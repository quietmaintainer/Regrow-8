import {arity, IN, OUT, NOT, AND, OR, XOR, MUX, DFF} from './logic.mjs';

export const TRACKS=12, PERIOD=1024, SETTLE_WINDOW=PERIOD/2;
export function image(n) {
  return {kind:new Uint8Array(n), tag:new Uint16Array(n), socket:new Uint8Array(3*n), wire:new Uint8Array(TRACKS*n)};
}

export class Fabric {
  constructor(side, inputs, outputs, {padWidth=1}={}) {
    const maxPins=Math.max(inputs.length,outputs.length);
    if (!Number.isInteger(side) || side<maxPins+2 || side>128) throw Error('invalid fabric size');
    if (!Number.isInteger(padWidth) || padWidth<1 || padWidth>4 || (padWidth>1 && side-1<(maxPins+1)*padWidth)) {
      throw Error('invalid boundary pad width');
    }
    this.side=side; this.n=side*side; this.seed=side>>1; this.clockPad=this.n-side+this.seed;
    this.config=image(this.n); this.dead=new Uint8Array(this.n); this.fixed=new Uint8Array(this.n);
    this.pads=new Uint8Array(this.n); this.padWidth=padWidth;
    this.inputContacts=new Map(); this.outputContacts=new Map();
    this.q=new Int32Array(this.n); this.epoch=0;
    this.fixed[this.seed]=this.fixed[this.clockPad]=1;
    const edge=(names,x,op,contacts)=>{
      const anchors=names.map((name,i)=>[name,Math.floor((i+1)*(side-1)/(names.length+1))]);
      const used=new Set(anchors.map(([,row])=>row));
      for (const [name,row] of anchors) contacts.set(name,[row*side+x]);
      // Spread each pin's contacts across the edge. Backups stay faultable, so
      // the same damage mask applies with and without redundancy.
      for (let copy=1;copy<padWidth;copy++) for (const [name,row] of anchors) {
        const target=(row+Math.floor(copy*side/padWidth))%side;
        let best=-1, nearest=side;
        for (let candidate=0;candidate<side;candidate++) if (!used.has(candidate)) {
          const delta=Math.abs(candidate-target), distance=Math.min(delta,side-delta);
          if (distance<nearest) { nearest=distance; best=candidate; }
        }
        used.add(best); contacts.get(name).push(best*side+x);
      }
      return new Map(anchors.map(([name,row])=>{
        const p=row*side+x;
        for (const site of contacts.get(name)) this.pads[site]=op;
        this.fixed[p]=1; this.config.kind[p]=op; return [name,p];
      }));
    };
    this.inputs=edge(inputs,0,IN,this.inputContacts); this.outputs=edge(outputs,side-1,OUT,this.outputContacts);
    this.neighbors=new Int32Array(this.n*4);
    for (let p=0;p<this.n;p++) this.neighbors.set([
      p%side ? p-1 : -1, p%side<side-1 ? p+1 : -1, p>=side ? p-side : -1, p<this.n-side ? p+side : -1,
    ],p*4);
  }
  // Non-destructive built-in test: a diagnostic bit written high reads low on a stuck site.
  probe(p) { return !this.dead[p]; }
  damage(sites, permanent) {
    const c=this.config;
    for (const p of sites) {
      if (!Number.isInteger(p)||p<0||p>=this.n||this.fixed[p]) throw Error('invalid damage site or fixed pad');
      if (permanent) this.dead[p]=1;
      c.kind[p]=c.tag[p]=this.q[p]=0;
      c.socket.fill(0,3*p,3*p+3); c.wire.fill(0,p*TRACKS,(p+1)*TRACKS);
    }
    this.epoch++;
  }
  // A configuration wave may reach only the surveyed sites. Never rewrite a
  // matching field; in particular retaining a DFF does not reset its Q.
  install(plan, wave) {
    let writes=0, sites=0;
    for (const p of wave) {
      if (!this.probe(p)) throw Error('stuck site in configuration wave');
      const before=writes, old=this.config;
      if (old.kind[p]!==plan.kind[p] || old.tag[p]!==plan.tag[p]) this.q[p]=0;
      for (const [key,width] of [['kind',1],['tag',1],['socket',3],['wire',TRACKS]]) {
        for (let i=p*width;i<(p+1)*width;i++) if (old[key][i]!==plan[key][i]) { old[key][i]=plan[key][i]; writes++; }
      }
      if (before!==writes) sites++;
    }
    if (writes) this.epoch++;
    return {fieldWrites:writes,sitesWritten:sites};
  }
  raw() {
    const {kind,tag,socket,wire}=this.config;
    const ids=Buffer.alloc(tag.length*2);
    tag.forEach((v,i)=>ids.writeUInt16LE(v,2*i));
    return Buffer.concat([kind,ids,socket,wire]);
  }
}

