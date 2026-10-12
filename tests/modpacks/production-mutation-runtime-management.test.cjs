const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fixtureAuthority, fixtureDurableFs, fixtureRegistry, fixtureRecovery,
  recordFixtureCandidate } = require('./runtime-authority-fixture.cjs');

const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');
const {
  ProductionMutationRuntime,
  scanCandidateManifest
} = require('../../electron/services/modpack-lifecycle/production-mutation-runtime.cjs');
const { validatePreparedRuntime } = require('../../electron/services/loader-install-service.cjs');
const { ServerHealthValidator } = require('../../electron/services/server-health-validator.cjs');
const {
  isAppIssuedForgeCandidateHealthAuthorization
} = require('../../electron/services/forge-candidate-health-authorization.cjs');

const CURRENT_RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0',
  javaMajor: 17, os: 'win32', architecture: 'x64'
});
const RESTORED_RUNTIME = Object.freeze({
  minecraftVersion: '1.19.2', loaderFamily: 'forge', loaderVersion: '43.4.0',
  javaMajor: 17, os: 'win32', architecture: 'x64'
});
const LATER_WORLD_BYTES = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0x2a]);

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function productionCandidateHealthValidator() {
  const nonce = 'rollback-runtime-ledger';
  return new ServerHealthValidator({
    chooseLoopbackPort: async () => 25591,
    coordinator: {
      async acquireStart() {
        return {
          assertOwnedPath(value) { return value; },
          markDirty() {},
          markRunning() {},
          release() {}
        };
      }
    },
    createNonce: () => nonce,
    pingStatus: async () => ({ description: `minecraft-core-health:${nonce}` }),
    processRunner: {
      launchServerProcess() {
        const pid = 4321;
        let live = true;
        let close;
        const closed = new Promise(resolve => { close = resolve; });
        return {
          pid,
          closed,
          isLive() { return live; },
          async ownsEndpoint() { return live; },
          async waitForReady() { return { pid, marker: 'Done' }; },
          async stopFully() {
            live = false;
            const evidence = { clean: true, closed: true, exitCode: 0, forced: false, signal: null };
            close(evidence);
            return evidence;
          }
        };
      }
    },
    resolveJavaPath: async ({ serverPath }) => path.join(serverPath, 'java.exe'),
    runWithLease: async (_lease, operation) => operation()
  });
}

