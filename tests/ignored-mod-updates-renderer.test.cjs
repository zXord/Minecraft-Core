const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const IGNORED_UPDATES_LOCAL_KEY = 'minecraft-core:ignored-updates';

function installRendererGlobals({
  backend = {},
  legacy = null,
  frozenServerPath = false,
  saveBackend = null,
  storage: suppliedStorage = null,
  currentPath: initialPath = 'C:\\servers\\alpha'
} = {}) {
  const invocations = [];
  const storage = suppliedStorage || new Map();
  let currentPath = initialPath;
  if (legacy !== null) storage.set(IGNORED_UPDATES_LOCAL_KEY, JSON.stringify(legacy));
  storage.set('currentInstance', JSON.stringify({ type: 'server', path: currentPath }));
  globalThis.localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    removeItem(key) { storage.delete(key); },
    setItem(key, value) { storage.set(key, String(value)); }
  };
  const serverPath = {
    get: () => currentPath,
    set(nextPath) {
      currentPath = nextPath;
      storage.set('currentInstance', JSON.stringify({ type: 'server', path: currentPath }));
    }
  };
  if (frozenServerPath) Object.freeze(serverPath);
  globalThis.window = {
    electron: {
      async invoke(channel, ...args) {
        invocations.push([channel, ...args]);
        if (channel === 'get-ignored-mod-updates') {
          const value = await (typeof backend === 'function' ? backend(args[0]) : backend);
          if (value && typeof value === 'object' && typeof value.success === 'boolean') {
            return structuredClone(value);
          }
          const data = value && typeof value === 'object' ? value : {};
          return {
            success: true,
            found: Object.keys(data).length > 0,
            data: structuredClone(data)
          };
        }
        if (channel === 'save-ignored-mod-updates' && typeof saveBackend === 'function') {
          return saveBackend(...args);
        }
        return { success: true, changed: true };
      }
    },
    serverPath
  };
  return {
    invocations,
    storage,
    setCurrentPath(nextPath) {
      currentPath = nextPath;
      storage.set('currentInstance', JSON.stringify({ type: 'server', path: currentPath }));
    }
  };
}

