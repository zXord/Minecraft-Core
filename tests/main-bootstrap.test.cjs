const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const { createMainBootstrap } = require('../electron/bootstrap/create-main-bootstrap.cjs');
const { PACKAGED_SMOKE_ARGUMENT, createRuntimeFlags } = require('../electron/bootstrap/runtime-flags.cjs');

test('main retirement readiness requires captured ready-to-show plus loaded navigation and returns false on close/diagnostic', async () => {
  const fs = require('node:fs'); const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const match = source.match(/function waitForWindowNavigationReady\(mainWindow\) \{[\s\S]*?\n\}\r?\n/);
  assert.ok(match, 'main must expose navigation readiness');
  const trackers = new WeakMap(); const navigation = new WeakMap();
  const wait = vm.runInNewContext(`(${match[0]})`, { mainWindowReadyTrackers: trackers, mainWindowNavigationPromises: navigation });
  const make = () => { const window = new EventEmitter(); window.isDestroyed = () => false;
    let ready, load; trackers.set(window, { wait: () => new Promise(r => { ready = r; }) });
    navigation.set(window, new Promise(r => { load = r; })); return { window, ready: () => ready(), load }; };
  const a = make(); let settled = false; const result = wait(a.window).then(v => { settled = true; return v; });
  a.ready(); await Promise.resolve(); assert.equal(settled, false); a.load({ status: 'loaded' }); assert.equal(await result, true);
  const b = make(); let diagnosticSettled = false;
  const diagnostic = wait(b.window).then(value => { diagnosticSettled = true; return value; });
  b.load({ status: 'diagnostic' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(diagnosticSettled, true, 'diagnostic navigation cannot wait forever for ready-to-show');
  assert.equal(await diagnostic, false);
  const c = make(); const closing = wait(c.window); c.window.emit('closed'); assert.equal(await closing, false);
  assert.equal(await wait(new EventEmitter()), false);
});

function recorder(order, name, result) {
  return async (...args) => {
    order.push(name);
    return typeof result === 'function' ? result(...args) : result;
  };
}

function bootstrapFixture({ testMode, packagedSmokeMode = false }) {
  const order = [];
  const userDataPath = path.join(os.tmpdir(), `minecraft-core-main-bootstrap-${testMode ? 'test' : 'production'}`);
  const appCalls = [];
  const app = {
    isPackaged: packagedSmokeMode,
    setName(value) { appCalls.push(['setName', value]); },
    setAppUserModelId(value) { appCalls.push(['setAppUserModelId', value]); },
    setPath(name, value) { appCalls.push(['setPath', name, value]); }
  };
  const window = Object.freeze({ id: 7 });
  const services = {
    updater: { start: recorder(order, 'updater:start'), dispose: recorder(order, 'updater:dispose') },
    tray: { start: recorder(order, 'tray:start'), dispose: recorder(order, 'tray:dispose') },
    watchdog: { start: recorder(order, 'watchdog:start'), dispose: recorder(order, 'watchdog:dispose') },
    nativeNotifications: { start: recorder(order, 'notifications:start'), dispose: recorder(order, 'notifications:dispose') },
    managementServer: { listen: recorder(order, 'management:listen'), dispose: recorder(order, 'management:dispose') }
  };
  const serviceGraph = {
    paths: { userData: userDataPath },
    startup: {
      installSecurity: recorder(order, 'security:install'),
      initializeRecovery: recorder(order, 'recovery:initialize'),
      initializeServerConfig: recorder(order, 'server-config:initialize'),
      cleanupRuntime: recorder(order, 'runtime:cleanup'),
      configureAfterReady: recorder(order, 'security:configure'),
      afterWindowCreated: recorder(order, 'window:after'),
      dispose: recorder(order, 'startup:dispose')
    },
    window: { create: recorder(order, 'window:create', window) },
    ...services
  };
  const runtimeFlags = createRuntimeFlags({
    env: testMode
      ? { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: userDataPath }
      : { NODE_ENV: 'production', MINECRAFT_CORE_TEST_MODE: '1' },
    argv: packagedSmokeMode
      ? ['Minecraft Core.exe', `${PACKAGED_SMOKE_ARGUMENT}=${'c'.repeat(64)}`, `--user-data-dir=${userDataPath}`]
      : ['Minecraft Core.exe'],
    platform: 'win32',
    isPackaged: packagedSmokeMode,
    fsApi: { readFileSync() { return 'c'.repeat(64); }, unlinkSync() {} }
  });
  const bootstrap = createMainBootstrap({ electronApi: { app }, serviceGraph, runtimeFlags });
  return { appCalls, bootstrap, order, runtimeFlags, serviceGraph, userDataPath, window };
}

test('bootstrap onReady finishes while owned post-window retirement remains held', async () => {
  const fixture = bootstrapFixture({ testMode: true });
  let release; const held = new Promise(resolve => { release = resolve; }); let finished = false;
  held.then(() => { finished = true; });
  fixture.serviceGraph.startup.afterWindowCreated = async () => { void held; };
  await fixture.bootstrap.onReady(); assert.equal(finished, false); release(); await held;
});

test('test mode is honored only under NODE_ENV=test and carries an isolated userData path', () => {
  const isolated = path.join(os.tmpdir(), 'minecraft-core-runtime-flags');
  const testFlags = createRuntimeFlags({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: isolated },
    platform: 'win32'
  });
  const productionFlags = createRuntimeFlags({
    env: { NODE_ENV: 'production', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: isolated },
    platform: 'win32'
  });

  assert.deepEqual(testFlags, {
    testMode: true,
    packagedSmokeMode: false,
    packagedSmokeUserDataPath: null,
    platform: 'win32',
    isolatedUserDataPath: path.resolve(isolated),
    updaterEnabled: false,
    automaticReleaseChecksEnabled: false,
    trayEnabled: false,
    watchdogEnabled: false,
    nativeNotificationsEnabled: false,
    publicManagementListenersEnabled: false
  });
  assert.equal(productionFlags.testMode, false);
  assert.equal(productionFlags.isolatedUserDataPath, null);
  assert.equal(productionFlags.updaterEnabled, true);
  assert.equal(productionFlags.publicManagementListenersEnabled, true);
  assert.equal(Object.isFrozen(testFlags), true);
});

test('an authenticated isolated real-E2E launch keeps production services but suppresses native notifications', () => {
  const root = path.join(os.tmpdir(), 'minecraft-core-real-notification-isolation-e2e-fixture');
  const userDataPath = path.join(root, 'user-data');
  const flags = createRuntimeFlags({
    env: {
      NODE_ENV: 'development',
      MINECRAFT_CORE_USER_DATA_DIR: userDataPath,
      MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS: '1'
    },
    argv: ['electron.exe', '.', `--minecraft-core-real-e2e-root=${root}`],
    platform: 'win32',
    isPackaged: false
  });

  assert.equal(flags.testMode, false);
  assert.equal(flags.nativeNotificationsEnabled, false);
  assert.equal(flags.automaticReleaseChecksEnabled, true);
  assert.equal(flags.watchdogEnabled, true);
  assert.equal(flags.publicManagementListenersEnabled, true);
});

test('a mismatched or packaged real-E2E argument cannot suppress production notifications', () => {
  const root = path.join(os.tmpdir(), 'minecraft-core-real-notification-isolation-e2e-fixture');
  const unrelatedUserData = path.join(os.tmpdir(), 'minecraft-core-unrelated-user-data');
  const argv = ['Minecraft Core.exe', `--minecraft-core-real-e2e-root=${root}`];

  assert.equal(createRuntimeFlags({
    env: { NODE_ENV: 'development', MINECRAFT_CORE_USER_DATA_DIR: unrelatedUserData },
    argv,
    platform: 'win32',
    isPackaged: false
  }).nativeNotificationsEnabled, true);
  assert.equal(createRuntimeFlags({
    env: { NODE_ENV: 'development', MINECRAFT_CORE_USER_DATA_DIR: path.join(root, 'user-data') },
    argv,
    platform: 'win32',
    isPackaged: false
  }).nativeNotificationsEnabled, true);
  assert.equal(createRuntimeFlags({
    env: {
      NODE_ENV: 'development',
      MINECRAFT_CORE_USER_DATA_DIR: path.join(root, 'user-data'),
      MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS: '1'
    },
    argv,
    platform: 'win32',
    isPackaged: true
  }).nativeNotificationsEnabled, true);
});

test('a harness-shaped real-E2E child whose TEMP lives inside the isolated root suppresses native notifications', () => {
  const nestedRoot = path.join(os.tmpdir(), 'minecraft-core-harness-parent', 'minecraft-core-real-lifecycle-e2e-a64');
  const harnessRoot = path.join(os.tmpdir(), 'minecraft-core-real-lifecycle-e2e-a64');
  for (const root of [nestedRoot, harnessRoot]) {
    const childTemp = path.join(root, 'environment', 'temp');
    const flags = createRuntimeFlags({
      env: {
        NODE_ENV: 'development',
        MINECRAFT_CORE_USER_DATA_DIR: path.join(root, 'user-data'),
        MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS: '1',
        TEMP: childTemp,
        TMP: childTemp
      },
      argv: ['electron.exe', '.', `--minecraft-core-real-e2e-root=${root}`],
      platform: 'win32',
      isPackaged: false,
      tempDirectory: childTemp
    });

    assert.equal(flags.nativeNotificationsEnabled, false, root);
    assert.equal(flags.testMode, false);
    assert.equal(flags.watchdogEnabled, true);
    assert.equal(flags.automaticReleaseChecksEnabled, true);
    assert.equal(flags.publicManagementListenersEnabled, true);
  }
});

test('a TEMP redirect only honours a real-E2E root that strictly contains it and passes every other gate', () => {
  const root = path.join(os.tmpdir(), 'minecraft-core-harness-parent', 'minecraft-core-real-gates-e2e-a64');
  const childTemp = path.join(root, 'environment', 'temp');
  const env = {
    NODE_ENV: 'development',
    MINECRAFT_CORE_USER_DATA_DIR: path.join(root, 'user-data'),
    MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS: '1'
  };
  const argv = ['electron.exe', '.', `--minecraft-core-real-e2e-root=${root}`];
  const flags = overrides => createRuntimeFlags({ env, argv, platform: 'win32', isPackaged: false, tempDirectory: childTemp, ...overrides });

  assert.equal(flags({}).nativeNotificationsEnabled, false);
  assert.equal(flags({ tempDirectory: path.join(os.tmpdir(), 'elsewhere', 'temp') }).nativeNotificationsEnabled, true);
  assert.equal(flags({ tempDirectory: root }).nativeNotificationsEnabled, true, 'the root itself is not inside the root');
  assert.equal(flags({ tempDirectory: `${root}-sibling` }).nativeNotificationsEnabled, true);
  assert.equal(flags({ isPackaged: true }).nativeNotificationsEnabled, true);
  assert.equal(flags({ env: { ...env, NODE_ENV: 'production' } }).nativeNotificationsEnabled, true);
  assert.equal(flags({ env: { ...env, MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS: '0' } }).nativeNotificationsEnabled, true);
  assert.equal(flags({ env: { ...env, MINECRAFT_CORE_USER_DATA_DIR: path.join(os.tmpdir(), 'other-user-data') } }).nativeNotificationsEnabled, true);
  assert.equal(flags({ argv: [...argv, `--minecraft-core-real-e2e-root=${root}`] }).nativeNotificationsEnabled, true);

  const unprefixed = path.join(os.tmpdir(), 'minecraft-core-harness-parent', 'unrelated-root');
  assert.equal(createRuntimeFlags({
    env: { ...env, MINECRAFT_CORE_USER_DATA_DIR: path.join(unprefixed, 'user-data') },
    argv: ['electron.exe', '.', `--minecraft-core-real-e2e-root=${unprefixed}`],
    platform: 'win32',
    isPackaged: false,
    tempDirectory: path.join(unprefixed, 'environment', 'temp')
  }).nativeNotificationsEnabled, true);
  assert.throws(() => createRuntimeFlags({ env, argv, platform: 'win32', tempDirectory: '' }), TypeError);
});

test('packaged binaries ignore test-mode environment flags', () => {
  const isolated = path.join(os.tmpdir(), 'minecraft-core-packaged-test-attempt');
  const flags = createRuntimeFlags({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: isolated },
    platform: 'win32',
    isPackaged: true
  });

  assert.equal(flags.testMode, false);
  assert.equal(flags.isolatedUserDataPath, null);
  assert.equal(flags.updaterEnabled, true);
  assert.equal(flags.publicManagementListenersEnabled, true);
});

