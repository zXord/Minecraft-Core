const http = require('node:http');
const https = require('node:https');
const { ModpackError } = require('./modpacks/errors.cjs');
const fail = (code = 'CLIENT_PACK_UNAVAILABLE') => new ModpackError(code, 'The management request could not be completed');

// No redirect handling, remote error text, or raw dependency errors cross this boundary.
async function requestManagementJson(input, { method = 'GET', body, headers, agent, signal, timeoutMs = 10000, maxBytes = 262144 } = {}) {
  let url;
  try { url = new URL(input); } catch { throw fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash ||
      !['GET', 'POST'].includes(method) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144 ||
      (body !== undefined && (method !== 'POST' || typeof body !== 'string' || Buffer.byteLength(body) > 16384))) throw fail();
  if (signal?.aborted) throw fail('CANCELLED');
  return new Promise((resolve, reject) => {
    let request, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { request?.destroy(); reject(error); } else resolve(value);
    };
    const abort = () => finish(fail('CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(fail()), timeoutMs);
    try {
      request = (url.protocol === 'https:' ? https : http).request(url, { method, headers, agent }, response => {
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
      request.on('error', () => finish(fail()));
      if (signal?.aborted) { abort(); return; }
      request.end(body);
    } catch { finish(fail()); }
  });
}
module.exports = { requestManagementJson };
