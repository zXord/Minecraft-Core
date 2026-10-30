const test = require('node:test');
const assert = require('node:assert/strict');

const { EventEmitter } = require('node:events');
const {
  applyWindowsTaskbarDetails,
  createStartupPageUrl,
  createStartupWindow,
  createWindowReadyTracker,
  resolveInitialWindowVisibility,
  startApplicationAfterReady,
  waitForStartupWindowDocument
} = require('../electron/utils/startup-window.cjs');

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function startupPageText(url) {
  const prefix = 'data:text/html;charset=utf-8,';
  assert.ok(url.startsWith(prefix), url);
  return decodeURIComponent(url.slice(prefix.length));
}

test('Windows identity notification sees complete relaunch metadata with Electron ID-first setters', () => {
  for (const isPackaged of [false, true]) {
    const properties = {};
    const notifications = [];
    // Electron 42's Chromium binding sets AppID (notifying Explorer) before
    // the other fields in each call. Omitted fields preserve previous values.
    const window = { setAppDetails(details) {
      if (details.appId) {
        properties.appId = details.appId;
        notifications.push({ ...properties });
      }
      for (const key of ['appIconPath', 'appIconIndex', 'relaunchCommand', 'relaunchDisplayName']) {
        if (Object.hasOwn(details, key)) properties[key] = details[key];
      }
    } };
    applyWindowsTaskbarDetails(window, {
      platform: 'win32', isPackaged,
      executablePath: 'C:\\fixture\\Minecraft Core.exe',
      applicationPath: 'C:\\fixture\\app',
      iconPath: 'C:\\fixture\\icon.ico'
    });
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], {
      appId: isPackaged ? 'com.minecraft-core.app' : 'com.minecraft-core.app.dev',
      appIconPath: isPackaged ? 'C:\\fixture\\Minecraft Core.exe' : 'C:\\fixture\\icon.ico',
      appIconIndex: 0,
      relaunchCommand: isPackaged ? '"C:\\fixture\\Minecraft Core.exe"' : '"C:\\fixture\\Minecraft Core.exe" "C:\\fixture\\app"',
      relaunchDisplayName: 'Minecraft Core'
    });
  }
});

test('held background retirement cannot delay main readiness or startup-window closure', async () => {
  let completeRetirement; const retirement = new Promise(resolve => { completeRetirement = resolve; });
  let closed = false; let retirementSettled = false;
  retirement.then(() => { retirementSettled = true; });
  const mainWindow = {};
  const result = await startApplicationAfterReady({
    createStartupWindow: () => ({ close() { closed = true; } }),
    async runMainStartup() { void retirement; return mainWindow; },
    async waitForMainWindowReady(window) { assert.equal(window, mainWindow); }
  });
  assert.equal(result, mainWindow); assert.equal(closed, true); assert.equal(retirementSettled, false);
  completeRetirement(); await retirement;
});

test('Windows taskbar details bind the branded icon to the explicit application identity', () => {
  const calls = [];
  const window = {
    setAppDetails(details) {
      calls.push(details);
    }
  };

  assert.equal(applyWindowsTaskbarDetails(window, {
    platform: 'win32',
    iconPath: 'C:\\fixture\\Minecraft Core.ico',
    executablePath: 'C:\\fixture\\Electron\\electron.exe',
    applicationPath: 'C:\\fixture\\Minecraft Core'
  }), true);
  assert.deepEqual(calls, [{
    appIconPath: 'C:\\fixture\\Minecraft Core.ico',
    appIconIndex: 0,
    relaunchCommand: '"C:\\fixture\\Electron\\electron.exe" "C:\\fixture\\Minecraft Core"',
    relaunchDisplayName: 'Minecraft Core'
  }, { appId: 'com.minecraft-core.app.dev' }]);
});

test('taskbar details do not mutate non-Windows windows', () => {
  let calls = 0;
  assert.equal(applyWindowsTaskbarDetails({ setAppDetails() { calls += 1; } }, {
    platform: 'linux',
    iconPath: '/fixture/icon.png',
    executablePath: '/fixture/electron',
    applicationPath: '/fixture/app'
  }), false);
  assert.equal(calls, 0);
});

