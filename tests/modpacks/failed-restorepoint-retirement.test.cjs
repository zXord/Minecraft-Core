const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { prepareExactDeleteRequest } = require('../../electron/utils/windows-durable-fs-client.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { RestorePointService } = require('../../electron/services/modpack-lifecycle/restore-point-service.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { PlanRegistry } = require('../../electron/services/modpack-lifecycle/plan-registry.cjs');
const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { ModpackStateRepository } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');
const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');
const { FailedRestorePointRetirement } = require('../../electron/services/modpack-lifecycle/failed-restorepoint-retirement.cjs');

const AT = '2026-10-11T00:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
function historyEntry(overrides = {}) { return { schemaVersion: 1, operationId: 'other', sequence: 1, kind: 'repair', outcome: 'completed',
  timestamp: AT, sourceRevision: 7, targetRevision: 8, ...overrides }; }
function durable(root) {
  return createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    async moveWriteThroughAsync(a, b) { fs.renameSync(a, b); },
    async replaceFileWriteThroughAsync(a, b) { fs.renameSync(a, b); }, async flushDirectoryAsync() {}
  } });
}
async function fixture(t, options = {}) {
  const jobId = options.jobId || 'job-failed';
  const instanceId = options.instanceId || 'server-one';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-retirement-task3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server'); fs.mkdirSync(serverPath);
  fs.writeFileSync(path.join(serverPath, 'server.jar'), 'synthetic-world');
  const events = []; const sourceDurable = durable(root);
  const service = new RestorePointService({ durableFs: sourceDurable, clock: () => new Date(AT),
    randomUUID: () => crypto.randomUUID(), extractVerifiedArchiveFn: async () => assert.fail('extract'),
    retirementDurableFsFor(parent) {
      assert.equal(parent.toLowerCase(), root.toLowerCase());
      return { async deleteFileExactAsync(file, request) {
        prepareExactDeleteRequest(file, request, [parent]);
        const which = file.endsWith('.zip') ? 'archive' : 'sidecar';
        events.push(`${which}:${request.mode}`);
        await options.beforeEffect?.(which, file, request);
        if (request.mode === 'delete') fs.unlinkSync(file);
        await options.afterEffect?.(which, file, request);
        events.push(`${which}:flush-close`);
        return { deleted: true, durable: true };
      } };
    }
  });
  const point = await service.createVerifiedRestorePoint({ serverPath, operationId: jobId, sourceRevision: 7, sourceRuntime: null });
  const candidate = { schemaVersion: 1, ...Object.fromEntries(['id', 'name', 'sha256', 'size', 'totalBytes', 'scopeSha256',
    'sourceRevision', 'sourceRuntime', 'operationId', 'createdAt'].map(key => [key, point[key]])), metadataName: path.basename(point.metadataPath) };
  const userDataPath = path.join(root, 'registry'); fs.mkdirSync(userDataPath);
  const registry = new RecoveryRegistry({ userDataPath, durableFs: durable(userDataPath), clock: () => new Date(AT) });
  await registry.initialize();
  const original = { volumeSerial: '1', fileId: '2' };
  const initial = { schemaVersion: 2, sequence: 0, jobId, operationKind: 'repair',
    target: { kind: 'existing', stableServerId: instanceId, path: serverPath }, candidatePath: null, rollbackPath: null,
    failedPath: null, restorePoint: { id: point.id, sha256: point.sha256 }, restoreCreation: null, journalPath: null,
    priorRuntime: { running: false, autoRestart: true }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: original, rollback: original, candidate: null, failed: null },
    createdAt: AT, updatedAt: AT, outcome: null };
  await registry.create(initial);
  await registry.transition(jobId, { expectedPhase: 'queued', nextPhase: 'preflight', patch: { outcome: { runtimeWriterProtocol: 1 } } });
  await registry.transition(jobId, { expectedPhase: 'preflight', nextPhase: 'snapshotting', patch: {
    outcome: { failedPointRetirementCandidate: candidate }
  } });
  await registry.finish(jobId, { terminalPhase: 'failed', outcome: {
    recovery: { action: 'pre-swap-restored', operationId: jobId }
  } });
  const evidence = await registry.loadPublishedTerminalEvidence(jobId, { expectedTarget: initial.target, expectedOperationKind: 'repair' });
  const selector = { instanceId, serverPath: evidence.record.target.path };
  const binding = { expectedTarget: evidence.record.target, expectedOperationKind: 'repair' };
  const proof = Object.freeze({});
  let revision = 7;
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => revision,
    bumpContentRevision: () => ++revision }); coordinator.completeStartupRecovery([]);
  const history = [];
  const stateRepository = { listHistory(_serverPath, { cursor, limit }) {
    assert.equal(limit, 200); events.push('references');
    return options.history?.(cursor) || { items: history, nextCursor: null };
  } };
  const write = registry.writeRestorePointRetirement.bind(registry);
  registry.writeRestorePointRetirement = async (id, request) => {
    await options.beforeReceipt?.(request.value);
    const result = await write(id, request); events.push(`receipt:${result.value.progress}:${result.value.durability.sidecar}`);
    await options.afterReceipt?.(result.value); return result;
  };
  const deps = { registry, coordinator, stateRepository, planRegistry: { hasRestorePointReference: () => false },
    restorePointServiceFor: () => service, verifyLiveProof: value => value === proof,
    assertTargetAvailable: async () => options.available?.(), clock: () => new Date(options.clock || AT), randomUUID: crypto.randomUUID };
  const helper = new FailedRestorePointRetirement(deps);
  async function live(custom = {}) {
    return coordinator.runMutation(selector, { operation: 'repair', operationId: jobId, revisionMode: 'auto' },
      lease => { events.push('lease'); return helper.retireLive({ jobId, selector, binding, lease,
        finalPolicyProof: proof, ...custom }); });
  }
  return { root, serverPath, service, point, candidate, registry, selector, binding, proof, coordinator, helper,
    live, events, history, deps, get revision() { return revision; }, evidence };
}

