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
const url = require('url');
const { ipcMain, dialog, shell } = require('electron');
const { initializeAutomatedBackups } = require('./ipc/backup-handlers.cjs');
const { registeredHandlers } = require('./utils/ipc-helpers.cjs');

// Utility function to open folders directly using child_process
function openFolderDirectly(folderPath) {
  const { exec } = require('child_process');
  const normalizedPath = path.normalize(folderPath);
  
  console.log('[MAIN] Opening folder directly:', normalizedPath);
  
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      // Windows - use explorer
      exec(`explorer "${normalizedPath}"`, (error) => {
        if (error) {
          console.error('[MAIN] Error opening folder with explorer:', error);
          reject(error);
        } else {
          resolve(true);
        }
      });
    } else if (process.platform === 'darwin') {
      // macOS - use open
      exec(`open "${normalizedPath}"`, (error) => {
        if (error) {
          console.error('[MAIN] Error opening folder with open:', error);
          reject(error);
        } else {
          resolve(true);
        }
      });
    } else {
      // Linux - use xdg-open
      exec(`xdg-open "${normalizedPath}"`, (error) => {
        if (error) {
          console.error('[MAIN] Error opening folder with xdg-open:', error);
          reject(error);
        } else {
          resolve(true);
        }
      });
    }
  });
}

// Flags to track app state
app.isQuitting = false;
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
  console.log('Electron will use preload script at:', preloadPath);

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

  // Open DevTools for debugging
  win.webContents.openDevTools();
  
  // Load the app - try port 5173 first, then 5174 if that fails
  const tryLoadURL = (url) => {
    win.loadURL(url).catch(() => {
      console.log(`Failed to load ${url}, trying alternative port...`);
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
  
  // Set the main window reference for IPC communications
  // Must be done before setupIpcHandlers
  setMainWindow(win);
  
  // Setup IPC handlers with reference to the window - only once
  if (!handlersInitialized) {
    setupIpcHandlers(win);
    handlersInitialized = true;
    
    // Initialize automated backups system
    const { loadBackupManager } = require('./ipc/backup-handlers.cjs');
    loadBackupManager(win);
    
    // Add direct handlers for critical functions to ensure they work
    const { ipcMain, shell, dialog } = require('electron');
    const fsPromises = require('fs/promises');
    
    // Remove any existing handlers first to avoid duplicates
    try {
      // Don't remove open-folder here as it's registered through createFileHandlers
      // Only remove handlers that are defined directly in this file
      ipcMain.removeHandler('show-confirmation-dialog');
      ipcMain.removeHandler('open-folder-direct');
    } catch (err) {
      // Ignore if no existing handlers
    }
    
    // Ensure the delete-instance handler is registered
    if (!registeredHandlers.has('delete-instance')) {
      console.error('[MAIN] delete-instance handler is not registered');
    }
    
    // Define our folder openers but don't register them directly
    const openFolderHandler = async (_event, folderPath) => {
      try {
        console.log('[MAIN] Opening folder in explorer:', folderPath);
        
        // Check if path exists
        if (!folderPath) {
          return { success: false, error: 'No folder path provided' };
        }
        
        // Try the direct folder opening first (most reliable)
        try {
          await openFolderDirectly(folderPath);
          return { success: true, method: 'direct' };
        } catch (directError) {
          console.error('[MAIN] Direct folder open failed:', directError);
          
          // Fall back to shell.openPath
          try {
            await shell.openPath(path.normalize(folderPath));
            return { success: true, method: 'shell' };
          } catch (shellError) {
            console.error('[MAIN] shell.openPath failed:', shellError);
            
            // Final attempt with spawn
            if (process.platform === 'win32') {
              try {
                require('child_process').spawn('explorer', [folderPath], { detached: true });
                return { success: true, method: 'spawn' };
              } catch (spawnError) {
                console.error('[MAIN] Spawn failed:', spawnError);
                return { 
                  success: false, 
                  error: 'All methods failed: ' + directError.message 
                };
              }
            } else {
              return { 
                success: false, 
                error: 'All methods failed: ' + directError.message 
              };
            }
          }
        }
      } catch (err) {
        console.error('[MAIN] Unhandled error in open-folder:', err);
        return { success: false, error: err.message };
      }
    };
    
    // Only check if open-folder is already registered, and use our handler if not
    if (!require('./utils/ipc-helpers.cjs').registeredHandlers.has('open-folder')) {
      ipcMain.handle('open-folder', openFolderHandler);
    }
    
    // Direct handler for confirming actions
    ipcMain.handle('show-confirmation-dialog', async (_event, options) => {
      try {
        return await dialog.showMessageBox(win, options);
      } catch (err) {
        console.error('[MAIN] Direct handler: Failed to show dialog:', err);
        throw new Error(`Failed to show dialog: ${err.message}`);
      }
    });
  }    
  // Start app watchdog only when a Minecraft server starts
  const eventBus = require('./utils/event-bus.cjs');
  const { spawn } = require('child_process');
  let appWatchdogProcess = null;
  const appWatchdogPath = path.join(__dirname, 'watchdog', 'app-watchdog.cjs');

  eventBus.on('server-started', () => {
    if (!fs.existsSync(appWatchdogPath)) {
      console.error(`App watchdog script not found at: ${appWatchdogPath}`);
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
    try {
      if (fs.existsSync(runtimePaths.appWatchdogPid)) {
        pid = parseInt(fs.readFileSync(runtimePaths.appWatchdogPid, 'utf8'));
      }
    } catch (err) {
      console.error('Failed to read app-watchdog.pid:', err.message);
    }
    if (pid) {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /PID ${pid} /F`);
        console.log(`App watchdog process with PID ${pid} killed.`);
        // Remove the PID file after killing
        fs.unlinkSync(runtimePaths.appWatchdogPid);
      } catch (err) {
        console.error('Failed to kill app watchdog process:', err.message);
      }
    } else {
      console.log('No app watchdog PID found to kill.');
    }
    appWatchdogProcess = null;
  }

  eventBus.on('server-normal-exit', stopAppWatchdog);
  eventBus.on('server-crashed', stopAppWatchdog);
  
  // Start periodic metrics reporting
  startMetricsReporting(win);
  
  // Initialize with last server path if available
  // IMPORTANT: Wait for the web contents to be ready before sending data
  win.webContents.once('did-finish-load', () => {
    try {
      const lastServerPath = appStore.get('lastServerPath');
      
      if (lastServerPath && win && win.webContents) {
        // Ensure config file exists with defaults
        const serverSettings = appStore.get('serverSettings') || { port: 25565, maxRam: 4 };
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
    } catch (err) {
      console.error('Error restoring last server path:', err);
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