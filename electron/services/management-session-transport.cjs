const http = require('node:http');
const https = require('node:https');
const { ModpackError } = require('./modpacks/errors.cjs');
// /api/server/info lists every client mod twice, so large packs need several MiB (v26.6.1 had no cap).
const MANAGEMENT_INFO_MAX_BYTES = 8 * 1024 * 1024;
// Internal only: the exchange never received an HTTP status because the host could not be reached.
const HOST_UNREACHABLE_REASON = 'host-unreachable';
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL',
  'ETIMEDOUT', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL']);
const fail = (code = 'CLIENT_PACK_UNAVAILABLE', reason) => {
  const error = new ModpackError(code, 'The management request could not be completed');
  // Non-enumerable, so serialized errors and public payloads never carry it.
  if (reason) Object.defineProperty(error, 'reason', { value: reason });
  return error;
};

// No redirect handling, remote error text, or raw dependency errors cross this boundary.
// onProgress observes 'connecting', 'connected' (TCP, or the TLS handshake for https) and 'responded'.
async function requestManagementJson(input, { method = 'GET', body, headers, agent, signal, timeoutMs = 10000, maxBytes = 262144, onProgress } = {}) {
  let url;
  try { url = new URL(input); } catch { throw fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      !['GET', 'POST'].includes(method) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MANAGEMENT_INFO_MAX_BYTES ||
      (onProgress !== undefined && typeof onProgress !== 'function') ||
      (body !== undefined && (method !== 'POST' || typeof body !== 'string' || Buffer.byteLength(body) > 16384))) throw fail();
  if (signal?.aborted) throw fail('CANCELLED');
  return new Promise((resolve, reject) => {
    let request, timer, stage = null, settled = false;
    const progress = next => {
      if (settled) return;
      stage = next;
      try { onProgress?.(next); } catch { /* Observers never change the exchange. */ }
    };
    // Refusals, resets, DNS failures and connect or TLS timeouts before any status are the only unreachable outcomes.
    const unreachable = code => stage !== 'responded' && UNREACHABLE_CODES.has(code) ? HOST_UNREACHABLE_REASON : undefined;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { request?.destroy(); reject(error); } else resolve(value);
    };
    const abort = () => finish(fail('CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(fail(undefined, stage === 'connecting' ? HOST_UNREACHABLE_REASON : undefined)), timeoutMs);
    try {
      request = (url.protocol === 'https:' ? https : http).request(url, { method, headers, agent }, response => {
        progress('responded');
        const statusCode = response.statusCode;
        if (statusCode >= 300 && statusCode < 400) { finish(fail()); return; }
        if (statusCode !== 200) { response.resume(); finish(null, { statusCode, body: null }); request.destroy(); return; }
        let length = 0; const chunks = [];
        response.on('data', chunk => {
          length += chunk.length;
          if (length > maxBytes) { finish(fail()); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(fail()));
        response.on('aborted', () => finish(fail()));
        response.on('end', () => {
          try { finish(null, { statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { finish(fail()); }
        });
      });
      request.on('socket', socket => {
        if (request.reusedSocket) { progress('connected'); return; }
        progress('connecting');
        socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { if (stage === 'connecting') progress('connected'); });
      });
      request.on('error', error => finish(fail(undefined, unreachable(error?.code))));
      if (signal?.aborted) { abort(); return; }
      request.end(body);
    } catch { finish(fail()); }
  });
}
module.exports = { requestManagementJson, MANAGEMENT_INFO_MAX_BYTES, HOST_UNREACHABLE_REASON };
