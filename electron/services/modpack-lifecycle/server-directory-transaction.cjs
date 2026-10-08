const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { MAX_FLUSH_DIRECTORIES } = require('../../utils/durable-fs.cjs');
const { isNetworkAccess } = require('../../utils/server-network-properties.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const {
  MAX_SERVER_HEALTH_TIMEOUT_MS,
  MAX_SERVER_PROPERTIES_BYTES
} = require('../server-health-constants.cjs');
const { isCompactOperationId } = require('./operation-id.cjs');
const { assertPlanStillValid } = require('../modpacks/planning/preflight-planner.cjs');
const { normalizeRecoveryTargetPath } = require('./recovery-target-envelope.cjs');
const {
  OperationJournal,
  createDirectoryMarker,
  createTargetAbsenceEvidence,
  verifyDirectoryMarker
} = require('./operation-journal.cjs');
const {
  assertServerDirectoryIdentity,
  captureServerDirectoryCopySource,
  copyServerDirectoryContents,
  identifyServerDirectory,
  inspectAndFlushServerDirectoryTree,
  inspectServerDirectoryStructure,
  inspectServerDirectoryTree,
  normalizeServerDirectoryPath
} = require('./server-directory-identity.cjs');
const { InstanceRegistry } = require('./instance-registry.cjs');
const { stopValidatedHandoff } = require('../server-health-validator.cjs');
const {
  isAppIssuedForgeCandidateHealthAuthorization
} = require('../forge-candidate-health-authorization.cjs');

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_KINDS = new Set(['install', 'import']);
const EXISTING_OPERATION_KINDS = new Set([
  'install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback', 'import', 'uninstall', 'detach'
]);
const MARKER_FILE = 'directory-marker.json';
const JOURNAL_FILE = 'journal.json';
// Windows can retain a delete-share denial briefly after a real server boot.
// Every attempt below re-proves the exact candidate, parent identity, and empty
// publication slots before the native move. Keep the backoff short and bounded:
// an app-owned handle must be fixed at its source instead of hidden by a long wait.
const NEW_PUBLICATION_RETRY_DELAYS_MS = Object.freeze([100, 500, 1500, 3000, 5000, 7500]);
const CLEANUP_YIELD_BATCH = 64;
const CLEANUP_YIELD_INTERVAL_MS = 16;
const EXACT_SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
const EXACT_SNAPSHOT_YIELD_BYTES = 8 * 1024 * 1024;

function defaultYieldControl() {
  return new Promise(resolve => setImmediate(resolve));
}

function defaultDurabilityHandoff() {
  return new Promise(resolve => setImmediate(resolve));
}

async function yieldCandidateControl(context) {
  await (context.yieldControl || defaultYieldControl)();
  if (context.signal?.aborted) {
    throw new ModpackError('CANCELLED', 'The server directory operation was cancelled');
  }
}

async function yieldDurabilityControl(context) {
  await (context.durabilityHandoff || context.yieldControl || defaultDurabilityHandoff)();
  if (context.signal?.aborted) {
    throw new ModpackError('CANCELLED', 'The server directory operation was cancelled');
  }
}

async function flushCleanupDirectory(context, directoryPath) {
  await context.durableFs.flushDirectoryAsync(directoryPath);
  await yieldDurabilityControl(context);
}

function targetExists() {
  return new ModpackError('TARGET_EXISTS', 'The selected server directory already exists');
}

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The publication request is invalid', { cause });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The server publication requires recovery', { cause });
}

function commitFailure(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('COMMIT_FAILED', 'The server publication could not be committed', { cause });
}

