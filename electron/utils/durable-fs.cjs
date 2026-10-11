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
// Large, schema-validated inventories may opt in per write. Other records keep
// the ordinary limit; byte, depth, string and strict-JSON guards still apply.
const MAX_JSON_INVENTORY_VALUES = 1_000_000;
const MAX_JSON_STRING_BYTES = 4 * 1024 * 1024;
// Each directory carries a nested identity object. Keep the cross-process batch
// below the native worker's strict 16,384-token JSON ceiling even when all 16
// allowed roots and their identities are present in the same request.
const MAX_FLUSH_DIRECTORIES = 512;
const TEMP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PRE_PUBLICATION_NATIVE_STAGES = new Set([
  'root-open',
  'source-open',
  'destination-parent-open',
  'source-parent-open',
  'ancestor-open',
  'preflight-revalidation'
]);

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

function forceFailurePhase(cause, phase) {
  if (!(cause instanceof ModpackError)) return commitFailure(cause, phase);
  return withPhase(new ModpackError(cause.code, cause.safeMessage, {
    cause,
    details: cause.details,
    retryable: cause.retryable
  }), phase);
}

function publicationFailurePhase(error, { published, phase }) {
  if (published || phase === 'post-publication') return 'post-publication';
  if (phase !== 'publication-attempted') return 'pre-publication';
  return error instanceof ModpackError && PRE_PUBLICATION_NATIVE_STAGES.has(error.durableFailureStage)
    ? 'pre-publication'
    : 'post-publication-uncertain';
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

function sameObject(left, right, {
  compareContent = false,
  allowMetadataChange = false,
  allowBirthtimeChange = false
} = {}) {
  return left.dev === right.dev && left.ino === right.ino &&
    (allowBirthtimeChange || left.birthtime === right.birthtime) &&
    (!compareContent || (left.size === right.size &&
      (allowMetadataChange || left.mtime === right.mtime)));
}

function assertDurableClient(client) {
  if (!client || typeof client !== 'object') throw commitFailure();
  for (const method of ['moveWriteThrough', 'replaceFileWriteThrough', 'flushDirectory']) {
    if (typeof client[method] !== 'function') throw commitFailure();
  }
  if (client.flushDirectories !== undefined && typeof client.flushDirectories !== 'function') throw commitFailure();
  if (client.flushDirectoriesAsync !== undefined && typeof client.flushDirectoriesAsync !== 'function') throw commitFailure();
  if (client.flushDirectoryAsync !== undefined && typeof client.flushDirectoryAsync !== 'function') throw commitFailure();
  if (client.moveWriteThroughAsync !== undefined && typeof client.moveWriteThroughAsync !== 'function') throw commitFailure();
  if (client.replaceFileWriteThroughAsync !== undefined && typeof client.replaceFileWriteThroughAsync !== 'function') throw commitFailure();
  if (client.reconcileMoveWriteThrough !== undefined && typeof client.reconcileMoveWriteThrough !== 'function') throw commitFailure();
  if (client.reconcileMoveWriteThroughAsync !== undefined && typeof client.reconcileMoveWriteThroughAsync !== 'function') throw commitFailure();
  return client;
}

function trustedNativeCapability(client, name) {
  try {
    const clientDescriptor = Object.getOwnPropertyDescriptor(client, 'capabilities');
    if (!clientDescriptor || !Object.hasOwn(clientDescriptor, 'value')) return false;
    const capabilities = clientDescriptor.value;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities) ||
        Object.getPrototypeOf(capabilities) !== Object.prototype || !Object.isFrozen(capabilities)) return false;
    const capability = Object.getOwnPropertyDescriptor(capabilities, name);
    return Boolean(capability?.enumerable && Object.hasOwn(capability, 'value') && capability.value === true);
  } catch {
    return false;
  }
}

