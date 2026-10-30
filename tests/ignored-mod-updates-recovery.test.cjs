const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

// End to end: the real renderer store drives the real get/save handlers over the
// real mod-file-manager against temporary server folders. Only the handler
// dependencies unrelated to ignored updates are stubbed.

const IGNORED_UPDATES_LOCAL_KEY = 'minecraft-core:ignored-updates';
const IGNORED_UPDATES_LOAD_ERROR = 'Ignored update preferences could not be loaded. Your changes will be kept until the server can be read safely.';
const TORN = '{"Old.jar":{"ids":["old-2"],"vers":["2.0"]},"Other.jar":{"ids":["ot';
const RESTORED = JSON.stringify({ 'A.jar': { ids: ['a-2'], vers: ['2.0'] } }, null, 2);
const realSetTimeout = globalThis.setTimeout;
const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));

function fallbackKeyFor(serverPath) {
  return `${IGNORED_UPDATES_LOCAL_KEY}:${encodeURIComponent(serverPath.trim().toLowerCase())}`;
}

function pendingKeyFor(serverPath) {
  return `${IGNORED_UPDATES_LOCAL_KEY}:pending:${encodeURIComponent(serverPath.trim().toLowerCase())}`;
}

function ignoredFile(serverPath) {
  return path.join(serverPath, 'minecraft-core-configs', 'ignored-mod-updates.json');
}

function readIgnoredFile(serverPath) {
  return JSON.parse(fs.readFileSync(ignoredFile(serverPath), 'utf8'));
}

function setAsideEntries(serverPath) {
  return fs.readdirSync(path.dirname(ignoredFile(serverPath)))
    .filter(name => name.startsWith('ignored-mod-updates.json.unreadable-'));
}

function preserveRendererGlobals(t) {
  const saved = ['window', 'localStorage', 'setTimeout'].map(key => [key, Object.hasOwn(globalThis, key), globalThis[key]]);
  t.after(() => {
    for (const [key, had, value] of saved) {
      if (had) globalThis[key] = value;
      else delete globalThis[key];
    }
  });
}

function installRendererGlobals({ invoke, storage, currentPath }) {
  let activePath = currentPath;
  storage.set('currentInstance', JSON.stringify({ type: 'server', path: activePath }));
  globalThis.localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    removeItem(key) { storage.delete(key); },
    setItem(key, value) { storage.set(key, String(value)); }
  };
  globalThis.window = {
    serverPath: {
      get: () => activePath,
      set(nextPath) { activePath = nextPath; }
    },
    electron: { invoke }
  };
}

