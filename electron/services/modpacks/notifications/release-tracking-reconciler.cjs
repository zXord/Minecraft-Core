const crypto = require('node:crypto');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { normalizeTrackingRecord } = require('./release-tracking-store.cjs');

const INTENT_SCHEMA_VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TRACKING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function invalid(cause) {
  if (cause instanceof ModpackError && cause.code === 'INVALID_REQUEST') return cause;
  return new ModpackError('INVALID_REQUEST', 'The release tracking reconciliation request is invalid', { cause });
}

function recoveryRequired(cause) {
  if (cause instanceof ModpackError && cause.code === 'RECOVERY_REQUIRED') return cause;
  return new ModpackError('RECOVERY_REQUIRED', 'Release tracking reconciliation requires recovery', { cause });
}

function strictObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.keys(descriptors);
  if (names.some(name => !allowedKeys.includes(name)) || requiredKeys.some(name => !Object.hasOwn(descriptors, name))) {
    throw invalid();
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
  return value;
}

function identifier(value, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalid();
  return value;
}

function nowIso(clock) {
  let value;
  try { value = clock(); } catch (error) { throw invalid(error); }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date.toISOString();
}

function trackingIdFor(serverIdValue) {
  const serverId = identifier(serverIdValue);
  const readable = `tracking-${serverId}`;
  if (readable.length <= 128) return readable;
  const digest = crypto.createHash('sha256').update(JSON.stringify(serverId), 'utf8').digest('hex');
  return `tracking-${digest.slice(0, 48)}`;
}

function createTrackingRecord({ serverId, source, clock }) {
  const trackingId = trackingIdFor(serverId);
  return normalizeTrackingRecord({
    trackingId,
    serverId,
    provider: source.provider,
    projectId: source.provider === 'modrinth' ? source.projectId : null,
    repositoryId: source.provider === 'github' ? source.repositoryId : null,
    githubOwner: source.provider === 'github' ? source.githubOwner : null,
    githubRepo: source.provider === 'github' ? source.githubRepo : null,
    includePrereleases: false,
    acceptedMapping: source.acceptedMapping || null,
    assetPattern: source.provider === 'github' ? source.assetPattern || null : null,
    etag: null,
    lastSuccessfulCheck: null,
    lastFailure: null,
    nextDueAt: nowIso(clock),
    lastSnapshot: null
  });
}

function createReleaseTrackingIntent({ serverId: serverIdValue, operationKind, source, clock = () => new Date() } = {}) {
  const serverId = identifier(serverIdValue);
  if (typeof operationKind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(operationKind) || typeof clock !== 'function') {
    throw invalid();
  }
  const trackingId = trackingIdFor(serverId);
  const trackedProvider = source && typeof source === 'object' && ['github', 'modrinth'].includes(source.provider);
  const remove = ['detach', 'uninstall-managed'].includes(operationKind) || !trackedProvider;
  if (remove) {
    return deepFreeze({
      schemaVersion: INTENT_SCHEMA_VERSION,
      action: 'remove',
      status: 'pending',
      serverId,
      trackingId
    });
  }
  return deepFreeze({
    schemaVersion: INTENT_SCHEMA_VERSION,
    action: 'upsert',
    status: 'pending',
    serverId,
    trackingId,
    record: createTrackingRecord({ serverId, source, clock })
  });
}

function normalizeReleaseTrackingIntent(value) {
  strictObject(value, ['schemaVersion', 'action', 'status', 'serverId', 'trackingId', 'record'],
    ['schemaVersion', 'action', 'status', 'serverId', 'trackingId']);
  if (value.schemaVersion !== INTENT_SCHEMA_VERSION || !['upsert', 'remove'].includes(value.action) ||
      !['pending', 'applied'].includes(value.status)) throw invalid();
  const serverId = identifier(value.serverId);
  const trackingId = identifier(value.trackingId, TRACKING_ID);
  if (trackingId !== trackingIdFor(serverId)) throw invalid();
  if (value.action === 'remove') {
    if (value.record !== undefined) throw invalid();
    return { schemaVersion: INTENT_SCHEMA_VERSION, action: 'remove', status: value.status, serverId, trackingId };
  }
  if (value.record === undefined) throw invalid();
  const record = normalizeTrackingRecord(value.record);
  if (record.serverId !== serverId || record.trackingId !== trackingId) throw invalid();
  return { schemaVersion: INTENT_SCHEMA_VERSION, action: 'upsert', status: value.status, serverId, trackingId, record };
}

