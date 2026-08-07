const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');

const TARGET = 'C:\\Minecraft\\Runtime';
const CANDIDATE = 'C:\\Minecraft\\.Runtime.minecraft-core.job-runtime.candidate';
const ROLLBACK = 'C:\\Minecraft\\.Runtime.minecraft-core.job-runtime.rollback';
const FAILED = 'C:\\Minecraft\\.Runtime.minecraft-core.job-runtime.failed';
const ORIGINAL_ID = Object.freeze({ volumeSerial: 'aa', fileId: '11' });
const CANDIDATE_ID = Object.freeze({ volumeSerial: 'aa', fileId: '12' });
const ORIGINAL_FP = '4'.repeat(64);
const CANDIDATE_FP = '5'.repeat(64);
const SOURCE_RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.0', javaMajor: 17
});
const TARGET_RUNTIME = Object.freeze({
  minecraftVersion: '1.21.1', loaderFamily: 'neoforge', loaderVersion: '21.1.1', javaMajor: 21
});

function runtimeRecord({
  phase = 'rolling-back', swapStep = 'rollback-restored', running = false, autoRestart = true,
  targetRunning
} = {}) {
  return {
    schemaVersion: 1,
    sequence: 9,
    jobId: 'job-runtime',
    operationKind: 'upgrade',
    target: { kind: 'existing', stableServerId: 'runtime-server', path: TARGET },
    candidatePath: CANDIDATE,
    rollbackPath: ROLLBACK,
    failedPath: FAILED,
    restorePoint: { id: 'restore-runtime', sha256: 'a'.repeat(64) },
    journalPath: `${TARGET}\\.minecraft-core-state\\operations\\job-runtime\\journal.json`,
    priorRuntime: { running, autoRestart },
    phase,
    swapStep,
    directoryIdentities: {
      target: phase === 'committed-healthy' ? CANDIDATE_ID : ORIGINAL_ID,
      candidate: CANDIDATE_ID,
      rollback: ORIGINAL_ID,
      failed: phase === 'committed-healthy' ? null : CANDIDATE_ID
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:09.000Z',
    outcome: {
      live: { fingerprint: ORIGINAL_FP },
      candidate: { fingerprint: CANDIDATE_FP },
      rollback: { fingerprint: ORIGINAL_FP },
      revision: { source: 2, target: 3 },
      revisionEvent: { eventId: 'event:job-runtime', published: true },
      runtime: {
        source: { runtime: SOURCE_RUNTIME, maxRam: 6, port: 25565 },
        target: { runtime: TARGET_RUNTIME, maxRam: 10, port: 25566 }
      },
      ...(targetRunning === undefined ? {} : { runtimePolicy: { targetRunning } })
    }
  };
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function serviceFixture(options = {}) {
  const initial = runtimeRecord(options);
  let current = clone(initial);
  const calls = [];
  const registry = {
    async load() { return clone(current); },
    async transition(_jobId, request) {
      assert.equal(current.phase, request.expectedPhase);
      current = {
        ...current,
        ...clone(request.patch),
        phase: request.nextPhase,
        sequence: current.sequence + 1
      };
      return clone(current);
    },
    async finish(_jobId, request) {
      calls.push(`finish:${request.terminalPhase}`);
      current = null;
      return { ...initial, phase: request.terminalPhase, outcome: clone(request.outcome) };
    }
  };
  const runtimePolicy = {
    async suspend(request) { calls.push(`hold:${request.jobId}`); return { held: true }; },
    async ensureStopped(request) {
      calls.push(`stop:${request.serverPath}`);
      if (options.stopError) throw options.stopError;
      return { stopped: true };
    },
    async adoptValidatedHandoff(request) {
      calls.push(`adopt:${request.eventId}`);
      if (options.adoptError) throw options.adoptError;
      return { adopted: true };
    },
    async restoreAutoRestart(request) {
      calls.push(`auto:${request.enabled}`);
      return { restored: true };
    }
  };
  const healthValidator = {
    async validateLive(request) {
      calls.push(`health:${request.runtime.minecraftVersion}:${request.maxRam}:${request.port}:${request.keepRunning}`);
      if (options.healthError) throw options.healthError;
      return {
        evidence: { ok: true },
        handoff: request.keepRunning ? { processHandle: {}, startLease: {} } : null
      };
    }
  };
  const authority = {
    exists(directoryPath) {
      if (directoryPath === TARGET) return true;
      if (directoryPath === FAILED) return options.phase !== 'committed-healthy';
      if (directoryPath === ROLLBACK) return options.phase === 'committed-healthy';
      return false;
    },
    async verifyOriginal(request) {
      calls.push(`verify-source:${request.directoryPath}`);
      if (request.directoryIdentity.fileId !== ORIGINAL_ID.fileId || request.fingerprint !== ORIGINAL_FP) {
        throw new ModpackError('RECOVERY_REQUIRED', 'wrong source');
      }
      return { identity: ORIGINAL_ID, fingerprint: ORIGINAL_FP };
    },
    async verifyOperationOwned(request) {
      calls.push(`verify-target:${request.directoryPath}`);
      if (request.directoryIdentity.fileId !== CANDIDATE_ID.fileId || request.fingerprint !== CANDIDATE_FP) {
        throw new ModpackError('RECOVERY_REQUIRED', 'wrong target');
      }
      return { identity: CANDIDATE_ID, fingerprint: CANDIDATE_FP };
    },
    async renameExact() { throw new Error('unexpected rename'); },
    async removeOperationOwned() { throw new Error('unexpected remove'); },
    async inspectFresh() { throw new Error('unexpected restore'); }
  };
  const transactionApi = {
    async markCommittedHealthy() { calls.push('publish-once'); return { phase: 'committed-healthy' }; },
    async cleanupCommittedTransaction() {
      calls.push('cleanup');
      const previous = current;
      current = { ...previous, phase: 'completed', swapStep: 'cleanup-complete' };
      return { phase: 'completed', rollbackRemoved: true };
    },
    async publishNewCandidate() { throw new Error('unexpected publish'); },
    async registerPublishedInstance() { throw new Error('unexpected register'); }
  };
  const coordinator = {
    runRecoveryMutation(_selector, _request, work) {
      return work(Object.freeze({
        kind: 'mutation',
        operation: 'modpack-recovery',
        operationId: initial.jobId,
        instanceId: initial.target.stableServerId,
        serverPath: initial.target.path,
        assertOwnedPath: value => value,
        markDirty() {}
      }));
    }
  };
  const contextFactory = async ({ record, mutationLease }) => ({
    jobId: record.jobId,
    operationKind: record.operationKind,
    stableInstanceId: record.target.stableServerId,
    targetPath: record.target.path,
    recoveryRegistry: registry,
    mutationLease,
    healthValidator,
    runtimePolicy,
    runtime: TARGET_RUNTIME,
    maxRam: 10,
    port: 25566,
    healthTimeoutMs: 30_000
  });
  const { ModpackRecoveryService } = require('../../electron/services/modpack-lifecycle/modpack-recovery-service.cjs');
  return {
    calls,
    initial,
    service: new ModpackRecoveryService({
      coordinator,
      recoveryRegistry: registry,
      contextFactory,
      directoryAuthority: authority,
      runtimePolicy,
      transactionApi
    })
  };
}

test('rollback validates the source runtime and a previously stopped server stays stopped', async () => {
  const fixture = serviceFixture({ running: false, autoRestart: true });
  const result = await fixture.service.recover(fixture.initial);

  assert.equal(result.resolved, true);
  assert.ok(fixture.calls.includes('health:1.20.1:6:25565:false'));
  assert.equal(fixture.calls.some(call => call.startsWith('adopt:')), false);
  assert.ok(fixture.calls.indexOf('health:1.20.1:6:25565:false') < fixture.calls.indexOf('auto:true'));
  assert.equal(fixture.calls.at(-1), 'finish:rolled-back');
});

test('only a previously running server keeps the validated source handoff and it is adopted once', async () => {
  const fixture = serviceFixture({ running: true, autoRestart: false });
  const result = await fixture.service.recover(fixture.initial);

  assert.equal(result.resolved, true);
  assert.ok(fixture.calls.includes('health:1.20.1:6:25565:true'));
  assert.deepEqual(fixture.calls.filter(call => call === 'adopt:modpack-runtime-handoff:job-runtime'), [
    'adopt:modpack-runtime-handoff:job-runtime'
  ]);
  assert.ok(fixture.calls.indexOf('adopt:modpack-runtime-handoff:job-runtime') < fixture.calls.indexOf('auto:false'));
});

test('committed healthy recovery uses the target runtime and never relaunches a previously stopped server', async () => {
  const fixture = serviceFixture({ phase: 'committed-healthy', running: false, autoRestart: false });
  const result = await fixture.service.recover(fixture.initial);

  assert.equal(result.resolved, true);
  assert.ok(fixture.calls.includes('health:1.21.1:10:25566:false'));
  assert.equal(fixture.calls.some(call => call.startsWith('adopt:')), false);
  assert.ok(fixture.calls.indexOf('publish-once') < fixture.calls.indexOf('cleanup'));
  assert.ok(fixture.calls.indexOf('cleanup') < fixture.calls.indexOf('finish:completed'));
});

test('committed target recovery honors start-after-install while source rollback still honors prior running state', async () => {
  const target = serviceFixture({ phase: 'committed-healthy', running: false, autoRestart: false, targetRunning: true });
  await target.service.recover(target.initial);
  assert.ok(target.calls.includes('health:1.21.1:10:25566:true'));
  assert.ok(target.calls.includes('adopt:modpack-runtime-handoff:job-runtime'));

  const source = serviceFixture({ running: false, autoRestart: false, targetRunning: true });
  await source.service.recover(source.initial);
  assert.ok(source.calls.includes('health:1.20.1:6:25565:false'));
  assert.equal(source.calls.some(call => call.startsWith('adopt:')), false);
});

test('failed stop, health, or handoff adoption retains the recovery hold and never restores auto-restart', async () => {
  const failures = [
    { name: 'stop', stopError: new Error('stop uncertain') },
    { name: 'health', healthError: new ModpackError('HEALTH_CHECK_FAILED', 'bad') },
    { name: 'adopt', running: true, adoptError: new Error('handoff uncertain') }
  ];
  for (const item of failures) {
    const fixture = serviceFixture(item);
    await assert.rejects(fixture.service.recover(fixture.initial), error => error.code === 'RECOVERY_REQUIRED', item.name);
    assert.equal(fixture.calls.some(call => call.startsWith('auto:')), false, item.name);
    assert.equal(fixture.calls.some(call => call.startsWith('finish:')), false, item.name);
    assert.equal(fixture.calls[0], 'hold:job-runtime', item.name);
  }
});

test('auto-restart recovery holds are per-server, suppress pending crash starts, and preserve delay/max settings', async () => {
  const modulePath = path.resolve(__dirname, '../../electron/services/auto-restart.cjs');
  const originalLoad = Module._load;
  const eventBus = new EventEmitter();
  const configs = new Map([[TARGET, {
    autoRestart: { enabled: true, delay: 37, maxCrashes: 7 }
  }]]);
  const appLevel = { enabled: false, delay: 10, maxCrashes: 3 };
  Module._load = function loadFixture(request, parent, isMain) {
    if (request.endsWith('utils/event-bus.cjs')) return eventBus;
    if (request.endsWith('utils/safe-send.cjs')) return { safeSend() {} };
    if (request.endsWith('utils/app-store.cjs')) {
      return { get: key => key === 'autoRestart' ? clone(appLevel) : null, set() {} };
    }
    if (request.endsWith('utils/config-manager.cjs')) {
      return {
        getDefaultServerConfig() { return { autoRestart: { enabled: false, delay: 10, maxCrashes: 3 } }; },
        readServerConfig(serverPath) { return clone(configs.get(serverPath)); },
        updateServerConfig(serverPath, patch) {
          configs.set(serverPath, {
            ...configs.get(serverPath),
            autoRestart: clone(patch.autoRestart)
          });
        }
      };
    }
    if (request === 'fs') return { existsSync: () => true };
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const autoRestart = require(modulePath);
    assert.equal(eventBus.listenerCount('server-crashed'), 0, 'module import must not expose an eager start listener');
    autoRestart.initializeAutoRestartListeners();
    autoRestart.beginRecoveryHold({ serverPath: TARGET, operationId: 'job-runtime' });
    assert.equal(autoRestart.isRecoveryHeld(TARGET), true);

    eventBus.emit('server-crashed', { serverInfo: { targetPath: TARGET, port: 25565, maxRam: 6 } });
    assert.equal(autoRestart.getAutoRestartState(TARGET).enabled, true);
    assert.equal(autoRestart.hasPendingAutoRestart(TARGET), false);

    autoRestart.restoreRecoveryAutoRestart({
      serverPath: TARGET,
      operationId: 'job-runtime',
      enabled: false
    });
    assert.equal(autoRestart.isRecoveryHeld(TARGET), false);
    assert.deepEqual(configs.get(TARGET).autoRestart, { enabled: false, delay: 37, maxCrashes: 7 });

    const adoptions = [];
    const runtimePolicy = autoRestart.createRecoveryRuntimePolicy({
      runtimeController: {
        async ensureStopped() { return { alreadyStopped: true }; },
        async adoptValidatedHandoff(request) {
          adoptions.push(request);
          return { adopted: true, pid: 41 };
        }
      }
    });
    const handoff = { processHandle: { pid: 41 }, startLease: { serverPath: TARGET } };
    const adoptionRequest = {
      eventId: 'modpack-runtime-handoff:job-runtime',
      handoff,
      instanceId: 'runtime-server',
      jobId: 'job-runtime'
    };
    await runtimePolicy.adoptValidatedHandoff(adoptionRequest);
    await runtimePolicy.adoptValidatedHandoff(adoptionRequest);
    assert.equal(adoptions.length, 1);
    assert.equal(adoptions[0].serverPath, TARGET, 'Task 21 handoffs derive their exact path from the owned start lease');
    await assert.rejects(runtimePolicy.adoptValidatedHandoff({
      ...adoptionRequest,
      instanceId: 'different-server'
    }), /handoff/i);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
});
