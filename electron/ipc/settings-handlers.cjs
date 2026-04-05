// Settings IPC handlers
const appStore = require('../utils/app-store.cjs');
const { ensureServersDat } = require('../utils/servers-dat.cjs');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { rm } = require('fs/promises');
const { getLoggerHandlers } = require('./logger-handlers.cjs');
const instanceContext = require('../utils/instance-context.cjs');
const {
  getDefaultServerConfig,
  readServerConfig,
  updateServerConfig,
  readClientConfig
} = require('../utils/config-manager.cjs');
const {
  ensureEncryptionAvailable,
  packSecret,
  unpackSecret
} = require('../utils/secure-store.cjs');
const { validateServerPorts } = require('../utils/port-validator.cjs');
const {
  shutdownMinecraftServer
} = require('../services/server-manager.cjs');
const {
  stopAndDisposeManagementServers
} = require('../services/management-server.cjs');

const logger = getLoggerHandlers();

const DEFAULT_SERVER_SETTINGS = {
  port: 25565,
  maxRam: 4,
  managementPort: 8080,
  autoStartMinecraft: false,
  autoStartManagement: false
};

function getServerConfigDefaults(serverPath = '') {
  const instances = appStore.get('instances') || [];
  const existingServer = serverPath
    ? instances.find((inst) => inst && inst.type === 'server' && inst.path === serverPath)
    : null;

  let folderSecret = '';
  if (existingServer && existingServer.managementInviteSecret) {
    try {
      ensureEncryptionAvailable();
      folderSecret = unpackSecret(existingServer.managementInviteSecret);
    } catch {
      folderSecret = '';
    }
  }

  return getDefaultServerConfig({
    port: DEFAULT_SERVER_SETTINGS.port,
    maxRam: DEFAULT_SERVER_SETTINGS.maxRam,
    managementPort: DEFAULT_SERVER_SETTINGS.managementPort,
    autoStartMinecraft: !!DEFAULT_SERVER_SETTINGS.autoStartMinecraft,
    autoStartManagement: !!DEFAULT_SERVER_SETTINGS.autoStartManagement,
    autoRestart: {
      enabled: false,
      delay: 10,
      maxCrashes: 3
    },
    managementInviteHost: typeof existingServer?.managementInviteHost === 'string'
      ? existingServer.managementInviteHost
      : '',
    managementInviteSecret: folderSecret,
    managementTls: existingServer && existingServer.managementTls ? existingServer.managementTls : null,
    backupAutomation: {
      enabled: false,
      frequency: 86400000,
      type: 'world',
      retentionCount: 100,
      runOnLaunch: false,
      hour: 3,
      minute: 0,
      day: 0,
      lastRun: null
    }
  });
}

function getMergedServerSettings(serverPath) {
  const config = serverPath ? readServerConfig(serverPath, getServerConfigDefaults(serverPath)) : null;
  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...(config ? {
      port: config.port,
      maxRam: config.maxRam,
      managementPort: config.managementPort,
      autoStartMinecraft: !!config.autoStartMinecraft,
      autoStartManagement: !!config.autoStartManagement
    } : {})
  };
}

function getPackedInviteSecretFromFolder(serverPath) {
  if (!serverPath) return '';
  const config = readServerConfig(serverPath, getServerConfigDefaults(serverPath));
  const plainSecret = config && typeof config.managementInviteSecret === 'string'
    ? config.managementInviteSecret.trim()
    : '';
  if (!plainSecret) {
    return '';
  }
  try {
    ensureEncryptionAvailable();
    return packSecret(plainSecret);
  } catch {
    return '';
  }
}

function normalizeHost(value) {
  if (!value || typeof value !== 'string') return '';
  return value.replace(/^\[|\]$/g, '').trim().toLowerCase();
}

function buildPendingPinKey(host, port) {
  const normalizedHost = normalizeHost(host);
  const normalizedPort = String(port || '8080');
  if (!normalizedHost || !normalizedPort) return '';
  return `${normalizedHost}|${normalizedPort}`;
}

function isSameServerInstance(left, right) {
  if (!left || !right || left.type !== 'server' || right.type !== 'server') {
    return false;
  }

  if (left.id && right.id) {
    return left.id === right.id;
  }

  return !!left.path && !!right.path && left.path === right.path;
}

function getRemovedServerInstances(currentInstances, nextInstances) {
  const nextServers = (nextInstances || []).filter((instance) => instance && instance.type === 'server');
  return (currentInstances || []).filter((instance) => {
    if (!instance || instance.type !== 'server') {
      return false;
    }
    return !nextServers.some((nextInstance) => isSameServerInstance(instance, nextInstance));
  });
}

function cleanupDeletedInstanceStoreState(instance) {
  if (!instance || typeof instance !== 'object') {
    return;
  }

  const instanceConfigKeys = new Set();
  if (typeof instance.id === 'string' && instance.id.trim()) {
    instanceConfigKeys.add(instance.id.trim());
  }
  if (typeof instance.path === 'string' && instance.path.trim()) {
    instanceConfigKeys.add(instance.path.trim());
  }

  if (instanceConfigKeys.size > 0) {
    const instanceConfigs = appStore.get('instanceConfigs');
    if (instanceConfigs && typeof instanceConfigs === 'object' && !Array.isArray(instanceConfigs)) {
      let changed = false;
      const nextInstanceConfigs = { ...instanceConfigs };
      for (const key of instanceConfigKeys) {
        if (Object.prototype.hasOwnProperty.call(nextInstanceConfigs, key)) {
          delete nextInstanceConfigs[key];
          changed = true;
        }
      }
      if (changed) {
        appStore.set('instanceConfigs', nextInstanceConfigs);
      }
    }
  }

  if (instance.type === 'server' && typeof instance.path === 'string' && instance.path.trim()) {
    const retentionKey = `retentionSettings_${Buffer.from(instance.path.trim()).toString('base64')}`;
    appStore.delete(retentionKey);
  }
}

async function cleanupServerInstanceRuntime(instance, reason = 'instance_removed') {
  if (!instance || instance.type !== 'server') {
    return {
      success: true,
      skipped: true
    };
  }

  logger.info('Stopping server runtime for removed instance', {
    category: 'settings',
    data: {
      operation: 'cleanup_server_instance_runtime',
      reason,
      instanceId: instance.id,
      instancePath: instance.path,
      instanceName: instance.name
    }
  });

  const selector = {
    instanceId: instance.id || null,
    targetPath: instance.path || null,
    serverPath: instance.path || null
  };

  const managementResult = await stopAndDisposeManagementServers({
    instanceId: selector.instanceId,
    serverPath: selector.serverPath
  });

  const serverResult = await shutdownMinecraftServer({
    instanceId: selector.instanceId,
    targetPath: selector.targetPath
  }, {
    disposeStateAfterStop: true
  });

  const success = !!(managementResult.success && serverResult.success);

  logger.info(success ? 'Removed instance runtime stopped successfully' : 'Removed instance runtime cleanup failed', {
    category: 'settings',
    data: {
      operation: 'cleanup_server_instance_runtime_result',
      reason,
      instanceId: instance.id,
      instancePath: instance.path,
      success,
      managementResult,
      serverResult
    }
  });

  return {
    success,
    managementResult,
    serverResult
  };
}

function findServerInstanceById(instanceId) {
  if (!instanceId || typeof instanceId !== 'string') {
    return null;
  }

  const instances = appStore.get('instances') || [];
  return instances.find((instance) => instance && instance.type === 'server' && instance.id === instanceId) || null;
}

