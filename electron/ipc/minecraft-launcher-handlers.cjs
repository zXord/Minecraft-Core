const { getMinecraftLauncher } = require('../services/minecraft-launcher/index.cjs');
const utils = require('../services/minecraft-launcher/utils.cjs');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');
const { readModMetadataFromJar } = require('./mod-utils/mod-file-manager.cjs');
const modAnalysisUtils = require('./mod-utils/mod-analysis-utils.cjs');
const { ensureServersDat } = require('../utils/servers-dat.cjs');

// In-memory lock to prevent race conditions during state operations
let stateLockPromise = Promise.resolve();

/**
 * Save the expected mod state to a persistent JSON file
 * Uses async fs operations and includes error handling with UI notifications * @param {string} clientPath - Path to the client directory
 * @param {Set} requiredMods - Set of required mod filenames
 * @param {Set} optionalMods - Set of optional mod filenames  
 * @param {object} win - Electron window object for error notifications
 * @param {Set} acknowledgedDeps - Set of acknowledged dependency mod filenames
 * @returns {Promise<{success: boolean, error?: string}>} Result of the save operation
 */
async function saveExpectedModState(clientPath, requiredMods, optionalMods, win = null, acknowledgedDeps = new Set()) {
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
      }        const state = {
        ...existingState,
        requiredMods: Array.from(requiredMods),
        optionalMods: Array.from(optionalMods),
        acknowledgedDeps: Array.from(acknowledgedDeps),
        lastUpdated: new Date().toISOString(),
        version: 1 // New simplified schema version
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
 * @returns {Promise<{success: boolean, requiredMods: Set, optionalMods: Set, acknowledgedDeps: Set, error?: string}>}
 */
async function loadExpectedModState(clientPath, win = null) {
  const stateFile = path.join(clientPath, 'minecraft-core-state', 'expected-mods.json');
  
  try {
    // Check if file exists
    try {
      await fsPromises.access(stateFile);
    } catch {
      return { success: true, requiredMods: new Set(), optionalMods: new Set(), acknowledgedDeps: new Set() };
    }
    
    const data = await fsPromises.readFile(stateFile, 'utf8');
    
    // Handle empty or corrupted JSON files
    if (!data.trim()) {
      return { success: true, requiredMods: new Set(), optionalMods: new Set(), acknowledgedDeps: new Set() };
    }
    
    let state;
    try {
      state = JSON.parse(data);
    } catch (parseError) {
      console.error('Corrupted state file, resetting:', parseError);
      // Delete corrupted file and start fresh
      try {
        await fsPromises.unlink(stateFile);
      } catch (unlinkError) {
        console.warn('Could not delete corrupted state file:', unlinkError);
      }
      return { success: true, requiredMods: new Set(), optionalMods: new Set(), acknowledgedDeps: new Set() };
    }
    
    // Handle schema migration and new schema (version 1)
    let requiredMods = new Set();
    let optionalMods = new Set(); 
    let acknowledgedDeps = new Set();
    
    if (state.version === 1) {
      // New schema - direct mapping
      requiredMods = new Set(state.requiredMods || []);
      optionalMods = new Set(state.optionalMods || []);
      acknowledgedDeps = new Set(state.acknowledgedDeps || []);
    } else {
      // Legacy schema migration (v0, v2, or unknown)
      // Migrate from old expectedMods/previousOptionalMods format
      if (state.expectedMods) {
        requiredMods = new Set(state.expectedMods);
      }
      if (state.previousOptionalMods) {
        optionalMods = new Set(state.previousOptionalMods);
      }
      if (state.acknowledgedDependencies) {
        acknowledgedDeps = new Set(state.acknowledgedDependencies);
      }
      
      // Save migrated format to new schema
      console.log('[STATE-MIGRATION] Migrating state to new schema version 1');
      await saveExpectedModState(clientPath, requiredMods, optionalMods, win, acknowledgedDeps);
    }

    return { success: true, requiredMods, optionalMods, acknowledgedDeps };
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
    
    return { success: false, error: error.message, requiredMods: new Set(), optionalMods: new Set(), acknowledgedDeps: new Set() };
  }
}

/**
 * Clear persistent mod state - useful for debugging or starting fresh
 */
async function clearExpectedModState(clientPath) {
  const stateFile = path.join(clientPath, 'minecraft-core-state', 'expected-mods.json');
  
  try {
    if (fs.existsSync(stateFile)) {
      await fsPromises.unlink(stateFile);

      return { success: true, message: 'Persistent mod state cleared' };
    } else {

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
  const dependencies = new Set();
  
  try {
    const modsDir = path.join(clientPath, 'mods');
    if (!fs.existsSync(modsDir)) {

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
    }    // Get truly client-side mods (exclude anything currently server-managed)
    const clientSideMods = modFiles.filter(file => {
      const fileName = file.toLowerCase();
      // If it's currently server-managed, it's NOT a client-side mod
      return !serverManagedSet.has(fileName);
    });
    
      for (const modFile of clientSideMods) {      const modPath = path.join(modsDir, modFile);
      
      try {
        const metadata = await modAnalysisUtils.extractDependenciesFromJar(modPath);
        
        
        if (metadata) {
          // Handle 'dependencies' field (array format)
          if (metadata.dependencies && Array.isArray(metadata.dependencies)) {
            for (const dep of metadata.dependencies) {              if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
              } else if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
              }
            }
          } else if (metadata.dependencies && typeof metadata.dependencies === 'object') {
            // Handle dependencies as object (key-value pairs)
            for (const depName of Object.keys(metadata.dependencies)) {
              dependencies.add(depName.toLowerCase());
            }
          }          // Handle 'depends' field (Fabric mod format)
          if (metadata.depends && typeof metadata.depends === 'object') {
            for (const depName of Object.keys(metadata.depends)) {
              if (!['minecraft', 'fabricloader', 'java'].includes(depName.toLowerCase())) {
                dependencies.add(depName.toLowerCase());
              }
            }
          } else if (metadata.depends && Array.isArray(metadata.depends)) {
            for (const dep of metadata.depends) {
              if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
              } else if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
              }
            }
          }
            // Handle 'requires' field
          if (metadata.requires && Array.isArray(metadata.requires)) {
            for (const dep of metadata.requires) {
              if (typeof dep === 'string') {
                dependencies.add(dep.toLowerCase());
              } else if (typeof dep === 'object' && dep.modid) {
                dependencies.add(dep.modid.toLowerCase());
              }
            }
          }
          
          // Handle embedded 'jars' field (bundled dependencies)
          if (metadata.jars && Array.isArray(metadata.jars)) {
            for (const jar of metadata.jars) {
              if (typeof jar === 'object' && jar.file) {
                // Extract mod name from embedded jar filename
                const jarFile = jar.file.split('/').pop(); // Get filename from path
                const jarName = jarFile.replace(/\.jar$/i, '').toLowerCase();
                
                // Try to extract a meaningful mod ID from the jar name
                const cleanJarName = jarName.replace(/[-_]\d+.*$/, ''); // Remove version
                const modIdFromJar = cleanJarName.replace(/[-_]/g, ''); // Remove separators
                
                dependencies.add(jarName);
                dependencies.add(cleanJarName);
                dependencies.add(modIdFromJar);
                
                
                // Special handling for common patterns
                if (jarName.includes('placeholder') && jarName.includes('api')) {
                  dependencies.add('placeholder-api');
                  dependencies.add('placeholderapi');
                  dependencies.add('text-placeholder-api');
                  dependencies.add('textplaceholderapi');
                }
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
      if (dep.includes('fabric') && (dep.includes('api') || dep === 'fabric-api' || dep === 'fabricapi')) {        fabricApiVariants.add('fabric');
        fabricApiVariants.add('api');
        fabricApiVariants.add('fabric-api');
        fabricApiVariants.add('fabricapi');
        fabricApiVariants.add('fabric_api');
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
      const modNameLower = modFile.toLowerCase();      for (const knownMod of knownFabricClientMods) {
        if (modNameLower.includes(knownMod)) {
          hasClientFabricMods = true;
          break;
        }
      }
    }
    
    if (hasClientFabricMods) {
      // Add all Fabric API variants if we detected known client-side Fabric mods
      dependencies.add('fabric-api');
      dependencies.add('fabricapi');
      dependencies.add('fabric_api');
    }
    
    const commonNonModDeps = new Set([
      'minecraft', 'forge', 'fabric', 'fabric-loader', 'fabricloader',
      'java', 'mcp', 'mappings', 'quilt', 'quilt-loader'
    ]);
      for (const dep of commonNonModDeps) {      dependencies.delete(dep);
    }
    

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
    nameLower.replace(/\.jar$/, ''), // Remove .jar
    // Try extracting just the first part before any delimiter
    nameLower.split(/[-_.]/)[0],
    // Additional patterns for compound names
    nameLower.replace(/[-_]/g, ''), // Remove all separators (text_placeholder_api -> textplaceholderapi)
    nameLower.replace(/[-_]/g, '').replace(/\.jar$/, ''), // Remove separators and .jar
  ];
  
  // Add special patterns for common mod name variations
  if (nameLower.includes('placeholder') && nameLower.includes('api')) {
    patterns.push('placeholderapi', 'placeholder-api', 'textplaceholderapi', 'text-placeholder-api');  }
  
  // Check each pattern against dependencies
  for (const pattern of patterns) {
    if (pattern && pattern.length > 2 && dependencies.has(pattern)) {
      return true;
    }  }
  
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
    },    'minecraft-download-mods': async (_e, { clientPath, requiredMods, allClientMods = [], serverInfo, optionalMods = [] }) => {
      try {
        if (!clientPath) {
          return { success: false, error: 'Invalid client path' };
        }
        
        // Combine required and optional mods for downloading
        const allModsToDownload = [...(requiredMods || []), ...(optionalMods || [])];
        
        const requiredModFileNames = new Set((requiredMods || []).map(mod => {
          const fileName = mod.fileName.toLowerCase();
          return fileName;
        }));
        
        if (allModsToDownload.length === 0) {
          return { success: true, downloaded: 0, failures: [], message: 'No mods to download' };
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
              
              const hasUpdate = allModsToDownload.some(reqMod => {
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
        }        for (let i = 0; i < allModsToDownload.length; i++) {
          const mod = allModsToDownload[i];
          
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
                
                request.setTimeout(60000, () => { // Increased timeout to 60 seconds
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
            : allModsToDownload;
          const allowed = new Set(allowedList.map(m => (typeof m === 'string' ? m : m.fileName)));
            if (fs.existsSync(manifestDir)) {
            const manifests = fs.readdirSync(manifestDir).filter(f => f.endsWith('.json'));
            for (const file of manifests) {                const manifestPath = path.join(manifestDir, file);
                const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const fileName = data.fileName;
                  if (!allowed.has(fileName) && data.source === 'server') {

                  // Don't automatically remove - let the user decide through the UI
          
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
            }          }        // **FIX**: Update persistent state to include newly downloaded REQUIRED mods only
        // Optional mods should not be tracked in the persistent state as "expected mods"
        if (downloaded.length > 0) {
          try {
            const stateResult = await loadExpectedModState(clientPath, win);
            if (stateResult.success) {
              // Only add required mods to persistent state, not optional ones
              const downloadedRequiredMods = downloaded.filter(filename => 
                requiredModFileNames.has(filename.toLowerCase())
              );
                if (downloadedRequiredMods.length > 0) {
                const updatedRequiredMods = new Set([
                  ...stateResult.requiredMods,
                  ...downloadedRequiredMods.map(filename => filename.toLowerCase())
                ]);
                await saveExpectedModState(clientPath, updatedRequiredMods, stateResult.optionalMods, win, stateResult.acknowledgedDeps);
              }
                if (downloaded.length > downloadedRequiredMods.length) {
                // Optional mods downloaded but not tracked in persistent state
              }
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


        return result;
        
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-launch': async (_e, options) => {
      try {        const {
          clientPath,
          minecraftVersion,
          serverIp,
          serverPort,
          managementPort,
          clientName,
          requiredMods = [],
          serverInfo = null,
          maxMemory = null,
          useProperLauncher = true,
          showDebugTerminal = false
        } = options;

        // CRITICAL FIX: Load authentication data for this client path before launching
        // This ensures the launcher has access to auth data even if it wasn't previously loaded
        console.log('🔐 Loading authentication data for client path:', clientPath);
        try {
          const loadAuthResult = await launcher.loadAuthData(clientPath);
          if (loadAuthResult.success) {
            console.log('✅ Authentication data loaded successfully for:', loadAuthResult.username);
          } else {
            console.warn('⚠️ No authentication data found for this client path');
            return { 
              success: false, 
              error: 'No authentication data available. Please authenticate first in the Settings tab.' 
            };
          }
        } catch (authError) {
          console.error('❌ Failed to load authentication data:', authError.message);
          return { 
            success: false, 
            error: 'Failed to load authentication data. Please re-authenticate in the Settings tab.' 
          };
        }

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
          maxMemory,
          showDebugTerminal
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
    },      'minecraft-check-mods': async (_e, { clientPath, requiredMods, allClientMods = [], serverManagedFiles = [] }) => {
      
      try {
        if (!clientPath || !requiredMods || !Array.isArray(requiredMods)) {
          return { success: false, error: 'Invalid parameters' };
        }        // Guard against incomplete server data - if serverManagedFiles has content but requiredMods is empty,
        // it likely means the server data isn't fully loaded yet
        // BUT: Only apply this guard if we also don't have a proper persistent state from storage.
        // If we have persistent state, then empty server data might mean mods were actually deleted.
        const earlyStateResult = await loadExpectedModState(clientPath, win);
        const hasPersistedState = earlyStateResult.success && (earlyStateResult.requiredMods.size > 0 || earlyStateResult.optionalMods.size > 0);
        
        if (serverManagedFiles.length > 0 && requiredMods.length === 0 && allClientMods.length === 0 && !hasPersistedState) {
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
            needsDownload: requiredMods.length,
            presentEnabledMods: [],
            presentDisabledMods: []
          };
        }
        
        const presentMods = fs
          .readdirSync(modsDir)
          .filter(file => file.toLowerCase().endsWith('.jar'));
        const disabledMods = fs
          .readdirSync(modsDir)
          .filter(file => file.toLowerCase().endsWith('.jar.disabled'))
          .map(file => file.replace('.disabled', ''));        const missingMods = [];
        const outdatedMods = [];
        const missingOptionalMods = [];
        const outdatedOptionalMods = [];
          for (const requiredMod of requiredMods) {
          const modPath = path.join(modsDir, requiredMod.fileName);
          const isPresent =
            presentMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase()) ||
            disabledMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase());
          
          if (!isPresent) {
            missingMods.push(requiredMod.fileName);          } else if (requiredMod.checksum) {
            // Find the actual filename on disk (case-insensitive)
            const actualFileName = presentMods.find(f => f.toLowerCase() === requiredMod.fileName.toLowerCase()) ||
                                   disabledMods.find(f => f.toLowerCase() === requiredMod.fileName.toLowerCase());
            
            const actualModPath = actualFileName 
              ? path.join(modsDir, actualFileName + (disabledMods.includes(actualFileName) ? '.disabled' : ''))
              : (presentMods.some(f => f.toLowerCase() === requiredMod.fileName.toLowerCase())
                ? modPath
                : modPath + '.disabled');
            
            const existingChecksum = utils.calculateFileChecksum(actualModPath);
            if (existingChecksum !== requiredMod.checksum) {
              // Extract mod name from JAR for better display              // Extract mod name and version with fallback methods
              let modName = requiredMod.fileName.replace(/\.jar$/i, '');
              let currentVersion = 'Unknown';
              
              // Try JAR metadata extraction first
              try {
                if (fs.existsSync(actualModPath)) {
                  const metadata = await modAnalysisUtils.extractDependenciesFromJar(actualModPath);
                  if (metadata?.name) {
                    modName = metadata.name;
                  }
                  if (metadata?.version) {
                    currentVersion = metadata.version;
                  }
                }
              } catch {
                // JAR extraction failed
              }
              
              // If version still unknown, try extracting from actual filename
              if (currentVersion === 'Unknown' && actualFileName) {
                const versionFromActual = extractVersionFromFilename(actualFileName);
                if (versionFromActual) {
                  currentVersion = versionFromActual;
                }
              }
              
              const newVersion = extractVersionFromFilename(requiredMod.fileName) || requiredMod.versionNumber || 'New Version';
              
              outdatedMods.push({
                fileName: requiredMod.fileName,
                name: modName,
                currentVersion,
                newVersion
              });
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
              missingOptionalMods.push(optionalMod.fileName);            } else if (optionalMod.checksum) {
              // Find the actual filename on disk (case-insensitive)
              const actualFileName = presentMods.find(f => f.toLowerCase() === optionalMod.fileName.toLowerCase()) ||
                                     disabledMods.find(f => f.toLowerCase() === optionalMod.fileName.toLowerCase());
              
              const actualModPath = actualFileName 
                ? path.join(modsDir, actualFileName + (disabledMods.includes(actualFileName) ? '.disabled' : ''))
                : (presentMods.some(f => f.toLowerCase() === optionalMod.fileName.toLowerCase())
                  ? modPath
                  : modPath + '.disabled');
              
              const existingChecksum = utils.calculateFileChecksum(actualModPath);
              if (existingChecksum !== optionalMod.checksum) {                // Extract mod name and version with fallback methods
                let modName = optionalMod.fileName.replace(/\.jar$/i, '');
                let currentVersion = 'Unknown';
                
                // Try JAR metadata extraction first
                try {
                  if (fs.existsSync(actualModPath)) {
                    const metadata = await modAnalysisUtils.extractDependenciesFromJar(actualModPath);
                    if (metadata?.name) {
                      modName = metadata.name;
                    }
                    if (metadata?.version) {
                      currentVersion = metadata.version;
                    }
                  }
                } catch {
                  // JAR extraction failed
                }
                
                // If version still unknown, try extracting from actual filename
                if (currentVersion === 'Unknown' && actualFileName) {
                  const versionFromActual = extractVersionFromFilename(actualFileName);
                  if (versionFromActual) {
                    currentVersion = versionFromActual;
                  }
                }
                
                const newVersion = extractVersionFromFilename(optionalMod.fileName) || optionalMod.versionNumber || 'New Version';
                
                outdatedOptionalMods.push({
                  fileName: optionalMod.fileName,
                  name: modName,
                  currentVersion,
                  newVersion
                });
              }
            }
          }
        }
    
        const clientModChanges = {
          updates: [],
          removals: [],
          newDownloads: []        };
        
        // Load persistent state
        const stateResult = await loadExpectedModState(clientPath, win);
        const previousServerRequiredModListFromStorage = stateResult.requiredMods; // Set of previously *required* mod filenames
        let acknowledgedDependencies = stateResult.acknowledgedDeps;
        
        // **CLEANUP**: Remove optional mods that were incorrectly stored as "required mods"
        // This fixes legacy state where optional mods were wrongly added to persistent state
        const actualRequiredMods = new Set(requiredMods.map(m => m.fileName.toLowerCase()));
        const correctedExpectedMods = new Set();
        // Legacy state handling - removed needsStateCleanup logic
        
        for (const mod of previousServerRequiredModListFromStorage) {
          if (actualRequiredMods.has(mod)) {            // This is actually a required mod, keep it
            correctedExpectedMods.add(mod);
          } else {
            // This was incorrectly stored as required, remove it
            // Legacy cleanup - no longer needed
          }
        }        // Don't do cleanup here - we need the original state for removal detection
          // Use the ORIGINAL expected mods for the removal detection logic
        // This ensures we can detect when previously required mods are removed
        const cleanedPreviousServerRequiredModListFromStorage = previousServerRequiredModListFromStorage;
        
        // We'll clean up the state AFTER removal detection is complete        // Current server *required* mods (what the server currently *requires*)
        const newServerRequiredModList = new Set(
          requiredMods.map(m => m.fileName.toLowerCase())
        );// Check if server *required* mod list has changed
        let serverRequiredModsActuallyChanged = false;
        if (cleanedPreviousServerRequiredModListFromStorage.size !== newServerRequiredModList.size) {
            serverRequiredModsActuallyChanged = true;
        } else {
            for (const mod of newServerRequiredModList) {
                if (!cleanedPreviousServerRequiredModListFromStorage.has(mod)) {
                    serverRequiredModsActuallyChanged = true;
                    break;
                }
            }
            if (!serverRequiredModsActuallyChanged) {
                for (const mod of cleanedPreviousServerRequiredModListFromStorage) {
                    if (!newServerRequiredModList.has(mod)) {
                        serverRequiredModsActuallyChanged = true;
                        break;
                    }
                }
            }        }
        
        // Log mod check summary (essential)
    
        
        if (serverRequiredModsActuallyChanged) {
          // Instead of clearing all acknowledgments, only clear those for mods that are now back on the server as required
          // This prevents acknowledged dependencies from being re-prompted when server state changes
          
          const updatedAcks = new Set();
          for (const ack of acknowledgedDependencies) {
            const ackLower = ack.toLowerCase();
            const baseAckName = getBaseModName(ack).toLowerCase();
            
            // Only clear acknowledgment if this mod is now back on the server as required
            const isNowRequiredByServer = newServerRequiredModList.has(ackLower) || newServerRequiredModList.has(baseAckName);
            
            if (!isNowRequiredByServer) {
              // Keep this acknowledgment - the mod is still not required by server
              updatedAcks.add(ack);
            }
          }
          
          acknowledgedDependencies = updatedAcks;
        }        // serverManagedFilesSet should represent what was *previously* considered server-managed for removal detection.
        // If bootstrapping, it might be the current server list, otherwise, it's the stored expected (required) list.
        let serverManagedFilesSetForDiff = new Set(
          (serverManagedFiles || []).map(f => f.toLowerCase())
        );
        
        if (
          serverManagedFilesSetForDiff.size === 0 &&
          cleanedPreviousServerRequiredModListFromStorage.size > 0
        ) {
          serverManagedFilesSetForDiff = new Set(
            cleanedPreviousServerRequiredModListFromStorage
          );
        } else if (
          serverManagedFilesSetForDiff.size === 0 &&
          newServerRequiredModList.size > 0
        ) {
          serverManagedFilesSetForDiff = new Set(newServerRequiredModList);        } else if (
          serverManagedFilesSetForDiff.size > 0 &&
          cleanedPreviousServerRequiredModListFromStorage.size > 0
        ) {
          // Merge previous required mods with current server managed set so that
          // optional mods remain tracked while still detecting removals of old
          // required mods.
          cleanedPreviousServerRequiredModListFromStorage.forEach(mod =>
            serverManagedFilesSetForDiff.add(mod)
          );
        }        // Reconcile acknowledged dependencies with current server-managed mods.
        // Clear acknowledgments for mods that are now managed by the server (required OR optional)
        // This allows them to show acknowledgment buttons again if they're later deleted
        if (acknowledgedDependencies && acknowledgedDependencies.size > 0) {
          const updatedAcks = new Set();
          
          // Get current optional mods from allClientMods
          const currentOptionalMods = new Set(
            (allClientMods || []).filter(m => !m.required).map(m => m.fileName.toLowerCase())
          );
          
          for (const dep of acknowledgedDependencies) {
            const lower = dep.toLowerCase();
            const baseDepName = getBaseModName(dep).toLowerCase();
            
            // Check if this mod is now managed by the server (required OR optional)
            const isNowRequiredByServer = newServerRequiredModList.has(lower) || newServerRequiredModList.has(baseDepName);
            const isNowOptionalByServer = currentOptionalMods.has(lower) || currentOptionalMods.has(baseDepName);
            const isNowManagedByServer = isNowRequiredByServer || isNowOptionalByServer;
            
            if (isNowManagedByServer) {
              // Clear acknowledgment - mod is now managed by server (required or optional)
              // This allows it to show acknowledgment button again if deleted from server
            } else {
              // Keep this acknowledgment - mod is still client-only
              updatedAcks.add(lower);
              // Keep acknowledged mods in serverManagedFilesSetForDiff for tracking
              serverManagedFilesSetForDiff.add(lower);
            }
          }          acknowledgedDependencies = updatedAcks;
        }const clientSideDependencies = await getClientSideDependencies(clientPath, Array.from(serverManagedFilesSetForDiff));
          const buildClientSideModsFor = async (excludeFile) => {
          if (!fs.existsSync(modsDir)) return [];
          
          const modFiles = fs.readdirSync(modsDir).filter(file => 
            file.toLowerCase().endsWith('.jar') && !file.toLowerCase().endsWith('.jar.disabled')
          );
          
          const lowerExclude = excludeFile.toLowerCase();
          const dependentMods = [];
          
          // Get client-side mods (exclude server-managed ones)
          const clientSideMods = modFiles.filter(f => {
            const lf = f.toLowerCase();
            return !serverManagedFilesSetForDiff.has(lf) && lf !== lowerExclude;
          });
  
          
          // Check each client mod to see if it actually depends on the excluded file
          for (const modFile of clientSideMods) {
            const modPath = path.join(modsDir, modFile);
              try {
              const metadata = await modAnalysisUtils.extractDependenciesFromJar(modPath);
              const modDependencies = new Set();
              
              if (metadata) {
                // Extract dependencies using the same logic as getClientSideDependencies
                if (metadata.dependencies && Array.isArray(metadata.dependencies)) {
                  for (const dep of metadata.dependencies) {
                    if (typeof dep === 'object' && dep.modid) {
                      modDependencies.add(dep.modid.toLowerCase());
                    } else if (typeof dep === 'string') {
                      modDependencies.add(dep.toLowerCase());
                    }
                  }
                } else if (metadata.dependencies && typeof metadata.dependencies === 'object') {
                  for (const depName of Object.keys(metadata.dependencies)) {
                    modDependencies.add(depName.toLowerCase());
                  }
                }
                
                if (metadata.depends && typeof metadata.depends === 'object') {
                  for (const depName of Object.keys(metadata.depends)) {
                    if (!['minecraft', 'fabricloader', 'java'].includes(depName.toLowerCase())) {
                      modDependencies.add(depName.toLowerCase());
                    }
                  }
                } else if (metadata.depends && Array.isArray(metadata.depends)) {
                  for (const dep of metadata.depends) {
                    if (typeof dep === 'string') {
                      modDependencies.add(dep.toLowerCase());
                    } else if (typeof dep === 'object' && dep.modid) {
                      modDependencies.add(dep.modid.toLowerCase());
                    }
                  }
                }
                
                if (metadata.requires && Array.isArray(metadata.requires)) {
                  for (const dep of metadata.requires) {
                    if (typeof dep === 'string') {
                      modDependencies.add(dep.toLowerCase());
                    } else if (typeof dep === 'object' && dep.modid) {
                      modDependencies.add(dep.modid.toLowerCase());
                    }
                  }
                }
                
                // Check embedded jars
                if (metadata.jars && Array.isArray(metadata.jars)) {
                  for (const jar of metadata.jars) {
                    if (typeof jar === 'object' && jar.file) {
                      const jarFile = jar.file.split('/').pop();
                      const jarName = jarFile.replace(/\.jar$/i, '').toLowerCase();
                      const cleanJarName = jarName.replace(/[-_]\d+.*$/, '');
                      const modIdFromJar = cleanJarName.replace(/[-_]/g, '');
                      
                      modDependencies.add(jarName);
                      modDependencies.add(cleanJarName);
                      modDependencies.add(modIdFromJar);
                      
                      if (jarName.includes('placeholder') && jarName.includes('api')) {
                        modDependencies.add('placeholder-api');
                        modDependencies.add('placeholderapi');
                        modDependencies.add('text-placeholder-api');
                        modDependencies.add('textplaceholderapi');
                      }
                    }
                  }
                }
              }
              
              // Check if this mod depends on the excluded file
              const excludeLower = excludeFile.toLowerCase();
              const excludeBase = getBaseModName(excludeFile).toLowerCase();
              
              const dependsOnExcluded = modDependencies.has(excludeLower) ||
                                      modDependencies.has(excludeBase) ||
                                      modDependencies.has(excludeLower.replace(/\.jar$/, '')) ||
                                      modDependencies.has(excludeBase.replace(/[-_]/g, '')) ||
                                      checkModDependencyByFilename(excludeFile, modDependencies);
  
              
              if (dependsOnExcluded) {
                dependentMods.push(modFile);
              }
              
            } catch (error) {
              console.warn(`Failed to analyze ${modFile}:`, error.message);
            }
          }
          

          return dependentMods;
        };

        const formatReason = (dependents) => {
          if (dependents.length === 0) return null;
          const names = dependents.map(f => f.replace(/\.jar$/i,''));
          if (names.length === 1) return `required as dependency by ${names[0]}`;
          if (names.length === 2) return `required as dependency by ${names[0]} and ${names[1]}`;
          return `required as dependency by ${names[0]}, ${names[1]} and ${names.length-2} other mod${names.length-2 > 1 ? 's' : ''}`;
        };
          const allCurrentMods = new Set();        if (fs.existsSync(modsDir)) {
          fs.readdirSync(modsDir).filter(f => f.toLowerCase().endsWith('.jar')).forEach(f => allCurrentMods.add(f.toLowerCase()));
          fs.readdirSync(modsDir).filter(f => f.toLowerCase().endsWith('.jar.disabled')).forEach(f => allCurrentMods.add(f.replace('.disabled', '').toLowerCase()));
        }
        
        // Logic for determining removals and acknowledgments
        // ===== NEW SIMPLIFIED REMOVAL DETECTION LOGIC =====
        
        // Build current server mod sets
        const currRequired = new Set(requiredMods.map(m => m.fileName.toLowerCase()));
        const currOptional = new Set(
          (allClientMods || []).filter(m => !m.required).map(m => m.fileName.toLowerCase())
        );

        
        // Get previous state
        const prevRequired = stateResult.requiredMods;
        const prevOptional = stateResult.optionalMods;        // Phase 1: Detect required mod removals
        const removedRequired = Array.from(prevRequired).filter(f => {
          const fLower = f.toLowerCase();
          return !currRequired.has(fLower) && allCurrentMods.has(fLower);
        });
        
        // Phase 2: Detect optional mod removals  
        const removedOptional = Array.from(prevOptional).filter(f => {
          const fLower = f.toLowerCase();
          return !currOptional.has(fLower) && allCurrentMods.has(fLower);
        });        
        
        // Initialize response arrays
        const requiredRemovals = [];
        const optionalRemovals = [];
        const acknowledgments = [];        // Process required removals
        for (const modFileName of removedRequired) {
          const modLower = modFileName.toLowerCase();
          const baseModName = getBaseModName(modFileName).toLowerCase();
          
          // Skip if this mod is now optional - it should only appear in optional section
          const isNowOptional = currOptional.has(modLower);
          if (isNowOptional) {
            continue; // Let the optional section handle this mod
          }
          
          // Check if needed by client-side mods
          const hasModLower = clientSideDependencies.has(modLower);
          const hasBaseModName = clientSideDependencies.has(baseModName);
          const hasFabricApiCheck = (modLower.includes('fabric') && modLower.includes('api') && 
                                   (clientSideDependencies.has('fabric-api') || clientSideDependencies.has('fabricapi') || clientSideDependencies.has('fabric_api')));          const hasFilenameCheck = checkModDependencyByFilename(modLower, clientSideDependencies);
          
          const isNeededByClientMod = hasModLower || hasBaseModName || hasFabricApiCheck || hasFilenameCheck;
          
          // Check if already acknowledged
          const isAlreadyAcknowledged = acknowledgedDependencies.has(modLower) || acknowledgedDependencies.has(baseModName);
          
          if (!isNeededByClientMod) {
            // Can be removed safely
            requiredRemovals.push({
              fileName: modFileName,
              reason: 'no longer required by server'
            });          } else if (isAlreadyAcknowledged) {
            // Still needed but already acknowledged - just keep it tracked, no acknowledgment needed
          } else {
            // Need acknowledgment due to client dependencies
            const dependents = await buildClientSideModsFor(modFileName);
            const reason = formatReason(dependents) || 'required as dependency by client downloaded mods';
            acknowledgments.push({
              fileName: modFileName,
              reason: reason
            });
          }
        }        // Process optional removals
        for (const modFileName of removedOptional) {
          const modLower = modFileName.toLowerCase();
          const baseModName = getBaseModName(modFileName).toLowerCase();
          
          // Check if needed by client-side mods (same logic as required mods)
          const hasModLower = clientSideDependencies.has(modLower);
          const hasBaseModName = clientSideDependencies.has(baseModName);
          const hasFabricApiCheck = (modLower.includes('fabric') && modLower.includes('api') && 
                                   (clientSideDependencies.has('fabric-api') || clientSideDependencies.has('fabricapi') || clientSideDependencies.has('fabric_api')));          const hasFilenameCheck = checkModDependencyByFilename(modLower, clientSideDependencies);
          
          const isNeededByClientMod = hasModLower || hasBaseModName || hasFabricApiCheck || hasFilenameCheck;
          
          // Check if already acknowledged
          const isAlreadyAcknowledged = acknowledgedDependencies.has(modLower) || acknowledgedDependencies.has(baseModName);
          
          if (!isNeededByClientMod) {
            // Can be removed safely
            optionalRemovals.push({
              fileName: modFileName,
              reason: 'no longer provided by server'
            });
          } else if (isAlreadyAcknowledged) {
            // Still needed but already acknowledged - just keep it tracked, no acknowledgment needed
            // The mod should still appear in the UI but without the acknowledgment button
          } else {
            // Need acknowledgment due to client dependencies (even for optional mods)
            const dependents = await buildClientSideModsFor(modFileName);
            const reason = formatReason(dependents) || 'required as dependency by client downloaded mods';
            acknowledgments.push({
              fileName: modFileName,
              reason: reason
            });
          }
        }
        
        // Additional check: Handle mods that were previously required but are now optional
        // These should also be checked for acknowledgment in the optional section
        for (const modFileName of removedRequired) {
          const modLower = modFileName.toLowerCase();
          const baseModName = getBaseModName(modFileName).toLowerCase();
          
          // Only process if this mod is now optional and wasn't already processed above
          const isNowOptional = currOptional.has(modLower);
          if (!isNowOptional) continue;
          
          // Skip if already acknowledged
          const isAlreadyAcknowledged = acknowledgedDependencies.has(modLower) || acknowledgedDependencies.has(baseModName);
          if (isAlreadyAcknowledged) {
            continue;
          }
          
          // Check if needed by client-side mods
          const hasModLower = clientSideDependencies.has(modLower);
          const hasBaseModName = clientSideDependencies.has(baseModName);
          const hasFabricApiCheck = (modLower.includes('fabric') && modLower.includes('api') && 
                                   (clientSideDependencies.has('fabric-api') || clientSideDependencies.has('fabricapi') || clientSideDependencies.has('fabric_api')));          const hasFilenameCheck = checkModDependencyByFilename(modLower, clientSideDependencies);
          
          const isNeededByClientMod = hasModLower || hasBaseModName || hasFabricApiCheck || hasFilenameCheck;
          
          if (isNeededByClientMod) {
            // Need acknowledgment due to client dependencies
            const dependents = await buildClientSideModsFor(modFileName);
            const reason = formatReason(dependents) || 'required as dependency by client downloaded mods';
            acknowledgments.push({
              fileName: modFileName,
              reason: reason
            });
          }        }
        // ===== END SIMPLIFIED REMOVAL DETECTION LOGIC =====
          // Module analysis for updates - Track which mods need updates vs new downloads
        // Use the already imported modAnalysisUtils from the top of the file
        const allPresentMods = [...presentMods, ...disabledMods];
        const allServerManagedFiles = new Set([
            ...(serverManagedFiles || []).map(f => f.toLowerCase()),
            ...requiredMods.map(rm => rm.fileName.toLowerCase()),
            ...(allClientMods || []).filter(m => m.required).map(m => m.fileName.toLowerCase())
          ]);
        
        // Track mods that need updates (have newer versions available)
        const modsNeedingUpdates = new Map(); // modFileName -> { currentVersion, newVersion, serverMod }
        
        for (const modFileName of allPresentMods) {
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
              
              return false;
            }) : null;

            if (exactServerMatch || similarServerMatch) {
              const matchedServerMod = exactServerMatch || similarServerMatch;
              const serverVersion = extractVersionFromFilename(matchedServerMod.fileName) || matchedServerMod.versionNumber || 'Server Version';
              const currentVersion = clientModMetadata.version || 'Unknown';
              
              // Store update info for this mod
              modsNeedingUpdates.set(modFileName, {
                currentVersion,
                newVersion: serverVersion,
                serverMod: matchedServerMod
              });
              
              clientModChanges.updates.push({
                fileName: modFileName,
                name: clientModMetadata.name || modFileName,
                currentVersion: currentVersion,
                serverVersion: serverVersion,
                action: 'update'
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
          }        }        // Track extra mods - these were handled above in the simplified removal logic
        const successfullyRemovedMods = [];

          // finalUpdatedServerManagedFiles should accurately reflect the current server\'s *required* mods.
          // Acknowledged dependencies that are NOT on the current server list should not be included.
          // const finalUpdatedServerManagedFiles = Array.from(newServerRequiredModList);          // Clean up expected state: remove mods that no longer exist on disk
        // This prevents phantom removal requests for already-deleted files
        const modsToRemoveFromState = [];
        for (const expectedMod of cleanedPreviousServerRequiredModListFromStorage) {
          if (!allCurrentMods.has(expectedMod.toLowerCase()) && 
              !newServerRequiredModList.has(expectedMod.toLowerCase())) {
            modsToRemoveFromState.push(expectedMod);
          }
        }
        
        // Also clean up optional mods that no longer exist on disk
        const optionalModsToRemoveFromState = [];
        for (const expectedMod of prevOptional) {
          if (!allCurrentMods.has(expectedMod.toLowerCase()) && 
              !currOptional.has(expectedMod.toLowerCase())) {
            optionalModsToRemoveFromState.push(expectedMod);
          }
        }
          // Clean up acknowledged dependencies for non-existent mods
        const acknowledgedToClean = [];
        for (const ack of acknowledgedDependencies) {
          if (!allCurrentMods.has(ack.toLowerCase())) {
            acknowledgedToClean.push(ack);
          }
        }
          // Remove non-existent mods from both sets
        if (modsToRemoveFromState.length > 0 || optionalModsToRemoveFromState.length > 0 || acknowledgedToClean.length > 0) {
          
          // Clean up expected mods (not needed here since we override the state below)
          // const cleanedExpectedMods = new Set(newServerRequiredModList);
          // for (const mod of modsToRemoveFromState) {
          //   cleanedExpectedMods.delete(mod.toLowerCase());
          // }
          
          // Clean up acknowledged dependencies
          const cleanedAcknowledged = new Set(acknowledgedDependencies);
          for (const ack of acknowledgedToClean) {
            cleanedAcknowledged.delete(ack);
          }
          
          // Update the sets for this check
          acknowledgedDependencies = cleanedAcknowledged;          
  
        }// Save the current state with simplified tracking
        try {
          // The key insight: we need to persist mods that are flagged for removal
          // until they're actually deleted from disk, so the UI can show them consistently
          
          // Build the sets to persist:
          // 1. Current server mods (what should be installed)
          // 2. Plus mods that are flagged for removal (so they stay visible until deleted)
          
          const requiredToSave = new Set(currRequired);
          const optionalToSave = new Set(currOptional);
            // Add mods flagged for removal back to the expected state
          // This ensures they remain visible in the UI until actually deleted
          // But exclude mods that have been cleaned up (no longer exist on disk)
          const removedModsToExclude = new Set([
            ...modsToRemoveFromState.map(m => m.toLowerCase()),
            ...optionalModsToRemoveFromState.map(m => m.toLowerCase())
          ]);
          
          for (const removal of requiredRemovals) {
            if (!removedModsToExclude.has(removal.fileName.toLowerCase())) {
              requiredToSave.add(removal.fileName);
            }
          }
          for (const removal of optionalRemovals) {
            if (!removedModsToExclude.has(removal.fileName.toLowerCase())) {
              optionalToSave.add(removal.fileName);
            }          }          for (const ack of acknowledgments) {
            // Save acknowledgments in the correct category
            if (!removedModsToExclude.has(ack.fileName.toLowerCase())) {
              const ackLower = ack.fileName.toLowerCase();
              
              // Check if this mod is currently in the server's required or optional list
              const isCurrentlyRequired = currRequired.has(ackLower);
              const isCurrentlyOptional = currOptional.has(ackLower);
              
              if (isCurrentlyRequired) {
                requiredToSave.add(ack.fileName);
              } else if (isCurrentlyOptional) {
                optionalToSave.add(ack.fileName);
              } else {
                // Mod is not currently provided by server, but needs acknowledgment
                // Determine where it came from by checking previous state
                const wasRequired = prevRequired.has(ackLower);
                const wasOptional = prevOptional.has(ackLower);
                
                if (wasRequired) {
                  // It was previously required, save as required for acknowledgment
                  requiredToSave.add(ack.fileName);
                } else if (wasOptional) {
                  // It was previously optional, save as optional for acknowledgment
                  optionalToSave.add(ack.fileName);
                } else {
                  // Fallback: save as required (conservative approach)
                  requiredToSave.add(ack.fileName);
                }
              }
            }
          }
          
          // IMPORTANT: Also save acknowledged mods that are still needed (but don't need new acknowledgment)
          // This ensures they remain visible in the UI even though they don't have acknowledgment buttons
          for (const removedMod of [...removedRequired, ...removedOptional]) {
            const modLower = removedMod.toLowerCase();
            const baseModName = getBaseModName(removedMod).toLowerCase();
            
            // Check if this mod is already being saved via acknowledgments
            const alreadyBeingSaved = 
              Array.from(requiredToSave).some(m => m.toLowerCase() === modLower) ||
              Array.from(optionalToSave).some(m => m.toLowerCase() === modLower);
              
            if (alreadyBeingSaved) continue;
            
            // Check if it's acknowledged and still needed
            const isAlreadyAcknowledged = acknowledgedDependencies.has(modLower) || acknowledgedDependencies.has(baseModName);
            
            if (isAlreadyAcknowledged) {
              // Check if still needed by client dependencies
              const hasModLower = clientSideDependencies.has(modLower);
              const hasBaseModName = clientSideDependencies.has(baseModName);
              const hasFabricApiCheck = (modLower.includes('fabric') && modLower.includes('api') && 
                                       (clientSideDependencies.has('fabric-api') || clientSideDependencies.has('fabricapi') || clientSideDependencies.has('fabric_api')));
              const hasFilenameCheck = checkModDependencyByFilename(modLower, clientSideDependencies);
              
              const isStillNeeded = hasModLower || hasBaseModName || hasFabricApiCheck || hasFilenameCheck;
              
              if (isStillNeeded) {
                // Determine correct category based on previous state
                const wasRequired = prevRequired.has(modLower);
                const wasOptional = prevOptional.has(modLower);
                  if (wasRequired) {
                  requiredToSave.add(removedMod);
                } else if (wasOptional) {
                  optionalToSave.add(removedMod);
                }
              }
            }
          }          // await saveExpectedModState(clientPath, requiredToSave, optionalToSave, win, acknowledgedDependencies);
          await saveExpectedModState(clientPath, requiredToSave, optionalToSave, win, acknowledgedDependencies);

        } catch (stateError) {
          console.error('[IPC HANDLER] Failed to update persistent state:', stateError);
        }// log.info(`[IPC HANDLER] Removal arrays: Required=${requiredRemovals.length}, Optional=${optionalRemovals.length}, Acknowledgments=${acknowledgments.length}`);        // Determine overall sync status
      const synchronized = missingMods.length === 0 && outdatedMods.length === 0 && 
                             requiredRemovals.length === 0 && // No required mods need removal
                             optionalRemovals.length === 0 && // No optional mods need removal
                             acknowledgments.length === 0;    // No acknowledgments needed        // Final response summary (keep this one for debugging if needed)


        const result = {
          success: true,
          synchronized,
          // Separate missing vs outdated for better UI feedback
          missingMods: missingMods, // Truly missing mods (new downloads)
          outdatedMods: outdatedMods, // Mods that need updates
          missingOptionalMods: missingOptionalMods, // Missing optional mods (new downloads)
          outdatedOptionalMods: outdatedOptionalMods, // Optional mods that need updates          // Combined for backwards compatibility
          allMissingMods: missingMods.concat(outdatedMods.map(m => m.fileName || m)),
          allMissingOptionalMods: missingOptionalMods.concat(outdatedOptionalMods.map(m => m.fileName || m)),
          needsDownload: missingMods.length + outdatedMods.length,
          needsOptionalDownload: missingOptionalMods.length + outdatedOptionalMods.length,
          needsRemoval: requiredRemovals.length + optionalRemovals.length,
          totalRequired: requiredMods.length,
          totalOptional: (allClientMods || []).filter(m => !m.required).length,
          presentEnabledMods: presentMods, // Actually enabled mods (.jar files)
          presentDisabledMods: disabledMods, // Actually disabled mods (.jar.disabled files)
          // Update information for mods that need version updates
          modsNeedingUpdates: Array.from(modsNeedingUpdates.entries()).map(([fileName, info]) => ({
            fileName,
            currentVersion: info.currentVersion,
            newVersion: info.newVersion,
            serverMod: info.serverMod
          })),
          // New response structure
          requiredRemovals,
          optionalRemovals,
          acknowledgments,
          // Legacy compatibility (remove in future version)
          clientModChanges,
          successfullyRemovedMods // Should be empty
        };
          
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

    'minecraft-clear-client-full': async (_e, { clientPath, minecraftVersion }) => {
      try {
        const result = await launcher.clearMinecraftClientFull(clientPath, minecraftVersion);
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
          }        }
        
        return { success: true, removed };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    
    'minecraft-remove-server-managed-mods': async (_e, { clientPath, modsToRemove = [] }) => {
      try {
        
        if (!clientPath || !Array.isArray(modsToRemove) || modsToRemove.length === 0) {
          return { success: false, error: 'Client path and mods to remove are required' };
        }

        const modsDir = path.join(clientPath, 'mods');
        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
        const successfullyRemovedMods = [];

        if (!fs.existsSync(modsDir)) {
          return { success: true, removed: [] };
        }        for (const modFileName of modsToRemove) {
          try {            

            
            // Handle case sensitivity by checking all files in the directory
            const allFiles = fs.readdirSync(modsDir);
            const targetFile = allFiles.find(file => 
              file.toLowerCase() === modFileName.toLowerCase() || 
              file.toLowerCase() === (modFileName + '.disabled').toLowerCase()
            );
            
            let removed = false;
            if (targetFile) {
              const actualPath = path.join(modsDir, targetFile);

              fs.unlinkSync(actualPath);
              removed = true;

            } else {

              // If the file doesn't exist, consider it successfully "removed"
              removed = true;
            }
            
            if (removed) {
              // Remove the corresponding manifest file
              const manifestPath = path.join(manifestDir, modFileName.replace(/\.jar$/i, '') + '.json');
              if (fs.existsSync(manifestPath)) {
                fs.unlinkSync(manifestPath);

              }
                successfullyRemovedMods.push(modFileName);
            }
          } catch (error) {
            console.error(`Failed to remove mod ${modFileName}:`, error);
            // For file not found errors, still consider it successfully removed
            if (error.code === 'ENOENT') {

              successfullyRemovedMods.push(modFileName);
            }
            // Continue with other mods even if one fails
          }
        }// Update persistent state after successful removal
        if (successfullyRemovedMods.length > 0) {
          try {
            const loadResult = await loadExpectedModState(clientPath, win);            if (loadResult.success) {
              const requiredMods = loadResult.requiredMods;
              const acknowledgedDeps = loadResult.acknowledgedDeps;
              const optionalMods = loadResult.optionalMods;
              
              // Remove the successfully removed mods from expected state and acknowledgments
              for (const removedMod of successfullyRemovedMods) {
                const lowerMod = removedMod.toLowerCase();
                requiredMods.delete(lowerMod);
                acknowledgedDeps.delete(lowerMod);
                optionalMods.delete(lowerMod);
                
                // Also remove base mod name variant
                const baseModName = getBaseModName(removedMod).toLowerCase();
                requiredMods.delete(baseModName);
                acknowledgedDeps.delete(baseModName);
                optionalMods.delete(baseModName);
              }
              
              // Save updated state with cleaned acknowledgments
              await saveExpectedModState(clientPath, requiredMods, optionalMods, win, acknowledgedDeps);
              }
            } catch (stateError) {
              console.error('Failed to update persistent state after mod removal:', stateError);
              // Don't fail the removal operation just because state update failed
            }
          }          return {
            success: true,
            removed: successfullyRemovedMods,
            count: successfullyRemovedMods.length,
            message: successfullyRemovedMods.length > 0 ? 
              `Successfully removed ${successfullyRemovedMods.length} mod(s)` : 
              'No mods were found to remove (may have been already removed)'
          };
        } catch (error) {
          console.error('Error in minecraft-remove-server-managed-mods:', error);
          return { success: false, error: error.message };
      }
    },    'minecraft-acknowledge-dependency': async (_e, { clientPath, modFileName }) => {
      try {
        if (!clientPath || !modFileName) {
          return { success: false, error: 'Client path and mod file name are required' };
        }

        // Load current state
        const stateResult = await loadExpectedModState(clientPath, win);
        if (!stateResult.success) {
          return { success: false, error: 'Failed to load mod state' };
        }
          const requiredMods = new Set(stateResult.requiredMods);
        const optionalMods = new Set(stateResult.optionalMods);
        const acknowledgedDeps = stateResult.acknowledgedDeps || new Set();
        
        // Add the mod to acknowledged dependencies
        const baseModName = getBaseModName(modFileName).toLowerCase();
        const modLower = modFileName.toLowerCase();
        acknowledgedDeps.add(modLower);
        acknowledgedDeps.add(baseModName);
        
        // IMPORTANT: Remove the mod from server tracking so it becomes a client-only mod
        requiredMods.delete(modFileName);
        requiredMods.delete(modLower);
        requiredMods.delete(baseModName);
        
        optionalMods.delete(modFileName);
        optionalMods.delete(modLower);
        optionalMods.delete(baseModName);
        
        // Save updated state (mod is now acknowledged and removed from server tracking)
        await saveExpectedModState(clientPath, requiredMods, optionalMods, win, acknowledgedDeps);
        
        return { 
          success: true,
          removedFromServerTracking: true // Signal that mod is now client-only
        };
      } catch (error) {
        console.error('Failed to acknowledge dependency:', error);
        return { success: false, error: error.message };
      }
    },
    
    'load-expected-mod-state': async (_e, { clientPath }) => {
      try {
        const stateResult = await loadExpectedModState(clientPath, win);        return {
          success: stateResult.success,
          requiredMods: Array.from(stateResult.requiredMods || []),
          optionalMods: Array.from(stateResult.optionalMods || []),
          acknowledgedDeps: Array.from(stateResult.acknowledgedDeps || []),
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
        return await clearExpectedModState(clientPath);      } catch (error) {
        console.error('Failed to clear expected mod state:', error);
        return { success: false, error: error.message };
      }
    },
  };
}



module.exports = { createMinecraftLauncherHandlers, loadExpectedModState };
