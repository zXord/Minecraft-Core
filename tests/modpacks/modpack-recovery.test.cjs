const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const {
  markUnprovenHealthProcess
} = require('../../electron/services/server-health-validator.cjs');

const TARGET = 'C:\\Minecraft\\Alpha';
const CANDIDATE = 'C:\\Minecraft\\.Alpha.minecraft-core.job-alpha.candidate';
const ROLLBACK = 'C:\\Minecraft\\.Alpha.minecraft-core.job-alpha.rollback';
const FAILED = 'C:\\Minecraft\\.Alpha.minecraft-core.job-alpha.failed';
const ORIGINAL_ID = Object.freeze({ volumeSerial: 'aa', fileId: '01' });
const CANDIDATE_ID = Object.freeze({ volumeSerial: 'aa', fileId: '02' });
const RESTORED_ID = Object.freeze({ volumeSerial: 'aa', fileId: '03' });
const ORIGINAL_FP = '1'.repeat(64);
const CANDIDATE_FP = '2'.repeat(64);
const RESTORED_FP = '3'.repeat(64);
const RUNTIME_SOURCE = Object.freeze({
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0', javaMajor: 17
});
const RUNTIME_TARGET = Object.freeze({
  minecraftVersion: '1.21.1', loaderFamily: 'neoforge', loaderVersion: '21.1.1', javaMajor: 21
});

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function recoveryError(message = 'recovery required') {
  return new ModpackError('RECOVERY_REQUIRED', message);
}

function retainedRecoveryHandoffDouble() {
  let live = true;
  let stopCalls = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const processHandle = {
    pid: 5252,
    closed,
    isLive() { return live; },
    async stopFully() {
      stopCalls += 1;
      live = false;
      const evidence = {
        clean: true,
        closed: true,
        exitCode: 0,
        forced: false,
        signal: null
      };
      resolveClosed(evidence);
      return evidence;
    }
  };
  return {
    handoff: { processHandle, startLease: { kind: 'start' } },
    isLive: () => live,
    stopCalls: () => stopCalls
  };
}

function record(overrides = {}) {
  const base = {
    schemaVersion: 1,
    sequence: 4,
    jobId: 'job-alpha',
    operationKind: 'upgrade',
    target: { kind: 'existing', stableServerId: 'alpha', path: TARGET },
    candidatePath: CANDIDATE,
    rollbackPath: ROLLBACK,
    failedPath: FAILED,
    restorePoint: { id: 'restore-alpha', sha256: 'a'.repeat(64) },
    journalPath: `${CANDIDATE}\\.minecraft-core-state\\operations\\job-alpha\\journal.json`,
    priorRuntime: { running: false, autoRestart: true },
    phase: 'committing',
    swapStep: 'prepared',
    directoryIdentities: {
      target: ORIGINAL_ID,
      candidate: CANDIDATE_ID,
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:01.000Z',
    outcome: {
      live: { fingerprint: ORIGINAL_FP },
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  };
  const next = { ...base, ...clone(overrides) };
  if (overrides.target) next.target = { ...base.target, ...clone(overrides.target) };
  if (overrides.directoryIdentities) {
    next.directoryIdentities = { ...base.directoryIdentities, ...clone(overrides.directoryIdentities) };
  }
  if (overrides.priorRuntime) next.priorRuntime = { ...base.priorRuntime, ...clone(overrides.priorRuntime) };
  if (overrides.outcome) next.outcome = { ...base.outcome, ...clone(overrides.outcome) };
  return next;
}

class FakeRegistry {
  constructor(initial) {
    this.current = clone(initial);
    this.transitions = [];
    this.finishes = [];
  }

  async load(jobId) {
    return this.current?.jobId === jobId ? clone(this.current) : null;
  }

  async transition(jobId, request) {
    assert.equal(jobId, this.current?.jobId);
    assert.equal(this.current.phase, request.expectedPhase);
    this.current = {
      ...this.current,
      ...clone(request.patch),
      phase: request.nextPhase,
      sequence: this.current.sequence + 1
    };
    this.transitions.push(clone(request));
    return clone(this.current);
  }

  async retryTerminalPublication(jobId, { expectedTarget, expectedOperationKind }) {
    const historical = this.finishes.at(-1)?.record;
    assert.equal(this.current, null);
    assert.equal(historical?.jobId, jobId);
    assert.deepEqual(historical.target, expectedTarget);
    assert.equal(historical.operationKind, expectedOperationKind);
    return { status: 'already-published', record: clone(historical) };
  }

  async clearRestoreCreationAfterCleanup(jobId, request) {
    assert.equal(jobId, this.current?.jobId);
    assert.equal(this.current.phase, request.expectedPhase);
    assert.deepEqual(this.current.restoreCreation, request.expectedCreation);
    this.current = { ...this.current, restoreCreation: null, restorePoint: null, sequence: this.current.sequence + 1 };
    return clone(this.current);
  }

  async finish(jobId, request) {
    assert.equal(jobId, this.current?.jobId || this.finishes.at(-1)?.jobId);
    if (!this.current) return clone(this.finishes.at(-1)?.record);
    const terminal = {
      ...this.current,
      phase: request.terminalPhase,
      outcome: clone(request.outcome),
      sequence: this.current.sequence + 1
    };
    this.finishes.push({ jobId, request: clone(request), record: terminal });
    this.current = null;
    return clone(terminal);
  }
}

class FakeDirectoryAuthority {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries).map(([key, value]) => [key, clone(value)]));
    this.calls = [];
    this.fail = new Set();
  }

  exists(directoryPath) {
    this.calls.push(`exists:${directoryPath}`);
    return this.entries.has(directoryPath);
  }

  async verifyOperationOwned({ directoryPath, directoryIdentity, fingerprint }) {
    this.calls.push(`verify-owned:${directoryPath}`);
    if (this.fail.has(`verify:${directoryPath}`)) throw recoveryError('verification failed');
    const value = this.entries.get(directoryPath);
    if (!value || value.kind !== 'owned' || value.journalValid === false ||
        JSON.stringify(value.identity) !== JSON.stringify(directoryIdentity) ||
        (fingerprint && value.fingerprint !== fingerprint)) throw recoveryError('owned identity mismatch');
    const evidence = clone(value);
    if (typeof value.journalPhase === 'string' && typeof value.journalStep === 'string') {
      evidence.journalRecord = {
        phase: value.journalPhase,
        swapStep: value.journalStep,
        targetIdentity: clone(value.journalTargetIdentity ?? null),
        rollbackIdentity: clone(value.journalRollbackIdentity ?? null),
        failedIdentity: clone(value.journalFailedIdentity ?? null)
      };
      evidence.locations = { journalPath: `${directoryPath}\\journal.json` };
      evidence.journal = {
        transition: (_journalPath, request) => {
          assert.equal(request.expectedPhase, value.journalPhase);
          value.journalPhase = request.nextPhase;
          value.journalStep = request.patch.swapStep ?? value.journalStep;
          if (Object.hasOwn(request.patch, 'targetIdentity')) {
            value.journalTargetIdentity = clone(request.patch.targetIdentity);
          }
          if (Object.hasOwn(request.patch, 'rollbackIdentity')) {
            value.journalRollbackIdentity = clone(request.patch.rollbackIdentity);
          }
          if (Object.hasOwn(request.patch, 'failedIdentity')) {
            value.journalFailedIdentity = clone(request.patch.failedIdentity);
          }
          this.calls.push(`journal:${request.nextPhase}:${value.journalStep}`);
          return { phase: value.journalPhase, swapStep: value.journalStep, ...clone(request.patch) };
        }
      };
    }
    return evidence;
  }

  async verifyOriginal({ directoryPath, directoryIdentity, fingerprint }) {
    this.calls.push(`verify-original:${directoryPath}`);
    if (this.fail.has(`verify:${directoryPath}`)) throw recoveryError('verification failed');
    const value = this.entries.get(directoryPath);
    if (!value || value.kind !== 'original' ||
        JSON.stringify(value.identity) !== JSON.stringify(directoryIdentity) ||
        (fingerprint && value.fingerprint !== fingerprint)) throw recoveryError('original identity mismatch');
    return clone(value);
  }

  async renameExact({ fromPath, toPath, directoryIdentity }) {
    this.calls.push(`rename:${fromPath}->${toPath}`);
    if (this.fail.has(`rename:${fromPath}`)) throw recoveryError('rename failed');
    if (this.entries.has(toPath)) throw recoveryError('destination occupied');
    const value = this.entries.get(fromPath);
    if (!value || JSON.stringify(value.identity) !== JSON.stringify(directoryIdentity)) throw recoveryError('rename identity mismatch');
    this.entries.delete(fromPath);
    this.entries.set(toPath, value);
  }

  async removeOperationOwned({ directoryPath, directoryIdentity, fingerprint, ownershipMode = 'operation-marker' }) {
    this.calls.push(`remove:${directoryPath}`);
    if (ownershipMode === 'recorded-identity') {
      const value = this.entries.get(directoryPath);
      if (!value || JSON.stringify(value.identity) !== JSON.stringify(directoryIdentity) ||
          value.fingerprint !== fingerprint) throw recoveryError('recorded identity mismatch');
    } else {
      await this.verifyOperationOwned({ directoryPath, directoryIdentity, fingerprint });
    }
    if (this.fail.has(`remove:${directoryPath}`)) throw recoveryError('remove failed');
    this.entries.delete(directoryPath);
  }

  async removeAuthorizedIdentity({ directoryPath, directoryIdentity }) {
    this.calls.push(`remove-authorized:${directoryPath}`);
    const value = this.entries.get(directoryPath);
    if (!value || JSON.stringify(value.identity) !== JSON.stringify(directoryIdentity)) {
      throw recoveryError('authorized identity mismatch');
    }
    if (this.fail.has(`remove:${directoryPath}`)) throw recoveryError('remove failed');
    this.entries.delete(directoryPath);
  }

  async inspectFresh({ directoryPath }) {
    this.calls.push(`inspect-fresh:${directoryPath}`);
    const value = this.entries.get(directoryPath);
    if (!value) throw recoveryError('fresh restore missing');
    return clone({
      directoryIdentity: value.identity,
      fingerprint: value.fingerprint,
      entryCount: value.entryCount ?? 0,
      totalBytes: value.totalBytes ?? '0'
    });
  }
}

