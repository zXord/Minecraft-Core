const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { strictJsonClone } = require('../../../utils/durable-fs.cjs');
const { normalizeRecoveryTargetPath } = require('../../modpack-lifecycle/recovery-target-envelope.cjs');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { captureReservedTarget } = require('../../modpack-lifecycle/reserved-target-authority.cjs');

const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The server destination reservation is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reserved server destination is no longer available', { cause });
}

function nowMilliseconds(clock) {
  const value = clock();
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(result) || result < 0) throw invalid();
  return result;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32'
    ? resolved.toLocaleLowerCase('en-US')
    : resolved;
}

function displayNameFor(targetPath) {
  const name = path.basename(targetPath).normalize('NFC').trim();
  if (!name || name.length > 128 || [...name].some(character => {
    const point = character.codePointAt(0);
    return point <= 0x1f || point === 0x7f;
  })) throw invalid();
  return name;
}

class ServerDestinationReservationService {
  constructor({
    dialog,
    reparseInspector,
    randomUUID,
    clock = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    captureReservation = captureReservedTarget,
    isInstanceIdAvailable = () => true,
    assertAdmission = () => {}
  } = {}) {
    if (!dialog || typeof dialog.showOpenDialog !== 'function' ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        typeof randomUUID !== 'function' || typeof clock !== 'function' ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || typeof captureReservation !== 'function' ||
        typeof isInstanceIdAvailable !== 'function' || typeof assertAdmission !== 'function') throw invalid();
    this.dialog = dialog;
    this.reparseInspector = reparseInspector;
    this.randomUUID = randomUUID;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.captureReservation = captureReservation;
    this.isInstanceIdAvailable = isInstanceIdAvailable;
    this.assertAdmission = assertAdmission;
    this.records = new Map();
    this.issuedIds = new Set();
    this.jobHolds = new Map();
    this.admissionHolds = new Map();
    this.beforeUnlaunchedRelease = null;
    this.pendingByPath = new Map();
  }

