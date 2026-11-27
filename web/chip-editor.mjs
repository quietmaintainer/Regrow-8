import { arity } from '../examples/machine_recipe/logic.mjs';
import { primitiveNames,recipeGraph } from '../examples/fpga_fabric/recipe-graph.mjs';
import { normalize } from './chip-model.mjs?v=2';

export class RecipeHistory {
  constructor(text='') { this.stack=[normalize(text)];this.at=0; }
  get text(){ return this.stack[this.at]; }
  put(text) { text=normalize(text);if(text===this.text)return;this.stack.splice(this.at+1);this.stack.push(text);if(this.stack.length>40)this.stack.shift();this.at=this.stack.length-1; }
  undo(){if(this.at>0)this.at--;return this.text;}
  redo(){if(this.at+1<this.stack.length)this.at++;return this.text;}
}

export const numberOfPorts=op=>arity[primitiveNames.indexOf(op)]??0;
// Structured edits preserve the text format and untouched lines/comments.
// Validate before accepting a connection; free-form text can be an invalid draft.
export function editGate(text,graph,selected,action,name,op,refs) {
  const old=graph.nodes.find(n=>n.name===selected&&n.group);
  if(action!=='add'&&!old) throw Error('Select a gate first');
  if(!['add','replace','delete'].includes(action))throw Error('Unknown gate action');
  const lines=text.split('\n');
  if(action==='delete') lines.splice(old.line-1,1);
  else {
    if(!/^[A-Za-z_][\w.-]*$/.test(name)||!numberOfPorts(op)||refs.length!==numberOfPorts(op)) throw Error('Choose a valid gate name, primitive and input signals');
    const decl=`  gate ${name} ${op} ${refs.join(' ')}`;
    if(action==='add') {
      if(old)lines.splice(old.line,0,decl);
      else {const group=lines.findIndex(l=>/^\s*group\s/.test(l));if(group>=0)lines.splice(group+1,0,decl);else lines.push('group workbench',decl);}
    } else {
      const comment=lines[old.line-1].indexOf('#');lines[old.line-1]=decl+(comment<0?'':`  ${lines[old.line-1].slice(comment)}`);
      if(name!==old.name) for(let i=0;i<lines.length;i++) {
        const [code,...comments]=lines[i].split('#'), tokens=code.trim().split(/\s+/);
        const start=tokens[0]==='gate'?3:tokens[0]==='output'?2:tokens.length;
        if(!tokens.slice(start).includes(old.name))continue;
        for(let j=start;j<tokens.length;j++)if(tokens[j]===old.name)tokens[j]=name;
        lines[i]=(tokens[0]==='gate'?'  ':'')+tokens.join(' ')+(comments.length?'  #'+comments.join('#'):'');
      }
    }
  }
  const result=lines.join('\n'); recipeGraph(result); return result;
}
