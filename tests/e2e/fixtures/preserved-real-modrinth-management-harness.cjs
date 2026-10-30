const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const yauzl = require('yauzl');

const { OperationJournal, verifyDirectoryMarker } = require('../../../electron/services/modpack-lifecycle/operation-journal.cjs');
const {
  createRecoveryTargetEnvelope,
  verifyRecoveryTargetEnvelope
} = require('../../../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');
const { normalizeRecord } = require('../../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const {
  identifyServerDirectory,
  inspectServerDirectoryTree
} = require('../../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const {
  createExistingSiblingPaths
} = require('../../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const {
  WindowsReparseInspector
} = require('../../../electron/services/modpacks/local/windows-reparse-inspector.cjs');
const { pathIsProtected } = require('../../../electron/services/modpacks/planning/ownership-planner.cjs');
const realHarness = require('./real-modpack-harness.cjs');

const MANAGEMENT_CONTINUATION_ROOT_ENV = 'MINECRAFT_CORE_REAL_MODPACK_MANAGEMENT_CONTINUATION_ROOT';
const MANAGEMENT_ENABLE_ENV = 'MINECRAFT_CORE_REAL_MODPACK_MANAGEMENT_E2E';
const MANAGEMENT_SCRATCH_PREFIX = 'minecraft-core-real-modrinth-management-e2e-';
const MANAGEMENT_IDENTITY = Object.freeze({ provider: 'modrinth', scenario: 'management-lifecycle' });
const WORLD_SENTINEL_RELATIVE = 'world/minecraft-core-real-e2e.keep';
const WORLD_SENTINEL_TEXT = 'unmanaged world data must survive\n';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const JOB_ID_PATTERN = /^(?:job-[A-Za-z0-9_-]{1,123}|op2-[0-9a-f]{32})$/u;
const OPERATION_RECORD_KEYS = Object.freeze([
  'type', 'schemaVersion', 'sequence', 'jobId', 'operationKind', 'serverId', 'planFingerprint', 'phase', 'swapStep',
  'progress', 'cancellationRequested', 'createdAt', 'updatedAt', 'terminalAt', 'outcome', 'events', 'checksum'
]);

function matchesManagementIdentity(value) {
  return Boolean(value && Object.keys(value).length === 2 &&
    value.provider === MANAGEMENT_IDENTITY.provider && value.scenario === MANAGEMENT_IDENTITY.scenario);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function assertNoLifecycleProcesses(root, { processes = null } = {}) {
  let candidates = processes;
  if (candidates === null) {
    if (process.platform !== 'win32') return Object.freeze([]);
    const command = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(java|javaw|electron)\\.exe$" } | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress';
    const result = childProcess.spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command
    ], { encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: false });
    if (result.error || result.status !== 0 || result.signal || String(result.stderr || '').trim()) {
      fail('could not audit lifecycle Electron and Java processes');
    }
    const output = String(result.stdout || '').trim();
    const parsed = output ? JSON.parse(output) : [];
    candidates = Array.isArray(parsed) ? parsed : [parsed];
  }
  const rootKey = comparablePath(root);
  const matching = candidates.filter(value => /^(?:java|javaw|electron)(?:\.exe)?$/iu.test(value?.Name || value?.name || '') &&
    comparablePath(String(value?.CommandLine || value?.commandLine || '')).includes(rootKey));
  if (matching.length !== 0) fail('completed management still has a lifecycle-root Electron or Java process');
  return Object.freeze([]);
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.volumeSerial === right.volumeSerial && left.fileId === right.fileId);
}

function fail(message, cause = null) {
  throw new Error(`The preserved management lifecycle ${message}`, cause ? { cause } : undefined);
}

function hasExactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function verifyPublicOperation(value, label) {
  if (!value || JSON.stringify(Object.keys(value)) !== JSON.stringify(OPERATION_RECORD_KEYS) ||
      value.type !== 'minecraft-core-modpack-job' || value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !JOB_ID_PATTERN.test(value.jobId) ||
      typeof value.operationKind !== 'string' || value.serverId === '' || typeof value.serverId !== 'string' ||
      (value.planFingerprint !== null && !SHA256_PATTERN.test(value.planFingerprint)) ||
      !['completed', 'failed'].includes(value.phase) || value.swapStep !== null ||
      value.cancellationRequested !== false || !value.progress || typeof value.progress !== 'object' ||
      !Array.isArray(value.events) || value.events.length !== 0 || typeof value.createdAt !== 'string' ||
      typeof value.updatedAt !== 'string' || typeof value.terminalAt !== 'string' || !value.outcome ||
      typeof value.outcome !== 'object' || !SHA256_PATTERN.test(value.checksum)) fail(`${label} is invalid`);
  const payload = Object.fromEntries(OPERATION_RECORD_KEYS
    .filter(key => key !== 'checksum')
    .map(key => [key, value[key]]));
  const expected = Buffer.from(sha256Bytes(JSON.stringify(payload)), 'hex');
  const actual = Buffer.from(value.checksum, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) fail(`${label} checksum is invalid`);
  return value;
}

function sha256File(filePath) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, position);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
      position += count;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function getPreservedManagementRoot(environment = process.env) {
  const value = environment?.[MANAGEMENT_CONTINUATION_ROOT_ENV];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

function enabled(value) {
  return ['1', 'true'].includes(String(value || '').trim().toLocaleLowerCase('en-US'));
}

function isPreservedManagementContinuationEnabled(environment = process.env) {
  return enabled(environment?.[MANAGEMENT_ENABLE_ENV]) && getPreservedManagementRoot(environment) !== null;
}

function assertScratchLocation(rootValue) {
  if (typeof rootValue !== 'string' || rootValue.trim() === '') fail('requires an explicit preserved root');
  const root = path.resolve(rootValue.trim());
  if (!pathsEqual(path.dirname(root), os.tmpdir())) fail('root must be directly under the operating-system temporary directory');
  const basename = path.basename(root);
  if (!basename.startsWith(MANAGEMENT_SCRATCH_PREFIX) || basename.length === MANAGEMENT_SCRATCH_PREFIX.length) {
    fail('root must use the exact management continuation prefix');
  }
  return root;
}

async function assertNotReparse(candidate, inspector) {
  let result;
  try { result = await inspector.isReparsePoint(candidate); }
  catch (error) { fail('contains an object whose reparse status could not be verified', error); }
  if (result !== false) fail('contains a redirected filesystem object');
}

async function assertCanonicalDirectory(directoryPath, expectedParent, inspector) {
  const stat = await fsp.lstat(directoryPath).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('contains a missing or redirected directory');
  await assertNotReparse(directoryPath, inspector);
  const real = await fsp.realpath(directoryPath);
  if (!pathsEqual(real, directoryPath) || (expectedParent && !pathsEqual(path.dirname(real), expectedParent))) {
    fail('contains a directory outside its validated root');
  }
  return real;
}

async function assertCanonicalFile(filePath, expectedParent, inspector, label, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const stat = await fsp.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
    fail(`${label} is missing, redirected, linked, or oversized`);
  }
  await assertNotReparse(filePath, inspector);
  const real = await fsp.realpath(filePath);
  if (!pathsEqual(real, filePath) || !pathsEqual(path.dirname(real), expectedParent)) {
    fail(`${label} is outside its validated directory`);
  }
  return { filePath: real, stat };
}

async function readCanonicalJson(filePath, expectedParent, inspector, label, options = {}) {
  await assertCanonicalFile(filePath, expectedParent, inspector, label, options);
  try {
    const value = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch (error) {
    fail(`${label} is invalid JSON`, error);
  }
}

async function assertAbsent(candidate, label) {
  const stat = await fsp.lstat(candidate).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (stat) fail(`${label} must be absent`);
}

function strictIdentity(identity, label) {
  if (!identity || Object.keys(identity).length !== 2 || typeof identity.volumeSerial !== 'string' ||
      typeof identity.fileId !== 'string' || !/^[a-f0-9]{1,32}$/u.test(identity.volumeSerial) ||
      !/^[a-f0-9]{1,64}$/u.test(identity.fileId)) fail(`${label} identity is invalid`);
  return identity;
}

function assertRuntime(runtime, label) {
  if (!runtime || runtime.minecraftVersion !== '1.20.1' || runtime.loaderFamily !== 'fabric' ||
      typeof runtime.loaderVersion !== 'string' || runtime.loaderVersion.length === 0 || runtime.javaMajor !== 17 ||
      runtime.os !== 'win32' || runtime.architecture !== 'x64') fail(`${label} runtime is invalid`);
  return runtime;
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('/') || value.includes('\\') ||
      value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(`${label} path is invalid`);
  }
  return value;
}

// Reads a stored manifest entry the way ModpackStateRepository does. A planner-protected path
// (server.properties, JVM argument files, run scripts, worlds) is the server owner's file, even
// where a manifest recorded by an earlier build lists it as pack or runtime content, so earlier
// preserved runs and fresh runs are audited alike.
function repositoryManifestEntry(entry) {
  if (!entry || !['pack', 'runtime'].includes(entry.origin) || typeof entry.pathKey !== 'string' ||
      !pathIsProtected(entry.pathKey, entry.role, entry.managementPolicy, [], [], entry.origin)) return entry;
  if (entry.origin === 'runtime') {
    return { ...entry, origin: 'user', managementPolicy: 'protected', role: entry.role === 'world' ? 'world' : 'other' };
  }
  return entry.managementPolicy === 'replaceable-managed' ? { ...entry, managementPolicy: 'preserve-after-seed' } : entry;
}

// The manifest entries an uninstall removes: unchanged pack and runtime files, never protected ones.
function uninstallableManagedEntries(manifest, serverPath) {
  const entries = [];
  const seen = new Set();
  for (const storedEntry of manifest.entries) {
    const entry = repositoryManifestEntry(storedEntry);
    if (!entry || !['pack', 'runtime'].includes(entry.origin) || entry.managementPolicy !== 'replaceable-managed' ||
        ['world', 'secret', 'application'].includes(entry.role)) continue;
    if (typeof entry.pathKey !== 'string' || !SHA256_PATTERN.test(entry.installedHash) ||
        !/^(0|[1-9][0-9]*)$/u.test(entry.size)) fail('rollback managed manifest entry is invalid');
    const relative = safeRelativePath(entry.path, 'rollback managed');
    const pathKey = entry.pathKey.toLocaleLowerCase('en-US');
    if (pathKey === '.minecraft-core.json' || pathKey === '.minecraft-core-state' ||
        pathKey.startsWith('.minecraft-core-state/')) continue;
    const resolved = path.resolve(serverPath, ...relative.split('/'));
    if (!comparablePath(resolved).startsWith(`${comparablePath(serverPath)}${path.sep}`) || seen.has(comparablePath(resolved))) {
      fail('rollback managed manifest paths are invalid or ambiguous');
    }
    seen.add(comparablePath(resolved));
    entries.push({ entry, filePath: resolved });
  }
  if (entries.length === 0) fail('rollback manifest does not expose uninstallable managed files');
  return entries.sort((left, right) => comparablePath(left.filePath).localeCompare(comparablePath(right.filePath), 'en-US'));
}

function uninstallableManagedPaths(manifest, serverPath) {
  return uninstallableManagedEntries(manifest, serverPath).map(item => item.filePath);
}

async function readManagedState(serverPath, inspector, {
  expectedVersionId,
  expectedRevision,
  expectedRuntime = null,
  requireSentinel = true,
  requireSentinelManifestEntry = true
} = {}) {
  const stateRoot = await assertCanonicalDirectory(path.join(serverPath, '.minecraft-core-state'), serverPath, inspector);
  const state = await readCanonicalJson(path.join(stateRoot, 'modpack.json'), stateRoot, inspector, 'managed state');
  if (state.schemaVersion !== 1 || state.modpackManaged !== true || state.source?.provider !== 'modrinth' ||
      state.source?.projectId !== realHarness.REAL_MODRINTH_LIFECYCLE.projectId || state.source?.versionId !== expectedVersionId ||
      state.contentRevision !== expectedRevision || typeof state.manifestId !== 'string') {
    fail('managed state does not match the exact expected Modrinth revision');
  }
  assertRuntime(state.runtime, 'managed state');
  if (expectedRuntime && JSON.stringify(state.runtime) !== JSON.stringify(expectedRuntime)) {
    fail('managed state runtime does not match the durable lifecycle evidence');
  }
  const manifestsPath = await assertCanonicalDirectory(path.join(stateRoot, 'manifests'), stateRoot, inspector);
  const manifest = await readCanonicalJson(
    path.join(manifestsPath, `${state.manifestId}.json`), manifestsPath, inspector, 'immutable manifest'
  );
  if (manifest.schemaVersion !== 1 || manifest.installationId !== state.manifestId || !Array.isArray(manifest.entries)) {
    fail('immutable manifest does not match the managed state');
  }
  const managedEntry = manifest.entries.find(entry => entry?.origin === 'pack' &&
    entry.managementPolicy === 'replaceable-managed' && entry.role === 'mod');
  if (!managedEntry || !SHA256_PATTERN.test(managedEntry.installedHash) || !/^(0|[1-9][0-9]*)$/u.test(managedEntry.size)) {
    fail('immutable manifest does not expose a replaceable managed mod');
  }
  const managedRelative = safeRelativePath(managedEntry.path, 'managed mod');
  const managedPath = path.resolve(serverPath, ...managedRelative.split('/'));
  if (!comparablePath(managedPath).startsWith(`${comparablePath(serverPath)}${path.sep}`)) fail('managed mod resolves outside the server');
  const managedParent = await fsp.realpath(path.dirname(managedPath));
  await assertCanonicalFile(managedPath, managedParent, inspector, 'managed mod');
  const managedStat = await fsp.stat(managedPath);
  if (String(managedStat.size) !== managedEntry.size || sha256File(managedPath) !== managedEntry.installedHash) {
    fail('managed mod does not match its immutable manifest');
  }
  const sentinelPath = path.join(serverPath, ...WORLD_SENTINEL_RELATIVE.split('/'));
  if (requireSentinel) {
    const sentinelParent = await fsp.realpath(path.dirname(sentinelPath));
    await assertCanonicalFile(sentinelPath, sentinelParent, inspector, 'world sentinel', { maxBytes: 4096 });
    if (await fsp.readFile(sentinelPath, 'utf8') !== WORLD_SENTINEL_TEXT) fail('world sentinel changed');
    const sentinelEntry = manifest.entries.find(entry => entry?.path === WORLD_SENTINEL_RELATIVE);
    if ((requireSentinelManifestEntry && !sentinelEntry) || (sentinelEntry &&
        (sentinelEntry.origin !== 'user' || sentinelEntry.managementPolicy !== 'protected' ||
        sentinelEntry.role !== 'world' || sentinelEntry.installedHash !== sha256File(sentinelPath)))) {
      fail('world sentinel is not protected by the immutable manifest');
    }
  }
  return { stateRoot, state, manifest, managedEntry, managedPath, sentinelPath };
}

async function readDetachedState(serverPath, inspector, {
  expectedRevision,
  expectedRuntime,
  expectedManifestId = null
} = {}) {
  const stateRoot = await assertCanonicalDirectory(path.join(serverPath, '.minecraft-core-state'), serverPath, inspector);
  const state = await readCanonicalJson(path.join(stateRoot, 'modpack.json'), stateRoot, inspector, 'detached state');
  if (!hasExactKeys(state, [
        'schemaVersion', 'modpackManaged', 'source', 'runtime', 'selectedOptionalFiles', 'installedAt',
        'contentRevision', 'manifestId'
      ]) || state.schemaVersion !== 1 || state.modpackManaged !== false ||
      !hasExactKeys(state.source, [
        'provider', 'version', 'title', 'projectId', 'versionId', 'artifactSetDigest'
      ]) || state.source.provider !== 'modrinth' ||
      state.source.projectId !== realHarness.REAL_MODRINTH_LIFECYCLE.projectId ||
      state.source.versionId !== realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id ||
      typeof state.source.version !== 'string' || state.source.version.length === 0 ||
      typeof state.source.title !== 'string' || state.source.title.length === 0 ||
      !SHA256_PATTERN.test(state.source.artifactSetDigest) || state.contentRevision !== expectedRevision ||
      typeof state.manifestId !== 'string' ||
      (expectedManifestId !== null && state.manifestId !== expectedManifestId) ||
      !Array.isArray(state.selectedOptionalFiles) || state.selectedOptionalFiles.length !== 0 ||
      !Number.isFinite(Date.parse(state.installedAt)) ||
      JSON.stringify(state.runtime) !== JSON.stringify(expectedRuntime)) {
    fail('detached state is not the exact preserved Modrinth revision');
  }
  assertRuntime(state.runtime, 'detached state');
  const manifestsPath = await assertCanonicalDirectory(path.join(stateRoot, 'manifests'), stateRoot, inspector);
  const manifest = await readCanonicalJson(
    path.join(manifestsPath, `${state.manifestId}.json`), manifestsPath, inspector, 'detached immutable manifest'
  );
  if (manifest.schemaVersion !== 1 || manifest.installationId !== state.manifestId || !Array.isArray(manifest.entries)) {
    fail('detached immutable manifest does not match the preserved state');
  }
  const current = {
    stateRoot,
    state,
    manifest,
    sentinelPath: path.join(serverPath, ...WORLD_SENTINEL_RELATIVE.split('/'))
  };
  await validateCompletedRestoredManifest(current, serverPath, inspector);
  const sentinelParent = await fsp.realpath(path.dirname(current.sentinelPath));
  await assertCanonicalFile(current.sentinelPath, sentinelParent, inspector, 'world sentinel', { maxBytes: 4096 });
  if (await fsp.readFile(current.sentinelPath, 'utf8') !== WORLD_SENTINEL_TEXT) fail('world sentinel changed');
  const managedEntry = manifest.entries.find(entry => entry?.origin === 'pack' &&
    entry.managementPolicy === 'replaceable-managed' && entry.role === 'mod');
  if (!managedEntry) fail('detached immutable manifest does not expose a managed mod');
  const managedPath = path.resolve(serverPath, ...safeRelativePath(managedEntry.path, 'detached managed mod').split('/'));
  const managedFilePaths = uninstallableManagedPaths(manifest, serverPath);
  if (!managedFilePaths.some(filePath => pathsEqual(filePath, managedPath))) {
    fail('detached managed mod is not bound to the immutable manifest');
  }
  return Object.freeze({
    stateRoot,
    state,
    manifest,
    managedEntry,
    managedPath,
    managedFilePaths: Object.freeze([...managedFilePaths]),
    sentinelPath: current.sentinelPath
  });
}

function operationJournalReader() {
  return new OperationJournal({
    durableFs: {
      readFileBounded(filePath, { allowMissing = false, maxBytes } = {}) {
        const bytes = fs.readFileSync(filePath);
        if (Number.isSafeInteger(maxBytes) && bytes.length > maxBytes) throw new Error('oversized journal');
        if (!allowMissing && bytes.length === 0) throw new Error('empty journal');
        return bytes;
      },
      async readFileBoundedAsync(filePath, { allowMissing = false, maxBytes } = {}) {
        const bytes = await fsp.readFile(filePath);
        if (Number.isSafeInteger(maxBytes) && bytes.length > maxBytes) throw new Error('oversized journal');
        if (!allowMissing && bytes.length === 0) throw new Error('empty journal');
        return bytes;
      },
      async writeJsonAtomicAsync() { throw new Error('read-only audit'); }
    },
    fsApi: fs,
    clock: () => new Date(0)
  });
}

async function readRestoreMetadata(backupsPath, restorePointId, inspector) {
  const names = (await fsp.readdir(backupsPath)).filter(name => name.endsWith('.json')).sort();
  const matches = [];
  for (const name of names) {
    const value = await readCanonicalJson(path.join(backupsPath, name), backupsPath, inspector, 'restore metadata');
    if (value.id === restorePointId) matches.push({ name, value });
  }
  if (matches.length !== 1) fail('restore metadata is missing or ambiguous');
  const { name: metadataName, value: metadata } = matches[0];
  if (metadata.schemaVersion !== 1 || metadata.kind !== 'minecraft-core-lifecycle-restore-point' ||
      typeof metadata.name !== 'string' || metadata.name !== metadataName.replace(/\.json$/u, '.zip') ||
      !SHA256_PATTERN.test(metadata.sha256) || !Number.isSafeInteger(metadata.size) || metadata.size < 1 ||
      metadata.scopeSha256 !== metadata.scope?.scopeSha256 || !Array.isArray(metadata.pins)) {
    fail('restore metadata is invalid');
  }
  validateScope(metadata.scope);
  const archivePath = path.join(backupsPath, metadata.name);
  const { stat } = await assertCanonicalFile(archivePath, backupsPath, inspector, 'restore archive', {
    maxBytes: Number.MAX_SAFE_INTEGER
  });
  if (stat.size !== metadata.size || sha256File(archivePath) !== metadata.sha256) fail('restore archive digest changed');
  return { archivePath, metadataPath: path.join(backupsPath, metadataName), metadata };
}

function readExactArchiveEntries(archivePath, metadata, requiredEntryNames) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (openError, archive) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = new Map();
      const required = new Set(requiredEntryNames);
      const captured = new Map();
      let settled = false;
      function finish(error, value) {
        if (settled) return;
        settled = true;
        archive.close();
        if (error) reject(error);
        else resolve(value);
      }
      archive.once('error', error => finish(error));
      archive.once('end', () => {
        try {
          const scopeEntries = metadata.scope.entries;
          if (entries.size !== scopeEntries.length || archive.entryCount !== scopeEntries.length) {
            throw new Error('archive entry count differs from verified restore scope');
          }
          for (const expected of scopeEntries) {
            const actual = entries.get(expected.path);
            if (!actual || actual.type !== expected.type || actual.size !== expected.size) {
              throw new Error('archive topology differs from verified restore scope');
            }
          }
          if (captured.size !== required.size) throw new Error('required archived lifecycle evidence is missing');
          finish(null, captured);
        } catch (error) {
          finish(error);
        }
      });
      archive.on('entry', entry => {
        try {
          const name = entry.fileName;
          const directory = name.endsWith('/');
          safeRelativePath(directory ? name.slice(0, -1) : name, 'restore archive');
          if (entry.generalPurposeBitFlag & 0x1 || entries.has(name) ||
              !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
            throw new Error('restore archive contains an encrypted, duplicate, or invalid entry');
          }
          entries.set(name, {
            type: directory ? 'directory' : 'file',
            size: entry.uncompressedSize
          });
          if (!required.has(name)) {
            archive.readEntry();
            return;
          }
          if (directory || entry.uncompressedSize > 32 * 1024 * 1024) {
            throw new Error('required archived lifecycle evidence is invalid or oversized');
          }
          archive.openReadStream(entry, (streamError, stream) => {
            if (streamError) {
              finish(streamError);
              return;
            }
            const chunks = [];
            let total = 0;
            stream.on('data', chunk => {
              total += chunk.length;
              if (total > 32 * 1024 * 1024) {
                stream.destroy(new Error('required archived lifecycle evidence is oversized'));
                return;
              }
              chunks.push(chunk);
            });
            stream.once('error', error => finish(error));
            stream.once('end', () => {
              captured.set(name, Buffer.concat(chunks));
              archive.readEntry();
            });
          });
        } catch (error) {
          finish(error);
        }
      });
      archive.readEntry();
    });
  });
}

async function readArchivedManagedSnapshot(restore, { expectedRevision, expectedRuntime }) {
  const stateEntryName = '.minecraft-core-state/modpack.json';
  const stateOnly = await readExactArchiveEntries(restore.archivePath, restore.metadata, [stateEntryName]);
  let state;
  try { state = JSON.parse(stateOnly.get(stateEntryName).toString('utf8')); }
  catch (error) { fail('detached restore archived state is invalid JSON', error); }
  if (!state || state.schemaVersion !== 1 || state.modpackManaged !== true ||
      state.source?.provider !== 'modrinth' ||
      state.source.projectId !== realHarness.REAL_MODRINTH_LIFECYCLE.projectId ||
      state.source.versionId !== realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id ||
      state.contentRevision !== expectedRevision || typeof state.manifestId !== 'string' ||
      JSON.stringify(state.runtime) !== JSON.stringify(expectedRuntime)) {
    fail('detached restore archive does not contain the exact managed revision 5 state');
  }
  const manifestEntryName = `.minecraft-core-state/manifests/${state.manifestId}.json`;
  const entries = await readExactArchiveEntries(
    restore.archivePath,
    restore.metadata,
    [stateEntryName, manifestEntryName]
  );
  let manifest;
  try { manifest = JSON.parse(entries.get(manifestEntryName).toString('utf8')); }
  catch (error) { fail('detached restore archived manifest is invalid JSON', error); }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.installationId !== state.manifestId ||
      !Array.isArray(manifest.entries) || manifest.entries.length !== 498 ||
      manifest.entries.some(entry => entry?.path === WORLD_SENTINEL_RELATIVE)) {
    fail('detached restore archive does not contain the exact immutable 498-entry manifest');
  }
  return Object.freeze({ state, manifest });
}

