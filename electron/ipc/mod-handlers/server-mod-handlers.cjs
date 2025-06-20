const fs = require("fs");
const path = require("path");
const modApiService = require("../services/mod-api-service.cjs");
const modFileManager = require("../mod-utils/mod-file-manager.cjs");
const modInstallService = require("../mod-utils/mod-installation-service.cjs");
const { extractVersionFromFilename } = require("./mod-handler-utils.cjs");
function createServerModHandlers(win) {

  return {
    'list-mods': async (_event, serverPath) => {
      try {
        return await modFileManager.listMods(serverPath);
      } catch (err) {
        throw new Error(`Failed to list mods: ${err.message}`);
      }
    },
    'get-installed-mod-info': async (_event, serverPath) => {
      try {
        return await modFileManager.getInstalledModInfo(serverPath);
      } catch (err) {
        throw new Error(`Failed to get installed mod info: ${err.message}`);
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
    },
    'check-mod-compatibility': async (_event, { serverPath, mcVersion, fabricVersion }) => {
      if (!serverPath || !fs.existsSync(serverPath)) {
        throw new Error('Invalid server path');
      }
      if (!mcVersion || !fabricVersion) {
        throw new Error('Version information missing');
      }
      modApiService.clearVersionCache();
      const installed = await modFileManager.getInstalledModInfo(serverPath);
      const results = [];
      for (const mod of installed) {
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
        try {
          const allVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, false);
          const currentVersionCompatible = allVersions && allVersions.some(v => {
            const versionMatches = v.versionNumber === currentVersion;
            const supportsTargetMC = v.gameVersions && v.gameVersions.includes(mcVersion);
            return versionMatches && supportsTargetMC;
          });
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
    'install-mod': async (_event, serverPath, modDetails) => {
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
    },
    'update-mod': async (_event, { serverPath, projectId, targetVersion, fileName }) => {
      try {
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
      } catch (err) {
        throw new Error(`Failed to update mod: ${err.message}`);
      }
    },
    'save-mod-categories': async (_event, categories) => {
      try {
        const storeSuccess = modFileManager.modCategoriesStore.set(categories);
        if (!storeSuccess) {
          // optionally handle failure
        }
        return { success: true };
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
    }
  };
}

module.exports = { createServerModHandlers };
