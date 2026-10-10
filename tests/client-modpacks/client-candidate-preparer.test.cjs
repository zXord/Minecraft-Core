const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ArtifactCache } = require('../../electron/services/modpacks/artifacts/artifact-cache.cjs');
const { ArtifactWorkspaceRegistry } = require('../../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { ArchiveInputMaterializer } = require('../../electron/services/modpacks/archive/archive-input-materializer.cjs');
const { ArchiveExtractor } = require('../../electron/services/modpacks/archive/archive-extractor.cjs');
const { validateArchiveEntries } = require('../../electron/services/modpacks/archive/archive-entry-policy.cjs');
const { ARCHIVE_LIMITS } = require('../../electron/services/modpacks/limits.cjs');
const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');
const { computePlanFingerprint } = require('../../electron/services/modpacks/artifacts/artifact-fingerprint.cjs');
const { PersistentCandidateHashService } = require('../../electron/services/modpacks/planning/candidate-hash-service.cjs');
const { ClientCandidatePreparer } = require('../../electron/services/client-modpacks/client-candidate-preparer.cjs');

const digest = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
const safeReparse = { async isReparsePoint() { return false; } };
const mod = (target, bytes, client = 'required') => ({ path: target,
  hashes: { sha1: digest('sha1', bytes), sha512: digest('sha512', bytes) },
  env: { client, server: client === 'unsupported' ? 'required' : 'unsupported' },
  downloads: ['https://cdn.modrinth.com/fixture.jar'], fileSize: bytes.length });

async function fixture(t, { indexPath = 'modrinth.index.json', extra = {}, downloader, worker, multimc = false, realZip = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-client-candidate-'));
  const workspaceRoot = path.join(root, 'workspaces');
  const cache = new ArtifactCache({ root: path.join(root, 'cache'), workspaceRoot });
  const registry = new ArtifactWorkspaceRegistry({ root: workspaceRoot, artifactCache: cache });
  const hashService = new PersistentCandidateHashService();
  t.after(async () => { await hashService.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const bytes = Buffer.from('client-only-mod');
  const optional = Buffer.from('optional-mod');
  const manifest = multimc ? { formatVersion: 1, components: [
    { uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.minecraftforge', version: '47.4.13' },
    { uid: 'org.lwjgl3', version: '3.3.1', dependencyOnly: true }
  ] } : { formatVersion: 1, game: 'minecraft', versionId: 'v1', name: 'Matching client',
    files: [mod('mods/client.jar', bytes), mod('mods/optional.jar', optional, 'optional'),
      mod('mods/server.jar', Buffer.from('server'), 'unsupported')],
    dependencies: { minecraft: '1.20.1', forge: '47.3.12' } };
  const payload = multimc ? new Map([['mmc-pack.json', Buffer.from(JSON.stringify(manifest))],
    ['instance.cfg', Buffer.from('InstanceType=OneSix\nPreLaunchCommand=never execute\nJavaPath=never import')],
    ['.minecraft/config/common.toml', Buffer.from('client')], ['.minecraft/options.txt', Buffer.from('setting')],
    ['icon.png', Buffer.from('icon')], ...Object.entries(extra)]) : new Map([[indexPath, Buffer.from(JSON.stringify(manifest))],
    ['overrides/config/common.toml', Buffer.from('common')],
    ['client-overrides/config/common.toml', Buffer.from('client')],
    ['client-overrides/options.txt', Buffer.from('setting')],
    ['server-overrides/config/server.toml', Buffer.from('server')], ...Object.entries(extra)]);
  let archiveBytes = Buffer.from('PK fake archive bytes');
  if (realZip) {
    const zip = new (require('adm-zip'))();
    for (const [name, data] of payload) zip.addFile(name, data);
    zip.addFile('.minecraft/empty/', Buffer.alloc(0));
    archiveBytes = zip.toBuffer();
  }
  async function cacheBytes(data) {
    const sha256 = digest('sha256', data);
    const filePath = cache.pathForSha256(sha256);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    return sha256;
  }
  await cacheBytes(archiveBytes);
  await cacheBytes(bytes);
  await cacheBytes(optional);
  const plan = createArtifactSetPlan({ provider: 'local', artifactSet: { kind: 'single', groupingScheme: 'single',
    primaryPartId: 'archive', providerImmutable: true, attestationStatus: 'verified',
    parts: [{ partId: 'archive', fileName: multimc ? 'pack.zip' : 'pack.mrpack', size: String(archiveBytes.length),
      providerDigest: { algorithm: 'sha256', value: digest('sha256', archiveBytes) } }] } });
  const verified = finalizeVerifiedArtifactSet(plan, [{ partId: 'archive', measuredSize: String(archiveBytes.length),
    sha256: digest('sha256', archiveBytes), sha512: digest('sha512', archiveBytes) }]);
  const entries = [...payload].map(([entryName, data]) => ({ entryName, canonicalName: entryName.toLowerCase(),
    type: 'file', size: String(data.length), packedSize: String(data.length), depth: entryName.split('/').length }));
  const policy = validateArchiveEntries(entries.map(entry => ({ path: entry.entryName, type: entry.type,
    size: entry.size, packedSize: entry.packedSize, encrypted: false, attributes: '' })), ARCHIVE_LIMITS);
  const result = { type: 'archive-inspection', archiveFamily: multimc ? 'zip' : 'mrpack', integrity: 'tested',
    artifactSet: { completeness: 'verified-complete-set', fingerprint: computePlanFingerprint(verified) },
    engineEvidence: { family: 'zip', tested: true, version: '26.02' }, entries,
    rootCandidates: [...new Set(entries.filter(entry => entry.depth > 1).map(entry => entry.entryName.split('/')[0]))].sort(),
    selectedRoot: null, limitEvidence: { policyVersion: 1, totals: policy.totals },
    // Server classification is intentionally blocked: the client projection must parse its own index.
    classification: { kind: 'client-only', confidence: 'exact', blocked: true } };
  let inspectionId;
  let nativeWorker;
  let reparseInspector = safeReparse;
  if (realZip) {
    const { ArchiveWorkerClient } = require('../../electron/services/modpacks/archive/archive-worker-client.cjs');
    const { createArchiveInspector } = require('../../electron/services/modpacks/archive/archive-inspector.cjs');
    const { WindowsReparseInspector } = require('../../electron/services/modpacks/local/windows-reparse-inspector.cjs');
    reparseInspector = new WindowsReparseInspector();
    nativeWorker = new ArchiveWorkerClient({ resourcesRoot: path.resolve(__dirname, '../..'), workspaceRoot,
      workspaceRegistry: registry, reparseInspector, appOwnedRoot: path.join(root, 'archive-worker') });
    const inspector = createArchiveInspector({ workspaceRegistry: registry, workspaceRoot, workerClient: nativeWorker });
    inspectionId = (await inspector.inspectArchive({ verifiedArtifactSet: verified })).inspectionId;
  } else {
    const materializer = new ArchiveInputMaterializer({ workspaceRegistry: registry, workspaceRoot });
    const context = await materializer.prepare(verified);
    inspectionId = materializer.promote(context, result);
  }
  const extractor = new ArchiveExtractor({ workspaceRegistry: registry, workspaceRoot, reparseInspector,
    diskProbe: async () => ({ availableBytes: String(100n * 1024n ** 3n) }), watchdogIntervalMs: 1000,
    workerClient: nativeWorker || { async run(request, { signal }) {
      const output = path.join(workspaceRoot, request.outputDirectoryId);
      if (worker) return worker({ output, signal, payload });
      for (const [relative, data] of payload) {
        const destination = path.join(output, ...relative.split('/'));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, data);
      }
      return { type: 'status', ok: true, exitCode: 0, metrics: { stdoutBytes: '0', stderrBytes: '0', dataBytes: '0', elapsedMs: 1 } };
    } } });
  const downloads = [];
  const preparer = new ClientCandidatePreparer({ workspaceRegistry: registry, archiveExtractor: extractor,
    artifactCache: cache, candidateHashService: hashService, reparseInspector, randomUUID: crypto.randomUUID,
    artifactDownloader: { async downloadPart(part, options) {
      downloads.push(part);
      if (downloader) return downloader(part, options, { bytes, optional, cache });
      options.onProgress?.({ partBytes: part.size });
      return { sha256: digest('sha256', part.targetPath === 'mods/client.jar' ? bytes : optional) };
    } } });
  return { root, registry, cache, hashService, preparer, inspectionId, bytes, optional, downloads, manifest, payload };
}

// Losing the env.client projection or reading server classification would prevent a real client-only pack inspection.
test('forgetInspection evicts only metadata and never releases upstream inspection ownership', async t => {
  const f = await fixture(t);
  const first = await f.preparer.inspect({ inspectionId: f.inspectionId });
  assert.equal(f.preparer.forgetInspection(f.inspectionId), true);
  assert.equal(f.preparer.forgetInspection(f.inspectionId), false);
  assert.equal(f.registry.resolveOwnedId({ ownerId: f.inspectionId, id: f.inspectionId, kind: 'inspection' }).id, f.inspectionId);
  assert.equal(await fs.readFile(path.join(f.root, 'workspaces', first.outputId, 'modrinth.index.json'), 'utf8'), JSON.stringify(f.manifest));
  const second = await f.preparer.inspect({ inspectionId: f.inspectionId });
  assert.notEqual(first.outputId, second.outputId);
});

test('forgetInspection rejects an in-flight preparation before it finishes reading upstream content', async t => {
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let finish; const finished = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { downloader: async (part, options, { bytes }) => { enter(); await finished; return { sha256: digest('sha256', bytes) }; } });
  const pending = f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] });
  await entered;
  try { assert.throws(() => f.preparer.forgetInspection(f.inspectionId), { code: 'OPERATION_IN_PROGRESS' }); }
  finally { finish(); }
  const result = await pending;
  await f.preparer.release(result.ownerId);
});

