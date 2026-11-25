// Recipes describe gates and their inputs. The router chooses physical sites
// and tracks after the recipe has been read.
export const [BLANK, IN, OUT, NOT, AND, OR, XOR, MUX, DFF] = [0,1,2,3,4,5,6,7,8];
export const arity = [0,0,1,1,2,2,2,3,1]; // MUX(select, whenZero, whenOne)
export const bus = (name, n) => Array.from({length:n}, (_, i) => name+i);

const primitives = new Map(Object.entries({NOT, AND, OR, XOR, MUX, DFF}));
const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function readTextRecipe(source) {
  const inputs=[], outputRows=[], modules=[];
  const declared=new Set(), groupNames=new Set();
  let group;
  const error=(line,message)=>Error('Recipe line '+line+': '+message);

  function declare(name,line) {
    if (!identifier.test(name ?? '')) throw error(line,'invalid signal name');
    if (declared.has(name)) throw error(line,'duplicate signal '+name);
    declared.add(name);
  }

  for (const [index,raw] of source.split(/\r?\n/).entries()) {
    const content=raw.split('#',1)[0].trim();
    if (!content) continue;
    const [command,...args]=content.split(/\s+/), line=index+1;
    switch (command) {
      case 'inputs':
        if (!args.length) throw error(line,'inputs requires at least one pin');
        for (const name of args) { declare(name,line); inputs.push(name); }
        break;
      case 'group': {
        const [name]=args;
        if (args.length!==1 || !identifier.test(name)) throw error(line,'group requires one name');
        if (groupNames.has(name)) throw error(line,'duplicate group '+name);
        groupNames.add(name);
        group=[]; modules.push(group);
        break;
      }
      case 'gate': {
        const [name,primitive,...refs]=args, op=primitives.get(primitive);
        if (!group) throw error(line,'gate requires a group');
        if (op===undefined) throw error(line,'unknown gate primitive '+primitive);
        if (refs.length!==arity[op]) throw error(line,primitive+' requires '+arity[op]+' input signals');
        declare(name,line);
        group.push({name,op,refs,line});
        break;
      }
      case 'output': {
        const [name,ref]=args;
        if (args.length!==2) throw error(line,'output requires a pin and a driver');
        declare(name,line);
        outputRows.push({name,ref,line});
        break;
      }
      default: throw error(line,'unknown directive '+command);
    }
  }

  if (!inputs.length || !outputRows.length) throw Error('Recipe requires input and output pins');
  if (modules.some(module=>!module.length)) throw Error('Recipe contains an empty group');

  // Register all drivers first so feedback through a DFF can name a later gate.
  const ids=new Map(inputs.map((name,id)=>[name,id]));
  const gates=inputs.map(()=>[IN]);
  const groups=modules.map(module=>module.map(({name,op})=>{
    const id=gates.length;
    ids.set(name,id);
    gates.push([op]);
    return id;
  }));
  const driver=(name,line)=>{
    if (!ids.has(name)) throw error(line,'unknown driver '+name);
    return ids.get(name);
  };
  for (const {name,refs,line} of modules.flat()) gates[ids.get(name)].push(...refs.map(ref=>driver(ref,line)));
  for (const {ref,line} of outputRows) gates.push([OUT,driver(ref,line)]);
  return {inputs,outputs:outputRows.map(({name})=>name),gates,groups,ids};
}

export function expand(recipe) {
  const source=String(recipe);
  return source.trimStart().startsWith('{') ? readLegacyRecipe(source) : readTextRecipe(source);
}

function readLegacyRecipe(bytes) {
  const {v, inputs, outputs, defs, use, out}=JSON.parse(bytes);
  if (v!==1 || !inputs.length || !outputs.length || new Set([...inputs,...outputs]).size!==inputs.length+outputs.length)
    throw Error('invalid recipe interface/version');
  const gates=inputs.map(()=>[IN]), groups=[];
  for (const [t,...pins] of use) {
    const base=gates.length, body=defs[t];
    if (!body?.length) throw Error('missing template');
    groups.push(body.map(([op,...refs],i)=>{
      if (!Number.isInteger(op) || op<NOT || op>DFF || refs.length!==arity[op]) throw Error('invalid primitive');
      gates.push([op,...refs.map(r=>{
        if (!Number.isSafeInteger(r)) throw Error('invalid template reference');
        return r<0 ? pins[-1-r] : r<body.length ? base+r : undefined;
      })]);
      return base+i;
    }));
  }
  const drivers=gates.length;
  if (out.length!==outputs.length) throw Error('invalid output count');
  for (const src of out) gates.push([OUT,src]);
  if (gates.some(([, ...refs])=>refs.some(i=>!Number.isInteger(i)||i<0||i>=drivers))) throw Error('invalid signal reference');
  return {inputs,outputs,gates,groups};
}
