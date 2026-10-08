const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const dns = require('node:dns');
const https = require('node:https');
const path = require('node:path');
const yauzl = require('yauzl');

const realHarness = require('./real-modpack-harness.cjs');
const { ARCHIVE_LIMITS } = require('../../../electron/services/modpacks/limits.cjs');
const { validateArchiveEntries } = require('../../../electron/services/modpacks/archive/archive-entry-policy.cjs');
const { parseMrpackManifest } = require('../../../electron/services/modpacks/mrpack/mrpack-parser.cjs');
const {
  MRPACK_DOWNLOAD_HOSTS,
  canonicalWindowsPath,
  ensureValidatedMrpackManifest,
  normalizeMrpackPath
} = require('../../../electron/services/modpacks/mrpack/mrpack-schema.cjs');
const { PinnedHttpsClient } = require('../../../electron/services/modpacks/network/pinned-https-client.cjs');
const { BoundedApiClient } = require('../../../electron/services/modpacks/network/bounded-api-client.cjs');
const { ModrinthModpackProvider } = require('../../../electron/services/modpacks/providers/modrinth-modpack-provider.cjs');
const { ArtifactCache } = require('../../../electron/services/modpacks/artifacts/artifact-cache.cjs');
const { ArtifactDownloader } = require('../../../electron/services/modpacks/artifacts/artifact-downloader.cjs');

const DISPOSABLE_CLIENT_JOIN_ENV = 'MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E';
const DISPOSABLE_CLIENT_ID = 'disposable-client-join-e2e';
const SENSITIVE_AUTH_KEY = /(?:^token$|_token$|access_token|refresh_token|client_token)/iu;
const MAX_DISPOSABLE_MRPACK_BYTES = 64 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA512 = /^[a-f0-9]{128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MINECRAFT_USERNAME = /^[A-Za-z0-9_]{3,16}$/u;

function isDisposableClientJoinEnabled(environment = process.env) {
  const value = String(environment?.[DISPOSABLE_CLIENT_JOIN_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function assertDisposablePath(lifecycle, candidatePath) {
  if (!lifecycle || typeof lifecycle.root !== 'string' || typeof candidatePath !== 'string') {
    throw new TypeError('A disposable lifecycle root and candidate path are required');
  }
  const root = path.resolve(lifecycle.root);
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Refusing to access a path outside the disposable lifecycle root');
  }
  const redirectError = () => new Error('Refusing to access a path through a symbolic link, junction, or reparse point');
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw redirectError();
  const realpath = fs.realpathSync.native || fs.realpathSync;
  const realRoot = realpath(root);
  const comparePath = value => process.platform === 'win32'
    ? path.normalize(value).toLocaleLowerCase('en-US')
    : path.normalize(value);
  const parts = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) throw redirectError();
    const expectedRealPath = path.join(realRoot, ...parts.slice(0, index + 1));
    if (comparePath(realpath(current)) !== comparePath(expectedRealPath)) throw redirectError();
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error('Refusing to traverse a non-directory disposable path component');
    }
  }
  return resolved;
}

function setProperty(lines, key, value) {
  let replaced = false;
  const retained = [];
  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      if (!replaced) {
        retained.push(`${key}=${value}`);
        replaced = true;
      }
      continue;
    }
    retained.push(line);
  }
  if (!replaced) retained.push(`${key}=${value}`);
  return retained;
}

async function configureOfflineServerProperties(lifecycle) {
  const serverPath = assertDisposablePath(lifecycle, lifecycle?.serverPath);
  const propertiesPath = assertDisposablePath(lifecycle, path.join(serverPath, 'server.properties'));
  const existing = fs.existsSync(propertiesPath) ? await fsp.readFile(propertiesPath, 'utf8') : '';
  const lines = existing.split(/\r?\n/u).filter((line, index, values) => line !== '' || index < values.length - 1);
  const offline = setProperty(lines, 'online-mode', 'false');
  const secureProfileDisabled = setProperty(offline, 'enforce-secure-profile', 'false');
  const loopbackOnly = setProperty(secureProfileDisabled, 'server-ip', '127.0.0.1');
  assertDisposablePath(lifecycle, propertiesPath);
  await fsp.writeFile(propertiesPath, `${loopbackOnly.join('\n')}\n`, 'utf8');
  return propertiesPath;
}

function createDisposableUsername({ randomBytes = crypto.randomBytes } = {}) {
  if (typeof randomBytes !== 'function') throw new TypeError('A cryptographic random byte source is required');
  const entropy = randomBytes(6);
  if (!Buffer.isBuffer(entropy) || entropy.length !== 6) {
    throw new Error('Disposable username entropy must contain exactly six bytes');
  }
  return `E2E_${entropy.toString('hex')}`;
}

