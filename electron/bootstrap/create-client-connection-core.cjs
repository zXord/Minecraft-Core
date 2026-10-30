const path = require('node:path');
const { ModpackError } = require('../services/modpacks/errors.cjs');
const { ManagementSessionBroker } = require('../services/management-session-broker.cjs');
const { withRegisteredConnectionFallback } = require('../services/client-modpacks/registered-connection-fallback.cjs');
const fail = () => new ModpackError('CLIENT_PACK_UNAVAILABLE', 'Matching client pack services are unavailable');
const unregistered = () => new ModpackError('INVALID_REQUEST', 'Choose a registered client instance');
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function compareCodePoints(left, right) {
  const leftPoints = Array.from(left); const rightPoints = Array.from(right);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
// Every id registered for one client folder, lowest first in code-point order.
const folderClientIds = (instances, folderKey) => [...new Set(instances.filter(i => i?.type === 'client' && typeof i.id === 'string' &&
  typeof i.path === 'string' && path.isAbsolute(i.path) && key(i.path) === folderKey).map(i => i.id))].sort(compareCodePoints);

// The host gives one session per remote client and every registration of a client
// folder reads that folder's connection, so they share one broker entry under the
// folder's lowest id, the client resolveClientByPath picks. An id registered nowhere,
// or for different folders, is passed on unchanged and refused as before. When a
// folder's lowest id changes, the previous entry is dropped so the claim moves with it.
class FolderSessionBroker extends ManagementSessionBroker {
  constructor({ readInstances, ...options } = {}) {
    super(options);
    // The last canonical id of each folder, by folder key.
    this.readInstances = readInstances; this.canonicalIds = new Map();
  }
  _canonicalClientId(clientId) {
    if (typeof clientId !== 'string') return clientId;
    let instances;
    try { instances = this.readInstances(); } catch { return clientId; }
    if (!Array.isArray(instances)) return clientId;
    const own = instances.filter(i => i?.id === clientId && i.type === 'client' && typeof i.path === 'string' && path.isAbsolute(i.path));
    if (own.length === 0 || own.some(match => key(match.path) !== key(own[0].path))) return clientId;
    const folderKey = key(own[0].path);
    const [canonical] = folderClientIds(instances, folderKey);
    const previous = this.canonicalIds.get(folderKey);
    if (previous !== undefined && previous !== canonical) super.invalidate(previous);
    this.canonicalIds.set(folderKey, canonical);
    return canonical;
  }
  acquire(clientId, options) { return super.acquire(this._canonicalClientId(clientId), options); }
  acquireWithProvenance(clientId, options) { return super.acquireWithProvenance(this._canonicalClientId(clientId), options); }
  acquireLegacyContext(clientId, options) { return super.acquireLegacyContext(this._canonicalClientId(clientId), options); }
  readServerInfo(clientId, options) { return super.readServerInfo(this._canonicalClientId(clientId), options); }
  invalidate(clientId) { super.invalidate(this._canonicalClientId(clientId)); }
}

// Client resolution and the management session broker. They need no modpack
// services and construction does no I/O, so the service graph builds this core
// with itself and client sessions keep working when the modpack composition does not.
function createClientConnectionCore({ store, readClientConfig, getPinnedHttpsAgent, managementSessionRequestJson, randomUUID, clock } = {}) {
  if (!store || typeof store.get !== 'function' || !clock || typeof clock.now !== 'function') throw fail();
  const getInstances = () => { const values = store.get('instances'); if (!Array.isArray(values)) throw fail(); return values; };
  // A folder registered twice (a v26.6.1 duplicate) resolves like v26.6.1 launched it:
  // the same id under several spellings of one folder is one client, and several ids
  // for one folder resolve to the lowest id in code-point order, never by array order.
  // One id registered for different folders stays ambiguous and is refused.
  const resolveClient = async clientId => {
    const matches = getInstances().filter(i => i?.id === clientId && i.type === 'client' && typeof i.path === 'string' && path.isAbsolute(i.path));
    if (matches.length === 0 || matches.some(match => key(match.path) !== key(matches[0].path))) throw unregistered();
    const clientPath = matches.map(match => path.resolve(match.path)).sort(compareCodePoints)[0];
    return Object.freeze({ clientId, clientPath });
  };
  const resolveClientByPath = async clientPath => {
    if (typeof clientPath !== 'string' || !path.isAbsolute(clientPath)) throw unregistered();
    const ids = folderClientIds(getInstances(), key(clientPath));
    if (ids.length === 0) throw unregistered();
    return resolveClient(ids[0]);
  };
  const sessionClock = () => { const value = clock.now(); return value instanceof Date ? value.getTime() : value; };
  const managementSessionBroker = new FolderSessionBroker({ resolveClient, readInstances: () => store.get('instances'),
    // A folder config without its pin or invite secret takes them from the registered clients v26.6.1 trusted.
    readClientConfig: withRegisteredConnectionFallback(readClientConfig || (value => require('../utils/config-manager.cjs').readClientConfig(value)), getInstances),
    getPinnedHttpsAgent: getPinnedHttpsAgent || ((...args) => require('../utils/tls-utils.cjs').getPinnedHttpsAgent(...args)),
    requestJson: managementSessionRequestJson, randomUUID, clock: sessionClock });
  const acquireLegacyManagementContext = async (clientPath, options = {}) => {
    const deadline = Math.min(options.deadline ?? Infinity, sessionClock() + 30000);
    const target = await resolveClientByPath(clientPath);
    const context = await managementSessionBroker.acquireLegacyContext(target.clientId, { ...options, deadline });
    const current = await resolveClientByPath(clientPath);
    if (current.clientId !== target.clientId || key(current.clientPath) !== key(target.clientPath)) throw new ModpackError('PLAN_STALE', 'The client connection changed');
    await context.assertCurrent({ ...options, deadline });
    return context;
  };
  return Object.freeze({ resolveClient, resolveClientByPath, managementSessionBroker, acquireLegacyManagementContext,
    // Idempotent; cancels every session request still in flight.
    dispose() { managementSessionBroker.dispose(); } });
}
module.exports = { createClientConnectionCore };
