import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
const skip=new Set(['.git','node_modules','dist','release','client-config']);let files=0;
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(skip.has(e.name))continue;const p=join(dir,e.name);if(e.isDirectory()){await walk(p);continue;}if(/\.sqlite|\.env$|\.pem$|\.key$/.test(e.name))throw Error('Private file type: '+p);if(!/\.(?:ts|js|mjs|json|md|csv|ya?ml|toml)$/.test(e.name))continue;const s=await readFile(p,'utf8');if(/\/Users\/[a-z][a-z0-9._-]+\//i.test(s))throw Error('Personal absolute path: '+p);if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}/.test(s))throw Error('Credential pattern: '+p);files++;}}
await walk('.');const p=JSON.parse(await readFile('package-lock.json','utf8'));for(const name of Object.keys(p.packages||{})){if(name.split('/').at(-1)==='axi'+'os')throw Error('Banned dependency');}
console.log('Public distribution scan passed: '+files+' source/config/doc files. Review the diff before publication; pattern scans do not prove absence of every secret.');
