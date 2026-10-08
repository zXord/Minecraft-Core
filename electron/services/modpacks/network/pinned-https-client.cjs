const https = require('node:https');
const dns = require('node:dns');
const tls = require('node:tls');
const { ModpackError } = require('../errors.cjs');
const { validateRemoteUrl, resolvePublicAddresses, normalizeAddress } = require('./remote-url-policy.cjs');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade']);
const CROSS_ORIGIN_SECRETS = new Set(['authorization', 'proxy-authorization', 'cookie']);
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;

function invalidUrl() { return new ModpackError('INVALID_RELEASE_URL', 'Remote release address is not allowed', { details: { reasonCode: 'host-not-allowed' } }); }
function deadlineExceeded() { return new ModpackError('INVALID_RELEASE_URL', 'Remote release request timed out', { retryable: true }); }
function cancelled() { return new ModpackError('CANCELLED', 'Artifact download was cancelled'); }

function requestTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) throw new TypeError('Pinned HTTPS dependencies are invalid');
  return value;
}

function deadlineSignal(signal, timeoutMs) {
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController();
  let timedOut = false;
  let callerCancelled = false;
  const onAbort = () => {
    callerCancelled = true;
    controller.abort();
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let rejectDeadline;
  const deadline = new Promise((resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(deadlineExceeded());
  }, timeoutMs);
  return {
    signal: controller.signal,
    deadline,
    callerCancelled: () => callerCancelled,
    timedOut: () => timedOut,
    clearDeadline() {
      clearTimeout(timer);
    },
    release() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

async function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw cancelled();
  let onAbort;
  const aborted = new Promise((resolve, reject) => { onAbort = () => reject(cancelled()); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function safeHeaders(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidUrl();
  const output = {};
  for (const [rawName, headerValue] of Object.entries(value)) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || FORBIDDEN_HEADERS.has(name) || headerValue === undefined || headerValue === null) throw invalidUrl();
    if (!(typeof headerValue === 'string' || typeof headerValue === 'number' || Array.isArray(headerValue) && headerValue.every(item => typeof item === 'string'))) throw invalidUrl();
    output[name] = headerValue;
  }
  return output;
}

class PinnedHttpsClient {
  constructor({ lookup = dns.promises.lookup, request = https.request, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (typeof lookup !== 'function' || typeof request !== 'function') throw new TypeError('Pinned HTTPS dependencies are invalid');
    this.lookup = lookup; this.requestImpl = request; this.requestTimeoutMs = requestTimeout(requestTimeoutMs);
  }

  async request(value, options = {}) {
    const { signal } = options;
    const bounded = deadlineSignal(signal, this.requestTimeoutMs);
    let response;
    try {
      response = await Promise.race([
        this.#request(value, { ...options, signal: bounded.signal }),
        bounded.deadline
      ]);
      bounded.clearDeadline();
      response.once('close', () => bounded.release());
      return response;
    } catch (error) {
      if (bounded.callerCancelled()) throw cancelled();
      if (bounded.timedOut()) throw deadlineExceeded();
      throw error;
    } finally {
      if (!response) bounded.release();
    }
  }

  async #request(value, { headers, signal, allowedHosts, allowedOrigins, allowSubdomains = false, maxRedirects = 5 } = {}) {
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw invalidUrl();
    let current = validateRemoteUrl(value, { allowedHosts, allowedOrigins, allowSubdomains });
    let requestHeaders = safeHeaders(headers);
    const visited = new Set();
    for (let redirects = 0; ; redirects += 1) {
      if (signal?.aborted) throw cancelled();
      const requestIdentity = `${current.origin}${current.pathname}${current.search}`;
      if (visited.has(requestIdentity)) throw invalidUrl();
      visited.add(requestIdentity);
      const vetted = await withAbort(resolvePublicAddresses(current.hostname, { lookup: this.lookup }), signal);
      if (signal?.aborted) throw cancelled();
      const response = await this.requestOnce(current, { headers: requestHeaders, signal, vetted });
      if (!REDIRECTS.has(response.statusCode)) return response;
      response.destroy();
      if (redirects >= maxRedirects) throw invalidUrl();
      const location = response.headers?.location;
      if (typeof location !== 'string' || !location || /[\r\n]/.test(location)) throw invalidUrl();
      let next;
      try { next = new URL(location, current); } catch { throw invalidUrl(); }
      next = validateRemoteUrl(next, { allowedHosts, allowedOrigins, allowSubdomains });
      if (next.origin !== current.origin) {
        requestHeaders = Object.fromEntries(Object.entries(requestHeaders).filter(([name]) => !CROSS_ORIGIN_SECRETS.has(name)));
      }
      current = next;
    }
  }

  requestOnce(url, { headers, signal, vetted }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const allowedPeers = new Set(vetted.map(answer => normalizeAddress(answer.address)));
      const pinned = vetted[0];
      const finishReject = error => {
        if (settled) return; settled = true; cleanup();
        reject(error?.code === 'CANCELLED' || error?.code === 'ABORT_ERR' || signal?.aborted ? cancelled() : invalidUrl());
      };
      const onAbort = () => { const error = cancelled(); request.destroy(error); finishReject(error); };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      let request;
      try {
        request = this.requestImpl(url, {
          method: 'GET', headers, signal, servername: url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname,
          rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity,
          lookup: (_hostname, lookupOptions, callback) => lookupOptions?.all
            ? callback(null, [{ address: pinned.address, family: pinned.family }])
            : callback(null, pinned.address, pinned.family)
        }, response => {
          if (settled) { response.destroy(); return; }
          const peer = normalizeAddress(response.socket?.remoteAddress);
          if (!peer || !allowedPeers.has(peer)) { response.destroy(); finishReject(invalidUrl()); return; }
          settled = true; cleanup();
          if (signal) {
            const destroyOnAbort = () => response.destroy(cancelled());
            signal.addEventListener('abort', destroyOnAbort, { once: true });
            response.once('close', () => signal.removeEventListener('abort', destroyOnAbort));
          }
          resolve(response);
        });
      } catch { finishReject(invalidUrl()); return; }
      request.once('error', finishReject);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort(); else request.end();
    });
  }
}

module.exports = { PinnedHttpsClient };
