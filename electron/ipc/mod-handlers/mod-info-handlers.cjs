const modApiService = require('../services/mod-api-service.cjs');
const modAnalysisUtils = require('../mod-utils/mod-analysis-utils.cjs');

function createModInfoHandlers() {
  return {
'search-mods': async (_event, { keyword, loader, version, source, page = 1, limit = 20, sortBy = 'popular' /* environmentType removed */ }) => {
  try {
    if (source === 'modrinth') {
      if (!keyword || keyword.trim() === '') {
        // Removed environmentType from getModrinthPopular call
        return await modApiService.getModrinthPopular({ loader, version, page, limit, sortBy });
      } else {
        // Removed environmentType from searchModrinthMods call
        return await modApiService.searchModrinthMods({ query: keyword, loader, version, page, limit, sortBy });
      }
    } else if (source === 'curseforge') {
       if (!keyword || keyword.trim() === '') {
        // Removed environmentType from getCurseForgePopular call
        return await modApiService.getCurseForgePopular({ loader, version, page, limit });
      } else {
        // Removed environmentType from searchCurseForgeMods call
        return await modApiService.searchCurseForgeMods({ query: keyword, loader, version, page, limit });
      }
    } else {
      throw new Error(`Invalid source: ${source}`);
    }
  } catch (error) {
    throw new Error(`Failed to search mods: ${error.message}`);
  }
},    'get-mod-versions': async (_event, { modId, loader, mcVersion, source, loadLatestOnly }) => {
  try {
    if (source === 'modrinth') {
      return await modApiService.getModrinthVersions(modId, loader, mcVersion, loadLatestOnly);
    } else {
      // Assuming CurseForge might be supported by modApiService in the future
      throw new Error('Only Modrinth version fetching is currently fully supported via modApiService.');
    }
  } catch (err) {
    // Provide more specific error messages for different types of failures
    if (err.message && err.message.includes('timeout')) {
      throw new Error(`Network timeout while fetching mod versions for ${modId}. Please check your internet connection and try again.`);
    } else if (err.message && err.message.includes('not found')) {
      throw new Error(`Mod not found: ${err.message}`);
    } else if (err.message && err.message.includes('API')) {
      throw new Error(`Modrinth API error: ${err.message}`);
    }
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
      // Not an error, version likely not found
    } else {
      // Log other errors if needed
    }
    
    // Provide more specific error messages for different types of failures
    if (err.message && err.message.includes('timeout')) {
      throw new Error(`Network timeout while fetching version info for ${modId}. Please check your internet connection and try again.`);
    } else if (err.message && err.message.includes('not found')) {
      throw new Error(`Version not found: ${err.message}`);
    } else if (err.message && err.message.includes('API')) {
      throw new Error(`Modrinth API error: ${err.message}`);
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
  if (!serverPath || !fs.existsSync(serverPath)) {
    throw new Error('Invalid server path');
  }
  if (!mcVersion || !fabricVersion) {
    throw new Error('Version information missing');
  }

  // Clear version cache to ensure fresh API calls for the new target version
  modApiService.clearVersionCache();

  const installed = await modFileManager.getInstalledModInfo(serverPath);
  const results = [];

  for (const mod of installed) {        const projectId = mod.projectId;
    const fileName = mod.fileName;
    const name = mod.name || mod.title || fileName;
    let currentVersion = mod.versionNumber || mod.version || null;
    
    // If no version found, try to extract from filename as fallback
    if (!currentVersion || currentVersion === 'Unknown') {
      currentVersion = extractVersionFromFilename(fileName) || 'Unknown';
    }

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
    }        try {          // Get ALL versions to check if the current version supports the target MC version
      const allVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, false);
      
      // Check if the current installed version is compatible with the target MC version
      const currentVersionCompatible = allVersions && allVersions.some(v => {
        const versionMatches = v.versionNumber === currentVersion;
        const supportsTargetMC = v.gameVersions && v.gameVersions.includes(mcVersion);
        
        return versionMatches && supportsTargetMC;
      });// Also get the latest version for update checking
      const latestVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, true);
      const latest = latestVersions && latestVersions[0];          if (currentVersionCompatible) {
        // Current version is compatible
        results.push({
          projectId,
          fileName,
          name,
          currentVersion,
          latestVersion: latest ? latest.versionNumber : currentVersion,
          compatible: true,
          dependencies: latest ? (latest.dependencies || []) : []
        });
      } else if (latest) {
        // Current version not compatible, but updates are available for target version
        results.push({
          projectId,
          fileName,
          name,
          currentVersion,
          latestVersion: latest.versionNumber,
          compatible: true, // Mark as compatible since updates are available
          hasUpdate: true, // Flag to indicate this mod needs updating
          dependencies: latest.dependencies || []
        });
      } else {
        // No compatible version found at all
        results.push({
          projectId,
          fileName,
          name,
          currentVersion,
          latestVersion: currentVersion,
          compatible: false,
          dependencies: []
        });
      }} catch (err) {
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
},

'install-mod': async (_event, serverPath, modDetails) => {
  // Pass 'win' object for progress reporting
  return await modInstallService.installModToServer(win, serverPath, modDetails);
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
  }
},    // Update a mod to a new version
'update-mod': async (_event, { serverPath, projectId, targetVersion, fileName }) => {
  try {
      // Step 1: Get the new version details
    const versions = await modApiService.getModrinthVersions(projectId, 'fabric', null, false);
    const targetVersionInfo = versions.find(v => v.versionNumber === targetVersion);
      if (!targetVersionInfo) {
      throw new Error(`Target version ${targetVersion} not found for mod ${projectId}`);
    }

    const completeVersionInfo = await modApiService.getModrinthVersionInfo(projectId, targetVersionInfo.id);

    // Step 2: Get the project info to get the proper display name
    const projectInfo = await modApiService.getModrinthProjectInfo(projectId);

    // Step 3: Install the new version (installation service will handle cleanup)
    const modDetails = {
      id: projectId,
      selectedVersionId: targetVersionInfo.id, // Use selectedVersionId instead of versionId
      name: projectInfo.title || completeVersionInfo.name || targetVersionInfo.name || projectId, // Use project title (display name) first
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
  };
}

module.exports = { createModInfoHandlers };
