const { execFile } = require('node:child_process');
const { lookup } = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createClientProcessInspector, validateProcessSnapshot, validIdentity } = require('./client-modpacks/client-process-inspector.cjs');
const { promisify } = require('node:util');
const { spawn } = require('child_process');

const { ModpackError } = require('./modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('./modpacks/contracts.cjs');
const { MAX_SERVER_HEALTH_TIMEOUT_MS } = require('./server-health-constants.cjs');
const { resolveLaunchPlan, resolvePrevalidatedLaunchPlan } = require('./server-launcher.cjs');
const { isAppIssuedManagedRuntimeValidation } = require('./managed-runtime-worker-client.cjs');
const {
  isAppIssuedForgeCandidateHealthAuthorization
} = require('./forge-candidate-health-authorization.cjs');
const defaultEventBus = require('../utils/event-bus.cjs');
const { requestServerProcessSupervision } = require('../watchdog/server-process-supervision.cjs');
const { isServerProcessSupervisionRequired } = require('../watchdog/server-process-supervision-policy.cjs');

const execFileAsync = promisify(execFile);
const MAX_LINE_BYTES = 1024 * 1024;
const LAUNCH_KEYS = new Set([
  'instanceId', 'javaPath', 'maxRam', 'onLine', 'operationId', 'publishEvents', 'runtime', 'runtimeContract',
  'runtimeValidation', 'serverPath', 'supervision', 'forgeCandidateHealthAuthorization'
]);
// 'required': a watchdog fault is fatal and terminates the exact child (lifecycle boots).
// 'best-effort': a watchdog fault is only reported; the server keeps running.
const SUPERVISION_MODES = new Set(['required', 'best-effort']);
const RUNTIME_CONTRACTS = new Set(['managed', 'legacy']);
const RUNTIME_KEYS = new Set(['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture']);
const LEGACY_LOADER_FAMILIES = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);
const DEGRADED_EVENT = 'server-process-supervision-degraded';
const NOT_ACKNOWLEDGED_REASON = 'Server process supervision was not acknowledged';
const LATE_ACK_REASON = 'Watchdog acknowledged after the deadline';
const WATCHDOG_FAILED_REASON = 'Server process watchdog failed';
const MAX_REASON_LENGTH = 512;
const WAIT_KEYS = new Set(['signal', 'timeoutMs']);
const ENDPOINT_KEYS = new Set(['allowWildcard', 'host', 'port', 'signal', 'timeoutMs']);
const STOP_KEYS = new Set(['gracefulTimeoutMs', 'killTimeoutMs']);
const SPAWN_MARKER = '-Dminecraft.core.server.launch=';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const commandHash = value => crypto.createHash('sha256').update(value).digest('hex');

// One directory only: no recursive inspection, argument-file reads, or native helper.
function captureLaunchRoot(directory) {
  const before = fs.lstatSync(directory, { bigint: true });
  const canonicalPath = fs.realpathSync.native(directory);
  const after = fs.lstatSync(directory, { bigint: true });
  const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink() ||
      pathKey(canonicalPath) !== pathKey(directory) || before.ino === 0n || identity(before) !== identity(after)) throw invalidRequest();
  return Object.freeze({ canonicalPath, identity: identity(before) });
}

function frozenRoot(capture, directory) {
  const value = capture(directory);
  if (!value || typeof value.canonicalPath !== 'string' || !path.isAbsolute(value.canonicalPath) ||
      pathKey(value.canonicalPath) !== pathKey(directory) || typeof value.identity !== 'string' ||
      !value.identity || value.identity.length > 1024) throw invalidRequest();
  return Object.freeze({ canonicalPath: pathKey(value.canonicalPath), identity: value.identity });
}

