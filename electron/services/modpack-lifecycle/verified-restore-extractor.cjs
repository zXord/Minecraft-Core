const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const yauzl = require('yauzl');

const { enumerateArchiveScopeCooperatively } = require('../../utils/backup-util.cjs');
const { MAX_FLUSH_DIRECTORIES } = require('../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { WindowsReparseInspector } = require('../modpacks/local/windows-reparse-inspector.cjs');
const { inspectServerDirectoryTree } = require('./server-directory-identity.cjs');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 250_000,
  maxTotalBytes: 512 * 1024 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024 * 1024,
  maxPathDepth: 64
});
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const MAX_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
const PROGRESS_INTERVAL_MS = 250;
const COOPERATIVE_HASH_BYTES = 4 * 1024 * 1024;
const COOPERATIVE_FILESYSTEM_OPERATIONS = 64;

function backupFailure(cause) {
  if (cause instanceof ModpackError && ['BACKUP_FAILED', 'CANCELLED'].includes(cause.code)) return cause;
  return new ModpackError('BACKUP_FAILED', 'The restore archive could not be extracted safely', { cause });
}

function cancelled(cause) {
  return new ModpackError('CANCELLED', 'The modpack operation was cancelled', { cause });
}

function normalizeSignal(signal) {
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

function defaultYieldControl() {
  return new Promise(resolve => setImmediate(resolve));
}

function createCooperativeCheckpoint(signal) {
  let bytes = 0;
  let operations = 0;
  let lastYieldAt = Date.now();
  return async (processedBytes = 0) => {
    throwIfCancelled(signal);
    bytes += processedBytes;
    operations += 1;
    const now = Date.now();
    if (bytes < COOPERATIVE_HASH_BYTES && operations < COOPERATIVE_FILESYSTEM_OPERATIONS &&
        now - lastYieldAt < 25) return;
    bytes = 0;
    operations = 0;
    await defaultYieldControl();
    lastYieldAt = Date.now();
    throwIfCancelled(signal);
  };
}

function plainExact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw backupFailure();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length !== keys.length || names.some(name => !keys.includes(name)) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    throw backupFailure();
  }
}

function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value !== value.normalize('NFC') ||
      value.split(/[\\/]/u).some(segment => segment === '.' || segment === '..')) throw backupFailure();
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw backupFailure();
  return resolved;
}

function sameLocalPath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32'
    ? first.toLocaleLowerCase('en-US') === second.toLocaleLowerCase('en-US')
    : first === second;
}

function normalizeLimits(value) {
  if (value === undefined) return DEFAULT_LIMITS;
  plainExact(value, ['maxEntries', 'maxTotalBytes', 'maxFileBytes', 'maxPathDepth']);
  for (const key of ['maxEntries', 'maxTotalBytes', 'maxFileBytes', 'maxPathDepth']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw backupFailure();
  }
  if (value.maxFileBytes > value.maxTotalBytes) throw backupFailure();
  return Object.freeze({ ...value });
}

function createBoundedProgressReporter(onProgress) {
  if (onProgress === undefined) return () => {};
  if (typeof onProgress !== 'function') throw backupFailure();
  let lastPhase = null;
  let lastPublishedAt = 0;
  return (value, { force = false } = {}) => {
    const now = Date.now();
    const phaseChanged = value.phase !== lastPhase;
    if (!force && !phaseChanged && now - lastPublishedAt < PROGRESS_INTERVAL_MS) return;
    lastPhase = value.phase;
    lastPublishedAt = now;
    try {
      Promise.resolve(onProgress(Object.freeze({ ...value }))).catch(() => {});
    } catch { /* progress observers never decide restore correctness */ }
  };
}

function normalizeStreamIdleTimeoutMs(value) {
  const timeoutMs = value === undefined ? DEFAULT_STREAM_IDLE_TIMEOUT_MS : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STREAM_IDLE_TIMEOUT_MS) {
    throw backupFailure();
  }
  return timeoutMs;
}