function createSiblingPaths(targetValue, jobId) {
  try {
    if (typeof targetValue !== 'string' || targetValue !== targetValue.normalize('NFC') ||
        typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw invalid();
    normalizeRecoveryTargetPath(targetValue);
    const targetPath = path.win32.normalize(targetValue.replaceAll('/', '\\'));
    const parent = path.win32.dirname(targetPath);
    const label = path.win32.basename(targetPath);
    const compact = isCompactOperationId(jobId);
    const prefix = compact ? `.${jobId}` : `.${label}.minecraft-core.${jobId}`;
    const candidatePath = path.win32.join(parent, `${prefix}.${compact ? 'c' : 'candidate'}`);
    const failedPath = path.win32.join(parent, `${prefix}.${compact ? 'f' : 'failed'}`);
    const aliases = new Set([targetPath, candidatePath, failedPath].map(pathAliasKey));
    if (aliases.size !== 3) throw invalid();
    return Object.freeze({ targetPath, candidatePath, failedPath });
  } catch (error) {
    throw invalid(error);
  }
}

function createExistingSiblingPaths(targetValue, jobId) {
  const base = createSiblingPaths(targetValue, jobId);
  const label = path.win32.basename(base.targetPath);
  const compact = isCompactOperationId(jobId);
  const rollbackPath = path.win32.join(
    path.win32.dirname(base.targetPath),
    compact ? `.${jobId}.r` : `.${label}.minecraft-core.${jobId}.rollback`
  );
  if (new Set([...Object.values(base), rollbackPath].map(pathAliasKey)).size !== 4) throw invalid();
  return Object.freeze({ ...base, rollbackPath });
}

function pathAliasKey(value) {
  return normalizeServerDirectoryPath(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function entryStat(fsApi, candidate) {
  try {
    return fsApi.lstatSync(candidate, { bigint: true, throwIfNoEntry: false }) || null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertIdentifier(value, pattern = JOB_ID_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
  return value;
}

function assertDependencies(context, purpose) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.getPrototypeOf(context) !== Object.prototype) {
    throw invalid();
  }
  const targetPath = normalizeServerDirectoryPath(context.targetPath);
  const jobId = assertIdentifier(context.jobId);
  const stableInstanceId = assertIdentifier(context.stableInstanceId, INSTANCE_ID_PATTERN);
  if (!OPERATION_KINDS.has(context.operationKind)) throw invalid();
  const expectedPaths = createSiblingPaths(targetPath, jobId);
  const fsApi = context.fsApi || fs;
  const fsPromises = filesystemPromises(context, fsApi);
  const durableFs = context.durableFs;
  const recoveryRegistry = context.recoveryRegistry;
  const mutationLease = context.mutationLease;
  const reparseInspector = context.reparseInspector;
  if (!fsApi || typeof fsApi.lstatSync !== 'function' || typeof fsApi.readdirSync !== 'function' ||
      !durableFs || typeof durableFs.flushDirectory !== 'function' || typeof durableFs.flushDirectoryAsync !== 'function' ||
      typeof durableFs.readFileBounded !== 'function' || typeof durableFs.readFileBoundedAsync !== 'function' ||
      typeof durableFs.writeJsonAtomicAsync !== 'function' ||
      !recoveryRegistry || typeof recoveryRegistry.load !== 'function' || typeof recoveryRegistry.transition !== 'function' ||
      !mutationLease || mutationLease.kind !== 'mutation' || mutationLease.instanceId !== stableInstanceId ||
      pathAliasKey(mutationLease.serverPath) !== pathAliasKey(targetPath) || typeof mutationLease.markDirty !== 'function' ||
      !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function') throw invalid();
  if (context.onProgress !== undefined && typeof context.onProgress !== 'function') throw invalid();
  if (context.publicationRetryDelay !== undefined && typeof context.publicationRetryDelay !== 'function') throw invalid();
  if (context.durabilityHandoff !== undefined && typeof context.durabilityHandoff !== 'function') throw invalid();
  if (context.yieldControl !== undefined && typeof context.yieldControl !== 'function') throw invalid();
  const common = {
    ...context,
    targetPath,
    jobId,
    stableInstanceId,
    expectedPaths,
    fsApi,
    fsPromises,
    durableFs,
    recoveryRegistry,
    mutationLease,
    reparseInspector
  };
  if (purpose === 'build') {
    if (typeof context.planValidator !== 'function' && typeof assertPlanStillValid !== 'function') throw invalid();
    const customPersistence = typeof context.persistCandidateState === 'function';
    const validatesRuntime = context.validateCandidate !== false;
    if (typeof context.materializeCandidate !== 'function' || !context.stateRepository ||
        (!customPersistence && typeof context.stateRepository.writeCandidateAsync !== 'function') ||
        (validatesRuntime && (!context.healthValidator || typeof context.healthValidator.validateCandidate !== 'function' ||
          !context.runtime || typeof context.maxRam !== 'number' || !Number.isSafeInteger(context.healthTimeoutMs) ||
          context.healthTimeoutMs < 1 || context.healthTimeoutMs > MAX_SERVER_HEALTH_TIMEOUT_MS))) throw invalid();
  }
  if (purpose === 'publish' && typeof durableFs.renameDurableAsync !== 'function') throw invalid();
  return common;
}

function operationPaths(serverPath, jobId) {
  const stateRoot = path.join(serverPath, '.minecraft-core-state');
  const operationsRoot = path.join(stateRoot, 'operations');
  const operationRoot = path.join(operationsRoot, jobId);
  return Object.freeze({
    stateRoot,
    manifestsRoot: path.join(stateRoot, 'manifests'),
    operationsRoot,
    historyRoot: path.join(stateRoot, 'history'),
    operationRoot,
    markerPath: path.join(operationRoot, MARKER_FILE),
    journalPath: path.join(operationRoot, JOURNAL_FILE),
    mutableJournalRelativePath: `.minecraft-core-state/operations/${jobId}/${JOURNAL_FILE}`
  });
}

function assertRecordMatches(record, context) {
  if (!record || record.jobId !== context.jobId || record.operationKind !== context.operationKind ||
      record.target?.kind !== 'new' || record.target.stableServerId !== context.stableInstanceId ||
      pathAliasKey(record.target.path) !== pathAliasKey(context.targetPath) ||
      pathAliasKey(record.candidatePath) !== pathAliasKey(context.expectedPaths.candidatePath) ||
      pathAliasKey(record.failedPath) !== pathAliasKey(context.expectedPaths.failedPath)) throw recoveryRequired();
  return record;
}

function assertSiblingAliasesAbsent(context, { allowCandidate = false, allowTarget = false } = {}) {
  const parent = path.dirname(context.targetPath);
  const slotByKey = new Map([
    [path.basename(context.targetPath).normalize('NFC').toLocaleLowerCase('en-US'), 'target'],
    [path.basename(context.expectedPaths.candidatePath).normalize('NFC').toLocaleLowerCase('en-US'), 'candidate'],
    [path.basename(context.expectedPaths.failedPath).normalize('NFC').toLocaleLowerCase('en-US'), 'failed']
  ]);
  let names;
  try { names = context.fsApi.readdirSync(parent); } catch (error) { throw invalid(error); }
  for (const name of names) {
    if (typeof name !== 'string' || name !== name.normalize('NFC')) {
      const normalizedKey = typeof name === 'string' ? name.normalize('NFC').toLocaleLowerCase('en-US') : '';
      if (slotByKey.has(normalizedKey)) throw targetExists();
      continue;
    }
    const slot = slotByKey.get(name.toLocaleLowerCase('en-US'));
    if (!slot) continue;
    if (slot === 'candidate' && allowCandidate) continue;
    if (slot === 'target' && allowTarget) continue;
    throw targetExists();
  }
}

async function identifyParent(context) {
  return identifyServerDirectory(path.dirname(context.targetPath), {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
}

async function createDirectoryExclusive(context, directoryPath) {
  if (entryStat(context.fsApi, directoryPath)) throw targetExists();
  try {
    context.fsApi.mkdirSync(directoryPath, { recursive: false, mode: 0o700 });
    await context.durableFs.flushDirectoryAsync(path.dirname(directoryPath));
    await yieldDurabilityControl(context);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'TARGET_EXISTS') throw targetExists();
    throw commitFailure(error);
  }
  return identifyServerDirectory(directoryPath, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
}

async function ensureOperationLayout(context, candidatePath) {
  const locations = operationPaths(candidatePath, context.jobId);
  const directories = [
    locations.stateRoot,
    locations.manifestsRoot,
    locations.operationsRoot,
    locations.historyRoot,
    locations.operationRoot
  ];
  for (const directory of directories) {
    if (entryStat(context.fsApi, directory)) throw recoveryRequired();
    await createDirectoryExclusive(context, directory);
  }
  return locations;
}

function createJournal(context) {
  return new OperationJournal({
    durableFs: context.durableFs,
    fsApi: context.fsApi,
    clock: context.clock || (() => new Date())
  });
}

function markerTime(context) {
  const value = (context.clock || (() => new Date()))();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalid();
  return value.toISOString();
}

async function writeMarker(context, markerPath) {
  const marker = createDirectoryMarker({
    jobId: context.jobId,
    operationKind: context.operationKind,
    stableInstanceId: context.stableInstanceId,
    createdAt: markerTime(context)
  });
  try {
    await context.durableFs.writeJsonAtomicAsync(markerPath, marker, { expectedTargetSha256: null });
    await context.durableFs.flushDirectoryAsync(path.dirname(markerPath));
    await yieldDurabilityControl(context);
  } catch (error) {
    throw commitFailure(error);
  }
  return marker;
}

function readMarker(context, serverPath) {
  const markerPath = operationPaths(serverPath, context.jobId).markerPath;
  try {
    const bytes = context.durableFs.readFileBounded(markerPath, { allowMissing: false, maxBytes: 64 * 1024 });
    return verifyDirectoryMarker(JSON.parse(bytes.toString('utf8')), {
      jobId: context.jobId,
      stableInstanceId: context.stableInstanceId
    });
  } catch (error) {
    throw recoveryRequired(error);
  }
}

function treeOptions(context, serverPath) {
  return {
    fsApi: context.fsApi,
    fsPromises: context.fsPromises,
    reparseInspector: context.reparseInspector,
    signal: context.signal,
    yieldControl: context.yieldControl,
    mutableRelativePaths: [operationPaths(serverPath, context.jobId).mutableJournalRelativePath]
  };
}

function handoffAdoptionFailure(cause) {
  return new ModpackError(
    'HEALTH_CHECK_FAILED',
    'The validated running server could not be adopted',
    cause ? { cause } : undefined
  );
}

async function adoptExistingValidatedHandoff(context, handoff) {
  if (!handoff || !context.runtimePolicy) throw handoffAdoptionFailure();
  const result = await context.runtimePolicy.adoptValidatedHandoff({
    eventId: `modpack-runtime-handoff:${context.jobId}`,
    handoff,
    instanceId: context.stableInstanceId,
    jobId: context.jobId,
    serverPath: context.targetPath
  });
  if (result?.adopted !== true) throw handoffAdoptionFailure();
  return result;
}

async function stopExistingValidatedHandoffAfterFailure(handoff, validationError) {
  try {
    await stopValidatedHandoff(handoff);
  } catch (cleanupError) {
    throw new ModpackError(
      'HEALTH_CHECK_FAILED',
      'The validated server process could not be stopped after validation or handoff failed',
      {
        cause: new AggregateError(
          [validationError, cleanupError],
          'Validated existing-server handoff cleanup failed'
        )
      }
    );
  }
  throw validationError;
}

function filesystemPromises(context, fsApi) {
  const candidate = context.fsPromises || fsApi.promises || fsp;
  if (!candidate || ['lstat', 'open', 'readdir', 'rmdir', 'unlink']
    .some(method => typeof candidate[method] !== 'function')) throw invalid();
  return candidate;
}

async function entryStatAsync(fsPromises, candidate) {
  try { return await fsPromises.lstat(candidate, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectCandidate(context, serverPath) {
  return inspectServerDirectoryTree(serverPath, treeOptions(context, serverPath));
}

async function inspectAndFlushCandidate(context, serverPath) {
  try {
    return await inspectAndFlushServerDirectoryTree(serverPath, {
      ...treeOptions(context, serverPath),
      durableFs: context.durableFs
    });
  } catch (error) {
    throw commitFailure(error);
  }
}

async function flushDirectoryBatch(context, directoryPaths) {
  const durableFs = context.durableFs;
  if (typeof durableFs.flushDirectoriesAsync === 'function') {
    for (let offset = 0; offset < directoryPaths.length; offset += MAX_FLUSH_DIRECTORIES) {
      await durableFs.flushDirectoriesAsync(directoryPaths.slice(offset, offset + MAX_FLUSH_DIRECTORIES));
      await yieldDurabilityControl(context);
    }
    return;
  }
  for (const directoryPath of directoryPaths) {
    await durableFs.flushDirectoryAsync(directoryPath);
    await yieldDurabilityControl(context);
  }
}

function identityMatches(left, right) {
  return Boolean(left && right && left.volumeSerial === right.volumeSerial && left.fileId === right.fileId);
}

function publicTransactionResult(context, phase, directoryIdentity, fingerprint) {
  return deepFreeze({
    jobId: context.jobId,
    stableInstanceId: context.stableInstanceId,
    phase,
    directoryIdentity: { ...directoryIdentity },
    candidateFingerprint: fingerprint
  });
}

async function buildNewCandidate(contextValue) {
  const context = assertDependencies(contextValue, 'build');
  let record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (record.phase !== 'preflight') throw recoveryRequired();
  const planValidator = context.planValidator || assertPlanStillValid;
  planValidator(context.plan, context.currentSnapshot);
  await candidateProgress(context, 'staging', 36, 'Preparing a protected candidate workspace');
  const parentIdentity = await identifyParent(context);
  assertSiblingAliasesAbsent(context);

  const locations = operationPaths(context.expectedPaths.candidatePath, context.jobId);
  await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'preflight',
    nextPhase: 'staging',
    patch: {
      candidatePath: context.expectedPaths.candidatePath,
      failedPath: context.expectedPaths.failedPath,
      journalPath: locations.journalPath
    }
  });
  await yieldDurabilityControl(context);
  context.mutationLease.markDirty();
  await assertServerDirectoryIdentity(path.dirname(context.targetPath), parentIdentity, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
  assertSiblingAliasesAbsent(context);
  const candidateIdentity = await createDirectoryExclusive(context, context.expectedPaths.candidatePath);
  await assertServerDirectoryIdentity(path.dirname(context.targetPath), parentIdentity, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
  if (candidateIdentity.volumeSerial !== parentIdentity.volumeSerial) throw commitFailure();
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'staging',
    nextPhase: 'staging',
    patch: {
      directoryIdentities: { target: null, candidate: candidateIdentity, rollback: null, failed: null }
    }
  });
  await yieldDurabilityControl(context);
  const createdLocations = await ensureOperationLayout(context, context.expectedPaths.candidatePath);
  const marker = await writeMarker(context, createdLocations.markerPath);
  const journal = createJournal(context);
  await journal.create(createdLocations.journalPath, {
    jobId: context.jobId,
    operationKind: context.operationKind,
    stableInstanceId: context.stableInstanceId,
    targetPath: context.targetPath,
    candidateIdentity,
    markerSha256: marker.checksum
  });
  await yieldDurabilityControl(context);
  await journal.transition(createdLocations.journalPath, {
    expectedPhase: 'staging', nextPhase: 'validating-candidate', patch: {}
  });
  await yieldDurabilityControl(context);
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'staging',
    nextPhase: 'validating-candidate',
    patch: {
      directoryIdentities: { target: null, candidate: candidateIdentity, rollback: null, failed: null }
    }
  });
  await yieldDurabilityControl(context);

  await candidateProgress(context, 'staging', 38, 'Materializing reviewed modpack files');
  await context.materializeCandidate(Object.freeze({
    candidatePath: context.expectedPaths.candidatePath,
    jobId: context.jobId,
    signal: context.signal
  }));
  const validationPhase = context.validateCandidate === false ? 'staging' : 'validating-candidate';
  await candidateProgress(context, validationPhase, 50, 'Recording the candidate state');
  if (context.persistCandidateState) {
    await context.persistCandidateState(Object.freeze({
      candidatePath: context.expectedPaths.candidatePath,
      candidateState: context.candidateState,
      jobId: context.jobId,
      stateRepository: context.stateRepository
    }));
  } else {
    await context.stateRepository.writeCandidateAsync(context.expectedPaths.candidatePath, context.candidateState);
  }
  await candidateProgress(context, validationPhase, 52, 'Checking and durably recording candidate content');
  const preHealthInspection = await inspectAndFlushCandidate(context, context.expectedPaths.candidatePath);
  let finalInspection = preHealthInspection;
  let candidateHealth = null;
  if (context.validateCandidate !== false) {
    await candidateProgress(context, validationPhase, 57, 'Boot-testing the candidate on loopback');
    const validation = await context.healthValidator.validateCandidate({
      candidatePath: context.expectedPaths.candidatePath,
      jobId: context.jobId,
      maxRam: context.maxRam,
      mutationLease: context.mutationLease,
      runtime: context.runtime,
      signal: context.signal,
      timeoutMs: context.healthTimeoutMs
    });
    const evidence = validation?.evidence ?? validation;
    candidateHealth = assertCandidateHealthAttestation(evidence);
    await candidateProgress(context, validationPhase, 60, 'Rechecking and flushing the validated candidate');
    finalInspection = await inspectAndFlushCandidate(context, context.expectedPaths.candidatePath);
  } else {
    await candidateProgress(context, validationPhase, 60, 'Candidate content is verified and durable');
  }
  if (!identityMatches(finalInspection.directoryIdentity, candidateIdentity)) throw recoveryRequired();

  await candidateProgress(context, validationPhase, 63, 'Sealing candidate integrity evidence');

  await journal.transition(createdLocations.journalPath, {
    expectedPhase: 'validating-candidate',
    nextPhase: 'committing',
    patch: { candidateFingerprint: finalInspection.fingerprint }
  });
  await yieldDurabilityControl(context);
  await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'validating-candidate',
    nextPhase: 'committing',
    patch: {
      directoryIdentities: { target: null, candidate: candidateIdentity, rollback: null, failed: null },
      outcome: {
        ...(record.outcome || {}),
        candidate: {
          fingerprint: finalInspection.fingerprint,
          markerSha256: marker.checksum,
          ...(candidateHealth ? { health: candidateHealth } : {})
        }
      }
    }
  });
  await yieldDurabilityControl(context);
  return publicTransactionResult(context, 'committing', candidateIdentity, finalInspection.fingerprint);
}

function assertCandidateHealthAttestation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || value.kind !== 'candidate' ||
      value.live !== true || value.listenerOwned !== true || value.pongMatched !== true ||
      value.handedOff !== false || typeof value.readyMarker !== 'string' || value.readyMarker.length === 0 ||
      !value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties) ||
      typeof value.properties.existed !== 'boolean' ||
      (value.properties.existed
        ? !/^[a-f0-9]{64}$/u.test(value.properties.sha256)
        : value.properties.sha256 !== null) ||
      !value.shutdown || typeof value.shutdown !== 'object' || Array.isArray(value.shutdown) ||
      value.shutdown.closed !== true || value.shutdown.clean !== true || value.shutdown.forced !== false ||
      value.shutdown.exitCode !== 0 || value.shutdown.signal !== null) {
    throw recoveryRequired();
  }
  return value;
}

async function verifyPublishedNewCandidate(contextValue) {
  const context = { ...assertDependencies(contextValue, 'publish'), signal: undefined };
  const record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['registering', 'committed-healthy'].includes(record.phase) ||
      record.swapStep !== 'candidate-published' || record.outcome?.registration?.complete !== true ||
      record.outcome?.liveMutationAuthorized === true || !record.directoryIdentities.target) {
    throw recoveryRequired();
  }
  const candidateHealth = record.outcome?.candidate?.health;
  assertCandidateHealthAttestation(candidateHealth);
  const owned = await verifyOwnedDirectory(
    context,
    context.targetPath,
    record.directoryIdentities.target,
    record.outcome?.publication?.candidateFingerprint || record.outcome?.candidate?.fingerprint || null
  );
  assertNewOperationLineage(record, owned);
  if (owned.journalRecord.phase !== 'registered' || owned.journalRecord.swapStep !== 'candidate-published' ||
      !identityMatches(owned.journalRecord.targetIdentity, record.directoryIdentities.target) ||
      owned.journalRecord.failedIdentity !== null ||
      owned.journalRecord.registration?.instanceId !== context.stableInstanceId ||
      owned.journalRecord.registration?.complete !== true) throw recoveryRequired();
  return deepFreeze({
    evidence: {
      ...candidateHealth,
      publicationVerified: true,
      validationSource: 'sealed-candidate'
    },
    handoff: null
  });
}

async function verifyCommittedNewPublication(contextValue) {
  const context = { ...assertDependencies(contextValue, 'publish'), signal: undefined };
  const record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['committed-healthy', 'completed'].includes(record.phase) ||
      record.swapStep !== 'candidate-published' || record.outcome?.registration?.complete !== true ||
      record.outcome?.liveMutationAuthorized === true || !record.directoryIdentities.target ||
      !record.outcome?.health || typeof record.outcome.health !== 'object' || Array.isArray(record.outcome.health)) {
    throw recoveryRequired();
  }
  const candidateFingerprint = record.outcome?.publication?.candidateFingerprint ||
    record.outcome?.candidate?.fingerprint || null;
  if (typeof candidateFingerprint !== 'string') throw recoveryRequired();
  // committed-healthy is irreversible. App-owned post-commit state (notably
  // lifecycle history) may legitimately change the tree fingerprint, so prove
  // the exact directory identity, marker, journal, and publication lineage
  // without comparing current mutable content to the pre-commit candidate.
  const owned = await readOwnedDirectoryEvidence(
    context,
    context.targetPath,
    record.directoryIdentities.target,
    candidateFingerprint
  );
  assertNewOperationLineage(record, owned);
  if (owned.journalRecord.phase !== 'registered' || owned.journalRecord.swapStep !== 'candidate-published' ||
      !identityMatches(owned.journalRecord.targetIdentity, record.directoryIdentities.target) ||
      owned.journalRecord.failedIdentity !== null ||
      owned.journalRecord.registration?.instanceId !== context.stableInstanceId ||
      owned.journalRecord.registration?.complete !== true) throw recoveryRequired();
  return deepFreeze({ phase: record.phase, verified: true });
}

