import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DFF, NOT } from '../examples/machine_recipe/logic.mjs';
import { TRACKS } from '../examples/machine_recipe/fabric.mjs';
import { ComputerRecipe, openComputerRecipe } from './computer-recipe.mjs';

const recipe = readFileSync(new URL('../recipes/cpu.txt', import.meta.url), 'utf8');
const counterRecipe = readFileSync(new URL('../recipes/counter.txt', import.meta.url), 'utf8');

test('the demo loads a text recipe for both circuit designs', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async url => new Response(readFileSync(url)));
  assert.equal((await openComputerRecipe('cpu')).variant, 'cpu');
  assert.equal((await openComputerRecipe('counter')).variant, 'counter');
  assert.deepEqual(fetch.mock.calls.map(({ arguments: [url] }) => url.href), [
    new URL('../recipes/cpu.txt', import.meta.url).href,
    new URL('../recipes/counter.txt', import.meta.url).href,
  ]);
});

function commission(computer) {
  for (let i = 0; i <= computer.board.side; i++) {
    const { computer: view } = computer.advance(1);
    assert.notEqual(view.phase, 'failed', view.failure);
    if (view.phase === 'ready') return view;
  }
  assert.fail('The configuration wave did not finish');
}

test('the blank fabric grows a CPU that writes to RAM through its pins', () => {
  const computer = new ComputerRecipe(recipe);
  const { computer: blank } = computer.frame();
  assert.equal(blank.phase, 'growing');
  assert.ok(blank.sections.every(section => !section.sites.length));
  assert.equal(computer.chip, undefined);
  const ready = commission(computer);
  assert.equal(ready.stats.gatesPlaced, 144);
  assert.equal(ready.sections[0].title, 'Instruction decoder');
  assert.equal(ready.sections.at(-1).title, 'Program counter');
  assert.equal(ready.sections.reduce((count, { sites }) => count + sites.length, 0), 144);
  for (let bit = 0; bit < 8; bit++) {
    const alu = ready.sections[1 + bit].sites, accumulator = ready.sections[9 + bit].sites;
    assert.equal(alu[0] >> 6, accumulator[0] >> 6);
    assert.ok(alu[0] % 64 < accumulator[0] % 64);
  }
  assert.equal(ready.edges, 0);
  assert.equal(ready.pc, 0);
  const { computer: ran } = computer.advance(5);
  assert.equal(ran.pc, 2);
  assert.equal(ran.accumulator, 2);
  assert.deepEqual(ran.ram, [2, 0, 0, 0]);
});

test('another cut discards a staged plan, and wire and gate repairs keep the live registers', () => {
  const computer = new ComputerRecipe(recipe);
  commission(computer);
  computer.advance(2);
  const { board } = computer;
  const gate = board.config.kind.indexOf(NOT);
  const anotherGate = board.config.kind.lastIndexOf(NOT);
  computer.damage({ cell: gate, radius: 0, permanent: false });
  const damaged = board.raw();
  const { computer: staged } = computer.advance(2);
  assert.equal(staged.phase, 'repairing');
  assert.equal(staged.edges, 2);
  assert.ok(staged.wave);
  assert.deepEqual(board.raw(), damaged);
  computer.damage({ cell: anotherGate, radius: 0, permanent: false });
  const fixed = commission(computer);
  assert.equal(fixed.stats.gatesPlaced, 2);
  assert.equal(fixed.stats.restarted, false);
  assert.equal(fixed.accumulator, 1);
  assert.equal(fixed.pc, 2);
  assert.deepEqual(fixed.ram, [1, 0, 0, 0]);
  assert.deepEqual(computer.advance(3).computer.ram, [2, 0, 0, 0]);
});

test('the documented permanent scar reroutes connections and the CPU can write again', () => {
  const computer = new ComputerRecipe(recipe);
  const before = commission(computer);
  const labeledGates = new Map(before.sections.flatMap(({ title, sites }) =>
    sites.map(site => [computer.board.config.tag[site], { site, title }])));
  computer.advance(5);
  const { computer: cut } = computer.damage({ sample: true });
  assert.equal(cut.phase, 'repairing');
  assert.equal(cut.dead.reduce((count, dead) => count + dead, 0), 610);
  const fixed = commission(computer);
  assert.equal(fixed.stats.gatesPlaced, 17);
  assert.equal(fixed.stats.pathsKept, 115);
  assert.equal(fixed.stats.pathsRouted, 211);
  let moved = 0;
  for (const { title, sites } of fixed.sections) for (const site of sites) {
    const original = labeledGates.get(computer.board.config.tag[site]);
    assert.equal(title, original.title);
    moved += Number(site !== original.site);
  }
  assert.equal(moved, fixed.stats.gatesPlaced);
  assert.equal(fixed.stats.restarted, true);
  assert.equal(fixed.edges, 5);
  assert.equal(fixed.pc, 0);
  assert.equal(fixed.accumulator, 0);
  assert.deepEqual(fixed.ram, [2, 0, 0, 0]);
  assert.deepEqual(computer.advance(2).computer.ram, [1, 0, 0, 0]);
});