function createSyntheticAuthData({ username, now = new Date() } = {}) {
  if (typeof username !== 'string' || !MINECRAFT_USERNAME.test(username)) {
    throw new TypeError('Synthetic Minecraft username must contain 3-16 letters, digits, or underscores');
  }
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError('Synthetic auth timestamp is invalid');
  return {
    access_token: 'disposable-access-token',
    client_token: 'disposable-client-token',
    uuid: '00000000-0000-0000-0000-000000000001',
    name: username,
    user_properties: {},
    savedAt: timestamp.toISOString(),
    lastRefresh: timestamp.toISOString(),
    xmcl_tokens: {
      microsoft: {
        access_token: 'disposable-microsoft-access-token',
        refresh_token: 'disposable-refresh-token'
      }
    }
  };
}

function packSyntheticAuthData(value, encryptString, key = '') {
  if (typeof encryptString !== 'function') throw new TypeError('An encryption function is required');
  if (typeof value === 'string') {
    return SENSITIVE_AUTH_KEY.test(key) && value ? `enc:${encryptString(value)}` : value;
  }
  if (Array.isArray(value)) return value.map(entry => packSyntheticAuthData(entry, encryptString));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    packSyntheticAuthData(entryValue, encryptString, entryKey)
  ]));
}

async function writeSyntheticEncryptedAuth(electronApp, lifecycle, { username, now = new Date() } = {}) {
  if (!electronApp || typeof electronApp.evaluate !== 'function') {
    throw new TypeError('A running Electron application is required');
  }
  const clientPath = assertDisposablePath(lifecycle, lifecycle?.clientPath);
  const authPath = assertDisposablePath(lifecycle, path.join(clientPath, 'xmcl-auth.json'));
  const authData = createSyntheticAuthData({ username, now });
  const packedAuth = await electronApp.evaluate(async ({ safeStorage }, { authData: source }) => {
    await new Promise(resolve => setImmediate(resolve));
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
      throw new Error('Electron safeStorage is unavailable for disposable auth');
    }
    const sensitive = /(?:^token$|_token$|access_token|refresh_token|client_token)/iu;
    const pack = (value, key = '') => {
      if (typeof value === 'string') {
        return sensitive.test(key) && value
          ? `enc:${safeStorage.encryptString(value).toString('base64')}`
          : value;
      }
      if (Array.isArray(value)) return value.map(entry => pack(entry));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, pack(entryValue, entryKey)]));
    };
    return JSON.stringify(pack(source), null, 2);
  }, { authData });
  if (typeof packedAuth !== 'string') throw new Error('Electron safeStorage did not return packed disposable auth');
  assertDisposablePath(lifecycle, authPath);
  await fsp.writeFile(authPath, packedAuth, 'utf8');
  return authPath;
}

async function registerDisposableClient(page, lifecycle, { username } = {}) {
  const clientPath = assertDisposablePath(lifecycle, lifecycle?.clientPath);
  const result = await realHarness.invoke(page, 'save-client-config', {
    path: clientPath,
    serverIp: lifecycle.serverHost,
    serverPort: String(lifecycle.managementPort),
    clientId: DISPOSABLE_CLIENT_ID,
    clientName: username
  });
  if (!result?.success) throw new Error(`Could not register disposable client: ${result?.error || 'unknown failure'}`);
  const initializedPath = assertDisposablePath(lifecycle, path.join(clientPath, '.servers-initialized'));
  assertDisposablePath(lifecycle, initializedPath);
  await fsp.unlink(initializedPath).catch(error => {
    if (error?.code !== 'ENOENT') throw error;
  });
  return Object.freeze({ clientId: DISPOSABLE_CLIENT_ID, clientPath });
}

function runtimeFromDependencies(dependencies) {
  const loader = Object.keys(dependencies).find(key => key !== 'minecraft');
  if (!loader) {
    return {
      minecraftVersion: dependencies.minecraft,
      loaderFamily: 'vanilla',
      loaderVersion: dependencies.minecraft
    };
  }
  const loaderFamily = loader === 'fabric-loader'
    ? 'fabric'
    : loader === 'quilt-loader' ? 'quilt' : loader;
  return {
    minecraftVersion: dependencies.minecraft,
    loaderFamily,
    loaderVersion: dependencies[loader]
  };
}

function archiveOperation(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      (entry.type !== 'file' && entry.type !== 'directory') || typeof entry.path !== 'string') {
    throw new TypeError('A validated MRPACK archive entry is required');
  }
  const archivePath = entry.type === 'directory' ? entry.path.replace(/[\\/]+$/u, '') : entry.path;
  const normalizedArchivePath = normalizeMrpackPath(archivePath, { rejectState: false });
  const slash = normalizedArchivePath.indexOf('/');
  if (slash < 0) return null;
  const layer = normalizedArchivePath.slice(0, slash).toLocaleLowerCase('en-US');
  if (layer !== 'overrides' && layer !== 'client-overrides') return null;
  const targetPath = normalizeMrpackPath(normalizedArchivePath.slice(slash + 1));
  const size = entry.size === undefined ? undefined : String(entry.size);
  if (size !== undefined && !/^(?:0|[1-9][0-9]*)$/u.test(size)) {
    throw new TypeError('A validated MRPACK archive entry size is required');
  }
  return {
    layer,
    order: layer === 'overrides' ? 1 : 2,
    archivePath: normalizedArchivePath,
    targetPath,
    type: entry.type,
    ...(size === undefined ? {} : { size })
  };
}