function containsPath(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function singleSpawnMarker(commandLine, nonce) {
  const markers = commandLine.split(/\s/u).map(token => token.replace(/^"|"$/gu, '')).filter(token => token.startsWith(SPAWN_MARKER));
  return markers.length === 1 && markers[0] === `${SPAWN_MARKER}${nonce}`;
}

function invalidRequest(cause) {
  return new ModpackError('INVALID_REQUEST', 'Server process request is invalid', { cause });
}

function healthFailure(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed', { cause });
}

function cancelled(cause) {
  return new ModpackError('CANCELLED', 'Server process wait was cancelled', { cause });
}

function assertExactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidRequest();
  }
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 &&
    (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isAbortSignal(value) {
  return value && typeof value === 'object' && typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' && typeof value.removeEventListener === 'function';
}

function hasControlCharacters(value) {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function normalizeRuntime(value) {
  try {
    return normalizeRuntimeTuple(value);
  } catch (error) {
    throw invalidRequest(error);
  }
}

function isPrintableLabel(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim().length > 0 &&
    ![...value].some(character => {
      const code = character.codePointAt(0);
      return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
    });
}

// v26.6.1 launched whatever version label an unmanaged server was configured or
// detected with (snapshots, pre-releases, old betas). Unmanaged starts keep that
// tolerance; prepared modpack runtimes stay on the strict managed tuple.
function normalizeLegacyRuntime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !RUNTIME_KEYS.has(key))) throw invalidRequest();
  if (!isPrintableLabel(value.minecraftVersion, 64) || !LEGACY_LOADER_FAMILIES.has(value.loaderFamily) ||
      !isPrintableLabel(value.loaderVersion, 128) || !Number.isSafeInteger(value.javaMajor) ||
      value.javaMajor < 8 || value.javaMajor > 99 || value.os !== 'win32' || value.architecture !== 'x64') {
    throw invalidRequest();
  }
  return Object.freeze({
    minecraftVersion: value.minecraftVersion,
    loaderFamily: value.loaderFamily,
    loaderVersion: value.loaderVersion,
    javaMajor: value.javaMajor,
    os: value.os,
    architecture: value.architecture
  });
}

function normalizeLaunchRequest(value) {
  assertExactKeys(value, LAUNCH_KEYS);
  if (!isAbsolutePath(value.serverPath) || !isAbsolutePath(value.javaPath)) throw invalidRequest();
  if (!isIdentifier(value.instanceId) || !isIdentifier(value.operationId)) throw invalidRequest();
  if (typeof value.maxRam !== 'number' || !Number.isFinite(value.maxRam) || value.maxRam <= 0 || value.maxRam > 1024) {
    throw invalidRequest();
  }
  if (typeof value.publishEvents !== 'boolean' || typeof value.onLine !== 'function') throw invalidRequest();
  if ((value.supervision !== undefined && !SUPERVISION_MODES.has(value.supervision)) ||
      (value.runtimeContract !== undefined && !RUNTIME_CONTRACTS.has(value.runtimeContract))) throw invalidRequest();
  const runtimeContract = value.runtimeContract ?? 'managed';
  // Lifecycle authority is only ever issued for prepared managed runtimes.
  if (runtimeContract === 'legacy' &&
      (value.runtimeValidation !== undefined || value.forgeCandidateHealthAuthorization !== undefined)) throw invalidRequest();
  const runtime = runtimeContract === 'legacy' ? normalizeLegacyRuntime(value.runtime) : normalizeRuntime(value.runtime);
  if (value.forgeCandidateHealthAuthorization !== undefined &&
      !isAppIssuedForgeCandidateHealthAuthorization(value.forgeCandidateHealthAuthorization, {
        candidatePath: value.serverPath,
        healthOperationId: value.operationId,
        instanceId: value.instanceId,
        runtime
      })) throw invalidRequest();
  return Object.freeze({
    ...value,
    runtime,
    runtimeContract,
    supervision: value.supervision ?? 'required'
  });
}

function supervisionReason(value, fallback) {
  const text = value instanceof Error ? value.message : value;
  return typeof text === 'string' && text.trim() ? text.slice(0, MAX_REASON_LENGTH) : fallback;
}

function normalizeWaitRequest(value) {
  assertExactKeys(value, WAIT_KEYS);
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 ||
      value.timeoutMs > MAX_SERVER_HEALTH_TIMEOUT_MS) throw invalidRequest();
  if (value.signal !== undefined && !isAbortSignal(value.signal)) throw invalidRequest();
  return Object.freeze({ signal: value.signal, timeoutMs: value.timeoutMs });
}

function normalizeEndpointRequest(value) {
  assertExactKeys(value, ENDPOINT_KEYS);
  const host = typeof value.host === 'string'
    ? value.host.trim().replace(/^\[|\]$/g, '').toLowerCase()
    : '';
  if (!host || host.length > 255 || hasControlCharacters(host) || host === '0.0.0.0' || host === '::') {
    throw invalidRequest();
  }
  if (value.allowWildcard !== undefined && typeof value.allowWildcard !== 'boolean') throw invalidRequest();
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) throw invalidRequest();
  const wait = normalizeWaitRequest({ timeoutMs: value.timeoutMs, ...(value.signal === undefined ? {} : { signal: value.signal }) });
  return Object.freeze({
    allowWildcard: value.allowWildcard === true,
    host,
    port: value.port,
    signal: wait.signal,
    timeoutMs: wait.timeoutMs
  });
}

