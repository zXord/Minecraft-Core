// Main electron entry point
const { markStartupTrace } = require('./utils/startup-trace.cjs');
markStartupTrace('main:entry');
const path = require('path');
markStartupTrace('main:import:path:complete');
const { app, BrowserWindow, Menu, Tray, Notification, dialog, ipcMain, shell, session } = require('electron');
markStartupTrace('main:import:electron:complete');
const fs = require('fs');
markStartupTrace('main:import:fs:complete');
const { createRuntimeFlags } = require('./bootstrap/runtime-flags.cjs');
markStartupTrace('main:import:runtime-flags:complete');
const { createPackagedSmokeGuard } = require('./bootstrap/packaged-smoke-guard.cjs');
markStartupTrace('main:import:packaged-smoke-guard:complete');
const runtimeFlags = createRuntimeFlags({ isPackaged: Boolean(app.isPackaged) });
const packagedSmokeGuard = runtimeFlags.packagedSmokeMode ? createPackagedSmokeGuard({ app }) : null;
if (runtimeFlags.packagedSmokeMode) {
  globalThis.__MINECRAFT_CORE_PACKAGED_SMOKE_EVIDENCE__ = () => Object.freeze({
    updaterEnabled: runtimeFlags.updaterEnabled,
    automaticReleaseChecksEnabled: runtimeFlags.automaticReleaseChecksEnabled,
    publicManagementListenersEnabled: runtimeFlags.publicManagementListenersEnabled,
    ...packagedSmokeGuard.evidence()
  });
}
if (runtimeFlags.testMode) {
  process.env.MINECRAFT_CORE_USER_DATA_DIR = runtimeFlags.isolatedUserDataPath;
}
const { createMainBootstrap } = require('./bootstrap/create-main-bootstrap.cjs');
markStartupTrace('main:import:main-bootstrap:complete');
const { createModpackServiceGraph } = require('./bootstrap/create-modpack-service-graph.cjs');
markStartupTrace('main:import:modpack-service-graph:complete');
const { loadTestIpcOverrides, loadTestModpackFactory, loadTestRecoveryFactory, resolveServiceGraphUserData } = require('./bootstrap/load-test-modpack-factory.cjs');
markStartupTrace('main:import:test-modpack-factory:complete');
const { setupAppCleanup } = require('./utils/app-cleanup.cjs');
markStartupTrace('main:import:app-cleanup:complete');
const { setMainWindow } = require('./utils/safe-send.cjs');
markStartupTrace('main:import:safe-send:complete');
const appStore = require('./utils/app-store.cjs');
markStartupTrace('main:import:app-store:complete');
const { shouldAllowNavigation } = require('./utils/navigation-policy.cjs');
markStartupTrace('main:import:navigation-policy:complete');
const { cleanupRuntimeFiles } = require('./utils/runtime-paths.cjs');
markStartupTrace('main:import:runtime-paths:complete');
const { getTlsFingerprint, normalizeFingerprint } = require('./utils/tls-utils.cjs');
markStartupTrace('main:import:tls-utils:complete');
const { shouldUseDevServer } = require('./utils/runtime-mode.cjs');
markStartupTrace('main:import:runtime-mode:complete');
const { loadRendererContent } = require('./utils/renderer-loader.cjs');
markStartupTrace('main:import:renderer-loader:complete');
const { resolveWindowIconPath } = require('./utils/asset-resolver.cjs');
markStartupTrace('main:import:asset-resolver:complete');
const { createOrderlyQuitBarrier } = require('./utils/orderly-quit-barrier.cjs');
markStartupTrace('main:import:orderly-quit-barrier:complete');
const {
  applyWindowsTaskbarDetails,
  createStartupWindow,
  createWindowReadyTracker,
  startApplicationAfterReady
} = require('./utils/startup-window.cjs');
markStartupTrace('main:import:startup-window:complete');
const { claimEarlyStartupWindow } = require('./startup-entry.cjs');
markStartupTrace('main:import:startup-entry:complete');
const { getUpdateService } = require('./services/update-service.cjs');
markStartupTrace('main:import:update-service:complete');
const { installServerMutationCoordinator } = require('./services/server-mutation-context.cjs');
markStartupTrace('main:import:server-mutation-context:complete');
const devConfig = require('../config/dev-config.cjs');
markStartupTrace('main:import:dev-config:complete');
markStartupTrace('main:imports:complete');
const startupStartedAt = Date.now();
const mainWindowReadyTrackers = new WeakMap();

// Initialize logger service early
let logger = null;
try {
  const { getLogger } = require('./services/logger-service.cjs');
  logger = getLogger();
  
  // Log application startup
  logger.info('Electron main process starting', {
    category: 'core',
    data: {
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      platform: process.platform,
      arch: process.arch,
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      startupArgs: process.argv,
      shouldStartMinimized: process.argv.includes('--start-minimized')
    }
  });
} catch {
  // Failed to initialize logger service
}

function describeStartupError(error) {
  if (!error) {
    return {
      errorType: 'Unknown',
      errorMessage: 'Unknown startup error',
      stack: ''
    };
  }

  if (error instanceof Error) {
    return {
      errorType: error.constructor?.name || 'Error',
      errorMessage: error.message || 'Unknown startup error',
      stack: error.stack || ''
    };
  }

  return {
    errorType: typeof error,
    errorMessage: String(error),
    stack: ''
  };
}

