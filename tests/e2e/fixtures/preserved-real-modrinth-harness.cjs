const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const realHarness = require('./real-modpack-harness.cjs');
const {
  normalizeRecord
} = require('../../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const {
  OperationJournal,
  verifyDirectoryMarker
} = require('../../../electron/services/modpack-lifecycle/operation-journal.cjs');
const {
  inspectServerDirectoryTree,
  normalizeServerDirectoryPath
} = require('../../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const {
  createExistingSiblingPaths
} = require('../../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const {
  createRecoveryTargetEnvelope,
  verifyRecoveryTargetEnvelope
} = require('../../../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');

const REAL_CONTINUATION_ROOT_ENV = 'MINECRAFT_CORE_REAL_MODPACK_CONTINUATION_ROOT';
const CONTINUATION_SCRATCH_PREFIX = 'minecraft-core-real-modrinth-e2e-';
const DEFAULT_CONTINUATION_IDENTITY = Object.freeze({ harness: 'modrinth-lifecycle' });

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function getPreservedLifecycleRoot(environment = process.env) {
  const value = environment?.[REAL_CONTINUATION_ROOT_ENV];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

function isPreservedLifecycleContinuationEnabled(environment = process.env) {
  return realHarness.isRealLifecycleEnabled(environment) && getPreservedLifecycleRoot(environment) !== null;
}

function assertContinuationScratchLocation(root, {
  scratchPrefix = CONTINUATION_SCRATCH_PREFIX,
  providerLabel = 'Modrinth'
} = {}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TypeError('An explicit preserved lifecycle root is required');
  }
  const resolved = path.resolve(root.trim());
  const temporaryDirectory = path.resolve(os.tmpdir());
  if (!pathsEqual(path.dirname(resolved), temporaryDirectory)) {
    throw new Error('The preserved lifecycle root must be directly under the operating-system temporary directory');
  }
  const basename = path.basename(resolved);
  if (typeof scratchPrefix !== 'string' || !scratchPrefix.startsWith('minecraft-core-real-') || !scratchPrefix.endsWith('-')) {
    throw new TypeError('The preserved lifecycle scratch prefix is invalid');
  }
  if (!basename.startsWith(scratchPrefix) || basename.length === scratchPrefix.length) {
    throw new Error(`The preserved lifecycle root must use the exact ${providerLabel} continuation prefix`);
  }
  return resolved;
}

async function assertCanonicalDirectory(directoryPath, expectedParent = null) {
  const metadata = await fsp.lstat(directoryPath).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The preserved lifecycle contains a missing or redirected directory');
  }
  const realDirectory = await fsp.realpath(directoryPath);
  if (!pathsEqual(realDirectory, directoryPath)) {
    throw new Error('The preserved lifecycle contains a redirected directory');
  }
  if (expectedParent && !pathsEqual(path.dirname(realDirectory), expectedParent)) {
    throw new Error('The preserved lifecycle contains a directory outside its validated root');
  }
  return realDirectory;
}

async function ensureCanonicalDirectory(directoryPath, expectedParent) {
  await fsp.mkdir(directoryPath).catch(error => {
    if (error?.code !== 'EEXIST') throw error;
  });
  return assertCanonicalDirectory(directoryPath, expectedParent);
}

