const path = require('node:path');
const { Worker } = require('node:worker_threads');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_REQUEST_ID = 2_147_483_647;
const MAX_PENDING_REQUESTS = 64;
const MAX_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WORKER_PATH = path.join(__dirname, 'candidate-hash-worker.cjs');
const IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'size', 'nlink', 'type']);
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function error(code, message) {
  const result = new Error(message);
  result.code = code;
  return result;
}

function unavailable() {
  return error('CANDIDATE_HASH_WORKER_UNAVAILABLE', 'The candidate hashing worker is unavailable');
}

function failed() {
  return error('CANDIDATE_HASH_FAILED', 'The candidate file could not be hashed safely');
}

function disposed() {
  return error('CANDIDATE_HASH_SERVICE_DISPOSED', 'The candidate hashing service is disposed');
}

function abortError() {
  const result = new Error('The candidate hash request was aborted');
  result.name = 'AbortError';
  result.code = 'ABORT_ERR';
  return result;
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0;
}

function fileIdentityFromStat(stat) {
  if (!stat || typeof stat.isFile !== 'function' || typeof stat.dev !== 'bigint' ||
      typeof stat.ino !== 'bigint' || typeof stat.birthtimeNs !== 'bigint' ||
      typeof stat.mtimeNs !== 'bigint' || typeof stat.size !== 'bigint' || typeof stat.nlink !== 'bigint') {
    throw new TypeError('Candidate file identity source is invalid');
  }
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    size: stat.size.toString(),
    nlink: stat.nlink.toString(),
    type: stat.isFile() ? 'file' : 'other'
  });
}

function validIdentity(value) {
  return plain(value) && Object.keys(value).join(',') === IDENTITY_KEYS.join(',') &&
    DECIMAL.test(value.dev) && DECIMAL.test(value.ino) && SIGNED_DECIMAL.test(value.birthtimeNs) &&
    SIGNED_DECIMAL.test(value.mtimeNs) && DECIMAL.test(value.size) && DECIMAL.test(value.nlink) &&
    value.nlink === '1' && value.type === 'file';
}

function sameFileIdentity(left, right) {
  return validIdentity(left) && validIdentity(right) && IDENTITY_KEYS.every(key => left[key] === right[key]);
}

