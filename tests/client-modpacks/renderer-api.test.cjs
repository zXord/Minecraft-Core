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

test('server drift stays a refusal with renderer-local Verify and Repair guidance', async () => {
  const { clientPackApi, allowsLegacyClient } = await modulePromise;
  global.window = { electron: { invoke: async () => ({ ok: false,
    error: { code: 'CLIENT_PACK_SERVER_CHANGED', message: 'C:\\private token=secret run-command', retryable: false } }) } };
  await assert.rejects(clientPackApi.getState('a'), error => error.code === 'CLIENT_PACK_SERVER_CHANGED' &&
    /Use Modpack Verify and Repair/.test(error.message) && !error.message.includes('secret'));
  assert.equal(allowsLegacyClient({ status: 'error', code: 'CLIENT_PACK_SERVER_CHANGED' }), false);
});

test('invalid installation review reaches the renderer with review-again guidance and no retry', async t => {
  const { clientPackApi } = await modulePromise;
  const { EventEmitter } = require('node:events');
  const { createClientPackHandlers } = require('../../electron/ipc/client-pack-handlers.cjs');
  const unexpected = async () => assert.fail('A missing review must not dispatch a service operation');
  const boundary = createClientPackHandlers({
    clientPackService: Object.fromEntries(['getState','preview','install','cancel','verify','recover'].map(name => [name, unexpected])),
    companionService: Object.fromEntries(['getStatus','listAssets','inspect','accept'].map(name => [name, unexpected]))
  });
  t.after(() => boundary.dispose());
  const owner = new EventEmitter(); Object.assign(owner, { id: 1, send() {}, isDestroyed: () => false });
  const calls = [], listeners = new Set(); let added = 0, removed = 0;
  global.window = { electron: {
    on: (_, callback) => { added++; listeners.add(callback); },
    removeListener: (_, callback) => { assert.equal(listeners.delete(callback), true); removed++; },
    invoke(channel, input) { calls.push(channel); return boundary.handlers[channel]({ sender: owner }, input); }
  } };
  await assert.rejects(clientPackApi.install({ clientId: 'qa', planId: 'missing', conflictChoices: {} },
    { onProgress: () => assert.fail('A refused capability must not publish progress') }), error => {
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.match(error.message, /review is no longer valid.*Review matching pack again/i);
    assert.doesNotMatch(error.message, /expired|server.*changed|files.*changed/i);
    return true;
  });
  assert.deepEqual(calls, ['client-packs:install']);
  assert.deepEqual([added, removed], [1, 1]);
  assert.equal(listeners.size, 0);
});
test('missing published dependency gives file-specific guidance without trusting remote error text', async () => {
  const { ClientPackApiError } = await modulePromise;
  const error = new ClientPackApiError({ code: 'ARTIFACT_UNAVAILABLE', message: 'PRIVATE token=secret',
    details: { fileName: 'midnight-ae2-30e7823.zip', httpStatus: '404', url: 'https://x/?token=secret' } });
  assert.match(error.message, /midnight-ae2-30e7823\.zip/);
  assert.match(error.message, /HTTP 404/);
  assert.match(error.message, /server owner/);
  assert.doesNotMatch(error.message, /PRIVATE|secret|https:/);
  for (const fileName of ['C:\\secret', '../secret', 'https://x/?token=secret', 'secret\nheader']) {
    const invalid = new ClientPackApiError({ code: 'ARTIFACT_UNAVAILABLE', message: 'PRIVATE', details: { fileName, httpStatus: 'bad' } });
    assert.doesNotMatch(invalid.message, /secret|PRIVATE|HTTP bad/);
    assert.match(invalid.message, /published download/);
  }
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
