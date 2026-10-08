const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { createDurableFs } = require('../../../electron/utils/durable-fs.cjs');
const { WindowsDurableFsClient } = require('../../../electron/utils/windows-durable-fs-client.cjs');
const {
  createRecoveryTargetEnvelope,
  verifyRecoveryTargetEnvelope
} = require('../../../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');
const { normalizeRecord: normalizeRecoveryRecord } = require('../../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const {
  createExistingSiblingPaths
} = require('../../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const { resolveBundledArchiveRuntimePaths } = require('../../../electron/services/modpacks/archive/archive-engine-paths.cjs');
const { WindowsReparseInspector } = require('../../../electron/services/modpacks/local/windows-reparse-inspector.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SCRATCH_PREFIX = 'minecraft-core-real-modrinth-crash-recovery-e2e-';
const CHECKPOINT_NAME = 'hard-crash-checkpoint.json';
const MARKER_NAME = 'hard-crash-fired.json';
const CHECKPOINT_TYPE = 'minecraft-core-real-modpack-crash-recovery';
const IDENTITY = Object.freeze({ provider: 'modrinth', scenario: 'hard-crash-recovery' });
const CHECKPOINT_KEYS = Object.freeze([
  'type', 'schemaVersion', 'stage', 'identity', 'rootIdentity', 'topology', 'network', 'instance', 'versions',
  'lease', 'operation', 'initialState', 'createdAt', 'checksum'
]);
const PUBLIC_OPERATION_KEYS = Object.freeze([
  'type', 'schemaVersion', 'sequence', 'jobId', 'operationKind', 'serverId', 'planFingerprint', 'phase', 'swapStep',
  'progress', 'cancellationRequested', 'createdAt', 'updatedAt', 'terminalAt', 'outcome', 'events', 'checksum'
]);
const JOB_ID_PATTERN = /^(?:job-[A-Za-z0-9_-]{1,123}|op2-[0-9a-f]{32})$/u;
const LEGACY_JOB_ID_PATTERN = /^job-[A-Za-z0-9_-]{1,123}$/u;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 200_000;
const pendingContinuationLeases = new Map();

function fail(message, cause = null) {
  return new Error(`The real crash-recovery harness ${message}`, cause ? { cause } : undefined);
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()));
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string' && comparablePath(left) === comparablePath(right);
}

function assertScratchRoot(rootValue, tempRootValue = os.tmpdir()) {
  if (typeof rootValue !== 'string' || rootValue.trim() === '' ||
      typeof tempRootValue !== 'string' || tempRootValue.trim() === '') throw fail('scratch root is invalid');
  const tempRoot = path.resolve(tempRootValue);
  const root = path.resolve(rootValue);
  const basename = path.basename(root);
  if (!samePath(path.dirname(root), tempRoot) || !basename.startsWith(SCRATCH_PREFIX) ||
      basename.length === SCRATCH_PREFIX.length || !/^[A-Za-z0-9_-]+$/u.test(basename.slice(SCRATCH_PREFIX.length))) {
    throw fail('scratch root is outside the exact disposable crash-recovery namespace');
  }
  return root;
}

function resolvePathInsideScratchRoot(rootValue, candidateValue, tempRootValue = os.tmpdir()) {
  if (typeof candidateValue !== 'string' || candidateValue.trim() === '') {
    throw fail('refuses to inspect an invalid disposable lifecycle path');
  }
  const root = assertScratchRoot(rootValue, tempRootValue);
  const resolved = path.resolve(candidateValue);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw fail('refuses to inspect a path outside the disposable lifecycle root');
  }
  return resolved;
}

function statIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs ?? BigInt(Math.trunc(Number(stat.birthtimeMs) * 1_000_000)))
  });
}

function sameIdentity(left, right) {
  return Boolean(exactKeys(left, ['dev', 'ino', 'birthtimeNs']) && exactKeys(right, ['dev', 'ino', 'birthtimeNs']) &&
    left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs);
}

function samePinnedFileStat(left, right) {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() &&
    String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino) &&
    String(left.birthtimeNs ?? left.birthtimeMs) === String(right.birthtimeNs ?? right.birthtimeMs) &&
    String(left.mtimeNs ?? left.mtimeMs) === String(right.mtimeNs ?? right.mtimeMs) &&
    String(left.ctimeNs ?? left.ctimeMs) === String(right.ctimeNs ?? right.ctimeMs) &&
    String(left.size) === String(right.size) && String(left.nlink) === String(right.nlink);
}

function checksumFor(value, keys) {
  const payload = Object.fromEntries(keys.filter(key => key !== 'checksum').map(key => [key, value[key]]));
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function secureChecksum(actual, expected) {
  if (typeof actual !== 'string' || !SHA256_PATTERN.test(actual) || !SHA256_PATTERN.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function strictJsonClone(value) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    throw fail('checkpoint state is not bounded JSON');
  }
  const cloned = JSON.parse(encoded);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) throw fail('checkpoint state is invalid');
  return cloned;
}

function inspectorLease(reparseInspector) {
  if (reparseInspector !== null && reparseInspector !== undefined) {
    if (typeof reparseInspector.isReparsePoint !== 'function') throw fail('reparse inspector is invalid');
    return { inspector: reparseInspector, owned: false };
  }
  return { inspector: new WindowsReparseInspector(), owned: true };
}

async function assertNotReparse(candidate, inspector) {
  let redirected;
  try { redirected = await inspector.isReparsePoint(candidate); }
  catch (error) { throw fail('could not verify filesystem redirection', error); }
  if (redirected !== false) throw fail('found a symbolic link, junction, or reparse redirect');
}

