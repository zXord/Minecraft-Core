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
    }
  };
}

module.exports = { createServerModHandlers };
