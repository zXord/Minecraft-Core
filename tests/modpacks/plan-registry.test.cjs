const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { PlanRegistry, PLAN_TTL_MS } = require('../../electron/services/modpack-lifecycle/plan-registry.cjs');
const { deepFreeze } = require('../../electron/services/modpacks/errors.cjs');
const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');

function referenceCandidate() {
  return { schemaVersion: 1, id: 'restore-safety', name: 'restore-point-safety.zip', metadataName: 'restore-point-safety.json',
    sha256: 'a'.repeat(64), size: 31, totalBytes: '22', scopeSha256: 'b'.repeat(64), sourceRevision: 7,
    sourceRuntime: null, operationId: 'job-failed', createdAt: '2026-08-01T00:00:00.000Z' };
}

test('claimed rollback plan protects selected point after claim removes reviewed plan', async t => {
  const { registry, workspaceRegistry, advance } = fixture(t);
  const { planningSessionId } = planningWorkspace(workspaceRegistry);
  const base = internalPlan();
  const plan = { ...base, restorePoints: [{ id: 'restore-safety', sha256: 'a'.repeat(64) }] };
  plan.fingerprint = computePreflightPlanFingerprint(plan);
  const reviewed = registry.create({ plan, sanitizedView: publicView(), fingerprint: plan.fingerprint, planningSessionId });
  const query = { instanceId: 'server-a', candidate: referenceCandidate(), excludingJobId: 'job-failed' };
  assert.equal(registry.hasRestorePointReference(query), true);
  const claimed = await registry.claim({ planId: reviewed.planId, fingerprint: reviewed.fingerprint });
  advance(PLAN_TTL_MS + 1);
  assert.equal(registry.hasRestorePointReference({ ...query, excludingJobId: claimed.jobId }), true);
  assert.equal(await registry.releaseClaim(claimed.jobId), true);
  assert.equal(registry.hasRestorePointReference(query), false);
});

test('reviewed and claimed plan references fail closed on partial or conflicting identity, not equal digests', async t => {
  for (const reference of [
    { id: 'different', sha256: 'a'.repeat(64), want: false },
    { id: 'restore-safety', sha256: 'a'.repeat(64), want: true },
    { id: 'restore-safety', sha256: 'b'.repeat(64), error: true },
    { id: 'restore-safety', error: true },
    { id: 'different', sha256: 'a'.repeat(64), name: 'restore-point-safety.zip', error: true }
  ]) {
    const { registry, workspaceRegistry } = fixture(t);
    const { planningSessionId } = planningWorkspace(workspaceRegistry);
    const { want, error, ...point } = reference;
    const plan = { ...internalPlan(), restorePoints: [point] };
    plan.fingerprint = computePreflightPlanFingerprint(plan);
    const reviewed = registry.create({ plan, sanitizedView: publicView(), fingerprint: plan.fingerprint, planningSessionId });
    const query = { instanceId: 'server-a', candidate: referenceCandidate(), excludingJobId: 'job-failed' };
    for (const stage of ['reviewed', 'claimed']) {
      if (stage === 'claimed') await registry.claim({ planId: reviewed.planId, fingerprint: reviewed.fingerprint });
      if (error) assert.throws(() => registry.hasRestorePointReference(query));
      else assert.equal(registry.hasRestorePointReference(query), want);
    }
  }
});

test('failed claim release keeps private selected-point ownership', async t => {
  const { registry, workspaceRegistry } = fixture(t, { releaseFailure: () => true });
  const { planningSessionId } = planningWorkspace(workspaceRegistry);
  const plan = { ...internalPlan(), restorePoints: [{ id: 'restore-safety', sha256: 'a'.repeat(64) }] };
  plan.fingerprint = computePreflightPlanFingerprint(plan);
  const reviewed = registry.create({ plan, sanitizedView: publicView(), fingerprint: plan.fingerprint, planningSessionId });
  const claimed = await registry.claim({ planId: reviewed.planId, fingerprint: reviewed.fingerprint });
  await assert.rejects(registry.releaseClaim(claimed.jobId));
  assert.equal(registry.hasRestorePointReference({ instanceId: 'server-a', candidate: referenceCandidate(), excludingJobId: 'other' }), true);
});

