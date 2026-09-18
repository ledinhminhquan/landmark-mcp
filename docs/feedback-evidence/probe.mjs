// Local A7 probes. Uses only already-installed project dependencies; no network.
import { createRequire } from 'node:module';
import { writeFile, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const project = new URL('../../', import.meta.url);
const require = createRequire(new URL('package.json', project));
const { McpServer } = await import(new URL('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js', project));
const { WebStandardStreamableHTTPServerTransport: Transport } = await import(new URL('node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js', project));
const { LATEST_PROTOCOL_VERSION, DEFAULT_NEGOTIATED_PROTOCOL_VERSION } = await import(new URL('node_modules/@modelcontextprotocol/sdk/dist/esm/types.js', project));
const { z } = require('zod');
const ExcelJS = require('exceljs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (promise, label) => Promise.race([promise,wait(2000).then(()=>{throw new Error('Probe timeout: '+label);})]);
const progress = new URL('./probe-progress.txt',import.meta.url);
await writeFile(progress,`pid=${process.pid}\n`);
const deadline=setTimeout(()=>{process.stderr.write('A7 probe global deadline\n');process.exit(2);},25000);
const results = { checkedAt: new Date().toISOString(), node: process.version, scope: 'A7 controlled probes, not a reconstruction of original build console output; no Alexa/cloud/microphone calls', versions: { sdk: '1.30.0', zod: require('zod/package.json').version, exceljs: require('exceljs/package.json').version, typescript: require('typescript/package.json').version }, protocol: { LATEST_PROTOCOL_VERSION, DEFAULT_NEGOTIATED_PROTOCOL_VERSION } };
function request(method, params) {
  return new Request('http://localhost/mcp', {method:'POST', headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
}
results.schemas = {};
for (const [name, schema] of Object.entries({rawShape:{value:z.string()},zodObject:z.object({value:z.string()}),plainJsonSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}})) {
  await appendFile(progress,'schema '+name+'\n');
  const server = new McpServer({name:'a7-schema-probe',version:'1'});
  const transport = new Transport({enableJsonResponse:true});
  try {
    server.registerTool('echo',{inputSchema:schema},async args=>({content:[{type:'text',text:JSON.stringify(args)}]}));
    await server.connect(transport);
    const call = await bounded(transport.handleRequest(request('tools/call',{name:'echo',arguments:{value:'ok'}})),name+' call');
    results.schemas[name] = {callStatus:call.status,call:await call.json()};
  } catch(error) {results.schemas[name]={error:String(error)};}
  finally {await bounded(server.close(),'close');}
}
results.streamLifetime = [];
for (const options of [{json:false,closeEarly:true},{json:false,closeEarly:false},{json:true,closeEarly:true}]) {
  await appendFile(progress,'stream '+JSON.stringify(options)+'\n');
  const server = new McpServer({name:'a7-stream-probe',version:'1'});
  server.registerTool('delayed_echo',{inputSchema:{value:z.string()}},async({value})=>{await wait(30);return {content:[{type:'text',text:value}]};});
  const transport = new Transport({enableJsonResponse:options.json});
  await server.connect(transport);
  const response = await bounded(transport.handleRequest(request('tools/call',{name:'delayed_echo',arguments:{value:'ok'}})),'stream request');
  if(options.closeEarly) await transport.close();
  const body = await Promise.race([response.text(),wait(1000).then(()=>'<timeout>')]);
  results.streamLifetime.push({...options,status:response.status,contentType:response.headers.get('content-type'),body});
  await wait(50); await server.close();
}
const book = new ExcelJS.Workbook();
await appendFile(progress,'merge and node\n');
const sheet=book.addWorksheet('Budget'); sheet.getCell('A1').value='Engineering'; sheet.mergeCells('A1:A3');
const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(await book.xlsx.writeBuffer());
const ws=loaded.getWorksheet('Budget');
results.merges={modelMerges:ws.model.merges,isArray:Array.isArray(ws.model.merges),cells:['A1','A2','A3'].map(address=>({address,value:ws.getCell(address).value,isMerged:ws.getCell(address).isMerged,master:ws.getCell(address).master.address}))};
const bad = new URL('./parameter-property.ts',import.meta.url);
await writeFile(bad,'class Problem { constructor(readonly nextStep: string) {} }\nnew Problem("retry");\n');
const run=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(bad)],{encoding:'utf8'});
results.parameterProperty={exit:run.status,stderr:run.stderr};
const tsc = new URL('node_modules/typescript/lib/tsc.js',project);
const erasable = spawnSync(process.execPath,[fileURLToPath(tsc),'--erasableSyntaxOnly','--noEmit'],{encoding:'utf8'});
results.erasableFlag={exit:erasable.status,stdout:erasable.stdout,stderr:erasable.stderr};
await writeFile(new URL('./legacy-probe-results.json',import.meta.url),JSON.stringify(results,null,2)+'\n');
clearTimeout(deadline);
console.log(JSON.stringify(results,null,2));
