import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {expand,arity,IN,OUT,DFF} from './logic.mjs';
import {Fabric,TRACKS,SETTLE_WINDOW,trace,machine} from './fabric.mjs';
import {grow,planCpuGrowth} from './grow.mjs';
import {mask} from './damage.mjs';
import {pinout,verifyAlu,verifyCpu,program} from './verify.mjs';
import {liveRegisterTrial,tmrCpuRecipe} from './live.mjs';
import {peerRepairTrials} from './peer-repair.mjs';

const alu=readFileSync(new URL('../../recipes/alu.txt',import.meta.url),'utf8');
const cpu=readFileSync(new URL('../../recipes/cpu.txt',import.meta.url),'utf8');

function fixture(recipe) {
  const {inputs,outputs}=expand(recipe), board=new Fabric(64,inputs,outputs);
  const placed=grow(board,recipe);
  return {board,recipe,placed};
}

test('losing a result gate breaks the real output; every intact path survives relocation byte-for-byte',()=>{
  const {board:b,recipe,placed}=fixture(alu), c=b.config;
  const victim=trace(b,c,b.outputs.get('y0'),0).driver, intact=[];
  for (let p=0;p<b.n;p++) for (let k=0;k<arity[c.kind[p]];k++) {
    const path=trace(b,c,p,k);
    if (p!==victim && path.path.every(j=>Math.floor(j/TRACKS)!==victim)) intact.push([p,k,path]);
  }
  const previous=machine(b); b.damage([victim],true);
  assert.throws(()=>previous.settle(),/fabric changed/);
  assert.throws(()=>verifyAlu(machine(b)),/ALU op=/);
  const fixed=grow(b,recipe);
  assert.equal(fixed.stats.gatesPlaced,1); assert.equal(fixed.stats.pathsKept,intact.length);
  assert.ok(fixed.stats.modulesKept>0 && fixed.stats.modulesKept<fixed.stats.modules);
  assert.equal(placed.at.filter((p,i)=>p!==fixed.at[i]).length,1);
  assert.ok(!b.probe(victim)); assert.notEqual(trace(b,c,b.outputs.get('y0'),0).driver,victim);
  for (const [p,k,path] of intact) assert.deepEqual(trace(b,c,p,k),path);
  assert.equal(verifyAlu(machine(b)).vectors,262144);
  assert.equal(grow(b,recipe).stats.fieldWrites,0);
});

test('an unreachable fixed pin refuses repair without partial writes to the surviving fabric',()=>{
  const {board:b,recipe}=fixture(cpu), p=b.inputs.get('i0');
  b.damage(Array.from(b.neighbors.slice(4*p,4*p+4)).filter(q=>q>=0),true);
  const damaged=b.raw(); assert.throws(()=>grow(b,recipe),/unreachable boundary pin/); assert.deepEqual(b.raw(),damaged);
});

test('DFF state survives quiescent repair of a different gate; erased state is not silently reconstructed',()=>{
  const {board:b,recipe}=fixture(cpu);
  const m=machine(b); m.drive('i0',-1); m.settle(); m.rise(); m.settle(); matchData(m,-1);
  const q=trace(b,b.config,b.outputs.get('data0'),0).driver;
  assert.equal(b.config.kind[q],DFF);
  b.damage([trace(b,b.config,b.outputs.get('we'),0).driver],false);
  grow(b,recipe); const retained=machine(b); retained.settle(); matchData(retained,-1);
  b.damage([q],true); grow(b,recipe); const reset=machine(b); reset.settle(); matchData(reset,0);
  assert.deepEqual(program(reset),[[1,3,1],[4,3,0],[8,3,0],[12,3,0]]);
  function matchData(chip,value) { assert.equal(chip.read('data0'),value); }
});

