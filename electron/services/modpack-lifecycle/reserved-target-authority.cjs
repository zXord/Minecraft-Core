const fs = require('node:fs');
const path = require('node:path');

const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The selected server destination is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed server destination changed', { cause });
}

function targetExists() {
  return new ModpackError(
    'TARGET_EXISTS',
    'The selected server destination is not empty and is not a managed modpack server'
  );
}

function normalizeTarget(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw invalid();
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw invalid();
  return resolved;
}

function lstat(fsApi, candidate) {
  try { return fsApi.lstatSync(candidate, { bigint: true, throwIfNoEntry: false }) || null; }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function identity(stat) {
  return deepFreeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs)
  });
}

function sameIdentity(stat, expected) {
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino &&
    String(stat.birthtimeNs) === expected.birthtimeNs;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

async function assertPlainDirectory({ fsApi, reparseInspector, targetPath, expectedIdentity = null, signal }) {
  if (signal?.aborted) throw new ModpackError('CANCELLED', 'The operation was cancelled');
  const stat = lstat(fsApi, targetPath);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() ||
      !samePath(fsApi.realpathSync.native(targetPath), targetPath) ||
      await reparseInspector.isReparsePoint(targetPath, signal ? { signal } : undefined) !== false ||
      (expectedIdentity && !sameIdentity(stat, expectedIdentity))) throw stale();
  return stat;
}

function dependencies(input) {
  const fsApi = input?.fsApi || fs;
  const reparseInspector = input?.reparseInspector;
  if (!fsApi || typeof fsApi.lstatSync !== 'function' || typeof fsApi.readdirSync !== 'function' ||
      typeof fsApi.realpathSync?.native !== 'function' || !reparseInspector ||
      typeof reparseInspector.isReparsePoint !== 'function') throw invalid();
  return { fsApi, reparseInspector };
}

async function captureReservedTarget({ targetPath: targetValue, fsApi: suppliedFs, reparseInspector, signal } = {}) {
  const targetPath = normalizeTarget(targetValue);
  const { fsApi } = dependencies({ fsApi: suppliedFs, reparseInspector });
  const initial = lstat(fsApi, targetPath);
  if (!initial) return deepFreeze({ kind: 'absent' });
  await assertPlainDirectory({ fsApi, reparseInspector, targetPath, signal });
  const names = fsApi.readdirSync(targetPath);
  if (!Array.isArray(names) || names.length !== 0) throw targetExists();
  const final = await assertPlainDirectory({ fsApi, reparseInspector, targetPath, expectedIdentity: identity(initial), signal });
  if (fsApi.readdirSync(targetPath).length !== 0) throw targetExists();
  return deepFreeze({ kind: 'empty-directory', identity: identity(final) });
}

async function consumeReservedTarget({
  targetPath: targetValue,
  reservation,
  mutationLease,
  durableFs,
  fsApi: suppliedFs,
  reparseInspector,
  signal
} = {}) {
  const targetPath = normalizeTarget(targetValue);
  const { fsApi } = dependencies({ fsApi: suppliedFs, reparseInspector });
  if (!reservation || !['absent', 'empty-directory'].includes(reservation.kind) ||
      !mutationLease || mutationLease.kind !== 'mutation' || !samePath(mutationLease.serverPath, targetPath) ||
      typeof mutationLease.markDirty !== 'function' || !durableFs || typeof durableFs.flushDirectory !== 'function' ||
      typeof fsApi.rmdirSync !== 'function') throw invalid();
  mutationLease.assertOwnedPath?.(targetPath);
  if (reservation.kind === 'absent') {
    if (lstat(fsApi, targetPath)) throw stale();
    return deepFreeze({ consumed: true, removedEmptyReservation: false });
  }
  if (!reservation.identity || typeof reservation.identity !== 'object') throw invalid();
  await assertPlainDirectory({
    fsApi,
    reparseInspector,
    targetPath,
    expectedIdentity: reservation.identity,
    signal
  });
  if (fsApi.readdirSync(targetPath).length !== 0) throw targetExists();
  mutationLease.markDirty();
  try {
    fsApi.rmdirSync(targetPath);
    durableFs.flushDirectory(path.dirname(targetPath));
  } catch (error) {
    throw stale(error);
  }
  if (lstat(fsApi, targetPath)) throw stale();
  return deepFreeze({ consumed: true, removedEmptyReservation: true });
}

module.exports = { captureReservedTarget, consumeReservedTarget };
