const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const disposableHarness = require('./disposable-client-join-harness.cjs');
const preservedHarness = require('./preserved-real-modrinth-harness.cjs');
const realHarness = require('./real-modpack-harness.cjs');

const PRESERVED_DISPOSABLE_CLIENT_JOIN_ROOT_ENV = 'MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_CONTINUATION_ROOT';
const EXPECTED_MODRINTH_VERSION_ID = 'oQ6gSIoF';
const EXPECTED_RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.15.10'
});
const SYNTHETIC_USERNAME = /^E2E_[a-f0-9]{12}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA512 = /^[a-f0-9]{128}$/u;
const MAX_PINNED_MRPACK_BYTES = 64 * 1024 * 1024;
const MAX_PROJECTED_CLIENT_MODS = 1_000;
const MAX_PROJECTED_CLIENT_MOD_BYTES = 256 * 1024 * 1024;
const MAX_PROJECTED_CLIENT_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_VERSION_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ASSET_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_INDEX_ENTRIES = 20_000;
const MAX_ASSET_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const RUNTIME_VERSION = /^[A-Za-z0-9._-]{1,64}$/u;
const EXPECTED_ASSET_INDEX = Object.freeze({
  id: '5',
  sha1: '7c4533d4bec68552b39668ce65cdd5cabfe68351',
  size: 413_067,
  indexEntryCount: 3_598,
  assetObjectCount: 3_575,
  totalSize: 650_087_741
});
const EXPECTED_PARTIAL_INDEX_CACHE = Object.freeze({
  size: 395_077,
  sha1: 'f34a1ef1623d09e3a3081ebcf1a23622349db6d3'
});
const EXPECTED_PARTIAL_ASSET_HASHES = Object.freeze([
  '8b2a57294e9f57a1e3ea28c1cc601762af2b63c4',
  '97b52210f12181c96547f94dda806a9a3ff838a5',
  'c1c3b7233b080ffc17389af8b68a46b2df798ef1',
  'e12154ca862546b6f91db32596bfb587a1c1cf77'
]);
const EXPECTED_CLIENT_MRPACK = Object.freeze({
  sha256: '52a56093e2446f5b677fa87cc00a699223cbb8413f6f611b3432de30d6cc97b4',
  sha512: '01de697916bdfe839c8d73a75aa5e2fb4af700e360de174e7d56c63fe843a82e1be703ffdadf12765cbc37800a55a4425cdd7e034b118e7c69cb9738d260a8d6',
  size: 4_637,
  manifestVersionId: '1.20.1',
  projectedModCount: 26
});

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function pathsEqual(left, right) {
  return typeof left === 'string' && typeof right === 'string' && comparablePath(left) === comparablePath(right);
}

