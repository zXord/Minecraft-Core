const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { normalizeRuntimeTuple } = require('../modpacks/contracts.cjs');
const { parseNonNegativeBytes } = require('../modpacks/limits.cjs');
const { isSafeWindowsBasename } = require('../modpacks/windows-basename.cjs');
const { JOB_ID_PATTERN, normalizeRecoveryTargetPath } = require('./recovery-target-envelope.cjs');

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATIONS = new Set(['install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback', 'import', 'detach', 'uninstall', 'verify']);
const PROGRESS = ['authorized', 'deleting', 'archive-deleted', 'deleted'];
const REASONS = new Set(['missing-final-policy-proof', 'independent-owner', 'reference-proof-incomplete', 'target-busy',
  'target-running', 'recovery-pending', 'identity-mismatch', 'unsupported-native', 'io-failure', 'publication-incomplete',
  'writer-unproven', 'receipt-conflict', 'invalid-evidence']);
const CANDIDATE_KEYS = ['schemaVersion', 'id', 'name', 'metadataName', 'sha256', 'size', 'totalBytes', 'scopeSha256',
  'sourceRevision', 'sourceRuntime', 'operationId', 'createdAt'];

function invalid(cause) { return new ModpackError('INVALID_REQUEST', 'The restorepoint retirement evidence is invalid', { cause }); }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(entry => !entry.enumerable || !Object.hasOwn(entry, 'value'))) throw invalid();
  return value;
}
function hash(value) { if (typeof value !== 'string' || !HASH.test(value)) throw invalid(); return value; }
function id(value, pattern = ID) { if (typeof value !== 'string' || !pattern.test(value)) throw invalid(); return value; }
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) throw invalid(); return value; }
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw invalid();
  return value;
}
function identity(value, fileType) {
  object(value, ['fileType', 'dev', 'ino', 'size', 'birthtime', 'mtime', 'ctime', ...(fileType === 'file' ? ['sha256'] : [])]);
  if (value.fileType !== fileType) throw invalid();
  for (const key of ['dev', 'ino', 'size']) {
    if (typeof value[key] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value[key]) || value[key].length > 20 ||
        BigInt(value[key]) > 18446744073709551615n) throw invalid();
  }
  if (value.ino === '0') throw invalid();
  for (const key of ['birthtime', 'mtime', 'ctime']) {
    if (typeof value[key] !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value[key]) || value[key].length > 20 ||
        BigInt(value[key]) < -9223372036854775808n || BigInt(value[key]) > 9223372036854775807n) throw invalid();
  }
  if (fileType === 'file') hash(value.sha256);
  return { ...value };
}
function target(value) {
  object(value, ['kind', 'stableServerId', 'path']);
  if (value.kind !== 'existing') throw invalid();
  return { kind: 'existing', stableServerId: id(value.stableServerId), path: normalizeRecoveryTargetPath(value.path) };
}

function normalizeRetirementCandidate(value) {
  object(value, CANDIDATE_KEYS);
  if (value.schemaVersion !== 1 || !isSafeWindowsBasename(value.name) ||
      !/^restore-point-[A-Za-z0-9._-]{1,180}\.zip$/.test(value.name) ||
      value.metadataName !== value.name.replace(/\.zip$/, '.json') || !isSafeWindowsBasename(value.metadataName) ||
      integer(value.size) === 0 || typeof value.totalBytes !== 'string' || value.totalBytes.length > 64 * 1024) throw invalid();
  try { parseNonNegativeBytes(value.totalBytes); } catch (error) { throw invalid(error); }
  // Clone before runtime normalization so accessors/prototypes cannot enter the reused validator.
  if (value.sourceRuntime !== null) object(value.sourceRuntime, ['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture']);
  const runtime = value.sourceRuntime === null ? null : normalizeRuntimeTuple(strictJsonClone(value.sourceRuntime));
  const result = { schemaVersion: 1, id: id(value.id), name: value.name, metadataName: value.metadataName,
    sha256: hash(value.sha256), size: value.size, totalBytes: value.totalBytes, scopeSha256: hash(value.scopeSha256),
    sourceRevision: integer(value.sourceRevision), sourceRuntime: runtime, operationId: id(value.operationId, JOB_ID_PATTERN),
    createdAt: timestamp(value.createdAt) };
  if (Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, 'utf8') > 64 * 1024) throw invalid();
  return deepFreeze(result);
}