function managementFixture(t, kind, {
  availableBytesValue = '100000000000',
  copySourceSnapshot = null,
  candidateWriteGate = null,
  healthValidator = null,
  includeArchivedState = false,
  inactive = false,
  onCandidateWriteAsync = null,
  priorRunning = false,
  rejectSyncCandidateWrite = false,
  rejectSyncHistoryWrite = false,
  releaseTrackingReconciler = null,
  restoreProgress = [],
  reviewedMinimumAvailableBytes = '1',
  safetyScopeSha256 = null,
  selectedRestoreTotalBytes = '5',
  snapshotDisk = null,
  revisionChain = {}
} = {}) {
  const currentStateRevision = revisionChain.currentStateRevision ?? 4;
  const currentCoordinatorRevision = revisionChain.currentCoordinatorRevision ?? currentStateRevision;
  const restoredRevision = revisionChain.restoredRevision ?? 2;
  const plannedSourceRevision = revisionChain.plannedSourceRevision ?? restoredRevision;
  const metadataSourceRevision = revisionChain.metadataSourceRevision ?? plannedSourceRevision;
  const archivedCoordinatorRevision = revisionChain.archivedCoordinatorRevision ?? metadataSourceRevision;
  const restoredHistoryTargetRevision = revisionChain.restoredHistoryTargetRevision ?? restoredRevision;
  const linkedSourceRevision = revisionChain.linkedSourceRevision ?? plannedSourceRevision;
  const linkedTargetRevision = revisionChain.linkedTargetRevision ?? currentStateRevision;
  const linkedRestoreSha256 = revisionChain.linkedRestoreSha256 ?? 'b'.repeat(64);
  const linkedOperationId = revisionChain.linkedOperationId ?? 'job-prior';
  const linkedRestoreTotalBytes = revisionChain.linkedRestoreTotalBytes ?? selectedRestoreTotalBytes;
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
      selectedOptionalFiles: [], installedAt: '2026-08-01T00:00:00.000Z', contentRevision: currentStateRevision,
      manifestId: currentManifest.installationId
    },
    manifest: currentManifest
  };
  const currentState = inactive
    ? {
        state: {
          schemaVersion: 1, modpackManaged: false, lifecycleMode: 'uninstalled', source: currentSource,
          runtime: null, selectedOptionalFiles: [], installedAt: '2026-08-01T00:00:00.000Z',
          contentRevision: currentStateRevision, manifestId: null,
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
      selectedOptionalFiles: [], installedAt: '2026-07-01T00:00:00.000Z', contentRevision: restoredRevision,
      manifestId: restoredManifest.installationId
    },
    manifest: restoredManifest
  };
  const selectedPublic = {
    id: 'restore-selected', sha256: 'b'.repeat(64), sourceRevision: plannedSourceRevision,
    runtime: RESTORED_RUNTIME, worldIncluded: true, totalBytes: selectedRestoreTotalBytes
  };
  const selectedPrivate = {
    ...selectedPublic,
    sourceRevision: metadataSourceRevision,
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
    kind, serverKind: 'existing', instanceId: 'server-managed', expectedContentRevision: currentCoordinatorRevision, downgrade: false
  };
  const restorePoints = kind === 'rollback-restore-point' ? [selectedPublic] : [];
  const pathPreconditions = [];
  const preconditions = {
    contentRevision: currentCoordinatorRevision,
    stateFingerprint: digest(currentState),
    pathPreconditions,
    pathPreconditionsFingerprint: digest(pathPreconditions),
    ownershipFingerprint: digest(ownership),
    restorePointsFingerprint: digest(restorePoints),
    operationFingerprint: digest(operation),
    minimumAvailableBytes: reviewedMinimumAvailableBytes
  };
  const planWithoutFingerprint = {
    type: 'modpack-management-plan', schemaVersion: 1, operation,
    source: { provider: 'github', repositoryId: 'repo-1', releaseId: 'release-2', githubOwner: 'Owner', githubRepo: 'Pack', version: 'v2' },
    runtime: kind === 'rollback-restore-point' ? RESTORED_RUNTIME : CURRENT_RUNTIME,
    ownership, restorePoints,
    disk: {
      candidateBytes: '1', restorePointBytes: '1', rollbackBytes: '1', journalBytes: '1', selectedBytes: '1',
      reserveBytes: '1', requiredBytes: reviewedMinimumAvailableBytes, availableBytes: '999999999999'
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
    reviewedServerDisk: {
      candidateBytes: '1', restorePointBytes: '1', rollbackBytes: '1', journalBytes: '1'
    },
    selectedRestorePoint: kind === 'rollback-restore-point' ? selectedPrivate : null,
    serverKind: 'existing', serverPath: targetPath, source: currentSource
  };
  const recoveryRegistry = fixtureRegistry(root);
  const authority = fixtureAuthority({ instanceId: 'server-managed', serverPath: targetPath,
    jobId: 'job-management', baseRevision: currentCoordinatorRevision, registry: recoveryRegistry });
  const durableFs = {
    flushDirectory() {},
    async flushDirectoryAsync() {},
    readFileBounded(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    async readFileBoundedAsync(filePath, options = {}) {
      if (options.allowMissing && !fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath);
    },
    renameDurable(source, destination) { fs.renameSync(source, destination); },
    async renameDurableAsync(source, destination) { fs.renameSync(source, destination); },
    sha256File() { return 'd'.repeat(64); },
    writeFileAtomic(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    async writeFileAtomicAsync(filePath, bytes) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, bytes); },
    writeJsonAtomic(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`); },
    async writeJsonAtomicAsync(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`); }
  };
  const safetyReference = {
    id: 'restore-safety', sha256: 'e'.repeat(64), serverPath: targetPath,
    name: 'restore-point-2026-08-02T00-00-00.000Z-00000000-0000-4000-8000-000000000017.zip',
    size: 123, totalBytes: '12', operationId: 'job-management',
    createdAt: '2026-08-02T00:00:00.000Z',
    sourceRevision: currentCoordinatorRevision, sourceRuntime: currentState.state.runtime,
    scopeSha256: safetyScopeSha256 ?? 'a'.repeat(64)
  };
  const restoreCalls = [];
  const writtenStates = [];
  const histories = [];
  const restoredHistory = [{
    schemaVersion: 1,
    operationId: 'job-installed-v1',
    sequence: 1,
    kind: 'install',
    outcome: 'completed',
    timestamp: '2026-07-01T00:00:00.000Z',
    sourceRevision: 0,
    targetRevision: restoredHistoryTargetRevision,
    targetRuntime: RESTORED_RUNTIME
  }];
  const linkedRestoreHistory = [{
    schemaVersion: 1,
    operationId: linkedOperationId,
    sequence: 2,
    kind: 'detach',
    outcome: 'completed',
    timestamp: '2026-07-02T00:00:00.000Z',
    sourceRevision: linkedSourceRevision,
    targetRevision: linkedTargetRevision,
    sourceRuntime: RESTORED_RUNTIME,
    targetRuntime: RESTORED_RUNTIME,
    restorePointId: 'restore-selected',
    restorePointSha256: linkedRestoreSha256,
    restorePointTotalBytes: linkedRestoreTotalBytes
  }];
  const trackingRemovals = [];
  const trackingUpserts = [];
  const recoveryCalls = [];
  const runtimePolicyRequests = [];
  const transactionCalls = [];
  const builtOperationKinds = [];
  const candidateHealthAuthorizations = [];
  let availableBytesCalls = 0;
  const stateRepository = {
    read(serverPath) {
      return path.resolve(serverPath) === path.resolve(targetPath) ? structuredClone(currentState) : structuredClone(restoredState);
    },
    writeCandidate(serverPath, state) {
      if (rejectSyncCandidateWrite) throw new Error('synchronous candidate state publication must not run');
      writtenStates.push({ serverPath, state: structuredClone(state) });
      return { state: { contentRevision: state.contentRevision } };
    },
    async writeCandidateAsync(serverPath, state) {
      onCandidateWriteAsync?.();
      if (candidateWriteGate) await candidateWriteGate;
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
    listHistory(serverPath) {
      const resolvedHistoryPath = path.resolve(serverPath);
      if (resolvedHistoryPath === path.resolve(targetPath)) {
        return { items: structuredClone(linkedRestoreHistory), nextCursor: null };
      }
      if (resolvedHistoryPath.endsWith(`${path.sep}selected-restore`)) {
        return { items: structuredClone(restoredHistory), nextCursor: null };
      }
      return { items: histories.map((entry, index) => ({ ...entry, sequence: index + 1 })), nextCursor: null };
    },
    appendHistory(_serverPath, entry) {
      if (rejectSyncHistoryWrite) throw new Error('synchronous history publication must not run');
      histories.push(structuredClone(entry));
    },
    async appendHistoryAsync(_serverPath, entry) { histories.push(structuredClone(entry)); }
  };
  const recoveryServices = {
    registry: recoveryRegistry,
    runtimeWriterAuthority: { async run(_jobId, work) { return work(); }, async assertRecoveryAllowed(record) { return record; } },
    runtimePolicy: {
        async suspend() { return { held: true }; }, async ensureStopped() { return { stopped: true }; },
        async adoptValidatedHandoff() { runtimePolicyRequests.push({ kind: 'adopt' }); return { adopted: true }; },
        async restoreAutoRestart(request) {
          runtimePolicyRequests.push({ kind: 'auto-restart', enabled: request.enabled });
          return { restored: true };
        }
      },
    ...(releaseTrackingReconciler ? { releaseTrackingReconciler } : {})
  };
  recoveryServices.recoveryService = fixtureRecovery({ authority, registry: recoveryRegistry,
    durableFs: fixtureDurableFs(root), runtimePolicy: recoveryServices.runtimePolicy,
    reparseInspector: { async isReparsePoint() { return false; } }, healthValidator: healthValidator || {
      async validateCandidate() {},
      async validateLive() { return { evidence: { ok: true } }; }
    }, onRecoverWithLease() { recoveryCalls.push('recover'); } });
  const runtime = new ProductionMutationRuntime({
    coordinator: authority.coordinator,
    availableBytes: async () => {
      availableBytesCalls += 1;
      return typeof availableBytesValue === 'function'
        ? availableBytesValue(availableBytesCalls)
        : availableBytesValue;
    },
    buildExistingCandidateFn: async context => {
      builtOperationKinds.push(context.operationKind);
      candidateHealthAuthorizations.push(context.forgeCandidateHealthAuthorization ?? null);
      context.planValidator(context.plan, context.currentSnapshot);
      if (copySourceSnapshot !== null) {
        assert.equal(typeof context.authorizeSourceSnapshot, 'function');
        await context.authorizeSourceSnapshot(structuredClone(copySourceSnapshot));
      }
      fs.mkdirSync(context.candidatePath, { recursive: true });
      await recordFixtureCandidate(recoveryRegistry, context);
      fs.mkdirSync(path.join(context.candidatePath, '.minecraft-core-state', 'operations', context.jobId), { recursive: true });
      fs.mkdirSync(path.join(context.candidatePath, '.minecraft-core-state', 'history'), { recursive: true });
      fs.writeFileSync(
        path.join(context.candidatePath, '.minecraft-core-state', 'operations', context.jobId, 'journal.json'),
        'current-operation-journal'
      );
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
      if (healthValidator) {
        await context.healthValidator.validateCandidate({
          candidatePath: context.candidatePath,
          jobId: context.jobId,
          maxRam: context.maxRam,
          mutationLease: context.mutationLease,
          runtime: context.runtime,
          signal: context.signal,
          timeoutMs: context.healthTimeoutMs
        });
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
    healthValidator: healthValidator || {
      async validateCandidate() {},
      async validateLive() { return { evidence: { ok: true } }; }
    },
    instanceResolver: { async resolveInstance(instanceId) { return { instanceId, serverPath: targetPath, priorRunning }; } },
    planningAdapter: {
      getExecutionRecord(received) { assert.equal(received, plan); return executionRecord; }
    },
    planValidator() { throw new Error('source preflight validator must not receive management plans'); },
    recoveryServices,
    releaseTrackingStore: {
      async list() { return [{ trackingId: 'tracking-old', serverId: 'server-managed' }]; },
      async remove(id) { trackingRemovals.push(id); return true; },
      async upsert(value) { trackingUpserts.push(structuredClone(value)); }
    },
    reparseInspector: { async isReparsePoint() { return false; } },
    restorePointServiceFactory: () => ({
      async prepareVerifiedRestorePointCreation(request) {
        return {
          schemaVersion: 1,
          kind: 'minecraft-core-lifecycle-restore-creation',
          operationId: request.operationId,
          name: safetyReference.name,
          partName: `${safetyReference.name}.part`,
          createdAt: safetyReference.createdAt,
          sourceRevision: request.sourceRevision,
          scopeSha256: safetyReference.scopeSha256,
          backupDirectory: { existed: true, identity: { dev: '1', ino: '2', birthtimeNs: '3' } },
          partIdentity: null,
          archiveSha256: null,
          archiveSize: null,
          metadataSha256: null,
          metadataIdentity: null,
          state: 'prepared'
        };
      },
      async createVerifiedRestorePoint(request, options) {
        assert.equal(recoveryRegistry.record.phase, 'snapshotting');
        assert.equal(recoveryRegistry.record.restoreCreation.state, 'prepared');
        restoreCalls.push({ kind: 'safety', request: structuredClone(request) });
        let state = {
          ...options.creationIntent,
          partIdentity: { dev: '1', ino: '4', birthtimeNs: '5' },
          state: 'writing'
        };
        await options.onCreationState(state);
        assert.equal(recoveryRegistry.record.restoreCreation.state, 'writing');
        state = {
          ...state,
          archiveSha256: safetyReference.sha256,
          archiveSize: safetyReference.size,
          metadataSha256: 'f'.repeat(64),
          state: 'verified'
        };
        await options.onCreationState(state);
        assert.equal(recoveryRegistry.record.restoreCreation.state, 'verified');
        state = { ...state, metadataIdentity: { dev: '1', ino: '6', birthtimeNs: '7' }, state: 'metadata-writing' };
        await options.onCreationState(state);
        assert.equal(recoveryRegistry.record.restoreCreation.state, 'metadata-writing');
        for (const nextState of ['metadata-staged', 'archive-published', 'published']) {
          state = { ...state, state: nextState };
          await options.onCreationState(state);
          assert.equal(recoveryRegistry.record.restoreCreation.state, nextState);
        }
        return safetyReference;
      },
      async restoreToOwnedCandidate(reference, destination, candidateRoot, options) {
        restoreCalls.push({ kind: 'selected', reference: structuredClone(reference), destination, candidateRoot });
        if (restoreProgress.length > 0) {
          assert.equal(typeof options?.onProgress, 'function');
          for (const value of restoreProgress) options.onProgress(structuredClone(value));
        }
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(
          path.join(destination, '.minecraft-core.json'),
          `${JSON.stringify({ contentRevision: archivedCoordinatorRevision })}\n`
        );
        fs.writeFileSync(path.join(destination, 'restored.txt'), 'restored');
        fs.writeFileSync(path.join(destination, 'run.bat'), '@echo off\r\n');
        fs.mkdirSync(path.join(destination, 'world', 'playerdata'), { recursive: true });
        fs.writeFileSync(path.join(destination, 'world', 'playerdata', 'later-created.dat'), LATER_WORLD_BYTES);
        fs.mkdirSync(path.join(destination, '.selected-restore'));
        fs.writeFileSync(path.join(destination, '.selected-restore', 'legitimate.txt'), 'legitimate-pack-content');
        if (kind === 'rollback-restore-point') {
          const argsRelativePath = 'libraries/net/minecraftforge/forge/1.19.2-43.4.0/win_args.txt';
          const argsPath = path.join(destination, ...argsRelativePath.split('/'));
          const argsBytes = Buffer.from('--launchTarget forge_server\n', 'utf8');
          fs.mkdirSync(path.dirname(argsPath), { recursive: true });
          fs.writeFileSync(argsPath, argsBytes);
          const restoredStateRoot = path.join(destination, '.minecraft-core-state');
          fs.mkdirSync(restoredStateRoot, { recursive: true });
          if (includeArchivedState) {
            fs.mkdirSync(path.join(restoredStateRoot, 'history'), { recursive: true });
            fs.mkdirSync(path.join(restoredStateRoot, 'operations', 'job-archived'), { recursive: true });
            fs.writeFileSync(path.join(restoredStateRoot, 'history', 'archived-operation.json'), '{"archived":true}\n');
            fs.writeFileSync(
              path.join(restoredStateRoot, 'operations', 'job-archived', 'journal.json'),
              '{"archived":true}\n'
            );
          }
          fs.writeFileSync(path.join(restoredStateRoot, 'runtime.json'), `${JSON.stringify({
            formatVersion: 1,
            runtime: RESTORED_RUNTIME,
            loader: { family: 'forge', argsFile: argsRelativePath },
            artifacts: [{
              relativePath: argsRelativePath,
              size: argsBytes.length,
              sha256: crypto.createHash('sha256').update(argsBytes).digest('hex'),
              sha512: crypto.createHash('sha512').update(argsBytes).digest('hex')
            }]
          }, null, 2)}\n`);
        }
        return { ok: true, destination };
      }
    }),
    snapshotServer: async () => ({
      liveSnapshot: { kind: 'existing', worldDirectories: ['world'], protectedPaths: [], entries: [] },
      pathPreconditions,
      candidateBytes: snapshotDisk?.candidateBytes ?? '1',
      restorePointBytes: snapshotDisk?.restorePointBytes ?? '1',
      rollbackBytes: snapshotDisk?.rollbackBytes ?? '1',
      journalBytes: snapshotDisk?.journalBytes ?? '1',
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
  async function revalidate() {
    await runtime.revalidate({
      jobId: 'job-management', plan,
      choices: { acceptEula: false, startAfterInstall: false, restorePointId: kind === 'rollback-restore-point' ? 'restore-selected' : null },
      selectedRestorePoint: kind === 'rollback-restore-point' ? selectedPublic : null,
      resolved, lease: authority.lease
    });
  }
  const context = {
    authority,
    get lease() { return authority.lease; },
    withLease(work) { return authority.run(() => work(context)); },
    availableBytesCalls: () => availableBytesCalls,
    builtOperationKinds, candidateHealthAuthorizations, histories, plan, revalidate, recoveryCalls, recoveryRegistry,
    resolved, restoreCalls, runtime,
    restoredState, runtimePolicyRequests, safetyReference, selectedPrivate, trackingRemovals, trackingUpserts,
    transactionCalls, writtenStates, targetPath
  };
  return context;
}

test('production issues Forge candidate health authorization only after the verified restore is published and recorded', async t => {
  await managementFixture(t, 'rollback-restore-point').withLease(async context => {
  const choices = {
    acceptEula: false,
    startAfterInstall: false,
    restorePointId: 'restore-selected'
  };
  await context.revalidate();

  await assert.rejects(
    context.runtime.buildCandidate({
      jobId: 'job-management',
      operationKind: 'rollback-restore-point',
      plan: context.plan,
      choices,
      restorePoint: null,
      resolved: context.resolved,
      lease: context.lease
    }),
    error => error?.code === 'PLAN_STALE'
  );
  assert.deepEqual(context.candidateHealthAuthorizations, []);

  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management',
    plan: context.plan,
    resolved: context.resolved
  });
  assert.equal(context.recoveryRegistry.record.restoreCreation.state, 'published');
  assert.deepEqual(context.recoveryRegistry.record.restorePoint, {
    id: safety.id,
    sha256: safety.sha256
  });

  const candidate = await context.runtime.buildCandidate({
    jobId: 'job-management',
    operationKind: 'rollback-restore-point',
    plan: context.plan,
    choices,
    restorePoint: safety,
    resolved: context.resolved,
    lease: context.lease
  });
  const authorization = context.candidateHealthAuthorizations[0];
  assert.equal(isAppIssuedForgeCandidateHealthAuthorization(authorization, {
    candidatePath: candidate.candidatePath,
    instanceId: context.resolved.instanceId,
    jobId: 'job-management',
    operationKind: 'rollback',
    restorePointId: safety.id,
    restorePointSha256: safety.sha256,
    runtime: context.plan.runtime,
    serverPath: context.targetPath,
    sourceRevision: context.plan.operation.expectedContentRevision
  }), true);
  });
});

test('detach creates a safety point and stages a full sibling transaction without removing server files', async t => {
  await managementFixture(t, 'detach').withLease(async context => {
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  assert.equal(context.recoveryRegistry.record.phase, 'snapshotting');
  assert.equal(context.recoveryRegistry.record.restoreCreation.state, 'published');
  assert.deepEqual(context.recoveryRegistry.record.restorePoint, {
    id: safety.id,
    sha256: safety.sha256
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
});

test('uninstall persists the exact reviewed confirmation as inactive state and does not double-write history', async t => {
  await managementFixture(t, 'uninstall').withLease(async context => {
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
});

test('rollback restores the privately pinned selected point and keeps the fresh safety backup separate', async t => {
  await managementFixture(t, 'rollback-restore-point', {
    revisionChain: {
      currentStateRevision: 7,
      currentCoordinatorRevision: 7,
      restoredRevision: 5,
      plannedSourceRevision: 5,
      metadataSourceRevision: 6,
      archivedCoordinatorRevision: 6,
      restoredHistoryTargetRevision: 5,
      linkedSourceRevision: 5,
      linkedTargetRevision: 7
    }
  }).withLease(async context => {
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
  assert.equal(context.plan.restorePoints[0].sourceRevision, 5);
  assert.equal(selected.reference.sourceRevision, 6);
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'restored.txt'), 'utf8'), 'restored');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'run.bat'), 'utf8'), '@echo off\r\n');
  assert.equal(fs.existsSync(path.join(candidate.candidatePath, 'live.txt')), false);
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, '.selected-restore', 'legitimate.txt'), 'utf8'),
    'legitimate-pack-content');
  assert.deepEqual(
    fs.readFileSync(path.join(candidate.candidatePath, 'world', 'playerdata', 'later-created.dat')),
    LATER_WORLD_BYTES
  );
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'backups', 'restore-point-prior.zip'), 'utf8'),
    'prior-backup');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, 'backups', 'operator-tool.exe'), 'utf8'),
    'opaque-backup-bytes');
  assert.equal(fs.readFileSync(path.join(candidate.candidatePath, '.minecraft-core-state', 'history', 'prior-operation.json'), 'utf8'),
    '{"prior":true}\n');
  assert.equal(fs.existsSync(selected.destination), false);
  assert.equal(
    fs.readFileSync(path.join(candidate.candidatePath, '.minecraft-core-state', 'operations', 'job-management', 'journal.json'), 'utf8'),
    'current-operation-journal'
  );
  const historicalState = structuredClone(context.restoredState.state);
  const historicalRevision = historicalState.contentRevision;
  delete historicalState.contentRevision;
  delete historicalState.manifestId;
  assert.equal(historicalRevision, 5);
  assert.deepEqual(context.writtenStates[0].state, {
    ...historicalState,
    contentRevision: 8,
    manifest: context.restoredState.manifest
  });
  assert.equal(
    context.writtenStates[0].state.manifest.entries.some(entry => entry.pathKey === 'world/playerdata/later-created.dat'),
    false
  );
  const nextManifest = await scanCandidateManifest({
    candidatePath: candidate.candidatePath,
    installationId: 'installed-v3',
    incomingManifest: { schemaVersion: 1, installationId: 'installed-v3', entries: [] },
    oldManifest: context.restoredState.manifest,
    ownershipPlan: {
      actions: [{ pathKey: 'world/playerdata/later-created.dat', action: 'preserve-user-addon' }]
    },
    reparseInspector: { async isReparsePoint() { return false; } }
  });
  const adoptedWorld = nextManifest.entries.find(entry => entry.pathKey === 'world/playerdata/later-created.dat');
  assert.deepEqual({
    origin: adoptedWorld.origin,
    managementPolicy: adoptedWorld.managementPolicy,
    role: adoptedWorld.role,
    installedHash: adoptedWorld.installedHash,
    size: adoptedWorld.size,
    priorBaseline: adoptedWorld.priorBaseline
  }, {
    origin: 'user',
    managementPolicy: 'protected',
    role: 'world',
    installedHash: crypto.createHash('sha256').update(LATER_WORLD_BYTES).digest('hex'),
    size: String(LATER_WORLD_BYTES.length),
    priorBaseline: null
  });
  assert.deepEqual(context.histories.map(entry => entry.kind), ['rollback']);
  assert.equal(context.histories[0].restorePointId, 'restore-safety');
  assert.notEqual(selected.reference.id, safety.id);
  });
});