test('an exact packaged smoke argument disables automatic network services without enabling test composition', () => {
  assert.equal(PACKAGED_SMOKE_ARGUMENT, '--minecraft-core-packaged-smoke');
  const smokeUserData = path.resolve(os.tmpdir(), 'minecraft-core-authorized-smoke');
  const nonce = 'a'.repeat(64);
  const flags = createRuntimeFlags({
    env: { NODE_ENV: 'production', MINECRAFT_CORE_TEST_MODE: '1' },
    argv: ['Minecraft Core.exe', `${PACKAGED_SMOKE_ARGUMENT}=${nonce}`, `--user-data-dir=${smokeUserData}`],
    platform: 'win32',
    isPackaged: true,
    fsApi: { readFileSync(filePath) {
      assert.equal(filePath, path.join(smokeUserData, '.minecraft-core-packaged-smoke'));
      return nonce;
    }, unlinkSync(filePath) {
      assert.equal(filePath, path.join(smokeUserData, '.minecraft-core-packaged-smoke'));
    } }
  });

  assert.equal(flags.testMode, false);
  assert.equal(flags.packagedSmokeMode, true);
  assert.equal(flags.packagedSmokeUserDataPath, smokeUserData);
  assert.equal(flags.updaterEnabled, false);
  assert.equal(flags.automaticReleaseChecksEnabled, false);
  assert.equal(flags.publicManagementListenersEnabled, false);
});

