const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { canonicalPath } = require('./ownership-planner.cjs');
const { createPassivePathFilter } = require('./quiescent-plan-revalidation.cjs');
const { MAX_SERVER_PROPERTIES_BYTES } = require('../../server-health-constants.cjs');
const { readEffectiveServerProperty } = require('../../../utils/server-network-properties.cjs');

const EXCLUDED_ROOTS = new Set(['.minecraft-core-state', 'backups', 'crash-reports', 'logs']);
const HASH_CHUNK_BYTES = 1024 * 1024;
// What a running server does to a file a review reads: Minecraft holds its
// world's session.lock locked (EBUSY), a file deleted while it is open cannot
// be opened (EPERM, see assertNotDenied), and a temporary save file can be gone
// before it is read.
const IN_USE_CODES = new Set(['EBUSY', 'ENOENT', 'EPERM']);
const SERVER_FILES_IN_USE_MESSAGE = 'Modpack or server files changed or were locked while this review read them. ' +
  'If the server is running, stop it, then review again. Nothing was changed on the server.';
// Failures that mean a path changed, appeared, vanished or was locked while it
// was read, unlike an unsafe path (a link, a reparse point, a hard link).
const CHANGED_FAILURES = new WeakSet();

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('PLAN_STALE', 'The server changed while its modpack plan was prepared', { cause });
}

function changed(cause) {
  if (cause instanceof ModpackError) return cause;
  const error = invalid(cause);
  CHANGED_FAILURES.add(error);
  return error;
}

function observationFailure(cause) {
  return IN_USE_CODES.has(cause?.code) ? changed(cause) : invalid(cause);
}

