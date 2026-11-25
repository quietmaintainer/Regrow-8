import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expand } from './logic.mjs';
import { Fabric, machine } from './fabric.mjs';
import { planGrowth } from './grow.mjs';
import { pinout, program, verifyCpu } from './verify.mjs';

export function tmrCpuRecipe(side=64) {
  const bytes=readFileSync(new URL('../../recipes/tmr-cpu.txt',import.meta.url),'utf8');
  const {groups,ids}=expand(bytes);
  const names=[...ids.keys()].filter(name=>ids.has(name+'.copy0'));
  const bits=names.map(name=>({name,voter:ids.get(name),
    copies:[0,1,2].map(copy=>ids.get(name+'.copy'+copy))}));
  const coreGroups=groups.slice(0,groups.length-bits.length*3);
  const columns=Math.ceil(Math.sqrt(coreGroups.length)), rows=Math.ceil(coreGroups.length/columns);
  const centers=coreGroups.map((_,index)=>{
    const row=Math.floor(index/columns), col=index%columns;
    return [(row%2 ? columns-col-.5 : col+.5)*side/columns,(row+.5)*side/rows];
  });
  for (const {voter} of bits) {
    const module=coreGroups.findIndex(group=>group.includes(voter));
    const [x,y]=centers[module];
    for (const [dx,dy] of [[-4,3],[0,6],[4,3]]) centers.push([x+dx,Math.min(side-2,y+dy)]);
  }
  return {bytes,centers,bits};
}

function replicaSpacing(board,placement,bits) {
  const distances=[];
  for (const {copies} of bits) for (let i=0;i<copies.length;i++) for (let j=0;j<i;j++) {
    const a=placement[copies[i]], b=placement[copies[j]];
    distances.push(Math.abs(a%board.side-b%board.side)+Math.abs(Math.floor(a/board.side)-Math.floor(b/board.side)));
  }
  return Math.min(...distances);
}

export function liveRegisterTrial(design,{bit=0,copy=0,atEdge=6,repairEdge=10,cycles=32,exhaustive=false}={}) {
  const target=design.bits[bit];
  if (!Number.isInteger(bit) || !target || !Number.isInteger(copy) || target.copies[copy]===undefined
    || ![atEdge,repairEdge,cycles].every(Number.isInteger) || atEdge<1 || atEdge>=repairEdge || repairEdge>=cycles) {
    throw Error('invalid live register trial');
  }
  const {inputs,outputs}=pinout('cpu'), board=new Fabric(64,inputs,outputs,{padWidth:4});
  const route=()=>planGrowth(board,design.bytes,design.centers,{isolateRegisters:true});
  const original=route();
  board.install(original.config,original.wave);
  const tile=original.at[target.copies[copy]];
  let repair, captured, damagedValue, final;
  const stores=program(machine(board),{
    cycles,
    onSample:sample=>{ final=sample; },
    beforeEdge(edge,chip) {
      if (edge===atEdge) {
        chip.settle();
        damagedValue=chip.readGate(tile)&1;
        board.damage([tile],true);
        repair=route();
        // Run the commissioned machine with its missing replica until commit.
        return machine(board);
      }
      if (edge===repairEdge) {
        chip.settle();
        const value=chip.readGate(original.at[target.voter]);
        captured=value&1;
        const moved=design.bits.flatMap(({copies})=>copies.filter(id=>original.at[id]!==repair.at[id]));
        assert.deepEqual(moved,[target.copies[copy]]);
        board.install(repair.config,repair.wave);
        const restored=repair.at[target.copies[copy]];
        board.q[restored]=value;
        const repaired=machine(board);
        repaired.settle();
        assert.equal(repaired.readGate(restored),value);
        assert.equal(repaired.readGate(repair.at[target.voter]),value);
        return repaired;
      }
    },
  });
  assert.ok(!board.probe(tile));
  const spacing=Math.min(replicaSpacing(board,original.at,design.bits),replicaSpacing(board,repair.at,design.bits));
  assert.ok(spacing>=3);
  return {bit:target.name,copy,atEdge,repairEdge,edgesWhileDamaged:repairEdge-atEdge,cycles,
    oldTile:tile,newTile:repair.at[target.copies[copy]],damagedValue,captured,final,stores,
    replicaSpacing:spacing,beforeTicks:original.stats.criticalTicks,afterTicks:repair.stats.criticalTicks,
    ...(exhaustive?{repairedVectors:verifyCpu(machine(board)).vectors}:{})};
}
