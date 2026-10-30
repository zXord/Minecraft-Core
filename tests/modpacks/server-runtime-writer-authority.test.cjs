const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { retainRuntimeWorkerQuiescence } = require('../../electron/services/runtime-worker-quiescence.cjs');
const { ServerRuntimeWriterAuthority, legacyMayHaveRuntimeWriters } = require('../../electron/services/modpack-lifecycle/server-runtime-writer-authority.cjs');

// Settling after a failure is a registry read plus a durable write, which can
// take far longer than a few hundred milliseconds under full-suite load. The
// fixture therefore allows a load-tolerant bound; tests whose closure never
// comes, or comes only after the refusal, ask for a bound that expires quickly.
const LOAD_TOLERANT_SETTLEMENT_MS = 10000;
const EXPIRING_SETTLEMENT_MS = 200;

async function fixture(t, { protocol = true, settlementTimeoutMs = LOAD_TOLERANT_SETTLEMENT_MS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-runtime-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {} } });
  const registry = new RecoveryRegistry({ userDataPath: root, durableFs }); await registry.initialize();
  const now = new Date().toISOString(); const candidatePath = 'C:\\fixture\\.candidate';
  await registry.create({ schemaVersion: 2, sequence: 0, jobId: 'job-runtime', operationKind: 'upgrade',
    target: { kind: 'existing', stableServerId: 'server-a', path: 'C:\\fixture\\server' }, candidatePath,
    rollbackPath: null, failedPath: null, restorePoint: null, restoreCreation: null, journalPath: null,
    priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null }, createdAt: now, updatedAt: now, outcome: null });
  await registry.transition('job-runtime', { expectedPhase: 'queued', nextPhase: 'preflight', patch: {
    outcome: protocol ? { runtimeWriterProtocol: 1 } : {} } });
  await registry.transition('job-runtime', { expectedPhase: 'preflight', nextPhase: 'validating-candidate', patch: {
    directoryIdentities: { target: null, candidate: { volumeSerial: 'ab', fileId: 'cd' }, rollback: null, failed: null },
    outcome: protocol ? { runtimeWriterProtocol: 1 } : {} } });
  const state = { boot: 10, blocked: 0 };
  const guard = new ServerRuntimeWriterAuthority({ registry, getBootSequence: async () => state.boot,
    coordinator: { quarantineMutation() { state.blocked++; } }, settlementTimeoutMs });
  return { root, registry, guard, state, lease: {}, async record() { return registry.load('job-runtime'); } };
}

test('unproven authority is durable before work and success records exact settlement', async t => {
  const f = await fixture(t);
  await f.guard.run('job-runtime', async () => { assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'unproven'); }, { lease: f.lease });
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'settled');
  await f.guard.assertRecoveryAllowed(await f.record());
});

test('never-close failure persists diagnosis before bounded refusal and blocks the lease', async t => {
  const f = await fixture(t, { settlementTimeoutMs: EXPIRING_SETTLEMENT_MS });
  const error = retainRuntimeWorkerQuiescence(Object.assign(new Error('private installer path'), { code: 'RUNTIME_INCOMPLETE' }), new Promise(() => {}));
  await assert.rejects(f.guard.run('job-runtime', async () => { throw error; }, { lease: f.lease }), { code: 'RECOVERY_REQUIRED' });
  const record = await f.record(); assert.equal(record.outcome.runtimeWriterAuthority.state, 'unproven');
  assert.deepEqual(record.outcome.runtimeWriterFailure, { code: 'RUNTIME_INCOMPLETE' }); assert.equal(f.state.blocked, 1);
  await assert.rejects(f.guard.assertRecoveryAllowed(record), { code: 'RECOVERY_REQUIRED' });
});

test('late trusted closure settles the same durable marker without deleting anything', async t => {
  const f = await fixture(t, { settlementTimeoutMs: EXPIRING_SETTLEMENT_MS }); let close;
  const error = retainRuntimeWorkerQuiescence(new Error('worker'), new Promise(resolve => { close = resolve; }));
  await assert.rejects(f.guard.run('job-runtime', async () => { throw error; }, { lease: f.lease }), { code: 'RECOVERY_REQUIRED' });
  close(true);
  const deadline = Date.now() + LOAD_TOLERANT_SETTLEMENT_MS;
  while ((await f.record()).outcome.runtimeWriterAuthority.state !== 'settled' && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'settled');
});