function assertProjectedTargets(downloads, operations) {
  const nodes = new Map();
  const projected = [
    ...downloads.map(download => ({ type: 'file', order: 0, targetPath: download.targetPath })),
    ...operations.map(operation => ({
      type: operation.type,
      order: operation.order,
      targetPath: operation.targetPath
    }))
  ].sort((left, right) => left.order - right.order ||
    canonicalWindowsPath(left.targetPath).localeCompare(canonicalWindowsPath(right.targetPath), 'en-US') ||
    left.type.localeCompare(right.type));

  for (const item of projected) {
    const alias = canonicalWindowsPath(item.targetPath);
    const current = nodes.get(alias);
    if (current) {
      if (current.type !== item.type) throw new Error('Client MRPACK contains a file-directory collision');
      if (item.type === 'file') {
        if (item.order <= current.order) throw new Error('Client MRPACK contains a duplicate target');
        nodes.set(alias, item);
      }
      continue;
    }
    const parts = alias.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (nodes.get(parts.slice(0, index).join('/'))?.type === 'file') {
        throw new Error('Client MRPACK contains a file-directory collision');
      }
    }
    if (item.type === 'file') {
      for (const [existingAlias] of nodes) {
        if (existingAlias.startsWith(`${alias}/`)) {
          throw new Error('Client MRPACK contains a file-directory collision');
        }
      }
    }
    nodes.set(alias, item);
  }
}

function buildMrpackClientProjection({ manifest: sourceManifest, archiveEntries = [] } = {}) {
  const manifest = ensureValidatedMrpackManifest(sourceManifest);
  if (!Array.isArray(archiveEntries)) throw new TypeError('MRPACK archive entries are required');
  const downloads = manifest.files
    .filter(file => file.env.client !== 'unsupported')
    .map(file => ({
      targetPath: file.path,
      client: file.env.client,
      optional: file.env.client === 'optional',
      size: file.fileSize,
      hashes: { ...file.hashes },
      downloadUrlCandidates: [...file.downloads]
    }));
  const operations = archiveEntries.map(archiveOperation).filter(Boolean);
  assertProjectedTargets(downloads, operations);
  operations.sort((left, right) => left.order - right.order ||
    canonicalWindowsPath(left.archivePath).localeCompare(canonicalWindowsPath(right.archivePath), 'en-US'));

  const finalOverrides = new Map();
  for (const operation of operations) {
    if (operation.type === 'file') finalOverrides.set(canonicalWindowsPath(operation.targetPath), operation);
  }

  return Object.freeze({
    type: 'mrpack-client-projection',
    manifestVersionId: manifest.versionId,
    runtime: Object.freeze(runtimeFromDependencies(manifest.dependencies)),
    downloads: Object.freeze(downloads.map(download => Object.freeze(download))),
    overrideOperations: Object.freeze(operations.map(operation => Object.freeze(operation))),
    finalOverrides: Object.freeze([...finalOverrides.values()]
      .sort((left, right) => canonicalWindowsPath(left.targetPath).localeCompare(canonicalWindowsPath(right.targetPath), 'en-US'))
      .map(operation => Object.freeze({
        layer: operation.layer,
        archivePath: operation.archivePath,
        targetPath: operation.targetPath,
        ...(operation.size === undefined ? {} : { size: operation.size })
      })))
  });
}

function openMrpackZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_DISPOSABLE_MRPACK_BYTES) {
    return Promise.reject(new Error('Verified MRPACK archive size is invalid'));
  }
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

function zipEntryPolicyRecord(entry) {
  const rawName = entry?.fileName;
  if (typeof rawName !== 'string' || !rawName || rawName.includes('\\') ||
      !Number.isSafeInteger(entry.compressedSize) || !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.compressedSize < 0 || entry.uncompressedSize < 0) {
    throw new Error('MRPACK archive contains an invalid ZIP entry');
  }
  const attributes = Number(entry.externalFileAttributes || 0) >>> 0;
  const unixMode = (attributes >>> 16) & 0xffff;
  const unixType = unixMode & 0xf000;
  const symbolicLink = unixType === 0xa000;
  const directory = !symbolicLink && (rawName.endsWith('/') || unixType === 0x4000);
  const archivePath = directory ? rawName.replace(/\/+$/u, '') : rawName;
  return {
    rawName,
    policy: {
      path: archivePath,
      type: symbolicLink ? 'symlink' : directory ? 'directory' : 'file',
      size: String(entry.uncompressedSize),
      packedSize: String(entry.compressedSize),
      encrypted: Boolean(entry.generalPurposeBitFlag & 1),
      attributes: symbolicLink ? 'lrwxrwxrwx' : directory ? 'drwxr-xr-x' : '-rw-r--r--',
      reparse: Boolean((attributes & 0x400) !== 0),
      method: entry.compressionMethod
    }
  };
}

