const path = require('node:path');

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
    isInstanceIdAvailable = () => true
  } = {}) {
    if (!dialog || typeof dialog.showOpenDialog !== 'function' ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        typeof randomUUID !== 'function' || typeof clock !== 'function' ||
        !Number.isSafeInteger(ttlMs) || ttlMs < 1 || typeof captureReservation !== 'function' ||
        typeof isInstanceIdAvailable !== 'function') throw invalid();
    this.dialog = dialog;
    this.reparseInspector = reparseInspector;
    this.randomUUID = randomUUID;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.captureReservation = captureReservation;
    this.isInstanceIdAvailable = isInstanceIdAvailable;
    this.records = new Map();
    this.releasedByPath = new Map();
    this.releasedIds = new Set();
    this.pendingByPath = new Map();
  }

  async reserveWithNativeDialog(request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.getPrototypeOf(request) !== Object.prototype || Object.keys(request).length !== 0) throw invalid();
    this.sweepExpired();
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
    return this.#finalizeForPath(targetPath, async () => {
      if ([...this.records.values()].some(record => samePath(record.targetPath, targetPath))) {
        throw new ModpackError('TARGET_EXISTS', 'The selected server destination is already reserved');
      }
      const reservation = await this.captureReservation({
        targetPath,
        reparseInspector: this.reparseInspector
      });
      const instanceId = this.#takeReleasedInstanceId(targetPath) || this.#newInstanceId();
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
      return deepFreeze({ instanceId: record.instanceId, displayName: record.displayName });
    });
  }

  resolve(instanceId) {
    if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) throw invalid();
    const record = this.records.get(instanceId);
    if (!record) return null;
    if (nowMilliseconds(this.clock) >= record.expiresAt) {
      this.#releaseRecord(record);
      throw stale();
    }
    return record;
  }

  consume(instanceId, targetPath) {
    const record = this.resolve(instanceId);
    if (!record || !samePath(record.targetPath, targetPath)) throw stale();
    this.records.delete(instanceId);
    this.#forgetReleasedIdentity(record);
    return true;
  }

  release(instanceId) {
    if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) return false;
    const record = this.records.get(instanceId);
    if (!record) return false;
    this.#releaseRecord(record);
    return true;
  }

  sweepExpired(now = nowMilliseconds(this.clock)) {
    if (!Number.isSafeInteger(now) || now < 0) throw invalid();
    let removed = 0;
    for (const [instanceId, record] of this.records) {
      if (now < record.expiresAt) continue;
      this.#releaseRecord(record);
      removed += 1;
    }
    return removed;
  }

  #releaseRecord(record) {
    this.records.delete(record.instanceId);
    const key = pathKey(record.targetPath);
    const previous = this.releasedByPath.get(key);
    if (previous) this.releasedIds.delete(previous);
    this.releasedByPath.set(key, record.instanceId);
    this.releasedIds.add(record.instanceId);
  }

  #forgetReleasedIdentity(record) {
    const key = pathKey(record.targetPath);
    if (this.releasedByPath.get(key) !== record.instanceId) return false;
    this.releasedByPath.delete(key);
    this.releasedIds.delete(record.instanceId);
    return true;
  }

  #takeReleasedInstanceId(targetPath) {
    const key = pathKey(targetPath);
    const instanceId = this.releasedByPath.get(key);
    if (!instanceId) return null;
    if (this.isInstanceIdAvailable(instanceId) !== true) {
      throw new ModpackError('TARGET_EXISTS', 'The reserved server destination identifier is already in use');
    }
    this.releasedByPath.delete(key);
    this.releasedIds.delete(instanceId);
    return instanceId;
  }

  async #finalizeForPath(targetPath, work) {
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
      if (!this.records.has(instanceId) && !this.releasedIds.has(instanceId) &&
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
