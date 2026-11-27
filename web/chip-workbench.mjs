import { recipeGraph } from '../examples/fpga_fabric/recipe-graph.mjs';
import { openBundle, normalize, roleDesign, stateAt, eventText, faultName, hex, unpackSite, belName, belType, compareBuilds } from './chip-model.mjs?v=2';
import { ChipLiveSession } from './chip-live-session.mjs?v=2';
import { RecipeHistory, numberOfPorts, editGate } from './chip-editor.mjs?v=2';
import { ChipMap } from './chip-map.mjs?v=2';

const $=id=>document.getElementById(id);
const node=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
const opt=(text,value)=>{const n=node('option',text);n.value=value;return n;};
const button=(text,fn)=>{const b=node('button',text);b.type='button';b.addEventListener('click',fn);return b;};
const systems={bank:'Register bank',reader:'Recovery reader',sha:'SHA-256 verifier',staging:'Staging RAM',syndrome:'Syndrome RAM',
  parity:'Parity ROM',crossing:'Inter-bay crossing',pins:'Chip I/O',global:'Clock & globals',shared:'Shared / unattributed'};
const loadEvents=new Set(['rebuilt','refused','digest','spare','spare-lost']);
const map=new ChipMap($('chip-map'),picked);
const device=new ChipLiveSession(()=>render());
let build,history,graph,roles=[],diagnosis='',mode='fpga',scenario=3,clock=0,group='primary:2',role=2,gate='',site;
let timer,scheduled,loadId=0,attachedLoadId=0,visibleEvents=[],placedSites=[],selectedSites=[];
let timelineSource,timelineFilter,timelineEnd=0,liveSelection;
const sc=()=>build?.scenarios[scenario], sameRecipe=()=>Boolean(build&&normalize($('source').value)===build.recipe);
const physical=()=>Boolean(graph)&&!scheduled&&sameRecipe();
const replay=()=>mode==='replay'&&physical();
const mapped=()=>mode==='fpga'&&physical()&&Boolean(build.live);
const preferredMode=()=>build?.live&&new URLSearchParams(location.search).get('mode')!=='replay'?'fpga':'replay';
const physicalState=()=>mapped()?device.state:replay()?stateAt(sc(),clock,roles):null;
function notice(text='',error=false){$('notice').textContent=text;$('notice').dataset.error=String(error);}
function stop(){clearInterval(timer);timer=undefined;$('play').textContent='Play';}
function fact(k,v){const row=node('div');row.append(node('dt',k),node('dd',v));return row;}
function groupName(g){const [kind,num]=g.split(':'),i=Number(num);
  if(kind==='primary'||kind==='tape')return `${roles[i]?.name??num} · ${kind==='primary'?'primary worker':'recipe tape'}`;
  if(kind==='spare'||kind==='bay')return `Bay ${i} · ${kind==='spare'?'shared spare':'control'}`;
  return systems[g]??g;
}
function selectGroup(g,exactSite,preferredRole) {
  group=g;site=exactSite;const [family,num]=group.split(':'),n=Number(num);
  if(family==='primary'||family==='tape')role=n;
  else if(family==='spare'||family==='bay'){
    const mask=physicalState()?.spare??0;
    role=preferredRole??((mask&(1<<(2*n+1)))?2*n+1:(mask&(1<<(2*n)))?2*n:(role>>1)===n?role:2*n);
  } else role=-1;
  const attached=roles[role]?.gates??(group==='bank'?graph.regs.map(i=>graph.names[i]):gateOptions());
  if(!attached.includes(gate))gate=attached[0]??'';
  $('tape-address').value=0;fillGateForm();render();
}
function gateOptions(){if(!graph)return [];
  if($('all-gates').checked)return graph.nodes.filter(n=>n.group).map(n=>n.name);
  if(roles[role])return roles[role].gates;
  if(roles.length&&group==='bank')return graph.regs.map(i=>graph.names[i]);
  return roles.length?[]:graph.nodes.filter(n=>n.group).map(n=>n.name);
}
function picked(p){
  if(p.group)selectGroup(p.group,p.code);
}
function compile(text,record=true,requestedMode=mode){
  clearTimeout(scheduled);scheduled=undefined;
  history??=new RecipeHistory(text);
  if(record)history.put(text);
  if($('source').value!==history.text)$('source').value=history.text;
  graph=undefined;roles=[];diagnosis='';
  try{graph=recipeGraph(history.text);try{roles=roleDesign(history.text);}catch(e){diagnosis=`Valid gate recipe. HX8K packing failed. ${e.message}`;}}
  catch(e){diagnosis=e.message;}
  if(!roles.length){group='design';role=-1;}else if(!roles[role]&&!systems[group]){role=2;group='primary:2';}
  if(!gateOptions().includes(gate))gate=gateOptions()[0]??'';
  site=undefined;fillGateForm();setMode(requestedMode);
}
function setMode(value){stop();mode=value==='fpga'&&build?.live?'fpga':'replay';
  if(mapped()){
    $('follow-events').checked=true;
    device.open(build,Number($('spare-policy').value));
  }else device.close();
  $('layer').value='placed';
  buildNavigator();render();}