function getPreservedDisposableClientJoinRoot(environment = process.env) {
  const value = environment?.[PRESERVED_DISPOSABLE_CLIENT_JOIN_ROOT_ENV];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

function isPreservedDisposableClientJoinEnabled(environment = process.env) {
  return disposableHarness.isDisposableClientJoinEnabled(environment) &&
    getPreservedDisposableClientJoinRoot(environment) !== null;
}

function validatePreservedClientRecords(lifecycle, { state, config, auth } = {}) {
  if (!lifecycle || typeof lifecycle.instanceId !== 'string' ||
      typeof lifecycle.serverPath !== 'string' || typeof lifecycle.clientPath !== 'string') {
    throw new TypeError('A validated preserved lifecycle is required');
  }
  if (state?.modpackManaged !== true || state.source?.provider !== 'modrinth' ||
      state.source?.projectId !== realHarness.REAL_MODRINTH_LIFECYCLE.projectId ||
      state.source?.versionId !== EXPECTED_MODRINTH_VERSION_ID ||
      state.runtime?.minecraftVersion !== EXPECTED_RUNTIME.minecraftVersion ||
      state.runtime?.loaderFamily !== EXPECTED_RUNTIME.loaderFamily ||
      state.runtime?.loaderVersion !== EXPECTED_RUNTIME.loaderVersion) {
    throw new Error('The preserved client join server does not match the exact approved managed pack');
  }
  if (!Array.isArray(config?.instances) || config.instances.length !== 2 ||
      !pathsEqual(config.lastServerPath, lifecycle.serverPath)) {
    throw new Error('The preserved client join configuration is not isolated to one server and one client');
  }
  const server = config.instances.find(instance => instance?.type === 'server');
  const client = config.instances.find(instance => instance?.type === 'client');
  if (!server || server.id !== lifecycle.instanceId || !pathsEqual(server.path, lifecycle.serverPath)) {
    throw new Error('The preserved server record is outside the validated scratch server');
  }
  if (!client || client.id !== disposableHarness.DISPOSABLE_CLIENT_ID ||
      !pathsEqual(client.path, lifecycle.clientPath) || !SYNTHETIC_USERNAME.test(client.name || '') ||
      client.serverIp !== '127.0.0.1' || !/^[1-9][0-9]{0,4}$/u.test(String(client.serverPort || '')) ||
      Number(client.serverPort) > 65535) {
    throw new Error('The preserved client record is outside the validated scratch client');
  }
  const authMatchesOriginalName = auth?.name === client.name;
  const authMatchesPreFixClientName = SYNTHETIC_USERNAME.test(client.clientName || '') &&
    auth?.name === client.clientName;
  if (!auth || (!authMatchesOriginalName && !authMatchesPreFixClientName) ||
      auth.uuid !== '00000000-0000-0000-0000-000000000001' ||
      typeof auth.access_token !== 'string' || !auth.access_token.startsWith('enc:') ||
      typeof auth.client_token !== 'string' || !auth.client_token.startsWith('enc:') ||
      typeof auth.xmcl_tokens?.microsoft?.access_token !== 'string' ||
      !auth.xmcl_tokens.microsoft.access_token.startsWith('enc:') ||
      typeof auth.xmcl_tokens?.microsoft?.refresh_token !== 'string' ||
      !auth.xmcl_tokens.microsoft.refresh_token.startsWith('enc:')) {
    throw new Error('The preserved client does not contain the expected encrypted synthetic identity');
  }
  return {
    priorUsername: auth.name,
    runtime: { ...EXPECTED_RUNTIME }
  };
}

async function readPinnedCachedArchive(lifecycle, { sha256, sha512, size } = {}) {
  if (!SHA256.test(sha256 || '') || !SHA512.test(sha512 || '') ||
      !Number.isSafeInteger(size) || size <= 0 || size > MAX_PINNED_MRPACK_BYTES) {
    throw new TypeError('A bounded pinned MRPACK cache identity is required');
  }
  const archivePath = disposableHarness.assertDisposablePath(
    lifecycle,
    path.join(lifecycle.root, 'client-pack-cache', 'sha256', sha256.slice(0, 2), sha256)
  );
  const metadata = await fsp.lstat(archivePath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== size) {
    throw new Error('The pinned MRPACK cache object size or type changed');
  }
  const archive = await fsp.readFile(archivePath);
  disposableHarness.assertDisposablePath(lifecycle, archivePath);
  if (archive.length !== size || crypto.createHash('sha256').update(archive).digest('hex') !== sha256 ||
      crypto.createHash('sha512').update(archive).digest('hex') !== sha512) {
    throw new Error('The pinned MRPACK cache object digest changed');
  }
  return archive;
}

async function hashRegularFile(filePath) {
  const metadata = await fsp.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('The preserved client pack contains a non-regular mod file');
  }
  const sha1 = crypto.createHash('sha1');
  const sha512 = crypto.createHash('sha512');
  let size = 0;
  const handle = await fsp.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      sha1.update(chunk);
      sha512.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return { size: String(size), sha1: sha1.digest('hex'), sha512: sha512.digest('hex') };
}

