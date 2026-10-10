const crypto = require('node:crypto');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const {
  getMrpackDownloadHosts,
  canonicalWindowsPath,
  ensureValidatedMrpackManifest,
  normalizeMrpackPath,
} = require('./mrpack-schema.cjs');

function invalidRequest(field = 'selectedOptionalFiles') {
  throw new ModpackError('INVALID_REQUEST', 'Modrinth pack selection is invalid', { details: { field } });
}

function unsafeEntry(reasonCode = 'path-traversal') {
  throw new ModpackError('UNSAFE_ARCHIVE_ENTRY', 'Pack archive entry is unsafe', { details: { reasonCode } });
}

function entryCollision(reasonCode = 'normalized-path-collision') {
  throw new ModpackError('ARCHIVE_ENTRY_COLLISION', 'Pack archive entries conflict', { details: { reasonCode } });
}

function safeArchivePath(value, type) {
  const candidate = type === 'directory' && typeof value === 'string' ? value.replace(/[\\/]+$/, '') : value;
  try { return normalizeMrpackPath(candidate, { rejectState: false }); }
  catch { unsafeEntry(); }
}

function normalizeArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length > ARCHIVE_LIMITS.maxArchiveEntries) invalidRequest('archiveEntries');
  const normalized = [];
  for (const source of entries) {
    const record = source;
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) unsafeEntry('non-regular-entry');
    if (record.type !== 'file' && record.type !== 'directory') unsafeEntry('non-regular-entry');
    if (Object.keys(record).some(key => !['path', 'type', 'size'].includes(key))) unsafeEntry('non-regular-entry');
    if (record.size !== undefined && (!Number.isSafeInteger(record.size) || record.size < 0)) unsafeEntry('non-regular-entry');
    normalized.push({
      path: safeArchivePath(record.path, record.type),
      type: record.type,
      ...(record.size === undefined ? {} : { size: String(record.size) })
    });
  }

  const byAlias = new Map();
  for (const entry of normalized) {
    const alias = canonicalWindowsPath(entry.path);
    if (byAlias.has(alias)) entryCollision();
    const segments = alias.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = byAlias.get(segments.slice(0, length).join('/'));
      if (ancestor?.type === 'file') entryCollision('file-directory-collision');
    }
    if (entry.type === 'file') {
      for (const existing of byAlias.keys()) if (existing.startsWith(`${alias}/`)) entryCollision('file-directory-collision');
    }
    byAlias.set(alias, entry);
  }
  return normalized;
}

function runtimeFromDependencies(dependencies) {
  const loader = Object.keys(dependencies).find(key => key !== 'minecraft');
  if (!loader) return { minecraftVersion: dependencies.minecraft, loaderFamily: 'vanilla', loaderVersion: dependencies.minecraft };
  const loaderFamily = loader === 'fabric-loader' ? 'fabric' : loader === 'quilt-loader' ? 'quilt' : loader;
  return { minecraftVersion: dependencies.minecraft, loaderFamily, loaderVersion: dependencies[loader] };
}

function downloadPartId(file) {
  const targetIdentity = crypto.createHash('sha256')
    .update(file.hashes.sha1, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalWindowsPath(file.path), 'utf8')
    .digest('hex');
  return `file-${file.hashes.sha1}-${targetIdentity}`;
}

function optionalFileChoiceId(file) {
  const identity = crypto.createHash('sha256')
    .update(canonicalWindowsPath(file.path), 'utf8')
    .update('\0', 'utf8')
    .update(file.hashes.sha512, 'utf8')
    .digest('hex')
    .slice(0, 48);
  return `optional-${identity}`;
}

function optionalFileRecords(sourceManifest, side = 'server') {
  const manifest = ensureValidatedMrpackManifest(sourceManifest);
  return manifest.files
    .filter(file => file.env[side] === 'optional')
    .map(file => ({ id: optionalFileChoiceId(file), path: file.path }))
    .sort((left, right) => canonicalWindowsPath(left.path).localeCompare(canonicalWindowsPath(right.path), 'en-US'));
}

function listOptionalChoices(sourceManifest, side) {
  return deepFreeze(optionalFileRecords(sourceManifest, side).map(record => ({
    id: record.id,
    label: record.path,
    defaultSelected: true
  })));
}

