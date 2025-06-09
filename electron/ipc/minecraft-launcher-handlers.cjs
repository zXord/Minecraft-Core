// Minecraft launcher IPC handlers
const { getMinecraftLauncher } = require('../services/minecraft-launcher/index.cjs');
const utils = require('../services/minecraft-launcher/utils.cjs');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { readModMetadataFromJar } = require('./mod-utils/mod-file-manager.cjs');
const { ensureServersDat } = require('../utils/servers-dat.cjs');

/**
 * Check if a mod is compatible with a specific Minecraft version
 * @param {string} modFileName - The name of the mod file
 * @param {string} targetVersion - The target Minecraft version
 * @returns {boolean} Whether the mod is compatible
 */
function checkModCompatibility(modFileName, targetVersion) {
  // Basic compatibility check - this is a simplified implementation
  // In a real scenario, you'd parse the mod's metadata to check supported versions
  try {
    // Extract version info from filename if available
    const versionMatch = modFileName.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (versionMatch) {
      const modVersion = versionMatch[1];
      const targetMajorMinor = targetVersion.split('.').slice(0, 2).join('.');
      const modMajorMinor = modVersion.split('.').slice(0, 2).join('.');
      return targetMajorMinor === modMajorMinor;
    }
    
    // If no version info in filename, assume compatible
    return true;
  } catch (error) {
    // On error, assume compatible to avoid breaking functionality
    return true;
  }
}

function getBaseModName(fileName) {
  if (!fileName) return '';
  const clean = fileName.toLowerCase().replace(/\.jar$/i, '');
  const segments = clean.split(/[-_+]/);
  const base = [];
  for (const seg of segments) {
    if (/^(?:v?\d|mc\d)/i.test(seg)) break;
    base.push(seg);
  }
  return base.join('-');
}