test('exact pair is durably retired archive first with unchanged pin bytes and immutable history', async t => {
  let sidecarBytes; let environment;
  environment = await fixture(t, { beforeEffect(which) {
    assert.deepEqual(fs.readFileSync(environment.point.metadataPath), sidecarBytes);
    assert.equal(JSON.parse(sidecarBytes).pins.includes('job-failed'), true);
  } });
  sidecarBytes = fs.readFileSync(environment.point.metadataPath);
  const historical = fs.readFileSync(path.join(environment.registry.historyPath, 'job-failed.json'));
  const result = await environment.live();
  assert.equal(result.status, 'reclaimed'); assert.equal(result.progress, 'deleted');
  assert.equal(result.archiveBytesReclaimed, String(environment.candidate.size));
  assert.equal(fs.existsSync(environment.point.archivePath), false); assert.equal(fs.existsSync(environment.point.metadataPath), false);
  assert.deepEqual(fs.readFileSync(path.join(environment.registry.historyPath, 'job-failed.json')), historical);
  const order = environment.events.filter(event => event.startsWith('receipt:') || event.includes('delete') || event.includes('flush-close'));
  assert.deepEqual(order, ['receipt:authorized:not-started', 'receipt:authorized:not-started', 'receipt:deleting:not-started',
    'archive:delete', 'archive:flush-close', 'receipt:archive-deleted:not-started', 'receipt:archive-deleted:intent',
    'sidecar:delete', 'sidecar:flush-close', 'receipt:deleted:durable']);
  assert.equal(environment.revision, 8);
});

test('missing live final-policy capability never creates a receipt or reads source', async t => {
  const e = await fixture(t); const result = await e.live({ finalPolicyProof: {} });
  assert.equal(result.reason, 'missing-final-policy-proof'); assert.equal(await e.registry.loadRestorePointRetirement('job-failed'), null);
  assert.equal(fs.existsSync(e.point.archivePath), true); assert.equal(e.events.includes('references'), false);
});

test('running original may acquire durable authorization but no source mutation', async t => {
  const e = await fixture(t, { available() { throw Object.assign(new Error('running'), { code: 'SERVER_RUNNING' }); } });
  const result = await e.live(); assert.equal(result.reason, 'target-running'); assert.equal(result.progress, 'authorized');
  assert.equal((await e.registry.loadRestorePointRetirement('job-failed')).value.diagnostic.reason, 'target-running');
  assert.equal(fs.existsSync(e.point.archivePath), true); assert.equal(e.revision, 7);
});

for (const [name, history, reason] of [
  ['history page two owns point', (e, cursor) => cursor === null ? { items: [], nextCursor: 'page2' } :
    { items: [historyEntry({ operationId: 'older', restorePointId: e.point.id, restorePointSha256: e.point.sha256 })], nextCursor: null }, 'independent-owner'],
  ['history proof cap is not absence', (_e, cursor) => ({ items: Array.from({ length: 200 }, () => historyEntry()), nextCursor: `${Number(cursor || 0) + 1}` }), 'reference-proof-incomplete'],
  ['repeated cursor defers', () => ({ items: [], nextCursor: 'same' }), 'reference-proof-incomplete'],
  ['same ID conflicting digest defers', e => ({ items: [historyEntry({ restorePointId: e.point.id, restorePointSha256: '0'.repeat(64) })], nextCursor: null }), 'reference-proof-incomplete'],
  ['partial ID hash defers', e => ({ items: [historyEntry({ restorePointId: e.point.id })], nextCursor: null }), 'reference-proof-incomplete'],
  ['same path different ID defers', e => ({ items: [historyEntry({ restorePointId: 'other', restorePointSha256: e.point.sha256, archivePath: e.point.archivePath })], nextCursor: null }), 'reference-proof-incomplete'],
  ['unsafe unrelated locator defers', e => ({ items: [historyEntry({ restorePointId: 'other', restorePointSha256: e.point.sha256, name: '../unsafe.zip' })], nextCursor: null }), 'reference-proof-incomplete']
]) test(name, async t => {
  let e; e = await fixture(t, { history: cursor => history(e, cursor) });
  const result = await e.live(); assert.equal(result.reason, reason); assert.equal(fs.existsSync(e.point.archivePath), true);
  assert.equal(e.events.some(event => event.startsWith('archive:')), false);
});

for (const outcome of ['completed', 'failed']) test(`real same-job ${outcome} local history independently protects the pair`, async t => {
  const e = await fixture(t);
  const repository = new ModpackStateRepository({ durableFs: durable(e.root) });
  await repository.appendHistoryAsync(e.serverPath, historyEntry({ operationId: 'job-failed', outcome,
    restorePointId: e.point.id, restorePointSha256: e.point.sha256 }));
  e.helper.stateRepository = repository;
  const bytes = fs.readFileSync(e.point.archivePath); const pins = fs.readFileSync(e.point.metadataPath);
  const result = await e.live(); assert.equal(result.reason, 'independent-owner');
  assert.deepEqual(fs.readFileSync(e.point.archivePath), bytes); assert.deepEqual(fs.readFileSync(e.point.metadataPath), pins);
  assert.equal(await e.registry.loadRestorePointRetirement('job-failed'), null);
  assert.equal(e.events.some(event => event.startsWith('archive:')), false);
});

