const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ModpackError } = require('../services/modpacks/errors.cjs');
const { isSafeWindowsBasename } = require('../services/modpacks/windows-basename.cjs');

const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_ATOMIC_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_HASH_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_COLLECTION = 10_000;
const MAX_JSON_STRING_BYTES = 4 * 1024 * 1024;
const TEMP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function withPhase(error, phase) {
  if (error && typeof error === 'object' && error.commitPhase === undefined) {
    Object.defineProperty(error, 'commitPhase', {
      value: phase,
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return error;
}

function commitFailure(cause, phase = 'pre-publication') {
  if (cause instanceof ModpackError) return withPhase(cause, phase);
  return withPhase(
    new ModpackError('COMMIT_FAILED', 'Durable filesystem operation failed', { cause }),
    phase
  );
}

function targetExists() {
  return new ModpackError('TARGET_EXISTS', 'The target already exists');
}

function staleTarget() {
  return new ModpackError('PLAN_STALE', 'The target changed before publication');
}

function boundedInteger(value, fallback, maximum) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) throw commitFailure();
  return candidate;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertAbsoluteLocal(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0') || !path.isAbsolute(candidate)) {
    throw commitFailure();
  }
  if (candidate.split(/[\\/]/u).some(segment => segment === '.' || segment === '..')) throw commitFailure();
  if (process.platform === 'win32') {
    if (!path.win32.isAbsolute(candidate) || candidate.startsWith('\\') || candidate.startsWith('\\?\\') || candidate.startsWith('\\.\\')) {
      throw commitFailure();
    }
  }
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  if (samePath(resolved, parsed.root)) throw commitFailure();
  const tail = resolved.slice(parsed.root.length);
  if (process.platform === 'win32') {
    if (tail.includes(':')) throw commitFailure();
    for (const segment of tail.split(path.sep).filter(Boolean)) {
      if (segment !== segment.normalize('NFC') || !isSafeWindowsBasename(segment)) throw commitFailure();
    }
  }
  return resolved;
}

function statIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs),
    mtime: String(stat.mtimeNs ?? stat.mtimeMs),
    ctime: String(stat.ctimeNs ?? stat.ctimeMs)
  });
}

function sameObject(left, right, { compareContent = false, allowMetadataChange = false } = {}) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtime === right.birthtime &&
    (!compareContent || (left.size === right.size && left.mtime === right.mtime &&
      (allowMetadataChange || left.ctime === right.ctime)));
}

function assertDurableClient(client) {
  if (!client || typeof client !== 'object') throw commitFailure();
  for (const method of ['moveWriteThrough', 'replaceFileWriteThrough', 'flushDirectory']) {
    if (typeof client[method] !== 'function') throw commitFailure();
  }
  return client;
}

function strictJsonClone(value, {
  maxDepth = MAX_JSON_DEPTH,
  maxCollection = MAX_JSON_COLLECTION,
  maxStringBytes = MAX_JSON_STRING_BYTES
} = {}) {
  const stack = new Set();
  let valuesSeen = 0;

  function visit(current, depth) {
    valuesSeen += 1;
    if (valuesSeen > maxCollection || depth > maxDepth) throw new TypeError('JSON structure limit exceeded');
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (Buffer.byteLength(current, 'utf8') > maxStringBytes) throw new TypeError('JSON string limit exceeded');
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('JSON number must be finite');
      return current;
    }
    if (typeof current !== 'object' || stack.has(current)) throw new TypeError('Value is not strict JSON');

    stack.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype || current.length > maxCollection ||
            Object.getOwnPropertySymbols(current).length !== 0) throw new TypeError('Invalid JSON array');
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const ownNames = Object.getOwnPropertyNames(current);
        const expectedNames = new Set(['length']);
        for (let index = 0; index < current.length; index += 1) expectedNames.add(String(index));
        if (ownNames.length !== expectedNames.size || ownNames.some(name => !expectedNames.has(name))) {
          throw new TypeError('JSON arrays cannot have named properties');
        }
        const clone = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('Sparse or accessor JSON arrays are not allowed');
          }
          clone.push(visit(descriptor.value, depth + 1));
        }
        return clone;
      }

      if (Object.getPrototypeOf(current) !== Object.prototype || Object.getOwnPropertySymbols(current).length !== 0) {
        throw new TypeError('JSON objects must be plain');
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Object.keys(descriptors);
      if (keys.length > maxCollection) throw new TypeError('JSON object limit exceeded');
      const clone = {};
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
            key === '__proto__' || key === 'prototype' || key === 'constructor' ||
            Buffer.byteLength(key, 'utf8') > maxStringBytes) throw new TypeError('Unsafe JSON property');
        clone[key] = visit(descriptor.value, depth + 1);
      }
      return clone;
    } finally {
      stack.delete(current);
    }
  }

  return visit(value, 0);
}

