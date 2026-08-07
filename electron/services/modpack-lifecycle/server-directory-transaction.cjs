const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
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
  copyServerDirectoryContents,
  identifyServerDirectory,
  inspectServerDirectoryTree,
  normalizeServerDirectoryPath
} = require('./server-directory-identity.cjs');
const { InstanceRegistry } = require('./instance-registry.cjs');

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_KINDS = new Set(['install', 'import']);
const EXISTING_OPERATION_KINDS = new Set([
  'install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback', 'import', 'uninstall', 'detach'
]);
const MARKER_FILE = 'directory-marker.json';
const JOURNAL_FILE = 'journal.json';

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
    const prefix = `.${label}.minecraft-core.${jobId}`;
    const candidatePath = path.win32.join(parent, `${prefix}.candidate`);
    const failedPath = path.win32.join(parent, `${prefix}.failed`);
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
  const rollbackPath = path.win32.join(
    path.win32.dirname(base.targetPath),
    `.${label}.minecraft-core.${jobId}.rollback`
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
  const durableFs = context.durableFs;
  const recoveryRegistry = context.recoveryRegistry;
  const mutationLease = context.mutationLease;
  const reparseInspector = context.reparseInspector;
  if (!fsApi || typeof fsApi.lstatSync !== 'function' || typeof fsApi.readdirSync !== 'function' ||
      !durableFs || typeof durableFs.flushDirectory !== 'function' || typeof durableFs.readFileBounded !== 'function' ||
      typeof durableFs.renameDurable !== 'function' || typeof durableFs.writeJsonAtomic !== 'function' ||
      !recoveryRegistry || typeof recoveryRegistry.load !== 'function' || typeof recoveryRegistry.transition !== 'function' ||
      !mutationLease || mutationLease.kind !== 'mutation' || mutationLease.instanceId !== stableInstanceId ||
      pathAliasKey(mutationLease.serverPath) !== pathAliasKey(targetPath) || typeof mutationLease.markDirty !== 'function' ||
      !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function') throw invalid();
  const common = {
    ...context,
    targetPath,
    jobId,
    stableInstanceId,
    expectedPaths,
    fsApi,
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
        (!customPersistence && typeof context.stateRepository.writeCandidate !== 'function') ||
        (validatesRuntime && (!context.healthValidator || typeof context.healthValidator.validateCandidate !== 'function' ||
          !context.runtime || typeof context.maxRam !== 'number' || !Number.isSafeInteger(context.healthTimeoutMs) ||
          context.healthTimeoutMs < 1 || context.healthTimeoutMs > 300000))) throw invalid();
  }
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
    context.durableFs.flushDirectory(path.dirname(directoryPath));
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

function writeMarker(context, markerPath) {
  const marker = createDirectoryMarker({
    jobId: context.jobId,
    operationKind: context.operationKind,
    stableInstanceId: context.stableInstanceId,
    createdAt: markerTime(context)
  });
  try {
    context.durableFs.writeJsonAtomic(markerPath, marker, { expectedTargetSha256: null });
    context.durableFs.flushDirectory(path.dirname(markerPath));
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
    reparseInspector: context.reparseInspector,
    signal: context.signal,
    mutableRelativePaths: [operationPaths(serverPath, context.jobId).mutableJournalRelativePath]
  };
}

async function inspectCandidate(context, serverPath) {
  return inspectServerDirectoryTree(serverPath, treeOptions(context, serverPath));
}

async function flushCandidateTree(context, serverPath) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fsApi = context.fsApi;
  async function visit(directory) {
    const names = fsApi.readdirSync(directory);
    names.sort((left, right) => left.localeCompare(right, 'en-US'));
    for (const name of names) {
      const candidate = path.join(directory, name);
      const stat = entryStat(fsApi, candidate);
      if (!stat || stat.isSymbolicLink()) throw recoveryRequired();
      const reparse = await context.reparseInspector.isReparsePoint(candidate, { signal: context.signal });
      if (reparse !== false) throw recoveryRequired();
      if (stat.isDirectory()) {
        await visit(candidate);
      } else if (stat.isFile() && stat.nlink === 1n) {
        let descriptor;
        try {
          descriptor = fsApi.openSync(candidate, fs.constants.O_RDWR | noFollow);
          const opened = fsApi.fstatSync(descriptor, { bigint: true });
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1n) {
            throw recoveryRequired();
          }
          fsApi.fsyncSync(descriptor);
        } finally {
          if (descriptor !== undefined) fsApi.closeSync(descriptor);
        }
      } else {
        throw recoveryRequired();
      }
    }
    context.durableFs.flushDirectory(directory);
  }
  try { await visit(serverPath); } catch (error) { throw commitFailure(error); }
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
  const record = assertRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (record.phase !== 'preflight') throw recoveryRequired();
  const planValidator = context.planValidator || assertPlanStillValid;
  planValidator(context.plan, context.currentSnapshot);
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
  const createdLocations = await ensureOperationLayout(context, context.expectedPaths.candidatePath);
  const marker = writeMarker(context, createdLocations.markerPath);
  const journal = createJournal(context);
  journal.create(createdLocations.journalPath, {
    jobId: context.jobId,
    operationKind: context.operationKind,
    stableInstanceId: context.stableInstanceId,
    targetPath: context.targetPath,
    candidateIdentity,
    markerSha256: marker.checksum
  });
  journal.transition(createdLocations.journalPath, {
    expectedPhase: 'staging', nextPhase: 'validating-candidate', patch: {}
  });
  await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'staging',
    nextPhase: 'validating-candidate',
    patch: {
      directoryIdentities: { target: null, candidate: candidateIdentity, rollback: null, failed: null }
    }
  });

  await context.materializeCandidate(Object.freeze({
    candidatePath: context.expectedPaths.candidatePath,
    jobId: context.jobId,
    signal: context.signal
  }));
  if (context.persistCandidateState) {
    await context.persistCandidateState(Object.freeze({
      candidatePath: context.expectedPaths.candidatePath,
      candidateState: context.candidateState,
      jobId: context.jobId,
      stateRepository: context.stateRepository
    }));
  } else {
    await context.stateRepository.writeCandidate(context.expectedPaths.candidatePath, context.candidateState);
  }
  await inspectCandidate(context, context.expectedPaths.candidatePath);
  await flushCandidateTree(context, context.expectedPaths.candidatePath);
  if (context.validateCandidate !== false) {
    await context.healthValidator.validateCandidate({
      candidatePath: context.expectedPaths.candidatePath,
      jobId: context.jobId,
      maxRam: context.maxRam,
      mutationLease: context.mutationLease,
      runtime: context.runtime,
      signal: context.signal,
      timeoutMs: context.healthTimeoutMs
    });
    await flushCandidateTree(context, context.expectedPaths.candidatePath);
  }
  const finalInspection = await inspectCandidate(context, context.expectedPaths.candidatePath);
  if (!identityMatches(finalInspection.directoryIdentity, candidateIdentity)) throw recoveryRequired();

  journal.transition(createdLocations.journalPath, {
    expectedPhase: 'validating-candidate',
    nextPhase: 'committing',
    patch: { candidateFingerprint: finalInspection.fingerprint }
  });
  await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: 'validating-candidate',
    nextPhase: 'committing',
    patch: {
      directoryIdentities: { target: null, candidate: candidateIdentity, rollback: null, failed: null },
      outcome: {
        ...(record.outcome || {}),
        candidate: { fingerprint: finalInspection.fingerprint, markerSha256: marker.checksum }
      }
    }
  });
  return publicTransactionResult(context, 'committing', candidateIdentity, finalInspection.fingerprint);
}

