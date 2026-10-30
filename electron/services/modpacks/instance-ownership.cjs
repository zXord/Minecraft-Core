const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

// The one ownership predicate (Tier A). A folder is 'unmanaged' only when it is
// an existing directory (alias-following stat) and every lifecycle evidence
// entry is proven absent with lstat ENOENT. v26.6.1 never creates any of these
// entries, so every folder it knows keeps exact v26.6.1 behaviour. Anything
// present gives 'lifecycle'; anything that cannot be proven gives 'unknown'.
// Both of those select the strict path. Folder shapes are never refused here,
// and nothing is cached or written.
const SERVER_STATE_DIRECTORY = '.minecraft-core-state';
const SERVER_EVIDENCE_ENTRIES = Object.freeze(['modpack.json', 'manifests', 'operations', 'history']);
const CLIENT_PACK_MANIFEST = '.minecraft-core-client-pack.json';
const EVIDENCE_KINDS = Object.freeze(['server', 'client']);
const EVIDENCE_ENTRIES_BY_KIND = Object.freeze({
  server: Object.freeze(SERVER_EVIDENCE_ENTRIES.map(entry => `${SERVER_STATE_DIRECTORY}/${entry}`)),
  client: Object.freeze([CLIENT_PACK_MANIFEST])
});

function isProbeableFolder(folder) {
  return typeof folder === 'string' && folder.length > 0 && !folder.includes('\0') && path.isAbsolute(folder);
}

function errorCodeOf(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'UNKNOWN';
}

function entrySegments(relativeEntry) {
  if (typeof relativeEntry !== 'string' || relativeEntry.length === 0 || relativeEntry.includes('\0') ||
      path.isAbsolute(relativeEntry)) return null;
  const segments = relativeEntry.split(/[\\/]/u);
  return segments.some(segment => segment === '' || segment === '.' || segment === '..') ? null : segments;
}

function normalizeRelativeEntries(relativeEntries) {
  const normalized = Array.isArray(relativeEntries) && relativeEntries.length > 0
    ? relativeEntries.map(entrySegments)
    : [null];
  if (normalized.includes(null)) {
    throw new TypeError('relativeEntries must be a non-empty list of paths inside the folder');
  }
  return normalized;
}

function evidenceEntriesFor(kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some(kind => !EVIDENCE_KINDS.includes(kind))) {
    throw new TypeError("kinds must list 'server' and/or 'client'");
  }
  return EVIDENCE_KINDS.filter(kind => kinds.includes(kind)).flatMap(kind => EVIDENCE_ENTRIES_BY_KIND[kind]);
}

function assertSyncFs(fsApi) {
  if (!fsApi || typeof fsApi.statSync !== 'function' || typeof fsApi.lstatSync !== 'function') {
    throw new TypeError('fsApi must provide statSync and lstatSync');
  }
}

function assertAsyncFs(fsApi) {
  if (!fsApi || typeof fsApi.stat !== 'function' || typeof fsApi.lstat !== 'function') {
    throw new TypeError('fsPromises must provide stat and lstat');
  }
}

// Returns the folder failure code, or the relative entries that exist plus the
// first lstat failure other than ENOENT.
function probeEntries(folder, entries, fsApi) {
  if (!isProbeableFolder(folder)) return { folderErrorCode: 'EINVAL' };
  try {
    if (!fsApi.statSync(folder)?.isDirectory?.()) return { folderErrorCode: 'ENOTDIR' };
  } catch (error) {
    return { folderErrorCode: errorCodeOf(error) };
  }
  const present = [];
  let entryErrorCode = null;
  for (const { label, segments } of entries) {
    try {
      fsApi.lstatSync(path.join(folder, ...segments));
      present.push(label);
    } catch (error) {
      if (error?.code !== 'ENOENT' && entryErrorCode === null) entryErrorCode = errorCodeOf(error);
    }
  }
  return { folderErrorCode: null, present, entryErrorCode };
}

function folderEvidence(state, evidence, errorCode) {
  return Object.freeze({ state, evidence: Object.freeze([...evidence]), errorCode });
}

/**
 * Classifies a folder by its on-disk modpack lifecycle evidence.
 * @param {string} folder absolute instance folder, evaluated under its own spelling
 * @param {{fsApi?: object, kinds?: Array<'server'|'client'>}} [options]
 * @returns {{state: 'unmanaged'|'lifecycle'|'unknown', evidence: string[], errorCode: string|null}}
 *   evidence lists the present entries relative to the folder ('/' separated);
 *   errorCode is set only for 'unknown'.
 */
function inspectFolderEvidence(folder, { fsApi = fs, kinds = EVIDENCE_KINDS } = {}) {
  assertSyncFs(fsApi);
  const entries = evidenceEntriesFor(kinds).map(label => ({ label, segments: label.split('/') }));
  const { folderErrorCode, present, entryErrorCode } = probeEntries(folder, entries, fsApi);
  if (folderErrorCode !== null) return folderEvidence('unknown', [], folderErrorCode);
  if (present.length > 0) return folderEvidence('lifecycle', present, null);
  if (entryErrorCode !== null) return folderEvidence('unknown', [], entryErrorCode);
  return folderEvidence('unmanaged', [], null);
}

/**
 * True only for an existing directory (alias-following stat) whose listed
 * entries all give lstat ENOENT. Entries are relative paths, '/' or '\' separated.
 */
function proveEntriesAbsent(folder, relativeEntries, { fsApi = fs } = {}) {
  assertSyncFs(fsApi);
  const entries = normalizeRelativeEntries(relativeEntries).map(segments => ({ label: segments.join('/'), segments }));
  const { folderErrorCode, present, entryErrorCode } = probeEntries(folder, entries, fsApi);
  return folderErrorCode === null && present.length === 0 && entryErrorCode === null;
}

async function proveEntriesAbsentAsync(folder, relativeEntries, { fsPromises: fsApi = fsPromises } = {}) {
  assertAsyncFs(fsApi);
  const entries = normalizeRelativeEntries(relativeEntries);
  if (!isProbeableFolder(folder)) return false;
  try {
    if (!(await fsApi.stat(folder))?.isDirectory?.()) return false;
  } catch {
    return false;
  }
  for (const segments of entries) {
    try {
      await fsApi.lstat(path.join(folder, ...segments));
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
  }
  return true;
}

module.exports = {
  CLIENT_PACK_MANIFEST,
  EVIDENCE_ENTRIES_BY_KIND,
  SERVER_EVIDENCE_ENTRIES,
  SERVER_STATE_DIRECTORY,
  inspectFolderEvidence,
  proveEntriesAbsent,
  proveEntriesAbsentAsync
};
