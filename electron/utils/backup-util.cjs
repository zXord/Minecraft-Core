const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const archiver = require('archiver');
const yauzl = require('yauzl');

const { ModpackError } = require('../services/modpacks/errors.cjs');
const { strictJsonClone } = require('./durable-fs.cjs');

const SCOPE_SCHEMA_VERSION = 1;
const SCOPE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const MAX_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
const COOPERATIVE_HASH_BYTES = 4 * 1024 * 1024;
const COOPERATIVE_FILESYSTEM_OPERATIONS = 64;
const COOPERATIVE_ELAPSED_MS = 25;

function backupFailure(cause) {
  if (cause instanceof ModpackError && ['BACKUP_FAILED', 'CANCELLED'].includes(cause.code)) return cause;
  return new ModpackError('BACKUP_FAILED', 'The restore point could not be verified', { cause });
}

function cancelled() {
  return new ModpackError('CANCELLED', 'The modpack operation was cancelled');
}

function assertSignal(signal) {
  if (signal === null || signal === undefined) return null;
  if (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
    throw backupFailure();
  }
  return signal;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelled();
}

function reportProgress(onProgress, value) {
  if (typeof onProgress !== 'function') return;
  try {
    Promise.resolve(onProgress(Object.freeze(value))).catch(() => {});
  } catch { /* progress observers never decide archive correctness */ }
}

async function reportProgressBoundary(onProgress, value) {
  if (typeof onProgress !== 'function') return;
  try { await onProgress(Object.freeze(strictJsonClone(value, { maxDepth: 8, maxCollection: 128, maxStringBytes: 4096 }))); }
  catch { /* progress observers never decide archive correctness */ }
}

function normalizeStreamIdleTimeoutMs(value) {
  const timeoutMs = value === undefined ? DEFAULT_STREAM_IDLE_TIMEOUT_MS : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STREAM_IDLE_TIMEOUT_MS) {
    throw backupFailure();
  }
  return timeoutMs;
}

function sameLocalPath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLocaleLowerCase('en-US') === resolvedRight.toLocaleLowerCase('en-US')
    : resolvedLeft === resolvedRight;
}

function sameBackupEntryStat(left, right) {
  // ChangeTime is advisory; metadata observers can update it without changing
  // bytes. Keep object identity, link/type evidence, write time and size strict.
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

function assertStableFileStat(before, pinned, linked, filePath, fsApi) {
  if (!pinned.isFile() || pinned.isSymbolicLink() || !linked.isFile() || linked.isSymbolicLink() ||
      !sameBackupEntryStat(before, pinned) || !sameBackupEntryStat(before, linked) ||
      !sameLocalPath(fsApi.realpathSync.native(filePath), filePath)) throw backupFailure();
}

function readFileDigest(descriptor, expectedSize, fsApi) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  while (true) {
    const count = fsApi.readSync(descriptor, buffer, 0, buffer.length, total);
    if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) throw backupFailure();
    if (count === 0) break;
    total += count;
    if (!Number.isSafeInteger(total) || BigInt(total) > expectedSize) throw backupFailure();
    hash.update(buffer.subarray(0, count));
  }
  if (BigInt(total) !== expectedSize) throw backupFailure();
  return { sha256: hash.digest('hex'), size: total };
}

function assertDirectoryStable(sourcePath, before, children, fsApi) {
  const names = fsApi.readdirSync(sourcePath).sort((left, right) => left.localeCompare(right, 'en-US'));
  if (names.length !== children.length || names.some((name, index) => name !== children[index].name)) {
    throw backupFailure();
  }
  const after = fsApi.lstatSync(sourcePath, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameBackupEntryStat(before, after) ||
      !sameLocalPath(fsApi.realpathSync.native(sourcePath), sourcePath)) throw backupFailure();
}

function stableFileDigest(filePath, fsApi = fs) {
  let descriptor = null;
  try {
    const beforePath = fsApi.lstatSync(filePath, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw backupFailure();
    descriptor = fsApi.openSync(filePath, 'r');
    const before = fsApi.fstatSync(descriptor, { bigint: true });
    assertStableFileStat(beforePath, before, beforePath, filePath, fsApi);
    const digest = readFileDigest(descriptor, before.size, fsApi);
    const after = fsApi.fstatSync(descriptor, { bigint: true });
    const afterPath = fsApi.lstatSync(filePath, { bigint: true });
    assertStableFileStat(before, after, afterPath, filePath, fsApi);
    if (beforePath.ctimeNs !== before.ctimeNs || before.ctimeNs !== after.ctimeNs || before.ctimeNs !== afterPath.ctimeNs) {
      // A bounded full reread distinguishes harmless churn from an overwrite
      // whose size/write time was restored. This is verification, never retry.
      if (readFileDigest(descriptor, before.size, fsApi).sha256 !== digest.sha256) throw backupFailure();
      assertStableFileStat(before, fsApi.fstatSync(descriptor, { bigint: true }),
        fsApi.lstatSync(filePath, { bigint: true }), filePath, fsApi);
    }
    fsApi.closeSync(descriptor);
    descriptor = null;
    return digest;
  } catch (error) {
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor); } catch { /* preserve primary error */ }
    }
    throw backupFailure(error);
  }
}

