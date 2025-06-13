const { getMinecraftLauncher } = require('../services/minecraft-launcher/index.cjs');
const utils = require('../services/minecraft-launcher/utils.cjs');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');
const { readModMetadataFromJar } = require('./mod-utils/mod-file-manager.cjs');
const { ensureServersDat } = require('../utils/servers-dat.cjs');

// In-memory lock to prevent race conditions during state operations
let stateLockPromise = Promise.resolve();

/**
 * Save the expected mod state to a persistent JSON file
 * Uses async fs operations and includes error handling with UI notifications
 * @param {string} clientPath - Path to the client directory
 * @param {Set} expectedMods - Set of expected mod filenames
 * @param {object} win - Electron window object for error notifications
 * @param {Set} acknowledgedDependencies - Set of acknowledged dependency mod filenames
 * @returns {Promise<{success: boolean, error?: string}>} Result of the save operation
 */
async function saveExpectedModState(clientPath, expectedMods, win = null, acknowledgedDependencies = new Set()) {
  // Serialize access to prevent race conditions
  await stateLockPromise;
  
  let resolver = () => {};
  stateLockPromise = new Promise(resolve => { resolver = resolve; });
  
  try {
    const stateDir = path.join(clientPath, 'minecraft-core-state');
    const stateFile = path.join(stateDir, 'expected-mods.json');
    
    try {
      // Use async fs operations to avoid blocking event loop
      try {
        await fsPromises.access(stateDir);
      } catch {
        await fsPromises.mkdir(stateDir, { recursive: true });
      }
      
      // Re-load current state to merge with any intervening changes
      let existingState = {};
      try {
        const existingData = await fsPromises.readFile(stateFile, 'utf8');
        existingState = JSON.parse(existingData);
      } catch {
        // File doesn't exist or is invalid, start fresh
      }
      
      const state = {
        ...existingState,
        expectedMods: Array.from(expectedMods),
        acknowledgedDependencies: Array.from(acknowledgedDependencies),
        lastUpdated: new Date().toISOString(),
        version: 1
      };
        await fsPromises.writeFile(stateFile, JSON.stringify(state, null, 2));
      
      resolver();
      return { success: true };
    } catch (error) {
      console.error('Failed to save expected mod state:', error);
      
      // Surface error to UI if window reference is available
      if (win && !win.isDestroyed()) {
        win.webContents.send('mod-state-persistence-error', {
          type: 'save',
          error: error.message,
          message: 'Failed to save mod state. Removal detection may not persist across restarts.'
        });
      }
      
      resolver();
      return { success: false, error: error.message };
    }
  } catch (error) {
    resolver();
    return { success: false, error: error.message };
  }
}

/**
 * Load the expected mod state from persistent JSON file
 * Includes schema migration for backward compatibility
 */
async function loadExpectedModState(clientPath, win = null) {
  const stateFile = path.join(clientPath, 'minecraft-core-state', 'expected-mods.json');
  
  try {
    // Use async fs operations
    try {
      await fsPromises.access(stateFile);
    } catch {
      console.log('No expected mod state file found, starting fresh');
      return { success: true, expectedMods: new Set(), acknowledgedDependencies: new Set() };
    }
    
    const data = await fsPromises.readFile(stateFile, 'utf8');
    const state = JSON.parse(data);
    
    // Handle schema migration
    let expectedMods;
    let acknowledgedDependencies = new Set();
    if (!state.version || state.version < 1) {
      // Migrate from v0 (or no version) to v1
      console.log('Migrating mod state from legacy format');
      expectedMods = new Set(Array.isArray(state) ? state : (state.expectedMods || []));
      
      // Save migrated format
      await saveExpectedModState(clientPath, expectedMods, win, acknowledgedDependencies);    } else if (state.version === 1) {
      expectedMods = new Set(state.expectedMods || []);
      acknowledgedDependencies = new Set(state.acknowledgedDependencies || []);
    } else {
      // Future version - reset to avoid compatibility issues
      console.warn(`Unknown mod state version ${state.version}, resetting`);
      expectedMods = new Set();
      acknowledgedDependencies = new Set();
    }
    
    console.log('=== LOADED PERSISTENT STATE ===');
    console.log('Expected mods:', Array.from(expectedMods));
    console.log('Acknowledged dependencies:', Array.from(acknowledgedDependencies));
    console.log('State file location:', stateFile);
    console.log('=== END LOADED STATE ===');
    
    console.log('Loaded expected mod state with', expectedMods.size, 'mods and', acknowledgedDependencies.size, 'acknowledged dependencies');
    return { success: true, expectedMods, acknowledgedDependencies };
  } catch (error) {
    console.error('Failed to load expected mod state:', error);
    
    // Surface error to UI if window reference is available
    if (win && !win.isDestroyed()) {
      win.webContents.send('mod-state-persistence-error', {
        type: 'load',
        error: error.message,
        message: 'Failed to load mod state. Some removal detection may be lost.'
      });
    }
    
    return { success: false, error: error.message, expectedMods: new Set(), acknowledgedDependencies: new Set() };  }
}

/**
 * Clear persistent mod state - useful for debugging or starting fresh
 */
async function clearExpectedModState(clientPath) {
  const stateFile = path.join(clientPath, 'minecraft-core-state', 'expected-mods.json');
  
  try {
    if (fs.existsSync(stateFile)) {
      await fsPromises.unlink(stateFile);
      console.log('Cleared persistent mod state file:', stateFile);
      return { success: true, message: 'Persistent mod state cleared' };
    } else {
      console.log('No persistent mod state file to clear');
      return { success: true, message: 'No state file found' };
    }
  } catch (error) {
    console.error('Failed to clear persistent mod state:', error);
    return { success: false, error: error.message };
  }
}

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
  }
  return null;
}

/**
 * Analyzes client-side (manual) mods to find their dependencies
 */
