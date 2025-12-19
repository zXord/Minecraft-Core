const path = require('path');
const fs = require('fs/promises');
const axios = require('axios');
const { createWriteStream } = require('fs');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipelineAsync = promisify(pipeline);

// Import JAR analysis utility
const { extractDependenciesFromJar } = require('./mod-analysis-utils.cjs');
const { getLoggerHandlers } = require('../logger-handlers.cjs');
const { UNASSIGNED_MODS_DIRNAME, UNASSIGNED_MANIFEST_DIRNAME } = require('./mod-file-manager.cjs');

// Placeholder for API service functions - these will be imported later
// For now, we might have to define minimal stubs or expect them to be passed if complex
const {
  getModrinthDownloadUrl,
  getModrinthVersionInfo,
  getLatestModrinthVersionInfo,
  getCurseForgeDownloadUrl, // Assuming this might be needed
  getModrinthVersions // For installClientMod
} = require('../../services/mod-api-service.cjs'); // Adjust path as needed


async function installModToServer(win, serverPath, modDetails) {
  const logger = getLoggerHandlers();

  logger.info('Installing mod to server', {
    category: 'mods',
    data: {
      service: 'mod-installation-service',
      operation: 'installModToServer',
      serverPath: serverPath,
      modName: modDetails?.name,
      modId: modDetails?.id,
      source: modDetails?.source,
      forceReinstall: modDetails?.forceReinstall
    }
  });

  if (!serverPath) {
    logger.error('Server path not provided for mod installation', {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        operation: 'installModToServer'
      }
    });
    return { success: false, error: 'Server path not provided' };
  }
  if (!modDetails || !modDetails.id || !modDetails.name) {
    logger.error('Invalid mod details for server installation', {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        operation: 'installModToServer',
        hasModDetails: !!modDetails,
        hasId: !!modDetails?.id,
        hasName: !!modDetails?.name
      }
    });
    return { success: false, error: 'Invalid mod details' };
  }

  try {
    const clientPath = path.join(serverPath, 'client');
    
    // Determine directories based on content type
    let modsDir, clientModsDir, targetSubDir;
    let unassignedModsDir = null;
    let unassignedManifestDir = null;
    
    if (modDetails.contentType === 'shaders') {
      targetSubDir = 'shaderpacks';
      modsDir = path.join(clientPath, targetSubDir);
      clientModsDir = path.join(clientPath, targetSubDir);
      
      logger.info('SHADER INSTALL: Using shader directories', {
        category: 'storage',
        data: {
          service: 'mod-installation-service',
          contentType: modDetails.contentType,
          modsDir: modsDir,
          clientModsDir: clientModsDir,
          targetSubDir: targetSubDir
        }
      });
    } else if (modDetails.contentType === 'resourcepacks') {
      targetSubDir = 'resourcepacks';
      modsDir = path.join(clientPath, targetSubDir);
      clientModsDir = path.join(clientPath, targetSubDir);
      
      logger.info('RESOURCEPACK INSTALL: Using resource pack directories', {
        category: 'storage',
        data: {
          service: 'mod-installation-service',
          contentType: modDetails.contentType,
          modsDir: modsDir,
          clientModsDir: clientModsDir,
          targetSubDir: targetSubDir
        }
      });
    } else {
      // Default to mods
      targetSubDir = 'mods';
      modsDir = path.join(serverPath, 'mods');
      clientModsDir = path.join(clientPath, 'mods');
      unassignedModsDir = path.join(serverPath, UNASSIGNED_MODS_DIRNAME);
      unassignedManifestDir = path.join(serverPath, UNASSIGNED_MANIFEST_DIRNAME);
      
      logger.debug('MOD INSTALL: Using default mod directories', {
        category: 'storage',
        data: {
          service: 'mod-installation-service',
          contentType: modDetails.contentType || 'mods',
          modsDir: modsDir,
          clientModsDir: clientModsDir,
          targetSubDir: targetSubDir
        }
      });
    }

    logger.debug('Creating content directories', {
      category: 'storage',
      data: {
        service: 'mod-installation-service',
        modsDir: modsDir,
        clientModsDir: clientModsDir,
        contentType: modDetails.contentType || 'mods'
      }
    });

    await fs.mkdir(modsDir, { recursive: true });
    await fs.mkdir(clientModsDir, { recursive: true });
    if (unassignedModsDir) {
      await fs.mkdir(unassignedModsDir, { recursive: true });
    }
    if (unassignedManifestDir) {
      await fs.mkdir(unassignedManifestDir, { recursive: true });
    }

    // Sanitize the name and determine file extension based on content type
    const sanitizedBase = modDetails.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    let fileName;
    
    if (modDetails.contentType === 'shaders' || modDetails.contentType === 'resourcepacks') {
      // For shaders and resource packs, prefer .zip but allow .jar
      if (/\.(zip|jar)$/i.test(sanitizedBase)) {
        fileName = sanitizedBase;
      } else {
        fileName = `${sanitizedBase}.zip`;
      }
      
      logger.info(`${modDetails.contentType.toUpperCase()} INSTALL: Determined filename`, {
        category: 'storage',
        data: {
          service: 'mod-installation-service',
          contentType: modDetails.contentType,
          originalName: modDetails.name,
          sanitizedBase: sanitizedBase,
          fileName: fileName
        }
      });
    } else {
      // For mods, use .jar
      fileName = /\.jar$/i.test(sanitizedBase)
        ? sanitizedBase
        : `${sanitizedBase}.jar`;
    }

    // For updates (forceReinstall), preserve the original filename
    if (modDetails.forceReinstall && modDetails.oldFileName) {
      fileName = modDetails.oldFileName;
      logger.debug('Using original filename for mod update', {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          originalFileName: modDetails.oldFileName,
          sanitizedFileName: fileName
        }
      });
    }

    logger.debug('Determined mod filename', {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        modName: modDetails.name,
        fileName: fileName,
        isUpdate: modDetails.forceReinstall
      }
    });

    let currentModLocation = null;
    let destinationPath = path.join(modsDir, fileName); // Default to server

    if (unassignedModsDir) {
      currentModLocation = 'unassigned';
      destinationPath = path.join(unassignedModsDir, fileName);
    }

    if (modDetails.forceReinstall) {
      logger.debug('Processing mod reinstall/update', {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          modName: modDetails.name,
          forceReinstall: true
        }
      });

      // Use old filename for location detection if provided (for updates)
      const checkFileName = modDetails.oldFileName || fileName;
      const serverModPath = path.join(modsDir, checkFileName);
      const clientModPath = path.join(clientModsDir, checkFileName);
      const unassignedModPath = unassignedModsDir ? path.join(unassignedModsDir, checkFileName) : null;
      const serverExists = await fs.access(serverModPath).then(() => true).catch(() => false);
      const clientExists = await fs.access(clientModPath).then(() => true).catch(() => false);
      const unassignedExists = unassignedModPath
        ? await fs.access(unassignedModPath).then(() => true).catch(() => false)
        : false;

      logger.debug('Checking existing mod locations', {
        category: 'storage',
        data: {
          service: 'mod-installation-service',
          checkFileName: checkFileName,
          serverExists: serverExists,
          clientExists: clientExists,
          unassignedExists: unassignedExists
        }
      });

      if (clientExists && serverExists) {
        currentModLocation = 'both';
        destinationPath = path.join(modsDir, fileName); // Install new version to server

        logger.debug('Mod exists in both locations, cleaning up old files', {
          category: 'storage',
          data: {
            service: 'mod-installation-service',
            currentModLocation: 'both',
            serverModPath: serverModPath,
            clientModPath: clientModPath
          }
        });

        // Clean up old files before installing new ones
        try {
          await fs.unlink(serverModPath);
          await fs.unlink(clientModPath);

          // Also clean up manifests if they exist
          const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
          const clientManifestDir = path.join(serverPath, 'client', 'minecraft-core-manifests');
          const oldManifestPath = `${checkFileName}.json`;
          await fs.unlink(path.join(serverManifestDir, oldManifestPath)).catch(() => { });
          await fs.unlink(path.join(clientManifestDir, oldManifestPath)).catch(() => { });

          logger.debug('Cleaned up old mod files and manifests', {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              checkFileName: checkFileName
            }
          });
        } catch (error) {
          logger.warn(`Error during mod cleanup: ${error.message}`, {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              checkFileName: checkFileName,
              errorType: error.constructor.name
            }
          });
          // Log cleanup errors but don't fail the installation
        }
      } else if (clientExists && !serverExists) {
        currentModLocation = 'client-only';
        destinationPath = path.join(clientModsDir, fileName); // Install new version to client

        logger.debug('Mod exists in client only, cleaning up old file', {
          category: 'storage',
          data: {
            service: 'mod-installation-service',
            currentModLocation: 'client-only',
            clientModPath: clientModPath
          }
        });

        // Clean up old client file
        try {
          await fs.unlink(clientModPath);

          // Also clean up client manifest if it exists
          const clientManifestDir = path.join(serverPath, 'client', 'minecraft-core-manifests');
          const oldManifestPath = `${checkFileName}.json`;
          await fs.unlink(path.join(clientManifestDir, oldManifestPath)).catch(() => { });

          logger.debug('Cleaned up old client mod file', {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              clientModPath: clientModPath
            }
          });
        } catch (error) {
          logger.warn(`Error during client mod cleanup: ${error.message}`, {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              clientModPath: clientModPath,
              errorType: error.constructor.name
            }
          });
          // Ignore cleanup errors
        }
      } else if (serverExists && !clientExists) {
        currentModLocation = 'server-only';
        destinationPath = path.join(modsDir, fileName); // Install new version to server

        logger.debug('Mod exists in server only, cleaning up old file', {
          category: 'storage',
          data: {
            service: 'mod-installation-service',
            currentModLocation: 'server-only',
            serverModPath: serverModPath
          }
        });

        // Clean up old server file
        try {
          await fs.unlink(serverModPath);

          // Also clean up server manifest if it exists
          const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
          const oldManifestPath = `${checkFileName}.json`;
          await fs.unlink(path.join(serverManifestDir, oldManifestPath)).catch(() => { });

          logger.debug('Cleaned up old server mod file', {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              serverModPath: serverModPath
            }
          });
        } catch (error) {
          logger.warn(`Error during server mod cleanup: ${error.message}`, {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              serverModPath: serverModPath,
              errorType: error.constructor.name
            }
          });
          // Ignore cleanup errors
        }
      }
      else if (unassignedExists && !serverExists && !clientExists) {
        currentModLocation = 'unassigned';
        destinationPath = path.join(unassignedModsDir, fileName);

        logger.debug('Mod exists in unassigned location, cleaning up old file', {
          category: 'storage',
          data: {
            service: 'mod-installation-service',
            currentModLocation: 'unassigned',
            unassignedModPath: unassignedModPath
          }
        });

        try {
          await fs.unlink(unassignedModPath);

          if (unassignedManifestDir) {
            const oldManifestPath = `${checkFileName}.json`;
            await fs.unlink(path.join(unassignedManifestDir, oldManifestPath)).catch(() => { });
          }

          logger.debug('Cleaned up old unassigned mod file', {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              unassignedModPath: unassignedModPath
            }
          });
        } catch (error) {
          logger.warn(`Error during unassigned mod cleanup: ${error.message}`, {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              unassignedModPath: unassignedModPath,
              errorType: error.constructor.name
            }
          });
        }
      }

    }

    const targetPath = destinationPath;

    logger.debug('Determined installation target path', {
      category: 'storage',
      data: {
        service: 'mod-installation-service',
        targetPath: targetPath,
        currentModLocation: currentModLocation,
        fileName: fileName
      }
    });

    try {
      let downloadUrl, versionInfoToSave;

      logger.debug('Resolving mod download URL', {
        category: 'network',
        data: {
          service: 'mod-installation-service',
          modName: modDetails.name,
          source: modDetails.source,
          hasDownloadUrl: !!modDetails.downloadUrl,
          hasSelectedVersionId: !!modDetails.selectedVersionId
        }
      });

      // Check if downloadUrl is already provided
      if (modDetails.downloadUrl) {
        downloadUrl = modDetails.downloadUrl;
        // If we have selectedVersionId, use it to get version info for manifest
        if (modDetails.selectedVersionId && modDetails.source === 'modrinth') {
          versionInfoToSave = await getModrinthVersionInfo(modDetails.id, modDetails.selectedVersionId, modDetails.version, modDetails.loader);
        }
      } else if (modDetails.source === 'modrinth') {
        if (modDetails.selectedVersionId) {
          logger.debug('Getting Modrinth version info by ID', {
            category: 'network',
            data: {
              service: 'mod-installation-service',
              modId: modDetails.id,
              selectedVersionId: modDetails.selectedVersionId
            }
          });

          versionInfoToSave = await getModrinthVersionInfo(modDetails.id, modDetails.selectedVersionId, modDetails.version, modDetails.loader);
          if (!versionInfoToSave || !versionInfoToSave.files || versionInfoToSave.files.length === 0) {
            logger.error('No files found for selected Modrinth version', {
              category: 'mods',
              data: {
                service: 'mod-installation-service',
                modId: modDetails.id,
                selectedVersionId: modDetails.selectedVersionId,
                hasVersionInfo: !!versionInfoToSave,
                fileCount: versionInfoToSave?.files?.length || 0
              }
            });
            throw new Error('No files found for selected version');
          }
          downloadUrl = versionInfoToSave.files[0].url;
        } else {
          logger.debug('Getting latest Modrinth version info', {
            category: 'network',
            data: {
              service: 'mod-installation-service',
              modId: modDetails.id,
              version: modDetails.version,
              loader: modDetails.loader
            }
          });

          // This part might need adjustment if getModrinthDownloadUrl is not just a URL string
          downloadUrl = await getModrinthDownloadUrl(modDetails.id, modDetails.version, modDetails.loader);
          versionInfoToSave = await getLatestModrinthVersionInfo(modDetails.id, modDetails.version, modDetails.loader);
        }
      } else if (modDetails.source === 'curseforge') {
        logger.debug('Getting CurseForge download URL', {
          category: 'network',
          data: {
            service: 'mod-installation-service',
            modId: modDetails.id,
            source: 'curseforge'
          }
        });

        // CurseForge support not implemented
        downloadUrl = await getCurseForgeDownloadUrl();
        // versionInfoToSave would need to be fetched for CurseForge too if manifest saving is desired for it
      } else {
        downloadUrl = modDetails.downloadUrl; // Direct URL
        logger.debug('Using direct download URL', {
          category: 'network',
          data: {
            service: 'mod-installation-service',
            hasDirectUrl: !!modDetails.downloadUrl
          }
        });
      }

      if (!downloadUrl) {
        logger.error('Failed to get download URL for mod', {
          category: 'network',
          data: {
            service: 'mod-installation-service',
            modName: modDetails.name,
            modId: modDetails.id,
            source: modDetails.source
          }
        });
        throw new Error('Failed to get download URL for mod');
      }

      logger.info('Starting mod download', {
        category: 'network',
        data: {
          service: 'mod-installation-service',
          modName: modDetails.name,
          downloadUrl: downloadUrl,
          targetPath: targetPath
        }
      });

      const downloadId = `mod-${modDetails.id}-${Date.now()}`;

      if (win && win.webContents) {
        win.webContents.send('download-progress', { id: downloadId, name: modDetails.name, progress: 0, speed: 0, completed: false, error: null });
      }

      const writer = createWriteStream(targetPath);
      const response = await axios({
        url: downloadUrl, method: 'GET', responseType: 'stream',
        onDownloadProgress: progressEvent => {
          const progress = progressEvent.loaded / progressEvent.total;
          const speed = progressEvent.rate || 0;
          if (win && win.webContents) {
            win.webContents.send('download-progress', { id: downloadId, name: modDetails.name, progress: progress * 100, size: progressEvent.total, downloaded: progressEvent.loaded, speed: speed, completed: false, error: null });
          }
        }
      });

      await pipelineAsync(response.data, writer); // Use pipelineAsync

      logger.debug('Mod download completed', {
        category: 'network',
        data: {
          service: 'mod-installation-service',
          modName: modDetails.name,
          targetPath: targetPath,
          downloadId: downloadId
        }
      });

      // Post-download verification (existence + non-zero size)
      try {
        const stat = await fs.stat(targetPath);
        if (!stat || stat.size === 0) {
          logger.error('Downloaded mod file is missing or empty', {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              targetPath,
              size: stat ? stat.size : 0,
              modId: modDetails.id
            }
          });
          return { success: false, error: 'Download incomplete (empty file)' };
        }
      } catch (vfErr) {
        logger.error(`Post-download file verification failed: ${vfErr.message}`, {
          category: 'storage',
          data: {
            service: 'mod-installation-service',
            targetPath,
            modId: modDetails.id,
            errorType: vfErr.constructor.name
          }
        });
        return { success: false, error: 'Download verification failed' };
      }

      // Extract mod metadata to get the clean filename
      let finalFileName = fileName;
      let finalTargetPath = targetPath;

      logger.debug('Extracting mod metadata for filename optimization', {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          modName: modDetails.name,
          currentFileName: fileName,
          isUpdate: modDetails.forceReinstall
        }
      });

      try {
        const metadata = await extractDependenciesFromJar(targetPath);
        if (metadata && metadata.name) {
          // Use the clean name from JAR metadata
          const cleanBase = metadata.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
          const cleanFileName = /\.jar$/i.test(cleanBase) ? cleanBase : `${cleanBase}.jar`;

          // Only rename if it's different and not an update (to preserve original filenames for updates)
          if (cleanFileName !== fileName && !modDetails.forceReinstall) {
            finalFileName = cleanFileName;
            const newTargetPath = path.join(path.dirname(targetPath), finalFileName);
            await fs.rename(targetPath, newTargetPath);
            finalTargetPath = newTargetPath;
            destinationPath = newTargetPath;

            logger.debug('Renamed mod file using JAR metadata', {
              category: 'storage',
              data: {
                service: 'mod-installation-service',
                originalFileName: fileName,
                cleanFileName: cleanFileName,
                metadataName: metadata.name
              }
            });
          } else {
            logger.debug('Keeping original filename', {
              category: 'storage',
              data: {
                service: 'mod-installation-service',
                fileName: fileName,
                reason: modDetails.forceReinstall ? 'update_preserve_name' : 'same_as_clean'
              }
            });
          }
        }
      } catch (error) {
        logger.debug(`JAR analysis failed, using original filename: ${error.message}`, {
          category: 'mods',
          data: {
            service: 'mod-installation-service',
            fileName: fileName,
            errorType: error.constructor.name
          }
        });
        // If JAR analysis fails, continue with original filename
      }

      if (currentModLocation === 'both') {
        const otherTargetPath = (destinationPath === path.join(modsDir, finalFileName)) ? path.join(clientModsDir, finalFileName) : path.join(modsDir, finalFileName);

        logger.debug('Copying mod to both locations', {
          category: 'storage',
          data: {
            service: 'mod-installation-service',
            finalTargetPath: finalTargetPath,
            otherTargetPath: otherTargetPath,
            currentModLocation: 'both'
          }
        });

        await fs.copyFile(finalTargetPath, otherTargetPath);
      }

      if (win && win.webContents) {
        win.webContents.send('download-progress', { id: downloadId, name: modDetails.name, progress: 100, speed: 0, completed: true, completedTime: Date.now(), error: null });
      }

      // Save manifest file for tracking mod information
      if (modDetails.source === 'modrinth') {
        logger.debug('Saving Modrinth mod manifest', {
          category: 'storage',
          data: {
            service: 'mod-installation-service',
            modName: modDetails.name,
            finalFileName: finalFileName,
            currentModLocation: currentModLocation
          }
        });

        try {
          const serverManifestDir = path.join(serverPath, 'minecraft-core-manifests');
          const clientManifestDir = path.join(clientPath, 'minecraft-core-manifests');

          // If we don't have version info, try to get it as a fallback
          if (!versionInfoToSave && modDetails.selectedVersionId) {
            try {
              versionInfoToSave = await getModrinthVersionInfo(modDetails.id, modDetails.selectedVersionId, modDetails.version, modDetails.loader);
            } catch (error) {
              logger.warn(`Could not fetch version info for manifest: ${error.message}`, {
                category: 'network',
                data: {
                  service: 'mod-installation-service',
                  modId: modDetails.id,
                  selectedVersionId: modDetails.selectedVersionId,
                  errorType: error.constructor.name
                }
              });
            }
          }
          // If version info absent but we have selectedVersionId (or fallback marker) attempt one more fetch
          if (!versionInfoToSave && modDetails.id) {
            try {
              versionInfoToSave = await getLatestModrinthVersionInfo(modDetails.id, modDetails.version, modDetails.loader);
              logger.debug('Fetched latest version info during manifest fallback', {
                category: 'network',
                data: {
                  service: 'mod-installation-service',
                  modId: modDetails.id
                }
              });
            } catch (lateErr) {
              logger.warn(`Could not fetch fallback version info for manifest: ${lateErr.message}`, {
                category: 'network',
                data: {
                  service: 'mod-installation-service',
                  modId: modDetails.id,
                  errorType: lateErr.constructor.name
                }
              });
            }
          }

          // Create manifest with available information (reflect fallback flags if present)
          const manifest = {
            projectId: modDetails.id,
            name: modDetails.name, // This should now be the display name from project info
            fileName: finalFileName, // Use the final filename (clean or original)
            versionId: (versionInfoToSave && versionInfoToSave.id) || modDetails.selectedVersionId || 'unknown',
            versionNumber: (versionInfoToSave && (versionInfoToSave.version_number || versionInfoToSave.name)) || modDetails.version || 'unknown',
            source: modDetails.source,
            installedAt: new Date().toISOString(),
            fallbackFrom404: !!(versionInfoToSave && versionInfoToSave._fallbackFrom404),
            originalVersionId: (versionInfoToSave && versionInfoToSave.originalVersionId) || undefined
          };

          if (currentModLocation === 'client-only') {
            await fs.mkdir(clientManifestDir, { recursive: true });
            const clientManifestPath = path.join(clientManifestDir, `${finalFileName}.json`);
            await fs.writeFile(clientManifestPath, JSON.stringify(manifest, null, 2));

            logger.debug('Saved client-only manifest', {
              category: 'storage',
              data: {
                service: 'mod-installation-service',
                manifestPath: clientManifestPath
              }
            });
          } else if (currentModLocation === 'both') {
            await fs.mkdir(serverManifestDir, { recursive: true });
            await fs.mkdir(clientManifestDir, { recursive: true });
            const serverManifestPath = path.join(serverManifestDir, `${finalFileName}.json`);
            const clientManifestPath = path.join(clientManifestDir, `${finalFileName}.json`);
            await fs.writeFile(serverManifestPath, JSON.stringify(manifest, null, 2));
            await fs.writeFile(clientManifestPath, JSON.stringify(manifest, null, 2));

            logger.debug('Saved manifests for both locations', {
              category: 'storage',
              data: {
                service: 'mod-installation-service',
                serverManifestPath: serverManifestPath,
                clientManifestPath: clientManifestPath
              }
            });
          } else if (currentModLocation === 'unassigned' && unassignedManifestDir) {
            await fs.mkdir(unassignedManifestDir, { recursive: true });
            const unassignedManifestPath = path.join(unassignedManifestDir, `${finalFileName}.json`);
            await fs.writeFile(unassignedManifestPath, JSON.stringify(manifest, null, 2));

            logger.debug('Saved unassigned manifest', {
              category: 'storage',
              data: {
                service: 'mod-installation-service',
                manifestPath: unassignedManifestPath
              }
            });
          } else { // server-only fallback
            await fs.mkdir(serverManifestDir, { recursive: true });
            const serverManifestPath = path.join(serverManifestDir, `${finalFileName}.json`);
            await fs.writeFile(serverManifestPath, JSON.stringify(manifest, null, 2));

            logger.debug('Saved server-only manifest', {
              category: 'storage',
              data: {
                service: 'mod-installation-service',
                manifestPath: serverManifestPath
              }
            });
          }
        } catch (error) {
          logger.warn(`Failed to save mod manifest: ${error.message}`, {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              modName: modDetails.name,
              finalFileName: finalFileName,
              errorType: error.constructor.name
            }
          });
          // Ignore manifest write errors
        }
      }
      logger.info('Server mod installation completed successfully', {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          operation: 'installModToServer',
          modName: modDetails.name,
          modId: modDetails.id,
          finalFileName: finalFileName,
          currentModLocation: currentModLocation,
          targetPath: finalTargetPath
        }
      });

      return { 
        success: true,
        filePath: finalTargetPath,
        fileName: finalFileName,
        versionId: (versionInfoToSave && versionInfoToSave.id) || modDetails.selectedVersionId || 'unknown',
        versionNumber: (versionInfoToSave && (versionInfoToSave.version_number || versionInfoToSave.name)) || modDetails.version || 'unknown',
        fallbackFrom404: !!(versionInfoToSave && versionInfoToSave._fallbackFrom404)
      };
    } catch (err) {
      let errorMessage = err.message || 'Unknown error';

      logger.error(`Server mod installation failed: ${errorMessage}`, {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          operation: 'installModToServer',
          modName: modDetails?.name,
          modId: modDetails?.id,
          serverPath: serverPath,
          errorType: err.constructor.name
        }
      });

      if (win && win.webContents && modDetails) {
        win.webContents.send('download-progress', { id: `mod-${modDetails.id}-${Date.now()}`, name: modDetails.name, progress: 0, speed: 0, completed: false, completedTime: Date.now(), error: errorMessage });
      }
      return { success: false, error: `Failed to install mod ${modDetails.name}: ${errorMessage}` };
    }
  } catch (error) {
    logger.error(`Server mod installation failed: ${error.message}`, {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        operation: 'installModToServer',
        modName: modDetails?.name,
        modId: modDetails?.id,
        serverPath: serverPath,
        errorType: error.constructor.name
      }
    });
    throw error;
  }
}

