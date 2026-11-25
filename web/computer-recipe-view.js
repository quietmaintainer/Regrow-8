import { COMPUTER_RECIPE_COUNTER } from './library.js';

const functions = ['Empty', 'Input pad', 'Output pad', 'NOT', 'AND', 'OR', 'XOR', 'MUX', 'D flip-flop'];
const wireColor = '#45a69d', gateColor = '#69d5c3', registerColor = '#ad9beb';
const activeWireColor = '#b8fff2', wireGlowColor = '#56ebcc4d';
const waveColor = '#f5c477', damageColor = '#e58389';
const pinNames = { enable: 'Count enable', rst: 'Reset', we: 'Write enable' };
const bitNames = { i: 'Operand', op: 'Opcode', data: 'Data', pc: 'Program counter', addr: 'Address', q: 'Counter output' };

function describePin(name) {
  const [, group, bit] = /^([a-z]+)(\d+)$/.exec(name) ?? [];
  return pinNames[name] ?? (bitNames[group] ? `${bitNames[group]} bit ${bit} (${name})` : name);
}

function drawCircuitLabels(ctx, state, side, unitsPerPixel) {
  const occupied = [], inset = .16, scale = unitsPerPixel;
  const counter = state.variant === COMPUTER_RECIPE_COUNTER;
  const showPinLabels = counter || scale <= .14;
  const moduleInset = showPinLabels && !counter ? 1.6 + 44 * scale : inset;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  function border(sites, color, dashed = false) {
    let minX = side, minY = side, maxX = 0, maxY = 0;
    for (const site of sites) {
      const x = site % side, y = Math.floor(site / side);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const left = Math.max(inset, minX - .36), top = Math.max(inset, minY - .36);
    const right = Math.min(side - inset, maxX + 1.36), bottom = Math.min(side - inset, maxY + 1.36);
    ctx.strokeStyle = `${color}a6`;
    ctx.lineWidth = scale;
    ctx.setLineDash(dashed ? [4 * scale, 3 * scale] : []);
    ctx.strokeRect(left, top, right - left, bottom - top);
    return { left, top, right, bottom };
  }

  function label(text, x, y, color, align = 'center', size = 11, margin = inset) {
    ctx.font = `600 ${size * scale}px "Geist", "Segoe UI", sans-serif`;
    const width = ctx.measureText(text).width;
    const offset = align === 'center' ? width / 2 : align === 'right' ? width : 0;
    const left = Math.min(Math.max(margin, x - offset), side - margin - width);
    const height = (size + 3) * scale;
    const center = Math.min(Math.max(height / 2, y), side - height / 2);
    const box = { left, right: left + width, top: center - height / 2, bottom: center + height / 2 };
    if (occupied.some(rect => box.left < rect.right + 3 * scale && box.right > rect.left - 3 * scale
      && box.top < rect.bottom && box.bottom > rect.top)) return false;
    occupied.push(box);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#0b1520';
    ctx.lineWidth = 3 * scale;
    ctx.strokeText(text, left, center);
    ctx.fillStyle = color;
    ctx.fillText(text, left, center);
    return true;
  }

  const inputs = state.pins.filter(([, site]) => site % side === 0);
  const outputs = state.pins.filter(([, site]) => site % side === side - 1);
  for (const [pins, title, color, align] of [
    [inputs, 'Input pins', '#9bbfe0', 'left'], [outputs, 'Output pins', gateColor, 'right'],
  ]) {
    const { top } = border(pins.map(([, site]) => site), color);
    label(title, align === 'left' ? .55 : side - .55, top - 16 * scale, color, align);
  }
  border([state.seed], waveColor);
  label('Configuration dock', state.seed % side + .5, 1.4 + 4 * scale, waveColor);
  border([state.clockPad], waveColor);
  label('Clock', state.clockPad % side + .5, side - 1.4 - 8 * scale, waveColor);

  for (const { title, short, color, sites } of state.sections) {
    if (!sites.length) continue;
    const { left, right, top, bottom } = border(sites, color, true);
    const x = (left + right) / 2, y = top - 9 * scale;
    if (scale <= .105 && label(title, x, y, color, 'center', 11, moduleInset)) continue;
    if (!label(short, x, y, color, 'center', 11, moduleInset)) {
      label(short, x, bottom + 9 * scale, color, 'center', 11, moduleInset);
    }
  }

  if (showPinLabels) for (const [name, site] of state.pins) {
    const input = site % side === 0;
    const text = counter ? (pinNames[name] ?? `Out ${name.slice(1)}`) : name.toUpperCase();
    label(text, input ? 1.6 : side - 1.6, Math.floor(site / side) + .5 - 8 * scale,
      input ? '#c0d7ea' : '#a5d8cf', input ? 'left' : 'right', 10);
  }
  ctx.restore();
}

function fillWire(ctx, x, y, directions, thickness) {
  const low = .5 - thickness / 2, reach = .5 + thickness / 2;
  if (directions & 1) ctx.fillRect(x, y + low, reach, thickness);
  if (directions & 2) ctx.fillRect(x + low, y + low, reach, thickness);
  if (directions & 4) ctx.fillRect(x + low, y, thickness, reach);
  if (directions & 8) ctx.fillRect(x + low, y + low, thickness, reach);
  if (!directions) ctx.fillRect(x + low, y + low, thickness, thickness);
}

export function drawComputerRecipe(ctx, state, side, selected, unit, pixel) {
  const { kind, tracks, links, highTracks, highLinks, staged, high, dead, erased, seed, clockPad, tape } = state;
  ctx.fillStyle = '#0b1520';
  ctx.fillRect(0, 0, side, side);
  ctx.lineWidth = pixel / unit;
  ctx.strokeStyle = '#172736';
  ctx.beginPath();
  for (let i = 0; i <= side; i++) {
    ctx.moveTo(i, 0); ctx.lineTo(i, side);
    ctx.moveTo(0, i); ctx.lineTo(side, i);
  }
  ctx.stroke();
  if (tape?.rows > 0) {
    ctx.fillStyle = '#f5c47714';
    ctx.fillRect(0, tape.rows - 1, side, 1);
    ctx.fillStyle = '#f5c47770';
    ctx.fillRect(.02, 0, .13, tape.rows);
  }

  for (let site = 0; site < kind.length; site++) {
    const x = site % side, y = Math.floor(site / side);
    const op = kind[site], pad = site === seed || site === clockPad;
    if (dead[site] || erased[site]) {
      ctx.fillStyle = dead[site] ? '#793e47' : '#4c2e41';
      ctx.fillRect(x + .09, y + .09, .82, .82);
    }
    if (tracks[site]) {
      const thick = .11 + Math.min(tracks[site], 6) * .032;
      ctx.fillStyle = staged[site] ? waveColor : wireColor;
      fillWire(ctx, x, y, links[site], thick);
      if (highTracks[site]) {
        ctx.fillStyle = wireGlowColor;
        fillWire(ctx, x, y, highLinks[site], thick + .19);
        ctx.fillStyle = activeWireColor;
        fillWire(ctx, x, y, highLinks[site], thick + .04);
      }
    }
    if (op || pad) {
      ctx.fillStyle = pad || staged[site] ? waveColor : high[site] ? '#edfff9'
        : op === 8 ? registerColor : op === 1 ? '#8ebde9' : op === 2 ? '#78c9b9' : gateColor;
      ctx.fillRect(x + .19, y + .19, .62, .62);
    }
    if (staged[site]) {
      ctx.strokeStyle = waveColor;
      ctx.strokeRect(x + .12, y + .12, .76, .76);
    }
  }
  drawCircuitLabels(ctx, state, side, pixel / unit);
  if (selected !== undefined) {
    ctx.strokeStyle = '#f4f8fc';
    ctx.lineWidth = Math.min(.25, 2 * pixel / unit);
    ctx.strokeRect(selected % side + .12, Math.floor(selected / side) + .12, .76, .76);
  }
}

export function computerRecipeView(canvas, { damage, chooseDesign, setEnable }) {
  const panel = document.querySelector('#computer-recipe-console');
  const legend = document.querySelector('#computer-recipe-legend');
  const inspector = document.querySelector('#computer-recipe-inspector');
  const status = panel.querySelector('#computer-recipe-status');
  const stats = panel.querySelector('#computer-recipe-stats');
  const tool = panel.querySelector('#computer-recipe-tool');
  const radius = panel.querySelector('#computer-recipe-radius');
  const sample = panel.querySelector('#computer-recipe-sample');
  const tapeStrip = document.querySelector('#computer-recipe-tape');
  const tapePosition = tapeStrip.querySelector('#computer-tape-position');
  const tapeSymbols = tapeStrip.querySelector('#computer-tape-symbols');
  const symbols = Array.from({ length: 24 }, () => document.createElement('span'));
  tapeSymbols.append(...symbols);
  const tapeDescriptions = { skip: 'Skip unchanged sites', write: 'Program a tile', row: 'End of row', end: 'End of tape' };
  const design = panel.querySelector('#computer-recipe-design');
  const counterPanel = panel.querySelector('#computer-recipe-counter');
  const enable = counterPanel.querySelector('#computer-recipe-enable');
  const cpuPanels = panel.querySelectorAll('[data-computer-cpu]');
  const rom = panel.querySelector('#computer-recipe-rom');
  const ram = panel.querySelector('#computer-recipe-ram');
  const fields = Object.fromEntries([...panel.querySelectorAll('[data-computer]'), ...inspector.querySelectorAll('[data-computer]')]
    .map(node => [node.dataset.computer, node]));
  const ramValues = Array.from({ length: 4 }, (_, address) => {
    const item = document.createElement('div'), label = document.createElement('dt'), value = document.createElement('dd');
    label.textContent = address;
    item.append(label, value);
    ram.append(item);
    return value;
  });
  const bytes = value => value == null ? '—' : String(value).padStart(3, '0');
  function syncTool() {
    radius.disabled = tool.value === 'inspect';
    if (!panel.hidden) canvas.dataset.computerTool = tool.value;
  }
  function syncInputs(state) {
    design.value = state.variant;
    if (state.variant === COMPUTER_RECIPE_COUNTER) enable.checked = state.enabled;
  }
  tool.addEventListener('change', syncTool);
  sample.addEventListener('click', () => damage({ sample: true }));
  design.addEventListener('change', () => chooseDesign(design.value));
  enable.addEventListener('change', () => setEnable(enable.checked));

  return {
    activate(enabled) {
      panel.hidden = legend.hidden = inspector.hidden = !enabled;
      if (enabled) syncTool();
      else {
        tapeStrip.hidden = true;
        delete canvas.dataset.computerTool;
      }
    },
    setBusy(blocked, state) {
      design.disabled = blocked;
      enable.disabled = blocked || !state;
      sample.disabled = blocked || state?.phase !== 'ready';
      if (!blocked && state) syncInputs(state);
    },
    applyTool(cell) {
      if (tool.value === 'inspect') return false;
      damage({ cell, radius: Number(radius.value), permanent: tool.value === 'disable' });
      return true;
    },
    show(state) {
      syncInputs(state);
      const { phase, wave, tape, failure, stats: result } = state;
      const counter = state.variant === COMPUTER_RECIPE_COUNTER;
      const device = counter ? 'counter' : 'CPU', ready = counter ? 'Counter ready' : 'CPU ready';
      const text = phase === 'failed' ? `${result ? 'Repair' : 'Build'} blocked · ${failure}`
        : phase === 'repairing' ? 'Clock halted for repair'
        : phase === 'growing' ? (wave || tape?.rows ? `Growing the ${device}` : 'Ready to grow')
        : result.restarted ? 'Repaired · registers reset' : result.repaired ? `Repaired · ${device} ready` : ready;
      if (status.textContent !== text) status.textContent = text;
      status.dataset.phase = phase;
      for (const section of cpuPanels) section.hidden = counter;
      counterPanel.hidden = !counter;
      tapeStrip.hidden = !counter;
      if (counter) {
        tapePosition.textContent = tape ? `${tape.rows} / ${tape.total} rows`
          : phase === 'ready' ? 'Complete' : phase === 'failed' ? 'Blocked' : 'Waiting';
        symbols.forEach((cell, index) => {
          const symbol = tape?.upcoming[index];
          cell.dataset.symbol = symbol ?? '';
          cell.title = tapeDescriptions[symbol] ?? '';
        });
        fields['count-binary'].textContent = state.count == null ? '—' : state.count.toString(2).padStart(4, '0');
        fields['count-decimal'].textContent = state.count ?? '—';
      } else {
        fields.pc.textContent = state.pc ?? '—';
        fields.accumulator.textContent = bytes(state.accumulator);
        if (!rom.children.length) rom.replaceChildren(...state.rom.map((word, address) => {
          const row = document.createElement('li'), label = document.createElement('span'), instruction = document.createElement('code');
          label.textContent = address;
          instruction.textContent = word;
          row.append(label, instruction);
          return row;
        }));
        for (const [address, row] of [...rom.children].entries()) row.setAttribute('aria-current', String(address === state.pc));
        state.ram.forEach((value, address) => { ramValues[address].textContent = bytes(value); });
      }
      stats.hidden = !result;
      if (result) stats.textContent = `${result.repaired ? 'Last repair' : 'Initial build'} · ${result.gatesPlaced} gates placed · ${result.pathsKept} paths kept · ${result.pathsRouted} routed. Signal path ${result.criticalTicks} of ${state.deadline} ticks.`;
      if (wave) return `Configuration wave ${wave[0]} / ${wave[1]}`;
      const faults = state.dead.reduce((n, dead) => n + dead, 0);
      const unit = counter ? 'clock edge' : 'instruction';
      return `${state.edges.toLocaleString()} ${unit}${state.edges === 1 ? '' : 's'}${faults ? ` · ${faults.toLocaleString()} disabled sites` : ''}`;
    },
    inspect(state, site) {
      const { kind, tracks, highTracks, staged, dead, erased, high, seed, clockPad, pins, sections } = state;
      const pin = pins.find(([, index]) => index === site)?.[0];
      const section = sections.find(item => item.sites.includes(site));
      fields.function.textContent = site === seed ? 'Configuration dock' : site === clockPad ? 'Clock pad'
        : pin ? `${functions[kind[site]]} · ${describePin(pin)}` : kind[site] ? functions[kind[site]] : tracks[site] ? 'Wire' : 'Empty';
      fields.section.textContent = section?.title ?? '';
      fields.section.parentElement.hidden = !section;
      fields.tracks.textContent = state.phase === 'ready' && tracks[site]
        ? `${tracks[site]} (${highTracks[site]} high)` : String(tracks[site]);
      fields.state.textContent = dead[site] ? 'Permanently disabled' : staged[site] ? (state.tape ? 'Written from tape' : 'Staged for configuration')
        : erased[site] ? 'Erased' : state.phase === 'ready' && (pin || kind[site] === 8) ? (high[site] ? 'High' : 'Low')
        : kind[site] || tracks[site] ? 'Configured' : '—';
    },
  };
}
