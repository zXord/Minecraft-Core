const { normalizeCompanionDescriptor } = require('./companion-contracts.cjs');
const { ModpackError, CLIENT_PACK_SERVER_CHANGED_GUIDANCE: SERVER_CHANGED_GUIDANCE } = require('../modpacks/errors.cjs');
// Friends on older versions give /api/server/info about 5 s; the companion fields
// must never hold the legacy fields beyond this.
const DEFAULT_TIMEOUT_MS = 3000;
function failureFields(cause) {
  if (cause instanceof ModpackError && cause.code === 'CLIENT_PACK_SERVER_CHANGED') {
    return { clientModpack: null, clientModpackError: { code: 'CLIENT_PACK_SERVER_CHANGED', message: SERVER_CHANGED_GUIDANCE } };
  }
  return { clientModpack: null, clientModpackError: { code: 'CLIENT_PACK_UNAVAILABLE',
    message: 'Matching client pack information is unavailable. Review the server matching pack settings.' } };
}
// Starts the resolver at once, so it overlaps the synchronous legacy server-info
// work. The budget starts only when settle() is called where the fields are used,
// so that work never spends it. A resolver that misses the budget yields the
// unavailable fields; its late result or failure is ignored.
function startClientPackManagementFields(serverId, resolver) {
  let pending;
  try {
    if (typeof resolver !== 'function') throw new Error('unavailable');
    pending = Promise.resolve(resolver(serverId));
  } catch (cause) { pending = Promise.reject(cause); }
  const fields = pending.then(descriptor => ({ clientModpack: descriptor === null ? null : normalizeCompanionDescriptor(descriptor) }))
    .catch(failureFields);
  return Object.freeze({
    async settle({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive whole number');
      let timer;
      const expired = new Promise(resolve => { timer = setTimeout(() => resolve(failureFields()), timeoutMs); });
      try { return await Promise.race([fields, expired]); }
      finally { clearTimeout(timer); }
    }
  });
}
function clientPackManagementFields(serverId, resolver, options) {
  return startClientPackManagementFields(serverId, resolver).settle(options);
}
module.exports = { clientPackManagementFields, startClientPackManagementFields };
