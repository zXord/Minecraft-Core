const { strictJsonClone } = require('../../utils/durable-fs.cjs');
const { formatProgressBytes } = require('../../utils/progress-bytes.cjs');
const { ModpackError, FAILURE_CODES, deepFreeze } = require('../modpacks/errors.cjs');
const {
  existingSwapCallsiteFromError,
  failureDiagnosticFromError,
  filesystemFailureDiagnosticFromError,
  normalizeFailureDiagnostic,
  publicationFailureDiagnosticFromError
} = require('./publication-failure-diagnostic.cjs');
const { runtimeDiagnosticFromError } = require('./server-runtime-writer-authority.cjs');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_AUTHORITY_KEY = /(?:path|directory|destination|command|argument|executable)/i;
const PLANNING_AUTHORITY_KEY = /(?:path|url|uri|cache|workspace|directory|destination|command|argument|executable|token|secret|password|artifactSetId|inputDirectoryId|outputDirectoryId|planningSessionId)/i;
const PUBLIC_INTERNAL_KEY = /(?:path|url|uri|cache|workspace|directory|destination|command|argument|executable|token|secret|password|provider.?internal|artifactSetId|inputDirectoryId|outputDirectoryId|planningSessionId)/i;
const INTERNAL_ID = /^(?:artifact-set|input|output|planning|workspace|cache)-/i;
const SHA256 = /^[a-f0-9]{64}$/;
const EXECUTION_CHOICE_KEYS = Object.freeze(['acceptEula', 'startAfterInstall', 'restorePointId']);
const MANAGEMENT_OPERATION_KINDS = new Set(['detach', 'uninstall', 'repair', 'rollback-restore-point']);
const MUTATION_RUNTIME_METHODS = Object.freeze([
  'resolveInstance', 'suspendAutoRestart', 'quiesce', 'revalidate', 'createRestorePoint', 'buildCandidate',
  'validateCandidate', 'publishCandidate', 'registerPublishedInstance', 'commitCandidate', 'startFinal',
  'validateLive', 'persistOutcome', 'cleanup', 'rollback', 'abandonCandidate', 'restorePriorState'
]);
const MUTATION_OPERATION_KINDS = new Set([
  'install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair', 'rollback-restore-point', 'detach',
  'import-files-only-new', 'uninstall-managed'
]);
const EULA_REQUIRED_OPERATION_KINDS = new Set([
  'install-new', 'install-existing', 'update', 'downgrade', 'switch', 'repair'
]);
const TERMINAL_JOB_PHASES = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);
const TERMINAL_RESOLUTION_KIND = 'terminal-resolution';
const CANDIDATE_PROGRESS_PHASES = new Set(['staging', 'validating-candidate']);
const MAX_OUTCOME_ACTIONS = 16;
const MAX_PUBLIC_VERIFY_MISMATCHES = 64;
// Leave headroom under OperationStore's unchanged 16 KiB object limit.
const MAX_PUBLIC_VERIFY_OUTCOME_BYTES = 12 * 1024;
const MAX_PUBLIC_INSPECTION_ROOT_CANDIDATES = 4_096;
const SAFE_FAILURE_STEPS = new Set([
  'acquire-mutation', 'suspend-auto-restart', 'quiesce', 'revalidate-plan'
]);
const NEW_SERVER_OPERATION_KINDS = new Set(['install-new', 'import-files-only-new']);
const INSPECTION_PROGRESS_PHASES = new Set(['resolving', 'downloading', 'verifying', 'materialize', 'list', 'validate', 'classify', 'complete']);
const PREFLIGHT_PROGRESS_PHASES = new Set([
  'validating-destination', 'preparing-candidate', 'scanning-server', 'verifying-restore-point', 'calculating-changes',
  'checking-capacity', 'sealing-plan', 'complete'
]);
const PREFLIGHT_PROGRESS_ACTIVITIES = new Set([
  'extracting', 'verifying-archive', 'downloading-pack-files', 'assembling-files', 'hashing-candidate-files'
]);
const MAX_INSPECTION_PROGRESS_BYTES = 16 * 1024 * 1024 * 1024;

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The modpack lifecycle request is invalid', { cause });
}

function stale(cause) {
  return new ModpackError('PLAN_STALE', 'The reviewed modpack plan is stale', { cause });
}

function cancelled(cause) {
  return new ModpackError('CANCELLED', 'The modpack operation was cancelled', { cause });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'The modpack operation requires recovery', { cause });
}

function strictObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.some(name => !allowedKeys.includes(name)) || requiredKeys.some(name => !Object.hasOwn(descriptors, name))) throw invalid();
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return descriptors;
}

function clone(value) {
  try { return strictJsonClone(value); }
  catch (error) { throw invalid(error); }
}

function assertIdentifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid();
  return value;
}

function assertSafeString(value, { allowRemoteUrl = false, allowInternalId = false } = {}) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.normalize('NFC') ||
      /(?:^|\s)[A-Za-z]:[\\/]/u.test(value) || /(?:^|\s)\\\\/u.test(value) || /\bfile:\/\//iu.test(value) ||
      (!allowRemoteUrl && /\bhttps?:\/\//iu.test(value)) || (!allowInternalId && INTERNAL_ID.test(value))) throw invalid();
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) throw invalid();
  }
  return value;
}

function validateClosedValue(value, options, field = 'request', depth = 0) {
  if (depth > 12) throw invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (typeof value === 'string') {
    return assertSafeString(value, {
      allowRemoteUrl: options.allowRemoteUrl,
      allowInternalId: options.allowInternalId || field === 'request.inspectionId'
    });
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000) throw invalid();
    return value.map((item, index) => validateClosedValue(item, options, `${field}.${index}`, depth + 1));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > 512) throw invalid();
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(key)) throw invalid();
    const qualified = `${field}.${key}`;
    const keyAllowed = options.allowedAuthorityKeys?.has(qualified) || options.allowedMetadataKeys?.has(qualified);
    if (!keyAllowed && options.forbiddenKey.test(key)) throw invalid();
    result[key] = validateClosedValue(descriptor.value, options, qualified, depth + 1);
  }
  return result;
}

function sourceRequest(value) {
  const cloned = clone(value);
  return deepFreeze(validateClosedValue(cloned, {
    allowRemoteUrl: true,
    allowInternalId: true,
    forbiddenKey: SOURCE_AUTHORITY_KEY
  }));
}

function planningRequest(value) {
  const cloned = clone(value);
  const normalized = validateClosedValue(cloned, {
    allowRemoteUrl: false,
    allowInternalId: false,
    forbiddenKey: PLANNING_AUTHORITY_KEY,
    allowedAuthorityKeys: new Set([
      'request.inspectionId',
      'request.selections.conflictChoices.paths'
    ])
  });
  assertIdentifier(normalized.inspectionId);
  return deepFreeze(normalized);
}

function managementPlanningRequest(value) {
  const descriptors = strictObject(value, ['instanceId', 'operationKind', 'selectionRef'], ['instanceId', 'operationKind']);
  const instanceId = assertIdentifier(descriptors.instanceId.value);
  const operationKind = descriptors.operationKind.value;
  if (!MANAGEMENT_OPERATION_KINDS.has(operationKind)) throw invalid();
  const selectionRef = descriptors.selectionRef?.value ?? null;
  if (selectionRef !== null) assertIdentifier(selectionRef);
  if (operationKind === 'rollback-restore-point' && selectionRef === null) throw invalid();
  if (['detach', 'uninstall'].includes(operationKind) && selectionRef !== null) throw invalid();
  return deepFreeze({ instanceId, operationKind, selectionRef });
}

function publicView(value) {
  const cloned = clone(value);
  const normalized = validateClosedValue(cloned, {
    allowRemoteUrl: false,
    allowInternalId: false,
    forbiddenKey: PUBLIC_INTERNAL_KEY,
    allowedAuthorityKeys: new Set(['public.inspectionId']),
    allowedMetadataKeys: new Set([
      'public.limitEvidence.totals.directoryCount',
      'public.limitEvidence.totals.maximumPathLength'
    ])
  }, 'public');
  return deepFreeze(normalized);
}

function publicVerificationOutcome(outcome, instanceId, fullResult) {
  const { mismatches } = fullResult;
  if (!Array.isArray(mismatches) || fullResult.mismatchCount !== String(mismatches.length) ||
      fullResult.healthy !== (mismatches.length === 0)) throw invalid();
  const result = {
    instanceId,
    type: fullResult.type,
    contentRevision: fullResult.contentRevision,
    checkedFiles: fullResult.checkedFiles,
    mismatchCount: fullResult.mismatchCount,
    healthy: fullResult.healthy,
    repairAvailable: fullResult.repairAvailable,
    repair: fullResult.repair === null ? null : {
      operationKind: fullResult.repair.operationKind,
      mismatchCount: fullResult.repair.mismatchCount
    },
    mismatches: [],
    verifiedAt: fullResult.verifiedAt
  };
  const projected = { ...outcome, result };
  const updateSampleCounts = () => {
    result.shownMismatchCount = String(result.mismatches.length);
    result.omittedMismatchCount = String(mismatches.length - result.mismatches.length);
    result.mismatchesTruncated = result.mismatches.length < mismatches.length;
  };
  // Omit labels needing shortening or redaction: displayed names are complete
  // relative labels, never shortened filesystem/action capabilities. The store
  // remains the final redaction boundary; these checks also prevent redaction
  // expansion from invalidating the measured UTF-8 budget.
  const safeLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !/(?:\b(?:https?|file):\/\/|\\\\|\b[A-Za-z]:[\\/]|\bBearer\s+|\b(?:token|password|secret)\s*[=:])/iu.test(value);
  for (const mismatch of mismatches) {
    if (result.mismatches.length >= MAX_PUBLIC_VERIFY_MISMATCHES) break;
    if (![mismatch.entryName, mismatch.origin, mismatch.role, mismatch.status].every(safeLabel) ||
        /^[\\/]/u.test(mismatch.entryName) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(mismatch.entryName)) continue;
    result.mismatches.push({
      entryName: mismatch.entryName, origin: mismatch.origin, role: mismatch.role, status: mismatch.status
    });
    updateSampleCounts();
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MAX_PUBLIC_VERIFY_OUTCOME_BYTES) {
      result.mismatches.pop();
    }
  }
  updateSampleCounts();
  if (!result.mismatchesTruncated) {
    // Existing small results retain their public DTO shape.
    delete result.shownMismatchCount;
    delete result.omittedMismatchCount;
    delete result.mismatchesTruncated;
  }
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MAX_PUBLIC_VERIFY_OUTCOME_BYTES) throw invalid();
  return projected;
}

