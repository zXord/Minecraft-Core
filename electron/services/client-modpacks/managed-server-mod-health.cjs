const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModpackError, CLIENT_PACK_SERVER_CHANGED_GUIDANCE: SERVER_CHANGED_GUIDANCE } = require('../modpacks/errors.cjs');
const { normalizeOwnershipManifest } = require('../modpacks/planning/ownership-planner.cjs');
const { inspectManagedPath, verifyManagedEntry, fileIdentity, sameFileIdentity, samePath, cancelled } = require('../modpacks/state/managed-entry-verifier.cjs');

const unavailable = cause => new ModpackError('CLIENT_PACK_UNAVAILABLE', 'The managed server mod files could not be safely checked. Use Modpack Verify before using its matching client pack.', { cause });
const stale = () => new ModpackError('PLAN_STALE', 'The managed server changed during verification');
const signature = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

class ManagedServerModHealth {
  constructor({ readRecord, fsApi = fs, fsPromises = fsApi?.promises, reparseInspector } = {}) {
    if (typeof readRecord !== 'function' || typeof fsApi?.lstatSync !== 'function' || typeof fsPromises?.open !== 'function' ||
        (reparseInspector !== undefined && typeof reparseInspector?.isReparsePoint !== 'function')) {
      throw new ModpackError('INVALID_REQUEST', 'Managed server health dependencies are invalid');
    }
    Object.assign(this, { readRecord, fsApi, fsPromises, reparseInspector });
    this.cache = new Map(); this.pending = new Map(); this.authorities = new Map(); this.closed = false;
  }
  async assertHealthy({ serverId, serverPath, record, force = false, signal } = {}) {
    if (this.closed) throw unavailable();
    if (typeof serverId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(serverId) ||
        typeof serverPath !== 'string' || !path.isAbsolute(serverPath) || typeof force !== 'boolean' ||
        (signal !== undefined && (typeof signal?.aborted !== 'boolean' || typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function'))) {
      throw new ModpackError('INVALID_REQUEST', 'Managed server health request is invalid');
    }
    cancelled(signal);
    if (record?.state?.modpackManaged !== true) { this.cache.delete(serverId); this.authorities.delete(serverId); return; }
    let manifest;
    try {
      manifest = normalizeOwnershipManifest(record.manifest);
      if (manifest.entries.length > 20000) throw unavailable();
    } catch (cause) { this.cache.delete(serverId); this.authorities.delete(serverId); throw cause; }
    const expected = manifest.entries.filter(entry => entry.origin === 'pack' && entry.managementPolicy === 'replaceable-managed' && entry.role === 'mod' && /\.jar$/i.test(entry.path));
    const recordSignature = signature(record);
    let observedRoot;
    try { observedRoot = this.#rootIdentity(serverPath); }
    catch (cause) { this.cache.delete(serverId); this.authorities.delete(serverId); throw unavailable(cause); }
    // Claim synchronously, before any native probe can pause. Same-authority
    // force/status share a token, but a new manifest/root supersedes old work.
    const authority = this.#claimAuthority(serverId, signature({ observedRoot, recordSignature }));
    const requestKey = force ? authority.forceKey : authority.statusKey;
    let operation = this.pending.get(requestKey);
    if (!operation || operation.controller.signal.aborted || operation.authority !== authority) {
      operation = { controller: new AbortController(), waiters: 0, authority };
      this.pending.set(requestKey, operation);
      operation.promise = Promise.resolve().then(() => this.#check({ serverId, serverPath, expected, recordSignature, observedRoot, authority, force, signal: operation.controller.signal }))
        .catch(cause => {
          if (this.authorities.get(serverId) === authority) this.cache.delete(serverId);
          cancelled(operation.controller.signal);
          if (cause instanceof ModpackError && ['CLIENT_PACK_SERVER_CHANGED', 'CANCELLED', 'INVALID_REQUEST', 'PLAN_STALE'].includes(cause.code) &&
              !(cause.code === 'PLAN_STALE' && cause.cause)) throw cause;
          throw unavailable(cause);
        }).finally(() => { if (this.pending.get(requestKey) === operation) this.pending.delete(requestKey); });
      operation.promise.catch(() => {});
    }
    return this.#join(operation, signal);
  }
  #claimAuthority(serverId, key) {
    let authority = this.authorities.get(serverId);
    if (authority?.key !== key) {
      authority = { key, statusKey: Symbol('status'), forceKey: Symbol('force') };
      this.cache.delete(serverId);
    }
    this.authorities.delete(serverId); this.authorities.set(serverId, authority);
    while (this.authorities.size > 32) {
      const oldest = this.authorities.keys().next().value;
      this.authorities.delete(oldest); this.cache.delete(oldest);
    }
    return authority;
  }
  #join(operation, signal) {
    operation.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (work, value) => {
        if (settled) return; settled = true;
        signal?.removeEventListener('abort', abort);
        operation.waiters--;
        if (!operation.waiters) operation.controller.abort();
        work(value);
      };
      const abort = () => finish(reject, new ModpackError('CANCELLED', 'Managed file verification was cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      operation.promise.then(value => finish(resolve, value), cause => finish(reject, cause));
    });
  }
  #rootIdentity(serverPath) {
    const stat = this.fsApi.lstatSync(serverPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(this.fsApi.realpathSync.native(serverPath), serverPath)) throw unavailable();
    const identity = fileIdentity(stat);
    const canonicalPath = process.platform === 'win32' ? path.resolve(serverPath).toLowerCase() : path.resolve(serverPath);
    return signature({ path: canonicalPath, dev: identity.dev, ino: identity.ino, birth: identity.birth });
  }
  async #root(serverPath, signal) {
    cancelled(signal);
    const identity = this.#rootIdentity(serverPath);
    if (this.reparseInspector && await this.reparseInspector.isReparsePoint(serverPath, { signal })) throw unavailable();
    return identity;
  }
  #assertResult(result) {
    if (result.status === 'missing' || result.status === 'modified') throw new ModpackError('CLIENT_PACK_SERVER_CHANGED', SERVER_CHANGED_GUIDANCE);
    if (result.status !== 'matched') throw unavailable();
  }
  async #check({ serverId, serverPath, expected, recordSignature, observedRoot, authority, force, signal }) {
    const root = await this.#root(serverPath, signal);
    if (root !== observedRoot || this.authorities.get(serverId) !== authority) throw stale();
    const key = signature({ root, recordSignature, expected });
    const cached = this.cache.get(serverId);
    if (cached && cached.key !== key) this.cache.delete(serverId);
    const prior = !force && cached?.key === key ? cached.entries : new Map();
    const entries = new Map();
    // Native ancestor evidence is local to this sweep and reused only while
    // fresh lstat identity still agrees; never carry it between status calls.
    const options = { fsApi: this.fsApi, fsPromises: this.fsPromises, reparseInspector: this.reparseInspector, signal,
      ancestorProof: new Map(), beforeAncestors: new Map(), afterAncestors: new Map() };
    for (const entry of expected) {
      const metadata = await inspectManagedPath(serverPath, entry, options);
      this.#assertResult(metadata);
      if (sameFileIdentity(prior.get(entry.pathKey), metadata.identity)) entries.set(entry.pathKey, metadata.identity);
      else {
        const checked = await verifyManagedEntry(serverPath, entry, options);
        this.#assertResult(checked); entries.set(entry.pathKey, checked.identity);
      }
    }
    // Recheck all metadata after hashing; a later JAR must not hide an edit to
    // an earlier one. Re-read authority last, then bind it to the same root.
    options.ancestorProof = new Map();
    for (const entry of expected) {
      const metadata = await inspectManagedPath(serverPath, entry, options);
      this.#assertResult(metadata);
      if (!sameFileIdentity(entries.get(entry.pathKey), metadata.identity)) throw stale();
    }
    if (signature(await this.readRecord(serverPath)) !== recordSignature || await this.#root(serverPath, signal) !== root) throw stale();
    cancelled(signal); if (this.closed) throw unavailable();
    // No awaits between this generation fence and publication/healthy return.
    if (this.authorities.get(serverId) !== authority) throw stale();
    this.cache.delete(serverId); this.cache.set(serverId, { key, entries });
    while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
  }
  async dispose() {
    this.closed = true; this.cache.clear(); this.authorities.clear();
    for (const operation of this.pending.values()) operation.controller.abort();
    await Promise.allSettled([...this.pending.values()].map(operation => operation.promise));
    this.pending.clear();
  }
}
module.exports = { ManagedServerModHealth, SERVER_CHANGED_GUIDANCE };