test('separate same-byte archive does not retain failed duplicate', async t => {
  const e = await fixture(t);
  const olderPath = path.join(path.dirname(e.point.archivePath), 'restore-point-older.zip');
  fs.copyFileSync(e.point.archivePath, olderPath);
  const olderSidecar = olderPath.replace(/\.zip$/, '.json');
  const old = { ...JSON.parse(fs.readFileSync(e.point.metadataPath)), id: 'restore-older', name: path.basename(olderPath), operationId: 'older-job', pins: ['older-job'] };
  fs.writeFileSync(olderSidecar, JSON.stringify(old));
  const oldBytes = fs.readFileSync(olderPath); const oldMeta = fs.readFileSync(olderSidecar); const oldIno = fs.statSync(olderPath).ino;
  e.history.push(historyEntry({ outcome: 'completed', operationId: 'older-job', restorePointId: old.id, restorePointSha256: old.sha256 }));
  const workspaceRoot = path.join(e.root, 'plans'); fs.mkdirSync(workspaceRoot);
  const workspaceRegistry = new ArtifactWorkspaceRegistry({ root: workspaceRoot });
  const plans = new PlanRegistry({ workspaceRegistry });
  const planningSessionId = workspaceRegistry.createPlanningSession(); workspaceRegistry.createStagingOutput({ ownerId: planningSessionId });
  const plan = { type: 'modpack-preflight-plan', schemaVersion: 1, operation: { kind: 'rollback', instanceId: e.selector.instanceId, expectedContentRevision: 7 },
    restorePoints: [{ id: old.id, sha256: old.sha256, name: old.name }], workspace: {}, source: {} };
  plan.fingerprint = computePreflightPlanFingerprint(plan);
  const reviewed = plans.create({ plan, fingerprint: plan.fingerprint, planningSessionId, sanitizedView: { title: 'Synthetic rollback' } });
  await plans.claim({ planId: reviewed.planId, fingerprint: reviewed.fingerprint });
  e.deps.planRegistry.hasRestorePointReference = request => plans.hasRestorePointReference(request);
  assert.equal((await e.live()).status, 'reclaimed');
  assert.deepEqual(fs.readFileSync(olderPath), oldBytes); assert.deepEqual(fs.readFileSync(olderSidecar), oldMeta);
  assert.equal(fs.statSync(olderPath).ino, oldIno);
  assert.equal((await e.service.resolveRestorePoint({ serverPath: e.serverPath, id: old.id, sha256: old.sha256 })).id, old.id);
});

test('independent physical pin added before sidecar effect preserves pinned sidecar', async t => {
  let e; e = await fixture(t, { afterReceipt(value) {
    if (value.progress === 'archive-deleted' && value.durability.sidecar === 'intent') {
      const metadata = JSON.parse(fs.readFileSync(e.point.metadataPath)); metadata.pins.push('another-owner');
      fs.writeFileSync(e.point.metadataPath, JSON.stringify(metadata));
    }
  } });
  const result = await e.live(); assert.equal(result.status, 'deferred'); assert.equal(result.reason, 'independent-owner');
  assert.equal(result.progress, 'archive-deleted'); assert.equal(result.archiveBytesReclaimed, String(e.candidate.size));
  assert.equal(fs.existsSync(e.point.metadataPath), true);
});

test('sidecar substitution during final reference proof preserves the archive', async t => {
  let e; let deleting = false; let checks = 0;
  e = await fixture(t, { afterReceipt(value) { if (value.progress === 'deleting') deleting = true; }, history() {
    if (deleting && ++checks === 2) {
      const metadata = JSON.parse(fs.readFileSync(e.point.metadataPath)); metadata.id = 'substitute-point';
      fs.writeFileSync(e.point.metadataPath, JSON.stringify(metadata));
    }
    return { items: [], nextCursor: null };
  } });
  const result = await e.live(); assert.equal(result.status, 'deferred'); assert.equal(result.progress, 'deleting');
  assert.equal(result.reason, 'identity-mismatch'); assert.equal(fs.existsSync(e.point.archivePath), true);
  assert.equal(fs.existsSync(e.point.metadataPath), true);
});

test('unintended sidecar absence during final reference proof preserves the archive', async t => {
  let e; let deleting = false; let checks = 0;
  e = await fixture(t, { afterReceipt(value) { if (value.progress === 'deleting') deleting = true; }, history() {
    if (deleting && ++checks === 2) fs.unlinkSync(e.point.metadataPath);
    return { items: [], nextCursor: null };
  } });
  const result = await e.live(); assert.equal(result.progress, 'deleting'); assert.equal(result.reason, 'identity-mismatch');
  assert.equal(fs.existsSync(e.point.archivePath), true);
});

for (const file of ['archive', 'sidecar']) test(`${file} absence observed before its intent cannot be reconciled as our effect`, async t => {
  let e; let once = false;
  e = await fixture(t, { afterReceipt(value) {
    if (!once && ((file === 'archive' && value.progress === 'authorized') || (file === 'sidecar' && value.progress === 'archive-deleted' && value.durability.sidecar === 'not-started'))) {
      once = true; fs.unlinkSync(file === 'archive' ? e.point.archivePath : e.point.metadataPath);
    }
  } });
  const result = await e.live(); assert.equal(result.status, 'deferred'); assert.equal(result.reason, 'identity-mismatch');
  const stored = (await e.registry.loadRestorePointRetirement('job-failed')).value;
  assert.equal(stored.durability[file], 'not-started');
  assert.equal(e.events.includes(`${file}:reconcile-absent`), false);
});

