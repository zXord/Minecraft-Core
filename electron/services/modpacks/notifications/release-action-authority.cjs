const crypto = require('node:crypto');

const { ModpackError, deepFreeze } = require('../errors.cjs');

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const REVIEW_ACTIONS = new Map([
  ['open-details', 'details'],
  ['choose-another-asset', 'asset-selection']
]);

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The release action reference is invalid', { cause });
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid();
  return value;
}

function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key)) ||
      Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) throw invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function parseReference(actionId, opaqueRef) {
  if (actionId === 'retry') {
    const match = /^release-check:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(opaqueRef);
    if (!match) throw invalid();
    return { kind: 'check', trackingId: match[1] };
  }
  if (REVIEW_ACTIONS.has(actionId)) {
    const match = /^release-review:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(opaqueRef);
    if (!match) throw invalid();
    return { kind: 'review', trackingId: match[1], releaseId: match[2] };
  }
  throw invalid();
}

class ReleaseNotificationReferenceAuthority {
  constructor({ notificationStore, trackingStore, randomUUID = crypto.randomUUID } = {}) {
    if (!notificationStore || typeof notificationStore.list !== 'function' ||
        !trackingStore || typeof trackingStore.get !== 'function' || typeof randomUUID !== 'function') throw invalid();
    this.notificationStore = notificationStore;
    this.trackingStore = trackingStore;
    this.randomUUID = randomUUID;
    this.activeByReference = new Map();
    this.claims = new Map();
    this.consumed = new Set();
  }

  async claim(requestValue) {
    const request = strictObject(requestValue, ['actionId', 'opaqueRef']);
    const actionId = identifier(request.actionId);
    const opaqueRef = identifier(request.opaqueRef);
    const parsed = parseReference(actionId, opaqueRef);
    if (this.activeByReference.has(opaqueRef) || this.consumed.has(opaqueRef)) throw invalid();

    const [tracking, notifications] = await Promise.all([
      this.trackingStore.get(parsed.trackingId),
      this.notificationStore.list({ unreadOnly: false, limit: 1000 })
    ]);
    if (!tracking || tracking.trackingId !== parsed.trackingId || !Array.isArray(notifications)) throw invalid();
    const issued = notifications.filter(item => item?.action?.actionId === actionId &&
      item.action.opaqueRef === opaqueRef && item.serverId === tracking.serverId);
    if (issued.length !== 1) throw invalid();

    let targetKind;
    let targetId;
    if (parsed.kind === 'check') {
      if (issued[0].release !== null) throw invalid();
      targetKind = 'retry';
      targetId = parsed.trackingId;
    } else {
      if (issued[0].release?.releaseId !== parsed.releaseId) throw invalid();
      targetKind = REVIEW_ACTIONS.get(actionId);
      targetId = identifier(`release:${parsed.trackingId}:${parsed.releaseId}`);
    }
    const generated = identifier(String(this.randomUUID()));
    const claimId = identifier(`claim:${generated}`);
    if (this.claims.has(claimId)) throw invalid();
    const claim = deepFreeze({
      claimId,
      reference: { actionId, targetKind, targetId }
    });
    this.activeByReference.set(opaqueRef, claimId);
    this.claims.set(claimId, { actionId, opaqueRef });
    return claim;
  }

  async complete(claimIdValue) {
    const claimId = identifier(claimIdValue);
    const claim = this.claims.get(claimId);
    if (!claim || this.activeByReference.get(claim.opaqueRef) !== claimId) return false;
    this.claims.delete(claimId);
    this.activeByReference.delete(claim.opaqueRef);
    if (claim.actionId === 'retry') this.consumed.add(claim.opaqueRef);
    return true;
  }

  async release(claimIdValue) {
    const claimId = identifier(claimIdValue);
    const claim = this.claims.get(claimId);
    if (!claim || this.activeByReference.get(claim.opaqueRef) !== claimId) return false;
    this.claims.delete(claimId);
    this.activeByReference.delete(claim.opaqueRef);
    return true;
  }
}

class ReleaseActionExecutor {
  constructor({ releaseMonitor } = {}) {
    if (!releaseMonitor || typeof releaseMonitor.checkOne !== 'function') throw invalid();
    this.releaseMonitor = releaseMonitor;
  }

  async execute(requestValue) {
    const request = strictObject(requestValue, ['actionId', 'targetKind', 'targetId']);
    if (request.actionId !== 'retry' || request.targetKind !== 'retry') throw invalid();
    const trackingId = identifier(request.targetId);
    await this.releaseMonitor.checkOne(trackingId, { force: true });
    return deepFreeze({ status: 'completed', referenceId: identifier(`release-check:${trackingId}`) });
  }
}

module.exports = { ReleaseActionExecutor, ReleaseNotificationReferenceAuthority };