function serverFilesInUse(cause) {
  return new ModpackError('PLAN_STALE', SERVER_FILES_IN_USE_MESSAGE, {
    cause,
    details: { reasonCode: 'server-files-in-use' },
    retryable: true
  });
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

function changedMemberNames(before, after) {
  const beforeNames = new Set(before);
  const afterNames = new Set(after);
  return [...before.filter(name => !afterNames.has(name)), ...after.filter(name => !beforeNames.has(name))];
}

function pathKeyOf(relative) {
  return relative.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

// `vanishedFs`, given only for a review, tells a probe that failed because the
// path is gone or being deleted apart from any other probe failure.
async function inspectReparse(reparseInspector, candidate, signal, vanishedFs = null) {
  throwIfCancelled(signal);
  let reparsePoint;
  try {
    reparsePoint = await reparseInspector.isReparsePoint(candidate, { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' ||
        error?.code === 'CANCELLED') throw cancelled(error);
    if (vanishedFs && await vanished(vanishedFs, candidate)) throw changed(error);
    throw invalid(error);
  }
  if (reparsePoint !== false) throw invalid();
  throwIfCancelled(signal);
}

async function vanished(fsPromises, candidate) {
  try {
    await fsPromises.lstat(candidate, { bigint: true });
    return false;
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'EPERM';
  }
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
    if (opened.isSymbolicLink() || (opened.isFile() && BigInt(opened.nlink) !== 1n)) throw invalid();
    if (!opened.isFile() || !sameFile(expected, opened)) throw changed();
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
    if (afterPath.isSymbolicLink() || (afterPath.isFile() && BigInt(afterPath.nlink) !== 1n)) throw invalid();
    if (totalRead !== opened.size || !afterPath.isFile() || !sameFile(opened, afterHandle) ||
        !sameFile(opened, afterPath)) throw changed();
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
    if (handle === undefined) await assertNotDenied(fsPromises, filePath, failure);
    throw observationFailure(failure);
  }
  return result;
}

// Windows answers EPERM both for a path being deleted and for one this user may
// not read. Only the first can no longer be looked up; the second stays
// unreadable once the server has stopped, so it is not in use.
async function assertNotDenied(fsPromises, candidate, failure) {
  if (failure?.code === 'EPERM' && !(await vanished(fsPromises, candidate))) throw invalid(failure);
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
    // A lifecycle review reads a server that may be running. It leaves out a
    // passive path the server writes or holds locked while it is read; Start
    // stops the server and takes this snapshot again, without `review`, before
    // it changes anything. A review never leaves out a path that
    // `incomingManifest` names: the reviewed source's files, or for a repair
    // every recorded file.
    review = false,
    incomingManifest = null,
    signal
  } = {}) {
    if (!validSignal(signal) || typeof review !== 'boolean' || (incomingManifest !== null &&
        (!incomingManifest || typeof incomingManifest !== 'object' || !Array.isArray(incomingManifest.entries)))) {
      throw invalid();
    }
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
      // Review only: each path left out, with the failure that left it out.
      const leftOut = new Map();
      const vanishedFs = review ? fsPromises : null;
      let passiveRule = null;

      // A review may leave out only a path Start can rebase once the server
      // stopped (createPassivePathFilter), outside the application's own state,
      // and never a world folder or a folder that holds one, since a world holds
      // its datapacks. World folders come from server.properties, so whatever
      // was left out before it was read is checked again at the end.
      function passiveInReview(pathKey) {
        if (pathKey === '.minecraft-core.json' || pathKey === '.minecraft-core-state' ||
            pathKey.startsWith('.minecraft-core-state/')) return false;
        if (!passiveRule || passiveRule.propertiesBytes !== propertiesBytes) {
          const worlds = worldDirectories(propertiesBytes).map(world => world.toLocaleLowerCase('en-US'));
          passiveRule = {
            propertiesBytes,
            worlds,
            passive: createPassivePathFilter({ oldManifest: currentState?.manifest ?? null, incomingManifest, worldDirectories: worlds })
          };
        }
        return passiveRule.passive(pathKey) &&
          !passiveRule.worlds.some(world => world === pathKey || world.startsWith(`${pathKey}/`));
      }

      function leftOutFailure(pathKey) {
        if (leftOut.size === 0) return null;
        let prefix = '';
        for (const segment of pathKey.split('/')) {
          prefix = prefix ? `${prefix}/${segment}` : segment;
          if (leftOut.has(prefix)) return leftOut.get(prefix);
        }
        return null;
      }

      // Every failure to observe a path passes through here. Outside a review,
      // and for an unsafe path or the server folder itself, it fails the
      // snapshot. A review leaves out a passive path that changed or was locked
      // and refuses, with its own reason, any other path that did.
      function leaveOut(pathKey, error) {
        if (!(error instanceof ModpackError) && (signal?.aborted || error?.name === 'AbortError' ||
            error?.code === 'ABORT_ERR' || error?.code === 'CANCELLED')) throw cancelled(error);
        const failure = observationFailure(error);
        if (!review || pathKey === '' || !CHANGED_FAILURES.has(failure)) throw failure;
        if (!passiveInReview(pathKey)) throw serverFilesInUse(failure);
        if (!leftOut.has(pathKey)) leftOut.set(pathKey, failure);
      }

      async function visit(directory, relative = '') {
        throwIfCancelled(signal);
        const directoryBefore = await fsPromises.lstat(directory, { bigint: true });
        throwIfCancelled(signal);
        if (directoryBefore.isSymbolicLink()) throw invalid();
        if (!directoryBefore.isDirectory()) throw changed();
        let children;
        try {
          children = await fsPromises.readdir(directory, { withFileTypes: true });
        } catch (error) {
          await assertNotDenied(fsPromises, directory, error);
          throw error;
        }
        throwIfCancelled(signal);
        const memberNames = directoryMemberNames(children);
        children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
        directoryObservations.push({ directory, relative, expected: directoryBefore, memberNames });
        for (const child of children) {
          throwIfCancelled(signal);
          const childRelative = relative ? `${relative}/${child.name}` : child.name;
          try {
            await visitChild(path.join(directory, child.name), childRelative);
          } catch (error) {
            leaveOut(pathKeyOf(childRelative), error);
          }
        }
        const directoryAfter = await fsPromises.lstat(directory, { bigint: true });
        if (directoryAfter.isSymbolicLink()) throw invalid();
        if (!directoryAfter.isDirectory() || !sameObject(directoryBefore, directoryAfter)) throw changed();
      }

      async function visitChild(absolute, childRelative) {
        const normalized = childRelative.replaceAll('\\', '/');
        const key = pathKeyOf(childRelative);
        const stat = await fsPromises.lstat(absolute, { bigint: true });
        if (stat.isSymbolicLink()) throw invalid();
        await inspectReparse(reparseInspector, absolute, signal, vanishedFs);
        const excluded = key === '.minecraft-core.json' || EXCLUDED_ROOTS.has(key.split('/')[0]);
        if (stat.isDirectory()) {
          if (!excluded) {
            liveEntries.push({ path: normalized, pathKey: key, type: 'directory', sha256: null, size: '0', origin: 'user' });
            pathPreconditions.push({ path: normalized, pathKey: key, exists: true, type: 'directory', size: '0', sha256: null,
              ...identity(stat) });
          }
          await visit(absolute, childRelative);
          const after = await fsPromises.lstat(absolute, { bigint: true });
          if (after.isSymbolicLink()) throw invalid();
          if (!after.isDirectory() || !sameObject(stat, after)) throw changed();
        } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
          fileObservations.push({ filePath: absolute, pathKey: key, expected: stat });
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

      try {
        await visit(serverPath);
      } catch (error) {
        leaveOut('', error);
      }
      for (const observation of directoryObservations) {
        throwIfCancelled(signal);
        const directoryKey = pathKeyOf(observation.relative);
        if (leftOutFailure(directoryKey)) continue;
        let currentNames;
        try {
          const current = await fsPromises.lstat(observation.directory, { bigint: true });
          throwIfCancelled(signal);
          if (current.isSymbolicLink()) throw invalid();
          if (!current.isDirectory() || !sameObject(observation.expected, current)) throw changed();
          await inspectReparse(reparseInspector, observation.directory, signal, vanishedFs);
          const currentChildren = await fsPromises.readdir(observation.directory, { withFileTypes: true });
          throwIfCancelled(signal);
          currentNames = directoryMemberNames(currentChildren);
        } catch (error) {
          leaveOut(directoryKey, error);
          continue;
        }
        for (const name of changedMemberNames(observation.memberNames, currentNames)) {
          leaveOut(pathKeyOf(observation.relative ? `${observation.relative}/${name}` : name), changed());
        }
      }
      for (const observation of fileObservations) {
        throwIfCancelled(signal);
        if (leftOutFailure(observation.pathKey)) continue;
        try {
          const current = await fsPromises.lstat(observation.filePath, { bigint: true });
          throwIfCancelled(signal);
          if (current.isSymbolicLink() || (current.isFile() && BigInt(current.nlink) !== 1n)) throw invalid();
          if (!current.isFile() || !sameFile(observation.expected, current)) throw changed();
          await inspectReparse(reparseInspector, observation.filePath, signal, vanishedFs);
        } catch (error) {
          leaveOut(observation.pathKey, error);
        }
      }
      const rootAfter = await fsPromises.lstat(serverPath, { bigint: true });
      if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || !sameObject(rootStat, rootAfter)) throw invalid();
      await inspectReparse(reparseInspector, serverPath, signal);
      let entries = liveEntries;
      let preconditions = pathPreconditions;
      if (leftOut.size > 0) {
        // Check again with the world folders server.properties names, then
        // drop every entry at or below a path left out; each must be passive.
        for (const [pathKey, failure] of leftOut) {
          if (!passiveInReview(pathKey)) throw serverFilesInUse(failure);
        }
        for (const entry of liveEntries) {
          const failure = leftOutFailure(entry.pathKey);
          if (failure && !passiveInReview(entry.pathKey)) throw serverFilesInUse(failure);
        }
        entries = liveEntries.filter(entry => !leftOutFailure(entry.pathKey));
        preconditions = pathPreconditions.filter(condition => !leftOutFailure(condition.pathKey));
      }
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
          entries
        },
        pathPreconditions: preconditions,
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