function safeEntryPath(value, type, maxDepth) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') || value.includes('\0') ||
      value.includes('\\') || value.startsWith('/') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw backupFailure();
  }
  const directory = type === 'directory';
  if (directory !== value.endsWith('/')) throw backupFailure();
  const withoutSlash = directory ? value.slice(0, -1) : value;
  if (!withoutSlash || withoutSlash.length > 32_767 || path.posix.normalize(withoutSlash) !== withoutSlash) {
    throw backupFailure();
  }
  const segments = withoutSlash.split('/');
  if (segments.length > maxDepth || segments.some(segment => !segment || segment === '.' || segment === '..' ||
      segment.length > 255 || segment !== segment.normalize('NFC') || segment.includes(':') ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/u.test(segment) || /[ .]$/u.test(segment) || RESERVED_WINDOWS_NAMES.test(segment))) {
    throw backupFailure();
  }
  return { path: directory ? `${segments.join('/')}/` : segments.join('/'), segments };
}

function scopeHash(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}

function normalizeScope(value, limits) {
  plainExact(value, ['schemaVersion', 'entries', 'totalBytes', 'fileCount', 'scopeSha256']);
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries) ||
      Object.getPrototypeOf(value.entries) !== Array.prototype || value.entries.length < 1 ||
      value.entries.length > limits.maxEntries || !Number.isSafeInteger(value.totalBytes) ||
      value.totalBytes < 0 || value.totalBytes > limits.maxTotalBytes ||
      !Number.isSafeInteger(value.fileCount) || value.fileCount < 0 ||
      typeof value.scopeSha256 !== 'string' || !HASH_PATTERN.test(value.scopeSha256)) throw backupFailure();

  const entries = value.entries.map(entry => {
    plainExact(entry, ['path', 'type', 'size', 'sha256']);
    if (!['directory', 'file'].includes(entry.type) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        entry.size > limits.maxFileBytes || (entry.type === 'directory'
          ? entry.size !== 0 || entry.sha256 !== null
          : typeof entry.sha256 !== 'string' || !HASH_PATTERN.test(entry.sha256))) throw backupFailure();
    const normalized = safeEntryPath(entry.path, entry.type, limits.maxPathDepth);
    return Object.freeze({ path: normalized.path, type: entry.type, size: entry.size, sha256: entry.sha256 });
  });
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  if (entries.some((entry, index) => entry.path !== sorted[index].path)) throw backupFailure();
  const aliases = new Set();
  const byPath = new Map();
  for (const entry of entries) {
    const alias = entry.path.replace(/\/$/u, '').toLocaleLowerCase('en-US');
    if (aliases.has(alias)) throw backupFailure();
    aliases.add(alias);
    byPath.set(entry.path, entry);
  }
  for (const entry of entries) {
    const components = entry.path.replace(/\/$/u, '').split('/');
    for (let index = 1; index < components.length; index += 1) {
      const parent = `${components.slice(0, index).join('/')}/`;
      if (byPath.get(parent)?.type !== 'directory') throw backupFailure();
    }
  }
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  const fileCount = entries.filter(entry => entry.type === 'file').length;
  if (!Number.isSafeInteger(totalBytes) || totalBytes !== value.totalBytes || fileCount !== value.fileCount ||
      scopeHash(entries) !== value.scopeSha256) throw backupFailure();
  return deepFreeze({
    schemaVersion: 1,
    entries,
    totalBytes,
    fileCount,
    scopeSha256: value.scopeSha256
  });
}

function normalizeArchiveIdentity(value) {
  const keys = ['dev', 'ino', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs'];
  plainExact(value, keys);
  for (const key of keys) {
    if (typeof value[key] !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value[key])) throw backupFailure();
  }
  return Object.freeze({ ...value });
}

function statIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    birthtimeNs: String(stat.birthtimeNs),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  });
}

function objectIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    birthtimeNs: stat.birthtimeNs,
    mode: stat.mode
  });
}

function sameObject(stat, expected) {
  return Boolean(stat && stat.dev === expected.dev && stat.ino === expected.ino &&
    stat.birthtimeNs === expected.birthtimeNs && stat.mode === expected.mode);
}