function validateScope(scope) {
  if (!scope || scope.schemaVersion !== 1 || !Array.isArray(scope.entries) ||
      !Number.isSafeInteger(scope.totalBytes) || scope.totalBytes < 0 ||
      !Number.isSafeInteger(scope.fileCount) || scope.fileCount < 0 || !SHA256_PATTERN.test(scope.scopeSha256) ||
      sha256Bytes(JSON.stringify(scope.entries)) !== scope.scopeSha256) fail('selected restore scope is invalid');
  const seen = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of scope.entries) {
    if (!entry || !['file', 'directory'].includes(entry.type) || typeof entry.path !== 'string' || seen.has(entry.path) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0) fail('selected restore scope entry is invalid');
    safeRelativePath(entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path, 'selected restore scope');
    if (entry.type === 'directory') {
      if (!entry.path.endsWith('/') || entry.size !== 0 || entry.sha256 !== null) fail('selected restore directory entry is invalid');
    } else {
      if (entry.path.endsWith('/') || !SHA256_PATTERN.test(entry.sha256)) fail('selected restore file entry is invalid');
      fileCount += 1;
      totalBytes += entry.size;
    }
    seen.add(entry.path);
  }
  if (fileCount !== scope.fileCount || totalBytes !== scope.totalBytes) fail('selected restore scope totals are invalid');
  return scope;
}

function enumeratePayloadTree(root, prefix = '') {
  const entries = [];
  function visit(directory, relativeParent) {
    const names = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, 'en-US'));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = relativeParent ? `${relativeParent}/${name}` : name;
      const archivePath = prefix ? `${prefix.replace(/\/$/u, '')}/${relative}` : relative;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || stat.nlink !== 1) fail('selected restore contains a linked object');
      if (stat.isDirectory()) {
        entries.push({ path: `${archivePath}/`, type: 'directory', size: 0, sha256: null });
        visit(absolute, relative);
      } else if (stat.isFile()) {
        entries.push({ path: archivePath, type: 'file', size: stat.size, sha256: sha256File(absolute) });
      } else {
        fail('selected restore contains an unsupported filesystem object');
      }
    }
  }
  visit(root, '');
  return entries;
}

function compareRestorePayload(candidatePath, selectedRestorePath, metadata) {
  const scope = validateScope(metadata.scope);
  const payloadNames = fs.readdirSync(candidatePath)
    .filter(name => name.toLocaleLowerCase('en-US') !== '.minecraft-core-state')
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  if (payloadNames.length < 1 || payloadNames.some(name => name.toLocaleLowerCase('en-US') === 'backups')) {
    fail('candidate does not contain the exact partial restored payload');
  }
  const actualEntries = [];
  for (const name of payloadNames) {
    const absolute = path.join(candidatePath, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      actualEntries.push({ path: `${name}/`, type: 'directory', size: 0, sha256: null });
      actualEntries.push(...enumeratePayloadTree(absolute, `${name}/`));
    } else if (stat.isFile()) {
      actualEntries.push({ path: name, type: 'file', size: stat.size, sha256: sha256File(absolute) });
    } else {
      fail('candidate payload contains an unsupported filesystem object');
    }
  }
  const movedFileCount = actualEntries.filter(entry => entry.type === 'file').length;
  actualEntries.push(...enumeratePayloadTree(selectedRestorePath));
  const actualByPath = new Map();
  for (const entry of actualEntries) {
    if (actualByPath.has(entry.path)) fail('candidate and selected restore payload overlap');
    actualByPath.set(entry.path, entry);
  }
  let mismatches = 0;
  for (const expected of scope.entries) {
    const actual = actualByPath.get(expected.path);
    if (!actual || actual.type !== expected.type || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      mismatches += 1;
    }
    actualByPath.delete(expected.path);
  }
  mismatches += actualByPath.size;
  if (mismatches !== 0) fail('partial candidate no longer reconstructs the selected verified restore scope');
  return {
    fileCount: scope.fileCount,
    totalBytes: scope.totalBytes,
    entryCount: scope.entries.length,
    scopeSha256: scope.scopeSha256,
    mismatches,
    movedFileCount,
    movedRestorePayloadNames: payloadNames
  };
}

async function readUpgradeCheckpoint(serverPath, current, inspector) {
  const historyPath = await assertCanonicalDirectory(path.join(current.stateRoot, 'history'), current.stateRoot, inspector);
  const historyNames = (await fsp.readdir(historyPath)).filter(name => name.endsWith('.json')).sort();
  const history = [];
  for (const name of historyNames) {
    history.push(await readCanonicalJson(path.join(historyPath, name), historyPath, inspector, 'lifecycle history'));
  }
  const matches = history.filter(item => item.kind === 'upgrade' && item.outcome === 'completed' &&
    item.targetRevision === current.state.contentRevision && typeof item.restorePointId === 'string');
  if (matches.length !== 1) fail('does not contain one exact completed upgrade checkpoint');
  const upgrade = matches[0];
  if (!JOB_ID_PATTERN.test(upgrade.operationId) || upgrade.sourceRevision !== 2 || upgrade.targetRevision !== 3 ||
      !SHA256_PATTERN.test(upgrade.restorePointSha256) || !/^(0|[1-9][0-9]*)$/u.test(upgrade.restorePointTotalBytes)) {
    fail('upgrade checkpoint is invalid');
  }
  assertRuntime(upgrade.sourceRuntime, 'upgrade source');
  assertRuntime(upgrade.targetRuntime, 'upgrade target');
  if (JSON.stringify(current.state.runtime) !== JSON.stringify(upgrade.targetRuntime)) {
    fail('live runtime differs from completed upgrade history');
  }
  return { history, historyPath, upgrade };
}

async function assertRootTopology(root, expectedNames, inspector) {
  const actual = (await fsp.readdir(root)).sort((left, right) => left.localeCompare(right, 'en-US'));
  const expected = [...expectedNames].sort((left, right) => left.localeCompare(right, 'en-US'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('root topology is not exact');
  await assertNotReparse(root, inspector);
}

async function assertNoRedirectedTree(root, inspector) {
  async function visit(candidate) {
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink()) fail('contains a redirected filesystem object');
    await assertNotReparse(candidate, inspector);
    if (!stat.isDirectory()) {
      if (!stat.isFile() || stat.nlink !== 1) fail('contains an unsupported or linked filesystem object');
      return;
    }
    for (const name of await fsp.readdir(candidate)) await visit(path.join(candidate, name));
  }
  await visit(root);
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : null;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function reserveDistinctPorts() {
  const first = await reserveLoopbackPort();
  let second = await reserveLoopbackPort();
  while (second === first) second = await reserveLoopbackPort();
  return [first, second];
}

function inspectorLease(supplied) {
  const inspector = supplied || new WindowsReparseInspector();
  if (!inspector || typeof inspector.isReparsePoint !== 'function') fail('reparse inspector is invalid');
  return {
    inspector,
    close() { if (!supplied && typeof inspector.close === 'function') inspector.close(); }
  };
}

function createGuardedManagementLifecycle({
  root,
  userDataPath,
  serverPath,
  clientPath,
  evidencePath,
  instanceId,
  serverPort,
  managementPort,
  recovery,
  checkpoint,
  activePath,
  rootDirectoryIdentity,
  inspector,
  continuationMode,
  requiresRecovery,
  rollbackCompleted = false,
  detachCompleted = false,
  managementCompleted = false,
  auditTerminalCompletion = null
}) {
  let completionAuthorization = null;
  let managedCompletionEvidence = typeof checkpoint.initialManagedModPath === 'string' &&
    Array.isArray(checkpoint.initialManagedFilePaths) && checkpoint.initialManagedFilePaths.length > 0
    ? Object.freeze({
        managedModPath: checkpoint.initialManagedModPath,
        managedFilePaths: Object.freeze([...checkpoint.initialManagedFilePaths])
      })
    : null;
  async function auditCompletedManagement(managedFilePath, { expectedContentRevision = null } = {}) {
    if (!managedCompletionEvidence || typeof managedFilePath !== 'string' ||
        !pathsEqual(managedFilePath, managedCompletionEvidence.managedModPath)) {
      fail('completion requires the exact audited rollback managed mod path');
    }
    const stateRoot = await assertCanonicalDirectory(path.join(serverPath, '.minecraft-core-state'), serverPath, inspector);
    const state = await readCanonicalJson(path.join(stateRoot, 'modpack.json'), stateRoot, inspector, 'completed inactive state');
    const completionRevisionFloor = Number.isSafeInteger(checkpoint.completionRevisionFloor)
      ? checkpoint.completionRevisionFloor
      : checkpoint.rollbackRevision;
    if (state.schemaVersion !== 1 || state.modpackManaged !== false || !['uninstalled', 'files-only'].includes(state.lifecycleMode) ||
        state.runtime !== null || state.manifestId !== null || state.source?.versionId !== checkpoint.initialVersionId ||
        !Number.isSafeInteger(state.contentRevision) || state.contentRevision <= completionRevisionFloor ||
        (expectedContentRevision !== null && state.contentRevision !== expectedContentRevision)) {
      fail('completion state is not a successful uninstall of the restored pack');
    }
    for (const managedPath of managedCompletionEvidence.managedFilePaths) {
      await assertAbsent(managedPath, 'uninstalled managed mod');
    }
    const sentinelParent = await fsp.realpath(path.dirname(checkpoint.worldSentinelPath));
    await assertCanonicalFile(checkpoint.worldSentinelPath, sentinelParent, inspector, 'world sentinel', { maxBytes: 4096 });
    if (await fsp.readFile(checkpoint.worldSentinelPath, 'utf8') !== WORLD_SENTINEL_TEXT) fail('world sentinel changed');
    const activeRemaining = await fsp.readdir(activePath);
    if (activeRemaining.length !== 0) fail('completion still has active recovery records');
    const historyNamesAfter = (await fsp.readdir(path.join(stateRoot, 'history'))).filter(name => name.endsWith('.json'));
    const historyAfter = historyNamesAfter.map(name => JSON.parse(fs.readFileSync(path.join(stateRoot, 'history', name), 'utf8')));
    for (const kind of ['detach', 'rollback', 'uninstall']) {
      if (!historyAfter.some(item => item.kind === kind && item.outcome === 'completed')) {
        fail(`completion history is missing ${kind}`);
      }
    }
    return state;
  }
  return Object.freeze({
    root,
    scratchLabel: 'modrinth-management',
    userDataPath,
    serverPath,
    clientPath,
    evidencePath,
    identityPath: path.join(root, 'real-lifecycle-identity.json'),
    instanceId,
    serverHost: '127.0.0.1',
    serverPort,
    managementPort,
    continuationMode,
    requiresRecovery,
    rollbackCompleted,
    detachCompleted,
    managementCompleted,
    recovery: Object.freeze({ ...recovery }),
    checkpoint,
    async auditRolledBackManagementLifecycle() {
      const restored = await readManagedState(serverPath, inspector, {
        expectedVersionId: checkpoint.initialVersionId,
        expectedRevision: checkpoint.rollbackRevision,
        expectedRuntime: checkpoint.initialRuntime,
        // Rollback intentionally restores the older immutable manifest verbatim. User files created after
        // that manifest remain protected by the restore payload even though they are not backfilled into it.
        requireSentinelManifestEntry: false
      });
      if (checkpoint.completedRollbackEvidence) {
        await validateCompletedRestoredManifest(restored, serverPath, inspector);
        const currentIdentity = await identifyServerDirectory(serverPath, { reparseInspector: inspector });
        if (!sameIdentity(currentIdentity, checkpoint.targetDirectoryIdentity)) {
          fail('completed rollback live server directory identity changed before continuation');
        }
      }
      const coordinator = await readCanonicalJson(
        path.join(serverPath, '.minecraft-core.json'), serverPath, inspector, 'rolled-back server content revision', {
          maxBytes: 1024 * 1024
        }
      );
      if (coordinator.contentRevision !== checkpoint.rollbackRevision) {
        fail('rolled-back server content coordinator revision is invalid');
      }
      if ((await fsp.readdir(activePath)).length !== 0) fail('rolled-back lifecycle still has active recovery records');
      const stateHistoryPath = await assertCanonicalDirectory(
        path.join(restored.stateRoot, 'history'), restored.stateRoot, inspector
      );
      const historyNames = (await fsp.readdir(stateHistoryPath)).filter(name => name.endsWith('.json'));
      const history = [];
      for (const name of historyNames) {
        history.push(await readCanonicalJson(path.join(stateHistoryPath, name), stateHistoryPath, inspector, 'rollback history'));
      }
      const expectedSourceRevision = Number.isSafeInteger(checkpoint.rollbackSourceRevision)
        ? checkpoint.rollbackSourceRevision
        : Number.isSafeInteger(checkpoint.coordinatorRevision)
        ? checkpoint.coordinatorRevision
        : checkpoint.sourceRevision;
      const rollbacks = history.filter(item => item.kind === 'rollback' && item.outcome === 'completed' &&
        item.sourceRevision === expectedSourceRevision && item.targetRevision === checkpoint.rollbackRevision &&
        JSON.stringify(item.sourceRuntime) === JSON.stringify(checkpoint.currentRuntime) &&
        JSON.stringify(item.targetRuntime) === JSON.stringify(checkpoint.initialRuntime) &&
        JOB_ID_PATTERN.test(item.operationId) && typeof item.restorePointId === 'string' &&
        SHA256_PATTERN.test(item.restorePointSha256));
      if (rollbacks.length !== 1) fail('fresh completed rollback history is missing or ambiguous');
      const rollbackPaths = createExistingSiblingPaths(serverPath, rollbacks[0].operationId);
      await Promise.all(['candidatePath', 'rollbackPath', 'failedPath'].map(key =>
        assertAbsent(rollbackPaths[key], `completed rollback ${key}`)));
      if (checkpoint.completedRollbackEvidence) {
        if (rollbacks[0].operationId !== checkpoint.completedRollbackEvidence.jobId) {
          fail('completed rollback history does not bind the adopted operation journal');
        }
        await readCompletedRollbackOperationWorkspace({
          serverPath,
          instanceId,
          inspector,
          evidence: checkpoint.completedRollbackEvidence
        });
      } else {
        await assertAbsent(
          path.join(serverPath, '.minecraft-core-state', 'operations', rollbacks[0].operationId),
          'completed rollback operation workspace'
        );
      }
      const managedFilePaths = uninstallableManagedPaths(restored.manifest, serverPath);
      const managedModPath = path.resolve(serverPath, ...restored.managedEntry.path.split('/'));
      if (!managedFilePaths.some(filePath => pathsEqual(filePath, managedModPath))) {
        fail('restored managed mod is not an uninstallable audited manifest entry');
      }
      managedCompletionEvidence = Object.freeze({
        managedModPath,
        managedFilePaths: Object.freeze([...managedFilePaths])
      });
      return Object.freeze({
        state: restored.state,
        managedModPath,
        managedFilePaths: Object.freeze([...managedFilePaths]),
        rollbackOperationId: rollbacks[0].operationId
      });
    },
    async auditDetachedManagementLifecycle() {
      if (!detachCompleted || !checkpoint.completedDetachEvidence || !checkpoint.failedDetachRestoreEvidence) {
        fail('detached audit requires the exact adopted post-detach checkpoint');
      }
      return auditPostDetachRestoreFailedCheckpoint({
        serverPath,
        userDataPath,
        instanceId,
        inspector,
        activePath,
        checkpoint
      });
    },
    async confirmCompletedManagement({ managedFilePath } = {}) {
      const state = await auditCompletedManagement(managedFilePath);
      completionAuthorization = Object.freeze({
        managedFilePath: managedCompletionEvidence.managedModPath,
        contentRevision: state.contentRevision
      });
      return Object.freeze({ authorized: true, contentRevision: state.contentRevision });
    },
    async auditCompletedManagementLifecycle() {
      if (!managementCompleted || typeof auditTerminalCompletion !== 'function') {
        fail('terminal management audit is not available for this checkpoint');
      }
      const result = await auditTerminalCompletion();
      completionAuthorization = Object.freeze({
        managedFilePath: result.managedModPath,
        contentRevision: result.state.contentRevision,
        terminal: true
      });
      return Object.freeze({ ...result, authorized: true });
    },
    async dispose({ preserveRoot = true } = {}) {
      if (preserveRoot) {
        console.error(`[real-modpack-e2e] preserving management continuation scratch root: ${root}`);
        return;
      }
      if (!completionAuthorization) fail('refuses deletion without confirmed successful management completion');
      const deletionRoot = assertScratchLocation(root);
      const deletionReal = await fsp.realpath(deletionRoot);
      if (!pathsEqual(deletionReal, root)) fail('refuses to remove a redirected continuation root');
      const deletionIdentity = await identifyServerDirectory(deletionRoot, { reparseInspector: inspector });
      if (!sameIdentity(deletionIdentity, rootDirectoryIdentity)) {
        fail('refuses deletion because the validated root directory identity changed');
      }
      const finalIdentity = await readCanonicalJson(
        path.join(root, 'real-lifecycle-identity.json'), root, inspector, 'identity file', { maxBytes: 4096 }
      );
      if (!matchesManagementIdentity(finalIdentity)) fail('refuses deletion after identity changed');
      if (completionAuthorization.terminal) await auditTerminalCompletion();
      else await auditCompletedManagement(completionAuthorization.managedFilePath, {
        expectedContentRevision: completionAuthorization.contentRevision
      });
      await assertNoRedirectedTree(root, inspector);
      await fsp.rm(deletionRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

function isExactFailedRollbackJob(job, {
  errorCode,
  percent,
  message,
  cleanupPending = false
}) {
  return Boolean(job && job.operationKind === 'rollback-restore-point' && job.phase === 'failed' &&
    job.swapStep === null && job.progress?.percent === percent && job.progress?.message === message &&
    job.progress?.currentItem === null && job.outcome?.status === 'failed' &&
    job.outcome?.message === 'The operation failed before the server changed' &&
    job.outcome?.errorCode === errorCode && job.outcome?.cleanupPending === cleanupPending);
}

async function validatePostRecoveryActiveLineage({
  lifecycleRoot,
  serverPath,
  recovery,
  publicJob,
  inspector
}) {
  const workspacesPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'workspaces'), lifecycleRoot, inspector);
  if ((await fsp.readdir(workspacesPath)).length !== 0) fail('post-recovery active workspaces must be empty');

  const operationsPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'operations'), lifecycleRoot, inspector);
  const operationNames = (await fsp.readdir(operationsPath)).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (operationNames.length < 3 || operationNames.some(name => !name.endsWith('.json') ||
      !JOB_ID_PATTERN.test(name.slice(0, -'.json'.length)))) {
    fail('post-recovery active public operation topology is invalid');
  }
  const jobs = [];
  for (const name of operationNames) {
    jobs.push(verifyPublicOperation(await readCanonicalJson(
      path.join(operationsPath, name), operationsPath, inspector, 'post-recovery active public operation', {
        maxBytes: 2 * 1024 * 1024
      }
    ), 'post-recovery active public operation'));
  }
  const rollbackJobs = jobs.filter(job => job.operationKind === 'rollback-restore-point');
  const commitFailures = rollbackJobs.filter(job => isExactFailedRollbackJob(job, {
    errorCode: 'COMMIT_FAILED',
    percent: 43,
    message: 'Restoring the selected verified server snapshot'
  }));
  const staleFailures = rollbackJobs.filter(job => isExactFailedRollbackJob(job, {
    errorCode: 'PLAN_STALE',
    percent: 5,
    message: 'Revalidating the reviewed plan'
  }));
  const currentMatches = commitFailures.filter(job => job.jobId === recovery.jobId);
  const historicalMatches = commitFailures.filter(job => job.jobId !== recovery.jobId);
  if (rollbackJobs.length !== 3 || commitFailures.length !== 2 || staleFailures.length !== 1 ||
      currentMatches.length !== 1 || historicalMatches.length !== 1) {
    fail('post-recovery active checkpoint does not contain the exact rollback operation lineage');
  }
  const currentJob = currentMatches[0];
  const historicalJob = historicalMatches[0];
  const staleJob = staleFailures[0];
  if (JSON.stringify(currentJob) !== JSON.stringify(publicJob) ||
      [currentJob, historicalJob, staleJob].some(job => job.serverId !== recovery.target.stableServerId) ||
      JSON.stringify(currentJob.outcome.actions?.map(action => action?.actionId)) !==
        JSON.stringify(['change-selection', 'open-details']) ||
      JSON.stringify(staleJob.outcome.actions?.map(action => action?.actionId)) !==
        JSON.stringify(['change-selection', 'open-details'])) {
    fail('post-recovery active public rollback evidence is not exact');
  }

  const historyPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'history'), lifecycleRoot, inspector);
  const historyNames = (await fsp.readdir(historyPath)).sort((left, right) => left.localeCompare(right, 'en-US'));
  const historyPairs = new Map();
  for (const name of historyNames) {
    const target = name.endsWith('.target.json');
    const suffix = target ? '.target.json' : '.json';
    if (!name.endsWith(suffix)) fail('post-recovery active durable recovery history topology is invalid');
    const jobId = name.slice(0, -suffix.length);
    if (!JOB_ID_PATTERN.test(jobId)) fail('post-recovery active durable recovery history topology is invalid');
    const pair = historyPairs.get(jobId) || new Set();
    pair.add(target ? 'target' : 'record');
    historyPairs.set(jobId, pair);
  }
  if (historyPairs.size === 0 || [...historyPairs.values()].some(pair =>
    pair.size !== 2 || !pair.has('record') || !pair.has('target')) ||
      !historyPairs.has(historicalJob.jobId) || historyPairs.has(staleJob.jobId) || historyPairs.has(currentJob.jobId)) {
    fail('post-recovery active durable recovery history topology is invalid');
  }
  const rawHistorical = await readCanonicalJson(
    path.join(historyPath, `${historicalJob.jobId}.json`), historyPath, inspector,
    'post-recovery active historical recovery record'
  );
  let historicalRecovery;
  try { historicalRecovery = normalizeRecord(rawHistorical); }
  catch (error) { fail('post-recovery active historical recovery record is invalid', error); }
  let historicalEnvelope;
  try {
    historicalEnvelope = verifyRecoveryTargetEnvelope(await readCanonicalJson(
      path.join(historyPath, `${historicalJob.jobId}.target.json`), historyPath, inspector,
      'post-recovery active historical recovery envelope'
    ));
  } catch (error) {
    fail('post-recovery active historical recovery envelope is invalid', error);
  }
  if (JSON.stringify(historicalEnvelope) !== JSON.stringify(createRecoveryTargetEnvelope(rawHistorical))) {
    fail('post-recovery active historical recovery envelope does not bind the recovered target');
  }
  if (historicalRecovery.jobId !== historicalJob.jobId || historicalRecovery.operationKind !== 'rollback' ||
      historicalRecovery.phase !== 'failed' || historicalRecovery.swapStep !== 'none' ||
      historicalRecovery.target.kind !== 'existing' ||
      historicalRecovery.target.stableServerId !== recovery.target.stableServerId ||
      !pathsEqual(historicalRecovery.target.path, serverPath) || historicalRecovery.restoreCreation !== null ||
      historicalRecovery.priorRuntime.running !== false || historicalRecovery.priorRuntime.autoRestart !== false ||
      !sameIdentity(historicalRecovery.directoryIdentities.target, historicalRecovery.directoryIdentities.rollback) ||
      !sameIdentity(historicalRecovery.directoryIdentities.target, recovery.directoryIdentities.target) ||
      !historicalRecovery.directoryIdentities.candidate || historicalRecovery.directoryIdentities.failed !== null ||
      historicalRecovery.outcome?.revision?.source !== 3 || historicalRecovery.outcome?.revision?.target !== 4 ||
      JSON.stringify(historicalRecovery.outcome?.runtime) !== JSON.stringify(recovery.outcome?.runtime) ||
      JSON.stringify(historicalRecovery.outcome?.runtimePolicy) !== JSON.stringify(recovery.outcome?.runtimePolicy) ||
      historicalRecovery.outcome?.candidateCleanup?.deletionAuthorized !== true ||
      historicalRecovery.outcome.candidateCleanup.slot !== 'candidate' ||
      historicalRecovery.outcome.candidateCleanup.action !== 'pre-swap-restored' ||
      historicalRecovery.outcome.candidateCleanup.ownershipMode !== 'recorded-identity' ||
      !sameIdentity(historicalRecovery.outcome.candidateCleanup.directoryIdentity,
        historicalRecovery.directoryIdentities.candidate) ||
      !SHA256_PATTERN.test(historicalRecovery.outcome.candidateCleanup.fingerprint) ||
      historicalRecovery.outcome?.recovery?.action !== 'pre-swap-restored' ||
      historicalRecovery.outcome.recovery.operationId !== historicalRecovery.jobId) {
    fail('post-recovery active historical record is not the exact terminal pre-swap restoration');
  }

  const historicalPaths = createExistingSiblingPaths(serverPath, historicalRecovery.jobId);
  for (const key of ['candidatePath', 'rollbackPath', 'failedPath']) {
    if (!pathsEqual(historicalRecovery[key], historicalPaths[key])) {
      fail(`post-recovery active historical recovery ${key} is not the exact operation sibling`);
    }
    await assertAbsent(historicalPaths[key], `post-recovery active historical recovery ${key}`);
  }
  const stalePaths = createExistingSiblingPaths(serverPath, staleJob.jobId);
  await Promise.all(['candidatePath', 'rollbackPath', 'failedPath'].map(key =>
    assertAbsent(stalePaths[key], `post-recovery active stale rollback ${key}`)));
  for (const jobId of [historicalRecovery.jobId, staleJob.jobId, recovery.jobId]) {
    await assertAbsent(
      path.join(serverPath, '.minecraft-core-state', 'operations', jobId),
      'post-recovery active live-server operation workspace'
    );
  }

  const timestamps = {
    historicalUpdated: Date.parse(historicalRecovery.updatedAt),
    staleCreated: Date.parse(staleJob.createdAt),
    staleTerminal: Date.parse(staleJob.terminalAt),
    currentPublicCreated: Date.parse(currentJob.createdAt),
    activeCreated: Date.parse(recovery.createdAt),
    activeUpdated: Date.parse(recovery.updatedAt),
    currentTerminal: Date.parse(currentJob.terminalAt)
  };
  if (Object.values(timestamps).some(value => !Number.isFinite(value)) ||
      timestamps.staleCreated <= timestamps.historicalUpdated || timestamps.staleTerminal <= timestamps.staleCreated ||
      timestamps.currentPublicCreated <= timestamps.staleTerminal || timestamps.activeCreated < timestamps.currentPublicCreated ||
      timestamps.activeUpdated <= timestamps.activeCreated || timestamps.currentTerminal <= timestamps.activeUpdated ||
      Date.parse(currentJob.updatedAt) !== timestamps.currentTerminal) {
    fail('post-recovery active rollback chronology is invalid');
  }

  const coordinator = await readCanonicalJson(
    path.join(serverPath, '.minecraft-core.json'), serverPath, inspector, 'post-recovery active server content revision', {
      maxBytes: 1024 * 1024
    }
  );
  if (coordinator.contentRevision !== 4 || coordinator.contentRevision !== recovery.outcome.revision.target - 1) {
    fail('post-recovery active coordinator revision is not the exact recovered checkpoint');
  }
  const backupsPath = await assertCanonicalDirectory(path.join(serverPath, 'backups'), serverPath, inspector);
  const historicalSafety = await readRestoreMetadata(backupsPath, historicalRecovery.restorePoint?.id, inspector);
  if (historicalSafety.metadata.sha256 !== historicalRecovery.restorePoint.sha256 ||
      historicalSafety.metadata.sourceRevision !== 3 ||
      JSON.stringify(historicalSafety.metadata.sourceRuntime) !== JSON.stringify(recovery.outcome.runtime.source) ||
      historicalSafety.metadata.operationId !== historicalRecovery.jobId ||
      !historicalSafety.metadata.pins.includes(historicalRecovery.jobId)) {
    fail('post-recovery active historical safety restore is invalid');
  }
  return Object.freeze({
    coordinatorRevision: coordinator.contentRevision,
    historicalRecoveryJobId: historicalRecovery.jobId,
    staleRollbackJobId: staleJob.jobId
  });
}

async function assertPostRecoveryActiveCandidateTopology(candidatePath, operationWorkspace, jobId, inspector) {
  await assertRootTopology(candidatePath, ['.fabric', '.minecraft-core-state'], inspector);
  const stateRoot = await assertCanonicalDirectory(path.join(candidatePath, '.minecraft-core-state'), candidatePath, inspector);
  await assertRootTopology(stateRoot, ['history', 'manifests', 'operations'], inspector);
  for (const emptyName of ['history', 'manifests']) {
    const emptyPath = await assertCanonicalDirectory(path.join(stateRoot, emptyName), stateRoot, inspector);
    if ((await fsp.readdir(emptyPath)).length !== 0) {
      fail(`post-recovery active candidate ${emptyName} must be empty`);
    }
  }
  const operationsRoot = await assertCanonicalDirectory(path.join(stateRoot, 'operations'), stateRoot, inspector);
  await assertRootTopology(operationsRoot, [jobId], inspector);
  await assertRootTopology(
    operationWorkspace,
    ['selected-restore', 'directory-marker.json', 'journal.json'],
    inspector
  );
  await assertCanonicalDirectory(path.join(candidatePath, '.fabric'), candidatePath, inspector);
}

async function readTerminalPreSwapRecovery({
  historyPath,
  publicJob,
  serverPath,
  inspector,
  expectedTargetRevision,
  expectedTargetIdentity = null,
  expectedRuntime = null
}) {
  const rawRecord = await readCanonicalJson(
    path.join(historyPath, `${publicJob.jobId}.json`),
    historyPath,
    inspector,
    'terminal retry recovery record'
  );
  let recovery;
  try { recovery = normalizeRecord(rawRecord); }
  catch (error) { fail('terminal retry recovery record is invalid', error); }
  let envelope;
  try {
    envelope = verifyRecoveryTargetEnvelope(await readCanonicalJson(
      path.join(historyPath, `${publicJob.jobId}.target.json`),
      historyPath,
      inspector,
      'terminal retry recovery envelope'
    ));
  } catch (error) {
    fail('terminal retry recovery envelope is invalid', error);
  }
  if (JSON.stringify(envelope) !== JSON.stringify(createRecoveryTargetEnvelope(rawRecord))) {
    fail('terminal retry recovery envelope does not bind the recovered target');
  }

  const expectedPaths = createExistingSiblingPaths(serverPath, recovery.jobId);
  const expectedJournalPath = path.join(
    expectedPaths.candidatePath,
    '.minecraft-core-state',
    'operations',
    recovery.jobId,
    'journal.json'
  );
  if (recovery.schemaVersion !== 2 || recovery.sequence !== 14 || recovery.jobId !== publicJob.jobId ||
      recovery.operationKind !== 'rollback' || recovery.phase !== 'failed' || recovery.swapStep !== 'none' ||
      recovery.target.kind !== 'existing' || recovery.target.stableServerId !== publicJob.serverId ||
      !pathsEqual(recovery.target.path, serverPath) || recovery.restoreCreation !== null ||
      !recovery.restorePoint || typeof recovery.restorePoint.id !== 'string' ||
      !SHA256_PATTERN.test(recovery.restorePoint.sha256) ||
      recovery.priorRuntime.running !== false || recovery.priorRuntime.autoRestart !== false ||
      !pathsEqual(recovery.journalPath, expectedJournalPath) ||
      !sameIdentity(recovery.directoryIdentities.target, recovery.directoryIdentities.rollback) ||
      !recovery.directoryIdentities.candidate || recovery.directoryIdentities.failed !== null ||
      recovery.outcome?.revision?.source !== 3 || recovery.outcome?.revision?.target !== expectedTargetRevision ||
      recovery.outcome?.runtime?.maxRam !== 4 || recovery.outcome?.runtime?.port !== 25565 ||
      recovery.outcome?.runtimePolicy?.targetRunning !== false ||
      recovery.outcome.runtimePolicy.targetAutoRestart !== false ||
      recovery.outcome.runtimePolicy.targetInactive !== false ||
      recovery.outcome?.target?.name !== 'server' || !SHA256_PATTERN.test(recovery.outcome?.live?.fingerprint) ||
      recovery.outcome?.candidateCleanup?.deletionAuthorized !== true ||
      recovery.outcome.candidateCleanup.slot !== 'candidate' ||
      recovery.outcome.candidateCleanup.action !== 'pre-swap-restored' ||
      recovery.outcome.candidateCleanup.ownershipMode !== 'recorded-identity' ||
      !sameIdentity(recovery.outcome.candidateCleanup.directoryIdentity, recovery.directoryIdentities.candidate) ||
      !SHA256_PATTERN.test(recovery.outcome.candidateCleanup.fingerprint) ||
      recovery.outcome?.recovery?.action !== 'pre-swap-restored' ||
      recovery.outcome.recovery.operationId !== recovery.jobId) {
    fail('terminal retry recovery is not the exact pre-swap restoration');
  }
  strictIdentity(recovery.directoryIdentities.target, 'terminal retry target');
  strictIdentity(recovery.directoryIdentities.candidate, 'terminal retry candidate');
  strictIdentity(recovery.directoryIdentities.rollback, 'terminal retry rollback');
  const sourceRuntime = assertRuntime(recovery.outcome.runtime.source, 'terminal retry source');
  const targetRuntime = assertRuntime(recovery.outcome.runtime.target, 'terminal retry target');
  if (expectedRuntime && JSON.stringify(recovery.outcome.runtime) !== JSON.stringify(expectedRuntime)) {
    fail('terminal retry runtime differs from the established rollback lineage');
  }
  if (expectedTargetIdentity && !sameIdentity(recovery.directoryIdentities.target, expectedTargetIdentity)) {
    fail('terminal retry target identity differs from the established rollback lineage');
  }
  for (const key of ['candidatePath', 'rollbackPath', 'failedPath']) {
    if (!pathsEqual(recovery[key], expectedPaths[key])) {
      fail(`terminal retry recovery ${key} is not the exact operation sibling`);
    }
    await assertAbsent(expectedPaths[key], `terminal retry recovery ${key}`);
  }
  await assertAbsent(
    path.join(serverPath, '.minecraft-core-state', 'operations', recovery.jobId),
    'terminal retry live-server operation workspace'
  );
  const createdAt = Date.parse(recovery.createdAt);
  const updatedAt = Date.parse(recovery.updatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || updatedAt <= createdAt ||
      createdAt < Date.parse(publicJob.createdAt)) {
    fail('terminal retry recovery chronology is invalid');
  }
  return Object.freeze({
    recovery,
    expectedPaths: Object.freeze({ ...expectedPaths }),
    createdAt,
    updatedAt,
    runtime: Object.freeze({ source: { ...sourceRuntime }, target: { ...targetRuntime } })
  });
}

async function readPostRecoveryTerminalLineage({
  serverPath,
  lifecycleRoot,
  inspector,
  rollbackJobs,
  completedRollbackJob = null,
  additionalRollbackHistoryJobIds = []
}) {
  if (!Array.isArray(additionalRollbackHistoryJobIds) ||
      additionalRollbackHistoryJobIds.some(jobId => !JOB_ID_PATTERN.test(jobId)) ||
      new Set(additionalRollbackHistoryJobIds).size !== additionalRollbackHistoryJobIds.length) {
    fail('terminal retry additional rollback history topology is invalid');
  }
  const failedRollbackJobs = completedRollbackJob === null
    ? rollbackJobs
    : rollbackJobs.filter(job => job.jobId !== completedRollbackJob.jobId);
  const settledCommitJobs = failedRollbackJobs.filter(job => isExactFailedRollbackJob(job, {
    errorCode: 'COMMIT_FAILED',
    percent: 43,
    message: 'Restoring the selected verified server snapshot'
  }));
  const pendingCommitJobs = failedRollbackJobs.filter(job => isExactFailedRollbackJob(job, {
    errorCode: 'COMMIT_FAILED',
    percent: 43,
    message: 'Restoring the selected verified server snapshot',
    cleanupPending: true
  }));
  const commitJobs = [...settledCommitJobs, ...pendingCommitJobs]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const staleJobs = failedRollbackJobs.filter(job => isExactFailedRollbackJob(job, {
    errorCode: 'PLAN_STALE',
    percent: 5,
    message: 'Revalidating the reviewed plan'
  }));
  if (failedRollbackJobs.length !== 4 || rollbackJobs.length !== 4 + Number(completedRollbackJob !== null) ||
      settledCommitJobs.length !== 2 || pendingCommitJobs.length !== 1 ||
      commitJobs.length !== 3 || staleJobs.length !== 1 || pendingCommitJobs[0].jobId !== commitJobs[2].jobId ||
      new Set(rollbackJobs.map(job => job.jobId)).size !== 4 + Number(completedRollbackJob !== null)) {
    fail('terminal retry checkpoint does not contain the exact rollback operation lineage');
  }
  const staleJob = staleJobs[0];
  const serverId = commitJobs[0].serverId;
  for (const job of [...commitJobs, staleJob]) {
    if (job.serverId !== serverId || JSON.stringify(job.outcome.actions?.map(action => action?.actionId)) !==
        JSON.stringify(['change-selection', 'open-details']) ||
        Date.parse(job.updatedAt) !== Date.parse(job.terminalAt) ||
        !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.terminalAt)) ||
        Date.parse(job.terminalAt) <= Date.parse(job.createdAt)) {
      fail('terminal retry public rollback evidence is not exact');
    }
  }

  const historyPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'history'), lifecycleRoot, inspector);
  const historyNames = (await fsp.readdir(historyPath)).sort((left, right) => left.localeCompare(right, 'en-US'));
  const historyPairs = new Map();
  for (const name of historyNames) {
    const target = name.endsWith('.target.json');
    const suffix = target ? '.target.json' : '.json';
    if (!name.endsWith(suffix)) fail('terminal retry durable recovery history topology is invalid');
    const jobId = name.slice(0, -suffix.length);
    if (!JOB_ID_PATTERN.test(jobId)) fail('terminal retry durable recovery history topology is invalid');
    const pair = historyPairs.get(jobId) || new Set();
    pair.add(target ? 'target' : 'record');
    historyPairs.set(jobId, pair);
  }
  if (historyPairs.size < 3 || [...historyPairs.values()].some(pair =>
    pair.size !== 2 || !pair.has('record') || !pair.has('target')) ||
      commitJobs.some(job => !historyPairs.has(job.jobId)) || historyPairs.has(staleJob.jobId)) {
    fail('terminal retry durable recovery history topology is invalid');
  }
  const rollbackHistoryJobIds = [];
  for (const jobId of historyPairs.keys()) {
    const raw = await readCanonicalJson(
      path.join(historyPath, `${jobId}.json`), historyPath, inspector, 'terminal retry durable recovery history record'
    );
    if (raw.operationKind === 'rollback') rollbackHistoryJobIds.push(jobId);
  }
  const expectedRollbackHistoryJobIds = [
    ...commitJobs.map(job => job.jobId),
    ...(completedRollbackJob ? [completedRollbackJob.jobId] : []),
    ...additionalRollbackHistoryJobIds
  ]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  rollbackHistoryJobIds.sort((left, right) => left.localeCompare(right, 'en-US'));
  if (JSON.stringify(rollbackHistoryJobIds) !== JSON.stringify(expectedRollbackHistoryJobIds)) {
    fail('rollback recovery history does not exactly match terminal operations');
  }

  const recoveries = [];
  for (let index = 0; index < commitJobs.length; index += 1) {
    recoveries.push(await readTerminalPreSwapRecovery({
      historyPath,
      publicJob: commitJobs[index],
      serverPath,
      inspector,
      expectedTargetRevision: index === 0 ? 4 : 5,
      expectedTargetIdentity: recoveries[0]?.recovery.directoryIdentities.target || null,
      expectedRuntime: recoveries[0]?.recovery.outcome.runtime || null
    }));
  }
  const stalePaths = createExistingSiblingPaths(serverPath, staleJob.jobId);
  await Promise.all(['candidatePath', 'rollbackPath', 'failedPath'].map(key =>
    assertAbsent(stalePaths[key], `terminal retry stale rollback ${key}`)));
  await assertAbsent(
    path.join(serverPath, '.minecraft-core-state', 'operations', staleJob.jobId),
    'terminal retry stale live-server operation workspace'
  );

  const [first, second, latest] = recoveries;
  const staleCreated = Date.parse(staleJob.createdAt);
  const staleTerminal = Date.parse(staleJob.terminalAt);
  if (first.updatedAt < Date.parse(commitJobs[0].terminalAt) ||
      staleCreated <= first.updatedAt || staleTerminal <= staleCreated ||
      Date.parse(commitJobs[1].createdAt) <= staleTerminal || second.updatedAt <= Date.parse(commitJobs[1].terminalAt) ||
      Date.parse(commitJobs[2].createdAt) <= second.updatedAt ||
      latest.updatedAt >= Math.max(Date.parse(commitJobs[2].terminalAt), Date.parse(commitJobs[2].updatedAt)) ||
      latest.createdAt <= Date.parse(commitJobs[2].createdAt)) {
    fail('terminal retry rollback chronology is invalid');
  }

  return Object.freeze({
    commitJobs: Object.freeze([...commitJobs]),
    staleJob,
    recoveries: Object.freeze([...recoveries]),
    historyPath
  });
}

