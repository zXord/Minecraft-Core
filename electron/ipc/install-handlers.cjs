// Installation and download IPC handlers
const path = require('path');
const fs = require('fs');
const { 
  downloadMinecraftServer,
  installFabric
} = require('../services/download-manager.cjs');

/**
 * Create installation and download IPC handlers
 * 
 * @param {BrowserWindow} win - The main application window
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
              console.log('Java not found:', error.message);
              resolve({ installed: false, error: error.message });
              return;
            }
            
            // Java outputs version to stderr by default
            const output = stderr || stdout;
            console.log('Java found:', output);
            resolve({ 
              installed: true, 
              version: output.split('\n')[0].trim()
            });
          });
        });
      } catch (err) {
        console.error('Error checking Java installation:', err);
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
        console.error('Error downloading Minecraft server:', err);
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
        console.error('Error installing Fabric:', err);
        return { success: false, error: err.message };
      }
    },
    
    'check-health': (_e, targetPath) => {
      try {
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
      } catch (err) {
        console.error('Error checking server health:', err);
        throw err;
      }
    },
    
    'repair-health': async (_e, { targetPath, mcVersion, fabricVersion }) => {
      console.log('Starting repair-health handler with:', { targetPath, mcVersion, fabricVersion });
      
      try {
        if (!targetPath || !fs.existsSync(targetPath)) {
          console.error('Invalid target directory:', targetPath);
          throw new Error('Invalid target directory');
        }
        
        if (!mcVersion || typeof mcVersion !== 'string') {
          console.error('Invalid Minecraft version:', mcVersion);
          throw new Error('Invalid Minecraft version');
        }
        
        if (!fabricVersion || typeof fabricVersion !== 'string') {
          console.error('Invalid Fabric version:', fabricVersion);
          throw new Error('Invalid Fabric version');
        }
        
        const files = ['server.jar', 'fabric-installer.jar', 'fabric-server-launch.jar'];
        const toRepair = files.filter(f => !fs.existsSync(path.join(targetPath, f)));
        console.log('Files to repair:', toRepair);

        if (toRepair.length === 0) {
          console.log('No files need repair');
          if (win && win.webContents) {
            win.webContents.send('repair-status', 'done');
          }
          return [];
        }

        for (const file of toRepair) {
          console.log(`Starting repair of ${file}`);
          if (win && win.webContents) {
            win.webContents.send('repair-log', `🔧 Repairing ${file}...`);
          }
          
          if (file === 'server.jar') {
            console.log(`Downloading Minecraft server version ${mcVersion}`);
            try {
              await downloadMinecraftServer(mcVersion, targetPath, 'repair-progress');
              console.log('Minecraft server download complete');
              if (win && win.webContents) {
                win.webContents.send('repair-log', '✔ server.jar downloaded');
              }
            } catch (downloadErr) {
              console.error('Error downloading Minecraft server:', downloadErr);
              if (win && win.webContents) {
                win.webContents.send('repair-log', `❌ Error downloading server.jar: ${downloadErr.message}`);
              }
              throw downloadErr;
            }
          } else if (file.includes('fabric')) {
            console.log(`Installing Fabric with mcVersion=${mcVersion}, fabricVersion=${fabricVersion}`);
            try {
              await installFabric(targetPath, mcVersion, fabricVersion);
              console.log('Fabric installation complete');
            } catch (fabricErr) {
              console.error('Error installing Fabric:', fabricErr);
              if (win && win.webContents) {
                win.webContents.send('repair-log', `❌ Error installing Fabric: ${fabricErr.message}`);
              }
              throw fabricErr;
            }
          }
          
          // Verify file was actually created
          if (fs.existsSync(path.join(targetPath, file))) {
            console.log(`Successfully repaired ${file}`);
            if (win && win.webContents) {
              win.webContents.send('repair-log', `✔ ${file} repaired`);
            }
          } else {
            console.error(`Failed to repair ${file} - file not found after repair attempt`);
            if (win && win.webContents) {
              win.webContents.send('repair-log', `❌ Failed to repair ${file}`);
            }
          }
        }

        console.log('Repair completed successfully');
        if (win && win.webContents) {
          win.webContents.send('repair-status', 'done');
        }
        
        return toRepair;
      } catch (err) {
        console.error('Error repairing server health:', err);
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
