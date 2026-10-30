const path = require('node:path');
const { randomUUID: uuid } = require('node:crypto');
const { ModpackError } = require('./modpacks/errors.cjs');
const { requestManagementJson, MANAGEMENT_INFO_MAX_BYTES, HOST_UNREACHABLE_REASON } = require('./management-session-transport.cjs');
const fail = (code = 'CLIENT_PACK_UNAVAILABLE', reason) => {
  const error = new ModpackError(code, 'The management session is unavailable');
  // Internal and non-enumerable: public payloads are rebuilt from the code alone.
  if (reason) Object.defineProperty(error, 'reason', { value: reason });
  return error;
};
const hostUnreachable = () => fail('CLIENT_PACK_UNAVAILABLE', HOST_UNREACHABLE_REASON);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const text = value => typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const sizedObject = (body, maxBytes) => {
  try { return body && typeof body === 'object' && !Array.isArray(body) && Buffer.byteLength(JSON.stringify(body)) <= maxBytes; }
  catch { return false; }
};

function normalize(target, config) {
  if (!config || typeof config !== 'object' || !['http', 'https'].includes(config.serverProtocol) ||
      !text(config.serverIp) || /[\s/@?#\\]/u.test(config.serverIp) || !/^[0-9]{1,5}$/.test(String(config.serverPort)) ||
      Number(config.serverPort) < 1 || Number(config.serverPort) > 65535 || typeof config.clientId !== 'string' || !idPattern.test(config.clientId) ||
      !text(config.clientName) || !text(config.inviteSecret) ||
      (config.sessionToken !== undefined && config.sessionToken !== '' && !text(config.sessionToken))) throw fail();
  const host = config.serverIp.includes(':') && !config.serverIp.startsWith('[') ? `[${config.serverIp}]` : config.serverIp;
  let origin;
  try { origin = new URL(`${config.serverProtocol}://${host}:${config.serverPort}`).origin; } catch { throw fail(); }
  let pin = '';
  if (config.serverProtocol === 'https') {
    if (typeof config.managementCertFingerprint !== 'string' || !/^(?:[a-f0-9]{64}|(?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/i.test(config.managementCertFingerprint)) throw fail();
    pin = config.managementCertFingerprint.replaceAll(':', '').toLowerCase();
  }
  const resolvedPath = path.resolve(target.clientPath);
  const authority = { clientPath: process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath,
    origin, pin, remoteId: config.clientId, name: config.clientName.trim(), invite: config.inviteSecret.trim() };
  return { authority, fingerprint: JSON.stringify(authority), seed: config.sessionToken || '' };
}

class ManagementSessionBroker {
  constructor({ resolveClient, readClientConfig, getPinnedHttpsAgent, requestJson = requestManagementJson,
    clock = Date.now, randomUUID = uuid, timeoutMs = 10000 } = {}) {
    if (typeof resolveClient !== 'function' || typeof readClientConfig !== 'function' || typeof requestJson !== 'function' ||
        typeof clock !== 'function' || typeof randomUUID !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw fail('INVALID_REQUEST');
    Object.assign(this, { resolveClient, readClientConfig, getPinnedHttpsAgent, requestJson, clock, randomUUID, timeoutMs });
    this.entries = new Map(); this.epochs = new Map(); this.claims = new Map(); this.operations = new Set(); this.disposed = false;
  }
  _budget(clientId, { signal, deadline } = {}, limit = 30000) {
    if (this.disposed) throw fail('CANCELLED');
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= 0)) throw fail('INVALID_REQUEST');
    const controller = new AbortController();
    const budget = { clientId, controller, signal: controller.signal, deadline: Math.min(deadline ?? Infinity, this.clock() + limit) };
    const abort = () => controller.abort(fail('CANCELLED'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(fail()), Math.max(0, budget.deadline - this.clock()));
    budget.close = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.operations.delete(budget); };
    this.operations.add(budget); return budget;
  }
  _check(budget) {
    if (budget.signal.aborted) throw budget.signal.reason;
    if (this.disposed) throw fail('CANCELLED');
    if (this.clock() >= budget.deadline) throw fail();
  }
  // Only a deadline aborts with CLIENT_PACK_UNAVAILABLE; cancellation and staleness never count as expiry.
  _expired(budget) {
    return budget.signal.aborted && budget.signal.reason?.code === 'CLIENT_PACK_UNAVAILABLE';
  }
  async _wait(operation, budget) {
    this._check(budget);
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(budget.signal.reason); };
      const cleanup = () => budget.signal.removeEventListener('abort', abort);
      budget.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { this._check(budget); return operation(); }).then(value => {
        cleanup(); try { this._check(budget); resolve(value); } catch (error) { reject(error); }
      }, error => { cleanup(); reject(error); });
    });
  }
  _drop(clientId) {
    // Order every accepted authority transition, including a current read failure.
    // Older asynchronous observations must not evict a subsequently accepted entry.
    this.epochs.set(clientId, (this.epochs.get(clientId) || 0) + 1);
    const entry = this.entries.get(clientId);
    if (entry) {
      entry.pending?.budget.controller.abort(fail('PLAN_STALE'));
      this.entries.delete(clientId);
      if (this.claims.get(entry.claim) === entry) this.claims.delete(entry.claim);
    }
  }
  async _binding(clientId, budget, expectedBinding) {
    const epoch = this.epochs.get(clientId) || 0;
    let target, normalized;
    try {
      target = await this._wait(() => this.resolveClient(clientId), budget);
      if (!target || target.clientId !== clientId || typeof target.clientPath !== 'string' || !target.clientPath) throw fail('INVALID_REQUEST');
      normalized = normalize(target, await this._wait(() => this.readClientConfig(target.clientPath), budget));
    } catch (error) {
      if (budget.signal.aborted) throw budget.signal.reason;
      this._check(budget);
      if ((this.epochs.get(clientId) || 0) !== epoch) throw fail('PLAN_STALE');
      this._drop(clientId);
      throw fail(error instanceof ModpackError && error.code === 'INVALID_REQUEST' ? 'INVALID_REQUEST' : 'CLIENT_PACK_UNAVAILABLE');
    }
    this._check(budget);
    let entry = this.entries.get(clientId);
    // Concurrent observations of the same accepted authority may adopt its current
    // token/revision; a delayed different observation can never replace it.
    if ((this.epochs.get(clientId) || 0) !== epoch && entry?.fingerprint !== normalized.fingerprint) throw fail('PLAN_STALE');
    if (!entry || entry.fingerprint !== normalized.fingerprint) {
      this._drop(clientId);
      const claim = JSON.stringify([normalized.authority.origin, normalized.authority.remoteId]);
      if (this.claims.has(claim)) throw fail();
      entry = { ...normalized, clientId, claim, token: normalized.seed, revision: 0,
        binding: Object.freeze({ generation: this.randomUUID() }), pending: null };
      this.entries.set(clientId, entry); this.claims.set(claim, entry);
    }
    if (expectedBinding && expectedBinding.generation !== entry.binding.generation) throw fail('PLAN_STALE');
    return entry;
  }
  async _assert(entry, budget) {
    const current = await this._binding(entry.clientId, budget, entry.binding);
    if (current !== entry) throw fail('PLAN_STALE');
  }
  _snapshot(entry) {
    return Object.freeze({ token: entry.token, baseOrigin: entry.authority.origin, binding: entry.binding,
      bindingGeneration: entry.binding.generation, revision: entry.revision });
  }
  async _request(entry, method, body, token, budget, exchange = { stage: null }) {
    const attempt = this._budget(entry.clientId, { signal: budget.signal, deadline: budget.deadline }, this.timeoutMs);
    try {
      const url = new URL(method === 'GET' ? '/api/server/info' : '/api/client/register', entry.authority.origin);
      let agent;
      if (url.protocol === 'https:') {
        if (typeof this.getPinnedHttpsAgent !== 'function') throw fail();
        agent = await this._wait(() => this.getPinnedHttpsAgent(url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 443), entry.authority.pin), attempt);
        if (!agent) throw fail();
      }
      await this._assert(entry, attempt);
      const result = await this._wait(() => this.requestJson(url, { method, body, agent, signal: attempt.signal,
        timeoutMs: Math.max(1, Math.min(this.timeoutMs, Math.ceil(attempt.deadline - this.clock()))),
        maxBytes: method === 'GET' ? MANAGEMENT_INFO_MAX_BYTES : 16384,
        headers: method === 'GET' ? { 'X-Session-Token': token } : { 'Content-Type': 'application/json' },
        onProgress: stage => { exchange.stage = stage; } }), attempt);
      await this._assert(entry, attempt);
      if (!result || !Number.isInteger(result.statusCode)) throw fail();
      return result;
    } catch (error) {
      // No HTTP status at all: a refusal, reset or DNS failure, or a deadline that expired while still connecting.
      const unreachable = exchange.stage !== 'responded' && ((error instanceof ModpackError && error.reason === HOST_UNREACHABLE_REASON) ||
        (exchange.stage === 'connecting' && (this._expired(attempt) || this._expired(budget))));
      if (budget.signal.aborted) throw unreachable && this._expired(budget) ? hostUnreachable() : budget.signal.reason;
      if (error instanceof ModpackError && ['PLAN_STALE', 'CANCELLED'].includes(error.code)) throw error;
      throw unreachable ? hostUnreachable() : fail();
    } finally { attempt.close(); }
  }
  _registration(entry) {
    if (entry.pending) return entry.pending.promise;
    const budget = this._budget(entry.clientId);
    const pending = { budget, exchange: { stage: null }, promise: null }; entry.pending = pending;
    pending.promise = (async () => {
      const body = JSON.stringify({ clientId: entry.authority.remoteId, name: entry.authority.name, secret: entry.authority.invite });
      if (Buffer.byteLength(body) > 16384) throw fail();
      const result = await this._request(entry, 'POST', body, undefined, budget, pending.exchange);
      if (result.statusCode !== 200 || !sizedObject(result.body, 16384) || result.body.success !== true ||
          typeof result.body.token !== 'string' || !/^[a-f0-9]{64}$/.test(result.body.token)) throw fail();
      await this._assert(entry, budget);
      entry.token = result.body.token; entry.revision++;
    })().finally(() => { budget.close(); if (entry.pending === pending) entry.pending = null; });
    return pending.promise;
  }
  _validate(clientId, options) {
    if (typeof clientId !== 'string' || !idPattern.test(clientId)) throw fail('INVALID_REQUEST');
    const reason = options.reason ?? 'reuse';
    if (!['reuse', 'authorization-rejected', 'explicit-reconnect'].includes(reason)) throw fail('INVALID_REQUEST');
    if (reason !== 'reuse' && (typeof options.observedBindingGeneration !== 'string' || !options.observedBindingGeneration ||
        !Number.isSafeInteger(options.observedRevision) || options.observedRevision < 0)) throw fail('INVALID_REQUEST');
    return reason;
  }
  async _acquireResult(clientId, options, budget) {
    const reason = this._validate(clientId, options);
    const entry = await this._binding(clientId, budget, options.expectedBinding);
    let registrationAttempted = false;
    const register = () => { registrationAttempted = true; return this._registration(entry); };
    // A caller deadline that expires while the shared registration is still connecting reports what its exchange would.
    const join = work => this._wait(work, budget).catch(error => {
      throw entry.pending?.exchange.stage === 'connecting' && this._expired(budget) ? hostUnreachable() : error;
    });
    if (reason !== 'reuse') {
      if (options.observedBindingGeneration !== entry.binding.generation) throw fail('PLAN_STALE');
      if (options.observedRevision > entry.revision) throw fail('INVALID_REQUEST');
      if (options.observedRevision === entry.revision) await join(() =>
        options.observedRevision === entry.revision ? register() : undefined);
    } else if (!entry.token) await join(() => entry.token ? undefined : register());
    await this._assert(entry, budget); return Object.freeze({ snapshot: this._snapshot(entry), registrationAttempted });
  }
  async _acquire(clientId, options, budget) {
    return (await this._acquireResult(clientId, options, budget)).snapshot;
  }
  async acquireWithProvenance(clientId, options = {}) {
    this._validate(clientId, options); const budget = this._budget(clientId, options);
    try { return await this._acquireResult(clientId, options, budget); } finally { budget.close(); }
  }
  async acquire(clientId, options = {}) {
    this._validate(clientId, options); const budget = this._budget(clientId, options);
    try { return await this._acquire(clientId, options, budget); } finally { budget.close(); }
  }
  // Main-only one-shot consumers need a pin from exactly the entry that supplied
  // the token/origin. The assertion never acquires/rotates a token or replays work.
  async acquireLegacyContext(clientId, options = {}) {
    this._validate(clientId, { reason: 'reuse' }); const budget = this._budget(clientId, options);
    try {
      const entry = await this._binding(clientId, budget, options.expectedBinding);
      const session = await this._acquire(clientId, { reason: 'reuse', expectedBinding: entry.binding }, budget);
      return Object.freeze({ baseOrigin: session.baseOrigin, sessionToken: session.token,
        managementCertFingerprint: entry.authority.pin, binding: session.binding,
        bindingGeneration: session.bindingGeneration, revision: session.revision,
        assertCurrent: async (checkOptions = {}) => {
          const checkBudget = this._budget(clientId, checkOptions);
          try { await this._assert(entry, checkBudget); } finally { checkBudget.close(); }
        } });
    } finally { budget.close(); }
  }
  async readServerInfo(clientId, options = {}) {
    this._validate(clientId, { reason: 'reuse' }); const budget = this._budget(clientId, options);
    try {
      // Retain the entry itself: looking it up after acquire can pair an old token
      // with a concurrently installed replacement authority.
      const entry = await this._binding(clientId, budget, options.expectedBinding);
      const hadToken = Boolean(entry.token);
      let session = await this._acquire(clientId, { expectedBinding: entry.binding }, budget);
      let result = await this._request(entry, 'GET', undefined, session.token, budget);
      if (result.statusCode === 401 && hadToken) {
        session = await this._acquire(clientId, { expectedBinding: session.binding, reason: 'authorization-rejected',
          observedBindingGeneration: session.bindingGeneration, observedRevision: session.revision }, budget);
        result = await this._request(entry, 'GET', undefined, session.token, budget);
      }
      if (result.statusCode !== 200 || !sizedObject(result.body, MANAGEMENT_INFO_MAX_BYTES)) throw fail();
      await this._assert(entry, budget); return { response: result.body, binding: session.binding };
    } finally { budget.close(); }
  }
  invalidate(clientId) {
    this._drop(clientId);
    for (const budget of this.operations) if (budget.clientId === clientId) budget.controller.abort(fail('PLAN_STALE'));
  }
  dispose() {
    this.disposed = true;
    for (const budget of this.operations) budget.controller.abort(fail('CANCELLED'));
    for (const clientId of this.entries.keys()) this._drop(clientId);
  }
}
module.exports = { ManagementSessionBroker };