function setCase(id){stop();scenario=id;clock=sc().events.find(e=>e[1]==='window')[0];render();}
function setClock(c){if(!replay())return;clock=Math.max(0,Math.min(sc().events.at(-1)[0],c));render();}
function eventRelated([,kind,target]){
  if(role>=0){
    if(kind==='fault')return [role,8+(role>>1),12+role,22+role].includes(target);
    if(kind==='write')return target===role;
    return loadEvents.has(kind)&&Boolean(target&(1<<role));
  }
  if(group==='bank'||group==='pins')return kind==='commit';
  if(group==='crossing')return kind==='fault'&&(target===20||target===21);
  if(group==='reader'||group==='staging')return ['write','rebuilt','refused','digest'].includes(kind);
  if(group==='sha'||group==='syndrome')return ['rebuilt','refused','digest'].includes(kind);
  if(group==='parity')return (kind==='fault'&&target>=30)||(kind==='digest'&&(target&256))||kind==='rebuilt'||kind==='refused';
  return false;
}
function followLatest(){
  liveSelection=undefined;
  const list=$('events');
  list.selectedIndex=-1;
  scrollToLatest(list);
}
function scrollToLatest(list){
  const bottom=list.scrollHeight-list.clientHeight;
  if(list.scrollTop<bottom)list.scrollTop=bottom;
}
function renderTimeline(onChip,verified){
  const source=onChip?device.log:verified?sc().events:null;
  const start=onChip?device.logStart:0;
  const end=start+(source?.length??0);
  const includeWords=$('show-words').checked,selectedOnly=$('selected-events').checked;
  const filter=`${group}/${role}/${includeWords}/${selectedOnly}`;
  const sourceChanged=source!==timelineSource;
  const rebuild=sourceChanged||filter!==timelineFilter;
  if(!rebuild&&end===timelineEnd)return;
  if(sourceChanged)liveSelection=undefined;

  const list=$('events');
  if(rebuild){
    list.replaceChildren();
    visibleEvents=[];
    timelineEnd=start;
  }
  // The worker clock keeps advancing while old events expire from the live log.
  while(list.firstElementChild&&Number(list.firstElementChild.value)<start){
    list.firstElementChild.remove();
    visibleEvents.shift();
  }
  const options=[];
  for(let index=Math.max(timelineEnd,start);index<end;index++){
    const event=source[index-start];
    const [clock,kind,target,address]=event;
    const related=eventRelated(event);
    if(selectedOnly&&!related)continue;
    if(kind==='write'&&!includeWords&&address!==0&&address+1!==roles[target].image.length)continue;
    visibleEvents.push(event);
    options.push(opt(`${related?'▸':' '} ${String(clock).padStart(6)}   ${eventText(event,roles)}`,index));
  }
  list.append(...options);
  timelineSource=source;
  timelineFilter=filter;
  timelineEnd=end;
  list.disabled=!visibleEvents.length;
  if(onChip&&$('follow-events').checked)followLatest();
  else if(onChip){
    const selectedIndex=visibleEvents.indexOf(liveSelection);
    if(list.selectedIndex!==selectedIndex)list.selectedIndex=selectedIndex;
  }
  const instructions=visibleEvents.length
    ? 'Select an event to inspect its component. Clocks are measured from reset release.'
    : source?.length?'No events match the current filters.':'Clock the chip to record events.';
  const limit=start?` The latest ${source.length.toLocaleString()} events are retained.`:'';
  $('timeline-help').textContent=instructions+limit;
}
function selectEvent(e){
  if(!e)return;
  const onChip=mapped();
  if(onChip){
    liveSelection=e;
    $('follow-events').checked=false;
  }else if(replay()){
    stop();
    clock=e[0];
  }else return;
  const [,k,a,b]=e;
  if(k==='fault'){
    if(a<8)selectGroup(`primary:${a}`);else if(a<12)selectGroup(`spare:${a-8}`);else if(a<20)selectGroup(`tape:${a-12}`);
    else if(a<22)selectGroup('crossing');else if(a<30)selectGroup(`tape:${a-22}`);else selectGroup('parity');
  }else if(k==='write'){selectGroup(`tape:${a}`);$('tape-address').value=b;wordInfo();}
  else if(loadEvents.has(k)){const i=Math.log2(a&-a);if(i===8)selectGroup('parity');
    else if(k==='spare'||k==='spare-lost')selectGroup(`spare:${i>>1}`,undefined,i);else selectGroup(`tape:${i}`);}
  else if(k==='commit'&&onChip)selectGroup('bank');
  else render();
}
function goNext(kind){if(!replay())return;const list=kind==='event'?visibleEvents:sc().events.filter(e=>e[1]===kind);
  const e=list.find(e=>e[0]>clock);if(e)setClock(e[0]);else{setClock(sc().events.at(-1)[0]);stop();}}
