const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ModpackError } = require('../modpacks/errors.cjs');
const { normalizeCompanionRecord } = require('./companion-contracts.cjs');
const TYPE = 'minecraft-core-client-companions';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 1000;
const fail = (code, cause) => new ModpackError(code, code === 'CLIENT_PACK_UNAVAILABLE' ? 'The matching client pack registry is unavailable' : 'The matching client pack registry could not be updated', { cause });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const payload = value => ({ type: value.type, schemaVersion: value.schemaVersion, sequence: value.sequence, records: value.records });
function envelope(sequence, records) {
  const value = { type: TYPE, schemaVersion: 1, sequence, records };
  return { ...value, checksum: hash(JSON.stringify(value)) };
}
function normalize(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'checksum,records,schemaVersion,sequence,type' || value.type !== TYPE || value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.records) || value.records.length > MAX_RECORDS ||
      !/^[a-f0-9]{64}$/.test(value.checksum)) throw fail('CLIENT_PACK_UNAVAILABLE');
  const records = value.records.map(normalizeCompanionRecord);
  if (new Set(records.map(item => JSON.stringify([item.serverId, item.descriptor.serverFingerprint]))).size !== records.length ||
      hash(JSON.stringify(payload({ ...value, records }))) !== value.checksum) throw fail('CLIENT_PACK_UNAVAILABLE');
  return envelope(value.sequence, records);
}
class CompanionStore {
  constructor({ filePath, durableFs, fsApi = fs } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || typeof durableFs?.readFileBounded !== 'function' || typeof durableFs?.writeJsonAtomic !== 'function') throw fail('INVALID_REQUEST');
    this.filePath = path.resolve(filePath); this.root = path.dirname(this.filePath); this.durableFs = durableFs; this.fs = fsApi;
    this.initialized = false;
  }
  get sequence() { this.#assert(); return this.state.sequence; }
  async initialize() {
    this.initialized = false;
    try {
      this.rootIdentity = this.#identity();
      const loaded = this.#load();
      this.state = loaded.value; this.sha256 = loaded.sha256; this.initialized = true;
    } catch (cause) { throw fail('CLIENT_PACK_UNAVAILABLE', cause); }
  }
  async get(serverId, fingerprint) {
    this.#assert();
    if (typeof serverId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(serverId) || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw fail('INVALID_REQUEST');
    const current = this.#load();
    if (current.sha256 !== this.sha256) throw fail('CLIENT_PACK_UNAVAILABLE');
    return this.state.records.find(item => item.serverId === serverId && item.descriptor.serverFingerprint === fingerprint) || null;
  }
  async put(value, { expectedSequence } = {}) {
    this.#assert();
    const record = normalizeCompanionRecord(value);
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) throw fail('INVALID_REQUEST');
    if (expectedSequence !== this.state.sequence) throw fail('PLAN_STALE');
    // Validate current bytes before writing; stale valid writers are rejected by durable hash CAS.
    const current = this.#load();
    if (current.sha256 === null && this.sha256 !== null) throw fail('CLIENT_PACK_UNAVAILABLE');
    const records = this.state.records.filter(item => !(item.serverId === record.serverId && item.descriptor.serverFingerprint === record.descriptor.serverFingerprint));
    records.push(record);
    if (records.length > MAX_RECORDS || this.state.sequence === Number.MAX_SAFE_INTEGER) throw fail('COMMIT_FAILED');
    const candidate = envelope(this.state.sequence + 1, records);
    const bytes = `${JSON.stringify(candidate, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail('COMMIT_FAILED');
    try {
      this.#revalidate();
      this.durableFs.writeJsonAtomic(this.filePath, candidate, { expectedTargetSha256: this.sha256 });
      this.#revalidate();
      this.state = candidate; this.sha256 = hash(bytes);
      return record;
    } catch (cause) { throw fail('COMMIT_FAILED', cause); }
  }
  #identity() {
    const stat = this.fs.lstatSync(this.root, { bigint: true });
    const real = this.fs.realpathSync.native(this.root);
    const same = process.platform === 'win32' ? real.toLowerCase() === this.root.toLowerCase() : real === this.root;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same) throw fail('CLIENT_PACK_UNAVAILABLE');
    return [stat.dev, stat.ino, stat.birthtimeNs];
  }
  #revalidate() {
    const identity = this.#identity();
    if (!this.rootIdentity || identity.some((part, index) => part !== this.rootIdentity[index])) throw fail('CLIENT_PACK_UNAVAILABLE');
  }
  #assert() {
    if (!this.initialized) throw fail('CLIENT_PACK_UNAVAILABLE');
    try { this.#revalidate(); } catch (cause) { throw fail('CLIENT_PACK_UNAVAILABLE', cause); }
  }
  #load() {
    try {
      this.#revalidate();
      const bytes = this.durableFs.readFileBounded(this.filePath, { allowMissing: true, maxBytes: MAX_BYTES });
      this.#revalidate();
      if (bytes === null) return { value: envelope(0, []), sha256: null };
      return { value: normalize(JSON.parse(bytes.toString('utf8'))), sha256: hash(bytes) };
    } catch (cause) { throw fail('CLIENT_PACK_UNAVAILABLE', cause); }
  }
}
module.exports = { CompanionStore };
