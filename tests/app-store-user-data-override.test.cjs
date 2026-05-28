const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function withAppStoreOverrideTest(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-app-store-'));
  const modulePath = path.resolve(__dirname, '../electron/utils/app-store.cjs');
  const originalLoad = Module._load;
  const previousOverride = process.env.MINECRAFT_CORE_USER_DATA_DIR;
  const setPathCalls = [];

  class FakeStore {
    constructor(config) {
      this.path = config.path;
      this.store = { ...(config.defaults || {}) };
    }

    get(key) {
      return this.store[key];
    }

    set(key, value) {
      this.store[key] = value;
    }

    has(key) {
      return Object.hasOwn(this.store, key);
    }

    delete(key) {
      delete this.store[key];
      return true;
    }

    clear() {
      this.store = {};
      return true;
    }
  }

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath(name) {
            if (name === 'userData') return path.join(root, 'default-user-data');
            if (name === 'appData') return path.join(root, 'real-appdata');
            return root;
          },
          setPath(name, value) {
            setPathCalls.push({ name, value });
          }
        }
      };
    }

    if (request === 'electron-store') {
      return FakeStore;
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    return await fn({ root, modulePath, setPathCalls });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    if (previousOverride === undefined) {
      delete process.env.MINECRAFT_CORE_USER_DATA_DIR;
    } else {
      process.env.MINECRAFT_CORE_USER_DATA_DIR = previousOverride;
    }
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('explicit user data override wins over existing stable app data store', async () => {
  await withAppStoreOverrideTest(async ({ root, modulePath, setPathCalls }) => {
    const stableStore = path.join(root, 'real-appdata', 'Minecraft Core', 'config', 'minecraft-core-config.json');
    const overrideUserData = path.join(root, 'qa-user-data');
    await fsp.mkdir(path.dirname(stableStore), { recursive: true });
    await fsp.writeFile(stableStore, JSON.stringify({ instances: [{ id: 'real' }] }));

    process.env.MINECRAFT_CORE_USER_DATA_DIR = overrideUserData;

    const appStore = require(modulePath);

    assert.equal(appStore.path, path.join(overrideUserData, 'config', 'minecraft-core-config.json'));
    assert.deepEqual(setPathCalls, [{ name: 'userData', value: overrideUserData }]);
  });
});