test('a packaged smoke argument without its exact userData nonce marker cannot alter production services', () => {
  const smokeUserData = path.resolve(os.tmpdir(), 'minecraft-core-unauthorized-smoke');
  const flags = createRuntimeFlags({
    argv: ['Minecraft Core.exe', `${PACKAGED_SMOKE_ARGUMENT}=${'b'.repeat(64)}`, `--user-data-dir=${smokeUserData}`],
    isPackaged: true,
    fsApi: { readFileSync() { throw new Error('missing'); }, unlinkSync() {} }
  });
  assert.equal(flags.packagedSmokeMode, false);
  assert.equal(flags.updaterEnabled, true);
  assert.equal(flags.automaticReleaseChecksEnabled, true);
  assert.equal(flags.publicManagementListenersEnabled, true);
});

test('test mode cannot accidentally start updater or public services', async () => {
  const { appCalls, bootstrap, order, userDataPath, window } = bootstrapFixture({ testMode: true });

  bootstrap.initializeBeforeReady();
  const result = await bootstrap.onReady();

  assert.equal(result, window);
  assert.deepEqual(appCalls, [
    ['setPath', 'userData', userDataPath],
    ['setName', 'Minecraft Core'],
    ['setAppUserModelId', 'com.minecraft-core.app.dev']
  ]);
  assert.deepEqual(order, [
    'security:install',
    'recovery:initialize',
    'server-config:initialize',
    'runtime:cleanup',
    'security:configure',
    'window:create',
    'window:after'
  ]);
  assert.equal(order.includes('updater:start'), false);
  assert.equal(order.includes('management:listen'), false);
  assert.equal(order.includes('tray:start'), false);
  assert.equal(order.includes('watchdog:start'), false);
  assert.equal(order.includes('notifications:start'), false);
});

test('production starts supervision before recovery and disposes services in reverse order idempotently', async () => {
  const { bootstrap, order } = bootstrapFixture({ testMode: false });

  bootstrap.initializeBeforeReady();
  await Promise.all([bootstrap.onReady(), bootstrap.onReady()]);
  await bootstrap.dispose();
  await bootstrap.dispose();

  assert.deepEqual(order, [
    'security:install',
    'watchdog:start',
    'recovery:initialize',
    'server-config:initialize',
    'runtime:cleanup',
    'security:configure',
    'tray:start',
    'window:create',
    'window:after',
    'updater:start',
    'notifications:start',
    'management:listen',
    'management:dispose',
    'notifications:dispose',
    'updater:dispose',
    'tray:dispose',
    'watchdog:dispose',
    'startup:dispose'
  ]);
});

