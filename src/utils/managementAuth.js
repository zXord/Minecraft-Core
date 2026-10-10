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

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const unavailable = () => new Error('The management session could not be acquired.');
const attemptDeadlines = new WeakMap();
const checkAttemptSignal = signal => {
  const end = attemptDeadlines.get(signal);
  if (signal.aborted || !Number.isFinite(end) || Date.now() >= end) throw unavailable();
};
const stale = () => Object.assign(new Error('The client connection changed.'), { stale: true });
const authorityKey = instance => JSON.stringify([instance?.id, instance?.path, instance?.serverIp, instance?.serverPort,
  instance?.serverProtocol, instance?.clientId, instance?.clientName, instance?.name, instance?.inviteSecret, instance?.managementCertFingerprint]);

function sessionOperation(instance, { isCurrent = () => true, signal, deadline } = {}) {
  const key = authorityKey(instance);
  let origin;
  try { origin = new URL(getManagementBaseUrl(instance)).origin; } catch { throw unavailable(); }
  const selector = instance?.id ? { clientInstanceId: instance.id } : { clientPath: instance?.path };
  if (selector.clientInstanceId ? !identifier(selector.clientInstanceId) : !selector.clientPath) throw unavailable();
  const end = Math.min(deadline ?? Infinity, Date.now() + 30000);
  let registrationAttempted = false;
  const check = () => {
    if (!isCurrent() || key !== authorityKey(instance)) throw stale();
    if (signal?.aborted || !Number.isFinite(end) || Date.now() >= end) throw unavailable();
  };
  // IPC has an exact schema: cancellation/deadlines are local to this waiter.
  const wait = async work => {
    check();
    let timer, abort;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => { check(); return work(); }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(unavailable()), Math.max(0, end - Date.now()));
          abort = () => reject(unavailable());
          signal?.addEventListener('abort', abort, { once: true });
        })
      ]);
      check(); return result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const acquire = async (reason = 'reuse', observed) => {
    let result;
    try {
      result = await wait(() => globalThis.window?.electron?.invoke('management-session:acquire', {
        ...selector, reason,
        ...(observed ? { observedBindingGeneration: observed.bindingGeneration, observedRevision: observed.revision } : {})
      }));
    } catch (error) { if (error?.stale) throw error; throw unavailable(); }
    if (result?.ok !== true) throw unavailable();
    const value = result.value;
    if (!value || typeof value.sessionToken !== 'string' || !value.sessionToken || value.sessionToken.length > 16384 ||
        /[\u0000-\u001f\u007f]/u.test(value.sessionToken) || !identifier(value.bindingGeneration) ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.baseOrigin !== 'string' || typeof value.registrationAttempted !== 'boolean') throw unavailable();
    let parsed;
    try { parsed = new URL(value.baseOrigin); } catch { throw unavailable(); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value.baseOrigin || parsed.username || parsed.password) throw unavailable();
    if (value.baseOrigin !== origin || (observed && value.bindingGeneration !== observed.bindingGeneration)) throw stale();
    registrationAttempted ||= value.registrationAttempted;
    return Object.freeze({ sessionToken: value.sessionToken, baseOrigin: value.baseOrigin, bindingGeneration: value.bindingGeneration, revision: value.revision });
  };
  const attempt = async (work, timeoutMs = 10000) => {
    check();
    const controller = new AbortController();
    const attemptEnd = Math.min(end, Date.now() + Math.max(0, Math.min(10000, timeoutMs)));
    attemptDeadlines.set(controller.signal, attemptEnd);
    const abort = () => controller.abort();
    const timer = setTimeout(abort, Math.max(0, attemptEnd - Date.now()));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    try {
      checkAttemptSignal(controller.signal);
      const result = await wait(() => new Promise((resolve, reject) => {
        const stopped = () => reject(unavailable());
        controller.signal.addEventListener('abort', stopped, { once: true });
        if (controller.signal.aborted) stopped();
        else Promise.resolve().then(() => { check(); checkAttemptSignal(controller.signal); return work(controller.signal); })
          .then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', stopped));
      }));
      checkAttemptSignal(controller.signal);
      return result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); attemptDeadlines.delete(controller.signal); }
  };
  return { acquire, wait, attempt, spent: () => registrationAttempted };
}

/** Compatibility helper for registered clients; never registers or saves in renderer. */
export async function ensureSessionToken(instance, force = false, options = {}) {
  const operation = sessionOperation(instance, options);
  let session = await operation.acquire();
  if (force && !operation.spent()) session = await operation.acquire('explicit-reconnect', session);
  return session.sessionToken;
}

/** Safe-read recovery only. URLs must be built from the callback's snapshot, with redirects blocked. */
export async function requestWithSessionRecovery(instance, request, options = {}) {
  if (typeof request !== 'function') throw new TypeError('Authenticated request must be a function');
  const operation = sessionOperation(instance, options);
  let session = await operation.acquire();
  if (options.forceRegistration && !operation.spent()) session = await operation.acquire('explicit-reconnect', session);
  const dispatch = current => operation.attempt(signal => request(Object.freeze({ [TOKEN_HEADER]: current.sessionToken }), current, { signal }), options.timeoutMs);
  const response = await dispatch(session);
  if (response?.status !== 401 || options.forceRegistration || operation.spent()) return response;
  session = await operation.acquire('authorization-rejected', session);
  return dispatch(session);
}

/** Registered JSON reads retain cancellation and deadlines through streaming and parsing. */
export async function readManagementJson(instance, path, options = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw unavailable();
  return requestWithSessionRecovery(instance, async (headers, session, { signal }) => {
    const response = await fetch(`${session.baseOrigin}${path}`, { method: 'GET', headers, redirect: 'error', signal });
    if (!response.ok) { await response.body?.cancel(); checkAttemptSignal(signal); return { ok: false, status: response.status, data: null }; }
    const maxBytes = path.split('?')[0] === '/api/server/info' ? 262144 : Infinity;
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      checkAttemptSignal(signal);
      if (Number(response.headers.get('Content-Length')) > maxBytes) throw unavailable();
      let size = 0; const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        checkAttemptSignal(signal);
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength > maxBytes - size) throw unavailable();
        size += value.byteLength; chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let data;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw unavailable(); }
      checkAttemptSignal(signal);
      return { ok: true, status: response.status, data };
    } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
  }, options);
}
