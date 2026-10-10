const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { createRecoveryTargetEnvelope } = require('../../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');
const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
const { ModpackRecoveryFacade } = require('../../electron/services/modpack-lifecycle/modpack-recovery-facade.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationContext } = require('../../electron/services/server-mutation-context.cjs');
const { initializeStartupRecovery, establishStartupRecoveryBoundary } = require('../../electron/services/modpack-lifecycle/startup-recovery-bootstrap.cjs');
const transaction = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');

const target = { kind: 'existing', stableServerId: 'alpha', path: 'C:\\Minecraft\\Alpha' };
const selector = { instanceId: 'alpha', serverPath: target.path };
function queued(targetValue = target) {
  const siblings = targetValue.kind === 'new'
    ? transaction.createSiblingPaths(targetValue.path, 'job-alpha')
    : transaction.createExistingSiblingPaths(targetValue.path, 'job-alpha');
  return {
    schemaVersion: 2, sequence: 0, jobId: 'job-alpha', operationKind: 'upgrade', target: targetValue,
    candidatePath: siblings.candidatePath, rollbackPath: targetValue.kind === 'new' ? null : siblings.rollbackPath,
    failedPath: siblings.failedPath, restorePoint: null, restoreCreation: null, journalPath: null,
    priorRuntime: { running: true, autoRestart: true }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', outcome: null
  };
}
const failedOutcome = { failure: { stage: 'durable-move', category: 'sharing-violation', boundary: 'handle-rename' }, note: 'original terminal outcome' };
const forbidden = () => assert.fail('metadata retry crossed a source/runtime boundary');
async function fixture(t, { fault = 'envelope-before', targetValue = target, terminalPhase = 'failed', outcome = failedOutcome } = {}) {
  let sourceCalls = 0;
  const sourceForbidden = () => { sourceCalls++; forbidden(); };
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-history-publication-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const controls = { fault, moves: 0, beforeMove: null, onYield: null, expectedSourceCalls: 0 };
  t.after(() => assert.equal(sourceCalls, controls.expectedSourceCalls, 'unexpected source/runtime calls'));
  const durableClient = {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync,
    async moveWriteThroughAsync(from, to) { fs.renameSync(from, to); },
    async replaceFileWriteThroughAsync(from, to) { fs.renameSync(from, to); },
    flushDirectory() {}, async flushDirectoryAsync() {}
  };
  const base = createDurableFs({ allowedRoots: [userDataPath], durableClient });
  const durableFs = { ...base, async renameDurableAsync(from, to, options) {
    controls.moves++;
    const part = from.endsWith('.target.json') ? 'envelope' : 'record';
    if (controls.beforeMove) await controls.beforeMove(from, to);
    if (controls.fault === `${part}-before`) throw new Error('injected before move');
    const result = await base.renameDurableAsync(from, to, options);
    if (controls.fault === `${part}-after`) throw new Error('injected after move');
    return result;
  } };
  const makeRegistry = () => new RecoveryRegistry({ userDataPath, durableFs,
    yieldControl: async () => { if (controls.onYield) await controls.onYield(); } });
  let registry = makeRegistry();
  await registry.initialize();
  const initial = await registry.create(queued(targetValue));
  const finish = () => registry.finish(initial.jobId, { terminalPhase, outcome });
  if (fault) await assert.rejects(finish(), { code: 'COMMIT_FAILED' });
  else await finish();
  const activeRecord = path.join(registry.activePath, 'job-alpha.json');
  const activeEnvelope = path.join(registry.activePath, 'job-alpha.target.json');
  const historyRecord = path.join(registry.historyPath, 'job-alpha.json');
  const historyEnvelope = path.join(registry.historyPath, 'job-alpha.target.json');
  const originalBytes = fs.existsSync(historyRecord) ? fs.readFileSync(historyRecord) : null;
  const context = createServerMutationContext();
  const coordinator = new ServerMutationCoordinator({ context, readContentRevision: () => 0, bumpContentRevision: forbidden });
  const makeService = () => new ModpackRecoveryService({ coordinator, recoveryRegistry: registry,
    contextFactory: sourceForbidden, runtimePolicy: { suspend: sourceForbidden, ensureStopped: sourceForbidden,
      adoptValidatedHandoff: sourceForbidden, restoreAutoRestart: sourceForbidden },
    runtimeWriterAuthority: { assertRecoveryAllowed: sourceForbidden },
    directoryAuthority: Object.fromEntries(['exists', 'verifyOperationOwned', 'verifyOriginal', 'renameExact',
      'removeOperationOwned', 'removeAuthorizedIdentity', 'inspectFresh'].map(name => [name, sourceForbidden])),
    transactionApi: Object.fromEntries(Object.keys(transaction).map(name => [name, sourceForbidden])),
    consumeReservedTargetFn: sourceForbidden, restorePointResolver: sourceForbidden,
    restorePointService: { cleanupInterruptedRestorePointCreation: sourceForbidden, verifyRestorePoint: sourceForbidden,
      restoreToFreshCandidate: sourceForbidden }
  });
  const f = { controls, initial, coordinator, context, paths: { activeRecord, activeEnvelope, historyRecord, historyEnvelope },
    originalBytes, makeRegistry, makeService,
    get registry() { return registry; }, get service() { return makeService(); },
    async restart() { registry = makeRegistry(); return registry.initialize(); },
    bindBlock() {
      coordinator.installRecoveryBlocks([{ operationId: initial.jobId,
        selector: { instanceId: targetValue.stableServerId, serverPath: targetValue.path } }]);
      coordinator.completeStartupRecovery([{ selector: { instanceId: targetValue.stableServerId, serverPath: targetValue.path }, resolved: false }]);
    },
    assertPublished() {
      assert.deepEqual(fs.readFileSync(historyRecord), originalBytes);
      assert.equal(fs.existsSync(historyEnvelope), true);
      assert.equal(fs.existsSync(activeEnvelope), false);
      assert.equal(fs.existsSync(activeRecord), false);
    },
    retry(options = {}) { return registry.retryTerminalPublication(initial.jobId, {
      expectedTarget: initial.target, expectedOperationKind: initial.operationKind, ...options }); }
  };
  return f;
}

// Removing the load-null publication call would reproduce false resolved=true while the envelope remains active.
test('ordinary recovery actually publishes a split terminal envelope before clearing its real coordinator block', async t => {
  const f = await fixture(t); f.bindBlock(); f.controls.fault = null;
  const result = await f.service.recover(f.initial);
  assert.equal(result.resolved, true); assert.equal(result.action, 'already-finished');
  assert.equal(result.historyPublication, 'published'); assert.deepEqual(result.failure, { stage: 'durable-move', category: 'sharing-violation', boundary: 'handle-rename' });
  f.assertPublished(); assert.equal((await f.registry.initialize()).blocks.length, 0);
  await f.coordinator.runMutation(selector, { operation: 'probe', operationId: 'probe-job', revisionMode: 'none' }, async () => {});
});

test('scan discovers only authenticated record-first split while listActive remains empty', async t => {
  const f = await fixture(t);
  for (const scan of [await f.registry.initialize(), await f.restart()]) {
    assert.equal(scan.records.length, 0); assert.equal(scan.corrupt.length, 0); assert.equal(scan.blocks.length, 1);
    assert.equal(scan.pendingTerminalPublications.length, 1);
    assert.equal(scan.pendingTerminalPublications[0].jobId, 'job-alpha');
    assert.equal(Object.isFrozen(scan.pendingTerminalPublications), true);
  }
  assert.deepEqual(await f.registry.listActive(), []);
});

test('publication failure remains rejected and blocked, then a genuine passed recovery lease publishes without source work', async t => {
  const f = await fixture(t); f.bindBlock();
  await assert.rejects(f.service.recover(f.initial), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(f.paths.activeEnvelope), true);
  await assert.rejects(f.coordinator.runMutation(selector, { operation: 'probe', operationId: 'probe-job', revisionMode: 'none' }, async () => {}), { code: 'RECOVERY_REQUIRED' });
  f.controls.fault = null;
  const result = await f.coordinator.runRecoveryMutation(selector, { operationId: 'job-alpha' }, lease => f.service.recoverWithLease(f.initial, lease));
  assert.equal(result.resolved, true); f.assertPublished();
});

test('complete history is a positively authenticated no-op without rewriting terminal metadata', async t => {
  const f = await fixture(t, { fault: 'envelope-after', terminalPhase: 'completed', outcome: { preserved: true } });
  f.controls.fault = null; f.bindBlock(); const moves = f.controls.moves;
  const result = await f.service.recover(f.initial);
  assert.equal(result.historyPublication, 'already-published'); assert.equal(f.controls.moves, moves);
  assert.equal(result.failure, undefined); f.assertPublished();
  assert.deepEqual((await f.registry.initialize()).pendingTerminalPublications, []);
});

for (const failure of ['record-before', 'record-after']) test(`first move ${failure} keeps its correct recovery lane`, async t => {
  const f = await fixture(t, { fault: failure }); const scan = await f.registry.initialize();
  if (failure === 'record-before') {
    assert.equal(scan.records.length, 1); assert.deepEqual(scan.pendingTerminalPublications, []);
    f.bindBlock(); f.controls.fault = null;
    f.controls.expectedSourceCalls = 1;
    await assert.rejects(f.service.recover(scan.records[0]), error => error.code === 'RECOVERY_REQUIRED' && /source\/runtime boundary/.test(error.cause?.message));
  } else {
    assert.equal(scan.records.length, 0); assert.equal(scan.pendingTerminalPublications.length, 1);
    f.controls.fault = null; await f.retry(); f.assertPublished();
  }
});

for (const mode of ['success', 'failure', 'boundary']) test(`fresh startup split ${mode} uses full target block and final rescan`, async t => {
  const f = await fixture(t); await f.restart();
  if (mode !== 'failure') f.controls.fault = null;
  const install = f.coordinator.installRecoveryBlocks.bind(f.coordinator);
  f.coordinator.installRecoveryBlocks = blocks => {
    assert.deepEqual(blocks, [{ operationId: 'job-alpha', selector: { instanceId: 'alpha', serverPath: 'c:\\minecraft\\alpha' } }]);
    return install(blocks);
  };
  const moves = f.controls.moves;
  const result = await (mode === 'boundary' ? establishStartupRecoveryBoundary : initializeStartupRecovery)({
    coordinator: f.coordinator, registry: f.registry, recoveryService: f.service,
    runtimeVerifier: async () => ({ quiescent: true })
  });
  assert.deepEqual(result.recovered, mode === 'success' ? ['job-alpha'] : []);
  assert.deepEqual(result.unresolved, mode === 'success' ? [] : ['job-alpha']);
  if (mode === 'success') f.assertPublished();
  else assert.equal(fs.existsSync(f.paths.activeEnvelope), true);
  if (mode === 'boundary') assert.equal(f.controls.moves, moves);
});

test('facade offers one opaque bookkeeping action, revalidates it, and invokes onResolved only after publication', async t => {
  const f = await fixture(t); f.bindBlock(); let scans = 0; const initialize = f.registry.initialize.bind(f.registry);
  f.registry.initialize = async () => { scans++; return initialize(); };
  let callbacks = 0;
  const facade = new ModpackRecoveryFacade({ recoveryRegistry: f.registry, recoveryService: f.service,
    hasActiveJob: () => false,
    canExposePendingNewServer: () => true, onResolved: async (jobId, record, result) => {
      callbacks++; assert.equal(jobId, 'job-alpha'); assert.equal(record.phase, 'failed');
      assert.equal(result.action, 'already-finished'); f.assertPublished(); return true;
    }
  });
  const listed = await facade.listRecovery(); assert.equal(scans, 1); assert.equal(listed.items.length, 1);
  const item = listed.items[0];
  assert.deepEqual(item.actions, [{ actionId: 'retry-history-publication', label: 'Finish recovery bookkeeping', recommended: true }]);
  assert.doesNotMatch(JSON.stringify(item), /Minecraft|job-alpha|original terminal outcome/i);
  const request = { recoveryId: item.recoveryId, actionId: 'retry-history-publication' };
  await assert.rejects(facade.recover(request), { code: 'RECOVERY_REQUIRED' }); assert.equal(callbacks, 0); assert.equal(scans, 2);
  f.controls.fault = null; const result = await facade.recover(request);
  assert.equal(result.resolved, true); assert.equal(result.operationStateReconciled, true); assert.equal(callbacks, 1); assert.equal(scans, 3);
  assert.deepEqual((await facade.listRecovery()).items, []);
  await assert.rejects(facade.recover(request), { code: 'PLAN_STALE' });
});

test('passed metadata lease rejects forged, foreign, expired, nonambient and wrong-job authority', async t => {
  const f = await fixture(t); f.bindBlock(); f.controls.fault = null;
  const fake = { kind: 'mutation', instanceId: 'alpha', serverPath: target.path, operationId: 'job-alpha', markDirty() {} };
  await assert.rejects(f.service.recoverWithLease(f.initial, fake), { code: 'RECOVERY_REQUIRED' });
  let expired;
  await f.coordinator.runRecoveryMutation(selector, { operationId: 'job-alpha' }, async lease => {
    expired = lease;
    await f.context.runWithLease({ assertOwnedPath() {}, markDirty() {} }, () => assert.rejects(f.service.recoverWithLease(f.initial, lease), { code: 'RECOVERY_REQUIRED' }));
    return { resolved: false };
  });
  await assert.rejects(f.service.recoverWithLease(f.initial, expired), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(f.paths.activeEnvelope), true); assert.deepEqual(fs.readFileSync(f.paths.historyRecord), f.originalBytes);
});

for (const binding of [ { expectedOperationKind: 'repair' },
  { expectedTarget: { ...target, kind: 'new' } }, { expectedTarget: { ...target, stableServerId: 'beta' } },
  { expectedTarget: { ...target, path: 'C:\\Minecraft\\Beta' } } ]) test(`bound retry rejects ${JSON.stringify(binding)}`, async t => {
  const f = await fixture(t); f.controls.fault = null; const moves = f.controls.moves;
  await assert.rejects(f.retry(binding)); assert.equal(f.controls.moves, moves);
  assert.deepEqual(fs.readFileSync(f.paths.historyRecord), f.originalBytes); assert.equal(fs.existsSync(f.paths.activeEnvelope), true);
});

for (const damage of ['missing-record', 'missing-envelope', 'duplicate-record', 'duplicate-envelope', 'corrupt-record',
  'nonterminal', 'wrong-job', 'unsafe-path', 'bad-checksum', 'mismatched-envelope', 'envelope-job', 'envelope-server', 'envelope-path', 'unproven']) {
  test(`metadata evidence ${damage} rejects without publication or source work`, async t => {
    const f = await fixture(t); f.controls.fault = null;
    const rewrite = value => fs.writeFileSync(f.paths.historyRecord, JSON.stringify(value));
    const historical = JSON.parse(f.originalBytes);
    if (damage === 'missing-record') fs.unlinkSync(f.paths.historyRecord);
    if (damage === 'missing-envelope') fs.unlinkSync(f.paths.activeEnvelope);
    if (damage === 'duplicate-record') fs.copyFileSync(f.paths.historyRecord, f.paths.activeRecord);
    if (damage === 'duplicate-envelope') fs.copyFileSync(f.paths.activeEnvelope, f.paths.historyEnvelope);
    if (damage === 'corrupt-record') fs.writeFileSync(f.paths.historyRecord, '{broken');
    if (damage === 'nonterminal') rewrite({ ...historical, phase: 'committing' });
    if (damage === 'wrong-job') rewrite({ ...historical, jobId: 'job-other' });
    if (damage === 'unsafe-path') rewrite({ ...historical, target: { ...historical.target, path: 'C:\\Minecraft\\..\\Beta' } });
    if (damage === 'bad-checksum') fs.writeFileSync(f.paths.activeEnvelope, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.paths.activeEnvelope)), checksum: '0'.repeat(64) }));
    if (damage === 'mismatched-envelope') fs.writeFileSync(f.paths.activeEnvelope, JSON.stringify(createRecoveryTargetEnvelope({ ...historical, target: { ...historical.target, stableServerId: 'beta', path: 'C:\\Minecraft\\Beta' } })));
    if (damage.startsWith('envelope-')) fs.writeFileSync(f.paths.activeEnvelope, JSON.stringify(createRecoveryTargetEnvelope({ ...historical,
      ...(damage === 'envelope-job' ? { jobId: 'job-other' } : {}), target: { ...historical.target,
        ...(damage === 'envelope-server' ? { stableServerId: 'beta' } : {}),
        ...(damage === 'envelope-path' ? { path: 'C:\\Minecraft\\Beta' } : {}) }
    })));
    if (damage === 'unproven') rewrite({ ...historical, directoryIdentities: { ...historical.directoryIdentities,
      candidate: { volumeSerial: 'aa', fileId: '02' } }, outcome: { runtimeWriterAuthority: {
      schemaVersion: 1, jobId: 'job-alpha', candidatePath: historical.candidatePath,
      candidateIdentity: { volumeSerial: 'aa', fileId: '02' }, bootSequence: 1, state: 'unproven'
    } } });
    const moves = f.controls.moves; await assert.rejects(f.retry()); assert.equal(f.controls.moves, moves);
    f.bindBlock(); await assert.rejects(f.service.retryTerminalPublication(f.initial), { code: 'RECOVERY_REQUIRED' });
    const scan = await f.registry.initialize(); assert.deepEqual(scan.pendingTerminalPublications, []);
    assert.ok(scan.blocks.length > 0 || scan.globalBlock || damage === 'missing-envelope');
  });
}

