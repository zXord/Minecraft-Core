const { ModpackError } = require('./modpacks/errors.cjs');
const {
  coordinatorInstanceKey,
  coordinatorPathKey
} = require('./server-mutation-coordinator.cjs');

// The coordinator keeps one record per folder, bound to one instance id. A
// folder can be registered more than once (a v26.6.1 duplicate, or a client
// and a server sharing a folder), and the user reorders registrations by
// dragging the sidebar, so the id used for a folder must never depend on array
// position. Every coordinated writer and every server start resolves its
// selector here, so all of them reach the same record with the same id.
const REGISTERED_TYPES = new Set(['server', 'client']);

function invalidRequest() {
  return new ModpackError('INVALID_REQUEST', 'The server mutation request is invalid');
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function registrationsOf(instances) {
  if (!Array.isArray(instances)) return [];
  const registrations = [];
  for (const instance of instances) {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance) || !REGISTERED_TYPES.has(instance.type)) continue;
    const key = coordinatorInstanceKey(instance.id);
    if (!key) continue;
    registrations.push({
      id: instance.id,
      key,
      pathKey: coordinatorPathKey(instance.path),
      server: instance.type === 'server'
    });
  }
  return registrations;
}

// A server before a client, then the lowest id in code-point order.
function preferredRegistration(candidates) {
  let preferred = null;
  for (const candidate of candidates) {
    if (!preferred ||
        (candidate.server && !preferred.server) ||
        (candidate.server === preferred.server && compareCodePoints(candidate.id, preferred.id) < 0)) {
      preferred = candidate;
    }
  }
  return preferred;
}

function boundInstanceId(coordinator, serverPath) {
  if (typeof coordinator?.pathBinding !== 'function') return null;
  try {
    const binding = coordinator.pathBinding(serverPath);
    return typeof binding?.instanceId === 'string' ? binding.instanceId : null;
  } catch {
    return null;
  }
}

function retireStaleBinding(coordinator, instanceId, serverPath) {
  if (typeof coordinator?.retireIdleRegistration !== 'function') return false;
  try {
    return coordinator.retireIdleRegistration({ instanceId, serverPath }) === true;
  } catch {
    return false;
  }
}

/**
 * The coordinator selector for a requested {instanceId, serverPath}, chosen
 * among the registered servers and clients whose folder is the requested one:
 * (a) the id the coordinator already binds to that folder when it is one of
 *     them;
 * (b) otherwise a server before a client, ties broken by the lowest id in
 *     code-point order;
 * (c) with no registration there, an unregistered requested id gives a
 *     path-only selector.
 * A bound id that is registered nowhere is first retired when its record is
 * idle (the registration was removed outside a coordinated writer).
 * @returns {Readonly<{instanceId: string|null, serverPath: string|null}>}
 */
function canonicalCoordinatorSelector({ instances, selector, coordinator } = {}) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw invalidRequest();
  const requestedId = selector.instanceId ?? null;
  const serverPath = selector.serverPath ?? null;
  const pathKey = coordinatorPathKey(serverPath);
  if (!pathKey) return Object.freeze({ instanceId: requestedId, serverPath });

  const registrations = registrationsOf(instances);
  const registeredKeys = new Set(registrations.map(registration => registration.key));
  const atPath = registrations.filter(registration => registration.pathKey === pathKey);

  const boundId = boundInstanceId(coordinator, serverPath);
  let boundKey = coordinatorInstanceKey(boundId);
  if (boundKey && !registeredKeys.has(boundKey) && retireStaleBinding(coordinator, boundId, serverPath)) {
    boundKey = null;
  }

  const bound = boundKey ? atPath.filter(registration => registration.key === boundKey) : [];
  const chosen = preferredRegistration(bound.length > 0 ? bound : atPath);
  if (chosen) return Object.freeze({ instanceId: chosen.id, serverPath });

  const requestedKey = coordinatorInstanceKey(requestedId);
  if (!requestedKey || !registeredKeys.has(requestedKey)) return Object.freeze({ instanceId: null, serverPath });
  return Object.freeze({ instanceId: requestedId, serverPath });
}

module.exports = {
  canonicalCoordinatorSelector
};
