const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { ModpackStateRepository } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');

function verification(mismatches) {
  return {
    type: 'modpack-verification-result', contentRevision: 3, checkedFiles: '4596',
    mismatchCount: String(mismatches.length), healthy: mismatches.length === 0,
    repairAvailable: mismatches.length > 0,
    repair: mismatches.length ? { operationKind: 'repair', mismatchCount: String(mismatches.length) } : null,
    mismatches, verifiedAt: '2026-10-09T00:00:00.000Z'
  };
}

function difference(entryName) {
  return { entryName, origin: 'pack', role: 'configuration', status: 'modified' };
}

async function fixture(t, { result, actions, repository } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-verify-summary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  let tempId = 0;
  const durableFs = createDurableFs({
    fsApi: fs, asyncFsApi: fs.promises, allowedRoots: [root],
    tempNameFactory: () => `verify-${++tempId}`,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      flushDirectory() {},
      async moveWriteThroughAsync(source, destination) { await fs.promises.rename(source, destination); },
      async replaceFileWriteThroughAsync(source, destination) { await fs.promises.rename(source, destination); },
      async flushDirectoryAsync() {}
    }
  });
  const dependencies = { userDataPath: path.join(root, 'user-data'), fsApi: fs, durableFs };
  fs.mkdirSync(dependencies.userDataPath);
  const store = new OperationStore(dependencies);
  await store.initialize();
  const unused = () => { throw new Error('Verify invoked an unrelated workflow'); };
  const stateRepository = repository ? repository({ serverPath, durableFs }) : {
    async verifyManagedFiles(receivedPath) {
      assert.equal(receivedPath, serverPath);
      return result;
    }
  };
  const service = new ModpackLifecycleService({
    sourceResolver: { resolveArtifactSetPlan: unused }, artifactDownloader: { downloadSet: unused },
    archiveInspector: { inspectArchive: unused }, inspectionLoader: { loadInspection: unused },
    planningAdapter: { createPlan: unused }, planRegistry: { create: unused, get: unused, claim: unused },
    operationStore: store, stateRepository,
    instanceResolver: { resolveInstance: instanceId => ({ instanceId, serverPath, priorRunning: false }) },
    ...(actions ? { outcomeActionIssuer: { issue: async () => actions } } : {})
  });
  return { service, store, dependencies, serverPath, stateRepository };
}

async function terminal(store, jobId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const job = await store.get(jobId);
    if (['completed', 'failed', 'cancelled'].includes(job?.phase)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Verify did not settle');
}

function assertSummary(job, total) {
  assert.equal(job.phase, 'completed', JSON.stringify(job.outcome));
  const result = job.outcome.result;
  assert.equal(result.mismatchCount, String(total));
  assert.equal(result.healthy, false);
  assert.equal(result.repairAvailable, true);
  assert.deepEqual(result.repair, { operationKind: 'repair', mismatchCount: String(total) });
  assert.ok(result.mismatches.length <= 64);
  assert.equal(result.shownMismatchCount, String(result.mismatches.length));
  assert.equal(result.omittedMismatchCount, String(total - result.mismatches.length));
  assert.equal(result.mismatchesTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(job.outcome)) <= 12 * 1024);
  return result;
}

test('large Verify persists exact unhealthy totals through the real store and durable reload', async t => {
  // Catches the full repository list being serialized directly into the capped outcome.
  const full = verification(Array.from({ length: 148 }, (_, index) =>
    difference(`config/${index}-${'setting'.repeat(10)}.json`)));
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 16 * 1024);
  const context = await fixture(t, { result: full });
  const queued = await context.service.verify('server-one');
  const job = await terminal(context.store, queued.jobId);
  const result = assertSummary(job, 148);
  assert.equal(result.checkedFiles, '4596');
  assert.equal(full.mismatches.length, 148);
  const restarted = new OperationStore(context.dependencies);
  await restarted.initialize();
  assert.deepEqual((await restarted.get(queued.jobId)).outcome, job.outcome);
});

test('real repository verification with over 256 mismatches remains read-only and completed', async t => {
  // Catches array-cap failures and any projection that changes the repository scan or stored state.
  const context = await fixture(t, { repository({ serverPath, durableFs }) {
    fs.mkdirSync(path.join(serverPath, 'config'));
    const repository = new ModpackStateRepository({ fsApi: fs, durableFs });
    repository.writeCandidate(serverPath, {
      schemaVersion: 1, modpackManaged: true,
      source: { provider: 'local', importId: 'import-verify', artifactSha256: 'b'.repeat(64), version: 'local-import', title: 'Verify fixture' },
      runtime: { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64' },
      selectedOptionalFiles: [], installedAt: '2026-10-09T00:00:00.000Z', contentRevision: 3,
      manifest: { schemaVersion: 1, installationId: 'installation-verify', entries: Array.from({ length: 300 }, (_, index) => {
        const name = `config/${String(index).padStart(3, '0')}-${'設定'.repeat(20)}.json`;
        return { path: name, pathKey: name, origin: 'pack', managementPolicy: 'replaceable-managed', role: 'configuration', installedHash: 'a'.repeat(64), size: '1', priorBaseline: null };
      }) }
    });
    return repository;
  } });
  const before = context.stateRepository.read(context.serverPath);
  const full = await context.stateRepository.verifyManagedFiles(context.serverPath);
  assert.equal(full.mismatches.length, 300);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 16 * 1024);
  const queued = await context.service.verify('server-one');
  const result = assertSummary(await terminal(context.store, queued.jobId), 300);
  assert.equal(result.checkedFiles, '300');
  assert.deepEqual(context.stateRepository.read(context.serverPath), before);
  assert.deepEqual(context.stateRepository.listHistory(context.serverPath).items, []);
  assert.deepEqual(fs.readdirSync(path.join(context.serverPath, 'config')), []);
});

