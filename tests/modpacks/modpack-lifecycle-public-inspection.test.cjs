const assert = require('node:assert/strict');
const test = require('node:test');

const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { validateModpackIpcResult } = require('../../electron/services/modpacks/ipc-schemas.cjs');

function createService(overrides = {}) {
  const attempts = [];
  return new ModpackLifecycleService({
    workspaceRegistry: {
      attempts,
      async releaseOwner(ownerId) {
        assert.equal(attempts.some(state => state.ownerId === ownerId && !state.finished), false);
        return 0;
      },
      beginPreparationAttempt({ ownerId }) {
        const state = { ownerId, retired: false, finished: false };
        attempts.push(state);
        return Object.freeze({
          async retire({ templateOutputId }) {
            assert.equal(templateOutputId, null, 'projection fixtures allocate no candidate template');
            assert.equal(state.finished, false);
            state.retired = true;
          },
          finish() {
            assert.equal(state.retired, true, 'fixture capability must retire before finish');
            assert.equal(state.finished, false);
            state.finished = true;
          }
        });
      }
    },
    sourceResolver: {
      async resolveArtifactSetPlan() {
        return {
          artifactSetPlan: { type: 'artifact-set-plan' },
          source: { provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF', version: 'v1.2-1.20.1', title: 'Server Optimized' }
        };
      }
    },
    artifactDownloader: { async downloadSet() { return { type: 'verified-artifact-set' }; } },
    archiveInspector: {
      async inspectArchive() {
        return {
          type: 'archive-inspection',
          archiveFamily: 'mrpack',
          integrity: 'tested',
          artifactSet: { completeness: 'verified-complete-set', fingerprint: 'a'.repeat(64) },
          engineEvidence: { family: 'zip', concreteFamily: 'zip', version: '24.09', tested: true },
          entries: [{ entryName: 'modrinth.index.json', canonicalName: 'modrinth.index.json', type: 'file', size: '1', packedSize: '1', depth: 1, nameLength: 19 }],
          rootCandidates: [],
          selectedRoot: null,
          limitEvidence: {
            policyVersion: 1,
            totals: {
              entryCount: 1,
              fileCount: 1,
              directoryCount: 0,
              expandedBytes: '1',
              packedBytes: '1',
              maximumDepth: 1,
              maximumPathLength: 19
            }
          },
          classification: { kind: 'mrpack-server', confidence: 'exact', blocked: false },
          inspectionId: 'inspection-real-lifecycle'
        };
      }
    },
    inspectionLoader: { loadInspection() { return null; } },
    planningAdapter: { async createPlan() { return null; } },
    planRegistry: { create() { return null; }, get() { return null; }, claim() { return null; } },
    operationStore: { async get() { return null; }, async requestCancellation() { return null; } },
    ...overrides
  });
}

test('inspection returns the opaque inspection handle required by the subsequent public preflight request', async () => {
  const result = await createService().inspectSource({
    provider: 'modrinth',
    projectId: 'ca0m6gMz',
    versionId: 'oQ6gSIoF'
  });

  assert.equal(result.inspectionId, 'inspection-real-lifecycle');
  assert.doesNotThrow(() => validateModpackIpcResult('modpacks:inspect', { ok: true, value: result }));
});

test('inspection forwards ordered progress without exposing the retired full archive-test phase', async () => {
  const events = [];
  const sourceOptions = [];
  const service = createService({
    sourceResolver: {
      async resolveArtifactSetPlan(request, options) {
        sourceOptions.push(options);
        return {
          artifactSetPlan: { type: 'artifact-set-plan' },
          source: { provider: 'modrinth', projectId: request.projectId, versionId: request.versionId, version: 'v1.2-1.20.1', title: 'Server Optimized' }
        };
      }
    },
    artifactDownloader: {
      async downloadSet(_plan, { onProgress }) {
        onProgress({ setBytes: '12', totalBytes: '24' });
        return { type: 'verified-artifact-set' };
      }
    },
    archiveInspector: {
      async inspectArchive({ onProgress }) {
        for (const phase of ['materialize', 'list', 'validate', 'test', 'classify', 'complete']) onProgress({ phase });
        return {
          type: 'archive-inspection', archiveFamily: 'mrpack', integrity: 'tested',
          artifactSet: { completeness: 'verified-complete-set', fingerprint: 'a'.repeat(64) },
          engineEvidence: { family: 'zip', concreteFamily: 'zip', version: '24.09', tested: true },
          entries: [], rootCandidates: [], selectedRoot: null,
          limitEvidence: { policyVersion: 1, totals: { entryCount: 0, fileCount: 0, directoryCount: 0, expandedBytes: '0', packedBytes: '0', maximumDepth: 0, maximumPathLength: 0 } },
          classification: { kind: 'mrpack-server', confidence: 'exact', blocked: false }, inspectionId: 'inspection-progress-one'
        };
      }
    }
  });

  const result = await service.inspectSource({ provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF' }, {
    onProgress(event) {
      events.push(event);
      if (event.phase === 'downloading') throw new Error('renderer disconnected');
    }
  });

  assert.equal(result.inspectionId, 'inspection-progress-one');
  assert.equal(typeof sourceOptions[0]?.onProgress, 'function');
  assert.deepEqual(events.map(event => event.phase), [
    'resolving', 'downloading', 'downloading', 'verifying', 'materialize', 'list', 'validate', 'classify', 'complete'
  ]);
  assert.deepEqual(events[2], { phase: 'downloading', transferredBytes: 12, totalBytes: 24, percent: 50 });
});

test('inspection cancellation reaches source download and archive boundaries', async () => {
  const controller = new AbortController();
  const received = {};
  const service = createService({
    sourceResolver: {
      async resolveArtifactSetPlan(_request, options) {
        received.sourceSignal = options.signal;
        return {
          artifactSetPlan: { type: 'artifact-set-plan' },
          source: { provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF', version: 'v1.2-1.20.1', title: 'Server Optimized' }
        };
      }
    },
    artifactDownloader: {
      async downloadSet(_plan, options) {
        received.downloadSignal = options.signal;
        controller.abort();
        const error = new Error('cancelled');
        error.code = 'ABORT_ERR';
        throw error;
      }
    },
    archiveInspector: {
      async inspectArchive() {
        throw new Error('archive inspection must not start after cancellation');
      }
    }
  });

  await assert.rejects(
    service.inspectSource({ provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF' }, {
      signal: controller.signal
    }),
    error => error?.code === 'CANCELLED'
  );
  assert.equal(received.sourceSignal, controller.signal);
  assert.equal(received.downloadSignal, controller.signal);
});

test('cancellation after archive promotion releases the inspection owner instead of retaining a session', async () => {
  const controller = new AbortController();
  const released = [];
  const service = createService({
    workspaceRegistry: {
      async releaseOwner(ownerId) { released.push(ownerId); }
    },
    archiveInspector: {
      async inspectArchive({ signal }) {
        assert.equal(signal, controller.signal);
        controller.abort();
        return {
          type: 'archive-inspection', archiveFamily: 'zip', integrity: 'tested',
          artifactSet: { completeness: 'verified-complete-set', fingerprint: 'a'.repeat(64) },
          engineEvidence: { family: 'zip', concreteFamily: 'zip', version: '24.09', tested: true },
          entries: [], rootCandidates: [], selectedRoot: null,
          limitEvidence: { policyVersion: 1, totals: { entryCount: 0, fileCount: 0, directoryCount: 0, expandedBytes: '0', packedBytes: '0', maximumDepth: 0, maximumPathLength: 0 } },
          classification: { kind: 'server-pack', confidence: 'high', blocked: false },
          inspectionId: 'inspection-cancelled-after-promotion'
        };
      }
    }
  });

  await assert.rejects(
    service.inspectSource({ provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF' }, {
      signal: controller.signal
    }),
    error => error?.code === 'CANCELLED'
  );
  assert.deepEqual(released, ['inspection-cancelled-after-promotion']);
  assert.equal(await service.cancelInspection('inspection-cancelled-after-promotion'), false);
});

test('discarding a completed inspection releases its owner exactly once', async () => {
  const released = [];
  const service = createService({
    workspaceRegistry: {
      async releaseOwner(ownerId) { released.push(ownerId); }
    }
  });
  const inspected = await service.inspectSource({
    provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF'
  });

  assert.equal(await service.cancelInspection(inspected.inspectionId), true);
  assert.equal(await service.cancelInspection(inspected.inspectionId), false);
  assert.deepEqual(released, ['inspection-real-lifecycle']);
});

test('large inspections return a bounded public projection while preflight retains the complete internal inspection', async () => {
  const entries = Array.from({ length: 10_001 }, (_, index) => ({
    entryName: `mods/mod-${index}.jar`, canonicalName: `mods/mod-${index}.jar`, type: 'file',
    size: '1', packedSize: '1', depth: 2, nameLength: 14
  }));
  const internalInspection = {
    type: 'archive-inspection', archiveFamily: 'zip', integrity: 'tested',
    artifactSet: { completeness: 'verified-complete-set', fingerprint: 'a'.repeat(64) },
    engineEvidence: { family: 'zip', concreteFamily: 'zip', version: '24.09', tested: true },
    entries,
    rootCandidates: ['mods'], selectedRoot: 'mods',
    limitEvidence: {
      policyVersion: 1,
      totals: {
        entryCount: 10_001, fileCount: 10_001, directoryCount: 0,
        expandedBytes: '10001', packedBytes: '10001', maximumDepth: 2, maximumPathLength: 18
      }
    },
    classification: { kind: 'prepared-server-pack', confidence: 'high', blocked: false },
    inspectionId: 'inspection-many-entries'
  };
  let loadedInspection = null;
  let plannedWith = null;
  const service = createService({
    archiveInspector: { async inspectArchive() { return internalInspection; } },
    inspectionLoader: {
      loadInspection(inspectionId) {
        assert.equal(inspectionId, 'inspection-many-entries');
        loadedInspection = { inspectionId, result: internalInspection };
        return loadedInspection;
      }
    },
    planningAdapter: {
      async createPlan({ inspection }) {
        plannedWith = inspection;
        return { plan: { fingerprint: 'plan-many-entries' }, sanitizedView: { title: 'Many entries' } };
      }
    },
    planRegistry: {
      create() {
        return { planId: 'plan-many-entries', fingerprint: 'plan-many-entries', planView: { title: 'Many entries' }, expiresAt: '2030-01-01T00:00:00.000Z' };
      },
      get() { return null; }, claim() { return null; }
    }
  });

  const publicInspection = await service.inspectSource({ provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF' });
  assert.equal(publicInspection.entries, undefined);
  assert.deepEqual(publicInspection.limitEvidence.totals, internalInspection.limitEvidence.totals);
  assert.deepEqual(publicInspection.classification, internalInspection.classification);
  assert.deepEqual(publicInspection.rootCandidates, ['mods']);
  assert.doesNotThrow(() => validateModpackIpcResult('modpacks:inspect', { ok: true, value: publicInspection }));

  await service.createPlan({
    inspectionId: publicInspection.inspectionId, instanceId: 'server-many-entries', operationKind: 'install-new',
    selections: { optionalFileIds: [], conflictChoices: {} }
  });
  assert.equal(loadedInspection.result.entries.length, 10_001);
  assert.equal(plannedWith.result.entries.length, 10_001);
  assert.deepEqual(service.workspaceRegistry.attempts, [{ ownerId: publicInspection.inspectionId, retired: true, finished: true }]);
});

test('oversized root candidate lists are bounded publicly while preflight retains every internal candidate', async () => {
  const rootCandidates = Array.from({ length: 10_001 }, (_, index) => `root-${String(index).padStart(5, '0')}`);
  const internalInspection = {
    type: 'archive-inspection', archiveFamily: 'zip', integrity: 'tested',
    artifactSet: { completeness: 'verified-complete-set', fingerprint: 'a'.repeat(64) },
    engineEvidence: { family: 'zip', concreteFamily: 'zip', version: '24.09', tested: true },
    entries: [], rootCandidates, selectedRoot: null,
    limitEvidence: {
      policyVersion: 1,
      totals: {
        entryCount: 10_001, fileCount: 10_001, directoryCount: 0,
        expandedBytes: '10001', packedBytes: '10001', maximumDepth: 2, maximumPathLength: 18
      }
    },
    classification: { kind: 'prepared-server-pack', confidence: 'high', blocked: false },
    inspectionId: 'inspection-many-roots'
  };
  let loadedInspection = null;
  let plannedWith = null;
  const service = createService({
    archiveInspector: { async inspectArchive() { return internalInspection; } },
    inspectionLoader: {
      loadInspection(inspectionId) {
        assert.equal(inspectionId, 'inspection-many-roots');
        loadedInspection = { inspectionId, result: internalInspection };
        return loadedInspection;
      }
    },
    planningAdapter: {
      async createPlan({ inspection }) {
        plannedWith = inspection;
        return { plan: { fingerprint: 'plan-many-roots' }, sanitizedView: { title: 'Many roots' } };
      }
    },
    planRegistry: {
      create() {
        return { planId: 'plan-many-roots', fingerprint: 'plan-many-roots', planView: { title: 'Many roots' }, expiresAt: '2030-01-01T00:00:00.000Z' };
      },
      get() { return null; }, claim() { return null; }
    }
  });

  const publicInspection = await service.inspectSource({ provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF' });
  assert.equal(publicInspection.rootCandidates.length, 4_096);
  assert.equal(publicInspection.rootCandidates[0], 'root-00000');
  assert.equal(publicInspection.rootCandidates.at(-1), 'root-04095');
  assert.doesNotThrow(() => validateModpackIpcResult('modpacks:inspect', { ok: true, value: publicInspection }));

  await service.createPlan({
    inspectionId: publicInspection.inspectionId, instanceId: 'server-many-roots', operationKind: 'install-new',
    selections: { optionalFileIds: [], conflictChoices: {} }
  });
  assert.equal(loadedInspection.result.rootCandidates.length, 10_001);
  assert.equal(plannedWith.result.rootCandidates.at(-1), 'root-10000');
  assert.deepEqual(service.workspaceRegistry.attempts, [{ ownerId: publicInspection.inspectionId, retired: true, finished: true }]);
});

test('preflight permits the public UI empty conflict-choice maps without widening planning authority', async () => {
  let received;
  const service = createService({
    inspectionLoader: { loadInspection(inspectionId) { return { inspectionId }; } },
    planningAdapter: {
      async createPlan(input) {
        received = input;
        return { plan: { fingerprint: 'plan-fingerprint' }, sanitizedView: {} };
      }
    },
    planRegistry: {
      create() { return { planId: 'plan-one', fingerprint: 'plan-fingerprint', planView: {}, expiresAt: '2030-01-01T00:00:00.000Z' }; },
      get() { return null; }, claim() { return null; }
    }
  });
  await service.inspectSource({ provider: 'modrinth', projectId: 'ca0m6gMz', versionId: 'oQ6gSIoF' });

  await service.createPlan({
    inspectionId: 'inspection-real-lifecycle', instanceId: 'server-one', operationKind: 'install-new',
    selections: { optionalFileIds: [], conflictChoices: { paths: {}, categories: {} } }
  });

  assert.deepEqual(received.request.selections.conflictChoices, { paths: {}, categories: {} });
  assert.deepEqual(service.workspaceRegistry.attempts, [{ ownerId: 'inspection-real-lifecycle', retired: true, finished: true }]);
});

test('rollback-option listing delegates one exact instance ID and returns only its public lazy options', async () => {
  const runtime = {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
  const received = [];
  const service = createService({
    planningAdapter: {
      async createPlan() { return null; },
      async listRollbackOptions(request) {
        received.push(request);
        return {
          items: [{
            restorePointId: 'restore-one', operationKind: 'upgrade',
            createdAt: '2026-08-01T01:02:03.004Z', sourceRevision: 4,
            runtime, totalBytes: '1234'
          }]
        };
      }
    }
  });

  assert.deepEqual(await service.listRollbackOptions('server-one'), {
    items: [{
      restorePointId: 'restore-one', operationKind: 'upgrade',
      createdAt: '2026-08-01T01:02:03.004Z', sourceRevision: 4,
      runtime, totalBytes: '1234'
    }]
  });
  assert.deepEqual(received, [{ instanceId: 'server-one' }]);
  await assert.rejects(service.listRollbackOptions('C:\\server'), error => error?.code === 'INVALID_REQUEST');
});