async function readOwnedDirectoryEvidence(context, serverPath, expectedIdentity, expectedFingerprint = null) {
  const identity = await assertServerDirectoryIdentity(serverPath, expectedIdentity, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
  const marker = readMarker(context, serverPath);
  const locations = operationPaths(serverPath, context.jobId);
  const journal = createJournal(context);
  const journalRecord = journal.load(locations.journalPath);
  const expectedTargetPathHash = crypto.createHash('sha256').update(pathAliasKey(context.targetPath), 'utf8').digest('hex');
  const expectedTargetNameHash = crypto.createHash('sha256')
    .update(path.basename(context.targetPath).normalize('NFC').toLocaleLowerCase('en-US'), 'utf8').digest('hex');
  if (journalRecord.targetPathHash !== expectedTargetPathHash ||
      (journalRecord.targetAbsence && (journalRecord.targetAbsence.targetPathHash !== expectedTargetPathHash ||
        journalRecord.targetAbsence.targetNameHash !== expectedTargetNameHash)) ||
      journalRecord.markerSha256 !== marker.checksum || journalRecord.jobId !== context.jobId ||
      journalRecord.stableInstanceId !== context.stableInstanceId ||
      journalRecord.operationKind !== context.operationKind || marker.operationKind !== context.operationKind ||
      !identityMatches(journalRecord.candidateIdentity, expectedIdentity) ||
      (expectedFingerprint && journalRecord.candidateFingerprint !== expectedFingerprint)) throw recoveryRequired();
  const confirmedIdentity = await assertServerDirectoryIdentity(serverPath, expectedIdentity, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
  if (!identityMatches(identity, confirmedIdentity)) throw recoveryRequired();
  return { identity: confirmedIdentity, journal, journalRecord, locations, marker };
}

async function verifyOwnedDirectory(context, serverPath, expectedIdentity, expectedFingerprint = null) {
  const owned = await readOwnedDirectoryEvidence(
    context,
    serverPath,
    expectedIdentity,
    expectedFingerprint
  );
  const inspection = await inspectCandidate(context, serverPath);
  const fingerprint = expectedFingerprint || owned.journalRecord.candidateFingerprint;
  if (!fingerprint || inspection.fingerprint !== fingerprint || !identityMatches(inspection.directoryIdentity, expectedIdentity)) {
    throw recoveryRequired();
  }
  return { ...owned, inspection };
}

function assertNewOperationLineage(record, owned) {
  const publication = record.outcome?.publication;
  const candidate = record.outcome?.candidate;
  if (!publication || !candidate || typeof publication.candidateFingerprint !== 'string' ||
      typeof publication.markerSha256 !== 'string' ||
      publication.candidateFingerprint !== candidate.fingerprint ||
      publication.markerSha256 !== candidate.markerSha256 ||
      publication.candidateFingerprint !== owned.journalRecord.candidateFingerprint ||
      publication.markerSha256 !== owned.journalRecord.markerSha256 ||
      publication.markerSha256 !== owned.marker.checksum ||
      owned.journalRecord.rollbackIdentity !== null || owned.journalRecord.rollbackFingerprint !== null ||
      owned.journalRecord.revisionEventId !== null || owned.journalRecord.revisionEventPublished !== false ||
      JSON.stringify(owned.journalRecord.targetAbsence) !== JSON.stringify(publication.targetAbsence)) {
    throw recoveryRequired();
  }
  return publication;
}

async function verifyMutableNewOperationOwnedDirectory(contextValue, serverPathValue, expectedIdentity) {
  const context = { ...assertDependencies(contextValue, 'publish'), signal: undefined };
  const record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  const serverPath = normalizeServerDirectoryPath(serverPathValue);
  const targetSlot = pathAliasKey(serverPath) === pathAliasKey(context.targetPath);
  const failedSlot = pathAliasKey(serverPath) === pathAliasKey(context.expectedPaths.failedPath);
  if ((!targetSlot && !failedSlot) || record.outcome?.liveMutationAuthorized !== true ||
      !['validating-live', 'committed-healthy', 'completed', 'rolling-back', 'failed'].includes(record.phase)) {
    throw recoveryRequired();
  }

  const candidateFingerprint = record.outcome?.publication?.candidateFingerprint;
  if (!candidateFingerprint || !record.outcome?.liveValidation?.properties) {
    throw recoveryRequired();
  }
  const owned = await readOwnedDirectoryEvidence(
    context,
    serverPath,
    expectedIdentity,
    candidateFingerprint
  );
  const journalRecord = owned.journalRecord;
  assertNewOperationLineage(record, owned);

  if (['validating-live', 'committed-healthy', 'completed'].includes(record.phase)) {
    if (!targetSlot || !identityMatches(record.directoryIdentities.target, expectedIdentity) ||
        journalRecord.phase !== 'registered' || journalRecord.swapStep !== 'candidate-published' ||
        !identityMatches(journalRecord.targetIdentity, expectedIdentity) || journalRecord.failedIdentity !== null ||
        journalRecord.registration?.instanceId !== context.stableInstanceId ||
        journalRecord.registration?.complete !== true) throw recoveryRequired();
  } else if (record.swapStep === 'candidate-published') {
    if (!identityMatches(record.directoryIdentities.target, expectedIdentity)) throw recoveryRequired();
    if (journalRecord.swapStep === 'candidate-published') {
      if ((!targetSlot && !failedSlot) || !['registered', 'rolling-back'].includes(journalRecord.phase) ||
          !identityMatches(journalRecord.targetIdentity, expectedIdentity) || journalRecord.failedIdentity !== null) {
        throw recoveryRequired();
      }
    } else if (journalRecord.swapStep === 'failed-canonical-moved') {
      if (!failedSlot || !['rolling-back', 'failed'].includes(journalRecord.phase) ||
          journalRecord.targetIdentity !== null ||
          !identityMatches(journalRecord.failedIdentity, expectedIdentity)) throw recoveryRequired();
    } else {
      throw recoveryRequired();
    }
  } else if (record.swapStep === 'failed-canonical-moved') {
    if (!failedSlot || !identityMatches(record.directoryIdentities.failed, expectedIdentity) ||
        !['rolling-back', 'failed'].includes(journalRecord.phase) ||
        journalRecord.swapStep !== 'failed-canonical-moved' || journalRecord.targetIdentity !== null ||
        !identityMatches(journalRecord.failedIdentity, expectedIdentity)) throw recoveryRequired();
  } else {
    throw recoveryRequired();
  }
  return owned;
}

async function prepareNewLiveValidation(contextValue) {
  const context = { ...assertDependencies(contextValue, 'publish'), signal: undefined };
  let record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['registering', 'validating-live', 'committed-healthy'].includes(record.phase) ||
      record.swapStep !== 'candidate-published' || record.outcome?.registration?.complete !== true ||
      !record.directoryIdentities.target) throw recoveryRequired();

  const needsAuthorization = record.outcome?.liveMutationAuthorized !== true;
  let owned;
  if (record.phase === 'registering' || (record.phase === 'committed-healthy' && needsAuthorization)) {
    owned = await verifyOwnedDirectory(
      context,
      context.targetPath,
      record.directoryIdentities.target,
      record.outcome?.publication?.candidateFingerprint || record.outcome?.candidate?.fingerprint || null
    );
    assertNewOperationLineage(record, owned);
    if (owned.journalRecord.phase !== 'registered' || owned.journalRecord.swapStep !== 'candidate-published' ||
        !identityMatches(owned.journalRecord.targetIdentity, record.directoryIdentities.target) ||
        owned.journalRecord.failedIdentity !== null ||
        owned.journalRecord.registration?.instanceId !== context.stableInstanceId ||
        owned.journalRecord.registration?.complete !== true) throw recoveryRequired();
  } else {
    owned = await verifyMutableNewOperationOwnedDirectory(
      context,
      context.targetPath,
      record.directoryIdentities.target
    );
  }

  const properties = await exactFileSnapshot(context, context.targetPath, 'server.properties');
  if (needsAuthorization) {
    const expectedPhase = record.phase;
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase,
      nextPhase: expectedPhase === 'registering' ? 'validating-live' : expectedPhase,
      patch: {
        outcome: {
          ...(record.outcome || {}),
          liveMutationAuthorized: true,
          liveValidation: { properties: durableSnapshotMetadata(properties) }
        }
      }
    });
    await operationBoundary(context, 'new-live-validation-authorized');
  } else {
    assertDurableSnapshotMetadata(properties, record.outcome?.liveValidation?.properties);
  }
  return deepFreeze({
    directoryIdentity: { ...record.directoryIdentities.target },
    jobId: context.jobId,
    properties
  });
}

async function completeNewLiveValidation(contextValue, authorization) {
  const context = { ...assertDependencies(contextValue, 'publish'), signal: undefined };
  if (!authorization || authorization.jobId !== context.jobId || !authorization.directoryIdentity ||
      !authorization.properties) throw invalid();
  const record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['validating-live', 'committed-healthy'].includes(record.phase) ||
      !identityMatches(record.directoryIdentities.target, authorization.directoryIdentity)) throw recoveryRequired();
  assertDurableSnapshotMetadata(authorization.properties, record.outcome?.liveValidation?.properties);
  await verifyMutableNewOperationOwnedDirectory(context, context.targetPath, record.directoryIdentities.target);
  await assertExactFileSnapshot(context, context.targetPath, 'server.properties', authorization.properties);
  return deepFreeze({ phase: 'validating-live', verified: true });
}

async function verifyCommittedOwnedDirectory(context, record, {
  allowPreValidationJournal = false,
  allowUnpublishedRevision = false
} = {}) {
  const validationPending = record.phase === 'validating-live';
  const targetIdentity = record.directoryIdentities?.target;
  const rollbackIdentity = record.directoryIdentities?.rollback;
  const candidateFingerprint = record.outcome?.candidate?.fingerprint;
  const candidateMarkerSha256 = record.outcome?.candidate?.markerSha256;
  const rollbackFingerprint = record.outcome?.rollback?.fingerprint;
  const revisionEventId = record.outcome?.revisionEvent?.eventId;
  const revisionPublished = record.outcome?.revisionEvent?.published === true;
  if (!targetIdentity || !rollbackIdentity || !candidateFingerprint || !candidateMarkerSha256 || !rollbackFingerprint ||
      (!validationPending && (!revisionEventId || (!allowUnpublishedRevision && !revisionPublished)))) {
    throw recoveryRequired();
  }

  const owned = await readOwnedDirectoryEvidence(
    context,
    context.targetPath,
    targetIdentity,
    candidateFingerprint
  );
  const compatibleJournalPhases = {
    'validating-live': new Set(allowPreValidationJournal ? ['starting', 'validating-live'] : ['validating-live']),
    'committed-healthy': new Set(allowUnpublishedRevision
      ? ['validating-live', 'committed-healthy']
      : ['committed-healthy']),
    cleanup: new Set(['committed-healthy', 'cleanup', 'cleanup-pending']),
    'cleanup-pending': new Set(['committed-healthy', 'cleanup', 'cleanup-pending']),
    completed: new Set(['cleanup', 'cleanup-pending', 'completed'])
  }[record.phase];
  const journalRecord = owned.journalRecord;
  const preValidationJournal = validationPending && journalRecord.phase === 'starting';
  const journalBeforeCommittedEvidence = journalRecord.phase === 'validating-live';
  const expectedRecordSwapStep = record.phase === 'completed' ? 'cleanup-complete' : 'candidate-published';
  const expectedJournalSwapStep = journalRecord.phase === 'completed' ? 'cleanup-complete' : 'candidate-published';
  if (!compatibleJournalPhases?.has(journalRecord.phase) ||
      record.swapStep !== expectedRecordSwapStep || journalRecord.swapStep !== expectedJournalSwapStep ||
      !identityMatches(journalRecord.targetIdentity, targetIdentity) ||
      !identityMatches(journalRecord.rollbackIdentity, rollbackIdentity) ||
      candidateMarkerSha256 !== journalRecord.markerSha256 || candidateMarkerSha256 !== owned.marker.checksum ||
      journalRecord.rollbackFingerprint !== rollbackFingerprint ||
      (validationPending
        ? (journalRecord.revisionEventId !== null || journalRecord.revisionEventPublished !== false ||
          record.outcome?.revisionEvent !== undefined)
        : journalBeforeCommittedEvidence
        ? (journalRecord.revisionEventId !== null || journalRecord.revisionEventPublished !== false || revisionPublished)
        : (journalRecord.revisionEventId !== revisionEventId ||
          (!allowUnpublishedRevision && journalRecord.revisionEventPublished !== true) ||
          (journalRecord.revisionEventPublished && !revisionPublished)))) throw recoveryRequired();
  if (!preValidationJournal) return owned;
  const inspection = await inspectCandidate(context, context.targetPath);
  if (inspection.fingerprint !== candidateFingerprint ||
      !identityMatches(inspection.directoryIdentity, targetIdentity)) throw recoveryRequired();
  return { ...owned, inspection };
}