function extractVersionFromFilename(fileName) {
  if (!fileName) return null;
  const clean = fileName.toLowerCase().replace(/\.jar$/i, '');
  const segments = clean.split(/[-_+]/).reverse();
  for (const seg of segments) {
    if (/^mc\d+(?:\.\d+)*$/i.test(seg)) continue;
    const match = seg.match(/^v?(\d+\.\d+(?:\.\d+)?)/);
    if (match) return match[1];
  }
  return null;
}

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
            } else {
            }
          } catch (saveError) {
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
          }
        }

        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
      // Download required mods and clean up removed ones
      'minecraft-download-mods': async (_e, { clientPath, requiredMods, allClientMods = [], serverInfo }) => {
      try {
        if (!clientPath || !requiredMods || !Array.isArray(requiredMods)) {
          return { success: false, error: 'Invalid parameters' };
        }
        
        if (requiredMods.length === 0) {
          return { success: true, downloaded: 0, failures: [], message: 'No mods required' };
        }

        // Check for manual mods before starting download
        const modsDir = path.join(clientPath, 'mods');
        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
        const manualModsAnalysis = { found: [], willUpdate: [], willDisable: [], willKeep: [] };
        
        if (fs.existsSync(modsDir)) {
          const existingMods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
          for (const modFile of existingMods) {
            const manifestPath = path.join(manifestDir, `${modFile}.json`);
            let isManual = true;
            
            if (fs.existsSync(manifestPath)) {
              try {
                const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                isManual = manifestData.source === 'manual';
              } catch (e) {
                isManual = true;
              }
            }
            
            if (isManual) {
              manualModsAnalysis.found.push(modFile);
              
              // Check if this manual mod has an update in required mods
              const hasUpdate = requiredMods.some(reqMod => {
                const reqFileName = typeof reqMod === 'string' ? reqMod : reqMod.fileName;
                const reqName = reqFileName.replace(/[-_\s]+/g, '').toLowerCase().replace('.jar', '');
                const currentName = modFile.replace(/[-_\s]+/g, '').toLowerCase().replace('.jar', '');
                return reqName.includes(currentName) || currentName.includes(reqName);
              });
              
              if (hasUpdate) {
                manualModsAnalysis.willUpdate.push(modFile);
              } else {
                // Check if compatible with server version
                const serverVersion = serverInfo?.minecraftVersion;
                const isCompatible = serverVersion ? checkModCompatibility(modFile, serverVersion) : true;
                
                if (isCompatible) {
                  manualModsAnalysis.willKeep.push(modFile);
                } else {
                  manualModsAnalysis.willDisable.push(modFile);
                }
              }
            }
          }
        }
          const downloaded = [];
        const failures = [];
        const skipped = [];

        // Ensure manifest directory exists
        if (!fs.existsSync(manifestDir)) {
          fs.mkdirSync(manifestDir, { recursive: true });
        }
        
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
                        
                        file2.on('finish', async () => {
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
                          try {
                            const manifestPath = path.join(manifestDir, `${mod.fileName}.json`);
                            const manifestData = {
                              fileName: mod.fileName,
                              source: 'server',
                              projectId: mod.projectId || null,
                              versionId: mod.versionId || null,
                              versionNumber: mod.versionNumber || null,
                              name: mod.name || null
                            };
                            try {
                              const meta = await readModMetadataFromJar(modPath);
                              if (meta) {
                                if (!manifestData.projectId) manifestData.projectId = meta.projectId;
                                if (!manifestData.versionNumber) manifestData.versionNumber = meta.versionNumber;
                                if (!manifestData.name) manifestData.name = meta.name;
                              }
                            } catch {}
                            fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
                          } catch {}
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
                    
                    file.on('finish', async () => {
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
                      try {
                        const manifestPath = path.join(manifestDir, `${mod.fileName}.json`);
                        const manifestData = {
                          fileName: mod.fileName,
                          source: 'server',
                          projectId: mod.projectId || null,
                          versionId: mod.versionId || null,
                          versionNumber: mod.versionNumber || null,
                          name: mod.name || null
                        };
                        try {
                          const meta = await readModMetadataFromJar(modPath);
                          if (meta) {
                            if (!manifestData.projectId) manifestData.projectId = meta.projectId;
                            if (!manifestData.versionNumber) manifestData.versionNumber = meta.versionNumber;
                            if (!manifestData.name) manifestData.name = meta.name;
                          }
                        } catch {}
                        fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
                      } catch {}
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
        
        const removed = [];        try {
          const modsDir = path.join(clientPath, 'mods');
          const manifestDir = path.join(clientPath, 'minecraft-core-manifests');

          const allowedList = Array.isArray(allClientMods) && allClientMods.length > 0
            ? allClientMods
            : requiredMods;
          const allowed = new Set(allowedList.map(m => (typeof m === 'string' ? m : m.fileName)));
          
          if (fs.existsSync(manifestDir)) {
            const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
            for (const file of manifests) {
              try {
                const manifestPath = path.join(manifestDir, file);
                const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const fileName = data.fileName;
                
                // Only remove mods that have manifests (indicating they were managed by the system)
                // AND are not in the allowed list
                if (!allowed.has(fileName) && data.source === 'server') {
                  const jar = path.join(modsDir, fileName);
                  const disabled = jar + '.disabled';
                  if (fs.existsSync(jar)) fs.unlinkSync(jar);
                  if (fs.existsSync(disabled)) fs.unlinkSync(disabled);
                  fs.unlinkSync(manifestPath);
                  removed.push(fileName);
                }
              } catch {}
            }
          }
          
          // Also check for manual mods that need preservation
          if (fs.existsSync(modsDir)) {
            const existingMods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
            for (const modFile of existingMods) {
              // If mod has no manifest, it's likely manual - preserve it
              const manifestPath = path.join(manifestDir, `${modFile}.json`);
              if (!fs.existsSync(manifestPath) && !allowed.has(modFile)) {
                // Create a simple marker file to track this as a preserved manual mod
                try {
                  if (!fs.existsSync(manifestDir)) {
                    fs.mkdirSync(manifestDir, { recursive: true });
                  }
                  fs.writeFileSync(manifestPath, JSON.stringify({ 
                    fileName: modFile, 
                    source: 'manual', 
                    preserved: true,
                    timestamp: new Date().toISOString()
                  }, null, 2));
                } catch (manifestError) {
                }
              }
            }
          }
        } catch (cleanupErr) {
        }        const result = {
          success: failures.length === 0,
          downloaded: downloaded.length,
          skipped: skipped.length,
          removed: removed.length,
          failures: failures,
          manualModsAnalysis: manualModsAnalysis,
          message: failures.length === 0
            ? `Successfully processed ${totalProcessed} mods (${downloaded.length} downloaded, ${skipped.length} already present, ${removed.length} removed)`
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
          } else {
          }
        } catch (err) {
        }
        
        // Try proper launcher first to fix LogUtils issues
        if (useProperLauncher) {
          
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
            return properResult;
          } else {
          }
        }
        
        // Fallback to original launcher
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
    'minecraft-check-mods': async (_e, { clientPath, requiredMods, allClientMods = [], serverManagedFiles = [] }) => {
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
        const presentMods = fs
          .readdirSync(modsDir)
          .filter(file => file.toLowerCase().endsWith('.jar'));
        // Also check for .disabled files (disabled mods)
        const disabledMods = fs
          .readdirSync(modsDir)
          .filter(file => file.toLowerCase().endsWith('.jar.disabled'))
          .map(file => file.replace('.disabled', '')); // Remove .disabled extension
        
        const missingMods = [];
        const outdatedMods = [];
        const missingOptionalMods = [];
        const outdatedOptionalMods = [];
        
        // Check required mods
        for (const requiredMod of requiredMods) {
          const modPath = path.join(modsDir, requiredMod.fileName);
          const isPresent =
            presentMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase()) ||
            disabledMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase());
          
          if (!isPresent) {
            missingMods.push(requiredMod.fileName);
          } else if (requiredMod.checksum) {
            // Check if mod is up to date using checksum
            const actualModPath = presentMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase())
              ? modPath
              : modPath + '.disabled';
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
            const isPresent =
              presentMods.some(f => f.toLowerCase() === optionalMod.fileName.toLowerCase()) ||
              disabledMods.some(f => f.toLowerCase() === optionalMod.fileName.toLowerCase());
            
            if (!isPresent) {
              missingOptionalMods.push(optionalMod.fileName);
            } else if (optionalMod.checksum) {
              // Check if mod is up to date using checksum
              const actualModPath = presentMods.some(f => f.toLowerCase() === optionalMod.fileName.toLowerCase())
                ? modPath
                : modPath + '.disabled';
              const existingChecksum = utils.calculateFileChecksum(actualModPath);
              if (existingChecksum !== optionalMod.checksum) {
                outdatedOptionalMods.push(optionalMod.fileName);
              }
            }
          }
        }        // Detect extra mods that were previously managed by the server
        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
        const extraMods = [];
        
        // Use the passed serverManagedFiles parameter instead of accessing the store
        const serverManagedFilesSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));

        try {
          if (fs.existsSync(manifestDir)) {
            const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
            const allowed = new Set([
              ...requiredMods.map(m => m.fileName),
              ...allClientMods.map(m => m.fileName)
            ]);
            
            for (const file of manifests) {
              try {
                const data = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));                if (data.fileName && !allowed.has(data.fileName)) {
                  // Only flag as "extra" if this mod was previously managed by the server
                  // Client-installed mods should not be flagged for removal
                  if (serverManagedFilesSet.has(data.fileName.toLowerCase())) {
                    extraMods.push(data.fileName);
                  }
                }
              } catch {}
            }
          }
        } catch {}        // Analyze client-downloaded mods that will be affected by server requirements
        const clientModChanges = {
          updates: [],
          removals: [],
          newDownloads: [] // Will be populated after analysis to avoid duplicates
        };try {
          const modAnalysisUtils = require('./mod-utils/mod-analysis-utils.cjs');
          
          // Check all present mods (enabled and disabled) for client-downloaded mods
          const allPresentMods = [...presentMods, ...disabledMods];
            // Build comprehensive list of server-managed mod names (including ones that will be downloaded)
          const allServerManagedFiles = new Set([
            ...(serverManagedFiles || []).map(f => f.toLowerCase()),
            ...requiredMods.map(rm => rm.fileName.toLowerCase()),
            ...(allClientMods || []).filter(m => m.required).map(m => m.fileName.toLowerCase())
          ]);
          
          // Build comprehensive list of all allowed mods (required + optional)
          const allAllowedMods = new Set([
            ...requiredMods.map(rm => rm.fileName.toLowerCase()),
            ...(allClientMods || []).map(m => m.fileName.toLowerCase())
          ]);
          
            const modFileNameLower = modFileName.toLowerCase();
            
            // Skip server-managed mods (mods that are/will be managed by the server)
            if (allServerManagedFiles.has(modFileNameLower)) {
              continue;
            }
            
            const modPath = presentMods.includes(modFileName)
              ? path.join(modsDir, modFileName)
              : path.join(modsDir, modFileName + '.disabled');
            
            try {
              // Extract metadata from the client mod
              const clientModMetadata = await modAnalysisUtils.extractDependenciesFromJar(modPath);
              if (!clientModMetadata) continue;
                // Check if this client mod has an exact match with server requirements
              const exactServerMatch = requiredMods.find(rm => 
                rm.fileName.toLowerCase() === modFileNameLower
              );
                // Also check for same-mod-different-version matches (e.g., Sodium 1.21.1 vs 1.21.3)
              const similarServerMatch = !exactServerMatch ? requiredMods.find(rm => {
                const serverFileName = rm.fileName.toLowerCase();
                const clientFileName = modFileNameLower;
                
                const clientBase = getBaseModName(clientFileName);
                const serverBase = getBaseModName(serverFileName);
                if (clientBase && serverBase && clientBase === serverBase) return true;
                if (clientModMetadata.name && serverBase === getBaseModName(clientModMetadata.name.toLowerCase().replace(/\s+/g, '_'))) return true;
                
                return false;
              }) : null;
              
              // Check for version compatibility with server requirements (for mods like Iris)
              const compatibleServerMatch = !exactServerMatch && !similarServerMatch ? (() => {
                // Check if this is a mod that could be compatible across minor versions
                const clientModName = (clientModMetadata.name || modFileName).toLowerCase();
                const serverVersion = '1.21.2'; // Target server version
                
                // Extract client mod version compatibility
                if (clientModName.includes('iris') || clientModName.includes('shader')) {
                  // Iris is often compatible across minor versions within the same major version
                  const clientMcVersion = modFileName.match(/1\.21\.(\d+)/);
                  if (clientMcVersion) {
                    const clientMinor = parseInt(clientMcVersion[1]);
                    // If client mod is for 1.21.4 and server is 1.21.2, it might be compatible
                    if (clientMinor >= 2) return { isCompatible: true };
                  }
                }
                
                if (clientModName.includes('entity') && clientModName.includes('culling')) {
                  // Entity Culling is often compatible across versions
                  return { isCompatible: true };
                }
                
                return null;
              })() : null;
                if (exactServerMatch || similarServerMatch) {
                // This client mod has a server equivalent - it's an update
                const matchedServerMod = exactServerMatch || similarServerMatch;
                const serverVersion = extractVersionFromFilename(matchedServerMod.fileName) || 'Server Version';
                
                clientModChanges.updates.push({
                  fileName: modFileName,
                  name: clientModMetadata.name || modFileName,
                  currentVersion: clientModMetadata.version || 'Unknown',
                  serverVersion: serverVersion,
                  action: 'update'
                });              } else if (compatibleServerMatch?.isCompatible) {
                // This mod might be compatible and should be kept, not disabled
                // Don't add to updates or removals - just keep it
              } else {
                // Check if this mod is in the allowed list (could be optional mod)
                const isExplicitlyAllowed = allAllowedMods.has(modFileNameLower);
                
                if (!isExplicitlyAllowed) {
                  // This client mod is not allowed by the server - it will be disabled
                  clientModChanges.removals.push({
                    fileName: modFileName,
                    name: clientModMetadata.name || modFileName,
                    currentVersion: clientModMetadata.version || 'Unknown',
                    action: 'disable'
                  });
                }
                // If explicitly allowed, keep as-is (no action needed)
                // If it's explicitly allowed, we don't need to do anything - it stays as-is
              }
            } catch (metadataError) {
            }
          }        } catch (analysisError) {
        }        // Populate newDownloads with mods that are truly new (not updates of existing client mods)
        // Get the server mod files that have corresponding client mod updates
        const serverModsWithClientUpdates = new Set();
        for (const update of clientModChanges.updates) {
          // Find the corresponding server mod for this client mod update
          const serverMod = allClientMods.find(serverMod => {
            const serverModNameLower = serverMod.fileName.toLowerCase();
            const clientModNameLower = update.fileName.toLowerCase();
            
            // Check for exact match first
            if (serverMod.fileName === update.fileName) return true;
            
            // Check for similar name patterns (same mod, different version)
            const clientBase = getBaseModName(clientModNameLower);
            const serverBase = getBaseModName(serverModNameLower);
            if (clientBase && serverBase && clientBase === serverBase) return true;
            
            return false;
          });
            if (serverMod) {
            serverModsWithClientUpdates.add(serverMod.fileName);
          }
        }
          // Add only mods that are not updates of existing client mods
        for (const modFileName of missingMods.concat(outdatedMods)) {
          if (!serverModsWithClientUpdates.has(modFileName)) {
            clientModChanges.newDownloads.push(modFileName);
          }
        }// Synchronized means all required mods are present, up to date, and no extras remain
          const synchronized = missingMods.length === 0 && outdatedMods.length === 0 && extraMods.length === 0;
        
        // Debug: Show final removal results
        
        return {
          success: true,
          synchronized,
          missingMods: missingMods.concat(outdatedMods),
          missingOptionalMods: missingOptionalMods.concat(outdatedOptionalMods),
          extraMods,
          clientModChanges, // New field containing client mod analysis
          totalRequired: requiredMods.length,
          totalOptional: allClientMods.filter(m => !m.required).length,
          totalPresent: requiredMods.length - missingMods.length - outdatedMods.length,
          totalOptionalPresent: (allClientMods.filter(m => !m.required).length) - missingOptionalMods.length - outdatedOptionalMods.length,
          needsDownload: missingMods.length + outdatedMods.length,
          needsOptionalDownload: missingOptionalMods.length + outdatedOptionalMods.length,
          needsRemoval: extraMods.length,
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

    // Delete a client mod
    'delete-client-mod': async (_e, { clientPath, modFileName }) => {
      try {
        if (!clientPath || !modFileName) {
          return { success: false, error: 'Client path and mod file name are required' };
        }

        const modsDir = path.join(clientPath, 'mods');
        const modPath = path.join(modsDir, modFileName);
        const disabledModPath = path.join(modsDir, modFileName + '.disabled');

        let deleted = false;
        if (fs.existsSync(modPath)) {
          fs.unlinkSync(modPath);
          deleted = true;
        }
        if (fs.existsSync(disabledModPath)) {
          fs.unlinkSync(disabledModPath);
          deleted = true;
        }

        if (deleted) {
          return { success: true, action: 'deleted' };
        }
        return { success: false, error: 'Mod file not found' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Remove mods that are not managed by the server
    'minecraft-remove-unmanaged-mods': async (_e, { clientPath, requiredMods = [], allClientMods = [] }) => {
      try {
        if (!clientPath) {
          return { success: false, error: 'Client path is required' };
        }

        const modsDir = path.join(clientPath, 'mods');
        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');

        if (!fs.existsSync(modsDir)) {
          return { success: true, removed: [] };
        }

        const allowed = new Set([
          ...requiredMods.map(m => m.fileName),
          ...allClientMods.map(m => m.fileName)
        ]);

        const files = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'));
        const removed = [];

        for (const file of files) {
          const base = file.replace('.disabled', '');
          if (!allowed.has(base)) {
            const filePath = path.join(modsDir, file);
            try {
              fs.unlinkSync(filePath);
            } catch {}

            // remove corresponding manifest if exists
            try {
              const manifestPath = path.join(manifestDir, `${base}.json`);
              if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
            } catch {}

            removed.push(base);
          }
        }

        return { success: true, removed };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },




  };
}

module.exports = { createMinecraftLauncherHandlers }; 
