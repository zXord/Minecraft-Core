const { test } = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../../src/utils/clientPacks/clientPackApi.js');
test('client requests unwrap failures and never authorize legacy on unknown states', async () => {
  const { clientPackApi, allowsLegacyClient } = await modulePromise;
  global.window = { electron: { invoke: async () => ({ ok: false, error: { code: 'CLIENT_PACK_UNAVAILABLE', message: 'Unavailable' } }) } };
  await assert.rejects(clientPackApi.getState('a'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  for (const state of [null, {}, { status: 'unpaired' }, { status: 'future-state' }]) assert.equal(allowsLegacyClient(state), false);
  assert.equal(allowsLegacyClient({ status: 'unmanaged' }), true);
});
test('progress uses both scope identifiers and removes only its own listener on settlement', async () => {
  const { clientPackApi } = await modulePromise;
  const listeners = new Set();
  const seen = [];
  global.window = { electron: {
    on: (channel, callback) => listeners.add(callback),
    removeListener: (channel, callback) => listeners.delete(callback),
    invoke: async (channel, request) => {
      assert.equal(channel, 'client-packs:preview');
      for (const callback of listeners) {
        callback({ requestId: request.requestId, clientId: 'b', phase: 'wrong-client' });
        callback({ requestId: 'other', clientId: 'a', phase: 'wrong-request' });
        callback({ requestId: request.requestId, clientId: 'a', phase: 'preparing', completedBytes: '12' });
      }
      return { ok: true, value: { planId: 'p' } };
    }
  } };
  const result = await clientPackApi.preview({ clientId: 'a' }, { onProgress: value => seen.push(value.phase) });
  assert.deepEqual(seen, ['preparing']);
  assert.deepEqual(result, { planId: 'p' });
  assert.equal(listeners.size, 0);
});
test('abort cancels only the request it owns and awaits main settlement without hiding late completion', async () => {
  const { clientPackApi } = await modulePromise;
  const controller = new AbortController();
  let resolveWork;
  let requestId;
  const calls = [];
  global.window = { electron: {
    on() {}, removeListener() {},
    invoke: async (channel, request) => {
      calls.push([channel, request]);
      if (channel === 'client-packs:cancel') { resolveWork({ ok: true, value: { status: 'ready' } }); return { ok: true, value: { cancelled: false } }; }
      requestId = request.requestId;
      return new Promise(resolve => { resolveWork = resolve; });
    }
  } };
  const work = clientPackApi.install({ clientId: 'a', planId: 'p', conflictChoices: {} }, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await work, { status: 'ready' });
  assert.deepEqual(calls[1], ['client-packs:cancel', { requestId }]);
});
test('cancel remains pending until main confirms exact request settlement', async () => {
  const { clientPackApi } = await modulePromise;
  const controller = new AbortController();
  let resolveWork, resolveCancel, settled = false;
  global.window = { electron: { on() {}, removeListener() {}, invoke: (channel) => {
    if (channel === 'client-packs:cancel') return new Promise(resolve => {resolveCancel=resolve;});
    return new Promise(resolve => {resolveWork=resolve;});
  } } };
  const work = clientPackApi.preview({clientId:'a'}, {signal:controller.signal}).finally(() => {settled=true;});
  controller.abort();
  resolveWork({ok:false,error:{code:'CANCELLED',message:'Cancelled'}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled,false);
  resolveCancel({ok:true,value:{cancelled:true}});
  await assert.rejects(work, {code:'CANCELLED'});
});
test('malformed measured counts are omitted rather than inventing a percentage', async () => {
  const { clientPackApi } = await modulePromise;
  let callback;
  let progress;
  global.window={electron:{on:(channel,fn)=>callback=fn,removeListener(){},invoke:async(channel,input)=>{
    callback({...input,phase:'downloading',completedBytes:'-1',totalBytes:'NaN',completedItems:'4',totalItems:'1e3'});
    return {ok:true,value:{planId:'p'}};
  }}};
  await clientPackApi.preview({clientId:'a'},{onProgress:value=>progress=value});
  assert.equal(progress.completedBytes,undefined);
  assert.equal(progress.totalBytes,undefined);
  assert.equal(progress.completedItems,'4');
  assert.equal(progress.totalItems,undefined);
});
