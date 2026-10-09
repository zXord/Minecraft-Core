const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function withEarlyTrace(importEnv, events, run, { brokenSink = false } = {}) {
  const modulePath = path.resolve(__dirname, '../electron/startup-entry.cjs');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './utils/startup-trace.cjs') {
      const { createStartupTrace } = originalLoad(request, parent, isMain);
      const options = {
        now: () => 100, utcNow: () => '2026-10-09T00:00:00.000Z', pid: 123,
        sink(line) {
          if (brokenSink) throw new Error('private sink failure');
          events.push(JSON.parse(line.slice('[Minecraft Core startup trace] '.length)).marker);
        }
      };
      return {
        markStartupTrace: createStartupTrace({ ...options, env: importEnv }),
        createStartupTrace: ({ env }) => createStartupTrace({ ...options, env })
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try { return await run(require(modulePath)); }
  finally { delete require.cache[modulePath]; Module._load = originalLoad; }
}

test('startup trace brackets held readiness document and main load with supplied opt-in despite disabled import', async () => {
  const events = [];
  await withEarlyTrace({}, events, async entry => {
    let finishReady, finishDocument, finishMain;
    const ready = new Promise(resolve => { finishReady = resolve; });
    const document = new Promise(resolve => { finishDocument = resolve; });
    const main = new Promise(resolve => { finishMain = resolve; });
    const window = { isDestroyed: () => false };
    const startup = entry.startEarlyStartup({
      app: { whenReady() { events.push('ready'); return ready; } },
      env: { MINECRAFT_CORE_STARTUP_TRACE: '1' },
      resolveIconPath() { events.push('resolve'); return null; },
      prepareIconPath() { events.push('prepare'); return null; },
      createWindow() { events.push('create'); return window; },
      waitForWindowDocument(value) { assert.equal(value, window); events.push('document'); return document; },
      loadMain() { events.push('main'); return main; }
    });
    assert.deepEqual(events, ['early:when-ready:start', 'ready']);
    finishReady();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [
      'early:when-ready:start', 'ready', 'early:when-ready:complete',
      'early:icon:start', 'resolve', 'prepare', 'early:icon:complete',
      'early:shortcut-attempt:start', 'early:shortcut-attempt:complete',
      'early:window:create:start', 'create', 'early:window:create:complete', 'early:document:start', 'document'
    ]);
    finishDocument();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events.slice(-3), ['early:document:complete', 'early:main-load:start', 'main']);
    finishMain();
    assert.equal(await startup, window);
    assert.equal(events.at(-1), 'early:main-load:complete');
    assert.equal(entry.claimEarlyStartupWindow(), window);
  });
});

test('startup trace early module entry is import-owned but test-mode body uses supplied env and skips window boundaries', async () => {
  const events = [];
  await withEarlyTrace({ MINECRAFT_CORE_STARTUP_TRACE: '1' }, events, async entry => {
    assert.deepEqual(events, ['early:entry', 'early:imports:complete']);
    events.length = 0;
    for (const enabled of [false, true]) {
      const result = await entry.startEarlyStartup({
        app: { whenReady() { events.push('ready'); return Promise.resolve(); } },
        env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', ...(enabled ? { MINECRAFT_CORE_STARTUP_TRACE: '1' } : {}) },
        createWindow() { assert.fail('test mode must bypass startup window'); },
        loadMain() { events.push('main'); }
      });
      assert.equal(result, null);
      assert.deepEqual(events, enabled ? [
        'early:when-ready:start', 'ready', 'early:when-ready:complete', 'early:main-load:start', 'main', 'early:main-load:complete'
      ] : ['ready', 'main']);
      events.length = 0;
    }
  });
});