test('failure to persist initial runtime authority never invokes the writer', async t => {
  const f = await fixture(t); let ran = false;
  f.registry.updateRuntimeWriterAuthority = async () => { throw new Error('CAS failed'); };
  await assert.rejects(f.guard.run('job-runtime', async () => { ran = true; }, { lease: f.lease }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(ran, false); assert.equal(f.state.blocked, 1);
});

test('unproven authority cannot be dropped, replaced, forged settled or archived', async t => {
  const f = await fixture(t); let proceed;
  const work = f.guard.run('job-runtime', () => new Promise(resolve => { proceed = resolve; }), { lease: f.lease });
  while (!proceed) await new Promise(resolve => setImmediate(resolve));
  const record = await f.record(); const authority = record.outcome.runtimeWriterAuthority;
  for (const replacement of [null, { ...authority, state: 'settled' }, { ...authority, jobId: 'other-job' }]) {
    await assert.rejects(f.registry.transition('job-runtime', { expectedPhase: record.phase, nextPhase: record.phase,
      patch: { outcome: { runtimeWriterAuthority: replacement } } }));
  }
  await assert.rejects(f.registry.finish('job-runtime', { terminalPhase: 'failed', outcome: {} }), { code: 'RECOVERY_REQUIRED' });
  proceed(); await work;
});

test('legacy possible-runtime record is first refused, then only strictly later boot permits recovery', async t => {
  const f = await fixture(t, { protocol: false });
  await assert.rejects(f.guard.assertRecoveryAllowed(await f.record()), { code: 'RECOVERY_REQUIRED' });
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.bootSequence, 10);
  for (const boot of [10, 9, 0, null, '11']) { f.state.boot = boot; await assert.rejects(f.guard.assertRecoveryAllowed(await f.record()), { code: 'RECOVERY_REQUIRED' }); }
  f.state.boot = 11; await f.guard.assertRecoveryAllowed(await f.record());
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'settled');
});

test('unrelated stale outcome transitions preserve runtime refusal authority', async t => {
  const f = await fixture(t); let proceed;
  const work = f.guard.run('job-runtime', () => new Promise(resolve => { proceed = resolve; }), { lease: f.lease });
  while (!proceed) await new Promise(resolve => setImmediate(resolve));
  await f.registry.transition('job-runtime', { expectedPhase: 'validating-candidate', nextPhase: 'validating-candidate', patch: { outcome: { unrelated: true } } });
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'unproven'); proceed(); await work;
});

test('settlement CAS failure leaves durable refusal and does not retry or report ordinary failure', async t => {
  const f = await fixture(t); const update = f.registry.updateRuntimeWriterAuthority.bind(f.registry); let writes = 0;
  f.registry.updateRuntimeWriterAuthority = async (...args) => {
    writes++; if (writes === 2) throw new Error('settlement write unavailable'); return update(...args);
  };
  await assert.rejects(f.guard.run('job-runtime', async () => {}, { lease: f.lease }), { code: 'RECOVERY_REQUIRED', runtimeWritersUnproven: true });
  assert.equal(writes, 2); assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'unproven');
  assert.equal(f.state.blocked, 1);
});

test('failure-diagnostic CAS failure never authorizes cleanup even if worker already closed', async t => {
  const f = await fixture(t); const update = f.registry.updateRuntimeWriterAuthority.bind(f.registry); let writes = 0;
  f.registry.updateRuntimeWriterAuthority = async (...args) => {
    writes++; if (writes > 1) throw new Error('diagnostic write unavailable'); return update(...args);
  };
  await assert.rejects(f.guard.run('job-runtime', async () => { throw Object.assign(new Error('installer'), { code: 'RUNTIME_INCOMPLETE' }); }, { lease: f.lease }),
    { code: 'RECOVERY_REQUIRED', runtimeWritersUnproven: true, runtimeFailureCode: 'RUNTIME_INCOMPLETE' });
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'unproven'); assert.equal(f.state.blocked, 1);
});

