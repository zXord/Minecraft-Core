const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ModpackError } = require('../services/modpacks/errors.cjs');
const { inspectFolderEvidence } = require('../services/modpacks/instance-ownership.cjs');
const { MAX_ATOMIC_BYTES, MAX_JSON_BYTES, strictJsonClone } = require('./durable-fs.cjs');

// Instance configuration writers (.minecraft-core.json, client-config.json).
//
// A folder without modpack lifecycle evidence ('unmanaged', which is every
// instance a v26.6.1 user has) gets the legacy writer: a plain temp file,
// fsync and rename inside the instance folder, with the v26.6.1 in-place
// fallback when the rename is refused. It needs no ArchiveWorker, makes no
// realpath, reparse, UNC, NFC, basename or root checks, and lets config-manager
// replace an unreadable config after preserving its bytes. Folders with
// evidence, or whose evidence cannot be ruled out, keep the strict writer.
//
// Every legacy failure is an advisory ModpackError. Its commitPhase is
// 'pre-publication' when the target was not touched, or 'legacy-unverified'
// when an in-place write failed after it opened the target. It is never a
// post-publication phase, so a failed legacy write cannot quarantine a server.
//
// Invariant: no modpack lifecycle or recovery code writes .minecraft-core.json
// in place in a live folder that has no lifecycle evidence. Publication writes
// candidate folders (the state repository creates its evidence layout before
// it writes a summary) and swaps them in, so the non-atomic compare-and-set
// below cannot race a native publication. Other processes can still race it,
// as they could race v26.6.1. tests/legacy-writer-invariant.test.cjs pins this.
const LEGACY_CAPABILITY = Symbol('minecraft-core.legacy-instance-config-fs');
const LEGACY_INSTANCE_CONFIG_ADVISORY = Symbol('minecraft-core.legacy-instance-config-advisory');
const TEMP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IN_PLACE_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const HASH_BUFFER_BYTES = 64 * 1024;
const READ_OPTION_KEYS = Object.freeze(['allowMissing', 'maxBytes']);
const WRITE_OPTION_KEYS = Object.freeze(['expectedTargetSha256']);

function legacyFailure(code, message, cause, phase) {
  const error = new ModpackError(code, message, { cause });
  Object.defineProperty(error, 'commitPhase', {
    value: phase,
    enumerable: true,
    configurable: false,
    writable: false
  });
  Object.defineProperty(error, LEGACY_INSTANCE_CONFIG_ADVISORY, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return error;
}

function commitFailed(cause, phase = 'pre-publication') {
  return legacyFailure('COMMIT_FAILED', 'The instance configuration could not be saved', cause, phase);
}

function targetChanged(cause) {
  return legacyFailure('PLAN_STALE', 'The instance configuration changed before it could be saved', cause, 'pre-publication');
}

function isLegacyInstanceConfigAdvisory(error) {
  return Boolean(error) && typeof error === 'object' &&
    Object.getOwnPropertyDescriptor(error, LEGACY_INSTANCE_CONFIG_ADVISORY)?.value === true;
}

function asLegacyFailure(error) {
  return isLegacyInstanceConfigAdvisory(error) ? error : commitFailed(error);
}

function isLegacyInstanceConfigFs(value) {
  return Boolean(value) && typeof value === 'object' &&
    Object.getOwnPropertyDescriptor(value, LEGACY_CAPABILITY)?.value === true;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function plainOptions(options, allowedKeys) {
  if (options === undefined) return {};
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !allowedKeys.includes(key))) throw commitFailed();
  return options;
}

function readOptions(options) {
  const { allowMissing = false, maxBytes = MAX_JSON_BYTES } = plainOptions(options, READ_OPTION_KEYS);
  if (typeof allowMissing !== 'boolean' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      maxBytes > MAX_ATOMIC_BYTES) throw commitFailed();
  return { allowMissing, maxBytes };
}

function writeOptions(options) {
  const { expectedTargetSha256 } = plainOptions(options, WRITE_OPTION_KEYS);
  if (expectedTargetSha256 !== undefined && expectedTargetSha256 !== null &&
      (typeof expectedTargetSha256 !== 'string' || !SHA256_PATTERN.test(expectedTargetSha256))) throw commitFailed();
  return { expectedTargetSha256 };
}

function assertFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0') || !path.isAbsolute(filePath)) {
    throw commitFailed();
  }
  return filePath;
}

