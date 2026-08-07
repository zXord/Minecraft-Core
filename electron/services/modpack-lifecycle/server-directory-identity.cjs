const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { WindowsReparseInspector } = require('../modpacks/local/windows-reparse-inspector.cjs');

const IDENTITY_KEYS = Object.freeze(['volumeSerial', 'fileId']);
const HEX_PATTERN = /^[a-f0-9]+$/;

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The server directory request is invalid', { cause });
}

function unsafe(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('UNSAFE_ARCHIVE_ENTRY', 'The server directory contains an unsafe filesystem object', {
    cause,
    details: { reasonCode: 'link-entry' }
  });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The server directory identity changed during the operation', { cause });
}

function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw invalid();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length !== keys.length || names.some(name => !keys.includes(name))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
}

function normalizeAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value !== value.normalize('NFC')) throw invalid();
  if (value.split(/[\\/]/u).some(segment => segment === '.' || segment === '..' || segment !== segment.normalize('NFC'))) {
    throw invalid();
  }
  const windowsShaped = path.win32.isAbsolute(value);
  if (windowsShaped && /^\\\\[?.]\\/.test(value.replaceAll('/', '\\'))) throw invalid();
  if (!windowsShaped && !path.isAbsolute(value)) throw invalid();
  const pathApi = windowsShaped ? path.win32 : path;
  const resolved = windowsShaped ? path.win32.normalize(value.replaceAll('/', '\\')) : path.resolve(value);
  const root = pathApi.parse(resolved).root;
  if (!root || resolved.toLocaleLowerCase('en-US') === root.toLocaleLowerCase('en-US')) throw invalid();
  return resolved;
}