function defaultYieldControl() {
  return new Promise(resolve => setImmediate(resolve));
}

function createCooperativeCheckpoint(yieldControl) {
  let bytes = 0;
  let operations = 0;
  let lastYieldAt = Date.now();
  return async (processedBytes = 0) => {
    bytes += processedBytes;
    operations += 1;
    const now = Date.now();
    if (bytes < COOPERATIVE_HASH_BYTES && operations < COOPERATIVE_FILESYSTEM_OPERATIONS &&
        now - lastYieldAt < COOPERATIVE_ELAPSED_MS) return;
    bytes = 0;
    operations = 0;
    await yieldControl();
    lastYieldAt = Date.now();
  };
}

async function stableFileDigestCooperatively(filePath, fsApi, checkpoint) {
  let descriptor = null;
  try {
    const beforePath = fsApi.lstatSync(filePath, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw backupFailure();
    descriptor = fsApi.openSync(filePath, 'r');
    const before = fsApi.fstatSync(descriptor, { bigint: true });
    assertStableFileStat(beforePath, before, beforePath, filePath, fsApi);
    const readDigest = async () => {
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let total = 0;
      while (true) {
        const count = fsApi.readSync(descriptor, buffer, 0, buffer.length, total);
        if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) throw backupFailure();
        if (count === 0) break;
        total += count;
        if (!Number.isSafeInteger(total) || BigInt(total) > before.size) throw backupFailure();
        hash.update(buffer.subarray(0, count));
        await checkpoint(count);
      }
      if (BigInt(total) !== before.size) throw backupFailure();
      return { sha256: hash.digest('hex'), size: total };
    };
    const digest = await readDigest();
    const after = fsApi.fstatSync(descriptor, { bigint: true });
    const afterPath = fsApi.lstatSync(filePath, { bigint: true });
    assertStableFileStat(before, after, afterPath, filePath, fsApi);
    if (beforePath.ctimeNs !== before.ctimeNs || before.ctimeNs !== after.ctimeNs || before.ctimeNs !== afterPath.ctimeNs) {
      if ((await readDigest()).sha256 !== digest.sha256) throw backupFailure();
      assertStableFileStat(before, fsApi.fstatSync(descriptor, { bigint: true }),
        fsApi.lstatSync(filePath, { bigint: true }), filePath, fsApi);
    }
    fsApi.closeSync(descriptor);
    descriptor = null;
    await checkpoint();
    return digest;
  } catch (error) {
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor); } catch { /* preserve primary error */ }
    }
    throw backupFailure(error);
  }
}

function normalizeArchiveEntryPath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw backupFailure();
  const normalized = value.replaceAll('\\', '/');
  const withoutSlash = directory && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (!withoutSlash || withoutSlash.startsWith('/') || path.posix.isAbsolute(withoutSlash) || path.win32.isAbsolute(withoutSlash)) {
    throw backupFailure();
  }
  const segments = withoutSlash.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment !== segment.normalize('NFC'))) {
    throw backupFailure();
  }
  return directory ? `${withoutSlash}/` : withoutSlash;
}

