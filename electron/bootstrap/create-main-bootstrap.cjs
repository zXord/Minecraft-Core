const { resolveWindowsAppUserModelId } = require('../utils/app-identity.cjs');

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function optionalFunction(value, name) {
  if (value === undefined || value === null) return null;
  return requireFunction(value, name);
}

function assertRuntimeFlags(flags) {
  const keys = [
    'testMode',
    'updaterEnabled',
    'trayEnabled',
    'watchdogEnabled',
    'nativeNotificationsEnabled',
    'publicManagementListenersEnabled'
  ];
  if (!flags || typeof flags !== 'object' || keys.some(key => typeof flags[key] !== 'boolean')) {
    throw new TypeError('Runtime flags are invalid');
  }
}

function createMainBootstrap({ electronApi, serviceGraph, runtimeFlags } = {}) {
  const app = electronApi?.app;
  if (!app || typeof app !== 'object' || !serviceGraph || typeof serviceGraph !== 'object') {
    throw new TypeError('Main bootstrap dependencies are invalid');
  }
  assertRuntimeFlags(runtimeFlags);

  const startup = serviceGraph.startup || {};
  const createWindow = requireFunction(serviceGraph.window?.create, 'window.create');
  const getWindow = optionalFunction(serviceGraph.window?.get, 'window.get');
  const initializeRecovery = optionalFunction(startup.initializeRecovery, 'startup.initializeRecovery') ||
    (() => { throw new TypeError('Startup recovery boundary is required'); });
  const initializeServerConfig = optionalFunction(startup.initializeServerConfig, 'startup.initializeServerConfig');
  const cleanupRuntime = optionalFunction(startup.cleanupRuntime, 'startup.cleanupRuntime');
  const markTiming = optionalFunction(startup.markTiming, 'startup.markTiming');
  const installSecurity = optionalFunction(startup.installSecurity, 'startup.installSecurity');
  const configureAfterReady = optionalFunction(startup.configureAfterReady, 'startup.configureAfterReady');
  const afterWindowCreated = optionalFunction(startup.afterWindowCreated, 'startup.afterWindowCreated');
  const disposeStartup = optionalFunction(startup.dispose, 'startup.dispose');

  let beforeReadyInitialized = false;
  let readyPromise = null;
  let recreatePromise = null;
  let disposePromise = null;
  let disposed = false;
  const startedServices = [];

  function initializeBeforeReady() {
    if (beforeReadyInitialized) return false;
    if (disposed) throw new Error('Main bootstrap is disposed');

    if (runtimeFlags.testMode) {
      const isolatedUserDataPath = runtimeFlags.isolatedUserDataPath || serviceGraph.paths?.userData;
      if (typeof isolatedUserDataPath !== 'string' || !isolatedUserDataPath) {
        throw new TypeError('Test mode requires isolated userData');
      }
      requireFunction(app.setPath, 'app.setPath').call(app, 'userData', isolatedUserDataPath);
    }
    optionalFunction(app.setName, 'app.setName')?.call(app, 'Minecraft Core');
    if (runtimeFlags.platform === 'win32') {
      optionalFunction(app.setAppUserModelId, 'app.setAppUserModelId')?.call(app,
        resolveWindowsAppUserModelId({ isPackaged: Boolean(app.isPackaged) }));
    }
    installSecurity?.(serviceGraph);
    beforeReadyInitialized = true;
    return true;
  }

  async function startService(service, method, enabled, name, ...args) {
    if (!enabled || !service) return;
    const start = optionalFunction(service[method], `${name}.${method}`);
    if (!start) return;
    await start.call(service, ...args);
    startedServices.push({ service, name });
  }

  async function createAndResolveWindow() {
    const createdWindow = await createWindow(serviceGraph);
    if (createdWindow) return createdWindow;
    if (!getWindow) throw new TypeError('Window factory did not publish a window');
    const publishedWindow = await getWindow();
    if (!publishedWindow) throw new TypeError('Window factory did not publish a window');
    return publishedWindow;
  }

  async function runStartupStage(name, operation) {
    markTiming?.(`${name}:start`);
    try {
      return await operation();
    } finally {
      markTiming?.(`${name}:complete`);
    }
  }

  async function startReady() {
    initializeBeforeReady();
    if (disposed) throw new Error('Main bootstrap is disposed');

    await startService(serviceGraph.watchdog, 'start', runtimeFlags.watchdogEnabled, 'watchdog');
    await runStartupStage('recovery', () => initializeRecovery(serviceGraph));
    await runStartupStage('server-config', () => initializeServerConfig?.(serviceGraph));
    await runStartupStage('cleanup', () => cleanupRuntime?.());
    await configureAfterReady?.(serviceGraph);
    await startService(serviceGraph.tray, 'start', runtimeFlags.trayEnabled, 'tray');
    const window = await runStartupStage('main-window:create', createAndResolveWindow);
    await afterWindowCreated?.(window, serviceGraph);
    await startService(serviceGraph.updater, 'start', runtimeFlags.updaterEnabled, 'updater');
    await startService(serviceGraph.nativeNotifications, 'start', runtimeFlags.nativeNotificationsEnabled, 'nativeNotifications');
    await startService(serviceGraph.managementServer, 'listen', runtimeFlags.publicManagementListenersEnabled, 'managementServer');
    return window;
  }

  function onReady() {
    if (!readyPromise) readyPromise = startReady();
    return readyPromise;
  }

  function createWindowAfterRecovery() {
    if (!recreatePromise) {
      recreatePromise = (async () => {
        const readyWindow = await onReady();
        if (disposed) throw new Error('Main bootstrap is disposed');
        if (!getWindow) return readyWindow;
        const current = await getWindow();
        if (current) return current;
        const window = await createAndResolveWindow();
        await afterWindowCreated?.(window, serviceGraph);
        return window;
      })().finally(() => { recreatePromise = null; });
    }
    return recreatePromise;
  }

  async function disposeStarted() {
    if (readyPromise) await readyPromise.catch(() => {});
    for (let index = startedServices.length - 1; index >= 0; index -= 1) {
      const { service, name } = startedServices[index];
      const disposeService = optionalFunction(service.dispose, `${name}.dispose`) || optionalFunction(service.stop, `${name}.stop`);
      await disposeService?.call(service);
    }
    startedServices.length = 0;
    await disposeStartup?.(serviceGraph);
    disposed = true;
  }

  function dispose() {
    if (!disposePromise) disposePromise = disposeStarted();
    return disposePromise;
  }

  return Object.freeze({ initializeBeforeReady, onReady, createWindowAfterRecovery, dispose });
}

module.exports = { createMainBootstrap };