async function verifyCommittedCanonicalDirectory(contextValue) {
  const context = { ...assertExistingDependencies(contextValue, 'cleanup'), signal: undefined };
  const record = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['validating-live', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed'].includes(record.phase) ||
      record.swapStep !== (record.phase === 'completed' ? 'cleanup-complete' : 'candidate-published')) {
    throw recoveryRequired();
  }
  await verifyCommittedOwnedDirectory(context, record, {
    allowPreValidationJournal: record.phase === 'validating-live',
    allowUnpublishedRevision: record.phase === 'committed-healthy'
  });
  return deepFreeze({ phase: record.phase, verified: true });
}

async function verifyMutableOperationOwnedDirectory(contextValue, serverPathValue, expectedIdentity) {
  const context = { ...assertExistingDependencies(contextValue, 'cleanup'), signal: undefined };
  const record = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  const serverPath = normalizeServerDirectoryPath(serverPathValue);
  const targetSlot = pathAliasKey(serverPath) === pathAliasKey(context.targetPath);
  const failedSlot = pathAliasKey(serverPath) === pathAliasKey(context.expectedPaths.failedPath);
  const mutationAuthorized = record.phase === 'validating-live' || record.outcome?.liveMutationAuthorized === true ||
    record.outcome?.recovery?.reason === 'live-health-failed';
  if ((!targetSlot && !failedSlot) || !mutationAuthorized ||
      !['validating-live', 'rolling-back', 'rolled-back'].includes(record.phase)) throw recoveryRequired();

  const candidateFingerprint = record.outcome?.candidate?.fingerprint;
  const candidateMarkerSha256 = record.outcome?.candidate?.markerSha256;
  const rollbackIdentity = record.directoryIdentities?.rollback;
  const rollbackFingerprint = record.outcome?.rollback?.fingerprint;
  if (!candidateFingerprint || !candidateMarkerSha256 || !rollbackIdentity || !rollbackFingerprint) {
    throw recoveryRequired();
  }
  const owned = await readOwnedDirectoryEvidence(
    context,
    serverPath,
    expectedIdentity,
    candidateFingerprint
  );
  const journalRecord = owned.journalRecord;
  if (candidateMarkerSha256 !== journalRecord.markerSha256 ||
      candidateMarkerSha256 !== owned.marker.checksum ||
      !identityMatches(journalRecord.rollbackIdentity, rollbackIdentity) ||
      journalRecord.rollbackFingerprint !== rollbackFingerprint ||
      journalRecord.revisionEventId !== null || journalRecord.revisionEventPublished !== false) throw recoveryRequired();

  if (record.phase === 'validating-live') {
    if (!targetSlot || !identityMatches(record.directoryIdentities.target, expectedIdentity) ||
        !['starting', 'validating-live'].includes(journalRecord.phase) ||
        journalRecord.swapStep !== 'candidate-published' ||
        !identityMatches(journalRecord.targetIdentity, expectedIdentity) || journalRecord.failedIdentity !== null) {
      throw recoveryRequired();
    }
    if (journalRecord.phase === 'starting') {
      const inspection = await inspectCandidate(context, serverPath);
      if (inspection.fingerprint !== candidateFingerprint ||
          !identityMatches(inspection.directoryIdentity, expectedIdentity)) throw recoveryRequired();
      return { ...owned, inspection };
    }
  } else if (record.swapStep === 'candidate-published') {
    if (!identityMatches(record.directoryIdentities.target, expectedIdentity)) throw recoveryRequired();
    if (journalRecord.swapStep === 'candidate-published') {
      if ((!targetSlot && !failedSlot) || !['validating-live', 'rolling-back'].includes(journalRecord.phase) ||
          !identityMatches(journalRecord.targetIdentity, expectedIdentity) || journalRecord.failedIdentity !== null) {
        throw recoveryRequired();
      }
    } else if (journalRecord.swapStep === 'failed-canonical-moved') {
      if (!failedSlot || journalRecord.phase !== 'rolling-back' || journalRecord.targetIdentity !== null ||
          !identityMatches(journalRecord.failedIdentity, expectedIdentity)) throw recoveryRequired();
    } else {
      throw recoveryRequired();
    }
  } else if (record.swapStep === 'failed-canonical-moved') {
    if (!failedSlot || !identityMatches(record.directoryIdentities.failed, expectedIdentity)) throw recoveryRequired();
    if (journalRecord.swapStep === 'failed-canonical-moved') {
      if (journalRecord.phase !== 'rolling-back' || journalRecord.targetIdentity !== null ||
          !identityMatches(journalRecord.failedIdentity, expectedIdentity)) throw recoveryRequired();
    } else if (journalRecord.swapStep === 'rollback-restored') {
      if (journalRecord.phase !== 'rolled-back' ||
          !identityMatches(journalRecord.targetIdentity, rollbackIdentity) ||
          !identityMatches(journalRecord.failedIdentity, expectedIdentity)) throw recoveryRequired();
    } else {
      throw recoveryRequired();
    }
  } else if (record.swapStep === 'rollback-restored') {
    if (!failedSlot || !identityMatches(record.directoryIdentities.failed, expectedIdentity) ||
        !['rolling-back', 'rolled-back'].includes(journalRecord.phase) ||
        journalRecord.swapStep !== 'rollback-restored' ||
        !identityMatches(journalRecord.targetIdentity, record.directoryIdentities.target) ||
        !identityMatches(journalRecord.failedIdentity, expectedIdentity)) throw recoveryRequired();
  } else {
    throw recoveryRequired();
  }
  return owned;
}

function publicationOutcome(journalRecord, state) {
  return {
    publication: {
      state,
      targetAbsence: journalRecord.targetAbsence,
      candidateFingerprint: journalRecord.candidateFingerprint,
      markerSha256: journalRecord.markerSha256
    }
  };
}

async function finishPublishedState(context, expectedIdentity) {
  const owned = await verifyOwnedDirectory(context, context.targetPath, expectedIdentity);
  let journalRecord = owned.journalRecord;
  if (journalRecord.phase === 'publishing') {
    journalRecord = await owned.journal.transition(owned.locations.journalPath, {
      expectedPhase: 'publishing',
      nextPhase: 'published',
      patch: { swapStep: 'candidate-published', targetIdentity: owned.identity }
    });
    await yieldDurabilityControl(context);
  } else if (!['published', 'registering', 'registered'].includes(journalRecord.phase)) {
    throw recoveryRequired();
  }
  let record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (record.phase === 'publishing') {
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'publishing',
      nextPhase: 'published',
      patch: {
        journalPath: owned.locations.journalPath,
        swapStep: 'candidate-published',
        directoryIdentities: {
          target: owned.identity,
          candidate: expectedIdentity,
          rollback: null,
          failed: null
        },
        outcome: { ...(record.outcome || {}), ...publicationOutcome(journalRecord, 'published') }
      }
    });
    await yieldDurabilityControl(context);
  } else if (!['published', 'registering'].includes(record.phase)) {
    throw recoveryRequired();
  }
  return publicTransactionResult(
    context,
    'published',
    owned.identity,
    journalRecord.candidateFingerprint
  );
}

async function waitForPublicationRetry(context, delayMs) {
  try {
    if (context.publicationRetryDelay) await context.publicationRetryDelay(delayMs);
    else await new Promise(resolve => setTimeout(resolve, delayMs));
  } catch (error) {
    throw commitFailure(error);
  }
}

async function moveNewCandidateWithRetry(context, candidateIdentity, journalRecord) {
  let lastError = null;
  for (let attempt = 0; attempt <= NEW_PUBLICATION_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      if (entryStat(context.fsApi, context.targetPath) ||
          entryStat(context.fsApi, context.expectedPaths.failedPath)) throw targetExists();
      const owned = await verifyOwnedDirectory(
        context,
        context.expectedPaths.candidatePath,
        candidateIdentity,
        journalRecord.candidateFingerprint
      );
      if (owned.journalRecord.phase !== 'publishing' || owned.journalRecord.swapStep !== 'new-prepared' ||
          !owned.journalRecord.targetAbsence ||
          owned.journalRecord.targetAbsence.targetPathHash !== journalRecord.targetAbsence.targetPathHash ||
          owned.journalRecord.targetAbsence.targetNameHash !== journalRecord.targetAbsence.targetNameHash ||
          !identityMatches(owned.journalRecord.targetAbsence.parentIdentity, journalRecord.targetAbsence.parentIdentity)) {
        throw recoveryRequired();
      }
      await assertServerDirectoryIdentity(path.dirname(context.targetPath), journalRecord.targetAbsence.parentIdentity, {
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector,
        signal: context.signal
      });
      if (entryStat(context.fsApi, context.targetPath) ||
          entryStat(context.fsApi, context.expectedPaths.failedPath)) throw targetExists();
      await context.durableFs.renameDurableAsync(context.expectedPaths.candidatePath, context.targetPath);
      await yieldDurabilityControl(context);
      return;
    } catch (error) {
      if (error instanceof ModpackError && error.code === 'TARGET_EXISTS') throw error;
      lastError = error;
      const targetPresent = entryStat(context.fsApi, context.targetPath);
      const candidatePresent = entryStat(context.fsApi, context.expectedPaths.candidatePath);
      const failedPresent = entryStat(context.fsApi, context.expectedPaths.failedPath);
      if (targetPresent && !candidatePresent && !failedPresent) {
        await verifyOwnedDirectory(context, context.targetPath, candidateIdentity, journalRecord.candidateFingerprint);
        return;
      }
      if (targetPresent || failedPresent || !candidatePresent || attempt === NEW_PUBLICATION_RETRY_DELAYS_MS.length) {
        throw error instanceof ModpackError ? error : commitFailure(error);
      }

      await waitForPublicationRetry(context, NEW_PUBLICATION_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError instanceof ModpackError ? lastError : commitFailure(lastError);
}

async function publishNewCandidate(contextValue) {
  if (contextValue && typeof contextValue.targetPath === 'string' && entryStat(fs, contextValue.targetPath)) {
    if (!contextValue.recoveryRegistry) throw targetExists();
  }
  const context = assertDependencies(contextValue, 'publish');
  let record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  const candidateIdentity = record.directoryIdentities?.candidate;
  if (!candidateIdentity) throw recoveryRequired();

  if (entryStat(context.fsApi, context.targetPath)) {
    if (!['publishing', 'published', 'registering'].includes(record.phase) || record.swapStep === 'none') throw targetExists();
    return finishPublishedState(context, candidateIdentity);
  }
  if (record.phase === 'published' || record.phase === 'registering') throw recoveryRequired();
  if (!['committing', 'publishing'].includes(record.phase)) throw recoveryRequired();
  assertSiblingAliasesAbsent(context, { allowCandidate: true });
  const candidate = await verifyOwnedDirectory(
    context,
    context.expectedPaths.candidatePath,
    candidateIdentity,
    record.outcome?.candidate?.fingerprint || null
  );
  if (!['committing', 'publishing'].includes(candidate.journalRecord.phase)) throw recoveryRequired();
  const parentIdentity = await identifyParent(context);
  let journalRecord = candidate.journalRecord;
  const absence = await createTargetAbsenceEvidence(context.targetPath, parentIdentity, {
    clock: context.clock || (() => new Date()),
    fsApi: context.fsApi
  });
  if (journalRecord.targetPathHash !== absence.targetPathHash) throw recoveryRequired();
  if (journalRecord.phase === 'committing') {
    journalRecord = await candidate.journal.transition(candidate.locations.journalPath, {
      expectedPhase: 'committing',
      nextPhase: 'publishing',
      patch: { swapStep: 'new-prepared', targetAbsence: absence }
    });
    await yieldDurabilityControl(context);
  }
  if (!journalRecord.targetAbsence || journalRecord.targetAbsence.targetPathHash !== absence.targetPathHash ||
      journalRecord.targetAbsence.targetNameHash !== absence.targetNameHash ||
      !identityMatches(journalRecord.targetAbsence.parentIdentity, parentIdentity)) {
    throw recoveryRequired();
  }
  if (record.phase === 'committing') {
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'committing',
      nextPhase: 'publishing',
      patch: {
        swapStep: 'new-prepared',
        directoryIdentities: { target: null, candidate: candidateIdentity, rollback: null, failed: null },
        outcome: { ...(record.outcome || {}), ...publicationOutcome(journalRecord, 'publishing') }
      }
    });
    await yieldDurabilityControl(context);
  }
  if (record.phase !== 'publishing' || record.swapStep !== 'new-prepared') throw recoveryRequired();
  await moveNewCandidateWithRetry(context, candidateIdentity, journalRecord);
  return finishPublishedState(context, candidateIdentity);
}

