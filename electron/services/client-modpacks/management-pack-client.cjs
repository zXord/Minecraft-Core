const http = require('node:http');
const https = require('node:https');
const { ModpackError } = require('../modpacks/errors.cjs');
const { normalizeCompanionDescriptor } = require('./companion-contracts.cjs');
const MAX_BYTES = 256 * 1024;
const fail = (code = 'CLIENT_PACK_UNAVAILABLE', cause) => new ModpackError(code, 'The matching client requirement could not be read', { cause });

// This transport never follows redirects. Its deadline includes the entire body.
function fetchManagementJson(url, { headers, agent, signal, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, { headers, agent, signal }, response => {
      if (response.statusCode !== 200) { response.resume(); request.destroy(); reject(fail()); return; }
      let length = 0; const chunks = [];
      response.on('data', chunk => {
        length += chunk.length;
        if (length > maxBytes) { request.destroy(fail()); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (cause) { reject(fail(undefined, cause)); }
      });
    });
    const timer = setTimeout(() => request.destroy(fail()), timeoutMs);
    request.once('close', () => clearTimeout(timer));
    request.once('error', reject);
  });
}
class ManagementPackClient {
  constructor({ resolveClient, readClientConfig, fetchJson = fetchManagementJson, getPinnedHttpsAgent, timeoutMs = 10000 } = {}) {
    if (typeof resolveClient !== 'function' || typeof readClientConfig !== 'function' || typeof fetchJson !== 'function' ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail('INVALID_REQUEST');
    Object.assign(this, { resolveClient, readClientConfig, fetchJson, getPinnedHttpsAgent, timeoutMs });
  }
  async _read(clientId, { signal } = {}) {
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clientId)) throw fail('INVALID_REQUEST');
    const target = await this.resolveClient(clientId);
    if (!target || target.clientId !== clientId || typeof target.clientPath !== 'string') throw fail('INVALID_REQUEST');
    try {
      const config = await this.readClientConfig(target.clientPath);
      if (!config || !['http', 'https'].includes(config.serverProtocol) || typeof config.serverIp !== 'string' ||
          !config.serverIp || /[\s/@?#\\]/u.test(config.serverIp) || typeof config.sessionToken !== 'string' ||
          !config.sessionToken || /[\r\n]/u.test(config.sessionToken) || !/^[0-9]{1,5}$/.test(String(config.serverPort)) ||
          Number(config.serverPort) < 1 || Number(config.serverPort) > 65535) throw fail();
      const host = config.serverIp.includes(':') && !config.serverIp.startsWith('[') ? `[${config.serverIp}]` : config.serverIp;
      const url = new URL(`${config.serverProtocol}://${host}:${config.serverPort}/api/server/info`);
      let agent;
      if (url.protocol === 'https:') {
        if (typeof config.managementCertFingerprint !== 'string' || !/^(?:[a-f0-9]{64}|(?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/i.test(config.managementCertFingerprint) ||
            typeof this.getPinnedHttpsAgent !== 'function') throw fail();
        agent = await this.getPinnedHttpsAgent(url.hostname.replace(/^\[|\]$/g, ''), Number(config.serverPort), config.managementCertFingerprint);
        if (!agent) throw fail();
      }
      signal?.throwIfAborted();
      const response = await this.fetchJson(url, { headers: { 'X-Session-Token': config.sessionToken }, agent, signal,
        timeoutMs: this.timeoutMs, maxBytes: MAX_BYTES, redirect: 'error' });
      signal?.throwIfAborted();
      if (!response || typeof response !== 'object' || Array.isArray(response) ||
          Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_BYTES || !Object.hasOwn(response, 'clientModpack') ||
          Object.hasOwn(response, 'clientModpackError')) throw fail();
      return { descriptor: response.clientModpack === null ? null : normalizeCompanionDescriptor(response.clientModpack),
        serverIp: config.serverIp, minecraftPort: response.minecraftPort };
    } catch (cause) { throw fail(signal?.aborted ? 'CANCELLED' : 'CLIENT_PACK_UNAVAILABLE', cause); }
  }
  async getRequirement(clientId, options) { return (await this._read(clientId, options)).descriptor; }
  // Main-only: the renderer cannot choose the endpoint or supply runtime authority.
  async getLaunchConnection(clientId, { serverFingerprint, artifactSha256 } = {}) {
    const result = await this._read(clientId);
    if (result.descriptor?.status !== 'ready' || result.descriptor.serverFingerprint !== serverFingerprint ||
        result.descriptor.artifactSha256 !== artifactSha256) throw fail('PLAN_STALE');
    if (!/^[0-9]{1,5}$/.test(String(result.minecraftPort)) || Number(result.minecraftPort) < 1 || Number(result.minecraftPort) > 65535) throw fail();
    return Object.freeze({ serverIp: result.serverIp, serverPort: Number(result.minecraftPort) });
  }
}
module.exports = { ManagementPackClient, fetchManagementJson };