function scopeHash(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

function enumerateArchiveScopeInternal(items, fsApi = fs) {
  try {
    if (!Array.isArray(items) || items.length === 0 || Object.getPrototypeOf(items) !== Array.prototype ||
        Object.getOwnPropertySymbols(items).length !== 0) throw backupFailure();
    const itemDescriptors = Object.getOwnPropertyDescriptors(items);
    const expectedNames = new Set(['length']);
    for (let index = 0; index < items.length; index += 1) expectedNames.add(String(index));
    if (Object.getOwnPropertyNames(items).some(name => !expectedNames.has(name))) throw backupFailure();
    for (let index = 0; index < items.length; index += 1) {
      const descriptor = itemDescriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'string' || !path.isAbsolute(descriptor.value)) throw backupFailure();
    }
    const resolvedItems = items.map(item => path.resolve(item));
    const parent = path.dirname(resolvedItems[0]);
    if (resolvedItems.some(item => path.dirname(item) !== parent) || new Set(resolvedItems).size !== resolvedItems.length) {
      throw backupFailure();
    }
    const entries = [];
    const names = new Set();

    function walk(sourcePath, archivePath) {
      const stat = fsApi.lstatSync(sourcePath, { bigint: true });
      if (stat.isSymbolicLink() || !sameLocalPath(fsApi.realpathSync.native(sourcePath), sourcePath)) throw backupFailure();
      if (stat.isDirectory()) {
        const name = normalizeArchiveEntryPath(archivePath, { directory: true });
        if (names.has(name)) throw backupFailure();
        names.add(name);
        entries.push({ path: name, type: 'directory', size: 0, sha256: null, sourcePath });
        const children = fsApi.readdirSync(sourcePath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
        for (const child of children) walk(path.join(sourcePath, child.name), `${name}${child.name}`);
        assertDirectoryStable(sourcePath, stat, children, fsApi);
        return;
      }
      if (!stat.isFile()) throw backupFailure();
      const name = normalizeArchiveEntryPath(archivePath);
      if (names.has(name) || names.has(`${name}/`)) throw backupFailure();
      const evidence = stableFileDigest(sourcePath, fsApi);
      names.add(name);
      entries.push({ path: name, type: 'file', size: evidence.size, sha256: evidence.sha256, sourcePath });
    }

    for (const item of [...resolvedItems].sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en-US'))) {
      walk(item, path.basename(item));
    }
    entries.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
    const publicEntries = entries.map(({ path: entryPath, type, size, sha256 }) => ({ path: entryPath, type, size, sha256 }));
    return {
      internalEntries: entries,
      publicScope: Object.freeze({
        schemaVersion: SCOPE_SCHEMA_VERSION,
        entries: Object.freeze(publicEntries.map(entry => Object.freeze(entry))),
        totalBytes: publicEntries.reduce((total, entry) => total + entry.size, 0),
        fileCount: publicEntries.filter(entry => entry.type === 'file').length,
        scopeSha256: scopeHash(publicEntries)
      })
    };
  } catch (error) {
    throw backupFailure(error);
  }
}

function enumerateArchiveScope(items, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some(key => key !== 'fsApi')) throw backupFailure();
  return enumerateArchiveScopeInternal(items, options.fsApi || fs).publicScope;
}

async function enumerateArchiveScopeInternalCooperatively(items, fsApi = fs, yieldControl = defaultYieldControl, signal = null) {
  try {
    if (!Array.isArray(items) || items.length === 0 || Object.getPrototypeOf(items) !== Array.prototype ||
      Object.getOwnPropertySymbols(items).length !== 0 || typeof yieldControl !== 'function') throw backupFailure();
    assertSignal(signal);
    throwIfCancelled(signal);
    const itemDescriptors = Object.getOwnPropertyDescriptors(items);
    const expectedNames = new Set(['length']);
    for (let index = 0; index < items.length; index += 1) expectedNames.add(String(index));
    if (Object.getOwnPropertyNames(items).some(name => !expectedNames.has(name))) throw backupFailure();
    const resolvedItems = [];
    for (let index = 0; index < items.length; index += 1) {
      const descriptor = itemDescriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'string' || !path.isAbsolute(descriptor.value)) throw backupFailure();
      resolvedItems.push(path.resolve(descriptor.value));
    }
    const parent = path.dirname(resolvedItems[0]);
    if (resolvedItems.some(item => path.dirname(item) !== parent) || new Set(resolvedItems).size !== resolvedItems.length) {
      throw backupFailure();
    }
    const entries = [];
    const names = new Set();
    const cooperativeCheckpoint = createCooperativeCheckpoint(yieldControl);
    const checkpoint = async processedBytes => {
      throwIfCancelled(signal);
      await cooperativeCheckpoint(processedBytes);
      throwIfCancelled(signal);
    };

    async function walk(sourcePath, archivePath) {
      const stat = fsApi.lstatSync(sourcePath, { bigint: true });
      if (stat.isSymbolicLink() || !sameLocalPath(fsApi.realpathSync.native(sourcePath), sourcePath)) throw backupFailure();
      await checkpoint();
      if (stat.isDirectory()) {
        const name = normalizeArchiveEntryPath(archivePath, { directory: true });
        if (names.has(name)) throw backupFailure();
        names.add(name);
        entries.push({ path: name, type: 'directory', size: 0, sha256: null, sourcePath });
        const children = fsApi.readdirSync(sourcePath, { withFileTypes: true })
          .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
        await checkpoint();
        for (const child of children) await walk(path.join(sourcePath, child.name), `${name}${child.name}`);
        assertDirectoryStable(sourcePath, stat, children, fsApi);
        await checkpoint();
        return;
      }
      if (!stat.isFile()) throw backupFailure();
      const name = normalizeArchiveEntryPath(archivePath);
      if (names.has(name) || names.has(`${name}/`)) throw backupFailure();
      const evidence = await stableFileDigestCooperatively(sourcePath, fsApi, checkpoint);
      names.add(name);
      entries.push({ path: name, type: 'file', size: evidence.size, sha256: evidence.sha256, sourcePath });
    }

    for (const item of [...resolvedItems].sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en-US'))) {
      await walk(item, path.basename(item));
    }
    entries.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
    const publicEntries = entries.map(({ path: entryPath, type, size, sha256 }) => ({ path: entryPath, type, size, sha256 }));
    return {
      internalEntries: entries,
      publicScope: Object.freeze({
        schemaVersion: SCOPE_SCHEMA_VERSION,
        entries: Object.freeze(publicEntries.map(entry => Object.freeze(entry))),
        totalBytes: publicEntries.reduce((total, entry) => total + entry.size, 0),
        fileCount: publicEntries.filter(entry => entry.type === 'file').length,
        scopeSha256: scopeHash(publicEntries)
      })
    };
  } catch (error) {
    throw backupFailure(error);
  }
}

