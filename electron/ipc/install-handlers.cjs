// Installation and download IPC handlers
const fs = require('fs');
const path = require('path');
const {
  downloadMinecraftServer,
  installFabric
} = require('../services/download-manager.cjs');
const { ServerJavaManager } = require('../services/server-java-manager.cjs');
const { getLoggerHandlers } = require('./logger-handlers.cjs');
const { readServerConfig, getDefaultServerConfig } = require('../utils/config-manager.cjs');
const { getFabricRuntimeStatus } = require('../utils/fabric-runtime.cjs');
const { resolveServerLoader } = require('../utils/server-loader.cjs');
const { findForgeLaunchAssets } = require('../services/server-launcher.cjs');
const {
  installServerLoader,
  getLoaderVersions,
  normalizeLoader: normalizeLoaderName,
  getForgeRuntimeHealthIssues
} = require('../services/loader-install-service.cjs');

const logger = getLoggerHandlers();

async function ensureServerJavaReady(win, targetPath, mcVersion) {
  const serverJavaManager = new ServerJavaManager(targetPath);
  let javaRequirements = await serverJavaManager.getJavaRequirementsForMinecraft(mcVersion);

  if (javaRequirements.needsDownload) {
    const javaResult = await serverJavaManager.ensureJavaForMinecraft(
      mcVersion,
      (progress) => {
        if (win && win.webContents) {
          win.webContents.send('server-java-download-progress', {
            minecraftVersion: mcVersion,
            serverPath: targetPath,
            ...progress
          });
        }
      }
    );

    if (!javaResult.success) {
      throw new Error(javaResult.error || 'Java installation failed');
    }

    javaRequirements = await serverJavaManager.getJavaRequirementsForMinecraft(mcVersion);
  }

  if (!javaRequirements.isAvailable || !javaRequirements.javaPath) {
    throw new Error(
      javaRequirements.validationMessage
      || `Java ${javaRequirements.requiredJavaVersion} is not available for Minecraft ${mcVersion}`
    );
  }

  return {
    serverJavaManager,
    javaRequirements,
    javaPath: javaRequirements.javaPath
  };
}

function resolveEffectiveLoader(targetPath, payload = {}) {
  const payloadLoader = typeof payload.loader === 'string' ? payload.loader.trim() : '';
  if (payloadLoader) {
    return normalizeLoaderName(payloadLoader);
  }

  const config = readServerConfig(targetPath, getDefaultServerConfig()) || {};
  if (config.loader) {
    return normalizeLoaderName(config.loader);
  }

  if (config.fabric) {
    return 'fabric';
  }

  return normalizeLoaderName(resolveServerLoader(targetPath).loader || 'vanilla');
}

function resolveEffectiveLoaderVersion(targetPath, loader, payload = {}) {
  const config = readServerConfig(targetPath, getDefaultServerConfig()) || {};
  if (loader === 'vanilla') {
    return null;
  }

  if (typeof payload.loaderVersion === 'string' && payload.loaderVersion.trim()) {
    return payload.loaderVersion.trim();
  }

  if (loader === 'fabric' && typeof payload.fabricVersion === 'string' && payload.fabricVersion.trim()) {
    return payload.fabricVersion.trim();
  }

  if (typeof config.loaderVersion === 'string' && config.loaderVersion.trim()) {
    return config.loaderVersion.trim();
  }

  if (loader === 'fabric' && typeof config.fabric === 'string' && config.fabric.trim()) {
    return config.fabric.trim();
  }

  const loaderInfo = resolveServerLoader(targetPath);
  return loaderInfo?.loaderVersion || null;
}

