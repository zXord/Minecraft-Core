const { markStartupTrace, createStartupTrace } = require('./utils/startup-trace.cjs');
markStartupTrace('early:entry');
const path = require('path');
const { app, BrowserWindow, dialog, shell } = require('electron');
const {
  materializeCachedDevelopmentIcon,
  resolveWindowIconPath
} = require('./utils/asset-resolver.cjs');
const { resolveWindowsAppUserModelId } = require('./utils/app-identity.cjs');
const { createStartupWindow, waitForStartupWindowDocument } = require('./utils/startup-window.cjs');
const { PACKAGED_SMOKE_ARGUMENT, REAL_E2E_ROOT_ARGUMENT } = require('./bootstrap/runtime-flags.cjs');
markStartupTrace('early:imports:complete');

const STARTUP_WINDOW_HANDOFF = Symbol.for('minecraft-core.startup-window-handoff');
const USER_DATA_OVERRIDE_ENV = 'MINECRAFT_CORE_USER_DATA_DIR';
const DEVELOPMENT_PROFILE_DEFAULTED_ENV = 'MINECRAFT_CORE_DEV_PROFILE_DEFAULTED';
const DEVELOPMENT_USER_DATA_DIRECTORY = 'Minecraft Core Development';
const REAL_E2E_NOTIFICATIONS_ENV = 'MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS';
const START_MINIMIZED_ARGUMENT = '--start-minimized';
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

