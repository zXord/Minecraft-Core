const path = require('node:path');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { isSafeWindowsBasename } = require('../windows-basename.cjs');

const ORIGINS = new Set(['pack', 'runtime', 'user', 'application']);
const POLICIES = new Set(['replaceable-managed', 'preserve-after-seed', 'protected', 'ignored-rejected']);
const ROLES = new Set(['mod', 'configuration', 'world', 'runtime', 'library', 'server', 'resource', 'shader', 'application', 'secret', 'other']);
const CHOICES = new Set(['keep-mine', 'use-pack', 'keep-both', 'disable-addon', 'remove-addon']);
const HASH = /^[a-f0-9]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const APP_ISSUED_OWNERSHIP_PLANS = new WeakSet();
const APP_ISSUED_OWNERSHIP_DECISIONS = new WeakMap();

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'The ownership plan is invalid', {
    details: field ? { field } : undefined
  });
}

function descriptors(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) invalid(field);
  const result = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(result)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || (allowed && !allowed.has(key))) invalid(`${field}.${key}`);
  }
  return result;
}

function data(value, allowed, field) {
  const source = descriptors(value, allowed, field);
  return Object.fromEntries(Object.entries(source).map(([key, descriptor]) => [key, descriptor.value]));
}

function arrayData(value, field, maximum = 250_000) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 || value.length > maximum) invalid(field);
  const source = Object.getOwnPropertyDescriptors(value);
  const expected = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (Object.keys(source).some(key => !expected.has(key))) invalid(field);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = source[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(`${field}.${index}`);
    result.push(descriptor.value);
  }
  return result;
}

function identifier(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) invalid(field);
  return value;
}

function manifestIdentifier(value, field) {
  const normalized = identifier(value, field);
  if (!isSafeWindowsBasename(`${normalized}.json`)) invalid(field);
  return normalized;
}

function canonicalPath(value, field = 'path') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || value !== value.normalize('NFC') ||
      value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes(':')) invalid(field);
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..' || !isSafeWindowsBasename(part))) invalid(field);
  return { path: parts.join('/'), pathKey: parts.join('/').toLocaleLowerCase('en-US') };
}

function isReserved(pathKey) {
  return pathKey === '.minecraft-core.json' || pathKey === '.minecraft-core-state' || pathKey.startsWith('.minecraft-core-state/');
}

function isEula(pathKey) {
  return pathKey === 'eula.txt';
}

function decimal(value, field) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) invalid(field);
  try { BigInt(value); } catch { invalid(field); }
  return value;
}

function digest(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HASH.test(value)) invalid(field);
  return value;
}

function assertNoFilePathOverlap(entries, field) {
  const keys = new Set(entries.map(entry => entry.pathKey));
  for (const entry of entries) {
    const parts = entry.pathKey.split('/');
    let prefix = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
      if (keys.has(prefix)) invalid(field);
    }
  }
}

function normalizeOwnershipEntry(value, index) {
  const field = `manifest.entries.${index}`;
  const entry = data(value, new Set([
    'path', 'pathKey', 'origin', 'managementPolicy', 'role', 'installedHash', 'size', 'priorBaseline',
    'modId', 'runtimeCompatible'
  ]), field);
  const normalized = canonicalPath(entry.path, `${field}.path`);
  if (entry.pathKey !== normalized.pathKey || isReserved(normalized.pathKey) || isEula(normalized.pathKey) ||
      !ORIGINS.has(entry.origin) || !POLICIES.has(entry.managementPolicy) || !ROLES.has(entry.role)) invalid(field);
  if (entry.modId !== undefined && (typeof entry.modId !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(entry.modId))) invalid(`${field}.modId`);
  if (entry.runtimeCompatible !== undefined && typeof entry.runtimeCompatible !== 'boolean') invalid(`${field}.runtimeCompatible`);
  return {
    ...normalized,
    origin: entry.origin,
    managementPolicy: entry.managementPolicy,
    role: entry.role,
    installedHash: digest(entry.installedHash, `${field}.installedHash`),
    size: decimal(entry.size, `${field}.size`),
    priorBaseline: digest(entry.priorBaseline, `${field}.priorBaseline`, { nullable: true }),
    ...(entry.modId === undefined ? {} : { modId: entry.modId }),
    ...(entry.runtimeCompatible === undefined ? {} : { runtimeCompatible: entry.runtimeCompatible })
  };
}