async function enumerateArchiveScopeCooperatively(items, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !['fsApi', 'yieldControl', 'signal'].includes(key)) ||
      (Object.hasOwn(options, 'yieldControl') && typeof options.yieldControl !== 'function')) throw backupFailure();
  const signal = assertSignal(options.signal);
  return (await enumerateArchiveScopeInternalCooperatively(
    items,
    options.fsApi || fs,
    options.yieldControl || defaultYieldControl,
    signal
  )).publicScope;
}

function normalizeExpectedScope(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw backupFailure();
    }
    const clone = strictJsonClone(value, { maxDepth: 8, maxCollection: 250_000, maxStringBytes: 4096 });
    if (clone.schemaVersion !== SCOPE_SCHEMA_VERSION || !Array.isArray(clone.entries) ||
        !Number.isSafeInteger(clone.totalBytes) || clone.totalBytes < 0 ||
        !Number.isSafeInteger(clone.fileCount) || clone.fileCount < 0 ||
        typeof clone.scopeSha256 !== 'string' || !SCOPE_HASH_PATTERN.test(clone.scopeSha256)) throw backupFailure();
    const entries = clone.entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          !['directory', 'file'].includes(entry.type) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
          (entry.type === 'directory' ? entry.sha256 !== null || entry.size !== 0 :
            typeof entry.sha256 !== 'string' || !SCOPE_HASH_PATTERN.test(entry.sha256))) throw backupFailure();
      return {
        path: normalizeArchiveEntryPath(entry.path, { directory: entry.type === 'directory' }),
        type: entry.type,
        size: entry.size,
        sha256: entry.sha256
      };
    });
    if (new Set(entries.map(entry => entry.path)).size !== entries.length ||
        entries.reduce((total, entry) => total + entry.size, 0) !== clone.totalBytes ||
        entries.filter(entry => entry.type === 'file').length !== clone.fileCount ||
        scopeHash(entries) !== clone.scopeSha256) throw backupFailure();
    return { schemaVersion: SCOPE_SCHEMA_VERSION, entries, totalBytes: clone.totalBytes, fileCount: clone.fileCount, scopeSha256: clone.scopeSha256 };
  } catch (error) {
    throw backupFailure(error);
  }
}

function openZipStreaming(descriptor, yauzlApi) {
  return new Promise((resolve, reject) => {
    yauzlApi.fromFd(descriptor, {
      autoClose: false,
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (error, zip) => error ? reject(error) : resolve(zip));
  });
}

async function hashPinnedZip(handle, expectedSize, signal, onProgress, hashPass) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    while (true) {
      throwIfCancelled(signal);
      const count = (await handle.read(buffer, 0, buffer.length, bytes))?.bytesRead;
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) throw backupFailure();
      if (count === 0) break;
      bytes += count;
      if (!Number.isSafeInteger(bytes) || BigInt(bytes) > expectedSize) throw backupFailure();
      hash.update(buffer.subarray(0, count));
      reportProgress(onProgress, {
        phase: 'archive-hash', hashPass, kind: 'progress', processedBytes: bytes, totalBytes: Number(expectedSize)
      });
    }
    throwIfCancelled(signal);
    if (BigInt(bytes) !== expectedSize) throw backupFailure();
    return { sha256: hash.digest('hex'), size: bytes };
  } finally {
    buffer.fill(0);
  }
}