test('Verify bounds multibyte names and the final action-bearing envelope without shortened path identities', async t => {
  // Catches count-only budgets, unbounded labels, private field forwarding, and envelope overflow.
  const full = verification([
    difference(`config/${'界'.repeat(1100)}.json`),
    ...Array.from({ length: 10000 - 1 }, (_, index) => difference(`config/${index}-${'界'.repeat(290)}.json`))
  ]);
  full.serverPath = 'C:\\private\\server';
  full.secret = 'private-result-secret';
  full.mismatches[1].secret = 'private-item-secret';
  const actions = Array.from({ length: 16 }, (_, index) => ({
    actionId: `action-${index}-${'a'.repeat(110)}`, opaqueRef: `ref-${index}-${'b'.repeat(110)}`
  }));
  const context = await fixture(t, { result: full, actions });
  const queued = await context.service.verify('server-one');
  const job = await terminal(context.store, queued.jobId);
  const result = assertSummary(job, 10000);
  assert.ok(result.mismatches.length > 0 && result.mismatches.length < 64);
  assert.deepEqual(job.outcome.actions, actions);
  assert.ok(result.mismatches.every(item => full.mismatches.some(original => item.entryName === original.entryName)));
  assert.ok(result.mismatches.every(item => item.entryName.length <= 1024));
  assert.doesNotMatch(JSON.stringify(job), /private-result-secret|private-item-secret|C:\\\\private/u);
});

test('all-oversized mismatch labels still preserve an unhealthy completed result with zero shown', async t => {
  const context = await fixture(t, { result: verification([difference(`config/${'x'.repeat(1100)}.json`)]) });
  const queued = await context.service.verify('server-one');
  const result = assertSummary(await terminal(context.store, queued.jobId), 1);
  assert.deepEqual(result.mismatches, []);
});

test('unsafe absolute and secret-bearing labels are omitted without leaking identifiers', async t => {
  const context = await fixture(t, { result: verification([
    difference('C:\\private\\server\\config.json'), difference('/private/server/config.json'),
    difference('../private/config.json'), difference('config/token=do-not-expose.json'),
    difference('config/ordinary.json')
  ]) });
  const queued = await context.service.verify('server-one');
  const job = await terminal(context.store, queued.jobId);
  const result = assertSummary(job, 5);
  assert.deepEqual(result.mismatches, [difference('config/ordinary.json')]);
  assert.doesNotMatch(JSON.stringify(job), /private|do-not-expose/u);
});

test('small and healthy Verify results retain their existing complete shape', async t => {
  for (const full of [verification([]), verification([difference('mods/managed.jar')])]) {
    const context = await fixture(t, { result: full });
    const queued = await context.service.verify('server-one');
    const job = await terminal(context.store, queued.jobId);
    assert.equal(job.phase, 'completed');
    assert.deepEqual(job.outcome.result, { instanceId: 'server-one', ...full });
  }
});

test('bounded Verify projection retains generic store rejection and redaction', async t => {
  const context = await fixture(t, { result: verification([difference('config/token=do-not-expose.json')]) });
  const queued = await context.service.verify('server-one');
  const job = await terminal(context.store, queued.jobId);
  assert.equal(job.phase, 'completed');
  assert.doesNotMatch(JSON.stringify(job), /do-not-expose/u);
  for (const payload of [{ values: Array(257).fill('x') }, { values: Array(100).fill('x'.repeat(200)) }]) {
    const created = await context.store.create({ operationKind: 'verify', serverId: 'server-one', planFingerprint: null });
    await context.store.transition(created.jobId, { expectedPhase: 'queued', nextPhase: 'verifying', patch: {} });
    await assert.rejects(context.store.transition(created.jobId, {
      expectedPhase: 'verifying', nextPhase: 'completed', patch: { outcome: { status: 'completed', ...payload } }
    }), error => error.code === 'INVALID_REQUEST');
    assert.equal((await context.store.get(created.jobId)).phase, 'verifying');
  }
});

test('failed repository verification never fabricates a completed sample', async t => {
  const context = await fixture(t, { repository: () => ({
    async verifyManagedFiles() { throw new ModpackError('PLAN_STALE', 'Managed files changed'); }
  }) });
  const queued = await context.service.verify('server-one');
  const job = await terminal(context.store, queued.jobId);
  assert.equal(job.phase, 'failed');
  assert.equal(job.outcome.errorCode, 'PLAN_STALE');
  assert.equal(job.outcome.result, undefined);
});

test('cancellation during a large repository scan never publishes a completed sample', async t => {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let finish;
  const scanning = new Promise(resolve => { finish = resolve; });
  let signal;
  const context = await fixture(t, { repository: () => ({
    async verifyManagedFiles(_serverPath, options) {
      signal = options.signal;
      enter();
      await scanning;
      return verification(Array.from({ length: 300 }, (_, index) => difference(`config/${index}.json`)));
    }
  }) });
  const queued = await context.service.verify('server-one');
  await entered;
  const cancelling = await context.service.cancelJob(queued.jobId);
  assert.equal(cancelling.phase, 'cancelling');
  assert.equal(signal.aborted, true);
  finish();
  const job = await terminal(context.store, queued.jobId);
  assert.equal(job.phase, 'cancelled');
  assert.equal(job.outcome.result, undefined);
  const restarted = new OperationStore(context.dependencies);
  await restarted.initialize();
  assert.equal((await restarted.get(queued.jobId)).phase, 'cancelled');
});
