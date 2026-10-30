const path = require('node:path');
const { ModpackError } = require('../modpacks/errors.cjs');

const PIN = /^(?:[a-f0-9]{64}|(?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/i;
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const pinOf = value => typeof value === 'string' && PIN.test(value.trim()) ? value.trim().replaceAll(':', '').toLowerCase() : '';
// v26.6.1 compared hosts without IPv6 brackets or case (main.cjs normalizeHost); ports compare as numbers.
const hostOf = value => typeof value === 'string' ? value.trim().replace(/^\[|\]$/g, '').toLowerCase() : '';
const portOf = value => {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  return /^[0-9]{1,5}$/.test(text) ? String(Number(text)) : '';
};
const missing = value => typeof value !== 'string' || !value.trim();
const defaultUnpackSecret = value => require('../../utils/secure-store.cjs').unpackSecret(value);

/**
 * Completes a folder client-config.json from the registered client instances v26.6.1 trusted.
 * An https config without a valid pin takes the pin of its own registered instance (same path,
 * host and port), else the one pin every registered client of that host and port agrees on
 * (v26.6.1's findClientInstanceForHost source). A missing invite secret takes the secret of its
 * own registered instance. Folder values always win; it never writes and never invents a pin.
 */
function withRegisteredConnectionFallback(readClientConfig, getInstances, { unpackSecret = defaultUnpackSecret } = {}) {
  if (typeof readClientConfig !== 'function' || typeof getInstances !== 'function' || typeof unpackSecret !== 'function') {
    throw new ModpackError('INVALID_REQUEST', 'Client connection details are unavailable');
  }
  return async clientPath => {
    const config = await readClientConfig(clientPath);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
    const needsPin = config.serverProtocol === 'https' && !pinOf(config.managementCertFingerprint);
    const needsSecret = missing(config.inviteSecret);
    const host = hostOf(config.serverIp), port = portOf(config.serverPort);
    if ((!needsPin && !needsSecret) || !host || !port || typeof clientPath !== 'string' || !path.isAbsolute(clientPath)) return config;
    let peers;
    try {
      const instances = await getInstances();
      peers = (Array.isArray(instances) ? instances : []).filter(instance => instance && typeof instance === 'object' &&
        instance.type === 'client' && hostOf(instance.serverIp) === host && portOf(instance.serverPort) === port);
    } catch { return config; }
    const own = peers.filter(instance => typeof instance.path === 'string' && path.isAbsolute(instance.path) && key(instance.path) === key(clientPath));
    const registered = own.length === 1 ? own[0] : null;
    const completed = {};
    if (needsPin) {
      const agreed = [...new Set(peers.map(instance => pinOf(instance.managementCertFingerprint)).filter(Boolean))];
      // Disagreeing pins are refused: the config keeps no pin, so the broker fails before any request.
      const pin = pinOf(registered?.managementCertFingerprint) || (agreed.length === 1 ? agreed[0] : '');
      if (pin) completed.managementCertFingerprint = pin;
    }
    if (needsSecret && registered) {
      try {
        const secret = unpackSecret(registered.inviteSecret);
        if (typeof secret === 'string' && secret.trim()) completed.inviteSecret = secret.trim();
      } catch { /* An unreadable secret stays missing, so the broker still fails before any request. */ }
    }
    return Object.keys(completed).length ? { ...config, ...completed } : config;
  };
}

module.exports = { withRegisteredConnectionFallback };
