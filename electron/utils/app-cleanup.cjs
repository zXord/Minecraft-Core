// Application cleanup utilities
const { ipcMain } = require('electron');
const { safeSend } = require('./safe-send.cjs');

/**
 * Set up application cleanup handlers
 * 
 * @param {Electron.App} app - Electron app instance
 * @param {Electron.BrowserWindow} win - Main window instance
 */
function setupAppCleanup(app, win) {
  // Handle window close event to ensure server is stopped before app quits
  if (win) {
    win.on('close', async (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        console.log('Window close requested, checking if server is running...');
        
        // Import server manager here to avoid circular dependencies
        const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
        const serverProcess = getServerProcess();

        if (serverProcess) {
          // Send a request to the renderer to ask the user
          const userConfirmed = await new Promise(resolve => {
            const handler = (_event, response) => {
              resolve(response);
              ipcMain.removeHandler('app-close-response');
            };
            ipcMain.handle('app-close-response', handler);
            safeSend('app-close-request');
          });

          if (userConfirmed) {
            console.log('Stopping server before exit...');
            try {
              killMinecraftServer();
              await new Promise(resolve => setTimeout(resolve, 500));
              app.isQuitting = true;
              win.close();
            } catch (err) {
              console.error('Error stopping server:', err);
              app.isQuitting = true;
              win.close();
            }
          } else {
            console.log('User canceled application exit');
          }
        } else {
          app.isQuitting = true;
          win.close();
        }
      }
    });
  }
  
  // Ensure all processes are cleaned up on quit
  app.on('quit', () => {
    console.log('Application quit event detected, ensuring all processes are cleaned up...');
    
    try {
      // Import server manager here to avoid circular dependencies
      const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
      const serverProcess = getServerProcess();
      
      if (serverProcess) {
        console.log('Server still running on quit, forcefully terminating...');
        killMinecraftServer();
      }
    } catch (err) {
      console.error('Error cleaning up processes on quit:', err);
    }
  });
  
  // Also handle SIGINT and SIGTERM signals (e.g. Ctrl+C in terminal)
  const signals = ['SIGINT', 'SIGTERM'];
  signals.forEach(signal => {
    process.on(signal, () => {
      console.log(`${signal} signal received, cleaning up...`);
      try {
        const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
        const serverProcess = getServerProcess();
        
        if (serverProcess) {
          console.log('Server still running, forcefully terminating...');
          killMinecraftServer();
        }
        
        // Allow a small delay for cleanup before exiting
        setTimeout(() => {
          console.log('Cleanup complete, exiting...');
          process.exit(0);
        }, 500);
      } catch (err) {
        console.error(`Error cleaning up on ${signal}:`, err);
        process.exit(1);
      }
    });
  });
}

module.exports = { setupAppCleanup };