async function loadPostRecoveryTerminalLineage({
  root,
  userDataPath,
  serverPath,
  clientPath,
  evidencePath,
  lifecycleRoot,
  activePath,
  rootDirectoryIdentity,
  inspector,
  rollbackJobs
}) {
  const { commitJobs, staleJob, recoveries } = await readPostRecoveryTerminalLineage({
    serverPath,
    lifecycleRoot,
    inspector,
    rollbackJobs
  });
  const latest = recoveries.at(-1);
  const serverId = commitJobs[0].serverId;

  const configPath = await assertCanonicalDirectory(path.join(userDataPath, 'config'), userDataPath, inspector);
  const config = await readCanonicalJson(
    path.join(configPath, 'minecraft-core-config.json'), configPath, inspector, 'terminal retry saved instance configuration'
  );
  if (!Array.isArray(config.instances) || config.instances.length !== 1 || config.instances[0]?.type !== 'server' ||
      config.instances[0].id !== serverId || !pathsEqual(config.instances[0].path, serverPath) ||
      typeof config.lastServerPath !== 'string' || !pathsEqual(config.lastServerPath, serverPath)) {
    fail('terminal retry saved instance does not bind the validated disposable server');
  }
  const coordinator = await readCanonicalJson(
    path.join(serverPath, '.minecraft-core.json'), serverPath, inspector, 'terminal retry server content revision', {
      maxBytes: 1024 * 1024
    }
  );
  if (coordinator.contentRevision !== 4) fail('terminal retry coordinator revision is not the exact recovered checkpoint');
  const current = await readManagedState(serverPath, inspector, {
    expectedVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[1].id,
    expectedRevision: 3,
    expectedRuntime: latest.runtime.source
  });
  if (coordinator.contentRevision !== current.state.contentRevision + 1) {
    fail('terminal retry managed state and coordinator revisions are not the exact preserved checkpoint');
  }
  const targetIdentity = await identifyServerDirectory(serverPath, { reparseInspector: inspector });
  if (!sameIdentity(targetIdentity, latest.recovery.directoryIdentities.target)) {
    fail('terminal retry live server directory identity changed');
  }
  const { history, upgrade } = await readUpgradeCheckpoint(serverPath, current, inspector);
  if (JSON.stringify(upgrade.sourceRuntime) !== JSON.stringify(latest.runtime.target)) {
    fail('terminal retry rollback target runtime differs from completed upgrade history');
  }
  const backupsPath = await assertCanonicalDirectory(path.join(serverPath, 'backups'), serverPath, inspector);
  const selectedRestore = await readRestoreMetadata(backupsPath, upgrade.restorePointId, inspector);
  if (selectedRestore.metadata.sha256 !== upgrade.restorePointSha256 ||
      selectedRestore.metadata.sourceRevision !== upgrade.sourceRevision ||
      JSON.stringify(selectedRestore.metadata.sourceRuntime) !== JSON.stringify(upgrade.sourceRuntime) ||
      selectedRestore.metadata.operationId !== upgrade.operationId ||
      !selectedRestore.metadata.pins.includes(upgrade.operationId) ||
      String(selectedRestore.metadata.scope.totalBytes) !== upgrade.restorePointTotalBytes) {
    fail('terminal retry selected restore metadata does not match completed upgrade history');
  }
  if (new Set(recoveries.map(item => item.recovery.restorePoint.id)).size !== recoveries.length ||
      recoveries.some(item => item.recovery.restorePoint.id === upgrade.restorePointId)) {
    fail('terminal retry safety restore lineage is ambiguous');
  }
  for (const item of recoveries) {
    const safety = await readRestoreMetadata(backupsPath, item.recovery.restorePoint.id, inspector);
    if (safety.metadata.sha256 !== item.recovery.restorePoint.sha256 ||
        safety.metadata.sourceRevision !== item.recovery.outcome.revision.target - 1 ||
        JSON.stringify(safety.metadata.sourceRuntime) !== JSON.stringify(current.state.runtime) ||
        safety.metadata.operationId !== item.recovery.jobId || !safety.metadata.pins.includes(item.recovery.jobId)) {
      fail('terminal retry safety restore does not match recovered durable history');
    }
  }
  const [serverPort, managementPort] = await reserveDistinctPorts();
  const checkpoint = Object.freeze({
    currentVersionId: current.state.source.versionId,
    initialVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id,
    sourceRevision: current.state.contentRevision,
    coordinatorRevision: coordinator.contentRevision,
    rollbackRevision: 5,
    currentRuntime: Object.freeze({ ...current.state.runtime }),
    initialRuntime: Object.freeze({ ...upgrade.sourceRuntime }),
    targetDirectoryIdentity: Object.freeze({ ...targetIdentity }),
    preRecoveryFingerprint: latest.recovery.outcome.live.fingerprint,
    upgradeRestorePointId: upgrade.restorePointId,
    upgradeRestorePointSha256: upgrade.restorePointSha256,
    safetyRestorePointId: latest.recovery.restorePoint.id,
    safetyRestorePointSha256: latest.recovery.restorePoint.sha256,
    worldSentinelPath: current.sentinelPath,
    worldSentinelText: WORLD_SENTINEL_TEXT,
    currentManagedModPath: current.managedPath,
    initialManagedModPath: null,
    initialManagedFilePaths: Object.freeze([]),
    restoreScope: Object.freeze({
      fileCount: selectedRestore.metadata.scope.fileCount,
      totalBytes: selectedRestore.metadata.scope.totalBytes,
      entryCount: selectedRestore.metadata.scope.entries.length,
      scopeSha256: selectedRestore.metadata.scope.scopeSha256,
      mismatches: 0
    }),
    movedRestorePayloadNames: Object.freeze([]),
    historyCount: history.length
  });
  return createGuardedManagementLifecycle({
    root,
    userDataPath,
    serverPath,
    clientPath,
    evidencePath,
    instanceId: serverId,
    serverPort,
    managementPort,
    recovery: {
      jobId: latest.recovery.jobId,
      phase: latest.recovery.phase,
      swapStep: latest.recovery.swapStep,
      candidatePath: latest.expectedPaths.candidatePath,
      rollbackPath: latest.expectedPaths.rollbackPath,
      failedPath: latest.expectedPaths.failedPath,
      failedRollbackJobId: staleJob.jobId,
      recoveredJobIds: Object.freeze(commitJobs.map(job => job.jobId))
    },
    checkpoint,
    activePath,
    rootDirectoryIdentity,
    inspector,
    continuationMode: 'post-recovery-terminal-lineage',
    requiresRecovery: false
  });
}

function isExactCompletedRollbackJob(job) {
  return Boolean(job && job.operationKind === 'rollback-restore-point' && job.phase === 'completed' &&
    job.swapStep === null && job.progress?.percent === 100 &&
    job.progress?.message === 'Modpack operation completed' && job.progress?.currentItem === null &&
    hasExactKeys(job.outcome, ['status', 'message', 'operationKind', 'actions']) &&
    job.outcome.status === 'completed' && job.outcome.message === 'The modpack operation completed successfully' &&
    job.outcome.operationKind === 'rollback-restore-point' && Array.isArray(job.outcome.actions) &&
    job.outcome.actions.length === 1 && job.outcome.actions[0]?.actionId === 'open-details' &&
    job.outcome.actions[0]?.opaqueRef === `oa:od:${job.jobId}` &&
    Date.parse(job.updatedAt) === Date.parse(job.terminalAt) &&
    Number.isFinite(Date.parse(job.createdAt)) && Date.parse(job.terminalAt) > Date.parse(job.createdAt));
}

