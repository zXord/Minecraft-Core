const { ModpackError } = require('../modpacks/errors.cjs');

const RESTORE_CREATION_SCHEMA_VERSION = 1;
const RESTORE_CREATION_KIND = 'minecraft-core-lifecycle-restore-creation';
const RESTORE_CREATION_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'operationId', 'name', 'partName', 'createdAt', 'sourceRevision', 'scopeSha256',
  'backupDirectory', 'partIdentity', 'archiveSha256', 'archiveSize', 'metadataSha256', 'metadataIdentity', 'state'
]);
const RESTORE_CREATION_DIRECTORY_KEYS = Object.freeze(['existed', 'identity']);
const RESTORE_CREATION_IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'birthtimeNs']);
const RESTORE_NAME_PATTERN = /^restore-point-[A-Za-z0-9._-]{1,180}\.zip$/;
const DECIMAL_IDENTITY_PATTERN = /^(0|[1-9][0-9]{0,39})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATE_ORDER = new Map([
  ['prepared', 0], ['writing', 1], ['verified', 2], ['metadata-writing', 3], ['metadata-staged', 4],
  ['archive-published', 5], ['published', 6]
]);

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The restore creation intent is invalid', { cause });
}

function assertStrictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length !== keys.length || names.some(name => !keys.includes(name))) throw invalid();
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return value;
}

function assertIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) throw invalid();
  return value;
}

function normalizeRestoreCreationIdentity(value) {
  if (value === null) return null;
  assertStrictObject(value, RESTORE_CREATION_IDENTITY_KEYS);
  for (const key of RESTORE_CREATION_IDENTITY_KEYS) {
    if (typeof value[key] !== 'string' || !DECIMAL_IDENTITY_PATTERN.test(value[key])) throw invalid();
  }
  return { dev: value.dev, ino: value.ino, birthtimeNs: value.birthtimeNs };
}

function normalizeRestoreCreation(value, expectedOperationId) {
  if (value === null) return null;
  assertStrictObject(value, RESTORE_CREATION_KEYS);
  if (value.schemaVersion !== RESTORE_CREATION_SCHEMA_VERSION || value.kind !== RESTORE_CREATION_KIND ||
      value.operationId !== expectedOperationId || typeof value.name !== 'string' || !RESTORE_NAME_PATTERN.test(value.name) ||
      value.partName !== `${value.name}.part` || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision < 0 ||
      typeof value.scopeSha256 !== 'string' || !SHA256_PATTERN.test(value.scopeSha256) || !STATE_ORDER.has(value.state)) {
    throw invalid();
  }
  assertStrictObject(value.backupDirectory, RESTORE_CREATION_DIRECTORY_KEYS);
  if (typeof value.backupDirectory.existed !== 'boolean') throw invalid();
  const backupIdentity = normalizeRestoreCreationIdentity(value.backupDirectory.identity);
  const partIdentity = normalizeRestoreCreationIdentity(value.partIdentity);
  const archiveSha256 = value.archiveSha256 === null
    ? null
    : (typeof value.archiveSha256 === 'string' && SHA256_PATTERN.test(value.archiveSha256) ? value.archiveSha256 : (() => { throw invalid(); })());
  const metadataSha256 = value.metadataSha256 === null
    ? null
    : (typeof value.metadataSha256 === 'string' && SHA256_PATTERN.test(value.metadataSha256) ? value.metadataSha256 : (() => { throw invalid(); })());
  const archiveSize = value.archiveSize === null
    ? null
    : (Number.isSafeInteger(value.archiveSize) && value.archiveSize > 0 ? value.archiveSize : (() => { throw invalid(); })());
  const metadataIdentity = normalizeRestoreCreationIdentity(value.metadataIdentity);

  if (value.backupDirectory.existed && backupIdentity === null) throw invalid();
  if (value.state === 'prepared' &&
      (partIdentity !== null || archiveSha256 !== null || archiveSize !== null || metadataSha256 !== null || metadataIdentity !== null)) {
    throw invalid();
  }
  if (value.state === 'writing' &&
      (backupIdentity === null || partIdentity === null || archiveSha256 !== null || archiveSize !== null ||
       metadataSha256 !== null || metadataIdentity !== null)) {
    throw invalid();
  }
  if (value.state === 'verified' &&
      (backupIdentity === null || partIdentity === null || archiveSha256 === null || archiveSize === null ||
       metadataSha256 === null || metadataIdentity !== null)) {
    throw invalid();
  }
  if (STATE_ORDER.get(value.state) >= STATE_ORDER.get('metadata-writing') &&
      (backupIdentity === null || partIdentity === null || archiveSha256 === null || archiveSize === null ||
       metadataSha256 === null || metadataIdentity === null)) {
    throw invalid();
  }

  return {
    schemaVersion: RESTORE_CREATION_SCHEMA_VERSION,
    kind: RESTORE_CREATION_KIND,
    operationId: expectedOperationId,
    name: value.name,
    partName: value.partName,
    createdAt: assertIsoTimestamp(value.createdAt),
    sourceRevision: value.sourceRevision,
    scopeSha256: value.scopeSha256,
    backupDirectory: { existed: value.backupDirectory.existed, identity: backupIdentity },
    partIdentity,
    archiveSha256,
    archiveSize,
    metadataSha256,
    metadataIdentity,
    state: value.state
  };
}

