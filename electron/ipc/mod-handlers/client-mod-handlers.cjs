const fs = require('fs');
const path = require('path');
const modInstallService = require('../mod-utils/mod-installation-service.cjs');
const { disableMod } = require('../mod-utils/mod-file-utils.cjs');
const { downloadWithProgress } = require('../../services/download-manager.cjs');
const modFileManager = require('../mod-utils/mod-file-manager.cjs');
const modAnalysisUtils = require('../mod-utils/mod-analysis-utils.cjs');
const { checkModCompatibilityFromFilename } = require('./mod-handler-utils.cjs');

function createClientModHandlers(win) {
  return {
    'install-client-mod': async (_e, modData) => {
      return await modInstallService.installModToClient(win, modData);
    },

    'get-client-installed-mod-info': async (_e, clientPath) => {
      return await modFileManager.getClientInstalledModInfo(clientPath);
    },

    'check-client-mod-compatibility': async (_e, options) => {
      const { newMinecraftVersion, clientPath } = options;
      if (!clientPath || !fs.existsSync(clientPath)) {
        throw new Error('Invalid client path provided');
      }
      const clientModInfo = await modFileManager.getClientInstalledModInfo(clientPath);
      const compatibilityResults = [];
      for (const modInfo of clientModInfo) {
        try {
          let compatibilityStatus = 'unknown';
          let reason = '';
          let availableUpdate = null;
          const metadata = {
            name: modInfo.name,
            version: modInfo.versionNumber,
            projectId: modInfo.projectId,
            fileName: modInfo.fileName
          };
          const filenameCheck = checkModCompatibilityFromFilename(modInfo.fileName, newMinecraftVersion);
          if (filenameCheck.isCompatible) {
            compatibilityStatus = 'compatible';
            reason = 'Compatibility determined from filename';
          } else {
            compatibilityStatus = 'unknown';
            reason = 'Unable to determine compatibility - manual verification recommended';
          }
          compatibilityResults.push({
            fileName: modInfo.fileName,
            name: modInfo.name || modInfo.fileName,
            version: modInfo.versionNumber || 'Unknown',
            compatibilityStatus,
            reason,
            availableUpdate,
            metadata
          });
        } catch (modError) {
          compatibilityResults.push({
            fileName: modInfo.fileName || 'Unknown',
            name: modInfo.name || modInfo.fileName || 'Unknown',
            version: 'Unknown',
            compatibilityStatus: 'error',
            reason: `Error checking compatibility: ${modError.message}`
          });
        }
      }
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
    },

    'update-client-mod': async (_e, { modInfo, clientPath }) => {
      if (!modInfo.downloadUrl) {
        throw new Error('No download URL available for mod update');
      }
      const modsDir = path.join(clientPath, 'mods');
      await fs.promises.mkdir(modsDir, { recursive: true });
      const sanitizedName = modInfo.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const fileName = sanitizedName.endsWith('.jar') ? sanitizedName : `${sanitizedName}.jar`;
      const targetPath = path.join(modsDir, fileName);
      const writer = fs.createWriteStream(targetPath);
      const axios = require('axios');
      const { pipeline } = require('stream');
      const { promisify } = require('util');
      const pipelineAsync = promisify(pipeline);
      const response = await axios({
        url: modInfo.downloadUrl,
        method: 'GET',
        responseType: 'stream',
        timeout: 60000
      });
      await pipelineAsync(response.data, writer);

      const oldFileName = modInfo.currentFilePath
        ? path.basename(modInfo.currentFilePath)
        : fileName;
      const newFileName = path.basename(targetPath);

      if (modInfo.currentFilePath && fs.existsSync(modInfo.currentFilePath)) {
        if (oldFileName !== newFileName) {
          await fs.promises.unlink(modInfo.currentFilePath);
        }
      }

      const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
      await fs.promises.mkdir(manifestDir, { recursive: true });
      const oldManifestPath = path.join(manifestDir, `${oldFileName}.json`);
      const newManifestPath = path.join(manifestDir, `${newFileName}.json`);
      let manifest = {};
      try {
        const content = await fs.promises.readFile(oldManifestPath, 'utf8');
        manifest = JSON.parse(content);
      } catch {
        manifest = {
          projectId: modInfo.projectId,
          name: modInfo.name,
          fileName: newFileName,
          versionNumber: modInfo.newVersion || modInfo.version || '',
          updatedAt: new Date().toISOString()
        };
      }
      manifest.fileName = newFileName;
      if (modInfo.newVersion) {
        manifest.versionNumber = modInfo.newVersion;
      } else if (modInfo.version) {
        manifest.versionNumber = modInfo.version;
      }
      manifest.updatedAt = new Date().toISOString();
      await fs.promises.writeFile(newManifestPath, JSON.stringify(manifest, null, 2));
      if (oldManifestPath !== newManifestPath) {
        await fs.promises.unlink(oldManifestPath).catch(() => {});
      }

      modAnalysisUtils.invalidateMetadataCache(targetPath);

      return { success: true, filePath: targetPath };
    },

    'disable-client-mod': async (_e, { modFilePath }) => {
      if (!fs.existsSync(modFilePath)) {
        throw new Error('Mod file not found');
      }
      const disabledPath = modFilePath + '.disabled';
      if (fs.existsSync(disabledPath)) {
        throw new Error('Mod is already disabled');
      }
      fs.renameSync(modFilePath, disabledPath);
      return { success: true, disabledPath };
    },

    'update-client-mods': async (_e, { mods, clientPath, minecraftVersion }) => {
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
          const primaryFile = modToUpdate.newVersionDetails.files.find(f => f.primary && f.url);
          const fileToDownload = primaryFile || modToUpdate.newVersionDetails.files.find(f => f.url && f.filename.endsWith('.jar')) || modToUpdate.newVersionDetails.files[0];
          if (!fileToDownload || !fileToDownload.url) {
            throw new Error(`Could not determine download URL for ${modToUpdate.name || modToUpdate.fileName}`);
          }
          const oldFileName = modToUpdate.fileName;
          const newFileName = fileToDownload.filename;
          if (oldFileName && fs.existsSync(path.join(modsDir, oldFileName))) {
            await disableMod(modsDir, oldFileName);
          }
          await downloadWithProgress(fileToDownload.url, modsDir, newFileName);

          const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
          await fs.promises.mkdir(manifestDir, { recursive: true });
          const oldManifestPath = path.join(manifestDir, `${oldFileName}.json`);
          const newManifestPath = path.join(manifestDir, `${newFileName}.json`);
          let manifest = {};
          try {
            const content = await fs.promises.readFile(oldManifestPath, 'utf8');
            manifest = JSON.parse(content);
          } catch {
            manifest = {
              projectId: modToUpdate.projectId,
              name: modToUpdate.name,
              fileName: newFileName,
              versionNumber: (modToUpdate.newVersionDetails && modToUpdate.newVersionDetails.versionNumber) || '',
              updatedAt: new Date().toISOString()
            };
          }
          manifest.fileName = newFileName;
          if (modToUpdate.newVersionDetails && modToUpdate.newVersionDetails.versionNumber) {
            manifest.versionNumber = modToUpdate.newVersionDetails.versionNumber;
          }
          manifest.updatedAt = new Date().toISOString();
          await fs.promises.writeFile(newManifestPath, JSON.stringify(manifest, null, 2));
          if (oldManifestPath !== newManifestPath) {
            await fs.promises.unlink(oldManifestPath).catch(() => {});
          }

          modAnalysisUtils.invalidateMetadataCache(path.join(modsDir, newFileName));

          updatedCount++;
        } catch (error) {
          errors.push(`${modToUpdate.name || modToUpdate.fileName}: ${error.message}`);
        }
      }
      if (errors.length > 0) {
        return { success: updatedCount > 0, updatedCount, error: `Some mods failed to update. Errors: ${errors.join('; ')}` };
      }
      return { success: true, updatedCount };
    },

    'disable-client-mods': async (_e, { mods, clientPath }) => {
      if (!mods || !Array.isArray(mods) || mods.length === 0) {
        return { success: false, error: 'No mods specified for disabling.', disabledCount: 0 };
      }
      if (!clientPath) {
        return { success: false, error: 'Client path not provided.', disabledCount: 0 };
      }
      const modsDir = path.join(clientPath, 'mods');
      if (!fs.existsSync(modsDir)) {
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
          }
        } catch (error) {
          errors.push(`${modToDisable.fileName}: ${error.message}`);
        }
      }
      if (errors.length > 0) {
        return { success: disabledCount > 0, disabledCount, error: `Some mods failed to disable. Errors: ${errors.join('; ')}` };
      }
      return { success: true, disabledCount };
    },

    'enhance-mod-names': async (_e, { clientPath, mods }) => {
      if (!mods || !Array.isArray(mods)) {
        return { success: false, error: 'Invalid mods data' };
      }
      const modsDir = path.join(clientPath, 'mods');
      if (!fs.existsSync(modsDir)) {
        return { success: false, error: 'Mods directory not found' };
      }
      const enhancedMods = [];
      for (const mod of mods) {
        const enhancedMod = { ...mod };
        try {
          const possiblePaths = [
            path.join(modsDir, mod.fileName),
            path.join(modsDir, mod.fileName + '.disabled')
          ];
          let actualPath = null;
          for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
              actualPath = possiblePath;
              break;
            }
          }
          if (actualPath) {
            const metadata = await modAnalysisUtils.extractDependenciesFromJar(actualPath);
            if (metadata?.name) {
              enhancedMod.cleanName = metadata.name;
              enhancedMod.displayName = metadata.name;
            }
            if (metadata?.version) {
              enhancedMod.cleanVersion = metadata.version;
            }
          }
        } catch {
          // ignore errors extracting metadata
        }
        enhancedMods.push(enhancedMod);
      }
      return { success: true, enhancedMods };
    }
  };
}

module.exports = { createClientModHandlers };
