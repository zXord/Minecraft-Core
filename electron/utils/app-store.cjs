const ElectronStore = require('electron-store');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

// Silent logger to avoid circular dependency and console spam
const logger = {
  debug: (message, data) => { void message; void data; },
  info: (message, data) => { void message; void data; },
  warn: (message, data) => { void message; void data; },
  error: (message, data) => { void message; void data; }
};

const Store = ElectronStore;

const getAppDataDir = () => {
  const userData = app ? app.getPath('userData') : path.join(os.homedir(), '.minecraft-core');
  const configDir = path.join(userData, 'config');

  logger.debug('Getting app data directory', {
    category: 'storage',
    data: {
      function: 'getAppDataDir',
      hasApp: !!app,
      userData,
      configDir
    }
  });

  return configDir;
};

const appDataDir = getAppDataDir();

const ensureDataDir = () => {
  logger.debug('Ensuring app data directory exists', {
    category: 'storage',
    data: {
      function: 'ensureDataDir',
      appDataDir,
      exists: fs.existsSync(appDataDir)
    }
  });

  try {
    if (!fs.existsSync(appDataDir)) {
      logger.info('Creating app data directory', {
        category: 'storage',
        data: {
          function: 'ensureDataDir',
          appDataDir,
          action: 'creating_directory'
        }
      });
      fs.mkdirSync(appDataDir, { recursive: true, mode: 0o755 });
    }

    // Test write permissions
    const testFile = path.join(appDataDir, '.writetest');
    logger.debug('Testing write permissions', {
      category: 'storage',
      data: {
        function: 'ensureDataDir',
        testFile,
        action: 'permission_test'
      }
    });

    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);

    logger.info('App data directory ready', {
      category: 'storage',
      data: {
        function: 'ensureDataDir',
        appDataDir,
        status: 'ready',
        permissions: 'write_ok'
      }
    });

    return true;
  } catch (err) {
    logger.error(`Failed to ensure data directory: ${err.message}`, {
      category: 'storage',
      data: {
        function: 'ensureDataDir',
        appDataDir,
        errorType: err.constructor.name,
        errorCode: err.code,
        errorMessage: err.message
      }
    });

    if (appDataDir !== path.join(os.homedir(), '.minecraft-core-fallback')) {
      logger.warn('Retrying with fallback directory', {
        category: 'storage',
        data: {
          function: 'ensureDataDir',
          originalDir: appDataDir,
          fallbackDir: path.join(os.homedir(), '.minecraft-core-fallback'),
          action: 'fallback_retry'
        }
      });
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
      managementPort: 8080,
      autoStartMinecraft: false,
      autoStartManagement: false
    },
    appSettings: {
      minimizeToTray: false,
      startMinimized: false,
      startOnStartup: false,
      // Browser control panel (served by management server)
      browserPanel: {
        enabled: false,
  autoStart: false,
  // Use a different default port than management server to avoid conflicts
  port: 8081,
        username: 'user',
        password: 'password',
        // Map of instanceId -> true/false (only server instances are respected)
        instanceVisibility: {}
      }
    },
    loggerSettings: {
      maxLogs: 1000,
      logLevel: 'all',
      exportFormat: 'json',
      maxFileSize: 50,
      maxFiles: 5,
      retentionDays: 7
    }
  }
};

let appStore;
logger.info('Initializing application store', {
  category: 'storage',
  data: {
    storePath,
    storeConfig: {
      name: storeConfig.name,
      cwd: storeConfig.cwd,
      atomicSave: storeConfig.atomicSave,
      defaultsKeys: Object.keys(storeConfig.defaults)
    }
  }
});

try {
  appStore = new Store(storeConfig);
  // Test store accessibility
  appStore.get('__test__');

  logger.info('Application store initialized successfully', {
    category: 'storage',
    data: {
      storeType: 'persistent',
      storePath: appStore.path,
      storeSize: Object.keys(appStore.store || {}).length
    }
  });
} catch (error) {
  logger.error(`Failed to initialize persistent store, falling back to in-memory: ${error.message}`, {
    category: 'storage',
    data: {
      originalConfig: storeConfig.name,
      errorType: error.constructor.name,
      errorMessage: error.message,
      fallback: 'in-memory'
    }
  });

  appStore = new Store({
    ...storeConfig,
    name: 'in-memory-config',
    fileExtension: 'json',
    cwd: os.tmpdir(),
  });

  logger.warn('Using in-memory store as fallback', {
    category: 'storage',
    data: {
      storeType: 'in-memory',
      tmpDir: os.tmpdir(),
      warning: 'data_will_not_persist'
    }
  });
}