async function inspectZipEntries(buffer) {
  const zip = await openMrpackZip(buffer);
  return new Promise((resolve, reject) => {
    const entries = [];
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* retain the primary archive error */ }
      reject(error);
    };
    zip.on('error', fail);
    zip.on('entry', entry => {
      try {
        entries.push(zipEntryPolicyRecord(entry));
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* inspection is already complete */ }
      resolve(entries);
    });
    zip.readEntry();
  });
}

async function readZipFile(buffer, rawName, maximumBytes) {
  const zip = await openMrpackZip(buffer);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* retain the primary result */ }
      if (error) reject(error);
      else resolve(value);
    };
    zip.on('error', error => finish(error));
    zip.on('entry', entry => {
      if (entry.fileName !== rawName) {
        zip.readEntry();
        return;
      }
      if (entry.fileName.endsWith('/') || !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0 || entry.uncompressedSize > maximumBytes) {
        finish(new Error('Reviewed MRPACK archive entry size is invalid'));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        const chunks = [];
        let measured = 0;
        stream.on('error', streamError => finish(streamError));
        stream.on('data', chunk => {
          measured += chunk.length;
          if (measured > maximumBytes || measured > entry.uncompressedSize) {
            stream.destroy(new Error('Reviewed MRPACK archive entry exceeded its declared size'));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => {
          if (measured !== entry.uncompressedSize) {
            finish(new Error('Reviewed MRPACK archive entry size changed'));
            return;
          }
          finish(null, Buffer.concat(chunks, measured));
        });
      });
    });
    zip.on('end', () => finish(new Error('Reviewed MRPACK archive entry is unavailable')));
    zip.readEntry();
  });
}

async function inspectMrpackClientArchive(archiveBuffer) {
  const inspected = await inspectZipEntries(archiveBuffer);
  const validated = validateArchiveEntries(inspected.map(entry => entry.policy), ARCHIVE_LIMITS);
  const rawByCanonical = new Map();
  for (let index = 0; index < validated.entries.length; index += 1) {
    rawByCanonical.set(canonicalWindowsPath(validated.entries[index].path), inspected[index].rawName);
  }
  const manifestEntries = validated.entries.filter(entry =>
    entry.type === 'file' && canonicalWindowsPath(entry.path) === 'modrinth.index.json');
  if (manifestEntries.length !== 1) throw new Error('Verified MRPACK archive does not contain one exact manifest');
  const manifestEntry = manifestEntries[0];
  const manifestBuffer = await readZipFile(
    archiveBuffer,
    rawByCanonical.get(canonicalWindowsPath(manifestEntry.path)),
    Number(manifestEntry.size)
  );
  const manifest = parseMrpackManifest(manifestBuffer);
  const projection = buildMrpackClientProjection({ manifest, archiveEntries: validated.entries });
  const reviewedFiles = new Map(projection.overrideOperations
    .filter(operation => operation.type === 'file')
    .map(operation => [canonicalWindowsPath(operation.archivePath), operation]));

  return Object.freeze({
    manifest,
    projection,
    archiveEntries: validated.entries,
    async readArchiveEntry(archivePath) {
      const normalized = normalizeMrpackPath(archivePath, { rejectState: false });
      const reviewed = reviewedFiles.get(canonicalWindowsPath(normalized));
      if (!reviewed) throw new Error('Archive entry is not part of the reviewed client projection');
      const rawName = rawByCanonical.get(canonicalWindowsPath(reviewed.archivePath));
      return readZipFile(archiveBuffer, rawName, Number(reviewed.size));
    }
  });
}

function hashBuffer(buffer) {
  return {
    size: String(buffer.length),
    sha1: crypto.createHash('sha1').update(buffer).digest('hex'),
    sha512: crypto.createHash('sha512').update(buffer).digest('hex')
  };
}

