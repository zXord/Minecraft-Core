const crypto = require('node:crypto');

const { normalizeRuntimeTuple } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { isSafeWindowsBasename, isSafeWindowsBasenamePattern } = require('../windows-basename.cjs');

const ROLES = new Set(['server-pack', 'mrpack', 'prepared-server', 'archive']);
const GROUPING_SCHEMES = new Set(['single', 'part-number', 'rar-rxx', 'numbered-volume']);
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]*$/;
const MAX_OVERRIDE_NODES = 4096;
const MAX_OVERRIDE_UTF8_BYTES = 64 * 1024;
const MAX_MATCH_WORK = 32 * 1024;

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

function newOverrideBudget() {
  return { nodes: 0, utf8Bytes: 0 };
}

function consumeOverrideBudget(budget, utf8Bytes, field) {
  budget.nodes += 1;
  budget.utf8Bytes += utf8Bytes;
  if (budget.nodes > MAX_OVERRIDE_NODES || budget.utf8Bytes > MAX_OVERRIDE_UTF8_BYTES) invalid(field);
}

function normalizeOverrides(value, field = 'userOverrides', budget = newOverrideBudget(), depth = 0) {
  if (depth > 8) invalid(field);
  if (value === null) {
    consumeOverrideBudget(budget, 4, field);
    return value;
  }
  if (typeof value === 'boolean') {
    consumeOverrideBudget(budget, value ? 4 : 5, field);
    return value;
  }
  if (typeof value === 'string') {
    const normalized = normalizeOverrideString(value, field);
    consumeOverrideBudget(budget, Buffer.byteLength(JSON.stringify(normalized), 'utf8'), field);
    return normalized;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid(field);
    consumeOverrideBudget(budget, Buffer.byteLength(String(value), 'utf8'), field);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) invalid(field);
    consumeOverrideBudget(budget, 2 + Math.max(0, value.length - 1), field);
    return value.map((item, index) => normalizeOverrides(item, `${field}.${index}`, budget, depth + 1));
  }
  if (!plain(value)) invalid(field);
  const keys = Object.keys(value).sort();
  if (keys.length > 64 || keys.some(key => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key))) invalid(field);
  consumeOverrideBudget(budget, 2 + Math.max(0, keys.length - 1) + keys.reduce((total, key) => total + Buffer.byteLength(JSON.stringify(key), 'utf8') + 1, 0), field);
  return Object.fromEntries(keys.map(key => [key, normalizeOverrides(value[key], `${field}.${key}`, budget, depth + 1)]));
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
    userOverrides: normalizeOverrides(reviewedSelection.userOverrides, 'reviewedSelection.userOverrides', newOverrideBudget())
  });
}

function reviewedRoleForClassification(value) {
  if (value === 'mrpack-server') return 'mrpack';
  if (value === 'prepared-server-pack') return 'server-pack';
  if (value === 'loader-installer-bundle') return 'prepared-server';
  invalid('classificationKind');
}

function matcherFromVersion(fileName, version) {
  actualFileName(fileName, 'seed.fileNames');
  if (typeof version !== 'string' || version.length < 1 || version.length > 128 || hasControl(version)) invalid('version');
  const tokens = [];
  if (/^[vV].+/u.test(version)) tokens.push(version.slice(1));
  tokens.push(version);
  for (const token of tokens) {
    if (token.length < 1) continue;
    const lowerName = fileName.toLocaleLowerCase('en-US');
    const lowerToken = token.toLocaleLowerCase('en-US');
    const first = lowerName.indexOf(lowerToken);
    if (first < 0 || lowerName.indexOf(lowerToken, first + lowerToken.length) >= 0) continue;
    const candidate = `${fileName.slice(0, first)}*${fileName.slice(first + token.length)}`;
    try {
      compileMatcher(candidate, 'seed.fileNames');
      return candidate;
    } catch {}
  }
  return fileName;
}

function structuralRootFingerprint(inspectionResult, classificationKind) {
  if (!plain(inspectionResult) || !Array.isArray(inspectionResult.entries) || inspectionResult.entries.length > 250_000) {
    invalid('inspectionResult');
  }
  const selectedRoot = inspectionResult.selectedRoot ?? null;
  if (selectedRoot !== null && (typeof selectedRoot !== 'string' || selectedRoot.length < 1 || selectedRoot.length > 1024 || hasControl(selectedRoot))) {
    invalid('inspectionResult.selectedRoot');
  }
  const root = selectedRoot?.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '') || null;
  const features = new Set();
  for (let index = 0; index < inspectionResult.entries.length; index += 1) {
    const entry = inspectionResult.entries[index];
    if (!plain(entry)) invalid(`inspectionResult.entries.${index}`);
    const rawName = entry.canonicalName ?? entry.path ?? entry.entryName;
    if (typeof rawName !== 'string' || rawName.length < 1 || rawName.length > 16_384 || hasControl(rawName)) invalid(`inspectionResult.entries.${index}`);
    let relative = rawName.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
    if (root) {
      if (relative.toLocaleLowerCase('en-US') === root.toLocaleLowerCase('en-US')) continue;
      if (!relative.toLocaleLowerCase('en-US').startsWith(`${root.toLocaleLowerCase('en-US')}/`)) continue;
      relative = relative.slice(root.length + 1);
    }
    const parts = relative.split('/').filter(Boolean);
    if (parts.length < 1) continue;
    if (parts.length > 1) features.add(`directory:${parts[0].normalize('NFC').toLocaleLowerCase('en-US')}`);
    else features.add(`file:${parts[0].normalize('NFC').toLocaleLowerCase('en-US')}`);
  }
  return crypto.createHash('sha256').update(JSON.stringify({
    classificationKind,
    features: [...features].sort((left, right) => left.localeCompare(right, 'en-US'))
  }), 'utf8').digest('hex');
}

