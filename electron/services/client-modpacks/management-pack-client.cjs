const { ModpackError, CLIENT_PACK_SERVER_CHANGED_GUIDANCE: SERVER_CHANGED_GUIDANCE } = require('../modpacks/errors.cjs');
const { MANAGEMENT_INFO_MAX_BYTES, HOST_UNREACHABLE_REASON } = require('../management-session-transport.cjs');
const { normalizeCompanionDescriptor } = require('./companion-contracts.cjs');
const MAX_BYTES = MANAGEMENT_INFO_MAX_BYTES;
const fail = (code = 'CLIENT_PACK_UNAVAILABLE', cause) => new ModpackError(code, 'The matching client requirement could not be read', { cause });
// Carries the broker's internal reachability reason; non-enumerable, so public
// results and serialized errors never include it.
function unavailable(cause) {
  const error = fail('CLIENT_PACK_UNAVAILABLE', cause);
  if (cause instanceof ModpackError && cause.reason === HOST_UNREACHABLE_REASON) Object.defineProperty(error, 'reason', { value: HOST_UNREACHABLE_REASON });
  return error;
}

class ManagementPackClient {
  constructor({ sessionBroker, clock = Date.now } = {}) {
    if (typeof sessionBroker?.readServerInfo !== 'function' || typeof sessionBroker?.acquire !== 'function' || typeof clock !== 'function') throw fail('INVALID_REQUEST');
    this.sessionBroker = sessionBroker; this.clock = clock;
  }
  async _read(clientId, { signal, deadline, expectedBinding } = {}) {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clientId)) throw fail('INVALID_REQUEST');
    try {
      const { response, binding } = await this.sessionBroker.readServerInfo(clientId, { signal, deadline, expectedBinding });
      signal?.throwIfAborted();
      if (!response || typeof response !== 'object' || Array.isArray(response) ||
          Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_BYTES) throw fail();
      const hasRequirement = Object.hasOwn(response, 'clientModpack');
      const hasError = Object.hasOwn(response, 'clientModpackError');
      // Hosts that predate matching client packs (v26.6.1) send neither field and
      // cannot publish a requirement. Every current host always sends clientModpack.
      if (!hasRequirement && !hasError) {
        if (response.success !== true) throw fail();
        return { descriptor: null, binding, minecraftPort: response.minecraftPort, legacyHost: true };
      }
      if (!hasRequirement) throw fail();
      if (hasError) {
        if (response.clientModpackError?.code === 'CLIENT_PACK_SERVER_CHANGED') {
          throw new ModpackError('CLIENT_PACK_SERVER_CHANGED', SERVER_CHANGED_GUIDANCE);
        }
        throw fail();
      }
      let descriptor;
      try { descriptor = response.clientModpack === null ? null : normalizeCompanionDescriptor(response.clientModpack); } catch { throw fail(); }
      return { descriptor, binding,
        minecraftPort: response.minecraftPort };
    } catch (cause) {
      if (!signal?.aborted && cause instanceof ModpackError && ['CLIENT_PACK_SERVER_CHANGED', 'PLAN_STALE', 'CANCELLED', 'INVALID_REQUEST'].includes(cause.code)) throw cause;
      throw signal?.aborted ? fail('CANCELLED', cause) : unavailable(cause);
    }
  }
  async readRequirement(clientId, options) {
    const { descriptor, binding, legacyHost } = await this._read(clientId, options);
    return legacyHost ? { descriptor, binding, legacyHost } : { descriptor, binding };
  }
  async getRequirement(clientId, options) { return (await this._read(clientId, options)).descriptor; }
  // Main-only: the renderer cannot choose the endpoint or supply runtime authority.
  async getLaunchConnection(clientId, { serverFingerprint, artifactSha256 } = {}, options = {}) {
    const deadline = Math.min(options.deadline ?? Infinity, this.clock() + 30000);
    const result = await this._read(clientId, { ...options, deadline });
    if (result.descriptor?.status !== 'ready' || result.descriptor.serverFingerprint !== serverFingerprint ||
        result.descriptor.artifactSha256 !== artifactSha256) throw fail('PLAN_STALE');
    if (!/^[0-9]{1,5}$/.test(String(result.minecraftPort)) || Number(result.minecraftPort) < 1 || Number(result.minecraftPort) > 65535) throw fail();
    const session = await this.sessionBroker.acquire(clientId, { ...options, deadline, expectedBinding: result.binding });
    const serverIp = new URL(session.baseOrigin).hostname.replace(/^\[|\]$/g, '');
    return Object.freeze({ serverIp, serverPort: Number(result.minecraftPort) });
  }
}
module.exports = { ManagementPackClient };
