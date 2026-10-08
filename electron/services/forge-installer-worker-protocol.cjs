const { normalizeRuntimeDiagnostic } = require('./runtime-diagnostic.cjs');
const crypto = require('node:crypto');
const path = require('node:path');

const FORGE_WORKER_PROTOCOL_VERSION = 1;
const FORGE_WORKER_OPERATION = 'install-forge-server';
const FORGE_WORKER_TOKEN_ENV = 'MINECRAFT_CORE_FORGE_WORKER_TOKEN';
const SAFE_TOKEN = /^[a-f0-9]{64}$/u;
const SAFE_REQUEST_ID = /^[a-f0-9]{32}$/u;
const SAFE_MINECRAFT_VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/u;
const SAFE_LOADER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

// Requests and successes retain v1; only diagnostic-bearing failures use v2.
const FAILURE_DIAGNOSTIC_PROTOCOL_VERSION = 2;
function diagnosticFieldsFor(ok, value) {
  if (value === undefined) return {};
  if (ok !== false) throw protocolError();
  try { return { runtimeDiagnostic: normalizeRuntimeDiagnostic(value) }; }
  catch { throw protocolError(); }
}

function protocolError() {
  const error = new Error('The Forge installer worker protocol is invalid.');
  error.code = 'FORGE_WORKER_PROTOCOL';
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function assertToken(token) {
  if (typeof token !== 'string' || !SAFE_TOKEN.test(token)) throw protocolError();
  return token;
}

function assertRequestId(requestId) {
  if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) throw protocolError();
  return requestId;
}

function assertAbsolutePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32767 ||
      CONTROL_CHARACTERS.test(value) || !path.isAbsolute(value)) throw protocolError();
  return value;
}

function assertForgePayload(payload) {
  if (!hasExactKeys(payload, ['targetPath', 'minecraftVersion', 'loaderVersion', 'javaPath']) ||
      typeof payload.minecraftVersion !== 'string' || !SAFE_MINECRAFT_VERSION.test(payload.minecraftVersion) ||
      typeof payload.loaderVersion !== 'string' || !SAFE_LOADER_VERSION.test(payload.loaderVersion)) {
    throw protocolError();
  }
  return {
    targetPath: assertAbsolutePath(payload.targetPath),
    minecraftVersion: payload.minecraftVersion,
    loaderVersion: payload.loaderVersion,
    javaPath: assertAbsolutePath(payload.javaPath)
  };
}

function requestAuthenticationValue(request) {
  return JSON.stringify([
    request.protocolVersion,
    request.operation,
    request.requestId,
    request.payload.targetPath,
    request.payload.minecraftVersion,
    request.payload.loaderVersion,
    request.payload.javaPath
  ]);
}

function responseAuthenticationValue(response) {
  const fields = [
    response.protocolVersion,
    response.requestId,
    response.ok,
    response.code
  ];
  if (response.protocolVersion === FAILURE_DIAGNOSTIC_PROTOCOL_VERSION) fields.push(response.runtimeDiagnostic);
  return JSON.stringify(fields);
}

function authenticate(token, value) {
  return crypto.createHmac('sha256', assertToken(token)).update(value, 'utf8').digest('hex');
}

function authenticatedEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' ||
      !SAFE_TOKEN.test(left) || !SAFE_TOKEN.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function createForgeInstallRequest({ token, requestId, payload } = {}) {
  const request = {
    protocolVersion: FORGE_WORKER_PROTOCOL_VERSION,
    operation: FORGE_WORKER_OPERATION,
    requestId: assertRequestId(requestId),
    payload: assertForgePayload(payload),
    auth: ''
  };
  request.auth = authenticate(token, requestAuthenticationValue(request));
  return request;
}

function verifyForgeInstallRequest(message, token) {
  if (!hasExactKeys(message, ['protocolVersion', 'operation', 'requestId', 'payload', 'auth']) ||
      message.protocolVersion !== FORGE_WORKER_PROTOCOL_VERSION ||
      message.operation !== FORGE_WORKER_OPERATION ||
      typeof message.auth !== 'string') throw protocolError();
  const request = {
    protocolVersion: message.protocolVersion,
    operation: message.operation,
    requestId: assertRequestId(message.requestId),
    payload: assertForgePayload(message.payload),
    auth: message.auth
  };
  const expected = authenticate(token, requestAuthenticationValue(request));
  if (!authenticatedEqual(request.auth, expected)) throw protocolError();
  return { requestId: request.requestId, payload: request.payload };
}

function createForgeInstallResponse({ token, requestId, ok, runtimeDiagnostic } = {}) {
  if (typeof ok !== 'boolean') throw protocolError();
  const diagnosticFields = diagnosticFieldsFor(ok, runtimeDiagnostic);
  const response = {
    protocolVersion: runtimeDiagnostic === undefined ? FORGE_WORKER_PROTOCOL_VERSION : FAILURE_DIAGNOSTIC_PROTOCOL_VERSION,
    requestId: assertRequestId(requestId),
    ok,
    code: ok ? null : 'INSTALL_FAILED',
    ...diagnosticFields,
    auth: ''
  };
  response.auth = authenticate(token, responseAuthenticationValue(response));
  return response;
}

function verifyForgeInstallResponse(message, token, expectedRequestId) {
  const isDiagnosticFailure = message?.protocolVersion === FAILURE_DIAGNOSTIC_PROTOCOL_VERSION;
  if (!hasExactKeys(message, ['protocolVersion', 'requestId', 'ok', 'code', 'auth', ...(isDiagnosticFailure ? ['runtimeDiagnostic'] : [])]) ||
      (isDiagnosticFailure ? message.ok !== false : message.protocolVersion !== FORGE_WORKER_PROTOCOL_VERSION) ||
      typeof message.ok !== 'boolean' ||
      message.code !== (message.ok ? null : 'INSTALL_FAILED') ||
      message.requestId !== assertRequestId(expectedRequestId) ||
      typeof message.auth !== 'string') throw protocolError();
  const diagnosticFields = isDiagnosticFailure ? diagnosticFieldsFor(false, message.runtimeDiagnostic) : {};
  if (isDiagnosticFailure && !Object.hasOwn(diagnosticFields, 'runtimeDiagnostic')) throw protocolError();
  const response = {
    protocolVersion: message.protocolVersion,
    requestId: assertRequestId(message.requestId),
    ok: message.ok,
    code: message.code,
    ...diagnosticFields,
    auth: message.auth
  };
  const expected = authenticate(token, responseAuthenticationValue(response));
  if (!authenticatedEqual(response.auth, expected)) throw protocolError();
  return { ok: response.ok, ...diagnosticFields };
}

module.exports = {
  FORGE_WORKER_PROTOCOL_VERSION,
  FORGE_WORKER_TOKEN_ENV,
  createForgeInstallRequest,
  verifyForgeInstallRequest,
  createForgeInstallResponse,
  verifyForgeInstallResponse
};
