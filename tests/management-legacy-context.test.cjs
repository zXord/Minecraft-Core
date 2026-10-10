const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const https = require('node:https');
const http = require('node:http');

async function fixture(work, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-session-legacy-'));
  const clientPath = path.join(root, 'client'); await fsp.mkdir(clientPath);
  const requests = [], hooks = [], agents = [], writes = [], launches = [];
  const saved = { baseOrigin: 'https://saved.test:8443', sessionToken: 'memory-current', managementCertFingerprint: 'a'.repeat(64), binding: 'binding', bindingGeneration: 'generation', revision: 4 };
  let current = true;
  const assertCurrent = async () => { if (!current) throw new Error('saved binding changed'); };
  const context = Object.freeze({ ...saved, assertCurrent });
  const launcher = new EventEmitter();
  launcher.getStatus = () => ({}); launcher.loadAuthData = async () => ({success:true});
  launcher.launchMinecraftProper = async value => { launches.push(value); return {success:true}; };
  const originalLoad = Module._load, originalGet = https.get, originalHttpGet = http.get;
  const modulePath = path.resolve(__dirname, '../electron/ipc/minecraft-launcher-handlers.cjs');
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return {app:{getPath:()=>root,getVersion:()=> 'test'},net:null,session:{defaultSession:null}};
    if (request.includes('logger-handlers.cjs')) return {getLoggerHandlers:()=>({debug(){},info(){},warn(){},error(){}})};
    if (request.includes('services/minecraft-launcher/index.cjs')) return {getMinecraftLauncher:()=>launcher};
    if (request.includes('services/minecraft-launcher/utils.cjs')) return {calculateFileChecksum:()=>'',calculateFileChecksumAsync:async()=>''};
    if (request.includes('app-store.cjs')) return {get:key=>key==='instances'?[{id:'registered',type:'client',path:clientPath}]:{},set:(...args)=>writes.push(args)};
    if (request.includes('config-manager.cjs')) return {getInstanceConfig:async()=>({primarySource:options.source||'server',fallbackSource:'modrinth'})};
    if (request.includes('tls-utils.cjs')) return {
      getPinnedHttpsAgent:async(...args)=>{agents.push(args);if(options.agentFailure)throw new Error('pin rejected');if(options.agentDrift)current=false;return {savedAgent:true};},
      getManagementHttpsAgent:async()=>assert.fail('registered runtime must not default TLS'),
      fetchPeerFingerprint:async()=>assert.fail('registered runtime must not discover pins')
    };
    if (request.includes('servers-dat.cjs')) return {ensureServersDat:async(...args)=>{options.onServers?.(args);return options.serversFailure?{success:false,error:'saved binding changed'}:{success:true};}};
    return originalLoad(request,parent,isMain);
  };
  https.get = (url, requestOptions, callback) => {
    requests.push({url,options:requestOptions});
    const request = new EventEmitter();request.setTimeout=()=>{};request.abort=()=>{};
    process.nextTick(()=>{const response=Readable.from(['denied']);response.statusCode=url.endsWith('/health')?200:401;response.headers={};callback(response);});
    return request;
  };
  http.get = https.get;
  delete require.cache[modulePath];
  try {
    const {createMinecraftLauncherHandlers}=require(modulePath);
    const handlers=createMinecraftLauncherHandlers({isDestroyed:()=>false,webContents:{send(){}}},{
      acquireLegacyManagementContext:async value=>{hooks.push(value);if(options.acquireFailure)throw new Error('unregistered authority');return context;}
    });
    await work({handlers,clientPath,requests,hooks,agents,writes,launches,context,setStale:()=>{current=false;}});
  } finally {https.get=originalGet;http.get=originalHttpGet;Module._load=originalLoad;delete require.cache[modulePath];await fsp.rm(root,{recursive:true,force:true});}
}
const forged = {serverIp:'forged.test',serverPort:'9443',serverProtocol:'https',sessionToken:'renderer-forged',managementCertFingerprint:'b'.repeat(64),registered:true};

