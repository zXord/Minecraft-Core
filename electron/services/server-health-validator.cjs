const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('./modpacks/errors.cjs');
const { normalizeRuntimeTuple } = require('./modpacks/contracts.cjs');
const { pingMinecraftStatus } = require('./minecraft-status-ping.cjs');
const { ServerJavaManager } = require('./server-java-manager.cjs');
const {
  getServerMutationCoordinator,
  runWithServerMutationLease
} = require('./server-mutation-context.cjs');
const { sharedServerProcessRunner } = require('./server-process-runner.cjs');

const CANDIDATE_KEYS = new Set([
  'candidatePath', 'jobId', 'maxRam', 'mutationLease', 'runtime', 'signal', 'timeoutMs'
]);
const LIVE_KEYS = new Set([
  'instanceId', 'jobId', 'keepRunning', 'maxRam', 'mutationLease', 'port', 'runtime', 'serverPath', 'signal', 'timeoutMs'
]);
const DEPENDENCY_KEYS = new Set([
  'chooseLoopbackPort', 'clock', 'coordinator', 'createNonce', 'fileSystem', 'pingStatus',
  'processRunner', 'resolveJavaPath', 'runWithLease', 'sleep'
]);
const CLEANUP_TIMEOUT_MS = 5000;

function invalidRequest(cause) {
  return new ModpackError('INVALID_REQUEST', 'Server health request is invalid', { cause });
}

function healthFailure(cause) {
  if (cause instanceof ModpackError && cause.code === 'HEALTH_CHECK_FAILED') return cause;
  return new ModpackError('HEALTH_CHECK_FAILED', 'Server health validation failed', { cause });
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
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 300000) throw invalidRequest();
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
  return Object.freeze(normalizeCommon(value, CANDIDATE_KEYS, 'candidatePath'));
}

function normalizeLive(value) {
  const result = normalizeCommon(value, LIVE_KEYS, 'serverPath');
  if (!isIdentifier(result.instanceId) || result.instanceId !== result.mutationLease.instanceId) throw invalidRequest();
  if (!Number.isSafeInteger(result.port) || result.port < 1 || result.port > 65535) throw invalidRequest();
  if (typeof result.keepRunning !== 'boolean') throw invalidRequest();
  return Object.freeze(result);
}

function defaultFileSystem() {
  return Object.freeze({
    exists: fs.existsSync,
    readFile: fs.readFileSync,
    removeFile: filePath => fs.rmSync(filePath, { force: true }),
    writeFile: fs.writeFileSync
  });
}

function validateFileSystem(value) {
  const candidate = value || defaultFileSystem();
  if (!candidate || typeof candidate !== 'object' ||
      ['exists', 'readFile', 'removeFile', 'writeFile'].some(method => typeof candidate[method] !== 'function')) {
    throw invalidRequest();
  }
  return candidate;
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
  const requirements = await manager.getJavaRequirementsForMinecraft(runtime.minecraftVersion);
  if (signal?.aborted) throw cancelled();
  if (requirements.needsDownload) {
    throw healthFailure(new Error('The required Java runtime was not prepared before health validation'));
  }
  if (!requirements.isAvailable || !requirements.javaPath || requirements.requiredJavaVersion !== runtime.javaMajor) {
    throw healthFailure();
  }
  return requirements.javaPath;
}

function operationId(kind, jobId) {
  return `health-${crypto.createHash('sha256').update(`${kind}:${jobId}`).digest('hex').slice(0, 32)}`;
}

function propertiesSnapshot(fileSystem, serverPath) {
  const filePath = path.join(serverPath, 'server.properties');
  if (!fileSystem.exists(filePath)) return { bytes: null, existed: false, filePath, sha256: null };
  const bytes = Buffer.from(fileSystem.readFile(filePath));
  return {
    bytes,
    existed: true,
    filePath,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

function overlayProperties(bytes, properties) {
  const original = bytes ? bytes.toString('utf8') : '';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const keys = new Set(Object.keys(properties));
  const lines = original.split(/\r?\n/).filter(line => {
    if (!line || line.startsWith('#') || !line.includes('=')) return true;
    return !keys.has(line.slice(0, line.indexOf('=')).trim());
  });
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(properties)) lines.push(`${key}=${value}`);
  return Buffer.from(`${lines.join(newline)}${newline}`, 'utf8');
}

function writeCandidateOverlay(fileSystem, snapshot, startLease, port, motdNonce) {
  startLease.assertOwnedPath(path.dirname(snapshot.filePath));
  startLease.markDirty();
  const bytes = overlayProperties(snapshot.bytes, {
    'broadcast-rcon-to-ops': 'false',
    'enable-query': 'false',
    'enable-rcon': 'false',
    'management-server-enabled': 'false',
    motd: motdNonce,
    'query.port': '0',
    'rcon.port': '0',
    'server-ip': '127.0.0.1',
    'server-port': String(port)
  });
  fileSystem.writeFile(snapshot.filePath, bytes);
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
    const restored = Buffer.from(fileSystem.readFile(snapshot.filePath));
    if (!restored.equals(snapshot.bytes)) throw healthFailure();
  }
}

function readConfiguredServerIp(bytes) {
  if (!bytes) return '';
  let configured = '';
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || !trimmed.includes('=')) continue;
    const separator = trimmed.indexOf('=');
    if (trimmed.slice(0, separator).trim() === 'server-ip') {
      configured = trimmed.slice(separator + 1).trim().replace(/^\[|\]$/g, '');
    }
  }
  return configured;
}