const safeStore = {
  get: (key) => {
    logger.debug('Getting store value', {
      category: 'storage',
      data: {
        operation: 'get',
        key,
        keyType: typeof key
      }
    });

    try {
      const value = appStore.get(key);
      logger.debug('Store value retrieved', {
        category: 'storage',
        data: {
          operation: 'get',
          key,
          hasValue: value !== undefined,
          valueType: typeof value,
          success: true
        }
      });
      return value;
    } catch (error) {
      logger.error(`Failed to get store value: ${error.message}`, {
        category: 'storage',
        data: {
          operation: 'get',
          key,
          errorType: error.constructor.name,
          errorMessage: error.message,
          recovery: 'returning_null'
        }
      });
      return null;
    }
  },

  set: (key, value) => {
    const startTime = Date.now();
    logger.debug('Setting store value', {
      category: 'storage',
      data: {
        operation: 'set',
        key,
        valueType: typeof value,
        valueSize: JSON.stringify(value).length
      }
    });

    let retries = 0;
    const maxRetries = 3;

    while (retries < maxRetries) {
      try {
        appStore.set(key, value);

        // Verify write
        const storedValue = appStore.get(key);
        if (JSON.stringify(storedValue) !== JSON.stringify(value)) {
          throw new Error('Write verification failed');
        }

        const duration = Date.now() - startTime;
        logger.info('Store value set successfully', {
          category: 'storage',
          data: {
            operation: 'set',
            key,
            valueType: typeof value,
            duration,
            retries,
            verified: true,
            success: true
          }
        });
        return true;
      } catch (error) {
        retries++;
        logger.warn(`Store set attempt ${retries} failed: ${error.message}`, {
          category: 'storage',
          data: {
            operation: 'set',
            key,
            attempt: retries,
            maxRetries,
            errorType: error.constructor.name,
            errorMessage: error.message
          }
        });

        if (retries >= maxRetries) {
          const duration = Date.now() - startTime;
          logger.error('Store set failed after all retries', {
            category: 'storage',
            data: {
              operation: 'set',
              key,
              totalRetries: retries,
              duration,
              finalError: error.message,
              success: false
            }
          });
          return false;
        }
      }
    }
  },

  has: (key) => {
    logger.debug('Checking if store has key', {
      category: 'storage',
      data: {
        operation: 'has',
        key
      }
    });

    try {
      const exists = appStore.has(key);
      logger.debug('Store key existence checked', {
        category: 'storage',
        data: {
          operation: 'has',
          key,
          exists,
          success: true
        }
      });
      return exists;
    } catch (error) {
      logger.error(`Failed to check store key existence: ${error.message}`, {
        category: 'storage',
        data: {
          operation: 'has',
          key,
          errorType: error.constructor.name,
          errorMessage: error.message,
          recovery: 'returning_false'
        }
      });
      return false;
    }
  },

  delete: (key) => {
    logger.info('Deleting store key', {
      category: 'storage',
      data: {
        operation: 'delete',
        key
      }
    });

    try {
      const result = appStore.delete(key);
      logger.info('Store key deleted', {
        category: 'storage',
        data: {
          operation: 'delete',
          key,
          result,
          success: true
        }
      });
      return result;
    } catch (error) {
      logger.error(`Failed to delete store key: ${error.message}`, {
        category: 'storage',
        data: {
          operation: 'delete',
          key,
          errorType: error.constructor.name,
          errorMessage: error.message,
          success: false
        }
      });
      return false;
    }
  },

  clear: () => {
    logger.warn('Clearing entire store', {
      category: 'storage',
      data: {
        operation: 'clear',
        warning: 'all_data_will_be_lost'
      }
    });

    try {
      const result = appStore.clear();
      logger.info('Store cleared successfully', {
        category: 'storage',
        data: {
          operation: 'clear',
          result,
          success: true
        }
      });
      return result;
    } catch (error) {
      logger.error(`Failed to clear store: ${error.message}`, {
        category: 'storage',
        data: {
          operation: 'clear',
          errorType: error.constructor.name,
          errorMessage: error.message,
          success: false
        }
      });
      return false;
    }
  },

  get store() {
    logger.debug('Getting entire store object', {
      category: 'storage',
      data: {
        operation: 'get_store',
        storeType: appStore.store ? 'electron-store' : 'fallback'
      }
    });
    return appStore.store || appStore;
  },

  set store(value) {
    logger.warn('Setting entire store object', {
      category: 'storage',
      data: {
        operation: 'set_store',
        valueKeys: Object.keys(value || {}),
        keyCount: Object.keys(value || {}).length,
        warning: 'bulk_operation'
      }
    });

    try {
      if (appStore.store) {
        appStore.store = value;
        logger.info('Store object set directly', {
          category: 'storage',
          data: {
            operation: 'set_store',
            method: 'direct',
            success: true
          }
        });
      } else {
        let successCount = 0;
        let errorCount = 0;
        Object.entries(value).forEach(([k, v]) => {
          try {
            appStore.set(k, v);
            successCount++;
          } catch (error) {
            errorCount++;
            logger.error(`Failed to set store key ${k}: ${error.message}`, {
              category: 'storage',
              data: {
                operation: 'set_store',
                key: k,
                errorType: error.constructor.name,
                errorMessage: error.message
              }
            });
          }
        });

        logger.info('Store object set via individual keys', {
          category: 'storage',
          data: {
            operation: 'set_store',
            method: 'individual',
            successCount,
            errorCount,
            totalKeys: Object.keys(value).length
          }
        });
      }
    } catch (error) {
      logger.error(`Failed to set store object: ${error.message}`, {
        category: 'storage',
        data: {
          operation: 'set_store',
          errorType: error.constructor.name,
          errorMessage: error.message,
          valueKeys: Object.keys(value || {})
        }
      });
    }
  },

  get path() {
    const storePath = appStore.path || 'in-memory-store';
    logger.debug('Getting store path', {
      category: 'storage',
      data: {
        operation: 'get_path',
        path: storePath,
        isInMemory: storePath === 'in-memory-store'
      }
    });
    return storePath;
  }
};

module.exports = safeStore;