test('after-window setup runs immediately after window publication and before updater startup', async () => {
  const { bootstrap, order } = bootstrapFixture({ testMode: false });

  await bootstrap.onReady();

  const windowIndex = order.indexOf('window:create');
  assert.notEqual(windowIndex, -1);
  assert.deepEqual(order.slice(windowIndex, windowIndex + 3), [
    'window:create',
    'window:after',
    'updater:start'
  ]);
});

test('production watchdog supervision is active before recovery can launch app-owned processes', async () => {
  const { bootstrap, order } = bootstrapFixture({ testMode: false });

  await bootstrap.onReady();

  assert.ok(order.indexOf('watchdog:start') < order.indexOf('recovery:initialize'));
});

test('packaged smoke retains production local services but cannot start automatic network services', async () => {
  const { bootstrap, order, runtimeFlags } = bootstrapFixture({ testMode: false, packagedSmokeMode: true });

  await bootstrap.onReady();

  assert.equal(runtimeFlags.testMode, false);
  assert.equal(runtimeFlags.packagedSmokeMode, true);
  assert.equal(order.includes('updater:start'), false);
  assert.equal(order.includes('management:listen'), false);
  assert.equal(order.includes('tray:start'), true);
  assert.equal(order.includes('watchdog:start'), true);
  assert.equal(order.includes('notifications:start'), true);
});

test('startup emits structured phase markers while keeping main window creation behind recovery', async () => {
  const phases = [];
  const userDataPath = path.join(os.tmpdir(), 'minecraft-core-startup-timing');
  const runtimeFlags = createRuntimeFlags({ env: { NODE_ENV: 'production' }, platform: 'win32' });
  const bootstrap = createMainBootstrap({
    electronApi: { app: { setName() {}, setAppUserModelId() {} } },
    serviceGraph: {
      paths: { userData: userDataPath },
      startup: {
        markTiming(phase) { phases.push(phase); },
        async initializeRecovery() { phases.push('recovery:work'); },
        async initializeServerConfig() { phases.push('server-config:work'); },
        async cleanupRuntime() { phases.push('cleanup:work'); }
      },
      window: { create() { phases.push('window:work'); return { id: 99 }; } }
    },
    runtimeFlags
  });

  await bootstrap.onReady();

  assert.deepEqual(phases, [
    'recovery:start',
    'recovery:work',
    'recovery:complete',
    'server-config:start',
    'server-config:work',
    'server-config:complete',
    'cleanup:start',
    'cleanup:work',
    'cleanup:complete',
    'main-window:create:start',
    'window:work',
    'main-window:create:complete'
  ]);
});

test('startup fails closed before window creation when no recovery boundary is injected', async () => {
  let windowsCreated = 0;
  const runtimeFlags = createRuntimeFlags({ env: { NODE_ENV: 'production' }, platform: 'win32' });
  const bootstrap = createMainBootstrap({
    electronApi: { app: { setName() {}, setAppUserModelId() {} } },
    serviceGraph: {
      paths: { userData: path.join(os.tmpdir(), 'minecraft-core-no-recovery') },
      window: { create() { windowsCreated += 1; return {}; } }
    },
    runtimeFlags
  });

  await assert.rejects(bootstrap.onReady(), /recovery/i);
  assert.equal(windowsCreated, 0);
});

function degradableFixture({ startup = {}, services = {}, recoveryError = new Error('ArchiveWorker.exe is missing') } = {}) {
  const order = [];
  const phases = [];
  const issues = [];
  const degradedCalls = [];
  const window = Object.freeze({ id: 31 });
  const step = name => async () => { order.push(name); };
  const serviceGraph = {
    paths: { userData: path.join(os.tmpdir(), 'minecraft-core-degraded-bootstrap') },
    startup: {
      markTiming(phase) { phases.push(phase); },
      async initializeRecovery() { order.push('recovery'); throw recoveryError; },
      async enterDegradedMode(error, graph) {
        order.push('degraded');
        degradedCalls.push({ error, graph });
        return { mode: 'degraded' };
      },
      reportStartupIssue(stage, error) { issues.push({ stage, error }); },
      initializeServerConfig: step('server-config'),
      cleanupRuntime: step('cleanup'),
      configureAfterReady: step('configure'),
      afterWindowCreated: step('window:after'),
      ...startup
    },
    window: { async create() { order.push('window:create'); return window; } },
    watchdog: { start: step('watchdog') },
    tray: { start: step('tray') },
    updater: { start: step('updater:start') },
    nativeNotifications: { start: step('notifications:start') },
    managementServer: { listen: step('management:listen') },
    ...services
  };
  const bootstrap = createMainBootstrap({
    electronApi: { app: { setName() {}, setAppUserModelId() {} } },
    serviceGraph,
    runtimeFlags: createRuntimeFlags({ env: { NODE_ENV: 'production' }, platform: 'win32' })
  });
  return { bootstrap, degradedCalls, issues, order, phases, recoveryError, serviceGraph, window };
}

const FULL_STARTUP_AFTER_RECOVERY = [
  'server-config', 'cleanup', 'configure', 'tray', 'window:create', 'window:after',
  'updater:start', 'notifications:start', 'management:listen'
];

test('a recovery failure enters degraded mode and still opens the window and starts the updater', async () => {
  const { bootstrap, degradedCalls, issues, order, phases, recoveryError, serviceGraph, window } = degradableFixture();

  assert.equal(await bootstrap.onReady(), window);

  assert.deepEqual(order, ['watchdog', 'recovery', 'degraded', ...FULL_STARTUP_AFTER_RECOVERY]);
  assert.equal(degradedCalls.length, 1);
  assert.equal(degradedCalls[0].error, recoveryError, 'degraded mode receives the original recovery error');
  assert.equal(degradedCalls[0].graph, serviceGraph);
  assert.deepEqual(issues, []);
  assert.deepEqual(phases.slice(0, 4), ['recovery:start', 'recovery:complete', 'recovery:degraded:start', 'recovery:degraded:complete']);
  assert.equal(await bootstrap.createWindowAfterRecovery(), window, 'window activation works after a degraded start');
});

