const { normalizeRuntimeDiagnostic } = require('./runtime-diagnostic.cjs');
const crypto = require('node:crypto');
const path = require('node:path');

const MANAGED_RUNTIME_WORKER_PROTOCOL_VERSION = 1;
const MANAGED_RUNTIME_PREPARE_OPERATION = 'prepare-managed-server-runtime';
const MANAGED_RUNTIME_VERIFY_OPERATION = 'verify-managed-server-runtime';
const MANAGED_RUNTIME_WORKER_TOKEN_ENV = 'MINECRAFT_CORE_MANAGED_RUNTIME_WORKER_TOKEN';
const MAX_MANAGED_RUNTIME_REQUEST_BYTES = 64 * 1024;
const MAX_MANAGED_RUNTIME_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_ARTIFACTS = 10000;
const MAX_RUNTIME_BYTES = 1024 * 1024 * 1024;
const SAFE_TOKEN = /^[a-f0-9]{64}$/u;
const SAFE_REQUEST_ID = /^[a-f0-9]{32}$/u;
const SAFE_MINECRAFT_VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/u;
const SAFE_LOADER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const SAFE_DIGEST_256 = /^[a-f0-9]{64}$/u;
const SAFE_DIGEST_512 = /^[a-f0-9]{128}$/u;
const LOADER_FAMILIES = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);
const OPERATIONS = new Set([MANAGED_RUNTIME_PREPARE_OPERATION, MANAGED_RUNTIME_VERIFY_OPERATION]);
const PREPARE_FAILURE_CODES = new Set([
  'RUNTIME_INCOMPLETE',
  'LOADER_VERSION_UNAVAILABLE',
  'LOADER_VERSION_REQUIRED',
  'UNSUPPORTED_LOADER'
]);
const VERIFY_FAILURE_CODES = new Set(['RUNTIME_INCOMPLETE', 'UNSUPPORTED_LOADER']);

// Requests and successes retain v1; only diagnostic-bearing failures use v2.
const FAILURE_DIAGNOSTIC_PROTOCOL_VERSION = 2;
function diagnosticFieldsFor(ok, value) {
  if (value === undefined) return {};
  if (ok !== false) throw protocolError();
  try { return { runtimeDiagnostic: normalizeRuntimeDiagnostic(value) }; }
  catch { throw protocolError(); }
}

function protocolError() {
  const error = new Error('The managed runtime worker protocol is invalid.');
  error.code = 'MANAGED_RUNTIME_WORKER_PROTOCOL';
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

function assertSerializedBound(value, maximumBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw protocolError();
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw protocolError();
  }
}

function assertToken(token) {
  if (typeof token !== 'string' || !SAFE_TOKEN.test(token)) throw protocolError();
  return token;
}

function assertRequestId(requestId) {
  if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) throw protocolError();
  return requestId;
}

function assertOperation(operation) {
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) throw protocolError();
  return operation;
}

function hasControlCharacters(value) {
  return [...String(value)].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function assertCanonicalAbsolutePath(value) {
  if (typeof value !== 'string' || value.length < 1 || hasControlCharacters(value) ||
      Buffer.byteLength(value, 'utf8') > 32767 || !path.isAbsolute(value) ||
      path.normalize(value) !== value || path.resolve(value) !== value) {
    throw protocolError();
  }
  return value;
}

function assertRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 2048 ||
      hasControlCharacters(value) || value.includes('\\') || value.includes(':') ||
      value.startsWith('/') || value.split('/').some(segment => !segment || segment === '.' || segment === '..' ||
        /[. ]$/u.test(segment))) {
    throw protocolError();
  }
  return value;
}

function assertBoundedMetadataString(value, maximumBytes) {
  if (typeof value !== 'string' || value.length < 1 || hasControlCharacters(value) ||
      value !== value.trim() || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw protocolError();
  }
  return value;
}

function assertHttpsRepository(value) {
  value = assertBoundedMetadataString(value, 2048);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw protocolError();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.toString() !== value) throw protocolError();
  return value;
}

