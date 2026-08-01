const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { validateRemoteUrl } = require('../network/remote-url-policy.cjs');

const MRPACK_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const MRPACK_DOWNLOAD_HOSTS = Object.freeze([
  'cdn.modrinth.com',
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com'
]);
const ENV_VALUES = new Set(['required', 'optional', 'unsupported']);
const DEPENDENCY_KEYS = new Set(['minecraft', 'forge', 'neoforge', 'fabric-loader', 'quilt-loader']);
const DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);
const VALIDATED_MANIFESTS = new WeakSet();

function manifestInvalid(reasonCode = 'missing-required-field') {
  return new ModpackError('MANIFEST_INVALID', 'Modrinth pack manifest is invalid', { details: { reasonCode } });
}

function collision() {
  return new ModpackError('ARCHIVE_ENTRY_COLLISION', 'Pack files have conflicting target paths', {
    details: { reasonCode: 'normalized-path-collision' }
  });
}

function limitExceeded(limit, actual) {
  return new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Pack content exceeded the configured byte limit', {
    details: { limit, actual: String(actual) }
  });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasControl(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function boundedString(value, { max = 256, empty = false } = {}) {
  return typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !hasControl(value);
}

function normalizeMrpackPath(value, { rejectState = true } = {}) {
  if (!boundedString(value, { max: ARCHIVE_LIMITS.maxNormalizedPathLength })) throw manifestInvalid();
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value) || value.includes(':') || hasControl(value)) throw manifestInvalid();
  const replaced = value.replaceAll('\\', '/');
  const rawSegments = replaced.split('/');
  if (rawSegments.length > ARCHIVE_LIMITS.maxPathDepth || rawSegments.some(segment => !segment || segment === '.' || segment === '..')) throw manifestInvalid();
  const segments = rawSegments.map(segment => {
    const normalized = segment.normalize('NFC');
    if (!normalized || normalized.length > 255 || /[. ]$/.test(normalized) || /[<>"|?*]/.test(normalized)) throw manifestInvalid();
    const stem = normalized.split('.', 1)[0].toUpperCase();
    if (DEVICE_NAMES.has(stem)) throw manifestInvalid();
    if (rejectState && normalized.toLocaleLowerCase('en-US').startsWith('.minecraft-core')) throw manifestInvalid();
    return normalized;
  });
  const result = segments.join('/');
  if (result.length > ARCHIVE_LIMITS.maxNormalizedPathLength) throw manifestInvalid();
  return result;
}

function canonicalWindowsPath(value) {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function normalizeEnvironment(value) {
  if (value === undefined) return { client: 'required', server: 'required' };
  if (!plainObject(value) || Object.keys(value).length !== 2 || !ENV_VALUES.has(value.client) || !ENV_VALUES.has(value.server)) {
    throw manifestInvalid('invalid-environment');
  }
  return { client: value.client, server: value.server };
}

function normalizeHashes(value) {
  if (!plainObject(value) || typeof value.sha1 !== 'string' || !/^[a-f0-9]{40}$/.test(value.sha1) ||
      typeof value.sha512 !== 'string' || !/^[a-f0-9]{128}$/.test(value.sha512)) {
    throw manifestInvalid('invalid-hash');
  }
  for (const [algorithm, digest] of Object.entries(value)) {
    if (!boundedString(algorithm, { max: 32 }) || typeof digest !== 'string' || !/^[a-f0-9]+$/.test(digest) || digest.length > 256) {
      throw manifestInvalid('invalid-hash');
    }
  }
  return { sha1: value.sha1, sha512: value.sha512 };
}

function normalizeDownload(value) {
  if (!boundedString(value, { max: 4096 })) throw new ModpackError('INVALID_RELEASE_URL', 'Pack download address is not allowed', { details: { reasonCode: 'malformed-url' } });
  const url = validateRemoteUrl(value, { allowedHosts: MRPACK_DOWNLOAD_HOSTS, allowSubdomains: false });
  if (url.port && url.port !== '443') throw new ModpackError('INVALID_RELEASE_URL', 'Pack download address is not allowed', { details: { reasonCode: 'host-not-allowed' } });
  return url.href;
}

function normalizeFile(value, index) {
  if (!plainObject(value)) throw manifestInvalid();
  const allowed = new Set(['path', 'hashes', 'env', 'downloads', 'fileSize']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw manifestInvalid('unsupported-format');
  if (!Array.isArray(value.downloads) || value.downloads.length === 0 || value.downloads.length > 16) throw manifestInvalid();
  if (!Number.isSafeInteger(value.fileSize) || value.fileSize < 0) throw manifestInvalid();
  if (BigInt(value.fileSize) > BigInt(ARCHIVE_LIMITS.maxFileExpandedBytes)) throw limitExceeded('maxFileExpandedBytes', value.fileSize);
  return {
    path: normalizeMrpackPath(value.path),
    hashes: normalizeHashes(value.hashes),
    env: normalizeEnvironment(value.env),
    downloads: value.downloads.map(normalizeDownload),
    fileSize: String(value.fileSize),
    _index: index
  };
}

function normalizeDependencies(value) {
  if (!plainObject(value) || !boundedString(value.minecraft, { max: 64 })) throw manifestInvalid();
  const keys = Object.keys(value);
  if (keys.some(key => !DEPENDENCY_KEYS.has(key))) throw manifestInvalid('unsupported-format');
  for (const key of keys) if (!boundedString(value[key], { max: 128 })) throw manifestInvalid();
  const loaders = keys.filter(key => key !== 'minecraft');
  if (loaders.length > 1) throw new ModpackError('LOADER_CONFLICT', 'Modrinth pack declares conflicting loaders');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function validateMrpackManifest(value) {
  if (!plainObject(value)) throw manifestInvalid();
  const allowed = new Set(['formatVersion', 'game', 'versionId', 'name', 'summary', 'files', 'dependencies']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw manifestInvalid('unsupported-format');
  if (value.formatVersion !== 1 || value.game !== 'minecraft') throw manifestInvalid('unsupported-format');
  if (!boundedString(value.versionId, { max: 256 }) || !boundedString(value.name, { max: 256 }) ||
      (value.summary !== undefined && !boundedString(value.summary, { max: 4096, empty: true }))) throw manifestInvalid();
  if (!Array.isArray(value.files) || value.files.length > ARCHIVE_LIMITS.maxArchiveEntries) throw manifestInvalid();
  const files = value.files.map(normalizeFile);
  const aliases = new Set();
  for (const file of files) {
    const alias = canonicalWindowsPath(file.path);
    if (aliases.has(alias)) throw collision();
    aliases.add(alias);
    delete file._index;
  }
  const result = deepFreeze({
    formatVersion: 1,
    game: 'minecraft',
    versionId: value.versionId,
    name: value.name,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    files,
    dependencies: normalizeDependencies(value.dependencies)
  });
  VALIDATED_MANIFESTS.add(result);
  return result;
}

function ensureValidatedMrpackManifest(value) {
  return VALIDATED_MANIFESTS.has(value) ? value : validateMrpackManifest(value);
}

module.exports = {
  MRPACK_DOWNLOAD_HOSTS,
  MRPACK_MANIFEST_MAX_BYTES,
  canonicalWindowsPath,
  ensureValidatedMrpackManifest,
  manifestInvalid,
  normalizeMrpackPath,
  validateMrpackManifest
};