function pathKey(value) {
  return normalizeAbsolutePath(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function identityFromStat(stat) {
  if (!stat || typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.dev < 0n || stat.ino < 0n) throw unsafe();
  return Object.freeze({
    volumeSerial: stat.dev.toString(16).toLocaleLowerCase('en-US'),
    fileId: stat.ino.toString(16).toLocaleLowerCase('en-US')
  });
}

function normalizeIdentity(value) {
  strictObject(value, IDENTITY_KEYS);
  if (typeof value.volumeSerial !== 'string' || !HEX_PATTERN.test(value.volumeSerial) || value.volumeSerial.length > 32 ||
      typeof value.fileId !== 'string' || !HEX_PATTERN.test(value.fileId) || value.fileId.length > 64) throw invalid();
  return Object.freeze({ volumeSerial: value.volumeSerial, fileId: value.fileId });
}

function sameIdentity(left, right) {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

function sameStatObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs &&
    left.mode === right.mode;
}

function defaultInspector() {
  if (process.platform !== 'win32') return Object.freeze({ async isReparsePoint() { return false; } });
  return new WindowsReparseInspector();
}

function dependencies(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !['durableFs', 'fsApi', 'mutableRelativePaths', 'reparseInspector', 'signal'].includes(key))) throw invalid();
  const fsApi = options.fsApi || fs;
  const reparseInspector = options.reparseInspector || defaultInspector();
  if (!fsApi || ['closeSync', 'fstatSync', 'lstatSync', 'openSync', 'readSync', 'readdirSync', 'realpathSync']
    .some(method => typeof fsApi[method] !== 'function') ||
      !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function') throw invalid();
  const mutableRelativePaths = options.mutableRelativePaths || [];
  if (!Array.isArray(mutableRelativePaths) || mutableRelativePaths.some(value => typeof value !== 'string' || value.length === 0 ||
    value !== value.normalize('NFC') || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw invalid();
  }
  const mutablePaths = new Set(mutableRelativePaths.map(value => value.toLocaleLowerCase('en-US')));
  if (mutablePaths.size !== mutableRelativePaths.length) throw invalid();
  const durableFs = options.durableFs || null;
  if (durableFs !== null && typeof durableFs.flushDirectory !== 'function') throw invalid();
  return { durableFs, fsApi, mutablePaths, reparseInspector, signal: options.signal };
}

function cancelled(signal) {
  if (signal?.aborted) throw new ModpackError('CANCELLED', 'The server directory operation was cancelled');
}

function lstatDirectory(fsApi, directoryPath) {
  const stat = fsApi.lstatSync(directoryPath, { bigint: true, throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
  return stat;
}

async function inspectReparse(reparseInspector, candidate, signal) {
  cancelled(signal);
  let result;
  try {
    result = await reparseInspector.isReparsePoint(candidate, { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'CANCELLED') {
      throw new ModpackError('CANCELLED', 'The server directory operation was cancelled', { cause: error });
    }
    throw unsafe(error);
  }
  if (result !== false) throw unsafe();
}

async function captureDirectory(directoryPath, options = {}) {
  const normalized = normalizeAbsolutePath(directoryPath);
  const { fsApi, reparseInspector, signal } = dependencies(options);
  cancelled(signal);
  let before;
  try {
    before = lstatDirectory(fsApi, normalized);
    await inspectReparse(reparseInspector, normalized, signal);
    const real = fsApi.realpathSync.native
      ? fsApi.realpathSync.native(normalized)
      : fsApi.realpathSync(normalized);
    if (pathKey(real) !== pathKey(normalized)) throw unsafe();
    const after = lstatDirectory(fsApi, normalized);
    if (!sameStatObject(before, after)) throw recoveryRequired();
  } catch (error) {
    if (error instanceof ModpackError) throw error;
    throw unsafe(error);
  }
  return Object.freeze({
    identity: identityFromStat(before),
    statIdentity: Object.freeze({
      birthtimeNs: before.birthtimeNs.toString(10),
      dev: before.dev.toString(10),
      ino: before.ino.toString(10),
      mode: before.mode.toString(10)
    })
  });
}

async function identifyServerDirectory(directoryPath, options = {}) {
  return (await captureDirectory(directoryPath, options)).identity;
}

async function assertServerDirectoryIdentity(directoryPath, expectedValue, options = {}) {
  const expected = normalizeIdentity(expectedValue);
  let actual;
  try {
    actual = await identifyServerDirectory(directoryPath, options);
  } catch (error) {
    if (error instanceof ModpackError && error.code === 'CANCELLED') throw error;
    throw recoveryRequired(error);
  }
  if (!sameIdentity(actual, expected)) throw recoveryRequired();
  return actual;
}

function readFileFingerprint(fsApi, filePath, initialStat) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fsApi.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const opened = fsApi.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || !sameStatObject(initialStat, opened) || opened.nlink !== 1n) throw unsafe();
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const count = fsApi.readSync(descriptor, chunk, 0, chunk.length, position);
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
      position += count;
    }
    const closed = fsApi.fstatSync(descriptor, { bigint: true });
    if (!sameStatObject(opened, closed) || closed.size !== opened.size || closed.mtimeNs !== opened.mtimeNs) {
      throw recoveryRequired();
    }
    return {
      sha256: digest.digest('hex'),
      size: opened.size.toString(10),
      object: `${opened.dev.toString(16)}:${opened.ino.toString(16)}:${opened.birthtimeNs.toString(16)}`
    };
  } catch (error) {
    if (error instanceof ModpackError) throw error;
    throw unsafe(error);
  } finally {
    if (descriptor !== undefined) {
      try { fsApi.closeSync(descriptor); } catch { /* identity verification already fails closed above */ }
    }
  }
}

async function inspectServerDirectoryTree(directoryPath, options = {}) {
  const normalized = normalizeAbsolutePath(directoryPath);
  const deps = dependencies(options);
  const rootBefore = await captureDirectory(normalized, options);
  const entries = [];
  const canonicalPaths = new Set();
  const seenMutablePaths = new Set();
  let totalBytes = 0n;

  async function visit(current, relativeParent) {
    cancelled(deps.signal);
    const names = deps.fsApi.readdirSync(current);
    if (!Array.isArray(names)) throw unsafe();
    const localNames = new Set();
    for (const name of names) {
      if (typeof name !== 'string' || name.length === 0 || name !== name.normalize('NFC') || name === '.' || name === '..' ||
          name.includes('\0') || name.includes('/') || name.includes('\\')) throw unsafe();
      const nameKey = name.toLocaleLowerCase('en-US');
      if (localNames.has(nameKey)) throw unsafe();
      localNames.add(nameKey);
    }
    names.sort((left, right) => left.toLocaleLowerCase('en-US').localeCompare(right.toLocaleLowerCase('en-US'), 'en-US'));
    for (const name of names) {
      const relative = relativeParent ? `${relativeParent}/${name}` : name;
      const relativeKey = relative.normalize('NFC').toLocaleLowerCase('en-US');
      if (canonicalPaths.has(relativeKey)) throw unsafe();
      canonicalPaths.add(relativeKey);
      const absolute = path.join(current, name);
      let stat;
      try { stat = deps.fsApi.lstatSync(absolute, { bigint: true, throwIfNoEntry: false }); }
      catch (error) { throw unsafe(error); }
      if (!stat || stat.isSymbolicLink()) throw unsafe();
      await inspectReparse(deps.reparseInspector, absolute, deps.signal);
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory', object: `${stat.dev.toString(16)}:${stat.ino.toString(16)}:${stat.birthtimeNs.toString(16)}` });
        await visit(absolute, relative);
        const after = deps.fsApi.lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
        if (!after || !after.isDirectory() || !sameStatObject(stat, after)) throw recoveryRequired();
      } else if (stat.isFile()) {
        if (stat.nlink !== 1n) throw unsafe();
        const fingerprint = readFileFingerprint(deps.fsApi, absolute, stat);
        if (deps.mutablePaths.has(relativeKey)) {
          seenMutablePaths.add(relativeKey);
          entries.push({ path: relative, type: 'mutable-file' });
        } else {
          totalBytes += BigInt(fingerprint.size);
          entries.push({ path: relative, type: 'file', ...fingerprint });
        }
      } else {
        throw unsafe();
      }
    }
  }

  await visit(normalized, '');
  if (seenMutablePaths.size !== deps.mutablePaths.size) throw recoveryRequired();
  const rootAfter = await captureDirectory(normalized, options);
  if (!sameIdentity(rootBefore.identity, rootAfter.identity) ||
      JSON.stringify(rootBefore.statIdentity) !== JSON.stringify(rootAfter.statIdentity)) throw recoveryRequired();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
  return deepFreeze({
    directoryIdentity: rootBefore.identity,
    fingerprint,
    entryCount: entries.length,
    totalBytes: totalBytes.toString(10)
  });
}