function normalizeOwnershipManifest(value, { allowNull = false } = {}) {
  if (allowNull && value === null) return null;
  const manifest = data(value, new Set(['schemaVersion', 'installationId', 'entries']), 'manifest');
  if (manifest.schemaVersion !== 1) invalid('manifest');
  const manifestEntries = arrayData(manifest.entries, 'manifest.entries');
  const entries = manifestEntries.map(normalizeOwnershipEntry);
  entries.sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  if (new Set(entries.map(entry => entry.pathKey)).size !== entries.length) invalid('manifest.entries');
  assertNoFilePathOverlap(entries, 'manifest.entries');
  return deepFreeze({ schemaVersion: 1, installationId: manifestIdentifier(manifest.installationId, 'manifest.installationId'), entries });
}

function normalizeIncomingManifest(value) {
  const raw = data(value, new Set(['schemaVersion', 'installationId', 'entries']), 'incomingManifest');
  if (raw.schemaVersion !== 1) invalid('incomingManifest');
  const incomingEntries = arrayData(raw.entries, 'incomingManifest.entries');
  const normalizedEntries = [];
  for (let index = 0; index < incomingEntries.length; index += 1) {
    const entry = data(incomingEntries[index], new Set([
      'path', 'pathKey', 'origin', 'managementPolicy', 'role', 'installedHash', 'size', 'priorBaseline',
      'modId', 'runtimeCompatible'
    ]), `incomingManifest.entries.${index}`);
    const normalized = canonicalPath(entry.path, `incomingManifest.entries.${index}.path`);
    if (entry.pathKey !== normalized.pathKey) invalid(`incomingManifest.entries.${index}.pathKey`);
    if (isReserved(normalized.pathKey)) invalid(`incomingManifest.entries.${index}.path`);
    if (isEula(normalized.pathKey)) {
      normalizedEntries.push({ ...entry, ...normalized, ignoredEula: true });
      continue;
    }
    normalizedEntries.push(normalizeOwnershipEntry(entry, index));
  }
  normalizedEntries.sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  if (new Set(normalizedEntries.map(entry => entry.pathKey)).size !== normalizedEntries.length) invalid('incomingManifest.entries');
  assertNoFilePathOverlap(normalizedEntries, 'incomingManifest.entries');
  return deepFreeze({ schemaVersion: 1, installationId: manifestIdentifier(raw.installationId, 'incomingManifest.installationId'), entries: normalizedEntries });
}

function normalizeLiveSnapshot(value) {
  const snapshot = data(value, new Set(['kind', 'worldDirectories', 'protectedPaths', 'entries']), 'liveSnapshot');
  if (!['new', 'existing'].includes(snapshot.kind)) invalid('liveSnapshot');
  const worldValues = arrayData(snapshot.worldDirectories || [], 'liveSnapshot.worldDirectories', 1024);
  const worlds = worldValues.map((item, index) => canonicalPath(item, `liveSnapshot.worldDirectories.${index}`).pathKey);
  const protectedValues = arrayData(snapshot.protectedPaths || [], 'liveSnapshot.protectedPaths', 4096);
  const protectedPaths = protectedValues.map((item, index) => canonicalPath(item, `liveSnapshot.protectedPaths.${index}`).pathKey);
  const entries = arrayData(snapshot.entries, 'liveSnapshot.entries').map((entryValue, index) => {
    const field = `liveSnapshot.entries.${index}`;
    const entry = data(entryValue, new Set([
      'path', 'pathKey', 'type', 'sha256', 'size', 'origin', 'modId', 'runtimeCompatible'
    ]), field);
    const normalized = canonicalPath(entry.path, `${field}.path`);
    if (entry.pathKey !== normalized.pathKey || !['file', 'directory'].includes(entry.type)) invalid(field);
    if (entry.origin !== undefined && entry.origin !== 'user') invalid(`${field}.origin`);
    if (entry.modId !== undefined && (typeof entry.modId !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(entry.modId))) invalid(`${field}.modId`);
    if (entry.runtimeCompatible !== undefined && typeof entry.runtimeCompatible !== 'boolean') invalid(`${field}.runtimeCompatible`);
    if (entry.type === 'directory' && (entry.sha256 !== null || entry.size !== '0')) invalid(field);
    if (entry.type === 'directory' && (entry.modId !== undefined || entry.runtimeCompatible !== undefined)) invalid(field);
    return {
      ...normalized, type: entry.type,
      sha256: entry.type === 'file' ? digest(entry.sha256, `${field}.sha256`) : null,
      size: decimal(entry.size, `${field}.size`),
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
      ...(entry.modId === undefined ? {} : { modId: entry.modId }),
      ...(entry.runtimeCompatible === undefined ? {} : { runtimeCompatible: entry.runtimeCompatible })
    };
  }).sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  if (new Set(entries.map(entry => entry.pathKey)).size !== entries.length || new Set(worlds).size !== worlds.length ||
      new Set(protectedPaths).size !== protectedPaths.length) invalid('liveSnapshot');
  return { kind: snapshot.kind, worldDirectories: worlds, protectedPaths, entries };
}

