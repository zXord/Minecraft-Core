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

// Utility function to open folders directly using child_process
function openFolderDirectly(folderPath) {
  const { exec } = require('child_process');
  const normalizedPath = path.normalize(folderPath);
  
  
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows - use explorer
      exec(`explorer "${normalizedPath}"`, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(true);
        }
      });
    } else if (process.platform === 'darwin') {
      // macOS - use open
      exec(`open "${normalizedPath}"`, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve(true);
        }
      });
    } else {
      // Linux - use xdg-open
      exec(`xdg-open "${normalizedPath}"`, (error) => {
        if (error) {
          reject(error);
        } else {
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
 * Creates the system tray
 */
function createTray() {
  const { nativeImage } = require('electron');
  
  try {
    let trayIcon;
    
          // Use the custom Minecraft Core icon
      const iconPath = path.join(__dirname, '../icon.png');
      
      if (fs.existsSync(iconPath)) {
        trayIcon = nativeImage.createFromPath(iconPath);
        // Resize to appropriate tray size (bigger for better visibility)
        if (!trayIcon.isEmpty()) {
          trayIcon = trayIcon.resize({ width: 32, height: 32 });
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
    
  } catch (error) {

    tray = null;
    return;
  }
  
  // If tray creation failed, exit early
  if (!tray) {
    return;
  }
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Minecraft Core',
      click: () => {
        if (win) {
          win.show();
          win.focus();
        }
      }
    },
    {
      label: 'Hide to Tray',
      click: () => {
        if (win) {
          win.hide();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
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
  // Get app settings including window settings
  const appSettings = appStore.get('appSettings') || {};
  
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


  const preloadPath = path.join(__dirname, 'preload.cjs');

  // Set up the window icon
  const iconPath = path.join(__dirname, '../icon.png');
  let windowIcon = null;
  
  if (fs.existsSync(iconPath)) {
    windowIcon = iconPath;
  }

  win = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    resizable: isResizable,
    icon: windowIcon, // Set the window icon
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
  
  // Handle window minimize behavior - check current settings each time
  win.on('minimize', (event) => {
    const currentSettings = appStore.get('appSettings') || {};
    
    if (currentSettings.minimizeToTray && tray) {
      event.preventDefault(); // Prevent default minimize behavior
      win.hide(); // Hide window completely (removes from taskbar)
    }
  });
  
  // Handle close button - should NOT minimize to tray, let normal close behavior happen
  // The minimize to tray feature should ONLY work for the minimize button, not the close button
  win.on('close', () => {
    // Always allow normal close behavior for X button
    // Do NOT prevent close or hide to tray here
    // This ensures X button always closes the app normally
  });
  
  // Show window after load unless starting minimized
  win.once('ready-to-show', () => {
    if (!shouldStartMinimized || !appSettings.startMinimized || !tray) {
      win.show();
    }
  });
  // Set the main window reference
  setMainWindow(win);
  // Setup IPC handlers BEFORE loading the URL - only once
  if (!handlersInitialized) {
    setupIpcHandlers(win);
    handlersInitialized = true;
    
    // Backup manager initialization is handled in setupIpcHandlers
    
    // Add direct handlers for critical functions to ensure they work
    const fsPromises = require('fs/promises');
    
    // Remove any existing handlers first to avoid duplicates
  ipcMain.removeHandler('open-folder-direct');
    
    // Register the direct folder opening handler
    ipcMain.handle('open-folder-direct', async (_event, folderPath) => {
      try {
        if (!folderPath || typeof folderPath !== 'string') {
          return { success: false, error: 'Invalid folder path' };
        }
        
        const normalizedPath = path.normalize(folderPath);
        
        // Check if path exists
        try {
          await fsPromises.access(normalizedPath);
        } catch {
          return { success: false, error: 'Folder does not exist or is inaccessible' };
        }
        
        const result = await openFolderDirectly(normalizedPath);
        return { success: result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
  }

  // Open DevTools only if enabled in dev config
  if (devConfig.enableDevConsole) {
    win.webContents.openDevTools();
  }
  
  // Load the app - check if in development mode
  // If running from source (npm run dev), always try dev server first
  // If running from built app, only use dev server if enabled in config
  const isDev = !app.isPackaged || devConfig.enableDevServer;
  
  if (isDev) {
    // Development mode: try dev servers
    const tryLoadURL = (url) => {
      win.loadURL(url).catch(() => {
        if (url.includes('5173')) {
          // Try port 5174
          win.loadURL('http://localhost:5174').catch(() => {
            // Both dev servers failed, fallback to production build
            const distPath = path.join(__dirname, '..', 'dist', 'index.html');
            if (fs.existsSync(distPath)) {
              win.loadFile(distPath);
            } else {
              console.error('No dev server and no production build found');
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
      win.loadFile(distPath);
    } else {
      console.error('Production build not found at:', distPath);
    }
  }
  
  // Save window size when resized (only if window is resizable)
  win.on('resize', () => {
    if (win.isResizable()) {
    const { width, height } = win.getBounds();
      // Update stored window bounds for fallback
    appStore.set('windowBounds', { width, height });
    }
  });
  
  // Event handler for window closed
  win.on('closed', () => {
    win = null;
  });
}

// Set app name explicitly to avoid version display
app.setName('Minecraft Core');

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
