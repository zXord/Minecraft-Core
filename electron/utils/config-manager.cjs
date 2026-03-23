// Config file management utilities
const fs = require('fs');
const path = require('path');
const { resolveServerLoader } = require('./server-loader.cjs');

const SERVER_CONFIG_FILENAME = '.minecraft-core.json';
const CLIENT_CONFIG_FILENAME = 'client-config.json';

const DEFAULT_AUTO_RESTART = Object.freeze({
  enabled: false,
  delay: 10,
  maxCrashes: 3
});

const DEFAULT_BACKUP_AUTOMATION = Object.freeze({
  enabled: false,
  frequency: 86400000,
  type: 'world',
  retentionCount: 100,
  runOnLaunch: false,
  hour: 3,
  minute: 0,
  day: 0,
  lastRun: null
});

// Lazy logger initialization to avoid circular dependency
let logger = null;
const getLogger = () => {
  if (!logger) {
    try {
      const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
      logger = getLoggerHandlers();
    } catch {
      logger = {
        debug: console.log,
        info: console.log,
        warn: console.warn,
        error: console.error
      };
    }
  }
  return logger;
};

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function coerceNumber(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function coerceBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function getServerConfigPath(serverPath) {
  return path.join(serverPath, SERVER_CONFIG_FILENAME);
}

function getClientConfigPath(clientPath) {
  return path.join(clientPath, CLIENT_CONFIG_FILENAME);
}

function getDefaultServerConfig(defaultSettings = {}) {
  const fallbackAutoRestart = isPlainObject(defaultSettings.autoRestart)
    ? defaultSettings.autoRestart
    : {};
  const backupSource = isPlainObject(defaultSettings.backupAutomation)
    ? defaultSettings.backupAutomation
    : (isPlainObject(defaultSettings.backupSettings) ? defaultSettings.backupSettings : {});

  return {
    version: defaultSettings.version ?? null,
    fabric: defaultSettings.fabric ?? null,
    loader: defaultSettings.loader ?? null,
    loaderVersion: defaultSettings.loaderVersion ?? null,
    port: coerceNumber(defaultSettings.port, 25565),
    maxRam: coerceNumber(defaultSettings.maxRam, 4),
    managementPort: coerceNumber(defaultSettings.managementPort, 8080),
    autoStartMinecraft: coerceBoolean(defaultSettings.autoStartMinecraft, false),
    autoStartManagement: coerceBoolean(defaultSettings.autoStartManagement, false),
    autoRestart: {
      enabled: coerceBoolean(fallbackAutoRestart.enabled, DEFAULT_AUTO_RESTART.enabled),
      delay: coerceNumber(fallbackAutoRestart.delay, DEFAULT_AUTO_RESTART.delay),
      maxCrashes: coerceNumber(fallbackAutoRestart.maxCrashes, DEFAULT_AUTO_RESTART.maxCrashes)
    },
    managementInviteHost: typeof defaultSettings.managementInviteHost === 'string'
      ? defaultSettings.managementInviteHost
      : '',
    managementInviteSecret: typeof defaultSettings.managementInviteSecret === 'string'
      ? defaultSettings.managementInviteSecret
      : '',
    managementTls: normalizeManagementTlsConfig(defaultSettings.managementTls),
    backupAutomation: {
      enabled: coerceBoolean(backupSource.enabled, DEFAULT_BACKUP_AUTOMATION.enabled),
      frequency: coerceNumber(backupSource.frequency, DEFAULT_BACKUP_AUTOMATION.frequency),
      type: typeof backupSource.type === 'string' && backupSource.type.trim()
        ? backupSource.type.trim()
        : DEFAULT_BACKUP_AUTOMATION.type,
      retentionCount: coerceNumber(backupSource.retentionCount, DEFAULT_BACKUP_AUTOMATION.retentionCount),
      runOnLaunch: coerceBoolean(backupSource.runOnLaunch, DEFAULT_BACKUP_AUTOMATION.runOnLaunch),
      hour: coerceNumber(backupSource.hour, DEFAULT_BACKUP_AUTOMATION.hour),
      minute: coerceNumber(backupSource.minute, DEFAULT_BACKUP_AUTOMATION.minute),
      day: coerceNumber(backupSource.day, DEFAULT_BACKUP_AUTOMATION.day),
      lastRun: typeof backupSource.lastRun === 'string' && backupSource.lastRun.trim()
        ? backupSource.lastRun
        : DEFAULT_BACKUP_AUTOMATION.lastRun
    },
    managedBy: typeof defaultSettings.managedBy === 'string' && defaultSettings.managedBy.trim()
      ? defaultSettings.managedBy
      : 'minecraft-core'
  };
}

function normalizeManagementTlsConfig(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  const cert = typeof value.cert === 'string' ? value.cert : '';
  const key = typeof value.key === 'string' ? value.key : '';
  if (!cert || !key) {
    return null;
  }

  return {
    cert,
    key,
    fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    keyEncrypted: typeof value.keyEncrypted === 'boolean' ? value.keyEncrypted : false
  };
}

function normalizeAutoRestartConfig(value, fallback = DEFAULT_AUTO_RESTART) {
  const source = isPlainObject(value) ? value : {};
  return {
    enabled: coerceBoolean(source.enabled, coerceBoolean(fallback.enabled, DEFAULT_AUTO_RESTART.enabled)),
    delay: coerceNumber(source.delay, coerceNumber(fallback.delay, DEFAULT_AUTO_RESTART.delay)),
    maxCrashes: coerceNumber(source.maxCrashes, coerceNumber(fallback.maxCrashes, DEFAULT_AUTO_RESTART.maxCrashes))
  };
}

function normalizeBackupAutomationConfig(value, fallback = DEFAULT_BACKUP_AUTOMATION) {
  const source = isPlainObject(value) ? value : {};
  return {
    enabled: coerceBoolean(source.enabled, coerceBoolean(fallback.enabled, DEFAULT_BACKUP_AUTOMATION.enabled)),
    frequency: coerceNumber(source.frequency, coerceNumber(fallback.frequency, DEFAULT_BACKUP_AUTOMATION.frequency)),
    type: typeof source.type === 'string' && source.type.trim()
      ? source.type.trim()
      : (typeof fallback.type === 'string' && fallback.type.trim()
        ? fallback.type.trim()
        : DEFAULT_BACKUP_AUTOMATION.type),
    retentionCount: coerceNumber(source.retentionCount, coerceNumber(fallback.retentionCount, DEFAULT_BACKUP_AUTOMATION.retentionCount)),
    runOnLaunch: coerceBoolean(source.runOnLaunch, coerceBoolean(fallback.runOnLaunch, DEFAULT_BACKUP_AUTOMATION.runOnLaunch)),
    hour: coerceNumber(source.hour, coerceNumber(fallback.hour, DEFAULT_BACKUP_AUTOMATION.hour)),
    minute: coerceNumber(source.minute, coerceNumber(fallback.minute, DEFAULT_BACKUP_AUTOMATION.minute)),
    day: coerceNumber(source.day, coerceNumber(fallback.day, DEFAULT_BACKUP_AUTOMATION.day)),
    lastRun: typeof source.lastRun === 'string' && source.lastRun.trim()
      ? source.lastRun
      : (typeof fallback.lastRun === 'string' && fallback.lastRun.trim() ? fallback.lastRun : null)
  };
}

function enrichServerConfig(config, serverPath) {
  const enriched = { ...config };

  if (!enriched.version) {
    const detectedVersion = detectMinecraftVersion(serverPath);
    if (detectedVersion) {
      enriched.version = detectedVersion;
      if (!enriched.detectedAt) {
        enriched.detectedAt = new Date().toISOString();
      }
      if (!enriched.detectionMethod) {
        enriched.detectionMethod = 'automatic';
      }
    }
  }

  try {
    const loaderInfo = resolveServerLoader(serverPath);
    if (loaderInfo && loaderInfo.loader) {
      if (!enriched.loader) {
        enriched.loader = loaderInfo.loader;
      }
      if (!enriched.loaderVersion && loaderInfo.loaderVersion) {
        enriched.loaderVersion = loaderInfo.loaderVersion;
      }
      if (!enriched.fabric && loaderInfo.loader === 'fabric' && loaderInfo.loaderVersion) {
        enriched.fabric = loaderInfo.loaderVersion;
      }
    }
  } catch (error) {
    getLogger().warn('Failed to enrich server config with loader information', {
      category: 'settings',
      data: {
        function: 'enrichServerConfig',
        serverPath,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
  }

  return enriched;
}

function normalizeServerConfig(config = {}, defaultSettings = {}, serverPath = null) {
  const defaults = getDefaultServerConfig(defaultSettings);
  const source = isPlainObject(config) ? config : {};

  const normalized = {
    ...defaults,
    ...source,
    port: coerceNumber(source.port, defaults.port),
    maxRam: coerceNumber(source.maxRam, defaults.maxRam),
    managementPort: coerceNumber(source.managementPort, defaults.managementPort),
    autoStartMinecraft: coerceBoolean(source.autoStartMinecraft, defaults.autoStartMinecraft),
    autoStartManagement: coerceBoolean(source.autoStartManagement, defaults.autoStartManagement),
    managementInviteHost: typeof source.managementInviteHost === 'string'
      ? source.managementInviteHost
      : defaults.managementInviteHost,
    managementInviteSecret: typeof source.managementInviteSecret === 'string'
      ? source.managementInviteSecret
      : defaults.managementInviteSecret,
    autoRestart: normalizeAutoRestartConfig(source.autoRestart, defaults.autoRestart),
    backupAutomation: normalizeBackupAutomationConfig(
      source.backupAutomation || source.backupSettings,
      defaults.backupAutomation
    ),
    managementTls: normalizeManagementTlsConfig(source.managementTls) || defaults.managementTls,
    managedBy: typeof source.managedBy === 'string' && source.managedBy.trim()
      ? source.managedBy
      : defaults.managedBy
  };

  return serverPath ? enrichServerConfig(normalized, serverPath) : normalized;
}

function normalizeClientConfig(config = {}) {
  if (!isPlainObject(config)) {
    return null;
  }

  const serverIp = typeof config.serverIp === 'string' ? config.serverIp.trim() : '';
  const serverPort = typeof config.serverPort === 'string' || typeof config.serverPort === 'number'
    ? String(config.serverPort).trim()
    : '';
  const serverProtocol = typeof config.serverProtocol === 'string' && config.serverProtocol.trim()
    ? config.serverProtocol.trim().toLowerCase()
    : 'https';
  const clientId = typeof config.clientId === 'string' ? config.clientId.trim() : '';
  const clientName = typeof config.clientName === 'string' ? config.clientName.trim() : '';

  if (!serverIp || !serverPort || !clientId || !clientName) {
    return null;
  }

  const normalized = {
    serverIp,
    serverPort,
    serverProtocol: serverProtocol === 'http' ? 'http' : 'https',
    clientId,
    clientName,
    lastConnected: typeof config.lastConnected === 'string' ? config.lastConnected : ''
  };

  if (typeof config.sessionToken === 'string' && config.sessionToken.trim()) {
    normalized.sessionToken = config.sessionToken.trim();
  }
  if (typeof config.inviteSecret === 'string' && config.inviteSecret.trim()) {
    normalized.inviteSecret = config.inviteSecret.trim();
  }
  if (typeof config.managementCertFingerprint === 'string' && config.managementCertFingerprint.trim()) {
    normalized.managementCertFingerprint = config.managementCertFingerprint.trim();
  }

  return normalized;
}

/**
 * Detects Minecraft version from server JAR files and other recoverable metadata.
 * @param {string} serverPath - Path to the server directory
 * @returns {string|null} Detected version or null if not found
 */
function detectMinecraftVersion(serverPath) {
  getLogger().debug('Starting Minecraft version detection', {
    category: 'settings',
    data: {
      function: 'detectMinecraftVersion',
      serverPath,
      pathExists: fs.existsSync(serverPath)
    }
  });

  try {
    if (!serverPath || !fs.existsSync(serverPath)) {
      getLogger().warn('Server path does not exist for version detection', {
        category: 'settings',
        data: {
          function: 'detectMinecraftVersion',
          serverPath,
          reason: 'path_not_found'
        }
      });
      return null;
    }

    const files = fs.readdirSync(serverPath);
    const serverJars = files.filter(file =>
      file.endsWith('.jar') && (
        file.includes('server') ||
        file.includes('minecraft') ||
        file.includes('paper') ||
        file.includes('forge') ||
        file.includes('fabric') ||
        file === 'fabric-server-launch.jar'
      )
    );

    for (const jarName of serverJars) {
      const versionMatch = jarName.match(/(\d+\.\d+(?:\.\d+)?)/);
      if (versionMatch) {
        return versionMatch[1];
      }
    }

    const versionPath = path.join(serverPath, 'version.json');
    if (fs.existsSync(versionPath)) {
      try {
        const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
        if (versionData.name || versionData.id) {
          return versionData.name || versionData.id;
        }
      } catch {
        // Ignore and continue with other sources
      }
    }

    const fabricLoaderPath = path.join(serverPath, '.fabric', 'remappedJars');
    if (fs.existsSync(fabricLoaderPath)) {
      const fabricFiles = fs.readdirSync(fabricLoaderPath);
      for (const file of fabricFiles) {
        const match = file.match(/minecraft-(\d+\.\d+(?:\.\d+)?)/);
        if (match) {
          return match[1];
        }
      }
    }

    const latestLogPath = path.join(serverPath, 'logs', 'latest.log');
    if (fs.existsSync(latestLogPath)) {
      try {
        const logContent = fs.readFileSync(latestLogPath, 'utf8');
        const versionMatch = logContent.match(/Starting minecraft server version (\d+\.\d+(?:\.\d+)?)|Minecraft (\d+\.\d+(?:\.\d+)?)|version (\d+\.\d+(?:\.\d+)?)/i);
        if (versionMatch) {
          return versionMatch[1] || versionMatch[2] || versionMatch[3] || null;
        }
      } catch {
        // Ignore and continue
      }
    }

    return null;
  } catch (error) {
    getLogger().error(`Version detection failed: ${error.message}`, {
      category: 'settings',
      data: {
        function: 'detectMinecraftVersion',
        serverPath,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
    return null;
  }
}

function readServerConfig(serverPath, defaultSettings = {}) {
  if (!serverPath || !fs.existsSync(serverPath)) {
    return null;
  }

  const configPath = getServerConfigPath(serverPath);
  let parsedConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      getLogger().warn('Failed to parse server config, falling back to defaults', {
        category: 'settings',
        data: {
          function: 'readServerConfig',
          serverPath,
          configPath,
          errorType: error.constructor.name,
          errorMessage: error.message
        }
      });
      parsedConfig = {};
    }
  }

  return normalizeServerConfig(parsedConfig, defaultSettings, serverPath);
}

function writeServerConfig(serverPath, config, defaultSettings = {}) {
  if (!serverPath) {
    return null;
  }

  if (!fs.existsSync(serverPath)) {
    fs.mkdirSync(serverPath, { recursive: true });
  }

  const normalized = normalizeServerConfig(config, defaultSettings, serverPath);
  const configPath = getServerConfigPath(serverPath);
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function updateServerConfig(serverPath, updates, defaultSettings = {}) {
  const current = readServerConfig(serverPath, defaultSettings)
    || getDefaultServerConfig(defaultSettings);
  const nextPartial = typeof updates === 'function' ? updates(cloneValue(current)) : { ...current, ...(updates || {}) };
  return writeServerConfig(serverPath, nextPartial, defaultSettings);
}

/**
 * Ensures a .minecraft-core.json config file exists in the given server directory.
 *
 * @param {string} serverPath - Path to the server directory
 * @param {object} defaultSettings - Default settings to use if config doesn't exist
 * @returns {object} The current config (either existing or newly created)
 */
function ensureConfigFile(serverPath, defaultSettings = {}) {
  getLogger().debug('Ensuring config file exists', {
    category: 'settings',
    data: {
      function: 'ensureConfigFile',
      serverPath,
      hasDefaultSettings: Object.keys(defaultSettings).length > 0,
      defaultSettingsKeys: Object.keys(defaultSettings)
    }
  });

  if (!serverPath) {
    getLogger().warn('No server path provided for config file', {
      category: 'settings',
      data: {
        function: 'ensureConfigFile',
        reason: 'no_server_path'
      }
    });
    return null;
  }

  try {
    if (!fs.existsSync(serverPath)) {
      getLogger().warn('Server directory does not exist', {
        category: 'settings',
        data: {
          function: 'ensureConfigFile',
          serverPath,
          reason: 'directory_not_found'
        }
      });
      return null;
    }

    const config = readServerConfig(serverPath, defaultSettings)
      || getDefaultServerConfig(defaultSettings);
    return writeServerConfig(serverPath, config, defaultSettings);
  } catch (error) {
    getLogger().error(`Config file management failed: ${error.message}`, {
      category: 'settings',
      data: {
        function: 'ensureConfigFile',
        serverPath,
        errorType: error.constructor.name,
        errorMessage: error.message,
        stack: error.stack
      }
    });
    return null;
  }
}

function readClientConfig(clientPath) {
  if (!clientPath || !fs.existsSync(clientPath)) {
    return null;
  }

  const configPath = getClientConfigPath(clientPath);
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return normalizeClientConfig(parsed);
  } catch (error) {
    getLogger().warn('Failed to read client config', {
      category: 'settings',
      data: {
        function: 'readClientConfig',
        clientPath,
        configPath,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
    return null;
  }
}

/**
 * Gets instance-specific configuration
 * @param {string} instanceId - Instance identifier
 * @param {string} configKey - Configuration key to retrieve
 * @returns {Promise<any>} Configuration value
 */
async function getInstanceConfig(instanceId, configKey) {
  getLogger().debug('Getting instance configuration', {
    category: 'settings',
    data: {
      function: 'getInstanceConfig',
      instanceId,
      configKey
    }
  });

  try {
    const appStore = require('./app-store.cjs');
    const instanceConfigs = await appStore.get('instanceConfigs') || {};

    const instanceConfig = instanceConfigs[instanceId] || {};
    const value = instanceConfig[configKey];

    getLogger().debug('Instance configuration retrieved', {
      category: 'settings',
      data: {
        function: 'getInstanceConfig',
        instanceId,
        configKey,
        hasValue: value !== undefined,
        valueType: typeof value
      }
    });

    return value;
  } catch (error) {
    getLogger().error(`Failed to get instance config: ${error.message}`, {
      category: 'settings',
      data: {
        function: 'getInstanceConfig',
        instanceId,
        configKey,
        errorType: error.constructor.name
      }
    });
    return undefined;
  }
}

/**
 * Sets instance-specific configuration
 * @param {string} instanceId - Instance identifier
 * @param {string} configKey - Configuration key to set
 * @param {any} value - Configuration value
 * @returns {Promise<void>}
 */
async function setInstanceConfig(instanceId, configKey, value) {
  getLogger().debug('Setting instance configuration', {
    category: 'settings',
    data: {
      function: 'setInstanceConfig',
      instanceId,
      configKey,
      valueType: typeof value
    }
  });

  try {
    const appStore = require('./app-store.cjs');
    const instanceConfigs = await appStore.get('instanceConfigs') || {};

    if (!instanceConfigs[instanceId]) {
      instanceConfigs[instanceId] = {};
    }

    instanceConfigs[instanceId][configKey] = value;

    appStore.set('instanceConfigs', instanceConfigs);

    getLogger().info('Instance configuration updated', {
      category: 'settings',
      data: {
        function: 'setInstanceConfig',
        instanceId,
        configKey,
        valueType: typeof value
      }
    });
  } catch (error) {
    getLogger().error(`Failed to set instance config: ${error.message}`, {
      category: 'settings',
      data: {
        function: 'setInstanceConfig',
        instanceId,
        configKey,
        errorType: error.constructor.name
      }
    });
    throw error;
  }
}

module.exports = {
  SERVER_CONFIG_FILENAME,
  CLIENT_CONFIG_FILENAME,
  DEFAULT_AUTO_RESTART,
  DEFAULT_BACKUP_AUTOMATION,
  getDefaultServerConfig,
  getServerConfigPath,
  getClientConfigPath,
  ensureConfigFile,
  detectMinecraftVersion,
  readServerConfig,
  writeServerConfig,
  updateServerConfig,
  readClientConfig,
  normalizeClientConfig,
  getInstanceConfig,
  setInstanceConfig
};
