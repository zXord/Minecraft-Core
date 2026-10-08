const { normalizeCompanionDescriptor } = require('./companion-contracts.cjs');
async function clientPackManagementFields(serverId, resolver) {
  try {
    if (typeof resolver !== 'function') throw new Error('unavailable');
    const descriptor = await resolver(serverId);
    return { clientModpack: descriptor === null ? null : normalizeCompanionDescriptor(descriptor) };
  } catch {
    return { clientModpack: null, clientModpackError: { code: 'CLIENT_PACK_UNAVAILABLE',
      message: 'Matching client pack information is unavailable. Review the server matching pack settings.' } };
  }
}
module.exports = { clientPackManagementFields };