test('literal one-hop switch propagation reaches the output exactly on the elaborated timing bound after a detour',()=>{
  const bytes=['inputs in','group inverter','gate inv NOT in','output out inv'].join('\n');
  const b=new Fabric(24,['in'],['out']); grow(b,bytes);
  const wall=Array.from({length:20},(_,i)=>(i+2)*24+12);
  b.damage(wall,true); grow(b,bytes);
  const m=machine(b), c=b.config, inPin=b.inputs.get('in'), out=b.outputs.get('out');
  let gates=new Uint8Array(b.n), tracks=new Uint8Array(c.wire.length);
  const switches=Array.from(c.wire.keys()).filter(j=>c.wire[j]);
  const active=Array.from(c.kind.keys()).filter(p=>c.kind[p]);
  function tick() {
    const g=gates.slice(), t=tracks.slice();
    for (const j of switches) {
      const p=Math.floor(j/TRACKS), code=c.wire[j];
      if (code===1) t[j]=gates[p];
      else {
        const d=Math.floor((code-2)/TRACKS), delta=[-1,1,-b.side,b.side][d];
        t[j]=tracks[(p+delta)*TRACKS+(code-2)%TRACKS];
      }
    }
    for (const p of active) if (c.kind[p]!==IN) {
      const bit=tracks[p*TRACKS+c.socket[p*3]-1];
      g[p]=c.kind[p]===OUT?bit:1-bit;
    }
    gates=g; tracks=t;
  }
  for (let i=0;i<m.criticalTicks;i++) tick(); assert.equal(gates[out],1);
  gates[inPin]=1; m.drive('in',-1); m.settle();
  for (let i=1;i<m.criticalTicks;i++) {tick(); assert.equal(gates[out],1);}
  tick(); assert.equal(gates[out],0); assert.equal(m.read('out'),0);
});

test('wire readback follows independent crossing tracks and goes low beyond a break',()=>{
  const b=new Fabric(8,['a','b'],['out','unused']), c=b.config;
  const a=b.inputs.get('a'), bottom=b.inputs.get('b'), crossing=a+3;
  c.wire[a*TRACKS]=1;
  for (let x=1;x<b.side;x++) c.wire[(a+x)*TRACKS]=2;
  c.socket[3*b.outputs.get('out')]=1;

  // The second wire rises across the first on lane 1, then ends without a socket.
  c.wire[bottom*TRACKS+1]=1;
  for (let x=1;x<=3;x++) c.wire[(bottom+x)*TRACKS+1]=3;
  for (let site=bottom+3-b.side;site>=crossing;site-=b.side) c.wire[site*TRACKS+1]=3+3*TRACKS;
  const chip=machine(b);
  assert.throws(()=>chip.wireLevels(),/unsettled/);
  const crossingLevels=engine=>Array.from(engine.wireLevels().slice(crossing*TRACKS,crossing*TRACKS+2));
  chip.drive('a',-1); chip.settle();
  assert.deepEqual(crossingLevels(chip),[1,0]);
  chip.drive('a',0); chip.drive('b',-1); chip.settle();
  assert.deepEqual(crossingLevels(chip),[0,1]);

  b.damage([bottom+1],true);
  assert.throws(()=>chip.wireLevels(),/changed fabric/);
  const cut=machine(b);
  cut.drive('a',-1); cut.drive('b',-1); cut.settle();
  assert.deepEqual(crossingLevels(cut),[1,0]);
});

test('a physically connected wire that misses the fixed sampling deadline is rejected',()=>{
  const b=new Fabric(64,['in'],['out']), c=b.config, src=b.inputs.get('in'), dst=b.outputs.get('out');
  let p=src; c.wire[p*TRACKS]=1;
  function step(delta,back) {p+=delta; c.wire[p*TRACKS]=2+back*TRACKS;}
  // Snake through nine rows, then return up a separate column to the output.
  for (let row=0;row<9;row++) {
    for(let i=0;i<62;i++) row%2 ? step(-1,1) : step(1,0);
    if (row<8) step(64,2);
  }
  step(1,0); for (let i=0;i<8;i++) step(-64,3);
  assert.equal(p,dst); c.socket[3*p]=1; assert.ok(trace(b,c,p,0).path.length>=SETTLE_WINDOW);
  assert.throws(()=>machine(b),/timing failure/);
});

