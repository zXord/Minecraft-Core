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

async function fixture(t, { provider = 'github', clientLoader = '47.3.12', blockedWorker, managedHealth = false,
  fileName = 'client.mrpack', multimc = false, nonclient = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-companion-service-'));
  const filePath = path.join(root, 'companions.json');
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: { moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {} } });
  const store = new CompanionStore({ filePath, durableFs }); await store.initialize();
  const serverPath = path.join(root, 'server'); fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'), { recursive: true });
  // Lifecycle evidence for the managed fixture; its state itself comes from readServerState.
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{}');
  const unmanagedPath = path.join(root, 'unmanaged-server'); fs.mkdirSync(unmanagedPath);
  let unmanagedReads = 0;
  let state = { modpackManaged: true, source: provider === 'github' ? { provider, repositoryId: '123', releaseId: '456', githubOwner: 'Pack-Team', githubRepo: 'Pack', selectedAssetIds: ['10'], artifactSetDigest: 'a'.repeat(64), version: 'v1' } : { provider, projectId: 'project', versionId: 'version', artifactSetDigest: 'a'.repeat(64), version: 'v1' }, runtime, selectedOptionalFiles: [] };
  let now = 0;
  let initializedRepository = false;
  let repositoryId = '123';
  let resolveInside;
  const workspaceRoot = path.join(root, 'workspaces');
  const cache = new ArtifactCache({ root: path.join(root, 'cache'), workspaceRoot });
  const registry = new ArtifactWorkspaceRegistry({ root: workspaceRoot, artifactCache: cache });
  const archiveBytes = Buffer.from(multimc ? 'PK bundled client ZIP' : 'PK companion archive');
  const archiveSha256 = hash('sha256', archiveBytes);
  fs.mkdirSync(path.dirname(cache.pathForSha256(archiveSha256)), { recursive: true }); fs.writeFileSync(cache.pathForSha256(archiveSha256), archiveBytes);
  const plan = createArtifactSetPlan({ provider, project: { id: provider === 'github' ? '123' : 'project', slug: 'pack', title: 'Pack' }, release: { id: provider === 'github' ? '456' : 'version', version: 'v1', channel: 'release', publishedAt: '2026-10-08T00:00:00.000Z' }, artifactSet: { kind: 'single', groupingScheme: 'single', primaryPartId: 'client', providerImmutable: true, attestationStatus: 'verified', parts: [{ partId: 'client', providerAssetId: provider === 'github' ? '20' : 'client', fileName, size: String(archiveBytes.length), providerDigest: { algorithm: 'sha256', value: archiveSha256 } }] } });
  const verified = finalizeVerifiedArtifactSet(plan, [{ partId: 'client', measuredSize: String(archiveBytes.length), sha256: archiveSha256, sha512: hash('sha512', archiveBytes) }]);
  const versionMetadata = { channel: 'release', prerelease: false, publishedAt: '2026-10-08T00:00:00.000Z' };
  const providers = {
    github: {
      async getRepositoryIdentity(url) { assert.equal(url, 'https://github.com/Pack-Team/Pack'); initializedRepository = true; return { repositoryId, owner: 'Pack-Team', repo: 'Pack', visibility: 'public' }; },
      repository(id) { assert.equal(initializedRepository, true, 'repository cache must be initialized'); assert.equal(id, '123'); return { repositoryId: id, owner: 'Pack-Team', repo: 'Pack', visibility: 'public' }; },
      async getRelease(request) { assert.deepEqual(request, { repositoryId: '123', releaseId: '456' }); return { releaseId: '456', tagName: 'v1', title: 'Pack', ...versionMetadata }; },
      async listUploadedAssets(request) { assert.equal(initializedRepository, true); assert.deepEqual(request, { repositoryId: '123', releaseId: '456' }); return { repositoryId: '123', releaseId: '456', assets: [{ assetId: '20', fileName, size: String(archiveBytes.length), state: 'uploaded', providerDigest: { algorithm: 'sha256', value: archiveSha256 } }, { assetId: '10', fileName: 'server.zip', size: '100', state: 'uploaded' }, { assetId: '30', fileName: 'unfinished.ZIP', size: '40', state: 'new' }, { assetId: '40', fileName: 'other.rar', size: '40', state: 'uploaded' }], choices: [] }; },
      async buildArtifactSetPlan(request) { assert.deepEqual(request, { repositoryId: '123', releaseId: '456', selectedAssetIds: ['20'] }); return plan; }
    },
    modrinth: { async getVersion(id) { assert.equal(id, 'version'); return { projectId: 'project', versionId: 'version', version: 'v1', ...versionMetadata }; }, async resolveArtifactSetPlan(id) { assert.equal(id, 'version'); return plan; } }
  };
  const sourceResolver = new ProductionModpackSourceResolver({ providers, localArtifactSource: { async ingestSelection() { assert.fail('No local ingestion'); } } });
  const index = Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: 'client-v1', name: 'Client pack', files: [{ path: 'mods/client.jar', hashes: { sha1: 'a'.repeat(40), sha512: 'a'.repeat(128) }, env: { client: 'required', server: 'unsupported' }, downloads: ['https://cdn.modrinth.com/client.jar'], fileSize: 42 }], dependencies: { minecraft: '1.20.1', forge: clientLoader } }));
  const payload = multimc ? new Map([
    ['mmc-pack.json', Buffer.from(JSON.stringify({ formatVersion: 1, components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.minecraftforge', version: clientLoader }] }))],
    ['instance.cfg', Buffer.from('PreLaunchCommand=never import')], ['.minecraft/config/common.toml', Buffer.from('bundled')]
  ]) : nonclient ? new Map([['server.properties', Buffer.from('server')]]) : new Map([['modrinth.index.json', index]]);
  const entries = [...payload].map(([entryName, bytes]) => ({ entryName, canonicalName: entryName.toLowerCase(), type: 'file', size: String(bytes.length), packedSize: String(bytes.length), depth: entryName.split('/').length }));
  const policy = validateArchiveEntries(entries.map(entry => ({ path: entry.entryName, type: entry.type, size: entry.size, packedSize: entry.packedSize, encrypted: false, attributes: '' })), ARCHIVE_LIMITS);
  const result = { type: 'archive-inspection', archiveFamily: /\.zip$/i.test(fileName) ? 'zip' : 'mrpack', integrity: 'tested', artifactSet: { completeness: 'verified-complete-set', fingerprint: computePlanFingerprint(verified) }, engineEvidence: { family: 'zip', tested: true, version: '26.02' }, entries, rootCandidates: multimc ? ['.minecraft'] : [], selectedRoot: null, limitEvidence: { policyVersion: 1, totals: policy.totals }, classification: { kind: 'client-only', confidence: 'exact', blocked: true } };
  const materializer = new ArchiveInputMaterializer({ workspaceRegistry: registry, workspaceRoot });
  const archiveInspector = { materializer, async inspectArchive({ verifiedArtifactSet }) { assert.equal(verifiedArtifactSet, verified); const context = await materializer.prepare(verifiedArtifactSet); return { ...result, inspectionId: materializer.promote(context, result) }; } };
  const extractor = new ArchiveExtractor({ workspaceRegistry: registry, workspaceRoot, reparseInspector: safeReparse, diskProbe: async () => ({ availableBytes: String(100n * 1024n ** 3n) }), watchdogIntervalMs: 1000, workerClient: { async run(request, { signal }) {
    if (blockedWorker) await blockedWorker(signal);
    for (const [relative, bytes] of payload) {
      const destination = path.join(workspaceRoot, request.outputDirectoryId, ...relative.split('/'));
      await fsp.mkdir(path.dirname(destination), { recursive: true }); await fsp.writeFile(destination, bytes);
    }
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
    if (id === 'server-two') {
      // Models a strict state read that cannot run for this folder's shape (drive root, junction).
      unmanagedReads++; throw Object.assign(new Error('strict state read refused the folder'), { code: 'RECOVERY_REQUIRED' });
    }
    assert.equal(id, 'server-one');
    if (managedHealth) {
      if (options?.force) assert.ok(context.getCurrentLease(), 'Fresh bytes must be checked inside the mutation reservation');
      await health.assertHealthy({ serverId: id, serverPath, record: { state, manifest }, ...options });
    }
    return state;
  }, resolveServer: async id => {
    if (id === 'server-two') return { instanceId: 'server-two', serverPath: unmanagedPath };
    assert.equal(id, 'server-one'); if (context.getCurrentLease()) resolveInside?.(); return selector;
  }, coordinator, providers, sourceResolver, artifactAcquisition: { async downloadSet(actualPlan) { assert.equal(actualPlan, plan); return verified; } }, archiveInspector, clientCandidatePreparer: preparer, clock: () => now });
  t.after(() => health.dispose());
  t.after(async () => { await service.dispose(); await preparer.dispose(); await registry.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, filePath, store, service, registry, preparer, selector, coordinator, archiveSha256, jarPath, serverPath, unmanagedPath, unmanagedReads: () => unmanagedReads, byteReads: () => byteReads, fingerprint: serverPackFingerprint(state), getState: () => state, setState: value => { state = value; }, setNow: value => { now = value; }, setRepositoryId: id => { repositoryId = id; }, setResolveInside: callback => { resolveInside = callback; }, bumps: () => bumps };
}
const inspect = f => f.service.inspect({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, assetId: '20' });

// Removing the shared provider allowlist or single-part check must break these cases.
test('client archive source gates accept only provider-supported single archives', () => {
  const { isClientArchiveName, singleClientArchive } = require('../../electron/services/client-modpacks/client-archive-source.cjs');
  for (const [provider, name, accepted] of [['github', 'client.MRPACK', true], ['github', 'client.ZIP', true], ['modrinth', 'client.MRPACK', true],
    ['modrinth', 'client.zip', false], ['local', 'client.mrpack', false], ['other', 'client.zip', false], ['github', 'client.zip.exe', false], ['github', null, false]]) {
    assert.equal(isClientArchiveName(name, provider), accepted);
    const part = { fileName: name }; const plan = { artifactSet: { kind: 'single', parts: [part] } };
    if (accepted) assert.equal(singleClientArchive(plan, provider), part);
    else assert.throws(() => singleClientArchive(plan, provider), { code: 'UNSUPPORTED_ARCHIVE' });
  }
  let reads = 0; assert.equal(isClientArchiveName({ toString() { reads++; return 'pack.zip'; } }, 'github'), false); assert.equal(reads, 0);
  for (const artifactSet of [null, { kind: 'multipart', parts: [{ fileName: 'client.zip' }] }, { kind: 'single', parts: [] },
    { kind: 'single', parts: [{ fileName: 'one.zip' }, { fileName: 'two.zip' }] }, { kind: 'single', parts: [null] }]) {
    assert.throws(() => singleClientArchive({ artifactSet }, 'github'), { code: 'UNSUPPORTED_ARCHIVE' });
  }
});

test('explicit GitHub ZIP inspection reviews bundled content without auto-selection or pairing', async t => {
  const f = await fixture(t, { fileName: 'client.ZIP', multimc: true }); let acquired = 0;
  const download = f.service.artifactAcquisition.downloadSet; f.service.artifactAcquisition.downloadSet = (...args) => { acquired++; return download(...args); };
  assert.deepEqual((await f.service.listAssets({ serverId: 'server-one' })).assets, [{ assetId: '20', fileName: 'client.ZIP', size: '21' }, { assetId: '10', fileName: 'server.zip', size: '100' }]);
  assert.equal(acquired, 0);
  await assert.rejects(f.service.inspect({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint }), { code: 'INVALID_REQUEST' });
  const preview = await inspect(f);
  assert.equal(preview.serverVersion, 'v1'); assert.equal(preview.version, '1.20.1'); assert.equal(preview.downloadBytes, '0');
  assert.deepEqual(preview.optionalFiles, []); assert.equal(Object.hasOwn(preview, 'runtimeConstraints'), false);
  assert.equal((await f.service.getStatus({ serverId: 'server-one' })).status, 'unpaired'); assert.equal(f.store.sequence, 0); assert.equal(acquired, 1);
  const descriptor = await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId });
  assert.equal(descriptor.artifactSha256, f.archiveSha256); assert.equal(descriptor.source.assetId, '20'); assert.equal(f.bumps(), 0);
});

test('same-release MRPACK to ZIP changes pairing only after explicit acceptance', async t => {
  const f = await fixture(t); const old = await inspect(f);
  const descriptor = await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: old.inspectionId });
  const zipped = await fixture(t, { fileName: 'client.zip', multimc: true });
  for (const key of ['providers', 'sourceResolver', 'artifactAcquisition', 'archiveInspector', 'clientCandidatePreparer']) f.service[key] = zipped.service[key];
  const preview = await inspect(f); assert.deepEqual(await f.service.getStatus({ serverId: 'server-one' }), descriptor);
  assert.notEqual(preview.artifactSha256, descriptor.artifactSha256);
  const accepted = await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId });
  assert.equal(accepted.artifactSha256, zipped.archiveSha256); assert.equal(accepted.serverFingerprint, descriptor.serverFingerprint); assert.equal(f.bumps(), 0);
});