async function assertCanonicalDirectory(directoryPath, expectedParent, inspector) {
  const stat = await fsp.lstat(directoryPath, { bigint: true }).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw fail('contains a missing or redirected directory');
  await assertNotReparse(directoryPath, inspector);
  const real = await fsp.realpath(directoryPath);
  if (!samePath(real, directoryPath) || (expectedParent && !samePath(path.dirname(real), expectedParent))) {
    throw fail('contains a directory outside its exact root');
  }
  return { path: path.resolve(real), stat, identity: statIdentity(stat) };
}

async function assertCanonicalFile(filePath, expectedParent, inspector, label, maxBytes = MAX_JSON_BYTES) {
  const stat = await fsp.lstat(filePath, { bigint: true }).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1 || Number(stat.size) > maxBytes) {
    throw fail(`${label} is missing, linked, redirected, or oversized`);
  }
  await assertNotReparse(filePath, inspector);
  const real = await fsp.realpath(filePath);
  if (!samePath(real, filePath) || !samePath(path.dirname(real), expectedParent)) {
    throw fail(`${label} is outside its exact directory`);
  }
  return { path: path.resolve(real), stat };
}

async function readCanonicalJson(filePath, expectedParent, inspector, label, maxBytes = MAX_JSON_BYTES) {
  const pinned = await assertCanonicalFile(filePath, expectedParent, inspector, label, maxBytes);
  let bytes;
  try { bytes = await fsp.readFile(pinned.path); }
  catch (error) { throw fail(`${label} could not be read`, error); }
  if (bytes.length > maxBytes) throw fail(`${label} is oversized`);
  const afterStat = await fsp.lstat(pinned.path, { bigint: true });
  if (!samePinnedFileStat(pinned.stat, afterStat) || Number(afterStat.size) !== bytes.length) {
    throw fail(`${label} changed while it was read`);
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw fail(`${label} is not valid JSON`, error); }
}

function matchesIdentity(value) {
  return exactKeys(value, ['provider', 'scenario']) && value.provider === IDENTITY.provider &&
    value.scenario === IDENTITY.scenario;
}

function validateInitialState(value, initialVersionId, instanceId) {
  if (!exactKeys(value, [
    'type', 'instanceId', 'modpackManaged', 'lifecycleMode', 'source', 'runtime', 'selectedOptionalFiles',
    'installedAt', 'contentRevision', 'managedFileCount'
  ]) || value.type !== 'modpack-state' || value.instanceId !== instanceId || value.modpackManaged !== true ||
      value.lifecycleMode !== 'managed' || value.source?.provider !== 'modrinth' ||
      value.source.projectId !== 'ca0m6gMz' || value.source.versionId !== initialVersionId ||
      typeof value.source.version !== 'string' || typeof value.source.title !== 'string' ||
      value.runtime?.minecraftVersion !== '1.20.1' || value.runtime.loaderFamily !== 'fabric' ||
      !Array.isArray(value.selectedOptionalFiles) ||
      value.selectedOptionalFiles.some(item => typeof item !== 'string') ||
      typeof value.installedAt !== 'string' || !ISO_TIMESTAMP.test(value.installedAt) ||
      !Number.isSafeInteger(value.contentRevision) || value.contentRevision < 1 ||
      typeof value.managedFileCount !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value.managedFileCount)) {
    throw fail('checkpoint initial state is not the exact approved Modrinth installation');
  }
  return strictJsonClone(value);
}

function persistedStateMatchesPublic(persisted, publicState) {
  return Boolean(persisted && typeof persisted === 'object' && !Array.isArray(persisted) &&
    persisted.schemaVersion === 1 && persisted.modpackManaged === true &&
    persisted.source?.provider === publicState.source.provider &&
    persisted.source.projectId === publicState.source.projectId &&
    persisted.source.versionId === publicState.source.versionId &&
    persisted.source.version === publicState.source.version && persisted.source.title === publicState.source.title &&
    isDeepStrictEqual(persisted.runtime, publicState.runtime) &&
    isDeepStrictEqual(persisted.selectedOptionalFiles, publicState.selectedOptionalFiles) &&
    persisted.installedAt === publicState.installedAt && persisted.contentRevision === publicState.contentRevision &&
    typeof persisted.manifestId === 'string' && persisted.manifestId.length > 0);
}

function validateCandidateState(value, checkpoint) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 ||
      value.modpackManaged !== true || value.source?.provider !== 'modrinth' ||
      value.source.projectId !== checkpoint.initialState.source.projectId ||
      value.source.versionId !== checkpoint.versions.updateVersionId ||
      value.runtime?.minecraftVersion !== '1.20.1' || value.runtime.loaderFamily !== 'fabric' ||
      value.contentRevision !== checkpoint.initialState.contentRevision + 1 ||
      typeof value.manifestId !== 'string' || value.manifestId.length < 1) {
    throw fail('candidate state is not the exact checkpointed update');
  }
  return value;
}