function validSignal(signal) {
  return signal === undefined || signal === null || (typeof signal === 'object' &&
    typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function');
}

function serializedBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

function validResult(value, expectedIdentity) {
  return plain(value) && Object.keys(value).join(',') === 'sha256,size,identity' &&
    SHA256.test(value.sha256) && DECIMAL.test(value.size) && value.size === expectedIdentity.size &&
    sameFileIdentity(value.identity, expectedIdentity);
}

class PersistentCandidateHashService {
  constructor({
    workerPath = DEFAULT_WORKER_PATH,
    workerFactory = (filename, options) => new Worker(filename, options),
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  } = {}) {
    if (typeof workerPath !== 'string' || !path.isAbsolute(workerPath) || workerPath.includes('\0') ||
        Buffer.byteLength(workerPath, 'utf8') > MAX_PATH_BYTES || typeof workerFactory !== 'function' ||
        !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > MAX_IDLE_TIMEOUT_MS ||
        !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
        requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new TypeError('Candidate hashing service dependencies are invalid');
    }
    this.workerPath = workerPath;
    this.workerFactory = workerFactory;
    this.idleTimeoutMs = idleTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.workerRecord = null;
    this.nextRequestId = 1;
    this.disposed = false;
    this.retirements = new Set();
    this.terminationFailed = false;
    this.disposalPromise = null;
  }

  hashFile(filePath, { expectedIdentity, signal } = {}) {
    if (this.disposed) return Promise.reject(disposed());
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.includes('\0') ||
        Buffer.byteLength(filePath, 'utf8') > MAX_PATH_BYTES || !validIdentity(expectedIdentity) ||
        !validSignal(signal)) return Promise.reject(failed());
    if (signal?.aborted) return Promise.reject(abortError());
    let record;
    try { record = this.workerRecord || this.#spawnWorker(); }
    catch { return Promise.reject(unavailable()); }
    if (record.closed || record.pending.size >= MAX_PENDING_REQUESTS) {
      this.#failWorker(record, unavailable());
      return Promise.reject(unavailable());
    }
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
    const id = this.#allocateRequestId(record);
    const request = {
      version: PROTOCOL_VERSION,
      type: 'hash',
      id,
      path: filePath,
      expectedIdentity: { ...expectedIdentity }
    };
    if (serializedBytes(request) > MAX_MESSAGE_BYTES) return Promise.reject(failed());

    return new Promise((resolve, reject) => {
      let abortListener = null;
      const timeout = setTimeout(() => this.#failWorker(record, unavailable()), this.requestTimeoutMs);
      timeout.unref?.();
      const cleanup = () => {
        clearTimeout(timeout);
        if (abortListener) {
          try { signal.removeEventListener('abort', abortListener); } catch { /* request still fails closed */ }
        }
      };
      const pending = { id, expectedIdentity: request.expectedIdentity, resolve, reject, cleanup };
      record.pending.set(id, pending);
      record.worker.ref?.();
      if (signal) {
        abortListener = () => this.#abortRequest(record, id);
        try { signal.addEventListener('abort', abortListener, { once: true }); }
        catch {
          this.#failWorker(record, unavailable());
          return;
        }
        if (signal.aborted) {
          abortListener();
          return;
        }
      }
      try { record.worker.postMessage(request); }
      catch { this.#failWorker(record, unavailable()); }
    });
  }

  dispose() {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    const record = this.workerRecord;
    if (record) this.#failWorker(record, disposed());
    // Abort, failure and idle retirement clear workerRecord before termination
    // finishes. Drain every generation, even when one termination has failed.
    this.disposalPromise = (async () => {
      await Promise.all([...this.retirements]);
      if (this.terminationFailed) throw unavailable();
    })();
    return this.disposalPromise;
  }

  #allocateRequestId(record) {
    for (let attempt = 0; attempt <= MAX_PENDING_REQUESTS; attempt += 1) {
      const id = this.nextRequestId;
      this.nextRequestId = id >= MAX_REQUEST_ID ? 1 : id + 1;
      if (!record.pending.has(id)) return id;
    }
    throw unavailable();
  }

  #spawnWorker() {
    const worker = this.workerFactory(this.workerPath, {
      name: 'minecraft-core-candidate-hash-worker'
    });
    if (!worker || typeof worker.on !== 'function' || typeof worker.postMessage !== 'function' ||
        typeof worker.terminate !== 'function') throw unavailable();
    const record = { worker, pending: new Map(), idleTimer: null, closed: false, termination: null };
    this.workerRecord = record;
    worker.on('message', message => this.#handleMessage(record, message));
    worker.on('messageerror', () => this.#failWorker(record, unavailable()));
    worker.on('error', () => this.#failWorker(record, unavailable()));
    worker.on('exit', code => {
      if (!record.closed && (code !== 0 || record.pending.size > 0)) this.#failWorker(record, unavailable(), false);
      else if (this.workerRecord === record) this.workerRecord = null;
    });
    worker.unref?.();
    return record;
  }

  #handleMessage(record, message) {
    if (record.closed || this.workerRecord !== record || serializedBytes(message) > MAX_MESSAGE_BYTES || !plain(message)) {
      this.#failWorker(record, unavailable());
      return;
    }
    const success = Object.keys(message).join(',') === 'version,id,ok,result' && message.ok === true;
    const failure = Object.keys(message).join(',') === 'version,id,ok,error' && message.ok === false &&
      message.error === 'HASH_FAILED';
    if ((!success && !failure) || message.version !== PROTOCOL_VERSION || !Number.isSafeInteger(message.id) ||
        message.id < 1 || message.id > MAX_REQUEST_ID) {
      this.#failWorker(record, unavailable());
      return;
    }
    const pending = record.pending.get(message.id);
    if (!pending || (success && !validResult(message.result, pending.expectedIdentity))) {
      this.#failWorker(record, unavailable());
      return;
    }
    record.pending.delete(message.id);
    pending.cleanup();
    if (success) {
      pending.resolve(Object.freeze({
        sha256: message.result.sha256,
        size: message.result.size,
        identity: Object.freeze({ ...message.result.identity })
      }));
    } else {
      pending.reject(failed());
    }
    if (record.pending.size === 0) this.#scheduleIdleShutdown(record);
  }

  #abortRequest(record, id) {
    if (record.closed) return;
    const pending = record.pending.get(id);
    if (!pending) return;
    record.pending.delete(id);
    pending.cleanup();
    pending.reject(abortError());
    this.#failWorker(record, unavailable());
  }

  #scheduleIdleShutdown(record) {
    record.worker.unref?.();
    clearTimeout(record.idleTimer);
    record.idleTimer = setTimeout(() => this.#closeWorker(record), this.idleTimeoutMs);
    record.idleTimer.unref?.();
  }

  #closeWorker(record) {
    if (record.closed) return record.termination || Promise.resolve();
    record.closed = true;
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
    if (this.workerRecord === record) this.workerRecord = null;
    return this.#terminateWorker(record);
  }

  #failWorker(record, reason, terminate = true) {
    if (record.closed) return record.termination || Promise.resolve();
    record.closed = true;
    clearTimeout(record.idleTimer);
    record.idleTimer = null;
    if (this.workerRecord === record) this.workerRecord = null;
    for (const pending of record.pending.values()) {
      pending.cleanup();
      pending.reject(reason);
    }
    record.pending.clear();
    if (!terminate) return Promise.resolve();
    return this.#terminateWorker(record);
  }

  #terminateWorker(record) {
    let finish;
    record.termination = new Promise(resolve => { finish = resolve; });
    this.retirements.add(record.termination);
    const settled = failed => {
      if (failed) this.terminationFailed = true;
      this.retirements.delete(record.termination);
      finish();
    };
    // Event callbacks must not leak rejected promises. Remember failure for
    // dispose(), whose successful result is the operation's quiescence proof.
    try { Promise.resolve(record.worker.terminate()).then(() => settled(false), () => settled(true)); }
    catch { settled(true); }
    return record.termination;
  }
}

module.exports = {
  PersistentCandidateHashService,
  fileIdentityFromStat,
  sameFileIdentity
};
