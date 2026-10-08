const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { strictJsonClone } = require('../../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { matchAssetPattern } = require('../providers/github-asset-pattern.cjs');
const { normalizeAcceptedMapping } = require('../state/modpack-state-repository.cjs');

const STORE_TYPE = 'minecraft-core-release-tracking';
const SCHEMA_VERSION = 1;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DECIMAL_ID = /^[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ETAG = /^(?:W\/)?"[A-Za-z0-9._:+/=-]{1,200}"$/;
const RECORD_KEYS = Object.freeze([
  'trackingId', 'serverId', 'provider', 'projectId', 'repositoryId', 'githubOwner', 'githubRepo',
  'includePrereleases', 'acceptedMapping', 'assetPattern', 'etag', 'lastSuccessfulCheck', 'lastFailure',
  'nextDueAt', 'lastSnapshot'
]);

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The release tracking request is invalid', { cause });
}

function recoveryRequired(cause) {
  return new ModpackError('RECOVERY_REQUIRED', 'The release tracking store cannot be trusted', { cause });
}

function commitFailure(cause) {
  return new ModpackError('COMMIT_FAILED', 'The release tracking store could not be updated', { cause });
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

function timestamp(value, nullable = false) {
  if (nullable && value === null) return null;
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

function clone(value) {
  try { return strictJsonClone(value, { maxDepth: 16, maxCollection: 4096, maxStringBytes: 256 * 1024 }); }
  catch (error) { throw invalid(error); }
}

function nullablePattern(value) {
  if (value === null) return null;
  const result = clone(value);
  try { matchAssetPattern(result, []); } catch (error) {
    if (error instanceof ModpackError && error.code === 'INVALID_REQUEST') throw invalid(error);
    throw error;
  }
  return result;
}

function nullableMapping(value) {
  if (value === null) return null;
  try { return normalizeAcceptedMapping(clone(value), 'acceptedMapping'); }
  catch (error) { throw invalid(error); }
}

function normalizeFailure(value) {
  if (value === null) return null;
  strictObject(value, ['code', 'at', 'attempt', 'retryAfterAt']);
  if (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.code) ||
      !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > 64) throw invalid();
  return {
    code: value.code,
    at: timestamp(value.at),
    attempt: value.attempt,
    retryAfterAt: timestamp(value.retryAfterAt, true)
  };
}

function normalizeSnapshot(value) {
  if (value === null) return null;
  const hasOrderingEvidence = Object.hasOwn(value, 'orderingKnown');
  strictObject(value, [
    'releaseId', 'version', 'prerelease', 'publishedAt', 'assetFingerprint', 'installable',
    ...(hasOrderingEvidence ? ['orderingKnown'] : [])
  ]);
  if (typeof value.version !== 'string' || value.version.length < 1 || value.version.length > 128 ||
      hasUnsafeControl(value.version) || typeof value.prerelease !== 'boolean' ||
      typeof value.installable !== 'boolean' ||
      (hasOrderingEvidence && typeof value.orderingKnown !== 'boolean') ||
      (value.assetFingerprint !== null && (typeof value.assetFingerprint !== 'string' || !SHA256.test(value.assetFingerprint)))) throw invalid();
  return {
    releaseId: identifier(value.releaseId),
    version: value.version,
    prerelease: value.prerelease,
    publishedAt: timestamp(value.publishedAt),
    assetFingerprint: value.assetFingerprint,
    installable: value.installable,
    ...(hasOrderingEvidence ? { orderingKnown: value.orderingKnown } : {})
  };
}

function normalizeRecord(value) {
  strictObject(value, RECORD_KEYS);
  if (!['github', 'modrinth'].includes(value.provider) || typeof value.includePrereleases !== 'boolean') throw invalid();
  const common = {
    trackingId: identifier(value.trackingId),
    serverId: identifier(value.serverId),
    provider: value.provider,
    projectId: value.projectId,
    repositoryId: value.repositoryId,
    githubOwner: value.githubOwner,
    githubRepo: value.githubRepo,
    includePrereleases: value.includePrereleases,
    acceptedMapping: nullableMapping(value.acceptedMapping),
    assetPattern: nullablePattern(value.assetPattern),
    etag: value.etag,
    lastSuccessfulCheck: timestamp(value.lastSuccessfulCheck, true),
    lastFailure: normalizeFailure(value.lastFailure),
    nextDueAt: timestamp(value.nextDueAt),
    lastSnapshot: normalizeSnapshot(value.lastSnapshot)
  };
  if (common.etag !== null && (typeof common.etag !== 'string' || !ETAG.test(common.etag))) throw invalid();
  if (value.provider === 'github') {
    if (value.projectId !== null || typeof value.repositoryId !== 'string' || !DECIMAL_ID.test(value.repositoryId) ||
        typeof value.githubOwner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.githubOwner) ||
        typeof value.githubRepo !== 'string' || !/^(?!\.)(?!.*\.git$)[A-Za-z0-9_.-]{1,100}$/i.test(value.githubRepo)) throw invalid();
  } else if (value.repositoryId !== null || value.githubOwner !== null || value.githubRepo !== null ||
      typeof value.projectId !== 'string' || !ID.test(value.projectId) || value.assetPattern !== null) throw invalid();
  return common;
}

function checksumPayload(value) {
  return { type: value.type, schemaVersion: value.schemaVersion, sequence: value.sequence, records: value.records };
}

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(checksumPayload(value)), 'utf8').digest('hex');
}