function validateCheckpoint(value) {
  if (!exactKeys(value, CHECKPOINT_KEYS) || value.type !== CHECKPOINT_TYPE || value.schemaVersion !== 1 ||
      value.stage !== 'armed' || !matchesIdentity(value.identity) ||
      !exactKeys(value.rootIdentity, ['dev', 'ino', 'birthtimeNs']) ||
      Object.values(value.rootIdentity).some(item => typeof item !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(item)) ||
      !exactKeys(value.topology, ['userData', 'server', 'client', 'evidence', 'identity', 'checkpoint', 'marker']) ||
      JSON.stringify(value.topology) !== JSON.stringify({
        userData: 'user-data', server: 'server', client: 'client', evidence: 'evidence',
        identity: 'real-lifecycle-identity.json', checkpoint: `evidence/${CHECKPOINT_NAME}`, marker: `evidence/${MARKER_NAME}`
      }) || !exactKeys(value.network, ['host', 'serverPort', 'managementPort']) ||
      value.network.host !== '127.0.0.1' || !Number.isSafeInteger(value.network.serverPort) ||
      !Number.isSafeInteger(value.network.managementPort) || value.network.serverPort < 1024 ||
      value.network.serverPort > 65535 || value.network.managementPort < 1024 ||
      value.network.managementPort > 65535 || value.network.serverPort === value.network.managementPort ||
      !exactKeys(value.instance, ['id']) || !INSTANCE_ID_PATTERN.test(value.instance.id) ||
      !exactKeys(value.versions, ['initialVersionId', 'updateVersionId']) ||
      !VERSION_ID_PATTERN.test(value.versions.initialVersionId) || !VERSION_ID_PATTERN.test(value.versions.updateVersionId) ||
      value.versions.initialVersionId === value.versions.updateVersionId ||
      !exactKeys(value.lease, ['kind', 'id']) || value.lease.kind !== 'process-bound-local-endpoint-v1' ||
      typeof value.lease.id !== 'string' || !SHA256_PATTERN.test(value.lease.id) ||
      !exactKeys(value.operation, ['kind', 'planFingerprint']) || value.operation.kind !== 'update' ||
      typeof value.operation.planFingerprint !== 'string' || !SHA256_PATTERN.test(value.operation.planFingerprint) ||
      typeof value.createdAt !== 'string' || !ISO_TIMESTAMP.test(value.createdAt) ||
      new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw fail('checkpoint schema or identity is invalid');
  }
  if (!secureChecksum(value.checksum, checksumFor(value, CHECKPOINT_KEYS))) throw fail('checkpoint checksum is invalid');
  validateInitialState(value.initialState, value.versions.initialVersionId, value.instance.id);
  return value;
}

function validatePublicOperation(value, { jobId, serverId, terminal }) {
  if (!exactKeys(value, PUBLIC_OPERATION_KEYS) || value.type !== 'minecraft-core-modpack-job' ||
      value.schemaVersion !== 1 || value.jobId !== jobId || value.serverId !== serverId ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.operationKind !== 'string' ||
      typeof value.phase !== 'string' || typeof value.cancellationRequested !== 'boolean' ||
      !Array.isArray(value.events) || !secureChecksum(value.checksum, checksumFor(value, PUBLIC_OPERATION_KEYS))) {
    throw fail('public operation checkpoint is invalid');
  }
  if (terminal === false && (value.operationKind !== 'update' || value.phase !== 'committing' ||
      value.terminalAt !== null || value.outcome !== null || value.cancellationRequested !== false)) {
    throw fail('public operation is not the exact interrupted update');
  }
  if (terminal === true && (value.operationKind !== 'install-new' || value.phase !== 'failed' ||
      typeof value.terminalAt !== 'string' || value.outcome?.status !== 'failed' ||
      value.outcome?.errorCode !== 'COMMIT_FAILED' ||
      value.outcome?.message !== 'The operation failed before the server changed')) {
    throw fail('legacy public operation is not the exact abandoned install');
  }
  return value;
}

function commandLineContainsRoot(commandLine, root) {
  const command = String(commandLine || '').replaceAll('/', '\\').toLocaleLowerCase('en-US');
  const needle = path.resolve(root).replaceAll('/', '\\').toLocaleLowerCase('en-US');
  return command.includes(needle);
}

function listLifecycleProcesses() {
  if (process.platform !== 'win32') return [];
  const command = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(java|javaw|electron)\\.exe$" } | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress';
  const result = childProcess.spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: false });
  if (result.error || result.signal || result.status !== 0 || String(result.stderr || '').trim() !== '') {
    throw fail('could not audit Electron and Java processes');
  }
  const output = String(result.stdout || '').trim();
  if (!output) return [];
  let parsed;
  try { parsed = JSON.parse(output); }
  catch (error) { throw fail('received an invalid Electron and Java process inventory', error); }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function assertNoRootBoundProcesses(root, { processes = null } = {}) {
  const inventory = processes === null ? listLifecycleProcesses() : processes;
  if (!Array.isArray(inventory)) throw fail('Electron and Java process inventory is invalid');
  const matching = inventory.filter(item => /^(?:java|javaw|electron)(?:\.exe)?$/iu.test(String(item?.Name ?? item?.name ?? '')) &&
    commandLineContainsRoot(item?.CommandLine ?? item?.commandLine, root));
  if (matching.length !== 0) throw fail('found a root-bound Electron or Java process');
  return Object.freeze([...inventory]);
}

function continuationLeaseEndpoint(leaseId) {
  if (typeof leaseId !== 'string' || !SHA256_PATTERN.test(leaseId)) {
    throw fail('continuation lease identity is invalid');
  }
  const name = `minecraft-core-real-modpack-crash-${leaseId}`;
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (process.platform === 'linux') return `\0${name}`;
  return path.join(os.tmpdir(), `${name}.sock`);
}

const continuationLeaseEndpoints = new WeakMap();

function listenOnContinuationEndpoint(leaseId) {
  return new Promise((resolve, reject) => {
    const endpoint = continuationLeaseEndpoint(leaseId);
    const listener = net.createServer(socket => socket.destroy());
    listener.unref();
    const onError = error => reject(error);
    listener.once('error', onError);
    listener.listen({ path: endpoint, exclusive: true }, () => {
      listener.removeListener('error', onError);
      continuationLeaseEndpoints.set(listener, endpoint);
      resolve(listener);
    });
  });
}