async function getLoaderHealthIssues(targetPath, loader, loaderVersion = null, minecraftVersion = null) {
  if (loader === 'fabric') {
    return getFabricRuntimeStatus(targetPath).issues.map((issue) => issue.message);
  }

  if (loader === 'forge') {
    const forgeAssets = findForgeLaunchAssets(targetPath);
    const issues = [];
    if (!forgeAssets.forgeArgs) {
      issues.push('Forge launch assets');
    }
    const runtimeIssues = await getForgeRuntimeHealthIssues(targetPath, minecraftVersion, loaderVersion);
    return [...issues, ...runtimeIssues];
  }

  return [];
}

async function buildHealthReport(targetPath) {
  const config = readServerConfig(targetPath, getDefaultServerConfig()) || {};
  const loader = resolveEffectiveLoader(targetPath, config);
  const loaderVersion = resolveEffectiveLoaderVersion(targetPath, loader, config);
  const missing = [];

  if (!fs.existsSync(path.join(targetPath, 'server.jar'))) {
    missing.push('server.jar');
  }

  missing.push(...await getLoaderHealthIssues(targetPath, loader, loaderVersion, config.version));

  if (config.version) {
    try {
      const serverJavaManager = new ServerJavaManager(targetPath);
      const javaRequirements = await serverJavaManager.getJavaRequirementsForMinecraft(config.version);
      if (javaRequirements.needsDownload) {
        missing.push(
          javaRequirements.installationState === 'broken'
            ? `Java ${javaRequirements.requiredJavaVersion} runtime is broken (for Minecraft ${config.version})`
            : `Java ${javaRequirements.requiredJavaVersion} (for Minecraft ${config.version})`
        );
      }
    } catch {
      // Ignore Java inspection failures in health summary
    }
  }

  return {
    loader,
    loaderVersion,
    missing
  };
}

/**
 * Create installation and download IPC handlers
 * 
 * @param {object} win - The main application window
 * @returns {Object.<string, Function>} Object with channel names as keys and handler functions as values
 */
