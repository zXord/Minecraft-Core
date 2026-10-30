const { resolveWindowsAppUserModelId } = require('./app-identity.cjs');
const WINDOWS_RELAUNCH_DISPLAY_NAME = 'Minecraft Core';
const startupWindowDocumentReady = new WeakMap();

function quotedWindowsPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('"')) return null;
  return `"${value.trim()}"`;
}

function createWindowsRelaunchCommand({
  isPackaged = false,
  executablePath = process.execPath,
  applicationPath
} = {}) {
  const executable = quotedWindowsPath(executablePath);
  if (!executable) return null;
  if (isPackaged) return executable;
  const application = quotedWindowsPath(applicationPath);
  return application ? `${executable} ${application}` : null;
}

function applyWindowsTaskbarDetails(window, {
  platform = process.platform,
  iconPath,
  isPackaged = false,
  executablePath = process.execPath,
  applicationPath,
  appId = resolveWindowsAppUserModelId({ isPackaged })
} = {}) {
  const taskbarIconPath = isPackaged ? executablePath : iconPath;
  const relaunchCommand = createWindowsRelaunchCommand({ isPackaged, executablePath, applicationPath });
  if (
    platform !== 'win32' ||
    !window ||
    typeof window.setAppDetails !== 'function' ||
    typeof taskbarIconPath !== 'string' ||
    !taskbarIconPath.trim() ||
    !relaunchCommand
  ) {
    return false;
  }

  // Chromium commits AppID first within one setAppDetails call. Windows uses
  // that commit to refresh the taskbar, so publish relaunch metadata before
  // the identity notification. Omitted fields are preserved by the binding.
  window.setAppDetails({
    appIconPath: taskbarIconPath,
    appIconIndex: 0,
    relaunchCommand,
    relaunchDisplayName: WINDOWS_RELAUNCH_DISPLAY_NAME
  });
  window.setAppDetails({ appId });
  return true;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createStartupPageUrl({ heading = 'Starting Minecraft Core…', detail = 'Preparing your workspace' } = {}) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif}main{text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#94a3b8}</style>
</head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createStartupWindow({
  BrowserWindow,
  iconPath,
  platform = process.platform,
  isPackaged = false,
  executablePath = process.execPath,
  applicationPath,
  appId = resolveWindowsAppUserModelId({ isPackaged })
} = {}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('BrowserWindow must be a function');
  const window = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    maximizable: false,
    minimizable: false,
    // Keep the native window hidden until its explicit Windows shell identity
    // has been applied. Showing it during construction lets Explorer create a
    // taskbar group from Electron's stock identity before setAppDetails runs.
    show: false,
    title: 'Minecraft Core',
    icon: iconPath || undefined,
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  applyWindowsTaskbarDetails(window, { platform, iconPath, isPackaged, executablePath, applicationPath, appId });
  const documentReady = Promise.resolve(window.loadURL(createStartupPageUrl())).then(() => {
    window.show?.();
    return window;
  });
  // The early entry awaits this exact promise. Keep a rejection handler here as
  // well so a standalone caller cannot create an unhandled rejection.
  void documentReady.catch(() => {});
  startupWindowDocumentReady.set(window, documentReady);
  return window;
}

async function waitForStartupWindowDocument(window) {
  if (!window || (typeof window !== 'object' && typeof window !== 'function')) {
    throw new TypeError('Startup window is invalid');
  }
  await (startupWindowDocumentReady.get(window) || Promise.resolve(window));
  // Give Electron one event-loop turn to publish and composite the loaded local
  // page before the synchronous main-process module graph starts loading.
  await new Promise(resolve => setImmediate(resolve));
  return window;
}

function closeWindow(window) {
  if (!window || window.isDestroyed?.()) return;
  window.close?.();
}

function createWindowReadyTracker(window) {
  if (!window || typeof window.once !== 'function') {
    throw new TypeError('Main window did not expose ready-to-show');
  }
  let outcome = null;
  const waiters = [];
  const finish = nextOutcome => {
    if (outcome) return;
    outcome = nextOutcome;
    for (const waiter of waiters.splice(0)) {
      if (outcome.status === 'ready') waiter.resolve(window);
      else waiter.reject(outcome.error);
    }
  };
  window.once('ready-to-show', () => finish({ status: 'ready' }));
  window.once('closed', () => finish({ status: 'failed', error: new Error('Main window closed before it became ready') }));
  if (window.isDestroyed?.()) finish({ status: 'failed', error: new Error('Main window was destroyed before it became ready') });
  return Object.freeze({
    wait() {
      if (outcome?.status === 'ready') return Promise.resolve(window);
      if (outcome?.status === 'failed') return Promise.reject(outcome.error);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    }
  });
}

function hideWindow(window) {
  try {
    if (window && !window.isDestroyed?.()) window.hide?.();
  } catch {
    // A window that cannot be hidden must not replace the startup failure.
  }
}

function readPublishedMainWindow(getMainWindow) {
  try {
    return getMainWindow?.() || null;
  } catch {
    return null;
  }
}

async function startApplicationAfterReady({
  createStartupWindow,
  runMainStartup,
  waitForMainWindowReady,
  closeStartupWindow = closeWindow,
  onStartupFailure = null,
  getMainWindow = null
} = {}) {
  if (typeof createStartupWindow !== 'function') throw new TypeError('createStartupWindow must be a function');
  if (typeof runMainStartup !== 'function') throw new TypeError('runMainStartup must be a function');
  if (typeof waitForMainWindowReady !== 'function') throw new TypeError('waitForMainWindowReady must be a function');
  if (onStartupFailure !== null && typeof onStartupFailure !== 'function') {
    throw new TypeError('onStartupFailure must be a function');
  }
  if (getMainWindow !== null && typeof getMainWindow !== 'function') throw new TypeError('getMainWindow must be a function');

  // The splash is cosmetic: a startup that cannot show one still starts.
  let startupWindow = null;
  try {
    startupWindow = (await createStartupWindow()) || null;
  } catch {
    startupWindow = null;
  }

  let mainWindow = null;
  try {
    mainWindow = await runMainStartup();
    await waitForMainWindowReady(mainWindow);
  } catch (error) {
    if (onStartupFailure) {
      // The open splash keeps window-all-closed from quitting while the hook
      // reports the failure. A main window that already exists has live IPC,
      // so it is hidden before anything is shown to the user.
      const failedMainWindow = mainWindow || readPublishedMainWindow(getMainWindow);
      hideWindow(failedMainWindow);
      try {
        await onStartupFailure(error, Object.freeze({ splash: startupWindow, mainWindow: failedMainWindow }));
      } catch {
        // The original startup failure stays primary.
      }
    }
    try {
      await closeStartupWindow(startupWindow);
    } catch {
      // Preserve the startup failure that triggered the cleanup.
    }
    throw error;
  }
  await closeStartupWindow(startupWindow);
  return mainWindow;
}

/**
 * Decides how the main window first appears. A login with --start-minimized,
 * the start-minimized setting and a tray starts hidden; a degraded start shows
 * the window without stealing focus so its warning banner is still seen.
 */
function resolveInitialWindowVisibility({
  startMinimizedArg = false,
  startMinimizedSetting = false,
  hasTray = false,
  degraded = false
} = {}) {
  const startsMinimized = Boolean(startMinimizedArg) && Boolean(startMinimizedSetting) && Boolean(hasTray);
  if (!startsMinimized) return 'show';
  return degraded ? 'show-inactive' : 'hidden';
}

module.exports = {
  applyWindowsTaskbarDetails,
  createStartupPageUrl,
  createStartupWindow,
  createWindowReadyTracker,
  resolveInitialWindowVisibility,
  startApplicationAfterReady,
  waitForStartupWindowDocument
};