async function closeContinuationLease(listener) {
  if (!listener) return;
  const endpoint = continuationLeaseEndpoints.get(listener);
  try {
    if (listener.listening) {
      await new Promise((resolve, reject) => {
        listener.close(error => error ? reject(error) : resolve());
      });
    }
  } finally {
    continuationLeaseEndpoints.delete(listener);
    if (endpoint && process.platform !== 'win32' && !endpoint.startsWith('\0')) {
      await fsp.rm(endpoint, { force: true }).catch(() => {});
    }
  }
}

async function acquireContinuationLease(leaseId) {
  try {
    return await listenOnContinuationEndpoint(leaseId);
  } catch (error) {
    throw fail('continuation lease is already held or unavailable', error);
  }
}

function createContinuationLeaseId(rootIdentity) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(rootIdentity), 'utf8')
    .update(crypto.randomBytes(32))
    .digest('hex');
}

async function releasePendingCrashRecoveryLease(rootValue, { tempRoot = os.tmpdir() } = {}) {
  const root = assertScratchRoot(rootValue, tempRoot);
  const key = comparablePath(root);
  const pending = pendingContinuationLeases.get(key);
  if (!pending) return false;
  pendingContinuationLeases.delete(key);
  await closeContinuationLease(pending.listener);
  return true;
}

function createDefaultDurableFs(lifecycle) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw fail('durable crash checkpoint requires Windows x64');
  const runtime = resolveBundledArchiveRuntimePaths({ runtimeRoot: PROJECT_ROOT, arch: process.arch, isPackaged: false });
  const appOwnedRoot = path.join(lifecycle.evidencePath, 'checkpoint-durability');
  fs.mkdirSync(appOwnedRoot, { recursive: true });
  const durableClient = new WindowsDurableFsClient({
    workerPath: runtime.workerPath,
    workerManifestPath: runtime.workerManifestPath,
    allowedRoots: [lifecycle.root],
    appOwnedRoot
  });
  return createDurableFs({ durableClient, allowedRoots: [lifecycle.root] });
}

async function writeCrashRecoveryCheckpoint(lifecycle, {
  instanceId,
  initialState,
  initialVersionId,
  updateVersionId,
  planFingerprint
} = {}, {
  tempRoot = os.tmpdir(),
  clock = () => new Date(),
  durableFs = null,
  reparseInspector = null,
  createLeaseId = createContinuationLeaseId
} = {}) {
  const root = assertScratchRoot(lifecycle?.root, tempRoot);
  if (!samePath(lifecycle?.userDataPath, path.join(root, 'user-data')) ||
      !samePath(lifecycle?.serverPath, path.join(root, 'server')) ||
      !samePath(lifecycle?.clientPath, path.join(root, 'client')) ||
      !samePath(lifecycle?.evidencePath, path.join(root, 'evidence')) ||
      !samePath(lifecycle?.identityPath, path.join(root, 'real-lifecycle-identity.json')) ||
      lifecycle.serverHost !== '127.0.0.1' || !INSTANCE_ID_PATTERN.test(instanceId || '') ||
      !VERSION_ID_PATTERN.test(initialVersionId || '') || !VERSION_ID_PATTERN.test(updateVersionId || '') ||
      initialVersionId === updateVersionId || !SHA256_PATTERN.test(planFingerprint || '') ||
      typeof createLeaseId !== 'function') {
    throw fail('checkpoint request does not describe one exact lifecycle');
  }
  const lease = inspectorLease(reparseInspector);
  let checkpointLease = null;
  let checkpointLeaseRetained = false;
  try {
    const rootDirectory = await assertCanonicalDirectory(root, tempRoot, lease.inspector);
    const [userData, server, client, evidence] = await Promise.all([
      assertCanonicalDirectory(lifecycle.userDataPath, root, lease.inspector),
      assertCanonicalDirectory(lifecycle.serverPath, root, lease.inspector),
      assertCanonicalDirectory(lifecycle.clientPath, root, lease.inspector),
      assertCanonicalDirectory(lifecycle.evidencePath, root, lease.inspector)
    ]);
    void userData; void server; void client;
    const expectedRootEntries = ['client', 'evidence', 'real-lifecycle-identity.json', 'server', 'user-data'].sort();
    if (JSON.stringify(await readDirectoryNames(root)) !== JSON.stringify(expectedRootEntries)) {
      throw fail('pre-crash root topology is not exact');
    }
    const identity = await readCanonicalJson(lifecycle.identityPath, root, lease.inspector, 'lifecycle identity', 4096);
    if (!matchesIdentity(identity)) throw fail('lifecycle identity does not match the hard-crash scenario');
    const checkpointPath = path.join(evidence.path, CHECKPOINT_NAME);
    const markerPath = path.join(evidence.path, MARKER_NAME);
    if (fs.existsSync(checkpointPath) || fs.existsSync(markerPath)) throw fail('checkpoint already exists');
    const createdAt = clock().toISOString();
    if (!ISO_TIMESTAMP.test(createdAt)) throw fail('checkpoint clock is invalid');
    let leaseId;
    try {
      leaseId = createLeaseId(rootDirectory.identity);
      if (typeof leaseId !== 'string' || !SHA256_PATTERN.test(leaseId)) {
        throw fail('generated continuation lease identity is invalid');
      }
      checkpointLease = await acquireContinuationLease(leaseId);
    } catch (error) {
      throw fail('could not acquire the continuation lease identity', error);
    }
    const checkpoint = {
      type: CHECKPOINT_TYPE,
      schemaVersion: 1,
      stage: 'armed',
      identity: { ...IDENTITY },
      rootIdentity: { ...rootDirectory.identity },
      topology: {
        userData: 'user-data', server: 'server', client: 'client', evidence: 'evidence',
        identity: 'real-lifecycle-identity.json', checkpoint: `evidence/${CHECKPOINT_NAME}`, marker: `evidence/${MARKER_NAME}`
      },
      network: {
        host: lifecycle.serverHost,
        serverPort: lifecycle.serverPort,
        managementPort: lifecycle.managementPort
      },
      instance: { id: instanceId },
      versions: { initialVersionId, updateVersionId },
      lease: { kind: 'process-bound-local-endpoint-v1', id: leaseId },
      operation: { kind: 'update', planFingerprint },
      initialState: validateInitialState(initialState, initialVersionId, instanceId),
      createdAt,
      checksum: ''
    };
    validateCheckpoint({ ...checkpoint, checksum: checksumFor(checkpoint, CHECKPOINT_KEYS) });
    checkpoint.checksum = checksumFor(checkpoint, CHECKPOINT_KEYS);
    const writer = durableFs ?? createDefaultDurableFs(lifecycle);
    if (!writer || typeof writer.writeJsonAtomic !== 'function') throw fail('durable checkpoint writer is invalid');
    const identitySha256 = crypto.createHash('sha256').update(fs.readFileSync(lifecycle.identityPath)).digest('hex');
    await writer.writeJsonAtomic(lifecycle.identityPath, { ...IDENTITY }, {
      expectedTargetSha256: identitySha256
    });
    await writer.writeJsonAtomic(markerPath, { fired: false, rollbackName: null }, {
      expectedTargetSha256: null
    });
    await writer.writeJsonAtomic(checkpointPath, checkpoint, { expectedTargetSha256: null });
    const pendingKey = comparablePath(root);
    if (pendingContinuationLeases.has(pendingKey)) throw fail('continuation lease is already retained for this root');
    pendingContinuationLeases.set(pendingKey, { id: leaseId, listener: checkpointLease });
    checkpointLeaseRetained = true;
    return Object.freeze(strictJsonClone(checkpoint));
  } finally {
    try {
      if (!checkpointLeaseRetained) await closeContinuationLease(checkpointLease);
    } finally {
      if (lease.owned) lease.inspector.close();
    }
  }
}