async function verifyPreservedClientProjection(lifecycle, projection) {
  if (!projection || projection.type !== 'mrpack-client-projection' ||
      !Array.isArray(projection.downloads) || projection.downloads.length === 0 ||
      projection.downloads.length > MAX_PROJECTED_CLIENT_MODS ||
      !Array.isArray(projection.overrideOperations) || projection.overrideOperations.length !== 0) {
    throw new Error('The preserved client projection is not the exact supported mod-only pack');
  }
  const expected = new Map();
  let declaredTotal = 0;
  for (const download of projection.downloads) {
    const match = /^mods\/([^/]+)$/u.exec(download?.targetPath || '');
    const measuredSize = Number(download?.size);
    if (!match || !Number.isSafeInteger(measuredSize) || measuredSize < 0 ||
        measuredSize > MAX_PROJECTED_CLIENT_MOD_BYTES || !SHA1.test(download?.hashes?.sha1 || '') ||
        !SHA512.test(download?.hashes?.sha512 || '')) {
      throw new Error('The preserved client projection contains an invalid mod identity');
    }
    declaredTotal += measuredSize;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_PROJECTED_CLIENT_TOTAL_BYTES) {
      throw new Error('The preserved client projection exceeds its total byte limit');
    }
    const alias = match[1].toLocaleLowerCase('en-US');
    if (expected.has(alias)) throw new Error('The preserved client projection contains a duplicate mod path');
    expected.set(alias, { fileName: match[1], download });
  }

  const modsPath = disposableHarness.assertDisposablePath(lifecycle, path.join(lifecycle.clientPath, 'mods'));
  const modsMetadata = await fsp.lstat(modsPath).catch(() => null);
  if (!modsMetadata?.isDirectory() || modsMetadata.isSymbolicLink()) {
    throw new Error('The preserved client does not contain an exact regular mod directory');
  }
  const entries = await fsp.readdir(modsPath, { withFileTypes: true });
  const actualAliases = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('The preserved client exact mod set contains a non-regular entry');
    }
    actualAliases.push(entry.name.toLocaleLowerCase('en-US'));
  }
  const expectedAliases = [...expected.keys()].sort((left, right) => left.localeCompare(right, 'en-US'));
  actualAliases.sort((left, right) => left.localeCompare(right, 'en-US'));
  if (actualAliases.length !== expectedAliases.length ||
      actualAliases.some((alias, index) => alias !== expectedAliases[index])) {
    throw new Error('The preserved client does not contain the exact immutable mod file set');
  }

  for (const { fileName, download } of expected.values()) {
    const filePath = disposableHarness.assertDisposablePath(lifecycle, path.join(modsPath, fileName));
    const calculated = await hashRegularFile(filePath);
    disposableHarness.assertDisposablePath(lifecycle, filePath);
    if (calculated.size !== String(download.size) || calculated.sha1 !== download.hashes.sha1 ||
        calculated.sha512 !== download.hashes.sha512) {
      throw new Error('A preserved client mod does not match its immutable manifest hash');
    }
  }
  return true;
}

async function readBoundedRegularFile(lifecycle, filePath, maximumBytes, label) {
  const confined = disposableHarness.assertDisposablePath(lifecycle, filePath);
  const metadata = await fsp.lstat(confined).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`The preserved client ${label} is missing, redirected, or oversized`);
  }
  const bytes = await fsp.readFile(confined);
  disposableHarness.assertDisposablePath(lifecycle, confined);
  if (bytes.length !== metadata.size || bytes.length > maximumBytes) {
    throw new Error(`The preserved client ${label} changed while it was read`);
  }
  return bytes;
}

async function hashAssetObject(filePath, maximumBytes) {
  const metadata = await fsp.lstat(filePath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    return { size: metadata.size, sha1: null, invalidType: true };
  }
  const sha1 = crypto.createHash('sha1');
  let size = 0;
  const handle = await fsp.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error('A preserved client asset grew beyond its bounded size');
      sha1.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return { size, sha1: sha1.digest('hex'), invalidType: false };
}

