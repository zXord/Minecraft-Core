const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');

function registryFixture({ idFactory } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-workspace-'));
  let now = 0;
  const registry = new ArtifactWorkspaceRegistry({ root, clock: () => now, idFactory: idFactory || (() => { let n = 0; return () => `id-${++n}`; })() });
  return { registry, root, advance(ms) { now += ms; }, cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}

const verifiedSet = Object.freeze({ type: 'verified-artifact-set', artifactSet: Object.freeze({ primaryPartId: 'part-1', parts: Object.freeze([]) }) });

test('workspace IDs are owner-bound and never substitute paths', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const id = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  assert.throws(
    () => f.registry.resolveOwnedId({ ownerId: 'plan-b', id, kind: 'output' }),
    error => error.code === 'PLAN_STALE'
  );
});

test('planning sessions and workspace IDs stay unique when the random source collides', (t) => {
  const values = ['same', 'same', 'next', 'same', 'last'];
  const f = registryFixture({ idFactory: () => values.shift() }); t.after(f.cleanup);
  const planningA = f.registry.createPlanningSession();
  const planningB = f.registry.createPlanningSession();
  assert.notEqual(planningA, planningB);
  const outputA = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  const outputB = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  assert.notEqual(outputA, outputB);
});

test('opaque IDs expire, cannot replay after release, and reject cross-kind substitution', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const id = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: 'plan-a', id, kind: 'input' }), error => error.code === 'PLAN_STALE');
  f.advance(30 * 60 * 1000);
  assert.equal(f.registry.sweepExpired(30 * 60 * 1000), 1);
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: 'plan-a', id, kind: 'output' }), error => error.code === 'PLAN_STALE');
  const replacement = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  f.registry.releaseOwner('plan-a');
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: 'plan-a', id: replacement, kind: 'output' }), error => error.code === 'PLAN_STALE');
});

test('an ID is claimable until but not including its exact 30-minute inactivity boundary', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const id = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  f.advance((30 * 60 * 1000) - 1);
  assert.equal(f.registry.resolveOwnedId({ ownerId: 'plan-a', id, kind: 'output' }).id, id);
  f.advance(30 * 60 * 1000);
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: 'plan-a', id, kind: 'output' }), error => error.code === 'PLAN_STALE');
});

test('records reject renderer-supplied path fields and resolve only opaque internal records', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  assert.throws(
    () => f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet: { ...verifiedSet, path: 'C:\\secret' } }),
    error => error.code === 'INVALID_REQUEST'
  );
  const artifactSetId = f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet });
  assert.throws(
    () => f.registry.createInspection({ ownerId: 'plan-a', artifactSetId, result: { archivePath: 'C:\\secret' } }),
    error => error.code === 'INVALID_REQUEST'
  );
  const inspectionId = f.registry.createInspection({ ownerId: 'plan-a', artifactSetId, result: { archiveFamily: 'zip' } });
  assert.equal(f.registry.resolveOwnedId({ ownerId: 'plan-a', id: inspectionId, kind: 'inspection' }).result.archiveFamily, 'zip');
});

test('transfers every owner record atomically so old IDs cannot be replayed', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const artifactSetId = f.registry.registerVerifiedSet({ ownerId: 'planning-1', verifiedSet });
  const outputId = f.registry.createStagingOutput({ ownerId: 'planning-1' });
  const inspectionId = f.registry.createInspection({ ownerId: 'planning-1', artifactSetId, result: { archiveFamily: 'zip' } });
  assert.equal(f.registry.transferOwnership({ fromOwnerId: 'planning-1', toOwnerId: 'plan-1' }), 3);
  for (const [id, kind] of [[artifactSetId, 'artifact-set'], [outputId, 'output'], [inspectionId, 'inspection']]) {
    assert.throws(() => f.registry.resolveOwnedId({ ownerId: 'planning-1', id, kind }), error => error.code === 'PLAN_STALE');
    assert.equal(f.registry.resolveOwnedId({ ownerId: 'plan-1', id, kind }).id, id);
  }
});

test('materializes a registered set into an owner-bound input ID without returning a renderer path', async (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  f.registry.artifactCache = { materializeSet: async (_set, destination) => {
    fs.mkdirSync(destination, { recursive: true });
    const primaryPath = path.join(destination, 'server.zip');
    fs.writeFileSync(primaryPath, 'archive');
    return primaryPath;
  } };
  const artifactSetId = f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet });
  const inputDirectoryId = await f.registry.materializeInput({ ownerId: 'plan-a', artifactSetId });
  assert.match(inputDirectoryId, /^input-/);
  assert.equal(fs.existsSync(f.registry.resolveOwnedId({ ownerId: 'plan-a', id: inputDirectoryId, kind: 'input' }).value.primaryPath), true);
});

test('failed ownership transfer leaves every record with its original owner', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const staleId = f.registry.createStagingOutput({ ownerId: 'planning-1' });
  const freshId = f.registry.createStagingOutput({ ownerId: 'planning-1' });
  f.advance((30 * 60 * 1000) - 1);
  f.registry.resolveOwnedId({ ownerId: 'planning-1', id: freshId, kind: 'output' });
  f.advance(1);
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: 'planning-1', toOwnerId: 'plan-1' }), error => error.code === 'PLAN_STALE');
  assert.equal(f.registry.resolveOwnedId({ ownerId: 'planning-1', id: freshId, kind: 'output' }).id, freshId);
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: 'plan-1', id: freshId, kind: 'output' }), error => error.code === 'PLAN_STALE');
  assert.equal(f.registry.sweepExpired(30 * 60 * 1000), 1);
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: 'planning-1', id: staleId, kind: 'output' }), error => error.code === 'PLAN_STALE');
});