function logStartupError(message, error) {
  const details = describeStartupError(error);
  try {
    console.error(`[Minecraft Core] ${message}: ${details.errorMessage}`, details.stack || details);
  } catch {
    // ignore console logging failures
  }

  try {
    if (logger) {
      logger.fatal(message, {
        category: 'core',
        data: {
          errorType: details.errorType,
          errorMessage: details.errorMessage,
          forceLog: true
        },
        stack: details.stack
      });
    }
  } catch {
    // ignore logger failures while reporting startup failures
  }
}

function describeRendererTarget(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === 'data:') return 'data-html';
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return 'unparseable';
  }
}

function markStartupTiming(marker, details = {}) {
  markStartupTrace(marker);
  if (!logger) return;
  logger.info('Startup timing marker', {
    category: 'performance',
    data: {
      marker,
      elapsedMs: Date.now() - startupStartedAt,
      ...details
    }
  });
}

// Utility function to open folders directly using child_process
async function openFolderDirectly(folderPath) {
  const { execFile } = require('child_process');
  const normalizedPath = path.normalize(folderPath);
  
  if (logger) {
    logger.debug('Opening folder directly', {
      category: 'storage',
      data: {
        folderPath: normalizedPath,
        platform: process.platform
      }
    });
  }
  
  // Try Electron's shell helper first to avoid false negatives from explorer.exe exit codes
  try {
    const shellResult = await shell.openPath(normalizedPath);
    if (!shellResult) {
      if (logger) {
        logger.info('Folder opened successfully via shell', {
          category: 'storage',
          data: {
            folderPath: normalizedPath,
            platform: process.platform,
            method: 'shell.openPath'
          }
        });
      }
      return true;
    }
    
    if (logger) {
      logger.warn('shell.openPath returned a message, falling back to OS command', {
        category: 'storage',
        data: {
          folderPath: normalizedPath,
          platform: process.platform,
          result: shellResult
        }
      });
    }
  } catch (shellError) {
    if (logger) {
      logger.warn(`shell.openPath failed, attempting OS command: ${shellError.message}`, {
        category: 'storage',
        data: {
          folderPath: normalizedPath,
          platform: process.platform,
          errorType: shellError.constructor?.name || 'Error'
        }
      });
    }
  }
  
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows - use explorer with proper escaping
      const windowsPath = normalizedPath.replace(/\//g, '\\');
      execFile('explorer.exe', [windowsPath], { windowsHide: true }, (error) => {
        if (error) {
          if (logger) {
            logger.error(`Failed to open folder on Windows: ${error.message}`, {
              category: 'storage',
              data: {
                folderPath: windowsPath,
                platform: 'win32',
                method: 'execFile',
                errorType: error.constructor.name,
                exitCode: error.code || null,
                signal: error.signal || null
              }
            });
          }
          reject(error);
        } else {
          if (logger) {
            logger.info('Folder opened successfully on Windows', {
              category: 'storage',
              data: {
                folderPath: windowsPath,
                platform: 'win32',
                method: 'execFile'
              }
            });
          }
          resolve(true);
        }
      });
    } else if (process.platform === 'darwin') {
      // macOS - use open
      execFile('open', [normalizedPath], (error) => {
        if (error) {
          if (logger) {
            logger.error(`Failed to open folder on macOS: ${error.message}`, {
              category: 'storage',
              data: {
                folderPath: normalizedPath,
                platform: 'darwin',
                errorType: error.constructor.name
              }
            });
          }
          reject(error);
        } else {
          if (logger) {
            logger.info('Folder opened successfully on macOS', {
              category: 'storage',
              data: { folderPath: normalizedPath, platform: 'darwin' }
            });
          }
          resolve(true);
        }
      });
    } else {
      // Linux - use xdg-open
      execFile('xdg-open', [normalizedPath], (error) => {
        if (error) {
          if (logger) {
            logger.error(`Failed to open folder on Linux: ${error.message}`, {
              category: 'storage',
              data: {
                folderPath: normalizedPath,
                platform: 'linux',
                errorType: error.constructor.name
              }
            });
          }
          reject(error);
        } else {
          if (logger) {
            logger.info('Folder opened successfully on Linux', {
              category: 'storage',
              data: { folderPath: normalizedPath, platform: 'linux' }
            });
          }
          resolve(true);
        }
      });
    }
  });
}

function openExternalSafely(targetUrl) {
  try {
    if (targetUrl) {
      const parsed = new URL(targetUrl);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        return;
      }
      shell.openExternal(targetUrl);
    }
  } catch {
    // ignore shell failures
  }
}

function normalizeHost(value) {
  if (!value || typeof value !== 'string') return '';
  return value.replace(/^\[|\]$/g, '').trim().toLowerCase();
}

function formatHostForUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

function resolveTrustTarget(targetUrl, portOverride) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    return { host: '', port: '', isHttps: false };
  }
  const raw = targetUrl.trim();
  if (!raw) return { host: '', port: '', isHttps: false };

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  let parsed = null;
  if (hasScheme) {
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
  } else {
    try {
      parsed = new URL(`https://${formatHostForUrl(raw)}`);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    return { host: raw, port: portOverride ? String(portOverride) : '', isHttps: true };
  }

  const isHttps = parsed.protocol === 'https:';
  let port = parsed.port || '';
  if (hasScheme && isHttps && !port) {
    port = '443';
  }
  if (portOverride) {
    port = String(portOverride);
  }
  return { host: parsed.hostname || '', port, isHttps };
}

function buildPendingPinKey(host, port) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = String(port || '8080');
  if (!normalizedHost || !normalizedPort) return '';
  return `${normalizedHost}|${normalizedPort}`;
}