function resolveOptionalChoices(sourceManifest, choiceIds, side) {
  if (!Array.isArray(choiceIds)) invalidRequest('optionalFileIds');
  const byId = new Map(optionalFileRecords(sourceManifest, side).map(record => [record.id, record]));
  const selected = new Set();
  for (const choiceId of choiceIds) {
    if (typeof choiceId !== 'string' || selected.has(choiceId) || !byId.has(choiceId)) invalidRequest('optionalFileIds');
    selected.add(choiceId);
  }
  return [...byId.values()].filter(record => selected.has(record.id)).map(record => record.path);
}

function selectedOptionAliases(manifest, selection, side) {
  const optional = new Map(manifest.files
    .filter(file => file.env[side] === 'optional')
    .map(file => [canonicalWindowsPath(file.path), file.path]));
  if (selection === undefined) return null;
  if (!Array.isArray(selection)) invalidRequest();
  const result = new Set();
  for (const path of selection) {
    let normalized;
    try { normalized = normalizeMrpackPath(path); }
    catch { invalidRequest(); }
    const alias = canonicalWindowsPath(normalized);
    if (!optional.has(alias) || result.has(alias)) invalidRequest();
    result.add(alias);
  }
  return result;
}

function projectedArchiveOperations(entries, side) {
  const files = [];
  const directories = [];
  const sideLayer = `${side}-overrides`;
  const aliasesByLayer = new Map([['overrides', new Set()], [sideLayer, new Set()]]);
  for (const entry of entries) {
    const slash = entry.path.indexOf('/');
    if (slash < 0) continue;
    const prefix = entry.path.slice(0, slash).toLocaleLowerCase('en-US');
    if (prefix !== 'overrides' && prefix !== sideLayer) continue;
    const targetSource = entry.path.slice(slash + 1);
    let targetPath;
    try { targetPath = normalizeMrpackPath(targetSource); }
    catch { unsafeEntry(); }
    const alias = canonicalWindowsPath(targetPath);
    const aliases = aliasesByLayer.get(prefix);
    if (aliases.has(alias)) entryCollision();
    aliases.add(alias);
    const operation = {
      layer: prefix,
      order: prefix === 'overrides' ? 1 : 2,
      archivePath: entry.path,
      targetPath,
      ...(entry.size === undefined ? {} : { size: entry.size })
    };
    if (entry.type === 'file') files.push(operation);
    else directories.push(operation);
  }
  const sorter = (left, right) => left.order - right.order || canonicalWindowsPath(left.archivePath).localeCompare(canonicalWindowsPath(right.archivePath), 'en-US');
  files.sort(sorter);
  directories.sort(sorter);
  return { files, directories };
}

function validateProjectedTargets(downloads, files, directories) {
  const nodes = new Map();
  const projected = [
    ...downloads.filter(download => download.selected).map(download => ({ type: 'file', order: 0, targetPath: download.targetPath })),
    ...files.map(file => ({ type: 'file', order: file.order, targetPath: file.targetPath })),
    ...directories.map(directory => ({ type: 'directory', order: directory.order, targetPath: directory.targetPath }))
  ].sort((left, right) => left.order - right.order || canonicalWindowsPath(left.targetPath).localeCompare(canonicalWindowsPath(right.targetPath), 'en-US') || left.type.localeCompare(right.type));

  for (const item of projected) {
    const alias = canonicalWindowsPath(item.targetPath);
    const current = nodes.get(alias);
    if (current) {
      if (current.type !== item.type) entryCollision('file-directory-collision');
      if (item.type === 'file') {
        if (item.order <= current.order) entryCollision();
        nodes.set(alias, item);
      }
      continue;
    }
    const segments = alias.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      if (nodes.get(segments.slice(0, length).join('/'))?.type === 'file') entryCollision('file-directory-collision');
    }
    if (item.type === 'file') {
      for (const [existingAlias] of nodes) if (existingAlias.startsWith(`${alias}/`)) entryCollision('file-directory-collision');
    }
    nodes.set(alias, item);
  }
}