test('nonclient ZIP inspection preserves an existing pairing and never falls back', async t => {
  const f = await fixture(t); const old = await inspect(f);
  const descriptor = await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: old.inspectionId });
  const zipped = await fixture(t, { fileName: 'server.zip', nonclient: true });
  for (const key of ['providers', 'sourceResolver', 'artifactAcquisition', 'archiveInspector', 'clientCandidatePreparer']) f.service[key] = zipped.service[key];
  let inspections = 0; const actual = zipped.preparer.inspect.bind(zipped.preparer);
  zipped.preparer.inspect = async request => { inspections++; return actual(request); };
  await assert.rejects(inspect(f), { code: 'PACK_ROOT_AMBIGUOUS' });
  assert.equal(inspections, 1); assert.equal(f.store.sequence, 1); assert.deepEqual(await f.service.getStatus({ serverId: 'server-one' }), descriptor);
});

test('MRPACK acquisition failure never selects a listed ZIP alternative', async t => {
  const f = await fixture(t); let acquisitions = 0;
  f.service.artifactAcquisition.downloadSet = async () => { acquisitions++; throw Object.assign(new Error('unavailable'), { code: 'ARTIFACT_UNAVAILABLE' }); };
  await assert.rejects(inspect(f), { code: 'ARTIFACT_UNAVAILABLE' }); assert.equal(acquisitions, 1); assert.equal(f.store.sequence, 0);
});