test('untrusted closure and unavailable boot proof never settle runtime writers', async t => {
  const f = await fixture(t);
  const error = retainRuntimeWorkerQuiescence(Object.assign(new Error('worker'), { code: 'RUNTIME_INCOMPLETE' }), Promise.resolve(false));
  await assert.rejects(f.guard.run('job-runtime', async () => { throw error; }, { lease: f.lease }), { code: 'RECOVERY_REQUIRED' });
  f.guard.getBootSequence = async () => { throw new Error('OS probe unavailable'); };
  await assert.rejects(f.guard.assertRecoveryAllowed(await f.record()), { code: 'RECOVERY_REQUIRED' });
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'unproven');
});

test('strict authority rejects malformed types and every job/candidate identity substitution', async t => {
  const f = await fixture(t); const record = await f.record();
  const valid = { schemaVersion: 1, jobId: record.jobId, candidatePath: record.candidatePath,
    candidateIdentity: record.directoryIdentities.candidate, bootSequence: 10, state: 'unproven' };
  for (const authority of [null, { ...valid, schemaVersion: '1' }, { ...valid, bootSequence: '10' },
    { ...valid, candidateIdentity: { volumeSerial: 123, fileId: 'cd' } }, { ...valid, jobId: 'other-job' },
    { ...valid, candidatePath: 'C:\\fixture\\other' }, { ...valid, candidateIdentity: { volumeSerial: 'ab', fileId: 'ee' } },
    { ...valid, extra: true }, { ...valid, state: 'settled' }]) {
    await assert.rejects(f.registry.updateRuntimeWriterAuthority(record.jobId, { expectedSequence: record.sequence, authority, failureCode: null }));
  }
  assert.equal((await f.record()).outcome.runtimeWriterAuthority, undefined);
});

test('corrupt persisted marker is retained as a blocked startup record, never interpreted as absent', async t => {
  const f = await fixture(t); const record = await f.record();
  record.outcome.runtimeWriterAuthority = { state: 'settled' };
  fs.writeFileSync(path.join(f.registry.activePath, 'job-runtime.json'), JSON.stringify(record));
  const scan = await f.registry.initialize();
  assert.equal(scan.corrupt.some(item => item.jobId === record.jobId), true);
  assert.equal(scan.blocks.some(item => item.jobId === record.jobId), true);
  await assert.rejects(f.record());
});

test('legacy phases are conservative after runtime admission, but untouched and healthy history remain usable', async t => {
  const f = await fixture(t, { protocol: false }); const base = await f.record();
  for (const phase of ['queued', 'preflight', 'snapshotting', 'staging', 'committed-healthy', 'cleanup', 'cleanup-pending', 'completed']) {
    const record = { ...base, phase }; assert.equal(await f.guard.assertRecoveryAllowed(record), record);
  }
  for (const operationKind of ['install', 'upgrade', 'downgrade', 'switch', 'repair', 'rollback']) {
    for (const phase of ['validating-candidate', 'committing', 'rolling-back', 'failed', 'recovery-required', 'unknown']) {
      assert.equal(legacyMayHaveRuntimeWriters({ ...base, operationKind, phase }), true, `${operationKind}/${phase}`);
    }
  }
});

test('new runtime protocol can only be declared at the queued to preflight boundary', async t => {
  const f = await fixture(t); const base = await f.record();
  await f.registry.create({ ...base, jobId: 'job-another', sequence: 0, phase: 'queued', outcome: null });
  await assert.rejects(f.registry.transition('job-another', { expectedPhase: 'queued', nextPhase: 'staging',
    patch: { outcome: { runtimeWriterProtocol: 1 } } }));
});

