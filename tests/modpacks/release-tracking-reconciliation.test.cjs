const assert = require('node:assert/strict');
const test = require('node:test');

const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const {
  ReleaseTrackingReconciler,
  createReleaseTrackingIntent,
  normalizeReleaseTrackingIntent
} = require('../../electron/services/modpacks/notifications/release-tracking-reconciler.cjs');

const NOW = new Date('2026-08-02T00:00:00.000Z');

class MemoryRecoveryRegistry {
  constructor(record) { this.record = structuredClone(record); }
  async load(jobId) { return this.record?.jobId === jobId ? structuredClone(this.record) : null; }
  async transition(jobId, request) {
    assert.equal(jobId, this.record.jobId);
    assert.equal(request.expectedPhase, this.record.phase);
    this.record = { ...this.record, ...structuredClone(request.patch), phase: request.nextPhase };
    return structuredClone(this.record);
  }
}

function recoveryRecord(operationKind = 'upgrade') {
  return {
    jobId: 'job-track',
    operationKind,
    phase: 'committed-healthy',
    target: { stableServerId: 'server-one' },
    outcome: { revisionEvent: { eventId: 'revision-one', published: true } }
  };
}

function githubSource() {
  return {
    provider: 'github',
    repositoryId: '123456',
    githubOwner: 'example-owner',
    githubRepo: 'example-pack',
    acceptedMapping: null,
    assetPattern: null
  };
}

test('tracking intent is closed, authority-free recovery state and retries a failed list on restart', async () => {
  const registry = new MemoryRecoveryRegistry(recoveryRecord());
  let failList = true;
  const upserts = [];
  const store = {
    async list() {
      if (failList) { failList = false; throw new Error('injected list crash'); }
      return [];
    },
    async remove() { return false; },
    async upsert(value) { upserts.push(structuredClone(value)); return value; }
  };
  const request = { serverId: 'server-one', operationKind: 'update', source: githubSource() };
  const firstProcess = new ReleaseTrackingReconciler({ trackingStore: store, recoveryRegistry: registry, clock: () => NOW });
  await firstProcess.persistPending('job-track', request);

  const serialized = JSON.stringify(registry.record.outcome.releaseTracking);
  assert.doesNotMatch(serialized, /(?:path|url|uri|token|secret|password|cache|workspace|directory)/i);
  assert.doesNotMatch(serialized, /(?:https?:\/\/|file:\/\/|[A-Za-z]:\\)/i);
  await assert.rejects(firstProcess.reconcile('job-track'), error => error.code === 'RECOVERY_REQUIRED');
  assert.equal(registry.record.outcome.releaseTracking.status, 'pending');

  const restarted = new ReleaseTrackingReconciler({ trackingStore: store, recoveryRegistry: registry, clock: () => NOW });
  const applied = await restarted.reconcile('job-track');
  assert.equal(applied.status, 'applied');
  assert.equal(registry.record.outcome.releaseTracking.status, 'applied');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].repositoryId, '123456');
});

test('upsert reconciliation is idempotent after stale-record removal and an injected upsert crash', async () => {
  const registry = new MemoryRecoveryRegistry(recoveryRecord());
  const records = [{ trackingId: 'legacy-track', serverId: 'server-one' }];
  let failUpsert = true;
  const removals = [];
  const store = {
    async list() { return structuredClone(records); },
    async remove(trackingId) {
      removals.push(trackingId);
      const index = records.findIndex(record => record.trackingId === trackingId);
      if (index >= 0) records.splice(index, 1);
      return index >= 0;
    },
    async upsert(value) {
      if (failUpsert) { failUpsert = false; throw new Error('injected upsert crash'); }
      records.push(structuredClone(value));
      return value;
    }
  };
  const reconciler = new ReleaseTrackingReconciler({ trackingStore: store, recoveryRegistry: registry, clock: () => NOW });
  await reconciler.persistPending('job-track', {
    serverId: 'server-one', operationKind: 'update', source: githubSource()
  });
  await assert.rejects(reconciler.reconcile('job-track'), error => error.code === 'RECOVERY_REQUIRED');
  assert.deepEqual(removals, ['legacy-track']);
  assert.equal(registry.record.outcome.releaseTracking.status, 'pending');

  await reconciler.reconcile('job-track');
  await reconciler.reconcile('job-track');
  assert.equal(records.length, 1);
  assert.equal(records[0].trackingId, 'tracking-server-one');
  assert.equal(registry.record.outcome.releaseTracking.status, 'applied');
});

test('detach removal retries after a partial remove failure and rejects forged intent identity', async () => {
  const registry = new MemoryRecoveryRegistry(recoveryRecord('detach'));
  const records = [
    { trackingId: 'legacy-one', serverId: 'server-one' },
    { trackingId: 'legacy-two', serverId: 'server-one' }
  ];
  let failSecond = true;
  const store = {
    async list() { return structuredClone(records); },
    async remove(trackingId) {
      if (trackingId === 'legacy-two' && failSecond) { failSecond = false; throw new Error('injected remove crash'); }
      const index = records.findIndex(record => record.trackingId === trackingId);
      if (index >= 0) records.splice(index, 1);
      return index >= 0;
    },
    async upsert() { throw new Error('unexpected upsert'); }
  };
  const reconciler = new ReleaseTrackingReconciler({ trackingStore: store, recoveryRegistry: registry, clock: () => NOW });
  await reconciler.persistPending('job-track', { serverId: 'server-one', operationKind: 'detach', source: githubSource() });
  await assert.rejects(reconciler.reconcile('job-track'), error => error.code === 'RECOVERY_REQUIRED');
  assert.equal(records.length, 1);
  await reconciler.reconcile('job-track');
  assert.deepEqual(records, []);
  assert.equal(registry.record.outcome.releaseTracking.status, 'applied');

  const forged = createReleaseTrackingIntent({
    serverId: 'server-one', operationKind: 'detach', source: null, clock: () => NOW
  });
  assert.throws(
    () => normalizeReleaseTrackingIntent({ ...forged, trackingId: 'tracking-other-server' }),
    error => error instanceof ModpackError && error.code === 'INVALID_REQUEST'
  );
});
