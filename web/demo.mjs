import { openComputerRecipe } from './computer-recipe.mjs?v=2';
import { computerRecipeView, drawComputerRecipe } from './computer-recipe-view.js?v=2';
import { COMPUTER_RECIPE_COUNTER, COMPUTER_RECIPE_CPU } from './library.js?v=2';

const canvas = document.querySelector('#fabric');
const context = canvas.getContext('2d');
const run = document.querySelector('#run');
const step = document.querySelector('#step');
const reset = document.querySelector('#reset');
const progress = document.querySelector('#progress');
const inspector = document.querySelector('#inspector');
const cellTitle = document.querySelector('#cell-title');
const status = document.querySelector('#computer-recipe-status');
const errorNotice = document.querySelector('#load-error');
const moves = new Map([
  ['ArrowLeft', [-1, 0]], ['ArrowRight', [1, 0]], ['ArrowUp', [0, -1]], ['ArrowDown', [0, 1]],
]);

let simulator, frame, selected, timer;
let loading = true;
let variant = new URLSearchParams(location.search).get('variant') === COMPUTER_RECIPE_COUNTER
  ? COMPUTER_RECIPE_COUNTER : COMPUTER_RECIPE_CPU;

const view = computerRecipeView(canvas, {
  damage(options) { if (simulator) show(simulator.damage(options)); },
  chooseDesign(design) {
    if (design === 'hx8k') {
      // Restore the circuit selection before navigating so browser Back shows it.
      controls();
      location.assign(new URL('../workbench.html', import.meta.url));
      return;
    }
    void load(design);
  },
  setEnable(enabled) { if (simulator) show(simulator.setEnabled(enabled)); },
});

function controls() {
  const state = frame?.computer;
  const running = timer !== undefined;
  run.textContent = running ? 'Pause' : 'Play';
  run.disabled = loading || !state || state.phase === 'failed';
  step.disabled = run.disabled || running;
  reset.disabled = loading;
  view.setBusy(loading, state);
}

function draw() {
  const pixel = Math.min(window.devicePixelRatio || 1, 2);
  const resolution = Math.max(1, Math.round(canvas.clientWidth * pixel));
  if (canvas.width !== resolution) canvas.width = canvas.height = resolution;
  if (!frame) {
    context.resetTransform();
    context.fillStyle = '#0b1520';
    context.fillRect(0, 0, resolution, resolution);
    return;
  }
  const unit = resolution / frame.width;
  context.setTransform(unit, 0, 0, unit, 0, 0);
  drawComputerRecipe(context, frame.computer, frame.width, selected, unit, pixel);
}

function showSelection() {
  inspector.hidden = selected === undefined || !frame;
  if (!inspector.hidden) {
    cellTitle.textContent = `Cell ${selected % frame.width}, ${Math.floor(selected / frame.width)}`;
    view.inspect(frame.computer, selected);
  }
  draw();
}

function show(next) {
  frame = next;
  if (frame.computer.phase === 'failed') pause();
  progress.textContent = view.show(frame.computer);
  showSelection();
  controls();
}

function advance() {
  if (simulator) show(simulator.advance(1));
}

function pause() {
  window.clearInterval(timer);
  timer = undefined;
}

async function load(design) {
  pause();
  variant = design;
  loading = true;
  simulator = frame = selected = undefined;
  errorNotice.hidden = true;
  status.textContent = 'Loading recipe…';
  status.removeAttribute('data-phase');
  progress.textContent = 'Loading circuit…';
  controls();
  showSelection();
  try {
    simulator = await openComputerRecipe(design);
    const counter = design === COMPUTER_RECIPE_COUNTER;
    canvas.setAttribute('aria-label', `64 by 64 ${counter ? 'counter' : 'CPU'} fabric`);
    const url = new URL(location.href);
    if (counter) url.searchParams.set('variant', design);
    else url.searchParams.delete('variant');
    history.replaceState(null, '', url);
    show(simulator.frame());
  } catch (error) {
    status.textContent = 'Recipe unavailable';
    status.dataset.phase = 'failed';
    progress.textContent = 'Load failed';
    errorNotice.textContent = error.message;
    errorNotice.hidden = false;
  } finally {
    loading = false;
    controls();
  }
}

function applyAt(cell) {
  const previous = selected;
  selected = cell;
  if (!view.applyTool(cell)) {
    selected = previous === cell ? undefined : cell;
    showSelection();
  }
}

function clamp(value) {
  return Math.max(0, Math.min(frame.width - 1, value));
}

run.addEventListener('click', () => {
  if (timer === undefined) {
    timer = window.setInterval(advance, 80);
    advance();
  } else pause();
  controls();
});
step.addEventListener('click', advance);
reset.addEventListener('click', () => { void load(variant); });

canvas.addEventListener('click', event => {
  if (!frame) return;
  const box = canvas.getBoundingClientRect();
  const x = clamp(Math.floor((event.clientX - box.left) * frame.width / box.width));
  const y = clamp(Math.floor((event.clientY - box.top) * frame.width / box.height));
  applyAt(y * frame.width + x);
});

canvas.addEventListener('keydown', event => {
  if (!frame) return;
  const key = event.key;
  if (moves.has(key)) {
    const [dx, dy] = moves.get(key);
    const cell = selected ?? frame.source;
    const x = clamp(cell % frame.width + dx);
    const y = clamp(Math.floor(cell / frame.width) + dy);
    selected = y * frame.width + x;
  } else if (key === 'Enter') selected = frame.source;
  else if (key === 'Escape') selected = undefined;
  else if (key !== ' ' || selected === undefined) return;
  event.preventDefault();
  if (key === ' ') view.applyTool(selected);
  showSelection();
});

view.activate(true);
new ResizeObserver(draw).observe(canvas);
void load(variant);
