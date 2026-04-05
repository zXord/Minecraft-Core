const { safeSend } = require('../utils/safe-send.cjs');
const {
  installFabric: installFabricXmcl,
  getLoaderArtifactListFor,
  installForge,
  getForgeVersionList,
  installVersion,
  installLibraries,
  walkForgeInstallerEntries,
  unpackForgeInstaller,
  installByProfileTask,
  isForgeInstallerEntries
} = require('@xmcl/installer');
const { Version, MinecraftFolder } = require('@xmcl/core');
const { open: openZip, readEntry } = require('@xmcl/unzip');
const fs = require('fs');
const path = require('path');
const https = require('https');
const fetch = require('node-fetch');

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

function getForgeArtifactVersion(minecraftVersion, loaderVersion) {
  if (!minecraftVersion || !loaderVersion) {
    return null;
  }

  const [_, minor] = String(minecraftVersion).split('.');
  const minorVersion = Number.parseInt(minor, 10);
  const normalizedLoaderVersion = String(loaderVersion);

  if (minorVersion >= 7 && minorVersion <= 8) {
    return `${minecraftVersion}-${normalizedLoaderVersion}-${minecraftVersion}`;
  }

  if (normalizedLoaderVersion.startsWith(`${minecraftVersion}`)) {
    return normalizedLoaderVersion;
  }

  return `${minecraftVersion}-${normalizedLoaderVersion}`;
}

function getForgeInstallerPath(targetPath, minecraftVersion, loaderVersion) {
  const artifactVersion = getForgeArtifactVersion(minecraftVersion, loaderVersion);
  if (!targetPath || !artifactVersion) {
    return null;
  }

  return path.join(
    targetPath,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    artifactVersion,
    `forge-${artifactVersion}-installer.jar`
  );
}

async function clearStaleForgeInstaller(targetPath, minecraftVersion, loaderVersion) {
  const installerPath = getForgeInstallerPath(targetPath, minecraftVersion, loaderVersion);
  if (!installerPath || !fs.existsSync(installerPath)) {
    return { installerPath, removed: false };
  }

  try {
    try {
      fs.chmodSync(installerPath, 0o666);
    } catch {
      // Best effort only. Some synced folders keep their own ACLs.
    }

    await fs.promises.rm(installerPath, {
      force: true,
      maxRetries: 6,
      retryDelay: 250
    });
    return { installerPath, removed: true };
  } catch (error) {
    getLogger().warn('Failed to remove stale Forge installer artifact before retry', {
      category: 'client',
      data: {
        service: 'LoaderInstallService',
        operation: 'clearStaleForgeInstaller',
        installerPath,
        error: error?.message || String(error)
      }
    });
    return { installerPath, removed: false, error };
  }
}

