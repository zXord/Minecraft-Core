const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { canonicalPath } = require('./ownership-planner.cjs');

const EXCLUDED_ROOTS = new Set(['.minecraft-core-state', 'backups', 'crash-reports', 'logs']);

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('PLAN_STALE', 'The server changed while its modpack plan was prepared', { cause });
}

function hashFile(fsApi, filePath, expected) {
  const descriptor = fsApi.openSync(filePath, 'r');
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const count = fsApi.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    fsApi.closeSync(descriptor);
  }
  const after = fsApi.lstatSync(filePath, { bigint: true });
  if (after.dev !== expected.dev || after.ino !== expected.ino || after.birthtimeNs !== expected.birthtimeNs ||
      after.size !== expected.size || after.mtimeNs !== expected.mtimeNs || BigInt(after.nlink) !== 1n) throw invalid();
  return digest.digest('hex');
}

function identity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtime: String(stat.birthtimeNs)
  };
}

function worldDirectories(fsApi, serverPath) {
  const result = new Set(['world', 'world_nether', 'world_the_end']);
  const properties = path.join(serverPath, 'server.properties');
  try {
    const text = fsApi.readFileSync(properties, 'utf8');
    const match = text.split(/\r?\n/u).find(line => line.trim().startsWith('level-name='));
    if (match) result.add(canonicalPath(match.slice(match.indexOf('=') + 1).trim()).path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw invalid(error);
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

function createProductionServerSnapshot({ fsApi = fs, reparseInspector, stateRepository } = {}) {
  if (!fsApi || typeof fsApi.lstatSync !== 'function' || typeof fsApi.readdirSync !== 'function' ||
      typeof fsApi.accessSync !== 'function' || !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
      !stateRepository || typeof stateRepository.read !== 'function') throw invalid();

  return async function snapshotServer({ currentState, operationKind, runtime, serverKind, serverPath } = {}) {
    if (serverKind === 'new') {
      return deepFreeze({
        liveSnapshot: { kind: 'new', worldDirectories: ['world', 'world_nether', 'world_the_end'], protectedPaths: [], entries: [] },
        pathPreconditions: [], candidateBytes: '0', restorePointBytes: '0', rollbackBytes: '0',
        journalBytes: '1048576', sourceRuntime: runtime, restorePoints: [], writeable: true
      });
    }
    const inactiveRollback = operationKind === 'rollback-restore-point' && currentState?.state &&
      currentState.state.modpackManaged === false;
    if (!currentState?.state || (!inactiveRollback &&
        (!currentState.state.runtime || currentState.state.modpackManaged !== true))) throw invalid();
    const rootStat = fsApi.lstatSync(serverPath, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        await reparseInspector.isReparsePoint(serverPath) !== false) throw invalid();
    const liveEntries = [];
    const pathPreconditions = [];
    let totalBytes = 0n;
    async function visit(directory, relative = '') {
      const children = fsApi.readdirSync(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
      for (const child of children) {
        const childRelative = relative ? `${relative}/${child.name}` : child.name;
        const normalized = childRelative.replaceAll('\\', '/');
        const key = normalized.toLocaleLowerCase('en-US');
        const absolute = path.join(directory, child.name);
        const stat = fsApi.lstatSync(absolute, { bigint: true });
        if (stat.isSymbolicLink() || await reparseInspector.isReparsePoint(absolute) !== false) throw invalid();
        const excluded = key === '.minecraft-core.json' || EXCLUDED_ROOTS.has(key.split('/')[0]);
        if (stat.isDirectory()) {
          if (!excluded) {
            liveEntries.push({ path: normalized, pathKey: key, type: 'directory', sha256: null, size: '0', origin: 'user' });
            pathPreconditions.push({ path: normalized, pathKey: key, exists: true, type: 'directory', size: '0', sha256: null,
              ...identity(stat) });
          }
          await visit(absolute, childRelative);
        } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
          totalBytes += BigInt(stat.size);
          if (!excluded) {
            const sha256 = hashFile(fsApi, absolute, stat);
            liveEntries.push({ path: normalized, pathKey: key, type: 'file', sha256, size: String(stat.size), origin: 'user' });
            pathPreconditions.push({ path: normalized, pathKey: key, exists: true, type: 'file', size: String(stat.size), sha256,
              ...identity(stat) });
          }
        } else {
          throw invalid();
        }
      }
    }
    await visit(serverPath);
    let writeable = true;
    try { fsApi.accessSync(serverPath, fs.constants.R_OK | fs.constants.W_OK); }
    catch { writeable = false; }
    return deepFreeze({
      liveSnapshot: {
        kind: 'existing',
        worldDirectories: worldDirectories(fsApi, serverPath),
        protectedPaths: [],
        entries: liveEntries
      },
      pathPreconditions,
      candidateBytes: totalBytes.toString(),
      restorePointBytes: totalBytes.toString(),
      rollbackBytes: totalBytes.toString(),
      journalBytes: '1048576',
      sourceRuntime: currentState.state.runtime ?? runtime ?? null,
      restorePoints: restorePointsFromHistory(stateRepository, serverPath),
      writeable
    });
  };
}

module.exports = { createProductionServerSnapshot };