test('the CPU rebinds an isolated input to a working contact and moves its grid label', () => {
  const computer = new ComputerRecipe(recipe);
  commission(computer);
  const { board } = computer;
  const pin = board.inputs.get('i0');
  computer.damage({ cell: pin, radius: 2, permanent: true });
  const fixed = commission(computer);
  const active = new Map(fixed.pins).get('i0');
  assert.ok(board.inputContacts.get('i0').slice(1).includes(active));
  assert.equal(fixed.high[pin], 0);
  assert.equal(fixed.high[active], 1);
  assert.ok(fixed.highLinks[active]);
  assert.equal(fixed.stats.restarted, false);
  assert.deepEqual(computer.advance(2).computer.ram, [1, 0, 0, 0]);
});

test('losing every contact for a pin halts the CPU without partial writes', () => {
  const computer = new ComputerRecipe(recipe);
  commission(computer);
  const { board } = computer;
  for (const cell of board.inputContacts.get('i0')) computer.damage({ cell, radius: 2, permanent: true });
  const damaged = board.raw();
  const { computer: failed } = computer.advance(1);
  assert.equal(failed.phase, 'failed');
  assert.match(failed.failure, /unreachable boundary pin: i0/);
  assert.equal(failed.edges, 0);
  assert.deepEqual(board.raw(), damaged);
  assert.ok(board.config.kind.includes(DFF));
});

test('the counter grows four staggered registers, holds when disabled, and wraps', () => {
  const counter = new ComputerRecipe(counterRecipe, 'counter');
  const ready = commission(counter);
  const registers = Array.from(ready.kind.keys()).filter(site => ready.kind[site] === DFF);
  assert.equal(registers.length, 4);
  assert.ok(ready.sections.every(({ title, sites }, bit) => title === `Counter bit ${bit}` && sites.includes(registers[bit])));
  assert.ok(registers.slice(1).every((site, i) => site % 64 > registers[i] % 64 && site - registers[i] > 64));
  const enable = counter.board.inputs.get('enable');
  assert.ok(ready.highLinks[enable] && ready.highTracks[enable]);
  for (let count = 0; count < 16; count++) {
    const { computer: held } = counter.setEnabled(false);
    assert.equal(held.count, count);
    assert.equal(held.highLinks[enable], 0);
    assert.equal(counter.advance(1).computer.count, count);
    counter.setEnabled(true);
    assert.equal(counter.advance(1).computer.count, (count + 1) % 16);
  }
});

test('the edge tape writes one physical row per step and commissions that fabric after END', () => {
  const counter = new ComputerRecipe(counterRecipe, 'counter');
  const blank = counter.board, { side } = blank;
  const { reader } = counter.tape, built = reader.board;
  assert.equal(counter.frame().computer.tape.rows, 0);
  assert.ok(counter.frame().computer.tape.upcoming.includes('row'));
  for (let row = 1; row <= side; row++) {
    const { computer: growing } = counter.advance(1);
    assert.equal(growing.tape.rows, row);
    assert.equal(growing.phase, 'growing');
    assert.equal(growing.edges, 0);
    assert.equal(growing.count, null);
    assert.ok(built.config.wire.subarray(row * side * TRACKS).every(value => value === 0));
  }
  assert.deepEqual(reader.view().upcoming, ['end']);
  assert.ok(built.config.kind.includes(DFF));
  assert.ok(!blank.config.kind.includes(DFF));
  const { computer: ready } = counter.advance(1);
  assert.equal(counter.board, built);
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.count, 0);
  assert.equal(ready.edges, 0);
  assert.equal(counter.advance(1).computer.count, 1);
});

test('counter repair reroutes the permanent scar and preserves its surviving count and enable pin', () => {
  const counter = new ComputerRecipe(counterRecipe, 'counter');
  commission(counter);
  assert.equal(counter.advance(7).computer.count, 7);
  counter.setEnabled(false);
  counter.damage({ sample: true });
  const damaged = counter.board.raw();
  const { computer: firstRow } = counter.advance(1);
  assert.equal(firstRow.phase, 'repairing');
  assert.equal(firstRow.tape.rows, 1);
  assert.equal(firstRow.edges, 7);
  assert.ok(firstRow.highTracks.every(level => level === 0));
  assert.deepEqual(counter.board.raw(), damaged);
  const fixed = commission(counter);
  assert.ok(fixed.stats.gatesPlaced > 0 && fixed.stats.pathsRouted > 0);
  assert.equal(fixed.stats.restarted, false);
  assert.equal(fixed.enabled, false);
  assert.equal(counter.advance(1).computer.count, 7);
  counter.setEnabled(true);
  for (let edge = 1; edge <= 16; edge++) assert.equal(counter.advance(1).computer.count, (7 + edge) % 16);
});

test('a cut during tape repair starts a new tape and retains the running registers at commit', () => {
  const counter = new ComputerRecipe(counterRecipe, 'counter');
  commission(counter);
  counter.advance(4);
  const { board } = counter;
  const gate = board.config.kind.indexOf(NOT);
  const wire = board.config.kind.findIndex((kind, site) => !kind && !board.fixed[site] && board.config.wire[site * TRACKS]);
  counter.damage({ cell: gate, radius: 0, permanent: true });
  const { computer: building } = counter.advance(20);
  assert.equal(building.tape.rows, 20);
  counter.damage({ cell: wire, radius: 0, permanent: true });
  assert.equal(counter.advance(1).computer.tape.rows, 1);
  const fixed = commission(counter);
  assert.equal(fixed.dead[gate], 1);
  assert.equal(fixed.dead[wire], 1);
  assert.equal(fixed.stats.restarted, false);
  assert.equal(fixed.count, 4);
  assert.equal(counter.advance(1).computer.count, 5);
});
