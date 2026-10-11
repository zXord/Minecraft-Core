const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const phases = new Set([
  'queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight',
  'snapshotting', 'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering',
  'starting', 'validating-live', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed', 'cancelling',
  'cancelled', 'rolling-back', 'rolled-back', 'failed', 'recovery-required'
]);
const unsuccessful = new Set(['cancelled', 'rolled-back', 'failed', 'recovery-required']);

function validIdentifier(value) { return typeof value === 'string' && identifier.test(value); }

// Module memory retains identity hints only. Renderer reload intentionally loses them.
export function createVerificationReferences() {
  const references = new Map();
  return Object.freeze({
    get(serverId) {
      if (serverId === undefined || serverId === null || serverId === '') return null;
      if (!validIdentifier(serverId)) throw new TypeError('Invalid verification server identifier');
      return references.get(serverId) || null;
    },
    record(serverId, jobId) {
      if (!validIdentifier(serverId) || !validIdentifier(jobId)) throw new TypeError('Invalid verification reference');
      const previous = references.get(serverId);
      const changed = previous?.jobId !== jobId;
      const reference = changed ? Object.freeze({ serverId, jobId }) : previous;
      references.delete(serverId);
      references.set(serverId, reference);
      if (references.size > 128) references.delete(references.keys().next().value);
      return Object.freeze({ reference, changed });
    }
  });
}

export const verificationSessionReferences = createVerificationReferences();

function record(value, keys = null) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length) throw new TypeError('Invalid display record');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid display property');
  }
  if (keys && (Object.keys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)))) {
    throw new TypeError('Invalid display shape');
  }
  return descriptors;
}
function field(descriptors, key) { return descriptors[key]?.value; }
function canonicalTime(value) {
  return typeof value === 'string' && value.length === 24 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function count(value) {
  if (typeof value !== 'string' || value.length > 16 || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid display count');
  const number = BigInt(value);
  if (number > 9007199254740991n) throw new TypeError('Invalid display count');
  return number;
}
function arrayData(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit ||
      Object.getOwnPropertySymbols(value).length) throw new TypeError('Invalid display array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) throw new TypeError('Invalid display array properties');
  const entries = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Invalid display array entry');
    entries.push(descriptor.value);
  }
  return entries;
}
function safeLabel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !/(?:\b(?:https?|file):\/\/|\\\\|\b[A-Za-z]:[\\/]|\bBearer\s+|\b(?:token|password|secret)\s*[=:])/iu.test(value);
}

