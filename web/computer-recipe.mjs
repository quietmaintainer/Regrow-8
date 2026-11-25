import { Fabric, machine, SETTLE_WINDOW, TRACKS } from '../examples/machine_recipe/fabric.mjs';
import { bus, DFF, expand } from '../examples/machine_recipe/logic.mjs';
import { mask } from '../examples/machine_recipe/damage.mjs';
import { planCpuGrowth, planGrowth } from '../examples/machine_recipe/grow.mjs';
import { pinout } from '../examples/machine_recipe/verify.mjs';
import { COMPUTER_RECIPE_COUNTER, COMPUTER_RECIPE_CPU, COMPUTER_RECIPE_SIDE, COMPUTER_RECIPE_VARIANTS } from './library.js';
import { RecipeRowTape } from './computer-recipe-tape.mjs';

const cpuPins = pinout('cpu');
const counterPins = { inputs: ['enable', 'rst'], outputs: bus('q', 4) };
const counterCenters = [[12, 14], [25, 26], [38, 38], [51, 50]];
const immediatePins = bus('i', 8), opcodePins = bus('op', 3);
const pcPins = bus('pc', 2), dataPins = bus('data', 8), addressPins = bus('addr', 2);
const demoRom = [[1, 1], [4, 0], [6, 0], [7, 0]];
const mnemonics = ['LDI', 'ADDI', 'SUBI', 'XORI', 'STA', 'BZ', 'JMP', 'NOP'];
const waveStride = 4;

// Order follows the groups in the CPU and counter recipes.
const cpuSections = [
  { title: 'Instruction decoder', short: 'Decoder', color: '#9bbfe0' },
  ...Array.from({ length: 8 }, (_, bit) => ({ title: `ALU bit ${bit}`, short: `ALU ${bit}`, color: '#82d6c8' })),
  ...Array.from({ length: 8 }, (_, bit) => ({ title: `Accumulator bit ${bit}`, short: `ACC ${bit}`, color: '#bfacf4' })),
  { title: 'Program counter', short: 'PC', color: '#9bbfe0' },
];
const counterSections = Array.from({ length: 4 }, (_, bit) => ({
  title: `Counter bit ${bit}`, short: `Bit ${bit}`, color: '#bfacf4',
}));

