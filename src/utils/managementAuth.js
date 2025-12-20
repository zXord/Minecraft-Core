/**
 * Management server auth helpers (renderer-side).
 */

/**
 * @typedef {Object} ManagementInstance
 * @property {string=} serverIp
 * @property {string=} serverPort
 * @property {string=} serverProtocol
 * @property {string=} clientId
 * @property {string=} clientName
 * @property {string=} name
 * @property {string=} path
 * @property {string=} sessionToken
 * @property {string=} inviteSecret
 * @property {string=} managementCertFingerprint
 */

const TOKEN_HEADER = 'X-Session-Token';

function normalizeProtocol(value) {
  if (!value || typeof value !== 'string') return 'https';
  const normalized = value.trim().toLowerCase();
  return normalized === 'http' ? 'http' : 'https';
}

function formatHostForUrl(host) {
  if (!host || typeof host !== 'string') return '';
  const trimmed = host.trim();
  if (trimmed.includes(':') && !trimmed.startsWith('[') && !trimmed.endsWith(']')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

/**
 * Build the base URL for the management server.
 * @param {ManagementInstance | null | undefined} instance
 * @returns {string}
 */
export function getManagementBaseUrl(instance) {
  if (!instance || !instance.serverIp || !instance.serverPort) return '';
  const protocol = normalizeProtocol(instance.serverProtocol);
  const host = formatHostForUrl(instance.serverIp);
  return `${protocol}://${host}:${instance.serverPort}`;
}

/**
 * Resolve a management server URL from a path.
 * @param {ManagementInstance | null | undefined} instance
 * @param {string} path
 * @returns {string}
 */
export function resolveManagementUrl(instance, path) {
  const base = getManagementBaseUrl(instance);
  if (!base) return '';
  if (!path) return base;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/**
 * Get the current session token from an instance, if present.
 * @param {ManagementInstance | null | undefined} instance
 * @returns {string}
 */
export function getSessionToken(instance) {
  if (!instance || typeof instance.sessionToken !== 'string') return '';
  const trimmed = instance.sessionToken.trim();
  return trimmed.length ? trimmed : '';
}

/**
 * Build headers with the session token attached when available.
 * @param {ManagementInstance | null | undefined} instance
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Record<string, string>}
 */
export function buildAuthHeaders(instance, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const token = getSessionToken(instance);
  if (token) {
    headers[TOKEN_HEADER] = token;
  }
  return headers;
}

/**
 * Ensure a session token is registered and stored for the instance.
 * @param {ManagementInstance | null | undefined} instance
 * @param {boolean} [force=false]
 * @returns {Promise<string|null>}
 */
export async function ensureSessionToken(instance, force = false) {
  if (!instance || !instance.serverIp || !instance.serverPort) return null;

  const existingToken = getSessionToken(instance);
  if (existingToken && !force) return existingToken;

  const clientId = instance.clientId || `client-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const clientName = instance.clientName || instance.name || 'Minecraft Client';
  const registerUrl = resolveManagementUrl(instance, '/api/client/register');
  if (!registerUrl) return null;

  try {
    const inviteSecret = typeof instance.inviteSecret === 'string' ? instance.inviteSecret.trim() : '';
    const response = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, name: clientName, secret: inviteSecret || undefined })
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const token = data && data.token ? String(data.token) : '';
    if (!token) return null;

    instance.sessionToken = token;
    instance.clientId = clientId;
    instance.clientName = clientName;

    if (instance.path && window?.electron?.invoke) {
      try {
        await window.electron.invoke('save-client-config', {
          path: instance.path,
          serverIp: instance.serverIp,
          serverPort: instance.serverPort,
          clientId,
          clientName,
          sessionToken: token
        });
      } catch {
        // ignore persistence errors
      }
    }

    return token;
  } catch {
    return null;
  }
}
