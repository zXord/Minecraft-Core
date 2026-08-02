const fs = require('fs');
const path = require('path');

let logger = null;
const getLogger = () => {
  if (!logger) {
    try {
      const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
      logger = getLoggerHandlers();
    } catch {
      logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
      };
    }
  }
  return logger;
};

const loaderAliasMap = {
  'fabricloader': 'fabric',
  'fabric-loader': 'fabric',
  'fabric_mc': 'fabric',
  'neo-forge': 'neoforge',
  'neo_forge': 'neoforge',
  'neo.forge': 'neoforge',
  'forge-loader': 'forge',
  'forge_client': 'forge',
  'quilt-loader': 'quilt',
  'quiltloader': 'quilt',
  'paperclip': 'paper',
  'paper-server': 'paper',
  'purpur-server': 'purpur',
  'spigot-server': 'spigot',
  'bukkit-server': 'bukkit'
};

const normalizeLoader = (value) => {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  return loaderAliasMap[normalized] || normalized;
};

function runtimeIncomplete() {
  const error = new Error('The prepared server runtime is incomplete.');
  error.code = 'RUNTIME_INCOMPLETE';
  return error;
}

const loaderVersionKeys = ['loaderVersion', 'loader_version', 'loader-version'];
const loaderTypeKeys = ['loader', 'loaderType', 'loader_type', 'modLoader', 'serverLoader'];
const loaderByVersionKey = {
  fabric: ['fabric'],
  forge: ['forge'],
  neoforge: ['neoforge', 'neoForge'],
  quilt: ['quilt'],
  liteloader: ['liteloader', 'liteLoader'],
  rift: ['rift'],
  paper: ['paper'],
  purpur: ['purpur'],
  spigot: ['spigot'],
  bukkit: ['bukkit']
};