test('startup trace early failures retain readiness and import error identity and cleanup even with broken diagnostics', async () => {
  for (const failureAt of ['ready', 'main']) {
    for (const brokenSink of [false, true]) {
      const events = [];
      const originalError = new Error('PRIVATE_ORIGINAL');
      await withEarlyTrace({}, events, async entry => {
        const window = { isDestroyed: () => false, close() { events.push('close'); } };
        await assert.rejects(entry.startEarlyStartup({
          app: { whenReady() { if (failureAt === 'ready') return Promise.reject(originalError); return Promise.resolve(); }, quit() { events.push('quit'); } },
          env: { MINECRAFT_CORE_STARTUP_TRACE: '1' },
          resolveIconPath: () => null, prepareIconPath: () => null,
          createWindow: () => window, waitForWindowDocument: async () => {},
          loadMain() { throw originalError; }
        }), actual => actual === originalError);
        assert.deepEqual(events.filter(value => ['close', 'quit'].includes(value)), failureAt === 'ready' ? ['quit'] : ['close', 'quit']);
        assert.equal(events.includes('early:main-load:complete'), false);
        assert.equal(events.includes('early:failed'), !brokenSink);
        assert.equal(entry.claimEarlyStartupWindow(), null);
      }, { brokenSink });
    }
  }
});

test('startup trace reused early window has document and main boundaries but no creation markers', async () => {
  const events = [];
  await withEarlyTrace({}, events, async entry => {
    const window = { isDestroyed: () => false };
    entry.publishEarlyStartupWindow(window);
    try {
      assert.equal(await entry.startEarlyStartup({
        app: { whenReady: async () => {} }, env: { MINECRAFT_CORE_STARTUP_TRACE: '1' },
        resolveIconPath: () => null, prepareIconPath: () => null,
        createWindow() { assert.fail('live existing window must be reused'); },
        waitForWindowDocument: async () => {}, loadMain: () => {}
      }), window);
      assert.equal(events.some(value => value.startsWith('early:window:create:')), false);
      assert.deepEqual(events.slice(-4), ['early:document:start', 'early:document:complete', 'early:main-load:start', 'early:main-load:complete']);
    } finally { assert.equal(entry.claimEarlyStartupWindow(), window); }
  });
});

function loadStartupEntry() {
  try {
    return require('../electron/startup-entry.cjs');
  } catch (error) {
    return { loadError: error };
  }
}

test('Electron browser startup runs even when the launcher owns require.main', () => {
  const startupEntry = loadStartupEntry();
  assert.equal(startupEntry.loadError, undefined, startupEntry.loadError?.message);
  assert.equal(typeof startupEntry.shouldAutoStartEarlyStartup, 'function');

  const startupModule = {};
  const launcherModule = {};
  assert.equal(startupEntry.shouldAutoStartEarlyStartup({
    processLike: { type: 'browser', versions: { electron: '42.10.1' } },
    startupModule,
    requireMain: launcherModule
  }), true);
  assert.equal(startupEntry.shouldAutoStartEarlyStartup({
    processLike: { versions: { node: process.versions.node } },
    startupModule,
    requireMain: launcherModule
  }), false);
});

test('early entry publishes the branded startup window before it imports the main process', async () => {
  const startupEntry = loadStartupEntry();
  assert.equal(startupEntry.loadError, undefined, startupEntry.loadError?.message);
  assert.equal(typeof startupEntry.startEarlyStartup, 'function');
  assert.equal(typeof startupEntry.claimEarlyStartupWindow, 'function');

  const events = [];
  const startupWindow = Object.freeze({ id: 93, isDestroyed: () => false });
  const app = {
    whenReady() {
      events.push('app:ready');
      return Promise.resolve();
    }
  };

  await startupEntry.startEarlyStartup({
    app,
    BrowserWindow: function BrowserWindow() {},
    resolveIconPath() {
      events.push('icon:resolve');
      return 'C:\\fixture\\build-resources\\icon.ico';
    },
    createWindow({ BrowserWindow, iconPath }) {
      assert.equal(typeof BrowserWindow, 'function');
      assert.equal(iconPath, 'C:\\fixture\\build-resources\\icon.ico');
      events.push('startup:create');
      return startupWindow;
    },
    loadMain() {
      events.push('main:import');
      assert.equal(startupEntry.claimEarlyStartupWindow(), startupWindow);
    }
  });

  assert.deepEqual(events, ['app:ready', 'icon:resolve', 'startup:create', 'main:import']);
  assert.equal(startupEntry.claimEarlyStartupWindow(), null);
});

