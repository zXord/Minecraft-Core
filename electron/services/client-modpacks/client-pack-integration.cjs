const { ModpackError } = require('../modpacks/errors.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const { MANIFEST_NAME } = require('./client-pack-state.cjs');
const { HOST_UNREACHABLE_REASON } = require('../management-session-transport.cjs');
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = code => new ModpackError(code, code === 'CLIENT_PACK_UNAVAILABLE'
  ? 'Use Matching modpack to install or update this client before continuing'
  : 'The client must be recovered or verified before continuing');
// How long a client-local content edit waits to learn the host's requirement: the
// broker's per-attempt cap (management-session-broker timeoutMs), so a slow but
// reachable host, such as one hashing every client mod for /api/server/info, answers in time.
const LOCAL_REQUIREMENT_DEADLINE_MS = 10000;
// Node's timers count whole milliseconds on their own clock, so the broker's deadline
// timer can fire up to 1 ms before the clock reaches the deadline.
const DEADLINE_TIMER_ROUNDING_MS = 1;
const HOST_SILENT_MESSAGE = 'The server did not answer in time, so this change was not made. Try again in a moment.';
// How long a host's answer spares later local edits a read (and the host its hashing
// pass): an answer without a requirement, or no HTTP response at all.
const NO_REQUIREMENT_VERDICT_MS = 60000;
const HOST_UNREACHABLE_VERDICT_MS = 30000;
const LENIENT = Object.freeze({ proof: 'none' });
const settled = journal => !journal || ['committed', 'abandoned'].includes(journal.phase);

async function folderMissing(folder) {
  try { return !(await fs.stat(folder)).isDirectory(); }
  catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'; }
}

function createClientPackIntegration({ resolveClient, resolveClientByPath, processGuard, transaction,
  stateStore, managementClient, clientPackService, clock = Date.now } = {}) {
  if (typeof resolveClient !== 'function' || typeof resolveClientByPath !== 'function' || typeof clock !== 'function') throw fail('INVALID_REQUEST');
  // The host's last verdict on each client's local content, keyed by client and folder,
  // so a run of toggles does not make the host hash every client mod for each one. Any
  // refusal, failed read or personal settings change ends it and bumps the key's epoch;
  // a read records its verdict only if the epoch did not move while it was in flight.
  const verdicts = new Map(); const verdictEpochs = new Map();
  const verdictKey = target => `${target.clientId}\u0000${pathKey(target.clientPath)}`;
  function forgetVerdict(key) {
    verdicts.delete(key);
    verdictEpochs.set(key, (verdictEpochs.get(key) ?? 0) + 1);
  }
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
      // A settings change (save-client-config) can point the client at another host,
      // so the host's verdict on local content ends both before and after it.
      const key = verdictKey(target);
      forgetVerdict(key);
      try {
        return await lenient(target, async () => {
          // Personal settings are permitted for managed clients, but never race
          // their pack's path reservation or an unfinished durable transaction.
          await assertSettled(target);
          return work();
        });
      } finally { forgetVerdict(key); }
    },
    // Client-local content (own mods, shaders, resource packs). It changes without
    // the host's requirement only when the host gave no HTTP response at all; any
    // reply, error body, refusal or slow connected host keeps refusing.
    async runLocalMutation({ clientId, clientPath }, work) {
      const target = await registeredTarget(clientId, clientPath);
      const key = verdictKey(target);
      return lenient(target, async () => {
        // Local evidence is checked on every edit, before any verdict.
        try {
          await assertSettled(target);
          if (await stateStore.read(target.clientPath)) throw fail('CLIENT_PACK_UNAVAILABLE');
        } catch (error) { forgetVerdict(key); throw error; }
        if (clock() < (verdicts.get(key) ?? -Infinity)) return work();
        const epoch = verdictEpochs.get(key) ?? 0;
        const record = lifetime => { if ((verdictEpochs.get(key) ?? 0) === epoch) verdicts.set(key, clock() + lifetime); };
        const deadline = clock() + LOCAL_REQUIREMENT_DEADLINE_MS;
        let requirement;
        try {
          ({ descriptor: requirement } = await managementClient.readRequirement(target.clientId, { deadline }));
        } catch (error) {
          const unavailable = error instanceof ModpackError && error.code === 'CLIENT_PACK_UNAVAILABLE';
          if (unavailable && error.reason === HOST_UNREACHABLE_REASON) { record(HOST_UNREACHABLE_VERDICT_MS); return work(); }
          forgetVerdict(key);
          // A connected host still silent when the budget ran out.
          if (unavailable && clock() >= deadline - DEADLINE_TIMER_ROUNDING_MS) {
            throw new ModpackError('CLIENT_PACK_UNAVAILABLE', HOST_SILENT_MESSAGE, { cause: error });
          }
          throw error;
        }
        if (requirement) { forgetVerdict(key); throw fail('CLIENT_PACK_UNAVAILABLE'); }
        record(NO_REQUIREMENT_VERDICT_MS);
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
