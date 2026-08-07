const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeServerDirectoryPath } = require('./server-directory-identity.cjs');

const JOURNAL_TYPE = 'minecraft-core-operation-journal';
const MARKER_TYPE = 'minecraft-core-directory-marker';
const SCHEMA_VERSION = 1;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_KINDS = new Set([
  'install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback', 'import', 'detach', 'uninstall', 'verify'
]);
const PHASES = new Set([
  'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering', 'registered',
  'starting', 'validating-live', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed',
  'rolling-back', 'rolled-back', 'failed', 'recovery-required'
]);
const SWAP_STEPS = new Set([
  'none', 'prepared', 'new-prepared', 'live-moved', 'candidate-published', 'failed-canonical-moved',
  'rollback-restored', 'cleanup-complete'
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTITY_KEYS = Object.freeze(['volumeSerial', 'fileId']);
const MARKER_KEYS = Object.freeze([
  'type', 'schemaVersion', 'jobId', 'operationKind', 'stableInstanceId', 'createdAt', 'checksum'
]);
const JOURNAL_KEYS = Object.freeze([
  'type', 'schemaVersion', 'sequence', 'jobId', 'operationKind', 'stableInstanceId', 'targetPathHash',
  'phase', 'swapStep', 'candidateIdentity', 'targetIdentity', 'rollbackIdentity', 'failedIdentity',
  'sourceFingerprint', 'candidateFingerprint', 'rollbackFingerprint', 'revisionEventId', 'revisionEventPublished',
  'markerSha256', 'targetAbsence', 'registration', 'createdAt', 'updatedAt', 'checksum'
]);
const ABSENCE_KEYS = Object.freeze([
  'parentIdentity', 'targetPathHash', 'targetNameHash', 'observedAt'
]);
const REGISTRATION_KEYS = Object.freeze(['instanceId', 'complete']);
const CREATE_KEYS = Object.freeze([
  'jobId', 'operationKind', 'stableInstanceId', 'targetPath', 'candidateIdentity', 'markerSha256'
]);
const TRANSITION_KEYS = Object.freeze(['expectedPhase', 'nextPhase', 'patch']);
const PATCH_KEYS = new Set([
  'swapStep', 'candidateIdentity', 'targetIdentity', 'rollbackIdentity', 'failedIdentity', 'candidateFingerprint',
  'sourceFingerprint', 'rollbackFingerprint', 'revisionEventId', 'revisionEventPublished', 'targetAbsence', 'registration'
]);

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The operation journal request is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale', { cause });
}

function commitFailure(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('COMMIT_FAILED', 'The operation journal could not be updated', { cause });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The operation journal cannot be trusted', { cause });
}

function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length !== keys.length || names.some(name => !keys.includes(name))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) throw invalid();
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      new Date(value).toISOString() !== value) throw invalid();
  return value;
}

function identity(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  strictObject(value, IDENTITY_KEYS);
  if (typeof value.volumeSerial !== 'string' || !/^[a-f0-9]{1,32}$/.test(value.volumeSerial) ||
      typeof value.fileId !== 'string' || !/^[a-f0-9]{1,64}$/.test(value.fileId)) throw invalid();
  return { volumeSerial: value.volumeSerial, fileId: value.fileId };
}

