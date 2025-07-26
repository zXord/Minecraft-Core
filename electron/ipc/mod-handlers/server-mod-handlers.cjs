const fs = require('fs');
const modApiService = require('../../services/mod-api-service.cjs');
const modFileManager = require('../mod-utils/mod-file-manager.cjs');
const modInstallService = require('../mod-utils/mod-installation-service.cjs');
const {
  extractVersionFromFilename
} = require('./mod-handler-utils.cjs');
const { getLoggerHandlers } = require('../logger-handlers.cjs');

function createServerModHandlers(win) {
  const logger = getLoggerHandlers();
  
  logger.info('Server mod handlers initialized', {
    category: 'mods',
    data: { 
      handler: 'server-mod-handlers',
      hasWindow: !!win
    }
  });

  return {
    'list-mods': async (_e, serverPath) => {
      logger.debug('Listing server mods', {
        category: 'mods',
        data: {
          handler: 'list-mods',
          serverPath: serverPath,
          pathExists: fs.existsSync(serverPath)
        }
      });

      try {
        const mods = await modFileManager.listMods(serverPath);
        
        logger.info('Server mods listed successfully', {
          category: 'mods',
          data: {
            handler: 'list-mods',
            serverPath: serverPath,
            modCount: mods?.length || 0
          }
        });
        
        return mods;
      } catch (error) {
        logger.error(`Failed to list server mods: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'list-mods',
            serverPath: serverPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'get-installed-mod-info': async (_e, serverPath) => {
      logger.debug('Getting server installed mod info', {
        category: 'mods',
        data: {
          handler: 'get-installed-mod-info',
          serverPath: serverPath,
          pathExists: fs.existsSync(serverPath)
        }
      });

      try {
        const modInfo = await modFileManager.getInstalledModInfo(serverPath);
        
        logger.info('Retrieved server mod info', {
          category: 'mods',
          data: {
            handler: 'get-installed-mod-info',
            serverPath: serverPath,
            modCount: modInfo?.length || 0
          }
        });
        
        return modInfo;
      } catch (error) {
        logger.error(`Failed to get server mod info: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'get-installed-mod-info',
            serverPath: serverPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'save-disabled-mods': async (_e, serverPath, disabledMods) => {
      logger.info('Saving disabled mods list', {
        category: 'mods',
        data: {
          handler: 'save-disabled-mods',
          serverPath: serverPath,
          disabledCount: disabledMods?.length || 0
        }
      });

      try {
        const result = await modFileManager.saveDisabledMods(serverPath, disabledMods);
        
        logger.info('Disabled mods list saved successfully', {
          category: 'mods',
          data: {
            handler: 'save-disabled-mods',
            serverPath: serverPath,
            disabledCount: disabledMods?.length || 0
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`Failed to save disabled mods: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'save-disabled-mods',
            serverPath: serverPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'get-disabled-mods': async (_e, serverPath) => {
      logger.debug('Getting disabled mods list', {
        category: 'mods',
        data: {
          handler: 'get-disabled-mods',
          serverPath: serverPath
        }
      });

      try {
        const disabledMods = await modFileManager.getDisabledMods(serverPath);
        
        logger.debug('Retrieved disabled mods list', {
          category: 'mods',
          data: {
            handler: 'get-disabled-mods',
            serverPath: serverPath,
            disabledCount: disabledMods?.length || 0
          }
        });
        
        return disabledMods;
      } catch (error) {
        logger.error(`Failed to get disabled mods: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'get-disabled-mods',
            serverPath: serverPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },    'check-mod-compatibility': async (_e, { serverPath, mcVersion, fabricVersion }) => {
      logger.info('Checking server mod compatibility', {
        category: 'mods',
        data: {
          handler: 'check-mod-compatibility',
          serverPath: serverPath,
          mcVersion: mcVersion,
          fabricVersion: fabricVersion,
          pathExists: fs.existsSync(serverPath)
        }
      });

      if (!serverPath || !fs.existsSync(serverPath)) {
        logger.error('Invalid server path for compatibility check', {
          category: 'mods',
          data: {
            handler: 'check-mod-compatibility',
            serverPath: serverPath,
            pathExists: fs.existsSync(serverPath)
          }
        });
        throw new Error('Invalid server path');
      }
      if (!mcVersion || !fabricVersion) {
        logger.error('Version information missing for compatibility check', {
          category: 'mods',
          data: {
            handler: 'check-mod-compatibility',
            mcVersion: mcVersion,
            fabricVersion: fabricVersion
          }
        });
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
      }      try {
        modApiService.clearVersionCache();
        const installed = await modFileManager.getInstalledModInfo(serverPath);
        const disabledMods = await modFileManager.getDisabledMods(serverPath);
        const disabledModsSet = new Set(disabledMods);
        
        // Filter out disabled mods - only check compatibility for enabled mods
        const enabledMods = installed.filter(mod => !disabledModsSet.has(mod.fileName));
        const results = [];
        
        logger.debug('Processing mod compatibility checks', {
          category: 'mods',
          data: {
            handler: 'check-mod-compatibility',
            totalMods: installed.length,
            enabledMods: enabledMods.length,
            disabledMods: disabledMods.length,
            mcVersion: mcVersion
          }
        });
      
      for (const mod of enabledMods) {
        const projectId = mod.projectId;
        const fileName = mod.fileName;
        const name = mod.name || mod.title || fileName;
        let currentVersion = mod.versionNumber || mod.version || null;
        
        if (!currentVersion || currentVersion === 'Unknown') {
          currentVersion = extractVersionFromFilename(fileName) || 'Unknown';
        }
        
        logger.debug('Processing individual mod compatibility', {
          category: 'mods',
          data: {
            modName: name,
            fileName: fileName,
            projectId: projectId,
            currentVersion: currentVersion,
            hasProjectId: !!projectId
          }
        });
        
        if (!projectId) {
          logger.debug('Mod has no project ID, marking as compatible', {
            category: 'mods',
            data: {
              modName: name,
              fileName: fileName
            }
          });
          
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
          // FIXED: Check if ANY versions exist for target MC version FIRST (most important)
          const availableVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, false);
          
          logger.debug('Retrieved available versions for mod', {
            category: 'network',
            data: {
              modName: name,
              projectId: projectId,
              mcVersion: mcVersion,
              availableVersionCount: availableVersions?.length || 0
            }
          });
          
          // If NO versions are available for the target MC version, mark as incompatible immediately
          if (!availableVersions || availableVersions.length === 0) {
            logger.debug('No versions available for target MC version', {
              category: 'mods',
              data: {
                modName: name,
                projectId: projectId,
                mcVersion: mcVersion,
                compatibilityStatus: 'incompatible'
              }
            });
            
            results.push({
              projectId,
              fileName,
              name,
              currentVersion,
              latestVersion: currentVersion,
              compatible: false,
              reason: `No versions available for Minecraft ${mcVersion}`,
              dependencies: []
            });
            continue;
          }
          
          // Get the latest available version for the target MC version
          const latestVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, true);
          const latest = latestVersions && latestVersions[0];
          
          // Check if current version is among the available versions for target MC
          let currentVersionCompatible = false;
          
          if (mod.minecraftVersion) {
            // Use backend-extracted metadata if available
            currentVersionCompatible = checkMinecraftVersionCompatibility(mod.minecraftVersion, mcVersion);
            // BUT also verify the version actually exists in the available versions list
            if (currentVersionCompatible) {
              const currentVersionExists = availableVersions.some(v => 
                v.versionNumber === currentVersion && 
                v.gameVersions && 
                v.gameVersions.includes(mcVersion)
              );
              currentVersionCompatible = currentVersionExists;
            }
          } else {
            // Check if current version exists in the available versions for target MC
            currentVersionCompatible = availableVersions.some(v => {
              const versionMatches = v.versionNumber === currentVersion;
              const supportsTargetMC = v.gameVersions && v.gameVersions.includes(mcVersion);
              return versionMatches && supportsTargetMC;
            });
          }
          
          if (currentVersionCompatible) {
            // Current version is compatible AND actually available for target MC
            logger.debug('Current mod version is compatible', {
              category: 'mods',
              data: {
                modName: name,
                currentVersion: currentVersion,
                latestVersion: latest?.versionNumber,
                hasUpdate: latest && latest.versionNumber !== currentVersion
              }
            });
            
            results.push({
              projectId,
              fileName,
              name,
              currentVersion,
              latestVersion: latest ? latest.versionNumber : currentVersion,
              compatible: true,
              hasUpdate: latest && latest.versionNumber !== currentVersion,
              dependencies: latest ? (latest.dependencies || []) : []
            });
          } else if (latest) {
            // Current version is not compatible, but there IS a latest version available
            logger.debug('Current mod version incompatible, but update available', {
              category: 'mods',
              data: {
                modName: name,
                currentVersion: currentVersion,
                latestVersion: latest.versionNumber,
                compatibilityStatus: 'update_available'
              }
            });
            
            results.push({
              projectId,
              fileName,
              name,
              currentVersion,
              latestVersion: latest.versionNumber,
              compatible: true, // Mark as compatible since there's an update available
              hasUpdate: true,
              reason: `Current version incompatible, update available: ${currentVersion} → ${latest.versionNumber}`,
              dependencies: latest.dependencies || []
            });
          } else {
            // This shouldn't happen since we checked availableVersions.length > 0 above
            logger.warn('No compatible versions found despite available versions existing', {
              category: 'mods',
              data: {
                modName: name,
                projectId: projectId,
                currentVersion: currentVersion,
                mcVersion: mcVersion
              }
            });
            
            results.push({
              projectId,
              fileName,
              name,
              currentVersion,
              latestVersion: currentVersion,
              compatible: false,
              reason: `No compatible versions found for Minecraft ${mcVersion}`,
              dependencies: []
            });
          }
        } catch (err) {
          logger.error(`Error checking mod compatibility: ${err.message}`, {
            category: 'mods',
            data: {
              modName: name,
              projectId: projectId,
              fileName: fileName,
              errorType: err.constructor.name
            }
          });
          
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
      
      logger.info('Server mod compatibility check completed', {
        category: 'mods',
        data: {
          handler: 'check-mod-compatibility',
          serverPath: serverPath,
          mcVersion: mcVersion,
          totalChecked: enabledMods.length,
          compatibleCount: results.filter(r => r.compatible).length,
          incompatibleCount: results.filter(r => !r.compatible).length,
          updateAvailableCount: results.filter(r => r.hasUpdate).length
        }
      });
      
      return results;
      } catch (error) {
        logger.error(`Server mod compatibility check failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'check-mod-compatibility',
            serverPath: serverPath,
            mcVersion: mcVersion,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'install-mod': async (_e, serverPath, modDetails) => {
      logger.info('Installing server mod', {
        category: 'mods',
        data: {
          handler: 'install-mod',
          serverPath: serverPath,
          modName: modDetails?.name,
          modId: modDetails?.id,
          hasDownloadUrl: !!modDetails?.downloadUrl
        }
      });

      try {
        const result = await modInstallService.installModToServer(win, serverPath, modDetails);
        
        logger.info('Server mod installation completed', {
          category: 'mods',
          data: {
            handler: 'install-mod',
            serverPath: serverPath,
            modName: modDetails?.name,
            success: result?.success,
            filePath: result?.filePath
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`Server mod installation failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'install-mod',
            serverPath: serverPath,
            modName: modDetails?.name,
            modId: modDetails?.id,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'add-mod': async (_e, serverPath, modPath) => {
      logger.info('Adding mod to server', {
        category: 'mods',
        data: {
          handler: 'add-mod',
          serverPath: serverPath,
          modPath: modPath,
          modExists: fs.existsSync(modPath)
        }
      });

      try {
        const result = await modFileManager.addMod(serverPath, modPath);
        
        logger.info('Mod added to server successfully', {
          category: 'mods',
          data: {
            handler: 'add-mod',
            serverPath: serverPath,
            modPath: modPath,
            success: result?.success
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`Failed to add mod to server: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'add-mod',
            serverPath: serverPath,
            modPath: modPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'delete-mod': async (_e, serverPath, modName) => {
      logger.info('Deleting server mod', {
        category: 'mods',
        data: {
          handler: 'delete-mod',
          serverPath: serverPath,
          modName: modName
        }
      });

      try {
        const result = await modFileManager.deleteMod(serverPath, modName);
        
        logger.info('Server mod deleted successfully', {
          category: 'mods',
          data: {
            handler: 'delete-mod',
            serverPath: serverPath,
            modName: modName,
            success: result?.success
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`Failed to delete server mod: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'delete-mod',
            serverPath: serverPath,
            modName: modName,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'update-mod': async (_e, { serverPath, projectId, targetVersion, fileName }) => {
      logger.info('Updating server mod', {
        category: 'mods',
        data: {
          handler: 'update-mod',
          serverPath: serverPath,
          projectId: projectId,
          targetVersion: targetVersion,
          fileName: fileName
        }
      });

      try {
        const versions = await modApiService.getModrinthVersions(projectId, 'fabric', null, false);
        const targetVersionInfo = versions.find(v => v.versionNumber === targetVersion);
        
        if (!targetVersionInfo) {
          logger.error('Target version not found for mod update', {
            category: 'mods',
            data: {
              handler: 'update-mod',
              projectId: projectId,
              targetVersion: targetVersion,
              availableVersions: versions?.length || 0
            }
          });
          throw new Error(`Target version ${targetVersion} not found for mod ${projectId}`);
        }
        
        logger.debug('Retrieved target version info for mod update', {
          category: 'network',
          data: {
            projectId: projectId,
            targetVersion: targetVersion,
            versionId: targetVersionInfo.id
          }
        });
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
      
      logger.info('Server mod update completed', {
        category: 'mods',
        data: {
          handler: 'update-mod',
          projectId: projectId,
          modName: modDetails.name,
          oldFileName: fileName,
          newFileName: modDetails.fileName,
          targetVersion: targetVersion,
          success: result?.success
        }
      });
      
      return {
        success: true,
        modName: modDetails.name,
        oldFileName: fileName,
        newFileName: modDetails.fileName,
        version: targetVersion,
        result
      };
      } catch (error) {
        logger.error(`Server mod update failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'update-mod',
            serverPath: serverPath,
            projectId: projectId,
            targetVersion: targetVersion,
            fileName: fileName,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'move-mod-file': async (_e, { fileName, newCategory, serverPath }) => {
      logger.info('Moving mod file', {
        category: 'mods',
        data: {
          handler: 'move-mod-file',
          fileName: fileName,
          newCategory: newCategory,
          serverPath: serverPath
        }
      });

      try {
        const result = await modFileManager.moveModFile({ fileName, newCategory, serverPath });
        
        logger.info('Mod file moved successfully', {
          category: 'storage',
          data: {
            handler: 'move-mod-file',
            fileName: fileName,
            newCategory: newCategory,
            serverPath: serverPath,
            success: result?.success
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`Failed to move mod file: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'move-mod-file',
            fileName: fileName,
            newCategory: newCategory,
            serverPath: serverPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'save-mod-categories': async (_e, categories) => {
      logger.info('Saving mod categories', {
        category: 'settings',
        data: {
          handler: 'save-mod-categories',
          categoryCount: categories?.length || 0
        }
      });

      try {
        modFileManager.modCategoriesStore.set(categories);
        
        logger.info('Mod categories saved successfully', {
          category: 'settings',
          data: {
            handler: 'save-mod-categories',
            categoryCount: categories?.length || 0
          }
        });
        
        return { success: true };
      } catch (error) {
        logger.error(`Failed to save mod categories: ${error.message}`, {
          category: 'settings',
          data: {
            handler: 'save-mod-categories',
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'get-mod-categories': async () => {
      logger.debug('Getting mod categories', {
        category: 'settings',
        data: {
          handler: 'get-mod-categories'
        }
      });

      try {
        const categories = modFileManager.modCategoriesStore.get() || [];
        
        logger.debug('Retrieved mod categories', {
          category: 'settings',
          data: {
            handler: 'get-mod-categories',
            categoryCount: categories.length
          }
        });
        
        return categories;
      } catch (error) {
        logger.error(`Failed to get mod categories: ${error.message}`, {
          category: 'settings',
          data: {
            handler: 'get-mod-categories',
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'enable-and-update-mod': async (_e, { serverPath, modFileName, projectId, targetVersion, targetVersionId }) => {
      logger.info('Enabling and updating server mod', {
        category: 'mods',
        data: {
          handler: 'enable-and-update-mod',
          serverPath: serverPath,
          modFileName: modFileName,
          projectId: projectId,
          targetVersion: targetVersion,
          targetVersionId: targetVersionId
        }
      });

      try {
        // First, validate inputs
        if (!serverPath || !modFileName || !projectId || !targetVersion || !targetVersionId) {
          logger.error('Missing required parameters for enable and update operation', {
            category: 'mods',
            data: {
              handler: 'enable-and-update-mod',
              hasServerPath: !!serverPath,
              hasModFileName: !!modFileName,
              hasProjectId: !!projectId,
              hasTargetVersion: !!targetVersion,
              hasTargetVersionId: !!targetVersionId
            }
          });
          throw new Error('Missing required parameters for enable and update operation');
        }

        // Check if the mod is actually disabled
        const disabledMods = await modFileManager.getDisabledMods(serverPath);
        if (!disabledMods.includes(modFileName)) {
          logger.error('Mod is not disabled, cannot enable and update', {
            category: 'mods',
            data: {
              handler: 'enable-and-update-mod',
              modFileName: modFileName,
              isDisabled: disabledMods.includes(modFileName),
              disabledModCount: disabledMods.length
            }
          });
          throw new Error(`Mod ${modFileName} is not disabled`);
        }
        
        logger.debug('Mod is disabled, proceeding with enable and update', {
          category: 'mods',
          data: {
            modFileName: modFileName,
            disabledModCount: disabledMods.length
          }
        });

        // Determine the original category/location by checking where disabled files exist
        const fs = require('fs');
        const path = require('path');
        
        const modsDir = path.join(serverPath, 'mods');
        const clientModsDir = path.join(serverPath, 'client', 'mods');
        const disabledFilePath = path.join(modsDir, modFileName + '.disabled');
        const clientDisabledFilePath = path.join(clientModsDir, modFileName + '.disabled');
        const legacyDisabledPath = path.join(serverPath, 'mods_disabled', modFileName);
        
        // Determine original category based on where disabled files exist
        const serverDisabledExists = fs.existsSync(disabledFilePath);
        const clientDisabledExists = fs.existsSync(clientDisabledFilePath);
        const legacyDisabledExists = fs.existsSync(legacyDisabledPath);
        
        let originalCategory = 'server-only'; // Default fallback
        
        if (serverDisabledExists && clientDisabledExists) {
          originalCategory = 'both';
        } else if (clientDisabledExists && !serverDisabledExists) {
          originalCategory = 'client-only';
        } else if (serverDisabledExists && !clientDisabledExists) {
          originalCategory = 'server-only';
        } else if (legacyDisabledExists) {
          originalCategory = 'server-only'; // Legacy defaults to server-only
        }
        
        logger.debug('Determined original mod category', {
          category: 'mods',
          data: {
            modFileName: modFileName,
            originalCategory: originalCategory,
            serverDisabledExists: serverDisabledExists,
            clientDisabledExists: clientDisabledExists,
            legacyDisabledExists: legacyDisabledExists
          }
        });

        // Remove the old disabled files BEFORE installing new version
        let removedFiles = [];
        if (serverDisabledExists) {
          fs.unlinkSync(disabledFilePath);
          removedFiles.push('server');
        }
        if (clientDisabledExists) {
          fs.unlinkSync(clientDisabledFilePath);
          removedFiles.push('client');
        }
        if (legacyDisabledExists) {
          fs.unlinkSync(legacyDisabledPath);
          removedFiles.push('legacy');
        }
        
        logger.debug('Removed disabled mod files', {
          category: 'storage',
          data: {
            modFileName: modFileName,
            removedFiles: removedFiles,
            removedCount: removedFiles.length
          }
        });
        
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
        logger.debug('Retrieving target version and project info', {
          category: 'network',
          data: {
            projectId: projectId,
            targetVersionId: targetVersionId,
            targetVersion: targetVersion
          }
        });
        
        const targetVersionInfo = await modApiService.getModrinthVersionInfo(projectId, targetVersionId);
        const projectInfo = await modApiService.getModrinthProjectInfo(projectId);

        if (!targetVersionInfo || !targetVersionInfo.files || targetVersionInfo.files.length === 0) {
          logger.error('Target version not found or has no files', {
            category: 'mods',
            data: {
              projectId: projectId,
              targetVersion: targetVersion,
              targetVersionId: targetVersionId,
              hasVersionInfo: !!targetVersionInfo,
              hasFiles: !!(targetVersionInfo?.files?.length)
            }
          });
          throw new Error(`Target version ${targetVersion} not found or has no files`);
        }

        // Prepare mod details for installation with original category preserved
        const modDetails = {
          id: projectId,
          selectedVersionId: targetVersionId,
          name: projectInfo.title || targetVersionInfo.name || projectId,
          fileName: modFileName, // Use the original filename without .disabled
          downloadUrl: targetVersionInfo.files[0]?.url,
          version: targetVersion,
          source: 'modrinth',
          forceReinstall: true, // This will overwrite any existing file
          category: originalCategory // Pass the original category to preserve location
        };

        // Install the new version (this will download to the correct enabled location)
        logger.debug('Installing updated mod version', {
          category: 'mods',
          data: {
            modName: modDetails.name,
            targetVersion: targetVersion,
            originalCategory: originalCategory,
            hasDownloadUrl: !!modDetails.downloadUrl
          }
        });
        
        const installResult = await modInstallService.installModToServer(win, serverPath, modDetails);

        if (!installResult || !installResult.success) {
          logger.error('Failed to install updated mod version', {
            category: 'mods',
            data: {
              modFileName: modFileName,
              projectId: projectId,
              targetVersion: targetVersion,
              installError: installResult?.error
            }
          });
          throw new Error(`Failed to install updated version: ${installResult?.error || 'Unknown error'}`);
        }
        
        logger.debug('Mod installation completed successfully', {
          category: 'mods',
          data: {
            modFileName: modFileName,
            targetVersion: targetVersion,
            installSuccess: installResult.success
          }
        });

        // After successful installation, ensure the mod is in the correct location based on original category
        await modFileManager.moveModFile({ 
          fileName: modFileName, 
          newCategory: originalCategory, 
          serverPath 
        });

        // Update the disabled mods list to remove this mod
        const updatedDisabledMods = disabledMods.filter(mod => mod !== modFileName);
        await modFileManager.saveDisabledMods(serverPath, updatedDisabledMods);
        
        // Force clear any cached mod information to ensure fresh data
        try {
          const modApiService = require('../../services/mod-api-service.cjs');
          modApiService.clearVersionCache();
        } catch {
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

        logger.info('Mod enable and update completed successfully', {
          category: 'mods',
          data: {
            handler: 'enable-and-update-mod',
            modFileName: modFileName,
            projectId: projectId,
            targetVersion: targetVersion,
            originalCategory: originalCategory,
            success: true
          }
        });

        return {
          success: true,
          message: `Mod ${modFileName} successfully enabled and updated to version ${targetVersion} in ${originalCategory} location`,
          newFileName: modFileName, // Keep the same filename structure
          oldFileName: modFileName,
          version: targetVersion,
          category: originalCategory // Return the preserved category for confirmation
        };

      } catch (error) {
        logger.error(`Mod enable and update failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'enable-and-update-mod',
            modFileName: modFileName,
            projectId: projectId,
            targetVersion: targetVersion,
            errorType: error.constructor.name
          }
        });
        
        return {
          success: false,
          error: error.message
        };
      }
    },

    'check-disabled-mod-updates': async (_e, { serverPath, mcVersion }) => {
      logger.info('Checking disabled mod updates', {
        category: 'mods',
        data: {
          handler: 'check-disabled-mod-updates',
          serverPath: serverPath,
          mcVersion: mcVersion
        }
      });

      try {
        // Get disabled mods
        const disabledMods = await modFileManager.getDisabledMods(serverPath);
        const installed = await modFileManager.getInstalledModInfo(serverPath);
        
        const disabledModsSet = new Set(disabledMods);
        const disabledModsInfo = installed.filter(mod => disabledModsSet.has(mod.fileName));
        
        logger.debug('Processing disabled mod update checks', {
          category: 'mods',
          data: {
            handler: 'check-disabled-mod-updates',
            totalDisabledMods: disabledMods.length,
            disabledModsWithInfo: disabledModsInfo.length,
            mcVersion: mcVersion
          }
        });
        
        const results = [];
        
        for (const mod of disabledModsInfo) {
          const projectId = mod.projectId;
          const fileName = mod.fileName;
          const name = mod.name || mod.title || fileName;
          let currentVersion = mod.versionNumber || mod.version || null;
          
          if (!currentVersion || currentVersion === 'Unknown') {
            currentVersion = extractVersionFromFilename(fileName) || 'Unknown';
          }
          
          logger.debug('Processing disabled mod update check', {
            category: 'mods',
            data: {
              modName: name,
              fileName: fileName,
              projectId: projectId,
              currentVersion: currentVersion,
              hasProjectId: !!projectId
            }
          });
          
          if (!projectId) {
            // No project ID means we can't check for updates
            logger.debug('Disabled mod has no project ID, cannot check updates', {
              category: 'mods',
              data: {
                modName: name,
                fileName: fileName
              }
            });
            
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
            // FIXED: Check if ANY versions exist for target MC version FIRST
            const availableVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, false);
            
            logger.debug('Retrieved available versions for disabled mod', {
              category: 'network',
              data: {
                modName: name,
                projectId: projectId,
                mcVersion: mcVersion,
                availableVersionCount: availableVersions?.length || 0
              }
            });
            
            if (!availableVersions || availableVersions.length === 0) {
              // No versions available for target MC version
              logger.debug('No versions available for disabled mod', {
                category: 'mods',
                data: {
                  modName: name,
                  projectId: projectId,
                  mcVersion: mcVersion
                }
              });
              
              results.push({
                projectId,
                fileName,
                name,
                currentVersion,
                hasUpdate: false,
                updateAvailable: false,
                isCompatibleUpdate: false,
                reason: `No versions available for Minecraft ${mcVersion}`
              });
              continue;
            }
            
            // Get the latest available version for the target MC version
            const latestVersions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, true);
            const latest = latestVersions && latestVersions[0];
            
            // Check if current version actually exists in available versions for target MC
            const currentVersionExists = availableVersions.some(v => 
              v.versionNumber === currentVersion && 
              v.gameVersions && 
              v.gameVersions.includes(mcVersion)
            );
            
            if (currentVersionExists) {
              // Current version is available for target MC version
              if (latest && latest.versionNumber !== currentVersion) {
                // There's a newer version available
                logger.debug('Update available for disabled mod', {
                  category: 'mods',
                  data: {
                    modName: name,
                    currentVersion: currentVersion,
                    latestVersion: latest.versionNumber,
                    updateType: 'newer_version'
                  }
                });
                
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
                // Current version is the latest for target MC
                logger.debug('Disabled mod current version is compatible and latest', {
                  category: 'mods',
                  data: {
                    modName: name,
                    currentVersion: currentVersion,
                    mcVersion: mcVersion
                  }
                });
                
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
            } else if (latest) {
              // Current version doesn't exist for target MC, but there's a compatible version available
              logger.debug('Disabled mod needs update for compatibility', {
                category: 'mods',
                data: {
                  modName: name,
                  currentVersion: currentVersion,
                  latestVersion: latest.versionNumber,
                  updateType: 'compatibility_required'
                }
              });
              
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
                reason: `Update required: ${currentVersion} not available for MC ${mcVersion}, compatible version: ${latest.versionNumber}`
              });
            } else {
              // This shouldn't happen since we checked availableVersions.length > 0 above
              logger.warn('No compatible versions found for disabled mod despite available versions', {
                category: 'mods',
                data: {
                  modName: name,
                  projectId: projectId,
                  currentVersion: currentVersion,
                  mcVersion: mcVersion
                }
              });
              
              results.push({
                projectId,
                fileName,
                name,
                currentVersion,
                hasUpdate: false,
                updateAvailable: false,
                isCompatibleUpdate: false,
                reason: `No compatible versions found for Minecraft ${mcVersion}`
              });
            }
            
          } catch (err) {
            logger.error(`Error checking disabled mod update: ${err.message}`, {
              category: 'mods',
              data: {
                modName: name,
                projectId: projectId,
                fileName: fileName,
                errorType: err.constructor.name
              }
            });
            
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
        
        logger.info('Disabled mod update check completed', {
          category: 'mods',
          data: {
            handler: 'check-disabled-mod-updates',
            serverPath: serverPath,
            mcVersion: mcVersion,
            totalChecked: disabledModsInfo.length,
            updatesAvailable: results.filter(r => r.hasUpdate).length,
            compatibleUpdates: results.filter(r => r.isCompatibleUpdate).length
          }
        });
        
        return results;
        
      } catch (error) {
        logger.error(`Failed to check disabled mod updates: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'check-disabled-mod-updates',
            serverPath: serverPath,
            mcVersion: mcVersion,
            errorType: error.constructor.name
          }
        });
        throw new Error(`Failed to check disabled mod updates: ${error.message}`);
      }
    }
  };
}

module.exports = { createServerModHandlers };
