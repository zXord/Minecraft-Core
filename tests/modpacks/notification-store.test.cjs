const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');

function nativeDurability() {
  return {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    flushDirectory() {}
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-notifications-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath);
  let temporary = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: nativeDurability(),
    allowedRoots: [root],
    tempNameFactory: () => `notification-${++temporary}`
  });
  let now = Date.parse('2026-08-01T00:00:00.000Z');
  const dependencies = {
    userDataPath,
    fsApi: fs,
    durableFs,
    clock: () => new Date(now += 1000),
    randomUUID: () => '00000000-0000-4000-8000-000000000026'
  };
  return { dependencies, root, userDataPath };
}

function updateNotification(overrides = {}) {
  return {
    type: 'update-available',
    serverId: 'server-1',
    source: { provider: 'modrinth', sourceId: 'project-1' },
    release: { releaseId: 'version-2', version: '2.0.0', prerelease: false },
    title: 'Modpack update available',
    message: 'Version 2.0.0 is ready to review.',
    action: { actionId: 'open-details', opaqueRef: 'notification-release-1' },
    dedupeKey: 'server-1:modrinth:version-2:update',
    ...overrides
  };
}

test('notifications persist across restart and acknowledgement is idempotent', async (t) => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies } = fixture(t);
  const store = new NotificationStore(dependencies);
  assert.deepEqual(await store.initialize(), []);
  const created = await store.create(updateNotification());
  assert.equal(created.read, false);
  assert.equal(created.notificationId, '00000000-0000-4000-8000-000000000026');
  assert.equal(Object.isFrozen(created), true);

  const firstAck = await store.acknowledge(created.notificationId);
  const secondAck = await store.acknowledge(created.notificationId);
  assert.equal(firstAck.read, true);
  assert.deepEqual(secondAck, firstAck);

  const reloaded = new NotificationStore(dependencies);
  const records = await reloaded.initialize();
  assert.equal(records.length, 1);
  assert.equal(records[0].read, true);
  assert.equal((await reloaded.list({ unreadOnly: true })).length, 0);
});

test('dedupe keys never create a second notification or install anything', async (t) => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies } = fixture(t);
  const store = new NotificationStore(dependencies);
  await store.initialize();
  const first = await store.create(updateNotification());
  const duplicate = await store.create(updateNotification({ message: 'Duplicate check result.' }));
  assert.equal(duplicate.notificationId, first.notificationId);
  assert.equal((await store.list()).length, 1);
  assert.doesNotMatch(JSON.stringify(duplicate), /install(?:Now|Command|Path)/i);
});

test('all persistent notification types use closed safe action payloads', async (t) => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies } = fixture(t);
  let suffix = 0;
  dependencies.randomUUID = () => `00000000-0000-4000-8000-${String(++suffix).padStart(12, '0')}`;
  const store = new NotificationStore(dependencies);
  await store.initialize();
  for (const type of [
    'update-available', 'prerelease-available', 'github-asset-selection-required', 'source-changed',
    'integrity-warning', 'rate-limit', 'operation-outcome', 'recovery-required'
  ]) {
    await store.create(updateNotification({ type, dedupeKey: `server-1:${type}` }));
  }
  assert.equal((await store.list()).length, 8);
  await assert.rejects(
    store.create(updateNotification({
      action: { actionId: 'open-details', opaqueRef: 'ref', path: 'C:\\Servers\\secret' },
      dedupeKey: 'unsafe-path'
    })),
    error => error.code === 'INVALID_REQUEST'
  );
  await assert.rejects(
    store.create(updateNotification({ type: 'install-now', dedupeKey: 'unsafe-type' })),
    error => error.code === 'INVALID_REQUEST'
  );
});

