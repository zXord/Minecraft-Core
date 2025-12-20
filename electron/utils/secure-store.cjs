const { safeStorage } = require('electron');

const ENCRYPTED_PREFIX = 'enc:';

function ensureEncryptionAvailable() {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new Error('Secure storage not available');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is not available on this device');
  }
}

function encryptString(value) {
  ensureEncryptionAvailable();
  if (typeof value !== 'string') {
    throw new Error('Value must be a string');
  }
  const encrypted = safeStorage.encryptString(value);
  return encrypted.toString('base64');
}

function decryptString(value) {
  ensureEncryptionAvailable();
  if (typeof value !== 'string') {
    throw new Error('Encrypted value must be a string');
  }
  const buffer = Buffer.from(value, 'base64');
  return safeStorage.decryptString(buffer);
}

function packSecret(value) {
  if (typeof value !== 'string' || !value.length) return '';
  const encrypted = encryptString(value);
  return `${ENCRYPTED_PREFIX}${encrypted}`;
}

function unpackSecret(value) {
  if (typeof value !== 'string' || !value.length) return '';
  if (!value.startsWith(ENCRYPTED_PREFIX)) {
    return value;
  }
  const payload = value.slice(ENCRYPTED_PREFIX.length);
  return decryptString(payload);
}

module.exports = {
  ensureEncryptionAvailable,
  encryptString,
  decryptString,
  packSecret,
  unpackSecret,
  ENCRYPTED_PREFIX
};