function identityFromStat(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs)
  });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRestoreCreationTransition(previous, next, context = {}) {
  if (previous === null) {
    if (next === null) return;
    if (next.state !== 'prepared' || context.previousPhase !== 'preflight' || context.nextPhase !== 'snapshotting') throw invalid();
    return;
  }
  if (next === null) {
    if (previous.state !== 'published' || context.previousPhase !== 'snapshotting' || context.nextPhase !== 'staging' ||
        !context.nextRestorePoint || context.nextRestorePoint.sha256 !== previous.archiveSha256) throw invalid();
    return;
  }
  for (const key of ['schemaVersion', 'kind', 'operationId', 'name', 'partName', 'createdAt', 'sourceRevision', 'scopeSha256']) {
    if (previous[key] !== next[key]) throw invalid();
  }
  if (previous.backupDirectory.existed !== next.backupDirectory.existed) throw invalid();
  if (previous.backupDirectory.identity !== null && !sameIdentity(previous.backupDirectory.identity, next.backupDirectory.identity)) throw invalid();
  if (previous.partIdentity !== null && !sameIdentity(previous.partIdentity, next.partIdentity)) throw invalid();
  if (previous.archiveSha256 !== null && previous.archiveSha256 !== next.archiveSha256) throw invalid();
  if (previous.archiveSize !== null && previous.archiveSize !== next.archiveSize) throw invalid();
  if (previous.metadataSha256 !== null && previous.metadataSha256 !== next.metadataSha256) throw invalid();
  if (previous.metadataIdentity !== null && !sameIdentity(previous.metadataIdentity, next.metadataIdentity)) throw invalid();

  const priorRank = STATE_ORDER.get(previous.state);
  const nextRank = STATE_ORDER.get(next.state);
  if (nextRank < priorRank || nextRank > priorRank + 1) throw invalid();
  if (nextRank === priorRank) {
    const allowedPreparedDirectoryPin = previous.state === 'prepared' && previous.backupDirectory.identity === null &&
      next.backupDirectory.identity !== null &&
      sameJson({ ...previous, backupDirectory: next.backupDirectory }, next);
    if (!sameJson(previous, next) && !allowedPreparedDirectoryPin) throw invalid();
    return;
  }
  if (previous.state === 'prepared' && next.state === 'writing') {
    if (previous.backupDirectory.identity === null || !sameIdentity(previous.backupDirectory.identity, next.backupDirectory.identity)) throw invalid();
    return;
  }
  if (previous.state === 'writing' && next.state === 'verified') return;
  if (previous.state === 'verified' && next.state === 'metadata-writing') return;
  if (previous.state === 'metadata-writing' && next.state === 'metadata-staged') return;
  if (previous.state === 'metadata-staged' && next.state === 'archive-published') return;
  if (previous.state === 'archive-published' && next.state === 'published') return;
  throw invalid();
}

module.exports = {
  RESTORE_CREATION_KIND,
  RESTORE_CREATION_SCHEMA_VERSION,
  assertRestoreCreationTransition,
  identityFromStat,
  normalizeRestoreCreation,
  sameIdentity
};
