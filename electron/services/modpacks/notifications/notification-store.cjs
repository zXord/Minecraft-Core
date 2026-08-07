const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { strictJsonClone } = require('../../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');

const STORE_TYPE = 'minecraft-core-modpack-notifications';
const SCHEMA_VERSION = 1;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_NOTIFICATIONS = 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TYPES = new Set([
  'update-available', 'prerelease-available', 'github-asset-selection-required', 'source-changed',
  'integrity-warning', 'rate-limit', 'operation-outcome', 'recovery-required'
]);
const ACTIONS = new Set([
  'retry', 'change-selection', 'open-details', 'open-retained-download-folder', 'remove-retained-download',
  'choose-another-asset', 'return-to-server', 'review-restore-point', 'restart-and-recover', 'review-recovery',
  'restore-from-restore-point'
]);
const RECORD_KEYS = Object.freeze([
  'notificationId', 'type', 'serverId', 'source', 'release', 'timestamp', 'read', 'title', 'message', 'action', 'dedupeKey'
]);
const CREATE_KEYS = Object.freeze(['type', 'serverId', 'source', 'release', 'title', 'message', 'action', 'dedupeKey']);

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The notification request is invalid', { cause });
}

function recoveryRequired(cause) {
  return new ModpackError('RECOVERY_REQUIRED', 'The notification store cannot be trusted', { cause });
}

function commitFailure(cause) {
  return new ModpackError('COMMIT_FAILED', 'The notification store could not be updated', { cause });
}

function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || Object.keys(descriptors).some(key => !keys.includes(key))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return value;
}

function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid();
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      new Date(value).toISOString() !== value) throw invalid();
  return value;
}

function hasUnsafeControl(value) {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function safeText(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value !== value.normalize('NFC') ||
      hasUnsafeControl(value) || /(?:https?|file):\/\//iu.test(value) ||
      /(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\)/u.test(value) || /\b(?:token|password|secret|authorization)\b/iu.test(value)) throw invalid();
  return value;
}

function normalizeSource(value) {
  strictObject(value, ['provider', 'sourceId']);
  if (!['modrinth', 'github', 'local'].includes(value.provider)) throw invalid();
  return { provider: value.provider, sourceId: identifier(value.sourceId) };
}

function normalizeRelease(value) {
  if (value === null) return null;
  strictObject(value, ['releaseId', 'version', 'prerelease']);
  if (typeof value.prerelease !== 'boolean') throw invalid();
  return {
    releaseId: identifier(value.releaseId),
    version: safeText(value.version, 128),
    prerelease: value.prerelease
  };
}

function normalizeAction(value) {
  if (value === null) return null;
  strictObject(value, ['actionId', 'opaqueRef']);
  if (!ACTIONS.has(value.actionId)) throw invalid();
  return { actionId: value.actionId, opaqueRef: identifier(value.opaqueRef) };
}

function normalizeRecord(value) {
  strictObject(value, RECORD_KEYS);
  if (!TYPES.has(value.type) || typeof value.read !== 'boolean') throw invalid();
  return {
    notificationId: identifier(value.notificationId),
    type: value.type,
    serverId: identifier(value.serverId),
    source: normalizeSource(value.source),
    release: normalizeRelease(value.release),
    timestamp: timestamp(value.timestamp),
    read: value.read,
    title: safeText(value.title, 160),
    message: safeText(value.message, 512),
    action: normalizeAction(value.action),
    dedupeKey: identifier(value.dedupeKey)
  };
}

function checksumPayload(value) {
  return { type: value.type, schemaVersion: value.schemaVersion, sequence: value.sequence, notifications: value.notifications };
}

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(checksumPayload(value)), 'utf8').digest('hex');
}

function normalizeEnvelope(value) {
  strictObject(value, ['type', 'schemaVersion', 'sequence', 'notifications', 'checksum']);
  if (value.type !== STORE_TYPE || value.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 || !Array.isArray(value.notifications) || value.notifications.length > MAX_NOTIFICATIONS ||
      typeof value.checksum !== 'string' || !SHA256.test(value.checksum)) throw invalid();
  const notifications = value.notifications.map(normalizeRecord);
  if (new Set(notifications.map(item => item.notificationId)).size !== notifications.length ||
      new Set(notifications.map(item => item.dedupeKey)).size !== notifications.length) throw invalid();
  const normalized = {
    type: STORE_TYPE,
    schemaVersion: SCHEMA_VERSION,
    sequence: value.sequence,
    notifications,
    checksum: value.checksum
  };
  const expected = checksum(normalized);
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value.checksum, 'hex'))) throw recoveryRequired();
  return normalized;
}

function emptyEnvelope() {
  const value = { type: STORE_TYPE, schemaVersion: SCHEMA_VERSION, sequence: 0, notifications: [], checksum: '' };
  value.checksum = checksum(value);
  return value;
}

