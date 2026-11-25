import * as fs from 'node:fs';
import {isDeepStrictEqual,parseArgs} from 'node:util';
import {expand} from './logic.mjs';
import {Fabric,machine} from './fabric.mjs';
import {grow,planCpuGrowth} from './grow.mjs';
import {mask} from './damage.mjs';
import {pinout,verifyAlu,verifyCpu} from './verify.mjs';

const {positionals:[action,kind,path,...extra],values}=parseArgs({allowPositionals:true,options:{
  stuck:{type:'string',default:'0'},shape:{type:'string',default:'scatter'},seed:{type:'string',default:'20261125'},
}});
if (action!=='check' || !['circuit','alu','cpu'].includes(kind) || !path || extra.length) {
  throw Error('check <circuit|alu|cpu> <recipe> [--stuck percent --shape crater|scatter --seed n]');
}

const seed=Number(values.seed);
if (!Number.isInteger(seed)||seed<0||seed>0xffffffff) throw Error('seed must be a u32');
const recipe=fs.readFileSync(path,'utf8'), graph=expand(recipe);
const {inputs,outputs}=kind==='circuit'?graph:pinout(kind);
const topology=({inputs,outputs,groups,gates})=>[inputs,outputs,groups,gates];
const standardCpu=kind==='cpu' && isDeepStrictEqual(topology(graph),
  topology(expand(fs.readFileSync(new URL('../../recipes/cpu.txt',import.meta.url),'utf8'))));
const planner=standardCpu?planCpuGrowth:undefined;
const board=new Fabric(64,inputs,outputs,{padWidth:standardCpu?4:1});
const grown=grow(board,recipe,planner).stats;
const scars=mask(board,values.shape,Number(values.stuck),seed);
board.damage(scars,true);
const repaired=grow(board,recipe,planner).stats;
const verify={alu:verifyAlu,cpu:verifyCpu}[kind];
const checked=verify?.(machine(board));
console.log(JSON.stringify({grown,stuckSites:scars.length,repaired,checked},null,2));