test('text and archived CPU recipes agree and reject an unbound driver',()=>{
  const doc=JSON.parse(readFileSync(new URL('./results/cpu.recipe.json',import.meta.url),'utf8'));
  const {ids,...graph}=expand(cpu);
  assert.ok(ids.has('reg0.q'));
  assert.deepEqual(graph,expand(JSON.stringify(doc)));
  assert.throws(()=>expand('inputs a\ngroup test\ngate inv NOT typo\noutput b inv'),/Recipe line 3: unknown driver typo/);
  assert.throws(()=>expand('inputs a\ngroup test\ngate a NOT a\noutput b a'),/Recipe line 3: duplicate signal a/);
  assert.ok(doc.defs.length<doc.use.length);
  doc.out[0]=99999; assert.throws(()=>expand(JSON.stringify(doc)),/invalid signal/);
});

test('the shipped CPU recipe runs the complete ISA at the original pins on the 15% scar',()=>{
  const {inputs,outputs}=pinout('cpu'), b=new Fabric(64,inputs,outputs);
  const bytes=readFileSync(new URL('./results/cpu.recipe.json',import.meta.url));
  const before=grow(b,bytes), dead=mask(b,'scatter',15,20261125);
  b.damage(dead,true); const after=grow(b,bytes);
  assert.ok(before.at.some((p,i)=>p!==after.at[i])); assert.ok(after.stats.pathsKept>0);
  assert.equal(verifyCpu(machine(b)).vectors,2097152);
});

test('spread contacts recover isolated inputs and outputs under the original fault masks',()=>{
  const {inputs,outputs}=pinout('cpu'), bytes=cpu;
  for (const [pin,percent,seed] of [['i4',15,20261127],['addr1',20,20261126]]) {
    const single=new Fabric(64,inputs,outputs), spread=new Fabric(64,inputs,outputs,{padWidth:4});
    const sites=mask(single,'scatter',percent,seed);
    assert.deepEqual(mask(spread,'scatter',percent,seed),sites);
    grow(single,bytes); single.damage(sites,true);
    assert.throws(()=>grow(single,bytes),{message:`unreachable boundary pin: ${pin}`});
    grow(spread,bytes); spread.damage(sites,true);
    const {at}=grow(spread,bytes), input=spread.inputs.has(pin);
    const contacts=input?spread.inputContacts:spread.outputContacts;
    const pad=input?at[inputs.indexOf(pin)]:at[at.length-outputs.length+outputs.indexOf(pin)];
    assert.ok(contacts.get(pin).slice(1).includes(pad));
    assert.equal(verifyCpu(machine(spread)).vectors,2097152);
  }
});

test('the revised CPU wiring repairs the three congested scatter masks',()=>{
  const {inputs,outputs}=pinout('cpu'), bytes=cpu;
  for (const seed of [20261128,20261130,20261132]) {
    const board=new Fabric(64,inputs,outputs,{padWidth:4});
    grow(board,bytes,planCpuGrowth);
    board.damage(mask(board,'scatter',20,seed),true);
    const {stats}=grow(board,bytes,planCpuGrowth);
    assert.ok(stats.pathsKept>0 && stats.pathsRouted>0);
    assert.equal(verifyCpu(machine(board)).vectors,2097152);
  }
});

test('a live CPU copies the commit-time vote after losing a high register replica',()=>{
  const design=tmrCpuRecipe();
  const low=liveRegisterTrial(design,{repairEdge:9}), high=liveRegisterTrial(design,{repairEdge:10});
  assert.equal(low.damagedValue,1);
  assert.equal(low.captured,0);
  assert.equal(high.captured,1);
  assert.notEqual(low.oldTile,low.newTile);
  assert.deepEqual(low.final,high.final);
  assert.deepEqual(low.stores,high.stores);
});

test('the two fabric supervisors heal both ways from parity and can bypass a dead spare',()=>{
  const {trials,control}=peerRepairTrials();
  const writes=trial=>trial.events.filter(({event})=>event==='program');
  assert.deepEqual(trials.map(trial=>writes(trial).map(({owner})=>owner)),[['B','A'],['A','B'],['B','A']]);
  assert.notEqual(writes(trials[0])[0].site,writes(trials[2])[0].site);
  assert.deepEqual(trials[2].events.filter(({event,target})=>event==='candidate' && target==='A')
    .map(({address,usable})=>[address,usable]),[[0,false],[1,true]]);
  assert.equal(writes(trials[2])[0].address,1);
  assert.equal(writes(control).length,0);
});