function boundedPublicRootCandidates(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length <= MAX_PUBLIC_INSPECTION_ROOT_CANDIDATES) return value;
  return value.slice(0, MAX_PUBLIC_INSPECTION_ROOT_CANDIDATES);
}

function publicInspectionProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const projected = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
    // Archive entries are persisted for planning/extraction, but are too large
    // for the renderer-facing inspection result.
    if (key === 'entries') continue;
    projected[key] = key === 'rootCandidates'
      ? boundedPublicRootCandidates(descriptor.value)
      : descriptor.value;
  }
  return projected;
}

function defaultYieldControl() {
  return new Promise(resolve => setImmediate(resolve));
}

function createActiveOperation(controller) {
  let resolveSettled;
  let isSettled = false;
  let isSettling = false;
  const settled = new Promise(resolve => { resolveSettled = resolve; });
  return Object.freeze({
    abort() {
      if (isSettling || isSettled) return false;
      controller.abort();
      return true;
    },
    beginSettlement() {
      if (isSettled) return false;
      isSettling = true;
      return true;
    },
    isSettling() { return isSettling; },
    settled,
    settle() {
      if (isSettled) return false;
      isSettling = true;
      isSettled = true;
      resolveSettled();
      return true;
    }
  });
}

function terminalResolution(jobId, request) {
  return deepFreeze({ kind: TERMINAL_RESOLUTION_KIND, jobId, request });
}

function progressBytes(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INSPECTION_PROGRESS_BYTES) return value;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed <= MAX_INSPECTION_PROGRESS_BYTES) return parsed;
  }
  return null;
}

function normalizeInspectionProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !INSPECTION_PROGRESS_PHASES.has(value.phase)) return null;
  const event = { phase: value.phase };
  const transferredBytes = progressBytes(value.transferredBytes ?? value.setBytes ?? value.measuredBytes);
  const totalBytes = progressBytes(value.totalBytes);
  if (transferredBytes !== null) event.transferredBytes = transferredBytes;
  if (totalBytes !== null) event.totalBytes = totalBytes;
  if (transferredBytes !== null && totalBytes !== null && totalBytes > 0) {
    event.percent = Math.min(100, Math.floor((transferredBytes * 100) / totalBytes));
  }
  return deepFreeze(event);
}

function inspectionProgressReporter(callback) {
  if (callback === undefined) return () => {};
  if (typeof callback !== 'function') throw invalid();
  return value => {
    const event = normalizeInspectionProgress(value);
    if (!event) return;
    try {
      Promise.resolve(callback(event)).catch(() => {});
    } catch { /* renderer progress is best effort */ }
  };
}

function inspectionOptions(value) {
  const descriptors = strictObject(value, ['onProgress', 'signal'], []);
  const onProgress = descriptors.onProgress?.value;
  const signal = descriptors.signal?.value;
  if (onProgress !== undefined && typeof onProgress !== 'function') throw invalid();
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invalid();
  return { onProgress, signal };
}

function preflightOptions(value) {
  const descriptors = strictObject(value, ['onProgress'], []);
  const onProgress = descriptors.onProgress?.value;
  if (onProgress !== undefined && typeof onProgress !== 'function') throw invalid();
  return { onProgress };
}

function preflightProgressReporter(callback) {
  if (callback === undefined) return () => {};
  if (typeof callback !== 'function') throw invalid();
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !PREFLIGHT_PROGRESS_PHASES.has(value.phase)) return;
    const event = { phase: value.phase };
    if (value.activity !== undefined) {
      const validActivity = PREFLIGHT_PROGRESS_ACTIVITIES.has(value.activity) && (
        value.phase === 'preparing-candidate' ||
        (value.phase === 'verifying-restore-point' && value.activity === 'verifying-archive')
      );
      if (!validActivity) return;
      event.activity = value.activity;
    }
    for (const [completed, total] of [
      ['completedItems', 'totalItems'], ['processedBytes', 'totalBytes']
    ]) {
      const hasCompleted = value[completed] !== undefined;
      const hasTotal = value[total] !== undefined;
      if (hasCompleted !== hasTotal) return;
      if (!hasCompleted) continue;
      const completedValue = Number(value[completed]);
      const totalValue = Number(value[total]);
      if (!Number.isSafeInteger(completedValue) || completedValue < 0 ||
          !Number.isSafeInteger(totalValue) || totalValue < 0 || completedValue > totalValue ||
          !['preparing-candidate', 'verifying-restore-point'].includes(value.phase)) return;
      event[completed] = completedValue;
      event[total] = totalValue;
    }
    try {
      Promise.resolve(callback(deepFreeze(event))).catch(() => {});
    } catch { /* renderer progress is best effort */ }
  };
}

function throwIfInspectionCancelled(signal) {
  if (signal?.aborted) throw cancelled();
}

function inspectionFailure(error, signal) {
  if (error instanceof ModpackError && error.code === 'CANCELLED') return error;
  if (signal?.aborted || error?.code === 'ABORT_ERR') return cancelled(error);
  return error;
}

function executionChoices(value) {
  const descriptors = strictObject(value, EXECUTION_CHOICE_KEYS, []);
  const acceptEula = descriptors.acceptEula?.value ?? false;
  const startAfterInstall = descriptors.startAfterInstall?.value ?? false;
  const restorePointId = descriptors.restorePointId?.value ?? null;
  if (typeof acceptEula !== 'boolean' || typeof startAfterInstall !== 'boolean' ||
      (restorePointId !== null && (typeof restorePointId !== 'string' || !IDENTIFIER.test(restorePointId)))) throw invalid();
  return deepFreeze({ acceptEula, startAfterInstall, restorePointId });
}

function candidateProgress(value) {
  const descriptors = strictObject(value, ['phase', 'percent', 'message', 'currentItem']);
  const phase = descriptors.phase.value;
  const percent = descriptors.percent.value;
  const message = assertSafeString(descriptors.message.value);
  if (!CANDIDATE_PROGRESS_PHASES.has(phase) || !Number.isSafeInteger(percent) || percent < 36 || percent > 63 ||
      message.length < 1 || message.length > 512 || descriptors.currentItem.value !== null) throw invalid();
  return deepFreeze({ phase, percent, message, currentItem: null });
}

const RESTORE_ACTIVITIES = [
  ['prepare-scope', 'Scanning current server files for the recovery snapshot', 'scope'],
  ['creation-scope', 'Rechecking server files before saving the recovery snapshot', 'scope'],
  ['archive-source-check', 'Checking snapshot source files before archive creation', 'scope'],
  ['archive-write', 'Saving the recovery snapshot', 'archive-write'],
  ['part-initial-hash', 'Checking the saved snapshot archive', 'archive-hash', 'initial'],
  ['part-entry-verify', 'Verifying saved snapshot files', 'entry-verify'],
  ['part-final-hash', 'Rechecking the saved archive after file verification', 'archive-hash', 'final'],
  ['source-recheck', 'Rechecking server files after saving the snapshot', 'scope'],
  ['publication', 'Publishing and checking the recovery snapshot', 'publication'],
  ['published-initial-hash', 'Checking the published snapshot archive', 'archive-hash', 'initial'],
  ['published-entry-verify', 'Verifying published snapshot files', 'entry-verify'],
  ['published-final-hash', 'Rechecking the published archive after file verification', 'archive-hash', 'final'],
  ['record-reference', 'Recording the verified recovery snapshot', 'record-reference']
];
const RESTORE_RECONCILIATION = [
  'publication-reconciliation', 'Reconciling and checking the published recovery snapshot', 'publication'
];

function restorePointCreationProgress(value) {
  const keys = ['phase', 'activity', 'kind', 'hashPass', 'processedBytes', 'totalBytes', 'entriesProcessed', 'entriesTotal'];
  const descriptors = strictObject(value, keys, ['phase']);
  const read = key => descriptors[key]?.value;
  if (read('phase') === 'complete') {
    if (Object.keys(descriptors).length !== 1) throw invalid();
    return { rank: 14, kind: 'complete' };
  }
  const rank = read('activity') === RESTORE_RECONCILIATION[0] ? 13 :
    RESTORE_ACTIVITIES.findIndex(([activity]) => activity === read('activity'));
  if (rank < 0) throw invalid();
  const [, , phase, hashPass] = rank === 13 ? RESTORE_RECONCILIATION : RESTORE_ACTIVITIES[rank];
  const kind = read('kind');
  const processedBytes = read('processedBytes');
  const totalBytes = read('totalBytes');
  if (read('phase') !== phase || read('hashPass') !== hashPass ||
      (hashPass === undefined && descriptors.hashPass !== undefined) ||
      !['start', 'progress'].includes(kind) || !Number.isSafeInteger(processedBytes) || processedBytes < 0) throw invalid();
  const measured = ['archive-write', 'archive-hash', 'entry-verify'].includes(phase);
  if (measured ? !Number.isSafeInteger(totalBytes) || totalBytes < processedBytes :
      totalBytes !== null || processedBytes !== 0 || kind !== 'start') throw invalid();
  const entriesProcessed = read('entriesProcessed');
  const entriesTotal = read('entriesTotal');
  if (phase === 'archive-write') {
    if (!Number.isSafeInteger(entriesProcessed) || entriesProcessed < 0 ||
        !Number.isSafeInteger(entriesTotal) || entriesTotal < entriesProcessed) throw invalid();
  } else if (descriptors.entriesProcessed || descriptors.entriesTotal) throw invalid();
  if (kind === 'start' && (processedBytes !== 0 || (entriesProcessed ?? 0) !== 0)) throw invalid();
  return { rank, kind, processedBytes, totalBytes, entriesProcessed, entriesTotal };
}

function snapshotMessage(sample, lastPercent) {
  if (sample.kind === 'complete') return {
    phase: 'snapshotting', percent: 34, message: 'Verified recovery snapshot ready', currentItem: null
  };
  const details = [];
  if (sample.entriesTotal > 0) details.push(`${sample.entriesProcessed} of ${sample.entriesTotal} files`);
  if (sample.totalBytes > 0) {
    const bytes = formatProgressBytes(sample.processedBytes, sample.totalBytes);
    if (bytes !== null) details.push(bytes);
  }
  const ratio = (steps, processed = sample.processedBytes, total = sample.totalBytes) =>
    total > 0 ? Math.floor(processed * steps / total) : 0;
  let percent = 16;
  if (sample.rank === 3) percent = 17 + Math.min(7, sample.totalBytes > 0 ? ratio(7) : ratio(7, sample.entriesProcessed, sample.entriesTotal));
  else if (sample.rank === 4) percent = 25 + Math.min(3, ratio(3));
  else if (sample.rank === 5) percent = 29 + Math.min(4, ratio(4));
  const label = (sample.rank === 13 ? RESTORE_RECONCILIATION : RESTORE_ACTIVITIES[sample.rank])[1];
  return {
    phase: 'snapshotting', percent: Math.max(lastPercent, percent),
    message: details.length ? `${label} (${details.join(', ')})` : label, currentItem: null
  };
}