function serialize(value) {
  // Byte-identical to createDurableFs().writeJsonAtomic with default limits.
  let serialized;
  try {
    serialized = `${JSON.stringify(strictJsonClone(value), null, 2)}\n`;
  } catch (error) {
    throw commitFailed(error);
  }
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length > MAX_JSON_BYTES) throw commitFailed();
  return bytes;
}

/**
 * The legacy writer for unmanaged instance folders. See the module comment.
 * @returns {{readFileBounded: Function, sha256File: Function, writeJsonAtomic: Function, preserveUnreadable: Function}}
 */
function createLegacyInstanceConfigFs({ fsApi = fs, tempNameFactory = crypto.randomUUID } = {}) {
  if (!fsApi || typeof fsApi !== 'object' || typeof tempNameFactory !== 'function') {
    throw new TypeError('Legacy instance configuration filesystem options are invalid');
  }

  function closeQuietly(descriptor) {
    try {
      fsApi.closeSync(descriptor);
    } catch { /* the primary outcome stands */ }
  }

  function removeQuietly(filePath) {
    try {
      fsApi.unlinkSync(filePath);
      return true;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }

  function readOpenFile(descriptor, maxBytes) {
    const stat = fsApi.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes) throw commitFailed();
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fsApi.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count < 1) throw targetChanged();
      offset += count;
    }
    if (fsApi.readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) throw targetChanged();
    return bytes;
  }

  function hashOpenFile(descriptor) {
    const stat = fsApi.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_ATOMIC_BYTES) throw commitFailed();
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let total = 0;
    for (;;) {
      const count = fsApi.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_ATOMIC_BYTES) throw commitFailed();
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  }

  // The sha256 of the current target, or null when it does not exist.
  function currentSha256(filePath) {
    let descriptor;
    try {
      descriptor = fsApi.openSync(filePath, 'r');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw commitFailed(error);
    }
    try {
      return hashOpenFile(descriptor);
    } catch (error) {
      throw asLegacyFailure(error);
    } finally {
      closeQuietly(descriptor);
    }
  }

  // null means the target must be absent; undefined means no compare-and-set.
  function assertExpectedTarget(filePath, expectedTargetSha256) {
    if (expectedTargetSha256 === undefined) return;
    const current = currentSha256(filePath);
    if (expectedTargetSha256 === null ? current !== null : current !== expectedTargetSha256) throw targetChanged();
  }

  function writeAll(descriptor, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fsApi.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(written) || written < 1 || written > bytes.length - offset) throw commitFailed();
      offset += written;
    }
  }

  function tempPathFor(filePath) {
    let token;
    try {
      token = String(tempNameFactory());
    } catch (error) {
      throw commitFailed(error);
    }
    if (!TEMP_TOKEN_PATTERN.test(token)) throw commitFailed();
    return path.join(path.dirname(filePath), `.${path.basename(filePath)}.minecraft-core-tmp-${token}`);
  }

  function readFileBounded(filePath, options) {
    const { allowMissing, maxBytes } = readOptions(options);
    assertFilePath(filePath);
    let descriptor;
    try {
      descriptor = fsApi.openSync(filePath, 'r');
    } catch (error) {
      if (error?.code === 'ENOENT' && allowMissing) return null;
      throw commitFailed(error);
    }
    try {
      return readOpenFile(descriptor, maxBytes);
    } catch (error) {
      throw asLegacyFailure(error);
    } finally {
      closeQuietly(descriptor);
    }
  }

  function sha256File(filePath) {
    assertFilePath(filePath);
    const digest = currentSha256(filePath);
    if (digest === null) throw targetChanged();
    return digest;
  }

  // v26.6.1 wrote the config in place. Used only when the rename is refused
  // (a sync client or antivirus holding the target, or a read-only file), and
  // it still compare-and-sets.
  function writeInPlace(filePath, bytes, expectedTargetSha256) {
    let descriptor;
    try {
      assertExpectedTarget(filePath, expectedTargetSha256);
      const flag = expectedTargetSha256 === null ? 'wx' : (expectedTargetSha256 === undefined ? 'w' : 'r+');
      descriptor = fsApi.openSync(filePath, flag);
    } catch (error) {
      if (isLegacyInstanceConfigAdvisory(error)) throw error;
      if (error?.code === 'EEXIST' || (error?.code === 'ENOENT' && typeof expectedTargetSha256 === 'string')) {
        throw targetChanged(error);
      }
      throw commitFailed(error);
    }
    try {
      writeAll(descriptor, bytes);
      fsApi.ftruncateSync(descriptor, bytes.length);
      fsApi.fsyncSync(descriptor);
    } catch (error) {
      closeQuietly(descriptor);
      throw commitFailed(error, 'legacy-unverified');
    }
    try {
      fsApi.closeSync(descriptor);
    } catch (error) {
      throw commitFailed(error, 'legacy-unverified');
    }
    return filePath;
  }

  // Flushes and closes a new file exactly once.
  function closeStaged(descriptor) {
    try {
      fsApi.fsyncSync(descriptor);
    } catch (error) {
      closeQuietly(descriptor);
      throw error;
    }
    fsApi.closeSync(descriptor);
  }

  function writeJsonAtomic(filePath, value, options) {
    const { expectedTargetSha256 } = writeOptions(options);
    assertFilePath(filePath);
    const bytes = serialize(value);
    assertExpectedTarget(filePath, expectedTargetSha256);
    const tempPath = tempPathFor(filePath);
    let descriptor = null;
    let tempExists = false;
    try {
      descriptor = fsApi.openSync(tempPath, 'wx');
      tempExists = true;
      writeAll(descriptor, bytes);
      const staged = descriptor;
      descriptor = null;
      closeStaged(staged);
      assertExpectedTarget(filePath, expectedTargetSha256);
      try {
        fsApi.renameSync(tempPath, filePath);
        tempExists = false;
        return filePath;
      } catch (error) {
        if (!IN_PLACE_FALLBACK_CODES.has(error?.code)) throw error;
      }
    } catch (error) {
      throw asLegacyFailure(error);
    } finally {
      if (descriptor !== null) closeQuietly(descriptor);
      if (tempExists) tempExists = !removeQuietly(tempPath);
    }
    try {
      return writeInPlace(filePath, bytes, expectedTargetSha256);
    } finally {
      // A scanner may have held the new temp file too; try once more.
      if (tempExists) removeQuietly(tempPath);
    }
  }

  // Create-only copy '<file>.unreadable-<sha12>' of bytes that cannot be parsed,
  // written before the file is replaced. Empty files are not copied.
  function preserveUnreadable(filePath, bytes) {
    assertFilePath(filePath);
    if (!Buffer.isBuffer(bytes)) throw commitFailed();
    if (bytes.length === 0) return null;
    const preservedPath = `${filePath}.unreadable-${sha256(bytes).slice(0, 12)}`;
    let descriptor;
    try {
      descriptor = fsApi.openSync(preservedPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw commitFailed(error);
      let existing = null;
      try {
        existing = readFileBounded(preservedPath, { maxBytes: bytes.length });
      } catch {
        existing = null;
      }
      if (!existing || !existing.equals(bytes)) throw commitFailed(error);
      return preservedPath;
    }
    try {
      try {
        writeAll(descriptor, bytes);
      } catch (error) {
        closeQuietly(descriptor);
        throw error;
      }
      closeStaged(descriptor);
      return preservedPath;
    } catch (error) {
      // Never leave a partial copy under the content-derived name.
      removeQuietly(preservedPath);
      throw asLegacyFailure(error);
    }
  }

  const capability = {
    readFileBounded,
    sha256File,
    writeJsonAtomic,
    preserveUnreadable
  };
  Object.defineProperty(capability, LEGACY_CAPABILITY, { value: true });
  return Object.freeze(capability);
}

/**
 * Chooses the instance configuration writer for exactly one root, on every
 * call: the legacy writer for an 'unmanaged' folder, otherwise strictFactory.
 */
function createInstanceConfigFsFactory({
  strictFactory,
  inspect = inspectFolderEvidence,
  legacyFs = createLegacyInstanceConfigFs()
} = {}) {
  if (typeof strictFactory !== 'function' || typeof inspect !== 'function' || !isLegacyInstanceConfigFs(legacyFs)) {
    throw new TypeError('Instance configuration filesystem factory options are invalid');
  }
  return function instanceConfigFsFor(roots) {
    const unmanaged = Array.isArray(roots) && roots.length === 1 && typeof roots[0] === 'string' &&
      inspect(roots[0]).state === 'unmanaged';
    return unmanaged ? legacyFs : strictFactory(roots);
  };
}

module.exports = {
  LEGACY_INSTANCE_CONFIG_ADVISORY,
  createInstanceConfigFsFactory,
  createLegacyInstanceConfigFs,
  isLegacyInstanceConfigAdvisory,
  isLegacyInstanceConfigFs
};
