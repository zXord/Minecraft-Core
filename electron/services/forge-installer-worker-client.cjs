const childProcess = require('node:child_process');
const { retainRuntimeWorkerQuiescence } = require('./runtime-worker-quiescence.cjs');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  FORGE_WORKER_TOKEN_ENV,
  createForgeInstallRequest,
  verifyForgeInstallResponse
} = require('./forge-installer-worker-protocol.cjs');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 5000;

function workerFailure() {
  const error = new Error('The Forge loader installer failed.');
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

function sanitizedWorkerEnvironment(executable, token) {
  const env = {
    PATH: path.dirname(executable),
    ELECTRON_RUN_AS_NODE: '1',
    [FORGE_WORKER_TOKEN_ENV]: token
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string' && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function createForgeInstallerWorkerClient(dependencies = {}) {
  const forkImpl = dependencies.forkImpl || childProcess.fork;
  const platform = dependencies.platform || process.platform;
  const workerPath = dependencies.workerPath || path.join(__dirname, 'forge-installer-worker.cjs');
  const execPath = dependencies.execPath || process.execPath;
  const tokenFactory = dependencies.tokenFactory || (() => crypto.randomBytes(32).toString('hex'));
  const requestIdFactory = dependencies.requestIdFactory || (() => crypto.randomBytes(16).toString('hex'));

  return function runForgeInstallerWorker(options = {}) {
    if (options.signal?.aborted) return Promise.reject(workerCancellation());
    const timeoutMs = positiveSafeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const terminationGraceMs = positiveSafeInteger(
      options.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
      60 * 1000
    );
    let token;
    let requestId;
    let request;
    try {
      token = tokenFactory();
      requestId = requestIdFactory();
      request = createForgeInstallRequest({
        token,
        requestId,
        payload: {
          targetPath: options.targetPath,
          minecraftVersion: options.minecraftVersion,
          loaderVersion: options.loaderVersion,
          javaPath: options.javaPath
        }
      });
    } catch {
      return Promise.reject(workerFailure());
    }

    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let response = null;
      let processError = null;
      let terminationError = null;
      let requestMayBeAccepted = false;
      let deadlineTimer = null;
      let forcedSettlementTimer = null;
      let recordClosure;
      let observesClosure = false;
      const closed = new Promise(resolve => { recordClosure = resolve; });

      const onAbort = () => beginTermination(workerCancellation());
      const cleanup = () => {
        clearTimeout(deadlineTimer);
        clearTimeout(forcedSettlementTimer);
        try { options.signal?.removeEventListener?.('abort', onAbort); } catch { /* already terminating */ }
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
      const disconnectWorker = () => {
        try { child.disconnect(); } catch { /* bounded preserve-workspace settlement remains authoritative */ }
      };
      function awaitAuthenticatedFailureClose(error) {
        if (settled || terminationError) return;
        terminationError = error;
        terminationError.preserveWorkspace = true;
        clearTimeout(deadlineTimer);
        // Let the authenticated worker complete its own send/disconnect/exit.
        // Parent disconnect here can suppress IPC EOF close accounting. A
        // bounded rejection still retains only the exact child close proof.
        forcedSettlementTimer = setTimeout(() => finish(terminationError), terminationGraceMs);
        forcedSettlementTimer.unref?.();
      }
      function beginTermination(error) {
        if (settled || terminationError) return;
        terminationError = error;
        terminationError.preserveWorkspace = true;
        clearTimeout(deadlineTimer);
        // This worker can own Forge Java processor children. Closing its IPC
        // channel asks it to finish those owned children; killing only the
        // outer Node process would orphan them on Windows.
        if (requestMayBeAccepted) disconnectWorker();
        else forceKill();
        if (settled) return;
        forcedSettlementTimer = setTimeout(() => {
          terminationError.preserveWorkspace = true;
          finish(terminationError);
        }, terminationGraceMs);
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
          typeof child.send === 'function' && typeof child.disconnect === 'function' &&
          typeof child.kill === 'function';
      } catch {
        validChild = false;
      }
      if (!validChild) {
        recordClosure(false);
        const error = workerFailure();
        error.preserveWorkspace = true;
        forceKill();
        finish(error);
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
          response = verifyForgeInstallResponse(message, token, requestId);
          if (!response.ok) awaitAuthenticatedFailureClose(Object.assign(workerFailure(),
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
        recordClosure(!requestMayBeAccepted || (signal === null &&
          (code === 65 || (response !== null && (code === 0 || code === 1)))));
        if (terminationError) {
          finish(terminationError);
          return;
        }
        if (processError || code !== 0 || signal !== null || response?.ok !== true) {
          const error = processError || workerFailure();
          error.preserveWorkspace = true;
          finish(error);
          return;
        }
        finish(null, { success: true });
        });
        observesClosure = true;
      } catch {
        if (!observesClosure) recordClosure(false);
        beginTermination(workerFailure());
        return;
      }

      if (options.signal) {
        try { options.signal.addEventListener('abort', onAbort, { once: true }); }
        catch {
          beginTermination(workerFailure());
          return;
        }
      }
      if (terminationError) return;
      deadlineTimer = setTimeout(() => beginTermination(workerFailure()), timeoutMs);
      deadlineTimer.unref?.();
      try {
        requestMayBeAccepted = true;
        child.send(request, error => { if (error && !settled) beginTermination(workerFailure()); });
      } catch {
        beginTermination(workerFailure());
      }
      if (options.signal?.aborted) onAbort();
    });
  };
}

const runForgeInstallerWorker = createForgeInstallerWorkerClient();

module.exports = {
  createForgeInstallerWorkerClient,
  runForgeInstallerWorker
};