test('tampered persistence fails closed and a failed write preserves prior notifications', async (t) => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies, userDataPath } = fixture(t);
  const store = new NotificationStore(dependencies);
  await store.initialize();
  await store.create(updateNotification());
  const filePath = path.join(userDataPath, 'modpack-lifecycle', 'notifications.json');
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  persisted.notifications[0].message = 'tampered';
  fs.writeFileSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`);
  await assert.rejects(new NotificationStore(dependencies).initialize(), error => error.code === 'RECOVERY_REQUIRED');
});

test('new durable notifications emit one frozen main-owned event and dedupe emits none', async (t) => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies } = fixture(t);
  const events = [];
  dependencies.eventSink = event => events.push(event);
  const store = new NotificationStore(dependencies);
  await store.initialize();
  const created = await store.create(updateNotification());
  await store.create(updateNotification({ message: 'duplicate' }));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], created);
  assert.equal(Object.isFrozen(events[0]), true);
});

test('retirement notices preserve dismissal until material state or reason changes across restart', async t => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies, userDataPath } = fixture(t);
  const events = [];
  dependencies.eventSink = event => events.push(event);
  let store = new NotificationStore(dependencies);
  await store.initialize();
  const request = { jobId: 'failed-job-1', serverId: 'server-1', state: 'retained', reason: 'target-busy' };
  assert.equal(typeof store.upsertRetirementNotice, 'function');
  const first = await store.upsertRetirementNotice(request);
  assert.equal(first.type, 'retention-warning');
  assert.equal(first.action, null);
  assert.equal(first.release, null);
  assert.equal(first.dedupeKey, 'retirement:failed-job-1');
  assert.deepEqual(first.source, { provider: 'local', sourceId: 'failed-backup-retirement' });
  assert.equal(Object.keys(first).length, 11);
  const read = await store.acknowledge(first.notificationId);
  store = new NotificationStore(dependencies);
  await store.initialize();
  assert.deepEqual(await store.upsertRetirementNotice(request), read);
  const changed = await store.upsertRetirementNotice({ ...request, reason: 'target-running' });
  assert.equal(changed.notificationId, first.notificationId);
  assert.equal(changed.message, first.message); // Same copy does not erase distinct durable reasons.
  assert.equal(changed.read, false);
  assert.notEqual(changed.timestamp, first.timestamp);
  const partial = await store.upsertRetirementNotice({ ...request, state: 'partial', reason: 'io-failure' });
  assert.equal(partial.title, 'Backup cleanup incomplete');
  const reclaimed = await store.upsertRetirementNotice({ ...request, state: 'reclaimed', reason: null });
  assert.equal(reclaimed.title, 'Backup cleanup complete');
  assert.equal(reclaimed.read, true);
  assert.equal((await store.list()).length, 1);
  for (const item of [...events, ...await store.list(), reclaimed]) assert.equal(Object.hasOwn(item, 'retirement'), false);
  const persisted = JSON.parse(fs.readFileSync(path.join(userDataPath, 'modpack-lifecycle', 'notifications.json'), 'utf8'));
  assert.deepEqual(persisted.notifications[0].retirement, { state: 'reclaimed', reason: null });
});

test('retirement private evidence is strict and checksum protected; general create cannot mint it', async t => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies, userDataPath } = fixture(t);
  const store = new NotificationStore(dependencies);
  await store.initialize();
  assert.equal(typeof store.upsertRetirementNotice, 'function');
  await assert.rejects(store.create(updateNotification({ type: 'retention-warning' })), e => e.code === 'INVALID_REQUEST');
  const request = { jobId: 'failed-job-1', serverId: 'server-1', state: 'retained', reason: 'target-busy' };
  for (const invalid of [{ ...request, state: '__proto__' }, { ...request, reason: 'unknown' },
    { ...request, privatePath: 'forbidden' }, { ...request, jobId: '../escape' }]) {
    await assert.rejects(store.upsertRetirementNotice(invalid), e => e.code === 'INVALID_REQUEST');
  }
  await store.upsertRetirementNotice(request);
  const file = path.join(userDataPath, 'modpack-lifecycle', 'notifications.json');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  persisted.notifications[0].retirement.reason = 'target-running';
  fs.writeFileSync(file, `${JSON.stringify(persisted, null, 2)}\n`);
  await assert.rejects(new NotificationStore(dependencies).initialize(), e => e.code === 'RECOVERY_REQUIRED');
});

test('retirement warning maps strict results without turning them into operation actions', async t => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies } = fixture(t);
  const store = new NotificationStore(dependencies);
  await store.initialize();
  const { createRetirementWarningPublisher } = require('../../electron/services/modpack-lifecycle/failed-restorepoint-retirement-warning.cjs');
  const publish = createRetirementWarningPublisher({ notificationStore: store });
  const base = { jobId: 'failed-job-1', status: 'deferred', reason: 'missing-final-policy-proof', progress: null, archiveBytesReclaimed: '0' };
  await publish({ jobId: base.jobId, serverId: 'server-1', result: base });
  assert.equal((await store.list())[0].title, 'Backup retained for safety');
  await publish({ jobId: base.jobId, serverId: 'server-1', result: { ...base, progress: 'archive-deleted', reason: 'io-failure' } });
  assert.equal((await store.list())[0].title, 'Backup cleanup incomplete');
  await publish({ jobId: base.jobId, serverId: 'server-1', result: { ...base, status: 'reclaimed', reason: null, progress: 'deleted', archiveBytesReclaimed: '42' } });
  assert.equal((await store.list())[0].read, true);
  await publish({ jobId: base.jobId, serverId: 'server-1', result: { ...base, status: 'not-eligible', reason: null } });
  assert.equal((await store.list()).length, 1);
  await assert.rejects(publish({ jobId: base.jobId, serverId: 'server-1', result: { ...base, rawPath: 'forbidden' } }), e => e.code === 'INVALID_REQUEST');
  await assert.rejects(publish({ jobId: base.jobId, serverId: 'server-1', result: { ...base, reason: null } }), e => e.code === 'INVALID_REQUEST');
  await assert.rejects(publish({ jobId: base.jobId, serverId: 'server-1', result: { ...base, status: 'reclaimed', reason: null } }), e => e.code === 'INVALID_REQUEST');
});

test('retirement notice CAS failure preserves previous durable and public state', async t => {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { dependencies } = fixture(t);
  const first = new NotificationStore(dependencies); const stale = new NotificationStore(dependencies);
  await first.initialize(); await stale.initialize();
  const request = { jobId: 'failed-one', serverId: 'server-1', state: 'retained', reason: 'target-busy' };
  const saved = await first.upsertRetirementNotice(request);
  await assert.rejects(stale.upsertRetirementNotice({ ...request, reason: 'io-failure' }), error => error.code === 'COMMIT_FAILED');
  assert.deepEqual(await stale.list(), []);
  const fresh = new NotificationStore(dependencies); await fresh.initialize(); assert.deepEqual(await fresh.list(), [saved]);
});