async function acquireVerifiedMrpackFromModrinth(lifecycle, { projectId, versionId, expectedMrpackSha512 }) {
  const root = path.resolve(lifecycle.root);
  const cacheRoot = assertDisposablePath(lifecycle, path.join(root, 'client-pack-cache'));
  const workspaceRoot = assertDisposablePath(lifecycle, path.join(root, 'client-pack-workspaces'));
  const http = new PinnedHttpsClient({ lookup: dns.promises.lookup, request: https.request });
  const api = new BoundedApiClient({ client: http, baseUrl: 'https://api.modrinth.com/v2/' });
  const provider = new ModrinthModpackProvider({ http: api });
  const cache = new ArtifactCache({ root: cacheRoot, workspaceRoot, fsApi: fsp });
  const downloader = new ArtifactDownloader({
    client: http,
    cache,
    partialRoot: path.join(cacheRoot, 'partial'),
    fsApi: fsp,
    randomUUID: crypto.randomUUID
  });

  const plan = await provider.resolveArtifactSetPlan(versionId);
  if (plan.project?.id !== projectId || plan.release?.id !== versionId) {
    throw new Error('Modrinth returned a different immutable client pack identity');
  }
  const primaryPlan = plan.artifactSet.parts.find(part => part.partId === plan.artifactSet.primaryPartId);
  if (!primaryPlan || primaryPlan.providerDigest?.algorithm !== 'sha512' ||
      primaryPlan.providerDigest.value !== expectedMrpackSha512 || BigInt(primaryPlan.size) > BigInt(MAX_DISPOSABLE_MRPACK_BYTES)) {
    throw new Error('Modrinth client pack does not match the pinned immutable digest');
  }
  assertDisposablePath(lifecycle, cacheRoot);
  assertDisposablePath(lifecycle, workspaceRoot);
  const verified = await downloader.downloadSet(plan);
  const primary = verified.artifactSet.parts.find(part => part.partId === verified.artifactSet.primaryPartId);
  const sourcePlan = plan.artifactSet.parts.find(part => part.partId === primary?.partId);
  if (!primary || !sourcePlan?.requiredProviderDigests) {
    throw new Error('Verified Modrinth client pack artifact is incomplete');
  }
  const archivePath = cache.pathForSha256(primary.calculatedDigests.sha256);
  const archiveBuffer = await fsp.readFile(archivePath);
  const archiveHashes = hashBuffer(archiveBuffer);
  if (archiveHashes.size !== primary.measuredSize || archiveHashes.sha1 !== sourcePlan.requiredProviderDigests.sha1 ||
      archiveHashes.sha512 !== sourcePlan.requiredProviderDigests.sha512) {
    throw new Error('Verified Modrinth client pack archive changed after download');
  }

  return Object.freeze({
    projectId,
    versionId,
    fileName: primary.fileName,
    size: archiveHashes.size,
    sha1: archiveHashes.sha1,
    sha512: archiveHashes.sha512,
    archiveBuffer,
    async materializeDownload(download, destination) {
      const identity = crypto.createHash('sha256').update(download.targetPath).digest('hex').slice(0, 32);
      const partId = `client-${download.hashes.sha1}-${identity}`;
      let result = null;
      let lastError = null;
      for (const downloadUrl of download.downloadUrlCandidates) {
        try {
          assertDisposablePath(lifecycle, cacheRoot);
          assertDisposablePath(lifecycle, workspaceRoot);
          result = await downloader.downloadPart({
            partId,
            provider: 'modrinth',
            size: download.size,
            downloadUrl,
            allowedHosts: [...MRPACK_DOWNLOAD_HOSTS],
            allowSubdomains: false,
            providerDigest: { algorithm: 'sha512', value: download.hashes.sha512 },
            requiredProviderDigests: { ...download.hashes }
          });
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!result) throw lastError || new Error('Verified Modrinth client file could not be downloaded');
      assertDisposablePath(lifecycle, destination);
      const copied = await cache.copyAndVerify(cache.pathForSha256(result.sha256), destination, {
        sha256: result.sha256,
        sha512: result.sha512,
        size: result.measuredSize,
        sourceRoot: cacheRoot,
        targetRoot: root,
        sourceField: 'clientPackCache',
        targetField: 'clientPackDestination'
      });
      if (!copied) throw new Error('Verified Modrinth client file changed during installation');
    }
  });
}

async function installExactModrinthClientPack(lifecycle, {
  projectId,
  versionId,
  expectedMrpackSha512,
  acquireVerifiedMrpack = acquireVerifiedMrpackFromModrinth
} = {}) {
  if (!IDENTIFIER.test(projectId || '') || !IDENTIFIER.test(versionId || '') ||
      !SHA512.test(expectedMrpackSha512 || '') || typeof acquireVerifiedMrpack !== 'function') {
    throw new TypeError('An exact immutable Modrinth client pack request is required');
  }
  const acquired = await acquireVerifiedMrpack(lifecycle, { projectId, versionId, expectedMrpackSha512 });
  if (!acquired || acquired.projectId !== projectId || acquired.versionId !== versionId ||
      typeof acquired.fileName !== 'string' || !Buffer.isBuffer(acquired.archiveBuffer) ||
      !SHA1.test(acquired.sha1 || '') || !SHA512.test(acquired.sha512 || '') ||
      typeof acquired.size !== 'string' || typeof acquired.materializeDownload !== 'function') {
    throw new Error('Modrinth returned an invalid verified client pack');
  }
  const calculated = hashBuffer(acquired.archiveBuffer);
  if (calculated.size !== acquired.size || calculated.sha1 !== acquired.sha1 ||
      calculated.sha512 !== acquired.sha512 || calculated.sha512 !== expectedMrpackSha512) {
    throw new Error('Modrinth client pack does not match the pinned immutable digest');
  }
  const inspected = await inspectMrpackClientArchive(acquired.archiveBuffer);
  const installed = await installMrpackClientProjection(lifecycle, {
    projection: inspected.projection,
    materializeDownload: acquired.materializeDownload,
    readArchiveEntry: inspected.readArchiveEntry
  });
  return Object.freeze({
    ...installed,
    projectId,
    versionId,
    mrpackFileName: acquired.fileName,
    mrpackSha1: acquired.sha1,
    mrpackSha512: acquired.sha512
  });
}

async function hashRegularFile(filePath) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Installed client pack contains a non-regular file');
  const sha1 = crypto.createHash('sha1');
  const sha512 = crypto.createHash('sha512');
  let size = 0n;
  const handle = await fsp.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      sha1.update(chunk);
      sha512.update(chunk);
      size += BigInt(chunk.length);
    }
  } finally {
    await handle.close();
  }
  return {
    size: size.toString(),
    sha1: sha1.digest('hex'),
    sha512: sha512.digest('hex')
  };
}