async function readCompletedOperationWorkspace({
  serverPath,
  instanceId,
  inspector,
  evidence,
  operationKind,
  label,
  expectedWorkspaceJobIds = [evidence?.jobId]
}) {
  if (!evidence || !JOB_ID_PATTERN.test(evidence.jobId) || typeof operationKind !== 'string' ||
      typeof label !== 'string' || label.length === 0 || !Array.isArray(expectedWorkspaceJobIds) ||
      expectedWorkspaceJobIds.length === 0 || expectedWorkspaceJobIds.some(jobId => !JOB_ID_PATTERN.test(jobId)) ||
      new Set(expectedWorkspaceJobIds).size !== expectedWorkspaceJobIds.length) {
    fail(`${label || 'completed operation'} operation evidence is invalid`);
  }
  const stateRoot = await assertCanonicalDirectory(path.join(serverPath, '.minecraft-core-state'), serverPath, inspector);
  const operationsRoot = await assertCanonicalDirectory(path.join(stateRoot, 'operations'), stateRoot, inspector);
  const names = (await fsp.readdir(operationsRoot)).sort((left, right) => left.localeCompare(right, 'en-US'));
  const expectedNames = [...expectedWorkspaceJobIds].sort((left, right) => left.localeCompare(right, 'en-US'));
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    fail(`${label} operation workspace topology is not exact`);
  }
  const workspace = await assertCanonicalDirectory(path.join(operationsRoot, evidence.jobId), operationsRoot, inspector);
  const workspaceNames = (await fsp.readdir(workspace)).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (JSON.stringify(workspaceNames) !== JSON.stringify(['directory-marker.json', 'journal.json'])) {
    fail(`${label} operation workspace is not exact`);
  }
  const marker = verifyDirectoryMarker(await readCanonicalJson(
    path.join(workspace, 'directory-marker.json'), workspace, inspector, `${label} directory marker`
  ), { jobId: evidence.jobId, stableInstanceId: instanceId });
  if (marker.operationKind !== operationKind || marker.checksum !== evidence.markerSha256) {
    fail(`${label} directory marker does not match durable evidence`);
  }
  let journal;
  try { journal = operationJournalReader().load(path.join(workspace, 'journal.json')); }
  catch (error) { fail(`${label} operation journal is invalid`, error); }
  if (journal.jobId !== evidence.jobId || journal.operationKind !== operationKind || journal.stableInstanceId !== instanceId ||
      journal.phase !== 'completed' || journal.swapStep !== 'cleanup-complete' ||
      journal.targetPathHash !== evidence.targetPathHash || journal.markerSha256 !== evidence.markerSha256 ||
      !sameIdentity(journal.targetIdentity, evidence.targetIdentity) ||
      !sameIdentity(journal.candidateIdentity, evidence.candidateIdentity) ||
      !sameIdentity(journal.rollbackIdentity, evidence.rollbackIdentity) || journal.failedIdentity !== null ||
      journal.sourceFingerprint !== evidence.sourceFingerprint ||
      journal.candidateFingerprint !== evidence.candidateFingerprint ||
      journal.rollbackFingerprint !== evidence.rollbackFingerprint ||
      journal.revisionEventId !== evidence.revisionEventId || journal.revisionEventPublished !== true ||
      journal.targetAbsence !== null || journal.registration !== null) {
    fail(`${label} operation journal does not match durable evidence`);
  }
  return Object.freeze({ workspace, marker, journal });
}

async function readCompletedRollbackOperationWorkspace({
  serverPath,
  instanceId,
  inspector,
  evidence,
  expectedWorkspaceJobIds = evidence?.expectedWorkspaceJobIds
}) {
  return readCompletedOperationWorkspace({
    serverPath,
    instanceId,
    inspector,
    evidence,
    operationKind: 'rollback',
    label: 'completed rollback',
    expectedWorkspaceJobIds: expectedWorkspaceJobIds || [evidence?.jobId]
  });
}

async function validateCompletedRestoredManifest(current, serverPath, inspector) {
  // Group sizes of the restored manifest as the state repository reads it.
  const expectedGroups = new Map([
    ['pack|replaceable-managed|mod', 21],
    ['runtime|replaceable-managed|library', 354],
    ['runtime|replaceable-managed|server', 2],
    ['user|protected|world', 23]
  ]);
  // Runtime preparation also writes server.properties. Earlier builds recorded it as runtime content
  // (measured: 78 runtime and 20 user files); it is now the owner's file, and
  // repositoryManifestEntry() reads earlier manifests the same way. Only the two groups' total is
  // pinned until a fresh preserved run re-measures the split.
  const sharedGroups = ['runtime|replaceable-managed|runtime', 'user|protected|other'];
  const sharedGroupTotal = 98;
  if (current.manifest.entries.length !== 498 ||
      current.manifest.entries.some(entry => entry?.path === WORLD_SENTINEL_RELATIVE)) {
    fail('completed rollback immutable manifest is not the exact restored 498-entry snapshot');
  }
  const groups = new Map();
  const seenPaths = new Set();
  const seenKeys = new Set();
  for (const storedEntry of current.manifest.entries) {
    const relative = safeRelativePath(storedEntry?.path, 'completed rollback manifest');
    const entry = repositoryManifestEntry(storedEntry);
    const key = `${entry.origin}|${entry.managementPolicy}|${entry.role}`;
    if ((!expectedGroups.has(key) && !sharedGroups.includes(key)) ||
        typeof entry.pathKey !== 'string' || entry.pathKey.length === 0 ||
        seenPaths.has(relative.toLocaleLowerCase('en-US')) || seenKeys.has(entry.pathKey.toLocaleLowerCase('en-US')) ||
        !SHA256_PATTERN.test(entry.installedHash) || !/^(0|[1-9][0-9]*)$/u.test(entry.size)) {
      fail('completed rollback immutable manifest topology is invalid');
    }
    seenPaths.add(relative.toLocaleLowerCase('en-US'));
    seenKeys.add(entry.pathKey.toLocaleLowerCase('en-US'));
    groups.set(key, (groups.get(key) || 0) + 1);
    const filePath = path.resolve(serverPath, ...relative.split('/'));
    if (!comparablePath(filePath).startsWith(`${comparablePath(serverPath)}${path.sep}`)) {
      fail('completed rollback manifest entry resolves outside the server');
    }
    const parent = await fsp.realpath(path.dirname(filePath));
    const { stat } = await assertCanonicalFile(filePath, parent, inspector, 'completed rollback manifest file', {
      maxBytes: Number.MAX_SAFE_INTEGER
    });
    if (['pack', 'runtime'].includes(entry.origin) &&
        (String(stat.size) !== entry.size || sha256File(filePath) !== entry.installedHash)) {
      fail('completed rollback managed file does not match the restored immutable manifest');
    }
  }
  for (const [key, count] of expectedGroups) {
    if (groups.get(key) !== count) fail('completed rollback immutable manifest classifications are not exact');
  }
  if (sharedGroups.reduce((total, key) => total + (groups.get(key) || 0), 0) !== sharedGroupTotal) {
    fail('completed rollback immutable manifest classifications are not exact');
  }
}

async function readCompletedManagedHistory({ current, serverPath, inspector, completedJobId }) {
  const historyPath = await assertCanonicalDirectory(path.join(current.stateRoot, 'history'), current.stateRoot, inspector);
  const names = (await fsp.readdir(historyPath)).filter(name => name.endsWith('.json')).sort();
  if (names.length !== 4) fail('completed rollback managed history topology is not exact');
  const history = [];
  for (const name of names) {
    history.push(await readCanonicalJson(path.join(historyPath, name), historyPath, inspector, 'completed rollback history'));
  }
  const ordered = [...history].sort((left, right) => left.sequence - right.sequence);
  if (JSON.stringify(ordered.map(item => [item.sequence, item.kind, item.outcome, item.sourceRevision, item.targetRevision])) !==
      JSON.stringify([
        [1, 'install', 'completed', 0, 1],
        [2, 'repair', 'completed', 1, 2],
        [3, 'upgrade', 'completed', 2, 3],
        [4, 'rollback', 'completed', 4, 5]
      ]) || new Set(ordered.map(item => item.operationId)).size !== 4 ||
      ordered.some(item => !JOB_ID_PATTERN.test(item.operationId)) || ordered[3].operationId !== completedJobId) {
    fail('completed rollback managed history lineage is not exact');
  }
  const [install, repair, upgrade, rollback] = ordered;
  if (JSON.stringify(install.targetRuntime) !== JSON.stringify(rollback.targetRuntime) ||
      JSON.stringify(repair.sourceRuntime) !== JSON.stringify(rollback.targetRuntime) ||
      JSON.stringify(repair.targetRuntime) !== JSON.stringify(rollback.targetRuntime) ||
      JSON.stringify(upgrade.sourceRuntime) !== JSON.stringify(rollback.targetRuntime) ||
      JSON.stringify(upgrade.targetRuntime) !== JSON.stringify(rollback.sourceRuntime) ||
      JSON.stringify(current.state.runtime) !== JSON.stringify(rollback.targetRuntime) ||
      ![repair, upgrade, rollback].every(item => typeof item.restorePointId === 'string' &&
        SHA256_PATTERN.test(item.restorePointSha256) && /^(0|[1-9][0-9]*)$/u.test(item.restorePointTotalBytes))) {
    fail('completed rollback managed history runtime or restore lineage is invalid');
  }
  const times = ordered.map(item => Date.parse(item.timestamp));
  if (times.some(value => !Number.isFinite(value)) || times.some((value, index) => index > 0 && value <= times[index - 1])) {
    fail('completed rollback managed history chronology is invalid');
  }
  return Object.freeze({ history: Object.freeze(history), install, repair, upgrade, rollback });
}

async function readDetachedManagedHistory({
  current,
  inspector,
  completedRollbackJobId,
  completedDetachJobId
}) {
  const historyPath = await assertCanonicalDirectory(path.join(current.stateRoot, 'history'), current.stateRoot, inspector);
  const names = (await fsp.readdir(historyPath)).filter(name => name.endsWith('.json')).sort();
  if (names.length !== 5) fail('detached managed history topology is not exact');
  const history = [];
  for (const name of names) {
    history.push(await readCanonicalJson(path.join(historyPath, name), historyPath, inspector, 'detached managed history'));
  }
  const ordered = [...history].sort((left, right) => left.sequence - right.sequence);
  if (JSON.stringify(ordered.map(item => [item.sequence, item.kind, item.outcome, item.sourceRevision, item.targetRevision])) !==
      JSON.stringify([
        [1, 'install', 'completed', 0, 1],
        [2, 'repair', 'completed', 1, 2],
        [3, 'upgrade', 'completed', 2, 3],
        [4, 'rollback', 'completed', 4, 5],
        [5, 'detach', 'completed', 5, 7]
      ]) || new Set(ordered.map(item => item.operationId)).size !== 5 ||
      ordered.some(item => !JOB_ID_PATTERN.test(item.operationId)) ||
      ordered[3].operationId !== completedRollbackJobId || ordered[4].operationId !== completedDetachJobId) {
    fail('detached managed history lineage is not exact');
  }
  const [install, repair, upgrade, rollback, detach] = ordered;
  const restoreBearing = [repair, upgrade, rollback, detach];
  if (JSON.stringify(install.targetRuntime) !== JSON.stringify(current.state.runtime) ||
      JSON.stringify(repair.sourceRuntime) !== JSON.stringify(current.state.runtime) ||
      JSON.stringify(repair.targetRuntime) !== JSON.stringify(current.state.runtime) ||
      JSON.stringify(upgrade.sourceRuntime) !== JSON.stringify(current.state.runtime) ||
      JSON.stringify(upgrade.targetRuntime) === JSON.stringify(current.state.runtime) ||
      JSON.stringify(rollback.targetRuntime) !== JSON.stringify(current.state.runtime) ||
      JSON.stringify(detach.sourceRuntime) !== JSON.stringify(current.state.runtime) ||
      JSON.stringify(detach.targetRuntime) !== JSON.stringify(current.state.runtime) ||
      restoreBearing.some(item => typeof item.restorePointId !== 'string' ||
        !SHA256_PATTERN.test(item.restorePointSha256) || !/^(0|[1-9][0-9]*)$/u.test(item.restorePointTotalBytes))) {
    fail('detached managed history runtime or restore lineage is invalid');
  }
  const times = ordered.map(item => Date.parse(item.timestamp));
  if (times.some(value => !Number.isFinite(value)) || times.some((value, index) => index > 0 && value <= times[index - 1])) {
    fail('detached managed history chronology is invalid');
  }
  return Object.freeze({
    history: Object.freeze(history),
    install,
    repair,
    upgrade,
    rollback,
    detach
  });
}

async function loadPostRollbackCompleted({
  root,
  userDataPath,
  serverPath,
  clientPath,
  evidencePath,
  lifecycleRoot,
  activePath,
  rootDirectoryIdentity,
  inspector,
  rollbackJobs,
  completedRollbackJob
}) {
  if (!isExactCompletedRollbackJob(completedRollbackJob)) {
    fail('completed rollback public operation is not exact');
  }
  const { commitJobs, staleJob, recoveries, historyPath } = await readPostRecoveryTerminalLineage({
    serverPath,
    lifecycleRoot,
    inspector,
    rollbackJobs,
    completedRollbackJob
  });
  const latest = recoveries.at(-1);
  if (completedRollbackJob.serverId !== commitJobs[0].serverId ||
      Date.parse(completedRollbackJob.createdAt) <= latest.updatedAt) {
    fail('completed rollback public operation does not follow the exact recovered lineage');
  }

  const raw = await readCanonicalJson(
    path.join(historyPath, `${completedRollbackJob.jobId}.json`), historyPath, inspector,
    'completed rollback durable recovery record'
  );
  let completed;
  try { completed = normalizeRecord(raw); }
  catch (error) { fail('completed rollback durable recovery record is invalid', error); }
  let envelope;
  try {
    envelope = verifyRecoveryTargetEnvelope(await readCanonicalJson(
      path.join(historyPath, `${completedRollbackJob.jobId}.target.json`), historyPath, inspector,
      'completed rollback durable recovery envelope'
    ));
  } catch (error) {
    fail('completed rollback durable recovery envelope is invalid', error);
  }
  if (JSON.stringify(envelope) !== JSON.stringify(createRecoveryTargetEnvelope(raw)) ||
      completed.jobId !== completedRollbackJob.jobId || completed.operationKind !== 'rollback' ||
      completed.target.kind !== 'existing' || completed.target.stableServerId !== completedRollbackJob.serverId ||
      !pathsEqual(completed.target.path, serverPath) || completed.restoreCreation !== null ||
      completed.priorRuntime.running !== false || completed.priorRuntime.autoRestart !== false ||
      completed.phase !== 'completed' || completed.swapStep !== 'cleanup-complete' ||
      completed.directoryIdentities.failed !== null ||
      !sameIdentity(completed.directoryIdentities.target, completed.directoryIdentities.candidate) ||
      sameIdentity(completed.directoryIdentities.target, completed.directoryIdentities.rollback)) {
    fail('completed rollback durable recovery record is not the exact successful checkpoint');
  }
  for (const [key, label] of [
    ['target', 'completed rollback target'], ['candidate', 'completed rollback candidate'], ['rollback', 'completed rollback rollback']
  ]) strictIdentity(completed.directoryIdentities[key], label);
  const expectedPaths = createExistingSiblingPaths(serverPath, completed.jobId);
  for (const key of ['candidatePath', 'rollbackPath', 'failedPath']) {
    if (!pathsEqual(completed[key], expectedPaths[key])) fail(`completed rollback ${key} is not the exact operation sibling`);
    await assertAbsent(expectedPaths[key], `completed rollback ${key}`);
  }
  const sourceRuntime = assertRuntime(completed.outcome?.runtime?.source, 'completed rollback source');
  const targetRuntime = assertRuntime(completed.outcome?.runtime?.target, 'completed rollback target');
  const runtimePolicy = completed.outcome?.runtimePolicy;
  const health = completed.outcome?.health;
  const release = completed.outcome?.releaseTracking;
  const releaseRecord = release?.record;
  if (!hasExactKeys(completed.outcome, [
        'live', 'runtime', 'runtimePolicy', 'target', 'revision', 'candidate', 'copy', 'rollback', 'swap',
        'liveValidation', 'health', 'revisionEvent', 'releaseTracking', 'cleanup'
      ]) || !hasExactKeys(completed.outcome.runtime, ['maxRam', 'port', 'source', 'target']) ||
      !hasExactKeys(runtimePolicy, [
        'targetRunning', 'targetAutoRestart', 'targetInactive', 'handoffEventId', 'runningRestored'
      ]) || !hasExactKeys(completed.outcome.candidate, ['fingerprint', 'markerSha256', 'properties']) ||
      !hasExactKeys(completed.outcome.candidate.properties, ['existed', 'sha256']) ||
      !hasExactKeys(health, [
        'elapsedMs', 'endpoint', 'handedOff', 'kind', 'listenerOwned', 'live', 'motdNonce', 'operationId',
        'pid', 'pongMatched', 'properties', 'readyMarker', 'shutdown'
      ]) || !hasExactKeys(release, ['schemaVersion', 'action', 'status', 'serverId', 'trackingId', 'record']) ||
      !hasExactKeys(releaseRecord, [
        'trackingId', 'serverId', 'provider', 'projectId', 'repositoryId', 'githubOwner', 'githubRepo',
        'includePrereleases', 'acceptedMapping', 'assetPattern', 'etag', 'lastSuccessfulCheck', 'lastFailure',
        'nextDueAt', 'lastSnapshot'
      ]) || !hasExactKeys(releaseRecord?.lastSnapshot, [
        'releaseId', 'version', 'prerelease', 'publishedAt', 'assetFingerprint', 'installable'
      ]) || completed.outcome?.runtime?.maxRam !== 4 || completed.outcome.runtime.port !== 25565 ||
      completed.outcome?.revision?.source !== 3 || completed.outcome.revision.target !== 5 ||
      runtimePolicy?.targetRunning !== false || runtimePolicy.targetAutoRestart !== false ||
      runtimePolicy.targetInactive !== false || runtimePolicy.handoffEventId !== null ||
      runtimePolicy.runningRestored !== false || completed.outcome?.target?.name !== 'server' ||
      !SHA256_PATTERN.test(completed.outcome?.live?.fingerprint) ||
      !SHA256_PATTERN.test(completed.outcome?.candidate?.fingerprint) ||
      completed.outcome.candidate.markerSha256 === undefined ||
      completed.outcome.candidate.properties?.existed !== false || completed.outcome.candidate.properties.sha256 !== null ||
      completed.outcome?.copy?.bytes !== '0' || completed.outcome.copy.files !== '0' ||
      completed.outcome?.rollback?.fingerprint !== completed.outcome.live.fingerprint ||
      completed.outcome?.swap?.step !== 'candidate-published' ||
      completed.outcome?.liveValidation?.properties?.existed !== false ||
      completed.outcome.liveValidation.properties.sha256 !== null ||
      completed.outcome?.cleanup?.deletionAuthorized !== true || completed.outcome.cleanup.rollbackRemoved !== true ||
      !health || !Number.isSafeInteger(health.elapsedMs) || health.elapsedMs < 0 ||
      health.endpoint?.host !== '127.0.0.1' || !Number.isSafeInteger(health.endpoint.port) || health.endpoint.port < 1 ||
      health.handedOff !== false || health.kind !== 'live' || health.listenerOwned !== true || health.live !== true ||
      typeof health.motdNonce !== 'string' || !health.motdNonce.startsWith('minecraft-core-health:') ||
      typeof health.operationId !== 'string' || !health.operationId.startsWith('health-') ||
      !Number.isSafeInteger(health.pid) || health.pid < 1 || health.pongMatched !== true ||
      health.properties?.existed !== false || health.properties.sha256 !== null || health.readyMarker !== 'Done (' ||
      JSON.stringify(health.shutdown) !== JSON.stringify({
        clean: true, closed: true, exitCode: 0, forced: false, signal: null
      }) || completed.outcome?.revisionEvent?.eventId !==
        `modpack-content-revision:${completed.jobId}:5` || completed.outcome.revisionEvent.published !== true ||
      release?.schemaVersion !== 1 || release.action !== 'upsert' || release.status !== 'applied' ||
      release.serverId !== completed.target.stableServerId || release.trackingId !== `tracking-${completed.target.stableServerId}` ||
      releaseRecord?.trackingId !== release.trackingId || releaseRecord.serverId !== completed.target.stableServerId ||
      releaseRecord.provider !== 'modrinth' || releaseRecord.projectId !== realHarness.REAL_MODRINTH_LIFECYCLE.projectId ||
      releaseRecord.repositoryId !== null || releaseRecord.githubOwner !== null || releaseRecord.githubRepo !== null ||
      releaseRecord.includePrereleases !== false || releaseRecord.acceptedMapping !== null ||
      releaseRecord.assetPattern !== null || releaseRecord.etag !== null || releaseRecord.lastSuccessfulCheck !== null ||
      releaseRecord.lastFailure !== null || releaseRecord.lastSnapshot?.releaseId !==
        realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id || releaseRecord.lastSnapshot.prerelease !== false ||
      releaseRecord.lastSnapshot.assetFingerprint !== null || releaseRecord.lastSnapshot.installable !== true ||
      Date.parse(releaseRecord.nextDueAt) !== Date.parse(releaseRecord.lastSnapshot.publishedAt)) {
    fail('completed rollback durable outcome is not the exact successful lifecycle result');
  }
  const createdAt = Date.parse(completed.createdAt);
  const updatedAt = Date.parse(completed.updatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) ||
      createdAt <= latest.updatedAt || updatedAt <= createdAt ||
      createdAt < Date.parse(completedRollbackJob.createdAt) ||
      updatedAt >= Date.parse(completedRollbackJob.terminalAt)) {
    fail('completed rollback chronology is invalid');
  }
  const targetIdentity = await identifyServerDirectory(serverPath, { reparseInspector: inspector });
  if (!sameIdentity(targetIdentity, completed.directoryIdentities.target)) {
    fail('completed rollback live server directory identity changed');
  }
  const completedEvidence = Object.freeze({
    jobId: completed.jobId,
    targetPathHash: envelope.targetPathHash,
    markerSha256: completed.outcome.candidate.markerSha256,
    targetIdentity: Object.freeze({ ...completed.directoryIdentities.target }),
    candidateIdentity: Object.freeze({ ...completed.directoryIdentities.candidate }),
    rollbackIdentity: Object.freeze({ ...completed.directoryIdentities.rollback }),
    sourceFingerprint: completed.outcome.live.fingerprint,
    candidateFingerprint: completed.outcome.candidate.fingerprint,
    rollbackFingerprint: completed.outcome.rollback.fingerprint,
    revisionEventId: completed.outcome.revisionEvent.eventId
  });
  const operation = await readCompletedRollbackOperationWorkspace({
    serverPath,
    instanceId: completed.target.stableServerId,
    inspector,
    evidence: completedEvidence
  });
  if (!pathsEqual(completed.journalPath, path.join(operation.workspace, 'journal.json')) ||
      completed.outcome.candidate.markerSha256 !== operation.marker.checksum) {
    fail('completed rollback journal path does not bind the live operation workspace');
  }

  const configPath = await assertCanonicalDirectory(path.join(userDataPath, 'config'), userDataPath, inspector);
  const config = await readCanonicalJson(
    path.join(configPath, 'minecraft-core-config.json'), configPath, inspector, 'completed rollback saved instance configuration'
  );
  if (!Array.isArray(config.instances) || config.instances.length !== 1 || config.instances[0]?.type !== 'server' ||
      config.instances[0].id !== completed.target.stableServerId || !pathsEqual(config.instances[0].path, serverPath) ||
      typeof config.lastServerPath !== 'string' || !pathsEqual(config.lastServerPath, serverPath)) {
    fail('completed rollback saved instance does not bind the validated disposable server');
  }
  const coordinator = await readCanonicalJson(
    path.join(serverPath, '.minecraft-core.json'), serverPath, inspector, 'completed rollback server content revision', {
      maxBytes: 1024 * 1024
    }
  );
  if (coordinator.contentRevision !== 5) fail('completed rollback coordinator revision is not exactly 5');
  const current = await readManagedState(serverPath, inspector, {
    expectedVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id,
    expectedRevision: 5,
    expectedRuntime: targetRuntime,
    requireSentinelManifestEntry: false
  });
  await validateCompletedRestoredManifest(current, serverPath, inspector);
  const managedHistory = await readCompletedManagedHistory({
    current,
    serverPath,
    inspector,
    completedJobId: completed.jobId
  });
  if (managedHistory.rollback.sourceRevision !== 4 || managedHistory.rollback.targetRevision !== 5 ||
      managedHistory.rollback.restorePointId !== completed.restorePoint?.id ||
      managedHistory.rollback.restorePointSha256 !== completed.restorePoint?.sha256 ||
      JSON.stringify(managedHistory.rollback.sourceRuntime) !== JSON.stringify(sourceRuntime) ||
      JSON.stringify(managedHistory.rollback.targetRuntime) !== JSON.stringify(targetRuntime)) {
    fail('completed rollback managed history does not bind the durable successful recovery');
  }

  const backupsPath = await assertCanonicalDirectory(path.join(serverPath, 'backups'), serverPath, inspector);
  const selected = await readRestoreMetadata(backupsPath, managedHistory.upgrade.restorePointId, inspector);
  const repair = await readRestoreMetadata(backupsPath, managedHistory.repair.restorePointId, inspector);
  const completedSafety = await readRestoreMetadata(backupsPath, completed.restorePoint?.id, inspector);
  if (selected.metadata.sha256 !== managedHistory.upgrade.restorePointSha256 ||
      selected.metadata.sourceRevision !== 2 || selected.metadata.operationId !== managedHistory.upgrade.operationId ||
      JSON.stringify(selected.metadata.sourceRuntime) !== JSON.stringify(targetRuntime) ||
      !selected.metadata.pins.includes(managedHistory.upgrade.operationId) ||
      String(selected.metadata.scope.totalBytes) !== managedHistory.upgrade.restorePointTotalBytes ||
      repair.metadata.sha256 !== managedHistory.repair.restorePointSha256 || repair.metadata.sourceRevision !== 1 ||
      repair.metadata.operationId !== managedHistory.repair.operationId ||
      JSON.stringify(repair.metadata.sourceRuntime) !== JSON.stringify(targetRuntime) ||
      !repair.metadata.pins.includes(managedHistory.repair.operationId) ||
      String(repair.metadata.scope.totalBytes) !== managedHistory.repair.restorePointTotalBytes ||
      completedSafety.metadata.sha256 !== completed.restorePoint.sha256 ||
      completedSafety.metadata.sourceRevision !== 4 || completedSafety.metadata.operationId !== completed.jobId ||
      JSON.stringify(completedSafety.metadata.sourceRuntime) !== JSON.stringify(sourceRuntime) ||
      !completedSafety.metadata.pins.includes(completed.jobId) ||
      String(completedSafety.metadata.scope.totalBytes) !== managedHistory.rollback.restorePointTotalBytes) {
    fail('completed rollback selected, repair, or safety restore evidence is invalid');
  }
  const recoverySafeties = [];
  for (const item of recoveries) {
    const safety = await readRestoreMetadata(backupsPath, item.recovery.restorePoint.id, inspector);
    if (safety.metadata.sha256 !== item.recovery.restorePoint.sha256 ||
        safety.metadata.sourceRevision !== item.recovery.outcome.revision.target - 1 ||
        JSON.stringify(safety.metadata.sourceRuntime) !== JSON.stringify(sourceRuntime) ||
        safety.metadata.operationId !== item.recovery.jobId || !safety.metadata.pins.includes(item.recovery.jobId)) {
      fail('completed rollback prior safety restore lineage is invalid');
    }
    recoverySafeties.push(safety);
  }
  const allRestores = [selected, repair, ...recoverySafeties, completedSafety];
  if (new Set(allRestores.map(item => item.metadata.id)).size !== 6) {
    fail('completed rollback restore lineage is ambiguous');
  }
  const expectedBackupNames = allRestores.flatMap(item => [
    path.basename(item.archivePath), path.basename(item.metadataPath)
  ]).sort((left, right) => left.localeCompare(right, 'en-US'));
  const actualBackupNames = (await fsp.readdir(backupsPath)).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (JSON.stringify(actualBackupNames) !== JSON.stringify(expectedBackupNames)) {
    fail('completed rollback backup topology is not exact');
  }

  const managedFilePaths = uninstallableManagedPaths(current.manifest, serverPath);
  const initialManagedModPath = path.resolve(serverPath, ...current.managedEntry.path.split('/'));
  const [serverPort, managementPort] = await reserveDistinctPorts();
  const checkpoint = Object.freeze({
    currentVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[1].id,
    initialVersionId: current.state.source.versionId,
    sourceRevision: 3,
    rollbackSourceRevision: managedHistory.rollback.sourceRevision,
    coordinatorRevision: coordinator.contentRevision,
    rollbackRevision: current.state.contentRevision,
    currentRuntime: Object.freeze({ ...sourceRuntime }),
    initialRuntime: Object.freeze({ ...targetRuntime }),
    targetDirectoryIdentity: Object.freeze({ ...targetIdentity }),
    preRecoveryFingerprint: latest.recovery.outcome.live.fingerprint,
    upgradeRestorePointId: managedHistory.upgrade.restorePointId,
    upgradeRestorePointSha256: managedHistory.upgrade.restorePointSha256,
    safetyRestorePointId: completed.restorePoint.id,
    safetyRestorePointSha256: completed.restorePoint.sha256,
    worldSentinelPath: current.sentinelPath,
    worldSentinelText: WORLD_SENTINEL_TEXT,
    currentManagedModPath: null,
    initialManagedModPath,
    initialManagedFilePaths: Object.freeze([...managedFilePaths]),
    restoreScope: Object.freeze({
      fileCount: selected.metadata.scope.fileCount,
      totalBytes: selected.metadata.scope.totalBytes,
      entryCount: selected.metadata.scope.entries.length,
      scopeSha256: selected.metadata.scope.scopeSha256,
      mismatches: 0
    }),
    movedRestorePayloadNames: Object.freeze([]),
    historyCount: managedHistory.history.length,
    completedRollbackEvidence: completedEvidence
  });
  return createGuardedManagementLifecycle({
    root,
    userDataPath,
    serverPath,
    clientPath,
    evidencePath,
    instanceId: completed.target.stableServerId,
    serverPort,
    managementPort,
    recovery: {
      jobId: completed.jobId,
      phase: completed.phase,
      swapStep: completed.swapStep,
      candidatePath: expectedPaths.candidatePath,
      rollbackPath: expectedPaths.rollbackPath,
      failedPath: expectedPaths.failedPath,
      failedRollbackJobId: staleJob.jobId,
      recoveredJobIds: Object.freeze(commitJobs.map(job => job.jobId))
    },
    checkpoint,
    activePath,
    rootDirectoryIdentity,
    inspector,
    continuationMode: 'post-rollback-completed',
    requiresRecovery: false,
    rollbackCompleted: true
  });
}