function targetPathHash(targetPath) {
  const normalized = normalizeServerDirectoryPath(targetPath).normalize('NFC').toLocaleLowerCase('en-US');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function checksumPayload(value, marker = false) {
  const keys = marker ? MARKER_KEYS : JOURNAL_KEYS;
  const payload = {};
  for (const key of keys) {
    if (key !== 'checksum') payload[key] = value[key];
  }
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function secureChecksumEquals(actual, expected) {
  if (typeof actual !== 'string' || !SHA256_PATTERN.test(actual) || typeof expected !== 'string' || !SHA256_PATTERN.test(expected)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function createDirectoryMarker(value) {
  strictObject(value, ['jobId', 'operationKind', 'stableInstanceId', 'createdAt']);
  if (!OPERATION_KINDS.has(value.operationKind)) throw invalid();
  const marker = {
    type: MARKER_TYPE,
    schemaVersion: SCHEMA_VERSION,
    jobId: identifier(value.jobId),
    operationKind: value.operationKind,
    stableInstanceId: identifier(value.stableInstanceId),
    createdAt: timestamp(value.createdAt),
    checksum: ''
  };
  marker.checksum = checksumPayload(marker, true);
  return deepFreeze(marker);
}

function verifyDirectoryMarker(value, expected = null) {
  strictObject(value, MARKER_KEYS);
  if (value.type !== MARKER_TYPE || value.schemaVersion !== SCHEMA_VERSION || !OPERATION_KINDS.has(value.operationKind)) throw invalid();
  identifier(value.jobId);
  identifier(value.stableInstanceId);
  timestamp(value.createdAt);
  if (!secureChecksumEquals(value.checksum, checksumPayload(value, true))) throw recoveryRequired();
  if (expected !== null) {
    strictObject(expected, ['jobId', 'stableInstanceId']);
    if (value.jobId !== identifier(expected.jobId) || value.stableInstanceId !== identifier(expected.stableInstanceId)) {
      throw recoveryRequired();
    }
  }
  return deepFreeze({ ...value });
}

function normalizeAbsence(value, { nullable = true } = {}) {
  if (nullable && value === null) return null;
  strictObject(value, ABSENCE_KEYS);
  if (typeof value.targetPathHash !== 'string' || !SHA256_PATTERN.test(value.targetPathHash) ||
      typeof value.targetNameHash !== 'string' || !SHA256_PATTERN.test(value.targetNameHash)) throw invalid();
  return {
    parentIdentity: identity(value.parentIdentity),
    targetPathHash: value.targetPathHash,
    targetNameHash: value.targetNameHash,
    observedAt: timestamp(value.observedAt)
  };
}

function normalizeRegistration(value) {
  if (value === null) return null;
  strictObject(value, REGISTRATION_KEYS);
  if (typeof value.complete !== 'boolean') throw invalid();
  return { instanceId: identifier(value.instanceId), complete: value.complete };
}

function nullableHash(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw invalid();
  return value;
}

function nullableEventId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 384 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw invalid();
  return value;
}

function normalizeJournal(value) {
  strictObject(value, JOURNAL_KEYS);
  if (value.type !== JOURNAL_TYPE || value.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 || !OPERATION_KINDS.has(value.operationKind) || !PHASES.has(value.phase) ||
      !SWAP_STEPS.has(value.swapStep) || typeof value.targetPathHash !== 'string' || !SHA256_PATTERN.test(value.targetPathHash) ||
      (value.candidateFingerprint !== null && (typeof value.candidateFingerprint !== 'string' || !SHA256_PATTERN.test(value.candidateFingerprint))) ||
      typeof value.markerSha256 !== 'string' || !SHA256_PATTERN.test(value.markerSha256)) throw invalid();
  const result = {
    type: value.type,
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    jobId: identifier(value.jobId),
    operationKind: value.operationKind,
    stableInstanceId: identifier(value.stableInstanceId),
    targetPathHash: value.targetPathHash,
    phase: value.phase,
    swapStep: value.swapStep,
    candidateIdentity: identity(value.candidateIdentity),
    targetIdentity: identity(value.targetIdentity, { nullable: true }),
    rollbackIdentity: identity(value.rollbackIdentity, { nullable: true }),
    failedIdentity: identity(value.failedIdentity, { nullable: true }),
    sourceFingerprint: nullableHash(value.sourceFingerprint),
    candidateFingerprint: nullableHash(value.candidateFingerprint),
    rollbackFingerprint: nullableHash(value.rollbackFingerprint),
    revisionEventId: nullableEventId(value.revisionEventId),
    revisionEventPublished: value.revisionEventPublished,
    markerSha256: value.markerSha256,
    targetAbsence: normalizeAbsence(value.targetAbsence),
    registration: normalizeRegistration(value.registration),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    checksum: value.checksum
  };
  if (typeof result.revisionEventPublished !== 'boolean' ||
      (result.revisionEventPublished && result.revisionEventId === null)) throw invalid();
  if (!secureChecksumEquals(value.checksum, checksumPayload(result))) throw recoveryRequired();
  return result;
}

async function createTargetAbsenceEvidence(targetValue, parentIdentity, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !['clock', 'fsApi'].includes(key))) throw invalid();
  const clock = options.clock || (() => new Date());
  const fsApi = options.fsApi || fs;
  if (typeof clock !== 'function' || !fsApi || typeof fsApi.lstatSync !== 'function') throw invalid();
  const targetPath = normalizeServerDirectoryPath(targetValue);
  let target;
  try { target = fsApi.lstatSync(targetPath, { bigint: true, throwIfNoEntry: false }); }
  catch (error) { if (error?.code !== 'ENOENT') throw invalid(error); }
  if (target) throw new ModpackError('TARGET_EXISTS', 'The selected server directory already exists');
  const observedAt = clock();
  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) throw invalid();
  return deepFreeze({
    parentIdentity: identity(parentIdentity),
    targetPathHash: targetPathHash(targetPath),
    targetNameHash: crypto.createHash('sha256')
      .update(path.basename(targetPath).normalize('NFC').toLocaleLowerCase('en-US'), 'utf8').digest('hex'),
    observedAt: observedAt.toISOString()
  });
}