async function verifyOwnedDirectory(context, serverPath, expectedIdentity, expectedFingerprint = null) {
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
      !identityMatches(journalRecord.candidateIdentity, expectedIdentity) ||
      (expectedFingerprint && journalRecord.candidateFingerprint !== expectedFingerprint)) throw recoveryRequired();
  const inspection = await inspectCandidate(context, serverPath);
  const fingerprint = expectedFingerprint || journalRecord.candidateFingerprint;
  if (!fingerprint || inspection.fingerprint !== fingerprint || !identityMatches(inspection.directoryIdentity, expectedIdentity)) {
    throw recoveryRequired();
  }
  return { identity, inspection, journal, journalRecord, locations };
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
    journalRecord = owned.journal.transition(owned.locations.journalPath, {
      expectedPhase: 'publishing',
      nextPhase: 'published',
      patch: { swapStep: 'candidate-published', targetIdentity: owned.identity }
    });
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
    journalRecord = candidate.journal.transition(candidate.locations.journalPath, {
      expectedPhase: 'committing',
      nextPhase: 'publishing',
      patch: { swapStep: 'new-prepared', targetAbsence: absence }
    });
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
  }
  if (record.phase !== 'publishing' || record.swapStep !== 'new-prepared') throw recoveryRequired();
  await assertServerDirectoryIdentity(path.dirname(context.targetPath), parentIdentity, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
  if (entryStat(context.fsApi, context.expectedPaths.failedPath)) throw targetExists();
  if (entryStat(context.fsApi, context.targetPath)) throw targetExists();
  try {
    context.durableFs.renameDurable(context.expectedPaths.candidatePath, context.targetPath);
  } catch (error) {
    if (error instanceof ModpackError && error.code === 'TARGET_EXISTS') throw error;
    const targetPresent = entryStat(context.fsApi, context.targetPath);
    const candidatePresent = entryStat(context.fsApi, context.expectedPaths.candidatePath);
    if (!targetPresent || candidatePresent) throw error instanceof ModpackError ? error : commitFailure(error);
    try {
      await verifyOwnedDirectory(context, context.targetPath, candidateIdentity, journalRecord.candidateFingerprint);
    } catch {
      throw error instanceof ModpackError ? error : commitFailure(error);
    }
  }
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
    journalRecord = owned.journal.transition(owned.locations.journalPath, {
      expectedPhase: 'published',
      nextPhase: 'registering',
      patch: { registration: { instanceId: context.stableInstanceId, complete: false } }
    });
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
    journalRecord = owned.journal.transition(owned.locations.journalPath, {
      expectedPhase: 'registering',
      nextPhase: 'registered',
      patch: { registration: { instanceId: context.stableInstanceId, complete: true } }
    });
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
  const durableFs = context.durableFs;
  const recoveryRegistry = context.recoveryRegistry;
  const mutationLease = context.mutationLease;
  if (!fsApi || [
    'closeSync', 'fstatSync', 'fsyncSync', 'lstatSync', 'mkdirSync', 'openSync', 'readFileSync', 'readdirSync',
    'realpathSync', 'rmdirSync', 'unlinkSync'
  ].some(method => typeof fsApi[method] !== 'function') ||
      !durableFs || typeof durableFs.flushDirectory !== 'function' || typeof durableFs.readFileBounded !== 'function' ||
      typeof durableFs.renameDurable !== 'function' || typeof durableFs.writeJsonAtomic !== 'function' ||
      !recoveryRegistry || typeof recoveryRegistry.load !== 'function' || typeof recoveryRegistry.transition !== 'function' ||
      !mutationLease || mutationLease.kind !== 'mutation' || mutationLease.instanceId !== stableInstanceId ||
      pathAliasKey(mutationLease.serverPath) !== pathAliasKey(targetPath) || typeof mutationLease.markDirty !== 'function' ||
      !context.reparseInspector || typeof context.reparseInspector.isReparsePoint !== 'function') throw invalid();
  const validatesCandidate = context.validateCandidate !== false;
  const validatesLive = context.validateLive !== false;
  if ((validatesCandidate && (!context.healthValidator || typeof context.healthValidator.validateCandidate !== 'function')) ||
      (purpose === 'healthy' && validatesLive &&
        (!context.healthValidator || typeof context.healthValidator.validateLive !== 'function')) ||
      !context.runtime || typeof context.maxRam !== 'number' || !Number.isSafeInteger(context.healthTimeoutMs) ||
      context.healthTimeoutMs < 1 || context.healthTimeoutMs > 300000 ||
      !Number.isSafeInteger(context.port) || context.port < 1 || context.port > 65535) throw invalid();
  if (purpose === 'build' && (typeof context.applyIncoming !== 'function' || !context.stateRepository ||
      typeof context.stateRepository.read !== 'function' ||
      (typeof context.persistCandidateState !== 'function' && typeof context.stateRepository.writeCandidate !== 'function') ||
      !context.candidateState || typeof context.candidateState !== 'object')) throw invalid();
  if (purpose === 'healthy' && (!context.revisionPublisher || typeof context.revisionPublisher.publishOnce !== 'function')) throw invalid();
  if (context.afterBoundary !== undefined && typeof context.afterBoundary !== 'function') throw invalid();
  if (context.removeOwnedDirectory !== undefined && typeof context.removeOwnedDirectory !== 'function') throw invalid();
  if (context.freshCandidate !== undefined && typeof context.freshCandidate !== 'boolean') throw invalid();
  if (context.runtimePolicy !== undefined && (!context.runtimePolicy ||
      typeof context.runtimePolicy.adoptValidatedHandoff !== 'function')) throw invalid();
  return {
    ...context,
    targetPath,
    jobId,
    stableInstanceId,
    expectedPaths,
    fsApi,
    durableFs,
    recoveryRegistry,
    mutationLease
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
      context.durableFs.flushDirectory(parent);
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
  const before = entryStat(context.fsApi, filePath);
  if (!before) return deepFreeze({ bytes: null, existed: false, sha256: null });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      await context.reparseInspector.isReparsePoint(filePath, { signal: context.signal }) !== false) throw recoveryRequired();
  const bytes = Buffer.from(context.fsApi.readFileSync(filePath));
  const after = entryStat(context.fsApi, filePath);
  if (!after || after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs ||
      after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw recoveryRequired();
  return deepFreeze({
    bytes: bytes.toString('base64'),
    existed: true,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

async function assertExactFileSnapshot(context, serverPath, relativePath, expected) {
  const actual = await exactFileSnapshot(context, serverPath, relativePath);
  if (actual.existed !== expected.existed || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new ModpackError('HEALTH_CHECK_FAILED', 'Candidate validation did not restore the canonical server properties');
  }
  return actual;
}

async function operationBoundary(context, name) {
  if (context.afterBoundary) await context.afterBoundary(name);
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
  const planValidator = context.planValidator || assertPlanStillValid;
  planValidator(context.plan, context.currentSnapshot);
  assertExistingSiblingSlots(context, { target: true });
  const currentState = context.stateRepository.read(context.targetPath);
  const sourceRevision = currentState?.state?.contentRevision;
  const targetRevision = context.candidateState.contentRevision;
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || targetRevision !== sourceRevision + 1 ||
      (Number.isSafeInteger(context.mutationLease.baseRevision) && context.mutationLease.baseRevision !== sourceRevision)) {
    throw new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale');
  }
  const liveInspection = await inspectServerDirectoryTree(context.targetPath, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
  const parentIdentity = await identifyParent(context);
  if (liveInspection.directoryIdentity.volumeSerial !== parentIdentity.volumeSerial) throw commitFailure();
  record = await context.recoveryRegistry.transition(context.jobId, {
    expectedPhase: record.phase,
    nextPhase: 'staging',
    patch: {
      directoryIdentities: {
        target: liveInspection.directoryIdentity,
        candidate: null,
        rollback: null,
        failed: null
      }
    }
  });
  context.mutationLease.markDirty();
  await operationBoundary(context, 'staging-recorded');
  await assertServerDirectoryIdentity(path.dirname(context.targetPath), parentIdentity, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector, signal: context.signal
  });
  assertExistingSiblingSlots(context, { target: true });
  const createdIdentity = await createDirectoryExclusive(context, context.expectedPaths.candidatePath);
  if (createdIdentity.volumeSerial !== liveInspection.directoryIdentity.volumeSerial) throw commitFailure();
  await operationBoundary(context, 'candidate-created');
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
        fsApi: context.fsApi,
        reparseInspector: context.reparseInspector,
        signal: context.signal
      });
  if (!identityMatches(copyEvidence.sourceIdentity, liveInspection.directoryIdentity) ||
      copyEvidence.sourceFingerprint !== liveInspection.fingerprint ||
      !identityMatches(copyEvidence.destinationIdentity, createdIdentity)) throw recoveryRequired();
  await operationBoundary(context, 'live-copied');

  const locations = await ensureExistingOperationLayout(context, context.expectedPaths.candidatePath);
  const marker = writeMarker(context, locations.markerPath);
  const journal = createJournal(context);
  journal.create(locations.journalPath, {
    jobId: context.jobId,
    operationKind: context.operationKind,
    stableInstanceId: context.stableInstanceId,
    targetPath: context.targetPath,
    candidateIdentity: createdIdentity,
    markerSha256: marker.checksum
  });
  journal.transition(locations.journalPath, {
    expectedPhase: 'staging',
    nextPhase: 'staging',
    patch: { targetIdentity: liveInspection.directoryIdentity }
  });
  journal.transition(locations.journalPath, {
    expectedPhase: 'staging', nextPhase: 'validating-candidate', patch: {}
  });
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
        revision: { source: sourceRevision, target: targetRevision }
      })
    }
  });
  await operationBoundary(context, 'candidate-validation-recorded');

  await context.applyIncoming(Object.freeze({
    candidatePath: context.expectedPaths.candidatePath,
    jobId: context.jobId,
    livePath: context.targetPath,
    plan: context.plan,
    signal: context.signal
  }));
  const writtenState = context.persistCandidateState
    ? await context.persistCandidateState(Object.freeze({
        candidatePath: context.expectedPaths.candidatePath,
        candidateState: context.candidateState,
        jobId: context.jobId,
        stateRepository: context.stateRepository
      }))
    : await context.stateRepository.writeCandidate(
        context.expectedPaths.candidatePath,
        context.candidateState
      );
  if (writtenState?.state?.contentRevision !== targetRevision) throw recoveryRequired();
  await flushCandidateTree(context, context.expectedPaths.candidatePath);
  const canonicalProperties = await exactFileSnapshot(context, context.expectedPaths.candidatePath, 'server.properties');
  if (context.validateCandidate !== false) {
    await context.healthValidator.validateCandidate({
      candidatePath: context.expectedPaths.candidatePath,
      jobId: context.jobId,
      maxRam: context.maxRam,
      mutationLease: context.mutationLease,
      runtime: context.runtime,
      signal: context.signal,
      timeoutMs: context.healthTimeoutMs
    });
    await assertExactFileSnapshot(context, context.expectedPaths.candidatePath, 'server.properties', canonicalProperties);
    await flushCandidateTree(context, context.expectedPaths.candidatePath);
  }
  const candidateInspection = await inspectCandidate(context, context.expectedPaths.candidatePath);
  if (!identityMatches(candidateInspection.directoryIdentity, createdIdentity)) throw recoveryRequired();
  const liveAfter = await inspectServerDirectoryTree(context.targetPath, {
    fsApi: context.fsApi,
    reparseInspector: context.reparseInspector,
    signal: context.signal
  });
  if (!identityMatches(liveAfter.directoryIdentity, liveInspection.directoryIdentity) ||
      liveAfter.fingerprint !== liveInspection.fingerprint) throw recoveryRequired();

  journal.transition(locations.journalPath, {
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
        revision: { source: sourceRevision, target: targetRevision },
        runtime: {
          maxRam: context.maxRam,
          port: context.port,
          source: currentState.state.runtime || null,
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
    context.durableFs.renameDurable(source, destination);
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
  candidate.journal.transition(candidate.locations.journalPath, {
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
  published.journal.transition(published.locations.journalPath, {
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
  const owned = await verifyOwnedDirectory(
    context,
    context.targetPath,
    record.directoryIdentities.target,
    record.outcome?.candidate?.fingerprint || null
  );
  await assertServerDirectoryIdentity(context.expectedPaths.rollbackPath, record.directoryIdentities.rollback, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  const rollbackInspection = await inspectServerDirectoryTree(context.expectedPaths.rollbackPath, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  if (!identityMatches(rollbackInspection.directoryIdentity, record.directoryIdentities.rollback) ||
      rollbackInspection.fingerprint !== record.outcome?.rollback?.fingerprint) throw recoveryRequired();
  const canonicalProperties = await exactFileSnapshot(context, context.targetPath, 'server.properties');
  let journalRecord = owned.journalRecord;
  if (!identityMatches(journalRecord.rollbackIdentity, record.directoryIdentities.rollback) ||
      journalRecord.rollbackFingerprint !== record.outcome?.rollback?.fingerprint) throw recoveryRequired();
  if (record.phase === 'starting') {
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'starting', nextPhase: 'validating-live', patch: {}
    });
    if (journalRecord.phase === 'starting') {
      journalRecord = owned.journal.transition(owned.locations.journalPath, {
        expectedPhase: 'starting', nextPhase: 'validating-live', patch: {}
      });
    }
    await operationBoundary(context, 'validating-live');
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
          port: context.port,
          runtime: context.runtime,
          serverPath: context.targetPath,
          signal: undefined,
          timeoutMs: context.healthTimeoutMs
        });
    await assertExactFileSnapshot(context, context.targetPath, 'server.properties', canonicalProperties);
    const event = revisionEvent(context, record);
    let adoptedHandoff = null;
    if (targetRunning && context.validateLive !== false) {
      if (!validation?.handoff || !context.runtimePolicy) {
        throw new ModpackError('HEALTH_CHECK_FAILED', 'The validated running server could not be adopted');
      }
      adoptedHandoff = await context.runtimePolicy.adoptValidatedHandoff({
        eventId: `modpack-runtime-handoff:${context.jobId}`,
        handoff: validation.handoff,
        instanceId: context.stableInstanceId,
        jobId: context.jobId
      });
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
      owned.journal.transition(owned.locations.journalPath, {
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
    durableJournal = createJournal(context).transition(owned.locations.journalPath, {
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
    createJournal(context).transition(owned.locations.journalPath, {
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
  await assertServerDirectoryIdentity(directoryPath, expectedIdentity, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  async function removeContents(directory) {
    const names = context.fsApi.readdirSync(directory);
    names.sort((left, right) => left.localeCompare(right, 'en-US'));
    for (const name of names) {
      const candidate = path.join(directory, name);
      const before = entryStat(context.fsApi, candidate);
      if (!before || before.isSymbolicLink() ||
          await context.reparseInspector.isReparsePoint(candidate) !== false) throw recoveryRequired();
      if (before.isDirectory()) {
        const identity = await identifyServerDirectory(candidate, {
          fsApi: context.fsApi, reparseInspector: context.reparseInspector
        });
        await removeContents(candidate);
        await assertServerDirectoryIdentity(candidate, identity, {
          fsApi: context.fsApi, reparseInspector: context.reparseInspector
        });
        context.fsApi.rmdirSync(candidate);
      } else if (before.isFile() && before.nlink === 1n) {
        const after = entryStat(context.fsApi, candidate);
        if (!after || after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs ||
            after.nlink !== 1n) throw recoveryRequired();
        context.fsApi.unlinkSync(candidate);
      } else {
        throw recoveryRequired();
      }
      context.durableFs.flushDirectory(directory);
    }
  }
  await removeContents(directoryPath);
  await assertServerDirectoryIdentity(directoryPath, expectedIdentity, {
    fsApi: context.fsApi, reparseInspector: context.reparseInspector
  });
  context.fsApi.rmdirSync(directoryPath);
  context.durableFs.flushDirectory(path.dirname(directoryPath));
}

async function cleanupCommittedTransaction(contextValue) {
  const context = { ...assertExistingDependencies(contextValue, 'cleanup'), signal: undefined };
  let record = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
  if (record.phase === 'completed' && record.swapStep === 'cleanup-complete') {
    return deepFreeze({ phase: 'completed', rollbackRemoved: true });
  }
  if (!['committed-healthy', 'cleanup', 'cleanup-pending'].includes(record.phase) ||
      record.swapStep !== 'candidate-published' || record.outcome?.revisionEvent?.published !== true) {
    throw recoveryRequired();
  }
  const owned = await verifyOwnedDirectory(
    context,
    context.targetPath,
    record.directoryIdentities.target,
    record.outcome?.candidate?.fingerprint || null
  );
  let journalRecord = owned.journalRecord;
  try {
    if (record.phase === 'committed-healthy' || record.phase === 'cleanup-pending') {
      const priorPhase = record.phase;
      record = await context.recoveryRegistry.transition(context.jobId, {
        expectedPhase: priorPhase, nextPhase: 'cleanup', patch: {}
      });
      if (journalRecord.phase === priorPhase || (priorPhase === 'cleanup-pending' && journalRecord.phase === 'committed-healthy')) {
        journalRecord = owned.journal.transition(owned.locations.journalPath, {
          expectedPhase: journalRecord.phase, nextPhase: 'cleanup', patch: {}
        });
      }
    }
    await operationBoundary(context, 'cleanup-started');
    const rollbackPresent = entryStat(context.fsApi, context.expectedPaths.rollbackPath);
    if (rollbackPresent) {
      await assertServerDirectoryIdentity(context.expectedPaths.rollbackPath, record.directoryIdentities.rollback, {
        fsApi: context.fsApi, reparseInspector: context.reparseInspector
      });
      const rollbackInspection = await inspectServerDirectoryTree(context.expectedPaths.rollbackPath, {
        fsApi: context.fsApi, reparseInspector: context.reparseInspector
      });
      if (rollbackInspection.fingerprint !== record.outcome?.rollback?.fingerprint) throw recoveryRequired();
      if (context.removeOwnedDirectory) {
        await context.removeOwnedDirectory({
          directoryIdentity: record.directoryIdentities.rollback,
          directoryPath: context.expectedPaths.rollbackPath,
          jobId: context.jobId
        });
      } else {
        await removeDirectoryByIdentity(context, context.expectedPaths.rollbackPath, record.directoryIdentities.rollback);
      }
    } else if (record.phase !== 'cleanup') {
      throw recoveryRequired();
    }
    await operationBoundary(context, 'rollback-removed');
    record = await context.recoveryRegistry.transition(context.jobId, {
      expectedPhase: 'cleanup',
      nextPhase: 'completed',
      patch: {
        swapStep: 'cleanup-complete',
        outcome: existingOutcome(record, { cleanup: { rollbackRemoved: true } })
      }
    });
    if (journalRecord.phase === 'cleanup') {
      owned.journal.transition(owned.locations.journalPath, {
        expectedPhase: 'cleanup', nextPhase: 'completed', patch: { swapStep: 'cleanup-complete' }
      });
    }
    await operationBoundary(context, 'cleanup-complete');
    return deepFreeze({ phase: record.phase, rollbackRemoved: true });
  } catch (error) {
    const latest = assertExistingRecordMatches(await context.recoveryRegistry.load(context.jobId), context);
    if (latest.phase === 'completed' && latest.swapStep === 'cleanup-complete') {
      return deepFreeze({ phase: 'completed', rollbackRemoved: true });
    }
    if (latest.phase === 'cleanup') {
      try {
        await context.recoveryRegistry.transition(context.jobId, {
          expectedPhase: 'cleanup',
          nextPhase: 'cleanup-pending',
          patch: { outcome: existingOutcome(latest, { cleanup: { rollbackRemoved: false } }) }
        });
      } catch { /* the existing durable cleanup record still preserves healthy-canonical authority */ }
    }
    try {
      const currentJournal = createJournal(context).load(operationPaths(context.targetPath, context.jobId).journalPath);
      if (currentJournal.phase === 'cleanup') {
        createJournal(context).transition(operationPaths(context.targetPath, context.jobId).journalPath, {
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
  createExistingSiblingPaths,
  createSiblingPaths,
  markCommittedHealthy,
  publishNewCandidate,
  registerPublishedInstance,
  swapExistingCandidate,
  verifyOperationOwnedDirectory: verifyOwnedDirectory
};
