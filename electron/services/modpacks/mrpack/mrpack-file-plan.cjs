const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const {
  MRPACK_DOWNLOAD_HOSTS,
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
    const record = typeof source === 'string' ? { path: source, type: 'file' } : source;
    if (!record || typeof record !== 'object' || Array.isArray(record)) unsafeEntry('non-regular-entry');
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

function selectedOptionAliases(manifest, selection) {
  const optional = new Map(manifest.files
    .filter(file => file.env.server === 'optional')
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

function overrideOperations(entries) {
  const operations = [];
  const aliasesByLayer = new Map([['overrides', new Set()], ['server-overrides', new Set()]]);
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const slash = entry.path.indexOf('/');
    if (slash < 0) continue;
    const prefix = entry.path.slice(0, slash).toLocaleLowerCase('en-US');
    if (prefix !== 'overrides' && prefix !== 'server-overrides') continue;
    const targetSource = entry.path.slice(slash + 1);
    let targetPath;
    try { targetPath = normalizeMrpackPath(targetSource); }
    catch { unsafeEntry(); }
    const alias = canonicalWindowsPath(targetPath);
    const aliases = aliasesByLayer.get(prefix);
    if (aliases.has(alias)) entryCollision();
    aliases.add(alias);
    operations.push({
      layer: prefix,
      order: prefix === 'overrides' ? 1 : 2,
      archivePath: entry.path,
      targetPath,
      ...(entry.size === undefined ? {} : { size: entry.size })
    });
  }
  operations.sort((left, right) => left.order - right.order || canonicalWindowsPath(left.archivePath).localeCompare(canonicalWindowsPath(right.archivePath), 'en-US'));
  return operations;
}

function buildMrpackServerPlan({ manifest: sourceManifest, selectedOptionalFiles, archiveEntries = [] } = {}) {
  const manifest = ensureValidatedMrpackManifest(sourceManifest);
  const selected = selectedOptionAliases(manifest, selectedOptionalFiles);
  const downloads = [];
  for (const file of manifest.files) {
    if (file.env.server === 'unsupported') continue;
    const optional = file.env.server === 'optional';
    const isSelected = !optional || selected === null || selected.has(canonicalWindowsPath(file.path));
    downloads.push({
      partId: `file-${file.hashes.sha1}`,
      targetPath: file.path,
      optional,
      selected: isSelected,
      downloadUrl: file.downloads[0],
      allowedHosts: [...MRPACK_DOWNLOAD_HOSTS],
      allowSubdomains: false,
      size: file.fileSize,
      provider: 'modrinth',
      providerDigest: { algorithm: 'sha512', value: file.hashes.sha512 },
      requiredProviderDigests: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 }
    });
  }

  const entries = normalizeArchiveEntries(archiveEntries);
  const operations = overrideOperations(entries);
  if (!downloads.some(download => download.selected) && operations.length === 0) {
    throw new ModpackError('CLIENT_ONLY_PACK', 'Modrinth pack has no supported server content');
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

  return deepFreeze({
    type: 'mrpack-server-plan',
    manifestVersionId: manifest.versionId,
    runtime: runtimeFromDependencies(manifest.dependencies),
    downloads,
    layers: [
      { name: 'downloads', order: 0 },
      { name: 'overrides', order: 1 },
      { name: 'server-overrides', order: 2 }
    ],
    overrideOperations: operations,
    finalOverrides
  });
}

module.exports = { buildMrpackServerPlan };
