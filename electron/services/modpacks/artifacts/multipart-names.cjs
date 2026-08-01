const { ModpackError } = require('../errors.cjs');

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Artifact candidate is invalid', { details: { field } });
}

function canonicalName(name) {
  if (typeof name !== 'string' || !name || name !== name.trim() || /[\\/\u0000-\u001f]/.test(name)) invalid('fileName');
  return name.normalize('NFC').toLocaleLowerCase('en-US');
}

function normalizeAsset(asset, index) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) invalid(`assets.${index}`);
  const partId = asset.assetId ?? asset.partId;
  if (typeof partId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(partId)) invalid(`assets.${index}.assetId`);
  if (typeof asset.size !== 'string' || !/^(0|[1-9][0-9]*)$/.test(asset.size)) invalid(`assets.${index}.size`);
  const fileName = asset.fileName;
  const key = canonicalName(fileName);
  return {
    partId,
    ...(asset.providerAssetId === undefined ? {} : { providerAssetId: asset.providerAssetId }),
    fileName,
    size: asset.size,
    ...(asset.updatedAt === undefined ? {} : { updatedAt: asset.updatedAt }),
    ...(asset.providerDigest === undefined ? {} : { providerDigest: asset.providerDigest }),
    key
  };
}

function enforceSourceScope(assets) {
  const hasRelease = assets.some((asset) => asset.releaseId !== undefined);
  const hasSelection = assets.some((asset) => asset.selectionId !== undefined);
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
  if (match) return { groupKey: `part:${match[1]}`, groupingScheme: 'part-number', volume: Number(match[2]), multipart: true };
  match = /^(.*)\.r(\d\d)$/i.exec(name);
  if (match) return { groupKey: `rxx:${match[1]}`, groupingScheme: 'rar-rxx', volume: Number(match[2]) + 1, multipart: true };
  match = /^(.*)\.(\d{3,})$/i.exec(name);
  if (match) return { groupKey: `numbered:${match[1]}`, groupingScheme: 'numbered-volume', volume: Number(match[2]), multipart: true };
  match = /^(.*)\.rar$/i.exec(name);
  if (match) return { groupKey: `rxx:${match[1]}`, groupingScheme: 'rar-rxx', volume: 0, multipart: false };
  if (/\.(?:zip|mrpack)$/i.test(name)) return { groupKey: `single:${name}`, groupingScheme: 'single', volume: 0, multipart: false };
  return null;
}

function choiceFromGroup(group) {
  group.items.sort((left, right) => left.volume - right.volume || left.asset.key.localeCompare(right.asset.key, 'en-US'));
  const volumes = new Map();
  for (const item of group.items) {
    const existing = volumes.get(item.volume) || [];
    existing.push(item);
    volumes.set(item.volume, existing);
  }
  const duplicate = [...volumes.values()].some((items) => items.length > 1);
  const volumeNumbers = [...volumes.keys()].sort((a, b) => a - b);
  const start = group.groupingScheme === 'rar-rxx' && volumeNumbers.includes(0) ? 0 : 1;
  const max = volumeNumbers.at(-1);
  const missingVolumes = [];
  for (let volume = start; volume <= max; volume += 1) if (!volumes.has(volume)) missingVolumes.push(volume);
  const disabled = duplicate || missingVolumes.length > 0;
  const parts = group.items.map(({ asset }) => {
    const { key, ...part } = asset;
    return part;
  });
  const primary = group.items.find((item) => item.volume === start) || group.items[0];
  return Object.freeze({
    type: 'provisional-group',
    kind: group.multipart ? 'multipart' : 'single',
    groupingScheme: group.groupingScheme,
    primaryPartId: primary.asset.partId,
    parts: Object.freeze(parts),
    disabled,
    ...(disabled ? { disabledReason: duplicate ? 'duplicate-volume' : 'missing-volume' } : {}),
    ...(missingVolumes.length ? { missingVolumes: Object.freeze(missingVolumes) } : {}),
    tailCompleteness: 'unknown'
  });
}

function groupMultipartCandidates(assets) {
  if (!Array.isArray(assets) || assets.length === 0) invalid('assets');
  enforceSourceScope(assets);
  const groups = new Map();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = normalizeAsset(assets[index], index);
    const classification = classify(asset);
    if (!classification) continue;
    const group = groups.get(classification.groupKey) || { ...classification, items: [] };
    group.multipart ||= classification.multipart;
    group.items.push({ asset, volume: classification.volume });
    groups.set(classification.groupKey, group);
  }
  return Object.freeze([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([, group]) => choiceFromGroup(group)));
}

module.exports = { groupMultipartCandidates };