function sameArchiveIdentity(stat, expected) {
  const actual = statIdentity(stat);
  // Retain ctime in serialized evidence for compatibility, but use the pinned
  // object, write time, size and independently checked digest as authority.
  return Object.keys(actual).every(key => key === 'ctimeNs' || actual[key] === expected[key]);
}

function sameArchiveOperationStat(stat, initial) {
  // mode/nlink are local in-operation evidence, not part of the persisted
  // six-key identity. Advisory ChangeTime must not hide changes to either.
  return Boolean(stat && stat.isFile() && !stat.isSymbolicLink() &&
    sameObject(stat, initial) && stat.nlink === initial.nlink);
}

function openZip(descriptor, yauzlApi, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(cancelled());
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    yauzlApi.fromFd(descriptor, {
      autoClose: false,
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (error, zip) => {
      if (settled) {
        try { zip?.close(); } catch { /* cancellation already owns the outcome */ }
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function openEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
  });
}

function assertEntryType(entry, declared) {
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize !== declared.size ||
      !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 ||
      (entry.generalPurposeBitFlag & 1) !== 0) throw backupFailure();
  const attributes = entry.externalFileAttributes >>> 0;
  const unixType = (attributes >>> 16) & 0xf000;
  const isDirectory = entry.fileName.endsWith('/');
  if (isDirectory !== (declared.type === 'directory') ||
      (unixType !== 0 && unixType !== (isDirectory ? 0x4000 : 0x8000)) ||
      (attributes & 0x400) !== 0 || (!isDirectory && (attributes & 0x10) !== 0)) throw backupFailure();
}

async function walkPinnedZip({
  descriptor,
  expectedScope,
  faultInjector,
  onProgress,
  phase,
  signal,
  sinkFactory,
  streamIdleTimeoutMs,
  yauzlApi
}) {
  throwIfCancelled(signal);
  const declared = new Map(expectedScope.entries.map(entry => [entry.path, entry]));
  const observed = new Set();
  let measuredTotal = 0;
  let measuredFiles = 0;
  const checkpoint = createCooperativeCheckpoint(signal);
  const zip = await openZip(descriptor, yauzlApi, signal);
  throwIfCancelled(signal);
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let activeStream = null;
      const abort = () => fail(cancelled());
      const fail = error => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        const stream = activeStream;
        activeStream = null;
        if (stream && !stream.destroyed) {
          try { stream.destroy(backupFailure(error)); } catch { /* preserve cancellation or verification failure */ }
        }
        try { zip.close(); } catch { /* descriptor cleanup remains in the caller */ }
        reject(backupFailure(error));
      };
      zip.once('error', fail);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        fail(cancelled());
        return;
      }
      zip.on('entry', entry => {
        void (async () => {
          throwIfCancelled(signal);
          const type = entry.fileName.endsWith('/') ? 'directory' : 'file';
          const normalized = safeEntryPath(entry.fileName, type, DEFAULT_LIMITS.maxPathDepth).path;
          const expected = declared.get(normalized);
          if (!expected || observed.has(normalized)) throw backupFailure();
          assertEntryType(entry, expected);
          observed.add(normalized);
          if (type === 'directory') {
            await faultInjector('archive-directory', { path: normalized });
            await checkpoint();
            throwIfCancelled(signal);
            zip.readEntry();
            return;
          }

          const stream = await openEntry(zip, entry);
          if (settled) {
            try { stream.destroy(); } catch { /* cancellation already owns the outcome */ }
            return;
          }
          activeStream = stream;
          throwIfCancelled(signal);
          const sink = sinkFactory ? await sinkFactory(expected) : null;
          const hash = crypto.createHash('sha256');
          let measured = 0;
          let idleTimer = null;
          let rejectIdle;
          const idleFailure = new Promise((_, reject) => { rejectIdle = reject; });
          const clearIdleTimer = () => {
            if (idleTimer !== null) clearTimeout(idleTimer);
            idleTimer = null;
          };
          const armIdleTimer = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              const error = backupFailure();
              try { stream.destroy(error); } catch { /* reject below retains the timeout */ }
              rejectIdle(error);
            }, streamIdleTimeoutMs);
          };
          try {
            armIdleTimer();
            const consume = (async () => {
              for await (const chunk of stream) {
                throwIfCancelled(signal);
                armIdleTimer();
                if (!Buffer.isBuffer(chunk)) throw backupFailure();
                measured += chunk.length;
                if (!Number.isSafeInteger(measured) || measured > expected.size) throw backupFailure();
                hash.update(chunk);
                await sink?.write(chunk);
                throwIfCancelled(signal);
                onProgress({
                  phase,
                  processedBytes: measuredTotal + measured,
                  totalBytes: expectedScope.totalBytes,
                  processedItems: measuredFiles,
                  totalItems: expectedScope.fileCount
                });
                await checkpoint(chunk.length);
              }
            })();
            await Promise.race([consume, idleFailure]);
            clearIdleTimer();
            throwIfCancelled(signal);
            if (measured !== expected.size || hash.digest('hex') !== expected.sha256) throw backupFailure();
            await sink?.finish();
            throwIfCancelled(signal);
          } catch (error) {
            await sink?.abort?.();
            throw error;
          } finally {
            clearIdleTimer();
            activeStream = null;
          }
          measuredTotal += measured;
          measuredFiles += 1;
          await faultInjector('archive-file', { path: normalized, size: measured });
          await checkpoint();
          throwIfCancelled(signal);
          zip.readEntry();
        })().catch(fail);
      });
      zip.once('end', () => {
        if (settled) return;
        try {
          throwIfCancelled(signal);
          if (observed.size !== declared.size || measuredTotal !== expectedScope.totalBytes ||
              measuredFiles !== expectedScope.fileCount) throw backupFailure();
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
  } catch (error) {
    throw backupFailure(error);
  }
}

function assertRegularArchive(fsApi, archivePath, expectedIdentity, expectedSize) {
  const stat = fsApi.lstatSync(archivePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || !sameLocalPath(fsApi.realpathSync.native(archivePath), archivePath) ||
      !sameArchiveIdentity(stat, expectedIdentity) || stat.size !== BigInt(expectedSize)) throw backupFailure();
  return stat;
}

async function hashDescriptor(fsApi, descriptor, expectedSize, onProgress, signal) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const checkpoint = createCooperativeCheckpoint(signal);
  let offset = 0;
  try {
    while (true) {
      throwIfCancelled(signal);
      const count = fsApi.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) throw backupFailure();
      if (count === 0) break;
      offset += count;
      if (!Number.isSafeInteger(offset) || offset > expectedSize) throw backupFailure();
      hash.update(buffer.subarray(0, count));
      onProgress({
        phase: 'archive-hash',
        processedBytes: offset,
        totalBytes: expectedSize,
        processedItems: 0,
        totalItems: 0
      });
      await checkpoint(count);
    }
    throwIfCancelled(signal);
    if (offset !== expectedSize) throw backupFailure();
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
  }
}