function compileAssetPatternForInspection({
  seed, version, classificationKind, inspectionResult, runtimeEvidence, userOverrides
} = {}) {
  if (!plain(seed)) invalid('seed');
  known(seed, ['fileNames', 'multipartStructure'], 'seed');
  const structure = normalizeStructure(seed.multipartStructure, 'seed.multipartStructure');
  if (!Array.isArray(seed.fileNames) || seed.fileNames.length !== structure.partCount) invalid('seed.fileNames');
  const fileNames = seed.fileNames.map((name, index) => {
    actualFileName(name, `seed.fileNames.${index}`);
    return name;
  });
  return compileAssetPattern({
    filenameMatchers: fileNames.map(name => matcherFromVersion(name, version)),
    reviewedRole: reviewedRoleForClassification(classificationKind),
    archiveRootFingerprint: structuralRootFingerprint(inspectionResult, classificationKind),
    runtimeEvidence,
    multipartStructure: structure,
    userOverrides
  });
}

function normalizePattern(pattern, overrideBudget) {
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
    userOverrides: normalizeOverrides(pattern.userOverrides, 'pattern.userOverrides', overrideBudget)
  };
}

function decimalId(value, field) {
  if (typeof value !== 'string' || !ID.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) invalid(field);
  return value;
}

function normalizeCandidate(candidate, index, overrideBudget) {
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
    userOverrides: normalizeOverrides(candidate.userOverrides, `${field}.userOverrides`, overrideBudget)
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

function assertMatchWorkBudget(pattern, releaseAssets) {
  const matcherCount = Array.isArray(pattern?.filenameMatchers) ? pattern.filenameMatchers.length : 0;
  let work = matcherCount;
  for (const candidate of releaseAssets) {
    work += matcherCount;
    if (plain(candidate)) {
      if (Array.isArray(candidate.assetIds)) work += candidate.assetIds.length;
      if (Array.isArray(candidate.fileNames)) work += candidate.fileNames.length;
    }
    if (work > MAX_MATCH_WORK) invalid('releaseAssets');
  }
}

function matchAssetPattern(pattern, releaseAssets) {
  if (!Array.isArray(releaseAssets) || releaseAssets.length > 1000) invalid('releaseAssets');
  assertMatchWorkBudget(pattern, releaseAssets);
  const overrideBudget = newOverrideBudget();
  const expected = normalizePattern(pattern, overrideBudget);
  const matches = releaseAssets.map((candidate, index) => normalizeCandidate(candidate, index, overrideBudget)).filter(candidate =>
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

function normalizeProvisionalCandidate(candidate, index) {
  const field = `releaseAssets.${index}`;
  if (!plain(candidate)) invalid(field);
  known(candidate, ['assetIds', 'fileNames', 'multipartStructure', 'complete'], field);
  if (!Array.isArray(candidate.assetIds) || candidate.assetIds.length < 1 || candidate.assetIds.length > 1000) invalid(`${field}.assetIds`);
  const assetIds = candidate.assetIds.map((id, assetIndex) => decimalId(id, `${field}.assetIds.${assetIndex}`));
  if (new Set(assetIds).size !== assetIds.length || !Array.isArray(candidate.fileNames) || candidate.fileNames.length !== assetIds.length) invalid(field);
  const fileNames = candidate.fileNames.map((name, assetIndex) => actualFileName(name, `${field}.fileNames.${assetIndex}`));
  const multipartStructure = normalizeStructure(candidate.multipartStructure, `${field}.multipartStructure`);
  if (multipartStructure.partCount !== assetIds.length || typeof candidate.complete !== 'boolean') invalid(field);
  return { assetIds, fileNames, multipartStructure, complete: candidate.complete };
}

function matchAssetPatternProvisional(pattern, releaseAssets) {
  if (!Array.isArray(releaseAssets) || releaseAssets.length > 1000) invalid('releaseAssets');
  assertMatchWorkBudget(pattern, releaseAssets);
  const expected = normalizePattern(pattern, newOverrideBudget());
  const matches = releaseAssets.map(normalizeProvisionalCandidate).filter(candidate =>
    candidate.complete && candidate.fileNames.length === expected.filenameMatchers.length &&
    candidate.fileNames.every((fileName, index) => matcherMatches(expected.filenameMatchers[index], fileName)) &&
    same(candidate.multipartStructure, expected.multipartStructure)
  );
  if (matches.length !== 1) return deepFreeze({ type: 'ASSET_SELECTION_REQUIRED', count: String(matches.length) });
  return deepFreeze({ type: 'SINGLE_PROVISIONAL', selectedAssetIds: matches[0].assetIds });
}

module.exports = {
  compileAssetPattern,
  compileAssetPatternForInspection,
  matchAssetPattern,
  matchAssetPatternProvisional
};