test('packaged taskbar details use the physical icon-embedded executable instead of an ASAR path', () => {
  const calls = [];
  const executablePath = 'C:\\Program Files\\Minecraft Core\\Minecraft Core.exe';

  assert.equal(applyWindowsTaskbarDetails({ setAppDetails(details) { calls.push(details); } }, {
    platform: 'win32',
    isPackaged: true,
    executablePath,
    iconPath: 'C:\\Program Files\\Minecraft Core\\resources\\app.asar\\build-resources\\icon.ico'
  }), true);
  assert.deepEqual(calls, [{
    appIconPath: executablePath,
    appIconIndex: 0,
    relaunchCommand: '"C:\\Program Files\\Minecraft Core\\Minecraft Core.exe"',
    relaunchDisplayName: 'Minecraft Core'
  }, { appId: 'com.minecraft-core.app' }]);
});

test('startup window applies Windows taskbar details and loads its local document before it is shown', async () => {
  const events = [];
  let resolveLoad;
  const loaded = new Promise(resolve => { resolveLoad = resolve; });
  class FakeBrowserWindow {
    constructor(options) {
      events.push(['window:create', options.show]);
    }

    setAppDetails(details) {
      events.push(['taskbar:details', details]);
    }

    show() {
      events.push('window:show');
    }

    loadURL() {
      events.push('window:load');
      return loaded;
    }
  }

  const startupWindow = createStartupWindow({
    BrowserWindow: FakeBrowserWindow,
    iconPath: 'C:\\fixture\\Minecraft Core.ico',
    platform: 'win32',
    executablePath: 'C:\\fixture\\Electron\\electron.exe',
    applicationPath: 'C:\\fixture\\Minecraft Core'
  });

  const detailsEvent = ['taskbar:details', {
    appIconPath: 'C:\\fixture\\Minecraft Core.ico',
    appIconIndex: 0,
    relaunchCommand: '"C:\\fixture\\Electron\\electron.exe" "C:\\fixture\\Minecraft Core"',
    relaunchDisplayName: 'Minecraft Core'
  }];
  const identityEvent = ['taskbar:details', { appId: 'com.minecraft-core.app.dev' }];
  assert.deepEqual(events, [
    ['window:create', false],
    detailsEvent,
    identityEvent,
    'window:load'
  ]);

  resolveLoad();
  await waitForStartupWindowDocument(startupWindow);
  assert.deepEqual(events, [
    ['window:create', false],
    detailsEvent,
    identityEvent,
    'window:load',
    'window:show'
  ]);
});

test('a startup document load failure never exposes an unbranded or blank window', async () => {
  let showCalls = 0;
  const failure = new Error('local startup document failed');
  class FakeBrowserWindow {
    setAppDetails() {}
    show() { showCalls += 1; }
    loadURL() { return Promise.reject(failure); }
  }

  const startupWindow = createStartupWindow({
    BrowserWindow: FakeBrowserWindow,
    iconPath: 'C:\\fixture\\Minecraft Core.ico',
    platform: 'win32',
    executablePath: 'C:\\fixture\\Electron\\electron.exe',
    applicationPath: 'C:\\fixture\\Minecraft Core'
  });

  await assert.rejects(waitForStartupWindowDocument(startupWindow), failure);
  assert.equal(showCalls, 0);
});

test('packaged startup window binds taskbar details to the physical executable', () => {
  const calls = [];
  class FakeBrowserWindow {
    setAppDetails(details) { calls.push(details); }
    loadURL() { return Promise.resolve(); }
  }
  const executablePath = 'C:\\Program Files\\Minecraft Core\\Minecraft Core.exe';

  createStartupWindow({
    BrowserWindow: FakeBrowserWindow,
    iconPath: 'C:\\Program Files\\Minecraft Core\\resources\\app.asar\\build-resources\\icon.ico',
    platform: 'win32',
    isPackaged: true,
    executablePath
  });

  assert.equal(calls[0]?.appIconPath, executablePath);
  assert.equal(calls[0]?.relaunchCommand, '"C:\\Program Files\\Minecraft Core\\Minecraft Core.exe"');
  assert.equal(calls[0]?.relaunchDisplayName, 'Minecraft Core');
});

test('startup window is an unprivileged local window', async () => {
  let options;
  let loadedUrl;
  let showCalls = 0;
  class FakeBrowserWindow {
    constructor(value) {
      options = value;
    }

    show() {
      showCalls += 1;
    }

    loadURL(value) {
      loadedUrl = value;
      return Promise.resolve();
    }
  }

  const startupWindow = createStartupWindow({ BrowserWindow: FakeBrowserWindow, iconPath: 'build-resources/icon.ico' });
  await waitForStartupWindowDocument(startupWindow);

  assert.ok(startupWindow instanceof FakeBrowserWindow);
  assert.equal(options.show, false);
  assert.equal(showCalls, 1);
  assert.equal(options.icon, 'build-resources/icon.ico');
  assert.deepEqual(options.webPreferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  });
  assert.equal(Object.hasOwn(options.webPreferences, 'preload'), false);
  assert.match(loadedUrl, /^data:text\/html;charset=utf-8,/u);
});