// Measure only the outcome, never the log envelope. Rebuild data without invoking
// accessors/toJSON; bounds prevent pathological input from turning display into work.
function outcomeBytes(value) {
  let remaining = 12 * 1024;
  function copy(input, depth = 0) {
    if (depth > 12 || --remaining < 0) throw new TypeError('Oversized outcome');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      remaining -= input.length;
      if (remaining < 0) throw new TypeError('Oversized outcome');
      return input;
    }
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return arrayData(input, 1024).map(item => copy(item, depth + 1));
    const properties = record(input);
    const result = Object.create(null);
    for (const [key, descriptor] of Object.entries(properties)) {
      remaining -= key.length;
      if (remaining < 0) throw new TypeError('Oversized outcome');
      result[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  }
  return new TextEncoder().encode(JSON.stringify(copy(value))).length;
}

// Defensive display projection, not ownership, repair permission, or an IPC parser.
export function projectVerificationAttempt(job, expectedReference) {
  try {
    const expected = record(expectedReference, ['serverId', 'jobId']);
    const serverId = field(expected, 'serverId');
    const jobId = field(expected, 'jobId');
    if (!validIdentifier(serverId) || !validIdentifier(jobId)) return null;
    const envelope = record(job);
    const phase = field(envelope, 'phase');
    if (field(envelope, 'serverId') !== serverId || field(envelope, 'jobId') !== jobId ||
        field(envelope, 'type') !== 'minecraft-core-modpack-job' || field(envelope, 'schemaVersion') !== 1 ||
        !Number.isSafeInteger(field(envelope, 'sequence')) || field(envelope, 'sequence') < 0 ||
        field(envelope, 'operationKind') !== 'verify' || !phases.has(phase)) return null;
    if (unsuccessful.has(phase)) {
      const terminalAt = field(envelope, 'terminalAt');
      return canonicalTime(terminalAt) ? Object.freeze({ serverId, jobId, status: phase, terminalAt }) : null;
    }
    if (phase !== 'completed') return Object.freeze({ serverId, jobId, status: 'in-progress' });
    const outcomeValue = field(envelope, 'outcome');
    const outcome = record(outcomeValue);
    if (field(outcome, 'status') !== 'completed') return null;
    const resultValue = field(outcome, 'result');
    const resultKeys = ['instanceId', 'type', 'contentRevision', 'checkedFiles', 'mismatchCount', 'healthy',
      'repairAvailable', 'repair', 'mismatches', 'verifiedAt'];
    const result = record(resultValue);
    const truncatedKeys = ['shownMismatchCount', 'omittedMismatchCount', 'mismatchesTruncated'];
    const truncated = truncatedKeys.some(key => Object.hasOwn(result, key));
    record(resultValue, truncated ? [...resultKeys, ...truncatedKeys] : resultKeys);
    const contentRevision = field(result, 'contentRevision');
    const verifiedAt = field(result, 'verifiedAt');
    const checkedFiles = field(result, 'checkedFiles');
    const mismatchCount = field(result, 'mismatchCount');
    const checked = count(checkedFiles);
    const total = count(mismatchCount);
    const healthy = field(result, 'healthy');
    if (field(result, 'instanceId') !== serverId || field(result, 'type') !== 'modpack-verification-result' ||
        !Number.isSafeInteger(contentRevision) || contentRevision < 0 || !canonicalTime(verifiedAt) ||
        total > checked || healthy !== (total === 0n)) return null;
    const repair = field(result, 'repair');
    if (total === 0n) {
      if (field(result, 'repairAvailable') !== false || repair !== null) return null;
    } else {
      const metadata = record(repair, ['operationKind', 'mismatchCount']);
      if (field(result, 'repairAvailable') !== true || field(metadata, 'operationKind') !== 'repair' ||
          field(metadata, 'mismatchCount') !== mismatchCount) return null;
    }
    const mismatches = arrayData(field(result, 'mismatches'), 64).map(value => {
      const item = record(value, ['entryName', 'origin', 'role', 'status']);
      const entryName = field(item, 'entryName');
      const origin = field(item, 'origin'); const role = field(item, 'role'); const status = field(item, 'status');
      if (![entryName, origin, role, status].every(safeLabel) || /^[\\/]/u.test(entryName) ||
          /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(entryName)) throw new TypeError('Invalid sample label');
      return Object.freeze({ entryName, origin, role, status });
    });
    const shownMismatchCount = truncated ? field(result, 'shownMismatchCount') : String(mismatches.length);
    const omittedMismatchCount = truncated ? field(result, 'omittedMismatchCount') : '0';
    if (count(shownMismatchCount) !== BigInt(mismatches.length)) return null;
    const omitted = count(omittedMismatchCount);
    if (truncated ? field(result, 'mismatchesTruncated') !== true || omitted === 0n || BigInt(mismatches.length) + omitted !== total
      : BigInt(mismatches.length) !== total) return null;
    if (outcomeBytes(outcomeValue) > 12 * 1024) return null;
    return Object.freeze({ serverId, jobId, status: 'completed', verifiedAt, contentRevision, checkedFiles, mismatchCount,
      healthy, mismatches: Object.freeze(mismatches), shownMismatchCount, omittedMismatchCount, mismatchesTruncated: truncated });
  } catch {
    return null;
  }
}