class OperationJournal {
  constructor(dependencies = {}) {
    strictObject(dependencies, ['durableFs', 'fsApi', 'clock']);
    this.durableFs = dependencies.durableFs;
    this.fs = dependencies.fsApi;
    this.clock = dependencies.clock;
    if (!this.durableFs || typeof this.durableFs.readFileBounded !== 'function' ||
        typeof this.durableFs.writeJsonAtomic !== 'function' || !this.fs || typeof this.clock !== 'function') throw invalid();
  }

  create(journalPath, value) {
    strictObject(value, CREATE_KEYS);
    if (!OPERATION_KINDS.has(value.operationKind)) throw invalid();
    const now = this.#now();
    const record = {
      type: JOURNAL_TYPE,
      schemaVersion: SCHEMA_VERSION,
      sequence: 0,
      jobId: identifier(value.jobId),
      operationKind: value.operationKind,
      stableInstanceId: identifier(value.stableInstanceId),
      targetPathHash: targetPathHash(value.targetPath),
      phase: 'staging',
      swapStep: 'none',
      candidateIdentity: identity(value.candidateIdentity),
      targetIdentity: null,
      rollbackIdentity: null,
      failedIdentity: null,
      sourceFingerprint: null,
      candidateFingerprint: null,
      rollbackFingerprint: null,
      revisionEventId: null,
      revisionEventPublished: false,
      markerSha256: value.markerSha256,
      targetAbsence: null,
      registration: null,
      createdAt: now,
      updatedAt: now,
      checksum: ''
    };
    if (typeof record.markerSha256 !== 'string' || !SHA256_PATTERN.test(record.markerSha256)) throw invalid();
    record.checksum = checksumPayload(record);
    try {
      this.durableFs.writeJsonAtomic(journalPath, record, { expectedTargetSha256: null });
      return deepFreeze(normalizeJournal(record));
    } catch (error) {
      throw commitFailure(error);
    }
  }