function dto(value) {
  return deepFreeze(strictJsonClone(value));
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

class NotificationStore {
  constructor({
    userDataPath, fsApi = fs, durableFs, clock = () => new Date(), randomUUID = crypto.randomUUID, eventSink = () => {}
  } = {}) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || !fsApi ||
        !durableFs || typeof durableFs.readFileBounded !== 'function' || typeof durableFs.writeJsonAtomic !== 'function' ||
        typeof durableFs.flushDirectory !== 'function' || typeof clock !== 'function' || typeof randomUUID !== 'function' ||
        typeof eventSink !== 'function') throw invalid();
    this.userDataPath = path.resolve(userDataPath);
    this.fs = fsApi;
    this.durableFs = durableFs;
    this.clock = clock;
    this.randomUUID = randomUUID;
    this.eventSink = eventSink;
    this.rootPath = path.join(this.userDataPath, 'modpack-lifecycle');
    this.filePath = path.join(this.rootPath, 'notifications.json');
    this.initialized = false;
  }

  async initialize() {
    this.#ensureRoot();
    const loaded = this.#load();
    this.state = loaded.value;
    this.sha256 = loaded.sha256;
    this.initialized = true;
    return this.list();
  }

  async list({ unreadOnly = false, limit = 200 } = {}) {
    this.#assertInitialized();
    if (typeof unreadOnly !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw invalid();
    return deepFreeze(this.state.notifications
      .filter(item => !unreadOnly || !item.read)
      .slice()
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.notificationId.localeCompare(left.notificationId))
      .slice(0, limit)
      .map(dto));
  }

  async create(request) {
    this.#assertInitialized();
    strictObject(request, CREATE_KEYS);
    const normalized = normalizeRecord({
      notificationId: identifier(String(this.randomUUID())),
      type: request.type,
      serverId: request.serverId,
      source: request.source,
      release: request.release,
      timestamp: this.#now(),
      read: false,
      title: request.title,
      message: request.message,
      action: request.action,
      dedupeKey: request.dedupeKey
    });
    const existing = this.state.notifications.find(item => item.dedupeKey === normalized.dedupeKey);
    if (existing) return dto(existing);
    if (this.state.notifications.length >= MAX_NOTIFICATIONS) throw commitFailure();
    await this.#publish([...this.state.notifications, normalized]);
    const created = dto(normalized);
    try { this.eventSink(created); } catch { /* durable notification remains authoritative */ }
    return created;
  }

  async acknowledge(notificationId) {
    this.#assertInitialized();
    identifier(notificationId);
    const index = this.state.notifications.findIndex(item => item.notificationId === notificationId);
    if (index < 0) throw invalid();
    if (this.state.notifications[index].read) return dto(this.state.notifications[index]);
    const notifications = this.state.notifications.map((item, itemIndex) => itemIndex === index ? { ...item, read: true } : item);
    await this.#publish(notifications);
    return dto(this.state.notifications[index]);
  }

  async #publish(notifications) {
    const candidate = {
      type: STORE_TYPE,
      schemaVersion: SCHEMA_VERSION,
      sequence: this.state.sequence + 1,
      notifications: notifications.map(normalizeRecord),
      checksum: ''
    };
    candidate.checksum = checksum(candidate);
    try {
      this.#revalidateRoot();
      this.durableFs.writeJsonAtomic(this.filePath, candidate, { expectedTargetSha256: this.sha256 });
      this.#revalidateRoot();
      this.state = normalizeEnvelope(candidate);
      this.sha256 = crypto.createHash('sha256').update(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8').digest('hex');
    } catch (error) {
      throw commitFailure(error);
    }
  }

  #load() {
    try {
      this.#revalidateRoot();
      const bytes = this.durableFs.readFileBounded(this.filePath, { allowMissing: true, maxBytes: MAX_BYTES });
      this.#revalidateRoot();
      if (bytes === null) return { value: emptyEnvelope(), sha256: null };
      return { value: normalizeEnvelope(JSON.parse(bytes.toString('utf8'))), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
      if (error instanceof ModpackError && error.code === 'RECOVERY_REQUIRED') throw error;
      throw recoveryRequired(error);
    }
  }

  #ensureRoot() {
    const user = this.fs.lstatSync(this.userDataPath, { bigint: true });
    if (!user.isDirectory() || user.isSymbolicLink() || !samePath(this.fs.realpathSync.native(this.userDataPath), this.userDataPath)) throw invalid();
    try { this.fs.mkdirSync(this.rootPath, { recursive: false, mode: 0o700 }); this.durableFs.flushDirectory(this.userDataPath); }
    catch (error) { if (error?.code !== 'EEXIST') throw commitFailure(error); }
    this.rootIdentity = this.#directoryIdentity(this.rootPath);
    this.#revalidateRoot();
  }

  #directoryIdentity(candidate) {
    const stat = this.fs.lstatSync(candidate, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(this.fs.realpathSync.native(candidate), candidate)) throw recoveryRequired();
    return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
  }

  #revalidateRoot() {
    const current = this.#directoryIdentity(this.rootPath);
    if (!this.rootIdentity || current.dev !== this.rootIdentity.dev || current.ino !== this.rootIdentity.ino ||
        current.birthtimeNs !== this.rootIdentity.birthtimeNs) throw recoveryRequired();
  }

  #assertInitialized() {
    if (!this.initialized) throw invalid();
    this.#revalidateRoot();
  }

  #now() {
    const value = this.clock();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw invalid();
    return value.toISOString();
  }
}

module.exports = { NotificationStore, NOTIFICATION_TYPES: Object.freeze([...TYPES]) };