test('dedicated metadata action cannot fall through to active source recovery after layout changes', async t => {
  const f = await fixture(t); f.bindBlock(); f.controls.fault = null;
  fs.renameSync(f.paths.historyRecord, f.paths.activeRecord);
  await assert.rejects(f.service.retryTerminalPublication(f.initial), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(f.paths.activeRecord), true); assert.equal(fs.existsSync(f.paths.activeEnvelope), true);
});

test('no record anywhere, including no orphan evidence, is not authenticated completion', async t => {
  const f = await fixture(t); f.bindBlock();
  fs.unlinkSync(f.paths.historyRecord); fs.unlinkSync(f.paths.activeEnvelope);
  await assert.rejects(f.service.recover(f.initial), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(f.service.recoverWithLease(f.initial, { kind: 'mutation', instanceId: 'alpha', serverPath: target.path, markDirty() {} }), { code: 'RECOVERY_REQUIRED' });
});

test('historical new target without a stable ID stays unresolved and path-blocked at startup', async t => {
  const f = await fixture(t, { targetValue: { ...target, kind: 'new', stableServerId: null } });
  f.controls.fault = null;
  const result = await initializeStartupRecovery({ coordinator: f.coordinator, registry: f.registry,
    recoveryService: f.service, runtimeVerifier: async () => ({ quiescent: true }) });
  assert.deepEqual(result.recovered, []); assert.deepEqual(result.unresolved, ['job-alpha']);
  assert.equal(fs.existsSync(f.paths.activeEnvelope), true);
});

for (const substitution of ['envelope', 'record-outcome', 'record-target', 'record-bytes']) test(`publication rejects ${substitution} substitution during its yield`, async t => {
  const f = await fixture(t); f.controls.fault = null; let injected = false;
  f.controls.onYield = () => {
    if (injected) return; injected = true;
    const historical = JSON.parse(fs.readFileSync(f.paths.historyRecord));
    if (substitution === 'envelope') fs.writeFileSync(f.paths.activeEnvelope, JSON.stringify(createRecoveryTargetEnvelope({
      ...historical, target: { ...historical.target, stableServerId: 'beta', path: 'C:\\Minecraft\\Beta' }
    })));
    if (substitution === 'record-outcome') fs.writeFileSync(f.paths.historyRecord, JSON.stringify({ ...historical, sequence: 99, outcome: { replaced: true } }));
    if (substitution === 'record-target') fs.writeFileSync(f.paths.historyRecord, JSON.stringify({ ...historical, target: { ...historical.target, path: 'C:\\Minecraft\\Beta' } }));
    if (substitution === 'record-bytes') fs.appendFileSync(f.paths.historyRecord, '\n');
  };
  await assert.rejects(f.retry()); f.controls.onYield = null;
  if (substitution === 'envelope') {
    assert.equal(fs.existsSync(f.paths.activeEnvelope), true);
    assert.equal((await f.registry.initialize()).blocks.length, 2);
  }
  // Rejection releases the publication gate even after mutation/uncertainty.
  await f.registry.initialize();
});

test('an uncertain retry after envelope mutation rejects once then authenticates a history-only no-op', async t => {
  const f = await fixture(t); f.bindBlock(); f.controls.fault = 'envelope-after';
  await assert.rejects(f.service.recover(f.initial), { code: 'RECOVERY_REQUIRED' });
  f.assertPublished(); f.controls.fault = null; const moves = f.controls.moves;
  const result = await f.service.recover(f.initial);
  assert.equal(result.historyPublication, 'already-published'); assert.equal(f.controls.moves, moves); f.assertPublished();
});

test('two retries, finish, and registry readers share one publication barrier', async t => {
  const f = await fixture(t); f.controls.fault = null; const moves = f.controls.moves;
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.controls.beforeMove = async () => { enter(); await gate; };
  const first = f.retry(); await entered;
  let observed = false;
  const readers = Promise.all([f.registry.initialize(), f.registry.load('job-alpha'), f.registry.listActive(), f.registry.load('job-unrelated')]).then(result => { observed = true; return result; });
  const second = f.retry();
  const finishing = f.registry.finish('job-alpha', { terminalPhase: 'failed', outcome: failedOutcome });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(observed, false);
  release();
  assert.equal((await first).status, 'published'); assert.equal((await second).status, 'already-published');
  const terminal = await finishing; assert.equal(terminal.phase, 'failed');
  const [scan, active, listed, unrelated] = await readers;
  assert.deepEqual(scan.blocks, []); assert.equal(active, null); assert.deepEqual(listed, []); assert.equal(unrelated, null);
  assert.equal(f.controls.moves, moves + 1); f.assertPublished();
});

test('finish winning a race leaves metadata retry an authenticated no-op', async t => {
  const f = await fixture(t); f.controls.fault = null; const moves = f.controls.moves;
  const finishing = f.registry.finish('job-alpha', { terminalPhase: 'failed', outcome: failedOutcome });
  const retry = f.retry(); await finishing;
  assert.equal((await retry).status, 'already-published'); assert.equal(f.controls.moves, moves + 1); f.assertPublished();
});

for (const unsafe of ['hardlink-envelope', 'hardlink-record', 'pinned-history', 'unsafe-entry']) test(`unsafe ${unsafe} evidence cannot publish`, async t => {
  const f = await fixture(t); f.controls.fault = null;
  if (unsafe === 'hardlink-envelope') fs.linkSync(f.paths.activeEnvelope, path.join(f.registry.rootPath, 'extra-envelope'));
  if (unsafe === 'hardlink-record') fs.linkSync(f.paths.historyRecord, path.join(f.registry.rootPath, 'extra-record'));
  if (unsafe === 'pinned-history') {
    fs.renameSync(f.registry.historyPath, `${f.registry.historyPath}-original`);
    fs.mkdirSync(f.registry.historyPath);
    fs.copyFileSync(path.join(`${f.registry.historyPath}-original`, 'job-alpha.json'), f.paths.historyRecord);
  }
  if (unsafe === 'unsafe-entry') {
    fs.mkdirSync(path.join(f.registry.activePath, 'unexpected-entry'));
    assert.equal((await f.registry.initialize()).globalBlock, true);
    // Unrelated unsafe entries retain global blocking; they do not authenticate
    // the requested job or permit application startup to clear that boundary.
    return;
  }
  const moves = f.controls.moves; await assert.rejects(f.retry()); assert.equal(f.controls.moves, moves);
  assert.equal(fs.existsSync(f.paths.activeEnvelope), true);
});

test('WithLease metadata completion admits a genuine nested running start without runtime probes', async t => {
  const f = await fixture(t); f.controls.fault = null;
  f.coordinator.completeStartupRecovery([]);
  await f.coordinator.runMutation(selector, { operation: 'upgrade', operationId: 'job-alpha', revisionMode: 'none' }, async lease => {
    const start = await f.coordinator.acquireStart(selector, { operation: 'start', operationId: 'job-alpha', parentMutationLease: lease });
    start.markRunning({ pid: 1234 }); // Coordinator evidence only; no process is created or inspected.
    assert.equal((await f.service.recoverWithLease(f.initial, lease)).historyPublication, 'published');
    start.release();
  });
  f.assertPublished();
});

test('coordinator assertion rejects wrong job, exact target mismatch, foreign lease, and accepts ambient group ownership', async t => {
  const f = await fixture(t); f.controls.fault = null; f.coordinator.completeStartupRecovery([]);
  await f.coordinator.runMutation(selector, { operation: 'upgrade', operationId: 'wrong-job', revisionMode: 'none' },
    lease => assert.rejects(f.service.recoverWithLease(f.initial, lease), { code: 'RECOVERY_REQUIRED' }));
  const foreign = new ServerMutationCoordinator({ context: f.context, readContentRevision: () => 0 });
  foreign.completeStartupRecovery([]);
  await foreign.runMutation(selector, { operation: 'upgrade', operationId: 'job-alpha', revisionMode: 'none' },
    lease => assert.rejects(f.service.recoverWithLease(f.initial, lease), { code: 'RECOVERY_REQUIRED' }));
  await f.coordinator.runManyMutations([selector, { instanceId: 'beta', serverPath: 'C:\\Minecraft\\Beta' }],
    { operation: 'upgrade', operationId: 'job-alpha', revisionMode: 'none' }, async leases => {
      const alpha = leases.find(lease => lease.instanceId === 'alpha');
      for (const badSelector of [{ ...selector, instanceId: 'beta' }, { ...selector, serverPath: 'C:\\Minecraft\\Beta' }]) {
        assert.throws(() => f.coordinator.assertMutationLease(alpha, badSelector, 'job-alpha'), { code: 'INVALID_REQUEST' });
      }
      assert.equal((await f.service.recoverWithLease(f.initial, alpha)).resolved, true);
    });
  f.assertPublished();
});

test('malformed pending discovery is rejected rather than silently skipped', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.recoverAll({ records: [], corrupt: [], pendingTerminalPublications: [null] }), { code: 'INVALID_REQUEST' });
});

