const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const modApiService = require('../../services/mod-api-service.cjs');
const modFileManager = require('../mod-utils/mod-file-manager.cjs');
const modInstallService = require('../mod-utils/mod-installation-service.cjs');
const { downloadWithProgress } = require('../../services/download-manager.cjs');
const { disableMod } = require('../mod-utils/mod-file-utils.cjs');
const {
  extractVersionFromFilename,
  compareVersions
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
    },

    'check-mod-compatibility': async (_e, { serverPath, mcVersion, fabricVersion }) => {
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
