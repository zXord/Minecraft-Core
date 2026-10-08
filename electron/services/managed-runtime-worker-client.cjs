const childProcess = require('node:child_process');
const { retainRuntimeWorkerQuiescence } = require('./runtime-worker-quiescence.cjs');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  MANAGED_RUNTIME_PREPARE_OPERATION,
  MANAGED_RUNTIME_VERIFY_OPERATION,
  MANAGED_RUNTIME_WORKER_TOKEN_ENV,
  createManagedRuntimeRequest,
  verifyManagedRuntimeResponse
} = require('./managed-runtime-worker-protocol.cjs');

const DEFAULT_PREPARE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_VERIFY_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const MAX_TERMINATION_GRACE_MS = 60 * 1000;
const OPERATIONS = new Set([MANAGED_RUNTIME_PREPARE_OPERATION, MANAGED_RUNTIME_VERIFY_OPERATION]);
const APP_ISSUED_MANAGED_RUNTIME_VALIDATIONS = new WeakMap();

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function managedRuntimeTargetIdentity(value) {
  try {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
    const normalized = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  } catch {
    return null;
  }
}

function issueManagedRuntimeValidation(value, targetPath) {
  const targetIdentity = managedRuntimeTargetIdentity(targetPath);
  if (!targetIdentity) throw runtimeFailure();
  deepFreeze(value);
  APP_ISSUED_MANAGED_RUNTIME_VALIDATIONS.set(value, targetIdentity);
  return value;
}

function isAppIssuedManagedRuntimeValidation(value, targetPath) {
  if (!value || typeof value !== 'object') return false;
  const expectedIdentity = managedRuntimeTargetIdentity(targetPath);
  return Boolean(expectedIdentity && APP_ISSUED_MANAGED_RUNTIME_VALIDATIONS.get(value) === expectedIdentity);
}

function runtimeFailure(code = 'RUNTIME_INCOMPLETE') {
  const messages = {
    RUNTIME_INCOMPLETE: 'The managed server runtime operation failed.',
    LOADER_VERSION_UNAVAILABLE: 'The requested loader version is unavailable.',
    LOADER_VERSION_REQUIRED: 'An exact loader version is required.',
    UNSUPPORTED_LOADER: 'The selected server loader is unsupported.'
  };
  const normalizedCode = Object.hasOwn(messages, code) ? code : 'RUNTIME_INCOMPLETE';
  const error = new Error(messages[normalizedCode]);
  error.code = normalizedCode;
  return error;
}

function runtimeCancellation() {
  const error = new Error('Runtime preparation was cancelled.');
  error.code = 'CANCELLED';
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every(key => allowed.has(key));
}

function positiveSafeInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw runtimeFailure();
  return number;
}

function readAbortSignalAborted(signal) {
  const getter = Object.getOwnPropertyDescriptor(globalThis.AbortSignal?.prototype || {}, 'aborted')?.get;
  if (typeof getter !== 'function') throw runtimeFailure();
  return getter.call(signal);
}

function validAbortSignal(signal) {
  if (signal === undefined || signal === null) return true;
  try {
    if (typeof signal !== 'object' || typeof readAbortSignalAborted(signal) !== 'boolean' ||
        typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' ||
        typeof signal.throwIfAborted !== 'function') return false;
    return true;
  } catch {
    return false;
  }
}

