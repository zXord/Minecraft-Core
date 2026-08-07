const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ModpackError } = require('../services/modpacks/errors.cjs');
const { isSafeWindowsBasename } = require('../services/modpacks/windows-basename.cjs');
const {
  encodeFrame,
  parseStrictJson,
  createBrokerBundle,
  recoverBrokerBundles,
  removeBrokerBundle,
  verifyArchiveWorkerExecutableSync
} = require('../services/modpacks/archive/archive-worker-client.cjs');

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 30 * 1000;
const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_ALLOWED_ROOTS = 16;

function failed(cause) {
  return new ModpackError('COMMIT_FAILED', 'Durable filesystem operation failed', { cause });
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
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || value.ok !== true) throw failed();
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
  return left.fileType === 'directory' || (left.size === right.size && left.mtime === right.mtime && left.ctime === right.ctime && left.sha256 === right.sha256);
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
  for (const key of required) {
    if ((actual.fileType === 'file' || ['dev', 'ino', 'birthtime'].includes(key)) && String(descriptors[key].value) !== actual[key]) throw failed();
  }
  if (Object.hasOwn(descriptors, 'sha256') && (typeof descriptors.sha256.value !== 'string' || descriptors.sha256.value !== actual.sha256)) throw failed();
}

function exactOptionKeys(value, expected) {
  if (value === undefined) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw failed();
  return true;
}

class WindowsDurableFsClient {
  constructor({ workerPath, workerManifestPath, allowedRoots, spawnSync = childProcess.spawnSync,
    verifyWorker = verifyArchiveWorkerExecutableSync, appOwnedRoot, timeoutMs = TIMEOUT_MS } = {}) {
    this.workerPath = path.resolve(workerPath || '');
    this.workerManifestPath = path.resolve(workerManifestPath || '');
    this.spawnSync = spawnSync;
    this.verifyWorker = verifyWorker;
    this.timeoutMs = timeoutMs;
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
    try { recoverBrokerBundles(this.appOwnedRoot); } catch (error) { throw failed(error); }
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
    let bundle;
    try { bundle = createBrokerBundle(this.appOwnedRoot); } catch (error) { throw failed(error); }
    const { bundleParent, bundleRoot } = bundle;
    try {
      this.verifyWorker({ workerPath: this.workerPath, workerManifestPath: this.workerManifestPath });
      const environment = { DOTNET_BUNDLE_EXTRACT_BASE_DIR: bundleRoot };
      if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
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
    } finally {
      try { removeBrokerBundle(bundleParent, bundleRoot); } catch { /* spawnSync returned, so no child can retain the bundle */ }
    }
  }
}

module.exports = { WindowsDurableFsClient };
