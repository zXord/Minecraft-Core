const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ModpackStateRepository } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');
const { createClientPackComposition } = require('../../electron/bootstrap/create-client-pack-composition.cjs');

// Independently hashed, hand-specified canonical identity for the fixture below;
// never derive the expected fingerprint with serverPackFingerprint.
const fingerprint = 'a483152d67a62ce78f4bfb9fd2ee9846469060a21b9dc02a4111d31b88067585';
const unexpected = () => assert.fail('Status and asset listing must not acquire or prepare artifacts');

async function fixture(t, { managed = true, missing = false, managedJar = false, client = false, readClientConfig } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-client-composition-'));
  const serverPath = path.join(root, 'registered-server');
  fs.mkdirSync(serverPath);
  if (managedJar) { fs.mkdirSync(path.join(serverPath, 'mods')); fs.writeFileSync(path.join(serverPath, 'mods/expected.jar'), 'pack'); }
  let composition;
  t.after(async () => {
    try { await composition?.dispose(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  // Keep production bounded/atomic filesystem behavior; substitute only native durability.
  const durableClient = {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    async moveWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
    async flushDirectoryAsync() {}
  };
  const durableFsFactory = allowedRoots => createDurableFs({ allowedRoots, durableClient });
  const repositoryFs = Object.create(fs);
  const repository = new ModpackStateRepository({ fsApi: repositoryFs, durableFs: durableFsFactory([root]) });
  if (!missing) repository.writeCandidate(serverPath, {
    schemaVersion: 1, modpackManaged: managed,
    source: { provider: 'github', repositoryId: '123', releaseId: '456', githubOwner: 'Pack-Team', githubRepo: 'Pack',
      version: 'v1', title: 'Pack', selectedAssetIds: ['10'], artifactSetDigest: 'a'.repeat(64) },
    runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' },
    selectedOptionalFiles: [], installedAt: '2026-10-08T00:00:00.000Z', contentRevision: 1,
    manifest: { schemaVersion: 1, installationId: 'install-one', entries: managedJar ? [{
      path: 'mods/expected.jar', pathKey: 'mods/expected.jar', origin: 'pack', managementPolicy: 'replaceable-managed',
      role: 'mod', size: '4', installedHash: '4862f447f2c7f272fa2f4aaf89dadb3b1ac09105bd5864f8d1a0c9452bb0a226', priorBaseline: null
    }] : [] }
  });
  // The legacy summary is not an authority for managed status or release identity.
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ modpackManaged: true, modpackVersion: 'wrong-summary-version', modpackReleaseId: '999' }));
  const workspaceRegistry = { createStagingOutput: unexpected, resolveOwnedWorkspace: unexpected, releaseOwner: unexpected };
  const instances = [{ id: 'server-one', type: 'server', path: serverPath }];
  const clientPath = path.join(root, 'registered-client');
  if (client) { fs.mkdirSync(clientPath); instances.push({ id: 'local-client', type: 'client', path: clientPath }); }
  composition = createClientPackComposition({
    userDataPath: path.join(root, 'app-data'),
    store: { get(key) { assert.equal(key, 'instances'); return instances; } },
    readClientConfig,
    clientDurableFsFactory: durableFsFactory,
    clientWorkerDurableConfig: { workerPath: path.join(root, 'ArchiveWorker.exe'), workerManifestPath: path.join(root, 'manifest.json'), appOwnedRoot: root },
    stateRepository: repository,
    coordinator: { runMutation: unexpected },
    providers: { github: {
      async getRepositoryIdentity(url) {
        assert.equal(url, 'https://github.com/Pack-Team/Pack');
        return { repositoryId: '123', visibility: 'public' };
      },
      async listUploadedAssets(selector) {
        assert.deepEqual(selector, { repositoryId: '123', releaseId: '456' });
        return { repositoryId: '123', releaseId: '456', assets: [
          { assetId: '20', fileName: 'client.mrpack', size: '42', state: 'uploaded' },
          { assetId: '10', fileName: 'server.zip', size: '100', state: 'uploaded' },
          { assetId: '30', fileName: 'unfinished.mrpack', size: '60', state: 'new' }
        ] };
      }
    } },
    sourceResolver: { resolveArtifactSetPlan: unexpected }, artifactAcquisition: { downloadSet: unexpected },
    archiveInspector: { inspectArchive: unexpected, materializer: { workspaceRegistry } },
    workspaceRegistry,
    archiveExtractor: { extractArchive: unexpected, materializer: { loadInspection: unexpected } },
    artifactDownloader: { downloadPart: unexpected }, artifactCache: { pathForSha256: unexpected },
    candidateHashService: { hashFile: unexpected, async dispose() {} },
    reparseInspector: { async isReparsePoint() { return false; } }, randomUUID: crypto.randomUUID, clock: { now: () => 0 }
  });
  await composition.initialize();
  return { service: composition.companionService, composition, instances, clientPath, repositoryFs, serverPath };
}

test('legacy composition hook resolves only the registered path and refuses replacement before dispatch', async t => {
  const config = { serverProtocol: 'https', serverIp: 'saved.test', serverPort: '8443', managementCertFingerprint: 'a'.repeat(64),
    clientId: 'remote-client', clientName: 'Synthetic', inviteSecret: 'private', sessionToken: 'saved-token' };
  const f = await fixture(t, { client: true, readClientConfig: async () => ({ ...config }) });
  const context = await f.composition.acquireLegacyManagementContext(f.clientPath);
  assert.equal(context.baseOrigin, 'https://saved.test:8443'); assert.equal(context.sessionToken, 'saved-token');
  assert.equal(context.managementCertFingerprint, 'a'.repeat(64)); assert.equal(Object.isFrozen(context), true);
  await assert.rejects(f.composition.acquireLegacyManagementContext(path.join(f.clientPath, 'unregistered')), { code: 'INVALID_REQUEST' });
  f.instances.find(item => item.id === 'local-client').path = path.join(f.clientPath, 'replacement');
  await assert.rejects(context.assertCurrent(), { code: 'PLAN_STALE' });
});

test('production composition exposes an unpaired descriptor from the managed repository envelope', async t => {
  const { service } = await fixture(t);
  assert.deepEqual(await service.getStatus({ serverId: 'server-one' }), {
    schemaVersion: 1, status: 'unpaired', serverFingerprint: fingerprint, serverVersion: 'v1',
    source: null, runtime: null, artifactSha256: null
  });
});

test('actual composition refuses drift from real envelope and returns original identity after restoration', async t => {
  const { service, serverPath } = await fixture(t, { managedJar: true });
  const original = await service.getStatus({ serverId: 'server-one' });
  const jar = path.join(serverPath, 'mods/expected.jar'); fs.writeFileSync(jar, 'evil');
  await assert.rejects(service.getStatus({ serverId: 'server-one' }), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  await assert.rejects(service.listAssets({ serverId: 'server-one' }), { code: 'CLIENT_PACK_SERVER_CHANGED' });
  fs.writeFileSync(jar, 'pack');
  assert.deepEqual(await service.getStatus({ serverId: 'server-one' }), original);
});

test('production composition lists matching client assets from the exact installed release', async t => {
  const { service } = await fixture(t);
  assert.deepEqual(await service.listAssets({ serverId: 'server-one' }), {
    serverFingerprint: fingerprint, serverVersion: 'v1', assets: [{ assetId: '20', fileName: 'client.mrpack', size: '42' }, { assetId: '10', fileName: 'server.zip', size: '100' }]
  });
});

for (const [name, options] of [['unmanaged', { managed: false }], ['missing', { missing: true }]]) {
  test(`production composition keeps ${name} repository state unavailable despite a managed summary`, async t => {
    const { service } = await fixture(t, options);
    assert.equal(await service.getStatus({ serverId: 'server-one' }), null);
    await assert.rejects(service.listAssets({ serverId: 'server-one' }), { code: 'CLIENT_PACK_UNAVAILABLE' });
  });
}

test('production composition rejects malformed persisted state without fabricating a descriptor', async t => {
  const { service, serverPath } = await fixture(t);
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{malformed');
  await assert.rejects(service.getStatus({ serverId: 'server-one' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(service.listAssets({ serverId: 'server-one' }), { code: 'INVALID_REQUEST' });
});

test('production composition propagates failed authoritative reads without fabricating a descriptor', async t => {
  const { service, repositoryFs, serverPath } = await fixture(t);
  const failure = Object.assign(new Error('authoritative repository unavailable'), { code: 'EIO' });
  repositoryFs.lstatSync = (target, ...args) => {
    if (target === path.join(serverPath, '.minecraft-core-state', 'modpack.json')) throw failure;
    return fs.lstatSync(target, ...args);
  };
  await assert.rejects(service.getStatus({ serverId: 'server-one' }), error => error === failure);
  await assert.rejects(service.listAssets({ serverId: 'server-one' }), error => error === failure);
});

test('production composition only resolves registered server identities', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.getStatus({ serverId: 'unregistered-server' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(service.listAssets({ serverId: 'unregistered-server' }), { code: 'INVALID_REQUEST' });
});
