// Application cleanup utilities
const { ipcMain } = require('electron');
const { safeSend } = require('./safe-send.cjs');
const process = require('process');
const { exec } = require('child_process');
let isQuitting = false;

/**
 * Kill Vite dev server and any other development processes
 */
function killDevelopmentProcesses() {
  return new Promise((resolve) => {
    
    if (process.platform === 'win32') {
      // Windows - kill processes on ports 5173 and 5174
      const killCommands = [
        'netstat -ano | findstr :5173',
        'netstat -ano | findstr :5174'
      ];
      
      let processesKilled = 0;
      let commandsCompleted = 0;
      
      killCommands.forEach((findCmd) => {
        exec(findCmd, (error, stdout) => {
          commandsCompleted++;
          
          if (!error && stdout.trim()) {
            const lines = stdout.trim().split('\n');
            lines.forEach(line => {
              const match = line.match(/\s+(\d+)$/);
              if (match) {
                const pid = match[1];
                exec(`taskkill /PID ${pid} /F`, (killError) => {
                  if (!killError) {
                    processesKilled++;
                  }
                });
              }
            });
          }
          
          if (commandsCompleted === killCommands.length) {
            setTimeout(() => {
              console.log(`🔄 Development cleanup complete (${processesKilled} processes killed)`);
              resolve();
            }, 1000);
          }
        });
      });
      
      // Also try to kill by process name
      exec('taskkill /IM node.exe /F /FI "WINDOWTITLE eq Administrator:  npm run dev:vite*"', () => {});
      exec('taskkill /IM node.exe /F /FI "COMMANDLINE eq *vite*dev*"', () => {});
      
      if (commandsCompleted === 0) {
        setTimeout(resolve, 1000);
      }
    } else {
      // Linux/Mac - kill processes on ports 5173 and 5174
      const killCommands = [
        'lsof -ti:5173',
        'lsof -ti:5174'
      ];
      
      let commandsCompleted = 0;
      let processesKilled = 0;
      
      killCommands.forEach(cmd => {
        exec(cmd, (error, stdout) => {
          commandsCompleted++;
          
          if (!error && stdout.trim()) {
            const pids = stdout.trim().split('\n');
            pids.forEach(pid => {
              if (pid) {
                exec(`kill -9 ${pid}`, (killError) => {
                  if (!killError) {
                    processesKilled++;
                  }
                });
              }
            });
          }
          
          if (commandsCompleted === killCommands.length) {
            setTimeout(() => {
              console.log(`🔄 Development cleanup complete (${processesKilled} processes killed)`);
              resolve();
            }, 1000);
          }
        });
      });
      
      if (commandsCompleted === 0) {
        setTimeout(resolve, 1000);
      }
    }
  });
}

/**
 * Clear all application intervals and timers
 */
function clearAllIntervals() {
  
  try {
    // Clear server manager intervals
    const { clearIntervals: clearServerIntervals } = require('../services/server-manager.cjs');
    clearServerIntervals();
    
    // Clear management server intervals
    const { getManagementServer } = require('../services/management-server.cjs');
    const managementServer = getManagementServer();
    if (managementServer && managementServer.stopClientCleanup) {
      managementServer.stopClientCleanup();
    }
    
    // Clear backup intervals
    const { clearBackupIntervals } = require('../ipc/backup-handlers.cjs');
    clearBackupIntervals();
  } catch (error) {
    console.warn('⚠️ Error clearing some intervals:', error.message);
  }
}

/**
 * Complete application cleanup
 */
async function performCompleteCleanup() {
  
  try {
    // 1. Stop metrics reporting
    const { stopMetricsReporting } = require('../services/system-metrics.cjs');
    stopMetricsReporting();
    
    // 2. Clear all intervals
    clearAllIntervals();
    
    // 3. Kill Minecraft server if running
    const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
    const serverProcess = getServerProcess();
    if (serverProcess) {
      killMinecraftServer();
    }
    
    // 4. Kill development processes (Vite, etc.)
    await killDevelopmentProcesses();
    
    console.log('✅ Complete cleanup finished');
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}

function setupAppCleanup(app, win) {
  // Handle window close event to ensure server is stopped before app quits
  if (win) {
    win.on('close', async (e) => {
      if (!isQuitting) {
        e.preventDefault();
        
        // Import modules here to avoid circular dependencies
        const { getServerProcess } = require('../services/server-manager.cjs');
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
            try {
              await performCompleteCleanup();
              isQuitting = true;
              win.close();
            } catch (err) {
              console.error(err);
              isQuitting = true;
              win.close();
            }
          }
        } else {
          // No server running, just do cleanup
          try {
            await performCompleteCleanup();
          } catch (error) {
            console.error('Cleanup error:', error);
          }
          
          isQuitting = true;
          win.close();
        }
      }
    });
  }
  
  // Ensure all processes are cleaned up on quit
  app.on('quit', async () => {
    await performCompleteCleanup();
  });
  
  // Also handle SIGINT and SIGTERM signals (e.g. Ctrl+C in terminal)
  const signals = ['SIGINT', 'SIGTERM'];
  signals.forEach(signal => {
    process.on(signal, async () => {
      console.log(`📡 Received ${signal}, cleaning up...`);
      
      try {
        await performCompleteCleanup();
        
        // Allow a small delay for cleanup before exiting
        setTimeout(() => {
          process.exit(0);
        }, 1500);
      } catch (err) {
        console.error('Cleanup error:', err);
        process.exit(1);
      }
    });
  });
}

module.exports = { setupAppCleanup, performCompleteCleanup, clearAllIntervals, killDevelopmentProcesses };
