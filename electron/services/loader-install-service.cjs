const { safeSend } = require('../utils/safe-send.cjs');
const { installFabric: installFabricXmcl, getLoaderArtifactListFor, installForge, getForgeVersionList, installVersion, installLibraries } = require('@xmcl/installer');
const { Version, MinecraftFolder } = require('@xmcl/core');
const { installFabric: installFabricLegacy } = require('./download-manager.cjs');
const fs = require('fs');
const path = require('path');
const https = require('https');

let logger = null;
function getLogger() {
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
}

function normalizeLoader(loader) {
  const normalized = typeof loader === 'string' ? loader.trim().toLowerCase() : '';
  if (!normalized) {
    return 'vanilla';
  }
  if (normalized === 'fabric') return 'fabric';
  if (normalized === 'forge') return 'forge';
  return normalized;
}

function emitProgress(progressChannel, payload, loader) {
  safeSend(progressChannel, payload);
  if (loader === 'fabric') {
    safeSend('fabric-install-progress', payload);
  }
}

function emitLog(logChannel, message) {
  safeSend(logChannel, message);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const statusCode = response.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        const redirectedUrl = new URL(response.headers.location, url).toString();
        fetchText(redirectedUrl).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Request failed for ${url}: ${statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function compareNumericVersionDesc(left, right) {
  const leftParts = String(left).split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = String(right).split(/[^0-9]+/).filter(Boolean).map(Number);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return rightPart - leftPart;
    }
  }

  return String(right).localeCompare(String(left));
}

