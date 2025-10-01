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

function detectLoaderFromFiles(serverPath) {
  if (!serverPath || !fs.existsSync(serverPath)) {
    return { loader: null, loaderVersion: null, detectedFrom: 'none' };
  }

  try {
    const entries = fs.readdirSync(serverPath, { withFileTypes: true });
    const fileNames = entries.map(entry => entry.name.toLowerCase());
    const fileSet = new Set(fileNames);

    const hasFabricLauncher = fileSet.has('fabric-server-launch.jar') || fileSet.has('fabric-server-launch.jar'.toLowerCase());
    const fabricDir = path.join(serverPath, '.fabric');
    if (hasFabricLauncher || fs.existsSync(fabricDir)) {
      return { loader: 'fabric', loaderVersion: null, detectedFrom: hasFabricLauncher ? 'fabric-launcher' : 'fabric-directory' };
    }

    const neoforgeEntry = fileNames.find(name => name.includes('neoforge'));
    if (neoforgeEntry) {
      const versionMatch = neoforgeEntry.match(/neoforge[.-]?([\d.]+)/);
      return {
        loader: 'neoforge',
        loaderVersion: versionMatch ? versionMatch[1] : null,
        detectedFrom: 'neoforge-jar'
      };
    }

    const forgeEntry = fileNames.find(name => name.includes('forge'));
    if (forgeEntry) {
      const versionMatch = forgeEntry.match(/forge[.-]?([\d.]+)/);
      return {
        loader: 'forge',
        loaderVersion: versionMatch ? versionMatch[1] : null,
        detectedFrom: 'forge-jar'
      };
    }

    const quiltEntry = fileNames.find(name => name.includes('quilt')); // Check for Quilt server jars
    if (quiltEntry) {
      const versionMatch = quiltEntry.match(/quilt[.-]?([\d.]+)/);
      return {
        loader: 'quilt',
        loaderVersion: versionMatch ? versionMatch[1] : null,
        detectedFrom: 'quilt-jar'
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

  const config = readServerConfig(serverPath);
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
    const detected = detectLoaderFromFiles(serverPath);
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