test('a graph without a degraded mode still fails closed when recovery fails', async () => {
  const { bootstrap, issues, order, recoveryError } = degradableFixture({ startup: { enterDegradedMode: undefined } });

  await assert.rejects(bootstrap.onReady(), error => error === recoveryError);
  assert.deepEqual(order, ['watchdog', 'recovery']);
  assert.deepEqual(issues, []);
});

test('a rejecting degraded mode is fatal, keeps the original recovery error and reports the degraded failure', async () => {
  const degradedFailure = new Error('degraded gate failed');
  const { bootstrap, issues, order, recoveryError } = degradableFixture({
    startup: { async enterDegradedMode() { throw degradedFailure; } }
  });

  await assert.rejects(bootstrap.onReady(), error => error === recoveryError);
  assert.deepEqual(order, ['watchdog', 'recovery']);
  assert.deepEqual(issues, [{ stage: 'recovery:degraded', error: degradedFailure }]);
});

test('each optional startup stage failure is reported while every later stage still runs', async () => {
  const cases = [
    { stage: 'server-config', at: 'server-config', fail: failure => ({ startup: { async initializeServerConfig() { throw failure; } } }) },
    { stage: 'cleanup', at: 'cleanup', fail: failure => ({ startup: { async cleanupRuntime() { throw failure; } } }) },
    { stage: 'updater:start', at: 'updater:start', fail: failure => ({ services: { updater: { start() { throw failure; } } } }) },
    { stage: 'nativeNotifications:start', at: 'notifications:start', fail: failure => ({ services: { nativeNotifications: { async start() { throw failure; } } } }) },
    { stage: 'managementServer:listen', at: 'management:listen', fail: failure => ({ services: { managementServer: { async listen() { throw failure; } } } }) }
  ];
  for (const { stage, at, fail } of cases) {
    const failure = new Error(`${stage} failed`);
    const overrides = fail(failure);
    const { bootstrap, issues, order, window } = degradableFixture({
      startup: { async initializeRecovery() { order.push('recovery'); }, ...overrides.startup },
      services: overrides.services
    });

    assert.equal(await bootstrap.onReady(), window, stage);
    assert.deepEqual(order, ['watchdog', 'recovery', ...FULL_STARTUP_AFTER_RECOVERY.filter(name => name !== at)], stage);
    assert.deepEqual(issues, [{ stage, error: failure }], stage);
    await bootstrap.dispose();
  }
});

test('a throwing issue reporter cannot turn an optional stage failure into a fatal one', async () => {
  const { bootstrap, order, window } = degradableFixture({
    startup: {
      async initializeRecovery() { order.push('recovery'); },
      async initializeServerConfig() { throw new Error('server config unreadable'); },
      reportStartupIssue() { throw new Error('logger unavailable'); }
    }
  });

  assert.equal(await bootstrap.onReady(), window);
  assert.deepEqual(order, ['watchdog', 'recovery', ...FULL_STARTUP_AFTER_RECOVERY.filter(name => name !== 'server-config')]);
});

test('watchdog, after-ready configuration, tray, window creation and after-window setup stay fatal', async () => {
  const cases = [
    ['watchdog', failure => ({ services: { watchdog: { start() { throw failure; } } } })],
    ['configure', failure => ({ startup: { configureAfterReady() { throw failure; } } })],
    ['tray', failure => ({ services: { tray: { async start() { throw failure; } } } })],
    ['window', failure => ({ services: { window: { async create() { throw failure; } } } })],
    ['after-window', failure => ({ startup: { async afterWindowCreated() { throw failure; } } })]
  ];
  for (const [name, fail] of cases) {
    const failure = new Error(`${name} failed`);
    const overrides = fail(failure);
    const { bootstrap, issues, order } = degradableFixture({
      startup: { async initializeRecovery() {}, ...overrides.startup },
      services: overrides.services
    });

    await assert.rejects(bootstrap.onReady(), error => error === failure, name);
    assert.deepEqual(issues, [], name);
    assert.equal(order.includes('updater:start'), false, name);
  }
});

test('startup adopts a window published by a void factory before after-window hooks', async () => {
  const userDataPath = path.join(os.tmpdir(), 'minecraft-core-void-window-factory');
  const window = Object.freeze({ id: 17 });
  let publishedWindow = null;
  let observedWindow = null;
  const runtimeFlags = createRuntimeFlags({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: userDataPath },
    platform: 'win32'
  });
  const bootstrap = createMainBootstrap({
    electronApi: {
      app: { setName() {}, setAppUserModelId() {}, setPath() {} }
    },
    serviceGraph: {
      paths: { userData: userDataPath },
      startup: {
        async initializeRecovery() {},
        afterWindowCreated(value) { observedWindow = value; }
      },
      window: {
        create() { publishedWindow = window; },
        get() { return publishedWindow; }
      }
    },
    runtimeFlags
  });

  const result = await bootstrap.onReady();

  assert.equal(result, window);
  assert.equal(observedWindow, window);
});