function fixture(initialRecord, entries, options = {}) {
  const calls = [];
  const healthRequests = [];
  const revisionEvents = [];
  const registry = new FakeRegistry(initialRecord);
  const authority = new FakeDirectoryAuthority(entries);
  const runtimePolicy = options.runtimePolicy || {
    async suspend(request) { calls.push(`suspend:${request.jobId}`); return { held: true }; },
    async ensureStopped(request) { calls.push(`stop:${request.serverPath}`); return { stopped: true }; },
    async adoptValidatedHandoff(request) { calls.push(`adopt:${request.eventId}`); return { adopted: true }; },
    async restoreAutoRestart(request) { calls.push(`auto:${request.enabled}`); return { restored: true }; }
  };
  const healthValidator = options.healthValidator || {
    async validateLive(request) {
      healthRequests.push(request);
      calls.push(`health:${request.runtime.minecraftVersion}:${request.keepRunning}`);
      if (options.healthError) throw options.healthError;
      return {
        evidence: { ok: true },
        handoff: request.keepRunning ? { processHandle: {}, startLease: {} } : null
      };
    }
  };
  const stateRepository = options.stateRepository || {
    read(serverPath) {
      assert.equal(serverPath, TARGET);
      calls.push('state:read-canonical');
      return {
        state: {
          schemaVersion: 1,
          modpackManaged: true,
          source: {
            provider: 'github', repositoryId: 'repo-alpha', releaseId: 'release-alpha',
            githubOwner: 'Owner', githubRepo: 'Pack', version: 'v1.0.0', title: 'Alpha Pack',
            selectedAssetIds: ['asset-alpha'], artifactSetDigest: 'a'.repeat(64)
          },
          runtime: RUNTIME_TARGET,
          selectedOptionalFiles: [],
          installedAt: '2026-08-01T00:00:00.000Z',
          contentRevision: 7,
          manifestId: 'installation-alpha'
        },
        manifest: { schemaVersion: 1, installationId: 'installation-alpha', entries: [] }
      };
    }
  };
  const revisionPublisher = options.revisionPublisher || {
    async publishOnce(event) {
      const current = await registry.load(event.eventId.split(':')[1]);
      calls.push(`revision:${current?.phase}:${current?.outcome?.revisionEvent?.published}`);
      revisionEvents.push(clone(event));
      return { published: true, duplicate: current?.outcome?.revisionEvent?.published === true };
    }
  };
  const releaseTrackingReconciler = options.releaseTrackingReconciler || {
    createIntent({ serverId }) {
      return {
        schemaVersion: 1, action: 'upsert', status: 'pending', serverId,
        trackingId: `tracking-${serverId}`,
        record: { trackingId: `tracking-${serverId}`, serverId, provider: 'github' }
      };
    },
    async persistIntent(jobId, intent) {
      const current = await registry.load(jobId);
      if (current.outcome?.releaseTracking) return clone(current.outcome.releaseTracking);
      const updated = await registry.transition(jobId, {
        expectedPhase: current.phase,
        nextPhase: current.phase,
        patch: { outcome: { ...(current.outcome || {}), releaseTracking: clone(intent) } }
      });
      return clone(updated.outcome.releaseTracking);
    },
    async reconcile(jobId) {
      const current = await registry.load(jobId);
      assert.ok(current?.outcome?.releaseTracking);
      if (current.outcome.releaseTracking.status === 'applied') return clone(current.outcome.releaseTracking);
      const applied = { ...current.outcome.releaseTracking, status: 'applied' };
      await registry.transition(jobId, {
        expectedPhase: current.phase,
        nextPhase: current.phase,
        patch: { outcome: { ...current.outcome, releaseTracking: applied } }
      });
      calls.push('tracking:applied');
      return clone(applied);
    }
  };
  const transactionApi = {
    async verifyCommittedNewPublication(context) {
      calls.push('verify-committed-new-publication');
      const current = await registry.load(context.jobId);
      return authority.verifyOperationOwned({
        directoryPath: TARGET,
        directoryIdentity: current.directoryIdentities.target,
        fingerprint: null
      });
    },
    async verifyPublishedNewCandidate(context) {
      calls.push('verify-published-candidate');
      const current = await registry.load(context.jobId);
      const candidateHealth = current?.outcome?.candidate?.health;
      if (!candidateHealth) throw recoveryError('candidate health missing');
      await authority.verifyOperationOwned({
        directoryPath: TARGET,
        directoryIdentity: current.directoryIdentities.target,
        fingerprint: current.outcome?.publication?.candidateFingerprint || current.outcome?.candidate?.fingerprint
      });
      return {
        evidence: {
          ...clone(candidateHealth),
          publicationVerified: true,
          validationSource: 'sealed-candidate'
        },
        handoff: null
      };
    },
    async prepareNewLiveValidation(context) {
      calls.push('authorize-new-live');
      let current = await registry.load(context.jobId);
      if (current.phase === 'registering') {
        current = await registry.transition(context.jobId, {
          expectedPhase: 'registering',
          nextPhase: 'validating-live',
          patch: {
            outcome: {
              ...current.outcome,
              liveMutationAuthorized: true,
              liveValidation: { properties: { existed: false, sha256: null } }
            }
          }
        });
      }
      return { jobId: context.jobId, directoryIdentity: clone(current.directoryIdentities.target) };
    },
    async completeNewLiveValidation() {
      calls.push('complete-new-live');
      return { phase: 'validating-live', verified: true };
    },
    async verifyCommittedCanonicalDirectory(context) {
      calls.push('verify-committed-canonical');
      const current = await registry.load(context.jobId);
      return authority.verifyOperationOwned({
        directoryPath: TARGET,
        directoryIdentity: current.directoryIdentities.target,
        fingerprint: null
      });
    },
    async verifyMutableOperationOwnedDirectory(_context, directoryPath, directoryIdentity) {
      calls.push(`verify-mutable:${directoryPath}`);
      return authority.verifyOperationOwned({
        directoryPath,
        directoryIdentity,
        fingerprint: null
      });
    },
    async verifyMutableNewOperationOwnedDirectory(_context, directoryPath, directoryIdentity) {
      calls.push(`verify-mutable-new:${directoryPath}`);
      return authority.verifyOperationOwned({
        directoryPath,
        directoryIdentity,
        fingerprint: null
      });
    },
    async publishNewCandidate(context) {
      calls.push('publish-new');
      const current = await registry.load(context.jobId);
      if (authority.exists(CANDIDATE)) {
        await authority.renameExact({
          fromPath: CANDIDATE,
          toPath: TARGET,
          directoryIdentity: current.directoryIdentities.candidate
        });
      }
      await registry.transition(context.jobId, {
        expectedPhase: current.phase,
        nextPhase: 'published',
        patch: {
          swapStep: 'candidate-published',
          directoryIdentities: {
            ...current.directoryIdentities,
            target: current.directoryIdentities.candidate
          },
          outcome: {
            ...current.outcome,
            publication: {
              ...(current.outcome?.publication || {}),
              state: 'published',
              candidateFingerprint: current.outcome?.candidate?.fingerprint || CANDIDATE_FP
            }
          }
        }
      });
      return { phase: 'published' };
    },
    async registerPublishedInstance(context) {
      calls.push('register-new');
      const current = await registry.load(context.jobId);
      if (current.phase === 'published') {
        await registry.transition(context.jobId, {
          expectedPhase: 'published',
          nextPhase: 'registering',
          patch: {
            outcome: {
              ...current.outcome,
              registration: { instanceId: current.target.stableServerId, complete: true }
            }
          }
        });
      } else if (current.outcome?.registration?.complete !== true) {
        await registry.transition(context.jobId, {
          expectedPhase: 'registering',
          nextPhase: 'registering',
          patch: {
            outcome: {
              ...current.outcome,
              registration: { instanceId: current.target.stableServerId, complete: true }
            }
          }
        });
      }
      return { instanceId: current.target.stableServerId };
    },
    async markCommittedHealthy(context) {
      calls.push('mark-healthy');
      if (options.commitHealthError) throw options.commitHealthError;
      const current = await registry.load(context.jobId);
      if (current.phase !== 'committed-healthy') {
        await registry.transition(context.jobId, {
          expectedPhase: current.phase,
          nextPhase: 'committed-healthy',
          patch: {
            outcome: {
              ...current.outcome,
              revisionEvent: { eventId: `event:${current.jobId}`, published: true }
            }
          }
        });
      }
      return { phase: 'committed-healthy' };
    },
    async cleanupCommittedTransaction(context) {
      calls.push('cleanup-committed');
      const current = await registry.load(context.jobId);
      if (options.cleanupPending) {
        if (current.phase !== 'cleanup-pending') {
          await registry.transition(context.jobId, {
            expectedPhase: current.phase,
            nextPhase: 'cleanup-pending',
            patch: { outcome: { ...current.outcome, cleanup: { rollbackRemoved: false } } }
          });
        }
        return { phase: 'cleanup-pending', rollbackRemoved: false };
      }
      if (authority.exists(ROLLBACK)) authority.entries.delete(ROLLBACK);
      await registry.transition(context.jobId, {
        expectedPhase: current.phase,
        nextPhase: 'completed',
        patch: {
          swapStep: 'cleanup-complete',
          outcome: { ...current.outcome, cleanup: { rollbackRemoved: true } }
        }
      });
      return { phase: 'completed', rollbackRemoved: true };
    }
  };
  const coordinator = {
    assertMutationLease(lease, selector, operationId) {
      assert.equal(lease.operationId, operationId);
      assert.equal(lease.instanceId, selector.instanceId);
      assert.equal(lease.serverPath, selector.serverPath);
    },
    async runRecoveryMutation(selector, request, work) {
      calls.push(`lease:${request.operationId}:${selector.instanceId}`);
      return work(Object.freeze({
        kind: 'mutation',
        operation: 'modpack-recovery',
        operationId: request.operationId,
        instanceId: selector.instanceId,
        serverPath: selector.serverPath,
        assertOwnedPath: value => value,
        markDirty() { calls.push('lease:dirty'); }
      }));
    }
  };
  const contextFactory = async ({ record: current, mutationLease }) => ({
    targetPath: current.target.path,
    jobId: current.jobId,
    operationKind: current.operationKind,
    stableInstanceId: current.target.stableServerId,
    recoveryRegistry: registry,
    mutationLease,
    healthValidator,
    runtimePolicy,
    runtime: current.outcome?.runtime?.target?.runtime || RUNTIME_TARGET,
    maxRam: current.outcome?.runtime?.target?.maxRam || 8,
    port: current.outcome?.runtime?.target?.port || 25566,
    healthTimeoutMs: 30_000,
    name: 'Alpha Pack',
    async unregisterPublishedInstance(current) {
      calls.push(`unregister-new:${current.target.stableServerId}`);
      return { removed: true };
    },
    releaseTrackingReconciler,
    revisionPublisher,
    stateRepository
  });
  const restorePointService = options.restorePointService || {
    async cleanupInterruptedRestorePointCreation(request) {
      calls.push(`restore:cleanup:${request.operationId}`);
      authority.calls.push(`restore-cleanup:${request.operationId}`);
      return { cleaned: 0, diagnostics: [] };
    },
    async verifyRestorePoint(reference) { calls.push(`restore:verify:${reference.id}`); return { ok: true }; },
    async restoreToFreshCandidate(reference, destination) {
      calls.push(`restore:fresh:${reference.id}`);
      authority.entries.set(destination, { kind: 'original', identity: RESTORED_ID, fingerprint: RESTORED_FP });
      return { ok: true, destination };
    }
  };
  const restorePointResolver = options.restorePointResolver || (async current => ({
    id: current.restorePoint.id,
    sha256: current.restorePoint.sha256,
    serverPath: current.target.path
  }));
  return {
    authority,
    calls,
    coordinator,
    contextFactory,
    healthValidator,
    healthRequests,
    registry,
    revisionEvents,
    restorePointResolver,
    restorePointService,
    runtimePolicy,
    transactionApi
  };
}

