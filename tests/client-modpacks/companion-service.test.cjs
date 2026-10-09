const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { CompanionStore } = require('../../electron/services/client-modpacks/companion-store.cjs');
const { CompanionService } = require('../../electron/services/client-modpacks/companion-service.cjs');
const { ManagedServerModHealth } = require('../../electron/services/client-modpacks/managed-server-mod-health.cjs');
const { serverPackFingerprint } = require('../../electron/services/client-modpacks/companion-contracts.cjs');
const { ArtifactCache } = require('../../electron/services/modpacks/artifacts/artifact-cache.cjs');
const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { ArchiveInputMaterializer } = require('../../electron/services/modpacks/archive/archive-input-materializer.cjs');
const { ArchiveExtractor } = require('../../electron/services/modpacks/archive/archive-extractor.cjs');
const { validateArchiveEntries } = require('../../electron/services/modpacks/archive/archive-entry-policy.cjs');
const { ARCHIVE_LIMITS } = require('../../electron/services/modpacks/limits.cjs');
const { ClientCandidatePreparer } = require('../../electron/services/client-modpacks/client-candidate-preparer.cjs');
const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');
const { computePlanFingerprint } = require('../../electron/services/modpacks/artifacts/artifact-fingerprint.cjs');
const { ProductionModpackSourceResolver } = require('../../electron/services/modpacks/providers/production-source-resolver.cjs');
const { ServerMutationCoordinator } = require('../../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationContext } = require('../../electron/services/server-mutation-context.cjs');
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' };
const safeReparse = { async isReparsePoint() { return false; } };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t, { provider = 'github', clientLoader = '47.3.12', blockedWorker, managedHealth = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-companion-service-'));
  const filePath = path.join(root, 'companions.json');
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: { moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {} } });
  const store = new CompanionStore({ filePath, durableFs }); await store.initialize();
  const serverPath = path.join(root, 'server'); fs.mkdirSync(serverPath);
  let state = { modpackManaged: true, source: provider === 'github' ? { provider, repositoryId: '123', releaseId: '456', githubOwner: 'Pack-Team', githubRepo: 'Pack', selectedAssetIds: ['10'], artifactSetDigest: 'a'.repeat(64), version: 'v1' } : { provider, projectId: 'project', versionId: 'version', artifactSetDigest: 'a'.repeat(64), version: 'v1' }, runtime, selectedOptionalFiles: [] };
  let now = 0;
  let initializedRepository = false;
  let repositoryId = '123';
  let resolveInside;
  const workspaceRoot = path.join(root, 'workspaces');
  const cache = new ArtifactCache({ root: path.join(root, 'cache'), workspaceRoot });
  const registry = new ArtifactWorkspaceRegistry({ root: workspaceRoot, artifactCache: cache });
  const archiveBytes = Buffer.from('PK companion archive');
  const archiveSha256 = hash('sha256', archiveBytes);
  fs.mkdirSync(path.dirname(cache.pathForSha256(archiveSha256)), { recursive: true }); fs.writeFileSync(cache.pathForSha256(archiveSha256), archiveBytes);
  const plan = createArtifactSetPlan({ provider, project: { id: provider === 'github' ? '123' : 'project', slug: 'pack', title: 'Pack' }, release: { id: provider === 'github' ? '456' : 'version', version: 'v1', channel: 'release', publishedAt: '2026-10-08T00:00:00.000Z' }, artifactSet: { kind: 'single', groupingScheme: 'single', primaryPartId: 'client', providerImmutable: true, attestationStatus: 'verified', parts: [{ partId: 'client', providerAssetId: provider === 'github' ? '20' : 'client', fileName: 'client.mrpack', size: String(archiveBytes.length), providerDigest: { algorithm: 'sha256', value: archiveSha256 } }] } });
  const verified = finalizeVerifiedArtifactSet(plan, [{ partId: 'client', measuredSize: String(archiveBytes.length), sha256: archiveSha256, sha512: hash('sha512', archiveBytes) }]);
  const versionMetadata = { channel: 'release', prerelease: false, publishedAt: '2026-10-08T00:00:00.000Z' };
  const providers = {
    github: {
      async getRepositoryIdentity(url) { assert.equal(url, 'https://github.com/Pack-Team/Pack'); initializedRepository = true; return { repositoryId, owner: 'Pack-Team', repo: 'Pack', visibility: 'public' }; },
      repository(id) { assert.equal(initializedRepository, true, 'repository cache must be initialized'); assert.equal(id, '123'); return { repositoryId: id, owner: 'Pack-Team', repo: 'Pack', visibility: 'public' }; },
      async getRelease(request) { assert.deepEqual(request, { repositoryId: '123', releaseId: '456' }); return { releaseId: '456', tagName: 'v1', title: 'Pack', ...versionMetadata }; },
      async listUploadedAssets(request) { assert.equal(initializedRepository, true); assert.deepEqual(request, { repositoryId: '123', releaseId: '456' }); return { repositoryId: '123', releaseId: '456', assets: [{ assetId: '20', fileName: 'client.mrpack', size: String(archiveBytes.length), state: 'uploaded', providerDigest: { algorithm: 'sha256', value: archiveSha256 } }, { assetId: '10', fileName: 'server.zip', size: '100', state: 'uploaded' }], choices: [] }; },
      async buildArtifactSetPlan(request) { assert.deepEqual(request, { repositoryId: '123', releaseId: '456', selectedAssetIds: ['20'] }); return plan; }
    },
    modrinth: { async getVersion(id) { assert.equal(id, 'version'); return { projectId: 'project', versionId: 'version', version: 'v1', ...versionMetadata }; }, async resolveArtifactSetPlan(id) { assert.equal(id, 'version'); return plan; } }
  };
  const sourceResolver = new ProductionModpackSourceResolver({ providers, localArtifactSource: { async ingestSelection() { assert.fail('No local ingestion'); } } });
  const index = Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: 'client-v1', name: 'Client pack', files: [{ path: 'mods/client.jar', hashes: { sha1: 'a'.repeat(40), sha512: 'a'.repeat(128) }, env: { client: 'required', server: 'unsupported' }, downloads: ['https://cdn.modrinth.com/client.jar'], fileSize: 42 }], dependencies: { minecraft: '1.20.1', forge: clientLoader } }));
  const entries = [{ entryName: 'modrinth.index.json', canonicalName: 'modrinth.index.json', type: 'file', size: String(index.length), packedSize: String(index.length), depth: 1 }];
  const policy = validateArchiveEntries(entries.map(entry => ({ path: entry.entryName, type: entry.type, size: entry.size, packedSize: entry.packedSize, encrypted: false, attributes: '' })), ARCHIVE_LIMITS);
  const result = { type: 'archive-inspection', archiveFamily: 'mrpack', integrity: 'tested', artifactSet: { completeness: 'verified-complete-set', fingerprint: computePlanFingerprint(verified) }, engineEvidence: { family: 'zip', tested: true, version: '26.02' }, entries, rootCandidates: [], selectedRoot: null, limitEvidence: { policyVersion: 1, totals: policy.totals }, classification: { kind: 'client-only', confidence: 'exact', blocked: true } };
  const materializer = new ArchiveInputMaterializer({ workspaceRegistry: registry, workspaceRoot });
  const archiveInspector = { materializer, async inspectArchive({ verifiedArtifactSet }) { assert.equal(verifiedArtifactSet, verified); const context = await materializer.prepare(verifiedArtifactSet); return { ...result, inspectionId: materializer.promote(context, result) }; } };
  const extractor = new ArchiveExtractor({ workspaceRegistry: registry, workspaceRoot, reparseInspector: safeReparse, diskProbe: async () => ({ availableBytes: String(100n * 1024n ** 3n) }), watchdogIntervalMs: 1000, workerClient: { async run(request, { signal }) {
    if (blockedWorker) await blockedWorker(signal);
    await fsp.writeFile(path.join(workspaceRoot, request.outputDirectoryId, 'modrinth.index.json'), index);
    return { type: 'status', ok: true, exitCode: 0, metrics: { stdoutBytes: '0', stderrBytes: '0', dataBytes: '0', elapsedMs: 1 } };
  } } });
  const preparer = new ClientCandidatePreparer({ workspaceRegistry: registry, archiveExtractor: extractor, artifactCache: cache, reparseInspector: safeReparse, randomUUID: crypto.randomUUID, artifactDownloader: { async downloadPart() { assert.fail('Pairing must not download referenced mods'); } } });
  const context = createServerMutationContext(); let bumps = 0;
  const coordinator = new ServerMutationCoordinator({ context, readContentRevision() { return 7; }, bumpContentRevision() { bumps++; return 8; } }); coordinator.completeStartupRecovery([]);
  const selector = { instanceId: 'server-one', serverPath };
  const jarPath = path.join(serverPath, 'expected.jar'); fs.writeFileSync(jarPath, 'pack');
  const manifest = { schemaVersion: 1, installationId: 'server-install', entries: [{ path: 'expected.jar', pathKey: 'expected.jar',
    origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod', installedHash: hash('sha256', 'pack'), size: '4', priorBaseline: null }] };
  let byteReads = 0;
  const fsPromises = { async open(...args) { const handle = await fsp.open(...args); return {
    stat: (...values) => handle.stat(...values), close: () => handle.close(), async read(...values) { byteReads++; return handle.read(...values); }
  }; } };
  const health = new ManagedServerModHealth({ readRecord: async () => ({ state, manifest }), fsPromises, reparseInspector: safeReparse });
  const service = new CompanionService({ store, readServerState: async (id, options) => {
    assert.equal(id, 'server-one');
    if (managedHealth) {
      if (options?.force) assert.ok(context.getCurrentLease(), 'Fresh bytes must be checked inside the mutation reservation');
      await health.assertHealthy({ serverId: id, serverPath, record: { state, manifest }, ...options });
    }
    return state;
  }, resolveServer: async id => { assert.equal(id, 'server-one'); if (context.getCurrentLease()) resolveInside?.(); return selector; }, coordinator, providers, sourceResolver, artifactAcquisition: { async downloadSet(actualPlan) { assert.equal(actualPlan, plan); return verified; } }, archiveInspector, clientCandidatePreparer: preparer, clock: () => now });
  t.after(() => health.dispose());
  t.after(async () => { await service.dispose(); await preparer.dispose(); await registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, filePath, store, service, registry, preparer, selector, coordinator, archiveSha256, jarPath, byteReads: () => byteReads, fingerprint: serverPackFingerprint(state), getState: () => state, setState: value => { state = value; }, setNow: value => { now = value; }, setRepositoryId: id => { repositoryId = id; }, setResolveInside: callback => { resolveInside = callback; }, bumps: () => bumps };
}
const inspect = f => f.service.inspect({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, assetId: '20' });

test('accept forces fresh managed JAR bytes under reservation and historical ready descriptor recovers after repair', async t => {
  const f = await fixture(t, { managedHealth: true }); const preview = await inspect(f); const reads = f.byteReads();
  const descriptor = await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId });
  assert.ok(f.byteReads() > reads, 'Accept must not use the status byte cache');
  fs.writeFileSync(f.jarPath, 'evil');
  await assert.rejects(f.service.getStatus({ serverId: 'server-one' }), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  fs.writeFileSync(f.jarPath, 'pack'); assert.deepEqual(await f.service.getStatus({ serverId: 'server-one' }), descriptor);
});

test('accept refuses managed JAR drift inside reservation without publishing a pairing', async t => {
  const f = await fixture(t, { managedHealth: true }); const preview = await inspect(f);
  f.setResolveInside(() => fs.writeFileSync(f.jarPath, 'evil'));
  await assert.rejects(f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId }), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  assert.equal(f.store.sequence, 0);
});

test('managed JAR drift refuses status, asset listing and inspection before pairing', async t => {
  const f = await fixture(t, { managedHealth: true });
  assert.equal((await f.service.getStatus({ serverId: 'server-one' })).status, 'unpaired');
  fs.writeFileSync(f.jarPath, 'evil');
  await assert.rejects(f.service.getStatus({ serverId: 'server-one' }), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  await assert.rejects(f.service.listAssets({ serverId: 'server-one' }), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  await assert.rejects(inspect(f), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  assert.equal(f.store.sequence, 0);
});

test('pairing inspects only the exact official release archive and binds measured digest', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.service.listAssets({ serverId: 'server-one' })).assets, [{ assetId: '20', fileName: 'client.mrpack', size: '20' }]);
  assert.equal((await f.service.getStatus({ serverId: 'server-one' })).status, 'unpaired');
  await assert.rejects(f.service.inspect({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, assetId: '999' }), { code: 'INVALID_REQUEST' });
  const preview = await inspect(f);
  assert.equal(preview.downloadBytes, '42'); assert.equal(preview.artifactSha256, f.archiveSha256);
  assert.equal(JSON.stringify(preview).includes('downloads'), false); assert.equal(Object.hasOwn(preview, 'outputId'), false);
  const descriptor = await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId });
  assert.deepEqual(descriptor.source, { provider: 'github', repositoryId: '123', githubOwner: 'Pack-Team', githubRepo: 'Pack', releaseId: '456', assetId: '20' });
  assert.equal(descriptor.status, 'ready'); assert.equal(descriptor.artifactSha256, f.archiveSha256); assert.equal(f.bumps(), 0);
  assert.deepEqual(await f.service.getStatus({ serverId: 'server-one' }), descriptor);
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: preview.inspectionId, id: preview.inspectionId, kind: 'inspection' }), { code: 'PLAN_STALE' });
});
test('Modrinth re-resolves the exact installed version without a renderer-selected source', async t => {
  const f = await fixture(t, { provider: 'modrinth' });
  const preview = await f.service.inspect({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint });
  const descriptor = await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId });
  assert.deepEqual(descriptor.source, { provider: 'modrinth', projectId: 'project', versionId: 'version' });
});
test('runtime mismatch and repository identity drift cannot publish a binding', async t => {
  const f = await fixture(t, { clientLoader: '47.3.13' });
  await assert.rejects(inspect(f), { code: 'RUNTIME_INCOMPLETE' });
  assert.equal(f.store.sequence, 0);
  f.setRepositoryId('999');
  await assert.rejects(inspect(f), { code: 'PLAN_STALE' });
});