async function inspectReparsePoint(reparseInspector, candidate, signal) {
  throwIfCancelled(signal);
  try {
    const result = await reparseInspector.isReparsePoint(candidate, signal ? { signal } : undefined);
    throwIfCancelled(signal);
    return result;
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'CANCELLED') throw cancelled(error);
    throw error;
  }
}

async function inspectDirectory(reparseInspector, fsApi, directoryPath, signal = null) {
  throwIfCancelled(signal);
  const stat = fsApi.lstatSync(directoryPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      !sameLocalPath(fsApi.realpathSync.native(directoryPath), directoryPath) ||
      await inspectReparsePoint(reparseInspector, directoryPath, signal) !== false) throw backupFailure();
  throwIfCancelled(signal);
  return objectIdentity(stat);
}

function trackCreatedDirectory(fsApi, state, directoryPath) {
  const stat = fsApi.lstatSync(directoryPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw backupFailure();
  const identity = objectIdentity(stat);
  state.directories.set(directoryPath, identity);
  if (!sameLocalPath(fsApi.realpathSync.native(directoryPath), directoryPath)) throw backupFailure();
  return identity;
}

async function revalidateDirectory(reparseInspector, fsApi, directoryPath, identity, signal = null) {
  throwIfCancelled(signal);
  const stat = fsApi.lstatSync(directoryPath, { bigint: true, throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || !sameObject(stat, identity) ||
      !sameLocalPath(fsApi.realpathSync.native(directoryPath), directoryPath) ||
      await inspectReparsePoint(reparseInspector, directoryPath, signal) !== false) throw backupFailure();
  throwIfCancelled(signal);
}

function directChildPath(root, entryPath) {
  const parts = entryPath.replace(/\/$/u, '').split('/');
  const candidate = path.resolve(root, ...parts);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw backupFailure();
  return candidate;
}

async function cleanupOwnedTree({ durableFs, fsApi, reparseInspector, state }) {
  const files = [...state.files.entries()].sort(([left], [right]) => right.length - left.length);
  for (const [filePath, identity] of files) {
    try {
      const stat = fsApi.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !sameObject(stat, identity) ||
          await reparseInspector.isReparsePoint(filePath) !== false) return;
      fsApi.unlinkSync(filePath);
      await durableFs.flushDirectory(path.dirname(filePath));
    } catch { return; }
  }
  const directories = [...state.directories.entries()].sort(([left], [right]) => right.length - left.length);
  for (const [directoryPath, identity] of directories) {
    try {
      await revalidateDirectory(reparseInspector, fsApi, directoryPath, identity);
      if (fsApi.readdirSync(directoryPath).length !== 0) return;
      fsApi.rmdirSync(directoryPath);
      await durableFs.flushDirectory(path.dirname(directoryPath));
    } catch { return; }
  }
}

async function flushDirectoryBatch(durableFs, directoryPaths, signal = null) {
  const seen = new Set();
  const unique = [];
  for (const directoryPath of directoryPaths) {
    const key = process.platform === 'win32'
      ? path.resolve(directoryPath).toLocaleLowerCase('en-US')
      : path.resolve(directoryPath);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path.resolve(directoryPath));
  }
  if (typeof durableFs.flushDirectoriesAsync === 'function') {
    for (let offset = 0; offset < unique.length; offset += MAX_FLUSH_DIRECTORIES) {
      throwIfCancelled(signal);
      await durableFs.flushDirectoriesAsync(unique.slice(offset, offset + MAX_FLUSH_DIRECTORIES));
      await defaultYieldControl();
      throwIfCancelled(signal);
    }
    return;
  }
  if (typeof durableFs.flushDirectories === 'function') {
    for (let offset = 0; offset < unique.length; offset += MAX_FLUSH_DIRECTORIES) {
      throwIfCancelled(signal);
      await durableFs.flushDirectories(unique.slice(offset, offset + MAX_FLUSH_DIRECTORIES));
      await defaultYieldControl();
      throwIfCancelled(signal);
    }
    return;
  }
  for (const directoryPath of unique) {
    throwIfCancelled(signal);
    await durableFs.flushDirectory(directoryPath);
    await defaultYieldControl();
    throwIfCancelled(signal);
  }
}