async function readCanonicalJson(filePath, expectedParent, label) {
  const metadata = await fsp.lstat(filePath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`The preserved lifecycle ${label} is missing or redirected`);
  }
  const realFile = await fsp.realpath(filePath);
  if (!pathsEqual(realFile, filePath) || !pathsEqual(path.dirname(realFile), expectedParent)) {
    throw new Error(`The preserved lifecycle ${label} is outside its validated directory`);
  }
  try {
    const parsed = JSON.parse(await fsp.readFile(realFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new Error(`The preserved lifecycle ${label} is invalid JSON`, { cause: error });
  }
}

async function assertPathAbsent(targetPath, label) {
  const metadata = await fsp.lstat(targetPath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata !== null) {
    throw new Error(`The preserved lifecycle ${label} must be absent`);
  }
}

function envelopesEqual(left, right) {
  const keys = ['schemaVersion', 'jobId', 'stableServerId', 'targetPathHash', 'targetLabel', 'checksum'];
  return keys.every(key => left[key] === right[key]);
}

function identitiesEqual(left, right) {
  return left?.volumeSerial === right?.volumeSerial && left?.fileId === right?.fileId;
}

function operationTargetPathHash(targetPath) {
  return crypto.createHash('sha256')
    .update(normalizeServerDirectoryPath(targetPath).normalize('NFC').toLocaleLowerCase('en-US'), 'utf8')
    .digest('hex');
}

function loadOperationJournal(journalPath) {
  const journal = new OperationJournal({
    durableFs: {
      readFileBounded(filePath, { maxBytes } = {}) {
        const bytes = fs.readFileSync(filePath);
        if (Number.isSafeInteger(maxBytes) && bytes.length > maxBytes) throw new Error('journal exceeds bound');
        return bytes;
      },
      async readFileBoundedAsync(filePath, { maxBytes } = {}) {
        const bytes = await fsp.readFile(filePath);
        if (Number.isSafeInteger(maxBytes) && bytes.length > maxBytes) throw new Error('journal exceeds bound');
        return bytes;
      },
      async writeJsonAtomicAsync() { throw new Error('read-only continuation validation'); }
    },
    fsApi: fs,
    clock: () => new Date()
  });
  return journal.load(journalPath);
}

async function loadMissingServerRecovery({ canonicalRoot, userDataPath, serverPath }) {
  const activeDirectory = await assertCanonicalDirectory(
    path.join(userDataPath, 'modpack-lifecycle', 'active'),
    path.join(userDataPath, 'modpack-lifecycle')
  );
  const entries = await fsp.readdir(activeDirectory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('The preserved lifecycle active recovery directory is ambiguous');
  }
  const recordNames = entries
    .map(entry => entry.name)
    .filter(name => /^(?:job-[A-Za-z0-9_-]{1,123}|op2-[0-9a-f]{32})\.json$/u.test(name));
  if (recordNames.length !== 1 || entries.length !== 2) {
    throw new Error('The preserved lifecycle must contain exactly one active recovery record and target envelope');
  }
  const recordName = recordNames[0];
  const jobId = recordName.slice(0, -'.json'.length);
  const envelopeName = `${jobId}.target.json`;
  if (!entries.some(entry => entry.name === envelopeName)) {
    throw new Error('The preserved lifecycle active recovery target envelope is missing');
  }

  const rawRecord = await readCanonicalJson(path.join(activeDirectory, recordName), activeDirectory, 'active recovery record');
  let record;
  try {
    record = normalizeRecord(rawRecord);
  } catch (error) {
    throw new Error('The preserved lifecycle active recovery record is invalid', { cause: error });
  }
  const expectedPaths = createExistingSiblingPaths(serverPath, jobId);
  const expectedCandidatePath = expectedPaths.candidatePath;
  const expectedRollbackPath = expectedPaths.rollbackPath;
  const expectedFailedPath = expectedPaths.failedPath;
  if (record.jobId !== jobId || record.target.kind !== 'existing' ||
      !['upgrade', 'downgrade', 'switch', 'repair', 'rollback'].includes(record.operationKind) ||
      record.phase !== 'committing' || record.swapStep !== 'prepared' ||
      !pathsEqual(record.target.path, serverPath) ||
      !pathsEqual(record.candidatePath, expectedCandidatePath) ||
      !pathsEqual(record.rollbackPath, expectedRollbackPath) ||
      !pathsEqual(record.failedPath, expectedFailedPath) ||
      record.restorePoint === null || record.directoryIdentities.target === null ||
      record.directoryIdentities.candidate === null || record.directoryIdentities.rollback !== null ||
      record.directoryIdentities.failed !== null) {
    throw new Error('The preserved lifecycle active recovery topology is not an approved between-renames commit');
  }

  const [candidatePath, rollbackPath] = await Promise.all([
    assertCanonicalDirectory(expectedCandidatePath, canonicalRoot),
    assertCanonicalDirectory(expectedRollbackPath, canonicalRoot)
  ]);
  await assertPathAbsent(expectedFailedPath, 'failed recovery sibling');

  const candidateFingerprint = record.outcome?.candidate?.fingerprint;
  const candidateMarkerSha256 = record.outcome?.candidate?.markerSha256;
  const rollbackFingerprint = record.outcome?.live?.fingerprint;
  if (typeof candidateFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(candidateFingerprint) ||
      typeof candidateMarkerSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(candidateMarkerSha256) ||
      typeof rollbackFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(rollbackFingerprint)) {
    throw new Error('The preserved lifecycle recovery record lacks exact directory fingerprints');
  }

  const operationRoot = await assertCanonicalDirectory(
    path.join(candidatePath, '.minecraft-core-state', 'operations', jobId),
    path.join(candidatePath, '.minecraft-core-state', 'operations')
  );
  const journalPath = path.join(operationRoot, 'journal.json');
  const markerPath = path.join(operationRoot, 'directory-marker.json');
  if (!pathsEqual(record.journalPath, journalPath)) {
    throw new Error('The preserved lifecycle recovery journal path does not match its candidate');
  }
  let journal;
  let marker;
  try {
    journal = loadOperationJournal(journalPath);
    marker = verifyDirectoryMarker(
      await readCanonicalJson(markerPath, operationRoot, 'candidate ownership marker'),
      { jobId, stableInstanceId: record.target.stableServerId }
    );
  } catch (error) {
    throw new Error('The preserved lifecycle candidate ownership evidence is invalid', { cause: error });
  }
  if (marker.operationKind !== record.operationKind || marker.checksum !== candidateMarkerSha256 ||
      journal.jobId !== jobId || journal.operationKind !== record.operationKind ||
      journal.stableInstanceId !== record.target.stableServerId || journal.phase !== 'committing' ||
      journal.swapStep !== 'prepared' || journal.targetPathHash !== operationTargetPathHash(serverPath) ||
      !identitiesEqual(journal.candidateIdentity, record.directoryIdentities.candidate) ||
      !identitiesEqual(journal.targetIdentity, record.directoryIdentities.target) ||
      journal.rollbackIdentity !== null || journal.failedIdentity !== null ||
      journal.sourceFingerprint !== rollbackFingerprint || journal.candidateFingerprint !== candidateFingerprint ||
      journal.markerSha256 !== candidateMarkerSha256) {
    throw new Error('The preserved lifecycle candidate ownership evidence does not match its recovery record');
  }

  const [candidateInspection, rollbackInspection] = await Promise.all([
    inspectServerDirectoryTree(candidatePath, {
      mutableRelativePaths: [`.minecraft-core-state/operations/${jobId}/journal.json`]
    }),
    inspectServerDirectoryTree(rollbackPath)
  ]);
  if (!identitiesEqual(candidateInspection.directoryIdentity, record.directoryIdentities.candidate) ||
      candidateInspection.fingerprint !== candidateFingerprint ||
      !identitiesEqual(rollbackInspection.directoryIdentity, record.directoryIdentities.target) ||
      rollbackInspection.fingerprint !== rollbackFingerprint) {
    throw new Error('The preserved lifecycle recovery directories do not match their durable fingerprints');
  }

  const rawEnvelope = await readCanonicalJson(
    path.join(activeDirectory, envelopeName),
    activeDirectory,
    'active recovery target envelope'
  );
  let envelope;
  try {
    envelope = verifyRecoveryTargetEnvelope(rawEnvelope);
  } catch (error) {
    throw new Error('The preserved lifecycle active recovery target envelope is invalid', { cause: error });
  }
  const expectedEnvelope = createRecoveryTargetEnvelope(rawRecord);
  if (!envelopesEqual(envelope, expectedEnvelope)) {
    throw new Error('The preserved lifecycle active recovery target envelope does not match its record');
  }

  const operationsDirectory = await assertCanonicalDirectory(
    path.join(userDataPath, 'modpack-lifecycle', 'operations'),
    path.join(userDataPath, 'modpack-lifecycle')
  );
  const publicOperation = await readCanonicalJson(
    path.join(operationsDirectory, `${jobId}.json`),
    operationsDirectory,
    'public recovery operation'
  );
  if (publicOperation.jobId !== jobId || publicOperation.serverId !== record.target.stableServerId ||
      publicOperation.operationKind !== record.operationKind || publicOperation.phase !== record.phase) {
    throw new Error('The preserved lifecycle public recovery operation does not match its active record');
  }

  return Object.freeze({
    record,
    candidatePath,
    rollbackPath,
    candidateFingerprint,
    rollbackFingerprint,
    evidencePaths: Object.freeze([
      path.join(activeDirectory, recordName),
      path.join(activeDirectory, envelopeName),
      path.join(operationsDirectory, `${jobId}.json`),
      journalPath,
      markerPath
    ])
  });
}

function validateIdentity(identity, expectedIdentity = DEFAULT_CONTINUATION_IDENTITY) {
  if (!expectedIdentity || typeof expectedIdentity !== 'object' || Array.isArray(expectedIdentity)) {
    throw new TypeError('A preserved lifecycle expected identity is required');
  }
  const expectedEntries = Object.entries(expectedIdentity);
  if (expectedEntries.length === 0 || expectedEntries.length > 8 ||
      expectedEntries.some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key) ||
        typeof value !== 'string' || value.length === 0 || value.length > 128)) {
    throw new TypeError('A preserved lifecycle expected identity is invalid');
  }
  if (Object.keys(identity).length !== expectedEntries.length ||
      expectedEntries.some(([key, value]) => identity[key] !== value)) {
    throw new Error('The preserved lifecycle identity does not match the real Modrinth lifecycle harness');
  }
}

