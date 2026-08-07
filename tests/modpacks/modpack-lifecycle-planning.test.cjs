const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { OperationStore } = require('../../electron/services/modpack-lifecycle/operation-store.cjs');
const { PlanRegistry } = require('../../electron/services/modpack-lifecycle/plan-registry.cjs');
const { ModpackLifecycleService } = require('../../electron/services/modpack-lifecycle/modpack-lifecycle-service.cjs');
const { ArchiveInputMaterializer } = require('../../electron/services/modpacks/archive/archive-input-materializer.cjs');
const { computePlanFingerprint } = require('../../electron/services/modpacks/artifacts/artifact-fingerprint.cjs');
const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');
const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');

function snapshotTree(root) {
  const result = {};
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        result[relative] = { type: 'directory' };
        visit(absolute, relative);
      } else {
        const bytes = fs.readFileSync(absolute);
        result[relative] = {
          type: 'file',
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        };
      }
    }
  }
  visit(root);
  return result;
}

function verifiedArtifactSet() {
  const plan = createArtifactSetPlan({
    provider: 'github',
    project: { id: '1001', slug: 'owner-reviewed-pack', title: 'Reviewed Pack' },
    release: { id: '2002', version: '1.2.3', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
    artifactSet: {
      kind: 'single',
      groupingScheme: 'single',
      primaryPartId: 'asset-9001',
      parts: [{
        partId: 'asset-9001',
        providerAssetId: 'asset-9001',
        fileName: 'reviewed-pack.zip',
        size: '4',
        updatedAt: '2026-08-01T00:00:00.000Z'
      }],
      providerImmutable: false,
      attestationStatus: 'unavailable'
    }
  });
  return finalizeVerifiedArtifactSet(plan, [{
    partId: 'asset-9001', measuredSize: '4', sha256: 'b'.repeat(64), sha512: 'c'.repeat(128)
  }]);
}

function inspectionResult(verifiedSet) {
  return {
    type: 'archive-inspection',
    archiveFamily: 'zip',
    integrity: 'tested',
    artifactSet: {
      completeness: 'verified-complete-set',
      fingerprint: computePlanFingerprint(verifiedSet)
    },
    engineEvidence: { family: 'zip', concreteFamily: 'zip', version: '26.02', tested: true },
    entries: [{
      entryName: 'mods/example.jar',
      canonicalName: 'mods/example.jar',
      type: 'file',
      size: '4',
      packedSize: '4',
      depth: 2,
      nameLength: 16
    }],
    rootCandidates: [],
    selectedRoot: null,
    limitEvidence: {
      policyVersion: 1,
      totals: { entries: '1', expandedBytes: '4', packedBytes: '4' }
    },
    classification: {
      kind: 'server-pack',
      confidence: 'high',
      runtimeCandidates: [{ loaderFamily: 'fabric', minecraftVersion: '1.21.1', loaderVersion: '0.16.14' }]
    }
  };
}

function fixture(t, { unsafePlanView = false } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-lifecycle-plan-'));
  const serverPath = path.join(userDataPath, 'external-server');
  fs.mkdirSync(path.join(serverPath, 'world'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'server.properties'), 'motd=untouched\n');
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), Buffer.from([1, 2, 3, 4]));

  const workspaceRoot = path.join(userDataPath, 'modpack-lifecycle', 'workspaces');
  let workspaceId = 0;
  const workspaceRegistry = new ArtifactWorkspaceRegistry({
    root: workspaceRoot,
    idFactory: () => `lifecycle-${++workspaceId}`,
    clock: () => Date.parse('2026-08-02T00:00:00.000Z')
  });
  const materializer = new ArchiveInputMaterializer({ workspaceRegistry, workspaceRoot });
  let planId = 0;
  const planRegistry = new PlanRegistry({
    workspaceRegistry,
    clock: () => Date.parse('2026-08-02T00:00:00.000Z'),
    randomUUID: () => `lifecycle-${++planId}`
  });
  let durableTemp = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
      replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
      flushDirectory() {}
    },
    allowedRoots: [userDataPath],
    tempNameFactory: () => `lifecycle-${++durableTemp}`
  });
  let operationId = 0;
  const operationStore = new OperationStore({
    userDataPath,
    fsApi: fs,
    durableFs,
    clock: () => new Date(Date.parse('2026-08-02T00:00:00.000Z') + (++operationId * 1000)),
    randomUUID: () => `operation-${operationId}`
  });

  const verifiedSet = verifiedArtifactSet();
  const internalSource = {
    provider: 'github',
    repositoryId: '1001',
    releaseId: '2002',
    assetIds: ['asset-9001'],
    downloadUrl: 'https://objects.example.invalid/reviewed-pack.zip?token=internal'
  };
  let lastInspection = null;
  let planMode = unsafePlanView ? 'unsafe' : 'safe';
  let planningCalls = 0;
  const sourceResolver = {
    async resolveArtifactSetPlan(request) {
      assert.deepEqual(request, {
        provider: 'github', repositoryId: '1001', releaseId: '2002', assetIds: ['asset-9001']
      });
      return {
        artifactSetPlan: {
          provider: 'github',
          releaseId: '2002',
          parts: [{ partId: 'asset-9001', url: internalSource.downloadUrl }]
        },
        source: internalSource
      };
    }
  };
  const artifactDownloader = {
    async downloadSet(plan) {
      if (plan.releaseId !== '2002' || plan.parts[0].partId !== 'asset-9001' || plan.parts[0].url !== internalSource.downloadUrl) {
        throw new Error('the exact reviewed asset was not preserved');
      }
      return verifiedSet;
    }
  };
  const archiveInspector = {
    async inspectArchive({ verifiedArtifactSet: received }) {
      assert.equal(received, verifiedSet);
      const ownerId = workspaceRegistry.createPlanningSession();
      const artifactSetId = workspaceRegistry.registerVerifiedSet({ ownerId, verifiedSet: received });
      const result = inspectionResult(received);
      const inspectionId = workspaceRegistry.createInspection({ ownerId, artifactSetId, result });
      workspaceRegistry.transferOwnership({ fromOwnerId: ownerId, toOwnerId: inspectionId });
      lastInspection = { artifactSetId, inspectionId };
      return { ...result, inspectionId };
    }
  };
  const planningAdapter = {
    async createPlan({ request, inspection, source }) {
      planningCalls += 1;
      assert.equal(request.inspectionId, lastInspection.inspectionId);
      assert.equal(request.instanceId, 'server-0001');
      assert.equal(inspection.verifiedArtifactSet.artifactSet.setDigest, verifiedSet.artifactSet.setDigest);
      assert.equal(source.downloadUrl, internalSource.downloadUrl);
      if (planMode === 'conflict') {
        return {
          requiresConflictReview: true,
          conflicts: [{
            id: 'conflict-opaque-one', label: 'config/changed.toml', role: 'configuration',
            reason: 'both-changed', protected: false,
            allowedChoices: ['keep-mine', 'use-pack', 'keep-both'],
            alternateOptions: [{ id: 'alternate-opaque-one', label: 'config/changed.pack.toml' }]
          }]
        };
      }
      const serverProperties = fs.readFileSync(path.join(serverPath, 'server.properties'), 'utf8');
      const planWithoutFingerprint = {
        type: 'modpack-preflight-plan',
        schemaVersion: 1,
        operation: {
          kind: request.operationKind,
          instanceId: request.instanceId,
          expectedContentRevision: 7
        },
        source,
        artifact: inspection.verifiedArtifactSet,
        inspection: inspection.result,
        serverSnapshot: {
          serverPath,
          serverPropertiesSha256: crypto.createHash('sha256').update(serverProperties).digest('hex')
        },
        selections: request.selections
      };
      const plan = { ...planWithoutFingerprint, fingerprint: computePreflightPlanFingerprint(planWithoutFingerprint) };
      const sanitizedView = {
        title: 'Reviewed Pack',
        server: { id: request.instanceId, contentRevision: 7 },
        source: { provider: 'github', version: '1.2.3' },
        runtime: { loader: 'fabric', minecraft: '1.21.1', loaderVersion: '0.16.14', java: 21 },
        changes: { added: 1, changed: 0, removed: 0, preserved: 2 },
        warnings: []
      };
      return {
        plan,
        sanitizedView: planMode === 'unsafe'
          ? { ...sanitizedView, serverPath, sourceUrl: internalSource.downloadUrl }
          : sanitizedView
      };
    }
  };
  const service = new ModpackLifecycleService({
    sourceResolver,
    artifactDownloader,
    archiveInspector,
    inspectionLoader: materializer,
    planningAdapter,
    planRegistry,
    operationStore
  });
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  return {
    get lastInspection() { return lastInspection; },
    get planningCalls() { return planningCalls; },
    operationStore,
    planRegistry,
    serverPath,
    service,
    setPlanMode(value) { planMode = value; },
    workspaceRegistry
  };
}