function createInstallHandlers(win) {
  logger.info('Install handlers initialized', {
    category: 'core',
    data: { handler: 'createInstallHandlers' }
  });

  return {
    'check-java': async () => {
      const startTime = Date.now();

      logger.debug('IPC handler invoked', {
        category: 'core',
        data: {
          handler: 'check-java',
          operation: 'java_detection'
        }
      });

      try {
        const { exec } = require('child_process');

        logger.debug('Starting Java version check', {
          category: 'core',
          data: {
            handler: 'check-java',
            operation: 'exec_java_version',
            command: 'java -version'
          }
        });

        return new Promise((resolve) => {
          exec('java -version', (error, stdout, stderr) => {
            const duration = Date.now() - startTime;

            if (error) {
              logger.warn('Java not found or not accessible', {
                category: 'core',
                data: {
                  handler: 'check-java',
                  operation: 'java_detection',
                  duration,
                  installed: false,
                  errorType: error.constructor.name,
                  errorMessage: error.message
                }
              });
              resolve({ installed: false, error: error.message });
              return;
            }

            // Java outputs version to stderr by default
            const output = stderr || stdout;
            const version = output.split('\n')[0].trim();

            logger.info('Java detection completed successfully', {
              category: 'core',
              data: {
                handler: 'check-java',
                operation: 'java_detection',
                duration,
                installed: true,
                version,
                outputSource: stderr ? 'stderr' : 'stdout'
              }
            });

            resolve({
              installed: true,
              version
            });
          });
        });
      } catch (err) {
        const duration = Date.now() - startTime;

        logger.error(`Java check failed: ${err.message}`, {
          category: 'core',
          data: {
            handler: 'check-java',
            operation: 'java_detection',
            duration,
            errorType: err.constructor.name,
            installed: false
          }
        });

        return { installed: false, error: err.message };
      }
    },

    'download-minecraft-server': async (_e, { mcVersion, targetPath }) => {
      const startTime = Date.now();

      logger.debug('IPC handler invoked', {
        category: 'core',
        data: {
          handler: 'download-minecraft-server',
          sender: _e.sender.id,
          parameters: {
            mcVersion: mcVersion !== undefined,
            targetPath: targetPath !== undefined
          }
        }
      });

      try {
        // Parameter validation with logging
        logger.debug('Starting parameter validation', {
          category: 'core',
          data: {
            handler: 'download-minecraft-server',
            operation: 'validation',
            mcVersion: mcVersion,
            mcVersionType: typeof mcVersion,
            targetPath: targetPath,
            targetPathExists: targetPath ? fs.existsSync(targetPath) : false
          }
        });

        if (!mcVersion || typeof mcVersion !== 'string') {
          logger.error('Parameter validation failed', {
            category: 'core',
            data: {
              handler: 'download-minecraft-server',
              validation: 'mcVersion',
              value: mcVersion,
              type: typeof mcVersion,
              valid: false,
              errorReason: !mcVersion ? 'missing' : 'invalid_type'
            }
          });
          throw new Error('Invalid Minecraft version');
        }

        if (!targetPath || !fs.existsSync(targetPath)) {
          logger.error('Parameter validation failed', {
            category: 'storage',
            data: {
              handler: 'download-minecraft-server',
              validation: 'targetPath',
              value: targetPath,
              exists: targetPath ? fs.existsSync(targetPath) : false,
              valid: false,
              errorReason: !targetPath ? 'missing' : 'path_not_exists'
            }
          });
          throw new Error('Invalid target directory');
        }

        logger.info('Starting Minecraft server download', {
          category: 'network',
          data: {
            handler: 'download-minecraft-server',
            operation: 'download_start',
            mcVersion,
            targetPath,
            targetPathExists: true
          }
        });

        const result = await downloadMinecraftServer(mcVersion, targetPath);
        const duration = Date.now() - startTime;

        logger.info('Minecraft server download completed', {
          category: 'network',
          data: {
            handler: 'download-minecraft-server',
            operation: 'download_complete',
            duration,
            mcVersion,
            targetPath,
            success: result === true,
            resultType: typeof result
          }
        });

        return result;
      } catch (err) {
        const duration = Date.now() - startTime;

        logger.error(`Minecraft server download failed: ${err.message}`, {
          category: 'network',
          data: {
            handler: 'download-minecraft-server',
            operation: 'download_failed',
            duration,
            mcVersion,
            targetPath,
            errorType: err.constructor.name,
            errorMessage: err.message
          }
        });

        return { success: false, error: err.message };
      }
    },

    'get-loader-versions': async (_e, { loader, mcVersion } = {}) => {
      if (!mcVersion || typeof mcVersion !== 'string') {
        return { success: false, error: 'Invalid Minecraft version' };
      }

      try {
        const versions = await getLoaderVersions(loader, mcVersion);
        return { success: true, versions };
      } catch (error) {
        return { success: false, error: error.message, versions: [] };
      }
    },

    'download-and-install-loader': async (_e, payload = {}) => {
      const startTime = Date.now();
      const {
        path: targetPath,
        mcVersion,
        loader,
        loaderVersion,
        fabricVersion
      } = payload;
      const effectiveLoader = normalizeLoaderName(loader || (fabricVersion ? 'fabric' : 'vanilla'));
      const effectiveLoaderVersion = effectiveLoader === 'fabric'
        ? (loaderVersion || fabricVersion)
        : (effectiveLoader === 'vanilla' ? null : loaderVersion);

      try {
        if (!targetPath || !fs.existsSync(targetPath)) {
          throw new Error('Invalid target directory');
        }

        if (!mcVersion || typeof mcVersion !== 'string') {
          throw new Error('Invalid Minecraft version');
        }

        if (effectiveLoader !== 'vanilla' && (!effectiveLoaderVersion || typeof effectiveLoaderVersion !== 'string')) {
          throw new Error(`Invalid ${effectiveLoader} version`);
        }

        let javaPath = null;
        if (effectiveLoader !== 'vanilla') {
          const javaInfo = await ensureServerJavaReady(win, targetPath, mcVersion);
          javaPath = javaInfo.javaPath;
        }

        const result = await installServerLoader({
          targetPath,
          minecraftVersion: mcVersion,
          loader: effectiveLoader,
          loaderVersion: effectiveLoaderVersion,
          javaPath,
          logChannel: 'install-log',
          progressChannel: effectiveLoader === 'fabric' ? 'fabric-install-progress' : 'loader-install-progress'
        });

        return {
          success: true,
          loader: effectiveLoader,
          loaderVersion: result.loaderVersion || effectiveLoaderVersion || null
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        logger.error(`Loader installation failed: ${err.message}`, {
          category: 'mods',
          data: {
            handler: 'download-and-install-loader',
            operation: 'loader_install_failed',
            duration,
            targetPath,
            mcVersion,
            loader: effectiveLoader,
            loaderVersion: effectiveLoaderVersion,
            errorType: err.constructor.name,
            errorMessage: err.message
          }
        });

        if (win && win.webContents) {
          win.webContents.send('install-error', err.message);
        }

        return { success: false, error: err.message };
      }
    },

    'download-and-install-fabric': async (_e, { path: targetPath, mcVersion, fabricVersion } = {}) => {
      try {
        const { javaPath } = await ensureServerJavaReady(win, targetPath, mcVersion);
        return await installServerLoader({
          targetPath,
          minecraftVersion: mcVersion,
          loader: 'fabric',
          loaderVersion: fabricVersion,
          javaPath,
          logChannel: 'install-log',
          progressChannel: 'fabric-install-progress'
        });
      } catch (error) {
        if (win && win.webContents) {
          win.webContents.send('install-error', error.message);
        }
        return { success: false, error: error.message };
      }
    },

    'check-health': async (_e, targetPath) => {
      const startTime = Date.now();

      logger.debug('IPC handler invoked', {
        category: 'core',
        data: {
          handler: 'check-health',
          sender: _e.sender.id,
          targetPath: targetPath
        }
      });

      try {
        // Parameter validation
        logger.debug('Starting health check validation', {
          category: 'storage',
          data: {
            handler: 'check-health',
            operation: 'validation',
            targetPath: targetPath,
            targetPathExists: targetPath ? fs.existsSync(targetPath) : false
          }
        });

        if (!targetPath || !fs.existsSync(targetPath)) {
          logger.error('Health check validation failed', {
            category: 'storage',
            data: {
              handler: 'check-health',
              validation: 'targetPath',
              value: targetPath,
              exists: targetPath ? fs.existsSync(targetPath) : false,
              valid: false,
              errorReason: !targetPath ? 'missing' : 'path_not_exists'
            }
          });
          throw new Error('Invalid target directory');
        }

        const report = await buildHealthReport(targetPath);
        const missing = report.missing;

        const duration = Date.now() - startTime;

        logger.info('Health check completed', {
          category: 'core',
          data: {
            handler: 'check-health',
            operation: 'health_check_complete',
            duration,
            targetPath,
            totalMissing: missing.length,
            missingItems: missing,
            filesChecked: 1,
            javaCheckPerformed: true
          }
        });

        return missing;
      } catch (err) {
        const duration = Date.now() - startTime;

        logger.error(`Health check failed: ${err.message}`, {
          category: 'core',
          data: {
            handler: 'check-health',
            operation: 'health_check_failed',
            duration,
            targetPath,
            errorType: err.constructor.name,
            errorMessage: err.message
          }
        });

        throw err;
      }
    },

    'repair-health': async (_e, payload = {}) => {
      const startTime = Date.now();
      const { targetPath, mcVersion, loader, loaderVersion, fabricVersion } = payload;

      try {
        if (!targetPath || !fs.existsSync(targetPath)) {
          throw new Error('Invalid target directory');
        }

        if (!mcVersion || typeof mcVersion !== 'string') {
          throw new Error('Invalid Minecraft version');
        }

        const effectiveLoader = resolveEffectiveLoader(targetPath, payload);
        const effectiveLoaderVersion = resolveEffectiveLoaderVersion(targetPath, effectiveLoader, {
          loader,
          loaderVersion,
          fabricVersion
        });
        const repairedItems = [];
        const report = await buildHealthReport(targetPath);
        const loaderIssues = await getLoaderHealthIssues(targetPath, effectiveLoader, effectiveLoaderVersion, mcVersion);
        const needsServerJar = report.missing.includes('server.jar');

        const serverJavaManager = new ServerJavaManager(targetPath);
        let javaRequirements = await serverJavaManager.getJavaRequirementsForMinecraft(mcVersion);
        const needsJava = javaRequirements.needsDownload;

        if (!needsJava && !needsServerJar && loaderIssues.length === 0) {
          if (win && win.webContents) {
            win.webContents.send('repair-status', 'done');
          }
          return [];
        }

        if (needsJava) {
          if (win && win.webContents) {
            win.webContents.send('repair-log', `🔧 Installing Java ${javaRequirements.requiredJavaVersion}...`);
          }

          const javaReady = await ensureServerJavaReady(win, targetPath, mcVersion);
          javaRequirements = javaReady.javaRequirements;
          repairedItems.push(`Java ${javaRequirements.requiredJavaVersion}`);

          if (win && win.webContents) {
            win.webContents.send('repair-log', `✔ Java ${javaRequirements.requiredJavaVersion} ready`);
          }
        }

        if (needsServerJar) {
          if (win && win.webContents) {
            win.webContents.send('repair-log', '🔧 Repairing server.jar...');
          }
          await downloadMinecraftServer(mcVersion, targetPath, 'repair-progress');
          repairedItems.push('server.jar');

          if (win && win.webContents) {
            win.webContents.send('repair-log', '✔ server.jar repaired');
          }
        }

        if (loaderIssues.length > 0 && effectiveLoader !== 'vanilla') {
          if (!effectiveLoaderVersion) {
            throw new Error(`${effectiveLoader} version is missing. Save the server version settings before repairing.`);
          }

          if (win && win.webContents) {
            win.webContents.send('repair-log', `🔧 Repairing ${effectiveLoader} runtime...`);
          }

          const javaReady = await ensureServerJavaReady(win, targetPath, mcVersion);
          await installServerLoader({
            targetPath,
            minecraftVersion: mcVersion,
            loader: effectiveLoader,
            loaderVersion: effectiveLoaderVersion,
            javaPath: javaReady.javaPath,
            logChannel: 'repair-log',
            progressChannel: 'repair-progress'
          });

          repairedItems.push(effectiveLoader === 'forge' ? 'Forge launch assets' : `${effectiveLoader} runtime`);
        }

        if (win && win.webContents) {
          win.webContents.send('repair-status', 'done');
        }

        logger.info('Repair health process completed successfully', {
          category: 'core',
          data: {
            handler: 'repair-health',
            operation: 'repair_complete',
            duration: Date.now() - startTime,
            targetPath,
            mcVersion,
            loader: effectiveLoader,
            loaderVersion: effectiveLoaderVersion,
            repairedItems
          }
        });

        return repairedItems;
      } catch (err) {
        logger.error(`Repair health process failed: ${err.message}`, {
          category: 'core',
          data: {
            handler: 'repair-health',
            operation: 'repair_failed',
            duration: Date.now() - startTime,
            targetPath,
            mcVersion,
            loader,
            loaderVersion: loaderVersion || fabricVersion || null,
            errorType: err.constructor.name,
            errorMessage: err.message,
            stack: err.stack
          }
        });

        if (win && win.webContents) {
          win.webContents.send('repair-log', `❌ Error: ${err.message}`);
          win.webContents.send('repair-status', 'error');
        }

        throw err;
      }
    }
  };
}

module.exports = { createInstallHandlers };
