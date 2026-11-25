import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packProtected, recoverProtected } from '../file_recipe/protected.mjs';
import { DATA, FRAME, frameKey, scanFrames } from '../file_recipe/frames.mjs';
import { DFF, expand } from './logic.mjs';
import { Fabric, TRACKS, image, machine, survey, trace } from './fabric.mjs';
import { planGrowth } from './grow.mjs';

const peers=['A','B'];
const addressBits=[0,1,2];
const fields=[['kind',1],['tag',1],['socket',3],['wire',TRACKS]];

// The clocked supervisors and one-bit computers are defined in the text recipe.
function peerRecipe() {
  const recipe=fs.readFileSync(new URL('../../recipes/peers.txt',import.meta.url),'utf8');
  const {inputs,outputs,ids}=expand(recipe);
  const centers=peers.flatMap((_,index)=>{
    const x=index?47:17;
    return [[x,19],[x-6,26],[x,29],[x+6,26],[x,43],[x,53]];
  });
  const cores=peers.map(name=>{
    const gate=local=>ids.get(name+'.'+local);
    return {name,voter:gate('vote'),next:gate('next'),copies:[0,1,2].map(copy=>gate('copy'+copy)),reader:gate('read')};
  });
  return {recipe,inputs,outputs,centers,cores};
}

function gateSite(board,id) { return board.config.tag.indexOf(id+1); }

function tile(config,site) {
  return fields.flatMap(([key,width])=>Array.from(config[key].subarray(site*width,(site+1)*width)));
}

function patch(board,plan) {
  const writes=[];
  for (const site of plan.wave) {
    const before=tile(board.config,site), after=tile(plan.config,site);
    if (before.some((value,i)=>value!==after[i])) writes.push([site,before,after]);
  }
  return writes;
}

function provision() {
  const design=peerRecipe();
  const create=()=>new Fabric(64,design.inputs,design.outputs);
  const route=board=>planGrowth(board,design.recipe,design.centers,{isolateRegisters:true});
  const base=route(create());
  const boot=()=>{ const board=create(); board.install(base.config,base.wave); return board; };
  const victims=design.cores.map(({copies})=>base.at[copies[0]]);
  const spares=design.cores.map(({copies},i)=>{
    const board=boot(); board.damage([victims[i]],true); return route(board).at[copies[0]];
  });
  const targets=[];
  const occupied=new Set();
  function reserve(config) {
    for (let site=0;site<config.kind.length;site++) if (config.kind[site] || config.wire.subarray(site*TRACKS,(site+1)*TRACKS).some(Boolean)) {
      occupied.add(site);
    }
  }
  reserve(base.config);
  for (let target=0;target<2;target++) {
    const peer=1-target, targetId=design.cores[target].copies[0], peerId=design.cores[peer].copies[0];
    const variants=[];
    for (const prior of [[],[victims[peer]],[victims[peer],spares[peer]]]) {
      let preferred;
      for (const fallback of [false,true]) {
        const board=boot();
        if (prior.length) {
          board.damage(prior,true);
          const previous=route(board);
          board.install(previous.config,previous.wave);
        }
        const peerTile=gateSite(board,peerId);
        board.damage(fallback?[victims[target],preferred]:[victims[target]],true);
        const next=route(board);
        if (!fallback) preferred=next.at[targetId];
        reserve(next.config);
        assert.ok(next.at[targetId]!==victims[target]);
        assert.equal(next.at[peerId],peerTile);
        variants.push({peerTile,newTile:next.at[targetId],writes:patch(board,next)});
      }
    }
    assert.ok(variants.length<=2**addressBits.length);
    targets.push(variants);
  }
  const reference=boot();
  const storage=peers.map((_,index)=>Array.from({length:reference.n},(_,site)=>site)
    .filter(site=>!occupied.has(site) && !reference.fixed[site] && (site%reference.side<reference.side/2)===(index===0))
    .slice(0,3));
  assert.ok(storage.every(sites=>sites.length===3));
  return {cores:design.cores,recipe:design.recipe.toString('utf8'),boot,victims,spares,targets,storage,criticalTicks:base.stats.criticalTicks};
}