async function listRegularFiles(root, directory = root) {
  const result = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const info = await fsp.lstat(filePath);
    if (info.isSymbolicLink()) throw new Error('Installed client pack contains a symbolic link');
    if (info.isDirectory()) result.push(...await listRegularFiles(root, filePath));
    else if (info.isFile()) result.push(path.relative(root, filePath).split(path.sep).join('/'));
    else throw new Error('Installed client pack contains a non-regular entry');
  }
  return result;
}

async function verifyClientPackAtRoot(root, receipt) {
  if (!receipt || !Array.isArray(receipt.files)) throw new TypeError('A client pack receipt is required');
  const expected = [...receipt.files].sort((left, right) => canonicalWindowsPath(left.path).localeCompare(canonicalWindowsPath(right.path), 'en-US'));
  const actual = (await listRegularFiles(root)).sort((left, right) => canonicalWindowsPath(left).localeCompare(canonicalWindowsPath(right), 'en-US'));
  if (actual.length !== expected.length || actual.some((file, index) => canonicalWindowsPath(file) !== canonicalWindowsPath(expected[index].path))) {
    throw new Error('Installed files do not match the exact client pack file set');
  }
  for (const file of expected) {
    const target = path.resolve(root, ...file.path.split('/'));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Installed client pack path escaped its root');
    }
    const calculated = await hashRegularFile(target);
    if (calculated.size !== file.size || calculated.sha1 !== file.sha1 || calculated.sha512 !== file.sha512) {
      throw new Error('Installed client pack file hash does not match the immutable manifest');
    }
  }
  return true;
}

async function installMrpackClientProjection(lifecycle, { projection, materializeDownload, readArchiveEntry } = {}) {
  if (!projection || projection.type !== 'mrpack-client-projection' || typeof materializeDownload !== 'function' ||
      typeof readArchiveEntry !== 'function') {
    throw new TypeError('A complete client MRPACK installation request is required');
  }
  const root = path.resolve(lifecycle?.root || '');
  const clientPath = assertDisposablePath(lifecycle, lifecycle?.clientPath);
  const clientInfo = await fsp.lstat(clientPath);
  if (!clientInfo.isDirectory() || clientInfo.isSymbolicLink() || (await fsp.readdir(clientPath)).length !== 0) {
    throw new Error('Disposable client directory must be an empty regular directory');
  }
  const stagingPrefix = path.join(root, '.client-pack-stage-');
  assertDisposablePath(lifecycle, `${stagingPrefix}candidate`);
  let stagingPath = assertDisposablePath(lifecycle, await fsp.mkdtemp(stagingPrefix));
  const finalFiles = new Map();
  try {
    for (const download of projection.downloads) {
      const destination = path.join(stagingPath, ...download.targetPath.split('/'));
      assertDisposablePath(lifecycle, destination);
      assertDisposablePath(lifecycle, path.dirname(destination));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      assertDisposablePath(lifecycle, destination);
      await materializeDownload(download, destination);
      assertDisposablePath(lifecycle, destination);
      const calculated = await hashRegularFile(destination);
      if (calculated.size !== download.size || calculated.sha1 !== download.hashes.sha1 ||
          calculated.sha512 !== download.hashes.sha512) {
        throw new Error('Downloaded client bytes do not match the immutable manifest hash');
      }
      finalFiles.set(canonicalWindowsPath(download.targetPath), {
        path: download.targetPath,
        source: 'download',
        ...calculated
      });
    }

    for (const operation of projection.overrideOperations) {
      const destination = path.join(stagingPath, ...operation.targetPath.split('/'));
      assertDisposablePath(lifecycle, destination);
      if (operation.type === 'directory') {
        assertDisposablePath(lifecycle, destination);
        await fsp.mkdir(destination, { recursive: true });
        continue;
      }
      const bytes = await readArchiveEntry(operation.archivePath);
      if (!Buffer.isBuffer(bytes) || (operation.size !== undefined && String(bytes.length) !== operation.size)) {
        throw new Error('Client override bytes do not match the verified MRPACK archive');
      }
      assertDisposablePath(lifecycle, path.dirname(destination));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      assertDisposablePath(lifecycle, destination);
      await fsp.unlink(destination).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
      assertDisposablePath(lifecycle, destination);
      await fsp.writeFile(destination, bytes, { flag: 'wx' });
      assertDisposablePath(lifecycle, destination);
      const calculated = await hashRegularFile(destination);
      finalFiles.set(canonicalWindowsPath(operation.targetPath), {
        path: operation.targetPath,
        source: operation.layer,
        ...calculated
      });
    }

    const files = [...finalFiles.values()].sort((left, right) =>
      canonicalWindowsPath(left.path).localeCompare(canonicalWindowsPath(right.path), 'en-US'));
    const receipt = Object.freeze({
      type: 'installed-mrpack-client',
      manifestVersionId: projection.manifestVersionId,
      runtime: projection.runtime,
      files: Object.freeze(files.map(file => Object.freeze(file)))
    });
    await verifyClientPackAtRoot(stagingPath, receipt);
    assertDisposablePath(lifecycle, clientPath);
    await fsp.rmdir(clientPath);
    try {
      assertDisposablePath(lifecycle, stagingPath);
      assertDisposablePath(lifecycle, clientPath);
      await fsp.rename(stagingPath, clientPath);
      stagingPath = null;
    } catch (error) {
      assertDisposablePath(lifecycle, clientPath);
      await fsp.mkdir(clientPath).catch(() => {});
      throw error;
    }
    await verifyClientPackAtRoot(clientPath, receipt);
    return receipt;
  } catch (error) {
    if (stagingPath) {
      try {
        assertDisposablePath(lifecycle, stagingPath);
        await fsp.rm(stagingPath, { recursive: true, force: true });
      } catch { /* preserve the primary installation error */ }
    }
    throw error;
  }
}