async function readDirectoryNames(directoryPath) {
  return (await fsp.readdir(directoryPath)).sort();
}

async function readPersistedModpackState(serverDirectory, inspector, label) {
  const stateRoot = path.join(serverDirectory, '.minecraft-core-state');
  const stateDirectory = await assertCanonicalDirectory(stateRoot, serverDirectory, inspector);
  return readCanonicalJson(
    path.join(stateRoot, 'modpack.json'), stateDirectory.path, inspector, `${label} managed state`
  );
}

async function loadCrashRecoveryContinuation(rootValue, {
  tempRoot = os.tmpdir(),
  processes = null,
  reparseInspector = null
} = {}) {
  const root = assertScratchRoot(rootValue, tempRoot);
  assertNoRootBoundProcesses(root, { processes });
  const lease = inspectorLease(reparseInspector);
  let continuationLease = null;
  let continuationLeaseTransferred = false;
  try {
    const rootDirectory = await assertCanonicalDirectory(root, tempRoot, lease.inspector);
    const userDataPath = path.join(root, 'user-data');
    const serverPath = path.join(root, 'server');
    const clientPath = path.join(root, 'client');
    const evidencePath = path.join(root, 'evidence');
    const identityPath = path.join(root, 'real-lifecycle-identity.json');
    const checkpointPath = path.join(evidencePath, CHECKPOINT_NAME);
    const markerPath = path.join(evidencePath, MARKER_NAME);
    const [userData, client, evidence] = await Promise.all([
      assertCanonicalDirectory(userDataPath, root, lease.inspector),
      assertCanonicalDirectory(clientPath, root, lease.inspector),
      assertCanonicalDirectory(evidencePath, root, lease.inspector)
    ]);
    void client;
    const identity = await readCanonicalJson(identityPath, root, lease.inspector, 'lifecycle identity', 4096);
    if (!matchesIdentity(identity)) throw fail('lifecycle identity does not match the checkpoint');
    const checkpoint = validateCheckpoint(await readCanonicalJson(
      checkpointPath, evidence.path, lease.inspector, 'hard-crash checkpoint'
    ));
    if (!sameIdentity(checkpoint.rootIdentity, rootDirectory.identity)) throw fail('checkpoint root identity does not match');
    const pendingKey = comparablePath(root);
    const pendingLease = pendingContinuationLeases.get(pendingKey);
    if (pendingLease) {
      if (pendingLease.id !== checkpoint.lease.id || !pendingLease.listener?.listening) {
        throw fail('retained continuation lease does not match the durable checkpoint');
      }
      pendingContinuationLeases.delete(pendingKey);
      continuationLease = pendingLease.listener;
    } else {
      continuationLease = await acquireContinuationLease(checkpoint.lease.id);
    }
    const marker = await readCanonicalJson(markerPath, evidence.path, lease.inspector, 'hard-crash marker', 4096);
    if (!exactKeys(marker, ['fired', 'rollbackName']) || marker.fired !== true ||
        typeof marker.rollbackName !== 'string') throw fail('hard-crash marker is invalid');
    const compactMatch = /^\.(op2-[0-9a-f]{32})\.r$/u.exec(marker.rollbackName);
    const legacyMatch = /^\.server\.minecraft-core\.(job-[A-Za-z0-9_-]{1,123})\.rollback$/u.exec(marker.rollbackName);
    const jobId = compactMatch?.[1] || legacyMatch?.[1] || '';
    if (!JOB_ID_PATTERN.test(jobId)) throw fail('hard-crash marker does not name one exact rollback');
    const expectedPaths = createExistingSiblingPaths(serverPath, jobId);
    const candidatePath = expectedPaths.candidatePath;
    const rollbackPath = expectedPaths.rollbackPath;
    const failedPath = expectedPaths.failedPath;
    if (path.basename(rollbackPath) !== marker.rollbackName) {
      throw fail('hard-crash marker does not match the operation rollback path');
    }
    const expectedRootEntries = [
      path.basename(candidatePath), path.basename(rollbackPath), 'client', 'evidence',
      'real-lifecycle-identity.json', 'user-data'
    ].sort();
    if (JSON.stringify(await readDirectoryNames(root)) !== JSON.stringify(expectedRootEntries)) {
      throw fail('post-crash root topology is not exact');
    }
    if (fs.existsSync(serverPath) || fs.existsSync(failedPath) ||
        !fs.existsSync(candidatePath) || !fs.existsSync(rollbackPath)) {
      throw fail('post-crash canonical topology is not preserved');
    }
    await Promise.all([
      assertCanonicalDirectory(candidatePath, root, lease.inspector),
      assertCanonicalDirectory(rollbackPath, root, lease.inspector)
    ]);
    const initialState = validateInitialState(
      checkpoint.initialState, checkpoint.versions.initialVersionId, checkpoint.instance.id
    );
    const [rollbackState, candidateState] = await Promise.all([
      readPersistedModpackState(rollbackPath, lease.inspector, 'rollback'),
      readPersistedModpackState(candidatePath, lease.inspector, 'candidate')
    ]);
    if (!persistedStateMatchesPublic(rollbackState, initialState)) {
      throw fail('rollback state does not match the checkpointed initial server');
    }
    validateCandidateState(candidateState, checkpoint);

    const activePath = path.join(userData.path, 'modpack-lifecycle', 'active');
    const lifecycleRoot = path.dirname(activePath);
    await assertCanonicalDirectory(lifecycleRoot, userData.path, lease.inspector);
    await assertCanonicalDirectory(activePath, lifecycleRoot, lease.inspector);
    const expectedActive = [`${jobId}.json`, `${jobId}.target.json`].sort();
    if (JSON.stringify(await readDirectoryNames(activePath)) !== JSON.stringify(expectedActive)) {
      throw fail('active recovery lineage is missing or ambiguous');
    }
    const recovery = normalizeRecoveryRecord(await readCanonicalJson(
      path.join(activePath, `${jobId}.json`), activePath, lease.inspector, 'active recovery record'
    ));
    if (recovery.jobId !== jobId || recovery.operationKind !== 'upgrade' || recovery.target.kind !== 'existing' ||
        recovery.target.stableServerId !== checkpoint.instance.id || !samePath(recovery.target.path, serverPath) ||
        !samePath(recovery.candidatePath, candidatePath) || !samePath(recovery.rollbackPath, rollbackPath) ||
        !samePath(recovery.failedPath, failedPath) || recovery.phase !== 'committing' || recovery.swapStep !== 'prepared' ||
        recovery.priorRuntime.running !== false || recovery.priorRuntime.autoRestart !== false ||
        recovery.restorePoint === null || recovery.directoryIdentities.target === null ||
        recovery.directoryIdentities.candidate === null || recovery.directoryIdentities.rollback !== null ||
        recovery.directoryIdentities.failed !== null ||
        recovery.outcome?.revision?.source !== initialState.contentRevision ||
        recovery.outcome?.revision?.target !== candidateState.contentRevision) {
      throw fail('active recovery is not the exact prepared update checkpoint');
    }
    const envelope = verifyRecoveryTargetEnvelope(await readCanonicalJson(
      path.join(activePath, `${jobId}.target.json`), activePath, lease.inspector, 'active recovery envelope'
    ));
    if (JSON.stringify(envelope) !== JSON.stringify(createRecoveryTargetEnvelope(recovery))) {
      throw fail('active recovery envelope does not match the interrupted update');
    }

    const operationsPath = path.join(lifecycleRoot, 'operations');
    await assertCanonicalDirectory(operationsPath, lifecycleRoot, lease.inspector);
    const operation = validatePublicOperation(await readCanonicalJson(
      path.join(operationsPath, `${jobId}.json`), operationsPath, lease.inspector, 'public update operation'
    ), { jobId, serverId: checkpoint.instance.id, terminal: false });
    if (operation.planFingerprint !== checkpoint.operation.planFingerprint) {
      throw fail('public update operation does not match the checkpointed reviewed plan');
    }
    assertNoRootBoundProcesses(root, { processes });
    const capturedRootIdentity = { ...rootDirectory.identity };
    let disposed = false;
    const releaseContinuationLease = async () => {
      if (continuationLease === null) return;
      const ownedLease = continuationLease;
      continuationLease = null;
      await closeContinuationLease(ownedLease);
    };
    const lifecycle = {
      root,
      scratchLabel: 'modrinth-crash-recovery',
      userDataPath,
      serverPath,
      clientPath,
      evidencePath,
      identityPath,
      serverHost: checkpoint.network.host,
      serverPort: checkpoint.network.serverPort,
      managementPort: checkpoint.network.managementPort,
      instanceId: checkpoint.instance.id,
      crashedJobId: jobId,
      initialState: Object.freeze(initialState),
      checkpoint: Object.freeze(strictJsonClone(checkpoint)),
      resumed: true,
      async dispose({ preserveRoot = true } = {}) {
        if (disposed) return;
        disposed = true;
        try {
          if (preserveRoot) {
            console.error(`[real-modpack-e2e] preserving crash-recovery scratch root: ${root}`);
            return;
          }
          assertNoRootBoundProcesses(root);
          const stat = await fsp.lstat(assertScratchRoot(root, tempRoot), { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(capturedRootIdentity, statIdentity(stat)) ||
              !samePath(await fsp.realpath(root), root)) throw fail('refusing to delete a changed continuation root');
          await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
          if (fs.existsSync(root)) throw fail('continuation root deletion was not confirmed');
        } finally {
          await releaseContinuationLease();
        }
      }
    };
    continuationLeaseTransferred = true;
    return Object.freeze(lifecycle);
  } finally {
    try {
      if (!continuationLeaseTransferred) await closeContinuationLease(continuationLease);
    } finally {
      if (lease.owned) lease.inspector.close();
    }
  }
}

async function assertTreeHasNoRedirects(root, inspector) {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) throw fail('legacy topology contains a symbolic link');
    if (stat.isDirectory()) {
      await assertNotReparse(current, inspector);
      if (!samePath(await fsp.realpath(current), current)) throw fail('legacy topology contains a redirected directory');
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) pending.push(path.join(current, entry.name));
    } else if (!stat.isFile()) {
      throw fail('legacy topology contains an unsupported filesystem object');
    }
    visited += 1;
    if (visited > MAX_TREE_ENTRIES) throw fail('legacy topology is too large to delete safely');
  }
}