test('startup window remains visible through recovery and closes once the main window is ready', async () => {
  const events = [];
  let releaseRecovery;
  const recovery = new Promise(resolve => { releaseRecovery = resolve; });
  const startupWindow = { close() { events.push('startup:close'); } };
  const mainWindow = { id: 41 };

  const start = startApplicationAfterReady({
    createStartupWindow() {
      events.push('startup:create');
      return startupWindow;
    },
    runMainStartup: async () => {
      events.push('recovery:begin');
      await recovery;
      events.push('main:create');
      return mainWindow;
    },
    waitForMainWindowReady: async window => {
      assert.equal(window, mainWindow);
      events.push('main:ready');
    }
  });

  await new Promise(resolve => queueMicrotask(resolve));
  assert.deepEqual(events, ['startup:create', 'recovery:begin']);

  releaseRecovery();
  assert.equal(await start, mainWindow);
  assert.deepEqual(events, [
    'startup:create',
    'recovery:begin',
    'main:create',
    'main:ready',
    'startup:close'
  ]);
});

test('main-window readiness is retained when ready-to-show fires before startup orchestration begins waiting', async () => {
  class FakeWindow extends EventEmitter {
    isDestroyed() { return false; }
  }
  const window = new FakeWindow();
  const tracker = createWindowReadyTracker(window);

  window.emit('ready-to-show');

  assert.equal(await tracker.wait(), window);
});

test('startup window closes when recovery prevents the privileged window from opening', async () => {
  const events = [];
  const failure = new Error('recovery failed');
  const startupWindow = { close() { events.push('startup:close'); } };

  await assert.rejects(
    startApplicationAfterReady({
      createStartupWindow() {
        events.push('startup:create');
        return startupWindow;
      },
      runMainStartup: async () => {
        events.push('recovery:begin');
        throw failure;
      },
      waitForMainWindowReady: async () => {
        events.push('main:ready');
      }
    }),
    failure
  );

  assert.deepEqual(events, ['startup:create', 'recovery:begin', 'startup:close']);
});

test('a startup failure hides the main window and awaits the failure hook before the splash closes', async () => {
  const events = [];
  const failure = new Error('main window closed before it became ready');
  const splash = { close() { events.push('splash:close'); } };
  const mainWindow = { isDestroyed: () => false, hide() { events.push('main:hide'); } };
  let releaseHook;
  const hookGate = new Promise(resolve => { releaseHook = resolve; });

  const start = startApplicationAfterReady({
    createStartupWindow: () => splash,
    runMainStartup: async () => mainWindow,
    waitForMainWindowReady: async () => { throw failure; },
    async onStartupFailure(error, context) {
      events.push('hook:start');
      assert.equal(error, failure);
      assert.equal(context.splash, splash);
      assert.equal(context.mainWindow, mainWindow);
      assert.equal(Object.isFrozen(context), true);
      await hookGate;
      events.push('hook:end');
    }
  });

  await tick();
  assert.deepEqual(events, ['main:hide', 'hook:start'], 'the splash stays open while the hook runs');
  releaseHook();
  await assert.rejects(start, error => error === failure);
  assert.deepEqual(events, ['main:hide', 'hook:start', 'hook:end', 'splash:close']);
});

test('a failure after the window was published reports that window through getMainWindow', async () => {
  const events = [];
  const failure = new Error('after-window hook failed');
  const published = { isDestroyed: () => false, hide() { events.push('published:hide'); } };

  await assert.rejects(startApplicationAfterReady({
    createStartupWindow: () => ({ close() { events.push('splash:close'); } }),
    getMainWindow: () => published,
    runMainStartup: async () => { throw failure; },
    waitForMainWindowReady: async () => assert.fail('a failed startup has no window to wait for'),
    onStartupFailure(error, { mainWindow }) {
      assert.equal(error, failure);
      assert.equal(mainWindow, published);
      events.push('hook');
    }
  }), error => error === failure);

  assert.deepEqual(events, ['published:hide', 'hook', 'splash:close']);
});

