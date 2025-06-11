
const { getMinecraftLauncher } = require('../services/minecraft-launcher/index.cjs');
const utils = require('../services/minecraft-launcher/utils.cjs');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { readModMetadataFromJar } = require('./mod-utils/mod-file-manager.cjs');
const { ensureServersDat } = require('../utils/servers-dat.cjs');

function checkModCompatibility(modFileName, targetVersion) {
  const versionMatch = modFileName.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (!versionMatch) return true;
  const modVersion = versionMatch[1];
  const targetMajorMinor = targetVersion.split('.').slice(0, 2).join('.');
  const modMajorMinor = modVersion.split('.').slice(0, 2).join('.');
  return targetMajorMinor === modMajorMinor;
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
  }  return null;
}

/**
 * Analyzes client-side (manual) mods to find their dependencies
 * @param {string} clientPath - Path to the client mods directory
 * @param {Array} serverManagedFiles - List of server-managed mod files
 * @returns {Promise<Set<string>>} Set of dependency mod names (lowercase)
 */
async function getClientSideDependencies(clientPath, serverManagedFiles = []) {
  const { extractDependenciesFromJar } = require('./mod-utils/mod-analysis-utils.cjs');
  
  const dependencies = new Set();
  
  try {
    if (!fs.existsSync(clientPath)) {
      return dependencies;
    }
    
    // Get list of server-managed files for comparison
    const serverManagedSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));
    
    // Get all jar files in client directory
    const modFiles = fs.readdirSync(clientPath).filter(file => 
      file.toLowerCase().endsWith('.jar')
    );
      // Find client-side (manual) mods - those not managed by server
    // Also include mods that were converted from server-managed to manual
    const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
    const convertedMods = new Set();
    
    if (fs.existsSync(manifestDir)) {
      const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
      for (const file of manifests) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));
          if (data.source === 'manual' || data.convertedFromServer) {
            convertedMods.add(data.fileName.toLowerCase());
          }        } catch {
          // Ignore manifest parsing errors
        }
      }
    }
    
    const clientSideMods = modFiles.filter(file => 
      !serverManagedSet.has(file.toLowerCase()) || convertedMods.has(file.toLowerCase())
    );
    
    // Analyze dependencies for each client-side mod
    for (const modFile of clientSideMods) {
      const modPath = path.join(clientPath, modFile);
      
      try {
        const metadata = await extractDependenciesFromJar(modPath);
        
        if (metadata && metadata.dependencies) {
          // Handle both array and object format dependencies
          let deps = metadata.dependencies;
          
          if (Array.isArray(deps)) {
            // Fabric format - array of dependency objects
            for (const dep of deps) {
              if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
              } else if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
              }
            }
          } else if (typeof deps === 'object') {            // Forge format - object with dependency entries
            for (const depName of Object.keys(deps)) {
              dependencies.add(depName.toLowerCase());
            }
          }
        }        // Also check for common dependency formats in mod metadata
        if (metadata) {
          // Check for 'depends' field
          if (metadata.depends && Array.isArray(metadata.depends)) {
            for (const dep of metadata.depends) {
              if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
              } else if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
              }
            }
          }
          
          // Check for 'requires' field
          if (metadata.requires && Array.isArray(metadata.requires)) {
            for (const dep of metadata.requires) {
              if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
              } else if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
              }
            }
          }
        }
        
      } catch (error) {
        console.warn(`Failed to analyze dependencies for ${modFile}:`, error.message);
        // Continue processing other mods even if one fails
      }
    }
    
    // Filter out common non-mod dependencies
    const commonNonModDeps = new Set([
      'minecraft', 'forge', 'fabric', 'fabric-loader', 'fabricloader',
      'java', 'mcp', 'mappings', 'quilt', 'quilt-loader'
    ]);
    
    for (const dep of commonNonModDeps) {
      dependencies.delete(dep);
    }
    
  } catch (error) {
    console.error('Error analyzing client-side dependencies:', error);
  }
  
  return dependencies;
}