test('timeout quarantine survives ordinary lease release and late settlement until explicit recovery', async t => {
  const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
  const f = await fixture(t, { settlementTimeoutMs: EXPIRING_SETTLEMENT_MS });
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 0, bumpContentRevision: () => 1 });
  coordinator.completeStartupRecovery([]); f.guard.coordinator = coordinator;
  const selector = { instanceId: 'server-a', serverPath: 'C:\\fixture\\server' };
  const options = { operation: 'prepare-runtime', operationId: 'job-runtime', revisionMode: 'none', quiesce: null };
  let close; const error = retainRuntimeWorkerQuiescence(Object.assign(new Error('loader'), { code: 'RUNTIME_INCOMPLETE' }),
    new Promise(resolve => { close = resolve; }));
  await assert.rejects(coordinator.runMutation(selector, options, lease =>
    f.guard.run('job-runtime', async () => { throw error; }, { lease })), { code: 'RECOVERY_REQUIRED', runtimeFailureCode: 'RUNTIME_INCOMPLETE' });
  const forbidden = () => coordinator.runMutation(selector, { ...options, operationId: 'another-job' }, async () => assert.fail('writer admitted'));
  await assert.rejects(forbidden(), { code: 'RECOVERY_REQUIRED' });
  close(true); const deadline = Date.now() + LOAD_TOLERANT_SETTLEMENT_MS;
  while ((await f.record()).outcome.runtimeWriterAuthority.state !== 'settled' && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'settled');
  await assert.rejects(forbidden(), { code: 'RECOVERY_REQUIRED' });
  await coordinator.runRecoveryMutation(selector, { operationId: 'job-runtime' }, async lease => {
    await f.guard.assertRecoveryAllowed(await f.record(), { lease }); return { resolved: true };
  });
  await coordinator.runMutation(selector, { ...options, operationId: 'new-job' }, async () => {});
});

test('bounded runtime diagnostic is durable before closure and survives recovery-required wrapping', async t => {
  const f = await fixture(t, { settlementTimeoutMs: EXPIRING_SETTLEMENT_MS });
  const diagnostic = { stage: 'finalizer-stability-before-publish', reason: 'identity-changed', changedIdentityFields: 64 };
  const error = retainRuntimeWorkerQuiescence(Object.assign(new Error('private path must not escape'), {
    code: 'RUNTIME_INCOMPLETE', runtimeDiagnostic: diagnostic
  }), new Promise(() => {}));
  const failed = await f.guard.run('job-runtime', async () => { throw error; }, { lease: f.lease }).catch(value => value);
  assert.equal(failed.code, 'RECOVERY_REQUIRED'); assert.deepEqual(failed.runtimeDiagnostic, diagnostic);
  assert.deepEqual((await f.record()).outcome.runtimeWriterFailure, { code: 'RUNTIME_INCOMPLETE', diagnostic });
});

test('a settlement write slowed by load still reports the original failure, not a recovery block', async t => {
  const f = await fixture(t); const update = f.registry.updateRuntimeWriterAuthority.bind(f.registry); let writes = 0;
  f.registry.updateRuntimeWriterAuthority = async (...args) => {
    // Write 3 settles the authority; a loaded disk makes it outlast a short bound.
    if (++writes === 3) await new Promise(resolve => setTimeout(resolve, EXPIRING_SETTLEMENT_MS * 2));
    return update(...args);
  };
  const error = Object.assign(new Error('private'), { code: 'RUNTIME_INCOMPLETE' });
  await assert.rejects(f.guard.run('job-runtime', async () => { throw error; }, { lease: f.lease }), failure => failure === error);
  assert.equal(writes, 3); assert.equal(f.state.blocked, 0);
  assert.equal((await f.record()).outcome.runtimeWriterAuthority.state, 'settled');
});

test('malformed or accessor runtime diagnostics cannot leak into durable failure metadata', async t => {
  for (const unsafe of [{ stage: 'C:\\secret', reason: 'io', osCode: 'ENOENT' }, { stage: 'forge-installer', reason: 'io', osCode: 'ENOENT', path: 'secret' },
    Object.defineProperty({ reason: 'io' }, 'stage', { enumerable: true, get() { assert.fail('diagnostic accessor was invoked'); } })]) {
    const f = await fixture(t); const error = Object.assign(new Error('private'), { code: 'RUNTIME_INCOMPLETE', runtimeDiagnostic: unsafe });
    await assert.rejects(f.guard.run('job-runtime', async () => { throw error; }, { lease: f.lease }), { code: 'RUNTIME_INCOMPLETE' });
    assert.deepEqual((await f.record()).outcome.runtimeWriterFailure, { code: 'RUNTIME_INCOMPLETE' });
  }
});