function buildNavigator(){const bays=$('bays'),extra=$('infrastructure');bays.replaceChildren();extra.replaceChildren();
  if(!roles.length){$('design-hint').textContent=graph?'Select a gate in the inspector to edit it.':'Load a valid recipe to inspect its gates.';return;}
  $('design-hint').textContent=physical()?'Select a role to cross-probe its gates and placed sites.':'Select a packed role to inspect its recipe.';
  const chooser=(id,text)=>{const b=button(text,()=>selectGroup(id));b.dataset.group=id;return b;};
  for(let i=0;i<4;i++){const box=node('div');box.className='bay';box.append(node('strong',physical()?`BAY ${i}`:`ROLES ${2*i}–${2*i+1}`));
    for(let j=2*i;j<2*i+2;j++)box.append(chooser(`primary:${j}`,roles[j].name));
    for(let j=2*i;j<2*i+2;j++)box.append(chooser(`tape:${j}`,`Tape ${j}`));
    if(physical()){const b=chooser(`spare:${i}`,`Shared spare ${i}`);b.classList.add('spare');box.append(b);}bays.append(box);}
  for(const key of physical()?Object.keys(systems):['bank'])extra.append(chooser(key,systems[key]));
  if(mapped())$('live-fault').replaceChildren(...Array.from({length:32},(_,i)=>opt(faultName(i,roles),i)));
}
function navState(s){for(const b of document.querySelectorAll('[data-group]')){const g=b.dataset.group,[kind,num]=g.split(':'),i=Number(num);
  b.setAttribute('aria-pressed',String(g===group));let condition='';
  if(s){if(kind==='primary')condition=s.dead.has(i)?'lost':s.loaded&(1<<i)?'working':'';
    else if(kind==='tape')condition=s.dead.has(12+i)||s.dead.has(22+i)?'lost':'';
    else if(kind==='spare')condition=s.spare&(3<<(2*i))?'working':'';
    else if(g==='parity'&&(s.dead.has(30)||s.dead.has(31)))condition='lost';}
  b.dataset.condition=condition;
}}
function fillGateForm(){
  const list=gateOptions();$('gate').replaceChildren(...list.map(n=>opt(n,n)));$('gate').value=gate;$('gate').disabled=!list.length;
  $('signals').replaceChildren(...(graph?.nodes??[]).filter(n=>n.op!=='OUT').map(n=>opt(n.name,n.name)));
  const g=graph?.nodes.find(n=>n.name===gate&&n.group);$('gate-name').value=g?.name??'';$('op').value=g?.op??'NOT';ports(g?.refs??[]);
  const links=$('signal-links');links.replaceChildren();
  if(g)for(const ref of new Set(g.refs)) {
    const driver=graph.nodes.find(n=>n.name===ref),b=button(`← ${ref}`,()=>chooseGate(ref));b.disabled=!driver?.group;links.append(b);
  }
  $('locate').disabled=!g;$('replace-gate').disabled=$('remove-gate').disabled=!g;$('add-gate').disabled=!graph;
}
function chooseGate(name){
  gate=name;
  if(roles.length&&!roles[role]?.gates.includes(name)){
    const i=roles.findIndex(r=>r.gates.includes(name)),isReg=graph.nodes.find(n=>n.name===name)?.op==='DFF';
    if(i>=0||isReg){selectGroup(isReg?'bank':`primary:${i}`);return;}
    role=-1;group='design';site=undefined;
  }
  fillGateForm();render();
}
function ports(refs){$('ports').replaceChildren(...Array.from({length:numberOfPorts($('op').value)},(_,i)=>{
  const l=node('label',$('op').value==='MUX'?['Select','When 0','When 1'][i]:`Input ${i+1}`),field=node('input');field.setAttribute('list','signals');field.value=refs[i]??'';l.append(field);return l;
}));}
function wordInfo(){const r=roles[role];$('tape-inspect').hidden=!r;if(!r)return;
  const address=$('tape-address');address.max=r.image.length-1;
  const i=Math.max(0,Math.min(r.image.length-1,Math.trunc(Number(address.value))||0)), w=r.image[i];address.value=i;
  $('word').textContent=`${hex(w,8)} · LUT ${hex(w>>>24)} · selectors ${w&255}, ${(w>>>8)&255}, ${(w>>>16)&255}`;
}
function renderInspectorActions(actions){
  const toolbar=$('actions'),buttons=toolbar.children;
  if(buttons.length!==actions.length||actions.some(({label},i)=>buttons[i].textContent!==label)){
    toolbar.replaceChildren(...actions.map(({label})=>{
      const control=node('button',label);
      control.type='button';
      return control;
    }));
  }
  actions.forEach(({run,disabled},i)=>{
    const control=buttons[i];
    control.onclick=run;
    if(control.disabled!==disabled)control.disabled=disabled;
  });
}
function inspect(s){
  const r=roles[role], facts=[], actions=[];let title=role>=0||systems[group]||group.startsWith('bay:')?groupName(group):'Logical design';
  const action=(label,run,disabled=false)=>actions.push({label,run,disabled});
  function inject(id){action(faultName(id,roles),()=>device.fault(id),!device.ready||s.dead.has(id));}
  if(r){facts.push(['Role',r.name],['Sources',r.inputs.join(', ')],['Config',`${r.gates.length} CRC LUTs · ${r.image.length} words`]);
    if(physical()){
      facts.push(['Worker',(s.spare&(1<<role))?`Spare in bay ${role>>1}`:s.dead.has(role)?'Primary lost':(s.loaded&(1<<role))?'Primary loaded':'Awaiting configuration']);
      facts.push(['Recipe',(s.refused&(1<<role))?'Load refused':(s.rebuilt&(1<<role))?'Verified reconstruction':s.dead.has(12+role)?'Master offline':(s.digest&(1<<role))?'Digest mismatch':'Master available']);
      if(replay()){
        action('Replay tape + primary loss',()=>setCase(1+role));
        action('Replay corrupt tape',()=>setCase(9+role));
      }
      else {inject(12+role);inject(role);inject(22+role);if(group.startsWith('spare:'))inject(8+(role>>1));}
    }
  } else if(physical()){
    const descriptions={bank:'Holds the eight PC and eight accumulator flip-flops.',reader:'Controls image verification, reconstruction and publication.',sha:'Checks each staged image against its original SHA-256 digest.',
      staging:'Holds the image whose RAM readback is checked before publication.',syndrome:'Accumulates the weighted parity residual over GF(2¹⁶).',parity:'One 352-byte global16 parity row for the shipped recipe.',
      crossing:'Direct registered link and two-register detour.',pins:'Placed package contacts, including the test instrumentation.',global:'Placed global buffers.',shared:'Packed logic without a retained component prefix.'};
    facts.push(['Function',descriptions[group]??'Bay assignment and local switching.']);
    if(group==='parity'||group==='reader'){if(replay())action('Replay parity failure',()=>setCase(22));else{inject(30);inject(31);}}
    if(group==='crossing'&&mapped()){inject(20);inject(21);}
  }
  if(physical()){
    const count=placedSites.filter(p=>build.fabric.groups[p.group]===group).length;facts.push(['Mapped sites',count||'No distinct named BELs']);
    if(site!==undefined){const p=unpackSite(site);facts.push(['BEL',`X${p.x}/Y${p.y}/${belName(p.bel)}`],['Cell type',belType(p.bel)]);
      if(mapped()){const probe=build.live.probes[build.fabric.sites.indexOf(site)];facts.push(['Live probe',probe&&device.levels?`${['','O','LO','COUT','RDATA[0]','global input','package pin'][probe%8]} = ${device.levels[probe>>>3]}`:'No retained signal']);}}
  }
  const g=graph?.nodes.find(n=>n.name===gate);
  if(g)facts.push(['Gate',`${g.name} = ${g.op} ${g.refs.join(' ')}`],['CRC source',`${g.group||'pin'} · line ${g.line??'—'}`]);
  $('component-name').textContent=title;$('facts').replaceChildren(...facts.map(([k,v])=>fact(k,v)));
  renderInspectorActions(actions);wordInfo();
}
function render(){
  const verified=replay(),onChip=mapped(),hw=verified||onChip,s=physicalState();
  $('mode').querySelector('[value=fpga]').disabled=!build?.live;
  $('mode').value=mode;$('mode').disabled=!hw;
  $('timeline').hidden=!hw;$('fpga-live').hidden=!onChip;
  $('follow-events-label').hidden=!onChip;$('replay-jumps').hidden=!verified;
  $('case-label').hidden=$('scrub-label').hidden=!verified;$('next-event').hidden=!hw;
  $('play').disabled=$('restart').disabled=$('one-clock').disabled=$('next-commit').disabled=$('next-event').disabled=!hw;
  $('layer').disabled=!hw;
  $('evidence').textContent=onChip?'Live mapped FPGA · HX8K':verified?'Verified FPGA replay · HX8K':'No matching HX8K run';
  for(const id of ['source','apply','edit-jump','export-recipe'])$(id).disabled=!history;
  $('undo').disabled=!history||(history.at===0&&!scheduled);
  $('redo').disabled=!history||history.at+1===history.stack.length;
  $('original').disabled=!build||sameRecipe();
  const recipeStatus=graph
    ? `${graph.gates.length} gates and pins · ${roles.length} clusters fit the FPGA profile. ${hw?'Matching run available.':'Export and rebuild to run on the HX8K.'}`
    : 'Import a recipe or run.';
  $('validation').textContent=scheduled?'Draft changed. Validating…':diagnosis||recipeStatus;
  $('validation').dataset.error=String(Boolean(history)&&!graph&&!scheduled);
  $('pc').textContent=hw?hex(s.pc):'—';$('acc').textContent=hw?hex(s.acc):'—';$('edges').textContent=hw?s.commits:'—';
  renderTimeline(onChip,verified);
  if(onChip){
    $('play').textContent=device.running?'Pause':'Play';$('play').disabled=!device.ready;
    $('one-clock').disabled=$('next-commit').disabled=$('next-event').disabled=$('run-clocks').disabled=!device.ready||device.running;
    for(const o of $('live-fault').options)o.disabled=s.dead.has(Number(o.value));
    $('inject').disabled=!device.ready||s.dead.has(Number($('live-fault').value));
    const e=device.log.at(-1);$('transition').textContent=e?eventText(e,roles):'Reset';
    $('clock-readout').textContent=`Clock ${s.clock.toLocaleString()} · live`;
    const status=`${device.note||(device.running?'Clocking mapped cells…':'Paused.')} ${s.dead.size} injected fault${s.dead.size===1?'':'s'}.`;
    if($('fpga-status').textContent!==status)$('fpga-status').textContent=status;
  }else if(verified){
    const e=sc().events.findLast(e=>e[0]<=clock);$('transition').textContent=e?eventText(e,roles):'Reset released';
    $('scrub').max=sc().events.at(-1)[0];$('scrub').value=clock;$('scenario').value=scenario;
    $('clock-readout').textContent=`Clock ${clock.toLocaleString()}${s.window!=null?` · +${(clock-s.window).toLocaleString()} from injection`:''}`;
    $('events').selectedIndex=visibleEvents.findLastIndex(e=>e[0]<=clock);
    for(const [id,k] of [['jump-verified','rebuilt'],['jump-spare','spare']])$(id).disabled=!sc().events.some(e=>e[1]===k);
    $('jump-result').disabled=sc().measurement.matchingCommits===0;
  }else{$('transition').textContent='—';$('clock-readout').textContent='';}
  navState(s);inspect(s);
  const layer=$('layer').value,showPlacement=hw&&layer==='placed';
  $('routes').disabled=$('site-nav').hidden=!showPlacement;$('levels-label').hidden=!onChip||!showPlacement;
  selectedSites=showPlacement?placedSites.filter(p=>build.fabric.groups[p.group]===group):[];
  $('previous-site').disabled=$('next-site').disabled=!selectedSites.length;
  const u=build?.build.utilization;
  $('map-info').textContent=showPlacement?`${u.ICESTORM_LC.used.toLocaleString()} / ${u.ICESTORM_LC.available.toLocaleString()} logic cells · ${u.ICESTORM_RAM.used}/${u.ICESTORM_RAM.available} BRAMs. ${onChip?'Light dots: sampled high bits. ':''}Bright: selected; violet: shared spare; red: lost worker. Drag to pan, Ctrl+wheel to zoom. Routes show retained output-bit segments.`
    :hw?'Signal connections · select a role to inspect its gates.':'Import a matching HX8K run to inspect the fabric.';
  $('build-id').textContent=build?`${hw?'Attached':'Reference'} build ${build.build.id.slice(0,16)} · recipe ${build.build.recipeHash.slice(0,16)} · seed ${build.build.seed}`:'No run loaded';
  map.set({layer,roles,group,role,site,state:s,routes:$('routes').checked,fabric:hw?build.fabric:null,
    levels:onChip&&$('levels').checked?device.levels:null,probes:onChip?build.live.probes:null});
}