const SOURCE_REQUEST = Object.freeze({
  provider: 'github', repositoryId: '1001', releaseId: '2002', assetIds: ['asset-9001']
});

function planningRequest(inspectionId) {
  return {
    inspectionId,
    instanceId: 'server-0001',
    operationKind: 'install-existing',
    selections: {
      optionalFileIds: [],
      conflictChoices: {},
      acknowledgeMissingProviderDigest: true
    }
  };
}

test('inspect and plan preserve the exact source internally while the public plan is the reviewed view only', async (t) => {
  const context = fixture(t);
  await context.operationStore.initialize();
  const before = snapshotTree(context.serverPath);
  const inspected = await context.service.inspectSource(SOURCE_REQUEST);
  assert.equal(inspected.type, 'archive-inspection');
  assert.equal(inspected.integrity, 'tested');
  assert.equal(typeof inspected.inspectionId, 'string');
  assert.doesNotMatch(JSON.stringify(inspected), /objects\.example|token=|external-server/);

  const created = await context.service.createPlan(planningRequest(inspected.inspectionId));
  assert.deepEqual(created.planView, {
    title: 'Reviewed Pack',
    server: { id: 'server-0001', contentRevision: 7 },
    source: { provider: 'github', version: '1.2.3' },
    runtime: { loader: 'fabric', minecraft: '1.21.1', loaderVersion: '0.16.14', java: 21 },
    changes: { added: 1, changed: 0, removed: 0, preserved: 2 },
    warnings: []
  });
  assert.deepEqual(Object.keys(created).sort(), ['expiresAt', 'planFingerprint', 'planId', 'planView']);
  assert.doesNotMatch(JSON.stringify(created), /objects\.example|https?:|external-server|artifact-set|workspace/);
  assert.deepEqual(snapshotTree(context.serverPath), before);

  const internal = context.planRegistry.get({ planId: created.planId, fingerprint: created.planFingerprint });
  assert.match(internal.plan.source.downloadUrl, /^https:\/\//);
  assert.equal(internal.plan.serverSnapshot.serverPath, context.serverPath);
  assert.equal(context.workspaceRegistry.resolveOwnedId({
    ownerId: created.planId,
    id: context.lastInspection.artifactSetId,
    kind: 'artifact-set'
  }).id, context.lastInspection.artifactSetId);
  await assert.rejects(
    context.service.createPlan(planningRequest(inspected.inspectionId)),
    error => error.code === 'PLAN_STALE'
  );
});

test('unsafe planning output is rejected without consuming the inspection workspace', async (t) => {
  const context = fixture(t, { unsafePlanView: true });
  await context.operationStore.initialize();
  const inspected = await context.service.inspectSource(SOURCE_REQUEST);
  await assert.rejects(
    context.service.createPlan(planningRequest(inspected.inspectionId)),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.equal(context.workspaceRegistry.resolveOwnedId({
    ownerId: inspected.inspectionId,
    id: context.lastInspection.artifactSetId,
    kind: 'artifact-set'
  }).id, context.lastInspection.artifactSetId);

  context.setPlanMode('safe');
  const created = await context.service.createPlan(planningRequest(inspected.inspectionId));
  assert.equal(created.planView.title, 'Reviewed Pack');
  assert.equal(context.planningCalls, 2);
});

test('conflict-review preflight keeps the inspection session alive for the resolved second pass', async (t) => {
  const context = fixture(t);
  await context.operationStore.initialize();
  const inspected = await context.service.inspectSource(SOURCE_REQUEST);
  context.setPlanMode('conflict');

  const review = await context.service.createPlan(planningRequest(inspected.inspectionId));
  assert.equal(review.requiresConflictReview, true);
  assert.deepEqual(Object.keys(review).sort(), ['conflicts', 'requiresConflictReview']);
  assert.doesNotMatch(review.conflicts[0].id, /config|changed|toml/i);
  assert.equal(context.workspaceRegistry.resolveOwnedId({
    ownerId: inspected.inspectionId,
    id: context.lastInspection.artifactSetId,
    kind: 'artifact-set'
  }).id, context.lastInspection.artifactSetId);

  context.setPlanMode('safe');
  const created = await context.service.createPlan(planningRequest(inspected.inspectionId));
  assert.equal(created.planView.title, 'Reviewed Pack');
  assert.equal(context.planningCalls, 2);
});

test('renderer filesystem authority is rejected before planning runs', async (t) => {
  const context = fixture(t);
  await context.operationStore.initialize();
  const inspected = await context.service.inspectSource(SOURCE_REQUEST);
  await assert.rejects(
    context.service.createPlan({ ...planningRequest(inspected.inspectionId), serverPath: 'C:\\Other\\Server' }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.equal(context.planningCalls, 0);
  assert.equal(context.workspaceRegistry.resolveOwnedId({
    ownerId: inspected.inspectionId,
    id: context.lastInspection.artifactSetId,
    kind: 'artifact-set'
  }).id, context.lastInspection.artifactSetId);
});

test('durable job lookup and pre-commit cancellation remain service-owned', async (t) => {
  const context = fixture(t);
  await context.operationStore.initialize();
  const created = await context.operationStore.create({
    jobId: 'job-service',
    operationKind: 'install-existing',
    serverId: 'server-0001',
    planFingerprint: 'd'.repeat(64)
  });
  assert.deepEqual(await context.service.getJob(created.jobId), created);
  const cancelled = await context.service.cancelJob(created.jobId);
  assert.equal(cancelled.phase, 'cancelling');
  assert.equal(cancelled.cancellationRequested, true);
  await assert.rejects(context.service.getJob('job-unknown'), error => error.code === 'PLAN_STALE');
  await assert.rejects(context.service.cancelJob('job-unknown'), error => error.code === 'PLAN_STALE');
});
