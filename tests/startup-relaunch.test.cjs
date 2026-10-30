const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const START_MINIMIZED = '--start-minimized';
const INSTALLED_EXE = 'C:\\Users\\fixture\\AppData\\Local\\Programs\\Minecraft Core\\Minecraft Core.exe';
const DEVELOPMENT_ELECTRON = 'C:\\dev\\minecraft-core\\node_modules\\electron\\dist\\electron.exe';

// The real setupIpcHandlers and its startup channels. Every handler module,
// the app store, the mutation policy and the server manager are stubbed, so
// no app profile is read or written.
function loadIpcSetup(t, { serverStates = [], legacyServerState = null, activeWork = [] } = {}) {
  const modulePath = path.resolve(__dirname, '../electron/ipc-handlers.cjs');
  const originalLoad = Module._load;
  const handlers = new Map();
  const calls = { relaunch: [], quit: 0 };
  const app = {
    relaunch(...args) { calls.relaunch.push(args); },
    quit() { calls.quit += 1; }
  };
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); }
  };
  const handlerModule = new Proxy({}, {
    get(_target, key) {
      if (key === 'getLoggerHandlers') return () => ({ info() {} });
      return () => ({});
    }
  });
  Module._load = function loadRelaunchFixture(request, parent, isMain) {
    if (parent?.filename === modulePath) {
      if (request === 'electron') return { ipcMain, app, shell: {} };
      if (request === './utils/app-store.cjs') return { get: () => null };
      if (request === './utils/ipc-helpers.cjs') return { registeredHandlers: new Set(), registerIpcHandlers() {} };
      if (request === './services/server-mutation-policy.cjs') {
        return { createServerMutationPolicy: () => ({ wrapHandler: (_channel, handler) => handler, wrapHandlers: value => value }) };
      }
      if (request === './services/auto-restart.cjs') return { setAutoRestartOptions() {}, getAutoRestartState: () => ({}) };
      if (request === './services/server-manager.cjs') {
        return { getAllServerStates: () => serverStates, getServerState: () => legacyServerState };
      }
      if (request.startsWith('./ipc/')) return handlerModule;
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  t.after(() => {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  });
  const { setupIpcHandlers } = require(modulePath);
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.isDestroyed = () => false;
  setupIpcHandlers(win, {
    store: { get: () => null },
    startup: {
      getHealth: () => ({ status: 'degraded', modpackServices: 'unavailable' }),
      listActiveWork: () => activeWork
    }
  });
  const invoke = channel => {
    const handler = handlers.get(channel);
    if (!handler) return Promise.reject(new Error(`No handler registered for '${channel}'`));
    return Promise.resolve(handler({ sender: {} }));
  };
  return { calls, invoke };
}

function useArgv(t, argv) {
  const original = process.argv;
  process.argv = [...argv];
  t.after(() => { process.argv = original; });
}

test('Restart after a start-minimized login relaunches without --start-minimized, so the window comes back', async t => {
  useArgv(t, [INSTALLED_EXE, START_MINIMIZED]);
  const ipc = loadIpcSetup(t);

  assert.deepEqual(await ipc.invoke('startup:relaunch'), { success: true });

  assert.deepEqual(ipc.calls.relaunch, [[{ args: [] }]]);
  assert.equal(ipc.calls.quit, 1);
  assert.deepEqual(process.argv, [INSTALLED_EXE, START_MINIMIZED], 'the running process keeps its own arguments');
});

test('Restart keeps every other argument, including the app path of an unpackaged run', async t => {
  useArgv(t, [DEVELOPMENT_ELECTRON, '.', START_MINIMIZED, '--user-data-dir=C:\\qa\\profile', START_MINIMIZED]);
  const ipc = loadIpcSetup(t);

  assert.deepEqual(await ipc.invoke('startup:relaunch'), { success: true });

  assert.deepEqual(ipc.calls.relaunch, [[{ args: ['.', '--user-data-dir=C:\\qa\\profile'] }]]);
  assert.equal(ipc.calls.quit, 1);
});

test('Restart of an ordinary start relaunches with the same arguments', async t => {
  useArgv(t, [INSTALLED_EXE]);
  const ipc = loadIpcSetup(t);

  assert.deepEqual(await ipc.invoke('startup:relaunch'), { success: true });

  assert.deepEqual(ipc.calls.relaunch, [[{ args: [] }]]);
  assert.equal(ipc.calls.quit, 1);
});

test('Restart is still refused while a server runs, and nothing relaunches or quits', async t => {
  useArgv(t, [INSTALLED_EXE, START_MINIMIZED]);
  for (const servers of [
    { serverStates: [{ isRunning: false }, { isRunning: true, serverPath: 'C:\\servers\\survival' }] },
    { serverStates: [], legacyServerState: { isRunning: true } }
  ]) {
    const ipc = loadIpcSetup(t, servers);

    const result = await ipc.invoke('startup:relaunch');

    assert.deepEqual(result, { success: false, error: 'Stop your running servers, then restart Minecraft Core.' });
    assert.deepEqual(ipc.calls.relaunch, []);
    assert.equal(ipc.calls.quit, 0);
  }
});

test('Restart is still refused while modpack or server work is active, and nothing relaunches or quits', async t => {
  useArgv(t, [INSTALLED_EXE, START_MINIMIZED]);
  const ipc = loadIpcSetup(t, { serverStates: [{ isRunning: false }], activeWork: ['modpack-install-1'] });

  const result = await ipc.invoke('startup:relaunch');

  assert.deepEqual(result, {
    success: false,
    error: 'Minecraft Core is still finishing a change. Wait for it to finish, then restart.'
  });
  assert.deepEqual(ipc.calls.relaunch, []);
  assert.equal(ipc.calls.quit, 0);
});