async function getForgeVersionsFromMetadata(minecraftVersion) {
  const metadataXml = await fetchText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
  const versionMatches = [...metadataXml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const prefix = `${minecraftVersion}-`;

  return versionMatches
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .filter(Boolean)
    .sort(compareNumericVersionDesc);
}

async function getForgeVersionsFromPromotions(minecraftVersion) {
  const promotionsJson = await fetchText('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const promotions = JSON.parse(promotionsJson).promos || {};
  const versions = [];

  for (const suffix of ['latest', 'recommended']) {
    const version = promotions[`${minecraftVersion}-${suffix}`];
    if (version) {
      versions.push(version);
    }
  }

  return versions;
}

async function getForgeVersionsWithFallback(minecraftVersion) {
  const loggerInstance = getLogger();

  try {
    const list = await getForgeVersionList({ minecraft: minecraftVersion });
    const xmclVersions = (list.versions || [])
      .map((entry) => entry.version)
      .filter(Boolean)
      .sort(compareNumericVersionDesc);

    if (xmclVersions.length > 0) {
      return [...new Set(xmclVersions)];
    }
  } catch (error) {
    loggerInstance.warn('XMCL Forge version lookup failed, falling back to Forge metadata', {
      category: 'mods',
      data: {
        service: 'LoaderInstallService',
        operation: 'getForgeVersionsWithFallback',
        minecraftVersion,
        error: error.message
      }
    });
  }

  const [metadataVersions, promotedVersions] = await Promise.all([
    getForgeVersionsFromMetadata(minecraftVersion).catch(() => []),
    getForgeVersionsFromPromotions(minecraftVersion).catch(() => [])
  ]);

  return [...new Set([...promotedVersions, ...metadataVersions])];
}

async function getMinecraftVersionMetadata(minecraftVersion) {
  const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  const versionInfo = Array.isArray(manifest.versions)
    ? manifest.versions.find((entry) => entry.id === minecraftVersion)
    : null;

  if (!versionInfo?.url) {
    throw new Error(`Minecraft version metadata not found for ${minecraftVersion}`);
  }

  return versionInfo;
}

function resolveForgeVersionId(targetPath, minecraftVersion, loaderVersion) {
  const candidate = `${minecraftVersion}-forge-${loaderVersion}`;
  const candidatePath = path.join(targetPath, 'versions', candidate);
  if (fs.existsSync(candidatePath)) {
    return candidate;
  }

  const versionsRoot = path.join(targetPath, 'versions');
  if (!fs.existsSync(versionsRoot)) {
    return candidate;
  }

  const fallback = fs.readdirSync(versionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .find((entry) => entry.startsWith(`${minecraftVersion}-forge-`) && entry.includes(loaderVersion));

  return fallback || candidate;
}

function ensureForgeRootShim(targetPath, minecraftVersion, loaderVersion) {
  if (!targetPath || !minecraftVersion || !loaderVersion) {
    return null;
  }

  const shimName = `forge-${minecraftVersion}-${loaderVersion}-shim.jar`;
  const sourceShimPath = path.join(
    targetPath,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    `${minecraftVersion}-${loaderVersion}`,
    shimName
  );

  if (!fs.existsSync(sourceShimPath)) {
    return null;
  }

  const rootShimPath = path.join(targetPath, shimName);
  const shouldCopy = !fs.existsSync(rootShimPath)
    || fs.statSync(rootShimPath).size !== fs.statSync(sourceShimPath).size;

  if (shouldCopy) {
    fs.copyFileSync(sourceShimPath, rootShimPath);
  }

  return rootShimPath;
}

async function ensureBaseMinecraftServerLayout(targetPath, minecraftVersion, logChannel, progressChannel) {
  emitLog(logChannel, `🧱 Preparing Minecraft ${minecraftVersion} server runtime...`);
  emitProgress(progressChannel, { percent: 20, speed: 'Resolving Minecraft server metadata...' }, 'forge');

  const versionManifestEntry = await getMinecraftVersionMetadata(minecraftVersion);
  await installVersion(versionManifestEntry, targetPath, { side: 'server' });

  const minecraftFolder = MinecraftFolder.from(targetPath);
  const rootServerJar = path.join(targetPath, 'server.jar');
  const versionedServerJar = minecraftFolder.getVersionJar(minecraftVersion, 'server');
  if (!fs.existsSync(rootServerJar) && fs.existsSync(versionedServerJar)) {
    fs.copyFileSync(versionedServerJar, rootServerJar);
  }

  emitProgress(progressChannel, { percent: 40, speed: 'Minecraft server runtime prepared' }, 'forge');
}

async function ensureForgeServerLibraries(targetPath, minecraftVersion, loaderVersion, logChannel, progressChannel) {
  const forgeVersionId = resolveForgeVersionId(targetPath, minecraftVersion, loaderVersion);
  emitLog(logChannel, `📚 Installing Forge runtime libraries for ${forgeVersionId}...`);
  emitProgress(progressChannel, { percent: 80, speed: 'Downloading Forge libraries...' }, 'forge');

  const resolvedForgeVersion = await Version.parse(targetPath, forgeVersionId);
  await installLibraries(resolvedForgeVersion);
  ensureForgeRootShim(targetPath, minecraftVersion, loaderVersion);

  emitProgress(progressChannel, { percent: 95, speed: 'Forge libraries ready' }, 'forge');
  return forgeVersionId;
}

async function getForgeRuntimeHealthIssues(targetPath, minecraftVersion, loaderVersion) {
  const issues = [];

  if (!minecraftVersion || !loaderVersion) {
    issues.push('Forge version metadata');
    return issues;
  }

  const minecraftFolder = MinecraftFolder.from(targetPath);
  const baseVersionJson = path.join(targetPath, 'versions', minecraftVersion, `${minecraftVersion}.json`);
  const baseServerJar = minecraftFolder.getVersionJar(minecraftVersion, 'server');
  const rootShimJar = path.join(targetPath, `forge-${minecraftVersion}-${loaderVersion}-shim.jar`);
  if (!fs.existsSync(baseVersionJson)) {
    issues.push(`Minecraft ${minecraftVersion} version metadata`);
  }
  if (!fs.existsSync(baseServerJar)) {
    issues.push(`Minecraft ${minecraftVersion} server runtime jar`);
  }

  try {
    const forgeVersionId = resolveForgeVersionId(targetPath, minecraftVersion, loaderVersion);
    const forgeVersionRoot = path.join(targetPath, 'versions', forgeVersionId);
    if (!fs.existsSync(forgeVersionRoot)) {
      issues.push('Forge version metadata');
      return issues;
    }

    if (!fs.existsSync(rootShimJar)) {
      issues.push('Forge shim jar');
    }

    const resolvedForgeVersion = await Version.parse(targetPath, forgeVersionId);
    const missingLibraries = resolvedForgeVersion.libraries.filter((library) => {
      const relativePath = library?.download?.path;
      if (!relativePath) {
        return false;
      }
      return !fs.existsSync(minecraftFolder.getLibraryByPath(relativePath));
    });

    if (missingLibraries.length > 0) {
      issues.push(`Forge libraries missing (${missingLibraries.length})`);
    }
  } catch (error) {
    getLogger().warn('Failed to inspect Forge runtime health', {
      category: 'mods',
      data: {
        service: 'LoaderInstallService',
        operation: 'getForgeRuntimeHealthIssues',
        targetPath,
        minecraftVersion,
        loaderVersion,
        error: error.message
      }
    });
    issues.push('Forge runtime metadata');
  }

  return [...new Set(issues)];
}

async function getLoaderVersions(loader, minecraftVersion) {
  const normalizedLoader = normalizeLoader(loader);

  if (!minecraftVersion || normalizedLoader === 'vanilla') {
    return [];
  }

  if (normalizedLoader === 'fabric') {
    const versions = await getLoaderArtifactListFor(minecraftVersion);
    return versions.map((entry) => entry.loader.version);
  }

  if (normalizedLoader === 'forge') {
    return getForgeVersionsWithFallback(minecraftVersion);
  }

  return [];
}

async function installFabricServer(options) {
  const {
    targetPath,
    minecraftVersion,
    loaderVersion,
    javaPath,
    logChannel = 'install-log',
    progressChannel = 'loader-install-progress'
  } = options;

  // Keep using the existing installer path for server installs because it already
  // writes the expected Fabric server launch artifacts into the target folder.
  await installFabricLegacy(
    targetPath,
    minecraftVersion,
    loaderVersion,
    logChannel,
    progressChannel,
    { javaPath }
  );

  return {
    success: true,
    loader: 'fabric',
    loaderVersion
  };
}

async function installForgeServer(options) {
  const loggerInstance = getLogger();
  const {
    targetPath,
    minecraftVersion,
    loaderVersion,
    javaPath,
    logChannel = 'install-log',
    progressChannel = 'loader-install-progress'
  } = options;

  emitLog(logChannel, `🔧 Installing Forge ${loaderVersion} for Minecraft ${minecraftVersion}...`);
  emitProgress(progressChannel, { percent: 10, speed: 'Preparing Forge installer...' }, 'forge');

  loggerInstance.info('Starting Forge server installation', {
    category: 'mods',
    data: {
      service: 'LoaderInstallService',
      operation: 'installForgeServer',
      targetPath,
      minecraftVersion,
      loaderVersion
    }
  });

  await ensureBaseMinecraftServerLayout(targetPath, minecraftVersion, logChannel, progressChannel);
  emitProgress(progressChannel, { percent: 55, speed: 'Running Forge installer...' }, 'forge');

  await installForge(
    {
      version: loaderVersion,
      mcversion: minecraftVersion
    },
    targetPath,
    {
      side: 'server',
      java: javaPath
    }
  );

  const forgeVersionId = await ensureForgeServerLibraries(
    targetPath,
    minecraftVersion,
    loaderVersion,
    logChannel,
    progressChannel
  );
  ensureForgeRootShim(targetPath, minecraftVersion, loaderVersion);

  emitProgress(progressChannel, { percent: 100, speed: 'Completed' }, 'forge');
  emitLog(logChannel, '✔ Forge installation completed');

  loggerInstance.info('Forge server installation completed', {
    category: 'mods',
    data: {
      service: 'LoaderInstallService',
      operation: 'installForgeServer',
      targetPath,
      minecraftVersion,
      loaderVersion,
      forgeVersionId,
      success: true
    }
  });

  return {
    success: true,
    loader: 'forge',
    loaderVersion
  };
}

async function installServerLoader(options = {}) {
  const loggerInstance = getLogger();
  const normalizedLoader = normalizeLoader(options.loader);
  const resultBase = {
    success: true,
    loader: normalizedLoader,
    loaderVersion: options.loaderVersion || null
  };

  loggerInstance.info('Installing server loader', {
    category: 'mods',
    data: {
      service: 'LoaderInstallService',
      operation: 'installServerLoader',
      loader: normalizedLoader,
      loaderVersion: options.loaderVersion || null,
      minecraftVersion: options.minecraftVersion || null,
      targetPath: options.targetPath || null
    }
  });

  if (normalizedLoader === 'vanilla') {
    if (options.logChannel) {
      emitLog(options.logChannel, '✔ Vanilla server selected. No loader installation needed.');
    }
    if (options.progressChannel) {
      emitProgress(options.progressChannel, { percent: 100, speed: 'Completed' }, normalizedLoader);
    }
    return resultBase;
  }

  if (!options.loaderVersion) {
    const error = new Error(`${normalizedLoader} loader version is required.`);
    error.code = 'LOADER_VERSION_REQUIRED';
    throw error;
  }

  if (normalizedLoader === 'fabric') {
    const result = await installFabricServer(options);
    return { ...resultBase, ...result };
  }

  if (normalizedLoader === 'forge') {
    const result = await installForgeServer(options);
    return { ...resultBase, ...result };
  }

  const error = new Error(`Unsupported loader: ${normalizedLoader}`);
  error.code = 'UNSUPPORTED_LOADER';
  throw error;
}

async function installClientLoader(options = {}) {
  const normalizedLoader = normalizeLoader(options.loader);

  if (normalizedLoader === 'vanilla') {
    return {
      success: true,
      loader: 'vanilla',
      loaderVersion: null,
      profileId: options.minecraftVersion
    };
  }

  if (normalizedLoader === 'fabric') {
    const versionId = await installFabricXmcl({
      minecraftVersion: options.minecraftVersion,
      version: options.loaderVersion,
      minecraft: options.clientPath,
      side: 'client'
    });
    return {
      success: true,
      loader: 'fabric',
      loaderVersion: options.loaderVersion,
      profileId: versionId
    };
  }

  if (normalizedLoader === 'forge') {
    const versionId = await installForge(
      {
        version: options.loaderVersion,
        mcversion: options.minecraftVersion
      },
      options.clientPath,
      {
        side: 'client',
        java: options.javaPath
      }
    );
    return {
      success: true,
      loader: 'forge',
      loaderVersion: options.loaderVersion,
      profileId: versionId
    };
  }

  throw new Error(`Unsupported client loader: ${normalizedLoader}`);
}

module.exports = {
  normalizeLoader,
  getLoaderVersions,
  installServerLoader,
  installClientLoader,
  getForgeRuntimeHealthIssues
};
