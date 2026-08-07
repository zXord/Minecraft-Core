const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');
const { ProductionMutationRuntime } = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');

const CURRENT_RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0',
  javaMajor: 17, os: 'win32', architecture: 'x64'
});
const RESTORED_RUNTIME = Object.freeze({
  minecraftVersion: '1.19.2', loaderFamily: 'forge', loaderVersion: '43.4.0',
  javaMajor: 17, os: 'win32', architecture: 'x64'
});

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function registryDouble() {
  let record = null;
  return {
    get record() { return structuredClone(record); },
    async create(value) { record = structuredClone(value); return structuredClone(record); },
    async load() { return record && structuredClone(record); },
    async transition(jobId, request) {
      assert.equal(jobId, record.jobId);
      assert.equal(request.expectedPhase, record.phase);
      record = { ...record, ...structuredClone(request.patch), phase: request.nextPhase, sequence: record.sequence + 1 };
      return structuredClone(record);
    },
    async finish() { record = null; return null; }
  };
}

function managementFixture(t, kind, {
  inactive = false,
  priorRunning = false,
  releaseTrackingReconciler = null
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-production-management-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Managed Server');
  fs.mkdirSync(targetPath);
  fs.writeFileSync(path.join(targetPath, 'live.txt'), 'current-live');
  fs.mkdirSync(path.join(targetPath, 'backups'));
  fs.writeFileSync(path.join(targetPath, 'backups', 'restore-point-prior.zip'), 'prior-backup');
  fs.writeFileSync(path.join(targetPath, 'backups', 'operator-tool.exe'), 'opaque-backup-bytes');
  fs.mkdirSync(path.join(targetPath, '.minecraft-core-state', 'history'), { recursive: true });
  fs.writeFileSync(path.join(targetPath, '.minecraft-core-state', 'history', 'prior-operation.json'), '{"prior":true}\n');
  const currentSource = {
    provider: 'github', repositoryId: 'repo-1', releaseId: 'release-2', githubOwner: 'Owner', githubRepo: 'Pack',
    version: 'v2', title: 'Pack', selectedAssetIds: ['asset-server'], artifactSetDigest: 'a'.repeat(64)
  };
  const currentManifest = {
    schemaVersion: 1, installationId: 'installed-v2',
    entries: [{
      path: 'live.txt', pathKey: 'live.txt', type: 'file', installedHash: digest('current-live'), size: '12',
      origin: 'pack', managementPolicy: 'replaceable-managed', role: 'other', priorBaseline: null
    }]
  };
  const managedCurrentState = {
    state: {
      schemaVersion: 1, modpackManaged: true, source: currentSource, runtime: CURRENT_RUNTIME,
      selectedOptionalFiles: [], installedAt: '2026-08-01T00:00:00.000Z', contentRevision: 4,
      manifestId: currentManifest.installationId
    },
    manifest: currentManifest
  };
  const currentState = inactive
    ? {
        state: {
          schemaVersion: 1, modpackManaged: false, lifecycleMode: 'uninstalled', source: currentSource,
          runtime: null, selectedOptionalFiles: [], installedAt: '2026-08-01T00:00:00.000Z',
          contentRevision: 4, manifestId: null,
          provenance: { classification: 'uninstalled', inspectionFingerprint: 'f'.repeat(64) }
        },
        manifest: null
      }
    : managedCurrentState;
  const restoredManifest = {
    schemaVersion: 1, installationId: 'installed-v1',
    entries: [{
      path: 'restored.txt', pathKey: 'restored.txt', type: 'file', installedHash: digest('restored'), size: '8',
      origin: 'pack', managementPolicy: 'replaceable-managed', role: 'other', priorBaseline: null
    }]
  };
  const restoredState = {
    state: {
      schemaVersion: 1, modpackManaged: true,
      source: { ...currentSource, releaseId: 'release-1', version: 'v1' }, runtime: RESTORED_RUNTIME,
      selectedOptionalFiles: [], installedAt: '2026-07-01T00:00:00.000Z', contentRevision: 2,
      manifestId: restoredManifest.installationId
    },
    manifest: restoredManifest
  };
  const selectedPublic = {
    id: 'restore-selected', sha256: 'b'.repeat(64), sourceRevision: 2,
    runtime: RESTORED_RUNTIME, worldIncluded: true
  };
  const selectedPrivate = {
    ...selectedPublic,
    name: 'restore-point-selected.zip', size: 128, scopeSha256: 'c'.repeat(64),
    sourceRuntime: RESTORED_RUNTIME, operationId: 'job-prior', createdAt: '2026-07-01T00:00:00.000Z',
    serverPath: targetPath, archivePath: path.join(targetPath, 'backups', 'restore-point-selected.zip'),
    metadataPath: path.join(targetPath, 'backups', 'restore-point-selected.json'), pinId: 'job-prior'
  };
  const ownership = {
    type: 'ownership-plan', schemaVersion: 1, actions: [], added: [], changed: [], removed: [], preserved: [],
    conflicts: [], orphaned: [], userAddons: [], blocked: [],
    confirmation: {
      unchangedManagedRemovalCount: kind === 'uninstall' ? '1' : '0', preservedCategories: [],
      possibleNonRunnable: kind === 'uninstall', instanceRetained: true, worldsRetained: true
    },
    summary: { preservedCount: 1 }
  };
  const operation = {
    kind, serverKind: 'existing', instanceId: 'server-managed', expectedContentRevision: 4, downgrade: false
  };
  const restorePoints = kind === 'rollback-restore-point' ? [selectedPublic] : [];
  const pathPreconditions = [];
  const preconditions = {
    contentRevision: 4,
    stateFingerprint: digest(currentState),
    pathPreconditions,
    pathPreconditionsFingerprint: digest(pathPreconditions),
    ownershipFingerprint: digest(ownership),
    restorePointsFingerprint: digest(restorePoints),
    operationFingerprint: digest(operation),
    minimumAvailableBytes: '1'
  };
  const planWithoutFingerprint = {
    type: 'modpack-management-plan', schemaVersion: 1, operation,
    source: { provider: 'github', repositoryId: 'repo-1', releaseId: 'release-2', githubOwner: 'Owner', githubRepo: 'Pack', version: 'v2' },
    runtime: kind === 'rollback-restore-point' ? RESTORED_RUNTIME : CURRENT_RUNTIME,
    ownership, restorePoints,
    disk: {
      candidateBytes: '1', restorePointBytes: '1', rollbackBytes: '1', journalBytes: '1', selectedBytes: '1',
      reserveBytes: '1', requiredBytes: '1', availableBytes: '999999'
    },
    requirements: {
      verifiedRestorePointRequired: true, filesOnlySafetyConfirmed: false,
      missingProviderDigestAcknowledged: false, downgradeWorldRiskAcknowledged: false
    },
    preconditions
  };
  const plan = Object.freeze({
    ...planWithoutFingerprint,
    fingerprint: computePreflightPlanFingerprint(planWithoutFingerprint)
  });
  const executionRecord = {
    execution: { managementOutputId: 'management-output' }, operationKind: kind,
    selectedRestorePoint: kind === 'rollback-restore-point' ? selectedPrivate : null,
    serverKind: 'existing', serverPath: targetPath, source: currentSource
  };
  const recoveryRegistry = registryDouble();
  const durableFs = {
    flushDirectory() {},
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    sha256File() { return 'd'.repeat(64); },
    writeFileAtomic(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    writeJsonAtomic(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`); }
  };
  const safetyReference = {
    id: 'restore-safety', sha256: 'e'.repeat(64), serverPath: targetPath,
    sourceRevision: 4, sourceRuntime: currentState.state.runtime
  };
  const restoreCalls = [];
  const writtenStates = [];
  const histories = [];
  const trackingRemovals = [];
  const trackingUpserts = [];
  const recoveryCalls = [];
  const runtimePolicyRequests = [];
  const transactionCalls = [];
  const builtOperationKinds = [];
  const stateRepository = {
    read(serverPath) {
      return path.resolve(serverPath) === path.resolve(targetPath) ? structuredClone(currentState) : structuredClone(restoredState);
    },
    writeCandidate(serverPath, state) {
      writtenStates.push({ serverPath, state: structuredClone(state) });
      return { state: { contentRevision: state.contentRevision } };
    },
    detachCandidate(serverPath, operationValue) {
      writtenStates.push({ serverPath, detach: structuredClone(operationValue) });
      histories.push({
        kind: 'detach', operationId: operationValue.operationId,
        restorePointId: operationValue.restorePointId,
        restorePointSha256: operationValue.restorePointSha256
      });
      return { state: { contentRevision: operationValue.contentRevision, modpackManaged: false } };
    },
    uninstallCandidate(serverPath, operationValue) {
      writtenStates.push({ serverPath, uninstall: structuredClone(operationValue) });
      histories.push({ kind: 'uninstall', operationId: operationValue.operationId });
      return { state: { contentRevision: operationValue.contentRevision } };
    },
    recordFilesOnlyCandidate() { throw new Error('not a files-only import'); },
    listHistory() { return { items: histories.map((entry, index) => ({ ...entry, sequence: index + 1 })), nextCursor: null }; },
    appendHistory(_serverPath, entry) { histories.push(structuredClone(entry)); }
  };
  const runtime = new ProductionMutationRuntime({
    availableBytes: async () => '999999',
    buildExistingCandidateFn: async context => {
      builtOperationKinds.push(context.operationKind);
      context.planValidator(context.plan, context.currentSnapshot);
      fs.mkdirSync(context.candidatePath, { recursive: true });
      fs.mkdirSync(path.join(context.candidatePath, '.minecraft-core-state', 'operations', context.jobId), { recursive: true });
      fs.mkdirSync(path.join(context.candidatePath, '.minecraft-core-state', 'history'), { recursive: true });
      if (!context.freshCandidate) fs.writeFileSync(path.join(context.candidatePath, 'live.txt'), 'current-live');
      await context.applyIncoming({ candidatePath: context.candidatePath, jobId: context.jobId });
      if (context.persistCandidateState) {
        await context.persistCandidateState({
          candidatePath: context.candidatePath, candidateState: context.candidateState,
          jobId: context.jobId, stateRepository: context.stateRepository
        });
      } else {
        await context.stateRepository.writeCandidate(context.candidatePath, context.candidateState);
      }
      const record = await recoveryRegistry.load(context.jobId);
      await recoveryRegistry.transition(context.jobId, {
        expectedPhase: record.phase, nextPhase: 'committing', patch: { swapStep: 'prepared' }
      });
      return { candidatePath: context.candidatePath };
    },
    swapExistingCandidateFn: async context => {
      transactionCalls.push({ kind: 'swap', operationKind: context.operationKind });
      return { phase: 'starting' };
    },
    markCommittedHealthyFn: async context => {
      transactionCalls.push({
        kind: 'healthy', operationKind: context.operationKind,
        validateLive: context.validateLive !== false
      });
      return { phase: 'committed-healthy' };
    },
    clock: () => new Date('2026-08-02T00:00:00.000Z'),
    destinationReservations: { resolve() { return null; }, consume() { return true; }, release() { return true; } },
    durableFsFactory: () => durableFs,
    fsApi: fs,
    healthValidator: { async validateCandidate() {}, async validateLive() { return { evidence: { ok: true } }; } },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath: targetPath, priorRunning }; } },
    planningAdapter: {
      getExecutionRecord(received) { assert.equal(received, plan); return executionRecord; }
    },
    planValidator() { throw new Error('source preflight validator must not receive management plans'); },
    recoveryServices: {
      registry: recoveryRegistry,
      recoveryService: {
        async recoverWithLease() { recoveryCalls.push('recover'); return { resolved: true }; },
        async rollbackWithLease() { recoveryCalls.push('rollback'); return { resolved: true }; },
        async failNewWithLease() { recoveryCalls.push('fail-new'); return { resolved: true }; }
      },
      runtimePolicy: {
        async suspend() { return { held: true }; }, async ensureStopped() { return { stopped: true }; },
        async adoptValidatedHandoff() { runtimePolicyRequests.push({ kind: 'adopt' }); return { adopted: true }; },
        async restoreAutoRestart(request) {
          runtimePolicyRequests.push({ kind: 'auto-restart', enabled: request.enabled });
          return { restored: true };
        }
      },
      ...(releaseTrackingReconciler ? { releaseTrackingReconciler } : {})
    },
    releaseTrackingStore: {
      async list() { return [{ trackingId: 'tracking-old', serverId: 'server-managed' }]; },
      async remove(id) { trackingRemovals.push(id); return true; },
      async upsert(value) { trackingUpserts.push(structuredClone(value)); }
    },
    reparseInspector: { async isReparsePoint() { return false; } },
    restorePointServiceFactory: () => ({
      async createVerifiedRestorePoint(request) {
        restoreCalls.push({ kind: 'safety', request: structuredClone(request) });
        return safetyReference;
      },
      async restoreToOwnedCandidate(reference, destination, candidateRoot) {
        restoreCalls.push({ kind: 'selected', reference: structuredClone(reference), destination, candidateRoot });
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, 'restored.txt'), 'restored');
        fs.writeFileSync(path.join(destination, 'run.bat'), '@echo off\r\n');
        fs.mkdirSync(path.join(destination, '.selected-restore'));
        fs.writeFileSync(path.join(destination, '.selected-restore', 'legitimate.txt'), 'legitimate-pack-content');
        return { ok: true, destination };
      }
    }),
    snapshotServer: async () => ({
      liveSnapshot: { kind: 'existing', worldDirectories: ['world'], protectedPaths: [], entries: [] },
      pathPreconditions,
      candidateBytes: '1', restorePointBytes: '1', rollbackBytes: '1', journalBytes: '1',
      sourceRuntime: CURRENT_RUNTIME, restorePoints: [selectedPublic], writeable: true
    }),
    stateRepository,
    store: { get: key => key === 'instances' ? [] : null, set() {} },
    userDataPath: root,
    workspaceRegistry: {
      resolveOwnedWorkspace({ ownerId, id, kind: workspaceKind }) {
        assert.equal(ownerId, 'job-management');
        assert.equal(id, 'management-output');
        assert.equal(workspaceKind, 'output');
        return { id, kind: workspaceKind, path: path.join(root, 'management-authority') };
      }
    }
  });
  const resolved = { instanceId: 'server-managed', serverPath: targetPath, priorRunning };
  const lease = {
    kind: 'mutation', instanceId: 'server-managed', serverPath: targetPath, baseRevision: 4,
    markDirty() {}, assertOwnedPath(value) { return value; }
  };
  async function revalidate() {
    await runtime.revalidate({
      jobId: 'job-management', plan,
      choices: { acceptEula: false, startAfterInstall: false, restorePointId: kind === 'rollback-restore-point' ? 'restore-selected' : null },
      selectedRestorePoint: kind === 'rollback-restore-point' ? selectedPublic : null,
      resolved, lease
    });
  }
  return {
    builtOperationKinds, histories, lease, plan, revalidate, recoveryCalls, recoveryRegistry, resolved, restoreCalls, runtime,
    runtimePolicyRequests, safetyReference, selectedPrivate, trackingRemovals, trackingUpserts,
    transactionCalls, writtenStates, targetPath
  };
}

test('detach creates a safety point and stages a full sibling transaction without removing server files', async t => {
  const context = managementFixture(t, 'detach');
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  const staged = await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });
  await context.runtime.commitCandidate({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    resolved: context.resolved, lease: context.lease
  });
  await context.runtime.persistOutcome({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    restorePoint: safety, resolved: context.resolved
  });

  assert.ok(staged.candidatePath);
  assert.equal(context.restoreCalls[0].kind, 'safety');
  assert.equal(context.writtenStates[0].detach.contentRevision, 5);
  assert.equal(context.writtenStates[0].detach.restorePointId, 'restore-safety');
  assert.equal(fs.readFileSync(path.join(context.targetPath, 'live.txt'), 'utf8'), 'current-live');
  assert.equal(context.histories[0].kind, 'detach');
  assert.equal(context.histories[0].restorePointSha256, 'e'.repeat(64));
  assert.deepEqual(context.transactionCalls, [{ kind: 'swap', operationKind: 'detach' }]);
  assert.deepEqual(context.trackingRemovals, ['tracking-old']);
});

test('uninstall persists the exact reviewed confirmation as inactive state and does not double-write history', async t => {
  const context = managementFixture(t, 'uninstall');
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'uninstall-managed', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });
  await context.runtime.persistOutcome({
    jobId: 'job-management', operationKind: 'uninstall-managed', plan: context.plan,
    restorePoint: safety, resolved: context.resolved
  });

  assert.equal(context.writtenStates[0].uninstall.confirmation.unchangedManagedRemovalCount, '1');
  assert.deepEqual(context.builtOperationKinds, ['uninstall']);
  assert.equal(context.writtenStates[0].uninstall.restorePointId, 'restore-safety');
  assert.equal(context.writtenStates[0].uninstall.restorePointSha256, 'e'.repeat(64));
  assert.deepEqual(context.histories.map(entry => entry.kind), ['uninstall']);
  assert.deepEqual(context.trackingRemovals, ['tracking-old']);
});

test('rollback restores the privately pinned selected point and keeps the fresh safety backup separate', async t => {
  const context = managementFixture(t, 'rollback-restore-point');
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, selectedRestorePoint: { id: 'restore-selected' },
    resolved: context.resolved
  });
  const candidate = await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'rollback-restore-point', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: 'restore-selected' },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });

  assert.equal(safety.id, 'restore-safety');
  const selected = context.restoreCalls.find(call => call.kind === 'selected');
  assert.equal(selected.reference.id, 'restore-selected');
  assert.equal(selected.reference.sha256, 'b'.repeat(64));
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'restored.txt'), 'utf8'), 'restored');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'run.bat'), 'utf8'), '@echo off\r\n');
  assert.equal(fs.existsSync(path.join(candidate.candidatePath, 'live.txt')), false);
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, '.selected-restore', 'legitimate.txt'), 'utf8'),
    'legitimate-pack-content');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'backups', 'restore-point-prior.zip'), 'utf8'),
    'prior-backup');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'backups', 'operator-tool.exe'), 'utf8'),
    'opaque-backup-bytes');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, '.minecraft-core-state', 'history', 'prior-operation.json'), 'utf8'),
    '{"prior":true}\n');
  assert.equal(context.writtenStates[0].state.runtime.minecraftVersion, '1.19.2');
  assert.deepEqual(context.histories.map(entry => entry.kind), ['rollback']);
  assert.equal(context.histories[0].restorePointId, 'restore-safety');
  assert.notEqual(selected.reference.id, safety.id);
});

test('rollback from inactive state creates a null-runtime safety point without substituting the selected target runtime', async t => {
  const context = managementFixture(t, 'rollback-restore-point', { inactive: true });
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'rollback-restore-point', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: 'restore-selected' },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });

  assert.equal(context.restoreCalls[0].request.sourceRuntime, null);
  assert.equal(safety.sourceRuntime, null);
  assert.equal(context.recoveryRegistry.record.outcome.runtime.source, null);
  assert.equal(context.recoveryRegistry.record.outcome.runtime.target.minecraftVersion, '1.19.2');
  assert.equal(context.histories[0].sourceRuntime, undefined);
  assert.equal(context.histories[0].targetRuntime.minecraftVersion, '1.19.2');
});

test('a pre-swap prepared failure uses recovery cleanup instead of post-publication rollback', async t => {
  const context = managementFixture(t, 'detach');
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });
  await context.runtime.rollback({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved,
    lease: context.lease, error: new Error('pre-swap failure')
  });

  assert.deepEqual(context.recoveryCalls, ['recover']);
  assert.equal(fs.readFileSync(path.join(context.targetPath, 'live.txt'), 'utf8'), 'current-live');
});

test('possible-non-runnable uninstall finalizes without health and keeps auto-restart disabled', async t => {
  const context = managementFixture(t, 'uninstall', { priorRunning: true });
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'uninstall-managed', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });
  await context.runtime.validateLive({
    jobId: 'job-management', operationKind: 'uninstall-managed', plan: context.plan,
    resolved: context.resolved, running: false, lease: context.lease
  });
  const immutableToken = Object.freeze({
    newServer: false, enabled: true, operationId: 'job-management', serverPath: context.targetPath
  });
  await context.runtime.restorePriorState({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved, restartToken: immutableToken
  });

  assert.equal(context.recoveryRegistry.record.outcome.runtimePolicy.targetRunning, false);
  assert.equal(context.recoveryRegistry.record.outcome.runtimePolicy.targetAutoRestart, false);
  assert.deepEqual(context.transactionCalls.filter(call => call.kind === 'healthy'), [
    { kind: 'healthy', operationKind: 'uninstall', validateLive: false }
  ]);
  assert.deepEqual(context.runtimePolicyRequests, [{ kind: 'auto-restart', enabled: false }]);
});

test('existing-server validation has no fallible intent persist after the transaction committed boundary', async t => {
  let persistCalls = 0;
  const context = managementFixture(t, 'detach', {
    releaseTrackingReconciler: {
      createIntent({ serverId }) {
        return {
          schemaVersion: 1, action: 'remove', status: 'pending', serverId,
          trackingId: `tracking-${serverId}`
        };
      },
      async persistIntent() {
        persistCalls += 1;
        throw new Error('transient registry read failure after committed-healthy');
      },
      async reconcile() { throw new Error('not part of live validation'); }
    }
  });
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });

  const result = await context.runtime.validateLive({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    resolved: context.resolved, running: false, lease: context.lease
  });

  assert.deepEqual(result, { phase: 'committed-healthy' });
  assert.equal(persistCalls, 0);
  assert.deepEqual(context.transactionCalls.filter(call => call.kind === 'healthy'), [
    { kind: 'healthy', operationKind: 'detach', validateLive: true }
  ]);
});