function sameIntent(left, right) {
  const normalizedLeft = normalizeReleaseTrackingIntent(left);
  const normalizedRight = normalizeReleaseTrackingIntent(right);
  return JSON.stringify({ ...normalizedLeft, status: 'pending' }) ===
    JSON.stringify({ ...normalizedRight, status: 'pending' });
}

class ReleaseTrackingReconciler {
  constructor({ trackingStore, recoveryRegistry, clock = () => new Date() } = {}) {
    if (!trackingStore || ['list', 'remove', 'upsert'].some(method => typeof trackingStore[method] !== 'function') ||
        !recoveryRegistry || typeof recoveryRegistry.load !== 'function' ||
        typeof recoveryRegistry.transition !== 'function' || typeof clock !== 'function') throw invalid();
    this.trackingStore = trackingStore;
    this.recoveryRegistry = recoveryRegistry;
    this.clock = clock;
  }

  createIntent(request) {
    return createReleaseTrackingIntent({ ...request, clock: this.clock });
  }

  async persistPending(jobIdValue, request) {
    return this.persistIntent(jobIdValue, this.createIntent(request));
  }

  async persistIntent(jobIdValue, intentValue) {
    const jobId = identifier(jobIdValue);
    const intended = normalizeReleaseTrackingIntent(intentValue);
    if (intended.status !== 'pending') throw invalid();
    const record = await this.recoveryRegistry.load(jobId);
    if (!record || record.jobId !== jobId || record.target?.stableServerId !== intended.serverId) throw recoveryRequired();
    const current = record.outcome?.releaseTracking;
    if (current !== undefined) {
      if (!sameIntent(current, intended)) throw recoveryRequired();
      return deepFreeze(normalizeReleaseTrackingIntent(current));
    }
    const updated = await this.recoveryRegistry.transition(jobId, {
      expectedPhase: record.phase,
      nextPhase: record.phase,
      patch: { outcome: { ...(record.outcome || {}), releaseTracking: intended } }
    });
    return deepFreeze(normalizeReleaseTrackingIntent(updated.outcome.releaseTracking));
  }

  async reconcile(jobIdValue) {
    const jobId = identifier(jobIdValue);
    let recoveryRecord = await this.recoveryRegistry.load(jobId);
    if (!recoveryRecord || recoveryRecord.jobId !== jobId) throw recoveryRequired();
    const intent = normalizeReleaseTrackingIntent(recoveryRecord.outcome?.releaseTracking);
    if (recoveryRecord.target?.stableServerId !== intent.serverId) throw recoveryRequired();
    if (intent.status === 'applied') return deepFreeze(intent);

    try {
      const records = await this.trackingStore.list();
      if (!Array.isArray(records)) throw invalid();
      for (const record of records) {
        if (record?.serverId === intent.serverId && (intent.action === 'remove' || record.trackingId !== intent.trackingId)) {
          await this.trackingStore.remove(record.trackingId);
        }
      }
      if (intent.action === 'upsert') await this.trackingStore.upsert(intent.record);
    } catch (error) {
      throw recoveryRequired(error);
    }

    recoveryRecord = await this.recoveryRegistry.load(jobId);
    if (!recoveryRecord || recoveryRecord.target?.stableServerId !== intent.serverId ||
        !sameIntent(recoveryRecord.outcome?.releaseTracking, intent)) throw recoveryRequired();
    const applied = { ...intent, status: 'applied' };
    await this.recoveryRegistry.transition(jobId, {
      expectedPhase: recoveryRecord.phase,
      nextPhase: recoveryRecord.phase,
      patch: { outcome: { ...(recoveryRecord.outcome || {}), releaseTracking: applied } }
    });
    return deepFreeze(applied);
  }
}

module.exports = {
  INTENT_SCHEMA_VERSION,
  ReleaseTrackingReconciler,
  createReleaseTrackingIntent,
  normalizeReleaseTrackingIntent,
  trackingIdFor
};
