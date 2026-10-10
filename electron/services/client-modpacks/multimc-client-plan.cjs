const { TextDecoder } = require('node:util');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { ARCHIVE_LIMITS } = require('../modpacks/limits.cjs');
const { canonicalWindowsPath, normalizeMrpackPath } = require('../modpacks/mrpack/mrpack-schema.cjs');
const { getRequiredJavaVersion } = require('../minecraft-launcher/utils.cjs');
const { normalizeClientRuntime } = require('./client-runtime-installer.cjs');
const { normalizeRuntimeConstraints } = require('./client-runtime-constraints.cjs');
const { clientPathPolicy } = require('./client-content-policy.cjs');

const MULTIMC_MANIFEST_MAX_BYTES = 256 * 1024;
const COMPONENT_KEYS = new Set(['uid', 'version', 'dependencyOnly', 'important', 'disabled', 'cachedName', 'cachedVersion', 'cachedRequires', 'cachedConflicts', 'cachedVolatile', 'volatile']);
const COMPONENTS = new Set(['net.minecraft', 'net.minecraftforge', 'net.fabricmc.fabric-loader', 'net.fabricmc.intermediary', 'org.lwjgl3']);
const DOWNLOAD_MARKERS = new Set(['manifest.json', 'modrinth.index.json', 'pack.toml']);
const CUSTOM_RUNTIME = new Set(['patches', 'libraries', 'jarmods']);
const MRPACK_PAYLOAD = new Set(['overrides', 'client-overrides', 'server-overrides']);
const VALIDATED = new WeakSet();
const error = code => new ModpackError(code, 'The client archive format or content is unsupported');
const invalid = () => error('MANIFEST_INVALID');
const unsafe = () => error('UNSAFE_ARCHIVE_ENTRY');
const ambiguous = () => error('PACK_ROOT_AMBIGUOUS');
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const string = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !/[\u0000-\u001f\u007f]/u.test(value);
const exact = value => string(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value) && !/^(latest|release|snapshot)$/i.test(value);

function parseMultiMCManifest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MULTIMC_MANIFEST_MAX_BYTES) throw invalid();
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!plain(value) || Object.keys(value).some(key => !['formatVersion', 'components'].includes(key)) || value.formatVersion !== 1 ||
      !Array.isArray(value.components) || value.components.length > 32) throw invalid();
  const components = new Map();
  for (const component of value.components) {
    if (!plain(component) || Object.keys(component).some(key => !COMPONENT_KEYS.has(key)) || !COMPONENTS.has(component.uid) ||
        components.has(component.uid) || !exact(component.version)) throw invalid();
    for (const key of ['dependencyOnly', 'important', 'disabled', 'cachedVolatile', 'volatile']) {
      if (Object.hasOwn(component, key) && typeof component[key] !== 'boolean') throw invalid();
    }
    if (component.disabled === true) throw invalid();
    for (const [key, maximum] of [['cachedName', 256], ['cachedVersion', 128]]) {
      if (Object.hasOwn(component, key) && !string(component[key], maximum, true)) throw invalid();
    }
    for (const key of ['cachedRequires', 'cachedConflicts']) {
      if (!Object.hasOwn(component, key)) continue;
      const records = component[key];
      if (!Array.isArray(records) || records.length > 32) throw invalid();
      for (const record of records) {
        if (!plain(record) || Object.keys(record).some(k => !['uid', 'equals', 'suggests'].includes(k)) || !string(record.uid, 128) ||
            ['equals', 'suggests'].some(k => Object.hasOwn(record, k) && !string(record[k], 128, true))) throw invalid();
      }
    }
    if (['org.lwjgl3', 'net.fabricmc.intermediary'].includes(component.uid) && component.dependencyOnly !== true) throw invalid();
    components.set(component.uid, component.version);
  }
  const minecraftVersion = components.get('net.minecraft');
  const forge = components.get('net.minecraftforge');
  const fabric = components.get('net.fabricmc.fabric-loader');
  if (!minecraftVersion || forge && fabric || components.has('net.fabricmc.intermediary') &&
      (!fabric || components.get('net.fabricmc.intermediary') !== minecraftVersion)) throw invalid();
  let runtime;
  try {
    runtime = normalizeClientRuntime({ minecraftVersion, loaderFamily: forge ? 'forge' : fabric ? 'fabric' : 'vanilla',
      loaderVersion: forge || fabric || minecraftVersion, javaMajor: getRequiredJavaVersion(minecraftVersion), os: 'win32', architecture: 'x64' });
  } catch { throw invalid(); }
  const manifest = deepFreeze({ runtime, runtimeConstraints: normalizeRuntimeConstraints({ lwjglVersion: components.get('org.lwjgl3') ?? null }) });
  VALIDATED.add(manifest);
  return manifest;
}