async function importFreshModStore(label) {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/stores/modStore.js'));
  moduleUrl.searchParams.set('ignored-updates-recovery', `${label}-${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

function currentErrorMessage(modStore) {
  let value;
  modStore.errorMessage.subscribe(next => { value = next; })();
  return value;
}

// Routes the renderer's timers through a set the test can clear, as if the
// window closed while a debounced save was still pending.
function trackRendererTimers() {
  const live = new Set();
  globalThis.setTimeout = (callback, ms, ...args) => {
    const handle = realSetTimeout(() => {
      live.delete(handle);
      callback(...args);
    }, ms);
    live.add(handle);
    return handle;
  };
  return {
    closeRenderer() {
      for (const handle of live) clearTimeout(handle);
      live.clear();
    }
  };
}

function loadRealIgnoredUpdateHandlers(userDataPath) {
  const originalLoad = Module._load;
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  Module._load = function loadIgnoredUpdatesRecoveryFixture(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userDataPath } };
    if (request === '../../services/mod-api-service.cjs') return {};
    if (request === '../mod-utils/mod-installation-service.cjs') return {};
    if (request === '../../services/download-manager.cjs') return {};
    if (request === '../../utils/app-store.cjs') return { get: () => [] };
    if (request === './mod-handler-utils.cjs') return {};
    if (request === '../logger-handlers.cjs') return { getLoggerHandlers: () => logger };
    if (request === '../error-monitoring-handlers.cjs') return { serverErrorMonitor: {} };
    if (request === '../../utils/server-loader.cjs') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  const handlersPath = require.resolve('../electron/ipc/mod-handlers/server-mod-handlers.cjs');
  const managerPath = require.resolve('../electron/ipc/mod-utils/mod-file-manager.cjs');
  delete require.cache[handlersPath];
  delete require.cache[managerPath];
  try {
    return require(handlersPath).createServerModHandlers(null);
  } finally {
    Module._load = originalLoad;
  }
}

// The main-process side of both ignored-update channels. `running` refuses
// saves the way the server mutation coordinator does while the server runs;
// `afterRead` runs once right after the next read has finished.
function createMainProcess(root) {
  const handlers = loadRealIgnoredUpdateHandlers(path.join(root, 'user-data'));
  const state = { running: false, afterRead: null };
  const invoke = async (channel, ...args) => {
    if (channel === 'get-ignored-mod-updates') {
      const result = await handlers[channel]({ sender: { id: 1 } }, ...args);
      const afterRead = state.afterRead;
      state.afterRead = null;
      if (afterRead) afterRead();
      return result;
    }
    if (channel === 'save-ignored-mod-updates') {
      if (state.running) {
        throw Object.assign(
          new Error('The server must be stopped before this operation can continue'),
          { code: 'SERVER_RUNNING' }
        );
      }
      return handlers[channel]({ sender: { id: 1 } }, ...args);
    }
    return { success: true };
  };
  return { invoke, state };
}

function createServers(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-core-ignored-recovery-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const alpha = path.join(root, 'alpha');
  fs.mkdirSync(path.dirname(ignoredFile(alpha)), { recursive: true });
  return { root, alpha, storage: new Map(), main: createMainProcess(root) };
}

async function startSession(env, label) {
  installRendererGlobals({ invoke: env.main.invoke, storage: env.storage, currentPath: env.alpha });
  const modStore = await importFreshModStore(label);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(env.alpha), true);
  return modStore;
}

async function settle(modStore, serverPath) {
  await sleep(350);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(serverPath), true);
}

test('R6: a torn ignored-update file no longer blocks; its bytes are set aside and new choices persist', async (t) => {
  preserveRendererGlobals(t);
  const env = createServers(t, 'torn');
  fs.writeFileSync(ignoredFile(env.alpha), TORN);

  const modStore = await startSession(env, 'torn');

  assert.notEqual(currentErrorMessage(modStore), IGNORED_UPDATES_LOAD_ERROR);
  assert.equal(fs.readFileSync(ignoredFile(env.alpha), 'utf8'), '{}');
  const setAside = setAsideEntries(env.alpha);
  assert.equal(setAside.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(ignoredFile(env.alpha)), setAside[0]), 'utf8'), TORN);

  modStore.ignoreUpdate('X.jar', 'x-2', null);
  await settle(modStore, env.alpha);
  assert.deepEqual(readIgnoredFile(env.alpha), { 'X.jar': { ids: ['x-2'], vers: [] } });
  assert.equal(env.storage.has(fallbackKeyFor(env.alpha)), false);
  assert.equal(env.storage.has(pendingKeyFor(env.alpha)), false);
});

test('R6: a BOM-prefixed hand-edited file keeps its ignored updates', async (t) => {
  preserveRendererGlobals(t);
  const env = createServers(t, 'bom');
  const content = `${String.fromCharCode(0xFEFF)}{"Kept.jar":{"ids":["kept-2"],"vers":[]}}`;
  fs.writeFileSync(ignoredFile(env.alpha), content);

  const modStore = await startSession(env, 'bom');

  assert.notEqual(currentErrorMessage(modStore), IGNORED_UPDATES_LOAD_ERROR);
  assert.equal(modStore.isUpdateIgnored('Kept.jar', 'kept-2', null), true);
  assert.equal(fs.readFileSync(ignoredFile(env.alpha), 'utf8'), content);
});

test('ATTACK-1: a refused repair leaves no fallback that could overwrite a file restored later', async (t) => {
  preserveRendererGlobals(t);
  const env = createServers(t, 'refused-repair');
  fs.writeFileSync(ignoredFile(env.alpha), TORN);

  // The server is selected while it runs, so the repair save is refused.
  env.main.state.running = true;
  await startSession(env, 'refused-repair-1');
  assert.equal(env.storage.has(fallbackKeyFor(env.alpha)), false);
  assert.equal(fs.readFileSync(ignoredFile(env.alpha), 'utf8'), TORN);

  // The server stops and a backup holding a valid file is restored.
  env.main.state.running = false;
  fs.writeFileSync(ignoredFile(env.alpha), RESTORED);

  const restarted = await startSession(env, 'refused-repair-2');
  assert.equal(restarted.isUpdateIgnored('A.jar', 'a-2', null), true);
  assert.equal(fs.readFileSync(ignoredFile(env.alpha), 'utf8'), RESTORED);
});

test('ATTACK-2: an ignore made while the server runs on an unreadable base survives a restore with the restored entries', async (t) => {
  preserveRendererGlobals(t);
  const env = createServers(t, 'refused-edit');
  fs.writeFileSync(ignoredFile(env.alpha), TORN);

  env.main.state.running = true;
  const first = await startSession(env, 'refused-edit-1');
  first.ignoreUpdate('Y.jar', 'y-2', null);
  await settle(first, env.alpha);
  assert.equal(first.isUpdateIgnored('Y.jar', 'y-2', null), true);
  assert.equal(env.storage.has(fallbackKeyFor(env.alpha)), false);

  env.main.state.running = false;
  fs.writeFileSync(ignoredFile(env.alpha), RESTORED);

  const restarted = await startSession(env, 'refused-edit-2');
  assert.deepEqual(readIgnoredFile(env.alpha), {
    'A.jar': { ids: ['a-2'], vers: ['2.0'] },
    'Y.jar': { ids: ['y-2'], vers: [] }
  });
  assert.equal(restarted.isUpdateIgnored('A.jar', 'a-2', null), true);
  assert.equal(restarted.isUpdateIgnored('Y.jar', 'y-2', null), true);
  assert.equal(env.storage.has(pendingKeyFor(env.alpha)), false);
});

test('ATTACK-3: a file that is torn when read but valid by the repair keeps its valid bytes', async (t) => {
  preserveRendererGlobals(t);
  const env = createServers(t, 'transient');
  fs.writeFileSync(ignoredFile(env.alpha), TORN);
  // An in-place writer (sync client, editor or restore) finishes right after the read.
  env.main.state.afterRead = () => fs.writeFileSync(ignoredFile(env.alpha), RESTORED);

  const modStore = await startSession(env, 'transient');

  assert.equal(fs.readFileSync(ignoredFile(env.alpha), 'utf8'), RESTORED);
  assert.deepEqual(setAsideEntries(env.alpha), []);
  assert.equal(env.storage.has(fallbackKeyFor(env.alpha)), false);

  // The next selection of the server reads the valid file.
  await modStore.activateIgnoredUpdatesServerPath('');
  await modStore.activateIgnoredUpdatesServerPath(env.alpha);
  assert.equal(modStore.isUpdateIgnored('A.jar', 'a-2', null), true);
  assert.equal(fs.readFileSync(ignoredFile(env.alpha), 'utf8'), RESTORED);
});

test('ATTACK-4: a fast close, then a moved-away folder, keeps both the folder entries and the journaled edit', async (t) => {
  preserveRendererGlobals(t);
  const env = createServers(t, 'moved-folder');
  const away = path.join(env.root, 'alpha-away');
  fs.writeFileSync(ignoredFile(env.alpha), JSON.stringify({ 'Base.jar': { ids: ['base-2'], vers: ['2.0'] } }, null, 2));
  const timers = trackRendererTimers();

  // Session 1: ignore X, then close the window inside the 250 ms debounce.
  const first = await startSession(env, 'moved-folder-1');
  first.ignoreUpdate('X.jar', 'x-2', null);
  timers.closeRenderer();

  // The folder is moved away before the next start.
  fs.renameSync(env.alpha, away);
  const second = await startSession(env, 'moved-folder-2');
  await sleep(50);
  assert.equal(fs.existsSync(env.alpha), false);
  assert.equal(second.isUpdateIgnored('X.jar', 'x-2', null), true);
  assert.equal(env.storage.has(fallbackKeyFor(env.alpha)), false);

  // The folder comes back with its own entries, and the app starts again.
  fs.renameSync(away, env.alpha);
  const third = await startSession(env, 'moved-folder-3');
  assert.deepEqual(readIgnoredFile(env.alpha), {
    'Base.jar': { ids: ['base-2'], vers: ['2.0'] },
    'X.jar': { ids: ['x-2'], vers: [] }
  });
  assert.equal(third.isUpdateIgnored('Base.jar', 'base-2', null), true);
  assert.equal(env.storage.has(pendingKeyFor(env.alpha)), false);
  assert.equal(env.storage.has(fallbackKeyFor(env.alpha)), false);
});

test('R16: choices kept for a server whose folder is gone never recreate it and are applied when it returns', async (t) => {
  preserveRendererGlobals(t);
  const env = createServers(t, 'gone-folder');
  const away = path.join(env.root, 'alpha-away');
  fs.writeFileSync(ignoredFile(env.alpha), JSON.stringify({ 'Base.jar': { ids: ['base-2'], vers: [] } }, null, 2));

  // Session 1: an ignore made while the server runs is kept locally.
  env.main.state.running = true;
  const first = await startSession(env, 'gone-folder-1');
  first.ignoreUpdate('A.jar', 'a-2', null);
  await settle(first, env.alpha);
  assert.deepEqual(JSON.parse(env.storage.get(fallbackKeyFor(env.alpha))), {
    'A.jar': { ids: ['a-2'], vers: [] },
    'Base.jar': { ids: ['base-2'], vers: [] }
  });
  env.main.state.running = false;

  // Session 2: the folder is gone. Nothing recreates it, and a new choice is kept.
  fs.renameSync(env.alpha, away);
  const second = await startSession(env, 'gone-folder-2');
  assert.equal(second.isUpdateIgnored('A.jar', 'a-2', null), true);
  second.ignoreUpdate('B.jar', 'b-2', null);
  await settle(second, env.alpha);
  assert.equal(fs.existsSync(env.alpha), false);
  assert.equal(second.isUpdateIgnored('B.jar', 'b-2', null), true);

  // Session 3: the folder is back with its own entry.
  fs.renameSync(away, env.alpha);
  const third = await startSession(env, 'gone-folder-3');
  assert.deepEqual(readIgnoredFile(env.alpha), {
    'A.jar': { ids: ['a-2'], vers: [] },
    'B.jar': { ids: ['b-2'], vers: [] },
    'Base.jar': { ids: ['base-2'], vers: [] }
  });
  assert.equal(third.isUpdateIgnored('Base.jar', 'base-2', null), true);
  assert.equal(env.storage.has(fallbackKeyFor(env.alpha)), false);
  assert.equal(env.storage.has(pendingKeyFor(env.alpha)), false);
});
