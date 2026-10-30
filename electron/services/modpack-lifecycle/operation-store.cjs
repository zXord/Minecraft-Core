const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { compactOperationIdFromRandomSource } = require('./operation-id.cjs');

const {
  createDeferredDirectoryFlushes,
  isDurableTempLeftover,
  strictJsonClone
} = require('../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeFailureDiagnostic } = require('./publication-failure-diagnostic.cjs');
const { normalizeRecoveryTargetPath } = require('./recovery-target-envelope.cjs');
const { isSafeWindowsBasename } = require('../modpacks/windows-basename.cjs');

const JOB_TYPE = 'minecraft-core-modpack-job';
const JOB_SCHEMA_VERSION = 1;
const MAX_JOB_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 128;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOB_RECORD_NAME = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\.json$/;
const OPERATION_KIND = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SWAP_STEP = /^[a-z][a-z0-9-]{0,63}$/;
const JOB_PHASES = Object.freeze([
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight',
  'snapshotting', 'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering',
  'starting', 'validating-live', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed', 'cancelling',
  'cancelled', 'rolling-back', 'rolled-back', 'failed', 'recovery-required'
]);
const JOB_PHASE_SET = new Set(JOB_PHASES);
const TERMINAL_PHASES = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);
const CANCELLABLE_PHASES = new Set([
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight',
  'snapshotting', 'staging', 'validating-candidate'
]);
const NEW_SERVER_OPERATION_KINDS = new Set(['install-new', 'import-files-only-new']);
const MUTATION_TRANSITIONS = Object.freeze({
  queued: ['resolving', 'preflight', 'cancelling', 'failed'],
  resolving: ['downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'cancelling', 'failed'],
  downloading: ['verifying', 'cancelling', 'failed'],
  verifying: ['inspecting', 'cancelling', 'failed'],
  inspecting: ['planning', 'awaiting-user', 'cancelling', 'failed'],
  planning: ['awaiting-user', 'cancelling', 'failed'],
  'awaiting-user': ['preflight', 'cancelling', 'failed'],
  preflight: ['snapshotting', 'staging', 'cancelling', 'failed', 'recovery-required'],
  snapshotting: ['staging', 'cancelling', 'failed', 'recovery-required'],
  staging: ['validating-candidate', 'committing', 'cancelling', 'failed', 'recovery-required'],
  'validating-candidate': ['committing', 'cancelling', 'failed', 'recovery-required'],
  committing: ['publishing', 'starting', 'validating-live', 'rolling-back', 'recovery-required'],
  publishing: ['published', 'rolling-back', 'recovery-required'],
  published: ['registering', 'starting', 'validating-live', 'rolling-back', 'recovery-required'],
  registering: ['starting', 'validating-live', 'committed-healthy', 'rolling-back', 'recovery-required'],
  starting: ['validating-live', 'rolling-back', 'recovery-required'],
  'validating-live': ['committed-healthy', 'rolling-back', 'recovery-required'],
  'committed-healthy': ['cleanup', 'cleanup-pending'],
  cleanup: ['completed', 'cleanup-pending'],
  'cleanup-pending': ['cleanup', 'completed', 'recovery-required'],
  cancelling: ['cancelled', 'failed', 'recovery-required'],
  'rolling-back': ['rolled-back', 'recovery-required']
});
const RECORD_KEYS = Object.freeze([
  'type', 'schemaVersion', 'sequence', 'jobId', 'operationKind', 'serverId', 'planFingerprint', 'phase', 'swapStep',
  'progress', 'cancellationRequested', 'createdAt', 'updatedAt', 'terminalAt', 'outcome', 'events', 'checksum'
]);
const PUBLIC_KEYS = Object.freeze(RECORD_KEYS.filter(key => key !== 'checksum'));
const BINDING_KEYS = Object.freeze(['planId', 'planFingerprint', 'instanceId', 'targetPath',
  'capturedReservation', 'displayName', 'destinationDisposition']);
const LAUNCH_PLAN_ID = /^plan-launch-v1-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const EVENT_KEYS = Object.freeze([
  'sequence', 'jobId', 'channel', 'phase', 'timestamp', 'message', 'progress', 'currentItem', 'details'
]);
const FORBIDDEN_PUBLIC_KEY = /(?:path|url|uri|token|secret|password|command|arguments?|headers?|authorization|cookie|cache|workspace|directory|provider.?internal|inputDirectoryId|outputDirectoryId|artifactSetId|inspectionId|planningSessionId)/i;

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The modpack job request is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale', { cause });
}

function commitFailure(cause) {
  return new ModpackError('COMMIT_FAILED', 'The modpack job could not be updated', { cause });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The stored modpack job cannot be trusted', { cause });
}

function targetExists(cause) {
  return new ModpackError('TARGET_EXISTS', 'The modpack job already exists', { cause });
}

function strictObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.some(name => !allowedKeys.includes(name)) || requiredKeys.some(name => !Object.hasOwn(descriptors, name))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return descriptors;
}

function clone(value) {
  try { return strictJsonClone(value); }
  catch (error) { throw invalid(error); }
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid();
  return value;
}

function operationKind(value) {
  if (typeof value !== 'string' || !OPERATION_KIND.test(value)) throw invalid();
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      new Date(value).toISOString() !== value) throw invalid();
  return value;
}

