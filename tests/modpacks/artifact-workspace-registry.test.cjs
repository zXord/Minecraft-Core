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

const verifiedSet = Object.freeze({
  type: 'verified-artifact-set',
  artifactSet: Object.freeze({ primaryPartId: 'part-1', parts: Object.freeze([]), setDigest: 'a'.repeat(64) })
});

test('workspace IDs are owner-bound and never substitute paths', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const id = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  assert.throws(
    () => f.registry.resolveOwnedId({ ownerId: 'plan-b', id, kind: 'output' }),
    error => error.code === 'PLAN_STALE'
  );
});

test('trusted composition resolves only an owner-bound materialized workspace', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const id = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  const resolved = f.registry.resolveOwnedWorkspace({ ownerId: 'plan-a', id, kind: 'output' });
  assert.deepEqual(resolved, { id, kind: 'output', path: path.join(f.root, id) });
  assert.equal(Object.isFrozen(resolved), true);
  assert.throws(
    () => f.registry.resolveOwnedWorkspace({ ownerId: 'plan-b', id, kind: 'output' }),
    error => error.code === 'PLAN_STALE'
  );
  assert.throws(
    () => f.registry.resolveOwnedWorkspace({ ownerId: 'plan-a', id, kind: 'artifact-set' }),
    error => error.code === 'INVALID_REQUEST'
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

test('resolution returns a frozen path-free snapshot that cannot mutate registry authorization', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const id = f.registry.createStagingOutput({ ownerId: 'plan-a' });
  const resolved = f.registry.resolveOwnedId({ ownerId: 'plan-a', id, kind: 'output' });
  assert.equal(Object.hasOwn(resolved, 'path'), false);
  assert.equal(Object.isFrozen(resolved), true);
  resolved.ownerId = 'plan-b';
  resolved.kind = 'inspection';
  resolved.lastUsedAt = 999999;
  resolved.path = 'C:\\secret';
  resolved.value.extra = 'forged';
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: 'plan-b', id, kind: 'output' }), error => error.code === 'PLAN_STALE');
  const fresh = f.registry.resolveOwnedId({ ownerId: 'plan-a', id, kind: 'output' });
  assert.equal(fresh.kind, 'output');
  assert.equal(Object.hasOwn(fresh, 'lastUsedAt'), false);
  assert.equal(Object.hasOwn(fresh.value, 'extra'), false);
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

test('claimed transfers survive expiry, allow plan-to-job handoff once, and reject replay transfers', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const id = f.registry.createStagingOutput({ ownerId: 'planning-1' });
  assert.equal(f.registry.transferOwnership({ fromOwnerId: 'planning-1', toOwnerId: 'plan-1' }), 1);
  f.advance(31 * 60 * 1000);
  assert.equal(f.registry.sweepExpired(), 0);
  assert.equal(f.registry.resolveOwnedId({ ownerId: 'plan-1', id, kind: 'output' }).id, id);
  assert.equal(f.registry.transferOwnership({ fromOwnerId: 'plan-1', toOwnerId: 'job-1' }), 1);
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: 'plan-1', toOwnerId: 'job-1' }), error => error.code === 'PLAN_STALE');
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: 'job-1', toOwnerId: 'job-1' }), error => error.code === 'PLAN_STALE');
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: 'empty-owner', toOwnerId: 'job-2' }), error => error.code === 'PLAN_STALE');
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
  const snapshot = f.registry.resolveOwnedId({ ownerId: 'plan-a', id: inputDirectoryId, kind: 'input' });
  assert.equal(Object.hasOwn(snapshot.value, 'primaryPath'), false);
  assert.equal(snapshot.value.sourceArtifactSetId, artifactSetId);
  assert.equal(snapshot.value.sourceSetDigest, verifiedSet.artifactSet.setDigest);
  assert.match(snapshot.value.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(f.root, inputDirectoryId, 'server.zip')), true);
});