function getPreferredStoredServerPath() {
  const instances = appStore.get('instances') || [];
  const serverInstances = instances.filter((instance) => instance && instance.type === 'server' && typeof instance.path === 'string' && instance.path.trim());
  if (serverInstances.length === 0) {
    return appStore.get('lastServerPath') || '';
  }

  const lastServerPath = appStore.get('lastServerPath') || '';
  const matchedInstance = serverInstances.find((instance) => instance.path === lastServerPath);
  const preferredPath = matchedInstance?.path || serverInstances[0].path;

  if (preferredPath && preferredPath !== lastServerPath) {
    appStore.set('lastServerPath', preferredPath);
  }

  return preferredPath;
}

function resolveServerPathFromPayload(payload = {}) {
  const instanceId = typeof payload.instanceId === 'string' ? payload.instanceId.trim() : '';
  const serverPath = typeof payload.serverPath === 'string' ? payload.serverPath.trim() : '';

  if (serverPath) {
    return serverPath;
  }

  if (instanceId) {
    const matchedInstance = findServerInstanceById(instanceId);
    if (matchedInstance?.path) {
      return matchedInstance.path;
    }
  }

  return getPreferredStoredServerPath();
}

/**
 * Create settings IPC handlers
 */
function createSettingsHandlers() {
  logger.info('Settings handlers initialized', {
    category: 'settings',
    data: { handler: 'createSettingsHandlers' }
  });

  return {
    'update-settings': async (_e, payload = {}) => {
      const startTime = Date.now();
      const {
        port,
        maxRam,
        managementPort,
        serverPath,
        instanceId,
        autoStartMinecraft,
        autoStartManagement
      } = payload;

      const coerceNumber = (value) => {
        if (value === null || value === undefined) return value;
        if (typeof value === 'number') return value;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (!trimmed) return NaN;
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) ? parsed : NaN;
        }
        return NaN;
      };

      const normalizedPort = coerceNumber(port);
      const normalizedMaxRam = coerceNumber(maxRam);
      const normalizedManagementPort = coerceNumber(managementPort);
      
      logger.debug('IPC handler invoked', {
        category: 'settings',
        data: {
          handler: 'update-settings',
          sender: _e.sender.id,
          parameters: {
            port: port !== undefined,
            maxRam: maxRam !== undefined,
            managementPort: managementPort !== undefined,
            serverPath: serverPath !== undefined,
            instanceId: instanceId !== undefined,
            autoStartMinecraft: autoStartMinecraft !== undefined,
            autoStartManagement: autoStartManagement !== undefined
          }
        }
      });

      try {
        // Validate parameters
        logger.debug('Starting settings validation', {
          category: 'settings',
          data: {
            handler: 'update-settings',
            operation: 'validation',
            fieldsToValidate: {
              port: port !== undefined,
              maxRam: maxRam !== undefined,
              managementPort: managementPort !== undefined,
              serverPath: serverPath !== undefined,
              instanceId: instanceId !== undefined
            }
          }
        });

        if (port !== undefined && (typeof normalizedPort !== 'number' || !Number.isFinite(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535)) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              validation: 'port',
              value: port,
              type: typeof port,
              valid: false,
              validRange: '1-65535',
              errorReason: typeof normalizedPort !== 'number' || !Number.isFinite(normalizedPort) ? 'invalid_type' : 'out_of_range'
            }
          });
          return { success: false, error: 'Invalid port number' };
        }
        
        if (maxRam !== undefined && (typeof normalizedMaxRam !== 'number' || !Number.isFinite(normalizedMaxRam) || normalizedMaxRam <= 0)) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              validation: 'maxRam',
              value: maxRam,
              type: typeof maxRam,
              valid: false,
              validRange: '>0',
              errorReason: typeof normalizedMaxRam !== 'number' || !Number.isFinite(normalizedMaxRam) ? 'invalid_type' : 'invalid_value'
            }
          });
          return { success: false, error: 'Invalid memory allocation' };
        }
        
        if (managementPort !== undefined && (typeof normalizedManagementPort !== 'number' || !Number.isFinite(normalizedManagementPort) || normalizedManagementPort < 1025 || normalizedManagementPort > 65535)) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              validation: 'managementPort',
              value: managementPort,
              type: typeof managementPort,
              valid: false,
              validRange: '1025-65535',
              errorReason: typeof normalizedManagementPort !== 'number' || !Number.isFinite(normalizedManagementPort) ? 'invalid_type' : 'out_of_range'
            }
          });
          return { success: false, error: 'Invalid management port number' };
        }

        if (serverPath !== undefined && (typeof serverPath !== 'string' || serverPath.trim() === '')) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              validation: 'serverPath',
              value: serverPath,
              type: typeof serverPath,
              valid: false,
              errorReason: typeof serverPath !== 'string' ? 'invalid_type' : 'empty_string'
            }
          });
          return { success: false, error: 'Invalid server path' };
        }

        logger.debug('Settings validation passed', {
          category: 'settings',
          data: {
            handler: 'update-settings',
            validatedFields: {
              port: port !== undefined ? 'valid' : 'not_provided',
              maxRam: maxRam !== undefined ? 'valid' : 'not_provided',
              managementPort: managementPort !== undefined ? 'valid' : 'not_provided'
            }
          }
        });
        
        // Get current settings to merge with updates
        logger.debug('Reading configuration file', {
          category: 'settings',
          data: {
            handler: 'update-settings',
            operation: 'config_read',
            source: 'app_store'
          }
        });

        const resolvedServerPath = resolveServerPathFromPayload({ instanceId, serverPath });
        const currentSettings = getMergedServerSettings(resolvedServerPath);
        const configFilePath = resolvedServerPath
          ? path.join(resolvedServerPath, '.minecraft-core.json')
          : null;
        const isDefaultConfig = !configFilePath || !fs.existsSync(configFilePath);
        
        if (isDefaultConfig) {
          logger.info('Default configuration applied', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              operation: 'default_config',
              defaults: {
                port: 25565,
                maxRam: 4,
                managementPort: 8080,
                autoStartMinecraft: false,
                autoStartManagement: false
              }
            }
          });
        }

        logger.debug('Current settings retrieved', {
          category: 'settings',
          data: {
            handler: 'update-settings',
            currentSettings: {
              port: currentSettings.port,
              maxRam: currentSettings.maxRam,
              managementPort: currentSettings.managementPort,
              autoStartMinecraft: currentSettings.autoStartMinecraft,
              autoStartManagement: currentSettings.autoStartManagement
            },
            isDefault: isDefaultConfig
          }
        });
        
        // Update settings with new values
        const updatedSettings = {
          ...currentSettings,
          port: port !== undefined ? normalizedPort : currentSettings.port,
          maxRam: maxRam !== undefined ? normalizedMaxRam : currentSettings.maxRam,
          managementPort: managementPort !== undefined ? normalizedManagementPort : currentSettings.managementPort,
          autoStartMinecraft: autoStartMinecraft !== undefined ? autoStartMinecraft : currentSettings.autoStartMinecraft,
          autoStartManagement: autoStartManagement !== undefined ? autoStartManagement : currentSettings.autoStartManagement
        };

        if (resolvedServerPath && (port !== undefined || managementPort !== undefined)) {
          const portValidation = await validateServerPorts({
            instanceId,
            serverPath: resolvedServerPath,
            minecraftPort: updatedSettings.port,
            managementPort: updatedSettings.managementPort
          });

          if (!portValidation.valid) {
            return {
              success: false,
              error: portValidation.errors[0]?.message || 'Port conflict detected',
              details: portValidation.errors
            };
          }
        }

        // Log settings changes with before/after values
        const changes = {};
        if (port !== undefined && port !== currentSettings.port) {
          changes.port = { before: currentSettings.port, after: port };
        }
        if (maxRam !== undefined && maxRam !== currentSettings.maxRam) {
          changes.maxRam = { before: currentSettings.maxRam, after: maxRam };
        }
        if (managementPort !== undefined && managementPort !== currentSettings.managementPort) {
          changes.managementPort = { before: currentSettings.managementPort, after: managementPort };
        }
        if (autoStartMinecraft !== undefined && autoStartMinecraft !== currentSettings.autoStartMinecraft) {
          changes.autoStartMinecraft = { before: currentSettings.autoStartMinecraft, after: autoStartMinecraft };
        }
        if (autoStartManagement !== undefined && autoStartManagement !== currentSettings.autoStartManagement) {
          changes.autoStartManagement = { before: currentSettings.autoStartManagement, after: autoStartManagement };
        }

        if (Object.keys(changes).length > 0) {
          logger.info('Settings changes detected', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              changes,
              changedFields: Object.keys(changes)
            }
          });
        } else {
          logger.debug('No settings changes detected', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              message: 'All provided values match current settings'
            }
          });
        }
        
        logger.debug('Skipping legacy global server settings persistence', {
          category: 'settings',
          data: {
            handler: 'update-settings',
            operation: 'persistence_skip',
            reason: 'server_settings_are_instance_local'
          }
        });
        
        // If serverPath is provided, update the lastServerPath
        if (resolvedServerPath) {
          try {
            const previousPath = appStore.get('lastServerPath');
            
            logger.debug('Updating server path configuration', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_path_update_start',
                previousPath,
                newPath: resolvedServerPath
              }
            });

            appStore.set('lastServerPath', resolvedServerPath);
            
            logger.info('Server path configuration updated', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_path_update_success',
                changes: {
                  lastServerPath: {
                    before: previousPath,
                    after: resolvedServerPath
                  }
                },
                pathChanged: previousPath !== resolvedServerPath
              }
            });
          } catch (pathError) {
            logger.error('Server path configuration update failed', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_path_update_failure',
                serverPath: resolvedServerPath,
                error: pathError.message,
                errorType: pathError.constructor.name,
                stack: pathError.stack,
                recovery: 'continuing_without_path_update'
              }
            });
            // Don't throw here, as main settings were saved successfully
          }
        }
        
        // Also update the server's config file if we have a path
        const usePath = resolvedServerPath || appStore.get('lastServerPath');
        if (usePath) {
          try {
            logger.debug('Updating server configuration file', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_config_file_update',
                configPath: path.join(usePath, '.minecraft-core.json'),
                serverPath: usePath
              }
            });
            const previousConfig = readServerConfig(usePath, getServerConfigDefaults(usePath)) || {};
            const config = updateServerConfig(usePath, {
              ...previousConfig,
              port: updatedSettings.port,
              maxRam: updatedSettings.maxRam,
              managementPort: updatedSettings.managementPort,
              autoStartMinecraft: !!updatedSettings.autoStartMinecraft,
              autoStartManagement: !!updatedSettings.autoStartManagement
            }, getServerConfigDefaults(usePath));

            logger.info('Server configuration file updated', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_config_file_success',
                configPath: path.join(usePath, '.minecraft-core.json'),
                changes: {
                  port: { before: previousConfig.port, after: config.port },
                  maxRam: { before: previousConfig.maxRam, after: config.maxRam },
                  managementPort: { before: previousConfig.managementPort, after: config.managementPort },
                  autoStartMinecraft: { before: previousConfig.autoStartMinecraft, after: config.autoStartMinecraft },
                  autoStartManagement: { before: previousConfig.autoStartManagement, after: config.autoStartManagement }
                }
              }
            });
          } catch (configError) {
            logger.error('Server configuration file update failed', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_config_file_failure',
                configPath: path.join(usePath, '.minecraft-core.json'),
                error: configError.message,
                errorType: configError.constructor.name,
                stack: configError.stack,
                recovery: 'continuing_without_file_update'
              }
            });
            // Don't throw here, as main settings were saved successfully
          }
        }
        
        const storedInstances = appStore.get('instances') || [];
        const hydratedInstances = storedInstances.map((instance) => {
          if (instance.type === 'server' && instance.path) {
            const config = readServerConfig(instance.path, getServerConfigDefaults(instance.path));
            let packedSecret = config && config.managementInviteSecret
              ? getPackedInviteSecretFromFolder(instance.path)
              : '';

            if ((!config || !config.managementInviteSecret) && instance.managementInviteSecret) {
              try {
                ensureEncryptionAvailable();
                const plainSecret = unpackSecret(instance.managementInviteSecret);
                if (plainSecret) {
                  const updatedConfig = updateServerConfig(instance.path, {
                    ...(config || {}),
                    managementInviteSecret: plainSecret,
                    managementInviteHost: typeof config?.managementInviteHost === 'string' && config.managementInviteHost
                      ? config.managementInviteHost
                      : (typeof instance.managementInviteHost === 'string' ? instance.managementInviteHost : '')
                  }, getServerConfigDefaults(instance.path));
                  packedSecret = updatedConfig && updatedConfig.managementInviteSecret
                    ? getPackedInviteSecretFromFolder(instance.path)
                    : packedSecret;
                }
              } catch {
                packedSecret = '';
              }
            }

            return {
              ...instance,
              ...(config && typeof config.managementInviteHost === 'string'
                ? { managementInviteHost: config.managementInviteHost }
                : {}),
              ...(packedSecret ? { managementInviteSecret: packedSecret } : {})
            };
          }

          if (instance.type === 'client' && instance.path) {
            const clientConfig = readClientConfig(instance.path);
            if (clientConfig) {
              return {
                ...instance,
                id: clientConfig.clientId || instance.id,
                name: clientConfig.clientName || instance.name,
                serverIp: clientConfig.serverIp,
                serverPort: clientConfig.serverPort,
                serverProtocol: clientConfig.serverProtocol || instance.serverProtocol,
                clientId: clientConfig.clientId,
                clientName: clientConfig.clientName,
                sessionToken: clientConfig.sessionToken || instance.sessionToken,
                inviteSecret: clientConfig.inviteSecret || instance.inviteSecret,
                managementCertFingerprint: clientConfig.managementCertFingerprint || instance.managementCertFingerprint,
                lastConnected: clientConfig.lastConnected || instance.lastConnected
              };
            }
          }

          return instance;
        });

        if (JSON.stringify(hydratedInstances) !== JSON.stringify(storedInstances)) {
          appStore.set('instances', hydratedInstances);
          instanceContext.updateInstances(hydratedInstances);
        }

        const duration = Date.now() - startTime;
        
        logger.info('Settings update completed successfully', {
          category: 'settings',
          data: {
            handler: 'update-settings',
            operation: 'complete_success',
            duration,
            changedFields: Object.keys(changes),
            totalFields: Object.keys(updatedSettings).length
          }
        });

        return { 
          success: true, 
          settings: {
            ...updatedSettings,
            serverPath: resolvedServerPath || appStore.get('lastServerPath')
          }
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        
        logger.error('Settings update operation failed', {
          category: 'settings',
          data: {
            handler: 'update-settings',
            operation: 'complete_failure',
            duration,
            error: err.message,
            errorType: err.constructor.name,
            stack: err.stack
          }
        });
        
        return { success: false, error: err.message };
      }
    },
    
    'get-settings': async (_e, payload = {}) => {
      const startTime = Date.now();
      
      logger.debug('IPC handler invoked', {
        category: 'settings',
        data: {
          handler: 'get-settings',
          sender: _e?.sender?.id || 'unknown'
        }
      });

      try {
        logger.debug('Reading configuration file', {
          category: 'settings',
          data: {
            handler: 'get-settings',
            operation: 'config_read',
            source: 'app_store'
          }
        });

        const serverPath = resolveServerPathFromPayload(payload);
        const settings = getMergedServerSettings(serverPath);
        const configFilePath = serverPath
          ? path.join(serverPath, '.minecraft-core.json')
          : null;
        const isDefaultConfig = !configFilePath || !fs.existsSync(configFilePath);
        
        if (isDefaultConfig) {
          logger.debug('Default configuration applied', {
            category: 'settings',
            data: {
              handler: 'get-settings',
              operation: 'default_config',
              defaults: {
                port: 25565,
                maxRam: 4,
                managementPort: 8080,
                autoStartMinecraft: false,
                autoStartManagement: false
              }
            }
          });
        }

        const duration = Date.now() - startTime;
        
        logger.debug('Settings retrieval completed', {
          category: 'settings',
          data: {
            handler: 'get-settings',
            operation: 'complete_success',
            duration,
            settingsKeys: Object.keys(settings),
            hasServerPath: !!serverPath,
            isDefault: isDefaultConfig
          }
        });
        
        return {
          success: true,
          settings: {
            ...settings,
            serverPath
          }
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        
        logger.error('Settings retrieval failed', {
          category: 'settings',
          data: {
            handler: 'get-settings',
            operation: 'complete_failure',
            duration,
            error: err.message,
            errorType: err.constructor.name,
            stack: err.stack
          }
        });
        
        return { success: false, error: err.message };
      }
    },
    
    'save-instances': async (_e, instances) => {
      const startTime = Date.now();
      
      logger.debug('IPC handler invoked', {
        category: 'settings',
        data: {
          handler: 'save-instances',
          sender: _e.sender.id,
          instanceCount: Array.isArray(instances) ? instances.length : 'invalid'
        }
      });

      try {
        if (!Array.isArray(instances)) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'save-instances',
              validation: 'instances_array',
              value: typeof instances,
              valid: false,
              errorReason: 'not_array'
            }
          });
          return { success: false, error: 'Invalid instances data: not an array' };
        }
        
        logger.debug('Starting instances validation', {
          category: 'settings',
          data: {
            handler: 'save-instances',
            operation: 'validation',
            inputInstanceCount: instances.length
          }
        });

        const currentInstances = appStore.get('instances') || [];

        // Filter out invalid instances and ensure required fields
        const validInstances = instances
          .filter(instance => {
            if (!instance || typeof instance !== 'object') {
              logger.warn('Invalid instance filtered out', {
                category: 'settings',
                data: {
                  handler: 'save-instances',
                  validation: 'instance_object',
                  instanceType: typeof instance,
                  valid: false,
                  reason: 'not_object'
                }
              });
              return false;
            }
            if (!instance.id || !instance.type) {
              logger.warn('Invalid instance filtered out', {
                category: 'settings',
                data: {
                  handler: 'save-instances',
                  validation: 'required_fields',
                  hasId: !!instance.id,
                  hasType: !!instance.type,
                  valid: false,
                  reason: 'missing_required_fields'
                }
              });
              return false;
            }
            if (instance.type === 'server' && !instance.path) {
              logger.warn('Invalid server instance filtered out', {
                category: 'settings',
                data: {
                  handler: 'save-instances',
                  validation: 'server_path',
                  instanceId: instance.id,
                  instanceType: instance.type,
                  hasPath: !!instance.path,
                  valid: false,
                  reason: 'server_missing_path'
                }
              });
              return false;
            }
            return true;
          })
          .map(instance => {
            const existingInstance = currentInstances.find(existing =>
              existing && (
                (existing.id === instance.id && existing.type === instance.type)
                || (instance.path && existing.type === instance.type && existing.path === instance.path)
              )
            );
            const folderServerConfig = instance.type === 'server' && instance.path
              ? readServerConfig(instance.path, getServerConfigDefaults(instance.path))
              : null;
            const folderClientConfig = instance.type === 'client' && instance.path
              ? readClientConfig(instance.path)
              : null;
            const validInstance = {
              id: folderClientConfig?.clientId || instance.id || existingInstance?.id || `instance-${Date.now()}`,
              name: folderClientConfig?.clientName || instance.name || existingInstance?.name || `Instance ${Date.now()}`,
              type: instance.type || 'server'
            };
            
            // Include type-specific fields
            if (instance.type === 'server') {
              if (instance.path) {
                validInstance.path = instance.path;
              }

              let migratedSecret = '';
              if ((!folderServerConfig || !folderServerConfig.managementInviteSecret) && existingInstance?.managementInviteSecret && instance.path) {
                try {
                  ensureEncryptionAvailable();
                  migratedSecret = unpackSecret(existingInstance.managementInviteSecret);
                  if (migratedSecret) {
                    updateServerConfig(instance.path, {
                      ...(folderServerConfig || {}),
                      managementInviteSecret: migratedSecret,
                      managementInviteHost: typeof folderServerConfig?.managementInviteHost === 'string' && folderServerConfig.managementInviteHost
                        ? folderServerConfig.managementInviteHost
                        : (typeof existingInstance.managementInviteHost === 'string' ? existingInstance.managementInviteHost : '')
                    }, getServerConfigDefaults(instance.path));
                  }
                } catch {
                  migratedSecret = '';
                }
              }

              const packedFolderSecret = instance.path ? getPackedInviteSecretFromFolder(instance.path) : '';
              if (packedFolderSecret) {
                validInstance.managementInviteSecret = packedFolderSecret;
              } else if (existingInstance && existingInstance.managementInviteSecret) {
                validInstance.managementInviteSecret = existingInstance.managementInviteSecret;
              }

              const folderInviteHost = typeof folderServerConfig?.managementInviteHost === 'string'
                ? folderServerConfig.managementInviteHost
                : '';
              if (folderInviteHost) {
                validInstance.managementInviteHost = folderInviteHost;
              } else if (typeof instance.managementInviteHost === 'string') {
                validInstance.managementInviteHost = instance.managementInviteHost;
                if (instance.path) {
                  updateServerConfig(instance.path, {
                    ...(folderServerConfig || {}),
                    managementInviteHost: instance.managementInviteHost
                  }, getServerConfigDefaults(instance.path));
                }
              } else if (existingInstance && typeof existingInstance.managementInviteHost === 'string') {
                validInstance.managementInviteHost = existingInstance.managementInviteHost;
              }
            } else if (instance.type === 'client') {
              // Include client-specific fields
              if (instance.path) validInstance.path = instance.path;
              validInstance.id = folderClientConfig?.clientId || instance.clientId || instance.id || existingInstance?.clientId || validInstance.id;
              validInstance.name = folderClientConfig?.clientName || instance.clientName || instance.name || existingInstance?.clientName || validInstance.name;
              validInstance.clientId = folderClientConfig?.clientId || instance.clientId || existingInstance?.clientId || validInstance.id;
              validInstance.clientName = folderClientConfig?.clientName || instance.clientName || existingInstance?.clientName || validInstance.name;
              if (folderClientConfig?.serverIp || instance.serverIp) validInstance.serverIp = folderClientConfig?.serverIp || instance.serverIp;
              if (folderClientConfig?.serverPort || instance.serverPort) validInstance.serverPort = folderClientConfig?.serverPort || instance.serverPort;
              if (folderClientConfig?.serverProtocol || instance.serverProtocol) validInstance.serverProtocol = folderClientConfig?.serverProtocol || instance.serverProtocol;
              if (folderClientConfig?.sessionToken || instance.sessionToken) validInstance.sessionToken = folderClientConfig?.sessionToken || instance.sessionToken;
              if (folderClientConfig?.inviteSecret || instance.inviteSecret) validInstance.inviteSecret = folderClientConfig?.inviteSecret || instance.inviteSecret;
              if (folderClientConfig?.managementCertFingerprint || instance.managementCertFingerprint) {
                validInstance.managementCertFingerprint = folderClientConfig?.managementCertFingerprint || instance.managementCertFingerprint;
              }
              if (folderClientConfig?.lastConnected || instance.lastConnected) validInstance.lastConnected = folderClientConfig?.lastConnected || instance.lastConnected;
              if (existingInstance && existingInstance.inviteSecret && !validInstance.inviteSecret) {
                validInstance.inviteSecret = existingInstance.inviteSecret;
              }
              if (existingInstance && existingInstance.serverProtocol && !validInstance.serverProtocol) {
                validInstance.serverProtocol = existingInstance.serverProtocol;
              }
              if (existingInstance && existingInstance.managementCertFingerprint && !validInstance.managementCertFingerprint) {
                validInstance.managementCertFingerprint = existingInstance.managementCertFingerprint;
              }
            }
            
            return validInstance;
          });
        
        logger.debug('Instances validation completed', {
          category: 'settings',
          data: {
            handler: 'save-instances',
            operation: 'validation_complete',
            inputCount: instances.length,
            validCount: validInstances.length,
            filteredCount: instances.length - validInstances.length
          }
        });
        
        if (validInstances.length === 0 && instances.length > 0) {
          const error = 'All instances were filtered out due to invalid data';
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'save-instances',
              validation: 'all_instances_invalid',
              inputCount: instances.length,
              validCount: 0,
              valid: false,
              errorReason: 'all_filtered_out'
            }
          });
          return { success: false, error };
        }
        
        try {
          logger.debug('Starting instances persistence operation', {
            category: 'settings',
            data: {
              handler: 'save-instances',
              operation: 'persistence_start',
              instanceCount: validInstances.length
            }
          });

          const removedServerInstances = getRemovedServerInstances(currentInstances, validInstances);
          for (const removedInstance of removedServerInstances) {
            const cleanupResult = await cleanupServerInstanceRuntime(removedInstance, 'save_instances_removed');
            if (!cleanupResult.success) {
              return {
                success: false,
                error: `Failed to stop deleted instance runtime for "${removedInstance.name || removedInstance.id}".`
              };
            }
          }

          // Save instances to the store
          appStore.set('instances', validInstances);
          
          // Update instance context with the new instances
          instanceContext.updateInstances(validInstances);
          
          logger.debug('Instance context updated with saved instances', {
            category: 'settings',
            data: {
              handler: 'save-instances',
              operation: 'instance_context_update',
              instanceCount: validInstances.length,
              instances: validInstances.map(i => ({ name: i.name, type: i.type, path: i.path }))
            }
          });
          
          // Update lastServerPath if there's a server instance
          const serverInstance = validInstances.find(i => i.type === 'server' && i.path);
          const previousServerPath = appStore.get('lastServerPath');
          
          if (serverInstance && serverInstance.path) {
            appStore.set('lastServerPath', serverInstance.path);
            
            if (previousServerPath !== serverInstance.path) {
              logger.info('Server path configuration updated', {
                category: 'settings',
                data: {
                  handler: 'save-instances',
                  operation: 'server_path_update',
                  changes: {
                    lastServerPath: {
                      before: previousServerPath,
                      after: serverInstance.path
                    }
                  }
                }
              });
            }
          }
          
          // Force a write to disk
          appStore.set('__last_updated__', Date.now());
          
          // Verify the save
          const savedInstances = appStore.get('instances') || [];
          
          if (!Array.isArray(savedInstances)) {
            const error = 'Saved instances is not an array';
            logger.error('Settings persistence verification failed', {
              category: 'settings',
              data: {
                handler: 'save-instances',
                operation: 'persistence_verification_failure',
                error,
                savedType: typeof savedInstances,
                recovery: 'returning_error'
              }
            });
            return { success: false, error };
          }

          const duration = Date.now() - startTime;
          
          logger.info('Instances persistence completed successfully', {
            category: 'settings',
            data: {
              handler: 'save-instances',
              operation: 'persistence_success',
              duration,
              changes: {
                instanceCount: {
                  before: currentInstances.length,
                  after: savedInstances.length
                }
              },
              savedInstanceCount: savedInstances.length
            }
          });
          
          return { success: true, instances: savedInstances };
          
        } catch (err) {
          const duration = Date.now() - startTime;
          
          logger.error('Instances persistence failed', {
            category: 'settings',
            data: {
              handler: 'save-instances',
              operation: 'persistence_failure',
              duration,
              error: err.message,
              errorType: err.constructor.name,
              stack: err.stack,
              instanceCount: validInstances.length
            }
          });
          
          return { 
            success: false, 
            error: `Failed to save instances: ${err.message}` 
          };
        }
      } catch (err) {
        const duration = Date.now() - startTime;
        
        logger.error('Save instances operation failed', {
          category: 'settings',
          data: {
            handler: 'save-instances',
            operation: 'complete_failure',
            duration,
            error: err.message,
            errorType: err.constructor.name,
            stack: err.stack
          }
        });
        
        return { success: false, error: err.message };
      }
    },
    
    'get-instances': async (_e) => {
      const startTime = Date.now();
      
      logger.debug('IPC handler invoked', {
        category: 'settings',
        data: {
          handler: 'get-instances',
          sender: _e?.sender?.id || 'unknown'
        }
      });

      try {
        logger.debug('Reading configuration file', {
          category: 'settings',
          data: {
            handler: 'get-instances',
            operation: 'config_read',
            source: 'app_store'
          }
        });

        const instances = appStore.get('instances') || [];
        const validInstances = instances.filter(instance => {
          const isValid = instance && 
            typeof instance === 'object' && 
            instance.id && 
            instance.name && 
            instance.type;
          
          if (!isValid) {
            logger.warn('Invalid instance filtered during retrieval', {
              category: 'settings',
              data: {
                handler: 'get-instances',
                validation: 'instance_validity',
                instanceId: instance?.id || 'unknown',
                hasId: !!instance?.id,
                hasName: !!instance?.name,
                hasType: !!instance?.type,
                valid: false
              }
            });
          }
          
          return isValid;
        });

        const hydratedInstances = validInstances.map((instance) => {
          const existingInstance = instances.find((existing) =>
            existing && (
              (existing.id === instance.id && existing.type === instance.type)
              || (instance.path && existing.type === instance.type && existing.path === instance.path)
            )
          );

          if (instance.type === 'server' && instance.path) {
            const config = readServerConfig(instance.path, getServerConfigDefaults(instance.path));
            let packedSecret = config && config.managementInviteSecret
              ? getPackedInviteSecretFromFolder(instance.path)
              : '';

            if ((!config || !config.managementInviteSecret) && instance.managementInviteSecret) {
              try {
                ensureEncryptionAvailable();
                const plainSecret = unpackSecret(instance.managementInviteSecret);
                if (plainSecret) {
                  const updatedConfig = updateServerConfig(instance.path, {
                    ...(config || {}),
                    managementInviteSecret: plainSecret,
                    managementInviteHost: typeof config?.managementInviteHost === 'string' && config.managementInviteHost
                      ? config.managementInviteHost
                      : (typeof instance.managementInviteHost === 'string' ? instance.managementInviteHost : '')
                  }, getServerConfigDefaults(instance.path));
                  packedSecret = updatedConfig && updatedConfig.managementInviteSecret
                    ? getPackedInviteSecretFromFolder(instance.path)
                    : packedSecret;
                }
              } catch {
                packedSecret = '';
              }
            }

            return {
              ...instance,
              ...(config && typeof config.managementInviteHost === 'string'
                ? { managementInviteHost: config.managementInviteHost }
                : {}),
              ...(packedSecret
                ? { managementInviteSecret: packedSecret }
                : (existingInstance?.managementInviteSecret ? { managementInviteSecret: existingInstance.managementInviteSecret } : {}))
            };
          }

          if (instance.type === 'client' && instance.path) {
            const clientConfig = readClientConfig(instance.path);
            if (clientConfig) {
              return {
                ...instance,
                id: clientConfig.clientId || instance.id,
                name: clientConfig.clientName || instance.name,
                serverIp: clientConfig.serverIp,
                serverPort: clientConfig.serverPort,
                serverProtocol: clientConfig.serverProtocol || instance.serverProtocol,
                clientId: clientConfig.clientId,
                clientName: clientConfig.clientName,
                sessionToken: clientConfig.sessionToken || instance.sessionToken,
                inviteSecret: clientConfig.inviteSecret || instance.inviteSecret,
                managementCertFingerprint: clientConfig.managementCertFingerprint || instance.managementCertFingerprint,
                lastConnected: clientConfig.lastConnected || instance.lastConnected
              };
            }
          }

          return instance;
        });

        if (JSON.stringify(hydratedInstances) !== JSON.stringify(validInstances)) {
          appStore.set('instances', hydratedInstances);
        }

        instanceContext.updateInstances(hydratedInstances);

        const serverInstance = hydratedInstances.find((instance) => instance && instance.type === 'server' && instance.path);
        if (serverInstance && serverInstance.path) {
          appStore.set('lastServerPath', serverInstance.path);
        }

        const duration = Date.now() - startTime;
        
        logger.debug('Instances retrieval completed', {
          category: 'settings',
          data: {
            handler: 'get-instances',
            operation: 'complete_success',
            duration,
            totalInstances: instances.length,
            validInstances: hydratedInstances.length,
            filteredCount: instances.length - validInstances.length
          }
        });
        
        return hydratedInstances;
      } catch (err) {
        const duration = Date.now() - startTime;
        
        logger.error('Instances retrieval failed', {
          category: 'settings',
          data: {
            handler: 'get-instances',
            operation: 'complete_failure',
            duration,
            error: err.message,
            errorType: err.constructor.name,
            stack: err.stack,
            recovery: 'returning_empty_array'
          }
        });
        
        return [];
      }
    },

    // Update visibility map for browser panel (App Settings scope)
    'set-instance-visibility': async (_e, visibilityMap) => {
      try {
        const appSettings = appStore.get('appSettings') || {};
        const current = appSettings.browserPanel || {};
        const sanitized = (visibilityMap && typeof visibilityMap === 'object') ? visibilityMap : {};
        appStore.set('appSettings', {
          ...appSettings,
          browserPanel: { ...current, instanceVisibility: sanitized }
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    
    // Rename instance
    'rename-instance': async (_e, { id, newName }) => {
      const startTime = Date.now();
      
      logger.debug('IPC handler invoked', {
        category: 'settings',
        data: {
          handler: 'rename-instance',
          sender: _e.sender.id,
          instanceId: id,
          newName: typeof newName === 'string' ? newName.substring(0, 50) : newName
        }
      });

      try {
        // Validate parameters
        if (!id || typeof newName !== 'string' || newName.trim() === '') {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'rename-instance',
              validation: 'parameters',
              hasId: !!id,
              newNameType: typeof newName,
              newNameEmpty: typeof newName === 'string' ? newName.trim() === '' : true,
              valid: false,
              errorReason: !id ? 'missing_id' : 'invalid_name'
            }
          });
          return { success: false, error: 'Invalid parameters' };
        }
        
        logger.debug('Reading configuration file', {
          category: 'settings',
          data: {
            handler: 'rename-instance',
            operation: 'config_read',
            source: 'app_store'
          }
        });

        const instances = appStore.get('instances') || [];
        const idx = instances.findIndex(i => i.id === id);
        
        if (idx === -1) {
          logger.error('Instance not found for rename operation', {
            category: 'settings',
            data: {
              handler: 'rename-instance',
              instanceId: id,
              totalInstances: instances.length,
              valid: false,
              errorReason: 'instance_not_found'
            }
          });
          return { success: false, error: 'Instance not found' };
        }

        const oldName = instances[idx].name;
        const instanceToRename = instances[idx];
        const isClientInstance = instanceToRename?.type === 'client';
        instances[idx].name = newName;
        if (isClientInstance) {
          instances[idx].clientName = newName;
        }

        logger.debug('Starting instance rename persistence', {
          category: 'settings',
          data: {
            handler: 'rename-instance',
            operation: 'persistence_start',
            instanceId: id,
            changes: {
              name: {
                before: oldName,
                after: newName
              }
            }
          }
        });
        
        if (isClientInstance && instanceToRename?.path) {
          const clientConfigPath = path.join(instanceToRename.path, 'client-config.json');
          let existingClientConfig = {};
          try {
            const folderClientConfig = readClientConfig(instanceToRename.path);
            if (folderClientConfig && typeof folderClientConfig === 'object') {
              existingClientConfig = { ...folderClientConfig };
            } else if (fs.existsSync(clientConfigPath)) {
              existingClientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
            }
          } catch {
            existingClientConfig = {};
          }

          const nextClientConfig = {
            ...existingClientConfig,
            clientId: existingClientConfig.clientId || instanceToRename.clientId || instanceToRename.id,
            clientName: newName
          };

          await fsPromises.writeFile(clientConfigPath, JSON.stringify(nextClientConfig, null, 2));
        }

        appStore.set('instances', instances);

        const duration = Date.now() - startTime;
        
        logger.info('Instance rename completed successfully', {
          category: 'settings',
          data: {
            handler: 'rename-instance',
            operation: 'complete_success',
            duration,
            instanceId: id,
            changes: {
              name: {
                before: oldName,
                after: newName
              }
            }
          }
        });
        
        return { success: true, instances };
      } catch (err) {
        const duration = Date.now() - startTime;
        
        logger.error('Instance rename operation failed', {
          category: 'settings',
          data: {
            handler: 'rename-instance',
            operation: 'complete_failure',
            duration,
            instanceId: id,
            error: err.message,
            errorType: err.constructor.name,
            stack: err.stack
          }
        });
        
        return { success: false, error: err.message };
      }
    },
    
    // Delete instance (with optional dir deletion)
    'delete-instance': async (_e, { id, deleteFiles }) => {
      const startTime = Date.now();
      
      logger.debug('IPC handler invoked', {
        category: 'settings',
        data: {
          handler: 'delete-instance',
          sender: _e.sender.id,
          instanceId: id,
          deleteFiles: !!deleteFiles
        }
      });

      try {
        if (!id) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'delete-instance',
              validation: 'instance_id',
              hasId: !!id,
              valid: false,
              errorReason: 'missing_id'
            }
          });
          return { success: false, error: 'Invalid instance ID' };
        }
        
        logger.debug('Reading configuration file', {
          category: 'settings',
          data: {
            handler: 'delete-instance',
            operation: 'config_read',
            source: 'app_store'
          }
        });

        const instances = appStore.get('instances') || [];
        const inst = instances.find(i => i.id === id);
        
        if (!inst) {
          logger.error('Instance not found for deletion', {
            category: 'settings',
            data: {
              handler: 'delete-instance',
              instanceId: id,
              totalInstances: instances.length,
              valid: false,
              errorReason: 'instance_not_found'
            }
          });
          return { success: false, error: 'Instance not found' };
        }

        logger.info('Starting instance deletion process', {
          category: 'settings',
          data: {
            handler: 'delete-instance',
            operation: 'deletion_start',
            instanceId: id,
            instanceName: inst.name,
            instanceType: inst.type,
            instancePath: inst.path,
            deleteFiles
          }
        });

        if (inst.type === 'server') {
          const cleanupResult = await cleanupServerInstanceRuntime(inst, 'delete_instance');
          if (!cleanupResult.success) {
            return {
              success: false,
              error: `Failed to stop server services for "${inst.name || inst.id}".`,
              code: 'INSTANCE_CLEANUP_FAILED'
            };
          }
        }
        
        const remaining = instances.filter(i => i.id !== id);
        
        logger.debug('Starting instance configuration persistence', {
          category: 'settings',
          data: {
            handler: 'delete-instance',
            operation: 'persistence_start',
            instanceId: id,
            remainingCount: remaining.length
          }
        });

        appStore.set('instances', remaining);
        instanceContext.updateInstances(remaining);
        cleanupDeletedInstanceStoreState(inst);
        
        // also clear lastServerPath if it was the deleted one
        const currentServerPath = appStore.get('lastServerPath');
        if (inst.path && currentServerPath === inst.path) {
          const nextServerInstance = remaining.find((item) => item && item.type === 'server' && item.path);
          appStore.set('lastServerPath', nextServerInstance?.path || null);
          
          logger.info('Server path configuration cleared', {
            category: 'settings',
            data: {
              handler: 'delete-instance',
              operation: 'server_path_clear',
              instanceId: id,
              changes: {
                lastServerPath: {
                  before: currentServerPath,
                  after: nextServerInstance?.path || null
                }
              }
            }
          });
        }
        
        // optionally delete directory
        if (deleteFiles && inst.path) {
          try {
            logger.debug('Starting file deletion', {
              category: 'settings',
              data: {
                handler: 'delete-instance',
                operation: 'file_deletion_start',
                instanceId: id,
                instancePath: inst.path
              }
            });

            await rm(inst.path, { recursive: true, force: true });

            logger.info('Instance files deleted successfully', {
              category: 'settings',
              data: {
                handler: 'delete-instance',
                operation: 'file_deletion_success',
                instanceId: id,
                instancePath: inst.path
              }
            });
          } catch (fileError) {
            logger.error('Instance file deletion failed', {
              category: 'settings',
              data: {
                handler: 'delete-instance',
                operation: 'file_deletion_failure',
                instanceId: id,
                instancePath: inst.path,
                error: fileError.message,
                errorType: fileError.constructor.name,
                recovery: 'returning_with_warning'
              }
            });

            return { 
              success: true, 
              instances: remaining,
              warning: `Instance removed but could not delete server files: ${fileError.message}`
            };
          }
        }

        const duration = Date.now() - startTime;
        
        logger.info('Instance deletion completed successfully', {
          category: 'settings',
          data: {
            handler: 'delete-instance',
            operation: 'complete_success',
            duration,
            instanceId: id,
            instanceName: inst.name,
            instanceType: inst.type,
            filesDeleted: deleteFiles && inst.path,
            remainingInstances: remaining.length
          }
        });
        
        return { success: true, instances: remaining };
      } catch (err) {
        const duration = Date.now() - startTime;
        
        logger.error('Instance deletion operation failed', {
          category: 'settings',
          data: {
            handler: 'delete-instance',
            operation: 'complete_failure',
            duration,
            instanceId: id,
            error: err.message,
            errorType: err.constructor.name,
            stack: err.stack
          }
        });
        
        return { success: false, error: err.message };
      }
    },
    
    // Cache a pending management server certificate pin (for setup/testing before save)
    'cache-management-cert-pin': async (_e, payload = {}) => {
      const host = typeof payload.host === 'string' ? payload.host.trim() : '';
      const port = payload.port || '8080';
      const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint.trim() : '';
      if (!host) {
        return { success: false, error: 'Host is required' };
      }
      const key = buildPendingPinKey(host, port);
      if (!key) {
        return { success: false, error: 'Invalid host or port' };
      }
      const pendingPins = appStore.get('pendingManagementPins') || {};
      const existing = pendingPins[key] || {};
      pendingPins[key] = {
        host,
        port: String(port || '8080'),
        fingerprint: fingerprint || existing.fingerprint || '',
        updatedAt: new Date().toISOString()
      };
      appStore.set('pendingManagementPins', pendingPins);
      return { success: true };
    },

    'read-client-config': async (_e, clientPath) => {
      try {
        if (!clientPath || typeof clientPath !== 'string' || clientPath.trim() === '') {
          return { success: false, error: 'Invalid client path' };
        }
        const config = readClientConfig(clientPath);
        if (!config) {
          return { success: false, error: 'Client configuration not found' };
        }
        return { success: true, config };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    // Save client configuration
    'save-client-config': async (_e, { path: clientPath, serverIp, serverPort, clientId, clientName, sessionToken, serverProtocol, inviteSecret, managementCertFingerprint }) => {
      const startTime = Date.now();
      
      logger.debug('IPC handler invoked', {
        category: 'settings',
        data: {
          handler: 'save-client-config',
          sender: _e.sender.id,
          hasClientPath: !!clientPath,
          hasServerIp: !!serverIp,
          hasServerPort: !!serverPort,
          hasClientId: !!clientId,
          hasClientName: !!clientName,
          hasSessionToken: !!sessionToken,
          hasServerProtocol: !!serverProtocol,
          hasInviteSecret: !!inviteSecret,
          hasManagementCertFingerprint: !!managementCertFingerprint
        }
      });

      try {
        // Validate parameters
        if (!clientPath || typeof clientPath !== 'string' || clientPath.trim() === '') {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              validation: 'client_path',
              value: clientPath,
              type: typeof clientPath,
              valid: false,
              errorReason: !clientPath ? 'missing' : typeof clientPath !== 'string' ? 'invalid_type' : 'empty_string'
            }
          });
          return { success: false, error: 'Invalid client path' };
        }
        
        if (!serverIp || typeof serverIp !== 'string' || serverIp.trim() === '') {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              validation: 'server_ip',
              value: serverIp,
              type: typeof serverIp,
              valid: false,
              errorReason: !serverIp ? 'missing' : typeof serverIp !== 'string' ? 'invalid_type' : 'empty_string'
            }
          });
          return { success: false, error: 'Invalid server IP address' };
        }

        const normalizedProtocol = typeof serverProtocol === 'string' ? serverProtocol.trim().toLowerCase() : '';
        if (normalizedProtocol && normalizedProtocol !== 'http' && normalizedProtocol !== 'https') {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              validation: 'server_protocol',
              value: serverProtocol,
              valid: false
            }
          });
          return { success: false, error: 'Invalid server protocol' };
        }
        
        logger.debug('Starting client configuration save process', {
          category: 'settings',
          data: {
            handler: 'save-client-config',
            operation: 'config_save_start',
            clientPath,
            serverIp,
            serverPort: serverPort || '8080'
          }
        });

        // Create directory if it doesn't exist
        if (!fs.existsSync(clientPath)) {
          logger.debug('Creating client directory', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              operation: 'directory_create',
              clientPath
            }
          });

          fs.mkdirSync(clientPath, { recursive: true });

          logger.info('Client directory created successfully', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              operation: 'directory_create_success',
              clientPath
            }
          });
        }

        // Save client configuration to a JSON file
        const configFile = path.join(clientPath, 'client-config.json');
        let existingConfig = {};
        if (fs.existsSync(configFile)) {
          try {
            existingConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
          } catch {
            existingConfig = {};
          }
        }
        const resolvedPort = serverPort || '8080';
        const storedToken = typeof sessionToken === 'string' && sessionToken.trim()
          ? sessionToken.trim()
          : (typeof existingConfig.sessionToken === 'string' ? existingConfig.sessionToken : '');
        const storedProtocol = normalizedProtocol
          ? normalizedProtocol
          : (typeof existingConfig.serverProtocol === 'string' ? existingConfig.serverProtocol : 'https');
        const storedInviteSecret = typeof inviteSecret === 'string' && inviteSecret.trim()
          ? inviteSecret.trim()
          : (typeof existingConfig.inviteSecret === 'string' ? existingConfig.inviteSecret : '');
        const existingHost = normalizeHost(existingConfig.serverIp || '');
        const existingPort = String(existingConfig.serverPort || '8080');
        const incomingHost = normalizeHost(serverIp || '');
        const incomingPort = String(resolvedPort);
        const serverChanged = !!existingHost && (existingHost !== incomingHost || existingPort !== incomingPort);
        let storedManagementFingerprint = '';
        if (typeof managementCertFingerprint === 'string' && managementCertFingerprint.trim()) {
          storedManagementFingerprint = managementCertFingerprint.trim();
        } else if (!serverChanged && typeof existingConfig.managementCertFingerprint === 'string') {
          storedManagementFingerprint = existingConfig.managementCertFingerprint;
        }
        if (!storedManagementFingerprint) {
          const pendingPins = appStore.get('pendingManagementPins') || {};
          const pinKey = buildPendingPinKey(serverIp, resolvedPort);
          const pendingEntry = pinKey ? pendingPins[pinKey] : null;
          if (pendingEntry && typeof pendingEntry.fingerprint === 'string' && pendingEntry.fingerprint.trim()) {
            storedManagementFingerprint = pendingEntry.fingerprint.trim();
          }
        }
        const shouldClearFingerprint = serverChanged && !storedManagementFingerprint;
        const config = {
          serverIp,
          serverPort: resolvedPort, // Default to management server port
          clientId: clientId || `client-${Date.now()}`,
          clientName: clientName || 'Unnamed Client',
          lastConnected: new Date().toISOString(),
          serverProtocol: storedProtocol || 'https'
        };
        if (storedToken) {
          config.sessionToken = storedToken;
        }
        if (storedInviteSecret) {
          config.inviteSecret = storedInviteSecret;
        }
        if (storedManagementFingerprint) {
          config.managementCertFingerprint = storedManagementFingerprint;
        }

        logger.debug('Writing client configuration file', {
          category: 'settings',
          data: {
            handler: 'save-client-config',
            operation: 'config_file_write',
            configFile,
            configKeys: Object.keys(config)
          }
        });
        
        await fsPromises.writeFile(configFile, JSON.stringify(config, null, 2));

        logger.info('Client configuration file saved successfully', {
          category: 'settings',
          data: {
            handler: 'save-client-config',
            operation: 'config_file_write_success',
            configFile,
            clientId: config.clientId,
            clientName: config.clientName
          }
        });

        // Create servers.dat so the server appears in multiplayer list (only if not already initialized)
        const serversInitializedFile = path.join(clientPath, '.servers-initialized');
        if (!fs.existsSync(serversInitializedFile)) {
          logger.debug('Initializing servers.dat file', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              operation: 'servers_dat_init',
              clientPath,
              serverIp,
              serverPort: config.serverPort
            }
          });

          await ensureServersDat(
            clientPath,
            serverIp,
            config.serverPort,
            config.clientName,
            null,
            false,
            config.sessionToken || null,
            config.serverProtocol || 'https',
            config.managementCertFingerprint || null
          );
          
          // Create flag file to indicate servers.dat has been initialized
          fs.writeFileSync(serversInitializedFile, JSON.stringify({
            initializedAt: new Date().toISOString(),
            serverIp,
            serverPort: config.serverPort,
            clientName: config.clientName
          }), 'utf8');

          logger.info('Servers.dat initialization completed', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              operation: 'servers_dat_init_success',
              clientPath,
              serverIp,
              serverPort: config.serverPort
            }
          });
        } else {
          logger.debug('Servers.dat already initialized, skipping', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              operation: 'servers_dat_skip',
              clientPath,
              reason: 'already_initialized'
            }
          });
        }
        
        // ALSO update the instance in the app store so it persists across app restarts
        logger.debug('Updating client instance in app store', {
          category: 'settings',
          data: {
            handler: 'save-client-config',
            operation: 'instance_store_update',
            clientPath,
            clientId: config.clientId
          }
        });

        const instances = appStore.get('instances') || [];
          
        // Find the client instance by path
        const clientInstanceIndex = instances.findIndex(inst => 
          inst.type === 'client' && inst.path === clientPath
        );
        
        if (clientInstanceIndex !== -1) {
          // Update existing client instance
          const previousInstance = { ...instances[clientInstanceIndex] };
          instances[clientInstanceIndex] = {
            ...instances[clientInstanceIndex],
            serverIp,
            serverPort: resolvedPort,
            serverProtocol: config.serverProtocol || instances[clientInstanceIndex].serverProtocol,
            clientId: config.clientId,
            clientName: config.clientName,
            sessionToken: config.sessionToken || instances[clientInstanceIndex].sessionToken,
            inviteSecret: config.inviteSecret || instances[clientInstanceIndex].inviteSecret,
            managementCertFingerprint: storedManagementFingerprint
              ? storedManagementFingerprint
              : (shouldClearFingerprint ? '' : instances[clientInstanceIndex].managementCertFingerprint),
            path: clientPath,
            lastConnected: config.lastConnected
          };

          logger.info('Existing client instance updated', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              operation: 'instance_update',
              clientId: config.clientId,
              changes: {
                serverIp: { before: previousInstance.serverIp, after: serverIp },
                serverPort: { before: previousInstance.serverPort, after: serverPort || '8080' },
                clientName: { before: previousInstance.clientName, after: config.clientName }
              }
            }
          });
        } else {
          // Create new client instance entry
          const newInstance = {
            id: config.clientId,
            name: config.clientName,
            type: 'client',
            path: clientPath,
            serverIp,
            serverPort: resolvedPort,
            serverProtocol: config.serverProtocol,
            clientId: config.clientId,
            clientName: config.clientName,
            sessionToken: config.sessionToken,
            inviteSecret: config.inviteSecret,
            managementCertFingerprint: config.managementCertFingerprint,
            lastConnected: config.lastConnected
          };
          instances.push(newInstance);

          logger.info('New client instance created', {
            category: 'settings',
            data: {
              handler: 'save-client-config',
              operation: 'instance_create',
              clientId: config.clientId,
              clientName: config.clientName,
              totalInstances: instances.length
            }
          });
        }

        appStore.set('instances', instances);

        const duration = Date.now() - startTime;
        
        logger.info('Client configuration save completed successfully', {
          category: 'settings',
          data: {
            handler: 'save-client-config',
            operation: 'complete_success',
            duration,
            clientId: config.clientId,
            clientName: config.clientName,
            clientPath
          }
        });

        return { success: true };
      } catch (err) {
        const duration = Date.now() - startTime;
        
        logger.error('Client configuration save failed', {
          category: 'settings',
          data: {
            handler: 'save-client-config',
            operation: 'complete_failure',
            duration,
            clientPath,
            error: err.message,
            errorType: err.constructor.name,
            stack: err.stack
          }
        });
        
        return { success: false, error: err.message };
      }
    }
  };
}

module.exports = { createSettingsHandlers };
