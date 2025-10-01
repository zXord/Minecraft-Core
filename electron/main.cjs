// Main electron entry point
const path = require('path');
const { app, BrowserWindow, Menu, Tray } = require('electron');
const { setupIpcHandlers } = require('./ipc-handlers.cjs');
const { setupAppCleanup } = require('./utils/app-cleanup.cjs');
const { setMainWindow } = require('./utils/safe-send.cjs');
const appStore = require('./utils/app-store.cjs');
const { ensureConfigFile } = require('./utils/config-manager.cjs');
const { cleanupRuntimeFiles } = require('./utils/runtime-paths.cjs');
const fs = require('fs');
const { ipcMain } = require('electron');
const { getUpdateService } = require('./services/update-service.cjs');
const devConfig = require('../dev-config.cjs');

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

// Utility function to open folders directly using child_process
function openFolderDirectly(folderPath) {
  const { exec } = require('child_process');
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
  
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows - use explorer with proper escaping
      const command = `explorer.exe "${normalizedPath.replace(/\//g, '\\')}"`;
      exec(command, (error) => {
        if (error) {
          if (logger) {
            logger.error(`Failed to open folder on Windows: ${error.message}`, {
              category: 'storage',
              data: {
                folderPath: normalizedPath,
                platform: 'win32',
                command: command,
                errorType: error.constructor.name
              }
            });
          }
          reject(error);
        } else {
          if (logger) {
            logger.info('Folder opened successfully on Windows', {
              category: 'storage',
              data: { folderPath: normalizedPath, platform: 'win32' }
            });
          }
          resolve(true);
        }
      });
    } else if (process.platform === 'darwin') {
      // macOS - use open
      exec(`open "${normalizedPath}"`, (error) => {
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
      exec(`xdg-open "${normalizedPath}"`, (error) => {
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

let handlersInitialized = false;

// Global reference to the main window
let win;

// Global reference to the system tray
let tray = null;

// Check if app should start minimized
const shouldStartMinimized = process.argv.includes('--start-minimized');

/**
 * Resolve an asset path regardless of dev or packaged runtime.
 * Prefers build resources when packaged while allowing root fallbacks in dev.
 * @param {...string} filenames
 * @returns {string|null}
 */
function resolveAssetPath(...filenames) {
  const seen = new Set();
  const candidates = [];

  for (const name of filenames) {
    if (!name) {
      continue;
    }

    const normalized = path.normalize(name);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, normalized));
      candidates.push(path.join(process.resourcesPath, 'build', normalized));
    }

    candidates.push(path.join(__dirname, '..', normalized));
    candidates.push(path.resolve(normalized));
    candidates.push(path.resolve('build', normalized));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore fs probe errors
    }
  }

  return null;
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
    const trayAsset = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const iconPath = resolveAssetPath(trayAsset, 'icon.ico', 'icon.png');

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
  const windowIconPath = resolveAssetPath(
    process.platform === 'win32' ? 'icon.ico' : 'icon.png',
    'icon.png'
  );

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
      sandbox: false
    },
    // Don't show initially if starting minimized
    show: false
  });

  // Explicitly set Windows taskbar overlay icon
  if (process.platform === 'win32' && windowIconPath) {
    const { nativeImage } = require('electron');
    try {
      const overlayIcon = nativeImage.createFromPath(windowIconPath);
      if (!overlayIcon.isEmpty()) {
        win.setOverlayIcon(overlayIcon, 'Minecraft Core');
      }
    } catch (error) {
      if (logger) {
        logger.warn('Failed to set overlay icon', {
          category: 'core',
          data: { error: error.message }
        });
      }
    }
  }
  
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

  // Auto-start Browser Control Panel if configured
  try {
    const settings = appStore.get('appSettings') || {};
    const bp = settings.browserPanel || {};
    if (bp.enabled && bp.autoStart) {
      try {
        const { getBrowserPanel } = require('./services/browser-panel-server.cjs');
        const panel = getBrowserPanel();
        const port = bp.port || 8081;
        panel.start(port).then((res) => {
          if (logger) {
            logger.info('Browser Panel auto-start attempted', { category: 'core', data: { success: !!(res && res.success), port, error: res && !res.success ? res.error : undefined } });
          }
        });
      } catch (e) {
        if (logger) {
          logger.error(`Browser Panel auto-start failed: ${e.message}`, { category: 'core', data: { errorType: e.constructor.name } });
        }
      }
    }
  } catch { /* ignore */ }
  
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
    
    setupIpcHandlers(win);
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
  
  // Load the app - check if in development mode
  // If running from source (npm run dev), always try dev server first
  // If running from built app, only use dev server if enabled in config
  const isDev = !app.isPackaged || devConfig.enableDevServer;
  
  if (logger) {
    logger.info('Loading application content', {
      category: 'core',
      data: {
        isDev,
        isPackaged: app.isPackaged,
        enableDevServer: devConfig.enableDevServer
      }
    });
  }
  
  if (isDev) {
    // Development mode: try dev servers
    const tryLoadURL = (url) => {
      if (logger) {
        logger.debug(`Attempting to load dev server: ${url}`, {
          category: 'core',
          data: { url, mode: 'development' }
        });
      }
      
      win.loadURL(url).then(() => {
        if (logger) {
          logger.info(`Successfully loaded dev server: ${url}`, {
            category: 'core',
            data: { url, success: true }
          });
        }
      }).catch((error) => {
        if (logger) {
          logger.warn(`Failed to load dev server ${url}: ${error.message}`, {
            category: 'core',
            data: {
              url,
              errorType: error.constructor.name,
              fallbackAttempt: url.includes('5173')
            }
          });
        }
        
        if (url.includes('5173')) {
          // Try port 5174
          const fallbackUrl = 'http://localhost:5174';
          if (logger) {
            logger.debug(`Trying fallback dev server: ${fallbackUrl}`, {
              category: 'core',
              data: { fallbackUrl }
            });
          }
          
          win.loadURL(fallbackUrl).then(() => {
            if (logger) {
              logger.info(`Successfully loaded fallback dev server: ${fallbackUrl}`, {
                category: 'core',
                data: { fallbackUrl, success: true }
              });
            }
          }).catch((fallbackError) => {
            if (logger) {
              logger.error(`Both dev servers failed: ${fallbackError.message}`, {
                category: 'core',
                data: {
                  primaryUrl: url,
                  fallbackUrl,
                  errorType: fallbackError.constructor.name
                }
              });
            }
            
            // Both dev servers failed, fallback to production build
            const distPath = path.join(__dirname, '..', 'dist', 'index.html');
            if (fs.existsSync(distPath)) {
              win.loadFile(distPath).then(() => {
                if (logger) {
                  logger.info('Loaded production build as fallback', {
                    category: 'core',
                    data: { distPath, fallbackFromDev: true }
                  });
                }
              }).catch((distError) => {
                if (logger) {
                  logger.fatal(`Failed to load production build: ${distError.message}`, {
                    category: 'core',
                    data: {
                      distPath,
                      errorType: distError.constructor.name,
                      allLoadMethodsFailed: true
                    }
                  });
                }
              });
            } else {
              if (logger) {
                logger.fatal('No dev server and no production build found', {
                  category: 'core',
                  data: {
                    distPath,
                    distExists: false,
                    devServersFailed: true
                  }
                });
              }
            }
          });
        }
      });
    };
    
    tryLoadURL('http://localhost:5173');
  } else {
    // Production mode: load the built app directly
    const distPath = path.join(__dirname, '..', 'dist', 'index.html');
    if (fs.existsSync(distPath)) {
      win.loadFile(distPath).then(() => {
        if (logger) {
          logger.info('Production build loaded successfully', {
            category: 'core',
            data: { distPath, mode: 'production' }
          });
        }
      }).catch((error) => {
        if (logger) {
          logger.fatal(`Failed to load production build: ${error.message}`, {
            category: 'core',
            data: {
              distPath,
              errorType: error.constructor.name,
              mode: 'production'
            }
          });
        }
      });
    } else {
      if (logger) {
        logger.fatal('Production build not found', {
          category: 'core',
          data: {
            distPath,
            distExists: false,
            mode: 'production'
          }
        });
      }
    }
  }
  
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

