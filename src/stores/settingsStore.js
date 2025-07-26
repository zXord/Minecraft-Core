// Settings state store
import { writable } from 'svelte/store';
import logger from '../utils/logger.js';

// Default settings for fallback and validation
const DEFAULT_SETTINGS = {
  // Server configuration
  port: 25565,
  maxRam: 4,
  path: '',
  
  // Minecraft and Fabric versions
  mcVersion: null,
  fabricVersion: null,
  
  // Auto-restart configuration
  autoRestart: {
    enabled: false,
    delay: 10,
    maxCrashes: 3,
    crashCount: 0
  },
  
  // UI state
  isDarkMode: true,
  consoleAutoScroll: true
};

// Validation functions
function validatePort(/** @type {any} */ port) {
  const portNum = parseInt(port);
  return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
}

function validateMaxRam(/** @type {any} */ maxRam) {
  const ramNum = parseInt(maxRam);
  return !isNaN(ramNum) && ramNum >= 1 && ramNum <= 64;
}

function validateAutoRestartSettings(/** @type {any} */ autoRestart) {
  if (!autoRestart || typeof autoRestart !== 'object') return false;
  
  const { enabled, delay, maxCrashes, crashCount } = autoRestart;
  
  return (
    typeof enabled === 'boolean' &&
    (!delay || (Number.isInteger(delay) && delay >= 0)) &&
    (!maxCrashes || (Number.isInteger(maxCrashes) && maxCrashes >= 0)) &&
    (!crashCount || (Number.isInteger(crashCount) && crashCount >= 0))
  );
}

function validateSettings(/** @type {any} */ settings) {
  const errors = [];
  
  if (settings.port !== undefined && !validatePort(settings.port)) {
    errors.push(`Invalid port: ${settings.port}`);
  }
  
  if (settings.maxRam !== undefined && !validateMaxRam(settings.maxRam)) {
    errors.push(`Invalid maxRam: ${settings.maxRam}`);
  }
  
  if (settings.autoRestart !== undefined && !validateAutoRestartSettings(settings.autoRestart)) {
    errors.push('Invalid autoRestart configuration');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

function sanitizeSettings(/** @type {any} */ settings) {
  try {
    const sanitized = { ...settings };
    
    // Sanitize port
    if (sanitized.port !== undefined && !validatePort(sanitized.port)) {
      logger.warn('Invalid port detected, using default', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'sanitizeSettings',
          invalidPort: sanitized.port,
          defaultPort: DEFAULT_SETTINGS.port
        }
      });
      sanitized.port = DEFAULT_SETTINGS.port;
    }
    
    // Sanitize maxRam
    if (sanitized.maxRam !== undefined && !validateMaxRam(sanitized.maxRam)) {
      logger.warn('Invalid maxRam detected, using default', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'sanitizeSettings',
          invalidMaxRam: sanitized.maxRam,
          defaultMaxRam: DEFAULT_SETTINGS.maxRam
        }
      });
      sanitized.maxRam = DEFAULT_SETTINGS.maxRam;
    }
    
    // Sanitize autoRestart
    if (sanitized.autoRestart !== undefined && !validateAutoRestartSettings(sanitized.autoRestart)) {
      logger.warn('Invalid autoRestart settings detected, using defaults', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'sanitizeSettings',
          invalidAutoRestart: sanitized.autoRestart,
          defaultAutoRestart: DEFAULT_SETTINGS.autoRestart
        }
      });
      sanitized.autoRestart = { ...DEFAULT_SETTINGS.autoRestart };
    }
    
    logger.debug('Settings sanitized successfully', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'sanitizeSettings',
        hasChanges: JSON.stringify(settings) !== JSON.stringify(sanitized)
      }
    });
    
    return sanitized;
  } catch (error) {
    logger.error(`Settings sanitization failed: ${error.message}`, {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'sanitizeSettings',
        errorType: error.constructor.name,
        originalSettings: settings
      }
    });
    
    // Return default settings on corruption
    return { ...DEFAULT_SETTINGS };
  }
}

