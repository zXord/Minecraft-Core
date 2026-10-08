const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { MAX_FLUSH_DIRECTORIES } = require('../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { WindowsReparseInspector } = require('../modpacks/local/windows-reparse-inspector.cjs');

const IDENTITY_KEYS = Object.freeze(['volumeSerial', 'fileId']);
const HEX_PATTERN = /^[a-f0-9]+$/;
const COOPERATIVE_YIELD_BYTES = 8 * 1024 * 1024;
const COOPERATIVE_YIELD_ENTRIES = 64;
const copySourceSnapshots = new WeakMap();

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

function staleCapacity(cause) {
  return new ModpackError('PLAN_STALE', 'Available disk capacity changed after review', {
    cause,
    details: { field: 'availableBytes' }
  });
}

function copyIoFailure(cause) {
  if (cause instanceof ModpackError) return cause;
  if (cause?.code === 'ENOSPC' || cause?.code === 'EDQUOT') return staleCapacity(cause);
  return unsafe(cause);
}

function sameEntryStat(left, right) {
  // Windows ChangeTime (`ctimeNs`) is advisory: sync, backup, indexing, and
  // antivirus software may update it without changing the directory entry or
  // file bytes. Object identity, last-write time, size, membership, reparse
  // evidence, and SHA-256 checks remain authoritative throughout this module.
  return sameStatObject(left, right) && left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink && left.size === right.size;
}

function fileStatEvidence(stat) {
  return Object.freeze({
    birthtimeNs: stat.birthtimeNs.toString(10),
    dev: stat.dev.toString(10),
    ino: stat.ino.toString(10),
    mode: stat.mode.toString(10),
    mtimeNs: stat.mtimeNs.toString(10),
    nlink: stat.nlink.toString(10),
    size: stat.size.toString(10)
  });
}

function matchesFileStatEvidence(stat, evidence) {
  return stat.birthtimeNs.toString(10) === evidence.birthtimeNs &&
    stat.dev.toString(10) === evidence.dev &&
    stat.ino.toString(10) === evidence.ino &&
    stat.mode.toString(10) === evidence.mode &&
    stat.mtimeNs.toString(10) === evidence.mtimeNs &&
    stat.nlink.toString(10) === evidence.nlink &&
    stat.size.toString(10) === evidence.size;
}

async function lstatEntry(fsPromises, candidate) {
  try { return await fsPromises.lstat(candidate, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertFilePathStable(deps, filePath, opened, { exact = true } = {}) {
  let current;
  try { current = await lstatEntry(deps.fsPromises, filePath); }
  catch (error) { throw recoveryRequired(error); }
  if (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
      !sameStatObject(opened, current) || (exact && !sameEntryStat(opened, current))) throw recoveryRequired();
  return current;
}

async function readDirectoryNames(fsPromises, directoryPath) {
  const names = await fsPromises.readdir(directoryPath);
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
  return names;
}

async function assertDirectoryMembershipStable(fsPromises, directoryPath, expectedNames) {
  let actual;
  try { actual = await readDirectoryNames(fsPromises, directoryPath); }
  catch (error) {
    if (error instanceof ModpackError) throw error;
    throw recoveryRequired(error);
  }
  if (actual.length !== expectedNames.length || actual.some((name, index) => name !== expectedNames[index])) {
    throw recoveryRequired();
  }
}

function defaultInspector() {
  if (process.platform !== 'win32') return Object.freeze({ async isReparsePoint() { return false; } });
  return new WindowsReparseInspector();
}

function defaultYieldControl() {
  return new Promise(resolve => setImmediate(resolve));
}

function dependencies(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => ![
        'authorizeSourceSnapshot', 'durableFs', 'expectedSourceSnapshot', 'fsApi', 'fsPromises',
        'mutableRelativePaths', 'reparseInspector', 'signal', 'yieldControl', 'onCopyProgress'
      ].includes(key))) throw invalid();
  const fsApi = options.fsApi || fs;
  const fsPromises = options.fsPromises || fsApi.promises || fsp;
  const reparseInspector = options.reparseInspector || defaultInspector();
  const yieldControl = options.yieldControl || defaultYieldControl;
  if (!fsApi || typeof fsApi !== 'object' ||
      !fsPromises || ['chmod', 'lstat', 'mkdir', 'open', 'readdir', 'realpath', 'rmdir', 'unlink']
        .some(method => typeof fsPromises[method] !== 'function') ||
      !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' || typeof yieldControl !== 'function' ||
      (options.authorizeSourceSnapshot !== undefined && typeof options.authorizeSourceSnapshot !== 'function') ||
      (options.onCopyProgress !== undefined && typeof options.onCopyProgress !== 'function') ||
      (options.expectedSourceSnapshot !== undefined && !copySourceSnapshots.has(options.expectedSourceSnapshot))) throw invalid();
  const mutableRelativePaths = options.mutableRelativePaths || [];
  if (!Array.isArray(mutableRelativePaths) || mutableRelativePaths.some(value => typeof value !== 'string' || value.length === 0 ||
    value !== value.normalize('NFC') || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw invalid();
  }
  const mutablePaths = new Set(mutableRelativePaths.map(value => value.toLocaleLowerCase('en-US')));
  if (mutablePaths.size !== mutableRelativePaths.length) throw invalid();
  const durableFs = options.durableFs || null;
  if (durableFs !== null && typeof durableFs.flushDirectoriesAsync !== 'function' &&
      typeof durableFs.flushDirectoryAsync !== 'function') throw invalid();
  return {
    authorizeSourceSnapshot: options.authorizeSourceSnapshot,
    durableFs,
    expectedSourceSnapshot: options.expectedSourceSnapshot,
    fsApi,
    fsPromises,
    mutablePaths,
    onCopyProgress: options.onCopyProgress,
    reparseInspector,
    signal: options.signal,
    yieldControl
  };
}

async function flushDirectoryBatch(durableFs, directoryPaths, yieldControl = defaultYieldControl, signal) {
  const seen = new Set();
  const unique = [];
  for (const directoryPath of directoryPaths) {
    const resolved = normalizeAbsolutePath(directoryPath);
    const key = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resolved);
  }
  if (typeof durableFs.flushDirectoriesAsync === 'function') {
    for (let offset = 0; offset < unique.length; offset += MAX_FLUSH_DIRECTORIES) {
      await durableFs.flushDirectoriesAsync(unique.slice(offset, offset + MAX_FLUSH_DIRECTORIES));
      await yieldControl();
      cancelled(signal);
    }
    return;
  }
  for (const directoryPath of unique) {
    await durableFs.flushDirectoryAsync(directoryPath);
    await yieldControl();
    cancelled(signal);
  }
}

function cancelled(signal) {
  if (signal?.aborted) throw new ModpackError('CANCELLED', 'The server directory operation was cancelled');
}

async function lstatDirectory(fsPromises, directoryPath) {
  const stat = await lstatEntry(fsPromises, directoryPath);
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
  const { fsPromises, reparseInspector, signal } = dependencies(options);
  cancelled(signal);
  let before;
  try {
    before = await lstatDirectory(fsPromises, normalized);
    await inspectReparse(reparseInspector, normalized, signal);
    const real = await fsPromises.realpath(normalized);
    if (pathKey(real) !== pathKey(normalized)) throw unsafe();
    const after = await lstatDirectory(fsPromises, normalized);
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

async function readFileFingerprint(filePath, initialStat, flushFile, deps) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await deps.fsPromises.open(
      filePath,
      (flushFile ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | noFollow
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || !sameStatObject(initialStat, opened) || opened.nlink !== 1n) throw unsafe();
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    let bytesSinceYield = 0;
    while (true) {
      cancelled(deps.signal);
      const result = await handle.read(chunk, 0, chunk.length, position);
      const count = result?.bytesRead;
      if (!Number.isSafeInteger(count) || count < 0 || count > chunk.length) throw recoveryRequired();
      if (count === 0) break;
      digest.update(chunk.subarray(0, count));
      position += count;
      bytesSinceYield += count;
      if (bytesSinceYield >= COOPERATIVE_YIELD_BYTES) {
        await deps.yieldControl();
        cancelled(deps.signal);
        await assertFilePathStable(deps, filePath, opened);
        bytesSinceYield = 0;
      }
    }
    if (bytesSinceYield > 0) {
      await deps.yieldControl();
      cancelled(deps.signal);
      await assertFilePathStable(deps, filePath, opened);
    }
    let closed = await handle.stat({ bigint: true });
    if (!sameEntryStat(opened, closed)) throw recoveryRequired();
    await assertFilePathStable(deps, filePath, closed);
    if (flushFile) {
      await deps.yieldControl();
      cancelled(deps.signal);
      await assertFilePathStable(deps, filePath, closed);
      await handle.sync();
      await deps.yieldControl();
      cancelled(deps.signal);
      await assertFilePathStable(deps, filePath, closed);
      const durable = await handle.stat({ bigint: true });
      if (!sameEntryStat(closed, durable)) throw recoveryRequired();
      closed = durable;
    }
    return {
      sha256: digest.digest('hex'),
      size: opened.size.toString(10),
      object: `${opened.dev.toString(16)}:${opened.ino.toString(16)}:${opened.birthtimeNs.toString(16)}`,
      statEvidence: fileStatEvidence(closed)
    };
  } catch (error) {
    if (error instanceof ModpackError) throw error;
    if (flushFile) throw new ModpackError('COMMIT_FAILED', 'The server directory could not be flushed durably', { cause: error });
    throw unsafe(error);
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* identity verification already fails closed above */ }
    }
  }
}

async function inspectServerDirectoryTreeEvidence(directoryPath, options = {}, flushTree = false) {
  const normalized = normalizeAbsolutePath(directoryPath);
  const deps = dependencies(options);
  if (flushTree && !deps.durableFs) throw invalid();
  const rootBefore = await captureDirectory(normalized, options);
  const entries = [];
  const entryEvidence = new Map();
  const canonicalPaths = new Set();
  const seenMutablePaths = new Set();
  const durableDirectories = [];
  const stableDirectories = new Map();
  const stableEntries = new Map();
  let totalBytes = 0n;
  let visitedEntries = 0;

  async function yieldAfterEntry() {
    visitedEntries += 1;
    if (visitedEntries % COOPERATIVE_YIELD_ENTRIES !== 0) return;
    await deps.yieldControl();
    cancelled(deps.signal);
  }

  async function visit(current, relativeParent) {
    cancelled(deps.signal);
    const directoryBefore = await lstatDirectory(deps.fsPromises, current);
    const names = await readDirectoryNames(deps.fsPromises, current);
    stableDirectories.set(current, Object.freeze([...names]));
    for (const name of names) {
      const relative = relativeParent ? `${relativeParent}/${name}` : name;
      const relativeKey = relative.normalize('NFC').toLocaleLowerCase('en-US');
      if (canonicalPaths.has(relativeKey)) throw unsafe();
      canonicalPaths.add(relativeKey);
      const absolute = path.join(current, name);
      let stat;
      try { stat = await lstatEntry(deps.fsPromises, absolute); }
      catch (error) { throw unsafe(error); }
      if (!stat || stat.isSymbolicLink()) throw unsafe();
      await inspectReparse(deps.reparseInspector, absolute, deps.signal);
      if (stat.isDirectory()) {
        const entry = { path: relative, type: 'directory', object: `${stat.dev.toString(16)}:${stat.ino.toString(16)}:${stat.birthtimeNs.toString(16)}` };
        entries.push(entry);
        entryEvidence.set(relativeKey, Object.freeze({ ...entry, statEvidence: fileStatEvidence(stat) }));
        await visit(absolute, relative);
        const after = await lstatEntry(deps.fsPromises, absolute);
        if (!after || !after.isDirectory() || !sameEntryStat(stat, after)) throw recoveryRequired();
        const statEvidence = fileStatEvidence(after);
        entryEvidence.set(relativeKey, Object.freeze({ ...entry, statEvidence }));
        stableEntries.set(absolute, Object.freeze({ type: 'directory', statEvidence }));
      } else if (stat.isFile()) {
        if (stat.nlink !== 1n) throw unsafe();
        const { statEvidence, ...fingerprint } = await readFileFingerprint(absolute, stat, flushTree, deps);
        if (deps.mutablePaths.has(relativeKey)) {
          seenMutablePaths.add(relativeKey);
          const entry = { path: relative, type: 'mutable-file' };
          entries.push(entry);
          entryEvidence.set(relativeKey, Object.freeze({ ...entry, ...fingerprint, statEvidence }));
        } else {
          totalBytes += BigInt(fingerprint.size);
          const entry = { path: relative, type: 'file', ...fingerprint };
          entries.push(entry);
          entryEvidence.set(relativeKey, Object.freeze({ ...entry, statEvidence }));
        }
        stableEntries.set(absolute, Object.freeze({ type: 'file', statEvidence }));
      } else {
        throw unsafe();
      }
      await yieldAfterEntry();
    }
    await assertDirectoryMembershipStable(deps.fsPromises, current, names);
    const directoryAfter = await lstatDirectory(deps.fsPromises, current);
    if (!sameEntryStat(directoryBefore, directoryAfter)) throw recoveryRequired();
    if (flushTree) {
      durableDirectories.push(current);
    }
  }

  async function assertTreeEvidenceStable() {
    let checkedEntries = 0;
    const checkpoint = async () => {
      checkedEntries += 1;
      if (checkedEntries % COOPERATIVE_YIELD_ENTRIES !== 0) return;
      await deps.yieldControl();
      cancelled(deps.signal);
    };
    for (const [directoryPath, names] of stableDirectories) {
      await assertDirectoryMembershipStable(deps.fsPromises, directoryPath, names);
      await checkpoint();
    }
    for (const [entryPath, evidence] of stableEntries) {
      const stat = await lstatEntry(deps.fsPromises, entryPath);
      if (!stat || stat.isSymbolicLink() ||
          (evidence.type === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) ||
          !matchesFileStatEvidence(stat, evidence.statEvidence)) throw recoveryRequired();
      await checkpoint();
    }
  }

  await visit(normalized, '');
  if (flushTree) {
    try { await flushDirectoryBatch(deps.durableFs, durableDirectories, deps.yieldControl, deps.signal); }
    catch (error) {
      if (error instanceof ModpackError) throw error;
      throw new ModpackError('COMMIT_FAILED', 'The server directory could not be flushed durably', { cause: error });
    }
  }
  if (seenMutablePaths.size !== deps.mutablePaths.size) throw recoveryRequired();
  const rootAfter = await captureDirectory(normalized, options);
  if (!sameIdentity(rootBefore.identity, rootAfter.identity) ||
      JSON.stringify(rootBefore.statIdentity) !== JSON.stringify(rootAfter.statIdentity)) throw recoveryRequired();
  await assertTreeEvidenceStable();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
  const inspection = deepFreeze({
    directoryIdentity: rootBefore.identity,
    fingerprint,
    entryCount: entries.length,
    totalBytes: totalBytes.toString(10)
  });
  return { entryEvidence, inspection };
}

function registerCopySourceSnapshot(source, treeSnapshot) {
  const entries = [...treeSnapshot.entryEvidence.entries()]
    .map(([relativeKey, evidence]) => {
      const statEvidence = evidence.statEvidence;
      if (!statEvidence) throw recoveryRequired();
      const file = evidence.type === 'file' || evidence.type === 'mutable-file';
      return {
        path: evidence.path,
        pathKey: relativeKey,
        type: file ? 'file' : 'directory',
        size: file ? evidence.size : '0',
        sha256: file ? evidence.sha256 : null,
        dev: statEvidence.dev,
        ino: statEvidence.ino,
        birthtime: statEvidence.birthtimeNs
      };
    })
    .sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  const sourceSnapshot = deepFreeze({
    directoryIdentity: { ...treeSnapshot.inspection.directoryIdentity },
    fingerprint: treeSnapshot.inspection.fingerprint,
    totalBytes: treeSnapshot.inspection.totalBytes,
    entries
  });
  copySourceSnapshots.set(sourceSnapshot, Object.freeze({
    entryEvidence: treeSnapshot.entryEvidence,
    inspection: treeSnapshot.inspection,
    sourceKey: pathKey(source)
  }));
  return sourceSnapshot;
}

async function captureServerDirectoryCopySource(directoryPath, options = {}) {
  const source = normalizeAbsolutePath(directoryPath);
  const treeSnapshot = await inspectServerDirectoryTreeEvidence(source, options);
  return registerCopySourceSnapshot(source, treeSnapshot);
}

async function inspectServerDirectoryStructure(directoryPath, options = {}) {
  const normalized = normalizeAbsolutePath(directoryPath);
  const deps = dependencies(options);
  const rootBefore = await captureDirectory(normalized, options);
  const canonicalPaths = new Set();
  const stableDirectories = new Map();
  const stableEntries = new Map();
  let entryCount = 0;

  async function checkpoint() {
    entryCount += 1;
    if (entryCount % COOPERATIVE_YIELD_ENTRIES !== 0) return;
    await deps.yieldControl();
    cancelled(deps.signal);
  }

  async function visit(current, relativeParent) {
    cancelled(deps.signal);
    const directoryBefore = await lstatDirectory(deps.fsPromises, current);
    const names = await readDirectoryNames(deps.fsPromises, current);
    stableDirectories.set(current, Object.freeze([...names]));
    for (const name of names) {
      const relative = relativeParent ? `${relativeParent}/${name}` : name;
      const relativeKey = relative.normalize('NFC').toLocaleLowerCase('en-US');
      if (canonicalPaths.has(relativeKey)) throw unsafe();
      canonicalPaths.add(relativeKey);
      const absolute = path.join(current, name);
      let stat;
      try { stat = await lstatEntry(deps.fsPromises, absolute); }
      catch (error) { throw unsafe(error); }
      if (!stat || stat.isSymbolicLink()) throw unsafe();
      await inspectReparse(deps.reparseInspector, absolute, deps.signal);
      if (stat.isDirectory()) {
        await visit(absolute, relative);
        const after = await lstatEntry(deps.fsPromises, absolute);
        if (!after || !after.isDirectory() || !sameEntryStat(stat, after)) throw recoveryRequired();
        stableEntries.set(absolute, Object.freeze({ type: 'directory', statEvidence: fileStatEvidence(after) }));
      } else if (stat.isFile()) {
        if (stat.nlink !== 1n) throw unsafe();
        stableEntries.set(absolute, Object.freeze({ type: 'file', statEvidence: fileStatEvidence(stat) }));
      } else {
        throw unsafe();
      }
      await checkpoint();
    }
    await assertDirectoryMembershipStable(deps.fsPromises, current, names);
    const directoryAfter = await lstatDirectory(deps.fsPromises, current);
    if (!sameEntryStat(directoryBefore, directoryAfter)) throw recoveryRequired();
  }

  await visit(normalized, '');
  let verifiedEntries = 0;
  const verificationCheckpoint = async () => {
    verifiedEntries += 1;
    if (verifiedEntries % COOPERATIVE_YIELD_ENTRIES !== 0) return;
    await deps.yieldControl();
    cancelled(deps.signal);
  };
  for (const [directoryPathValue, names] of stableDirectories) {
    await assertDirectoryMembershipStable(deps.fsPromises, directoryPathValue, names);
    await verificationCheckpoint();
  }
  for (const [entryPath, evidence] of stableEntries) {
    const stat = await lstatEntry(deps.fsPromises, entryPath);
    if (!stat || stat.isSymbolicLink() ||
        (evidence.type === 'file' ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) ||
        !matchesFileStatEvidence(stat, evidence.statEvidence)) throw recoveryRequired();
    await verificationCheckpoint();
  }
  const rootAfter = await captureDirectory(normalized, options);
  if (!sameIdentity(rootBefore.identity, rootAfter.identity) ||
      JSON.stringify(rootBefore.statIdentity) !== JSON.stringify(rootAfter.statIdentity)) throw recoveryRequired();
  return deepFreeze({ directoryIdentity: rootBefore.identity, entryCount });
}

async function inspectServerDirectoryTree(directoryPath, options = {}) {
  return (await inspectServerDirectoryTreeEvidence(directoryPath, options)).inspection;
}

async function inspectAndFlushServerDirectoryTree(directoryPath, options = {}) {
  return (await inspectServerDirectoryTreeEvidence(directoryPath, options, true)).inspection;
}

function assertCopyDependencies(deps) {
  const required = ['chmod', 'lstat', 'mkdir', 'open', 'readdir'];
  if (required.some(method => typeof deps.fsPromises[method] !== 'function') || !deps.durableFs) throw invalid();
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
  if ((await readDirectoryNames(deps.fsPromises, destination)).length !== 0) {
    throw new ModpackError('TARGET_EXISTS', 'The candidate directory is not empty');
  }
  let sourceSnapshot;
  let authorization;
  if (deps.expectedSourceSnapshot) {
    sourceSnapshot = copySourceSnapshots.get(deps.expectedSourceSnapshot);
    if (!sourceSnapshot || sourceSnapshot.sourceKey !== pathKey(source)) throw invalid();
    authorization = deps.expectedSourceSnapshot;
  } else {
    const captured = await inspectServerDirectoryTreeEvidence(source, options);
    authorization = registerCopySourceSnapshot(source, captured);
    sourceSnapshot = copySourceSnapshots.get(authorization);
  }
  const sourceBefore = sourceSnapshot.inspection;
  const expectedEntries = sourceSnapshot.entryEvidence;
  if (!sameIdentity(sourceRoot.identity, sourceBefore.directoryIdentity)) throw recoveryRequired();
  if (deps.authorizeSourceSnapshot) {
    await deps.authorizeSourceSnapshot(authorization);
    cancelled(deps.signal);
  }
  const copiedEntries = new Set();
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let copiedFiles = 0;
  let copiedBytes = 0n;
  const durableDirectories = [];
  const expectedFiles = [...expectedEntries.values()].filter(entry => entry.type !== 'directory');
  const totalFiles = expectedFiles.length;
  const totalCopyBytes = expectedFiles.reduce((total, entry) => total + BigInt(entry.size), 0n).toString();
  const reportCopy = async activity => {
    if (!deps.onCopyProgress) return;
    const event = activity === 'copying-live-files'
      ? { activity, completedItems: String(copiedFiles), totalItems: String(totalFiles),
          completedBytes: copiedBytes.toString(), totalBytes: totalCopyBytes }
      : { activity };
    try { await deps.onCopyProgress(deepFreeze(event)); } catch { /* Progress is not publication authority. */ }
  };
  await reportCopy('copying-live-files');

  async function copyDirectory(sourceDirectory, destinationDirectory, relativeParent) {
    cancelled(deps.signal);
    const names = await readDirectoryNames(deps.fsPromises, sourceDirectory);
    for (const name of names) {
      const relative = relativeParent ? `${relativeParent}/${name}` : name;
      const relativeKey = relative.normalize('NFC').toLocaleLowerCase('en-US');
      const expected = expectedEntries.get(relativeKey);
      if (!expected || copiedEntries.has(relativeKey)) throw recoveryRequired();
      copiedEntries.add(relativeKey);
      const sourcePath = path.join(sourceDirectory, name);
      const destinationPath = path.join(destinationDirectory, name);
      const initial = await lstatEntry(deps.fsPromises, sourcePath);
      if (!initial || initial.isSymbolicLink()) throw unsafe();
      await inspectReparse(deps.reparseInspector, sourcePath, deps.signal);
      if (initial.isDirectory()) {
        if (expected.type !== 'directory' ||
            expected.object !== `${initial.dev.toString(16)}:${initial.ino.toString(16)}:${initial.birthtimeNs.toString(16)}`) {
          throw recoveryRequired();
        }
        try {
          await deps.fsPromises.mkdir(destinationPath, { recursive: false, mode: Number(initial.mode & 0o777n) });
        } catch (error) {
          throw copyIoFailure(error);
        }
        await inspectReparse(deps.reparseInspector, destinationPath, deps.signal);
        await copyDirectory(sourcePath, destinationPath, relative);
        const final = await lstatEntry(deps.fsPromises, sourcePath);
        if (!final || !final.isDirectory() || !sameStatObject(initial, final)) throw recoveryRequired();
        durableDirectories.push(destinationPath);
        continue;
      }
      if (!initial.isFile() || initial.nlink !== 1n) throw unsafe();
      if (!['file', 'mutable-file'].includes(expected.type) ||
          !matchesFileStatEvidence(initial, expected.statEvidence)) throw recoveryRequired();
      let sourceHandle;
      let destinationHandle;
      let openedDestination;
      try {
        sourceHandle = await deps.fsPromises.open(sourcePath, fs.constants.O_RDONLY | noFollow);
        const openedSource = await sourceHandle.stat({ bigint: true });
        if (!openedSource.isFile() || openedSource.nlink !== 1n ||
            !matchesFileStatEvidence(openedSource, expected.statEvidence)) throw recoveryRequired();
        destinationHandle = await deps.fsPromises.open(
          destinationPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
          Number(initial.mode & 0o777n)
        );
        openedDestination = await destinationHandle.stat({ bigint: true });
        if (!openedDestination.isFile() || openedDestination.nlink !== 1n ||
            (openedDestination.dev === openedSource.dev && openedDestination.ino === openedSource.ino)) {
          throw recoveryRequired();
        }
        const digest = crypto.createHash('sha256');
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        let bytesSinceYield = 0;
        while (true) {
          cancelled(deps.signal);
          const readResult = await sourceHandle.read(chunk, 0, chunk.length, position);
          const count = readResult?.bytesRead;
          if (!Number.isSafeInteger(count) || count < 0 || count > chunk.length) throw recoveryRequired();
          if (count === 0) break;
          digest.update(chunk.subarray(0, count));
          let written = 0;
          while (written < count) {
            const writeResult = await destinationHandle.write(
              chunk,
              written,
              count - written,
              position + written
            );
            const bytesWritten = writeResult?.bytesWritten;
            if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > count - written) {
              throw recoveryRequired();
            }
            written += bytesWritten;
          }
          position += count;
          bytesSinceYield += count;
          if (bytesSinceYield >= COOPERATIVE_YIELD_BYTES) {
            await deps.yieldControl();
            cancelled(deps.signal);
            await assertFilePathStable(deps, sourcePath, openedSource);
            await assertFilePathStable(deps, destinationPath, openedDestination, { exact: false });
            bytesSinceYield = 0;
          }
        }
        if (bytesSinceYield > 0) {
          await deps.yieldControl();
          cancelled(deps.signal);
          await assertFilePathStable(deps, sourcePath, openedSource);
          await assertFilePathStable(deps, destinationPath, openedDestination, { exact: false });
        }
        const closedSource = await sourceHandle.stat({ bigint: true });
        const destinationStat = await destinationHandle.stat({ bigint: true });
        if (!sameStatObject(openedSource, closedSource) || closedSource.size !== openedSource.size ||
            closedSource.mtimeNs !== openedSource.mtimeNs || destinationStat.nlink !== 1n ||
            (destinationStat.dev === openedSource.dev && destinationStat.ino === openedSource.ino) ||
            digest.digest('hex') !== expected.sha256 || destinationStat.size.toString(10) !== expected.size) {
          throw recoveryRequired();
        }
        await deps.yieldControl();
        cancelled(deps.signal);
        await assertFilePathStable(deps, sourcePath, closedSource);
        await assertFilePathStable(deps, destinationPath, destinationStat);
        await destinationHandle.sync();
        await deps.yieldControl();
        cancelled(deps.signal);
        await assertFilePathStable(deps, sourcePath, closedSource);
        await assertFilePathStable(deps, destinationPath, destinationStat);
        const durableDestination = await destinationHandle.stat({ bigint: true });
        if (!sameEntryStat(destinationStat, durableDestination)) throw recoveryRequired();
        copiedFiles += 1;
        copiedBytes += BigInt(expected.size);
      } catch (error) {
        throw copyIoFailure(error);
      } finally {
        if (destinationHandle !== undefined) {
          try { await destinationHandle.close(); } catch { /* the transaction remains failed closed */ }
        }
        if (sourceHandle !== undefined) {
          try { await sourceHandle.close(); } catch { /* the transaction remains failed closed */ }
        }
      }
      try {
        await deps.fsPromises.chmod(destinationPath, Number(initial.mode & 0o777n));
      } catch (error) {
        throw copyIoFailure(error);
      }
      const chmodStat = await lstatEntry(deps.fsPromises, destinationPath);
      if (!chmodStat || !chmodStat.isFile() || chmodStat.isSymbolicLink() || chmodStat.nlink !== 1n ||
          !sameStatObject(openedDestination, chmodStat)) throw recoveryRequired();
      await reportCopy('copying-live-files');
    }
  }

  await copyDirectory(source, destination, '');
  if (copiedEntries.size !== expectedEntries.size) throw recoveryRequired();
  durableDirectories.push(destination);
  await reportCopy('flushing-candidate-directories');
  try {
    await flushDirectoryBatch(deps.durableFs, durableDirectories, deps.yieldControl, deps.signal);
  } catch (error) {
    if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') throw staleCapacity(error);
    throw error;
  }
  await reportCopy('verifying-candidate-copy');
  const sourceAfter = await inspectServerDirectoryTree(source, options);
  if (sourceBefore.fingerprint !== sourceAfter.fingerprint ||
      !sameIdentity(sourceBefore.directoryIdentity, sourceAfter.directoryIdentity)) throw recoveryRequired();
  const destinationSnapshot = await inspectServerDirectoryTreeEvidence(destination, options);
  const destinationAfter = destinationSnapshot.inspection;
  if (!sameIdentity(destinationRoot.identity, destinationAfter.directoryIdentity)) throw recoveryRequired();
  if (destinationSnapshot.entryEvidence.size !== expectedEntries.size) throw recoveryRequired();
  for (const [relativeKey, expected] of expectedEntries) {
    const actual = destinationSnapshot.entryEvidence.get(relativeKey);
    if (!actual || actual.path !== expected.path || actual.type !== expected.type ||
        (expected.type !== 'directory' && (actual.sha256 !== expected.sha256 || actual.size !== expected.size))) {
      throw recoveryRequired();
    }
  }
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
  captureServerDirectoryCopySource,
  copyServerDirectoryContents,
  identifyServerDirectory,
  inspectAndFlushServerDirectoryTree,
  inspectServerDirectoryStructure,
  inspectServerDirectoryTree,
  normalizeServerDirectoryPath: normalizeAbsolutePath
};
