const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// As electron/utils/install-identity.cjs reports them. Only the NSIS-installed
// copy may write the shared HKCU Run entry.
const INSTALLED_IDENTITY = Object.freeze({ installed: true, reason: 'uninstaller-present', platform: 'win32', isPackaged: true });
const NOT_INSTALLED_IDENTITIES = [
  Object.freeze({ installed: false, reason: 'not-installed-copy', platform: 'win32', isPackaged: true }),
  Object.freeze({ installed: false, reason: 'unpackaged', platform: 'win32', isPackaged: false })
];

function withAppSettingsHandlers({ storedSettings = {}, installIdentity = INSTALLED_IDENTITY } = {}, fn) {
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
    if (request.endsWith('install-identity.cjs')) {
      return {
        getInstallIdentity() {
          if (installIdentity instanceof Error) throw installIdentity;
          return installIdentity;
        }
      };
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

test('the installed app writes the start-at-login entry exactly as before', async () => {
  await withAppSettingsHandlers({
    storedSettings: baseSettings({ startOnStartup: false })
  }, async (handlers, { loginItemCalls }) => {
    const enabled = await handlers['save-app-settings']({}, baseSettings({ startOnStartup: true, startMinimized: true }));
    assert.equal(enabled.success, true);
    assert.deepEqual(enabled.startupLoginItem, { applied: true });
    assert.deepEqual(loginItemCalls, [{ openAtLogin: true, name: 'Minecraft Core', args: ['--start-minimized'] }]);

    loginItemCalls.length = 0;
    const disabled = await handlers['save-app-settings']({}, baseSettings({ startOnStartup: false }));
    assert.equal(disabled.success, true);
    assert.deepEqual(disabled.startupLoginItem, { applied: true });
    assert.deepEqual(loginItemCalls, [
      { openAtLogin: false, name: 'Minecraft Core', args: [] },
      { openAtLogin: false, name: 'Minecraft Core', args: ['--start-minimized'] }
    ]);
  });
});

test('a copy that is not the installed app never writes or removes the start-at-login entry', async () => {
  for (const installIdentity of [...NOT_INSTALLED_IDENTITIES, new Error('IDENTITY_UNAVAILABLE')]) {
    for (const startOnStartup of [true, false]) {
      await withAppSettingsHandlers({
        storedSettings: baseSettings({ startOnStartup: !startOnStartup }),
        installIdentity
      }, async (handlers, { loginItemCalls, store }) => {
        const result = await handlers['save-app-settings']({}, baseSettings({ startOnStartup }));

        assert.equal(result.success, true);
        assert.deepEqual(result.startupLoginItem, { applied: false, reason: 'not-installed-copy' });
        assert.deepEqual(loginItemCalls, [], `${installIdentity.reason || installIdentity.message} must not touch the Run key`);
        // The choice is still kept in this copy's own settings.
        assert.equal(store.get('appSettings').startOnStartup, startOnStartup);
      });
    }
  }
});

test('saving settings that leave startup alone does not touch the start-at-login entry', async () => {
  await withAppSettingsHandlers({}, async (handlers, { loginItemCalls }) => {
    const { startOnStartup, ...settings } = baseSettings();
    void startOnStartup;
    const result = await handlers['save-app-settings']({}, settings);

    assert.equal(result.success, true);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'startupLoginItem'), false);
    assert.deepEqual(loginItemCalls, []);
  });
});
