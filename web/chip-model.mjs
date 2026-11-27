import { recipeGraph, commitOracle } from '../examples/fpga_fabric/recipe-graph.mjs';
import { packProfile } from '../examples/fpga_fabric/packing.mjs';
import { validateLiveImage } from './live-fpga.mjs';

export const FORMAT='regrow-chip/1';
export const normalize=text=>text.replaceAll('\r\n','\n');
export function identity(build) {
  const parts=[build.recipeHash,build.mappedHash,build.routedHash,build.device,build.seed];
  if(build.mappedJsonHash!==undefined||build.placedHash!==undefined)parts.push(build.mappedJsonHash,build.placedHash);
  return JSON.stringify(parts);
}
export const hex=(value,width=2)=>value.toString(16).toUpperCase().padStart(width,'0');
export const unpackSite=n=>({x:n&63,y:(n>>>6)&63,bel:(n>>>12)&15,group:n>>>16});
export const belName=b=>b<8?`lc${b}`:b===8?'ram':b===11?'gb':`io${b-9}`;
export const belType=b=>b<8?'ICESTORM_LC':b===8?'ICESTORM_RAM':b===11?'SB_GB':'SB_IO';
function requireThat(ok,msg) { if (!ok) throw Error(`Invalid workbench bundle: ${msg}`); }
const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);

export function roleDesign(recipe) {
  const graph=recipeGraph(recipe), p=packProfile(recipe);
  return p.logic.map(({lane,inputLanes,gateIds},i)=>({ name:p.laneNames[lane], inputs:inputLanes.map(l=>p.laneNames[l]),
    gates:gateIds.map(id=>graph.names[id]), image:p.pairs[i>>1].images[i%2] }));
}

export function checkTrace(sc, roles, oracle) {
  const ev=sc.events, r=sc.measurement;
  requireThat(Array.isArray(ev)&&ev.length>0&&ev.length<=4096&&typeof r?.fault==='string','trace size/label');
  let last=0, window=-1, writes=0, addr=0, writer=-1, rebuilt=0, refused=0, digest=0, spare=0;
  const commits=[], loads=[];
  for (const [i,e] of ev.entries()) {
    const [c,k,a,b]=e;
    requireThat(integer(c,last,200000)&&Array.isArray(e)&&e.length<=4,'event clock or shape'); last=c;
    if (k==='write') {
      requireThat(integer(a,0,7)&&b===addr&&addr<roles[a].image.length&&(!addr||a===writer),'write order');
      writer=a; writes++; addr=(addr+1)%roles[a].image.length;
    } else if (k==='commit') {
      requireThat(integer(a,0,255)&&integer(b,0,255)&&((a<<8)|b)===oracle[commits.length],'architectural commit'); commits.push(c);
    } else if (k==='window') { requireThat(window<0,'duplicate injection window'); window=c; }
    else if (k==='fault') requireThat(integer(a,0,31),'fault domain');
    else if (['rebuilt','refused','digest','spare'].includes(k)) {
      requireThat(integer(a,1,k==='digest'?511:255),'status mask');
      if (k==='rebuilt') rebuilt|=a; if (k==='refused') refused|=a; if (k==='digest') digest|=a; if (k==='spare') {spare|=a;loads.push(c);}
    } else requireThat(k==='end'&&i===ev.length-1,'unknown or misplaced event');
  }
  requireThat(ev.at(-1)[1]==='end'&&window===r.firstCommit+170&&commits[0]===r.firstCommit&&commits.length===r.matchingCommits+1
    && (commits.length>1?commits[1]-window:null)===r.nextCommitAfterInjection && writes===r.checkedWordsPublished && addr===0
    && (loads.length?loads[0]-window:null)===r.spareLoadedAfterInjection
    && rebuilt===r.rebuiltMask&&refused===r.refusedMask&&digest===r.badDigestMask&&spare===r.loadedSpareMask,'trace and checked report disagree');
}

