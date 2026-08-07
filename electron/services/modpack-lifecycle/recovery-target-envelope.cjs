const crypto = require('node:crypto');
const path = require('node:path');

const { ModpackError } = require('../modpacks/errors.cjs');
const { isSafeWindowsBasename } = require('../modpacks/windows-basename.cjs');

const ENVELOPE_SCHEMA_VERSION = 1;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'jobId',
  'stableServerId',
  'targetPathHash',
  'targetLabel',
  'checksum'
]);

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The recovery target is invalid', { cause });
}

function assertStrictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
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

function normalizeRecoveryTargetPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) throw invalid();
  const slashed = candidate.replaceAll('/', '\\');
  if (!path.win32.isAbsolute(slashed) || slashed.startsWith('\\\\') ||
      slashed.startsWith('\\?\\') || slashed.startsWith('\\.\\')) throw invalid();
  const rawParsed = path.win32.parse(slashed);
  if (slashed.slice(rawParsed.root.length).split('\\').some(segment => segment === '.' || segment === '..')) throw invalid();
  const normalized = path.win32.normalize(slashed).normalize('NFC');
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root) || normalized.toLocaleLowerCase('en-US') === parsed.root.toLocaleLowerCase('en-US')) {
    throw invalid();
  }
  const tail = normalized.slice(parsed.root.length);
  if (tail.includes(':')) throw invalid();
  const segments = tail.split('\\').filter(Boolean);
  if (segments.length === 0 || segments.some(segment => segment !== segment.normalize('NFC') || !isSafeWindowsBasename(segment))) {
    throw invalid();
  }
  return `${parsed.root[0].toLocaleLowerCase('en-US')}:${normalized.slice(parsed.root.length - 1)}`
    .replace(/[\\]+$/, '')
    .toLocaleLowerCase('en-US')
    .normalize('NFC');
}

function displayLabel(normalizedPath) {
  const label = path.win32.basename(normalizedPath).normalize('NFC');
  if (!isSafeWindowsBasename(label)) throw invalid();
  return label.slice(0, 128);
}

function payloadBytes(envelope) {
  return Buffer.from(JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    jobId: envelope.jobId,
    stableServerId: envelope.stableServerId,
    targetPathHash: envelope.targetPathHash,
    targetLabel: envelope.targetLabel
  }), 'utf8');
}

function checksum(envelope) {
  return crypto.createHash('sha256').update(payloadBytes(envelope)).digest('hex');
}

function assertEnvelopeFields(envelope) {
  assertStrictObject(envelope, ENVELOPE_KEYS);
  if (envelope.schemaVersion !== ENVELOPE_SCHEMA_VERSION ||
      typeof envelope.jobId !== 'string' || !JOB_ID_PATTERN.test(envelope.jobId) ||
      (envelope.stableServerId !== null && (typeof envelope.stableServerId !== 'string' || !SERVER_ID_PATTERN.test(envelope.stableServerId))) ||
      typeof envelope.targetPathHash !== 'string' || !SHA256_PATTERN.test(envelope.targetPathHash) ||
      typeof envelope.targetLabel !== 'string' || envelope.targetLabel.length < 1 || envelope.targetLabel.length > 128 ||
      envelope.targetLabel !== envelope.targetLabel.normalize('NFC') || !isSafeWindowsBasename(envelope.targetLabel) ||
      typeof envelope.checksum !== 'string' || !SHA256_PATTERN.test(envelope.checksum)) throw invalid();
  const expected = Buffer.from(checksum(envelope), 'hex');
  const actual = Buffer.from(envelope.checksum, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw invalid();
  return envelope;
}

function createRecoveryTargetEnvelope(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.getPrototypeOf(record) !== Object.prototype) throw invalid();
  const recordDescriptors = Object.getOwnPropertyDescriptors(record);
  const jobIdDescriptor = recordDescriptors.jobId;
  const targetDescriptor = recordDescriptors.target;
  if (!jobIdDescriptor?.enumerable || !Object.hasOwn(jobIdDescriptor, 'value') ||
      !targetDescriptor?.enumerable || !Object.hasOwn(targetDescriptor, 'value')) throw invalid();
  const target = targetDescriptor.value;
  if (!target || typeof target !== 'object' || Array.isArray(target) || Object.getPrototypeOf(target) !== Object.prototype) throw invalid();
  const targetDescriptors = Object.getOwnPropertyDescriptors(target);
  for (const name of ['stableServerId', 'path']) {
    if (!targetDescriptors[name]?.enumerable || !Object.hasOwn(targetDescriptors[name], 'value')) throw invalid();
  }
  const jobId = jobIdDescriptor.value;
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) throw invalid();
  const stableServerId = targetDescriptors.stableServerId.value ?? null;
  if (stableServerId !== null && (typeof stableServerId !== 'string' || !SERVER_ID_PATTERN.test(stableServerId))) throw invalid();
  const targetPath = targetDescriptors.path.value;
  const normalizedPath = normalizeRecoveryTargetPath(targetPath);
  const envelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    jobId,
    stableServerId,
    targetPathHash: crypto.createHash('sha256').update(normalizedPath, 'utf8').digest('hex'),
    targetLabel: displayLabel(targetPath.replaceAll('/', '\\')),
    checksum: ''
  };
  envelope.checksum = checksum(envelope);
  return Object.freeze(envelope);
}

function verifyRecoveryTargetEnvelope(value) {
  return Object.freeze({ ...assertEnvelopeFields(value) });
}

module.exports = {
  ENVELOPE_SCHEMA_VERSION,
  JOB_ID_PATTERN,
  createRecoveryTargetEnvelope,
  normalizeRecoveryTargetPath,
  verifyRecoveryTargetEnvelope
};