test('forgetInspection cannot evict metadata during cached inspection revalidation', async t => {
  const f = await fixture(t);
  await f.preparer.inspect({ inspectionId: f.inspectionId });
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let finish; const finished = new Promise(resolve => { finish = resolve; });
  f.preparer.reparseInspector = { async isReparsePoint() { enter(); await finished; return false; } };
  const pending = f.preparer.inspect({ inspectionId: f.inspectionId }); await entered;
  try { assert.throws(() => f.preparer.forgetInspection(f.inspectionId), { code: 'OPERATION_IN_PROGRESS' }); }
  finally { finish(); }
  await pending;
});

test('inspection reads its bounded root index and retains exact runtime and default choices', async t => {
  const f = await fixture(t);
  const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
  assert.equal(inspected.inspectionId, f.inspectionId);
  assert.equal(inspected.name, 'Matching client');
  assert.equal(inspected.version, 'v1');
  assert.deepEqual(inspected.runtime, { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.3.12', javaMajor: 17, os: 'win32', architecture: 'x64' });
  assert.equal(inspected.downloadBytes, '27');
  assert.deepEqual(inspected.optionalFiles.map(item => [item.label, item.defaultSelected]), [['mods/optional.jar', true]]);
  assert.equal(f.downloads.length, 0);
});

// Copying the wrong layer, omitting either provider hash, or failing to hash final bytes changes this result.
test('candidate contains verified selected client files and final overrides only', async t => {
  const f = await fixture(t);
  const events = [];
  const result = await f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [], onProgress: event => events.push(event) });
  assert.equal(await fs.readFile(path.join(result.path, 'mods/client.jar'), 'utf8'), 'client-only-mod');
  assert.equal(await fs.readFile(path.join(result.path, 'config/common.toml'), 'utf8'), 'client');
  await assert.rejects(fs.access(path.join(result.path, 'mods/optional.jar')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(result.path, 'config/server.toml')), { code: 'ENOENT' });
  assert.deepEqual(f.downloads.map(item => item.requiredProviderDigests), [{ sha1: digest('sha1', f.bytes), sha512: digest('sha512', f.bytes) }]);
  assert.deepEqual(result.manifest.entries, [
    { path: 'config/common.toml', pathKey: 'config/common.toml', sha256: digest('sha256', Buffer.from('client')), size: '6', policy: 'managed' },
    { path: 'mods/client.jar', pathKey: 'mods/client.jar', sha256: digest('sha256', f.bytes), size: '15', policy: 'managed' },
    { path: 'options.txt', pathKey: 'options.txt', sha256: digest('sha256', Buffer.from('setting')), size: '7', policy: 'preserve-after-seed' }
  ]);
  assert.equal(result.totalBytes, '28');
  assert.deepEqual(result.optionalFileIds, []);
  assert.equal(f.registry.resolveOwnedWorkspace({ ownerId: result.ownerId, id: result.outputId, kind: 'output' }).path, result.path);
  assert.deepEqual(events.filter(event => event.activity === 'assembling-files').at(-1), {
    activity: 'assembling-files', completedItems: 3, totalItems: 3, processedBytes: 28, totalBytes: 28
  });
  assert.equal(events.filter(event => event.activity === 'downloading-pack-files').at(-1).processedBytes, 15);
  await f.preparer.release(result.ownerId);
  await assert.rejects(fs.access(result.path), { code: 'ENOENT' });
  assert.equal(f.registry.resolveOwnedId({ ownerId: f.inspectionId, id: f.inspectionId, kind: 'inspection' }).id, f.inspectionId);
  assert.ok([...f.registry.records.values()].some(record => record.ownerId === f.inspectionId && record.kind === 'artifact-set'));
});

