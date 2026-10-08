const crypto = require('node:crypto');
const path = require('node:path');

const JAVA_ARCHIVE_WORKER_PROTOCOL_VERSION = 1;
const JAVA_ARCHIVE_WORKER_OPERATION = 'extract-java-zip';
const JAVA_ARCHIVE_WORKER_TOKEN_ENV = 'MINECRAFT_CORE_JAVA_ARCHIVE_WORKER_TOKEN';
const MAX_JAVA_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_JAVA_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SAFE_TOKEN = /^[a-f0-9]{64}$/u;
const SAFE_REQUEST_ID = /^[a-f0-9]{32}$/u;
const FAILURE_CODES = new Set([
  'JAVA_ARCHIVE_UNSAFE',
  'JAVA_ARCHIVE_TOO_LARGE',
  'JAVA_EXTRACTION_FAILED'
]);

function protocolError() {
  const error = new Error('The Java archive worker protocol is invalid.');
  error.code = 'JAVA_ARCHIVE_WORKER_PROTOCOL';
  return error;
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function bounded(value, maximum) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw protocolError(); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maximum) throw protocolError();
}

function token(value) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) throw protocolError();
  return value;
}

function requestId(value) {
  if (typeof value !== 'string' || !SAFE_REQUEST_ID.test(value)) throw protocolError();
  return value;
}

function canonicalAbsolute(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32767 ||
      [...value].some(character => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127) ||
      !path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value) throw protocolError();
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function payload(value) {
  if (!exact(value, [
    'rootPath', 'archivePath', 'destinationPath', 'maxArchiveBytes', 'expectedArchiveSize', 'expectedSha256'
  ])) throw protocolError();
  const rootPath = canonicalAbsolute(value.rootPath);
  const archivePath = canonicalAbsolute(value.archivePath);
  const destinationPath = canonicalAbsolute(value.destinationPath);
  const maxArchiveBytes = value.maxArchiveBytes;
  const expectedArchiveSize = value.expectedArchiveSize;
  const expectedSha256 = value.expectedSha256;
  const archiveRelative = path.relative(rootPath, archivePath);
  const destinationRelative = path.relative(rootPath, destinationPath);
  if (!inside(rootPath, archivePath) || !inside(rootPath, destinationPath) ||
      archivePath === destinationPath || path.extname(archivePath).toLowerCase() !== '.zip' ||
      archiveRelative.split(path.sep)[0].toLowerCase() !== 'temp' ||
      destinationRelative.includes(path.sep) || !/^java-[1-9][0-9]?$/u.test(destinationRelative) ||
      !Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1 || maxArchiveBytes > MAX_JAVA_ARCHIVE_BYTES ||
      !Number.isSafeInteger(expectedArchiveSize) || expectedArchiveSize < 1 || expectedArchiveSize > maxArchiveBytes ||
      typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw protocolError();
  }
  return { rootPath, archivePath, destinationPath, maxArchiveBytes, expectedArchiveSize, expectedSha256 };
}

function javaArchiveStagingPath(destinationPath, id) {
  const destination = canonicalAbsolute(destinationPath);
  return path.join(path.dirname(destination), `.${path.basename(destination)}-extract-${requestId(id)}`);
}

function javaArchivePreviousPath(destinationPath, id) {
  const destination = canonicalAbsolute(destinationPath);
  return path.join(path.dirname(destination), `.${path.basename(destination)}-previous-${requestId(id)}`);
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || value.includes('\\') ||
      value.includes(':') || [...value].some(character => character.codePointAt(0) <= 31 ||
        character.codePointAt(0) === 127)) throw protocolError();
  const components = value.split('/');
  if (components.length > 64 || components.some(component => !component || component === '.' || component === '..') ||
      path.posix.normalize(value) !== value || path.posix.isAbsolute(value)) throw protocolError();
  return value;
}

function result(value) {
  if (!exact(value, ['entryCount', 'expandedBytes', 'javaExecutableRelativePath']) ||
      !Number.isSafeInteger(value.entryCount) ||
      value.entryCount < 1 || value.entryCount > 250000 || typeof value.expandedBytes !== 'string' ||
      !/^(?:0|[1-9][0-9]*)$/u.test(value.expandedBytes) || BigInt(value.expandedBytes) > BigInt(MAX_JAVA_EXPANDED_BYTES)) {
    throw protocolError();
  }
  return {
    entryCount: value.entryCount,
    expandedBytes: value.expandedBytes,
    javaExecutableRelativePath: safeRelativePath(value.javaExecutableRelativePath)
  };
}

