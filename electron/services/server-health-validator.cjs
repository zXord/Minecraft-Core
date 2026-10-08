const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('./modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('./modpacks/contracts.cjs');
const { pingMinecraftStatus } = require('./minecraft-status-ping.cjs');
const {
  MAX_SERVER_PROPERTIES_BYTES,
  MAX_SERVER_HEALTH_TIMEOUT_MS,
  SERVER_HEALTH_PROBE_TIMEOUT_MS
} = require('./server-health-constants.cjs');
const { ServerJavaManager } = require('./server-java-manager.cjs');
const {
  filesystemFailureDiagnosticFromError,
  normalizeFailureDiagnostic
} = require('./modpack-lifecycle/publication-failure-diagnostic.cjs');
const {
  getServerMutationCoordinator,
  runWithServerMutationLease
} = require('./server-mutation-context.cjs');
const { sharedServerProcessRunner } = require('./server-process-runner.cjs');
const { runManagedRuntimeVerificationWorker } = require('./managed-runtime-worker-client.cjs');
const {
  isAppIssuedForgeCandidateHealthAuthorization
} = require('./forge-candidate-health-authorization.cjs');
const {
  LOOPBACK_SERVER_IP,
  applyServerNetworkProperties,
  isNetworkAccess,
  overlayServerProperties,
  readEffectiveServerProperty
} = require('../utils/server-network-properties.cjs');

const CANDIDATE_KEYS = new Set([
  'candidatePath', 'jobId', 'maxRam', 'mutationLease', 'runtime', 'signal', 'timeoutMs',
  'forgeCandidateHealthAuthorization'
]);
const LIVE_KEYS = new Set([
  'captureBootDiagnostic', 'instanceId', 'jobId', 'keepRunning', 'maxRam', 'mutationLease', 'networkAccess', 'port', 'runtime',
  'serverPath', 'signal', 'timeoutMs'
]);
const DEPENDENCY_KEYS = new Set([
  'chooseLoopbackPort', 'clock', 'coordinator', 'createNonce', 'fileSystem', 'pingStatus',
  'processRunner', 'resolveJavaPath', 'runWithLease', 'sleep', 'verifyRuntime'
]);
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;
const FORCED_SHUTDOWN_TIMEOUT_MS = 5_000;
const retryableCandidateFailures = new WeakSet();
const candidateBootDiagnosticAttempts = new WeakMap();
const unprovenHealthProcesses = new WeakSet();
const MAX_CANDIDATE_DIAGNOSTIC_BYTES = 32 * 1024;
const MAX_CANDIDATE_DIAGNOSTIC_ENTRIES = 64;
const MAX_CANDIDATE_DIAGNOSTIC_LINE_BYTES = 2 * 1024;

function invalidRequest(cause) {
  return new ModpackError('INVALID_REQUEST', 'Server health request is invalid', { cause });
}

function healthFailure(cause) {
  if (cause instanceof ModpackError && cause.code === 'HEALTH_CHECK_FAILED') return cause;
  return new ModpackError('HEALTH_CHECK_FAILED', 'Server health validation failed', { cause });
}

function markUnprovenHealthProcess(error) {
  if ((typeof error === 'object' || typeof error === 'function') && error !== null) {
    unprovenHealthProcesses.add(error);
  }
  return error;
}

function isUnprovenHealthProcessError(error) {
  const pending = [error];
  const visited = new Set();
  while (pending.length > 0 && visited.size < 24) {
    const current = pending.shift();
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null || visited.has(current)) continue;
    visited.add(current);
    if (unprovenHealthProcesses.has(current)) return true;
    try {
      const cause = Object.getOwnPropertyDescriptor(current, 'cause');
      if (cause && Object.hasOwn(cause, 'value')) pending.push(cause.value);
      const errors = Object.getOwnPropertyDescriptor(current, 'errors');
      if (errors && Object.hasOwn(errors, 'value') && Array.isArray(errors.value)) pending.push(...errors.value);
    } catch {
      // Opaque errors cannot establish that a retained process was stopped.
    }
  }
  return false;
}

function cancelled(cause) {
  return new ModpackError('CANCELLED', 'Server health validation was cancelled', { cause });
}

function assertExactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidRequest();
  }
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 &&
    (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function isAbortSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function';
}

function normalizeRuntime(value) {
  try {
    return normalizeRuntimeTuple(value);
  } catch (error) {
    throw invalidRequest(error);
  }
}