async function verifyInstalledClientPack(lifecycle, receipt) {
  return verifyClientPackAtRoot(assertDisposablePath(lifecycle, lifecycle?.clientPath), receipt);
}

function assertRuntime(runtime) {
  if (!runtime || typeof runtime.minecraftVersion !== 'string' || typeof runtime.loaderFamily !== 'string' || typeof runtime.loaderVersion !== 'string') {
    throw new TypeError('A complete reviewed modpack runtime is required');
  }
  return runtime;
}

async function launchDisposableClient(page, lifecycle, runtime) {
  const reviewedRuntime = assertRuntime(runtime);
  const clientPath = assertDisposablePath(lifecycle, lifecycle?.clientPath);
  const result = await realHarness.invoke(page, 'minecraft-launch', {
    clientPath,
    minecraftVersion: reviewedRuntime.minecraftVersion,
    serverIp: lifecycle.serverHost,
    serverPort: lifecycle.serverPort,
    managementPort: lifecycle.managementPort,
    clientName: 'Disposable client join proof',
    requiredMods: [],
    serverInfo: {
      minecraftVersion: reviewedRuntime.minecraftVersion,
      loader: reviewedRuntime.loaderFamily,
      loaderType: reviewedRuntime.loaderFamily,
      loaderVersion: reviewedRuntime.loaderVersion,
      ...(reviewedRuntime.loaderFamily === 'fabric' ? { fabric: reviewedRuntime.loaderVersion } : {})
    },
    maxMemory: 2048,
    useProperLauncher: true,
    strictProperLauncher: true,
    showDebugTerminal: false
  });
  if (!result?.success) throw new Error(`Could not launch disposable client: ${result?.error || 'unknown failure'}`);
  if (result.launcherKind !== 'proper' || result.fallbackAttempted !== false) {
    throw new Error('Disposable client did not use the strict proper launcher');
  }
  return result;
}