function isForgeInstallerOpenError(error, installerPath) {
  const message = error?.message || '';
  if (!installerPath || !message) {
    return false;
  }

  const normalizedInstallerPath = path.normalize(installerPath).toLowerCase();
  const normalizedMessage = String(message).replaceAll('/', path.sep).toLowerCase();

  return /eperm|ebusy|operation not permitted|resource busy/i.test(normalizedMessage)
    && normalizedMessage.includes(normalizedInstallerPath);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadFileBuffer(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Minecraft-Core/LoaderInstallService'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function getForgeInstallerDownloadUrls(minecraftVersion, loaderVersion) {
  const artifactVersion = getForgeArtifactVersion(minecraftVersion, loaderVersion);
  if (!artifactVersion) {
    return [];
  }

  const relativePath = `net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}-installer.jar`;

  return [
    `https://maven.minecraftforge.net/${relativePath}`,
    `https://files.minecraftforge.net/maven/${relativePath}`,
    `http://files.minecraftforge.net/maven/${relativePath}`
  ];
}

async function canReadForgeInstallerJar(installerPath, minecraftVersion, loaderVersion) {
  if (!installerPath || !fs.existsSync(installerPath)) {
    return false;
  }

  const forgeArtifactVersion = getForgeArtifactVersion(minecraftVersion, loaderVersion);
  if (!forgeArtifactVersion) {
    return false;
  }

  let zip;
  try {
    zip = await openZip(installerPath, { lazyEntries: true, autoClose: false });
    const entries = await walkForgeInstallerEntries(zip, forgeArtifactVersion);
    return !!entries.installProfileJson && !!entries.versionJson;
  } catch {
    return false;
  } finally {
    try {
      zip?.close();
    } catch {
      // Ignore zip close errors during validation.
    }
  }
}

async function stageForgeInstallerJar(targetPath, minecraftVersion, loaderVersion) {
  const installerPath = getForgeInstallerPath(targetPath, minecraftVersion, loaderVersion);
  if (!installerPath) {
    throw new Error('Unable to resolve Forge installer path');
  }

  if (await canReadForgeInstallerJar(installerPath, minecraftVersion, loaderVersion)) {
    return installerPath;
  }

  await fs.promises.mkdir(path.dirname(installerPath), { recursive: true });
  await clearStaleForgeInstaller(targetPath, minecraftVersion, loaderVersion);

  const stagedPath = `${installerPath}.download`;
  await fs.promises.rm(stagedPath, {
    force: true,
    maxRetries: 4,
    retryDelay: 150
  }).catch(() => {});

  let lastError = null;

  for (const url of getForgeInstallerDownloadUrls(minecraftVersion, loaderVersion)) {
    try {
      const fileBuffer = await downloadFileBuffer(url);
      await fs.promises.writeFile(stagedPath, fileBuffer);

      const stagedReadable = await canReadForgeInstallerJar(stagedPath, minecraftVersion, loaderVersion);
      if (!stagedReadable) {
        throw new Error(`Downloaded Forge installer from ${url} is invalid`);
      }

      await clearStaleForgeInstaller(targetPath, minecraftVersion, loaderVersion);
      await fs.promises.rename(stagedPath, installerPath);
      return installerPath;
    } catch (error) {
      lastError = error;
      await fs.promises.rm(stagedPath, {
        force: true,
        maxRetries: 2,
        retryDelay: 100
      }).catch(() => {});
    }
  }

  throw lastError || new Error('Unable to stage Forge installer jar');
}

async function installForgeClientFromLocalInstaller(options = {}) {
  const installerPath = await stageForgeInstallerJar(
    options.clientPath,
    options.minecraftVersion,
    options.loaderVersion
  );
  const forgeArtifactVersion = getForgeArtifactVersion(
    options.minecraftVersion,
    options.loaderVersion
  );
  const minecraftFolder = MinecraftFolder.from(options.clientPath);

  let zip;
  try {
    zip = await openZip(installerPath, { lazyEntries: true, autoClose: false });
    const entries = await walkForgeInstallerEntries(zip, forgeArtifactVersion);

    if (!entries.installProfileJson) {
      throw new Error(`Missing install_profile.json in Forge installer ${installerPath}`);
    }

    if (!isForgeInstallerEntries(entries)) {
      throw new Error(`Unsupported Forge installer layout in ${installerPath}`);
    }

    const profile = JSON.parse(
      (await readEntry(zip, entries.installProfileJson)).toString()
    );

    const versionId = await unpackForgeInstaller(
      zip,
      entries,
      profile,
      minecraftFolder,
      installerPath,
      {
        side: 'client',
        java: options.javaPath
      }
    );

    await installByProfileTask(profile, options.clientPath, {
      side: 'client',
      java: options.javaPath
    }).startAndWait();

    return versionId;
  } finally {
    try {
      zip?.close();
    } catch {
      // Ignore zip close errors after install.
    }
  }
}

function getLegacyFabricInstaller() {
  return require('./download-manager.cjs').installFabric;
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
  await getLegacyFabricInstaller()(
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
    const installerPath = getForgeInstallerPath(
      options.clientPath,
      options.minecraftVersion,
      options.loaderVersion
    );

    let versionId;
    try {
      versionId = await installForgeClientFromLocalInstaller(options);
    } catch (error) {
      if (
        !isForgeInstallerOpenError(error, installerPath)
        && !/enoent|not found|missing install_profile\.json|invalid/i.test(error?.message || '')
      ) {
        throw error;
      }

      getLogger().warn('Retrying Forge client install after installer artifact staging failure', {
        category: 'client',
        data: {
          service: 'LoaderInstallService',
          operation: 'installClientLoader',
          minecraftVersion: options.minecraftVersion,
          loaderVersion: options.loaderVersion,
          installerPath,
          error: error.message
        }
      });

      await clearStaleForgeInstaller(
        options.clientPath,
        options.minecraftVersion,
        options.loaderVersion
      );
      await delay(750);

      versionId = await installForgeClientFromLocalInstaller(options);
    }

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
  getForgeRuntimeHealthIssues,
  __testUtils: {
    getForgeArtifactVersion,
    getForgeInstallerPath,
    isForgeInstallerOpenError
  }
};
