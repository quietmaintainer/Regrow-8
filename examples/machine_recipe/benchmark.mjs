import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {deflateRawSync} from 'node:zlib';
import {packProtected,recoverProtected} from '../file_recipe/protected.mjs';
import {DATA,FRAME,frameKey,scanFrames} from '../file_recipe/frames.mjs';
import {cutCopy} from '../file_recipe/loss-fixtures.mjs';
import {expand} from './logic.mjs';
import {Fabric,machine,PERIOD,SETTLE_WINDOW,TRACKS} from './fabric.mjs';
import {grow} from './grow.mjs';
import {pinout,verifyAlu,verifyCpu,program} from './verify.mjs';
import {mask} from './damage.mjs';

// Give the decoder a physically shortened archive, with its entire recipe
// data frame gone, and NO original-file argument. Commission the machine from
// restored.bin; the recorded recipe bytes are the equality witness.
function protect(dir,label,bytes) {
  const plain=join(dir,label+'.recipe.json'), archive=join(dir,label+'.grfp');
  fs.writeFileSync(plain,bytes,{flag:'wx'});
  const packed=packProtected(plain,archive,undefined,{text:'off',fec:'global16',parityPercent:5});
  const work=fs.mkdtempSync(join(tmpdir(),'machine-parity-'));
  try {
    const fd=fs.openSync(archive,'r'); let entry;
    try { const scan=scanFrames(fd); assert.equal(scan.catalog.stripe,'global16'); entry=scan.entries.get(frameKey(DATA,0)); }
    finally {fs.closeSync(fd);}
    const bad=join(work,'cut.grfp'), restored=join(work,'restored');
    const removed=cutCopy(archive,bad,[[entry.at,FRAME+entry.n]]), result=recoverProtected(bad,restored);
    const recovered=fs.readFileSync(join(restored,'restored.bin'));
    assert.deepEqual(recovered,bytes); assert.deepEqual(fs.readFileSync(join(restored,'protected.grfp')),fs.readFileSync(archive));
    assert.equal(result.recipeGroupsFromParity,1); assert.equal(result.recipeGroupsFromOriginal,0);
    return {recovered,stats:{recipeBytes:bytes.length,grfpBytes:fs.statSync(archive).size,deletedFrameBytes:removed,
      parityFrames:packed.parityFrames,groupsRecoveredFromParity:result.recipeGroupsFromParity}};
  } finally {fs.rmSync(work,{recursive:true,force:true});}
}

function suite(label,dir,seeds,side) {
  const archived=fs.readFileSync(new URL('./results/'+label+'.recipe.json',import.meta.url));
  const {recovered,stats}=protect(dir,label,archived), graph=expand(recovered), recipe=JSON.parse(recovered);
  const {inputs,outputs}=pinout(label), fresh=()=>new Fabric(side,inputs,outputs), pristine=fresh();
  const {at,stats:grown}=grow(pristine,recovered);
  const verify=label==='alu'?verifyAlu:verifyCpu;
  const clean=verify(machine(pristine));
  const flat=Buffer.from(JSON.stringify({inputs:graph.inputs,outputs:graph.outputs,gates:graph.gates}));
  const raw=pristine.raw(), size={...stats,templates:recipe.defs.length,instances:recipe.use.length,
    flatNetlistBytes:flat.length,gridBytes:raw.length,deflatedFlatBytes:deflateRawSync(flat).length,
    deflatedGridBytes:deflateRawSync(raw).length,deflatedRecipeBytes:deflateRawSync(recovered).length};
  const trials=[];
  for (const seed of seeds) for (const permanent of [false,true]) for (const shape of ['crater','scatter']) {
    for (const percent of permanent?[5,10,15,20]:[25,50,75]) {
      const b=fresh(); grow(b,recovered);
      const sites=mask(b,shape,percent,seed), hits=new Set(sites);
      const trial={seed,permanent,shape,percent,sites:sites.length,gatesHit:Array.from(at).filter(p=>hits.has(p)).length};
      trials.push(trial); b.damage(sites,permanent);
      try { (label==='alu'?verifyAlu:program)(machine(b)); trial.detectedBefore=false; } catch {trial.detectedBefore=true;}
      try {
        const {at:next,stats:repair}=grow(b,recovered);
        const relocated=at.reduce((sum,p,id)=>sum+(p!==next[id]),0);
        if (permanent) {
          assert.ok(relocated>=trial.gatesHit);
          for (const p of sites) {
            assert.ok(!b.probe(p)); assert.equal(b.config.kind[p],0);
            assert.ok(b.config.wire.subarray(p*TRACKS,(p+1)*TRACKS).every(v=>!v));
          }
        }
        Object.assign(trial,{relocated,...repair,vectors:verify(machine(b)).vectors,pass:true});
      } catch(e) { Object.assign(trial,{pass:false,error:e.message}); }
    }
  }
  return {size,programmableSites:pristine.fixed.reduce((n,x)=>n+1-x,0),grown,clean,trials};
}

export function benchmark(dir,seed=20261125,count=3) {
  const side=64, seeds=Array.from({length:count},(_,i)=>(seed+i)>>>0);
  return {seeds,side,tracksPerSite:TRACKS,clockPeriod:PERIOD,settleWindow:SETTLE_WINDOW,
    alu:suite('alu',dir,seeds,side),cpu:suite('cpu',dir,seeds,side)};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const {values}=parseArgs({options:{out:{type:'string'},seed:{type:'string',default:'20261125'},count:{type:'string',default:'3'}}});
  const seed=Number(values.seed), count=Number(values.count);
  if (!Number.isInteger(seed)||seed<0||seed>0xffffffff) throw Error('seed must be a u32');
  if (!Number.isSafeInteger(count)||count<1) throw Error('count must be a positive integer');
  const dir=values.out ?? fs.mkdtempSync(join(tmpdir(),'machine-recipe-'));
  if (values.out) fs.mkdirSync(dir); // Refuse to overwrite a previous run.
  try {
    const report=benchmark(dir,seed,count);
    fs.writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    for (const label of ['alu','cpu']) {
      const r=report[label], failed=r.trials.filter(t=>!t.pass);
      console.log(`${label}: initial ${r.clean.vectors} vectors; ${r.trials.length-failed.length}/${r.trials.length} repairs passed; recipe ${r.size.recipeBytes} B, .grfp ${r.size.grfpBytes} B`);
      for (const t of failed) console.error(`seed ${t.seed}, ${t.permanent?'stuck':'erased'} ${t.shape} ${t.percent}%: ${t.error}`);
      if (failed.length) process.exitCode=1;
    }
    if (values.out) console.log(join(dir,'report.json'));
  } finally {if (!values.out) fs.rmSync(dir,{recursive:true,force:true});}
}