// The programming dock probes and reaches healthy sites by cardinal hops.
export function survey(board) {
  const {seed,neighbors,n}=board;
  const order=[seed], distance=new Int16Array(n).fill(-1);
  if (!board.probe(seed)) throw Error('seed unavailable');
  distance[seed]=0;
  for (let i=0;i<order.length;i++) {
    const site=order[i];
    for (let direction=0;direction<4;direction++) {
      const neighbor=neighbors[4*site+direction];
      if (neighbor<0 || distance[neighbor]>=0 || !board.probe(neighbor)) continue;
      distance[neighbor]=distance[site]+1;
      order.push(neighbor);
    }
  }
  return {order,distance};
}

// 0 = open, 1 = local driver; otherwise the switch selects exactly one
// track on a cardinal neighbor. No global signal ID is available to a wire.
function sourceTrack(board,site,code) {
  const selector=code-2;
  const neighbor=board.neighbors[4*site+Math.floor(selector/TRACKS)];
  return neighbor*TRACKS+selector%TRACKS;
}

export function trace(board,config,p,port) {
  const lane=config.socket[p*3+port]-1;
  let slot=lane>=0 && lane<TRACKS ? p*TRACKS+lane : -1;
  const path=[];
  while (config.wire[slot]) {
    const site=Math.floor(slot/TRACKS), code=config.wire[slot];
    path.push(slot);
    if (path.length>config.wire.length) throw Error('wire loop');
    if (code===1) return {driver:config.kind[site] ? site : -1, path};
    slot=sourceTrack(board,site,code);
  }
  return {driver:-1,path};
}

function wireDrivers(board,config) {
  const {kind,wire}=config, drivers=new Int32Array(wire.length).fill(-1), path=[];
  for (let start=0;start<wire.length;start++) {
    if (!wire[start] || drivers[start]>=0) continue;
    let slot=start;
    // Index zero is the constant low value. Mark the path with it while
    // walking so an open end or a driverless cycle stays low.
    while (wire[slot] && drivers[slot]===-1) {
      const site=Math.floor(slot/TRACKS), code=wire[slot];
      path.push(slot);
      drivers[slot]=0;
      if (code===1) {
        if (kind[site]) drivers[slot]=site+1;
        break;
      }
      slot=sourceTrack(board,site,code);
    }
    const driver=wire[slot] ? drivers[slot] : 0;
    for (const visited of path) drivers[visited]=driver;
    path.length=0;
  }
  return drivers;
}

