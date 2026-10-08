const childProcess = require('node:child_process');
const { retainRuntimeWorkerQuiescence } = require('./runtime-worker-quiescence.cjs');
const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const {
  JAVA_ARCHIVE_WORKER_TOKEN_ENV,
  createJavaArchiveRequest,
  javaArchivePreviousPath,
  javaArchiveStagingPath,
  verifyJavaArchiveResponse
} = require('./java-archive-worker-protocol.cjs');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const MAX_TERMINATION_GRACE_MS = 60 * 1000;
const PUBLICATION_RETRY_DELAYS_MS = Object.freeze([50, 150, 400, 800]);

function failure(code = 'JAVA_EXTRACTION_FAILED') {
  const messages = {
    JAVA_ARCHIVE_UNSAFE: 'The Java runtime archive contains unsafe content.',
    JAVA_ARCHIVE_TOO_LARGE: 'The Java runtime archive exceeded its safety limit.',
    JAVA_EXTRACTION_FAILED: 'The Java runtime archive could not be extracted.',
    JAVA_EXTRACTION_TIMEOUT: 'Java runtime extraction timed out.',
    CANCELLED: 'Java runtime extraction was cancelled.'
  };
  const normalized = Object.hasOwn(messages, code) ? code : 'JAVA_EXTRACTION_FAILED';
  const error = new Error(messages[normalized]);
  error.code = normalized;
  return error;
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function integer(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure();
  return value;
}

function brandedAborted(signal) {
  const getter = Object.getOwnPropertyDescriptor(globalThis.AbortSignal?.prototype || {}, 'aborted')?.get;
  if (typeof getter !== 'function') throw failure();
  return getter.call(signal);
}

function signalValid(signal) {
  if (signal === undefined || signal === null) return true;
  try {
    return typeof signal === 'object' && typeof brandedAborted(signal) === 'boolean' &&
      typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function' &&
      typeof signal.throwIfAborted === 'function';
  } catch { return false; }
}

function options(value) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length > 0) throw failure();
  const allowed = new Set([
    'rootPath', 'archivePath', 'destinationPath', 'maxArchiveBytes',
    'expectedArchiveSize', 'expectedSha256',
    'signal', 'timeoutMs', 'terminationGraceMs'
  ]);
  const captured = {};
  for (const key of Object.getOwnPropertyNames(value)) captured[key] = value[key];
  if (Object.keys(captured).some(key => !allowed.has(key)) || !signalValid(captured.signal)) throw failure();
  return {
    ...captured,
    timeoutMs: integer(captured.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    terminationGraceMs: integer(captured.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, MAX_TERMINATION_GRACE_MS)
  };
}

function environment(executable, token) {
  const result = {
    PATH: path.dirname(executable),
    ELECTRON_RUN_AS_NODE: '1',
    [JAVA_ARCHIVE_WORKER_TOKEN_ENV]: token
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string' && process.env[key]) result[key] = process.env[key];
  }
  return result;
}

function samePath(left, right) {
  const normalize = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function canonicalDirectory(target, fsApi = fsPromises) {
  const stat = await fsApi.lstat(target, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fsApi.realpath(target), target)) throw failure();
  return stat;
}

async function pathStatIfPresent(target, fsApi = fsPromises) {
  try { return await fsApi.lstat(target, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function transientPublicationRenameFailure(error) {
  return error?.code === 'EPERM' || error?.code === 'EBUSY';
}

function publicationRetryDelay(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function renameForPublication(source, destination, fsApi, delayImpl) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsApi.rename(source, destination);
      return;
    } catch (error) {
      const delayMs = PUBLICATION_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !transientPublicationRenameFailure(error)) throw error;
      await delayImpl(delayMs);
    }
  }
}