function normalizeChoices(value) {
  if (value === undefined) return { paths: new Map(), categories: new Map() };
  const choices = data(value, new Set(['paths', 'categories']), 'conflictChoices');
  const result = { paths: new Map(), categories: new Map() };
  if (choices.paths !== undefined) {
    const entries = descriptors(choices.paths, null, 'conflictChoices.paths');
    for (const [rawPath, descriptor] of Object.entries(entries)) {
      const normalized = canonicalPath(rawPath, `conflictChoices.paths.${rawPath}`);
      const choiceValue = data(descriptor.value, new Set(['choice', 'alternatePath']), `conflictChoices.paths.${rawPath}`);
      if (!CHOICES.has(choiceValue.choice)) invalid(`conflictChoices.paths.${rawPath}.choice`);
      if (choiceValue.choice === 'keep-both') {
        if (choiceValue.alternatePath === undefined) invalid(`conflictChoices.paths.${rawPath}.alternatePath`);
        choiceValue.alternatePath = canonicalPath(choiceValue.alternatePath, `conflictChoices.paths.${rawPath}.alternatePath`).path;
      } else if (choiceValue.alternatePath !== undefined) invalid(`conflictChoices.paths.${rawPath}.alternatePath`);
      if (result.paths.has(normalized.pathKey)) invalid('conflictChoices.paths');
      result.paths.set(normalized.pathKey, choiceValue);
    }
  }
  if (choices.categories !== undefined) {
    const entries = descriptors(choices.categories, null, 'conflictChoices.categories');
    for (const [role, descriptor] of Object.entries(entries)) {
      if (!ROLES.has(role) || !['keep-mine', 'use-pack'].includes(descriptor.value)) invalid(`conflictChoices.categories.${role}`);
      result.categories.set(role, descriptor.value);
    }
  }
  return result;
}

function choiceView(choices) {
  const paths = Object.fromEntries([...choices.paths.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([pathKey, decision]) => [pathKey, { ...decision }]));
  const categories = Object.fromEntries([...choices.categories.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US')));
  return deepFreeze({ paths, categories });
}

function pathIsProtected(pathKey, role, policy, worlds, protectedPaths = [], origin = null) {
  if (origin === 'application' || policy === 'protected' || policy === 'preserve-after-seed' || role === 'world' || role === 'secret' || role === 'application') return true;
  const worldRoots = new Set(['world', 'world_nether', 'world_the_end', ...worlds]);
  if ([...worldRoots].some(world => pathKey === world || pathKey.startsWith(`${world}/`))) return true;
  if (protectedPaths.some(candidate => pathKey === candidate || pathKey.startsWith(`${candidate}/`))) return true;
  if (['server.properties', 'ops.json', 'whitelist.json', 'banned-ips.json', 'banned-players.json', 'usercache.json', 'server-icon.png'].includes(pathKey)) return true;
  if (['user_jvm_args.txt', 'jvm_args.txt', 'config/jvm.args', 'config/jvm-args.txt'].includes(pathKey)) return true;
  if (['backups', 'logs', 'crash-reports', 'certificates', 'secrets'].some(root => pathKey === root || pathKey.startsWith(`${root}/`))) return true;
  return /^(?:start|launch|run)(?:-[^/]*)?\.(?:bat|cmd|ps1|sh)$/.test(pathKey);
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function findLiveFileAncestor(pathKey, liveByPath) {
  const parts = pathKey.split('/');
  let prefix = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
    const candidate = liveByPath.get(prefix);
    if (candidate?.type === 'file') return candidate;
  }
  return null;
}

function hasLiveDescendant(pathKey, sortedLiveKeys) {
  const prefix = `${pathKey}/`;
  let low = 0;
  let high = sortedLiveKeys.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedLiveKeys[middle] < prefix) low = middle + 1;
    else high = middle;
  }
  return sortedLiveKeys[low]?.startsWith(prefix) === true;
}

