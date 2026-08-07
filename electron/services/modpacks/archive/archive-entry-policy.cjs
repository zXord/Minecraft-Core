const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { isSafeWindowsBasename } = require('../windows-basename.cjs');

const MAX_UINT64 = 18446744073709551615n;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const LINK_FIELDS = Object.freeze(['symbolicLink', 'hardLink', 'copyLink', 'linkTarget']);

function invalid(field = 'limits') {
  throw new ModpackError('INVALID_REQUEST', 'Archive policy request is invalid', { details: { field } });
}

function unsafe(reasonCode = 'non-regular-entry') {
  throw new ModpackError('UNSAFE_ARCHIVE_ENTRY', 'Archive contains an unsafe entry', { details: { reasonCode } });
}

function collision(reasonCode = 'normalized-path-collision') {
  throw new ModpackError('ARCHIVE_ENTRY_COLLISION', 'Archive entries have conflicting destinations', {
    details: { reasonCode }
  });
}

function encrypted() {
  throw new ModpackError('ENCRYPTED_ARCHIVE', 'Encrypted archives are not supported');
}

function limitExceeded(limit, actual) {
  throw new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Archive content exceeded a configured safety limit', {
    details: { limit, actual: String(actual) }
  });
}

function validateLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
      Object.keys(limits).length !== Object.keys(ARCHIVE_LIMITS).length ||
      Object.entries(ARCHIVE_LIMITS).some(([key, value]) => limits[key] !== value)) invalid();
  return limits;
}

function decimal(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) unsafe();
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) unsafe();
  return parsed;
}

function pathParts(value, limits) {
  if (typeof value !== 'string' || !value) unsafe('path-traversal');
  if ([...value].some(character => {
    const code = character.codePointAt(0);
    return code === 0 || code < 0x20 || code === 0x7f;
  })) unsafe('path-traversal');
  if (/^(?:[A-Za-z]:|[\\/]|\\\\\?\\|\\\\\.\\)/.test(value) || value.includes(':')) unsafe('path-traversal');
  if ((value.includes('/') && value.includes('\\')) || /[/\\]{2}/.test(value)) unsafe('path-traversal');
  const components = value.replaceAll('\\', '/').split('/');
  if (components.some(component => !component || component === '.' || component === '..')) unsafe('path-traversal');
  if (limits && components.length > limits.maxPathDepth) unsafe('path-depth');
  const normalizedComponents = components.map(component => component.normalize('NFC'));
  const normalized = normalizedComponents.join('/');
  if (limits && normalized.length > limits.maxNormalizedPathLength) unsafe('path-length');
  if (normalizedComponents.some(component => !isSafeWindowsBasename(component))) unsafe('path-traversal');
  return { normalized, normalizedComponents };
}

function canonicalWindowsArchivePath(value) {
  return pathParts(value).normalized.toLocaleLowerCase('en-US');
}

function normalizePath(value, limits) {
  const { normalized, normalizedComponents } = pathParts(value, limits);
  return {
    path: normalized,
    canonicalPath: normalized.toLocaleLowerCase('en-US'),
    depth: normalizedComponents.length,
    pathLength: normalized.length,
    canonicalComponents: normalizedComponents.map(component => component.toLocaleLowerCase('en-US'))
  };
}

function newTrieNode() {
  return { type: null, children: new Map() };
}

function registerDestination(root, normalized, type) {
  let node = root;
  for (const component of normalized.canonicalComponents) {
    if (node.type === 'file') collision('file-directory-collision');
    let child = node.children.get(component);
    if (!child) {
      child = newTrieNode();
      node.children.set(component, child);
    }
    node = child;
  }
  if (node.type) {
    if (node.type !== type) collision('file-directory-collision');
    collision('normalized-path-collision');
  }
  if (type === 'file' && node.children.size > 0) collision('file-directory-collision');
  node.type = type;
}