async function verifyPublishedForRegistration(context, request) {
  if (request.jobId !== context.jobId || request.stableInstanceId !== context.stableInstanceId ||
      pathAliasKey(request.targetPath) !== pathAliasKey(context.targetPath)) throw recoveryRequired();
  const record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['published', 'registering'].includes(record.phase) || record.swapStep !== 'candidate-published' ||
      !identityMatches(record.directoryIdentities.target, request.directoryIdentity)) throw recoveryRequired();
  const owned = await verifyOwnedDirectory(
    context,
    context.targetPath,
    record.directoryIdentities.target,
    record.outcome?.publication?.candidateFingerprint || null
  );
  return Object.freeze({
    jobId: context.jobId,
    stableInstanceId: context.stableInstanceId,
    targetPath: context.targetPath,
    directoryIdentity: owned.identity
  });
}

async function registerPublishedInstance(contextValue) {
  const context = assertDependencies(contextValue, 'register');
  if (typeof context.name !== 'string' || !context.appStore || !context.instanceContext) throw invalid();
  let record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['published', 'registering'].includes(record.phase) || record.swapStep !== 'candidate-published' ||
      !record.directoryIdentities.target) throw recoveryRequired();
  const owned = await verifyOwnedDirectory(
    context,
    context.targetPath,
    record.directoryIdentities.target,
    record.outcome?.publication?.candidateFingerprint || null
  );
  let journalRecord = owned.journalRecord;
  if (journalRecord.phase === 'published') {
    journalRecord = await owned.journal.transition(owned.locations.journalPath, {
      expectedPhase: 'published',
      nextPhase: 'registering',
      patch: { registration: { instanceId: context.stableInstanceId, complete: false } }
    });
    await yieldDurabilityControl(context);
  } else if (!['registering', 'registered'].includes(journalRecord.phase)) {
    throw recoveryRequired();
  }
  if (record.phase === 'published') {
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'published',
      nextPhase: 'registering',
      patch: {
        outcome: {
          ...(record.outcome || {}),
          ...publicationOutcome(journalRecord, 'published'),
          registration: { instanceId: context.stableInstanceId, complete: false }
        }
      }
    });
    await yieldDurabilityControl(context);
  }
  const registry = context.instanceRegistry || new InstanceRegistry({
    appStore: context.appStore,
    instanceContext: context.instanceContext,
    verifyOwnership: request => verifyPublishedForRegistration(context, request)
  });
  if (!registry || typeof registry.registerPublishedInstance !== 'function') throw invalid();
  const result = await registry.registerPublishedInstance({
    jobId: context.jobId,
    stableInstanceId: context.stableInstanceId,
    name: context.name,
    targetPath: context.targetPath,
    directoryIdentity: owned.identity
  });
  if (journalRecord.phase === 'registering') {
    journalRecord = await owned.journal.transition(owned.locations.journalPath, {
      expectedPhase: 'registering',
      nextPhase: 'registered',
      patch: { registration: { instanceId: context.stableInstanceId, complete: true } }
    });
    await yieldDurabilityControl(context);
  }
  record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (record.phase !== 'registering') throw recoveryRequired();
  if (record.outcome?.registration?.complete !== true) {
    await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'registering',
      nextPhase: 'registering',
      patch: {
        outcome: {
          ...(record.outcome || {}),
          ...publicationOutcome(journalRecord, 'published'),
          registration: { instanceId: context.stableInstanceId, complete: true }
        }
      }
    });
    await yieldDurabilityControl(context);
  }
  return result;
}

function assertExistingRecordMatches(record, context) {
  if (!record || record.jobId !== context.jobId || record.operationKind !== context.operationKind ||
      record.target?.kind !== 'existing' || record.target.stableServerId !== context.stableInstanceId ||
      pathAliasKey(record.target.path) !== pathAliasKey(context.targetPath) ||
      pathAliasKey(record.candidatePath) !== pathAliasKey(context.expectedPaths.candidatePath) ||
      pathAliasKey(record.rollbackPath) !== pathAliasKey(context.expectedPaths.rollbackPath) ||
      pathAliasKey(record.failedPath) !== pathAliasKey(context.expectedPaths.failedPath)) throw recoveryRequired();
  return record;
}

function assertExistingDependencies(context, purpose) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.getPrototypeOf(context) !== Object.prototype) {
    throw invalid();
  }
  const targetPath = normalizeServerDirectoryPath(context.targetPath);
  const jobId = assertIdentifier(context.jobId);
  const stableInstanceId = assertIdentifier(context.stableInstanceId, INSTANCE_ID_PATTERN);
  if (!EXISTING_OPERATION_KINDS.has(context.operationKind)) throw invalid();
  const expectedPaths = createExistingSiblingPaths(targetPath, jobId);
  const fsApi = context.fsApi || fs;
  const fsPromises = filesystemPromises(context, fsApi);
  const durableFs = context.durableFs;
  const recoveryRegistry = context.recoveryRegistry;
  const mutationLease = context.mutationLease;
  const networkAccess = context.networkAccess ?? 'pack-default';
  if (!fsApi || ['lstatSync', 'mkdirSync', 'readdirSync']
    .some(method => typeof fsApi[method] !== 'function') ||
      !durableFs || typeof durableFs.flushDirectory !== 'function' || typeof durableFs.flushDirectoryAsync !== 'function' ||
      typeof durableFs.readFileBounded !== 'function' || typeof durableFs.readFileBoundedAsync !== 'function' ||
      typeof durableFs.writeJsonAtomicAsync !== 'function' ||
      !recoveryRegistry || typeof recoveryRegistry.load !== 'function' || typeof recoveryRegistry.transition !== 'function' ||
      !mutationLease || mutationLease.kind !== 'mutation' || mutationLease.instanceId !== stableInstanceId ||
      pathAliasKey(mutationLease.serverPath) !== pathAliasKey(targetPath) || typeof mutationLease.markDirty !== 'function' ||
      !context.reparseInspector || typeof context.reparseInspector.isReparsePoint !== 'function') throw invalid();
  if (context.onProgress !== undefined && typeof context.onProgress !== 'function') throw invalid();
  const validatesCandidate = context.validateCandidate !== false;
  const validatesLive = context.validateLive !== false;
  if ((validatesCandidate && (!context.healthValidator || typeof context.healthValidator.validateCandidate !== 'function')) ||
      (purpose === 'healthy' && validatesLive &&
        (!context.healthValidator || typeof context.healthValidator.validateLive !== 'function')) ||
      !context.runtime || typeof context.maxRam !== 'number' || !Number.isSafeInteger(context.healthTimeoutMs) ||
      context.healthTimeoutMs < 1 || context.healthTimeoutMs > MAX_SERVER_HEALTH_TIMEOUT_MS ||
      !Number.isSafeInteger(context.port) || context.port < 1 || context.port > 65535 ||
      !isNetworkAccess(networkAccess)) throw invalid();
  if (purpose === 'build' && (typeof context.applyIncoming !== 'function' || !context.stateRepository ||
      typeof context.stateRepository.read !== 'function' ||
      (typeof context.persistCandidateState !== 'function' && typeof context.stateRepository.writeCandidateAsync !== 'function') ||
      !context.candidateState || typeof context.candidateState !== 'object')) throw invalid();
  if (purpose === 'swap' && typeof durableFs.renameDurableAsync !== 'function') throw invalid();
  if (purpose === 'healthy' && (!context.revisionPublisher || typeof context.revisionPublisher.publishOnce !== 'function')) throw invalid();
  if (context.afterBoundary !== undefined && typeof context.afterBoundary !== 'function') throw invalid();
  if (context.authorizeSourceSnapshot !== undefined && typeof context.authorizeSourceSnapshot !== 'function') throw invalid();
  if (context.removeOwnedDirectory !== undefined && typeof context.removeOwnedDirectory !== 'function') throw invalid();
  if (context.freshCandidate !== undefined && typeof context.freshCandidate !== 'boolean') throw invalid();
  if (context.durabilityHandoff !== undefined && typeof context.durabilityHandoff !== 'function') throw invalid();
  if (context.yieldControl !== undefined && typeof context.yieldControl !== 'function') throw invalid();
  if (context.runtimePolicy !== undefined && (!context.runtimePolicy ||
      typeof context.runtimePolicy.adoptValidatedHandoff !== 'function')) throw invalid();
  if (context.forgeCandidateHealthAuthorization !== undefined &&
      (!context.forgeCandidateHealthAuthorization ||
       typeof context.forgeCandidateHealthAuthorization !== 'object')) throw invalid();
  return {
    ...context,
    targetPath,
    jobId,
    stableInstanceId,
    expectedPaths,
    fsApi,
    fsPromises,
    durableFs,
    recoveryRegistry,
    mutationLease,
    networkAccess
  };
}

function assertExistingSiblingSlots(context, allowances = {}) {
  const parent = path.dirname(context.targetPath);
  const slots = new Map([
    [path.basename(context.targetPath).normalize('NFC').toLocaleLowerCase('en-US'), 'target'],
    [path.basename(context.expectedPaths.candidatePath).normalize('NFC').toLocaleLowerCase('en-US'), 'candidate'],
    [path.basename(context.expectedPaths.rollbackPath).normalize('NFC').toLocaleLowerCase('en-US'), 'rollback'],
    [path.basename(context.expectedPaths.failedPath).normalize('NFC').toLocaleLowerCase('en-US'), 'failed']
  ]);
  const names = context.fsApi.readdirSync(parent);
  for (const name of names) {
    if (typeof name !== 'string') throw recoveryRequired();
    const slot = slots.get(name.normalize('NFC').toLocaleLowerCase('en-US'));
    if (!slot) continue;
    if (name !== name.normalize('NFC') || allowances[slot] !== true) throw targetExists();
  }
}

async function ensureExistingOperationLayout(context, candidatePath) {
  const locations = operationPaths(candidatePath, context.jobId);
  let parent = candidatePath;
  for (const directory of [locations.stateRoot, locations.manifestsRoot, locations.operationsRoot, locations.historyRoot]) {
    const stat = entryStat(context.fsApi, directory);
    if (!stat) {
      context.fsApi.mkdirSync(directory, { recursive: false, mode: 0o700 });
      await context.durableFs.flushDirectoryAsync(parent);
      await yieldDurabilityControl(context);
    } else {
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          pathAliasKey(context.fsApi.realpathSync.native(directory)) !== pathAliasKey(directory) ||
          await context.reparseInspector.isReparsePoint(directory, { signal: context.signal }) !== false) throw recoveryRequired();
    }
    if (directory === locations.stateRoot) parent = locations.stateRoot;
  }
  if (entryStat(context.fsApi, locations.operationRoot)) throw targetExists();
  await createDirectoryExclusive(context, locations.operationRoot);
  return locations;
}

async function exactFileSnapshot(context, serverPath, relativePath) {
  const filePath = path.join(serverPath, relativePath);
  const before = await entryStatAsync(context.fsPromises, filePath);
  if (!before) return deepFreeze({ bytes: null, existed: false, sha256: null });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > BigInt(MAX_SERVER_PROPERTIES_BYTES) ||
      await context.reparseInspector.isReparsePoint(filePath, { signal: context.signal }) !== false) throw recoveryRequired();
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const digest = crypto.createHash('sha256');
  const chunks = [];
  const chunk = Buffer.allocUnsafe(EXACT_SNAPSHOT_CHUNK_BYTES);
  let handle;
  let totalBytes = 0;
  let bytesSinceYield = 0;
  try {
    handle = await context.fsPromises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!sameExactFileStat(before, opened) || !opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n) {
      throw recoveryRequired();
    }
    if (opened.size > BigInt(MAX_SERVER_PROPERTIES_BYTES)) throw recoveryRequired();
    while (true) {
      const result = await handle.read(chunk, 0, chunk.length, null);
      const count = result?.bytesRead;
      if (!Number.isSafeInteger(count) || count < 0 || count > chunk.length) throw recoveryRequired();
      if (count === 0) break;
      if (!Number.isSafeInteger(totalBytes + count)) throw recoveryRequired();
      if (totalBytes + count > MAX_SERVER_PROPERTIES_BYTES) throw recoveryRequired();
      const bytes = Buffer.from(chunk.subarray(0, count));
      chunks.push(bytes);
      digest.update(bytes);
      totalBytes += count;
      bytesSinceYield += count;
      if (bytesSinceYield >= EXACT_SNAPSHOT_YIELD_BYTES) {
        await yieldCandidateControl(context);
        const current = await entryStatAsync(context.fsPromises, filePath);
        if (!current || !sameExactFileStat(opened, current)) throw recoveryRequired();
        bytesSinceYield = 0;
      }
    }
    if (bytesSinceYield > 0) await yieldCandidateControl(context);
    const closed = await handle.stat({ bigint: true });
    const after = await entryStatAsync(context.fsPromises, filePath);
    if (!after || !sameExactFileStat(opened, closed) || !sameExactFileStat(opened, after) ||
        BigInt(totalBytes) !== opened.size ||
        await context.reparseInspector.isReparsePoint(filePath, { signal: context.signal }) !== false) {
      throw recoveryRequired();
    }
    const final = await entryStatAsync(context.fsPromises, filePath);
    if (!final || !sameExactFileStat(opened, final)) throw recoveryRequired();
    return deepFreeze({
      bytes: Buffer.concat(chunks, totalBytes).toString('base64'),
      existed: true,
      sha256: digest.digest('hex')
    });
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* a failed verification remains failed closed */ }
    }
  }
}