async function auditClientAssets(lifecycle, runtime) {
  if (!runtime || !RUNTIME_VERSION.test(runtime.minecraftVersion || '')) {
    throw new TypeError('A bounded preserved client runtime is required');
  }
  const versionJsonPath = path.join(
    lifecycle.clientPath,
    'versions',
    runtime.minecraftVersion,
    `${runtime.minecraftVersion}.json`
  );
  const versionBytes = await readBoundedRegularFile(
    lifecycle,
    versionJsonPath,
    MAX_VERSION_JSON_BYTES,
    'version metadata'
  );
  let version;
  try {
    version = JSON.parse(versionBytes.toString('utf8'));
  } catch (error) {
    throw new Error('The preserved client version metadata is invalid JSON', { cause: error });
  }
  const assetIndex = version?.assetIndex;
  if (version?.id !== runtime.minecraftVersion || version?.assets !== assetIndex?.id ||
      !assetIndex || !RUNTIME_VERSION.test(assetIndex.id || '') ||
      !SHA1.test(assetIndex.sha1 || '') || !Number.isSafeInteger(assetIndex.size) || assetIndex.size <= 0 ||
      assetIndex.size > MAX_ASSET_INDEX_BYTES || !Number.isSafeInteger(assetIndex.totalSize) ||
      assetIndex.totalSize < 0 || assetIndex.totalSize > MAX_ASSET_TOTAL_BYTES ||
      assetIndex.url !== `https://piston-meta.mojang.com/v1/packages/${assetIndex.sha1}/${assetIndex.id}.json`) {
    throw new Error('The preserved client version does not contain a bounded pinned asset index');
  }
  const indexPath = path.join(lifecycle.clientPath, 'assets', 'indexes', `${assetIndex.id}.json`);
  const indexBytes = await readBoundedRegularFile(lifecycle, indexPath, MAX_ASSET_INDEX_BYTES, 'asset index');
  if (indexBytes.length !== assetIndex.size || crypto.createHash('sha1').update(indexBytes).digest('hex') !== assetIndex.sha1) {
    throw new Error('The preserved client asset index does not match its pinned digest');
  }
  const indexCachePath = disposableHarness.assertDisposablePath(
    lifecycle,
    path.join(lifecycle.clientPath, 'assets', 'indexes', `${assetIndex.sha1}.json`)
  );
  const indexCache = await hashAssetObject(indexCachePath, MAX_ASSET_INDEX_BYTES);
  disposableHarness.assertDisposablePath(lifecycle, indexCachePath);
  const indexCacheValid = Boolean(indexCache && !indexCache.invalidType &&
    indexCache.size === assetIndex.size && indexCache.sha1 === assetIndex.sha1);
  let index;
  try {
    index = JSON.parse(indexBytes.toString('utf8'));
  } catch (error) {
    throw new Error('The preserved client asset index is invalid JSON', { cause: error });
  }
  if (!index?.objects || typeof index.objects !== 'object' || Array.isArray(index.objects)) {
    throw new Error('The preserved client asset index does not contain an object map');
  }
  const entries = Object.entries(index.objects);
  if (entries.length === 0 || entries.length > MAX_ASSET_INDEX_ENTRIES) {
    throw new Error('The preserved client asset index entry count is outside its bound');
  }
  const uniqueObjects = new Map();
  let totalSize = 0;
  for (const [logicalName, object] of entries) {
    if (typeof logicalName !== 'string' || logicalName.length === 0 || logicalName.length > 1_024 ||
        !SHA1.test(object?.hash || '') || !Number.isSafeInteger(object?.size) || object.size < 0 ||
        object.size > MAX_ASSET_OBJECT_BYTES) {
      throw new Error('The preserved client asset index contains an invalid object identity');
    }
    totalSize += object.size;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_ASSET_TOTAL_BYTES) {
      throw new Error('The preserved client asset index exceeds its total byte bound');
    }
    const existing = uniqueObjects.get(object.hash);
    if (existing && existing.size !== object.size) {
      throw new Error('The preserved client asset index reuses a digest with a different size');
    }
    uniqueObjects.set(object.hash, { hash: object.hash, size: object.size });
  }
  if (totalSize !== assetIndex.totalSize) {
    throw new Error('The preserved client asset index total size changed');
  }

  const invalid = [];
  let validAssetObjectCount = 0;
  for (const object of uniqueObjects.values()) {
    const objectPath = disposableHarness.assertDisposablePath(
      lifecycle,
      path.join(lifecycle.clientPath, 'assets', 'objects', object.hash.slice(0, 2), object.hash)
    );
    const calculated = await hashAssetObject(objectPath, MAX_ASSET_OBJECT_BYTES);
    disposableHarness.assertDisposablePath(lifecycle, objectPath);
    if (!calculated) {
      invalid.push({ hash: object.hash, reason: 'missing', expectedSize: object.size, actualSize: null, actualSha1: null });
    } else if (calculated.invalidType || calculated.size !== object.size || calculated.sha1 !== object.hash) {
      invalid.push({
        hash: object.hash,
        reason: 'digest-or-size',
        expectedSize: object.size,
        actualSize: calculated.size,
        actualSha1: calculated.sha1
      });
    } else {
      validAssetObjectCount += 1;
    }
  }
  invalid.sort((left, right) => left.hash.localeCompare(right.hash, 'en-US'));
  return Object.freeze({
    assetIndexId: assetIndex.id,
    assetIndexSha1: assetIndex.sha1,
    indexCacheValid,
    indexCacheActualSize: indexCache?.size ?? null,
    indexCacheActualSha1: indexCache?.sha1 ?? null,
    indexEntryCount: entries.length,
    assetObjectCount: uniqueObjects.size,
    validAssetObjectCount,
    totalSize,
    invalid: Object.freeze(invalid.map(entry => Object.freeze(entry)))
  });
}

