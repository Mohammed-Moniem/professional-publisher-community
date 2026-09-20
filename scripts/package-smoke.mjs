import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const stage=resolve(process.argv[2]);const root=await mkdtemp(join(tmpdir(),'publisher-package-smoke-'));
const client=new Client({name:'package-smoke',version:'1.0.0'});
try{
 await client.connect(new StdioClientTransport({command:join(stage,'runtime',process.platform==='win32'?'node.exe':'node'),args:[join(stage,'scripts','launch.mjs'),'mcp'],env:{...process.env,PUBLISHER_COMMUNITY_HOME:root},stderr:'pipe'}));
 const list=await client.listTools();if(list.tools.length!==43)throw Error('Unexpected tool count');
 async function call(name,args={}){const r=await client.callTool({name,arguments:args});if(r.isError)throw Error(JSON.stringify(r));return JSON.parse(r.content[0].text);}
 await call('get_workflow');
 const d=await call('create_deck',{deck:{identity:'urn:li:person:synthetic',title:'Packaged rendering',slides:[{layout:'cover',title:'A portable publishing tool.',body:'Synthetic package verification.'}]}});
 const output=await call('render_deck',{deckId:d.id});for(const path of [output.pdf,output.pptx,...output.slides])await access(path);
 console.log('Packaged official Node: 43 MCP tools, workflow and real PDF/PPTX/PNG rendering passed. No credentials or LinkedIn requests.');
}finally{await client.close();await rm(root,{recursive:true,force:true});}
