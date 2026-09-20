import {mkdir,cp,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import JSZip from 'jszip';
const exec=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const p=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const out=join(root,'release'),name=`${p.name}-${p.version}-${process.platform}-${process.arch}`,stage=join(out,name);
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
// Explicit allowlist: no local databases, credentials, exports, caches, or private profiles.
for(const path of ['dist/src','vendor','skills','scripts/launch.mjs','scripts/install.mjs','scripts/setup.mjs','scripts/verify-release.mjs','.codex-plugin','.claude-plugin','.agents','.mcp.json','package.json','package-lock.json','LICENSE','README.md','AGENTS.md','SETUP.md','SECURITY.md','docs','examples','assets'])await cp(join(root,path),join(stage,path),{recursive:true});
const npm=process.platform==='win32'?'npm.cmd':'npm';
// execFile .cmd is not portable on Windows. Run npm's JS entry point with the build Node.
const npmCli=process.env.npm_execpath;
if(!npmCli)throw Error('Run using npm run release:pack');
await exec(process.execPath,[npmCli,'ci','--omit=dev','--ignore-scripts'],{cwd:stage,maxBuffer:10_000_000});
const sbom=await exec(process.execPath,[npmCli,'sbom','--package-lock-only','--omit=dev','--sbom-format=cyclonedx'],{cwd:stage,maxBuffer:20_000_000});await writeFile(join(stage,'sbom.json'),sbom.stdout);
await mkdir(join(stage,'runtime'),{recursive:true});
// Use official Node builds: a Homebrew executable can depend on external dylibs.
const nodeFile=`node-${process.version}-${process.platform==='win32'?'win':process.platform}-${process.arch}.${process.platform==='win32'?'zip':'tar.gz'}`;
const base=`https://nodejs.org/dist/${process.version}/`;
const checksResponse=await fetch(base+'SHASUMS256.txt',{signal:AbortSignal.timeout(60000)});if(!checksResponse.ok)throw Error('Node checksums unavailable');
const checks=await checksResponse.text();const expected=checks.split('\n').find(l=>l.trim().endsWith(' '+nodeFile))?.split(/\s+/)[0];if(!expected)throw Error('Official Node archive not listed');
const nodeResponse=await fetch(base+nodeFile,{signal:AbortSignal.timeout(120000)});if(!nodeResponse.ok)throw Error('Node download failed');const bytes=Buffer.from(await nodeResponse.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Node checksum mismatch');
const unpack=join(out,'node-'+process.platform+'-'+process.arch);await mkdir(unpack,{recursive:true});
const archiveRoot=nodeFile.replace(/\.(?:zip|tar\.gz)$/,'');
if(process.platform==='win32'){const zip=await JSZip.loadAsync(bytes);for(const item of ['node.exe','LICENSE'])await writeFile(join(stage,'runtime',item),await zip.file(archiveRoot+'/'+item).async('nodebuffer'));}
else{const file=join(unpack,nodeFile);await writeFile(file,bytes);await exec('tar',['-xzf',file,'-C',unpack]);await cp(join(unpack,archiveRoot,'bin','node'),join(stage,'runtime','node'));await cp(join(unpack,archiveRoot,'LICENSE'),join(stage,'runtime','LICENSE'));await chmod(join(stage,'runtime','node'),0o755);}
await rm(unpack,{recursive:true,force:true});
await exec(process.execPath,[join(stage,'node_modules','playwright','cli.js'),'install','chromium'],{cwd:stage,env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:join(stage,'browsers')},maxBuffer:10_000_000});
await rm(join(stage,'browsers','.links'),{recursive:true,force:true});
const smoke=await exec(process.execPath,[join(root,'scripts','package-smoke.mjs'),stage],{maxBuffer:10_000_000});console.log(smoke.stdout.trim());
const config={command:process.platform==='win32'?'./runtime/node.exe':'./runtime/node',args:['./scripts/launch.mjs','mcp'],cwd:'.'};
await writeFile(join(stage,'.mcp.json'),JSON.stringify({mcpServers:{[p.name]:config}},null,2));
const manifest={manifest_version:'0.3',name:p.name,version:p.version,description:p.description,author:{name:'Mohammed Osman'},license:'MIT',server:{type:'binary',entry_point:'runtime/'+(process.platform==='win32'?'node.exe':'node'),mcp_config:{command:'${__dirname}/runtime/'+(process.platform==='win32'?'node.exe':'node'),args:['${__dirname}/scripts/launch.mjs','mcp']}},tools_generated:true,compatibility:{platforms:[process.platform]},privacy_policies:['https://www.linkedin.com/legal/privacy-policy','https://github.com/Mohammed-Moniem/professional-publisher-community/blob/main/SECURITY.md']};
await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2));
// tar retains Unix executable permissions and avoids buffering bundled browsers in memory.
const archive=join(out,name+'.tar.gz');await exec('tar',['-czf',archive,'-C',out,name],{maxBuffer:10_000_000});
// MCPB is an actual ZIP with Unix permissions. Build only desktop platforms.
if(process.platform!=='linux'){
 const zip=new JSZip();const {readdir,lstat,readlink}=await import('node:fs/promises');
 async function add(dir,relative=''){for(const entry of await readdir(dir)){const path=join(dir,entry),rel=relative?relative+'/'+entry:entry,stat=await lstat(path);if(stat.isSymbolicLink()){zip.file(rel,await readlink(path),{unixPermissions:stat.mode});continue;}if(stat.isDirectory())await add(path,rel);else zip.file(rel,createReadStream(path),{unixPermissions:stat.mode});}}
 await add(stage);await pipeline(zip.generateNodeStream({type:'nodebuffer',streamFiles:true,platform:'UNIX',compression:'DEFLATE',compressionOptions:{level:3}}),createWriteStream(join(out,name+'.mcpb')));
}
for(const suffix of ['.tar.gz',...(process.platform!=='linux'?['.mcpb']:[])]){const hash=createHash('sha256');for await(const chunk of createReadStream(join(out,name+suffix)))hash.update(chunk);await writeFile(join(out,name+suffix+'.sha256'),hash.digest('hex')+'  '+name+suffix+'\n');}
console.log('Packaged '+name+'. Runtime, native modules, fonts, Chromium and license inventory included. Video validation requires ffprobe on PATH.');