function redactText(value, { maximum = 512 } = {}) {
  if (typeof value !== 'string' || value.length < 1) throw invalid();
  const redacted = value
    .replace(/\b(?:https?|file):\/\/[^\s]+/giu, '[redacted]')
    .replace(/\\\\[^\s]+/gu, '[redacted]')
    .replace(/\b[A-Za-z]:[\\/][^\s]+/gu, '[redacted]')
    .replace(/\bBearer\s+[^\s]+/giu, '[redacted]')
    .replace(/\b(?:token|password|secret)\s*[=:]\s*[^\s,;]+/giu, '[redacted]')
    .replaceAll(/./gsu, character => {
      const code = character.codePointAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .trim();
  if (!redacted || redacted.length > maximum) throw invalid();
  return redacted;
}

function sanitizePublicValue(value, depth = 0) {
  if (depth > 8) throw invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw invalid();
    return value;
  }
  if (typeof value === 'string') return redactText(value, { maximum: 1024 });
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 256) throw invalid();
    return value.map(item => sanitizePublicValue(item, depth + 1));
  }
  const descriptors = strictObject(value, Object.keys(value), []);
  if (Object.keys(descriptors).length > 128) throw invalid();
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)) throw invalid();
    if (FORBIDDEN_PUBLIC_KEY.test(key)) continue;
    result[key] = sanitizePublicValue(descriptor.value, depth + 1);
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16 * 1024) throw invalid();
  return result;
}

function normalizeProgress(value) {
  if (value === null) return null;
  const descriptors = strictObject(value, ['percent', 'message', 'currentItem']);
  const percent = descriptors.percent.value;
  if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100) throw invalid();
  const currentItem = descriptors.currentItem.value;
  return {
    percent,
    message: redactText(descriptors.message.value),
    currentItem: currentItem === null ? null : redactText(currentItem, { maximum: 256 })
  };
}

function normalizeOutcome(value, terminalPhase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const sanitized = sanitizePublicValue(value);
  if (sanitized.status !== terminalPhase) throw invalid();
  if (Object.hasOwn(sanitized, 'failure')) {
    const failure = normalizeFailureDiagnostic(sanitized.failure);
    if (failure) sanitized.failure = failure;
    else delete sanitized.failure;
  }
  return sanitized;
}

function normalizeStoredEvent(value, expectedJobId = null) {
  const descriptors = strictObject(value, EVENT_KEYS);
  const sequence = descriptors.sequence.value;
  const jobId = identifier(descriptors.jobId.value);
  const channel = descriptors.channel.value;
  const phase = descriptors.phase.value;
  const progress = descriptors.progress.value;
  const currentItem = descriptors.currentItem.value;
  if (!Number.isSafeInteger(sequence) || sequence < 1 || (expectedJobId !== null && jobId !== expectedJobId) ||
      !['progress', 'log'].includes(channel) || !JOB_PHASE_SET.has(phase) ||
      (progress !== null && (!Number.isSafeInteger(progress) || progress < 0 || progress > 100)) ||
      (currentItem !== null && redactText(currentItem, { maximum: 256 }) !== currentItem)) throw invalid();
  const message = redactText(descriptors.message.value);
  const details = descriptors.details.value === null ? null : sanitizePublicValue(descriptors.details.value);
  if (message !== descriptors.message.value || JSON.stringify(details) !== JSON.stringify(descriptors.details.value)) throw invalid();
  return {
    sequence,
    jobId,
    channel,
    phase,
    timestamp: timestamp(descriptors.timestamp.value),
    message,
    progress,
    currentItem,
    details
  };
}

function normalizeNewEvent(value, { jobId, phase, sequence, timestamp: eventTimestamp }) {
  const descriptors = strictObject(value, ['channel', 'message', 'details', 'progress', 'currentItem'], ['channel', 'message']);
  const channel = descriptors.channel.value;
  if (!['progress', 'log'].includes(channel)) throw invalid();
  const progress = descriptors.progress?.value ?? null;
  if (progress !== null && (!Number.isSafeInteger(progress) || progress < 0 || progress > 100)) throw invalid();
  const currentItemValue = descriptors.currentItem?.value ?? null;
  return {
    sequence,
    jobId,
    channel,
    phase,
    timestamp: eventTimestamp,
    message: redactText(descriptors.message.value),
    progress,
    currentItem: currentItemValue === null ? null : redactText(currentItemValue, { maximum: 256 }),
    details: descriptors.details === undefined ? null : sanitizePublicValue(descriptors.details.value)
  };
}

function checksumPayload(record) {
  const keys = record.schemaVersion === 2 ? [...PUBLIC_KEYS, 'launchBinding'] : PUBLIC_KEYS;
  return Object.fromEntries(keys.map(key => [key, record[key]]));
}