function createVerifiedRestoreExtractor(dependencies = {}) {
  plainExact(dependencies, ['durableFs', 'fsApi', 'reparseInspector', 'faultInjector', 'limits', 'streamIdleTimeoutMs', 'yauzlApi']
    .filter(key => Object.hasOwn(dependencies, key)));
  const fsApi = dependencies.fsApi || fs;
  const durableFs = dependencies.durableFs;
  const reparseInspector = dependencies.reparseInspector ||
    (process.platform === 'win32' ? new WindowsReparseInspector() : Object.freeze({ async isReparsePoint() { return false; } }));
  const faultInjector = dependencies.faultInjector || (async () => {});
  const limits = normalizeLimits(dependencies.limits);
  const streamIdleTimeoutMs = normalizeStreamIdleTimeoutMs(dependencies.streamIdleTimeoutMs);
  const yauzlApi = dependencies.yauzlApi || yauzl;
  if (!fsApi || ['closeSync', 'fstatSync', 'fsyncSync', 'lstatSync', 'mkdirSync', 'openSync', 'readSync',
    'readFileSync', 'readdirSync', 'realpathSync', 'rmdirSync', 'unlinkSync', 'writeSync'].some(method => typeof fsApi[method] !== 'function') ||
      !durableFs || typeof durableFs.flushDirectory !== 'function' ||
      !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
      typeof faultInjector !== 'function' || !yauzlApi || typeof yauzlApi.fromFd !== 'function') throw backupFailure();

  return async function extractVerifiedRestoreArchive(request) {
    let descriptor = null;
    let success = false;
    const state = { directories: new Map(), files: new Map() };
    try {
      const requestKeys = [
        'archivePath', 'stagingPath', 'expectedArchiveSha256', 'expectedArchiveSize',
        'expectedArchiveIdentity', 'expectedScope', 'operationId'
      ];
      if (Object.hasOwn(request, 'onProgress')) requestKeys.push('onProgress');
      if (Object.hasOwn(request, 'signal')) requestKeys.push('signal');
      plainExact(request, requestKeys);
      const reportProgress = createBoundedProgressReporter(request.onProgress);
      const signal = normalizeSignal(request.signal);
      throwIfCancelled(signal);
      const archivePath = localPath(request.archivePath);
      const stagingPath = localPath(request.stagingPath);
      if (sameLocalPath(archivePath, stagingPath) || !IDENTIFIER_PATTERN.test(request.operationId) ||
          typeof request.expectedArchiveSha256 !== 'string' || !HASH_PATTERN.test(request.expectedArchiveSha256) ||
          !Number.isSafeInteger(request.expectedArchiveSize) || request.expectedArchiveSize < 1) throw backupFailure();
      const expectedIdentity = normalizeArchiveIdentity(request.expectedArchiveIdentity);
      if (expectedIdentity.size !== String(request.expectedArchiveSize)) throw backupFailure();
      const expectedScope = normalizeScope(request.expectedScope, limits);
      const completeProgress = phase => ({
        phase,
        processedBytes: expectedScope.totalBytes,
        totalBytes: expectedScope.totalBytes,
        processedItems: expectedScope.fileCount,
        totalItems: expectedScope.fileCount
      });
      const parentPath = path.dirname(stagingPath);
      if (fsApi.lstatSync(stagingPath, { bigint: true, throwIfNoEntry: false })) throw backupFailure();
      const parentIdentity = await inspectDirectory(reparseInspector, fsApi, parentPath, signal);

      const before = assertRegularArchive(fsApi, archivePath, expectedIdentity, request.expectedArchiveSize);
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fsApi.openSync(archivePath, fs.constants.O_RDONLY | noFollow);
      const pinnedBefore = fsApi.fstatSync(descriptor, { bigint: true });
      if (!sameArchiveIdentity(pinnedBefore, expectedIdentity) ||
          !sameArchiveOperationStat(pinnedBefore, before)) throw backupFailure();
      const archiveSha256 = await hashDescriptor(
        fsApi,
        descriptor,
        request.expectedArchiveSize,
        reportProgress,
        signal
      );
      if (archiveSha256 !== request.expectedArchiveSha256) throw backupFailure();
      throwIfCancelled(signal);
      reportProgress({
        phase: 'archive-hash',
        processedBytes: request.expectedArchiveSize,
        totalBytes: request.expectedArchiveSize,
        processedItems: 0,
        totalItems: 0
      }, { force: true });
      throwIfCancelled(signal);
      await faultInjector('archive-pinned', { operationId: request.operationId });
      throwIfCancelled(signal);
      reportProgress({
        phase: 'entry-verification', processedBytes: 0, totalBytes: expectedScope.totalBytes,
        processedItems: 0, totalItems: expectedScope.fileCount
      }, { force: true });
      await walkPinnedZip({
        descriptor,
        expectedScope,
        faultInjector,
        onProgress: reportProgress,
        phase: 'entry-verification',
        signal,
        sinkFactory: null,
        streamIdleTimeoutMs,
        yauzlApi
      });
      throwIfCancelled(signal);
      reportProgress(completeProgress('entry-verification'), { force: true });
      const afterPreflight = fsApi.fstatSync(descriptor, { bigint: true });
      const pathAfterPreflight = assertRegularArchive(fsApi, archivePath, expectedIdentity, request.expectedArchiveSize);
      if (!sameArchiveIdentity(afterPreflight, expectedIdentity) ||
          !sameArchiveOperationStat(afterPreflight, pinnedBefore) ||
          !sameArchiveOperationStat(pathAfterPreflight, pinnedBefore)) throw backupFailure();

      await revalidateDirectory(reparseInspector, fsApi, parentPath, parentIdentity, signal);
      throwIfCancelled(signal);
      fsApi.mkdirSync(stagingPath, { recursive: false, mode: 0o700 });
      const stagingIdentity = trackCreatedDirectory(fsApi, state, stagingPath);
      await revalidateDirectory(reparseInspector, fsApi, stagingPath, stagingIdentity, signal);
      await faultInjector('staging-created', { stagingPath });
      throwIfCancelled(signal);

      const declaredDirectories = expectedScope.entries
        .filter(entry => entry.type === 'directory')
        .sort((left, right) => {
          const depth = left.path.split('/').length - right.path.split('/').length;
          return depth || left.path.localeCompare(right.path, 'en-US');
        });
      const directoryCheckpoint = createCooperativeCheckpoint(signal);
      for (const entry of declaredDirectories) {
        throwIfCancelled(signal);
        const directoryPath = directChildPath(stagingPath, entry.path);
        const parent = path.dirname(directoryPath);
        const trackedParent = state.directories.get(parent);
        if (!trackedParent) throw backupFailure();
        await revalidateDirectory(reparseInspector, fsApi, parent, trackedParent, signal);
        fsApi.mkdirSync(directoryPath, { recursive: false, mode: 0o700 });
        const directoryIdentity = trackCreatedDirectory(fsApi, state, directoryPath);
        await revalidateDirectory(reparseInspector, fsApi, directoryPath, directoryIdentity, signal);
        await directoryCheckpoint();
      }

      const sinkFactory = async entry => {
        throwIfCancelled(signal);
        const filePath = directChildPath(stagingPath, entry.path);
        const parent = path.dirname(filePath);
        const parentEntry = state.directories.get(parent);
        if (!parentEntry) throw backupFailure();
        await revalidateDirectory(reparseInspector, fsApi, parent, parentEntry, signal);
        if (fsApi.lstatSync(filePath, { bigint: true, throwIfNoEntry: false })) throw backupFailure();
        const fileDescriptor = fsApi.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL |
          fs.constants.O_WRONLY | noFollow, 0o600);
        let closed = false;
        const initial = fsApi.fstatSync(fileDescriptor, { bigint: true });
        if (!initial.isFile() || initial.isSymbolicLink?.() || initial.nlink !== 1n) {
          fsApi.closeSync(fileDescriptor);
          throw backupFailure();
        }
        state.files.set(filePath, objectIdentity(initial));
        return {
          async write(chunk) {
            throwIfCancelled(signal);
            let offset = 0;
            while (offset < chunk.length) {
              throwIfCancelled(signal);
              const written = fsApi.writeSync(fileDescriptor, chunk, offset, chunk.length - offset, null);
              if (!Number.isSafeInteger(written) || written < 1 || written > chunk.length - offset) throw backupFailure();
              offset += written;
            }
            throwIfCancelled(signal);
          },
          async finish() {
            throwIfCancelled(signal);
            fsApi.fsyncSync(fileDescriptor);
            throwIfCancelled(signal);
            const pinned = fsApi.fstatSync(fileDescriptor, { bigint: true });
            if (!sameObject(pinned, state.files.get(filePath)) || pinned.nlink !== 1n || pinned.size !== BigInt(entry.size)) {
              throw backupFailure();
            }
            fsApi.closeSync(fileDescriptor);
            closed = true;
            const published = fsApi.lstatSync(filePath, { bigint: true });
            if (!sameObject(published, state.files.get(filePath)) || published.nlink !== 1n ||
                !sameLocalPath(fsApi.realpathSync.native(filePath), filePath) ||
                await inspectReparsePoint(reparseInspector, filePath, signal) !== false) throw backupFailure();
            await faultInjector('after-file-flush', { path: entry.path });
            throwIfCancelled(signal);
          },
          async abort() {
            if (!closed) {
              try { fsApi.closeSync(fileDescriptor); } catch { /* owned tree cleanup validates the path */ }
              closed = true;
            }
          }
        };
      };

      reportProgress({
        phase: 'extraction', processedBytes: 0, totalBytes: expectedScope.totalBytes,
        processedItems: 0, totalItems: expectedScope.fileCount
      }, { force: true });
      throwIfCancelled(signal);
      await walkPinnedZip({
        descriptor,
        expectedScope,
        faultInjector,
        onProgress: reportProgress,
        phase: 'extraction',
        signal,
        sinkFactory,
        streamIdleTimeoutMs,
        yauzlApi
      });
      throwIfCancelled(signal);
      reportProgress(completeProgress('extraction'), { force: true });
      if (await hashDescriptor(fsApi, descriptor, request.expectedArchiveSize,
        () => {}, signal) !== request.expectedArchiveSha256) throw backupFailure();
      const pinnedAfter = fsApi.fstatSync(descriptor, { bigint: true });
      const pathAfter = assertRegularArchive(fsApi, archivePath, expectedIdentity, request.expectedArchiveSize);
      if (!sameArchiveIdentity(pinnedAfter, expectedIdentity) ||
          !sameArchiveOperationStat(pinnedAfter, pinnedBefore) ||
          !sameArchiveOperationStat(pathAfter, pinnedBefore)) throw backupFailure();

      const rootIdentity = state.directories.get(stagingPath);
      await revalidateDirectory(reparseInspector, fsApi, stagingPath, rootIdentity, signal);
      reportProgress({
        phase: 'output-verification', processedBytes: 0, totalBytes: expectedScope.totalBytes,
        processedItems: 0, totalItems: expectedScope.fileCount
      }, { force: true });
      throwIfCancelled(signal);
      const topLevelItems = fsApi.readdirSync(stagingPath).sort((left, right) => left.localeCompare(right, 'en-US'))
        .map(name => path.join(stagingPath, name));
      const measuredScope = await enumerateArchiveScopeCooperatively(topLevelItems, { fsApi, signal });
      if (JSON.stringify(measuredScope) !== JSON.stringify(expectedScope)) throw backupFailure();
      throwIfCancelled(signal);
      const inspection = await inspectServerDirectoryTree(stagingPath, { fsApi, reparseInspector, signal });
      await revalidateDirectory(reparseInspector, fsApi, stagingPath, rootIdentity, signal);
      const durableDirectories = [...state.directories.entries()].sort(([left], [right]) => right.length - left.length);
      for (const [directoryPath, identity] of durableDirectories) {
        await revalidateDirectory(reparseInspector, fsApi, directoryPath, identity, signal);
      }
      await flushDirectoryBatch(
        durableFs,
        [...durableDirectories.map(([directoryPath]) => directoryPath), parentPath],
        signal
      );
      await faultInjector('extraction-verified', { fingerprint: inspection.fingerprint });
      throwIfCancelled(signal);
      reportProgress(completeProgress('output-verification'), { force: true });

      throwIfCancelled(signal);
      fsApi.closeSync(descriptor);
      descriptor = null;
      success = true;
      reportProgress(completeProgress('complete'), { force: true });
      return deepFreeze({
        ok: true,
        destination: stagingPath,
        directoryIdentity: inspection.directoryIdentity,
        fingerprint: inspection.fingerprint,
        scopeSha256: measuredScope.scopeSha256
      });
    } catch (error) {
      throw backupFailure(error);
    } finally {
      if (descriptor !== null) {
        try { fsApi.closeSync(descriptor); } catch { /* preserve the extraction failure */ }
      }
      if (!success && state.directories.size > 0) {
        await cleanupOwnedTree({ durableFs, fsApi, reparseInspector, state });
      }
    }
  };
}

module.exports = {
  DEFAULT_LIMITS,
  createVerifiedRestoreExtractor
};