async function installModToClient(win, modData) {
  const logger = getLoggerHandlers();

  logger.info('Installing mod to client', {
    category: 'mods',
    data: {
      service: 'mod-installation-service',
      operation: 'installModToClient',
      clientPath: modData?.clientPath,
      modName: modData?.name,
      modId: modData?.id,
  loader: modData?.loader,
      version: modData?.version,
  forceReinstall: modData?.forceReinstall,
  contentType: modData?.contentType || 'mods'
    }
  });

  if (!modData.clientPath) {
    logger.error('Client path is required for client mod installation', {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        operation: 'installModToClient'
      }
    });
    throw new Error('Client path is required for client mod installation');
  }
  if (!modData || !modData.id || !modData.name) {
    logger.error('Invalid mod details for client installation', {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        operation: 'installModToClient',
        hasModData: !!modData,
        hasId: !!modData?.id,
        hasName: !!modData?.name
      }
    });
    throw new Error('Invalid mod details (id, name) are required');
  }

  try {
    // Determine target subdir and default extension based on content type
    const contentType = (modData.contentType || 'mods').toLowerCase();
    let targetSubDir = 'mods';
    let defaultExtension = '.jar';

    if (contentType === 'shaders') {
      targetSubDir = 'shaderpacks';
      defaultExtension = '.zip';
    } else if (contentType === 'resourcepacks') {
      targetSubDir = 'resourcepacks';
      defaultExtension = '.zip';
    }

    const clientModsDir = path.join(modData.clientPath, targetSubDir);
    await fs.mkdir(clientModsDir, { recursive: true });
    const clientManifestDir = path.join(modData.clientPath, 'minecraft-core-manifests');
    await fs.mkdir(clientManifestDir, { recursive: true });

    logger.debug('Created client mod directories', {
      category: 'storage',
      data: {
        service: 'mod-installation-service',
        clientModsDir: clientModsDir,
        clientManifestDir: clientManifestDir
      }
    });

    // Use a sanitized file name instead of the API provided one to
    // match the server install behaviour and avoid version suffixes.
    const sanitizedBase = modData.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    // Determine extension based on content type; allow explicit extension if provided
    let sanitizedFileName;
    if (contentType === 'mods') {
      sanitizedFileName = /\.jar$/i.test(sanitizedBase) ? sanitizedBase : `${sanitizedBase}${defaultExtension}`;
    } else {
      // shaders/resourcepacks: prefer .zip, but if name already has .zip or .jar, keep it
      if (/\.(zip|jar)$/i.test(sanitizedBase)) {
        sanitizedFileName = sanitizedBase;
      } else {
        sanitizedFileName = `${sanitizedBase}${defaultExtension}`;
      }
    }
    let targetPath = path.join(clientModsDir, sanitizedFileName); // Initial target path

    logger.debug('Determined client mod filename', {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        modName: modData.name,
        sanitizedFileName: sanitizedFileName,
        targetPath: targetPath
      }
    });

    const fileExists = await fs.access(targetPath).then(() => true).catch(() => false);
    if (fileExists && !modData.forceReinstall) {
      logger.info('Client mod already installed', {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          modName: modData.name,
          fileName: sanitizedFileName,
          targetPath: targetPath
        }
      });
      return { success: true, message: 'Mod already installed', fileName: sanitizedFileName };
    }

    if (modData.forceReinstall) {
      logger.debug('Processing client mod reinstall/update', {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          modName: modData.name,
          modId: modData.id,
          forceReinstall: true
        }
      });

      try {
        const manifestFiles = await fs.readdir(clientManifestDir).catch(() => []);
        for (const manifestFile of manifestFiles) {
          if (!manifestFile.endsWith('.json')) continue;
          const manifestPath = path.join(clientManifestDir, manifestFile);
          try {
            const manifestContent = await fs.readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(manifestContent);
            if (manifest.projectId === modData.id) {
              const oldFilePath = path.join(clientModsDir, manifest.fileName);
              await fs.unlink(oldFilePath).catch(() => { });
              await fs.unlink(manifestPath).catch(() => { });

              logger.debug('Cleaned up old client mod files by manifest', {
                category: 'storage',
                data: {
                  service: 'mod-installation-service',
                  oldFilePath: oldFilePath,
                  manifestPath: manifestPath
                }
              });
              break;
            }
          } catch (error) {
            logger.debug(`Error parsing manifest during cleanup: ${error.message}`, {
              category: 'storage',
              data: {
                service: 'mod-installation-service',
                manifestFile: manifestFile,
                errorType: error.constructor.name
              }
            });
            // Ignore manifest parsing errors
          }
        }

        if (modData.name) {
          const modFiles = await fs.readdir(clientModsDir);
          const baseName = modData.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
          const possibleMatches = modFiles.filter(f => f.startsWith(baseName) && f.endsWith('.jar'));

          logger.debug('Cleaning up possible mod file matches', {
            category: 'storage',
            data: {
              service: 'mod-installation-service',
              baseName: baseName,
              matchCount: possibleMatches.length
            }
          });

          for (const match of possibleMatches) {
            await fs.unlink(path.join(clientModsDir, match)).catch(() => { });
          }
        }
      } catch (error) {
        logger.warn(`Error during client mod cleanup: ${error.message}`, {
          category: 'storage',
          data: {
            service: 'mod-installation-service',
            modName: modData.name,
            errorType: error.constructor.name
          }
        });
        // Ignore cleanup errors
      }
    }

    try {
      // For shaders/resourcepacks, loaders don't apply; keep null to allow API to handle appropriately
      const isNonMod = contentType === 'shaders' || contentType === 'resourcepacks';
      const loader = isNonMod ? null : (modData.loader || 'fabric'); // Default or passed
      const mcVersion = modData.version || '1.20.1'; // Default or passed

      logger.debug('Resolving client mod version', {
        category: 'network',
        data: {
          service: 'mod-installation-service',
          modId: modData.id,
          loader: loader,
          mcVersion: mcVersion,
          hasSelectedVersionId: !!modData.selectedVersionId
        }
      });

      let versionInfo;
      let versionToInstall;

      if (modData.selectedVersionId) {
        // Try to fetch the requested version info
        try {
          versionInfo = await getModrinthVersionInfo(modData.id, modData.selectedVersionId, mcVersion, loader);
          if (
            versionInfo &&
            (!loader || versionInfo.loaders.includes(loader)) &&
            (!mcVersion || versionInfo.game_versions.includes(mcVersion))
          ) {
            versionToInstall = { id: versionInfo.id, versionNumber: versionInfo.version_number };

            logger.debug('Using selected version for client mod', {
              category: 'mods',
              data: {
                service: 'mod-installation-service',
                selectedVersionId: modData.selectedVersionId,
                versionNumber: versionInfo.version_number
              }
            });
          } else {
            versionInfo = null;

            logger.debug('Selected version not compatible, will find alternative', {
              category: 'mods',
              data: {
                service: 'mod-installation-service',
                selectedVersionId: modData.selectedVersionId,
                hasVersionInfo: false,
                loaderCompatible: false,
                mcVersionCompatible: false
              }
            });
          }
        } catch (error) {
          logger.debug(`Error fetching selected version: ${error.message}`, {
            category: 'network',
            data: {
              service: 'mod-installation-service',
              selectedVersionId: modData.selectedVersionId,
              errorType: error.constructor.name
            }
          });
          versionInfo = null;
        }
      }    // If no suitable version info found, pick the best compatible version automatically
  if (!versionInfo) {
        logger.debug('Finding best compatible version for client mod', {
          category: 'network',
          data: {
            service: 'mod-installation-service',
            modId: modData.id,
            loader: loader,
            mcVersion: mcVersion
          }
        });

  const versions = await getModrinthVersions(modData.id, loader, mcVersion, true);
        if (!versions || versions.length === 0) {
          logger.error('No compatible versions found for client mod', {
            category: 'mods',
            data: {
              service: 'mod-installation-service',
              modId: modData.id,
              modName: modData.name,
              loader: loader,
              mcVersion: mcVersion
            }
          });
          throw new Error('No compatible versions found for this mod');
        }
        // **FIX**: Ensure we get the complete version info, not just the summary
        const bestVersion = versions[0];
        versionToInstall = { id: bestVersion.id, versionNumber: bestVersion.versionNumber };
  versionInfo = await getModrinthVersionInfo(modData.id, bestVersion.id, mcVersion, loader);

        logger.debug('Found best compatible version for client mod', {
          category: 'mods',
          data: {
            service: 'mod-installation-service',
            bestVersionId: bestVersion.id,
            bestVersionNumber: bestVersion.versionNumber,
            availableVersions: versions.length
          }
        });
      }

      if (!versionInfo.files || versionInfo.files.length === 0) {
        logger.error('No files found for client mod version', {
          category: 'mods',
          data: {
            service: 'mod-installation-service',
            modId: modData.id,
            versionId: versionToInstall.id,
            hasVersionInfo: !!versionInfo,
            fileCount: versionInfo?.files?.length || 0
          }
        });
        throw new Error('No files found for this mod version');
      }

      const primaryFile = versionInfo.files.find(file => file.primary) || versionInfo.files[0];
      const downloadUrl = primaryFile.url;

      logger.debug('Determined client mod download details', {
        category: 'network',
        data: {
          service: 'mod-installation-service',
          downloadUrl: downloadUrl,
          primaryFile: !!primaryFile.primary,
          fileSize: primaryFile.size
        }
      });

      // Use sanitized file name for storage to match server behaviour
  const fileName = sanitizedFileName;
      targetPath = path.join(clientModsDir, fileName);

      const downloadId = `client-mod-${modData.id}-${Date.now()}`;

      logger.info('Starting client mod download', {
        category: 'network',
        data: {
          service: 'mod-installation-service',
          modName: modData.name,
          downloadId: downloadId,
          targetPath: targetPath,
          downloadUrl: downloadUrl
        }
      });

      if (win && win.webContents) {
        win.webContents.send('download-progress', { id: downloadId, name: modData.name, progress: 0, speed: 0, completed: false, error: null });
      }

      const writer = createWriteStream(targetPath);
      const response = await axios({
        url: downloadUrl,
        method: 'GET',
        responseType: 'stream',
        timeout: 30000,
        onDownloadProgress: progressEvent => {
          const progress = progressEvent.loaded / progressEvent.total;
          const speed = progressEvent.rate || 0;
          if (win && win.webContents) {
            win.webContents.send('download-progress', { id: downloadId, name: modData.name, progress: progress * 100, size: progressEvent.total, downloaded: progressEvent.loaded, speed, completed: false, error: null });
          }
        }
      });

      await pipelineAsync(response.data, writer);

      logger.debug('Client mod download completed', {
        category: 'network',
        data: {
          service: 'mod-installation-service',
          modName: modData.name,
          downloadId: downloadId,
          targetPath: targetPath
        }
      });

      if (win && win.webContents) {
        win.webContents.send('download-progress', { id: downloadId, name: modData.name, progress: 100, speed: 0, completed: true, completedTime: Date.now(), error: null });
      }

      logger.debug('Saving client mod manifest', {
        category: 'storage',
        data: {
          service: 'mod-installation-service',
          modName: modData.name,
          fileName: fileName,
          versionNumber: versionToInstall.versionNumber
        }
      });

      const installationDate = new Date().toISOString();
      const manifestData = {
        projectId: modData.id,
        versionId: versionToInstall.id,
        fileName: fileName,
        name: modData.name,
        title: modData.title || modData.name,
        versionNumber: versionToInstall.versionNumber,
        mcVersion: mcVersion,
        loader: loader,
        source: 'modrinth',
        downloadUrl: downloadUrl,
        installedAt: installationDate,
        lastUpdated: installationDate,
        filePath: targetPath,
        fileSize: primaryFile.size,
        contentType
      };
      const manifestPath = path.join(clientManifestDir, `${fileName}.json`);
      await fs.writeFile(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');

      logger.info('Client mod installation completed successfully', {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          operation: 'installModToClient',
          modName: modData.name,
          modId: modData.id,
          fileName: fileName,
          version: versionToInstall.versionNumber,
          versionId: versionToInstall.id,
          manifestPath: manifestPath
        }
      });

      return { success: true, fileName: fileName, version: versionToInstall.versionNumber, versionId: versionToInstall.id, manifestPath };
    } catch (error) {
      logger.error(`Client mod installation failed: ${error.message}`, {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          operation: 'installModToClient',
          modName: modData?.name,
          modId: modData?.id,
          clientPath: modData?.clientPath,
          errorType: error.constructor.name
        }
      });

      // Clean up partially downloaded file
      throw new Error(`Failed to install client mod ${modData.name}: ${error.message}`);
    }
  } catch (error) {
    logger.error(`Client mod installation failed: ${error.message}`, {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        operation: 'installModToClient',
        modName: modData?.name,
        modId: modData?.id,
        clientPath: modData?.clientPath,
        errorType: error.constructor.name
      }
    });
    throw error;
  }
}