async function auditLegacyRoot(root, { tempRoot, processes, inspector, inspectTree }) {
  const processInventory = assertNoRootBoundProcesses(root, { processes });
  if (processInventory.some(item => /^(?:electron)(?:\.exe)?$/iu.test(String(item?.Name ?? item?.name ?? '')))) {
    throw fail('legacy root predates the auditable Electron root tag while an Electron process is active');
  }
  const rootDirectory = await assertCanonicalDirectory(root, tempRoot, inspector);
  const entries = await readDirectoryNames(root);
  const candidates = entries.filter(name => /^\.server\.minecraft-core\.job-[A-Za-z0-9_-]{1,123}\.candidate$/u.test(name));
  const expectedStatic = ['client', 'evidence', 'real-lifecycle-identity.json', 'user-data'];
  if (candidates.length !== 1 || JSON.stringify(entries) !== JSON.stringify([...expectedStatic, candidates[0]].sort())) {
    throw fail('legacy topology is not the exact known abandoned root');
  }
  const jobId = candidates[0].slice('.server.minecraft-core.'.length, -'.candidate'.length);
  if (!LEGACY_JOB_ID_PATTERN.test(jobId)) throw fail('legacy topology job identity is invalid');
  const userDataPath = path.join(root, 'user-data');
  const clientPath = path.join(root, 'client');
  const evidencePath = path.join(root, 'evidence');
  const candidatePath = path.join(root, candidates[0]);
  const serverPath = path.join(root, 'server');
  const failedPath = path.join(root, `.server.minecraft-core.${jobId}.failed`);
  if (fs.existsSync(serverPath) || fs.existsSync(failedPath)) throw fail('legacy topology contains an unexpected canonical or failed server');
  const [userData, , , candidate] = await Promise.all([
    assertCanonicalDirectory(userDataPath, root, inspector),
    assertCanonicalDirectory(clientPath, root, inspector),
    assertCanonicalDirectory(evidencePath, root, inspector),
    assertCanonicalDirectory(candidatePath, root, inspector)
  ]);
  const identity = await readCanonicalJson(
    path.join(root, 'real-lifecycle-identity.json'), root, inspector, 'legacy lifecycle identity', 4096
  );
  if (!matchesIdentity(identity)) throw fail('legacy lifecycle identity is mismatched');
  const lifecycleRoot = path.join(userData.path, 'modpack-lifecycle');
  const activePath = path.join(lifecycleRoot, 'active');
  const operationsPath = path.join(lifecycleRoot, 'operations');
  await Promise.all([
    assertCanonicalDirectory(lifecycleRoot, userData.path, inspector),
    assertCanonicalDirectory(activePath, lifecycleRoot, inspector),
    assertCanonicalDirectory(operationsPath, lifecycleRoot, inspector)
  ]);
  if (JSON.stringify(await readDirectoryNames(activePath)) !==
      JSON.stringify([`${jobId}.json`, `${jobId}.target.json`].sort())) {
    throw fail('legacy active recovery topology is not exact');
  }
  if (JSON.stringify(await readDirectoryNames(operationsPath)) !== JSON.stringify([`${jobId}.json`])) {
    throw fail('legacy public operation topology is not exact');
  }
  const recovery = normalizeRecoveryRecord(await readCanonicalJson(
    path.join(activePath, `${jobId}.json`), activePath, inspector, 'legacy active recovery'
  ));
  if (recovery.schemaVersion !== 2 || recovery.jobId !== jobId || recovery.operationKind !== 'install' ||
      recovery.target.kind !== 'new' || !INSTANCE_ID_PATTERN.test(recovery.target.stableServerId || '') ||
      !samePath(recovery.target.path, serverPath) || !samePath(recovery.candidatePath, candidatePath) ||
      recovery.rollbackPath !== null || !samePath(recovery.failedPath, failedPath) ||
      recovery.restorePoint !== null || recovery.phase !== 'validating-candidate' || recovery.swapStep !== 'none' ||
      recovery.directoryIdentities.target !== null || recovery.directoryIdentities.candidate === null ||
      recovery.directoryIdentities.rollback !== null || recovery.directoryIdentities.failed !== null) {
    throw fail('legacy recovery is not the exact abandoned install checkpoint');
  }
  const envelope = verifyRecoveryTargetEnvelope(await readCanonicalJson(
    path.join(activePath, `${jobId}.target.json`), activePath, inspector, 'legacy recovery envelope'
  ));
  if (JSON.stringify(envelope) !== JSON.stringify(createRecoveryTargetEnvelope(recovery))) {
    throw fail('legacy recovery envelope is mismatched');
  }
  validatePublicOperation(await readCanonicalJson(
    path.join(operationsPath, `${jobId}.json`), operationsPath, inspector, 'legacy public operation'
  ), { jobId, serverId: recovery.target.stableServerId, terminal: true });
  if (inspectTree) await assertTreeHasNoRedirects(root, inspector);
  return { rootIdentity: rootDirectory.identity, candidateIdentity: candidate.identity, jobId };
}