function getPendingManagementPin(host, port) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return null;
  const pins = appStore.get('pendingManagementPins') || {};
  const normalizedPort = port ? String(port || '') : '';
  if (normalizedPort) {
    const key = buildPendingPinKey(host, normalizedPort);
    if (!key) return null;
    return pins[key] || null;
  }
  const entries = Object.values(pins).filter((entry) => normalizeHost(entry && entry.host ? entry.host : '') === normalizedHost);
  if (!entries.length) return null;
  return entries.find((entry) => normalizeFingerprint(entry && entry.fingerprint ? entry.fingerprint : '')) || entries[0];
}

function updatePendingManagementPin(host, port, fingerprint) {
  const pins = appStore.get('pendingManagementPins') || {};
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return;
  const normalizedPort = port ? String(port || '') : '';
  if (normalizedPort) {
    const key = buildPendingPinKey(host, normalizedPort);
    if (!key) return;
    const existing = pins[key] || {};
    pins[key] = {
      host,
      port: String(port || '8080'),
      fingerprint: fingerprint || existing.fingerprint || '',
      updatedAt: new Date().toISOString()
    };
  } else {
    const keys = Object.keys(pins);
    if (!keys.length) return;
    for (const key of keys) {
      const entry = pins[key];
      if (normalizeHost(entry && entry.host ? entry.host : '') !== normalizedHost) continue;
      pins[key] = {
        host: entry.host || host,
        port: String(entry.port || '8080'),
        fingerprint: fingerprint || entry.fingerprint || '',
        updatedAt: new Date().toISOString()
      };
    }
  }
  appStore.set('pendingManagementPins', pins);
}

function findClientInstanceForHost(host, port) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = port ? String(port || '') : '';
  if (!normalizedHost) return null;
  const instances = appStore.get('instances') || [];
  if (normalizedPort) {
    return instances.find((inst) =>
      inst &&
      inst.type === 'client' &&
      normalizeHost(inst.serverIp || '') === normalizedHost &&
      String(inst.serverPort || '') === normalizedPort
    ) || null;
  }
  return instances.find((inst) =>
    inst &&
    inst.type === 'client' &&
    normalizeHost(inst.serverIp || '') === normalizedHost
  ) || null;
}

function storeClientInstanceFingerprint(match, fingerprint) {
  if (!match || !fingerprint) return;
  const instances = appStore.get('instances') || [];
  const idx = instances.findIndex((inst) =>
    inst &&
    inst.type === 'client' &&
    ((match.id && inst.id === match.id) || (match.path && inst.path === match.path))
  );
  if (idx === -1) return;
  const updated = { ...instances[idx], managementCertFingerprint: fingerprint };
  instances[idx] = updated;
  appStore.set('instances', instances);
}

function shouldTrustAppCertificate(targetUrl, certificate, portOverride) {
  if (!targetUrl || !certificate) return false;
  const { host, port, isHttps } = resolveTrustTarget(targetUrl, portOverride);
  if (!isHttps || !host) return false;
  const certFingerprint = normalizeFingerprint(certificate.fingerprint256 || certificate.fingerprint || '');
  if (!certFingerprint) return false;
  const managementFingerprint = getTlsFingerprint('management');
  const panelFingerprint = getTlsFingerprint('browserPanel');

  if (managementFingerprint && certFingerprint === managementFingerprint) {
    return true;
  }

  if (panelFingerprint && certFingerprint === panelFingerprint) {
    return true;
  }

  const clientInstance = findClientInstanceForHost(host, port);
  if (clientInstance) {
    const storedFingerprint = normalizeFingerprint(clientInstance.managementCertFingerprint || '');
    if (storedFingerprint) {
      return certFingerprint === storedFingerprint;
    }
    const pendingPin = getPendingManagementPin(host, port);
    const pendingFingerprint = normalizeFingerprint(pendingPin && pendingPin.fingerprint ? pendingPin.fingerprint : '');
    if (pendingFingerprint) {
      if (certFingerprint !== pendingFingerprint) {
        return false;
      }
      storeClientInstanceFingerprint(clientInstance, certFingerprint);
      return true;
    }
    storeClientInstanceFingerprint(clientInstance, certFingerprint);
    if (logger) {
      logger.info('Pinned management server certificate for client instance', {
        category: 'security',
        data: {
          serverIp: clientInstance.serverIp,
          serverPort: clientInstance.serverPort,
          clientId: clientInstance.id || clientInstance.clientId
        }
      });
    }
    return true;
  }

  const pendingPin = getPendingManagementPin(host, port);
  if (pendingPin) {
    const pendingFingerprint = normalizeFingerprint(pendingPin.fingerprint || '');
    if (pendingFingerprint) {
      return certFingerprint === pendingFingerprint;
    }
    updatePendingManagementPin(host, port, certFingerprint);
    return true;
  }

  return false;
}

let certVerifyProcInstalled = false;

function setupCertificateVerification() {
  if (certVerifyProcInstalled) return;
  if (!session || !session.defaultSession) return;
  certVerifyProcInstalled = true;
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    try {
      if (request && request.verificationResult === 'net::OK') {
        callback(0);
        return;
      }
      if (request && request.errorCode === 0) {
        callback(0);
        return;
      }
      const targetHost = request && request.hostname ? request.hostname : '';
      const targetPort = request && request.port ? String(request.port) : '';
      const shouldTrust = shouldTrustAppCertificate(
        targetHost,
        request ? request.certificate : null,
        targetPort || undefined
      );
      callback(shouldTrust ? 0 : -2);
      return;
    } catch {
      callback(-2);
      return;
    }
  });
}