/**
 * Install mod to server with fallback support using download strategy
 * @param {Object} win - Electron window for progress updates
 * @param {string} serverPath - Server path
 * @param {Object} modDetails - Mod details with fallback configuration
 * @returns {Promise<Object>} Installation result with fallback information
 */
async function installModToServerWithFallback(win, serverPath, modDetails) {
  const logger = getLoggerHandlers();
  const startTime = Date.now();
  
  logger.info('Installing mod to server with fallback support', {
    category: 'mods',
    data: {
      service: 'mod-installation-service',
      operation: 'installModToServerWithFallback',
      serverPath: serverPath,
      modName: modDetails?.name,
      modId: modDetails?.id,
      useFallback: modDetails?.useFallback,
      maxRetries: modDetails?.maxRetries || 3,
      fallbackDelay: modDetails?.fallbackDelay || 15 * 60 * 1000
    }
  });

  if (!serverPath) {
    return { 
      success: false, 
      error: 'Server path not provided',
      attempts: 0,
      fallbackUsed: false,
      checksumErrors: 0,
      networkErrors: 1
    };
  }
  
  if (!modDetails || !modDetails.id || !modDetails.name) {
    return { 
      success: false, 
      error: 'Invalid mod details',
      attempts: 0,
      fallbackUsed: false,
      checksumErrors: 0,
      networkErrors: 1
    };
  }

  const maxRetries = modDetails.maxRetries || 3;
  const fallbackDelay = modDetails.fallbackDelay || 15 * 60 * 1000; // 15 minutes
  const useFallback = modDetails.useFallback !== false;
  
  let attempts = 0;
  let checksumErrors = 0;
  let networkErrors = 0;
  let lastError = null;
  let fallbackUsed = false;
  let lastSource = 'server';

  // Try server download with retries
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts++;
    
    try {
      logger.debug(`Attempting server download (attempt ${attempt}/${maxRetries})`, {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          operation: 'installModToServerWithFallback',
          modName: modDetails?.name,
          attempt,
          maxRetries
        }
      });

      // Send progress update
      if (win && win.webContents && modDetails.downloadId) {
        win.webContents.send('download-progress', {
          id: modDetails.downloadId,
          name: modDetails.name,
          state: attempt === 1 ? 'downloading' : 'retrying',
          progress: 0,
          source: 'server',
          attempt,
          maxAttempts: maxRetries,
          statusMessage: attempt === 1 ? 'Downloading from server...' : `Retrying download (attempt ${attempt}/${maxRetries})...`
        });
      }

      // Use the existing installModToServer method
      const installResult = await installModToServer(win, serverPath, modDetails);
      
      if (installResult.success) {
        const duration = Date.now() - startTime;
        
        logger.info('Server installation completed successfully', {
          category: 'mods',
          data: {
            service: 'mod-installation-service',
            operation: 'installModToServerWithFallback',
            modName: modDetails?.name,
            attempts,
            duration
          }
        });
        
        return {
          ...installResult,
          source: 'server',
          attempts,
          fallbackUsed: false,
          checksumErrors,
          networkErrors,
          duration
        };
      } else {
        throw new Error(installResult.error || 'Installation failed');
      }
    } catch (error) {
      lastError = error;
      
      // Categorize the error
      if (error.message.includes('checksum') || error.message.includes('Checksum')) {
        checksumErrors++;
        logger.warn(`Checksum error on attempt ${attempt}: ${error.message}`, {
          category: 'mods',
          data: {
            service: 'mod-installation-service',
            modName: modDetails?.name,
            attempt,
            checksumErrors
          }
        });
      } else {
        networkErrors++;
        logger.warn(`Network error on attempt ${attempt}: ${error.message}`, {
          category: 'mods',
          data: {
            service: 'mod-installation-service',
            modName: modDetails?.name,
            attempt,
            networkErrors
          }
        });
      }
      
      // If this isn't the last attempt, wait before retrying
      if (attempt < maxRetries) {
        const retryDelay = 1000 * Math.pow(2, attempt - 1); // Exponential backoff
        logger.debug(`Waiting ${retryDelay}ms before retry`, {
          category: 'mods',
          data: {
            service: 'mod-installation-service',
            modName: modDetails?.name,
            attempt,
            retryDelay
          }
        });
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  // If fallback is disabled or not available, return failure
  if (!useFallback || (!modDetails.projectId && !modDetails.modrinthId && !modDetails.curseforgeId)) {
    const duration = Date.now() - startTime;
    
    logger.error('Server installation failed and fallback not available', {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        operation: 'installModToServerWithFallback',
        modName: modDetails?.name,
        attempts,
        checksumErrors,
        networkErrors,
        useFallback,
        hasIdentifiers: !!(modDetails.projectId || modDetails.modrinthId || modDetails.curseforgeId),
        duration
      }
    });
    
    return {
      success: false,
      error: lastError?.message || 'All server download attempts failed',
      source: 'server',
      attempts,
      fallbackUsed: false,
      checksumErrors,
      networkErrors,
      duration
    };
  }

  // Wait for fallback delay if configured
  if (fallbackDelay > 0) {
    logger.info(`Waiting ${Math.round(fallbackDelay / 60000)} minutes before fallback`, {
      category: 'mods',
      data: {
        service: 'mod-installation-service',
        operation: 'installModToServerWithFallback',
        modName: modDetails?.name,
        fallbackDelay
      }
    });

    // Send fallback countdown updates
    if (win && win.webContents && modDetails.downloadId) {
      const endTime = Date.now() + fallbackDelay;
      const updateInterval = 30000; // 30 seconds
      
      while (Date.now() < endTime) {
        const remaining = endTime - Date.now();
        const remainingMinutes = Math.ceil(remaining / 60000);
        
        win.webContents.send('download-progress', {
          id: modDetails.downloadId,
          name: modDetails.name,
          state: 'fallback',
          progress: 0,
          source: 'server',
          statusMessage: `Trying alternative source in ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}...`,
          fallbackCountdown: remaining
        });
        
        const waitTime = Math.min(updateInterval, remaining);
        if (waitTime > 0) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, fallbackDelay));
    }
  }

  // Try fallback sources
  const fallbackSources = [];
  if (modDetails.projectId || modDetails.modrinthId) {
    fallbackSources.push('modrinth');
  }
  if (modDetails.curseforgeId) {
    fallbackSources.push('curseforge');
  }

  for (const source of fallbackSources) {
    attempts++;
    fallbackUsed = true;
    lastSource = source;
    
    try {
      logger.info(`Attempting fallback download from ${source}`, {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          operation: 'installModToServerWithFallback',
          modName: modDetails?.name,
          source,
          attempts
        }
      });

      // Send progress update
      if (win && win.webContents && modDetails.downloadId) {
        win.webContents.send('download-progress', {
          id: modDetails.downloadId,
          name: modDetails.name,
          state: 'downloading',
          progress: 0,
          source,
          statusMessage: `Downloading from ${source}...`
        });
      }

      // Create modified mod details for fallback source
      const fallbackModDetails = {
        ...modDetails,
        source,
        downloadUrl: null // Force URL resolution from the fallback source
      };

      const installResult = await installModToServer(win, serverPath, fallbackModDetails);
      
      if (installResult.success) {
        const duration = Date.now() - startTime;
        
        logger.info('Fallback installation completed successfully', {
          category: 'mods',
          data: {
            service: 'mod-installation-service',
            operation: 'installModToServerWithFallback',
            modName: modDetails?.name,
            source,
            attempts,
            duration
          }
        });
        
        return {
          ...installResult,
          source,
          attempts,
          fallbackUsed: true,
          checksumErrors,
          networkErrors,
          duration
        };
      } else {
        throw new Error(installResult.error || 'Fallback installation failed');
      }
    } catch (error) {
      lastError = error;
      
      if (error.message.includes('checksum') || error.message.includes('Checksum')) {
        checksumErrors++;
      } else {
        networkErrors++;
      }
      
      logger.warn(`Fallback source ${source} failed: ${error.message}`, {
        category: 'mods',
        data: {
          service: 'mod-installation-service',
          modName: modDetails?.name,
          source,
          attempts,
          errorType: error.constructor.name
        }
      });
    }
  }

  // All attempts failed
  const duration = Date.now() - startTime;
  
  logger.error('All installation attempts failed', {
    category: 'mods',
    data: {
      service: 'mod-installation-service',
      operation: 'installModToServerWithFallback',
      modName: modDetails?.name,
      attempts,
      checksumErrors,
      networkErrors,
      fallbackUsed,
      lastSource,
      duration
    }
  });

  return {
    success: false,
    error: lastError?.message || 'All download sources failed',
    source: lastSource,
    attempts,
    fallbackUsed,
    checksumErrors,
    networkErrors,
    duration
  };
}

module.exports = {
  installModToServer,
  installModToClient,
  installModToServerWithFallback
};
