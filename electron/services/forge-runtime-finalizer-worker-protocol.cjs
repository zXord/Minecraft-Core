const { normalizeRuntimeDiagnostic } = require('./runtime-diagnostic.cjs');
const crypto = require('node:crypto');
const path = require('node:path');

const FORGE_FINALIZER_PROTOCOL_VERSION = 1;
const FORGE_FINALIZER_OPERATION = 'finalize-forge-server-runtime';
const FORGE_FINALIZER_TOKEN_ENV = 'MINECRAFT_CORE_FORGE_FINALIZER_TOKEN';
const MAX_VALIDATION_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACTS = 10000;
const MAX_RUNTIME_BYTES = 1024 * 1024 * 1024;
const SAFE_TOKEN = /^[a-f0-9]{64}$/u;
const SAFE_REQUEST_ID = /^[a-f0-9]{32}$/u;
const SAFE_MINECRAFT_VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/u;
const SAFE_LOADER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

function hasControlCharacters(value) {
  return [...value].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);
}

// Requests and successes retain v1; only diagnostic-bearing failures use v2.
const FAILURE_DIAGNOSTIC_PROTOCOL_VERSION = 2;
function diagnosticFieldsFor(ok, value) {
  if (value === undefined) return {};
  if (ok !== false) throw protocolError();
  try { return { runtimeDiagnostic: normalizeRuntimeDiagnostic(value) }; }
  catch { throw protocolError(); }
}

function protocolError() {
  const error = new Error('The Forge runtime finalizer worker protocol is invalid.');
  error.code = 'FORGE_FINALIZER_PROTOCOL';
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
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
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 32767 ||
      hasControlCharacters(value) || !path.isAbsolute(value) || path.normalize(value) !== value ||
      path.resolve(value) !== value) throw protocolError();
  return value;
}

function assertRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 ||
      hasControlCharacters(value) || value.includes('\\') || value.includes(':') ||
      value.startsWith('/') || value.split('/').some(segment => !segment || segment === '.' || segment === '..' ||
        /[. ]$/u.test(segment))) {
    throw protocolError();
  }
  return value;
}

function assertRuntime(runtime) {
  if (!hasExactKeys(runtime, ['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture']) ||
      typeof runtime.minecraftVersion !== 'string' || !SAFE_MINECRAFT_VERSION.test(runtime.minecraftVersion) ||
      runtime.loaderFamily !== 'forge' || typeof runtime.loaderVersion !== 'string' ||
      !SAFE_LOADER_VERSION.test(runtime.loaderVersion) || !Number.isSafeInteger(runtime.javaMajor) ||
      runtime.javaMajor < 8 || runtime.javaMajor > 99 || runtime.os !== 'win32' || runtime.architecture !== 'x64') {
    throw protocolError();
  }
  return {
    minecraftVersion: runtime.minecraftVersion,
    loaderFamily: runtime.loaderFamily,
    loaderVersion: runtime.loaderVersion,
    javaMajor: runtime.javaMajor,
    os: runtime.os,
    architecture: runtime.architecture
  };
}

function runtimeEquals(left, right) {
  return ['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture']
    .every(key => left?.[key] === right?.[key]);
}

