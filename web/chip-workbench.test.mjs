import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkTrace,identity,openBundle,shaText,stateAt,unpackSite} from './chip-model.mjs';
import {recipeGraph,commitOracle} from '../examples/fpga_fabric/recipe-graph.mjs';
import {verifyLiveTraces} from '../examples/fpga_fabric/verify-live-traces.mjs';
import {RecipeHistory,editGate} from './chip-editor.mjs';

const asset=readFileSync(new URL('./chip-example.json',import.meta.url),'utf8');
test('shipped workbench traces match the mapped adder repair, word bus and independent architectural oracle',async()=>{
  const d=await openBundle(asset),sc=d.scenarios[3],role=d.roles[2];
  assert.equal(d.recipe,readFileSync(new URL('../recipes/hx8k-cpu8.txt',import.meta.url),'utf8').replaceAll('\r\n','\n'));
  assert.equal(role.name,'sum');assert.equal(role.gates.length,46);assert.equal(role.image.length,54);
  const window=sc.events.find(e=>e[1]==='window')[0];
  assert.deepEqual([stateAt(sc,window,d.roles).pc,stateAt(sc,window,d.roles).acc],[1,254]);
  assert.equal(stateAt(sc,window+3,d.roles).dead.size,2);
  assert.equal(stateAt(sc,window+32750,d.roles).spare,0);assert.equal(stateAt(sc,window+32751,d.roles).spare,4);
  const after=stateAt(sc,window+33009,d.roles);assert.deepEqual([after.rebuilt,after.pc,after.acc,after.commits],[4,2,0,2]);
  const rebuilt=sc.events.find(e=>e[1]==='rebuilt')[0];
  assert.equal(sc.events.filter(e=>e[1]==='write'&&e[2]===2&&e[0]>rebuilt).length,54);
  const sites=d.fabric.sites.map(unpackSite);assert.equal(sites.filter(s=>s.bel===8).length,32);
  assert.equal(sites.filter(s=>s.bel===8&&d.fabric.groups[s.group]==='primary:2').length,2);
  assert.ok(d.fabric.routes['primary:2'].length>0);
  const blocked=d.scenarios[19],st=stateAt(blocked,blocked.events.at(-1)[0],d.roles);assert.deepEqual([st.refused,st.commits,st.spare],[4,1,0]);
});

test('altered recipes, mixed builds and invented milestone clocks cannot attach as matching evidence',async()=>{
  const b=JSON.parse(asset);b.data.recipe+='\n# edit';await assert.rejects(openBundle(JSON.stringify(b)),/digest/);
  b.sha256=await shaText(JSON.stringify(b.data));await assert.rejects(openBundle(JSON.stringify(b)),/identity/);
  const c=JSON.parse(asset);c.data.scenarios[3].buildId='different';c.sha256=await shaText(JSON.stringify(c.data));await assert.rejects(openBundle(JSON.stringify(c)),/build ID/);
  const t=JSON.parse(asset);t.data.scenarios[3].measurement.spareLoadedAfterInjection--;t.sha256=await shaText(JSON.stringify(t.data));await assert.rejects(openBundle(JSON.stringify(t)),/report disagree/);
});

test('missing or inconsistent placement capacities fail before a run can attach',async()=>{
  const b=JSON.parse(asset),capacity=b.data.build.utilization.ICESTORM_LC;
  for(const available of [undefined,capacity.used-1]){
    capacity.available=available;
    b.sha256=await shaText(JSON.stringify(b.data));
    await assert.rejects(openBundle(JSON.stringify(b)),/resource capacity or count for ICESTORM_LC/);
  }
});

test('the shipped build identity binds both mapped and placed JSON hashes',async()=>{
  for(const key of ['mappedJsonHash','placedHash']){
    const b=JSON.parse(asset);
    assert.match(b.data.build[key],/^[0-9a-f]{64}$/);
    b.data.build[key]=await shaText(`different ${key}`);
    b.sha256=await shaText(JSON.stringify(b.data));
    await assert.rejects(openBundle(JSON.stringify(b)),/design\/build identity/);
  }
});

test('legacy build identities still support live and replay-only imports',async()=>{
  const b=JSON.parse(asset),{build,live,scenarios}=b.data;
  delete build.mappedJsonHash;
  delete build.placedHash;
  build.id=await shaText(identity(build));
  live.buildId=build.id;
  for(const scenario of scenarios)scenario.buildId=build.id;
  b.sha256=await shaText(JSON.stringify(b.data));
  assert.ok((await openBundle(JSON.stringify(b))).live);
  delete b.data.live;
  b.sha256=await shaText(JSON.stringify(b.data));
  assert.equal((await openBundle(JSON.stringify(b))).live,undefined);
});

test('export verification rejects a live pin transition that disagrees with an otherwise valid trace',()=>{
  const {data}=JSON.parse(asset),scenario=data.scenarios[0];
  scenario.events.find(e=>e[1]==='write')[0]++;
  assert.doesNotThrow(()=>checkTrace(scenario,data.roles,commitOracle(data.recipe)));
  assert.throws(()=>verifyLiveTraces({...data,scenarios:[scenario]}),/live pin trace differs/);
});

test('editing the actual D input changes the FPGA rebuild oracle; undo restores the original recipe identity',async()=>{
  const {data}=JSON.parse(asset),h=new RecipeHistory(data.recipe),graph=recipeGraph(h.text);
  const high=graph.nodes.find(g=>g.name==='acc7').refs[0];
  h.put(editGate(h.text,graph,high,'replace',high,'DFF',['rst']));
  assert.notEqual(await shaText(h.text),data.build.recipeHash);
  assert.equal(commitOracle(h.text)[0],0x017e);
  h.undo();assert.equal(await shaText(h.text),data.build.recipeHash);h.redo();assert.equal(commitOracle(h.text)[0],0x017e);
});

test('wiring edits validate all cones and preserve named consumers on rename',()=>{
  let text='inputs a\ngroup demo\n  gate q DFF next\n  gate next XOR a q\noutput y q\n';
  text=editGate(text,recipeGraph(text),'next','replace','d','XOR',['a','q']);
  assert.match(text,/DFF d\b/);
  text=editGate(text,recipeGraph(text),'q','add','free','NOT',['a']);assert.ok(recipeGraph(text).ids.has('free'));
  assert.throws(()=>editGate(text,recipeGraph(text),'free','replace','free','NOT',['free']),/cycle/);
  assert.throws(()=>editGate(text,recipeGraph(text),'d','delete'),/unknown driver/);
  assert.throws(()=>editGate(text,recipeGraph(text),'d','replace','d','OR',['a','missing']),/unknown driver/);
  assert.ok(!recipeGraph(editGate(text,recipeGraph(text),'free','delete')).ids.has('free'));
});
