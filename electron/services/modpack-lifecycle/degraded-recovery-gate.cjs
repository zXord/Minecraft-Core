const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ModpackError, MODPACK_SERVICES_UNAVAILABLE_MESSAGE } = require('../modpacks/errors.cjs');
const { createDurableFs } = require('../../utils/durable-fs.cjs');
const { RecoveryRegistry } = require('./recovery-registry.cjs');
const { establishStartupRecoveryBoundary, mapScanBlocks } = require('./startup-recovery-bootstrap.cjs');

const LIFECYCLE_DIRECTORY = 'modpack-lifecycle';
const RECORD_DIRECTORIES = Object.freeze(['active', 'history']);
const SCAN_ONLY_WRITE_METHODS = Object.freeze(['writeFileAtomic', 'writeJsonAtomic', 'renameDurable']);
const SCAN_ONLY_ASYNC_WRITE_METHODS = Object.freeze([
  'deleteFileExactAsync', 'writeFileAtomicAsync', 'writeJsonAtomicAsync', 'renameDurableAsync'
]);

function modpackServicesUnavailable(cause) {
  return new ModpackError('MODPACK_SERVICES_UNAVAILABLE', MODPACK_SERVICES_UNAVAILABLE_MESSAGE,
    cause === undefined ? undefined : { cause });
}

// A second line of defence: the scan-only facade refuses every write before it
// reaches the durable filesystem, so this client is never asked to publish.
const SCAN_ONLY_DURABLE_CLIENT = Object.freeze({
  moveWriteThrough() { throw modpackServicesUnavailable(); },
  replaceFileWriteThrough() { throw modpackServicesUnavailable(); },
  flushDirectory() {}
});

/**
 * Durable filesystem reads with the real path guards and no ArchiveWorker.
 * Every write is refused with MODPACK_SERVICES_UNAVAILABLE before anything,
 * even a temporary file, is created; flushes are no-ops because nothing is
 * ever written.
 */
function createScanOnlyDurableFs({ fsApi = fs, asyncFsApi, allowedRoots } = {}) {
  const reader = createDurableFs({
    fsApi,
    ...(asyncFsApi === undefined ? {} : { asyncFsApi }),
    durableClient: SCAN_ONLY_DURABLE_CLIENT,
    allowedRoots
  });
  const facade = {
    readFileBounded: (...args) => reader.readFileBounded(...args),
    readFileBoundedAsync: (...args) => reader.readFileBoundedAsync(...args),
    sha256File: (...args) => reader.sha256File(...args),
    flushDirectory() {},
    flushDirectories() {},
    async flushDirectoryAsync() {},
    async flushDirectoriesAsync() {}
  };
  for (const method of SCAN_ONLY_WRITE_METHODS) facade[method] = () => { throw modpackServicesUnavailable(); };
  for (const method of SCAN_ONLY_ASYNC_WRITE_METHODS) facade[method] = async () => { throw modpackServicesUnavailable(); };
  return Object.freeze(facade);
}

/**
 * The startup quiescence proof: while the recovery boundary is open, the
 * coordinator refuses every start, so a refused probe start proves no server
 * runtime was admitted before recovery.
 */
function createCoordinatorQuiescenceVerifier({ coordinator, userDataPath } = {}) {
  if (!coordinator || typeof userDataPath !== 'string' || !userDataPath) {
    throw new TypeError('Coordinator quiescence verifier dependencies are invalid');
  }
  return Object.freeze({
    async verifyBeforeRecovery() {
      try {
        const lease = await coordinator.acquireStart({
          instanceId: 'startup-recovery-probe',
          serverPath: userDataPath
        }, {
          operation: 'startup-recovery-probe',
          operationId: 'startup-recovery-probe'
        });
        await lease?.release?.();
        return Object.freeze({ quiescent: false });
      } catch (error) {
        return Object.freeze({ quiescent: error?.code === 'RECOVERY_REQUIRED' });
      }
    }
  });
}

