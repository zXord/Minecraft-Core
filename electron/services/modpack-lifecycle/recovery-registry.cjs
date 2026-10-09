const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ModpackError } = require('../modpacks/errors.cjs');
const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const {
  JOB_ID_PATTERN,
  createRecoveryTargetEnvelope,
  normalizeRecoveryTargetPath,
  verifyRecoveryTargetEnvelope
} = require('./recovery-target-envelope.cjs');
const {
  assertRestoreCreationTransition,
  normalizeRestoreCreation
} = require('./restore-creation-intent.cjs');
const { normalizeFailureDiagnostic } = require('./publication-failure-diagnostic.cjs');
const { normalizeRuntimeWriterAuthority } = require('./server-runtime-writer-authority.cjs');
const { FAILURE_CODES } = require('../modpacks/errors.cjs');
const { normalizeRuntimeDiagnostic } = require('../runtime-diagnostic.cjs');

const LEGACY_RECORD_SCHEMA_VERSION = 1;
const RECORD_SCHEMA_VERSION = 2;
const MAX_RECORD_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATION_KINDS = new Set([
  'install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback', 'import', 'detach', 'uninstall', 'verify'
]);
const PHASES = new Set([
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight',
  'snapshotting', 'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering',
  'starting', 'validating-live', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed', 'cancelling',
  'cancelled', 'rolling-back', 'rolled-back', 'failed', 'recovery-required'
]);
const TERMINAL_PHASES = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);
const SWAP_STEPS = new Set([
  'none', 'prepared', 'new-prepared', 'live-moved', 'candidate-published', 'failed-canonical-moved',
  'rollback-restored', 'cleanup-complete'
]);
const LEGACY_RECORD_KEYS = Object.freeze([
  'schemaVersion', 'sequence', 'jobId', 'operationKind', 'target', 'candidatePath', 'rollbackPath', 'failedPath',
  'restorePoint', 'journalPath', 'priorRuntime', 'phase', 'swapStep', 'directoryIdentities', 'createdAt', 'updatedAt', 'outcome'
]);
const RECORD_KEYS = Object.freeze([...LEGACY_RECORD_KEYS, 'restoreCreation']);
const TARGET_KEYS = Object.freeze(['kind', 'stableServerId', 'path']);
const RESTORE_KEYS = Object.freeze(['id', 'sha256']);
const PRIOR_RUNTIME_KEYS = Object.freeze(['running', 'autoRestart']);
const DIRECTORY_IDENTITIES_KEYS = Object.freeze(['target', 'candidate', 'rollback', 'failed']);
const DIRECTORY_IDENTITY_KEYS = Object.freeze(['volumeSerial', 'fileId']);
const TRANSITION_KEYS = new Set([
  'candidatePath', 'rollbackPath', 'failedPath', 'restorePoint', 'restoreCreation', 'journalPath', 'priorRuntime', 'swapStep',
  'directoryIdentities', 'outcome'
]);

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The recovery registry request is invalid', { cause });
}

function commitFailure(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('COMMIT_FAILED', 'The recovery registry could not be updated', { cause });
}

function stale() {
  return new ModpackError('PLAN_STALE', 'The recovery record changed before the transition');
}

function targetExists() {
  return new ModpackError('TARGET_EXISTS', 'The recovery record already exists');
}

function recoveryRequired(cause) {
  return new ModpackError('RECOVERY_REQUIRED', 'The recovery record requires manual recovery', { cause });
}

function assertStrictObject(value, keys, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length !== keys.length || names.some(name => !keys.includes(name))) throw invalid();
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return value;
}

function assertIdentifier(value, pattern = SERVER_ID_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
  return value;
}

function assertIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) throw invalid();
  return value;
}

function normalizeOptionalPath(value) {
  return value === null ? null : normalizeRecoveryTargetPath(value);
}

function normalizeRestorePoint(value) {
  if (value === null) return null;
  assertStrictObject(value, RESTORE_KEYS);
  return {
    id: assertIdentifier(value.id),
    sha256: typeof value.sha256 === 'string' && SHA256_PATTERN.test(value.sha256) ? value.sha256 : (() => { throw invalid(); })()
  };
}

function normalizeDirectoryIdentity(value) {
  if (value === null) return null;
  assertStrictObject(value, DIRECTORY_IDENTITY_KEYS);
  if (typeof value.volumeSerial !== 'string' || !/^[A-Fa-f0-9]{1,32}$/.test(value.volumeSerial) ||
      typeof value.fileId !== 'string' || !/^[A-Fa-f0-9]{1,64}$/.test(value.fileId)) throw invalid();
  return { volumeSerial: value.volumeSerial.toLocaleLowerCase('en-US'), fileId: value.fileId.toLocaleLowerCase('en-US') };
}

function normalizeDirectoryIdentities(value) {
  assertStrictObject(value, DIRECTORY_IDENTITIES_KEYS);
  return {
    target: normalizeDirectoryIdentity(value.target),
    candidate: normalizeDirectoryIdentity(value.candidate),
    rollback: normalizeDirectoryIdentity(value.rollback),
    failed: normalizeDirectoryIdentity(value.failed)
  };
}