test('candidate resolves opaque client optional IDs before downloading', async t => {
  const f = await fixture(t);
  const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
  const result = await f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [inspected.optionalFiles[0].id] });
  assert.equal(await fs.readFile(path.join(result.path, 'mods/optional.jar'), 'utf8'), 'optional-mod');
  assert.deepEqual(result.optionalFileIds, [inspected.optionalFiles[0].id]);
});

// Reusing source data after a failed extractor or accepting an arbitrary owner would release unrelated resources.
test('candidate errors and arbitrary release preserve unrelated workspaces', async t => {
  const f = await fixture(t, { downloader: async () => { throw new Error('download unavailable'); } });
  const unrelated = f.registry.createStagingOutput({ ownerId: 'unrelated-owner' });
  await fs.writeFile(path.join(f.root, 'workspaces', unrelated, 'keep.txt'), 'keep');
  await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }));
  await assert.rejects(f.preparer.release('unrelated-owner'), { code: 'INVALID_REQUEST' });
  assert.equal(await fs.readFile(path.join(f.root, 'workspaces', unrelated, 'keep.txt'), 'utf8'), 'keep');
  assert.equal([...f.registry.records.values()].filter(record => record.kind === 'output' && !['unrelated-owner', f.inspectionId].includes(record.ownerId)).length, 0);
});