test('duplicate-ID conflicting plans are incomplete reference proof even for another candidate', t => {
  const { registry, workspaceRegistry } = fixture(t);
  for (const sha256 of ['c'.repeat(64), 'd'.repeat(64)]) {
    const { planningSessionId } = planningWorkspace(workspaceRegistry);
    const plan = { ...internalPlan(), restorePoints: [{ id: 'unrelated-point', sha256 }] };
    plan.fingerprint = computePreflightPlanFingerprint(plan);
    registry.create({ plan, sanitizedView: publicView(), fingerprint: plan.fingerprint, planningSessionId });
  }
  assert.throws(() => registry.hasRestorePointReference({ instanceId: 'server-a', candidate: referenceCandidate(), excludingJobId: 'job-failed' }));
});

function fixture(t, { transferFailure = null, releaseFailure = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-plan-registry-'));
  let workspaceId = 0;
  let now = Date.parse('2026-08-02T00:00:00.000Z');
  const baseWorkspace = new ArtifactWorkspaceRegistry({
    root,
    clock: () => now,
    idFactory: () => `workspace-${++workspaceId}`
  });
  const workspaceRegistry = transferFailure === null && releaseFailure === null ? baseWorkspace : {
    createPlanningSession: (...args) => baseWorkspace.createPlanningSession(...args),
    createStagingOutput: (...args) => baseWorkspace.createStagingOutput(...args),
    resolveOwnedId: (...args) => baseWorkspace.resolveOwnedId(...args),
    releaseOwner(ownerId) {
      if (releaseFailure?.(ownerId)) throw new Error('injected ownership release failure');
      return baseWorkspace.releaseOwner(ownerId);
    },
    transferOwnership(request) {
      if (transferFailure?.(request)) throw new Error('injected ownership transfer failure');
      return baseWorkspace.transferOwnership(request);
    }
  };
  let registryId = 0;
  const dependencies = {
    workspaceRegistry,
    clock: () => now,
    randomUUID: () => `registry-${++registryId}`
  };
  const registry = new PlanRegistry(dependencies);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    advance(milliseconds) { now += milliseconds; },
    baseWorkspace,
    dependencies,
    registry,
    workspaceRegistry
  };
}

function internalPlan({ serverId = 'server-a' } = {}) {
  const plan = {
    type: 'modpack-preflight-plan',
    schemaVersion: 1,
    operation: { instanceId: serverId, expectedContentRevision: 7 },
    source: {
      provider: 'github',
      releaseId: '42',
      downloadUrl: 'https://example.invalid/private?token=secret'
    },
    workspace: {
      cachePath: 'C:\\MinecraftCore\\cache\\artifact.zip',
      artifactSetId: 'artifact-set-internal'
    }
  };
  return { ...plan, fingerprint: computePreflightPlanFingerprint(plan) };
}

function publicView({ title = 'Reviewed Pack', serverId = 'server-a' } = {}) {
  return {
    title,
    server: { id: serverId, contentRevision: 7 },
    source: { provider: 'github', version: '1.2.3' },
    changes: { added: 12, changed: 3, removed: 1 },
    warnings: []
  };
}

function planningWorkspace(workspaceRegistry) {
  const planningSessionId = workspaceRegistry.createPlanningSession();
  const outputDirectoryId = workspaceRegistry.createStagingOutput({ ownerId: planningSessionId });
  return { outputDirectoryId, planningSessionId };
}

function launchPlan() {
  const plan = internalPlan();
  plan.operation = { ...plan.operation, serverKind: 'new' };
  plan.fingerprint = computePreflightPlanFingerprint(plan);
  return plan;
}

