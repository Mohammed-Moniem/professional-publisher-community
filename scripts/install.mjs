// Generates client configurations; never edits existing client config or credentials.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
const root=fileURLToPath(new URL('../',import.meta.url));
const destination=resolve(process.argv[2]||join(root,'client-config'));
await mkdir(destination,{recursive:true});
const node=existsSync(join(root,'runtime',process.platform==='win32'?'node.exe':'node'))?join(root,'runtime',process.platform==='win32'?'node.exe':'node'):process.execPath;
const config={command:node,args:[join(root,'scripts','launch.mjs'),'mcp']};
await writeFile(join(destination,'mcp.json'),JSON.stringify({mcpServers:{'professional-publisher-community':config}},null,2)+'\n');
const quote=s=>JSON.stringify(s);
await writeFile(join(destination,'codex.toml'),'[mcp_servers.professional-publisher-community]\ncommand = '+quote(node)+'\nargs = ['+quote(config.args[0])+', "mcp"]\n');
// Client plugin manifests reference concrete paths to the stable extracted runtime.
await writeFile(join(root,'.mcp.json'),JSON.stringify({mcpServers:{'professional-publisher-community':config}},null,2)+'\n');
console.log('Client configurations written to '+destination+'\nKeep this runtime directory in place. Merge only the named server into your client configuration, or install the plugin using SETUP.md. Existing client settings have not been changed.');