// Cancellation must wait for a download to settle before removing its preparation files.
test('cancellation does not clean workspaces until the in-flight downloader is quiescent', async t => {
  let enter;
  let finish;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const f = await fixture(t, { downloader: async () => { enter(); await gate; throw new Error('writer stopped'); } });
  const pending = f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [], signal: controller.signal });
  let settled = false;
  pending.catch(() => { settled = true; });
  await entered;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok([...f.registry.records.values()].some(record => record.kind === 'output'));
  finish();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal([...f.registry.records.values()].filter(record => record.kind === 'output' && record.ownerId !== f.inspectionId).length, 0);
});

// Trusting extracted bytes from an earlier inspection after mutation would install an unreviewed pack.
test('candidate rejects a changed extracted index after inspection', async t => {
  const f = await fixture(t);
  const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
  const output = f.registry.resolveOwnedWorkspace({ ownerId: f.inspectionId, id: inspected.outputId, kind: 'output' }).path;
  await fs.writeFile(path.join(output, 'modrinth.index.json'), JSON.stringify({ ...f.manifest, versionId: 'unreviewed' }));
  await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }), { code: 'PLAN_STALE' });
  assert.equal(f.downloads.length, 0);
});

test('client candidate rejects nested and multiple index roots instead of guessing', async t => {
  for (const options of [{ indexPath: 'nested/modrinth.index.json' }, { extra: { 'nested/modrinth.index.json': Buffer.from('{}') } }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.preparer.inspect({ inspectionId: f.inspectionId }), { code: 'PACK_ROOT_AMBIGUOUS' });
  }
});

test('client inspection rejects stale ownership before creating or releasing any workspace', async t => {
  const f = await fixture(t);
  const before = f.registry.records.size;
  await assert.rejects(f.preparer.inspect({ inspectionId: 'inspection-not-owned' }), { code: 'PLAN_STALE' });
  assert.equal(f.registry.records.size, before);
});

// An ID collision must not send cleanup through an already-successful candidate's owner.
test('duplicate candidate IDs cannot release a previously prepared candidate', async t => {
  const f = await fixture(t);
  f.preparer.randomUUID = () => '00000000-0000-4000-8000-000000000001';
  const first = await f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] });
  await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }), { code: 'INVALID_REQUEST' });
  assert.equal(await fs.readFile(path.join(first.path, 'mods/client.jar'), 'utf8'), 'client-only-mod');
  await f.preparer.release(first.ownerId);
  await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }), { code: 'INVALID_REQUEST' });
});

test('changed cached download bytes never become a verified candidate', async t => {
  const f = await fixture(t, { downloader: async (part, options, { bytes, cache }) => {
    const sha256 = digest('sha256', bytes);
    await fs.writeFile(cache.pathForSha256(sha256), Buffer.from('changed-payload'));
    return { sha256 };
  } });
  await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }), { code: 'HASH_MISMATCH' });
});

