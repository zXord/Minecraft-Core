const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parentPort } = require('node:worker_threads');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 32 * 1024;
const MAX_REQUEST_ID = 2_147_483_647;
const IDENTITY_KEYS = 'dev,ino,birthtimeNs,mtimeNs,size,nlink,type';
const DECIMAL = /^(?:0|[1-9]\d*)$/u;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)$/u;

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0;
}

function identityFromStat(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    size: stat.size.toString(),
    nlink: stat.nlink.toString(),
    type: stat.isFile() ? 'file' : 'other'
  };
}

function validIdentity(value) {
  return plain(value) && Object.keys(value).join(',') === IDENTITY_KEYS &&
    DECIMAL.test(value.dev) && DECIMAL.test(value.ino) && SIGNED_DECIMAL.test(value.birthtimeNs) &&
    SIGNED_DECIMAL.test(value.mtimeNs) && DECIMAL.test(value.size) && DECIMAL.test(value.nlink) &&
    value.nlink === '1' && value.type === 'file';
}

function sameIdentity(left, right) {
  return IDENTITY_KEYS.split(',').every(key => left[key] === right[key]);
}

function validRequest(value) {
  if (!plain(value) || Object.keys(value).join(',') !== 'version,type,id,path,expectedIdentity' ||
      value.version !== PROTOCOL_VERSION || value.type !== 'hash' || !Number.isSafeInteger(value.id) ||
      value.id < 1 || value.id > MAX_REQUEST_ID || typeof value.path !== 'string' ||
      !path.isAbsolute(value.path) || value.path.includes('\0') ||
      Buffer.byteLength(value.path, 'utf8') > MAX_PATH_BYTES || !validIdentity(value.expectedIdentity)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_MESSAGE_BYTES; }
  catch { return false; }
}

function hashOpenedFile(filePath, expectedIdentity) {
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = identityFromStat(fs.fstatSync(descriptor, { bigint: true }));
    if (!validIdentity(before) || !sameIdentity(before, expectedIdentity)) throw new Error('identity mismatch');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let measured = 0n;
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) throw new Error('invalid read');
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      measured += BigInt(bytesRead);
      if (measured > BigInt(before.size)) throw new Error('size mismatch');
    }
    const after = identityFromStat(fs.fstatSync(descriptor, { bigint: true }));
    if (!validIdentity(after) || !sameIdentity(after, before) || !sameIdentity(after, expectedIdentity) ||
        measured.toString() !== before.size) throw new Error('identity mismatch');
    return {
      sha256: hash.digest('hex'),
      size: measured.toString(),
      identity: before
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function postFailure(id) {
  parentPort.postMessage({ version: PROTOCOL_VERSION, id, ok: false, error: 'HASH_FAILED' });
}

if (!parentPort) process.exit(70);

parentPort.on('message', request => {
  if (!validRequest(request)) process.exit(71);
  try {
    const result = hashOpenedFile(request.path, request.expectedIdentity);
    parentPort.postMessage({ version: PROTOCOL_VERSION, id: request.id, ok: true, result });
  } catch {
    postFailure(request.id);
  }
});