function normalizeCommon(value, allowed, pathField) {
  assertExactKeys(value, allowed);
  if (!isIdentifier(value.jobId) || !isAbsolutePath(value[pathField])) throw invalidRequest();
  if (typeof value.maxRam !== 'number' || !Number.isFinite(value.maxRam) || value.maxRam <= 0 || value.maxRam > 1024) {
    throw invalidRequest();
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 ||
      value.timeoutMs > MAX_SERVER_HEALTH_TIMEOUT_MS) throw invalidRequest();
  if (value.signal !== undefined && !isAbortSignal(value.signal)) throw invalidRequest();
  const mutationLease = value.mutationLease;
  if (!mutationLease || typeof mutationLease !== 'object' || mutationLease.kind !== 'mutation' ||
      !isIdentifier(mutationLease.instanceId)) {
    throw invalidRequest();
  }
  return {
    ...value,
    mutationLease,
    runtime: normalizeRuntime(value.runtime),
    signal: value.signal
  };
}

function normalizeCandidate(value) {
  const result = normalizeCommon(value, CANDIDATE_KEYS, 'candidatePath');
  if (result.forgeCandidateHealthAuthorization !== undefined &&
      !isAppIssuedForgeCandidateHealthAuthorization(result.forgeCandidateHealthAuthorization, {
        candidatePath: result.candidatePath,
        instanceId: result.mutationLease.instanceId,
        jobId: result.jobId,
        runtime: result.runtime
      })) throw invalidRequest();
  return Object.freeze(result);
}

function normalizeLive(value) {
  const result = normalizeCommon(value, LIVE_KEYS, 'serverPath');
  if (!isIdentifier(result.instanceId) || result.instanceId !== result.mutationLease.instanceId) throw invalidRequest();
  if (!Number.isSafeInteger(result.port) || result.port < 1 || result.port > 65535) throw invalidRequest();
  if (typeof result.keepRunning !== 'boolean') throw invalidRequest();
  const networkAccess = result.networkAccess ?? 'pack-default';
  if (!isNetworkAccess(networkAccess)) throw invalidRequest();
  if (result.captureBootDiagnostic !== undefined && typeof result.captureBootDiagnostic !== 'boolean') throw invalidRequest();
  return Object.freeze({ ...result, networkAccess });
}

function samePropertiesFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink);
}

function readFileBoundedDefault(filePath, { maxBytes }) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  let opened;
  let bytes;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n ||
        opened.size > BigInt(maxBytes)) throw healthFailure();
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) throw healthFailure();
      offset += count;
    }
    const afterHandle = fs.fstatSync(descriptor, { bigint: true });
    if (!samePropertiesFile(opened, afterHandle)) throw healthFailure();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const afterPath = fs.lstatSync(filePath, { bigint: true });
  if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterPath.nlink !== 1n ||
      !samePropertiesFile(opened, afterPath)) throw healthFailure();
  return bytes;
}

function defaultFileSystem() {
  return Object.freeze({
    exists: fs.existsSync,
    readFileBounded: readFileBoundedDefault,
    removeFile: filePath => fs.rmSync(filePath, { force: true }),
    writeFile: fs.writeFileSync
  });
}

function validateFileSystem(value) {
  const candidate = value || defaultFileSystem();
  if (!candidate || typeof candidate !== 'object' ||
      ['exists', 'readFileBounded', 'removeFile', 'writeFile'].some(method => typeof candidate[method] !== 'function')) {
    throw invalidRequest();
  }
  return candidate;
}

function readServerProperties(fileSystem, filePath) {
  const value = fileSystem.readFileBounded(filePath, { maxBytes: MAX_SERVER_PROPERTIES_BYTES });
  const bytes = Buffer.from(value);
  if (bytes.length > MAX_SERVER_PROPERTIES_BYTES) throw healthFailure();
  return bytes;
}

async function chooseLoopbackPortDefault({ signal } = {}) {
  if (signal?.aborted) throw cancelled();
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      server.removeAllListeners();
      if (error) reject(error);
      else resolve(port);
    };
    const onAbort = () => {
      server.close(() => finish(cancelled()));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    server.once('error', error => finish(healthFailure(error)));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(error => {
        if (error || !Number.isSafeInteger(port)) finish(healthFailure(error));
        else finish(null, port);
      });
    });
  });
}

