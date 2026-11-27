import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAT,normalize,identity,roleDesign,checkTrace,belType } from '../../web/chip-model.mjs';
import { commitOracle } from './recipe-graph.mjs';
import { liveImage } from './live-image.mjs';
import { validateLiveImage } from '../../web/live-fpga.mjs';
import { artifactHash, protectedTraceFiles, readBuildArtifacts } from './build-artifacts.mjs';
import { verifyLiveTraces } from './verify-live-traces.mjs';

function owner(name,type) {
  if(type==='SB_IO') return 'pins';
  if(type==='SB_GB') return 'global';
  const bay=/^bay(\d+)\.(a|b|spare)\./.exec(name);
  if(bay) return bay[2]==='spare'?`spare:${bay[1]}`:`primary:${2*Number(bay[1])+Number(bay[2]==='b')}`;
  const tape=/^(?:rom|plane)([0-7])(?:[._\[]|$)/.exec(name); if(tape) return `tape:${tape[1]}`;
  if(/^reader\.sha\./.test(name)) return 'sha';
  if(/^reader\.(stage|syndrome)\./.test(name)) return name.startsWith('reader.stage.')?'staging':'syndrome';
  if(name.startsWith('reader.')) return 'reader';
  if(name.startsWith('parity_rom.')) return 'parity';
  if(name.startsWith('crossing.')) return 'crossing';
  if(/^(pc|acc|retire|color)(?:\[|_|$)/.test(name)) return 'bank';
  if(/^bay[0-3]\./.test(name)) return 'bay:'+name[3];
  return 'shared';
}

function placement(doc,utilization) {
  const top=doc.modules.top;
  if (top?.settings?.['arch.type']!=='hx8k'||top.settings['arch.package']!=='ct256'||!parseInt(top.settings.route,2)) throw Error('Expected routed HX8K-CT256 placement');
  const groups=[],sites=[],counts={}, routes=new Map(); let width=0,height=0;
  for(const [name,cell] of Object.entries(top.cells)) {
    const m=/^X(\d+)\/Y(\d+)\/(lc[0-7]|io[01]|ram|gb)$/.exec(cell.attributes.NEXTPNR_BEL);
    if(!m) throw Error(`Unknown placed site on ${name}`);
    const [,xs,ys,sub]=m,x=+xs,y=+ys,b=sub==='ram'?8:sub==='gb'?11:sub.startsWith('lc')?+sub[2]:9+(+sub[2]);
    if(belType(b)!==cell.type||x>=64||y>=64) throw Error('Invalid physical placement');
    const group=owner(name,cell.type); if(!groups.includes(group)) groups.push(group);
    sites.push(x|(y<<6)|(b<<12)|(groups.indexOf(group)<<16));
    counts[cell.type]=(counts[cell.type]??0)+1; width=Math.max(width,x+1); height=Math.max(height,y+1);
  }
  for(const [k,n] of Object.entries(counts)) if(utilization[k]?.used!==n) throw Error(`Placed ${k} count mismatch`);
  // Preserve inter-tile PIPs on named worker output bits. Same-tile PIPs
  // have zero length at this scale. Unattributed logic remains shared.
  for(const [name,net] of Object.entries(top.netnames)) if(/^bay[0-3]\.(a|b|spare)\.value(?:\[\d+\])?$/.test(name)) {
    const group=owner(name,''); if(!routes.has(group)) routes.set(group,new Set());
    for(const m of (net.attributes.ROUTING??'').matchAll(/\/([0-9]+)\.(\d+)\.[^;]*?\.->\.(\d+)\.(\d+)\./g)) {
      const [x,y,xx,yy]=m.slice(1).map(Number); if(x===xx&&y===yy) continue;
      const a=x|y<<6,b=xx|yy<<6; routes.get(group).add(Math.min(a,b)|(Math.max(a,b)<<12));
    }
  }
  return {width,height,groups,sites:sites.sort((a,b)=>(a&65535)-(b&65535)),routes:Object.fromEntries([...routes].map(([k,s])=>[k,[...s].sort((a,b)=>a-b)]))};
}

export function makeViewerBundle(dir) {
  const { files, hashes } = readBuildArtifacts(dir);
  const report=JSON.parse(files['report.json']);
  if(report.simulation!=='iCE40 mapped primitives'||!report.protection) throw Error('Workbench requires a completed protected mapped trial');
  const recipe=normalize(files['recipe.txt'].toString('utf8')), recipeHash=artifactHash(recipe);
  if(recipeHash!==report.recipeSha256) throw Error('Recipe differs from the mapped run');
  const build={device:report.placement.part,seed:report.placement.seed,recipeHash,mappedHash:hashes['mapped.v'],
    mappedJsonHash:hashes['mapped.json'],routedHash:hashes['routed.asc'],placedHash:hashes['placed.json'],
    utilization:report.placement.utilization, fmax:report.placement.fmax, synthesis:report.synthesis.tool};
  build.id=artifactHash(identity(build));
  const roles=roleDesign(recipe), oracle=commitOracle(recipe);
  const scenarios=report.protection.trials.map((measurement,id)=>({buildId:build.id,id,measurement,events:[]}));
  const logs=protectedTraceFiles.map(name=>files[name].toString('utf8'));
  for(const line of logs.join('\n').split(/\r?\n/)) if(line.startsWith('VIEW ')) {
    const [,id,clock,k,...values]=line.split(' '), args=values.map(Number);
    if(k==='write') {
      const word=values.pop(); args.pop();
      if(!/^[0-9a-f]{8}$/i.test(word)||parseInt(word,16)!==roles[args[0]]?.image[args[1]]) throw Error(`Configuration bus mismatch: ${line}`);
    }
    scenarios[Number(id)].events.push([Number(clock),k,...args]);
  }
  scenarios.forEach(sc=>checkTrace(sc,roles,oracle));
  const placed=JSON.parse(files['placed.json']),fabric=placement(placed,build.utilization);
  const live=liveImage(JSON.parse(files['mapped.json']),placed,fabric,build);
  validateLiveImage(live,build,fabric.sites.length);
  const data={build,recipe,roles,fabric,scenarios,live};
  verifyLiveTraces(data);
  return {format:FORMAT,sha256:artifactHash(JSON.stringify(data)),data};
}

export function writeViewerBundle(dir) {
  const name=join(dir,'viewer-bundle.json');
  writeFileSync(name,JSON.stringify(makeViewerBundle(dir))+'\n',{flag:'wx'});
  return name;
}