function isExactCompletedManagementJob(job, operationKind) {
  return Boolean(job && job.operationKind === operationKind && job.phase === 'completed' &&
    job.swapStep === null && job.progress?.percent === 100 &&
    job.progress?.message === 'Modpack operation completed' && job.progress?.currentItem === null &&
    hasExactKeys(job.outcome, ['status', 'message', 'operationKind', 'actions']) &&
    job.outcome.status === 'completed' && job.outcome.message === 'The modpack operation completed successfully' &&
    job.outcome.operationKind === operationKind && Array.isArray(job.outcome.actions) &&
    job.outcome.actions.length === 1 && job.outcome.actions[0]?.actionId === 'open-details' &&
    job.outcome.actions[0]?.opaqueRef === `oa:od:${job.jobId}` &&
    Date.parse(job.updatedAt) === Date.parse(job.terminalAt) &&
    Number.isFinite(Date.parse(job.createdAt)) && Date.parse(job.terminalAt) > Date.parse(job.createdAt));
}

async function readPairedLifecycleRecord(historyPath, publicJob, inspector, label) {
  const recordPath = path.join(historyPath, `${publicJob.jobId}.json`);
  const envelopePath = path.join(historyPath, `${publicJob.jobId}.target.json`);
  const raw = await readCanonicalJson(recordPath, historyPath, inspector, `${label} durable record`);
  let record;
  try { record = normalizeRecord(raw); }
  catch (error) { fail(`${label} durable record is invalid`, error); }
  let envelope;
  try {
    envelope = verifyRecoveryTargetEnvelope(await readCanonicalJson(
      envelopePath, historyPath, inspector, `${label} durable envelope`
    ));
  } catch (error) {
    fail(`${label} durable envelope is invalid`, error);
  }
  if (JSON.stringify(envelope) !== JSON.stringify(createRecoveryTargetEnvelope(raw)) || record.jobId !== publicJob.jobId) {
    fail(`${label} durable envelope does not bind the exact operation`);
  }
  return Object.freeze({ raw, record, envelope, recordPath, envelopePath });
}

function completedOperationEvidence(record, envelope) {
  return Object.freeze({
    jobId: record.jobId,
    targetPathHash: envelope.targetPathHash,
    markerSha256: record.outcome.candidate.markerSha256,
    targetIdentity: Object.freeze({ ...record.directoryIdentities.target }),
    candidateIdentity: Object.freeze({ ...record.directoryIdentities.candidate }),
    rollbackIdentity: Object.freeze({ ...record.directoryIdentities.rollback }),
    sourceFingerprint: record.outcome.live.fingerprint,
    candidateFingerprint: record.outcome.candidate.fingerprint,
    rollbackFingerprint: record.outcome.rollback.fingerprint,
    revisionEventId: record.outcome.revisionEvent.eventId
  });
}

function validateCompletedOperationOutcome(record, {
  operationKind,
  sourceRevision,
  targetRevision,
  sourceRuntime,
  targetRuntime,
  propertiesExisted,
  copyBytes,
  copyFiles
}) {
  const outcome = record.outcome;
  const runtimePolicy = outcome?.runtimePolicy;
  const health = outcome?.health;
  if (!hasExactKeys(outcome, [
        'live', 'runtime', 'runtimePolicy', 'target', 'revision', 'candidate', 'copy', 'rollback', 'swap',
        'liveValidation', 'health', 'revisionEvent', 'releaseTracking', 'cleanup'
      ]) || !hasExactKeys(outcome.runtime, ['maxRam', 'port', 'source', 'target']) ||
      !hasExactKeys(runtimePolicy, [
        'targetRunning', 'targetAutoRestart', 'targetInactive', 'handoffEventId', 'runningRestored'
      ]) || !hasExactKeys(outcome.candidate, ['fingerprint', 'markerSha256', 'properties']) ||
      !hasExactKeys(outcome.candidate.properties, ['existed', 'sha256']) ||
      !hasExactKeys(outcome.rollback, ['fingerprint']) || !hasExactKeys(outcome.swap, ['step']) ||
      !hasExactKeys(outcome.liveValidation, ['properties']) ||
      !hasExactKeys(outcome.liveValidation.properties, ['existed', 'sha256']) ||
      !hasExactKeys(outcome.revisionEvent, ['eventId', 'published']) ||
      !hasExactKeys(outcome.cleanup, ['deletionAuthorized', 'rollbackRemoved']) ||
      !hasExactKeys(health, [
        'elapsedMs', 'endpoint', 'handedOff', 'kind', 'listenerOwned', 'live', 'motdNonce', 'operationId',
        'pid', 'pongMatched', 'properties', 'readyMarker', 'shutdown'
      ]) || outcome.runtime.maxRam !== 4 || outcome.runtime.port !== 25565 ||
      JSON.stringify(outcome.runtime.source) !== JSON.stringify(sourceRuntime) ||
      JSON.stringify(outcome.runtime.target) !== JSON.stringify(targetRuntime) ||
      outcome.revision?.source !== sourceRevision || outcome.revision.target !== targetRevision ||
      runtimePolicy.targetRunning !== false || runtimePolicy.targetAutoRestart !== false ||
      runtimePolicy.targetInactive !== false || runtimePolicy.handoffEventId !== null ||
      runtimePolicy.runningRestored !== false || outcome.target?.name !== 'server' ||
      !SHA256_PATTERN.test(outcome.live?.fingerprint) || !SHA256_PATTERN.test(outcome.candidate.fingerprint) ||
      !SHA256_PATTERN.test(outcome.candidate.markerSha256) ||
      outcome.candidate.properties.existed !== propertiesExisted ||
      (propertiesExisted ? !SHA256_PATTERN.test(outcome.candidate.properties.sha256) :
        outcome.candidate.properties.sha256 !== null) ||
      outcome.copy?.bytes !== copyBytes || outcome.copy.files !== copyFiles ||
      outcome.rollback.fingerprint !== outcome.live.fingerprint || outcome.swap.step !== 'candidate-published' ||
      JSON.stringify(outcome.liveValidation.properties) !== JSON.stringify(outcome.candidate.properties) ||
      outcome.cleanup.deletionAuthorized !== true || outcome.cleanup.rollbackRemoved !== true ||
      outcome.revisionEvent.eventId !== `modpack-content-revision:${record.jobId}:${targetRevision}` ||
      outcome.revisionEvent.published !== true || !Number.isSafeInteger(health.elapsedMs) || health.elapsedMs < 0 ||
      health.endpoint?.host !== '127.0.0.1' || !Number.isSafeInteger(health.endpoint.port) || health.endpoint.port < 1 ||
      health.handedOff !== false || health.kind !== 'live' || health.listenerOwned !== true || health.live !== true ||
      typeof health.motdNonce !== 'string' || !health.motdNonce.startsWith('minecraft-core-health:') ||
      typeof health.operationId !== 'string' || !health.operationId.startsWith('health-') ||
      !Number.isSafeInteger(health.pid) || health.pid < 1 || health.pongMatched !== true ||
      JSON.stringify(health.properties) !== JSON.stringify(outcome.candidate.properties) ||
      health.readyMarker !== 'Done (' || JSON.stringify(health.shutdown) !== JSON.stringify({
        clean: true, closed: true, exitCode: 0, forced: false, signal: null
      })) {
    fail(`completed ${operationKind} durable outcome is not exact`);
  }
}

async function readExactFileDigests(directory, inspector, label, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const names = (await fsp.readdir(directory)).sort((left, right) => left.localeCompare(right, 'en-US'));
  const digests = {};
  for (const name of names) {
    const { filePath } = await assertCanonicalFile(path.join(directory, name), directory, inspector, label, {
      maxBytes
    });
    digests[name] = sha256File(filePath);
  }
  return Object.freeze(digests);
}

async function assertExactFileDigests(directory, inspector, expected, label, options) {
  const current = await readExactFileDigests(directory, inspector, label, options);
  if (JSON.stringify(current) !== JSON.stringify(expected)) fail(`${label} changed after adoption`);
}

async function auditPostDetachRestoreFailedCheckpoint({
  serverPath,
  userDataPath,
  instanceId,
  inspector,
  activePath,
  checkpoint
}) {
  if ((await fsp.readdir(activePath)).length !== 0) fail('post-detach lifecycle still has active recovery records');
  const lifecycleRoot = path.dirname(activePath);
  const workspacesPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'workspaces'), lifecycleRoot, inspector);
  if ((await fsp.readdir(workspacesPath)).length !== 0) fail('post-detach lifecycle workspaces are not empty');
  const currentIdentity = await identifyServerDirectory(serverPath, { reparseInspector: inspector });
  if (!sameIdentity(currentIdentity, checkpoint.targetDirectoryIdentity)) {
    fail('post-detach live server directory identity changed');
  }
  for (const evidence of [checkpoint.completedRollbackEvidence, checkpoint.completedDetachEvidence]) {
    const siblings = createExistingSiblingPaths(serverPath, evidence.jobId);
    await Promise.all(['candidatePath', 'rollbackPath', 'failedPath'].map(key =>
      assertAbsent(siblings[key], `post-detach completed operation ${key}`)));
  }
  const failedSiblings = createExistingSiblingPaths(serverPath, checkpoint.failedDetachRestoreEvidence.jobId);
  await Promise.all(['candidatePath', 'rollbackPath', 'failedPath'].map(key =>
    assertAbsent(failedSiblings[key], `failed detach restore ${key}`)));
  await assertAbsent(
    path.join(serverPath, '.minecraft-core-state', 'operations', checkpoint.failedDetachRestoreEvidence.jobId),
    'failed detach restore operation workspace'
  );
  const current = await readDetachedState(serverPath, inspector, {
    expectedRevision: checkpoint.detachRevision,
    expectedRuntime: checkpoint.initialRuntime,
    expectedManifestId: checkpoint.detachedManifestId
  });
  const coordinator = await readCanonicalJson(
    path.join(serverPath, '.minecraft-core.json'), serverPath, inspector, 'detached server content revision', {
      maxBytes: 1024 * 1024
    }
  );
  if (coordinator.contentRevision !== checkpoint.coordinatorRevision || coordinator.modpackManaged !== false ||
      JSON.stringify(coordinator.runtime) !== JSON.stringify(checkpoint.initialRuntime)) {
    fail('detached server coordinator is not the exact revision 7 checkpoint');
  }
  const managedHistory = await readDetachedManagedHistory({
    current,
    inspector,
    completedRollbackJobId: checkpoint.completedRollbackEvidence.jobId,
    completedDetachJobId: checkpoint.completedDetachEvidence.jobId
  });
  if (managedHistory.detach.restorePointId !== checkpoint.detachRestorePointId ||
      managedHistory.detach.restorePointSha256 !== checkpoint.detachRestorePointSha256 ||
      managedHistory.detach.sourceRevision !== checkpoint.rollbackRevision ||
      managedHistory.detach.targetRevision !== checkpoint.detachRevision) {
    fail('detached managed history no longer binds the selected retry archive');
  }
  const expectedWorkspaceJobIds = checkpoint.completedRollbackEvidence.expectedWorkspaceJobIds;
  await readCompletedRollbackOperationWorkspace({
    serverPath,
    instanceId,
    inspector,
    evidence: checkpoint.completedRollbackEvidence,
    expectedWorkspaceJobIds
  });
  await readCompletedOperationWorkspace({
    serverPath,
    instanceId,
    inspector,
    evidence: checkpoint.completedDetachEvidence,
    operationKind: 'detach',
    label: 'completed detach',
    expectedWorkspaceJobIds
  });
  const backupsPath = await assertCanonicalDirectory(path.join(serverPath, 'backups'), serverPath, inspector);
  const backupEvidence = checkpoint.backupEvidence;
  if (!Array.isArray(backupEvidence) || backupEvidence.length !== 8) {
    fail('post-detach backup evidence is missing or ambiguous');
  }
  const auditedBackupNames = [];
  for (const expected of backupEvidence) {
    const restore = await readRestoreMetadata(backupsPath, expected.id, inspector);
    if (restore.metadata.sha256 !== expected.sha256 ||
        restore.metadata.sourceRevision !== expected.sourceRevision ||
        restore.metadata.operationId !== expected.operationId ||
        JSON.stringify(restore.metadata.sourceRuntime) !== JSON.stringify(expected.sourceRuntime) ||
        restore.metadata.scope.scopeSha256 !== expected.scopeSha256 ||
        restore.metadata.scope.fileCount !== expected.fileCount ||
        restore.metadata.scope.entries.length !== expected.entryCount ||
        restore.metadata.scope.totalBytes !== expected.totalBytes) {
      fail('post-detach backup lineage changed after adoption');
    }
    auditedBackupNames.push(path.basename(restore.archivePath), path.basename(restore.metadataPath));
  }
  const currentBackupNames = (await fsp.readdir(backupsPath)).sort((left, right) => left.localeCompare(right, 'en-US'));
  auditedBackupNames.sort((left, right) => left.localeCompare(right, 'en-US'));
  if (JSON.stringify(currentBackupNames) !== JSON.stringify(auditedBackupNames)) {
    fail('post-detach backup topology changed after adoption');
  }
  const detachRestore = await readRestoreMetadata(backupsPath, checkpoint.detachRestorePointId, inspector);
  const failedSafety = await readRestoreMetadata(
    backupsPath,
    checkpoint.failedDetachRestoreEvidence.safetyRestorePointId,
    inspector
  );
  if (detachRestore.metadata.sha256 !== checkpoint.detachRestorePointSha256 ||
      detachRestore.metadata.sourceRevision !== 6 || detachRestore.metadata.operationId !==
        checkpoint.completedDetachEvidence.jobId ||
      !detachRestore.metadata.pins.includes(checkpoint.completedDetachEvidence.jobId) ||
      detachRestore.metadata.scope.fileCount !== 517 || detachRestore.metadata.scope.entries.length !== 719 ||
      failedSafety.metadata.sha256 !== checkpoint.failedDetachRestoreEvidence.safetyRestorePointSha256 ||
      failedSafety.metadata.sourceRevision !== checkpoint.detachRevision ||
      failedSafety.metadata.operationId !== checkpoint.failedDetachRestoreEvidence.jobId ||
      !failedSafety.metadata.pins.includes(checkpoint.failedDetachRestoreEvidence.jobId) ||
      failedSafety.metadata.scope.fileCount !== 522 || failedSafety.metadata.scope.entries.length !== 725) {
    fail('post-detach restore archive evidence changed');
  }
  const archived = await readArchivedManagedSnapshot(detachRestore, {
    expectedRevision: checkpoint.rollbackRevision,
    expectedRuntime: checkpoint.initialRuntime
  });
  if (archived.state.manifestId !== checkpoint.detachedManifestId) {
    fail('detached restore archive manifest binding changed');
  }
  await assertExactFileDigests(
    path.join(lifecycleRoot, 'operations'), inspector, checkpoint.publicOperationDigests,
    'post-detach public operation evidence'
  );
  await assertExactFileDigests(
    path.join(lifecycleRoot, 'history'), inspector, checkpoint.lifecycleHistoryDigests,
    'post-detach lifecycle history evidence'
  );
  await assertExactFileDigests(
    path.join(current.stateRoot, 'history'), inspector, checkpoint.managedHistoryDigests,
    'post-detach managed history evidence'
  );
  return Object.freeze({
    state: current.state,
    managedModPath: current.managedPath,
    managedFilePaths: current.managedFilePaths,
    detachOperationId: checkpoint.completedDetachEvidence.jobId,
    failedRestoreOperationId: checkpoint.failedDetachRestoreEvidence.jobId,
    restorePointId: checkpoint.detachRestorePointId
  });
}