function sleepDefault(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish(cancelled());
    function finish(error) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function resolveJavaPathDefault({ serverPath, runtime, signal }) {
  if (signal?.aborted) throw cancelled();
  const manager = new ServerJavaManager(serverPath);
  const requirements = manager.getJavaValidationStatus(runtime.javaMajor);
  if (signal?.aborted) throw cancelled();
  if (!requirements?.isInstalled) {
    throw healthFailure(new Error('The required Java runtime was not prepared before health validation'));
  }
  if (typeof requirements.javaPath !== 'string' || !isAbsolutePath(requirements.javaPath)) {
    throw healthFailure();
  }
  return requirements.javaPath;
}

function operationId(kind, jobId) {
  return `health-${crypto.createHash('sha256').update(`${kind}:${jobId}`).digest('hex').slice(0, 32)}`;
}

function createHealthNonce(createNonce) {
  const generated = String(createNonce());
  const safeNonce = /^[A-Za-z0-9._:-]{1,96}$/.test(generated)
    ? generated
    : crypto.createHash('sha256').update(generated).digest('hex').slice(0, 32);
  return `minecraft-core-health:${safeNonce}`;
}

function propertiesSnapshot(fileSystem, serverPath) {
  const filePath = path.join(serverPath, 'server.properties');
  if (!fileSystem.exists(filePath)) return { bytes: null, existed: false, filePath, sha256: null };
  const bytes = readServerProperties(fileSystem, filePath);
  return {
    bytes,
    existed: true,
    filePath,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

function writeCandidateOverlay(fileSystem, snapshot, startLease, port, motdNonce) {
  startLease.assertOwnedPath(path.dirname(snapshot.filePath));
  startLease.markDirty();
  const bytes = overlayServerProperties(snapshot.bytes, {
    'broadcast-rcon-to-ops': 'false',
    'enable-query': 'false',
    'enable-rcon': 'false',
    'management-server-enabled': 'false',
    motd: motdNonce,
    'query.port': '0',
    'rcon.port': '0',
    'server-ip': LOOPBACK_SERVER_IP,
    'server-port': String(port)
  });
  fileSystem.writeFile(snapshot.filePath, bytes);
}

function writeCanonicalNetworkOverlay(fileSystem, snapshot, startLease, port, networkAccess) {
  startLease.markDirty();
  fileSystem.writeFile(snapshot.filePath, applyServerNetworkProperties(snapshot.bytes, { port, networkAccess }));
}

function restoreCandidateProperties(fileSystem, snapshot, startLease) {
  if (snapshot.existed) {
    startLease.markDirty();
    fileSystem.writeFile(snapshot.filePath, snapshot.bytes);
  } else if (fileSystem.exists(snapshot.filePath)) {
    startLease.markDirty();
    fileSystem.removeFile(snapshot.filePath);
  }
  verifyProperties(fileSystem, snapshot);
}

function verifyProperties(fileSystem, snapshot) {
  const exists = fileSystem.exists(snapshot.filePath);
  if (exists !== snapshot.existed) throw healthFailure();
  if (snapshot.existed) {
    const restored = readServerProperties(fileSystem, snapshot.filePath);
    if (!restored.equals(snapshot.bytes)) throw healthFailure();
  }
}

function readConfiguredServerIp(bytes) {
  return (readEffectiveServerProperty(bytes, 'server-ip') || '').trim().replace(/^\[|\]$/g, '');
}

function liveEndpoint(snapshot, port) {
  const configured = readConfiguredServerIp(snapshot.bytes);
  if (!configured || configured === '0.0.0.0') {
    return Object.freeze({ allowWildcard: true, host: '127.0.0.1', port });
  }
  if (configured === '::') {
    return Object.freeze({ allowWildcard: true, host: '::1', port });
  }
  return Object.freeze({ allowWildcard: false, host: configured.toLowerCase(), port });
}

function safeRelease(lease) {
  try { lease.release(); } catch {
    // The coordinator retains its own fail-closed revision state on release errors.
  }
}

async function stopValidatedHandoff(handoff) {
  const handle = handoff?.processHandle;
  if (!handle || typeof handle.stopFully !== 'function' || typeof handle.isLive !== 'function' ||
      !handle.closed || typeof handle.closed.then !== 'function') {
    throw markUnprovenHealthProcess(healthFailure());
  }
  let shutdown;
  try {
    shutdown = await handle.stopFully({
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      killTimeoutMs: FORCED_SHUTDOWN_TIMEOUT_MS
    });
  } catch (error) {
    throw markUnprovenHealthProcess(healthFailure(error));
  }
  let live;
  try {
    live = handle.isLive();
  } catch (error) {
    throw markUnprovenHealthProcess(healthFailure(error));
  }
  if (shutdown?.closed !== true || live !== false) {
    throw markUnprovenHealthProcess(healthFailure());
  }
  return shutdown;
}

function isCleanShutdown(value) {
  return Boolean(value && value.clean === true && value.closed === true && value.exitCode === 0 &&
    value.forced === false && value.signal === null);
}

function isClosedEvidence(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
    (value.signal === null || (typeof value.signal === 'string' && value.signal.length > 0)));
}

function ownDataValue(value, key) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedLine(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const prefix = value.slice(0, MAX_CANDIDATE_DIAGNOSTIC_LINE_BYTES);
  const bytes = Buffer.from(prefix, 'utf8');
  return bytes.length <= MAX_CANDIDATE_DIAGNOSTIC_LINE_BYTES
    ? prefix
    : bytes.subarray(0, MAX_CANDIDATE_DIAGNOSTIC_LINE_BYTES).toString('utf8');
}

function createCandidateDiagnosticRing() {
  const entries = [];
  let byteLength = 0;
  return Object.freeze({
    push(value) {
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const lineDescriptor = descriptors.line;
        const streamDescriptor = descriptors.stream;
        if (!lineDescriptor || !Object.hasOwn(lineDescriptor, 'value') ||
            (streamDescriptor && !Object.hasOwn(streamDescriptor, 'value'))) return;
        const line = boundedLine(lineDescriptor.value);
        const stream = streamDescriptor?.value;
        if (line === null || (stream !== undefined && !['stdout', 'stderr'].includes(stream))) return;
        const entryBytes = Buffer.byteLength(line, 'utf8');
        entries.push(line);
        byteLength += entryBytes;
        while (entries.length > MAX_CANDIDATE_DIAGNOSTIC_ENTRIES || byteLength > MAX_CANDIDATE_DIAGNOSTIC_BYTES) {
          byteLength -= Buffer.byteLength(entries.shift(), 'utf8');
        }
      } catch {
        // Diagnostic evidence is advisory and must never alter candidate-health control flow.
      }
    },
    text() {
      return entries.join('\n');
    }
  });
}

function errorDiagnosticText(error) {
  const values = [];
  const visited = new Set();
  let current = error;
  for (let depth = 0; depth < 8 && current &&
      (typeof current === 'object' || typeof current === 'function') && !visited.has(current); depth += 1) {
    visited.add(current);
    for (const key of ['code', 'name', 'message']) {
      const value = ownDataValue(current, key);
      if (typeof value === 'string' && value.length > 0) values.push(value.slice(0, 2048));
    }
    current = ownDataValue(current, 'cause');
  }
  return values.join('\n');
}

function candidateBootCategory({ error, lines, processExited, timedOut }) {
  const evidence = `${lines}\n${errorDiagnosticText(error)}`.toLocaleLowerCase('en-US');
  if (/outofmemoryerror|java heap space|gc overhead limit exceeded|unable to create (?:new )?native thread|insufficient memory|could not reserve enough space(?: for .+)? object heap/u.test(evidence)) {
    return 'out-of-memory';
  }
  if (/unsupportedclassversionerror|class file version|compiled by a more recent (?:version|java runtime)|only recognizes class file versions|requires java|incompatible java runtime/u.test(evidence)) {
    return 'runtime-java-mismatch';
  }
  if (/eaddrinuse|bindexception|address already in use|failed to bind to port|perhaps a server is already running/u.test(evidence)) {
    return 'port-conflict';
  }
  if (/modloadingexception|modresolutionexception|loadingfailedexception|failed to load (?:a )?mod|errors? during mod loading|mixin(?: apply)? failed|mixintransformererror|could not execute entrypoint|incompatible mod set/u.test(evidence)) {
    return 'mod-loading-failure';
  }
  if (timedOut || /deadline exceeded|readiness timeout|timed out waiting for (?:server )?readiness/u.test(evidence)) {
    return 'readiness-timeout';
  }
  if (processExited) return 'process-exited';
  return 'health-failure';
}

function attachCandidateBootDiagnostic(error, { attempt, boundary, lines, processExited, timedOut }) {
  let target = error instanceof ModpackError ? error : healthFailure(error);
  if (filesystemFailureDiagnosticFromError(target)) return target;
  const diagnostic = normalizeFailureDiagnostic({
    stage: 'candidate-boot',
    boundary,
    category: candidateBootCategory({ error, lines, processExited, timedOut })
  });
  if (!diagnostic) return target;
  const existing = Object.getOwnPropertyDescriptor(target, 'candidateBootDiagnostic');
  const hardenedExisting = existing && Object.hasOwn(existing, 'value') && existing.configurable === false &&
    existing.enumerable === false && existing.writable === false &&
    normalizeFailureDiagnostic(existing.value)?.stage === 'candidate-boot';
  if (hardenedExisting && candidateBootDiagnosticAttempts.get(target) === attempt) return target;
  if (!Object.isExtensible(target) || existing) {
    target = new ModpackError(target.code, target.safeMessage, {
      cause: target,
      details: target.details,
      retryable: target.retryable
    });
  }
  Object.defineProperty(target, 'candidateBootDiagnostic', {
    configurable: false,
    enumerable: false,
    value: diagnostic,
    writable: false
  });
  candidateBootDiagnosticAttempts.set(target, attempt);
  return target;
}

class ServerHealthValidator {
  constructor(dependencies = {}) {
    assertExactKeys(dependencies, DEPENDENCY_KEYS);
    this.chooseLoopbackPort = dependencies.chooseLoopbackPort || chooseLoopbackPortDefault;
    this.clock = dependencies.clock || Date.now;
    this.coordinator = dependencies.coordinator || getServerMutationCoordinator();
    this.createNonce = dependencies.createNonce || crypto.randomUUID;
    this.fileSystem = validateFileSystem(dependencies.fileSystem);
    this.pingStatus = dependencies.pingStatus || pingMinecraftStatus;
    this.processRunner = dependencies.processRunner || sharedServerProcessRunner;
    this.resolveJavaPath = dependencies.resolveJavaPath || resolveJavaPathDefault;
    this.runWithLease = dependencies.runWithLease || runWithServerMutationLease;
    this.sleep = dependencies.sleep || sleepDefault;
    this.verifyRuntime = dependencies.verifyRuntime || runManagedRuntimeVerificationWorker;
    if (typeof this.chooseLoopbackPort !== 'function' || typeof this.clock !== 'function' ||
        !this.coordinator || typeof this.coordinator.acquireStart !== 'function' || typeof this.createNonce !== 'function' ||
        typeof this.pingStatus !== 'function' || !this.processRunner ||
        typeof this.processRunner.launchServerProcess !== 'function' || typeof this.resolveJavaPath !== 'function' ||
        typeof this.runWithLease !== 'function' || typeof this.sleep !== 'function' ||
        typeof this.verifyRuntime !== 'function') {
      throw invalidRequest();
    }
  }

  async validateCandidate(input) {
    let request;
    try { request = normalizeCandidate(input); } catch (error) { throw this._normalizeError(error); }
    const deadline = this.clock() + request.timeoutMs;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const motdNonce = createHealthNonce(this.createNonce);
      let port;
      try {
        this._throwIfCancelled(request.signal);
        this._remaining(deadline);
        port = await this.chooseLoopbackPort({ signal: request.signal });
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw healthFailure();
        this._throwIfCancelled(request.signal);
        const remaining = this._remaining(deadline);
        return await this._validate({
          kind: 'candidate',
          keepRunning: false,
          motdNonce,
          port,
          propertiesMode: 'isolated',
          request: Object.freeze({ ...request, timeoutMs: remaining }),
          serverPath: request.candidatePath
        });
      } catch (error) {
        const normalized = this._normalizeError(error, request.signal);
        if (attempt !== 0 || !retryableCandidateFailures.has(normalized) ||
            request.signal?.aborted || this.clock() >= deadline) throw normalized;
      }
    }
    throw healthFailure();
  }

  async validateLive(input) {
    let request;
    try { request = normalizeLive(input); } catch (error) { throw this._normalizeError(error); }
    if (!request.keepRunning) {
      let port;
      try {
        this._throwIfCancelled(request.signal);
        port = await this.chooseLoopbackPort({ signal: request.signal });
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw healthFailure();
      } catch (error) {
        throw this._normalizeError(error, request.signal);
      }
      return this._validate({
        kind: 'live',
        keepRunning: false,
        motdNonce: createHealthNonce(this.createNonce),
        port,
        propertiesMode: 'isolated',
        request,
        serverPath: request.serverPath
      });
    }
    return this._validate({
      kind: 'live',
      keepRunning: request.keepRunning,
      motdNonce: null,
      port: request.port,
      propertiesMode: 'canonical-network',
      request,
      serverPath: request.serverPath
    });
  }

  async _validate({ kind, keepRunning, motdNonce, port, propertiesMode, request, serverPath }) {
    const startedAt = this.clock();
    const deadline = startedAt + request.timeoutMs;
    const id = operationId(kind, request.jobId);
    let startLease;
    let retainLease = false;
    let pendingPrelaunchWork = null;
    let candidateRetrySafe = false;
    const captureBootDiagnostic = kind === 'candidate' || request.captureBootDiagnostic === true;
    const candidateDiagnosticRing = captureBootDiagnostic ? createCandidateDiagnosticRing() : null;
    const candidateDiagnosticAttempt = captureBootDiagnostic ? Object.freeze({}) : null;
    let candidateBootStarted = false;
    let candidateFailureBoundary = 'health-validation';
    let candidateProcessExited = false;
    let candidateTimedOut = false;
    try {
      this._throwIfCancelled(request.signal);
      startLease = await this.coordinator.acquireStart(
        { instanceId: request.mutationLease.instanceId, serverPath },
        {
          operation: `server-health-${kind}`,
          operationId: id,
          parentMutationLease: request.mutationLease
        }
      );

      return await this.runWithLease(startLease, async () => {
        candidateBootStarted = captureBootDiagnostic;
        const snapshot = propertiesSnapshot(this.fileSystem, serverPath);
        const endpoint = propertiesMode === 'isolated'
          ? Object.freeze({ host: LOOPBACK_SERVER_IP, port })
          : request.networkAccess === 'loopback'
            ? Object.freeze({ host: LOOPBACK_SERVER_IP, port })
            : liveEndpoint(snapshot, port);
        let handle = null;
        let overlayAttempted = false;
        let shutdown = null;
        let verified = null;
        let primaryError = null;
        let unwindError = null;
        let propertiesCleanupError = null;
        let handoff = null;
        let releaseOnCloseArmed = false;
        let launchAttempted = false;
        let propertiesRestored = false;
        let closeObservation = null;
        const closeState = { evidence: null, rejected: false, settled: false };
        const observeClose = () => {
          if (!closeObservation) {
            closeObservation = Promise.resolve(handle.closed).then(
              evidence => {
                closeState.evidence = evidence;
                closeState.settled = true;
              },
              () => {
                closeState.rejected = true;
                closeState.settled = true;
              }
            );
          }
          return closeObservation;
        };
        const retainUntilClosed = () => {
          retainLease = true;
          if (!handle || releaseOnCloseArmed) return;
          releaseOnCloseArmed = true;
          observeClose().then(() => {
            if (closeState.rejected) return;
            try {
              if (isClosedEvidence(closeState.evidence) && handle.isLive() === false) safeRelease(startLease);
            } catch {
              // Invalid close evidence retains the lease fail-closed.
            }
          });
        };
        const ensureStopped = async () => {
          if (!handle || shutdown) return;
          try {
            shutdown = await handle.stopFully({
              gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
              killTimeoutMs: FORCED_SHUTDOWN_TIMEOUT_MS
            });
            if (!shutdown?.closed) {
              retainUntilClosed();
              unwindError = markUnprovenHealthProcess(healthFailure());
            } else {
              let stillLive;
              try { stillLive = handle.isLive(); }
              catch { stillLive = true; }
              if (!isCleanShutdown(shutdown) || stillLive) {
                unwindError = stillLive
                  ? markUnprovenHealthProcess(healthFailure())
                  : healthFailure();
              }
            }
          } catch (error) {
            retainUntilClosed();
            unwindError = markUnprovenHealthProcess(healthFailure(error));
          }
        };

        try {
          if (propertiesMode !== 'none') {
            candidateFailureBoundary = 'properties-overlay';
            overlayAttempted = true;
            if (propertiesMode === 'isolated') {
              writeCandidateOverlay(this.fileSystem, snapshot, startLease, port, motdNonce);
            } else if (propertiesMode === 'canonical-network') {
              writeCanonicalNetworkOverlay(this.fileSystem, snapshot, startLease, port, request.networkAccess);
            } else {
              throw healthFailure();
            }
          }
          this._throwIfCancelled(request.signal);
          candidateFailureBoundary = 'java-resolution';
          const javaPath = await this._resolveJavaWithinDeadline({
            deadline,
            request,
            retainLeaseUntil: settlement => {
              pendingPrelaunchWork = settlement;
            },
            serverPath
          });
          this._throwIfCancelled(request.signal);
          this._remaining(deadline);
          candidateFailureBoundary = 'runtime-verification';
          const runtimeValidation = await this.verifyRuntime({
            targetPath: serverPath,
            runtime: request.runtime,
            signal: request.signal,
            timeoutMs: this._remaining(deadline)
          });
          this._throwIfCancelled(request.signal);
          this._remaining(deadline);
          candidateFailureBoundary = 'process-launch';
          launchAttempted = true;
          handle = this.processRunner.launchServerProcess({
            instanceId: request.mutationLease.instanceId,
            javaPath,
            maxRam: request.maxRam,
            onLine(evidence) { candidateDiagnosticRing?.push(evidence); },
            operationId: id,
            publishEvents: false,
            runtime: request.runtime,
            runtimeValidation,
            serverPath,
            ...(request.forgeCandidateHealthAuthorization
              ? { forgeCandidateHealthAuthorization: request.forgeCandidateHealthAuthorization }
              : {})
          });
          this._assertHandle(handle);
          observeClose();
          startLease.markRunning({ pid: handle.pid });

          candidateFailureBoundary = 'readiness';
          const ready = await handle.waitForReady({
            signal: request.signal,
            timeoutMs: this._remaining(deadline)
          });
          if (!ready || ready.pid !== handle.pid || typeof ready.marker !== 'string' || !handle.isLive()) {
            throw healthFailure();
          }
          candidateFailureBoundary = 'endpoint-verification';
          const pong = await this._waitForIdentity({
            deadline,
            endpoint,
            handle,
            motdNonce,
            signal: request.signal
          });
          verified = { pong, ready };
        } catch (error) {
          candidateTimedOut = this.clock() >= deadline;
          if (handle) {
            try { candidateProcessExited = handle.isLive() === false; }
            catch { candidateProcessExited = false; }
          }
          primaryError = this._normalizeError(error, request.signal);
        } finally {
          if (kind === 'candidate' || !keepRunning || primaryError) await ensureStopped();

          try {
            if (propertiesMode !== 'none' && overlayAttempted) {
              restoreCandidateProperties(this.fileSystem, snapshot, startLease);
            }
            else verifyProperties(this.fileSystem, snapshot);
            propertiesRestored = true;
          } catch (error) {
            propertiesCleanupError = healthFailure(error);
          }
          if (keepRunning && (primaryError || unwindError || propertiesCleanupError)) await ensureStopped();
        }

        if (unwindError && isUnprovenHealthProcessError(unwindError)) {
          primaryError = markUnprovenHealthProcess(primaryError || unwindError);
          candidateFailureBoundary = 'shutdown';
        } else if (!primaryError && unwindError) {
          primaryError = unwindError;
          candidateFailureBoundary = 'shutdown';
        }
        if (!primaryError && propertiesCleanupError) {
          primaryError = propertiesCleanupError;
          candidateFailureBoundary = 'properties-restore';
        }

        if (!primaryError && keepRunning) {
          try {
            if (!handle || !handle.isLive()) throw healthFailure();
            await this._waitForHandoffBoundary({
              closeObservation: observeClose(),
              deadline,
              signal: request.signal
            });
            if (closeState.settled || !handle || !handle.isLive()) throw healthFailure();
          } catch (error) {
            primaryError = this._normalizeError(error, request.signal);
            await ensureStopped();
          }
        }

        if (primaryError) {
          let processFullyUnwound = false;
          if (kind === 'candidate') {
            if (handle && shutdown?.closed === true) {
              try { processFullyUnwound = handle.isLive() === false; }
              catch { processFullyUnwound = false; }
            }
            if (handle && !processFullyUnwound) retainUntilClosed();
          }
          candidateRetrySafe = kind === 'candidate' && launchAttempted && processFullyUnwound &&
            propertiesRestored && !retainLease;
          throw primaryError;
        }
        if (!verified || !handle) throw healthFailure();
        if (keepRunning) {
          retainUntilClosed();
          handoff = Object.freeze({ processHandle: handle, startLease });
        }
        const evidence = deepFreeze({
          elapsedMs: Math.max(0, this.clock() - startedAt),
          endpoint: { host: endpoint.host, port: endpoint.port },
          handedOff: Boolean(handoff),
          kind,
          listenerOwned: true,
          live: true,
          motdNonce,
          operationId: id,
          pid: handle.pid,
          pongMatched: true,
          properties: { existed: snapshot.existed, sha256: snapshot.sha256 },
          readyMarker: verified.ready.marker,
          shutdown: handoff ? null : shutdown
        });
        return Object.freeze({ evidence, handoff });
      });
    } catch (error) {
      let normalized = this._normalizeError(error, request.signal);
      if (captureBootDiagnostic && candidateBootStarted && !['CANCELLED', 'INVALID_REQUEST'].includes(normalized.code)) {
        normalized = attachCandidateBootDiagnostic(normalized, {
          attempt: candidateDiagnosticAttempt,
          boundary: candidateFailureBoundary,
          lines: candidateDiagnosticRing.text(),
          processExited: candidateProcessExited,
          timedOut: candidateTimedOut
        });
      }
      if (candidateRetrySafe && normalized.code === 'HEALTH_CHECK_FAILED') {
        retryableCandidateFailures.add(normalized);
      }
      throw normalized;
    } finally {
      if (startLease && !retainLease) {
        if (pendingPrelaunchWork) {
          retainLease = true;
          Promise.resolve(pendingPrelaunchWork).then(() => safeRelease(startLease));
        } else {
          safeRelease(startLease);
        }
      }
    }
  }

  async _waitForIdentity({ deadline, endpoint, handle, motdNonce, signal }) {
    while (true) {
      this._throwIfCancelled(signal);
      if (!handle.isLive()) throw healthFailure();
      const remaining = this._remaining(deadline);
      const probeTimeoutMs = Math.min(SERVER_HEALTH_PROBE_TIMEOUT_MS, remaining);
      const owned = await handle.ownsEndpoint({
        ...(endpoint.allowWildcard ? { allowWildcard: true } : {}),
        host: endpoint.host,
        port: endpoint.port,
        signal,
        timeoutMs: probeTimeoutMs
      });
      if (owned) {
        if (!handle.isLive()) throw healthFailure();
        try {
          const pong = await this.pingStatus({
            host: endpoint.host,
            port: endpoint.port,
            protocolVersion: -1,
            signal,
            timeoutMs: Math.min(SERVER_HEALTH_PROBE_TIMEOUT_MS, this._remaining(deadline))
          });
          if (handle.isLive() && pong && typeof pong.description === 'string' &&
              (motdNonce === null || pong.description === motdNonce)) {
            return pong;
          }
        } catch (error) {
          const normalized = this._normalizeError(error, signal);
          if (normalized.code === 'CANCELLED') throw normalized;
        }
      }
      const afterAttempt = this._remaining(deadline);
      await this.sleep(Math.min(50, afterAttempt), signal);
    }
  }

  async _resolveJavaWithinDeadline({ deadline, request, retainLeaseUntil, serverPath }) {
    const controller = new AbortController();
    let cancelledByCaller = false;
    let deadlineExpired = false;
    const onCallerAbort = () => {
      cancelledByCaller = true;
      controller.abort();
    };
    if (request.signal) request.signal.addEventListener('abort', onCallerAbort, { once: true });
    const timeoutMs = this._remaining(deadline);
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, timeoutMs);
    const abortResult = new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(cancelledByCaller ? cancelled() : healthFailure());
      }, { once: true });
    });
    let resolutionSettled = false;
    const resolution = Promise.resolve().then(() => this.resolveJavaPath({
      deadlineMs: deadline,
      runtime: request.runtime,
      serverPath,
      signal: controller.signal,
      timeoutMs
    }));
    const settlement = resolution.then(
      () => { resolutionSettled = true; },
      () => { resolutionSettled = true; }
    );
    try {
      return await Promise.race([resolution, abortResult]);
    } catch (error) {
      if (!resolutionSettled && (cancelledByCaller || deadlineExpired)) retainLeaseUntil(settlement);
      if (cancelledByCaller || request.signal?.aborted) throw cancelled(error);
      if (deadlineExpired) throw healthFailure(error);
      throw error;
    } finally {
      clearTimeout(timer);
      if (request.signal) request.signal.removeEventListener('abort', onCallerAbort);
    }
  }

  async _waitForHandoffBoundary({ closeObservation, deadline, signal }) {
    this._throwIfCancelled(signal);
    this._remaining(deadline);
    await Promise.race([
      closeObservation,
      new Promise(resolve => setTimeout(resolve, 0))
    ]);
    this._throwIfCancelled(signal);
    this._remaining(deadline);
  }

  _remaining(deadline) {
    const remaining = deadline - this.clock();
    if (!Number.isFinite(remaining) || remaining <= 0) throw healthFailure();
    return Math.max(1, Math.floor(remaining));
  }

  _throwIfCancelled(signal) {
    if (signal?.aborted) throw cancelled();
  }

  _assertHandle(handle) {
    if (!handle || !Number.isSafeInteger(handle.pid) || handle.pid <= 0 ||
        typeof handle.isLive !== 'function' || typeof handle.ownsEndpoint !== 'function' ||
        typeof handle.stopFully !== 'function' || typeof handle.waitForReady !== 'function' ||
        !handle.closed || typeof handle.closed.then !== 'function') {
      throw healthFailure();
    }
  }

  _normalizeError(error, signal) {
    if (error instanceof ModpackError) return error;
    if (signal?.aborted || error?.code === 'CANCELLED' || error?.name === 'AbortError') return cancelled(error);
    if (error?.code === 'INVALID_REQUEST') return invalidRequest(error);
    return healthFailure(error);
  }
}

module.exports = {
  isUnprovenHealthProcessError,
  markUnprovenHealthProcess,
  ServerHealthValidator,
  stopValidatedHandoff
};