function normalizeEntries(entries, nameKey) {
  if (!Array.isArray(entries) || entries.length > ARCHIVE_LIMITS.maxArchiveEntries) throw unsafe();
  const trie = { type: null, children: new Map() };
  let total = 0n;
  return entries.map(source => {
    if (!plain(source) || !['file', 'directory'].includes(source.type) ||
        nameKey === 'path' && Reflect.ownKeys(source).some(key => !['path', 'type', 'size'].includes(key))) throw unsafe();
    const original = source[nameKey];
    let normalized;
    try { normalized = normalizeMrpackPath(source.type === 'directory' && typeof original === 'string' ? original.replace(/[\\/]+$/, '') : original, { rejectState: false }); }
    catch { throw unsafe(); }
    const size = typeof source.size === 'number' && Number.isSafeInteger(source.size) && source.size >= 0 ? String(source.size) : source.size;
    if (typeof size !== 'string' || !/^(?:0|[1-9]\d*)$/.test(size) || BigInt(size) > BigInt(ARCHIVE_LIMITS.maxFileExpandedBytes) ||
        source.type === 'directory' && size !== '0') throw unsafe();
    total += BigInt(size);
    if (total > BigInt(ARCHIVE_LIMITS.maxExpandedBytes)) throw error('ARCHIVE_LIMIT_EXCEEDED');
    const key = canonicalWindowsPath(normalized);
    let node = trie;
    for (const segment of key.split('/')) {
      if (node.type === 'file') throw error('ARCHIVE_ENTRY_COLLISION');
      if (!node.children.has(segment)) node.children.set(segment, { type: null, children: new Map() });
      node = node.children.get(segment);
    }
    if (node.type || source.type === 'file' && node.children.size) throw error('ARCHIVE_ENTRY_COLLISION');
    node.type = source.type;
    return { original, path: normalized, key, type: source.type, size };
  });
}

function selectNormalized(entries) {
  const mrpack = entries.filter(entry => entry.key.split('/').at(-1) === 'modrinth.index.json');
  const launcher = entries.filter(entry => ['mmc-pack.json', 'instance.cfg'].includes(entry.key.split('/').at(-1)));
  if (mrpack.some(entry => entry.key === 'modrinth.index.json')) {
    if (mrpack.length !== 1 || mrpack[0].key.includes('/') || mrpack[0].type !== 'file' ||
        launcher.some(entry => !MRPACK_PAYLOAD.has(entry.key.split('/')[0]))) throw ambiguous();
    return { format: 'mrpack', metadataPath: mrpack[0].original };
  }
  // The ordinary game-content exception belongs only to a coherent MultiMC export.
  if (mrpack.some(entry => !entry.key.startsWith('.minecraft/'))) throw ambiguous();
  const metadata = launcher.find(entry => entry.key === 'mmc-pack.json' && entry.type === 'file');
  const marker = launcher.find(entry => entry.key === 'instance.cfg' && entry.type === 'file');
  if (launcher.length !== 2 || !metadata || !marker) throw ambiguous();
  let payload = false;
  for (const entry of entries) {
    const segments = entry.key.split('/');
    if (segments[0] === '.minecraft') {
      if (segments.length === 1 && entry.type !== 'directory') throw ambiguous();
      if (segments.length > 1 && entry.type === 'file') payload = true;
    } else if (DOWNLOAD_MARKERS.has(segments.at(-1)) || segments.some(segment => CUSTOM_RUNTIME.has(segment))) throw ambiguous();
  }
  if (!payload) throw ambiguous();
  return { format: 'multimc', metadataPath: metadata.original };
}

function selectClientArchiveFormat(entries) {
  return deepFreeze(selectNormalized(normalizeEntries(entries, 'entryName')));
}

function buildMultiMCClientPlan({ manifest, archiveEntries } = {}) {
  if (!VALIDATED.has(manifest)) throw invalid();
  const entries = normalizeEntries(archiveEntries, 'path');
  if (selectNormalized(entries).format !== 'multimc') throw ambiguous();
  const finalOverrides = [];
  const finalDirectories = [];
  for (const entry of entries) {
    if (!entry.key.startsWith('.minecraft/')) continue;
    // Normalize the target, never the exact source lookup path, and remove only this prefix.
    const targetPath = entry.path.slice(entry.path.indexOf('/') + 1);
    clientPathPolicy(targetPath);
    if (entry.type === 'file') finalOverrides.push({ archivePath: entry.original, targetPath, size: entry.size });
    else finalDirectories.push({ targetPath });
  }
  const sort = (a, b) => canonicalWindowsPath(a.targetPath).localeCompare(canonicalWindowsPath(b.targetPath), 'en-US');
  finalOverrides.sort(sort); finalDirectories.sort(sort);
  return deepFreeze({ runtime: manifest.runtime, runtimeConstraints: manifest.runtimeConstraints, downloads: [], finalOverrides, finalDirectories });
}

module.exports = { MULTIMC_MANIFEST_MAX_BYTES, selectClientArchiveFormat, parseMultiMCManifest, buildMultiMCClientPlan };