async function importFreshModStore(label) {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/stores/modStore.js'));
  moduleUrl.searchParams.set('ignored-updates-test', `${label}-${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

function saveInvocations(invocations) {
  return invocations.filter(([channel]) => channel === 'save-ignored-mod-updates');
}

const IGNORED_UPDATES_LOAD_ERROR = 'Ignored update preferences could not be loaded. Your changes will be kept until the server can be read safely.';
const ALPHA = 'C:\\servers\\alpha';
const BETA = 'C:\\servers\\beta';
const realSetTimeout = globalThis.setTimeout;
const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));

function fallbackKeyFor(serverPath) {
  return `${IGNORED_UPDATES_LOCAL_KEY}:${encodeURIComponent(serverPath.trim().toLowerCase())}`;
}

function pendingKeyFor(serverPath) {
  return `${IGNORED_UPDATES_LOCAL_KEY}:pending:${encodeURIComponent(serverPath.trim().toLowerCase())}`;
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

function currentErrorMessage(modStore) {
  let value;
  modStore.errorMessage.subscribe(next => { value = next; })();
  return value;
}

// A fake main process whose disk holds one JSON object per server path.
function memoryDisk(initial = {}) {
  const disk = new Map(Object.entries(initial).map(([serverPath, data]) => [serverPath, structuredClone(data)]));
  return {
    disk,
    read(serverPath) {
      return disk.has(serverPath)
        ? { success: true, found: true, data: structuredClone(disk.get(serverPath)) }
        : { success: true, found: false, data: {} };
    },
    async save(serverPath, json) {
      disk.set(serverPath, JSON.parse(json));
      return { success: true, changed: true };
    }
  };
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

function isScopedFallbackKey(key) {
  return key.startsWith(`${IGNORED_UPDATES_LOCAL_KEY}:`) &&
    !key.startsWith(`${IGNORED_UPDATES_LOCAL_KEY}:pending:`) &&
    key !== `${IGNORED_UPDATES_LOCAL_KEY}:legacy-owner`;
}

test('ignored-update hydration does not save unchanged backend state during startup', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const { invocations } = installRendererGlobals({ backend: {} });

  await importFreshModStore('hydrate');
  await new Promise(resolve => setTimeout(resolve, 1_200));

  assert.deepEqual(saveInvocations(invocations), []);
});

test('equivalent empty scoped fallback is cleared without reserving a server save', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const pathKey = 'c:\\servers\\alpha';
  const fallbackKey = `${IGNORED_UPDATES_LOCAL_KEY}:${encodeURIComponent(pathKey)}`;
  const storage = new Map([[fallbackKey, '{}']]);
  const { invocations } = installRendererGlobals({ backend: {}, storage });

  await importFreshModStore('equivalent-empty-scoped-fallback');
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.deepEqual(saveInvocations(invocations), []);
  assert.equal(storage.has(fallbackKey), false);
});

test('nonempty legacy ignored updates migrate once after backend hydration', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const legacy = {
    'Example.jar': { ids: ['version-one'], vers: ['1.0'] }
  };
  const { invocations, storage } = installRendererGlobals({ backend: {}, legacy });

  await importFreshModStore('legacy-migration');
  await new Promise(resolve => setTimeout(resolve, 1_200));

  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 1);
  assert.equal(saves[0][1], 'C:\\servers\\alpha');
  assert.deepEqual(JSON.parse(saves[0][2]), legacy);
  assert.equal(storage.has(IGNORED_UPDATES_LOCAL_KEY), false);
});

test('switching server paths hydrates ignored updates for the newly active server', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const backend = (serverPath) => serverPath.endsWith('alpha')
    ? { 'Alpha.jar': { ids: ['alpha-version'], vers: [] } }
    : { 'Beta.jar': { ids: ['beta-version'], vers: [] } };
  const { invocations } = installRendererGlobals({ backend });

  const modStore = await importFreshModStore('path-switch');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(modStore.isUpdateIgnored('Alpha.jar', 'alpha-version', null), true);

  globalThis.window.serverPath.set('C:\\servers\\beta');
  await modStore.activateIgnoredUpdatesServerPath('C:\\servers\\beta');
  assert.equal(modStore.isUpdateIgnored('Alpha.jar', 'alpha-version', null), false);
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(modStore.isUpdateIgnored('Beta.jar', 'beta-version', null), true);
  assert.deepEqual(
    invocations
      .filter(([channel]) => channel === 'get-ignored-mod-updates')
      .map(([, serverPath]) => serverPath),
    ['C:\\servers\\alpha', 'C:\\servers\\beta']
  );
  assert.deepEqual(saveInvocations(invocations), []);
});

test('an explicit server activation rehydrates through a preload-like frozen bridge', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const backend = (serverPath) => serverPath.endsWith('alpha')
    ? { 'Alpha.jar': { ids: ['alpha-version'], vers: [] } }
    : { 'Beta.jar': { ids: ['beta-version'], vers: [] } };
  const { invocations, setCurrentPath } = installRendererGlobals({ backend, frozenServerPath: true });

  const modStore = await importFreshModStore('frozen-preload-bridge');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(modStore.isUpdateIgnored('Alpha.jar', 'alpha-version', null), true);

  setCurrentPath('C:\\servers\\beta');
  await modStore.activateIgnoredUpdatesServerPath('C:\\servers\\beta');

  assert.equal(modStore.isUpdateIgnored('Alpha.jar', 'alpha-version', null), false);
  assert.equal(modStore.isUpdateIgnored('Beta.jar', 'beta-version', null), true);
  assert.deepEqual(
    invocations
      .filter(([channel]) => channel === 'get-ignored-mod-updates')
      .map(([, serverPath]) => serverPath),
    ['C:\\servers\\alpha', 'C:\\servers\\beta']
  );
  assert.deepEqual(saveInvocations(invocations), []);
});

test('a user ignore made during hydration is merged and persisted instead of overwritten', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  let releaseHydration;
  const hydration = new Promise(resolve => { releaseHydration = resolve; });
  const { invocations } = installRendererGlobals({ backend: hydration });

  const modStore = await importFreshModStore('edit-during-hydration');
  await new Promise(resolve => setTimeout(resolve, 20));
  modStore.ignoreUpdate('User.jar', 'user-version', null);
  releaseHydration({ 'Backend.jar': { ids: ['backend-version'], vers: [] } });
  await new Promise(resolve => setTimeout(resolve, 400));

  assert.equal(modStore.isUpdateIgnored('Backend.jar', 'backend-version', null), true);
  assert.equal(modStore.isUpdateIgnored('User.jar', 'user-version', null), true);
  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0][2]), {
    'Backend.jar': { ids: ['backend-version'], vers: [] },
    'User.jar': { ids: ['user-version'], vers: [] }
  });
});

test('rapid server reactivation reuses in-flight hydration and preserves pending edits', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  let releaseAlpha;
  const alphaHydration = new Promise(resolve => { releaseAlpha = resolve; });
  const { invocations, setCurrentPath } = installRendererGlobals({
    backend: serverPath => serverPath.endsWith('alpha')
      ? alphaHydration
      : { 'Beta.jar': { ids: ['beta-version'], vers: [] } }
  });

  const modStore = await importFreshModStore('rapid-reactivation');
  await new Promise(resolve => setTimeout(resolve, 20));
  modStore.ignoreUpdate('Pending.jar', 'pending-version', null);

  setCurrentPath('C:\\servers\\beta');
  await modStore.activateIgnoredUpdatesServerPath('C:\\servers\\beta');
  assert.equal(modStore.isUpdateIgnored('Pending.jar', 'pending-version', null), false);

  setCurrentPath('C:\\servers\\alpha');
  const alphaActivation = modStore.activateIgnoredUpdatesServerPath('C:\\servers\\alpha');
  assert.equal(modStore.isUpdateIgnored('Pending.jar', 'pending-version', null), true);

  releaseAlpha({ 'Backend.jar': { ids: ['backend-version'], vers: [] } });
  await alphaActivation;
  assert.equal(modStore.isUpdateIgnored('Backend.jar', 'backend-version', null), true);
  assert.equal(modStore.isUpdateIgnored('Pending.jar', 'pending-version', null), true);

  modStore.ignoreUpdate('Later.jar', 'later-version', null);
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.deepEqual(
    invocations
      .filter(([channel]) => channel === 'get-ignored-mod-updates')
      .map(([, serverPath]) => serverPath),
    ['C:\\servers\\alpha', 'C:\\servers\\beta']
  );
  const alphaSaves = saveInvocations(invocations)
    .filter(([, serverPath]) => serverPath.endsWith('alpha'));
  assert.equal(alphaSaves.length, 2);
  assert.deepEqual(JSON.parse(alphaSaves.at(-1)[2]), {
    'Backend.jar': { ids: ['backend-version'], vers: [] },
    'Pending.jar': { ids: ['pending-version'], vers: [] },
    'Later.jar': { ids: ['later-version'], vers: [] }
  });
});

test('edits made after reactivating a hydration that is still saving persist the full union', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  let releaseAlphaHydration;
  const alphaHydration = new Promise(resolve => { releaseAlphaHydration = resolve; });
  let markAlphaSaveStarted;
  const alphaSaveStarted = new Promise(resolve => { markAlphaSaveStarted = resolve; });
  let releaseAlphaSave;
  const alphaSave = new Promise(resolve => { releaseAlphaSave = resolve; });
  let blockedAlphaSave = false;
  const { invocations, setCurrentPath } = installRendererGlobals({
    backend: serverPath => serverPath.endsWith('alpha') ? alphaHydration : {},
    saveBackend: async (serverPath) => {
      if (serverPath.endsWith('alpha') && !blockedAlphaSave) {
        blockedAlphaSave = true;
        markAlphaSaveStarted();
        await alphaSave;
      }
      return { success: true, changed: true };
    }
  });

  const modStore = await importFreshModStore('reactivation-during-save');
  await new Promise(resolve => setTimeout(resolve, 20));
  modStore.ignoreUpdate('Pending.jar', 'pending-version', null);

  setCurrentPath('C:\\servers\\beta');
  await modStore.activateIgnoredUpdatesServerPath('C:\\servers\\beta');
  releaseAlphaHydration({ 'Backend.jar': { ids: ['backend-version'], vers: [] } });
  await alphaSaveStarted;

  setCurrentPath('C:\\servers\\alpha');
  const alphaActivation = modStore.activateIgnoredUpdatesServerPath('C:\\servers\\alpha');
  assert.equal(modStore.isUpdateIgnored('Backend.jar', 'backend-version', null), true);
  assert.equal(modStore.isUpdateIgnored('Pending.jar', 'pending-version', null), true);
  modStore.ignoreUpdate('Later.jar', 'later-version', null);
  await new Promise(resolve => setTimeout(resolve, 300));

  releaseAlphaSave();
  await alphaActivation;
  await new Promise(resolve => setTimeout(resolve, 100));

  const alphaSaves = saveInvocations(invocations)
    .filter(([, serverPath]) => serverPath.endsWith('alpha'));
  assert.equal(alphaSaves.length, 2);
  assert.deepEqual(JSON.parse(alphaSaves.at(-1)[2]), {
    'Backend.jar': { ids: ['backend-version'], vers: [] },
    'Pending.jar': { ids: ['pending-version'], vers: [] },
    'Later.jar': { ids: ['later-version'], vers: [] }
  });
});

test('same-path activation remains pending until its hydration save settles', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const pathKey = 'c:\\servers\\alpha';
  const fallbackKey = `${IGNORED_UPDATES_LOCAL_KEY}:${encodeURIComponent(pathKey)}`;
  const storage = new Map([[fallbackKey, JSON.stringify({
    'Deferred.jar': { ids: ['deferred-version'], vers: [] }
  })]]);
  let signalSaveStarted;
  const saveStarted = new Promise(resolve => { signalSaveStarted = resolve; });
  let releaseSave;
  const blockedSave = new Promise(resolve => { releaseSave = resolve; });
  installRendererGlobals({
    backend: {},
    storage,
    saveBackend: async () => {
      signalSaveStarted();
      await blockedSave;
      return { success: true, changed: true };
    }
  });

  const modStore = await importFreshModStore('same-path-save-boundary');
  await saveStarted;

  let activationSettled = false;
  const activation = modStore.activateIgnoredUpdatesServerPath('C:\\servers\\alpha')
    .then(result => {
      activationSettled = true;
      return result;
    });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(activationSettled, false);
  releaseSave();
  assert.equal(await activation, true);
});

test('a later clear is not undone on restart when its ignore was queued during the hydration save', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });

  const serverPath = 'C:\\servers\\alpha';
  const pathKey = serverPath.toLowerCase();
  const pendingKey = `${IGNORED_UPDATES_LOCAL_KEY}:pending:${encodeURIComponent(pathKey)}`;
  const storage = new Map();
  let backendState = {};
  let releaseHydration;
  const hydration = new Promise(resolve => { releaseHydration = resolve; });
  let signalFirstSaveStarted;
  const firstSaveStarted = new Promise(resolve => { signalFirstSaveStarted = resolve; });
  let releaseFirstSave;
  const blockedFirstSave = new Promise(resolve => { releaseFirstSave = resolve; });
  let saveCount = 0;
  const saveBackend = async (_serverPath, json) => {
    saveCount += 1;
    if (saveCount === 1) {
      signalFirstSaveStarted();
      await blockedFirstSave;
    }
    backendState = JSON.parse(json);
    return { success: true, changed: true };
  };

  installRendererGlobals({ backend: hydration, storage, saveBackend });
  const firstStore = await importFreshModStore('queued-save-journal-ack-write');
  await new Promise(resolve => setTimeout(resolve, 20));
  firstStore.ignoreUpdate('Base.jar', 'base-version', null);
  releaseHydration({});
  await firstSaveStarted;

  const hydrationSettlement = firstStore.activateIgnoredUpdatesServerPath(serverPath);
  firstStore.ignoreUpdate('Reverted.jar', 'reverted-version', null);
  releaseFirstSave();
  assert.equal(await hydrationSettlement, true);
  firstStore.clearIgnoredUpdates('Reverted.jar');
  assert.equal(await firstStore.waitForIgnoredUpdatesPersistence(serverPath), true);
  assert.deepEqual(backendState, {
    'Base.jar': { ids: ['base-version'], vers: [] }
  });

  installRendererGlobals({
    backend: () => backendState,
    storage,
    saveBackend
  });
  const restartedStore = await importFreshModStore('queued-save-journal-ack-restart');
  assert.equal(await restartedStore.waitForIgnoredUpdatesPersistence(serverPath), true);

  assert.equal(restartedStore.isUpdateIgnored('Reverted.jar', 'reverted-version', null), false);
  assert.deepEqual(backendState, {
    'Base.jar': { ids: ['base-version'], vers: [] }
  });
  assert.equal(storage.has(pendingKey), false);
});

test('a failed clear stays ordered after an older pending ignore across restart', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });

  const serverPath = 'C:\\servers\\alpha';
  const pathKey = serverPath.toLowerCase();
  const fallbackKey = `${IGNORED_UPDATES_LOCAL_KEY}:${encodeURIComponent(pathKey)}`;
  const pendingKey = `${IGNORED_UPDATES_LOCAL_KEY}:pending:${encodeURIComponent(pathKey)}`;
  const storage = new Map();
  let releaseHydration;
  const hydration = new Promise(resolve => { releaseHydration = resolve; });
  installRendererGlobals({
    backend: hydration,
    storage,
    saveBackend: async () => ({ success: false, changed: false })
  });
  const firstStore = await importFreshModStore('failed-clear-journal-order-write');
  await new Promise(resolve => setTimeout(resolve, 20));

  firstStore.ignoreUpdate('Reverted.jar', 'reverted-version', null);
  const hydrationSettlement = firstStore.activateIgnoredUpdatesServerPath(serverPath);
  releaseHydration({});
  assert.equal(await hydrationSettlement, true);
  assert.equal(firstStore.isUpdateIgnored('Reverted.jar', 'reverted-version', null), true);

  firstStore.clearIgnoredUpdates('Reverted.jar');
  assert.equal(await firstStore.waitForIgnoredUpdatesPersistence(serverPath), true);
  assert.equal(firstStore.isUpdateIgnored('Reverted.jar', 'reverted-version', null), false);
  assert.deepEqual(JSON.parse(storage.get(fallbackKey)), {});

  let backendState = {};
  installRendererGlobals({
    backend: () => backendState,
    storage,
    saveBackend: async (_savedServerPath, json) => {
      backendState = JSON.parse(json);
      return { success: true, changed: true };
    }
  });
  const restartedStore = await importFreshModStore('failed-clear-journal-order-restart');
  assert.equal(await restartedStore.waitForIgnoredUpdatesPersistence(serverPath), true);

  assert.equal(restartedStore.isUpdateIgnored('Reverted.jar', 'reverted-version', null), false);
  assert.deepEqual(backendState, {});
  assert.equal(storage.has(fallbackKey), false);
  assert.equal(storage.has(pendingKey), false);
});

test('a failed save is isolated to its server and cannot migrate into another server', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const { invocations, storage, setCurrentPath } = installRendererGlobals({
    backend: {},
    saveBackend: async (serverPath) => ({
      success: !serverPath.endsWith('alpha'),
      changed: !serverPath.endsWith('alpha')
    })
  });
  const modStore = await importFreshModStore('server-scoped-fallback');
  await new Promise(resolve => setTimeout(resolve, 100));

  modStore.ignoreUpdate('AlphaOnly.jar', 'alpha-only', null);
  await new Promise(resolve => setTimeout(resolve, 350));
  const scopedFallback = Array.from(storage.entries()).find(([key]) => isScopedFallbackKey(key));
  assert.ok(scopedFallback);
  assert.match(scopedFallback[1], /AlphaOnly\.jar/);
  assert.equal(storage.has(IGNORED_UPDATES_LOCAL_KEY), false);

  setCurrentPath('C:\\servers\\beta');
  await modStore.activateIgnoredUpdatesServerPath('C:\\servers\\beta');
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(modStore.isUpdateIgnored('AlphaOnly.jar', 'alpha-only', null), false);
  assert.equal(
    saveInvocations(invocations).filter(([, serverPath]) => serverPath.endsWith('beta')).length,
    0
  );
  assert.equal(storage.has(scopedFallback[0]), true);
});

test('a server-scoped failed save is restored only when that same server returns', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const storage = new Map();
  installRendererGlobals({
    backend: {},
    storage,
    saveBackend: async () => ({ success: false })
  });
  const firstStore = await importFreshModStore('scoped-fallback-write');
  await new Promise(resolve => setTimeout(resolve, 100));
  firstStore.ignoreUpdate('AlphaOnly.jar', 'alpha-only', null);
  await new Promise(resolve => setTimeout(resolve, 350));
  const fallbackKey = Array.from(storage.keys()).find(isScopedFallbackKey);
  assert.ok(fallbackKey);

  const { invocations } = installRendererGlobals({ backend: {}, storage });
  const restoredStore = await importFreshModStore('scoped-fallback-restore');
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(restoredStore.isUpdateIgnored('AlphaOnly.jar', 'alpha-only', null), true);
  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 1);
  assert.equal(saves[0][1], 'C:\\servers\\alpha');
  assert.match(saves[0][2], /AlphaOnly\.jar/);
  assert.equal(storage.has(fallbackKey), false);
});

test('a failed hydration cannot enable a partial overwrite and a retry rebases pending edits', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  let attempts = 0;
  const { invocations } = installRendererGlobals({
    backend: () => {
      attempts += 1;
      if (attempts === 1) return { success: false, error: 'permission denied' };
      return { success: true, found: true, data: {
        'Backend.jar': { ids: ['backend-version'], vers: [] }
      } };
    }
  });
  const modStore = await importFreshModStore('failed-hydration-retry');
  await new Promise(resolve => setTimeout(resolve, 100));

  modStore.ignoreUpdate('User.jar', 'user-version', null);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(saveInvocations(invocations), []);

  await modStore.activateIgnoredUpdatesServerPath('C:\\servers\\alpha');
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(modStore.isUpdateIgnored('Backend.jar', 'backend-version', null), true);
  assert.equal(modStore.isUpdateIgnored('User.jar', 'user-version', null), true);
  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0][2]), {
    'Backend.jar': { ids: ['backend-version'], vers: [] },
    'User.jar': { ids: ['user-version'], vers: [] }
  });
});

test('failed hydration edits survive restart and remain isolated to their server', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const storage = new Map();
  let alphaAttempts = 0;
  const backend = serverPath => {
    if (serverPath.endsWith('beta')) return {};
    alphaAttempts += 1;
    if (alphaAttempts === 1) return { success: false, error: 'permission denied' };
    return { success: true, found: true, data: {
      'Backend.jar': { ids: ['backend-version'], vers: [] }
    } };
  };
  const firstRenderer = installRendererGlobals({ backend, storage });
  const firstStore = await importFreshModStore('failed-hydration-journal-write');
  await new Promise(resolve => setTimeout(resolve, 100));

  firstStore.ignoreUpdate('AlphaOnly.jar', 'alpha-only', null);
  firstRenderer.setCurrentPath('C:\\servers\\beta');
  await firstStore.activateIgnoredUpdatesServerPath('C:\\servers\\beta');
  assert.equal(firstStore.isUpdateIgnored('AlphaOnly.jar', 'alpha-only', null), false);
  assert.equal(
    saveInvocations(firstRenderer.invocations)
      .filter(([, serverPath]) => serverPath.endsWith('beta'))
      .some(([, , json]) => json.includes('AlphaOnly.jar')),
    false
  );

  const restartedRenderer = installRendererGlobals({
    backend,
    storage,
    currentPath: 'C:\\servers\\beta'
  });
  const restartedStore = await importFreshModStore('failed-hydration-journal-read');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(restartedStore.isUpdateIgnored('AlphaOnly.jar', 'alpha-only', null), false);

  restartedRenderer.setCurrentPath('C:\\servers\\alpha');
  await restartedStore.activateIgnoredUpdatesServerPath('C:\\servers\\alpha');

  assert.equal(restartedStore.isUpdateIgnored('Backend.jar', 'backend-version', null), true);
  assert.equal(restartedStore.isUpdateIgnored('AlphaOnly.jar', 'alpha-only', null), true);
  const alphaSaves = saveInvocations(restartedRenderer.invocations)
    .filter(([, serverPath]) => serverPath.endsWith('alpha'));
  assert.equal(alphaSaves.length, 1);
  assert.deepEqual(JSON.parse(alphaSaves[0][2]), {
    'Backend.jar': { ids: ['backend-version'], vers: [] },
    'AlphaOnly.jar': { ids: ['alpha-only'], vers: [] }
  });
  assert.equal(
    saveInvocations(restartedRenderer.invocations)
      .filter(([, serverPath]) => serverPath.endsWith('beta'))
      .some(([, , json]) => json.includes('AlphaOnly.jar')),
    false
  );
});

test('per-server saves are serialized so an older write cannot finish after a newer snapshot', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  let releaseFirstSave;
  let saveCallCount = 0;
  let finalPersistedJson = '';
  const firstSave = new Promise(resolve => { releaseFirstSave = resolve; });
  const { invocations } = installRendererGlobals({
    backend: {},
    saveBackend: async (_serverPath, json) => {
      saveCallCount += 1;
      if (saveCallCount === 1) await firstSave;
      finalPersistedJson = json;
      return { success: true, changed: true };
    }
  });
  const modStore = await importFreshModStore('serialized-saves');
  await new Promise(resolve => setTimeout(resolve, 100));

  modStore.ignoreUpdate('Old.jar', 'old-version', null);
  await new Promise(resolve => setTimeout(resolve, 300));
  modStore.clearIgnoredUpdates('Old.jar');
  modStore.ignoreUpdate('New.jar', 'new-version', null);
  await new Promise(resolve => setTimeout(resolve, 300));

  assert.equal(saveInvocations(invocations).length, 1);
  releaseFirstSave();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(saveInvocations(invocations).length, 2);
  assert.deepEqual(JSON.parse(finalPersistedJson), {
    'New.jar': { ids: ['new-version'], vers: [] }
  });
});

test('a user ignore action persists once after hydration', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  const { invocations } = installRendererGlobals({ backend: {} });
  const modStore = await importFreshModStore('user-change');
  await new Promise(resolve => setTimeout(resolve, 100));

  modStore.ignoreUpdate('Example.jar', 'version-one', null);
  await new Promise(resolve => setTimeout(resolve, 350));

  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0][2]), {
    'Example.jar': { ids: ['version-one'], vers: [] }
  });
});

test('a stale hydration cannot consume the one-time legacy migration for the active server', async (t) => {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const originalWindow = globalThis.window;
  const hadLocalStorage = Object.hasOwn(globalThis, 'localStorage');
  const originalLocalStorage = globalThis.localStorage;
  t.after(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (hadLocalStorage) globalThis.localStorage = originalLocalStorage;
    else delete globalThis.localStorage;
  });
  let releaseAlpha;
  let releaseBeta;
  const alpha = new Promise(resolve => { releaseAlpha = resolve; });
  const beta = new Promise(resolve => { releaseBeta = resolve; });
  const legacy = { 'Legacy.jar': { ids: ['legacy-version'], vers: [] } };
  const { invocations, storage } = installRendererGlobals({
    backend: serverPath => serverPath.endsWith('alpha') ? alpha : beta,
    legacy
  });

  const modStore = await importFreshModStore('stale-legacy-hydration');
  await new Promise(resolve => setTimeout(resolve, 20));
  globalThis.window.serverPath.set('C:\\servers\\beta');
  void modStore.activateIgnoredUpdatesServerPath('C:\\servers\\beta');
  await new Promise(resolve => setTimeout(resolve, 20));
  releaseAlpha({});
  await new Promise(resolve => setTimeout(resolve, 20));
  releaseBeta({});
  await new Promise(resolve => setTimeout(resolve, 100));

  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 1);
  assert.equal(saves[0][1], 'C:\\servers\\beta');
  assert.deepEqual(JSON.parse(saves[0][2]), legacy);
  assert.equal(storage.has(IGNORED_UPDATES_LOCAL_KEY), false);
});

test('R6: an unreadable ignored-update file is repaired once instead of failing every activation', async (t) => {
  preserveRendererGlobals(t);
  const { invocations, storage } = installRendererGlobals({
    backend: { success: true, found: false, data: {}, unreadable: true }
  });

  const modStore = await importFreshModStore('unreadable-repair');
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  assert.notEqual(currentErrorMessage(modStore), IGNORED_UPDATES_LOAD_ERROR);
  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 1);
  assert.equal(saves[0][1], ALPHA);
  assert.deepEqual(JSON.parse(saves[0][2]), {});
  assert.deepEqual(saves[0][3], { replaceOnlyUnreadable: true });
  assert.equal(storage.has(fallbackKeyFor(ALPHA)), false);
});

test('R15: switching away and back inside the save debounce keeps the edit', async (t) => {
  preserveRendererGlobals(t);
  const memory = memoryDisk({ [ALPHA]: { 'Base.jar': { ids: ['base'], vers: [] } } });
  const { setCurrentPath } = installRendererGlobals({
    backend: serverPath => memory.read(serverPath),
    saveBackend: (serverPath, json) => memory.save(serverPath, json)
  });
  const modStore = await importFreshModStore('switch-back-inside-debounce');
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  modStore.ignoreUpdate('X.jar', 'x-2', null);
  setCurrentPath(BETA);
  await modStore.activateIgnoredUpdatesServerPath(BETA);
  setCurrentPath(ALPHA);
  await modStore.activateIgnoredUpdatesServerPath(ALPHA);
  await sleep(300);

  assert.equal(modStore.isUpdateIgnored('X.jar', 'x-2', null), true);
  modStore.ignoreUpdate('Y.jar', 'y-2', null);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);
  assert.deepEqual(Object.keys(memory.disk.get(ALPHA)).sort(), ['Base.jar', 'X.jar', 'Y.jar']);
});

test('R15: closing the app inside the save debounce does not lose the edit', async (t) => {
  preserveRendererGlobals(t);
  const storage = new Map();
  const memory = memoryDisk({ [ALPHA]: { 'Base.jar': { ids: ['base'], vers: [] } } });
  const timers = trackRendererTimers();
  const rendererOptions = {
    backend: serverPath => memory.read(serverPath),
    saveBackend: (serverPath, json) => memory.save(serverPath, json),
    storage
  };
  installRendererGlobals(rendererOptions);
  const firstStore = await importFreshModStore('close-inside-debounce');
  assert.equal(await firstStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  firstStore.ignoreUpdate('X.jar', 'x-2', null);
  timers.closeRenderer();
  assert.deepEqual(Object.keys(memory.disk.get(ALPHA)), ['Base.jar']);

  installRendererGlobals(rendererOptions);
  const restartedStore = await importFreshModStore('close-inside-debounce-restart');
  assert.equal(await restartedStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  assert.equal(restartedStore.isUpdateIgnored('X.jar', 'x-2', null), true);
  assert.deepEqual(Object.keys(memory.disk.get(ALPHA)).sort(), ['Base.jar', 'X.jar']);
  assert.equal(storage.has(pendingKeyFor(ALPHA)), false);
});

test('R15: a debounced snapshot from before a switch cannot overwrite the re-hydration save', async (t) => {
  preserveRendererGlobals(t);
  const memory = memoryDisk({ [ALPHA]: { 'Base.jar': { ids: ['base'], vers: [] } } });
  let alphaReads = 0;
  let releaseRehydration;
  const rehydrationRead = new Promise(resolve => { releaseRehydration = resolve; });
  const { setCurrentPath } = installRendererGlobals({
    backend: async serverPath => {
      if (serverPath === ALPHA && ++alphaReads === 2) await rehydrationRead;
      return memory.read(serverPath);
    },
    saveBackend: (serverPath, json) => memory.save(serverPath, json)
  });
  const modStore = await importFreshModStore('stale-debounced-snapshot');
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  modStore.ignoreUpdate('X.jar', 'x-2', null);
  setCurrentPath(BETA);
  await modStore.activateIgnoredUpdatesServerPath(BETA);
  setCurrentPath(ALPHA);
  const reactivation = modStore.activateIgnoredUpdatesServerPath(ALPHA);
  modStore.ignoreUpdate('Z.jar', 'z-2', null);
  releaseRehydration();
  await reactivation;
  await sleep(400);

  assert.equal(modStore.isUpdateIgnored('X.jar', 'x-2', null), true);
  assert.equal(modStore.isUpdateIgnored('Z.jar', 'z-2', null), true);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);
  assert.deepEqual(Object.keys(memory.disk.get(ALPHA)).sort(), ['Base.jar', 'X.jar', 'Z.jar']);
});

test('R15: a save that lands while a re-hydration reads the file cannot drop the edit it acknowledged', async (t) => {
  preserveRendererGlobals(t);
  const memory = memoryDisk({ [ALPHA]: { 'Base.jar': { ids: ['base'], vers: [] } } });
  let alphaReads = 0;
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const { setCurrentPath } = installRendererGlobals({
    backend: async serverPath => {
      if (serverPath === ALPHA && ++alphaReads === 2) {
        // The re-hydration reads the file before the flushed save lands.
        const beforeSave = memory.read(serverPath);
        await readGate;
        return beforeSave;
      }
      return memory.read(serverPath);
    },
    saveBackend: async (serverPath, json) => {
      await sleep(10);
      return memory.save(serverPath, json);
    }
  });
  const modStore = await importFreshModStore('save-lands-during-rehydration-read');
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  modStore.ignoreUpdate('X.jar', 'x-2', null);
  // Re-select the same server straight from a client instance.
  await modStore.activateIgnoredUpdatesServerPath('');
  setCurrentPath(ALPHA);
  const reactivation = modStore.activateIgnoredUpdatesServerPath(ALPHA);
  await sleep(30);
  assert.deepEqual(Object.keys(memory.disk.get(ALPHA)).sort(), ['Base.jar', 'X.jar']);
  releaseRead();
  await reactivation;

  assert.equal(modStore.isUpdateIgnored('X.jar', 'x-2', null), true);
  modStore.ignoreUpdate('Y.jar', 'y-2', null);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);
  assert.deepEqual(Object.keys(memory.disk.get(ALPHA)).sort(), ['Base.jar', 'X.jar', 'Y.jar']);
});

test('a refused save on an unreadable base keeps the journal and never writes a scoped fallback', async (t) => {
  preserveRendererGlobals(t);
  const { invocations, storage } = installRendererGlobals({
    backend: { success: true, found: false, data: {}, unreadable: true },
    saveBackend: async () => ({ success: false, error: 'The server must be stopped first' })
  });
  const modStore = await importFreshModStore('unreadable-base-refused');
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  modStore.ignoreUpdate('Y.jar', 'y-2', null);
  await sleep(350);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  assert.equal(modStore.isUpdateIgnored('Y.jar', 'y-2', null), true);
  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 2);
  for (const save of saves) assert.deepEqual(save[3], { replaceOnlyUnreadable: true });
  assert.equal(storage.has(fallbackKeyFor(ALPHA)), false);
  assert.deepEqual(JSON.parse(storage.get(pendingKeyFor(ALPHA))).map(mutation => mutation.fileName), ['Y.jar']);
});

test('a refused save for a missing server folder leaves an existing scoped fallback untouched', async (t) => {
  preserveRendererGlobals(t);
  const existingFallback = JSON.stringify({ 'A.jar': { ids: ['a-2'], vers: [] } });
  const storage = new Map([[fallbackKeyFor(ALPHA), existingFallback]]);
  const { invocations } = installRendererGlobals({
    backend: { success: true, found: false, data: {}, rootMissing: true },
    saveBackend: async () => ({ success: false, error: 'ENOENT: no such file or directory' }),
    storage
  });
  const modStore = await importFreshModStore('missing-root-existing-fallback');
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);
  assert.equal(modStore.isUpdateIgnored('A.jar', 'a-2', null), true);
  assert.notEqual(currentErrorMessage(modStore), IGNORED_UPDATES_LOAD_ERROR);

  modStore.ignoreUpdate('B.jar', 'b-2', null);
  await sleep(350);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  assert.equal(storage.get(fallbackKeyFor(ALPHA)), existingFallback);
  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 2);
  for (const save of saves) assert.deepEqual(save[3], { replaceOnlyUnreadable: true });
  assert.deepEqual(JSON.parse(saves[1][2]), {
    'A.jar': { ids: ['a-2'], vers: [] },
    'B.jar': { ids: ['b-2'], vers: [] }
  });
  assert.deepEqual(JSON.parse(storage.get(pendingKeyFor(ALPHA))).map(mutation => mutation.fileName), ['B.jar']);
});

test('the unreadable-base guard ends after the first successful save', async (t) => {
  preserveRendererGlobals(t);
  let saveCount = 0;
  const { invocations, storage } = installRendererGlobals({
    backend: { success: true, found: false, data: {}, unreadable: true },
    saveBackend: async () => {
      saveCount += 1;
      return saveCount === 1
        ? { success: true, changed: true }
        : { success: false, error: 'The file is locked' };
    }
  });
  const modStore = await importFreshModStore('unreadable-base-cleared-by-save');
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  modStore.ignoreUpdate('X.jar', 'x-2', null);
  await sleep(350);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  const saves = saveInvocations(invocations);
  assert.equal(saves.length, 2);
  assert.deepEqual(saves[0][3], { replaceOnlyUnreadable: true });
  assert.equal(saves[1].length, 3);
  assert.deepEqual(JSON.parse(storage.get(fallbackKeyFor(ALPHA))), {
    'X.jar': { ids: ['x-2'], vers: [] }
  });
});

test('the unreadable-base guard ends after a normal read of the server', async (t) => {
  preserveRendererGlobals(t);
  let alphaReads = 0;
  const { invocations, storage, setCurrentPath } = installRendererGlobals({
    backend: serverPath => {
      if (serverPath !== ALPHA) return {};
      alphaReads += 1;
      return alphaReads === 1
        ? { success: true, found: false, data: {}, unreadable: true }
        : { success: true, found: true, data: { 'Base.jar': { ids: ['base'], vers: [] } } };
    },
    saveBackend: async () => ({ success: false, error: 'The file is locked' })
  });
  const modStore = await importFreshModStore('unreadable-base-cleared-by-read');
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);
  assert.equal(storage.has(fallbackKeyFor(ALPHA)), false);

  setCurrentPath(BETA);
  await modStore.activateIgnoredUpdatesServerPath(BETA);
  setCurrentPath(ALPHA);
  await modStore.activateIgnoredUpdatesServerPath(ALPHA);
  assert.equal(modStore.isUpdateIgnored('Base.jar', 'base', null), true);
  modStore.ignoreUpdate('X.jar', 'x-2', null);
  await sleep(350);
  assert.equal(await modStore.waitForIgnoredUpdatesPersistence(ALPHA), true);

  const alphaSaves = saveInvocations(invocations).filter(([, serverPath]) => serverPath === ALPHA);
  assert.equal(alphaSaves.length, 2);
  assert.deepEqual(alphaSaves[0][3], { replaceOnlyUnreadable: true });
  assert.equal(alphaSaves[1].length, 3);
  assert.deepEqual(JSON.parse(storage.get(fallbackKeyFor(ALPHA))), {
    'Base.jar': { ids: ['base'], vers: [] },
    'X.jar': { ids: ['x-2'], vers: [] }
  });
});
