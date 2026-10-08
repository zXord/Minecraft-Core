const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEVELOPMENT_ICON_CACHE_DIRECTORY = 'window-icon-cache';
const DEVELOPMENT_ICON_CACHE_PREFIX = 'minecraft-core-';

function firstExisting(candidates, exists = fs.existsSync) {
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // A failed probe is equivalent to an unavailable optional asset.
    }
  }
  return null;
}

function isValidWindowsIcon(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) return false;
  if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return false;
  const imageCount = bytes.readUInt16LE(4);
  const directoryEnd = 6 + (imageCount * 16);
  if (imageCount < 1 || directoryEnd > bytes.length) return false;

  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + (index * 16);
    const imageSize = bytes.readUInt32LE(entryOffset + 8);
    const imageOffset = bytes.readUInt32LE(entryOffset + 12);
    if (imageSize < 1 || imageOffset < directoryEnd || imageOffset + imageSize > bytes.length) return false;
  }
  return true;
}

function materializeCachedDevelopmentIcon({
  platform = process.platform,
  isPackaged = false,
  sourcePath,
  userDataPath,
  fsApi = fs
} = {}) {
  if (
    platform !== 'win32' ||
    isPackaged ||
    typeof sourcePath !== 'string' ||
    !sourcePath.trim() ||
    typeof userDataPath !== 'string' ||
    !userDataPath.trim()
  ) {
    return sourcePath || null;
  }

  try {
    const sourceBytes = fsApi.readFileSync(sourcePath);
    if (!isValidWindowsIcon(sourceBytes)) return sourcePath;

    const digest = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    const cacheDirectory = path.join(userDataPath, DEVELOPMENT_ICON_CACHE_DIRECTORY);
    const cachedPath = path.join(cacheDirectory, `${DEVELOPMENT_ICON_CACHE_PREFIX}${digest}.ico`);
    fsApi.mkdirSync(cacheDirectory, { recursive: true });

    try {
      if (fsApi.readFileSync(cachedPath).equals(sourceBytes)) return cachedPath;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    fsApi.writeFileSync(cachedPath, sourceBytes);
    if (!fsApi.readFileSync(cachedPath).equals(sourceBytes)) return sourcePath;
    return cachedPath;
  } catch {
    return sourcePath;
  }
}

function resolveWindowIconPath({
  platform = process.platform,
  isPackaged = false,
  projectRoot = path.resolve('.'),
  appPath = projectRoot,
  resourcesPath = process.resourcesPath,
  userDataPath,
  exists = fs.existsSync
} = {}) {
  const roots = isPackaged
    ? [resourcesPath, appPath, projectRoot].filter(Boolean)
    : [projectRoot];
  const relativeCandidates = platform === 'win32'
    ? ['build-resources/icon.ico', 'icon.ico', 'icon.png']
    : ['icon.png', 'build-resources/icon.ico'];

  const sourcePath = firstExisting(
    roots.flatMap(root => relativeCandidates.map(candidate => path.join(root, candidate))),
    exists
  );
  return materializeCachedDevelopmentIcon({
    platform,
    isPackaged,
    sourcePath,
    userDataPath
  });
}

module.exports = {
  materializeCachedDevelopmentIcon,
  resolveWindowIconPath
};