function assertExpectedPreservedPartialAssets(audit) {
  const hashes = Array.isArray(audit?.invalid)
    ? audit.invalid.map(entry => entry?.hash).sort((left, right) => String(left).localeCompare(String(right), 'en-US'))
    : [];
  const exactInvalidSet = hashes.length === EXPECTED_PARTIAL_ASSET_HASHES.length &&
    hashes.every((hash, index) => hash === EXPECTED_PARTIAL_ASSET_HASHES[index]) &&
    audit.invalid.every(entry => entry?.reason === 'digest-or-size');
  if (audit?.assetIndexId !== EXPECTED_ASSET_INDEX.id ||
      audit?.assetIndexSha1 !== EXPECTED_ASSET_INDEX.sha1 ||
      audit?.indexEntryCount !== EXPECTED_ASSET_INDEX.indexEntryCount ||
      audit?.assetObjectCount !== EXPECTED_ASSET_INDEX.assetObjectCount ||
      audit?.validAssetObjectCount !== EXPECTED_ASSET_INDEX.assetObjectCount - EXPECTED_PARTIAL_ASSET_HASHES.length ||
      audit?.totalSize !== EXPECTED_ASSET_INDEX.totalSize || audit?.indexCacheValid !== false ||
      audit?.indexCacheActualSize !== EXPECTED_PARTIAL_INDEX_CACHE.size ||
      audit?.indexCacheActualSha1 !== EXPECTED_PARTIAL_INDEX_CACHE.sha1 || !exactInvalidSet) {
    throw new Error('The preserved client does not match the characterized four-object asset failure');
  }
  return true;
}

function isExpectedPinnedIndexCache(audit) {
  return audit?.indexCacheValid === true &&
    audit?.indexCacheActualSize === EXPECTED_ASSET_INDEX.size &&
    audit?.indexCacheActualSha1 === EXPECTED_ASSET_INDEX.sha1;
}

function isExpectedTruncatedIndexCache(audit) {
  return audit?.indexCacheValid === false &&
    audit?.indexCacheActualSize === EXPECTED_PARTIAL_INDEX_CACHE.size &&
    audit?.indexCacheActualSha1 === EXPECTED_PARTIAL_INDEX_CACHE.sha1;
}

function assertExpectedPreservedPrelaunchAssets(audit) {
  try {
    return assertExpectedPreservedPartialAssets(audit);
  } catch {
    // A bounded retry can remove the same four invalid objects before the
    // launcher replaces them. Its auxiliary digest-named cache may remain the
    // known truncated artifact or may already contain the exact pinned bytes.
  }
  try {
    return assertExpectedRepairedAssets(audit);
  } catch {
    // A later bounded retry may already have replaced every invalid object
    // before failing in loader preparation or JVM startup.
  }
  const hashes = Array.isArray(audit?.invalid)
    ? audit.invalid.map(entry => entry?.hash).sort((left, right) => String(left).localeCompare(String(right), 'en-US'))
    : [];
  const exactMissingSet = hashes.length === EXPECTED_PARTIAL_ASSET_HASHES.length &&
    hashes.every((hash, index) => hash === EXPECTED_PARTIAL_ASSET_HASHES[index]) &&
    audit.invalid.every(entry => entry?.reason === 'missing');
  const expectedAuxiliaryCache = isExpectedPinnedIndexCache(audit) || isExpectedTruncatedIndexCache(audit);
  if (audit?.assetIndexId !== EXPECTED_ASSET_INDEX.id ||
      audit?.assetIndexSha1 !== EXPECTED_ASSET_INDEX.sha1 ||
      audit?.indexEntryCount !== EXPECTED_ASSET_INDEX.indexEntryCount ||
      audit?.assetObjectCount !== EXPECTED_ASSET_INDEX.assetObjectCount ||
      audit?.validAssetObjectCount !== EXPECTED_ASSET_INDEX.assetObjectCount - EXPECTED_PARTIAL_ASSET_HASHES.length ||
      audit?.totalSize !== EXPECTED_ASSET_INDEX.totalSize || !expectedAuxiliaryCache || !exactMissingSet) {
    throw new Error('The preserved client does not match a characterized prelaunch asset state');
  }
  return true;
}