function normalizeBinding(value, record, { stored = false, creating = false } = {}) {
  const descriptors = strictObject(value, BINDING_KEYS);
  const binding = Object.fromEntries(BINDING_KEYS.map(key => [key, descriptors[key].value]));
  if (!NEW_SERVER_OPERATION_KINDS.has(record.operationKind) || typeof binding.planId !== 'string' ||
      !LAUNCH_PLAN_ID.test(binding.planId) || typeof binding.planFingerprint !== 'string' ||
      !SHA256.test(binding.planFingerprint) || binding.planFingerprint !== record.planFingerprint ||
      identifier(binding.instanceId) !== record.serverId ||
      !['held', 'released', 'consumed'].includes(binding.destinationDisposition) ||
      (creating && binding.destinationDisposition !== 'held')) throw invalid();
  const targetPath = normalizeRecoveryTargetPath(binding.targetPath);
  if (typeof binding.displayName !== 'string') throw invalid();
  const displayName = binding.displayName.normalize('NFC').trim();
  if (displayName.length < 1 || displayName.length > 128 || !isSafeWindowsBasename(displayName) ||
      /\p{Cc}/u.test(displayName) ||
      (stored && (targetPath !== binding.targetPath || displayName !== binding.displayName))) throw invalid();
  const capture = binding.capturedReservation;
  // Examine descriptors before reading even the discriminant; getters are never executed.
  const captureDescriptors = strictObject(capture, ['kind', 'identity'], ['kind']);
  const kind = captureDescriptors.kind.value;
  if (kind === 'absent') {
    strictObject(capture, ['kind']);
    binding.capturedReservation = { kind };
  } else if (kind === 'empty-directory') {
    strictObject(capture, ['kind', 'identity']);
    const identityDescriptors = strictObject(captureDescriptors.identity.value, ['dev', 'ino', 'birthtimeNs']);
    const identity = {};
    for (const key of ['dev', 'ino', 'birthtimeNs']) {
      const part = identityDescriptors[key].value;
      const pattern = key === 'birthtimeNs' ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/;
      if (typeof part !== 'string' || part.length > 128 || !pattern.test(part)) throw invalid();
      identity[key] = part;
    }
    binding.capturedReservation = { kind, identity };
  } else throw invalid();
  return { ...binding, targetPath, displayName };
}

function revision(value) {
  const descriptors = strictObject(value, ['sequence', 'sha256']);
  const sequence = descriptors.sequence.value;
  const sha256 = descriptors.sha256.value;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || typeof sha256 !== 'string' || !SHA256.test(sha256)) throw invalid();
  return { sequence, sha256 };
}

function terminalUpdate(value) {
  const descriptors = strictObject(value, ['expectedPhase', 'nextPhase', 'patch']);
  const expectedPhase = descriptors.expectedPhase.value;
  const nextPhase = descriptors.nextPhase.value;
  if (!JOB_PHASE_SET.has(expectedPhase) || !['failed', 'cancelled'].includes(nextPhase)) throw invalid();
  const patchDescriptors = strictObject(descriptors.patch.value, ['progress', 'swapStep', 'outcome'], ['outcome']);
  const patch = { outcome: normalizeOutcome(patchDescriptors.outcome.value, nextPhase) };
  if (patchDescriptors.progress) patch.progress = normalizeProgress(patchDescriptors.progress.value);
  if (patchDescriptors.swapStep) {
    const value = patchDescriptors.swapStep.value;
    if (value !== null && (typeof value !== 'string' || !SWAP_STEP.test(value))) throw invalid();
    patch.swapStep = value;
  }
  return { expectedPhase, nextPhase, patch };
}

function hasTerminalUpdate(record, update) {
  return record.phase === update.nextPhase && record.terminalAt !== null &&
    Object.entries(update.patch).every(([key, value]) => isDeepStrictEqual(record[key], value));
}

function interruptedUpdate(kind) {
  return { expectedPhase: 'queued', nextPhase: 'failed', patch: {
    outcome: { status: 'failed', message: 'The operation was interrupted before execution',
      errorCode: 'COMMIT_FAILED', operationKind: kind, actions: [] },
    progress: { percent: 100, message: 'Interrupted before execution', currentItem: null }
  } };
}

function checksumFor(record) {
  return crypto.createHash('sha256').update(JSON.stringify(checksumPayload(record)), 'utf8').digest('hex');
}

function secureEqual(left, right) {
  if (typeof left !== 'string' || !SHA256.test(left) || typeof right !== 'string' || !SHA256.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function normalizeRecord(value) {
  const versionDescriptor = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  const storageVersion = versionDescriptor?.value;
  const descriptors = strictObject(value, storageVersion === 2 ? [...RECORD_KEYS, 'launchBinding'] : RECORD_KEYS);
  const sequence = descriptors.sequence.value;
  const phase = descriptors.phase.value;
  const swapStep = descriptors.swapStep.value;
  const planFingerprint = descriptors.planFingerprint.value;
  const cancellationRequested = descriptors.cancellationRequested.value;
  const terminalAt = descriptors.terminalAt.value;
  const rawEvents = descriptors.events.value;
  if (descriptors.type.value !== JOB_TYPE || ![1, 2].includes(storageVersion) ||
      !Number.isSafeInteger(sequence) || sequence < 0 || !JOB_PHASE_SET.has(phase) ||
      (swapStep !== null && (typeof swapStep !== 'string' || !SWAP_STEP.test(swapStep))) ||
      (planFingerprint !== null && (typeof planFingerprint !== 'string' || !SHA256.test(planFingerprint))) ||
      typeof cancellationRequested !== 'boolean' || (terminalAt !== null && typeof terminalAt !== 'string') ||
      !Array.isArray(rawEvents) || Object.getPrototypeOf(rawEvents) !== Array.prototype || rawEvents.length > MAX_EVENTS) throw invalid();
  const jobId = identifier(descriptors.jobId.value);
  const outcome = descriptors.outcome.value === null ? null : normalizeOutcome(descriptors.outcome.value, phase);
  const isTerminal = TERMINAL_PHASES.has(phase);
  if (isTerminal !== (terminalAt !== null) || isTerminal !== (outcome !== null)) throw invalid();
  const events = rawEvents.map(event => normalizeStoredEvent(event, jobId));
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].sequence >= events[index].sequence) throw invalid();
  }
  if (events.some(event => event.sequence > sequence)) throw invalid();
  const record = {
    type: JOB_TYPE,
    schemaVersion: storageVersion,
    sequence,
    jobId,
    operationKind: operationKind(descriptors.operationKind.value),
    serverId: identifier(descriptors.serverId.value),
    planFingerprint,
    phase,
    swapStep,
    progress: normalizeProgress(descriptors.progress.value),
    cancellationRequested,
    createdAt: timestamp(descriptors.createdAt.value),
    updatedAt: timestamp(descriptors.updatedAt.value),
    terminalAt: terminalAt === null ? null : timestamp(terminalAt),
    outcome,
    events,
    checksum: descriptors.checksum.value
  };
  if (storageVersion === 2) record.launchBinding = normalizeBinding(descriptors.launchBinding.value, record, { stored: true });
  if (!secureEqual(record.checksum, checksumFor(record))) throw recoveryRequired();
  return record;
}

