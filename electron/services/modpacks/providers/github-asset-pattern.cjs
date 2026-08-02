const { normalizeRuntimeTuple } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { isSafeWindowsBasename, isSafeWindowsBasenamePattern } = require('../windows-basename.cjs');

const ROLES = new Set(['server-pack', 'mrpack', 'prepared-server', 'archive']);
const GROUPING_SCHEMES = new Set(['single', 'part-number', 'rar-rxx', 'numbered-volume']);
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]*$/;

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'GitHub asset pattern is invalid', {
    details: field ? { field } : undefined
  });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function known(value, names, field) {
  for (const key of Object.keys(value)) if (!names.includes(key)) invalid(`${field}.${key}`);
}

function hasControl(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function actualFileName(value, field, { pattern = false } = {}) {
  if (!(pattern ? isSafeWindowsBasenamePattern(value) : isSafeWindowsBasename(value))) invalid(field);
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function compileMatcher(value, field) {
  const normalized = actualFileName(value, field, { pattern: true });
  if ([...normalized].some(character => '?[](){}+^$|'.includes(character))) invalid(field);
  const stars = normalized.split('*').length - 1;
  if (stars > 1) invalid(field);
  if (stars === 0) return { kind: 'literal', value: normalized };
  const [prefix, suffix] = normalized.split('*');
  if (prefix.length < 3 || suffix.length < 3 || prefix.length + suffix.length < 7) invalid(field);
  return { kind: 'single-wildcard', prefix, suffix };
}

function normalizeMatcher(value, field) {
  if (!plain(value)) invalid(field);
  if (value.kind === 'literal') {
    known(value, ['kind', 'value'], field);
    const compiled = compileMatcher(value.value, `${field}.value`);
    if (compiled.kind !== 'literal') invalid(field);
    return compiled;
  }
  if (value.kind === 'single-wildcard') {
    known(value, ['kind', 'prefix', 'suffix'], field);
    const compiled = compileMatcher(`${value.prefix}*${value.suffix}`, field);
    if (compiled.kind !== 'single-wildcard' || compiled.prefix !== value.prefix || compiled.suffix !== value.suffix) invalid(field);
    return compiled;
  }
  invalid(`${field}.kind`);
}

function normalizeStructure(value, field) {
  if (!plain(value)) invalid(field);
  known(value, ['kind', 'groupingScheme', 'partCount', 'primaryIndex'], field);
  if (value.kind !== 'single' && value.kind !== 'multipart') invalid(`${field}.kind`);
  if (!GROUPING_SCHEMES.has(value.groupingScheme)) invalid(`${field}.groupingScheme`);
  if (!Number.isSafeInteger(value.partCount) || value.partCount < 1 || value.partCount > 1000) invalid(`${field}.partCount`);
  if (!Number.isSafeInteger(value.primaryIndex) || value.primaryIndex < 0 || value.primaryIndex >= value.partCount) invalid(`${field}.primaryIndex`);
  if (value.kind === 'single' && (value.groupingScheme !== 'single' || value.partCount !== 1 || value.primaryIndex !== 0)) invalid(field);
  if (value.kind === 'multipart' && (value.groupingScheme === 'single' || value.partCount < 2)) invalid(field);
  return {
    kind: value.kind, groupingScheme: value.groupingScheme,
    partCount: value.partCount, primaryIndex: value.primaryIndex
  };
}

function normalizeOverrideString(value, field) {
  if (value.length > 256 || value.includes('\\') || hasControl(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value) || /:\/\//.test(value) || /^[A-Za-z]:/.test(value)) invalid(field);
  return value.normalize('NFC');
}

function normalizeOverrides(value, field = 'userOverrides', depth = 0) {
  if (depth > 8) invalid(field);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return normalizeOverrideString(value, field);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid(field);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) invalid(field);
    return value.map((item, index) => normalizeOverrides(item, `${field}.${index}`, depth + 1));
  }
  if (!plain(value)) invalid(field);
  const keys = Object.keys(value).sort();
  if (keys.length > 64 || keys.some(key => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key))) invalid(field);
  return Object.fromEntries(keys.map(key => [key, normalizeOverrides(value[key], `${field}.${key}`, depth + 1)]));
}

function normalizeFingerprint(value, field) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalid(field);
  return value;
}

function normalizeRole(value, field) {
  if (!ROLES.has(value)) invalid(field);
  return value;
}

function compileAssetPattern(reviewedSelection) {
  if (!plain(reviewedSelection)) invalid('reviewedSelection');
  known(reviewedSelection, [
    'filenameMatcher', 'filenameMatchers', 'reviewedRole', 'archiveRootFingerprint',
    'runtimeEvidence', 'multipartStructure', 'userOverrides'
  ], 'reviewedSelection');
  const structure = normalizeStructure(reviewedSelection.multipartStructure, 'reviewedSelection.multipartStructure');
  let sourceMatchers;
  if (Array.isArray(reviewedSelection.filenameMatchers) && reviewedSelection.filenameMatcher === undefined) sourceMatchers = reviewedSelection.filenameMatchers;
  else if (typeof reviewedSelection.filenameMatcher === 'string' && reviewedSelection.filenameMatchers === undefined) sourceMatchers = [reviewedSelection.filenameMatcher];
  else invalid('reviewedSelection.filenameMatcher');
  if (sourceMatchers.length !== structure.partCount) invalid('reviewedSelection.filenameMatchers');
  const filenameMatchers = sourceMatchers.map((matcher, index) => compileMatcher(matcher, `reviewedSelection.filenameMatchers.${index}`));
  return deepFreeze({
    type: 'github-asset-pattern', version: 1, filenameMatchers,
    reviewedRole: normalizeRole(reviewedSelection.reviewedRole, 'reviewedSelection.reviewedRole'),
    archiveRootFingerprint: normalizeFingerprint(reviewedSelection.archiveRootFingerprint, 'reviewedSelection.archiveRootFingerprint'),
    runtimeEvidence: normalizeRuntimeTuple(reviewedSelection.runtimeEvidence),
    multipartStructure: structure,
    userOverrides: normalizeOverrides(reviewedSelection.userOverrides)
  });
}