function createMinecraftLauncherHandlers(win) {
  const launcher = getMinecraftLauncher();
  
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
    'minecraft-auth': async (_e, { clientPath }) => {
      try {
        const result = await launcher.authenticateWithMicrosoft();
        if (result.success && clientPath) {
          await launcher.saveAuthData(clientPath).catch(() => {});
        }
        
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-load-auth': async (_e, { clientPath }) => {
      try {
        const result = await launcher.loadAuthData(clientPath);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-save-auth': async (_e, { clientPath }) => {
      try {
        const result = await launcher.saveAuthData(clientPath);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    'minecraft-check-refresh-auth': async (_e, { clientPath }) => {
      try {
        const result = await launcher.checkAndRefreshAuth();
        if (result.success && result.refreshed && clientPath) {
          await launcher.saveAuthData(clientPath).catch(() => {});
        }

        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
      'minecraft-download-mods': async (_e, { clientPath, requiredMods, allClientMods = [], serverInfo }) => {
      try {
        if (!clientPath || !requiredMods || !Array.isArray(requiredMods)) {
          return { success: false, error: 'Invalid parameters' };
        }
        
        if (requiredMods.length === 0) {
          return { success: true, downloaded: 0, failures: [], message: 'No mods required' };
        }

        const modsDir = path.join(clientPath, 'mods');
        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
        const manualModsAnalysis = { found: [], willUpdate: [], willDisable: [], willKeep: [] };
        
        if (fs.existsSync(modsDir)) {
          const existingMods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
          for (const modFile of existingMods) {
            const manifestPath = path.join(manifestDir, `${modFile}.json`);
            let isManual = true;
            
            if (fs.existsSync(manifestPath)) {              try {
                const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                isManual = manifestData.source === 'manual';
              } catch {
                isManual = true;
              }
            }
            
            if (isManual) {
              manualModsAnalysis.found.push(modFile);
              
              const hasUpdate = requiredMods.some(reqMod => {
                const reqFileName = typeof reqMod === 'string' ? reqMod : reqMod.fileName;
                const reqName = reqFileName.replace(/[-_\s]+/g, '').toLowerCase().replace('.jar', '');
                const currentName = modFile.replace(/[-_\s]+/g, '').toLowerCase().replace('.jar', '');
                return reqName.includes(currentName) || currentName.includes(reqName);
              });
              
              if (hasUpdate) {
                manualModsAnalysis.willUpdate.push(modFile);
              } else {
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

        if (!fs.existsSync(manifestDir)) {
          fs.mkdirSync(manifestDir, { recursive: true });
        }
        for (let i = 0; i < requiredMods.length; i++) {
          const mod = requiredMods[i];
          
          try {
            const modPath = path.join(clientPath, 'mods', mod.fileName);
            
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
            
            if (mod.downloadUrl) {
              await new Promise((resolve, reject) => {
                const protocol = mod.downloadUrl.startsWith('https:') ? https : http;
                const file = fs.createWriteStream(modPath);
                
                const request = protocol.get(mod.downloadUrl, (response) => {
                  if (response.statusCode === 302 || response.statusCode === 301) {
                    file.close();
                    fs.unlinkSync(modPath);
                    
                    const redirectUrl = response.headers.location;
                    const redirectProtocol = redirectUrl.startsWith('https:') ? https : http;
                    
                    redirectProtocol.get(redirectUrl, (redirectResponse) => {
                      if (redirectResponse.statusCode === 200) {
                        const file2 = fs.createWriteStream(modPath);
                        redirectResponse.pipe(file2);
                        
                        file2.on('finish', async () => {
                          file2.close();
                          
                          if (mod.checksum) {
                            const downloadedChecksum = utils.calculateFileChecksum(modPath);
                            if (downloadedChecksum !== mod.checksum) {
                              fs.unlinkSync(modPath);
                              reject(new Error(`Checksum mismatch for ${mod.fileName}`));
                              return;
                            }
                          }
                          
                          downloaded.push(mod.fileName);
                          const manifestPath = path.join(manifestDir, `${mod.fileName}.json`);
                          const manifestData = {
                            fileName: mod.fileName,
                            source: 'server',
                            projectId: mod.projectId || null,
                            versionId: mod.versionId || null,
                            versionNumber: mod.versionNumber || null,
                            name: mod.name || null
                          };
                          const meta = await readModMetadataFromJar(modPath).catch(() => null);
                          if (meta) {
                            if (!manifestData.projectId) manifestData.projectId = meta.projectId;
                            if (!manifestData.versionNumber) manifestData.versionNumber = meta.versionNumber;
                            if (!manifestData.name) manifestData.name = meta.name;
                          }
                          fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
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
                      
                      if (mod.checksum) {
                        const downloadedChecksum = utils.calculateFileChecksum(modPath);
                        if (downloadedChecksum !== mod.checksum) {
                          fs.unlinkSync(modPath);
                          reject(new Error(`Checksum mismatch for ${mod.fileName}`));
                          return;
                        }
                      }
                      
                      downloaded.push(mod.fileName);
                          const manifestPath = path.join(manifestDir, `${mod.fileName}.json`);
                          const manifestData = {
                            fileName: mod.fileName,
                            source: 'server',
                            projectId: mod.projectId || null,
                            versionId: mod.versionId || null,
                            versionNumber: mod.versionNumber || null,
                            name: mod.name || null
                          };
                          const meta = await readModMetadataFromJar(modPath).catch(() => null);
                          if (meta) {
                            if (!manifestData.projectId) manifestData.projectId = meta.projectId;
                            if (!manifestData.versionNumber) manifestData.versionNumber = meta.versionNumber;
                            if (!manifestData.name) manifestData.name = meta.name;
                          }
                          fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
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
        
        const removed = [];

          const allowedList = Array.isArray(allClientMods) && allClientMods.length > 0
            ? allClientMods
            : requiredMods;
          const allowed = new Set(allowedList.map(m => (typeof m === 'string' ? m : m.fileName)));
            if (fs.existsSync(manifestDir)) {
            const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
            for (const file of manifests) {
                const manifestPath = path.join(manifestDir, file);
                const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const fileName = data.fileName;
                
                // Check if this mod is actually present in the client directory
                const modPath = path.join(modsDir, fileName);
                const modExists = fs.existsSync(modPath) || fs.existsSync(modPath + '.disabled');
                
                if (!allowed.has(fileName) && data.source === 'server') {
                  // If the mod exists in client directory but is no longer server-managed,
                  // convert it to a manual mod instead of removing it
                  if (modExists) {
                    // Update manifest to mark as manual
                    data.source = 'manual';
                    data.convertedFromServer = true;
                    data.convertedAt = new Date().toISOString();
                    fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2));
                    console.log(`Converted ${fileName} from server-managed to manual mod`);
                  } else {
                    // Only remove if the mod doesn't exist
                    const jar = path.join(modsDir, fileName);
                    const disabled = jar + '.disabled';
                    if (fs.existsSync(jar)) fs.unlinkSync(jar);
                    if (fs.existsSync(disabled)) fs.unlinkSync(disabled);
                    fs.unlinkSync(manifestPath);
                    removed.push(fileName);
                  }
                }
            }
          }
          
          if (fs.existsSync(modsDir)) {
            const existingMods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
            for (const modFile of existingMods) {
              const manifestPath = path.join(manifestDir, `${modFile}.json`);
              if (!fs.existsSync(manifestPath) && !allowed.has(modFile)) {
                  if (!fs.existsSync(manifestDir)) {
                    fs.mkdirSync(manifestDir, { recursive: true });
                  }
                  fs.writeFileSync(manifestPath, JSON.stringify({ 
                    fileName: modFile, 
                    source: 'manual', 
                    preserved: true,
                    timestamp: new Date().toISOString()
                  }, null, 2));
              }
            }
          }
        
        const result = {
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
          maxMemory = null,
          useProperLauncher = true
        } = options;

        await ensureServersDat(
          clientPath,
          serverIp,
          managementPort,
          clientName || 'Minecraft Server',
          serverPort
        );
        
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
          }
        }
        
        const result = await launcher.launchMinecraft({
          clientPath,
          minecraftVersion,
          serverIp,
          serverPort: parseInt(serverPort),
          requiredMods,
          serverInfo,
          maxMemory
        });
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-stop': async () => {
      try {
        const result = await launcher.stopMinecraft();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-launcher-status': async () => {
      try {
        const status = launcher.getStatus();
        return { success: true, status };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-get-status': async () => {      try {
        const status = launcher.getStatus();
        return status;
      } catch {
        return { 
          isAuthenticated: false,
          isLaunching: false,
          isRunning: false,
          username: null,
          clientPath: null
        };
      }
    },
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
        
        const presentMods = fs
          .readdirSync(modsDir)
          .filter(file => file.toLowerCase().endsWith('.jar'));
        const disabledMods = fs
          .readdirSync(modsDir)
          .filter(file => file.toLowerCase().endsWith('.jar.disabled'))
          .map(file => file.replace('.disabled', ''));
        
        const missingMods = [];
        const outdatedMods = [];
        const missingOptionalMods = [];
        const outdatedOptionalMods = [];
        
        for (const requiredMod of requiredMods) {
          const modPath = path.join(modsDir, requiredMod.fileName);
          const isPresent =
            presentMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase()) ||
            disabledMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase());
          
          if (!isPresent) {
            missingMods.push(requiredMod.fileName);
          } else if (requiredMod.checksum) {
            const actualModPath = presentMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase())
              ? modPath
              : modPath + '.disabled';
            const existingChecksum = utils.calculateFileChecksum(actualModPath);
            if (existingChecksum !== requiredMod.checksum) {
              outdatedMods.push(requiredMod.fileName);
            }
          }
        }
        
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
              const actualModPath = presentMods.some(f => f.toLowerCase() === optionalMod.fileName.toLowerCase())
                ? modPath
                : modPath + '.disabled';
              const existingChecksum = utils.calculateFileChecksum(actualModPath);
              if (existingChecksum !== optionalMod.checksum) {
                outdatedOptionalMods.push(optionalMod.fileName);
              }
            }
          }
        }
        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');        const extraMods = [];
        
        const serverManagedFilesSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));

          if (fs.existsSync(manifestDir)) {
            const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
            
            // Create a set of currently allowed server mods (both required and optional)
            const currentServerMods = new Set([
              ...requiredMods.map(m => m.fileName.toLowerCase()),
              ...allClientMods.map(m => m.fileName.toLowerCase())
            ]);            // Get client-side (manual) mods and their dependencies
            const clientSideDependencies = await getClientSideDependencies(clientPath, serverManagedFiles);
            
            // Get list of actual mods present in client directory
            const actualClientMods = new Set();
            if (fs.existsSync(clientPath)) {
              const clientModFiles = fs.readdirSync(clientPath).filter(f => f.toLowerCase().endsWith('.jar'));
              clientModFiles.forEach(f => actualClientMods.add(f.toLowerCase()));
            }
              for (const file of manifests) {
                const data = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));
                if (data.fileName) {
                  const fileNameLower = data.fileName.toLowerCase();
                  const baseModName = getBaseModName(data.fileName).toLowerCase();
                  
                  // Check if mod actually exists in client directory
                  const modExists = actualClientMods.has(fileNameLower);
                  
                  // If the mod exists but was previously server-managed and is no longer in server list,
                  // convert it to manual status right here during the check phase
                  if (modExists && 
                      serverManagedFilesSet.has(fileNameLower) && 
                      !currentServerMods.has(fileNameLower) &&
                      data.source === 'server') {
                    
                    // Convert to manual mod immediately
                    const manifestPath = path.join(manifestDir, file);
                    data.source = 'manual';
                    data.convertedFromServer = true;
                    data.convertedAt = new Date().toISOString();
                    fs.writeFileSync(manifestPath, JSON.stringify(data, null, 2));
                    console.log(`Converted ${data.fileName} from server-managed to manual during check phase`);
                    
                    // Don't add to removal list since it's now manual
                    continue;
                  }
                  
                  // Only consider a mod for removal if:
                  // 1. It was previously server-managed (tracked in serverManagedFiles)
                  // 2. AND it's no longer in the current server mod list
                  // 3. AND it's not required by any client-side mods (by mod ID)
                  // 4. AND it's not required by any client-side mods (by base file name)
                  // 5. AND it doesn't exist in the client directory (truly absent)
                  if (serverManagedFilesSet.has(fileNameLower) && 
                      !currentServerMods.has(fileNameLower) &&
                      !clientSideDependencies.has(fileNameLower) &&
                      !clientSideDependencies.has(baseModName) &&
                      !clientSideDependencies.has(data.name?.toLowerCase() || '') &&
                      !modExists) {
                    extraMods.push(data.fileName);
                  }
                }
            }
          }
        const clientModChanges = {
          updates: [],
          removals: [],
          newDownloads: []
        };
          const modAnalysisUtils = require('./mod-utils/mod-analysis-utils.cjs');
            const allPresentMods = [...presentMods, ...disabledMods];
          const allServerManagedFiles = new Set([
            ...(serverManagedFiles || []).map(f => f.toLowerCase()),
            ...requiredMods.map(rm => rm.fileName.toLowerCase()),
            ...(allClientMods || []).filter(m => m.required).map(m => m.fileName.toLowerCase())
          ]);for (const modFileName of allPresentMods) {
            const modFileNameLower = modFileName.toLowerCase();
            
            // Skip mods that are known to be server-managed
            if (allServerManagedFiles.has(modFileNameLower)) {
              continue;
            }
            
            const modPath = presentMods.includes(modFileName)
              ? path.join(modsDir, modFileName)
              : path.join(modsDir, modFileName + '.disabled');
            
            const clientModMetadata = await modAnalysisUtils.extractDependenciesFromJar(modPath);
            if (!clientModMetadata) continue;
            
            // Check if this mod matches any server mod (exact or similar)
            const exactServerMatch = requiredMods.find(rm => 
              rm.fileName.toLowerCase() === modFileNameLower
            );
            const similarServerMatch = !exactServerMatch ? requiredMods.find(rm => {
              const serverFileName = rm.fileName.toLowerCase();
              const clientFileName = modFileNameLower;
              
              const clientBase = getBaseModName(clientFileName);
              const serverBase = getBaseModName(serverFileName);
              if (clientBase && serverBase && clientBase === serverBase) return true;
              if (clientModMetadata.name && serverBase === getBaseModName(clientModMetadata.name.toLowerCase().replace(/\s+/g, '_'))) return true;
              
              return false;
            }) : null;

            // If this mod matches a server mod, it needs updating
            if (exactServerMatch || similarServerMatch) {
              const matchedServerMod = exactServerMatch || similarServerMatch;
              const serverVersion = extractVersionFromFilename(matchedServerMod.fileName) || 'Server Version';
              
              clientModChanges.updates.push({
                fileName: modFileName,
                name: clientModMetadata.name || modFileName,
                currentVersion: clientModMetadata.version || 'Unknown',
                serverVersion: serverVersion,
                action: 'update'
              });
            } 
            // IMPORTANT: If this mod doesn't match any server mod, it's a manual/client-side mod
            // and should be left alone (not added to removals). Only server-managed mods that
            // are no longer on the server should be considered for removal.
            // Manual mods are completely independent of server synchronization.
          }

        const serverModsWithClientUpdates = new Set();
        for (const update of clientModChanges.updates) {
          const serverMod = allClientMods.find(serverMod => {
            const serverModNameLower = serverMod.fileName.toLowerCase();
            const clientModNameLower = update.fileName.toLowerCase();
            
            if (serverMod.fileName === update.fileName) return true;
            
            const clientBase = getBaseModName(clientModNameLower);
            const serverBase = getBaseModName(serverModNameLower);
            if (clientBase && serverBase && clientBase === serverBase) return true;
            
            return false;
          });
            if (serverMod) {
            serverModsWithClientUpdates.add(serverMod.fileName);
          }
        }        for (const modFileName of missingMods.concat(outdatedMods)) {
          if (!serverModsWithClientUpdates.has(modFileName)) {
            clientModChanges.newDownloads.push(modFileName);
          }
        }

        // Populate removals with server-managed mods that are no longer on the server
        for (const extraMod of extraMods) {
          clientModChanges.removals.push({
            name: extraMod,
            fileName: extraMod,
            reason: 'no longer required by server',
            action: 'remove'
          });
        }const synchronized = missingMods.length === 0 && outdatedMods.length === 0 && extraMods.length === 0;
        
        // Calculate actual needs more conservatively to avoid "0 out of X" issues
        const actualNeedsDownload = missingMods.length + outdatedMods.length;
        const actualNeedsOptionalDownload = missingOptionalMods.length + outdatedOptionalMods.length;
        
        return {
          success: true,
          synchronized,
          missingMods: missingMods.concat(outdatedMods),
          missingOptionalMods: missingOptionalMods.concat(outdatedOptionalMods),
          extraMods,
          clientModChanges,
          totalRequired: requiredMods.length,
          totalOptional: allClientMods.filter(m => !m.required).length,
          totalPresent: requiredMods.length - missingMods.length - outdatedMods.length,
          totalOptionalPresent: (allClientMods.filter(m => !m.required).length) - missingOptionalMods.length - outdatedOptionalMods.length,
          needsDownload: synchronized ? 0 : actualNeedsDownload, // Force 0 if synchronized
          needsOptionalDownload: synchronized ? 0 : actualNeedsOptionalDownload, // Force 0 if synchronized  
          needsRemoval: extraMods.length,
          presentEnabledMods: presentMods,
          presentDisabledMods: disabledMods
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-check-client': async (_e, { clientPath, minecraftVersion, requiredMods = [], serverInfo = null }) => {
      try {
        const result = await launcher.checkMinecraftClient(clientPath, minecraftVersion, { requiredMods, serverInfo });
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    'minecraft-check-client-sync': async (_e, { clientPath, minecraftVersion, requiredMods = [], serverInfo = null }) => {
      try {
        const result = await launcher.checkMinecraftClient(clientPath, minecraftVersion, { requiredMods, serverInfo });
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-download-client': async (_e, { clientPath, minecraftVersion, requiredMods = [], serverInfo = null }) => {
      try {
        const downloadOptions = { 
          requiredMods, 
          serverInfo 
        };
        
        if (serverInfo && serverInfo.serverIp) {
          downloadOptions.serverIp = serverInfo.serverIp;
        }
        
        const result = await launcher.downloadMinecraftClientSimple(clientPath, minecraftVersion, downloadOptions);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-clear-client': async (_e, { clientPath, minecraftVersion }) => {
      try {
        const result = await launcher.clearMinecraftClient(clientPath, minecraftVersion);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    'minecraft-clear-assets': async (_e, { clientPath }) => {
      try {
        const result = await launcher.clearAssets(clientPath);
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    'minecraft-reset-launcher': async () => {
      try {
        launcher.resetLauncherState();
        return { success: true, message: 'Launcher state reset' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    'toggle-client-mod': async (_e, { clientPath, modFileName, enabled }) => {
      try {
        if (!clientPath || !modFileName) {
          return { success: false, error: 'Client path and mod file name are required' };
        }
        
        const modsDir = path.join(clientPath, 'mods');
        const modPath = path.join(modsDir, modFileName);
        const disabledModPath = path.join(modsDir, modFileName + '.disabled');
        
        if (enabled) {
          if (fs.existsSync(disabledModPath)) {
            fs.renameSync(disabledModPath, modPath);
            return { success: true, action: 'enabled' };
          } else if (fs.existsSync(modPath)) {
            return { success: true, action: 'already_enabled' };
          } else {
            return { success: false, error: 'Mod file not found' };
          }
        } else {
          if (fs.existsSync(modPath)) {
            fs.renameSync(modPath, disabledModPath);
            return { success: true, action: 'disabled' };
          } else if (fs.existsSync(disabledModPath)) {
            return { success: true, action: 'already_disabled' };
          } else {
            return { success: false, error: 'Mod file not found' };
          }
        }
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

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
            fs.unlinkSync(filePath);

            const manifestPath = path.join(manifestDir, `${base}.json`);
            if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

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