for (const stage of ['archive', 'sidecar']) test(`lost ${stage} native result reconciles only durable intent on retry`, async t => {
  let failed = false;
  const e = await fixture(t, { afterEffect(which) { if (which === stage && !failed) { failed = true; throw new Error('lost response after close'); } } });
  const first = await e.live(); assert.equal(first.status, 'deferred');
  const resumed = await new FailedRestorePointRetirement(e.deps).retryPass({ trigger: 'startup', selector: null });
  assert.equal(resumed.results[0].status, 'reclaimed');
  assert.ok(e.events.includes(`${stage}:reconcile-absent`));
});

test('archive absent without durable intent is not success', async t => {
  const e = await fixture(t); fs.unlinkSync(e.point.archivePath);
  const result = await e.live(); assert.equal(result.status, 'deferred'); assert.equal(result.archiveBytesReclaimed, '0');
  assert.equal(await e.registry.loadRestorePointRetirement('job-failed'), null); assert.equal(fs.existsSync(e.point.metadataPath), true);
});

test('replacement archive with identical bytes survives retry', async t => {
  let e; e = await fixture(t, { afterReceipt(value) {
    if (value.progress === 'deleting') {
      const data = fs.readFileSync(e.point.archivePath); fs.renameSync(e.point.archivePath, `${e.point.archivePath}.saved`);
      fs.writeFileSync(e.point.archivePath, data);
    }
  } });
  const result = await e.live(); assert.equal(result.reason, 'identity-mismatch'); assert.equal(fs.existsSync(e.point.archivePath), true);
  assert.equal(fs.existsSync(e.point.metadataPath), true); assert.equal(result.archiveBytesReclaimed, '0');
});

test('receipt CAS conflict stops the next effect and retains both leaves', async t => {
  const e = await fixture(t, { beforeReceipt(value) { if (value.progress === 'deleting') throw Object.assign(new Error('CAS'), { code: 'PLAN_STALE' }); } });
  const result = await e.live(); assert.equal(result.reason, 'receipt-conflict'); assert.equal(e.events.includes('archive:delete'), false);
  assert.equal(fs.existsSync(e.point.metadataPath), true); assert.equal(fs.existsSync(e.point.archivePath), true);
});

test('actual concurrent receipt CAS is reloaded once and never authorizes the next effect', async t => {
  let e; let once = false;
  e = await fixture(t, { async beforeReceipt(value) {
    if (value.progress === 'deleting' && !once) {
      once = true; const current = await e.registry.loadRestorePointRetirement('job-failed');
      await e.registry.writeRestorePointRetirement('job-failed', { expectedSha256: current.sha256, value: {
        ...current.value, sequence: current.value.sequence + 1, diagnostic: { reason: 'io-failure', at: current.value.updatedAt }
      } });
    }
  } });
  const result = await e.live(); assert.equal(result.reason, 'receipt-conflict'); assert.equal(result.progress, 'authorized');
  assert.equal(fs.existsSync(e.point.archivePath), true); assert.equal(e.events.some(event => event.startsWith('archive:')), false);
});

test('wrong, nonambient and expired lease cannot authorize exact pair work', async t => {
  const e = await fixture(t); let expired;
  await e.coordinator.runMutation(e.selector, { operation: 'x', operationId: 'wrong', revisionMode: 'none' }, async lease => { expired = lease;
    await assert.rejects(e.helper.retireLive({ jobId: 'job-failed', selector: e.selector, binding: e.binding, lease, finalPolicyProof: e.proof }), { code: 'INVALID_REQUEST' });
  });
  await assert.rejects(e.helper.retireLive({ jobId: 'job-failed', selector: e.selector, binding: e.binding, lease: expired, finalPolicyProof: e.proof }), { code: 'INVALID_REQUEST' });
  assert.equal(await e.registry.loadRestorePointRetirement('job-failed'), null);
  let currentLease; let release; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const held = e.coordinator.runMutation(e.selector, { operation: 'repair', operationId: 'job-failed', revisionMode: 'none' },
    async lease => { currentLease = lease; entered(); await gate; });
  await started;
  await assert.rejects(e.helper.retireLive({ jobId: 'job-failed', selector: e.selector, binding: e.binding, lease: currentLease, finalPolicyProof: e.proof }), { code: 'INVALID_REQUEST' });
  release(); await held;
});

