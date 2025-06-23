const fs = require('fs');
const modApiService = require('../../services/mod-api-service.cjs');
const modFileManager = require('../mod-utils/mod-file-manager.cjs');
const modInstallService = require('../mod-utils/mod-installation-service.cjs');
const {
  extractVersionFromFilename
} = require('./mod-handler-utils.cjs');

function createServerModHandlers(win) {
  return {
    'list-mods': async (_e, serverPath) => {
      return await modFileManager.listMods(serverPath);
    },

    'get-installed-mod-info': async (_e, serverPath) => {
      return await modFileManager.getInstalledModInfo(serverPath);
    },

    'save-disabled-mods': async (_e, serverPath, disabledMods) => {
      return await modFileManager.saveDisabledMods(serverPath, disabledMods);
    },

    'get-disabled-mods': async (_e, serverPath) => {
      return await modFileManager.getDisabledMods(serverPath);
    },    'check-mod-compatibility': async (_e, { serverPath, mcVersion, fabricVersion }) => {
      if (!serverPath || !fs.existsSync(serverPath)) {
        throw new Error('Invalid server path');
      }
      if (!mcVersion || !fabricVersion) {
        throw new Error('Version information missing');
      }      // Helper function for version compatibility checking
      function checkMinecraftVersionCompatibility(modVersion, targetVersion) {
        if (!modVersion || !targetVersion) return false;
        
        // Exact match
        if (modVersion === targetVersion) return true;
        
        // Handle arrays (like ["1.21.x"])
        if (Array.isArray(modVersion)) {
          return modVersion.some(v => checkMinecraftVersionCompatibility(v, targetVersion));
        }
        
        // Handle range format like ">=1.21.2 <=1.21.3" (from multi-version arrays)
        if (modVersion.includes('>=') && modVersion.includes('<=')) {
          const rangeParts = modVersion.split(' ');
          const minPart = rangeParts.find(p => p.startsWith('>='));
          const maxPart = rangeParts.find(p => p.startsWith('<='));
          
          if (minPart && maxPart) {
            const minVersion = minPart.substring(2).trim();
            const maxVersion = maxPart.substring(2).trim();
            return compareVersions(targetVersion, minVersion) >= 0 && 
                   compareVersions(targetVersion, maxVersion) <= 0;
          }
        }
        
        // Handle version ranges like "1.21.x" or "1.21.*"
        if (modVersion.includes('.x') || modVersion.includes('.*')) {
          const baseVersion = modVersion.replace(/\.[x*].*$/, '');
          return targetVersion.startsWith(baseVersion + '.');
        }
        
        // Handle ">=" comparisons like ">=1.21.4-rc.3"
        if (modVersion.startsWith('>=')) {
          const minVersion = modVersion.substring(2).trim();
          return compareVersions(targetVersion, minVersion) >= 0;
        }
        
        // Handle ">" comparisons
        if (modVersion.startsWith('>')) {
          const minVersion = modVersion.substring(1).trim();
          return compareVersions(targetVersion, minVersion) > 0;
        }
        
        // Handle "<=" comparisons
        if (modVersion.startsWith('<=')) {
          const maxVersion = modVersion.substring(2).trim();
          return compareVersions(targetVersion, maxVersion) <= 0;
        }
        
        // Handle "<" comparisons
        if (modVersion.startsWith('<')) {
          const maxVersion = modVersion.substring(1).trim();
          return compareVersions(targetVersion, maxVersion) < 0;
        }
        
        // Handle "~" (approximately equal) like "~1.21.4"
        if (modVersion.startsWith('~')) {
          const baseVersion = modVersion.substring(1).trim();
          const [baseMajor, baseMinor] = baseVersion.split('.');
          const [targetMajor, targetMinor] = targetVersion.split('.');
          return baseMajor === targetMajor && baseMinor === targetMinor;
        }
        
        return false;
      }
      
      // Simple version comparison function
      function compareVersions(version1, version2) {
        // Remove any suffixes like "-rc.3", "-alpha", etc. for comparison
        const clean1 = version1.split('-')[0];
        const clean2 = version2.split('-')[0];
        
        const parts1 = clean1.split('.').map(Number);
        const parts2 = clean2.split('.').map(Number);
        
        const maxLength = Math.max(parts1.length, parts2.length);
        
        for (let i = 0; i < maxLength; i++) {
          const part1 = parts1[i] || 0;
          const part2 = parts2[i] || 0;
          
          if (part1 > part2) return 1;
          if (part1 < part2) return -1;
        }
        
        return 0;
      }      modApiService.clearVersionCache();
      const installed = await modFileManager.getInstalledModInfo(serverPath);
      const disabledMods = await modFileManager.getDisabledMods(serverPath);
      const disabledModsSet = new Set(disabledMods);
      
      // Filter out disabled mods - only check compatibility for enabled mods
      const enabledMods = installed.filter(mod => !disabledModsSet.has(mod.fileName));
      const results = [];
      
      for (const mod of enabledMods) {
        const projectId = mod.projectId;
        const fileName = mod.fileName;
        const name = mod.name || mod.title || fileName;
        let currentVersion = mod.versionNumber || mod.version || null;
        
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
        }
        
        try {          // NEW: Check backend-extracted metadata first (most reliable)
          let currentVersionCompatible = false;
          
          if (mod.minecraftVersion) {
            currentVersionCompatible = checkMinecraftVersionCompatibility(mod.minecraftVersion, mcVersion);
          }
          
          // Fallback to Modrinth API if backend metadata unavailable
          if (!currentVersionCompatible && !mod.minecraftVersion) {
            const allVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, false);
            currentVersionCompatible = allVersions && allVersions.some(v => {
              const versionMatches = v.versionNumber === currentVersion;
              const supportsTargetMC = v.gameVersions && v.gameVersions.includes(mcVersion);
              return versionMatches && supportsTargetMC;
            });
          }
          
          const latestVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, true);
          const latest = latestVersions && latestVersions[0];
          
          if (currentVersionCompatible) {
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
            // Check if the LATEST version would be compatible with target MC version
            const latestVersionCompatible = latest.gameVersions && latest.gameVersions.includes(mcVersion);
            
            if (latestVersionCompatible) {
              // Latest version IS compatible - show as update available
              results.push({
                projectId,
                fileName,
                name,
                currentVersion,
                latestVersion: latest.versionNumber,
                compatible: true,
                hasUpdate: true,
                dependencies: latest.dependencies || []
              });
            } else {
              // Latest version is ALSO incompatible - show as incompatible
              results.push({
                projectId,
                fileName,
                name,
                currentVersion,
                latestVersion: latest.versionNumber,
                compatible: false,
                dependencies: []
              });
            }
          } else {
            results.push({
              projectId,
              fileName,
              name,
              currentVersion,
              latestVersion: currentVersion,
              compatible: false,
              dependencies: []
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
    },

    'install-mod': async (_e, serverPath, modDetails) => {
      return await modInstallService.installModToServer(win, serverPath, modDetails);
    },

    'add-mod': async (_e, serverPath, modPath) => {
      return await modFileManager.addMod(serverPath, modPath);
    },

    'delete-mod': async (_e, serverPath, modName) => {
      return await modFileManager.deleteMod(serverPath, modName);
    },

    'update-mod': async (_e, { serverPath, projectId, targetVersion, fileName }) => {
      const versions = await modApiService.getModrinthVersions(projectId, 'fabric', null, false);
      const targetVersionInfo = versions.find(v => v.versionNumber === targetVersion);
      if (!targetVersionInfo) {
        throw new Error(`Target version ${targetVersion} not found for mod ${projectId}`);
      }
      const completeVersionInfo = await modApiService.getModrinthVersionInfo(projectId, targetVersionInfo.id);
      const projectInfo = await modApiService.getModrinthProjectInfo(projectId);
      const modDetails = {
        id: projectId,
        selectedVersionId: targetVersionInfo.id,
        name: projectInfo.title || completeVersionInfo.name || targetVersionInfo.name || projectId,
        fileName: completeVersionInfo.files[0]?.filename,
        downloadUrl: completeVersionInfo.files[0]?.url,
        version: targetVersion,
        source: 'modrinth',
        forceReinstall: true,
        oldFileName: fileName
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
    },

    'move-mod-file': async (_e, { fileName, newCategory, serverPath }) => {
      return await modFileManager.moveModFile({ fileName, newCategory, serverPath });
    },

    'save-mod-categories': async (_e, categories) => {
      modFileManager.modCategoriesStore.set(categories);
      return { success: true };
    },

    'get-mod-categories': async () => {
      return modFileManager.modCategoriesStore.get() || [];
    },

    'enable-and-update-mod': async (_e, { serverPath, modFileName, projectId, targetVersion, targetVersionId }) => {
      try {
        // First, validate inputs
        if (!serverPath || !modFileName || !projectId || !targetVersion || !targetVersionId) {
          throw new Error('Missing required parameters for enable and update operation');
        }

        // Check if the mod is actually disabled
        const disabledMods = await modFileManager.getDisabledMods(serverPath);
        if (!disabledMods.includes(modFileName)) {
          throw new Error(`Mod ${modFileName} is not disabled`);
        }

        // Remove the old disabled file FIRST, before installing new version
        const fs = require('fs');
        const path = require('path');
        
        const modsDir = path.join(serverPath, 'mods');
        const clientModsDir = path.join(serverPath, 'client', 'mods');
        const disabledFilePath = path.join(modsDir, modFileName + '.disabled');
        const clientDisabledFilePath = path.join(clientModsDir, modFileName + '.disabled');
        
        // Delete the old disabled files (both server and client)
        if (fs.existsSync(disabledFilePath)) {
          fs.unlinkSync(disabledFilePath);
        }
        if (fs.existsSync(clientDisabledFilePath)) {
          fs.unlinkSync(clientDisabledFilePath);
        }
        
        // Also remove old manifests for the disabled files to prevent stale metadata
        const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
        const clientManifestDir = path.join(serverPath, 'client', 'minecraft-core-manifests');
        const manifestPath = path.join(serverManifestDir, `${modFileName}.json`);
        const clientManifestPath = path.join(clientManifestDir, `${modFileName}.json`);
        
        // Remove old manifests
        if (fs.existsSync(manifestPath)) {
          fs.unlinkSync(manifestPath);
        }
        if (fs.existsSync(clientManifestPath)) {
          fs.unlinkSync(clientManifestPath);
        }

        // Get the version info and project info for the target version
        const targetVersionInfo = await modApiService.getModrinthVersionInfo(projectId, targetVersionId);
        const projectInfo = await modApiService.getModrinthProjectInfo(projectId);

        if (!targetVersionInfo || !targetVersionInfo.files || targetVersionInfo.files.length === 0) {
          throw new Error(`Target version ${targetVersion} not found or has no files`);
        }

        // Prepare mod details for installation (install with the original filename, not .disabled)
        const modDetails = {
          id: projectId,
          selectedVersionId: targetVersionId,
          name: projectInfo.title || targetVersionInfo.name || projectId,
          fileName: modFileName, // Use the original filename without .disabled
          downloadUrl: targetVersionInfo.files[0]?.url,
          version: targetVersion,
          source: 'modrinth',
          forceReinstall: true // This will overwrite any existing file
        };



        // Install the new version (this will download to the correct enabled location)
        const installResult = await modInstallService.installModToServer(win, serverPath, modDetails);

        if (!installResult || !installResult.success) {
          throw new Error(`Failed to install updated version: ${installResult?.error || 'Unknown error'}`);
        }

        // Update the disabled mods list to remove this mod
        const updatedDisabledMods = disabledMods.filter(mod => mod !== modFileName);
        await modFileManager.saveDisabledMods(serverPath, updatedDisabledMods);
        
        // Force clear any cached mod information to ensure fresh data
        try {
          const modApiService = require('../../services/mod-api-service.cjs');
          modApiService.clearVersionCache();
        } catch (cacheErr) {
          // Cache clearing failed, but operation can continue
        }

        // Final cleanup: ensure no stale disabled files exist
        const finalDisabledCheck = path.join(modsDir, modFileName + '.disabled');
        const finalClientDisabledCheck = path.join(clientModsDir, modFileName + '.disabled');
        
        if (fs.existsSync(finalDisabledCheck)) {
          fs.unlinkSync(finalDisabledCheck);
        }
        
        if (fs.existsSync(finalClientDisabledCheck)) {
          fs.unlinkSync(finalClientDisabledCheck);
        }

        return {
          success: true,
          message: `Mod ${modFileName} successfully enabled and updated to version ${targetVersion}`,
          newFileName: modFileName, // Keep the same filename structure
          oldFileName: modFileName,
          version: targetVersion
        };

      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    },

    'check-disabled-mod-updates': async (_e, { serverPath, mcVersion }) => {
      try {
        // Get disabled mods
        const disabledMods = await modFileManager.getDisabledMods(serverPath);
        const installed = await modFileManager.getInstalledModInfo(serverPath);
        
        const disabledModsSet = new Set(disabledMods);
        const disabledModsInfo = installed.filter(mod => disabledModsSet.has(mod.fileName));
        
        const results = [];
        
        for (const mod of disabledModsInfo) {
          const projectId = mod.projectId;
          const fileName = mod.fileName;
          const name = mod.name || mod.title || fileName;
          let currentVersion = mod.versionNumber || mod.version || null;
          
          if (!currentVersion || currentVersion === 'Unknown') {
            currentVersion = extractVersionFromFilename(fileName) || 'Unknown';
          }
          
          if (!projectId) {
            // No project ID means we can't check for updates
            results.push({
              projectId: null,
              fileName,
              name,
              currentVersion,
              hasUpdate: false,
              updateAvailable: false,
              isCompatibleUpdate: false,
              reason: 'No project ID available'
            });
            continue;
          }
          
          try {
            // Check if current version is compatible with target MC version
            let currentVersionCompatible = false;
            
            if (mod.minecraftVersion) {
              // Use backend-extracted metadata if available
              const checkMinecraftVersionCompatibility = require('./mod-handler-utils.cjs').checkMinecraftVersionCompatibility;
              currentVersionCompatible = checkMinecraftVersionCompatibility(mod.minecraftVersion, mcVersion);
            }
            
            // If current version is not compatible, check for compatible updates
            if (!currentVersionCompatible) {
              const latestVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, true);
              const latest = latestVersions && latestVersions[0];
              
              if (latest && latest.versionNumber !== currentVersion) {
                // There's a newer version compatible with current MC version
                results.push({
                  projectId,
                  fileName,
                  name,
                  currentVersion,
                  hasUpdate: true,
                  updateAvailable: true,
                  isCompatibleUpdate: true,
                  latestVersion: latest.versionNumber,
                  latestVersionId: latest.id,
                  reason: `Update available: ${currentVersion} → ${latest.versionNumber} (compatible with MC ${mcVersion})`
                });
              } else {
                results.push({
                  projectId,
                  fileName,
                  name,
                  currentVersion,
                  hasUpdate: false,
                  updateAvailable: false,
                  isCompatibleUpdate: false,
                  reason: latest ? 'Current version is latest' : 'No compatible versions found'
                });
              }
            } else {
              // Current version is already compatible
              results.push({
                projectId,
                fileName,
                name,
                currentVersion,
                hasUpdate: false,
                updateAvailable: false,
                isCompatibleUpdate: false,
                reason: `Current version is compatible with MC ${mcVersion}`
              });
            }
            
          } catch (err) {
            results.push({
              projectId,
              fileName,
              name,
              currentVersion,
              hasUpdate: false,
              updateAvailable: false,
              isCompatibleUpdate: false,
              reason: `Error: ${err.message}`,
              error: err.message
            });
          }
        }
        
        return results;
        
      } catch (error) {
        throw new Error(`Failed to check disabled mod updates: ${error.message}`);
      }
    }
  };
}

module.exports = { createServerModHandlers };
