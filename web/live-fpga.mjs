// Single-clock, two-state iCE40 primitive simulator. The input is a compact
// mapped circuit, never a recipe, ISA model, test oracle or replay trace.
const portWidths={clk:1,rst:1,policy:2,hit:1,fault_addr:5,pc:8,acc:8,retire:1,spare_loaded:8,rebuilt:8,refused:8,hash_bad:9,cfg_role:3,cfg_stream:41};
const inputs=['clk','rst','policy','hit','fault_addr'];
const int=(n,a,b)=>Number.isInteger(n)&&n>=a&&n<=b;
function check(ok,what){if(!ok)throw Error(`Invalid live FPGA image: ${what}`);}

export function validateLiveImage(im,build,siteCount) {
  check(im?.format==='regrow-hx8k-live/1'&&im.buildId===build.id&&im.mappedHash===build.mappedHash,'build identity');
  check(int(im.wires,3,65535),'wire count');
  const bound=im.wires-1,driven=new Uint8Array(im.wires); driven[0]=driven[1]=1;
  const pins=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(b=>int(b,0,bound));
  const output=b=>{check(int(b,2,bound)&&!driven[b],'multiple/invalid driver');driven[b]=1;};
  check(im.ports&&Object.keys(im.ports).length===Object.keys(portWidths).length,'port count');
  for(const [key,n] of Object.entries(portWidths))check(pins(im.ports[key],n),`port ${key}`);
  for(const key of inputs)im.ports[key].forEach(output);
  check(Array.isArray(im.ffs)&&im.ffs.length<=5*7680&&im.ffs.length%5===0,'flip-flops');
  for(let i=0;i<im.ffs.length;i+=5){output(im.ffs[i]);check(pins(im.ffs.slice(i+1,i+4),3)&&int(im.ffs[i+4],0,1),'flip-flop pins');}
  check(Array.isArray(im.rams)&&im.rams.length<=32,'RAM count');
  for(const r of im.rams){check(int(r.rm,0,3)&&int(r.wm,0,3)&&typeof r.init==='string'&&/^(?:[0-9a-f]{1024})?$/.test(r.init),'RAM mode/contents');
    check(pins(r.ra,11)&&pins(r.wa,11)&&pins(r.rd,16)&&pins(r.wd,16)&&pins(r.mask,16)&&pins([r.re,r.rce,r.we,r.wce],4),'RAM pins');r.rd.forEach(output);}
  check(Array.isArray(im.ops)&&im.ops.length<=6*16000&&im.ops.length%6===0,'LUT schedule');
  for(let i=0;i<im.ops.length;i+=6){check(im.ops.slice(i+1,i+5).every(b=>int(b,0,bound)&&driven[b]===1)&&int(im.ops[i+5],0,65535),'non-topological LUT'); output(im.ops[i]);}
  for(let i=0;i<im.ffs.length;i+=5)for(const b of im.ffs.slice(i+1,i+4))check(driven[b],'undriven flip-flop input');
  for(const r of im.rams)for(const b of [...r.ra,...r.wa,...r.wd,...r.mask,r.re,r.rce,r.we,r.wce])check(driven[b],'undriven RAM input');
  for(const a of Object.values(im.ports))check(a.every(b=>driven[b]),'undriven port');
  check(Array.isArray(im.probes)&&im.probes.length===siteCount&&im.probes.every(p=>p===0||int(p,1,8*im.wires-1)&&(p%8)>=1&&(p%8)<=6&&driven[p>>>3]),'placed probes');
}

function read(v,p,n=p.length){let x=0;for(let i=n-1;i>=0;i--)x=(x<<1)|v[p[i]];return x>>>0;}
function drive(v,p,x){for(let i=0;i<p.length;i++)v[p[i]]=(x>>>i)&1;}

// In narrow RAM modes the high address selects one bit of each interleaved
// group. Port positions follow SB_RAM40_4K in Yosys ice40/cells_sim.v.
function ramEdge(r,v){
  if(v[r.re]&&v[r.rce]){
    const addr=read(v,r.ra), word=r.mem[addr&255];
    if(r.rm===0)r.next=word;
    else {const stride=1<<r.rm,sel=(addr>>>8)&(stride-1),pin=(stride>>1)-1;let q=0;
      for(let base=0;base<16;base+=stride)q|=((word>>>(base+sel))&1)<<(base+pin);r.next=q;}
  }
  if(v[r.we]&&v[r.wce]){
    const addr=read(v,r.wa),index=addr&255;let word=r.mem[index];
    if(r.wm===0){const mask=read(v,r.mask);word=(word&mask)|(read(v,r.wd)&~mask);}
    else {const stride=1<<r.wm,sel=(addr>>>8)&(stride-1),pin=(stride>>1)-1;
      for(let base=0;base<16;base+=stride){const b=base+sel;word=(word&~(1<<b))|(v[r.wd[base+pin]]<<b);}}
    r.mem[index]=word;
  }
}

