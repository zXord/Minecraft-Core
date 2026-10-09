const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { ModpackRecoveryService, defaultDirectoryAuthority } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
const { ServerRuntimeWriterAuthority } = require('../../electron/services/modpack-lifecycle/server-runtime-writer-authority.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createExistingSiblingPaths } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const { inspectServerDirectoryTree } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');

// Real directory inspection, journal, writer admission and coordinator; only external
// runtime launch/shutdown and the native durability transport are replaced.
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-stopped-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'servers', 'Alpha');
  fs.mkdirSync(path.join(serverPath, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(serverPath, 'config'));
  fs.writeFileSync(path.join(serverPath, 'logs', 'latest.log'), 'old log');
  fs.writeFileSync(path.join(serverPath, 'config', 'broken.toml'), 'malformed = [');
  const reparseInspector = { async isReparsePoint() { return false; } };
  const paths = createExistingSiblingPaths(serverPath, 'job-stopped');
  const original = await inspectServerDirectoryTree(serverPath, { fsApi: fs, reparseInspector });
  let candidate = null;
  if (options.candidate) {
    fs.mkdirSync(paths.candidatePath);
    fs.writeFileSync(path.join(paths.candidatePath, 'partial.txt'), 'candidate-only');
    candidate = await inspectServerDirectoryTree(paths.candidatePath, { reparseInspector });
  }
  let token = 0;
  const durableFs = createDurableFs({ fsApi: fs, allowedRoots: [root],
    tempNameFactory: () => `stopped-${++token}`,
    durableClient: {
      moveWriteThrough(a, b) { fs.renameSync(a, b); },
      async moveWriteThroughAsync(a, b) { fs.renameSync(a, b); },
      replaceFileWriteThrough(a, b) { fs.renameSync(a, b); },
      async replaceFileWriteThroughAsync(a, b) { fs.renameSync(a, b); },
      flushDirectory() {},
      async flushDirectoryAsync() {}
    }
  });
  let failHistory = false;
  const registry = new RecoveryRegistry({ userDataPath: root, durableFs: {
    ...durableFs,
    async renameDurableAsync(a, b, request) {
      if (options.onHistory && b.includes(`${path.sep}history${path.sep}`)) await options.onHistory(value);
      if (failHistory && b.includes(`${path.sep}history${path.sep}`)) throw new Error('history transport failed');
      return durableFs.renameDurableAsync(a, b, request);
    }
  } });
  await registry.initialize();
  await registry.create({ schemaVersion: 2, sequence: 0, jobId: 'job-stopped', operationKind: options.operationKind || 'repair',
    target: { kind: 'existing', stableServerId: 'alpha', path: serverPath },
    candidatePath: paths.candidatePath, rollbackPath: paths.rollbackPath, failedPath: paths.failedPath,
    journalPath: null, restorePoint: null, restoreCreation: null,
    priorRuntime: { running: false, autoRestart: false }, phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: original.directoryIdentity, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', outcome: null });
  const outcome = { live: { fingerprint: original.fingerprint }, ...(options.legacyWriter ? {} : { runtimeWriterProtocol: 1 }),
    ...(options.terminal ? { recovery: { action: 'pre-swap-restored', operationId: 'job-stopped' } } : {}),
    ...(options.authorizedCandidate ? { candidateCleanup: {
      deletionAuthorized: true, slot: 'candidate', action: 'pre-swap-restored',
      directoryIdentity: candidate.directoryIdentity, fingerprint: candidate.fingerprint, ownershipMode: 'recorded-identity'
    } } : {}),
    ...options.outcome };
  await registry.transition('job-stopped', { expectedPhase: 'queued', nextPhase: 'preflight',
    patch: { outcome: options.legacyWriter ? {} : { runtimeWriterProtocol: 1 } } });
  let initial = await registry.transition('job-stopped', { expectedPhase: 'preflight',
    nextPhase: 'snapshotting', patch: {
      ...options.patch, outcome,
      directoryIdentities: { target: original.directoryIdentity, candidate: candidate?.directoryIdentity || null,
        rollback: options.terminal ? original.directoryIdentity : null, failed: null,
        ...(typeof options.identities === 'function' ? options.identities(original) : options.identities) }
    } });
  if (options.terminal) initial = await registry.transition(initial.jobId, { expectedPhase: 'snapshotting', nextPhase: 'failed', patch: {} });
  const selector = { instanceId: 'alpha', serverPath };
  const coordinator = new ServerMutationCoordinator({ readContentRevision: () => 4,
    bumpContentRevision() { assert.fail('no revision may be created'); } });
  coordinator.installRecoveryBlocks([{ selector, operationId: initial.jobId }]);
  coordinator.completeStartupRecovery([{ selector, resolved: false }]);
  const calls = [];
  const runtimePolicy = {
    async suspend() { calls.push('suspend'); return { held: true }; },
    async ensureStopped() { calls.push('stop'); if (options.onStop) await options.onStop(value); return options.stopResult || { alreadyStopped: true }; },
    async restoreAutoRestart(request) {
      calls.push('auto'); assert.equal(request.enabled, initial.priorRuntime.autoRestart);
      if (options.onAuto) await options.onAuto(value);
      return options.autoResult || { restored: true };
    },
    async adoptValidatedHandoff() { assert.fail('source adoption forbidden'); }
  };
  const authority = defaultDirectoryAuthority();
  const service = new ModpackRecoveryService({ coordinator, recoveryRegistry: registry, runtimePolicy,
    runtimeWriterAuthority: new ServerRuntimeWriterAuthority({ registry, coordinator, getBootSequence: () => 1 }),
    directoryAuthority: options.authority ? options.authority(authority, calls) : authority,
    restorePointService: options.restorePointService || null,
    contextFactory: async ({ record, mutationLease }) => ({ fsApi: fs, reparseInspector, durableFs,
      jobId: record.jobId, mutationLease, targetPath: serverPath, operationKind: record.operationKind,
      recoveryRegistry: registry, stableInstanceId: 'alpha', runtimePolicy,
      async resolveRecoveryRuntimeConfig() {
        calls.push('config');
        if (options.runtimeConfig) return options.runtimeConfig;
        throw new Error('source config must not be resolved');
      },
      healthValidator: { async validateLive() { calls.push('health'); throw new Error('source launch forbidden'); } }
    }) });
  const value = { root, serverPath, paths, original, initial, selector, coordinator, registry, service, calls,
    authority, reparseInspector, candidate, failHistory(enabled) { failHistory = enabled; },
    recover() { return service.recover(initial); },
    withLease(work) { return coordinator.runRecoveryMutation(selector, { operationId: initial.jobId }, work); },
    async update(patch) {
      initial = await registry.transition(initial.jobId, { expectedPhase: initial.phase, nextPhase: initial.phase, patch });
      value.initial = initial; return initial;
    }
  };
  return value;
}

test('stopped original initial cleanup proves full source and finishes failed without config or boot', async t => {
  let originalProofs = 0;
  const value = await fixture(t, { authority: base => ({ ...base, async verifyOriginal(request) {
    originalProofs++;
    assert.equal((await value.registry.load('job-stopped')).phase, 'snapshotting');
    return base.verifyOriginal(request);
  } }) });
  const before = await inspectServerDirectoryTree(value.serverPath, { reparseInspector: value.reparseInspector });
  const result = await value.recover();
  assert.deepEqual(result, { jobId: 'job-stopped', resolved: true, action: 'pre-swap-restored' });
  const historical = await value.registry.loadHistory('job-stopped');
  assert.equal(historical.phase, 'failed');
  assert.deepEqual(historical.outcome.recovery, { action: 'pre-swap-restored', operationId: 'job-stopped' });
  assert.equal((await inspectServerDirectoryTree(value.serverPath, { reparseInspector: value.reparseInspector })).fingerprint, before.fingerprint);
  assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
  assert.equal(originalProofs, 1);
  assert.equal(await value.registry.load('job-stopped'), null);
  assert.deepEqual(fs.readdirSync(value.registry.activePath), []);
  assert.deepEqual(fs.readdirSync(value.registry.historyPath).sort(), ['job-stopped.json', 'job-stopped.target.json']);
  const start = await value.coordinator.acquireStart(value.selector, { operation: 'later-start', operationId: 'later', parentMutationLease: null });
  start.release();
});

for (const relative of ['logs/latest.log', 'config/broken.toml']) {
  test(`stopped native-shaped terminal retry retains safe current ${relative} bytes and exact outcome`, async t => {
    const value = await fixture(t, { terminal: true });
    const before = value.initial;
    fs.writeFileSync(path.join(value.serverPath, relative), 'current user bytes');
    assert.notEqual((await inspectServerDirectoryTree(value.serverPath, { reparseInspector: value.reparseInspector })).fingerprint, value.original.fingerprint);
    const result = await value.recover();
    assert.equal(result.resolved, true);
    assert.equal(fs.readFileSync(path.join(value.serverPath, relative), 'utf8'), 'current user bytes');
    const historical = await value.registry.loadHistory(before.jobId);
    assert.equal(historical.schemaVersion, 2);
    assert.equal(historical.phase, 'failed');
    assert.deepEqual(historical.outcome, before.outcome);
    assert.equal(historical.sequence, before.sequence);
    assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
  });
}

test('stopped retain reservation holds through policy and finish and releases on durable failure for exact retry', async t => {
  const value = await fixture(t, { terminal: true, onAuto: async c => {
    await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'conflicting-health', operationId: 'other',
      parentMutationLease: c.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
  } });
  value.failHistory(true);
  const outcome = structuredClone(value.initial.outcome);
  await value.withLease(async lease => {
    value.parentLease = lease;
    await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
    const released = await value.coordinator.acquireStart(value.selector, { operation: 'prove-release', operationId: 'other', parentMutationLease: lease });
    released.release();
  });
  assert.deepEqual((await value.registry.load('job-stopped')).outcome, outcome);
  await assert.rejects(value.coordinator.acquireStart(value.selector, { operation: 'ordinary-start', operationId: 'other', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
  value.failHistory(false);
  await value.withLease(async lease => {
    value.parentLease = lease;
    assert.equal((await value.service.recoverWithLease(value.initial, lease)).resolved, true);
  });
  assert.deepEqual((await value.registry.loadHistory('job-stopped')).outcome, outcome);
});

for (const slot of ['source', 'candidate']) {
  test(`stopped retain WithLease and top-level recovery reject retained ${slot} health start authority`, async t => {
    const value = await fixture(t, { terminal: true });
    let retained;
    await value.withLease(async lease => {
      retained = await value.coordinator.acquireStart({ instanceId: 'alpha',
        serverPath: slot === 'candidate' ? value.paths.candidatePath : value.serverPath }, {
        operation: 'health-validation', operationId: 'retained-health', parentMutationLease: lease });
      await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
      assert.equal((await value.registry.load(value.initial.jobId)).phase, 'failed');
      assert.equal(value.calls.includes('auto'), false);
    });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    retained.release();
    assert.equal((await value.recover()).resolved, true);
  });
}

test('stopped retain rejects forged, expired and nonambient mutation parents with actual coordinator', async t => {
  const value = await fixture(t, { terminal: true });
  let expired;
  await value.withLease(async lease => { expired = lease; });
  const fake = { kind: 'mutation', operationId: 'job-stopped', instanceId: 'alpha', serverPath: value.serverPath, markDirty() {} };
  for (const lease of [fake, expired]) {
    await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
  }
  let continueWork;
  let admitted;
  const active = new Promise(resolve => { admitted = resolve; });
  const finished = value.withLease(async lease => {
    admitted(lease);
    await new Promise(resolve => { continueWork = resolve; });
  });
  const nonambient = await active;
  try {
    await assert.rejects(value.service.recoverWithLease(value.initial, nonambient), { code: 'RECOVERY_REQUIRED' });
  } finally { continueWork(); await finished; }
  assert.equal((await value.recover()).resolved, true);
});

test('stopped initial recovery rejects changed original bytes before durable restored action', async t => {
  const value = await fixture(t);
  fs.writeFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'new bytes');
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  const active = await value.registry.load(value.initial.jobId);
  assert.equal(active.phase, 'snapshotting');
  assert.equal(active.outcome.recovery, undefined);
  assert.equal(value.calls.includes('auto'), false);
});

const contradictions = [
  ['wrong operation', { recovery: { action: 'pre-swap-restored', operationId: 'other-job' } }],
  ['missing operation', { recovery: { action: 'pre-swap-restored' } }],
  ['no source evidence', { live: null }],
  ['conflicting fingerprints', { rollback: { fingerprint: 'f'.repeat(64) } }],
  ['malformed historical fingerprint', { rollback: { fingerprint: 0 } }],
  ['publication', { publication: { state: 'published' } }],
  ['registration', { registration: { complete: false } }],
  ['live authorization', { liveMutationAuthorized: true }],
  ['malformed live authorization', { liveMutationAuthorized: 'false' }],
  ['live validation', { liveValidation: {} }],
  ['revision event', { revisionEvent: { published: false } }],
  ['crossed outcome swap', { swap: { step: 'live-moved' } }],
  ['malformed outcome swap', { swap: 'none' }]
];
for (const [name, outcome] of contradictions) {
  test(`stopped terminal retain rejects ${name} without launching`, async t => {
    const value = await fixture(t, { terminal: true, outcome });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(await value.registry.loadHistory(value.initial.jobId), null);
    assert.equal(value.calls.includes('config'), false);
    assert.equal(value.calls.includes('auto'), false);
  });
}

for (const mismatch of ['rollback', 'candidate', 'failed']) {
  test(`stopped terminal retain rejects conflicting ${mismatch} identity`, async t => {
    // Real schema normalizes shape but deliberately does not enforce these
    // semantic identity relationships; construct it before the terminal phase.
    const initial = await fixture(t, { terminal: true, identities: original => ({ [mismatch]: mismatch === 'candidate'
      ? original.directoryIdentity : { volumeSerial: 'aa', fileId: 'bb' } }) });
    await assert.rejects(initial.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(initial.calls.includes('config'), false);
  });
}

for (const topology of ['missing', 'replacement', 'rollback', 'failed', 'symlink', 'hardlink']) {
  test(`stopped terminal retain rejects ${topology} canonical topology`, async t => {
    const value = await fixture(t, { terminal: true });
    if (topology === 'missing' || topology === 'replacement') {
      fs.renameSync(value.serverPath, path.join(value.root, 'retained-original'));
      if (topology === 'replacement') fs.mkdirSync(value.serverPath);
    } else if (topology === 'rollback' || topology === 'failed') {
      fs.mkdirSync(value.paths[`${topology}Path`]);
    } else if (topology === 'symlink') {
      fs.renameSync(value.serverPath, path.join(value.root, 'retained-original'));
      fs.symlinkSync(path.join(value.root, 'retained-original'), value.serverPath, 'junction');
    } else {
      fs.linkSync(path.join(value.serverPath, 'config', 'broken.toml'), path.join(value.serverPath, 'config', 'linked.toml'));
    }
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(await value.registry.loadHistory(value.initial.jobId), null);
    assert.equal(value.calls.includes('auto'), false);
  });
}

for (const change of ['target', 'parent', 'rollback', 'failed', 'candidate']) {
  test(`stopped retain rechecks ${change} after awaited policy restoration`, async t => {
    const value = await fixture(t, { terminal: true, onAuto: async c => {
      await new Promise(resolve => setImmediate(resolve));
      if (change === 'target') {
        fs.renameSync(c.serverPath, path.join(c.root, 'saved-target')); fs.mkdirSync(c.serverPath);
      } else if (change === 'parent') {
        const parent = path.dirname(c.serverPath);
        fs.renameSync(parent, path.join(c.root, 'saved-parent'));
        fs.mkdirSync(parent);
        fs.renameSync(path.join(c.root, 'saved-parent', 'Alpha'), c.serverPath);
      } else fs.mkdirSync(c.paths[`${change}Path`]);
    } });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.ok(await value.registry.load(value.initial.jobId));
    assert.equal(await value.registry.loadHistory(value.initial.jobId), null);
  });
}

for (const [name, policy] of [['stop', { stopResult: { stopped: false } }], ['auto-restart', { autoResult: { restored: false } }]]) {
  test(`stopped retain ${name} proof failure retains recovery and releases reservation`, async t => {
    const value = await fixture(t, { terminal: true, ...policy });
    await value.withLease(async lease => {
      await assert.rejects(value.service.recoverWithLease(value.initial, lease), { code: 'RECOVERY_REQUIRED' });
      const start = await value.coordinator.acquireStart(value.selector, { operation: 'prove-release', operationId: 'release', parentMutationLease: lease });
      start.release();
    });
    assert.ok(await value.registry.load(value.initial.jobId));
  });
}

test('stopped initial candidate cleanup preserves independent exact deletion proof and resumes partial deletion', async t => {
  let fail = true;
  const value = await fixture(t, { candidate: true, authority: base => ({ ...base,
    async removeAuthorizedIdentity(request) {
      if (fail) {
        fs.unlinkSync(path.join(request.directoryPath, 'partial.txt'));
        throw new Error('partial deletion failed');
      }
      return base.removeAuthorizedIdentity(request);
    }
  }) });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  const active = await value.registry.load(value.initial.jobId);
  assert.equal(active.phase, 'failed');
  assert.equal(active.outcome.candidateCleanup.deletionAuthorized, true);
  assert.equal(fs.existsSync(value.paths.candidatePath), true);
  fail = false;
  assert.equal((await value.recover()).resolved, true);
  assert.equal(fs.existsSync(value.paths.candidatePath), false);
  assert.equal((await value.registry.loadHistory(value.initial.jobId)).phase, 'failed');
});

test('stopped terminal candidate without prior deletion authority remains untouched', async t => {
  const value = await fixture(t, { terminal: true, candidate: true });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(value.paths.candidatePath, 'partial.txt'), 'utf8'), 'candidate-only');
  assert.equal(value.calls.includes('auto'), false);
});

test('stopped terminal candidate with exact existing deletion authority is independently removed', async t => {
  const value = await fixture(t, { terminal: true, candidate: true, authorizedCandidate: true });
  assert.equal((await value.recover()).resolved, true);
  assert.equal(fs.existsSync(value.paths.candidatePath), false);
  assert.deepEqual((await value.registry.loadHistory(value.initial.jobId)).outcome, value.initial.outcome);
});

for (const operationKind of ['upgrade', 'downgrade', 'switch', 'import']) {
  test(`stopped never-published ${operationKind} uses the same retain-only rule`, async t => {
    const value = await fixture(t, { operationKind });
    assert.equal((await value.recover()).resolved, true);
    assert.equal((await value.registry.loadHistory(value.initial.jobId)).phase, 'failed');
    assert.deepEqual(value.calls, ['suspend', 'stop', 'auto']);
  });
}

for (const policy of [{ running: true, autoRestart: false }, { running: false, autoRestart: true }]) {
  test(`prior running=${policy.running} autoRestart=${policy.autoRestart} still requires normal source health`, async t => {
    const value = await fixture(t, { terminal: true, patch: { priorRuntime: policy }, runtimeConfig: {
      runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0', javaMajor: 17 },
      maxRam: 4, port: 25565, networkAccess: 'pack-default'
    } });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.deepEqual(value.calls, ['suspend', 'stop', 'config', 'health']);
  });
}

for (const swapStep of ['prepared', 'live-moved', 'candidate-published', 'rollback-restored']) {
  test(`terminal ${swapStep} cannot use stopped retain exception`, async t => {
    const value = await fixture(t, { terminal: true, patch: { swapStep } });
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(value.calls.includes('config'), true);
    assert.equal(value.calls.includes('auto'), false);
  });
}

test('between-renames terminal action keeps ordinary source validation', async t => {
  const value = await fixture(t, { terminal: true, outcome: { recovery: {
    action: 'between-renames-restored', operationId: 'job-stopped'
  } } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('config'), true);
});

test('unsettled same-boot writer blocks stopped retain before source context and remains quarantined', async t => {
  const value = await fixture(t, { terminal: true, candidate: true, authorizedCandidate: true });
  const marker = { schemaVersion: 1, jobId: value.initial.jobId, candidatePath: value.paths.candidatePath,
    candidateIdentity: value.candidate.directoryIdentity, bootSequence: 1, state: 'unproven' };
  const active = await value.registry.updateRuntimeWriterAuthority(value.initial.jobId, {
    expectedSequence: value.initial.sequence, authority: marker, failureCode: null
  });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, []);
  assert.equal(fs.existsSync(value.paths.candidatePath), true);
  await assert.rejects(value.coordinator.acquireStart(value.selector, { operation: 'ordinary-start', operationId: 'other', parentMutationLease: null }), { code: 'RECOVERY_REQUIRED' });
  await value.registry.updateRuntimeWriterAuthority(value.initial.jobId, { expectedSequence: active.sequence,
    authority: { ...marker, state: 'settled' }, failureCode: null });
  assert.equal((await value.recover()).resolved, true);
});

function restoreCreation() {
  return { schemaVersion: 1, kind: 'minecraft-core-lifecycle-restore-creation', operationId: 'job-stopped',
    name: 'restore-point-stopped.zip', partName: 'restore-point-stopped.zip.part',
    createdAt: '2026-10-09T00:00:00.000Z', sourceRevision: 4, scopeSha256: 'b'.repeat(64),
    backupDirectory: { existed: false, identity: null }, partIdentity: null,
    archiveSha256: null, archiveSize: null, metadataSha256: null, metadataIdentity: null, state: 'prepared' };
}

for (const cleanup of ['success', 'diagnostics', 'error']) {
  test(`initial stopped retain interrupted restore cleanup ${cleanup} gates full proof and failed transition`, async t => {
    let cleanups = 0;
    const restorePointService = {
      async cleanupInterruptedRestorePointCreation(request) {
        cleanups++;
        assert.equal(request.operationId, 'job-stopped');
        assert.deepEqual(request.creationIntent, restoreCreation());
        if (cleanup === 'error') throw new Error('restore cleanup transport failed');
        return { cleaned: 0, diagnostics: cleanup === 'diagnostics' ? [{ code: 'BACKUP_UNCERTAIN' }] : [] };
      },
      async verifyRestorePoint() { assert.fail('retention is not restore validation'); },
      async restoreToFreshCandidate() { assert.fail('retention must not reconstruct source'); }
    };
    const value = await fixture(t, { patch: { restoreCreation: restoreCreation() }, restorePointService,
      authority: (base, calls) => ({ ...base, async verifyOriginal(request) {
        assert.equal(cleanups, 1, 'full proof must follow restore cleanup');
        assert.equal((await value.registry.load(value.initial.jobId)).restoreCreation, null);
        calls.push('full-proof');
        return base.verifyOriginal(request);
      } }) });
    if (cleanup === 'success') {
      assert.equal((await value.recover()).resolved, true);
      const historical = await value.registry.loadHistory(value.initial.jobId);
      assert.equal(historical.restoreCreation, null);
      assert.deepEqual(value.calls, ['suspend', 'stop', 'full-proof', 'auto']);
    } else {
      await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
      const active = await value.registry.load(value.initial.jobId);
      assert.equal(active.phase, 'snapshotting');
      assert.deepEqual(active.restoreCreation, restoreCreation());
      assert.equal(active.outcome.recovery, undefined);
    }
  });
}

test('terminal stopped retain never drops unresolved restore creation', async t => {
  const value = await fixture(t, { terminal: true, patch: { restoreCreation: restoreCreation() } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, ['suspend']);
  assert.deepEqual((await value.registry.load(value.initial.jobId)).restoreCreation, restoreCreation());
});

test('stopped retain detects parent replacement during ensureStopped before source proof', async t => {
  const value = await fixture(t, { terminal: true, onStop: async c => {
    const parent = path.dirname(c.serverPath);
    fs.renameSync(parent, path.join(c.root, 'saved-parent'));
    fs.mkdirSync(parent);
    fs.renameSync(path.join(c.root, 'saved-parent', 'Alpha'), c.serverPath);
  } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
});

test('pre-swap none restores an authenticated original rollback sibling then retains stopped without boot', async t => {
  const value = await fixture(t);
  fs.renameSync(value.serverPath, value.paths.rollbackPath);
  assert.equal((await value.recover()).resolved, true);
  assert.equal(fs.existsSync(value.paths.rollbackPath), false);
  const inspection = await inspectServerDirectoryTree(value.serverPath, { reparseInspector: value.reparseInspector });
  assert.deepEqual(inspection.directoryIdentity, value.original.directoryIdentity);
  assert.equal(inspection.fingerprint, value.original.fingerprint);
  assert.equal(value.calls.includes('config'), false);
  assert.equal(value.calls.includes('health'), false);
  assert.equal((await value.registry.loadHistory(value.initial.jobId)).phase, 'failed');
});

test('restored original finish failure retries exact terminal outcome with changed bytes and no second rename', async t => {
  let renames = 0;
  const value = await fixture(t, { authority: base => ({ ...base, async renameExact(request) {
    renames++;
    return base.renameExact(request);
  } }) });
  fs.renameSync(value.serverPath, value.paths.rollbackPath);
  value.failHistory(true);
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  const restored = await value.registry.load(value.initial.jobId);
  assert.equal(restored.phase, 'failed');
  assert.deepEqual(restored.outcome.recovery, { action: 'pre-swap-restored', operationId: value.initial.jobId });
  assert.equal(renames, 1);
  fs.writeFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'current log after restored failed finish');
  value.failHistory(false);
  assert.equal((await value.recover()).resolved, true);
  assert.equal(renames, 1);
  assert.equal(value.calls.includes('config'), false);
  assert.deepEqual((await value.registry.loadHistory(value.initial.jobId)).outcome, restored.outcome);
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'logs', 'latest.log'), 'utf8'), 'current log after restored failed finish');
});

test('pre-swap none rollback original fingerprint mismatch never authorizes restoration rename', async t => {
  let renames = 0;
  const value = await fixture(t, { authority: base => ({ ...base, async renameExact(request) {
    renames++; return base.renameExact(request);
  } }) });
  fs.renameSync(value.serverPath, value.paths.rollbackPath);
  fs.writeFileSync(path.join(value.paths.rollbackPath, 'config', 'broken.toml'), 'changed before restoration');
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(renames, 0);
  assert.equal(fs.existsSync(value.serverPath), false);
  assert.equal((await value.registry.load(value.initial.jobId)).phase, 'snapshotting');
});

test('pre-swap none restores exact recorded rollback identity when original target slot is null', async t => {
  const value = await fixture(t, { identities: original => ({ target: null, rollback: original.directoryIdentity }) });
  fs.renameSync(value.serverPath, value.paths.rollbackPath);
  assert.equal((await value.recover()).resolved, true);
  assert.deepEqual((await value.registry.loadHistory(value.initial.jobId)).directoryIdentities.target, value.original.directoryIdentity);
  assert.equal(value.calls.includes('config'), false);
});

test('stopped reservation stays active through both authenticated registry history moves', async t => {
  let historyMoves = 0;
  const value = await fixture(t, { terminal: true, onHistory: async c => {
    historyMoves++;
    await assert.rejects(c.coordinator.acquireStart(c.selector, { operation: 'competing-start', operationId: 'other',
      parentMutationLease: c.parentLease }), { code: 'OPERATION_IN_PROGRESS' });
  } });
  await value.withLease(async lease => {
    value.parentLease = lease;
    assert.equal((await value.service.recoverWithLease(value.initial, lease)).resolved, true);
  });
  assert.equal(historyMoves, 2);
});

test('unknown legacy terminal candidate worker is first durably refused without candidate cleanup', async t => {
  const value = await fixture(t, { terminal: true, candidate: true, authorizedCandidate: true, legacyWriter: true });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, []);
  assert.equal(fs.readFileSync(path.join(value.paths.candidatePath, 'partial.txt'), 'utf8'), 'candidate-only');
  assert.equal((await value.registry.load(value.initial.jobId)).outcome.runtimeWriterAuthority.state, 'unproven');
});

test('stopped terminal reparse observation blocks the complete safe-tree proof', async t => {
  const value = await fixture(t, { terminal: true });
  value.reparseInspector.isReparsePoint = async candidate =>
    candidate.toLowerCase() === path.join(value.serverPath, 'config').toLowerCase();
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(value.calls.includes('auto'), false);
});

test('terminal candidate directory alias to canonical original is not deletion authority', async t => {
  const value = await fixture(t, { terminal: true, candidate: true, authorizedCandidate: true });
  fs.unlinkSync(path.join(value.paths.candidatePath, 'partial.txt'));
  fs.rmdirSync(value.paths.candidatePath);
  fs.symlinkSync(value.serverPath, value.paths.candidatePath, 'junction');
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(value.serverPath, 'config', 'broken.toml'), 'utf8'), 'malformed = [');
  assert.equal(value.calls.includes('auto'), false);
});

test('missing prior policy and missing terminal action cannot acquire retain authority', async t => {
  const value = await fixture(t, { terminal: true, outcome: { recovery: null } });
  await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(value.calls, ['suspend']);
  await assert.rejects(value.service.recover({ ...value.initial, priorRuntime: { running: false } }), { code: 'INVALID_REQUEST' });
  assert.ok(await value.registry.load(value.initial.jobId));
});

for (const failure of ['rename', 'stop']) {
  test(`pre-swap rollback-original ${failure} failure retains exact original without no-boot completion`, async t => {
    const value = await fixture(t, { ...(failure === 'stop' ? { stopResult: { stopped: false } } : {
      authority: base => ({ ...base, async renameExact() { throw new Error('rename transport failed'); } })
    }) });
    fs.renameSync(value.serverPath, value.paths.rollbackPath);
    await assert.rejects(value.recover(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(fs.existsSync(value.serverPath), false);
    assert.equal((await inspectServerDirectoryTree(value.paths.rollbackPath, { reparseInspector: value.reparseInspector })).fingerprint,
      value.original.fingerprint);
    assert.equal((await value.registry.load(value.initial.jobId)).phase, 'snapshotting');
    assert.equal(value.calls.includes('auto'), false);
  });
}