test('a throwing failure hook cannot mask the startup error or keep the splash open', async () => {
  const events = [];
  const failure = new Error('recovery failed');

  await assert.rejects(startApplicationAfterReady({
    createStartupWindow: () => ({ close() { events.push('splash:close'); } }),
    runMainStartup: async () => { throw failure; },
    waitForMainWindowReady: async () => {},
    onStartupFailure: async () => { events.push('hook'); throw new Error('dialog failed'); }
  }), error => error === failure);

  assert.deepEqual(events, ['hook', 'splash:close']);
});

test('without a failure hook a failed startup leaves an existing main window untouched', async () => {
  const events = [];
  const failure = new Error('not ready');
  const mainWindow = { isDestroyed: () => false, hide() { events.push('main:hide'); } };

  await assert.rejects(startApplicationAfterReady({
    createStartupWindow: () => ({ close() { events.push('splash:close'); } }),
    getMainWindow: () => mainWindow,
    runMainStartup: async () => mainWindow,
    waitForMainWindowReady: async () => { throw failure; }
  }), error => error === failure);

  assert.deepEqual(events, ['splash:close']);
});

test('a splash close failure after a ready main window is not treated as a startup failure', async () => {
  const closeFailure = new Error('close failed');
  let hookCalls = 0;
  const mainWindow = { isDestroyed: () => false, hide() { assert.fail('a ready main window is never hidden'); } };

  await assert.rejects(startApplicationAfterReady({
    createStartupWindow: () => ({}),
    runMainStartup: async () => mainWindow,
    waitForMainWindowReady: async () => {},
    closeStartupWindow: () => { throw closeFailure; },
    onStartupFailure: () => { hookCalls += 1; }
  }), error => error === closeFailure);

  assert.equal(hookCalls, 0);
});

test('startup tolerates a null splash and a splash that cannot be created', async () => {
  const mainWindow = { id: 51 };
  for (const createStartupWindowCase of [() => null, () => { throw new Error('splash failed'); }, async () => { throw new Error('async splash failed'); }]) {
    const closed = [];
    const result = await startApplicationAfterReady({
      createStartupWindow: createStartupWindowCase,
      runMainStartup: async () => mainWindow,
      waitForMainWindowReady: async () => {},
      closeStartupWindow: window => { closed.push(window); }
    });
    assert.equal(result, mainWindow);
    assert.deepEqual(closed, [null]);
  }

  const failure = new Error('recovery failed');
  const contexts = [];
  await assert.rejects(startApplicationAfterReady({
    createStartupWindow: () => null,
    runMainStartup: async () => { throw failure; },
    waitForMainWindowReady: async () => {},
    onStartupFailure: (error, context) => { contexts.push(context); }
  }), error => error === failure);
  assert.deepEqual(contexts, [{ splash: null, mainWindow: null }]);
});

test('initial main-window visibility starts hidden only for a start-minimized login with the setting and a tray', () => {
  for (const startMinimizedArg of [false, true]) {
    for (const startMinimizedSetting of [false, true]) {
      for (const hasTray of [false, true]) {
        for (const degraded of [false, true]) {
          const startsMinimized = startMinimizedArg && startMinimizedSetting && hasTray;
          const expected = startsMinimized ? (degraded ? 'show-inactive' : 'hidden') : 'show';
          assert.equal(
            resolveInitialWindowVisibility({ startMinimizedArg, startMinimizedSetting, hasTray, degraded }),
            expected,
            JSON.stringify({ startMinimizedArg, startMinimizedSetting, hasTray, degraded })
          );
        }
      }
    }
  }
  assert.equal(resolveInitialWindowVisibility(), 'show');
  assert.equal(resolveInitialWindowVisibility({ startMinimizedArg: true, startMinimizedSetting: 1, hasTray: {} }), 'hidden');
});

test('the startup page keeps its default text and escapes a custom progress heading and detail', () => {
  const defaultPage = startupPageText(createStartupPageUrl());
  assert.match(defaultPage, /<h1>Starting Minecraft Core…<\/h1><p>Preparing your workspace<\/p>/u);
  assert.match(defaultPage, /default-src 'none'; style-src 'unsafe-inline'/u);

  const progressPage = startupPageText(createStartupPageUrl({
    heading: 'Downloading Minecraft Core 26.12.1…',
    detail: '<script>alert("x")</script> & 40%'
  }));
  assert.match(progressPage, /<h1>Downloading Minecraft Core 26\.12\.1…<\/h1>/u);
  assert.match(progressPage, /<p>&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; 40%<\/p>/u);
  assert.doesNotMatch(progressPage, /<script>/u);
  assert.match(progressPage, /default-src 'none'/u);
});
