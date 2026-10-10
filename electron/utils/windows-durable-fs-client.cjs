const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ModpackError } = require('../services/modpacks/errors.cjs');
const { isSafeWindowsBasename } = require('../services/modpacks/windows-basename.cjs');
const { WindowsReparseInspector } = require('../services/modpacks/local/windows-reparse-inspector.cjs');
const {
  MAX_FRAME_BYTES,
  createExtractionBlockedEnvironment,
  encodeFrame,
  parseStrictJson,
  getBrokerBundleRecoveryDiagnostics,
  recoverBrokerBundles,
  verifyArchiveWorkerExecutable,
  verifyArchiveWorkerExecutableSync
} = require('../services/modpacks/archive/archive-worker-client.cjs');

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 30 * 1000;
const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_ALLOWED_ROOTS = 16;
// A directory request consumes 21 strict-JSON tokens. 512 leaves headroom for
// the maximum 16 allowed roots inside the native worker's 16,384-token frame.
const MAX_FLUSH_DIRECTORIES = 512;
const DEFAULT_TERMINATION_GRACE_MS = 5000;
const MAX_TERMINATION_GRACE_MS = 60 * 1000;
const DURABLE_FAILURE_KINDS = Object.freeze([
  'sharing-violation',
  'access-denied',
  'timeout',
  'integrity-failure',
  'io-failure',
  'worker-failure'
]);
const DURABLE_FAILURE_STAGES = Object.freeze([
  'root-open',
  'source-open',
  'destination-parent-open',
  'source-parent-open',
  'ancestor-open',
  'preflight-revalidation',
  'handle-rename',
  'completion-flush',
  'published-identity',
  'final-revalidation',
  'request'
]);
const WINDOWS_DURABLE_FS_CAPABILITIES = Object.freeze({
  moveWriteThroughFlushesParents: true,
  reconcileMoveWriteThrough: true
});

function failed(cause) {
  return new ModpackError('COMMIT_FAILED', 'Durable filesystem operation failed', { cause });
}

function durableFailure(failureKind, failureStage) {
  const error = failed();
  Object.defineProperty(error, 'durableFailureKind', {
    value: failureKind,
    enumerable: true,
    configurable: false,
    writable: false
  });
  Object.defineProperty(error, 'durableFailureStage', {
    value: failureStage,
    enumerable: true,
    configurable: false,
    writable: false
  });
  return error;
}

function containsReparsePoint(candidate) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return true;
  }
  if (fs.existsSync(resolved) && fs.realpathSync.native(resolved).toLocaleLowerCase('en-US') !== resolved.toLocaleLowerCase('en-US')) return true;
  return false;
}

function safeAbsolute(candidate) {
  if (typeof candidate !== 'string' || !path.win32.isAbsolute(candidate) || candidate.startsWith('\\\\') || candidate.startsWith('\\?\\') || candidate.startsWith('\\.\\')) return false;
  const parsed = path.win32.parse(candidate);
  const tail = candidate.slice(parsed.root.length);
  const components = tail.split(/[\\/]/).filter(Boolean);
  return !tail.includes(':') && !candidate.includes('\0') && components.every(component => isSafeWindowsBasename(component));
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function decodeResponse(stdout) {
  if (!Buffer.isBuffer(stdout) || stdout.length < 6 || stdout.length > MAX_RESPONSE_BYTES) throw failed();
  const length = stdout.readUInt32LE(0);
  if (length !== stdout.length - 4) throw failed();
  let value;
  try { value = parseStrictJson(stdout.subarray(4)); } catch (error) { throw failed(error); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed();
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'ok' && value.ok === true) return;
  if (keys.length === 3 && Object.hasOwn(value, 'ok') && Object.hasOwn(value, 'failureKind') &&
      Object.hasOwn(value, 'failureStage') && value.ok === false && DURABLE_FAILURE_KINDS.includes(value.failureKind) &&
      DURABLE_FAILURE_STAGES.includes(value.failureStage)) throw durableFailure(value.failureKind, value.failureStage);
  throw failed();
}

function identityFromStat(stat, fileType, sha256) {
  return Object.freeze({
    fileType,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs),
    mtime: String(stat.mtimeNs ?? stat.mtimeMs),
    ctime: String(stat.ctimeNs ?? stat.ctimeMs),
    ...(sha256 === undefined ? {} : { sha256 })
  });
}

