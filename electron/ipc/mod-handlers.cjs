// Mod management IPC handlers
const path = require('path'); // Keep for clientPath determination if needed by handlers directly
const fs = require('fs');
const { dialog, app } = require('electron'); // For dialogs & app paths

// Services and Utilities for Mod Management
const modApiService = require('../services/mod-api-service.cjs');
const modFileManager = require('./mod-utils/mod-file-manager.cjs');
const modInstallService = require('./mod-utils/mod-installation-service.cjs');
const modAnalysisUtils = require('./mod-utils/mod-analysis-utils.cjs');
const { downloadWithProgress } = require('../services/download-manager.cjs'); // Corrected import
const { disableMod, enableMod } = require('./mod-utils/mod-file-utils.cjs');
const { mainWindow } = require('../main.cjs'); // Import mainWindow

// fs/promises, axios, createWriteStream, pipeline, promisify, pipelineAsync are now mainly used within the services.
// If any handler directly needs them (e.g. a simple file op not covered by services), they can be re-added or operations moved.

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
        const result = await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Mod Files', extensions: ['jar'] }],
          title: 'Select Mod Files',
          defaultPath: app.getPath('downloads') // Start in downloads folder
        });
        
        if (result.canceled) {
          return [];
        }
        
        return result.filePaths;
      } catch (err) {
        throw new Error(`Failed to select mod files: ${err.message}`);
      }
    },

    // Process dropped files to get their paths
    'get-dropped-file-paths': async (_event, fileIdentifiers) => {
      try {
        
        if (!fileIdentifiers || !Array.isArray(fileIdentifiers) || !fileIdentifiers.length) {
          return [];
        }
        
        // Extract file paths from the dropped files
        const filePaths = fileIdentifiers
          .filter(file => file && file.path)
          .map(file => file.path);
          
        
        return filePaths;
      } catch (err) {
        throw new Error(`Failed to process dropped files: ${err.message}`);
      }
    },

    'list-mods': async (_event, serverPath) => {
      try {
        return await modFileManager.listMods(serverPath);
      } catch (err) {
        throw new Error(`Failed to list mods: ${err.message}`);
      }
    },

    'search-mods': async (_event, { keyword, loader, version, source, page = 1, limit = 20, sortBy = 'popular', environmentType = 'all' }) => {
      try {
        if (source === 'modrinth') {
          if (!keyword || keyword.trim() === '') {
            return await modApiService.getModrinthPopular({ loader, version, page, limit, sortBy, environmentType });
          } else {
            return await modApiService.searchModrinthMods({ query: keyword, loader, version, page, limit, sortBy, environmentType });
          }
        } else if (source === 'curseforge') {
           if (!keyword || keyword.trim() === '') {
            return await modApiService.getCurseForgePopular({ loader, version, page, limit, environmentType });
          } else {
            return await modApiService.searchCurseForgeMods({ query: keyword, loader, version, page, limit, environmentType });
          }
        } else {
          throw new Error(`Invalid source: ${source}`);
        }
      } catch (error) {
        throw new Error(`Failed to search mods: ${error.message}`);
      }
    },

    'get-mod-versions': async (_event, { modId, loader, mcVersion, source, loadLatestOnly }) => {
      try {
        if (source === 'modrinth') {
          return await modApiService.getModrinthVersions(modId, loader, mcVersion, loadLatestOnly);
        } else {
          // Assuming CurseForge might be supported by modApiService in the future
          throw new Error('Only Modrinth version fetching is currently fully supported via modApiService.');
        }
      } catch (err) {
        throw new Error(`Failed to get mod versions: ${err.message}`);
      }
    },
    
    'get-version-info': async (_event, { modId, versionId, source, gameVersion, loader }) => {
      try {
        if (source === 'modrinth') {
          return await modApiService.getModrinthVersionInfo(modId, versionId, gameVersion, loader);
        } else {
          throw new Error('Only Modrinth version info is currently fully supported via modApiService.');
        }
      } catch (err) {
        // Only log as error if it's not a 404 (which can be normal for missing/removed versions)
        if (err.message && err.message.includes('404')) {
        } else {
        }
        throw new Error(`Failed to get version info: ${err.message}`);
      }
    },
    
    'get-installed-mod-info': async (_event, serverPath) => {
      try {
        return await modFileManager.getInstalledModInfo(serverPath);
      } catch (err) {
        throw new Error(`Failed to get installed mod info: ${err.message}`);
      }
    },

    'get-client-installed-mod-info': async (_event, clientPath) => {
      try {
        return await modFileManager.getClientInstalledModInfo(clientPath);
      } catch (err) {
        throw new Error(`Failed to get client installed mod info: ${err.message}`);
      }
    },

    'save-disabled-mods': async (_event, serverPath, disabledMods) => {
      try {
        return await modFileManager.saveDisabledMods(serverPath, disabledMods);
      } catch (err) {
        throw new Error(`Failed to save disabled mods: ${err.message}`);
      }
    },
    
    'get-disabled-mods': async (_event, serverPath) => {
      try {
        return await modFileManager.getDisabledMods(serverPath);
      } catch (err) {
        throw new Error(`Failed to get disabled mods: ${err.message}`);
      }
    },    'check-mod-compatibility': async (_event, { serverPath, mcVersion, fabricVersion }) => {
      try {
        if (!serverPath || !fs.existsSync(serverPath)) {
          throw new Error('Invalid server path');
        }
        if (!mcVersion || !fabricVersion) {
          throw new Error('Version information missing');
        }

        const installed = await modFileManager.getInstalledModInfo(serverPath);
        const results = [];

        for (const mod of installed) {
          const projectId = mod.projectId;
          const fileName = mod.fileName;
          const name = mod.name || mod.title || fileName;
          const currentVersion = mod.versionNumber || mod.version || null;

          if (!projectId) {
            results.push({ 
              projectId: null, 
              fileName, 
              name, 
              currentVersion, 
              compatible: true, 
              dependencies: [] 
            });
            continue;
          }

          try {
            const versions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, true);
            const best = versions && versions[0];

            if (!best) {
              results.push({ 
                projectId, 
                fileName, 
                name, 
                currentVersion, 
                compatible: false 
              });
            } else {
              results.push({
                projectId,
                fileName,
                name,
                currentVersion,
                latestVersion: best.version_number,
                compatible: true,
                dependencies: best.dependencies || []
              });
            }
          } catch (err) {
            results.push({ 
              projectId, 
              fileName, 
              name, 
              currentVersion, 
              compatible: false, 
              error: err.message 
            });
          }
        }

        return results;
      } catch (err) {
        throw err;
      }
    },

    'install-mod': async (_event, serverPath, modDetails) => {
      try {
        // Pass 'win' object for progress reporting
        return await modInstallService.installModToServer(win, serverPath, modDetails);
      } catch (err) {
        // The service function should format the error appropriately
        throw err; // Re-throw the error to be caught by the invoker in the renderer
      }
    },

    'add-mod': async (_event, serverPath, modPath) => {
      try {
        return await modFileManager.addMod(serverPath, modPath);
      } catch (err) {
        throw new Error(`Failed to add mod: ${err.message}`);
      }
    },
      'delete-mod': async (_event, serverPath, modName) => {
      try {
        return await modFileManager.deleteMod(serverPath, modName);
      } catch (err) {
        throw new Error(`Failed to delete mod: ${err.message}`);
      }    },

    // Update a mod to a new version
    'update-mod': async (_event, { serverPath, projectId, targetVersion, fileName }) => {
      try {
          // Step 1: Get the new version details
        const versions = await modApiService.getModrinthVersions(projectId, 'fabric', null, false);
        const targetVersionInfo = versions.find(v => v.versionNumber === targetVersion);
          if (!targetVersionInfo) {
          throw new Error(`Target version ${targetVersion} not found for mod ${projectId}`);
        }

        const completeVersionInfo = await modApiService.getModrinthVersionInfo(projectId, targetVersionInfo.id);

        // Step 2: Install the new version (installation service will handle cleanup)
        const modDetails = {
          id: projectId,
          selectedVersionId: targetVersionInfo.id, // Use selectedVersionId instead of versionId
          name: completeVersionInfo.name || targetVersionInfo.name || projectId,
          fileName: completeVersionInfo.files[0]?.filename,
          downloadUrl: completeVersionInfo.files[0]?.url,
          version: targetVersion,
          source: 'modrinth',
          forceReinstall: true, // This flag triggers location detection and preservation
          oldFileName: fileName // Pass the old filename for proper location detection
        };

        const result = await modInstallService.installModToServer(win, serverPath, modDetails);
        
        return { 
          success: true, 
          modName: modDetails.name,
          oldFileName: fileName,
          newFileName: modDetails.fileName,
          version: targetVersion,
          result 
        };
        
      } catch (err) {
        throw new Error(`Failed to update mod: ${err.message}`);
      }
    },
    
    // Process dropped files directly
    'handle-dropped-files': async (_event, files) => {
      try {
        
        if (!files || !files.length) {
          return [];
        }
        
        // Get the file paths from the dropped files
        // The files object structure might vary based on how it was passed
        let filePaths = [];
        
        // Try different ways to extract paths
        if (Array.isArray(files)) {
          
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
        
        
        // Just return whatever paths we were able to extract
        // No fallback dialog needed
        return filePaths;
      } catch (err) {
        throw new Error(`Failed to process dropped files: ${err.message}`);
      }
    },
    
    'save-temp-file': async (_event, { name, buffer }) => {
      try {
        return await modFileManager.saveTemporaryFile({ name, buffer });
      } catch (err) {
        throw new Error(`Failed to save temporary file: ${err.message}`);
      }
    },

    'direct-add-mod': async (_event, { serverPath, fileName, buffer }) => {
      try {
        return await modFileManager.directAddMod({ serverPath, fileName, buffer });
      } catch (err) {
        throw new Error(`Failed to add mod: ${err.message}`);
      }
    },

    'get-mod-info': async (_event, { modId, source }) => {
      try {
        if (source === 'modrinth') {
          return await modApiService.getModInfo(modId, source);
        } else {
          throw new Error('Only Modrinth mod info is currently fully supported via modApiService.');
        }
      } catch (err) {
        throw new Error(`Failed to get mod info: ${err.message}`);
      }
    },

    'get-project-info': async (_event, { projectId, source }) => {
      try {
        if (source === 'modrinth') {
          return await modApiService.getModrinthProjectInfo(projectId);
        } else {
          throw new Error('Only Modrinth project info is currently fully supported via modApiService.');
        }
      } catch (err) {
        throw new Error(`Failed to get project info: ${err.message}`);
      }
    },

    'extract-jar-dependencies': async (_event, modPath) => {
      try {
        return await modAnalysisUtils.extractDependenciesFromJar(modPath);
      } catch (error) {
        throw new Error(`Failed to extract dependencies: ${error.message}`);
      }
    },

    'analyze-mod-from-url': async (_event, { url, modId }) => {
      try {
        return await modAnalysisUtils.analyzeModFromUrl(url, modId);
      } catch (error) {
        throw new Error(`Failed to analyze mod: ${error.message}`);
      }
    },

    'save-mod-categories': async (_event, categories, serverPath, clientPath) => {
      try {
        // First, save the categories to the store
        const storeSuccess = modFileManager.modCategoriesStore.set(categories);
        if (!storeSuccess) {
        }

        // If serverPath is provided, proceed with physical file movements
        // This part needs to be carefully considered. The original 'save-mod-categories'
        // had complex logic for moving files and their manifests.
        // We'll assume for now that individual 'move-mod-file' calls or a dedicated
        // batch operation in modFileManager would handle this.
        // For this refactoring step, we'll just call the store set.
        // A more complete solution might involve iterating `categories` and calling `moveModFile`
        // for each mod that changed its category, or a new batch function in modFileManager.
        if (serverPath) {
            // Example of how one might trigger moves (conceptual):
            // for (const modCat of categories) {
            //   // Determine old category if possible, then call moveModFile
            //   // This requires more state than available here.
            // }
        }
        return { success: true, message: "Categories saved to store. File moves require separate/refined logic." };

      } catch (error) {
        throw new Error(`Failed to save mod categories: ${error.message}`);
      }
    },
    
    'get-mod-categories': async () => {
      try {
        return modFileManager.modCategoriesStore.get() || [];
      } catch (error) {
        throw new Error(`Failed to get mod categories: ${error.message}`);
      }
    },

    'move-mod-file': async (_event, { fileName, newCategory, serverPath }) => {
      try {
        return await modFileManager.moveModFile({ fileName, newCategory, serverPath });
      } catch (err) {
        throw new Error(`Failed to move mod file: ${err.message}`);
      }
    },    'install-client-mod': async (_event, modData) => {
      try {
        // Pass 'win' object for progress reporting, if the service function is adapted for it
        // The service function currently doesn't take 'win', but it could be added
        // or a callback mechanism implemented. For now, passing win as per general plan.
        return await modInstallService.installModToClient(win, modData);
      } catch (error) {
        throw error; // Re-throw the error
      }
    },

    // Check client-side mod compatibility with new Minecraft version
    'check-client-mod-compatibility': async (_event, options) => {
      try {
        const { newMinecraftVersion, clientPath } = options;
        
        if (!clientPath || !fs.existsSync(clientPath)) {
          throw new Error('Invalid client path provided');
        }
        
        // Get list of client-side mods (manual mods)
        const clientMods = await getClientSideMods(clientPath);
        
        // Check compatibility for each mod
        const compatibilityResults = [];
        
        for (const mod of clientMods) {
          try {
            let compatibilityStatus = 'unknown';
            let reason = '';
            let availableUpdate = null;
            
            // Try to get mod metadata for better compatibility checking
            const modPath = path.join(clientPath, 'mods', mod.fileName);
            const metadata = await readModMetadata(modPath);
            
            if (metadata && metadata.gameVersions) {
              // Check if mod supports the new Minecraft version
              const isCompatible = metadata.gameVersions.includes(newMinecraftVersion);
              
              if (isCompatible) {
                compatibilityStatus = 'compatible';
              } else {
                compatibilityStatus = 'incompatible';
                reason = `Does not support Minecraft ${newMinecraftVersion}. Supported versions: ${metadata.gameVersions.join(', ')}`;
                
                // Try to find available updates
                if (metadata.projectId) {
                  try {
                    const updateInfo = await modApiService.checkModUpdate(metadata.projectId, {
                      currentVersion: metadata.version,
                      gameVersion: newMinecraftVersion,
                      source: metadata.source || 'modrinth'
                    });
                    
                    if (updateInfo && updateInfo.hasUpdate) {
                      compatibilityStatus = 'needs_update';
                      availableUpdate = updateInfo;
                      reason = `Update available for Minecraft ${newMinecraftVersion}`;
                    }
                  } catch (updateError) {
                  }
                }
              }
            } else {
              // Fallback to filename-based checking
              const filenameCheck = checkModCompatibilityFromFilename(mod.fileName, newMinecraftVersion);
              if (filenameCheck.isCompatible) {
                compatibilityStatus = 'compatible';
                reason = 'Compatibility determined from filename';
              } else {
                compatibilityStatus = 'unknown';
                reason = 'Unable to determine compatibility - manual verification recommended';
              }
            }
            
            compatibilityResults.push({
              fileName: mod.fileName,
              name: metadata?.name || mod.fileName,
              compatibilityStatus,
              reason,
              availableUpdate,
              metadata
            });
            
          } catch (modError) {
            compatibilityResults.push({
              fileName: mod.fileName,
              name: mod.fileName,
              compatibilityStatus: 'error',
              reason: `Error checking compatibility: ${modError.message}`
            });
          }
        }
        
        // Categorize results
        const report = {
          compatible: compatibilityResults.filter(r => r.compatibilityStatus === 'compatible'),
          incompatible: compatibilityResults.filter(r => r.compatibilityStatus === 'incompatible'),
          needsUpdate: compatibilityResults.filter(r => r.compatibilityStatus === 'needs_update'),
          unknown: compatibilityResults.filter(r => r.compatibilityStatus === 'unknown'),
          errors: compatibilityResults.filter(r => r.compatibilityStatus === 'error'),
          hasIncompatible: false,
          hasUpdatable: false
        };
        
        report.hasIncompatible = report.incompatible.length > 0;
        report.hasUpdatable = report.needsUpdate.length > 0;
          return report;
        
      } catch (error) {
        throw new Error(`Failed to check client mod compatibility: ${error.message}`);
      }
    },    // Update a client-side mod to a newer version
    'update-client-mod': async (_event, { modInfo, clientPath }) => {
      try {
        
        if (!modInfo.downloadUrl) {
          throw new Error('No download URL available for mod update');
        }
        
        const fs = require('fs').promises;
        const path = require('path');
        const axios = require('axios');
        const { createWriteStream } = require('fs');
        const { pipeline } = require('stream');
        const { promisify } = require('util');
        const pipelineAsync = promisify(pipeline);
        
        const modsDir = path.join(clientPath, 'mods');
        await fs.mkdir(modsDir, { recursive: true });
        
        // Generate a safe filename
        const sanitizedName = modInfo.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const fileName = sanitizedName.endsWith('.jar') ? sanitizedName : `${sanitizedName}.jar`;
        const targetPath = path.join(modsDir, fileName);
        
        // Download the updated mod
        const writer = createWriteStream(targetPath);
        const response = await axios({
          url: modInfo.downloadUrl,
          method: 'GET',
          responseType: 'stream',
          timeout: 60000
        });
        
        await pipelineAsync(response.data, writer);
        
        // If the old mod file exists and has a different name, remove it
        if (modInfo.currentFilePath && require('fs').existsSync(modInfo.currentFilePath)) {
          const oldFileName = path.basename(modInfo.currentFilePath);
          const newFileName = path.basename(targetPath);
          
          if (oldFileName !== newFileName) {
            await fs.unlink(modInfo.currentFilePath);
          }
        }
        
        return { success: true, filePath: targetPath };
        
      } catch (error) {
        throw new Error(`Failed to update mod "${modInfo.name}": ${error.message}`);
      }
    },    // Disable a client-side mod by moving it to disabled folder
    'disable-client-mod': async (_event, { modFilePath, clientPath }) => {
      try {
        
        if (!fs.existsSync(modFilePath)) {
          throw new Error('Mod file not found');
        }
        
        const modsDir = path.join(clientPath, 'mods');
        const disabledDir = path.join(modsDir, 'disabled');
        
        // Create disabled directory if it doesn't exist
        if (!fs.existsSync(disabledDir)) {
          fs.mkdirSync(disabledDir, { recursive: true });
        }
        
        const fileName = path.basename(modFilePath);
        const disabledPath = path.join(disabledDir, fileName);
        
        // Move the mod file to the disabled directory
        fs.renameSync(modFilePath, disabledPath);
        
        return { success: true, disabledPath };
        
      } catch (error) {
        throw new Error(`Failed to disable mod: ${error.message}`);
      }
    },

    // Get detailed information about manual mods
    'get-manual-mods-detailed': async (_event, { clientPath, serverManagedFiles }) => {
      try {

        if (!clientPath || !fs.existsSync(clientPath)) {
          throw new Error('Invalid client path provided');
        }

        const modsDir = path.join(clientPath, 'mods');
        const disabledDir = path.join(modsDir, 'disabled');

        if (!fs.existsSync(modsDir)) {
          return { success: true, mods: [] };
        }

        const serverManagedFilesSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));

        const enabledFiles = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')) : [];
        const disabledFiles = fs.existsSync(disabledDir) ? fs.readdirSync(disabledDir).filter(f => f.endsWith('.jar')) : [];

        const mods = [];

        // Process enabled mods
        for (const fileName of enabledFiles) {
          if (serverManagedFilesSet.has(fileName.toLowerCase())) {
            continue;
          }
          const filePath = path.join(modsDir, fileName);
          const stats = fs.statSync(filePath);

          try {
            const metadata = await readModMetadata(filePath);
            mods.push({
              fileName,
              name: metadata?.name || fileName.replace(/\.jar$/i, ''),
              version: metadata?.version || 'Unknown', // Use metadata version
              authors: metadata?.authors || [],
              description: metadata?.description || '',
              projectId: metadata?.projectId || null,
              loaderType: metadata?.loaderType || 'Unknown',
              gameVersions: metadata?.gameVersions || [],
              size: stats.size,
              lastModified: stats.mtime,
              enabled: true
            });
          } catch (metadataError) {
            mods.push({
              fileName,
              name: fileName.replace(/\.jar$/i, ''),
              version: 'Unknown', // Fallback version
              authors: [],
              description: '',
              projectId: null,
              loaderType: 'Unknown',
              gameVersions: [],
              size: stats.size,
              lastModified: stats.mtime,
              enabled: true
            });
          }
        }

        // Process disabled mods
        for (const fileName of disabledFiles) {
          if (serverManagedFilesSet.has(fileName.toLowerCase())) {
            continue;
          }
          const filePath = path.join(disabledDir, fileName);
          const stats = fs.statSync(filePath);

          try {
            const metadata = await readModMetadata(filePath);
            mods.push({
              fileName,
              name: metadata?.name || fileName.replace(/\.jar$/i, ''),
              version: metadata?.version || 'Unknown', // Use metadata version
              authors: metadata?.authors || [],
              description: metadata?.description || '',
              projectId: metadata?.projectId || null,
              loaderType: metadata?.loaderType || 'Unknown',
              gameVersions: metadata?.gameVersions || [],
              size: stats.size,
              lastModified: stats.mtime,
              enabled: false
            });
          } catch (metadataError) {
            mods.push({
              fileName,
              name: fileName.replace(/\.jar$/i, ''),
              version: 'Unknown', // Fallback version
              authors: [],
              description: '',
              projectId: null,
              loaderType: 'Unknown',
              gameVersions: [],
              size: stats.size,
              lastModified: stats.mtime,
              enabled: false
            });
          }
        }
        
        return { success: true, mods };

      } catch (error) {
        return { success: false, error: error.message, mods: [] };
      }
    },    // Check manual mods for basic compatibility
    'check-manual-mods': async (_event, { clientPath, minecraftVersion }) => {
      try {
        
        if (!clientPath || !fs.existsSync(clientPath)) {
          throw new Error('Invalid client path provided');
        }
        
        // Get detailed mods directly using the same logic
        const modsDir = path.join(clientPath, 'mods');
        const disabledDir = path.join(modsDir, 'disabled');
        
        if (!fs.existsSync(modsDir)) {
          return { success: true, results: [] };
        }
        
        const enabledFiles = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')) : [];
        const disabledFiles = fs.existsSync(disabledDir) ? fs.readdirSync(disabledDir).filter(f => f.endsWith('.jar')) : [];
        
        const compatibilityResults = [];
        
        // Process enabled mods
        for (const fileName of enabledFiles) {
          const filePath = path.join(modsDir, fileName);
          
          try {
            const metadata = await readModMetadata(filePath);
            let status = 'unknown';
            let reason = '';
            
            if (metadata && metadata.gameVersions && metadata.gameVersions.length > 0) {
              const isCompatible = metadata.gameVersions.includes(minecraftVersion);
              status = isCompatible ? 'compatible' : 'incompatible';
              reason = isCompatible ? 
                `Supports Minecraft ${minecraftVersion}` : 
                `Does not support Minecraft ${minecraftVersion}. Supported: ${metadata.gameVersions.join(', ')}`;
            } else {
              // Fallback to filename-based checking
              const filenameCheck = checkModCompatibilityFromFilename(fileName, minecraftVersion);
              status = filenameCheck.isCompatible ? 'compatible' : 'unknown';
              reason = filenameCheck.isCompatible ? 
                'Compatibility determined from filename' : 
                'Unable to determine compatibility';
            }
            
            compatibilityResults.push({
              fileName,
              name: metadata?.name || fileName.replace(/\.jar$/i, ''),
              status,
              reason,
              enabled: true
            });
          } catch (metadataError) {
            compatibilityResults.push({
              fileName,
              name: fileName.replace(/\.jar$/i, ''),
              status: 'unknown',
              reason: 'Unable to read mod metadata',
              enabled: true
            });
          }
        }
        
        // Process disabled mods
        for (const fileName of disabledFiles) {
          const filePath = path.join(disabledDir, fileName);
          
          try {
            const metadata = await readModMetadata(filePath);
            let status = 'unknown';
            let reason = '';
            
            if (metadata && metadata.gameVersions && metadata.gameVersions.length > 0) {
              const isCompatible = metadata.gameVersions.includes(minecraftVersion);
              status = isCompatible ? 'compatible' : 'incompatible';
              reason = isCompatible ? 
                `Supports Minecraft ${minecraftVersion}` : 
                `Does not support Minecraft ${minecraftVersion}. Supported: ${metadata.gameVersions.join(', ')}`;
            } else {
              // Fallback to filename-based checking
              const filenameCheck = checkModCompatibilityFromFilename(fileName, minecraftVersion);
              status = filenameCheck.isCompatible ? 'compatible' : 'unknown';
              reason = filenameCheck.isCompatible ? 
                'Compatibility determined from filename' : 
                'Unable to determine compatibility';
            }
            
            compatibilityResults.push({
              fileName,
              name: metadata?.name || fileName.replace(/\.jar$/i, ''),
              status,
              reason,
              enabled: false
            });
          } catch (metadataError) {
            compatibilityResults.push({
              fileName,
              name: fileName.replace(/\.jar$/i, ''),
              status: 'unknown',
              reason: 'Unable to read mod metadata',
              enabled: false
            });
          }
        }
        
        return { success: true, results: compatibilityResults };
        
      } catch (error) {
        return { success: false, error: error.message, results: [] };
      }
    },

    // Remove manual mods
    'remove-manual-mods': async (_event, { clientPath, fileNames }) => {
      try {
        
        if (!clientPath || !fs.existsSync(clientPath)) {
          throw new Error('Invalid client path provided');
        }
        
        if (!Array.isArray(fileNames) || fileNames.length === 0) {
          throw new Error('No file names provided');
        }
        
        const modsDir = path.join(clientPath, 'mods');
        const disabledDir = path.join(modsDir, 'disabled');
        const removedFiles = [];
        const errors = [];
        
        for (const fileName of fileNames) {
          try {
            let filePath = path.join(modsDir, fileName);
            let found = false;
            
            // Check in enabled mods directory
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              removedFiles.push({ fileName, location: 'enabled' });
              found = true;
            } else {
              // Check in disabled mods directory
              filePath = path.join(disabledDir, fileName);
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                removedFiles.push({ fileName, location: 'disabled' });
                found = true;
              }
            }
            
            if (!found) {
              errors.push({ fileName, error: 'File not found' });
            }
          } catch (fileError) {
            errors.push({ fileName, error: fileError.message });
          }
        }
        
        return { 
          success: errors.length === 0, 
          removedFiles, 
          errors,
          message: errors.length === 0 ? 'All mods removed successfully' : `${removedFiles.length} mods removed, ${errors.length} failed`
        };
        
      } catch (error) {
        return { success: false, error: error.message, removedFiles: [], errors: [] };
      }
    },

    // Toggle manual mod enabled/disabled state
    'toggle-manual-mod': async (_event, { clientPath, fileName, enable }) => {
      try {
        
        if (!clientPath || !fs.existsSync(clientPath)) {
          throw new Error('Invalid client path provided');
        }
        
        const modsDir = path.join(clientPath, 'mods');
        const disabledDir = path.join(modsDir, 'disabled');
        
        // Ensure disabled directory exists
        if (!fs.existsSync(disabledDir)) {
          fs.mkdirSync(disabledDir, { recursive: true });
        }
        
        let sourceFile, targetFile;
        
        if (enable) {
          // Moving from disabled to enabled
          sourceFile = path.join(disabledDir, fileName);
          targetFile = path.join(modsDir, fileName);
          
          if (!fs.existsSync(sourceFile)) {
            throw new Error(`Disabled mod file not found: ${fileName}`);
          }
        } else {
          // Moving from enabled to disabled
          sourceFile = path.join(modsDir, fileName);
          targetFile = path.join(disabledDir, fileName);
          
          if (!fs.existsSync(sourceFile)) {
            throw new Error(`Enabled mod file not found: ${fileName}`);
          }
        }
        
        // Check if target already exists
        if (fs.existsSync(targetFile)) {
          throw new Error(`Target file already exists: ${path.basename(targetFile)}`);
        }
        
        // Move the file
        fs.renameSync(sourceFile, targetFile);
        
        return { 
          success: true, 
          message: `Mod ${enable ? 'enabled' : 'disabled'} successfully`,
          newPath: targetFile
        };
        
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Update a manual mod to a newer version
    'update-manual-mod': async (_event, { clientPath, fileName, newVersion, downloadUrl }) => {
      try {
        
        if (!clientPath || !fs.existsSync(clientPath)) {
          throw new Error('Invalid client path provided');
        }
        
        if (!downloadUrl) {
          throw new Error('Download URL is required for mod update');
        }
        
        const axios = require('axios');
        const { createWriteStream } = require('fs');
        const { pipeline } = require('stream');
        const { promisify } = require('util');
        const pipelineAsync = promisify(pipeline);
        
        const modsDir = path.join(clientPath, 'mods');
        const disabledDir = path.join(modsDir, 'disabled');
        
        // Find the current mod file
        let currentFilePath = path.join(modsDir, fileName);
        let isDisabled = false;
        
        if (!fs.existsSync(currentFilePath)) {
          currentFilePath = path.join(disabledDir, fileName);
          isDisabled = true;
          
          if (!fs.existsSync(currentFilePath)) {
            throw new Error(`Mod file not found: ${fileName}`);
          }
        }
        
        // Generate new filename with version if provided
        const baseName = fileName.replace(/\.jar$/i, '');
        const newFileName = newVersion ? `${baseName}-${newVersion}.jar` : fileName;
        const targetDir = isDisabled ? disabledDir : modsDir;
        const targetPath = path.join(targetDir, newFileName);
        
        // Download the new version
        const writer = createWriteStream(targetPath);
        const response = await axios({
          url: downloadUrl,
          method: 'GET',
          responseType: 'stream',
          timeout: 60000,
          headers: {
            'User-Agent': 'MinecraftModManager/1.0'
          }
        });
        
        await pipelineAsync(response.data, writer);
        
        // Remove old file if name changed
        if (currentFilePath !== targetPath && fs.existsSync(currentFilePath)) {
          fs.unlinkSync(currentFilePath);
        }
        
        return { 
          success: true, 
          message: `Mod updated to version ${newVersion}`,
          newFileName: newFileName,
          newPath: targetPath
        };
        
      } catch (error) {
        return { success: false, error: error.message };
      }
    },    // Check for updates for manual mods
    'check-manual-mod-updates': async (_event, { clientPath, minecraftVersion, serverManagedFiles }) => {
      try {

        if (!clientPath || !fs.existsSync(clientPath)) {
          throw new Error('Invalid client path provided');
        }
        if (!minecraftVersion) {
        }
        
        const modsDir = path.join(clientPath, 'mods');
        const disabledDir = path.join(modsDir, 'disabled');
        
        if (!fs.existsSync(modsDir)) {
          return { success: true, updates: [], summary: { total: 0, updatesAvailable: 0 } };
        }
        
        const enabledFiles = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')) : [];
        const disabledFiles = fs.existsSync(disabledDir) ? fs.readdirSync(disabledDir).filter(f => f.endsWith('.jar')) : [];
        
        const updates = [];
        // Use the passed serverManagedFiles array
        const serverManagedFilesSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));

        // Process enabled mods
        for (const fileName of enabledFiles) {
          if (serverManagedFilesSet.has(fileName.toLowerCase())) continue; // Skip server managed

          const filePath = path.join(modsDir, fileName);
          
          try {
            const metadata = await readModMetadata(filePath);
            
            if (metadata && metadata.projectId) {
              
              const loader = metadata.loaderType === 'fabric' ? 'fabric' : (metadata.loaderType === 'forge' ? 'forge' : (metadata.loaderType === 'quilt' ? 'quilt' : 'fabric'));
              const latestInfo = await modApiService.getLatestModrinthVersionInfo(metadata.projectId, minecraftVersion, loader);
              
              if (latestInfo && latestInfo.version_number !== metadata.version) {
                updates.push({
                  fileName,
                  hasUpdate: true,
                  currentVersion: metadata.version,
                  latestVersion: latestInfo.version_number,
                  updateUrl: latestInfo.files?.[0]?.url || null,
                  changelogUrl: latestInfo.changelog_url || null
                });
              } else {
                updates.push({
                  fileName,
                  hasUpdate: false,
                  currentVersion: metadata.version,
                  latestVersion: metadata.version
                });
              }
            } else {
              // No project ID, can't check for updates
              updates.push({
                fileName,
                hasUpdate: false,
                currentVersion: metadata?.version || 'Unknown',
                reason: 'No project ID available'
              });
            }
          } catch (modError) {
            updates.push({
              fileName,
              hasUpdate: false,
              currentVersion: 'Unknown',
              error: modError.message
            });
          }
        }
        
        // Process disabled mods
        for (const fileName of disabledFiles) {
          if (serverManagedFilesSet.has(fileName.toLowerCase())) continue; // Skip server managed

          const filePath = path.join(disabledDir, fileName);
          
          try {
            const metadata = await readModMetadata(filePath);
            
            if (metadata && metadata.projectId) {
              
              const loader = metadata.loaderType === 'fabric' ? 'fabric' : (metadata.loaderType === 'forge' ? 'forge' : (metadata.loaderType === 'quilt' ? 'quilt' : 'fabric'));
              const latestInfo = await modApiService.getLatestModrinthVersionInfo(metadata.projectId, minecraftVersion, loader);
              
              if (latestInfo && latestInfo.version_number !== metadata.version) {
                updates.push({
                  fileName,
                  hasUpdate: true,
                  currentVersion: metadata.version,
                  latestVersion: latestInfo.version_number,
                  updateUrl: latestInfo.files?.[0]?.url || null,
                  changelogUrl: latestInfo.changelog_url || null
                });
              } else {
                updates.push({
                  fileName,
                  hasUpdate: false,
                  currentVersion: metadata.version,
                  latestVersion: metadata.version
                });
              }
            } else {
              // No project ID, can't check for updates
              updates.push({
                fileName,
                hasUpdate: false,
                currentVersion: metadata?.version || 'Unknown',
                reason: 'No project ID available'
              });
            }
          } catch (modError) {
            updates.push({
              fileName,
              hasUpdate: false,
              currentVersion: 'Unknown',
              error: modError.message
            });
          }
        }
        
        const updatesAvailable = updates.filter(u => u.hasUpdate).length;
        
        return { 
          success: true, 
          updates,
          summary: {
            total: updates.length,
            updatesAvailable
          }
        };
        
      } catch (error) {
        return { success: false, error: error.message, updates: [] };
      }
    },

    // Update multiple client-side mods to new versions
    'update-client-mods': async (_event, { mods, clientPath, minecraftVersion, loaderType }) => {
      try {
        
        if (!mods || !Array.isArray(mods) || mods.length === 0) {
          return { success: false, error: 'No mods specified for update.', updatedCount: 0 };
        }
        if (!clientPath) {
          return { success: false, error: 'Client path not provided.', updatedCount: 0 };
        }
        if (!minecraftVersion) {
          return { success: false, error: 'Minecraft version not provided.', updatedCount: 0 };
        }

        const modsDir = path.join(clientPath, 'mods');
        if (!fs.existsSync(modsDir)) {
          fs.mkdirSync(modsDir, { recursive: true });
        }

        let updatedCount = 0;
        const errors = [];

        for (const modToUpdate of mods) {
          try {
            if (!modToUpdate.newVersionDetails || !modToUpdate.newVersionDetails.files || modToUpdate.newVersionDetails.files.length === 0) {
              throw new Error(`No suitable file found for ${modToUpdate.name || modToUpdate.fileName} for MC ${minecraftVersion}`);
            }

            // Find the primary file (usually a .jar)
            const primaryFile = modToUpdate.newVersionDetails.files.find(f => f.primary && f.url);
            const fileToDownload = primaryFile || modToUpdate.newVersionDetails.files.find(f => f.url && f.filename.endsWith('.jar')) || modToUpdate.newVersionDetails.files[0];

            if (!fileToDownload || !fileToDownload.url) {
              throw new Error(`Could not determine download URL for ${modToUpdate.name || modToUpdate.fileName}`);
            }

            const oldFileName = modToUpdate.fileName;
            const newFileName = fileToDownload.filename;

            // Disable old mod file (rename to .disabled)
            if (oldFileName && fs.existsSync(path.join(modsDir, oldFileName))) {
              await disableMod(modsDir, oldFileName);
            }

            // Download new mod file
            await downloadWithProgress(fileToDownload.url, modsDir, newFileName, fileToDownload.hashes?.sha512 || fileToDownload.hashes?.sha1);
            updatedCount++;

          } catch (error) {
            errors.push(`${modToUpdate.name || modToUpdate.fileName}: ${error.message}`);
          }
        }

        if (errors.length > 0) {
          return { success: updatedCount > 0, updatedCount, error: `Some mods failed to update. Errors: ${errors.join('; ')}` };
        }
        return { success: true, updatedCount };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },

    // Disable multiple client-side mods
    'disable-client-mods': async (_event, { mods, clientPath }) => {
      try {
        
        if (!mods || !Array.isArray(mods) || mods.length === 0) {
          return { success: false, error: 'No mods specified for disabling.', disabledCount: 0 };
        }
        if (!clientPath) {
          return { success: false, error: 'Client path not provided.', disabledCount: 0 };
        }

        const modsDir = path.join(clientPath, 'mods');
        if (!fs.existsSync(modsDir)) {
          // If mods directory doesn't exist, there's nothing to disable.
          return { success: true, disabledCount: 0, message: 'Mods directory does not exist.' };
        }

        let disabledCount = 0;
        const errors = [];

        for (const modToDisable of mods) {
          try {
            if (!modToDisable.fileName) {
              throw new Error('Mod filename not provided for disabling.');
            }
            const modPath = path.join(modsDir, modToDisable.fileName);
            if (fs.existsSync(modPath)) {
              await disableMod(modsDir, modToDisable.fileName);
              disabledCount++;
            } else {
              // Optionally, count this as a non-error if the goal is to ensure it's disabled
            }
          } catch (error) {
            errors.push(`${modToDisable.fileName}: ${error.message}`);
          }
        }

        if (errors.length > 0) {
          return { success: disabledCount > 0, disabledCount, error: `Some mods failed to disable. Errors: ${errors.join('; ')}` };
        }
        return { success: true, disabledCount };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  };
}

/**
 * Read mod metadata from a JAR file
 * @param {string} filePath - Path to the mod JAR file
 * @returns {Promise<Object|null>} - Mod metadata or null if not readable
 */
async function readModMetadata(filePath) {
  try {
    const result = await modAnalysisUtils.extractDependenciesFromJar(filePath);
    return result;
  } catch (error) {
    return null;
  }
}

/**
 * Get list of client-side mods (manual mods)
 * @param {string} clientPath - Path to the client directory
 * @returns {Promise<Array>} - Array of client-side mods
 */
async function getClientSideMods(clientPath) {
  const modsDir = path.join(clientPath, 'mods');
  
  if (!fs.existsSync(modsDir)) {
    return [];
  }
  
  const files = fs.readdirSync(modsDir);
  const jarFiles = files.filter(file => file.endsWith('.jar'));
  
  // Filter to get only manual/client-side mods
  // We can identify these by checking if they're in the manual mods list or not in server mods
  const clientMods = [];
  
  for (const fileName of jarFiles) {
    // For now, treat all mods as potential client-side mods
    // In a more sophisticated implementation, we could check against server mod lists
    clientMods.push({
      fileName,
      filePath: path.join(modsDir, fileName),
      lastModified: fs.statSync(path.join(modsDir, fileName)).mtime
    });
  }
  
  return clientMods;
}

/**
 * Check mod compatibility based on filename
 * @param {string} filename - The mod filename
 * @param {string} minecraftVersion - Target Minecraft version
 * @returns {Object} - Compatibility result
 */
function checkModCompatibilityFromFilename(filename, minecraftVersion) {
  if (!filename || !minecraftVersion) {
    return { isCompatible: false, confidence: 'low' };
  }
  
  const lowerFilename = filename.toLowerCase();
  const versionPattern = /(\d+\.\d+(?:\.\d+)?)/g;
  const matches = lowerFilename.match(versionPattern);
  
  if (!matches) {
    return { isCompatible: false, confidence: 'low' };
  }
  
  // Check if the target Minecraft version appears in the filename
  for (const match of matches) {
    if (match === minecraftVersion || minecraftVersion.startsWith(match)) {
      return { isCompatible: true, confidence: 'medium' };
    }
  }
  
  return { isCompatible: false, confidence: 'medium' };
}

module.exports = { createModHandlers };
