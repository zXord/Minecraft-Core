const fs = require('fs');
const path = require('path');
const modApiService = require('../../services/mod-api-service.cjs');
const { getModrinthDownloadUrl, getCurseForgeDownloadUrl } = require('../../services/mod-api-service.cjs');
const modFileManager = require('../mod-utils/mod-file-manager.cjs');
const modInstallService = require('../mod-utils/mod-installation-service.cjs');
const { downloadWithProgress } = require('../../services/download-manager.cjs');
const {
  extractVersionFromFilename
} = require('./mod-handler-utils.cjs');
const { getLoggerHandlers } = require('../logger-handlers.cjs');
const { serverErrorMonitor } = require('../error-monitoring-handlers.cjs');

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

            logger.debug('Diagnostic snapshot for incompatibility', {
              category: 'mods',
              data: {
                modName: name,
                availableSample: availableVersions.slice(0,5).map(v => ({ num: v.versionNumber, gv: v.gameVersions })),
                latestSample: latestVersions ? latestVersions.slice(0,3).map(v => v.versionNumber) : [],
                reason: 'No version entry matched both versionNumber and mcVersion'
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
    // ---------------- Ignored Mod Updates -----------------
    'get-ignored-mod-updates': async (_e, serverPath) => {
      try {
        const data = await modFileManager.getIgnoredModUpdates(serverPath);
        return data;
      } catch (error) {
        logger.error(`Failed to get ignored mod updates: ${error.message}`, { category: 'mods', data: { handler: 'get-ignored-mod-updates', serverPath } });
        return {};
      }
    },
    'save-ignored-mod-updates': async (_e, serverPath, data) => {
      try {
        let parsed = data;
        if (typeof data === 'string') {
          try { parsed = JSON.parse(data); } catch { parsed = {}; }
        }
        try {
          const loggerHandlers = getLoggerHandlers();
          loggerHandlers.debug('Saving ignored mod updates', {
            category:'mods',
            data: { handler:'save-ignored-mod-updates', serverPath, keys: Object.keys(parsed||{}).length }
          });
  } catch { /* ignore logging errors */ }
        await modFileManager.saveIgnoredModUpdates(serverPath, parsed || {});
        return { success: true };
      } catch (error) {
        logger.error(`Failed to save ignored mod updates: ${error.message}`, { category: 'mods', data: { handler: 'save-ignored-mod-updates', serverPath } });
        return { success: false, error: error.message };
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

    'install-mod-with-fallback': async (_e, serverPath, modDetails) => {
      const startTime = Date.now();
      
      logger.info('Installing server mod with fallback support', {
        category: 'mods',
        data: {
          handler: 'install-mod-with-fallback',
          serverPath: serverPath,
          modName: modDetails?.name,
          modId: modDetails?.id,
          useFallback: modDetails?.useFallback,
          maxRetries: modDetails?.maxRetries,
          fallbackDelay: modDetails?.fallbackDelay,
          hasDownloadUrl: !!modDetails?.downloadUrl,
          originalSource: modDetails?.originalSource
        }
      });

      try {
        // Use the enhanced mod install service with fallback support
        const result = await modInstallService.installModToServerWithFallback(
          win, 
          serverPath, 
          modDetails
        );
        
        const duration = Date.now() - startTime;
        
        logger.info('Server mod installation with fallback completed', {
          category: 'mods',
          data: {
            handler: 'install-mod-with-fallback',
            serverPath: serverPath,
            modName: modDetails?.name,
            success: result?.success,
            source: result?.source,
            attempts: result?.attempts,
            fallbackUsed: result?.fallbackUsed,
            checksumErrors: result?.checksumErrors,
            duration
          }
        });
        
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        
        logger.error(`Server mod installation with fallback failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'install-mod-with-fallback',
            serverPath: serverPath,
            modName: modDetails?.name,
            modId: modDetails?.id,
            errorType: error.constructor.name,
            duration
          }
        });
        throw error;
      }
    },

    'download-mod-from-server': async (_e, { mod, attempt, totalAttempts, validateChecksum = true }) => {
      logger.info('Downloading mod from server', {
        category: 'mods',
        data: {
          handler: 'download-mod-from-server',
          modName: mod?.name,
          modId: mod?.id,
          attempt,
          totalAttempts,
          validateChecksum,
          hasExpectedChecksum: !!mod.expectedChecksum
        }
      });

      try {
        // Use the existing mod API service to download from server
        const downloadUrl = mod.downloadUrl || await getModrinthDownloadUrl(
          mod.projectId || mod.id,
          mod.version,
          mod.loader
        );

        if (!downloadUrl) {
          throw new Error('No download URL available for server download');
        }

        // Create a temporary file path for download
        const tempDir = require('os').tmpdir();
        const tempFileName = `${mod.name || mod.id}_${Date.now()}.jar`;
        const tempFilePath = require('path').join(tempDir, tempFileName);

        // Download the file with progress reporting
        await downloadWithProgress(downloadUrl, tempFilePath, `download-progress-${mod.id || mod.name}`);
        
        // Get file size after download
        const stats = fs.statSync(tempFilePath);
        const fileSize = stats.size;

        // Perform checksum validation if requested and checksum is available
        let checksumValidation = null;
        if (validateChecksum && mod.expectedChecksum) {
          logger.debug('Performing checksum validation with integrity service', {
            category: 'mods',
            data: {
              handler: 'download-mod-from-server',
              modName: mod?.name,
              filePath: tempFilePath,
              expectedChecksum: mod.expectedChecksum,
              algorithm: mod.checksumAlgorithm || 'sha1'
            }
          });

          // Use the file integrity service for validation
          checksumValidation = await module.exports.createServerModHandlers(win)['verify-file-integrity'](_e, {
            filePath: tempFilePath,
            expectedChecksum: mod.expectedChecksum,
            algorithm: mod.checksumAlgorithm || 'sha1'
          });

          if (!checksumValidation.isValid) {
            // Delete the invalid file
            try {
              await require('fs/promises').unlink(tempFilePath);
            } catch (unlinkError) {
              logger.warn(`Failed to delete invalid file: ${unlinkError.message}`, {
                category: 'storage',
                data: {
                  handler: 'download-mod-from-server',
                  filePath: tempFilePath
                }
              });
            }

            throw new Error(`Checksum validation failed: expected ${checksumValidation.expected}, got ${checksumValidation.actual}`);
          } else {
            // Store the valid checksum for future verification
            try {
              await module.exports.createServerModHandlers(win)['store-file-checksum'](_e, {
                filePath: tempFilePath,
                checksum: checksumValidation.actual,
                algorithm: checksumValidation.algorithm,
                metadata: {
                  modId: mod.id,
                  modName: mod.name,
                  source: 'server',
                  downloadUrl,
                  downloadTime: Date.now()
                }
              });
            } catch (storeError) {
              logger.warn(`Failed to store checksum: ${storeError.message}`, {
                category: 'storage',
                data: {
                  handler: 'download-mod-from-server',
                  filePath: tempFilePath
                }
              });
            }
          }
        }

        logger.info('Server download completed successfully', {
          category: 'mods',
          data: {
            handler: 'download-mod-from-server',
            modName: mod?.name,
            filePath: tempFilePath,
            fileSize: fileSize,
            checksumValid: checksumValidation?.isValid,
            checksumValidated: !!checksumValidation
          }
        });

        return {
          success: true,
          filePath: tempFilePath,
          downloadUrl,
          size: fileSize,
          checksumValidation
        };
      } catch (error) {
        // Log to error monitoring system
        serverErrorMonitor.logDownloadError({
          type: error.message.includes('Checksum') ? 'checksum' : 'network',
          message: error.message,
          source: 'server',
          modId: mod?.id,
          modName: mod?.name,
          attempt,
          totalAttempts,
          downloadUrl: mod.downloadUrl,
          httpStatus: error.response?.status,
          timeout: error.timeout,
          stack: error.stack,
          errorType: error.constructor.name,
          networkDetails: {
            url: mod.downloadUrl,
            method: 'GET',
            timeout: error.timeout,
            connectionTime: error.connectionTime
          },
          checksumDetails: mod.expectedChecksum ? {
            expected: mod.expectedChecksum,
            algorithm: mod.checksumAlgorithm || 'sha1'
          } : null
        });

        logger.error(`Server download failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'download-mod-from-server',
            modName: mod?.name,
            attempt,
            errorType: error.constructor.name,
            isChecksumError: error.message.includes('Checksum')
          }
        });
        throw error;
      }
    },

    'download-mod-from-fallback': async (_e, { mod, source, attempt, totalAttempts, validateChecksum = true }) => {
      logger.info('Downloading mod from fallback source', {
        category: 'mods',
        data: {
          handler: 'download-mod-from-fallback',
          modName: mod?.name,
          modId: mod?.id,
          source,
          attempt,
          totalAttempts,
          validateChecksum,
          hasExpectedChecksum: !!mod.expectedChecksum
        }
      });

      let downloadUrl;
      
      try {
        // Get download URL based on fallback source
        if (source === 'modrinth') {
          downloadUrl = await getModrinthDownloadUrl(
            mod.projectId || mod.id,
            mod.version,
            mod.loader
          );
        } else if (source === 'curseforge') {
          // Use CurseForge API if available
          if (mod.curseforgeId) {
            try {
              downloadUrl = await getCurseForgeDownloadUrl();
            } catch (error) {
              throw new Error(`CurseForge download not supported: ${error.message}`);
            }
          } else {
            throw new Error('CurseForge ID not available for fallback download');
          }
        } else {
          throw new Error(`Unsupported fallback source: ${source}`);
        }

        if (!downloadUrl) {
          throw new Error(`No download URL available for ${source} fallback`);
        }

        // Create a temporary file path for download
        const tempDir = require('os').tmpdir();
        const tempFileName = `${mod.name || mod.id}_${source}_${Date.now()}.jar`;
        const tempFilePath = require('path').join(tempDir, tempFileName);

        // Download the file with progress reporting
        await downloadWithProgress(downloadUrl, tempFilePath, `download-progress-${mod.id || mod.name}-${source}`);
        
        // Get file size after download
        const fallbackStats = fs.statSync(tempFilePath);
        const fallbackFileSize = fallbackStats.size;

        // Perform checksum validation if requested and checksum is available
        let checksumValidation = null;
        if (validateChecksum && mod.expectedChecksum) {
          logger.debug('Performing checksum validation on fallback download with integrity service', {
            category: 'mods',
            data: {
              handler: 'download-mod-from-fallback',
              modName: mod?.name,
              source,
              filePath: tempFilePath,
              expectedChecksum: mod.expectedChecksum,
              algorithm: mod.checksumAlgorithm || 'sha1'
            }
          });

          // Use the file integrity service for validation
          checksumValidation = await module.exports.createServerModHandlers(win)['verify-file-integrity'](_e, {
            filePath: tempFilePath,
            expectedChecksum: mod.expectedChecksum,
            algorithm: mod.checksumAlgorithm || 'sha1'
          });

          if (!checksumValidation.isValid) {
            // Delete the invalid file
            try {
              await require('fs/promises').unlink(tempFilePath);
            } catch (unlinkError) {
              logger.warn(`Failed to delete invalid file: ${unlinkError.message}`, {
                category: 'storage',
                data: {
                  handler: 'download-mod-from-fallback',
                  filePath: tempFilePath
                }
              });
            }

            throw new Error(`Checksum validation failed: expected ${checksumValidation.expected}, got ${checksumValidation.actual}`);
          } else {
            // Store the valid checksum for future verification
            try {
              await module.exports.createServerModHandlers(win)['store-file-checksum'](_e, {
                filePath: tempFilePath,
                checksum: checksumValidation.actual,
                algorithm: checksumValidation.algorithm,
                metadata: {
                  modId: mod.id,
                  modName: mod.name,
                  source,
                  downloadUrl,
                  downloadTime: Date.now()
                }
              });
            } catch (storeError) {
              logger.warn(`Failed to store checksum: ${storeError.message}`, {
                category: 'storage',
                data: {
                  handler: 'download-mod-from-fallback',
                  filePath: tempFilePath
                }
              });
            }
          }
        }

        logger.info('Fallback download completed successfully', {
          category: 'mods',
          data: {
            handler: 'download-mod-from-fallback',
            modName: mod?.name,
            source,
            filePath: tempFilePath,
            fileSize: fallbackFileSize,
            checksumValid: checksumValidation?.isValid,
            checksumValidated: !!checksumValidation
          }
        });

        return {
          success: true,
          filePath: tempFilePath,
          downloadUrl,
          source,
          size: fallbackFileSize,
          checksumValidation
        };
      } catch (error) {
        // Log to error monitoring system
        serverErrorMonitor.logDownloadError({
          type: error.message.includes('Checksum') ? 'checksum' : 'network',
          message: error.message,
          source,
          modId: mod?.id,
          modName: mod?.name,
          attempt,
          totalAttempts,
          downloadUrl: downloadUrl || 'unknown',
          httpStatus: error.response?.status,
          timeout: error.timeout,
          stack: error.stack,
          errorType: error.constructor.name,
          networkDetails: {
            url: downloadUrl || 'unknown',
            method: 'GET',
            timeout: error.timeout,
            fallbackSource: source
          },
          checksumDetails: mod.expectedChecksum ? {
            expected: mod.expectedChecksum,
            algorithm: mod.checksumAlgorithm || 'sha1'
          } : null
        });

        logger.error(`Fallback download failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'download-mod-from-fallback',
            modName: mod?.name,
            source,
            attempt,
            errorType: error.constructor.name,
            isChecksumError: error.message.includes('Checksum')
          }
        });
        throw error;
      }
    },

    'calculate-file-checksum': async (_e, { filePath, algorithm = 'sha1' }) => {
      logger.debug('Calculating file checksum', {
        category: 'mods',
        data: {
          handler: 'calculate-file-checksum',
          filePath,
          algorithm
        }
      });

      try {
        const crypto = require('crypto');
        // fs is already declared at the top of the file
        
        return new Promise((resolve, reject) => {
          const hash = crypto.createHash(algorithm);
          const stream = fs.createReadStream(filePath);
          
          stream.on('data', (data) => {
            hash.update(data);
          });
          
          stream.on('end', () => {
            const checksum = hash.digest('hex');
            logger.debug('Checksum calculation completed', {
              category: 'mods',
              data: {
                handler: 'calculate-file-checksum',
                filePath,
                algorithm,
                checksum
              }
            });
            resolve(checksum);
          });
          
          stream.on('error', (error) => {
            logger.error(`Checksum calculation failed: ${error.message}`, {
              category: 'mods',
              data: {
                handler: 'calculate-file-checksum',
                filePath,
                algorithm,
                errorType: error.constructor.name
              }
            });
            reject(error);
          });
        });
      } catch (error) {
        logger.error(`Checksum calculation setup failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'calculate-file-checksum',
            filePath,
            algorithm,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'download-mod-with-fallback': async (_e, { mod, serverPath, options = { maxRetries: 3, fallbackDelay: 15 * 60 * 1000, useFallback: true } }) => {
      const startTime = Date.now();
      const downloadId = `mod-${mod.id || mod.name}-${Date.now()}`;
      
      logger.info('Starting mod download with fallback support', {
        category: 'mods',
        data: {
          handler: 'download-mod-with-fallback',
          modName: mod?.name,
          modId: mod?.id,
          serverPath,
          downloadId,
          maxRetries: options.maxRetries || 3,
          fallbackDelay: options.fallbackDelay || 15 * 60 * 1000,
          useFallback: options.useFallback !== false
        }
      });

      try {
        // Send initial progress update
        win.webContents.send('download-progress', {
          id: downloadId,
          name: mod.name,
          state: 'queued',
          progress: 0,
          source: 'server',
          attempt: 0,
          maxAttempts: options.maxRetries || 3,
          statusMessage: 'Queued for download...',
          startTime: Date.now()
        });

        // Use the enhanced mod install service with fallback support
        const result = await modInstallService.installModToServerWithFallback(
          win, 
          serverPath, 
          {
            ...mod,
            maxRetries: options.maxRetries || 3,
            fallbackDelay: options.fallbackDelay || 15 * 60 * 1000,
            useFallback: options.useFallback !== false,
            downloadId
          }
        );
        
        const duration = Date.now() - startTime;
        
        if (result.success) {
          win.webContents.send('download-progress', {
            id: downloadId,
            name: mod.name,
            state: 'completed',
            progress: 100,
            source: result.source || 'server',
            statusMessage: 'Download completed successfully',
            completedTime: Date.now(),
            duration
          });
          
          logger.info('Mod download with fallback completed successfully', {
            category: 'mods',
            data: {
              handler: 'download-mod-with-fallback',
              modName: mod?.name,
              downloadId,
              source: result.source,
              attempts: result.attempts,
              fallbackUsed: result.fallbackUsed,
              checksumErrors: result.checksumErrors,
              duration
            }
          });
        } else {
          win.webContents.send('download-progress', {
            id: downloadId,
            name: mod.name,
            state: 'failed',
            progress: 0,
            error: result.error || 'Download failed',
            statusMessage: 'Download failed',
            errorDetails: {
              lastSource: result.lastSource,
              attempts: result.attempts,
              checksumErrors: result.checksumErrors,
              networkErrors: result.networkErrors
            },
            completedTime: Date.now(),
            duration
          });
          
          logger.error('Mod download with fallback failed', {
            category: 'mods',
            data: {
              handler: 'download-mod-with-fallback',
              modName: mod?.name,
              downloadId,
              error: result.error,
              attempts: result.attempts,
              duration
            }
          });
        }
        
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        
        win.webContents.send('download-progress', {
          id: downloadId,
          name: mod.name,
          state: 'failed',
          progress: 0,
          error: error.message,
          statusMessage: 'Download failed',
          errorDetails: {
            errorType: error.constructor.name,
            message: error.message
          },
          completedTime: Date.now(),
          duration
        });
        
        logger.error(`Mod download with fallback failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'download-mod-with-fallback',
            modName: mod?.name,
            downloadId,
            errorType: error.constructor.name,
            duration
          }
        });
        
        throw error;
      }
    },

    'validate-file-checksum': async (_e, { filePath, expectedChecksum, algorithm = 'sha1' }) => {
      logger.debug('Validating file checksum', {
        category: 'mods',
        data: {
          handler: 'validate-file-checksum',
          filePath,
          expectedChecksum,
          algorithm
        }
      });

      try {
        const actualChecksum = await module.exports.createServerModHandlers(win)['calculate-file-checksum'](_e, { filePath, algorithm });
        
        const isValid = actualChecksum === expectedChecksum;
        
        const result = {
          isValid,
          expected: expectedChecksum,
          actual: actualChecksum,
          algorithm,
          validationTime: Date.now()
        };
        
        if (!isValid) {
          // Log checksum mismatch to error monitoring system
          serverErrorMonitor.logChecksumError({
            type: 'checksum',
            message: `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`,
            filePath,
            expected: expectedChecksum,
            actual: actualChecksum,
            algorithm,
            validationTime: Date.now()
          });
        }
        
        logger.debug('File checksum validation completed', {
          category: 'mods',
          data: {
            handler: 'validate-file-checksum',
            filePath,
            isValid,
            algorithm,
            expectedChecksum,
            actualChecksum
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`File checksum validation failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'validate-file-checksum',
            filePath,
            expectedChecksum,
            algorithm,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'verify-file-integrity': async (_e, { filePath, expectedChecksum, algorithm = 'sha1' }) => {
      const { fileIntegrityService } = require('../mod-utils/file-integrity-service.cjs');
      
      logger.debug('Verifying file integrity', {
        category: 'mods',
        data: {
          handler: 'verify-file-integrity',
          filePath,
          hasExpectedChecksum: !!expectedChecksum,
          algorithm
        }
      });

      try {
        const result = await fileIntegrityService.verifyFileIntegrity(filePath, expectedChecksum, algorithm);
        
        logger.debug('File integrity verification completed', {
          category: 'mods',
          data: {
            handler: 'verify-file-integrity',
            filePath,
            isValid: result.isValid,
            algorithm: result.algorithm
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`File integrity verification failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'verify-file-integrity',
            filePath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'store-file-checksum': async (_e, { filePath, checksum, algorithm = 'sha1', metadata = {} }) => {
      const { fileIntegrityService } = require('../mod-utils/file-integrity-service.cjs');
      
      logger.debug('Storing file checksum', {
        category: 'mods',
        data: {
          handler: 'store-file-checksum',
          filePath,
          checksum,
          algorithm,
          hasMetadata: Object.keys(metadata).length > 0
        }
      });

      try {
        await fileIntegrityService.storeFileChecksum(filePath, checksum, algorithm, metadata);
        
        logger.debug('File checksum stored successfully', {
          category: 'mods',
          data: {
            handler: 'store-file-checksum',
            filePath,
            algorithm
          }
        });
        
        return { success: true };
      } catch (error) {
        logger.error(`Failed to store file checksum: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'store-file-checksum',
            filePath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'get-stored-checksum': async (_e, { filePath }) => {
      const { fileIntegrityService } = require('../mod-utils/file-integrity-service.cjs');
      
      logger.debug('Getting stored checksum', {
        category: 'mods',
        data: {
          handler: 'get-stored-checksum',
          filePath
        }
      });

      try {
        const result = await fileIntegrityService.getStoredChecksum(filePath);
        
        logger.debug('Stored checksum retrieved', {
          category: 'mods',
          data: {
            handler: 'get-stored-checksum',
            filePath,
            found: !!result,
            algorithm: result?.algorithm
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`Failed to get stored checksum: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'get-stored-checksum',
            filePath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'batch-verify-integrity': async (_e, { filePaths }) => {
      const { fileIntegrityService } = require('../mod-utils/file-integrity-service.cjs');
      
      logger.info('Starting batch integrity verification', {
        category: 'mods',
        data: {
          handler: 'batch-verify-integrity',
          fileCount: filePaths?.length || 0
        }
      });

      try {
        const result = await fileIntegrityService.batchVerifyIntegrity(filePaths, (progress) => {
          // Send progress updates to the renderer
          if (win && win.webContents) {
            win.webContents.send('batch-integrity-progress', progress);
          }
        });
        
        logger.info('Batch integrity verification completed', {
          category: 'mods',
          data: {
            handler: 'batch-verify-integrity',
            total: result.total,
            valid: result.valid,
            invalid: result.invalid,
            errors: result.errors
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`Batch integrity verification failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'batch-verify-integrity',
            fileCount: filePaths?.length || 0,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'get-corruption-alerts': async () => {
      const { fileIntegrityService } = require('../mod-utils/file-integrity-service.cjs');
      
      logger.debug('Getting corruption alerts', {
        category: 'mods',
        data: {
          handler: 'get-corruption-alerts'
        }
      });

      try {
        const alerts = fileIntegrityService.getCorruptionAlerts();
        
        logger.debug('Corruption alerts retrieved', {
          category: 'mods',
          data: {
            handler: 'get-corruption-alerts',
            alertCount: alerts.length
          }
        });
        
        return alerts;
      } catch (error) {
        logger.error(`Failed to get corruption alerts: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'get-corruption-alerts',
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'clear-corruption-alert': async (_e, { filePath }) => {
      const { fileIntegrityService } = require('../mod-utils/file-integrity-service.cjs');
      
      logger.debug('Clearing corruption alert', {
        category: 'mods',
        data: {
          handler: 'clear-corruption-alert',
          filePath
        }
      });

      try {
        const cleared = fileIntegrityService.clearCorruptionAlert(filePath);
        
        logger.debug('Corruption alert clear result', {
          category: 'mods',
          data: {
            handler: 'clear-corruption-alert',
            filePath,
            cleared
          }
        });
        
        return { success: cleared };
      } catch (error) {
        logger.error(`Failed to clear corruption alert: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'clear-corruption-alert',
            filePath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'auto-redownload-corrupted-file': async (event, { filePath, mod, serverPath }) => {
      logger.info('Starting automatic re-download for corrupted file', {
        category: 'mods',
        data: {
          handler: 'auto-redownload-corrupted-file',
          filePath,
          modName: mod?.name,
          modId: mod?.id,
          serverPath
        }
      });

      try {
        const { fileIntegrityService } = require('../mod-utils/file-integrity-service.cjs');
        
        // First, verify the file is actually corrupted
        const integrityResult = await fileIntegrityService.verifyFileIntegrity(filePath);
        
        if (integrityResult.isValid === true) {
          logger.info('File is not corrupted, skipping re-download', {
            category: 'mods',
            data: {
              handler: 'auto-redownload-corrupted-file',
              filePath,
              modName: mod?.name
            }
          });
          
          return { success: true, skipped: true, reason: 'file_not_corrupted' };
        }

        if (integrityResult.isValid === null) {
          logger.warn('Cannot verify file integrity (no expected checksum), skipping re-download', {
            category: 'mods',
            data: {
              handler: 'auto-redownload-corrupted-file',
              filePath,
              modName: mod?.name
            }
          });
          
          return { success: false, skipped: true, reason: 'no_expected_checksum' };
        }

        // File is corrupted, attempt re-download
        logger.info('File corruption confirmed, attempting re-download', {
          category: 'mods',
          data: {
            handler: 'auto-redownload-corrupted-file',
            filePath,
            modName: mod?.name,
            expected: integrityResult.expected,
            actual: integrityResult.actual
          }
        });

        // Try to re-download using the original source first
        let redownloadResult;
        
        try {
          // Attempt server download first
          redownloadResult = await module.exports.createServerModHandlers(win)['download-mod-from-server'](event, {
            mod: {
              ...mod,
              expectedChecksum: integrityResult.expected,
              checksumAlgorithm: integrityResult.algorithm
            },
            attempt: 1,
            totalAttempts: 3,
            validateChecksum: true
          });
          
          if (redownloadResult.success) {
            // Replace the corrupted file with the new download
            const fsPromises = require('fs/promises');
            await fsPromises.copyFile(redownloadResult.filePath, filePath);
            await fsPromises.unlink(redownloadResult.filePath); // Clean up temp file
            
            // Clear the corruption alert
            fileIntegrityService.clearCorruptionAlert(filePath);
            
            logger.info('File successfully re-downloaded from server', {
              category: 'mods',
              data: {
                handler: 'auto-redownload-corrupted-file',
                filePath,
                modName: mod?.name,
                source: 'server'
              }
            });
            
            return { 
              success: true, 
              source: 'server',
              checksumValidation: redownloadResult.checksumValidation
            };
          }
        } catch (serverError) {
          logger.warn(`Server re-download failed: ${serverError.message}`, {
            category: 'mods',
            data: {
              handler: 'auto-redownload-corrupted-file',
              filePath,
              modName: mod?.name,
              errorType: serverError.constructor.name
            }
          });
        }

        // Try fallback sources if server failed
        const fallbackSources = [];
        if (mod.projectId || mod.modrinthId) {
          fallbackSources.push('modrinth');
        }
        if (mod.curseforgeId) {
          fallbackSources.push('curseforge');
        }

        for (const source of fallbackSources) {
          try {
            logger.info(`Attempting re-download from fallback source: ${source}`, {
              category: 'mods',
              data: {
                handler: 'auto-redownload-corrupted-file',
                filePath,
                modName: mod?.name,
                source
              }
            });

            redownloadResult = await module.exports.createServerModHandlers(win)['download-mod-from-fallback'](event, {
              mod: {
                ...mod,
                expectedChecksum: integrityResult.expected,
                checksumAlgorithm: integrityResult.algorithm
              },
              source,
              attempt: 1,
              totalAttempts: 1,
              validateChecksum: true
            });
            
            if (redownloadResult.success) {
              // Replace the corrupted file with the new download
              const fsPromises2 = require('fs/promises');
              await fsPromises2.copyFile(redownloadResult.filePath, filePath);
              await fsPromises2.unlink(redownloadResult.filePath); // Clean up temp file
              
              // Clear the corruption alert
              fileIntegrityService.clearCorruptionAlert(filePath);
              
              logger.info(`File successfully re-downloaded from ${source}`, {
                category: 'mods',
                data: {
                  handler: 'auto-redownload-corrupted-file',
                  filePath,
                  modName: mod?.name,
                  source
                }
              });
              
              return { 
                success: true, 
                source,
                checksumValidation: redownloadResult.checksumValidation
              };
            }
          } catch (fallbackError) {
            logger.warn(`Fallback re-download from ${source} failed: ${fallbackError.message}`, {
              category: 'mods',
              data: {
                handler: 'auto-redownload-corrupted-file',
                filePath,
                modName: mod?.name,
                source,
                errorType: fallbackError.constructor.name
              }
            });
          }
        }

        // All re-download attempts failed
        logger.error('All re-download attempts failed for corrupted file', {
          category: 'mods',
          data: {
            handler: 'auto-redownload-corrupted-file',
            filePath,
            modName: mod?.name,
            triedSources: ['server', ...fallbackSources]
          }
        });

        return { 
          success: false, 
          error: 'All re-download attempts failed',
          triedSources: ['server', ...fallbackSources]
        };

      } catch (error) {
        logger.error(`Automatic re-download failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'auto-redownload-corrupted-file',
            filePath,
            modName: mod?.name,
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

    'update-mod': async (_e, { serverPath, projectId, targetVersion, fileName, mcVersion }) => {
      logger.info('Updating server mod', {
        category: 'mods',
        data: {
          handler: 'update-mod',
          serverPath: serverPath,
          projectId: projectId,
          targetVersion: targetVersion,
          fileName: fileName,
          mcVersion
        }
      });

      try {
        if (!mcVersion) {
          logger.warn('update-mod called without mcVersion; rejecting to avoid picking wrong latest version', {
            category: 'mods',
            data: { handler: 'update-mod', projectId }
          });
          throw new Error('Minecraft version (mcVersion) is required to update a mod safely');
        }

        const versions = await modApiService.getModrinthVersions(projectId, 'fabric', mcVersion, false);
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
  const completeVersionInfo = await modApiService.getModrinthVersionInfo(projectId, targetVersionInfo.id, mcVersion, 'fabric');
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

  'enable-and-update-mod': async (_e, { serverPath, modFileName, projectId, targetVersion, targetVersionId, mcVersion }) => {
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
        
  const targetVersionInfo = await modApiService.getModrinthVersionInfo(projectId, targetVersionId, mcVersion, 'fabric');
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

        // Helper: loose semantic-ish comparison. Returns negative if a<b, 0 if equal, positive if a>b
        function compareLooseVersions(a, b) {
          try {
            const norm = v => String(v || '').trim().toLowerCase().replace(/^v/, '');
            const extractNumeric = v => {
              const m = norm(v).match(/\d+(?:\.\d+){0,3}/); // capture up to 4 numeric segments
              return m ? m[0] : '';
            };
            const as = extractNumeric(a).split('.').filter(Boolean).map(n => parseInt(n, 10));
            const bs = extractNumeric(b).split('.').filter(Boolean).map(n => parseInt(n, 10));
            if (as.length === 0 || bs.length === 0) return 0; // can't compare meaningfully
            const len = Math.max(as.length, bs.length);
            for (let i = 0; i < len; i++) {
              const ai = as[i] || 0; const bi = bs[i] || 0;
              if (ai !== bi) return ai - bi;
            }
            return 0;
          } catch {
            return 0;
          }
        }
        
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
              if (latest && latest.versionNumber !== currentVersion && compareLooseVersions(currentVersion, latest.versionNumber) < 0) {
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
              // Current version doesn't exist for target MC, but there's a compatible version available.
              // Guard: avoid suggesting a downgrade if installed version appears newer semantically.
              const cmp = compareLooseVersions(currentVersion, latest.versionNumber);
              if (cmp >= 0) { // installed is newer or equal numerically
                logger.debug('Skipping disabled mod update - would be downgrade across MC branches', {
                  category: 'mods',
                  data: { modName: name, currentVersion: currentVersion, targetVersion: latest.versionNumber, updateType: 'downgrade_skip' }
                });
                results.push({
                  projectId,
                  fileName,
                  name,
                  currentVersion,
                  hasUpdate: false,
                  updateAvailable: false,
                  isCompatibleUpdate: false,
                  reason: cmp > 0
                    ? `Installed version (${currentVersion}) appears newer than compatible build (${latest.versionNumber}) for MC ${mcVersion}`
                    : `Installed version (${currentVersion}) equals latest compatible build (${latest.versionNumber}) for MC ${mcVersion}`
                });
              } else {
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
              }
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
    },

    'list-shaders': async (_e, serverPath) => {
      logger.debug('Listing server shaders', {
        category: 'mods',
        data: {
          handler: 'list-shaders',
          serverPath: serverPath,
          pathExists: fs.existsSync(serverPath)
        }
      });

      try {
        const shadersPath = path.join(serverPath, 'client', 'shaderpacks');
        
        // Create shaderpacks directory if it doesn't exist
        if (!fs.existsSync(shadersPath)) {
          fs.mkdirSync(shadersPath, { recursive: true });
          logger.info('Created shaderpacks directory', {
            category: 'mods',
            data: { handler: 'list-shaders', shadersPath }
          });
        }

        const files = fs.readdirSync(shadersPath);
        const shaderFiles = files.filter(file => 
          file.toLowerCase().endsWith('.zip') || 
          file.toLowerCase().endsWith('.jar')
        );

        // Extract metadata from shader files
        const shaders = [];
        const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
        const clientManifestDir = path.join(serverPath, 'client', 'minecraft-core-manifests');
        
        for (const file of shaderFiles) {
          const filePath = path.join(shadersPath, file);
          let shaderData = {
            fileName: file,
            name: file.replace(/\.(zip|jar)$/i, ''),
            type: 'shader',
            path: filePath
          };

          // First, try to get version info from manifest files (created during installation)
          let manifestFound = false;
          const manifestPaths = [
            path.join(clientManifestDir, `${file}.json`),
            path.join(serverManifestDir, `${file}.json`)
          ];
          
          for (const manifestPath of manifestPaths) {
            try {
              if (fs.existsSync(manifestPath)) {
                const manifestContent = fs.readFileSync(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);
                
                if (manifest) {
                  shaderData = {
                    ...shaderData,
                    versionNumber: manifest.versionNumber || manifest.version,
                    projectId: manifest.projectId,
                    versionId: manifest.versionId,
                    name: manifest.name || shaderData.name,
                    minecraftVersion: manifest.minecraftVersion,
                    source: manifest.source || 'modrinth',
                    installationDate: manifest.installedAt || manifest.installationDate,
                    lastUpdated: manifest.lastUpdated,
                    installedAt: manifest.installedAt || manifest.installationDate
                  };
                  
                  logger.debug(`Shader manifest data for ${file}:`, {
                    category: 'core',
                    data: {
                      manifestPath: manifestPath,
                      installedAt: manifest.installedAt,
                      installationDate: manifest.installationDate,
                      lastUpdated: manifest.lastUpdated,
                      finalInstallationDate: shaderData.installationDate,
                      versionNumber: manifest.versionNumber || manifest.version,
                      projectId: manifest.projectId,
                      name: manifest.name
                    }
                  });
                  
                  manifestFound = true;
                  break;
                }
              }
            } catch {
              // Continue to next manifest path
            }
          }

          // If no manifest found, try to extract version information from the shader file itself
          if (!manifestFound) {
            try {
              const metadata = await modFileManager.readModMetadataFromJar(filePath);
              
              if (metadata && metadata.versionNumber) {
                shaderData = {
                  ...shaderData,
                  versionNumber: metadata.versionNumber,
                  projectId: metadata.projectId,
                  name: metadata.name || shaderData.name,
                  minecraftVersion: metadata.minecraftVersion,
                  source: 'modrinth' // Default source
                };
              } else {
                // Try to extract version from filename as fallback
                const versionFromFilename = extractVersionFromFilename(file);
                if (versionFromFilename) {
                  shaderData.versionNumber = versionFromFilename;
                } else {
                  // For shaders without version info, set a placeholder
                  shaderData.versionNumber = 'Unknown';
                }
              }
            } catch {
              // If metadata extraction fails, set placeholder version
              shaderData.versionNumber = 'Unknown';
            }
          }

          shaders.push(shaderData);
        }
        
        logger.info('Server shaders listed successfully', {
          category: 'mods',
          data: {
            handler: 'list-shaders',
            serverPath: serverPath,
            shaderCount: shaders.length
          }
        });
        
        const response = { shaderFiles: shaderFiles, mods: shaders };
        logger.debug('Returning shader data:', {
          category: 'mods',
          data: {
            handler: 'list-shaders',
            shaderFilesCount: shaderFiles.length,
            modsCount: shaders.length,
            sampleShader: shaders[0] || null
          }
        });
        return response;
      } catch (error) {
        logger.error(`Failed to list server shaders: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'list-shaders',
            serverPath: serverPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'list-resourcepacks': async (_e, serverPath) => {
      logger.debug('Listing server resource packs', {
        category: 'mods',
        data: {
          handler: 'list-resourcepacks',
          serverPath: serverPath,
          pathExists: fs.existsSync(serverPath)
        }
      });

      try {
        const resourcePacksPath = path.join(serverPath, 'client', 'resourcepacks');
        
        // Create resourcepacks directory if it doesn't exist
        if (!fs.existsSync(resourcePacksPath)) {
          fs.mkdirSync(resourcePacksPath, { recursive: true });
          logger.info('Created resourcepacks directory', {
            category: 'mods',
            data: { handler: 'list-resourcepacks', resourcePacksPath }
          });
        }

        const files = fs.readdirSync(resourcePacksPath);
        const resourcePackFiles = files.filter(file => 
          file.toLowerCase().endsWith('.zip') || 
          file.toLowerCase().endsWith('.jar')
        );

        // Extract metadata from resource pack files
        const resourcePacks = [];
        const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
        const clientManifestDir = path.join(serverPath, 'client', 'minecraft-core-manifests');
        
        for (const file of resourcePackFiles) {
          const filePath = path.join(resourcePacksPath, file);
          let resourcePackData = {
            fileName: file,
            name: file.replace(/\.(zip|jar)$/i, ''),
            type: 'resourcepack',
            path: filePath
          };

          // First, try to get version info from manifest files (created during installation)
          let manifestFound = false;
          const manifestPaths = [
            path.join(clientManifestDir, `${file}.json`),
            path.join(serverManifestDir, `${file}.json`)
          ];
          
          for (const manifestPath of manifestPaths) {
            try {
              if (fs.existsSync(manifestPath)) {
                const manifestContent = fs.readFileSync(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);
                
                if (manifest) {
                  resourcePackData = {
                    ...resourcePackData,
                    versionNumber: manifest.versionNumber || manifest.version,
                    projectId: manifest.projectId,
                    versionId: manifest.versionId,
                    name: manifest.name || resourcePackData.name,
                    minecraftVersion: manifest.minecraftVersion,
                    source: manifest.source || 'modrinth',
                    installationDate: manifest.installedAt || manifest.installationDate,
                    lastUpdated: manifest.lastUpdated,
                    installedAt: manifest.installedAt || manifest.installationDate
                  };
                  
                  logger.debug(`Resource pack manifest data for ${file}:`, {
                    category: 'core',
                    data: {
                      manifestPath: manifestPath,
                      installedAt: manifest.installedAt,
                      installationDate: manifest.installationDate,
                      lastUpdated: manifest.lastUpdated,
                      finalInstallationDate: resourcePackData.installationDate,
                      versionNumber: manifest.versionNumber || manifest.version,
                      projectId: manifest.projectId,
                      name: manifest.name
                    }
                  });
                  
                  manifestFound = true;
                  break;
                }
              }
            } catch {
              // Continue to next manifest path
            }
          }

          // If no manifest found, try to extract version information from the resource pack file itself
          if (!manifestFound) {
            try {
              const metadata = await modFileManager.readModMetadataFromJar(filePath);
              
              if (metadata && metadata.versionNumber) {
                resourcePackData = {
                  ...resourcePackData,
                  versionNumber: metadata.versionNumber,
                  projectId: metadata.projectId,
                  name: metadata.name || resourcePackData.name,
                  minecraftVersion: metadata.minecraftVersion,
                  source: 'modrinth' // Default source
                };
              } else {
                // Try to extract version from filename as fallback
                const versionFromFilename = extractVersionFromFilename(file);
                if (versionFromFilename) {
                  resourcePackData.versionNumber = versionFromFilename;
                } else {
                  // For resource packs without version info, set a placeholder
                  resourcePackData.versionNumber = 'Unknown';
                }
              }
            } catch {
              // If metadata extraction fails, set placeholder version
              resourcePackData.versionNumber = 'Unknown';
            }
          }

          resourcePacks.push(resourcePackData);
        }
        
        logger.info('Server resource packs listed successfully', {
          category: 'mods',
          data: {
            handler: 'list-resourcepacks',
            serverPath: serverPath,
            resourcePackCount: resourcePacks.length
          }
        });
        
        const response = { resourcePackFiles: resourcePackFiles, mods: resourcePacks };
        logger.debug('Returning resource pack data:', {
          category: 'mods',
          data: {
            handler: 'list-resourcepacks',
            resourcePackFilesCount: resourcePackFiles.length,
            modsCount: resourcePacks.length,
            sampleResourcePack: resourcePacks[0] || null
          }
        });
        return response;
      } catch (error) {
        logger.error(`Failed to list server resource packs: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'list-resourcepacks',
            serverPath: serverPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'delete-shader': async (_e, serverPath, shaderName) => {
      logger.debug('Deleting server shader', {
        category: 'mods',
        data: {
          handler: 'delete-shader',
          serverPath: serverPath,
          shaderName: shaderName
        }
      });

      try {
        const shadersPath = path.join(serverPath, 'client', 'shaderpacks');
        const shaderPath = path.join(shadersPath, shaderName);
        
        if (fs.existsSync(shaderPath)) {
          fs.unlinkSync(shaderPath);
          
          logger.info('Server shader deleted successfully', {
            category: 'mods',
            data: {
              handler: 'delete-shader',
              serverPath: serverPath,
              shaderName: shaderName
            }
          });
          
          return { success: true, deletedFrom: [shaderPath] };
        } else {
          logger.warn('Shader file not found for deletion', {
            category: 'mods',
            data: {
              handler: 'delete-shader',
              serverPath: serverPath,
              shaderName: shaderName,
              shaderPath: shaderPath
            }
          });
          
          return { success: true, deletedFrom: 'not_found' };
        }
      } catch (error) {
        logger.error(`Failed to delete server shader: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'delete-shader',
            serverPath: serverPath,
            shaderName: shaderName,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'delete-resourcepack': async (_e, serverPath, resourcePackName) => {
      logger.debug('Deleting server resource pack', {
        category: 'mods',
        data: {
          handler: 'delete-resourcepack',
          serverPath: serverPath,
          resourcePackName: resourcePackName
        }
      });

      try {
        const resourcePacksPath = path.join(serverPath, 'client', 'resourcepacks');
        const resourcePackPath = path.join(resourcePacksPath, resourcePackName);
        
        if (fs.existsSync(resourcePackPath)) {
          fs.unlinkSync(resourcePackPath);
          
          logger.info('Server resource pack deleted successfully', {
            category: 'mods',
            data: {
              handler: 'delete-resourcepack',
              serverPath: serverPath,
              resourcePackName: resourcePackName
            }
          });
          
          return { success: true, deletedFrom: [resourcePackPath] };
        } else {
          logger.warn('Resource pack file not found for deletion', {
            category: 'mods',
            data: {
              handler: 'delete-resourcepack',
              serverPath: serverPath,
              resourcePackName: resourcePackName,
              resourcePackPath: resourcePackPath
            }
          });
          
          return { success: true, deletedFrom: 'not_found' };
        }
      } catch (error) {
        logger.error(`Failed to delete server resource pack: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'delete-resourcepack',
            serverPath: serverPath,
            resourcePackName: resourcePackName,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'install-shader-with-fallback': async (_e, serverPath, shaderDetails) => {
      const startTime = Date.now();
      
      logger.info('SHADER INSTALL: Starting shader installation', {
        category: 'mods',
        data: {
          handler: 'install-shader-with-fallback',
          serverPath: serverPath,
          shaderName: shaderDetails?.name,
          shaderId: shaderDetails?.id,
          shaderDetails: JSON.stringify(shaderDetails, null, 2)
        }
      });

      try {
        // Modify shader details to specify it's a shader
        const modifiedShaderDetails = {
          ...shaderDetails,
          contentType: 'shaders',
          targetDirectory: 'shaderpacks'
        };
        
        logger.info('SHADER INSTALL: Calling mod install service with modified details', {
          category: 'mods',
          data: {
            handler: 'install-shader-with-fallback',
            modifiedDetails: JSON.stringify(modifiedShaderDetails, null, 2)
          }
        });
        
        // First install using the regular mod install service
        const result = await modInstallService.installModToServer(win, serverPath, modifiedShaderDetails);
        
        logger.info('SHADER INSTALL: Result from mod service', {
          category: 'mods',
          data: {
            handler: 'install-shader-with-fallback',
            success: result?.success,
            filePath: result?.filePath,
            hasResult: !!result,
            fullResult: JSON.stringify(result, null, 2)
          }
        });
        
        // No need to move files anymore since they're installed directly in client/shaderpacks
        if (result && result.success) {
          logger.info('Shader installed successfully to client/shaderpacks', {
            category: 'mods',
            data: {
              handler: 'install-shader-with-fallback',
              filePath: result.filePath,
              shaderName: shaderDetails.name
            }
          });
        }
        
        logger.info('Shader installation completed', {
          category: 'mods',
          data: {
            handler: 'install-shader-with-fallback',
            serverPath: serverPath,
            shaderName: shaderDetails?.name,
            success: result?.success,
            duration: Date.now() - startTime
          }
        });

        return result;
      } catch (error) {
        logger.error(`Shader installation failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'install-shader-with-fallback',
            serverPath: serverPath,
            shaderName: shaderDetails?.name,
            error: error.message,
            duration: Date.now() - startTime
          }
        });
        throw error;
      }
    },

    'install-resourcepack-with-fallback': async (_e, serverPath, resourcePackDetails) => {
      const startTime = Date.now();
      
      logger.info('RESOURCEPACK INSTALL: Starting resource pack installation', {
        category: 'mods',
        data: {
          handler: 'install-resourcepack-with-fallback',
          serverPath: serverPath,
          resourcePackName: resourcePackDetails?.name,
          resourcePackId: resourcePackDetails?.id,
          resourcePackDetails: JSON.stringify(resourcePackDetails, null, 2)
        }
      });

      try {
        // Modify resource pack details to specify it's a resource pack
        const modifiedResourcePackDetails = {
          ...resourcePackDetails,
          contentType: 'resourcepacks',
          targetDirectory: 'resourcepacks'
        };
        
        logger.info('RESOURCEPACK INSTALL: Calling mod install service with modified details', {
          category: 'mods',
          data: {
            handler: 'install-resourcepack-with-fallback',
            modifiedDetails: JSON.stringify(modifiedResourcePackDetails, null, 2)
          }
        });
        
        // First install using the regular mod install service
        const result = await modInstallService.installModToServer(win, serverPath, modifiedResourcePackDetails);
        
        logger.info('RESOURCEPACK INSTALL: Result from mod service', {
          category: 'mods',
          data: {
            handler: 'install-resourcepack-with-fallback',
            success: result?.success,
            filePath: result?.filePath,
            hasResult: !!result,
            fullResult: JSON.stringify(result, null, 2)
          }
        });
        
        logger.info('Resource pack installation completed', {
          category: 'mods',
          data: {
            handler: 'install-resourcepack-with-fallback',
            serverPath: serverPath,
            resourcePackName: resourcePackDetails?.name,
            success: result?.success,
            duration: Date.now() - startTime
          }
        });

        return result;
      } catch (error) {
        logger.error(`Resource pack installation failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'install-resourcepack-with-fallback',
            serverPath: serverPath,
            resourcePackName: resourcePackDetails?.name,
            error: error.message,
            duration: Date.now() - startTime
          }
        });
        throw error;
      }
    }
  };
}

module.exports = { createServerModHandlers };