test('window recreation adopts a replacement published by a void factory', async () => {
  const userDataPath = path.join(os.tmpdir(), 'minecraft-core-void-window-recreation');
  const windows = [Object.freeze({ id: 21 }), Object.freeze({ id: 22 })];
  const observedWindows = [];
  let publishedWindow = null;
  let createCount = 0;
  const runtimeFlags = createRuntimeFlags({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: userDataPath },
    platform: 'win32'
  });
  const bootstrap = createMainBootstrap({
    electronApi: {
      app: { setName() {}, setAppUserModelId() {}, setPath() {} }
    },
    serviceGraph: {
      paths: { userData: userDataPath },
      startup: {
        async initializeRecovery() {},
        afterWindowCreated(value) { observedWindows.push(value); }
      },
      window: {
        create() {
          publishedWindow = windows[createCount];
          createCount += 1;
        },
        get() { return publishedWindow; }
      }
    },
    runtimeFlags
  });

  assert.equal(await bootstrap.onReady(), windows[0]);
  publishedWindow = null;

  const replacement = await bootstrap.createWindowAfterRecovery();

  assert.equal(replacement, windows[1]);
  assert.deepEqual(observedWindows, windows);
});

test('startup rejects a factory that neither returns nor publishes a window', async () => {
  const userDataPath = path.join(os.tmpdir(), 'minecraft-core-missing-window-publication');
  let afterWindowCalls = 0;
  const runtimeFlags = createRuntimeFlags({
    env: { NODE_ENV: 'test', MINECRAFT_CORE_TEST_MODE: '1', MINECRAFT_CORE_USER_DATA_DIR: userDataPath },
    platform: 'win32'
  });
  const bootstrap = createMainBootstrap({
    electronApi: {
      app: { setName() {}, setAppUserModelId() {}, setPath() {} }
    },
    serviceGraph: {
      paths: { userData: userDataPath },
      startup: {
        async initializeRecovery() {},
        afterWindowCreated() { afterWindowCalls += 1; }
      },
      window: {
        create() {},
        get() { return null; }
      }
    },
    runtimeFlags
  });

  await assert.rejects(bootstrap.onReady(), /did not publish a window/u);
  assert.equal(afterWindowCalls, 0);
});

const mainImportCheckpoints = [
  ['path', 'main:import:path:complete'],
  ['electron', 'main:import:electron:complete'],
  ['fs', 'main:import:fs:complete'],
  ['./bootstrap/runtime-flags.cjs', 'main:import:runtime-flags:complete'],
  ['./bootstrap/packaged-smoke-guard.cjs', 'main:import:packaged-smoke-guard:complete'],
  ['./bootstrap/create-main-bootstrap.cjs', 'main:import:main-bootstrap:complete'],
  ['./bootstrap/create-modpack-service-graph.cjs', 'main:import:modpack-service-graph:complete'],
  ['./bootstrap/load-test-modpack-factory.cjs', 'main:import:test-modpack-factory:complete'],
  ['./utils/app-cleanup.cjs', 'main:import:app-cleanup:complete'],
  ['./utils/safe-send.cjs', 'main:import:safe-send:complete'],
  ['./utils/app-store.cjs', 'main:import:app-store:complete'],
  ['./utils/navigation-policy.cjs', 'main:import:navigation-policy:complete'],
  ['./utils/runtime-paths.cjs', 'main:import:runtime-paths:complete'],
  ['./utils/tls-utils.cjs', 'main:import:tls-utils:complete'],
  ['./utils/runtime-mode.cjs', 'main:import:runtime-mode:complete'],
  ['./utils/renderer-loader.cjs', 'main:import:renderer-loader:complete'],
  ['./utils/asset-resolver.cjs', 'main:import:asset-resolver:complete'],
  ['./utils/orderly-quit-barrier.cjs', 'main:import:orderly-quit-barrier:complete'],
  ['./utils/startup-window.cjs', 'main:import:startup-window:complete'],
  ['./startup-entry.cjs', 'main:import:startup-entry:complete'],
  ['./services/update-service.cjs', 'main:import:update-service:complete'],
  ['./services/server-mutation-context.cjs', 'main:import:server-mutation-context:complete'],
  ['../config/dev-config.cjs', 'main:import:dev-config:complete']
];