test('management revalidation rejects fresh operation-specific disk growth before creating recovery state', async t => {
  await managementFixture(t, 'detach', {
    availableBytesValue: '3000000000',
    snapshotDisk: {
      candidateBytes: '5000000000', restorePointBytes: '1', rollbackBytes: '0', journalBytes: '1'
    }
  }).withLease(async context => {

  await assert.rejects(
    context.revalidate(),
    error => error?.code === 'PLAN_STALE' && error?.details?.field === 'availableBytes'
  );
  assert.equal(context.recoveryRegistry.record, null);
  });
});

test('management revalidation accepts current capacity when the fresh server footprint shrank after review', async t => {
  await managementFixture(t, 'detach', {
    availableBytesValue: '3000000000',
    reviewedMinimumAvailableBytes: '5000000000'
  }).withLease(async context => {

  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });

  assert.equal(context.recoveryRegistry.record?.phase, 'committing');
  });
});

test('existing candidate rechecks remaining capacity after the safety restore and before copying live bytes', async t => {
  const copySourceSnapshot = {
    directoryIdentity: { volumeSerial: 'volume-1', fileId: 'directory-1' },
    fingerprint: 'f'.repeat(64),
    totalBytes: '1',
    entries: [{
      path: 'late-sync.bin', pathKey: 'late-sync.bin', type: 'file', size: '1',
      sha256: 'a'.repeat(64), dev: '1', ino: '2', birthtime: '3'
    }]
  };
  await managementFixture(t, 'detach', {
    availableBytesValue: call => call === 1 ? '100000000000' : '2147483648',
    copySourceSnapshot
  }).withLease(async context => {

  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  await assert.rejects(context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  }), error => error?.code === 'PLAN_STALE' && error?.details?.field === 'availableBytes' &&
    error?.details?.requiredBytes === '2147483650' && error?.details?.availableBytes === '2147483648');

  assert.equal(context.availableBytesCalls(), 2);
  assert.equal(fs.existsSync(context.recoveryRegistry.record.candidatePath), false);
  });
});

