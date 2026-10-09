const { markStartupTrace, createStartupTrace } = require('./utils/startup-trace.cjs');
markStartupTrace('early:entry');
const path = require('path');
const { app, BrowserWindow, shell } = require('electron');
const {
  materializeCachedDevelopmentIcon,
  resolveWindowIconPath
} = require('./utils/asset-resolver.cjs');
const { resolveWindowsAppUserModelId } = require('./utils/app-identity.cjs');
const { createStartupWindow, waitForStartupWindowDocument } = require('./utils/startup-window.cjs');
markStartupTrace('early:imports:complete');

const STARTUP_WINDOW_HANDOFF = Symbol.for('minecraft-core.startup-window-handoff');
const USER_DATA_OVERRIDE_ENV = 'MINECRAFT_CORE_USER_DATA_DIR';
const APP_NAME = 'Minecraft Core';
const earlyIdentityApps = new WeakSet();

function resolveEarlyStartupIconPath({ app: electronApp = app } = {}) {
  const projectRoot = path.join(__dirname, '..');
  let appPath = projectRoot;
  try {
    appPath = electronApp.getAppPath?.() || appPath;
  } catch {
    // The entry path is a safe development fallback when Electron cannot report its app path.
  }
  return resolveWindowIconPath({
    platform: process.platform,
    isPackaged: Boolean(electronApp.isPackaged),
    projectRoot,
    appPath,
    resourcesPath: process.resourcesPath
  });
}

function resolveElectronApplicationPath(electronApp = app) {
  const projectRoot = path.join(__dirname, '..');
  try {
    const appPath = electronApp.getAppPath?.();
    if (typeof appPath === 'string' && appPath.trim()) return appPath;
  } catch {
    // The entry path remains a safe relaunch fallback in development.
  }
  return projectRoot;
}

function prepareEarlyStartupIconPath({
  app: electronApp = app,
  platform = process.platform,
  sourceIconPath
} = {}) {
  let userDataPath = null;
  try {
    userDataPath = electronApp.getPath?.('userData') || null;
  } catch {
    return sourceIconPath || null;
  }
  return materializeCachedDevelopmentIcon({
    platform,
    isPackaged: Boolean(electronApp.isPackaged),
    sourcePath: sourceIconPath,
    userDataPath
  });
}

function publishEarlyStartupWindow(window) {
  if (!window) throw new TypeError('Early startup window was not created');
  globalThis[STARTUP_WINDOW_HANDOFF] = window;
  return window;
}

function claimEarlyStartupWindow() {
  const window = globalThis[STARTUP_WINDOW_HANDOFF] || null;
  Reflect.deleteProperty(globalThis, STARTUP_WINDOW_HANDOFF);
  return window;
}

function shouldCreateEarlyStartupWindow({ app: electronApp = app, env = process.env } = {}) {
  return Boolean(electronApp.isPackaged) || !(env.NODE_ENV === 'test' && env.MINECRAFT_CORE_TEST_MODE === '1');
}

function isDevelopmentStartup(env = process.env) {
  return env?.npm_lifecycle_event === 'dev' ||
    env?.npm_lifecycle_event === 'dev:electron' ||
    env?.NODE_ENV === 'development';
}

function isTestStartup(env = process.env) {
  return env?.NODE_ENV === 'test' && env?.MINECRAFT_CORE_TEST_MODE === '1';
}

function windowsPathKey(value) {
  return typeof value === 'string' && value.trim()
    ? path.win32.normalize(value.trim()).toLocaleLowerCase('en-US')
    : null;
}

function isOwnedDevelopmentShortcut(details, expected) {
  if (!details || typeof details !== 'object') return false;
  if (details.appUserModelId === expected.appUserModelId) return true;
  return details.args === expected.args &&
    windowsPathKey(details.cwd) === windowsPathKey(expected.cwd);
}