function sameIdentity(left, right) {
  if (left.fileType !== right.fileType || left.dev !== right.dev || left.ino !== right.ino || left.birthtime !== right.birthtime) return false;
  return left.fileType === 'directory' || (left.size === right.size && left.mtime === right.mtime && left.sha256 === right.sha256);
}

function captureIdentity(candidate, expectedType) {
  const initial = fs.lstatSync(candidate, { bigint: true });
  if (initial.isSymbolicLink() || (expectedType === 'file' ? !initial.isFile() : !initial.isDirectory())) throw failed();
  if (expectedType === 'directory') {
    const final = fs.lstatSync(candidate, { bigint: true });
    const before = identityFromStat(initial, 'directory');
    const after = identityFromStat(final, 'directory');
    if (!sameIdentity(before, after)) throw failed();
    return before;
  }
  const descriptor = fs.openSync(candidate, 'r');
  try {
    const beforeStat = fs.fstatSync(descriptor, { bigint: true });
    if (!beforeStat.isFile()) throw failed();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    buffer.fill(0);
    const afterStat = fs.fstatSync(descriptor, { bigint: true });
    const pathStat = fs.lstatSync(candidate, { bigint: true });
    const digest = hash.digest('hex');
    const before = identityFromStat(beforeStat, 'file', digest);
    if (!sameIdentity(before, identityFromStat(afterStat, 'file', digest)) ||
        !sameIdentity(before, identityFromStat(pathStat, 'file', digest))) throw failed();
    return before;
  } finally {
    fs.closeSync(descriptor);
  }
}

function compareCallerExpectation(expected, actual) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.getPrototypeOf(expected) !== Object.prototype) throw failed();
  const descriptors = Object.getOwnPropertyDescriptors(expected);
  const keys = Object.keys(descriptors);
  const required = ['dev', 'ino', 'size', 'birthtime', 'mtime', 'ctime'];
  if (keys.some(key => ![...required, 'sha256'].includes(key)) || required.some(key => !keys.includes(key)) ||
      keys.some(key => !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw failed();
  const compared = actual.fileType === 'file'
    ? ['dev', 'ino', 'size', 'birthtime', 'mtime']
    : ['dev', 'ino', 'birthtime'];
  for (const key of compared) {
    if (String(descriptors[key].value) !== actual[key]) throw failed();
  }
  if (Object.hasOwn(descriptors, 'sha256') && (typeof descriptors.sha256.value !== 'string' || descriptors.sha256.value !== actual.sha256)) throw failed();
}

function exactOptionKeys(value, expected) {
  if (value === undefined) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw failed();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) throw failed();
  return true;
}

function assertAbsent(candidate) {
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw failed(error);
  }
  throw failed();
}

function comparePublishedMoveExpectation(expected, actual) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.getPrototypeOf(expected) !== Object.prototype) throw failed();
  const descriptors = Object.getOwnPropertyDescriptors(expected);
  const keys = Object.keys(descriptors);
  const required = ['dev', 'ino', 'size', 'birthtime', 'mtime', 'ctime'];
  if (keys.some(key => ![...required, 'sha256'].includes(key)) || required.some(key => !keys.includes(key)) ||
      keys.some(key => !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw failed();
  const expectedFile = Object.hasOwn(descriptors, 'sha256');
  if (expectedFile !== (actual.fileType === 'file')) throw failed();
  const compared = expectedFile ? ['dev', 'ino', 'size', 'mtime', 'sha256'] : ['dev', 'ino', 'birthtime'];
  for (const key of compared) {
    if (String(descriptors[key].value) !== actual[key]) throw failed();
  }
}

function publishedExpectationFromIdentity(identity) {
  return Object.freeze({
    ...Object.fromEntries(['dev', 'ino', 'size', 'birthtime', 'mtime', 'ctime']
      .map(key => [key, identity[key]])),
    ...(identity.fileType === 'file' ? { sha256: identity.sha256 } : {})
  });
}

function strictArrayValues(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 || value.length < 1 || value.length > maximum) throw failed();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) throw failed();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failed();
    result.push(descriptor.value);
  }
  return result;
}

function boundedPositiveInteger(value, fallback, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw failed();
  return result;
}