function applyChoice(action, choices, occupied, consumedPaths, consumedCategories, sources) {
  const specific = choices.paths.get(action.pathKey);
  if (action.action === 'incompatible-user-addon') {
    if (!specific) return action;
    if (!['disable-addon', 'remove-addon'].includes(specific.choice)) invalid('conflictChoices.paths');
    consumedPaths.add(action.pathKey);
    return {
      ...action,
      action: specific.choice === 'disable-addon' ? 'disable-user-addon' : 'remove-user-addon',
      reason: `user-choice-${specific.choice}`
    };
  }
  if (action.action !== 'conflict') return action;
  if (['file-ancestor-collision', 'file-descendant-collision'].includes(action.reason) &&
      (specific || choices.categories.has(action.role))) invalid('conflictChoices');
  const bulk = action.protected || action.role === 'world' || action.role === 'secret' ? null : choices.categories.get(action.role);
  const chosen = specific?.choice || bulk;
  if (!chosen) return action;
  if (!['keep-mine', 'use-pack', 'keep-both'].includes(chosen)) invalid('conflictChoices.paths');
  if (specific) consumedPaths.add(action.pathKey);
  else consumedCategories.add(action.role);
  if (chosen === 'keep-mine') {
    return {
      ...action,
      action: sources.live ? (sources.incoming ? 'preserve-modified' : 'preserve-orphan') : 'absent',
      reason: 'user-choice-keep-mine'
    };
  }
  if (chosen === 'use-pack') {
    return {
      ...action,
      action: !sources.incoming ? 'remove' : !sources.live ? (sources.old ? 'restore-missing' : 'add') : 'replace',
      reason: 'user-choice-use-pack'
    };
  }
  if (!sources.live || !sources.incoming) invalid('conflictChoices.paths');
  const alternate = canonicalPath(specific.alternatePath, `conflictChoices.paths.${action.path}.alternatePath`);
  if (action.role === 'world' || action.role === 'secret' || path.posix.dirname(alternate.pathKey) !== path.posix.dirname(action.pathKey) ||
      isReserved(alternate.pathKey) || isEula(alternate.pathKey) || pathIsProtected(alternate.pathKey, action.role, 'replaceable-managed', []) ||
      [...occupied].some(candidate => pathsOverlap(candidate, alternate.pathKey))) invalid('conflictChoices.paths');
  const originalExtension = path.posix.extname(action.pathKey);
  if (originalExtension && path.posix.extname(alternate.pathKey) !== originalExtension) invalid('conflictChoices.paths');
  occupied.add(alternate.pathKey);
  return { ...action, action: 'keep-both', reason: 'user-choice-keep-both', incomingPath: alternate.path };
}

