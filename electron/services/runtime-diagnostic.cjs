// Informational only: these values never authorize cleanup or process settlement.
const STAGES = new Set([
  'unknown', 'reparse-startup', 'reparse-request', 'reparse-spawn', 'reparse-pipe',
  'reparse-exit', 'reparse-native', 'reparse-protocol', 'managed-target', 'managed-load', 'managed-java', 'managed-prepare',
  'reparse-native-open', 'reparse-native-identity', 'reparse-native-finalpath', 'reparse-native-tag', 'reparse-native-path',
  'managed-verify', 'managed-result', 'java-validation', 'base-preparation',
  'forge-installer', 'forge-library-completion', 'forge-shim', 'forge-finalizer', 'artifact-digest', 'finalizer-load',
  'finalizer-layout', 'finalizer-artifact-collection', 'finalizer-artifact-digest',
  'finalizer-fresh-record', 'finalizer-stability-before-publish', 'finalizer-publish',
  'finalizer-readback', 'finalizer-stability-after-publish', 'finalizer-response',
  'candidate-health-call', 'candidate-properties-check', 'candidate-progress-60',
  'live-health-call', 'live-properties-check', 'live-revision-event', 'live-handoff', 'live-health-publication',
  'exact-snapshot-initial-stat', 'exact-snapshot-initial-type', 'exact-snapshot-initial-symlink',
  'exact-snapshot-initial-links', 'exact-snapshot-initial-size', 'exact-snapshot-initial-reparse',
  'exact-snapshot-open', 'exact-snapshot-opened-stat', 'exact-snapshot-opened-identity',
  'exact-snapshot-opened-type', 'exact-snapshot-opened-symlink', 'exact-snapshot-opened-links',
  'exact-snapshot-opened-size', 'exact-snapshot-read', 'exact-snapshot-read-count',
  'exact-snapshot-accumulated-safe-integer', 'exact-snapshot-accumulated-size',
  'exact-snapshot-yield', 'exact-snapshot-yield-path-stat', 'exact-snapshot-yield-path-missing',
  'exact-snapshot-yield-path-identity', 'exact-snapshot-post-handle-stat', 'exact-snapshot-post-path-stat',
  'exact-snapshot-post-path-missing', 'exact-snapshot-post-handle-identity', 'exact-snapshot-post-path-identity',
  'exact-snapshot-byte-count', 'exact-snapshot-final-reparse', 'exact-snapshot-final-stat',
  'exact-snapshot-final-path-missing', 'exact-snapshot-final-identity', 'exact-snapshot-bytes'
]);
const REASONS = new Set(['unknown', 'io', 'invalid-input', 'identity-changed', 'digest-mismatch', 'limit', 'dependency', 'protocol', 'timeout']);
const OS_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EBUSY', 'EIO', 'ENOSPC', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EROFS', 'EINVAL', 'EXDEV']);

function invalidDiagnostic() {
  return Object.assign(new TypeError('The runtime diagnostic is invalid.'), { code: 'RUNTIME_DIAGNOSTIC_INVALID' });
}

function normalizeRuntimeDiagnostic(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw invalidDiagnostic();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (!keys.includes('stage') || !keys.includes('reason') || keys.length > 4 ||
      keys.some(key => !['stage', 'reason', 'osCode', 'changedIdentityFields'].includes(key) ||
        !Object.hasOwn(descriptors[key], 'value'))) throw invalidDiagnostic();
  const stage = descriptors.stage.value, reason = descriptors.reason.value;
  if (!STAGES.has(stage) || !REASONS.has(reason)) throw invalidDiagnostic();
  const normalized = { stage, reason };
  if (descriptors.osCode) {
    if (reason !== 'io' || !OS_CODES.has(descriptors.osCode.value)) throw invalidDiagnostic();
    normalized.osCode = descriptors.osCode.value;
  }
  if (descriptors.changedIdentityFields) {
    const mask = descriptors.changedIdentityFields.value;
    if (reason !== 'identity-changed' || !Number.isInteger(mask) || mask < 1 || mask > 255) throw invalidDiagnostic();
    normalized.changedIdentityFields = mask;
  }
  return normalized;
}

function runtimeDiagnosticFor(error, stage) {
  try {
    const prior = error && Object.getOwnPropertyDescriptor(error, 'runtimeDiagnostic');
    if (prior && Object.hasOwn(prior, 'value')) {
      try { return normalizeRuntimeDiagnostic(prior.value); } catch { /* do not transport arbitrary details */ }
    }
    const code = error && Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (OS_CODES.has(code)) return normalizeRuntimeDiagnostic({ stage, reason: 'io', osCode: code });
  } catch { /* diagnostic extraction must not replace the actual failure */ }
  return normalizeRuntimeDiagnostic({ stage, reason: 'unknown' });
}

function annotateRuntimeError(error, stage) {
  // Preserve the original Error, including its private exact-close association.
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try { error.runtimeDiagnostic = runtimeDiagnosticFor(error, stage); } catch { /* never mask the original failure */ }
  }
  return error;
}

function runRuntimeStageSync(stage, work) {
  try { return work(); } catch (error) { throw annotateRuntimeError(error, stage); }
}

async function runRuntimeStage(stage, work) {
  try { return await work(); } catch (error) { throw annotateRuntimeError(error, stage); }
}

// Bit order: nlink, dev, ino, mode, size, mtimeMs, ctimeMs, birthtimeMs.
// Call only with actually observed before/after stat evidence.
function changedIdentityFields(left, right) {
  return ['nlink', 'dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs']
    .reduce((mask, key, index) => mask | (left[key] !== right[key] ? 1 << index : 0), 0);
}

module.exports = { normalizeRuntimeDiagnostic, runtimeDiagnosticFor, annotateRuntimeError,
  runRuntimeStage, runRuntimeStageSync, changedIdentityFields };
