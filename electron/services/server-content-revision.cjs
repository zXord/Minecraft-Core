const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ModpackError } = require('./modpacks/errors.cjs');

const SERVER_CONFIG_FILENAME = '.minecraft-core.json';
const CLIENT_CONFIG_FILENAME = 'client-config.json';
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BUMP_OPTION_KEYS = new Set(['expectedRevision', 'operationId', 'durableFs']);
const activeRevisionWrites = new Map();

function invalidRequest(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The request is invalid', { cause });
}

function commitFailure(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('COMMIT_FAILED', 'Unable to update server content revision', { cause });
}

function staleRevision() {
  return new ModpackError('PLAN_STALE', 'The instance changed after this operation started');
}

function normalizeContentRevision(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function assertRevision(value, { canIncrement = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (canIncrement && value >= Number.MAX_SAFE_INTEGER)) {
    throw invalidRequest();
  }
  return value;
}

function assertOperationId(operationId) {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) throw invalidRequest();
  return operationId;
}

function serverKey(serverPath) {
  if (typeof serverPath !== 'string' || serverPath.length === 0 || !path.isAbsolute(serverPath)) throw invalidRequest();
  const resolved = path.resolve(serverPath);
  if (resolved === path.parse(resolved).root) throw invalidRequest();
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function withContentRevisionLock(serverPath, operationId, work) {
  const key = serverKey(serverPath);
  const owner = assertOperationId(operationId);
  if (typeof work !== 'function') throw invalidRequest();
  const active = activeRevisionWrites.get(key);
  if (active) {
    throw new ModpackError('OPERATION_IN_PROGRESS', 'Another operation is already changing this server', {
      details: { operationId: active }
    });
  }
  activeRevisionWrites.set(key, owner);
  try {
    const result = work();
    if (result && typeof result.then === 'function') throw invalidRequest();
    return result;
  } finally {
    if (activeRevisionWrites.get(key) === owner) activeRevisionWrites.delete(key);
  }
}

function resolveRevisionConfig(serverPath) {
  const serverConfigPath = path.join(serverPath, SERVER_CONFIG_FILENAME);
  const clientConfigPath = path.join(serverPath, CLIENT_CONFIG_FILENAME);
  if (fs.existsSync(serverConfigPath) || !fs.existsSync(clientConfigPath)) {
    return { configPath: serverConfigPath, kind: 'server' };
  }
  return { configPath: clientConfigPath, kind: 'client' };
}

function readRawConfig(serverPath) {
  const { configPath } = resolveRevisionConfig(serverPath);
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
      throw new TypeError('Config must be a plain object');
    }
    return parsed;
  } catch (error) {
    throw commitFailure(error);
  }
}

function bumpClientContentRevision(serverPath, expectedRevision, operationId, durableFs) {
  const configPath = path.join(serverPath, CLIENT_CONFIG_FILENAME);
  return withContentRevisionLock(serverPath, operationId, () => {
    const bytes = durableFs.readFileBounded(configPath, {
      allowMissing: false,
      maxBytes: 1024 * 1024
    });
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.getPrototypeOf(parsed) !== Object.prototype) {
      throw new TypeError('Client config must be a plain object');
    }
    const currentRevision = normalizeContentRevision(parsed.contentRevision, 0);
    if (currentRevision !== expectedRevision) throw staleRevision();
    durableFs.writeJsonAtomic(configPath, {
      ...parsed,
      contentRevision: expectedRevision + 1
    }, {
      expectedTargetSha256: crypto.createHash('sha256').update(bytes).digest('hex')
    });
    return expectedRevision + 1;
  });
}

function readContentRevision(serverPath) {
  serverKey(serverPath);
  try {
    return normalizeContentRevision(readRawConfig(serverPath).contentRevision, 0);
  } catch {
    return 0;
  }
}

function bumpContentRevision(serverPath, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !BUMP_OPTION_KEYS.has(key))) throw invalidRequest();
  const { expectedRevision, operationId, durableFs } = options;
  assertRevision(expectedRevision, { canIncrement: true });
  assertOperationId(operationId);
  if (!durableFs || typeof durableFs.writeJsonAtomic !== 'function') throw invalidRequest();

  try {
    if (resolveRevisionConfig(serverPath).kind === 'client') {
      return bumpClientContentRevision(serverPath, expectedRevision, operationId, durableFs);
    }
    const { updateServerConfig } = require('../utils/config-manager.cjs');
    const updated = updateServerConfig(serverPath, {}, {}, {
      expectedContentRevision: expectedRevision,
      nextContentRevision: expectedRevision + 1,
      allowRevisionOverride: true,
      operationId,
      durableFs
    });
    return updated.contentRevision;
  } catch (error) {
    throw commitFailure(error);
  }
}

module.exports = {
  assertOperationId,
  bumpContentRevision,
  normalizeContentRevision,
  readContentRevision,
  withContentRevisionLock
};