test('launch credential read retains only issued fingerprint across invalidation and claim cleanup without replay authority', async t => {
  const { dependencies, workspaceRegistry, advance } = fixture(t);
  let sequence = 0;
  const registry = new PlanRegistry({ ...dependencies, allowNewServerLaunchBindings: true,
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` });
  const create = () => {
    const plan = launchPlan();
    return registry.create({ plan, sanitizedView: publicView(), fingerprint: plan.fingerprint,
      planningSessionId: planningWorkspace(workspaceRegistry).planningSessionId });
  };
  const invalidated = create();
  assert.equal(registry.readIssuedNewServerPlanFingerprint(invalidated.planId), invalidated.fingerprint);
  await registry.invalidate(invalidated.planId);
  const claimedPlan = create();
  const claim = await registry.claim({ planId: claimedPlan.planId, fingerprint: claimedPlan.fingerprint });
  await registry.releaseClaim(claim.jobId);
  advance(PLAN_TTL_MS + 1);
  const fence = registry.fenceGeneration;
  const release = workspaceRegistry.releaseOwner;
  workspaceRegistry.releaseOwner = () => assert.fail('credential read must not release workspace ownership');
  try {
    for (const issued of [invalidated, claimedPlan]) {
      assert.equal(registry.readIssuedNewServerPlanFingerprint(issued.planId), issued.fingerprint);
      await assert.rejects(registry.claim({ planId: issued.planId, fingerprint: issued.fingerprint }), { code: 'PLAN_STALE' });
    }
    assert.equal(registry.readIssuedNewServerPlanFingerprint(claim.jobId), null);
    assert.equal(registry.readIssuedNewServerPlanFingerprint('plan-launch-v1-00000000-0000-4000-8000-999999999999'), null);
    assert.equal(new PlanRegistry({ ...dependencies, allowNewServerLaunchBindings: true })
      .readIssuedNewServerPlanFingerprint(invalidated.planId), null);
    assert.equal(registry.fenceGeneration, fence);
  } finally { workspaceRegistry.releaseOwner = release; }
  registry.randomUUID = () => invalidated.planId.slice('plan-launch-v1-'.length);
  assert.throws(create, { code: 'PLAN_STALE' }, 'issued IDs are never reused after cleanup');
});

for (const failure of ['transfer', 'clock']) test(`launch credential read never publishes a failed create credential: ${failure}`, t => {
  const { dependencies, workspaceRegistry } = fixture(t);
  const suffix = '00000000-0000-4000-8000-000000000001';
  const registry = new PlanRegistry({ ...dependencies, allowNewServerLaunchBindings: true, randomUUID: () => suffix });
  const plan = launchPlan();
  const request = { plan, sanitizedView: publicView(), fingerprint: plan.fingerprint,
    planningSessionId: planningWorkspace(workspaceRegistry).planningSessionId };
  if (failure === 'transfer') registry.workspaceRegistry = { ...dependencies.workspaceRegistry,
    transferOwnership() { throw new Error('injected create transfer failure'); } };
  else registry.clock = () => Number.MAX_SAFE_INTEGER;
  assert.throws(() => registry.create(request));
  const id = `plan-launch-v1-${suffix}`;
  assert.equal(registry.readIssuedNewServerPlanFingerprint(id), null);
  assert.equal(registry.plans.has(id), false);
  registry.workspaceRegistry = workspaceRegistry; registry.clock = dependencies.clock;
  assert.throws(() => registry.create(request), { code: 'PLAN_STALE' }, 'failed allocated IDs are not recycled');
});

test('launch credential read excludes ordinary plan IDs even after successful issue', t => {
  const { registry, workspaceRegistry } = fixture(t); const plan = internalPlan();
  const created = registry.create({ plan, sanitizedView: publicView(), fingerprint: plan.fingerprint,
    planningSessionId: planningWorkspace(workspaceRegistry).planningSessionId });
  assert.equal(registry.readIssuedNewServerPlanFingerprint(created.planId), null);
  assert.throws(() => registry.readIssuedNewServerPlanFingerprint('C:\\private'), { code: 'INVALID_REQUEST' });
});

test('launch synchronous claim fence permits only one concurrent claimant', async t => {
  const { registry, workspaceRegistry } = fixture(t);
  const plan = internalPlan();
  const created = registry.create({ plan, sanitizedView: publicView(), fingerprint: plan.fingerprint,
    planningSessionId: planningWorkspace(workspaceRegistry).planningSessionId });
  const results = await Promise.allSettled([registry.claim({ planId: created.planId, fingerprint: created.fingerprint }),
    registry.claim({ planId: created.planId, fingerprint: created.fingerprint })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'PLAN_STALE');
});

test('launch synchronous invalidation fence survives deferred cleanup and captured credential', async t => {
  const { registry, workspaceRegistry } = fixture(t);
  const plan = internalPlan();
  const created = registry.create({ plan, sanitizedView: publicView(), fingerprint: plan.fingerprint,
    planningSessionId: planningWorkspace(workspaceRegistry).planningSessionId });
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const release = workspaceRegistry.releaseOwner.bind(workspaceRegistry);
  workspaceRegistry.releaseOwner = async id => { await gate; return release(id); };
  const claim = registry.claim({ planId: created.planId, fingerprint: created.fingerprint });
  const invalidation = registry.invalidate(created.planId);
  try { await assert.rejects(claim, { code: 'PLAN_STALE' }); }
  finally { finish(); await invalidation; }
});

test('create returns exactly the reviewed view while retaining the internal plan in memory', async (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const { outputDirectoryId, planningSessionId } = planningWorkspace(workspaceRegistry);
  const plan = internalPlan();
  const sanitizedView = publicView();
  const created = registry.create({
    plan,
    sanitizedView,
    fingerprint: plan.fingerprint,
    planningSessionId
  });

  assert.deepEqual(created, {
    planId: 'plan-registry-1',
    fingerprint: plan.fingerprint,
    planView: publicView(),
    expiresAt: '2026-08-02T02:00:00.000Z'
  });
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.planView.server), true);
  assert.equal(JSON.stringify(created).includes('downloadUrl'), false);
  assert.equal(JSON.stringify(created).includes('MinecraftCore'), false);

  plan.source.releaseId = 'mutated';
  sanitizedView.title = 'mutated';
  const internal = await registry.get({ planId: created.planId, fingerprint: created.fingerprint });
  assert.equal(internal.plan.source.releaseId, '42');
  assert.equal(internal.planView.title, 'Reviewed Pack');
  assert.equal(workspaceRegistry.resolveOwnedId({
    ownerId: created.planId,
    id: outputDirectoryId,
    kind: 'output'
  }).id, outputDirectoryId);
});

test('registry retains a reviewed plan larger than the generic JSON clone budget', async (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const { planningSessionId } = planningWorkspace(workspaceRegistry);
  const planWithoutFingerprint = internalPlan();
  delete planWithoutFingerprint.fingerprint;
  planWithoutFingerprint.preconditions = {
    paths: Array.from({ length: 3_000 }, (_, index) => ({
      pathKey: `mods/example-${index}.jar`,
      exists: index % 2 === 0,
      size: String(index)
    }))
  };
  const plan = {
    ...planWithoutFingerprint,
    fingerprint: computePreflightPlanFingerprint(planWithoutFingerprint)
  };

  const created = registry.create({
    plan,
    sanitizedView: publicView(),
    fingerprint: plan.fingerprint,
    planningSessionId
  });
  const retained = await registry.get({ planId: created.planId, fingerprint: created.fingerprint });
  assert.equal(retained.plan.preconditions.paths.length, 3_000);
});

test('a fingerprint cannot execute without its one-use plan ID or across server plans', async (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const firstWorkspace = planningWorkspace(workspaceRegistry);
  const secondWorkspace = planningWorkspace(workspaceRegistry);
  const firstPlan = internalPlan({ serverId: 'server-a' });
  const secondPlan = internalPlan({ serverId: 'server-b' });
  const first = registry.create({
    plan: firstPlan,
    sanitizedView: publicView({ serverId: 'server-a' }),
    fingerprint: firstPlan.fingerprint,
    planningSessionId: firstWorkspace.planningSessionId
  });
  const second = registry.create({
    plan: secondPlan,
    sanitizedView: publicView({ title: 'Other Pack', serverId: 'server-b' }),
    fingerprint: secondPlan.fingerprint,
    planningSessionId: secondWorkspace.planningSessionId
  });

  await assert.rejects(registry.claim({ fingerprint: first.fingerprint }), error => error.code === 'PLAN_STALE');
  await assert.rejects(
    registry.claim({ planId: 'wrong', fingerprint: first.fingerprint }),
    error => error.code === 'PLAN_STALE'
  );
  await assert.rejects(
    registry.claim({ planId: first.planId, fingerprint: second.fingerprint }),
    error => error.code === 'PLAN_STALE'
  );

  const claimed = await registry.claim({ planId: first.planId, fingerprint: first.fingerprint });
  assert.match(claimed.jobId, /^op2-[0-9a-f]{32}$/u);
  assert.equal(claimed.plan.operation.instanceId, 'server-a');
  await assert.rejects(registry.claim({ planId: first.planId, fingerprint: first.fingerprint }), error => error.code === 'PLAN_STALE');
  await assert.rejects(registry.get({ planId: first.planId, fingerprint: first.fingerprint }), error => error.code === 'PLAN_STALE');
  assert.equal(workspaceRegistry.resolveOwnedId({
    ownerId: claimed.jobId,
    id: firstWorkspace.outputDirectoryId,
    kind: 'output'
  }).id, firstWorkspace.outputDirectoryId);
  assert.throws(() => workspaceRegistry.resolveOwnedId({
    ownerId: first.planId,
    id: firstWorkspace.outputDirectoryId,
    kind: 'output'
  }), error => error.code === 'PLAN_STALE');
});

test('expiry is fixed at two hours, releases workspaces, and a new registry has no old plans', async (t) => {
  const { advance, dependencies, registry, workspaceRegistry } = fixture(t);
  const workspace = planningWorkspace(workspaceRegistry);
  const plan = internalPlan();
  const created = registry.create({
    plan,
    sanitizedView: publicView(),
    fingerprint: plan.fingerprint,
    planningSessionId: workspace.planningSessionId
  });
  advance(60 * 60 * 1000);
  assert.equal((await registry.get({ planId: created.planId, fingerprint: created.fingerprint })).planId, created.planId);
  advance(60 * 60 * 1000);
  await assert.rejects(registry.get({ planId: created.planId, fingerprint: created.fingerprint }), error => error.code === 'PLAN_STALE');
  assert.throws(() => workspaceRegistry.resolveOwnedId({
    ownerId: created.planId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }), error => error.code === 'PLAN_STALE');

  const restarted = new PlanRegistry(dependencies);
  await assert.rejects(restarted.get({ planId: created.planId, fingerprint: created.fingerprint }), error => error.code === 'PLAN_STALE');
  assert.equal(await registry.invalidate(created.planId), false);
  assert.equal(PLAN_TTL_MS, 2 * 60 * 60 * 1000);
});

test('unsafe reviewed fields and values fail before workspace ownership changes', (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const cases = [
    { serverPath: 'C:\\Minecraft\\Server' },
    { downloadUrl: 'https://example.invalid/archive.zip' },
    { cacheKey: 'sha256-value' },
    { workspaceId: 'workspace-internal' },
    { providerInternal: { raw: true } },
    { description: 'file:///C:/Minecraft/Server' },
    { description: 'C:\\Minecraft\\Server' },
    { opaqueRef: 'artifact-set-internal' }
  ];
  for (const [index, leak] of cases.entries()) {
    const workspace = planningWorkspace(workspaceRegistry);
    const plan = internalPlan();
    assert.throws(() => registry.create({
      plan,
      sanitizedView: { ...publicView(), leak },
      fingerprint: plan.fingerprint,
      planningSessionId: workspace.planningSessionId
    }), error => error.code === 'INVALID_REQUEST', `case ${index}`);
    assert.equal(workspaceRegistry.resolveOwnedId({
      ownerId: workspace.planningSessionId,
      id: workspace.outputDirectoryId,
      kind: 'output'
    }).id, workspace.outputDirectoryId);
  }

  let getterCalls = 0;
  const unsafeView = publicView();
  Object.defineProperty(unsafeView, 'title', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    }
  });
  const workspace = planningWorkspace(workspaceRegistry);
  const accessorPlan = internalPlan();
  assert.throws(() => registry.create({
    plan: accessorPlan,
    sanitizedView: unsafeView,
    fingerprint: accessorPlan.fingerprint,
    planningSessionId: workspace.planningSessionId
  }), error => error.code === 'INVALID_REQUEST');
  assert.equal(getterCalls, 0);
});

test('a failed claim transfer leaves the plan available for an exact retry', async (t) => {
  let failClaim = true;
  const { baseWorkspace, registry, workspaceRegistry } = fixture(t, {
    transferFailure: ({ fromOwnerId }) => fromOwnerId.startsWith('plan-') && failClaim
  });
  const workspace = planningWorkspace(workspaceRegistry);
  const plan = internalPlan();
  const created = registry.create({
    plan,
    sanitizedView: publicView(),
    fingerprint: plan.fingerprint,
    planningSessionId: workspace.planningSessionId
  });
  await assert.rejects(
    registry.claim({ planId: created.planId, fingerprint: created.fingerprint }),
    /injected ownership transfer failure/
  );
  assert.equal((await registry.get({ planId: created.planId, fingerprint: created.fingerprint })).planId, created.planId);
  assert.equal(baseWorkspace.resolveOwnedId({
    ownerId: created.planId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }).id, workspace.outputDirectoryId);

  failClaim = false;
  const claimed = await registry.claim({ planId: created.planId, fingerprint: created.fingerprint });
  assert.equal(baseWorkspace.resolveOwnedId({
    ownerId: claimed.jobId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }).id, workspace.outputDirectoryId);
});

test('registry admission recomputes the fingerprint over server artifact and workspace state', (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const workspace = planningWorkspace(workspaceRegistry);
  const reviewed = internalPlan();
  const changed = structuredClone(reviewed);
  changed.operation.expectedContentRevision = 8;

  assert.throws(() => registry.create({
    plan: changed,
    sanitizedView: publicView(),
    fingerprint: reviewed.fingerprint,
    planningSessionId: workspace.planningSessionId
  }), error => error.code === 'INVALID_REQUEST');
  assert.equal(workspaceRegistry.resolveOwnedId({
    ownerId: workspace.planningSessionId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }).id, workspace.outputDirectoryId);
});

test('claim preserves deeply frozen app-issued plan identity for downstream validation', async (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const workspace = planningWorkspace(workspaceRegistry);
  const appIssuedPlan = deepFreeze(internalPlan());
  const created = registry.create({
    plan: appIssuedPlan,
    sanitizedView: publicView(),
    fingerprint: appIssuedPlan.fingerprint,
    planningSessionId: workspace.planningSessionId
  });

  assert.equal((await registry.get({ planId: created.planId, fingerprint: created.fingerprint })).plan, appIssuedPlan);
  assert.equal((await registry.claim({ planId: created.planId, fingerprint: created.fingerprint })).plan, appIssuedPlan);
});

test('releaseClaim frees only an exact successfully claimed job owner and rejects replay', async (t) => {
  const { baseWorkspace, registry, workspaceRegistry } = fixture(t);
  const workspace = planningWorkspace(workspaceRegistry);
  const plan = internalPlan();
  const created = registry.create({
    plan,
    sanitizedView: publicView(),
    fingerprint: plan.fingerprint,
    planningSessionId: workspace.planningSessionId
  });
  const claimed = await registry.claim({ planId: created.planId, fingerprint: created.fingerprint });

  assert.equal(await registry.releaseClaim('job-not-issued'), false);
  assert.equal(baseWorkspace.resolveOwnedId({
    ownerId: claimed.jobId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }).id, workspace.outputDirectoryId);
  assert.equal(await registry.releaseClaim(claimed.jobId), true);
  assert.throws(() => baseWorkspace.resolveOwnedId({
    ownerId: claimed.jobId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }), error => error.code === 'PLAN_STALE');
  assert.equal(await registry.releaseClaim(claimed.jobId), false);
});

test('a failed claimed-workspace release remains tracked for an exact retry', async (t) => {
  let failRelease = true;
  const { baseWorkspace, registry, workspaceRegistry } = fixture(t, {
    releaseFailure: ownerId => ownerId.startsWith('op2-') && failRelease
  });
  const workspace = planningWorkspace(workspaceRegistry);
  const plan = internalPlan();
  const created = registry.create({
    plan,
    sanitizedView: publicView(),
    fingerprint: plan.fingerprint,
    planningSessionId: workspace.planningSessionId
  });
  const claimed = await registry.claim({ planId: created.planId, fingerprint: created.fingerprint });

  await assert.rejects(registry.releaseClaim(claimed.jobId), /injected ownership release failure/);
  assert.equal(baseWorkspace.resolveOwnedId({
    ownerId: claimed.jobId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }).id, workspace.outputDirectoryId);
  failRelease = false;
  assert.equal(await registry.releaseClaim(claimed.jobId), true);
  assert.equal(await registry.releaseClaim(claimed.jobId), false);
});

test('dispose awaits release of every unclaimed plan workspace and is idempotent', async (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const workspaces = [planningWorkspace(workspaceRegistry), planningWorkspace(workspaceRegistry)];
  const created = workspaces.map((workspace, index) => {
    const plan = internalPlan({ serverId: `server-${index + 1}` });
    return registry.create({
      plan,
      sanitizedView: publicView({ serverId: `server-${index + 1}` }),
      fingerprint: plan.fingerprint,
      planningSessionId: workspace.planningSessionId
    });
  });
  const workspacePaths = workspaces.map(workspace => path.join(
    workspaceRegistry.root,
    workspace.outputDirectoryId
  ));
  assert.equal(workspacePaths.every(candidate => fs.existsSync(candidate)), true);

  assert.equal(await registry.dispose(), 2);

  assert.equal(workspacePaths.every(candidate => !fs.existsSync(candidate)), true);
  for (const plan of created) {
    await assert.rejects(
      registry.get({ planId: plan.planId, fingerprint: plan.fingerprint }),
      error => error.code === 'PLAN_STALE'
    );
  }
  assert.equal(await registry.dispose(), 0);
});

test('dispose retains only a failed plan so the exact cleanup can be retried', async (t) => {
  let failedPlanId = null;
  let failRelease = true;
  const { baseWorkspace, registry, workspaceRegistry } = fixture(t, {
    releaseFailure: ownerId => ownerId === failedPlanId && failRelease
  });
  const failedWorkspace = planningWorkspace(workspaceRegistry);
  const releasedWorkspace = planningWorkspace(workspaceRegistry);
  const failedPlan = internalPlan({ serverId: 'server-failed' });
  const releasedPlan = internalPlan({ serverId: 'server-released' });
  const failed = registry.create({
    plan: failedPlan,
    sanitizedView: publicView({ serverId: 'server-failed' }),
    fingerprint: failedPlan.fingerprint,
    planningSessionId: failedWorkspace.planningSessionId
  });
  const released = registry.create({
    plan: releasedPlan,
    sanitizedView: publicView({ serverId: 'server-released' }),
    fingerprint: releasedPlan.fingerprint,
    planningSessionId: releasedWorkspace.planningSessionId
  });
  failedPlanId = failed.planId;

  await assert.rejects(registry.dispose(), /injected ownership release failure/);
  await assert.rejects(registry.get({ planId: failed.planId, fingerprint: failed.fingerprint }), { code: 'PLAN_STALE' });
  await assert.rejects(
    registry.get({ planId: released.planId, fingerprint: released.fingerprint }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(baseWorkspace.resolveOwnedId({
    ownerId: failed.planId,
    id: failedWorkspace.outputDirectoryId,
    kind: 'output'
  }).id, failedWorkspace.outputDirectoryId);
  assert.throws(() => baseWorkspace.resolveOwnedId({
    ownerId: released.planId,
    id: releasedWorkspace.outputDirectoryId,
    kind: 'output'
  }), error => error.code === 'PLAN_STALE');

  failRelease = false;
  assert.equal(await registry.dispose(), 1);
  await assert.rejects(
    registry.get({ planId: failed.planId, fingerprint: failed.fingerprint }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(await registry.dispose(), 0);
});

test('dispose retains claimed job ownership for active or recoverable operations', async (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const claimedWorkspace = planningWorkspace(workspaceRegistry);
  const unclaimedWorkspace = planningWorkspace(workspaceRegistry);
  const claimedPlan = internalPlan({ serverId: 'server-active' });
  const unclaimedPlan = internalPlan({ serverId: 'server-unclaimed' });
  const createdClaimed = registry.create({
    plan: claimedPlan,
    sanitizedView: publicView({ serverId: 'server-active' }),
    fingerprint: claimedPlan.fingerprint,
    planningSessionId: claimedWorkspace.planningSessionId
  });
  registry.create({
    plan: unclaimedPlan,
    sanitizedView: publicView({ serverId: 'server-unclaimed' }),
    fingerprint: unclaimedPlan.fingerprint,
    planningSessionId: unclaimedWorkspace.planningSessionId
  });
  const claimed = await registry.claim({
    planId: createdClaimed.planId,
    fingerprint: createdClaimed.fingerprint
  });

  assert.equal(await registry.dispose(), 1);

  assert.equal(workspaceRegistry.resolveOwnedId({
    ownerId: claimed.jobId,
    id: claimedWorkspace.outputDirectoryId,
    kind: 'output'
  }).id, claimedWorkspace.outputDirectoryId);
  assert.equal(fs.existsSync(path.join(
    workspaceRegistry.root,
    unclaimedWorkspace.outputDirectoryId
  )), false);
  assert.equal(await registry.releaseClaim(claimed.jobId), true);
});