async function mainEntryFixture(inspect = async () => {}, { traceEnabled = false, brokenSink = false, ipcError = null, listenerError = null, ipcModuleError = null, loggerNull = false } = {}) {
  const mainPath = path.resolve(__dirname, '../electron/main.cjs');
  const originalLoad = Module._load;
  const calls = [];
  const boundaries = [];
  const traceLines = [];
  const importEvents = [];
  let capturedGraphDependencies;
  let publishedWindow;
  let finishNavigation;
  const navigation = new Promise(resolve => { finishNavigation = resolve; });
  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.id = 101;
      this.webContents = new EventEmitter();
      publishedWindow = this;
      boundaries.push('browser-window:work');
    }
    isDestroyed() { return false; }
    show() { boundaries.push('window:show'); }
    static fromWebContents() { return null; }
    static getAllWindows() { return []; }
  }
  const appHandlers = new Map();
  const pendingReady = new Promise(() => {});
  let finishDisposal;
  const disposal = new Promise(resolve => { finishDisposal = resolve; });
  const app = {
    isPackaged: false,
    getVersion: () => 'test',
    getPath: () => path.join(os.tmpdir(), 'minecraft-core-main-entry'),
    on(name, handler) { appHandlers.set(name, handler); },
    quit() { calls.push('app:quit'); },
    setName: () => {},
    setAppUserModelId: () => {},
    setPath: () => {},
    whenReady() { calls.push('app:when-ready'); return pendingReady; }
  };
  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    Menu: { setApplicationMenu: () => {} },
    Tray: function FakeTray() {},
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    session: { defaultSession: { setCertificateVerifyProc: () => {} } },
    shell: { openExternal: async () => {}, openPath: async () => '' }
  };
  const store = { get: () => null, set: () => {} };
  const runtimeFlags = { testMode: false };
  const graph = { id: 'graph', installSecurity: null };
  const bootstrap = {
    initializeBeforeReady() {
      calls.push('bootstrap:initialize');
      boundaries.push('before-ready:work');
      graph.installSecurity();
    },
    onReady() { calls.push('bootstrap:ready'); },
    dispose() { calls.push('bootstrap:dispose'); return disposal; }
  };

  function loadMainFixture(request, parent, isMain) {
    if (request === './utils/startup-trace.cjs' && parent.filename === mainPath) {
      const { createStartupTrace } = originalLoad(request, parent, isMain);
      return { markStartupTrace: createStartupTrace({
        env: traceEnabled ? { MINECRAFT_CORE_STARTUP_TRACE: '1' } : {},
        now: () => 100, utcNow: () => '2026-10-09T00:00:00.000Z', pid: 123,
        sink(line) {
          if (brokenSink) throw new Error('PRIVATE_SINK_FAILURE');
          traceLines.push(line);
          const marker = JSON.parse(line.slice('[Minecraft Core startup trace] '.length)).marker;
          boundaries.push(marker);
          if (marker === 'main:entry' || marker === 'main:imports:complete' || marker.startsWith('main:import:')) {
            importEvents.push(marker);
          }
        }
      }) };
    }
    if (request === 'electron') return electron;
    if (request === './ipc-handlers.cjs') {
      calls.push('ipc-module:load');
      boundaries.push('ipc-module:load');
      if (ipcModuleError) throw ipcModuleError;
      return { setupIpcHandlers(window, suppliedGraph) {
        assert.equal(window, publishedWindow);
        assert.equal(suppliedGraph, graph);
        boundaries.push('ipc:setup');
        if (ipcError) throw ipcError;
      } };
    }
    if (request === './services/auto-restart.cjs') return { initializeAutoRestartListeners() {
      boundaries.push('listeners:initialize');
      if (listenerError) throw listenerError;
    } };
    if (request === './utils/asset-resolver.cjs') return { resolveWindowIconPath: () => null };
    if (request === './utils/renderer-loader.cjs') return { loadRendererContent(options) {
      assert.equal(options.window, publishedWindow);
      boundaries.push('navigation:work');
      return navigation;
    } };
    if (request === './utils/app-cleanup.cjs') return { setupAppCleanup: () => {} };
    if (request === './utils/safe-send.cjs') return { setMainWindow: () => {} };
    if (request === './utils/app-store.cjs') return store;
    if (request === './utils/config-manager.cjs') return { ensureConfigFile: () => {} };
    if (request === './utils/navigation-policy.cjs') return { shouldAllowNavigation: () => false };
    if (request === './utils/runtime-paths.cjs') return { cleanupRuntimeFiles: () => {} };
    if (request === './utils/tls-utils.cjs') return { getTlsFingerprint: () => null, normalizeFingerprint: value => value };
    if (request === './utils/runtime-mode.cjs') return { shouldUseDevServer: () => false };
    if (request === './services/update-service.cjs') return { getUpdateService: () => ({ startPeriodicChecks: () => {} }) };
    if (request === './services/server-mutation-coordinator.cjs') return { ServerMutationCoordinator: class {} };
    if (request === './services/server-mutation-context.cjs') return { installServerMutationCoordinator: () => {} };
    if (request === './services/logger-service.cjs') return { getLogger() {
      if (loggerNull) throw new Error('PRIVATE_LOGGER_FAILURE');
      return { info: () => {}, fatal: () => {}, debug: () => {}, warn: () => {} };
    } };
    if (request === '../config/dev-config.cjs') { boundaries.push('imports:last'); return { enableDevConsole: false, enableDevServer: false }; }
    if (request === './bootstrap/runtime-flags.cjs') return {
      createRuntimeFlags() { calls.push('flags:create'); return runtimeFlags; }
    };
    if (request === './bootstrap/create-modpack-service-graph.cjs') {
      calls.push('graph-module:load');
      return {
        createModpackServiceGraph(dependencies) {
          calls.push('graph:create');
          boundaries.push('graph:work');
          capturedGraphDependencies = dependencies;
          assert.equal(dependencies.app, app);
          assert.equal(dependencies.store, store);
          graph.installSecurity = dependencies.startup.installSecurity;
          return graph;
        }
      };
    }
    if (request === './bootstrap/create-main-bootstrap.cjs') {
      calls.push('bootstrap-module:load');
      return {
        createMainBootstrap(dependencies) {
          calls.push('bootstrap:create');
          assert.equal(dependencies.electronApi.app, app);
          assert.equal(dependencies.serviceGraph, graph);
          assert.equal(dependencies.runtimeFlags, runtimeFlags);
          return bootstrap;
        }
      };
    }
    return originalLoad(request, parent, isMain);
  }
  Module._load = function observeMainImports(request, parent, isMain) {
    const result = loadMainFixture.call(this, request, parent, isMain);
    if (parent?.filename === mainPath && mainImportCheckpoints.some(([expected]) => expected === request)) {
      importEvents.push(`import:return:${request}`);
    }
    return result;
  };
  delete require.cache[mainPath];
  try {
    require(mainPath);
    assert.deepEqual(calls, [
      'flags:create',
      'bootstrap-module:load',
      'graph-module:load',
      'graph:create',
      'bootstrap:create',
      'bootstrap:initialize',
      'app:when-ready'
    ]);
    await inspect({ boundaries, traceLines, importEvents, dependencies: capturedGraphDependencies,
      getWindow: () => publishedWindow, finishNavigation });
    const firstQuit = { prevented: 0, preventDefault() { this.prevented += 1; } };
    appHandlers.get('before-quit')(firstQuit);
    assert.equal(firstQuit.prevented, 1);
    assert.equal(calls.filter(value => value === 'bootstrap:dispose').length, 1);
    assert.equal(calls.includes('app:quit'), false);

    finishDisposal();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(value => value === 'app:quit').length, 1);

    const reentry = { prevented: 0, preventDefault() { this.prevented += 1; } };
    appHandlers.get('before-quit')(reentry);
    assert.equal(reentry.prevented, 0);
    assert.equal(calls.filter(value => value === 'bootstrap:dispose').length, 1);
  } finally {
    delete require.cache[mainPath];
    Module._load = originalLoad;
  }
}

