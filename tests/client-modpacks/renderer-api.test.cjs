const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const modulePromise = import('../../src/utils/clientPacks/clientPackApi.js');
const ROOT = path.resolve(__dirname, '../..');
const source = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const quoted = text => [...text.matchAll(/'([^']+)'/gu)].map(match => match[1]);
const panelStatuses = () => quoted(/const statuses = new Set\(\[([^\]]*)\]\);/u.exec(source('src/components/client/ClientModpackPanel.svelte'))[1]);
for (const method of ['getState', 'verify']) test(`read-only check renderer ${method} correlates progress and cancellation settlement`, async () => {
  const { clientPackApi } = await modulePromise; const controller = new AbortController();
  const calls = []; const seen = []; let listener, resolveWork, resolveCancel, settled = false;
  global.window = { electron: { on: (_, fn) => { listener = fn; }, removeListener: () => { listener = null; }, invoke: (channel, input) => {
    calls.push({ channel, input });
    if (channel === 'client-packs:cancel') return new Promise(resolve => { resolveCancel = resolve; });
    return new Promise(resolve => { resolveWork = resolve; });
  } } };
  const work = clientPackApi[method]('a', { signal: controller.signal, onProgress: event => seen.push(event) }).finally(() => { settled = true; });
  work.catch(() => {});
  try {
    assert.equal(typeof calls[0].input.requestId, 'string');
    listener({ ...calls[0].input, phase: 'checking-client-files', completedItems: '64' });
    assert.equal(seen[0].completedItems, '64');
    controller.abort(); assert.deepEqual(calls[1].input, { requestId: calls[0].input.requestId });
    resolveWork({ ok: false, error: { code: 'CANCELLED' } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    resolveCancel({ ok: true, value: { cancelled: true } });
    await assert.rejects(work, { code: 'CANCELLED' }); assert.equal(listener, null);
  } finally { resolveWork?.({ ok: false, error: { code: 'CANCELLED' } }); resolveCancel?.({ ok: true, value: { cancelled: true } }); await work.catch(() => {}); }
});

test('read-only check busy refusal gives an actionable retry without implying readiness', async () => {
  const { clientPackApi } = await modulePromise;
  global.window = { electron: { invoke: async () => ({ ok: false, error: { code: 'OPERATION_IN_PROGRESS' } }) } };
  await assert.rejects(clientPackApi.getState('a'), error => error.code === 'OPERATION_IN_PROGRESS' && error.retryable && /Refresh requirement/.test(error.message));
});

test('read-only check overlap guidance preserves the actual IPC running-client refusal', async () => {
  const { clientPackApi } = await modulePromise;
  const { createClientPackHandlers } = require('../../electron/ipc/client-pack-handlers.cjs');
  const failure = async () => { throw Object.assign(new Error('private'), { code: 'CLIENT_RUNNING' }); };
  const boundary = createClientPackHandlers({ clientPackService: Object.fromEntries(['getState','verify','preview','install','recover','cancel'].map(name => [name, failure])),
    companionService: Object.fromEntries(['getStatus','listAssets','inspect','accept'].map(name => [name, failure])) });
  const sender = new (require('node:events').EventEmitter)(); sender.id = 1; sender.isDestroyed = () => false; sender.send = () => {};
  global.window = { electron: { invoke: (channel, input) => boundary.handlers[channel]({ sender }, input) } };
  try { await assert.rejects(clientPackApi.getState('a'), error => error.code === 'OPERATION_IN_PROGRESS' && /Close the running Minecraft client/.test(error.message) && !/Refresh requirement/.test(error.message)); }
  finally { await boundary.dispose(); }
});
test('client requests unwrap failures and never authorize legacy on unknown states', async () => {
  const { clientPackApi, allowsLegacyClient } = await modulePromise;
  global.window = { electron: { invoke: async () => ({ ok: false, error: { code: 'CLIENT_PACK_UNAVAILABLE', message: 'Unavailable' } }) } };
  await assert.rejects(clientPackApi.getState('a'), { code: 'CLIENT_PACK_UNAVAILABLE' });
  for (const state of [null, {}, { status: 'unpaired' }, { status: 'future-state' }]) assert.equal(allowsLegacyClient(state), false);
  assert.equal(allowsLegacyClient({ status: 'unmanaged' }), true);
});

test('own client content stays available while an offline host leaves the requirement unchecked, never for managed or unknown states', async () => {
  const { allowsLocalClientContent, allowsLegacyClient } = await modulePromise;
  for (const status of ['unmanaged', 'requirement-unavailable']) {
    assert.equal(allowsLocalClientContent({ clientId: 'a', status, verified: false, descriptor: null }), true, status);
  }
  for (const state of [null, undefined, {}, 'unmanaged', { status: 'unpaired' }, { status: 'install-required' }, { status: 'update-required' },
    { status: 'modified' }, { status: 'ready', verified: true }, { status: 'runtime-incomplete' }, { status: 'recovery-required' },
    { status: 'unavailable' }, { status: 'loading' }, { status: 'future-state' }, { status: 'error', code: 'CLIENT_PACK_UNAVAILABLE' }]) {
    assert.equal(allowsLocalClientContent(state), false, JSON.stringify(state));
  }
  // Syncing from the host and launching keep the legacy gate: an unchecked requirement never authorizes them.
  assert.equal(allowsLegacyClient({ status: 'requirement-unavailable' }), false);
  for (const status of ['unpaired', 'install-required', 'loading', 'future-state']) assert.equal(allowsLegacyClient({ status }), false);
  assert.equal(allowsLegacyClient({ status: 'unmanaged' }), true);
});

test('every client pack status list accepts requirement-unavailable: the panel, the IPC boundary and the TS type', async t => {
  const { clientPackApi } = await modulePromise;
  const { createClientPackHandlers } = require('../../electron/ipc/client-pack-handlers.cjs');
  const panel = panelStatuses();
  const typed = quoted(/export type ClientPackStatus = ([^;]+);/u.exec(source('src/types/client-modpack.d.ts'))[1]);
  assert.equal(panel.includes('requirement-unavailable'), true, 'the panel must not map the status to unavailable');
  assert.deepEqual([...panel].sort(), [...typed].sort());
  let state;
  const unexpected = name => async () => assert.fail(`A status read must not call ${name}`);
  const boundary = createClientPackHandlers({
    clientPackService: { ...Object.fromEntries(['preview', 'install', 'cancel', 'recover'].map(name => [name, unexpected(name)])), getState: async () => state, verify: async () => state },
    companionService: Object.fromEntries(['getStatus', 'listAssets', 'inspect', 'accept'].map(name => [name, unexpected(name)]))
  });
  t.after(() => boundary.dispose());
  const sender = new EventEmitter(); Object.assign(sender, { id: 1, send() {}, isDestroyed: () => false });
  global.window = { electron: { on() {}, removeListener() {}, invoke: (channel, input) => boundary.handlers[channel]({ sender }, input) } };
  for (const status of typed) {
    state = { clientId: 'a', status, verified: false, descriptor: null };
    assert.deepEqual(await clientPackApi.getState('a'), state, status);
    assert.deepEqual(await clientPackApi.verify('a'), state, status);
  }
  state = { clientId: 'a', status: 'requirement-unknown', verified: false, descriptor: null };
  await assert.rejects(clientPackApi.getState('a'), { code: 'INVALID_REQUEST' });
});

test('the matching pack panel explains an unchecked requirement honestly and keeps Refresh requirement', () => {
  const panel = source('src/components/client/ClientModpackPanel.svelte');
  const labels = vm.runInNewContext(`(${/const labels = (\{[\s\S]*?\});/u.exec(panel)[1]})`);
  // Every status the panel shows has its own heading instead of the generic 'Matching pack unavailable'.
  for (const status of panelStatuses().filter(status => status !== 'unmanaged')) assert.equal(typeof labels[status], 'string', status);
  assert.equal(labels['requirement-unavailable'], 'Matching pack requirement not checked');
  assert.match(panel, /\{:else if state\?\.status === 'requirement-unavailable'\}\s*<p>The server’s matching pack requirement could not be checked \(the server may be offline\)\. Your own client content stays available; syncing from the server and launching wait until it can be checked\.<\/p>/u);
  const footer = /<footer>([\s\S]*?)<\/footer>/u.exec(panel)[1];
  assert.equal(footer.includes('>Refresh requirement</button>'), true, 'Refresh requirement stays in the footer');
  const beforeRefresh = footer.slice(0, footer.indexOf('>Refresh requirement</button>'));
  assert.equal(beforeRefresh.split('{#if ').length, beforeRefresh.split('{/if}').length, 'Refresh requirement is not tied to a status');
});

test('the Mods tab opens for own client content while host sync and launch keep the legacy gate', () => {
  const ui = source('src/components/client/ClientInterface.svelte');
  assert.match(ui, /function legacyContentAllowed\(\) \{\s*return activeClientKey === instanceKey\s*&& packState\?\.clientId === instance\?\.id && allowsLegacyClient\(packState\);\s*\}/u);
  // The gate follows the settled pack state for the current instance and keeps its answer while a check runs.
  assert.match(ui, /let modsTabOpen = false;\s*\$: if \(packState\?\.status !== 'loading'\) \{\s*modsTabOpen = activeClientKey === instanceKey\s*&& packState\?\.clientId === instance\?\.id && allowsLocalClientContent\(packState\);\s*\}/u);
  assert.match(ui, /\{:else if \$clientState\.activeTab === 'mods'\}\s*\{#if modsTabOpen\}\s*<ModsTab\b/u);
  // Only the Mods tab uses the local gate; every host-sync flow and launch still call legacyContentAllowed().
  assert.equal(ui.match(/\bmodsTabOpen\b/gu).length, 3);
  assert.equal(ui.match(/\ballowsLocalClientContent\(/gu).length, 1);
});

test('client components compile without warnings and a client that opens on the Mods tab follows the settled check', async () => {
  const { compile } = await import('svelte/compiler');
  for (const file of ['src/components/client/ClientInterface.svelte', 'src/components/client/ClientModpackPanel.svelte']) {
    const { js, warnings } = compile(source(file), { filename: path.join(ROOT, file), generate: 'client', dev: false });
    assert.deepEqual(warnings.map(warning => warning.code), [], file);
    if (!file.endsWith('ClientInterface.svelte')) continue;
    // Legacy-mode Svelte evaluates a function called from the template only when its block is created, so a
    // gate written as {#if fn()} would keep the answer from before the check settled (the A37 placeholder).
    assert.doesNotMatch(js.code, /\$\.untrack\(\w*ContentAllowed\)/u);
    assert.equal(js.code.includes('if ($.get(modsTabOpen)) $$render('), true);
  }
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
