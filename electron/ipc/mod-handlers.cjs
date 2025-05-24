// Mod management IPC handlers
const path = require('path');
const fs = require('fs/promises');
const { dialog, app } = require('electron');
const os = require('os');
const crypto = require('crypto');
const fetch = require('node-fetch');
const axios = require('axios');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);
const fsSync = require('fs');

// Simple store implementation to persist mod categories
const configDir = path.join(app.getPath('userData'), 'config');
const configFile = path.join(configDir, 'mod-categories.json');

// Create config directory if it doesn't exist
if (!fsSync.existsSync(configDir)) {
  fsSync.mkdirSync(configDir, { recursive: true });
}

// Simple store object to manage mod categories
const modCategoriesStore = {
  get: () => {
    try {
      if (fsSync.existsSync(configFile)) {
        const data = fsSync.readFileSync(configFile, 'utf8');
        return JSON.parse(data);
      }
      return [];
    } catch (error) {
      console.error('Error reading mod categories:', error);
      return [];
    }
  },
  set: (data) => {
    try {
      fsSync.writeFileSync(configFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('Error writing mod categories:', error);
      return false;
    }
  }
};

// Modrinth API base URL
const MODRINTH_API = 'https://api.modrinth.com/v2';

// Add a rate limiter utility
const RATE_LIMIT_MS = 500; // Delay between API requests
let lastRequestTime = 0;

/**
 * Simple rate limiter that ensures a minimum delay between API requests
 * @returns {Promise<void>} Resolves when it's safe to make another request
 */
async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  
  if (elapsed < RATE_LIMIT_MS && lastRequestTime > 0) {
    const delay = RATE_LIMIT_MS - elapsed;
    console.log(`[API] Rate limiting: Waiting ${delay}ms before next request`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  lastRequestTime = Date.now();
}

// Version cache to reduce API calls
const versionCache = new Map();

/**
 * Create mod management IPC handlers
 * 
 * @param {BrowserWindow} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createModHandlers(win) {
  return {
    // Select mod files using native dialog
    'select-mod-files': async () => {
      try {
        console.log('[IPC:Mods] Opening file dialog for mod selection');
        const result = await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Mod Files', extensions: ['jar'] }],
          title: 'Select Mod Files',
          defaultPath: app.getPath('downloads') // Start in downloads folder
        });
        
        if (result.canceled) {
          console.log('[IPC:Mods] File selection canceled');
          return [];
        }
        
        console.log('[IPC:Mods] Selected files:', result.filePaths);
        return result.filePaths;
      } catch (err) {
        console.error('[IPC:Mods] Error selecting mod files:', err);
        throw new Error(`Failed to select mod files: ${err.message}`);
      }
    },

    // Process dropped files to get their paths
    'get-dropped-file-paths': async (_event, fileIdentifiers) => {
      try {
        console.log('[IPC:Mods] Processing dropped files:', fileIdentifiers);
        
        if (!fileIdentifiers || !Array.isArray(fileIdentifiers) || !fileIdentifiers.length) {
          return [];
        }
        
        // Extract file paths from the dropped files
        const filePaths = fileIdentifiers
          .filter(file => file && file.path)
          .map(file => file.path);
          
        console.log('[IPC:Mods] Extracted file paths:', filePaths);
        
        return filePaths;
      } catch (err) {
        console.error('[IPC:Mods] Error processing dropped files:', err);
        throw new Error(`Failed to process dropped files: ${err.message}`);
      }
    },

    'list-mods': async (_event, serverPath) => {
      try {
        console.log('[IPC:Mods] Listing mods from:', serverPath);
        
        if (!serverPath) {
          throw new Error('Server path is required for listing mods');
        }
        
        // Verify server path exists
        try {
          await fs.access(serverPath);
        } catch (err) {
          throw new Error('Server directory does not exist or is inaccessible');
        }
        
        // Determine client path from server path
        // Instead of creating a parallel client directory, create it inside the server directory
        const clientPath = path.join(serverPath, 'client');
        
        console.log('[IPC:Mods] Server path:', serverPath);
        console.log('[IPC:Mods] Client path:', clientPath);
        
        const serverModsDir = path.join(serverPath, 'mods');
        const clientModsDir = path.join(clientPath, 'mods');
        const disabledModsDir = path.join(serverPath, 'mods_disabled');
        
        // Create all directories if they don't exist
        await fs.mkdir(serverModsDir, { recursive: true });
        await fs.mkdir(clientModsDir, { recursive: true }).catch(err => {
          console.warn('[IPC:Mods] Could not create client mods directory:', err);
        });
        await fs.mkdir(disabledModsDir, { recursive: true });
        
        // Get mods from server folder
        const serverFiles = await fs.readdir(serverModsDir);
        const serverModFiles = serverFiles.filter(file => file.endsWith('.jar'));
        
        // Get mods from client folder
        let clientModFiles = [];
        try {
          const clientFiles = await fs.readdir(clientModsDir);
          clientModFiles = clientFiles.filter(file => file.endsWith('.jar'));
        } catch (err) {
          console.warn('[IPC:Mods] Could not read client mods directory:', err);
        }
        
        // Get disabled mods
        const disabledFiles = await fs.readdir(disabledModsDir);
        const disabledModFiles = disabledFiles.filter(file => file.endsWith('.jar'));
        
        // Find mods that exist in both server and client directories
        const modsInBoth = serverModFiles.filter(mod => clientModFiles.includes(mod));
        
        // Find mods that only exist in server directory
        const serverOnlyMods = serverModFiles.filter(mod => !clientModFiles.includes(mod));
        
        // Find mods that only exist in client directory
        const clientOnlyMods = clientModFiles.filter(mod => !serverModFiles.includes(mod));
        
        // Create a result array with all mods and their locations
        const allMods = [
          // Server-only mods
          ...serverOnlyMods.map(mod => ({ 
            fileName: mod, 
            locations: ['server'], 
            category: 'server-only' 
          })),
          
          // Client-only mods
          ...clientOnlyMods.map(mod => ({ 
            fileName: mod, 
            locations: ['client'], 
            category: 'client-only' 
          })),
          
          // Mods in both locations
          ...modsInBoth.map(mod => ({ 
            fileName: mod, 
            locations: ['server', 'client'], 
            category: 'both' 
          })),
          
          // Disabled mods
          ...disabledModFiles.map(mod => ({ 
            fileName: mod, 
            locations: ['disabled'], 
            category: 'disabled' 
          }))
        ];
        
        // Create a flat list of all mod filenames for backward compatibility
        const allModFiles = [...new Set([
          ...serverModFiles, 
          ...clientModFiles,
          ...disabledModFiles
        ])];
        
        console.log('[IPC:Mods] Found mods:', allMods);
        console.log('[IPC:Mods] All mod filenames:', allModFiles);
        
        return {
          mods: allMods,
          modFiles: allModFiles, // Include plain filenames for backward compatibility
          serverPath,
          clientPath
        };
      } catch (err) {
        console.error('[IPC:Mods] Failed to list mods:', err);
        throw new Error(`Failed to list mods: ${err.message}`);
      }
    },

    'search-mods': async (_event, { keyword, loader, version, source, page = 1, limit = 20, sortBy = 'popular', environmentType = 'all' }) => {
      console.log('[IPC:Mods] Searching mods with:', { keyword, loader, version, source, page, limit, sortBy, environmentType });
      
      try {
        // Validate parameters
        if (!source || (source !== 'modrinth' && source !== 'curseforge')) {
          throw new Error('Invalid source. Must be "modrinth" or "curseforge"');
        }
        
        if (page !== undefined && (typeof page !== 'number' || page < 1)) {
          page = 1;
        }
        
        if (limit !== undefined && (typeof limit !== 'number' || limit < 1)) {
          limit = 20;
        }
        
        // Determine which source to use
        if (source === 'modrinth') {
          if (!keyword || keyword.trim() === '') {
            const result = await getModrinthPopular({ loader, version, page, limit, sortBy, environmentType });
            return {
              mods: result.mods,
              pagination: result.pagination
            };
          } else {
            const result = await searchModrinthMods({ query: keyword, loader, version, page, limit, sortBy, environmentType });
            return {
              mods: result.mods,
              pagination: result.pagination
            };
          }
        } else if (source === 'curseforge') {
          if (!keyword || keyword.trim() === '') {
            const result = await getCurseForgePopular({ loader, version, page, limit, environmentType });
            return {
              mods: result.mods,
              pagination: result.pagination
            };
          } else {
            const result = await searchCurseForgeMods({ query: keyword, loader, version, page, limit, environmentType });
            return {
              mods: result.mods,
              pagination: result.pagination
            };
          }
        } else {
          throw new Error(`Invalid source: ${source}`);
        }
      } catch (error) {
        console.error(`[IPC:Mods] Error searching ${source} mods:`, error);
        throw new Error(`Failed to search mods: ${error.message}`);
      }
    },

    'get-mod-versions': async (_event, { modId, loader, mcVersion, source, loadLatestOnly }) => {
      try {
        console.log(`[IPC:Mods] Getting versions for mod ${modId} (source: ${source}, loadLatestOnly: ${loadLatestOnly})`);
        
        if (!modId) {
          throw new Error('Mod ID is required');
        }
        
        if (!source || (source !== 'modrinth' && source !== 'curseforge')) {
          throw new Error('Invalid source. Must be "modrinth" or "curseforge"');
        }
        
        if (source === 'modrinth') {
          const versions = await getModrinthVersions(modId, loader, mcVersion, loadLatestOnly);
          return versions;
        } else {
          throw new Error('Only Modrinth version fetching is supported');
        }
      } catch (err) {
        console.error('[IPC:Mods] Failed to get mod versions:', err);
        throw new Error(`Failed to get mod versions: ${err.message}`);
      }
    },
    
    'get-version-info': async (_event, { modId, versionId, source }) => {
      try {
        console.log(`[IPC:Mods] Getting version info for mod ${modId}, version ${versionId} (source: ${source})`);
        
        if (source === 'modrinth') {
          const versionInfo = await getModrinthVersionInfo(modId, versionId);
          return versionInfo;
        } else {
          throw new Error('Only Modrinth version info is supported');
        }
      } catch (err) {
        console.error('[IPC:Mods] Failed to get version info:', err);
        throw new Error(`Failed to get version info: ${err.message}`);
      }
    },
    
    'get-installed-mod-info': async (_event, serverPath) => {
      try {
        console.log('[IPC:Mods] Getting installed mod info from:', serverPath);
        
        if (!serverPath) {
          throw new Error('Server path is required');
        }
        
        // Determine client path
        const clientPath = path.join(serverPath, 'client');
        
        const modsDir = path.join(serverPath, 'mods');
        const clientModsDir = path.join(clientPath, 'mods');
        await fs.mkdir(modsDir, { recursive: true });
        await fs.mkdir(clientModsDir, { recursive: true });
        
        // Include both enabled and disabled mods for manifest lookup
        const enabledFiles = await fs.readdir(modsDir);
        const enabledMods = enabledFiles.filter(file => file.endsWith('.jar'));
        
        // Get client mods
        let clientMods = [];
        try {
          const clientFiles = await fs.readdir(clientModsDir);
          clientMods = clientFiles.filter(file => file.endsWith('.jar'));
        } catch (err) {
          console.warn('[IPC:Mods] Could not read client mods:', err);
        }
        
        const disabledDir = path.join(serverPath, 'mods_disabled');
        await fs.mkdir(disabledDir, { recursive: true });
        const disabledFiles = (await fs.readdir(disabledDir).catch(() => [])).filter(file => file.endsWith('.jar'));
        
        // Combine all mod files (removing duplicates)
        const allModFiles = [...new Set([...enabledMods, ...clientMods, ...disabledFiles])];
        
        // Try to get mod info from both server and client manifest directories
        const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
        const clientManifestDir = path.join(clientPath, 'minecraft-core-manifests');
        let modInfo = [];
        
        try {
          await fs.mkdir(serverManifestDir, { recursive: true });
          await fs.mkdir(clientManifestDir, { recursive: true });
          
          // Read manifests from both server and client directories
          for (const modFile of allModFiles) {
            const serverManifestPath = path.join(serverManifestDir, `${modFile}.json`);
            const clientManifestPath = path.join(clientManifestDir, `${modFile}.json`);
            
            let manifest = null;
            
            // Try client manifest first (for client-only mods)
            try {
              const clientManifestContent = await fs.readFile(clientManifestPath, 'utf8');
              manifest = JSON.parse(clientManifestContent);
              console.log(`[IPC:Mods] Found client manifest for ${modFile}`);
            } catch (clientManifestErr) {
              // Try server manifest
              try {
                const serverManifestContent = await fs.readFile(serverManifestPath, 'utf8');
                manifest = JSON.parse(serverManifestContent);
                console.log(`[IPC:Mods] Found server manifest for ${modFile}`);
              } catch (serverManifestErr) {
                // Skip this mod if manifest can't be read from either location
                console.log(`[IPC:Mods] No manifest found for ${modFile} in either location`);
              }
            }
            
            if (manifest) {
              modInfo.push(manifest);
            }
          }
        } catch (manifestDirErr) {
          console.error('[IPC:Mods] Error accessing manifest directories:', manifestDirErr);
          // Continue with empty mod info
        }
        
        console.log(`[IPC:Mods] Found ${modInfo.length} mod manifests out of ${allModFiles.length} total mods`);
        return modInfo;
      } catch (err) {
        console.error('[IPC:Mods] Failed to get installed mod info:', err);
        throw new Error(`Failed to get installed mod info: ${err.message}`);
      }
    },

    'save-disabled-mods': async (_event, serverPath, disabledMods) => {
  try {
    console.log('[IPC:Mods] Saving disabled mods:', disabledMods);
    
    if (!serverPath) {
      throw new Error('Server path is required');
    }
    
    if (!Array.isArray(disabledMods)) {
      throw new Error('Disabled mods must be an array');
    }
    
    // Create a config directory if it doesn't exist
    const configDir = path.join(serverPath, 'minecraft-core-configs');
    await fs.mkdir(configDir, { recursive: true });
    
    // Save the disabled mods list to a JSON file
    const disabledModsPath = path.join(configDir, 'disabled-mods.json');
    await fs.writeFile(disabledModsPath, JSON.stringify(disabledMods, null, 2));
    
    // Set up directories
    const modsDir = path.join(serverPath, 'mods');
    const disabledModsDir = path.join(serverPath, 'mods_disabled');
    
    // Create directories if they don't exist
    await fs.mkdir(modsDir, { recursive: true });
    await fs.mkdir(disabledModsDir, { recursive: true });
    
    // Get current files
    const enabledFiles = await fs.readdir(modsDir);
    const disabledFiles = await fs.readdir(disabledModsDir);
    
    // Debug logging - what's in each folder
    console.log(`[IPC:Mods] Enabled mods directory (${modsDir}) contains:`, enabledFiles);
    console.log(`[IPC:Mods] Disabled mods directory (${disabledModsDir}) contains:`, disabledFiles);
    console.log(`[IPC:Mods] Disabled mods list contains:`, disabledMods);
    
    // Move mods to disabled folder if they are in the disabled list
    for (const modFile of enabledFiles) {
      if (modFile.endsWith('.jar') && disabledMods.includes(modFile)) {
        // This mod should be disabled - move it to the disabled folder
        const sourcePath = path.join(modsDir, modFile);
        const destPath = path.join(disabledModsDir, modFile);
        
        console.log(`[IPC:Mods] Disabling mod by moving: ${sourcePath} -> ${destPath}`);
        
        try {
          // Use copyFile and then unlink instead of rename for better cross-device compatibility
          await fs.copyFile(sourcePath, destPath);
          await fs.unlink(sourcePath);
          console.log(`[IPC:Mods] Successfully moved mod to disabled folder: ${modFile}`);
        } catch (moveErr) {
          console.error(`[IPC:Mods] Error moving mod to disabled folder: ${moveErr.message}`);
          throw new Error(`Failed to disable mod ${modFile}: ${moveErr.message}`);
        }
      }
    }
    
    // Move mods from disabled folder back to mods folder if they are not in the disabled list
    for (const modFile of disabledFiles) {
      if (modFile.endsWith('.jar') && !disabledMods.includes(modFile)) {
        // This mod should be enabled - move it back to the mods folder
        const sourcePath = path.join(disabledModsDir, modFile);
        const destPath = path.join(modsDir, modFile);
        
        console.log(`[IPC:Mods] Enabling mod by moving: ${sourcePath} -> ${destPath}`);
        
        try {
          // Use copyFile and then unlink instead of rename for better cross-device compatibility
          await fs.copyFile(sourcePath, destPath);
          await fs.unlink(sourcePath);
          console.log(`[IPC:Mods] Successfully moved mod back to enabled folder: ${modFile}`);
        } catch (moveErr) {
          console.error(`[IPC:Mods] Error moving mod from disabled folder: ${moveErr.message}`);
          throw new Error(`Failed to enable mod ${modFile}: ${moveErr.message}`);
        }
      }
    }
    
    // Verify the moves
    const newEnabledFiles = await fs.readdir(modsDir);
    const newDisabledFiles = await fs.readdir(disabledModsDir);
    console.log(`[IPC:Mods] After moves, enabled mods:`, newEnabledFiles);
    console.log(`[IPC:Mods] After moves, disabled mods:`, newDisabledFiles);
    
    console.log('[IPC:Mods] Disabled mods saved and physically moved');
    return true;
  } catch (err) {
    console.error('[IPC:Mods] Failed to save disabled mods:', err);
    throw new Error(`Failed to save disabled mods: ${err.message}`);
  }
},
    
    'get-disabled-mods': async (_event, serverPath) => {
      try {
        console.log('[IPC:Mods] Getting disabled mods from:', serverPath);
        
        if (!serverPath) {
          throw new Error('Server path is required');
        }
        
        // Set up directories
        const modsDir = path.join(serverPath, 'mods');
        const disabledModsDir = path.join(serverPath, 'mods_disabled');
        
        // Create directories if they don't exist
        await fs.mkdir(modsDir, { recursive: true });
        await fs.mkdir(disabledModsDir, { recursive: true });
        
        // Create a config directory if it doesn't exist
        const configDir = path.join(serverPath, 'minecraft-core-configs');
        await fs.mkdir(configDir, { recursive: true });
        
        // Load the disabled mods list from a JSON file
        const disabledModsPath = path.join(configDir, 'disabled-mods.json');
        
        let disabledMods = [];
        try {
          const disabledModsContent = await fs.readFile(disabledModsPath, 'utf8');
          disabledMods = JSON.parse(disabledModsContent);
          
          if (!Array.isArray(disabledMods)) {
            throw new Error('Invalid disabled mods format');
          }
        } catch (fileErr) {
          // If the file doesn't exist or can't be parsed, start with an empty array
          console.log('[IPC:Mods] No disabled mods config found or error reading file:', fileErr.message);
          disabledMods = [];
        }
        
            // Check for mods in the disabled folder
    try {
      const disabledFiles = await fs.readdir(disabledModsDir);
      const disabledModFiles = disabledFiles.filter(file => file.endsWith('.jar'));
      
      // Add any mods in the disabled folder to the list if they're not already there
      for (const modFile of disabledModFiles) {
        if (!disabledMods.includes(modFile)) {
          disabledMods.push(modFile);
        }
      }
      
      // Update the config file with the current state
      await fs.writeFile(disabledModsPath, JSON.stringify(disabledMods, null, 2));
    } catch (disabledFolderErr) {
      console.error('[IPC:Mods] Error checking disabled mods folder:', disabledFolderErr);
    }
    
    console.log('[IPC:Mods] Loaded disabled mods:', disabledMods);
    return disabledMods;
      } catch (err) {
        console.error('[IPC:Mods] Failed to get disabled mods:', err);
        throw new Error(`Failed to get disabled mods: ${err.message}`);
      }
    },

    'install-mod': async (_event, serverPath, modDetails) => {
      console.log('[IPC:Mods] Attempting to install mod:', modDetails.name, 'to server path:', serverPath);
      if (!serverPath) {
        console.error('[IPC:Mods] Server path is required for installing mods');
        return { success: false, error: 'Server path not provided' };
      }
      if (!modDetails || !modDetails.id || !modDetails.name) {
        console.error('[IPC:Mods] Mod details (id, name) are required');
        return { success: false, error: 'Invalid mod details' };
      }

      // Determine client path
      const clientPath = path.join(serverPath, 'client');
      const modsDir = path.join(serverPath, 'mods');
      const clientModsDir = path.join(clientPath, 'mods');
      await fs.mkdir(modsDir, { recursive: true }); // Ensure mods directory exists
      await fs.mkdir(clientModsDir, { recursive: true }); // Ensure client mods directory exists

      // Sanitize mod name to create a valid filename
      const fileName = modDetails.name.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.jar';
      
      // Check current mod location to preserve it during updates
      let currentModLocation = null;
      let destinationPath = path.join(modsDir, fileName); // Default to server
      
      if (modDetails.forceReinstall) {
        console.log('[IPC:Mods] Checking current mod location for version update...');
        
        const serverModPath = path.join(modsDir, fileName);
        const clientModPath = path.join(clientModsDir, fileName);
        
        const serverExists = await fs.access(serverModPath).then(() => true).catch(() => false);
        const clientExists = await fs.access(clientModPath).then(() => true).catch(() => false);
        
        console.log(`[IPC:Mods] Current mod locations - Server: ${serverExists}, Client: ${clientExists}`);
        
        // Determine current location and set destination accordingly
        if (clientExists && serverExists) {
          currentModLocation = 'both';
          console.log('[IPC:Mods] Mod currently exists in both locations, will update both');
        } else if (clientExists && !serverExists) {
          currentModLocation = 'client-only';
          destinationPath = clientModPath; // Install to client instead of server
          console.log('[IPC:Mods] Mod is currently client-only, will update client location');
        } else if (serverExists && !clientExists) {
          currentModLocation = 'server-only';
          console.log('[IPC:Mods] Mod is currently server-only, will update server location');
        }
      }
      
      const targetPath = destinationPath;
      
      // For version updates, we need to check for existing files and remove them
      if (modDetails.forceReinstall) {
        try {
          console.log('[IPC:Mods] Checking for existing mod files to replace...');
          
          // First, look for manifest files to find any existing versions
          const manifestDir = path.join(serverPath, 'minecraft-core-manifests');
          const manifestFiles = await fs.readdir(manifestDir).catch(() => []);
          
          // Find manifest files for this mod
          let existingFileName = null;
          for (const manifestFile of manifestFiles) {
            if (!manifestFile.endsWith('.json')) continue;
            
            try {
              const manifestPath = path.join(manifestDir, manifestFile);
              const manifestContent = await fs.readFile(manifestPath, 'utf8');
              const manifest = JSON.parse(manifestContent);
              
              // If this is the same mod by project ID, we need to remove the old file
              if (manifest.projectId === modDetails.id) {
                existingFileName = manifest.fileName;
                console.log(`[IPC:Mods] Found existing version of mod: ${existingFileName}`);
                
                // Remove the old mod file
                const oldFilePath = path.join(modsDir, existingFileName);
                await fs.unlink(oldFilePath).catch(() => {
                  console.log(`[IPC:Mods] Could not delete ${oldFilePath}, may not exist`);
                });
                
                // Remove old manifest
                await fs.unlink(manifestPath).catch(() => {
                  console.log(`[IPC:Mods] Could not delete manifest ${manifestPath}`);
                });
                
                break;
              }
            } catch (err) {
              console.error(`[IPC:Mods] Error parsing manifest ${manifestFile}:`, err);
            }
          }
          
          // If we didn't find a manifest but this is a version update,
          // we should still check for files that match the mod name pattern
          if (!existingFileName && modDetails.name) {
            const modFiles = await fs.readdir(modsDir);
            const possibleMatches = modFiles.filter(file => {
              // Simple check - filename starts with the mod name base (without extension)
              const baseName = modDetails.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
              return file.startsWith(baseName) && file.endsWith('.jar') && file !== fileName;
            });
            
            for (const match of possibleMatches) {
              console.log(`[IPC:Mods] Removing potential older version: ${match}`);
              await fs.unlink(path.join(modsDir, match)).catch(() => {});
            }
          }
        } catch (err) {
          console.error('[IPC:Mods] Error checking for existing mod files:', err);
          // Continue with installation, even if cleanup failed
        }
      }

      try {
        // Get the actual download URL based on the source
        let downloadUrl, versionInfo;
        if (modDetails.source === 'modrinth') {
          // If we have a specific version ID, use that
          if (modDetails.selectedVersionId) {
            versionInfo = await getModrinthVersionInfo(modDetails.id, modDetails.selectedVersionId);
            if (!versionInfo || !versionInfo.files || versionInfo.files.length === 0) {
              throw new Error('No files found for selected version');
            }
            downloadUrl = versionInfo.files[0].url;
          } else {
            // Otherwise get latest compatible version
            downloadUrl = await getModrinthDownloadUrl(modDetails.id, modDetails.version, modDetails.loader);
            // Also fetch version info for the manifest
            versionInfo = await getLatestModrinthVersionInfo(modDetails.id, modDetails.version, modDetails.loader);
          }
        } else if (modDetails.source === 'curseforge') {
          downloadUrl = await getCurseForgeDownloadUrl(modDetails.id, modDetails.version, modDetails.loader);
        } else {
          // If downloadUrl is already a direct URL, use it
          downloadUrl = modDetails.downloadUrl;
        }
        
        if (!downloadUrl) {
          throw new Error('Failed to get download URL for mod');
        }
        
        console.log(`[IPC:Mods] Downloading mod from ${downloadUrl} to ${targetPath}`);
        
        // Create a unique download ID
        const downloadId = `mod-${modDetails.id}-${Date.now()}`;
        
        // Send initial progress update
        if (win && win.webContents) {
          win.webContents.send('download-progress', {
            id: downloadId,
            name: modDetails.name,
            progress: 0,
            speed: 0,
            completed: false,
            error: null
          });
        }
        
        // Use axios to download the file with progress tracking
        try {
          const writer = createWriteStream(targetPath);
          
          const response = await axios({
            url: downloadUrl,
            method: 'GET',
            responseType: 'stream',
            onDownloadProgress: progressEvent => {
              const progress = progressEvent.loaded / progressEvent.total;
              const speed = progressEvent.rate || 0; // bytes per second
              
              // Send progress update
              if (win && win.webContents) {
                win.webContents.send('download-progress', {
                  id: downloadId,
                  name: modDetails.name,
                  progress: progress * 100, // Convert to percentage
                  size: progressEvent.total,
                  downloaded: progressEvent.loaded,
                  speed: speed,
                  completed: false,
                  error: null
                });
              }
            }
          });
          
          // Get total size from headers
          const totalBytes = parseInt(response.headers['content-length'], 10);
          let downloadedBytes = 0;
          let lastUpdate = Date.now();
          let lastBytes = 0;
          let speed = 0;
          
          // Track progress manually if onDownloadProgress doesn't work
          response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            
            // Calculate progress
            const progress = totalBytes ? downloadedBytes / totalBytes : 0;
            
            // Calculate speed every 500ms
            const now = Date.now();
            const timeDiff = now - lastUpdate;
            if (timeDiff >= 500) {
              speed = ((downloadedBytes - lastBytes) * 1000) / timeDiff; // bytes per second
              lastUpdate = now;
              lastBytes = downloadedBytes;
              
              // Send progress update
              if (win && win.webContents) {
                win.webContents.send('download-progress', {
                  id: downloadId,
                  name: modDetails.name,
                  progress: progress * 100, // Convert to percentage
                  size: totalBytes,
                  downloaded: downloadedBytes,
                  speed: speed,
                  completed: false,
                  error: null
                });
              }
            }
          });
          
          // Pipe the response to the file
          await new Promise((resolve, reject) => {
            // Handle completion
            writer.on('finish', resolve);
            writer.on('error', reject);
            
            // Pipe response to file
            response.data.pipe(writer);
          });
          
          // If mod was in both locations, copy to the other location as well
          if (currentModLocation === 'both') {
            console.log('[IPC:Mods] Copying mod to other location for "both" category');
            if (destinationPath === path.join(modsDir, fileName)) {
              // We installed to server, copy to client
              const clientTargetPath = path.join(clientModsDir, fileName);
              await fs.copyFile(targetPath, clientTargetPath);
              console.log(`[IPC:Mods] Copied mod to client: ${clientTargetPath}`);
            } else {
              // We installed to client, copy to server  
              const serverTargetPath = path.join(modsDir, fileName);
              await fs.copyFile(targetPath, serverTargetPath);
              console.log(`[IPC:Mods] Copied mod to server: ${serverTargetPath}`);
            }
          }
          
          // Send completion update
          if (win && win.webContents) {
            win.webContents.send('download-progress', {
              id: downloadId,
              name: modDetails.name,
              progress: 1,
              speed: 0,
              completed: true,
              completedTime: Date.now(),
              error: null
            });
          }
        } catch (downloadErr) {
          console.error('[IPC:Mods] Download error:', downloadErr);
          
          // Determine a friendly error message
          let errorMessage = 'Download failed';
          
          if (downloadErr.code === 'ECONNRESET') {
            errorMessage = 'Connection was reset (ECONNRESET). The server might be temporarily unavailable.';
          } else if (downloadErr.code === 'ETIMEDOUT' || downloadErr.code === 'ESOCKETTIMEDOUT') {
            errorMessage = 'Connection timed out. Please check your internet connection.';
          } else if (downloadErr.code === 'ENOTFOUND') {
            errorMessage = 'Host not found. Please check your internet connection.';
          } else if (downloadErr.response && downloadErr.response.status) {
            errorMessage = `Server responded with error (${downloadErr.response.status}): ${downloadErr.message}`;
          } else if (downloadErr.message) {
            errorMessage = downloadErr.message;
          }
          
          // Send error update with completedTime to ensure it gets cleaned up
          if (win && win.webContents) {
            win.webContents.send('download-progress', {
              id: downloadId,
              name: modDetails.name,
              progress: 0,
              speed: 0,
              completed: false,
              completedTime: Date.now(), // Add completed time to ensure it gets cleaned up
              error: errorMessage
            });
          }
          
          throw new Error(errorMessage);
        }
        
        // Save manifest information
        if (modDetails.source === 'modrinth' && versionInfo) {
          try {
            // Determine which manifest directories to use based on mod location
            const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
            const clientManifestDir = path.join(clientPath, 'minecraft-core-manifests');
            
            const manifest = {
              projectId: modDetails.id,
              name: modDetails.name,
              fileName: fileName,
              versionId: versionInfo.id || modDetails.selectedVersionId,
              versionNumber: versionInfo.version_number || versionInfo.name || 'unknown',
              source: modDetails.source
            };
            
            // Save manifest to appropriate location(s) based on current mod location
            if (currentModLocation === 'client-only') {
              // Save only to client manifest directory
              await fs.mkdir(clientManifestDir, { recursive: true });
              const clientManifestPath = path.join(clientManifestDir, `${fileName}.json`);
              await fs.writeFile(clientManifestPath, JSON.stringify(manifest, null, 2));
              console.log('[IPC:Mods] Saved client-only mod manifest:', clientManifestPath);
            } else if (currentModLocation === 'both') {
              // Save to both manifest directories
              await fs.mkdir(serverManifestDir, { recursive: true });
              await fs.mkdir(clientManifestDir, { recursive: true });
              
              const serverManifestPath = path.join(serverManifestDir, `${fileName}.json`);
              const clientManifestPath = path.join(clientManifestDir, `${fileName}.json`);
              
              await fs.writeFile(serverManifestPath, JSON.stringify(manifest, null, 2));
              await fs.writeFile(clientManifestPath, JSON.stringify(manifest, null, 2));
              console.log('[IPC:Mods] Saved mod manifest to both locations:', serverManifestPath, clientManifestPath);
            } else {
              // Default to server manifest directory (server-only or new installs)
              await fs.mkdir(serverManifestDir, { recursive: true });
              const serverManifestPath = path.join(serverManifestDir, `${fileName}.json`);
              await fs.writeFile(serverManifestPath, JSON.stringify(manifest, null, 2));
              console.log('[IPC:Mods] Saved server mod manifest:', serverManifestPath);
            }
          } catch (manifestErr) {
            console.error('[IPC:Mods] Failed to save mod manifest:', manifestErr);
            // Continue without saving manifest
          }
        }
        
        console.log('[IPC:Mods] Mod installed successfully:', modDetails.name);
        return { success: true };
      } catch (err) {
        console.error('[IPC:Mods] Failed to install mod:', err);
        
        // Determine a friendly error message
        let errorMessage = 'Unknown error';
        
        if (err.code === 'ECONNRESET') {
          errorMessage = 'Connection was reset (ECONNRESET). The server might be temporarily unavailable.';
        } else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
          errorMessage = 'Connection timed out. Please check your internet connection.';
        } else if (err.code === 'ENOTFOUND') {
          errorMessage = 'Host not found. Please check your internet connection.';
        } else if (err.message) {
          errorMessage = err.message;
        }
        
        // Send error update with completedTime
        if (win && win.webContents && modDetails) {
          win.webContents.send('download-progress', {
            id: `mod-${modDetails.id}-${Date.now()}`,
            name: modDetails.name,
            progress: 0,
            speed: 0,
            completed: false,
            completedTime: Date.now(), // Add completed time to ensure it gets cleaned up
            error: errorMessage
          });
        }
        return { success: false, error: `Failed to install mod ${modDetails.name}: ${errorMessage}` };
      }
    },

    'add-mod': async (_event, serverPath, modPath) => {
      try {
        console.log('[IPC:Mods] Adding mod:', { serverPath, modPath });
        
        if (!serverPath) {
          console.error('[IPC:Mods] Server path is missing');
          throw new Error('Server path is required');
        }
        
        if (!modPath) {
          console.error('[IPC:Mods] Mod path is missing');
          throw new Error('Mod path is required');
        }
        
        // Check if source file exists
        try {
          const stats = await fs.stat(modPath);
          if (!stats.isFile()) {
            throw new Error(`Not a file: ${modPath}`);
          }
          console.log(`[IPC:Mods] Source file exists: ${modPath} (${stats.size} bytes)`);
        } catch (statErr) {
          console.error('[IPC:Mods] Error checking source file:', statErr);
          throw new Error(`Source file not accessible: ${statErr.message}`);
        }
        
        const modsDir = path.join(serverPath, 'mods');
        const fileName = path.basename(modPath);
        const targetPath = path.join(modsDir, fileName);
        
        console.log('[IPC:Mods] Target path:', targetPath);
        
        // Create mods directory if it doesn't exist
        await fs.mkdir(modsDir, { recursive: true });
        
        // Copy the mod file to the mods directory
        try {
          await fs.copyFile(modPath, targetPath);
          console.log('[IPC:Mods] Copied mod to:', targetPath);
        } catch (copyErr) {
          console.error('[IPC:Mods] Error copying file:', copyErr);
          throw new Error(`Failed to copy mod file: ${copyErr.message}`);
        }
        
        // Verify the file was copied successfully
        try {
          const stats = await fs.stat(targetPath);
          console.log(`[IPC:Mods] Target file verified: ${targetPath} (${stats.size} bytes)`);
        } catch (verifyErr) {
          console.error('[IPC:Mods] Error verifying target file:', verifyErr);
          throw new Error(`Failed to verify copied file: ${verifyErr.message}`);
        }
        
        return true;
      } catch (err) {
        console.error('[IPC:Mods] Failed to add mod:', err);
        throw new Error(`Failed to add mod: ${err.message}`);
      }
    },
    
    'delete-mod': async (_event, serverPath, modName) => {
      try {
        console.log('[IPC:Mods] Deleting mod:', { serverPath, modName });
        
        if (!serverPath) {
          throw new Error('Server path is required');
        }
        
        if (!modName) {
          throw new Error('Mod name is required');
        }
        
        // Ensure we delete the .jar file
        const fileName = modName.endsWith('.jar') ? modName : `${modName}.jar`;
        const modPath = path.join(serverPath, 'mods', fileName);
        
        console.log('[IPC:Mods] Mod path to delete:', modPath);
        
        await fs.unlink(modPath);
        console.log('[IPC:Mods] Deleted mod:', modPath);
        
        return true;
      } catch (err) {
        console.error('[IPC:Mods] Failed to delete mod:', err);
        throw new Error(`Failed to delete mod: ${err.message}`);
      }
    },
    
    // Process dropped files directly
    'handle-dropped-files': async (_event, files) => {
      try {
        console.log('[IPC:Mods] Processing dropped files:', files);
        
        if (!files || !files.length) {
          console.log('[IPC:Mods] No files provided');
          return [];
        }
        
        // Get the file paths from the dropped files
        // The files object structure might vary based on how it was passed
        let filePaths = [];
        
        // Try different ways to extract paths
        if (Array.isArray(files)) {
          console.log('[IPC:Mods] Files is an array');
          
          // Try to extract paths if files is an array of objects with path property
          if (files[0] && typeof files[0] === 'object') {
            filePaths = files.map(file => file.path || '').filter(Boolean);
          } 
          // If files is already an array of paths
          else if (typeof files[0] === 'string') {
            filePaths = files;
          }
        } 
        // If files is just a single object with a path
        else if (typeof files === 'object' && files.path) {
          filePaths = [files.path];
        }
        
        console.log('[IPC:Mods] Extracted file paths:', filePaths);
        
        // Just return whatever paths we were able to extract
        // No fallback dialog needed
        return filePaths;
      } catch (err) {
        console.error('[IPC:Mods] Error processing dropped files:', err);
        throw new Error(`Failed to process dropped files: ${err.message}`);
      }
    },
    
    'save-temp-file': async (_event, { name, buffer }) => {
      try {
        console.log(`[IPC:Mods] Saving temporary file: ${name}, buffer length: ${buffer ? buffer.length : 'undefined'}`);
        
        if (!buffer || !Array.isArray(buffer) || buffer.length === 0) {
          throw new Error('Invalid or empty buffer received');
        }
        
        // Create a temporary file path
        const tempDir = path.join(os.tmpdir(), 'minecraft-core-mods');
        await fs.mkdir(tempDir, { recursive: true });
        
        // Use a hash of the name + timestamp to avoid collisions
        const hash = crypto
          .createHash('md5')
          .update(`${name}-${Date.now()}`)
          .digest('hex')
          .slice(0, 8);
          
        const tempFilePath = path.join(tempDir, `${hash}-${name}`);
        
        // Convert the array back to a Uint8Array and write to file
        const uint8Array = new Uint8Array(buffer);
        await fs.writeFile(tempFilePath, uint8Array);
        
        // Verify the file was written successfully
        const stats = await fs.stat(tempFilePath);
        console.log(`[IPC:Mods] Temporary file saved to: ${tempFilePath} (${stats.size} bytes)`);
        
        // Return the absolute path to the temporary file
        return tempFilePath;
      } catch (err) {
        console.error('[IPC:Mods] Failed to save temporary file:', err);
        throw new Error(`Failed to save temporary file: ${err.message}`);
      }
    },

    // Direct mod addition from renderer (no need for file paths)
    'direct-add-mod': async (_event, { serverPath, fileName, buffer }) => {
      try {
        console.log(`[IPC:Mods] Direct adding mod: ${fileName} to ${serverPath}`);
        
        if (!serverPath) {
          throw new Error('Server path is required');
        }
        
        if (!fileName) {
          throw new Error('File name is required');
        }
        
        if (!buffer || !Array.isArray(buffer) || buffer.length === 0) {
          throw new Error('Valid file buffer is required');
        }
        
        const modsDir = path.join(serverPath, 'mods');
        const targetPath = path.join(modsDir, fileName);
        
        console.log(`[IPC:Mods] Target path for direct mod: ${targetPath}`);
        
        // Create mods directory if it doesn't exist
        await fs.mkdir(modsDir, { recursive: true });
        
        // Write the file directly from the buffer
        await fs.writeFile(targetPath, new Uint8Array(buffer));
        
        // Verify the file was written successfully
        const stats = await fs.stat(targetPath);
        console.log(`[IPC:Mods] Direct mod added: ${targetPath} (${stats.size} bytes)`);
        
        return true;
      } catch (err) {
        console.error('[IPC:Mods] Failed to directly add mod:', err);
        throw new Error(`Failed to add mod: ${err.message}`);
      }
    },

    'get-project-info': async (_event, { projectId, source }) => {
      try {
        console.log(`[IPC:Mods] Getting project info for ${projectId} (source: ${source})`);
        
        if (source === 'modrinth') {
          const projectInfo = await getModrinthProjectInfo(projectId);
          return projectInfo;
        } else {
          throw new Error('Only Modrinth project info is supported');
        }
      } catch (err) {
        console.error('[IPC:Mods] Failed to get project info:', err);
        throw new Error(`Failed to get project info: ${err.message}`);
      }
    },

    // Add this helper function for extracting dependencies from JAR files
    'extract-jar-dependencies': async (_event, modPath) => {
      try {
        console.log('[IPC:Mods] Extracting dependencies from JAR:', modPath);
        if (!modPath) {
          throw new Error('Mod path is required');
        }
        
        const dependencies = await extractDependenciesFromJar(modPath);
        return dependencies;
      } catch (error) {
        console.error('[IPC:Mods] Failed to extract JAR dependencies:', error);
        throw new Error(`Failed to extract dependencies: ${error.message}`);
      }
    },

    // Add this function for downloading and analyzing mods directly
    'analyze-mod-from-url': async (_event, { url, modId }) => {
      try {
        console.log(`[IPC:Mods] Analyzing mod from URL: ${url}`);
        if (!url) {
          throw new Error('URL is required');
        }
        
        const dependencies = await analyzeModFromUrl(url, modId);
        return dependencies;
      } catch (error) {
        console.error('[IPC:Mods] Failed to analyze mod from URL:', error);
        throw new Error(`Failed to analyze mod: ${error.message}`);
      }
    },

    // Save mod categories
    'save-mod-categories': async (_event, categories, serverPath, clientPath) => {
      try {
        if (!Array.isArray(categories)) {
          console.error('[Mod Categories] Invalid categories format:', categories);
          return { success: false, error: 'Invalid categories format' };
        }
        
        // Save to app store
        modCategoriesStore.set(categories);
        
        // Check if we have a valid server path for file operations
        if (serverPath) {
          console.log(`[Mod Categories] Processing mod categories for server: ${serverPath}`);
          
          // Set up directory paths
          const serverModsDir = path.join(serverPath, 'mods');
          
          // If clientPath is not provided, try to determine it
          if (!clientPath) {
            // Create client directory inside the server directory
            clientPath = path.join(serverPath, 'client');
            console.log(`[Mod Categories] Using client path inside server directory: ${clientPath}`);
          } else {
            console.log(`[Mod Categories] Using provided client path: ${clientPath}`);
          }
          
          const clientModsDir = path.join(clientPath, 'mods');
          
          console.log(`[Mod Categories] Server mods directory: ${serverModsDir}`);
          console.log(`[Mod Categories] Client mods directory: ${clientModsDir}`);
          
          // Manifest directories
          const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
          const clientManifestDir = path.join(clientPath, 'minecraft-core-manifests');
          
          console.log(`[Mod Categories] Server manifest directory: ${serverManifestDir}`);
          console.log(`[Mod Categories] Client manifest directory: ${clientManifestDir}`);
          
          // Create directories if they don't exist
          await fs.mkdir(serverModsDir, { recursive: true }).catch(err => {
            console.error(`[Mod Categories] Error creating server mods directory: ${err.message}`);
          });
          
          await fs.mkdir(clientModsDir, { recursive: true }).catch(err => {
            console.error(`[Mod Categories] Error creating client mods directory: ${err.message}`);
          });
          
          await fs.mkdir(serverManifestDir, { recursive: true }).catch(err => {
            console.error(`[Mod Categories] Error creating server manifest directory: ${err.message}`);
          });
          
          await fs.mkdir(clientManifestDir, { recursive: true }).catch(err => {
            console.error(`[Mod Categories] Error creating client manifest directory: ${err.message}`);
          });
          
          // Debug: List all files in both directories before changes
          try {
            const serverFiles = await fs.readdir(serverModsDir);
            console.log(`[Mod Categories] Current server mods (${serverFiles.length}):`, serverFiles);
            
            const clientFiles = await fs.readdir(clientModsDir);
            console.log(`[Mod Categories] Current client mods (${clientFiles.length}):`, clientFiles);
          } catch (listErr) {
            console.error(`[Mod Categories] Error listing mod files: ${listErr.message}`);
          }
          
          // Now, physically move the mod files based on category
          for (const modData of categories) {
            try {
              const { modId, category } = modData;
              
              // Skip if missing required data
              if (!modId || !category) {
                console.log(`[Mod Categories] Skipping mod with missing data: ${JSON.stringify(modData)}`);
                continue;
              }
              
              // Ensure modId includes .jar extension if it doesn't already
              const fileName = modId.endsWith('.jar') ? modId : `${modId}.jar`;
              
              // For cases where we actually need to move files
              if (category === 'client-only' || category === 'server-only' || category === 'both') {
                // Check if the mod exists in the server directory
                const serverModPath = path.join(serverModsDir, fileName);
                const clientModPath = path.join(clientModsDir, fileName);
                
                // Manifest paths
                const serverManifestPath = path.join(serverManifestDir, `${fileName}.json`);
                const clientManifestPath = path.join(clientManifestDir, `${fileName}.json`);
                
                console.log(`[Mod Categories] Processing mod ${fileName} with category ${category}`);
                console.log(`[Mod Categories] Server path: ${serverModPath}`);
                console.log(`[Mod Categories] Client path: ${clientModPath}`);
                
                let serverModExists = false;
                let clientModExists = false;
                let serverManifestExists = false;
                let clientManifestExists = false;
                
                try {
                  await fs.access(serverModPath);
                  serverModExists = true;
                } catch (err) {
                  console.log(`[Mod Categories] Mod does not exist in server: ${fileName}`);
                }
                
                try {
                  await fs.access(clientModPath);
                  clientModExists = true;
                } catch (err) {
                  console.log(`[Mod Categories] Mod does not exist in client: ${fileName}`);
                }
                
                try {
                  await fs.access(serverManifestPath);
                  serverManifestExists = true;
                } catch (err) {
                  console.log(`[Mod Categories] Manifest does not exist in server: ${fileName}`);
                }
                
                try {
                  await fs.access(clientManifestPath);
                  clientManifestExists = true;
                } catch (err) {
                  console.log(`[Mod Categories] Manifest does not exist in client: ${fileName}`);
                }
                
                console.log(`[Mod Categories] Server mod exists: ${serverModExists}`);
                console.log(`[Mod Categories] Client mod exists: ${clientModExists}`);
                console.log(`[Mod Categories] Server manifest exists: ${serverManifestExists}`);
                console.log(`[Mod Categories] Client manifest exists: ${clientManifestExists}`);
                
                // Move files based on category
                if (category === 'client-only') {
                  // Move from server to client if it exists in the server
                  if (serverModExists) {
                    console.log(`[Mod Categories] Moving ${fileName} from server to client`);
                    try {
                      await fs.copyFile(serverModPath, clientModPath);
                      await fs.unlink(serverModPath);
                      console.log(`[Mod Categories] Successfully moved ${fileName} from server to client`);
                      
                      // Also move the manifest
                      if (serverManifestExists) {
                        await fs.copyFile(serverManifestPath, clientManifestPath);
                        await fs.unlink(serverManifestPath);
                        console.log(`[Mod Categories] Successfully moved manifest for ${fileName} from server to client`);
                      }
                    } catch (moveError) {
                      console.error(`[Mod Categories] Error moving file: ${moveError.message}`);
                      
                      // Additional debug info if move failed
                      try {
                        const serverStat = await fs.stat(serverModPath);
                        console.log(`[Mod Categories] Server file stats: size=${serverStat.size}, isFile=${serverStat.isFile()}`);
                      } catch (statErr) {
                        console.error(`[Mod Categories] Error getting server file stats: ${statErr.message}`);
                      }
                    }
                  }
                } else if (category === 'server-only') {
                  // Move from client to server if it exists in the client
                  if (clientModExists) {
                    console.log(`[Mod Categories] Moving ${fileName} from client to server`);
                    try {
                      await fs.copyFile(clientModPath, serverModPath);
                      await fs.unlink(clientModPath);
                      console.log(`[Mod Categories] Successfully moved ${fileName} from client to server`);
                      
                      // Also move the manifest
                      if (clientManifestExists) {
                        await fs.copyFile(clientManifestPath, serverManifestPath);
                        await fs.unlink(clientManifestPath);
                        console.log(`[Mod Categories] Successfully moved manifest for ${fileName} from client to server`);
                      }
                    } catch (moveError) {
                      console.error(`[Mod Categories] Error moving file: ${moveError.message}`);
                    }
                  }
                } else if (category === 'both') {
                  // Ensure it exists in both locations
                  if (serverModExists && !clientModExists) {
                    console.log(`[Mod Categories] Copying ${fileName} from server to client`);
                    try {
                      await fs.copyFile(serverModPath, clientModPath);
                      console.log(`[Mod Categories] Successfully copied ${fileName} from server to client`);
                      
                      // Also copy the manifest
                      if (serverManifestExists) {
                        await fs.copyFile(serverManifestPath, clientManifestPath);
                        console.log(`[Mod Categories] Successfully copied manifest for ${fileName} from server to client`);
                      }
                    } catch (copyError) {
                      console.error(`[Mod Categories] Error copying file: ${copyError.message}`);
                    }
                  } else if (!serverModExists && clientModExists) {
                    console.log(`[Mod Categories] Copying ${fileName} from client to server`);
                    try {
                      await fs.copyFile(clientModPath, serverModPath);
                      console.log(`[Mod Categories] Successfully copied ${fileName} from client to server`);
                      
                      // Also copy the manifest
                      if (clientManifestExists) {
                        await fs.copyFile(clientManifestPath, serverManifestPath);
                        console.log(`[Mod Categories] Successfully copied manifest for ${fileName} from client to server`);
                      }
                    } catch (copyError) {
                      console.error(`[Mod Categories] Error copying file: ${copyError.message}`);
                    }
                  }
                }
              } else {
                console.log(`[Mod Categories] Skipping unknown category: ${category} for mod ${fileName}`);
              }
            } catch (modError) {
              console.error(`[Mod Categories] Error processing mod ${modData.modId}:`, modError);
              // Continue with other mods even if one fails
            }
          }
          
          // Debug: List all files in both directories after changes
          try {
            const serverFiles = await fs.readdir(serverModsDir);
            console.log(`[Mod Categories] Server mods after changes (${serverFiles.length}):`, serverFiles);
            
            const clientFiles = await fs.readdir(clientModsDir);
            console.log(`[Mod Categories] Client mods after changes (${clientFiles.length}):`, clientFiles);
          } catch (listErr) {
            console.error(`[Mod Categories] Error listing mod files after changes: ${listErr.message}`);
          }
        } else {
          console.log('[Mod Categories] No server path provided, skipping file operations');
        }
        
        return { success: true };
      } catch (error) {
        console.error('[Mod Categories] Error saving mod categories:', error);
        return { success: false, error: error.message };
      }
    },
    
    // Get mod categories
    'get-mod-categories': async () => {
      try {
        const categories = modCategoriesStore.get();
        console.log('[IPC] get-mod-categories returning:', categories);
        return categories || []; // Return categories directly as array
      } catch (error) {
        console.error('[IPC] Error getting mod categories:', error);
        return []; // Return empty array on error
      }
    },

    // Move a mod file between directories based on category
    'move-mod-file': async (_event, { fileName, newCategory, serverPath }) => {
      try {
        console.log(`[IPC:Mods] Moving mod ${fileName} to category ${newCategory}, with serverPath ${serverPath}`);
        
        if (!fileName) {
          throw new Error('Filename is required');
        }
        
        if (!newCategory) {
          throw new Error('New category is required');
        }
        
        if (!serverPath) {
          throw new Error('Server path is required');
        }
        
        // Determine client path from server path
        // Instead of creating a parallel client directory, create it inside the server directory
        const clientPath = path.join(serverPath, 'client');
        
        console.log('[IPC:Mods] Server path:', serverPath);
        console.log('[IPC:Mods] Client path:', clientPath);
        
        const serverModsDir = path.join(serverPath, 'mods');
        const clientModsDir = path.join(clientPath, 'mods');
        const disabledModsDir = path.join(serverPath, 'mods_disabled');
        
        // Manifest directories
        const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
        const clientManifestDir = path.join(clientPath, 'minecraft-core-manifests');
        
        console.log('[IPC:Mods] Server mods dir:', serverModsDir);
        console.log('[IPC:Mods] Client mods dir:', clientModsDir);
        console.log('[IPC:Mods] Disabled mods dir:', disabledModsDir);
        console.log('[IPC:Mods] Server manifest dir:', serverManifestDir);
        console.log('[IPC:Mods] Client manifest dir:', clientManifestDir);
        
        // Create all directories if they don't exist
        await fs.mkdir(serverModsDir, { recursive: true });
        await fs.mkdir(clientModsDir, { recursive: true }).catch(err => {
          console.warn('[IPC:Mods] Could not create client mods directory:', err);
          throw new Error(`Could not create client mods directory: ${err.message}`);
        });
        await fs.mkdir(disabledModsDir, { recursive: true });
        await fs.mkdir(serverManifestDir, { recursive: true });
        await fs.mkdir(clientManifestDir, { recursive: true });
        
        // Check if file exists in various locations
        const serverModPath = path.join(serverModsDir, fileName);
        const clientModPath = path.join(clientModsDir, fileName);
        const disabledModPath = path.join(disabledModsDir, fileName);
        
        // Manifest file paths
        const serverManifestPath = path.join(serverManifestDir, `${fileName}.json`);
        const clientManifestPath = path.join(clientManifestDir, `${fileName}.json`);
        const disabledManifestPath = path.join(serverManifestDir, `${fileName}.json`); // Disabled mods keep manifest in server
        
        console.log('[IPC:Mods] Server mod path:', serverModPath);
        console.log('[IPC:Mods] Client mod path:', clientModPath);
        console.log('[IPC:Mods] Disabled mod path:', disabledModPath);
        
        const serverFileExists = await fs.access(serverModPath).then(() => true).catch(() => false);
        const clientFileExists = await fs.access(clientModPath).then(() => true).catch(() => false);
        const disabledFileExists = await fs.access(disabledModPath).then(() => true).catch(() => false);
        const serverManifestExists = await fs.access(serverManifestPath).then(() => true).catch(() => false);
        const clientManifestExists = await fs.access(clientManifestPath).then(() => true).catch(() => false);
        
        console.log('[IPC:Mods] File exists status - Server:', serverFileExists, 'Client:', clientFileExists, 'Disabled:', disabledFileExists);
        console.log('[IPC:Mods] Manifest exists status - Server:', serverManifestExists, 'Client:', clientManifestExists);
        
        // Determine what files to move based on the new category
        if (newCategory === 'server-only') {
          // Mod should be in server only
          if (clientFileExists) {
            console.log('[IPC:Mods] Moving from client to server-only');
            // If not in server, copy it there first
            if (!serverFileExists) {
              await fs.copyFile(clientModPath, serverModPath);
              console.log('[IPC:Mods] Copied from client to server');
            }
            // Copy manifest from client to server if it exists
            if (clientManifestExists && !serverManifestExists) {
              await fs.copyFile(clientManifestPath, serverManifestPath);
              console.log('[IPC:Mods] Copied manifest from client to server');
            }
            // Then remove from client
            await fs.unlink(clientModPath);
            if (clientManifestExists) {
              await fs.unlink(clientManifestPath);
              console.log('[IPC:Mods] Removed manifest from client');
            }
            console.log(`[IPC:Mods] Removed mod from client: ${clientModPath}`);
          }
          
          if (!serverFileExists && disabledFileExists) {
            // Move from disabled to server
            await fs.copyFile(disabledModPath, serverModPath);
            await fs.unlink(disabledModPath);
            console.log(`[IPC:Mods] Moved mod from disabled to server: ${fileName}`);
          }
        } 
        else if (newCategory === 'client-only') {
          // Mod should be in client only
          console.log('[IPC:Mods] Moving to client-only');
          if (serverFileExists) {
            // Copy to client if not already there
            if (!clientFileExists) {
              await fs.copyFile(serverModPath, clientModPath);
              console.log(`[IPC:Mods] Copied mod to client: ${fileName}`);
            }
            
            // Copy manifest from server to client
            if (serverManifestExists && !clientManifestExists) {
              await fs.copyFile(serverManifestPath, clientManifestPath);
              console.log(`[IPC:Mods] Copied manifest to client: ${fileName}`);
            }
            
            // Then remove from server
            await fs.unlink(serverModPath);
            if (serverManifestExists) {
              await fs.unlink(serverManifestPath);
              console.log('[IPC:Mods] Removed manifest from server');
            }
            console.log(`[IPC:Mods] Removed mod from server: ${serverModPath}`);
          } 
          else if (disabledFileExists) {
            // Move from disabled to client
            await fs.copyFile(disabledModPath, clientModPath);
            await fs.unlink(disabledModPath);
            
            // Copy manifest to client if it exists in server manifests
            if (serverManifestExists) {
              await fs.copyFile(serverManifestPath, clientManifestPath);
              console.log(`[IPC:Mods] Copied manifest to client from server manifests: ${fileName}`);
            }
            
            console.log(`[IPC:Mods] Moved mod from disabled to client: ${fileName}`);
          }
          else {
            console.log('[IPC:Mods] WARNING: Could not find the mod file in any location when moving to client-only');
          }
        } 
        else if (newCategory === 'both') {
          // Mod should be in both server and client
          if (serverFileExists && !clientFileExists) {
            // Copy from server to client
            await fs.copyFile(serverModPath, clientModPath);
            console.log(`[IPC:Mods] Copied mod to client: ${fileName}`);
            
            // Copy manifest to client
            if (serverManifestExists) {
              await fs.copyFile(serverManifestPath, clientManifestPath);
              console.log(`[IPC:Mods] Copied manifest to client: ${fileName}`);
            }
          } 
          else if (!serverFileExists && clientFileExists) {
            // Copy from client to server
            await fs.copyFile(clientModPath, serverModPath);
            console.log(`[IPC:Mods] Copied mod to server: ${fileName}`);
            
            // Copy manifest to server
            if (clientManifestExists) {
              await fs.copyFile(clientManifestPath, serverManifestPath);
              console.log(`[IPC:Mods] Copied manifest to server: ${fileName}`);
            }
          } 
          else if (disabledFileExists) {
            // Move from disabled to both
            await fs.copyFile(disabledModPath, serverModPath);
            await fs.copyFile(disabledModPath, clientModPath);
            await fs.unlink(disabledModPath);
            
            // Copy manifest to both locations if it exists in server manifests
            if (serverManifestExists) {
              await fs.copyFile(serverManifestPath, clientManifestPath);
              console.log(`[IPC:Mods] Copied manifest to client: ${fileName}`);
            }
            
            console.log(`[IPC:Mods] Moved mod from disabled to both: ${fileName}`);
          }
        } 
        else if (newCategory === 'disabled') {
          // Mod should be disabled
          if (serverFileExists) {
            // Copy to disabled if not already there
            if (!disabledFileExists) {
              await fs.copyFile(serverModPath, disabledModPath);
            }
            await fs.unlink(serverModPath);
            console.log(`[IPC:Mods] Disabled mod from server: ${fileName}`);
          }
          
          if (clientFileExists) {
            // Copy to disabled if not already there
            if (!disabledFileExists) {
              await fs.copyFile(clientModPath, disabledModPath);
            }
            await fs.unlink(clientModPath);
            
            // Remove client manifest but keep server manifest for disabled mods
            if (clientManifestExists) {
              await fs.unlink(clientManifestPath);
              console.log('[IPC:Mods] Removed client manifest for disabled mod');
            }
            
            console.log(`[IPC:Mods] Disabled mod from client: ${fileName}`);
          }
        }
        
        return { success: true, category: newCategory };
      } catch (err) {
        console.error('[IPC:Mods] Error moving mod:', err);
        throw new Error(`Failed to move mod: ${err.message}`);
      }
    },

    // Install a mod to a client instance
    'install-client-mod': async (_event, modData) => {
      try {
        const result = await installClientMod(modData);
        return result;
      } catch (error) {
        console.error('[IPC:Mods] Error in install-client-mod handler:', error);
        return { success: false, error: error.message };
      }
    },
  };
}

/**
 * Helper function to convert our sort options to Modrinth API format
 * @param {string} sortBy - Sort option
 * @returns {string} - Converted sort option
 */
function convertSortToModrinthFormat(sortBy) {
  console.log(`[API:Modrinth] Converting sort parameter: "${sortBy}"`);
  
  // Convert our sort values to Modrinth's expected format
  let modrinthSort;
  switch (sortBy) {
    case 'relevance': 
      modrinthSort = 'relevance';
      break;
    case 'downloads': 
      modrinthSort = 'downloads';
      break;
    case 'follows': 
      modrinthSort = 'follows';
      break;
    case 'newest': 
      modrinthSort = 'newest';
      break;
    case 'updated': 
      modrinthSort = 'updated';
      break;
    default: 
      console.log(`[API:Modrinth] Unknown sort value: "${sortBy}", defaulting to relevance`);
      modrinthSort = 'relevance';
  }
  
  console.log(`[API:Modrinth] Converted sort parameter to: "${modrinthSort}"`);
  return modrinthSort;
}

/**
 * Get popular mods from Modrinth
 * 
 * @param {Object} options - Search options
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Results per page
 * @param {string} options.sortBy - Sort method (popular, recent, downloads, name)
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function getModrinthPopular({ loader, version, page = 1, limit = 20, sortBy = 'relevance', environmentType = 'all' }) {
  await rateLimit();
  
  console.log(`[API:Modrinth] getModrinthPopular called with sortBy="${sortBy}" and environmentType="${environmentType}"`);
  
  const modrinthSortBy = convertSortToModrinthFormat(sortBy);
  
  // Build the facets array
  const facets = [];
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  if (version) {
    facets.push(["versions:" + version]);
  }
  
  // Add environment type facet if specified
  if (environmentType !== 'all') {
    // Convert our environment types to Modrinth's format
    if (environmentType === 'client') {
      // For client-side, include both 'required' and 'optional' to catch all client-compatible mods
      facets.push(['client_side:required', 'client_side:optional']);
    } else if (environmentType === 'server') {
      // For server-side, include both 'required' and 'optional' to catch all server-compatible mods
      facets.push(['server_side:required', 'server_side:optional']);
    } else if (environmentType === 'both') {
      // For "both", we need mods that work on both client and server
      // Use separate AND condition with both client and server support
      facets.push(['client_side:required', 'client_side:optional']);
      facets.push(['server_side:required', 'server_side:optional']);
    }
  }
  
  // Convert facets to JSON string
  const facetsParam = JSON.stringify(facets);
  
  // Build request URL
  const url = new URL(`${MODRINTH_API}/search`);
  url.searchParams.append('offset', (page - 1) * limit);
  url.searchParams.append('limit', limit);
  url.searchParams.append('facets', facetsParam);
  
  // Add sorting parameter in multiple formats to ensure compatibility
  url.searchParams.append('index', modrinthSortBy);  // For newer API versions
  
  // Execute request
  console.log(`[API:Modrinth] Fetching popular mods with index=${modrinthSortBy}, facets=${facetsParam}, page=${page}, limit=${limit}, environmentType=${environmentType}`);
  console.log(`[API:Modrinth] Full URL: ${url.toString()}`);
  
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'minecraft-core/1.0.0'
      }
    });
    
    if (!response.ok) {
      console.error(`[API:Modrinth] Error response: ${response.status} ${response.statusText}`);
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`[API:Modrinth] Got ${data.hits?.length || 0} results, total hits: ${data.total_hits || 0}`);
    
    // Debug: Log first few results to check if they're actually sorted correctly
    if (data.hits && data.hits.length > 0) {
      console.log(`[API:Modrinth] First result: ${data.hits[0].title}, Downloads: ${data.hits[0].downloads}, Follows: ${data.hits[0].follows}`);
      if (data.hits.length > 1) {
        console.log(`[API:Modrinth] Second result: ${data.hits[1].title}, Downloads: ${data.hits[1].downloads}, Follows: ${data.hits[1].follows}`);
      }
    }
    
    const mods = data.hits.map(mod => ({
      id: mod.project_id,
      name: mod.title,
      description: mod.description,
      author: mod.author,
      downloads: mod.downloads,
      followers: mod.follows || 0, // Add followers field
      versions: formatModVersions(mod.versions),
      iconUrl: mod.icon_url || null,
      source: 'modrinth',
      downloadUrl: mod.project_id,
      clientSide: mod.client_side === 'required' || mod.client_side === 'optional',
      serverSide: mod.server_side === 'required' || mod.server_side === 'optional'
    }));
    
    return {
      mods,
      pagination: {
        currentPage: page,
        totalResults: data.total_hits,
        totalPages: Math.ceil(data.total_hits / limit),
        limit
      }
    };
  } catch (error) {
    console.error('Modrinth API error:', error);
    throw error;
  }
}

/**
 * Search for mods on Modrinth
 * 
 * @param {Object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Number of results per page
 * @param {string} [options.sortBy='relevance'] - Sort by option
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function searchModrinthMods({ query, loader, version, page = 1, limit = 20, sortBy = 'relevance', environmentType = 'all' }) {
  console.log('[IPC:Mods] Searching mods with:', { keyword: query, loader, version, source: 'modrinth', page, limit, sortBy, environmentType });
  
  await rateLimit();
  
  console.log(`[API:Modrinth] searchModrinthMods called with sortBy="${sortBy}" and environmentType="${environmentType}"`);
  
  const modrinthSortBy = convertSortToModrinthFormat(sortBy);
  
  // Build the facets array
  const facets = [];
  if (loader) {
    facets.push([`categories:${loader}`]);
  }
  if (version) {
    facets.push(["versions:" + version]);
  }
  
  // Add environment type facet if specified
  if (environmentType !== 'all') {
    // Convert our environment types to Modrinth's format
    if (environmentType === 'client') {
      // For client-side, include both 'required' and 'optional' to catch all client-compatible mods
      facets.push(['client_side:required', 'client_side:optional']);
    } else if (environmentType === 'server') {
      // For server-side, include both 'required' and 'optional' to catch all server-compatible mods
      facets.push(['server_side:required', 'server_side:optional']);
    } else if (environmentType === 'both') {
      // For "both", we need mods that work on both client and server
      // Use separate AND condition with both client and server support
      facets.push(['client_side:required', 'client_side:optional']);
      facets.push(['server_side:required', 'server_side:optional']);
    }
  }
  
  // Convert facets to JSON string
  const facetsParam = JSON.stringify(facets);
  
  // Build request URL
  const url = new URL(`${MODRINTH_API}/search`);
  url.searchParams.append('query', query);
  url.searchParams.append('offset', (page - 1) * limit);
  url.searchParams.append('limit', limit);
  url.searchParams.append('facets', facetsParam);
  
  // Add sorting parameter in multiple formats to ensure compatibility
  url.searchParams.append('index', modrinthSortBy);  // For newer API versions
  
  // Execute request
  console.log(`[API:Modrinth] Searching mods with query="${query}", index=${modrinthSortBy}, facets=${facetsParam}, page=${page}, limit=${limit}, environmentType=${environmentType}`);
  console.log(`[API:Modrinth] Full URL: ${url.toString()}`);
  
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'minecraft-core/1.0.0'
      }
    });
    
    if (!response.ok) {
      console.error(`[API:Modrinth] Error response: ${response.status} ${response.statusText}`);
      throw new Error(`Modrinth API error (${response.status}): ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log(`[API:Modrinth] Got ${data.hits?.length || 0} results, total hits: ${data.total_hits || 0}`);
    
    // Debug: Log first few results to check if they're actually sorted correctly
    if (data.hits && data.hits.length > 0) {
      console.log(`[API:Modrinth] First result: ${data.hits[0].title}, Downloads: ${data.hits[0].downloads}, Follows: ${data.hits[0].follows}`);
      if (data.hits.length > 1) {
        console.log(`[API:Modrinth] Second result: ${data.hits[1].title}, Downloads: ${data.hits[1].downloads}, Follows: ${data.hits[1].follows}`);
      }
    }
    
    // Process results
    const mods = data.hits.map(project => ({
      id: project.project_id,
      name: project.title,
      description: project.description,
      thumbnail: project.icon_url,
      iconUrl: project.icon_url || null,
      downloads: project.downloads,
      followers: project.follows,
      categories: project.categories || [],
      author: project.author,
      clientSide: project.client_side === 'required' || project.client_side === 'optional',
      serverSide: project.server_side === 'required' || project.server_side === 'optional',
      lastUpdated: project.date_modified,
      source: 'modrinth'
    }));
    
    return {
      mods,
      pagination: {
        totalResults: data.total_hits,
        totalPages: Math.ceil(data.total_hits / limit),
        currentPage: page
      }
    };
  } catch (error) {
    console.error('[IPC:Mods] Error searching Modrinth mods:', error);
    throw error;
  }
}

/**
 * Format version strings to make them more concise and readable
 * Show only full releases, not snapshots/alphas/betas
 * 
 * @param {string[]} versions - Array of version strings
 * @returns {string[]} Formatted array of version strings
 */
function formatModVersions(versions) {
  if (!versions || !Array.isArray(versions) || versions.length === 0) {
    return ['Unknown'];
  }
  
  // Strict filtering for release versions only
  const releaseVersions = versions.filter(v => {
    if (!v || typeof v !== 'string') return false;
    
    // Convert to lowercase for case-insensitive comparison
    const lowerV = v.toLowerCase();
    
    // Check for snapshot pattern like "25w02a" (week-based snapshots)
    // Format is usually [YY]w[WW][a-z]
    if (/\d+w\d+[a-z]?/.test(v)) {
      return false;
    }
    
    // Skip any version with these keywords
    const nonReleaseKeywords = [
      'alpha', 'beta', 'snapshot', 'pre', 'rc', 'experimental', 
      'dev', 'test', 'nightly', 'preview'
    ];
    
    // Check if version has any of the non-release keywords
    if (nonReleaseKeywords.some(keyword => lowerV.includes(keyword))) {
      return false;
    }
    
    // Check for Minecraft's older pre-release pattern like "1.16-pre1" or "1.17-rc1"
    if (/-pre\d+/.test(v) || /-rc\d+/.test(v)) {
      return false;
    }
    
    return true;
  });
  
  // If there are no release versions at all, return a meaningful message
  if (releaseVersions.length === 0) {
    return ['No stable releases'];
  }
  
  // Sort versions by semantic versioning (e.g., 1.20.1, 1.19.4, 1.19.2, etc.)
  const sortedVersions = [...releaseVersions].sort((a, b) => {
    // Try to extract semantic version parts (1.19.2 -> [1, 19, 2])
    const aParts = a.split('.').map(part => parseInt(part) || 0);
    const bParts = b.split('.').map(part => parseInt(part) || 0);
    
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (aVal !== bVal) {
        return bVal - aVal; // Descending order
      }
    }
    return 0;
  });
  
  // If there are more than 3 versions, only show the 3 most recent ones
  if (sortedVersions.length > 3) {
    // Return the 3 latest versions and indicate more are available
    return sortedVersions.slice(0, 3).concat([`+${releaseVersions.length - 3} more`]);
  }
  
  return sortedVersions;
}

/**
 * Get download URL for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID
 * @param {string} version - Minecraft version
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @returns {Promise<string>} Download URL
 */
async function getModrinthDownloadUrl(projectId, version, loader) {
  try {
    const versions = await getModrinthVersions(projectId, loader, version);
    
    if (versions.length === 0) {
      throw new Error('No matching versions found for this mod');
    }
    
    // Get latest version
    const latest = versions[0];
    
    // Get the full version info
    const versionInfo = await getModrinthVersionInfo(projectId, latest.id);
    
    // Get primary file
    if (!versionInfo.files || versionInfo.files.length === 0) {
      throw new Error('No files found for this mod version');
    }
    
    const primaryFile = versionInfo.files.find(file => file.primary) || versionInfo.files[0];
    return primaryFile.url;
  } catch (error) {
    console.error('Modrinth download URL error:', error);
    throw error;
  }
}

/**
 * Get information about a Modrinth mod project
 * 
 * @param {string} projectId - Modrinth project ID
 * @returns {Promise<Object>} Project info
 */
async function getModrinthProjectInfo(projectId) {
  try {
    const response = await fetch(`${MODRINTH_API}/project/${projectId}`);
    
    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Modrinth project info error:', error);
    throw error;
  }
}

/**
 * Resolve dependency information from Modrinth
 * 
 * @param {Array} dependencies - Array of dependency objects
 * @returns {Promise<Array>} Array of resolved dependency objects with names
 */
async function resolveModrinthDependencies(dependencies) {
  const resolvedDeps = [];
  
  for (const dep of dependencies) {
    if (dep.project_id && dep.dependency_type === 'required') {
      try {
        // Get project info to get the name
        const projectInfo = await getModrinthProjectInfo(dep.project_id);
        
        resolvedDeps.push({
          projectId: dep.project_id,
          name: projectInfo.title,
          dependencyType: dep.dependency_type
        });
      } catch (error) {
        console.error(`[IPC:Mods] Failed to resolve dependency ${dep.project_id}:`, error);
        // Include the dependency even if we can't resolve its name
        resolvedDeps.push({
          projectId: dep.project_id,
          name: 'Unknown Mod',
          dependencyType: dep.dependency_type
        });
      }
    }
  }
  
  return resolvedDeps;
}

/**
 * Get popular mods from CurseForge
 * 
 * @param {Object} options - Search options
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Results per page
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function getCurseForgePopular({ loader, version, page = 1, limit = 20, environmentType = 'all' }) {
  console.log('[IPC:Mods] CurseForge support not implemented');
  // Return an empty result set
  return {
    mods: [],
    pagination: {
      currentPage: page,
      totalResults: 0,
      totalPages: 0,
      limit
    }
  };
}

/**
 * Search for mods on CurseForge
 * 
 * @param {Object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.loader - Mod loader (fabric, forge, etc.)
 * @param {string} options.version - Minecraft version
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Results per page
 * @returns {Promise<Object>} Object with mods array and pagination info
 */
async function searchCurseForgeMods({ query, loader, version, page = 1, limit = 20, environmentType = 'all' }) {
  console.log('[IPC:Mods] CurseForge support not implemented');
  // Return an empty result set
  return {
    mods: [],
    pagination: {
      currentPage: page,
      totalResults: 0,
      totalPages: 0,
      limit
    }
  };
}

/**
 * Get download URL for a CurseForge mod
 * 
 * @param {string} modId - CurseForge mod ID
 * @param {string} version - Minecraft version
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @returns {Promise<string>} Download URL
 */
async function getCurseForgeDownloadUrl(modId, version, loader) {
  console.log('[IPC:Mods] CurseForge support not implemented');
  throw new Error('CurseForge support not implemented');
}

/**
 * Get versions for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @param {string} gameVersion - Minecraft version
 * @param {boolean} loadLatestOnly - Whether to only load the latest version
 * @returns {Promise<Array>} Array of version objects
 */
async function getModrinthVersions(projectId, loader, gameVersion, loadLatestOnly = false) {
  try {
    // Check cache first
    const cacheKey = `${projectId}:${loader || ''}:${gameVersion || ''}`;
    if (versionCache.has(cacheKey)) {
      console.log(`[API] Using cached versions for ${projectId}`);
      
      // If we only need the latest version, filter from cache
      if (loadLatestOnly) {
        const cachedVersions = versionCache.get(cacheKey);
        const latestStable = cachedVersions.find(v => v.isStable);
        if (latestStable) {
          return [latestStable];
        }
        return [cachedVersions[0]];
      }
      
      return versionCache.get(cacheKey);
    }
    
    // Apply rate limiting before API request
    await rateLimit();
    
    const response = await fetch(`${MODRINTH_API}/project/${projectId}/version`);
    
    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    const versions = await response.json();
    
    // Filter versions that match our requirements
    let compatibleVersions = versions;
    
    if (loader) {
      compatibleVersions = compatibleVersions.filter(v => v.loaders.includes(loader));
    }
    
    if (gameVersion) {
      compatibleVersions = compatibleVersions.filter(v => v.game_versions.includes(gameVersion));
    }
    
    // Map to a more user-friendly format
    let mappedVersions = compatibleVersions.map(v => ({
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      dependencies: v.dependencies || [],
      datePublished: v.date_published,
      isStable: !v.version_type.includes('alpha') && !v.version_type.includes('beta'),
      fileSize: v.files && v.files.length > 0 ? v.files[0].size : undefined,
      downloads: v.downloads || 0
    }));
    
    // Sort versions (newest first)
    mappedVersions.sort((a, b) => {
      const dateA = new Date(a.datePublished).getTime();
      const dateB = new Date(b.datePublished).getTime();
      return dateB - dateA;
    });
    
    // Cache the results
    versionCache.set(cacheKey, mappedVersions);
    
    // If we only need the latest version, just return the first one
    if (loadLatestOnly && mappedVersions.length > 0) {
      // Try to get the latest stable version first
      const latestStable = mappedVersions.find(v => v.isStable);
      if (latestStable) {
        return [latestStable];
      }
      // If no stable version, return the latest version regardless of stability
      return [mappedVersions[0]];
    }
    
    return mappedVersions;
  } catch (error) {
    console.error('Modrinth versions error:', error);
    throw error;
  }
}

/**
 * Get specific version info for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID
 * @param {string} versionId - Version ID
 * @returns {Promise<Object>} Version info object
 */
async function getModrinthVersionInfo(projectId, versionId) {
  try {
    const response = await fetch(`${MODRINTH_API}/version/${versionId}`);
    
    if (!response.ok) {
      throw new Error(`Modrinth API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Modrinth version info error:', error);
    throw error;
  }
}

/**
 * Get latest version info for a Modrinth mod
 * 
 * @param {string} projectId - Modrinth project ID
 * @param {string} gameVersion - Minecraft version
 * @param {string} loader - Mod loader (fabric, forge, etc.)
 * @returns {Promise<Object>} Version info object
 */
async function getLatestModrinthVersionInfo(projectId, gameVersion, loader) {
  try {
    const versions = await getModrinthVersions(projectId, loader, gameVersion);
    
    if (!versions || versions.length === 0) {
      throw new Error('No matching versions found');
    }
    
    // First try to find a stable version
    const stableVersion = versions.find(v => v.isStable);
    
    // If no stable version, take the first one
    return stableVersion 
      ? await getModrinthVersionInfo(projectId, stableVersion.id)
      : await getModrinthVersionInfo(projectId, versions[0].id);
  } catch (error) {
    console.error('Modrinth latest version info error:', error);
    throw error;
  }
}

// Add this helper function for extracting dependencies from JAR files
async function extractDependenciesFromJar(jarPath) {
  try {
    console.log(`[IPC:Mods] Analyzing mod file for dependencies: ${jarPath}`);
    
    // Check if the file exists
    try {
      await fs.access(jarPath);
    } catch (err) {
      throw new Error(`Mod file does not exist: ${jarPath}`);
    }
    
    // Use AdmZip to extract and read mod metadata
    const AdmZip = require('adm-zip');
    
    try {
      const zip = new AdmZip(jarPath);
      const zipEntries = zip.getEntries();
      
      // Check for Fabric mod.json first
      const fabricEntry = zipEntries.find(entry => 
        entry.entryName === 'fabric.mod.json' || 
        entry.entryName.endsWith('/fabric.mod.json')
      );
      
      if (fabricEntry) {
        console.log('[IPC:Mods] Found fabric.mod.json');
        const content = fabricEntry.getData().toString('utf8');
        try {
          const metadata = JSON.parse(content);
          
          // Extract dependencies
          const dependencies = [];
          
          // Check 'depends' field (Fabric format)
          if (metadata.depends && typeof metadata.depends === 'object') {
            Object.keys(metadata.depends).forEach(depId => {
              dependencies.push({
                id: depId,
                dependency_type: 'required',
                version_requirement: metadata.depends[depId]
              });
            });
          }
          
          // Check 'recommends' field
          if (metadata.recommends && typeof metadata.recommends === 'object') {
            Object.keys(metadata.recommends).forEach(depId => {
              dependencies.push({
                id: depId,
                dependency_type: 'optional',
                version_requirement: metadata.recommends[depId]
              });
            });
          }
          
          console.log(`[IPC:Mods] Extracted ${dependencies.length} dependencies from fabric.mod.json`);
          return dependencies;
        } catch (parseErr) {
          console.error('[IPC:Mods] Error parsing fabric.mod.json:', parseErr);
        }
      }
      
      // Check for Forge mods.toml
      const forgeEntry = zipEntries.find(entry => 
        entry.entryName === 'META-INF/mods.toml' || 
        entry.entryName.endsWith('/META-INF/mods.toml')
      );
      
      if (forgeEntry) {
        console.log('[IPC:Mods] Found Forge mods.toml');
        const content = forgeEntry.getData().toString('utf8');
        
        // Simple TOML parser for dependencies
        const dependencies = [];
        const dependencyLines = content.match(/\[\[dependencies\.[^\]]+\]\]([\s\S]*?)(?=\[|\Z)/g);
        
        if (dependencyLines) {
          dependencyLines.forEach(section => {
            // Extract modId
            const modIdMatch = section.match(/modId\s*=\s*["']([^"']+)["']/);
            if (modIdMatch) {
              const modId = modIdMatch[1];
              
              // Extract mandatory flag
              const mandatoryMatch = section.match(/mandatory\s*=\s*(true|false)/);
              const isMandatory = mandatoryMatch ? mandatoryMatch[1] === 'true' : false;
              
              // Extract version range
              const versionRangeMatch = section.match(/versionRange\s*=\s*["']([^"']+)["']/);
              const versionRange = versionRangeMatch ? versionRangeMatch[1] : '*';
              
              dependencies.push({
                id: modId,
                dependency_type: isMandatory ? 'required' : 'optional',
                version_requirement: versionRange
              });
            }
          });
        }
        
        console.log(`[IPC:Mods] Extracted ${dependencies.length} dependencies from mods.toml`);
        return dependencies;
      }
      
      // Check for Quilt quilt.mod.json
      const quiltEntry = zipEntries.find(entry => 
        entry.entryName === 'quilt.mod.json' || 
        entry.entryName.endsWith('/quilt.mod.json')
      );
      
      if (quiltEntry) {
        console.log('[IPC:Mods] Found quilt.mod.json');
        const content = quiltEntry.getData().toString('utf8');
        try {
          const metadata = JSON.parse(content);
          
          // Extract dependencies
          const dependencies = [];
          
          // Check 'depends' field
          if (metadata.depends && Array.isArray(metadata.depends)) {
            metadata.depends.forEach(dep => {
              if (typeof dep === 'string') {
                dependencies.push({
                  id: dep,
                  dependency_type: 'required'
                });
              } else if (dep && dep.id) {
                dependencies.push({
                  id: dep.id,
                  dependency_type: 'required',
                  version_requirement: dep.versions || dep.version
                });
              }
            });
          }
          
          console.log(`[IPC:Mods] Extracted ${dependencies.length} dependencies from quilt.mod.json`);
          return dependencies;
        } catch (parseErr) {
          console.error('[IPC:Mods] Error parsing quilt.mod.json:', parseErr);
        }
      }
      
      console.log('[IPC:Mods] No recognized mod metadata found in JAR');
      return [];
    } catch (zipErr) {
      console.error('[IPC:Mods] Error processing JAR file:', zipErr);
      return [];
    }
  } catch (error) {
    console.error('[IPC:Mods] Failed to extract dependencies from JAR:', error);
    return [];
  }
}

// Add this function for downloading and analyzing mods directly
async function analyzeModFromUrl(url, modId) {
  try {
    console.log(`[IPC:Mods] Downloading and analyzing mod from URL: ${url}`);
    
    if (!url) {
      throw new Error('URL is required for mod analysis');
    }
    
    // Create a temporary directory for download
    const tempDir = path.join(os.tmpdir(), 'minecraft-core-temp');
    await fs.mkdir(tempDir, { recursive: true });
    const tempFile = path.join(tempDir, `temp-${modId || 'unknown'}.jar`);
    
    try {
      // Download the file
      const response = await axios({
        url: url,
        method: 'GET',
        responseType: 'arraybuffer'
      });
      
      // Save to temporary file
      await fs.writeFile(tempFile, response.data);
      
      // Extract dependencies from the JAR
      const dependencies = await extractDependenciesFromJar(tempFile);
      
      // Clean up
      try {
        await fs.unlink(tempFile);
      } catch (cleanupErr) {
        console.log(`[IPC:Mods] Error cleaning up temporary file: ${cleanupErr.message}`);
      }
      
      return dependencies;
    } catch (err) {
      console.error(`[IPC:Mods] Error downloading or analyzing mod from URL: ${err.message}`);
      
      // Clean up in case of error
      try {
        await fs.unlink(tempFile);
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
      
      throw err;
    }
  } catch (error) {
    console.error('[IPC:Mods] Failed to analyze mod from URL:', error);
    return [];
  }
}

// Install a mod to a client instance
async function installClientMod(modData) {
  console.log('[IPC:Mods] Installing mod to client:', modData.name, 'to path:', modData.clientPath);
  
  if (!modData.clientPath) {
    throw new Error('Client path is required for client mod installation');
  }
  
  if (!modData || !modData.id || !modData.name) {
    throw new Error('Invalid mod details (id, name) are required');
  }

  // Set up client mods directory
  const clientModsDir = path.join(modData.clientPath, 'mods');
  await fs.mkdir(clientModsDir, { recursive: true });

  // Set up client manifests directory
  const clientManifestDir = path.join(modData.clientPath, 'minecraft-core-manifests');
  await fs.mkdir(clientManifestDir, { recursive: true });

  // Sanitize mod name to create a valid filename
  const fileName = modData.name.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.jar';
  const targetPath = path.join(clientModsDir, fileName);
  
  console.log('[IPC:Mods] Client target path:', targetPath);

  // Check if mod already exists
  const fileExists = await fs.access(targetPath).then(() => true).catch(() => false);
  if (fileExists && !modData.forceReinstall) {
    console.log('[IPC:Mods] Mod already exists in client, skipping installation');
    return { success: true, message: 'Mod already installed' };
  }

  try {
    // Get mod versions to find the right download
    const loader = modData.loader || 'fabric';
    const mcVersion = modData.version || '1.20.1';
    
    console.log('[IPC:Mods] Getting mod versions for client installation:', {
      modId: modData.id,
      loader,
      mcVersion,
      selectedVersionId: modData.selectedVersionId
    });

    const versions = await getModrinthVersions(modData.id, loader, mcVersion);
    
    if (!versions || versions.length === 0) {
      throw new Error('No compatible versions found for this mod');
    }

    // Find the version to install
    let selectedVersion;
    if (modData.selectedVersionId) {
      selectedVersion = versions.find(v => v.id === modData.selectedVersionId);
      if (!selectedVersion) {
        throw new Error('Selected version not found or not compatible');
      }
    } else {
      selectedVersion = versions[0]; // Latest compatible version
    }

    console.log('[IPC:Mods] Selected version for client installation:', selectedVersion.versionNumber);

    // Get detailed version info
    const versionInfo = await getModrinthVersionInfo(modData.id, selectedVersion.id);
    
    if (!versionInfo.files || versionInfo.files.length === 0) {
      throw new Error('No files found for this mod version');
    }

    // Get the primary file
    const primaryFile = versionInfo.files.find(file => file.primary) || versionInfo.files[0];
    const downloadUrl = primaryFile.url;
    const actualFileName = primaryFile.filename;

    console.log('[IPC:Mods] Downloading mod file for client:', actualFileName);

    // Update target path with actual filename
    const actualTargetPath = path.join(clientModsDir, actualFileName);

    // Download the mod file
    const response = await axios({
      url: downloadUrl,
      method: 'GET',
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': 'minecraft-core/1.0.0'
      }
    });

    // Save to client mods directory
    const writer = createWriteStream(actualTargetPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log('[IPC:Mods] Successfully downloaded mod to client:', actualTargetPath);

    // Create manifest file for the mod
    const manifestData = {
      projectId: modData.id,
      versionId: selectedVersion.id,
      fileName: actualFileName,
      name: modData.name,
      title: modData.title || modData.name,
      versionNumber: selectedVersion.versionNumber,
      mcVersion: mcVersion,
      loader: loader,
      source: 'modrinth',
      downloadUrl: downloadUrl,
      installedAt: new Date().toISOString(),
      filePath: actualTargetPath,
      fileSize: primaryFile.size
    };

    const manifestPath = path.join(clientManifestDir, `${actualFileName}.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');

    console.log('[IPC:Mods] Created manifest for client mod:', manifestPath);

    return { 
      success: true, 
      fileName: actualFileName,
      version: selectedVersion.versionNumber,
      manifestPath
    };

  } catch (error) {
    console.error('[IPC:Mods] Error installing mod to client:', error);
    throw new Error(`Failed to install mod: ${error.message}`);
  }
}

module.exports = { createModHandlers };