async function matchingScratchRoots(tempRootValue) {
  const tempRoot = path.resolve(tempRootValue);
  const entries = await fsp.readdir(tempRoot, { withFileTypes: true });
  return entries.filter(entry => entry.name.startsWith(SCRATCH_PREFIX))
    .map(entry => path.join(tempRoot, entry.name));
}

async function cleanupAbandonedCrashRecoveryRoots({
  tempRoot = os.tmpdir(),
  processes = null,
  reparseInspector = null,
  removeRoot = root => fsp.rm(root, { recursive: true, force: true, maxRetries: 3 })
} = {}) {
  if (typeof removeRoot !== 'function') throw fail('legacy root removal dependency is invalid');
  const resolvedTemp = path.resolve(tempRoot);
  const lease = inspectorLease(reparseInspector);
  const removed = [];
  const preserved = [];
  try {
    for (const candidate of await matchingScratchRoots(resolvedTemp)) {
      const root = assertScratchRoot(candidate, resolvedTemp);
      if (fs.existsSync(path.join(root, 'evidence', CHECKPOINT_NAME))) continue;
      try {
        const first = await auditLegacyRoot(root, {
          tempRoot: resolvedTemp, processes, inspector: lease.inspector, inspectTree: true
        });
        const second = await auditLegacyRoot(root, {
          tempRoot: resolvedTemp, processes, inspector: lease.inspector, inspectTree: true
        });
        if (!sameIdentity(first.rootIdentity, second.rootIdentity) ||
            !sameIdentity(first.candidateIdentity, second.candidateIdentity) || first.jobId !== second.jobId) {
          throw fail('legacy root changed before deletion');
        }
        await removeRoot(root);
        if (fs.existsSync(root)) throw fail('legacy root deletion was not confirmed');
        removed.push(root);
      } catch (error) {
        preserved.push(Object.freeze({ root, reason: error instanceof Error ? error.message : 'legacy audit failed' }));
      }
    }
    return Object.freeze({ removed: Object.freeze(removed), preserved: Object.freeze(preserved) });
  } finally {
    if (lease.owned) lease.inspector.close();
  }
}

