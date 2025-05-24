// Minecraft launcher IPC handlers
const { getMinecraftLauncher } = require('../services/minecraft-launcher.cjs');

/**
 * Create Minecraft launcher IPC handlers
 * 
 * @param {BrowserWindow} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createMinecraftLauncherHandlers(win) {
  const launcher = getMinecraftLauncher();
  
  // Set up launcher event forwarding to renderer
  launcher.on('auth-success', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-auth-success', data);
    }
  });
  
  launcher.on('auth-error', (error) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-auth-error', error);
    }
  });
  
  launcher.on('download-start', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-download-start', data);
    }
  });
  
  launcher.on('download-progress', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-download-progress', data);
    }
  });
  
  launcher.on('download-complete', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-download-complete', data);
    }
  });
  
  launcher.on('launch-start', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-launch-start');
    }
  });
  
  launcher.on('launch-progress', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-launch-progress', data);
    }
  });
  
  launcher.on('launch-success', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-launch-success');
    }
  });
  
  launcher.on('launch-error', (error) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-launch-error', error);
    }
  });
  
  launcher.on('minecraft-closed', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-minecraft-closed', data);
    }
  });
  
  launcher.on('minecraft-stopped', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-minecraft-stopped');
    }
  });
  
  // Client download events
  launcher.on('client-download-start', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-client-download-start', data);
    }
  });
  
  launcher.on('client-download-progress', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-client-download-progress', data);
    }
  });
  
  launcher.on('client-download-complete', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-client-download-complete', data);
    }
  });
  
  launcher.on('client-download-error', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-client-download-error', data);
    }
  });
  
  // Java download events
  launcher.on('java-download-start', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-java-download-start', data);
    }
  });
  
  launcher.on('java-download-progress', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-java-download-progress', data);
    }
  });
  
  launcher.on('java-download-complete', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-java-download-complete', data);
    }
  });
  
  launcher.on('java-download-error', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('launcher-java-download-error', data);
    }
  });
  
  return {
    // Authenticate with Microsoft
    'minecraft-auth': async () => {
      try {
        console.log('[IPC] Starting Microsoft authentication...');
        const result = await launcher.authenticateWithMicrosoft();
        return result;
      } catch (error) {
        console.error('[IPC] Microsoft authentication error:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Load saved authentication data
    'minecraft-load-auth': async (_e, { clientPath }) => {
      try {
        console.log(`[IPC] Loading authentication data from: ${clientPath}`);
        const result = await launcher.loadAuthData(clientPath);
        return result;
      } catch (error) {
        console.error('[IPC] Error loading auth data:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Save authentication data
    'minecraft-save-auth': async (_e, { clientPath }) => {
      try {
        console.log(`[IPC] Saving authentication data to: ${clientPath}`);
        const result = await launcher.saveAuthData(clientPath);
        return result;
      } catch (error) {
        console.error('[IPC] Error saving auth data:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Download required mods
    'minecraft-download-mods': async (_e, { clientPath, requiredMods, serverInfo }) => {
      try {
        console.log(`[IPC] minecraft-download-mods called with:`, {
          clientPath,
          requiredModsCount: requiredMods ? requiredMods.length : 'undefined',
          requiredMods: requiredMods,
          serverInfo
        });
        
        if (!clientPath || !requiredMods || !Array.isArray(requiredMods)) {
          console.log(`[IPC] Invalid parameters:`, { clientPath: !!clientPath, requiredMods: !!requiredMods, isArray: Array.isArray(requiredMods) });
          return { success: false, error: 'Invalid parameters' };
        }
        
        if (requiredMods.length === 0) {
          console.log(`[IPC] No mods required, returning success`);
          return { success: true, downloaded: 0, failures: [], message: 'No mods required' };
        }
        
        console.log(`[IPC] Downloading ${requiredMods.length} mods to: ${clientPath}`);
        console.log(`[IPC] Required mods:`, requiredMods.map(m => ({ fileName: m.fileName, downloadUrl: m.downloadUrl, checksum: m.checksum })));
        
        const fs = require('fs');
        const path = require('path');
        const https = require('https');
        const http = require('http');
        
        // Create mods directory if it doesn't exist
        const modsDir = path.join(clientPath, 'mods');
        console.log(`[IPC] Mods directory: ${modsDir}`);
        
        if (!fs.existsSync(modsDir)) {
          console.log(`[IPC] Creating mods directory...`);
          fs.mkdirSync(modsDir, { recursive: true });
        } else {
          console.log(`[IPC] Mods directory already exists`);
        }
        
        const downloaded = [];
        const failures = [];
        const skipped = [];
        
        console.log(`[IPC] Starting mod processing loop...`);
        
        // Process each required mod
        for (let i = 0; i < requiredMods.length; i++) {
          const mod = requiredMods[i];
          const progressPercent = Math.round(((i + 1) / requiredMods.length) * 100);
          
          console.log(`[IPC] Processing mod ${i + 1}/${requiredMods.length}: ${mod.fileName}`);
          
          // Send progress update
          if (!win.isDestroyed()) {
            console.log(`[IPC] Sending progress update: ${progressPercent}%`);
            win.webContents.send('launcher-download-progress', {
              type: 'Mods',
              task: `Processing mod ${mod.fileName} (${i + 1}/${requiredMods.length})`,
              total: requiredMods.length,
              current: i + 1,
              percent: progressPercent
            });
          } else {
            console.log(`[IPC] Window destroyed, cannot send progress update`);
          }
          
          try {
            const modPath = path.join(modsDir, mod.fileName);
            console.log(`[IPC] Checking mod path: ${modPath}`);
            
            // Check if mod already exists and has correct checksum
            if (fs.existsSync(modPath)) {
              console.log(`[IPC] Mod ${mod.fileName} already exists`);
              if (mod.checksum) {
                const existingChecksum = launcher.calculateFileChecksum(modPath);
                console.log(`[IPC] Checksum comparison: existing=${existingChecksum}, expected=${mod.checksum}`);
                if (existingChecksum === mod.checksum) {
                  console.log(`[IPC] Mod ${mod.fileName} already exists with correct checksum, skipping`);
                  skipped.push(mod.fileName);
                  continue;
                }
              } else {
                console.log(`[IPC] Mod ${mod.fileName} already exists, skipping (no checksum to verify)`);
                skipped.push(mod.fileName);
                continue;
              }
            } else {
              console.log(`[IPC] Mod ${mod.fileName} does not exist, will download`);
            }
            
            // Download the mod file
            if (mod.downloadUrl) {
              console.log(`[IPC] Downloading mod ${mod.fileName} from ${mod.downloadUrl}`);
              
              await new Promise((resolve, reject) => {
                const protocol = mod.downloadUrl.startsWith('https:') ? https : http;
                const file = fs.createWriteStream(modPath);
                
                const request = protocol.get(mod.downloadUrl, (response) => {
                  console.log(`[IPC] HTTP response status: ${response.statusCode}`);
                  
                  if (response.statusCode === 302 || response.statusCode === 301) {
                    // Handle redirects
                    console.log(`[IPC] Redirecting to: ${response.headers.location}`);
                    file.close();
                    fs.unlinkSync(modPath); // Remove empty file
                    
                    const redirectProtocol = response.headers.location.startsWith('https:') ? https : http;
                    const redirectRequest = redirectProtocol.get(response.headers.location, (redirectResponse) => {
                      if (redirectResponse.statusCode !== 200) {
                        reject(new Error(`HTTP ${redirectResponse.statusCode}: ${redirectResponse.statusMessage}`));
                        return;
                      }
                      
                      const redirectFile = fs.createWriteStream(modPath);
                      redirectResponse.pipe(redirectFile);
                      
                      redirectFile.on('finish', () => {
                        redirectFile.close();
                        
                        // Verify checksum if provided
                        if (mod.checksum) {
                          const downloadedChecksum = launcher.calculateFileChecksum(modPath);
                          console.log(`[IPC] Downloaded checksum: ${downloadedChecksum}, expected: ${mod.checksum}`);
                          if (downloadedChecksum !== mod.checksum) {
                            fs.unlinkSync(modPath); // Remove corrupted file
                            reject(new Error('Checksum verification failed'));
                            return;
                          }
                        }
                        
                        console.log(`[IPC] Successfully downloaded mod ${mod.fileName}`);
                        downloaded.push(mod.fileName);
                        resolve();
                      });
                      
                      redirectFile.on('error', (err) => {
                        console.error(`[IPC] File write error for ${mod.fileName}:`, err);
                        fs.unlinkSync(modPath); // Remove partial file
                        reject(err);
                      });
                    }).on('error', (err) => {
                      console.error(`[IPC] Redirect request error for ${mod.fileName}:`, err);
                      reject(err);
                    });
                    
                    return;
                  }
                  
                  if (response.statusCode !== 200) {
                    file.close();
                    fs.unlinkSync(modPath); // Remove empty file
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                    return;
                  }
                  
                  response.pipe(file);
                  
                  file.on('finish', () => {
                    file.close();
                    
                    // Verify checksum if provided
                    if (mod.checksum) {
                      const downloadedChecksum = launcher.calculateFileChecksum(modPath);
                      console.log(`[IPC] Downloaded checksum: ${downloadedChecksum}, expected: ${mod.checksum}`);
                      if (downloadedChecksum !== mod.checksum) {
                        fs.unlinkSync(modPath); // Remove corrupted file
                        reject(new Error('Checksum verification failed'));
                        return;
                      }
                    }
                    
                    console.log(`[IPC] Successfully downloaded mod ${mod.fileName}`);
                    downloaded.push(mod.fileName);
                    resolve();
                  });
                  
                  file.on('error', (err) => {
                    console.error(`[IPC] File write error for ${mod.fileName}:`, err);
                    if (fs.existsSync(modPath)) {
                      fs.unlinkSync(modPath); // Remove partial file
                    }
                    reject(err);
                  });
                }).on('error', (err) => {
                  console.error(`[IPC] HTTP request error for ${mod.fileName}:`, err);
                  if (fs.existsSync(modPath)) {
                    fs.unlinkSync(modPath); // Remove partial file
                  }
                  reject(err);
                });
                
                // Set timeout for download
                request.setTimeout(30000, () => {
                  request.destroy();
                  if (fs.existsSync(modPath)) {
                    fs.unlinkSync(modPath); // Remove partial file
                  }
                  reject(new Error('Download timeout'));
                });
              });
              
            } else {
              // If no download URL, this is an error condition
              console.error(`[IPC] No download URL for mod ${mod.fileName}`);
              failures.push({
                fileName: mod.fileName,
                error: 'No download URL provided'
              });
            }
            
          } catch (error) {
            console.error(`[IPC] Failed to download mod ${mod.fileName}:`, error);
            failures.push({
              fileName: mod.fileName,
              error: error.message
            });
          }
        }
        
        const totalProcessed = downloaded.length + failures.length + skipped.length;
        const successCount = downloaded.length + skipped.length;
        
        console.log(`[IPC] Mod download complete: ${downloaded.length} downloaded, ${skipped.length} skipped, ${failures.length} failed`);
        
        const result = {
          success: failures.length === 0,
          downloaded: downloaded.length,
          skipped: skipped.length,
          failures: failures,
          message: failures.length === 0 
            ? `Successfully processed ${totalProcessed} mods (${downloaded.length} downloaded, ${skipped.length} already present)`
            : `Processed ${successCount}/${totalProcessed} mods successfully, ${failures.length} failed`
        };
        
        console.log(`[IPC] Returning result:`, result);
        return result;
        
      } catch (error) {
        console.error('[IPC] Error downloading mods:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Launch Minecraft
    'minecraft-launch': async (_e, options) => {
      try {
        const {
          clientPath,
          minecraftVersion,
          serverIp,
          serverPort,
          requiredMods = [],
          serverInfo = null
        } = options;
        
        console.log(`[IPC] Launching Minecraft ${minecraftVersion} from: ${clientPath}`);
        const result = await launcher.launchMinecraft({
          clientPath,
          minecraftVersion,
          serverIp,
          serverPort: parseInt(serverPort), // Minecraft server port (25565)
          requiredMods,
          serverInfo
        });
        return result;
      } catch (error) {
        console.error('[IPC] Error launching Minecraft:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Stop Minecraft
    'minecraft-stop': async () => {
      try {
        console.log('[IPC] Stopping Minecraft...');
        const result = await launcher.stopMinecraft();
        return result;
      } catch (error) {
        console.error('[IPC] Error stopping Minecraft:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Get launcher status
    'minecraft-launcher-status': async () => {
      try {
        const status = launcher.getStatus();
        return { success: true, status };
      } catch (error) {
        console.error('[IPC] Error getting launcher status:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Get launcher status (shorter alias)
    'minecraft-get-status': async () => {
      try {
        const status = launcher.getStatus();
        return status;
      } catch (error) {
        console.error('[IPC] Error getting launcher status:', error);
        return { 
          isAuthenticated: false,
          isLaunching: false,
          isRunning: false,
          username: null,
          clientPath: null
        };
      }
    },
    
    // Check if mods are synchronized
    'minecraft-check-mods': async (_e, { clientPath, requiredMods, allClientMods = [] }) => {
      try {
        const fs = require('fs');
        const path = require('path');
        
        if (!clientPath || !requiredMods || !Array.isArray(requiredMods)) {
          return { success: false, error: 'Invalid parameters' };
        }
        
        const modsDir = path.join(clientPath, 'mods');
        
        if (!fs.existsSync(modsDir)) {
          return { 
            success: true, 
            synchronized: false, 
            missingMods: requiredMods.map(m => m.fileName),
            missingOptionalMods: allClientMods.filter(m => !m.required).map(m => m.fileName),
            totalRequired: requiredMods.length,
            totalOptional: allClientMods.filter(m => !m.required).length,
            totalPresent: 0,
            needsDownload: requiredMods.length
          };
        }
        
        // Get all .jar files (enabled mods) in the client mods directory
        const presentMods = fs.readdirSync(modsDir).filter(file => file.endsWith('.jar'));
        // Also check for .disabled files (disabled mods)
        const disabledMods = fs.readdirSync(modsDir)
          .filter(file => file.endsWith('.jar.disabled'))
          .map(file => file.replace('.disabled', '')); // Remove .disabled extension
        
        const missingMods = [];
        const outdatedMods = [];
        const missingOptionalMods = [];
        const outdatedOptionalMods = [];
        
        // Check required mods
        for (const requiredMod of requiredMods) {
          const modPath = path.join(modsDir, requiredMod.fileName);
          const isPresent = presentMods.includes(requiredMod.fileName) || disabledMods.includes(requiredMod.fileName);
          
          if (!isPresent) {
            missingMods.push(requiredMod.fileName);
          } else if (requiredMod.checksum) {
            // Check if mod is up to date using checksum
            const actualModPath = presentMods.includes(requiredMod.fileName) ? modPath : modPath + '.disabled';
            const existingChecksum = launcher.calculateFileChecksum(actualModPath);
            if (existingChecksum !== requiredMod.checksum) {
              outdatedMods.push(requiredMod.fileName);
            }
          }
        }
        
        // Check optional mods (if allClientMods provided)
        if (Array.isArray(allClientMods) && allClientMods.length > 0) {
          const optionalMods = allClientMods.filter(mod => !mod.required);
          
          for (const optionalMod of optionalMods) {
            const modPath = path.join(modsDir, optionalMod.fileName);
            const isPresent = presentMods.includes(optionalMod.fileName) || disabledMods.includes(optionalMod.fileName);
            
            if (!isPresent) {
              missingOptionalMods.push(optionalMod.fileName);
            } else if (optionalMod.checksum) {
              // Check if mod is up to date using checksum
              const actualModPath = presentMods.includes(optionalMod.fileName) ? modPath : modPath + '.disabled';
              const existingChecksum = launcher.calculateFileChecksum(actualModPath);
              if (existingChecksum !== optionalMod.checksum) {
                outdatedOptionalMods.push(optionalMod.fileName);
              }
            }
          }
        }
        
        // Synchronized means all required mods are present and up to date
        const synchronized = missingMods.length === 0 && outdatedMods.length === 0;
        
        return {
          success: true,
          synchronized,
          missingMods: missingMods.concat(outdatedMods),
          missingOptionalMods: missingOptionalMods.concat(outdatedOptionalMods),
          totalRequired: requiredMods.length,
          totalOptional: allClientMods.filter(m => !m.required).length,
          totalPresent: requiredMods.length - missingMods.length - outdatedMods.length,
          totalOptionalPresent: (allClientMods.filter(m => !m.required).length) - missingOptionalMods.length - outdatedOptionalMods.length,
          needsDownload: missingMods.length + outdatedMods.length,
          needsOptionalDownload: missingOptionalMods.length + outdatedOptionalMods.length,
          presentEnabledMods: presentMods,
          presentDisabledMods: disabledMods
        };
      } catch (error) {
        console.error('[IPC] Error checking mod synchronization:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Check Minecraft client synchronization
    'minecraft-check-client': async (_e, { clientPath, minecraftVersion }) => {
      try {
        console.log(`[IPC] Checking Minecraft ${minecraftVersion} client files in: ${clientPath}`);
        const result = await launcher.checkMinecraftClient(clientPath, minecraftVersion);
        return { success: true, ...result };
      } catch (error) {
        console.error('[IPC] Error checking client synchronization:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Download Minecraft client files
    'minecraft-download-client': async (_e, { clientPath, minecraftVersion }) => {
      try {
        console.log(`[IPC] Downloading Minecraft ${minecraftVersion} client files to: ${clientPath}`);
        const result = await launcher.downloadMinecraftClientSimple(clientPath, minecraftVersion);
        return result;
      } catch (error) {
        console.error('[IPC] Error downloading client files:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Clear Minecraft client files
    'minecraft-clear-client': async (_e, { clientPath, minecraftVersion }) => {
      try {
        console.log(`[IPC] Clearing Minecraft ${minecraftVersion} client files from: ${clientPath}`);
        const result = await launcher.clearMinecraftClient(clientPath, minecraftVersion);
        return result;
      } catch (error) {
        console.error('[IPC] Error clearing client files:', error);
        return { success: false, error: error.message };
      }
    },

    // Toggle client mod (enable/disable)
    'toggle-client-mod': async (_e, { clientPath, modFileName, enabled }) => {
      try {
        const fs = require('fs');
        const path = require('path');
        
        if (!clientPath || !modFileName) {
          return { success: false, error: 'Client path and mod file name are required' };
        }
        
        const modsDir = path.join(clientPath, 'mods');
        const modPath = path.join(modsDir, modFileName);
        const disabledModPath = path.join(modsDir, modFileName + '.disabled');
        
        if (enabled) {
          // Enable mod: rename from .jar.disabled to .jar
          if (fs.existsSync(disabledModPath)) {
            fs.renameSync(disabledModPath, modPath);
            console.log(`[IPC] Enabled mod: ${modFileName}`);
            return { success: true, action: 'enabled' };
          } else if (fs.existsSync(modPath)) {
            // Already enabled
            console.log(`[IPC] Mod already enabled: ${modFileName}`);
            return { success: true, action: 'already_enabled' };
          } else {
            return { success: false, error: 'Mod file not found' };
          }
        } else {
          // Disable mod: rename from .jar to .jar.disabled
          if (fs.existsSync(modPath)) {
            fs.renameSync(modPath, disabledModPath);
            console.log(`[IPC] Disabled mod: ${modFileName}`);
            return { success: true, action: 'disabled' };
          } else if (fs.existsSync(disabledModPath)) {
            // Already disabled
            console.log(`[IPC] Mod already disabled: ${modFileName}`);
            return { success: true, action: 'already_disabled' };
          } else {
            return { success: false, error: 'Mod file not found' };
          }
        }
      } catch (error) {
        console.error('[IPC] Error toggling client mod:', error);
        return { success: false, error: error.message };
      }
    },
  };
}

module.exports = { createMinecraftLauncherHandlers }; 