function writeDevelopmentStartMenuShortcut({
  app: electronApp = app,
  shellApi = shell,
  env = process.env,
  platform = process.platform,
  iconPath,
  logger = console
} = {}) {
  if (
    platform !== 'win32' ||
    electronApp?.isPackaged ||
    isTestStartup(env) ||
    !isDevelopmentStartup(env) ||
    (typeof env?.[USER_DATA_OVERRIDE_ENV] === 'string' && env[USER_DATA_OVERRIDE_ENV].trim())
  ) {
    return false;
  }

  try {
    if (!shellApi || typeof shellApi.writeShortcutLink !== 'function') {
      throw new TypeError('Electron shell.writeShortcutLink is unavailable');
    }
    const appPath = electronApp.getAppPath?.();
    const appDataPath = electronApp.getPath?.('appData');
    if (typeof appPath !== 'string' || !appPath.trim() || typeof appDataPath !== 'string' || !appDataPath.trim()) {
      throw new TypeError('Electron app paths required for the development shortcut are unavailable');
    }
    if (typeof iconPath !== 'string' || !iconPath.trim()) {
      throw new TypeError('The development shortcut icon path is unavailable');
    }
    const shortcutPath = path.join(
      appDataPath,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Minecraft Core Development.lnk'
    );
    const details = {
      target: process.execPath,
      args: `"${appPath}"`,
      cwd: appPath,
      icon: iconPath,
      iconIndex: 0,
      appUserModelId: resolveWindowsAppUserModelId({ isPackaged: false })
    };
    let operation = 'create';
    if (typeof shellApi.readShortcutLink === 'function') {
      try {
        const existing = shellApi.readShortcutLink(shortcutPath);
        if (!isOwnedDevelopmentShortcut(existing, details)) {
          logger?.warn?.('[Minecraft Core] Refusing to replace an unrelated Start Menu shortcut collision');
          return false;
        }
        operation = 'replace';
      } catch {
        // A missing or unreadable app-owned shortcut is safely recreated at this exact path.
      }
    }
    let created = shellApi.writeShortcutLink(shortcutPath, operation, details);
    if (!created && operation === 'replace') {
      // The shortcut can disappear between inspection and replacement. Recreate only
      // this application-owned link; never enumerate or alter unrelated shortcuts.
      created = shellApi.writeShortcutLink(shortcutPath, 'create', details);
    }
    if (created) return true;
    logger?.warn?.('[Minecraft Core] Failed to create development Start Menu shortcut: Electron returned false');
  } catch (error) {
    logger?.warn?.('[Minecraft Core] Failed to create development Start Menu shortcut:', error);
  }
  return false;
}

function shouldAutoStartEarlyStartup({
  processLike = process,
  startupModule = module,
  requireMain = require.main
} = {}) {
  if (requireMain === startupModule) return true;
  return processLike?.type === 'browser' && typeof processLike?.versions?.electron === 'string';
}

function applyEarlyUserDataOverride({ app: electronApp = app, env = process.env } = {}) {
  const configured = env?.[USER_DATA_OVERRIDE_ENV];
  if (typeof configured !== 'string' || !configured.trim()) return null;
  if (typeof electronApp?.setPath !== 'function') {
    throw new TypeError('Electron app must expose setPath for an explicit userData override');
  }
  const userDataPath = path.resolve(configured.trim());
  electronApp.setPath('userData', userDataPath);
  return userDataPath;
}

function applyEarlyAppIdentity({ app: electronApp = app, platform = process.platform } = {}) {
  if (!electronApp || (typeof electronApp !== 'object' && typeof electronApp !== 'function')) return false;
  if (earlyIdentityApps.has(electronApp)) return false;

  if (typeof electronApp.setName === 'function') {
    electronApp.setName(APP_NAME);
  }
  if (platform === 'win32' && typeof electronApp.setAppUserModelId === 'function') {
    electronApp.setAppUserModelId(resolveWindowsAppUserModelId({
      isPackaged: Boolean(electronApp.isPackaged)
    }));
  }
  earlyIdentityApps.add(electronApp);
  return true;
}

