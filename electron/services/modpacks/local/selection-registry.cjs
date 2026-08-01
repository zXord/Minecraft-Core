const crypto = require('node:crypto');
const { ModpackError, deepFreeze } = require('../errors.cjs');

const SAFE_SELECTION_ID = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_ID_ATTEMPTS = 16;

function staleSelection() {
  return new ModpackError('PLAN_STALE', 'The local archive selection is unavailable');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function clonePrivateValue(value) {
  if (Array.isArray(value)) return value.map(clonePrivateValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clonePrivateValue(child)]));
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || value === null) return value;
  throw new TypeError('Selection registry values must be serializable records');
}

function defaultRandomId() {
  return crypto.randomBytes(24).toString('base64url');
}

class SelectionRegistry {
  constructor({ clock = () => Date.now(), randomId = defaultRandomId } = {}) {
    if (typeof clock !== 'function' || typeof randomId !== 'function') throw new TypeError('Selection registry dependencies are invalid');
    this.clock = clock;
    this.randomId = randomId;
    this.records = new Map();
  }

  now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Selection registry clock is invalid');
    return value;
  }

  create(input) {
    if (!isPlainObject(input) || Object.keys(input).some(key => !['selectedPaths', 'displayNames', 'expiresAt'].includes(key))) {
      throw new TypeError('Selection registry input is invalid');
    }
    const { selectedPaths, displayNames, expiresAt } = input;
    if (!Array.isArray(selectedPaths) || selectedPaths.length === 0 || !Array.isArray(displayNames) || displayNames.length !== selectedPaths.length ||
      displayNames.some(name => typeof name !== 'string' || !name) || !Number.isSafeInteger(expiresAt) || expiresAt < 0 || Number.isNaN(new Date(expiresAt).getTime())) {
      throw new TypeError('Selection registry input is invalid');
    }
    const record = deepFreeze({
      selectedPaths: clonePrivateValue(selectedPaths),
      displayNames: clonePrivateValue(displayNames),
      expiresAt
    });
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const selectionId = this.randomId();
      if (typeof selectionId !== 'string' || !SAFE_SELECTION_ID.test(selectionId)) throw new TypeError('Selection identifier source is invalid');
      if (this.records.has(selectionId)) continue;
      this.records.set(selectionId, record);
      return deepFreeze({ selectionId, expiresAt: new Date(expiresAt).toISOString() });
    }
    throw new ModpackError('OPERATION_IN_PROGRESS', 'Local archive selection registration is busy');
  }

  claim(selectionId) {
    if (typeof selectionId !== 'string' || !SAFE_SELECTION_ID.test(selectionId)) throw staleSelection();
    const record = this.records.get(selectionId);
    if (!record) throw staleSelection();
    this.records.delete(selectionId);
    if (this.now() >= record.expiresAt) throw staleSelection();
    return record;
  }

  invalidate(selectionId) {
    if (typeof selectionId !== 'string' || !SAFE_SELECTION_ID.test(selectionId)) return false;
    return this.records.delete(selectionId);
  }

  sweepExpired() {
    const now = this.now();
    let removed = 0;
    for (const [selectionId, record] of this.records) {
      if (now < record.expiresAt) continue;
      this.records.delete(selectionId);
      removed += 1;
    }
    return removed;
  }
}

module.exports = { SelectionRegistry };
