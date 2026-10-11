const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const modulePath = path.resolve(__dirname, '../../src/utils/modpacks/launchResultValidation.js');
const helpers = () => import(`data:text/javascript;base64,${fs.readFileSync(modulePath).toString('base64')}`);
const identity = { jobId: 'launch-job', serverId: 'pending-launch', operationKind: 'install-new', planFingerprint: 'a'.repeat(64) };
const job = () => ({ type: 'minecraft-core-modpack-job', schemaVersion: 1, sequence: 2, ...identity, phase: 'completed', swapStep: null,
  progress: { percent: 100, message: 'Complete', currentItem: null }, cancellationRequested: false,
  createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:01.000Z', terminalAt: '2026-10-11T00:00:01.000Z',
  outcome: { status: 'completed', kind: 'completed', actions: [] }, events: [] });
const credentials = { planId: 'plan-launch-v1-11111111-1111-4111-8111-111111111111', planFingerprint: identity.planFingerprint };

test('launch response accepts real complete DTOs and exact captured identity only', async () => {
  const { isValidPublicJob, isValidLaunchJob } = await helpers();
  assert.equal(isValidPublicJob(job(), identity), true);
  assert.equal(isValidLaunchJob(job(), identity), true);
  for (const patch of [{ serverId: 'other' }, { jobId: 'other' }, { operationKind: 'import-files-only-new' }, { planFingerprint: 'b'.repeat(64) }, { sequence: -1 }, { schemaVersion: 2 }, { checksum: 'private' }, { terminalAt: null }, { outcome: { status: 'failed' } }, { progress: { percent: 1.5, message: 'bad', currentItem: null } }, { createdAt: '2026-02-31T00:00:00.000Z' }]) {
    assert.equal(isValidLaunchJob({ ...job(), ...patch }, identity), false, JSON.stringify(patch));
  }
  assert.equal(isValidPublicJob({ ...job(), operationKind: 'repair' }, { ...identity, operationKind: 'repair' }), true);
  assert.equal(isValidLaunchJob({ ...job(), operationKind: 'repair' }, { ...identity, operationKind: 'repair' }), false);
});

test('launch response rejects malformed nested public data without invoking getters', async () => {
  const { isValidLaunchJob } = await helpers();
  let reads = 0;
  const outcome = { status: 'completed' };
  Object.defineProperty(outcome, 'kind', { enumerable: true, get() { reads++; return 'completed'; } });
  for (const value of [outcome, { status: 'completed', nested: { targetPath: 'private' } }, { status: 'completed', actions: [{ opaqueRef: 'ref', command: 'private' }] }, { status: 'completed', count: NaN }]) {
    assert.equal(isValidLaunchJob({ ...job(), outcome: value }, identity), false);
  }
  assert.equal(reads, 0);
  const actions = [];
  Object.defineProperty(actions, '0', { enumerable: true, get() { reads++; return { actionId: 'retry', opaqueRef: 'ref' }; } });
  assert.equal(isValidLaunchJob({ ...job(), outcome: { status: 'completed', actions } }, identity), false);
  assert.equal(reads, 0);
  for (const events of [[{ jobId: 'other', sequence: 1 }], [{ sequence: 3, jobId: identity.jobId, channel: 'log', phase: 'completed', timestamp: job().createdAt, message: 'bad', progress: null, currentItem: null, details: null }]]) {
    assert.equal(isValidLaunchJob({ ...job(), events }, identity), false);
  }
});

test('reconciliation requires exact credentials and retains support-required actual disposition', async () => {
  const { isValidReconciliation, isValidSettlement, isValidLaunchSummary } = await helpers();
  for (const destinationDisposition of ['held', 'released', 'consumed']) {
    const settlement = { status: 'support-required', destinationDisposition, recoveryAvailable: false, reason: 'conflicting-evidence' };
    assert.equal(isValidSettlement(settlement), true);
    assert.equal(isValidReconciliation({ status: 'started', ...credentials, job: job(), settlement }, { ...identity, ...credentials }), true);
    assert.equal(isValidLaunchSummary({ status: 'started', ...credentials, createdAt: job().createdAt, serverId: identity.serverId, operationKind: identity.operationKind, jobId: identity.jobId, displayName: 'Prior setup', settlement }), true);
    assert.equal(isValidSettlement({ ...settlement, status: 'recovery-required', recoveryAvailable: true }), destinationDisposition === 'held');
    assert.equal(isValidSettlement({ ...settlement, status: 'repair-pending' }), destinationDisposition === 'held');
  }
  assert.equal(isValidReconciliation({ status: 'pending', ...credentials }, credentials), true);
  assert.equal(isValidReconciliation({ status: 'pending', ...credentials, planFingerprint: 'b'.repeat(64) }, credentials), false);
  assert.equal(isValidReconciliation({ status: 'not-started', ...credentials, reason: 'admission-unresolved' }, credentials), false);
  assert.equal(isValidReconciliation({ status: 'unavailable', ...credentials, reason: 'legacy-correlation-unavailable' }, credentials), true);
  assert.equal(isValidLaunchSummary({ status: 'pending', ...credentials, createdAt: job().createdAt }), true);
  assert.equal(isValidLaunchSummary({ status: 'pending', ...credentials, createdAt: job().createdAt, jobId: identity.jobId }), false);
});

test('R3 launch recursion rejects every approved private-key family in outcomes and event details', async () => {
  const { isValidLaunchJob } = await helpers();
  const keys = ['recordRevision', 'rawError', 'snapshot', 'epoch', 'publicationGeneration', 'capturedRecord', 'destination', 'executable',
    'nativeError', 'stack', 'cause', 'errno', 'syscall', 'binding', 'checksum', 'inputDirectoryId', 'outputDirectoryId'];
  for (const key of keys) {
    const nested = { result: [{ [key]: { sequence: 1 } }] };
    assert.equal(isValidLaunchJob({ ...job(), outcome: { status: 'completed', ...nested } }, identity), false, `outcome.${key}`);
    const event = { sequence: 1, jobId: identity.jobId, channel: 'log', phase: 'completed', timestamp: job().createdAt,
      message: 'Complete', progress: null, currentItem: null, details: nested };
    assert.equal(isValidLaunchJob({ ...job(), events: [event] }, identity), false, `event.${key}`);
  }
});

test('R3 ordinary public-v1 metadata remains distinct from launch-private correlation data', async () => {
  const { isValidPublicJob, isValidLaunchJob } = await helpers();
  const value = { ...job(), operationKind: 'uninstall-managed', outcome: { status: 'completed', sourceRevision: 1, targetRevision: 2 } };
  assert.equal(isValidPublicJob(value, { ...identity, operationKind: 'uninstall-managed' }), true);
  assert.equal(isValidLaunchJob(value), false);
});
