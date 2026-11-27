import { expand, DFF, NOT, AND, OR, XOR, MUX } from '../machine_recipe/logic.mjs';

export const BYTE_LANES = 12;
const FIRST_LUT = 1 + 8 * BYTE_LANES;
const MAX_LUTS = 128;
const truth = new Map([[NOT, 0x55], [AND, 0x88], [OR, 0xee], [XOR, 0x66], [MUX, 0xe4]]);
const inputsOf = w => [...w.picks, ...w.lut.filter((_, i) => i % 4 !== 0)];

// The CRC output taps define the byte-lane boundaries, and the DFFs
// identify the register inputs and outputs. No placement is assigned here.
function packCones(recipe) {
  const { inputs, outputs, gates } = expand(recipe);
  if (inputs.join() !== 'rst') throw Error('HX8K CPU expects a single rst input strapped low');
  const buses = new Map();
  outputs.forEach((name, i) => {
    const [, base, digit] = /^(.*?)(\d+)?$/.exec(name);
    if (!buses.has(base)) buses.set(base, []);
    const ids = buses.get(base);
    if (Number(digit ?? 0) !== ids.length || ids.length >= 8) throw Error(`expected contiguous little-endian taps for ${base}`);
    ids.push(gates[gates.length - outputs.length + i][1]);
  });
  const regs = ['pc', 'acc'].map(name => buses.get(name) ?? []);
  const registerIds = regs.flat();
  if (regs.some(ids => ids.length !== 8) || new Set(registerIds).size !== 16 || registerIds.some(id => gates[id][0] !== DFF)
    || gates.filter(([op]) => op === DFF).length !== 16) throw Error('expected 8 PC and 8 accumulator DFFs');

  const known = new Map([[0, 0]]);
  const laneNames = ['pc', 'acc'];
  const logic = [];
  const expose = (ids, lane) => ids.forEach((id, bit) => {
    if (!known.has(id)) known.set(id, 1 + 8 * lane + bit);
  });
  regs.forEach(expose);

  function cluster(name, ids) {
    const lane = laneNames.length;
    if (lane >= BYTE_LANES) throw Error('CPU exceeds the byte-lane budget');
    const lut = [], used = new Set(), memo = new Map(), visiting = new Set();
    function select(id) {
      if (known.has(id)) {
        const ref = known.get(id);
        if (ref) used.add((ref - 1) >> 3);
        return ref;
      }
      if (memo.has(id)) return memo.get(id);
      if (visiting.has(id)) throw Error('combinational feedback in CRC cluster');
      visiting.add(id);
      const [op, ...args] = gates[id];
      if (!truth.has(op)) throw Error('unsupported CRC gate');
      const [a, b = 0, c = 0] = args.map(select), n = lut.length / 4;
      if (n >= MAX_LUTS) throw Error(`cluster ${name} exceeds ${MAX_LUTS} LUTs`);
      lut.push(truth.get(op), a, b, c);
      visiting.delete(id);
      memo.set(id, FIRST_LUT + n);
      return FIRST_LUT + n;
    }
    const picks = ids.map(select);
    // Even a constant belongs to the transaction arriving from the bank.
    if (!used.size) used.add(0);
    logic.push({ lane, inputLanes: [...used], lut, picks, gateIds: [...memo.keys()] });
    laneNames.push(name);
    expose(ids, lane);
    return lane;
  }

  for (const [name, ids] of buses) if (name !== 'pc' && name !== 'acc') cluster(name, ids);
  const registerInputLanes = regs.map((ids, i) => cluster(`D:${laneNames[i]}`, ids.map(id => gates[id][1])));
  return { logic, laneNames, registerInputLanes };
}

// A bay shares a pinout, so either tape fits the third site. Re-encode the
// packer's absolute local LUT selectors as distances into a shift register.
function packPair(words) {
  const pins = [...new Set(words.flatMap(inputsOf).filter(s => s > 0 && s < FIRST_LUT))].sort((a, b) => a - b);
  let history = 8;
  const images = words.map(w => {
    const ops = [];
    function append(table, refs) {
      const [a, b, c] = refs.map(ref => {
        if (!ref) return 0;
        if (ref < FIRST_LUT) return 1 + pins.indexOf(ref);
        const back = ops.length - 1 - (ref - FIRST_LUT);
        if (back < 0) throw Error('forward LUT reference');
        history = Math.max(history, back + 1);
        return 1 + pins.length + back;
      });
      ops.push(((table << 24) | (c << 16) | (b << 8) | a) >>> 0);
    }
    for (let j = 0; j < w.lut.length; j += 4) append(w.lut[j], w.lut.slice(j + 1, j + 4));
    for (let bit = 7; bit >= 0; bit--) append(0xaa, [w.picks[bit] ?? 0, 0, 0]);
    if (ops.length > 128) throw Error('image exceeds site RAM depth');
    return ops;
  });
  if (!pins.length || pins.length + history > 255) throw Error('bay exceeds selector budget');
  return { pins: pins.map(p => p - 1), history, images };
}

export function packProfile(recipe) {
  const cones = packCones(recipe);
  if (cones.logic.length !== 8) throw Error('FPGA profile requires eight CRC logic cones');
  for (const { lane, inputLanes } of cones.logic) {
    if (inputLanes.some(input => input >= lane)) throw Error('cluster cannot be served by the forward interconnect');
  }
  const pairs = [0, 2, 4, 6].map(i => packPair(cones.logic.slice(i, i + 2)));
  return { ...cones, pairs };
}
