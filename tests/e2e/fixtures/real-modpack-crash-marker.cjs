const fs = require('node:fs');
const path = require('node:path');

const MAX_MARKER_BYTES = 4096;

function fail(message, cause = null) {
  return new Error(`The real crash marker ${message}`, cause ? { cause } : undefined);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function statIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs ?? stat.birthtimeMs),
    mtimeNs: String(stat.mtimeNs ?? stat.mtimeMs),
    ctimeNs: String(stat.ctimeNs ?? stat.ctimeMs),
    size: String(stat.size),
    nlink: String(stat.nlink)
  });
}

function isExactFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1 && Number(stat.size) <= MAX_MARKER_BYTES;
}

function sameIdentity(left, right) {
  return Object.keys(left).every(key => left[key] === right[key]);
}

function assertArmedPayload(bytes) {
  let value;
  try { value = JSON.parse(bytes); }
  catch (error) { throw fail('is not armed JSON', error); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['fired', 'rollbackName']) ||
      value.fired !== false || value.rollbackName !== null) {
    throw fail('is not armed for this disposable crash');
  }
}

function closePinnedCrashMarker(pin) {
  if (!pin || typeof pin !== 'object' || pin.closed === true) return;
  pin.closed = true;
  fs.closeSync(pin.descriptor);
}

function openPinnedCrashMarker(markerPath) {
  const resolvedPath = path.resolve(markerPath);
  let descriptor = null;
  try {
    descriptor = fs.openSync(resolvedPath, 'r+');
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    const pathStat = fs.lstatSync(resolvedPath, { bigint: true });
    if (!isExactFile(descriptorStat) || !isExactFile(pathStat) ||
        !sameIdentity(statIdentity(descriptorStat), statIdentity(pathStat)) ||
        comparablePath(fs.realpathSync(resolvedPath)) !== comparablePath(resolvedPath)) {
      throw fail('is linked or redirected');
    }
    const bytes = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(bytes, 'utf8') > MAX_MARKER_BYTES) throw fail('is oversized');
    assertArmedPayload(bytes);
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(statIdentity(descriptorStat), statIdentity(afterRead))) {
      throw fail('changed while it was armed');
    }
    return {
      descriptor,
      markerPath: resolvedPath,
      identity: statIdentity(afterRead),
      closed: false
    };
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (error instanceof Error && error.message.startsWith('The real crash marker ')) throw error;
    throw fail('could not be pinned', error);
  }
}

function writePinnedCrashMarker(pin, value) {
  if (!pin || typeof pin !== 'object' || pin.closed === true || !Number.isInteger(pin.descriptor)) {
    throw fail('pin is invalid or closed');
  }
  const descriptorStat = fs.fstatSync(pin.descriptor, { bigint: true });
  const pathStat = fs.lstatSync(pin.markerPath, { bigint: true });
  if (!isExactFile(descriptorStat) || !isExactFile(pathStat) ||
      !sameIdentity(pin.identity, statIdentity(descriptorStat)) ||
      !sameIdentity(pin.identity, statIdentity(pathStat)) ||
      comparablePath(fs.realpathSync(pin.markerPath)) !== comparablePath(pin.markerPath)) {
    throw fail('changed after it was armed');
  }
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > MAX_MARKER_BYTES) throw fail('payload is oversized');
  fs.ftruncateSync(pin.descriptor, 0);
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(pin.descriptor, bytes, offset, bytes.length - offset, offset);
  }
  fs.fsyncSync(pin.descriptor);
}

function firePinnedCrashMarkerAndTerminate(pin, value, {
  writePinnedCrashMarker: writeMarker = writePinnedCrashMarker,
  closePinnedCrashMarker: closeMarker = closePinnedCrashMarker,
  terminateProcess = () => process.kill(process.pid, 'SIGKILL')
} = {}) {
  if (typeof writeMarker !== 'function' || typeof closeMarker !== 'function' || typeof terminateProcess !== 'function') {
    throw fail('termination dependencies are invalid');
  }
  let markerError = null;
  try {
    writeMarker(pin, value);
  } catch (error) {
    markerError = error;
  }
  try {
    closeMarker(pin);
  } catch (error) {
    markerError = markerError === null
      ? error
      : new AggregateError([markerError, error], 'The real crash marker could not be written or closed');
  }
  try {
    terminateProcess();
  } catch (error) {
    if (markerError !== null) {
      throw new AggregateError([markerError, error], 'The real crash marker failed and the disposable process stayed alive');
    }
    throw error;
  }
  if (markerError !== null) throw markerError;
}

module.exports = {
  closePinnedCrashMarker,
  firePinnedCrashMarkerAndTerminate,
  openPinnedCrashMarker,
  writePinnedCrashMarker
};