test('changed extracted overrides never become a verified candidate', async t => {
  const f = await fixture(t);
  const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
  const output = f.registry.resolveOwnedWorkspace({ ownerId: f.inspectionId, id: inspected.outputId, kind: 'output' }).path;
  await fs.writeFile(path.join(output, 'client-overrides/config/common.toml'), 'changed');
  await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }), { code: 'PLAN_STALE' });
});

test('pre-aborted client preparation creates no workspaces', async t => {
  const f = await fixture(t);
  const before = f.registry.records.size;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [], signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(f.registry.records.size, before);
});

// Treating a bundled export as a download manifest, or copying launcher commands, breaks this result.
for (const realZip of [false, true]) test(`MultiMC ${realZip ? 'actual ZIP worker' : 'guarded extracted fixture'} prepares bundled content only`, {
  skip: realZip && (process.platform !== 'win32' || process.arch !== 'x64'), timeout: 120_000
}, async t => {
  const f = await fixture(t, { multimc: true, realZip, downloader: async () => assert.fail('MultiMC has no downloads') });
  const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
  assert.deepEqual(inspected.runtime, { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13', javaMajor: 17, os: 'win32', architecture: 'x64' });
  assert.equal(inspected.name, 'MultiMC client export');
  assert.equal(inspected.version, '1.20.1');
  assert.equal(inspected.contentFormat, 'multimc');
  assert.deepEqual(inspected.runtimeConstraints, { lwjglVersion: '3.3.1' });
  assert.deepEqual(inspected.optionalFiles, []);
  assert.equal(inspected.downloadBytes, '0');
  const events = [];
  const result = await f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [], onProgress: e => events.push(e) });
  assert.equal(await fs.readFile(path.join(result.path, 'config/common.toml'), 'utf8'), 'client');
  assert.equal(await fs.readFile(path.join(result.path, 'options.txt'), 'utf8'), 'setting');
  for (const relative of ['mmc-pack.json', 'instance.cfg', '.minecraft', 'icon.png']) {
    await assert.rejects(fs.access(path.join(result.path, relative)), { code: 'ENOENT' });
  }
  if (realZip) assert.ok((await fs.stat(path.join(result.path, 'empty'))).isDirectory());
  assert.deepEqual(result.manifest.entries, [
    { path: 'config/common.toml', pathKey: 'config/common.toml', sha256: digest('sha256', Buffer.from('client')), size: '6', policy: 'managed' },
    { path: 'options.txt', pathKey: 'options.txt', sha256: digest('sha256', Buffer.from('setting')), size: '7', policy: 'preserve-after-seed' }
  ]);
  assert.deepEqual(result.optionalFileIds, []);
  assert.equal(result.contentFormat, 'multimc');
  assert.deepEqual(result.runtimeConstraints, { lwjglVersion: '3.3.1' });
  assert.equal(result.totalBytes, '13');
  assert.equal(f.downloads.length, 0);
  assert.ok(!events.some(e => e.activity === 'downloading-pack-files'));
  assert.deepEqual(events.filter(e => e.activity === 'assembling-files').at(-1), {
    activity: 'assembling-files', completedItems: 2, totalItems: 2, processedBytes: 13, totalBytes: 13
  });
  await f.preparer.release(result.ownerId);
  assert.ok(f.registry.resolveOwnedId({ ownerId: f.inspectionId, id: f.inspectionId, kind: 'inspection' }));
  assert.equal(f.preparer.forgetInspection(f.inspectionId), true);
  await f.registry.releaseOwner(f.inspectionId);
});