test('existing candidate accepts the exact post-restore remaining-capacity boundary', async t => {
  const copySourceSnapshot = {
    directoryIdentity: { volumeSerial: 'volume-1', fileId: 'directory-1' },
    fingerprint: 'f'.repeat(64),
    totalBytes: '1',
    entries: [{
      path: 'late-sync.bin', pathKey: 'late-sync.bin', type: 'file', size: '1',
      sha256: 'a'.repeat(64), dev: '1', ino: '2', birthtime: '3'
    }]
  };
  await managementFixture(t, 'detach', {
    availableBytesValue: call => call === 1 ? '100000000000' : '2147483650',
    copySourceSnapshot
  }).withLease(async context => {

  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'detach', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: null },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });

  assert.equal(context.availableBytesCalls(), 2);
  assert.equal(context.recoveryRegistry.record.phase, 'committing');
  });
});

test('rollback revalidation recomputes capacity from the exact selected restore expanded bytes', async t => {
  await managementFixture(t, 'rollback-restore-point', {
    availableBytesValue: '3000000000',
    selectedRestoreTotalBytes: '2000000000'
  }).withLease(async context => {

  await assert.rejects(
    context.revalidate(),
    error => error?.code === 'PLAN_STALE' && error?.details?.field === 'availableBytes'
  );
  assert.equal(context.recoveryRegistry.record, null);
  });
});

