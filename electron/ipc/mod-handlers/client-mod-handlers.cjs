const fs = require('fs');
const path = require('path');
const modInstallService = require('../mod-utils/mod-installation-service.cjs');
const modFileManager = require('../mod-utils/mod-file-manager.cjs');
const modApiService = require('../services/mod-api-service.cjs');
const { disableMod } = require('../mod-utils/mod-file-utils.cjs');
const { readModMetadata, compareVersions } = require('./mod-handler-utils.cjs');

function createClientModHandlers(win) {
  return {
    'install-client-mod': async (_event, modData) => {
      return await modInstallService.installModToClient(win, modData);
    },
    'check-client-mod-compatibility': async (_event, options) => {
      try {
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
            const filenameCheck = require('./mod-handler-utils.cjs').checkModCompatibilityFromFilename(modInfo.fileName, newMinecraftVersion);
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
      } catch (error) {
        throw new Error(`Failed to check client mod compatibility: ${error.message}`);
      }
    },
    'update-client-mod': async (_event, { modInfo, clientPath }) => {
      try {
        if (!modInfo.downloadUrl) {
          throw new Error('No download URL available for mod update');
        }
        const fsPromises = require('fs').promises;
        const axios = require('axios');
        const { createWriteStream } = require('fs');
        const { pipeline } = require('stream');
        const { promisify } = require('util');
        const pipelineAsync = promisify(pipeline);
        const modsDir = path.join(clientPath, 'mods');
        await fsPromises.mkdir(modsDir, { recursive: true });
        const sanitizedName = modInfo.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const fileName = sanitizedName.endsWith('.jar') ? sanitizedName : `${sanitizedName}.jar`;
        const targetPath = path.join(modsDir, fileName);
        const writer = createWriteStream(targetPath);
        const response = await axios({
          url: modInfo.downloadUrl,
          method: 'GET',
          responseType: 'stream',
          timeout: 60000
        });
        await pipelineAsync(response.data, writer);
        if (modInfo.currentFilePath && fs.existsSync(modInfo.currentFilePath)) {
          const oldFileName = path.basename(modInfo.currentFilePath);
          const newFileName = path.basename(targetPath);
          if (oldFileName !== newFileName) {
            await fsPromises.unlink(modInfo.currentFilePath);
          }
        }
        return { success: true, filePath: targetPath };
      } catch (error) {
        throw new Error(`Failed to update mod "${modInfo.name}": ${error.message}`);
      }
    },
    'disable-client-mod': async (_event, { modFilePath }) => {
      try {
        if (!fs.existsSync(modFilePath)) {
          throw new Error('Mod file not found');
        }
        const disabledPath = modFilePath + '.disabled';
        if (fs.existsSync(disabledPath)) {
          throw new Error('Mod is already disabled');
        }
        fs.renameSync(modFilePath, disabledPath);
        return { success: true, disabledPath };
      } catch (error) {
        throw new Error(`Failed to disable mod: ${error.message}`);
      }
    },
    'update-client-mods': async (_event, { mods, clientPath, minecraftVersion }) => {
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
            await require('../services/download-manager.cjs').downloadWithProgress(fileToDownload.url, modsDir, newFileName);
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
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
    'enhance-mod-names': async (_event, { clientPath, mods }) => {
      try {
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
              const metadata = await readModMetadata(actualPath);
              if (metadata?.name) {
                enhancedMod.cleanName = metadata.name;
                enhancedMod.displayName = metadata.name;
              }
              if (metadata?.version) {
                enhancedMod.cleanVersion = metadata.version;
              }
            }
          } catch {
          }
          enhancedMods.push(enhancedMod);
        }
        return { success: true, enhancedMods };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  };
}

module.exports = { createClientModHandlers };
