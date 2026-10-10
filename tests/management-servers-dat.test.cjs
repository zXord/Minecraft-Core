const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const Module=require('node:module');
const https=require('node:https');
const {PassThrough}=require('node:stream');
const {EventEmitter}=require('node:events');

async function fixture(work,options={}){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'mc-session-servers-'));
  const clientPath=path.join(root,'new-client');
  const calls=[],agents=[];let current=true;
  let checks=0,destroyed=false;
  const assertCurrent=async()=>{checks++;if(options.delayedAssertion||options.delayCheckAt===checks)await new Promise(resolve=>setTimeout(resolve,50));if(!current)throw new Error('binding stale');};
  const originalRequest=https.request;
  https.request=(url,requestOptions,callback)=>{
    calls.push({url:String(url),options:requestOptions});
    const response=new PassThrough();response.statusCode=options.status||200;
    const request=new EventEmitter();request.destroy=()=>{destroyed=true;response.destroy();};
    request.end=()=>queueMicrotask(()=>{
      if(options.responseDrift)current=false;callback(response);
      if(options.stall)return;
      const body=options.bytes ? Buffer.from('"'+'x'.repeat(options.bytes-2)+'"') : Buffer.from('{"minecraftPort":25566}');
      response.write(body.subarray(0,10));response.write(body.subarray(10));
      if(options.jsonDrift)current=false;response.end();
    });return request;
  };
  const originalLoad=Module._load;
  const modulePath=path.resolve(__dirname,'../electron/utils/servers-dat.cjs');
  Module._load=function(request,parent,isMain){
    if(request==='./fetch.cjs')return {fetch:async(url,requestOptions)=>{
      calls.push({url,options:requestOptions});
      if(options.responseDrift)current=false;
      return {ok:options.status!==401,json:async()=>{if(options.jsonDrift)current=false;return {minecraftPort:25566};}};
    }};
    if(request==='./tls-utils.cjs')return {
      getPinnedHttpsAgent:async()=>{agents.push('pinned');if(options.pinFailure)throw new Error('pin rejected');return {pinned:true};},
      getManagementHttpsAgent:async()=>{agents.push('default');return {default:true};}
    };
    return originalLoad(request,parent,isMain);
  };
  delete require.cache[modulePath];
  try{await work({ensure:require(modulePath).ensureServersDat,clientPath,calls,agents,assertCurrent,destroyed:()=>destroyed,setStale:()=>{current=false;}});}
  finally{https.request=originalRequest;Module._load=originalLoad;delete require.cache[modulePath];await fsp.rm(root,{recursive:true,force:true});}
}
for(const mode of ['responseDrift','jsonDrift'])test(`registered servers.dat ${mode} rejects before later filesystem writes`,()=>fixture(async f=>{
  const result=await f.ensure(f.clientPath,'saved.test',8443,'Saved',null,false,'memory-current','https','a'.repeat(64),{agent:{prepared:true},assertCurrent:f.assertCurrent});
  assert.equal(result.success,false);assert.equal(fs.existsSync(f.clientPath),false);assert.equal(f.calls.length,1);assert.deepEqual(f.agents,[]);
  assert.deepEqual(f.calls[0].options.agent,{prepared:true});assert.deepEqual(f.calls[0].options.headers,{'X-Session-Token':'memory-current'});
},{[mode]:true}));
test('registered servers.dat checks after awaited prepared agent and before GET',()=>fixture(async f=>{
  const agent=Promise.resolve().then(()=>{f.setStale();return {prepared:true};});
  const result=await f.ensure(f.clientPath,'saved.test',8443,'Saved',null,false,'memory-current','https','a'.repeat(64),{agent,assertCurrent:f.assertCurrent});
  assert.equal(result.success,false);assert.deepEqual(f.calls,[]);assert.equal(fs.existsSync(f.clientPath),false);assert.deepEqual(f.agents,[]);
}));
test('registered servers.dat valid saved context writes once and does not reacquire',()=>fixture(async f=>{
  const result=await f.ensure(f.clientPath,'saved.test',8443,'Saved',null,false,'memory-current','https','a'.repeat(64),{agent:{prepared:true},assertCurrent:f.assertCurrent});
  assert.equal(result.success,true);assert.equal(f.calls.length,1);assert.deepEqual(f.agents,[]);
  assert.match(fs.readFileSync(path.join(f.clientPath,'options.txt'),'utf8'),/lastServer:saved.test:25566/);
  assert.equal(fs.existsSync(path.join(f.clientPath,'servers.dat')),true);
}));
test('setup default argument retains existing pin failure fallback behavior',()=>fixture(async f=>{
  const result=await f.ensure(f.clientPath,'setup.test',8443,'Setup',null,false,'setup-token','https','a'.repeat(64));
  assert.equal(result.success,true);assert.deepEqual(f.agents,['pinned','default']);assert.equal(f.calls.length,1);
},{pinFailure:true}));
test('registered servers.dat401 dispatches once and stops content work without port fallback',()=>fixture(async f=>{
  const result=await f.ensure(f.clientPath,'saved.test',8443,'Saved',null,false,'memory-current','https','a'.repeat(64),{agent:{prepared:true},assertCurrent:f.assertCurrent});
  assert.equal(result.success,false);assert.equal(f.calls.length,1);assert.equal(fs.existsSync(f.clientPath),false);
},{status:401}));
for(const mode of ['stall','delayedAssertion','delayedAgent'])test(`registered servers.dat bounds ${mode} with one shared deadline`,()=>fixture(async f=>{
  const deadline=Date.now()+20;
  const agent=mode==='delayedAgent'?new Promise(resolve=>setTimeout(()=>resolve({prepared:true}),50)):{prepared:true};
  const result=await f.ensure(f.clientPath,'saved.test',8443,'Saved',null,false,'memory-current','https','a'.repeat(64),{agent,assertCurrent:f.assertCurrent,deadline,attemptDeadline:deadline});
  assert.equal(result.success,false);assert.equal(fs.existsSync(f.clientPath),false);
  if(mode==='stall')assert.equal(f.destroyed(),true);else assert.equal(f.calls.length,0);
},{[mode]:true}));
for(const bytes of [262144,262145])test(`registered servers.dat actual chunked transport ${bytes} byte boundary`,()=>fixture(async f=>{
  const result=await f.ensure(f.clientPath,'saved.test',8443,'Saved',null,false,'memory-current','https','a'.repeat(64),{agent:{prepared:true},assertCurrent:f.assertCurrent,deadline:Date.now()+1000});
  assert.equal(result.success,bytes===262144);assert.equal(fs.existsSync(f.clientPath),bytes===262144);
},{bytes}));
test('registered servers.dat post-body assertion shares the original attempt deadline',()=>fixture(async f=>{
  const deadline=Date.now()+20;
  const result=await f.ensure(f.clientPath,'saved.test',8443,'Saved',null,false,'memory-current','https','a'.repeat(64),{agent:{prepared:true},assertCurrent:f.assertCurrent,deadline,attemptDeadline:deadline});
  assert.equal(result.success,false);assert.equal(f.calls.length,1);assert.equal(fs.existsSync(f.clientPath),false);
},{delayCheckAt:2}));
test('registered servers.dat abort after headers destroys the pending body and stops writes',()=>fixture(async f=>{
  const controller=new AbortController();
  const pending=f.ensure(f.clientPath,'saved.test',8443,'Saved',null,false,'memory-current','https','a'.repeat(64),{agent:{prepared:true},assertCurrent:f.assertCurrent,signal:controller.signal,deadline:Date.now()+1000});
  setTimeout(()=>controller.abort(),20);
  assert.equal((await pending).success,false);assert.equal(f.calls.length,1);assert.equal(f.destroyed(),true);assert.equal(fs.existsSync(f.clientPath),false);
},{stall:true}));