test('rollback revalidation accepts the exact one-tree selected restore capacity boundary', async t => {
  await managementFixture(t, 'rollback-restore-point', {
    // Four bytes of fresh server work + one 2,000,000,000-byte selected tree +
    // the 2 GiB reserve. Promotion is a same-volume rename, not a second tree.
    availableBytesValue: '4147483652',
    selectedRestoreTotalBytes: '2000000000'
  }).withLease(async context => {

  await context.revalidate();

  assert.equal(context.recoveryRegistry.record?.phase, 'preflight');
  });
});

test('rollback rejects a live write that occurred after its safety restore and before candidate creation', async t => {
  const baselineScope = [{
    path: 'live.txt', type: 'file', size: 12,
    sha256: crypto.createHash('sha256').update('current-live').digest('hex')
  }];
  const copySourceSnapshot = {
    directoryIdentity: { volumeSerial: 'volume-1', fileId: 'directory-1' },
    fingerprint: 'f'.repeat(64),
    totalBytes: '12',
    entries: [{
      path: 'live.txt', pathKey: 'live.txt', type: 'file', size: '12',
      sha256: crypto.createHash('sha256').update('changed-live').digest('hex'),
      dev: '1', ino: '2', birthtime: '3'
    }]
  };
  await managementFixture(t, 'rollback-restore-point', {
    copySourceSnapshot,
    safetyScopeSha256: crypto.createHash('sha256').update(JSON.stringify(baselineScope)).digest('hex')
  }).withLease(async context => {

  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, resolved: context.resolved
  });
  fs.writeFileSync(path.join(context.targetPath, 'live.txt'), 'changed-live');
  await assert.rejects(context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'rollback-restore-point', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: 'restore-selected' },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  }), error => error?.code === 'PLAN_STALE');

  assert.equal(fs.readFileSync(path.join(context.targetPath, 'live.txt'), 'utf8'), 'changed-live');
  assert.equal(fs.existsSync(context.recoveryRegistry.record.candidatePath), false);
  });
});