test('close drains dispatched work and synchronously refuses new work', async t => {
  let release; let entered; const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const e = await fixture(t, { async afterEffect(which) { if (which === 'archive') { entered(); await gate; } } });
  const active = e.live(); await started; let closed = false; const closing = e.helper.close().then(() => { closed = true; });
  await assert.rejects(e.helper.retryPass({ trigger: 'startup', selector: null }), { code: 'INVALID_REQUEST' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); release();
  assert.equal((await active).status, 'reclaimed'); await closing; assert.equal(closed, true);
});

test('malformed no-reference history entry does not prove absence', async t => {
  const e = await fixture(t, { history: () => ({ items: [{ unrelated: true }], nextCursor: null }) });
  const result = await e.live(); assert.equal(result.reason, 'reference-proof-incomplete');
  assert.equal(fs.existsSync(e.point.archivePath), true);
});

test('session cannot replace its captured authorization identities or survive callback return', async t => {
  let running = true;
  const e = await fixture(t, { available() { if (running) throw Object.assign(new Error('running'), { code: 'SERVER_RUNNING' }); } });
  await e.live(); running = false; let session;
  const loaded = await e.registry.loadRestorePointRetirement('job-failed');
  await e.coordinator.runMutation(e.selector, { operation: 'retirement', operationId: 'maintenance', revisionMode: 'none' }, async lease => {
    await e.service.withExactRetirementPoint(e.candidate, {
      authority: { lease, operationId: 'maintenance', selector: e.selector, coordinator: e.coordinator }, receipt: loaded.value, recheckReferences: async () => {}
    }, async value => {
      session = value;
      const replaced = clone(loaded.value); replaced.progress = 'deleting'; replaced.durability.archive = 'intent';
      const bytes = fs.readFileSync(e.point.archivePath); fs.renameSync(e.point.archivePath, `${e.point.archivePath}.saved`);
      fs.writeFileSync(e.point.archivePath, bytes); const replacement = fs.lstatSync(e.point.archivePath, { bigint: true });
      replaced.files.archive = { fileType: 'file', dev: String(replacement.dev), ino: String(replacement.ino), size: String(replacement.size),
        birthtime: String(replacement.birthtimeNs), mtime: String(replacement.mtimeNs), ctime: String(replacement.ctimeNs), sha256: e.candidate.sha256 };
      await assert.rejects(value.deleteArchive(replaced), error => error.retirementReason === 'invalid-evidence');
    });
  });
  await assert.rejects(session.captureAuthorization());
  assert.equal(fs.existsSync(e.point.archivePath), true);
});

for (const [name, patch] of [
  ['completed', r => { r.phase = 'completed'; }], ['rolled-back', r => { r.phase = 'rolled-back'; }],
  ['new target', r => { r.target.kind = 'new'; }], ['prepared swap', r => { r.swapStep = 'prepared'; }],
  ['between renames restoration', r => { r.outcome.recovery.action = 'between-renames-restored'; }],
  ['commit begun', r => { r.outcome.commitStarted = true; }], ['canonical publication', r => { r.outcome.publication = { state: 'published' }; }],
  ['failed sibling identity', r => { r.directoryIdentities.failed = { volumeSerial: '1', fileId: '3' }; }],
  ['different rollback identity', r => { r.directoryIdentities.rollback.fileId = '3'; }],
  ['unproven writer', r => { r.outcome.runtimeWriterAuthority = { state: 'unproven' }; }],
  ['creation outstanding', r => { r.restoreCreation = { state: 'writing' }; }],
  ['missing point marker only', r => { r.restorePoint = null; }]
]) test(`eligibility excludes ${name} without filesystem discovery`, async t => {
  const e = await fixture(t); const proof = clone(e.evidence); patch(proof.record);
  e.registry.loadPublishedTerminalEvidence = async () => proof;
  e.deps.restorePointServiceFor = () => assert.fail('excluded source opened');
  const helper = new FailedRestorePointRetirement(e.deps);
  const result = await e.coordinator.runMutation(e.selector, { operation: 'repair', operationId: 'job-failed', revisionMode: 'none' },
    lease => helper.retireLive({ jobId: 'job-failed', selector: e.selector, binding: e.binding, lease, finalPolicyProof: e.proof }));
  assert.equal(result.status, 'not-eligible'); assert.equal(e.events.includes('references'), false);
  assert.equal(fs.existsSync(e.point.archivePath), true);
});

for (const when of ['beforeReceipt', 'afterReceipt']) for (const boundary of ['authorized:not-started', 'deleting:not-started',
  'archive-deleted:not-started', 'archive-deleted:intent', 'deleted:durable']) {
  test(`crash at ${when} ${boundary} preserves a durable retry obligation`, async t => {
    let injected = false;
    const e = await fixture(t, { [when](receipt) {
      if (!injected && `${receipt.progress}:${receipt.durability.sidecar}` === boundary) { injected = true; throw new Error('injected crash boundary'); }
    } });
    const first = await e.live(); assert.equal(first.status, 'deferred');
    const reloaded = new RecoveryRegistry({ userDataPath: e.registry.userDataPath, durableFs: durable(e.registry.userDataPath), clock: () => new Date('2020-01-01T00:00:00.000Z') });
    await reloaded.initialize();
    const pending = reloaded.listRestorePointRetirementItems({ selector: null }); assert.equal(pending.length, 1);
    const pass = await new FailedRestorePointRetirement({ ...e.deps, registry: reloaded }).retryPass({ trigger: 'startup', selector: null });
    if (when === 'beforeReceipt' && boundary === 'authorized:not-started') {
      assert.equal(pass.results[0].reason, 'missing-final-policy-proof'); assert.equal(fs.existsSync(e.point.archivePath), true);
    } else { assert.equal(pass.results[0].status, 'reclaimed'); assert.equal(fs.existsSync(e.point.metadataPath), false); }
  });
}

test('hardlinked candidate is retained and exact pending counterpart is never recovered', async t => {
  const hardlink = await fixture(t); fs.linkSync(hardlink.point.archivePath, path.join(hardlink.root, 'protected-link.zip'));
  assert.equal((await hardlink.live()).reason, 'identity-mismatch'); assert.equal(fs.existsSync(hardlink.point.metadataPath), true);
  const pending = await fixture(t); const leaf = pending.point.archivePath.replace(/\.zip$/, '.pending.json');
  fs.copyFileSync(pending.point.metadataPath, leaf); const original = fs.readFileSync(leaf);
  assert.equal((await pending.live()).reason, 'invalid-evidence'); assert.deepEqual(fs.readFileSync(leaf), original);
  assert.equal(fs.existsSync(pending.point.archivePath), true);
});

for (const [name, trigger] of [
  ['__proto__', '__proto__'], ['constructor', 'constructor'], ['toString', 'toString'],
  ['valueOf', 'valueOf'], ['hasOwnProperty', 'hasOwnProperty'], ['unknown string', 'unknown'],
  ['empty string', ''], ['null', null], ['undefined', undefined], ['number', 0], ['boolean', true],
  ['symbol', Symbol('startup')], ['array', ['startup']], ['boxed string', new String('startup')],
  ['coercible object', { [Symbol.toPrimitive]() { assert.fail('trigger coercion must not execute'); } }]
]) test(`invalid retry trigger ${name} rejects before inventory or work`, async () => {
  const calls = [];
  const forbidden = name => () => { calls.push(name); assert.fail(`invalid trigger invoked ${name}`); };
  const helper = new FailedRestorePointRetirement({ registry: {
    loadPublishedTerminalEvidence: forbidden('evidence'), loadRestorePointRetirement: forbidden('receipt load'),
    writeRestorePointRetirement: forbidden('attempt stamp'), hasOtherActiveRestorePointReference: forbidden('registry references'),
    listRestorePointRetirementItems() { calls.push('inventory'); return Array.from({ length: 25 }, (_, i) => ({
      jobId: `notice-${i}`, selector: { instanceId: 'synthetic', serverPath: 'C:/task3-review-synthetic/server' },
      state: 'deferred-proof', createdAt: AT, lastAttemptAt: null })); }
  }, coordinator: { runMutation: forbidden('admission'), assertMutationLease: forbidden('lease') },
    planRegistry: { hasRestorePointReference: forbidden('plan references') }, stateRepository: { listHistory: forbidden('history') },
    restorePointServiceFor: forbidden('service'), verifyLiveProof: forbidden('proof'), assertTargetAvailable: forbidden('availability') });
  try {
    await assert.rejects(helper.retryPass({ trigger, selector: null }), { code: 'INVALID_REQUEST' });
    assert.deepEqual(calls, []);
  } finally { await helper.close(); }
});

test('more than 16 old reclaimed notices cannot starve a new eligible receipt', async t => {
  let running = true;
  const e = await fixture(t, { available() { if (running) throw Object.assign(new Error('running'), { code: 'SERVER_RUNNING' }); } });
  await e.live(); running = false;
  const inventory = e.registry.listRestorePointRetirementItems.bind(e.registry);
  e.registry.listRestorePointRetirementItems = request => [
    ...Array.from({ length: 40 }, (_, i) => ({ jobId: `old-${i}`, selector: e.selector, state: 'reclaimed', createdAt: '2020-01-01T00:00:00.000Z', lastAttemptAt: null })),
    ...Array.from({ length: 8 }, (_, i) => ({ jobId: `gap-${i}`, selector: e.selector, state: 'deferred-proof', createdAt: '2021-01-01T00:00:00.000Z', lastAttemptAt: null })),
    ...inventory(request)
  ];
  const load = e.registry.loadRestorePointRetirement.bind(e.registry);
  e.registry.loadRestorePointRetirement = id => id === 'job-failed' ? load(id) : null;
  const pass = await e.helper.retryPass({ trigger: 'startup', selector: null });
  assert.equal(pass.retryConsidered, 1); assert.ok(pass.noticeConsidered <= 4); assert.ok(pass.considered <= 20);
  assert.equal(pass.results.find(result => result.jobId === 'job-failed').status, 'reclaimed');
  assert.equal(pass.remaining, 44);
});

test('retry inventory cannot substitute the authenticated receipt target selector', async t => {
  let running = true;
  const e = await fixture(t, { available() { if (running) throw Object.assign(new Error('running'), { code: 'SERVER_RUNNING' }); } });
  await e.live(); running = false;
  const prior = (await e.registry.loadRestorePointRetirement('job-failed')).value;
  const inventory = e.registry.listRestorePointRetirementItems.bind(e.registry);
  e.registry.listRestorePointRetirementItems = request => inventory(request).map(item => ({ ...item,
    selector: { ...item.selector, instanceId: 'wrong-server' } }));
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 7, bumpContentRevision: () => 8 });
  coordinator.completeStartupRecovery([]);
  const pass = await new FailedRestorePointRetirement({ ...e.deps, coordinator }).retryPass({ trigger: 'startup', selector: null });
  assert.equal(pass.results[0].reason, 'invalid-evidence');
  assert.equal((await e.registry.loadRestorePointRetirement('job-failed')).value.lastAttemptAt, prior.lastAttemptAt);
  assert.equal(e.events.some(event => event.includes(':delete')), false);
  assert.equal(fs.existsSync(e.point.archivePath), true); assert.equal(fs.existsSync(e.point.metadataPath), true);
});

