// Installation and download IPC handlers
const fs = require('fs');
const path = require('path');
const { 
  downloadMinecraftServer,
  installFabric
} = require('../services/download-manager.cjs');
const { ServerJavaManager } = require('../services/server-java-manager.cjs');

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
    
    'check-health': async (_e, targetPath) => {
      if (!targetPath || !fs.existsSync(targetPath)) {
        throw new Error('Invalid target directory');
      }
      
      const missing = [];
      const files = ['server.jar', 'fabric-installer.jar', 'fabric-server-launch.jar'];
      
      // Check for missing server files
      files.forEach(file => {
        if (!fs.existsSync(path.join(targetPath, file))) {
          missing.push(file);
        }
      });
      
      // Check Java requirements
      try {
        // Read server configuration to get Minecraft version
        const configPath = path.join(targetPath, '.minecraft-core.json');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (config.version) {
            const serverJavaManager = new ServerJavaManager(targetPath);
            const javaRequirements = serverJavaManager.getJavaRequirementsForMinecraft(config.version);
            
            if (javaRequirements.needsDownload) {
              missing.push(`Java ${javaRequirements.requiredJavaVersion} (for Minecraft ${config.version})`);
            }
          }
        }
      } catch (error) {
        // TODO: Add proper logging - Could not check Java requirements
      }
      
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
        
        // Check Java requirements
        const serverJavaManager = new ServerJavaManager(targetPath);
        const javaRequirements = serverJavaManager.getJavaRequirementsForMinecraft(mcVersion);
        const needsJava = javaRequirements.needsDownload;
        
        if (toRepair.length === 0 && !needsJava) {
          if (win && win.webContents) {
            win.webContents.send('repair-status', 'done');
          }
          return [];
        }

        // Repair Java first if needed
        if (needsJava) {
          if (win && win.webContents) {
            win.webContents.send('repair-log', `🔧 Installing Java ${javaRequirements.requiredJavaVersion}...`);
          }
          
          try {
            const javaResult = await serverJavaManager.ensureJavaForMinecraft(
              mcVersion,
              (progress) => {
                // Send progress updates
                if (win && win.webContents) {
                  win.webContents.send('repair-progress', {
                    percent: progress.progress || 0,
                    speed: progress.speed || '0 MB/s'
                  });
                }
              }
            );
            
            if (javaResult.success) {
              if (win && win.webContents) {
                win.webContents.send('repair-log', `✔ Java ${javaRequirements.requiredJavaVersion} installed`);
              }
            } else {
              if (win && win.webContents) {
                win.webContents.send('repair-log', `❌ Error installing Java: ${javaResult.error}`);
              }
              throw new Error(`Java installation failed: ${javaResult.error}`);
            }
          } catch (javaErr) {
            if (win && win.webContents) {
              win.webContents.send('repair-log', `❌ Error installing Java: ${javaErr.message}`);
            }
            throw javaErr;
          }
        }

        // Repair server files
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
        
        const repairedItems = [...toRepair];
        if (needsJava) {
          repairedItems.push(`Java ${javaRequirements.requiredJavaVersion}`);
        }
        
        return repairedItems;
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