// Create the settings store with default values and logging
function createSettingsStore() {
  logger.info('Initializing settings store', {
    category: 'settings',
    data: {
      store: 'settingsStore',
      function: 'createSettingsStore',
      defaultSettings: Object.keys(DEFAULT_SETTINGS)
    }
  });
  
  const { subscribe, set, update } = writable(DEFAULT_SETTINGS);
  
  return {
    subscribe,
    set: (/** @type {any} */ value) => {
      try {
        const validation = validateSettings(value);
        
        if (!validation.isValid) {
          logger.warn('Invalid settings detected during set operation', {
            category: 'settings',
            data: {
              store: 'settingsStore',
              function: 'set',
              errors: validation.errors,
              attemptedValue: value
            }
          });
          
          value = sanitizeSettings(value);
        }
        
        logger.info('Settings store set operation', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'set',
            settingsKeys: Object.keys(value),
            port: value.port,
            maxRam: value.maxRam,
            hasAutoRestart: !!value.autoRestart
          }
        });
        
        set(value);
      } catch (error) {
        logger.error(`Settings store set operation failed: ${error.message}`, {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'set',
            errorType: error.constructor.name,
            attemptedValue: value
          }
        });
        
        // Fallback to defaults on corruption
        logger.warn('Falling back to default settings due to corruption', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'set',
            fallbackReason: 'set_operation_failed'
          }
        });
        set(DEFAULT_SETTINGS);
      }
    },
    update: (/** @type {any} */ updater) => {
      try {
        update((currentState) => {
          const newState = updater(currentState);
          
          const validation = validateSettings(newState);
          
          if (!validation.isValid) {
            logger.warn('Invalid settings detected during update operation', {
              category: 'settings',
              data: {
                store: 'settingsStore',
                function: 'update',
                errors: validation.errors,
                currentState: Object.keys(currentState),
                newState: Object.keys(newState)
              }
            });
            
            return sanitizeSettings(newState);
          }
          
          logger.debug('Settings store updated', {
            category: 'settings',
            data: {
              store: 'settingsStore',
              function: 'update',
              changedKeys: Object.keys(newState).filter(key => 
                JSON.stringify(currentState[key]) !== JSON.stringify(newState[key])
              ),
              port: newState.port,
              maxRam: newState.maxRam,
              hasAutoRestart: !!newState.autoRestart
            }
          });
          
          return newState;
        });
      } catch (error) {
        logger.error(`Settings store update operation failed: ${error.message}`, {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'update',
            errorType: error.constructor.name
          }
        });
        
        // Fallback to defaults on corruption
        logger.warn('Falling back to default settings due to corruption', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'update',
            fallbackReason: 'update_operation_failed'
          }
        });
        set(DEFAULT_SETTINGS);
      }
    }
  };
}

export const settingsStore = createSettingsStore();

// Helper functions to update parts of the settings
export function updateServerSettings(/** @type {any} */ settings) {
  try {
    if (!settings) {
      logger.debug('No settings provided to updateServerSettings', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'updateServerSettings',
          settings
        }
      });
      return;
    }
    
    // Validate server settings before update
    const serverValidation = {
      port: settings.port ? validatePort(settings.port) : true,
      maxRam: settings.maxRam ? validateMaxRam(settings.maxRam) : true,
      path: settings.path ? typeof settings.path === 'string' : true
    };
    
    const hasValidationErrors = Object.values(serverValidation).some(valid => !valid);
    
    if (hasValidationErrors) {
      logger.warn('Invalid server settings detected', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'updateServerSettings',
          validation: serverValidation,
          settings
        }
      });
    }
    
    logger.info('Updating server settings', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'updateServerSettings',
        port: settings.port,
        maxRam: settings.maxRam,
        hasPath: !!settings.path,
        validationPassed: !hasValidationErrors
      }
    });
    
    settingsStore.update(/** @type {any} */ state => {
      const oldPort = state.port;
      const oldMaxRam = state.maxRam;
      const oldPath = state.path;
      
      const newState = {
        ...state,
        port: (settings.port && validatePort(settings.port)) ? settings.port : state.port,
        maxRam: (settings.maxRam && validateMaxRam(settings.maxRam)) ? settings.maxRam : state.maxRam,
        path: settings.path || state.path,
      };
      
      // Log actual changes
      const changes = [];
      if (oldPort !== newState.port) changes.push(`port: ${oldPort} -> ${newState.port}`);
      if (oldMaxRam !== newState.maxRam) changes.push(`maxRam: ${oldMaxRam} -> ${newState.maxRam}`);
      if (oldPath !== newState.path) changes.push(`path: ${oldPath} -> ${newState.path}`);
      
      if (changes.length > 0) {
        logger.info('Server settings changed', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'updateServerSettings',
            changes
          }
        });
      }
      
      return newState;
    });
  } catch (error) {
    logger.error(`Failed to update server settings: ${error.message}`, {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'updateServerSettings',
        errorType: error.constructor.name,
        settings
      }
    });
  }
}

