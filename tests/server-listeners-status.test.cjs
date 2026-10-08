const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('an explicit stopping status survives isRunning and queued activity metrics while close is pending', async (t) => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const listeners = new Map();
  const localStorage = { getItem() { return null; } };
  globalThis.localStorage = localStorage;
  globalThis.window = {
    localStorage,
    electron: {
      async invoke() { return { success: true }; },
      on(channel, listener) { listeners.set(channel, listener); },
      removeAllListeners(channel) { listeners.delete(channel); }
    }
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  });

  const listenersUrl = pathToFileURL(path.resolve(__dirname, '../src/modules/serverListeners.js'));
  listenersUrl.searchParams.set('close-barrier-status', `${Date.now()}-${Math.random()}`);
  const [{ setupIpcListeners }, { serverState }] = await Promise.all([
    import(listenersUrl.href),
    import(pathToFileURL(path.resolve(__dirname, '../src/stores/serverState.js')).href)
  ]);
  let currentState;
  const unsubscribe = serverState.subscribe(value => { currentState = value; });
  t.after(unsubscribe);

  setupIpcListeners();
  listeners.get('server-status')({
    instanceId: 'close-pending-server',
    isRunning: true,
    status: 'stopping'
  });

  assert.equal(currentState.status, 'Stopping');
  listeners.get('metrics-update')({
    cpuPct: 8,
    maxRamMB: 4096,
    memUsedMB: 512,
    uptime: '0h 2m 3s'
  });
  assert.equal(currentState.status, 'Stopping');
});