function liveEndpoint(snapshot, port) {
  const configured = readConfiguredServerIp(snapshot.bytes);
  if (!configured || configured === '0.0.0.0') {
    return Object.freeze({ host: '127.0.0.1', port });
  }
  if (configured === '::') {
    return Object.freeze({ host: '::1', port });
  }
  return Object.freeze({ host: configured.toLowerCase(), port });
}

function safeRelease(lease) {
  try { lease.release(); } catch {
    // The coordinator retains its own fail-closed revision state on release errors.
  }
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
    if (typeof this.chooseLoopbackPort !== 'function' || typeof this.clock !== 'function' ||
        !this.coordinator || typeof this.coordinator.acquireStart !== 'function' || typeof this.createNonce !== 'function' ||
        typeof this.pingStatus !== 'function' || !this.processRunner ||
        typeof this.processRunner.launchServerProcess !== 'function' || typeof this.resolveJavaPath !== 'function' ||
        typeof this.runWithLease !== 'function' || typeof this.sleep !== 'function') {
      throw invalidRequest();
    }
  }

  async validateCandidate(input) {
    let request;
    try { request = normalizeCandidate(input); } catch (error) { throw this._normalizeError(error); }
    const generated = String(this.createNonce());
    const safeNonce = /^[A-Za-z0-9._:-]{1,96}$/.test(generated)
      ? generated
      : crypto.createHash('sha256').update(generated).digest('hex').slice(0, 32);
    const motdNonce = `minecraft-core-health:${safeNonce}`;
    let port;
    try {
      this._throwIfCancelled(request.signal);
      port = await this.chooseLoopbackPort({ signal: request.signal });
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw healthFailure();
    } catch (error) {
      throw this._normalizeError(error, request.signal);
    }
    return this._validate({
      kind: 'candidate',
      keepRunning: false,
      motdNonce,
      port,
      request,
      serverPath: request.candidatePath
    });
  }

  async validateLive(input) {
    let request;
    try { request = normalizeLive(input); } catch (error) { throw this._normalizeError(error); }
    return this._validate({
      kind: 'live',
      keepRunning: request.keepRunning,
      motdNonce: null,
      port: request.port,
      request,
      serverPath: request.serverPath
    });
  }

  async _validate({ kind, keepRunning, motdNonce, port, request, serverPath }) {
    const startedAt = this.clock();
    const deadline = startedAt + request.timeoutMs;
    const id = operationId(kind, request.jobId);
    let startLease;
    let retainLease = false;
    let pendingPrelaunchWork = null;
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
        const snapshot = propertiesSnapshot(this.fileSystem, serverPath);
        const endpoint = kind === 'candidate'
          ? Object.freeze({ host: '127.0.0.1', port })
          : liveEndpoint(snapshot, port);
        let handle = null;
        let overlayAttempted = false;
        let shutdown = null;
        let verified = null;
        let primaryError = null;
        let handoff = null;
        let releaseOnCloseArmed = false;
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
              gracefulTimeoutMs: CLEANUP_TIMEOUT_MS,
              killTimeoutMs: CLEANUP_TIMEOUT_MS
            });
            if (!shutdown?.closed) {
              retainUntilClosed();
              primaryError = healthFailure();
            } else if (!primaryError && (!isCleanShutdown(shutdown) || handle.isLive())) {
              primaryError = healthFailure();
            }
          } catch (error) {
            retainUntilClosed();
            primaryError = healthFailure(error);
          }
        };

        try {
          if (kind === 'candidate') {
            overlayAttempted = true;
            writeCandidateOverlay(this.fileSystem, snapshot, startLease, port, motdNonce);
          }
          this._throwIfCancelled(request.signal);
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
          handle = this.processRunner.launchServerProcess({
            instanceId: request.mutationLease.instanceId,
            javaPath,
            maxRam: request.maxRam,
            onLine() {},
            operationId: id,
            publishEvents: false,
            runtime: request.runtime,
            serverPath
          });
          this._assertHandle(handle);
          observeClose();
          startLease.markRunning({ pid: handle.pid });

          const ready = await handle.waitForReady({
            signal: request.signal,
            timeoutMs: this._remaining(deadline)
          });
          if (!ready || ready.pid !== handle.pid || typeof ready.marker !== 'string' || !handle.isLive()) {
            throw healthFailure();
          }
          const pong = await this._waitForIdentity({
            deadline,
            endpoint,
            handle,
            motdNonce,
            signal: request.signal
          });
          verified = { pong, ready };
        } catch (error) {
          primaryError = this._normalizeError(error, request.signal);
        } finally {
          if (kind === 'candidate' || !keepRunning || primaryError) await ensureStopped();

          try {
            if (kind === 'candidate' && overlayAttempted) restoreCandidateProperties(this.fileSystem, snapshot, startLease);
            else verifyProperties(this.fileSystem, snapshot);
          } catch (error) {
            primaryError = healthFailure(error);
          }
          if (keepRunning && primaryError) await ensureStopped();
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

        if (primaryError) throw primaryError;
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
      throw this._normalizeError(error, request.signal);
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
      const owned = await handle.ownsEndpoint({
        host: endpoint.host,
        port: endpoint.port,
        signal,
        timeoutMs: remaining
      });
      if (owned) {
        if (!handle.isLive()) throw healthFailure();
        try {
          const pong = await this.pingStatus({
            host: endpoint.host,
            port: endpoint.port,
            protocolVersion: -1,
            signal,
            timeoutMs: this._remaining(deadline)
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
  ServerHealthValidator
};