// Blanket rejection prevents this real ZIP import; trusting sidecar JSON changes runtime/downloads or installed bytes.
for (const [name, contents] of [
  ['malformed JSON', '{not JSON'],
  ['conflicting metadata', JSON.stringify({ minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860' }] },
    files: [{ projectID: 1, fileID: 2, required: true }], dependencies: { minecraft: '1.12.2' }, lwjglVersion: '2.9.4' })]
]) test(`MultiMC actual ZIP retained sidecar ${name} never controls preparation`, {
  skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 120_000
}, async t => {
  const f = await fixture(t, { multimc: true, realZip: true, extra: { 'flame/manifest.json': Buffer.from(contents) },
    downloader: async () => assert.fail('Retained launcher metadata must not cause external pack downloads') });
  const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
  const result = await f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] });
  for (const value of [inspected, result]) {
    assert.deepEqual(value.runtime, { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13',
      javaMajor: 17, os: 'win32', architecture: 'x64' });
    assert.deepEqual(value.runtimeConstraints, { lwjglVersion: '3.3.1' });
    assert.equal(value.contentFormat, 'multimc');
    assert.deepEqual(value.optionalFileIds ?? value.optionalFiles, []);
  }
  assert.equal(inspected.downloadBytes, '0');
  assert.equal(await fs.readFile(path.join(result.path, 'config/common.toml'), 'utf8'), 'client');
  assert.equal(await fs.readFile(path.join(result.path, 'options.txt'), 'utf8'), 'setting');
  assert.deepEqual(result.manifest.entries, [
    { path: 'config/common.toml', pathKey: 'config/common.toml', sha256: digest('sha256', Buffer.from('client')), size: '6', policy: 'managed' },
    { path: 'options.txt', pathKey: 'options.txt', sha256: digest('sha256', Buffer.from('setting')), size: '7', policy: 'preserve-after-seed' }
  ]);
  assert.deepEqual((await fs.readdir(result.path)).sort(), ['config', 'empty', 'options.txt']);
  for (const relative of ['flame', 'flame/manifest.json', 'mmc-pack.json', 'instance.cfg', '.minecraft', 'icon.png']) {
    await assert.rejects(fs.access(path.join(result.path, relative)), { code: 'ENOENT' });
  }
  assert.equal(result.totalBytes, '13');
  assert.equal(f.downloads.length, 0);
  await f.preparer.release(result.ownerId);
  f.preparer.forgetInspection(f.inspectionId);
  await f.registry.releaseOwner(f.inspectionId);
});

