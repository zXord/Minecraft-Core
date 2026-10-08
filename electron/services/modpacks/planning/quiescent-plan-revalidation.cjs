'use strict';

const path = require('node:path');

const { ModpackError } = require('../errors.cjs');

const REBASEABLE_ACTIONS = new Set(['preserve-modified', 'preserve-orphan', 'preserve-user-addon']);
const SENSITIVE_ROLES = new Set(['mod', 'runtime', 'library', 'server', 'application']);
const SENSITIVE_ROOTS = new Set([
  '.fabric', '.quilt', 'java', 'kubejs', 'libraries', 'mods', 'plugins', 'scripts', 'versions'
]);
const SENSITIVE_PATHS = new Set(['server.properties']);
const SENSITIVE_EXTENSIONS = new Set([
  '.bat', '.class', '.cmd', '.cjs', '.dll', '.dylib', '.exe', '.groovy', '.jar',
  '.js', '.kts', '.mjs', '.ps1', '.py', '.rb', '.sh', '.so'
]);
const DEFAULT_WORLD_DIRECTORIES = Object.freeze(['world', 'world_nether', 'world_the_end']);

function stale() {
  return new ModpackError('PLAN_STALE', 'The server changed after the modpack plan was reviewed');
}

function mapByPath(values) {
  if (!Array.isArray(values)) throw stale();
  const result = new Map();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.pathKey !== 'string' || value.pathKey.length === 0 || result.has(value.pathKey)) throw stale();
    result.set(value.pathKey, value);
  }
  return result;
}

function decisionView(action) {
  if (!action) return null;
  return {
    pathKey: action.pathKey,
    action: action.action,
    role: action.role,
    protected: action.protected === true,
    incomingPath: action.incomingPath ?? null
  };
}

function sameDecision(left, right) {
  return JSON.stringify(decisionView(left)) === JSON.stringify(decisionView(right));
}

function sameCondition(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function normalizeWorldDirectories(values = DEFAULT_WORLD_DIRECTORIES) {
  if (!Array.isArray(values) || values.length === 0) throw stale();
  const result = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw stale();
    const normalized = value.replaceAll('\\', '/').toLocaleLowerCase('en-US');
    const segments = normalized.split('/');
    if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) ||
        segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) throw stale();
    result.add(normalized);
  }
  return result;
}

function sensitivePath(pathKey, worldDirectories, ...actions) {
  if (actions.some(action => SENSITIVE_ROLES.has(action?.role))) return true;
  const normalized = pathKey.replaceAll('\\', '/').toLocaleLowerCase('en-US');
  const segments = normalized.split('/').filter(Boolean);
  const root = segments[0];
  const base = path.posix.basename(normalized);
  // Datapacks are executable server behavior even when their payload uses
  // otherwise passive extensions such as .zip or .json. World save churn may
  // be rebased after a graceful stop, but a datapack subtree must remain bound
  // to the bytes the user reviewed. Matching exact discovered world roots
  // covers nested custom level names without mistaking a dimension namespace
  // (or a world itself named `datapacks`) for the executable datapack folder.
  const datapackPath = [...worldDirectories].some(worldRoot =>
    normalized === `${worldRoot}/datapacks` || normalized.startsWith(`${worldRoot}/datapacks/`));
  return datapackPath || SENSITIVE_PATHS.has(normalized) || SENSITIVE_ROOTS.has(root) ||
    SENSITIVE_EXTENSIONS.has(path.posix.extname(base)) ||
    /^(?:start|launch|run)(?:-[^/]*)?\.(?:bat|cmd|ps1|sh)$/u.test(base);
}

function rebaseable(action) {
  return !action || REBASEABLE_ACTIONS.has(action.action);
}

function manifestPathKeys(manifest, { ignorePreservedUserEntries = false } = {}) {
  if (manifest === null || manifest === undefined) return new Set();
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) throw stale();
  return new Set(manifest.entries.flatMap(entry => {
    if (!entry || typeof entry.pathKey !== 'string' || entry.pathKey.length === 0) throw stale();
    // A completed lifecycle records carried-forward worlds and other preserved
    // user data in the installed manifest. Their presence is provenance, not
    // pack ownership: a later graceful shutdown must still be able to rebase
    // those preservation-only bytes. Unknown origins remain strict.
    return ignorePreservedUserEntries && entry.origin === 'user' ? [] : [entry.pathKey];
  }));
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Accepts only passive user-data churn outside every managed, incoming, or
 * alternate target. All reviewed managed and executable paths remain exact.
 */
function reconcileQuiescentOwnership({
  reviewedOwnership,
  currentOwnership,
  reviewedPathPreconditions,
  currentPathPreconditions,
  oldManifest = null,
  incomingManifest = null,
  worldDirectories
} = {}) {
  if (!reviewedOwnership || !currentOwnership ||
      !Array.isArray(reviewedOwnership.actions) || !Array.isArray(currentOwnership.actions) ||
      !Array.isArray(currentOwnership.blocked) || currentOwnership.blocked.length > 0) throw stale();

  const reviewedActions = mapByPath(reviewedOwnership.actions);
  const currentActions = mapByPath(currentOwnership.actions);
  const reviewedConditions = mapByPath(reviewedPathPreconditions);
  const currentConditions = mapByPath(currentPathPreconditions);
  const knownWorldDirectories = normalizeWorldDirectories(worldDirectories);
  const managedPaths = new Set([
    ...manifestPathKeys(oldManifest, { ignorePreservedUserEntries: true }),
    ...manifestPathKeys(incomingManifest)
  ]);
  const alternateTargets = new Set([...reviewedActions.values(), ...currentActions.values()]
    .map(action => action?.incomingPath)
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => value.replaceAll('\\', '/').toLocaleLowerCase('en-US')));
  const keys = new Set([
    ...reviewedActions.keys(), ...currentActions.keys(),
    ...reviewedConditions.keys(), ...currentConditions.keys()
  ]);

  for (const key of keys) {
    const reviewed = reviewedActions.get(key) || null;
    const current = currentActions.get(key) || null;
    const sensitive = sensitivePath(key, knownWorldDirectories, reviewed, current);
    const overlapsManaged = [...managedPaths, ...alternateTargets].some(candidate => pathsOverlap(key, candidate));
    const eligiblePassiveUserPath = !sensitive && !overlapsManaged && rebaseable(reviewed) && rebaseable(current);
    if (!sameDecision(reviewed, current) && !eligiblePassiveUserPath) throw stale();
    if (!sameCondition(reviewedConditions.get(key), currentConditions.get(key)) && !eligiblePassiveUserPath) throw stale();
  }

  return currentOwnership;
}

module.exports = { reconcileQuiescentOwnership };