export function updateVersions(/** @type {any} */ mcVersion, /** @type {any} */ fabricVersion) {
  try {
    // Validate version strings
    const mcVersionValid = !mcVersion || (typeof mcVersion === 'string' && mcVersion.trim().length > 0);
    const fabricVersionValid = !fabricVersion || (typeof fabricVersion === 'string' && fabricVersion.trim().length > 0);
    
    if (!mcVersionValid || !fabricVersionValid) {
      logger.warn('Invalid version strings provided', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'updateVersions',
          mcVersion,
          fabricVersion,
          mcVersionValid,
          fabricVersionValid
        }
      });
    }
    
    logger.info('Updating Minecraft and Fabric versions', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'updateVersions',
        mcVersion,
        fabricVersion,
        validationPassed: mcVersionValid && fabricVersionValid
      }
    });
    
    settingsStore.update(/** @type {any} */ state => {
      const oldMcVersion = state.mcVersion;
      const oldFabricVersion = state.fabricVersion;
      const newState = {
        ...state,
        mcVersion: (mcVersionValid && mcVersion) ? mcVersion : state.mcVersion,
        fabricVersion: (fabricVersionValid && fabricVersion) ? fabricVersion : state.fabricVersion
      };
      
      const changes = [];
      if (oldMcVersion !== newState.mcVersion) {
        changes.push(`mcVersion: ${oldMcVersion} -> ${newState.mcVersion}`);
      }
      if (oldFabricVersion !== newState.fabricVersion) {
        changes.push(`fabricVersion: ${oldFabricVersion} -> ${newState.fabricVersion}`);
      }
      
      if (changes.length > 0) {
        logger.info('Version settings changed', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'updateVersions',
            changes,
            newMcVersion: newState.mcVersion,
            newFabricVersion: newState.fabricVersion
          }
        });
      } else {
        logger.debug('No version changes applied', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'updateVersions',
            reason: 'no_valid_changes'
          }
        });
      }
      
      return newState;
    });
  } catch (error) {
    logger.error(`Failed to update versions: ${error.message}`, {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'updateVersions',
        errorType: error.constructor.name,
        mcVersion,
        fabricVersion
      }
    });
  }
}

export function updateAutoRestartSettings(/** @type {any} */ settings) {
  try {
    if (!settings) {
      logger.debug('No settings provided to updateAutoRestartSettings', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'updateAutoRestartSettings',
          settings
        }
      });
      return;
    }
    
    // Validate auto-restart settings
    const validation = validateAutoRestartSettings(settings);
    
    if (!validation) {
      logger.warn('Invalid auto-restart settings provided', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'updateAutoRestartSettings',
          settings,
          validationPassed: false
        }
      });
    }
    
    logger.info('Updating auto-restart settings', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'updateAutoRestartSettings',
        enabled: settings.enabled,
        delay: settings.delay,
        maxCrashes: settings.maxCrashes,
        crashCount: settings.crashCount,
        validationPassed: validation
      }
    });
    
    settingsStore.update(/** @type {any} */ state => {
      const oldAutoRestart = { ...state.autoRestart };
      
      const newAutoRestart = {
        ...state.autoRestart,
        enabled: settings.enabled !== undefined ? settings.enabled : state.autoRestart.enabled,
        delay: (settings.delay !== undefined && Number.isInteger(settings.delay) && settings.delay >= 0) 
          ? settings.delay : state.autoRestart.delay,
        maxCrashes: (settings.maxCrashes !== undefined && Number.isInteger(settings.maxCrashes) && settings.maxCrashes >= 0) 
          ? settings.maxCrashes : state.autoRestart.maxCrashes,
        crashCount: settings.crashCount !== undefined ? settings.crashCount : state.autoRestart.crashCount
      };
      
      // Log actual changes
      const changes = [];
      if (oldAutoRestart.enabled !== newAutoRestart.enabled) {
        changes.push(`enabled: ${oldAutoRestart.enabled} -> ${newAutoRestart.enabled}`);
      }
      if (oldAutoRestart.delay !== newAutoRestart.delay) {
        changes.push(`delay: ${oldAutoRestart.delay} -> ${newAutoRestart.delay}`);
      }
      if (oldAutoRestart.maxCrashes !== newAutoRestart.maxCrashes) {
        changes.push(`maxCrashes: ${oldAutoRestart.maxCrashes} -> ${newAutoRestart.maxCrashes}`);
      }
      if (oldAutoRestart.crashCount !== newAutoRestart.crashCount) {
        changes.push(`crashCount: ${oldAutoRestart.crashCount} -> ${newAutoRestart.crashCount}`);
      }
      
      if (changes.length > 0) {
        logger.info('Auto-restart settings changed', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'updateAutoRestartSettings',
            changes
          }
        });
      }
      
      return {
        ...state,
        autoRestart: newAutoRestart
      };
    });
  } catch (error) {
    logger.error(`Failed to update auto-restart settings: ${error.message}`, {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'updateAutoRestartSettings',
        errorType: error.constructor.name,
        settings
      }
    });
  }
}

