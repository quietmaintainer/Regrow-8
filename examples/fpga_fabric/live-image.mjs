// Export data, not executable code: the actual Yosys cell connections, LUT
// tables and BRAM contents. Nothing here knows the CPU ISA or a fault trial.
import { belName,unpackSite } from '../../web/chip-model.mjs';

function net(b){
  if(b==='0'||b==='1')return Number(b);
  if(Number.isInteger(b)&&b>=2&&b<65535)return b;
  throw Error(`Unsupported mapped bit ${b}`);
}
function binary(s,n,allowX=false) {
  if(typeof s!=='string'||s.length!==n||!(allowX?/^[01x]+$/:/^[01]+$/).test(s)) throw Error('Invalid iCE40 parameter');
  return s.replaceAll('x','0');
}
function ramInit(p) {
  const words=[];
  for(const k of '0123456789ABCDEF') {
    const init=binary(p['INIT_'+k],256,true);
    for(let end=256;end>0;end-=16) words.push(parseInt(init.slice(end-16,end),2).toString(16).padStart(4,'0'));
  }
  const s=words.join(''); return /^0+$/.test(s)?'':s;
}

// Match named routed nets to mapped signal bits. nextpnr and Yosys use
// different numeric IDs. Leave optimized/ambiguous signals unprobed.
function siteProbes(mapped,placed,sites) {
  const byName=new Map();
  const put=(key,v)=>byName.set(key,byName.has(key)&&byName.get(key)!==v?null:v);
  for(const [name,n] of Object.entries(mapped.netnames)) n.bits.forEach((b,i)=>{
    if(b==='x'||b==='z')return;
    if(n.bits.length===1)put(name,net(b));
    put(`${name}[${(n.offset??0)+(n.upto?n.bits.length-i-1:i)}]`,net(b));
  });
  const p=placed.modules.top, wire=new Map();
  for(const [name,n] of Object.entries(p.netnames)) if(n.bits.length===1&&byName.get(name)!=null) {
    const k=n.bits[0],v=byName.get(name);wire.set(k,wire.has(k)&&wire.get(k)!==v?null:v);
  }
  const probes=new Map();
  for(const [name,{type,attributes,connections:c}] of Object.entries(p.cells)) {
    let probe=0;
    const choices=type==='ICESTORM_LC'?['O','LO','COUT']:type==='ICESTORM_RAM'?['RDATA_0']:type==='SB_GB'?['USER_SIGNAL_TO_GLOBAL_BUFFER']:[];
    const kind={O:1,LO:2,COUT:3,RDATA_0:4,USER_SIGNAL_TO_GLOBAL_BUFFER:5};
    for(const port of choices){const b=wire.get(c[port]?.[0]);if(b!=null){probe=b*8+kind[port];break;}}
    if(type==='SB_IO'){const b=byName.get(name.split('$sb_io')[0]);if(b!=null)probe=b*8+6;}
    probes.set(attributes.NEXTPNR_BEL,probe);
  }
  return sites.map(code=>{const {x,y,bel}=unpackSite(code);return probes.get(`X${x}/Y${y}/${belName(bel)}`)??0;});
}

export function liveImage(mappedJson,placed,fabric,build) {
  const m=mappedJson.modules.regrow_fpga;
  const ports=Object.fromEntries(Object.entries(m.ports).map(([n,p])=>[n,p.bits.map(net)]));
  const clk=ports.clk[0],luts=[],ffs=[],rams=[];let max=Math.max(...Object.values(ports).flat());
  for(const c of Object.values(m.cells)) {
    if(c.type==='$scopeinfo')continue;
    const pins=Object.fromEntries(Object.entries(c.connections).map(([key,v])=>[key,v.map(net)]));
    for(const v of Object.values(pins)) for(const b of v) max=Math.max(max,b);
    const bit=name=>{if(pins[name]?.length!==1)throw Error(`Invalid ${c.type}.${name}`);return pins[name][0];};
    if(c.type==='SB_LUT4') luts.push([bit('O'),...['I0','I1','I2','I3'].map(bit),parseInt(binary(c.parameters.LUT_INIT,16),2)]);
    else if(c.type==='SB_CARRY') luts.push([bit('CO'),bit('I0'),bit('I1'),bit('CI'),0,0xe8e8]); // majority
    else if(/^SB_DFFE?(SR|SS)?$/.test(c.type)) {
      if(bit('C')!==clk)throw Error('Unsupported flip-flop clock');
      ffs.push(bit('Q'),bit('D'),pins.E?bit('E'):1,pins.R?bit('R'):pins.S?bit('S'):0,Number(Boolean(pins.S)));
    } else if(c.type==='SB_RAM40_4K') {
      const enabledClock=k=>{const b=bit(k);if(b===clk)return true;if(b<=1)return false;throw Error('Unsupported block RAM clock');};
      rams.push({rm:parseInt(binary(c.parameters.READ_MODE,2),2),wm:parseInt(binary(c.parameters.WRITE_MODE,2),2),init:ramInit(c.parameters),
        re:enabledClock('RCLK')?bit('RE'):0,rce:bit('RCLKE'),ra:pins.RADDR,rd:pins.RDATA,
        we:enabledClock('WCLK')?bit('WE'):0,wce:bit('WCLKE'),wa:pins.WADDR,wd:pins.WDATA,mask:pins.MASK});
    } else throw Error(`Unsupported live FPGA primitive: ${c.type}`);
  }
  // A single evaluation in this order settles every combinational path.
  const drivers=new Map(luts.map((g,i)=>[g[0],i])),seen=new Uint8Array(luts.length),ops=[];
  function schedule(i){if(seen[i]===2)return;if(seen[i])throw Error('Combinational loop in FPGA mapping');seen[i]=1;
    for(const b of luts[i].slice(1,5))if(drivers.has(b))schedule(drivers.get(b));
    ops.push(...luts[i]);seen[i]=2;}
  luts.forEach((_,i)=>schedule(i));
  // The stepper models one rising edge; the clock cannot also serve as data.
  if(luts.some(g=>g.slice(1,5).includes(clk))||ffs.some((b,i)=>i%5!==4&&b===clk)||rams.some(r=>[r.re,r.rce,...r.ra,r.we,r.wce,...r.wa,...r.mask,...r.wd].includes(clk)))throw Error('Clock used as data');
  return {format:'regrow-hx8k-live/1',buildId:build.id,mappedHash:build.mappedHash,wires:max+1,ports,ops,ffs,rams,probes:siteProbes(m,placed,fabric.sites)};
}
