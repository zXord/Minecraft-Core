const childProcess = require('node:child_process');
const { retainRuntimeWorkerQuiescence } = require('./runtime-worker-quiescence.cjs');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  FORGE_FINALIZER_TOKEN_ENV,
  createForgeFinalizerRequest,
  verifyForgeFinalizerResponse
} = require('./forge-runtime-finalizer-worker-protocol.cjs');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const MAX_TERMINATION_GRACE_MS = 60 * 1000;

function workerFailure() {
  const error = new Error('The Forge runtime finalizer failed.');
  error.code = 'RUNTIME_INCOMPLETE';
  return error;
}

function workerCancellation() {
  const error = new Error('Runtime preparation was cancelled.');
  error.code = 'CANCELLED';
  return error;
}

function positiveSafeInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw workerFailure();
  return number;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every(key => allowed.has(key));
}

function readAbortSignalAborted(signal) {
  const getter = Object.getOwnPropertyDescriptor(globalThis.AbortSignal?.prototype || {}, 'aborted')?.get;
  if (typeof getter !== 'function') throw workerFailure();
  return getter.call(signal);
}

function validAbortSignal(signal) {
  if (signal === undefined || signal === null) return true;
  try {
    return typeof signal === 'object' && typeof readAbortSignalAborted(signal) === 'boolean' &&
      typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function' &&
      typeof signal.throwIfAborted === 'function';
  } catch {
    return false;
  }
}

function normalizedClientOptions(options) {
  const allowedKeys = new Set(['targetPath', 'runtime', 'signal', 'timeoutMs', 'terminationGraceMs']);
  if (!hasOnlyKeys(options, allowedKeys)) throw workerFailure();
  const signal = options.signal;
  if (!validAbortSignal(signal)) throw workerFailure();
  return {
    signal,
    timeoutMs: positiveSafeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    terminationGraceMs: positiveSafeInteger(
      options.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
      MAX_TERMINATION_GRACE_MS
    )
  };
}

function sanitizedWorkerEnvironment(executable, token) {
  const env = {
    PATH: path.dirname(executable),
    ELECTRON_RUN_AS_NODE: '1',
    [FORGE_FINALIZER_TOKEN_ENV]: token
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function createForgeRuntimeFinalizerWorkerClient(dependencies = {}) {
  const forkImpl = dependencies.forkImpl || childProcess.fork;
  const platform = dependencies.platform || process.platform;
  const workerPath = dependencies.workerPath || path.join(__dirname, 'forge-runtime-finalizer-worker.cjs');
  const execPath = dependencies.execPath || process.execPath;
  const tokenFactory = dependencies.tokenFactory || (() => crypto.randomBytes(32).toString('hex'));
  const requestIdFactory = dependencies.requestIdFactory || (() => crypto.randomBytes(16).toString('hex'));

  return function runForgeRuntimeFinalizerWorker(options = {}) {
    let normalized;
    let token;
    let requestId;
    let request;
    try {
      normalized = normalizedClientOptions(options);
      if (normalized.signal && readAbortSignalAborted(normalized.signal)) throw workerCancellation();
      token = tokenFactory();
      requestId = requestIdFactory();
      request = createForgeFinalizerRequest({
        token,
        requestId,
        payload: { targetPath: options.targetPath, runtime: options.runtime }
      });
    } catch (error) {
      return Promise.reject(error?.code === 'CANCELLED' ? error : workerFailure());
    }

    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let response = null;
      let processError = null;
      let terminationError = null;
      let deadlineTimer = null;
      let forcedSettlementTimer = null;
      let recordClosure;
      let observesClosure = false;
      const closed = new Promise(resolve => { recordClosure = resolve; });

      const onAbort = () => beginTermination(workerCancellation());
      const cleanup = () => {
        clearTimeout(deadlineTimer);
        clearTimeout(forcedSettlementTimer);
        try { normalized.signal?.removeEventListener?.('abort', onAbort); } catch { /* already settling */ }
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
      const forceKill = () => {
        try { child.kill('SIGKILL'); } catch { /* bounded preserve-workspace settlement remains authoritative */ }
      };
      function beginTermination(error) {
        if (settled || terminationError) return;
        terminationError = error;
        error.preserveWorkspace = true;
        clearTimeout(deadlineTimer);
        forceKill();
        if (settled) return;
        forcedSettlementTimer = setTimeout(() => {
          terminationError.preserveWorkspace = true;
          finish(terminationError);
        }, normalized.terminationGraceMs);
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
        finish(workerFailure());
        return;
      }
      let validChild = false;
      try {
        validChild = Boolean(child) && typeof child.on === 'function' && typeof child.once === 'function' &&
          typeof child.send === 'function' && typeof child.kill === 'function';
      } catch {
        validChild = false;
      }
      if (!validChild) {
        recordClosure(false);
        const failure = workerFailure();
        failure.preserveWorkspace = true;
        forceKill();
        finish(failure);
        return;
      }

      try {
        child.on('message', message => {
          if (settled) return;
          if (response) {
            beginTermination(workerFailure());
            return;
          }
          try {
            response = verifyForgeFinalizerResponse(message, token, requestId, request.payload.runtime);
            if (!response.ok) beginTermination(Object.assign(workerFailure(),
              response.runtimeDiagnostic ? { runtimeDiagnostic: response.runtimeDiagnostic } : {}));
          } catch {
            beginTermination(workerFailure());
          }
        });
        child.once('error', () => {
          if (settled) return;
          processError = workerFailure();
          beginTermination(processError);
        });
        child.once('close', (code, signal) => {
          recordClosure(true);
          if (terminationError) {
            finish(terminationError);
            return;
          }
          if (processError || code !== 0 || signal !== null || response?.ok !== true) {
            const failure = processError || workerFailure();
            failure.preserveWorkspace = true;
            finish(failure);
            return;
          }
          finish(null, response.validation);
        });
        observesClosure = true;
      } catch {
        if (!observesClosure) recordClosure(false);
        beginTermination(workerFailure());
        return;
      }

      if (normalized.signal) {
        try {
          normalized.signal.addEventListener('abort', onAbort, { once: true });
        } catch {
          beginTermination(workerFailure());
          return;
        }
      }
      deadlineTimer = setTimeout(() => beginTermination(workerFailure()), normalized.timeoutMs);
      deadlineTimer.unref?.();
      try {
        child.send(request, error => { if (error && !settled) beginTermination(workerFailure()); });
      } catch {
        beginTermination(workerFailure());
      }
      try {
        if (normalized.signal && readAbortSignalAborted(normalized.signal)) onAbort();
      } catch {
        beginTermination(workerFailure());
      }
    });
  };
}

const runForgeRuntimeFinalizerWorker = createForgeRuntimeFinalizerWorkerClient();

module.exports = {
  createForgeRuntimeFinalizerWorkerClient,
  runForgeRuntimeFinalizerWorker
};
