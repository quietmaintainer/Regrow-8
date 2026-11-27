import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fpgaProfile } from './profile.mjs';
import { BYTE_LANES } from './packing.mjs';
import { tapeProtection } from './protection.mjs';
import { decode16 } from '../file_recipe/rs16.mjs';
import { createHash } from 'node:crypto';
import { hashBuildArtifacts, protectedTraceFiles, readBuildArtifacts, writeBuildManifest } from './build-artifacts.mjs';
import { makeViewerBundle } from './viewer-bundle.mjs';

const recipe = readFileSync(new URL('../../recipes/hx8k-cpu8.txt', import.meta.url), 'utf8');

function evaluateCone({ lut, picks }, bus) {
  const values = [0];
  for (const byte of bus) for (let bit = 0; bit < 8; bit++) values.push((byte >> bit) & 1);
  for (let i = 0; i < lut.length; i += 4) {
    const address = values[lut[i + 1]] | (values[lut[i + 2]] << 1) | (values[lut[i + 3]] << 2);
    values.push((lut[i] >> address) & 1);
  }
  return picks.reduce((byte, ref, bit) => byte | (values[ref] << bit), 0);
}

test('both configuration streams in each bay compute their source CRC cone on arbitrary socket bytes', () => {
  const profile = fpgaProfile(recipe);
  const bus = new Uint8Array(BYTE_LANES);
  let rng = 1001;
  for (let vector = 0; vector < 256; vector++) {
    for (let j = 0; j < bus.length; j++) { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; bus[j] = rng >>> 24; }
    profile.pairs.forEach(({ pins, history, images }, i) => images.forEach((img, j) => {
      const socket = [0, ...pins.map(bit => (bus[bit >> 3] >> (bit & 7)) & 1)];
      const prior = [];
      for (const op of img) {
        const ref = shift => {
          const k = (op >>> shift) & 255;
          if (k < socket.length) return socket[k];
          assert.ok(k - socket.length < Math.min(history, prior.length));
          return prior.at(-1 - (k - socket.length));
        };
        prior.push(((op >>> 24) >> (ref(0) | ref(8) << 1 | ref(16) << 2)) & 1);
      }
      assert.equal(prior.slice(-8).reduce((v, b) => 2*v+b, 0), evaluateCone(profile.logic[2*i+j], bus));
    }));
  }
});

test('one FPGA parity row recovers every actual tape with the GRFP reference decoder', () => {
  const profile = fpgaProfile(recipe);
  const { parity, hashes, lengths } = tapeProtection(profile);
  const shards = profile.pairs.flatMap(p => p.images.map(img => {
    const b = Buffer.alloc(img.length*4); img.forEach((w,i) => b.writeUInt32LE(w,4*i)); return b;
  }));
  for (let target=0;target<8;target++) {
    decode16({ d:8, width:parity.length, missing:[target], rows:[0], length:i=>lengths[i]*4,
      load:i=>{assert.notEqual(i,target); return shards[i];}, parity:()=>parity,
      save:(i,b)=>{assert.deepEqual(b,shards[target]); assert.equal(createHash('sha256').update(b).digest('hex'),hashes[i]);} });
  }
});

test('an export requires the recorded manifest and rejects a replaced mapped netlist', t => {
  const directory = mkdtempSync(join(tmpdir(), 'regrow-build-'));
  const files = ['recipe.txt', 'mapped.v', 'mapped.json', 'routed.asc', 'placed.json', 'routing.json',
    'report.json', ...protectedTraceFiles];
  t.after(() => {
    for (const name of [...files, 'build-manifest.json']) rmSync(join(directory, name), { force: true });
    rmdirSync(directory);
  });
  for (const name of files) writeFileSync(join(directory, name), `original ${name}`);
  assert.throws(() => makeViewerBundle(directory), /Missing build manifest/);
  const recorded = hashBuildArtifacts(directory, files);
  writeBuildManifest(directory, recorded);
  assert.equal(readBuildArtifacts(directory).files['mapped.json'].toString(), 'original mapped.json');
  writeFileSync(join(directory, 'mapped.json'), 'different mapped.json');
  assert.throws(() => makeViewerBundle(directory), /differs from its manifest: mapped\.json/);
});
