import { readFileSync } from 'node:fs';
import { openBundle } from '../../web/chip-model.mjs';
import { verifyLiveTraces } from './verify-live-traces.mjs';

const data=await openBundle(readFileSync(process.argv[2]??new URL('../../web/chip-example.json',import.meta.url),'utf8'));
const { clocks, transitions } = verifyLiveTraces(data);
console.log(`${data.scenarios.length} cases matched mapped Icarus outputs · ${clocks.toLocaleString()} clocks · ${transitions.toLocaleString()} observed transitions (including every config word).`);
