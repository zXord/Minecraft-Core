const fs = require('fs');
const path = require('path');
const modInstallService = require('../mod-utils/mod-installation-service.cjs');
const { disableMod } = require('../mod-utils/mod-file-utils.cjs');
const { downloadWithProgress } = require('../../services/download-manager.cjs');
const modFileManager = require('../mod-utils/mod-file-manager.cjs');
const modAnalysisUtils = require('../mod-utils/mod-analysis-utils.cjs');
const { checkModCompatibilityFromFilename } = require('./mod-handler-utils.cjs');
const { getLoggerHandlers } = require('../logger-handlers.cjs');
const modApiService = require('../../services/mod-api-service.cjs');
const crypto = require('crypto');

function createClientModHandlers(win) {
  const logger = getLoggerHandlers();
  
  logger.info('Client mod handlers initialized', {
    category: 'mods',
    data: { 
      handler: 'client-mod-handlers',
      hasWindow: !!win
    }
  });

  return {
    'install-client-mod': async (_e, modData) => {
      logger.info('Installing client mod', {
        category: 'mods',
        data: {
          handler: 'install-client-mod',
          modName: modData?.name,
          modId: modData?.projectId,
          hasDownloadUrl: !!modData?.downloadUrl
        }
      });

      try {
        const result = await modInstallService.installModToClient(win, modData);
        
        logger.info('Client mod installation completed', {
          category: 'mods',
          data: {
            handler: 'install-client-mod',
            modName: modData?.name,
            success: result?.success,
            filePath: result?.filePath
          }
        });
        
        return result;
      } catch (error) {
        logger.error(`Client mod installation failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'install-client-mod',
            modName: modData?.name,
            modId: modData?.projectId,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    // List client assets (shaderpacks or resourcepacks)
    'list-client-assets': async (_e, { clientPath, type }) => {
      logger.debug('Listing client assets', {
        category: 'mods',
        data: { handler: 'list-client-assets', clientPath, type }
      });
      try {
        if (!clientPath || !type) throw new Error('Invalid parameters');
        const subdir = type === 'shaderpacks' ? 'shaderpacks' : 'resourcepacks';
        const dir = path.join(clientPath, subdir);
        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
        if (!fs.existsSync(dir)) {
          return { success: true, type: subdir, items: [] };
        }
        // Simple version extractor from filename, e.g., "name-1.2.3.zip" or "name v1.2.zip"
        function extractVersionFromFilename(fileName) {
          if (!fileName) return null;
          const base = fileName.replace(/\.(zip|jar)$/i, '');
          // Look for x.y or x.y.z patterns possibly prefixed by v or r
          const match = base.match(/(?:r|v|version)?\s*(\d+\.\d+(?:\.\d+)?)/i);
          return match ? match[1] : null;
        }
  const all = fs.readdirSync(dir);
        // Consider .zip, .zip.disabled; also allow directories for resourcepacks
        const items = [];
        for (const name of all) {
          const lower = name.toLowerCase();
          const full = path.join(dir, name);
          const isZip = lower.endsWith('.zip') || lower.endsWith('.zip.disabled');
          const isDir = !isZip && fs.existsSync(full) && fs.statSync(full).isDirectory();
          if (!isZip && !isDir) continue;

          const fileName = name.replace(/\.disabled$/i, '');
          const enabled = !lower.endsWith('.disabled');
          const statPath = enabled ? full : full.replace(/\.disabled$/i, '');
          let size = 0; let lastModified = null;
          try {
            const st = fs.statSync(statPath);
            size = st.size || 0;
            lastModified = st.mtime;
          } catch (err) {
            // Ignore stat errors for missing/invalid files
            logger.debug('Stat error while listing client assets', {
              category: 'mods',
              data: { handler: 'list-client-assets', file: statPath, error: err?.message }
            });
          }
          let source = 'manual';
          let projectId = null;
          let versionId = null;
          let versionNumber = null;
          let manifestName = null;
          const manifestPath = path.join(manifestDir, `${fileName}.json`);
          if (fs.existsSync(manifestPath)) {
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              if (manifest && manifest.source) source = manifest.source;
        if (manifest && manifest.projectId) projectId = manifest.projectId;
        if (manifest && manifest.versionId) versionId = manifest.versionId;
        if (manifest && (manifest.versionNumber || manifest.version)) versionNumber = manifest.versionNumber || manifest.version;
              if (manifest && (manifest.name || manifest.title)) manifestName = manifest.name || manifest.title;
            } catch (err) {
              // Ignore manifest parse errors
              logger.debug('Manifest parse error for client asset', {
                category: 'mods',
                data: { handler: 'list-client-assets', manifestPath, error: err?.message }
              });
            }
          }
          // Fallback: derive version from filename if manifest didn't provide one
          if (!versionNumber) {
            const derived = extractVersionFromFilename(fileName);
            if (derived) versionNumber = derived;
          }

          // If we still lack projectId or version, try to resolve via Modrinth by file hash (sha1)
          if ((!versionNumber || !projectId) && (isZip || isDir)) {
            try {
              const hashPath = fs.existsSync(full) ? full : (fs.existsSync(statPath) ? statPath : null);
              if (hashPath && fs.existsSync(hashPath) && fs.statSync(hashPath).isFile()) {
                // Compute sha1 of the file
                const sha1 = (() => {
                  const hash = crypto.createHash('sha1');
                  const stream = fs.createReadStream(hashPath);
                  return new Promise((resolve, reject) => {
                    stream.on('data', (chunk) => hash.update(chunk));
                    stream.on('end', () => resolve(hash.digest('hex')));
                    stream.on('error', (err) => reject(err));
                  });
                })();
                let sha1Hex = null;
                try { sha1Hex = await sha1; } catch (e) {
                  logger.debug('SHA1 computation failed', { category: 'mods', data: { handler: 'list-client-assets', subdir, fileName, error: e?.message } });
                }
                if (sha1Hex) {
                  try {
                    const ver = await modApiService.getModrinthVersionByFileHash(sha1Hex, 'sha1');
                    if (ver && ver.id) {
                      versionId = ver.id;
                      versionNumber = ver.version_number || ver.versionNumber || versionNumber;
                      projectId = ver.project_id || ver.projectId || projectId;
                      manifestName = manifestName || ver.name || ver.title || manifestName;
                      // Persist enrichment
                      try {
                        const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
                        const updated = {
                          ...existing,
                          projectId: projectId || existing.projectId || null,
                          versionId: versionId || existing.versionId || null,
                          versionNumber: versionNumber || existing.versionNumber || null,
                          name: manifestName || existing.name || null,
                          source: existing.source || source
                        };
                        fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2));
                        logger.debug('Enriched asset manifest via hash lookup', {
                          category: 'mods',
                          data: { handler: 'list-client-assets', subdir, fileName, projectId: updated.projectId, versionId: updated.versionId, versionNumber: updated.versionNumber }
                        });
                      } catch (persistErr) {
                        logger.debug('Failed to persist manifest after hash enrichment', {
                          category: 'mods',
                          data: { handler: 'list-client-assets', subdir, fileName, error: persistErr?.message }
                        });
                      }
                    }
                  } catch (hashLookupErr) {
                    logger.debug('Modrinth hash lookup failed or no match', {
                      category: 'mods',
                      data: { handler: 'list-client-assets', subdir, fileName, error: hashLookupErr?.message }
                    });
                  }
                }
              }
            } catch (hashErr) {
              logger.debug('Error computing file hash for asset', {
                category: 'mods',
                data: { handler: 'list-client-assets', subdir, fileName, error: hashErr?.message }
              });
            }
          }

          // If manifest is missing projectId, try to enrich via Modrinth search and persist
          if (!projectId) {
            try {
              const baseNoExt = fileName.replace(/\.(zip|jar)$/i, '');
              const cleanedBase = baseNoExt
                .replace(/(?:[-_\s])?(?:r\d+(?:\.\d+)*)$/i, '')
                .replace(/(?:[-_\s])?(?:v?\d+(?:\.\d+)*)$/i, '')
                .replace(/(?:[-_\s])?mc[_-]?\d+(?:\.\d+)*$/i, '')
                .replace(/[_-]+/g, ' ')
                .trim();
              const projectType = subdir === 'shaderpacks' ? 'shader' : 'resourcepack';
              const res = await modApiService.searchModrinthMods({
                query: cleanedBase || baseNoExt,
                loader: null,
                version: null,
                page: 1,
                limit: 5,
                sortBy: 'relevance',
                environmentType: 'client',
                projectType
              });
              if (res && Array.isArray(res.mods) && res.mods.length) {
                const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
                const target = norm(cleanedBase || baseNoExt);
                let best = res.mods[0];
                let bestScore = 0;
                for (const m of res.mods) {
                  const n1 = norm(m.name);
                  const n2 = norm(m.slug);
                  let score = 0;
                  if (n1 === target || n2 === target) score = 3;
                  else if (n1.includes(target) || target.includes(n1)) score = 2;
                  else if (n2.includes(target) || target.includes(n2)) score = 2;
                  else if (n1 && target && n1[0] === target[0]) score = 1;
                  if (score > bestScore) { best = m; bestScore = score; }
                }
                if (best) {
                  projectId = best.id || best.project_id || null;
                  manifestName = manifestName || best.name || best.title || null;
                  // Persist enrichment back to manifest for future reads
                  try {
                    const existing = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
                    const updated = { ...existing, projectId, name: manifestName };
                    fs.writeFileSync(manifestPath, JSON.stringify(updated, null, 2));
                    logger.debug('Enriched asset manifest with projectId', {
                      category: 'mods',
                      data: { handler: 'list-client-assets', subdir, fileName, projectId }
                    });
                  } catch (persistErr) {
                    logger.debug('Failed to persist enriched asset manifest', {
                      category: 'mods',
                      data: { handler: 'list-client-assets', subdir, fileName, error: persistErr?.message }
                    });
                  }
                }
              }
            } catch (enrichErr) {
              logger.debug('Asset enrichment lookup failed', {
                category: 'mods',
                data: { handler: 'list-client-assets', subdir, fileName, error: enrichErr?.message }
              });
            }
          }
          // Debug: show how version was determined
          try {
            logger.debug('Asset version resolution', {
              category: 'mods',
              data: {
                handler: 'list-client-assets',
                subdir,
                fileName,
                fromManifest: !!fs.existsSync(manifestPath),
                versionFromManifest: !!(versionNumber && fs.existsSync(manifestPath)),
                versionNumber: versionNumber || null,
                projectId: projectId || null
              }
            });
          } catch {
            // ignore logging errors
          }
          // Calculate checksum for reliable server vs client comparison (md5)
          let checksum = null;
          try {
            if (fs.existsSync(statPath) && fs.statSync(statPath).isFile()) {
              checksum = require('../../services/minecraft-launcher/utils.cjs').calculateFileChecksum(statPath);
            }
          } catch {
            checksum = null;
          }
          items.push({ fileName, enabled, size, lastModified, source, projectId, versionId, versionNumber, name: manifestName, checksum });
        }
        return { success: true, type: subdir, items };
      } catch (error) {
        logger.error(`Failed to list client assets: ${error.message}`, {
          category: 'mods',
          data: { handler: 'list-client-assets', errorType: error.constructor.name }
        });
        return { success: false, error: error.message };
      }
    },

    'get-client-installed-mod-info': async (_e, clientPath) => {
      logger.debug('Getting client installed mod info', {
        category: 'mods',
        data: {
          handler: 'get-client-installed-mod-info',
          clientPath: clientPath,
          pathExists: fs.existsSync(clientPath)
        }
      });

      try {
        const modInfo = await modFileManager.getClientInstalledModInfo(clientPath);
        
        logger.info('Retrieved client mod info', {
          category: 'mods',
          data: {
            handler: 'get-client-installed-mod-info',
            clientPath: clientPath,
            modCount: modInfo?.length || 0
          }
        });
        
        return modInfo;
      } catch (error) {
        logger.error(`Failed to get client mod info: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'get-client-installed-mod-info',
            clientPath: clientPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'check-client-mod-compatibility': async (_e, options) => {
      const { newMinecraftVersion, clientPath } = options;
      
      logger.info('Checking client mod compatibility', {
        category: 'mods',
        data: {
          handler: 'check-client-mod-compatibility',
          minecraftVersion: newMinecraftVersion,
          clientPath: clientPath,
          pathExists: fs.existsSync(clientPath)
        }
      });

      if (!clientPath || !fs.existsSync(clientPath)) {
        logger.error('Invalid client path provided for compatibility check', {
          category: 'mods',
          data: {
            handler: 'check-client-mod-compatibility',
            clientPath: clientPath,
            pathExists: fs.existsSync(clientPath)
          }
        });
        throw new Error('Invalid client path provided');
      }
      try {
        const clientModInfo = await modFileManager.getClientInstalledModInfo(clientPath);
        const compatibilityResults = [];
        
        logger.debug('Processing mod compatibility checks', {
          category: 'mods',
          data: {
            handler: 'check-client-mod-compatibility',
            modCount: clientModInfo.length,
            minecraftVersion: newMinecraftVersion
          }
        });

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
            
            logger.debug('Mod compatibility check: compatible', {
              category: 'mods',
              data: {
                modName: modInfo.name,
                fileName: modInfo.fileName,
                minecraftVersion: newMinecraftVersion,
                compatibilityStatus: 'compatible'
              }
            });
          } else {
            compatibilityStatus = 'unknown';
            reason = 'Unable to determine compatibility - manual verification recommended';
            
            logger.debug('Mod compatibility check: unknown', {
              category: 'mods',
              data: {
                modName: modInfo.name,
                fileName: modInfo.fileName,
                minecraftVersion: newMinecraftVersion,
                compatibilityStatus: 'unknown'
              }
            });
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
          logger.error(`Error checking mod compatibility: ${modError.message}`, {
            category: 'mods',
            data: {
              modName: modInfo?.name,
              fileName: modInfo?.fileName,
              minecraftVersion: newMinecraftVersion,
              errorType: modError.constructor.name
            }
          });

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
      
      logger.info('Client mod compatibility check completed', {
        category: 'mods',
        data: {
          handler: 'check-client-mod-compatibility',
          minecraftVersion: newMinecraftVersion,
          totalMods: compatibilityResults.length,
          compatible: report.compatible.length,
          incompatible: report.incompatible.length,
          needsUpdate: report.needsUpdate.length,
          unknown: report.unknown.length,
          errors: report.errors.length
        }
      });
      
      return report;
      } catch (error) {
        logger.error(`Client mod compatibility check failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'check-client-mod-compatibility',
            minecraftVersion: newMinecraftVersion,
            clientPath: clientPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'update-client-mod': async (_e, { modInfo, clientPath }) => {
      logger.info('Updating client mod', {
        category: 'mods',
        data: {
          handler: 'update-client-mod',
          modName: modInfo?.name,
          modId: modInfo?.projectId,
          clientPath: clientPath,
          hasDownloadUrl: !!modInfo?.downloadUrl
        }
      });

      if (!modInfo.downloadUrl) {
        logger.error('No download URL available for mod update', {
          category: 'mods',
          data: {
            handler: 'update-client-mod',
            modName: modInfo?.name,
            modId: modInfo?.projectId
          }
        });
        throw new Error('No download URL available for mod update');
      }
      try {
        const modsDir = path.join(clientPath, 'mods');
        await fs.promises.mkdir(modsDir, { recursive: true });
        const sanitizedName = modInfo.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const fileName = sanitizedName.endsWith('.jar') ? sanitizedName : `${sanitizedName}.jar`;
        const targetPath = path.join(modsDir, fileName);

        logger.debug('Downloading mod update', {
          category: 'network',
          data: {
            modName: modInfo.name,
            downloadUrl: modInfo.downloadUrl,
            targetPath: targetPath,
            fileName: fileName
          }
        });
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

      logger.debug('Mod download completed, processing file replacement', {
        category: 'storage',
        data: {
          modName: modInfo.name,
          targetPath: targetPath,
          hasCurrentFile: !!modInfo.currentFilePath
        }
      });

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
          lastUpdated: new Date().toISOString()
        };
      }
      manifest.fileName = newFileName;
      if (modInfo.newVersion) {
        manifest.versionNumber = modInfo.newVersion;
      } else if (modInfo.version) {
        manifest.versionNumber = modInfo.version;
      }
      manifest.lastUpdated = new Date().toISOString();
      await fs.promises.writeFile(newManifestPath, JSON.stringify(manifest, null, 2));
      if (oldManifestPath !== newManifestPath) {
        await fs.promises.unlink(oldManifestPath).catch(() => {});
      }

      modAnalysisUtils.invalidateMetadataCache(targetPath);

      logger.info('Client mod update completed successfully', {
        category: 'mods',
        data: {
          handler: 'update-client-mod',
          modName: modInfo.name,
          oldFileName: oldFileName,
          newFileName: newFileName,
          filePath: targetPath
        }
      });

      return { success: true, filePath: targetPath };
      } catch (error) {
        logger.error(`Client mod update failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'update-client-mod',
            modName: modInfo?.name,
            modId: modInfo?.projectId,
            clientPath: clientPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'disable-client-mod': async (_e, { modFilePath }) => {
      logger.info('Disabling client mod', {
        category: 'mods',
        data: {
          handler: 'disable-client-mod',
          modFilePath: modFilePath,
          fileExists: fs.existsSync(modFilePath)
        }
      });

      if (!fs.existsSync(modFilePath)) {
        logger.error('Mod file not found for disabling', {
          category: 'mods',
          data: {
            handler: 'disable-client-mod',
            modFilePath: modFilePath
          }
        });
        throw new Error('Mod file not found');
      }
      
      const disabledPath = modFilePath + '.disabled';
      if (fs.existsSync(disabledPath)) {
        logger.warn('Mod is already disabled', {
          category: 'mods',
          data: {
            handler: 'disable-client-mod',
            modFilePath: modFilePath,
            disabledPath: disabledPath
          }
        });
        throw new Error('Mod is already disabled');
      }

      try {
        fs.renameSync(modFilePath, disabledPath);
        
        logger.info('Client mod disabled successfully', {
          category: 'mods',
          data: {
            handler: 'disable-client-mod',
            originalPath: modFilePath,
            disabledPath: disabledPath
          }
        });
        
        return { success: true, disabledPath };
      } catch (error) {
        logger.error(`Failed to disable client mod: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'disable-client-mod',
            modFilePath: modFilePath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'update-client-mods': async (_e, { mods, clientPath, minecraftVersion }) => {
      logger.info('Bulk updating client mods', {
        category: 'mods',
        data: {
          handler: 'update-client-mods',
          modCount: mods?.length || 0,
          clientPath: clientPath,
          minecraftVersion: minecraftVersion
        }
      });

      if (!mods || !Array.isArray(mods) || mods.length === 0) {
        logger.error('No mods specified for bulk update', {
          category: 'mods',
          data: {
            handler: 'update-client-mods',
            modsProvided: !!mods,
            isArray: Array.isArray(mods),
            modCount: mods?.length || 0
          }
        });
        return { success: false, error: 'No mods specified for update.', updatedCount: 0 };
      }
      if (!clientPath) {
        logger.error('Client path not provided for bulk update', {
          category: 'mods',
          data: { handler: 'update-client-mods' }
        });
        return { success: false, error: 'Client path not provided.', updatedCount: 0 };
      }
      if (!minecraftVersion) {
        logger.error('Minecraft version not provided for bulk update', {
          category: 'mods',
          data: { handler: 'update-client-mods' }
        });
        return { success: false, error: 'Minecraft version not provided.', updatedCount: 0 };
      }
      try {
        const modsDir = path.join(clientPath, 'mods');
        if (!fs.existsSync(modsDir)) {
          fs.mkdirSync(modsDir, { recursive: true });
        }
        let updatedCount = 0;
        const errors = [];
        
        logger.debug('Processing bulk mod updates', {
          category: 'mods',
          data: {
            handler: 'update-client-mods',
            modsDir: modsDir,
            modCount: mods.length
          }
        });

        for (const modToUpdate of mods) {
          try {
            logger.debug('Processing individual mod update', {
              category: 'mods',
              data: {
                modName: modToUpdate.name,
                fileName: modToUpdate.fileName,
                hasNewVersionDetails: !!modToUpdate.newVersionDetails
              }
            });
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
              lastUpdated: new Date().toISOString()
            };
          }
          manifest.fileName = newFileName;
          if (modToUpdate.newVersionDetails && modToUpdate.newVersionDetails.versionNumber) {
            manifest.versionNumber = modToUpdate.newVersionDetails.versionNumber;
          }
          manifest.lastUpdated = new Date().toISOString();
          await fs.promises.writeFile(newManifestPath, JSON.stringify(manifest, null, 2));
          if (oldManifestPath !== newManifestPath) {
            await fs.promises.unlink(oldManifestPath).catch(() => {});
          }

          modAnalysisUtils.invalidateMetadataCache(path.join(modsDir, newFileName));

          logger.debug('Individual mod update completed', {
            category: 'mods',
            data: {
              modName: modToUpdate.name,
              oldFileName: oldFileName,
              newFileName: newFileName
            }
          });

          updatedCount++;
        } catch (error) {
          logger.error(`Individual mod update failed: ${error.message}`, {
            category: 'mods',
            data: {
              modName: modToUpdate.name || modToUpdate.fileName,
              errorType: error.constructor.name
            }
          });
          errors.push(`${modToUpdate.name || modToUpdate.fileName}: ${error.message}`);
        }
      }
      logger.info('Bulk client mod update completed', {
        category: 'mods',
        data: {
          handler: 'update-client-mods',
          totalMods: mods.length,
          updatedCount: updatedCount,
          errorCount: errors.length,
          success: updatedCount > 0
        }
      });

      if (errors.length > 0) {
        return { success: updatedCount > 0, updatedCount, error: `Some mods failed to update. Errors: ${errors.join('; ')}` };
      }
      return { success: true, updatedCount };
      } catch (error) {
        logger.error(`Bulk client mod update failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'update-client-mods',
            modCount: mods?.length || 0,
            clientPath: clientPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'disable-client-mods': async (_e, { mods, clientPath }) => {
      logger.info('Bulk disabling client mods', {
        category: 'mods',
        data: {
          handler: 'disable-client-mods',
          modCount: mods?.length || 0,
          clientPath: clientPath
        }
      });

      if (!mods || !Array.isArray(mods) || mods.length === 0) {
        logger.error('No mods specified for bulk disable', {
          category: 'mods',
          data: {
            handler: 'disable-client-mods',
            modsProvided: !!mods,
            isArray: Array.isArray(mods),
            modCount: mods?.length || 0
          }
        });
        return { success: false, error: 'No mods specified for disabling.', disabledCount: 0 };
      }
      if (!clientPath) {
        logger.error('Client path not provided for bulk disable', {
          category: 'mods',
          data: { handler: 'disable-client-mods' }
        });
        return { success: false, error: 'Client path not provided.', disabledCount: 0 };
      }
      
      const modsDir = path.join(clientPath, 'mods');
      if (!fs.existsSync(modsDir)) {
        logger.warn('Mods directory does not exist for bulk disable', {
          category: 'mods',
          data: {
            handler: 'disable-client-mods',
            modsDir: modsDir
          }
        });
        return { success: true, disabledCount: 0, message: 'Mods directory does not exist.' };
      }
      let disabledCount = 0;
      const errors = [];
      
      logger.debug('Processing bulk mod disabling', {
        category: 'mods',
        data: {
          handler: 'disable-client-mods',
          modsDir: modsDir,
          modCount: mods.length
        }
      });

      for (const modToDisable of mods) {
        try {
          if (!modToDisable.fileName) {
            throw new Error('Mod filename not provided for disabling.');
          }
          const modPath = path.join(modsDir, modToDisable.fileName);
          if (fs.existsSync(modPath)) {
            await disableMod(modsDir, modToDisable.fileName);
            disabledCount++;
            
            logger.debug('Individual mod disabled', {
              category: 'mods',
              data: {
                fileName: modToDisable.fileName,
                modPath: modPath
              }
            });
          } else {
            logger.debug('Mod file not found for disabling', {
              category: 'mods',
              data: {
                fileName: modToDisable.fileName,
                modPath: modPath
              }
            });
          }
        } catch (error) {
          logger.error(`Individual mod disable failed: ${error.message}`, {
            category: 'mods',
            data: {
              fileName: modToDisable.fileName,
              errorType: error.constructor.name
            }
          });
          errors.push(`${modToDisable.fileName}: ${error.message}`);
        }
      }
      logger.info('Bulk client mod disable completed', {
        category: 'mods',
        data: {
          handler: 'disable-client-mods',
          totalMods: mods.length,
          disabledCount: disabledCount,
          errorCount: errors.length,
          success: disabledCount > 0 || errors.length === 0
        }
      });

      if (errors.length > 0) {
        return { success: disabledCount > 0, disabledCount, error: `Some mods failed to disable. Errors: ${errors.join('; ')}` };
      }
      return { success: true, disabledCount };
    },

    'enhance-mod-names': async (_e, { clientPath, mods }) => {
      logger.info('Enhancing mod names', {
        category: 'mods',
        data: {
          handler: 'enhance-mod-names',
          clientPath: clientPath,
          modCount: mods?.length || 0
        }
      });

      if (!mods || !Array.isArray(mods)) {
        logger.error('Invalid mods data for name enhancement', {
          category: 'mods',
          data: {
            handler: 'enhance-mod-names',
            modsProvided: !!mods,
            isArray: Array.isArray(mods)
          }
        });
        return { success: false, error: 'Invalid mods data' };
      }
      
      const modsDir = path.join(clientPath, 'mods');
      if (!fs.existsSync(modsDir)) {
        logger.error('Mods directory not found for name enhancement', {
          category: 'mods',
          data: {
            handler: 'enhance-mod-names',
            modsDir: modsDir
          }
        });
        return { success: false, error: 'Mods directory not found' };
      }
      try {
        const enhancedMods = [];
        let enhancedCount = 0;
        
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
                enhancedCount++;
                
                logger.debug('Enhanced mod name', {
                  category: 'mods',
                  data: {
                    fileName: mod.fileName,
                    originalName: mod.name,
                    enhancedName: metadata.name
                  }
                });
              }
              if (metadata?.version) {
                enhancedMod.cleanVersion = metadata.version;
              }
            }
          } catch (error) {
            logger.debug(`Failed to enhance mod name: ${error.message}`, {
              category: 'mods',
              data: {
                fileName: mod.fileName,
                errorType: error.constructor.name
              }
            });
            // ignore errors extracting metadata
          }
          enhancedMods.push(enhancedMod);
        }
        
        logger.info('Mod name enhancement completed', {
          category: 'mods',
          data: {
            handler: 'enhance-mod-names',
            totalMods: mods.length,
            enhancedCount: enhancedCount
          }
        });
        
        return { success: true, enhancedMods };
      } catch (error) {
        logger.error(`Mod name enhancement failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'enhance-mod-names',
            clientPath: clientPath,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },    'download-client-mod-version-updates': async (_e, { clientPath, updates, minecraftVersion }) => {
      logger.info('Downloading client mod version updates', {
        category: 'mods',
        data: {
          handler: 'download-client-mod-version-updates',
          clientPath: clientPath,
          updateCount: updates?.length || 0,
          minecraftVersion: minecraftVersion
        }
      });

      try {
        if (!clientPath || !updates || !Array.isArray(updates)) {
          logger.error('Invalid parameters for mod version updates', {
            category: 'mods',
            data: {
              handler: 'download-client-mod-version-updates',
              hasClientPath: !!clientPath,
              hasUpdates: !!updates,
              isUpdatesArray: Array.isArray(updates)
            }
          });
          throw new Error('Invalid parameters provided');
        }

        if (!fs.existsSync(clientPath)) {
          logger.error('Client path does not exist for mod updates', {
            category: 'mods',
            data: {
              handler: 'download-client-mod-version-updates',
              clientPath: clientPath
            }
          });
          throw new Error('Client path does not exist');
        }

        const modsDir = path.join(clientPath, 'mods');
        await fs.promises.mkdir(modsDir, { recursive: true });

        let updatedCount = 0;
        let errors = [];

        logger.debug('Processing mod version updates', {
          category: 'mods',
          data: {
            handler: 'download-client-mod-version-updates',
            modsDir: modsDir,
            updateCount: updates.length
          }
        });

        // Process each update
        for (const update of updates) {
          try {
            logger.debug('Processing individual mod version update', {
              category: 'mods',
              data: {
                modName: update.name,
                projectId: update.projectId,
                hasDownloadUrl: !!update.downloadUrl
              }
            });

            if (!update.downloadUrl) {
              const error = `${update.name}: No download URL available`;
              logger.warn('No download URL for mod update', {
                category: 'mods',
                data: {
                  modName: update.name,
                  projectId: update.projectId
                }
              });
              errors.push(error);
              continue;
            }            // Find current mod file (old filename) and use original filename pattern
            const oldFileName = update.oldFileName || update.fileName; // Fallback for compatibility
            // Use the original mod filename instead of the Modrinth API filename to maintain consistency
            const newFileName = oldFileName; // Keep the original filename pattern instead of using API filename
            
            const currentModPath = path.join(modsDir, oldFileName);
            const newModPath = path.join(modsDir, newFileName);
            // Download new version with progress tracking
            const downloadId = `client-update-${update.projectId || update.name}-${Date.now()}`;
            const modName = update.name || oldFileName;
            
            logger.debug('Starting mod download', {
              category: 'network',
              data: {
                modName: modName,
                downloadUrl: update.downloadUrl,
                downloadId: downloadId,
                oldFileName: oldFileName,
                newFileName: newFileName
              }
            });
            
            // Send initial progress
            if (win && win.webContents) {
              win.webContents.send('download-progress', { 
                id: downloadId, 
                name: modName, 
                progress: 0, 
                speed: 0, 
                completed: false, 
                error: null 
              });
            }
            
            const response = await require('axios')({
              url: update.downloadUrl,
              method: 'GET',
              responseType: 'stream',
              timeout: 60000,
              onDownloadProgress: (progressEvent) => {
                const progress = progressEvent.loaded / progressEvent.total;
                const speed = progressEvent.rate || 0;
                
                if (win && win.webContents) {
                  win.webContents.send('download-progress', { 
                    id: downloadId, 
                    name: modName, 
                    progress: progress * 100, 
                    size: progressEvent.total,
                    downloaded: progressEvent.loaded,
                    speed: speed, 
                    completed: false, 
                    error: null 
                  });
                }
              }
            });            // Create temporary file for download (use new filename)
            const tempPath = newModPath + '.tmp';
            const writer = fs.createWriteStream(tempPath);
              await new Promise((resolve, reject) => {
              response.data.pipe(writer);
              writer.on('finish', () => {
                // Send completion progress
                if (win && win.webContents) {
                  win.webContents.send('download-progress', { 
                    id: downloadId, 
                    name: modName, 
                    progress: 100, 
                    speed: 0, 
                    completed: true, 
                    completedTime: Date.now(),
                    error: null 
                  });
                }
                resolve();
              });
              writer.on('error', (err) => {
                // Send error progress
                if (win && win.webContents) {
                  win.webContents.send('download-progress', { 
                    id: downloadId, 
                    name: modName, 
                    progress: 0, 
                    speed: 0, 
                    completed: false, 
                    error: err.message,
                    completedTime: Date.now()
                  });
                }
                reject(err);
              });
            });            // Remove old file if it exists before downloading new version
            if (fs.existsSync(currentModPath)) {
              await fs.promises.unlink(currentModPath);
            }
            
            // Move new file to final location
            await fs.promises.rename(tempPath, newModPath);            // Update manifest for the same filename
            const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
            await fs.promises.mkdir(manifestDir, { recursive: true });
            const manifestPath = path.join(manifestDir, `${newFileName}.json`);
            
            let manifest = {};
            try {
              const content = await fs.promises.readFile(manifestPath, 'utf8');
              manifest = JSON.parse(content);            } catch {              // Create new manifest if it doesn't exist
              manifest = {
                projectId: update.projectId,
                name: update.name,
                fileName: newFileName, // Use new filename
                versionNumber: update.newVersion,
                lastUpdated: new Date().toISOString(),
                minecraftVersion: minecraftVersion
              };
            }            // Update manifest with new version info but preserve filename consistency
            manifest.versionNumber = update.newVersion;
            manifest.lastUpdated = new Date().toISOString();
            manifest.minecraftVersion = minecraftVersion;
            manifest.fileName = newFileName; // Keep consistent with original filename
            // Ensure we preserve the Modrinth projectId for API compatibility
            manifest.projectId = update.projectId;
            manifest.name = update.name;
            
            await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));            // Invalidate metadata cache for the updated file
            modAnalysisUtils.invalidateMetadataCache(currentModPath);
            updatedCount++;
            
            logger.debug('Individual mod version update completed', {
              category: 'mods',
              data: {
                modName: update.name,
                oldFileName: oldFileName,
                newFileName: newFileName,
                updatedCount: updatedCount
              }
            });
            
            // Emit progress if window is available
            if (win && win.webContents) {
              win.webContents.send('launcher-download-progress', {
                downloaded: updatedCount,
                total: updates.length,
                current: update.name,
                status: 'downloading'
              });
            }          } catch (modError) {
            logger.error(`Individual mod version update failed: ${modError.message}`, {
              category: 'mods',
              data: {
                modName: update.name,
                projectId: update.projectId,
                errorType: modError.constructor.name
              }
            });

            // Send error progress for failed mod updates
            const downloadId = `client-update-${update.projectId || update.name}-${Date.now()}`;
            const modName = update.name || update.fileName;
            
            if (win && win.webContents) {
              win.webContents.send('download-progress', { 
                id: downloadId, 
                name: modName, 
                progress: 0, 
                speed: 0, 
                completed: false, 
                error: modError.message,
                completedTime: Date.now()
              });
            }
            
            const error = `${update.name}: ${modError.message}`;
            errors.push(error);
          }
        }

        // Send completion event
        if (win && win.webContents) {
          win.webContents.send('launcher-download-complete', {
            success: updatedCount > 0,
            updated: updatedCount,
            errors: errors.length
          });
        }
        
        logger.info('Client mod version updates completed', {
          category: 'mods',
          data: {
            handler: 'download-client-mod-version-updates',
            totalUpdates: updates.length,
            updatedCount: updatedCount,
            errorCount: errors.length,
            minecraftVersion: minecraftVersion
          }
        });

        const result = {
          success: true,
          updated: updatedCount,
          errors: errors.length > 0 ? errors : undefined,
          message: `Successfully updated ${updatedCount} mod${updatedCount !== 1 ? 's' : ''} for Minecraft ${minecraftVersion}`
        };
        
        return result;      } catch (error) {
        logger.error(`Client mod version updates failed: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'download-client-mod-version-updates',
            clientPath: clientPath,
            updateCount: updates?.length || 0,
            errorType: error.constructor.name
          }
        });
        
        return {
          success: false,
          error: error.message
        };
      }
    },

    'clear-client-mod-cache': async (_e, { clientPath, fileName }) => {
      logger.info('Clearing client mod cache', {
        category: 'mods',
        data: {
          handler: 'clear-client-mod-cache',
          clientPath: clientPath,
          fileName: fileName
        }
      });

      try {
        if (!clientPath || !fileName) {
          logger.error('Client path and file name required for cache clear', {
            category: 'mods',
            data: {
              handler: 'clear-client-mod-cache',
              hasClientPath: !!clientPath,
              hasFileName: !!fileName
            }
          });
          throw new Error('Client path and file name are required');
        }

        const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
        const manifestPath = path.join(manifestDir, `${fileName}.json`);
        
        // Delete the manifest file to force re-reading from jar
        if (fs.existsSync(manifestPath)) {
          await fs.promises.unlink(manifestPath);
          logger.debug('Deleted manifest file', {
            category: 'storage',
            data: {
              manifestPath: manifestPath,
              fileName: fileName
            }
          });
        }

        // Also invalidate any other caches
        const modPath = path.join(clientPath, 'mods', fileName);
        if (modAnalysisUtils && modAnalysisUtils.invalidateMetadataCache) {
          modAnalysisUtils.invalidateMetadataCache(modPath);
          logger.debug('Invalidated metadata cache', {
            category: 'mods',
            data: {
              modPath: modPath,
              fileName: fileName
            }
          });
        }

        logger.info('Client mod cache cleared successfully', {
          category: 'mods',
          data: {
            handler: 'clear-client-mod-cache',
            fileName: fileName,
            clientPath: clientPath
          }
        });

        return { success: true };
      } catch (error) {
        logger.error(`Error clearing client mod cache: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'clear-client-mod-cache',
            clientPath: clientPath,
            fileName: fileName,
            errorType: error.constructor.name
          }
        });
        return { success: false, error: error.message };
      }
    }
  };
}

module.exports = { createClientModHandlers };