function serviceFor(value) {
  const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
  return new ModpackRecoveryService({
    coordinator: value.coordinator,
    recoveryRegistry: value.registry,
    contextFactory: value.contextFactory,
    directoryAuthority: value.authority,
    runtimePolicy: value.runtimePolicy,
    runtimeWriterAuthority: value.runtimeWriterAuthority || { async assertRecoveryAllowed(record) { return record; } },
    restorePointResolver: value.restorePointResolver,
    restorePointService: value.restorePointService,
    consumeReservedTargetFn: value.consumeReservedTargetFn,
    transactionApi: value.transactionApi
  });
}

test('every recovery and cleanup route checks durable runtime writer authority before filesystem context', async () => {
  for (const method of ['recover', 'rollback', 'recoverNewPublication', 'recoverExistingSwap', 'retryCommittedCleanup',
    'recoverWithLease', 'rollbackWithLease', 'failNewWithLease']) {
    const initial = record(); const value = fixture(initial, {}); let admissions = 0; let contexts = 0;
    value.contextFactory = async () => { contexts++; throw new Error('must not inspect candidate'); };
    value.runtimeWriterAuthority = { async assertRecoveryAllowed(current) {
      admissions++; assert.equal(current.jobId, initial.jobId); throw recoveryError('unknown writer');
    } };
    const lease = { kind: 'mutation', instanceId: 'alpha', serverPath: TARGET, markDirty() {} };
    await assert.rejects(serviceFor(value)[method](initial, ...(method.endsWith('WithLease') ? [lease] : [])), { code: 'RECOVERY_REQUIRED' });
    assert.equal(admissions, 1, method); assert.equal(contexts, 0, method); assert.equal(value.authority.calls.length, 0, method);
  }
});

async function realFilesystemCandidateRecoveryFixture(t, label) {
  const {
    createExistingSiblingPaths
  } = require('../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
  const {
    identifyServerDirectory,
    inspectServerDirectoryTree
  } = require('../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
  const { ModpackRecoveryService } = require(
    '../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-core-recovery-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const servers = path.join(root, 'servers');
  const targetPath = path.join(servers, 'server');
  fs.mkdirSync(path.join(targetPath, 'world'), { recursive: true });
  fs.writeFileSync(path.join(targetPath, 'server.jar'), 'canonical-server');
  fs.writeFileSync(path.join(targetPath, 'world', 'level.dat'), 'canonical-world');

  const paths = createExistingSiblingPaths(targetPath, 'job-alpha');
  fs.mkdirSync(path.join(paths.candidatePath, 'config'), { recursive: true });
  fs.mkdirSync(path.join(
    paths.candidatePath,
    '.minecraft-core-state',
    'operations',
    'job-previous'
  ), { recursive: true });
  fs.writeFileSync(path.join(paths.candidatePath, 'config', 'partial.toml'), 'copied=true\n');
  fs.writeFileSync(path.join(
    paths.candidatePath,
    '.minecraft-core-state',
    'operations',
    'job-previous',
    'directory-marker.json'
  ), '{"copiedFromLive":true}\n');

  const noReparse = Object.freeze({ async isReparsePoint() { return false; } });
  let temporary = 0;
  const directoryFlushes = [];
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      flushDirectory(directoryPath) { directoryFlushes.push(path.resolve(directoryPath)); }
    },
    allowedRoots: [root],
    tempNameFactory: () => `recovery-${label}-${++temporary}`
  });
  const liveInspection = await inspectServerDirectoryTree(targetPath, {
    fsApi: fs,
    reparseInspector: noReparse
  });
  const candidateIdentity = await identifyServerDirectory(paths.candidatePath, {
    fsApi: fs,
    reparseInspector: noReparse
  });
  const initial = record({
    target: { kind: 'existing', stableServerId: 'alpha', path: targetPath },
    candidatePath: paths.candidatePath,
    rollbackPath: paths.rollbackPath,
    failedPath: paths.failedPath,
    journalPath: null,
    phase: 'staging',
    swapStep: 'none',
    directoryIdentities: {
      target: liveInspection.directoryIdentity,
      candidate: candidateIdentity,
      rollback: null,
      failed: null
    },
    outcome: {
      live: { fingerprint: liveInspection.fingerprint },
      candidate: null,
      rollback: null
    }
  });
  const registry = new FakeRegistry(initial);
  const runtimePolicy = {
    async suspend() { return { held: true }; },
    async ensureStopped() { return { stopped: true }; },
    async adoptValidatedHandoff() { return { adopted: true }; },
    async restoreAutoRestart() { return { restored: true }; }
  };
  const contextFactory = async ({ record: current, mutationLease }) => ({
    durableFs,
    fsApi: fs,
    healthTimeoutMs: 30_000,
    healthValidator: {
      async validateLive() { return { evidence: { ok: true }, handoff: null }; }
    },
    jobId: current.jobId,
    mutationLease,
    operationKind: current.operationKind,
    recoveryRegistry: registry,
    reparseInspector: noReparse,
    runtimePolicy,
    stableInstanceId: current.target.stableServerId,
    targetPath: current.target.path
  });
  const service = new ModpackRecoveryService({
    coordinator: {
      async runRecoveryMutation(_selector, _request, work) {
        return work({
          kind: 'mutation',
          instanceId: 'alpha',
          markDirty() { return true; },
          operationId: 'job-alpha',
          serverPath: targetPath
        });
      }
    },
    recoveryRegistry: registry,
    contextFactory,
    runtimePolicy,
    runtimeWriterAuthority: { async assertRecoveryAllowed(record) { return record; } }
  });
  const mutationLease = Object.freeze({
    kind: 'mutation',
    instanceId: 'alpha',
    markDirty() { return true; },
    serverPath: targetPath
  });
  return {
    candidateIdentity,
    directoryFlushes,
    initial,
    mutationLease,
    paths,
    registry,
    root,
    service,
    targetPath
  };
}