function sameExactFileStat(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink);
}

async function assertExactFileSnapshot(context, serverPath, relativePath, expected) {
  const actual = await exactFileSnapshot(context, serverPath, relativePath);
  if (actual.existed !== expected.existed || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new ModpackError('HEALTH_CHECK_FAILED', 'Candidate validation did not restore the canonical server properties');
  }
  return actual;
}

function durableSnapshotMetadata(snapshot) {
  return deepFreeze({ existed: snapshot.existed, sha256: snapshot.sha256 });
}

function assertDurableSnapshotMetadata(actual, expected) {
  const valid = expected && typeof expected === 'object' && !Array.isArray(expected) &&
    typeof expected.existed === 'boolean' &&
    (expected.existed
      ? typeof expected.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(expected.sha256)
      : expected.sha256 === null);
  if (!valid || actual.existed !== expected.existed || actual.sha256 !== expected.sha256) {
    throw new ModpackError('HEALTH_CHECK_FAILED', 'Candidate validation did not preserve the canonical server properties');
  }
  return actual;
}

async function operationBoundary(context, name) {
  if (context.afterBoundary) await context.afterBoundary(name);
  await yieldDurabilityControl(context);
}

async function candidateProgress(context, phase, percent, message) {
  if (typeof context.onProgress === 'function') {
    await context.onProgress(deepFreeze({ phase, percent, message, currentItem: null }));
  }
  await yieldDurabilityControl(context);
}

function existingOutcome(record, patch) {
  return { ...(record.outcome || {}), ...patch };
}

async function buildExistingCandidate(contextValue) {
  const context = assertExistingDependencies(contextValue, 'build');
  let record = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['preflight', 'snapshotting'].includes(record.phase) || record.swapStep !== 'none' ||
      !record.restorePoint) {
    throw recoveryRequired();
  }
  const publishedRestoreCreation = record.restoreCreation;
  const publishedRestorePoint = record.restorePoint;
  const candidateHealthAuthorization = context.forgeCandidateHealthAuthorization;
  const hasPublishedRestoreProtection = isAppIssuedForgeCandidateHealthAuthorization(
    candidateHealthAuthorization,
    {
      candidatePath: context.expectedPaths.candidatePath,
      instanceId: context.stableInstanceId,
      jobId: context.jobId,
      operationKind: context.operationKind,
      restorePointId: publishedRestorePoint.id,
      restorePointSha256: publishedRestorePoint.sha256,
      runtime: context.runtime,
      serverPath: context.targetPath,
      sourceRevision: context.mutationLease.baseRevision
    }
  ) && publishedRestoreCreation?.schemaVersion === 1 &&
    publishedRestoreCreation.kind === 'minecraft-core-lifecycle-restore-creation' &&
    publishedRestoreCreation.operationId === context.jobId &&
    publishedRestoreCreation.state === 'published' &&
    publishedRestoreCreation.archiveSha256 === publishedRestorePoint.sha256 &&
    publishedRestoreCreation.sourceRevision === context.mutationLease.baseRevision;
  const planValidator = context.planValidator || assertPlanStillValid;
  planValidator(context.plan, context.currentSnapshot);
  assertExistingSiblingSlots(context, { target: true });
  await candidateProgress(context, 'staging', 36, 'Checking the live server content');
  const currentState = context.stateRepository.read(context.targetPath);
  const persistedSourceRevision = currentState?.state?.contentRevision;
  const targetRevision = context.candidateState.contentRevision;
  const coordinatorRevision = Number.isSafeInteger(context.mutationLease.baseRevision)
    ? context.mutationLease.baseRevision
    : persistedSourceRevision;
  const unmanagedSource = currentState === null || currentState?.state?.modpackManaged === false;
  const unmanagedAdoption = context.unmanagedAdoption === true && unmanagedSource;
  const sourceRevision = unmanagedAdoption ? coordinatorRevision : persistedSourceRevision;
  if ((!unmanagedAdoption && context.unmanagedAdoption === true) ||
      !Number.isSafeInteger(sourceRevision) || sourceRevision < 0 ||
      !Number.isSafeInteger(coordinatorRevision) || coordinatorRevision < sourceRevision ||
      coordinatorRevision >= Number.MAX_SAFE_INTEGER || targetRevision !== coordinatorRevision + 1) {
    throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
  }
  const exactLiveSource = await captureServerDirectoryCopySource(context.targetPath, {
    fsApi: context.fsApi,
    fsPromises: context.fsPromises,
    reparseInspector: context.reparseInspector,
    signal: context.signal,
    yieldControl: context.yieldControl
  });
  const liveInspection = deepFreeze({
    directoryIdentity: exactLiveSource.directoryIdentity,
    entryCount: exactLiveSource.entries.length,
    fingerprint: exactLiveSource.fingerprint,
    totalBytes: exactLiveSource.totalBytes
  });
  if (context.authorizeSourceSnapshot) {
    await context.authorizeSourceSnapshot(exactLiveSource);
    if (context.signal?.aborted) {
      throw new ModpackError('CANCELLED', 'The server directory operation was cancelled');
    }
  }
  const parentIdentity = await identifyParent(context);
  if (liveInspection.directoryIdentity.volumeSerial !== parentIdentity.volumeSerial) throw commitFailure();
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: record.phase,
    nextPhase: 'staging',
    patch: {
      restoreCreation: null,
      directoryIdentities: {
        target: liveInspection.directoryIdentity,
        candidate: null,
        rollback: null,
        failed: null
      },
      outcome: existingOutcome(record, { live: { fingerprint: liveInspection.fingerprint } })
    }
  });
  const transactionalRestoreProtected = hasPublishedRestoreProtection &&
    record.phase === 'staging' && record.restoreCreation === null &&
    record.restorePoint?.id === publishedRestorePoint.id &&
    record.restorePoint?.sha256 === publishedRestorePoint.sha256;
  context.mutationLease.markDirty();
  await operationBoundary(context, 'staging-recorded');
  await assertServerDirectoryIdentity(path.dirname(context.targetPath), parentIdentity, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector, signal: context.signal
  });
  assertExistingSiblingSlots(context, { target: true });
  const createdIdentity = await createDirectoryExclusive(context, context.expectedPaths.candidatePath);
  if (createdIdentity.volumeSerial !== liveInspection.directoryIdentity.volumeSerial) throw commitFailure();
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'staging',
    nextPhase: 'staging',
    patch: {
      directoryIdentities: {
        target: liveInspection.directoryIdentity,
        candidate: createdIdentity,
        rollback: null,
        failed: null
      }
    }
  });
  await operationBoundary(context, 'candidate-created');
  await candidateProgress(context, 'staging', 38, 'Copying the live server into a protected candidate');
  let lastCopyProgress = 0;
  const onCopyProgress = async event => {
    if (event.activity === 'copying-live-files') {
      const now = Date.now();
      if (now - lastCopyProgress < 1000 && event.completedItems !== event.totalItems) return;
      lastCopyProgress = now;
      await candidateProgress(context, 'staging', 38,
        `Copying server files (${event.completedItems} of ${event.totalItems} files, ${event.completedBytes} of ${event.totalBytes} bytes)`);
    } else if (event.activity === 'flushing-candidate-directories') {
      await candidateProgress(context, 'staging', 38, 'Flushing copied server directories');
    } else if (event.activity === 'verifying-candidate-copy') {
      await candidateProgress(context, 'staging', 38, 'Verifying the copied server files');
    }
  };
  const copyEvidence = context.freshCandidate
    ? {
        sourceIdentity: liveInspection.directoryIdentity,
        sourceFingerprint: liveInspection.fingerprint,
        destinationIdentity: createdIdentity,
        copiedBytes: '0',
        copiedFiles: '0'
      }
    : await copyServerDirectoryContents(context.targetPath, context.expectedPaths.candidatePath, {
        durableFs: context.durableFs,
        expectedSourceSnapshot: exactLiveSource,
        fsApi: context.fsApi,
        fsPromises: context.fsPromises,
        reparseInspector: context.reparseInspector,
        signal: context.signal,
        onCopyProgress,
        yieldControl: context.yieldControl
      });
  if (!identityMatches(copyEvidence.sourceIdentity, liveInspection.directoryIdentity) ||
      copyEvidence.sourceFingerprint !== liveInspection.fingerprint ||
      !identityMatches(copyEvidence.destinationIdentity, createdIdentity)) throw recoveryRequired();
  await candidateProgress(context, 'staging', 40, 'Live server copy verified');
  await operationBoundary(context, 'live-copied');

  const locations = await ensureExistingOperationLayout(context, context.expectedPaths.candidatePath);
  const marker = await writeMarker(context, locations.markerPath);
  const journal = createJournal(context);
  await journal.create(locations.journalPath, {
    jobId: context.jobId,
    operationKind: context.operationKind,
    stableInstanceId: context.stableInstanceId,
    targetPath: context.targetPath,
    candidateIdentity: createdIdentity,
    markerSha256: marker.checksum
  });
  await yieldDurabilityControl(context);
  await journal.transition(locations.journalPath, {
    expectedPhase: 'staging',
    nextPhase: 'staging',
    patch: { targetIdentity: liveInspection.directoryIdentity }
  });
  await yieldDurabilityControl(context);
  await journal.transition(locations.journalPath, {
    expectedPhase: 'staging', nextPhase: 'validating-candidate', patch: {}
  });
  await yieldDurabilityControl(context);
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'staging',
    nextPhase: 'validating-candidate',
    patch: {
      journalPath: locations.journalPath,
      directoryIdentities: {
        target: liveInspection.directoryIdentity,
        candidate: createdIdentity,
        rollback: null,
        failed: null
      },
      outcome: existingOutcome(record, {
        live: { fingerprint: liveInspection.fingerprint },
        revision: { source: coordinatorRevision, target: targetRevision }
      })
    }
  });
  await operationBoundary(context, 'candidate-validation-recorded');

  await candidateProgress(context, 'staging', 42, 'Reconciling reviewed modpack files');
  await context.applyIncoming(Object.freeze({
    candidatePath: context.expectedPaths.candidatePath,
    jobId: context.jobId,
    livePath: context.targetPath,
    plan: context.plan,
    signal: context.signal
  }));
  const validationPhase = context.validateCandidate === false ? 'staging' : 'validating-candidate';
  await candidateProgress(context, validationPhase, 50, 'Recording the candidate state');
  const writtenState = context.persistCandidateState
    ? await context.persistCandidateState(Object.freeze({
        candidatePath: context.expectedPaths.candidatePath,
        candidateState: context.candidateState,
        jobId: context.jobId,
        stateRepository: context.stateRepository
      }))
    : await context.stateRepository.writeCandidateAsync(
        context.expectedPaths.candidatePath,
        context.candidateState
      );
  if (writtenState?.state?.contentRevision !== targetRevision) throw recoveryRequired();
  await candidateProgress(context, validationPhase, 53, 'Checking candidate filesystem safety');
  const structureInspection = await inspectServerDirectoryStructure(context.expectedPaths.candidatePath, {
    fsApi: context.fsApi,
    fsPromises: context.fsPromises,
    reparseInspector: context.reparseInspector,
    signal: context.signal,
    yieldControl: context.yieldControl
  });
  if (!identityMatches(structureInspection.directoryIdentity, createdIdentity)) throw recoveryRequired();
  const canonicalProperties = await exactFileSnapshot(context, context.expectedPaths.candidatePath, 'server.properties');
  if (context.validateCandidate !== false) {
    await candidateProgress(context, validationPhase, 57, 'Boot-testing the candidate on loopback');
    await context.healthValidator.validateCandidate({
      candidatePath: context.expectedPaths.candidatePath,
      jobId: context.jobId,
      maxRam: context.maxRam,
      mutationLease: context.mutationLease,
      runtime: context.runtime,
      signal: context.signal,
      timeoutMs: context.healthTimeoutMs,
      // The flag is derived only after RecoveryRegistry accepts the durable
      // published-restore -> recorded-restore-point -> staging transition.
      // The untouched live directory remains canonical during this private
      // candidate boot; canonical, manual, and recovery boots never receive it.
      ...(transactionalRestoreProtected
        ? { forgeCandidateHealthAuthorization: candidateHealthAuthorization }
        : {})
    });
    await assertExactFileSnapshot(context, context.expectedPaths.candidatePath, 'server.properties', canonicalProperties);
  }
  await candidateProgress(context, validationPhase, 60,
    context.validateCandidate === false
      ? 'Hashing and durably recording candidate content'
      : 'Hashing and durably recording the validated candidate');
  const candidateInspection = await inspectAndFlushCandidate(context, context.expectedPaths.candidatePath);
  if (!identityMatches(candidateInspection.directoryIdentity, createdIdentity)) throw recoveryRequired();
  await candidateProgress(context, validationPhase, 62, 'Confirming the live server remained unchanged');
  const liveAfter = await inspectServerDirectoryTree(context.targetPath, {
    fsApi: context.fsApi,
    fsPromises: context.fsPromises,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
  if (!identityMatches(liveAfter.directoryIdentity, liveInspection.directoryIdentity) ||
      liveAfter.fingerprint !== liveInspection.fingerprint) throw recoveryRequired();

  await candidateProgress(context, validationPhase, 63, 'Sealing candidate integrity evidence');

  await journal.transition(locations.journalPath, {
    expectedPhase: 'validating-candidate',
    nextPhase: 'committing',
    patch: {
      swapStep: 'prepared',
      sourceFingerprint: liveInspection.fingerprint,
      candidateFingerprint: candidateInspection.fingerprint
    }
  });
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'validating-candidate',
    nextPhase: 'committing',
    patch: {
      swapStep: 'prepared',
      directoryIdentities: {
        target: liveInspection.directoryIdentity,
        candidate: createdIdentity,
        rollback: null,
        failed: null
      },
      outcome: existingOutcome(record, {
        candidate: {
          fingerprint: candidateInspection.fingerprint,
          markerSha256: marker.checksum,
          properties: { existed: canonicalProperties.existed, sha256: canonicalProperties.sha256 }
        },
        copy: { bytes: copyEvidence.copiedBytes, files: copyEvidence.copiedFiles },
        live: { fingerprint: liveInspection.fingerprint },
        revision: { source: coordinatorRevision, target: targetRevision },
        runtime: {
          maxRam: context.maxRam,
          networkAccess: context.networkAccess,
          port: context.port,
          source: unmanagedAdoption ? currentState?.state?.runtime ?? null : currentState.state.runtime || null,
          target: Object.hasOwn(context.candidateState, 'runtime')
            ? context.candidateState.runtime
            : context.runtime
        }
      })
    }
  });
  await operationBoundary(context, 'prepared');
  return publicTransactionResult(context, 'committing', createdIdentity, candidateInspection.fingerprint);
}