function normalizePattern(pattern) {
  if (!plain(pattern)) invalid('pattern');
  known(pattern, [
    'type', 'version', 'filenameMatchers', 'reviewedRole', 'archiveRootFingerprint',
    'runtimeEvidence', 'multipartStructure', 'userOverrides'
  ], 'pattern');
  if (pattern.type !== 'github-asset-pattern' || pattern.version !== 1 || !Array.isArray(pattern.filenameMatchers)) invalid('pattern.version');
  const structure = normalizeStructure(pattern.multipartStructure, 'pattern.multipartStructure');
  if (pattern.filenameMatchers.length !== structure.partCount) invalid('pattern.filenameMatchers');
  return {
    filenameMatchers: pattern.filenameMatchers.map((matcher, index) => normalizeMatcher(matcher, `pattern.filenameMatchers.${index}`)),
    reviewedRole: normalizeRole(pattern.reviewedRole, 'pattern.reviewedRole'),
    archiveRootFingerprint: normalizeFingerprint(pattern.archiveRootFingerprint, 'pattern.archiveRootFingerprint'),
    runtimeEvidence: normalizeRuntimeTuple(pattern.runtimeEvidence),
    multipartStructure: structure,
    userOverrides: normalizeOverrides(pattern.userOverrides)
  };
}

function decimalId(value, field) {
  if (typeof value !== 'string' || !ID.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) invalid(field);
  return value;
}

function normalizeCandidate(candidate, index) {
  const field = `releaseAssets.${index}`;
  if (!plain(candidate)) invalid(field);
  known(candidate, [
    'assetIds', 'fileNames', 'reviewedRole', 'archiveRootFingerprint', 'runtimeEvidence',
    'multipartStructure', 'userOverrides', 'complete'
  ], field);
  if (!Array.isArray(candidate.assetIds) || candidate.assetIds.length < 1 || candidate.assetIds.length > 1000) invalid(`${field}.assetIds`);
  const assetIds = candidate.assetIds.map((id, assetIndex) => decimalId(id, `${field}.assetIds.${assetIndex}`));
  if (new Set(assetIds).size !== assetIds.length) invalid(`${field}.assetIds`);
  if (!Array.isArray(candidate.fileNames) || candidate.fileNames.length !== assetIds.length) invalid(`${field}.fileNames`);
  const fileNames = candidate.fileNames.map((name, assetIndex) => actualFileName(name, `${field}.fileNames.${assetIndex}`));
  if (typeof candidate.complete !== 'boolean') invalid(`${field}.complete`);
  const evidencePresent = candidate.reviewedRole !== undefined && candidate.archiveRootFingerprint !== undefined &&
    candidate.runtimeEvidence !== undefined && candidate.multipartStructure !== undefined && candidate.userOverrides !== undefined;
  if (!evidencePresent) return { assetIds, fileNames, complete: candidate.complete, evidenceComplete: false };
  const structure = normalizeStructure(candidate.multipartStructure, `${field}.multipartStructure`);
  return {
    assetIds, fileNames, complete: candidate.complete, evidenceComplete: structure.partCount === assetIds.length,
    reviewedRole: normalizeRole(candidate.reviewedRole, `${field}.reviewedRole`),
    archiveRootFingerprint: normalizeFingerprint(candidate.archiveRootFingerprint, `${field}.archiveRootFingerprint`),
    runtimeEvidence: normalizeRuntimeTuple(candidate.runtimeEvidence),
    multipartStructure: structure,
    userOverrides: normalizeOverrides(candidate.userOverrides, `${field}.userOverrides`)
  };
}

function matcherMatches(matcher, fileName) {
  if (matcher.kind === 'literal') return fileName === matcher.value;
  return fileName.startsWith(matcher.prefix) && fileName.endsWith(matcher.suffix) &&
    fileName.length > matcher.prefix.length + matcher.suffix.length;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchAssetPattern(pattern, releaseAssets) {
  const expected = normalizePattern(pattern);
  if (!Array.isArray(releaseAssets) || releaseAssets.length > 1000) invalid('releaseAssets');
  const matches = releaseAssets.map(normalizeCandidate).filter(candidate =>
    candidate.complete && candidate.evidenceComplete &&
    candidate.fileNames.length === expected.filenameMatchers.length &&
    candidate.fileNames.every((fileName, index) => matcherMatches(expected.filenameMatchers[index], fileName)) &&
    candidate.reviewedRole === expected.reviewedRole &&
    candidate.archiveRootFingerprint === expected.archiveRootFingerprint &&
    same(candidate.runtimeEvidence, expected.runtimeEvidence) &&
    same(candidate.multipartStructure, expected.multipartStructure) &&
    same(candidate.userOverrides, expected.userOverrides)
  );
  if (matches.length !== 1) return deepFreeze({ type: 'ASSET_SELECTION_REQUIRED', count: String(matches.length) });
  return deepFreeze({ type: 'HIGH_CONFIDENCE', selectedAssetIds: matches[0].assetIds });
}

module.exports = { compileAssetPattern, matchAssetPattern };
