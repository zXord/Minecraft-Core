const crypto = require('node:crypto');
const path = require('node:path');

const { normalizeRuntimeTuple } = require('./modpacks/contracts.cjs');

const ELIGIBLE_OPERATION_KINDS = new Set([
  'install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback'
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const issued = new WeakMap();

function pathIdentity(value) {
  if (typeof value !== 'string' || value.length === 0 ||
      (!path.isAbsolute(value) && !path.win32.isAbsolute(value))) return null;
  if (path.win32.isAbsolute(value)) {
    return path.win32.normalize(value).toLocaleLowerCase('en-US');
  }
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function runtimeIdentity(value) {
  try {
    const runtime = normalizeRuntimeTuple(value);
    if (runtime.loaderFamily !== 'forge') return null;
    return JSON.stringify(runtime);
  } catch {
    return null;
  }
}

function candidateHealthOperationId(jobId) {
  return `health-${crypto.createHash('sha256').update(`candidate:${jobId}`).digest('hex').slice(0, 32)}`;
}

function metadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return null;
  const keys = Object.keys(value);
  const expectedKeys = [
    'candidatePath', 'instanceId', 'jobId', 'operationKind', 'restorePointId', 'restorePointSha256',
    'runtime', 'serverPath', 'sourceRevision'
  ];
  if (keys.length !== expectedKeys.length || keys.some(key => !expectedKeys.includes(key)) ||
      !IDENTIFIER.test(value.instanceId) || !IDENTIFIER.test(value.jobId) ||
      !ELIGIBLE_OPERATION_KINDS.has(value.operationKind) || !IDENTIFIER.test(value.restorePointId) ||
      !SHA256.test(value.restorePointSha256) || !Number.isSafeInteger(value.sourceRevision) ||
      value.sourceRevision < 0) return null;
  const candidatePath = pathIdentity(value.candidatePath);
  const serverPath = pathIdentity(value.serverPath);
  const runtime = runtimeIdentity(value.runtime);
  if (!candidatePath || !serverPath || candidatePath === serverPath || !runtime) return null;
  return Object.freeze({
    candidatePath,
    instanceId: value.instanceId,
    healthOperationId: candidateHealthOperationId(value.jobId),
    jobId: value.jobId,
    operationKind: value.operationKind,
    restorePointId: value.restorePointId,
    restorePointSha256: value.restorePointSha256,
    runtime,
    serverPath,
    sourceRevision: value.sourceRevision
  });
}

function issueForgeCandidateHealthAuthorization(value) {
  const bound = metadata(value);
  if (!bound) throw new TypeError('Invalid Forge candidate health authorization');
  const token = Object.freeze(Object.create(null));
  issued.set(token, bound);
  return token;
}

function isAppIssuedForgeCandidateHealthAuthorization(token, expected = {}) {
  const bound = token && typeof token === 'object' ? issued.get(token) : null;
  if (!bound || !expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'candidatePath' || key === 'serverPath') {
      if (pathIdentity(value) !== bound[key]) return false;
    } else if (key === 'runtime') {
      if (runtimeIdentity(value) !== bound.runtime) return false;
    } else if (!Object.hasOwn(bound, key) || bound[key] !== value) {
      return false;
    }
  }
  return true;
}

module.exports = {
  isAppIssuedForgeCandidateHealthAuthorization,
  issueForgeCandidateHealthAuthorization
};