test('rollback maps verified restore byte and file progress into the candidate lifecycle range', async t => {
  await managementFixture(t, 'rollback-restore-point', {
    restoreProgress: [
      { phase: 'source-verification', processedBytes: 50, totalBytes: 100, processedItems: 1, totalItems: 2 },
      { phase: 'archive-hash', processedBytes: 100, totalBytes: 100, processedItems: 0, totalItems: 2 },
      { phase: 'entry-verification', processedBytes: 50, totalBytes: 100, processedItems: 1, totalItems: 2 },
      { phase: 'extraction', processedBytes: 50, totalBytes: 100, processedItems: 1, totalItems: 2 },
      { phase: 'extraction', processedBytes: 100, totalBytes: 100, processedItems: 2, totalItems: 2 },
      { phase: 'output-verification', processedBytes: 100, totalBytes: 100, processedItems: 2, totalItems: 2 },
      { phase: 'complete', processedBytes: 100, totalBytes: 100, processedItems: 2, totalItems: 2 }
    ]
  }).withLease(async context => {
  const progress = [];
  const controller = new AbortController();
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, selectedRestorePoint: { id: 'restore-selected' },
    resolved: context.resolved
  });

  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'rollback-restore-point', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: 'restore-selected' },
    restorePoint: safety, resolved: context.resolved, lease: context.lease,
    signal: controller.signal,
    onProgress: async value => { progress.push(structuredClone(value)); }
  });

  assert.deepEqual(progress.map(value => value.percent), [43, 43, 44, 45, 48, 49, 49]);
  assert.match(progress.find(value => value.percent === 48).message, /2 of 2 files, 100 of 100 bytes/u);
  assert.equal(progress.at(-1).message, 'Verified server snapshot restored');
  });
});

