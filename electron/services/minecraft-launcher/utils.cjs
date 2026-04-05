const fs = require('fs');
const { createHash } = require('crypto');
const fetch = require('node-fetch');

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const VERSION_CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const DEFAULT_JAVA_VERSION = 17;

let versionManifestCache = {
  fetchedAt: 0,
  data: null
};

const javaRequirementCache = new Map();

function normalizeMinecraftVersion(minecraftVersion) {
  return typeof minecraftVersion === 'string'
    ? minecraftVersion.trim()
    : '';
}

function getFallbackRequiredJavaVersion(minecraftVersion) {
  const normalizedVersion = normalizeMinecraftVersion(minecraftVersion);
  const [mainVersion = ''] = normalizedVersion.split(/[-+]/);
  const parts = mainVersion.split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1] || '0', 10);
  const patch = parseInt(parts[2] || '0', 10);

  if (Number.isNaN(major)) {
    return DEFAULT_JAVA_VERSION;
  }

  if (major === 1) {
    if (minor <= 16) {
      return 8;
    }

    if (minor < 20 || (minor === 20 && patch <= 4)) {
      return 17;
    }

    return 21;
  }

  // New Minecraft release numbering (for example 26.1) no longer starts with "1.".
  // Current releases in this scheme require newer Java runtimes than the legacy fallback assumed.
  if (major >= 26) {
    return 25;
  }

  if (major >= 21) {
    return 21;
  }

  return DEFAULT_JAVA_VERSION;
}

function getRequiredJavaVersion(minecraftVersion) {
  return getFallbackRequiredJavaVersion(minecraftVersion);
}

function getCachedJavaRequirement(minecraftVersion) {
  const cached = javaRequirementCache.get(minecraftVersion);
  if (!cached) {
    return null;
  }

  if (Date.now() - cached.cachedAt > VERSION_CACHE_TTL_MS) {
    javaRequirementCache.delete(minecraftVersion);
    return null;
  }

  return cached.value;
}

function setCachedJavaRequirement(minecraftVersion, value) {
  javaRequirementCache.set(minecraftVersion, {
    cachedAt: Date.now(),
    value
  });
  return value;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function getVersionManifest() {
  if (
    versionManifestCache.data
    && Date.now() - versionManifestCache.fetchedAt <= VERSION_CACHE_TTL_MS
  ) {
    return versionManifestCache.data;
  }

  const manifest = await fetchJson(VERSION_MANIFEST_URL);
  versionManifestCache = {
    fetchedAt: Date.now(),
    data: manifest
  };

  return manifest;
}

async function resolveRequiredJavaVersion(minecraftVersion) {
  const normalizedVersion = normalizeMinecraftVersion(minecraftVersion);
  const fallbackVersion = getFallbackRequiredJavaVersion(normalizedVersion);

  if (!normalizedVersion) {
    return {
      minecraftVersion: normalizedVersion,
      requiredJavaVersion: fallbackVersion,
      source: 'fallback',
      javaComponent: null,
      versionUrl: null,
      error: 'Missing Minecraft version'
    };
  }

  const cached = getCachedJavaRequirement(normalizedVersion);
  if (cached) {
    return cached;
  }

  try {
    const manifest = await getVersionManifest();
    const versionMeta = Array.isArray(manifest?.versions)
      ? manifest.versions.find(version => version.id === normalizedVersion)
      : null;

    if (!versionMeta?.url) {
      return setCachedJavaRequirement(normalizedVersion, {
        minecraftVersion: normalizedVersion,
        requiredJavaVersion: fallbackVersion,
        source: 'fallback',
        javaComponent: null,
        versionUrl: null,
        error: `Version ${normalizedVersion} was not found in the Mojang manifest`
      });
    }

    const versionDetails = await fetchJson(versionMeta.url);
    const metadataJavaVersion = parseInt(versionDetails?.javaVersion?.majorVersion, 10);

    if (Number.isFinite(metadataJavaVersion) && metadataJavaVersion > 0) {
      return setCachedJavaRequirement(normalizedVersion, {
        minecraftVersion: normalizedVersion,
        requiredJavaVersion: metadataJavaVersion,
        source: 'mojang-metadata',
        javaComponent: versionDetails?.javaVersion?.component || null,
        versionUrl: versionMeta.url,
        error: null
      });
    }
  } catch (error) {
    return setCachedJavaRequirement(normalizedVersion, {
      minecraftVersion: normalizedVersion,
      requiredJavaVersion: fallbackVersion,
      source: 'fallback',
      javaComponent: null,
      versionUrl: null,
      error: error.message
    });
  }

  return setCachedJavaRequirement(normalizedVersion, {
    minecraftVersion: normalizedVersion,
    requiredJavaVersion: fallbackVersion,
    source: 'fallback',
    javaComponent: null,
    versionUrl: null,
    error: 'Minecraft metadata did not include a Java requirement'
  });
}

function calculateFileChecksum(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath);
    return createHash('md5').update(fileContent).digest('hex');
  } catch {
    return null;
  }
}

function calculateFileChecksumAsync(filePath) {
  return new Promise((resolve) => {
    try {
      const hash = createHash('md5');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => {
        hash.update(chunk);
      });

      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });

      stream.on('error', () => {
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

module.exports = {
  getRequiredJavaVersion,
  resolveRequiredJavaVersion,
  calculateFileChecksum,
  calculateFileChecksumAsync
};