function normalizeStopRequest(value) {
  assertExactKeys(value, STOP_KEYS);
  for (const key of STOP_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 300000) throw invalidRequest();
  }
  return Object.freeze({ ...value });
}

function parseNetstatListeningEndpoints(output) {
  const endpoints = [];
  const seen = new Set();
  for (const line of String(output || '').split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue;
    const state = columns.at(-2)?.toUpperCase();
    const pid = Number(columns.at(-1));
    const localAddress = columns[1] || '';
    const separator = localAddress.lastIndexOf(':');
    const port = Number(localAddress.slice(separator + 1));
    const host = localAddress.slice(0, separator).replace(/^\[|\]$/g, '').toLowerCase();
    if (state !== 'LISTENING' || !host || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
        !Number.isSafeInteger(pid) || pid <= 0) {
      continue;
    }
    const key = `${host}\0${port}\0${pid}`;
    if (!seen.has(key)) {
      seen.add(key);
      endpoints.push(Object.freeze({ host, port, pid }));
    }
  }
  return endpoints;
}

function parseNetstatListeningPids(output, port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return [];
  return [...new Set(
    parseNetstatListeningEndpoints(output)
      .filter(endpoint => endpoint.port === port)
      .map(endpoint => endpoint.pid)
  )];
}

async function defaultGetListeningEndpoints() {
  if (process.platform !== 'win32') return [];
  const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10000,
    windowsHide: true
  });
  return parseNetstatListeningEndpoints(stdout);
}

function normalizeListenerHost(value) {
  const host = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  return mapped && net.isIP(mapped[1]) === 4 ? mapped[1] : host;
}

async function resolveEndpointHosts(host, lookupHost) {
  const normalized = normalizeListenerHost(host);
  if (net.isIP(normalized)) return new Set([normalized]);
  const records = await lookupHost(normalized, { all: true, verbatim: true });
  if (!Array.isArray(records)) throw healthFailure();
  return new Set(records.map(record => normalizeListenerHost(record.address)).filter(Boolean));
}

function endpointMatches(listener, request, pid, resolvedHosts) {
  if (!listener || typeof listener !== 'object' || Array.isArray(listener) ||
      !Number.isSafeInteger(listener.pid) || listener.pid !== pid ||
      !Number.isSafeInteger(listener.port) || listener.port !== request.port ||
      typeof listener.host !== 'string') {
    return false;
  }
  const host = normalizeListenerHost(listener.host);
  if (resolvedHosts.has(host)) return true;
  return request.allowWildcard && (host === '0.0.0.0' || host === '::');
}

function waitForPromise(promise, { signal, timeoutMs }, timeoutResult = null) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(cancelled());
    const timer = setTimeout(() => {
      if (timeoutResult !== null) finish(null, timeoutResult);
      else finish(healthFailure(new Error('Server process deadline exceeded')));
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || !isAbsolutePath(plan.cwd) || !Array.isArray(plan.args) ||
      plan.args.some(value => typeof value !== 'string') || !Array.isArray(plan.readyMarkers) ||
      !Array.isArray(plan.fatalMarkers) || plan.readyMarkers.some(value => typeof value !== 'string' || !value) ||
      plan.fatalMarkers.some(value => typeof value !== 'string' || !value)) {
    throw healthFailure();
  }
  return plan;
}

function withForgeCandidateConfirmation(plan) {
  const args = [...plan.args];
  const forgeArgsPath = plan.assets?.forgeArgs;
  let launchBoundary = -1;
  if (typeof forgeArgsPath === 'string' && isAbsolutePath(forgeArgsPath)) {
    const forgeResponseArgument = `@${path.relative(plan.cwd, forgeArgsPath)}`;
    launchBoundary = args.indexOf(forgeResponseArgument);
  }
  if (launchBoundary < 0) launchBoundary = args.findIndex(argument => argument === '-jar');
  if (launchBoundary < 0) {
    throw healthFailure(new Error('Protected Forge candidate launch boundary is unavailable'));
  }
  args.splice(launchBoundary, 0, '-Dfml.queryResult=confirm');
  return args;
}