test('MRPACK preparation omits both private MultiMC fields', async t => {
  const f = await fixture(t);
  const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
  const result = await f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] });
  for (const value of [inspected, result]) {
    assert.equal(Object.hasOwn(value, 'contentFormat'), false);
    assert.equal(Object.hasOwn(value, 'runtimeConstraints'), false);
  }
});
test('MRPACK still installs ordinary override JSON and launcher-like filenames', async t => {
  const f = await fixture(t, { extra: {
    'overrides/config/manifest.json': Buffer.from('ordinary-json'),
    'client-overrides/config/mmc-pack.json': Buffer.from('ordinary-payload'),
    'client-overrides/config/instance.cfg': Buffer.from('ordinary-config')
  } });
  const result = await f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] });
  assert.equal(await fs.readFile(path.join(result.path, 'config/manifest.json'), 'utf8'), 'ordinary-json');
  assert.equal(await fs.readFile(path.join(result.path, 'config/mmc-pack.json'), 'utf8'), 'ordinary-payload');
  assert.equal(await fs.readFile(path.join(result.path, 'config/instance.cfg'), 'utf8'), 'ordinary-config');
});
for (const prefix of ['.minecraft', 'overrides', 'client-overrides', 'server-overrides']) {
  test(`MRPACK preparer refuses another Modrinth index in ${prefix} before extraction`, async t => {
    const f = await fixture(t, { extra: { [`${prefix}/config/modrinth.index.json`]: Buffer.from('{}') } });
    const before = f.registry.records.size;
    await assert.rejects(f.preparer.inspect({ inspectionId: f.inspectionId }), { code: 'PACK_ROOT_AMBIGUOUS' });
    assert.equal(f.registry.records.size, before);
    assert.equal(f.downloads.length, 0);
  });
}
test('MultiMC rechecks consumed metadata and marker after awaited copy work', async t => {
  for (const relative of ['mmc-pack.json', 'instance.cfg']) {
    const f = await fixture(t, { multimc: true });
    const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
    const raw = f.registry.resolveOwnedWorkspace({ ownerId: f.inspectionId, id: inspected.outputId, kind: 'output' }).path;
    let mutated = false;
    f.preparer.candidateHashService = { dispose: () => f.hashService.dispose(), async hashFile(filePath, options) {
      const measured = await f.hashService.hashFile(filePath, options);
      if (!mutated) { mutated = true; await fs.writeFile(path.join(raw, relative), 'changed after inspect'); }
      return measured;
    } };
    await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }), { code: 'PLAN_STALE' });
    assert.equal([...f.registry.records.values()].filter(r => r.ownerId.startsWith('client-candidate-')).length, 0);
  }
});
test('MultiMC revalidation binds archive fingerprint and actual selected format', async t => {
  for (const change of ['fingerprint', 'format']) {
    const f = await fixture(t, { multimc: true });
    await f.preparer.inspect({ inspectionId: f.inspectionId });
    const materializer = f.preparer.archiveExtractor.materializer;
    const original = materializer.loadInspection.bind(materializer);
    materializer.loadInspection = id => {
      const loaded = original(id);
      return { ...loaded, result: { ...loaded.result, ...(change === 'fingerprint'
        ? { artifactSet: { ...loaded.result.artifactSet, fingerprint: 'changed' } }
        : { entries: [{ entryName: 'modrinth.index.json', type: 'file', size: '1' }] }) } };
    };
    await assert.rejects(f.preparer.inspect({ inspectionId: f.inspectionId }), { code: 'PLAN_STALE' });
  }
});
test('MultiMC refuses nonempty or malformed optional choices before candidate allocation', async t => {
  const f = await fixture(t, { multimc: true });
  await f.preparer.inspect({ inspectionId: f.inspectionId });
  const count = f.registry.records.size;
  for (const optionalFileIds of [['optional-unreviewed'], undefined, null, '']) {
    await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds }), { code: 'INVALID_REQUEST' });
    assert.equal(f.registry.records.size, count);
  }
  assert.equal(f.downloads.length, 0);
});
for (const relative of ['mmc-pack.json', 'instance.cfg', '.minecraft/config/common.toml']) {
  test(`MultiMC refuses same-byte identity replacement of ${relative}`, async t => {
    const f = await fixture(t, { multimc: true });
    const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
    const root = f.registry.resolveOwnedWorkspace({ ownerId: f.inspectionId, id: inspected.outputId, kind: 'output' }).path;
    const target = path.join(root, ...relative.split('/'));
    const replacement = `${target}.replacement`;
    await fs.writeFile(replacement, await fs.readFile(target));
    await fs.rename(replacement, target);
    await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }), { code: 'PLAN_STALE' });
    assert.equal(f.downloads.length, 0);
    assert.ok(f.registry.resolveOwnedId({ ownerId: f.inspectionId, id: f.inspectionId, kind: 'inspection' }));
  });
}
test('MultiMC cached inspection rejects replaced marker identity without parsing cfg commands', async t => {
  const f = await fixture(t, { multimc: true });
  const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
  const root = f.registry.resolveOwnedWorkspace({ ownerId: f.inspectionId, id: inspected.outputId, kind: 'output' }).path;
  await fs.writeFile(path.join(root, 'instance.cfg'), 'changed marker');
  await assert.rejects(f.preparer.inspect({ inspectionId: f.inspectionId }), { code: 'PLAN_STALE' });
});
test('MultiMC refuses a source hardlink and reparse marker after inspection', async t => {
  for (const mutation of ['hardlink', 'reparse']) {
    const f = await fixture(t, { multimc: true });
    const inspected = await f.preparer.inspect({ inspectionId: f.inspectionId });
    const root = f.registry.resolveOwnedWorkspace({ ownerId: f.inspectionId, id: inspected.outputId, kind: 'output' }).path;
    if (mutation === 'hardlink') await fs.link(path.join(root, '.minecraft/config/common.toml'), path.join(root, 'alias'));
    else f.preparer.reparseInspector = { async isReparsePoint(p) { return path.basename(p) === 'instance.cfg'; } };
    await assert.rejects(f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [] }), { code: 'UNSAFE_ARCHIVE_ENTRY' });
  }
});
test('MultiMC cancellation awaits hashing, rejects busy eviction, and cleans only its candidate owner', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { multimc: true });
  await f.preparer.inspect({ inspectionId: f.inspectionId });
  const unrelated = f.registry.createStagingOutput({ ownerId: 'unrelated-owner' });
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  f.preparer.candidateHashService = { dispose: () => f.hashService.dispose(),
    async hashFile(request, options) { enter(); await gate; return f.hashService.hashFile(request, options); } };
  const pending = f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [], signal: controller.signal });
  let settled = false; pending.catch(() => { settled = true; });
  await entered;
  await assert.rejects(f.preparer.inspect({ inspectionId: f.inspectionId }), { code: 'OPERATION_IN_PROGRESS' });
  assert.throws(() => f.preparer.forgetInspection(f.inspectionId), { code: 'OPERATION_IN_PROGRESS' });
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok([...f.registry.records.values()].some(r => r.ownerId.startsWith('client-candidate-')));
  finish();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal([...f.registry.records.values()].filter(r => r.ownerId.startsWith('client-candidate-')).length, 0);
  assert.ok(f.registry.resolveOwnedWorkspace({ ownerId: 'unrelated-owner', id: unrelated, kind: 'output' }));
});