test('bookkeeping action crosses public IPC validation and renders its label in the actual recovery panel', async t => {
  const { validateModpackIpcRequest, validateModpackIpcResult } = require('../../electron/services/modpacks/ipc-schemas.cjs');
  const { pathToFileURL } = require('node:url');
  const f = await fixture(t); f.bindBlock(); f.controls.fault = null;
  const facade = new ModpackRecoveryFacade({ recoveryRegistry: f.registry, recoveryService: f.service, canExposePendingNewServer: () => true, hasActiveJob: () => false });
  const previousWindow = global.window;
  global.window = { electron: { async invoke(channel, request) {
    const normalized = validateModpackIpcRequest(channel, request);
    const value = channel === 'modpacks:list-recovery' ? await facade.listRecovery() : await facade.recover(normalized);
    return validateModpackIpcResult(channel, { ok: true, value });
  } } };
  t.after(() => { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; });
  const root = path.resolve(__dirname, '../..');
  const apiUrl = pathToFileURL(path.join(root, 'src/utils/modpacks/modpackApi.js')).href;
  const { modpackApi } = await import(apiUrl);
  const listed = await modpackApi.listRecovery();
  assert.equal(listed.items.length, 1); assert.equal(listed.items[0].actions[0].actionId, 'retry-history-publication');
  const { compile } = await import('svelte/compiler');
  const componentPath = path.join(root, 'src/components/modpacks/ModpackRecoveryPanel.svelte');
  let code = compile(fs.readFileSync(componentPath, 'utf8'), { filename: componentPath, generate: 'server', dev: false }).js.code;
  for (const [specifier, url] of [
    ['svelte/internal/server', pathToFileURL(require.resolve('svelte/internal/server')).href],
    ['svelte', pathToFileURL(require.resolve('svelte')).href],
    ['../../utils/modpacks/modpackApi.js', apiUrl],
    ['../../utils/modpacks/serverRequestScope.js', pathToFileURL(path.join(root, 'src/utils/modpacks/serverRequestScope.js')).href]
  ]) code = code.replace(`from '${specifier}'`, `from '${url}'`);
  const Component = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
  const { render } = await import('svelte/server');
  const body = render(Component, { props: { records: listed, serverId: 'alpha' } }).body;
  assert.equal((body.match(/Finish recovery bookkeeping/g) || []).length, 1);
  assert.doesNotMatch(body, /Restore prior server|Recheck runtime shutdown|Retry verified recovery|c:\\minecraft/i);
  const result = await modpackApi.recover(listed.items[0].recoveryId, listed.items[0].actions[0].actionId);
  assert.equal(result.resolved, true); assert.equal(result.actionId, 'retry-history-publication');
  assert.doesNotMatch(JSON.stringify(result), /job-alpha|historyPublication|Minecraft/);
  f.assertPublished();
});

test('a reparse envelope is never metadata publication authority', async t => {
  const f = await fixture(t); f.controls.fault = null;
  const originalEnvelope = path.join(f.registry.rootPath, 'original-envelope.json');
  fs.renameSync(f.paths.activeEnvelope, originalEnvelope);
  try { fs.symlinkSync(originalEnvelope, f.paths.activeEnvelope, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('file symlink unavailable'); return; } throw error; }
  const moves = f.controls.moves; await assert.rejects(f.retry()); assert.equal(f.controls.moves, moves);
  assert.equal((await f.registry.initialize()).globalBlock, true);
});
