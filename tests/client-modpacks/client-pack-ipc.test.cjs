const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const {createClientPackHandlers:create}=require('../../electron/ipc/client-pack-handlers.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const descriptor={schemaVersion:1,status:'ready',serverFingerprint:'a'.repeat(64),serverVersion:'0.13.4',source:{provider:'modrinth',projectId:'p',versionId:'v'},artifactSha256:'b'.repeat(64),runtime:{minecraftVersion:'1.20.1',loaderFamily:'forge',loaderVersion:'47.4.13',javaMajor:17,os:'win32',architecture:'x64'}};
const preview=clientId=>({clientId,planId:'p',descriptor,optionalFiles:[],optionalFileIds:[],downloadBytes:'0',additions:[],removals:[],replacements:[],conflicts:[],preserved:[]});
const prepare=async f=>assert.equal((await f.call('preview',{clientId:'c',requestId:'preview-r'})).ok,true);

test('MultiMC private source and constraint evidence never becomes IPC authority', async () => {
  const github = { ...descriptor, source: { provider: 'github', repositoryId: '1', githubOwner: 'Example', githubRepo: 'Pack', releaseId: '2', assetId: '3' } };
  const privateFields = { contentFormat: 'multimc', runtimeConstraints: { lwjglVersion: '3.3.1' }, outputId: 'private-output', path: 'C:/private', url: 'https://private' };
  const inspection = { inspectionId: 'i', ...github, name: 'MultiMC client export', version: '1.20.1', optionalFiles: [], downloadBytes: '0' };
  const reviewed = { ...preview('c'), descriptor: github };
  let calls = 0;
  const f = fixture({ companion: { inspect: async () => { calls++; return { ...inspection, ...privateFields }; } }, client: { preview: async () => { calls++; return { ...reviewed, ...privateFields }; } } });
  assert.deepEqual(await f.call('inspect-companion', { serverId: 's', expectedServerFingerprint: 'a'.repeat(64), assetId: '3', requestId: 'r' }), { ok: true, value: inspection });
  assert.deepEqual(await f.call('preview', { clientId: 'c', requestId: 'p' }), { ok: true, value: reviewed });
  for (const [name, input] of [['inspect-companion', { serverId: 's', expectedServerFingerprint: 'a'.repeat(64), assetId: '3', requestId: 'other-r' }], ['preview', { clientId: 'c', requestId: 'other-p' }], ['install', { clientId: 'c', planId: 'p', conflictChoices: {}, requestId: 'install-r' }]]) {
    for (const extra of [{ contentFormat: 'multimc' }, { runtimeConstraints: { lwjglVersion: null } }, { root: '.minecraft' }, { source: github.source }, { path: 'C:/private' }, { url: 'https://private' }]) {
      assert.equal((await f.call(name, { ...input, ...extra })).error.code, 'INVALID_REQUEST');
    }
  }
  assert.equal(calls, 2); await f.dispose();
});
function sender(id) { const value = new EventEmitter(); value.id=id; value.messages=[]; value.dead=false; value.send=(channel,payload) => value.messages.push({channel,payload}); value.isDestroyed=()=>value.dead; return value; }
function fixture(overrides={}) {
  assert.equal(typeof create, 'function', 'matching client IPC boundary must exist');
  const clientPackService = { getState: async ({clientId}) => ({clientId,status:'unmanaged',verified:false,descriptor:null}), verify: async ({clientId}) => ({clientId,status:'unmanaged',verified:false,descriptor:null}), recover:async()=>null,
    preview:async({clientId})=>preview(clientId),install:async()=>{throw new Error('Unexpected install');},cancel:async()=>{throw new Error('Unexpected cancel');},...overrides.client };
  const companionService = {getStatus:async()=>null,listAssets:async()=>({serverFingerprint:'a'.repeat(64),serverVersion:'0.13.4',assets:[]}),inspect:async()=>{throw new Error('Unexpected inspect');},accept:async()=>{throw new Error('Unexpected accept');},...overrides.companion};
  const api=create({clientPackService,companionService}); const owner=sender(1),other=sender(2);
  return {...api,owner,other,call:(name,input,from=owner)=>api.handlers[`client-packs:${name}`]({sender:from},input)};
}

test('IPC returns bounded trusted server drift refusal without unmanaged success', async () => {
  const message = "The server's managed mod files differ from the installed pack. Use Modpack Verify and Repair before installing or launching its matching client pack.";
  const fail = async () => { throw new ModpackError('CLIENT_PACK_SERVER_CHANGED', message, { details: { path: 'C:\\private', token: 'secret' } }); };
  const f = fixture({ client: { getState: fail }, companion: { getStatus: fail } });
  for (const [name, input] of [['get-state', { clientId: 'client-one' }], ['get-companion', { serverId: 'server-one' }]]) {
    const result = await f.call(name, input);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'CLIENT_PACK_SERVER_CHANGED');
    assert.deepEqual(result.error.details, {}); assert.equal(result.error.message, message);
  }
  await f.dispose();
});
test('registered ID request succeeds but renderer filesystem and runtime authority never reaches services',async()=>{
  let calls=0; const f=fixture({client:{getState:async({clientId})=>{calls++;return{clientId,status:'unmanaged',verified:false,descriptor:null};}}});
  assert.deepEqual(await f.call('get-state',{clientId:'client-qa'}),{ok:true,value:{clientId:'client-qa',status:'unmanaged',verified:false,descriptor:null}});
  for(const extra of [{clientPath:'C:\\users\\real'},{runtime:{}},{source:{}},{javaPath:'java.exe'},{sessionToken:'secret'}]) assert.equal((await f.call('get-state',{clientId:'client-qa',...extra})).error.code,'INVALID_REQUEST');
  assert.equal(calls,1); await f.dispose();
});
test('only the bounded restart recovery reason is exposed with recovery-required state',async()=>{
  let result={clientId:'c',status:'recovery-required',verified:false,descriptor:null,recoveryReason:'restart-required',bootId:'private'};
  const f=fixture({client:{getState:async()=>result,verify:async()=>result}});
  for(const channel of ['get-state','verify']) {
    assert.deepEqual(await f.call(channel,{clientId:'c'}),{ok:true,value:{clientId:'c',status:'recovery-required',verified:false,descriptor:null,recoveryReason:'restart-required'}});
  }
  result={...result,recoveryReason:'C:/private'};
  assert.equal((await f.call('get-state',{clientId:'c'})).ok,false);
  result={...result,status:'ready',recoveryReason:'restart-required'};
  assert.equal((await f.call('get-state',{clientId:'c'})).ok,false);
  await f.dispose();
});
test('accessors, malformed identifiers, excessive arrays and unsafe conflict paths reject without evaluation',async()=>{
  const f=fixture();let reads=0;const accessor={};Object.defineProperty(accessor,'clientId',{enumerable:true,get(){reads++;return'client-qa';}});
  for(const input of [accessor,{clientId:'../real'},{clientId:''},{clientId:'a'.repeat(129)}]) assert.equal((await f.call('get-state',input)).error.code,'INVALID_REQUEST');
  assert.equal(reads,0);
  assert.equal((await f.call('preview',{clientId:'c',requestId:'r',optionalFileIds:Array(10001).fill('a')})).error.code,'INVALID_REQUEST');
  for(const unsafe of ['../real','C:/real','mods\\a.jar','mods/../a.jar']) assert.equal((await f.call('install',{clientId:'c',requestId:'r',planId:'p',conflictChoices:{[unsafe]:'replace'}})).error.code,'INVALID_REQUEST');
  assert.equal((await f.call('cancel',{requestId:'r',clientId:'c',operationId:'o'})).error.code,'INVALID_REQUEST');await f.dispose();
});
test('progress is sender scoped, correlation comes from main, and raw metadata is omitted',async()=>{
  const pending=deferred();let options; const f=fixture({client:{install:async(input,opts)=>{options=opts;return pending.promise;}}});
  await prepare(f);
  const run=f.call('install',{clientId:'c',planId:'p',conflictChoices:{},requestId:'r'});await tick();
  options.onProgress({phase:'downloading',operationId:'operation-1',clientId:'other',requestId:'forged',completedBytes:'5',totalBytes:'10',completedItems:2,totalItems:Infinity,path:'C:/private',url:'https://private',message:'secret'});
  assert.deepEqual(f.owner.messages,[{channel:'client-packs:progress',payload:{requestId:'r',clientId:'c',phase:'downloading',operationId:'operation-1',completedBytes:'5',totalBytes:'10',completedItems:'2'}}]);assert.deepEqual(f.other.messages,[]);
  pending.resolve({clientId:'c',status:'ready',verified:true});assert.equal((await run).ok,true);options.onProgress({phase:'preparing'});assert.equal(f.owner.messages.length,1);await f.dispose();
});
test('another sender cannot cancel a request or operation even with known identifiers',async()=>{
  const pending=deferred();let signal;const f=fixture({client:{install:async(_,opts)=>{signal=opts.signal;opts.onProgress({phase:'preparing',operationId:'operation-1'});return pending.promise;}}});
  await prepare(f);
  const run=f.call('install',{clientId:'c',planId:'p',conflictChoices:{},requestId:'r'});await tick();
  assert.equal((await f.call('cancel',{requestId:'r'},f.other)).error.code,'INVALID_REQUEST');
  assert.equal((await f.call('cancel',{clientId:'c',operationId:'operation-1'},f.other)).error.code,'INVALID_REQUEST');assert.equal(signal.aborted,false);
  pending.resolve({clientId:'c',status:'ready',verified:true});await run;await f.dispose();
});
test('cancel waits for actual settlement instead of treating abort as stopped writers',async()=>{
  const pending=deferred(),cancelGate=deferred();let signal,cancelInput;const f=fixture({client:{install:async(_,opts)=>{signal=opts.signal;opts.onProgress({phase:'preparing',operationId:'operation-1'});return pending.promise;},cancel:async input=>{cancelInput=input;await cancelGate.promise;return {...input,cancelled:true};}}});
  await prepare(f);
  const run=f.call('install',{clientId:'c',planId:'p',conflictChoices:{},requestId:'r'});await tick();let settled=false;const cancel=f.call('cancel',{requestId:'r'}).then(x=>{settled=true;return x;});await tick();
  assert.equal(signal.aborted,true);assert.equal(settled,false);assert.deepEqual(cancelInput,{clientId:'c',operationId:'operation-1'});
  cancelGate.resolve();await tick();assert.equal(settled,false);pending.reject(new ModpackError('CANCELLED','The matching client pack request was cancelled'));
  assert.equal((await run).error.code,'CANCELLED');assert.deepEqual(await cancel,{ok:true,value:{cancelled:true}});await f.dispose();
});
test('late cancellation reports completed publication as not cancelled',async()=>{
  const pending=deferred();const f=fixture({client:{install:async(_,opts)=>{opts.onProgress({phase:'publishing',operationId:'operation-1'});return pending.promise;},cancel:async input=>{await pending.promise;return{...input,cancelled:false};}}});
  await prepare(f);
  const run=f.call('install',{clientId:'c',planId:'p',conflictChoices:{},requestId:'r'});await tick();const cancel=f.call('cancel',{requestId:'r'});pending.resolve({clientId:'c',status:'ready',verified:true});assert.equal((await run).ok,true);assert.deepEqual(await cancel,{ok:true,value:{cancelled:false}});await f.dispose();
});
test('uncertain cancellation remains recovery-required, never successful cancellation',async()=>{
  const pending=deferred();const f=fixture({client:{install:async(_,opts)=>{opts.onProgress({phase:'preparing',operationId:'operation-1'});return pending.promise;},cancel:async()=>{throw new ModpackError('RECOVERY_REQUIRED','Client installation recovery is required');}}});
  await prepare(f);
  const run=f.call('install',{clientId:'c',planId:'p',conflictChoices:{},requestId:'r'});await tick();const cancel=f.call('cancel',{requestId:'r'});pending.reject(new ModpackError('RECOVERY_REQUIRED','Client installation recovery is required'));
  assert.equal((await run).error.code,'RECOVERY_REQUIRED');assert.equal((await cancel).error.code,'RECOVERY_REQUIRED');await f.dispose();
});
test('destroyed sender stops only its own requests and disposal waits for their settlement',async()=>{
  const a=deferred(),b=deferred();const signals={};const f=fixture({companion:{inspect:async({serverId},opts)=>{signals[serverId]=opts.signal;return(serverId==='a'?a:b).promise;}}});
  const runA=f.call('inspect-companion',{serverId:'a',expectedServerFingerprint:'a'.repeat(64),requestId:'r'}),runB=f.call('inspect-companion',{serverId:'b',expectedServerFingerprint:'b'.repeat(64),requestId:'r'},f.other);await tick();
  f.owner.dead=true;f.owner.emit('destroyed');await tick();assert.equal(signals.a.aborted,true);assert.equal(signals.b.aborted,false);
  let disposed=false;const dispose=f.dispose().then(()=>{disposed=true;});await tick();assert.equal(disposed,false);assert.equal(signals.b.aborted,true);
  a.reject(new ModpackError('CANCELLED','The matching client pack request was cancelled'));b.reject(new ModpackError('CANCELLED','The matching client pack request was cancelled'));await Promise.all([runA,runB,dispose]);assert.equal(disposed,true);assert.equal(f.owner.listenerCount('destroyed'),0);assert.equal(f.other.listenerCount('destroyed'),0);
});
test('duplicate active correlation IDs reject but identical IDs in another window remain independent',async()=>{
  const pending=deferred();let calls=0;const f=fixture({companion:{inspect:async()=>{calls++;return pending.promise;}}});const input={serverId:'s',expectedServerFingerprint:'a'.repeat(64),requestId:'r'};
  const one=f.call('inspect-companion',input);await tick();assert.equal((await f.call('inspect-companion',input)).error.code,'OPERATION_IN_PROGRESS');const two=f.call('inspect-companion',input,f.other);await tick();assert.equal(calls,2);pending.reject(new ModpackError('CANCELLED','The matching client pack request was cancelled'));await Promise.all([one,two]);await f.dispose();
});
test('raw errors and accidental main-only success fields cannot leak over IPC',async()=>{
  const f=fixture({client:{getState:async({clientId})=>({clientId,status:'unmanaged',verified:false,descriptor:null,javaPath:'C:/private',sessionToken:'secret'}),recover:async()=>{throw new Error('C:/private secret https://private');}}});
  const state=await f.call('get-state',{clientId:'c'});assert.deepEqual(state,{ok:true,value:{clientId:'c',status:'unmanaged',verified:false,descriptor:null}});
  const error=await f.call('recover',{clientId:'c'});assert.equal(error.ok,false);assert.equal(JSON.stringify(error).includes('private'),false);assert.equal(JSON.stringify(error).includes('secret'),false);await f.dispose();
});
test('preview capability is bound to the originating sender and client and consumed once',async()=>{
  let installs=0;const f=fixture({client:{install:async({clientId})=>{installs++;return{clientId,status:'ready',verified:true};}}});await prepare(f);
  const input={clientId:'c',planId:'p',conflictChoices:{},requestId:'install-r'};
  assert.equal((await f.call('install',input,f.other)).error?.code,'INVALID_REQUEST');
  assert.equal((await f.call('install',{...input,clientId:'wrong'})).error?.code,'INVALID_REQUEST');assert.equal(installs,0);
  assert.equal((await f.call('install',input)).ok,true);
  assert.equal((await f.call('install',{...input,requestId:'retry-r'})).error?.code,'INVALID_REQUEST');assert.equal(installs,1);await f.dispose();
});
for (const age of [899999, 900000]) test(`installation review at age ${age} keeps its exact expiry boundary and actionable refusal`, async t => {
  let now = 1000, installs = 0;
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ client: { install: async ({ clientId }) => { installs++; return { clientId, status: 'ready', verified: true }; } } });
  t.after(() => f.dispose());
  await prepare(f); now += age;
  const result = await f.call('install', { clientId: 'c', planId: 'p', conflictChoices: {}, requestId: 'install' });
  assert.equal(installs, age === 899999 ? 1 : 0);
  if (age === 899999) assert.equal(result.ok, true);
  else {
    assert.equal(result.error?.code, 'INVALID_REQUEST');
    assert.match(result.error.message, /review is no longer valid.*Review matching pack again/i);
  }
});

