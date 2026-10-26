import { createHostClient } from '@getpaseo/client/node';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const home=process.env.PASEO_HOME||join(homedir(),'.paseo');
const status=JSON.parse(execFileSync('paseo',['daemon','status','--json'],{encoding:'utf8'}));
const client=createHostClient(status.listen,{clientId:'file-bridge-verification',clientType:'cli',appVersion:'0.13.0',
  localCredential:async()=>(await readFile(join(home,'local-credential'),'utf8')).trim(),reconnect:{enabled:false}});
try {
  await client.connect();
  const own=(await client.getPluginCatalog()).find(x=>x.id==='file-bridge');assert.ok(own,'Plugin missing');
  const runtime={'@getpaseo/plugin':require('@getpaseo/plugin'),'@getpaseo/plugin/client':{},'@getpaseo/plugin/client/ui':{},react:require('react'),'react/jsx-runtime':require('react/jsx-runtime'),'react-native':{},zod:require('zod')};
  const factory=vm.runInNewContext(own.clientBundle,{setTimeout,clearTimeout,setInterval,clearInterval},{timeout:3000});
  const plugin=factory(name=>{assert.ok(name in runtime,'Unexpected runtime '+name);return runtime[name]});
  const registrations=[];const stop=plugin.default({addScreen:x=>{registrations.push(['screen',x]);return()=>{}},addSidebarHeaderItem:x=>{registrations.push(['sidebar',x]);return()=>{}},addCommandCenterItem:x=>{registrations.push(['command',x]);return()=>{}}});
  assert.deepEqual(registrations.map(x=>x[0]),['screen','sidebar','command']);
  const result=await client.invokePluginRpc('file-bridge','bridge.status',{});
  assert.equal(result.platform,'linux');assert.ok(Array.isArray(result.jobs));assert.match(result.deviceId,/^[a-f0-9]{32}$/);
  await assert.rejects(()=>client.invokePluginRpc('file-bridge','bridge.control',{action:'start'}),/Windows/);
  await assert.rejects(()=>client.invokePluginRpc('file-bridge','bridge.queue',{action:'push',source:'/missing/path.txt'}));
  console.log(JSON.stringify({running:true,registrations:registrations.map(x=>x[0]),rpcStatus:result,errorStates:'Linux start rejected; invalid source rejected',rendering:'not tested on actual Desktop'},null,2));
  stop();
} finally {await client.close()}