function createRestorePointCreationProgressQueue(onProgress, clock) {
  let active = false;
  let lastRank = -1;
  let lastPercent = 16;
  let failure = null;
  const pending = [];
  const idleWaiters = [];
  const activities = new Map();
  const fail = error => {
    failure = error;
    pending.splice(0);
    for (const state of activities.values()) state.reject(error);
  };
  const pump = async () => {
    if (active || failure !== null) return;
    active = true;
    try {
      while (pending.length && failure === null) {
        const sample = pending.shift();
        const state = activities.get(sample.rank);
        try {
          await onProgress(() => {
            if (sample.kind === 'progress') {
              const now = clock();
              if (now - state.epoch < 10_000) return null;
              state.epoch = now;
            }
            const progress = snapshotMessage(sample, lastPercent);
            lastPercent = progress.percent;
            return progress;
          });
          if (sample.kind === 'start') {
            state.epoch = clock();
            state.resolve();
          }
        } catch (error) { fail(error); }
      }
    } finally {
      active = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };
  return {
    push(value) {
      const sample = restorePointCreationProgress(value);
      if (failure !== null) {
        if (sample.kind !== 'start') return;
        const receipt = Promise.reject(failure);
        void receipt.catch(() => {});
        return receipt;
      }
      if (sample.kind === 'complete') {
        pending.push(sample);
      } else if (sample.kind === 'start') {
        const prior = activities.get(sample.rank);
        if (prior) {
          if (prior.totalBytes !== sample.totalBytes || prior.entriesTotal !== sample.entriesTotal) throw invalid();
          return prior.receipt;
        }
        const allowed = lastRank === -1 ? [0, 1].includes(sample.rank) :
          sample.rank === 13 ? [8, 9, 10, 11].includes(lastRank) :
          lastRank === 13 ? sample.rank === 12 : sample.rank === lastRank + 1;
        if (!allowed) throw invalid();
        lastRank = sample.rank;
        let resolve;
        let reject;
        const receipt = new Promise((yes, no) => { resolve = yes; reject = no; });
        void receipt.catch(() => {});
        activities.set(sample.rank, { ...sample, receipt, resolve, reject, epoch: null });
        for (let index = pending.length - 1; index >= 0; index--) {
          if (pending[index].kind === 'progress') pending.splice(index, 1);
        }
        pending.push(sample);
        void pump();
        return receipt;
      } else {
        if (sample.rank < lastRank) return;
        const state = activities.get(sample.rank);
        if (!state || sample.rank !== lastRank || state.totalBytes !== sample.totalBytes ||
            state.entriesTotal !== sample.entriesTotal) throw invalid();
        if (sample.processedBytes < state.processedBytes ||
            (sample.entriesProcessed ?? 0) < (state.entriesProcessed ?? 0)) return;
        state.processedBytes = sample.processedBytes;
        state.entriesProcessed = sample.entriesProcessed;
        const index = pending.findIndex(item => item.rank === sample.rank && item.kind === 'progress');
        if (index < 0) pending.push(sample);
        else pending[index] = sample;
      }
      void pump();
    },
    async drain() {
      while (active || pending.length) await new Promise(resolve => idleWaiters.push(resolve));
      if (failure !== null) throw failure;
    }
  };
}

function normalizeIssuedActions(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_OUTCOME_ACTIONS) throw invalid();
  const seen = new Set();
  return value.map(item => {
    const descriptors = strictObject(item, ['actionId', 'opaqueRef']);
    const actionId = assertIdentifier(descriptors.actionId.value);
    const opaqueRef = assertIdentifier(descriptors.opaqueRef.value);
    if (seen.has(actionId)) throw invalid();
    seen.add(actionId);
    return { actionId, opaqueRef };
  });
}

function hasVerifiedRetainedArtifact(plan) {
  const artifact = plan?.artifact;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) ||
      !SHA256.test(artifact.setDigest || '') || !Array.isArray(artifact.parts) || artifact.parts.length < 1) return false;
  const partIds = new Set();
  for (const part of artifact.parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part) ||
        typeof part.partId !== 'string' || !IDENTIFIER.test(part.partId) || partIds.has(part.partId) ||
        typeof part.measuredSize !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(part.measuredSize) ||
        !SHA256.test(part.sha256 || '')) return false;
    partIds.add(part.partId);
  }
  return true;
}

function mutationOperationKind(plan) {
  const operation = plan?.operation;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw stale();
  let kind;
  if (operation.kind === 'install') {
    if (operation.serverKind === 'new') kind = 'install-new';
    else if (operation.serverKind === 'existing') kind = 'install-existing';
  } else if (operation.kind === 'files-only' && operation.serverKind === 'new' &&
      plan.requirements?.filesOnlySafetyConfirmed === true && plan.inspection?.kind === 'files-only') {
    kind = 'import-files-only-new';
  } else if (operation.kind === 'uninstall' && operation.serverKind === 'existing') {
    const confirmation = plan.ownership?.confirmation;
    if (!confirmation || typeof confirmation.unchangedManagedRemovalCount !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(confirmation.unchangedManagedRemovalCount) ||
        !Array.isArray(confirmation.preservedCategories) || typeof confirmation.possibleNonRunnable !== 'boolean' ||
        confirmation.instanceRetained !== true || confirmation.worldsRetained !== true) throw stale();
    kind = 'uninstall-managed';
  } else if (operation.kind === 'upgrade') {
    kind = 'update';
  } else if (['downgrade', 'switch', 'repair', 'rollback-restore-point', 'detach'].includes(operation.kind)) {
    kind = operation.kind;
  }
  if (!MUTATION_OPERATION_KINDS.has(kind) || typeof operation.instanceId !== 'string' ||
      !IDENTIFIER.test(operation.instanceId) || !Number.isSafeInteger(operation.expectedContentRevision) ||
      operation.expectedContentRevision < 0) throw stale();
  return kind;
}

function selectedPinnedRestorePoint(plan, choices) {
  if (!Array.isArray(plan.restorePoints) || choices.restorePointId === null) return null;
  return plan.restorePoints.find(point => point && typeof point === 'object' && point.id === choices.restorePointId) || null;
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'COMMIT_FAILED';
}

function safeFailureLogMessage(error) {
  if (!(error instanceof ModpackError)) return 'The operation stopped before the server changed';
  const descriptor = Object.getOwnPropertyDescriptor(error, 'safeMessage');
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value
    : 'The operation stopped before the server changed';
}

function safeFailureField(error) {
  if (!(error instanceof ModpackError) || error.code !== 'PLAN_STALE') return null;
  try {
    const details = Object.getOwnPropertyDescriptor(error, 'details');
    if (!details || !Object.hasOwn(details, 'value')) return null;
    const value = details.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const field = Object.getOwnPropertyDescriptor(value, 'field');
    return field && Object.hasOwn(field, 'value') &&
      typeof field.value === 'string' && /^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(field.value)
      ? field.value
      : null;
  } catch {
    return null;
  }
}

function destinationRecoveryFailureReason(error, { operationKind, failureStep } = {}) {
  if (!NEW_SERVER_OPERATION_KINDS.has(operationKind) || failureStep !== 'acquire-mutation' ||
      !(error instanceof ModpackError)) return null;
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    const details = Object.getOwnPropertyDescriptor(error, 'details');
    if (!code || !Object.hasOwn(code, 'value') || code.value !== 'RECOVERY_REQUIRED' ||
        !details || !Object.hasOwn(details, 'value')) return null;
    const value = details.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const operationId = Object.getOwnPropertyDescriptor(value, 'operationId');
    return operationId && Object.hasOwn(operationId, 'value') &&
      typeof operationId.value === 'string' && IDENTIFIER.test(operationId.value)
      ? 'destination-recovery'
      : null;
  } catch {
    return null;
  }
}

function publicSource(source) {
  if (!source) return null;
  const common = {
    provider: source.provider,
    version: source.version,
    title: source.title
  };
  if (source.provider === 'github') {
    return {
      ...common,
      repositoryId: source.repositoryId,
      releaseId: source.releaseId,
      githubOwner: source.githubOwner,
      githubRepo: source.githubRepo,
      ...(source.channel === undefined ? {} : {
        channel: source.channel,
        prerelease: source.prerelease,
        publishedAt: source.publishedAt
      })
    };
  }
  if (source.provider === 'modrinth') {
    return {
      ...common,
      projectId: source.projectId,
      versionId: source.versionId,
      ...(source.channel === undefined ? {} : {
        channel: source.channel,
        prerelease: source.prerelease,
        publishedAt: source.publishedAt
      })
    };
  }
  if (source.provider === 'local') {
    return { ...common, importId: source.importId, artifactSha256: source.artifactSha256 };
  }
  throw invalid();
}

function publicHistoryEntry(entry) {
  const result = {
    schemaVersion: entry.schemaVersion,
    operationId: entry.operationId,
    sequence: entry.sequence,
    kind: entry.kind,
    outcome: entry.outcome,
    timestamp: entry.timestamp,
    sourceRevision: entry.sourceRevision,
    targetRevision: entry.targetRevision
  };
  for (const key of ['restorePointId', 'restorePointSha256', 'sourceRuntime', 'targetRuntime']) {
    if (entry[key] !== undefined) result[key] = clone(entry[key]);
  }
  return result;
}

function assertResolvedInstance(value, expectedInstanceId) {
  const descriptors = strictObject(value, ['instanceId', 'serverPath', 'priorRunning']);
  const instanceId = descriptors.instanceId.value;
  const serverPath = descriptors.serverPath.value;
  const priorRunning = descriptors.priorRunning.value;
  if (instanceId !== expectedInstanceId || typeof serverPath !== 'string' || serverPath.length < 1 ||
      typeof priorRunning !== 'boolean') throw stale();
  return deepFreeze({ instanceId, serverPath, priorRunning });
}