async function verifyZipScopeStreaming(zipPath, expectedScope, options = {}) {
  let handle = null;
  try {
    if (typeof zipPath !== 'string' || !path.isAbsolute(zipPath) || !options || typeof options !== 'object' ||
        Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
        Object.keys(options).some(key => ![
          'yauzlApi', 'onChunk', 'onProgress', 'streamIdleTimeoutMs', 'signal', 'fsApi', 'asyncFsApi'
        ].includes(key)) ||
        (options.onChunk !== undefined && typeof options.onChunk !== 'function') ||
        (options.onProgress !== undefined && typeof options.onProgress !== 'function')) throw backupFailure();
    const expected = normalizeExpectedScope(expectedScope);
    const streamIdleTimeoutMs = normalizeStreamIdleTimeoutMs(options.streamIdleTimeoutMs);
    const signal = assertSignal(options.signal);
    throwIfCancelled(signal);
    const fsApi = options.fsApi || fs;
    const asyncFsApi = options.asyncFsApi || fsApi.promises || fs.promises;
    if (!asyncFsApi || typeof asyncFsApi.open !== 'function') throw backupFailure();
    const yauzlApi = options.yauzlApi || yauzl;
    if (!yauzlApi || typeof yauzlApi.fromFd !== 'function') throw backupFailure();
    const before = fsApi.lstatSync(zipPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || !sameLocalPath(fsApi.realpathSync.native(zipPath), zipPath)) {
      throw backupFailure();
    }
    handle = await asyncFsApi.open(zipPath, 'r');
    if (!handle || typeof handle.fd !== 'number' || typeof handle.stat !== 'function' ||
        typeof handle.read !== 'function' || typeof handle.close !== 'function') throw backupFailure();
    const pinnedBefore = await handle.stat({ bigint: true });
    assertStableFileStat(before, pinnedBefore, before, zipPath, fsApi);
    await reportProgressBoundary(options.onProgress, {
      phase: 'archive-hash', hashPass: 'initial', kind: 'start', processedBytes: 0, totalBytes: Number(pinnedBefore.size)
    });
    const initialDigest = await hashPinnedZip(handle, pinnedBefore.size, signal, options.onProgress, 'initial');
    const archiveSha256 = initialDigest.sha256;
    const archiveBytes = initialDigest.size;
    await reportProgressBoundary(options.onProgress, {
      phase: 'entry-verify', kind: 'start', processedBytes: 0, totalBytes: expected.totalBytes
    });
    const zip = await openZipStreaming(handle.fd, yauzlApi);
    const declared = new Map(expected.entries.map(entry => [entry.path, entry]));
    const observed = new Set();
    let totalBytes = 0;
    let fileCount = 0;
    await new Promise((resolve, reject) => {
      let settled = false;
      let activeStream = null;
      let idleTimer = null;
      const abort = () => fail(cancelled());
      const clearIdleTimer = () => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = null;
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        clearIdleTimer();
        signal?.removeEventListener('abort', abort);
        const stream = activeStream;
        activeStream = null;
        if (stream && !stream.destroyed) {
          try { stream.destroy(backupFailure(error)); } catch { /* preserve verification failure */ }
        }
        try { zip.close(); } catch { /* preserve verification failure */ }
        reject(backupFailure(error));
      };
      const armIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => fail(backupFailure()), streamIdleTimeoutMs);
      };
      zip.once('error', fail);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { fail(cancelled()); return; }
      zip.on('entry', entry => {
        try {
          const isDirectory = entry.fileName.endsWith('/');
          const normalizedName = normalizeArchiveEntryPath(entry.fileName, { directory: isDirectory });
          const expectedEntry = declared.get(normalizedName);
          if (!expectedEntry || observed.has(normalizedName) || isDirectory !== (expectedEntry.type === 'directory') ||
              !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize !== expectedEntry.size) throw backupFailure();
          observed.add(normalizedName);
          if (isDirectory) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error) { fail(error); return; }
            if (settled) {
              try { stream.destroy(); } catch { /* verification already failed */ }
              return;
            }
            activeStream = stream;
            armIdleTimer();
            const hash = crypto.createHash('sha256');
            let measured = 0;
            stream.on('data', chunk => {
              try {
                armIdleTimer();
                if (!Buffer.isBuffer(chunk)) throw backupFailure();
                measured += chunk.length;
                if (!Number.isSafeInteger(measured) || measured > expectedEntry.size) throw backupFailure();
                hash.update(chunk);
                options.onChunk?.(chunk);
                reportProgress(options.onProgress, {
                  phase: 'entry-verify', kind: 'progress', processedBytes: totalBytes + measured, totalBytes: expected.totalBytes
                });
              } catch (streamError) {
                try { stream.destroy(streamError); } catch { /* fail below retains the primary error */ }
                fail(streamError);
              }
            });
            stream.once('error', fail);
            stream.once('end', () => {
              clearIdleTimer();
              activeStream = null;
              try {
                if (measured !== expectedEntry.size || hash.digest('hex') !== expectedEntry.sha256) throw backupFailure();
                totalBytes += measured;
                fileCount += 1;
                zip.readEntry();
              } catch (streamError) {
                fail(streamError);
              }
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.once('end', () => {
        if (settled) return;
        clearIdleTimer();
        try {
          if (observed.size !== declared.size || totalBytes !== expected.totalBytes || fileCount !== expected.fileCount) {
            throw backupFailure();
          }
          settled = true;
          signal?.removeEventListener('abort', abort);
          resolve();
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
    throwIfCancelled(signal);
    assertStableFileStat(pinnedBefore, await handle.stat({ bigint: true }),
      fsApi.lstatSync(zipPath, { bigint: true }), zipPath, fsApi);
    // Entry hashes protect decompressed content; a final raw hash also binds
    // archive headers/comments to the exact digest returned to restore callers.
    await reportProgressBoundary(options.onProgress, {
      phase: 'archive-hash', hashPass: 'final', kind: 'start', processedBytes: 0, totalBytes: Number(pinnedBefore.size)
    });
    const finalDigest = await hashPinnedZip(handle, pinnedBefore.size, signal, options.onProgress, 'final');
    if (finalDigest.sha256 !== archiveSha256) throw backupFailure();
    const pinnedAfter = await handle.stat({ bigint: true });
    const after = fsApi.lstatSync(zipPath, { bigint: true });
    assertStableFileStat(pinnedBefore, pinnedAfter, after, zipPath, fsApi);
    await handle.close();
    handle = null;
    return Object.freeze({
      scopeSha256: expected.scopeSha256,
      totalBytes,
      fileCount,
      archiveSha256,
      archiveSize: archiveBytes,
      archiveIdentity: Object.freeze({
        dev: String(after.dev),
        ino: String(after.ino),
        size: String(after.size),
        birthtimeNs: String(after.birthtimeNs),
        mtimeNs: String(after.mtimeNs),
        ctimeNs: String(after.ctimeNs)
      })
    });
  } catch (error) {
    if (handle !== null) {
      try { await handle.close(); } catch { /* preserve verification failure */ }
    }
    throw backupFailure(error);
  }
}

async function createVerifiedZip({
  items,
  partPath,
  expectedScope,
  onProgress = null,
  onPartCreated = null,
  fsApi = fs,
  asyncFsApi = null,
  archiveFactory = archiver,
  zipStreamVerifier = verifyZipScopeStreaming,
  faultInjector = () => {},
  signal = null
} = {}) {
  let handle = null;
  try {
    if (typeof partPath !== 'string' || !path.isAbsolute(partPath) || !partPath.endsWith('.part') ||
        (onProgress !== null && typeof onProgress !== 'function') ||
        (onPartCreated !== null && typeof onPartCreated !== 'function') || typeof archiveFactory !== 'function' ||
        typeof zipStreamVerifier !== 'function' || typeof faultInjector !== 'function') throw backupFailure();
    signal = assertSignal(signal);
    throwIfCancelled(signal);
    asyncFsApi ||= fsApi.promises || fs.promises;
    if (!asyncFsApi || typeof asyncFsApi.open !== 'function') throw backupFailure();
    const parent = path.dirname(partPath);
    const parentStat = fsApi.lstatSync(parent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
        !sameLocalPath(fsApi.realpathSync.native(parent), parent)) throw backupFailure();
    const expected = normalizeExpectedScope(expectedScope);
    await reportProgressBoundary(onProgress, {
      activity: 'archive-source-check', phase: 'scope', kind: 'start', processedBytes: 0, totalBytes: null
    });
    const current = await enumerateArchiveScopeInternalCooperatively(items, fsApi, defaultYieldControl, signal);
    if (JSON.stringify(current.publicScope) !== JSON.stringify(expected)) throw backupFailure();
    throwIfCancelled(signal);
    handle = await asyncFsApi.open(partPath, 'wx', 0o600);
    if (!handle || typeof handle.fd !== 'number' || typeof handle.stat !== 'function' ||
        typeof handle.sync !== 'function' || typeof handle.close !== 'function') throw backupFailure();
    const created = await handle.stat({ bigint: true });
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1n || created.size !== 0n) throw backupFailure();
    const partIdentity = Object.freeze({
      dev: String(created.dev),
      ino: String(created.ino),
      birthtimeNs: String(created.birthtimeNs)
    });
    if (onPartCreated) await onPartCreated(partIdentity);
    throwIfCancelled(signal);
    const pinned = await handle.stat({ bigint: true });
    const linked = fsApi.lstatSync(partPath, { bigint: true });
    if (!pinned.isFile() || pinned.isSymbolicLink() || pinned.nlink !== 1n || pinned.size !== 0n ||
        !linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n || linked.size !== 0n ||
        pinned.dev !== created.dev || pinned.ino !== created.ino || pinned.birthtimeNs !== created.birthtimeNs ||
        linked.dev !== created.dev || linked.ino !== created.ino || linked.birthtimeNs !== created.birthtimeNs) {
      throw backupFailure();
    }
    await reportProgressBoundary(onProgress, {
      activity: 'archive-write', phase: 'archive-write', kind: 'start', processedBytes: 0,
      totalBytes: expected.totalBytes, entriesProcessed: 0, entriesTotal: expected.entries.length
    });
    const output = fsApi.createWriteStream(partPath, { fd: handle.fd, autoClose: false });
    const archive = archiveFactory('zip', { zlib: { level: 1 } });
    await new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => fail(cancelled());
      const fail = error => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        try { archive.abort?.(); } catch { /* preserve cancellation/failure */ }
        try { output.destroy(); } catch { /* preserve cancellation/failure */ }
        reject(error);
      };
      output.on('error', fail);
      archive.on('error', fail);
      archive.on('progress', progress => {
        reportProgress(onProgress, {
          phase: 'archive-write',
          kind: 'progress', activity: 'archive-write',
          processedBytes: progress?.fs?.processedBytes ?? 0,
          totalBytes: expected.totalBytes,
          entriesProcessed: progress?.entries?.processed ?? 0,
          entriesTotal: expected.entries.length
        });
      });
      output.on('finish', async () => {
        if (settled) return;
        try {
          throwIfCancelled(signal);
          faultInjector('before-archive-close');
          await handle.sync();
          const completed = await handle.stat({ bigint: true });
          if (!completed.isFile() || completed.dev !== created.dev || completed.ino !== created.ino ||
              completed.birthtimeNs !== created.birthtimeNs || completed.size < 1n) throw backupFailure();
          await handle.close();
          handle = null;
          settled = true;
          signal?.removeEventListener('abort', abort);
          resolve();
        } catch (error) {
          fail(error);
        }
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { fail(cancelled()); return; }
      archive.pipe(output);
      for (const entry of current.internalEntries) {
        if (entry.type === 'directory') archive.append(Buffer.alloc(0), { name: entry.path });
        else archive.file(entry.sourcePath, { name: entry.path });
      }
      archive.finalize().catch(fail);
    });

    faultInjector('during-integrity-test');
    faultInjector('during-manifest-comparison');
    throwIfCancelled(signal);
    const archiveEvidence = await zipStreamVerifier(partPath, expected, {
      signal,
      onProgress: progress => {
        try {
          const event = strictJsonClone(progress, { maxDepth: 8, maxCollection: 128, maxStringBytes: 4096 });
          return event.kind === 'start' ? reportProgressBoundary(onProgress, event) : reportProgress(onProgress, event);
        } catch { /* malformed observer samples do not decide archive correctness */ }
      },
      fsApi,
      asyncFsApi
    });
    return Object.freeze({
      sha256: archiveEvidence.archiveSha256,
      size: archiveEvidence.archiveSize,
      scopeSha256: expected.scopeSha256,
      scope: Object.freeze(expected)
    });
  } catch (error) {
    if (handle !== null) {
      try { await handle.close(); } catch { /* preserve primary error */ }
    }
    throw backupFailure(error);
  }
}

function shouldIgnoreArchiveEntry(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  return normalized.endsWith('~')
    || normalized.startsWith('tmp')
    || normalized.endsWith('.lock')
    || normalized.endsWith('.tmp');
}

function calculateArchiveInputSize(items) {
  const summary = {
    totalBytes: 0,
    fileCount: 0
  };

  const walk = (itemPath) => {
    if (!fs.existsSync(itemPath)) {
      return;
    }

    const stats = fs.statSync(itemPath);
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(itemPath, { withFileTypes: true })) {
        if (shouldIgnoreArchiveEntry(entry.name)) {
          continue;
        }
        walk(path.join(itemPath, entry.name));
      }
      return;
    }

    if (stats.isFile()) {
      summary.totalBytes += stats.size;
      summary.fileCount += 1;
    }
  };

  for (const item of items) {
    walk(item);
  }

  return summary;
}

function normalizeCompressionLevel(level) {
  const numericLevel = Number(level);
  if (Number.isInteger(numericLevel) && numericLevel >= 0 && numericLevel <= 9) {
    return numericLevel;
  }
  return 5;
}

/**
 * Create a zip file from a list of folders or files
 * 
 * @param {Array<string>} items - Paths to folders or files to include in the zip
 * @param {string} outputPath - Path where to save the zip file
 * @returns {Promise<void>} - Resolves when zip is created
 */
async function createZip(items, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
      const inputSummary = options.inputSummary || calculateArchiveInputSize(items);
      const compressionLevel = normalizeCompressionLevel(options.compressionLevel);
      const expectedTotalBytes = Number(inputSummary.totalBytes) || 0;
      const expectedEntriesTotal = Number(inputSummary.fileCount) || items.length;
      let settled = false;
      let lastProgressAt = 0;

      const emitProgress = (payload, { force = false } = {}) => {
        if (!onProgress) return;
        const now = Date.now();
        if (!force && now - lastProgressAt < 500) return;
        lastProgressAt = now;
        onProgress(payload);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const output = fs.createWriteStream(outputPath);
      const archive = (/** @type {any} */ (archiver))('zip', {
        zlib: { level: compressionLevel }
      });
      
      output.on('error', (err) => {
        output.end();
        fail(err);
      });

      archive.on('error', (err) => {
        output.end();
        fail(err);
      });
      
      output.on('close', () => {
        if (settled) return;
        settled = true;
        emitProgress({
          phase: 'complete',
          percent: 100,
          processedBytes: expectedTotalBytes || archive.pointer(),
          totalBytes: expectedTotalBytes,
          entriesTotal: expectedEntriesTotal
        }, { force: true });
        resolve();
      });
      archive.on('warning', (err) => {
        if (err.code !== 'ENOENT') {
          fail(err);
        }
      });

      archive.on('progress', (progress) => {
        const processedBytes = progress?.fs?.processedBytes || 0;
        const totalBytes = expectedTotalBytes || progress?.fs?.totalBytes || 0;
        const entriesProcessed = progress?.entries?.processed || 0;
        const entriesTotal = expectedEntriesTotal || progress?.entries?.total || 0;
        const bytePercent = totalBytes > 0 ? (processedBytes / totalBytes) * 100 : null;
        const entryPercent = entriesTotal > 0 ? (entriesProcessed / entriesTotal) * 100 : null;
        const percent = bytePercent ?? entryPercent;

        emitProgress({
          phase: 'zipping',
          percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
          processedBytes,
          totalBytes,
          entriesProcessed,
          entriesTotal
        });
      });

      archive.pipe(output);

      for (const item of items) {
          if (!fs.existsSync(item)) {
            continue;
          }
          
          const itemName = path.basename(item);
          const stats = fs.statSync(item);
          
          if (stats.isDirectory()) {
            archive.glob('**/*', {
              cwd: item,
              ignore: ['**/*~', '**/tmp*', '**/*.lock', '**/*.tmp'],
              dot: true
            }, { prefix: itemName });
          } else {
            fs.accessSync(item, fs.constants.R_OK);
            archive.file(item, { name: itemName });
          }
      }
      
      emitProgress({
        phase: 'queued',
        percent: 0,
        processedBytes: 0,
        totalBytes: expectedTotalBytes,
        entriesTotal: expectedEntriesTotal
      }, { force: true });
      archive.finalize();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Create a backup of the entire server or specific folders
 * 
 * @param {string} serverPath - Path to the server directory
 * @param {Array<string>} [folders] - Optional list of specific folders to backup
 * @returns {Promise<string>} - Path to the created backup file
 */
async function createServerBackup(serverPath, folders = null) {
    const backupDir = path.join(serverPath, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `server-backup-${timestamp}.zip`;
    const backupPath = path.join(backupDir, backupFilename);
    
    let itemsToBackup = [];
    
    if (folders && Array.isArray(folders) && folders.length > 0) {
      itemsToBackup = folders.map(folder => path.join(serverPath, folder))
        .filter(folderPath => fs.existsSync(folderPath));
    } else {
      const defaultFolders = ['world', 'world_nether', 'world_the_end', 'config', 'mods'];
      itemsToBackup = defaultFolders.map(folder => path.join(serverPath, folder))
        .filter(folderPath => fs.existsSync(folderPath));
      
        const serverPropertiesPath = path.join(serverPath, 'server.properties');
      if (fs.existsSync(serverPropertiesPath)) {
        itemsToBackup.push(serverPropertiesPath);
      }
    }
    
    if (itemsToBackup.length === 0) {
      throw new Error('No valid folders or files found to backup');
    }
    
    await createZip(itemsToBackup, backupPath);
    return backupPath;
}

/**
 * List available backups for a server
 * 
 * @param {string} serverPath - Path to the server directory
 * @returns {Promise<Array<Object>>} - List of backup info objects
 */
async function listBackups(serverPath) {
  try {
    const backupDir = path.join(serverPath, 'backups');
    if (!fs.existsSync(backupDir)) {
      return [];
    }
    
    const backupFiles = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.zip'))
      .map(file => {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);
        
        return {
          name: file,
          path: filePath,
          size: stats.size,
          created: stats.mtime
        };
      })
        .sort((a, b) => b.created.getTime() - a.created.getTime());
    
    return backupFiles;
    } catch {
      return [];
    }
  }

module.exports = {
  createVerifiedZip,
  createZip,
  createServerBackup,
  enumerateArchiveScope,
  enumerateArchiveScopeCooperatively,
  listBackups,
  calculateArchiveInputSize,
  normalizeCompressionLevel,
  verifyZipScopeStreaming
}; 