test('rollback coalesces repeated restore progress by phase while a slow durable observer is active', async t => {
  const restoreProgress = [
    { phase: 'source-verification', processedBytes: 1, totalBytes: 100, processedItems: 0, totalItems: 4 },
    { phase: 'archive-hash', processedBytes: 20, totalBytes: 100, processedItems: 0, totalItems: 4 },
    { phase: 'entry-verification', processedBytes: 40, totalBytes: 100, processedItems: 1, totalItems: 4 },
    { phase: 'extraction', processedBytes: 60, totalBytes: 100, processedItems: 2, totalItems: 4 },
    { phase: 'extraction', processedBytes: 80, totalBytes: 100, processedItems: 3, totalItems: 4 },
    { phase: 'output-verification', processedBytes: 100, totalBytes: 100, processedItems: 4, totalItems: 4 },
    { phase: 'complete', processedBytes: 100, totalBytes: 100, processedItems: 4, totalItems: 4 }
  ];
  await managementFixture(t, 'rollback-restore-point', { restoreProgress }).withLease(async context => {
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, selectedRestorePoint: { id: 'restore-selected' },
    resolved: context.resolved
  });
  let releaseSlowProgress;
  const slowProgress = new Promise(resolve => { releaseSlowProgress = resolve; });
  let signalSlowProgress;
  const slowProgressEntered = new Promise(resolve => { signalSlowProgress = resolve; });
  const progress = [];

  const build = context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'rollback-restore-point', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: 'restore-selected' },
    restorePoint: safety, resolved: context.resolved, lease: context.lease,
    onProgress: async value => {
      progress.push(structuredClone(value));
      if (progress.length === 2) {
        signalSlowProgress();
        await slowProgress;
      }
    }
  });

  await slowProgressEntered;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(progress.length, 2, 'only one restore progress write may be active');
  releaseSlowProgress();
  await build;

  assert.deepEqual(progress.map(value => value.percent), [43, 43, 44, 45, 47, 49, 49]);
  assert.match(progress.find(value => value.percent === 47).message, /3 of 4 files, 80 of 100 bytes/u);
  assert.equal(progress.at(-1).message, 'Verified server snapshot restored');
  });
});

test('rollback candidate state publication awaits the asynchronous repository writer', async t => {
  let releaseWrite;
  let signalWriteStarted;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  t.after(() => releaseWrite());
  await managementFixture(t, 'rollback-restore-point', {
    candidateWriteGate: writeGate,
    onCandidateWriteAsync: () => signalWriteStarted(),
    rejectSyncCandidateWrite: true,
    rejectSyncHistoryWrite: true
  }).withLease(async context => {
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, selectedRestorePoint: { id: 'restore-selected' },
    resolved: context.resolved
  });
  const buildOutcome = context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'rollback-restore-point', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: 'restore-selected' },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  }).then(value => ({ status: 'resolved', value }), error => ({ status: 'rejected', error }));

  const first = await Promise.race([
    writeStarted.then(() => 'async-write-started'),
    buildOutcome.then(outcome => outcome.status)
  ]);
  assert.equal(first, 'async-write-started');
  assert.equal(await Promise.race([
    buildOutcome.then(outcome => outcome.status),
    new Promise(resolve => setImmediate(() => resolve('pending')))
  ]), 'pending');

  releaseWrite();
  const outcome = await buildOutcome;
  assert.equal(outcome.status, 'resolved', outcome.error?.stack);
  assert.equal(context.writtenStates.length, 1);
  });
});

test('rollback preserves only the verified runtime ledger needed by production candidate health', async t => {
  await managementFixture(t, 'rollback-restore-point', {
    healthValidator: productionCandidateHealthValidator(),
    includeArchivedState: true
  }).withLease(async context => {
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

  assert.equal(validatePreparedRuntime(candidate.candidatePath, RESTORED_RUNTIME).valid, true);
  assert.equal(fs.existsSync(path.join(
    candidate.candidatePath, '.minecraft-core-state', 'history', 'archived-operation.json'
  )), false);
  assert.equal(fs.existsSync(path.join(
    candidate.candidatePath, '.minecraft-core-state', 'operations', 'job-archived'
  )), false);
  assert.equal(fs.existsSync(path.join(
    candidate.candidatePath, '.minecraft-core-state', 'operations', 'job-management', 'journal.json'
  )), true);
  });
});