function shouldCreateEarlyStartupWindow({ app: electronApp = app, env = process.env, argv = process.argv } = {}) {
  // The login item passes --start-minimized; that start shows no splash.
  if (Array.isArray(argv) && argv.includes(START_MINIMIZED_ARGUMENT)) return false;
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

/**
 * Test, packaged-smoke and real-E2E harness launches must never block on a
 * dialog. This reads argv and env only: runtime flags are never created here,
 * because doing so would consume the packaged-smoke nonce before main loads.
 */
function isNonInteractiveStartup({ env = process.env, argv = process.argv } = {}) {
  if (isTestStartup(env) || env?.[REAL_E2E_NOTIFICATIONS_ENV] === '1') return true;
  const argumentsList = Array.isArray(argv) ? argv : [];
  return argumentsList.some(value => typeof value === 'string' &&
    (value.startsWith(`${PACKAGED_SMOKE_ARGUMENT}=`) || value.startsWith(`${REAL_E2E_ROOT_ARGUMENT}=`)));
}

function windowsPathKey(value) {
  return typeof value === 'string' && value.trim()
    ? path.win32.normalize(value.trim()).toLocaleLowerCase('en-US')
    : null;
}

function resolveDevelopmentUserDataPath(electronApp) {
  if (typeof electronApp?.getPath !== 'function') {
    throw new TypeError('Electron app must expose getPath for the development profile');
  }
  const appDataPath = electronApp.getPath('appData');
  if (typeof appDataPath !== 'string' || !appDataPath.trim()) {
    throw new TypeError('Electron appData path is unavailable for the development profile');
  }
  return path.join(path.resolve(appDataPath.trim()), DEVELOPMENT_USER_DATA_DIRECTORY);
}

function hasExplicitUserDataOverride({ app: electronApp, env }) {
  const configured = env?.[USER_DATA_OVERRIDE_ENV];
  if (typeof configured !== 'string' || !configured.trim()) return false;
  if (env?.[DEVELOPMENT_PROFILE_DEFAULTED_ENV] !== '1') return true;
  // Only the development profile this entry defaulted counts as not explicit;
  // an inherited marker beside any other path is still an isolated profile.
  try {
    return windowsPathKey(path.resolve(configured.trim())) !== windowsPathKey(resolveDevelopmentUserDataPath(electronApp));
  } catch {
    return true;
  }
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
    hasExplicitUserDataOverride({ app: electronApp, env })
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
  if (typeof configured === 'string' && configured.trim()) {
    if (typeof electronApp?.setPath !== 'function') {
      throw new TypeError('Electron app must expose setPath for an explicit userData override');
    }
    const userDataPath = path.resolve(configured.trim());
    electronApp.setPath('userData', userDataPath);
    return userDataPath;
  }
  if (electronApp?.isPackaged || isTestStartup(env)) return null;

  // Unpackaged runs (npm run dev, electron ., the development shortcut) never
  // open the installed app's profile. The main process and app-store follow
  // the exported override; the marker keeps the development shortcut eligible.
  if (!env || typeof env !== 'object') throw new TypeError('Startup environment is invalid');
  if (typeof electronApp?.setPath !== 'function') {
    throw new TypeError('Electron app must expose setPath for the development profile');
  }
  const userDataPath = resolveDevelopmentUserDataPath(electronApp);
  electronApp.setPath('userData', userDataPath);
  env[USER_DATA_OVERRIDE_ENV] = userDataPath;
  env[DEVELOPMENT_PROFILE_DEFAULTED_ENV] = '1';
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

function readEarlyUserDataPath(electronApp) {
  try {
    const userDataPath = electronApp?.getPath?.('userData');
    return typeof userDataPath === 'string' && userDataPath.trim() ? userDataPath : null;
  } catch {
    return null;
  }
}

async function reportFatalEarlyStartup({ app: electronApp, error, startupWindow, shellApi = shell, logger = console } = {}) {
  let reporter;
  try {
    // Loaded only after a failure, so a normal start never pays for the
    // reporter or the update service.
    const { createFatalStartupReporter } = require('./utils/startup-failure-reporter.cjs');
    const userDataPath = readEarlyUserDataPath(electronApp);
    reporter = createFatalStartupReporter({
      dialog,
      shell: shellApi,
      app: electronApp,
      getUpdateService: () => require('./services/update-service.cjs').getUpdateService(),
      logDirectory: userDataPath ? path.join(userDataPath, 'logs') : null,
      userDataPath,
      interactive: true,
      logger
    });
  } catch {
    // Without Electron's dialog API there is nothing to show; startup still quits.
    return null;
  }
  return reporter.report(error, { splash: startupWindow });
}

async function terminateFailedEarlyStartup({
  app: electronApp,
  startupWindow,
  error,
  env,
  argv,
  reportFatalStartup,
  shellApi,
  logger
}) {
  if (globalThis[STARTUP_WINDOW_HANDOFF] === startupWindow) {
    Reflect.deleteProperty(globalThis, STARTUP_WINDOW_HANDOFF);
  }
  if (typeof reportFatalStartup === 'function' && !isNonInteractiveStartup({ env, argv })) {
    try {
      // The still-open splash keeps Electron from quitting while the user reads the report.
      await reportFatalStartup({ app: electronApp, error, startupWindow, shellApi, logger });
    } catch {
      // The startup failure stays primary when the report itself fails.
    }
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
  argv = process.argv,
  platform = process.platform,
  shellApi = shell,
  logger = console,
  resolveIconPath = resolveEarlyStartupIconPath,
  prepareIconPath = prepareEarlyStartupIconPath,
  createWindow = createStartupWindow,
  waitForWindowDocument = waitForStartupWindowDocument,
  shouldCreateStartupWindow = shouldCreateEarlyStartupWindow,
  reportFatalStartup = reportFatalEarlyStartup,
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
    if (!shouldCreateStartupWindow({ app: electronApp, env, argv })) {
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
    await terminateFailedEarlyStartup({
      app: electronApp,
      startupWindow,
      error,
      env,
      argv,
      reportFatalStartup,
      shellApi,
      logger
    });
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
  isNonInteractiveStartup,
  publishEarlyStartupWindow,
  prepareEarlyStartupIconPath,
  resolveEarlyStartupIconPath,
  writeDevelopmentStartMenuShortcut,
  shouldAutoStartEarlyStartup,
  shouldCreateEarlyStartupWindow,
  startEarlyStartup
};