test('early entry lets the branded document finish loading before it imports the main process', async () => {
  const startupEntry = loadStartupEntry();
  const events = [];
  let finishDocumentLoad;

  class FakeBrowserWindow {
    constructor() {
      this.id = 94;
      events.push('startup:create');
    }

    isDestroyed() {
      return false;
    }

    loadURL() {
      events.push('startup:load');
      return new Promise(resolve => {
        finishDocumentLoad = () => {
          events.push('startup:loaded');
          resolve();
        };
      });
    }
  }

  const startup = startupEntry.startEarlyStartup({
    app: {
      whenReady() {
        events.push('app:ready');
        return Promise.resolve();
      }
    },
    BrowserWindow: FakeBrowserWindow,
    resolveIconPath: () => null,
    loadMain() {
      events.push('main:import');
      startupEntry.claimEarlyStartupWindow();
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['app:ready', 'startup:create', 'startup:load']);

  const observableTurn = new Promise(resolve => setImmediate(() => {
    events.push('startup:observable');
    resolve();
  }));
  finishDocumentLoad();
  await observableTurn;
  assert.deepEqual(events, [
    'app:ready',
    'startup:create',
    'startup:load',
    'startup:loaded',
    'startup:observable'
  ]);

  await startup;
  assert.deepEqual(events, [
    'app:ready',
    'startup:create',
    'startup:load',
    'startup:loaded',
    'startup:observable',
    'main:import'
  ]);
});

test('early entry tells the startup window when its icon must come from the packaged executable', async t => {
  const startupEntry = loadStartupEntry();
  const startupWindow = { isDestroyed: () => false };
  t.after(() => { startupEntry.claimEarlyStartupWindow(); });

  await startupEntry.startEarlyStartup({
    app: {
      isPackaged: true,
      setName() {},
      setAppUserModelId() {},
      whenReady: async () => {}
    },
    platform: 'win32',
    resolveIconPath: () => 'C:\\fixture\\resources\\app.asar\\build-resources\\icon.ico',
    createWindow(options) {
      assert.equal(options.isPackaged, true);
      assert.equal(options.executablePath, process.execPath);
      return startupWindow;
    },
    loadMain() {}
  });
});

test('early entry preserves direct main test-mode startup without leaving a splash window behind', async () => {
  const { startEarlyStartup } = loadStartupEntry();
  const events = [];

  await startEarlyStartup({
    app: { isPackaged: false, whenReady: async () => { events.push('app:ready'); } },
    shouldCreateStartupWindow: () => false,
    createWindow: () => {
      events.push('startup:create');
      throw new Error('test mode must not create a startup window');
    },
    loadMain: () => { events.push('main:import'); }
  });

  assert.deepEqual(events, ['app:ready', 'main:import']);
});

test('early entry applies an explicit userData override before readiness and startup window creation', async () => {
  const startupEntry = loadStartupEntry();
  const events = [];
  const isolatedUserData = path.join(os.tmpdir(), 'minecraft-core-early-user-data-test');
  const startupWindow = { isDestroyed: () => false };

  await startupEntry.startEarlyStartup({
    app: {
      setPath(name, value) { events.push(`path:${name}:${value}`); },
      whenReady() { events.push('app:ready'); return Promise.resolve(); }
    },
    env: { MINECRAFT_CORE_USER_DATA_DIR: isolatedUserData },
    shouldCreateStartupWindow: () => true,
    resolveIconPath: () => null,
    createWindow() { events.push('startup:create'); return startupWindow; },
    loadMain() {
      events.push('main:import');
      assert.equal(startupEntry.claimEarlyStartupWindow(), startupWindow);
    }
  });

  assert.deepEqual(events, [
    `path:userData:${path.resolve(isolatedUserData)}`,
    'app:ready',
    'startup:create',
    'main:import'
  ]);
});

test('early entry establishes Windows identity after an override and before readiness or the startup window', async t => {
  const startupEntry = loadStartupEntry();
  const events = [];
  const isolatedUserData = path.join(os.tmpdir(), 'minecraft-core-early-identity-user-data-test');
  const startupWindow = { isDestroyed: () => false };
  t.after(() => { startupEntry.claimEarlyStartupWindow(); });

  await startupEntry.startEarlyStartup({
    app: {
      setPath(name, value) { events.push(`path:${name}:${value}`); },
      setName(value) { events.push(`name:${value}`); },
      setAppUserModelId(value) { events.push(`app-id:${value}`); },
      whenReady() { events.push('app:ready'); return Promise.resolve(); }
    },
    env: { MINECRAFT_CORE_USER_DATA_DIR: isolatedUserData },
    platform: 'win32',
    shouldCreateStartupWindow: () => true,
    resolveIconPath: () => null,
    createWindow() { events.push('startup:create'); return startupWindow; },
    loadMain() { events.push('main:import'); }
  });

  assert.deepEqual(events, [
    `path:userData:${path.resolve(isolatedUserData)}`,
    'name:Minecraft Core',
    'app-id:com.minecraft-core.app.dev',
    'app:ready',
    'startup:create',
    'main:import'
  ]);
});

test('development startup creates or overwrites the branded Start Menu shortcut before its first window', async t => {
  const startupEntry = loadStartupEntry();
  const events = [];
  const appPath = 'C:\\fixture\\minecraft-core';
  const appDataPath = 'C:\\fixture\\AppData\\Roaming';
  const programsPath = path.join(appDataPath, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const iconPath = 'C:\\fixture\\minecraft-core\\build-resources\\icon.ico';
  const cachedIconPath = 'C:\\fixture\\AppData\\Roaming\\Minecraft Core\\window-icon-cache\\minecraft-core-content.ico';
  const startupWindow = { isDestroyed: () => false };
  let shortcutWrite = null;
  t.after(() => { startupEntry.claimEarlyStartupWindow(); });

  await startupEntry.startEarlyStartup({
    app: {
      isPackaged: false,
      getAppPath() { return appPath; },
      getPath(name) { assert.equal(name, 'appData'); return appDataPath; },
      whenReady() { events.push('app:ready'); return Promise.resolve(); }
    },
    env: { npm_lifecycle_event: 'dev:electron' },
    platform: 'win32',
    shellApi: {
      writeShortcutLink(shortcutPath, operation, details) {
        events.push('shortcut:write');
        shortcutWrite = { shortcutPath, operation, details };
        return true;
      }
    },
    resolveIconPath() { events.push('icon:resolve'); return iconPath; },
    prepareIconPath({ sourceIconPath }) {
      assert.equal(sourceIconPath, iconPath);
      events.push('icon:cache');
      return cachedIconPath;
    },
    createWindow(options) {
      assert.equal(options.iconPath, cachedIconPath);
      assert.equal(options.applicationPath, appPath);
      events.push('startup:create');
      return startupWindow;
    },
    loadMain() { events.push('main:import'); }
  });

  assert.deepEqual(events, [
    'app:ready',
    'icon:resolve',
    'icon:cache',
    'shortcut:write',
    'startup:create',
    'main:import'
  ]);
  assert.deepEqual(shortcutWrite, {
    shortcutPath: path.join(programsPath, 'Minecraft Core Development.lnk'),
    operation: 'create',
    details: {
      target: process.execPath,
      args: `"${appPath}"`,
      cwd: appPath,
      icon: cachedIconPath,
      iconIndex: 0,
      appUserModelId: 'com.minecraft-core.app.dev'
    }
  });
});

test('development startup explicitly replaces only its exact existing Start Menu shortcut', () => {
  const { writeDevelopmentStartMenuShortcut } = loadStartupEntry();
  const appPath = 'C:\\fixture\\minecraft-core';
  const appDataPath = 'C:\\fixture\\AppData\\Roaming';
  const shortcutPath = path.join(
    appDataPath,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Minecraft Core Development.lnk'
  );
  const operations = [];

  assert.equal(writeDevelopmentStartMenuShortcut({
    app: {
      isPackaged: false,
      getAppPath: () => appPath,
      getPath(name) { assert.equal(name, 'appData'); return appDataPath; }
    },
    env: { npm_lifecycle_event: 'dev:electron' },
    iconPath: 'C:\\fixture\\Minecraft Core.ico',
    platform: 'win32',
    shellApi: {
      readShortcutLink(candidate) {
        assert.equal(candidate, shortcutPath);
        return {
          target: 'C:\\stale\\electron.exe',
          appUserModelId: 'com.minecraft-core.app.dev'
        };
      },
      writeShortcutLink(candidate, operation) {
        operations.push({ candidate, operation });
        return true;
      }
    }
  }), true);

  assert.deepEqual(operations, [{ candidate: shortcutPath, operation: 'replace' }]);
});

test('development startup leaves an unrelated shortcut collision untouched', () => {
  const { writeDevelopmentStartMenuShortcut } = loadStartupEntry();
  let writes = 0;
  const warnings = [];

  assert.equal(writeDevelopmentStartMenuShortcut({
    app: {
      isPackaged: false,
      getAppPath: () => 'C:\\fixture\\minecraft-core',
      getPath: () => 'C:\\fixture\\AppData\\Roaming'
    },
    env: { npm_lifecycle_event: 'dev:electron' },
    iconPath: 'C:\\fixture\\Minecraft Core.ico',
    logger: { warn(message) { warnings.push(message); } },
    platform: 'win32',
    shellApi: {
      readShortcutLink() {
        return {
          target: 'C:\\Program Files\\Unrelated\\unrelated.exe',
          args: '--unrelated',
          cwd: 'C:\\Program Files\\Unrelated',
          appUserModelId: 'com.example.unrelated'
        };
      },
      writeShortcutLink() { writes += 1; return true; }
    }
  }), false);

  assert.equal(writes, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unrelated Start Menu shortcut/u);
});

test('development shortcut is a no-op outside real unpackaged Windows startup', async t => {
  const startupEntry = loadStartupEntry();
  const scenarios = [
    { name: 'non-Windows', platform: 'linux', isPackaged: false, env: { npm_lifecycle_event: 'dev:electron' } },
    { name: 'packaged', platform: 'win32', isPackaged: true, env: { npm_lifecycle_event: 'dev:electron' } },
    { name: 'test mode', platform: 'win32', isPackaged: false, env: { npm_lifecycle_event: 'dev:electron', NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1' } }
  ];
  t.after(() => { startupEntry.claimEarlyStartupWindow(); });

  for (const scenario of scenarios) {
    let shortcutWrites = 0;
    await startupEntry.startEarlyStartup({
      app: {
        isPackaged: scenario.isPackaged,
        whenReady: async () => {},
        getPath() { throw new Error(`${scenario.name} must not resolve Start Menu`); },
        getAppPath() { throw new Error(`${scenario.name} must not resolve app path`); }
      },
      env: scenario.env,
      platform: scenario.platform,
      shellApi: { writeShortcutLink() { shortcutWrites += 1; return true; } },
      shouldCreateStartupWindow: () => false,
      loadMain() {}
    });
    assert.equal(shortcutWrites, 0, scenario.name);
  }
});

test('an isolated userData override cannot overwrite the real Windows development shortcut', async t => {
  const startupEntry = loadStartupEntry();
  let shortcutWrites = 0;
  let realStartMenuResolutions = 0;
  const startupWindow = { isDestroyed: () => false };
  t.after(() => { startupEntry.claimEarlyStartupWindow(); });

  await startupEntry.startEarlyStartup({
    app: {
      isPackaged: false,
      setPath() {},
      whenReady: async () => {},
      getPath(name) {
        if (name === 'userData') return 'C:\\isolated\\user-data';
        realStartMenuResolutions += 1;
        return 'C:\\Users\\fixture\\AppData\\Roaming';
      },
      getAppPath() { return 'C:\\fixture\\minecraft-core'; }
    },
    env: {
      npm_lifecycle_event: 'dev:electron',
      MINECRAFT_CORE_USER_DATA_DIR: 'C:\\isolated\\user-data'
    },
    platform: 'win32',
    shellApi: { writeShortcutLink() { shortcutWrites += 1; return true; } },
    shouldCreateStartupWindow: () => true,
    resolveIconPath: () => 'C:\\fixture\\icon.ico',
    prepareIconPath: ({ sourceIconPath }) => sourceIconPath,
    createWindow: () => startupWindow,
    loadMain() {}
  });

  assert.equal(shortcutWrites, 0);
  assert.equal(realStartMenuResolutions, 0);
});

test('development shortcut failures warn and leave first-window startup running', async t => {
  const startupEntry = loadStartupEntry();
  const events = [];
  const warnings = [];
  const startupWindow = { isDestroyed: () => false };
  t.after(() => { startupEntry.claimEarlyStartupWindow(); });

  await startupEntry.startEarlyStartup({
    app: {
      isPackaged: false,
      getAppPath: () => 'C:\\fixture\\minecraft-core',
      getPath(name) { assert.equal(name, 'appData'); return 'C:\\fixture\\AppData\\Roaming'; },
      whenReady() { events.push('app:ready'); return Promise.resolve(); }
    },
    env: { npm_lifecycle_event: 'dev:electron' },
    platform: 'win32',
    shellApi: { writeShortcutLink() { throw new Error('shortcut unavailable'); } },
    logger: { warn(message) { warnings.push(message); } },
    resolveIconPath: () => 'C:\\fixture\\icon.ico',
    createWindow() { events.push('startup:create'); return startupWindow; },
    loadMain() { events.push('main:import'); }
  });

  assert.deepEqual(events, ['app:ready', 'startup:create', 'main:import']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /development Start Menu shortcut/u);
});

test('early entry does not call the Windows AppUserModelID API on non-Windows platforms', async () => {
  const startupEntry = loadStartupEntry();
  const events = [];

  await startupEntry.startEarlyStartup({
    app: {
      setName(value) { events.push(`name:${value}`); },
      setAppUserModelId() { events.push('app-id'); },
      whenReady() { events.push('app:ready'); return Promise.resolve(); }
    },
    platform: 'linux',
    shouldCreateStartupWindow: () => false,
    loadMain() { events.push('main:import'); }
  });

  assert.deepEqual(events, ['name:Minecraft Core', 'app:ready', 'main:import']);
});

test('early identity setup does not repeat identity mutations for the same Electron app', () => {
  const startupEntry = loadStartupEntry();
  const calls = [];
  const app = {
    setName(value) { calls.push(['setName', value]); },
    setAppUserModelId(value) { calls.push(['setAppUserModelId', value]); }
  };

  startupEntry.applyEarlyAppIdentity({ app, platform: 'win32' });
  startupEntry.applyEarlyAppIdentity({ app, platform: 'win32' });

  assert.deepEqual(calls, [
    ['setName', 'Minecraft Core'],
    ['setAppUserModelId', 'com.minecraft-core.app.dev']
  ]);
});

test('packaged and unpackaged Windows startup use different shell identities', () => {
  const startupEntry = loadStartupEntry();
  const developmentCalls = [];
  const packagedCalls = [];

  startupEntry.applyEarlyAppIdentity({
    app: {
      isPackaged: false,
      setAppUserModelId(value) { developmentCalls.push(value); }
    },
    platform: 'win32'
  });
  startupEntry.applyEarlyAppIdentity({
    app: {
      isPackaged: true,
      setAppUserModelId(value) { packagedCalls.push(value); }
    },
    platform: 'win32'
  });

  assert.deepEqual(developmentCalls, ['com.minecraft-core.app.dev']);
  assert.deepEqual(packagedCalls, ['com.minecraft-core.app']);
  assert.notEqual(developmentCalls[0], packagedCalls[0]);
});

test('a failed main import closes and unpublishes the early window before quitting', async t => {
  const startupEntry = loadStartupEntry();
  t.after(() => { startupEntry.claimEarlyStartupWindow(); });
  const events = [];
  const failure = new Error('main import failed');
  const startupWindow = {
    isDestroyed: () => false,
    close() { events.push('startup:close'); }
  };

  await assert.rejects(startupEntry.startEarlyStartup({
    app: {
      whenReady() { events.push('app:ready'); return Promise.resolve(); },
      quit() { events.push('app:quit'); }
    },
    env: {},
    shouldCreateStartupWindow: () => true,
    resolveIconPath: () => null,
    createWindow() { events.push('startup:create'); return startupWindow; },
    loadMain() { events.push('main:import'); throw failure; }
  }), failure);

  assert.deepEqual(events, [
    'app:ready',
    'startup:create',
    'main:import',
    'startup:close',
    'app:quit'
  ]);
  assert.equal(startupEntry.claimEarlyStartupWindow(), null);
});

test('failed startup does not wait indefinitely for asynchronous window cleanup', async t => {
  const startupEntry = loadStartupEntry();
  t.after(() => { startupEntry.claimEarlyStartupWindow(); });
  const events = [];
  const failure = new Error('main import failed');
  const startupWindow = {
    isDestroyed: () => false,
    close() {
      events.push('startup:close');
      return new Promise(() => {});
    }
  };

  const startup = startupEntry.startEarlyStartup({
    app: {
      whenReady: async () => {},
      quit() { events.push('app:quit'); }
    },
    env: {},
    shouldCreateStartupWindow: () => true,
    resolveIconPath: () => null,
    createWindow: () => startupWindow,
    loadMain() { throw failure; }
  });
  const outcome = await Promise.race([
    startup.then(
      () => ({ status: 'resolved' }),
      error => ({ status: 'rejected', error })
    ),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timed-out' }), 100))
  ]);

  assert.deepEqual(outcome, { status: 'rejected', error: failure });
  assert.deepEqual(events, ['startup:close', 'app:quit']);
});

test('a readiness failure quits startup without masking the primary error', async () => {
  const startupEntry = loadStartupEntry();
  const events = [];
  const failure = new Error('electron readiness failed');

  await assert.rejects(startupEntry.startEarlyStartup({
    app: {
      whenReady() { events.push('app:ready'); return Promise.reject(failure); },
      quit() { events.push('app:quit'); }
    },
    env: {},
    loadMain() { events.push('main:import'); }
  }), failure);

  assert.deepEqual(events, ['app:ready', 'app:quit']);
});

test('a userData override failure quits startup without masking the primary error', async () => {
  const startupEntry = loadStartupEntry();
  const events = [];
  const failure = new Error('userData override failed');

  await assert.rejects(startupEntry.startEarlyStartup({
    app: {
      setPath() { events.push('path:set'); throw failure; },
      whenReady() { events.push('app:ready'); return Promise.resolve(); },
      quit() { events.push('app:quit'); }
    },
    env: { MINECRAFT_CORE_USER_DATA_DIR: path.join(os.tmpdir(), 'minecraft-core-failed-user-data') },
    loadMain() { events.push('main:import'); }
  }), failure);

  assert.deepEqual(events, ['path:set', 'app:quit']);
});
