const crypto = require('node:crypto');

const COMPACT_OPERATION_ID_PATTERN = /^op2-[0-9a-f]{32}$/;

function compactOperationIdFromRandomSource(value) {
  return `op2-${crypto.createHash('sha256')
    .update(`minecraft-core-operation\0${value}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function isCompactOperationId(value) {
  return typeof value === 'string' && COMPACT_OPERATION_ID_PATTERN.test(value);
}

module.exports = {
  COMPACT_OPERATION_ID_PATTERN,
  compactOperationIdFromRandomSource,
  isCompactOperationId
};