function readServerConfig(serverPath) {
  if (!serverPath) {
    return null;
  }
  try {
    const configPath = path.join(serverPath, '.minecraft-core.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (error) {
    getLogger().warn('Failed to read server config for loader detection', {
      category: 'mods',
      data: {
        service: 'server-loader',
        operation: 'readServerConfig',
        serverPath,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
    return null;
  }
}

function detectExactPreparedRuntime(serverPath) {
  const metadataPath = path.join(serverPath, '.minecraft-core-state', 'runtime.json');
  try {
    const stat = fs.lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 2 * 1024 * 1024) throw runtimeIncomplete();
    const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const runtime = parsed?.runtime;
    if (!runtime || !['neoforge', 'quilt'].includes(runtime.loaderFamily)) throw runtimeIncomplete();
    const { validatePreparedRuntime } = require('../services/loader-install-service.cjs');
    const validation = validatePreparedRuntime(serverPath, runtime);
    return {
      loader: validation.runtime.loaderFamily,
      loaderVersion: validation.runtime.loaderVersion,
      detectedFrom: 'runtime-metadata'
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'RUNTIME_INCOMPLETE') throw error;
    throw runtimeIncomplete();
  }
}

function detectLoaderFromFiles(serverPath, preparedRuntime = undefined) {
  if (!serverPath || !fs.existsSync(serverPath)) {
    return { loader: null, loaderVersion: null, detectedFrom: 'none' };
  }

  try {
    const exactRuntime = preparedRuntime === undefined ? detectExactPreparedRuntime(serverPath) : preparedRuntime;
    if (exactRuntime) return exactRuntime;

    const entries = fs.readdirSync(serverPath, { withFileTypes: true });
    const fileNames = entries.map(entry => entry.name.toLowerCase());
    const fileSet = new Set(fileNames);

    const hasFabricLauncher = fileSet.has('fabric-server-launch.jar') || fileSet.has('fabric-server-launch.jar'.toLowerCase());
    const fabricDir = path.join(serverPath, '.fabric');
    if (hasFabricLauncher || fs.existsSync(fabricDir)) {
      return { loader: 'fabric', loaderVersion: null, detectedFrom: hasFabricLauncher ? 'fabric-launcher' : 'fabric-directory' };
    }

    const forgeEntry = fileNames.find(name => name.includes('forge') && !name.includes('neoforge'));
    if (forgeEntry) {
      const versionMatch = forgeEntry.match(/forge[.-]?([\d.]+)/);
      return {
        loader: 'forge',
        loaderVersion: versionMatch ? versionMatch[1] : null,
        detectedFrom: 'forge-jar'
      };
    }

    const paperEntry = fileNames.find(name => name.includes('paper') && name.endsWith('.jar'));
    if (paperEntry) {
      const versionMatch = paperEntry.match(/paper[.-]?([\d.]+)/);
      return {
        loader: 'paper',
        loaderVersion: versionMatch ? versionMatch[1] : null,
        detectedFrom: 'paper-jar'
      };
    }

    const purpurEntry = fileNames.find(name => name.includes('purpur') && name.endsWith('.jar'));
    if (purpurEntry) {
      const versionMatch = purpurEntry.match(/purpur[.-]?([\d.]+)/);
      return {
        loader: 'purpur',
        loaderVersion: versionMatch ? versionMatch[1] : null,
        detectedFrom: 'purpur-jar'
      };
    }

    const spigotEntry = fileNames.find(name => name.includes('spigot') && name.endsWith('.jar'));
    if (spigotEntry) {
      const versionMatch = spigotEntry.match(/spigot[.-]?([\d.]+)/);
      return {
        loader: 'spigot',
        loaderVersion: versionMatch ? versionMatch[1] : null,
        detectedFrom: 'spigot-jar'
      };
    }

    const bukkitEntry = fileNames.find(name => name.includes('bukkit') && name.endsWith('.jar'));
    if (bukkitEntry) {
      const versionMatch = bukkitEntry.match(/bukkit[.-]?([\d.]+)/);
      return {
        loader: 'bukkit',
        loaderVersion: versionMatch ? versionMatch[1] : null,
        detectedFrom: 'bukkit-jar'
      };
    }
  } catch (error) {
    if (error?.code === 'RUNTIME_INCOMPLETE') throw error;
    getLogger().warn('Failed to inspect server files for loader detection', {
      category: 'mods',
      data: {
        service: 'server-loader',
        operation: 'detectLoaderFromFiles',
        serverPath,
        errorType: error.constructor.name,
        errorMessage: error.message
      }
    });
  }

  return { loader: null, loaderVersion: null, detectedFrom: 'none' };
}

function resolveServerLoader(serverPath) {
  const loggerInstance = getLogger();
  const result = {
    loader: null,
    loaderVersion: null,
    source: 'unknown'
  };

  const preparedRuntime = serverPath ? detectExactPreparedRuntime(serverPath) : null;
  if (preparedRuntime) {
    result.loader = preparedRuntime.loader;
    result.loaderVersion = preparedRuntime.loaderVersion;
    result.source = preparedRuntime.detectedFrom;
  }
  const config = preparedRuntime ? null : readServerConfig(serverPath);
  if (config) {
    for (const key of loaderTypeKeys) {
      if (config[key]) {
        result.loader = normalizeLoader(config[key]);
        result.source = `config:${key}`;
        break;
      }
    }

    if (!result.loader) {
      for (const [candidateLoader, versionKeys] of Object.entries(loaderByVersionKey)) {
        for (const versionKey of versionKeys) {
          if (config[versionKey]) {
            result.loader = candidateLoader;
            result.source = `config:${versionKey}`;
            result.loaderVersion = String(config[versionKey]).trim();
            break;
          }
        }
        if (result.loader) {
          break;
        }
      }
    }

    if (!result.loaderVersion) {
      for (const versionKey of loaderVersionKeys) {
        if (config[versionKey]) {
          result.loaderVersion = String(config[versionKey]).trim();
          if (!result.loader) {
            // Attempt to derive loader type from version value when not explicitly set
            result.loader = normalizeLoader(config[versionKey]);
            result.source = `config:${versionKey}`;
          }
          break;
        }
      }
    }

    if (result.loader && !result.loaderVersion) {
      const normalizedLoader = result.loader.toLowerCase();
      const versionKeys = loaderByVersionKey[normalizedLoader];
      if (versionKeys) {
        for (const versionKey of versionKeys) {
          if (config[versionKey]) {
            result.loaderVersion = String(config[versionKey]).trim();
            break;
          }
        }
      }
    }
  }

  if (!result.loader) {
    const detected = detectLoaderFromFiles(serverPath, preparedRuntime);
    if (detected.loader) {
      result.loader = detected.loader;
      result.loaderVersion = detected.loaderVersion || result.loaderVersion;
      result.source = detected.detectedFrom;
    }
  }

  if (!result.loader) {
    result.loader = null;
    result.source = result.source === 'unknown' ? 'undetected' : result.source;
  }

  loggerInstance.debug('Resolved server loader', {
    category: 'mods',
    data: {
      service: 'server-loader',
      operation: 'resolveServerLoader',
      serverPath,
      loader: result.loader,
      loaderVersion: result.loaderVersion,
      source: result.source
    }
  });

  return result;
}

module.exports = {
  resolveServerLoader,
  normalizeLoaderName: normalizeLoader
};
