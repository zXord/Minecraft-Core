const { runtimeDiagnosticFor } = require('./runtime-diagnostic.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { waitForRuntimeWorkerQuiescence } = require('./runtime-worker-quiescence.cjs');
const {
  MANAGED_RUNTIME_PREPARE_OPERATION,
  MANAGED_RUNTIME_VERIFY_OPERATION,
  MANAGED_RUNTIME_WORKER_TOKEN_ENV,
  createManagedRuntimeResponse,
  verifyManagedRuntimeRequest
} = require('./managed-runtime-worker-protocol.cjs');

// The parent boundary allows an hour for a real loader installation. Keep this
// authenticated child on the same budget so it cannot terminate an otherwise
// healthy operation after an unrelated 30-second watchdog expires.
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const PREPARE_FAILURE_CODES = new Set([
  'RUNTIME_INCOMPLETE',
  'LOADER_VERSION_UNAVAILABLE',
  'LOADER_VERSION_REQUIRED',
  'UNSUPPORTED_LOADER'
]);

function canonicalPathIdentity(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function nativeRealpath(fsApi, value) {
  const implementation = fsApi.realpathSync?.native || fsApi.realpathSync;
  if (typeof implementation !== 'function') throw new Error('Native realpath is unavailable');
  return implementation.call(fsApi.realpathSync, value);
}

function assertCanonicalDirectory(value, fsApi) {
  const stat = fsApi.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Runtime target is invalid');
  const real = nativeRealpath(fsApi, value);
  if (canonicalPathIdentity(real) !== canonicalPathIdentity(value)) throw new Error('Runtime target is invalid');
}

function assertCanonicalRegularFile(value, fsApi) {
  const stat = fsApi.lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || (Number.isInteger(stat.nlink) && stat.nlink !== 1)) {
    throw new Error('Java runtime is invalid');
  }
  const real = nativeRealpath(fsApi, value);
  if (canonicalPathIdentity(real) !== canonicalPathIdentity(value)) throw new Error('Java runtime is invalid');
}

function runtimeEquals(left, right) {
  return ['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture']
    .every(key => left?.[key] === right?.[key]);
}

function assertRuntimeResult(result, expectedRuntime) {
  if (!result || result.valid !== true || !runtimeEquals(result.runtime, expectedRuntime)) {
    throw new Error('Managed runtime result is invalid');
  }
  return result;
}

function failureCode(operation, error) {
  if (operation === MANAGED_RUNTIME_PREPARE_OPERATION && PREPARE_FAILURE_CODES.has(error?.code)) {
    return error.code;
  }
  if (operation === MANAGED_RUNTIME_VERIFY_OPERATION && error?.code === 'UNSUPPORTED_LOADER') {
    return 'UNSUPPORTED_LOADER';
  }
  return 'RUNTIME_INCOMPLETE';
}

function startManagedRuntimeWorker(options = {}) {
  const processRef = options.processRef || process;
  const fsApi = options.fsApi || fs;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  const environment = processRef.env || {};
  const token = environment[MANAGED_RUNTIME_WORKER_TOKEN_ENV];
  delete environment[MANAGED_RUNTIME_WORKER_TOKEN_ENV];
  const requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  let accepted = false;
  let finished = false;
  let parentDisconnected = false;
  let requestTimer = null;
  const cancellation = new AbortController();

  const hardExit = code => {
    if (finished) return;
    finished = true;
    clearTimeoutImpl(requestTimer);
    processRef.exit(code);
  };
  const sendAndExit = (response, code) => {
    if (finished) return;
    finished = true;
    clearTimeoutImpl(requestTimer);
    let exitTimer = setTimeoutImpl(() => processRef.exit(70), 1000);
    try {
      if (!processRef.connected || typeof processRef.send !== 'function') {
        clearTimeoutImpl(exitTimer);
        processRef.exit(70);
        return;
      }
      processRef.send(response, error => {
        clearTimeoutImpl(exitTimer);
        exitTimer = null;
        if (!error) {
          try { processRef.disconnect?.(); } catch { /* process exit remains authoritative */ }
        }
        processRef.exit(error ? 70 : code);
      });
    } catch {
      clearTimeout(exitTimer);
      processRef.exit(70);
    }
  };

  processRef.once?.('disconnect', () => {
    parentDisconnected = true;
    cancellation.abort();
    clearTimeoutImpl(requestTimer);
    // Runtime preparation can own Java and nested loader workers. Keep this
    // process alive until that operation settles so losing IPC never orphans
    // those descendants.
    if (!accepted) hardExit(65);
  });
  processRef.on?.('message', async message => {
    if (finished) return;
    if (accepted) {
      hardExit(64);
      return;
    }
    accepted = true;
    clearTimeoutImpl(requestTimer);

    let verified;
    try {
      verified = verifyManagedRuntimeRequest(message, token);
    } catch {
      hardExit(64);
      return;
    }

    let diagnosticStage = 'managed-target';
    try {
      assertCanonicalDirectory(verified.payload.targetPath, fsApi);
      let result;
      if (verified.operation === MANAGED_RUNTIME_PREPARE_OPERATION) {
        diagnosticStage = 'managed-java';
        assertCanonicalRegularFile(verified.payload.javaPath, fsApi);
        diagnosticStage = 'managed-load';
        const service = options.prepareRuntimeImpl ? null : require('./loader-install-service.cjs');
        const prepareRuntime = options.prepareRuntimeImpl ||
          service?.__testUtils?.prepareManagedServerRuntimeInProcess;
        if (typeof prepareRuntime !== 'function') throw new Error('Managed runtime preparation is unavailable');
        diagnosticStage = 'managed-prepare';
        const validation = await prepareRuntime({
          targetPath: verified.payload.targetPath,
          runtime: verified.payload.runtime,
          javaPath: verified.payload.javaPath,
          skipMutationMark: true,
          signal: cancellation.signal
        });
        diagnosticStage = 'managed-result';
        assertRuntimeResult(validation, verified.payload.runtime);
        result = { valid: true, runtime: validation.runtime };
      } else {
        diagnosticStage = 'managed-load';
        const validateRuntime = options.verifyRuntimeImpl ||
          require('./loader-install-service.cjs').validatePreparedRuntime;
        if (typeof validateRuntime !== 'function') throw new Error('Managed runtime validation is unavailable');
        diagnosticStage = 'managed-verify';
        result = await validateRuntime(verified.payload.targetPath, verified.payload.runtime);
        diagnosticStage = 'managed-result';
        assertRuntimeResult(result, verified.payload.runtime);
      }
      if (finished) return;
      if (parentDisconnected) {
        hardExit(65);
        return;
      }
      sendAndExit(createManagedRuntimeResponse({
        token,
        requestId: verified.requestId,
        operation: verified.operation,
        ok: true,
        result
      }), 0);
    } catch (error) {
      if (finished) return;
      try { await waitForRuntimeWorkerQuiescence(error); }
      catch {
        // A crashed descendant-owning worker is not proof that its descendants
        // stopped. Exit distinctly so the parent preserves recovery ownership.
        hardExit(66);
        return;
      }
      if (parentDisconnected) {
        hardExit(65);
        return;
      }
      sendAndExit(createManagedRuntimeResponse({
        token,
        requestId: verified.requestId,
        operation: verified.operation,
        ok: false,
        code: failureCode(verified.operation, error),
        runtimeDiagnostic: runtimeDiagnosticFor(error, diagnosticStage)
      }), 1);
    }
  });

  requestTimer = setTimeoutImpl(() => hardExit(64), requestTimeoutMs);
  requestTimer.unref?.();
  return { started: true };
}

if (require.main === module) {
  startManagedRuntimeWorker();
}

module.exports = {
  startManagedRuntimeWorker
};