async function durableRenameWithIdentity(context, source, destination, expectedIdentity) {
  try {
    await context.durableFs.renameDurableAsync(source, destination);
  } catch (error) {
    const sourcePresent = entryStat(context.fsApi, source);
    const destinationPresent = entryStat(context.fsApi, destination);
    if (sourcePresent || !destinationPresent) throw commitFailure(error);
    try {
      await assertServerDirectoryIdentity(destination, expectedIdentity, {
        fsApi: context.fsApi, reparseInspector: context.reparseInspector
      });
    } catch {
      throw commitFailure(error);
    }
  }
  if (entryStat(context.fsApi, source)) throw recoveryRequired();
  return assertServerDirectoryIdentity(destination, expectedIdentity, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
}

async function swapExistingCandidate(contextValue) {
  const context = { ...assertExistingDependencies(contextValue, 'swap'), signal: undefined };
  let record = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (record.phase !== 'committing' || record.swapStep !== 'prepared' ||
      !record.directoryIdentities.target || !record.directoryIdentities.candidate) throw recoveryRequired();
  assertExistingSiblingSlots(context, { target: true, candidate: true });
  if (entryStat(context.fsApi, context.expectedPaths.rollbackPath) || entryStat(context.fsApi, context.expectedPaths.failedPath)) {
    throw targetExists();
  }
  await assertServerDirectoryIdentity(context.targetPath, record.directoryIdentities.target, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  const liveInspection = await inspectServerDirectoryTree(context.targetPath, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  if (liveInspection.fingerprint !== record.outcome?.live?.fingerprint) throw recoveryRequired();
  const candidate = await verifyOwnedDirectory(
    context,
    context.expectedPaths.candidatePath,
    record.directoryIdentities.candidate,
    record.outcome?.candidate?.fingerprint || null
  );
  if (candidate.journalRecord.phase !== 'committing' || candidate.journalRecord.swapStep !== 'prepared' ||
      !identityMatches(candidate.journalRecord.targetIdentity, record.directoryIdentities.target) ||
      candidate.journalRecord.sourceFingerprint !== record.outcome?.live?.fingerprint) throw recoveryRequired();
  if (record.directoryIdentities.target.volumeSerial !== record.directoryIdentities.candidate.volumeSerial) throw commitFailure();
  context.mutationLease.markDirty();

  const rollbackIdentity = await durableRenameWithIdentity(
    context,
    context.targetPath,
    context.expectedPaths.rollbackPath,
    record.directoryIdentities.target
  );
  const rollbackInspection = await inspectServerDirectoryTree(context.expectedPaths.rollbackPath, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  if (!identityMatches(rollbackInspection.directoryIdentity, rollbackIdentity) ||
      rollbackInspection.fingerprint !== record.outcome?.live?.fingerprint) throw recoveryRequired();
  await operationBoundary(context, 'live-renamed');
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'committing',
    nextPhase: 'committing',
    patch: {
      swapStep: 'live-moved',
      directoryIdentities: {
        target: record.directoryIdentities.target,
        candidate: record.directoryIdentities.candidate,
        rollback: rollbackIdentity,
        failed: null
      },
      outcome: existingOutcome(record, {
        rollback: { fingerprint: rollbackInspection.fingerprint },
        swap: { step: 'live-moved' }
      })
    }
  });
  await candidate.journal.transition(candidate.locations.journalPath, {
    expectedPhase: 'committing',
    nextPhase: 'committing',
    patch: {
      swapStep: 'live-moved',
      rollbackIdentity,
      rollbackFingerprint: rollbackInspection.fingerprint
    }
  });
  await operationBoundary(context, 'live-moved');

  const publishedIdentity = await durableRenameWithIdentity(
    context,
    context.expectedPaths.candidatePath,
    context.targetPath,
    record.directoryIdentities.candidate
  );
  await operationBoundary(context, 'candidate-renamed');
  const published = await verifyOwnedDirectory(
    context,
    context.targetPath,
    publishedIdentity,
    record.outcome?.candidate?.fingerprint || null
  );
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'committing',
    nextPhase: 'starting',
    patch: {
      journalPath: published.locations.journalPath,
      swapStep: 'candidate-published',
      directoryIdentities: {
        target: publishedIdentity,
        candidate: record.directoryIdentities.candidate,
        rollback: rollbackIdentity,
        failed: null
      },
      outcome: existingOutcome(record, { swap: { step: 'candidate-published' } })
    }
  });
  await published.journal.transition(published.locations.journalPath, {
    expectedPhase: 'committing',
    nextPhase: 'starting',
    patch: { swapStep: 'candidate-published', targetIdentity: publishedIdentity, rollbackIdentity }
  });
  await operationBoundary(context, 'candidate-published');
  return publicTransactionResult(
    context,
    'starting',
    publishedIdentity,
    record.outcome?.candidate?.fingerprint
  );
}

function revisionEvent(context, record) {
  const revision = record.outcome?.revision?.target;
  if (!Number.isSafeInteger(revision) || revision < 1) throw recoveryRequired();
  return deepFreeze({
    eventId: `modpack-content-revision:${context.jobId}:${revision}`,
    instanceId: context.stableInstanceId,
    operationKind: context.operationKind,
    targetRevision: revision
  });
}

async function markCommittedHealthy(contextValue) {
  const context = { ...assertExistingDependencies(contextValue, 'healthy'), signal: undefined };
  let record = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (!['starting', 'validating-live', 'committed-healthy'].includes(record.phase) ||
      record.swapStep !== 'candidate-published' || !record.directoryIdentities.target ||
      !record.directoryIdentities.rollback) throw recoveryRequired();
  const initialPhase = record.phase;
  const owned = initialPhase === 'starting'
    ? await verifyOwnedDirectory(
        context,
        context.targetPath,
        record.directoryIdentities.target,
        record.outcome?.candidate?.fingerprint || null
      )
    : await verifyCommittedOwnedDirectory(context, record, {
        allowPreValidationJournal: initialPhase === 'validating-live',
        allowUnpublishedRevision: record.phase === 'committed-healthy'
      });
  await assertServerDirectoryIdentity(context.expectedPaths.rollbackPath, record.directoryIdentities.rollback, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  const rollbackInspection = await inspectServerDirectoryTree(context.expectedPaths.rollbackPath, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  if (!identityMatches(rollbackInspection.directoryIdentity, record.directoryIdentities.rollback) ||
      rollbackInspection.fingerprint !== record.outcome?.rollback?.fingerprint) throw recoveryRequired();
  const canonicalProperties = initialPhase === 'committed-healthy'
    ? null
    : await exactFileSnapshot(context, context.targetPath, 'server.properties');
  let journalRecord = owned.journalRecord;
  if (record.outcome?.candidate?.markerSha256 !== journalRecord.markerSha256 ||
      record.outcome?.candidate?.markerSha256 !== owned.marker.checksum ||
      !identityMatches(journalRecord.rollbackIdentity, record.directoryIdentities.rollback) ||
      journalRecord.rollbackFingerprint !== record.outcome?.rollback?.fingerprint) throw recoveryRequired();
  if (initialPhase === 'starting') {
    const publishedJournal = journalRecord.phase === 'starting' &&
      journalRecord.swapStep === 'candidate-published' &&
      identityMatches(journalRecord.targetIdentity, record.directoryIdentities.target) &&
      journalRecord.failedIdentity === null;
    const registryAheadJournal = journalRecord.phase === 'committing' &&
      journalRecord.swapStep === 'live-moved' &&
      identityMatches(journalRecord.targetIdentity, record.directoryIdentities.rollback) &&
      journalRecord.failedIdentity === null;
    if ((!publishedJournal && !registryAheadJournal) || journalRecord.revisionEventId !== null ||
        journalRecord.revisionEventPublished !== false) throw recoveryRequired();
    if (registryAheadJournal) {
      journalRecord = await owned.journal.transition(owned.locations.journalPath, {
        expectedPhase: 'committing',
        nextPhase: 'starting',
        patch: {
          swapStep: 'candidate-published',
          targetIdentity: record.directoryIdentities.target,
          rollbackIdentity: record.directoryIdentities.rollback
        }
      });
    }
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'starting',
      nextPhase: 'validating-live',
      patch: {
        outcome: existingOutcome(record, {
          liveValidation: { properties: durableSnapshotMetadata(canonicalProperties) }
        })
      }
    });
    if (journalRecord.phase === 'starting') {
      journalRecord = await owned.journal.transition(owned.locations.journalPath, {
        expectedPhase: 'starting', nextPhase: 'validating-live', patch: {}
      });
    }
    await operationBoundary(context, 'validating-live');
  } else if (initialPhase === 'validating-live') {
    let expectedProperties = record.outcome?.liveValidation?.properties;
    if (!expectedProperties && journalRecord.phase === 'starting') {
      expectedProperties = durableSnapshotMetadata(canonicalProperties);
      record = await context.recoveryRegistry.transition(context.jobId, {
        expectedPhase: 'validating-live',
        nextPhase: 'validating-live',
        patch: {
          outcome: existingOutcome(record, {
            liveValidation: { properties: expectedProperties }
          })
        }
      });
    }
    assertDurableSnapshotMetadata(canonicalProperties, expectedProperties);
    if (journalRecord.phase === 'starting') {
      journalRecord = await owned.journal.transition(owned.locations.journalPath, {
        expectedPhase: 'starting', nextPhase: 'validating-live', patch: {}
      });
      await operationBoundary(context, 'validating-live');
    }
  }
  if (record.phase === 'validating-live') {
    const targetRunning = record.outcome?.runtimePolicy?.targetRunning ?? record.priorRuntime.running;
    const validation = context.validateLive === false
      ? { evidence: { skipped: true, reason: 'unmanaged-files-only' }, handoff: null }
      : await context.healthValidator.validateLive({
          instanceId: context.stableInstanceId,
          jobId: context.jobId,
          keepRunning: targetRunning,
          maxRam: context.maxRam,
          mutationLease: context.mutationLease,
          networkAccess: context.networkAccess,
          port: context.port,
          runtime: context.runtime,
          serverPath: context.targetPath,
          signal: undefined,
          timeoutMs: context.healthTimeoutMs
        });
    let event;
    let adoptedHandoff = null;
    try {
      await assertExactFileSnapshot(context, context.targetPath, 'server.properties', canonicalProperties);
      event = revisionEvent(context, record);
      if (targetRunning && context.validateLive !== false) {
        adoptedHandoff = await adoptExistingValidatedHandoff(context, validation?.handoff);
      }
    } catch (error) {
      if (validation?.handoff && !adoptedHandoff) {
        await stopExistingValidatedHandoffAfterFailure(validation.handoff, error);
      }
      throw error;
    }
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'validating-live',
      nextPhase: 'committed-healthy',
      patch: {
        outcome: existingOutcome(record, {
          health: validation?.evidence || validation || { ok: true },
          runtimePolicy: {
            ...(record.outcome?.runtimePolicy || {}),
            handoffEventId: targetRunning && context.validateLive !== false
              ? `modpack-runtime-handoff:${context.jobId}`
              : null,
            runningRestored: targetRunning && context.validateLive !== false ? Boolean(adoptedHandoff) : false
          },
          revisionEvent: { eventId: event.eventId, published: false },
          ...(context.releaseTrackingIntent ? { releaseTracking: context.releaseTrackingIntent } : {}),
          swap: { step: 'candidate-published' }
        })
      }
    });
    if (journalRecord.phase === 'validating-live') {
      await owned.journal.transition(owned.locations.journalPath, {
        expectedPhase: 'validating-live',
        nextPhase: 'committed-healthy',
        patch: { revisionEventId: event.eventId, revisionEventPublished: false }
      });
    }
    await operationBoundary(context, 'committed-healthy');
  }
  if (record.phase !== 'committed-healthy') throw recoveryRequired();
  const event = revisionEvent(context, record);
  if (record.outcome?.revisionEvent?.eventId !== event.eventId) throw recoveryRequired();
  let durableJournal = createJournal(context).load(owned.locations.journalPath);
  if (durableJournal.phase === 'validating-live') {
    durableJournal = await createJournal(context).transition(owned.locations.journalPath, {
      expectedPhase: 'validating-live',
      nextPhase: 'committed-healthy',
      patch: { revisionEventId: event.eventId, revisionEventPublished: false }
    });
  }
  if (durableJournal.phase !== 'committed-healthy' || durableJournal.revisionEventId !== event.eventId) {
    throw recoveryRequired();
  }
  if (record.outcome.revisionEvent.published !== true) {
    await context.revisionPublisher.publishOnce(event);
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'committed-healthy',
      nextPhase: 'committed-healthy',
      patch: {
        outcome: existingOutcome(record, {
          revisionEvent: { eventId: event.eventId, published: true }
        })
      }
    });
    await operationBoundary(context, 'revision-published');
  }
  durableJournal = createJournal(context).load(owned.locations.journalPath);
  if (!durableJournal.revisionEventPublished) {
    await createJournal(context).transition(owned.locations.journalPath, {
      expectedPhase: 'committed-healthy',
      nextPhase: 'committed-healthy',
      patch: { revisionEventId: event.eventId, revisionEventPublished: true }
    });
  }
  return deepFreeze({
    eventId: event.eventId,
    handoffExpected: context.validateLive === false
      ? false
      : record.outcome?.runtimePolicy?.targetRunning ?? record.priorRuntime.running,
    phase: 'committed-healthy',
    revision: event.targetRevision
  });
}

