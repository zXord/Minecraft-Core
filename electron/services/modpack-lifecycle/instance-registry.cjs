const appStore = require('../../utils/app-store.cjs');
const instanceContext = require('../../utils/instance-context.cjs');

const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { ModpackError, deepFreeze } = require('../modpacks/errors.cjs');
const { normalizeServerDirectoryPath } = require('./server-directory-identity.cjs');

const REQUEST_KEYS = Object.freeze([
  'jobId', 'stableInstanceId', 'name', 'targetPath', 'directoryIdentity'
]);
const VERIFIED_KEYS = Object.freeze([
  'jobId', 'stableInstanceId', 'targetPath', 'directoryIdentity'
]);
const IDENTITY_KEYS = Object.freeze(['volumeSerial', 'fileId']);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The instance registration request is invalid', { cause });
}

function targetExists() {
  return new ModpackError('TARGET_EXISTS', 'The selected server directory is already registered');
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The published server identity cannot be verified', { cause });
}

function commitFailure(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('COMMIT_FAILED', 'The published server could not be registered', { cause });
}

function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.length !== keys.length || names.some(name => !keys.includes(name))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) throw invalid();
  return value;
}

function displayName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || value !== value.normalize('NFC') ||
      Array.from(value).some(character => {
        const point = character.codePointAt(0);
        return point <= 0x1f || point === 0x7f;
      })) throw invalid();
  return value;
}

function identity(value) {
  strictObject(value, IDENTITY_KEYS);
  if (typeof value.volumeSerial !== 'string' || !/^[a-f0-9]{1,32}$/.test(value.volumeSerial) ||
      typeof value.fileId !== 'string' || !/^[a-f0-9]{1,64}$/.test(value.fileId)) throw invalid();
  return Object.freeze({ volumeSerial: value.volumeSerial, fileId: value.fileId });
}

function sameIdentity(left, right) {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId;
}

function normalizeRequest(value, keys = REQUEST_KEYS) {
  strictObject(value, keys);
  return Object.freeze({
    jobId: identifier(value.jobId),
    stableInstanceId: identifier(value.stableInstanceId),
    ...(keys === REQUEST_KEYS ? { name: displayName(value.name) } : {}),
    targetPath: normalizeServerDirectoryPath(value.targetPath),
    directoryIdentity: identity(value.directoryIdentity)
  });
}

function pathKey(value) {
  return normalizeServerDirectoryPath(value).normalize('NFC').toLocaleLowerCase('en-US');
}

function safeInstances(value) {
  let clone;
  try { clone = strictJsonClone(value); } catch (error) { throw commitFailure(error); }
  if (!Array.isArray(clone) || clone.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw commitFailure();
  return clone;
}

class InstanceRegistry {
  constructor(dependencies = {}) {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies) ||
        Object.getPrototypeOf(dependencies) !== Object.prototype || Object.getOwnPropertySymbols(dependencies).length !== 0 ||
        Object.keys(dependencies).some(key => !['appStore', 'instanceContext', 'verifyOwnership'].includes(key))) throw invalid();
    this.appStore = dependencies.appStore || appStore;
    this.instanceContext = dependencies.instanceContext || instanceContext;
    this.verifyOwnership = dependencies.verifyOwnership;
    if (!this.appStore || typeof this.appStore.get !== 'function' || typeof this.appStore.set !== 'function' ||
        !this.instanceContext || typeof this.instanceContext.updateInstances !== 'function' ||
        typeof this.verifyOwnership !== 'function') throw invalid();
  }

  async registerPublishedInstance(value) {
    const request = normalizeRequest(value);
    let verified;
    try {
      verified = normalizeRequest(await this.verifyOwnership(request), VERIFIED_KEYS);
    } catch (error) {
      if (error instanceof ModpackError) throw error;
      if (error?.code === 'RECOVERY_REQUIRED') throw recoveryRequired(error);
      throw recoveryRequired(error);
    }
    if (verified.jobId !== request.jobId || verified.stableInstanceId !== request.stableInstanceId ||
        pathKey(verified.targetPath) !== pathKey(request.targetPath) ||
        !sameIdentity(verified.directoryIdentity, request.directoryIdentity)) throw recoveryRequired();

    try {
      const current = safeInstances(this.appStore.get('instances'));
      const requestedPathKey = pathKey(verified.targetPath);
      const byId = current.filter(item => item.id === request.stableInstanceId);
      const byPath = current.filter(item => typeof item.path === 'string' && (() => {
        try { return pathKey(item.path) === requestedPathKey; } catch { return false; }
      })());
      if (byId.length > 0 || byPath.length > 0) {
        if (byId.length !== 1 || byPath.length !== 1 || byId[0] !== byPath[0] || byId[0].type !== 'server' ||
            byId[0].name !== request.name || pathKey(byId[0].path) !== requestedPathKey) throw targetExists();
        this.instanceContext.updateInstances(current);
        return deepFreeze({ instanceId: request.stableInstanceId, name: request.name, type: 'server' });
      }

      const next = [
        ...current,
        { id: request.stableInstanceId, name: request.name, type: 'server', path: verified.targetPath }
      ];
      this.appStore.set('instances', next);
      const persisted = safeInstances(this.appStore.get('instances'));
      const matches = persisted.filter(item => item.id === request.stableInstanceId ||
        (typeof item.path === 'string' && (() => {
          try { return pathKey(item.path) === requestedPathKey; } catch { return false; }
        })()));
      if (matches.length !== 1 || matches[0].id !== request.stableInstanceId || matches[0].name !== request.name ||
          matches[0].type !== 'server' || pathKey(matches[0].path) !== requestedPathKey) throw commitFailure();
      this.instanceContext.updateInstances(persisted);
      return deepFreeze({ instanceId: request.stableInstanceId, name: request.name, type: 'server' });
    } catch (error) {
      throw commitFailure(error);
    }
  }
}

async function registerPublishedInstance(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.getPrototypeOf(context) !== Object.prototype ||
      Object.getOwnPropertySymbols(context).length !== 0) throw invalid();
  const { instanceRegistry, ...request } = context;
  if (!(instanceRegistry instanceof InstanceRegistry)) throw invalid();
  return instanceRegistry.registerPublishedInstance(request);
}

module.exports = {
  InstanceRegistry,
  registerPublishedInstance
};