async function discoverCrashRecoveryContinuation({
  tempRoot = os.tmpdir(),
  processes = null,
  reparseInspector = null,
  removeRoot
} = {}) {
  const resolvedTemp = path.resolve(tempRoot);
  const lease = inspectorLease(reparseInspector);
  try {
    const cleanup = await cleanupAbandonedCrashRecoveryRoots({
      tempRoot: resolvedTemp,
      processes,
      reparseInspector: lease.inspector,
      ...(removeRoot ? { removeRoot } : {})
    });
    if (cleanup.preserved.length > 0) {
      throw fail(`checkpoint is missing and ${cleanup.preserved.length} matching root was preserved: ${cleanup.preserved[0].reason}`);
    }
    const roots = await matchingScratchRoots(resolvedTemp);
    const checkpointRoots = [];
    for (const root of roots) {
      const checkpointPath = path.join(root, 'evidence', CHECKPOINT_NAME);
      if (!fs.existsSync(checkpointPath)) throw fail('checkpoint is missing from a matching crash-recovery root');
      checkpointRoots.push(root);
    }
    if (checkpointRoots.length > 1) throw fail('crash-recovery checkpoint discovery is ambiguous');
    if (checkpointRoots.length === 0) {
      return Object.freeze({ lifecycle: null, removedLegacyRoots: cleanup.removed });
    }
    const lifecycle = await loadCrashRecoveryContinuation(checkpointRoots[0], {
      tempRoot: resolvedTemp,
      processes,
      reparseInspector: lease.inspector
    });
    return Object.freeze({ lifecycle, removedLegacyRoots: cleanup.removed });
  } finally {
    if (lease.owned) lease.inspector.close();
  }
}

async function waitForApplicationClose(electronApp, timeoutMs = 20 * 60_000, {
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (!electronApp || typeof electronApp.waitForEvent !== 'function' || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new TypeError('Application-close wait request is invalid');
  }
  let timer = null;
  try {
    await Promise.race([
      electronApp.waitForEvent('close', { timeout: 0 }),
      new Promise((_, reject) => {
        timer = setTimeoutFn(
          () => reject(new Error('The armed disposable Electron process did not crash at the durable rename boundary')),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer !== null) clearTimeoutFn(timer);
  }
}

module.exports = {
  CHECKPOINT_NAME,
  IDENTITY,
  MARKER_NAME,
  SCRATCH_PREFIX,
  assertNoRootBoundProcesses,
  cleanupAbandonedCrashRecoveryRoots,
  continuationLeaseEndpoint,
  discoverCrashRecoveryContinuation,
  loadCrashRecoveryContinuation,
  releasePendingCrashRecoveryLease,
  resolvePathInsideScratchRoot,
  waitForApplicationClose,
  writeCrashRecoveryCheckpoint
};