function normalizeRetirementReceipt(value) {
  object(value, ['schemaVersion', 'policyVersion', 'sequence', 'jobId', 'operationKind', 'target', 'candidate', 'terminal',
    'lineage', 'files', 'pinOwner', 'settlement', 'progress', 'durability', 'diagnostic', 'lastAttemptAt', 'createdAt', 'updatedAt']);
  if (value.schemaVersion !== 1 || value.policyVersion !== 1 || !OPERATIONS.has(value.operationKind) || !PROGRESS.includes(value.progress)) throw invalid();
  const candidate = normalizeRetirementCandidate(value.candidate);
  const jobId = id(value.jobId, JOB_ID_PATTERN);
  if (candidate.operationId !== jobId || value.pinOwner !== jobId) throw invalid();
  object(value.terminal, ['recordSha256', 'envelopeSha256', 'targetPathHash', 'envelopeChecksum']);
  const terminal = Object.fromEntries(['recordSha256', 'envelopeSha256', 'targetPathHash', 'envelopeChecksum'].map(key => [key, hash(value.terminal[key])]));
  object(value.lineage, ['parent', 'target', 'backups']);
  const lineage = Object.fromEntries(['parent', 'target', 'backups'].map(key => [key, identity(value.lineage[key], 'directory')]));
  object(value.files, ['archive', 'sidecar']);
  const files = { archive: identity(value.files.archive, 'file'), sidecar: identity(value.files.sidecar, 'file') };
  if (files.archive.sha256 !== candidate.sha256 || files.archive.size !== String(candidate.size)) throw invalid();
  object(value.settlement, ['caller', 'action', 'swapStep', 'commitStarted', 'policyRestored']);
  if (value.settlement.caller !== 'live-precommit-final-policy' || value.settlement.action !== 'pre-swap-restored' ||
      value.settlement.swapStep !== 'none' || value.settlement.commitStarted !== false || value.settlement.policyRestored !== true) throw invalid();
  object(value.durability, ['archive', 'sidecar']);
  const { archive, sidecar } = value.durability;
  if (!(value.progress === 'authorized' && archive === 'not-started' && sidecar === 'not-started') &&
      !(value.progress === 'deleting' && archive === 'intent' && sidecar === 'not-started') &&
      !(value.progress === 'archive-deleted' && archive === 'durable' && ['not-started', 'intent'].includes(sidecar)) &&
      !(value.progress === 'deleted' && archive === 'durable' && sidecar === 'durable')) throw invalid();
  let diagnostic = null;
  if (value.diagnostic !== null) {
    object(value.diagnostic, ['reason', 'at']);
    if (!REASONS.has(value.diagnostic.reason)) throw invalid();
    diagnostic = { reason: value.diagnostic.reason, at: timestamp(value.diagnostic.at) };
  }
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const lastAttemptAt = value.lastAttemptAt === null ? null : timestamp(value.lastAttemptAt);
  if (updatedAt < createdAt || (lastAttemptAt !== null && (lastAttemptAt < createdAt || lastAttemptAt > updatedAt))) throw invalid();
  const result = { schemaVersion: 1, policyVersion: 1, sequence: integer(value.sequence), jobId, operationKind: value.operationKind,
    target: target(value.target), candidate, terminal, lineage, files, pinOwner: jobId,
    settlement: { caller: 'live-precommit-final-policy', action: 'pre-swap-restored', swapStep: 'none', commitStarted: false, policyRestored: true },
    progress: value.progress, durability: { archive, sidecar }, diagnostic, lastAttemptAt, createdAt, updatedAt };
  if (Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, 'utf8') > 64 * 1024) throw invalid();
  return deepFreeze(result);
}

function sameIdentity(left, right) {
  const keys = ['fileType', 'dev', 'ino', 'birthtime', ...(left.fileType === 'file' ? ['size', 'mtime', 'sha256'] : [])];
  return keys.every(key => left[key] === right[key]);
}

function assertRetirementReceiptTransition(previous, next) {
  const before = normalizeRetirementReceipt(previous);
  const after = normalizeRetirementReceipt(next);
  for (const key of ['schemaVersion', 'policyVersion', 'jobId', 'operationKind', 'target', 'candidate', 'terminal', 'pinOwner', 'settlement', 'createdAt']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw invalid();
  }
  for (const key of ['parent', 'target', 'backups']) if (!sameIdentity(before.lineage[key], after.lineage[key])) throw invalid();
  for (const key of ['archive', 'sidecar']) if (!sameIdentity(before.files[key], after.files[key])) throw invalid();
  const step = PROGRESS.indexOf(after.progress) - PROGRESS.indexOf(before.progress);
  if (after.sequence !== before.sequence + 1 || after.updatedAt < before.updatedAt || step < 0 || step > 1 ||
      (before.lastAttemptAt !== null && (after.lastAttemptAt === null || after.lastAttemptAt < before.lastAttemptAt))) throw invalid();
  const order = ['not-started', 'intent', 'durable'];
  for (const key of ['archive', 'sidecar']) {
    const delta = order.indexOf(after.durability[key]) - order.indexOf(before.durability[key]);
    if (delta < 0 || delta > 1) throw invalid();
  }
}

module.exports = { normalizeRetirementCandidate, normalizeRetirementReceipt, assertRetirementReceiptTransition };