class WindowsDurableFsClient {
  constructor({ workerPath, workerManifestPath, allowedRoots, spawnSync = childProcess.spawnSync,
    spawn = childProcess.spawn,
    verifyWorker = verifyArchiveWorkerExecutableSync, verifyWorkerAsync = null,
    platform = process.platform,
    appOwnedRoot, timeoutMs = TIMEOUT_MS, terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    requireConfirmedClose = false } = {}) {
    if (typeof requireConfirmedClose !== 'boolean') throw failed();
    // Dedicated staging/authority clients may require exact helper close even
    // on flush errors; preserve the existing bounded policy for other clients.
    Object.defineProperty(this, 'requireConfirmedClose', { value: requireConfirmedClose, enumerable: true });
    this.workerPath = path.resolve(workerPath || '');
    this.workerManifestPath = path.resolve(workerManifestPath || '');
    this.spawnSync = spawnSync;
    this.spawn = spawn;
    this.verifyWorker = verifyWorker;
    // Reuse only the read-only probe transport. Every invocation still verifies
    // both paths, the manifest, executable digest and PE header. Its existing
    // idle shutdown releases the helper without extending mutation authority.
    let verificationReparseInspector;
    this.verifyWorkerAsync = verifyWorkerAsync || (verifyWorker === verifyArchiveWorkerExecutableSync
      ? options => verifyArchiveWorkerExecutable({ ...options,
        reparseInspector: verificationReparseInspector ??= new WindowsReparseInspector() })
      : async options => verifyWorker(options));
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.terminationGraceMs = boundedPositiveInteger(
      terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
      MAX_TERMINATION_GRACE_MS
    );
    if (typeof this.spawnSync !== 'function' || typeof this.spawn !== 'function' ||
        typeof this.verifyWorker !== 'function' || typeof this.verifyWorkerAsync !== 'function' ||
        typeof this.platform !== 'string') throw failed();
    if (!Array.isArray(allowedRoots) || allowedRoots.length < 1 || allowedRoots.length > MAX_ALLOWED_ROOTS ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) throw failed();
    this.allowedRoots = allowedRoots.map(root => {
      if (!safeAbsolute(root)) throw failed();
      const resolved = path.resolve(root);
      if (resolved.toLocaleLowerCase('en-US') === path.parse(resolved).root.toLocaleLowerCase('en-US')) throw failed();
      const stat = fs.lstatSync(resolved);
      if (!stat.isDirectory() || stat.isSymbolicLink() || containsReparsePoint(resolved)) throw failed();
      return resolved;
    });
    if (new Set(this.allowedRoots.map(root => root.toLocaleLowerCase('en-US'))).size !== this.allowedRoots.length) throw failed();
    this.allowedRootIdentities = this.allowedRoots.map(root => Object.freeze({ path: root, identity: captureIdentity(root, 'directory') }));
    const defaultBase = process.env.LOCALAPPDATA || path.join(os.tmpdir(), 'MinecraftCore-LocalAppData');
    this.appOwnedRoot = path.resolve(appOwnedRoot || path.join(defaultBase, 'MinecraftCore', 'ArchiveWorker'));
    if (!safeAbsolute(this.appOwnedRoot) || this.appOwnedRoot === path.parse(this.appOwnedRoot).root) throw failed();
    fs.mkdirSync(this.appOwnedRoot, { recursive: true });
    if (!fs.lstatSync(this.appOwnedRoot).isDirectory() || containsReparsePoint(this.appOwnedRoot)) throw failed();
    try {
      recoverBrokerBundles(this.appOwnedRoot);
      this.recoveryDiagnostics = getBrokerBundleRecoveryDiagnostics(this.appOwnedRoot);
    } catch (error) { throw failed(error); }
    Object.defineProperty(this, 'capabilities', {
      value: WINDOWS_DURABLE_FS_CAPABILITIES,
      enumerable: true,
      configurable: false,
      writable: false
    });
  }