function buildMrpackPlan({ manifest: sourceManifest, selectedOptionalFiles, archiveEntries = [] } = {}, side) {
  const manifest = ensureValidatedMrpackManifest(sourceManifest);
  const selected = selectedOptionAliases(manifest, selectedOptionalFiles, side);
  const pathPolicy = side === 'client' ? require('../../client-modpacks/client-content-policy.cjs').clientPathPolicy : null;
  const downloads = [];
  for (const file of manifest.files) {
    if (file.env[side] === 'unsupported') continue;
    if (pathPolicy) pathPolicy(file.path);
    const optional = file.env[side] === 'optional';
    const isSelected = !optional || selected === null || selected.has(canonicalWindowsPath(file.path));
    downloads.push({
      partId: downloadPartId(file),
      targetPath: file.path,
      optional,
      selected: isSelected,
      downloadUrl: file.downloads[0],
      downloadUrlCandidates: [...file.downloads],
      allowedHosts: getMrpackDownloadHosts(file.downloads[0]),
      allowSubdomains: false,
      size: file.fileSize,
      provider: 'modrinth',
      providerDigest: { algorithm: 'sha512', value: file.hashes.sha512 },
      requiredProviderDigests: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 }
    });
  }

  const selectedBytes = downloads.reduce((total, download) => total + (download.selected ? BigInt(download.size) : 0n), 0n);
  if (selectedBytes > BigInt(ARCHIVE_LIMITS.maxArtifactSetBytes)) {
    throw new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Pack downloads exceeded the configured byte limit', {
      details: { limit: 'maxArtifactSetBytes', actual: selectedBytes.toString() }
    });
  }

  const entries = normalizeArchiveEntries(archiveEntries);
  const { files: operations, directories } = projectedArchiveOperations(entries, side);
  if (pathPolicy) for (const item of [...operations, ...directories]) pathPolicy(item.targetPath);
  validateProjectedTargets(downloads, operations, directories);
  if (!downloads.some(download => download.selected) && operations.length === 0) {
    throw new ModpackError(side === 'server' ? 'CLIENT_ONLY_PACK' : 'MANIFEST_INVALID', `Modrinth pack has no supported ${side} content`);
  }
  const finalByTarget = new Map();
  for (const operation of operations) finalByTarget.set(canonicalWindowsPath(operation.targetPath), operation);
  const finalOverrides = [...finalByTarget.values()]
    .sort((left, right) => canonicalWindowsPath(left.targetPath).localeCompare(canonicalWindowsPath(right.targetPath), 'en-US'))
    .map(operation => ({
      layer: operation.layer,
      archivePath: operation.archivePath,
      targetPath: operation.targetPath,
      ...(operation.size === undefined ? {} : { size: operation.size })
    }));
  const finalDirectories = [...new Set(directories.map(directory => canonicalWindowsPath(directory.targetPath)))]
    .sort((left, right) => left.localeCompare(right, 'en-US'))
    .map(targetPath => ({ targetPath }));

  return deepFreeze({
    type: `mrpack-${side}-plan`,
    manifestVersionId: manifest.versionId,
    runtime: runtimeFromDependencies(manifest.dependencies),
    downloads,
    layers: [
      { name: 'downloads', order: 0 },
      { name: 'overrides', order: 1 },
      { name: `${side}-overrides`, order: 2 }
    ],
    overrideOperations: operations,
    finalOverrides,
    finalDirectories
  });
}

const buildMrpackServerPlan = options => buildMrpackPlan(options, 'server');
const buildMrpackClientPlan = options => buildMrpackPlan(options, 'client');
const listOptionalFileChoices = manifest => listOptionalChoices(manifest, 'server');
const listOptionalClientFileChoices = manifest => listOptionalChoices(manifest, 'client');
const resolveOptionalFileChoiceIds = (manifest, ids) => resolveOptionalChoices(manifest, ids, 'server');
const resolveOptionalClientFileChoiceIds = (manifest, ids) => resolveOptionalChoices(manifest, ids, 'client');

module.exports = {
  buildMrpackServerPlan, listOptionalFileChoices, resolveOptionalFileChoiceIds,
  buildMrpackClientPlan, listOptionalClientFileChoices, resolveOptionalClientFileChoiceIds
};