function isAllowedWindowNavigation(contents, targetUrl) {
  const browserWindow = BrowserWindow.fromWebContents(contents);
  const isMainWindow = Boolean(browserWindow && win && browserWindow.id === win.id);
  const allowedFilePaths = isMainWindow
    ? [path.join(__dirname, '..', 'dist', 'index.html')]
    : [];
  return shouldAllowNavigation(targetUrl, { isMainWindow, allowedFilePaths });
}

function handleWebContentsCreated(_event, contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedWindowNavigation(contents, url)) return { action: 'allow' };
    openExternalSafely(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isAllowedWindowNavigation(contents, url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });
}

function handleCertificateError(event, _webContents, url, _error, certificate, callback) {
  if (shouldTrustAppCertificate(url, certificate)) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
}

let applicationHandlersInstalled = false;

function installApplicationHandlers() {
  if (applicationHandlersInstalled) return false;
  app.on('web-contents-created', handleWebContentsCreated);
  app.on('certificate-error', handleCertificateError);
  app.on('window-all-closed', handleWindowAllClosed);
  app.on('before-quit', handleBeforeQuit);
  app.on('activate', handleActivate);
  applicationHandlersInstalled = true;
  return true;
}

function removeApplicationHandlers() {
  if (!applicationHandlersInstalled || typeof app.removeListener !== 'function') return false;
  app.removeListener('web-contents-created', handleWebContentsCreated);
  app.removeListener('certificate-error', handleCertificateError);
  app.removeListener('window-all-closed', handleWindowAllClosed);
  app.removeListener('before-quit', handleBeforeQuit);
  app.removeListener('activate', handleActivate);
  applicationHandlersInstalled = false;
  return true;
}

let handlersInitialized = false;
let autoRestartListenersInitialized = false;

function initializePostRecoveryListeners() {
  if (autoRestartListenersInitialized) return false;
  const { initializeAutoRestartListeners } = require('./services/auto-restart.cjs');
  initializeAutoRestartListeners();
  autoRestartListenersInitialized = true;
  return true;
}

function disposeApplicationStartup() {
  if (autoRestartListenersInitialized) {
    const { disposeAutoRestartListeners } = require('./services/auto-restart.cjs');
    disposeAutoRestartListeners();
    autoRestartListenersInitialized = false;
  }
  return removeApplicationHandlers();
}

// Global reference to the main window
let win;

// Global reference to the system tray
let tray = null;

// Check if app should start minimized
const shouldStartMinimized = process.argv.includes('--start-minimized');

function resolveApplicationIconPath() {
  let appPath = path.join(__dirname, '..');
  try {
    appPath = app.getAppPath?.() || appPath;
  } catch {
    // Keep the entry-point-relative path when Electron cannot report its app path.
  }
  let userDataPath = null;
  try {
    userDataPath = app.getPath?.('userData') || null;
  } catch {
    // Keep the repository/resource icon when the optional development cache is unavailable.
  }
  return resolveWindowIconPath({
    platform: process.platform,
    isPackaged: Boolean(app.isPackaged),
    projectRoot: path.join(__dirname, '..'),
    appPath,
    resourcesPath: process.resourcesPath,
    userDataPath
  });
}

function resolveApplicationPath() {
  try {
    const appPath = app.getAppPath?.();
    if (typeof appPath === 'string' && appPath.trim()) return appPath;
  } catch {
    // Keep the entry-point-relative path as a development relaunch fallback.
  }
  return path.join(__dirname, '..');
}



/**
 * Creates the system tray
 */
function createTray() {
  const { nativeImage } = require('electron');
  
  if (logger) {
    logger.debug('Creating system tray', {
      category: 'core',
      data: { platform: process.platform }
    });
  }
  
  try {
    let trayIcon;
    const iconPath = resolveApplicationIconPath();

    if (iconPath) {
      trayIcon = nativeImage.createFromPath(iconPath);

      if (!trayIcon.isEmpty()) {
        const targetSize = process.platform === 'win32' ? 32 : 24;
        trayIcon = trayIcon.resize({ width: targetSize, height: targetSize });
        if (logger) {
          logger.debug('Tray icon loaded and resized', {
            category: 'core',
            data: { iconPath, iconSize: `${targetSize}x${targetSize}` }
          });
        }
      }
    }

    // Fallback if icon loading fails
    if (!trayIcon || trayIcon.isEmpty()) {
      const width = 32;
      const height = 32;
      const buffer = Buffer.alloc(width * height * 4);

      // Create a simple dark square as fallback
      for (let i = 0; i < buffer.length; i += 4) {
        buffer[i] = 64;      // Red (dark gray)
        buffer[i + 1] = 64;  // Green (dark gray)
        buffer[i + 2] = 64;  // Blue (dark gray)
        buffer[i + 3] = 255; // Alpha (fully opaque)
      }

      trayIcon = nativeImage.createFromBuffer(buffer, { width, height });
    }
    
    // Create tray with the icon (or system default if empty)
    tray = new Tray(trayIcon);
    
    if (logger) {
      logger.info('System tray created successfully', {
        category: 'core',
        data: { 
          hasCustomIcon: !trayIcon.isEmpty(),
          platform: process.platform
        }
      });
    }
    
  } catch (error) {
    if (logger) {
      logger.error(`Failed to create system tray: ${error.message}`, {
        category: 'core',
        data: {
          errorType: error.constructor.name,
          platform: process.platform
        }
      });
    }
    tray = null;
    return;
  }
  
  // If tray creation failed, exit early
  if (!tray) {
    if (logger) {
      logger.warn('System tray creation failed, continuing without tray', {
        category: 'core',
        data: { platform: process.platform }
      });
    }
    return;
  }
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Minecraft Core',
      click: () => {
        if (logger) {
          logger.debug('Tray menu: Show Minecraft Core clicked', {
            category: 'core',
            data: { hasWindow: !!win }
          });
        }
        if (win) {
          win.show();
          win.focus();
        }
      }
    },
    {
      label: 'Hide to Tray',
      click: () => {
        if (logger) {
          logger.debug('Tray menu: Hide to Tray clicked', {
            category: 'core',
            data: { hasWindow: !!win }
          });
        }
        if (win) {
          win.hide();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        if (logger) {
          logger.info('Tray menu: Quit clicked', {
            category: 'core',
            data: { 
              hasWindow: !!win,
              windowDestroyed: win ? win.isDestroyed() : true
            }
          });
        }
        // Trigger the normal close process (including confirmation dialogs)
        if (win && !win.isDestroyed()) {
          win.close();
        } else {
          app.quit();
        }
      }
    }
  ]);
  
  tray.setToolTip('Minecraft Core');
  tray.setContextMenu(contextMenu);
  
  // Double-click to show/hide window
  tray.on('double-click', () => {
    if (logger) {
      logger.debug('Tray double-clicked', {
        category: 'core',
        data: { 
          hasWindow: !!win,
          windowVisible: win ? win.isVisible() : false
        }
      });
    }
    if (win) {
      if (win.isVisible()) {
        win.hide();
      } else {
        win.show();
        win.focus();
      }
    }
  });
}