async function stopDisposableClient(page, { timeoutMs = 60_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const result = await realHarness.invokeBeforeTeardownDeadline(
    page, 'minecraft-stop', {}, deadline, 'client stop'
  );
  if (!result?.success) throw new Error(`Could not stop disposable client: ${result?.error || 'unknown failure'}`);
  while (Date.now() < deadline) {
    const status = await realHarness.invokeBeforeTeardownDeadline(
      page, 'minecraft-launcher-status', {}, deadline, 'client status'
    );
    if (status?.success && !status.status?.isRunning) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error('Disposable client did not stop cleanly');
}

async function stopDisposableServer(page, lifecycle, instanceId, { timeoutMs = 60_000, pollMs = 500 } = {}) {
  return realHarness.stopIsolatedServer(page, lifecycle, instanceId, { timeoutMs, pollMs });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readLatestLog(latestLogPath) {
  try {
    return await fsp.readFile(latestLogPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

async function captureLatestLogBoundary(lifecycle) {
  const latestLogPath = assertDisposablePath(lifecycle, path.join(lifecycle.serverPath, 'logs', 'latest.log'));
  const existing = await readLatestLog(latestLogPath);
  assertDisposablePath(lifecycle, latestLogPath);
  return Object.freeze({
    type: 'disposable-latest-log-boundary',
    latestLogPath,
    byteOffset: existing.length,
    prefixSha256: sha256(existing)
  });
}

function assertLatestLogBoundary(boundary, latestLogPath) {
  if (!boundary || boundary.type !== 'disposable-latest-log-boundary' ||
      typeof boundary.latestLogPath !== 'string' || path.resolve(boundary.latestLogPath) !== latestLogPath ||
      !Number.isSafeInteger(boundary.byteOffset) || boundary.byteOffset < 0 || !SHA256.test(boundary.prefixSha256 || '')) {
    throw new TypeError('A captured disposable latest.log boundary is required');
  }
  return boundary;
}

async function waitForJoinLog(lifecycle, username, {
  boundary,
  timeoutMs = 5 * 60_000,
  pollMs = 1_000
} = {}) {
  if (typeof username !== 'string' || !MINECRAFT_USERNAME.test(username)) {
    throw new TypeError('A valid disposable Minecraft username is required');
  }
  const latestLogPath = assertDisposablePath(lifecycle, path.join(lifecycle.serverPath, 'logs', 'latest.log'));
  const captured = assertLatestLogBoundary(boundary, latestLogPath);
  const joined = new RegExp(
    `^\\[[^\\]\\r\\n]+\\] \\[Server thread\\/INFO\\](?: \\[[^\\]\\r\\n]+\\])?: ${escapeRegex(username)} joined the game\\r?$`,
    'u'
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertDisposablePath(lifecycle, latestLogPath);
    const contents = await readLatestLog(latestLogPath);
    if (contents.length < captured.byteOffset ||
        sha256(contents.subarray(0, captured.byteOffset)) !== captured.prefixSha256) {
      throw new Error('Disposable server latest.log changed across the captured client-launch boundary');
    }
    const appended = contents.subarray(captured.byteOffset).toString('utf8');
    const lastCompleteLine = appended.lastIndexOf('\n');
    if (lastCompleteLine >= 0) {
      const completeLines = appended.slice(0, lastCompleteLine).split('\n');
      const matchingLine = completeLines.find(line => joined.test(line));
      if (matchingLine !== undefined) {
        const joinLine = matchingLine.replace(/\r$/u, '');
        return { latestLogPath, latestLog: appended, joinLine, boundary: captured };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Disposable server log did not record ${username} joining the game`);
}

async function collectDisposableJoinEvidence(lifecycle) {
  assertDisposablePath(lifecycle, lifecycle.serverPath);
  assertDisposablePath(lifecycle, lifecycle.evidencePath);
  const evidence = await realHarness.collectServerEvidence(lifecycle);
  const authPath = assertDisposablePath(lifecycle, path.join(lifecycle.clientPath, 'xmcl-auth.json'));
  const payload = {
    ...evidence,
    disposableAuthPath: authPath,
    disposableAuthExists: fs.existsSync(authPath)
  };
  const evidencePath = assertDisposablePath(lifecycle, path.join(lifecycle.evidencePath, 'disposable-client-join-evidence.json'));
  assertDisposablePath(lifecycle, evidencePath);
  await fsp.writeFile(evidencePath, JSON.stringify(payload, null, 2));
  return payload;
}

async function finalizeDisposableClientJoin({
  completed,
  close,
  collectEvidence,
  attachEvidence,
  dispose,
  environment = process.env
} = {}) {
  if (typeof completed !== 'boolean' || typeof close !== 'function' ||
      typeof collectEvidence !== 'function' || typeof attachEvidence !== 'function' ||
      typeof dispose !== 'function') {
    throw new TypeError('Disposable client join finalization dependencies are invalid');
  }
  let closeError = null;
  try {
    await close();
  } catch (error) {
    closeError = error;
  }
  const failed = !completed;
  let preserveRoot = closeError !== null || (failed && realHarness.shouldPreserveFailedRealE2E(environment));
  let followupError = null;
  if (failed || closeError !== null) {
    try {
      const evidence = await collectEvidence();
      await attachEvidence(evidence);
    } catch (error) {
      preserveRoot = true;
      followupError = error;
    }
  }
  try {
    await dispose({ preserveRoot });
  } catch (error) {
    followupError ||= error;
  }
  if (closeError) throw closeError;
  if (followupError) throw followupError;
}

module.exports = {
  DISPOSABLE_CLIENT_JOIN_ENV,
  DISPOSABLE_CLIENT_ID,
  isDisposableClientJoinEnabled,
  assertDisposablePath,
  configureOfflineServerProperties,
  createDisposableUsername,
  createSyntheticAuthData,
  packSyntheticAuthData,
  writeSyntheticEncryptedAuth,
  registerDisposableClient,
  buildMrpackClientProjection,
  inspectMrpackClientArchive,
  installMrpackClientProjection,
  installExactModrinthClientPack,
  verifyInstalledClientPack,
  launchDisposableClient,
  stopDisposableClient,
  stopDisposableServer,
  captureLatestLogBoundary,
  waitForJoinLog,
  collectDisposableJoinEvidence,
  finalizeDisposableClientJoin
};
