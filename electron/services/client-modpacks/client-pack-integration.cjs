const { ModpackError } = require('../modpacks/errors.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const { MANIFEST_NAME } = require('./client-pack-state.cjs');
const { HOST_UNREACHABLE_REASON } = require('../management-session-transport.cjs');
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = code => new ModpackError(code, code === 'CLIENT_PACK_UNAVAILABLE'
  ? 'Use Matching modpack to install or update this client before continuing'
  : 'The client must be recovered or verified before continuing');
// How long a client-local content edit waits to learn the host's requirement.
const LOCAL_REQUIREMENT_DEADLINE_MS = 3000;
const LENIENT = Object.freeze({ proof: 'none' });
const settled = journal => !journal || ['committed', 'abandoned'].includes(journal.phase);

async function folderMissing(folder) {
  try { return !(await fs.stat(folder)).isDirectory(); }
  catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'; }
}

function createClientPackIntegration({ resolveClient, resolveClientByPath, processGuard, transaction,
  stateStore, managementClient, clientPackService, clock = Date.now } = {}) {
  if (typeof resolveClient !== 'function' || typeof resolveClientByPath !== 'function' || typeof clock !== 'function') throw fail('INVALID_REQUEST');
  async function assertSettled(target) {
    if (!settled(await transaction.status(target))) throw fail('RECOVERY_REQUIRED');
  }
  async function classify(target, options) {
    await assertSettled(target);
    const manifest = await stateStore.read(target.clientPath);
    const { descriptor: requirement, binding } = await managementClient.readRequirement(target.clientId, options);
    return { managed: Boolean(manifest || requirement), requirement, binding };
  }
  // Strict or lenient is decided from local evidence alone (a manifest or an
  // unsettled journal), read before any reservation, so none ever needs upgrading.
  // Evidence that cannot be read selects the strict path.
  async function hasLocalEvidence(target) {
    try { return !settled(await transaction.status(target)) || Boolean(await stateStore.read(target.clientPath)); }
    catch { return true; }
  }
  async function registeredTarget(clientId, clientPath) {
    const target = await resolveClient(clientId);
    if (!target || target.clientId !== clientId || (clientPath !== undefined && pathKey(clientPath) !== pathKey(target.clientPath))) throw fail('INVALID_REQUEST');
    return target;
  }
  // Client channels share the folder with each other and with the app's own
  // unmanaged game, with no process scan (v26.6.1 had no guard). Pack transactions
  // and managed launches hold it exclusively, so neither side can overlap the other.
  function lenient(target, work) {
    return processGuard.withMutation(target, async () => {
      const current = await resolveClient(target.clientId);
      if (!current || pathKey(current.clientPath) !== pathKey(target.clientPath)) throw fail('PLAN_STALE');
      return work();
    }, LENIENT);
  }
  async function strictLaunch(target, options) {
    const reservation = await processGuard.beginLaunch(target);
    try {
      const status = await classify(target, options);
      // Process lifetime ownership is independent of managed runtime authority:
      // connection preferences can change while an ordinary client is running.
      if (!status.managed) return reservation;
      if (status.requirement?.status !== 'ready') throw fail('CLIENT_PACK_UNAVAILABLE');
      const internalOptions = { signal: options.signal, deadline: options.deadline, expectedBinding: status.binding };
      const authority = await clientPackService.getLaunchAuthority({ clientId: target.clientId }, internalOptions);
      const connection = await managementClient.getLaunchConnection(target.clientId, authority, internalOptions);
      return Object.freeze({ ...reservation, authority: Object.freeze({ ...authority, ...connection }) });
    } catch (error) {
      await reservation?.abortBeforeSpawn?.();
      throw error;
    }
  }
  return Object.freeze({
    async assertServerDestination(serverPath) {
      if (typeof serverPath !== 'string' || !path.isAbsolute(serverPath) || serverPath.includes('\0')) throw fail('INVALID_REQUEST');
      if (typeof transaction.assertNoUnsettledAtPath !== 'function') throw fail('CLIENT_PACK_UNAVAILABLE');
      // Exact application-owned marker names only. Presence (including corruption)
      // refuses reuse; absence never clears a durable unfinished transaction. A drive
      // or share root is checked itself; below one, the walk stops before the root.
      let current = path.resolve(serverPath);
      for (;;) {
        try { await fs.lstat(path.join(current, MANIFEST_NAME)); throw fail('CLIENT_PACK_UNAVAILABLE'); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await transaction.assertNoUnsettledAtPath(current);
        const parent = path.dirname(current);
        if (parent === current || path.dirname(parent) === parent) return;
        current = parent;
      }
    },
    async runLegacyMutation({ clientId, clientPath }, work) {
      const target = await registeredTarget(clientId, clientPath);
      return lenient(target, async () => {
        if ((await classify(target)).managed) throw fail('CLIENT_PACK_UNAVAILABLE');
        return work();
      });
    },
    async runPersonalMutation({ clientId, clientPath }, work) {
      const target = await resolveClient(clientId);
      if (!target || target.clientId !== clientId || pathKey(clientPath) !== pathKey(target.clientPath)) throw fail('INVALID_REQUEST');
      return lenient(target, async () => {
        // Personal settings are permitted for managed clients, but never race
        // their pack's path reservation or an unfinished durable transaction.
        await assertSettled(target);
        return work();
      });
    },
    // Client-local content (own mods, shaders, resource packs). It changes without
    // the host's requirement only when the host gave no HTTP response at all; any
    // reply, error body, refusal or slow connected host keeps refusing.
    async runLocalMutation({ clientId, clientPath }, work) {
      const target = await registeredTarget(clientId, clientPath);
      return lenient(target, async () => {
        await assertSettled(target);
        if (await stateStore.read(target.clientPath)) throw fail('CLIENT_PACK_UNAVAILABLE');
        let requirement;
        try {
          ({ descriptor: requirement } = await managementClient.readRequirement(target.clientId, { deadline: clock() + LOCAL_REQUIREMENT_DEADLINE_MS }));
        } catch (error) {
          if (error instanceof ModpackError && error.code === 'CLIENT_PACK_UNAVAILABLE' && error.reason === HOST_UNREACHABLE_REASON) return work();
          throw error;
        }
        if (requirement) throw fail('CLIENT_PACK_UNAVAILABLE');
        return work();
      });
    },
    // Client rename and delete: registry edits that never read the host. A client
    // whose folder (or its parent) is gone has nothing to hold, so it stays editable.
    // Either way an unsettled journal keeps its client: an interrupted publication
    // leaves the live folder missing, and recovery needs the registration to finish.
    // Only the journal's phase matters here; a settled pack never pins the folder.
    async runRegistryMutation({ clientId, clientPath }, work) {
      const target = await registeredTarget(clientId, clientPath);
      if (await folderMissing(target.clientPath)) {
        await transaction.assertNoUnsettledAtPath(target.clientPath);
        return work();
      }
      return lenient(target, async () => {
        await transaction.assertNoUnsettledAtPath(target.clientPath);
        return work();
      });
    },
    async beginManagedLaunch({ clientPath }, options = {}) {
      const target = await resolveClientByPath(clientPath);
      if (!target) throw fail('INVALID_REQUEST');
      if (await hasLocalEvidence(target)) return strictLaunch(target, options);
      const reservation = await processGuard.beginLaunch(target, LENIENT);
      try {
        // A host that publishes a requirement needs the matching pack installed first.
        const { descriptor } = await managementClient.readRequirement(target.clientId, options);
        if (descriptor) throw fail('CLIENT_PACK_UNAVAILABLE');
        return reservation;
      } catch (error) {
        await reservation?.abortBeforeSpawn?.();
        throw error;
      }
    }
  });
}
module.exports = { createClientPackIntegration };
