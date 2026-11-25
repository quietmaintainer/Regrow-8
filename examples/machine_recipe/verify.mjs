// Independent integer oracles. The only device interface here is its pins
// and rising edge: even exhaustive CPU starting states are loaded by executing
// instructions. Bit k of a word belongs to test lane k.
const names=(s,n)=>Array.from({length:n},(_,i)=>s+i);
const A=names('a',8), B=names('b',8), Y=names('y',8), I=names('i',8), DATA=names('data',8);
const OP=names('op',3), PC=names('pc',2), ADDR=names('addr',2);
// Boundary pad order is part of the test fixture, independent of the contents
// or ordering of the recipe supplied to the constructor.
export function pinout(device) {
  if (device==='alu') return {inputs:[...A,...B,...OP.slice(0,2)],outputs:[...Y,'z','c']};
  if (device==='cpu') return {inputs:[...I,...OP,'rst'],outputs:['we',...DATA,'pc0','addr0','pc1','addr1']};
  throw Error('unknown pin contract');
}
const broadcast=Array.from({length:256},(_,v)=>A.map((_,b)=>-((v>>b)&1)));
function pack(f) {
  const result=Array(8).fill(0);
  for (let k=0;k<32;k++) {
    const v=f(k);
    for (let b=0;b<8;b++) result[b]|=((v>>b)&1)<<k;
  }
  return result;
}
const ascending=Array.from({length:8},(_,block)=>pack(k=>32*block+k));
function drive(m,names,words) { for (let b=0;b<names.length;b++) m.drive(names[b],words[b]); }
function match(m,pin,w) {
  const got=m.read(pin);
  if (got!==w) throw Error(`${pin}: actual 0x${(got>>>0).toString(16)}, expected 0x${(w>>>0).toString(16)}`);
}
function check(m,names,words) { for (let b=0;b<names.length;b++) match(m,names[b],words[b]); }

export function verifyAlu(m) {
  const ops=OP.slice(0,2); let vectors=0;
  for (let op=0;op<4;op++) for (let a=0;a<256;a++) for (let base=0;base<256;base+=32) {
    drive(m,ops,broadcast[op]); drive(m,A,broadcast[a]); drive(m,B,ascending[base>>5]); m.settle();
    let zero=0,carry=0;
    const result=pack(k=>{
      const b=base+k, y=[a+b,a-b,a^b,a&b][op]&255;
      if (!y) zero|=1<<k;
      if ((op===0 && a+b>255)||(op===1 && a>=b)) carry|=1<<k;
      return y;
    });
    try { check(m,Y,result); match(m,'z',zero); match(m,'c',carry); }
    catch(e) { throw Error(`ALU op=${op}, a=${a}, b=${base}..${base+31}: ${e.message}`); }
    vectors+=32;
  }
  return {vectors};
}

function instruction(m,op,operand,reset=false) {
  drive(m,OP,broadcast[op]); drive(m,I,operand); m.drive('rst',reset?-1:0); m.settle();
}
function nextAcc(a,op,i) {
  switch(op) { case 0:return i; case 1:return (a+i)&255; case 2:return (a-i)&255; case 3:return a^i; default:return a; }
}
function nextPc(a,pc,op,i) { return (op===6 || (op===5 && a===0) ? i : pc+1)&3; }
function readScalar(m,names) { return names.reduce((v,p,b)=>v|((m.read(p)&1)<<b),0); }

// The ROM is addressed by the actual PC pads. Only the actual write-enable,
// address and data pads can change the external RAM, at the prescribed edge.
export function program(m,{cycles=16,beforeEdge,onSample}={}) {
  const rom=[[1,1],[4,3],[2,1],[5,1]], ram=Array(4).fill(0), expected=ram.slice(), stores=[];
  instruction(m,4,broadcast[2],true); match(m,'we',0); m.rise();
  let a=0,pc=0;
  for (let t=0;t<cycles;t++) {
    m=beforeEdge?.(t,m) ?? m;
    m.settle(); check(m,PC,broadcast[pc]); check(m,DATA,broadcast[a]);
    if (onSample) onSample({edge:t,pc:readScalar(m,PC),accumulator:readScalar(m,DATA),ram:ram.slice()});
    const [actualOp,actualI]=rom[readScalar(m,PC)], [op,i]=rom[pc];
    instruction(m,actualOp,broadcast[actualI]);
    match(m,'we',op===4?-1:0);
    if (op===4) check(m,ADDR,broadcast[i]);
    if (m.read('we')&1) {const addr=readScalar(m,ADDR), v=readScalar(m,DATA); ram[addr]=v; stores.push([t,addr,v]);}
    if (op===4) expected[i&3]=a;
    if (ram.some((v,j)=>v!==expected[j])) throw Error(`RAM diverged on edge ${t}`);
    m.rise(); pc=nextPc(a,pc,op,i); a=nextAcc(a,op,i);
  }
  m.settle(); check(m,PC,broadcast[pc]); check(m,DATA,broadcast[a]);
  if (onSample) onSample({edge:cycles,pc:readScalar(m,PC),accumulator:readScalar(m,DATA),ram:ram.slice()});
  return stores;
}

export function verifyCpu(m) {
  const stores=program(m); let vectors=0;
  for (let op=0;op<8;op++) for (let i=0;i<256;i++) for (let base=0;base<256;base+=32) {
    const before=ascending[base>>5], after=pack(k=>nextAcc(base+k,op,i));
    for (let pc=0;pc<4;pc++) {
      instruction(m,0,before); m.rise(); instruction(m,6,broadcast[pc]); m.rise();
      instruction(m,op,broadcast[i]);
      try {
        check(m,PC,broadcast[pc]); check(m,DATA,before); check(m,ADDR,broadcast[i]); match(m,'we',op===4?-1:0);
        m.rise(); m.settle(); check(m,DATA,after);
        // Only the lane with A=0 can take a conditional branch.
        for (let bit=0;bit<2;bit++) {
          let word=broadcast[nextPc(1,pc,op,i)][bit];
          if (!base) word=(word&~1)|(nextPc(0,pc,op,i)>>bit&1);
          match(m,PC[bit],word);
        }
      } catch(e) { throw Error(`CPU op=${op}, i=${i}, pc=${pc}, a=${base}..${base+31}: ${e.message}`); }
      vectors+=32;
    }
  }
  return {vectors,programEdges:16,stores};
}