export function loadSettings(/** @type {any} */ config) {
  try {
    if (!config) {
      logger.debug('No config provided to loadSettings', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'loadSettings',
          config
        }
      });
      return;
    }
    
    // Validate config structure
    const configValidation = {
      version: !config.version || (typeof config.version === 'string' && config.version.trim().length > 0),
      fabric: !config.fabric || (typeof config.fabric === 'string' && config.fabric.trim().length > 0),
      autoRestart: !config.autoRestart || validateAutoRestartSettings(config.autoRestart)
    };
    
    const hasValidationErrors = Object.values(configValidation).some(valid => !valid);
    
    if (hasValidationErrors) {
      logger.warn('Invalid config structure detected during load', {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'loadSettings',
          validation: configValidation,
          config
        }
      });
    }
    
    logger.info('Loading settings from config', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'loadSettings',
        mcVersion: config.version,
        fabricVersion: config.fabric,
        hasAutoRestart: !!config.autoRestart,
        validationPassed: !hasValidationErrors
      }
    });
    
    settingsStore.update(/** @type {any} */ state => {
      const oldState = { ...state };
      
      const newState = {
        ...state,
        mcVersion: (configValidation.version && config.version) ? config.version : state.mcVersion,
        fabricVersion: (configValidation.fabric && config.fabric) ? config.fabric : state.fabricVersion,
        autoRestart: {
          ...state.autoRestart,
          enabled: (configValidation.autoRestart && config.autoRestart?.enabled !== undefined) 
            ? config.autoRestart.enabled : state.autoRestart.enabled,
          delay: (configValidation.autoRestart && config.autoRestart?.delay !== undefined) 
            ? config.autoRestart.delay : state.autoRestart.delay,
          maxCrashes: (configValidation.autoRestart && config.autoRestart?.maxCrashes !== undefined) 
            ? config.autoRestart.maxCrashes : state.autoRestart.maxCrashes
        }
      };
      
      // Log what was loaded
      const loadedSettings = [];
      if (oldState.mcVersion !== newState.mcVersion) {
        loadedSettings.push(`mcVersion: ${newState.mcVersion}`);
      }
      if (oldState.fabricVersion !== newState.fabricVersion) {
        loadedSettings.push(`fabricVersion: ${newState.fabricVersion}`);
      }
      if (JSON.stringify(oldState.autoRestart) !== JSON.stringify(newState.autoRestart)) {
        loadedSettings.push('autoRestart configuration');
      }
      
      if (loadedSettings.length > 0) {
        logger.info('Settings loaded from config', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'loadSettings',
            loadedSettings,
            settingsCount: loadedSettings.length
          }
        });
      } else {
        logger.debug('No settings changes from config load', {
          category: 'settings',
          data: {
            store: 'settingsStore',
            function: 'loadSettings',
            reason: 'no_valid_changes_or_same_values'
          }
        });
      }
      
      return newState;
    });
  } catch (error) {
    logger.error(`Failed to load settings from config: ${error.message}`, {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'loadSettings',
        errorType: error.constructor.name,
        config
      }
    });
    
    // On corruption, try to load defaults
    logger.warn('Loading default settings due to config corruption', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'loadSettings',
        fallbackReason: 'config_load_failed'
      }
    });
    
    try {
      settingsStore.set(DEFAULT_SETTINGS);
    } catch (fallbackError) {
      logger.error(`Failed to load default settings: ${fallbackError.message}`, {
        category: 'settings',
        data: {
          store: 'settingsStore',
          function: 'loadSettings',
          fallbackError: fallbackError.constructor.name
        }
      });
    }
  }
}

// Additional helper functions for settings persistence and recovery
export function resetToDefaults() {
  try {
    logger.info('Resetting settings to defaults', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'resetToDefaults',
        defaultKeys: Object.keys(DEFAULT_SETTINGS)
      }
    });
    
    settingsStore.set({ ...DEFAULT_SETTINGS });
    
    logger.info('Settings reset to defaults completed', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'resetToDefaults',
        success: true
      }
    });
  } catch (error) {
    logger.error(`Failed to reset settings to defaults: ${error.message}`, {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'resetToDefaults',
        errorType: error.constructor.name
      }
    });
  }
}

export function validateCurrentSettings() {
  try {
    let currentSettings;
    
    settingsStore.subscribe(settings => {
      currentSettings = settings;
    })();
    
    const validation = validateSettings(currentSettings);
    
    logger.info('Settings validation completed', {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'validateCurrentSettings',
        isValid: validation.isValid,
        errorCount: validation.errors.length,
        errors: validation.errors
      }
    });
    
    return validation;
  } catch (error) {
    logger.error(`Settings validation failed: ${error.message}`, {
      category: 'settings',
      data: {
        store: 'settingsStore',
        function: 'validateCurrentSettings',
        errorType: error.constructor.name
      }
    });
    
    return {
      isValid: false,
      errors: [`Validation process failed: ${error.message}`]
    };
  }
}