async function loadPostDetachRestoreFailed({
  root,
  userDataPath,
  serverPath,
  clientPath,
  evidencePath,
  lifecycleRoot,
  activePath,
  rootDirectoryIdentity,
  inspector,
  jobs,
  rollbackJobs
}) {
  const operationCounts = new Map();
  for (const job of jobs) operationCounts.set(job.operationKind, (operationCounts.get(job.operationKind) || 0) + 1);
  if (jobs.length !== 14 || JSON.stringify([...operationCounts.entries()].sort()) !== JSON.stringify([
        ['detach', 1], ['install-new', 1], ['repair', 1], ['rollback-restore-point', 6], ['update', 1], ['verify', 4]
      ])) {
    fail('post-detach public operation topology is not exact');
  }
  const completedRollbackJobs = rollbackJobs.filter(isExactCompletedRollbackJob);
  const detachJobs = jobs.filter(job => isExactCompletedManagementJob(job, 'detach'));
  if (completedRollbackJobs.length !== 1 || detachJobs.length !== 1 ||
      completedRollbackJobs[0].sequence !== 19 || detachJobs[0].sequence !== 18) {
    fail('post-detach completed rollback or detach operation is missing or ambiguous');
  }
  const completedRollbackJob = completedRollbackJobs[0];
  const detachJob = detachJobs[0];
  const failedAfterDetach = rollbackJobs.filter(job => isExactFailedRollbackJob(job, {
    errorCode: 'COMMIT_FAILED',
    percent: 43,
    message: 'Restoring the selected verified server snapshot',
    cleanupPending: true
  }) && Date.parse(job.createdAt) > Date.parse(detachJob.terminalAt));
  if (failedAfterDetach.length !== 1 || failedAfterDetach[0].sequence !== 9 ||
      completedRollbackJob.serverId !== detachJob.serverId ||
      detachJob.serverId !== failedAfterDetach[0].serverId ||
      JSON.stringify(failedAfterDetach[0].outcome.actions?.map(action => action?.actionId)) !==
        JSON.stringify(['change-selection', 'open-details']) ||
      Date.parse(failedAfterDetach[0].updatedAt) !== Date.parse(failedAfterDetach[0].terminalAt)) {
    fail('post-detach failed restore public operation is not exact');
  }
  const failedJob = failedAfterDetach[0];
  const priorRollbackJobs = rollbackJobs.filter(job => job.jobId !== failedJob.jobId);
  const lineage = await readPostRecoveryTerminalLineage({
    serverPath,
    lifecycleRoot,
    inspector,
    rollbackJobs: priorRollbackJobs,
    completedRollbackJob,
    additionalRollbackHistoryJobIds: [failedJob.jobId]
  });
  const latestPriorRecovery = lineage.recoveries.at(-1);
  if (Date.parse(completedRollbackJob.createdAt) <= latestPriorRecovery.updatedAt ||
      Date.parse(detachJob.createdAt) <= Date.parse(completedRollbackJob.terminalAt) ||
      Date.parse(failedJob.createdAt) <= Date.parse(detachJob.terminalAt)) {
    fail('post-detach operation chronology is invalid');
  }

  const historyPath = lineage.historyPath;
  const completedPair = await readPairedLifecycleRecord(historyPath, completedRollbackJob, inspector, 'completed rollback');
  const detachPair = await readPairedLifecycleRecord(historyPath, detachJob, inspector, 'completed detach');
  const failedPair = await readPairedLifecycleRecord(historyPath, failedJob, inspector, 'failed detach restore');
  const completed = completedPair.record;
  const detach = detachPair.record;
  const failed = failedPair.record;
  if (completed.operationKind !== 'rollback' || completed.phase !== 'completed' ||
      completed.swapStep !== 'cleanup-complete' || completed.sequence !== 22 ||
      completed.target.kind !== 'existing' || completed.target.stableServerId !== completedRollbackJob.serverId ||
      !pathsEqual(completed.target.path, serverPath) || completed.restoreCreation !== null ||
      completed.priorRuntime.running !== false || completed.priorRuntime.autoRestart !== false ||
      !sameIdentity(completed.directoryIdentities.target, completed.directoryIdentities.candidate) ||
      sameIdentity(completed.directoryIdentities.target, completed.directoryIdentities.rollback) ||
      completed.directoryIdentities.failed !== null) {
    fail('post-detach completed rollback durable checkpoint is not exact');
  }
  validateCompletedOperationOutcome(completed, {
    operationKind: 'rollback',
    sourceRevision: 3,
    targetRevision: 5,
    sourceRuntime: latestPriorRecovery.runtime.source,
    targetRuntime: latestPriorRecovery.runtime.target,
    propertiesExisted: false,
    copyBytes: '0',
    copyFiles: '0'
  });
  if (!hasExactKeys(completed.outcome.releaseTracking, [
        'schemaVersion', 'action', 'status', 'serverId', 'trackingId', 'record'
      ]) || completed.outcome.releaseTracking.action !== 'upsert' ||
      completed.outcome.releaseTracking.status !== 'applied' ||
      completed.outcome.releaseTracking.serverId !== completed.target.stableServerId ||
      completed.outcome.releaseTracking.trackingId !== `tracking-${completed.target.stableServerId}` ||
      completed.outcome.releaseTracking.record?.provider !== 'modrinth' ||
      completed.outcome.releaseTracking.record?.projectId !== realHarness.REAL_MODRINTH_LIFECYCLE.projectId ||
      completed.outcome.releaseTracking.record?.lastSnapshot?.releaseId !==
        realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id) {
    fail('post-detach completed rollback release tracking is not exact');
  }

  if (detach.operationKind !== 'detach' || detach.phase !== 'completed' || detach.swapStep !== 'cleanup-complete' ||
      detach.sequence !== 22 || detach.target.kind !== 'existing' ||
      detach.target.stableServerId !== completed.target.stableServerId || !pathsEqual(detach.target.path, serverPath) ||
      detach.restoreCreation !== null || detach.priorRuntime.running !== false || detach.priorRuntime.autoRestart !== false ||
      !sameIdentity(detach.directoryIdentities.target, detach.directoryIdentities.candidate) ||
      sameIdentity(detach.directoryIdentities.target, detach.directoryIdentities.rollback) ||
      detach.directoryIdentities.failed !== null) {
    fail('completed detach durable checkpoint is not exact');
  }
  validateCompletedOperationOutcome(detach, {
    operationKind: 'detach',
    sourceRevision: 5,
    targetRevision: 7,
    sourceRuntime: latestPriorRecovery.runtime.target,
    targetRuntime: latestPriorRecovery.runtime.target,
    propertiesExisted: true,
    copyBytes: '1569126978',
    copyFiles: 531
  });
  if (!hasExactKeys(detach.outcome.releaseTracking, [
        'schemaVersion', 'action', 'status', 'serverId', 'trackingId'
      ]) || detach.outcome.releaseTracking.schemaVersion !== 1 || detach.outcome.releaseTracking.action !== 'remove' ||
      detach.outcome.releaseTracking.status !== 'applied' ||
      detach.outcome.releaseTracking.serverId !== detach.target.stableServerId ||
      detach.outcome.releaseTracking.trackingId !== `tracking-${detach.target.stableServerId}`) {
    fail('completed detach release tracking is not exact');
  }

  if (failed.schemaVersion !== 2 || failed.sequence !== 14 || failed.operationKind !== 'rollback' ||
      failed.phase !== 'failed' || failed.swapStep !== 'none' || failed.target.kind !== 'existing' ||
      failed.target.stableServerId !== detach.target.stableServerId || !pathsEqual(failed.target.path, serverPath) ||
      failed.restoreCreation !== null || failed.priorRuntime.running !== false || failed.priorRuntime.autoRestart !== false ||
      !sameIdentity(failed.directoryIdentities.target, failed.directoryIdentities.rollback) ||
      sameIdentity(failed.directoryIdentities.target, failed.directoryIdentities.candidate) ||
      failed.directoryIdentities.failed !== null || !hasExactKeys(failed.outcome, [
        'live', 'runtime', 'runtimePolicy', 'target', 'revision', 'candidateCleanup', 'recovery'
      ]) || failed.outcome.revision?.source !== 7 || failed.outcome.revision.target !== 8 ||
      failed.outcome.runtime?.maxRam !== 4 || failed.outcome.runtime.port !== 25565 ||
      JSON.stringify(failed.outcome.runtime.source) !== JSON.stringify(latestPriorRecovery.runtime.target) ||
      JSON.stringify(failed.outcome.runtime.target) !== JSON.stringify(latestPriorRecovery.runtime.target) ||
      failed.outcome.runtimePolicy?.targetRunning !== false ||
      failed.outcome.runtimePolicy.targetAutoRestart !== false ||
      failed.outcome.runtimePolicy.targetInactive !== false || failed.outcome.target?.name !== 'server' ||
      !SHA256_PATTERN.test(failed.outcome.live?.fingerprint) ||
      failed.outcome.candidateCleanup?.deletionAuthorized !== true ||
      failed.outcome.candidateCleanup.slot !== 'candidate' ||
      failed.outcome.candidateCleanup.action !== 'pre-swap-restored' ||
      failed.outcome.candidateCleanup.ownershipMode !== 'recorded-identity' ||
      !sameIdentity(failed.outcome.candidateCleanup.directoryIdentity, failed.directoryIdentities.candidate) ||
      !SHA256_PATTERN.test(failed.outcome.candidateCleanup.fingerprint) ||
      failed.outcome.recovery?.action !== 'pre-swap-restored' ||
      failed.outcome.recovery.operationId !== failed.jobId) {
    fail('failed detach restore durable checkpoint is not exact');
  }
  const failedExpectedPaths = createExistingSiblingPaths(serverPath, failed.jobId);
  const failedExpectedJournal = path.join(
    failedExpectedPaths.candidatePath, '.minecraft-core-state', 'operations', failed.jobId, 'journal.json'
  );
  for (const key of ['candidatePath', 'rollbackPath', 'failedPath']) {
    const expected = failedExpectedPaths[key];
    if (!pathsEqual(failed[key], expected)) fail(`failed detach restore ${key} is not the exact operation sibling`);
    await assertAbsent(expected, `failed detach restore ${key}`);
  }
  if (!pathsEqual(failed.journalPath, failedExpectedJournal) ||
      Date.parse(failed.createdAt) < Date.parse(failedJob.createdAt) ||
      Date.parse(failed.updatedAt) <= Date.parse(failed.createdAt) ||
      Date.parse(failed.updatedAt) >= Date.parse(failedJob.terminalAt)) {
    fail('failed detach restore chronology or journal binding is invalid');
  }
  await assertAbsent(
    path.join(serverPath, '.minecraft-core-state', 'operations', failed.jobId),
    'failed detach restore operation workspace'
  );

  const configPath = await assertCanonicalDirectory(path.join(userDataPath, 'config'), userDataPath, inspector);
  const config = await readCanonicalJson(
    path.join(configPath, 'minecraft-core-config.json'), configPath, inspector, 'post-detach saved instance configuration'
  );
  if (!Array.isArray(config.instances) || config.instances.length !== 1 || config.instances[0]?.type !== 'server' ||
      config.instances[0].id !== detach.target.stableServerId || !pathsEqual(config.instances[0].path, serverPath) ||
      typeof config.lastServerPath !== 'string' || !pathsEqual(config.lastServerPath, serverPath)) {
    fail('post-detach saved instance does not bind the validated disposable server');
  }
  const coordinator = await readCanonicalJson(
    path.join(serverPath, '.minecraft-core.json'), serverPath, inspector, 'post-detach server content revision', {
      maxBytes: 1024 * 1024
    }
  );
  if (coordinator.contentRevision !== 7 || coordinator.modpackManaged !== false ||
      JSON.stringify(coordinator.runtime) !== JSON.stringify(latestPriorRecovery.runtime.target)) {
    fail('post-detach coordinator is not the exact detached revision 7 checkpoint');
  }
  const current = await readDetachedState(serverPath, inspector, {
    expectedRevision: 7,
    expectedRuntime: latestPriorRecovery.runtime.target
  });
  const targetIdentity = await identifyServerDirectory(serverPath, { reparseInspector: inspector });
  if (!sameIdentity(completed.directoryIdentities.target, detach.directoryIdentities.rollback) ||
      !sameIdentity(targetIdentity, detach.directoryIdentities.target) ||
      !sameIdentity(targetIdentity, failed.directoryIdentities.target)) {
    fail('post-detach live server identity does not bind the rollback, detach, and failed restore lineage');
  }
  const completedPaths = createExistingSiblingPaths(serverPath, completed.jobId);
  const detachPaths = createExistingSiblingPaths(serverPath, detach.jobId);
  for (const [record, expectedPaths, label] of [
    [completed, completedPaths, 'completed rollback'],
    [detach, detachPaths, 'completed detach']
  ]) {
    for (const key of ['candidatePath', 'rollbackPath', 'failedPath']) {
      const expected = expectedPaths[key];
      if (!pathsEqual(record[key], expected)) fail(`${label} ${key} is not the exact operation sibling`);
      await assertAbsent(expected, `${label} ${key}`);
    }
  }
  const operationWorkspaceIds = [completed.jobId, detach.jobId]
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  const completedEvidence = Object.freeze({
    ...completedOperationEvidence(completed, completedPair.envelope),
    expectedWorkspaceJobIds: Object.freeze([...operationWorkspaceIds])
  });
  const detachEvidence = Object.freeze({
    ...completedOperationEvidence(detach, detachPair.envelope),
    expectedWorkspaceJobIds: Object.freeze([...operationWorkspaceIds])
  });
  const completedOperation = await readCompletedRollbackOperationWorkspace({
    serverPath,
    instanceId: detach.target.stableServerId,
    inspector,
    evidence: completedEvidence,
    expectedWorkspaceJobIds: operationWorkspaceIds
  });
  const detachOperation = await readCompletedOperationWorkspace({
    serverPath,
    instanceId: detach.target.stableServerId,
    inspector,
    evidence: detachEvidence,
    operationKind: 'detach',
    label: 'completed detach',
    expectedWorkspaceJobIds: operationWorkspaceIds
  });
  if (!pathsEqual(completed.journalPath, path.join(completedOperation.workspace, 'journal.json')) ||
      !pathsEqual(detach.journalPath, path.join(detachOperation.workspace, 'journal.json'))) {
    fail('completed rollback or detach journal path does not bind its live operation workspace');
  }

  const managedHistory = await readDetachedManagedHistory({
    current,
    inspector,
    completedRollbackJobId: completed.jobId,
    completedDetachJobId: detach.jobId
  });
  if (managedHistory.rollback.restorePointId !== completed.restorePoint?.id ||
      managedHistory.rollback.restorePointSha256 !== completed.restorePoint?.sha256 ||
      managedHistory.detach.restorePointId !== detach.restorePoint?.id ||
      managedHistory.detach.restorePointSha256 !== detach.restorePoint?.sha256 ||
      JSON.stringify(managedHistory.rollback.sourceRuntime) !== JSON.stringify(latestPriorRecovery.runtime.source) ||
      JSON.stringify(managedHistory.rollback.targetRuntime) !== JSON.stringify(latestPriorRecovery.runtime.target)) {
    fail('post-detach managed rollback and detach history does not bind durable lifecycle evidence');
  }

  const historyNames = (await fsp.readdir(historyPath)).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (historyNames.length !== 18) fail('post-detach lifecycle history pair count is not exact');
  const historyRecords = new Map();
  for (const name of historyNames.filter(name => !name.endsWith('.target.json'))) {
    const jobId = name.slice(0, -'.json'.length);
    const pair = await readPairedLifecycleRecord(
      historyPath,
      { jobId },
      inspector,
      'post-detach lifecycle history'
    );
    historyRecords.set(jobId, pair.record);
  }
  const expectedHistoryIds = new Set([
    managedHistory.install.operationId,
    managedHistory.repair.operationId,
    managedHistory.upgrade.operationId,
    ...lineage.commitJobs.map(job => job.jobId),
    completed.jobId,
    detach.jobId,
    failed.jobId
  ]);
  if (expectedHistoryIds.size !== 9 || historyRecords.size !== 9 ||
      [...expectedHistoryIds].some(jobId => !historyRecords.has(jobId)) || historyRecords.has(lineage.staleJob.jobId)) {
    fail('post-detach lifecycle history topology is not the exact nine-operation lineage');
  }
  const installRecord = historyRecords.get(managedHistory.install.operationId);
  if (installRecord.operationKind !== 'install' || installRecord.phase !== 'completed' ||
      installRecord.swapStep !== 'candidate-published' || installRecord.target.kind !== 'new' ||
      installRecord.target.stableServerId !== detach.target.stableServerId ||
      !pathsEqual(installRecord.target.path, serverPath) ||
      Object.prototype.hasOwnProperty.call(installRecord.outcome, 'revision')) {
    fail('post-detach install-new durable publication lineage is invalid');
  }
  for (const [managed, operationKind, sourceRevision, targetRevision] of [
    [managedHistory.repair, 'repair', 1, 2],
    [managedHistory.upgrade, 'upgrade', 2, 3]
  ]) {
    const record = historyRecords.get(managed.operationId);
    if (record.operationKind !== operationKind || record.phase !== 'completed' ||
        record.swapStep !== 'cleanup-complete' || record.target.kind !== 'existing' ||
        record.target.stableServerId !== detach.target.stableServerId || !pathsEqual(record.target.path, serverPath) ||
        record.outcome?.revision?.source !== sourceRevision || record.outcome.revision.target !== targetRevision) {
      fail('post-detach repair or upgrade durable lineage is invalid');
    }
  }

  const backupsPath = await assertCanonicalDirectory(path.join(serverPath, 'backups'), serverPath, inspector);
  const repairRestore = await readRestoreMetadata(backupsPath, managedHistory.repair.restorePointId, inspector);
  const selectedRestore = await readRestoreMetadata(backupsPath, managedHistory.upgrade.restorePointId, inspector);
  const completedSafety = await readRestoreMetadata(backupsPath, managedHistory.rollback.restorePointId, inspector);
  const detachRestore = await readRestoreMetadata(backupsPath, managedHistory.detach.restorePointId, inspector);
  const failedSafety = await readRestoreMetadata(backupsPath, failed.restorePoint?.id, inspector);
  if (repairRestore.metadata.sha256 !== managedHistory.repair.restorePointSha256 ||
      repairRestore.metadata.sourceRevision !== 1 || repairRestore.metadata.operationId !== managedHistory.repair.operationId ||
      JSON.stringify(repairRestore.metadata.sourceRuntime) !== JSON.stringify(managedHistory.repair.sourceRuntime) ||
      String(repairRestore.metadata.scope.totalBytes) !== managedHistory.repair.restorePointTotalBytes ||
      selectedRestore.metadata.sha256 !== managedHistory.upgrade.restorePointSha256 ||
      selectedRestore.metadata.sourceRevision !== 2 || selectedRestore.metadata.operationId !== managedHistory.upgrade.operationId ||
      JSON.stringify(selectedRestore.metadata.sourceRuntime) !== JSON.stringify(managedHistory.upgrade.sourceRuntime) ||
      String(selectedRestore.metadata.scope.totalBytes) !== managedHistory.upgrade.restorePointTotalBytes ||
      completedSafety.metadata.sha256 !== managedHistory.rollback.restorePointSha256 ||
      completedSafety.metadata.sourceRevision !== 4 || completedSafety.metadata.operationId !== completed.jobId ||
      JSON.stringify(completedSafety.metadata.sourceRuntime) !== JSON.stringify(managedHistory.rollback.sourceRuntime) ||
      String(completedSafety.metadata.scope.totalBytes) !== managedHistory.rollback.restorePointTotalBytes ||
      detachRestore.metadata.sha256 !== managedHistory.detach.restorePointSha256 ||
      detachRestore.metadata.sourceRevision !== 6 || detachRestore.metadata.operationId !== detach.jobId ||
      JSON.stringify(detachRestore.metadata.sourceRuntime) !== JSON.stringify(managedHistory.detach.sourceRuntime) ||
      String(detachRestore.metadata.scope.totalBytes) !== managedHistory.detach.restorePointTotalBytes ||
      !detachRestore.metadata.pins.includes(detach.jobId) ||
      detachRestore.metadata.scope.fileCount !== 517 || detachRestore.metadata.scope.entries.length !== 719 ||
      failedSafety.metadata.sha256 !== failed.restorePoint.sha256 || failedSafety.metadata.sourceRevision !== 7 ||
      failedSafety.metadata.operationId !== failed.jobId || !failedSafety.metadata.pins.includes(failed.jobId) ||
      JSON.stringify(failedSafety.metadata.sourceRuntime) !== JSON.stringify(current.state.runtime) ||
      failedSafety.metadata.scope.fileCount !== 522 || failedSafety.metadata.scope.entries.length !== 725) {
    fail('failed detach restore safety evidence or selected restore lineage is invalid');
  }
  const recoverySafeties = [];
  for (const item of lineage.recoveries) {
    const safety = await readRestoreMetadata(backupsPath, item.recovery.restorePoint.id, inspector);
    if (safety.metadata.sha256 !== item.recovery.restorePoint.sha256 ||
        safety.metadata.sourceRevision !== item.recovery.outcome.revision.target - 1 ||
        safety.metadata.operationId !== item.recovery.jobId || !safety.metadata.pins.includes(item.recovery.jobId)) {
      fail('post-detach prior recovery safety lineage is invalid');
    }
    recoverySafeties.push(safety);
  }
  const allRestores = [repairRestore, selectedRestore, ...recoverySafeties, completedSafety, detachRestore, failedSafety];
  if (allRestores.length !== 8 || new Set(allRestores.map(item => item.metadata.id)).size !== 8) {
    fail('post-detach restore lineage is ambiguous');
  }
  const expectedBackupNames = allRestores.flatMap(item => [
    path.basename(item.archivePath), path.basename(item.metadataPath)
  ]).sort((left, right) => left.localeCompare(right, 'en-US'));
  const actualBackupNames = (await fsp.readdir(backupsPath)).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (JSON.stringify(actualBackupNames) !== JSON.stringify(expectedBackupNames)) {
    fail('post-detach backup topology is not the exact eight-restore lineage');
  }
  const archived = await readArchivedManagedSnapshot(detachRestore, {
    expectedRevision: 5,
    expectedRuntime: latestPriorRecovery.runtime.target
  });
  if (archived.state.manifestId !== current.state.manifestId) {
    fail('post-detach selected restore does not bind the detached immutable manifest');
  }

  const operationsPath = path.join(lifecycleRoot, 'operations');
  const supportJobs = jobs.filter(job => ['install-new', 'repair', 'update'].includes(job.operationKind));
  const verifyJobs = jobs.filter(job => job.operationKind === 'verify');
  const supportSequences = new Map([['install-new', 31], ['repair', 19], ['update', 30]]);
  if (supportJobs.some(job => job.sequence !== supportSequences.get(job.operationKind) ||
        job.phase !== 'completed' || job.progress?.percent !== 100 ||
        job.progress?.message !== 'Modpack operation completed') ||
      verifyJobs.some(job => job.sequence !== 2 || job.phase !== 'completed' || job.progress?.percent !== 100 ||
        job.progress?.message !== 'Managed files verified') ||
      !supportJobs.some(job => job.jobId === managedHistory.install.operationId && job.operationKind === 'install-new') ||
      !supportJobs.some(job => job.jobId === managedHistory.repair.operationId && job.operationKind === 'repair') ||
      !supportJobs.some(job => job.jobId === managedHistory.upgrade.operationId && job.operationKind === 'update')) {
    fail('post-detach supporting public operation lineage is invalid');
  }
  const publicOperationDigests = await readExactFileDigests(
    operationsPath, inspector, 'post-detach public operation evidence'
  );
  const lifecycleHistoryDigests = await readExactFileDigests(
    historyPath, inspector, 'post-detach lifecycle history evidence'
  );
  const managedHistoryDigests = await readExactFileDigests(
    path.join(current.stateRoot, 'history'), inspector, 'post-detach managed history evidence'
  );
  const managedFilePaths = current.managedFilePaths;
  const backupEvidence = Object.freeze(allRestores.map(item => Object.freeze({
    id: item.metadata.id,
    sha256: item.metadata.sha256,
    sourceRevision: item.metadata.sourceRevision,
    operationId: item.metadata.operationId,
    sourceRuntime: Object.freeze({ ...item.metadata.sourceRuntime }),
    scopeSha256: item.metadata.scope.scopeSha256,
    fileCount: item.metadata.scope.fileCount,
    entryCount: item.metadata.scope.entries.length,
    totalBytes: item.metadata.scope.totalBytes
  })));
  const [serverPort, managementPort] = await reserveDistinctPorts();
  const checkpoint = Object.freeze({
    currentVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[1].id,
    initialVersionId: current.state.source.versionId,
    sourceRevision: 3,
    rollbackSourceRevision: managedHistory.rollback.sourceRevision,
    rollbackRevision: managedHistory.rollback.targetRevision,
    detachRevision: current.state.contentRevision,
    detachRestoreRevision: failed.outcome.revision.target,
    completionRevisionFloor: failed.outcome.revision.target,
    coordinatorRevision: coordinator.contentRevision,
    currentRuntime: Object.freeze({ ...latestPriorRecovery.runtime.source }),
    initialRuntime: Object.freeze({ ...current.state.runtime }),
    targetDirectoryIdentity: Object.freeze({ ...targetIdentity }),
    preRecoveryFingerprint: latestPriorRecovery.recovery.outcome.live.fingerprint,
    upgradeRestorePointId: managedHistory.upgrade.restorePointId,
    upgradeRestorePointSha256: managedHistory.upgrade.restorePointSha256,
    safetyRestorePointId: completed.restorePoint.id,
    safetyRestorePointSha256: completed.restorePoint.sha256,
    detachRestorePointId: detachRestore.metadata.id,
    detachRestorePointSha256: detachRestore.metadata.sha256,
    detachedManifestId: current.state.manifestId,
    worldSentinelPath: current.sentinelPath,
    worldSentinelText: WORLD_SENTINEL_TEXT,
    currentManagedModPath: null,
    initialManagedModPath: current.managedPath,
    initialManagedFilePaths: Object.freeze([...managedFilePaths]),
    restoreScope: Object.freeze({
      fileCount: selectedRestore.metadata.scope.fileCount,
      totalBytes: selectedRestore.metadata.scope.totalBytes,
      entryCount: selectedRestore.metadata.scope.entries.length,
      scopeSha256: selectedRestore.metadata.scope.scopeSha256,
      mismatches: 0
    }),
    movedRestorePayloadNames: Object.freeze([]),
    historyCount: managedHistory.history.length,
    completedRollbackEvidence: completedEvidence,
    completedDetachEvidence: detachEvidence,
    failedDetachRestoreEvidence: Object.freeze({
      jobId: failed.jobId,
      safetyRestorePointId: failed.restorePoint.id,
      safetyRestorePointSha256: failed.restorePoint.sha256,
      sourceRevision: failed.outcome.revision.source,
      targetRevision: failed.outcome.revision.target
    }),
    backupEvidence,
    publicOperationDigests,
    lifecycleHistoryDigests,
    managedHistoryDigests
  });
  return createGuardedManagementLifecycle({
    root,
    userDataPath,
    serverPath,
    clientPath,
    evidencePath,
    instanceId: detach.target.stableServerId,
    serverPort,
    managementPort,
    recovery: {
      jobId: failed.jobId,
      phase: failed.phase,
      swapStep: failed.swapStep,
      candidatePath: failedExpectedPaths.candidatePath,
      rollbackPath: failedExpectedPaths.rollbackPath,
      failedPath: failedExpectedPaths.failedPath,
      failedRollbackJobId: lineage.staleJob.jobId,
      recoveredJobIds: Object.freeze(lineage.commitJobs.map(job => job.jobId)),
      completedRollbackJobId: completed.jobId,
      completedDetachJobId: detach.jobId
    },
    checkpoint,
    activePath,
    rootDirectoryIdentity,
    inspector,
    continuationMode: 'post-detach-restore-failed',
    requiresRecovery: false,
    rollbackCompleted: true,
    detachCompleted: true
  });
}