function planOwnership({ oldManifest, liveSnapshot, incomingManifest, conflictChoices, operationKind = null } = {}) {
  if (operationKind !== null && operationKind !== 'repair') invalid('operationKind');
  const targetedRepair = operationKind === 'repair';
  const oldState = normalizeOwnershipManifest(oldManifest, { allowNull: true });
  const liveState = normalizeLiveSnapshot(liveSnapshot);
  const incomingState = normalizeIncomingManifest(incomingManifest);
  const choices = normalizeChoices(conflictChoices || {});
  const oldByPath = new Map((oldState?.entries || []).map(entry => [entry.pathKey, entry]));
  const liveByPath = new Map(liveState.entries.map(entry => [entry.pathKey, entry]));
  const livePathKeys = liveState.entries.map(entry => entry.pathKey).sort();
  const incomingByPath = new Map(incomingState.entries.map(entry => [entry.pathKey, entry]));
  const incomingModIds = new Set(incomingState.entries.map(entry => entry.modId).filter(Boolean));
  const keys = [...new Set([...oldByPath.keys(), ...liveByPath.keys(), ...incomingByPath.keys()])].sort((a, b) => a.localeCompare(b, 'en-US'));
  const occupied = new Set(keys);
  const consumedPaths = new Set();
  const consumedCategories = new Set();
  const actions = [];

  for (const pathKey of keys) {
    const oldEntry = oldByPath.get(pathKey);
    const liveEntry = liveByPath.get(pathKey);
    const incomingEntry = incomingByPath.get(pathKey);
    const liveFileAncestor = incomingEntry && findLiveFileAncestor(pathKey, liveByPath);
    const liveDescendant = incomingEntry && !liveEntry && hasLiveDescendant(pathKey, livePathKeys);
    const pathValue = incomingEntry?.path || liveEntry?.path || oldEntry.path;
    if (targetedRepair && oldEntry) {
      const managedRepairTarget = ['pack', 'runtime'].includes(oldEntry.origin) &&
        oldEntry.managementPolicy === 'replaceable-managed';
      if (managedRepairTarget) {
        if (!incomingEntry || incomingEntry.installedHash !== oldEntry.installedHash ||
            incomingEntry.origin !== oldEntry.origin || incomingEntry.managementPolicy !== oldEntry.managementPolicy) {
          invalid('incomingManifest');
        }
        const action = !liveEntry
          ? { action: 'restore-missing', reason: 'managed-file-missing' }
          : liveEntry.type !== 'file'
            ? { action: 'conflict', reason: 'managed-path-type-changed' }
            : liveEntry.sha256 === oldEntry.installedHash
              ? { action: 'unchanged', reason: 'live-equals-installed-baseline' }
              : { action: 'replace', reason: 'managed-file-corrupt' };
        actions.push({ path: pathValue, pathKey, ...action, role: oldEntry.role, protected: false });
        continue;
      }
      const action = !liveEntry
        ? { action: 'absent', reason: 'user-content-absent' }
        : liveEntry.type === 'file' && liveEntry.sha256 === oldEntry.installedHash
          ? { action: 'unchanged', reason: 'user-content-unchanged' }
          : { action: 'preserve-modified', reason: 'user-content-preserved' };
      actions.push({ path: pathValue, pathKey, ...action, role: oldEntry.role, protected: true });
      continue;
    }
    if (targetedRepair && incomingEntry && !oldEntry) invalid('incomingManifest');
    if (incomingEntry?.ignoredEula || isEula(pathKey)) {
      actions.push({ path: pathValue, pathKey, action: 'ignore-eula', reason: 'explicit-eula-only', role: 'configuration', protected: true });
      continue;
    }
    if (!oldEntry && !incomingEntry) {
      const incompatible = liveEntry.runtimeCompatible === false || (liveEntry.modId && incomingModIds.has(liveEntry.modId));
      const userAddon = { path: pathValue, pathKey, action: incompatible ? 'incompatible-user-addon' : 'preserve-user-addon',
        reason: incompatible ? 'mod-or-runtime-conflict' : 'user-addon', role: liveEntry.modId ? 'mod' : 'other', protected: false };
      actions.push(applyChoice(userAddon, choices, occupied, consumedPaths, consumedCategories,
        { old: false, live: true, incoming: false }));
      continue;
    }
    const role = oldEntry?.role === 'world' || oldEntry?.role === 'secret' || oldEntry?.role === 'application'
      ? oldEntry.role
      : (incomingEntry?.role || oldEntry?.role || 'other');
    const oldProtected = oldEntry && pathIsProtected(pathKey, oldEntry.role, oldEntry.managementPolicy,
      liveState.worldDirectories, liveState.protectedPaths, oldEntry.origin);
    const incomingProtected = incomingEntry && pathIsProtected(pathKey, incomingEntry.role, incomingEntry.managementPolicy,
      liveState.worldDirectories, liveState.protectedPaths, incomingEntry.origin);
    const protectedPath = Boolean(oldProtected || incomingProtected || pathIsProtected(pathKey, role, 'replaceable-managed',
      liveState.worldDirectories, liveState.protectedPaths));
    let action;
    if (incomingEntry?.managementPolicy === 'ignored-rejected') {
      action = { action: 'ignore-rejected', reason: 'incoming-policy-ignored' };
    } else if (incomingEntry && liveEntry?.type === 'directory') {
      action = { action: 'conflict', reason: 'managed-path-type-changed' };
    } else if (liveFileAncestor) {
      action = { action: 'conflict', reason: 'file-ancestor-collision' };
    } else if (liveDescendant) {
      action = { action: 'conflict', reason: 'file-descendant-collision' };
    } else if (!oldEntry) {
      if (!liveEntry) {
        action = protectedPath
          ? (liveState.kind === 'new' ? { action: 'seed-protected', reason: 'new-server-seed' } : { action: 'conflict', reason: 'protected-existing-server' })
          : { action: 'add', reason: 'new-incoming' };
      } else {
        action = { action: 'conflict', reason: protectedPath ? 'protected-collision' : 'user-path-collision' };
      }
    } else if (!incomingEntry) {
      if (!liveEntry) action = { action: 'absent', reason: 'already-removed' };
      else if (protectedPath) action = { action: 'conflict', reason: 'protected-incoming-removed' };
      else if (liveEntry.type === 'file' && liveEntry.sha256 === oldEntry.installedHash) action = { action: 'remove', reason: 'incoming-removed' };
      else action = { action: 'preserve-orphan', reason: 'modified-managed-removed-upstream' };
    } else if (!liveEntry) {
      action = protectedPath
        ? { action: 'conflict', reason: 'protected-user-removed' }
        : { action: 'restore-missing', reason: 'managed-file-missing' };
    } else {
      const liveEqualsOld = liveEntry.type === 'file' && liveEntry.sha256 === oldEntry.installedHash;
      const incomingEqualsOld = incomingEntry.installedHash === oldEntry.installedHash;
      const liveEqualsIncoming = liveEntry.type === 'file' && liveEntry.sha256 === incomingEntry.installedHash;
      if (protectedPath && !liveEqualsIncoming) action = { action: 'conflict', reason: 'protected-managed-path' };
      else if (liveEqualsIncoming) action = { action: 'unchanged', reason: 'live-equals-incoming' };
      else if (liveEqualsOld && !incomingEqualsOld) action = { action: 'replace', reason: 'clean-managed-update' };
      else if (!liveEqualsOld && incomingEqualsOld) action = { action: 'preserve-modified', reason: 'user-modified' };
      else action = { action: 'conflict', reason: 'both-changed' };
    }
    actions.push(applyChoice({ path: pathValue, pathKey, ...action, role, protected: protectedPath }, choices, occupied,
      consumedPaths, consumedCategories, { old: Boolean(oldEntry), live: Boolean(liveEntry), incoming: Boolean(incomingEntry) }));
  }

  if ([...choices.paths.keys()].some(key => !consumedPaths.has(key))) invalid('conflictChoices.paths');
  if ([...choices.categories.keys()].some(role => !consumedCategories.has(role))) invalid('conflictChoices.categories');
  const freezeList = predicate => deepFreeze(actions.filter(predicate).map(action => ({ ...action })));
  const preserved = freezeList(action => ['unchanged', 'preserve-modified', 'preserve-orphan', 'preserve-user-addon', 'ignore-eula', 'ignore-rejected', 'absent'].includes(action.action));
  const removed = freezeList(action => ['remove', 'remove-user-addon'].includes(action.action));
  const preservedRoles = [...new Set(preserved.map(action => action.role))].sort((left, right) => left.localeCompare(right, 'en-US'));
  const plan = deepFreeze({
    type: 'ownership-plan', schemaVersion: 1,
    actions: actions.map(action => deepFreeze({ ...action })),
    added: freezeList(action => ['add', 'seed-protected', 'restore-missing'].includes(action.action)),
    changed: freezeList(action => ['replace', 'keep-both', 'disable-user-addon'].includes(action.action)),
    removed,
    preserved,
    conflicts: freezeList(action => action.action === 'conflict'),
    orphaned: freezeList(action => action.action === 'preserve-orphan'),
    userAddons: freezeList(action => ['preserve-user-addon', 'incompatible-user-addon', 'disable-user-addon', 'remove-user-addon'].includes(action.action)),
    blocked: freezeList(action => ['conflict', 'incompatible-user-addon'].includes(action.action)),
    confirmation: deepFreeze({
      unchangedManagedRemovalCount: String(actions.filter(action => action.action === 'remove').length),
      preservedCategories: preservedRoles,
      possibleNonRunnable: actions.some(action => ['remove', 'remove-user-addon', 'disable-user-addon'].includes(action.action) &&
        ['runtime', 'server', 'library', 'mod'].includes(action.role)),
      instanceRetained: true,
      worldsRetained: !actions.some(action => action.role === 'world' && ['replace', 'remove'].includes(action.action))
    })
  });
  APP_ISSUED_OWNERSHIP_PLANS.add(plan);
  APP_ISSUED_OWNERSHIP_DECISIONS.set(plan, choiceView(choices));
  return plan;
}