function assertLoader(loader, runtime) {
  if (!isPlainObject(loader) || loader.family !== 'forge') throw protocolError();
  const artifactVersion = `${runtime.minecraftVersion}-${runtime.loaderVersion}`;
  if (hasExactKeys(loader, ['family', 'argsFile'])) {
    const argsFile = assertRelativePath(loader.argsFile);
    if (argsFile !== `libraries/net/minecraftforge/forge/${artifactVersion}/win_args.txt`) throw protocolError();
    return { family: 'forge', argsFile };
  }
  if (!hasExactKeys(loader, ['family', 'launchJar', 'serverJar', 'libraries']) ||
      !Array.isArray(loader.libraries) || loader.libraries.length < 1 || loader.libraries.length > MAX_ARTIFACTS) {
    throw protocolError();
  }
  const libraries = loader.libraries.map(assertRelativePath);
  if (new Set(libraries.map(value => value.normalize('NFC').toLowerCase())).size !== libraries.length ||
      libraries.some(value => !value.startsWith('libraries/') || !value.toLowerCase().endsWith('.jar'))) {
    throw protocolError();
  }
  const launchJar = assertRelativePath(loader.launchJar);
  const serverJar = assertRelativePath(loader.serverJar);
  if (launchJar !== `forge-${artifactVersion}.jar` ||
      serverJar !== `minecraft_server.${runtime.minecraftVersion}.jar`) throw protocolError();
  return {
    family: 'forge',
    launchJar,
    serverJar,
    libraries
  };
}

function assertValidation(validation, expectedRuntime) {
  let serialized;
  try { serialized = JSON.stringify(validation); } catch { throw protocolError(); }
  if (Buffer.byteLength(serialized || '', 'utf8') > MAX_VALIDATION_BYTES ||
      !hasExactKeys(validation, ['valid', 'runtime', 'loader', 'artifacts']) || validation.valid !== true ||
      !Array.isArray(validation.artifacts) || validation.artifacts.length < 1 ||
      validation.artifacts.length > MAX_ARTIFACTS) throw protocolError();
  const runtime = assertRuntime(validation.runtime);
  if (expectedRuntime && !runtimeEquals(runtime, assertRuntime(expectedRuntime))) throw protocolError();
  const loader = assertLoader(validation.loader, runtime);
  const identities = new Set();
  let measuredBytes = 0;
  const artifacts = validation.artifacts.map(artifact => {
    if (!hasExactKeys(artifact, ['relativePath', 'size', 'sha256', 'sha512']) ||
        !Number.isSafeInteger(artifact.size) || artifact.size < 0 ||
        typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
        typeof artifact.sha512 !== 'string' || !/^[a-f0-9]{128}$/u.test(artifact.sha512)) throw protocolError();
    const relativePath = assertRelativePath(artifact.relativePath);
    const identity = relativePath.normalize('NFC').toLowerCase();
    if (identities.has(identity)) throw protocolError();
    identities.add(identity);
    measuredBytes += artifact.size;
    if (!Number.isSafeInteger(measuredBytes) || measuredBytes > MAX_RUNTIME_BYTES) throw protocolError();
    return { relativePath, size: artifact.size, sha256: artifact.sha256, sha512: artifact.sha512 };
  });
  const loaderPaths = loader.argsFile
    ? [loader.argsFile]
    : [loader.launchJar, loader.serverJar, ...loader.libraries];
  if (loaderPaths.some(value => !identities.has(value.normalize('NFC').toLowerCase()))) throw protocolError();
  return { valid: true, runtime, loader, artifacts };
}

function assertPayload(payload) {
  if (!hasExactKeys(payload, ['targetPath', 'runtime'])) throw protocolError();
  return { targetPath: assertAbsolutePath(payload.targetPath), runtime: assertRuntime(payload.runtime) };
}

function authenticate(token, value) {
  return crypto.createHmac('sha256', assertToken(token)).update(value, 'utf8').digest('hex');
}

function authenticatedEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !SAFE_TOKEN.test(left) || !SAFE_TOKEN.test(right)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requestAuthenticationValue(request) {
  return JSON.stringify([request.protocolVersion, request.operation, request.requestId, request.payload]);
}

function responseAuthenticationValue(response) {
  const fields = [response.protocolVersion, response.requestId, response.ok, response.code, response.validation];
  if (response.protocolVersion === FAILURE_DIAGNOSTIC_PROTOCOL_VERSION) fields.push(response.runtimeDiagnostic);
  return JSON.stringify(fields);
}

