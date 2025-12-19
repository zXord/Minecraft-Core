/**
 * Management server auth helpers (renderer-side).
 */

/**
 * @typedef {Object} ManagementInstance
 * @property {string=} serverIp
 * @property {string=} serverPort
 * @property {string=} clientId
 * @property {string=} clientName
 * @property {string=} name
 * @property {string=} path
 * @property {string=} sessionToken
 */

const TOKEN_HEADER = 'X-Session-Token';

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
  const registerUrl = `http://${instance.serverIp}:${instance.serverPort}/api/client/register`;

  try {
    const response = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, name: clientName })
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
