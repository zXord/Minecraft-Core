const assert = require('node:assert/strict');
const test = require('node:test');

const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');

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
      evidence.journalRecord = { phase: value.journalPhase, swapStep: value.journalStep };
      evidence.locations = { journalPath: `${directoryPath}\\journal.json` };
      evidence.journal = {
        transition: (_journalPath, request) => {
          assert.equal(request.expectedPhase, value.journalPhase);
          value.journalPhase = request.nextPhase;
          value.journalStep = request.patch.swapStep ?? value.journalStep;
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

  async removeOperationOwned({ directoryPath, directoryIdentity, fingerprint }) {
    this.calls.push(`remove:${directoryPath}`);
    await this.verifyOperationOwned({ directoryPath, directoryIdentity, fingerprint });
    if (this.fail.has(`remove:${directoryPath}`)) throw recoveryError('remove failed');
    this.entries.delete(directoryPath);
  }

  async inspectFresh({ directoryPath }) {
    this.calls.push(`inspect-fresh:${directoryPath}`);
    const value = this.entries.get(directoryPath);
    if (!value) throw recoveryError('fresh restore missing');
    return clone({ directoryIdentity: value.identity, fingerprint: value.fingerprint });
  }
}

function fixture(initialRecord, entries, options = {}) {
  const calls = [];
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
    releaseTrackingReconciler,
    revisionPublisher,
    stateRepository
  });
  const restorePointService = options.restorePointService || {
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
    restorePointResolver: value.restorePointResolver,
    restorePointService: value.restorePointService,
    consumeReservedTargetFn: value.consumeReservedTargetFn,
    transactionApi: value.transactionApi
  });
}

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
  const initial = record({
    operationKind: 'install',
    target: { kind: 'new', stableServerId: 'alpha', path: TARGET },
    rollbackPath: null,
    restorePoint: null,
    phase: 'preflight',
    swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    outcome: null
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
  assert.equal(value.registry.current, null);
  assert.equal(value.calls.some(call => call.startsWith('suspend:') || call.startsWith('lease:')), false);
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
    assert.ok(value.calls.indexOf('health:1.21.1:false') < value.calls.indexOf('register-new'));
    assert.ok(value.calls.indexOf('register-new') < value.calls.indexOf('revision:committed-healthy:false'));
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
    assert.deepEqual(repeated, { jobId: 'job-alpha', resolved: true, action: 'already-finished' });
    assert.equal(value.revisionEvents.length, 1);
  }
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
  assert.equal(value.calls.includes('register-new'), false);
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