export async function shaText(text) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function openBundle(text) {
  requireThat(typeof text==='string'&&text.length<=4_000_000,'file size');
  const {format,sha256,data}=JSON.parse(text);
  requireThat(format===FORMAT&&data&&await shaText(JSON.stringify(data))===sha256,'version or content digest');
  const {build,recipe,roles,fabric,scenarios}=data;
  const hasArtifactHashes=build?.mappedJsonHash!==undefined||build?.placedHash!==undefined;
  requireThat(!hasArtifactHashes||(digest(build.mappedJsonHash)&&digest(build.placedHash)),'mapped and placed artifact hashes');
  requireThat(build?.device==='HX8K-CT256'&&digest(build.mappedHash)&&digest(build.routedHash)&&typeof recipe==='string'
    && await shaText(normalize(recipe))===build.recipeHash&&await shaText(identity(build))===build.id,'design/build identity');
  requireThat(JSON.stringify(roleDesign(recipe))===JSON.stringify(roles),'roles do not match the CRC recipe');
  requireThat(Array.isArray(fabric.groups)&&fabric.groups.length<=64&&fabric.groups.every(g=>typeof g==='string'&&g.length<=40)
    && Array.isArray(fabric.sites)&&fabric.sites.length<=9000&&integer(fabric.width,1,64)&&integer(fabric.height,1,64),'placement dimensions');
  const counts={}, seen=new Set();
  for (const code of fabric.sites) {
    const {x,y,bel,group}=unpackSite(code), key=code&65535;
    requireThat(integer(code,0,0x3fffff)&&x<fabric.width&&y<fabric.height&&bel<=11&&group<fabric.groups.length&&!seen.has(key),'placed BEL');
    seen.add(key); const type=belType(bel); counts[type]=(counts[type]??0)+1;
  }
  for (const type of ['ICESTORM_LC','ICESTORM_RAM','SB_GB','SB_IO']) {
    const capacity=build.utilization?.[type];
    requireThat(integer(capacity?.available,1,Number.MAX_SAFE_INTEGER)&&integer(capacity.used,0,capacity.available)
      &&(counts[type]??0)===capacity.used,`resource capacity or count for ${type}`);
  }
  requireThat(fabric.routes && Object.entries(fabric.routes).every(([g,segments])=>fabric.groups.includes(g)&&Array.isArray(segments)&&segments.length<10000&&segments.every(n=>integer(n,0,0xffffff))),'route segments');
  const oracle=commitOracle(recipe);
  requireThat(Array.isArray(scenarios)&&scenarios.length===26,'protected fault panel');
  scenarios.forEach((s,i)=>{requireThat(s.id===i&&s.buildId===build.id,'trace build ID'); checkTrace(s,roles,oracle);});
  if(data.live!==undefined)validateLiveImage(data.live,build,fabric.sites.length);
  return data;
}

export function stateAt(sc,clock,roles) {
  const s={pc:0,acc:0,commits:0,dead:new Set(),loaded:0,rebuilt:0,refused:0,digest:0,spare:0,window:null,write:null};
  for (const [c,k,a,b] of sc.events) {
    if (c>clock) break;
    if(k==='fault') s.dead.add(a);
    else if(k==='window') s.window=c;
    else if(k==='commit') {s.pc=a; s.acc=b; s.commits++;}
    else if(k==='write') {s.write={clock:c,role:a,addr:b}; if(b+1===roles[a].image.length) s.loaded|=1<<a;}
    else if(['rebuilt','refused','digest','spare'].includes(k)) s[k]|=a;
  }
  return s;
}

export function faultName(id,roles) {
  if(id<8) return `Disable ${roles[id].name} primary`;
  if(id<12) return `Disable bay ${id-8} spare`;
  if(id<20) return `Lose ${roles[id-12].name} tape`;
  if(id<22) return id===20?'Cut direct link':'Cut detour';
  if(id<30) return `Flip bit in ${roles[id-22].name} tape`;
  return id===30?'Lose parity row':'Flip bit in parity';
}
export function eventText([,k,a,b,data],roles) {
  if(k==='write') return `${roles[a]?.name??a} · word ${b+1}/${roles[a]?.image.length??'?'} = ${hex(data??roles[a].image[b],8)}`;
  if(k==='commit') return `Instruction committed · PC ${hex(a)}, ACC ${hex(b)}`;
  if(k==='fault') return faultName(a,roles);
  if(k==='window') return 'Fault injection window opens';
  if(k==='end') return 'Observation ends';
  const names=[...roles.map(r=>r.name),'parity'].filter((_,i)=>a&(1<<i)).join(', ');
  return `${({rebuilt:'Reconstruction verified',refused:'Load refused',digest:'Digest mismatch',spare:'Spare loaded','spare-lost':'Spare offline'})[k]} · ${names}`;
}

export function compareBuilds(before,after) {
  if(before.build.id===after.build.id)return null;
  const tapes=new Map(before.roles.map(r=>[r.name,r.image])), changed=[];
  for(const {name,image} of after.roles){const old=tapes.get(name);
    if(!old||image.length!==old.length||image.some((w,i)=>w!==old[i]))changed.push(name);tapes.delete(name);}
  const slots=data=>new Map(data.fabric.sites.map(n=>[n&65535,data.fabric.groups[n>>>16]]));
  const old=slots(before),newSites=slots(after);let added=0,removed=0,regrouped=0;
  for(const [bel,group] of newSites){if(!old.has(bel))added++;else if(old.get(bel)!==group)regrouped++;}
  for(const bel of old.keys())if(!newSites.has(bel))removed++;
  return {from:before.build.id,tapes:[...changed,...tapes.keys()],added,removed,regrouped};
}
