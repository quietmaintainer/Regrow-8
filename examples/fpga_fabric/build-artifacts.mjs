import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const manifestName = 'build-manifest.json';
const format = 'regrow-hx8k-build/1';
export const protectedTraceFiles = [0, 1, 2, 3].map(group => `recovery-${group}.log`);
const artifactFiles = ['recipe.txt', 'mapped.v', 'mapped.json', 'routed.asc', 'placed.json', 'routing.json',
  'report.json', ...protectedTraceFiles];

export function artifactHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashBuildArtifacts(directory, names) {
  return Object.fromEntries(names.map(name => [name, artifactHash(readFileSync(join(directory, name)))]));
}

export function writeBuildManifest(directory, recorded) {
  const artifacts = Object.fromEntries(artifactFiles.map(name => {
    const hash = recorded[name];
    if (!hash) throw Error(`Missing recorded build artifact: ${name}`);
    return [name, hash];
  }));
  writeFileSync(join(directory, manifestName), JSON.stringify({ format, artifacts }, null, 2) + '\n', { flag: 'wx' });
}

export function readBuildArtifacts(directory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, manifestName), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('Missing build manifest. Rebuild the mapped run to export its evidence.');
    throw error;
  }
  if (manifest?.format !== format || !manifest.artifacts) throw Error('Invalid build manifest');

  const files = {};
  for (const name of artifactFiles) {
    const bytes = readFileSync(join(directory, name));
    if (artifactHash(bytes) !== manifest.artifacts[name]) throw Error(`Build artifact differs from its manifest: ${name}`);
    files[name] = bytes;
  }
  return { files, hashes: manifest.artifacts };
}
