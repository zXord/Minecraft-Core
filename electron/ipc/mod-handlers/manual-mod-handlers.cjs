const fs = require('fs');
const path = require('path');
const fsPromises = require('fs').promises;
const modApiService = require('../services/mod-api-service.cjs');
const { readModMetadata, checkModCompatibilityFromFilename, compareVersions } = require('./mod-handler-utils.cjs');

function createManualModHandlers() {
  return {
'get-manual-mods-detailed': async (_event, { clientPath, serverManagedFiles }) => {
  try {
    
    if (!clientPath || !fs.existsSync(clientPath)) {
      throw new Error('Invalid client path provided');
    }
    
    const modsDir = path.join(clientPath, 'mods');

    if (!fs.existsSync(modsDir)) {
      return { success: true, mods: [] };
    }

    const serverManagedFilesSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));
      // Load acknowledged dependencies from the client state
    let acknowledgedDependencies = new Set();
    try {
      const { loadExpectedModState } = require('./minecraft-launcher-handlers.cjs');
      const stateResult = await loadExpectedModState(clientPath);
      if (stateResult.success && stateResult.acknowledgedDeps) {
        acknowledgedDependencies = stateResult.acknowledgedDeps;
      }
    } catch {
      // Failed to load acknowledged dependencies, continue without them
    }

    const allFiles = fs.readdirSync(modsDir);
    const enabledFiles = allFiles.filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'));
    const disabledFiles = allFiles.filter(f => f.endsWith('.jar.disabled'))
      .map(f => f.replace('.disabled', '')); // Remove .disabled extension for processing

    const mods = [];
    // Process enabled mods
    for (const fileName of enabledFiles) {
      const fileNameLower = fileName.toLowerCase();
      const isServerManaged = serverManagedFilesSet.has(fileNameLower);
      const isAcknowledged = acknowledgedDependencies.has(fileNameLower);
        // Only skip if it's still server-managed AND not acknowledged
      // Acknowledged mods should appear in Client Downloaded even if server-managed
      if (isServerManaged && !isAcknowledged) {
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
      } catch {
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
      const fileNameLower = fileName.toLowerCase();
      const isServerManaged = serverManagedFilesSet.has(fileNameLower);
      const isAcknowledged = acknowledgedDependencies.has(fileNameLower);
      
      // Only skip if it's still server-managed AND not acknowledged
      // Acknowledged mods should appear in Client Downloaded even if server-managed
      if (isServerManaged && !isAcknowledged) {
        continue;
      }
      
      const filePath = path.join(modsDir, fileName + '.disabled');
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
      } catch {
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
},

// Check manual mods for basic compatibility
'check-manual-mods': async (_event, { clientPath, minecraftVersion }) => {
  try {
      if (!clientPath || !fs.existsSync(clientPath)) {
      throw new Error('Invalid client path provided');
    }
    
    // Get detailed mods directly using the same logic
    const modsDir = path.join(clientPath, 'mods');
    
    if (!fs.existsSync(modsDir)) {
      return { success: true, results: [] };
    }
    
    const allFiles = fs.readdirSync(modsDir);
    const enabledFiles = allFiles.filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'));
    const disabledFiles = allFiles.filter(f => f.endsWith('.jar.disabled'))
      .map(f => f.replace('.disabled', '')); // Remove .disabled extension for processing
    
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
      } catch {
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
      const filePath = path.join(modsDir, fileName + '.disabled');
      
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
      } catch {
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
          // Check for disabled mod with .disabled extension
          filePath = path.join(modsDir, fileName + '.disabled');
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
    
    let sourceFile, targetFile;
    
    if (enable) {
      // Enabling: removing .disabled extension
      sourceFile = path.join(modsDir, fileName + '.disabled');
      targetFile = path.join(modsDir, fileName);
      
      if (!fs.existsSync(sourceFile)) {
        throw new Error(`Disabled mod file not found: ${fileName}.disabled`);
      }
    } else {
      // Disabling: adding .disabled extension
      sourceFile = path.join(modsDir, fileName);
      targetFile = path.join(modsDir, fileName + '.disabled');
      
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
    
    // Find the current mod file
    let currentFilePath = path.join(modsDir, fileName);
    let isDisabled = false;
    
    if (!fs.existsSync(currentFilePath)) {
      currentFilePath = path.join(modsDir, fileName + '.disabled');
      isDisabled = true;
      
      if (!fs.existsSync(currentFilePath)) {
        throw new Error(`Mod file not found: ${fileName}`);
      }
    }
      // **FIX**: Keep the original filename instead of appending version
    // This maintains consistency with the original installation naming
    const newFileName = fileName; // Keep the same filename
    const targetPath = path.join(modsDir, newFileName + (isDisabled ? '.disabled' : ''));
    
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
      // **FIX**: Update the manifest file with new version information
    try {
      const manifestPath = path.join(clientPath, 'minecraft-core-manifests', `${fileName}.json`);
      if (fs.existsSync(manifestPath)) {
        const manifestContent = await fsPromises.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestContent);
        // Update the version in the manifest
        manifest.versionNumber = newVersion;
        manifest.updatedAt = new Date().toISOString();
        await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      }        } catch {
      // Ignore manifest update errors
    }
    
    // Remove old file if it's different (shouldn't be different now, but keeping for safety)
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
},

// Check for updates for manual mods
'check-manual-mod-updates': async (_event, { clientPath, minecraftVersion, serverManagedFiles }) => {
  try {
    if (!clientPath || !fs.existsSync(clientPath)) {
      throw new Error('Invalid client path provided');
    }
    
    const modsDir = path.join(clientPath, 'mods');
    
    if (!fs.existsSync(modsDir)) {
      return { success: true, updates: [], summary: { total: 0, updatesAvailable: 0 } };
    }
    
    const allFiles = fs.readdirSync(modsDir);
    const enabledFiles = allFiles.filter(f => f.endsWith('.jar') && !f.endsWith('.disabled'));
    const disabledFiles = allFiles.filter(f => f.endsWith('.jar.disabled'))
      .map(f => f.replace('.disabled', ''));
      const updates = [];
    const serverManagedFilesSet = new Set((serverManagedFiles || []).map(f => f.toLowerCase()));
    // Known problematic project IDs to skip - REMOVED to allow proper update checking
    // const badIds = ['forgeconfigapiport','xaerominimap'];
    const badIds = []; // Empty array to allow all mods to be checked// Process enabled mods
    for (const fileName of enabledFiles) {
      if (serverManagedFilesSet.has(fileName.toLowerCase())) continue;

      const filePath = path.join(modsDir, fileName);
      let metadata, currentVersion = 'Unknown';
      try {
        metadata = await readModMetadata(filePath);
        currentVersion = metadata?.version || 'Unknown';            // **FIX**: Try to get version from manifest file if available for better accuracy
        if (metadata && metadata.projectId) {
          const manifestPath = path.join(clientPath, 'minecraft-core-manifests', `${fileName}.json`);
          try {
            const manifestContent = await fsPromises.readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(manifestContent);
            
            // **FIX**: Use manifest data if available, regardless of project ID mismatch
            // The manifest has the correct Modrinth project ID and version
            if (manifest.projectId && manifest.versionNumber) {
              // Override metadata with manifest data for accurate version checking
              metadata.projectId = manifest.projectId;
              currentVersion = manifest.versionNumber;
            }              } catch {
            // Manifest doesn't exist or is corrupted, use JAR metadata version
          }
        }            
        // Skip known invalid project IDs
        if (metadata?.projectId && badIds.includes(metadata.projectId)) {
          updates.push({ fileName, hasUpdate: false, currentVersion, reason: 'Skipped invalid project ID' });
          continue;
        }            if (metadata && metadata.projectId) {
          const loader = metadata.loaderType === 'fabric' ? 'fabric' : (metadata.loaderType === 'forge' ? 'forge' : (metadata.loaderType === 'quilt' ? 'quilt' : 'fabric'));
          
          // Use the same approach as server-side: get all versions, then find the best one
          const allVersions = await modApiService.getModrinthVersions(metadata.projectId, loader, minecraftVersion, false);
          
          if (allVersions && allVersions.length > 0) {
            // Find stable versions first
            const stableVersions = allVersions.filter(v => v.isStable !== false);
            const versionsToCheck = stableVersions.length > 0 ? stableVersions : allVersions;
            
            // Sort by date (newest first) - same logic as server-side
            const sortedVersions = [...versionsToCheck].sort((a, b) => {
              const dateA = new Date(a.datePublished).getTime();
              const dateB = new Date(b.datePublished).getTime();
              return dateB - dateA;
            });                  const latestVersion = sortedVersions[0];
            
            // Use EXACT same comparison logic as server-side checkForUpdate function
            if (latestVersion && latestVersion.versionNumber !== currentVersion) {
              // Check if the latest version is actually newer using semantic versioning
              const versionComparison = compareVersions(latestVersion.versionNumber, currentVersion);
              
              if (versionComparison > 0) {
              // Get the actual version info for download URL
              const latestVersionInfo = await modApiService.getModrinthVersionInfo(metadata.projectId, latestVersion.id, minecraftVersion, loader);
              
              updates.push({
                fileName,
                hasUpdate: true,
                currentVersion,
                latestVersion: latestVersion.versionNumber,                    updateUrl: latestVersionInfo?.files?.[0]?.url || null,
                changelogUrl: latestVersionInfo?.changelog_url || null
              });
              } else {
                updates.push({ fileName, hasUpdate: false, currentVersion, latestVersion: latestVersion.versionNumber });
              }
            } else {
              updates.push({ fileName, hasUpdate: false, currentVersion, latestVersion: latestVersion.versionNumber });
            }
          } else {
            updates.push({ fileName, hasUpdate: false, currentVersion, reason: 'No compatible versions found' });
          }
        } else {
          updates.push({ fileName, hasUpdate: false, currentVersion, reason: 'No project ID available' });
        }
      } catch (modError) {
        // Treat missing Modrinth project (404) as no update
        if (modError.message.includes('Mod not found on Modrinth')) {
          updates.push({ fileName, hasUpdate: false, currentVersion, latestVersion: currentVersion, reason: 'Dependency missing, update skipped' });
        } else {
          updates.push({ fileName, hasUpdate: false, currentVersion, error: modError.message });
        }
      }
    }
    
    // Process disabled mods
    for (const fileName of disabledFiles) {
      if (serverManagedFilesSet.has(fileName.toLowerCase())) continue;          const filePath = path.join(modsDir, fileName + '.disabled');
      let metadata;
      let currentVersion = 'Unknown';
      try {
        metadata = await readModMetadata(filePath);
        currentVersion = metadata?.version || 'Unknown';            // **FIX**: Try to get version from manifest file if available for better accuracy
        if (metadata && metadata.projectId) {
          const manifestPath = path.join(clientPath, 'minecraft-core-manifests', `${fileName}.json`);
          try {
            const manifestContent = await fsPromises.readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(manifestContent);
            
            // **FIX**: Use manifest data if available, regardless of project ID mismatch
            // The manifest has the correct Modrinth project ID and version
            if (manifest.projectId && manifest.versionNumber) {
              // Override metadata with manifest data for accurate version checking
              metadata.projectId = manifest.projectId;
              currentVersion = manifest.versionNumber;
            }
          } catch {
            // Manifest doesn't exist or is corrupted, use JAR metadata version
          }
        }
        // Skip known invalid project IDs
        if (metadata?.projectId && badIds.includes(metadata.projectId)) {
          updates.push({ fileName, hasUpdate: false, currentVersion, reason: 'Skipped invalid project ID' });
          continue;
        }            if (metadata && metadata.projectId) {
          const loader = metadata.loaderType === 'fabric' ? 'fabric' : (metadata.loaderType === 'forge' ? 'forge' : (metadata.loaderType === 'quilt' ? 'quilt' : 'fabric'));
          
          // Use the same approach as server-side: get all versions, then find the best one
          const allVersions = await modApiService.getModrinthVersions(metadata.projectId, loader, minecraftVersion, false);
          
  };
}

module.exports = { createManualModHandlers };