/**
 * Creates the main application window
 */
function createWindow() {
  const startTime = Date.now();
  
  if (logger) {
    logger.info('Creating main application window', {
      category: 'core',
      data: {
        shouldStartMinimized,
        platform: process.platform
      }
    });
  }
  
  // Get app settings including window settings
  const appSettings = appStore.get('appSettings') || {};
  
  if (logger) {
    logger.debug('App settings loaded for window creation', {
      category: 'settings',
      data: {
        windowSize: appSettings.windowSize,
        customWidth: appSettings.customWidth,
        customHeight: appSettings.customHeight,
        minimizeToTray: appSettings.minimizeToTray,
        startMinimized: appSettings.startMinimized
      }
    });
  }
  
  // Calculate window size based on settings
  let windowWidth, windowHeight, isResizable;
  
  const windowPresets = {
    small: { width: 1000, height: 700 },
    medium: { width: 1200, height: 800 },
    large: { width: 1400, height: 900 }
  };
  
  if (appSettings.windowSize === 'custom') {
    windowWidth = Math.max(800, Math.min(2560, appSettings.customWidth || 1200));
    windowHeight = Math.max(600, Math.min(1440, appSettings.customHeight || 800));
  } else {
    const preset = windowPresets[appSettings.windowSize] || windowPresets.medium;
    windowWidth = preset.width;
    windowHeight = preset.height;
  }
  
  isResizable = false; // Always lock window size
  
  if (logger) {
    logger.debug('Window dimensions calculated', {
      category: 'core',
      data: {
        windowWidth,
        windowHeight,
        isResizable,
        sizeMode: appSettings.windowSize || 'medium'
      }
    });
  }


  const preloadPath = path.join(__dirname, 'preload.cjs');

  // Set up the window icon
  const windowIconPath = resolveApplicationIconPath();

  if (!windowIconPath && logger) {
    logger.warn('Window icon not resolved, using default', {
      category: 'core'
    });
  } else if (windowIconPath && logger) {
    logger.debug('Window icon resolved', {
      category: 'core',
      data: { windowIconPath }
    });
  }

  markStartupTiming('main-window:browser-window:create:start');
  win = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    resizable: isResizable,
    icon: windowIconPath || undefined, // Set the window icon
    title: 'Minecraft Core', // Set explicit title without version
    webPreferences: {
      contextIsolation: true,
      preload: preloadPath,
      webSecurity: true,
      allowRunningInsecureContent: false,
      nodeIntegration: false,
      sandbox: true
    },
    // Don't show initially if starting minimized
    show: false,
    backgroundColor: '#0f172a'
  });
  applyWindowsTaskbarDetails(win, {
    platform: process.platform,
    iconPath: windowIconPath,
    isPackaged: Boolean(app.isPackaged),
    executablePath: process.execPath,
    applicationPath: resolveApplicationPath()
  });
  mainWindowReadyTrackers.set(win, createWindowReadyTracker(win));
  markStartupTiming('main-window:browser-window:create:complete', { windowId: win.id });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !logger) return;
    logger.warn('Renderer navigation failed', {
      category: 'core',
      data: {
        errorCode,
        errorDescription: String(errorDescription || '').slice(0, 160),
        target: describeRendererTarget(validatedURL)
      }
    });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    if (!logger) return;
    logger.error('Renderer process exited unexpectedly', {
      category: 'core',
      data: {
        reason: typeof details?.reason === 'string' ? details.reason : 'unknown',
        exitCode: Number.isInteger(details?.exitCode) ? details.exitCode : null
      }
    });
  });

  const windowCreationTime = Date.now() - startTime;
  if (logger) {
    logger.info('Main window created successfully', {
      category: 'performance',
      data: {
        windowCreationTime,
        windowWidth,
        windowHeight,
        isResizable,
        hasIcon: !!windowIconPath,
        preloadPath
      }
    });
  }
  
  // Handle window minimize behavior - check current settings each time
  win.on('minimize', (event) => {
    const currentSettings = appStore.get('appSettings') || {};
    
    if (logger) {
      logger.debug('Window minimize event', {
        category: 'core',
        data: {
          minimizeToTray: currentSettings.minimizeToTray,
          hasTray: !!tray
        }
      });
    }
    
    if (currentSettings.minimizeToTray && tray) {
      event.preventDefault(); // Prevent default minimize behavior
      win.hide(); // Hide window completely (removes from taskbar)
      
      if (logger) {
        logger.info('Window hidden to tray', {
          category: 'core',
          data: { minimizeToTray: true }
        });
      }
    }
  });

  win.on('close', () => {
    if (logger) {
      logger.info('Window close event triggered', {
        category: 'core',
        data: {
          isDestroyed: win.isDestroyed(),
          isVisible: win.isVisible()
        }
      });
    }
    
    // Close logger window if open
    try {
      if (logger) {
        logger.closeLoggerWindow();
        logger.debug('Logger window closed during app shutdown', {
          category: 'core',
          data: { trigger: 'window-close' }
        });
      }
    } catch (error) {
      if (logger) {
        logger.error(`Failed to close logger window: ${error.message}`, {
          category: 'core',
          data: {
            errorType: error.constructor.name,
            trigger: 'window-close'
          }
        });
      }
    }
  });
  
  // Show window after load unless starting minimized
  win.once('ready-to-show', () => {
    markStartupTiming('main-window:ready-to-show', { windowId: win.id });
    const shouldShow = !shouldStartMinimized || !appSettings.startMinimized || !tray;
    
    if (logger) {
      logger.debug('Window ready to show', {
        category: 'core',
        data: {
          shouldShow,
          shouldStartMinimized,
          startMinimizedSetting: appSettings.startMinimized,
          hasTray: !!tray
        }
      });
    }
    
    if (shouldShow) {
      win.show();
      if (logger) {
        logger.info('Main window shown to user', {
          category: 'core',
          data: { trigger: 'ready-to-show' }
        });
      }
    } else if (logger) {
      logger.info('Main window kept hidden (start minimized)', {
        category: 'core',
        data: { startMinimized: true }
      });
    }
  });
  // Set the main window reference
  setMainWindow(win);
  
  if (logger) {
    logger.debug('Main window reference set', {
      category: 'core',
      data: { windowId: win.id }
    });
  }
  
  // Setup IPC handlers BEFORE loading the URL - only once
  if (!handlersInitialized) {
    if (logger) {
      logger.info('Setting up IPC handlers', {
        category: 'core',
        data: { windowId: win.id }
      });
    }
    
    markStartupTrace('main:ipc:start');
    initializePostRecoveryListeners();
    markStartupTrace('main:ipc:listeners:complete');
    const { setupIpcHandlers } = require('./ipc-handlers.cjs');
    markStartupTrace('main:ipc:handler-module:complete');
    setupIpcHandlers(win, serviceGraph);
    markStartupTrace('main:ipc:complete');
    handlersInitialized = true;
    
    if (logger) {
      logger.info('IPC handlers setup completed', {
        category: 'core',
        data: { handlersInitialized: true }
      });
    }
    
    // Backup manager initialization is handled in setupIpcHandlers
    
    // Add direct handlers for critical functions to ensure they work
    const fsPromises = require('fs/promises');
    
    // Remove any existing handlers first to avoid duplicates
  ipcMain.removeHandler('open-folder-direct');
    
    // Register the direct folder opening handler
    ipcMain.handle('open-folder-direct', async (_event, folderPath) => {
      if (logger) {
        logger.debug('IPC handler called: open-folder-direct', {
          category: 'core',
          data: {
            hasPath: !!folderPath,
            pathType: typeof folderPath
          }
        });
      }
      
      try {
        if (!folderPath || typeof folderPath !== 'string') {
          if (logger) {
            logger.warn('Invalid folder path provided to open-folder-direct', {
              category: 'core',
              data: {
                folderPath,
                pathType: typeof folderPath
              }
            });
          }
          return { success: false, error: 'Invalid folder path' };
        }
        
        const normalizedPath = path.normalize(folderPath);
        
        // Check if path exists
        try {
          await fsPromises.access(normalizedPath);
        } catch (accessError) {
          if (logger) {
            logger.error(`Folder access check failed: ${accessError.message}`, {
              category: 'storage',
              data: {
                folderPath: normalizedPath,
                errorType: accessError.constructor.name
              }
            });
          }
          return { success: false, error: 'Folder does not exist or is inaccessible' };
        }
        
        const result = await openFolderDirectly(normalizedPath);
        
        if (logger) {
          logger.info('Folder opened successfully via IPC', {
            category: 'storage',
            data: {
              folderPath: normalizedPath,
              success: result
            }
          });
        }
        
        return { success: result };
      } catch (error) {
        if (logger) {
          logger.error(`IPC open-folder-direct failed: ${error.message}`, {
            category: 'core',
            data: {
              errorType: error.constructor.name,
              folderPath
            }
          });
        }
        return { success: false, error: error.message };
      }
    });
  }

  // Open DevTools only if enabled in dev config
  if (devConfig.enableDevConsole) {
    win.webContents.openDevTools();
    if (logger) {
      logger.debug('DevTools opened', {
        category: 'core',
        data: { enableDevConsole: true }
      });
    }
  }
  
  const isDev = shouldUseDevServer({
    isPackaged: app.isPackaged,
    enableDevServer: devConfig.enableDevServer,
    lifecycleEvent: process.env.npm_lifecycle_event || '',
    forceDevServer: process.env.MINECRAFT_CORE_USE_DEV_SERVER === '1'
  });
  
  if (logger) {
    logger.info('Loading application content', {
      category: 'core',
      data: {
        isDev,
        isPackaged: app.isPackaged,
        enableDevServer: devConfig.enableDevServer,
        lifecycleEvent: process.env.npm_lifecycle_event || ''
      }
    });
  }
  
  const distPath = path.join(__dirname, '..', 'dist', 'index.html');
  markStartupTiming('main-window:navigation:start', { isDevelopment: isDev });
  void loadRendererContent({
    isDevelopment: isDev,
    window: win,
    distPath,
    ...(!app.isPackaged && process.env.MINECRAFT_CORE_DEV_SERVER_URL
      ? { devServerUrl: process.env.MINECRAFT_CORE_DEV_SERVER_URL }
      : {}),
    onRendererReady: () => initializeLastServer(win)
  }).then(outcome => {
    markStartupTiming('main-window:navigation:complete', { status: outcome.status, mode: outcome.mode });
    if (!logger) return;
    logger.info('Renderer load completed', {
      category: 'core',
      data: outcome
    });
  }).catch(error => {
    markStartupTiming('main-window:navigation:failed', { errorType: describeStartupError(error).errorType });
    const details = describeStartupError(error);
    if (logger) {
      logger.error('Renderer load failed', {
        category: 'core',
        data: {
          mode: isDev ? 'development' : 'production',
          errorType: details.errorType
        }
      });
    }
  });
  
  // Save window size when resized (only if window is resizable)
  win.on('resize', () => {
    if (win.isResizable()) {
      const { width, height } = win.getBounds();
      
      if (logger) {
        logger.debug('Window resized', {
          category: 'core',
          data: { width, height }
        });
      }
      
      // Update stored window bounds for fallback
      appStore.set('windowBounds', { width, height });
    }
  });
  
  // Event handler for window closed
  win.on('closed', () => {
    if (logger) {
      logger.info('Main window closed', {
        category: 'core',
        data: { windowDestroyed: true }
      });
    }
    win = null;
  });
}