test('busy receipts rotate across restart with earlier clock and protected recovery bounds', async t => {
  const e = await fixture(t, { available() { throw Object.assign(new Error('running'), { code: 'SERVER_RUNNING' }); } });
  await e.live(); const seed = clone((await e.registry.loadRestorePointRetirement('job-failed')).value);
  const receipts = new Map(); const order = [];
  for (let i = 0; i < 20; i++) {
    const jobId = `job-${String(i).padStart(2, '0')}`;
    const value = { ...clone(seed), jobId, pinOwner: jobId, candidate: { ...seed.candidate, operationId: jobId }, lastAttemptAt: null };
    receipts.set(jobId, { value, sha256: crypto.createHash('sha256').update(jobId).digest('hex') });
  }
  const registry = {
    async loadPublishedTerminalEvidence() { assert.fail('busy admission must not read source proof'); },
    async hasOtherActiveRestorePointReference() { assert.fail('busy admission must not read source references'); },
    listRestorePointRetirementItems() { return [...receipts].map(([jobId, entry]) => ({ jobId, selector: e.selector,
      state: 'authorized-retry', createdAt: entry.value.createdAt, lastAttemptAt: entry.value.lastAttemptAt })); },
    async loadRestorePointRetirement(id) { return receipts.get(id); },
    async writeRestorePointRetirement(id, { expectedSha256, value }) {
      const prior = receipts.get(id); assert.equal(expectedSha256, prior.sha256);
      require('../../electron/services/modpack-lifecycle/failed-restorepoint-retirement-evidence.cjs').assertRetirementReceiptTransition(prior.value, value);
      const next = { value, sha256: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') }; receipts.set(id, next); return next;
    }
  };
  const deps = { ...e.deps, registry, clock: () => new Date('2020-01-01T00:00:00.000Z'),
    coordinator: { async runMutation(_selector, _options, work) {
      // Admission refusal is before any source callback and must still persist fairness/diagnostic metadata.
      const current = [...receipts].filter(([, v]) => !v.value.diagnostic || v.value.diagnostic.reason !== 'target-busy')
        .find(([, v]) => v.value.lastAttemptAt !== null);
      if (current) order.push(current[0]);
      throw Object.assign(new Error('busy'), { code: 'OPERATION_IN_PROGRESS' });
    }, assertMutationLease() { assert.fail('busy callback admitted'); } }
  };
  const first = await new FailedRestorePointRetirement(deps).retryPass({ trigger: 'startup', selector: null });
  assert.equal(first.retryConsidered, 16);
  for (let i = 0; i < 16; i++) { const receipt = receipts.get(`job-${String(i).padStart(2, '0')}`).value;
    assert.equal(receipt.diagnostic.reason, 'target-busy'); assert.notEqual(receipt.lastAttemptAt, null);
  }
  const second = await new FailedRestorePointRetirement(deps).retryPass({ trigger: 'recovery-completed', selector: e.selector });
  assert.equal(second.retryConsidered, 4); assert.ok(second.considered <= 6);
  assert.deepEqual(order.slice(16, 20), ['job-16', 'job-17', 'job-18', 'job-19']);
  assert.equal(e.events.some(event => event.includes(':delete')), false);
  const times = [...receipts.values()].map(entry => entry.value.lastAttemptAt); assert.equal(new Set(times).size, 20);
});

test('new independent reviewed plan before the next effect retains partial sidecar', async t => {
  let e; let owner = false;
  e = await fixture(t, { afterReceipt(value) { if (value.progress === 'archive-deleted') owner = true; } });
  e.deps.planRegistry.hasRestorePointReference = () => owner;
  const result = await e.live(); assert.equal(result.reason, 'independent-owner'); assert.equal(result.progress, 'archive-deleted');
  assert.equal(fs.existsSync(e.point.metadataPath), true); assert.equal(fs.existsSync(e.point.archivePath), false);
});

test('timestamp-write failure retains both leaves and never enters source mutation', async t => {
  let fail = false;
  const e = await fixture(t, { available() { throw Object.assign(new Error('running'), { code: 'SERVER_RUNNING' }); },
    beforeReceipt(value) { if (fail && value.lastAttemptAt !== null) throw new Error('metadata storage unavailable'); } });
  await e.live(); const before = fs.readFileSync(e.point.metadataPath); const prior = await e.registry.loadRestorePointRetirement('job-failed');
  fail = true;
  const pass = await e.helper.retryPass({ trigger: 'startup', selector: null });
  assert.equal(pass.considered, 1); assert.equal(pass.results[0].reason, 'io-failure'); assert.equal(pass.remaining, 0);
  assert.deepEqual(fs.readFileSync(e.point.metadataPath), before); assert.equal(fs.existsSync(e.point.archivePath), true);
  assert.equal((await e.registry.loadRestorePointRetirement('job-failed')).sha256, prior.sha256);
  assert.equal(e.events.some(event => event.startsWith('archive:')), false);
});

test('wrong native allowed-root scope cannot delete the exact pair', async t => {
  const e = await fixture(t); e.service.retirementDurableFsFor = parent => ({ async deleteFileExactAsync(file, options) {
    prepareExactDeleteRequest(file, options, [path.join(parent, 'server')]); assert.fail('wrong root dispatched');
  } });
  const result = await e.live(); assert.equal(result.status, 'deferred'); assert.equal(result.archiveBytesReclaimed, '0');
  assert.equal(fs.existsSync(e.point.archivePath), true); assert.equal(fs.existsSync(e.point.metadataPath), true);
});

test('retirement never uses discovery, ordinary cleanup, unpin, extraction or creation recovery', async t => {
  const e = await fixture(t);
  for (const key of ['resolveRestorePoint', 'recoverPendingRestorePoints', 'unpinRestorePoint', 'pinRestorePoint', 'listAvailableRestorePoints',
    'restoreToFreshCandidate', 'cleanupInterruptedRestorePointCreation']) e.service[key] = () => assert.fail(`forbidden ${key}`);
  assert.equal((await e.live()).status, 'reclaimed');
});

test('valid legacy local history kinds and storage identifiers do not become artificial retention gates', async t => {
  const e = await fixture(t); e.history.push(historyEntry({ kind: 'import-files-only', operationId: 'import.v1' }));
  assert.equal((await e.live()).status, 'reclaimed');
});

test('remaining counts newly known unprocessed items without automatic continuation', async t => {
  let running = true; let published = false;
  const e = await fixture(t, { available() { if (running) throw Object.assign(new Error('running'), { code: 'SERVER_RUNNING' }); },
    afterReceipt(value) { if (value.progress === 'deleted') published = true; } });
  await e.live(); running = false;
  const inventory = e.registry.listRestorePointRetirementItems.bind(e.registry);
  e.registry.listRestorePointRetirementItems = request => [...inventory(request), ...(published ? [{ jobId: 'new-notice', selector: e.selector,
    state: 'deferred-proof', createdAt: AT, lastAttemptAt: null }] : [])];
  const pass = await e.helper.retryPass({ trigger: 'startup', selector: null });
  assert.equal(pass.considered, 1); assert.equal(pass.remaining, 1);
});

test('authenticated restart rotates 16 busy receipts behind four never-attempted eligible pairs', async t => {
  const environments = new Map(); let registries = new Map();
  const held = []; let release; const barrier = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  for (let i = 0; i < 20; i++) {
    const jobId = `fair-${String(i).padStart(2, '0')}`;
    const e = await fixture(t, { jobId, instanceId: `server-${i}` }); environments.set(jobId, e); registries.set(jobId, e.registry);
    await e.coordinator.runMutation(e.selector, { operation: 'synthetic-authorization', operationId: jobId, revisionMode: 'none' }, lease =>
      e.service.withExactRetirementPoint(e.candidate, { authority: { lease, operationId: jobId, selector: e.selector, coordinator: e.coordinator },
        receipt: null, recheckReferences: async () => {} }, async session => {
        const capture = await session.captureAuthorization(); const proof = e.evidence;
        await e.registry.writeRestorePointRetirement(jobId, { expectedSha256: null, value: {
          schemaVersion: 1, policyVersion: 1, sequence: 0, jobId, operationKind: 'repair', target: proof.record.target, candidate: e.candidate,
          terminal: { recordSha256: proof.recordSha256, envelopeSha256: proof.envelopeSha256, targetPathHash: proof.envelope.targetPathHash, envelopeChecksum: proof.envelope.checksum },
          ...capture, settlement: { caller: 'live-precommit-final-policy', action: 'pre-swap-restored', swapStep: 'none', commitStarted: false, policyRestored: true },
          progress: 'authorized', durability: { archive: 'not-started', sidecar: 'not-started' }, diagnostic: null, lastAttemptAt: null, createdAt: AT, updatedAt: AT
        } });
      }));
  }
  const coordinator = environments.get('fair-00').coordinator;
  for (let i = 0; i < 16; i++) held.push(coordinator.runMutation(environments.get(`fair-${String(i).padStart(2, '0')}`).selector,
    { operation: 'busy-source-owner', operationId: `held-${i}`, revisionMode: 'none' }, async () => barrier));
  const registry = {
    listRestorePointRetirementItems: request => [...registries.values()].flatMap(value => value.listRestorePointRetirementItems(request)),
    loadRestorePointRetirement: id => registries.get(id).loadRestorePointRetirement(id),
    writeRestorePointRetirement: (id, request) => registries.get(id).writeRestorePointRetirement(id, request),
    loadPublishedTerminalEvidence: (id, request) => registries.get(id).loadPublishedTerminalEvidence(id, request),
    hasOtherActiveRestorePointReference: request => registries.get(request.excludingJobId).hasOtherActiveRestorePointReference(request)
  };
  const order = [];
  const observedCoordinator = { assertMutationLease: (...args) => coordinator.assertMutationLease(...args),
    runMutation(selected, options, work) { order.push(selected.instanceId); return coordinator.runMutation(selected, options, work); } };
  const deps = { ...environments.get('fair-00').deps, registry, coordinator: observedCoordinator, clock: () => new Date('2020-01-01T00:00:00.000Z'),
    restorePointServiceFor: selected => [...environments.values()].find(e => e.selector.instanceId === selected.instanceId).service };
  const first = await new FailedRestorePointRetirement(deps).retryPass({ trigger: 'startup', selector: null });
  assert.equal(first.retryConsidered, 16); assert.ok(first.results.every(value => value.reason === 'target-busy'));
  const stamps = new Map();
  for (const [jobId, previous] of registries) {
    const receipt = await previous.loadRestorePointRetirement(jobId); stamps.set(jobId, receipt.value.lastAttemptAt);
    const fresh = new RecoveryRegistry({ userDataPath: previous.userDataPath, durableFs: durable(previous.userDataPath), clock: () => new Date('2020-01-01T00:00:00.000Z') });
    await fresh.initialize(); registries.set(jobId, fresh);
    assert.equal((await fresh.loadRestorePointRetirement(jobId)).value.lastAttemptAt, receipt.value.lastAttemptAt);
  }
  assert.equal(stamps.get('fair-16'), null);
  const second = await new FailedRestorePointRetirement(deps).retryPass({ trigger: 'startup', selector: null });
  assert.deepEqual(order.slice(16, 20), ['server-16', 'server-17', 'server-18', 'server-19']);
  assert.equal(second.results.filter(value => value.status === 'reclaimed').length, 4);
  assert.equal(second.retryConsidered, 16);
  for (let i = 0; i < 20; i++) {
    const e = environments.get(`fair-${String(i).padStart(2, '0')}`);
    assert.equal(fs.existsSync(e.point.archivePath), i < 16); assert.equal(fs.existsSync(e.point.metadataPath), i < 16);
    if (i < 16) assert.equal(e.events.some(event => event.startsWith('archive:')), false);
  }
  release(); await Promise.all(held);
});