function createDurableFs({
  fsApi = fs,
  durableClient,
  allowedRoots,
  assertNoReparse = null,
  tempNameFactory = crypto.randomUUID,
  maxAtomicBytes,
  maxJsonBytes,
  maxHashBytes
} = {}) {
  const client = assertDurableClient(durableClient);
  if (!fsApi || typeof fsApi !== 'object' || typeof tempNameFactory !== 'function' ||
      (assertNoReparse !== null && typeof assertNoReparse !== 'function') ||
      !Array.isArray(allowedRoots) || allowedRoots.length === 0) throw commitFailure();
  const atomicLimit = boundedInteger(maxAtomicBytes, MAX_ATOMIC_BYTES, MAX_ATOMIC_BYTES);
  const jsonLimit = boundedInteger(maxJsonBytes, MAX_JSON_BYTES, MAX_JSON_BYTES);
  const hashLimit = boundedInteger(maxHashBytes, MAX_HASH_BYTES, MAX_HASH_BYTES);
  const lstat = candidate => fsApi.lstatSync(candidate, { bigint: true });
  const fstat = descriptor => fsApi.fstatSync(descriptor, { bigint: true });

  const roots = allowedRoots.map(candidate => {
    const root = assertAbsoluteLocal(candidate);
    const stat = lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fsApi.realpathSync.native(root), root)) throw commitFailure();
    if (assertNoReparse) assertNoReparse(root);
    return Object.freeze({ path: root, identity: statIdentity(stat) });
  });
  if (new Set(roots.map(root => process.platform === 'win32'
    ? root.path.toLocaleLowerCase('en-US') : root.path)).size !== roots.length) throw commitFailure();

  function lstatIfExists(candidate) {
    try {
      return lstat(candidate);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function revalidateRoot(root) {
    const stat = lstat(root.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        !sameObject(root.identity, statIdentity(stat)) ||
        !samePath(fsApi.realpathSync.native(root.path), root.path)) throw staleTarget();
    if (assertNoReparse) assertNoReparse(root.path);
  }

  function guardParent(candidate) {
    const target = assertAbsoluteLocal(candidate);
    const root = roots.find(allowedRoot => isWithin(allowedRoot.path, target));
    if (!root) throw commitFailure();
    revalidateRoot(root);
    const parent = path.dirname(target);
    if (!isWithin(root.path, parent)) throw commitFailure();
    const relative = path.relative(root.path, parent);
    let current = root.path;
    const components = relative === '' ? [] : relative.split(path.sep);
    for (const component of components) {
      current = path.join(current, component);
      const stat = lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fsApi.realpathSync.native(current), current)) throw commitFailure();
      if (assertNoReparse) assertNoReparse(current);
    }
    const parentStat = lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !samePath(fsApi.realpathSync.native(parent), parent)) {
      throw commitFailure();
    }
    if (assertNoReparse) assertNoReparse(parent);
    return Object.freeze({ target, parent, parentIdentity: statIdentity(parentStat), root: root.path, rootIdentity: root.identity });
  }

  function guardExisting(candidate, expectedKind = 'file') {
    const guarded = guardParent(candidate);
    const stat = lstat(guarded.target);
    const correctKind = expectedKind === 'any'
      ? stat.isFile() || stat.isDirectory()
      : expectedKind === 'directory' ? stat.isDirectory() : stat.isFile();
    if (!correctKind || stat.isSymbolicLink() || !samePath(fsApi.realpathSync.native(guarded.target), guarded.target)) {
      throw commitFailure();
    }
    if (assertNoReparse) assertNoReparse(guarded.target);
    return Object.freeze({ ...guarded, stat, identity: statIdentity(stat) });
  }

  function revalidateParent(guarded) {
    const stat = lstat(guarded.parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameObject(guarded.parentIdentity, statIdentity(stat)) ||
        !samePath(fsApi.realpathSync.native(guarded.parent), guarded.parent)) throw staleTarget();
    if (assertNoReparse) assertNoReparse(guarded.parent);
  }

  function revalidateExisting(guarded) {
    const stat = lstat(guarded.target);
    const sameKind = guarded.stat.isDirectory() ? stat.isDirectory() : stat.isFile();
    if (!sameKind || stat.isSymbolicLink() ||
        !sameObject(guarded.identity, statIdentity(stat)) ||
        !samePath(fsApi.realpathSync.native(guarded.target), guarded.target)) throw staleTarget();
    if (assertNoReparse) assertNoReparse(guarded.target);
  }

  function sha256File(filePath, limit = hashLimit) {
    const guarded = guardExisting(filePath, 'file');
    if (Number(guarded.stat.size) > limit) throw commitFailure();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(HASH_BUFFER_BYTES, limit));
    let descriptor = null;
    try {
      descriptor = fsApi.openSync(guarded.target, 'r');
      const before = fstat(descriptor);
      const beforeSize = Number(before.size);
      if (!before.isFile() || beforeSize > limit) throw commitFailure();
      const beforeIdentity = statIdentity(before);
      let total = 0;
      while (true) {
        const count = fsApi.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) throw commitFailure();
        if (count === 0) break;
        total += count;
        if (total > limit) throw commitFailure();
        hash.update(buffer.subarray(0, count));
      }
      const afterIdentity = statIdentity(fstat(descriptor));
      if (total !== beforeSize || !sameObject(beforeIdentity, afterIdentity, { compareContent: true })) throw staleTarget();
      fsApi.closeSync(descriptor);
      descriptor = null;
      const pathIdentity = statIdentity(lstat(guarded.target));
      if (!sameObject(beforeIdentity, pathIdentity, { compareContent: true })) throw staleTarget();
      return hash.digest('hex');
    } catch (error) {
      if (descriptor !== null) {
        try { fsApi.closeSync(descriptor); } catch { /* retain the primary failure */ }
      }
      throw commitFailure(error);
    }
  }

  function readFileBounded(filePath, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.getPrototypeOf(options) !== Object.prototype ||
        Object.keys(options).some(key => key !== 'maxBytes' && key !== 'allowMissing')) throw commitFailure();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const key of Object.keys(descriptors)) {
      if (!Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) throw commitFailure();
    }
    const limit = boundedInteger(options.maxBytes, jsonLimit, atomicLimit);
    if (options.allowMissing !== undefined && typeof options.allowMissing !== 'boolean') throw commitFailure();
    const parent = guardParent(filePath);
    if (!lstatIfExists(parent.target)) {
      revalidateParent(parent);
      if (options.allowMissing) return null;
      throw commitFailure();
    }
    const guarded = guardExisting(parent.target, 'file');
    if (Number(guarded.stat.size) > limit) throw commitFailure();
    let descriptor = null;
    try {
      descriptor = fsApi.openSync(guarded.target, 'r');
      const before = fstat(descriptor);
      const beforeIdentity = statIdentity(before);
      const beforeSize = Number(before.size);
      if (!before.isFile() || beforeSize > limit || !sameObject(guarded.identity, beforeIdentity, { compareContent: true })) {
        throw staleTarget();
      }
      const bytes = Buffer.alloc(beforeSize);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fsApi.readSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) throw commitFailure();
        offset += count;
      }
      const afterIdentity = statIdentity(fstat(descriptor));
      if (!sameObject(beforeIdentity, afterIdentity, { compareContent: true })) throw staleTarget();
      fsApi.closeSync(descriptor);
      descriptor = null;
      const pathIdentity = statIdentity(lstat(guarded.target));
      if (!sameObject(beforeIdentity, pathIdentity, { compareContent: true })) throw staleTarget();
      return bytes;
    } catch (error) {
      if (descriptor !== null) {
        try { fsApi.closeSync(descriptor); } catch { /* retain the primary failure */ }
      }
      throw commitFailure(error);
    }
  }

  function writeFileAtomic(filePath, data, {
    mode,
    fsyncParent = true,
    expectedTargetSha256
  } = {}) {
    let phase = 'pre-publication';
    const guarded = guardParent(filePath);
    let token;
    try {
      token = String(tempNameFactory());
    } catch (error) {
      throw commitFailure(error);
    }
    if (!TEMP_TOKEN_PATTERN.test(token) || typeof fsyncParent !== 'boolean') throw commitFailure();
    if (mode !== undefined && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777)) throw commitFailure();
    if (expectedTargetSha256 !== undefined && expectedTargetSha256 !== null && !SHA256_PATTERN.test(expectedTargetSha256)) {
      throw commitFailure();
    }
    const initialTargetStat = lstatIfExists(guarded.target);
    const targetInitiallyExists = initialTargetStat !== null;
    if (expectedTargetSha256 === null && targetInitiallyExists) throw staleTarget();
    if (typeof expectedTargetSha256 === 'string') {
      if (!targetInitiallyExists || sha256File(guarded.target) !== expectedTargetSha256) throw staleTarget();
    }
    let existingMode = null;
    let initialTargetIdentity = null;
    if (targetInitiallyExists) {
      const existingTarget = guardExisting(guarded.target, 'file');
      existingMode = Number(existingTarget.stat.mode) & 0o777;
      initialTargetIdentity = existingTarget.identity;
    }

    const isSharedView = typeof SharedArrayBuffer !== 'undefined' &&
      ArrayBuffer.isView(data) && data.buffer instanceof SharedArrayBuffer;
    if (isSharedView) throw commitFailure();
    const inputLength = typeof data === 'string'
      ? Buffer.byteLength(data, 'utf8')
      : (Buffer.isBuffer(data) || data instanceof Uint8Array ? data.byteLength : null);
    if (inputLength === null || inputLength > atomicLimit) throw commitFailure();
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const expectedDataSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const tempPath = path.join(guarded.parent, `.${path.basename(guarded.target)}.minecraft-core-tmp-${token}`);
    let descriptor = null;
    let published = false;
    let flushedTempIdentity = null;

    try {
      descriptor = fsApi.openSync(tempPath, 'wx', mode ?? existingMode ?? 0o600);
      const opened = fstat(descriptor);
      if (!opened.isFile()) throw commitFailure();
      let offset = 0;
      while (offset < bytes.length) {
        const written = fsApi.writeSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (!Number.isSafeInteger(written) || written < 1 || written > bytes.length - offset) throw commitFailure();
        offset += written;
      }
      fsApi.fsyncSync(descriptor);
      const finalTempStat = fstat(descriptor);
      if (!finalTempStat.isFile() || Number(finalTempStat.size) !== bytes.length) throw commitFailure();
      flushedTempIdentity = statIdentity(finalTempStat);
      fsApi.closeSync(descriptor);
      descriptor = null;

      revalidateParent(guarded);
      const staged = guardExisting(tempPath, 'file');
      if (!sameObject(flushedTempIdentity, staged.identity, { compareContent: true }) ||
          sha256File(tempPath, atomicLimit) !== expectedDataSha256) throw staleTarget();
      if (expectedTargetSha256 === null && lstatIfExists(guarded.target)) throw staleTarget();
      if (typeof expectedTargetSha256 === 'string' && sha256File(guarded.target) !== expectedTargetSha256) throw staleTarget();
      if (targetInitiallyExists) {
        const currentTarget = guardExisting(guarded.target, 'file');
        if (!sameObject(initialTargetIdentity, currentTarget.identity, { compareContent: true })) throw staleTarget();
      }
      phase = 'publication-attempted';
      const sourceIdentity = Object.freeze({ ...flushedTempIdentity, sha256: expectedDataSha256 });
      if (targetInitiallyExists) {
        client.replaceFileWriteThrough(tempPath, guarded.target, {
          sourceIdentity,
          destinationParentIdentity: guarded.parentIdentity,
          destinationIdentity: initialTargetIdentity
        });
      } else {
        client.moveWriteThrough(tempPath, guarded.target, {
          sourceIdentity,
          destinationParentIdentity: guarded.parentIdentity
        });
      }
      published = true;
      phase = 'post-publication';
      const publishedTarget = guardExisting(guarded.target, 'file');
      if (!sameObject(flushedTempIdentity, publishedTarget.identity, { compareContent: true, allowMetadataChange: true }) ||
          sha256File(guarded.target, atomicLimit) !== expectedDataSha256) throw staleTarget();
      if (fsyncParent) client.flushDirectory(guarded.parent, { directoryIdentity: guarded.parentIdentity });
      return guarded.target;
    } catch (error) {
      if (descriptor !== null) {
        try { fsApi.closeSync(descriptor); } catch { /* retain the primary failure */ }
      }
      if (phase === 'pre-publication') {
        try {
          if (lstatIfExists(tempPath)) fsApi.unlinkSync(tempPath);
        } catch { /* retain the primary failure */ }
      }
      const errorPhase = published || phase === 'post-publication'
        ? 'post-publication'
        : phase === 'publication-attempted' ? 'post-publication-uncertain' : 'pre-publication';
      throw commitFailure(error, errorPhase);
    }
  }

  function writeJsonAtomic(filePath, value, options = {}) {
    try {
      const clone = strictJsonClone(value, { maxStringBytes: Math.min(MAX_JSON_STRING_BYTES, jsonLimit) });
      const serialized = `${JSON.stringify(clone, null, 2)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > jsonLimit) throw new TypeError('JSON byte limit exceeded');
      return writeFileAtomic(filePath, serialized, options);
    } catch (error) {
      throw commitFailure(error);
    }
  }

  function renameDurable(sourcePath, destinationPath, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.getPrototypeOf(options) !== Object.prototype ||
        Object.getOwnPropertySymbols(options).length !== 0 ||
        Object.keys(options).some(key => key !== 'expectedSourceSha256')) throw commitFailure();
    const optionDescriptors = Object.getOwnPropertyDescriptors(options);
    for (const descriptor of Object.values(optionDescriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw commitFailure();
    }
    const expectedSourceSha256 = options.expectedSourceSha256;
    if (expectedSourceSha256 !== undefined &&
        (typeof expectedSourceSha256 !== 'string' || !SHA256_PATTERN.test(expectedSourceSha256))) throw commitFailure();
    const source = guardExisting(sourcePath, 'any');
    const destination = guardParent(destinationPath);
    if (!samePath(path.parse(source.target).root, path.parse(destination.target).root) ||
        source.parentIdentity.dev !== destination.parentIdentity.dev) throw commitFailure();
    if (lstatIfExists(destination.target)) throw targetExists();
    let verifiedSourceSha256 = null;
    if (expectedSourceSha256 !== undefined) {
      if (!source.stat.isFile()) throw commitFailure();
      verifiedSourceSha256 = sha256File(source.target);
      if (verifiedSourceSha256 !== expectedSourceSha256) throw staleTarget();
    }
    let attempted = false;
    let moved = false;
    try {
      revalidateParent(source);
      revalidateParent(destination);
      if (lstatIfExists(destination.target)) throw targetExists();
      revalidateExisting(source);
      attempted = true;
      const sourceIdentity = source.stat.isFile()
        ? Object.freeze({ ...source.identity, sha256: verifiedSourceSha256 ?? sha256File(source.target) })
        : source.identity;
      client.moveWriteThrough(source.target, destination.target, {
        sourceIdentity,
        destinationParentIdentity: destination.parentIdentity
      });
      moved = true;
      const published = guardExisting(destination.target, 'any');
      if (!sameObject(source.identity, published.identity)) throw staleTarget();
      client.flushDirectory(source.parent, { directoryIdentity: source.parentIdentity });
      if (!samePath(destination.parent, source.parent)) {
        client.flushDirectory(destination.parent, { directoryIdentity: destination.parentIdentity });
      }
      return destination.target;
    } catch (error) {
      const phase = moved ? 'post-publication' : attempted ? 'post-publication-uncertain' : 'pre-publication';
      throw commitFailure(error, phase);
    }
  }

  function flushDirectory(directoryPath) {
    const resolved = assertAbsoluteLocal(directoryPath);
    const exactRoot = roots.find(root => samePath(root.path, resolved));
    let directory;
    if (exactRoot) {
      revalidateRoot(exactRoot);
      const stat = lstat(exactRoot.path);
      directory = Object.freeze({
        target: exactRoot.path,
        stat,
        identity: statIdentity(stat)
      });
    } else {
      directory = guardExisting(resolved, 'directory');
    }
    try {
      revalidateExisting(directory);
      client.flushDirectory(directory.target, { directoryIdentity: directory.identity });
      revalidateExisting(directory);
      return directory.target;
    } catch (error) {
      throw commitFailure(error, 'post-publication');
    }
  }

  return Object.freeze({ flushDirectory, readFileBounded, writeFileAtomic, writeJsonAtomic, renameDurable, sha256File });
}

let configuredDurableFs = null;

function configureDurableFs(options) {
  configuredDurableFs = createDurableFs(options);
  return configuredDurableFs;
}

function getConfiguredDurableFs() {
  if (!configuredDurableFs) throw commitFailure();
  return configuredDurableFs;
}

function writeFileAtomic(filePath, data, options) {
  return getConfiguredDurableFs().writeFileAtomic(filePath, data, options);
}

function readFileBounded(filePath, options) {
  return getConfiguredDurableFs().readFileBounded(filePath, options);
}

function flushDirectory(directoryPath) {
  return getConfiguredDurableFs().flushDirectory(directoryPath);
}

function writeJsonAtomic(filePath, value, options) {
  return getConfiguredDurableFs().writeJsonAtomic(filePath, value, options);
}

function renameDurable(sourcePath, destinationPath, options) {
  return getConfiguredDurableFs().renameDurable(sourcePath, destinationPath, options);
}

function sha256File(filePath) {
  return getConfiguredDurableFs().sha256File(filePath);
}

module.exports = {
  MAX_ATOMIC_BYTES,
  MAX_HASH_BYTES,
  MAX_JSON_BYTES,
  configureDurableFs,
  createDurableFs,
  flushDirectory,
  readFileBounded,
  strictJsonClone,
  renameDurable,
  sha256File,
  writeFileAtomic,
  writeJsonAtomic
};
