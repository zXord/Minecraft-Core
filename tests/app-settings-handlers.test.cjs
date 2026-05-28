const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function withAppSettingsHandlers({ storedSettings = {} } = {}, fn) {
  const originalLoad = Module._load;
  const modulePath = path.resolve(__dirname, '../electron/ipc/app-settings-handlers.cjs');
  const store = new Map();
  const loginItemCalls = [];

  if (storedSettings !== undefined) {
    store.set('appSettings', storedSettings);
  }

  const appStore = {
    get(key) {
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
      return true;
    }
  };

  const fakeElectron = {
    app: {
      setLoginItemSettings(settings) {
        loginItemCalls.push(settings);
      },
      getLoginItemSettings() {
        return { openAtLogin: false, executableWillLaunchAtLogin: false };
      },
      getVersion() {
        return '0.0.0-test';
      }
    },
    BrowserWindow: {
      getFocusedWindow() {
        return null;
      },
      getAllWindows() {
        return [];
      }
    },
    safeStorage: {
      isEncryptionAvailable() {
        return true;
      },
      encryptString(value) {
        return Buffer.from(value, 'utf8');
      },
      decryptString(buffer) {
        return buffer.toString('utf8');
      }
    }
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return fakeElectron;
    }
    if (request === '../utils/app-store.cjs' || request.endsWith('/utils/app-store.cjs')) {
      return appStore;
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const { createAppSettingsHandlers } = require(modulePath);
    return fn(createAppSettingsHandlers(), { loginItemCalls, store });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

function baseSettings(overrides = {}) {
  return {
    minimizeToTray: true,
    startMinimized: true,
    startOnStartup: false,
    windowSize: 'medium',
    customWidth: 1200,
    customHeight: 800,
    ...overrides
  };
}

test('saving disabled startup removes the same named login item used when enabling', async () => {
  await withAppSettingsHandlers({
    storedSettings: baseSettings({ startOnStartup: true })
  }, async (handlers, { loginItemCalls }) => {
    const result = await handlers['save-app-settings']({}, baseSettings({ startOnStartup: false }));

    assert.equal(result.success, true);
    assert.ok(
      loginItemCalls.some((call) => call.openAtLogin === false && call.name === 'Minecraft Core'),
      'expected disabled startup save to pass the Minecraft Core login item name'
    );
  });
});