async function removeDirectoryByIdentity(context, directoryPath, expectedIdentity) {
  let removedEntries = 0;
  let lastCleanupYieldAt = Date.now();
  const directoriesByDepth = [];
  const yieldAfterRemoval = async (currentDirectory, currentIdentity) => {
    removedEntries += 1;
    const now = Date.now();
    if (removedEntries % CLEANUP_YIELD_BATCH !== 0 &&
        now - lastCleanupYieldAt < CLEANUP_YIELD_INTERVAL_MS) return;
    await yieldCandidateControl(context);
    lastCleanupYieldAt = Date.now();
    await assertServerDirectoryIdentity(currentDirectory, currentIdentity, {
      fsApi: context.fsApi,
      fsPromises: context.fsPromises,
      reparseInspector: context.reparseInspector
    });
  };
  await assertServerDirectoryIdentity(directoryPath, expectedIdentity, {
    fsApi: context.fsApi, fsPromises: context.fsPromises, reparseInspector: context.reparseInspector
  });
  async function removeFiles(directory, currentIdentity, depth, parent = null) {
    const names = await context.fsPromises.readdir(directory);
    names.sort((left, right) => left.localeCompare(right, 'en-US'));
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0 || name !== name.normalize('NFC') || name === '.' || name === '..' ||
          name.includes('\0') || name.includes('/') || name.includes('\\')) throw recoveryRequired();
      const candidate = path.join(directory, name);
      const before = await entryStatAsync(context.fsPromises, candidate);
      if (!before || before.isSymbolicLink() ||
          await context.reparseInspector.isReparsePoint(candidate) !== false) throw recoveryRequired();
      if (before.isDirectory()) {
        const identity = await identifyServerDirectory(candidate, {
          fsApi: context.fsApi, fsPromises: context.fsPromises, reparseInspector: context.reparseInspector
        });
        await removeFiles(candidate, identity, depth + 1, {
          directoryPath: directory,
          identity: currentIdentity
        });
      } else if (before.isFile() && before.nlink === 1n) {
        const after = await entryStatAsync(context.fsPromises, candidate);
        if (!after || after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs ||
            after.nlink !== 1n) throw recoveryRequired();
        await context.fsPromises.unlink(candidate);
        await yieldAfterRemoval(directory, currentIdentity);
      } else {
        throw recoveryRequired();
      }
    }
    directoriesByDepth[depth] ||= [];
    directoriesByDepth[depth].push({ directoryPath: directory, identity: currentIdentity, parent });
  }
  await removeFiles(directoryPath, expectedIdentity, 0);
  for (let depth = directoriesByDepth.length - 1; depth >= 0; depth -= 1) {
    const directories = directoriesByDepth[depth];
    await flushDirectoryBatch(context, directories.map(entry => entry.directoryPath));
    for (const directory of directories) {
      await assertServerDirectoryIdentity(directory.directoryPath, directory.identity, {
        fsApi: context.fsApi, fsPromises: context.fsPromises, reparseInspector: context.reparseInspector
      });
      await context.fsPromises.rmdir(directory.directoryPath);
      if (directory.parent) {
        await yieldAfterRemoval(directory.parent.directoryPath, directory.parent.identity);
      }
    }
  }
}

async function reconcileCompletedCleanup(context, record) {
  const owned = await verifyCommittedOwnedDirectory(context, record);
  if (await entryStatAsync(context.fsPromises, context.expectedPaths.rollbackPath)) throw recoveryRequired();
  let journalRecord = owned.journalRecord;
  if (['cleanup', 'cleanup-pending'].includes(journalRecord.phase)) {
    journalRecord = await owned.journal.transition(owned.locations.journalPath, {
      expectedPhase: journalRecord.phase,
      nextPhase: 'completed',
      patch: { swapStep: 'cleanup-complete' }
    });
  }
  if (journalRecord.phase !== 'completed' || journalRecord.swapStep !== 'cleanup-complete') {
    throw recoveryRequired();
  }
  return deepFreeze({ phase: 'completed', rollbackRemoved: true });
}

async function cleanupCommittedTransaction(contextValue) {
  const context = { ...assertExistingDependencies(contextValue, 'cleanup'), signal: undefined };
  let record = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (record.phase === 'completed' && record.swapStep === 'cleanup-complete') {
    return reconcileCompletedCleanup(context, record);
  }
  if (!['committed-healthy', 'cleanup', 'cleanup-pending'].includes(record.phase) ||
      record.swapStep !== 'candidate-published' || record.outcome?.revisionEvent?.published !== true) {
    throw recoveryRequired();
  }
  const owned = await verifyCommittedOwnedDirectory(context, record);
  let journalRecord = owned.journalRecord;
  try {
    const rollbackPresent = Boolean(await entryStatAsync(context.fsPromises, context.expectedPaths.rollbackPath));
    let deletionAuthorized = record.outcome?.cleanup?.deletionAuthorized === true;
    if (rollbackPresent) {
      await assertServerDirectoryIdentity(context.expectedPaths.rollbackPath, record.directoryIdentities.rollback, {
        fsApi: context.fsApi, fsPromises: context.fsPromises, reparseInspector: context.reparseInspector
      });
      if (!deletionAuthorized) {
        const rollbackInspection = await inspectServerDirectoryTree(context.expectedPaths.rollbackPath, {
          fsApi: context.fsApi, fsPromises: context.fsPromises, reparseInspector: context.reparseInspector
        });
        if (!identityMatches(rollbackInspection.directoryIdentity, record.directoryIdentities.rollback) ||
            rollbackInspection.fingerprint !== record.outcome?.rollback?.fingerprint) throw recoveryRequired();
      }
    } else if (!deletionAuthorized) {
      throw recoveryRequired();
    }
    if (!deletionAuthorized) {
      record = await context.recoveryRegistry.transition(context.jobId, {
        expectedPhase: record.phase,
        nextPhase: record.phase,
        patch: {
          outcome: existingOutcome(record, {
            cleanup: { ...(record.outcome?.cleanup || {}), deletionAuthorized: true, rollbackRemoved: false }
          })
        }
      });
      await yieldDurabilityControl(context);
      deletionAuthorized = true;
    }
    if (record.phase === 'cleanup' && ['committed-healthy', 'cleanup-pending'].includes(journalRecord.phase)) {
      journalRecord = await owned.journal.transition(owned.locations.journalPath, {
        expectedPhase: journalRecord.phase, nextPhase: 'cleanup', patch: {}
      });
    }
    if (record.phase === 'committed-healthy' || record.phase === 'cleanup-pending') {
      const priorPhase = record.phase;
      record = await context.recoveryRegistry.transition(context.jobId, {
        expectedPhase: priorPhase, nextPhase: 'cleanup', patch: {}
      });
      if (journalRecord.phase === priorPhase ||
          (priorPhase === 'cleanup-pending' && ['committed-healthy', 'cleanup-pending'].includes(journalRecord.phase))) {
        journalRecord = await owned.journal.transition(owned.locations.journalPath, {
          expectedPhase: journalRecord.phase, nextPhase: 'cleanup', patch: {}
        });
      }
    }
    if (record.phase !== 'cleanup' || journalRecord.phase !== 'cleanup') throw recoveryRequired();
    await operationBoundary(context, 'cleanup-started');
    if (rollbackPresent) {
      await assertServerDirectoryIdentity(context.targetPath, record.directoryIdentities.target, {
        fsApi: context.fsApi, fsPromises: context.fsPromises, reparseInspector: context.reparseInspector
      });
      if (context.removeOwnedDirectory) {
        await context.removeOwnedDirectory({
          directoryIdentity: record.directoryIdentities.rollback,
          directoryPath: context.expectedPaths.rollbackPath,
          jobId: context.jobId
        });
      } else {
        await removeDirectoryByIdentity(context, context.expectedPaths.rollbackPath, record.directoryIdentities.rollback);
      }
    }
    await flushCleanupDirectory(context, path.dirname(context.expectedPaths.rollbackPath));
    await operationBoundary(context, 'rollback-removed');
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'cleanup',
      nextPhase: 'completed',
      patch: {
        swapStep: 'cleanup-complete',
        outcome: existingOutcome(record, {
          cleanup: { ...(record.outcome?.cleanup || {}), deletionAuthorized: true, rollbackRemoved: true }
        })
      }
    });
    if (journalRecord.phase === 'cleanup') {
      await owned.journal.transition(owned.locations.journalPath, {
        expectedPhase: 'cleanup', nextPhase: 'completed', patch: { swapStep: 'cleanup-complete' }
      });
    }
    await operationBoundary(context, 'cleanup-complete');
    return deepFreeze({ phase: record.phase, rollbackRemoved: true });
  } catch (error) {
    const latest = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
    if (latest.phase === 'completed' && latest.swapStep === 'cleanup-complete') {
      try {
        return await reconcileCompletedCleanup(context, latest);
      } catch (reconcileError) {
        return deepFreeze({
          errorCode: reconcileError?.code || error?.code || 'COMMIT_FAILED',
          phase: 'cleanup-pending',
          rollbackRemoved: true
        });
      }
    }
    if (latest.phase === 'cleanup') {
      try {
        await context.recoveryRegistry.transition(context.jobId, {
          expectedPhase: 'cleanup',
          nextPhase: 'cleanup-pending',
          patch: {
            outcome: existingOutcome(latest, {
              cleanup: { ...(latest.outcome?.cleanup || {}), rollbackRemoved: false }
            })
          }
        });
      } catch { /* the existing durable cleanup record still preserves healthy-canonical authority */ }
    }
    try {
      const currentJournal = createJournal(context).load(operationPaths(context.targetPath, context.jobId).journalPath);
      if (currentJournal.phase === 'cleanup') {
        await createJournal(context).transition(operationPaths(context.targetPath, context.jobId).journalPath, {
          expectedPhase: 'cleanup', nextPhase: 'cleanup-pending', patch: {}
        });
      }
    } catch { /* registry evidence is authoritative for recovery */ }
    return deepFreeze({ errorCode: error?.code || 'COMMIT_FAILED', phase: 'cleanup-pending', rollbackRemoved: false });
  }
}

module.exports = {
  buildExistingCandidate,
  buildNewCandidate,
  cleanupCommittedTransaction,
  completeNewLiveValidation,
  createExistingSiblingPaths,
  createSiblingPaths,
  markCommittedHealthy,
  prepareNewLiveValidation,
  publishNewCandidate,
  registerPublishedInstance,
  swapExistingCandidate,
  verifyCommittedCanonicalDirectory,
  verifyCommittedNewPublication,
  verifyPublishedNewCandidate,
  verifyMutableNewOperationOwnedDirectory,
  verifyMutableOperationOwnedDirectory,
  verifyOperationOwnedDirectory: verifyOwnedDirectory
};
