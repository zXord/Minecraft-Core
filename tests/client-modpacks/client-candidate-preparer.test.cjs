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

async function fixture(t, { indexPath = 'modrinth.index.json', extra = {}, downloader, worker } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-client-candidate-'));
  const workspaceRoot = path.join(root, 'workspaces');
  const cache = new ArtifactCache({ root: path.join(root, 'cache'), workspaceRoot });
  const registry = new ArtifactWorkspaceRegistry({ root: workspaceRoot, artifactCache: cache });
  const hashService = new PersistentCandidateHashService();
  t.after(async () => { await hashService.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const bytes = Buffer.from('client-only-mod');
  const optional = Buffer.from('optional-mod');
  const manifest = { formatVersion: 1, game: 'minecraft', versionId: 'v1', name: 'Matching client',
    files: [mod('mods/client.jar', bytes), mod('mods/optional.jar', optional, 'optional'),
      mod('mods/server.jar', Buffer.from('server'), 'unsupported')],
    dependencies: { minecraft: '1.20.1', forge: '47.3.12' } };
  const payload = new Map([[indexPath, Buffer.from(JSON.stringify(manifest))],
    ['overrides/config/common.toml', Buffer.from('common')],
    ['client-overrides/config/common.toml', Buffer.from('client')],
    ['client-overrides/options.txt', Buffer.from('setting')],
    ['server-overrides/config/server.toml', Buffer.from('server')], ...Object.entries(extra)]);
  const archiveBytes = Buffer.from('PK fake archive bytes');
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
    parts: [{ partId: 'archive', fileName: 'pack.mrpack', size: String(archiveBytes.length),
      providerDigest: { algorithm: 'sha256', value: digest('sha256', archiveBytes) } }] } });
  const verified = finalizeVerifiedArtifactSet(plan, [{ partId: 'archive', measuredSize: String(archiveBytes.length),
    sha256: digest('sha256', archiveBytes), sha512: digest('sha512', archiveBytes) }]);
  const entries = [...payload].map(([entryName, data]) => ({ entryName, canonicalName: entryName.toLowerCase(),
    type: 'file', size: String(data.length), packedSize: String(data.length), depth: entryName.split('/').length }));
  const policy = validateArchiveEntries(entries.map(entry => ({ path: entry.entryName, type: entry.type,
    size: entry.size, packedSize: entry.packedSize, encrypted: false, attributes: '' })), ARCHIVE_LIMITS);
  const result = { type: 'archive-inspection', archiveFamily: 'mrpack', integrity: 'tested',
    artifactSet: { completeness: 'verified-complete-set', fingerprint: computePlanFingerprint(verified) },
    engineEvidence: { family: 'zip', tested: true, version: '26.02' }, entries,
    rootCandidates: [...new Set(entries.filter(entry => entry.depth > 1).map(entry => entry.entryName.split('/')[0]))].sort(),
    selectedRoot: null, limitEvidence: { policyVersion: 1, totals: policy.totals },
    // Server classification is intentionally blocked: the client projection must parse its own index.
    classification: { kind: 'client-only', confidence: 'exact', blocked: true } };
  const materializer = new ArchiveInputMaterializer({ workspaceRegistry: registry, workspaceRoot });
  const context = await materializer.prepare(verified);
  const inspectionId = materializer.promote(context, result);
  const extractor = new ArchiveExtractor({ workspaceRegistry: registry, workspaceRoot, reparseInspector: safeReparse,
    diskProbe: async () => ({ availableBytes: String(100n * 1024n ** 3n) }), watchdogIntervalMs: 1000,
    workerClient: { async run(request, { signal }) {
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
    artifactCache: cache, candidateHashService: hashService, reparseInspector: safeReparse, randomUUID: crypto.randomUUID,
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
