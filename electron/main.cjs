// Main electron entry point
const path = require('path');
const { app, BrowserWindow, Menu } = require('electron');
const { setupIpcHandlers } = require('./ipc-handlers.cjs');
const { startMetricsReporting } = require('./services/system-metrics.cjs');
const { setupAppCleanup } = require('./utils/app-cleanup.cjs');
const { setMainWindow } = require('./utils/safe-send.cjs');
const appStore = require('./utils/app-store.cjs');
const { ensureConfigFile } = require('./utils/config-manager.cjs');
const { cleanupRuntimeFiles } = require('./utils/runtime-paths.cjs');
const fs = require('fs');
const { ipcMain } = require('electron');

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

/**
 * Creates the main application window
 */
function createWindow() {
  // Get stored window bounds or use defaults
  const { width, height } = appStore.get('windowBounds');

  // Debug: print the preload script path
  const preloadPath = path.join(__dirname, 'preload.cjs');

  win = new BrowserWindow({
    width,
    height,
    webPreferences: {
      contextIsolation: true,
      preload: preloadPath,
      webSecurity: true,
      allowRunningInsecureContent: false,
      nodeIntegration: false,
      sandbox: false
    },
    // Suppress security warnings in dev mode
    show: false
  });
  
  // Show window after load to reduce initial console spam
  win.once('ready-to-show', () => {
    win.show();
  });
  // Set the main window reference
  setMainWindow(win);
  // Setup IPC handlers BEFORE loading the URL - only once
  if (!handlersInitialized) {
    setupIpcHandlers(win);
    handlersInitialized = true;
    
    // Initialize automated backups system
    const { loadBackupManager } = require('./ipc/backup-handlers.cjs');
    loadBackupManager();
    
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

  // Open DevTools for debugging
  win.webContents.openDevTools();
  
  // Load the app - try port 5173 first, then 5174 if that fails
  const tryLoadURL = (url) => {
    win.loadURL(url).catch(() => {
      if (url.includes('5173')) {
        win.loadURL('http://localhost:5174');
      }
    });
  };
  
  tryLoadURL('http://localhost:5173');
  
  // Save window size when resized
  win.on('resize', () => {
    const { width, height } = win.getBounds();
    appStore.set('windowBounds', { width, height });
  });
  
  // Event handler for window closed
  win.on('closed', () => {
    win = null;
  });
}

// Initialize app when ready
app.whenReady().then(() => {
  // Clean up any old runtime files from previous sessions
  cleanupRuntimeFiles();
  
  Menu.setApplicationMenu(null);
  createWindow();
  
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
  
  // Start periodic metrics reporting
  startMetricsReporting();
  
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
  if (process.platform !== 'darwin') app.quit();
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
