// Minecraft launcher IPC handlers
const { getMinecraftLauncher } = require('../services/minecraft-launcher/index.cjs');
const utils = require('../services/minecraft-launcher/utils.cjs');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { ensureServersDat } = require('../utils/servers-dat.cjs');

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
    'minecraft-auth': async (_e, { clientPath }) => {
      try {
        const result = await launcher.authenticateWithMicrosoft();
        
        // If authentication was successful and we have a client path, save the auth data immediately
        if (result.success && clientPath) {
          try {
            const saveResult = await launcher.saveAuthData(clientPath);
            if (saveResult.success) {
              console.log('[IPC] ✅ Authentication data saved automatically after successful login');
            } else {
              console.warn('[IPC] ⚠️ Failed to save auth data after successful login:', saveResult.error);
            }
          } catch (saveError) {
            console.warn('[IPC] ⚠️ Error auto-saving auth data:', saveError.message);
          }
        }
        
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Load saved authentication data
    'minecraft-load-auth': async (_e, { clientPath }) => {
      try {
        const result = await launcher.loadAuthData(clientPath);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Save authentication data
    'minecraft-save-auth': async (_e, { clientPath }) => {
      try {
        const result = await launcher.saveAuthData(clientPath);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Check and refresh authentication if needed
    'minecraft-check-refresh-auth': async (_e, { clientPath }) => {
      try {
        const result = await launcher.checkAndRefreshAuth();

        // If token was refreshed successfully, persist updated auth data
        if (result.success && result.refreshed && clientPath) {
          try {
            await launcher.saveAuthData(clientPath);
          } catch (saveError) {
            console.warn('[IPC] ⚠️ Failed to save refreshed auth data:', saveError.message);
          }
        }

        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Download required mods
    'minecraft-download-mods': async (_e, { clientPath, requiredMods, serverInfo }) => {
      try {
        if (!clientPath || !requiredMods || !Array.isArray(requiredMods)) {
          return { success: false, error: 'Invalid parameters' };
        }
        
        if (requiredMods.length === 0) {
          return { success: true, downloaded: 0, failures: [], message: 'No mods required' };
        }
        
        const downloaded = [];
        const failures = [];
        const skipped = [];
        
        // Process each required mod
        for (let i = 0; i < requiredMods.length; i++) {
          const mod = requiredMods[i];
          const progressPercent = Math.round(((i + 1) / requiredMods.length) * 100);
          
          try {
            const modPath = path.join(clientPath, 'mods', mod.fileName);
            
            // Check if mod already exists and has correct checksum
            if (fs.existsSync(modPath)) {
              if (mod.checksum) {
                const existingChecksum = utils.calculateFileChecksum(modPath);
                if (existingChecksum === mod.checksum) {
                  skipped.push(mod.fileName);
                  continue;
                }
              } else {
                skipped.push(mod.fileName);
                continue;
              }
            }
            
            // Download the mod file
            if (mod.downloadUrl) {
              await new Promise((resolve, reject) => {
                const protocol = mod.downloadUrl.startsWith('https:') ? https : http;
                const file = fs.createWriteStream(modPath);
                
                const request = protocol.get(mod.downloadUrl, (response) => {
                  if (response.statusCode === 302 || response.statusCode === 301) {
                    // Handle redirects
                    file.close();
                    fs.unlinkSync(modPath); // Remove empty file
                    
                    const redirectUrl = response.headers.location;
                    const redirectProtocol = redirectUrl.startsWith('https:') ? https : http;
                    
                    redirectProtocol.get(redirectUrl, (redirectResponse) => {
                      if (redirectResponse.statusCode === 200) {
                        const file2 = fs.createWriteStream(modPath);
                        redirectResponse.pipe(file2);
                        
                        file2.on('finish', () => {
                          file2.close();
                          
                          // Verify checksum if provided
                          if (mod.checksum) {
                            const downloadedChecksum = utils.calculateFileChecksum(modPath);
                            if (downloadedChecksum !== mod.checksum) {
                              fs.unlinkSync(modPath); // Remove corrupted file
                              reject(new Error(`Checksum mismatch for ${mod.fileName}`));
                              return;
                            }
                          }
                          
                          downloaded.push(mod.fileName);
                          resolve();
                        });
                        
                        file2.on('error', (err) => {
                          fs.unlinkSync(modPath);
                          reject(err);
                        });
                      } else {
                        reject(new Error(`Failed to download ${mod.fileName}: HTTP ${redirectResponse.statusCode}`));
                      }
                    }).on('error', reject);
                  } else if (response.statusCode === 200) {
                    response.pipe(file);
                    
                    file.on('finish', () => {
                      file.close();
                      
                      // Verify checksum if provided
                      if (mod.checksum) {
                        const downloadedChecksum = utils.calculateFileChecksum(modPath);
                        if (downloadedChecksum !== mod.checksum) {
                          fs.unlinkSync(modPath); // Remove corrupted file
                          reject(new Error(`Checksum mismatch for ${mod.fileName}`));
                          return;
                        }
                      }
                      
                      downloaded.push(mod.fileName);
                      resolve();
                    });
                    
                    file.on('error', (err) => {
                      fs.unlinkSync(modPath);
                      reject(err);
                    });
                  } else {
                    file.close();
                    fs.unlinkSync(modPath);
                    reject(new Error(`Failed to download ${mod.fileName}: HTTP ${response.statusCode}`));
                  }
                }).on('error', (err) => {
                  file.close();
                  if (fs.existsSync(modPath)) {
                    fs.unlinkSync(modPath);
                  }
                  reject(err);
                });
                
                request.setTimeout(30000, () => {
                  request.abort();
                  reject(new Error(`Download timeout for ${mod.fileName}`));
                });
              });
            } else {
              // If no download URL, this is an error condition
              failures.push({
                fileName: mod.fileName,
                error: 'No download URL provided'
              });
            }
            
          } catch (error) {
            failures.push({
              fileName: mod.fileName,
              error: error.message
            });
          }
        }
        
        const totalProcessed = downloaded.length + failures.length + skipped.length;
        const successCount = downloaded.length + skipped.length;
        
        const result = {
          success: failures.length === 0,
          downloaded: downloaded.length,
          skipped: skipped.length,
          failures: failures,
          message: failures.length === 0 
            ? `Successfully processed ${totalProcessed} mods (${downloaded.length} downloaded, ${skipped.length} already present)`
            : `Processed ${successCount}/${totalProcessed} mods successfully, ${failures.length} failed`
        };
        
        return result;
        
      } catch (error) {
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
          managementPort,
          clientName,
          requiredMods = [],
          serverInfo = null,
          maxMemory = null, // Add maxMemory parameter
          useProperLauncher = true // New option to use XMCL proper launcher
        } = options;

        // Ensure servers.dat has our server before launching
        try {
          const datRes = await ensureServersDat(
            clientPath,
            serverIp,
            managementPort,
            clientName || 'Minecraft Server',
            serverPort
          );
          if (datRes.success) {
            console.log('[IPC] servers.dat ensured before launch');
          } else {
            console.warn(`[IPC] Failed to ensure servers.dat before launch: ${datRes.error}`);
          }
        } catch (err) {
          console.warn('[IPC] Error while ensuring servers.dat:', err.message);
        }
        
        // Try proper launcher first to fix LogUtils issues
        if (useProperLauncher) {
          console.log(`[IPC] Attempting launch with XMCL proper launcher to fix LogUtils...`);
          
          const properResult = await launcher.launchMinecraftProper({
            clientPath,
            minecraftVersion,
            serverIp,
            serverPort: parseInt(serverPort),
            requiredMods,
            serverInfo,
            maxMemory,
            needsFabric: serverInfo?.loaderType === 'fabric' || requiredMods.length > 0,
            fabricVersion: serverInfo?.loaderVersion || 'latest'
          });
          
          if (properResult.success) {
            console.log(`[IPC] ✅ XMCL proper launcher succeeded!`);
            return properResult;
          } else {
            console.warn(`[IPC] ⚠️ XMCL proper launcher failed: ${properResult.error}`);
            console.log(`[IPC] Falling back to original launcher...`);
          }
        }
        
        // Fallback to original launcher
        console.log(`[IPC] Using original launcher implementation...`);
        const result = await launcher.launchMinecraft({
          clientPath,
          minecraftVersion,
          serverIp,
          serverPort: parseInt(serverPort), // Minecraft server port (25565)
          requiredMods,
          serverInfo,
          maxMemory // Pass maxMemory to launcher
        });
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Stop Minecraft
    'minecraft-stop': async () => {
      try {
        const result = await launcher.stopMinecraft();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Get launcher status
    'minecraft-launcher-status': async () => {
      try {
        const status = launcher.getStatus();
        return { success: true, status };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Get launcher status (shorter alias)
    'minecraft-get-status': async () => {
      try {
        const status = launcher.getStatus();
        return status;
      } catch (error) {
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
            const existingChecksum = utils.calculateFileChecksum(actualModPath);
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
              const existingChecksum = utils.calculateFileChecksum(actualModPath);
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
        return { success: false, error: error.message };
      }
    },
    
    // Check Minecraft client synchronization
    'minecraft-check-client': async (_e, { clientPath, minecraftVersion, requiredMods = [], serverInfo = null }) => {
      try {
        const result = await launcher.checkMinecraftClient(clientPath, minecraftVersion, { requiredMods, serverInfo });
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Check Minecraft client sync status (alternative endpoint)
    'minecraft-check-client-sync': async (_e, { clientPath, minecraftVersion, requiredMods = [], serverInfo = null }) => {
      try {
        const result = await launcher.checkMinecraftClient(clientPath, minecraftVersion, { requiredMods, serverInfo });
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Download Minecraft client files
    'minecraft-download-client': async (_e, { clientPath, minecraftVersion, requiredMods = [], serverInfo = null }) => {
      try {
        // Extract serverIp from serverInfo if available for server list addition
        const downloadOptions = { 
          requiredMods, 
          serverInfo 
        };
        
        // Add serverIp to options if it's in serverInfo
        if (serverInfo && serverInfo.serverIp) {
          downloadOptions.serverIp = serverInfo.serverIp;
        }
        
        const result = await launcher.downloadMinecraftClientSimple(clientPath, minecraftVersion, downloadOptions);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    // Clear Minecraft client files
    'minecraft-clear-client': async (_e, { clientPath, minecraftVersion }) => {
      try {
        const result = await launcher.clearMinecraftClient(clientPath, minecraftVersion);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Clear just assets (for fixing corrupted assets)
    'minecraft-clear-assets': async (_e, { clientPath }) => {
      try {
        const result = await launcher.clearAssets(clientPath);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Reset launcher state (for when it gets stuck)
    'minecraft-reset-launcher': async () => {
      try {
        launcher.resetLauncherState();
        return { success: true, message: 'Launcher state reset' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Toggle client mod (enable/disable)
    'toggle-client-mod': async (_e, { clientPath, modFileName, enabled }) => {
      try {
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
            return { success: true, action: 'enabled' };
          } else if (fs.existsSync(modPath)) {
            // Already enabled
            return { success: true, action: 'already_enabled' };
          } else {
            return { success: false, error: 'Mod file not found' };
          }
        } else {
          // Disable mod: rename from .jar to .jar.disabled
          if (fs.existsSync(modPath)) {
            fs.renameSync(modPath, disabledModPath);
            return { success: true, action: 'disabled' };
          } else if (fs.existsSync(disabledModPath)) {
            // Already disabled
            return { success: true, action: 'already_disabled' };
          } else {
            return { success: false, error: 'Mod file not found' };
          }
        }
      } catch (error) {
        return { success: false, error: error.message };
      }
    },


  };
}

module.exports = { createMinecraftLauncherHandlers }; 