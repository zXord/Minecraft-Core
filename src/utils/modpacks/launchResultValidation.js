// Renderer-side rejection only. These checks grant no storage, release or action authority.
const jobKeys = ['type', 'schemaVersion', 'sequence', 'jobId', 'operationKind', 'serverId', 'planFingerprint', 'phase', 'swapStep', 'progress', 'cancellationRequested', 'createdAt', 'updatedAt', 'terminalAt', 'outcome', 'events'];
const eventKeys = ['sequence', 'jobId', 'channel', 'phase', 'timestamp', 'message', 'progress', 'currentItem', 'details'];
const phases = new Set(['queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user', 'preflight', 'snapshotting', 'staging', 'validating-candidate', 'committing', 'publishing', 'published', 'registering', 'starting', 'validating-live', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed', 'cancelling', 'cancelled', 'rolling-back', 'rolled-back', 'failed', 'recovery-required']);
const terminal = new Set(['completed', 'cancelled', 'rolled-back', 'failed', 'recovery-required']);
const reasons = new Set(['admission-unresolved', 'missing-recovery-evidence', 'conflicting-evidence', 'invalid-durable-evidence', 'pending-terminal-publication', 'settlement-repair-required', 'destination-recovery', 'legacy-origin-unproven']);
const statuses = new Set(['pending', 'not-observed', 'not-started', 'started', 'recovery-required', 'unavailable']);
// Kept local and pure: match the approved IPC output authority/private-key
// families without importing backend validation or granting action authority.
const publicForbiddenKey = /path|url|uri|directory|destination|command|arguments?|executable|token|secret|password|headers?|authorization|cookie|cache|workspace|provider.?internal|artifactSetId|inputDirectoryId|outputDirectoryId|planningSessionId|native.?error|stack|cause|errno|syscall/iu;
const launchPrivateKey = /binding|checksum|revision|epoch|generation|captur|snapshot|raw.?error/iu;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const operationKind = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
const newKind = value => ['install-new', 'import-files-only-new'].includes(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const safeText = (value, maximum = 1024) => typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim() &&
  !/[\x00-\x1f\x7f]|[A-Za-z]:[\\/]|\\\\|(?:https?|file):\/\/|\bBearer\s+|\b(?:token|password|secret)\s*[=:]/iu.test(value);

export function isClosedObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return required.every(key => Object.hasOwn(descriptors, key)) && Object.entries(descriptors).every(([key, descriptor]) =>
    (required.includes(key) || optional.includes(key)) && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
}

function publicData(value, depth = 0, launch = false) {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return plainArray(value, 256) && value.every(item => publicData(item, depth + 1, launch));
  if (!isClosedObject(value, [], Object.keys(value || {})) || Object.keys(value).length > 128) return false;
  return Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) =>
    /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(key) &&
    !publicForbiddenKey.test(key) && !/binding|checksum|ownerEpoch|publicationGeneration|inspectionId/iu.test(key) &&
    (!launch || !launchPrivateKey.test(key)) && publicData(descriptor.value, depth + 1, launch));
}

function plainArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length || value.length > maximum) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).length === value.length + 1 && Object.entries(descriptors).every(([key, descriptor]) => key === 'length' ||
    /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < value.length && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
}

function validatePublicJob(value, expected, launch) {
  try {
    if (!isClosedObject(value, jobKeys) || value.type !== 'minecraft-core-modpack-job' || value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !identifier(value.jobId) || !identifier(value.serverId) || !operationKind(value.operationKind) ||
        value.planFingerprint !== null && !sha256(value.planFingerprint) || !phases.has(value.phase) ||
        value.swapStep !== null && !operationKind(value.swapStep) || typeof value.cancellationRequested !== 'boolean' ||
        !timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.terminalAt !== null && !timestamp(value.terminalAt)) return false;
    for (const key of ['jobId', 'serverId', 'operationKind', 'planFingerprint']) if (expected[key] != null && expected[key] !== value[key]) return false;
    if (value.progress !== null && (!isClosedObject(value.progress, ['percent', 'message', 'currentItem']) ||
        !Number.isSafeInteger(value.progress.percent) || value.progress.percent < 0 || value.progress.percent > 100 || !safeText(value.progress.message, 512) ||
        value.progress.currentItem !== null && !safeText(value.progress.currentItem, 256))) return false;
    const isTerminal = terminal.has(value.phase);
    if (isTerminal !== (value.terminalAt !== null) || isTerminal !== (value.outcome !== null) ||
        value.outcome !== null && (!publicData(value.outcome, 0, launch) || !isClosedObject(value.outcome, ['status'], Object.keys(value.outcome)) || value.outcome.status !== value.phase)) return false;
    if (!plainArray(value.events, 128)) return false;
    let previous = 0;
    for (const event of value.events) {
      if (!isClosedObject(event, eventKeys) || event.jobId !== value.jobId || !Number.isSafeInteger(event.sequence) || event.sequence <= previous || event.sequence > value.sequence ||
          !['progress', 'log'].includes(event.channel) || !phases.has(event.phase) || !timestamp(event.timestamp) || !safeText(event.message, 512) ||
          event.progress !== null && (!Number.isSafeInteger(event.progress) || event.progress < 0 || event.progress > 100) ||
          event.currentItem !== null && !safeText(event.currentItem, 256) || !publicData(event.details, 0, launch)) return false;
      previous = event.sequence;
    }
    return true;
  } catch { return false; }
}

