const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { canonicalPath } = require('./ownership-planner.cjs');
const { MAX_SERVER_PROPERTIES_BYTES } = require('../../server-health-constants.cjs');
const { readEffectiveServerProperty } = require('../../../utils/server-network-properties.cjs');

const EXCLUDED_ROOTS = new Set(['.minecraft-core-state', 'backups', 'crash-reports', 'logs']);
const HASH_CHUNK_BYTES = 1024 * 1024;

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('PLAN_STALE', 'The server changed while its modpack plan was prepared', { cause });
}

function cancelled(cause) {
  if (cause instanceof ModpackError && cause.code === 'CANCELLED') return cause;
  return new ModpackError('CANCELLED', 'The server snapshot was cancelled', { cause });
}

function validSignal(signal) {
  return signal === undefined || signal === null || (typeof signal === 'object' &&
    typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function');
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelled();
}

function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function sameFile(left, right) {
  return sameObject(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink;
}

function directoryMemberNames(children) {
  if (!Array.isArray(children)) throw invalid();
  const names = [];
  const localNames = new Set();
  for (const child of children) {
    if (!child || typeof child.name !== 'string' || child.name.length === 0 || child.name.includes('\0') ||
        child.name.includes('/') || child.name.includes('\\') || child.name === '.' || child.name === '..') throw invalid();
    const localKey = child.name.toLocaleLowerCase('en-US');
    if (localNames.has(localKey)) throw invalid();
    localNames.add(localKey);
    names.push(child.name);
  }
  return names.sort((left, right) => left.localeCompare(right, 'en-US'));
}

async function inspectReparse(reparseInspector, candidate, signal) {
  throwIfCancelled(signal);
  try {
    if (await reparseInspector.isReparsePoint(candidate, { signal }) !== false) throw invalid();
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ||
        error?.code === 'CANCELLED') throw cancelled(error);
    throw invalid(error);
  }
  throwIfCancelled(signal);
}

async function hashFile(fsPromises, filePath, expected, {
  captureBytes = false,
  captureLimitBytes = null,
  signal
} = {}) {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let handle;
  let failure = null;
  let result = null;
  try {
    throwIfCancelled(signal);
    handle = await fsPromises.open(filePath, fs.constants.O_RDONLY | noFollow);
    throwIfCancelled(signal);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || BigInt(opened.nlink) !== 1n ||
        !sameFile(expected, opened)) throw invalid();
    if (captureBytes && (!Number.isSafeInteger(captureLimitBytes) || captureLimitBytes < 0 ||
        opened.size > BigInt(captureLimitBytes))) throw invalid();
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    const captured = captureBytes ? [] : null;
    let totalRead = 0n;
    for (;;) {
      throwIfCancelled(signal);
      const read = await handle.read(buffer, 0, buffer.length, null);
      throwIfCancelled(signal);
      const count = read?.bytesRead;
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length) throw invalid();
      if (count === 0) break;
      if (captured && totalRead + BigInt(count) > BigInt(captureLimitBytes)) throw invalid();
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
      if (captured) captured.push(Buffer.from(chunk));
      totalRead += BigInt(count);
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fsPromises.lstat(filePath, { bigint: true });
    throwIfCancelled(signal);
    if (totalRead !== opened.size || !afterPath.isFile() || afterPath.isSymbolicLink() ||
        BigInt(afterPath.nlink) !== 1n || !sameFile(opened, afterHandle) || !sameFile(opened, afterPath)) {
      throw invalid();
    }
    result = {
      sha256: digest.digest('hex'),
      ...(captured ? { bytes: Buffer.concat(captured, Number(totalRead)) } : {})
    };
  } catch (error) {
    failure = error;
  }
  if (handle !== undefined) {
    try { await handle.close(); }
    catch (error) { failure ||= error; }
  }
  if (failure) {
    if (signal?.aborted || failure?.name === 'AbortError' || failure?.code === 'ABORT_ERR' ||
        failure?.code === 'CANCELLED') throw cancelled(failure);
    throw invalid(failure);
  }
  return result;
}

function identity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime: String(stat.birthtimeNs)
  };
}