function strictArrayValues(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 || value.length < 1 || value.length > maximum) throw commitFailure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) throw commitFailure();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw commitFailure();
    result.push(descriptor.value);
  }
  return result;
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
  asyncFsApi,
  durableClient,
  allowedRoots,
  assertNoReparse = null,
  tempNameFactory = crypto.randomUUID,
  maxAtomicBytes,
  maxJsonBytes,
  maxHashBytes
} = {}) {
  const client = assertDurableClient(durableClient);
  const asyncIo = asyncFsApi === undefined ? (fsApi === fs ? fs.promises : null) : asyncFsApi;
  if (!fsApi || typeof fsApi !== 'object' || typeof tempNameFactory !== 'function' ||
      (assertNoReparse !== null && typeof assertNoReparse !== 'function') ||
      !Array.isArray(allowedRoots) || allowedRoots.length === 0) throw commitFailure();
  if (asyncIo !== null && (!asyncIo || typeof asyncIo !== 'object' ||
      typeof asyncIo.open !== 'function' || typeof asyncIo.unlink !== 'function')) throw commitFailure();
  const atomicLimit = boundedInteger(maxAtomicBytes, MAX_ATOMIC_BYTES, MAX_ATOMIC_BYTES);
  const jsonLimit = boundedInteger(maxJsonBytes, MAX_JSON_BYTES, MAX_JSON_BYTES);
  const hashLimit = boundedInteger(maxHashBytes, MAX_HASH_BYTES, MAX_HASH_BYTES);
  const moveFlushesParents = trustedNativeCapability(client, 'moveWriteThroughFlushesParents');
  const reconcilesMovesNatively = (typeof client.reconcileMoveWriteThrough === 'function' ||
    typeof client.reconcileMoveWriteThroughAsync === 'function') &&
    trustedNativeCapability(client, 'reconcileMoveWriteThrough');
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

  async function readFileBoundedAsync(filePath, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.getPrototypeOf(options) !== Object.prototype ||
        Object.keys(options).some(key => key !== 'maxBytes' && key !== 'allowMissing')) throw commitFailure();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const key of Object.keys(descriptors)) {
      if (!Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) throw commitFailure();
    }
    const limit = boundedInteger(options.maxBytes, jsonLimit, atomicLimit);
    if (options.allowMissing !== undefined && typeof options.allowMissing !== 'boolean') throw commitFailure();
    if (asyncIo === null) throw commitFailure();
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
      descriptor = await asyncIo.open(guarded.target, 'r');
      if (!descriptor || typeof descriptor.stat !== 'function' ||
          typeof descriptor.read !== 'function' || typeof descriptor.close !== 'function') throw commitFailure();
      const before = await descriptor.stat({ bigint: true });
      const beforeIdentity = statIdentity(before);
      const beforeSize = Number(before.size);
      if (!before.isFile() || beforeSize > limit ||
          !sameObject(guarded.identity, beforeIdentity, { compareContent: true })) throw staleTarget();
      const bytes = Buffer.alloc(beforeSize);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await descriptor.read(bytes, offset, bytes.length - offset, null);
        const count = result?.bytesRead;
        if (!Number.isSafeInteger(count) || count < 1 || count > bytes.length - offset) throw commitFailure();
        offset += count;
      }
      const afterIdentity = statIdentity(await descriptor.stat({ bigint: true }));
      if (!sameObject(beforeIdentity, afterIdentity, { compareContent: true })) throw staleTarget();
      await descriptor.close();
      descriptor = null;
      const pathIdentity = statIdentity(lstat(guarded.target));
      if (!sameObject(beforeIdentity, pathIdentity, { compareContent: true })) throw staleTarget();
      return bytes;
    } catch (error) {
      if (descriptor !== null) {
        try { await descriptor.close(); } catch { /* retain the primary failure */ }
      }
      throw commitFailure(error);
    }
  }

  function assertExactAtomicPublication(source, published, sourceIdentity) {
    if (!source.stat.isFile() || !published.stat.isFile() ||
        !sameObject(source.identity, published.identity, {
          compareContent: true,
          allowMetadataChange: true,
          allowBirthtimeChange: true
        }) || sha256File(published.target, atomicLimit) !== sourceIdentity.sha256) throw staleTarget();
    revalidateExisting(published);
    if (lstatIfExists(source.target)) throw staleTarget();
  }

  function reconcileUncertainAtomicPublication(source, destination, sourceIdentity) {
    if (lstatIfExists(source.target) || !lstatIfExists(destination.target)) return null;
    const published = guardExisting(destination.target, 'file');
    assertExactAtomicPublication(source, published, sourceIdentity);
    revalidateParent(source);
    revalidateParent(destination);
    assertExactAtomicPublication(source, published, sourceIdentity);
    return published;
  }

  function flushReconciledAtomicParent(source, destination, published, sourceIdentity) {
    revalidateParent(source);
    revalidateParent(destination);
    assertExactAtomicPublication(source, published, sourceIdentity);
    client.flushDirectory(source.parent, { directoryIdentity: source.parentIdentity });
    revalidateParent(source);
    revalidateParent(destination);
    assertExactAtomicPublication(source, published, sourceIdentity);
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
      initialTargetIdentity = Object.freeze({
        ...existingTarget.identity,
        sha256: sha256File(guarded.target, atomicLimit)
      });
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
        if (!sameObject(initialTargetIdentity, currentTarget.identity, { compareContent: true }) ||
            sha256File(guarded.target, atomicLimit) !== initialTargetIdentity.sha256) throw staleTarget();
      }
      phase = 'publication-attempted';
      const sourceIdentity = Object.freeze({ ...flushedTempIdentity, sha256: expectedDataSha256 });
      try {
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
      } catch (publicationError) {
        const publishedTarget = reconcileUncertainAtomicPublication(staged, guarded, sourceIdentity);
        if (publishedTarget === null) throw publicationError;
        if (reconcilesMovesNatively) {
          client.reconcileMoveWriteThrough(tempPath, guarded.target, {
            sourceIdentity,
            sourceParentIdentity: staged.parentIdentity,
            destinationParentIdentity: guarded.parentIdentity
          });
          revalidateParent(staged);
          revalidateParent(guarded);
          assertExactAtomicPublication(staged, publishedTarget, sourceIdentity);
        } else {
          flushReconciledAtomicParent(staged, guarded, publishedTarget, sourceIdentity);
        }
      }
      published = true;
      phase = 'post-publication';
      const publishedTarget = guardExisting(guarded.target, 'file');
      if (!sameObject(flushedTempIdentity, publishedTarget.identity, {
        compareContent: true,
        allowMetadataChange: true,
        allowBirthtimeChange: true
      }) ||
          sha256File(guarded.target, atomicLimit) !== expectedDataSha256) throw staleTarget();
      if (fsyncParent && !moveFlushesParents) {
        client.flushDirectory(guarded.parent, { directoryIdentity: guarded.parentIdentity });
      }
      return guarded.target;
    } catch (error) {
      if (descriptor !== null) {
        try { fsApi.closeSync(descriptor); } catch { /* retain the primary failure */ }
      }
      const errorPhase = publicationFailurePhase(error, { published, phase });
      if (errorPhase === 'pre-publication') {
        try {
          if (lstatIfExists(tempPath)) fsApi.unlinkSync(tempPath);
        } catch { /* retain the primary failure */ }
      }
      throw commitFailure(error, errorPhase);
    }
  }

  function writeJsonAtomic(filePath, value, options = {}) {
    try {
      const { maxJsonValues, mode, fsyncParent, expectedTargetSha256 } = options;
      const maxCollection = boundedInteger(maxJsonValues, MAX_JSON_COLLECTION, MAX_JSON_INVENTORY_VALUES);
      const clone = strictJsonClone(value, { maxCollection, maxStringBytes: Math.min(MAX_JSON_STRING_BYTES, jsonLimit) });
      const serialized = `${JSON.stringify(clone, null, 2)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > jsonLimit) throw new TypeError('JSON byte limit exceeded');
      return writeFileAtomic(filePath, serialized, { mode, fsyncParent, expectedTargetSha256 });
    } catch (error) {
      throw commitFailure(error);
    }
  }

  async function flushReconciledAtomicParentAsync(source, destination, published, sourceIdentity) {
    revalidateParent(source);
    revalidateParent(destination);
    assertExactAtomicPublication(source, published, sourceIdentity);
    if (typeof client.flushDirectoryAsync !== 'function') throw commitFailure();
    await client.flushDirectoryAsync(source.parent, { directoryIdentity: source.parentIdentity });
    revalidateParent(source);
    revalidateParent(destination);
    assertExactAtomicPublication(source, published, sourceIdentity);
  }

  async function writeFileAtomicAsync(filePath, data, {
    mode,
    fsyncParent = true,
    expectedTargetSha256
  } = {}) {
    if (asyncIo === null) throw commitFailure();
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
    if (targetInitiallyExists && typeof client.replaceFileWriteThroughAsync !== 'function') throw commitFailure();
    if (!targetInitiallyExists && typeof client.moveWriteThroughAsync !== 'function') throw commitFailure();
    let existingMode = null;
    let initialTargetIdentity = null;
    if (targetInitiallyExists) {
      const existingTarget = guardExisting(guarded.target, 'file');
      existingMode = Number(existingTarget.stat.mode) & 0o777;
      initialTargetIdentity = Object.freeze({
        ...existingTarget.identity,
        sha256: sha256File(guarded.target, atomicLimit)
      });
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
      descriptor = await asyncIo.open(tempPath, 'wx', mode ?? existingMode ?? 0o600);
      if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.stat !== 'function' ||
          typeof descriptor.write !== 'function' || typeof descriptor.sync !== 'function' ||
          typeof descriptor.close !== 'function') throw commitFailure();
      const opened = await descriptor.stat({ bigint: true });
      if (!opened.isFile()) throw commitFailure();
      let offset = 0;
      while (offset < bytes.length) {
        const result = await descriptor.write(bytes, offset, bytes.length - offset, null);
        const written = result?.bytesWritten;
        if (!Number.isSafeInteger(written) || written < 1 || written > bytes.length - offset) throw commitFailure();
        offset += written;
      }
      await descriptor.sync();
      const finalTempStat = await descriptor.stat({ bigint: true });
      if (!finalTempStat.isFile() || Number(finalTempStat.size) !== bytes.length) throw commitFailure();
      flushedTempIdentity = statIdentity(finalTempStat);
      await descriptor.close();
      descriptor = null;

      revalidateParent(guarded);
      const staged = guardExisting(tempPath, 'file');
      if (!sameObject(flushedTempIdentity, staged.identity, { compareContent: true }) ||
          sha256File(tempPath, atomicLimit) !== expectedDataSha256) throw staleTarget();
      if (expectedTargetSha256 === null && lstatIfExists(guarded.target)) throw staleTarget();
      if (typeof expectedTargetSha256 === 'string' && sha256File(guarded.target) !== expectedTargetSha256) throw staleTarget();
      if (targetInitiallyExists) {
        const currentTarget = guardExisting(guarded.target, 'file');
        if (!sameObject(initialTargetIdentity, currentTarget.identity, { compareContent: true }) ||
            sha256File(guarded.target, atomicLimit) !== initialTargetIdentity.sha256) throw staleTarget();
      }
      phase = 'publication-attempted';
      const sourceIdentity = Object.freeze({ ...flushedTempIdentity, sha256: expectedDataSha256 });
      try {
        if (targetInitiallyExists) {
          await client.replaceFileWriteThroughAsync(tempPath, guarded.target, {
            sourceIdentity,
            destinationParentIdentity: guarded.parentIdentity,
            destinationIdentity: initialTargetIdentity
          });
        } else {
          await client.moveWriteThroughAsync(tempPath, guarded.target, {
            sourceIdentity,
            destinationParentIdentity: guarded.parentIdentity
          });
        }
      } catch (publicationError) {
        const publishedTarget = reconcileUncertainAtomicPublication(staged, guarded, sourceIdentity);
        if (publishedTarget === null) throw publicationError;
        if (reconcilesMovesNatively && typeof client.reconcileMoveWriteThroughAsync === 'function') {
          await client.reconcileMoveWriteThroughAsync(tempPath, guarded.target, {
            sourceIdentity,
            sourceParentIdentity: staged.parentIdentity,
            destinationParentIdentity: guarded.parentIdentity
          });
          revalidateParent(staged);
          revalidateParent(guarded);
          assertExactAtomicPublication(staged, publishedTarget, sourceIdentity);
        } else {
          await flushReconciledAtomicParentAsync(staged, guarded, publishedTarget, sourceIdentity);
        }
      }
      published = true;
      phase = 'post-publication';
      const publishedTarget = guardExisting(guarded.target, 'file');
      if (!sameObject(flushedTempIdentity, publishedTarget.identity, {
        compareContent: true,
        allowMetadataChange: true,
        allowBirthtimeChange: true
      }) || sha256File(guarded.target, atomicLimit) !== expectedDataSha256) throw staleTarget();
      if (fsyncParent && !moveFlushesParents) {
        if (typeof client.flushDirectoryAsync !== 'function') throw commitFailure();
        await client.flushDirectoryAsync(guarded.parent, { directoryIdentity: guarded.parentIdentity });
      }
      revalidateParent(guarded);
      return guarded.target;
    } catch (error) {
      if (descriptor !== null) {
        try { await descriptor.close(); } catch { /* retain the primary failure */ }
      }
      const errorPhase = publicationFailurePhase(error, { published, phase });
      if (errorPhase === 'pre-publication') {
        try {
          if (lstatIfExists(tempPath)) await asyncIo.unlink(tempPath);
        } catch { /* retain the primary failure */ }
      }
      throw commitFailure(error, errorPhase);
    }
  }

  async function writeJsonAtomicAsync(filePath, value, options = {}) {
    try {
      const { maxJsonValues, mode, fsyncParent, expectedTargetSha256 } = options;
      const maxCollection = boundedInteger(maxJsonValues, MAX_JSON_COLLECTION, MAX_JSON_INVENTORY_VALUES);
      const clone = strictJsonClone(value, { maxCollection, maxStringBytes: Math.min(MAX_JSON_STRING_BYTES, jsonLimit) });
      const serialized = `${JSON.stringify(clone, null, 2)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > jsonLimit) throw new TypeError('JSON byte limit exceeded');
      return await writeFileAtomicAsync(filePath, serialized, { mode, fsyncParent, expectedTargetSha256 });
    } catch (error) {
      throw commitFailure(error);
    }
  }

  function assertExactPublishedMove(source, published, sourceIdentity) {
    const sameKind = source.stat.isFile() ? published.stat.isFile() : published.stat.isDirectory();
    if (!sameKind || !sameObject(source.identity, published.identity)) throw staleTarget();
    if (source.stat.isFile() && sha256File(published.target) !== sourceIdentity.sha256) throw staleTarget();
    revalidateExisting(published);
    if (lstatIfExists(source.target)) throw staleTarget();
  }

  function reconcileUncertainMove(source, destination, sourceIdentity) {
    if (lstatIfExists(source.target) || !lstatIfExists(destination.target)) return null;
    const published = guardExisting(destination.target, 'any');
    assertExactPublishedMove(source, published, sourceIdentity);
    revalidateParent(source);
    revalidateParent(destination);
    assertExactPublishedMove(source, published, sourceIdentity);
    return published;
  }

  function flushReconciledMoveParents(source, destination, published, sourceIdentity) {
    const parents = samePath(source.parent, destination.parent) ? [source] : [source, destination];
    for (const parent of parents) revalidateParent(parent);
    assertExactPublishedMove(source, published, sourceIdentity);
    if (typeof client.flushDirectories === 'function') {
      client.flushDirectories(
        parents.map(parent => parent.parent),
        { directoryIdentities: parents.map(parent => parent.parentIdentity) }
      );
    } else {
      for (const parent of parents) {
        client.flushDirectory(parent.parent, { directoryIdentity: parent.parentIdentity });
      }
    }
    for (const parent of parents) revalidateParent(parent);
    assertExactPublishedMove(source, published, sourceIdentity);
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
    let reconciliationAttempted = false;
    let reconciled = false;
    try {
      revalidateParent(source);
      revalidateParent(destination);
      if (lstatIfExists(destination.target)) throw targetExists();
      revalidateExisting(source);
      attempted = true;
      const sourceIdentity = source.stat.isFile()
        ? Object.freeze({ ...source.identity, sha256: verifiedSourceSha256 ?? sha256File(source.target) })
        : source.identity;
      try {
        client.moveWriteThrough(source.target, destination.target, {
          sourceIdentity,
          destinationParentIdentity: destination.parentIdentity
        });
      } catch (moveError) {
        reconciliationAttempted = true;
        const published = reconcileUncertainMove(source, destination, sourceIdentity);
        if (published === null) throw moveError;
        if (reconcilesMovesNatively) {
          client.reconcileMoveWriteThrough(source.target, destination.target, {
            sourceIdentity,
            sourceParentIdentity: source.parentIdentity,
            destinationParentIdentity: destination.parentIdentity
          });
          revalidateParent(source);
          revalidateParent(destination);
          assertExactPublishedMove(source, published, sourceIdentity);
        } else {
          flushReconciledMoveParents(source, destination, published, sourceIdentity);
        }
        reconciled = true;
        moved = true;
        return destination.target;
      }
      moved = true;
      const published = guardExisting(destination.target, 'any');
      if (!sameObject(source.identity, published.identity)) throw staleTarget();
      if (!moveFlushesParents) {
        client.flushDirectory(source.parent, { directoryIdentity: source.parentIdentity });
        if (!samePath(destination.parent, source.parent)) {
          client.flushDirectory(destination.parent, { directoryIdentity: destination.parentIdentity });
        }
      }
      return destination.target;
    } catch (error) {
      if (reconciliationAttempted && !reconciled) {
        throw forceFailurePhase(error, 'post-publication-uncertain');
      }
      const phase = moved ? 'post-publication' : attempted ? 'post-publication-uncertain' : 'pre-publication';
      throw commitFailure(error, phase);
    }
  }

  function captureFlushDirectory(directoryPath) {
    const resolved = assertAbsoluteLocal(directoryPath);
    const exactRoot = roots.find(root => samePath(root.path, resolved));
    if (exactRoot) {
      revalidateRoot(exactRoot);
      const stat = lstat(exactRoot.path);
      return Object.freeze({
        target: exactRoot.path,
        stat,
        identity: statIdentity(stat)
      });
    }
    return guardExisting(resolved, 'directory');
  }

  async function flushReconciledMoveParentsAsync(source, destination, published, sourceIdentity) {
    const parents = samePath(source.parent, destination.parent) ? [source] : [source, destination];
    for (const parent of parents) revalidateParent(parent);
    assertExactPublishedMove(source, published, sourceIdentity);
    if (typeof client.flushDirectoriesAsync === 'function') {
      await client.flushDirectoriesAsync(
        parents.map(parent => parent.parent),
        { directoryIdentities: parents.map(parent => parent.parentIdentity) }
      );
    } else if (typeof client.flushDirectoryAsync === 'function') {
      for (const parent of parents) {
        await client.flushDirectoryAsync(parent.parent, { directoryIdentity: parent.parentIdentity });
      }
    } else {
      throw commitFailure();
    }
    for (const parent of parents) revalidateParent(parent);
    assertExactPublishedMove(source, published, sourceIdentity);
  }

  async function renameDurableAsync(sourcePath, destinationPath, options = {}) {
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
    if (typeof client.moveWriteThroughAsync !== 'function') throw commitFailure();
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
    let reconciliationAttempted = false;
    let reconciled = false;
    try {
      revalidateParent(source);
      revalidateParent(destination);
      if (lstatIfExists(destination.target)) throw targetExists();
      revalidateExisting(source);
      attempted = true;
      const sourceIdentity = source.stat.isFile()
        ? Object.freeze({ ...source.identity, sha256: verifiedSourceSha256 ?? sha256File(source.target) })
        : source.identity;
      try {
        await client.moveWriteThroughAsync(source.target, destination.target, {
          sourceIdentity,
          destinationParentIdentity: destination.parentIdentity
        });
      } catch (moveError) {
        reconciliationAttempted = true;
        const published = reconcileUncertainMove(source, destination, sourceIdentity);
        if (published === null) throw moveError;
        if (reconcilesMovesNatively && typeof client.reconcileMoveWriteThroughAsync === 'function') {
          const expectations = {
            sourceIdentity,
            sourceParentIdentity: source.parentIdentity,
            destinationParentIdentity: destination.parentIdentity
          };
          await client.reconcileMoveWriteThroughAsync(source.target, destination.target, expectations);
          revalidateParent(source);
          revalidateParent(destination);
          assertExactPublishedMove(source, published, sourceIdentity);
        } else {
          await flushReconciledMoveParentsAsync(source, destination, published, sourceIdentity);
        }
        reconciled = true;
        moved = true;
        return destination.target;
      }
      moved = true;
      const published = guardExisting(destination.target, 'any');
      assertExactPublishedMove(source, published, sourceIdentity);
      if (!moveFlushesParents) {
        if (typeof client.flushDirectoryAsync !== 'function') throw commitFailure();
        await client.flushDirectoryAsync(source.parent, { directoryIdentity: source.parentIdentity });
        if (!samePath(destination.parent, source.parent)) {
          await client.flushDirectoryAsync(destination.parent, { directoryIdentity: destination.parentIdentity });
        }
      }
      revalidateParent(source);
      revalidateParent(destination);
      assertExactPublishedMove(source, published, sourceIdentity);
      return destination.target;
    } catch (error) {
      if (reconciliationAttempted && !reconciled) {
        throw forceFailurePhase(error, 'post-publication-uncertain');
      }
      const phase = moved ? 'post-publication' : attempted ? 'post-publication-uncertain' : 'pre-publication';
      throw commitFailure(error, phase);
    }
  }

  function flushDirectory(directoryPath) {
    const directory = captureFlushDirectory(directoryPath);
    try {
      revalidateExisting(directory);
      client.flushDirectory(directory.target, { directoryIdentity: directory.identity });
      revalidateExisting(directory);
      return directory.target;
    } catch (error) {
      throw commitFailure(error, 'post-publication');
    }
  }

  async function flushDirectoryAsync(directoryPath) {
    const directory = captureFlushDirectory(directoryPath);
    try {
      revalidateExisting(directory);
      if (typeof client.flushDirectoryAsync === 'function') {
        await client.flushDirectoryAsync(directory.target, { directoryIdentity: directory.identity });
      } else {
        client.flushDirectory(directory.target, { directoryIdentity: directory.identity });
      }
      revalidateExisting(directory);
      return directory.target;
    } catch (error) {
      throw commitFailure(error, 'post-publication');
    }
  }

  function flushDirectories(directoryPaths) {
    const requested = strictArrayValues(directoryPaths, MAX_FLUSH_DIRECTORIES);
    const directories = requested.map(captureFlushDirectory);
    const keys = directories.map(directory => process.platform === 'win32'
      ? directory.target.toLocaleLowerCase('en-US')
      : directory.target);
    if (new Set(keys).size !== keys.length) throw commitFailure();
    try {
      for (const directory of directories) revalidateExisting(directory);
      if (typeof client.flushDirectories === 'function') {
        client.flushDirectories(
          directories.map(directory => directory.target),
          { directoryIdentities: directories.map(directory => directory.identity) }
        );
      } else {
        for (const directory of directories) {
          client.flushDirectory(directory.target, { directoryIdentity: directory.identity });
        }
      }
      for (const directory of directories) revalidateExisting(directory);
      return Object.freeze(directories.map(directory => directory.target));
    } catch (error) {
      throw commitFailure(error, 'post-publication');
    }
  }

  async function flushDirectoriesAsync(directoryPaths) {
    const requested = strictArrayValues(directoryPaths, MAX_FLUSH_DIRECTORIES);
    const directories = requested.map(captureFlushDirectory);
    const keys = directories.map(directory => process.platform === 'win32'
      ? directory.target.toLocaleLowerCase('en-US')
      : directory.target);
    if (new Set(keys).size !== keys.length) throw commitFailure();
    try {
      for (const directory of directories) revalidateExisting(directory);
      if (typeof client.flushDirectoriesAsync === 'function') {
        await client.flushDirectoriesAsync(
          directories.map(directory => directory.target),
          { directoryIdentities: directories.map(directory => directory.identity) }
        );
      } else if (typeof client.flushDirectories === 'function') {
        client.flushDirectories(
          directories.map(directory => directory.target),
          { directoryIdentities: directories.map(directory => directory.identity) }
        );
      } else {
        for (const directory of directories) {
          if (typeof client.flushDirectoryAsync === 'function') {
            await client.flushDirectoryAsync(directory.target, { directoryIdentity: directory.identity });
          } else {
            client.flushDirectory(directory.target, { directoryIdentity: directory.identity });
          }
        }
      }
      for (const directory of directories) revalidateExisting(directory);
      return Object.freeze(directories.map(directory => directory.target));
    } catch (error) {
      throw commitFailure(error, 'post-publication');
    }
  }

  async function deleteFileExactAsync(filePath, options) {
    let dispatched = false;
    try {
      if (!trustedNativeCapability(durableClient, 'deleteFileExactFlushesParent') || typeof durableClient.deleteFileExactAsync !== 'function') throw commitFailure();
      const { prepareExactDeleteRequest } = require('./windows-durable-fs-client.cjs');
      // Both layers authenticate the caller's original lineage before dispatch.
      const request = prepareExactDeleteRequest(filePath, options, roots.map(root => root.path));
      for (const root of roots) {
        const current = statIdentity(fsApi.lstatSync(root.path, { bigint: true }));
        if (!sameObject(root.identity, current)) throw commitFailure();
      }
      dispatched = true;
      const result = await durableClient.deleteFileExactAsync(request.sourcePath, {
        expectedFileIdentity: request.sourceIdentity, expectedParentIdentity: request.sourceParentIdentity,
        expectedAllowedRootIdentities: request.allowedRootIdentities, expectedAncestorIdentities: request.ancestorIdentities, mode: request.mode
      });
      if (!result || Object.getPrototypeOf(result) !== Object.prototype || Object.keys(result).length !== 2 ||
          result.deleted !== true || result.durable !== true) throw commitFailure();
      return Object.freeze({ deleted: true, durable: true });
    } catch (error) {
      const failure = commitFailure(error);
      for (const [key, value] of Object.entries({ durableFailureKind: 'integrity-failure', durableFailureStage: 'request',
        durableEffectState: dispatched ? 'uncertain' : 'none' })) {
        if (failure[key] === undefined) Object.defineProperty(failure, key, { value, enumerable: true });
      }
      throw failure;
    }
  }

  return Object.freeze({
    deleteFileExactAsync,
    flushDirectories,
    flushDirectoriesAsync,
    flushDirectory,
    flushDirectoryAsync,
    readFileBounded,
    readFileBoundedAsync,
    writeFileAtomic,
    writeFileAtomicAsync,
    writeJsonAtomic,
    writeJsonAtomicAsync,
    renameDurable,
    renameDurableAsync,
    sha256File
  });
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

