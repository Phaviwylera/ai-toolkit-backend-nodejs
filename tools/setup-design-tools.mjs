/* Optional authoring tools. Never required by visitors or the production server. */
import {spawnSync} from 'node:child_process';import {existsSync,mkdirSync} from 'node:fs';import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');const folder=resolve(root,'.tools/font-mcp');mkdirSync(resolve(root,'.tools'),{recursive:true});
function run(command,args,cwd=root){const r=spawnSync(command,args,{cwd,stdio:'inherit',shell:process.platform==='win32'});if(r.status!==0)process.exit(r.status||1)}
if(!existsSync(folder))run('git',['clone','--depth','1','https://github.com/Microck/font-mcp.git',folder]);
run('npm',['install'],folder);run('npm',['run','build'],folder);
console.log('Font MCP ready. Load .mcp.json in a compatible editor. DesignLang starts through npx.');
