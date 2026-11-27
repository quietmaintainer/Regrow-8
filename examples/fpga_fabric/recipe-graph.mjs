import { expand, IN, OUT, DFF, NOT, AND, OR, XOR, MUX } from '../machine_recipe/logic.mjs';

export const primitiveNames = ['', 'IN', 'OUT', 'NOT', 'AND', 'OR', 'XOR', 'MUX', 'DFF'];
// Validate the whole graph, including disconnected cones. A DFF cuts the
// combinational dependency at Q. This logic-level model never sees placement.
export function recipeGraph(text) {
  if (typeof text !== 'string' || text.length > 262144 || text.trimStart().startsWith('{')) throw Error('Expected a CRC text recipe (up to 256 KiB)');
  const { gates, outputs, ids } = expand(text);
  if (gates.length > 2048) throw Error('Workbench supports up to 2,048 gates and pins');
  const names = []; for (const [name,id] of ids) names[id] = name;
  outputs.forEach((name,i) => { names[gates.length-outputs.length+i]=name; });
  const lines = new Map(); let group = '';
  text.split(/\r?\n/).forEach((line,i) => {
    const [op,name]=line.split('#',1)[0].trim().split(/\s+/);
    if (op==='group') group=name;
    if (op==='gate' || op==='output') lines.set(name,{line:i+1,group:op==='gate'?group:''});
  });
  const nodes=gates.map(([op,...refs],id)=>({name:names[id],op:primitiveNames[op],refs:refs.map(r=>names[r]),...lines.get(names[id])}));
  const order=[], regs=[], mark=new Uint8Array(gates.length);
  function visit(i) {
    if (mark[i]===2) return;
    if (mark[i]===1) throw Error(`Combinational cycle at ${names[i]} (line ${nodes[i].line})`);
    mark[i]=1; const [op,...refs]=gates[i];
    if (op===DFF) regs.push(i);
    else if (op!==IN) { refs.forEach(visit); order.push(i); }
    mark[i]=2;
  }
  gates.forEach((_,i)=>visit(i));
  return { gates, names, nodes, ids, order, regs };
}

// Evaluate the source gates independently of the FPGA packer for trace checks.
export function commitOracle(recipe) {
  const {gates,names,order,regs}=recipeGraph(recipe);
  const bits=new Uint8Array(gates.length); // rst is strapped low.
  const taps=name=>Array.from({length:8},(_,i)=>{
    const signal=name+i, index=names.indexOf(signal);
    if(index<0)throw Error(`Unknown signal ${signal}`);
    return index;
  });
  const pc=taps('pc'), acc=taps('acc');
  const readBus=indices=>indices.reduce((value,index,bit)=>value|(bits[index]<<bit),0);

  function settle() {
    for (const i of order) {
      const [op,a,b,c]=gates[i], x=bits[a], y=bits[b];
      switch (op) {
        case OUT: bits[i]=x; break; case NOT: bits[i]=1-x; break; case AND: bits[i]=x&y; break;
        case OR: bits[i]=x|y; break; case XOR: bits[i]=x^y; break; case MUX: bits[i]=x?bits[c]:y; break;
        default: throw Error('Unknown gate');
      }
    }
  }
  settle();
  return Array.from({length:8},()=>{
    const next=regs.map(i=>bits[gates[i][1]]);
    regs.forEach((id,i)=>{bits[id]=next[i];});
    settle();
    return (readBus(pc)<<8)|readBus(acc);
  });
}
