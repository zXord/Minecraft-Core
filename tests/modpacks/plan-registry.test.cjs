const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { PlanRegistry, PLAN_TTL_MS } = require('../../electron/services/modpack-lifecycle/plan-registry.cjs');
const { deepFreeze } = require('../../electron/services/modpacks/errors.cjs');
const { computePreflightPlanFingerprint } = require('../../electron/services/modpacks/planning/plan-fingerprint.cjs');

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

test('create returns exactly the reviewed view while retaining the internal plan in memory', (t) => {
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
  const internal = registry.get({ planId: created.planId, fingerprint: created.fingerprint });
  assert.equal(internal.plan.source.releaseId, '42');
  assert.equal(internal.planView.title, 'Reviewed Pack');
  assert.equal(workspaceRegistry.resolveOwnedId({
    ownerId: created.planId,
    id: outputDirectoryId,
    kind: 'output'
  }).id, outputDirectoryId);
});

test('a fingerprint cannot execute without its one-use plan ID or across server plans', (t) => {
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

  assert.throws(() => registry.claim({ fingerprint: first.fingerprint }), error => error.code === 'PLAN_STALE');
  assert.throws(
    () => registry.claim({ planId: 'wrong', fingerprint: first.fingerprint }),
    error => error.code === 'PLAN_STALE'
  );
  assert.throws(
    () => registry.claim({ planId: first.planId, fingerprint: second.fingerprint }),
    error => error.code === 'PLAN_STALE'
  );

  const claimed = registry.claim({ planId: first.planId, fingerprint: first.fingerprint });
  assert.equal(claimed.jobId, 'job-registry-3');
  assert.equal(claimed.plan.operation.instanceId, 'server-a');
  assert.throws(() => registry.claim({ planId: first.planId, fingerprint: first.fingerprint }), error => error.code === 'PLAN_STALE');
  assert.throws(() => registry.get({ planId: first.planId, fingerprint: first.fingerprint }), error => error.code === 'PLAN_STALE');
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

test('expiry is fixed at two hours, releases workspaces, and a new registry has no old plans', (t) => {
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
  assert.equal(registry.get({ planId: created.planId, fingerprint: created.fingerprint }).planId, created.planId);
  advance(60 * 60 * 1000);
  assert.throws(() => registry.get({ planId: created.planId, fingerprint: created.fingerprint }), error => error.code === 'PLAN_STALE');
  assert.throws(() => workspaceRegistry.resolveOwnedId({
    ownerId: created.planId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }), error => error.code === 'PLAN_STALE');

  const restarted = new PlanRegistry(dependencies);
  assert.throws(() => restarted.get({ planId: created.planId, fingerprint: created.fingerprint }), error => error.code === 'PLAN_STALE');
  assert.equal(registry.invalidate(created.planId), false);
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

test('a failed claim transfer leaves the plan available for an exact retry', (t) => {
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
  assert.throws(
    () => registry.claim({ planId: created.planId, fingerprint: created.fingerprint }),
    /injected ownership transfer failure/
  );
  assert.equal(registry.get({ planId: created.planId, fingerprint: created.fingerprint }).planId, created.planId);
  assert.equal(baseWorkspace.resolveOwnedId({
    ownerId: created.planId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }).id, workspace.outputDirectoryId);

  failClaim = false;
  const claimed = registry.claim({ planId: created.planId, fingerprint: created.fingerprint });
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

test('claim preserves deeply frozen app-issued plan identity for downstream validation', (t) => {
  const { registry, workspaceRegistry } = fixture(t);
  const workspace = planningWorkspace(workspaceRegistry);
  const appIssuedPlan = deepFreeze(internalPlan());
  const created = registry.create({
    plan: appIssuedPlan,
    sanitizedView: publicView(),
    fingerprint: appIssuedPlan.fingerprint,
    planningSessionId: workspace.planningSessionId
  });

  assert.equal(registry.get({ planId: created.planId, fingerprint: created.fingerprint }).plan, appIssuedPlan);
  assert.equal(registry.claim({ planId: created.planId, fingerprint: created.fingerprint }).plan, appIssuedPlan);
});

test('releaseClaim frees only an exact successfully claimed job owner and rejects replay', (t) => {
  const { baseWorkspace, registry, workspaceRegistry } = fixture(t);
  const workspace = planningWorkspace(workspaceRegistry);
  const plan = internalPlan();
  const created = registry.create({
    plan,
    sanitizedView: publicView(),
    fingerprint: plan.fingerprint,
    planningSessionId: workspace.planningSessionId
  });
  const claimed = registry.claim({ planId: created.planId, fingerprint: created.fingerprint });

  assert.equal(registry.releaseClaim('job-not-issued'), false);
  assert.equal(baseWorkspace.resolveOwnedId({
    ownerId: claimed.jobId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }).id, workspace.outputDirectoryId);
  assert.equal(registry.releaseClaim(claimed.jobId), true);
  assert.throws(() => baseWorkspace.resolveOwnedId({
    ownerId: claimed.jobId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }), error => error.code === 'PLAN_STALE');
  assert.equal(registry.releaseClaim(claimed.jobId), false);
});

test('a failed claimed-workspace release remains tracked for an exact retry', (t) => {
  let failRelease = true;
  const { baseWorkspace, registry, workspaceRegistry } = fixture(t, {
    releaseFailure: ownerId => ownerId.startsWith('job-') && failRelease
  });
  const workspace = planningWorkspace(workspaceRegistry);
  const plan = internalPlan();
  const created = registry.create({
    plan,
    sanitizedView: publicView(),
    fingerprint: plan.fingerprint,
    planningSessionId: workspace.planningSessionId
  });
  const claimed = registry.claim({ planId: created.planId, fingerprint: created.fingerprint });

  assert.throws(() => registry.releaseClaim(claimed.jobId), /injected ownership release failure/);
  assert.equal(baseWorkspace.resolveOwnedId({
    ownerId: claimed.jobId,
    id: workspace.outputDirectoryId,
    kind: 'output'
  }).id, workspace.outputDirectoryId);
  failRelease = false;
  assert.equal(registry.releaseClaim(claimed.jobId), true);
  assert.equal(registry.releaseClaim(claimed.jobId), false);
});
