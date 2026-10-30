const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { ModpackError } = require('../modpacks/errors.cjs');
const { captureReservedTarget } = require('./reserved-target-authority.cjs');
const { createSiblingPaths } = require('./server-directory-transaction.cjs');

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The unstarted server destination could not be verified', { cause });
}

function entryStat(fsApi, candidate) {
  try { return fsApi.lstatSync(candidate, { bigint: true, throwIfNoEntry: false }) || null; }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

function assertPlainDirectory(fsApi, directory, expectedIdentity = null) {
  const stat = entryStat(fsApi, directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() ||
      !samePath(fsApi.realpathSync.native(directory), directory) ||
      (expectedIdentity && !isDeepStrictEqual(identity(stat), expectedIdentity))) throw recoveryRequired();
  return identity(stat);
}

function assertSiblingsAbsent(fsApi, paths) {
  if (entryStat(fsApi, paths.candidatePath) || entryStat(fsApi, paths.failedPath)) throw recoveryRequired();
}

// Lifecycle supplies an authenticated launch and owns the destination gate.
// This is only filesystem evidence: it grants no launch/recovery authority and
// never consumes a reservation, removes files, or acquires a mutation lease.
async function assertUnstartedLaunchTarget({ launch, fsApi = fs, reparseInspector } = {}) {
  try {
    const { targetPath, capturedReservation } = launch.binding;
    const paths = createSiblingPaths(targetPath, launch.job.jobId);
    const parent = path.dirname(paths.targetPath);
    const parentIdentity = assertPlainDirectory(fsApi, parent);
    if (await reparseInspector.isReparsePoint(parent) !== false) throw recoveryRequired();
    assertPlainDirectory(fsApi, parent, parentIdentity);
    assertSiblingsAbsent(fsApi, paths);

    // Reuse the reservation authority's canonical-path, empty-tree, identity
    // and OS reparse checks rather than weakening or consuming that evidence.
    const current = await captureReservedTarget({ targetPath, fsApi, reparseInspector });
    if (!isDeepStrictEqual(current, capturedReservation)) throw recoveryRequired();

    // The target capture includes awaited OS inspection. Reprove all pathname
    // facts synchronously afterwards, including identity substitution during
    // the final inspection, before returning this bounded read-only proof.
    assertPlainDirectory(fsApi, parent, parentIdentity);
    if (capturedReservation.kind === 'absent') {
      if (entryStat(fsApi, targetPath)) throw recoveryRequired();
    } else {
      assertPlainDirectory(fsApi, targetPath, capturedReservation.identity);
      const names = fsApi.readdirSync(targetPath);
      if (!Array.isArray(names) || names.length !== 0) throw recoveryRequired();
      assertPlainDirectory(fsApi, targetPath, capturedReservation.identity);
    }
    assertSiblingsAbsent(fsApi, paths);
    assertPlainDirectory(fsApi, parent, parentIdentity);
    return true;
  } catch (error) {
    throw recoveryRequired(error);
  }
}

module.exports = { assertUnstartedLaunchTarget };