export function isValidPublicJob(value, expected = {}) {
  return validatePublicJob(value, expected, false);
}

export function isValidLaunchJob(value, expected = {}) {
  return validatePublicJob(value, expected, true) && newKind(value.operationKind) && sha256(value.planFingerprint);
}

export function isValidSettlement(value) {
  try {
    if (!isClosedObject(value, ['status', 'destinationDisposition', 'recoveryAvailable'], ['reason']) ||
        !['active', 'settled', 'repair-pending', 'recovery-required', 'support-required'].includes(value.status) ||
        !['held', 'released', 'consumed'].includes(value.destinationDisposition) || typeof value.recoveryAvailable !== 'boolean') return false;
    if (['active', 'settled'].includes(value.status)) return !Object.hasOwn(value, 'reason') && !value.recoveryAvailable && (value.status !== 'settled' || value.destinationDisposition !== 'held');
    return reasons.has(value.reason) && (value.status === 'support-required' || value.destinationDisposition === 'held') && value.recoveryAvailable === (value.status === 'recovery-required');
  } catch { return false; }
}

export function isValidReconciliation(value, expected) {
  try {
    if (!value || !statuses.has(Object.getOwnPropertyDescriptor(value, 'status')?.value)) return false;
    const required = ['status', 'planId', 'planFingerprint'];
    if (value.status === 'started') required.push('job', 'settlement');
    if (['recovery-required', 'unavailable'].includes(value.status)) required.push('reason');
    return isClosedObject(value, required, value.status === 'pending' ? ['reason'] : []) && value.planId === expected.planId && value.planFingerprint === expected.planFingerprint &&
      (value.status !== 'started' || isValidLaunchJob(value.job, expected) && isValidSettlement(value.settlement)) &&
      (value.status !== 'pending' || !Object.hasOwn(value, 'reason') || value.reason === 'admission-unresolved') &&
      (value.status !== 'recovery-required' || reasons.has(value.reason)) &&
      (value.status !== 'unavailable' || value.reason === 'legacy-correlation-unavailable');
  } catch { return false; }
}

export function isValidLaunchSummary(item) {
  try {
    if (!isClosedObject(item, ['planId', 'planFingerprint', 'status', 'createdAt'], ['serverId', 'operationKind', 'displayName', 'jobId', 'settlement']) ||
        !identifier(item.planId) || !sha256(item.planFingerprint) || !statuses.has(item.status) || !timestamp(item.createdAt)) return false;
    if (Object.hasOwn(item, 'serverId') && !identifier(item.serverId) || Object.hasOwn(item, 'operationKind') && !newKind(item.operationKind) ||
        Object.hasOwn(item, 'displayName') && (typeof item.displayName !== 'string' || !item.displayName.trim() || item.displayName !== item.displayName.trim().normalize('NFC') ||
          item.displayName.length > 128 || /[\\/:*?"<>|\x00-\x1f]|[. ]$/u.test(item.displayName))) return false;
    return item.status === 'started' ? identifier(item.serverId) && identifier(item.jobId) && typeof item.displayName === 'string' && newKind(item.operationKind) &&
      isValidSettlement(item.settlement) : !Object.hasOwn(item, 'jobId') && !Object.hasOwn(item, 'settlement');
  } catch { return false; }
}