function assertExpectedRepairedAssets(audit) {
  const expectedAuxiliaryCache = isExpectedPinnedIndexCache(audit) || isExpectedTruncatedIndexCache(audit);
  if (audit?.assetIndexId !== EXPECTED_ASSET_INDEX.id ||
      audit?.assetIndexSha1 !== EXPECTED_ASSET_INDEX.sha1 ||
      audit?.indexEntryCount !== EXPECTED_ASSET_INDEX.indexEntryCount ||
      audit?.assetObjectCount !== EXPECTED_ASSET_INDEX.assetObjectCount ||
      audit?.validAssetObjectCount !== EXPECTED_ASSET_INDEX.assetObjectCount ||
      audit?.totalSize !== EXPECTED_ASSET_INDEX.totalSize || !expectedAuxiliaryCache ||
      !Array.isArray(audit?.invalid) || audit.invalid.length !== 0) {
    throw new Error('The preserved client asset set was not completely repaired');
  }
  return true;
}

async function readBoundedJson(lifecycle, filePath, label) {
  const bytes = await readBoundedRegularFile(lifecycle, filePath, 2 * 1024 * 1024, label);
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (error) {
    throw new Error(`The preserved client ${label} is invalid JSON`, { cause: error });
  }
}

async function loadPreservedDisposableClientJoinLifecycle(root) {
  const lifecycle = await preservedHarness.loadPreservedRealLifecycle(root, {
    expectedIdentity: { provider: 'modrinth', harness: 'real-modpack' }
  });
  const [state, config, auth] = await Promise.all([
    readBoundedJson(
      lifecycle,
      path.join(lifecycle.serverPath, '.minecraft-core-state', 'modpack.json'),
      'managed state'
    ),
    readBoundedJson(
      lifecycle,
      path.join(lifecycle.userDataPath, 'config', 'minecraft-core-config.json'),
      'saved configuration'
    ),
    readBoundedJson(lifecycle, path.join(lifecycle.clientPath, 'xmcl-auth.json'), 'synthetic auth')
  ]);
  const records = validatePreservedClientRecords(lifecycle, { state, config, auth });
  const archive = await readPinnedCachedArchive(lifecycle, EXPECTED_CLIENT_MRPACK);
  const inspected = await disposableHarness.inspectMrpackClientArchive(archive);
  const projection = inspected?.projection;
  if (!projection || projection.manifestVersionId !== EXPECTED_CLIENT_MRPACK.manifestVersionId ||
      projection.runtime?.minecraftVersion !== EXPECTED_RUNTIME.minecraftVersion ||
      projection.runtime?.loaderFamily !== EXPECTED_RUNTIME.loaderFamily ||
      projection.runtime?.loaderVersion !== EXPECTED_RUNTIME.loaderVersion ||
      projection.downloads?.length !== EXPECTED_CLIENT_MRPACK.projectedModCount ||
      projection.overrideOperations?.length !== 0) {
    throw new Error('The pinned MRPACK cache is not the exact approved client projection');
  }
  await verifyPreservedClientProjection(lifecycle, projection);
  const prelaunchAssetAudit = await auditClientAssets(lifecycle, records.runtime);
  assertExpectedPreservedPrelaunchAssets(prelaunchAssetAudit);
  return Object.freeze({
    ...lifecycle,
    priorUsername: records.priorUsername,
    runtime: Object.freeze({ ...records.runtime }),
    clientPackProjection: projection,
    prelaunchAssetAudit
  });
}

module.exports = {
  PRESERVED_DISPOSABLE_CLIENT_JOIN_ROOT_ENV,
  getPreservedDisposableClientJoinRoot,
  isPreservedDisposableClientJoinEnabled,
  validatePreservedClientRecords,
  readPinnedCachedArchive,
  verifyPreservedClientProjection,
  auditClientAssets,
  assertExpectedPreservedPartialAssets,
  assertExpectedPreservedPrelaunchAssets,
  assertExpectedRepairedAssets,
  loadPreservedDisposableClientJoinLifecycle
};