  async reserveWithNativeDialog(request = {}) {
    this.assertAdmission();
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.getPrototypeOf(request) !== Object.prototype || Object.keys(request).length !== 0) throw invalid();
    await this.sweepExpired();
    this.assertAdmission();
    let selected;
    try {
      selected = await this.dialog.showOpenDialog({
        title: 'Choose an empty folder for the modpack server',
        properties: ['openDirectory', 'createDirectory']
      });
    } catch (error) {
      throw invalid(error);
    }
    if (!selected || typeof selected !== 'object' || typeof selected.canceled !== 'boolean' ||
        !Array.isArray(selected.filePaths)) throw invalid();
    if (selected.canceled) return null;
    if (selected.filePaths.length !== 1 || typeof selected.filePaths[0] !== 'string' ||
        !path.isAbsolute(selected.filePaths[0])) throw invalid();
    const targetPath = path.resolve(selected.filePaths[0]);
    if (targetPath === path.parse(targetPath).root) {
      throw new ModpackError('TARGET_EXISTS', 'The selected server destination is already reserved');
    }
    return this.withDestinationGate(targetPath, async () => {
      this.assertAdmission();
      if ([...this.records.values()].some(record => samePath(record.targetPath, targetPath)) ||
          [...this.jobHolds.values()].some(hold => samePath(hold.binding.targetPath, targetPath))) {
        throw new ModpackError('TARGET_EXISTS', 'The selected server destination is already reserved');
      }
      const reservation = await this.captureReservation({
        targetPath,
        reparseInspector: this.reparseInspector
      });
      this.assertAdmission();
      const instanceId = this.#newInstanceId();
      const createdAt = nowMilliseconds(this.clock);
      const record = deepFreeze({
        instanceId,
        displayName: displayNameFor(targetPath),
        targetPath,
        reservation,
        createdAt,
        expiresAt: createdAt + this.ttlMs
      });
      this.records.set(instanceId, record);
      this.issuedIds.add(instanceId);
      return deepFreeze({ instanceId: record.instanceId, displayName: record.displayName });
    });
  }

  resolve(instanceId) {
    if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) throw invalid();
    const record = this.records.get(instanceId);
    if (!record) return null;
    if (!this.isDestinationHeld(instanceId) && nowMilliseconds(this.clock) >= record.expiresAt) {
      throw stale();
    }
    return record;
  }

  consume(instanceId, targetPath) {
    if (this.isDestinationHeld(instanceId)) return false;
    const record = this.resolve(instanceId);
    if (!record || !samePath(record.targetPath, targetPath)) throw stale();
    this.records.delete(instanceId);
    return true;
  }

  release(instanceId) {
    if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) return false;
    const record = this.records.get(instanceId);
    if (!record) return false;
    if (this.isDestinationHeld(instanceId)) return false;
    this.#releaseRecord(record);
    return true;
  }

  async sweepExpired(now = nowMilliseconds(this.clock)) {
    if (!Number.isSafeInteger(now) || now < 0) throw invalid();
    let removed = 0;
    for (const [instanceId, record] of this.records) {
      if (now < record.expiresAt || this.isDestinationHeld(instanceId)) continue;
      if (await this.withDestinationGate(record.targetPath, () => this.releaseUnlaunched(instanceId, record))) removed += 1;
    }
    return removed;
  }

  #releaseRecord(record) {
    this.records.delete(record.instanceId);
  }

  peek(instanceId) { return this.records.get(instanceId) ?? null; }

  retainInstanceId(instanceId) {
    if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) throw invalid();
    this.issuedIds.add(instanceId);
  }

  isDestinationHeld(instanceId) {
    return this.admissionHolds.has(instanceId) || [...this.jobHolds.values()].some(hold => hold.binding.instanceId === instanceId);
  }

  holdAdmission(instanceId, planId) {
    if (!this.resolve(instanceId) || this.isDestinationHeld(instanceId)) throw stale();
    this.admissionHolds.set(instanceId, planId);
  }

  removeAdmissionHold(instanceId, planId) {
    if (this.admissionHolds.get(instanceId) !== planId) return false;
    this.admissionHolds.delete(instanceId);
    return true;
  }

  async releaseUnlaunched(instanceId, expectedRecord = this.peek(instanceId)) {
    if (!expectedRecord || this.records.get(instanceId) !== expectedRecord || this.isDestinationHeld(instanceId)) return false;
    // Called only within withDestinationGate; fence every sibling before cleanup awaits.
    if (this.beforeUnlaunchedRelease) await this.beforeUnlaunchedRelease(instanceId);
    if (this.records.get(instanceId) !== expectedRecord || this.isDestinationHeld(instanceId)) return false;
    this.#releaseRecord(expectedRecord);
    return true;
  }

  holdJobDestination({ jobId, binding }) {
    const record = this.peek(binding?.instanceId);
    if (!record || normalizeRecoveryTargetPath(record.targetPath) !== binding.targetPath ||
        !isDeepStrictEqual(record.reservation, binding.capturedReservation) || record.displayName !== binding.displayName) throw stale();
    return this.restoreJobHold({ jobId, binding });
  }

  restoreJobHold({ jobId, binding }) {
    if (typeof jobId !== 'string' || !INSTANCE_ID.test(jobId) || !binding ||
        typeof binding.instanceId !== 'string' || !INSTANCE_ID.test(binding.instanceId) ||
        binding.destinationDisposition !== 'held' || normalizeRecoveryTargetPath(binding.targetPath) !== binding.targetPath) throw invalid();
    const retained = deepFreeze(strictJsonClone(binding));
    const prior = this.jobHolds.get(jobId);
    if (prior) {
      if (!isDeepStrictEqual(prior.binding, retained)) throw stale();
      return true;
    }
    if ([...this.jobHolds.values()].some(hold => hold.binding.instanceId === binding.instanceId ||
        samePath(hold.binding.targetPath, binding.targetPath))) throw stale();
    if ([...this.records.values()].some(record => record.instanceId !== binding.instanceId &&
        samePath(record.targetPath, binding.targetPath))) throw stale();
    const record = this.peek(binding.instanceId);
    if (record && (normalizeRecoveryTargetPath(record.targetPath) !== binding.targetPath ||
        !isDeepStrictEqual(record.reservation, binding.capturedReservation))) throw stale();
    this.jobHolds.set(jobId, Object.freeze({ jobId, binding: retained }));
    this.issuedIds.add(binding.instanceId);
    return true;
  }

  removeConfirmedJobHold({ jobId, instanceId, disposition }) {
    if (!['released', 'consumed'].includes(disposition)) throw invalid();
    const hold = this.jobHolds.get(jobId);
    if (!hold || hold.binding.instanceId !== instanceId) return false;
    this.jobHolds.delete(jobId);
    const record = this.peek(instanceId);
    if (record && normalizeRecoveryTargetPath(record.targetPath) === hold.binding.targetPath) this.records.delete(instanceId);
    return true;
  }

  async withDestinationGate(targetPath, work) {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath) || typeof work !== 'function') throw invalid();
    const key = pathKey(targetPath);
    const previous = this.pendingByPath.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.pendingByPath.set(key, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.pendingByPath.get(key) === current) this.pendingByPath.delete(key);
    }
  }

  #newInstanceId() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const token = this.randomUUID();
      const instanceId = `server-${String(token)}`;
      if (!INSTANCE_ID.test(instanceId)) throw invalid();
      if (!this.records.has(instanceId) && !this.issuedIds.has(instanceId) &&
          this.isInstanceIdAvailable(instanceId) === true) return instanceId;
    }
    throw new ModpackError('TARGET_EXISTS', 'A server destination identifier could not be reserved');
  }
}

function createCompositeInstanceResolver({ liveInstanceResolver, destinationReservations } = {}) {
  if (!liveInstanceResolver || typeof liveInstanceResolver.resolveInstance !== 'function' ||
      !destinationReservations || typeof destinationReservations.resolve !== 'function') throw invalid();
  return deepFreeze({
    async resolveInstance(instanceId) {
      const reserved = destinationReservations.resolve(instanceId);
      if (reserved) {
        return deepFreeze({ instanceId, serverPath: reserved.targetPath, priorRunning: false });
      }
      return liveInstanceResolver.resolveInstance(instanceId);
    }
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  ServerDestinationReservationService,
  createCompositeInstanceResolver
};
