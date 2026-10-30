const defaultFsPromises = require('node:fs/promises');
const path = require('node:path');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { proveEntriesAbsentAsync } = require('../modpacks/instance-ownership.cjs');
const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { normalizeCompanionDescriptor } = require('./companion-contracts.cjs');
const { clientPathPolicy } = require('./client-content-policy.cjs');
const { normalizeRuntimeConstraints } = require('./client-runtime-constraints.cjs');
const MANIFEST_NAME = '.minecraft-core-client-pack.json';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
// Up to 100,000 entry objects (seven values each when preserved), 10,000
// optional IDs and bounded descriptor fields. Serialized writes remain 8 MiB.
const MANIFEST_JSON_VALUES = 1_000_000;
const fail = () => new ModpackError('RECOVERY_REQUIRED', 'Client ownership state could not be verified');
const SUBFOLDER_REQUIRED = 'Matching client packs need the client folder inside another normal folder. Move this client into a subfolder, then retry.';
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
}
function normalizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 100000) throw fail();
  const seen = new Set();
  return entries.map(entry => {
    if (!entry || Object.keys(entry).some(key => !['path', 'pathKey', 'sha256', 'size', 'policy', 'preserved'].includes(key)) ||
        typeof entry.path !== 'string' || entry.pathKey !== entry.path.toLowerCase() || seen.has(entry.pathKey) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^(0|[1-9][0-9]*)$/.test(entry.size) ||
        (entry.preserved !== undefined && typeof entry.preserved !== 'boolean') || clientPathPolicy(entry.path) !== entry.policy) throw fail();
    seen.add(entry.pathKey);
    return { path: entry.path, pathKey: entry.pathKey, sha256: entry.sha256, size: entry.size, policy: entry.policy, ...(entry.preserved === true ? { preserved: true } : {}) };
  }).sort((a, b) => a.pathKey.localeCompare(b.pathKey, 'en-US'));
}
function normalizeClientPackManifest(value) {
  const v = strictJsonClone(value, { maxCollection: MANIFEST_JSON_VALUES });
  if (v?.schemaVersion === 2) {
    try {
      if (Object.keys(v).sort().join(',') !== 'contentFormat,descriptor,entries,optionalFileIds,runtimeConstraints,schemaVersion' ||
          v.contentFormat !== 'multimc' || !Array.isArray(v.optionalFileIds) || v.optionalFileIds.length !== 0) throw fail();
      const descriptor = normalizeCompanionDescriptor(v.descriptor);
      if (descriptor.status !== 'ready' || descriptor.source.provider !== 'github') throw fail();
      return deepFreeze({ schemaVersion: 2, descriptor, optionalFileIds: [], entries: normalizeEntries(v.entries),
        contentFormat: 'multimc', runtimeConstraints: normalizeRuntimeConstraints(v.runtimeConstraints) });
    } catch (cause) { throw new ModpackError('RECOVERY_REQUIRED', 'Client ownership state could not be verified', { cause }); }
  }
  if (!v || Object.keys(v).sort().join(',') !== 'descriptor,entries,optionalFileIds,schemaVersion' || v.schemaVersion !== 1 ||
      !Array.isArray(v.optionalFileIds) || v.optionalFileIds.length > 10000 ||
      v.optionalFileIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,192}$/.test(id)) ||
      new Set(v.optionalFileIds).size !== v.optionalFileIds.length) throw fail();
  const descriptor = normalizeCompanionDescriptor(v.descriptor);
  if (descriptor.status !== 'ready') throw fail();
  return deepFreeze({ schemaVersion: 1, descriptor, optionalFileIds: [...v.optionalFileIds].sort(), entries: normalizeEntries(v.entries) });
}
function planOwnership(snapshot, oldManifest, nextEntries) {
  const old = new Map(normalizeEntries(oldManifest?.entries || []).map(e => [e.pathKey, e]));
  const next = new Map(normalizeEntries(nextEntries).map(e => [e.pathKey, e]));
  const current = new Map(snapshot.entries.map(e => [e.pathKey, e]));
  const result = { additions: [], removals: [], replacements: [], conflicts: [], preserved: [] };
  for (const key of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const before = old.get(key), after = next.get(key), live = current.get(key);
    const label = after?.path || before.path;
    if (live && (after?.policy === 'preserve-after-seed' || before?.policy === 'preserve-after-seed')) { result.preserved.push(label); continue; }
    if (!live) { if (after) result.additions.push(label); continue; }
    if (after && live.type === 'file' && live.sha256 === after.sha256) continue;
    if (before && live.type === 'file' && live.sha256 === before.sha256 && live.size === before.size && !before.preserved) {
      (after ? result.replacements : result.removals).push(label);
    } else {
      result.conflicts.push({ path: label, action: after ? 'replace' : 'remove', reason: before ? 'modified-owned' : 'unowned', replaceAllowed: live.type === 'file' });
    }
  }
  return deepFreeze(result);
}
class ClientPackStateStore {
  constructor({ durableFs, fsPromises = defaultFsPromises } = {}) {
    if (!durableFs || !fsPromises || typeof fsPromises.stat !== 'function' || typeof fsPromises.lstat !== 'function' ||
        typeof fsPromises.realpath !== 'function') throw fail();
    this.durableFs = durableFs;
    this.fsPromises = fsPromises;
  }
  async read(clientPath) {
    // A client folder that never held a matching pack has no manifest. Proving
    // that with stat and lstat needs no parent-scoped durable authority, which a
    // drive-root or aliased parent cannot have. Anything else stays strict.
    if (await proveEntriesAbsentAsync(clientPath, [MANIFEST_NAME], { fsPromises: this.fsPromises })) return null;
    try {
      const bytes = await this.durableFs.readFileBoundedAsync(path.join(clientPath, MANIFEST_NAME), { maxBytes: MAX_MANIFEST_BYTES, allowMissing: true });
      return bytes === null ? null : normalizeClientPackManifest(JSON.parse(bytes.toString('utf8')));
    } catch (cause) { throw new ModpackError('RECOVERY_REQUIRED', 'Client ownership state could not be verified', { cause }); }
  }
  // Publication stages candidate folders beside the client, so it needs durable
  // authority over the client's parent. Refuse up front, with advice the user
  // can act on, when the folder's shape is the reason that authority is missing.
  async assertPublishable(clientPath) {
    if (await this.#unsupportedShape(clientPath)) throw new ModpackError('CLIENT_PACK_UNAVAILABLE', SUBFOLDER_REQUIRED);
    try {
      await this.durableFs.readFileBoundedAsync(path.join(clientPath, MANIFEST_NAME), { maxBytes: MAX_MANIFEST_BYTES, allowMissing: true });
    } catch (cause) {
      throw new ModpackError('CLIENT_PACK_UNAVAILABLE', 'Matching client pack services are unavailable', { cause });
    }
  }
  async #unsupportedShape(clientPath) {
    if (typeof clientPath !== 'string' || !path.isAbsolute(clientPath)) return false;
    if (/^[\\/]{2}/u.test(clientPath)) return true;
    const resolved = path.resolve(clientPath);
    const root = path.parse(resolved).root;
    if (samePath(resolved, root) || samePath(path.dirname(resolved), root)) return true;
    let real;
    try { real = await this.fsPromises.realpath(resolved); } catch { return false; }
    return !samePath(path.resolve(real), resolved);
  }
  async write(clientPath, value) {
    const manifest = normalizeClientPackManifest(value);
    await this.durableFs.writeJsonAtomicAsync(path.join(clientPath, MANIFEST_NAME), manifest, { maxJsonValues: MANIFEST_JSON_VALUES });
    return manifest;
  }
}
module.exports = { ClientPackStateStore, MANIFEST_NAME, planOwnership, normalizeEntries, normalizeClientPackManifest };
