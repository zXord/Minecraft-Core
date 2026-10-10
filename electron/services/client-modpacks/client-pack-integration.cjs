const { ModpackError } = require('../modpacks/errors.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const { MANIFEST_NAME } = require('./client-pack-state.cjs');
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = code => new ModpackError(code, code === 'CLIENT_PACK_UNAVAILABLE'
  ? 'Use Matching modpack to install or update this client before continuing'
  : 'The client must be recovered or verified before continuing');

function createClientPackIntegration({ resolveClient, resolveClientByPath, processGuard, transaction,
  stateStore, managementClient, clientPackService } = {}) {
  if (typeof resolveClient !== 'function' || typeof resolveClientByPath !== 'function') throw fail('INVALID_REQUEST');
  async function classify(target, options) {
    const journal = await transaction.status(target);
    if (journal && !['committed', 'abandoned'].includes(journal.phase)) throw fail('RECOVERY_REQUIRED');
    const manifest = await stateStore.read(target.clientPath);
    const { descriptor: requirement, binding } = await managementClient.readRequirement(target.clientId, options);
    return { managed: Boolean(manifest || requirement), requirement, binding };
  }
  return Object.freeze({
    async assertServerDestination(serverPath) {
      if (typeof serverPath !== 'string' || !path.isAbsolute(serverPath) || serverPath.includes('\0')) throw fail('INVALID_REQUEST');
      if (typeof transaction.assertNoUnsettledAtPath !== 'function') throw fail('CLIENT_PACK_UNAVAILABLE');
      // Exact application-owned marker names only. Presence (including corruption)
      // refuses reuse; absence never clears a durable unfinished transaction.
      let current = path.resolve(serverPath);
      if (path.dirname(current) === current) throw fail('INVALID_REQUEST');
      for (;;) {
        try { await fs.lstat(path.join(current, MANIFEST_NAME)); throw fail('CLIENT_PACK_UNAVAILABLE'); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await transaction.assertNoUnsettledAtPath(current);
        const parent = path.dirname(current);
        if (path.dirname(parent) === parent) return;
        current = parent;
      }
    },
    async runLegacyMutation({ clientId, clientPath }, work) {
      const target = await resolveClient(clientId);
      if (!target || target.clientId !== clientId || (clientPath !== undefined && pathKey(clientPath) !== pathKey(target.clientPath))) throw fail('INVALID_REQUEST');
      return processGuard.withMutation(target, async () => {
        const current = await resolveClient(clientId);
        if (!current || pathKey(current.clientPath) !== pathKey(target.clientPath)) throw fail('PLAN_STALE');
        if ((await classify(target)).managed) throw fail('CLIENT_PACK_UNAVAILABLE');
        return work();
      });
    },
    async beginManagedLaunch({ clientPath }, options = {}) {
      const target = await resolveClientByPath(clientPath);
      if (!target) throw fail('INVALID_REQUEST');
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
        await reservation.abortBeforeSpawn();
        throw error;
      }
    }
  });
}
module.exports = { createClientPackIntegration };
