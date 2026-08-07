const { AsyncLocalStorage } = require('node:async_hooks');

const { ModpackError } = require('./modpacks/errors.cjs');

const REQUIRED_COORDINATOR_METHODS = Object.freeze([
  'acquireStart',
  'beginStartupRecovery',
  'completeStartupRecovery',
  'installRecoveryBlocks',
  'runManyMutations',
  'runMutation',
  'runRecoveryMutation'
]);

function invalidRequest(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The server mutation context is invalid', { cause });
}

function recoveryRequired() {
  return new ModpackError('RECOVERY_REQUIRED', 'Server startup recovery has not completed');
}

function assertCoordinator(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') ||
      REQUIRED_COORDINATOR_METHODS.some(method => typeof value[method] !== 'function')) {
    throw invalidRequest();
  }
  return value;
}

function assertLease(value) {
  if (!value || typeof value !== 'object' ||
      typeof value.assertOwnedPath !== 'function' || typeof value.markDirty !== 'function') {
    throw invalidRequest();
  }
  return value;
}

function createServerMutationContext() {
  const storage = new AsyncLocalStorage();
  let coordinator = null;

  function installCoordinator(value) {
    const candidate = assertCoordinator(value);
    if (coordinator && coordinator !== candidate) throw invalidRequest();
    coordinator = candidate;
    return coordinator;
  }

  function getCoordinator() {
    if (!coordinator) throw recoveryRequired();
    return coordinator;
  }

  function getCurrentLease() {
    return storage.getStore()?.lease || null;
  }

  function getCurrentMutationLease() {
    const lease = getCurrentLease();
    return lease?.kind === 'mutation' ? lease : null;
  }

  function runWithLease(lease, work) {
    const ownedLease = assertLease(lease);
    if (typeof work !== 'function') throw invalidRequest();
    return storage.run(Object.freeze({ lease: ownedLease }), work);
  }

  function markCurrentDirty(serverPath) {
    const lease = getCurrentLease();
    if (!lease) return false;
    if (lease.kind === 'mutation-group' && typeof lease.markDirtyPath === 'function') {
      return lease.markDirtyPath(serverPath);
    }
    lease.assertOwnedPath(serverPath);
    lease.markDirty();
    return true;
  }

  return Object.freeze({
    getCoordinator,
    getCurrentLease,
    getCurrentMutationLease,
    installCoordinator,
    markCurrentDirty,
    runWithLease
  });
}

const sharedServerMutationContext = createServerMutationContext();

function installServerMutationCoordinator(coordinator) {
  return sharedServerMutationContext.installCoordinator(coordinator);
}

function getServerMutationCoordinator() {
  return sharedServerMutationContext.getCoordinator();
}

function getCurrentServerMutationLease() {
  return sharedServerMutationContext.getCurrentMutationLease();
}

function runWithServerMutationLease(lease, work) {
  return sharedServerMutationContext.runWithLease(lease, work);
}

function markCurrentServerMutationDirty(serverPath) {
  return sharedServerMutationContext.markCurrentDirty(serverPath);
}

module.exports = {
  createServerMutationContext,
  getCurrentServerMutationLease,
  getServerMutationCoordinator,
  installServerMutationCoordinator,
  markCurrentServerMutationDirty,
  runWithServerMutationLease,
  sharedServerMutationContext
};