test('asset401 dispatch uses main saved origin/token/pin exactly once, never renderer authority or replay',()=>fixture(async f=>{
  const result=await f.handlers['minecraft-download-assets']({}, {clientPath:f.clientPath,type:'shaderpacks',requiredItems:[{fileName:'a.zip'}],serverInfo:forged});
  assert.equal(result.success,false);assert.deepEqual(f.hooks,[f.clientPath]);assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'https://saved.test:8443/api/assets/download/shaderpacks/a.zip');
  assert.deepEqual(f.requests[0].options.headers,{'X-Session-Token':'memory-current'});
  assert.deepEqual(f.agents,[['saved.test','8443','a'.repeat(64)]]);assert.deepEqual(f.writes,[]);
}));
test('server mod401 uses one retained main context without content replay',()=>fixture(async f=>{
  await fsp.mkdir(path.join(f.clientPath,'mods'));
  const result=await f.handlers['minecraft-download-mods']({}, {clientPath:f.clientPath,requiredMods:[{fileName:'a.jar',downloadUrl:'/api/mods/download/a.jar'}],serverInfo:forged});
  assert.equal(result.success,false);assert.deepEqual(f.hooks,[f.clientPath]);
  const content=f.requests.filter(r=>r.url.includes('/api/mods/download/'));
  assert.equal(content.length,1);assert.equal(content[0].url,'https://saved.test:8443/api/mods/download/a.jar');
  assert.deepEqual(content[0].options.headers,{'X-Session-Token':'memory-current'});
  assert.ok(f.requests.filter(r=>r.url.endsWith('/health')).every(r=>!r.options.headers));
}));
for(const mode of ['agentFailure','agentDrift','acquireFailure'])test(`${mode} stops asset work before directories/network and cannot forge private context`,()=>fixture(async f=>{
  const result=await f.handlers['minecraft-download-assets']({}, {clientPath:f.clientPath,type:'shaderpacks',requiredItems:[{fileName:'a.zip'}],serverInfo:forged});
  assert.equal(result.success,false);assert.equal(f.requests.length,0);assert.deepEqual(fs.readdirSync(f.clientPath),[]);assert.deepEqual(f.writes,[]);
},{[mode]:true}));
test('unknown client path fails existing gate before acquiring authority',()=>fixture(async f=>{
  const result=await f.handlers['minecraft-download-assets']({}, {clientPath:path.join(f.clientPath,'unknown'),type:'shaderpacks',requiredItems:[{fileName:'a.zip'}],serverInfo:forged});
  assert.equal(result.success,false);assert.deepEqual(f.hooks,[]);assert.equal(f.requests.length,0);
}));
test('legacy server-list failure stops marker and launch, using the main internal prepared assertion',()=>fixture(async f=>{
  const result=await f.handlers['minecraft-launch']({}, {clientPath:f.clientPath,minecraftVersion:'1.20.1',serverIp:'forged.test',managementPort:'9443',serverInfo:forged});
  assert.equal(result.success,false);assert.deepEqual(f.hooks,[f.clientPath]);assert.deepEqual(f.launches,[]);assert.equal(fs.existsSync(path.join(f.clientPath,'.servers-initialized')),false);
},{serversFailure:true,onServers:args=>{assert.equal(args[1],'saved.test');assert.equal(args[2],'8443');assert.equal(args[6],'memory-current');assert.equal(args[8],'a'.repeat(64));assert.equal(typeof args[9].assertCurrent,'function');assert.deepEqual(args[9].agent,{savedAgent:true});}}));
test('game-port-only launch needs no management authority',()=>fixture(async f=>{
  const result=await f.handlers['minecraft-launch']({}, {clientPath:f.clientPath,minecraftVersion:'1.20.1',serverIp:'game.test',serverPort:'25565',managementPort:'9443',serverInfo:forged});
  assert.equal(result.success,true);assert.deepEqual(f.hooks,[]);assert.equal(f.launches.length,1);
}));
test('external asset metadata cannot forge a management-origin plaintext exception',()=>fixture(async f=>{
  const result=await f.handlers['minecraft-download-assets']({}, {clientPath:f.clientPath,type:'shaderpacks',requiredItems:[{fileName:'a.zip',downloadUrl:'http://forged.test:9443/a.zip'}],serverInfo:{...forged,serverProtocol:'http'}});
  assert.equal(result.success,false);assert.deepEqual(f.hooks,[]);assert.deepEqual(f.requests,[]);
}));
