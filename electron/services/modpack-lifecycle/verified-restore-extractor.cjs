const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const yauzl = require('yauzl');

const { enumerateArchiveScope } = require('../../utils/backup-util.cjs');
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

function backupFailure(cause) {
  if (cause instanceof ModpackError && cause.code === 'BACKUP_FAILED') return cause;
  return new ModpackError('BACKUP_FAILED', 'The restore archive could not be extracted safely', { cause });
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
  return Object.keys(actual).every(key => actual[key] === expected[key]);
}

function openZip(descriptor, yauzlApi) {
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

async function walkPinnedZip({ descriptor, expectedScope, faultInjector, sinkFactory, yauzlApi }) {
  const declared = new Map(expectedScope.entries.map(entry => [entry.path, entry]));
  const observed = new Set();
  let measuredTotal = 0;
  let measuredFiles = 0;
  const zip = await openZip(descriptor, yauzlApi);
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* descriptor cleanup remains in the caller */ }
        reject(backupFailure(error));
      };
      zip.once('error', fail);
      zip.on('entry', entry => {
        void (async () => {
          const type = entry.fileName.endsWith('/') ? 'directory' : 'file';
          const normalized = safeEntryPath(entry.fileName, type, DEFAULT_LIMITS.maxPathDepth).path;
          const expected = declared.get(normalized);
          if (!expected || observed.has(normalized)) throw backupFailure();
          assertEntryType(entry, expected);
          observed.add(normalized);
          if (type === 'directory') {
            await faultInjector('archive-directory', { path: normalized });
            zip.readEntry();
            return;
          }

          const stream = await openEntry(zip, entry);
          const sink = sinkFactory ? await sinkFactory(expected) : null;
          const hash = crypto.createHash('sha256');
          let measured = 0;
          try {
            for await (const chunk of stream) {
              if (!Buffer.isBuffer(chunk)) throw backupFailure();
              measured += chunk.length;
              if (!Number.isSafeInteger(measured) || measured > expected.size) throw backupFailure();
              hash.update(chunk);
              await sink?.write(chunk);
            }
            if (measured !== expected.size || hash.digest('hex') !== expected.sha256) throw backupFailure();
            await sink?.finish();
          } catch (error) {
            await sink?.abort?.();
            throw error;
          }
          measuredTotal += measured;
          measuredFiles += 1;
          await faultInjector('archive-file', { path: normalized, size: measured });
          zip.readEntry();
        })().catch(fail);
      });
      zip.once('end', () => {
        if (settled) return;
        try {
          if (observed.size !== declared.size || measuredTotal !== expectedScope.totalBytes ||
              measuredFiles !== expectedScope.fileCount) throw backupFailure();
          settled = true;
          resolve();
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
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

function hashDescriptor(fsApi, descriptor, expectedSize) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (true) {
      const count = fsApi.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) throw backupFailure();
      if (count === 0) break;
      offset += count;
      if (!Number.isSafeInteger(offset) || offset > expectedSize) throw backupFailure();
      hash.update(buffer.subarray(0, count));
    }
    if (offset !== expectedSize) throw backupFailure();
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
  }
}

async function inspectDirectory(reparseInspector, fsApi, directoryPath) {
  const stat = fsApi.lstatSync(directoryPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      !sameLocalPath(fsApi.realpathSync.native(directoryPath), directoryPath) ||
      await reparseInspector.isReparsePoint(directoryPath) !== false) throw backupFailure();
  return objectIdentity(stat);
}