async function loadPostUninstallCompleted({
  root, userDataPath, serverPath, clientPath, evidencePath, lifecycleRoot, activePath,
  rootDirectoryIdentity, inspector, jobs, rollbackJobs
}) {
  await assertRootTopology(root, ['user-data', 'server', 'client', 'evidence', 'real-lifecycle-identity.json'], inspector);
  const counts = new Map();
  for (const job of jobs) counts.set(job.operationKind, (counts.get(job.operationKind) || 0) + 1);
  if (jobs.length !== 17 || JSON.stringify([...counts.entries()].sort()) !== JSON.stringify([
    ['detach', 1], ['install-new', 1], ['repair', 1], ['rollback-restore-point', 7],
    ['uninstall-managed', 1], ['update', 1], ['verify', 5]
  ])) fail('completed management public operation topology is not exact');
  const retryJobs = rollbackJobs.filter(job => isExactCompletedRollbackJob(job) && job.sequence === 19);
  const uninstallJobs = jobs.filter(job => isExactCompletedManagementJob(job, 'uninstall-managed') && job.sequence === 17);
  if (retryJobs.length !== 2 || uninstallJobs.length !== 1) {
    fail('completed management rollback or uninstall public operation is missing or ambiguous');
  }
  retryJobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const retryJob = retryJobs[1];
  const uninstallJob = uninstallJobs[0];
  if (retryJob.serverId !== uninstallJob.serverId ||
      Date.parse(uninstallJob.createdAt) <= Date.parse(retryJob.terminalAt)) {
    fail('completed management public operation chronology is invalid');
  }
  const historyPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'history'), lifecycleRoot, inspector);
  const lifecycleHistoryNames = (await fsp.readdir(historyPath)).sort((a, b) => a.localeCompare(b, 'en-US'));
  if (lifecycleHistoryNames.length !== 22 ||
      lifecycleHistoryNames.filter(name => name.endsWith('.target.json')).length !== 11) {
    fail('completed management durable history topology is not exact');
  }
  const durableRecords = new Map();
  for (const name of lifecycleHistoryNames.filter(name => !name.endsWith('.target.json'))) {
    const jobId = name.slice(0, -'.json'.length);
    const pair = await readPairedLifecycleRecord(historyPath, { jobId }, inspector, 'completed management history');
    durableRecords.set(jobId, pair.record);
  }
  if (durableRecords.size !== 11) fail('completed management durable lineage is ambiguous');
  const retryPair = await readPairedLifecycleRecord(historyPath, retryJob, inspector, 'completed retry rollback');
  const uninstallPair = await readPairedLifecycleRecord(historyPath, uninstallJob, inspector, 'completed uninstall');
  const retry = retryPair.record;
  const uninstall = uninstallPair.record;
  for (const [record, kind, source, target, label] of [
    [retry, 'rollback', 7, 8, 'completed retry rollback'],
    [uninstall, 'uninstall', 8, 10, 'completed uninstall']
  ]) {
    if (record.operationKind !== kind || record.phase !== 'completed' || record.sequence !== 22 ||
        record.swapStep !== 'cleanup-complete' || record.target.kind !== 'existing' ||
        record.target.stableServerId !== retryJob.serverId || !pathsEqual(record.target.path, serverPath) ||
        record.restoreCreation !== null || record.priorRuntime.running !== false ||
        record.priorRuntime.autoRestart !== false || record.outcome?.revision?.source !== source ||
        record.outcome.revision.target !== target || !sameIdentity(record.directoryIdentities.target, record.directoryIdentities.candidate) ||
        sameIdentity(record.directoryIdentities.target, record.directoryIdentities.rollback) ||
        record.directoryIdentities.failed !== null) fail(`${label} durable checkpoint is not exact`);
    const paths = createExistingSiblingPaths(serverPath, record.jobId);
    for (const key of ['candidatePath', 'rollbackPath', 'failedPath']) {
      if (!pathsEqual(record[key], paths[key])) fail(`${label} sibling binding is invalid`);
      await assertAbsent(paths[key], `${label} ${key}`);
    }
  }
  if (retry.outcome.releaseTracking?.action !== 'upsert' || retry.outcome.releaseTracking.status !== 'applied' ||
      uninstall.outcome.releaseTracking?.action !== 'remove' || uninstall.outcome.releaseTracking.status !== 'applied' ||
      retry.outcome.copy?.files !== '0' || retry.outcome.copy.bytes !== '0' ||
      uninstall.outcome.copy?.files !== 542 || uninstall.outcome.copy.bytes !== '2127135833') {
    fail('completed management durable outcomes are not exact');
  }
  const workspacesPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'workspaces'), lifecycleRoot, inspector);
  if ((await fsp.readdir(workspacesPath)).length !== 0 || (await fsp.readdir(activePath)).length !== 0) {
    fail('completed management still has active lifecycle work');
  }
  const stateRoot = await assertCanonicalDirectory(path.join(serverPath, '.minecraft-core-state'), serverPath, inspector);
  const state = await readCanonicalJson(path.join(stateRoot, 'modpack.json'), stateRoot, inspector, 'completed files-only state');
  const coordinator = await readCanonicalJson(path.join(serverPath, '.minecraft-core.json'), serverPath, inspector,
    'completed files-only coordinator', { maxBytes: 1024 * 1024 });
  if (state.schemaVersion !== 1 || state.modpackManaged !== false || state.lifecycleMode !== 'files-only' ||
      state.contentRevision !== 10 || state.runtime !== null || state.manifestId !== null ||
      state.source?.provider !== 'modrinth' || state.source.projectId !== realHarness.REAL_MODRINTH_LIFECYCLE.projectId ||
      state.source.versionId !== realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id ||
      coordinator.contentRevision !== 10 || coordinator.modpackManaged !== false ||
      coordinator.modpackLifecycleMode !== 'files-only') fail('completed management state is not exact revision 10');
  const managedHistoryPath = await assertCanonicalDirectory(path.join(stateRoot, 'history'), stateRoot, inspector);
  const managedHistoryNames = (await fsp.readdir(managedHistoryPath)).filter(name => name.endsWith('.json'));
  const managedHistory = [];
  for (const name of managedHistoryNames) managedHistory.push(await readCanonicalJson(
    path.join(managedHistoryPath, name), managedHistoryPath, inspector, 'completed managed history'));
  managedHistory.sort((left, right) => left.sequence - right.sequence);
  if (managedHistory.length !== 7 || JSON.stringify(managedHistory.map(item => [item.sequence, item.kind, item.sourceRevision, item.targetRevision])) !==
      JSON.stringify([[1, 'install', 0, 1], [2, 'repair', 1, 2], [3, 'upgrade', 2, 3],
        [4, 'rollback', 4, 5], [5, 'detach', 5, 7], [6, 'rollback', 7, 8], [7, 'uninstall', 8, 10]]) ||
      managedHistory.some(item => item.outcome !== 'completed') ||
      managedHistory[5].operationId !== retry.jobId || managedHistory[6].operationId !== uninstall.jobId) {
    fail('completed management history lineage is not exact');
  }
  const backupsPath = await assertCanonicalDirectory(path.join(serverPath, 'backups'), serverPath, inspector);
  const backupNames = (await fsp.readdir(backupsPath)).sort((a, b) => a.localeCompare(b, 'en-US'));
  if (backupNames.length !== 20 || backupNames.filter(name => name.endsWith('.json')).length !== 10 ||
      backupNames.filter(name => name.endsWith('.zip')).length !== 10) fail('completed management backup topology is not exact');
  const restoreIds = new Set();
  for (const name of backupNames.filter(value => value.endsWith('.json'))) {
    const metadata = await readCanonicalJson(path.join(backupsPath, name), backupsPath, inspector,
      'completed management restore metadata', { maxBytes: 16 * 1024 * 1024 });
    const restore = await readRestoreMetadata(backupsPath, metadata.id, inspector);
    const record = durableRecords.get(metadata.operationId);
    if (restoreIds.has(metadata.id) || !record || record.restorePoint?.id !== metadata.id ||
        record.restorePoint.sha256 !== metadata.sha256 || metadata.sourceRevision !== record.outcome?.revision?.target - 1 ||
        !metadata.pins.includes(record.jobId)) fail('completed management restore lineage is not exact');
    restoreIds.add(metadata.id);
  }
  if (restoreIds.size !== 10) fail('completed management restore lineage is ambiguous');
  const uninstallRestore = await readRestoreMetadata(backupsPath, uninstall.restorePoint?.id, inspector);
  if (uninstallRestore.metadata.sha256 !== uninstall.restorePoint.sha256 ||
      uninstallRestore.metadata.sourceRevision !== 9 || uninstallRestore.metadata.operationId !== uninstall.jobId ||
      !uninstallRestore.metadata.pins.includes(uninstall.jobId) || uninstallRestore.metadata.scope.fileCount !== 522 ||
      uninstallRestore.metadata.scope.entries.length !== 724) fail('completed uninstall restore evidence is invalid');
  const archived = await readArchivedManagedSnapshot(uninstallRestore, {
    expectedRevision: 8, expectedRuntime: retry.outcome.runtime.target
  });
  // Derived from the evidence rather than a measured count: uninstall removes only unchanged
  // managed files, so each one must be a file of the verified pre-uninstall restore point with
  // exactly its manifest size and hash.
  const managedEntries = uninstallableManagedEntries(archived.manifest, serverPath);
  const restoredFiles = new Map(uninstallRestore.metadata.scope.entries
    .filter(entry => entry.type === 'file')
    .map(entry => [entry.path.toLocaleLowerCase('en-US'), entry]));
  for (const { entry } of managedEntries) {
    const restored = restoredFiles.get(entry.path.toLocaleLowerCase('en-US'));
    if (!restored || String(restored.size) !== entry.size || restored.sha256 !== entry.installedHash) {
      fail('completed uninstall managed path set does not match the pre-uninstall restore point');
    }
  }
  const managedFilePaths = managedEntries.map(item => item.filePath);
  for (const managedPath of managedFilePaths) await assertAbsent(managedPath, 'completed uninstall managed file');
  const sentinelPath = path.join(serverPath, ...WORLD_SENTINEL_RELATIVE.split('/'));
  await assertCanonicalFile(sentinelPath, await fsp.realpath(path.dirname(sentinelPath)), inspector, 'world sentinel', { maxBytes: 4096 });
  if (await fsp.readFile(sentinelPath, 'utf8') !== WORLD_SENTINEL_TEXT) fail('world sentinel changed');
  const operationsPath = path.join(lifecycleRoot, 'operations');
  const digests = Object.freeze({
    public: await readExactFileDigests(operationsPath, inspector, 'completed public operations'),
    lifecycle: await readExactFileDigests(historyPath, inspector, 'completed lifecycle history'),
    managed: await readExactFileDigests(managedHistoryPath, inspector, 'completed managed history'),
    backups: await readExactFileDigests(backupsPath, inspector, 'completed backups', { maxBytes: 4 * 1024 * 1024 * 1024 })
  });
  const targetIdentity = await identifyServerDirectory(serverPath, { reparseInspector: inspector });
  if (!sameIdentity(targetIdentity, uninstall.directoryIdentities.target)) fail('completed uninstall live identity changed');
  const managedModPath = path.resolve(serverPath, ...archived.manifest.entries.find(entry =>
    entry.path.startsWith('mods/') && entry.path.endsWith('.jar')).path.split('/'));
  const auditTerminalCompletion = async () => {
    await assertExactFileDigests(operationsPath, inspector, digests.public, 'completed public operations');
    await assertExactFileDigests(historyPath, inspector, digests.lifecycle, 'completed lifecycle history');
    await assertExactFileDigests(managedHistoryPath, inspector, digests.managed, 'completed managed history');
    await assertExactFileDigests(backupsPath, inspector, digests.backups, 'completed backups', {
      maxBytes: 4 * 1024 * 1024 * 1024
    });
    if ((await fsp.readdir(activePath)).length !== 0 || (await fsp.readdir(workspacesPath)).length !== 0) {
      fail('completed management topology changed before cleanup');
    }
    for (const managedPath of managedFilePaths) await assertAbsent(managedPath, 'completed uninstall managed file');
    if (await fsp.readFile(sentinelPath, 'utf8') !== WORLD_SENTINEL_TEXT) fail('world sentinel changed');
    assertNoLifecycleProcesses(root);
    return Object.freeze({ state, managedModPath, managedFilePaths: Object.freeze([...managedFilePaths]),
      rollbackOperationId: retry.jobId, uninstallOperationId: uninstall.jobId });
  };
  const [serverPort, managementPort] = await reserveDistinctPorts();
  return createGuardedManagementLifecycle({ root, userDataPath, serverPath, clientPath, evidencePath,
    instanceId: retryJob.serverId, serverPort, managementPort, recovery: {
      jobId: uninstall.jobId, phase: uninstall.phase, swapStep: uninstall.swapStep,
      ...createExistingSiblingPaths(serverPath, uninstall.jobId)
    }, checkpoint: Object.freeze({ initialVersionId: state.source.versionId, rollbackRevision: 8,
      completionRevisionFloor: 8, worldSentinelPath: sentinelPath, worldSentinelText: WORLD_SENTINEL_TEXT,
      initialManagedModPath: managedModPath, initialManagedFilePaths: Object.freeze([...managedFilePaths]) }),
    activePath, rootDirectoryIdentity, inspector, continuationMode: 'post-uninstall-completed',
    requiresRecovery: false, rollbackCompleted: true, detachCompleted: true, managementCompleted: true,
    auditTerminalCompletion });
}

async function loadPostRecoveryPlanStaleLifecycle({
  root,
  userDataPath,
  serverPath,
  clientPath,
  evidencePath,
  lifecycleRoot,
  activePath,
  rootDirectoryIdentity,
  inspector
}) {
  await assertRootTopology(root, ['user-data', 'server', 'client', 'evidence', 'real-lifecycle-identity.json'], inspector);
  const workspacesPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'workspaces'), lifecycleRoot, inspector);
  if ((await fsp.readdir(workspacesPath)).length !== 0) fail('post-recovery workspaces must be empty');
  const operationsPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'operations'), lifecycleRoot, inspector);
  const operationNames = (await fsp.readdir(operationsPath)).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (operationNames.length < 2 || operationNames.some(name => !JOB_ID_PATTERN.test(name.replace(/\.json$/u, '')) ||
      !name.endsWith('.json'))) fail('post-recovery public operation topology is invalid');
  const jobs = [];
  for (const name of operationNames) {
    jobs.push(verifyPublicOperation(
      await readCanonicalJson(path.join(operationsPath, name), operationsPath, inspector, 'public operation', {
        maxBytes: 2 * 1024 * 1024
      }),
      'public operation'
    ));
  }
  const rollbackJobs = jobs.filter(job => job.operationKind === 'rollback-restore-point');
  if (rollbackJobs.length === 7) {
    return loadPostUninstallCompleted({
      root, userDataPath, serverPath, clientPath, evidencePath, lifecycleRoot, activePath,
      rootDirectoryIdentity, inspector, jobs, rollbackJobs
    });
  }
  if (rollbackJobs.length === 6) {
    return loadPostDetachRestoreFailed({
      root,
      userDataPath,
      serverPath,
      clientPath,
      evidencePath,
      lifecycleRoot,
      activePath,
      rootDirectoryIdentity,
      inspector,
      jobs,
      rollbackJobs
    });
  }
  if (rollbackJobs.length === 5) {
    const completedJobs = rollbackJobs.filter(isExactCompletedRollbackJob);
    if (completedJobs.length !== 1) fail('completed rollback checkpoint is missing or ambiguous');
    return loadPostRollbackCompleted({
      root,
      userDataPath,
      serverPath,
      clientPath,
      evidencePath,
      lifecycleRoot,
      activePath,
      rootDirectoryIdentity,
      inspector,
      rollbackJobs,
      completedRollbackJob: completedJobs[0]
    });
  }
  if (rollbackJobs.length === 4) {
    return loadPostRecoveryTerminalLineage({
      root,
      userDataPath,
      serverPath,
      clientPath,
      evidencePath,
      lifecycleRoot,
      activePath,
      rootDirectoryIdentity,
      inspector,
      rollbackJobs
    });
  }
  const originalMatches = rollbackJobs.filter(job => job.outcome?.errorCode === 'COMMIT_FAILED' &&
    job.outcome?.message === 'The operation failed before the server changed' && job.outcome?.cleanupPending === false &&
    job.progress?.percent === 43 && job.progress?.message === 'Restoring the selected verified server snapshot');
  const staleMatches = rollbackJobs.filter(job => job.outcome?.errorCode === 'PLAN_STALE' &&
    job.outcome?.message === 'The operation failed before the server changed' && job.outcome?.cleanupPending === false &&
    job.progress?.percent === 5 && job.progress?.message === 'Revalidating the reviewed plan');
  if (rollbackJobs.length !== 2 || originalMatches.length !== 1 || staleMatches.length !== 1 ||
      originalMatches[0].jobId === staleMatches[0].jobId) {
    fail('post-recovery checkpoint does not contain the exact original and fresh failed rollback jobs');
  }
  const originalJob = originalMatches[0];
  const failedRollbackJob = staleMatches[0];
  if (originalJob.serverId !== failedRollbackJob.serverId ||
      Date.parse(failedRollbackJob.createdAt) <= Date.parse(originalJob.createdAt) ||
      Date.parse(failedRollbackJob.updatedAt) !== Date.parse(failedRollbackJob.terminalAt) ||
      Date.parse(failedRollbackJob.updatedAt) <= Date.parse(failedRollbackJob.createdAt) ||
      JSON.stringify(failedRollbackJob.outcome.actions?.map(action => action?.actionId)) !==
        JSON.stringify(['change-selection', 'open-details'])) {
    fail('fresh failed rollback job is not the exact terminal preflight failure');
  }

  const recoveryHistoryPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'history'), lifecycleRoot, inspector);
  const recoveryHistoryNames = (await fsp.readdir(recoveryHistoryPath)).sort((left, right) =>
    left.localeCompare(right, 'en-US'));
  const recoveryHistoryPairs = new Map();
  for (const name of recoveryHistoryNames) {
    const target = name.endsWith('.target.json');
    const suffix = target ? '.target.json' : '.json';
    if (!name.endsWith(suffix)) fail('durable recovery history topology is invalid');
    const jobId = name.slice(0, -suffix.length);
    if (!JOB_ID_PATTERN.test(jobId)) fail('durable recovery history topology is invalid');
    const pair = recoveryHistoryPairs.get(jobId) || new Set();
    pair.add(target ? 'target' : 'record');
    recoveryHistoryPairs.set(jobId, pair);
  }
  if (recoveryHistoryPairs.size === 0 || [...recoveryHistoryPairs.values()].some(pair =>
    pair.size !== 2 || !pair.has('record') || !pair.has('target'))) {
    fail('durable recovery history topology is invalid');
  }
  const rawHistorical = await readCanonicalJson(
    path.join(recoveryHistoryPath, `${originalJob.jobId}.json`), recoveryHistoryPath, inspector,
    'historical recovery record'
  );
  let recovery;
  try { recovery = normalizeRecord(rawHistorical); }
  catch (error) { fail('historical recovery record is invalid', error); }
  let envelope;
  try {
    envelope = verifyRecoveryTargetEnvelope(await readCanonicalJson(
      path.join(recoveryHistoryPath, `${originalJob.jobId}.target.json`), recoveryHistoryPath, inspector,
      'historical recovery envelope'
    ));
  } catch (error) {
    fail('historical recovery envelope is invalid', error);
  }
  if (JSON.stringify(envelope) !== JSON.stringify(createRecoveryTargetEnvelope(rawHistorical))) {
    fail('historical recovery envelope does not bind the recovered target');
  }
  await Promise.all([
    assertAbsent(path.join(recoveryHistoryPath, `${failedRollbackJob.jobId}.json`), 'fresh rollback recovery history'),
    assertAbsent(path.join(recoveryHistoryPath, `${failedRollbackJob.jobId}.target.json`), 'fresh rollback recovery envelope')
  ]);
  if (recovery.jobId !== originalJob.jobId || recovery.operationKind !== 'rollback' || recovery.phase !== 'failed' ||
      recovery.swapStep !== 'none' || recovery.target.kind !== 'existing' ||
      recovery.target.stableServerId !== originalJob.serverId || recovery.restoreCreation !== null ||
      recovery.priorRuntime.running !== false || recovery.priorRuntime.autoRestart !== false ||
      !sameIdentity(recovery.directoryIdentities.target, recovery.directoryIdentities.rollback) ||
      !recovery.directoryIdentities.candidate || recovery.directoryIdentities.failed !== null ||
      recovery.outcome?.revision?.source !== 3 || recovery.outcome?.revision?.target !== 4 ||
      recovery.outcome?.candidateCleanup?.deletionAuthorized !== true ||
      recovery.outcome.candidateCleanup.slot !== 'candidate' ||
      recovery.outcome.candidateCleanup.action !== 'pre-swap-restored' ||
      recovery.outcome.candidateCleanup.ownershipMode !== 'recorded-identity' ||
      !sameIdentity(recovery.outcome.candidateCleanup.directoryIdentity, recovery.directoryIdentities.candidate) ||
      !SHA256_PATTERN.test(recovery.outcome.candidateCleanup.fingerprint) ||
      recovery.outcome?.recovery?.action !== 'pre-swap-restored' ||
      recovery.outcome.recovery.operationId !== recovery.jobId) {
    fail('historical recovery record is not the exact terminal pre-swap restoration');
  }
  if (!Number.isFinite(Date.parse(recovery.updatedAt)) ||
      Date.parse(failedRollbackJob.createdAt) <= Date.parse(recovery.updatedAt)) {
    fail('fresh failed rollback job must follow terminal recovery');
  }
  if (!pathsEqual(recovery.target.path, serverPath)) fail('historical recovery target is outside the validated server');
  const expectedPaths = createExistingSiblingPaths(serverPath, recovery.jobId);
  for (const key of ['candidatePath', 'rollbackPath', 'failedPath']) {
    if (!pathsEqual(recovery[key], expectedPaths[key])) fail(`historical recovery ${key} is not the exact operation sibling`);
    await assertAbsent(expectedPaths[key], `historical recovery ${key}`);
  }
  const freshPaths = createExistingSiblingPaths(serverPath, failedRollbackJob.jobId);
  await Promise.all(['candidatePath', 'rollbackPath', 'failedPath'].map(key =>
    assertAbsent(freshPaths[key], `fresh failed rollback ${key}`)));
  for (const jobId of [recovery.jobId, failedRollbackJob.jobId]) {
    await assertAbsent(path.join(serverPath, '.minecraft-core-state', 'operations', jobId), 'server operation workspace');
  }

  const configPath = await assertCanonicalDirectory(path.join(userDataPath, 'config'), userDataPath, inspector);
  const config = await readCanonicalJson(
    path.join(configPath, 'minecraft-core-config.json'), configPath, inspector, 'saved instance configuration'
  );
  if (!Array.isArray(config.instances) || config.instances.length !== 1 ||
      config.instances[0]?.type !== 'server' || config.instances[0].id !== recovery.target.stableServerId ||
      !pathsEqual(config.instances[0].path, serverPath) || typeof config.lastServerPath !== 'string' ||
      !pathsEqual(config.lastServerPath, serverPath)) {
    fail('saved post-recovery instance does not bind the validated disposable server');
  }
  const coordinator = await readCanonicalJson(
    path.join(serverPath, '.minecraft-core.json'), serverPath, inspector, 'server content revision', { maxBytes: 1024 * 1024 }
  );
  if (coordinator.contentRevision !== recovery.outcome.revision.target) {
    fail('server content coordinator revision does not match recovered durable evidence');
  }
  const current = await readManagedState(serverPath, inspector, {
    expectedVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[1].id,
    expectedRevision: recovery.outcome.revision.source,
    expectedRuntime: recovery.outcome.runtime?.source
  });
  if (coordinator.contentRevision !== current.state.contentRevision + 1) {
    fail('post-recovery managed state and coordinator revisions are not the exact preserved checkpoint');
  }
  const targetIdentity = await identifyServerDirectory(serverPath, { reparseInspector: inspector });
  if (!sameIdentity(targetIdentity, recovery.directoryIdentities.target)) {
    fail('post-recovery live server directory identity changed');
  }
  const { history, upgrade } = await readUpgradeCheckpoint(serverPath, current, inspector);
  if (JSON.stringify(upgrade.sourceRuntime) !== JSON.stringify(recovery.outcome.runtime?.target)) {
    fail('post-recovery rollback target runtime differs from completed upgrade history');
  }
  const backupsPath = await assertCanonicalDirectory(path.join(serverPath, 'backups'), serverPath, inspector);
  const selectedRestore = await readRestoreMetadata(backupsPath, upgrade.restorePointId, inspector);
  if (selectedRestore.metadata.sha256 !== upgrade.restorePointSha256 ||
      selectedRestore.metadata.sourceRevision !== upgrade.sourceRevision ||
      JSON.stringify(selectedRestore.metadata.sourceRuntime) !== JSON.stringify(upgrade.sourceRuntime) ||
      selectedRestore.metadata.operationId !== upgrade.operationId ||
      !selectedRestore.metadata.pins.includes(upgrade.operationId) ||
      String(selectedRestore.metadata.scope.totalBytes) !== upgrade.restorePointTotalBytes) {
    fail('post-recovery selected restore metadata does not match completed upgrade history');
  }
  const safetyRestore = await readRestoreMetadata(backupsPath, recovery.restorePoint?.id, inspector);
  if (safetyRestore.metadata.sha256 !== recovery.restorePoint.sha256 ||
      safetyRestore.metadata.sourceRevision !== current.state.contentRevision ||
      JSON.stringify(safetyRestore.metadata.sourceRuntime) !== JSON.stringify(current.state.runtime) ||
      safetyRestore.metadata.operationId !== recovery.jobId || !safetyRestore.metadata.pins.includes(recovery.jobId)) {
    fail('post-recovery safety restore does not match terminal recovery history');
  }
  const [serverPort, managementPort] = await reserveDistinctPorts();
  const checkpoint = Object.freeze({
    currentVersionId: current.state.source.versionId,
    initialVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id,
    sourceRevision: current.state.contentRevision,
    coordinatorRevision: coordinator.contentRevision,
    rollbackRevision: coordinator.contentRevision + 1,
    currentRuntime: Object.freeze({ ...current.state.runtime }),
    initialRuntime: Object.freeze({ ...upgrade.sourceRuntime }),
    targetDirectoryIdentity: Object.freeze({ ...targetIdentity }),
    preRecoveryFingerprint: recovery.outcome.live.fingerprint,
    upgradeRestorePointId: upgrade.restorePointId,
    upgradeRestorePointSha256: upgrade.restorePointSha256,
    safetyRestorePointId: recovery.restorePoint.id,
    safetyRestorePointSha256: recovery.restorePoint.sha256,
    worldSentinelPath: current.sentinelPath,
    worldSentinelText: WORLD_SENTINEL_TEXT,
    currentManagedModPath: current.managedPath,
    initialManagedModPath: null,
    initialManagedFilePaths: Object.freeze([]),
    restoreScope: Object.freeze({
      fileCount: selectedRestore.metadata.scope.fileCount,
      totalBytes: selectedRestore.metadata.scope.totalBytes,
      entryCount: selectedRestore.metadata.scope.entries.length,
      scopeSha256: selectedRestore.metadata.scope.scopeSha256,
      mismatches: 0
    }),
    movedRestorePayloadNames: Object.freeze([]),
    historyCount: history.length
  });
  return createGuardedManagementLifecycle({
    root,
    userDataPath,
    serverPath,
    clientPath,
    evidencePath,
    instanceId: recovery.target.stableServerId,
    serverPort,
    managementPort,
    recovery: {
      jobId: recovery.jobId,
      phase: recovery.phase,
      swapStep: recovery.swapStep,
      candidatePath: expectedPaths.candidatePath,
      rollbackPath: expectedPaths.rollbackPath,
      failedPath: expectedPaths.failedPath,
      failedRollbackJobId: failedRollbackJob.jobId
    },
    checkpoint,
    activePath,
    rootDirectoryIdentity,
    inspector,
    continuationMode: 'post-recovery-plan-stale',
    requiresRecovery: false
  });
}