// Elaborate ONLY the physical switch settings and gate types. Tags, recipes,
// placement and the arithmetic oracle are not inputs. A word simulates 32
// independent copies of the same board, with the same clock edge in all lanes.
export function machine(board, config=board.config) {
  const {kind}=config, {n}=board, epoch=board.epoch;
  const value=new Int32Array(n+1), depth=new Uint32Array(n+1), mark=new Uint8Array(n);
  const order=[], regs=[], captures=[]; let criticalTicks=0;
  function visit(p) {
    if (p<0 || mark[p]===2) return;
    const op=kind[p];
    if (op===IN || op===DFF) { value[p+1]=op===DFF ? board.q[p] : 0; mark[p]=2; return; }
    if (mark[p]===1) throw Error('combinational feedback');
    mark[p]=1;
    const src=[0,0,0]; let delay=0;
    for (let k=0;k<arity[op];k++) {
      const {driver,path}=trace(board,config,p,k); visit(driver); src[k]=driver+1;
      delay=Math.max(delay,depth[driver+1]+path.length);
    }
    depth[p+1]=delay+1; order.push(op,p+1,...src); mark[p]=2;
    if (op===OUT) criticalTicks=Math.max(criticalTicks,depth[p+1]);
  }
  for (let p=0;p<n;p++) if (kind[p]) visit(p);
  for (let p=0;p<n;p++) if (kind[p]===DFF) {
    const {driver,path}=trace(board,config,p,0);
    regs.push(p); captures.push(driver+1); criticalTicks=Math.max(criticalTicks,depth[driver+1]+path.length+1);
  }
  // First half: new Q reaches address pads. Second half: externally supplied
  // ROM word reaches D and store pads. Both deadlines are layout independent.
  if (criticalTicks>=SETTLE_WINDOW) throw Error(`timing failure: ${criticalTicks} ticks, window ${SETTLE_WINDOW}`);
  const schedule=Uint16Array.from(order), next=new Int32Array(regs.length);
  let outputSites=board.outputs;
  if (board.padWidth>1) {
    const {distance}=survey(board);
    outputSites=new Map([...board.outputContacts].map(([name,sites])=>[name,
      sites.find(site=>distance[site]>=0 && kind[site]===OUT && trace(board,config,site,0).driver>=0) ?? -1]));
  }
  const pin=(map,name)=>{if (!map.has(name)) throw Error(`unknown pin ${name}`);return map.get(name)+1;};
  let settled=false, drivers;
  return {criticalTicks,
    drive(name,word) {
      const contacts=board.inputContacts.get(name);
      if (!contacts) throw Error(`unknown pin ${name}`);
      for (const site of contacts) if (kind[site]===IN) value[site+1]=word;
      settled=false;
    },
    read(name) { if (!settled || epoch!==board.epoch) throw Error('unsettled or changed fabric'); return value[pin(outputSites,name)]; },
    readGate(site) {
      if (!settled || epoch!==board.epoch) throw Error('unsettled or changed fabric');
      if (!kind[site]) throw Error(`no gate at ${site}`);
      return value[site+1];
    },
    // The live viewer reads bit 0 of the settled machine on each physical track.
    wireLevels() {
      if (!settled || epoch!==board.epoch) throw Error('unsettled or changed fabric');
      drivers ??= wireDrivers(board,config);
      const levels=new Uint8Array(drivers.length);
      for (let i=0;i<drivers.length;i++) if (drivers[i]>0) levels[i]=value[drivers[i]]&1;
      return levels;
    },
    settle() {
      if (epoch!==board.epoch) throw Error('fabric changed; elaborate its current switches');
      for (let i=0;i<schedule.length;i+=5) {
        const op=schedule[i], dst=schedule[i+1], a=value[schedule[i+2]], b=value[schedule[i+3]];
        switch(op) {
          case OUT: value[dst]=a; break;
          case NOT: value[dst]=~a; break;
          case AND: value[dst]=a&b; break;
          case OR: value[dst]=a|b; break;
          case XOR: value[dst]=a^b; break;
          case MUX: value[dst]=(~a&b)|(a&value[schedule[i+4]]); break;
          default: throw Error('unknown physical primitive');
        }
      }
      settled=true;
    },
    rise() {
      if (!settled || epoch!==board.epoch) throw Error('edge before settling or after damage');
      for (let i=0;i<regs.length;i++) next[i]=value[captures[i]];
      for (let i=0;i<regs.length;i++) board.q[regs[i]]=value[regs[i]+1]=next[i];
      settled=false;
    },
  };
}