export async function openComputerRecipe(variant = COMPUTER_RECIPE_CPU) {
  if (!COMPUTER_RECIPE_VARIANTS.includes(variant)) throw new Error('Unknown computer recipe');
  const url = new URL('../recipes/' + variant + '.txt', import.meta.url);
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Cannot load the ${variant} recipe (HTTP ${response.status}). Serve the Regrow-8 project over HTTP.`);
  return new ComputerRecipe(await response.text(), variant);
}

function readBus(chip, pins) {
  return pins.reduce((word, pin, bit) => word | ((chip.read(pin) & 1) << bit), 0);
}

function driveBus(chip, pins, value) {
  pins.forEach((pin, bit) => chip.drive(pin, -((value >> bit) & 1)));
}

function losesRegister(board, config) {
  const old = board.config;
  return old.kind.some((kind, site) => kind === DFF && old.tag[site] !== config.tag[site]);
}

export class ComputerRecipe {
  constructor(recipe, variant = COMPUTER_RECIPE_CPU) {
    if (!COMPUTER_RECIPE_VARIANTS.includes(variant)) throw new Error('Unknown computer recipe');
    this.recipe = recipe;
    this.variant = variant;
    const counter = variant === COMPUTER_RECIPE_COUNTER;
    const { groups, gates } = expand(recipe);
    const sections = counter ? counterSections : cpuSections;
    this.sections = groups.map((_, index) => sections[index] ?? {
      title: `Logic group ${index + 1}`, short: `Group ${index + 1}`, color: '#9bbfe0',
    });
    this.sectionByTag = new Uint16Array(gates.length + 1);
    groups.forEach((ids, index) => ids.forEach(id => { this.sectionByTag[id + 1] = index + 1; }));
    const { inputs, outputs } = counter ? counterPins : cpuPins;
    this.board = new Fabric(COMPUTER_RECIPE_SIDE, inputs, outputs, { padWidth: counter ? 1 : 4 });
    this.pins = new Map([...this.board.inputs, ...this.board.outputs]);
    this.erased = new Uint8Array(this.board.n);
    if (counter) this.enabled = true;
    else this.ram = [0, 0, 0, 0];
    this.tick = this.edges = 0;
    this.pendingReset = true;
    if (counter) this.loadTape();
  }

  advance(count) {
    if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error('Invalid computer step count');
    for (let i = 0; i < count && !this.failure; i++) {
      this.tick++;
      if (this.chip) this.clock();
      else this.grow();
    }
    return this.frame();
  }

  grow() {
    try {
      if (this.variant === COMPUTER_RECIPE_COUNTER) {
        if (!this.tape) this.loadTape();
        if (this.tape.reader.advance()) {
          const { reader, stats, replacesRegister } = this.tape;
          this.commission(reader.board, stats, reader.writes, replacesRegister);
        }
        return;
      }
      if (!this.plan) {
        this.plan = planCpuGrowth(this.board, this.recipe);
        this.depth = 0;
      } else {
        this.depth += waveStride;
      }
      const { config, pins, wave, stats } = this.plan;
      if (this.depth < stats.waveDepth) return;

      // Stage the visual wave, then commit the validated switch image in one go.
      // A cut during staging discards the plan and leaves the real fabric consistent.
      const replacing = losesRegister(this.board, config);
      const writes = this.board.install(config, wave);
      this.commission(this.board, stats, writes, replacing);
      this.pins = pins;
    } catch (failure) {
      this.failure = failure.message;
      this.chip = this.plan = this.tape = undefined;
    }
  }

  loadTape() {
    const plan = planGrowth(this.board, this.recipe, counterCenters);
    this.tape = { reader: new RecipeRowTape(this.board, plan), stats: plan.stats,
      replacesRegister: losesRegister(this.board, plan.config) };
  }

  commission(board, stats, writes, replacing) {
    this.pendingReset ||= replacing;
    this.chip = machine(board);
    const repaired = Boolean(this.stats), restarted = repaired && this.pendingReset;
    if (this.pendingReset) {
      this.chip.drive('rst', -1);
      this.chip.settle();
      this.chip.rise();
      this.chip.drive('rst', 0);
      this.pendingReset = false;
    }
    this.driveInputs();
    this.board = board;
    this.stats = { ...stats, ...writes, repaired, restarted };
    this.erased.fill(0);
    this.plan = this.tape = undefined;
  }

  driveInputs() {
    if (this.variant === COMPUTER_RECIPE_COUNTER) {
      this.chip.drive('enable', this.enabled ? -1 : 0);
      this.chip.settle();
      return;
    }
    this.chip.settle();
    const [opcode, operand] = demoRom[readBus(this.chip, pcPins)];
    driveBus(this.chip, opcodePins, opcode);
    driveBus(this.chip, immediatePins, operand);
    this.chip.settle();
  }

  clock() {
    if (this.variant === COMPUTER_RECIPE_CPU && (this.chip.read('we') & 1)) {
      this.ram[readBus(this.chip, addressPins)] = readBus(this.chip, dataPins);
    }
    this.chip.rise();
    this.edges++;
    this.driveInputs();
  }

  setEnabled(enabled) {
    if (this.variant !== COMPUTER_RECIPE_COUNTER || typeof enabled !== 'boolean') throw new Error('Choose the enabled counter');
    this.enabled = enabled;
    if (this.chip) this.driveInputs();
    return this.frame();
  }

  damage({ cell, radius, permanent, sample = false } = {}) {
    const { board } = this;
    let sites;
    if (sample) {
      sites = mask(board, 'scatter', 15, 20261125);
      permanent = true;
    } else {
      if (!Number.isInteger(cell) || cell < 0 || cell >= board.n || !Number.isInteger(radius)
        || radius < 0 || radius > 8 || typeof permanent !== 'boolean') throw new Error('Invalid damage brush');
      const x = cell % board.side, y = Math.floor(cell / board.side);
      sites = [];
      for (let row = Math.max(0, y - radius); row < Math.min(board.side, y + radius + 1); row++) {
        for (let col = Math.max(0, x - radius); col < Math.min(board.side, x + radius + 1); col++) {
          if ((row - y) ** 2 + (col - x) ** 2 <= radius ** 2) sites.push(row * board.side + col);
        }
      }
    }
    const { kind, wire } = (this.tape?.reader.board ?? board).config;
    const affected = sites.filter(site => !board.fixed[site] && !board.dead[site]
      && (permanent || kind[site] || wire.subarray(site * TRACKS, (site + 1) * TRACKS).some(Boolean)));
    if (!affected.length) return this.frame();
    this.pendingReset ||= affected.some(site => board.config.kind[site] === DFF);
    board.damage(affected, permanent);
    for (const site of affected) this.erased[site] = Number(!permanent);
    this.chip = this.plan = this.tape = this.failure = undefined;
    return this.frame();
  }

  frame() {
    const { chip, plan, depth } = this;
    const reader = this.tape?.reader;
    const board = reader?.board ?? this.board;
    const old = board.config;
    const kind = new Uint8Array(board.n), tracks = new Uint8Array(board.n), links = new Uint8Array(board.n);
    const highTracks = new Uint8Array(board.n), highLinks = new Uint8Array(board.n);
    const staged = new Uint8Array(board.n), high = new Uint8Array(board.n);
    const levels = chip?.wireLevels();
    const sections = this.sections.map(section => ({ ...section, sites: [] }));
    if (reader) for (const site of reader.written) staged[site] = 1;
    const configAt = site => plan && plan.distance[site] >= 0 && plan.distance[site] <= depth ? plan.config : old;
    for (let site = 0; site < board.n; site++) {
      const shown = configAt(site);
      kind[site] = shown.kind[site];
      const section = this.sectionByTag[shown.tag[site]];
      if (section && kind[site]) sections[section - 1].sites.push(site);
      if (shown !== old) {
        staged[site] = Number(kind[site] !== old.kind[site] || shown.tag[site] !== old.tag[site]);
      }
      high[site] = board.q[site] & 1;
      for (let lane = 0; lane < TRACKS; lane++) {
        const i = site * TRACKS + lane, code = shown.wire[i];
        if (code !== old.wire[i]) staged[site] = 1;
        if (!code) continue;
        const powered = levels?.[i] ?? 0;
        tracks[site]++;
        highTracks[site] += powered;
        if (code === 1) continue;
        const direction = Math.floor((code - 2) / TRACKS);
        const incoming = 1 << direction, outgoing = 1 << (direction ^ 1);
        links[site] |= incoming;
        if (powered) highLinks[site] |= incoming;
        const neighbor = board.neighbors[site * 4 + direction];
        if (neighbor >= 0 && configAt(neighbor).wire[neighbor * TRACKS + (code - 2) % TRACKS]) {
          links[neighbor] |= outgoing;
          if (powered) highLinks[neighbor] |= outgoing;
        }
      }
    }
    const counter = this.variant === COMPUTER_RECIPE_COUNTER;
    const pc = chip && !counter ? readBus(chip, pcPins) : null;
    if (chip) {
      if (counter) high[this.pins.get('enable')] = Number(this.enabled);
      else {
        const [opcode, operand] = demoRom[pc];
        opcodePins.forEach((name, bit) => { high[this.pins.get(name)] = (opcode >> bit) & 1; });
        immediatePins.forEach((name, bit) => { high[this.pins.get(name)] = (operand >> bit) & 1; });
      }
      for (const name of board.outputs.keys()) high[this.pins.get(name)] = chip.read(name) & 1;
    }
    return { tick: this.tick, width: board.side, height: board.side, source: board.seed, webgpu: false,
      computer: {
        kind, tracks, links, highTracks, highLinks, staged, high, dead: board.dead.slice(), erased: this.erased.slice(), variant: this.variant,
        seed: board.seed, clockPad: board.clockPad, pins: [...this.pins], sections,
        phase: this.failure ? 'failed' : chip ? 'ready' : this.stats ? 'repairing' : 'growing',
        wave: plan ? [depth, plan.stats.waveDepth] : null, tape: reader?.view(), failure: this.failure, stats: this.stats,
        edges: this.edges,
        ...(counter ? { enabled: this.enabled, count: chip ? readBus(chip, counterPins.outputs) : null }
          : { pc, accumulator: chip ? readBus(chip, dataPins) : null, ram: this.ram.slice(),
            rom: demoRom.map(([opcode, operand]) => opcode === 7 ? mnemonics[opcode] : `${mnemonics[opcode]} ${operand}`) }),
        deadline: SETTLE_WINDOW,
      },
    };
  }
}