function validateApprovedManagedState(state) {
  const source = state.source;
  if (state.modpackManaged !== true || source?.provider !== 'modrinth' ||
      source?.projectId !== realHarness.REAL_MODRINTH_LIFECYCLE.projectId) {
    throw new Error('The preserved lifecycle is not the expected managed Modrinth project');
  }
  const approvedVersion = realHarness.REAL_MODRINTH_LIFECYCLE.versions.find(version => version.id === source.versionId);
  if (!approvedVersion) {
    throw new Error('The preserved lifecycle does not contain an approved exact Modrinth version');
  }
  if (state.runtime?.minecraftVersion !== approvedVersion.minecraft || state.runtime?.loaderFamily !== 'fabric') {
    throw new Error('The preserved lifecycle runtime does not match its approved exact Fabric version');
  }
}

function validateSavedDisposableInstance(config, { serverPath, clientPath }) {
  if (!Array.isArray(config.instances)) {
    throw new Error('The preserved lifecycle does not contain an instances list');
  }
  const serverInstances = config.instances.filter(instance => instance?.type === 'server');
  if (serverInstances.length !== 1) {
    throw new Error('The preserved lifecycle must contain exactly one saved disposable server');
  }
  for (const instance of config.instances) {
    const expectedPath = instance?.type === 'server'
      ? serverPath
      : instance?.type === 'client'
        ? clientPath
        : null;
    if (!expectedPath || typeof instance.path !== 'string' || !pathsEqual(instance.path, expectedPath)) {
      throw new Error('A saved instance points outside the validated scratch server directory');
    }
  }
  const server = serverInstances[0];
  if (typeof server.id !== 'string' || server.id.trim() === '' || !pathsEqual(server.path, serverPath) ||
      typeof config.lastServerPath !== 'string' || !pathsEqual(config.lastServerPath, serverPath)) {
    throw new Error('A saved instance points outside the validated scratch server directory');
  }
  return server.id;
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

async function reserveDistinctLoopbackPorts() {
  const first = await reserveLoopbackPort();
  let second = await reserveLoopbackPort();
  while (second === first) second = await reserveLoopbackPort();
  return [first, second];
}

async function loadPreservedRealLifecycle(root, {
  expectedIdentity = DEFAULT_CONTINUATION_IDENTITY,
  scratchPrefix = CONTINUATION_SCRATCH_PREFIX,
  providerLabel = 'Modrinth',
  scratchLabel = 'modrinth',
  validateManagedState = validateApprovedManagedState,
  assertNoRootProcesses = realHarness.assertNoProductionProcesses
} = {}) {
  if (typeof validateManagedState !== 'function' || typeof assertNoRootProcesses !== 'function') {
    throw new TypeError('A preserved lifecycle managed-state validator is required');
  }
  const locationOptions = { scratchPrefix, providerLabel };
  const requestedRoot = assertContinuationScratchLocation(root, locationOptions);
  const temporaryDirectory = await fsp.realpath(path.resolve(os.tmpdir()));
  const canonicalRoot = await assertCanonicalDirectory(requestedRoot, temporaryDirectory);
  if (!pathsEqual(canonicalRoot, requestedRoot) ||
      !path.basename(canonicalRoot).startsWith(scratchPrefix)) {
    throw new Error(`The preserved lifecycle root resolves outside the exact ${providerLabel} continuation area`);
  }

  const userDataPath = path.join(canonicalRoot, 'user-data');
  const serverPath = path.join(canonicalRoot, 'server');
  const clientPath = path.join(canonicalRoot, 'client');
  const evidencePath = path.join(canonicalRoot, 'evidence');
  const identityPath = path.join(canonicalRoot, 'real-lifecycle-identity.json');
  await Promise.all([
    assertCanonicalDirectory(userDataPath, canonicalRoot),
    assertCanonicalDirectory(clientPath, canonicalRoot),
    assertCanonicalDirectory(evidencePath, canonicalRoot)
  ]);
  await assertNoRootProcesses({ root: canonicalRoot, userDataPath });

  const serverMetadata = await fsp.lstat(serverPath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  let recovery = null;
  let managedStateRoot = serverPath;
  if (serverMetadata === null) {
    recovery = await loadMissingServerRecovery({ canonicalRoot, userDataPath, serverPath });
    managedStateRoot = recovery.rollbackPath;
  } else {
    await assertCanonicalDirectory(serverPath, canonicalRoot);
  }

  const environmentPath = await ensureCanonicalDirectory(path.join(canonicalRoot, 'environment'), canonicalRoot);
  const profilePath = await ensureCanonicalDirectory(path.join(environmentPath, 'profile'), environmentPath);
  const appDataPath = await ensureCanonicalDirectory(path.join(profilePath, 'AppData'), profilePath);
  const roamingAppDataPath = await ensureCanonicalDirectory(path.join(appDataPath, 'Roaming'), appDataPath);
  const localAppDataPath = await ensureCanonicalDirectory(path.join(appDataPath, 'Local'), appDataPath);
  const tempPath = await ensureCanonicalDirectory(path.join(environmentPath, 'temp'), environmentPath);

  const stateDirectory = await assertCanonicalDirectory(
    path.join(managedStateRoot, '.minecraft-core-state'),
    managedStateRoot
  );
  const configDirectory = await assertCanonicalDirectory(path.join(userDataPath, 'config'), userDataPath);
  const statePath = path.join(stateDirectory, 'modpack.json');
  const configPath = path.join(configDirectory, 'minecraft-core-config.json');
  const [identity, state, config] = await Promise.all([
    readCanonicalJson(identityPath, canonicalRoot, 'identity file'),
    readCanonicalJson(statePath, stateDirectory, 'managed state'),
    readCanonicalJson(configPath, configDirectory, 'saved instance configuration')
  ]);
  validateIdentity(identity, expectedIdentity);
  validateManagedState(state);
  const instanceId = validateSavedDisposableInstance(config, { serverPath, clientPath });
  if (recovery && recovery.record.target.stableServerId !== instanceId) {
    throw new Error('The preserved lifecycle recovery target does not match its saved disposable server');
  }
  const recoveryLaunchAuthority = recovery
    ? realHarness.createMissingServerRecoveryAuthority({
        root: canonicalRoot,
        serverPath,
        candidatePath: recovery.candidatePath,
        rollbackPath: recovery.rollbackPath,
        jobId: recovery.record.jobId,
        candidateFingerprint: recovery.candidateFingerprint,
        rollbackFingerprint: recovery.rollbackFingerprint,
        evidencePaths: [identityPath, statePath, configPath, ...recovery.evidencePaths]
      })
    : null;
  await assertNoRootProcesses({ root: canonicalRoot, userDataPath });
  const [serverPort, managementPort] = await reserveDistinctLoopbackPorts();

  let cleanupAuthority = null;
  const lifecycle = {
    root: canonicalRoot,
    scratchLabel,
    continuationScratchPrefix: scratchPrefix,
    continuationProviderLabel: providerLabel,
    userDataPath,
    serverPath,
    clientPath,
    evidencePath,
    identityPath,
    environmentPath,
    profilePath,
    roamingAppDataPath,
    localAppDataPath,
    tempPath,
    instanceId,
    serverHost: '127.0.0.1',
    serverPort,
    managementPort,
    recoveryPending: recovery !== null,
    recoveryJobId: recovery?.record.jobId ?? null,
    recoveryCandidatePath: recovery?.candidatePath ?? null,
    recoveryRollbackPath: recovery?.rollbackPath ?? null,
    recoveryLaunchAuthority,
    async dispose({ preserveRoot = true } = {}) {
      if (preserveRoot) {
        console.error(`[real-modpack-e2e] preserving continuation scratch root: ${canonicalRoot}`);
        return;
      }
      assertContinuationScratchLocation(canonicalRoot, locationOptions);
      await realHarness.removeIsolatedLifecycleRoot(lifecycle, cleanupAuthority);
    }
  };
  cleanupAuthority = realHarness.captureIsolatedLifecycleCleanupAuthority(lifecycle);
  return Object.freeze(lifecycle);
}

async function startPreservedServer(page, lifecycle, { timeoutMs = 5 * 60_000, pollMs = 1_000 } = {}) {
  if (!lifecycle || typeof lifecycle.root !== 'string' || typeof lifecycle.instanceId !== 'string' ||
      typeof lifecycle.serverPath !== 'string') {
    throw new TypeError('A validated preserved lifecycle is required');
  }
  const locationOptions = {
    scratchPrefix: lifecycle.continuationScratchPrefix || CONTINUATION_SCRATCH_PREFIX,
    providerLabel: lifecycle.continuationProviderLabel || 'Modrinth'
  };
  const root = assertContinuationScratchLocation(lifecycle.root, locationOptions);
  if (!pathsEqual(lifecycle.serverPath, path.join(root, 'server'))) {
    throw new Error('Refusing to start anything except the validated continuation scratch server');
  }
  const temporaryDirectory = await fsp.realpath(path.resolve(os.tmpdir()));
  const canonicalRoot = await assertCanonicalDirectory(root, temporaryDirectory);
  const canonicalServerPath = await assertCanonicalDirectory(lifecycle.serverPath, canonicalRoot);
  if (!pathsEqual(canonicalServerPath, path.join(canonicalRoot, 'server'))) {
    throw new Error('Refusing to start anything except the validated continuation scratch server');
  }
  const latestLogPath = path.join(lifecycle.serverPath, 'logs', 'latest.log');
  const priorLog = await fsp.readFile(latestLogPath, 'utf8').catch(() => null);
  await realHarness.configureLoopbackOnlyServerProperties(lifecycle);
  const result = await realHarness.invoke(page, 'start-server', {
    instanceId: lifecycle.instanceId,
    targetPath: lifecycle.serverPath,
    port: lifecycle.serverPort,
    maxRam: 2
  });
  if (!result?.success) {
    throw new Error(`Could not start preserved server: ${result?.code || ''} ${result?.error || ''}`.trim());
  }

  const startedAt = Date.now();
  let status = null;
  let sawRunning = false;
  while (Date.now() - startedAt < timeoutMs) {
    status = await realHarness.invoke(page, 'get-server-status', {
      instanceId: lifecycle.instanceId,
      targetPath: lifecycle.serverPath
    });
    const isRunning = status?.status === 'running' || status?.isRunning === true;
    if (isRunning) sawRunning = true;
    if (['failed', 'crashed', 'error'].includes(status?.status) || (sawRunning && !isRunning)) {
      throw new Error(`Preserved server exited before fresh readiness; last status: ${status?.status || 'not-running'}`);
    }
    const latestLog = await fsp.readFile(latestLogPath, 'utf8').catch(() => null);
    if (isRunning && latestLog !== null && latestLog !== priorLog && /Done \([0-9.]+s\)!/u.test(latestLog)) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Preserved server did not produce a fresh readiness log; last status: ${status?.status || 'unknown'}`);
}

module.exports = {
  REAL_CONTINUATION_ROOT_ENV,
  getPreservedLifecycleRoot,
  isPreservedLifecycleContinuationEnabled,
  loadPreservedRealLifecycle,
  startPreservedServer
};