test('slow preparation receives a fresh review lifetime only after completion', async t => {
  let now = 1000, installs = 0;
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ client: {
    preview: async ({ clientId }) => { now += 1200000; return preview(clientId); },
    install: async ({ clientId }) => { installs++; return { clientId, status: 'ready', verified: true }; }
  } });
  t.after(() => f.dispose());
  await prepare(f); now += 899999;
  assert.equal((await f.call('install', { clientId: 'c', planId: 'p', conflictChoices: {}, requestId: 'install' })).ok, true);
  assert.equal(installs, 1);
});

for (const reason of ['missing', 'expired-pruned', 'evicted', 'consumed', 'other-sender', 'other-client']) {
  test(`${reason} review refuses before installation with non-causal review-again guidance`, async t => {
    let now = 1000, installs = 0, serial = 0;
    t.mock.method(Date, 'now', () => now);
    const f = fixture({ client: {
      preview: async ({ clientId }) => ({ ...preview(clientId), planId: `plan-${serial++}` }),
      install: async ({ clientId }) => { installs++; return { clientId, status: 'ready', verified: true }; }
    } });
    t.after(() => f.dispose());
    const input = { clientId: 'c', planId: 'plan-0', conflictChoices: {}, requestId: 'install' };
    if (reason !== 'missing') await prepare(f);
    if (reason === 'expired-pruned') {
      now += 900000;
      await f.call('preview', { clientId: 'c', requestId: 'prune' });
    }
    if (reason === 'evicted') for (let n = 0; n < 16; n++) await f.call('preview', { clientId: 'c', requestId: `fill-${n}` });
    if (reason === 'consumed') assert.equal((await f.call('install', { ...input, requestId: 'first-install' })).ok, true);
    const before = installs;
    const result = await f.call('install', reason === 'other-client' ? { ...input, clientId: 'wrong' } : input,
      reason === 'other-sender' ? f.other : f.owner);
    assert.equal(installs, before);
    assert.equal(result.error?.code, 'INVALID_REQUEST');
    assert.match(result.error.message, /review is no longer valid.*Review matching pack again/i);
    assert.doesNotMatch(result.error.message, /expired|server.*changed|files.*changed/i);
    if (reason === 'other-sender' || reason === 'other-client') {
      assert.equal((await f.call('install', { ...input, requestId: 'correct-owner' })).ok, true);
      assert.equal(installs, 1, 'foreign refusal must not consume the rightful review');
    }
  });
}