function normalizeOutcome(value) {
  if (value === null) return null;
  let clone;
  try {
    clone = strictJsonClone(value, { maxDepth: 16, maxCollection: 512, maxStringBytes: 64 * 1024 });
  } catch (error) {
    throw invalid(error);
  }
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) throw invalid();
  if (Object.hasOwn(clone, 'runtimeWriterProtocol') && clone.runtimeWriterProtocol !== 1) throw invalid();
  if (Object.hasOwn(clone, 'runtimeWriterFailure')) {
    assertStrictObject(clone.runtimeWriterFailure, ['code', ...(Object.hasOwn(clone.runtimeWriterFailure, 'diagnostic') ? ['diagnostic'] : [])]);
    if (typeof clone.runtimeWriterFailure.code !== 'string' || !FAILURE_CODES.includes(clone.runtimeWriterFailure.code)) throw invalid();
    if (Object.hasOwn(clone.runtimeWriterFailure, 'diagnostic')) {
      try { clone.runtimeWriterFailure.diagnostic = normalizeRuntimeDiagnostic(clone.runtimeWriterFailure.diagnostic); }
      catch (error) { throw invalid(error); }
    }
  }
  const storedFailure = Object.getOwnPropertyDescriptor(clone, 'failure');
  if (storedFailure) {
    const normalizedFailure = normalizeFailureDiagnostic(storedFailure.value);
    if (normalizedFailure) clone.failure = normalizedFailure;
    else delete clone.failure;
  }
  return clone;
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const schemaDescriptor = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  if (!schemaDescriptor || !Object.hasOwn(schemaDescriptor, 'value')) throw invalid();
  const legacy = schemaDescriptor.value === LEGACY_RECORD_SCHEMA_VERSION;
  assertStrictObject(value, legacy ? LEGACY_RECORD_KEYS : RECORD_KEYS);
  if ((!legacy && value.schemaVersion !== RECORD_SCHEMA_VERSION) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
      typeof value.jobId !== 'string' || !JOB_ID_PATTERN.test(value.jobId) || !OPERATION_KINDS.has(value.operationKind) ||
      !PHASES.has(value.phase) || !SWAP_STEPS.has(value.swapStep)) throw invalid();
  assertStrictObject(value.target, TARGET_KEYS);
  if (!['new', 'existing'].includes(value.target.kind)) throw invalid();
  const stableServerId = value.target.stableServerId === null ? null : assertIdentifier(value.target.stableServerId);
  if (value.target.kind === 'existing' && stableServerId === null) throw invalid();
  assertStrictObject(value.priorRuntime, PRIOR_RUNTIME_KEYS);
  if (typeof value.priorRuntime.running !== 'boolean' || typeof value.priorRuntime.autoRestart !== 'boolean') throw invalid();
  const targetPath = normalizeRecoveryTargetPath(value.target.path);
  const candidatePath = normalizeOptionalPath(value.candidatePath);
  const rollbackPath = normalizeOptionalPath(value.rollbackPath);
  const failedPath = normalizeOptionalPath(value.failedPath);
  const siblingPaths = [candidatePath, rollbackPath, failedPath].filter(Boolean);
  const uniqueDirectoryPaths = new Set([targetPath, ...siblingPaths]);
  if (uniqueDirectoryPaths.size !== 1 + siblingPaths.length ||
      siblingPaths.some(candidate => path.win32.dirname(candidate) !== path.win32.dirname(targetPath))) throw invalid();
  const result = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    sequence: value.sequence,
    jobId: value.jobId,
    operationKind: value.operationKind,
    target: {
      kind: value.target.kind,
      stableServerId,
      path: targetPath
    },
    candidatePath,
    rollbackPath,
    failedPath,
    restorePoint: normalizeRestorePoint(value.restorePoint),
    restoreCreation: normalizeRestoreCreation(legacy ? null : value.restoreCreation, value.jobId),
    journalPath: normalizeOptionalPath(value.journalPath),
    priorRuntime: {
      running: value.priorRuntime.running,
      autoRestart: value.priorRuntime.autoRestart
    },
    phase: value.phase,
    swapStep: value.swapStep,
    directoryIdentities: normalizeDirectoryIdentities(value.directoryIdentities),
    createdAt: assertIsoTimestamp(value.createdAt),
    updatedAt: assertIsoTimestamp(value.updatedAt),
    outcome: normalizeOutcome(value.outcome)
  };
  if (result.outcome && Object.hasOwn(result.outcome, 'runtimeWriterAuthority')) {
    result.outcome.runtimeWriterAuthority = normalizeRuntimeWriterAuthority(result.outcome.runtimeWriterAuthority, result);
  }
  return result;
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameLocalPath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function registryDirectoryIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs)
  });
}

function sameRegistryDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtime === right.birthtime;
}

function defaultYieldControl() {
  return new Promise(resolve => setImmediate(resolve));
}

