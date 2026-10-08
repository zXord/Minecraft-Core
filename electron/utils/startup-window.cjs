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

  window.setAppDetails({
    appId,
    appIconPath: taskbarIconPath,
    appIconIndex: 0,
    relaunchCommand,
    relaunchDisplayName: WINDOWS_RELAUNCH_DISPLAY_NAME
  });
  return true;
}

function createStartupPageUrl() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif}main{text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#94a3b8}</style>
</head><body><main><h1>Starting Minecraft Core…</h1><p>Preparing your workspace</p></main></body></html>`;
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

async function startApplicationAfterReady({ createStartupWindow, runMainStartup, waitForMainWindowReady, closeStartupWindow = closeWindow } = {}) {
  if (typeof createStartupWindow !== 'function') throw new TypeError('createStartupWindow must be a function');
  if (typeof runMainStartup !== 'function') throw new TypeError('runMainStartup must be a function');
  if (typeof waitForMainWindowReady !== 'function') throw new TypeError('waitForMainWindowReady must be a function');

  const startupWindow = await createStartupWindow();
  try {
    const mainWindow = await runMainStartup();
    await waitForMainWindowReady(mainWindow);
    await closeStartupWindow(startupWindow);
    return mainWindow;
  } catch (error) {
    try {
      await closeStartupWindow(startupWindow);
    } catch {
      // Preserve the startup failure that triggered the cleanup.
    }
    throw error;
  }
}

module.exports = {
  applyWindowsTaskbarDetails,
  createStartupPageUrl,
  createStartupWindow,
  createWindowReadyTracker,
  startApplicationAfterReady,
  waitForStartupWindowDocument
};