test('malformed install and companion acceptance keep their unrelated error guidance', async t => {
  const f = fixture(); t.after(() => f.dispose());
  for (const [name, input] of [
    ['install', { clientId: 'c', planId: 'p', conflictChoices: {}, requestId: 'r', clientPath: 'C:/private' }],
    ['accept-companion', { serverId: 's', expectedServerFingerprint: 'a'.repeat(64), inspectionId: 'missing' }]
  ]) {
    const result = await f.call(name, input);
    assert.equal(result.error?.code, 'INVALID_REQUEST');
    assert.doesNotMatch(result.error.message, /review.*no longer valid|Review matching pack again/i);
  }
});

test('inspection capability cannot be accepted by another sender or for another fingerprint',async()=>{
  let accepts=0;const f=fixture({companion:{inspect:async()=>({inspectionId:'i',...descriptor,name:'TFG',version:'0.13.4',optionalFiles:[],downloadBytes:'0'}),accept:async()=>{accepts++;return descriptor;}}});
  assert.equal((await f.call('inspect-companion',{serverId:'s',expectedServerFingerprint:'a'.repeat(64),requestId:'inspect-r'})).ok,true);
  const input={serverId:'s',inspectionId:'i',expectedServerFingerprint:'a'.repeat(64)};
  assert.equal((await f.call('accept-companion',input,f.other)).error?.code,'INVALID_REQUEST');assert.equal((await f.call('accept-companion',{...input,expectedServerFingerprint:'b'.repeat(64)})).error?.code,'INVALID_REQUEST');assert.equal(accepts,0);
  assert.equal((await f.call('accept-companion',input)).ok,true);assert.equal((await f.call('accept-companion',input)).error?.code,'INVALID_REQUEST');assert.equal(accepts,1);await f.dispose();
});
test('actual downloader and candidate progress shapes retain measured bytes and distinct activities',async()=>{
  const pending=deferred();let report;const f=fixture({companion:{inspect:async(_,opts)=>{report=opts.onProgress;return pending.promise;}}});
  const run=f.call('inspect-companion',{serverId:'s',expectedServerFingerprint:'a'.repeat(64),requestId:'r'});await tick();
  report({partId:'private-name',partBytes:'40',setBytes:'140',totalBytes:'200'});
  report({activity:'assembling-files',processedBytes:150,totalBytes:250,completedItems:3,totalItems:7});
  assert.deepEqual(f.owner.messages.map(x=>x.payload),[
    {requestId:'r',serverId:'s',phase:'downloading-archive',completedBytes:'140',totalBytes:'200'},
    {requestId:'r',serverId:'s',phase:'assembling-files',completedBytes:'150',totalBytes:'250',completedItems:'3',totalItems:'7'}]);
  pending.reject(new ModpackError('CANCELLED','The matching client pack request was cancelled'));await run;await f.dispose();
});
test('cancel after a completed publication does not turn success into an error',async()=>{
  const f=fixture({client:{install:async({clientId})=>({clientId,status:'ready',verified:true})}});await prepare(f);
  assert.equal((await f.call('install',{clientId:'c',planId:'p',conflictChoices:{},requestId:'r'})).ok,true);
  assert.deepEqual(await f.call('cancel',{requestId:'r'}),{ok:true,value:{cancelled:false}});await f.dispose();
  assert.equal((await f.call('get-state',{clientId:'c'})).error.code,'CLIENT_PACK_UNAVAILABLE');
});
test('a misrouted service result cannot be displayed as the requested client or accepted fingerprint',async()=>{
  const f=fixture({client:{getState:async()=>({clientId:'wrong',status:'unmanaged',verified:false,descriptor:null})},companion:{inspect:async()=>({inspectionId:'i',...descriptor,serverFingerprint:'b'.repeat(64),name:'TFG',version:'0.13.4',optionalFiles:[],downloadBytes:'0'})}});
  assert.equal((await f.call('get-state',{clientId:'c'})).ok,false);
  assert.equal((await f.call('inspect-companion',{serverId:'s',expectedServerFingerprint:'a'.repeat(64),requestId:'r'})).ok,false);await f.dispose();
});
for(const settleFirst of [false,true]) test(`destroyed sender retains cancellation barrier through disposal (operation settled first: ${settleFirst})`,async()=>{
  const pending=deferred(),cancelGate=deferred();const f=fixture({client:{install:async(_,opts)=>{opts.onProgress({phase:'preparing',operationId:'op'});return pending.promise;},cancel:async input=>{await cancelGate.promise;return{...input,cancelled:true};}}});await prepare(f);
  const run=f.call('install',{clientId:'c',planId:'p',conflictChoices:{},requestId:'r'});await tick();f.owner.dead=true;f.owner.emit('destroyed');await tick();
  if(settleFirst){pending.reject(new ModpackError('CANCELLED','Cancelled'));await run;await tick();}
  let disposed=false;const disposal=f.dispose().then(()=>{disposed=true;});
  if(!settleFirst){pending.reject(new ModpackError('CANCELLED','Cancelled'));await run;}
  await tick();const premature=disposed;cancelGate.resolve();await disposal;assert.equal(premature,false);
});
test('request admission failure leaves the unused plan available for a fresh correlation ID',async()=>{
  const pending=deferred();let installs=0;const f=fixture({client:{install:async({clientId})=>{installs++;return{clientId,status:'ready',verified:true};}},companion:{inspect:async()=>pending.promise}});await prepare(f);
  const other=f.call('inspect-companion',{serverId:'s',expectedServerFingerprint:'a'.repeat(64),requestId:'same'});await tick();const input={clientId:'c',planId:'p',conflictChoices:{}};
  assert.equal((await f.call('install',{...input,requestId:'same'})).error.code,'OPERATION_IN_PROGRESS');const retry=await f.call('install',{...input,requestId:'fresh'});
  pending.reject(new ModpackError('CANCELLED','Cancelled'));await other;await f.dispose();assert.equal(retry.ok,true);assert.equal(installs,1);
});
test('an unresolved cancellation barrier cannot be displaced by reusing its correlation ID',async()=>{
  const pending=deferred(),cancelGate=deferred();const f=fixture({client:{install:async(_,opts)=>{opts.onProgress({phase:'preparing',operationId:'op'});return pending.promise;},cancel:async input=>{await cancelGate.promise;return{...input,cancelled:true};}}});await prepare(f);
  const run=f.call('install',{clientId:'c',planId:'p',conflictChoices:{},requestId:'r'});await tick();const cancel=f.call('cancel',{requestId:'r'});await tick();pending.reject(new ModpackError('CANCELLED','Cancelled'));await run;
  const reuse=await f.call('preview',{clientId:'c',requestId:'r'});cancelGate.resolve();await cancel;await f.dispose();assert.equal(reuse.error?.code,'OPERATION_IN_PROGRESS');
});