async function attach(text,id){
  if(id<attachedLoadId)return;
  const data=await openBundle(text);
  if(id<attachedLoadId)return;
  const keep=$('source').value && (!build||!sameRecipe());
  const diff=build&&compareBuilds(build,data);$('comparison').hidden=!diff;
  if(diff)$('compare-text').textContent=`Since ${diff.from.slice(0,16)}: changed tape images: ${diff.tapes.join(', ')||'none'}. Placed BELs: ${diff.added} newly occupied, ${diff.removed} vacated, ${diff.regrouped} with a different retained component label.`;
  const next=keep?normalize($('source').value):data.recipe;
  const sites=data.fabric.sites.map(code=>({...unpackSite(code),code}));
  const trials=data.scenarios.map(s=>opt(s.measurement.fault,s.id));
  build=data;placedSites=sites;
  $('scenario').replaceChildren(...trials);scenario=3;clock=sc().events.find(e=>e[1]==='window')[0];
  group='primary:2';role=2;compile(next,true,preferredMode());
  attachedLoadId=id;
  if(id===loadId||$('notice').dataset.error!=='true')notice(keep&&!sameRecipe()?'Imported a reference run. Restore its build recipe to simulate it.':'');
}
async function fileText(input,limit){const f=input.files[0];input.value='';if(!f)return null;if(f.size>limit)throw Error('File exceeds the workbench size limit');return f.text();}
$('bundle-file').onchange=async e=>{
  const id=++loadId;
  try{
    const text=await fileText(e.target,4_000_000);
    if(text)await attach(text,id);
  }catch(err){if(id===loadId)notice(err.message,true);}
};
$('recipe-file').onchange=async e=>{try{const text=await fileText(e.target,262144);if(text!=null){compile(text);$('editor').open=true;notice('Imported CRC recipe.');}}catch(err){notice(err.message,true);}};
$('export-recipe').onclick=()=>{const a=node('a'),url=URL.createObjectURL(new Blob([$('source').value],{type:'text/plain'}));a.href=url;a.download='workbench-recipe.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('mode').onchange=e=>setMode(e.target.value);$('scenario').onchange=e=>setCase(Number(e.target.value));
$('one-clock').onclick=()=>mapped()?device.run('clocks',1):setClock(clock+1);
$('next-commit').onclick=()=>mapped()?device.run('commit'):goNext('commit');
$('next-event').onclick=()=>mapped()?device.run('event'):goNext('event');$('restart').onclick=()=>{stop();if(mapped())setMode('fpga');else setClock(0);};
$('spare-policy').onchange=()=>setMode('fpga');$('inject').onclick=()=>device.fault(Number($('live-fault').value));$('live-fault').onchange=render;
$('run-clocks').onclick=()=>{const n=Number($('run-count').value);if(!Number.isInteger(n)||n<1||n>100000){$('run-count').reportValidity();return;}device.run('clocks',n);};
$('play').onclick=()=>{if(mapped()){if(device.running)device.send({type:'pause'});else device.run('play');return;}
  if(!replay())return;
  if(timer){stop();return;}if(clock===sc().events.at(-1)[0])setClock(0);$('play').textContent='Pause';
  timer=setInterval(()=>{goNext('event');if(clock>=sc().events.at(-1)[0])stop();},360);};
$('scrub').oninput=e=>{stop();setClock(+e.target.value);};$('selected-events').onchange=$('show-words').onchange=render;
$('follow-events').onchange=e=>{if(mapped()&&e.target.checked)followLatest();};
$('events').onchange=e=>selectEvent(visibleEvents[e.target.selectedIndex]);
// A native list can scroll to the previous selection after clearing it.
$('events').onscroll=e=>{if(mapped()&&$('follow-events').checked)scrollToLatest(e.target);};
for(const [id,k] of [['jump-window','window'],['jump-verified','rebuilt'],['jump-spare','spare'],['jump-result','commit']])$(id).onclick=()=>{
  if(!replay())return;
  const at=sc().events.find(e=>e[1]==='window')[0];selectEvent(sc().events.find(e=>e[1]===k&&(k!=='commit'||e[0]>at)));};
$('layer').onchange=$('routes').onchange=$('levels').onchange=render;$('fit').onclick=()=>map.fit();$('minus').onclick=()=>map.scale(.72);$('plus').onclick=()=>map.scale(1.4);
for(const [id,dir] of [['previous-site',-1],['next-site',1]])$(id).onclick=()=>{const n=selectedSites.length;if(!n)return;const i=selectedSites.findIndex(p=>p.code===site),p=selectedSites[(i<0?(dir>0?0:n-1):(i+n+dir)%n)];site=p.code;render();map.focus(p);};
$('gate').onchange=e=>chooseGate(e.target.value);$('all-gates').onchange=()=>{if(!gateOptions().includes(gate))gate=gateOptions()[0]??'';fillGateForm();render();};$('tape-address').onchange=wordInfo;
$('locate').onclick=()=>{const g=graph?.nodes.find(n=>n.name===gate);if(!g?.line)return;$('editor').open=true;const ta=$('source');ta.focus();
  const lines=ta.value.split('\n'),offset=lines.slice(0,g.line-1).reduce((n,l)=>n+l.length+1,0);ta.setSelectionRange(offset,offset+lines[g.line-1].length);ta.scrollTop=(g.line-4)*19;};
$('edit-jump').onclick=()=>{$('editor').open=true;$('source').focus();};$('op').onchange=()=>ports([...$('ports').querySelectorAll('input')].map(n=>n.value));
for(const [id,act] of [['add-gate','add'],['replace-gate','replace'],['remove-gate','delete']])$(id).onclick=()=>{try{
  const name=$('gate-name').value.trim(),next=editGate(history.text,graph,gate,act,name,$('op').value,[...$('ports').querySelectorAll('input')].map(n=>n.value.trim()));
  gate=act==='delete'?'':name;compile(next);notice('Recipe updated.');
}catch(e){notice(e.message,true);}};
$('source').oninput=()=>{stop();device.close();clearTimeout(scheduled);graph=undefined;roles=[];group='design';role=-1;gate='';
  scheduled=setTimeout(()=>compile($('source').value),220);fillGateForm();buildNavigator();render();};
$('apply').onclick=()=>{if(scheduled||!graph)compile($('source').value);};
$('undo').onclick=()=>{if(scheduled)history.put($('source').value);compile(history.undo(),false);};$('redo').onclick=()=>compile(history.redo(),false);
$('original').onclick=()=>{if(build){compile(build.recipe,true,preferredMode());notice('Restored the build recipe.');}};
fillGateForm();setMode(mode);
const boot=++loadId;
try{const res=await fetch(new URL('./chip-example.json?v=2',import.meta.url));if(!res.ok)throw Error(`HTTP ${res.status}`);await attach(await res.text(),boot);}
catch(e){if(boot===loadId)notice(`Could not open the example. ${e.message}. Import a mapped run to continue.`,true);}
