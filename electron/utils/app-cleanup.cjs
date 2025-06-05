// Application cleanup utilities
const { dialog } = require('electron');
const path = require('path');
const fs = require('fs');
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

        const iconCandidate = path.join(__dirname, '..', 'resources', 'icon.png');
        const iconPath = fs.existsSync(iconCandidate) ? iconCandidate : undefined;
        
        if (serverProcess) {
          const dialogOpts = {
            type: 'question',
            buttons: ['Yes', 'No'],
            defaultId: 0,
            title: 'Minecraft Server Running',
            message: 'The Minecraft server is still running.',
            detail: 'Would you like to stop the server and quit the application?',
            icon: iconPath,
            noLink: true,
            customStylesheet: `
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                background: #2a2a2a;
                color: #ffffff;
              }
              .dialog-button {
                background: #3a3a3a;
                border: 1px solid #4a4a4a;
                color: #ffffff;
                border-radius: 4px;
                padding: 8px 16px;
              }
              .dialog-button:hover {
                background: #4a4a4a;
              }
              .dialog-button.primary {
                background: #646cff;
                border-color: #535bf2;
              }
              .dialog-button.primary:hover {
                background: #535bf2;
              }
            `
          };
          
          const choice = await dialog.showMessageBox(win, dialogOpts);
          
          if (choice.response === 0) {
            // User chose to stop the server
            console.log('Stopping server before exit...');
            try {
              killMinecraftServer();
              
              // Give the server a moment to shut down
              await new Promise(resolve => setTimeout(resolve, 500));
              
              // Proceed with app quit
              app.isQuitting = true;
              win.close();
            } catch (err) {
              console.error('Error stopping server:', err);
              app.isQuitting = true;
              win.close();
            }
          } else {
            // User chose not to quit
            console.log('User canceled application exit');
          }
        } else {
          // No server running, proceed with quit
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
