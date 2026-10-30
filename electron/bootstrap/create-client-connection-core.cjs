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
    const ids = [...new Set(getInstances().filter(i => i?.type === 'client' && typeof i.id === 'string' && typeof i.path === 'string' &&
      path.isAbsolute(i.path) && key(i.path) === key(clientPath)).map(i => i.id))].sort(compareCodePoints);
    if (ids.length === 0) throw unregistered();
    return resolveClient(ids[0]);
  };
  const sessionClock = () => { const value = clock.now(); return value instanceof Date ? value.getTime() : value; };
  const managementSessionBroker = new ManagementSessionBroker({ resolveClient,
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
