const { deepFreeze } = require('../modpacks/errors.cjs');

const PUBLICATION_FAILURE_STAGE = 'durable-move';
const DURABLE_FAILURE_KINDS = new Set([
  'sharing-violation',
  'access-denied',
  'timeout',
  'integrity-failure',
  'io-failure',
  'worker-failure'
]);
const DURABLE_FAILURE_STAGES = new Set([
  'root-open', 'source-open', 'destination-parent-open', 'source-parent-open', 'ancestor-open',
  'preflight-revalidation', 'handle-rename', 'completion-flush', 'published-identity',
  'final-revalidation', 'request'
]);
const FILESYSTEM_FAILURE_STAGE = 'filesystem-operation';
const CANDIDATE_BOOT_FAILURE_STAGE = 'candidate-boot';
const CANDIDATE_BOOT_BOUNDARIES = new Set([
  'health-validation',
  'properties-overlay',
  'java-resolution',
  'runtime-verification',
  'process-launch',
  'readiness',
  'endpoint-verification',
  'shutdown',
  'properties-restore'
]);
const CANDIDATE_BOOT_CATEGORIES = new Set([
  'out-of-memory',
  'runtime-java-mismatch',
  'mod-loading-failure',
  'port-conflict',
  'process-exited',
  'readiness-timeout',
  'health-failure'
]);
const COMMIT_PHASES = new Set([
  'pre-publication',
  'post-publication',
  'post-publication-uncertain'
]);
const FAILURE_CATEGORIES = new Set([
  ...DURABLE_FAILURE_KINDS,
  ...COMMIT_PHASES,
  'publication-failed'
]);

function ownDataValue(value, key) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFailureDiagnostic(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.keys(descriptors).sort();
    const exactFailureShape = (names.length === 2 && names[0] === 'category' && names[1] === 'stage') ||
      (names.length === 3 && names[0] === 'boundary' && names[1] === 'category' && names[2] === 'stage');
    if (!exactFailureShape || Object.values(descriptors).some(
      descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
    )) {
      return null;
    }
    const stage = descriptors.stage.value;
    const category = descriptors.category.value;
    const boundary = descriptors.boundary?.value;
    if (stage === CANDIDATE_BOOT_FAILURE_STAGE) {
      if (names.length !== 3 || typeof boundary !== 'string' || !CANDIDATE_BOOT_BOUNDARIES.has(boundary) ||
          typeof category !== 'string' || !CANDIDATE_BOOT_CATEGORIES.has(category)) return null;
      return deepFreeze({ stage, boundary, category });
    }
    if (![PUBLICATION_FAILURE_STAGE, FILESYSTEM_FAILURE_STAGE].includes(stage) || typeof category !== 'string' ||
        !FAILURE_CATEGORIES.has(category) || (stage === FILESYSTEM_FAILURE_STAGE && !DURABLE_FAILURE_KINDS.has(category)) ||
        (boundary !== undefined &&
          (typeof boundary !== 'string' || !DURABLE_FAILURE_STAGES.has(boundary)))) {
      return null;
    }
    return deepFreeze({ stage, category, ...(boundary === undefined ? {} : { boundary }) });
  } catch {
    return null;
  }
}

function normalizePublicationFailureDiagnostic(value) {
  const normalized = normalizeFailureDiagnostic(value);
  return normalized?.stage === CANDIDATE_BOOT_FAILURE_STAGE ? null : normalized;
}

function candidateBootFailureDiagnosticFromError(error) {
  let current = error;
  const visited = new Set();
  for (let depth = 0; depth < 8 && current &&
      (typeof current === 'object' || typeof current === 'function') && !visited.has(current); depth += 1) {
    visited.add(current);
    const normalized = normalizeFailureDiagnostic(ownDataValue(current, 'candidateBootDiagnostic'));
    if (normalized?.stage === CANDIDATE_BOOT_FAILURE_STAGE) return normalized;
    current = ownDataValue(current, 'cause');
  }
  return null;
}

function filesystemFailureDiagnosticFromError(error) {
  let current = error;
  let durableFailureStage = null;
  const visited = new Set();
  for (let depth = 0; depth < 8 && current &&
      (typeof current === 'object' || typeof current === 'function') && !visited.has(current); depth += 1) {
    visited.add(current);
    const candidateStage = ownDataValue(current, 'durableFailureStage');
    if (durableFailureStage === null && typeof candidateStage === 'string' && DURABLE_FAILURE_STAGES.has(candidateStage)) {
      durableFailureStage = candidateStage;
    }
    const durableFailureKind = ownDataValue(current, 'durableFailureKind');
    if (typeof durableFailureKind === 'string' && DURABLE_FAILURE_KINDS.has(durableFailureKind)) {
      return deepFreeze({
        stage: FILESYSTEM_FAILURE_STAGE,
        category: durableFailureKind,
        ...(durableFailureStage === null ? {} : { boundary: durableFailureStage })
      });
    }
    current = ownDataValue(current, 'cause');
  }
  return null;
}

function publicationFailureDiagnosticFromError(error) {
  const filesystemFailure = filesystemFailureDiagnosticFromError(error);
  if (filesystemFailure) return deepFreeze({
    stage: PUBLICATION_FAILURE_STAGE,
    category: filesystemFailure.category,
    ...(filesystemFailure.boundary ? { boundary: filesystemFailure.boundary } : {})
  });
  let current = error;
  let commitPhase = null;
  const visited = new Set();
  for (let depth = 0; depth < 8 && current &&
      (typeof current === 'object' || typeof current === 'function') && !visited.has(current); depth += 1) {
    visited.add(current);
    const candidatePhase = ownDataValue(current, 'commitPhase');
    if (commitPhase === null && typeof candidatePhase === 'string' && COMMIT_PHASES.has(candidatePhase)) {
      commitPhase = candidatePhase;
    }
    current = ownDataValue(current, 'cause');
  }
  return deepFreeze({
    stage: PUBLICATION_FAILURE_STAGE,
    category: commitPhase || 'publication-failed'
  });
}

function failureDiagnosticFromError(error) {
  return filesystemFailureDiagnosticFromError(error) || candidateBootFailureDiagnosticFromError(error);
}

module.exports = {
  candidateBootFailureDiagnosticFromError,
  failureDiagnosticFromError,
  filesystemFailureDiagnosticFromError,
  normalizeFailureDiagnostic,
  normalizePublicationFailureDiagnostic,
  publicationFailureDiagnosticFromError
};
