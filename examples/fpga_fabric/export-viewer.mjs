import { writeFileSync } from 'node:fs';
import { makeViewerBundle } from './viewer-bundle.mjs';

const [dir,dest,...rest]=process.argv.slice(2);
if(!dir||!dest||rest.length) throw Error('Usage: node examples/fpga_fabric/export-viewer.mjs COMPLETED_MAPPED_RUN NEW_BUNDLE.json');
const result=makeViewerBundle(dir);
writeFileSync(dest,JSON.stringify(result)+'\n',{flag:'wx'});
console.log(`${result.data.scenarios.length} checked scenarios · ${result.data.fabric.sites.length} placed resources · ${dest}`);
