'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_SERVER_PROPERTIES_BYTES,
  readEffectiveServerProperty
} = require('../../utils/server-network-properties.cjs');

const LIVE_SERVER_FOLDER_MESSAGE =
  'A Minecraft server that Minecraft Core did not start is still using this folder. Stop it, then retry.';
const DEFAULT_LEVEL_NAME = 'world';
const SESSION_LOCK = 'session.lock';
const LIVE_CODES = new Set(['EBUSY', 'EPERM']);

function evidence(live, code = null) {
  return Object.freeze({ live, code });
}

function propertiesInvalid(cause) {
  return Object.assign(new Error('Server properties are unreadable', { cause }), { code: 'PROPERTIES_INVALID' });
}

async function readServerPropertiesBytes(serverPath, fsPromises) {
  let handle;
  try {
    handle = await fsPromises.open(path.join(serverPath, 'server.properties'), 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_SERVER_PROPERTIES_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_SERVER_PROPERTIES_BYTES) throw propertiesInvalid();
    return buffer.subarray(0, total);
  } finally {
    await handle.close().catch(() => {});
  }
}

// Minecraft reads server.properties as UTF-8 and falls back to ISO-8859-1.
function levelNameFrom(bytes) {
  if (bytes === null) return DEFAULT_LEVEL_NAME;
  let value;
  try {
    value = readEffectiveServerProperty(bytes, 'level-name');
  } catch (utf8Error) {
    try {
      value = readEffectiveServerProperty(Buffer.from(bytes.toString('latin1'), 'utf8'), 'level-name');
    } catch {
      throw propertiesInvalid(utf8Error);
    }
  }
  return value ?? DEFAULT_LEVEL_NAME;
}

// A running Java server (1.15 and later) holds an exclusive lock on
// <level-name>/session.lock. On Windows that lock makes any other read fail
// with EBUSY, so one read-only byte tells whether a server outside this app
// still owns the world. The probe never creates, writes or deletes anything.
async function probeLiveServerFolder(serverPath, { fsPromises = fs.promises } = {}) {
  if (typeof serverPath !== 'string' || !serverPath || !path.isAbsolute(serverPath)) return evidence('unknown', 'INVALID_PATH');
  let lockPath;
  try {
    const levelName = levelNameFrom(await readServerPropertiesBytes(serverPath, fsPromises));
    lockPath = path.join(path.resolve(serverPath, levelName), SESSION_LOCK);
  } catch (error) {
    return evidence('unknown', typeof error?.code === 'string' ? error.code : 'PROPERTIES_INVALID');
  }
  let handle;
  try {
    handle = await fsPromises.open(lockPath, 'r');
    await handle.read(Buffer.alloc(1), 0, 1, 0);
    return evidence(false);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : null;
    if (LIVE_CODES.has(code)) return evidence(true, code);
    if (code === 'ENOENT') return evidence(false, code);
    return evidence('unknown', code);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = {
  LIVE_SERVER_FOLDER_MESSAGE,
  probeLiveServerFolder
};