async function publishJavaArchive({
  rootPath,
  destinationPath,
  stagingPath,
  requestId,
  result
}, fsApi = fsPromises, delayImpl = publicationRetryDelay) {
  await canonicalDirectory(rootPath, fsApi);
  if (!samePath(path.dirname(destinationPath), rootPath) || !samePath(path.dirname(stagingPath), rootPath)) {
    throw failure();
  }
  await canonicalDirectory(stagingPath, fsApi);
  const executablePath = path.resolve(stagingPath, ...result.javaExecutableRelativePath.split('/'));
  if (!inside(stagingPath, executablePath)) throw failure();
  const executable = await fsApi.lstat(executablePath, { bigint: true });
  if (!executable.isFile() || executable.isSymbolicLink() || executable.nlink !== 1n ||
      !samePath(await fsApi.realpath(executablePath), executablePath)) throw failure();

  const previousPath = javaArchivePreviousPath(destinationPath, requestId);
  if (await pathStatIfPresent(previousPath, fsApi)) {
    const error = failure();
    error.preserveWorkspace = true;
    throw error;
  }
  const destination = await pathStatIfPresent(destinationPath, fsApi);
  if (destination && (destination.isSymbolicLink() ||
      (!destination.isDirectory() && (!destination.isFile() || destination.nlink !== 1n)) ||
      !samePath(await fsApi.realpath(destinationPath), destinationPath))) throw failure();

  let movedPrevious = false;
  try {
    if (destination) {
      await renameForPublication(destinationPath, previousPath, fsApi, delayImpl);
      movedPrevious = true;
    }
    await renameForPublication(stagingPath, destinationPath, fsApi, delayImpl);
  } catch (error) {
    if (movedPrevious) {
      try { await renameForPublication(previousPath, destinationPath, fsApi, delayImpl); }
      catch {
        const uncertain = failure();
        uncertain.preserveWorkspace = true;
        throw uncertain;
      }
    }
    throw failure();
  }
  if (movedPrevious) {
    try { await fsApi.rm(previousPath, { recursive: true, force: true }); }
    catch {
      const error = failure();
      error.preserveWorkspace = true;
      throw error;
    }
  }
}

