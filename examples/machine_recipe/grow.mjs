import {DFF, expand} from './logic.mjs';
import {TRACKS, image, machine, survey, trace} from './fabric.mjs';

export function grow(b,bytes,planner=planGrowth) {
  const {at,config,wave,stats}=planner(b,bytes);
  return {at,stats:{...stats,...b.install(config,wave)}};
}

export function planCpuGrowth(board,bytes) {
  // Match each ALU slice to its accumulator bit and keep the decoder and PC
  // below the data path, alongside the opcode and address pads.
  const column=x=>Array.from({length:8},(_,bit)=>[x,9+4.5*bit]);
  const scale=board.side/64;
  const centers=[[14,48],...column(25),...column(37),[40,52]].map(([x,y])=>[x*scale,y*scale]);
  return planGrowth(board,bytes,centers,{avoidCongestion:true});
}

export function planGrowth(b,bytes,centers,{isolateRegisters=false,avoidCongestion=false}={}) {
  const {inputs,outputs,gates,groups}=expand(bytes), {order,distance}=survey(b);
  const c=image(b.n), old=b.config, at=new Int32Array(gates.length).fill(-1);
  const pins=new Map();
  const missing=new Uint8Array(gates.length), mapPin=(name,i,contacts)=>{
    const p=contacts.get(name)?.find(site=>distance[site]>=0 && old.kind[site]===gates[i][0])
      ?? contacts.get(name)?.find(site=>distance[site]>=0);
    if (p===undefined) throw Error(`unreachable boundary pin: ${name}`);
    at[i]=p; c.kind[p]=gates[i][0]; pins.set(name,p);
  };
  if (inputs.length!==b.inputs.size || outputs.length!==b.outputs.size) throw Error('pin count mismatch');
  inputs.forEach((name,i)=>mapPin(name,i,b.inputContacts));
  outputs.forEach((name,i)=>mapPin(name,gates.length-outputs.length+i,b.outputContacts));
  // IDs are configuration readback tags, not a surviving external placement map.
  for (const p of order) {
    const id=old.tag[p]-1;
    if (id>=0 && !b.fixed[p] && !b.pads[p] && at[id]===-1 && gates[id][0]===old.kind[p]) {
      at[id]=p; c.kind[p]=old.kind[p]; c.tag[p]=id+1;
    }
  }
  // Default to serpentine packing unless a design supplies preferred centers.
  // The nearest free reachable site wins, with wave-order ties.
  const cols=Math.ceil(Math.sqrt(groups.length)), rows=Math.ceil(groups.length/cols);
  let gatesPlaced=0;
  groups.forEach((ids,m)=>{
    const row=Math.floor(m/cols), col=row%2 ? cols-1-m%cols : m%cols;
    const [centerX,centerY]=centers?.[m] ?? [(col+.5)*b.side/cols,(row+.5)*b.side/rows];
    const w=Math.ceil(Math.sqrt(ids.length));
    ids.forEach((id,j)=>{
      if (at[id]>=0) return;
      const x=Math.floor(centerX)+j%w-(w>>1);
      const y=Math.floor(centerY)+Math.floor(j/w)-(w>>1);
      let best=-1,min=Infinity;
      for (const p of order) if (!c.kind[p] && !b.fixed[p] && !b.pads[p]) {
        const dist=Math.abs(p%b.side-x)+Math.abs(Math.floor(p/b.side)-y);
        if (dist<min) { min=dist; best=p; if (!min) break; }
      }
      if (best<0) throw Error('out of reachable gate sites');
      at[id]=best; c.tag[best]=id+1; c.kind[best]=gates[id][0];
      missing[id]=1; gatesPlaced++;
    });
  });

  // Keep the exact switches on every intact driver-to-socket path. A net
  // can fan out from any surviving segment, including at a wire crossing.
  const trees=new Map(), pending=[], used=new Uint8Array(b.n);
  const blockedRegister=(site,start,driver)=>isolateRegisters && c.kind[site]===DFF && site!==start && site!==driver;
  let pathsKept=0;
  for (const [id,[, ...refs]] of gates.entries()) for (const [port,src] of refs.entries()) {
    const start=at[id], driver=at[src];
    if (!trees.has(driver)) trees.set(driver,new Map());
    const kept=trace(b,old,start,port);
    if (kept.driver!==driver || (missing[src]&1) || (missing[id]&1)
      || (isolateRegisters && kept.path.some(slot=>blockedRegister(Math.floor(slot/TRACKS),start,driver)))) {
      pending.push({start,driver,port}); missing[id]|=2; continue;
    }
    c.socket[start*3+port]=old.socket[start*3+port];
    for (const j of kept.path) {
      const p=Math.floor(j/TRACKS);
      if (!c.wire[j]) used[p]++;
      c.wire[j]=old.wire[j]; trees.get(driver).set(p,j%TRACKS);
    }
    pathsKept++;
  }
  const seen=new Uint32Array(b.n), back=new Uint8Array(b.n), queue=new Int32Array(b.n);
  const trackLimits=avoidCongestion?[TRACKS/2,3*TRACKS/4,TRACKS]:[TRACKS];
  let stamp=0;
  function add(p,code,tree) {
    let lane=0;
    while (lane<TRACKS && c.wire[p*TRACKS+lane]) lane++;
    if (lane===TRACKS) throw Error('switch box full');
    c.wire[p*TRACKS+lane]=code; used[p]++; tree.set(p,lane); return lane;
  }
  function findBranch(start,driver,tree,limit) {
    stamp++;
    queue[0]=start; seen[start]=stamp;
    for (let i=0,end=1;i<end;i++) {
      const v=queue[i];
      if (tree.has(v)) return v;
      if (used[v]>=limit) continue;
      if (v===driver) return v;
      for (let d=0;d<4;d++) {
        const q=b.neighbors[v*4+d];
        if (q<0 || seen[q]===stamp || distance[q]<0 || blockedRegister(q,start,driver)) continue;
        queue[end++]=q; seen[q]=stamp; back[q]=d^1;
      }
    }
    return -1;
  }
  if (avoidCongestion) {
    const span=({start,driver})=>Math.abs(start%b.side-driver%b.side)
      +Math.abs(Math.floor(start/b.side)-Math.floor(driver/b.side));
    // Reserve the shortest local connections before longer wires can occupy
    // their tracks. Use busier sites only when an emptier route is unavailable.
    pending.sort((a,z)=>span(a)-span(z));
  }
  for (const {start,driver,port} of pending) {
    const tree=trees.get(driver);
    let p=-1;
    for (const limit of trackLimits) {
      p=findBranch(start,driver,tree,limit);
      if (p>=0) break;
    }
    if (p<0) throw Error(`no free track from ${driver} to ${start}:${port}`);
    let lane=tree.get(p) ?? add(p,1,tree);
    while (p!==start) {
      const d=back[p]; p=b.neighbors[p*4+d];
      lane=add(p,2+(d^1)*TRACKS+lane,tree);
    }
    c.socket[start*3+port]=lane+1;
  }
  for (const [id,[, ...refs]] of gates.entries()) refs.forEach((src,k)=>{
    if (trace(b,c,at[id],k).driver!==at[src]) throw Error('route did not reach intended driver');
  });
  const {criticalTicks}=machine(b,c); // Refuse unclockable plans before any writes.
  const stats={reachable:order.length,waveDepth:distance[order.at(-1)],gatesPlaced,
    modules:groups.length,modulesKept:groups.filter(ids=>ids.every(i=>!missing[i])).length,
    pathsKept,pathsRouted:pending.length,trackCells:used.reduce((a,v)=>a+v,0),criticalTicks};
  return {at,pins,config:c,wave:order,distance,stats};
}