function assertRuntime(runtime) {
  if (!hasExactKeys(runtime, [
    'minecraftVersion',
    'loaderFamily',
    'loaderVersion',
    'javaMajor',
    'os',
    'architecture'
  ]) || typeof runtime.minecraftVersion !== 'string' || !SAFE_MINECRAFT_VERSION.test(runtime.minecraftVersion) ||
      !LOADER_FAMILIES.has(runtime.loaderFamily) || typeof runtime.loaderVersion !== 'string' ||
      !SAFE_LOADER_VERSION.test(runtime.loaderVersion) || !Number.isSafeInteger(runtime.javaMajor) ||
      runtime.javaMajor < 8 || runtime.javaMajor > 99 || runtime.os !== 'win32' ||
      runtime.architecture !== 'x64') {
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

function assertPayload(operation, payload) {
  if (operation === MANAGED_RUNTIME_PREPARE_OPERATION) {
    if (!hasExactKeys(payload, ['targetPath', 'runtime', 'javaPath'])) throw protocolError();
    return {
      targetPath: assertCanonicalAbsolutePath(payload.targetPath),
      runtime: assertRuntime(payload.runtime),
      javaPath: assertCanonicalAbsolutePath(payload.javaPath)
    };
  }
  if (!hasExactKeys(payload, ['targetPath', 'runtime'])) throw protocolError();
  return {
    targetPath: assertCanonicalAbsolutePath(payload.targetPath),
    runtime: assertRuntime(payload.runtime)
  };
}

function quiltCoordinatePath(coordinate) {
  const parts = coordinate.split(':');
  if (parts.length !== 3) throw protocolError();
  const [group, artifact, version] = parts;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,191}$/u.test(group) ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(artifact) ||
      !SAFE_LOADER_VERSION.test(version) || group.split('.').some(segment => !segment)) throw protocolError();
  return `libraries/${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
}

function assertLoader(loader, runtime) {
  const expectedFamily = runtime.loaderFamily;
  if (!isPlainObject(loader) || loader.family !== expectedFamily) throw protocolError();
  if (expectedFamily === 'vanilla') {
    if (!hasExactKeys(loader, ['family', 'serverJar'])) throw protocolError();
    const serverJar = assertRelativePath(loader.serverJar);
    if (serverJar !== 'server.jar') throw protocolError();
    return { family: 'vanilla', serverJar };
  }
  if (expectedFamily === 'fabric' || expectedFamily === 'quilt') {
    if (expectedFamily === 'quilt') {
      if (!hasExactKeys(loader, ['family', 'launcherJar', 'properties', 'libraries']) ||
          !Array.isArray(loader.libraries) || loader.libraries.length < 1 || loader.libraries.length > 4096) {
        throw protocolError();
      }
      const identities = new Set();
      const libraries = loader.libraries.map(library => {
        if (!hasExactKeys(library, ['coordinate', 'repository', 'relativePath'])) throw protocolError();
        const normalized = {
          coordinate: assertBoundedMetadataString(library.coordinate, 384),
          repository: assertHttpsRepository(library.repository),
          relativePath: assertRelativePath(library.relativePath)
        };
        if (!new Set([
          'https://maven.quiltmc.org/repository/release/',
          'https://maven.fabricmc.net/'
        ]).has(normalized.repository) || normalized.relativePath !== quiltCoordinatePath(normalized.coordinate)) {
          throw protocolError();
        }
        const identity = normalized.relativePath.normalize('NFC').toLowerCase();
        if (identities.has(identity)) throw protocolError();
        identities.add(identity);
        return normalized;
      });
      const launcherJar = assertRelativePath(loader.launcherJar);
      const properties = assertRelativePath(loader.properties);
      if (launcherJar !== 'quilt-server-launch.jar' || properties !== 'quilt-server-launcher.properties') {
        throw protocolError();
      }
      return {
        family: 'quilt',
        launcherJar,
        properties,
        libraries
      };
    }
    if (!hasExactKeys(loader, ['family', 'launcherJar'])) throw protocolError();
    const launcherJar = assertRelativePath(loader.launcherJar);
    if (launcherJar !== 'fabric-server-launch.jar') throw protocolError();
    return { family: expectedFamily, launcherJar };
  }
  if (expectedFamily === 'neoforge') {
    if (!hasExactKeys(loader, ['family', 'argsFile', 'universalJar'])) throw protocolError();
    const argsFile = assertRelativePath(loader.argsFile);
    const universalJar = assertRelativePath(loader.universalJar);
    const root = `libraries/net/neoforged/neoforge/${runtime.loaderVersion}`;
    if (argsFile !== `${root}/win_args.txt` ||
        universalJar !== `${root}/neoforge-${runtime.loaderVersion}-universal.jar`) throw protocolError();
    return {
      family: 'neoforge',
      argsFile,
      universalJar
    };
  }
  if (expectedFamily !== 'forge') throw protocolError();
  const artifactVersion = `${runtime.minecraftVersion}-${runtime.loaderVersion}`;
  if (hasExactKeys(loader, ['family', 'argsFile'])) {
    const argsFile = assertRelativePath(loader.argsFile);
    if (argsFile !== `libraries/net/minecraftforge/forge/${artifactVersion}/win_args.txt`) throw protocolError();
    return { family: 'forge', argsFile };
  }
  if (!hasExactKeys(loader, ['family', 'launchJar', 'serverJar', 'libraries']) ||
      !Array.isArray(loader.libraries) || loader.libraries.length < 1 ||
      loader.libraries.length > MAX_RUNTIME_ARTIFACTS) {
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

function assertPreparationResult(result, expectedRuntime) {
  if (!hasExactKeys(result, ['valid', 'runtime']) || result.valid !== true) throw protocolError();
  const runtime = assertRuntime(result.runtime);
  if (expectedRuntime && !runtimeEquals(runtime, assertRuntime(expectedRuntime))) throw protocolError();
  return { valid: true, runtime };
}

function assertValidationResult(result, expectedRuntime) {
  if (!hasExactKeys(result, ['valid', 'runtime', 'loader', 'artifacts']) || result.valid !== true ||
      !Array.isArray(result.artifacts) || result.artifacts.length < 1 ||
      result.artifacts.length > MAX_RUNTIME_ARTIFACTS) {
    throw protocolError();
  }
  const runtime = assertRuntime(result.runtime);
  if (expectedRuntime && !runtimeEquals(runtime, assertRuntime(expectedRuntime))) throw protocolError();
  const loader = assertLoader(result.loader, runtime);
  const identities = new Set();
  let measuredBytes = 0;
  const artifacts = result.artifacts.map(artifact => {
    if (!hasExactKeys(artifact, ['relativePath', 'size', 'sha256', 'sha512']) ||
        !Number.isSafeInteger(artifact.size) || artifact.size < 0 ||
        typeof artifact.sha256 !== 'string' || !SAFE_DIGEST_256.test(artifact.sha256) ||
        typeof artifact.sha512 !== 'string' || !SAFE_DIGEST_512.test(artifact.sha512)) {
      throw protocolError();
    }
    const relativePath = assertRelativePath(artifact.relativePath);
    const identity = relativePath.normalize('NFC').toLowerCase();
    if (identities.has(identity)) throw protocolError();
    identities.add(identity);
    measuredBytes += artifact.size;
    if (!Number.isSafeInteger(measuredBytes) || measuredBytes > MAX_RUNTIME_BYTES) throw protocolError();
    return {
      relativePath,
      size: artifact.size,
      sha256: artifact.sha256,
      sha512: artifact.sha512
    };
  });
  const requiredPaths = runtime.loaderFamily === 'vanilla'
    ? [loader.serverJar]
    : runtime.loaderFamily === 'fabric'
      ? [loader.launcherJar, 'server.jar']
      : runtime.loaderFamily === 'forge'
        ? (loader.argsFile ? [loader.argsFile] : [loader.launchJar, loader.serverJar, ...loader.libraries])
        : runtime.loaderFamily === 'neoforge'
          ? [loader.argsFile, loader.universalJar, 'server.jar', 'user_jvm_args.txt']
          : [loader.launcherJar, loader.properties, 'server.jar', ...loader.libraries.map(item => item.relativePath)];
  if (requiredPaths.some(value => !identities.has(value.normalize('NFC').toLowerCase()))) throw protocolError();
  return {
    valid: true,
    runtime,
    loader,
    artifacts
  };
}

function assertSuccessResult(operation, result, expectedRuntime) {
  return operation === MANAGED_RUNTIME_PREPARE_OPERATION
    ? assertPreparationResult(result, expectedRuntime)
    : assertValidationResult(result, expectedRuntime);
}

function assertFailureCode(operation, code) {
  const allowed = operation === MANAGED_RUNTIME_PREPARE_OPERATION ? PREPARE_FAILURE_CODES : VERIFY_FAILURE_CODES;
  if (typeof code !== 'string' || !allowed.has(code)) throw protocolError();
  return code;
}

function authenticate(token, value) {
  return crypto.createHmac('sha256', assertToken(token)).update(value, 'utf8').digest('hex');
}

function authenticatedEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' ||
      !SAFE_TOKEN.test(left) || !SAFE_TOKEN.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requestAuthenticationValue(request) {
  return JSON.stringify([
    request.protocolVersion,
    request.operation,
    request.requestId,
    request.payload
  ]);
}

function responseAuthenticationValue(response) {
  const fields = [
    response.protocolVersion,
    response.operation,
    response.requestId,
    response.ok,
    response.code,
    response.result
  ];
  if (response.protocolVersion === FAILURE_DIAGNOSTIC_PROTOCOL_VERSION) fields.push(response.runtimeDiagnostic);
  return JSON.stringify(fields);
}

function createManagedRuntimeRequest({ token, requestId, operation, payload } = {}) {
  const request = {
    protocolVersion: MANAGED_RUNTIME_WORKER_PROTOCOL_VERSION,
    operation: assertOperation(operation),
    requestId: assertRequestId(requestId),
    payload: null,
    auth: ''
  };
  request.payload = assertPayload(request.operation, payload);
  request.auth = authenticate(token, requestAuthenticationValue(request));
  assertSerializedBound(request, MAX_MANAGED_RUNTIME_REQUEST_BYTES);
  return request;
}

function verifyManagedRuntimeRequest(message, token) {
  if (!hasExactKeys(message, ['protocolVersion', 'operation', 'requestId', 'payload', 'auth']) ||
      message.protocolVersion !== MANAGED_RUNTIME_WORKER_PROTOCOL_VERSION || typeof message.auth !== 'string') {
    throw protocolError();
  }
  const request = {
    protocolVersion: message.protocolVersion,
    operation: assertOperation(message.operation),
    requestId: assertRequestId(message.requestId),
    payload: null,
    auth: message.auth
  };
  request.payload = assertPayload(request.operation, message.payload);
  assertSerializedBound(request, MAX_MANAGED_RUNTIME_REQUEST_BYTES);
  const expected = authenticate(token, requestAuthenticationValue(request));
  if (!authenticatedEqual(request.auth, expected)) throw protocolError();
  return { requestId: request.requestId, operation: request.operation, payload: request.payload };
}

function createManagedRuntimeResponse({ token, requestId, operation, ok, code = null, result = null, runtimeDiagnostic } = {}) {
  operation = assertOperation(operation);
  if (typeof ok !== 'boolean') throw protocolError();
  const normalizedCode = ok ? null : assertFailureCode(operation, code);
  if ((ok && code !== null && code !== undefined) || (!ok && result !== null && result !== undefined)) {
    throw protocolError();
  }
  const diagnosticFields = diagnosticFieldsFor(ok, runtimeDiagnostic);
  const response = {
    protocolVersion: runtimeDiagnostic === undefined ? MANAGED_RUNTIME_WORKER_PROTOCOL_VERSION : FAILURE_DIAGNOSTIC_PROTOCOL_VERSION,
    operation,
    requestId: assertRequestId(requestId),
    ok,
    code: normalizedCode,
    result: ok ? assertSuccessResult(operation, result) : null,
    ...diagnosticFields,
    auth: ''
  };
  response.auth = authenticate(token, responseAuthenticationValue(response));
  assertSerializedBound(response, MAX_MANAGED_RUNTIME_RESPONSE_BYTES);
  return response;
}

function verifyManagedRuntimeResponse(message, token, expectedRequestId, expectedOperation, expectedRuntime) {
  const isDiagnosticFailure = message?.protocolVersion === FAILURE_DIAGNOSTIC_PROTOCOL_VERSION;
  if (!hasExactKeys(message, [
    'protocolVersion', 'operation', 'requestId', 'ok', 'code', 'result', 'auth',
    ...(isDiagnosticFailure ? ['runtimeDiagnostic'] : [])
  ]) || (isDiagnosticFailure ? message.ok !== false : message.protocolVersion !== MANAGED_RUNTIME_WORKER_PROTOCOL_VERSION) || typeof message.ok !== 'boolean' ||
      typeof message.auth !== 'string') {
    throw protocolError();
  }
  const operation = assertOperation(message.operation);
  if (operation !== assertOperation(expectedOperation) || message.requestId !== assertRequestId(expectedRequestId)) {
    throw protocolError();
  }
  if ((message.ok && message.code !== null) || (!message.ok && message.result !== null)) throw protocolError();
  const diagnosticFields = isDiagnosticFailure ? diagnosticFieldsFor(false, message.runtimeDiagnostic) : {};
  if (isDiagnosticFailure && !Object.hasOwn(diagnosticFields, 'runtimeDiagnostic')) throw protocolError();
  const response = {
    protocolVersion: message.protocolVersion,
    operation,
    requestId: assertRequestId(message.requestId),
    ok: message.ok,
    code: message.ok ? null : assertFailureCode(operation, message.code),
    result: message.ok ? assertSuccessResult(operation, message.result, expectedRuntime) : null,
    ...diagnosticFields,
    auth: message.auth
  };
  assertSerializedBound(response, MAX_MANAGED_RUNTIME_RESPONSE_BYTES);
  const expected = authenticate(token, responseAuthenticationValue(response));
  if (!authenticatedEqual(response.auth, expected)) throw protocolError();
  return { ok: response.ok, code: response.code, result: response.result, ...diagnosticFields };
}

module.exports = {
  MANAGED_RUNTIME_WORKER_PROTOCOL_VERSION,
  MANAGED_RUNTIME_PREPARE_OPERATION,
  MANAGED_RUNTIME_VERIFY_OPERATION,
  MANAGED_RUNTIME_WORKER_TOKEN_ENV,
  MAX_MANAGED_RUNTIME_REQUEST_BYTES,
  MAX_MANAGED_RUNTIME_RESPONSE_BYTES,
  createManagedRuntimeRequest,
  verifyManagedRuntimeRequest,
  createManagedRuntimeResponse,
  verifyManagedRuntimeResponse
};