class ModpackLifecycleService {
  constructor({
    sourceResolver,
    artifactDownloader,
    archiveInspector,
    inspectionLoader,
    planningAdapter,
    planRegistry,
    operationStore,
    mutationCoordinator = null,
    mutationRuntime = null,
    instanceResolver = null,
    stateRepository = null,
    stateEventSink = null,
    outcomeActionIssuer = null,
    workspaceRegistry = inspectionLoader?.workspaceRegistry ?? planRegistry?.workspaceRegistry ?? null,
    yieldControl = defaultYieldControl,
    snapshotProgressClock = () => performance.now()
  } = {}) {
    if (!sourceResolver || typeof sourceResolver.resolveArtifactSetPlan !== 'function' ||
        !artifactDownloader || typeof artifactDownloader.downloadSet !== 'function' ||
        !archiveInspector || typeof archiveInspector.inspectArchive !== 'function' ||
        !inspectionLoader || typeof inspectionLoader.loadInspection !== 'function' ||
        !planningAdapter || typeof planningAdapter.createPlan !== 'function' ||
        !planRegistry || typeof planRegistry.create !== 'function' || typeof planRegistry.get !== 'function' ||
        typeof planRegistry.claim !== 'function' ||
        !operationStore || typeof operationStore.get !== 'function' || typeof operationStore.requestCancellation !== 'function' ||
        (stateEventSink !== null && typeof stateEventSink !== 'function') ||
        (outcomeActionIssuer !== null && (!outcomeActionIssuer || typeof outcomeActionIssuer.issue !== 'function')) ||
        (workspaceRegistry !== null && (!workspaceRegistry || typeof workspaceRegistry.releaseOwner !== 'function')) ||
        typeof yieldControl !== 'function' || typeof snapshotProgressClock !== 'function') {
      throw invalid();
    }
    this.sourceResolver = sourceResolver;
    this.artifactDownloader = artifactDownloader;
    this.archiveInspector = archiveInspector;
    this.inspectionLoader = inspectionLoader;
    this.planningAdapter = planningAdapter;
    this.planRegistry = planRegistry;
    this.operationStore = operationStore;
    this.mutationCoordinator = mutationCoordinator;
    this.mutationRuntime = mutationRuntime;
    this.instanceResolver = instanceResolver;
    this.stateRepository = stateRepository;
    this.stateEventSink = stateEventSink;
    this.outcomeActionIssuer = outcomeActionIssuer;
    this.workspaceRegistry = workspaceRegistry;
    this.yieldControl = yieldControl;
    this.snapshotProgressClock = snapshotProgressClock;
    this.inspections = new Map();
    this.activeOperations = new Map();
    this.releasedClaims = new Set();
  }

  async dispose() {
    const inspectionIds = [...this.inspections.keys()];
    if (inspectionIds.length === 0) return 0;
    if (!this.workspaceRegistry) throw invalid();
    let firstFailure = null;
    for (const inspectionId of inspectionIds) {
      try {
        await this.workspaceRegistry.releaseOwner(inspectionId);
        this.inspections.delete(inspectionId);
      }
      catch (error) { firstFailure ??= error; }
    }
    if (firstFailure) throw firstFailure;
    return inspectionIds.length;
  }

  async inspectSource(request, options = {}) {
    const normalizedRequest = sourceRequest(request);
    const { onProgress, signal } = inspectionOptions(options);
    const reportProgress = inspectionProgressReporter(onProgress);
    let promotedInspectionId = null;
    try {
      throwIfInspectionCancelled(signal);
      reportProgress({ phase: 'resolving' });
      const resolution = await this.sourceResolver.resolveArtifactSetPlan(normalizedRequest, {
        signal,
        onProgress: progress => reportProgress({ ...progress, phase: 'downloading' })
      });
      throwIfInspectionCancelled(signal);
      const descriptors = strictObject(resolution, ['artifactSetPlan', 'source']);
      const source = clone(descriptors.source.value);
      reportProgress({ phase: 'downloading' });
      const verifiedArtifactSet = await this.artifactDownloader.downloadSet(descriptors.artifactSetPlan.value, {
        signal,
        onProgress: progress => reportProgress({ ...progress, phase: 'downloading' })
      });
      throwIfInspectionCancelled(signal);
      reportProgress({ phase: 'verifying' });
      const inspected = await this.archiveInspector.inspectArchive({
        verifiedArtifactSet,
        signal,
        onProgress: reportProgress
      });
      promotedInspectionId = assertIdentifier(inspected?.inspectionId);
      throwIfInspectionCancelled(signal);
      const safeInspection = publicView(publicInspectionProjection(inspected));
      const inspectionId = assertIdentifier(safeInspection.inspectionId);
      if (inspectionId !== promotedInspectionId || this.inspections.has(inspectionId)) throw stale();
      this.inspections.set(inspectionId, deepFreeze({ source, request: clone(normalizedRequest) }));
      throwIfInspectionCancelled(signal);
      return safeInspection;
    } catch (error) {
      if (promotedInspectionId) {
        this.inspections.delete(promotedInspectionId);
        try { await this.workspaceRegistry?.releaseOwner(promotedInspectionId); } catch { /* preserve primary failure */ }
      }
      throw inspectionFailure(error, signal);
    }
  }

  async cancelInspection(inspectionId) {
    const normalizedInspectionId = assertIdentifier(inspectionId);
    const session = this.inspections.get(normalizedInspectionId);
    if (!session) return false;
    if (!this.workspaceRegistry) throw invalid();
    this.inspections.delete(normalizedInspectionId);
    try {
      await this.workspaceRegistry.releaseOwner(normalizedInspectionId);
      return true;
    } catch (error) {
      this.inspections.set(normalizedInspectionId, session);
      throw error;
    }
  }

