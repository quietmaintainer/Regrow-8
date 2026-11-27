import { execFile, execFileSync } from 'node:child_process';
import { parseEnv, promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fpgaProfile, topVerilog } from './profile.mjs';
import { panelCsv } from './results.mjs';
import { tapeProtection, protectionRoms } from './protection.mjs';
import { gradeProtection, protectionCsv } from './grfp_results.mjs';
import { commitOracle } from './recipe-graph.mjs';
import { writeViewerBundle } from './viewer-bundle.mjs';
import { hashBuildArtifacts, protectedTraceFiles, writeBuildManifest } from './build-artifacts.mjs';

function fail(message) { console.error(message); process.exit(1); }
const argv = process.argv.slice(2), rtl = argv.includes('--rtl-only'), grfp = argv.includes('--grfp');
const recipeOption=argv.indexOf('--recipe'); let recipePath;
if (recipeOption>=0) {
  recipePath=argv[recipeOption+1];
  if (!grfp || !recipePath || recipePath.startsWith('--')) fail('--recipe requires a CRC text file and the --grfp profile');
  argv.splice(recipeOption,2);
}
const args = argv.filter(a=>a!=='--rtl-only' && a!=='--grfp');
const [dest] = args;
if (args.length > 1 || dest === '' || dest?.startsWith('--')) fail('Usage: node examples/fpga_fabric/run.mjs [NEW_OUTPUT_DIRECTORY] [--rtl-only] [--grfp]');
const src = name => new URL(name, import.meta.url), output = fileURLToPath(src('../../output/'));
const envFile = join(output, 'fpga-tools.env');
const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const setting = key => process.env[key] || local[key];
const tool = name => setting(name.toUpperCase().replaceAll('-', '_')) || name;
const cells = !rtl && [setting('ICE40_CELLS'), '/usr/share/yosys/ice40/cells_sim.v', '/usr/local/share/yosys/ice40/cells_sim.v'].find(p => p && existsSync(p));
if (!rtl && !cells) fail('Set ICE40_CELLS to the Yosys ice40/cells_sim.v library before starting a mapped trial.');
const recipe=readFileSync(recipePath ?? src('../../recipes/hx8k-cpu8.txt'), 'utf8').replaceAll('\r\n','\n');
const profile = fpgaProfile(recipe);
let cwd;
if (dest) {
  cwd = resolve(dest);
  try { mkdirSync(cwd); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fail(`Output path already exists: ${cwd}\nRun npm run test:fpga without a directory to start a fresh trial.`);
  }
} else {
  mkdirSync(output, { recursive: true });
  cwd = mkdtempSync(join(output, grfp ? 'grfp-trial-' : 'fpga-trial-'));
}
console.log(`FPGA trial output: ${cwd}`);
const recorded = grfp && !rtl ? {} : null;
const recordArtifacts = (...names) => {
  if (recorded) Object.assign(recorded, hashBuildArtifacts(cwd, names));
};
const bench = grfp ? 'grfp_trials.sv' : 'trials.sv';
const sources = ['fabric.v', 'top.v'];
for (const f of ['fabric.v', bench]) copyFileSync(src(f), join(cwd, f));
writeFileSync(join(cwd, 'top.v'), topVerilog(profile, grfp));
const protection = grfp && tapeProtection(profile);
if (grfp) {
  writeFileSync(join(cwd,'recipe.txt'),recipe);
  recordArtifacts('recipe.txt');
  writeFileSync(join(cwd,'bench-commits.hex'),commitOracle(recipe).map(n=>n.toString(16).padStart(4,'0')).join('\n')+'\n');
  for (const f of ['grfp_reader.v','tape_sha256.v']) copyFileSync(src(f),join(cwd,f));
  writeFileSync(join(cwd,'protection_roms.v'),protectionRoms(protection));
  sources.push('grfp_reader.v','tape_sha256.v','protection_roms.v');
  // Testbench-only oracle; never in the synthesis inputs.
  const golden=profile.pairs.flatMap(p=>p.images.flatMap(img=>Array.from({length:128},(_,i)=>
    `${Number(i===img.length-1)}${(img[i]??0).toString(16).padStart(8,'0')}`)));
  writeFileSync(join(cwd,'bench-images.hex'),golden.join('\n')+'\n');
}
const opts = { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
const run = (name, args) => execFileSync(tool(name), args, opts);
const report = { profile: 'CRC CPU on four three-site bays', simulation: rtl ? 'RTL' : 'iCE40 mapped primitives',
  recipeSha256: profile.recipeSha256, clusters: profile.logic.map((w,i) => ({ name: profile.laneNames[w.lane],
    lut3: w.lut.length / 4, configWords: profile.pairs[i>>1].images[i%2].length })) };
let design = sources;
if (!rtl) {
  copyFileSync(cells, join(cwd,'cells_sim.v'));
  run('yosys', ['-Q','-q','-l','synthesis.log','-p',`read_verilog ${sources.join(' ')}; synth_ice40 -top regrow_fpga -json mapped.json; check -assert; write_verilog -noattr mapped.v`]);
  recordArtifacts('mapped.v', 'mapped.json');
  const json = JSON.parse(readFileSync(join(cwd,'mapped.json')));
  report.synthesis = { tool: json.creator, cells: {} };
  for (const {type} of Object.values(json.modules.regrow_fpga.cells)) report.synthesis.cells[type] = (report.synthesis.cells[type] ?? 0) + 1;
  run('nextpnr-ice40', ['--hx8k','--package','ct256','--json','mapped.json','--asc','routed.asc','--report','routing.json', ...(grfp?['--write','placed.json']:[]),
    '--seed','1','--freq','12','--pcf-allow-unconstrained','--log','placement.log','--quiet']);
  recordArtifacts('placed.json', 'routed.asc', 'routing.json');
  const { utilization, fmax } = JSON.parse(readFileSync(join(cwd,'routing.json')));
  report.placement = { part: 'HX8K-CT256', seed: 1, utilization, fmax };
  design = ['mapped.v','cells_sim.v'];
}
run('iverilog',['-g2012','-DNO_ICE40_DEFAULT_ASSIGNMENTS','-s','trials','-o','trials.vvp',...design,bench]);
const simulate = promisify(execFile);
async function simLog(arg, file) {
  const {stdout}=await simulate(tool('vvp'),['trials.vvp',arg,...(grfp&&!rtl?['+VIEW']:[])],opts);
  writeFileSync(join(cwd,file),stdout);
  recordArtifacts(file);
  return stdout;
}
let summary, csv;
if (grfp) {
  const logs = await Promise.all(protectedTraceFiles.map((file, group) => simLog(`+GROUP=${group}`, file)));
  const trials=gradeProtection(logs,profile,protection);
  report.protection={ code:'GRFP global16 row 0, d=8, r=1', parityBytes:protection.parity.length,
    sourceBytes:4*protection.lengths.slice(0,8).reduce((a,b)=>a+b,0), sha256:protection.hashes, trials };
  csv=protectionCsv(trials);
  summary=`${trials.length} protected trials; adder tape + primary recovered, next commit after ${trials[3].nextCommitAfterInjection} clocks`;
} else {
  const labels = ['clean', ...profile.logic.map(w=>'primary:'+profile.laneNames[w.lane]), 'cross-bay primaries','same-bay primaries',
    'tape then its primary','spare then its primary','tape only','direct link','both links','spare only','detour only','unread tape at boot'];
  const policyNames = ['regrow','fixed-A','fixed-B'];
  function expectedService(p,id) {
    if ([10,12,15,18].includes(id)) return false;
    if (id===11) return p===1;
    if (id===9) return p===0;
    return !(id>=1 && id<=8) || p===0 || (id-1)%2 === p-1;
  }
  report.policies = Object.fromEntries(await Promise.all(policyNames.map(async (name,p) => {
    const stdout = await simLog(`+POLICY=${p}`,`${name}.log`);
    const rows = stdout.split(/\r?\n/).filter(s=>s.startsWith('TRIAL ')).map((s,index) => {
      const [policy,id,boot,prefix,latency,claim,spares,clocks] = s.split(' ').slice(1).map(Number);
      if (policy!==p || id!==index || prefix!==(expectedService(p,id) ? 7 : 0)) throw Error(`unexpected service: ${s}`);
      if (id>=1 && id<=8 && prefix===7 && !(spares & (1<<(id-1)))) throw Error(`missing physical replacement: ${s}`);
      if (id>=1 && id<=8 && prefix===7 && (p===0 ? claim<=0 : claim!==0)) throw Error(`unexpected cold/hot spare: ${s}`);
      return { fault: labels[id], firstCommit: id===18 ? null : boot, matchingCommits: prefix,
        nextCommitAfterInjection: latency<0 ? null : latency, spareLoadedAfterInjection: claim<0 ? null : claim,
        loadedSpareMask: spares, clocks };
    });
    if (rows.length!==labels.length) throw Error(`incomplete ${name} panel`);
    return [name, rows];
  })));
  csv=panelCsv(report); summary='57 trials';
  for (const name of policyNames) {
    const trials=report.policies[name], singles=trials.slice(1,9).filter(t=>t.matchingCommits===7);
    console.log(`${name}: ${singles.length}/8 live primary faults preserved all seven commits; clean next-capture latency ${trials[0].nextCommitAfterInjection} clocks`);
  }
}
writeFileSync(join(cwd,'report.json'),JSON.stringify(report,null,2)+'\n');
writeFileSync(join(cwd,'panel.csv'),csv);
console.log(`${report.simulation}: ${summary}. Report in ${join(cwd,'report.json')}`);
if (recorded) {
  recordArtifacts('report.json');
  writeBuildManifest(cwd, recorded);
  console.log('Checking live FPGA execution against every recorded pin transition…');
  console.log(`Chip Workbench: ${writeViewerBundle(cwd)}`);
}