test('input binding is immutable and differs for two same-owner sets with equal filenames', async (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  f.registry.artifactCache = { materializeSet: async (_set, destination) => {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'same.zip'), 'archive');
    return path.join(destination, 'same.zip');
  } };
  const first = { ...verifiedSet, artifactSet: { ...verifiedSet.artifactSet, setDigest: 'a'.repeat(64) } };
  const second = { ...verifiedSet, artifactSet: { ...verifiedSet.artifactSet, setDigest: 'b'.repeat(64) } };
  const firstSetId = f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet: first });
  const secondSetId = f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet: second });
  const firstInputId = await f.registry.materializeInput({ ownerId: 'plan-a', artifactSetId: firstSetId });
  const secondInputId = await f.registry.materializeInput({ ownerId: 'plan-a', artifactSetId: secondSetId });
  const firstInput = f.registry.resolveOwnedId({ ownerId: 'plan-a', id: firstInputId, kind: 'input' }).value;
  const secondInput = f.registry.resolveOwnedId({ ownerId: 'plan-a', id: secondInputId, kind: 'input' }).value;
  assert.equal(firstInput.sourceArtifactSetId, firstSetId);
  assert.equal(secondInput.sourceArtifactSetId, secondSetId);
  assert.notEqual(firstInput.sourceFingerprint, secondInput.sourceFingerprint);
});

test('materialization reserves owner state so transfer, release, and expiry cannot orphan it', async (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  let finish;
  f.registry.artifactCache = { materializeSet: async (_set, destination) => {
    await new Promise((resolve) => { finish = () => { fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, 'server.zip'), 'archive'); resolve(); }; });
    return path.join(destination, 'server.zip');
  } };
  const artifactSetId = f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet });
  const pending = f.registry.materializeInput({ ownerId: 'plan-a', artifactSetId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => f.registry.transferOwnership({ fromOwnerId: 'plan-a', toOwnerId: 'job-a' }), error => error.code === 'PLAN_STALE');
  assert.throws(() => f.registry.releaseOwner('plan-a'), error => error.code === 'PLAN_STALE');
  f.advance(31 * 60 * 1000);
  assert.equal(f.registry.sweepExpired(), 0);
  finish();
  const inputId = await pending;
  assert.equal(f.registry.resolveOwnedId({ ownerId: 'plan-a', id: inputId, kind: 'input' }).id, inputId);
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

test('registry reference ownership keeps shared cached digests until the final owner releases', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const calls = [];
  f.registry.artifactCache = { retain: (digest) => calls.push(`+${digest}`), release: (digest) => calls.push(`-${digest}`) };
  const digest = 'a'.repeat(64);
  const shared = { type: 'verified-artifact-set', artifactSet: { primaryPartId: 'p', parts: [{ partId: 'p', fileName: 'server.zip', measuredSize: '1', calculatedDigests: { sha256: digest, sha512: 'b'.repeat(128) } }] } };
  f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet: shared });
  f.registry.registerVerifiedSet({ ownerId: 'plan-b', verifiedSet: shared });
  f.registry.releaseOwner('plan-a');
  f.registry.releaseOwner('plan-b');
  assert.deepEqual(calls, [`+${digest}`, `+${digest}`, `-${digest}`, `-${digest}`]);
});

test('failed verified-set registration rolls back only references it acquired', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const first = 'a'.repeat(64); const second = 'c'.repeat(64); const calls = [];
  f.registry.artifactCache = { retain: (digest) => { calls.push(`+${digest}`); if (digest === second) throw new Error('retain failed'); }, release: (digest) => calls.push(`-${digest}`) };
  const failing = { type: 'verified-artifact-set', artifactSet: { primaryPartId: 'a', parts: [
    { partId: 'a', fileName: 'one.zip', measuredSize: '1', calculatedDigests: { sha256: first, sha512: 'b'.repeat(128) } },
    { partId: 'b', fileName: 'two.zip', measuredSize: '1', calculatedDigests: { sha256: second, sha512: 'd'.repeat(128) } }
  ] } };
  assert.throws(() => f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet: failing }), /retain failed/);
  assert.deepEqual(calls, [`+${first}`, `+${second}`, `-${first}`]);
});

test('expiry releases verified-set cache references', (t) => {
  const f = registryFixture(); t.after(f.cleanup);
  const digest = 'a'.repeat(64); const calls = [];
  f.registry.artifactCache = { retain: (value) => calls.push(`+${value}`), release: (value) => calls.push(`-${value}`) };
  f.registry.registerVerifiedSet({ ownerId: 'plan-a', verifiedSet: { type: 'verified-artifact-set', artifactSet: { primaryPartId: 'p', parts: [{ partId: 'p', fileName: 'server.zip', measuredSize: '1', calculatedDigests: { sha256: digest, sha512: 'b'.repeat(128) } }] } } });
  f.advance(30 * 60 * 1000);
  assert.equal(f.registry.sweepExpired(), 1);
  assert.deepEqual(calls, [`+${digest}`, `-${digest}`]);
});