function sameFileFingerprint(left, right) {
  return left.sha256 === right.sha256 && left.size === right.size && left.object === right.object;
}

function assertCopyDependencies(deps) {
  const required = [
    'chmodSync', 'closeSync', 'fstatSync', 'fsyncSync', 'lstatSync', 'mkdirSync', 'openSync', 'readSync',
    'readdirSync', 'writeSync'
  ];
  if (required.some(method => typeof deps.fsApi[method] !== 'function') || !deps.durableFs) throw invalid();
}

async function copyServerDirectoryContents(sourceValue, destinationValue, options = {}) {
  const source = normalizeAbsolutePath(sourceValue);
  const destination = normalizeAbsolutePath(destinationValue);
  if (pathKey(source) === pathKey(destination)) throw invalid();
  const deps = dependencies(options);
  assertCopyDependencies(deps);
  cancelled(deps.signal);
  const sourceRoot = await captureDirectory(source, options);
  const destinationRoot = await captureDirectory(destination, options);
  if (sourceRoot.identity.volumeSerial !== destinationRoot.identity.volumeSerial) {
    throw new ModpackError('COMMIT_FAILED', 'The server candidate must be on the same volume as the live server');
  }
  if (deps.fsApi.readdirSync(destination).length !== 0) {
    throw new ModpackError('TARGET_EXISTS', 'The candidate directory is not empty');
  }
  const sourceBefore = await inspectServerDirectoryTree(source, options);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let copiedFiles = 0;
  let copiedBytes = 0n;

  async function copyDirectory(sourceDirectory, destinationDirectory) {
    cancelled(deps.signal);
    const names = deps.fsApi.readdirSync(sourceDirectory);
    if (!Array.isArray(names)) throw unsafe();
    names.sort((left, right) => left.toLocaleLowerCase('en-US').localeCompare(right.toLocaleLowerCase('en-US'), 'en-US'));
    const localNames = new Set();
    for (const name of names) {
      if (typeof name !== 'string' || !name || name !== name.normalize('NFC') || name === '.' || name === '..' ||
          name.includes('/') || name.includes('\\') || name.includes('\0')) throw unsafe();
      const key = name.toLocaleLowerCase('en-US');
      if (localNames.has(key)) throw unsafe();
      localNames.add(key);
      const sourcePath = path.join(sourceDirectory, name);
      const destinationPath = path.join(destinationDirectory, name);
      const initial = deps.fsApi.lstatSync(sourcePath, { bigint: true, throwIfNoEntry: false });
      if (!initial || initial.isSymbolicLink()) throw unsafe();
      await inspectReparse(deps.reparseInspector, sourcePath, deps.signal);
      if (initial.isDirectory()) {
        deps.fsApi.mkdirSync(destinationPath, { recursive: false, mode: Number(initial.mode & 0o777n) });
        deps.durableFs.flushDirectory(destinationDirectory);
        await inspectReparse(deps.reparseInspector, destinationPath, deps.signal);
        await copyDirectory(sourcePath, destinationPath);
        const final = deps.fsApi.lstatSync(sourcePath, { bigint: true, throwIfNoEntry: false });
        if (!final || !final.isDirectory() || !sameStatObject(initial, final)) throw recoveryRequired();
        deps.durableFs.flushDirectory(destinationPath);
        continue;
      }
      if (!initial.isFile() || initial.nlink !== 1n) throw unsafe();
      const expected = readFileFingerprint(deps.fsApi, sourcePath, initial);
      let sourceDescriptor;
      let destinationDescriptor;
      try {
        sourceDescriptor = deps.fsApi.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
        const openedSource = deps.fsApi.fstatSync(sourceDescriptor, { bigint: true });
        if (!openedSource.isFile() || openedSource.nlink !== 1n || !sameStatObject(initial, openedSource)) throw recoveryRequired();
        destinationDescriptor = deps.fsApi.openSync(
          destinationPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
          Number(initial.mode & 0o777n)
        );
        const digest = crypto.createHash('sha256');
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (true) {
          cancelled(deps.signal);
          const count = deps.fsApi.readSync(sourceDescriptor, chunk, 0, chunk.length, position);
          if (count === 0) break;
          digest.update(chunk.subarray(0, count));
          let written = 0;
          while (written < count) {
            written += deps.fsApi.writeSync(destinationDescriptor, chunk, written, count - written, position + written);
          }
          position += count;
        }
        const closedSource = deps.fsApi.fstatSync(sourceDescriptor, { bigint: true });
        const destinationStat = deps.fsApi.fstatSync(destinationDescriptor, { bigint: true });
        if (!sameStatObject(openedSource, closedSource) || closedSource.size !== openedSource.size ||
            closedSource.mtimeNs !== openedSource.mtimeNs || destinationStat.nlink !== 1n ||
            (destinationStat.dev === openedSource.dev && destinationStat.ino === openedSource.ino) ||
            digest.digest('hex') !== expected.sha256 || destinationStat.size.toString(10) !== expected.size) {
          throw recoveryRequired();
        }
        deps.fsApi.fsyncSync(destinationDescriptor);
        copiedFiles += 1;
        copiedBytes += BigInt(expected.size);
      } catch (error) {
        if (error instanceof ModpackError) throw error;
        throw unsafe(error);
      } finally {
        if (destinationDescriptor !== undefined) {
          try { deps.fsApi.closeSync(destinationDescriptor); } catch { /* the transaction remains failed closed */ }
        }
        if (sourceDescriptor !== undefined) {
          try { deps.fsApi.closeSync(sourceDescriptor); } catch { /* the transaction remains failed closed */ }
        }
      }
      deps.fsApi.chmodSync(destinationPath, Number(initial.mode & 0o777n));
      deps.durableFs.flushDirectory(destinationDirectory);
      const finalFingerprint = readFileFingerprint(
        deps.fsApi,
        sourcePath,
        deps.fsApi.lstatSync(sourcePath, { bigint: true })
      );
      if (!sameFileFingerprint(expected, finalFingerprint)) throw recoveryRequired();
    }
  }

  await copyDirectory(source, destination);
  deps.durableFs.flushDirectory(destination);
  const sourceAfter = await inspectServerDirectoryTree(source, options);
  if (sourceBefore.fingerprint !== sourceAfter.fingerprint ||
      !sameIdentity(sourceBefore.directoryIdentity, sourceAfter.directoryIdentity)) throw recoveryRequired();
  const destinationAfter = await inspectServerDirectoryTree(destination, options);
  if (!sameIdentity(destinationRoot.identity, destinationAfter.directoryIdentity)) throw recoveryRequired();
  return deepFreeze({
    copiedBytes: copiedBytes.toString(10),
    copiedFiles,
    destinationIdentity: destinationAfter.directoryIdentity,
    destinationFingerprint: destinationAfter.fingerprint,
    sourceFingerprint: sourceAfter.fingerprint,
    sourceIdentity: sourceAfter.directoryIdentity
  });
}

module.exports = {
  assertServerDirectoryIdentity,
  copyServerDirectoryContents,
  identifyServerDirectory,
  inspectServerDirectoryTree,
  normalizeServerDirectoryPath: normalizeAbsolutePath
};