function createServerProcessRunner(dependencies = {}) {
  assertExactKeys(dependencies, new Set([
    'eventBus',
    'getListeningEndpoints',
    'isManagedRuntimeValidation',
    'lookupHost',
    'resolveLaunchPlan',
    'resolvePrevalidatedLaunchPlan',
    'spawnProcess',
    'supervisionRequired',
    'inspectProcesses',
    'captureLaunchRoot',
    'randomUUID'
  ]));
  const eventBus = dependencies.eventBus || defaultEventBus;
  const getListeningEndpoints = dependencies.getListeningEndpoints || defaultGetListeningEndpoints;
  const lookupHost = dependencies.lookupHost || lookup;
  const isRuntimeValidation = dependencies.isManagedRuntimeValidation || isAppIssuedManagedRuntimeValidation;
  const resolvePlan = dependencies.resolveLaunchPlan || resolveLaunchPlan;
  const resolvePrevalidatedPlan = dependencies.resolvePrevalidatedLaunchPlan || resolvePrevalidatedLaunchPlan;
  const spawnProcess = dependencies.spawnProcess || spawn;
  const supervisionRequired = dependencies.supervisionRequired || isServerProcessSupervisionRequired;
  const inspectProcesses = dependencies.inspectProcesses;
  const captureRoot = dependencies.captureLaunchRoot || captureLaunchRoot;
  const randomUUID = dependencies.randomUUID || crypto.randomUUID;
  const processEvidence = new Map();
  if (!eventBus || typeof eventBus.emit !== 'function' ||
      typeof getListeningEndpoints !== 'function' || typeof lookupHost !== 'function' ||
      typeof isRuntimeValidation !== 'function' ||
      typeof resolvePlan !== 'function' || typeof resolvePrevalidatedPlan !== 'function' ||
      typeof spawnProcess !== 'function' || typeof supervisionRequired !== 'function' || typeof randomUUID !== 'function' ||
      (inspectProcesses !== undefined && typeof inspectProcesses !== 'function') ||
      (captureRoot !== undefined && typeof captureRoot !== 'function')) {
    throw invalidRequest();
  }

  function launchServerProcess(input) {
    const request = normalizeLaunchRequest(input);
    const runtime = request.runtime;
    let plan;
    let child;
    let launchAuthority = null;
    let evidenceEntry = null;
    const invalidateEvidence = () => {
      if (!evidenceEntry) return;
      evidenceEntry.invalidated = true;
      if (processEvidence.get(evidenceEntry.pid) === evidenceEntry) processEvidence.delete(evidenceEntry.pid);
    };
    try {
      const planOptions = {
        javaMajor: runtime.javaMajor,
        loader: runtime.loaderFamily,
        loaderVersion: runtime.loaderVersion,
        maxRam: request.maxRam,
        minecraftVersion: runtime.minecraftVersion
      };
      if (request.runtimeValidation !== undefined) {
        if (!isRuntimeValidation(request.runtimeValidation, request.serverPath)) throw invalidRequest();
        plan = validatePlan(resolvePrevalidatedPlan(request.serverPath, planOptions, request.runtimeValidation));
      } else {
        plan = validatePlan(resolvePlan(request.serverPath, planOptions, { runtimeTuple: runtime }));
      }
      const launchArguments = request.forgeCandidateHealthAuthorization
        ? withForgeCandidateConfirmation(plan)
        : plan.args;
      const nonce = randomUUID();
      if (!UUID.test(nonce)) throw invalidRequest();
      const spawnArguments = [`-Dminecraft.core.server.id=${request.operationId}`, `${SPAWN_MARKER}${nonce}`, ...launchArguments];
      // Evidence failure never changes the existing server startup/supervision contract.
      if (inspectProcesses && captureRoot) {
        try {
          const serverRoot = frozenRoot(captureRoot, request.serverPath);
          const cwdRoot = frozenRoot(captureRoot, plan.cwd);
          if (serverRoot.canonicalPath !== cwdRoot.canonicalPath || serverRoot.identity !== cwdRoot.identity ||
              plan.loader !== runtime.loaderFamily || (plan.runtime && plan.runtime.loaderFamily !== runtime.loaderFamily) ||
              spawnArguments.filter(argument => argument.startsWith(SPAWN_MARKER)).length !== 1) throw invalidRequest();
          launchAuthority = Object.freeze({ serverRoot, cwd: path.resolve(plan.cwd), serverPath: path.resolve(request.serverPath),
            executablePath: pathKey(request.javaPath), nonce, args: Object.freeze([...spawnArguments]) });
        } catch { /* No positive root/launch evidence; still launch the server normally. */ }
      }
      child = spawnProcess(
        request.javaPath,
        spawnArguments,
        {
          cwd: plan.cwd,
          detached: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        }
      );
    } catch (error) {
      throw error instanceof ModpackError ? error : healthFailure(error);
    }
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 ||
        !child.stdout || !child.stderr || !child.stdin || typeof child.stdin.write !== 'function' ||
        typeof child.on !== 'function' || typeof child.once !== 'function' || typeof child.kill !== 'function') {
      try { child?.kill?.(); } catch {
        // The invalid child cannot be trusted to provide further cleanup evidence.
      }
      throw healthFailure();
    }

    const pid = child.pid;
    let stdinFailed = false;
    const onStdinError = () => {
      stdinFailed = true;
    };
    if (typeof child.stdin.on === 'function') {
      child.stdin.on('error', onStdinError);
    }
    const writeStdin = value => {
      if (stdinFailed || child.stdin.destroyed === true || child.stdin.closed === true ||
          child.stdin.writable === false || child.stdin.writableEnded === true ||
          child.stdin.writableFinished === true) return false;
      try {
        child.stdin.write(value, error => {
          if (error) stdinFailed = true;
        });
        return true;
      } catch {
        stdinFailed = true;
        return false;
      }
    };
    const endpointHostResolutions = new Map();
    const resolveEndpointHostsOnce = host => {
      const normalized = normalizeListenerHost(host);
      if (net.isIP(normalized)) return Promise.resolve(new Set([normalized]));
      let pending = endpointHostResolutions.get(normalized);
      if (!pending) {
        pending = Promise.resolve().then(() => resolveEndpointHosts(normalized, lookupHost));
        endpointHostResolutions.set(normalized, pending);
        void pending.catch(() => {
          if (endpointHostResolutions.get(normalized) === pending) endpointHostResolutions.delete(normalized);
        });
      }
      return pending;
    };
    let closedInfo = null;
    let fatal = false;
    let readyEvidence = null;
    let supervisionEstablished = false;
    let supervisionTerminationRequested = false;
    let supervisionMode = request.supervision;
    // 'pending' until the watchdog ACK, then 'armed'; 'unsupervised' when no watchdog
    // armed in time (a late ACK still upgrades it), 'lost' when an armed watcher failed.
    let supervisionState = 'pending';
    let resolveSupervisionSettled;
    const supervisionSettled = new Promise(resolve => { resolveSupervisionSettled = resolve; });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const readyWaiters = new Set();
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });

    const settleWaiter = (waiter, error, value) => {
      if (!readyWaiters.delete(waiter)) return;
      clearTimeout(waiter.timer);
      if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (error) waiter.reject(error);
      else waiter.resolve(value);
    };
    const settleAllWaiters = (error, value) => {
      for (const waiter of [...readyWaiters]) settleWaiter(waiter, error, value);
    };
    // Best-effort readiness is the ready marker alone; it never waits for the watchdog.
    const readinessSupervised = () => supervisionEstablished || supervisionMode === 'best-effort';
    const settleReadyIfComplete = () => {
      if (readyEvidence && readinessSupervised() && !fatal && !closedInfo) {
        settleAllWaiters(null, readyEvidence);
      }
    };
    const emitLine = (line, stream) => {
      if (!line) return;
      const evidence = Object.freeze({ line, operationId: request.operationId, pid, stream });
      try { request.onLine(evidence); } catch {
        // Operation observers cannot interfere with process supervision.
      }
      const fatalMarker = plan.fatalMarkers.find(marker => line.includes(marker));
      if (fatalMarker) {
        fatal = true;
        invalidateEvidence();
        settleAllWaiters(healthFailure());
        return;
      }
      if (!readyEvidence) {
        const marker = plan.readyMarkers.find(value => line.includes(value));
        if (marker) {
          readyEvidence = Object.freeze({ marker, pid });
          settleReadyIfComplete();
        }
      }
    };
    const consume = (chunk, stream) => {
      const current = stream === 'stdout' ? stdoutBuffer : stderrBuffer;
      let next = current + chunk.toString();
      if (Buffer.byteLength(next, 'utf8') > MAX_LINE_BYTES) {
        fatal = true;
        invalidateEvidence();
        next = '';
        settleAllWaiters(healthFailure());
      }
      const lines = next.split(/\r\n|\r|\n/);
      const remainder = lines.pop() || '';
      for (const line of lines) emitLine(line, stream);
      if (stream === 'stdout') stdoutBuffer = remainder;
      else stderrBuffer = remainder;
    };
    const flush = stream => {
      const value = stream === 'stdout' ? stdoutBuffer : stderrBuffer;
      if (value) emitLine(value, stream);
      if (stream === 'stdout') stdoutBuffer = '';
      else stderrBuffer = '';
    };
    const onStdoutData = chunk => consume(chunk, 'stdout');
    const onStderrData = chunk => consume(chunk, 'stderr');
    const onStdoutEnd = () => flush('stdout');
    const onStderrEnd = () => flush('stderr');
    const onStreamError = () => {
      fatal = true;
      invalidateEvidence();
      settleAllWaiters(healthFailure());
    };
    const detachStreams = () => {
      child.stdout.removeListener('data', onStdoutData);
      child.stdout.removeListener('end', onStdoutEnd);
      child.stdout.removeListener('error', onStreamError);
      child.stderr.removeListener('data', onStderrData);
      child.stderr.removeListener('end', onStderrEnd);
      child.stderr.removeListener('error', onStreamError);
    };
    const onChildError = () => {
      fatal = true;
      invalidateEvidence();
      settleAllWaiters(healthFailure());
    };
    const onChildClose = (exitCode, signal) => {
      if (closedInfo) return;
      invalidateEvidence();
      flush('stdout');
      flush('stderr');
      closedInfo = Object.freeze({ exitCode, signal });
      if (supervisionState === 'pending') supervisionState = 'unsupervised';
      resolveSupervisionSettled(supervisionState === 'armed' ? 'armed' : 'unsupervised');
      detachStreams();
      child.removeListener('error', onChildError);
      child.removeListener('close', onChildClose);
      settleAllWaiters(healthFailure());
      resolveClosed(closedInfo);
    };

    child.stdout.on('data', onStdoutData);
    child.stdout.on('end', onStdoutEnd);
    child.stdout.on('error', onStreamError);
    child.stderr.on('data', onStderrData);
    child.stderr.on('end', onStderrEnd);
    child.stderr.on('error', onStreamError);
    child.on('error', onChildError);
    child.on('close', onChildClose);
    child.once('exit', invalidateEvidence);

    const ownership = Object.freeze({ instanceId: request.instanceId, operationId: request.operationId, pid });
    child.once('close', () => {
      try { eventBus.emit('server-process-released', ownership); } catch {
        // Internal observers cannot interfere with exact process-close handling.
      }
    });
    const reportSupervision = (state, reason) => {
      const event = Object.freeze({ ...ownership, state, reason });
      queueMicrotask(() => {
        try { eventBus.emit(DEGRADED_EVENT, event); } catch {
          // Observers of a degraded watchdog cannot change the running server.
        }
      });
    };
    const markSupervisionArmed = () => {
      if (closedInfo || supervisionState === 'armed' || supervisionState === 'lost') return;
      const recovered = supervisionState === 'unsupervised';
      supervisionState = 'armed';
      resolveSupervisionSettled('armed');
      if (recovered && supervisionMode === 'best-effort') reportSupervision('armed', LATE_ACK_REASON);
    };
    // Best-effort watchdog faults are reported once per transition. They never
    // mark the server fatal and never terminate it.
    const degradeSupervision = reason => {
      if (closedInfo || supervisionState === 'lost') return;
      const next = supervisionState === 'armed' ? 'lost' : 'unsupervised';
      if (supervisionState === next) return;
      supervisionState = next;
      resolveSupervisionSettled('unsupervised');
      reportSupervision(next, supervisionReason(reason, WATCHDOG_FAILED_REASON));
    };
    const supervisionFailure = reason => {
      if (supervisionMode === 'best-effort') return degradeSupervision(reason);
      if (closedInfo) return;
      supervisionState = supervisionState === 'armed' ? 'lost' : 'unsupervised';
      resolveSupervisionSettled('unsupervised');
      fatal = true;
      invalidateEvidence();
      settleAllWaiters(healthFailure());
      if (supervisionTerminationRequested) return;
      supervisionTerminationRequested = true;
      try { child.kill('SIGKILL'); } catch {
        // The failed launch remains rejected when exact-child termination cannot be confirmed.
      }
    };
    let supervision;
    try {
      supervision = requestServerProcessSupervision({
        eventBus,
        identity: ownership,
        onFailure: (identity, reason) => supervisionFailure(reason),
        required: supervisionMode === 'required' && supervisionRequired() === true,
        ...(supervisionMode === 'best-effort' ? { onDeadline: (identity, reason) => degradeSupervision(reason) } : {})
      });
    } catch (error) {
      // The child already exists. Return its exact handle so the caller can
      // prove termination; throwing here would discard the only safe cleanup
      // authority while the operating system may still have a live process.
      supervisionFailure(error);
      supervision = Object.freeze({
        acknowledged: false,
        ready: Promise.resolve().then(() => { throw error; })
      });
    }
    const acknowledged = supervision.acknowledged === true;
    if (!acknowledged && supervisionMode === 'best-effort') degradeSupervision(NOT_ACKNOWLEDGED_REASON);
    const watchdogReady = Promise.resolve(supervision.ready).then(() => {
      // Only an exact watchdog ACK arms supervision; an unrequired, unacknowledged
      // launch keeps its readiness semantics but is never treated as supervised.
      if (acknowledged) markSupervisionArmed();
      else if (supervisionState === 'pending') {
        supervisionState = 'unsupervised';
        resolveSupervisionSettled('unsupervised');
      }
      if (supervisionMode === 'best-effort') return ownership;
      if (fatal || closedInfo) throw healthFailure();
      supervisionEstablished = true;
      settleReadyIfComplete();
      return ownership;
    }, error => {
      supervisionFailure(error);
      if (supervisionMode === 'best-effort') return ownership;
      throw healthFailure(error);
    });
    void watchdogReady.catch(() => {});
    // Best-effort callers learn the outcome without ever seeing a rejection.
    const supervisionReady = request.supervision === 'best-effort'
      ? supervisionSettled.then(() => ownership)
      : watchdogReady;

    const handle = {
      child,
      closed,
      fatalMarkers: Object.freeze([...plan.fatalMarkers]),
      launchPlan: plan,
      operationId: request.operationId,
      pid,
      publishEvents: request.publishEvents,
      supervision: Object.freeze({
        settled: supervisionSettled,
        state: () => supervisionState
      }),
      supervisionReady,
      readyMarkers: Object.freeze([...plan.readyMarkers]),
      isLive() {
        return !fatal && closedInfo === null && child.exitCode === null && child.signalCode === null && !child.killed;
      },
      // Later watchdog faults are reported instead of terminating this server.
      relaxSupervision() {
        if (supervisionMode === 'best-effort') return false;
        supervisionMode = 'best-effort';
        settleReadyIfComplete();
        return true;
      },
      waitForReady(inputValue) {
        const wait = normalizeWaitRequest(inputValue);
        if (wait.signal?.aborted) return Promise.reject(cancelled());
        if (fatal || closedInfo) return Promise.reject(healthFailure());
        if (readyEvidence && readinessSupervised()) return Promise.resolve(readyEvidence);
        return new Promise((resolve, reject) => {
          const waiter = { resolve, reject, signal: wait.signal, timer: null, onAbort: null };
          waiter.onAbort = () => settleWaiter(waiter, cancelled());
          waiter.timer = setTimeout(() => settleWaiter(waiter, healthFailure()), wait.timeoutMs);
          if (wait.signal) wait.signal.addEventListener('abort', waiter.onAbort, { once: true });
          readyWaiters.add(waiter);
        });
      },
      async ownsEndpoint(inputValue) {
        const endpoint = normalizeEndpointRequest(inputValue);
        if (!handle.isLive()) return false;
        try {
          const ownership = await waitForPromise(
            Promise.all([
              getListeningEndpoints(endpoint),
              resolveEndpointHostsOnce(endpoint.host)
            ]).then(([endpoints, resolvedHosts]) => ({ endpoints, resolvedHosts })),
            { signal: endpoint.signal, timeoutMs: endpoint.timeoutMs },
            { endpoints: [], resolvedHosts: new Set() }
          );
          return handle.isLive() && Array.isArray(ownership.endpoints) &&
            ownership.endpoints.some(listener => endpointMatches(listener, endpoint, pid, ownership.resolvedHosts));
        } catch (error) {
          if (error instanceof ModpackError && error.code === 'CANCELLED') throw error;
          return false;
        }
      },
      async stopFully(inputValue) {
        const stop = normalizeStopRequest(inputValue);
        invalidateEvidence();
        let forced = false;
        if (!closedInfo) {
          const gracefulRequested = writeStdin('stop\n');
          if (gracefulRequested) {
            await waitForPromise(closed, { timeoutMs: stop.gracefulTimeoutMs }, null).catch(() => null);
          }
        }
        if (!closedInfo) {
          forced = true;
          try { child.kill('SIGKILL'); } catch {
            // The closed=false result is the fail-closed termination evidence.
          }
          await waitForPromise(closed, { timeoutMs: stop.killTimeoutMs }, null).catch(() => null);
        }
        if (!closedInfo) detachStreams();
        return Object.freeze({
          clean: Boolean(closedInfo && !forced && closedInfo.exitCode === 0 && closedInfo.signal === null),
          closed: Boolean(closedInfo),
          exitCode: closedInfo?.exitCode ?? null,
          forced,
          signal: closedInfo?.signal ?? null
        });
      }
    };
    if (launchAuthority && handle.isLive()) {
      const previous = processEvidence.get(pid);
      if (previous) {
        previous.invalidated = true;
        processEvidence.delete(pid); // Conflicting live handles never receive a PID-only exemption.
      } else {
        evidenceEntry = { pid, handle, authority: launchAuthority, identity: null, invalidated: false,
          isSupervised: () => supervisionState === 'armed' };
        processEvidence.set(pid, evidenceEntry);
        const entry = evidenceEntry;
        void Promise.resolve().then(() => inspectProcesses()).then(value => {
          const row = validateProcessSnapshot(value).processes.find(item => item.pid === pid);
          if (processEvidence.get(pid) !== entry || entry.invalidated || !handle.isLive() ||
              !validIdentity(row) || row.parentPid !== process.pid || pathKey(row.executablePath) !== launchAuthority.executablePath ||
              !singleSpawnMarker(row.commandLine, launchAuthority.nonce)) return;
          entry.identity = Object.freeze({ pid, parentPid: row.parentPid, creationTime: row.creationTime,
            executablePath: row.executablePath, commandHash: commandHash(row.commandLine) });
        }).catch(() => { /* Missing/failed bounded identity capture grants no exemption and never kills the server. */ });
      }
    }
    return Object.freeze(handle);
  }

  function isCurrentUnrelatedServer({ process: row, clientPath } = {}) {
    try {
      if (!validIdentity(row) || typeof clientPath !== 'string' || !path.isAbsolute(clientPath)) return false;
      const entry = processEvidence.get(row.pid); const identity = entry?.identity;
      if (!entry || entry.invalidated || !identity || !entry.handle.isLive() || !entry.isSupervised() ||
          row.pid !== identity.pid || row.parentPid !== identity.parentPid || row.creationTime !== identity.creationTime ||
          row.executablePath !== identity.executablePath || commandHash(row.commandLine) !== identity.commandHash ||
          !singleSpawnMarker(row.commandLine, entry.authority.nonce)) return false;
      const root = frozenRoot(captureRoot, entry.authority.serverPath);
      const cwd = frozenRoot(captureRoot, entry.authority.cwd);
      const original = entry.authority.serverRoot; const target = pathKey(clientPath);
      return root.canonicalPath === original.canonicalPath && cwd.canonicalPath === original.canonicalPath &&
        root.identity === original.identity && cwd.identity === original.identity &&
        !containsPath(root.canonicalPath, target) && !containsPath(target, root.canonicalPath) &&
        processEvidence.get(row.pid) === entry && !entry.invalidated && entry.handle.isLive() && entry.isSupervised();
    } catch { return false; }
  }
  return Object.freeze({ launchServerProcess, isCurrentUnrelatedServer });
}

const sharedServerProcessRunner = createServerProcessRunner({ inspectProcesses: createClientProcessInspector(), captureLaunchRoot });

function launchServerProcess(request) {
  return sharedServerProcessRunner.launchServerProcess(request);
}

module.exports = {
  createServerProcessRunner,
  launchServerProcess,
  parseNetstatListeningEndpoints,
  parseNetstatListeningPids,
  sharedServerProcessRunner
};
