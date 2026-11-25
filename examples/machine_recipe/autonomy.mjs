import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Fabric, machine, trace } from './fabric.mjs';
import { grow, planCpuGrowth, planGrowth } from './grow.mjs';
import { mask } from './damage.mjs';
import { pinout, program, verifyCpu } from './verify.mjs';
import { liveRegisterTrial, tmrCpuRecipe } from './live.mjs';
import { peerRepairTrials } from './peer-repair.mjs';

const baseline=JSON.parse(readFileSync(new URL('./results/report.json',import.meta.url),'utf8'));
const cpu=readFileSync(new URL('../../recipes/cpu.txt',import.meta.url),'utf8');
const {inputs,outputs}=pinout('cpu');
const fresh=padWidth=>new Fabric(64,inputs,outputs,{padWidth});

function tryPads(trial,padWidth,sites,planner=planGrowth) {
  const board=fresh(padWidth);
  grow(board,cpu,planner);
  assert.deepEqual(mask(board,trial.shape,trial.percent,trial.seed),sites,'changed fault mask');
  board.damage(sites,trial.permanent);
  try {
    const {at,stats}=grow(board,cpu,planner);
    const bindings=[...inputs.map((name,i)=>[name,at[i],board.inputs]),
      ...outputs.map((name,i)=>[name,at[at.length-outputs.length+i],board.outputs])];
    const backups=bindings.filter(([name,site,pins])=>pins.get(name)!==site).map(([name,site])=>({name,site}));
    return {pass:true,vectors:verifyCpu(machine(board)).vectors,criticalTicks:stats.criticalTicks,backups};
  } catch (error) {
    const pin=/^unreachable boundary pin: (.+)$/.exec(error.message)?.[1];
    const site=board.inputs.get(pin) ?? board.outputs.get(pin);
    const deadNeighbors=site===undefined?undefined:Array.from(board.neighbors.subarray(site*4,site*4+4))
      .filter(neighbor=>neighbor>=0 && board.dead[neighbor]);
    return {pass:false,error:error.message,deadNeighbors};
  }
}

function pairedPads(panel) {
  return panel.map(({seed,permanent,shape,percent})=>{
    const trial={seed,permanent,shape,percent};
    const sites=mask(fresh(1),shape,percent,seed);
    return {...trial,sites:sites.length,single:tryPads(trial,1,sites),spread:tryPads(trial,4,sites)};
  });
}

function countPads(trials) {
  return {trials:trials.length,single:trials.filter(row=>row.single.pass).length,spread:trials.filter(row=>row.spread.pass).length};
}

export function padTrials() {
  const original=pairedPads(baseline.cpu.trials);
  assert.deepEqual(original.map(row=>row.single.pass),baseline.cpu.trials.map(row=>row.pass));
  const heldOut=pairedPads(Array.from({length:6},(_,i)=>[15,20].map(percent=>({
    seed:20261128+i,permanent:true,shape:'scatter',percent,
  }))).flat());
  const disconnected=fresh(4);
  grow(disconnected,cpu);
  disconnected.damage(Array.from({length:64},(_,i)=>64*i+1),true);
  assert.throws(()=>grow(disconnected,cpu),/unreachable boundary pin: i0/);
  return {contactsPerPin:4,original:countPads(original),heldOut:countPads(heldOut),
    original15:countPads(original.filter(row=>row.permanent&&row.percent===15)),
    original20:countPads(original.filter(row=>row.permanent&&row.percent===20)),
    originalTrials:original,heldOutTrials:heldOut,allContactsCutControl:'unreachable boundary pin: i0'};
}

export function registerTrials() {
  const design=tmrCpuRecipe(), board=fresh(4);
  const layout=planGrowth(board,design.bytes,design.centers,{isolateRegisters:true});
  board.install(layout.config,layout.wave);
  const clean=verifyCpu(machine(board)).vectors;
  const trials=design.bits.flatMap((_,bit)=>[0,1,2].flatMap(copy=>[9,10].map(repairEdge=>{
    const trial=liveRegisterTrial(design,{bit,copy,repairEdge,exhaustive:bit===0&&copy===0&&repairEdge===10});
    assert.equal(trial.damagedValue,1);
    return trial;
  })));
  const control=fresh(4); grow(control,cpu);
  const erased=trace(control,control.config,control.outputs.get('data0'),0).driver;
  let controlError;
  assert.throws(()=>program(machine(control),{beforeEdge(edge,chip) {
    if (edge!==6) return chip;
    chip.settle(); assert.equal(chip.readGate(erased)&1,1);
    control.damage([erased],true); return machine(control);
  }}),error=>{
    controlError=error.message;
    return /^data0: actual /.test(error.message);
  });
  return {bits:design.bits.length,replicas:design.bits.length*3,cleanVectors:clean,cleanTicks:layout.stats.criticalTicks,
    minReplicaSpacing:Math.min(...trials.map(row=>row.replicaSpacing)),
    maxRepairedTicks:Math.max(...trials.map(row=>row.afterTicks)),
    changedValueAtCommit:trials.filter(row=>row.damagedValue!==row.captured).length,
    highValueAtCommit:trials.filter(row=>row.captured===1).length,
    repairedVectors:trials.find(row=>row.repairedVectors).repairedVectors,
    singleRegisterControl:{faultEdge:6,erased,error:controlError},trials};
}

function cpuWiringTrials(pads) {
  const compare=panel=>{
    const cases=panel.map(({seed,permanent,shape,percent,spread})=>{
      const trial={seed,permanent,shape,percent}, sites=mask(fresh(4),shape,percent,seed);
      return {...trial,sites:sites.length,prior:spread ?? tryPads(trial,4,sites),
        revised:tryPads(trial,4,sites,planCpuGrowth)};
    });
    return {trials:cases.length,prior:cases.filter(row=>row.prior.pass).length,
      revised:cases.filter(row=>row.revised.pass).length,cases};
  };
  const scatter=(first,trials)=>Array.from({length:trials},(_,i)=>({
    seed:first+i,permanent:true,shape:'scatter',percent:20,
  }));
  const clean=planner=>{
    const board=fresh(4), {stats:{trackCells,criticalTicks}}=grow(board,cpu,planner);
    return {trackCells,criticalTicks,vectors:verifyCpu(machine(board)).vectors};
  };
  return {contactsPerPin:4,clean:{prior:clean(planGrowth),revised:clean(planCpuGrowth)},
    original:compare(pads.originalTrials),previousHeldOut:compare(pads.heldOutTrials),
    development:compare(scatter(20261134,36)),fresh:compare(scatter(20261170,24))};
}

export function autonomy() {
  const pads=padTrials();
  return {pads,live:registerTrials(),peers:peerRepairTrials(),wiring:cpuWiringTrials(pads)};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const {values}=parseArgs({options:{out:{type:'string'}}});
  const report=autonomy();
  const json=JSON.stringify(report,null,2)+'\n';
  if (values.out) {
    writeFileSync(values.out,json,{flag:'wx'});
    console.log(JSON.stringify({original:report.pads.original,heldOut:report.pads.heldOut,
      liveTrials:report.live.trials.length,peerTrials:report.peers.trials.length,
      wiring:Object.fromEntries(['original','previousHeldOut','development','fresh'].map(key=>{
        const {trials,prior,revised}=report.wiring[key]; return [key,{trials,prior,revised}];
      })),report:values.out},null,2));
  } else process.stdout.write(json);
}