class RecoveryRegistry {
  constructor({
    userDataPath,
    fsApi = fs,
    durableFs,
    clock = () => new Date(),
    randomUUID = crypto.randomUUID,
    yieldControl = defaultYieldControl
  } = {}) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || !fsApi || typeof fsApi !== 'object' ||
        !durableFs || typeof durableFs.readFileBounded !== 'function' || typeof durableFs.writeJsonAtomicAsync !== 'function' ||
        typeof durableFs.renameDurable !== 'function' || typeof durableFs.renameDurableAsync !== 'function' ||
        typeof durableFs.flushDirectory !== 'function' ||
        typeof clock !== 'function' || typeof randomUUID !== 'function' || typeof yieldControl !== 'function') throw invalid();
    this.userDataPath = path.resolve(userDataPath);
    if (this.userDataPath === path.parse(this.userDataPath).root) throw invalid();
    if (process.platform === 'win32') {
      const win32Path = this.userDataPath.replaceAll('/', '\\');
      const parsed = path.win32.parse(win32Path);
      if (!path.win32.isAbsolute(win32Path) || win32Path.startsWith('\\\\') ||
          win32Path.startsWith('\\?\\') || win32Path.startsWith('\\.\\') ||
          win32Path.slice(parsed.root.length).includes(':')) throw invalid();
    }
    const userDataStat = fsApi.lstatSync(this.userDataPath, { bigint: true });
    const realUserData = path.resolve(fsApi.realpathSync.native(this.userDataPath));
    if (!userDataStat.isDirectory() || userDataStat.isSymbolicLink() || !sameLocalPath(realUserData, this.userDataPath)) throw invalid();
    this.fs = fsApi;
    this.durableFs = durableFs;
    this.clock = clock;
    this.randomUUID = randomUUID;
    this.yieldControl = yieldControl;
    this.rootPath = path.join(this.userDataPath, 'modpack-lifecycle');
    this.activePath = path.join(this.rootPath, 'active');
    this.historyPath = path.join(this.rootPath, 'history');
    this.directoryPins = {
      userData: registryDirectoryIdentity(userDataStat),
      root: null,
      active: null,
      history: null
    };
    this.initialized = false;
    this.historyPublication = Promise.resolve();
  }

  async initialize() {
    await this.#awaitHistoryStable();
    if (this.initialized) this.#revalidateRegistryDirectories();
    else this.#initializeDirectories();
    this.#revalidateRegistryDirectories();
    const jobs = new Map();
    let globalBlock = false;
    for (const [location, directory] of [['active', this.activePath], ['history', this.historyPath]]) {
      const entries = this.fs.readdirSync(directory, { withFileTypes: true });
      this.#revalidateRegistryDirectories();
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          globalBlock = true;
          continue;
        }
        const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})(\.target)?\.json$/.exec(entry.name);
        if (!match) {
          globalBlock = true;
          continue;
        }
        const item = jobs.get(match[1]) || { record: false, envelope: false, historyRecord: false, historyEnvelope: false };
        const key = location === 'history' ? (match[2] ? 'historyEnvelope' : 'historyRecord') : (match[2] ? 'envelope' : 'record');
        item[key] = true;
        jobs.set(match[1], item);
      }
    }

    const records = [];
    const pendingTerminalPublications = [];
    const corrupt = [];
    const blocks = [];
    for (const [jobId, presence] of [...jobs].sort(([left], [right]) => left.localeCompare(right))) {
      let publication = null;
      if (presence.historyRecord || presence.historyEnvelope) {
        try { publication = this.#classifyTerminalPublication(jobId); } catch { /* Retain all identifying blocks below. */ }
        if (publication?.status === 'already-published') continue;
        if (publication?.status === 'pending') pendingTerminalPublications.push(publication.record.value);
      }
      let recordFromHistory = false;
      let recordResult = presence.record
        ? this.#tryReadRecord(this.#recordPath(jobId), jobId)
        : { value: null, identifyingValue: null, error: null };
      if (!presence.record && presence.historyRecord) {
        const historicalResult = this.#tryReadRecord(this.#historyRecordPath(jobId), jobId);
        if (historicalResult.value || historicalResult.identifyingValue) {
          recordResult = historicalResult;
          recordFromHistory = true;
        }
      }
      const envelopeResult = presence.envelope ? this.#tryReadEnvelope(this.#envelopePath(jobId)) : { value: null, error: null };
      const identifyingEnvelopes = [];
      if (recordResult.value) {
        if (!recordFromHistory) records.push(recordResult.value);
        identifyingEnvelopes.push(createRecoveryTargetEnvelope(recordResult.value));
      } else if (recordResult.identifyingValue) {
        identifyingEnvelopes.push(createRecoveryTargetEnvelope(recordResult.identifyingValue));
      }
      if (envelopeResult.value) identifyingEnvelopes.push(envelopeResult.value);
      if (presence.record && presence.historyRecord) {
        const historical = this.#tryReadRecord(this.#historyRecordPath(jobId), jobId);
        if (historical.value || historical.identifyingValue) {
          identifyingEnvelopes.push(createRecoveryTargetEnvelope(historical.value || historical.identifyingValue));
        }
      }
      if (presence.historyEnvelope) {
        const historicalEnvelope = this.#tryReadEnvelope(this.#historyEnvelopePath(jobId));
        if (historicalEnvelope.value) identifyingEnvelopes.push(historicalEnvelope.value);
      }

      const recordEnvelope = recordResult.value ? createRecoveryTargetEnvelope(recordResult.value) : null;
      const evidenceMatches = Boolean(recordEnvelope && envelopeResult.value &&
        envelopeResult.value.jobId === jobId &&
        envelopeResult.value.targetPathHash === recordEnvelope.targetPathHash &&
        envelopeResult.value.stableServerId === recordEnvelope.stableServerId);
      const hasHistoryEvidence = presence.historyRecord || presence.historyEnvelope;
      const isCorrupt = hasHistoryEvidence ? !publication : !recordResult.value || !envelopeResult.value || !evidenceMatches;
      if (isCorrupt) {
        corrupt.push({
          jobId,
          recordValid: Boolean(recordResult.value),
          envelopeValid: Boolean(envelopeResult.value),
          mismatched: Boolean(
            recordResult.identifyingValue ||
            (recordEnvelope && envelopeResult.value && !evidenceMatches) ||
            (envelopeResult.value && envelopeResult.value.jobId !== jobId)
          )
        });
      }
      if (identifyingEnvelopes.length === 0) {
        globalBlock = true;
      }
      for (const identifyingEnvelope of identifyingEnvelopes) {
        const duplicate = blocks.some(block =>
          block.stableServerId === identifyingEnvelope.stableServerId &&
          block.targetPathHash === identifyingEnvelope.targetPathHash);
        if (!duplicate) {
          blocks.push({
            jobId: identifyingEnvelope.jobId,
            stableServerId: identifyingEnvelope.stableServerId,
            targetPathHash: identifyingEnvelope.targetPathHash,
            targetLabel: identifyingEnvelope.targetLabel
          });
        }
      }
    }

    return Object.freeze({
      records: Object.freeze(records.map(item => Object.freeze(strictJsonClone(item)))),
      pendingTerminalPublications: Object.freeze(pendingTerminalPublications.map(item => Object.freeze(strictJsonClone(item)))),
      corrupt: Object.freeze(corrupt.map(item => Object.freeze(item))),
      blocks: Object.freeze(blocks.map(item => Object.freeze(item))),
      globalBlock
    });
  }

  async create(record) {
    await this.#awaitHistoryStable();
    this.#assertInitialized();
    let normalized;
    try {
      normalized = normalizeRecord(record);
    } catch (error) {
      throw invalid(error);
    }
    if (normalized.sequence !== 0 || normalized.phase !== 'queued' || normalized.swapStep !== 'none' || normalized.outcome !== null) {
      throw invalid();
    }
    const now = this.#now();
    normalized.createdAt = now;
    normalized.updatedAt = now;
    const recordPath = this.#recordPath(normalized.jobId);
    const envelopePath = this.#envelopePath(normalized.jobId);
    if (this.#entryExists(recordPath) || this.#entryExists(envelopePath) ||
        this.#entryExists(this.#historyRecordPath(normalized.jobId)) || this.#entryExists(this.#historyEnvelopePath(normalized.jobId))) {
      throw targetExists();
    }
    const envelope = createRecoveryTargetEnvelope(normalized);
    try {
      this.#revalidateRegistryDirectories();
      await this.durableFs.writeJsonAtomicAsync(envelopePath, envelope, { expectedTargetSha256: null });
      this.#revalidateRegistryDirectories();
      await this.durableFs.writeJsonAtomicAsync(recordPath, normalized, { expectedTargetSha256: null });
      this.#revalidateRegistryDirectories();
      return Object.freeze(strictJsonClone(normalized));
    } catch (error) {
      throw commitFailure(error);
    }
  }

  async load(jobId) {
    await this.#awaitHistoryStable();
    this.#assertInitialized();
    assertIdentifier(jobId, JOB_ID_PATTERN);
    const loaded = this.#readRecord(this.#recordPath(jobId), { allowMissing: true, expectedJobId: jobId });
    return loaded ? Object.freeze(strictJsonClone(loaded.value)) : null;
  }

  async loadHistory(jobId) {
    await this.#awaitHistoryStable();
    this.#assertInitialized();
    assertIdentifier(jobId, JOB_ID_PATTERN);
    const loaded = this.#readRecord(this.#historyRecordPath(jobId), { allowMissing: true, expectedJobId: jobId });
    if (!loaded) return null;
    if (!TERMINAL_PHASES.has(loaded.value.phase)) throw recoveryRequired();
    this.#assertEnvelopeMatches(loaded.value);
    return Object.freeze(strictJsonClone(loaded.value));
  }

  async listActive() {
    const scan = await this.initialize();
    return scan.records;
  }

  async retryTerminalPublication(jobId, request) {
    this.#assertInitialized();
    assertIdentifier(jobId, JOB_ID_PATTERN);
    assertStrictObject(request, ['expectedTarget', 'expectedOperationKind']);
    assertStrictObject(request.expectedTarget, TARGET_KEYS);
    const target = request.expectedTarget;
    if (!['new', 'existing'].includes(target.kind) || !OPERATION_KINDS.has(request.expectedOperationKind)) throw invalid();
    const stableServerId = target.stableServerId === null ? null : assertIdentifier(target.stableServerId);
    if (target.kind === 'existing' && stableServerId === null) throw invalid();
    const binding = { target: { kind: target.kind, stableServerId, path: normalizeRecoveryTargetPath(target.path) },
      operationKind: request.expectedOperationKind };
    const release = await this.#acquireHistoryPublication();
    try {
      const before = this.#classifyTerminalPublication(jobId, binding);
      if (before.status === 'already-published') {
        return Object.freeze({ status: before.status, record: Object.freeze(strictJsonClone(before.record.value)) });
      }
      await this.yieldControl();
      this.#revalidateRegistryDirectories();
      if (this.#entryExists(this.#historyEnvelopePath(jobId))) throw targetExists();
      await this.durableFs.renameDurableAsync(this.#envelopePath(jobId), this.#historyEnvelopePath(jobId), {
        expectedSourceSha256: before.envelope.sha256
      });
      this.#revalidateRegistryDirectories();
      await this.yieldControl();
      const after = this.#classifyTerminalPublication(jobId, binding);
      if (after.status !== 'already-published' || after.record.sha256 !== before.record.sha256 ||
          !sameJson(after.record.value, before.record.value)) throw recoveryRequired();
      return Object.freeze({ status: 'published', record: Object.freeze(strictJsonClone(after.record.value)) });
    } catch (error) {
      throw commitFailure(error);
    } finally {
      release();
    }
  }

  // Explicit locations are essential: the ordinary history reader deliberately
  // accepts an active envelope, which is not proof of completed publication.
  #classifyTerminalPublication(jobId, binding = null) {
    this.#revalidateRegistryDirectories();
    for (const filePath of [this.#recordPath(jobId), this.#historyRecordPath(jobId),
      this.#envelopePath(jobId), this.#historyEnvelopePath(jobId)]) {
      if (this.#entryExists(filePath) && BigInt(this.fs.lstatSync(filePath, { bigint: true }).nlink) !== 1n) throw recoveryRequired();
    }
    if (this.#entryExists(this.#recordPath(jobId)) || !this.#entryExists(this.#historyRecordPath(jobId))) throw recoveryRequired();
    const activeEnvelope = this.#entryExists(this.#envelopePath(jobId));
    const historyEnvelope = this.#entryExists(this.#historyEnvelopePath(jobId));
    if (activeEnvelope === historyEnvelope) throw recoveryRequired();
    const record = this.#readRecord(this.#historyRecordPath(jobId), { allowMissing: false, expectedJobId: jobId });
    if (!TERMINAL_PHASES.has(record.value.phase) || record.value.outcome?.runtimeWriterAuthority?.state === 'unproven') throw recoveryRequired();
    if (binding && (record.value.operationKind !== binding.operationKind || !sameJson(record.value.target, binding.target))) throw recoveryRequired();
    const envelope = this.#tryReadEnvelope(activeEnvelope ? this.#envelopePath(jobId) : this.#historyEnvelopePath(jobId));
    const expected = createRecoveryTargetEnvelope(record.value);
    if (!envelope.value || envelope.value.jobId !== jobId || envelope.value.stableServerId !== expected.stableServerId ||
        envelope.value.targetPathHash !== expected.targetPathHash) throw recoveryRequired(envelope.error);
    this.#revalidateRegistryDirectories();
    return { status: activeEnvelope ? 'pending' : 'already-published', record, envelope };
  }

  async transition(jobId, request) {
    await this.#awaitHistoryStable();
    this.#assertInitialized();
    assertIdentifier(jobId, JOB_ID_PATTERN);
    assertStrictObject(request, ['expectedPhase', 'nextPhase', 'patch']);
    if (!PHASES.has(request.expectedPhase) || !PHASES.has(request.nextPhase)) throw invalid();
    const patch = request.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.getPrototypeOf(patch) !== Object.prototype ||
        Object.getOwnPropertySymbols(patch).length !== 0 || Object.keys(patch).some(key => !TRANSITION_KEYS.has(key))) throw invalid();
    const loaded = this.#readRecord(this.#recordPath(jobId), { allowMissing: false, expectedJobId: jobId });
    if (loaded.value.phase !== request.expectedPhase) throw stale();
    if (TERMINAL_PHASES.has(loaded.value.phase)) throw stale();
    const safePatch = strictJsonClone(patch);
    if (Object.hasOwn(safePatch, 'outcome')) safePatch.outcome = this.#preserveRuntimeAuthority(loaded.value, safePatch.outcome,
      loaded.value.phase === 'queued' && request.nextPhase === 'preflight');
    const candidate = normalizeRecord({
      ...loaded.value,
      ...safePatch,
      sequence: loaded.value.sequence + 1,
      phase: request.nextPhase,
      updatedAt: this.#now()
    });
    assertRestoreCreationTransition(loaded.value.restoreCreation, candidate.restoreCreation, {
      previousPhase: loaded.value.phase,
      nextPhase: candidate.phase,
      previousRestorePoint: loaded.value.restorePoint,
      nextRestorePoint: candidate.restorePoint
    });
    try {
      this.#revalidateRegistryDirectories();
      await this.durableFs.writeJsonAtomicAsync(this.#recordPath(jobId), candidate, { expectedTargetSha256: loaded.sha256 });
      this.#revalidateRegistryDirectories();
      return Object.freeze(strictJsonClone(candidate));
    } catch (error) {
      throw commitFailure(error);
    }
  }

  #preserveRuntimeAuthority(previous, outcome, declaringProtocol = false) {
    const result = outcome === null ? {} : { ...outcome };
    for (const field of ['runtimeWriterAuthority', 'runtimeWriterProtocol', 'runtimeWriterFailure']) {
      const before = previous.outcome?.[field];
      if (before !== undefined) {
        if (Object.hasOwn(result, field) && !sameJson(result[field], before)) throw stale();
        result[field] = before;
      } else if (Object.hasOwn(result, field) && !(field === 'runtimeWriterProtocol' && declaringProtocol && result[field] === 1)) throw invalid();
    }
    return outcome === null && Object.keys(result).length === 0 ? null : result;
  }

  async updateRuntimeWriterAuthority(jobId, request) {
    await this.#awaitHistoryStable(); this.#assertInitialized(); assertIdentifier(jobId, JOB_ID_PATTERN);
    assertStrictObject(request, ['expectedSequence', 'authority', 'failureCode', ...(Object.hasOwn(request, 'diagnostic') ? ['diagnostic'] : [])]);
    let diagnostic = null;
    if (Object.hasOwn(request, 'diagnostic')) {
      try { diagnostic = normalizeRuntimeDiagnostic(request.diagnostic); } catch (error) { throw invalid(error); }
      if (request.failureCode === null) throw invalid();
    }
    if (!Number.isSafeInteger(request.expectedSequence) || request.expectedSequence < 0 ||
        (request.failureCode !== null && (typeof request.failureCode !== 'string' || !FAILURE_CODES.includes(request.failureCode)))) throw invalid();
    const loaded = this.#readRecord(this.#recordPath(jobId), { allowMissing: false, expectedJobId: jobId });
    if (loaded.value.sequence !== request.expectedSequence) throw stale();
    const authority = normalizeRuntimeWriterAuthority(request.authority, loaded.value);
    const previous = loaded.value.outcome?.runtimeWriterAuthority;
    const previousFailure = loaded.value.outcome?.runtimeWriterFailure;
    if (previousFailure && request.failureCode !== null && previousFailure.code !== request.failureCode) throw stale();
    if (previousFailure && diagnostic && !sameJson(previousFailure.diagnostic, diagnostic)) throw stale();
    if (previous) {
      if (!sameJson({ ...previous, state: authority.state }, authority) ||
          (previous.state === 'settled' && authority.state !== 'settled')) throw stale();
    } else if (authority.state !== 'unproven') throw invalid();
    const candidate = normalizeRecord({ ...loaded.value, sequence: loaded.value.sequence + 1, updatedAt: this.#now(),
      outcome: { ...(loaded.value.outcome || {}), runtimeWriterAuthority: authority,
        ...(request.failureCode === null ? {} : { runtimeWriterFailure: previousFailure || {
          code: request.failureCode, ...(diagnostic ? { diagnostic } : {})
        } }) } });
    try {
      this.#revalidateRegistryDirectories();
      await this.durableFs.writeJsonAtomicAsync(this.#recordPath(jobId), candidate, { expectedTargetSha256: loaded.sha256 });
      this.#revalidateRegistryDirectories(); return Object.freeze(strictJsonClone(candidate));
    } catch (cause) { throw commitFailure(cause); }
  }

  async clearRestoreCreationAfterCleanup(jobId, request) {
    await this.#awaitHistoryStable();
    this.#assertInitialized();
    assertIdentifier(jobId, JOB_ID_PATTERN);
    assertStrictObject(request, ['expectedPhase', 'expectedCreation']);
    if (!['preflight', 'snapshotting'].includes(request.expectedPhase)) throw invalid();
    const expectedCreation = normalizeRestoreCreation(request.expectedCreation, jobId);
    if (expectedCreation === null) throw invalid();
    const loaded = this.#readRecord(this.#recordPath(jobId), { allowMissing: false, expectedJobId: jobId });
    if (loaded.value.phase !== request.expectedPhase ||
        !sameJson(loaded.value.restoreCreation, expectedCreation)) throw stale();
    const candidate = normalizeRecord({
      ...loaded.value,
      restorePoint: null,
      restoreCreation: null,
      sequence: loaded.value.sequence + 1,
      updatedAt: this.#now()
    });
    try {
      this.#revalidateRegistryDirectories();
      await this.durableFs.writeJsonAtomicAsync(this.#recordPath(jobId), candidate, { expectedTargetSha256: loaded.sha256 });
      this.#revalidateRegistryDirectories();
      return Object.freeze(strictJsonClone(candidate));
    } catch (error) {
      throw commitFailure(error);
    }
  }

  async finish(jobId, request) {
    this.#assertInitialized();
    assertIdentifier(jobId, JOB_ID_PATTERN);
    assertStrictObject(request, ['terminalPhase', 'outcome']);
    if (!TERMINAL_PHASES.has(request.terminalPhase)) throw invalid();
    const releaseHistoryPublication = await this.#acquireHistoryPublication();
    try {
    let outcome = normalizeOutcome(request.outcome);
    const activeRecordPath = this.#recordPath(jobId);
    const historyRecordPath = this.#historyRecordPath(jobId);
    const activeEnvelopePath = this.#envelopePath(jobId);
    const historyEnvelopePath = this.#historyEnvelopePath(jobId);
    let terminal;
    let recordSourceSha256 = null;
    let envelopeSourceSha256 = null;
    const active = this.#readRecord(activeRecordPath, { allowMissing: true, expectedJobId: jobId });
    if (active) {
      outcome = this.#preserveRuntimeAuthority(active.value, outcome);
      if (active.value.outcome?.runtimeWriterAuthority?.state === 'unproven') throw recoveryRequired();
      const envelopeEvidence = this.#assertEnvelopeMatches(active.value);
      envelopeSourceSha256 = envelopeEvidence.sha256;
      if (TERMINAL_PHASES.has(active.value.phase) &&
          (active.value.phase !== request.terminalPhase || !sameJson(active.value.outcome, outcome))) throw stale();
      if (active.value.phase === request.terminalPhase && sameJson(active.value.outcome, outcome)) {
        terminal = active.value;
        recordSourceSha256 = active.sha256;
      } else {
        terminal = normalizeRecord({
          ...active.value,
          sequence: active.value.sequence + 1,
          phase: request.terminalPhase,
          updatedAt: this.#now(),
          outcome
        });
        try {
          this.#revalidateRegistryDirectories();
          await this.durableFs.writeJsonAtomicAsync(activeRecordPath, terminal, { expectedTargetSha256: active.sha256 });
          this.#revalidateRegistryDirectories();
          recordSourceSha256 = digest(Buffer.from(`${JSON.stringify(terminal, null, 2)}\n`, 'utf8'));
        } catch (error) {
          throw commitFailure(error);
        }
      }
    } else {
      const historical = this.#readRecord(historyRecordPath, { allowMissing: true, expectedJobId: jobId });
      if (historical) outcome = this.#preserveRuntimeAuthority(historical.value, outcome);
      if (!historical || historical.value.phase !== request.terminalPhase || !sameJson(historical.value.outcome, outcome)) {
        throw recoveryRequired();
      }
      terminal = historical.value;
      const envelopeEvidence = this.#assertEnvelopeMatches(terminal);
      envelopeSourceSha256 = envelopeEvidence.sha256;
    }

    // The terminal record is already durable and retryable here. Give Electron
    // one main-loop turn before the two authenticated history moves. The
    // instance-local publication barrier keeps registry readers and writers from
    // observing the recoverable record-first split while each native move runs
    // off-thread. A restarted registry also recognizes that split as blocking.
    await this.yieldControl();

    try {
      if (this.#entryExists(activeRecordPath)) {
        if (this.#entryExists(historyRecordPath)) throw targetExists();
        this.#revalidateRegistryDirectories();
        await this.durableFs.renameDurableAsync(activeRecordPath, historyRecordPath, {
          expectedSourceSha256: recordSourceSha256
        });
        this.#revalidateRegistryDirectories();
      }
      if (this.#entryExists(activeEnvelopePath)) {
        if (this.#entryExists(historyEnvelopePath)) throw targetExists();
        this.#revalidateRegistryDirectories();
        await this.durableFs.renameDurableAsync(activeEnvelopePath, historyEnvelopePath, {
          expectedSourceSha256: envelopeSourceSha256
        });
        this.#revalidateRegistryDirectories();
      }
      if (!this.#entryExists(historyRecordPath) || !this.#entryExists(historyEnvelopePath)) throw recoveryRequired();
      const publishedRecord = this.#readRecord(historyRecordPath, { allowMissing: false, expectedJobId: jobId });
      if (!sameJson(publishedRecord.value, terminal)) throw recoveryRequired();
      this.#assertEnvelopeMatches(publishedRecord.value);
      return Object.freeze(strictJsonClone(terminal));
    } catch (error) {
      throw commitFailure(error);
    }
    } finally {
      releaseHistoryPublication();
    }
  }

  async #awaitHistoryStable() {
    while (true) {
      const observed = this.historyPublication;
      await observed;
      if (observed === this.historyPublication) return;
    }
  }

  async #acquireHistoryPublication() {
    const previous = this.historyPublication;
    let releaseGate;
    const gate = new Promise(resolve => { releaseGate = resolve; });
    this.historyPublication = previous.then(() => gate, () => gate);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
    };
  }

  #initializeDirectories() {
    for (const [pinName, directory, parent] of [
      ['root', this.rootPath, this.userDataPath],
      ['active', this.activePath, this.rootPath],
      ['history', this.historyPath, this.rootPath]
    ]) {
      this.#revalidatePinnedDirectory('userData', this.userDataPath);
      if (!sameLocalPath(parent, this.userDataPath)) this.#revalidatePinnedDirectory('root', this.rootPath);
      try {
        this.fs.lstatSync(directory, { bigint: true });
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw commitFailure(error);
        this.fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
      }
      const stat = this.fs.lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameLocalPath(this.fs.realpathSync.native(directory), directory)) {
        throw commitFailure();
      }
      const identity = registryDirectoryIdentity(stat);
      if (this.directoryPins[pinName] && !sameRegistryDirectory(this.directoryPins[pinName], identity)) {
        throw recoveryRequired();
      }
      if (!this.directoryPins[pinName]) this.directoryPins[pinName] = identity;
      this.durableFs.flushDirectory(parent);
    }
    this.#revalidateRegistryDirectories();
    this.initialized = true;
  }

  #assertInitialized() {
    if (!this.initialized) throw invalid();
    this.#revalidateRegistryDirectories();
  }

  #revalidatePinnedDirectory(pinName, directoryPath) {
    try {
      const stat = this.fs.lstatSync(directoryPath, { bigint: true });
      const expected = this.directoryPins[pinName];
      if (!expected || !stat.isDirectory() || stat.isSymbolicLink() ||
          !sameRegistryDirectory(expected, registryDirectoryIdentity(stat)) ||
          !sameLocalPath(this.fs.realpathSync.native(directoryPath), directoryPath)) throw recoveryRequired();
    } catch (error) {
      throw recoveryRequired(error);
    }
  }

  #revalidateRegistryDirectories() {
    this.#revalidatePinnedDirectory('userData', this.userDataPath);
    this.#revalidatePinnedDirectory('root', this.rootPath);
    this.#revalidatePinnedDirectory('active', this.activePath);
    this.#revalidatePinnedDirectory('history', this.historyPath);
  }

  #now() {
    let value;
    try { value = this.clock(); } catch (error) { throw invalid(error); }
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalid();
    return value.toISOString();
  }

  #entryExists(candidate) {
    this.#revalidateRegistryDirectories();
    try {
      const stat = this.fs.lstatSync(candidate, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw recoveryRequired();
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  #recordPath(jobId) { return path.join(this.activePath, `${jobId}.json`); }
  #envelopePath(jobId) { return path.join(this.activePath, `${jobId}.target.json`); }
  #historyRecordPath(jobId) { return path.join(this.historyPath, `${jobId}.json`); }
  #historyEnvelopePath(jobId) { return path.join(this.historyPath, `${jobId}.target.json`); }

  #readJson(filePath, { allowMissing }) {
    this.#revalidateRegistryDirectories();
    const bytes = this.durableFs.readFileBounded(filePath, { allowMissing, maxBytes: MAX_RECORD_BYTES });
    if (bytes === null) {
      this.#revalidateRegistryDirectories();
      return null;
    }
    const value = strictJsonClone(JSON.parse(bytes.toString('utf8')), {
      maxDepth: 32,
      maxCollection: 4096,
      maxStringBytes: 256 * 1024
    });
    this.#revalidateRegistryDirectories();
    return { value, sha256: digest(bytes) };
  }

  #readRecord(filePath, { allowMissing, expectedJobId }) {
    try {
      const loaded = this.#readJson(filePath, { allowMissing });
      if (!loaded) return null;
      const normalized = normalizeRecord(loaded.value);
      if (normalized.jobId !== expectedJobId) throw recoveryRequired();
      return { value: normalized, sha256: loaded.sha256 };
    } catch (error) {
      if (allowMissing && error && error.code === 'ENOENT') return null;
      throw recoveryRequired(error);
    }
  }

  #tryReadRecord(filePath, expectedJobId) {
    try {
      const loaded = this.#readJson(filePath, { allowMissing: false });
      const normalized = normalizeRecord(loaded.value);
      if (normalized.jobId !== expectedJobId) {
        return { value: null, identifyingValue: normalized, error: recoveryRequired() };
      }
      return { value: normalized, identifyingValue: null, error: null };
    } catch (error) {
      return { value: null, identifyingValue: null, error };
    }
  }

  #tryReadEnvelope(filePath) {
    try {
      const loaded = this.#readJson(filePath, { allowMissing: false });
      return { value: verifyRecoveryTargetEnvelope(loaded.value), sha256: loaded.sha256, error: null };
    } catch (error) {
      return { value: null, error };
    }
  }

  #assertEnvelopeMatches(record) {
    const activePath = this.#envelopePath(record.jobId);
    const historyPath = this.#historyEnvelopePath(record.jobId);
    const envelopePath = this.#entryExists(activePath) ? activePath : (this.#entryExists(historyPath) ? historyPath : null);
    if (!envelopePath) throw recoveryRequired();
    const loaded = this.#tryReadEnvelope(envelopePath);
    if (!loaded.value) throw recoveryRequired(loaded.error);
    const expected = createRecoveryTargetEnvelope(record);
    if (loaded.value.jobId !== expected.jobId || loaded.value.stableServerId !== expected.stableServerId ||
        loaded.value.targetPathHash !== expected.targetPathHash) throw recoveryRequired();
    return loaded;
  }
}

module.exports = {
  PHASES,
  RECORD_SCHEMA_VERSION,
  RecoveryRegistry,
  SWAP_STEPS,
  TERMINAL_PHASES,
  normalizeRecord
};