test('unsafe installed loader identity makes pairing unavailable without publishing', async t => {
  const f = await fixture(t);
  f.setState({ ...f.getState(), runtime: { ...runtime, loaderVersion: 'https://example.invalid/private?token=secret' } });
  await assert.rejects(f.service.getStatus({ serverId: 'server-one' }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  await assert.rejects(inspect(f), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.store.sequence, 0);
});
test('accept rechecks identity and registration inside a revision-neutral mutation reservation', async t => {
  const f = await fixture(t); const preview = await inspect(f);
  f.setResolveInside(() => f.setState({ ...f.getState(), source: { ...f.getState().source, releaseId: '457' } }));
  await assert.rejects(f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId }), { code: 'PLAN_STALE' });
  assert.equal(f.store.sequence, 0); assert.equal(f.bumps(), 0);
});
test('running server and forged inspection capabilities cannot alter registry', async t => {
  const f = await fixture(t); const preview = await inspect(f);
  const start = await f.coordinator.acquireStart(f.selector, { operation: 'test-start', operationId: 'test-start' }); start.markRunning({ pid: 42 });
  await assert.rejects(f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId }), { code: 'SERVER_RUNNING' });
  await assert.rejects(f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: 'forged' }), { code: 'INVALID_REQUEST' });
  start.release(); assert.equal(f.store.sequence, 0);
});
test('missing legacy identity and corrupt registry are explicitly unavailable without server changes', async t => {
  const f = await fixture(t); const original = structuredClone(f.getState());
  f.setState({ ...original, source: { ...original.source, artifactSetDigest: undefined } });
  await assert.rejects(f.service.getStatus({ serverId: 'server-one' }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  f.setState(original); const preview = await inspect(f); await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId });
  fs.writeFileSync(f.filePath, 'corrupt');
  await assert.rejects(f.service.getStatus({ serverId: 'server-one' }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.deepEqual(f.getState(), original); assert.equal(f.bumps(), 0); assert.equal(fs.readFileSync(f.filePath, 'utf8'), 'corrupt');
});

test('unmanaged status stays null and local imports never advertise remote companions', async t => {
  const f = await fixture(t);
  f.setState(null); assert.equal(await f.service.getStatus({ serverId: 'server-one' }), null);
  f.setState({ modpackManaged: true, source: { provider: 'local', importId: 'local-one', artifactSha256: 'a'.repeat(64), version: 'v1' }, runtime, selectedOptionalFiles: [] });
  const status = await f.service.getStatus({ serverId: 'server-one' });
  assert.equal(status.status, 'unpaired'); assert.equal(status.source, null);
  assert.deepEqual((await f.service.listAssets({ serverId: 'server-one' })).assets, []);
  await assert.rejects(f.service.inspect({ serverId: 'server-one', expectedServerFingerprint: status.serverFingerprint }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  assert.equal(f.store.sequence, 0);
});
test('bounded inspection retention expires capabilities and releases only owned inspections', async t => {
  const f = await fixture(t); const unrelated = f.registry.createStagingOutput({ ownerId: 'unrelated' });
  fs.writeFileSync(path.join(f.root, 'workspaces', unrelated, 'keep.txt'), 'keep');
  const first = await inspect(f);
  for (let i = 0; i < 4; i++) await inspect(f);
  assert.throws(() => f.registry.resolveOwnedId({ ownerId: first.inspectionId, id: first.inspectionId, kind: 'inspection' }), { code: 'PLAN_STALE' });
  f.setNow(15 * 60 * 1000); await f.service.getStatus({ serverId: 'server-one' });
  assert.equal(fs.readdirSync(path.join(f.root, 'workspaces')).filter(name => name.startsWith('output-')).length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'workspaces', unrelated, 'keep.txt'), 'utf8'), 'keep');
  await f.service.dispose(); await f.registry.releaseOwner('unrelated');
  await assert.rejects(inspect(f), { code: 'CLIENT_PACK_UNAVAILABLE' });
});
test('dispose aborts and waits for active extraction before exact-owned cleanup', async t => {
  const entered = deferred(); const finish = deferred(); let signal;
  const f = await fixture(t, { blockedWorker: async value => { signal = value; entered.resolve(); await finish.promise; } });
  const pending = inspect(f); await entered.promise;
  let settled = false; const disposal = f.service.dispose().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(signal.aborted, true); assert.equal(settled, false);
  assert.ok(fs.readdirSync(path.join(f.root, 'workspaces')).some(name => name.startsWith('output-')));
  finish.resolve(); await assert.rejects(pending, { code: 'CANCELLED' }); await disposal;
  assert.equal(fs.readdirSync(path.join(f.root, 'workspaces')).filter(name => /^(input|output)-/.test(name)).length, 0);
});

test('all four active inspections block a fifth without reclaiming in-use outputs', async t => {
  const entered = deferred(); const finish = deferred(); let count = 0;
  const f = await fixture(t, { blockedWorker: async () => { if (++count === 4) entered.resolve(); await finish.promise; } });
  const pending = Array.from({ length: 4 }, () => inspect(f));
  await entered.promise;
  try {
    await assert.rejects(inspect(f), { code: 'OPERATION_IN_PROGRESS' });
    assert.equal(fs.readdirSync(path.join(f.root, 'workspaces')).filter(name => name.startsWith('output-')).length, 4);
  } finally { finish.resolve(); }
  const previews = await Promise.all(pending);
  assert.equal(new Set(previews.map(preview => preview.inspectionId)).size, 4);
});

test('pruning marks an expiring inspection in-use until raw ownership cleanup settles', async t => {
  const f = await fixture(t); const preview = await inspect(f);
  const entered = deferred(); const finish = deferred();
  const releaseOwner = f.registry.releaseOwner.bind(f.registry);
  let paused = false;
  f.registry.releaseOwner = async id => { if (id === preview.inspectionId && !paused) { paused = true; entered.resolve(); await finish.promise; } return releaseOwner(id); };
  f.setNow(15 * 60 * 1000);
  const pruning = f.service.getStatus({ serverId: 'server-one' }); await entered.promise;
  try { await assert.rejects(f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId }), { code: 'OPERATION_IN_PROGRESS' }); }
  finally { finish.resolve(); }
  await pruning; assert.equal(f.store.sequence, 0);
});
