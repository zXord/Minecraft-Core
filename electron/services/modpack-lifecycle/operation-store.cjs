const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { compactOperationIdFromRandomSource } = require('./operation-id.cjs');

const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeFailureDiagnostic } = require('./publication-failure-diagnostic.cjs');

const JOB_TYPE = 'minecraft-core-modpack-job';
const JOB_SCHEMA_VERSION = 1;
const MAX_JOB_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 128;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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
  return Object.fromEntries(RECORD_KEYS.filter(key => key !== 'checksum').map(key => [key, record[key]]));
}

function checksumFor(record) {
  return crypto.createHash('sha256').update(JSON.stringify(checksumPayload(record)), 'utf8').digest('hex');
}

function secureEqual(left, right) {
  if (typeof left !== 'string' || !SHA256.test(left) || typeof right !== 'string' || !SHA256.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function normalizeRecord(value) {
  const descriptors = strictObject(value, RECORD_KEYS);
  const sequence = descriptors.sequence.value;
  const phase = descriptors.phase.value;
  const swapStep = descriptors.swapStep.value;
  const planFingerprint = descriptors.planFingerprint.value;
  const cancellationRequested = descriptors.cancellationRequested.value;
  const terminalAt = descriptors.terminalAt.value;
  const rawEvents = descriptors.events.value;
  if (descriptors.type.value !== JOB_TYPE || descriptors.schemaVersion.value !== JOB_SCHEMA_VERSION ||
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
    schemaVersion: JOB_SCHEMA_VERSION,
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
  const result = clone(record);
  delete result.checksum;
  return deepFreeze(result);
}

class OperationStore {
  constructor({ userDataPath, fsApi = fs, durableFs, clock = () => new Date(), randomUUID = crypto.randomUUID, eventSink = () => {} } = {}) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || !fsApi || typeof fsApi !== 'object' ||
        !durableFs || typeof durableFs.readFileBounded !== 'function' || typeof durableFs.writeJsonAtomic !== 'function' ||
        typeof durableFs.writeJsonAtomicAsync !== 'function' ||
        typeof durableFs.flushDirectory !== 'function' || typeof clock !== 'function' || typeof randomUUID !== 'function' ||
        typeof eventSink !== 'function') throw invalid();
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
    this.activePublications = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (!this.initialized) this.#initializeDirectories();
    this.#revalidateDirectories();
    const records = new Map();
    for (const entry of this.fs.readdirSync(this.operationsPath, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw recoveryRequired();
      const match = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\.json$/.exec(entry.name);
      if (!match) throw recoveryRequired();
      const loaded = this.#read(match[1], { allowMissing: false });
      if (loaded.record.jobId !== match[1]) throw recoveryRequired();
      records.set(match[1], loaded.record);
    }
    this.records = records;
    return deepFreeze([...records.values()].map(dto));
  }

  async create(request) {
    this.#assertInitialized();
    const descriptors = strictObject(request, ['jobId', 'operationKind', 'serverId', 'planFingerprint'], ['operationKind', 'serverId']);
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
    record.checksum = checksumFor(record);
    try {
      this.#revalidateDirectories();
      await this.durableFs.writeJsonAtomicAsync(filePath, record, { expectedTargetSha256: null });
      this.#revalidateDirectories();
    } catch (error) {
      throw commitFailure(error);
    }
    this.records.set(jobId, record);
    return dto(record);
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

  async #write(jobId, expectedSha256, candidateValue) {
    const candidate = { ...candidateValue, checksum: '' };
    candidate.checksum = checksumFor(candidate);
    let normalized;
    try { normalized = normalizeRecord(candidate); }
    catch (error) { throw error instanceof ModpackError ? error : invalid(error); }
    const finishPublication = this.#beginPublication(jobId);
    try {
      try {
        this.#revalidateDirectories();
        await this.durableFs.writeJsonAtomicAsync(this.#recordPath(jobId), normalized, { expectedTargetSha256: expectedSha256 });
        this.#revalidateDirectories();
      } catch (error) {
        throw commitFailure(error);
      }
      this.records.set(jobId, normalized);
      return dto(normalized);
    } finally {
      finishPublication();
    }
  }

  #beginPublication(jobId) {
    let resolvePublication;
    const publication = new Promise(resolve => { resolvePublication = resolve; });
    let active = this.activePublications.get(jobId);
    if (!active) {
      active = new Set();
      this.activePublications.set(jobId, active);
    }
    active.add(publication);
    return () => {
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
        this.durableFs.flushDirectory(parent);
      } catch (error) {
        throw commitFailure(error);
      }
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
  isLegalJobTransition
};
