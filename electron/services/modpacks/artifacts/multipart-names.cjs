const { ModpackError } = require('../errors.cjs');
const { ARCHIVE_LIMITS } = require('../limits.cjs');

const MAX_VOLUME = ARCHIVE_LIMITS.maxArchiveEntries;

function invalid(field) { throw new ModpackError('INVALID_REQUEST', 'Artifact candidate is invalid', { details: { field } }); }
function canonicalName(name) {
  if (typeof name !== 'string' || !name || name !== name.trim() || /[\\/\u0000-\u001f]/.test(name)) invalid('fileName');
  return name.normalize('NFC').toLocaleLowerCase('en-US');
}
function boundedIndex(raw, field, { allowZero = false } = {}) {
  if (!/^[0-9]+$/.test(raw)) invalid(field);
  const value = BigInt(raw);
  if ((!allowZero && value < 1n) || value > BigInt(MAX_VOLUME) || value > BigInt(Number.MAX_SAFE_INTEGER)) invalid(field);
  return Number(value);
}
function expectedCount(value, field) {
  if (value === undefined) return undefined;
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return boundedIndex(raw, field);
}
function normalizeAsset(asset, index) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) invalid(`assets.${index}`);
  const partId = asset.assetId ?? asset.partId;
  if (typeof partId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(partId)) invalid(`assets.${index}.assetId`);
  if (typeof asset.size !== 'string' || !/^(0|[1-9][0-9]*)$/.test(asset.size)) invalid(`assets.${index}.size`);
  return {
    partId, ...(asset.providerAssetId === undefined ? {} : { providerAssetId: asset.providerAssetId }), fileName: asset.fileName,
    size: asset.size, ...(asset.updatedAt === undefined ? {} : { updatedAt: asset.updatedAt }), ...(asset.providerDigest === undefined ? {} : { providerDigest: asset.providerDigest }),
    expectedPartCount: expectedCount(asset.expectedPartCount ?? asset.expectedVolumeCount, `assets.${index}.expectedPartCount`), key: canonicalName(asset.fileName)
  };
}
function enforceSourceScope(assets) {
  const hasRelease = assets.some((asset) => asset.releaseId !== undefined); const hasSelection = assets.some((asset) => asset.selectionId !== undefined);
  if (hasRelease && hasSelection) invalid('assets.source');
  const field = hasRelease ? 'releaseId' : hasSelection ? 'selectionId' : null;
  if (!field) return;
  const values = new Set(assets.map((asset) => asset[field]));
  if (values.size !== 1 || values.has(undefined) || values.has('')) invalid(`assets.${field}`);
}
function classify(asset) {
  const name = asset.key;
  if (/\.rev$/i.test(name)) return null;
  let match = /^(.*)\.part(\d+)\.rar$/i.exec(name);
  if (match) return { groupKey: `part:${match[1]}`, groupingScheme: 'part-number', volume: boundedIndex(match[2], 'fileName'), multipart: true };
  match = /^(.*)\.r(\d\d)$/i.exec(name);
  if (match) return { groupKey: `rxx:${match[1]}`, groupingScheme: 'rar-rxx', volume: boundedIndex(match[2], 'fileName', { allowZero: true }) + 1, multipart: true };
  match = /^(.*)\.(\d{3,})$/i.exec(name);
  if (match) return { groupKey: `numbered:${match[1]}`, groupingScheme: 'numbered-volume', volume: boundedIndex(match[2], 'fileName'), multipart: true };
  match = /^(.*)\.rar$/i.exec(name);
  if (match) return { groupKey: `rxx:${match[1]}`, groupingScheme: 'rar-rxx', volume: 0, multipart: false, bareRar: true };
  if (/\.(?:zip|mrpack)$/i.test(name)) return { groupKey: `single:${name}`, groupingScheme: 'single', volume: 0, multipart: false };
  return null;
}
function choiceFromGroup(group) {
  group.items.sort((left, right) => left.volume - right.volume || left.asset.key.localeCompare(right.asset.key, 'en-US'));
  const rxxHasSecondary = group.groupingScheme === 'rar-rxx' && group.items.some((item) => item.volume > 0);
  const groupingScheme = rxxHasSecondary ? 'rar-rxx' : group.groupingScheme === 'rar-rxx' ? 'single' : group.groupingScheme;
  const multipart = groupingScheme !== 'single';
  const start = groupingScheme === 'rar-rxx' ? 0 : 1;
  const volumes = new Map();
  for (const item of group.items) volumes.set(item.volume, [...(volumes.get(item.volume) || []), item]);
  const duplicate = [...volumes.values()].some((items) => items.length > 1);
  const declared = new Set(group.items.map((item) => item.asset.expectedPartCount).filter((value) => value !== undefined));
  if (declared.size > 1) invalid('assets.expectedPartCount');
  const declaredCount = declared.values().next().value;
  const lastFromMetadata = declaredCount === undefined ? undefined : groupingScheme === 'rar-rxx' ? declaredCount - 1 : declaredCount;
  const presentMax = Math.max(...volumes.keys());
  const max = lastFromMetadata === undefined ? presentMax : Math.max(presentMax, lastFromMetadata);
  if (max > MAX_VOLUME) invalid('fileName');
  const missingVolumes = [];
  for (let volume = start; volume <= max; volume += 1) if (!volumes.has(volume)) missingVolumes.push(volume);
  const disabled = duplicate || missingVolumes.length > 0;
  const parts = group.items.map(({ asset }) => { const { key, expectedPartCount, ...part } = asset; return part; });
  const primary = group.items.find((item) => item.volume === start) || group.items[0];
  return Object.freeze({ type: 'provisional-group', kind: multipart ? 'multipart' : 'single', groupingScheme, primaryPartId: primary.asset.partId,
    parts: Object.freeze(parts), disabled, ...(disabled ? { disabledReason: duplicate ? 'duplicate-volume' : 'missing-volume' } : {}), ...(missingVolumes.length ? { missingVolumes: Object.freeze(missingVolumes) } : {}),
    tailCompleteness: declaredCount === undefined ? 'unknown' : missingVolumes.length ? 'known-missing' : 'known-present' });
}
function groupMultipartCandidates(assets) {
  if (!Array.isArray(assets) || assets.length === 0) invalid('assets');
  enforceSourceScope(assets);
  const groups = new Map();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = normalizeAsset(assets[index], index); const classification = classify(asset); if (!classification) continue;
    const group = groups.get(classification.groupKey) || { ...classification, items: [] };
    group.items.push({ asset, volume: classification.volume }); groups.set(classification.groupKey, group);
  }
  return Object.freeze([...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'en-US')).map(([, group]) => choiceFromGroup(group)));
}
module.exports = { groupMultipartCandidates };