// Set app name explicitly to avoid version display
app.setName('Minecraft Core');

// Set Windows App User Model ID for proper taskbar icon grouping
// This must match the appId in package.json build configuration
if (process.platform === 'win32') {
  app.setAppUserModelId('com.minecraft-core.app');
}

// Initialize app when ready
app.whenReady().then(() => {
  // Clean up any old runtime files from previous sessions
  cleanupRuntimeFiles();
  
  Menu.setApplicationMenu(null);
  
  // Create system tray
  createTray();
  
  createWindow();
  
  // Initialize update service and start periodic checks
  const updateService = getUpdateService();
  updateService.startPeriodicChecks();
  
  // Start app watchdog only when a Minecraft server starts
  const eventBus = require('./utils/event-bus.cjs');
  const { spawn } = require('child_process');
  let appWatchdogProcess = null;
  const appWatchdogPath = path.join(__dirname, 'watchdog', 'app-watchdog.cjs');

  eventBus.on('server-started', () => {
    if (!fs.existsSync(appWatchdogPath)) {
      return;
    }
    if (appWatchdogProcess) {
      return;
    }
    appWatchdogProcess = spawn('node', [
      appWatchdogPath,
      process.pid.toString(),
      'minecraft-core-app'
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    });
    appWatchdogProcess.unref();
  });
  
  // Stop the app watchdog when the server stops or crashes
  function stopAppWatchdog() {
    const { getRuntimePaths } = require('./utils/runtime-paths.cjs');
    const runtimePaths = getRuntimePaths();
    let pid = null;
    if (fs.existsSync(runtimePaths.appWatchdogPid)) {
      try {
        pid = parseInt(fs.readFileSync(runtimePaths.appWatchdogPid, 'utf8'));
      } catch {
        pid = null;
      }
    }
    if (pid) {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /PID ${pid} /F`);
        fs.unlinkSync(runtimePaths.appWatchdogPid);
      } catch {
        pid = null;
      }
    }
    appWatchdogProcess = null;
  }

  eventBus.on('server-normal-exit', stopAppWatchdog);
  eventBus.on('server-crashed', stopAppWatchdog);
  
  // DON'T start metrics on app startup - only when server starts
  // startMetricsReporting();
  
  // Initialize with last server path if available
  // IMPORTANT: Wait for the web contents to be ready before sending data
  win.webContents.once('did-finish-load', () => {
    try {
      const lastServerPath = appStore.get('lastServerPath');
      
      if (lastServerPath && win && win.webContents) {
        // Ensure config file exists with defaults
        const serverSettings = appStore.get('serverSettings') || {
          port: 25565,
          maxRam: 4,
          autoStartMinecraft: false,
          autoStartManagement: false
        };
        const autoRestart = appStore.get('autoRestart') || { enabled: false, delay: 10, maxCrashes: 3 };
        
        // Create a default config if needed
        ensureConfigFile(lastServerPath, {
          version: null,
          port: serverSettings.port,
          maxRam: serverSettings.maxRam,
          autoRestart: {
            enabled: autoRestart.enabled,
            delay: autoRestart.delay, 
            maxCrashes: autoRestart.maxCrashes
          }
        });
        
        // Send updated path to renderer with a small delay to ensure renderer is ready
        setTimeout(() => {
          win.webContents.send('update-server-path', lastServerPath);
          
          // Restore server settings (port and RAM)
          if (serverSettings) {
            win.webContents.send('restore-server-settings', serverSettings);
          }
        }, 500); // Small delay to ensure renderer is fully ready
        
        // Initialize auto-restart settings from this server's config
        const { initFromServerConfig } = require('./services/auto-restart.cjs');
        initFromServerConfig(lastServerPath);
      }
    } catch {
      return;
    }
  });
  
  // Setup cleanup handlers
  setupAppCleanup(app, win);
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  // Always quit when X button is used to close the window
  // The minimize to tray feature should ONLY work with the minimize button
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up tray on quit
app.on('before-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('activate', () => {
  // On macOS, recreate the window when clicking dock icon
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    
    // Reset the main window reference but don't register handlers again
    setMainWindow(win);
  }
});

// Export the window instance so other modules can access it
module.exports = { getMainWindow: () => win };