function plainDirectoryState(fsApi, directory) {
  let stat;
  try {
    stat = fsApi.lstatSync(directory);
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'unknown';
  }
  return stat.isDirectory() && !stat.isSymbolicLink() ? 'directory' : 'unknown';
}

/**
 * True only when the profile provably has no modpack recovery records: the
 * lifecycle folder is absent, or a plain directory whose active and history
 * folders are each absent or plain directories with no entries. A junction,
 * a file, an entry of any kind or an unreadable folder is not proof.
 */
function lifecycleRecordsProvablyAbsent(userDataPath, fsApi = fs) {
  const root = path.join(userDataPath, LIFECYCLE_DIRECTORY);
  const rootState = plainDirectoryState(fsApi, root);
  if (rootState === 'absent') return true;
  if (rootState !== 'directory') return false;
  return RECORD_DIRECTORIES.every(name => {
    const directory = path.join(root, name);
    const state = plainDirectoryState(fsApi, directory);
    if (state === 'absent') return true;
    if (state !== 'directory') return false;
    try {
      return fsApi.readdirSync(directory).length === 0;
    } catch {
      return false;
    }
  });
}

function createScanOnlyRecoveryRegistry({ userDataPath, fsApi, clock, randomUUID }) {
  return new RecoveryRegistry({
    userDataPath,
    fsApi,
    durableFs: createScanOnlyDurableFs({ fsApi, allowedRoots: [userDataPath] }),
    clock,
    randomUUID
  });
}

function gateResult(basis, globalBlock, blocks, error = null) {
  return Object.freeze({ basis, globalBlock, blocks: Object.freeze([...blocks]), error });
}

/**
 * Settles the startup recovery boundary when the modpack services could not
 * start (degraded startup). A profile that provably has no recovery records is
 * released at once. Otherwise the same boundary as a full start is computed
 * from a real RecoveryRegistry over scan-only storage, so an interrupted
 * modpack operation keeps its server blocked while every other server can
 * start. Anything that cannot be read keeps every server blocked.
 * Returns {basis, globalBlock, blocks, error}; blocks are mapped recovery blocks
 * ({operationId, selector}).
 */
async function establishDegradedRecoveryGate({
  coordinator,
  userDataPath,
  fsApi = fs,
  clock = () => new Date(),
  randomUUID = crypto.randomUUID,
  runtimeVerifier = null,
  createRegistry = createScanOnlyRecoveryRegistry
} = {}) {
  if (!coordinator || typeof coordinator.completeStartupRecovery !== 'function' ||
      typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath) || typeof createRegistry !== 'function') {
    throw new TypeError('Degraded recovery gate dependencies are invalid');
  }
  try {
    if (lifecycleRecordsProvablyAbsent(userDataPath, fsApi)) {
      coordinator.completeStartupRecovery([], { globalBlock: false });
      return gateResult('no-recovery-records', false, []);
    }
    const registry = createRegistry({ userDataPath, fsApi, clock, randomUUID });
    let scan = null;
    await establishStartupRecoveryBoundary({
      coordinator,
      registry: Object.freeze({
        async initialize() {
          scan = await registry.initialize();
          return scan;
        }
      }),
      runtimeVerifier: runtimeVerifier || createCoordinatorQuiescenceVerifier({ coordinator, userDataPath })
    });
    const mapping = mapScanBlocks(scan);
    return gateResult('read-only-scan', mapping.requiresGlobalBlock, mapping.blocks);
  } catch (error) {
    try {
      if (coordinator.recoveryOpen !== false) coordinator.completeStartupRecovery([], { globalBlock: true });
    } catch {
      return gateResult('unsettled', true, [], error);
    }
    return gateResult('unreadable', true, [], error);
  }
}

module.exports = {
  createCoordinatorQuiescenceVerifier,
  createScanOnlyDurableFs,
  establishDegradedRecoveryGate,
  lifecycleRecordsProvablyAbsent,
  modpackServicesUnavailable
};