  load(journalPath) {
    return deepFreeze(this.#load(journalPath).value);
  }

  transition(journalPath, request) {
    strictObject(request, TRANSITION_KEYS);
    if (!PHASES.has(request.expectedPhase) || !PHASES.has(request.nextPhase)) throw invalid();
    if (!request.patch || typeof request.patch !== 'object' || Array.isArray(request.patch) ||
        Object.getPrototypeOf(request.patch) !== Object.prototype || Object.getOwnPropertySymbols(request.patch).length !== 0 ||
        Object.keys(request.patch).some(key => !PATCH_KEYS.has(key))) throw invalid();
    const loaded = this.#load(journalPath);
    if (loaded.value.phase !== request.expectedPhase) throw stale();
    const patch = {};
    if (Object.hasOwn(request.patch, 'swapStep')) {
      if (!SWAP_STEPS.has(request.patch.swapStep)) throw invalid();
      patch.swapStep = request.patch.swapStep;
    }
    if (Object.hasOwn(request.patch, 'candidateIdentity')) patch.candidateIdentity = identity(request.patch.candidateIdentity);
    if (Object.hasOwn(request.patch, 'targetIdentity')) patch.targetIdentity = identity(request.patch.targetIdentity, { nullable: true });
    if (Object.hasOwn(request.patch, 'rollbackIdentity')) patch.rollbackIdentity = identity(request.patch.rollbackIdentity, { nullable: true });
    if (Object.hasOwn(request.patch, 'failedIdentity')) patch.failedIdentity = identity(request.patch.failedIdentity, { nullable: true });
    if (Object.hasOwn(request.patch, 'sourceFingerprint')) patch.sourceFingerprint = nullableHash(request.patch.sourceFingerprint);
    if (Object.hasOwn(request.patch, 'candidateFingerprint')) {
      if (typeof request.patch.candidateFingerprint !== 'string' || !SHA256_PATTERN.test(request.patch.candidateFingerprint)) throw invalid();
      patch.candidateFingerprint = request.patch.candidateFingerprint;
    }
    if (Object.hasOwn(request.patch, 'rollbackFingerprint')) patch.rollbackFingerprint = nullableHash(request.patch.rollbackFingerprint);
    if (Object.hasOwn(request.patch, 'revisionEventId')) patch.revisionEventId = nullableEventId(request.patch.revisionEventId);
    if (Object.hasOwn(request.patch, 'revisionEventPublished')) {
      if (typeof request.patch.revisionEventPublished !== 'boolean') throw invalid();
      patch.revisionEventPublished = request.patch.revisionEventPublished;
    }
    if (Object.hasOwn(request.patch, 'targetAbsence')) patch.targetAbsence = normalizeAbsence(request.patch.targetAbsence, { nullable: false });
    if (Object.hasOwn(request.patch, 'registration')) patch.registration = normalizeRegistration(request.patch.registration);
    const candidate = {
      ...loaded.value,
      ...patch,
      sequence: loaded.value.sequence + 1,
      phase: request.nextPhase,
      updatedAt: this.#now(),
      checksum: ''
    };
    candidate.checksum = checksumPayload(candidate);
    try {
      this.durableFs.writeJsonAtomic(journalPath, candidate, { expectedTargetSha256: loaded.sha256 });
      return deepFreeze(normalizeJournal(candidate));
    } catch (error) {
      throw commitFailure(error);
    }
  }

  #load(journalPath) {
    try {
      const bytes = this.durableFs.readFileBounded(journalPath, { allowMissing: false, maxBytes: MAX_JOURNAL_BYTES });
      const value = normalizeJournal(JSON.parse(bytes.toString('utf8')));
      return {
        value,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      };
    } catch (error) {
      if (error instanceof ModpackError && error.code === 'INVALID_REQUEST') throw recoveryRequired(error);
      if (error instanceof ModpackError) throw error;
      throw recoveryRequired(error);
    }
  }

  #now() {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalid();
    return value.toISOString();
  }
}

module.exports = {
  JOURNAL_TYPE,
  MARKER_TYPE,
  OperationJournal,
  createDirectoryMarker,
  createTargetAbsenceEvidence,
  verifyDirectoryMarker
};