function isAppIssuedOwnershipPlan(value) {
  return Boolean(value) && typeof value === 'object' && APP_ISSUED_OWNERSHIP_PLANS.has(value);
}

function getAppIssuedOwnershipDecisions(value) {
  return APP_ISSUED_OWNERSHIP_DECISIONS.get(value) || null;
}

function normalizeSourceIdentity(value, field) {
  const source = data(value, new Set(['provider', 'projectId', 'repositoryId', 'title']), field);
  if (!['modrinth', 'github', 'local'].includes(source.provider)) invalid(`${field}.provider`);
  if (source.title !== undefined && (typeof source.title !== 'string' || source.title.length < 1 || source.title.length > 128 ||
      /https?:|[\\/]/i.test(source.title) || [...source.title].some(character => character.charCodeAt(0) <= 0x1f))) invalid(`${field}.title`);
  if (source.provider === 'modrinth') {
    if (source.repositoryId !== undefined) invalid(`${field}.repositoryId`);
    return { provider: 'modrinth', id: identifier(source.projectId, `${field}.projectId`) };
  }
  if (source.provider === 'github') {
    if (source.projectId !== undefined || typeof source.repositoryId !== 'string' || !/^[1-9][0-9]{0,29}$/.test(source.repositoryId)) invalid(`${field}.repositoryId`);
    return { provider: 'github', id: source.repositoryId };
  }
  if (source.projectId !== undefined || source.repositoryId !== undefined) invalid(field);
  return { provider: 'local', id: null };
}