export class LiveFpga {
  constructor(image,policy=0) {
    this.ops=Uint16Array.from(image.ops);this.ffs=Uint16Array.from(image.ffs);this.next=new Uint8Array(this.ffs.length/5);
    this.v=new Uint8Array(image.wires);this.p=image.ports;
    this.rams=image.rams.map(r=>({...r,mem:new Uint16Array(256),initial:Uint16Array.from(r.init.match(/.{4}/g)??[],w=>parseInt(w,16))}));
    this.reset(policy);
  }
  settle(){const v=this.v,op=this.ops;
    for(let i=0;i<op.length;i+=6){const idx=v[op[i+1]]|(v[op[i+2]]<<1)|(v[op[i+3]]<<2)|(v[op[i+4]]<<3);v[op[i]]=(op[i+5]>>>idx)&1;}
  }
  edge(){
    const {v,ffs:f,next:q,rams}=this;
    // Sample every device from the same pre-edge state. A simultaneous RAM
    // read sees the old word. Apply all Q/RDATA outputs before settling.
    for(let i=0,j=0;i<f.length;i+=5,j++)q[j]=v[f[i+2]]?(v[f[i+3]]?f[i+4]:v[f[i+1]]):v[f[i]];
    for(const r of rams)ramEdge(r,v);
    for(let i=0,j=0;i<f.length;i+=5,j++)v[f[i]]=q[j];
    for(const r of rams)if(r.next!==r.old){drive(v,r.rd,r.next);r.old=r.next;}
    this.settle();
  }
  reset(policy=0){
    if(!int(policy,0,2))throw Error('Unknown FPGA spare policy');
    this.policy=policy;const {v,p}=this;v.fill(0);v[1]=1;
    for(const r of this.rams){r.mem.fill(0);r.mem.set(r.initial);r.next=r.old=0;}
    drive(v,p.policy,policy);v[p.rst[0]]=1;this.settle();this.edge();this.edge();v[p.rst[0]]=0;this.settle();
    this.clock=this.commits=this.loaded=this.rebuilt=this.refused=this.digest=this.spare=0;
    this.dead=new Set();this.events=[];this.write=null;
  }
  tick(fault=-1){
    const {p,v}=this, hit=fault!==-1;
    if(hit){if(!int(fault,0,31))throw Error('Invalid fault domain');drive(v,p.fault_addr,fault);v[p.hit[0]]=1;this.settle();}
    const c=++this.clock, bus=p.cfg_stream;
    if(v[bus[40]]){
      const role=read(v,p.cfg_role),addr=read(v,bus.slice(32,39)),data=read(v,bus,32);
      this.write={clock:c,role,addr,data};this.events.push([c,'write',role,addr,data]);if(v[bus[39]])this.loaded|=1<<role;
    }
    this.edge();
    if(hit){this.dead.add(fault);this.events.push([c,'fault',fault]);v[p.hit[0]]=0;this.settle();}
    const rebuilt=read(v,p.rebuilt),refused=read(v,p.refused),digest=read(v,p.hash_bad),spare=read(v,p.spare_loaded);
    if(rebuilt!==this.rebuilt)this.events.push([c,'rebuilt',rebuilt^this.rebuilt]);
    if(refused!==this.refused)this.events.push([c,'refused',refused^this.refused]);
    if(digest!==this.digest)this.events.push([c,'digest',digest^this.digest]);
    if(spare&~this.spare)this.events.push([c,'spare',spare&~this.spare]);
    if(this.spare&~spare)this.events.push([c,'spare-lost',this.spare&~spare]);
    this.rebuilt=rebuilt;this.refused=refused;this.digest=digest;this.spare=spare;
    if(v[p.retire[0]]){this.commits++;this.events.push([c,'commit',read(v,p.pc),read(v,p.acc)]);}
  }
  takeEvents(){const result=this.events;this.events=[];return result;}
  snapshot(){return {clock:this.clock,commits:this.commits,policy:this.policy,pc:read(this.v,this.p.pc),acc:read(this.v,this.p.acc),
    dead:[...this.dead],loaded:this.loaded,rebuilt:this.rebuilt,refused:this.refused,digest:this.digest,spare:this.spare,write:this.write};}
}
