const { ModpackError } = require('../modpacks/errors.cjs');

const REASONS = Object.freeze(['missing-final-policy-proof', 'independent-owner', 'reference-proof-incomplete',
  'target-busy', 'target-running', 'recovery-pending', 'identity-mismatch', 'unsupported-native', 'io-failure',
  'publication-incomplete', 'writer-unproven', 'receipt-conflict', 'invalid-evidence']);
const STATES = Object.freeze(['retained', 'partial', 'deferred-proof', 'reclaimed']);
const COPY = Object.freeze({
  retained: Object.freeze({ title: 'Backup cleanup pending', message: "The failed attempt's backup is still retained. Cleanup will be retried when it is safe. This warning alone does not block Repair." }),
  partial: Object.freeze({ title: 'Backup cleanup incomplete', message: 'The archive was removed, but its protected metadata still needs cleanup. This warning alone does not block Repair.' }),
  'deferred-proof': Object.freeze({ title: 'Backup retained for safety', message: 'Final policy completion was not recorded for this attempt. Its backup has been kept; automatic cleanup cannot be promised. This warning alone does not block Repair.' }),
  reclaimed: Object.freeze({ title: 'Backup cleanup complete', message: "The failed attempt's archive and metadata were removed." })
});
function invalid() { return new ModpackError('INVALID_REQUEST', 'The retirement warning is invalid'); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(d => !d.enumerable || !Object.hasOwn(d, 'value'))) throw invalid();
}
function normalizeRetirementNotice(value) {
  exact(value, ['state', 'reason']);
  if (!STATES.includes(value.state) || (value.reason !== null && !REASONS.includes(value.reason)) ||
      (value.state === 'reclaimed' && value.reason !== null) ||
      (value.state !== 'reclaimed' && value.reason === null) ||
      (['retained', 'partial'].includes(value.state) && value.reason === 'missing-final-policy-proof') ||
      (value.state === 'deferred-proof' && value.reason !== 'missing-final-policy-proof')) throw invalid();
  return { state: value.state, reason: value.reason };
}
function retirementNoticeCopy(value) {
  const { state, reason } = normalizeRetirementNotice(value);
  if (state === 'retained' && reason === 'independent-owner') return { title: COPY.retained.title,
    message: 'Another history entry or operation still needs this backup. It has been kept. This warning alone does not block Repair.' };
  if (state === 'retained' && ['reference-proof-incomplete', 'invalid-evidence'].includes(reason)) return { title: COPY.retained.title,
    message: 'Backup ownership could not be fully verified. It has been kept; automatic cleanup cannot be promised. This warning alone does not block Repair.' };
  return COPY[state];
}
function createRetirementWarningPublisher({ notificationStore } = {}) {
  if (typeof notificationStore?.upsertRetirementNotice !== 'function') throw invalid();
  return async function publishRetirementWarning(request) {
    exact(request, ['jobId', 'serverId', 'result']);
    const { result } = request;
    exact(result, ['status', 'jobId', 'reason', 'progress', 'archiveBytesReclaimed']);
    if (result.jobId !== request.jobId || !['reclaimed', 'deferred', 'not-eligible'].includes(result.status) ||
        (result.reason !== null && !REASONS.includes(result.reason)) ||
        ![null, 'authorized', 'deleting', 'archive-deleted', 'deleted'].includes(result.progress) ||
        typeof result.archiveBytesReclaimed !== 'string' || !/^(0|[1-9][0-9]*)$/.test(result.archiveBytesReclaimed)) throw invalid();
    if ((result.status === 'deferred' && result.reason === null) ||
        (result.status === 'reclaimed' && (result.reason !== null || result.progress !== 'deleted')) ||
        (result.status === 'not-eligible' && (result.reason !== null || result.progress !== null || result.archiveBytesReclaimed !== '0'))) throw invalid();
    if (result.status === 'not-eligible') return;
    const state = result.status === 'reclaimed' ? 'reclaimed' : result.progress === 'archive-deleted' ? 'partial'
      : result.reason === 'missing-final-policy-proof' ? 'deferred-proof' : 'retained';
    await notificationStore.upsertRetirementNotice({ jobId: request.jobId, serverId: request.serverId, state, reason: result.reason });
  };
}
module.exports = { createRetirementWarningPublisher, normalizeRetirementNotice, retirementNoticeCopy };