let serviceGraph = null;
let mainBootstrap = null;
let orderlyQuitBarrier = null;
let appWatchdogSupervisor = null;
let browserPanelInstance = null;
let updateServiceInstance = null;

function waitForMainWindowReady(mainWindow) {
  try {
    const tracker = mainWindowReadyTrackers.get(mainWindow);
    if (!tracker) throw new TypeError('Main window readiness was not registered');
    return tracker.wait();
  } catch (error) {
    return Promise.reject(error);
  }
}

function closeEarlyStartupWindow(startupWindow) {
  markStartupTiming('startup-window:close');
  if (!startupWindow || startupWindow.isDestroyed?.()) return;
  startupWindow.close?.();
}

function handleWindowAllClosed() {
  // Always quit when X button is used to close the window
  // The minimize to tray feature should ONLY work with the minimize button
  if (process.platform !== 'darwin') {
    app.quit();
  }
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function handleBeforeQuit(event) {
  orderlyQuitBarrier?.handleBeforeQuit(event);
}

function handleActivate() {
  // On macOS, recreate the window when clicking dock icon
  if (BrowserWindow.getAllWindows().length === 0) {
    const recreation = mainBootstrap?.createWindowAfterRecovery?.();
    if (!recreation) return;
    void Promise.resolve(recreation).then(mainWindow => {
      if (mainWindow) setMainWindow(mainWindow);
    }).catch(error => {
      logStartupError('Window activation was blocked because startup recovery is unavailable', error);
    });
  }
}

function startAppWatchdogMonitoring() {
  const eventBus = require('./utils/event-bus.cjs');
  const { createAppWatchdogSupervisor } = require('./watchdog/app-watchdog-supervisor.cjs');
  if (!appWatchdogSupervisor) {
    appWatchdogSupervisor = createAppWatchdogSupervisor({
      eventBus
    });
  }
  return appWatchdogSupervisor.start();
}

function stopAppWatchdogMonitoring() {
  appWatchdogSupervisor?.dispose();
  appWatchdogSupervisor = null;
}

async function startConfiguredPublicManagementListeners() {
  const settings = appStore.get('appSettings') || {};
  const browserPanel = settings.browserPanel || {};
  if (!browserPanel.enabled || !browserPanel.autoStart) return { success: true, skipped: true };
  try {
    const { getBrowserPanel } = require('./services/browser-panel-server.cjs');
    browserPanelInstance = getBrowserPanel();
    const port = browserPanel.port || 8081;
    const result = await browserPanelInstance.start(port);
    logger?.info('Browser Panel auto-start attempted', {
      category: 'core',
      data: { success: Boolean(result?.success), port, error: result && !result.success ? result.error : undefined }
    });
    return result;
  } catch (error) {
    logger?.error(`Browser Panel auto-start failed: ${error.message}`, {
      category: 'core',
      data: { errorType: error.constructor.name }
    });
    return { success: false, error: error.message };
  }
}

async function stopConfiguredPublicManagementListeners() {
  const panel = browserPanelInstance;
  browserPanelInstance = null;
  await panel?.stop?.();
}

function initializeLastServer(mainWindow) {
  try {
    let lastServerPath = appStore.get('lastServerPath');
    const instances = appStore.get('instances') || [];
    const serverInstances = instances.filter(instance => instance && instance.type === 'server' && instance.path);
    const matchingServerInstance = serverInstances.find(instance => instance.path === lastServerPath);
    const firstExistingServerInstance = serverInstances.find(instance => fs.existsSync(instance.path));

    if (matchingServerInstance && fs.existsSync(matchingServerInstance.path)) {
      lastServerPath = matchingServerInstance.path;
    } else if (firstExistingServerInstance) {
      appStore.set('lastServerPath', firstExistingServerInstance.path);
      lastServerPath = firstExistingServerInstance.path;
    } else if (lastServerPath) {
      appStore.set('lastServerPath', null);
      lastServerPath = null;
    }

    if (!lastServerPath || !mainWindow?.webContents || mainWindow.isDestroyed?.()) return;
    const serverSettings = appStore.get('serverSettings') || {
      port: 25565,
      maxRam: 4,
      autoStartMinecraft: false,
      autoStartManagement: false
    };
    setTimeout(() => {
      if (!mainWindow?.webContents || mainWindow.isDestroyed?.()) return;
      mainWindow.webContents.send('update-server-path', lastServerPath);
      mainWindow.webContents.send('restore-server-settings', serverSettings);
    }, 500);
    const { initFromServerConfig } = require('./services/auto-restart.cjs');
    initFromServerConfig(lastServerPath);
  } catch {
    return;
  }
}

const updaterController = {
  start() {
    updateServiceInstance = getUpdateService();
    return updateServiceInstance.startPeriodicChecks();
  },
  dispose() {
    return updateServiceInstance?.stopPeriodicChecks?.();
  }
};

const trayController = {
  start: createTray,
  dispose: destroyTray
};

const watchdogController = {
  start: startAppWatchdogMonitoring,
  dispose: stopAppWatchdogMonitoring
};

const managementServerController = {
  listen: startConfiguredPublicManagementListeners,
  dispose: stopConfiguredPublicManagementListeners
};

const runtimeRoot = path.resolve(__dirname, '..');
const userDataPath = resolveServiceGraphUserData({ runtimeFlags, app, runtimeRoot });
const modpackFactory = loadTestModpackFactory({ isPackaged: Boolean(app.isPackaged) });
const recoveryFactory = loadTestRecoveryFactory({ isPackaged: Boolean(app.isPackaged) });
const testIpcOverrides = loadTestIpcOverrides({ isPackaged: Boolean(app.isPackaged) });

markStartupTrace('main:graph:start');
serviceGraph = createModpackServiceGraph({
  app,
  store: appStore,
  userDataPath,
  dialog,
  Notification,
  shell,
  runtimeRoots: {
    resourcesPath: app.isPackaged && typeof process.resourcesPath === 'string' ? process.resourcesPath : runtimeRoot,
    runtimeRoot,
    isPackaged: Boolean(app.isPackaged),
    arch: process.arch
  },
  windowFactory: createWindow,
  getWindow: () => win,
  modpackFactory,
  recoveryFactory,
  ipc: {
    nativeNotificationsEnabled: runtimeFlags.nativeNotificationsEnabled,
    updaterEnabled: runtimeFlags.updaterEnabled,
    ...(testIpcOverrides || {})
  },
  updater: updaterController,
  tray: trayController,
  watchdog: watchdogController,
  managementServer: managementServerController,
  startup: {
    automaticReleaseChecksEnabled: runtimeFlags.automaticReleaseChecksEnabled,
    installSecurity: installApplicationHandlers,
    cleanupRuntime: cleanupRuntimeFiles,
    markTiming: markStartupTiming,
    configureAfterReady() {
      setupCertificateVerification();
      Menu.setApplicationMenu(null);
    },
    afterWindowCreated(mainWindow) {
      setupAppCleanup(app, mainWindow);
    },
    dispose: disposeApplicationStartup
  }
});
markStartupTrace('main:graph:complete');
installServerMutationCoordinator(serviceGraph.coordinator);

mainBootstrap = createMainBootstrap({
  electronApi: { app, BrowserWindow, Menu, Tray, ipcMain, shell, session },
  serviceGraph,
  runtimeFlags
});
orderlyQuitBarrier = createOrderlyQuitBarrier({
  dispose: () => mainBootstrap?.dispose(),
  quit: () => app.quit(),
  onDisposeError: error => logStartupError('Application shutdown cleanup failed', error)
});
markStartupTrace('main:before-ready:start');
mainBootstrap.initializeBeforeReady();
markStartupTrace('main:before-ready:complete');

app.whenReady().then(() => {
  markStartupTiming('app:when-ready');
  packagedSmokeGuard?.installSessionBlock(session);
  if (runtimeFlags.testMode) return mainBootstrap.onReady();
  const earlyStartupWindow = claimEarlyStartupWindow();
  return startApplicationAfterReady({
    createStartupWindow() {
      const startupWindow = earlyStartupWindow && !earlyStartupWindow.isDestroyed?.()
        ? earlyStartupWindow
        : createStartupWindow({
          BrowserWindow,
          iconPath: resolveApplicationIconPath() || undefined,
          isPackaged: Boolean(app.isPackaged),
          executablePath: process.execPath,
          applicationPath: resolveApplicationPath()
        });
      markStartupTiming('startup-window:create:complete', { windowId: startupWindow.id, early: startupWindow === earlyStartupWindow });
      return startupWindow;
    },
    runMainStartup: () => mainBootstrap.onReady(),
    waitForMainWindowReady,
    closeStartupWindow: closeEarlyStartupWindow
  });
}).catch((error) => {
  logStartupError('Application startup failed before main window could load', error);
});

// Export the window instance so other modules can access it
module.exports = { getMainWindow: () => win };