async function revalidateDirectory(reparseInspector, fsApi, directoryPath, identity) {
  const stat = fsApi.lstatSync(directoryPath, { bigint: true, throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || !sameObject(stat, identity) ||
      !sameLocalPath(fsApi.realpathSync.native(directoryPath), directoryPath) ||
      await reparseInspector.isReparsePoint(directoryPath) !== false) throw backupFailure();
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

function createVerifiedRestoreExtractor(dependencies = {}) {
  plainExact(dependencies, ['durableFs', 'fsApi', 'reparseInspector', 'faultInjector', 'limits', 'yauzlApi']
    .filter(key => Object.hasOwn(dependencies, key)));
  const fsApi = dependencies.fsApi || fs;
  const durableFs = dependencies.durableFs;
  const reparseInspector = dependencies.reparseInspector ||
    (process.platform === 'win32' ? new WindowsReparseInspector() : Object.freeze({ async isReparsePoint() { return false; } }));
  const faultInjector = dependencies.faultInjector || (async () => {});
  const limits = normalizeLimits(dependencies.limits);
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
      plainExact(request, [
        'archivePath', 'stagingPath', 'expectedArchiveSha256', 'expectedArchiveSize',
        'expectedArchiveIdentity', 'expectedScope', 'operationId'
      ]);
      const archivePath = localPath(request.archivePath);
      const stagingPath = localPath(request.stagingPath);
      if (sameLocalPath(archivePath, stagingPath) || !IDENTIFIER_PATTERN.test(request.operationId) ||
          typeof request.expectedArchiveSha256 !== 'string' || !HASH_PATTERN.test(request.expectedArchiveSha256) ||
          !Number.isSafeInteger(request.expectedArchiveSize) || request.expectedArchiveSize < 1) throw backupFailure();
      const expectedIdentity = normalizeArchiveIdentity(request.expectedArchiveIdentity);
      if (expectedIdentity.size !== String(request.expectedArchiveSize)) throw backupFailure();
      const expectedScope = normalizeScope(request.expectedScope, limits);
      const parentPath = path.dirname(stagingPath);
      if (fsApi.lstatSync(stagingPath, { bigint: true, throwIfNoEntry: false })) throw backupFailure();
      const parentIdentity = await inspectDirectory(reparseInspector, fsApi, parentPath);

      const before = assertRegularArchive(fsApi, archivePath, expectedIdentity, request.expectedArchiveSize);
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fsApi.openSync(archivePath, fs.constants.O_RDONLY | noFollow);
      const pinnedBefore = fsApi.fstatSync(descriptor, { bigint: true });
      if (!pinnedBefore.isFile() || !sameArchiveIdentity(pinnedBefore, expectedIdentity) ||
          pinnedBefore.dev !== before.dev || pinnedBefore.ino !== before.ino ||
          hashDescriptor(fsApi, descriptor, request.expectedArchiveSize) !== request.expectedArchiveSha256) throw backupFailure();
      await faultInjector('archive-pinned', { operationId: request.operationId });
      await walkPinnedZip({ descriptor, expectedScope, faultInjector, sinkFactory: null, yauzlApi });
      const afterPreflight = fsApi.fstatSync(descriptor, { bigint: true });
      if (!sameArchiveIdentity(afterPreflight, expectedIdentity)) throw backupFailure();

      await revalidateDirectory(reparseInspector, fsApi, parentPath, parentIdentity);
      fsApi.mkdirSync(stagingPath, { recursive: false, mode: 0o700 });
      state.directories.set(stagingPath, await inspectDirectory(reparseInspector, fsApi, stagingPath));
      await durableFs.flushDirectory(parentPath);
      await faultInjector('staging-created', { stagingPath });

      const declaredDirectories = expectedScope.entries
        .filter(entry => entry.type === 'directory')
        .sort((left, right) => {
          const depth = left.path.split('/').length - right.path.split('/').length;
          return depth || left.path.localeCompare(right.path, 'en-US');
        });
      for (const entry of declaredDirectories) {
        const directoryPath = directChildPath(stagingPath, entry.path);
        const parent = path.dirname(directoryPath);
        const trackedParent = state.directories.get(parent);
        if (!trackedParent) throw backupFailure();
        await revalidateDirectory(reparseInspector, fsApi, parent, trackedParent);
        fsApi.mkdirSync(directoryPath, { recursive: false, mode: 0o700 });
        state.directories.set(directoryPath, await inspectDirectory(reparseInspector, fsApi, directoryPath));
        await durableFs.flushDirectory(parent);
      }

      const sinkFactory = async entry => {
        const filePath = directChildPath(stagingPath, entry.path);
        const parent = path.dirname(filePath);
        const parentEntry = state.directories.get(parent);
        if (!parentEntry) throw backupFailure();
        await revalidateDirectory(reparseInspector, fsApi, parent, parentEntry);
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
            let offset = 0;
            while (offset < chunk.length) {
              const written = fsApi.writeSync(fileDescriptor, chunk, offset, chunk.length - offset, null);
              if (!Number.isSafeInteger(written) || written < 1 || written > chunk.length - offset) throw backupFailure();
              offset += written;
            }
          },
          async finish() {
            fsApi.fsyncSync(fileDescriptor);
            const pinned = fsApi.fstatSync(fileDescriptor, { bigint: true });
            if (!sameObject(pinned, state.files.get(filePath)) || pinned.nlink !== 1n || pinned.size !== BigInt(entry.size)) {
              throw backupFailure();
            }
            fsApi.closeSync(fileDescriptor);
            closed = true;
            const published = fsApi.lstatSync(filePath, { bigint: true });
            if (!sameObject(published, state.files.get(filePath)) || published.nlink !== 1n ||
                !sameLocalPath(fsApi.realpathSync.native(filePath), filePath) ||
                await reparseInspector.isReparsePoint(filePath) !== false) throw backupFailure();
            await durableFs.flushDirectory(parent);
            await faultInjector('after-file-flush', { path: entry.path });
          },
          async abort() {
            if (!closed) {
              try { fsApi.closeSync(fileDescriptor); } catch { /* owned tree cleanup validates the path */ }
              closed = true;
            }
          }
        };
      };

      await walkPinnedZip({ descriptor, expectedScope, faultInjector, sinkFactory, yauzlApi });
      const pinnedAfter = fsApi.fstatSync(descriptor, { bigint: true });
      const pathAfter = assertRegularArchive(fsApi, archivePath, expectedIdentity, request.expectedArchiveSize);
      if (!sameArchiveIdentity(pinnedAfter, expectedIdentity) || pinnedAfter.dev !== pathAfter.dev ||
          pinnedAfter.ino !== pathAfter.ino) throw backupFailure();

      const rootIdentity = state.directories.get(stagingPath);
      await revalidateDirectory(reparseInspector, fsApi, stagingPath, rootIdentity);
      const topLevelItems = fsApi.readdirSync(stagingPath).sort((left, right) => left.localeCompare(right, 'en-US'))
        .map(name => path.join(stagingPath, name));
      const measuredScope = enumerateArchiveScope(topLevelItems, { fsApi });
      if (JSON.stringify(measuredScope) !== JSON.stringify(expectedScope)) throw backupFailure();
      const inspection = await inspectServerDirectoryTree(stagingPath, { fsApi, reparseInspector });
      await revalidateDirectory(reparseInspector, fsApi, stagingPath, rootIdentity);
      for (const [directoryPath, identity] of [...state.directories.entries()].sort(([left], [right]) => right.length - left.length)) {
        await revalidateDirectory(reparseInspector, fsApi, directoryPath, identity);
        await durableFs.flushDirectory(directoryPath);
      }
      await durableFs.flushDirectory(parentPath);
      await faultInjector('extraction-verified', { fingerprint: inspection.fingerprint });

      fsApi.closeSync(descriptor);
      descriptor = null;
      success = true;
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
