const { ModpackError, deepFreeze } = require('../errors.cjs');

const SHA256 = /^[a-f0-9]{64}$/;

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'GitHub release snapshot is invalid', {
    details: field ? { field } : undefined
  });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function known(value, names, field) {
  for (const key of Object.keys(value)) if (!names.includes(key)) invalid(`${field}.${key}`);
}

function decimalId(value, field) {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) invalid(field);
  const parsed = BigInt(raw);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) invalid(field);
  return raw;
}

function bytes(value, field) {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) invalid(field);
  if (BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER)) invalid(field);
  return raw;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) invalid(field);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  const parsed = new Date(value);
  if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() + 1 !== Number(match[2]) || parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) || parsed.getUTCMinutes() !== Number(match[5]) || parsed.getUTCSeconds() !== Number(match[6])) invalid(field);
  return value;
}

function tag(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid(field);
  return value;
}

function digest(value, field) {
  if (value === null) return null;
  if (!plain(value)) invalid(field);
  known(value, ['algorithm', 'value'], field);
  if (value.algorithm !== 'sha256' || !SHA256.test(value.value || '')) invalid(field);
  return { algorithm: 'sha256', value: value.value };
}

function normalizeAsset(value, field) {
  if (!plain(value)) invalid(field);
  known(value, ['assetId', 'size', 'providerDigest', 'updatedAt'], field);
  if (!Object.hasOwn(value, 'providerDigest')) invalid(`${field}.providerDigest`);
  return {
    assetId: decimalId(value.assetId, `${field}.assetId`),
    size: bytes(value.size, `${field}.size`),
    providerDigest: digest(value.providerDigest, `${field}.providerDigest`),
    updatedAt: timestamp(value.updatedAt, `${field}.updatedAt`)
  };
}

function normalizeSnapshot(value, field) {
  if (!plain(value)) invalid(field);
  const common = ['repositoryId', 'releaseId', 'tagName', 'prerelease', 'publishedAt'];
  const multipart = Object.hasOwn(value, 'assets');
  known(value, multipart ? [...common, 'assets'] : [...common, 'assetId', 'size', 'providerDigest', 'updatedAt'], field);
  if (typeof value.prerelease !== 'boolean') invalid(`${field}.prerelease`);
  const assets = multipart
    ? (() => {
        if (!Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 1000) invalid(`${field}.assets`);
        return value.assets.map((asset, index) => normalizeAsset(asset, `${field}.assets.${index}`));
      })()
    : [normalizeAsset({
        assetId: value.assetId,
        size: value.size,
        providerDigest: value.providerDigest,
        updatedAt: value.updatedAt
      }, `${field}.asset`)];
  assets.sort((left, right) => BigInt(left.assetId) < BigInt(right.assetId) ? -1 : BigInt(left.assetId) > BigInt(right.assetId) ? 1 : 0);
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) invalid(`${field}.assets`);
  return {
    repositoryId: decimalId(value.repositoryId, `${field}.repositoryId`),
    releaseId: decimalId(value.releaseId, `${field}.releaseId`),
    tagName: tag(value.tagName, `${field}.tagName`),
    prerelease: value.prerelease,
    publishedAt: timestamp(value.publishedAt, `${field}.publishedAt`),
    assets
  };
}

function compareReleaseSnapshot(previous, current) {
  const left = normalizeSnapshot(previous, 'previous');
  const right = normalizeSnapshot(current, 'current');
  if (left.repositoryId !== right.repositoryId) invalid('current.repositoryId');

  if (left.tagName === right.tagName) {
    const leftIdentity = JSON.stringify({
      releaseId: left.releaseId, prerelease: left.prerelease, publishedAt: left.publishedAt, assets: left.assets
    });
    const rightIdentity = JSON.stringify({
      releaseId: right.releaseId, prerelease: right.prerelease, publishedAt: right.publishedAt, assets: right.assets
    });
    return deepFreeze({ type: leftIdentity === rightIdentity ? 'NO_CHANGE' : 'ASSET_CHANGED' });
  }

  if (left.releaseId === right.releaseId) return deepFreeze({ type: 'ASSET_CHANGED' });
  if (Date.parse(right.publishedAt) <= Date.parse(left.publishedAt)) return deepFreeze({ type: 'NO_CHANGE' });
  return deepFreeze({
    type: right.prerelease ? 'NEWER_PRERELEASE' : 'NEWER_STABLE',
    releaseId: right.releaseId,
    tagName: right.tagName
  });
}

module.exports = { compareReleaseSnapshot };
