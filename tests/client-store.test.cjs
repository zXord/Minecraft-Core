const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { get } = require('svelte/store');

function createLocalStorage() {
  const backing = new Map();
  return {
    getItem(key) {
      return backing.has(key) ? backing.get(key) : null;
    },
    setItem(key, value) {
      backing.set(key, String(value));
    },
    removeItem(key) {
      backing.delete(key);
    },
    clear() {
      backing.clear();
    }
  };
}

async function withClientStore(options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  const { persistedState } = options || {};

  const originalLoad = Module._load;
  const originalWindow = global.window;
  const originalLocalStorage = global.localStorage;
  const localStorage = createLocalStorage();
  if (persistedState) {
    localStorage.setItem('clientState', JSON.stringify(persistedState));
  }

  const loggerStub = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {}
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request.endsWith('utils/logger.js')) {
      return loggerStub;
    }
    return originalLoad(request, parent, isMain);
  };

  global.localStorage = localStorage;
  global.window = { ...(originalWindow || {}), localStorage };

  const modulePath = path.resolve(__dirname, '../src/stores/clientStore.js');
  delete require.cache[modulePath];
  const clientStoreModule = require(modulePath);

  try {
    await fn(clientStoreModule, { localStorage });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    if (originalLocalStorage === undefined) {
      delete global.localStorage;
    } else {
      global.localStorage = originalLocalStorage;
    }
    if (originalWindow === undefined) {
      delete global.window;
    } else {
      global.window = originalWindow;
    }
  }
}

test('setManagementServerStatus updates store and persists state', async () => {
  await withClientStore(async ({ clientState, setManagementServerStatus }) => {
    let latest;
    const unsubscribe = clientState.subscribe(value => {
      latest = value;
    });

    setManagementServerStatus('running');
    unsubscribe();

    assert.equal(latest.managementServerStatus, 'running');
    const persisted = JSON.parse(global.localStorage.getItem('clientState'));
    assert.equal(persisted.managementServerStatus, 'running');
  });
});

test('validateAndFixClientState normalizes invalid statuses', async () => {
  await withClientStore(async ({ clientState, validateAndFixClientState }) => {
    clientState.update(state => ({
      ...state,
      connectionStatus: 'weird',
      managementServerStatus: 'bogus',
      minecraftServerStatus: '???',
      activeTab: 'unknown-tab',
      versionChangeDetected: true,
      lastKnownMinecraftVersion: null
    }));

    validateAndFixClientState();
    const state = get(clientState);

    assert.equal(state.connectionStatus, 'disconnected');
    assert.equal(state.managementServerStatus, 'unknown');
    assert.equal(state.minecraftServerStatus, 'unknown');
    assert.equal(state.activeTab, 'play');
    assert.equal(state.versionChangeDetected, false);
  });
});
