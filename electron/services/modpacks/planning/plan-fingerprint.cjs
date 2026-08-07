const crypto = require('node:crypto');

const { strictJsonClone } = require('../../../utils/durable-fs.cjs');
const { ModpackError } = require('../errors.cjs');

function invalid() {
  throw new ModpackError('INVALID_REQUEST', 'The preflight plan is invalid');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, 'en-US'))
    .map(key => [key, canonicalize(value[key])]));
}

function computePreflightPlanFingerprint(value) {
  let clone;
  try { clone = strictJsonClone(value); }
  catch { invalid(); }
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) invalid();
  delete clone.fingerprint;
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(clone)), 'utf8').digest('hex');
}

module.exports = { computePreflightPlanFingerprint };