function createForgeFinalizerRequest({ token, requestId, payload } = {}) {
  const request = {
    protocolVersion: FORGE_FINALIZER_PROTOCOL_VERSION,
    operation: FORGE_FINALIZER_OPERATION,
    requestId: assertRequestId(requestId),
    payload: assertPayload(payload),
    auth: ''
  };
  request.auth = authenticate(token, requestAuthenticationValue(request));
  return request;
}

function verifyForgeFinalizerRequest(message, token) {
  if (!hasExactKeys(message, ['protocolVersion', 'operation', 'requestId', 'payload', 'auth']) ||
      message.protocolVersion !== FORGE_FINALIZER_PROTOCOL_VERSION || message.operation !== FORGE_FINALIZER_OPERATION ||
      typeof message.auth !== 'string') throw protocolError();
  const request = {
    protocolVersion: message.protocolVersion,
    operation: message.operation,
    requestId: assertRequestId(message.requestId),
    payload: assertPayload(message.payload),
    auth: message.auth
  };
  const expected = authenticate(token, requestAuthenticationValue(request));
  if (!authenticatedEqual(request.auth, expected)) throw protocolError();
  return { requestId: request.requestId, payload: request.payload };
}

function createForgeFinalizerResponse({ token, requestId, ok, validation = null, runtimeDiagnostic } = {}) {
  if (typeof ok !== 'boolean' || (ok && validation === null) || (!ok && validation !== null)) throw protocolError();
  const diagnosticFields = diagnosticFieldsFor(ok, runtimeDiagnostic);
  const response = {
    protocolVersion: runtimeDiagnostic === undefined ? FORGE_FINALIZER_PROTOCOL_VERSION : FAILURE_DIAGNOSTIC_PROTOCOL_VERSION,
    requestId: assertRequestId(requestId),
    ok,
    code: ok ? null : 'FINALIZATION_FAILED',
    validation: ok ? assertValidation(validation) : null,
    ...diagnosticFields,
    auth: ''
  };
  response.auth = authenticate(token, responseAuthenticationValue(response));
  return response;
}

function verifyForgeFinalizerResponse(message, token, expectedRequestId, expectedRuntime) {
  const isDiagnosticFailure = message?.protocolVersion === FAILURE_DIAGNOSTIC_PROTOCOL_VERSION;
  if (!hasExactKeys(message, ['protocolVersion', 'requestId', 'ok', 'code', 'validation', 'auth', ...(isDiagnosticFailure ? ['runtimeDiagnostic'] : [])]) ||
      (isDiagnosticFailure ? message.ok !== false : message.protocolVersion !== FORGE_FINALIZER_PROTOCOL_VERSION) || typeof message.ok !== 'boolean' ||
      message.code !== (message.ok ? null : 'FINALIZATION_FAILED') ||
      message.requestId !== assertRequestId(expectedRequestId) || typeof message.auth !== 'string' ||
      (message.ok ? message.validation === null : message.validation !== null)) throw protocolError();
  const diagnosticFields = isDiagnosticFailure ? diagnosticFieldsFor(false, message.runtimeDiagnostic) : {};
  if (isDiagnosticFailure && !Object.hasOwn(diagnosticFields, 'runtimeDiagnostic')) throw protocolError();
  const response = {
    protocolVersion: message.protocolVersion,
    requestId: assertRequestId(message.requestId),
    ok: message.ok,
    code: message.code,
    validation: message.ok ? assertValidation(message.validation, expectedRuntime) : null,
    ...diagnosticFields,
    auth: message.auth
  };
  const expected = authenticate(token, responseAuthenticationValue(response));
  if (!authenticatedEqual(response.auth, expected)) throw protocolError();
  return { ok: response.ok, validation: response.validation, ...diagnosticFields };
}

module.exports = {
  FORGE_FINALIZER_PROTOCOL_VERSION,
  FORGE_FINALIZER_TOKEN_ENV,
  createForgeFinalizerRequest,
  verifyForgeFinalizerRequest,
  createForgeFinalizerResponse,
  verifyForgeFinalizerResponse
};