function planCrossProviderIdentity(left, right, acceptedMappings) {
  const leftIdentity = normalizeSourceIdentity(left, 'left');
  const rightIdentity = normalizeSourceIdentity(right, 'right');
  const mappingValues = arrayData(acceptedMappings, 'acceptedMappings', 1024);
  const modrinth = leftIdentity.provider === 'modrinth' ? leftIdentity : rightIdentity.provider === 'modrinth' ? rightIdentity : null;
  const github = leftIdentity.provider === 'github' ? leftIdentity : rightIdentity.provider === 'github' ? rightIdentity : null;
  let matched = false;
  for (let index = 0; index < mappingValues.length; index += 1) {
    const mapping = data(mappingValues[index], new Set([
      'type', 'version', 'modrinthProjectId', 'githubRepositoryId', 'githubOwner', 'githubRepo'
    ]), `acceptedMappings.${index}`);
    if (mapping.type !== 'provider-source-mapping' || mapping.version !== 1 ||
        identifier(mapping.modrinthProjectId, `acceptedMappings.${index}.modrinthProjectId`) !== mapping.modrinthProjectId ||
        typeof mapping.githubRepositoryId !== 'string' || !/^[1-9][0-9]*$/.test(mapping.githubRepositoryId) ||
        typeof mapping.githubOwner !== 'string' || typeof mapping.githubRepo !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,100}$/.test(mapping.githubOwner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(mapping.githubRepo)) invalid(`acceptedMappings.${index}`);
    if (modrinth && github && mapping.modrinthProjectId === modrinth.id && mapping.githubRepositoryId === github.id) matched = true;
  }
  if (leftIdentity.provider === rightIdentity.provider) {
    return leftIdentity.id !== null && leftIdentity.id === rightIdentity.id ? 'same' : 'distinct';
  }
  return matched ? 'same' : 'distinct';
}

module.exports = {
  ORIGINS,
  POLICIES,
  canonicalPath,
  getAppIssuedOwnershipDecisions,
  isAppIssuedOwnershipPlan,
  normalizeOwnershipManifest,
  planCrossProviderIdentity,
  planOwnership
};