function createJavaArchiveWorkerClient(dependencies = {}) {
  const forkImpl = dependencies.forkImpl || childProcess.fork;
  const platform = dependencies.platform || process.platform;
  const workerPath = dependencies.workerPath || path.join(__dirname, 'java-archive-worker.cjs');
  const execPath = dependencies.execPath || process.execPath;
  const tokenFactory = dependencies.tokenFactory || (() => crypto.randomBytes(32).toString('hex'));
  const requestIdFactory = dependencies.requestIdFactory || (() => crypto.randomBytes(16).toString('hex'));
  const removeImpl = dependencies.removeImpl || (target => fsPromises.rm(target, {
    recursive: true,
    force: true
  }));
  const publicationFsApi = dependencies.publicationFsApi || fsPromises;
  const publicationRetryDelayImpl = dependencies.publicationRetryDelayImpl || publicationRetryDelay;
  const publishImpl = dependencies.publishImpl || (request => publishJavaArchive(
    request,
    publicationFsApi,
    publicationRetryDelayImpl
  ));

  return function runJavaArchiveWorker(value = {}) {
    let normalized;
    let token;
    let requestId;
    let request;
    try {
      normalized = options(value);
      if (normalized.signal && brandedAborted(normalized.signal)) throw failure('CANCELLED');
      token = tokenFactory();
      requestId = requestIdFactory();
      request = createJavaArchiveRequest({
        token,
        requestId,
        payload: {
          rootPath: normalized.rootPath,
          archivePath: normalized.archivePath,
          destinationPath: normalized.destinationPath,
          maxArchiveBytes: normalized.maxArchiveBytes,
          expectedArchiveSize: normalized.expectedArchiveSize,
          expectedSha256: normalized.expectedSha256
        }
      });
    } catch (error) {
      return Promise.reject(error?.code === 'CANCELLED' ? error : failure());
    }

    return new Promise((resolve, reject) => {
      let child = null;
      let settled = false;
      let response = null;
      let terminating = null;
      let deadline = null;
      let forcedSettlement = null;
      let publishing = false;
      let recordClosure;
      let observesClosure = false;
      const closed = new Promise(resolve => { recordClosure = resolve; });
      const stagingPath = javaArchiveStagingPath(normalized.destinationPath, requestId);
      const onAbort = () => { if (!publishing) terminate(failure('CANCELLED')); };
      const cleanup = () => {
        clearTimeout(deadline);
        clearTimeout(forcedSettlement);
        try { normalized.signal?.removeEventListener?.('abort', onAbort); } catch { /* settlement is authoritative */ }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          if (error.preserveWorkspace === true) retainRuntimeWorkerQuiescence(error, closed);
          reject(error);
        } else resolve(result);
      };
      const forceKill = target => { try { target?.kill?.('SIGKILL'); } catch { /* fail closed */ } };
      const settleTerminatedAfterClose = state => {
        clearTimeout(forcedSettlement);
        Promise.resolve()
          .then(() => removeImpl(stagingPath))
          .then(() => {
            recordClosure(true);
            if (state.preserveOnClose) state.error.preserveWorkspace = true;
            finish(state.error);
          }, () => {
            recordClosure(true);
            state.error.preserveWorkspace = true;
            finish(state.error);
          });
      };
      const publishAfterCleanClose = () => {
        publishing = true;
        clearTimeout(deadline);
        clearTimeout(forcedSettlement);
        try { normalized.signal?.removeEventListener?.('abort', onAbort); } catch { /* publication is authoritative */ }
        Promise.resolve()
          .then(() => publishImpl({
            rootPath: normalized.rootPath,
            destinationPath: normalized.destinationPath,
            stagingPath,
            requestId,
            result: response.result
          }))
          .then(() => finish(null, response.result), async error => {
            const publicError = failure();
            if (error?.preserveWorkspace === true) publicError.preserveWorkspace = true;
            try { await removeImpl(stagingPath); }
            catch { publicError.preserveWorkspace = true; }
            recordClosure(true);
            finish(publicError);
          });
      };
      function terminate(error, { kill = true, preserveOnClose = false } = {}) {
        if (settled || terminating) return;
        terminating = { error, preserveOnClose };
        clearTimeout(deadline);
        if (kill) forceKill(child);
        forcedSettlement = setTimeout(() => {
          error.preserveWorkspace = true;
          if (!kill) forceKill(child);
          finish(error);
        }, normalized.terminationGraceMs);
        forcedSettlement.unref?.();
      }

      try {
        child = forkImpl(workerPath, [], {
          cwd: path.dirname(execPath),
          env: environment(execPath, token),
          execPath,
          execArgv: [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
          detached: platform !== 'win32'
        });
      } catch { finish(failure()); return; }

      let valid = false;
      try {
        valid = Boolean(child) && typeof child.on === 'function' && typeof child.once === 'function' &&
          typeof child.send === 'function' && typeof child.kill === 'function';
      } catch { valid = false; }
      if (!valid) {
        recordClosure(false);
        const error = failure();
        error.preserveWorkspace = true;
        forceKill(child);
        finish(error);
        return;
      }

      try {
        child.on('message', message => {
          if (settled || terminating) return;
          if (response) { terminate(failure(), { preserveOnClose: true }); return; }
          try {
            response = verifyJavaArchiveResponse(message, token, requestId);
            if (!response.ok) terminate(failure(response.code), { kill: false });
          } catch { terminate(failure(), { preserveOnClose: true }); }
        });
        child.once('error', () => terminate(failure(), { preserveOnClose: true }));
        child.once('close', (code, closeSignal) => {
          if (terminating) {
            settleTerminatedAfterClose(terminating);
            return;
          }
          if (code !== 0 || closeSignal !== null || response?.ok !== true) {
            settleTerminatedAfterClose({ error: failure(), preserveOnClose: false });
            return;
          }
          publishAfterCleanClose();
        });
        observesClosure = true;
      } catch {
        if (!observesClosure) recordClosure(false);
        terminate(failure(), { preserveOnClose: true });
        return;
      }

      if (normalized.signal) {
        try { normalized.signal.addEventListener('abort', onAbort, { once: true }); }
        catch { terminate(failure(), { preserveOnClose: true }); return; }
      }
      deadline = setTimeout(() => terminate(failure('JAVA_EXTRACTION_TIMEOUT')), normalized.timeoutMs);
      deadline.unref?.();
      try { child.send(request, error => {
        if (error && !settled) terminate(failure(), { preserveOnClose: true });
      }); }
      catch { terminate(failure(), { preserveOnClose: true }); }
      try { if (normalized.signal && brandedAborted(normalized.signal)) onAbort(); }
      catch { terminate(failure(), { preserveOnClose: true }); }
    });
  };
}

const runJavaArchiveWorker = createJavaArchiveWorkerClient();

module.exports = { createJavaArchiveWorkerClient, runJavaArchiveWorker };
