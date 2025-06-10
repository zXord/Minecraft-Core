// Installation and download IPC handlers
const fs = require('fs');
const path = require('path');
const { 
  downloadMinecraftServer,
  installFabric
} = require('../services/download-manager.cjs');

/**
 * Create installation and download IPC handlers
 * 
 * @param {object} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createInstallHandlers(win) {
  return {
    'check-java': async () => {
      try {
        const { exec } = require('child_process');
        
        return new Promise((resolve) => {
          exec('java -version', (error, stdout, stderr) => {
            if (error) {
              resolve({ installed: false, error: error.message });
              return;
            }
            
            // Java outputs version to stderr by default
            const output = stderr || stdout;
            resolve({ 
              installed: true, 
              version: output.split('\n')[0].trim()
            });
          });
        });
      } catch (err) {
        return { installed: false, error: err.message };
      }
    },
    
    'download-minecraft-server': async (_e, { mcVersion, targetPath }) => {
      try {
        if (!mcVersion || typeof mcVersion !== 'string') {
          throw new Error('Invalid Minecraft version');
        }
        
        if (!targetPath || !fs.existsSync(targetPath)) {
          throw new Error('Invalid target directory');
        }
        
        return await downloadMinecraftServer(mcVersion, targetPath);
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    'download-and-install-fabric': async (_e, { path: targetPath, mcVersion, fabricVersion }) => {
      try {
        if (!targetPath || !fs.existsSync(targetPath)) {
          throw new Error('Invalid target directory');
        }
        
        if (!mcVersion || typeof mcVersion !== 'string') {
          throw new Error('Invalid Minecraft version');
        }
        
        if (!fabricVersion || typeof fabricVersion !== 'string') {
          throw new Error('Invalid Fabric version');
        }
        
        await installFabric(targetPath, mcVersion, fabricVersion);
        return { success: true };
      } catch (err) {
        if (win && win.webContents) {
          win.webContents.send('install-error', err.message);
        }
        return { success: false, error: err.message };
      }
    },
      'check-health': (_e, targetPath) => {
      if (!targetPath || !fs.existsSync(targetPath)) {
        throw new Error('Invalid target directory');
      }
      
      const missing = [];
      const files = ['server.jar', 'fabric-installer.jar', 'fabric-server-launch.jar'];
      
      files.forEach(file => {
        if (!fs.existsSync(path.join(targetPath, file))) {
          missing.push(file);
        }
      });
      
      return missing;
    },
    
    'repair-health': async (_e, { targetPath, mcVersion, fabricVersion }) => {
      
      try {
        if (!targetPath || !fs.existsSync(targetPath)) {
          throw new Error('Invalid target directory');
        }
        
        if (!mcVersion || typeof mcVersion !== 'string') {
          throw new Error('Invalid Minecraft version');
        }
        
        if (!fabricVersion || typeof fabricVersion !== 'string') {
          throw new Error('Invalid Fabric version');
        }
        
        const files = ['server.jar', 'fabric-installer.jar', 'fabric-server-launch.jar'];
        const toRepair = files.filter(f => !fs.existsSync(path.join(targetPath, f)));

        if (toRepair.length === 0) {
          if (win && win.webContents) {
            win.webContents.send('repair-status', 'done');
          }
          return [];
        }

        for (const file of toRepair) {
          if (win && win.webContents) {
            win.webContents.send('repair-log', `🔧 Repairing ${file}...`);
          }
          
          if (file === 'server.jar') {
            try {
              await downloadMinecraftServer(mcVersion, targetPath, 'repair-progress');
              if (win && win.webContents) {
                win.webContents.send('repair-log', '✔ server.jar downloaded');
              }
            } catch (downloadErr) {
              if (win && win.webContents) {
                win.webContents.send('repair-log', `❌ Error downloading server.jar: ${downloadErr.message}`);
              }
              throw downloadErr;
            }
          } else if (file.includes('fabric')) {
            try {
              await installFabric(targetPath, mcVersion, fabricVersion);
            } catch (fabricErr) {
              if (win && win.webContents) {
                win.webContents.send('repair-log', `❌ Error installing Fabric: ${fabricErr.message}`);
              }
              throw fabricErr;
            }
          }
          
          // Verify file was actually created
          if (fs.existsSync(path.join(targetPath, file))) {
            if (win && win.webContents) {
              win.webContents.send('repair-log', `✔ ${file} repaired`);
            }
          } else {
            if (win && win.webContents) {
              win.webContents.send('repair-log', `❌ Failed to repair ${file}`);
            }
          }
        }

        if (win && win.webContents) {
          win.webContents.send('repair-status', 'done');
        }
        
        return toRepair;
      } catch (err) {
        if (win && win.webContents) {
          win.webContents.send('repair-log', `❌ Error: ${err.message}`);
          win.webContents.send('repair-status', 'error');
        }
        throw err;
      }
    }
  };
}

module.exports = { createInstallHandlers };
