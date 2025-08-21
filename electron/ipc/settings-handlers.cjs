// Settings IPC handlers
const appStore = require('../utils/app-store.cjs');
const { ensureServersDat } = require('../utils/servers-dat.cjs');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { rm } = require('fs/promises');
const { getLoggerHandlers } = require('./logger-handlers.cjs');
const instanceContext = require('../utils/instance-context.cjs');

const logger = getLoggerHandlers();

/**
 * Create settings IPC handlers
 */
function createSettingsHandlers() {
  logger.info('Settings handlers initialized', {
    category: 'settings',
    data: { handler: 'createSettingsHandlers' }
  });

  return {
    'update-settings': async (_e, { port, maxRam, managementPort, serverPath, autoStartMinecraft, autoStartManagement }) => {
      const startTime = Date.now();
      
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
              serverPath: serverPath !== undefined
            }
          }
        });

        if (port !== undefined && (typeof port !== 'number' || port < 1 || port > 65535)) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              validation: 'port',
              value: port,
              type: typeof port,
              valid: false,
              validRange: '1-65535',
              errorReason: typeof port !== 'number' ? 'invalid_type' : 'out_of_range'
            }
          });
          return { success: false, error: 'Invalid port number' };
        }
        
        if (maxRam !== undefined && (typeof maxRam !== 'number' || maxRam <= 0)) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              validation: 'maxRam',
              value: maxRam,
              type: typeof maxRam,
              valid: false,
              validRange: '>0',
              errorReason: typeof maxRam !== 'number' ? 'invalid_type' : 'invalid_value'
            }
          });
          return { success: false, error: 'Invalid memory allocation' };
        }
        
        if (managementPort !== undefined && (typeof managementPort !== 'number' || managementPort < 1025 || managementPort > 65535)) {
          logger.error('Configuration validation failed', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              validation: 'managementPort',
              value: managementPort,
              type: typeof managementPort,
              valid: false,
              validRange: '1025-65535',
              errorReason: typeof managementPort !== 'number' ? 'invalid_type' : 'out_of_range'
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

        const currentSettings = appStore.get('serverSettings') || { 
          port: 25565, 
          maxRam: 4, 
          managementPort: 8080,
          autoStartMinecraft: false, 
          autoStartManagement: false 
        };

        const isDefaultConfig = !appStore.get('serverSettings');
        
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
          port: port !== undefined ? port : currentSettings.port,
          maxRam: maxRam !== undefined ? maxRam : currentSettings.maxRam,
          managementPort: managementPort !== undefined ? managementPort : currentSettings.managementPort,
          autoStartMinecraft: autoStartMinecraft !== undefined ? autoStartMinecraft : currentSettings.autoStartMinecraft,
          autoStartManagement: autoStartManagement !== undefined ? autoStartManagement : currentSettings.autoStartManagement
        };

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
        
        // Save to persistent store
        try {
          logger.debug('Starting settings persistence operation', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              operation: 'persistence_start',
              settingsKeys: Object.keys(updatedSettings)
            }
          });

          appStore.set('serverSettings', updatedSettings);
          
          logger.info('Settings persistence completed successfully', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              operation: 'persistence_success',
              settingsKeys: Object.keys(updatedSettings),
              duration: Date.now() - startTime
            }
          });
        } catch (storeError) {
          logger.error('Settings persistence failed', {
            category: 'settings',
            data: {
              handler: 'update-settings',
              operation: 'persistence_failure',
              error: storeError.message,
              errorType: storeError.constructor.name,
              stack: storeError.stack,
              duration: Date.now() - startTime,
              recovery: 'throwing_error'
            }
          });
          throw new Error(`Failed to save settings: ${storeError.message}`);
        }
        
        // If serverPath is provided, update the lastServerPath
        if (serverPath && typeof serverPath === 'string' && serverPath.trim() !== '') {
          try {
            const previousPath = appStore.get('lastServerPath');
            
            logger.debug('Updating server path configuration', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_path_update_start',
                previousPath,
                newPath: serverPath
              }
            });

            appStore.set('lastServerPath', serverPath);
            
            logger.info('Server path configuration updated', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_path_update_success',
                changes: {
                  lastServerPath: {
                    before: previousPath,
                    after: serverPath
                  }
                },
                pathChanged: previousPath !== serverPath
              }
            });
          } catch (pathError) {
            logger.error('Server path configuration update failed', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_path_update_failure',
                serverPath,
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
        const usePath = serverPath || appStore.get('lastServerPath');
        if (usePath) {
          try {
            const configPath = path.join(usePath, '.minecraft-core.json');
            let config = { port: updatedSettings.port, maxRam: updatedSettings.maxRam };

            logger.debug('Updating server configuration file', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_config_file_update',
                configPath,
                serverPath: usePath
              }
            });

            if (fs.existsSync(configPath)) {
              try {
                logger.debug('Reading existing server configuration file', {
                  category: 'settings',
                  data: {
                    handler: 'update-settings',
                    operation: 'config_file_read',
                    configPath
                  }
                });

                const fileContent = fs.readFileSync(configPath, 'utf-8');
                const existingConfig = JSON.parse(fileContent);
                config = { ...existingConfig };

                logger.debug('Existing server configuration loaded', {
                  category: 'settings',
                  data: {
                    handler: 'update-settings',
                    operation: 'config_file_loaded',
                    configKeys: Object.keys(existingConfig)
                  }
                });
              } catch (readError) {
                logger.warn('Failed to read existing server configuration, using defaults', {
                  category: 'settings',
                  data: {
                    handler: 'update-settings',
                    operation: 'config_file_read_failure',
                    configPath,
                    error: readError.message,
                    errorType: readError.constructor.name,
                    recovery: 'using_defaults'
                  }
                });
                config = { port: updatedSettings.port, maxRam: updatedSettings.maxRam };
              }
            } else {
              logger.debug('Server configuration file does not exist, creating new', {
                category: 'settings',
                data: {
                  handler: 'update-settings',
                  operation: 'config_file_create',
                  configPath
                }
              });
            }

            const previousConfig = { ...config };
            config.port = updatedSettings.port;
            config.maxRam = updatedSettings.maxRam;

            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

            logger.info('Server configuration file updated', {
              category: 'settings',
              data: {
                handler: 'update-settings',
                operation: 'server_config_file_success',
                configPath,
                changes: {
                  port: { before: previousConfig.port, after: config.port },
                  maxRam: { before: previousConfig.maxRam, after: config.maxRam }
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
            serverPath: serverPath || appStore.get('lastServerPath')
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
    
    'get-settings': async (_e) => {
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

        const settings = appStore.get('serverSettings') || { 
          port: 25565, 
          maxRam: 4, 
          managementPort: 8080,
          autoStartMinecraft: false, 
          autoStartManagement: false 
        };
        const serverPath = appStore.get('lastServerPath');
        
        const isDefaultConfig = !appStore.get('serverSettings');
        
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
            const validInstance = {
              id: instance.id || `instance-${Date.now()}`,
              name: instance.name || `Instance ${Date.now()}`,
              type: instance.type || 'server'
            };
            
            // Include type-specific fields
            if (instance.type === 'server') {
              if (instance.path) {
                validInstance.path = instance.path;
              }
            } else if (instance.type === 'client') {
              // Include client-specific fields
              if (instance.path) validInstance.path = instance.path;
              if (instance.serverIp) validInstance.serverIp = instance.serverIp;
              if (instance.serverPort) validInstance.serverPort = instance.serverPort;
              if (instance.clientId) validInstance.clientId = instance.clientId;
              if (instance.clientName) validInstance.clientName = instance.clientName;
              if (instance.lastConnected) validInstance.lastConnected = instance.lastConnected;
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

          // Get current instances for change tracking
          const currentInstances = appStore.get('instances') || [];
          
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

        const duration = Date.now() - startTime;
        
        logger.debug('Instances retrieval completed', {
          category: 'settings',
          data: {
            handler: 'get-instances',
            operation: 'complete_success',
            duration,
            totalInstances: instances.length,
            validInstances: validInstances.length,
            filteredCount: instances.length - validInstances.length
          }
        });
        
        return validInstances;
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
        instances[idx].name = newName;

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
        
        // CRITICAL: Stop file watchers for server instances before deletion
        if (inst.type === 'server' && inst.path) {
          logger.debug('Stopping server processes and watchers before deletion', {
            category: 'settings',
            data: {
              handler: 'delete-instance',
              operation: 'cleanup_start',
              instanceId: id,
              instancePath: inst.path
            }
          });

          try {
            // Stop management server watchers if they're watching this path
            const { getManagementServer } = require('../services/management-server.cjs');
            const managementServer = getManagementServer();
            const status = managementServer.getStatus();
            
            if (status.isRunning && status.serverPath === inst.path) {
              logger.debug('Stopping management server watchers', {
                category: 'settings',
                data: {
                  handler: 'delete-instance',
                  operation: 'management_server_cleanup',
                  instanceId: id,
                  serverPath: inst.path
                }
              });

              // If management server is watching this path, stop the watcher
              managementServer.stopVersionWatcher();
              
              // Update server path to null to prevent further file system operations
              managementServer.updateServerPath(null);

              logger.info('Management server watchers stopped successfully', {
                category: 'settings',
                data: {
                  handler: 'delete-instance',
                  operation: 'management_server_cleanup_success',
                  instanceId: id
                }
              });
            }
          } catch (managementError) {
            logger.error('Failed to cleanup management server watchers', {
              category: 'settings',
              data: {
                handler: 'delete-instance',
                operation: 'management_server_cleanup_failure',
                instanceId: id,
                error: managementError.message,
                errorType: managementError.constructor.name,
                recovery: 'continuing_with_deletion'
              }
            });
          }
          
          // Also stop any server processes that might be using this directory
          try {
            const { getServerProcess, killMinecraftServer } = require('../services/server-manager.cjs');
            const serverProcess = getServerProcess();
            if (serverProcess) {
              logger.debug('Stopping server process before deletion', {
                category: 'settings',
                data: {
                  handler: 'delete-instance',
                  operation: 'server_process_cleanup',
                  instanceId: id,
                  hasServerProcess: true
                }
              });

              killMinecraftServer();
              // Wait a bit for process cleanup
              await new Promise(resolve => setTimeout(resolve, 1000));

              logger.info('Server process stopped successfully', {
                category: 'settings',
                data: {
                  handler: 'delete-instance',
                  operation: 'server_process_cleanup_success',
                  instanceId: id
                }
              });
            }
          } catch (serverError) {
            logger.error('Failed to cleanup server process', {
              category: 'settings',
              data: {
                handler: 'delete-instance',
                operation: 'server_process_cleanup_failure',
                instanceId: id,
                error: serverError.message,
                errorType: serverError.constructor.name,
                recovery: 'continuing_with_deletion'
              }
            });
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
        
        // also clear lastServerPath if it was the deleted one
        const currentServerPath = appStore.get('lastServerPath');
        if (inst.path && currentServerPath === inst.path) {
          appStore.set('lastServerPath', null);
          
          logger.info('Server path configuration cleared', {
            category: 'settings',
            data: {
              handler: 'delete-instance',
              operation: 'server_path_clear',
              instanceId: id,
              changes: {
                lastServerPath: {
                  before: currentServerPath,
                  after: null
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
    
    // Save client configuration
    'save-client-config': async (_e, { path: clientPath, serverIp, serverPort, clientId, clientName }) => {
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
          hasClientName: !!clientName
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
        const config = {
          serverIp,
          serverPort: serverPort || '8080', // Default to management server port
          clientId: clientId || `client-${Date.now()}`,
          clientName: clientName || 'Unnamed Client',
          lastConnected: new Date().toISOString()
        };

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

          await ensureServersDat(clientPath, serverIp, config.serverPort, config.clientName);
          
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
            serverPort: serverPort || '8080',
            clientId: config.clientId,
            clientName: config.clientName,
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
            serverPort: serverPort || '8080',
            clientId: config.clientId,
            clientName: config.clientName,
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
