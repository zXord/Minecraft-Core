const { TextDecoder } = require('node:util');
const { ModpackError } = require('../errors.cjs');
const {
  MRPACK_MANIFEST_MAX_BYTES,
  manifestInvalid,
  validateMrpackManifest
} = require('./mrpack-schema.cjs');

function parseMrpackManifest(buffer) {
  if (!Buffer.isBuffer(buffer)) throw manifestInvalid('invalid-json');
  if (buffer.length > MRPACK_MANIFEST_MAX_BYTES) {
    throw new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Pack manifest exceeded the configured byte limit', {
      details: { limit: 'maxTechnicalStdoutBytes', actual: String(buffer.length) }
    });
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw manifestInvalid('invalid-json'); }
  let value;
  try { value = JSON.parse(text); }
  catch { throw manifestInvalid('invalid-json'); }
  return validateMrpackManifest(value);
}

module.exports = { MRPACK_MANIFEST_MAX_BYTES, parseMrpackManifest, validateMrpackManifest };