  moveWriteThrough(sourcePath, destinationPath, expectations) {
    const source = this.#owned(sourcePath, true);
    const destination = this.#owned(destinationPath, false);
    if (fs.existsSync(destination) || source.toLocaleLowerCase('en-US') === destination.toLocaleLowerCase('en-US')) throw failed();
    const sourceStat = fs.lstatSync(source);
    if ((!sourceStat.isFile() && !sourceStat.isDirectory()) || sourceStat.isSymbolicLink() || containsReparsePoint(source)) throw failed();
    this.#sameVolume(source, destination);
    const sourceIdentity = captureIdentity(source, sourceStat.isFile() ? 'file' : 'directory');
    const destinationParentIdentity = captureIdentity(path.dirname(destination), 'directory');
    if (exactOptionKeys(expectations, ['sourceIdentity', 'destinationParentIdentity'])) {
      compareCallerExpectation(expectations.sourceIdentity, sourceIdentity);
      compareCallerExpectation(expectations.destinationParentIdentity, destinationParentIdentity);
    }
    const allowedRootIdentities = this.#revalidateRoots();
    this.#invoke({ operation: 'move-write-through', sourcePath: source, destinationPath: destination, sourceIdentity,
      destinationParentIdentity, allowedRoots: this.allowedRoots, allowedRootIdentities });
  }

  async moveWriteThroughAsync(sourcePath, destinationPath, expectations) {
    const source = this.#owned(sourcePath, true);
    const destination = this.#owned(destinationPath, false);
    if (fs.existsSync(destination) || source.toLocaleLowerCase('en-US') === destination.toLocaleLowerCase('en-US')) throw failed();
    const sourceStat = fs.lstatSync(source);
    if ((!sourceStat.isFile() && !sourceStat.isDirectory()) || sourceStat.isSymbolicLink() || containsReparsePoint(source)) throw failed();
    this.#sameVolume(source, destination);
    const sourceType = sourceStat.isFile() ? 'file' : 'directory';
    const sourceIdentity = captureIdentity(source, sourceType);
    const destinationParent = path.dirname(destination);
    const destinationParentIdentity = captureIdentity(destinationParent, 'directory');
    if (exactOptionKeys(expectations, ['sourceIdentity', 'destinationParentIdentity'])) {
      compareCallerExpectation(expectations.sourceIdentity, sourceIdentity);
      compareCallerExpectation(expectations.destinationParentIdentity, destinationParentIdentity);
    }
    const allowedRootIdentities = this.#revalidateRoots();
    await this.#invokeAsync({ operation: 'move-write-through', sourcePath: source, destinationPath: destination, sourceIdentity,
      destinationParentIdentity, allowedRoots: this.allowedRoots, allowedRootIdentities }, { requireConfirmedClose: true });
    const publishedExpectation = publishedExpectationFromIdentity(sourceIdentity);
    const publishedParentExpectation = publishedExpectationFromIdentity(destinationParentIdentity);
    assertAbsent(source);
    comparePublishedMoveExpectation(publishedExpectation, captureIdentity(destination, sourceType));
    compareCallerExpectation(publishedParentExpectation, captureIdentity(destinationParent, 'directory'));
    this.#revalidateRoots();
    assertAbsent(source);
    comparePublishedMoveExpectation(publishedExpectation, captureIdentity(destination, sourceType));
  }

  replaceFileWriteThrough(sourcePath, destinationPath, expectations) {
    const source = this.#owned(sourcePath, true);
    const destination = this.#owned(destinationPath, true);
    if (source.toLocaleLowerCase('en-US') === destination.toLocaleLowerCase('en-US')) throw failed();
    const sourceStat = fs.lstatSync(source);
    const destinationStat = fs.lstatSync(destination);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !destinationStat.isFile() || destinationStat.isSymbolicLink() || containsReparsePoint(source) || containsReparsePoint(destination)) throw failed();
    this.#sameVolume(source, destination);
    const sourceIdentity = captureIdentity(source, 'file');
    const destinationIdentity = captureIdentity(destination, 'file');
    const destinationParentIdentity = captureIdentity(path.dirname(destination), 'directory');
    if (exactOptionKeys(expectations, ['sourceIdentity', 'destinationParentIdentity', 'destinationIdentity'])) {
      compareCallerExpectation(expectations.sourceIdentity, sourceIdentity);
      compareCallerExpectation(expectations.destinationParentIdentity, destinationParentIdentity);
      compareCallerExpectation(expectations.destinationIdentity, destinationIdentity);
    }
    const allowedRootIdentities = this.#revalidateRoots();
    this.#invoke({ operation: 'replace-file-write-through', sourcePath: source, destinationPath: destination, sourceIdentity,
      destinationParentIdentity, destinationIdentity, allowedRoots: this.allowedRoots, allowedRootIdentities });
  }

  async replaceFileWriteThroughAsync(sourcePath, destinationPath, expectations) {
    const source = this.#owned(sourcePath, true);
    const destination = this.#owned(destinationPath, true);
    if (source.toLocaleLowerCase('en-US') === destination.toLocaleLowerCase('en-US')) throw failed();
    const sourceStat = fs.lstatSync(source);
    const destinationStat = fs.lstatSync(destination);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !destinationStat.isFile() || destinationStat.isSymbolicLink() || containsReparsePoint(source) || containsReparsePoint(destination)) throw failed();
    this.#sameVolume(source, destination);
    const sourceIdentity = captureIdentity(source, 'file');
    const destinationIdentity = captureIdentity(destination, 'file');
    const destinationParent = path.dirname(destination);
    const destinationParentIdentity = captureIdentity(destinationParent, 'directory');
    if (exactOptionKeys(expectations, ['sourceIdentity', 'destinationParentIdentity', 'destinationIdentity'])) {
      compareCallerExpectation(expectations.sourceIdentity, sourceIdentity);
      compareCallerExpectation(expectations.destinationParentIdentity, destinationParentIdentity);
      compareCallerExpectation(expectations.destinationIdentity, destinationIdentity);
    }
    const allowedRootIdentities = this.#revalidateRoots();
    await this.#invokeAsync({ operation: 'replace-file-write-through', sourcePath: source, destinationPath: destination,
      sourceIdentity, destinationParentIdentity, destinationIdentity,
      allowedRoots: this.allowedRoots, allowedRootIdentities }, { requireConfirmedClose: true });
    const publishedExpectation = publishedExpectationFromIdentity(sourceIdentity);
    const publishedParentExpectation = publishedExpectationFromIdentity(destinationParentIdentity);
    assertAbsent(source);
    comparePublishedMoveExpectation(publishedExpectation, captureIdentity(destination, 'file'));
    compareCallerExpectation(publishedParentExpectation, captureIdentity(destinationParent, 'directory'));
    this.#revalidateRoots();
    assertAbsent(source);
    comparePublishedMoveExpectation(publishedExpectation, captureIdentity(destination, 'file'));
  }

  flushDirectory(directoryPath, expectations) {
    const directory = this.#owned(directoryPath, true);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || containsReparsePoint(directory)) throw failed();
    const directoryIdentity = captureIdentity(directory, 'directory');
    if (exactOptionKeys(expectations, ['directoryIdentity'])) compareCallerExpectation(expectations.directoryIdentity, directoryIdentity);
    const allowedRootIdentities = this.#revalidateRoots();
    this.#invoke({ operation: 'flush-directory', directoryPath: directory, directoryIdentity,
      allowedRoots: this.allowedRoots, allowedRootIdentities });
  }

  async flushDirectoryAsync(directoryPath, expectations) {
    const directory = this.#owned(directoryPath, true);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || containsReparsePoint(directory)) throw failed();
    const directoryIdentity = captureIdentity(directory, 'directory');
    if (exactOptionKeys(expectations, ['directoryIdentity'])) {
      compareCallerExpectation(expectations.directoryIdentity, directoryIdentity);
    }
    const allowedRootIdentities = this.#revalidateRoots();
    await this.#invokeAsync({ operation: 'flush-directory', directoryPath: directory, directoryIdentity,
      allowedRoots: this.allowedRoots, allowedRootIdentities });
    const after = captureIdentity(directory, 'directory');
    if (!sameIdentity(directoryIdentity, after)) throw failed();
    this.#revalidateRoots();
  }

  reconcileMoveWriteThrough(sourcePath, destinationPath, expectations) {
    const source = this.#owned(sourcePath, false);
    const destination = this.#owned(destinationPath, true);
    assertAbsent(source);
    if (source.toLocaleLowerCase('en-US') === destination.toLocaleLowerCase('en-US')) throw failed();
    this.#sameVolume(source, destination);
    if (!exactOptionKeys(expectations, ['sourceIdentity', 'sourceParentIdentity', 'destinationParentIdentity'])) throw failed();
    const destinationStat = fs.lstatSync(destination);
    if ((!destinationStat.isFile() && !destinationStat.isDirectory()) || destinationStat.isSymbolicLink() || containsReparsePoint(destination)) throw failed();
    const destinationIdentity = captureIdentity(destination, destinationStat.isFile() ? 'file' : 'directory');
    const sourceParentIdentity = captureIdentity(path.dirname(source), 'directory');
    const destinationParentIdentity = captureIdentity(path.dirname(destination), 'directory');
    comparePublishedMoveExpectation(expectations.sourceIdentity, destinationIdentity);
    compareCallerExpectation(expectations.sourceParentIdentity, sourceParentIdentity);
    compareCallerExpectation(expectations.destinationParentIdentity, destinationParentIdentity);
    const normalizedSourceIdentity = Object.freeze({
      fileType: destinationIdentity.fileType,
      ...Object.fromEntries(['dev', 'ino', 'size', 'birthtime', 'mtime', 'ctime']
        .map(key => [key, String(expectations.sourceIdentity[key])])),
      ...(destinationIdentity.fileType === 'file' ? { sha256: expectations.sourceIdentity.sha256 } : {})
    });
    const allowedRootIdentities = this.#revalidateRoots();
    this.#invoke({ operation: 'reconcile-move-write-through', sourcePath: source, destinationPath: destination,
      sourceIdentity: normalizedSourceIdentity, sourceParentIdentity, destinationParentIdentity,
      allowedRoots: this.allowedRoots, allowedRootIdentities });
  }

  async reconcileMoveWriteThroughAsync(sourcePath, destinationPath, expectations) {
    const source = this.#owned(sourcePath, false);
    const destination = this.#owned(destinationPath, true);
    assertAbsent(source);
    if (source.toLocaleLowerCase('en-US') === destination.toLocaleLowerCase('en-US')) throw failed();
    this.#sameVolume(source, destination);
    if (!exactOptionKeys(expectations, ['sourceIdentity', 'sourceParentIdentity', 'destinationParentIdentity'])) throw failed();
    const destinationStat = fs.lstatSync(destination);
    if ((!destinationStat.isFile() && !destinationStat.isDirectory()) || destinationStat.isSymbolicLink() || containsReparsePoint(destination)) throw failed();
    const destinationType = destinationStat.isFile() ? 'file' : 'directory';
    const destinationIdentity = captureIdentity(destination, destinationType);
    const sourceParent = path.dirname(source);
    const destinationParent = path.dirname(destination);
    const sourceParentIdentity = captureIdentity(sourceParent, 'directory');
    const destinationParentIdentity = captureIdentity(destinationParent, 'directory');
    comparePublishedMoveExpectation(expectations.sourceIdentity, destinationIdentity);
    compareCallerExpectation(expectations.sourceParentIdentity, sourceParentIdentity);
    compareCallerExpectation(expectations.destinationParentIdentity, destinationParentIdentity);
    const normalizedSourceIdentity = Object.freeze({
      fileType: destinationIdentity.fileType,
      ...Object.fromEntries(['dev', 'ino', 'size', 'birthtime', 'mtime', 'ctime']
        .map(key => [key, String(expectations.sourceIdentity[key])])),
      ...(destinationIdentity.fileType === 'file' ? { sha256: expectations.sourceIdentity.sha256 } : {})
    });
    const allowedRootIdentities = this.#revalidateRoots();
    await this.#invokeAsync({ operation: 'reconcile-move-write-through', sourcePath: source, destinationPath: destination,
      sourceIdentity: normalizedSourceIdentity, sourceParentIdentity, destinationParentIdentity,
      allowedRoots: this.allowedRoots, allowedRootIdentities });
    const publishedExpectation = publishedExpectationFromIdentity(normalizedSourceIdentity);
    const publishedSourceParentExpectation = publishedExpectationFromIdentity(sourceParentIdentity);
    const publishedDestinationParentExpectation = publishedExpectationFromIdentity(destinationParentIdentity);
    assertAbsent(source);
    comparePublishedMoveExpectation(publishedExpectation, captureIdentity(destination, destinationType));
    compareCallerExpectation(publishedSourceParentExpectation, captureIdentity(sourceParent, 'directory'));
    compareCallerExpectation(publishedDestinationParentExpectation, captureIdentity(destinationParent, 'directory'));
    this.#revalidateRoots();
    assertAbsent(source);
    comparePublishedMoveExpectation(publishedExpectation, captureIdentity(destination, destinationType));
  }

  flushDirectories(directoryPaths, expectations) {
    const requestedPaths = strictArrayValues(directoryPaths, MAX_FLUSH_DIRECTORIES);
    const expectedIdentities = exactOptionKeys(expectations, ['directoryIdentities'])
      ? strictArrayValues(expectations.directoryIdentities, MAX_FLUSH_DIRECTORIES)
      : null;
    if (expectedIdentities !== null && expectedIdentities.length !== requestedPaths.length) throw failed();
    const seen = new Set();
    const directories = requestedPaths.map((directoryPath, index) => {
      const directory = this.#owned(directoryPath, true);
      const key = directory.toLocaleLowerCase('en-US');
      if (seen.has(key)) throw failed();
      seen.add(key);
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || containsReparsePoint(directory)) throw failed();
      const directoryIdentity = captureIdentity(directory, 'directory');
      if (expectedIdentities !== null) compareCallerExpectation(expectedIdentities[index], directoryIdentity);
      return { directoryPath: directory, directoryIdentity };
    });
    const allowedRootIdentities = this.#revalidateRoots();
    this.#invoke({ operation: 'flush-directories', directories,
      allowedRoots: this.allowedRoots, allowedRootIdentities });
  }

  async flushDirectoriesAsync(directoryPaths, expectations) {
    const requestedPaths = strictArrayValues(directoryPaths, MAX_FLUSH_DIRECTORIES);
    const expectedIdentities = exactOptionKeys(expectations, ['directoryIdentities'])
      ? strictArrayValues(expectations.directoryIdentities, MAX_FLUSH_DIRECTORIES)
      : null;
    if (expectedIdentities !== null && expectedIdentities.length !== requestedPaths.length) throw failed();
    const seen = new Set();
    const directories = requestedPaths.map((directoryPath, index) => {
      const directory = this.#owned(directoryPath, true);
      const key = directory.toLocaleLowerCase('en-US');
      if (seen.has(key)) throw failed();
      seen.add(key);
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || containsReparsePoint(directory)) throw failed();
      const directoryIdentity = captureIdentity(directory, 'directory');
      if (expectedIdentities !== null) compareCallerExpectation(expectedIdentities[index], directoryIdentity);
      return { directoryPath: directory, directoryIdentity };
    });
    const allowedRootIdentities = this.#revalidateRoots();
    const requests = [];
    let request = { operation: 'flush-directories', directories: [],
      allowedRoots: this.allowedRoots, allowedRootIdentities };
    // Plan every full native envelope before dispatch: a later unfit singleton
    // must not leave an earlier partial flush in flight. Count alone cannot
    // bound JSON UTF-8 bytes for long or multibyte Windows paths.
    for (const directory of directories) {
      request.directories.push(directory);
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') <= MAX_FRAME_BYTES) continue;
      request.directories.pop();
      if (request.directories.length === 0) throw failed();
      requests.push(request);
      request = { ...request, directories: [directory] };
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_FRAME_BYTES) throw failed();
    }
    requests.push(request);
    for (const partition of requests) await this.#invokeAsync(partition);
    for (const directory of directories) {
      if (!sameIdentity(directory.directoryIdentity, captureIdentity(directory.directoryPath, 'directory'))) throw failed();
    }
    this.#revalidateRoots();
  }

  #revalidateRoots() {
    return this.allowedRootIdentities.map(expected => {
      const identity = captureIdentity(expected.path, 'directory');
      if (!sameIdentity(expected.identity, identity)) throw failed();
      return { path: expected.path, identity };
    });
  }

  #owned(candidate, mustExist) {
    try {
      if (!safeAbsolute(candidate)) throw failed();
      const resolved = path.resolve(candidate);
      if (path.parse(resolved).root === resolved || !this.allowedRoots.some(root => isWithin(root, resolved))) throw failed();
      if (mustExist && !fs.existsSync(resolved)) throw failed();
      const parent = mustExist ? resolved : path.dirname(resolved);
      if (!fs.existsSync(parent) || containsReparsePoint(parent)) throw failed();
      return resolved;
    } catch (error) {
      if (error instanceof ModpackError) throw error;
      throw failed(error);
    }
  }

  #sameVolume(source, destination) {
    if (path.parse(source).root.toLocaleLowerCase('en-US') !== path.parse(destination).root.toLocaleLowerCase('en-US')) throw failed();
  }

  #invoke(request) {
    let framedRequest;
    try { framedRequest = encodeFrame(request); } catch (error) { throw failed(error); }
    try {
      this.verifyWorker({ workerPath: this.workerPath, workerManifestPath: this.workerManifestPath });
      const environment = createExtractionBlockedEnvironment(this.workerPath);
      const result = this.spawnSync(this.workerPath, ['--durable-fs'], {
        input: framedRequest,
        shell: false,
        windowsHide: true,
        encoding: null,
        env: environment,
        timeout: this.timeoutMs,
        maxBuffer: MAX_RESPONSE_BYTES,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stderr) || result.stderr.length !== 0) throw failed(result.error);
      decodeResponse(result.stdout);
    } catch (error) {
      if (error instanceof ModpackError && error.code === 'COMMIT_FAILED') throw error;
      throw failed(error);
    }
  }

  async #invokeAsync(request, { requireConfirmedClose = false } = {}) {
    if (typeof requireConfirmedClose !== 'boolean') throw failed();
    const mustConfirmClose = this.requireConfirmedClose || requireConfirmedClose;
    let framedRequest;
    try { framedRequest = encodeFrame(request); } catch (error) { throw failed(error); }
    try {
      await this.verifyWorkerAsync({ workerPath: this.workerPath, workerManifestPath: this.workerManifestPath });
    } catch (error) {
      throw failed(error);
    }

    return new Promise((resolve, reject) => {
      let child = null;
      let settled = false;
      let closed = false;
      let requestMayHaveBeenSent = false;
      let terminalError = null;
      let deadline = null;
      let forcedSettlement = null;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout = [];

      const publicError = error => error instanceof ModpackError && error.code === 'COMMIT_FAILED'
        ? error
        : failed(error);
      const settle = error => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(forcedSettlement);
        if (error) reject(publicError(error)); else resolve();
      };
      const forceKill = target => {
        try { target?.kill?.('SIGKILL'); } catch { /* fail closed after the bounded wait */ }
      };
      const terminate = error => {
        if (settled || terminalError) return;
        terminalError = publicError(error);
        clearTimeout(deadline);
        forceKill(child);
        if (mustConfirmClose && requestMayHaveBeenSent) return;
        forcedSettlement = setTimeout(() => {
          // Publication uncertainty still waits for the bounded close policy.
          settle(terminalError);
        }, this.terminationGraceMs);
        forcedSettlement.unref?.();
      };
      const close = (code, signal) => {
        if (closed) return;
        closed = true;
        clearTimeout(deadline);
        clearTimeout(forcedSettlement);
        if (settled) return;
        if (terminalError) { settle(terminalError); return; }
        if (code !== 0 || signal !== null || stderrBytes !== 0) { settle(failed()); return; }
        try {
          decodeResponse(Buffer.concat(stdout, stdoutBytes));
          settle(null);
        } catch (error) {
          settle(error);
        }
      };

      const environment = createExtractionBlockedEnvironment(this.workerPath);
      try {
        child = this.spawn(this.workerPath, ['--durable-fs'], {
          shell: false,
          windowsHide: true,
          env: environment,
          detached: this.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (error) {
        settle(failed(error));
        return;
      }

      let valid = false;
      try {
        valid = Boolean(child) && Number.isSafeInteger(child.pid) && child.pid > 0 &&
          typeof child.once === 'function' && typeof child.kill === 'function' &&
          child.stdin && typeof child.stdin.end === 'function' && typeof child.stdin.once === 'function' &&
          child.stdout && typeof child.stdout.on === 'function' &&
          child.stderr && typeof child.stderr.on === 'function';
      } catch { valid = false; }
      if (!valid) { terminate(failed()); return; }

      try {
        child.stdout.on('data', chunk => {
          if (settled || terminalError) return;
          if (!Buffer.isBuffer(chunk)) { terminate(failed()); return; }
          stdoutBytes += chunk.length;
          if (stdoutBytes > MAX_RESPONSE_BYTES) { terminate(failed()); return; }
          stdout.push(chunk);
        });
        child.stderr.on('data', chunk => {
          if (settled || terminalError) return;
          if (!Buffer.isBuffer(chunk)) { terminate(failed()); return; }
          stderrBytes += chunk.length;
          if (stderrBytes > MAX_RESPONSE_BYTES) terminate(failed());
        });
        child.stdin.once('error', error => terminate(failed(error)));
        child.once('error', error => terminate(failed(error)));
        child.once('close', close);
        deadline = setTimeout(() => terminate(failed()), this.timeoutMs);
        deadline.unref?.();
        requestMayHaveBeenSent = true;
        child.stdin.end(framedRequest);
      } catch (error) {
        terminate(failed(error));
      }
    });
  }
}

module.exports = { MAX_FLUSH_DIRECTORIES, WindowsDurableFsClient };