for (const boundary of ['resolved', 'acquired']) test(`companion refuses wrong selected GitHub asset at ${boundary} boundary`, async t => {
  const f = await fixture(t);
  if (boundary === 'resolved') f.service.sourceResolver.resolveArtifactSetPlan = async () => ({ artifactSetPlan: { artifactSet: { kind: 'single', parts: [{ fileName: 'client.mrpack', providerAssetId: '999' }] } } });
  else { const download = f.service.artifactAcquisition.downloadSet; f.service.artifactAcquisition.downloadSet = async (...args) => { const value = await download(...args); return { ...value, artifactSet: { ...value.artifactSet, parts: value.artifactSet.parts.map(part => ({ ...part, providerAssetId: '999' })) } }; }; }
  await assert.rejects(inspect(f), { code: 'PLAN_STALE' }); assert.equal(f.store.sequence, 0);
});

for (const boundary of ['resolved', 'acquired']) for (const invalid of ['extension', 'multipart']) test(`companion enforces ${invalid} single-archive gate at ${boundary} boundary`, async t => {
  const f = await fixture(t, { fileName: 'client.zip', multimc: true });
  const dependency = boundary === 'resolved' ? f.service.sourceResolver : f.service.artifactAcquisition;
  const method = boundary === 'resolved' ? 'resolveArtifactSetPlan' : 'downloadSet'; const original = dependency[method];
  dependency[method] = async (...args) => {
    const result = await original.apply(dependency, args); const plan = boundary === 'resolved' ? result.artifactSetPlan : result;
    const artifactSet = invalid === 'multipart' ? { ...plan.artifactSet, kind: 'multipart' }
      : { ...plan.artifactSet, parts: plan.artifactSet.parts.map(part => ({ ...part, fileName: 'client.rar' })) };
    const changed = { ...plan, artifactSet }; return boundary === 'resolved' ? { ...result, artifactSetPlan: changed } : changed;
  };
  f.service.archiveInspector.inspectArchive = async () => assert.fail('Invalid source must fail before inspection');
  await assert.rejects(inspect(f), { code: 'UNSUPPORTED_ARCHIVE' }); assert.equal(f.store.sequence, 0);
});

