// Informational only: these values never authorize cleanup or process settlement.
const STAGES = new Set([
  'unknown', 'managed-target', 'managed-load', 'managed-java', 'managed-prepare',
  'managed-verify', 'managed-result', 'java-validation', 'base-preparation',
  'forge-installer', 'forge-library-completion', 'forge-shim', 'forge-finalizer', 'artifact-digest', 'finalizer-load',
  'finalizer-layout', 'finalizer-artifact-collection', 'finalizer-artifact-digest',
  'finalizer-fresh-record', 'finalizer-stability-before-publish', 'finalizer-publish',
  'finalizer-readback', 'finalizer-stability-after-publish', 'finalizer-response'
]);
const REASONS = new Set(['unknown', 'io', 'invalid-input', 'identity-changed', 'digest-mismatch', 'limit', 'dependency', 'protocol']);
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