async function loadPreservedRealManagementLifecycle(rootValue, { reparseInspector = null } = {}) {
  const lease = inspectorLease(reparseInspector);
  try {
    const requestedRoot = assertScratchLocation(rootValue);
    const temporaryDirectory = await fsp.realpath(path.resolve(os.tmpdir()));
    const root = await assertCanonicalDirectory(requestedRoot, temporaryDirectory, lease.inspector);
    if (!pathsEqual(root, requestedRoot)) fail('root resolves outside the exact management continuation area');
    const rootDirectoryIdentity = strictIdentity(
      await identifyServerDirectory(root, { reparseInspector: lease.inspector }),
      'root'
    );
    const userDataPath = await assertCanonicalDirectory(path.join(root, 'user-data'), root, lease.inspector);
    const serverPath = await assertCanonicalDirectory(path.join(root, 'server'), root, lease.inspector);
    const clientPath = await assertCanonicalDirectory(path.join(root, 'client'), root, lease.inspector);
    const evidencePath = await assertCanonicalDirectory(path.join(root, 'evidence'), root, lease.inspector);
    const identity = await readCanonicalJson(
      path.join(root, 'real-lifecycle-identity.json'), root, lease.inspector, 'identity file', { maxBytes: 4096 }
    );
    if (!matchesManagementIdentity(identity)) fail('identity does not match the management lifecycle harness');

    const lifecycleRoot = await assertCanonicalDirectory(path.join(userDataPath, 'modpack-lifecycle'), userDataPath, lease.inspector);
    const activePath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'active'), lifecycleRoot, lease.inspector);
    const activeNames = (await fsp.readdir(activePath)).sort();
    if (activeNames.length === 0) {
      return await loadPostRecoveryPlanStaleLifecycle({
        root,
        userDataPath,
        serverPath,
        clientPath,
        evidencePath,
        lifecycleRoot,
        activePath,
        rootDirectoryIdentity,
        inspector: lease.inspector
      });
    }
    const recordNames = activeNames.filter(name => JOB_ID_PATTERN.test(name.replace(/\.json$/u, '')) && !name.endsWith('.target.json'));
    if (recordNames.length !== 1 || activeNames.length !== 2) fail('must contain exactly one active recovery record and envelope');
    const rawRecord = await readCanonicalJson(path.join(activePath, recordNames[0]), activePath, lease.inspector, 'active recovery record');
    let recovery;
    try { recovery = normalizeRecord(rawRecord); }
    catch (error) { fail('active recovery record is invalid', error); }
    if (recovery.operationKind !== 'rollback' || recovery.phase !== 'validating-candidate' || recovery.swapStep !== 'none' ||
        recovery.target.kind !== 'existing' || recovery.restoreCreation !== null || recovery.directoryIdentities.rollback !== null ||
        recovery.directoryIdentities.failed !== null || !recovery.directoryIdentities.target || !recovery.directoryIdentities.candidate) {
      fail('active recovery is not the exact pre-swap rollback checkpoint');
    }
    const postRecoveryActive = recovery.outcome?.revision?.source === 3 &&
      recovery.outcome?.revision?.target === 5;
    const originalPreRecovery = recovery.outcome?.revision?.source === 3 &&
      recovery.outcome?.revision?.target === 4;
    if (!originalPreRecovery && !postRecoveryActive) {
      fail('active recovery revision is not an approved preserved checkpoint');
    }
    if (!pathsEqual(recovery.target.path, serverPath)) fail('active recovery target is outside the validated server');
    const expectedPaths = createExistingSiblingPaths(serverPath, recovery.jobId);
    for (const key of ['candidatePath', 'rollbackPath', 'failedPath']) {
      if (!pathsEqual(recovery[key], expectedPaths[key])) fail(`active recovery ${key} is not the exact operation sibling`);
    }
    await assertAbsent(expectedPaths.rollbackPath, 'rollback sibling');
    await assertAbsent(expectedPaths.failedPath, 'failed sibling');
    const candidatePath = await assertCanonicalDirectory(expectedPaths.candidatePath, root, lease.inspector);
    await assertRootTopology(root, [
      'user-data', 'server', 'client', 'evidence', 'real-lifecycle-identity.json', path.basename(candidatePath)
    ], lease.inspector);

    const configPath = await assertCanonicalDirectory(path.join(userDataPath, 'config'), userDataPath, lease.inspector);
    const config = await readCanonicalJson(
      path.join(configPath, 'minecraft-core-config.json'), configPath, lease.inspector, 'saved instance configuration'
    );
    if (!Array.isArray(config.instances) || config.instances.length !== 1) fail('must contain exactly one saved disposable instance');
    const instance = config.instances[0];
    if (instance?.type !== 'server' || instance.id !== recovery.target.stableServerId || !pathsEqual(instance.path, serverPath) ||
        (config.lastServerPath !== null && (typeof config.lastServerPath !== 'string' || !pathsEqual(config.lastServerPath, serverPath)))) {
      fail('saved instance points outside the validated disposable server');
    }
    if (postRecoveryActive && (typeof config.lastServerPath !== 'string' || !pathsEqual(config.lastServerPath, serverPath))) {
      fail('post-recovery active saved instance is not selected');
    }

    const envelopeName = `${recovery.jobId}.target.json`;
    if (!activeNames.includes(envelopeName)) fail('active recovery envelope is missing');
    let envelope;
    try {
      envelope = verifyRecoveryTargetEnvelope(await readCanonicalJson(
        path.join(activePath, envelopeName), activePath, lease.inspector, 'active recovery envelope'
      ));
    } catch (error) {
      fail('active recovery envelope is invalid', error);
    }
    const expectedEnvelope = createRecoveryTargetEnvelope(rawRecord);
    if (JSON.stringify(envelope) !== JSON.stringify(expectedEnvelope)) fail('active recovery envelope does not bind the exact target');

    const operationsPath = await assertCanonicalDirectory(path.join(lifecycleRoot, 'operations'), lifecycleRoot, lease.inspector);
    const publicJob = verifyPublicOperation(await readCanonicalJson(
      path.join(operationsPath, `${recovery.jobId}.json`), operationsPath, lease.inspector, 'terminal public operation'
    ), 'terminal public operation');
    if (publicJob.jobId !== recovery.jobId || publicJob.serverId !== recovery.target.stableServerId ||
        publicJob.operationKind !== 'rollback-restore-point' || publicJob.phase !== 'failed' || publicJob.terminalAt === null ||
        publicJob.outcome?.status !== 'failed' || publicJob.outcome?.errorCode !== 'COMMIT_FAILED' ||
        publicJob.outcome?.cleanupPending !== false || publicJob.outcome?.message !== 'The operation failed before the server changed') {
      fail('terminal public operation does not prove a pre-swap failure');
    }
    const activeLineage = postRecoveryActive
      ? await validatePostRecoveryActiveLineage({
          lifecycleRoot,
          serverPath,
          recovery,
          publicJob,
          inspector: lease.inspector
        })
      : null;

    const operationWorkspace = await assertCanonicalDirectory(
      path.join(candidatePath, '.minecraft-core-state', 'operations', recovery.jobId),
      path.join(candidatePath, '.minecraft-core-state', 'operations'),
      lease.inspector
    );
    if (postRecoveryActive) {
      await assertPostRecoveryActiveCandidateTopology(
        candidatePath,
        operationWorkspace,
        recovery.jobId,
        lease.inspector
      );
    }
    const marker = verifyDirectoryMarker(await readCanonicalJson(
      path.join(operationWorkspace, 'directory-marker.json'), operationWorkspace, lease.inspector, 'candidate marker'
    ), { jobId: recovery.jobId, stableInstanceId: recovery.target.stableServerId });
    if (marker.operationKind !== 'rollback') fail('candidate marker operation kind is invalid');
    let journal;
    try { journal = operationJournalReader().load(path.join(operationWorkspace, 'journal.json')); }
    catch (error) { fail('candidate journal is invalid', error); }
    if (journal.jobId !== recovery.jobId || journal.operationKind !== 'rollback' || journal.phase !== recovery.phase ||
        journal.swapStep !== recovery.swapStep || journal.stableInstanceId !== recovery.target.stableServerId ||
        journal.targetPathHash !== envelope.targetPathHash || journal.markerSha256 !== marker.checksum ||
        !sameIdentity(journal.targetIdentity, recovery.directoryIdentities.target) ||
        !sameIdentity(journal.candidateIdentity, recovery.directoryIdentities.candidate) ||
        journal.rollbackIdentity !== null || journal.failedIdentity !== null || journal.candidateFingerprint !== null) {
      fail('candidate journal does not match the active pre-swap recovery');
    }

    const [targetInspection, candidateInspection] = await Promise.all([
      inspectServerDirectoryTree(serverPath, { reparseInspector: lease.inspector }),
      inspectServerDirectoryTree(candidatePath, { reparseInspector: lease.inspector })
    ]);
    strictIdentity(recovery.directoryIdentities.target, 'target');
    strictIdentity(recovery.directoryIdentities.candidate, 'candidate');
    if (!sameIdentity(targetInspection.directoryIdentity, recovery.directoryIdentities.target) ||
        targetInspection.fingerprint !== recovery.outcome?.live?.fingerprint) {
      fail('live server identity or fingerprint differs from the durable pre-swap record');
    }
    if (!sameIdentity(candidateInspection.directoryIdentity, recovery.directoryIdentities.candidate)) {
      fail('candidate identity differs from the durable pre-swap record');
    }
    if (recovery.outcome?.revision?.source !== 3 || ![4, 5].includes(recovery.outcome?.revision?.target) ||
        recovery.outcome?.runtimePolicy?.targetRunning !== false || recovery.outcome?.runtimePolicy?.targetAutoRestart !== false ||
        recovery.outcome?.runtimePolicy?.targetInactive !== false || recovery.priorRuntime.running !== false ||
        recovery.priorRuntime.autoRestart !== false) fail('active recovery runtime or revision policy is not the exact stopped checkpoint');
    const currentRuntime = assertRuntime(recovery.outcome?.runtime?.source, 'active source');
    const initialRuntime = assertRuntime(recovery.outcome?.runtime?.target, 'active target');

    const current = await readManagedState(serverPath, lease.inspector, {
      expectedVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[1].id,
      expectedRevision: 3,
      expectedRuntime: currentRuntime
    });
    const { history, upgrade } = await readUpgradeCheckpoint(serverPath, current, lease.inspector);
    if (JSON.stringify(upgrade.sourceRuntime) !== JSON.stringify(initialRuntime)) {
      fail('rollback target runtime differs from the completed upgrade source');
    }
    const backupsPath = await assertCanonicalDirectory(path.join(serverPath, 'backups'), serverPath, lease.inspector);
    const selectedRestore = await readRestoreMetadata(backupsPath, upgrade.restorePointId, lease.inspector);
    if (selectedRestore.metadata.sha256 !== upgrade.restorePointSha256 ||
        selectedRestore.metadata.sourceRevision !== upgrade.sourceRevision ||
        JSON.stringify(selectedRestore.metadata.sourceRuntime) !== JSON.stringify(upgrade.sourceRuntime) ||
        selectedRestore.metadata.operationId !== upgrade.operationId ||
        !selectedRestore.metadata.pins.includes(upgrade.operationId) ||
        String(selectedRestore.metadata.scope.totalBytes) !== upgrade.restorePointTotalBytes) {
      fail('selected restore metadata does not match completed upgrade history');
    }
    const safetyRestore = await readRestoreMetadata(backupsPath, recovery.restorePoint?.id, lease.inspector);
    if (safetyRestore.metadata.sha256 !== recovery.restorePoint.sha256 ||
        safetyRestore.metadata.sourceRevision !== (activeLineage?.coordinatorRevision ?? current.state.contentRevision) ||
        JSON.stringify(safetyRestore.metadata.sourceRuntime) !== JSON.stringify(current.state.runtime) ||
        safetyRestore.metadata.operationId !== recovery.jobId || !safetyRestore.metadata.pins.includes(recovery.jobId)) {
      fail('rollback safety restore does not match the active recovery record');
    }
    const selectedRestorePath = await assertCanonicalDirectory(
      path.join(operationWorkspace, 'selected-restore'), operationWorkspace, lease.inspector
    );
    const initial = await readManagedState(selectedRestorePath, lease.inspector, {
      expectedVersionId: realHarness.REAL_MODRINTH_LIFECYCLE.versions[0].id,
      expectedRevision: upgrade.sourceRevision,
      expectedRuntime: upgrade.sourceRuntime,
      requireSentinel: false
    });
    const initialManagedModPath = path.resolve(serverPath, ...initial.managedEntry.path.split('/'));
    if (!comparablePath(initialManagedModPath).startsWith(`${comparablePath(serverPath)}${path.sep}`)) {
      fail('rollback managed mod resolves outside the validated server');
    }
    const initialManagedFilePaths = uninstallableManagedPaths(initial.manifest, serverPath);
    if (!initialManagedFilePaths.some(filePath => pathsEqual(filePath, initialManagedModPath))) {
      fail('rollback managed mod is not an uninstallable audited manifest entry');
    }
    const restoreScope = compareRestorePayload(candidatePath, selectedRestorePath, selectedRestore.metadata);
    if (postRecoveryActive && (JSON.stringify(restoreScope.movedRestorePayloadNames) !== JSON.stringify(['.fabric']) ||
        restoreScope.movedFileCount !== 77)) {
      fail('post-recovery active candidate does not contain the exact 77-file moved .fabric payload');
    }
    const [serverPort, managementPort] = await reserveDistinctPorts();
    const checkpoint = Object.freeze({
      currentVersionId: current.state.source.versionId,
      initialVersionId: initial.state.source.versionId,
      sourceRevision: current.state.contentRevision,
      coordinatorRevision: activeLineage?.coordinatorRevision,
      rollbackRevision: recovery.outcome.revision.target,
      currentRuntime: Object.freeze({ ...current.state.runtime }),
      initialRuntime: Object.freeze({ ...initial.state.runtime }),
      targetDirectoryIdentity: Object.freeze({ ...targetInspection.directoryIdentity }),
      preRecoveryFingerprint: targetInspection.fingerprint,
      upgradeRestorePointId: upgrade.restorePointId,
      upgradeRestorePointSha256: upgrade.restorePointSha256,
      safetyRestorePointId: recovery.restorePoint.id,
      safetyRestorePointSha256: recovery.restorePoint.sha256,
      worldSentinelPath: current.sentinelPath,
      worldSentinelText: WORLD_SENTINEL_TEXT,
      currentManagedModPath: current.managedPath,
      initialManagedModPath,
      initialManagedFilePaths: Object.freeze([...initialManagedFilePaths]),
      restoreScope: Object.freeze({ ...restoreScope }),
      movedRestorePayloadNames: Object.freeze([...restoreScope.movedRestorePayloadNames]),
      historyCount: history.length
    });
    return createGuardedManagementLifecycle({
      root,
      userDataPath,
      serverPath,
      clientPath,
      evidencePath,
      instanceId: recovery.target.stableServerId,
      serverPort,
      managementPort,
      recovery: {
        jobId: recovery.jobId,
        phase: recovery.phase,
        swapStep: recovery.swapStep,
        candidatePath,
        rollbackPath: expectedPaths.rollbackPath,
        failedPath: expectedPaths.failedPath,
        historicalRecoveryJobId: activeLineage?.historicalRecoveryJobId,
        failedRollbackJobId: activeLineage?.staleRollbackJobId
      },
      checkpoint,
      activePath,
      rootDirectoryIdentity,
      inspector: lease.inspector,
      continuationMode: postRecoveryActive ? 'post-recovery-active' : 'pre-recovery',
      requiresRecovery: true
    });
  } finally {
    lease.close();
  }
}

async function auditRecoveredManagementLifecycle(lifecycle, { reparseInspector = null } = {}) {
  if (!lifecycle || typeof lifecycle.root !== 'string' || typeof lifecycle.serverPath !== 'string' ||
      typeof lifecycle.instanceId !== 'string' || !lifecycle.checkpoint || !lifecycle.recovery) {
    fail('recovered audit requires a validated management lifecycle');
  }
  const lease = inspectorLease(reparseInspector);
  try {
    const root = assertScratchLocation(lifecycle.root);
    await assertCanonicalDirectory(root, await fsp.realpath(os.tmpdir()), lease.inspector);
    await assertRootTopology(root, ['user-data', 'server', 'client', 'evidence', 'real-lifecycle-identity.json'], lease.inspector);
    await Promise.all([
      assertAbsent(lifecycle.recovery.candidatePath, 'candidate sibling'),
      assertAbsent(lifecycle.recovery.rollbackPath, 'rollback sibling'),
      assertAbsent(lifecycle.recovery.failedPath, 'failed sibling')
    ]);
    const activePath = path.join(lifecycle.userDataPath, 'modpack-lifecycle', 'active');
    if ((await fsp.readdir(activePath)).length !== 0) fail('recovered lifecycle still has active recovery records');
    const currentIdentity = await identifyServerDirectory(lifecycle.serverPath, { reparseInspector: lease.inspector });
    if (!sameIdentity(currentIdentity, lifecycle.checkpoint.targetDirectoryIdentity)) {
      fail('recovered live server directory identity changed before the new rollback');
    }
    const current = await readManagedState(lifecycle.serverPath, lease.inspector, {
      expectedVersionId: lifecycle.checkpoint.currentVersionId,
      expectedRevision: lifecycle.checkpoint.sourceRevision,
      expectedRuntime: lifecycle.checkpoint.currentRuntime
    });
    const { history, upgrade } = await readUpgradeCheckpoint(lifecycle.serverPath, current, lease.inspector);
    if (upgrade.restorePointId !== lifecycle.checkpoint.upgradeRestorePointId ||
        upgrade.restorePointSha256 !== lifecycle.checkpoint.upgradeRestorePointSha256 ||
        history.length !== lifecycle.checkpoint.historyCount) fail('recovered lifecycle history changed before the new rollback');
    const backupsPath = await assertCanonicalDirectory(path.join(lifecycle.serverPath, 'backups'), lifecycle.serverPath, lease.inspector);
    const selected = await readRestoreMetadata(backupsPath, lifecycle.checkpoint.upgradeRestorePointId, lease.inspector);
    const safety = await readRestoreMetadata(backupsPath, lifecycle.checkpoint.safetyRestorePointId, lease.inspector);
    if (selected.metadata.sha256 !== lifecycle.checkpoint.upgradeRestorePointSha256 ||
        safety.metadata.sha256 !== lifecycle.checkpoint.safetyRestorePointSha256) fail('recovered restore archive evidence changed');
    const inspection = await inspectServerDirectoryTree(lifecycle.serverPath, { reparseInspector: lease.inspector });
    return Object.freeze({
      directoryIdentity: inspection.directoryIdentity,
      fingerprint: inspection.fingerprint,
      state: current.state,
      managedModPath: current.managedPath,
      worldSentinelPath: current.sentinelPath,
      upgradeRestorePointId: upgrade.restorePointId
    });
  } finally {
    lease.close();
  }
}

module.exports = {
  MANAGEMENT_CONTINUATION_ROOT_ENV,
  MANAGEMENT_ENABLE_ENV,
  WORLD_SENTINEL_TEXT,
  assertNoLifecycleProcesses,
  auditRecoveredManagementLifecycle,
  getPreservedManagementRoot,
  isPreservedManagementContinuationEnabled,
  loadPreservedRealManagementLifecycle
};