function normalizeEnvelope(value) {
  strictObject(value, ['type', 'schemaVersion', 'sequence', 'records', 'checksum']);
  if (value.type !== STORE_TYPE || value.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS ||
      typeof value.checksum !== 'string' || !SHA256.test(value.checksum)) throw invalid();
  const records = value.records.map(normalizeRecord);
  if (new Set(records.map(record => record.trackingId)).size !== records.length ||
      new Set(records.map(record => record.serverId)).size !== records.length) throw invalid();
  const result = { type: STORE_TYPE, schemaVersion: SCHEMA_VERSION, sequence: value.sequence, records, checksum: value.checksum };
  const expected = checksum(result);
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value.checksum, 'hex'))) throw recoveryRequired();
  return result;
}

function emptyEnvelope() {
  const value = { type: STORE_TYPE, schemaVersion: SCHEMA_VERSION, sequence: 0, records: [], checksum: '' };
  value.checksum = checksum(value);
  return value;
}

function dto(value) { return deepFreeze(clone(value)); }

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

class ReleaseTrackingStore {
  constructor({ userDataPath, fsApi = fs, durableFs, clock = () => new Date() } = {}) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || !fsApi || !durableFs ||
        typeof durableFs.readFileBounded !== 'function' || typeof durableFs.writeJsonAtomic !== 'function' ||
        typeof durableFs.flushDirectory !== 'function' || typeof clock !== 'function') throw invalid();
    this.userDataPath = path.resolve(userDataPath);
    this.fs = fsApi;
    this.durableFs = durableFs;
    this.clock = clock;
    this.rootPath = path.join(this.userDataPath, 'modpack-lifecycle');
    this.filePath = path.join(this.rootPath, 'release-tracking.json');
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

  async list() {
    this.#assertInitialized();
    return deepFreeze(this.state.records.slice().sort((left, right) => left.trackingId.localeCompare(right.trackingId)).map(dto));
  }

  async get(trackingId) {
    this.#assertInitialized();
    identifier(trackingId);
    const record = this.state.records.find(item => item.trackingId === trackingId);
    return record ? dto(record) : null;
  }

  async upsert(value) {
    this.#assertInitialized();
    const record = normalizeRecord(value);
    const index = this.state.records.findIndex(item => item.trackingId === record.trackingId);
    const serverConflict = this.state.records.find(item => item.serverId === record.serverId && item.trackingId !== record.trackingId);
    if (serverConflict) throw invalid();
    const records = this.state.records.slice();
    if (index < 0) {
      if (records.length >= MAX_RECORDS) throw commitFailure();
      records.push(record);
    } else {
      records[index] = record;
    }
    await this.#publish(records);
    return dto(record);
  }

  async recordSuccess(trackingId, value) {
    this.#assertInitialized();
    strictObject(value, ['checkedAt', 'etag', 'nextDueAt', 'snapshot']);
    const current = this.#required(trackingId);
    const candidate = normalizeRecord({
      ...current,
      etag: value.etag,
      lastSuccessfulCheck: value.checkedAt,
      lastFailure: null,
      nextDueAt: value.nextDueAt,
      lastSnapshot: value.snapshot === undefined ? current.lastSnapshot : value.snapshot
    });
    await this.#replace(candidate);
    return dto(candidate);
  }

  async recordFailure(trackingId, value) {
    this.#assertInitialized();
    strictObject(value, ['code', 'at', 'attempt', 'retryAfterAt', 'nextDueAt']);
    const current = this.#required(trackingId);
    const candidate = normalizeRecord({
      ...current,
      lastFailure: {
        code: value.code,
        at: value.at,
        attempt: value.attempt,
        retryAfterAt: value.retryAfterAt
      },
      nextDueAt: value.nextDueAt
    });
    await this.#replace(candidate);
    return dto(candidate);
  }

  async remove(trackingId) {
    this.#assertInitialized();
    identifier(trackingId);
    const records = this.state.records.filter(item => item.trackingId !== trackingId);
    if (records.length === this.state.records.length) return false;
    await this.#publish(records);
    return true;
  }

  #required(trackingId) {
    identifier(trackingId);
    const record = this.state.records.find(item => item.trackingId === trackingId);
    if (!record) throw invalid();
    return record;
  }

  async #replace(record) {
    await this.#publish(this.state.records.map(item => item.trackingId === record.trackingId ? record : item));
  }

  async #publish(records) {
    const candidate = {
      type: STORE_TYPE,
      schemaVersion: SCHEMA_VERSION,
      sequence: this.state.sequence + 1,
      records: records.map(normalizeRecord),
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
}

module.exports = { ReleaseTrackingStore, normalizeTrackingRecord: normalizeRecord };
