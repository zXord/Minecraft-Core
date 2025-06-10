const electronStore = require('electron-store');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

const Store = electronStore.default || electronStore;

const getAppDataDir = () => {
  const userData = app ? app.getPath('userData') : path.join(os.homedir(), '.minecraft-core');
  return path.join(userData, 'config');
};

const appDataDir = getAppDataDir();

const ensureDataDir = () => {
  try {
    if (!fs.existsSync(appDataDir)) {
      fs.mkdirSync(appDataDir, { recursive: true, mode: 0o755 });
    }
    const testFile = path.join(appDataDir, '.writetest');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    
    return true;
  } catch (err) {
    if (appDataDir !== path.join(os.homedir(), '.minecraft-core-fallback')) {
      return ensureDataDir();
    }
    throw err;
  }
};

ensureDataDir();
const storePath = path.join(appDataDir, 'minecraft-core-config.json');
const storeConfig = {
  name: 'minecraft-core-config',
  cwd: appDataDir,
  clearInvalidConfig: false,
  fileExtension: 'json',
  serialize: JSON.stringify,
  deserialize: JSON.parse,
  path: storePath,
  atomicSave: true,
  defaults: {
    lastServerPath: null,
    instances: [],
    windowBounds: {
      width: 1280,
      height: 800
    },
    autoRestart: {
      enabled: false,
      delay: 10,
      maxCrashes: 3
    },
    serverSettings: {
      port: 25565,
      maxRam: 4,
      autoStartMinecraft: false,
      autoStartManagement: false
    }
  }
};

let appStore;
try {
  appStore = new Store(storeConfig);
  appStore.get('__test__');
} catch {
  appStore = new Store({
    ...storeConfig,
    name: 'in-memory-config',
    fileExtension: 'json',
    cwd: os.tmpdir(),
  });
}

const safeStore = {
  get: (key) => {
    try {
      return appStore.get(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
      try {
        appStore.set(key, value);
        if (JSON.stringify(appStore.get(key)) !== JSON.stringify(value)) {
          throw new Error('Write verification failed');
        }
        return true;
      } catch {
        retries++;
        if (retries >= maxRetries) {
          return false;
        }
      }
    }
  },
  has: (key) => {
    try {
      return appStore.has(key);
    } catch {
      return false;
    }
  },
  delete: (key) => {
    try {
      return appStore.delete(key);
    } catch {
      return false;
    }
  },
  clear: () => {
    try {
      return appStore.clear();
    } catch {
      return false;
    }
  },
  get store() {
    return appStore.store || appStore;
  },
  set store(value) {
    if (appStore.store) {
      appStore.store = value;
    } else {
      Object.entries(value).forEach(([k, v]) => appStore.set(k, v));
    }
  },
  get path() {
    return appStore.path || 'in-memory-store';
  }
};

module.exports = safeStore;
