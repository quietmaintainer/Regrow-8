import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LiveFpga,validateLiveImage } from './live-fpga.mjs';

const {data}=JSON.parse(readFileSync(new URL('./chip-example.json',import.meta.url),'utf8'));

test('interactive hot-B chip agrees with the independently clocked mapped device on a non-replay fault schedule',()=>{
  // Icarus grfp_trials.sv +POLICY=2 +CASE=4 +DELAY=93 +VIEW. Digest of
  // ordered pin transitions through the eighth commit, including write data.
  const chip=new LiveFpga(data.live,2);
  for(let clock=1;clock<=26486;clock++)chip.tick(clock===23766?15:clock===23768?3:-1);
  assert.equal(createHash('sha256').update(JSON.stringify(chip.takeEvents())).digest('hex'),
    '32848fdc41337018727673a3534105aa64b204975abde19998e64f831c3bb7f7');
  const s=chip.snapshot();assert.deepEqual([s.pc,s.acc,s.commits,s.spare,s.rebuilt],[1,254,8,170,0]);
  chip.reset();assert.deepEqual(chip.snapshot().dead,[]);assert.equal(chip.clock,0);assert.equal(chip.snapshot().spare,0);
});

test('live image rejects backward or conflicting drivers and an unmatched build',()=>{
  const image=structuredClone(data.live), check=()=>validateLiveImage(image,data.build,data.fabric.sites.length);
  image.ops[1]=image.ops[0];assert.throws(check,/topological/);
  image.ops[1]=data.live.ops[1];image.ffs[0]=data.live.ports.rst[0];assert.throws(check,/driver/);
  image.buildId='another build';assert.throws(check,/build identity/);
});