function worldDirectories(propertiesBytes) {
  const result = new Set(['world', 'world_nether', 'world_the_end']);
  if (propertiesBytes !== null) {
    const levelName = readEffectiveServerProperty(propertiesBytes, 'level-name');
    if (levelName !== null) result.add(canonicalPath(levelName).path);
  }
  return [...result].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function restorePointsFromHistory(stateRepository, serverPath) {
  if (typeof stateRepository.listHistory !== 'function') return [];
  const page = stateRepository.listHistory(serverPath, { cursor: null, limit: 200 });
  if (!page || !Array.isArray(page.items)) return [];
  const points = [];
  const seen = new Set();
  for (const entry of page.items) {
    if (typeof entry?.restorePointId !== 'string' || typeof entry.restorePointSha256 !== 'string' ||
        !entry.sourceRuntime || seen.has(entry.restorePointId)) continue;
    seen.add(entry.restorePointId);
    points.push({
      id: entry.restorePointId,
      sha256: entry.restorePointSha256,
      sourceRevision: entry.sourceRevision,
      runtime: entry.sourceRuntime,
      worldIncluded: true,
      ...(typeof entry.restorePointTotalBytes === 'string' && /^(0|[1-9][0-9]*)$/.test(entry.restorePointTotalBytes)
        ? { totalBytes: entry.restorePointTotalBytes }
        : {})
    });
  }
  return points;
}

function createProductionServerSnapshot({
  fsApi = fs,
  fsPromises = fsApi?.promises || fsp,
  reparseInspector,
  stateRepository
} = {}) {
  if (!fsPromises || ['access', 'lstat', 'open', 'readdir'].some(method => typeof fsPromises[method] !== 'function') ||
      !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
      !stateRepository || typeof stateRepository.read !== 'function') throw invalid();

  return async function snapshotServer({
    currentState,
    operationKind,
    runtime,
    serverKind,
    serverPath,
    unmanagedAdoption = false,
    signal
  } = {}) {
    if (!validSignal(signal)) throw invalid();
    throwIfCancelled(signal);
    if (serverKind === 'new') {
      return deepFreeze({
        liveSnapshot: { kind: 'new', worldDirectories: ['world', 'world_nether', 'world_the_end'], protectedPaths: [], entries: [] },
        pathPreconditions: [], candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0',
        journalBytes: '1048576', sourceRuntime: runtime, restorePoints: [], writeable: true
      });
    }
    const inactiveRollback = operationKind === 'rollback-restore-point' && currentState?.state &&
      currentState.state.modpackManaged === false;
    const adoptingExisting = unmanagedAdoption === true && operationKind === 'install' &&
      (!currentState?.state || currentState.state.modpackManaged !== true);
    if ((!currentState?.state && !adoptingExisting) || (!inactiveRollback && !adoptingExisting &&
        (!currentState.state.runtime || currentState.state.modpackManaged !== true))) throw invalid();
    try {
      const rootStat = await fsPromises.lstat(serverPath, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw invalid();
      await inspectReparse(reparseInspector, serverPath, signal);
      const liveEntries = [];
      const pathPreconditions = [];
      let propertiesBytes = null;
      let completeLiveBytes = 0n;
      let restorePointSourceBytes = 0n;
      let retainedBackupBytes = 0n;
      let liveHistoryBytes = 0n;
      const directoryObservations = [];
      const fileObservations = [];
      async function visit(directory, relative = '') {
        throwIfCancelled(signal);
        const directoryBefore = await fsPromises.lstat(directory, { bigint: true });
        throwIfCancelled(signal);
        if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) throw invalid();
        const children = await fsPromises.readdir(directory, { withFileTypes: true });
        throwIfCancelled(signal);
        const memberNames = directoryMemberNames(children);
        children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
        directoryObservations.push({ directory, expected: directoryBefore, memberNames });
        for (const child of children) {
          throwIfCancelled(signal);
          const childRelative = relative ? `${relative}/${child.name}` : child.name;
          const normalized = childRelative.replaceAll('\\', '/');
          const key = normalized.toLocaleLowerCase('en-US');
          const absolute = path.join(directory, child.name);
          const stat = await fsPromises.lstat(absolute, { bigint: true });
          if (stat.isSymbolicLink()) throw invalid();
          await inspectReparse(reparseInspector, absolute, signal);
          const excluded = key === '.minecraft-core.json' || EXCLUDED_ROOTS.has(key.split('/')[0]);
          if (stat.isDirectory()) {
            if (!excluded) {
              liveEntries.push({ path: normalized, pathKey: key, type: 'directory', sha256: null, size: '0', origin: 'user' });
              pathPreconditions.push({ path: normalized, pathKey: key, exists: true, type: 'directory', size: '0', sha256: null,
                ...identity(stat) });
            }
            await visit(absolute, childRelative);
            const after = await fsPromises.lstat(absolute, { bigint: true });
            if (!after.isDirectory() || after.isSymbolicLink() || !sameObject(stat, after)) throw invalid();
          } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
            fileObservations.push({ filePath: absolute, expected: stat });
            const size = BigInt(stat.size);
            const rootKey = key.split('/')[0];
            completeLiveBytes += size;
            if (rootKey === 'backups') {
              retainedBackupBytes += size;
            } else {
              // RestorePointService archives every top-level server item except
              // `backups`, including application state, logs, and crash reports.
              restorePointSourceBytes += size;
            }
            if (key.startsWith('.minecraft-core-state/history/')) {
              // A fresh rollback candidate does not clone the live tree. It
              // explicitly carries forward only the live history and backups.
              liveHistoryBytes += size;
            }
            if (!excluded) {
              const measured = await hashFile(fsPromises, absolute, stat, {
                captureBytes: key === 'server.properties',
                captureLimitBytes: key === 'server.properties' ? MAX_SERVER_PROPERTIES_BYTES : null,
                signal
              });
              if (key === 'server.properties') propertiesBytes = measured.bytes;
              liveEntries.push({ path: normalized, pathKey: key, type: 'file', sha256: measured.sha256, size: String(stat.size), origin: 'user' });
              pathPreconditions.push({ path: normalized, pathKey: key, exists: true, type: 'file', size: String(stat.size), sha256: measured.sha256,
                ...identity(stat) });
            }
          } else {
            throw invalid();
          }
        }
        const directoryAfter = await fsPromises.lstat(directory, { bigint: true });
        if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink() ||
            !sameObject(directoryBefore, directoryAfter)) throw invalid();
      }
      await visit(serverPath);
      for (const observation of directoryObservations) {
        throwIfCancelled(signal);
        const current = await fsPromises.lstat(observation.directory, { bigint: true });
        throwIfCancelled(signal);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameObject(observation.expected, current)) throw invalid();
        await inspectReparse(reparseInspector, observation.directory, signal);
        const currentChildren = await fsPromises.readdir(observation.directory, { withFileTypes: true });
        throwIfCancelled(signal);
        if (JSON.stringify(directoryMemberNames(currentChildren)) !== JSON.stringify(observation.memberNames)) throw invalid();
      }
      for (const observation of fileObservations) {
        throwIfCancelled(signal);
        const current = await fsPromises.lstat(observation.filePath, { bigint: true });
        throwIfCancelled(signal);
        if (!current.isFile() || current.isSymbolicLink() || BigInt(current.nlink) !== 1n ||
            !sameFile(observation.expected, current)) throw invalid();
        await inspectReparse(reparseInspector, observation.filePath, signal);
      }
      const rootAfter = await fsPromises.lstat(serverPath, { bigint: true });
      if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || !sameObject(rootStat, rootAfter)) throw invalid();
      await inspectReparse(reparseInspector, serverPath, signal);
      let writeable = true;
      try {
        await fsPromises.access(serverPath, fs.constants.R_OK | fs.constants.W_OK);
        throwIfCancelled(signal);
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ||
            error?.code === 'CANCELLED') throw cancelled(error);
        writeable = false;
      }
      // Restore-point creation happens before the transaction clones the live
      // tree. The resulting safety archive is therefore allocated once in the
      // live backup directory and copied once into the candidate. Its exact ZIP
      // size is not known until execution; the uncompressed source scope is the
      // planning estimate, with archive overhead covered by the capacity reserve.
      const liveBytesCopiedToCandidate = operationKind === 'rollback-restore-point'
        ? retainedBackupBytes + liveHistoryBytes
        : completeLiveBytes;
      const candidateBytes = liveBytesCopiedToCandidate + restorePointSourceBytes;
      return deepFreeze({
        liveSnapshot: {
          kind: 'existing',
          worldDirectories: worldDirectories(propertiesBytes),
          protectedPaths: [],
          entries: liveEntries
        },
        pathPreconditions,
        candidateBytes: candidateBytes.toString(),
        restorePointBytes: restorePointSourceBytes.toString(),
        // Commit preserves the live directory by renaming it into the rollback
        // slot. A same-volume rename consumes no additional file payload bytes.
        rollbackBytes: '0',
        journalBytes: '1048576',
        sourceRuntime: adoptingExisting
          ? currentState?.state?.runtime ?? null
          : currentState.state.runtime ?? runtime ?? null,
        restorePoints: adoptingExisting ? [] : restorePointsFromHistory(stateRepository, serverPath),
        writeable
      });
    } catch (error) {
      if (error instanceof ModpackError) throw error;
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ||
          error?.code === 'CANCELLED') throw cancelled(error);
      throw invalid(error);
    }
  };
}

module.exports = { createProductionServerSnapshot };