// The configuration port mounts an archive from three memory tiles on the same
// board. Loss of the middle tile removes an entire checked data frame.
function protectedBank(dir,index,sites,recipe,variants) {
  const source=join(dir,`peer-${index}.json`), archive=join(dir,`peer-${index}.grfp`);
  fs.writeFileSync(source,JSON.stringify({recipe,variants}),{flag:'wx'});
  packProtected(source,archive,undefined,{text:'off',fec:'global16',parityPercent:5});
  const fd=fs.openSync(archive,'r');
  let data;
  try { data=scanFrames(fd).entries.get(frameKey(DATA,0)); }
  finally { fs.closeSync(fd); }
  const bytes=fs.readFileSync(archive);
  const cut=data.at+FRAME+data.n;
  return {sites,size:bytes.length,shards:[bytes.subarray(0,data.at),bytes.subarray(data.at,cut),bytes.subarray(cut)]};
}

function readBank(board,bank,dir,edge,owner) {
  const path=join(dir,`read-${edge}-${owner}.grfp`), out=join(dir,`read-${edge}-${owner}`);
  fs.writeFileSync(path,Buffer.concat(bank.shards.filter((_,i)=>board.probe(bank.sites[i]))),{flag:'wx'});
  const recovered=recoverProtected(path,out);
  const document=JSON.parse(fs.readFileSync(join(out,'restored.bin'),'utf8'));
  return {...document,parity:recovered.recipeGroupsFromParity};
}

function verifyLayout(board,config,recipe) {
  const {inputs,outputs,gates}=expand(recipe), at=new Int32Array(gates.length).fill(-1);
  inputs.forEach((name,i)=>{ at[i]=board.inputs.get(name); });
  outputs.forEach((name,i)=>{ at[gates.length-outputs.length+i]=board.outputs.get(name); });
  for (let site=0;site<board.n;site++) if (config.tag[site]) at[config.tag[site]-1]=site;
  for (const [id,[kind,...refs]] of gates.entries()) {
    const site=at[id]; assert.equal(config.kind[site],kind);
    refs.forEach((source,input)=>assert.equal(trace(board,config,site,input).driver,at[source]));
  }
}

function routeUsable(board,record,peerTile) {
  if (!record || record.peerTile!==peerTile) return false;
  const {distance}=survey(board);
  return record.writes.every(([site,before])=>distance[site]>=0 &&
    tile(board.config,site).every((value,field)=>value===before[field]));
}

function applyPatch(board,recipe,record,peerTile,restoredValue) {
  assert.ok(routeUsable(board,record,peerTile),'requested route cannot be applied');
  const config=image(board.n);
  for (const [key] of fields) config[key].set(board.config[key]);
  const sites=[];
  for (const [site,,after] of record.writes) {
    let offset=0;
    for (const [key,width] of fields) {
      config[key].set(after.slice(offset,offset+width),site*width);
      offset+=width;
    }
    sites.push(site);
  }
  verifyLayout(board,config,recipe);
  const {criticalTicks}=machine(board,config);
  const stats=board.install(config,sites);
  board.q[record.newTile]=restoredValue;
  return {...stats,criticalTicks,site:record.newTile};
}

function tapeAddress(chip,name) {
  return addressBits.reduce((address,bit)=>address|((chip.read(`${name}_address${bit}`)&1)<<bit),0);
}

