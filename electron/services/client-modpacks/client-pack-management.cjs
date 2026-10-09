const { normalizeCompanionDescriptor } = require('./companion-contracts.cjs');
const { ModpackError, CLIENT_PACK_SERVER_CHANGED_GUIDANCE: SERVER_CHANGED_GUIDANCE } = require('../modpacks/errors.cjs');
async function clientPackManagementFields(serverId, resolver) {
  try {
    if (typeof resolver !== 'function') throw new Error('unavailable');
    const descriptor = await resolver(serverId);
    return { clientModpack: descriptor === null ? null : normalizeCompanionDescriptor(descriptor) };
  } catch (cause) {
    if (cause instanceof ModpackError && cause.code === 'CLIENT_PACK_SERVER_CHANGED') {
      return { clientModpack: null, clientModpackError: { code: 'CLIENT_PACK_SERVER_CHANGED', message: SERVER_CHANGED_GUIDANCE } };
    }
    return { clientModpack: null, clientModpackError: { code: 'CLIENT_PACK_UNAVAILABLE',
      message: 'Matching client pack information is unavailable. Review the server matching pack settings.' } };
  }
}
module.exports = { clientPackManagementFields };