test('Windows parent death terminates its attached runtime worker before recovery cleanup', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const { fork } = require('node:child_process');
  const value = await realFilesystemCandidateRecoveryFixture(t, 'orphan-runtime');
  const marker = name => path.join(value.root, name);
  fs.writeFileSync(marker('java.exe'), 'fixture-java');
  const workerParent = fork(path.resolve(__dirname, '../fixtures/orphan-managed-runtime-worker.cjs'),
    ['parent', value.root, value.paths.candidatePath], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, execArgv: []
    });
  let parentDiagnostics = '';
  workerParent.stderr.on('data', data => { parentDiagnostics += data; });
  const parentClosed = new Promise(resolve => workerParent.once('close', resolve));
  const waitForMarker = async name => {
    const deadline = Date.now() + 12_000;
    while (!fs.existsSync(marker(name))) {
      if (Date.now() >= deadline) throw new Error(`Fixture marker not observed: ${name}; files=${fs.readdirSync(value.root)}; ${parentDiagnostics}; ${fs.existsSync(marker('parent-failed')) ? fs.readFileSync(marker('parent-failed'), 'utf8') : ''}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  let workerPid;
  const workerAlive = () => {
    try { process.kill(workerPid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  try {
    await waitForMarker('worker-writing-pending');
    workerPid = Number(fs.readFileSync(marker('worker-process'), 'utf8'));
    assert.equal(workerAlive(), true);
    workerParent.kill('SIGKILL');
    await parentClosed;
    const stopDeadline = Date.now() + 1000;
    while (workerAlive() && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(workerAlive(), false, 'attached Windows worker must not survive its parent');
    const recovered = await value.service.recoverWithLease(value.initial, value.mutationLease);
    assert.equal(recovered.resolved, true);
    assert.equal(fs.existsSync(value.paths.candidatePath), false);
    assert.equal(fs.readFileSync(path.join(value.targetPath, 'world', 'level.dat'), 'utf8'), 'canonical-world');
  } finally {
    fs.writeFileSync(marker('resume-worker'), 'resume');
    if (workerParent.exitCode === null && workerParent.signalCode === null) workerParent.kill('SIGKILL');
    await parentClosed;
    if (workerPid && workerAlive()) await waitForMarker('worker-exited');
  }
});

test('recoverAll skips every corrupt job even when its record is parseable', async () => {
  const first = record({ jobId: 'job-alpha', phase: 'queued', swapStep: 'none', candidatePath: null, rollbackPath: null, failedPath: null });
  const value = fixture(first, {});
  const service = serviceFor(value);
  let attempts = 0;
  service.recover = async () => { attempts += 1; return { jobId: 'job-alpha', resolved: true }; };

  const result = await service.recoverAll({
    records: [first],
    corrupt: [{ jobId: 'job-alpha' }],
    blocks: [{ jobId: 'job-alpha' }],
    globalBlock: false
  });

  assert.equal(attempts, 0);
  assert.deepEqual(result, { recovered: [], unresolved: ['job-alpha'] });
  assert.equal(Object.isFrozen(result), true);
});

test('lifecycle recovery reuses its owned mutation lease without reacquiring recovery coordination', async () => {
  const failure = {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  };
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    rollbackPath: null,
    restorePoint: null,
    phase: 'preflight',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    outcome: { failure }
  });
  const value = fixture(initial, {});
  const service = serviceFor(value);
  const lease = Object.freeze({
    kind: 'mutation',
    instanceId: 'alpha',
    serverPath: TARGET,
    markDirty() { return true; }
  });

  const result = await service.recoverWithLease(initial, lease);

  assert.equal(result.resolved, true);
  assert.equal(result.action, 'pre-publication-cleanup');
  assert.deepEqual(result.failure, failure);
  assert.deepEqual(value.registry.finishes[0].request.outcome.failure, failure);
  assert.equal(value.registry.current, null);
  assert.equal(value.calls.some(call => call.startsWith('suspend:') || call.startsWith('lease:')), false);
});

test('new publication failure cleans a proven candidate when the durable rename never occurred', async () => {
  for (const phase of ['publishing', 'rolling-back']) {
    const initial = record({
      operationKind: 'install',
      target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
      rollbackPath: null,
      phase,
      swapStep: phase === 'publishing' ? 'new-prepared' : 'candidate-published',
      directoryIdentities: { target: null, candidate: CANDIDATE_ID, rollback: null, failed: null },
      outcome: {
        candidate: { fingerprint: CANDIDATE_FP },
        publication: { state: 'publishing', candidateFingerprint: CANDIDATE_FP },
        ...(phase === 'rolling-back'
          ? { recovery: { action: 'new-health-failed', operationId: 'job-alpha' } }
          : {})
      }
    });
    const value = fixture(initial, {
      [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
    });
    const lease = Object.freeze({
      kind: 'mutation', instanceId: 'alpha', serverPath: TARGET, markDirty() { return true; }
    });

    const result = phase === 'publishing'
      ? await serviceFor(value).failNewWithLease(initial, lease, recoveryError('rename failed'))
      : await serviceFor(value).recoverWithLease(initial, lease);

    assert.equal(result.resolved, true, phase);
    assert.equal(result.action, 'pre-publication-cleanup', phase);
    assert.equal(value.authority.entries.has(CANDIDATE), false, phase);
    assert.equal(value.authority.entries.has(TARGET), false, phase);
    assert.equal(value.registry.finishes[0].request.terminalPhase, 'failed', phase);
  }
});

test('new publication failure persists and returns a closed durable diagnostic before candidate cleanup', async () => {
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    rollbackPath: null,
    phase: 'publishing',
    swapStep: 'new-prepared',
    directoryIdentities: { target: null, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'publishing', candidateFingerprint: CANDIDATE_FP }
    }
  });
  const value = fixture(initial, {
    [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  });
  const lease = Object.freeze({
    kind: 'mutation', instanceId: 'alpha', serverPath: TARGET, markDirty() { return true; }
  });
  const failure = new ModpackError('COMMIT_FAILED', 'The server could not be published', {
    cause: new Error('C:\\private\\candidate is locked')
  });
  Object.defineProperty(failure, 'durableFailureKind', { value: 'sharing-violation' });

  const result = await serviceFor(value).failNewWithLease(initial, lease, failure);

  const diagnostic = { stage: 'durable-move', category: 'sharing-violation' };
  assert.deepEqual(result.failure, diagnostic);
  assert.deepEqual(value.registry.finishes[0].request.outcome.failure, diagnostic);
  assert.deepEqual(value.registry.transitions[0].patch.outcome.failure, diagnostic);
  assert.equal(value.registry.transitions[0].expectedPhase, 'publishing');
  assert.equal(value.registry.transitions[0].nextPhase, 'publishing');
  assert.doesNotMatch(JSON.stringify(result), /private|candidate|locked|stack|errno/i);
});

test('new preflight recovery consumes only the exact recorded empty destination reservation before cleanup', async () => {
  const reservation = { kind: 'empty-directory', nonce: 'private-reservation-proof' };
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    rollbackPath: null,
    restorePoint: null,
    phase: 'preflight',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    outcome: { reservation }
  });
  const value = fixture(initial, { [TARGET]: { kind: 'reservation' } });
  const consumed = [];
  value.consumeReservedTargetFn = async request => {
    consumed.push(request);
    assert.equal(request.targetPath, TARGET);
    assert.deepEqual(request.reservation, reservation);
    assert.equal(request.mutationLease.kind, 'mutation');
    value.authority.entries.delete(TARGET);
    return { consumed: true };
  };
  const lease = Object.freeze({
    kind: 'mutation', instanceId: 'alpha', serverPath: TARGET, markDirty() { return true; }
  });

  const result = await serviceFor(value).recoverWithLease(initial, lease);

  assert.equal(result.resolved, true);
  assert.equal(consumed.length, 1);
  assert.equal(value.authority.entries.has(TARGET), false);
});

test('lifecycle recovery lease reuse rejects the wrong kind, instance, or canonical server path', async () => {
  const makeInitial = () => record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    rollbackPath: null,
    restorePoint: null,
    phase: 'preflight',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    outcome: null
  });
  const cases = [
    { kind: 'start', instanceId: 'alpha', serverPath: TARGET },
    { kind: 'mutation', instanceId: 'beta', serverPath: TARGET },
    { kind: 'mutation', instanceId: 'alpha', serverPath: 'C:\\Minecraft\\Other' }
  ];
  for (const leaseInput of cases) {
    const initial = makeInitial();
    const value = fixture(initial, {});
    const service = serviceFor(value);
    const lease = Object.freeze({ ...leaseInput, markDirty() { return true; } });
    await assert.rejects(
      service.recoverWithLease(initial, lease),
      error => error?.code === 'RECOVERY_REQUIRED'
    );
    assert.notEqual(value.registry.current, null);
    assert.deepEqual(value.calls, []);
  }
});

test('new pre-publication phases remove only a proven operation candidate and finish failed', async () => {
  const phases = ['queued', 'resolving', 'downloading', 'verifying', 'inspecting', 'planning', 'awaiting-user',
    'preflight', 'snapshotting', 'staging', 'validating-candidate', 'committing'];
  for (const phase of phases) {
    const initial = record({
      operationKind: 'install',
      target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
      phase,
      swapStep: 'none',
      rollbackPath: null,
      directoryIdentities: { target: null, candidate: phase === 'queued' ? null : CANDIDATE_ID, rollback: null, failed: null },
      outcome: phase === 'queued' ? null : { candidate: { fingerprint: CANDIDATE_FP } }
    });
    const entries = phase === 'queued' ? {} : {
      [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
    };
    const value = fixture(initial, entries);
    const result = await serviceFor(value).recover(initial);
    assert.equal(result.resolved, true, phase);
    assert.equal(value.registry.finishes[0].request.terminalPhase, 'failed', phase);
    assert.equal(value.authority.entries.has(CANDIDATE), false, phase);
    assert.equal(value.authority.entries.has(TARGET), false, phase);
  }
});

test('new candidate cleanup resumes by durable directory identity after partial deletion changes its fingerprint', async () => {
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'staging',
    swapStep: 'none',
    rollbackPath: null,
    directoryIdentities: { target: null, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: { candidate: { fingerprint: CANDIDATE_FP } }
  });
  const value = fixture(initial, {
    [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  });
  const service = serviceFor(value);
  value.authority.fail.add(`remove:${CANDIDATE}`);

  await assert.rejects(service.recover(initial), error => error?.code === 'RECOVERY_REQUIRED');
  const authorized = await value.registry.load(initial.jobId);
  assert.equal(authorized.phase, 'failed');
  assert.equal(authorized.outcome.candidateCleanup.deletionAuthorized, true);
  value.authority.entries.get(CANDIDATE).fingerprint = 'partial-tree-fingerprint';
  value.authority.entries.get(CANDIDATE).journalValid = false;
  value.authority.fail.delete(`remove:${CANDIDATE}`);

  const result = await service.recover(authorized);

  assert.equal(result.resolved, true);
  assert.equal(value.authority.entries.has(CANDIDATE), false);
  assert.equal(value.authority.calls.includes(`remove-authorized:${CANDIDATE}`), true);
});

function interruptedRestoreCreation() {
  return {
    schemaVersion: 1,
    kind: 'minecraft-core-lifecycle-restore-creation',
    operationId: 'job-alpha',
    name: 'restore-point-2026-08-01T00-00-00.000Z-00000000-0000-4000-8000-000000000017.zip',
    partName: 'restore-point-2026-08-01T00-00-00.000Z-00000000-0000-4000-8000-000000000017.zip.part',
    createdAt: '2026-08-01T00:00:00.000Z',
    sourceRevision: 4,
    scopeSha256: 'b'.repeat(64),
    backupDirectory: { existed: true, identity: { dev: '1', ino: '2', birthtimeNs: '3' } },
    partIdentity: { dev: '1', ino: '4', birthtimeNs: '5' },
    archiveSha256: null,
    archiveSize: null,
    metadataSha256: null,
    metadataIdentity: null,
    state: 'writing'
  };
}

test('existing snapshot recovery cleans an exact interrupted restore creation before verifying the original tree', async () => {
  const initial = record({
    schemaVersion: 2,
    phase: 'snapshotting',
    swapStep: 'none',
    restorePoint: null,
    restoreCreation: interruptedRestoreCreation(),
    journalPath: null,
    directoryIdentities: { target: ORIGINAL_ID, candidate: null, rollback: null, failed: null },
    outcome: {
      live: { fingerprint: ORIGINAL_FP },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  const cleanupIndex = value.authority.calls.indexOf('restore-cleanup:job-alpha');
  const verifyIndex = value.authority.calls.indexOf(`verify-original:${TARGET}`);
  assert.notEqual(cleanupIndex, -1);
  assert.notEqual(verifyIndex, -1);
  assert.ok(cleanupIndex < verifyIndex);
  assert.equal(value.registry.current, null);
});

test('existing staging recovery removes a partially copied candidate by its durably recorded identity', async () => {
  const initial = record({
    phase: 'staging',
    swapStep: 'none',
    journalPath: null,
    directoryIdentities: { target: ORIGINAL_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: { live: { fingerprint: ORIGINAL_FP }, candidate: null }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP },
    [CANDIDATE]: {
      kind: 'staging', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP, entryCount: 19, totalBytes: '4096'
    }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.authority.entries.has(CANDIDATE), false);
  assert.equal(value.authority.entries.has(TARGET), true);
  assert.equal(value.authority.calls.includes(`inspect-fresh:${CANDIDATE}`), true);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'failed');
});

test('existing pre-swap cleanup resumes a partially deleted candidate after publishing restored source authority', async () => {
  const initial = record({
    phase: 'staging',
    swapStep: 'none',
    journalPath: null,
    directoryIdentities: { target: ORIGINAL_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: { live: { fingerprint: ORIGINAL_FP }, candidate: { fingerprint: CANDIDATE_FP } }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP },
    [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  });
  const service = serviceFor(value);
  value.authority.fail.add(`remove:${CANDIDATE}`);

  await assert.rejects(service.recover(initial), error => error?.code === 'RECOVERY_REQUIRED');
  const restored = await value.registry.load(initial.jobId);
  assert.equal(restored.phase, 'failed');
  assert.equal(restored.outcome.recovery.action, 'pre-swap-restored');
  value.authority.entries.get(CANDIDATE).fingerprint = 'partial-tree-fingerprint';
  value.authority.entries.get(CANDIDATE).journalValid = false;
  value.authority.fail.delete(`remove:${CANDIDATE}`);

  const result = await service.recover(restored);

  assert.equal(result.resolved, true);
  assert.equal(value.authority.entries.has(CANDIDATE), false);
  assert.equal(value.authority.entries.get(TARGET).identity.fileId, ORIGINAL_ID.fileId);
});

test('pre-swap source boot can write the restored server and retry from durable terminal authority', async () => {
  const initial = record({
    phase: 'staging',
    swapStep: 'none',
    journalPath: null,
    directoryIdentities: { target: ORIGINAL_ID, candidate: null, rollback: null, failed: null },
    outcome: {
      live: { fingerprint: ORIGINAL_FP },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  let value;
  let healthAttempts = 0;
  const healthValidator = {
    async validateLive() {
      healthAttempts += 1;
      if (healthAttempts === 1) {
        value.authority.entries.get(TARGET).fingerprint = 'runtime-mutated-source';
        throw new ModpackError('HEALTH_CHECK_FAILED', 'injected source boot failure');
      }
      return { evidence: { ok: true }, handoff: null };
    }
  };
  value = fixture(initial, {
    [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  }, { healthValidator });
  const service = serviceFor(value);

  await assert.rejects(
    service.recover(initial),
    error => error?.code === 'RECOVERY_REQUIRED' && error?.cause?.code === 'HEALTH_CHECK_FAILED'
  );
  const terminal = await value.registry.load(initial.jobId);
  assert.equal(terminal.phase, 'failed');
  assert.equal(terminal.outcome.recovery.action, 'pre-swap-restored');

  const result = await service.recover(terminal);

  assert.equal(result.resolved, true);
  assert.equal(healthAttempts, 2);
});

test('staging recovery only adopts an unrecorded candidate when it is still empty', async () => {
  for (const entryCount of [0, 1]) {
    const initial = record({
      phase: 'staging',
      swapStep: 'none',
      journalPath: null,
      directoryIdentities: { target: ORIGINAL_ID, candidate: null, rollback: null, failed: null },
      outcome: { live: { fingerprint: ORIGINAL_FP }, candidate: null }
    });
    const value = fixture(initial, {
      [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP },
      [CANDIDATE]: {
        kind: 'staging', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP,
        entryCount, totalBytes: entryCount === 0 ? '0' : '1'
      }
    });

    if (entryCount === 0) {
      const result = await serviceFor(value).recover(initial);
      assert.equal(result.resolved, true);
      assert.equal(value.authority.entries.has(CANDIDATE), false);
    } else {
      await assert.rejects(serviceFor(value).recover(initial), error => error?.code === 'RECOVERY_REQUIRED');
      assert.equal(value.authority.entries.has(CANDIDATE), true);
      assert.equal(value.authority.calls.includes(`remove:${CANDIDATE}`), false);
    }
  }
});

test('default directory authority removes only the recorded markerless staging candidate', async (t) => {
  await t.test('removes a partially copied real directory without a current operation marker', async (subtest) => {
    const value = await realFilesystemCandidateRecoveryFixture(subtest, 'partial');
    const currentMarker = path.join(
      value.paths.candidatePath,
      '.minecraft-core-state',
      'operations',
      value.initial.jobId,
      'directory-marker.json'
    );
    const copiedMarker = path.join(
      value.paths.candidatePath,
      '.minecraft-core-state',
      'operations',
      'job-previous',
      'directory-marker.json'
    );
    assert.equal(fs.existsSync(currentMarker), false);
    assert.equal(fs.existsSync(copiedMarker), true);

    const result = await value.service.recoverWithLease(value.initial, value.mutationLease);

    assert.equal(result.resolved, true);
    assert.equal(result.action, 'pre-swap-restored');
    assert.equal(fs.existsSync(value.paths.candidatePath), false);
    assert.deepEqual(value.directoryFlushes, [path.resolve(path.dirname(value.paths.candidatePath))]);
    assert.equal(fs.readFileSync(path.join(value.targetPath, 'server.jar'), 'utf8'), 'canonical-server');
    assert.equal(fs.readFileSync(path.join(value.targetPath, 'world', 'level.dat'), 'utf8'), 'canonical-world');
    assert.equal(value.registry.current, null);
  });

  await t.test('rejects a directory substituted after its identity was recorded', async (subtest) => {
    const value = await realFilesystemCandidateRecoveryFixture(subtest, 'substitution');
    const displaced = path.join(value.root, 'recorded-candidate-object');
    fs.renameSync(value.paths.candidatePath, displaced);
    fs.mkdirSync(value.paths.candidatePath);
    fs.writeFileSync(path.join(value.paths.candidatePath, 'unrelated.txt'), 'must-survive');

    await assert.rejects(
      value.service.recoverWithLease(value.initial, value.mutationLease),
      error => error?.code === 'RECOVERY_REQUIRED'
    );

    assert.equal(fs.readFileSync(path.join(value.paths.candidatePath, 'unrelated.txt'), 'utf8'), 'must-survive');
    assert.equal(fs.existsSync(displaced), true);
    assert.notEqual(value.registry.current, null);
  });

  await t.test('rejects a hardlink inside the recorded candidate without deleting either name', async (subtest) => {
    const value = await realFilesystemCandidateRecoveryFixture(subtest, 'hardlink');
    const protectedPath = path.join(value.root, 'protected-hardlink-source.dat');
    const linkedPath = path.join(value.paths.candidatePath, 'linked-protected.dat');
    fs.writeFileSync(protectedPath, 'protected-hardlink-bytes');
    try {
      fs.linkSync(protectedPath, linkedPath);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        subtest.skip(`hardlinks are unavailable on this filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      value.service.recoverWithLease(value.initial, value.mutationLease),
      error => error?.code === 'RECOVERY_REQUIRED'
    );

    assert.equal(fs.readFileSync(protectedPath, 'utf8'), 'protected-hardlink-bytes');
    assert.equal(fs.readFileSync(linkedPath, 'utf8'), 'protected-hardlink-bytes');
    assert.notEqual(value.registry.current, null);
  });

  await t.test('rejects a directory link inside the recorded candidate when links are available', async (subtest) => {
    const value = await realFilesystemCandidateRecoveryFixture(subtest, 'directory-link');
    const protectedPath = path.join(value.root, 'protected-link-target');
    const linkedPath = path.join(value.paths.candidatePath, 'linked-protected-directory');
    fs.mkdirSync(protectedPath);
    fs.writeFileSync(path.join(protectedPath, 'must-survive.txt'), 'protected-link-bytes');
    try {
      fs.symlinkSync(protectedPath, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        subtest.skip(`directory links are unavailable on this filesystem: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      value.service.recoverWithLease(value.initial, value.mutationLease),
      error => error?.code === 'RECOVERY_REQUIRED'
    );

    assert.equal(fs.readFileSync(path.join(protectedPath, 'must-survive.txt'), 'utf8'), 'protected-link-bytes');
    assert.equal(fs.lstatSync(linkedPath).isSymbolicLink(), true);
    assert.notEqual(value.registry.current, null);
  });
});

test('new publication reconciles both sides of the durable rename and never accepts two canonicals', async () => {
  for (const afterRename of [false, true]) {
    const initial = record({
      operationKind: 'install',
      target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
      phase: 'publishing',
      swapStep: 'new-prepared',
      rollbackPath: null,
      directoryIdentities: { target: afterRename ? CANDIDATE_ID : null, candidate: CANDIDATE_ID, rollback: null, failed: null },
      outcome: {
        candidate: { fingerprint: CANDIDATE_FP },
        publication: { state: 'publishing', candidateFingerprint: CANDIDATE_FP }
      }
    });
    const owned = { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP };
    const value = fixture(initial, { [afterRename ? TARGET : CANDIDATE]: owned });
    const result = await serviceFor(value).recover(initial);
    assert.equal(result.resolved, true);
    assert.equal(value.registry.finishes[0].request.terminalPhase, 'completed');
    assert.equal(value.authority.entries.has(TARGET), true);
    assert.equal(value.authority.entries.has(CANDIDATE), false);
    assert.equal(value.calls.filter(item => item === 'register-new').length, 1);
  }

  const ambiguous = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'publishing',
    swapStep: 'new-prepared',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: { candidate: { fingerprint: CANDIDATE_FP }, publication: { candidateFingerprint: CANDIDATE_FP } }
  });
  const value = fixture(ambiguous, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
    [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  });
  await assert.rejects(serviceFor(value).recover(ambiguous), error => error.code === 'RECOVERY_REQUIRED');
  assert.equal(value.authority.calls.some(call => call.startsWith('rename:') || call.startsWith('remove:')), false);
  assert.equal(value.registry.finishes.length, 0);
});

test('publishing through registering new servers reconstruct and finish one durable committed outcome', async () => {
  for (const phase of ['publishing', 'published', 'registering']) {
    const initial = record({
      operationKind: 'install',
      target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
      phase,
      swapStep: phase === 'publishing' ? 'new-prepared' : 'candidate-published',
      rollbackPath: null,
      directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
      outcome: {
        candidate: { fingerprint: CANDIDATE_FP },
        publication: {
          state: phase === 'publishing' ? 'publishing' : 'published',
          candidateFingerprint: CANDIDATE_FP
        },
        ...(phase === 'registering' ? { registration: { instanceId: 'alpha', complete: false } } : {}),
        runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } },
        runtimePolicy: { targetRunning: false, targetAutoRestart: true, targetInactive: false }
      }
    });
    const value = fixture(initial, {
      [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
    });
    const service = serviceFor(value);
    const result = await service.recover(initial);
    assert.equal(result.resolved, true);
    assert.equal(value.calls.filter(item => item === 'register-new').length, 1);
    assert.ok(value.calls.indexOf('register-new') < value.calls.indexOf('authorize-new-live'));
    assert.ok(value.calls.indexOf('authorize-new-live') < value.calls.indexOf('health:1.21.1:false'));
    assert.ok(value.calls.indexOf('health:1.21.1:false') < value.calls.indexOf('complete-new-live'));
    assert.ok(value.calls.indexOf('complete-new-live') < value.calls.indexOf('revision:committed-healthy:false'));
    assert.ok(value.calls.indexOf('revision:committed-healthy:false') < value.calls.indexOf('tracking:applied'));
    assert.ok(value.calls.indexOf('tracking:applied') < value.calls.indexOf('auto:true'));
    assert.equal(value.registry.finishes.length, 1);
    assert.equal(value.registry.finishes[0].record.outcome.revisionEvent.published, true);
    assert.equal(value.registry.finishes[0].record.outcome.releaseTracking.status, 'applied');
    assert.equal(value.registry.finishes[0].record.outcome.health.ok, true);
    assert.deepEqual(value.revisionEvents, [{
      eventId: 'modpack-content-revision:job-alpha:7',
      instanceId: 'alpha',
      operationKind: 'install',
      targetRevision: 7
    }]);

    const repeated = await service.recover(initial);
    assert.deepEqual(repeated, { jobId: 'job-alpha', resolved: true, action: 'already-finished', historyPublication: 'already-published' });
    assert.equal(value.revisionEvents.length, 1);
  }
});

test('a concurrent replay that finds recovery already finished does not install a late auto-restart hold', async () => {
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'publishing',
    swapStep: 'new-prepared',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'publishing', candidateFingerprint: CANDIDATE_FP },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } },
      runtimePolicy: { targetRunning: false, targetAutoRestart: true, targetInactive: false }
    }
  });
  let releaseLateSuspend;
  const lateSuspend = new Promise(resolve => { releaseLateSuspend = resolve; });
  let held = false;
  let suspendCalls = 0;
  const runtimePolicy = {
    async suspend() {
      suspendCalls += 1;
      if (suspendCalls === 2) await lateSuspend;
      held = true;
      return { held: true };
    },
    async ensureStopped() { return { stopped: true }; },
    async adoptValidatedHandoff() { return { adopted: true }; },
    async restoreAutoRestart() {
      held = false;
      return { restored: true };
    }
  };
  const value = fixture(initial, {
    [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  }, { runtimePolicy });
  let mutationQueue = Promise.resolve();
  value.coordinator = {
    assertMutationLease: value.coordinator.assertMutationLease,
    runRecoveryMutation(selector, request, work) {
      const operation = mutationQueue.then(() => work(Object.freeze({
        kind: 'mutation',
        operation: 'modpack-recovery',
        operationId: request.operationId,
        instanceId: selector.instanceId,
        serverPath: selector.serverPath,
        assertOwnedPath: candidatePath => candidatePath,
        markDirty() {}
      })));
      mutationQueue = operation.then(() => undefined, () => undefined);
      return operation;
    }
  };
  const service = serviceFor(value);

  const first = service.recover(initial);
  const replay = service.recover(initial);
  assert.equal((await first).resolved, true);
  releaseLateSuspend();

  assert.deepEqual(await replay, { jobId: 'job-alpha', resolved: true, action: 'already-finished', historyPublication: 'already-published' });
  assert.equal(suspendCalls, 1);
  assert.equal(held, false);
});

test('committed new-server recovery retries an unpublished revision and pending tracking without registration', async () => {
  const reconciler = {};
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'committed-healthy',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } },
      runtimePolicy: { targetRunning: false, targetAutoRestart: true, targetInactive: false },
      health: { ok: true },
      revisionEvent: { eventId: 'modpack-content-revision:job-alpha:7', published: false },
      releaseTracking: {
        schemaVersion: 1, action: 'upsert', status: 'pending', serverId: 'alpha',
        trackingId: 'tracking-alpha',
        record: {
          trackingId: 'tracking-alpha', serverId: 'alpha', provider: 'github',
          nextDueAt: '2026-08-01T00:00:00.000Z'
        }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  }, {
    releaseTrackingReconciler: reconciler
  });
  reconciler.createIntent = ({ serverId }) => ({
    schemaVersion: 1, action: 'upsert', status: 'pending', serverId,
    trackingId: `tracking-${serverId}`,
    record: {
      trackingId: `tracking-${serverId}`, serverId, provider: 'github',
      nextDueAt: '2026-08-02T00:00:00.000Z'
    }
  });
  reconciler.persistIntent = async (_jobId, intent) => {
    assert.equal(intent.record.nextDueAt, '2026-08-01T00:00:00.000Z');
    return clone(intent);
  };
  reconciler.reconcile = async jobId => {
    const current = await value.registry.load(jobId);
    const applied = { ...current.outcome.releaseTracking, status: 'applied' };
    await value.registry.transition(jobId, {
      expectedPhase: current.phase,
      nextPhase: current.phase,
      patch: { outcome: { ...current.outcome, releaseTracking: applied } }
    });
    return applied;
  };

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.calls.includes('register-new'), false);
  assert.deepEqual(value.calls.filter(call => call.startsWith('revision:')), ['revision:committed-healthy:false']);
  assert.equal(value.registry.finishes[0].record.outcome.revisionEvent.published, true);
  assert.equal(value.registry.finishes[0].record.outcome.releaseTracking.status, 'applied');
});

test('files-only new recovery completes after a crash at the validating-live boundary without booting', async () => {
  const initial = record({
    operationKind: 'import',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'validating-live',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: true }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.calls.some(call => call.startsWith('health:')), false);
  assert.equal(value.calls.includes('register-new'), false);
  assert.equal(value.registry.finishes[0].record.phase, 'completed');
});

test('inactive boot-tested new recovery verifies the sealed publication without a second boot', async () => {
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'registering',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP, health: { kind: 'candidate', live: true } },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: false }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.calls.includes('verify-published-candidate'), true);
  assert.equal(value.calls.includes('authorize-new-live'), false);
  assert.equal(value.calls.some(call => call.startsWith('health:')), false);
  assert.equal(value.registry.finishes[0].record.outcome.health.validationSource, 'sealed-candidate');
});

test('new running recovery stops the exact retained handoff when adoption fails', async () => {
  const retained = retainedRecoveryHandoffDouble();
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'registering',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } },
      runtimePolicy: { targetRunning: true, targetAutoRestart: false, targetInactive: false }
    }
  });
  const runtimePolicy = {
    async suspend() { return { held: true }; },
    async ensureStopped() { return { stopped: true }; },
    async adoptValidatedHandoff() { throw new Error('injected recovery adoption failure'); },
    async restoreAutoRestart() { return { restored: true }; }
  };
  const healthValidator = {
    async validateLive() {
      return { evidence: { ok: true }, handoff: retained.handoff };
    }
  };
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  }, { healthValidator, runtimePolicy });

  await assert.rejects(
    serviceFor(value).recover(initial),
    error => error?.code === 'RECOVERY_REQUIRED'
  );

  assert.equal(retained.stopCalls(), 1);
  assert.equal(retained.isLive(), false);
});

test('new running recovery stops an adopted canonical when completion verification fails', async () => {
  const retained = retainedRecoveryHandoffDouble();
  let adopted = false;
  let stopAfterAdoption = 0;
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'registering',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } },
      runtimePolicy: { targetRunning: true, targetAutoRestart: false, targetInactive: false }
    }
  });
  const runtimePolicy = {
    async suspend() { return { held: true }; },
    async ensureStopped() {
      if (adopted) {
        stopAfterAdoption += 1;
        await retained.handoff.processHandle.stopFully();
        adopted = false;
      }
      return { stopped: true };
    },
    async adoptValidatedHandoff() {
      adopted = true;
      return { adopted: true };
    },
    async restoreAutoRestart() { return { restored: true }; }
  };
  const healthValidator = {
    async validateLive() {
      return { evidence: { ok: true }, handoff: retained.handoff };
    }
  };
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  }, { healthValidator, runtimePolicy });
  value.transactionApi.completeNewLiveValidation = async () => {
    throw recoveryError('injected completion verification failure');
  };

  await assert.rejects(
    serviceFor(value).recover(initial),
    error => error?.code === 'RECOVERY_REQUIRED'
  );

  assert.equal(stopAfterAdoption, 1);
  assert.equal(adopted, false);
  assert.equal(retained.isLive(), false);
  assert.equal(value.authority.entries.has(TARGET), true);
  assert.equal(value.authority.entries.has(FAILED), false);
});

test('committed inactive new recovery accepts post-commit history without re-booting or rechecking the sealed fingerprint', async () => {
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'committed-healthy',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP, health: { kind: 'candidate', live: true } },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      health: { kind: 'candidate', live: true, validationSource: 'sealed-candidate' },
      revisionEvent: {
        eventId: 'modpack-content-revision:job-alpha:7',
        published: true
      },
      releaseTracking: {
        schemaVersion: 1,
        action: 'upsert',
        status: 'applied',
        serverId: 'alpha',
        trackingId: 'tracking-alpha',
        record: { trackingId: 'tracking-alpha', serverId: 'alpha', provider: 'github' }
      },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: false }
    }
  });
  const value = fixture(initial, {
    // App-owned history is appended after the durable commit boundary, so the
    // canonical tree no longer has the sealed candidate fingerprint.
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: 'post-commit-history-fingerprint' }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.calls.includes('verify-committed-new-publication'), true);
  assert.equal(value.calls.includes('verify-published-candidate'), false);
  assert.equal(value.calls.includes('authorize-new-live'), false);
  assert.equal(value.calls.some(call => call.startsWith('health:')), false);
  assert.equal(value.registry.finishes[0].record.phase, 'completed');
});

test('completed inactive new recovery enforces stopped policy without another health boot', async () => {
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'completed',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      liveMutationAuthorized: true,
      liveValidation: { properties: { existed: false, sha256: null } },
      health: { ok: true, kind: 'live' },
      revisionEvent: { eventId: 'modpack-content-revision:job-alpha:7', published: true },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: false }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: 'post-health-runtime-state' }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.calls.includes(`verify-mutable-new:${TARGET}`), true);
  assert.equal(value.calls.includes(`stop:${TARGET}`), true);
  assert.equal(value.calls.includes('auto:false'), true);
  assert.equal(value.calls.some(call => call.startsWith('health:')), false);
});

test('new-server health failure quarantines a legitimately mutated authorized canonical', async () => {
  const healthError = new ModpackError('HEALTH_CHECK_FAILED', 'unhealthy');
  Object.defineProperty(healthError, 'candidateBootDiagnostic', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      stage: 'candidate-boot',
      boundary: 'readiness',
      category: 'mod-loading-failure'
    }),
    writable: false
  });
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'validating-live',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      liveMutationAuthorized: true,
      liveValidation: { properties: { existed: false, sha256: null } },
      runtime: {
        networkAccess: 'loopback',
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: 'mutated-by-server' }
  }, { healthError });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.authority.entries.has(TARGET), false);
  assert.equal(value.authority.entries.has(FAILED), true);
  assert.equal(value.calls.includes(`verify-mutable-new:${TARGET}`), true);
  assert.equal(value.calls.includes(`verify-mutable-new:${FAILED}`), true);
  assert.equal(value.healthRequests.length, 1);
  assert.equal(value.healthRequests[0].captureBootDiagnostic, true);
  assert.equal(value.healthRequests[0].networkAccess, 'loopback');
  assert.deepEqual(result.failure, {
    stage: 'candidate-boot',
    boundary: 'readiness',
    category: 'mod-loading-failure'
  });
  assert.deepEqual(value.registry.finishes[0].record.outcome.failure, result.failure);
});

test('post-publication filesystem failure is durable before new canonical quarantine', async () => {
  const healthError = new ModpackError('HEALTH_CHECK_FAILED', 'unhealthy');
  Object.defineProperty(healthError, 'durableFailureKind', {
    configurable: false,
    enumerable: false,
    value: 'sharing-violation',
    writable: false
  });
  Object.defineProperty(healthError, 'durableFailureStage', {
    configurable: false,
    enumerable: false,
    value: 'completion-flush',
    writable: false
  });
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'validating-live',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      liveMutationAuthorized: true,
      liveValidation: { properties: { existed: false, sha256: null } },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: 'mutated-by-server' }
  }, { healthError });

  const result = await serviceFor(value).recover(initial);

  const diagnostic = {
    stage: 'filesystem-operation',
    category: 'sharing-violation',
    boundary: 'completion-flush'
  };
  assert.deepEqual(result.failure, diagnostic);
  assert.deepEqual(value.registry.finishes[0].record.outcome.failure, diagnostic);
  assert.equal(value.registry.transitions[0].expectedPhase, 'validating-live');
  assert.equal(value.registry.transitions[0].nextPhase, 'validating-live');
  assert.deepEqual(value.registry.transitions[0].patch.outcome.failure, diagnostic);
  assert.equal(value.authority.entries.has(TARGET), false);
  assert.equal(value.authority.entries.has(FAILED), true);
});

test('new canonical recovery never quarantines while its exact health process has not proven close', async () => {
  const healthError = markUnprovenHealthProcess(
    new ModpackError('HEALTH_CHECK_FAILED', 'unclosed canonical health process')
  );
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'validating-live',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      registration: { instanceId: 'alpha', complete: true },
      liveMutationAuthorized: true,
      liveValidation: { properties: { existed: false, sha256: null } },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: 'mutated-by-server' }
  }, { healthError });

  await assert.rejects(
    serviceFor(value).recover(initial),
    error => error?.code === 'RECOVERY_REQUIRED'
  );

  assert.equal(value.authority.entries.has(TARGET), true);
  assert.equal(value.authority.entries.has(FAILED), false);
  assert.equal(value.authority.calls.some(call => call.startsWith('rename:')), false);
  assert.equal(value.calls.includes('unregister-new:alpha'), false);
});

test('failed new canonical health stops fully and moves only the matching target aside', async () => {
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    phase: 'published',
    swapStep: 'candidate-published',
    rollbackPath: null,
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: null, failed: null },
    outcome: {
      publication: { state: 'published', candidateFingerprint: CANDIDATE_FP },
      runtime: { target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 } }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  }, { healthError: new ModpackError('HEALTH_CHECK_FAILED', 'unhealthy') });

  const result = await serviceFor(value).recover(initial);
  assert.equal(result.resolved, true);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'failed');
  assert.equal(value.authority.entries.has(TARGET), false);
  assert.equal(value.authority.entries.has(FAILED), true);
  assert.ok(value.calls.indexOf(`stop:${TARGET}`) < value.authority.calls.indexOf(`rename:${TARGET}->${FAILED}`) ||
    value.calls.includes(`stop:${TARGET}`));
  assert.equal(value.calls.includes('register-new'), true);
  assert.equal(value.calls.includes('unregister-new:alpha'), true);
});

test('prepared and live-moved existing swaps recover both before and after each rename', async () => {
  const cases = [
    {
      name: 'prepared before first rename',
      phase: 'committing',
      step: 'prepared',
      entries: {
        [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP },
        [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
      }
    },
    {
      name: 'prepared after first rename',
      phase: 'committing',
      step: 'prepared',
      entries: {
        [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP },
        [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
      }
    },
    {
      name: 'live-moved before second rename',
      phase: 'committing',
      step: 'live-moved',
      entries: {
        [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP },
        [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
      }
    },
    {
      name: 'live-moved after second rename',
      phase: 'committing',
      step: 'live-moved',
      entries: {
        [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
        [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
      }
    }
  ];
  for (const item of cases) {
    const initial = record({
      phase: item.phase,
      swapStep: item.step,
      directoryIdentities: {
        target: item.entries[TARGET]?.identity || ORIGINAL_ID,
        candidate: CANDIDATE_ID,
        rollback: item.entries[ROLLBACK]?.identity || null,
        failed: null
      }
    });
    const value = fixture(initial, item.entries);
    const result = await serviceFor(value).recover(initial);
    assert.equal(result.resolved, true, item.name);
    assert.equal(value.registry.finishes[0].request.terminalPhase, item.step === 'live-moved' && item.entries[TARGET]
      ? 'rolled-back' : 'failed', item.name);
    assert.deepEqual(value.authority.entries.get(TARGET)?.identity, ORIGINAL_ID, item.name);
    assert.equal(value.authority.entries.has(CANDIDATE), false, item.name);
  }
});

test('candidate-published, validating-live, and every rolling-back step converge idempotently', async () => {
  const cases = [
    ['starting', 'candidate-published', {
      [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
      [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
    }],
    ['validating-live', 'candidate-published', {
      [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
      [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
    }],
    ['rolling-back', 'candidate-published', {
      [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
      [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
    }],
    ['rolling-back', 'failed-canonical-moved', {
      [FAILED]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
      [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
    }],
    ['rolling-back', 'failed-canonical-moved', {
      [FAILED]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
      [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
    }],
    ['rolling-back', 'rollback-restored', {
      [FAILED]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
      [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
    }]
  ];
  for (const [phase, swapStep, entries] of cases) {
    const initial = record({
      phase,
      swapStep,
      directoryIdentities: {
        target: swapStep === 'rollback-restored' ? ORIGINAL_ID : (entries[TARGET]?.kind === 'owned' ? CANDIDATE_ID : null),
        candidate: CANDIDATE_ID,
        rollback: ORIGINAL_ID,
        failed: entries[FAILED] ? CANDIDATE_ID : null
      }
    });
    const value = fixture(initial, entries, {
      commitHealthError: phase === 'rolling-back' ? undefined : new ModpackError('HEALTH_CHECK_FAILED', 'failed live')
    });
    const result = phase === 'rolling-back'
      ? await serviceFor(value).recover(initial)
      : await serviceFor(value).rollback(initial, 'startup-incomplete');
    assert.equal(result.resolved, true, `${phase}/${swapStep}`);
    assert.equal(value.registry.finishes[0].request.terminalPhase, 'rolled-back');
    assert.deepEqual(value.authority.entries.get(TARGET)?.identity, ORIGINAL_ID);
    assert.equal(value.authority.entries.has(ROLLBACK), false);
  }
});

test('rollback advances the operation journal with each durable filesystem topology', async () => {
  const initial = record({
    phase: 'rolling-back',
    swapStep: 'candidate-published',
    directoryIdentities: {
      target: CANDIDATE_ID,
      candidate: CANDIDATE_ID,
      rollback: ORIGINAL_ID,
      failed: null
    }
  });
  const value = fixture(initial, {
    [TARGET]: {
      kind: 'owned',
      identity: CANDIDATE_ID,
      fingerprint: CANDIDATE_FP,
      journalPhase: 'starting',
      journalStep: 'candidate-published'
    },
    [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.deepEqual(value.authority.calls.filter(item => item.startsWith('journal:')), [
    'journal:rolling-back:candidate-published',
    'journal:rolling-back:failed-canonical-moved',
    'journal:rolled-back:rollback-restored'
  ]);
  assert.equal(value.authority.entries.get(FAILED).journalPhase, 'rolled-back');
  assert.equal(value.authority.entries.get(FAILED).journalStep, 'rollback-restored');
});

test('rollback reconciles a journal-ahead failed-canonical rename split', async () => {
  const initial = record({
    phase: 'rolling-back',
    swapStep: 'candidate-published',
    directoryIdentities: {
      target: CANDIDATE_ID,
      candidate: CANDIDATE_ID,
      rollback: ORIGINAL_ID,
      failed: null
    },
    outcome: { liveMutationAuthorized: true }
  });
  const value = fixture(initial, {
    [FAILED]: {
      kind: 'owned',
      identity: CANDIDATE_ID,
      fingerprint: '9'.repeat(64),
      journalPhase: 'rolling-back',
      journalStep: 'failed-canonical-moved',
      journalTargetIdentity: null,
      journalRollbackIdentity: ORIGINAL_ID,
      journalFailedIdentity: CANDIDATE_ID
    },
    [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'rolled-back');
  assert.equal(value.authority.calls.includes(`rename:${TARGET}->${FAILED}`), false);
  assert.equal(value.authority.entries.get(TARGET).kind, 'original');
  assert.equal(value.authority.entries.get(FAILED).journalStep, 'rollback-restored');
});

test('rollback reconciles a journal-ahead restored-original split', async () => {
  const initial = record({
    phase: 'rolling-back',
    swapStep: 'failed-canonical-moved',
    directoryIdentities: {
      target: null,
      candidate: CANDIDATE_ID,
      rollback: ORIGINAL_ID,
      failed: CANDIDATE_ID
    },
    outcome: { liveMutationAuthorized: true }
  });
  const value = fixture(initial, {
    [FAILED]: {
      kind: 'owned',
      identity: CANDIDATE_ID,
      fingerprint: '9'.repeat(64),
      journalPhase: 'rolled-back',
      journalStep: 'rollback-restored',
      journalTargetIdentity: ORIGINAL_ID,
      journalRollbackIdentity: ORIGINAL_ID,
      journalFailedIdentity: CANDIDATE_ID
    },
    [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'rolled-back');
  assert.equal(value.authority.calls.includes(`rename:${ROLLBACK}->${TARGET}`), false);
  assert.equal(value.authority.entries.get(TARGET).kind, 'original');
  assert.equal(value.authority.entries.get(FAILED).journalStep, 'rollback-restored');
});

test('active terminal rolled-back record is verified and republished after a history-move failure', async () => {
  const initial = record({
    phase: 'rolled-back',
    swapStep: 'rollback-restored',
    directoryIdentities: {
      target: ORIGINAL_ID,
      candidate: CANDIDATE_ID,
      rollback: ORIGINAL_ID,
      failed: CANDIDATE_ID
    },
    outcome: {
      liveMutationAuthorized: true,
      recovery: {
        action: 'rollback-restored',
        operationId: 'job-alpha',
        reason: 'live-health-failed'
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: '7'.repeat(64) },
    [FAILED]: {
      kind: 'owned',
      identity: CANDIDATE_ID,
      fingerprint: '9'.repeat(64),
      journalPhase: 'rolled-back',
      journalStep: 'rollback-restored',
      journalTargetIdentity: ORIGINAL_ID,
      journalRollbackIdentity: ORIGINAL_ID,
      journalFailedIdentity: CANDIDATE_ID
    }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.calls.includes(`verify-mutable:${FAILED}`), true);
  assert.equal(value.authority.calls.includes(`inspect-fresh:${TARGET}`), true);
  assert.equal(value.calls.some(call => call === 'health:1.20.1:false'), true);
  assert.deepEqual(value.registry.finishes[0].request.outcome, initial.outcome);
});

test('active terminal existing failure accepts post-restore runtime writes and republishes exact outcome', async () => {
  const initial = record({
    phase: 'failed',
    swapStep: 'candidate-published',
    directoryIdentities: {
      target: ORIGINAL_ID,
      candidate: CANDIDATE_ID,
      rollback: ORIGINAL_ID,
      failed: null
    },
    outcome: {
      recovery: { action: 'pre-swap-restored', operationId: 'job-alpha' }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: '7'.repeat(64) }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.authority.calls.includes(`inspect-fresh:${TARGET}`), true);
  assert.equal(value.calls.some(call => call === 'health:1.20.1:false'), true);
  assert.deepEqual(value.registry.finishes[0].request.outcome, initial.outcome);
});

test('active terminal new pre-publication failure republishes after proving every slot is absent', async () => {
  const initial = record({
    target: { kind: 'new' },
    rollbackPath: null,
    phase: 'failed',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    outcome: {
      recovery: { action: 'pre-publication-cleanup', operationId: 'job-alpha' }
    }
  });
  const value = fixture(initial, {});

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.deepEqual(value.registry.finishes[0].request.outcome, initial.outcome);
  assert.equal(value.calls.some(call => call.startsWith('health:')), false);
});

test('committed healthy canonical always wins and cleanup-pending is retried without rollback', async () => {
  for (const cleanupPending of [true, false]) {
    const initial = record({
      phase: cleanupPending ? 'cleanup-pending' : 'committed-healthy',
      swapStep: 'candidate-published',
      directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
      outcome: {
        candidate: { fingerprint: CANDIDATE_FP },
        rollback: { fingerprint: ORIGINAL_FP },
        revision: { source: 4, target: 5 },
        revisionEvent: { eventId: 'event:job-alpha', published: true },
        runtime: {
          source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
          target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
        }
      }
    });
    const value = fixture(initial, {
      [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
      [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
    }, { cleanupPending });
    const result = await serviceFor(value).recover(initial);
    assert.equal(result.resolved, !cleanupPending);
    assert.equal(value.authority.calls.some(call => call === `rename:${TARGET}->${FAILED}`), false);
    if (cleanupPending) {
      assert.equal(value.registry.current.phase, 'cleanup-pending');
      assert.equal(value.registry.finishes.length, 0);
    } else {
      assert.equal(value.registry.finishes[0].request.terminalPhase, 'completed');
      assert.equal(value.authority.entries.get(TARGET).kind, 'owned');
    }
  }
});

test('cleanup-pending recovery completes when the rollback was durably removed before the crash', async () => {
  const initial = record({
    phase: 'cleanup-pending',
    swapStep: 'candidate-published',
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      revisionEvent: { eventId: 'event:job-alpha', published: true },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'completed');
  assert.equal(value.registry.finishes[0].record.swapStep, 'cleanup-complete');
  assert.equal(value.authority.calls.some(call => call.startsWith('rename:')), false);
});

test('cleanup-pending recovery resumes an authorized partial rollback deletion', async () => {
  const initial = record({
    phase: 'cleanup-pending',
    swapStep: 'candidate-published',
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      revisionEvent: { eventId: 'event:job-alpha', published: true },
      cleanup: { deletionAuthorized: true, rollbackRemoved: false },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: '9'.repeat(64) },
    [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: '8'.repeat(64) }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.authority.calls.includes(`verify-original:${ROLLBACK}`), false);
  assert.equal(value.authority.entries.has(ROLLBACK), false);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'completed');
});

test('cleanup-pending verifies committed ownership before executing the canonical server', async () => {
  const initial = record({
    phase: 'cleanup-pending',
    swapStep: 'candidate-published',
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      revisionEvent: { eventId: 'event:job-alpha', published: true },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
    [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  });
  value.authority.fail.add(`verify:${TARGET}`);

  await assert.rejects(
    serviceFor(value).recover(initial),
    error => error?.code === 'RECOVERY_REQUIRED'
  );

  assert.equal(value.calls.includes('verify-committed-canonical'), true);
  assert.equal(value.calls.some(call => call.startsWith('health:')), false);
  assert.equal(value.calls.some(call => call.startsWith('stop:')), false);
  assert.equal(value.calls.includes('cleanup-committed'), false);
  assert.equal(value.authority.entries.has(ROLLBACK), true);
});

test('terminal committed recovery accepts normal post-health canonical writes', async () => {
  const initial = record({
    phase: 'completed',
    swapStep: 'cleanup-complete',
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      revisionEvent: { eventId: 'event:job-alpha', published: true },
      cleanup: { rollbackRemoved: true },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: '9'.repeat(64) }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.calls.includes('verify-committed-canonical'), true);
  assert.equal(value.calls.some(call => call.startsWith('health:1.21.1:')), true);
  assert.equal(value.authority.calls.some(call => call === `verify-owned:${TARGET}`), true);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'completed');
});

test('an explicit rollback request cannot contradict a durable committed-healthy boundary', async () => {
  const initial = record({
    phase: 'committed-healthy',
    swapStep: 'candidate-published',
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      revisionEvent: { eventId: 'event:job-alpha', published: true },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
    [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  });

  await assert.rejects(serviceFor(value).rollback(initial, 'late-lifecycle-error'), error =>
    error?.code === 'RECOVERY_REQUIRED');
  assert.equal(value.authority.calls.some(call => call.startsWith('rename:')), false);
  assert.equal(value.registry.current.phase, 'committed-healthy');
});

test('health failure after an authorized live boot rolls back a mutated canonical candidate', async () => {
  const initial = record({
    phase: 'validating-live',
    swapStep: 'candidate-published',
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  const value = fixture(initial, {
    [TARGET]: {
      kind: 'owned', identity: CANDIDATE_ID, fingerprint: '9'.repeat(64),
      journalPhase: 'validating-live', journalStep: 'candidate-published'
    },
    [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  }, {
    commitHealthError: new ModpackError('HEALTH_CHECK_FAILED', 'live boot failed after world writes')
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'rolled-back');
  assert.equal(value.authority.entries.get(TARGET).kind, 'original');
  assert.equal(value.authority.entries.get(TARGET).fingerprint, ORIGINAL_FP);
  assert.equal(value.authority.entries.get(FAILED).kind, 'owned');
  assert.equal(value.authority.entries.get(FAILED).fingerprint, '9'.repeat(64));
  assert.equal(value.calls.some(call => call === `verify-mutable:${TARGET}`), true);
  assert.equal(value.calls.some(call => call === `verify-mutable:${FAILED}`), true);
});

test('startup committed cleanup retries pending release tracking before removing rollback bytes', async () => {
  const initial = record({
    phase: 'committed-healthy',
    swapStep: 'candidate-published',
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      revisionEvent: { eventId: 'event:job-alpha', published: true },
      releaseTracking: {
        schemaVersion: 1,
        action: 'remove',
        status: 'pending',
        serverId: 'alpha',
        trackingId: 'tracking-alpha'
      },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: { runtime: RUNTIME_TARGET, maxRam: 8, port: 25566 }
      }
    }
  });
  let attempts = 0;
  let value;
  const releaseTrackingReconciler = {
    async reconcile(jobId) {
      attempts += 1;
      if (attempts === 1) throw new Error('injected tracking-store crash');
      const current = await value.registry.load(jobId);
      await value.registry.transition(jobId, {
        expectedPhase: current.phase,
        nextPhase: current.phase,
        patch: {
          outcome: {
            ...current.outcome,
            releaseTracking: { ...current.outcome.releaseTracking, status: 'applied' }
          }
        }
      });
    }
  };
  value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
    [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  }, { releaseTrackingReconciler });
  const service = serviceFor(value);

  await assert.rejects(service.recover(initial), error => error.code === 'RECOVERY_REQUIRED');
  assert.equal(value.registry.current.outcome.releaseTracking.status, 'pending');
  assert.equal(value.authority.entries.has(ROLLBACK), true);
  assert.equal(value.calls.includes('cleanup-committed'), false);

  const result = await service.recover(value.registry.current);
  assert.equal(result.resolved, true);
  assert.equal(attempts, 2);
  assert.equal(value.authority.entries.has(ROLLBACK), false);
  assert.equal(value.registry.finishes[0].record.outcome.releaseTracking.status, 'applied');
});

test('committed inactive uninstall recovery stays stopped and keeps auto-restart disabled without health validation', async () => {
  const initial = record({
    operationKind: 'uninstall',
    phase: 'committed-healthy',
    swapStep: 'candidate-published',
    priorRuntime: { running: true, autoRestart: true },
    directoryIdentities: { target: CANDIDATE_ID, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: null },
    outcome: {
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 4, target: 5 },
      revisionEvent: { eventId: 'event:job-alpha', published: true },
      runtime: {
        source: { runtime: RUNTIME_SOURCE, maxRam: 6, port: 25565 },
        target: null
      },
      runtimePolicy: { targetRunning: false, targetAutoRestart: false, targetInactive: true }
    }
  });
  const value = fixture(initial, {
    [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
    [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
  });

  const result = await serviceFor(value).recover(initial);

  assert.equal(result.resolved, true);
  assert.equal(value.calls.includes(`stop:${TARGET}`), true);
  assert.equal(value.calls.includes('auto:false'), true);
  assert.equal(value.calls.some(call => call.startsWith('health:')), false);
  assert.equal(value.calls.some(call => call.startsWith('adopt:')), false);
  assert.equal(value.registry.finishes[0].request.terminalPhase, 'completed');
});

test('missing rollback reconstructs only into an absent fresh sibling and persists its new identity before use', async () => {
  const initial = record({
    phase: 'rolling-back',
    swapStep: 'failed-canonical-moved',
    directoryIdentities: { target: null, candidate: CANDIDATE_ID, rollback: ORIGINAL_ID, failed: CANDIDATE_ID }
  });
  const value = fixture(initial, {
    [FAILED]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP }
  });

  const result = await serviceFor(value).recover(initial);
  assert.equal(result.resolved, true);
  assert.ok(value.calls.includes('restore:verify:restore-alpha'));
  assert.ok(value.calls.includes('restore:fresh:restore-alpha'));
  const persisted = value.registry.transitions.find(item =>
    item.nextPhase === 'rolling-back' && item.patch.directoryIdentities?.rollback?.fileId === RESTORED_ID.fileId);
  assert.ok(persisted, 'fresh restore identity must be durable before its rename');
  assert.deepEqual(value.authority.entries.get(TARGET)?.identity, RESTORED_ID);
});

test('offline, corrupt journal, mutated identities, occupied destinations, and failed restore remain unresolved without writes', async () => {
  const scenarios = [
    {
      name: 'offline target parent',
      entries: {},
      configure(value) { value.authority.fail.add(`verify:${TARGET}`); }
    },
    {
      name: 'corrupt journal',
      entries: {
        [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP, journalValid: false },
        [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
      }
    },
    {
      name: 'mutated identity',
      entries: {
        [TARGET]: { kind: 'owned', identity: RESTORED_ID, fingerprint: CANDIDATE_FP },
        [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
      }
    },
    {
      name: 'two apparent canonicals',
      entries: {
        [TARGET]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
        [CANDIDATE]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP },
        [ROLLBACK]: { kind: 'original', identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP }
      }
    },
    {
      name: 'failed restore',
      phase: 'rolling-back',
      step: 'failed-canonical-moved',
      entries: { [FAILED]: { kind: 'owned', identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP } },
      options: {
        restorePointService: {
          async cleanupInterruptedRestorePointCreation() { return { cleaned: 0, diagnostics: [] }; },
          async verifyRestorePoint() { throw recoveryError('bad restore'); },
          async restoreToFreshCandidate() { throw new Error('must not restore after failed verification'); }
        }
      }
    }
  ];
  for (const scenario of scenarios) {
    const initial = record({
      phase: scenario.phase || 'starting',
      swapStep: scenario.step || 'candidate-published',
      directoryIdentities: {
        target: scenario.step === 'failed-canonical-moved' ? null : CANDIDATE_ID,
        candidate: CANDIDATE_ID,
        rollback: ORIGINAL_ID,
        failed: scenario.step === 'failed-canonical-moved' ? CANDIDATE_ID : null
      }
    });
    const value = fixture(initial, scenario.entries, scenario.options);
    scenario.configure?.(value);
    const before = clone([...value.authority.entries]);
    await assert.rejects(serviceFor(value).recover(initial), error => error.code === 'RECOVERY_REQUIRED', scenario.name);
    assert.equal(value.registry.finishes.length, 0, scenario.name);
    if (scenario.name !== 'offline target parent') {
      const destructive = value.authority.calls.filter(item => item.startsWith('rename:') || item.startsWith('remove:'));
      assert.deepEqual(destructive, [], scenario.name);
      assert.deepEqual([...value.authority.entries], before, scenario.name);
    }
  }
});