function validateEntryShape(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.getPrototypeOf(entry) !== Object.prototype) unsafe();
  if (entry.encrypted === true) throw encrypted();
  if (entry.encrypted !== false) unsafe();
  if (entry.type !== 'file' && entry.type !== 'directory') {
    if (entry.type === 'symlink' || LINK_FIELDS.some(key => typeof entry[key] === 'string' && entry[key])) unsafe('link-entry');
    unsafe();
  }
  if (LINK_FIELDS.some(key => typeof entry[key] === 'string' && entry[key].length > 0)) unsafe('link-entry');
  if (entry.reparse === true || entry.alternateStream === true || entry.ntSecurity ||
      (typeof entry.attributes === 'string' && /(?:^|\s)l[rwx-]{9}(?:$|\s)/.test(entry.attributes))) unsafe();
  if (typeof entry.attributes !== 'string') unsafe();
}

function validateArchiveEntries(entries, limitsValue) {
  const limits = validateLimits(limitsValue);
  if (!Array.isArray(entries)) invalid('entries');
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && entry.encrypted === true) throw encrypted();
  }
  if (entries.length > limits.maxArchiveEntries) limitExceeded('maxArchiveEntries', entries.length);

  const trie = newTrieNode();
  const normalizedEntries = [];
  let fileCount = 0;
  let directoryCount = 0;
  let expandedTotal = 0n;
  let packedTotal = 0n;
  let maximumDepth = 0;
  let maximumPathLength = 0;
  const maximumFile = BigInt(limits.maxFileExpandedBytes);
  const maximumExpanded = BigInt(limits.maxExpandedBytes);
  const perEntryThreshold = BigInt(limits.minPerEntryRatioExpandedBytes);
  const aggregateThreshold = BigInt(limits.minAggregateRatioExpandedBytes);
  const perEntryRatio = BigInt(limits.maxPerEntryCompressionRatio);
  const aggregateRatio = BigInt(limits.maxAggregateCompressionRatio);

  for (const source of entries) {
    validateEntryShape(source);
    const normalized = normalizePath(source.path, limits);
    const size = decimal(source.size);
    const packedSize = decimal(source.packedSize);
    if (source.type === 'directory' && (size !== 0n || packedSize !== 0n)) unsafe();
    if (source.type === 'file' && size > 0n && packedSize === 0n) unsafe();
    if (source.type === 'file' && size > maximumFile) limitExceeded('maxFileExpandedBytes', size);
    if (source.type === 'file' && size >= perEntryThreshold && size > packedSize * perEntryRatio) {
      limitExceeded('maxPerEntryCompressionRatio', (size + packedSize - 1n) / packedSize);
    }
    expandedTotal += size;
    packedTotal += packedSize;
    if (expandedTotal > maximumExpanded) limitExceeded('maxExpandedBytes', expandedTotal);
    if (packedTotal > MAX_UINT64) unsafe();
    registerDestination(trie, normalized, source.type);
    if (source.type === 'file') fileCount += 1;
    else directoryCount += 1;
    maximumDepth = Math.max(maximumDepth, normalized.depth);
    maximumPathLength = Math.max(maximumPathLength, normalized.pathLength);
    normalizedEntries.push({
      path: normalized.path,
      canonicalPath: normalized.canonicalPath,
      type: source.type,
      size: size.toString(),
      packedSize: packedSize.toString(),
      encrypted: false,
      attributes: source.attributes,
      depth: normalized.depth,
      pathLength: normalized.pathLength,
      ...(source.method === undefined ? {} : { method: source.method }),
      ...(source.symbolicLink === undefined ? {} : { symbolicLink: source.symbolicLink }),
      ...(source.hardLink === undefined ? {} : { hardLink: source.hardLink }),
      ...(source.copyLink === undefined ? {} : { copyLink: source.copyLink }),
      ...(source.volumeIndex === undefined ? {} : { volumeIndex: source.volumeIndex })
    });
  }

  if (expandedTotal >= aggregateThreshold && expandedTotal > packedTotal * aggregateRatio) {
    const actual = packedTotal === 0n ? expandedTotal : (expandedTotal + packedTotal - 1n) / packedTotal;
    limitExceeded('maxAggregateCompressionRatio', actual);
  }

  return deepFreeze({
    policyVersion: limits.version,
    entries: normalizedEntries,
    totals: {
      entryCount: normalizedEntries.length,
      fileCount,
      directoryCount,
      expandedBytes: expandedTotal.toString(),
      packedBytes: packedTotal.toString(),
      maximumDepth,
      maximumPathLength
    }
  });
}

module.exports = { canonicalWindowsArchivePath, validateArchiveEntries };