function failureCode(value) {
  if (typeof value !== 'string' || !FAILURE_CODES.has(value)) throw protocolError();
  return value;
}

function authenticate(secret, value) {
  return crypto.createHmac('sha256', token(secret)).update(value, 'utf8').digest('hex');
}

function equal(left, right) {
  return typeof left === 'string' && typeof right === 'string' && SAFE_TOKEN.test(left) && SAFE_TOKEN.test(right) &&
    crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requestAuth(value) {
  return JSON.stringify([value.protocolVersion, value.operation, value.requestId, value.payload]);
}

function responseAuth(value) {
  return JSON.stringify([
    value.protocolVersion, value.operation, value.requestId, value.ok, value.code, value.result
  ]);
}

function createJavaArchiveRequest({ token: secret, requestId: id, payload: input } = {}) {
  const request = {
    protocolVersion: JAVA_ARCHIVE_WORKER_PROTOCOL_VERSION,
    operation: JAVA_ARCHIVE_WORKER_OPERATION,
    requestId: requestId(id),
    payload: payload(input),
    auth: ''
  };
  request.auth = authenticate(secret, requestAuth(request));
  bounded(request, MAX_REQUEST_BYTES);
  return request;
}

function verifyJavaArchiveRequest(message, secret) {
  if (!exact(message, ['protocolVersion', 'operation', 'requestId', 'payload', 'auth']) ||
      message.protocolVersion !== JAVA_ARCHIVE_WORKER_PROTOCOL_VERSION ||
      message.operation !== JAVA_ARCHIVE_WORKER_OPERATION || typeof message.auth !== 'string') throw protocolError();
  const request = {
    protocolVersion: message.protocolVersion,
    operation: message.operation,
    requestId: requestId(message.requestId),
    payload: payload(message.payload),
    auth: message.auth
  };
  bounded(request, MAX_REQUEST_BYTES);
  if (!equal(request.auth, authenticate(secret, requestAuth(request)))) throw protocolError();
  return { requestId: request.requestId, payload: request.payload };
}

function createJavaArchiveResponse({ token: secret, requestId: id, ok, code = null, result: input = null } = {}) {
  if (typeof ok !== 'boolean' || (ok ? code !== null && code !== undefined : input !== null && input !== undefined)) {
    throw protocolError();
  }
  const response = {
    protocolVersion: JAVA_ARCHIVE_WORKER_PROTOCOL_VERSION,
    operation: JAVA_ARCHIVE_WORKER_OPERATION,
    requestId: requestId(id),
    ok,
    code: ok ? null : failureCode(code),
    result: ok ? result(input) : null,
    auth: ''
  };
  response.auth = authenticate(secret, responseAuth(response));
  bounded(response, MAX_RESPONSE_BYTES);
  return response;
}

function verifyJavaArchiveResponse(message, secret, expectedRequestId) {
  if (!exact(message, [
    'protocolVersion', 'operation', 'requestId', 'ok', 'code', 'result', 'auth'
  ]) || message.protocolVersion !== JAVA_ARCHIVE_WORKER_PROTOCOL_VERSION ||
      message.operation !== JAVA_ARCHIVE_WORKER_OPERATION || typeof message.ok !== 'boolean' ||
      typeof message.auth !== 'string' || message.requestId !== requestId(expectedRequestId) ||
      (message.ok ? message.code !== null : message.result !== null)) throw protocolError();
  const response = {
    protocolVersion: message.protocolVersion,
    operation: message.operation,
    requestId: message.requestId,
    ok: message.ok,
    code: message.ok ? null : failureCode(message.code),
    result: message.ok ? result(message.result) : null,
    auth: message.auth
  };
  bounded(response, MAX_RESPONSE_BYTES);
  if (!equal(response.auth, authenticate(secret, responseAuth(response)))) throw protocolError();
  return { ok: response.ok, code: response.code, result: response.result };
}

module.exports = {
  JAVA_ARCHIVE_WORKER_OPERATION,
  JAVA_ARCHIVE_WORKER_PROTOCOL_VERSION,
  JAVA_ARCHIVE_WORKER_TOKEN_ENV,
  MAX_JAVA_ARCHIVE_BYTES,
  javaArchivePreviousPath,
  javaArchiveStagingPath,
  createJavaArchiveRequest,
  verifyJavaArchiveRequest,
  createJavaArchiveResponse,
  verifyJavaArchiveResponse
};
