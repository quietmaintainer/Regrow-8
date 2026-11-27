import assert from 'node:assert/strict';
import { LiveFpga } from '../../web/live-fpga.mjs';

// Supply only the recorded external fault stimulus to the live simulator.
export function verifyLiveTraces({ live, scenarios, roles }) {
  if (!live) throw Error('Build has no live mapped image');
  const chip = new LiveFpga(live);
  let clocks = 0, transitions = 0;

  for (const scenario of scenarios) {
    chip.reset();
    const faults = new Map(scenario.events.filter(event => event[1] === 'fault').map(event => [event[0], event[2]]));
    for (let clock = 1; clock <= scenario.events.at(-1)[0]; clock++) chip.tick(faults.get(clock) ?? -1);

    const observed = chip.takeEvents();
    const expected = scenario.events.filter(event => event[1] !== 'window' && event[1] !== 'end').map(event =>
      event[1] === 'write' ? [...event, roles[event[2]].image[event[3]]] : event);
    assert.deepEqual(observed, expected, `live pin trace differs for ${scenario.measurement.fault}`);
    clocks += chip.clock;
    transitions += observed.length;
  }
  return { clocks, transitions };
}
