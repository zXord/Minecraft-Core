const path = require('node:path');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { isSafeWindowsBasename, windowsBasenameCollisionKey } = require('../windows-basename.cjs');

const ZIP_MARKERS = Object.freeze([
  { bytes: Buffer.from('504b0304', 'hex'), minimumBytes: 30, signature: 'zip-local' },
  { bytes: Buffer.from('504b0506', 'hex'), minimumBytes: 22, signature: 'zip-empty' },
  { bytes: Buffer.from('504b0606', 'hex'), minimumBytes: 56, signature: 'zip64-eocd' }
]);
const SPLIT_ZIP_MARKERS = Object.freeze([
  Buffer.from('504b0708', 'hex'),
  Buffer.from('504b3030', 'hex')
]);
const RAR4_MARKER = Buffer.from('526172211a0700', 'hex');
const RAR5_MARKER = Buffer.from('526172211a070100', 'hex');
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GROUPING = new Set(['single', 'part-number', 'rar-rxx', 'numbered-volume']);

function invalid() {
  throw new ModpackError('INVALID_REQUEST', 'Archive identity is invalid', { details: { field: 'reviewedNames' } });
}

function unsupported() {
  throw new ModpackError('UNSUPPORTED_ARCHIVE', 'Archive format is not supported');
}

function mismatch(archiveFamily) {
  throw new ModpackError('MAGIC_EXTENSION_MISMATCH', 'Archive content does not match its reviewed type', {
    details: { archiveFamily }
  });
}

function exactKeys(value, required) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
}

function normalizeReviewedNames(value) {
  const keys = ['kind', 'groupingScheme', 'primaryPartId', 'parts'];
  if (!exactKeys(value, keys) || !['single', 'multipart'].includes(value.kind) ||
      !GROUPING.has(value.groupingScheme) || !IDENTIFIER.test(value.primaryPartId || '') ||
      !Array.isArray(value.parts) || value.parts.length < 1) invalid();
  if ((value.kind === 'single') !== (value.parts.length === 1 && value.groupingScheme === 'single')) invalid();
  if (value.kind === 'multipart' && (value.parts.length < 2 || value.groupingScheme === 'single')) invalid();

  const ids = new Set();
  const names = new Set();
  let primary = null;
  for (const part of value.parts) {
    if (!exactKeys(part, ['partId', 'fileName']) || !IDENTIFIER.test(part.partId || '') ||
        !isSafeWindowsBasename(part.fileName) || path.basename(part.fileName) !== part.fileName) invalid();
    const collisionKey = windowsBasenameCollisionKey(part.fileName);
    if (ids.has(part.partId) || names.has(collisionKey)) invalid();
    ids.add(part.partId);
    names.add(collisionKey);
    if (part.partId === value.primaryPartId) primary = part;
  }
  if (!primary) invalid();
  return { ...value, primary };
}

function reviewedNameFamily(reviewed) {
  const name = reviewed.primary.fileName.toLocaleLowerCase('en-US');
  if (name.endsWith('.mrpack')) return 'mrpack';
  if (name.endsWith('.zip')) return 'zip';
  if (name.endsWith('.rar') || /\.r\d\d$/.test(name) || /\.\d{3,}$/.test(name)) return 'rar';
  return 'unsupported';
}

function startsWith(bytes, marker) {
  return bytes.length >= marker.length && bytes.subarray(0, marker.length).equals(marker);
}

function detectArchiveFamily(prefixBytes, reviewedNames) {
  if (!Buffer.isBuffer(prefixBytes)) invalid();
  const reviewed = normalizeReviewedNames(reviewedNames);
  const reviewedFamily = reviewedNameFamily(reviewed);

  if (SPLIT_ZIP_MARKERS.some(marker => startsWith(prefixBytes, marker))) unsupported();

  let detected = null;
  for (const marker of ZIP_MARKERS) {
    if (startsWith(prefixBytes, marker.bytes)) {
      if (prefixBytes.length < marker.minimumBytes) unsupported();
      detected = { kind: 'zip', signature: marker.signature };
      break;
    }
  }
  if (!detected && startsWith(prefixBytes, RAR5_MARKER)) detected = { kind: 'rar5', signature: 'rar5' };
  if (!detected && startsWith(prefixBytes, RAR4_MARKER)) detected = { kind: 'rar4', signature: 'rar4' };
  if (!detected) unsupported();

  if (reviewedFamily === 'unsupported') unsupported();
  if (detected.kind === 'zip') {
    if (reviewedFamily !== 'zip' && reviewedFamily !== 'mrpack') mismatch('zip');
    if (reviewedFamily === 'mrpack' && reviewed.kind !== 'single') mismatch('mrpack');
    return deepFreeze({
      archiveFamily: reviewedFamily === 'mrpack' ? 'mrpack' : 'zip',
      engineFamily: 'zip',
      signature: detected.signature
    });
  }

  if (reviewedFamily !== 'rar') mismatch(detected.kind);
  return deepFreeze({
    archiveFamily: reviewed.kind === 'multipart' ? 'multipart-rar' : detected.kind,
    engineFamily: 'rar',
    signature: detected.signature
  });
}

module.exports = { detectArchiveFamily };