test('GitHub MultiMC ZIP runtime mismatch cannot publish a pairing', async t => {
  const f = await fixture(t, { fileName: 'client.zip', multimc: true, clientLoader: '47.0.0' });
  await assert.rejects(inspect(f), { code: 'RUNTIME_INCOMPLETE' }); assert.equal(f.store.sequence, 0);
});

test('wrong GitHub listing release refuses discovery and inspection before acquisition', async t => {
  const f = await fixture(t); const list = f.service.providers.github.listUploadedAssets;
  f.service.providers.github.listUploadedAssets = async (...args) => ({ ...await list(...args), releaseId: '457' });
  f.service.artifactAcquisition.downloadSet = async () => assert.fail('Wrong release must not acquire');
  await assert.rejects(f.service.listAssets({ serverId: 'server-one' }), { code: 'PLAN_STALE' });
  await assert.rejects(inspect(f), { code: 'PLAN_STALE' }); assert.equal(f.store.sequence, 0);
});

for (const fileName of ['client.zip', 'client.mrpack']) test(`Modrinth refuses MultiMC content in ${fileName} before pairing`, async t => {
  const f = await fixture(t, { provider: 'modrinth', fileName, multimc: true });
  if (fileName.endsWith('.zip')) {
    f.service.artifactAcquisition.downloadSet = async () => assert.fail('Modrinth ZIP must not acquire');
    await assert.rejects(f.service.listAssets({ serverId: 'server-one' }), { code: 'UNSUPPORTED_ARCHIVE' });
  }
  await assert.rejects(f.service.inspect({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint }), { code: 'UNSUPPORTED_ARCHIVE' });
  assert.equal(f.store.sequence, 0);
});

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
  assert.deepEqual((await f.service.listAssets({ serverId: 'server-one' })).assets, [{ assetId: '20', fileName: 'client.mrpack', size: '20' }, { assetId: '10', fileName: 'server.zip', size: '100' }]);
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
test('saved ready status remains independent of repository identity refusal in asset discovery', async t => {
  const f = await fixture(t); const preview = await inspect(f);
  const descriptor = await f.service.accept({ serverId: 'server-one', expectedServerFingerprint: f.fingerprint, inspectionId: preview.inspectionId });
  f.setRepositoryId('999');
  assert.deepEqual(await f.service.getStatus({ serverId: 'server-one' }), descriptor);
  await assert.rejects(f.service.listAssets({ serverId: 'server-one' }), { code: 'PLAN_STALE' });
  assert.deepEqual(await f.service.getStatus({ serverId: 'server-one' }), descriptor);
  f.setRepositoryId('123');
  assert.equal((await f.service.listAssets({ serverId: 'server-one' })).serverFingerprint, descriptor.serverFingerprint);
  assert.deepEqual((await f.service.listAssets({ serverId: 'server-one' })).assets, [{ assetId: '20', fileName: 'client.mrpack', size: '20' }, { assetId: '10', fileName: 'server.zip', size: '100' }]);
  assert.equal(f.store.sequence, 1);
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

test('a server without modpack state answers null before any strict state read', async t => {
  const f = await fixture(t);
  assert.equal(await f.service.getStatus({ serverId: 'server-two' }), null);
  fs.mkdirSync(path.join(f.unmanagedPath, '.minecraft-core-state'));
  fs.writeFileSync(path.join(f.unmanagedPath, '.minecraft-core-state', 'runtime.json'), '{}');
  assert.equal(await f.service.getStatus({ serverId: 'server-two' }), null, 'a loader runtime record is not modpack state');
  assert.equal(f.unmanagedReads(), 0);
  fs.writeFileSync(path.join(f.unmanagedPath, '.minecraft-core-state', 'modpack.json'), '{}');
  await assert.rejects(f.service.getStatus({ serverId: 'server-two' }), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.unmanagedReads(), 1, 'present modpack state keeps the strict read');
  await assert.rejects(f.service.listAssets({ serverId: 'server-two' }), { code: 'RECOVERY_REQUIRED' });
});

test('an unmanaged server answers without waiting for another server lifecycle cleanup', async t => {
  const f = await fixture(t); const preview = await inspect(f);
  const entered = deferred(); const finish = deferred();
  const releaseOwner = f.registry.releaseOwner.bind(f.registry);
  let paused = false;
  f.registry.releaseOwner = async id => { if (id === preview.inspectionId && !paused) { paused = true; entered.resolve(); await finish.promise; } return releaseOwner(id); };
  f.setNow(15 * 60 * 1000);
  const pruning = f.service.getStatus({ serverId: 'server-one' }); await entered.promise;
  try {
    const answer = await Promise.race([f.service.getStatus({ serverId: 'server-two' }),
      new Promise(resolve => setTimeout(() => resolve('still waiting on the lifecycle lock'), 500))]);
    assert.equal(answer, null);
  } finally { finish.resolve(); }
  assert.equal((await pruning).status, 'unpaired');
});
