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

function persistenceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-release-monitor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(userDataPath);
  let temporary = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: nativeDurability(),
    allowedRoots: [root],
    tempNameFactory: () => `release-${++temporary}`
  });
  return { durableFs, root, userDataPath };
}

function githubTracking(overrides = {}) {
  return {
    trackingId: 'tracking-github-1',
    serverId: 'server-1',
    provider: 'github',
    projectId: null,
    repositoryId: '12345',
    githubOwner: 'Owner',
    githubRepo: 'Pack',
    includePrereleases: false,
    acceptedMapping: null,
    assetPattern: null,
    etag: null,
    lastSuccessfulCheck: null,
    lastFailure: null,
    nextDueAt: '2026-08-01T00:00:00.000Z',
    lastSnapshot: {
      releaseId: '100', version: 'v1.0.0', prerelease: false,
      publishedAt: '2026-07-01T00:00:00.000Z', assetFingerprint: 'a'.repeat(64), installable: true
    },
    ...overrides
  };
}

function modrinthTracking(overrides = {}) {
  return {
    trackingId: 'tracking-modrinth-1',
    serverId: 'server-2',
    provider: 'modrinth',
    projectId: 'project-permanent',
    repositoryId: null,
    githubOwner: null,
    githubRepo: null,
    includePrereleases: false,
    acceptedMapping: null,
    assetPattern: null,
    etag: null,
    lastSuccessfulCheck: null,
    lastFailure: null,
    nextDueAt: '2026-08-01T00:00:00.000Z',
    lastSnapshot: {
      releaseId: 'version-1', version: '1.0.0', prerelease: false,
      publishedAt: '2026-07-01T00:00:00.000Z', assetFingerprint: null, installable: true
    },
    ...overrides
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function stores(t, clock) {
  const { NotificationStore } = require('../../electron/services/modpacks/notifications/notification-store.cjs');
  const { ReleaseTrackingStore } = require('../../electron/services/modpacks/notifications/release-tracking-store.cjs');
  const persistence = persistenceFixture(t);
  let uuid = 0;
  const common = { ...persistence, fsApi: fs, clock };
  const notificationStore = new NotificationStore({
    ...common,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`
  });
  const trackingStore = new ReleaseTrackingStore(common);
  await notificationStore.initialize();
  await trackingStore.initialize();
  return { ...persistence, notificationStore, trackingStore };
}

test('tracking store persists permanent IDs, policy, ETag, snapshots, and restart state', async (t) => {
  let now = new Date('2026-08-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const { ReleaseTrackingStore } = require('../../electron/services/modpacks/notifications/release-tracking-store.cjs');
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking());
  await state.trackingStore.recordSuccess('tracking-github-1', {
    checkedAt: '2026-08-01T00:05:00.000Z',
    etag: '"release-etag"',
    nextDueAt: '2026-08-01T12:30:00.000Z',
    snapshot: {
      releaseId: '101', version: 'v1.1.0', prerelease: false,
      publishedAt: '2026-08-01T00:01:00.000Z', assetFingerprint: 'b'.repeat(64), installable: true
    }
  });
  const reloaded = new ReleaseTrackingStore({ userDataPath: state.userDataPath, durableFs: state.durableFs, fsApi: fs, clock });
  const records = await reloaded.initialize();
  assert.equal(records[0].repositoryId, '12345');
  assert.equal(records[0].etag, '"release-etag"');
  assert.equal(records[0].lastSnapshot.releaseId, '101');
  assert.equal(records[0].nextDueAt, '2026-08-01T12:30:00.000Z');
});

test('due monitor creates persistent stable, prerelease, asset-selection, and source-change notifications', async (t) => {
  let nowMs = Date.parse('2026-08-01T01:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking({ includePrereleases: true }));
  const responses = [
    { releaseId: '101', version: 'v1.1.0', prerelease: false, publishedAt: '2026-08-01T00:00:00.000Z', assetFingerprint: 'b'.repeat(64), installable: true },
    { releaseId: '102', version: 'v1.2.0-beta', prerelease: true, publishedAt: '2026-08-02T00:00:00.000Z', assetFingerprint: 'c'.repeat(64), installable: true },
    { releaseId: '103', version: 'v1.2.0', prerelease: false, publishedAt: '2026-08-03T00:00:00.000Z', assetFingerprint: 'd'.repeat(64), installable: false },
    { releaseId: '103', version: 'v1.2.0', prerelease: false, publishedAt: '2026-08-03T00:00:00.000Z', assetFingerprint: 'e'.repeat(64), installable: false }
  ];
  const provider = {
    async checkLatest(record) {
      assert.equal(record.repositoryId, '12345');
      const snapshot = responses.shift();
      return { notModified: false, etag: `"etag-${snapshot.releaseId}-${snapshot.assetFingerprint[0]}"`, snapshot };
    }
  };
  const { ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock, notificationStore: state.notificationStore, trackingStore: state.trackingStore,
    providers: { github: provider, modrinth: provider }
  });
  for (let index = 0; index < 4; index += 1) {
    await monitor.checkAll({ force: true });
    nowMs += 60_000;
  }
  const types = (await state.notificationStore.list()).map(item => item.type);
  assert.equal(types.includes('update-available'), true);
  assert.equal(types.includes('prerelease-available'), true);
  assert.equal(types.includes('github-asset-selection-required'), true);
  assert.equal(types.includes('source-changed'), true);
});

test('not-modified checks advance schedule without duplicate notifications', async (t) => {
  const nowMs = Date.parse('2026-08-01T01:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking({ etag: '"old"' }));
  const { ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock,
    notificationStore: state.notificationStore,
    trackingStore: state.trackingStore,
    providers: {
      github: { async checkLatest(record) { assert.equal(record.etag, '"old"'); return { notModified: true, etag: '"old"' }; } },
      modrinth: { async checkLatest() { throw new Error('not called'); } }
    }
  });
  await monitor.checkAll();
  assert.equal((await state.notificationStore.list()).length, 0);
  const tracking = await state.trackingStore.get('tracking-github-1');
  assert.equal(tracking.lastSuccessfulCheck, '2026-08-01T01:00:00.000Z');
  const delta = Date.parse(tracking.nextDueAt) - nowMs;
  assert.equal(delta >= 10.8 * 60 * 60 * 1000 && delta <= 13.2 * 60 * 60 * 1000, true);
});

test('rate limits and failures persist capped backoff and produce one safe notification', async (t) => {
  let nowMs = Date.parse('2026-08-01T01:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking());
  const rateLimit = Object.assign(new Error('limited'), {
    code: 'RATE_LIMITED',
    details: { retryAfterAt: '2026-08-01T03:00:00.000Z', token: 'must-not-persist' }
  });
  const { ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock,
    notificationStore: state.notificationStore,
    trackingStore: state.trackingStore,
    providers: {
      github: { async checkLatest() { throw rateLimit; } },
      modrinth: { async checkLatest() { throw rateLimit; } }
    }
  });
  await monitor.checkAll({ force: true });
  const record = await state.trackingStore.get('tracking-github-1');
  assert.equal(record.lastFailure.code, 'RATE_LIMITED');
  assert.equal(record.nextDueAt, '2026-08-01T03:00:00.000Z');
  const serialized = JSON.stringify(await state.notificationStore.list());
  assert.match(serialized, /rate-limit/);
  assert.doesNotMatch(serialized, /must-not-persist|token/);

  nowMs = Date.parse('2026-08-01T02:00:00.000Z');
  await monitor.checkAll();
  assert.equal((await state.notificationStore.list()).length, 1);
});

test('clock rollback cannot postpone a due source indefinitely', async (t) => {
  const nowMs = Date.parse('2026-07-01T00:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking({
    lastSuccessfulCheck: '2026-08-01T00:00:00.000Z',
    nextDueAt: '2026-08-01T12:00:00.000Z'
  }));
  let checks = 0;
  const { ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock,
    notificationStore: state.notificationStore,
    trackingStore: state.trackingStore,
    providers: {
      github: { async checkLatest() { checks += 1; return { notModified: true, etag: null }; } },
      modrinth: { async checkLatest() { throw new Error('not called'); } }
    }
  });
  await monitor.checkAll();
  assert.equal(checks, 1);
});

test('tracking persistence corruption fails closed before any provider call', async (t) => {
  const clock = () => new Date('2026-08-01T00:00:00.000Z');
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking());
  const filePath = path.join(state.userDataPath, 'modpack-lifecycle', 'release-tracking.json');
  const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  envelope.records[0].repositoryId = '99999';
  fs.writeFileSync(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  const { ReleaseTrackingStore } = require('../../electron/services/modpacks/notifications/release-tracking-store.cjs');
  await assert.rejects(
    new ReleaseTrackingStore({ userDataPath: state.userDataPath, durableFs: state.durableFs, fsApi: fs, clock }).initialize(),
    error => error.code === 'RECOVERY_REQUIRED'
  );
});

test('startup checks only due sources and installs one twelve-hour scheduler that can stop', async () => {
  let interval = null;
  let cleared = null;
  let checks = 0;
  const record = githubTracking({ nextDueAt: '2026-08-02T00:00:00.000Z' });
  const { BASE_INTERVAL_MS, ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock: () => new Date('2026-08-01T00:00:00.000Z'),
    notificationStore: { async create() {} },
    trackingStore: {
      async list() { return [record]; },
      async get() { return record; },
      async recordSuccess() {},
      async recordFailure() {}
    },
    providers: {
      github: { async checkLatest() { checks += 1; return { notModified: true, etag: null }; } },
      modrinth: { async checkLatest() { throw new Error('not called'); } }
    },
    setIntervalFn(callback, milliseconds) { interval = { callback, milliseconds }; return 'timer-one'; },
    clearIntervalFn(timer) { cleared = timer; }
  });
  await monitor.start();
  await monitor.start();
  assert.equal(checks, 0);
  assert.equal(interval.milliseconds, BASE_INTERVAL_MS);
  await interval.callback();
  assert.equal(checks, 0);
  monitor.stop();
  assert.equal(cleared, 'timer-one');
});

test('failure backoff is capped at twelve hours even after repeated failures', async (t) => {
  const nowMs = Date.parse('2026-08-01T01:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking({
    lastFailure: { code: 'PROVIDER_UNAVAILABLE', at: '2026-08-01T00:00:00.000Z', attempt: 63, retryAfterAt: null }
  }));
  const { BASE_INTERVAL_MS, ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock,
    notificationStore: state.notificationStore,
    trackingStore: state.trackingStore,
    providers: {
      github: { async checkLatest() { throw new Error('still unavailable'); } },
      modrinth: { async checkLatest() { throw new Error('not called'); } }
    }
  });
  await monitor.checkAll({ force: true });
  const failed = await state.trackingStore.get('tracking-github-1');
  assert.equal(failed.lastFailure.attempt, 64);
  assert.equal(Date.parse(failed.nextDueAt) - nowMs, BASE_INTERVAL_MS);
});

test('default GitHub and Modrinth adapters use permanent IDs and provider-native listings', async (t) => {
  const nowMs = Date.parse('2026-08-01T01:00:00.000Z');
  const clock = () => new Date(nowMs);
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking({ etag: '"persisted"' }));
  await state.trackingStore.upsert(modrinthTracking());
  const calls = [];
  const { ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock,
    notificationStore: state.notificationStore,
    trackingStore: state.trackingStore,
    providers: {
      github: {
        async listReleases(request) {
          calls.push(['github-releases', request]);
          return {
            notModified: false,
            etag: '"next"',
            releases: [{ releaseId: '101', tagName: 'v1.1.0', prerelease: false, publishedAt: '2026-08-01T00:00:00.000Z' }]
          };
        },
        async loadUploadedAssets(request) {
          calls.push(['github-assets', request]);
          return {
            assets: [{ assetId: '201', fileName: 'server.zip', providerDigest: null, size: '12', state: 'uploaded', updatedAt: '2026-08-01T00:00:00.000Z' }],
            choices: [{ complete: true }]
          };
        }
      },
      modrinth: {
        async listVersions(request) {
          calls.push(['modrinth-versions', request]);
          return [{ versionId: 'version-2', version: '1.1.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' }];
        }
      }
    }
  });
  await monitor.checkAll({ force: true });
  assert.equal(calls[0][1].repositoryId, '12345');
  assert.equal(calls[0][1].etag, '"persisted"');
  assert.equal(calls[1][1].releaseId, '101');
  assert.deepEqual(calls[2][1], { projectId: 'project-permanent', channels: ['release'] });
  const types = (await state.notificationStore.list()).map(item => item.type);
  assert.equal(types.filter(type => type === 'update-available').length, 2);
});

test('remembered GitHub patterns distinguish one provisional future match from zero or multiple choices', async (t) => {
  const clock = () => new Date('2026-08-01T01:00:00.000Z');
  const state = await stores(t, clock);
  const { compileAssetPattern } = require('../../electron/services/modpacks/providers/github-asset-pattern.cjs');
  const pattern = compileAssetPattern({
    filenameMatcher: 'server-pack-*.zip', reviewedRole: 'server-pack',
    archiveRootFingerprint: 'f'.repeat(64),
    runtimeEvidence: {
      minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
      javaMajor: 21, os: 'win32', architecture: 'x64'
    },
    multipartStructure: { kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 },
    userOverrides: { selectedRoot: null, runtimeChoice: null }
  });
  await state.trackingStore.upsert(githubTracking({ assetPattern: pattern }));
  let release = 101;
  const provider = {
    async listReleases() {
      return {
        notModified: false,
        releases: [{
          releaseId: String(release), tagName: `v${release}`, prerelease: false,
          publishedAt: `2026-08-01T00:00:${String(release - 100).padStart(2, '0')}.000Z`
        }]
      };
    },
    async loadUploadedAssets() {
      const count = release === 101 ? 1 : 2;
      const choices = Array.from({ length: count }, (_, index) => ({
        kind: 'single', groupingScheme: 'single', primaryPartId: String(201 + index), complete: true,
        parts: [{ providerAssetId: String(201 + index), fileName: `server-pack-v${release}-${index + 1}.zip` }]
      }));
      return {
        assets: choices.map(choice => ({
          assetId: choice.parts[0].providerAssetId,
          fileName: choice.parts[0].fileName,
          providerDigest: null, size: '12', state: 'uploaded', updatedAt: '2026-08-01T00:00:00.000Z'
        })),
        choices
      };
    }
  };
  const { ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock, notificationStore: state.notificationStore, trackingStore: state.trackingStore,
    providers: { github: provider, modrinth: { async listVersions() { return []; } } }
  });

  await monitor.checkAll({ force: true });
  release = 102;
  await monitor.checkAll({ force: true });
  const types = (await state.notificationStore.list()).map(item => item.type);
  assert.equal(types.includes('update-available'), true);
  assert.equal(types.includes('github-asset-selection-required'), true);
});

test('concurrent forced checks of one source share one provider request and one durable outcome', async (t) => {
  const clock = () => new Date('2026-08-01T01:00:00.000Z');
  const state = await stores(t, clock);
  await state.trackingStore.upsert(githubTracking());
  const gate = deferred();
  let checks = 0;
  const { ReleaseMonitor } = require('../../electron/services/modpacks/notifications/release-monitor.cjs');
  const monitor = new ReleaseMonitor({
    clock,
    notificationStore: state.notificationStore,
    trackingStore: state.trackingStore,
    providers: {
      github: { async checkLatest() { checks += 1; await gate.promise; return { notModified: true, etag: null }; } },
      modrinth: { async checkLatest() { throw new Error('not called'); } }
    }
  });
  const first = monitor.checkOne('tracking-github-1', { force: true });
  const second = monitor.checkOne('tracking-github-1', { force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1);
  gate.resolve();
  assert.deepEqual(await second, await first);
});