async function getClientSideDependencies(clientPath, serverManagedFiles = []) {
  const { extractDependenciesFromJar } = require('./mod-utils/mod-analysis-utils.cjs');
  
  const dependencies = new Set();
  
  try {
    const modsDir = path.join(clientPath, 'mods');
    if (!fs.existsSync(modsDir)) {
      console.log('getClientSideDependencies: mods directory not found');
      return dependencies;
    }
    
    const serverManagedSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));
    
    const modFiles = fs.readdirSync(modsDir).filter(file => 
      file.toLowerCase().endsWith('.jar')
    );
    
    const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
    const convertedMods = new Set();
    
    if (fs.existsSync(manifestDir)) {
      const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
      for (const file of manifests) {        try {
          const data = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));
          if (data.source === 'manual' || data.convertedFromServer) {
            convertedMods.add(data.fileName.toLowerCase());
          }
        } catch {
          // Ignore manifest parsing errors
        }
      }
    }
    
    const clientSideMods = modFiles.filter(file => 
      !serverManagedSet.has(file.toLowerCase()) || convertedMods.has(file.toLowerCase())
    );
    console.log('getClientSideDependencies: client-side mods:', clientSideMods);
    
    for (const modFile of clientSideMods) {
      const modPath = path.join(modsDir, modFile);
        try {
        const metadata = await extractDependenciesFromJar(modPath);
        
        if (metadata) {
          // Handle 'dependencies' field (array format)
          if (metadata.dependencies && Array.isArray(metadata.dependencies)) {
            for (const dep of metadata.dependencies) {
              if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
                console.log(`getClientSideDependencies: found dependency ${dep.modid.toLowerCase()} in ${modFile}`);
              } else if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
                console.log(`getClientSideDependencies: found dependency ${dep.toLowerCase()} in ${modFile}`);
              }
            }
          } else if (metadata.dependencies && typeof metadata.dependencies === 'object') {
            // Handle dependencies as object (key-value pairs)
            for (const depName of Object.keys(metadata.dependencies)) {
              dependencies.add(depName.toLowerCase());
              console.log(`getClientSideDependencies: found dependency ${depName.toLowerCase()} in ${modFile}`);
            }
          }
          
          // Handle 'depends' field (Fabric mod format)
          if (metadata.depends && typeof metadata.depends === 'object') {
            for (const depName of Object.keys(metadata.depends)) {
              if (!['minecraft', 'fabricloader', 'java'].includes(depName.toLowerCase())) {
                dependencies.add(depName.toLowerCase());
                console.log(`getClientSideDependencies: found 'depends' dependency ${depName.toLowerCase()} in ${modFile}`);
              }
            }
          } else if (metadata.depends && Array.isArray(metadata.depends)) {
            for (const dep of metadata.depends) {
              if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
                console.log(`getClientSideDependencies: found 'depends' dependency ${dep.toLowerCase()} in ${modFile}`);
              } else if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
                console.log(`getClientSideDependencies: found 'depends' dependency ${dep.modid.toLowerCase()} in ${modFile}`);
              }
            }
          }
          
          // Handle 'requires' field
          if (metadata.requires && Array.isArray(metadata.requires)) {
            for (const dep of metadata.requires) {
              if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
                console.log(`getClientSideDependencies: found 'requires' dependency ${dep.toLowerCase()} in ${modFile}`);
              } else if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
                console.log(`getClientSideDependencies: found 'requires' dependency ${dep.modid.toLowerCase()} in ${modFile}`);
              }
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to analyze dependencies for ${modFile}:`, error.message);
      }    }
      // Add common Fabric API variants that client mods might reference
    const fabricApiVariants = new Set();
    for (const dep of dependencies) {
      if (dep.includes('fabric') && (dep.includes('api') || dep === 'fabric-api' || dep === 'fabricapi')) {
        fabricApiVariants.add('fabric');
        fabricApiVariants.add('api');
        fabricApiVariants.add('fabric-api');
        fabricApiVariants.add('fabricapi');
        fabricApiVariants.add('fabric_api');
        console.log(`getClientSideDependencies: detected Fabric API dependency, adding variants`);
      }
    }
    
    // Add the variants to the dependencies set
    for (const variant of fabricApiVariants) {
      dependencies.add(variant);
    }
    
    // Special handling: If we have any known client-side Fabric mods, assume they need Fabric API
    const knownFabricClientMods = ['sodium', 'iris', 'lithium', 'phosphor', 'modmenu', 'optifabric'];
    let hasClientFabricMods = false;
    
    for (const modFile of clientSideMods) {
      const modNameLower = modFile.toLowerCase();
      for (const knownMod of knownFabricClientMods) {
        if (modNameLower.includes(knownMod)) {
          hasClientFabricMods = true;
          console.log(`getClientSideDependencies: detected known Fabric client mod: ${modFile}, assuming Fabric API dependency`);
          break;
        }
      }
    }
    
    if (hasClientFabricMods) {
      // Add all Fabric API variants if we detected known client-side Fabric mods
      dependencies.add('fabric-api');
      dependencies.add('fabricapi');
      dependencies.add('fabric_api');
      console.log(`getClientSideDependencies: added Fabric API variants due to detected client-side Fabric mods`);
    }
    
    const commonNonModDeps = new Set([
      'minecraft', 'forge', 'fabric', 'fabric-loader', 'fabricloader',
      'java', 'mcp', 'mappings', 'quilt', 'quilt-loader'
    ]);
    
    for (const dep of commonNonModDeps) {
      dependencies.delete(dep);
    }
    
    console.log('getClientSideDependencies: final dependencies set:', Array.from(dependencies));
    
  } catch (error) {
    console.error('Error analyzing client-side dependencies:', error);
  }
    return dependencies;
}

/**
 * Check if a mod filename matches any dependency by extracting various parts of the filename
 * @param {string} fileName - The mod filename to check
 * @param {Set} dependencies - Set of dependency names
 * @returns {boolean} True if the mod is likely needed as a dependency
 */
function checkModDependencyByFilename(fileName, dependencies) {
  const nameLower = fileName.toLowerCase();
  
  // Extract mod ID patterns (e.g., sodium-fabric-0.5.8+mc1.20.1.jar -> sodium)
  const patterns = [
    // Remove common suffixes and version patterns
    nameLower.replace(/[-_](fabric|forge|quilt).*$/, ''), // sodium-fabric-... -> sodium
    nameLower.replace(/[-_]\d+.*$/, ''), // mod-1.0.0 -> mod
    nameLower.replace(/[-_]v?\d+\..*$/, ''), // mod-v1.0 -> mod
    nameLower.replace(/[-_]mc\d+.*$/, ''), // mod-mc1.20 -> mod
    nameLower.replace(/\.jar$/, ''), // Remove .jar    // Try extracting just the first part before any delimiter
    nameLower.split(/[-_.]/)[0]
  ];
  
  // Check each pattern against dependencies
  for (const pattern of patterns) {
    if (pattern && pattern.length > 2 && dependencies.has(pattern)) {
      console.log(`Found dependency match: ${fileName} -> ${pattern}`);
      return true;
    }
  }
  
  return false;
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
              if (fs.existsSync(manifestPath)) {
              try {
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

          // NOTE: Automatic removal of server-managed mods has been disabled
          // Mods that are no longer on the server should be handled through the UI with user consent
          // The minecraft-check-mods handler now detects such mods and marks them for user review
          
          const allowedList = Array.isArray(allClientMods) && allClientMods.length > 0
            ? allClientMods
            : requiredMods;
          const allowed = new Set(allowedList.map(m => (typeof m === 'string' ? m : m.fileName)));
            if (fs.existsSync(manifestDir)) {
            const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
            for (const file of manifests) {                const manifestPath = path.join(manifestDir, file);
                const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const fileName = data.fileName;
                  if (!allowed.has(fileName) && data.source === 'server') {
                  console.log(`Detected server-managed mod ${fileName} that is no longer on server (will not auto-remove)`);
                  // Don't automatically remove - let the user decide through the UI
                  // removed.push(fileName);
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
            }          }
          
        // **FIX**: Update persistent state to include newly downloaded mods
        // This ensures re-added mods show up in serverManagedFiles and get remove buttons
        if (downloaded.length > 0) {
          try {
            console.log('Updating persistent state with newly downloaded mods:', downloaded);
            const stateResult = await loadExpectedModState(clientPath, win);
            if (stateResult.success) {
              const updatedExpectedMods = new Set([
                ...stateResult.expectedMods,
                ...downloaded.map(filename => filename.toLowerCase())
              ]);
              await saveExpectedModState(clientPath, updatedExpectedMods, win, stateResult.acknowledgedDependencies);
              console.log('Updated persistent state with downloaded mods');
            }
          } catch (stateError) {
            console.error('Failed to update persistent state after download:', stateError);
            // Don't fail the download operation just because state update failed
          }
        }
          
          const result = {
          success: failures.length === 0,
          downloaded: downloaded.length,
          skipped: skipped.length,
          removed: removed.length,
          removedMods: removed, // Add the actual list of removed mod filenames
          downloadedFiles: downloaded, // **FIX**: Include list of downloaded filenames for frontend store update
          failures: failures,
          manualModsAnalysis: manualModsAnalysis,
          message: failures.length === 0
            ? `Successfully processed ${totalProcessed} mods (${downloaded.length} downloaded, ${skipped.length} already present, ${removed.length} removed)`
            : `Processed ${successCount}/${totalProcessed} mods successfully, ${failures.length} failed`
        };

        console.log('→ returning updatedServerManagedFiles (downloadedFiles):', downloaded);
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
        return {          isAuthenticated: false,
          isLaunching: false,
          isRunning: false,
          username: null,
          clientPath: null
        };
      }
    },'minecraft-check-mods': async (_e, { clientPath, requiredMods, allClientMods = [], serverManagedFiles = [] }) => {
      try {        // Debug helper function with scoped logging
        const debugDump = async (context, scope = null) => {
          try {
            const state = await loadExpectedModState(clientPath, win);
            const currentServerMods = new Set([
              ...requiredMods.map(m => m.fileName.toLowerCase()),
              ...allClientMods.map(m => m.fileName.toLowerCase())
            ]);
            const serverManagedFilesSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));
            
            console.log(`\n=== DEBUG DUMP (${context}) ===`);
            
            // Only log full state if no scope is specified
            if (!scope) {
              console.log('currentServerMods:', Array.from(currentServerMods));
              console.log('serverManagedFilesSet:', Array.from(serverManagedFilesSet));
              console.log('acknowledgedDependencies:', Array.from(state.acknowledgedDependencies));
              console.log('expectedMods (persistent):', Array.from(state.expectedMods));
            } else {
              // Scoped logging for specific operations
              switch (scope.type) {
                case 'acknowledgment':
                  console.log('ACKNOWLEDGMENT SCOPE:', scope.mod);
                  console.log('acknowledgedDependencies:', Array.from(state.acknowledgedDependencies));
                  console.log('currentServerMods affecting this mod:', 
                    Array.from(currentServerMods).filter(m => scope.mod && 
                      [scope.mod, scope.mod.replace(/\.jar$/, ''), scope.mod.replace(/-/g, '_')]
                      .some(variant => m.includes(variant.toLowerCase()))));
                  break;
                case 'removal':
                  console.log('REMOVAL SCOPE:', scope.mods);
                  console.log('expectedMods (persistent):', Array.from(state.expectedMods));
                  console.log('mods being removed:', scope.mods);
                  break;
                default:
                  console.log('SCOPE:', scope);
              }
            }
            
            console.log('====================================\n');
          } catch (err) {
            console.error('Debug dump failed:', err);
          }
        };

        console.log('>>> START minecraft-check-mods');
        await debugDump('start of minecraft-check-mods');
        
        if (!clientPath || !requiredMods || !Array.isArray(requiredMods)) {
          return { success: false, error: 'Invalid parameters' };
        }
        
        // Guard against incomplete server data - if serverManagedFiles has content but requiredMods is empty,
        // it likely means the server data isn't fully loaded yet
        if (serverManagedFiles.length > 0 && requiredMods.length === 0 && allClientMods.length === 0) {
          return { 
            success: true, 
            synchronized: true, 
            missingMods: [],
            missingOptionalMods: [],
            extraMods: [],
            totalRequired: 0,
            totalOptional: 0,
            totalPresent: 0,
            needsDownload: 0,
            needsOptionalDownload: 0,
            needsRemoval: 0,
            presentEnabledMods: [],
            presentDisabledMods: []
          };
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
        }        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');        const extraMods = [];
        const clientModChanges = {
          updates: [],
          removals: [],
          newDownloads: []
        };
          // Initialize server managed files if empty but server has mods
        let serverManagedFilesSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));
          // Load persistent expected mod state
        const stateResult = await loadExpectedModState(clientPath, win);
        const expectedModState = stateResult.expectedMods;
        const acknowledgedDependencies = stateResult.acknowledgedDependencies;

        // Store whether we need to bootstrap (save state after diffing)
        let needsBootstrap = false;

        // If serverManagedFiles is empty but we have persistent state, use that
        if (serverManagedFilesSet.size === 0 && expectedModState.size > 0) {
          serverManagedFilesSet = new Set(expectedModState);
        }        // If no persistent state and we have server mods, use them for comparison but DON'T save yet
        else if (serverManagedFilesSet.size === 0 && (requiredMods.length > 0 || allClientMods.length > 0)) {
          const allServerMods = [
            ...requiredMods.map(m => m.fileName.toLowerCase()),
            ...allClientMods.map(m => m.fileName.toLowerCase())
          ];
          serverManagedFilesSet = new Set(allServerMods);
          
          // Mark that we need to bootstrap (save state after diffing)
          needsBootstrap = true;
          console.log('Bootstrap: Will use server mods for comparison but save state after diffing');
        }
        // If we have both current and expected state, use expected for comparison
        else if (serverManagedFilesSet.size > 0 && expectedModState.size > 0) {
          // Use the expected state for comparison to detect removals
          serverManagedFilesSet = new Set(expectedModState);
        }
        
        console.log('Server managed files (final):', Array.from(serverManagedFilesSet));

        // Current server mods (what the server currently requires)
        const currentServerMods = new Set([
          ...requiredMods.map(m => m.fileName.toLowerCase()),
          ...allClientMods.map(m => m.fileName.toLowerCase())
        ]);
        console.log('Current server mods (requiredMods):', requiredMods.map(m => m.fileName));
        console.log('Current server mods (allClientMods):', allClientMods.map(m => m.fileName));
        console.log('Combined currentServerMods set:', Array.from(currentServerMods));        // Get client-side dependencies to check if mods should be kept
        const clientSideDependencies = await getClientSideDependencies(clientPath, serverManagedFiles);
        console.log('Client-side dependencies found:', Array.from(clientSideDependencies));        // Get list of client-side mods for dependency reasoning
        const clientSideMods = [];
        if (fs.existsSync(modsDir)) {
          const modFiles = fs.readdirSync(modsDir).filter(file => 
            file.toLowerCase().endsWith('.jar') && !file.toLowerCase().endsWith('.jar.disabled')
          );
          
          const serverManagedSet = new Set(serverManagedFiles.map(f => f.toLowerCase()));
          clientSideMods.push(...modFiles.filter(file => 
            !serverManagedSet.has(file.toLowerCase())
          ));
        }

        // ——————————————————————————————
        // HELPERS FOR SELF-EXCLUSION IN DEPENDENCY REASONS
        const buildClientSideModsFor = (excludeFile) => {
          if (!fs.existsSync(modsDir)) return [];
          
          const modFiles = fs.readdirSync(modsDir).filter(file => 
            file.toLowerCase().endsWith('.jar') && !file.toLowerCase().endsWith('.jar.disabled')
          );
          
          const lowerExclude = excludeFile.toLowerCase();
          return modFiles.filter(f => {
            const lf = f.toLowerCase();
            // 1) not server-managed, and 2) not the mod itself
            return !serverManagedFilesSet.has(lf) && lf !== lowerExclude;
          });
        };

        const formatReason = (dependents) => {
          if (dependents.length === 0) return null;
          const names = dependents.map(f => f.replace(/\.jar$/i,''));
          if (names.length === 1) return `required as dependency by ${names[0]}`;
          if (names.length === 2) return `required as dependency by ${names[0]} and ${names[1]}`;
          return `required as dependency by ${names[0]}, ${names[1]} and ${names.length-2} other mod${names.length-2 > 1 ? 's' : ''}`;
        };
        // ——————————————————————————————

        // Get all actual mods currently in the mods folder (both enabled and disabled)
        const allCurrentMods = new Set();
        if (fs.existsSync(modsDir)) {
          const enabledMods = fs.readdirSync(modsDir).filter(f => f.toLowerCase().endsWith('.jar'));
          const disabledModFiles = fs.readdirSync(modsDir).filter(f => f.toLowerCase().endsWith('.jar.disabled'));
          
          enabledMods.forEach(f => allCurrentMods.add(f.toLowerCase()));
          disabledModFiles.forEach(f => allCurrentMods.add(f.replace('.disabled', '').toLowerCase()));
        }
        console.log('All current mods in folder:', Array.from(allCurrentMods));

        // Check manifest-tracked mods for removal (existing logic)
        if (fs.existsSync(manifestDir)) {
          const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
            
          for (const file of manifests) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));                
              if (data.fileName) {
                const fileNameLower = data.fileName.toLowerCase();
                const baseModName = getBaseModName(data.fileName).toLowerCase();
                  
                if (serverManagedFilesSet.has(fileNameLower) && 
                    !currentServerMods.has(fileNameLower)) {
                    console.log(`Checking removal for ${data.fileName}:`);
                  console.log(`  - Is in serverManagedFiles: ${serverManagedFilesSet.has(fileNameLower)}`);
                  console.log(`  - Is NOT in currentServerMods: ${!currentServerMods.has(fileNameLower)}`);
                  console.log(`  - fileNameLower: "${fileNameLower}"`);
                  console.log(`  - baseModName: "${baseModName}"`);
                  console.log(`  - data.name: "${data.name || 'undefined'}"`);
                    const isNeededByClientMod = clientSideDependencies.has(fileNameLower) ||
                      clientSideDependencies.has(baseModName) ||
                      clientSideDependencies.has(data.name?.toLowerCase() || '') ||
                      // Add specific Fabric API checks
                      (fileNameLower.includes('fabric') && fileNameLower.includes('api') && (
                        clientSideDependencies.has('fabric-api') ||
                        clientSideDependencies.has('fabricapi') ||
                        clientSideDependencies.has('fabric_api') ||
                        (clientSideDependencies.has('fabric') && clientSideDependencies.has('api'))
                      )) ||
                      // Check by mod ID from the filename
                      checkModDependencyByFilename(fileNameLower, clientSideDependencies);
                  
                  // Check if this dependency has already been acknowledged
                  const isAlreadyAcknowledged = acknowledgedDependencies.has(fileNameLower) ||
                      acknowledgedDependencies.has(baseModName) ||
                      acknowledgedDependencies.has(data.name?.toLowerCase() || '');
                  
                  if (!isNeededByClientMod) {
                    console.log(`  -> WILL REMOVE: ${data.fileName}`);
                    extraMods.push(data.fileName);                  } else if (!isAlreadyAcknowledged) {                    console.log(`  -> WILL KEEP: ${data.fileName} (needed by client-side mod) - first time notification`);
                    
                    // Build list of client-side mods excluding the one under test
                    const dependents = buildClientSideModsFor(data.fileName);
                    const reason = formatReason(dependents) || 'required as dependency by client downloaded mods';

                    console.log(`Ack for ${data.fileName}: dependents=`, dependents);
                      clientModChanges.removals.push({
                      name: data.fileName,
                      fileName: data.fileName,
                      reason: reason,
                      action: 'acknowledge_dependency'
                    });
                  } else {
                    console.log(`  -> WILL KEEP: ${data.fileName} (needed by client-side mod) - already acknowledged`);
                  }
                }
              }
            } catch (error) {
              console.warn(`Failed to parse manifest ${file}:`, error.message);
            }
          }
        }

        // NEW: Check ALL mods in the folder for potential removal, not just manifest-tracked ones
        // This handles mods that might not have manifests but still need to be removed
        for (const modFileName of allCurrentMods) {
          const fileNameLower = modFileName.toLowerCase();
          const baseModName = getBaseModName(modFileName).toLowerCase();
          
          // Skip if this mod is currently required by server
          if (currentServerMods.has(fileNameLower)) {
            console.log(`Skipping ${modFileName} - currently required by server`);
            continue;
          }
          
          // Skip if this mod is not server-managed (e.g., client-only mods)
          if (!serverManagedFilesSet.has(fileNameLower)) {
            console.log(`Skipping ${modFileName} - not server-managed`);
            continue;
          }
          
          // Skip if we already processed this mod through manifests
          if (extraMods.some(mod => mod.toLowerCase() === fileNameLower) ||
              clientModChanges.removals.some(removal => removal.fileName.toLowerCase() === fileNameLower)) {
            console.log(`Skipping ${modFileName} - already processed through manifest`);
            continue;
          }
          
          console.log(`Checking NON-MANIFEST mod for removal: ${modFileName}`);
            // Check if this mod is needed by client-side dependencies
          const isNeededByClientMod = clientSideDependencies.has(fileNameLower) ||
              clientSideDependencies.has(baseModName) ||
              // Add specific Fabric API checks
              (fileNameLower.includes('fabric') && fileNameLower.includes('api') && (
                clientSideDependencies.has('fabric-api') ||
                clientSideDependencies.has('fabricapi') ||
                clientSideDependencies.has('fabric_api') ||
                (clientSideDependencies.has('fabric') && clientSideDependencies.has('api'))
              )) ||
              // Check by mod ID from the filename (e.g., sodium-fabric-0.5.8+mc1.20.1.jar -> sodium)
              checkModDependencyByFilename(fileNameLower, clientSideDependencies);
          
          // Check if this dependency has already been acknowledged
          const isAlreadyAcknowledged = acknowledgedDependencies.has(fileNameLower) ||
              acknowledgedDependencies.has(baseModName);
          
          console.log(`  - isNeededByClientMod: ${isNeededByClientMod}`);
          console.log(`  - isAlreadyAcknowledged: ${isAlreadyAcknowledged}`);
          
          if (!isNeededByClientMod) {
            console.log(`  -> WILL REMOVE: ${modFileName} (no manifest)`);
            extraMods.push(modFileName);          } else if (!isAlreadyAcknowledged) {            console.log(`  -> WILL KEEP: ${modFileName} (needed by client-side mod) - first time notification (no manifest)`);
            
            // Build list of client-side mods excluding the one under test
            const dependents = buildClientSideModsFor(modFileName);
            const reason = formatReason(dependents) || 'required as dependency by client downloaded mods';

            console.log(`Ack for ${modFileName}: dependents=`, dependents);
            
            clientModChanges.removals.push({
              name: modFileName,
              fileName: modFileName,
              reason: reason,
              action: 'acknowledge_dependency'
            });
          } else {
            console.log(`  -> WILL KEEP: ${modFileName} (needed by client-side mod) - already acknowledged (no manifest)`);
          }
        }
        
        const modAnalysisUtils = require('./mod-utils/mod-analysis-utils.cjs');
        const allPresentMods = [...presentMods, ...disabledMods];
          const allServerManagedFiles = new Set([
            ...(serverManagedFiles || []).map(f => f.toLowerCase()),
            ...requiredMods.map(rm => rm.fileName.toLowerCase()),
            ...(allClientMods || []).filter(m => m.required).map(m => m.fileName.toLowerCase())
          ]);        for (const modFileName of allPresentMods) {
            const modFileNameLower = modFileName.toLowerCase();
            
            if (allServerManagedFiles.has(modFileNameLower)) {
              continue;
            }
            
            const modPath = presentMods.includes(modFileName)
              ? path.join(modsDir, modFileName)
              : path.join(modsDir, modFileName + '.disabled');
              const clientModMetadata = await modAnalysisUtils.extractDependenciesFromJar(modPath);
            if (!clientModMetadata) continue;
            
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
              
              return false;            }) : null;

            if (exactServerMatch || similarServerMatch) {
              const matchedServerMod = exactServerMatch || similarServerMatch;
              const serverVersion = extractVersionFromFilename(matchedServerMod.fileName) || 'Server Version';
              
              clientModChanges.updates.push({
                fileName: modFileName,
                name: clientModMetadata.name || modFileName,
                currentVersion: clientModMetadata.version || 'Unknown',
                serverVersion: serverVersion,                action: 'update'
              });
            } 
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
          });          if (serverMod) {
            serverModsWithClientUpdates.add(serverMod.fileName);
          }
        }
        
        for (const modFileName of missingMods.concat(outdatedMods)) {
          if (!serverModsWithClientUpdates.has(modFileName)) {
            clientModChanges.newDownloads.push(modFileName);
          }        }        // Track extra mods that need removal but DON'T automatically delete them
        // Let the user decide when to remove them through the UI
        console.log(`About to process extraMods for removal:`, extraMods);
        console.log(`Total unique mods marked for removal: ${extraMods.length}`);
        console.log(`Mods marked for removal: ${extraMods.join(', ')}`);
        const successfullyRemovedMods = [];        
        for (const extraMod of extraMods) {
          console.log(`Detected extra mod that should be removed: ${extraMod}`);
          
          // Just track the mod for removal - don't actually delete it
          clientModChanges.removals.push({
            name: extraMod,
            fileName: extraMod,
            reason: 'no longer required by server',
            action: 'remove_needed' // Changed from 'remove' to indicate it needs removal
          });
          
          console.log(`Added to clientModChanges.removals:`, {
            name: extraMod,
            fileName: extraMod,
            reason: 'no longer required by server',
            action: 'remove_needed'
          });
          
          // Don't add to successfullyRemovedMods since we didn't actually remove anything
        }
        
        console.log('Final clientModChanges.removals:', clientModChanges.removals);        
        console.log('Successfully removed mods:', successfullyRemovedMods);

        const updatedServerManagedFiles = Array.from(
          new Set(
            [...serverManagedFilesSet].filter(
              f => !successfullyRemovedMods.some(r => r.toLowerCase() === f.toLowerCase())
            )
          )
        );        console.log('Backend: Before filtering - serverManagedFiles:', Array.from(serverManagedFilesSet));
        console.log('Backend: After filtering - updatedServerManagedFiles:', updatedServerManagedFiles);        await debugDump('before acknowledgment clearing');
        
        // ————————————————————————
        // **SCOPED**: Only clear acknowledgments for mods that were actually re-added
        // This should ONLY happen when a mod is actually downloaded/re-added, not during regular checks
        console.log('=== ACKNOWLEDGMENT CLEARING CHECK ===');
        console.log('acknowledgedDependencies:', Array.from(acknowledgedDependencies));
        console.log('currentServerMods:', Array.from(currentServerMods));
        console.log('serverManagedFilesSet (frontend state):', Array.from(serverManagedFilesSet));
          // Get the persistent state as the source of truth for "previous" state
        const previousExpectedMods = expectedModState; // This is from persistent storage, not frontend
        const newlyReaddedMods = [];
        
        // IMPORTANT: Only clear acknowledgments if a mod is back on the server 
        // AND was not in our persistent expected state (meaning it was truly re-added)
        for (const currentMod of currentServerMods) {
          // Check if this mod is in current server but was previously acknowledged
          for (const ackModName of Array.from(acknowledgedDependencies)) {
            const bareAck = ackModName.toLowerCase().replace(/\.jar$/,'');
            const hyphens = bareAck;
            const underscores = bareAck.replace(/-/g, '_');
            const candidates = [
              `${hyphens}.jar`,
              `${underscores}.jar`,
              hyphens,
              underscores
            ];
            
            // If current server mod matches an acknowledged mod
            if (candidates.includes(currentMod)) {
              // Only clear if this mod wasn't in the PERSISTENT expected state
              // This prevents clearing acknowledgments during normal mod removals
              if (!previousExpectedMods.has(currentMod)) {
                console.log(`  → Detected re-added mod: ${currentMod} (was acknowledged as ${ackModName})`);
                console.log(`  → previousExpectedMods had: ${Array.from(previousExpectedMods)}`);
                newlyReaddedMods.push({ ack: ackModName, server: currentMod });
                // Log scoped debug info for this specific mod
                await debugDump(`acknowledgment clearing for ${ackModName}`, {
                  type: 'acknowledgment',
                  mod: ackModName
                });
              } else {
                console.log(`  → NOT clearing ${ackModName}: was in persistent state (${currentMod})`);
              }
            }
          }
        }
        
        // Only clear acknowledgments for truly re-added mods
        const clearedAcknowledgments = [];
        for (const { ack, server } of newlyReaddedMods) {
          console.log(`  → CLEARING ack '${ack}' (newly re-added server mod: '${server}')`);
          acknowledgedDependencies.delete(ack);
          clearedAcknowledgments.push(ack);
        }
        
        if (newlyReaddedMods.length === 0) {
          console.log('  → No acknowledgments cleared (no newly re-added mods detected)');
        } else {
          console.log(`  → Cleared ${clearedAcknowledgments.length} acknowledgments:`, clearedAcknowledgments);
        }
        
        console.log('=== END ACKNOWLEDGMENT CLEARING ===');
        
        await debugDump('after acknowledgment clearing');
        
        // Update persistent state after all diffing is complete
        try {
          let stateToSave;
          
          if (needsBootstrap) {
            // First-time bootstrap: save the current server state after diffing
            console.log('Bootstrap: Saving initial expected state after diffing');
            stateToSave = new Set(currentServerMods);
          } else {
            // Normal update: save the updated state after removals
            stateToSave = new Set(updatedServerManagedFiles.map(f => f.toLowerCase()));
          }          
          // Now save: expectedMods (as before) + pruned ack list
          await saveExpectedModState(clientPath, stateToSave, win, acknowledgedDependencies);
          console.log('Updated persistent state:', {
            bootstrap: needsBootstrap,
            expectedMods: Array.from(stateToSave),
            acknowledgedDependencies: Array.from(acknowledgedDependencies)
          });
          
          // Validate state consistency after save
          console.log('=== STATE VALIDATION ===');
          for (const ack of acknowledgedDependencies) {
            if (currentServerMods.has(ack)) {
              console.warn(`STATE ERROR: ${ack} is BOTH server-managed AND acknowledged!`);
            } else {
              console.log(`✓ Valid: ${ack} is acknowledged but not server-managed`);
            }
          }
          console.log('=== END STATE VALIDATION ===');
        } catch (stateError) {
          console.error('Failed to update persistent state:', stateError);
          // Don't fail the check operation just because state update failed
        }
        // ————————————————————————// Check if there are any acknowledgment notifications pending
        const hasAcknowledgmentNotifications = clientModChanges.removals.some(removal => 
          removal.action === 'acknowledge_dependency'
        );
        
        const synchronized =
          missingMods.length === 0 &&
          outdatedMods.length === 0 &&
          extraMods.length === 0 &&
          !hasAcknowledgmentNotifications; // Not synchronized if there are pending acknowledgments
        
        console.log('Synchronization status:', {
          missingMods: missingMods.length,
          outdatedMods: outdatedMods.length, 
          extraMods: extraMods.length,
          hasAcknowledgmentNotifications,
          synchronized
        });
          const actualNeedsDownload = missingMods.length + outdatedMods.length;
        const actualNeedsOptionalDownload = missingOptionalMods.length + outdatedOptionalMods.length;        const needsAcknowledgment = clientModChanges.removals.filter(removal => 
          removal.action === 'acknowledge_dependency'
        ).length;
          await debugDump('end of minecraft-check-mods');
        console.log('>>> END minecraft-check-mods\n');
        
        const result = {
          success: true,
          synchronized,
          missingMods: missingMods.concat(outdatedMods),
          missingOptionalMods: missingOptionalMods.concat(outdatedOptionalMods),
          extraMods,
          clientModChanges,
          successfullyRemovedMods,
          totalRequired: requiredMods.length,
          totalOptional: allClientMods.filter(m => !m.required).length,
          totalPresent: requiredMods.length - missingMods.length - outdatedMods.length,
          totalOptionalPresent: (allClientMods.filter(m => !m.required).length) - missingOptionalMods.length - outdatedOptionalMods.length,
          needsDownload: synchronized ? 0 : actualNeedsDownload,
          needsOptionalDownload: actualNeedsOptionalDownload,
          needsRemoval: extraMods.length,
          needsAcknowledgment,
          presentEnabledMods: presentMods,
          presentDisabledMods: disabledMods,
          updatedServerManagedFiles
        };
        
        console.log('→ returning updatedServerManagedFiles:', updatedServerManagedFiles);
        return result;
      } catch (error) {
        console.error('>>> ERROR in minecraft-check-mods:', error);
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
        }        return { success: true, removed };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },    'minecraft-remove-server-managed-mods': async (_e, { clientPath, modsToRemove = [] }) => {
      try {
        console.log('>>> START minecraft-remove-server-managed-mods for:', modsToRemove);
          // Debug helper function with scoped logging
        const debugDump = async (context, scope = null) => {
          try {
            const state = await loadExpectedModState(clientPath, win);
            console.log(`\n=== DEBUG DUMP (${context}) ===`);
            
            if (!scope) {
              console.log('modsToRemove:', modsToRemove);
              console.log('acknowledgedDependencies:', Array.from(state.acknowledgedDependencies));
              console.log('expectedMods (persistent):', Array.from(state.expectedMods));
            } else {
              // Scoped logging for specific mod removals
              switch (scope.type) {
                case 'individual-removal':
                  console.log('INDIVIDUAL MOD REMOVAL:', scope.mod);
                  console.log('acknowledgedDependencies before:', Array.from(state.acknowledgedDependencies));
                  console.log('expectedMods before:', Array.from(state.expectedMods));
                  break;
                default:
                  console.log('SCOPE:', scope);
              }
            }
            
            console.log('====================================\n');
          } catch (err) {
            console.error('Debug dump failed:', err);
          }
        };

        await debugDump('before mod removal');
        
        if (!clientPath || !Array.isArray(modsToRemove) || modsToRemove.length === 0) {
          console.log('Invalid parameters for mod removal');
          return { success: false, error: 'Client path and mods to remove are required' };
        }

        const modsDir = path.join(clientPath, 'mods');
        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
        const successfullyRemovedMods = [];

        if (!fs.existsSync(modsDir)) {
          return { success: true, removed: [] };
        }        for (const modFileName of modsToRemove) {
          try {
            console.log(`Attempting to remove mod: ${modFileName}`);
            
            // Debug dump for individual mod removal
            await debugDump(`before removing ${modFileName}`, {
              type: 'individual-removal',
              mod: modFileName
            });
            
            // Handle case sensitivity by checking all files in the directory
            const allFiles = fs.readdirSync(modsDir);
            const targetFile = allFiles.find(file => 
              file.toLowerCase() === modFileName.toLowerCase() || 
              file.toLowerCase() === (modFileName + '.disabled').toLowerCase()
            );
            
            console.log(`All files in mods dir: ${allFiles.join(', ')}`);
            console.log(`Looking for: ${modFileName} (case-insensitive)`);
            console.log(`Found matching file: ${targetFile || 'none'}`);
            
            let removed = false;
            if (targetFile) {
              const actualPath = path.join(modsDir, targetFile);
              fs.unlinkSync(actualPath);
              console.log(`Removed mod file: ${actualPath}`);
              removed = true;
            } else {
              console.log(`Mod file not found: ${modFileName}`);
            }
            
            if (removed) {
              // Remove the corresponding manifest file
              const manifestPath = path.join(manifestDir, modFileName.replace('.jar', '.json'));
              if (fs.existsSync(manifestPath)) {
                fs.unlinkSync(manifestPath);
                console.log(`Removed manifest file: ${manifestPath}`);
              }
              
              successfullyRemovedMods.push(modFileName);
              
              // Debug dump after individual mod removal
              await debugDump(`after removing ${modFileName}`, {
                type: 'individual-removal',
                mod: modFileName
              });
            }
          } catch (error) {
            console.error(`Failed to remove mod ${modFileName}:`, error);
            // Continue with other mods even if one fails
          }
        }        // Update persistent state after successful removal
        if (successfullyRemovedMods.length > 0) {
          try {
            const loadResult = await loadExpectedModState(clientPath, win);
            if (loadResult.success) {
              const expectedMods = loadResult.expectedMods;
              const acknowledgedDependencies = loadResult.acknowledgedDependencies;
              
              // Remove the successfully removed mods from expected state
              for (const removedMod of successfullyRemovedMods) {
                expectedMods.delete(removedMod.toLowerCase());
              }
                // Save updated state WITH preserved acknowledgments
              await saveExpectedModState(clientPath, expectedMods, win, acknowledgedDependencies);
              console.log('Updated persistent state after mod removal:', Array.from(expectedMods));
              console.log('Preserved acknowledged dependencies:', Array.from(acknowledgedDependencies));
              
              // Final debug dump to confirm acknowledgments were preserved
              await debugDump('after persistent state update');
            }
          } catch (stateError) {
            console.error('Failed to update persistent state after mod removal:', stateError);
            // Don't fail the removal operation just because state update failed
          }
        }return { 
          success: true, 
          removed: successfullyRemovedMods,
          count: successfullyRemovedMods.length 
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },    'minecraft-acknowledge-dependency': async (_e, { clientPath, modFileName }) => {
      try {
        console.log('>>> START minecraft-acknowledge-dependency for:', modFileName);
        
        // Debug helper function
        const debugDump = async (context) => {
          try {
            const state = await loadExpectedModState(clientPath, win);
            console.log(`\n=== DEBUG DUMP (${context}) ===`);
            console.log('modFileName:', modFileName);
            console.log('acknowledgedDependencies:', Array.from(state.acknowledgedDependencies));
            console.log('expectedMods (persistent):', Array.from(state.expectedMods));
            console.log('====================================\n');
          } catch (err) {
            console.error('Debug dump failed:', err);
          }
        };
        
        await debugDump('before acknowledgment');
        
        if (!clientPath || !modFileName) {
          return { success: false, error: 'Client path and mod file name are required' };
        }

        console.log('Acknowledging dependency:', modFileName);
        
        // Load current state
        const stateResult = await loadExpectedModState(clientPath, win);
        if (!stateResult.success) {
          return { success: false, error: 'Failed to load mod state' };
        }
        
        const expectedMods = stateResult.expectedMods;
        const acknowledgedDependencies = stateResult.acknowledgedDependencies || new Set();
        
        // Add the mod to acknowledged dependencies
        const baseModName = getBaseModName(modFileName).toLowerCase();
        acknowledgedDependencies.add(modFileName.toLowerCase());
        acknowledgedDependencies.add(baseModName);
        
        // Save updated state
        await saveExpectedModState(clientPath, expectedMods, win, acknowledgedDependencies);
        console.log('Updated acknowledged dependencies:', Array.from(acknowledgedDependencies));
        
        // Validate state consistency after acknowledgment
        console.log('=== STATE VALIDATION AFTER ACKNOWLEDGMENT ===');
        for (const ack of acknowledgedDependencies) {
          console.log(`✓ Acknowledged: ${ack}`);
        }
        console.log('=== END STATE VALIDATION ===');
        
        await debugDump('after acknowledgment');
        
        console.log('>>> END minecraft-acknowledge-dependency');
        return { success: true };
      } catch (error) {
        console.error('Failed to acknowledge dependency:', error);
        return { success: false, error: error.message };
      }
    },    'load-expected-mod-state': async (_e, { clientPath }) => {
      try {
        const stateResult = await loadExpectedModState(clientPath, win);
        return {
          success: stateResult.success,
          expectedMods: Array.from(stateResult.expectedMods || []),
          acknowledgedDependencies: Array.from(stateResult.acknowledgedDependencies || []),
          error: stateResult.error
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    'clear-expected-mod-state': async (_e, { clientPath }) => {
      try {
        if (!clientPath) {
          return { success: false, error: 'Client path is required' };
        }
        return await clearExpectedModState(clientPath);
      } catch (error) {
        console.error('Failed to clear expected mod state:', error);
        return { success: false, error: error.message };      }
    },
  };
}

module.exports = { createMinecraftLauncherHandlers, loadExpectedModState };