function normalizedClientOptions(options) {
  if (!isPlainObject(options)) throw runtimeFailure();
  if (Object.getOwnPropertySymbols(options).length > 0) throw runtimeFailure();
  const captured = {};
  for (const key of Object.getOwnPropertyNames(options)) captured[key] = options[key];
  const operation = captured.operation === undefined ? MANAGED_RUNTIME_PREPARE_OPERATION : captured.operation;
  if (!OPERATIONS.has(operation)) throw runtimeFailure();
  const commonKeys = ['operation', 'targetPath', 'runtime', 'signal', 'timeoutMs', 'terminationGraceMs'];
  const allowedKeys = new Set(operation === MANAGED_RUNTIME_PREPARE_OPERATION
    ? [...commonKeys, 'javaPath']
    : commonKeys);
  if (!hasOnlyKeys(captured, allowedKeys) || !validAbortSignal(captured.signal)) throw runtimeFailure();
  const timeoutMs = positiveSafeInteger(
    captured.timeoutMs,
    operation === MANAGED_RUNTIME_PREPARE_OPERATION ? DEFAULT_PREPARE_TIMEOUT_MS : DEFAULT_VERIFY_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  const terminationGraceMs = positiveSafeInteger(
    captured.terminationGraceMs,
    DEFAULT_TERMINATION_GRACE_MS,
    MAX_TERMINATION_GRACE_MS
  );
  return { ...captured, operation, timeoutMs, terminationGraceMs };
}

function sanitizedWorkerEnvironment(executable, token) {
  const env = {
    PATH: path.dirname(executable),
    ELECTRON_RUN_AS_NODE: '1',
    [MANAGED_RUNTIME_WORKER_TOKEN_ENV]: token
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function createManagedRuntimeWorkerClient(dependencies = {}) {
  const forkImpl = dependencies.forkImpl || childProcess.fork;
  const platform = dependencies.platform || process.platform;
  const workerPath = dependencies.workerPath || path.join(__dirname, 'managed-runtime-worker.cjs');
  const execPath = dependencies.execPath || process.execPath;
  const tokenFactory = dependencies.tokenFactory || (() => crypto.randomBytes(32).toString('hex'));
  const requestIdFactory = dependencies.requestIdFactory || (() => crypto.randomBytes(16).toString('hex'));

  return function runManagedRuntimeWorker(options = {}) {
    let normalized;
    let token;
    let requestId;
    let request;
    try {
      normalized = normalizedClientOptions(options);
      if (normalized.signal && readAbortSignalAborted(normalized.signal)) throw runtimeCancellation();
      token = tokenFactory();
      requestId = requestIdFactory();
      request = createManagedRuntimeRequest({
        token,
        requestId,
        operation: normalized.operation,
        payload: normalized.operation === MANAGED_RUNTIME_PREPARE_OPERATION
          ? { targetPath: normalized.targetPath, runtime: normalized.runtime, javaPath: normalized.javaPath }
          : { targetPath: normalized.targetPath, runtime: normalized.runtime }
      });
    } catch (error) {
      return Promise.reject(error?.code === 'CANCELLED' ? error : runtimeFailure());
    }

    return new Promise((resolve, reject) => {
      let child = null;
      let settled = false;
      let response = null;
      let terminationError = null;
      let requestMayBeAccepted = false;
      let deadlineTimer = null;
      let forcedSettlementTimer = null;
      let recordClosure;
      let observesClosure = false;
      const closed = new Promise(resolve => { recordClosure = resolve; });

      const onAbort = () => beginTermination(runtimeCancellation());
      const cleanup = () => {
        clearTimeout(deadlineTimer);
        clearTimeout(forcedSettlementTimer);
        try { normalized.signal?.removeEventListener?.('abort', onAbort); } catch { /* already terminating */ }
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          if (error.preserveWorkspace === true) retainRuntimeWorkerQuiescence(error, closed);
          reject(error);
        } else resolve(value);
      };
      const forceKill = target => {
        try { target?.kill?.('SIGKILL'); } catch { /* preserve-workspace settlement remains authoritative */ }
      };
      const disconnectWorker = target => {
        try { target?.disconnect?.(); } catch { /* preserve-workspace settlement remains authoritative */ }
      };
      function awaitAuthenticatedFailureClose(error) {
        terminationError = error;
        terminationError.preserveWorkspace = true;
        clearTimeout(deadlineTimer);
        // A valid failure response declares settled work and the worker owns
        // its send/disconnect/exit sequence. Parent disconnect can consume IPC
        // EOF before Node accounts for it, suppressing ChildProcess.close.
        // Bound public rejection, but retain the exact close proof if late.
        forcedSettlementTimer = setTimeout(() => finish(terminationError), normalized.terminationGraceMs);
        forcedSettlementTimer.unref?.();
      }
      function beginTermination(error) {
        if (settled || terminationError) return;
        terminationError = error;
        terminationError.preserveWorkspace = true;
        clearTimeout(deadlineTimer);
        // Preparation may own Java or nested Forge workers. Let the worker
        // retain those children until its operation settles instead of killing
        // only the outer process and orphaning descendants.
        if (requestMayBeAccepted) disconnectWorker(child);
        else forceKill(child);
        if (settled) return;
        forcedSettlementTimer = setTimeout(() => finish(terminationError), normalized.terminationGraceMs);
        forcedSettlementTimer.unref?.();
      }

      try {
        child = forkImpl(workerPath, [], {
          cwd: path.dirname(execPath),
          env: sanitizedWorkerEnvironment(execPath, token),
          execPath,
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
          detached: platform !== 'win32'
        });
      } catch {
        finish(runtimeFailure());
        return;
      }

      let validChild = false;
      try {
        validChild = Boolean(child) && typeof child.on === 'function' && typeof child.once === 'function' &&
          typeof child.send === 'function' && typeof child.disconnect === 'function' &&
          typeof child.kill === 'function';
      } catch {
        validChild = false;
      }
      if (!validChild) {
        recordClosure(false);
        const failure = runtimeFailure();
        failure.preserveWorkspace = true;
        forceKill(child);
        finish(failure);
        return;
      }

      try {
        child.on('message', message => {
          if (settled || terminationError) return;
          if (response) {
            beginTermination(runtimeFailure());
            return;
          }
          try {
            response = verifyManagedRuntimeResponse(
              message,
              token,
              requestId,
              normalized.operation,
              request.payload.runtime
            );
            if (!response.ok) awaitAuthenticatedFailureClose(Object.assign(runtimeFailure(response.code),
              response.runtimeDiagnostic ? { runtimeDiagnostic: response.runtimeDiagnostic } : {}));
          } catch {
            beginTermination(runtimeFailure());
          }
        });
        child.once('error', () => {
          if (!settled) beginTermination(runtimeFailure());
        });
        child.once('close', (code, signal) => {
          recordClosure(!requestMayBeAccepted || (signal === null &&
            (code === 65 || (response !== null && (code === 0 || code === 1)))));
          if (terminationError) {
            finish(terminationError);
            return;
          }
          if (code !== 0 || signal !== null || response?.ok !== true) {
            const failure = runtimeFailure();
            failure.preserveWorkspace = true;
            finish(failure);
            return;
          }
          finish(null, normalized.operation === MANAGED_RUNTIME_VERIFY_OPERATION
            ? issueManagedRuntimeValidation(response.result, request.payload.targetPath)
            : response.result);
        });
        observesClosure = true;
      } catch {
        if (!observesClosure) recordClosure(false);
        beginTermination(runtimeFailure());
        return;
      }

      if (normalized.signal) {
        try {
          normalized.signal.addEventListener('abort', onAbort, { once: true });
        } catch {
          beginTermination(runtimeFailure());
          return;
        }
      }
      if (terminationError) return;
      deadlineTimer = setTimeout(() => beginTermination(runtimeFailure()), normalized.timeoutMs);
      deadlineTimer.unref?.();
      try {
        requestMayBeAccepted = true;
        child.send(request, error => { if (error && !settled) beginTermination(runtimeFailure()); });
      } catch {
        beginTermination(runtimeFailure());
      }
      try {
        if (normalized.signal && readAbortSignalAborted(normalized.signal)) onAbort();
      } catch {
        beginTermination(runtimeFailure());
      }
    });
  };
}

const runManagedRuntimeWorker = createManagedRuntimeWorkerClient();

function runManagedRuntimeVerificationWorker(options = {}) {
  return runManagedRuntimeWorker({ ...options, operation: MANAGED_RUNTIME_VERIFY_OPERATION });
}

module.exports = {
  createManagedRuntimeWorkerClient,
  isAppIssuedManagedRuntimeValidation,
  runManagedRuntimeWorker,
  runManagedRuntimeVerificationWorker
};