test('production main entry delegates lifecycle ownership and holds quit until bootstrap disposal settles', async () => {
  await mainEntryFixture();
});

test('startup trace real main emits each fixed import checkpoint only after its require returns in original order', async () => {
  await mainEntryFixture(async ({ importEvents }) => {
    assert.deepEqual(importEvents, [
      'main:entry',
      ...mainImportCheckpoints.flatMap(([request, marker]) => [`import:return:${request}`, marker]),
      'main:imports:complete'
    ]);
  }, { traceEnabled: true, loggerNull: true });
});

test('startup trace real main brackets imports graph before-ready and forwards timing without a logger or details', async () => {
  await mainEntryFixture(async ({ boundaries, traceLines, dependencies }) => {
    assert.deepEqual(boundaries.filter(marker => !marker.startsWith('main:import:')), [
      'main:entry', 'imports:last', 'main:imports:complete', 'main:graph:start', 'graph:work',
      'main:graph:complete', 'main:before-ready:start', 'before-ready:work', 'main:before-ready:complete'
    ]);
    dependencies.startup.markTiming('recovery:start', { path: 'PRIVATE_PATH', error: new Error('PRIVATE_ERROR') });
    assert.equal(boundaries.at(-1), 'recovery:start');
    assert.doesNotMatch(traceLines.join(''), /PRIVATE|"path"\s*:|"error"\s*:/);
    for (const line of traceLines) {
      assert.deepEqual(Object.keys(JSON.parse(line.slice('[Minecraft Core startup trace] '.length))),
        ['marker', 'pid', 'utc', 'elapsedMs']);
    }
  }, { traceEnabled: true, loggerNull: true });
});

test('startup trace real window IPC boundary precedes listeners import setup and held navigation', async () => {
  await mainEntryFixture(async ({ boundaries, dependencies, getWindow, finishNavigation }) => {
    boundaries.length = 0;
    dependencies.windowFactory();
    assert.deepEqual(boundaries, [
      'main-window:browser-window:create:start', 'browser-window:work', 'main-window:browser-window:create:complete',
      'main:ipc:start', 'listeners:initialize', 'main:ipc:listeners:complete',
      'ipc-module:load', 'main:ipc:handler-module:complete', 'ipc:setup', 'main:ipc:complete',
      'main-window:navigation:start', 'navigation:work'
    ]);
    getWindow().emit('ready-to-show');
    assert.deepEqual(boundaries.slice(-2), ['main-window:ready-to-show', 'window:show']);
    finishNavigation({ status: 'ready', mode: 'production' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(boundaries.at(-1), 'main-window:navigation:complete');
    getWindow().emit('closed');
    dependencies.windowFactory();
    assert.equal(boundaries.filter(value => value === 'main:ipc:start').length, 1);
    assert.equal(boundaries.filter(value => value === 'main-window:browser-window:create:start').length, 1);
  }, { traceEnabled: true, loggerNull: true });
});

test('startup trace real main preserves each IPC stage failure identity without false completion or navigation', async () => {
  const failure = new Error('PRIVATE_ORIGINAL_IPC');
  for (const [option, expected] of [
    ['listenerError', ['main:ipc:start', 'listeners:initialize']],
    ['ipcModuleError', ['main:ipc:start', 'listeners:initialize', 'main:ipc:listeners:complete', 'ipc-module:load']],
    ['ipcError', ['main:ipc:start', 'listeners:initialize', 'main:ipc:listeners:complete',
      'ipc-module:load', 'main:ipc:handler-module:complete', 'ipc:setup']]
  ]) {
    await mainEntryFixture(async ({ boundaries, dependencies, traceLines }) => {
      boundaries.length = 0;
      assert.throws(() => dependencies.windowFactory(), actual => actual === failure);
      assert.deepEqual(boundaries.slice(3), expected);
      assert.equal(boundaries.includes('main:ipc:complete'), false);
      assert.equal(boundaries.includes('navigation:work'), false);
      assert.doesNotMatch(traceLines.join(''), /PRIVATE_ORIGINAL_IPC/);
    }, { traceEnabled: true, loggerNull: true, [option]: failure });
  }
});

test('startup trace disabled and broken sink leave actual main graph bootstrap and IPC behavior unchanged', async () => {
  for (const traceEnabled of [false, true]) {
    await mainEntryFixture(async ({ traceLines, dependencies, boundaries, finishNavigation }) => {
      dependencies.startup.markTiming('recovery:start', { private: 'PRIVATE_DETAILS' });
      dependencies.windowFactory();
      assert.deepEqual(boundaries, ['imports:last', 'graph:work', 'before-ready:work', 'browser-window:work', 'listeners:initialize', 'ipc-module:load', 'ipc:setup', 'navigation:work']);
      finishNavigation({ status: 'ready', mode: 'production' });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(traceLines, []);
    }, { traceEnabled, brokenSink: true, loggerNull: true });
  }
});
