// AppStore for persistent app configurations
const electronStore = require('electron-store');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

// Get the correct constructor (handles both ESM and CJS exports)
const Store = electronStore.default || electronStore;

// Create a dedicated storage directory for the app
const getAppDataDir = () => {
  // Use app.getPath('userData') for proper app data directory
  const userData = app ? app.getPath('userData') : path.join(os.homedir(), '.minecraft-core');
  return path.join(userData, 'config');
};

const appDataDir = getAppDataDir();

// Ensure directory exists and is writable
const ensureDataDir = () => {
  try {
    if (!fs.existsSync(appDataDir)) {
      fs.mkdirSync(appDataDir, { recursive: true, mode: 0o755 });
    }
    
    // Test write access
    const testFile = path.join(appDataDir, '.writetest');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    
    return true;
  } catch (err) {
    console.error('Error accessing app data directory:', err);
    // Fallback to a different directory if needed
    if (appDataDir !== path.join(os.homedir(), '.minecraft-core-fallback')) {
      console.log('Falling back to home directory');
      return ensureDataDir();
    }
    throw err;
  }
};

// Ensure data directory is accessible
ensureDataDir();

// Log the exact path we're using
const storePath = path.join(appDataDir, 'minecraft-core-config.json');
console.log('Store file path:', storePath);

// Configure the store with defaults
const storeConfig = {
  name: 'minecraft-core-config',
  cwd: appDataDir,
  clearInvalidConfig: false, // Don't clear when the store gets corrupted
  fileExtension: 'json',
  serialize: JSON.stringify,
  deserialize: JSON.parse,
  // Explicitly set the file path
  path: storePath,
  // Ensure file is written atomically
  atomicSave: true,
  // Set migrations to handle older versions
  migrations: {
    '>=1.0.0': store => {
      // If instances array doesn't exist, initialize it
      if (!store.has('instances')) {
        store.set('instances', []);
      }
      
      // Make sure instances are valid
      const instances = store.get('instances');
      if (instances && Array.isArray(instances)) {
        const validInstances = instances.filter(instance => {
          if (!instance || typeof instance !== 'object') return false;
          return instance.id && instance.type;
        });
        store.set('instances', validInstances);
      }
    }
  },
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
      maxRam: 4
    }
  }
};

// Initialize store synchronously
let appStore;
try {
  appStore = new Store(storeConfig);
  // Quick sanity check
  appStore.get('__test__');
  console.log('Store initialized successfully at:', storePath);
} catch (err) {
  console.error('Failed to initialize electron-store, falling back to in-memory:', err);
  // Fallback to in-memory store
  appStore = new Store({
    ...storeConfig,
    // @ts-ignore
    name: 'in-memory-config',
    fileExtension: 'json',
    cwd: os.tmpdir(),
  });
}

// Create a robust proxy to catch errors and add retry logic
const safeStore = {
  get: (key) => {
    try {
      return appStore.get(key);
    } catch (error) {
      console.error(`Error getting ${key} from store:`, error);
      return null;
    }
  },
  set: (key, value) => {
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
      try {
        appStore.set(key, value);
        // Verify write
        if (JSON.stringify(appStore.get(key)) !== JSON.stringify(value)) {
          throw new Error('Write verification failed');
        }
        return true;
      } catch (error) {
        retries++;
        console.warn(`Retry ${retries}/${maxRetries} for setting ${key}:`, error.message);
        if (retries >= maxRetries) {
          console.error(`Failed to set ${key} after ${maxRetries} attempts:`, error);
          return false;
        }
      }
    }
  },
  has: (key) => {
    try {
      return appStore.has(key);
    } catch (error) {
      console.error(`Error checking for ${key} in store:`, error);
      return false;
    }
  },
  delete: (key) => {
    try {
      return appStore.delete(key);
    } catch (error) {
      console.error(`Error deleting ${key} from store:`, error);
      return false;
    }
  },
  clear: () => {
    try {
      return appStore.clear();
    } catch (error) {
      console.error('Error clearing store:', error);
      return false;
    }
  },
  // Add store property for direct access
  get store() {
    return appStore.store || appStore;
  },
  set store(value) {
    if (appStore.store) {
      appStore.store = value;
    } else {
      // Fallback for in-memory store
      Object.entries(value).forEach(([k, v]) => appStore.set(k, v));
    }
  },
  // Add path for debugging
  get path() {
    return appStore.path || 'in-memory-store';
  }
};

// Log store info
console.log('App Store Path:', safeStore.path);
console.log('App Data Directory:', appDataDir);

// Test store access
try {
  const testKey = '__store_test__';
  const testValue = { test: Date.now() };
  safeStore.set(testKey, testValue);
  const readValue = safeStore.get(testKey);
  safeStore.delete(testKey);
  
  if (JSON.stringify(readValue) !== JSON.stringify(testValue)) {
    console.error('Store read/write verification failed');
  } else {
    console.log('Store read/write verification successful');
  }
} catch (err) {
  console.error('Store test failed:', err);
}

module.exports = safeStore;