test('rollback accepts an older managed state when exact coordinator-domain history binds the selected snapshot', async t => {
  await managementFixture(t, 'rollback-restore-point', {
    revisionChain: {
      currentStateRevision: 10,
      currentCoordinatorRevision: 12,
      restoredRevision: 5,
      plannedSourceRevision: 9,
      metadataSourceRevision: 9,
      archivedCoordinatorRevision: 9,
      restoredHistoryTargetRevision: 5,
      linkedSourceRevision: 9,
      linkedTargetRevision: 10
    }
  }).withLease(async context => {
  await context.revalidate();
  const safety = await context.runtime.createRestorePoint({
    jobId: 'job-management', plan: context.plan, selectedRestorePoint: { id: 'restore-selected' },
    resolved: context.resolved
  });
  await context.runtime.buildCandidate({
    jobId: 'job-management', operationKind: 'rollback-restore-point', plan: context.plan,
    choices: { acceptEula: false, startAfterInstall: false, restorePointId: 'restore-selected' },
    restorePoint: safety, resolved: context.resolved, lease: context.lease
  });

  assert.equal(context.restoredState.state.contentRevision, 5);
  assert.equal(context.selectedPrivate.sourceRevision, 9);
  assert.equal(context.writtenStates[0].state.contentRevision, 13);
  assert.deepEqual(context.writtenStates[0].state.manifest, context.restoredState.manifest);
  });
});

test('rollback rejects revision chains that do not bind metadata, archive, history, and managed state', async t => {
  const baseline = {
    currentStateRevision: 7,
    currentCoordinatorRevision: 7,
    restoredRevision: 5,
    plannedSourceRevision: 5,
    metadataSourceRevision: 5,
    archivedCoordinatorRevision: 5,
    restoredHistoryTargetRevision: 5,
    linkedSourceRevision: 5,
    linkedTargetRevision: 7
  };
  const cases = [
    ['archived coordinator differs from restore metadata', { archivedCoordinatorRevision: 4 }],
    ['latest archived history differs from managed state', { restoredHistoryTargetRevision: 4 }],
    ['planned history source differs from managed state', { plannedSourceRevision: 4, linkedSourceRevision: 4 }],
    ['current history does not link the exact archive digest', { linkedRestoreSha256: 'c'.repeat(64) }],
    ['current history was written by a different operation', { linkedOperationId: 'job-substitute' }],
    ['current history records a different expanded byte count', { linkedRestoreTotalBytes: '6' }],
    ['restore metadata is not before its creating history target', { linkedTargetRevision: 5 }],
    ['latest completed current history differs from current state', { linkedTargetRevision: 6 }],
    ['malformed archived coordinator cannot masquerade as revision zero', {
      currentStateRevision: 2,
      currentCoordinatorRevision: 2,
      restoredRevision: 0,
      plannedSourceRevision: 0,
      metadataSourceRevision: 0,
      archivedCoordinatorRevision: 'not-a-revision',
      restoredHistoryTargetRevision: 0,
      linkedSourceRevision: 0,
      linkedTargetRevision: 1
    }],
    ['managed state is ahead of restore metadata', {
      restoredRevision: 6,
      plannedSourceRevision: 6,
      metadataSourceRevision: 5,
      archivedCoordinatorRevision: 5,
      restoredHistoryTargetRevision: 6,
      linkedSourceRevision: 6
    }]
  ];

  for (const [name, revisionChain] of cases) {
    await t.test(name, async st => {
      await managementFixture(st, 'rollback-restore-point', {
        revisionChain: { ...baseline, ...revisionChain }
      }).withLease(async context => {
      await context.revalidate();
      const safety = await context.runtime.createRestorePoint({
        jobId: 'job-management', plan: context.plan, selectedRestorePoint: { id: 'restore-selected' },
        resolved: context.resolved
      });
      await assert.rejects(context.runtime.buildCandidate({
        jobId: 'job-management', operationKind: 'rollback-restore-point', plan: context.plan,
        choices: { acceptEula: false, startAfterInstall: false, restorePointId: 'restore-selected' },
        restorePoint: safety, resolved: context.resolved, lease: context.lease
      }), error => error?.code === 'PLAN_STALE');
      });
    });
  }
});

test('rollback from inactive state creates a null-runtime safety point without substituting the selected target runtime', async t => {
  await managementFixture(t, 'rollback-restore-point', { inactive: true }).withLease(async context => {
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
});

test('a pre-swap prepared failure uses recovery cleanup instead of post-publication rollback', async t => {
  const context = managementFixture(t, 'detach');
  await context.withLease(async () => {
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
  assert.equal(await context.recoveryRegistry.load('job-management'), null);
  const history = await context.recoveryRegistry.loadHistory('job-management');
  assert.equal(history.phase, 'failed');
  assert.equal(history.outcome.recovery.action, 'pre-swap-restored');
  assert.equal(fs.existsSync(history.candidatePath), false);
  });
  const start = await context.authority.coordinator.acquireStart(context.authority.selector,
    { operation: 'ordinary-start', operationId: 'probe-start' });
  start.release();
  await context.authority.coordinator.runMutation(context.authority.selector,
    { operation: 'ordinary-write', operationId: 'probe-write', revisionMode: 'none' }, async () => {});
});

test('possible-non-runnable uninstall finalizes without health and keeps auto-restart disabled', async t => {
  await managementFixture(t, 'uninstall', { priorRunning: true }).withLease(async context => {
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
});

test('existing-server validation has no fallible intent persist after the transaction committed boundary', async t => {
  let persistCalls = 0;
  await managementFixture(t, 'detach', {
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
  }).withLease(async context => {
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
});