function writeFileAtomicAsync(filePath, data, options) {
  return getConfiguredDurableFs().writeFileAtomicAsync(filePath, data, options);
}

function readFileBounded(filePath, options) {
  return getConfiguredDurableFs().readFileBounded(filePath, options);
}

function readFileBoundedAsync(filePath, options) {
  return getConfiguredDurableFs().readFileBoundedAsync(filePath, options);
}

function flushDirectory(directoryPath) {
  return getConfiguredDurableFs().flushDirectory(directoryPath);
}

function flushDirectoryAsync(directoryPath) {
  return getConfiguredDurableFs().flushDirectoryAsync(directoryPath);
}

function flushDirectories(directoryPaths) {
  return getConfiguredDurableFs().flushDirectories(directoryPaths);
}

function flushDirectoriesAsync(directoryPaths) {
  return getConfiguredDurableFs().flushDirectoriesAsync(directoryPaths);
}

function writeJsonAtomic(filePath, value, options) {
  return getConfiguredDurableFs().writeJsonAtomic(filePath, value, options);
}

function writeJsonAtomicAsync(filePath, value, options) {
  return getConfiguredDurableFs().writeJsonAtomicAsync(filePath, value, options);
}

function renameDurable(sourcePath, destinationPath, options) {
  return getConfiguredDurableFs().renameDurable(sourcePath, destinationPath, options);
}

function renameDurableAsync(sourcePath, destinationPath, options) {
  return getConfiguredDurableFs().renameDurableAsync(sourcePath, destinationPath, options);
}

function sha256File(filePath) {
  return getConfiguredDurableFs().sha256File(filePath);
}

function deleteFileExactAsync(filePath, options) {
  return getConfiguredDurableFs().deleteFileExactAsync(filePath, options);
}

module.exports = {
  MAX_ATOMIC_BYTES,
  MAX_FLUSH_DIRECTORIES,
  MAX_HASH_BYTES,
  MAX_JSON_BYTES,
  configureDurableFs,
  createDurableFs,
  deleteFileExactAsync,
  flushDirectories,
  flushDirectoriesAsync,
  flushDirectory,
  flushDirectoryAsync,
  getConfiguredDurableFs,
  readFileBounded,
  readFileBoundedAsync,
  strictJsonClone,
  renameDurable,
  renameDurableAsync,
  sha256File,
  writeFileAtomic,
  writeFileAtomicAsync,
  writeJsonAtomic,
  writeJsonAtomicAsync
};