function runPair(layout,banks,dir,order,{control=false,blockSpare=false}={}) {
  const {cores,victims,spares}=layout, board=layout.boot(), pending=[null,null], events=[];
  const cycles=36, expected=[0,0], injuries=control?[[5,order[0]]]:[[5,order[0]],[21,order[1]]];
  board.damage(banks.map(bank=>bank.sites[1]),true);
  if (control) board.damage([gateSite(board,cores[1-order[0]].reader)],false);
  let chip=machine(board);
  const drives=(engine,commands)=>{
    engine.settle();
    const diagnostics=cores.map(({name,copies},owner)=>{
      const target=cores[1-owner], restored=gateSite(board,target.copies[0]), voter=gateSite(board,target.voter);
      const archive=pending[owner], address=tapeAddress(engine,name);
      return {missing:restored<0,present:restored>=0 && board.config.kind[restored]===DFF
        && trace(board,board.config,restored,0).driver===gateSite(board,target.next)
        && trace(board,board.config,voter,0).driver===restored,
      usable:!!(engine.read(`${name}_search`)&1) && routeUsable(board,archive?.variants[address],gateSite(board,copies[0])),
      last:!!archive && address===archive.variants.length-1,
      expected:engine.readGate(voter)&1,readback:restored<0?0:engine.readGate(restored)&1};
    });
    cores.forEach(({name},owner)=>{
      engine.drive(`${name}.op`,-commands[owner]);
      for (const [pin,bit] of Object.entries(diagnostics[owner])) engine.drive(`${name}.${pin}`,-Number(bit));
    });
    engine.settle();
    return diagnostics;
  };
  for (let edge=0;edge<cycles;edge++) {
    const injury=injuries.find(([when])=>when===edge);
    if (injury) {
      const [,target]=injury;
      chip.settle();
      assert.equal(chip.readGate(victims[target])&1,1);
      const sites=blockSpare && edge===5?[victims[target],spares[target]]:[victims[target]];
      board.damage(sites,true);
      chip=machine(board);
      events.push({edge,event:'fault',target:cores[target].name,sites});
    }
    const commands=peers.map((_,owner)=>Number(edge!==33+owner));
    let diagnostics=drives(chip,commands);
    for (const [owner,{name,copies}] of cores.entries()) {
      const target=cores[1-owner];
      if (chip.read(`${name}_read`)&1) {
        const archive=readBank(board,banks[owner],dir,edge,name);
        pending[owner]=archive;
        events.push({edge,event:'read',owner:name,target:target.name,recoveredFromParity:archive.parity});
      }
      if (chip.read(`${name}_search`)&1) {
        const address=tapeAddress(chip,name);
        const record=pending[owner]?.variants[address];
        assert.ok(record,'tape cursor has no route record');
        events.push({edge,event:'candidate',owner:name,target:target.name,address,usable:diagnostics[owner].usable});
      }
      if (chip.read(`${name}_program`)&1) {
        const archive=pending[owner];
        assert.ok(archive,'program command before tape read');
        const address=tapeAddress(chip,name);
        const value=chip.readGate(gateSite(board,target.voter));
        const stats=applyPatch(board,archive.recipe,archive.variants[address],gateSite(board,copies[0]),value);
        assert.equal(gateSite(board,target.copies[0]),stats.site);
        pending[owner]=null;
        chip=machine(board);
        diagnostics=drives(chip,commands);
        events.push({edge,event:'program',owner:name,target:target.name,address,captured:value&1,...stats});
      }
      if (chip.read(`${name}_verify`)&1) {
        assert.equal(chip.read(`${name}_verified`)&1,1,'peer verification failed');
        events.push({edge,event:'verified',owner:name,target:target.name});
      }
    }
    for (const [i,{name}] of cores.entries()) {
      assert.equal(chip.read(`${name}_vote`)&1,expected[i],`${name} diverged on edge ${edge}`);
      expected[i]^=commands[i];
    }
    chip.rise();
  }
  chip.settle();
  for (const [i,{name}] of cores.entries()) assert.equal(chip.read(`${name}_vote`)&1,expected[i]);
  const verified=events.filter(({event})=>event==='verified');
  if (control) {
    assert.equal(verified.length,0);
    assert.equal(gateSite(board,cores[order[0]].copies[0]),-1);
  } else {
    assert.deepEqual(verified.map(({target})=>target),order.map(i=>cores[i].name));
    assert.ok(events.filter(({event})=>event==='read').every(({recoveredFromParity})=>recoveredFromParity>0));
  }
  return {cycles,order:order.map(i=>cores[i].name),events,final:expected,control,blockSpare};
}

export function peerRepairTrials() {
  const parent=fs.realpathSync(tmpdir()), work=fs.mkdtempSync(join(parent,'swarm-peer-repair-'));
  try {
    const {storage,targets,recipe,...layout}=provision();
    const banks=peers.map((_,owner)=>protectedBank(work,owner,storage[owner],recipe,targets[1-owner]));
    const run=(label,order,options)=>{
      const dir=join(work,label); fs.mkdirSync(dir);
      return runPair(layout,banks,dir,order,options);
    };
    return {sharedFabric:64,criticalTicks:layout.criticalTicks,archiveBytes:banks.map(bank=>bank.size),
      memoryTiles:banks.map(bank=>bank.sites),trials:[run('first-a',[0,1]),run('first-b',[1,0]),
        run('spare-removed',[0,1],{blockSpare:true})],control:run('reader-removed',[0,1],{control:true})};
  } finally {
    if (dirname(fs.realpathSync(work))!==parent) throw Error('Temporary repair directory escaped its parent');
    fs.rmSync(work,{recursive:true,force:true});
  }
}