function isLegalJobTransition(from, to, { operationKind: kind = 'install-existing' } = {}) {
  if (!JOB_PHASE_SET.has(from) || !JOB_PHASE_SET.has(to) || typeof kind !== 'string') return false;
  if ((MUTATION_TRANSITIONS[from] || []).includes(to)) return true;
  if (from === 'rolling-back' && to === 'failed' && NEW_SERVER_OPERATION_KINDS.has(kind)) return true;
  return kind === 'verify' && ((from === 'queued' && to === 'verifying') || (from === 'verifying' && to === 'completed'));
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function directoryIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs) };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtime === right.birthtime;
}

function dto(record) {
  const result = clone(Object.fromEntries(PUBLIC_KEYS.map(key => [key, key === 'schemaVersion' ? 1 : record[key]])));
  return deepFreeze(result);
}

// Public reads share the durable job contract without accepting a checksum as
// renderer authority. This does not authenticate bytes; OperationStore.get does.
function validatePublicJob(value) {
  const descriptors = strictObject(value, PUBLIC_KEYS);
  if (descriptors.schemaVersion.value !== 1) throw invalid();
  return dto(normalizeRecord({ ...value, checksum: checksumFor(value) }));
}

class OperationStore {
  constructor({ userDataPath, fsApi = fs, durableFs, clock = () => new Date(), randomUUID = crypto.randomUUID,
    eventSink = () => {}, allowNewServerLaunchBindings = false, launchOwner = null } = {}) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || !fsApi || typeof fsApi !== 'object' ||
        !durableFs || typeof durableFs.readFileBounded !== 'function' || typeof durableFs.writeJsonAtomic !== 'function' ||
        typeof durableFs.writeJsonAtomicAsync !== 'function' ||
        typeof durableFs.flushDirectory !== 'function' || typeof clock !== 'function' || typeof randomUUID !== 'function' ||
        typeof eventSink !== 'function' || typeof allowNewServerLaunchBindings !== 'boolean' ||
        (launchOwner !== null && (typeof launchOwner !== 'object' || typeof launchOwner.assertCurrent !== 'function' ||
          launchOwner.epoch === null || launchOwner.epoch === undefined))) throw invalid();
    this.userDataPath = path.resolve(userDataPath);
    if (this.userDataPath === path.parse(this.userDataPath).root) throw invalid();
    let userDataStat;
    try {
      userDataStat = fsApi.lstatSync(this.userDataPath, { bigint: true });
      if (!userDataStat.isDirectory() || userDataStat.isSymbolicLink() ||
          !samePath(fsApi.realpathSync.native(this.userDataPath), this.userDataPath)) throw invalid();
    } catch (error) {
      throw invalid(error);
    }
    this.fs = fsApi;
    this.durableFs = durableFs;
    this.clock = clock;
    this.randomUUID = randomUUID;
    this.eventSink = eventSink;
    this.rootPath = path.join(this.userDataPath, 'modpack-lifecycle');
    this.operationsPath = path.join(this.rootPath, 'operations');
    this.pins = { userData: directoryIdentity(userDataStat), root: null, operations: null };
    this.pendingDirectoryFlushes = createDeferredDirectoryFlushes(directory => this.durableFs.flushDirectory(directory));
    this.activePublications = new Map();
    this.publicationGeneration = 0;
    this.allowNewServerLaunchBindings = allowNewServerLaunchBindings;
    this.launchOwner = launchOwner;
    this.initialized = false;
  }

  async initialize() {
    if (!this.initialized) this.#initializeDirectories();
    this.#revalidateDirectories();
    const records = new Map();
    for (const entry of this.fs.readdirSync(this.operationsPath, { withFileTypes: true })) {
      // A crashed writer's staged copy of a job record never published anything.
      if (isDurableTempLeftover(entry, JOB_RECORD_NAME)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw recoveryRequired();
      const match = JOB_RECORD_NAME.exec(entry.name);
      if (!match) throw recoveryRequired();
      const loaded = this.#read(match[1], { allowMissing: false });
      if (loaded.record.jobId !== match[1]) throw recoveryRequired();
      records.set(match[1], loaded.record);
    }
    this.records = records;
    return deepFreeze([...records.values()].map(dto));
  }

  async create(request, ownerEpoch = null, { onPublicationAttempt = null } = {}) {
    this.#assertInitialized();
    if (onPublicationAttempt !== null && typeof onPublicationAttempt !== 'function') throw invalid();
    const descriptors = strictObject(request, ['jobId', 'operationKind', 'serverId', 'planFingerprint', 'launchBinding'], ['operationKind', 'serverId']);
    const jobId = descriptors.jobId === undefined ? this.#newJobId() : identifier(descriptors.jobId.value);
    const filePath = this.#recordPath(jobId);
    if (this.#entryExists(filePath) || this.records.has(jobId)) throw targetExists();
    const now = this.#now();
    const planFingerprint = descriptors.planFingerprint?.value ?? null;
    if (planFingerprint !== null && (typeof planFingerprint !== 'string' || !SHA256.test(planFingerprint))) throw invalid();
    const record = {
      type: JOB_TYPE,
      schemaVersion: JOB_SCHEMA_VERSION,
      sequence: 0,
      jobId,
      operationKind: operationKind(descriptors.operationKind.value),
      serverId: identifier(descriptors.serverId.value),
      planFingerprint,
      phase: 'queued',
      swapStep: null,
      progress: null,
      cancellationRequested: false,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
      outcome: null,
      events: [],
      checksum: ''
    };
    if (descriptors.launchBinding !== undefined) {
      if (!this.allowNewServerLaunchBindings) throw invalid();
      this.#assertLaunchOwner(ownerEpoch);
      record.schemaVersion = 2;
      record.launchBinding = normalizeBinding(descriptors.launchBinding.value, record, { creating: true });
      const catalogue = this.#scanLaunchCatalogue(ownerEpoch);
      if (catalogue.some(loaded => loaded.record.launchBinding &&
          (loaded.record.launchBinding.planId === record.launchBinding.planId ||
           loaded.record.launchBinding.instanceId === record.launchBinding.instanceId))) throw targetExists();
    }
    record.checksum = checksumFor(record);
    this.#revalidateDirectories();
    if (record.schemaVersion === 2) this.#assertLaunchOwner(ownerEpoch);
    this.pendingDirectoryFlushes.flushPending(commitFailure);
    // All rejection preconditions precede this local attempt witness. It is not
    // proof of durable publication; only an exact subsequent reread can be that.
    const finishPublication = this.#beginPublication(jobId);
    try {
      try {
        if (record.schemaVersion === 2 && onPublicationAttempt) onPublicationAttempt(deepFreeze({
          job: dto(record), binding: clone(record.launchBinding), expectedTargetSha256: null
        }));
        if (record.schemaVersion === 2) this.#assertLaunchOwner(ownerEpoch);
        await this.durableFs.writeJsonAtomicAsync(filePath, record, { expectedTargetSha256: null });
        this.#revalidateDirectories();
        if (record.schemaVersion === 2) this.#assertLaunchOwner(ownerEpoch, { allowClosing: true });
      } catch (error) {
        if (record.schemaVersion === 2) this.#assertLaunchOwner(ownerEpoch, { allowClosing: true });
        if (error?.code === 'PLAN_STALE') throw stale(error);
        throw commitFailure(error);
      }
      this.records.set(jobId, record);
      return dto(record);
    } finally {
      finishPublication();
    }
  }

  async get(jobId) {
    this.#assertInitialized();
    identifier(jobId);
    let loaded;
    while (true) {
      await this.#waitForActivePublications(jobId);
      try {
        loaded = this.#read(jobId, { allowMissing: true });
        break;
      } catch (error) {
        // A native atomic replacement can complete while the guarded reader
        // still holds the prior file identity. Retry only when this exact
        // store has an authenticated publication in flight; unrelated read
        // failures continue to fail closed as recovery-required.
        if (!this.activePublications.has(jobId)) throw error;
      }
    }
    if (!loaded) {
      this.records.delete(jobId);
      return null;
    }
    this.records.set(jobId, loaded.record);
    return dto(loaded.record);
  }

  async load(jobId) {
    return this.get(jobId);
  }

  #assertLaunchOwner(ownerEpoch, options = {}) {
    if (!this.launchOwner || ownerEpoch === null || ownerEpoch === undefined || ownerEpoch !== this.launchOwner.epoch) throw stale();
    try { this.launchOwner.assertCurrent(ownerEpoch, options); }
    catch (error) { throw stale(error); }
  }

  async getNewServerLaunch(jobId, ownerEpoch) {
    this.#assertInitialized();
    identifier(jobId);
    this.#assertLaunchOwner(ownerEpoch, { allowClosing: true });
    let loaded;
    while (true) {
      await this.#waitForActivePublications(jobId);
      this.#assertLaunchOwner(ownerEpoch, { allowClosing: true });
      try {
        loaded = this.#read(jobId, { allowMissing: true });
        break;
      } catch (error) {
        this.#assertLaunchOwner(ownerEpoch, { allowClosing: true });
        if (!this.activePublications.has(jobId)) throw error;
      }
    }
    this.#assertLaunchOwner(ownerEpoch, { allowClosing: true });
    if (!loaded) return null;
    if (loaded.record.schemaVersion !== 2) throw recoveryRequired();
    return this.#launchRecord(loaded);
  }

  #launchRecord(loaded) {
    return deepFreeze({ job: dto(loaded.record), binding: clone(loaded.record.launchBinding),
      recordRevision: { sequence: loaded.record.sequence, sha256: loaded.sha256 } });
  }

  getLaunchPublicationState(ownerEpoch) {
    this.#assertInitialized();
    this.#assertLaunchOwner(ownerEpoch, { allowClosing: true });
    return Object.freeze({ generation: this.publicationGeneration, pending: this.activePublications.size !== 0 });
  }

  #assertStableCatalogue(generation, ownerEpoch) {
    this.#assertLaunchOwner(ownerEpoch);
    if (this.activePublications.size !== 0 || generation !== this.publicationGeneration) throw stale();
  }

  #scanLaunchCatalogue(ownerEpoch) {
    this.#assertInitialized();
    const generation = this.publicationGeneration;
    this.#assertStableCatalogue(generation, ownerEpoch);
    const catalogue = [];
    const plans = new Set();
    const instances = new Set();
    try {
      for (const entry of this.fs.readdirSync(this.operationsPath, { withFileTypes: true })) {
        if (isDurableTempLeftover(entry, JOB_RECORD_NAME)) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw recoveryRequired();
        const match = JOB_RECORD_NAME.exec(entry.name);
        if (!match) throw recoveryRequired();
        const loaded = this.#read(match[1], { allowMissing: false });
        const binding = loaded.record.launchBinding;
        if (binding) {
          if (plans.has(binding.planId) || instances.has(binding.instanceId)) throw recoveryRequired();
          plans.add(binding.planId);
          instances.add(binding.instanceId);
        }
        catalogue.push(loaded);
      }
      this.#revalidateDirectories();
    } catch (error) {
      throw recoveryRequired(error);
    } finally {
      // A scan cannot certify even a negative result across a publication or
      // owner change. This also takes precedence over a racing temporary file.
      this.#assertStableCatalogue(generation, ownerEpoch);
    }
    return catalogue;
  }

  async findNewServerLaunch(request, ownerEpoch) {
    const descriptors = strictObject(request, ['planId', 'planFingerprint']);
    const planId = descriptors.planId.value;
    const planFingerprint = descriptors.planFingerprint.value;
    if (typeof planId !== 'string' || !LAUNCH_PLAN_ID.test(planId) || typeof planFingerprint !== 'string' || !SHA256.test(planFingerprint)) throw invalid();
    const catalogue = this.#scanLaunchCatalogue(ownerEpoch);
    const found = catalogue.find(loaded => loaded.record.launchBinding?.planId === planId);
    if (!found) return null;
    if (found.record.launchBinding.planFingerprint !== planFingerprint) throw invalid();
    return this.#launchRecord(found);
  }

  async listNewServerLaunchBindings(ownerEpoch) {
    return deepFreeze(this.#scanLaunchCatalogue(ownerEpoch).filter(loaded => loaded.record.schemaVersion === 2)
      .map(loaded => this.#launchRecord(loaded)));
  }

  #checkRevision(loaded, expected) {
    if (loaded.record.sequence !== expected.sequence || !secureEqual(loaded.sha256, expected.sha256)) throw stale();
  }

  async settleNewServerDestination(jobId, request, ownerEpoch) {
    this.#assertInitialized();
    identifier(jobId);
    const descriptors = strictObject(request, ['expectedInstanceId', 'expectedRecordRevision', 'nextDisposition', 'terminalUpdate'],
      ['expectedInstanceId', 'expectedRecordRevision', 'nextDisposition']);
    const expectedInstanceId = identifier(descriptors.expectedInstanceId.value);
    const expectedRevision = revision(descriptors.expectedRecordRevision.value);
    const nextDisposition = descriptors.nextDisposition.value;
    if (!['released', 'consumed'].includes(nextDisposition)) throw invalid();
    const update = descriptors.terminalUpdate ? terminalUpdate(descriptors.terminalUpdate.value) : null;
    if (update && nextDisposition !== 'released') throw invalid();
    const assertOwner = () => this.#assertLaunchOwner(ownerEpoch, { allowClosing: true });
    assertOwner();
    const loaded = this.#read(jobId, { allowMissing: false });
    assertOwner();
    const record = loaded.record;
    if (record.schemaVersion !== 2) throw recoveryRequired();
    if (record.serverId !== expectedInstanceId || record.launchBinding.instanceId !== expectedInstanceId) throw stale();
    if (record.launchBinding.destinationDisposition === nextDisposition) {
      if (update && !hasTerminalUpdate(record, update)) throw recoveryRequired();
      return dto(record);
    }
    if (record.launchBinding.destinationDisposition !== 'held') throw recoveryRequired();
    this.#checkRevision(loaded, expectedRevision);
    if (update && (record.phase !== update.expectedPhase || TERMINAL_PHASES.has(record.phase) ||
        !isLegalJobTransition(record.phase, update.nextPhase, { operationKind: record.operationKind }))) throw stale();
    const now = this.#now();
    const candidate = { ...record, sequence: record.sequence + 1, updatedAt: now,
      launchBinding: { ...record.launchBinding, destinationDisposition: nextDisposition } };
    if (update) Object.assign(candidate, update.patch, { phase: update.nextPhase, terminalAt: now });
    return this.#write(jobId, loaded.sha256, candidate, assertOwner);
  }

  async closeInterruptedQueued(jobId, request, ownerEpoch) {
    this.#assertInitialized();
    identifier(jobId);
    const descriptors = strictObject(request, ['expectedInstanceId', 'expectedRecordRevision']);
    const expectedInstanceId = identifier(descriptors.expectedInstanceId.value);
    const expectedRevision = revision(descriptors.expectedRecordRevision.value);
    const assertOwner = () => this.#assertLaunchOwner(ownerEpoch, { startupOnly: true });
    assertOwner();
    const loaded = this.#read(jobId, { allowMissing: false });
    assertOwner();
    const record = loaded.record;
    if (!NEW_SERVER_OPERATION_KINDS.has(record.operationKind) || record.serverId !== expectedInstanceId) throw stale();
    const update = interruptedUpdate(record.operationKind);
    if (hasTerminalUpdate(record, update) && !record.cancellationRequested &&
        (record.schemaVersion === 1 || record.launchBinding.destinationDisposition === 'released')) return dto(record);
    if (record.phase !== 'queued' || record.cancellationRequested) throw stale();
    this.#checkRevision(loaded, expectedRevision);
    if (record.schemaVersion === 2 && record.launchBinding.destinationDisposition !== 'held') throw recoveryRequired();
    const now = this.#now();
    const candidate = { ...record, ...update.patch, phase: 'failed', terminalAt: now, updatedAt: now, sequence: record.sequence + 1 };
    if (record.schemaVersion === 2) candidate.launchBinding = { ...record.launchBinding, destinationDisposition: 'released' };
    return this.#write(jobId, loaded.sha256, candidate, assertOwner);
  }

  async transition(jobId, request) {
    this.#assertInitialized();
    identifier(jobId);
    const descriptors = strictObject(request, ['expectedPhase', 'nextPhase', 'patch']);
    const expectedPhase = descriptors.expectedPhase.value;
    const nextPhase = descriptors.nextPhase.value;
    if (!JOB_PHASE_SET.has(expectedPhase) || !JOB_PHASE_SET.has(nextPhase)) throw invalid();
    const patchDescriptors = strictObject(descriptors.patch.value, ['progress', 'swapStep', 'outcome'], []);
    const loaded = this.#read(jobId, { allowMissing: false });
    if (loaded.record.phase !== expectedPhase || TERMINAL_PHASES.has(loaded.record.phase) ||
        !isLegalJobTransition(expectedPhase, nextPhase, { operationKind: loaded.record.operationKind })) throw stale();
    const terminal = TERMINAL_PHASES.has(nextPhase);
    const hasOutcome = patchDescriptors.outcome !== undefined;
    if (terminal !== hasOutcome) throw invalid();
    const now = this.#now();
    const candidate = {
      ...loaded.record,
      sequence: loaded.record.sequence + 1,
      phase: nextPhase,
      updatedAt: now,
      terminalAt: terminal ? now : null,
      outcome: terminal ? normalizeOutcome(patchDescriptors.outcome.value, nextPhase) : null
    };
    if (patchDescriptors.progress !== undefined) candidate.progress = normalizeProgress(patchDescriptors.progress.value);
    if (patchDescriptors.swapStep !== undefined) {
      const value = patchDescriptors.swapStep.value;
      if (value !== null && (typeof value !== 'string' || !SWAP_STEP.test(value))) throw invalid();
      candidate.swapStep = value;
    }
    return this.#write(jobId, loaded.sha256, candidate);
  }

  async reconcileRecovery(jobId, request) {
    this.#assertInitialized();
    identifier(jobId);
    const descriptors = strictObject(request, ['nextPhase', 'patch']);
    const nextPhase = descriptors.nextPhase.value;
    if (!['completed', 'failed', 'rolled-back'].includes(nextPhase)) throw invalid();
    const patchDescriptors = strictObject(descriptors.patch.value, ['progress', 'outcome']);
    const progress = normalizeProgress(patchDescriptors.progress.value);
    if (progress === null) throw invalid();
    const loaded = this.#read(jobId, { allowMissing: false });
    if (loaded.record.phase !== 'recovery-required') throw stale();
    const now = this.#now();
    const candidate = {
      ...loaded.record,
      sequence: loaded.record.sequence + 1,
      phase: nextPhase,
      progress,
      updatedAt: now,
      terminalAt: now,
      outcome: normalizeOutcome(patchDescriptors.outcome.value, nextPhase)
    };
    return this.#write(jobId, loaded.sha256, candidate);
  }

  async updateProgress(jobId, request) {
    this.#assertInitialized();
    identifier(jobId);
    const descriptors = strictObject(request, ['expectedPhase', 'progress']);
    const expectedPhase = descriptors.expectedPhase.value;
    if (!JOB_PHASE_SET.has(expectedPhase)) throw invalid();
    const progress = normalizeProgress(descriptors.progress.value);
    if (progress === null) throw invalid();
    const loaded = this.#read(jobId, { allowMissing: false });
    if (loaded.record.phase !== expectedPhase || TERMINAL_PHASES.has(loaded.record.phase) ||
        (loaded.record.progress !== null && progress.percent < loaded.record.progress.percent)) throw stale();
    const candidate = {
      ...loaded.record,
      sequence: loaded.record.sequence + 1,
      progress,
      updatedAt: this.#now()
    };
    return this.#write(jobId, loaded.sha256, candidate);
  }

  async requestCancellation(jobId) {
    this.#assertInitialized();
    identifier(jobId);
    const loaded = this.#read(jobId, { allowMissing: false });
    if (loaded.record.phase === 'cancelling' && loaded.record.cancellationRequested) return dto(loaded.record);
    if (!CANCELLABLE_PHASES.has(loaded.record.phase) ||
        !isLegalJobTransition(loaded.record.phase, 'cancelling', { operationKind: loaded.record.operationKind })) throw stale();
    const candidate = {
      ...loaded.record,
      sequence: loaded.record.sequence + 1,
      phase: 'cancelling',
      cancellationRequested: true,
      updatedAt: this.#now()
    };
    return this.#write(jobId, loaded.sha256, candidate);
  }

  async appendEvent(jobId, event) {
    this.#assertInitialized();
    identifier(jobId);
    const loaded = this.#read(jobId, { allowMissing: false });
    if (TERMINAL_PHASES.has(loaded.record.phase)) throw stale();
    const now = this.#now();
    const sequence = loaded.record.sequence + 1;
    const safeEvent = normalizeNewEvent(event, {
      jobId,
      phase: loaded.record.phase,
      sequence,
      timestamp: now
    });
    const candidate = {
      ...loaded.record,
      sequence,
      updatedAt: now,
      events: [...loaded.record.events.slice(-(MAX_EVENTS - 1)), safeEvent]
    };
    const written = await this.#write(jobId, loaded.sha256, candidate);
    try { this.eventSink(deepFreeze(clone(safeEvent))); } catch { /* job durability is authoritative */ }
    return written;
  }

  async #write(jobId, expectedSha256, candidateValue, assertOwner = null) {
    const candidate = { ...candidateValue, checksum: '' };
    candidate.checksum = checksumFor(candidate);
    let normalized;
    try { normalized = normalizeRecord(candidate); }
    catch (error) { throw error instanceof ModpackError ? error : invalid(error); }
    const finishPublication = this.#beginPublication(jobId);
    try {
      try {
        if (assertOwner) assertOwner();
        this.#revalidateDirectories();
        if (assertOwner) assertOwner();
        this.pendingDirectoryFlushes.flushPending(commitFailure);
        await this.durableFs.writeJsonAtomicAsync(this.#recordPath(jobId), normalized, { expectedTargetSha256: expectedSha256 });
        this.#revalidateDirectories();
        if (assertOwner) assertOwner();
      } catch (error) {
        if (assertOwner) {
          assertOwner();
          if (error?.code === 'PLAN_STALE') throw stale(error);
        }
        throw commitFailure(error);
      }
      this.records.set(jobId, normalized);
      return dto(normalized);
    } finally {
      finishPublication();
    }
  }

  #beginPublication(jobId) {
    this.publicationGeneration += 1;
    let resolvePublication;
    const publication = new Promise(resolve => { resolvePublication = resolve; });
    let active = this.activePublications.get(jobId);
    if (!active) {
      active = new Set();
      this.activePublications.set(jobId, active);
    }
    active.add(publication);
    return () => {
      this.publicationGeneration += 1;
      active.delete(publication);
      if (active.size === 0 && this.activePublications.get(jobId) === active) {
        this.activePublications.delete(jobId);
      }
      resolvePublication();
    };
  }

  async #waitForActivePublications(jobId) {
    while (true) {
      const active = this.activePublications.get(jobId);
      if (!active || active.size === 0) return;
      await Promise.all([...active]);
    }
  }

  #read(jobId, { allowMissing }) {
    const filePath = this.#recordPath(jobId);
    try {
      this.#revalidateDirectories();
      const bytes = this.durableFs.readFileBounded(filePath, { allowMissing, maxBytes: MAX_JOB_BYTES });
      this.#revalidateDirectories();
      if (bytes === null) return null;
      const record = normalizeRecord(JSON.parse(bytes.toString('utf8')));
      if (record.jobId !== jobId) throw recoveryRequired();
      return { record, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return null;
      if (error instanceof ModpackError && error.code === 'RECOVERY_REQUIRED') throw error;
      throw recoveryRequired(error);
    }
  }

  #newJobId() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const value = this.randomUUID();
      if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,96}$/.test(value)) throw invalid();
      const jobId = compactOperationIdFromRandomSource(value);
      if (!this.records.has(jobId) && !this.#entryExists(this.#recordPath(jobId))) return jobId;
    }
    throw targetExists();
  }

  #recordPath(jobId) {
    return path.join(this.operationsPath, `${identifier(jobId)}.json`);
  }

  #now() {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalid();
    return value.toISOString();
  }

  #entryExists(candidate) {
    try { this.fs.lstatSync(candidate, { bigint: true }); return true; }
    catch (error) { if (error?.code === 'ENOENT') return false; throw recoveryRequired(error); }
  }

  #ensureDirectory(parent, candidate, pinName) {
    if (!this.#entryExists(candidate)) {
      try {
        this.fs.mkdirSync(candidate, { recursive: false, mode: 0o700 });
      } catch (error) {
        throw commitFailure(error);
      }
      // A flush that cannot run now (for example without ArchiveWorker.exe) is
      // settled before the first job record is written.
      this.pendingDirectoryFlushes.created(parent);
    }
    let stat;
    try {
      stat = this.fs.lstatSync(candidate, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(this.fs.realpathSync.native(candidate), candidate)) {
        throw recoveryRequired();
      }
    } catch (error) {
      throw recoveryRequired(error);
    }
    this.pins[pinName] = directoryIdentity(stat);
  }

  #initializeDirectories() {
    this.#ensureDirectory(this.userDataPath, this.rootPath, 'root');
    this.#ensureDirectory(this.rootPath, this.operationsPath, 'operations');
    this.initialized = true;
    this.records = new Map();
  }

  #revalidateDirectories() {
    const entries = [
      ['userData', this.userDataPath],
      ['root', this.rootPath],
      ['operations', this.operationsPath]
    ];
    try {
      for (const [name, directory] of entries) {
        const stat = this.fs.lstatSync(directory, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(this.fs.realpathSync.native(directory), directory) ||
            !this.pins[name] || !sameIdentity(this.pins[name], directoryIdentity(stat))) throw recoveryRequired();
      }
    } catch (error) {
      throw recoveryRequired(error);
    }
  }

  #assertInitialized() {
    if (!this.initialized) throw invalid();
    this.#revalidateDirectories();
  }
}

module.exports = {
  JOB_PHASES,
  JOB_SCHEMA_VERSION,
  JOB_TYPE,
  OperationStore,
  TERMINAL_PHASES: Object.freeze([...TERMINAL_PHASES]),
  isLegalJobTransition,
  validatePublicJob
};