// Task 7: actual progress remains observation, never publication authority.
const phaseOf = event => event.phase ?? event.activity;
const phases = events => events.map(phaseOf).filter((phase, i, values) => i === 0 || phase !== values[i - 1]);
const measurements = (events, phase) => events.filter(event => phaseOf(event) === phase).map(event => ({
  completedItems: String(event.completedItems), totalItems: String(event.totalItems),
  ...(event.completedBytes === undefined ? {} : { completedBytes: String(event.completedBytes), totalBytes: String(event.totalBytes) })
}));
function assertSubsequence(actual, expected) {
  let previous = -1;
  for (const value of expected) { const index = actual.indexOf(value, previous + 1); assert.ok(index > previous, `Missing ordered phase ${value}: ${actual}`); previous = index; }
}
for (const multimc of [false, true]) test(`task7: ${multimc ? 'MultiMC' : 'MRPACK'} fresh bundled checks and cached/final revalidation have distinct phases`, async t => {
  const f = await fixture(t, { multimc }); const fresh = [], cached = [], preparedEvents = [];
  const first = await f.preparer.inspect({ inspectionId: f.inspectionId, onProgress: event => fresh.push(event) });
  assertSubsequence(phases(fresh), ['extracting', 'verifying-archive', 'reading-client-metadata', 'checking-bundled-files']);
  assert.deepEqual(measurements(fresh, 'checking-bundled-files'), [0, 1, 2].map(n => ({ completedItems: String(n), totalItems: '2' })));
  assert.equal(fresh.some(e => e.activity === 'checking-bundled-files' && e.processedBytes !== undefined), false, 'stat size is not measured bytes read');
  assert.equal(await f.preparer.inspect({ inspectionId: f.inspectionId, onProgress: event => cached.push(event) }), first);
  assert.deepEqual(phases(cached), ['revalidating-client-files']);
  const result = await f.preparer.prepare({ inspectionId: f.inspectionId, optionalFileIds: [], onProgress: event => preparedEvents.push(event) });
  assertSubsequence(phases(preparedEvents), ['revalidating-client-files', 'assembling-files', 'revalidating-client-files']);
  assert.equal(phaseOf(preparedEvents.at(-1)), 'revalidating-client-files');
  assert.equal(preparedEvents.at(-1).completedItems, undefined);
  if (multimc) assert.equal(f.downloads.length, 0);
  await f.preparer.release(result.ownerId);
});
test('task7: cancelling a fresh bundled-file check stops before another completed count or retained inspection', async t => {
  const f = await fixture(t, { multimc: true }); const controller = new AbortController(); const events = [];
  await assert.rejects(f.preparer.inspect({ inspectionId: f.inspectionId, signal: controller.signal, onProgress: event => {
    events.push(event); if (event.activity === 'checking-bundled-files' && String(event.completedItems) === '1') controller.abort();
  } }), { code: 'CANCELLED' });
  assert.deepEqual(measurements(events, 'checking-bundled-files').map(e => e.completedItems), ['0', '1']);
  assert.equal(f.preparer.inspections.has(f.inspectionId), false);
});
for (const rejection of ['sync', 'async']) test(`task7: ${rejection} fresh-check observer failure cannot change inspected evidence`, async t => {
  const f = await fixture(t, { multimc: true }); let observed = 0;
  const result = await f.preparer.inspect({ inspectionId: f.inspectionId, onProgress: event => {
    if (event.activity !== 'checking-bundled-files') return;
    observed++; if (rejection === 'sync') throw new Error('observer'); return Promise.reject(new Error('observer'));
  } });
  assert.equal(observed, 3); assert.equal(result.contentFormat, 'multimc'); assert.equal(f.downloads.length, 0);
});

test('task7: bundled-check progress uses a bounded stride and retains the final exact count', async t => {
  const extra = Object.fromEntries(Array.from({ length: 399 }, (_, index) => [`.minecraft/config/bulk-${index}.cfg`, Buffer.from('x')]));
  const f = await fixture(t, { multimc: true, extra }); const events = [];
  await f.preparer.inspect({ inspectionId: f.inspectionId, onProgress: event => events.push(event) });
  const checks = measurements(events, 'checking-bundled-files');
  assert.equal(checks.length, 135); assert.deepEqual(checks.slice(0, 3).map(e => e.completedItems), ['0', '3', '6']);
  assert.deepEqual(checks.at(-1), { completedItems: '401', totalItems: '401' });
  assert.equal(f.preparer.inspections.get(f.inspectionId).identities.size, 402, 'all payload identities and the launcher marker remain checked');
});