async function terminateFailedEarlyStartup({ app: electronApp, startupWindow }) {
  if (globalThis[STARTUP_WINDOW_HANDOFF] === startupWindow) {
    Reflect.deleteProperty(globalThis, STARTUP_WINDOW_HANDOFF);
  }
  try {
    if (startupWindow && !startupWindow.isDestroyed?.()) {
      const closeResult = startupWindow.close?.();
      if (closeResult && typeof closeResult.catch === 'function') {
        void closeResult.catch(() => {});
      }
    }
  } catch {
    // Preserve the main-process import failure while still terminating startup.
  } finally {
    try { electronApp.quit?.(); } catch {
      // Preserve the startup failure when Electron itself cannot quit cleanly.
    }
  }
}

async function startEarlyStartup({
  app: electronApp = app,
  BrowserWindow: ElectronBrowserWindow = BrowserWindow,
  env = process.env,
  platform = process.platform,
  shellApi = shell,
  logger = console,
  resolveIconPath = resolveEarlyStartupIconPath,
  prepareIconPath = prepareEarlyStartupIconPath,
  createWindow = createStartupWindow,
  waitForWindowDocument = waitForStartupWindowDocument,
  shouldCreateStartupWindow = shouldCreateEarlyStartupWindow,
  loadMain = () => require('./main.cjs')
} = {}) {
  const markTrace = env === process.env ? markStartupTrace : createStartupTrace({ env });
  if (!electronApp || typeof electronApp.whenReady !== 'function') {
    throw new TypeError('Electron app must expose whenReady');
  }

  let startupWindow = null;
  try {
    applyEarlyUserDataOverride({ app: electronApp, env });
    applyEarlyAppIdentity({ app: electronApp, platform });
    markTrace('early:when-ready:start');
    await electronApp.whenReady();
    markTrace('early:when-ready:complete');
    if (!shouldCreateStartupWindow({ app: electronApp, env })) {
      markTrace('early:main-load:start');
      await loadMain();
      markTrace('early:main-load:complete');
      return null;
    }
    markTrace('early:icon:start');
    const sourceIconPath = resolveIconPath({ app: electronApp, platform }) || undefined;
    const iconPath = prepareIconPath({
      app: electronApp,
      platform,
      sourceIconPath
    }) || sourceIconPath;
    markTrace('early:icon:complete');
    const applicationPath = resolveElectronApplicationPath(electronApp);
    const appId = resolveWindowsAppUserModelId({ isPackaged: Boolean(electronApp.isPackaged) });
    markTrace('early:shortcut-attempt:start');
    writeDevelopmentStartMenuShortcut({
      app: electronApp,
      shellApi,
      env,
      platform,
      iconPath,
      logger
    });
    markTrace('early:shortcut-attempt:complete');
    startupWindow = globalThis[STARTUP_WINDOW_HANDOFF];
    if (!startupWindow || startupWindow.isDestroyed?.()) {
      markTrace('early:window:create:start');
      startupWindow = publishEarlyStartupWindow(createWindow({
        BrowserWindow: ElectronBrowserWindow,
        iconPath,
        isPackaged: Boolean(electronApp.isPackaged),
        executablePath: process.execPath,
        applicationPath,
        appId
      }));
      markTrace('early:window:create:complete');
    }
    markTrace('early:document:start');
    await waitForWindowDocument(startupWindow);
    markTrace('early:document:complete');
    markTrace('early:main-load:start');
    await loadMain();
    markTrace('early:main-load:complete');
    return startupWindow;
  } catch (error) {
    markTrace('early:failed');
    await terminateFailedEarlyStartup({ app: electronApp, startupWindow });
    throw error;
  }
}

if (shouldAutoStartEarlyStartup()) {
  void startEarlyStartup().catch(error => {
    console.error('[Minecraft Core] Early startup window failed:', error);
  });
}

module.exports = {
  applyEarlyAppIdentity,
  applyEarlyUserDataOverride,
  claimEarlyStartupWindow,
  publishEarlyStartupWindow,
  prepareEarlyStartupIconPath,
  resolveEarlyStartupIconPath,
  writeDevelopmentStartMenuShortcut,
  shouldAutoStartEarlyStartup,
  shouldCreateEarlyStartupWindow,
  startEarlyStartup
};
