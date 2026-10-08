'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { normalizeClientRuntime, failure } = require('./client-runtime-installer.cjs');
const TOKEN_ENV = 'MINECRAFT_CORE_CLIENT_RUNTIME_TOKEN';
const CODES = new Set(['RUNTIME_INCOMPLETE', 'UNSUPPORTED_LOADER', 'CANCELLED', 'LOADER_VERSION_UNAVAILABLE', 'LOADER_VERSION_REQUIRED']);
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw failure();
}
function payloadFor(kind, payload) {
  if (kind === 'request') {
    exact(payload, payload?.ownership === undefined ? ['clientPath', 'runtime'] : ['clientPath', 'runtime', 'ownership']);
    if (typeof payload.clientPath !== 'string' || payload.clientPath.length > 32767 || /[\u0000-\u001f\u007f]/.test(payload.clientPath) || !path.isAbsolute(payload.clientPath) || path.resolve(payload.clientPath) !== payload.clientPath) throw failure();
    const ownership = payload.ownership === undefined ? null : require('./client-runtime-ownership.cjs').contextFor(payload.ownership);
    if (ownership && ownership.clientPath !== payload.clientPath) throw failure();
    return { clientPath: payload.clientPath, runtime: normalizeClientRuntime(payload.runtime), ...(ownership ? { ownership } : {}) };
  }
  if (kind === 'result') {
    exact(payload, ['ok', 'code']);
    if (typeof payload.ok !== 'boolean' || (payload.ok ? payload.code !== null : !CODES.has(payload.code))) throw failure();
    return { ok: payload.ok, code: payload.code };
  }
  if (kind !== 'progress' || !payload || !['java', 'minecraft', 'loader', 'libraries', 'verify'].includes(payload.phase)) throw failure();
  const result = { phase: payload.phase };
  if (Object.keys(payload).some(key => !['phase', 'bytes', 'totalBytes', 'files', 'totalFiles'].includes(key))) throw failure();
  for (const key of ['bytes', 'totalBytes', 'files', 'totalFiles']) {
    if (payload[key] === undefined) continue;
    if (!Number.isSafeInteger(payload[key]) || payload[key] < 0 || payload[key] > 64 * 1024 ** 3) throw failure();
    result[key] = payload[key];
  }
  if (result.bytes > result.totalBytes || result.files > result.totalFiles) throw failure();
  return result;
}
function digest(token, frame) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw failure();
  return crypto.createHmac('sha256', token).update(JSON.stringify([frame.v, frame.id, frame.kind, frame.payload])).digest('hex');
}
function createFrame(token, id, kind, payload) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw failure();
  const frame = { v: 1, id, kind, payload: payloadFor(kind, payload), auth: '' };
  frame.auth = digest(token, frame);
  if (Buffer.byteLength(JSON.stringify(frame)) > 65536) throw failure();
  return frame;
}
function verifyFrame(value, token, id) {
  exact(value, ['v', 'id', 'kind', 'payload', 'auth']);
  if (value.v !== 1 || (id !== undefined && value.id !== id) || !/^[a-f0-9]{64}$/.test(value.auth)) throw failure();
  const expected = createFrame(token, value.id, value.kind, value.payload);
  if (!crypto.timingSafeEqual(Buffer.from(expected.auth, 'hex'), Buffer.from(value.auth, 'hex'))) throw failure();
  return expected;
}
module.exports = { TOKEN_ENV, CODES, createFrame, verifyFrame };
