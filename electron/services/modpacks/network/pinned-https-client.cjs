const https = require('node:https');
const dns = require('node:dns');
const tls = require('node:tls');
const { ModpackError } = require('../errors.cjs');
const { validateRemoteUrl, resolvePublicAddresses, normalizeAddress } = require('./remote-url-policy.cjs');

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade']);
const CROSS_ORIGIN_SECRETS = new Set(['authorization', 'proxy-authorization', 'cookie']);

function invalidUrl() { return new ModpackError('INVALID_RELEASE_URL', 'Remote release address is not allowed', { details: { reasonCode: 'host-not-allowed' } }); }
function cancelled() { return new ModpackError('CANCELLED', 'Artifact download was cancelled'); }

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
  constructor({ lookup = dns.promises.lookup, request = https.request } = {}) {
    if (typeof lookup !== 'function' || typeof request !== 'function') throw new TypeError('Pinned HTTPS dependencies are invalid');
    this.lookup = lookup; this.requestImpl = request;
  }

  async request(value, { headers, signal, allowedHosts, allowSubdomains = false, maxRedirects = 5 } = {}) {
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw invalidUrl();
    let current = validateRemoteUrl(value, { allowedHosts, allowSubdomains });
    let requestHeaders = safeHeaders(headers);
    const visited = new Set();
    for (let redirects = 0; ; redirects += 1) {
      if (signal?.aborted) throw cancelled();
      const requestIdentity = `${current.origin}${current.pathname}${current.search}`;
      if (visited.has(requestIdentity)) throw invalidUrl();
      visited.add(requestIdentity);
      const vetted = await resolvePublicAddresses(current.hostname, { lookup: this.lookup });
      const response = await this.requestOnce(current, { headers: requestHeaders, signal, vetted });
      if (!REDIRECTS.has(response.statusCode)) return response;
      response.destroy();
      if (redirects >= maxRedirects) throw invalidUrl();
      const location = response.headers?.location;
      if (typeof location !== 'string' || !location || /[\r\n]/.test(location)) throw invalidUrl();
      let next;
      try { next = new URL(location, current); } catch { throw invalidUrl(); }
      next = validateRemoteUrl(next, { allowedHosts, allowSubdomains });
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
        reject(error?.code === 'CANCELLED' ? error : invalidUrl());
      };
      const onAbort = () => { const error = cancelled(); request.destroy(error); finishReject(error); };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      let request;
      try {
        request = this.requestImpl(url, {
          method: 'GET', headers, signal, servername: url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname,
          rejectUnauthorized: true, checkServerIdentity: tls.checkServerIdentity,
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family)
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