  async createPlan(request, options = {}) {
    const normalizedRequest = planningRequest(request);
    const { onProgress } = preflightOptions(options);
    const reportProgress = preflightProgressReporter(onProgress);
    const inspectionId = normalizedRequest.inspectionId;
    const session = this.inspections.get(inspectionId);
    if (!session) throw stale();
    let inspection;
    try { inspection = this.inspectionLoader.loadInspection(inspectionId); }
    catch (error) { throw error instanceof ModpackError ? error : stale(error); }
    if (!inspection || inspection.inspectionId !== inspectionId) throw stale();
    const planned = await this.planningAdapter.createPlan({
      request: normalizedRequest,
      inspection,
      source: deepFreeze(clone(session.source)),
      onProgress: reportProgress
    });
    if (planned?.requiresConflictReview === true) {
      const descriptors = strictObject(planned, ['requiresConflictReview', 'conflicts']);
      if (!Array.isArray(descriptors.conflicts.value) || descriptors.conflicts.value.length < 1) throw invalid();
      const review = publicView(planned);
      reportProgress({ phase: 'complete' });
      return review;
    }
    const descriptors = strictObject(planned, ['plan', 'sanitizedView']);
    const plan = descriptors.plan.value;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || typeof plan.fingerprint !== 'string') throw invalid();
    const created = this.planRegistry.create({
      plan,
      sanitizedView: descriptors.sanitizedView.value,
      fingerprint: plan.fingerprint,
      planningSessionId: inspectionId
    });
    this.inspections.delete(inspectionId);
    const result = deepFreeze({
      planId: created.planId,
      planFingerprint: created.fingerprint,
      planView: created.planView,
      expiresAt: created.expiresAt
    });
    reportProgress({ phase: 'complete' });
    return result;
  }

  async createManagementPlan(requestValue, options = {}) {
    const request = managementPlanningRequest(requestValue);
    const { onProgress } = preflightOptions(options);
    const reportProgress = preflightProgressReporter(onProgress);
    if (typeof this.planningAdapter.createManagementPlan !== 'function' ||
        !this.stateRepository || typeof this.stateRepository.read !== 'function') throw invalid();
    const instance = await this.#resolveStateInstance(request.instanceId);
    const currentState = this.stateRepository.read(instance.serverPath);
    if (!currentState || (request.operationKind !== 'rollback-restore-point' &&
        (currentState.state.modpackManaged !== true || !currentState.manifest))) throw stale();
    const planned = await this.planningAdapter.createManagementPlan({
      request,
      currentState,
      instance,
      onProgress: reportProgress
    });
    const descriptors = strictObject(planned, ['plan', 'sanitizedView', 'planningSessionId']);
    const plan = descriptors.plan.value;
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || typeof plan.fingerprint !== 'string' ||
        !SHA256.test(plan.fingerprint)) throw invalid();
    const operationDescriptors = strictObject(plan.operation, [
      'kind', 'serverKind', 'instanceId', 'expectedContentRevision', 'downgrade'
    ], ['kind', 'serverKind', 'instanceId', 'expectedContentRevision']);
    if (operationDescriptors.kind.value !== request.operationKind || operationDescriptors.serverKind.value !== 'existing' ||
        operationDescriptors.instanceId.value !== request.instanceId ||
        operationDescriptors.expectedContentRevision.value < currentState.state.contentRevision ||
        (operationDescriptors.downgrade && operationDescriptors.downgrade.value !== false)) throw stale();
    if (request.operationKind === 'rollback-restore-point' &&
        (!Array.isArray(plan.restorePoints) || !plan.restorePoints.some(point =>
          point && typeof point === 'object' && point.id === request.selectionRef))) throw stale();
    const created = this.planRegistry.create({
      plan,
      sanitizedView: descriptors.sanitizedView.value,
      fingerprint: plan.fingerprint,
      planningSessionId: assertIdentifier(descriptors.planningSessionId.value)
    });
    const result = deepFreeze({
      planId: created.planId,
      planFingerprint: created.fingerprint,
      planView: created.planView,
      expiresAt: created.expiresAt
    });
    reportProgress({ phase: 'complete' });
    return result;
  }

  async getJob(jobId) {
    let normalized;
    try { normalized = assertIdentifier(jobId); }
    catch (error) { throw stale(error); }
    let job = await this.operationStore.get(normalized);
    if (!job) throw stale();
    const active = this.activeOperations.get(normalized);
    if (active && TERMINAL_JOB_PHASES.has(job.phase)) {
      await active.settled;
      job = await this.operationStore.get(normalized);
      if (!job) throw stale();
    }
    return job;
  }

  async cancelJob(jobId) {
    const existing = await this.getJob(jobId);
    const active = this.activeOperations.get(existing.jobId);
    if (active?.isSettling()) {
      await active.settled;
      const settled = await this.operationStore.get(existing.jobId);
      if (!settled) throw stale();
      return settled;
    }
    const cancelledJob = await this.operationStore.requestCancellation(existing.jobId);
    active?.abort();
    return cancelledJob;
  }

  async getState(instanceIdValue) {
    const instanceId = assertIdentifier(instanceIdValue);
    const resolved = await this.#resolveStateInstance(instanceId);
    if (!this.stateRepository || typeof this.stateRepository.read !== 'function') throw invalid();
    const current = this.stateRepository.read(resolved.serverPath);
    if (!current) {
      return deepFreeze({
        type: 'modpack-state',
        instanceId,
        modpackManaged: false,
        lifecycleMode: 'unmanaged',
        source: null,
        runtime: null,
        selectedOptionalFiles: [],
        installedAt: null,
        contentRevision: null,
        managedFileCount: '0'
      });
    }
    const managedFileCount = current.manifest
      ? current.manifest.entries.filter(entry =>
        ['pack', 'runtime'].includes(entry.origin) && entry.managementPolicy === 'replaceable-managed').length
      : 0;
    return deepFreeze({
      type: 'modpack-state',
      instanceId,
      modpackManaged: current.state.modpackManaged,
      lifecycleMode: current.state.lifecycleMode || (current.state.modpackManaged ? 'managed' : 'detached'),
      source: publicSource(current.state.source),
      runtime: current.state.runtime ? clone(current.state.runtime) : null,
      selectedOptionalFiles: [...current.state.selectedOptionalFiles],
      installedAt: current.state.installedAt,
      contentRevision: current.state.contentRevision,
      managedFileCount: String(managedFileCount)
    });
  }

  async listHistory(instanceIdValue, optionsValue = {}) {
    const instanceId = assertIdentifier(instanceIdValue);
    const descriptors = strictObject(optionsValue, ['cursor', 'limit'], []);
    const cursor = descriptors.cursor?.value ?? null;
    const limit = descriptors.limit?.value ?? 50;
    if ((cursor !== null && (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 512)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid();
    const resolved = await this.#resolveStateInstance(instanceId);
    if (!this.stateRepository || typeof this.stateRepository.listHistory !== 'function') throw invalid();
    const page = this.stateRepository.listHistory(resolved.serverPath, { cursor, limit });
    return deepFreeze({
      instanceId,
      items: page.items.map(publicHistoryEntry),
      nextCursor: page.nextCursor
    });
  }

  async listRollbackOptions(instanceIdValue) {
    const instanceId = assertIdentifier(instanceIdValue);
    if (typeof this.planningAdapter.listRollbackOptions !== 'function') throw invalid();
    return publicView(await this.planningAdapter.listRollbackOptions({ instanceId }));
  }

  async verify(instanceIdValue) {
    const instanceId = assertIdentifier(instanceIdValue);
    this.#assertVerificationDependencies();
    const queued = await this.operationStore.create({
      operationKind: 'verify',
      serverId: instanceId,
      planFingerprint: null
    });
    const controller = new AbortController();
    const active = createActiveOperation(controller);
    this.activeOperations.set(queued.jobId, active);
    Promise.resolve().then(() => this.#executeVerification({
      jobId: queued.jobId,
      instanceId,
      signal: controller.signal,
      active
    })).catch(() => {}).finally(() => {
      if (this.activeOperations.get(queued.jobId) === active) this.activeOperations.delete(queued.jobId);
      active.settle();
    });
    return queued;
  }

  async startOperation(request) {
    this.#assertMutationDependencies();
    const descriptors = strictObject(request, ['planId', 'planFingerprint', 'choices']);
    const planId = assertIdentifier(descriptors.planId.value);
    const planFingerprint = descriptors.planFingerprint.value;
    if (typeof planFingerprint !== 'string' || !SHA256.test(planFingerprint)) throw invalid();
    const choices = executionChoices(descriptors.choices.value);

    let claimed = null;
    try {
      claimed = await this.planRegistry.claim({ planId, fingerprint: planFingerprint });
      if (!claimed || claimed.planId !== planId || claimed.fingerprint !== planFingerprint ||
          typeof claimed.jobId !== 'string' || !IDENTIFIER.test(claimed.jobId)) throw stale();
      const operationKind = mutationOperationKind(claimed.plan);
      if (EULA_REQUIRED_OPERATION_KINDS.has(operationKind) && choices.acceptEula !== true) {
        throw new ModpackError('INVALID_REQUEST', 'Minecraft EULA acceptance is required for this server operation');
      }
      if (operationKind === 'downgrade' &&
          claimed.plan.requirements?.downgradeWorldRiskAcknowledged !== true) throw stale();
      const selectedRestorePoint = operationKind === 'rollback-restore-point'
          ? selectedPinnedRestorePoint(claimed.plan, choices)
          : null;
      if (operationKind === 'rollback-restore-point' && !selectedRestorePoint) throw stale();
      if (choices.restorePointId !== null && operationKind !== 'rollback-restore-point') throw invalid();

      const queued = await this.operationStore.create({
        jobId: claimed.jobId,
        operationKind,
        serverId: claimed.plan.operation.instanceId,
        planFingerprint
      });
      const controller = new AbortController();
      const active = createActiveOperation(controller);
      this.activeOperations.set(claimed.jobId, active);
      Promise.resolve().then(() => this.#executeOperation({
        claimed,
        choices,
        operationKind,
        selectedRestorePoint,
        signal: controller.signal,
        active
      })).catch(() => {}).finally(() => {
        if (this.activeOperations.get(claimed.jobId) === active) this.activeOperations.delete(claimed.jobId);
        active.settle();
      });
      return queued;
    } catch (error) {
      if (claimed) {
        try { await this.#releaseClaim(claimed.jobId); }
        catch (releaseError) { throw recoveryRequired(releaseError); }
      }
      throw error;
    }
  }

  #assertMutationDependencies() {
    if (!this.mutationCoordinator || typeof this.mutationCoordinator.runMutation !== 'function' ||
        !this.mutationRuntime || MUTATION_RUNTIME_METHODS.some(method => typeof this.mutationRuntime[method] !== 'function') ||
        typeof this.operationStore.create !== 'function' || typeof this.operationStore.transition !== 'function' ||
        typeof this.planRegistry.releaseClaim !== 'function') throw invalid();
  }

  #assertVerificationDependencies() {
    if (!this.instanceResolver || typeof this.instanceResolver.resolveInstance !== 'function' ||
        !this.stateRepository || typeof this.stateRepository.verifyManagedFiles !== 'function' ||
        typeof this.operationStore.create !== 'function' || typeof this.operationStore.transition !== 'function') throw invalid();
  }

  async #resolveStateInstance(instanceId) {
    if (!this.instanceResolver || typeof this.instanceResolver.resolveInstance !== 'function') throw invalid();
    const resolved = assertResolvedInstance(await this.instanceResolver.resolveInstance(instanceId), instanceId);
    return { instanceId, serverPath: resolved.serverPath };
  }

  async #emitStateChanged(instanceId) {
    if (this.stateEventSink === null) return;
    try {
      const state = await this.getState(instanceId);
      await this.stateEventSink(state);
    } catch {
      // Durable state is authoritative; event delivery must not invalidate a committed transaction.
    }
  }

  async #executeVerification({ jobId, instanceId, signal, active }) {
    try {
      await this.#transition(jobId, 'verifying', 10, 'Verifying managed files', signal);
      const resolved = assertResolvedInstance(await this.instanceResolver.resolveInstance(instanceId), instanceId);
      await this.#throwIfCancelled(jobId, signal);
      const result = await this.stateRepository.verifyManagedFiles(resolved.serverPath, { signal });
      await this.#throwIfCancelled(jobId, signal);
      active.beginSettlement();
      const outcome = await this.#withIssuedActions({
        status: 'completed',
        message: result.healthy ? 'All managed files match the installed manifest' : 'Managed file differences were found',
        operationKind: 'verify'
      }, {
        jobId,
        operationKind: 'verify',
        instanceId,
        phase: 'completed',
        status: 'completed',
        errorCode: null,
        plan: null,
        restorePointId: null,
        automaticRecovery: false
      });
      await this.#transition(jobId, 'completed', 100, 'Managed files verified', signal,
        publicVerificationOutcome(outcome, instanceId, result));
    } catch (error) {
      active.beginSettlement();
      await this.#finishVerificationFailure({ jobId, instanceId, error });
    }
  }

  async #finishVerificationFailure({ jobId, instanceId, error }) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let current;
      try {
        current = await this.operationStore.get(jobId);
      } catch (readError) {
        if (attempt >= 2) throw readError;
        await this.yieldControl();
        continue;
      }
      if (!current) throw stale();
      if (TERMINAL_JOB_PHASES.has(current.phase)) return current;
      const wasCancelled = current.phase === 'cancelling' || error?.code === 'CANCELLED';
      if (wasCancelled && current.phase !== 'cancelling') {
        try { current = await this.operationStore.requestCancellation(jobId); }
        catch (cancellationError) {
          if (attempt < 2) {
            await this.yieldControl();
            continue;
          }
          throw cancellationError;
        }
      }
      const terminalPhase = wasCancelled ? 'cancelled' : 'failed';
      const errorCode = safeErrorCode(error);
      const filesystemFailure = wasCancelled ? null : filesystemFailureDiagnosticFromError(error);
      await this.#appendFailureEvent(jobId, error, null);
      const outcome = await this.#withIssuedActions({
        status: terminalPhase,
        message: wasCancelled ? 'Verification was cancelled' : 'Managed file verification failed',
        errorCode,
        ...(filesystemFailure === null ? {} : { failure: filesystemFailure })
      }, {
        jobId,
        operationKind: 'verify',
        instanceId,
        phase: terminalPhase,
        status: terminalPhase,
        errorCode,
        plan: null,
        restorePointId: null,
        automaticRecovery: false
      });
      try {
        return await this.operationStore.transition(jobId, {
          expectedPhase: current.phase,
          nextPhase: terminalPhase,
          patch: { outcome }
        });
      } catch (transitionError) {
        const latest = await this.operationStore.get(jobId).catch(() => null);
        if (latest && TERMINAL_JOB_PHASES.has(latest.phase)) return latest;
        if (attempt >= 2) throw transitionError;
        await this.yieldControl();
      }
    }
    throw recoveryRequired();
  }

  async #releaseClaim(jobId) {
    if (this.releasedClaims.has(jobId)) return true;
    if (await this.planRegistry.releaseClaim(jobId) !== true) throw recoveryRequired();
    this.releasedClaims.add(jobId);
    await this.yieldControl();
    return true;
  }

  async #executeOperation(context) {
    const { claimed, choices, operationKind, signal, active } = context;
    let resolved = null;
    let restartToken = null;
    let deferredTerminal = null;
    let callbackFailure = null;
    const state = {
      candidateBuilt: false,
      commitStarted: false,
      committedHealthy: false,
      recoveryRecordPrepared: false,
      restorePoint: null,
      restorePointAttempted: false,
      failureStep: null
    };
    try {
      await this.#throwIfCancelled(claimed.jobId, signal);
      resolved = assertResolvedInstance(await this.mutationRuntime.resolveInstance({
        jobId: claimed.jobId,
        plan: claimed.plan,
        choices,
        signal
      }), claimed.plan.operation.instanceId);
      await this.#transition(claimed.jobId, 'preflight', 5, 'Revalidating the reviewed plan', signal);
      const selector = { instanceId: resolved.instanceId, serverPath: resolved.serverPath };
      state.failureStep = 'acquire-mutation';
      const completedOutcome = await this.mutationCoordinator.runMutation(selector, {
        operation: operationKind,
        operationId: claimed.jobId,
        // A reserved new-server target has no live content revision until the
        // publication transaction succeeds. Its reservation, transaction
        // journal, and candidate identities are the authoritative guards.
        // Requiring a live lifecycle revision here can overwrite the real
        // pre-publication failure with PLAN_STALE after candidate I/O dirties
        // the lease, even though no canonical server exists yet.
        revisionMode: claimed.plan.operation.serverKind === 'new' ? 'none' : 'lifecycle',
        signal,
        quiesce: async quiesceContext => {
          state.failureStep = 'suspend-auto-restart';
          restartToken = await this.mutationRuntime.suspendAutoRestart({
            ...quiesceContext,
            jobId: claimed.jobId,
            plan: claimed.plan,
            resolved
          });
          state.failureStep = 'quiesce';
          await this.mutationRuntime.quiesce({
            ...quiesceContext,
            jobId: claimed.jobId,
            plan: claimed.plan,
            resolved,
            restartToken
          });
        }
      }, async lease => {
        try {
          state.failureStep = 'revalidate-plan';
          return await this.#executeUnderLease({ ...context, lease, resolved, restartToken, state });
        } catch (error) {
          active.beginSettlement();
          callbackFailure = error;
          deferredTerminal = await this.#handleFailure(
            { ...context, lease, resolved, restartToken, state, error },
            { deferTerminal: true }
          );
          throw error;
        }
      });
      await this.#transition(claimed.jobId, 'completed', 100, 'Modpack operation completed', null, completedOutcome);
    } catch (error) {
      if (deferredTerminal?.kind === TERMINAL_RESOLUTION_KIND) {
        const settlementContext = { ...context, state, resolved, restartToken };
        if (error !== callbackFailure) {
          await this.#publishRecoveryRequiredAfterRelease(settlementContext, error);
          return;
        }
        await this.#publishDeferredTerminal(deferredTerminal, settlementContext, error);
        return;
      }
      const job = await this.operationStore.get(claimed.jobId).catch(() => null);
      if (job && (TERMINAL_JOB_PHASES.has(job.phase) || job.phase === 'cleanup-pending')) return;
      // From this point cancellation must wait for the already-selected
      // failure outcome. This also covers resolve/quiesce/coordinator errors
      // that happen before the mutation callback gets a lease.
      active.beginSettlement();
      const settlementContext = { ...context, state, resolved, restartToken };
      try {
        const resolution = await this.#handleFailure(
          { ...settlementContext, lease: null, error },
          { deferTerminal: true }
        );
        if (resolution?.kind === TERMINAL_RESOLUTION_KIND) {
          await this.#publishDeferredTerminal(resolution, settlementContext, error);
        }
      } catch (settlementError) {
        await this.#publishRecoveryRequiredAfterRelease(settlementContext, settlementError);
      }
    }
  }

  async #tryPublishTerminal(resolution) {
    if (!resolution || resolution.kind !== TERMINAL_RESOLUTION_KIND) throw invalid();
    let lastError = null;
    let latest = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { latest = await this.operationStore.get(resolution.jobId); }
      catch (error) {
        lastError = error;
        if (attempt === 0) await this.yieldControl();
        continue;
      }
      if (!latest) throw stale();
      if (TERMINAL_JOB_PHASES.has(latest.phase)) return { job: latest, error: null };
      if (latest.phase !== resolution.request.expectedPhase) {
        return { job: null, error: lastError || stale() };
      }
      try {
        const job = await this.operationStore.transition(resolution.jobId, resolution.request);
        return { job, error: null };
      } catch (error) {
        lastError = error;
        if (attempt === 0) await this.yieldControl();
      }
    }
    try {
      latest = await this.operationStore.get(resolution.jobId);
      if (latest && TERMINAL_JOB_PHASES.has(latest.phase)) return { job: latest, error: null };
    } catch (error) {
      lastError ||= error;
    }
    return { job: null, error: lastError || recoveryRequired() };
  }

  async #publishDeferredTerminal(resolution, context, primaryError) {
    await this.#appendFailureEvent(resolution.jobId, primaryError, context.state);
    const published = await this.#tryPublishTerminal(resolution);
    if (published.job) return published.job;
    return this.#publishRecoveryRequiredAfterRelease(context, published.error || primaryError);
  }

  async #publishRecoveryRequiredAfterRelease(context, error) {
    const { claimed, operationKind, selectedRestorePoint, state } = context;
    await this.#appendFailureEvent(claimed.jobId, error, state);
    const job = await this.operationStore.get(claimed.jobId);
    if (!job) throw stale();
    if (TERMINAL_JOB_PHASES.has(job.phase)) return job;
    const errorCode = safeErrorCode(error);
    const outcome = await this.#withIssuedActions({
      status: 'recovery-required',
      message: 'The server needs recovery before it can be used',
      errorCode,
      automatic: false
    }, {
      jobId: claimed.jobId,
      operationKind,
      instanceId: claimed.plan.operation.instanceId,
      phase: 'recovery-required',
      status: 'recovery-required',
      errorCode,
      plan: claimed.plan,
      restorePointId: state.restorePoint?.id || selectedRestorePoint?.id || null,
      automaticRecovery: false
    });
    const resolution = terminalResolution(claimed.jobId, {
      expectedPhase: job.phase,
      nextPhase: 'recovery-required',
      patch: { outcome }
    });
    const published = await this.#tryPublishTerminal(resolution);
    if (published.job) return published.job;
    throw recoveryRequired(published.error || error);
  }

  async #executeUnderLease(context) {
    const { claimed, choices, operationKind, selectedRestorePoint, signal, lease, resolved, restartToken, state } = context;
    await this.#throwIfCancelled(claimed.jobId, signal);
    await this.mutationRuntime.revalidate({
      jobId: claimed.jobId,
      plan: claimed.plan,
      choices,
      selectedRestorePoint,
      resolved,
      lease,
      signal
    });
    // Successful production revalidation has already created the operation's
    // durable recovery record and retained runtime context. Mark that boundary
    // before consulting the independently persisted job cancellation state or
    // advancing its phase so either failure path performs idempotent recovery.
    state.recoveryRecordPrepared = true;
    state.failureStep = null;
    await this.#throwIfCancelled(claimed.jobId, signal);

    const existing = !['install-new', 'import-files-only-new'].includes(operationKind);
    const requiresRuntimeValidation = operationKind !== 'import-files-only-new' &&
      !(operationKind === 'uninstall-managed' && claimed.plan.ownership.confirmation.possibleNonRunnable);
    const requiresCommitFinalizationWithoutHealth = operationKind === 'import-files-only-new' ||
      (operationKind === 'uninstall-managed' && claimed.plan.ownership.confirmation.possibleNonRunnable);
    const shouldRun = requiresRuntimeValidation && (resolved.priorRunning || choices.startAfterInstall);
    // Existing servers retain the pre-swap candidate boot. New managed servers
    // are validated exactly once from their final canonical path so path-
    // sensitive server packs behave the same whether they remain running or not.
    const requiresCandidateValidation = requiresRuntimeValidation && existing;
    let restorePoint = selectedRestorePoint;
    if (existing) {
      await this.#transition(claimed.jobId, 'snapshotting', 15, 'Creating a verified restore point', signal);
      const snapshotProgress = createRestorePointCreationProgressQueue(
        progress => this.#updateSnapshotProgress(claimed.jobId, progress, signal), this.snapshotProgressClock
      );
      // A production attempt may durably create or advance its recovery record
      // before createRestorePoint returns (including immediately before it
      // reports cancellation). From this boundary onward, pre-commit failure
      // must ask the runtime to reconcile that record even without a returned
      // restore-point reference; an absent record is handled idempotently.
      state.restorePointAttempted = true;
      try {
        restorePoint = await this.mutationRuntime.createRestorePoint({
          jobId: claimed.jobId,
          plan: claimed.plan,
          choices,
          selectedRestorePoint,
          resolved,
          lease,
          signal,
          onProgress: value => snapshotProgress.push(value)
        });
        // The production runtime has already durably published both the
        // restore point and its recovery-registry reference before returning.
        // Record that fact before draining best-effort UI progress so a store
        // failure or cancellation at this boundary still reconciles the
        // pre-candidate recovery record.
        state.restorePoint = restorePoint;
        await snapshotProgress.drain();
        snapshotProgress.push({ phase: 'complete' });
        await snapshotProgress.drain();
      } catch (error) {
        try { await snapshotProgress.drain(); } catch { /* preserve the restore-point failure */ }
        throw error;
      }
      await this.#throwIfCancelled(claimed.jobId, signal);
    }

    await this.#transition(claimed.jobId, 'staging', 35, 'Building the server candidate', signal);
    state.candidateBuilt = true;
    const candidate = await this.mutationRuntime.buildCandidate({
      jobId: claimed.jobId,
      operationKind,
      plan: claimed.plan,
      choices,
      restorePoint,
      resolved,
      lease,
      signal,
      onProgress: progress => this.#updateCandidateProgress(claimed.jobId, progress, signal)
    });
    await this.#throwIfCancelled(claimed.jobId, signal);
    if (requiresCandidateValidation) {
      const current = await this.operationStore.get(claimed.jobId);
      if (!current) throw stale();
      if (current.phase === 'staging') {
        await this.#transition(claimed.jobId, 'validating-candidate', 50, 'Validating the server candidate', signal);
      } else if (current.phase !== 'validating-candidate') {
        throw stale();
      }
      await this.mutationRuntime.validateCandidate({
        jobId: claimed.jobId,
        operationKind,
        plan: claimed.plan,
        choices,
        candidate,
        resolved,
        lease,
        signal
      });
      await this.#throwIfCancelled(claimed.jobId, signal);
    }

    await this.#transition(claimed.jobId, 'committing', 65, 'Committing the reviewed changes', signal);
    state.commitStarted = true;
    lease.markDirty();
    let committed;
    if (!existing) {
      await this.#transition(claimed.jobId, 'publishing', 70, 'Publishing the new server', null);
      committed = await this.mutationRuntime.publishCandidate({
        jobId: claimed.jobId, plan: claimed.plan, choices, candidate, resolved, lease
      });
      await this.#transition(claimed.jobId, 'published', 75, 'New server published', null);
      await this.#transition(claimed.jobId, 'registering', 80, 'Registering the new server', null);
      await this.mutationRuntime.registerPublishedInstance({
        jobId: claimed.jobId, plan: claimed.plan, choices, committed, resolved, lease
      });
    } else {
      committed = await this.mutationRuntime.commitCandidate({
        jobId: claimed.jobId,
        operationKind,
        plan: claimed.plan,
        choices,
        candidate,
        restorePoint,
        resolved,
        lease
      });
    }

    if (shouldRun) {
      await this.#transition(claimed.jobId, 'starting', 85, 'Starting the committed server', null);
      await this.mutationRuntime.startFinal({
        jobId: claimed.jobId, plan: claimed.plan, choices, committed, resolved, lease
      });
    }
    let validation = {
      skipped: true,
      reason: operationKind === 'uninstall-managed' ? 'unmanaged-files-only' : 'files-only'
    };
    if (requiresRuntimeValidation || requiresCommitFinalizationWithoutHealth) {
      await this.#transition(
        claimed.jobId,
        'validating-live',
        90,
        requiresRuntimeValidation ? 'Validating the committed server' : 'Finalizing the files-only server state',
        null
      );
      validation = await this.mutationRuntime.validateLive({
        jobId: claimed.jobId,
        operationKind,
        plan: claimed.plan,
        choices,
        committed,
        resolved,
        running: shouldRun,
        lease
      });
      // validateLive is the durable commit boundary: production runtimes have
      // already marked recovery committed-healthy and published the revision.
      // From this point onward, side-effect failures must be reconciled as
      // cleanup-pending and must never roll the canonical server back.
      state.committedHealthy = true;
      await this.#transition(claimed.jobId, 'committed-healthy', 95, 'Committed server is healthy', null);
    } else if (existing) {
      await this.#transition(claimed.jobId, 'validating-live', 90, 'Recording the unmanaged files-only outcome', null);
    }
    await this.mutationRuntime.persistOutcome({
      jobId: claimed.jobId,
      operationKind,
      plan: claimed.plan,
      choices,
      committed,
      restorePoint,
      validation,
      resolved,
      running: shouldRun,
      lease
    });
    await this.#emitStateChanged(resolved.instanceId);
    if (!state.committedHealthy) {
      await this.#transition(claimed.jobId, 'committed-healthy', 95, 'Committed server is healthy', null);
      state.committedHealthy = true;
    }
    await this.mutationRuntime.restorePriorState({
      jobId: claimed.jobId,
      plan: claimed.plan,
      resolved,
      restartToken,
      running: shouldRun,
      lease
    });
    await this.#transition(claimed.jobId, 'cleanup', 98, 'Cleaning temporary files', null);
    await this.mutationRuntime.cleanup({
      jobId: claimed.jobId, operationKind, plan: claimed.plan, committed, resolved, lease
    });
    await this.#releaseClaim(claimed.jobId);
    const completedOutcome = await this.#withIssuedActions({
      status: 'completed',
      message: 'The modpack operation completed successfully',
      operationKind
    }, {
      jobId: claimed.jobId,
      operationKind,
      instanceId: resolved.instanceId,
      phase: 'completed',
      status: 'completed',
      errorCode: null,
      plan: claimed.plan,
      restorePointId: restorePoint?.id || null,
      automaticRecovery: false
    });
    return completedOutcome;
  }

  async #appendFailureEvent(jobId, error, state, swapFallback = false) {
    if (typeof this.operationStore.appendEvent !== 'function') return null;
    try {
      const current = await this.operationStore.get(jobId);
      if (!current || TERMINAL_JOB_PHASES.has(current.phase)) return current;
      const swapCallsite = swapFallback ? 'rollback-settlement' : existingSwapCallsiteFromError(error);
      if (swapCallsite) {
        const failureRole = swapFallback ? 'fallback' : 'primary';
        const code = error && Object.getOwnPropertyDescriptor(error, 'code')?.value;
        const errorCode = FAILURE_CODES.includes(code) ? code : 'COMMIT_FAILED';
        const failure = normalizeFailureDiagnostic(swapCallsite === 'candidate-promotion'
          ? publicationFailureDiagnosticFromError(error) : filesystemFailureDiagnosticFromError(error));
        const duplicate = Array.isArray(current.events) && current.events.some(event => {
          const details = event?.details;
          const priorFailure = normalizeFailureDiagnostic(details?.failure);
          return event?.channel === 'log' && details?.failureRole === failureRole &&
            details?.swapCallsite === swapCallsite && details?.errorCode === errorCode &&
            priorFailure?.stage === failure?.stage && priorFailure?.category === failure?.category &&
            priorFailure?.boundary === failure?.boundary;
        });
        if (duplicate) return current;
        const evidence = failure
          ? `${failure.stage}; ${failure.category}${failure.boundary ? `; ${failure.boundary}` : ''}`
          : 'native diagnostic unavailable';
        return await this.operationStore.appendEvent(jobId, {
          channel: 'log',
          message: `Existing swap ${failureRole} failure (${swapCallsite}; ${evidence}).`,
          details: { errorCode, failureRole, swapCallsite, ...(failure ? { failure } : {}) }
        });
      }
      const errorCode = error?.runtimeWritersUnproven === true && typeof error?.runtimeFailureCode === 'string'
        ? safeErrorCode({ code: error.runtimeFailureCode }) : safeErrorCode(error);
      const runtimeDiagnostic = runtimeDiagnosticFromError(error);
      const step = SAFE_FAILURE_STEPS.has(state?.failureStep) ? state.failureStep : null;
      const field = safeFailureField(error);
      const duplicate = Array.isArray(current.events) && current.events.some(event =>
        event?.channel === 'log' && event?.details?.errorCode === errorCode &&
        !event?.details?.failureRole && !event?.details?.swapCallsite &&
        (step === null || event?.details?.step === step) &&
        (field === null || event?.details?.field === field)
      );
      if (duplicate) return current;
      return await this.operationStore.appendEvent(jobId, {
        channel: 'log',
        message: runtimeDiagnostic
          ? `${errorCode}: Runtime preparation stopped (${runtimeDiagnostic.stage}; ${runtimeDiagnostic.reason}${runtimeDiagnostic.osCode ? `; ${runtimeDiagnostic.osCode}` : ''}${runtimeDiagnostic.changedIdentityFields ? `; changed identity fields ${runtimeDiagnostic.changedIdentityFields}` : ''})`
          : safeFailureLogMessage(error),
        details: {
          errorCode,
          ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
          ...(step === null ? {} : { step }),
          ...(field === null ? {} : { field })
        }
      });
    } catch {
      // Diagnostic publication is best-effort. The terminal outcome remains authoritative.
      return null;
    }
  }

  async #handleFailure(context, { deferTerminal = false } = {}) {
    const { claimed, operationKind, plan, choices, selectedRestorePoint, lease, resolved, restartToken, state, error } = {
      plan: context.claimed.plan,
      ...context
    };
    let job = await this.operationStore.get(claimed.jobId);
    if (!job || TERMINAL_JOB_PHASES.has(job.phase) || job.phase === 'cleanup-pending') return;

    if (!state.committedHealthy && state.commitStarted && resolved &&
        typeof this.mutationRuntime.isDurablyCommitted === 'function') {
      try {
        state.committedHealthy = await this.mutationRuntime.isDurablyCommitted({
          jobId: claimed.jobId,
          plan,
          resolved
        }) === true;
      } catch {
        // The normal rollback path remains authoritative unless a durable
        // committed recovery record can be positively identified.
      }
    }

    if (state.committedHealthy || ['committed-healthy', 'cleanup'].includes(job.phase)) {
      // Settlement runs under the original mutation authority. Production must
      // hand unresolved healthy-source cleanup to the coordinator before that
      // lease is released; authenticated archive completion makes later policy
      // or claim errors ancillary. Never invent authority in after-release retry.
      if (lease && typeof this.mutationRuntime.quarantinePendingCleanup === 'function') {
        await this.mutationRuntime.quarantinePendingCleanup({
          jobId: claimed.jobId, operationKind, plan, resolved, lease, error
        });
      }
      if (state.committedHealthy && job.phase === 'registering') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'registering', nextPhase: 'committed-healthy', patch: {}
        });
      } else if (state.committedHealthy && job.phase === 'starting') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'starting', nextPhase: 'validating-live', patch: {}
        });
      }
      if (state.committedHealthy && job.phase === 'validating-live') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'validating-live', nextPhase: 'committed-healthy', patch: {}
        });
      }
      if (job.phase === 'committed-healthy') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'committed-healthy', nextPhase: 'cleanup-pending', patch: {}
        });
      } else if (job.phase === 'cleanup') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: 'cleanup', nextPhase: 'cleanup-pending', patch: {}
        });
      }
      return deferTerminal ? null : job;
    }

    if (!state.commitStarted) {
      // Presentation only: cancellation and optional publication failures must
      // never bypass precommit settlement under the original mutation lease.
      try {
        const current = await this.operationStore.get(claimed.jobId);
        if (current && !TERMINAL_JOB_PHASES.has(current.phase) && current.phase !== 'cleanup-pending' &&
            typeof this.operationStore.updateProgress === 'function') {
          await this.operationStore.updateProgress(claimed.jobId, {
            expectedPhase: current.phase,
            progress: {
              percent: current.progress?.percent ?? 0,
              message: current.phase === 'cancelling' || current.cancellationRequested || error?.code === 'CANCELLED'
                ? 'Cancelling; verifying safe cleanup of the candidate.'
                : 'The attempt failed; verifying safe cleanup of the candidate.',
              currentItem: null
            }
          });
        }
      } catch { /* optional progress must not replace the original failure or cleanup */ }
      let cleanupError = null;
      if ((state.recoveryRecordPrepared || state.candidateBuilt || state.restorePointAttempted ||
           state.restorePoint !== null) && resolved) {
        if (error?.preserveWorkspace === true && typeof this.operationStore.appendEvent === 'function') {
          try {
            await this.operationStore.appendEvent(claimed.jobId, {
              channel: 'log',
              message: 'Waiting for runtime workers to stop before safely cleaning the candidate',
              details: { step: 'wait-runtime-workers' }
            });
          } catch { /* progress reporting must not bypass the shutdown barrier */ }
        }
        try {
          await this.mutationRuntime.abandonCandidate({
            jobId: claimed.jobId, operationKind, plan, choices, resolved, lease, error
          });
        } catch (candidateError) {
          cleanupError = candidateError;
        }
      }
      const runtimeUnproven = error?.runtimeWritersUnproven === true || cleanupError?.runtimeWritersUnproven === true;
      if (runtimeUnproven) this.mutationCoordinator.quarantineMutation(lease);
      if (!runtimeUnproven && restartToken !== null && resolved) {
        try {
          await this.mutationRuntime.restorePriorState({
            jobId: claimed.jobId, plan, resolved, restartToken, running: resolved.priorRunning, lease
          });
        } catch (policyError) {
          cleanupError ||= policyError;
        }
      }
      if (!runtimeUnproven) {
        try { await this.#releaseClaim(claimed.jobId); }
        catch (releaseError) { cleanupError ||= releaseError; }
      }
      job = await this.operationStore.get(claimed.jobId);
      const wasCancelled = job.phase === 'cancelling' || error?.code === 'CANCELLED';
      if (wasCancelled && job.phase !== 'cancelling') {
        job = await this.operationStore.requestCancellation(claimed.jobId);
      }
      const terminalPhase = runtimeUnproven ? 'recovery-required' : wasCancelled ? 'cancelled' : 'failed';
      const errorCode = runtimeUnproven && typeof error?.runtimeFailureCode === 'string'
        ? safeErrorCode({ code: error.runtimeFailureCode }) : safeErrorCode(error);
      const failureDiagnostic = wasCancelled ? null : failureDiagnosticFromError(error);
      const runtimeDiagnostic = runtimeDiagnosticFromError(error);
      const failureReason = wasCancelled ? null : destinationRecoveryFailureReason(error, {
        operationKind,
        failureStep: state.failureStep
      });
      const outcome = await this.#withIssuedActions({
        status: terminalPhase,
        message: runtimeUnproven
          ? 'Runtime shutdown could not be confirmed. Candidate files are retained and this server is blocked pending recovery.'
          : wasCancelled ? 'The operation was cancelled before the server changed' : 'The operation failed before the server changed',
        errorCode,
        cleanupPending: runtimeUnproven || cleanupError !== null,
        ...(cleanupError === null ? {} : { cleanupErrorCode: safeErrorCode(cleanupError) }),
        ...(failureReason === null ? {} : { failureReason }),
        ...(failureDiagnostic === null ? {} : { failure: failureDiagnostic }),
        ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
        ...(hasVerifiedRetainedArtifact(plan) ? { retainedDownload: true } : {})
      }, {
        jobId: claimed.jobId,
        operationKind,
        instanceId: claimed.plan.operation.instanceId,
        phase: terminalPhase,
        status: terminalPhase,
        errorCode,
        plan,
        restorePointId: state.restorePoint?.id || selectedRestorePoint?.id || null,
        automaticRecovery: false
      });
      const request = {
        expectedPhase: job.phase,
        nextPhase: terminalPhase,
        patch: {
          outcome,
          ...(runtimeUnproven ? { progress: {
            percent: job.progress?.percent ?? 0,
            message: 'Runtime shutdown is unproven; files are retained for recovery',
            currentItem: null
          } } : {})
        }
      };
      return deferTerminal
        ? terminalResolution(claimed.jobId, request)
        : this.operationStore.transition(claimed.jobId, request);
    }

    const failedPhase = job.phase;
    const existingSwapFailed = plan.operation.serverKind === 'existing' &&
      existingSwapCallsiteFromError(error) !== null;
    if (existingSwapFailed) await this.#appendFailureEvent(claimed.jobId, error, state);
    try {
      if (job.phase !== 'rolling-back') {
        job = await this.operationStore.transition(claimed.jobId, {
          expectedPhase: job.phase,
          nextPhase: 'rolling-back',
          patch: {}
        });
      }
      const rollbackResult = await this.mutationRuntime.rollback({
        jobId: claimed.jobId,
        operationKind,
        plan,
        choices,
        selectedRestorePoint,
        resolved,
        restartToken,
        lease,
        error
      });
      if (restartToken !== null && resolved) {
        await this.mutationRuntime.restorePriorState({
          jobId: claimed.jobId, plan, resolved, restartToken, running: resolved.priorRunning, lease
        });
      }
      await this.#releaseClaim(claimed.jobId);
      const errorCode = safeErrorCode(error);
      const newServerFailed = plan.operation.serverKind === 'new';
      const newServerFailure = newServerFailed
        ? normalizeFailureDiagnostic(rollbackResult?.failure) ||
          (rollbackResult?.action === 'pre-publication-cleanup'
            ? publicationFailureDiagnosticFromError(error)
            : failureDiagnosticFromError(error))
        : null;
      const terminalPhase = newServerFailed ? 'failed' : 'rolled-back';
      const terminalMessage = newServerFailed
        ? rollbackResult?.action === 'pre-publication-cleanup'
          ? 'The new server was not published'
          : 'The failed new server was quarantined safely'
        : 'The original server was restored after the operation failed';
      const outcome = await this.#withIssuedActions({
        status: terminalPhase,
        message: terminalMessage,
        errorCode,
        ...(newServerFailure ? { failure: newServerFailure } : {})
      }, {
        jobId: claimed.jobId,
        operationKind,
        instanceId: claimed.plan.operation.instanceId,
        phase: terminalPhase,
        status: terminalPhase,
        errorCode,
        plan,
        restorePointId: state.restorePoint?.id || selectedRestorePoint?.id || null,
        automaticRecovery: false
      });
      const request = {
        expectedPhase: 'rolling-back',
        nextPhase: terminalPhase,
        patch: {
          outcome
        }
      };
      return deferTerminal
        ? terminalResolution(claimed.jobId, request)
        : this.operationStore.transition(claimed.jobId, request);
    } catch (rollbackError) {
      if (existingSwapFailed) await this.#appendFailureEvent(claimed.jobId, rollbackError, state, true);
      const latest = await this.operationStore.get(claimed.jobId);
      if (!latest || TERMINAL_JOB_PHASES.has(latest.phase)) return latest;
      const phase = latest.phase === 'rolling-back' ? latest.phase : job.phase;
      const errorCode = safeErrorCode(rollbackError);
      const publicationFailure = plan.operation.serverKind === 'new' && failedPhase === 'publishing'
        ? publicationFailureDiagnosticFromError(error)
        : null;
      const outcome = await this.#withIssuedActions({
        status: 'recovery-required',
        message: 'The server needs recovery before it can be used',
        errorCode,
        automatic: false,
        ...(publicationFailure ? { failure: publicationFailure } : {})
      }, {
        jobId: claimed.jobId,
        operationKind,
        instanceId: claimed.plan.operation.instanceId,
        phase: 'recovery-required',
        status: 'recovery-required',
        errorCode,
        plan,
        restorePointId: state.restorePoint?.id || selectedRestorePoint?.id || null,
        automaticRecovery: false
      });
      const request = {
        expectedPhase: phase,
        nextPhase: 'recovery-required',
        patch: {
          outcome
        }
      };
      return deferTerminal
        ? terminalResolution(claimed.jobId, request)
        : this.operationStore.transition(claimed.jobId, request);
    }
  }

  async #throwIfCancelled(jobId, signal) {
    if (signal?.aborted) throw cancelled();
    const job = await this.operationStore.get(jobId);
    if (!job || job.phase === 'cancelling' || job.cancellationRequested) throw cancelled();
  }

  async #updateCandidateProgress(jobId, value, signal) {
    const progress = candidateProgress(value);
    await this.#throwIfCancelled(jobId, signal);
    const current = await this.operationStore.get(jobId);
    if (!current) throw stale();
    if (current.phase === 'cancelling' || current.cancellationRequested) throw cancelled();
    if (current.progress !== null && progress.percent < current.progress.percent) throw stale();
    if (current.phase === progress.phase) {
      if (typeof this.operationStore.updateProgress !== 'function') return current;
      return this.operationStore.updateProgress(jobId, {
        expectedPhase: current.phase,
        progress: { percent: progress.percent, message: progress.message, currentItem: null }
      });
    }
    if (current.phase === 'staging' && progress.phase === 'validating-candidate') {
      return this.#transition(jobId, 'validating-candidate', progress.percent, progress.message, signal);
    }
    throw stale();
  }

  async #updateSnapshotProgress(jobId, admitProgress, signal) {
    await this.#throwIfCancelled(jobId, signal);
    const current = await this.operationStore.get(jobId);
    if (!current) throw stale();
    if (current.phase === 'cancelling' || current.cancellationRequested) throw cancelled();
    if (current.phase !== 'snapshotting') throw stale();
    if (typeof this.operationStore.updateProgress !== 'function') return current;
    const progress = admitProgress();
    if (progress === null) return current;
    if (progress?.phase !== 'snapshotting' || !Number.isSafeInteger(progress.percent) ||
        progress.percent < 16 || progress.percent > 34 || typeof progress.message !== 'string' ||
        progress.message.length < 1 || progress.message.length > 512 || progress.currentItem !== null) throw invalid();
    if (current.progress !== null && progress.percent < current.progress.percent) throw stale();
    return this.operationStore.updateProgress(jobId, {
      expectedPhase: 'snapshotting',
      progress: { percent: progress.percent, message: progress.message, currentItem: null }
    });
  }

  async #withIssuedActions(outcome, context) {
    if (this.outcomeActionIssuer === null) return outcome;
    try {
      const actions = normalizeIssuedActions(await this.outcomeActionIssuer.issue(deepFreeze({ ...context })));
      return { ...outcome, actions };
    } catch {
      return { ...outcome, actions: [], actionIssuanceFailed: true };
    }
  }

  async #transition(jobId, nextPhase, percent, message, signal, outcome = null) {
    if (signal) await this.#throwIfCancelled(jobId, signal);
    const current = await this.operationStore.get(jobId);
    if (!current) throw stale();
    if (current.phase === 'cancelling') throw cancelled();
    const patch = outcome === null
      ? { progress: { percent, message, currentItem: null } }
      : { progress: { percent, message, currentItem: null }, outcome };
    const transitioned = await this.operationStore.transition(jobId, {
      expectedPhase: current.phase,
      nextPhase,
      patch
    });
    await this.yieldControl();
    return transitioned;
  }
}

module.exports = { ModpackLifecycleService };
