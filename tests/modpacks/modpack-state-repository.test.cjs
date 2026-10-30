const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ModpackStateRepository } = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');
const { compileAssetPattern } = require('../../electron/services/modpacks/providers/github-asset-pattern.cjs');

function nativeClient() {
  return {
    moveWriteThrough: (source, destination) => fs.renameSync(source, destination),
    replaceFileWriteThrough: (source, destination) => fs.renameSync(source, destination),
    flushDirectory() {},
    moveWriteThroughAsync: async (source, destination) => fs.renameSync(source, destination),
    replaceFileWriteThroughAsync: async (source, destination) => fs.renameSync(source, destination),
    async flushDirectoryAsync() {}
  };
}

function fixture(t, { repositoryFs = fs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-state-repository-'));
  const serverPath = path.join(root, 'candidate');
  fs.mkdirSync(serverPath);
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ maxRam: 8, contentRevision: 2 }));
  const durableStorage = createDurableFs({
    fsApi: fs,
    durableClient: nativeClient(),
    allowedRoots: [root],
    tempNameFactory: (() => { let id = 0; return () => `state-${++id}`; })()
  });
  const durableFs = { ...durableStorage };
  const repository = new ModpackStateRepository({
    fsApi: repositoryFs,
    durableFs,
    clock: () => new Date('2026-08-01T12:00:00.000Z')
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repository, durableFs, root, serverPath };
}

function runtime() {
  return {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
}

function assetPattern() {
  return compileAssetPattern({
    filenameMatcher: 'server-pack-*.zip',
    reviewedRole: 'server-pack',
    archiveRootFingerprint: 'a'.repeat(64),
    runtimeEvidence: runtime(),
    multipartStructure: { kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 },
    userOverrides: { rootChoice: 'primary' }
  });
}

function state() {
  return {
    schemaVersion: 1,
    modpackManaged: true,
    source: {
      provider: 'github', repositoryId: '1234', releaseId: '5678', githubOwner: 'Owner', githubRepo: 'Pack',
      version: 'v2.0.0-beta.1', title: 'Pack', channel: 'prerelease', prerelease: true,
      publishedAt: '2026-07-31T20:15:00.000Z',
      selectedAssetIds: ['901', '902'],
      artifactSetDigest: 'd'.repeat(64),
      assetPattern: assetPattern(),
      acceptedMapping: {
        type: 'provider-source-mapping', version: 1, modrinthProjectId: 'pack-project',
        githubRepositoryId: '1234', githubOwner: 'Owner', githubRepo: 'Pack'
      }
    },
    runtime: runtime(),
    selectedOptionalFiles: ['optional-config'],
    installedAt: '2026-08-01T11:00:00.000Z',
    contentRevision: 3,
    manifest: {
      schemaVersion: 1,
      installationId: 'install-0001',
      entries: [
        { path: 'mods/a.jar', pathKey: 'mods/a.jar', origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod', installedHash: '1'.repeat(64), size: '4', priorBaseline: null },
        { path: 'server.properties', pathKey: 'server.properties', origin: 'user', managementPolicy: 'protected', role: 'configuration', installedHash: '2'.repeat(64), size: '8', priorBaseline: null }
      ]
    }
  };
}

function stateWithManifestEntries(entryCount) {
  const candidate = state();
  candidate.manifest.entries = Array.from({ length: entryCount }, (_, index) => {
    const basename = `tfg-${String(index).padStart(5, '0')}.jar`;
    return {
      path: `mods/${basename}`,
      pathKey: `mods/${basename}`,
      origin: 'pack',
      managementPolicy: 'replaceable-managed',
      role: 'mod',
      installedHash: index.toString(16).padStart(64, '0'),
      size: String(index + 1),
      priorBaseline: null
    };
  });
  return candidate;
}

test('async candidate publication uses only async durability in manifest, state, then summary order', async (t) => {
  const { repository, durableFs, serverPath } = fixture(t);
  const publications = [];
  let manifestPublished = false;
  let statePublished = false;
  const writeFileAtomicAsync = durableFs.writeFileAtomicAsync.bind(durableFs);
  const writeJsonAtomicAsync = durableFs.writeJsonAtomicAsync.bind(durableFs);
  const flushDirectoryAsync = durableFs.flushDirectoryAsync.bind(durableFs);
  durableFs.writeFileAtomic = () => { throw new Error('synchronous durable file publication must not run'); };
  durableFs.writeJsonAtomic = () => { throw new Error('synchronous durable JSON publication must not run'); };
  durableFs.flushDirectory = () => { throw new Error('synchronous durable directory flush must not run'); };
  durableFs.flushDirectoryAsync = (...args) => flushDirectoryAsync(...args);
  durableFs.writeFileAtomicAsync = async (filePath, bytes, options) => {
    publications.push({ kind: 'manifest', filePath, options });
    const result = await writeFileAtomicAsync(filePath, bytes, options);
    manifestPublished = true;
    return result;
  };
  durableFs.writeJsonAtomicAsync = async (filePath, value, options) => {
    const kind = path.basename(filePath) === 'modpack.json' ? 'state' : 'summary';
    assert.equal(manifestPublished, true);
    if (kind === 'summary') assert.equal(statePublished, true);
    publications.push({
      kind,
      filePath,
      options
    });
    const result = await writeJsonAtomicAsync(filePath, value, options);
    if (kind === 'state') statePublished = true;
    return result;
  };

  const written = await repository.writeCandidateAsync(serverPath, state());

  assert.deepEqual(publications.map(item => item.kind), ['manifest', 'state', 'summary']);
  assert.deepEqual(publications[0].options, { expectedTargetSha256: null });
  assert.equal(publications[1].options, undefined);
  assert.equal(publications[2].options, undefined);
  assert.deepEqual(repository.read(serverPath), written);
});

test('async candidate publication lets the event loop advance while manifest publication is pending', async (t) => {
  const { repository, durableFs, serverPath } = fixture(t);
  const writeFileAtomicAsync = durableFs.writeFileAtomicAsync.bind(durableFs);
  let enterManifestPublication;
  const manifestPublicationEntered = new Promise(resolve => { enterManifestPublication = resolve; });
  let releaseManifestPublication;
  const manifestPublicationGate = new Promise(resolve => { releaseManifestPublication = resolve; });
  durableFs.writeFileAtomicAsync = async (...args) => {
    enterManifestPublication();
    await manifestPublicationGate;
    return writeFileAtomicAsync(...args);
  };

  let settled = false;
  const pending = repository.writeCandidateAsync(serverPath, state()).finally(() => { settled = true; });
  await manifestPublicationEntered;
  let eventLoopAdvanced = false;
  await new Promise(resolve => setImmediate(() => {
    eventLoopAdvanced = true;
    resolve();
  }));

  assert.equal(eventLoopAdvanced, true);
  assert.equal(settled, false);
  releaseManifestPublication();
  await pending;
});

test('async candidate publication rejects missing async durability before creating repository layout', async (t) => {
  const { repository, durableFs, serverPath } = fixture(t);
  durableFs.writeFileAtomicAsync = undefined;

  await assert.rejects(
    repository.writeCandidateAsync(serverPath, state()),
    error => error?.code === 'INVALID_REQUEST' && error?.details?.field === 'repository'
  );
  assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false);
});

test('async history publication uses async durability and yields while its immutable record is pending', async (t) => {
  const { repository, durableFs, serverPath } = fixture(t);
  const writeJsonAtomicAsync = durableFs.writeJsonAtomicAsync.bind(durableFs);
  const flushDirectoryAsync = durableFs.flushDirectoryAsync.bind(durableFs);
  durableFs.writeJsonAtomic = () => { throw new Error('synchronous durable JSON publication must not run'); };
  durableFs.flushDirectory = () => { throw new Error('synchronous durable directory flush must not run'); };
  durableFs.flushDirectoryAsync = (...args) => flushDirectoryAsync(...args);
  let enterPublication;
  const publicationEntered = new Promise(resolve => { enterPublication = resolve; });
  let releasePublication;
  const publicationGate = new Promise(resolve => { releasePublication = resolve; });
  durableFs.writeJsonAtomicAsync = async (...args) => {
    enterPublication();
    await publicationGate;
    return writeJsonAtomicAsync(...args);
  };
  const entry = {
    schemaVersion: 1,
    operationId: 'async-operation-1',
    sequence: 1,
    kind: 'install',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: 0,
    targetRevision: 1
  };

  let settled = false;
  const pending = repository.appendHistoryAsync(serverPath, entry).finally(() => { settled = true; });
  await publicationEntered;
  let eventLoopAdvanced = false;
  await new Promise(resolve => setImmediate(() => {
    eventLoopAdvanced = true;
    resolve();
  }));

  assert.equal(eventLoopAdvanced, true);
  assert.equal(settled, false);
  releasePublication();
  assert.deepEqual(await pending, entry);
  assert.deepEqual(repository.listHistory(serverPath).items, [entry]);
});

test('async history publication rejects missing async durability before creating repository layout', async (t) => {
  const { repository, durableFs, serverPath } = fixture(t);
  durableFs.writeJsonAtomicAsync = undefined;

  await assert.rejects(
    repository.appendHistoryAsync(serverPath, {
      schemaVersion: 1,
      operationId: 'async-missing-durability',
      sequence: 1,
      kind: 'install',
      outcome: 'completed',
      timestamp: '2026-08-01T12:00:00.000Z',
      sourceRevision: 0,
      targetRevision: 1
    }),
    error => error?.code === 'INVALID_REQUEST' && error?.details?.field === 'repository'
  );
  assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false);
});

test('async history keeps immutable JSON authoritative when optional indexes fail and enforces sequence order', async (t) => {
  const markerFailure = Object.assign(new Error('history index publication failed'), { code: 'EIO' });
  const repositoryFs = Object.create(fs);
  repositoryFs.openSync = (filePath, ...args) => {
    if (path.basename(filePath).endsWith('.idx')) throw markerFailure;
    return fs.openSync(filePath, ...args);
  };
  const { repository, serverPath } = fixture(t, { repositoryFs });
  const entry = (operationId, sequence) => ({
    schemaVersion: 1,
    operationId,
    sequence,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: sequence,
    targetRevision: sequence + 1
  });

  assert.deepEqual(await repository.appendHistoryAsync(serverPath, entry('async-index-4', 4)), entry('async-index-4', 4));
  await assert.rejects(
    repository.appendHistoryAsync(serverPath, entry('async-duplicate-sequence', 4)),
    error => error?.code === 'PLAN_STALE'
  );
  assert.deepEqual(await repository.appendHistoryAsync(serverPath, entry('async-index-7', 7)), entry('async-index-7', 7));

  assert.deepEqual(repository.listHistory(serverPath).items.map(item => item.sequence), [7, 4]);
  assert.deepEqual(
    fs.readdirSync(path.join(serverPath, '.minecraft-core-state', 'history')).sort(),
    ['async-index-4.json', 'async-index-7.json']
  );
});

test('candidate state accepts a TerraFirmaGreg-sized managed ownership manifest', (t) => {
  const { repository, serverPath } = fixture(t);
  const written = repository.writeCandidate(serverPath, stateWithManifestEntries(4_234));

  assert.equal(written.manifest.entries.length, 4_234);
  assert.equal(repository.read(serverPath).manifest.entries.length, 4_234);
});

test('candidate state rejects ownership manifests beyond its explicit entry boundary', (t) => {
  const { repository, serverPath } = fixture(t);

  assert.throws(
    () => repository.writeCandidate(serverPath, stateWithManifestEntries(10_001)),
    error => error?.code === 'INVALID_REQUEST' && error?.details?.field === 'state.manifest'
  );
  assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json')), false);
});

test('candidate state retains the eight MiB serialized manifest boundary before mutation', (t) => {
  const { repository, serverPath } = fixture(t);
  const candidate = stateWithManifestEntries(6_000);
  const longPrefix = ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200), 'd'.repeat(200)].join('/');
  for (let index = 0; index < candidate.manifest.entries.length; index += 1) {
    const relativePath = `${longPrefix}/${String(index).padStart(5, '0')}.json`;
    candidate.manifest.entries[index].path = relativePath;
    candidate.manifest.entries[index].pathKey = relativePath;
  }

  assert.throws(
    () => repository.writeCandidate(serverPath, candidate),
    error => error?.code === 'INVALID_REQUEST' && error?.details?.field === 'state.manifest'
  );
  assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false);
});

test('candidate state round-trips exact managed identity and preserves backward-compatible config fields', (t) => {
  const { repository, serverPath } = fixture(t);
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({
    maxRam: 8,
    contentRevision: 2,
    version: '1.20.1',
    fabric: '0.15.10',
    loader: 'fabric',
    loaderVersion: '0.15.10',
    javaVersion: 17
  }));
  const written = repository.writeCandidate(serverPath, state());
  assert.equal(written.state.manifestId, 'install-0001');
  const loaded = repository.read(serverPath);
  assert.deepEqual(loaded, written);
  assert.equal(Object.isFrozen(loaded), true);
  const summary = JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8'));
  assert.equal(summary.maxRam, 8);
  assert.equal(summary.contentRevision, 3);
  assert.equal(summary.modpackManaged, true);
  assert.equal(summary.modpackProvider, 'github');
  assert.equal(summary.modpackReleaseId, '5678');
  assert.equal(loaded.state.source.githubOwner, 'Owner');
  assert.equal(loaded.state.source.githubRepo, 'Pack');
  assert.equal(loaded.state.source.channel, 'prerelease');
  assert.equal(loaded.state.source.prerelease, true);
  assert.equal(loaded.state.source.publishedAt, '2026-07-31T20:15:00.000Z');
  assert.deepEqual(loaded.state.source.selectedAssetIds, ['901', '902']);
  assert.equal(loaded.state.source.artifactSetDigest, 'd'.repeat(64));
  assert.equal(summary.runtime.loaderFamily, 'fabric');
  assert.equal(summary.version, '1.21.1');
  assert.equal(summary.loader, 'fabric');
  assert.equal(summary.loaderVersion, '0.16.14');
  assert.equal(summary.fabric, '0.16.14');
  assert.equal(summary.javaVersion, 21);
  const persisted = fs.readFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), 'utf8');
  assert.doesNotMatch(persisted, /https?:|cache|archivePath|serverPath/i);
});

test('GitHub source identity requires trusted owner and repository names and forbids them elsewhere', (t) => {
  const { repository, serverPath } = fixture(t);
  for (const field of ['githubOwner', 'githubRepo']) {
    const missing = state();
    delete missing.source[field];
    assert.throws(() => repository.writeCandidate(serverPath, missing), error => error.code === 'INVALID_REQUEST');
  }
  const invalidOwner = state();
  invalidOwner.source.githubOwner = '-owner';
  assert.throws(() => repository.writeCandidate(serverPath, invalidOwner), error => error.code === 'INVALID_REQUEST');
  const modrinth = state();
  modrinth.source = {
    provider: 'modrinth', projectId: 'project', versionId: 'version', version: '1.0.0', title: 'Pack',
    githubOwner: 'Owner', githubRepo: 'Pack'
  };
  assert.throws(() => repository.writeCandidate(serverPath, modrinth), error => error.code === 'INVALID_REQUEST');
  const modrinthMetadata = state();
  modrinthMetadata.source = {
    provider: 'modrinth', projectId: 'project', versionId: 'version-beta-2',
    version: '2.0.0-beta.2', title: 'Pack', channel: 'beta', prerelease: true,
    publishedAt: '2026-07-31T20:15:00.000Z'
  };
  const modrinthWritten = repository.writeCandidate(serverPath, modrinthMetadata);
  assert.deepEqual(modrinthWritten.state.source, modrinthMetadata.source);

  for (const provider of ['local']) {
    const nonGithub = state();
    nonGithub.source = provider === 'modrinth'
      ? { provider, projectId: 'project', versionId: 'version', version: '1.0.0', title: 'Pack' }
      : { provider, importId: 'import-1', artifactSha256: 'a'.repeat(64), version: 'local-1', title: 'Pack' };
    Object.assign(nonGithub.source, {
      channel: 'release', prerelease: false, publishedAt: '2026-07-31T20:15:00.000Z'
    });
    assert.throws(() => repository.writeCandidate(serverPath, nonGithub), error => error.code === 'INVALID_REQUEST');
  }

  for (const selectedAssetIds of [['901', '901'], ['not-an-asset']]) {
    const invalidAssets = state();
    invalidAssets.source.selectedAssetIds = selectedAssetIds;
    assert.throws(() => repository.writeCandidate(serverPath, invalidAssets), error => error.code === 'INVALID_REQUEST');
  }
});

test('state rejects reserved ownership, EULA ownership, duplicate canonical paths, and untrusted fields', (t) => {
  const { repository, serverPath } = fixture(t);
  for (const entry of [
    { path: '.minecraft-core.json' },
    { path: '.minecraft-core-state/modpack.json' },
    { path: 'eula.txt' },
    { path: '../outside.txt' }
  ]) {
    const candidate = state();
    candidate.manifest.entries[0] = { ...candidate.manifest.entries[0], ...entry, pathKey: entry.path.toLocaleLowerCase('en-US') };
    assert.throws(() => repository.writeCandidate(serverPath, candidate), error => error.code === 'INVALID_REQUEST');
  }
  const duplicate = state();
  duplicate.manifest.entries.push({ ...duplicate.manifest.entries[0], path: 'MODS/A.JAR', pathKey: 'mods/a.jar' });
  assert.throws(() => repository.writeCandidate(serverPath, duplicate), error => error.code === 'INVALID_REQUEST');
  const leaked = state();
  leaked.source.url = 'https://example.invalid/token';
  assert.throws(() => repository.writeCandidate(serverPath, leaked), error => error.code === 'INVALID_REQUEST');
});

test('ownership manifests are immutable and content revision cannot move backward', (t) => {
  const { repository, serverPath } = fixture(t);
  repository.writeCandidate(serverPath, state());
  const replacedManifest = state();
  replacedManifest.manifest.entries[0].installedHash = '9'.repeat(64);
  assert.throws(() => repository.writeCandidate(serverPath, replacedManifest), error => error.code === 'TARGET_EXISTS');
  assert.equal(repository.read(serverPath).manifest.entries[0].installedHash, '1'.repeat(64));

  const stale = state();
  stale.manifest.installationId = 'install-0002';
  stale.contentRevision = 1;
  assert.throws(() => repository.writeCandidate(serverPath, stale), error => error.code === 'PLAN_STALE');
  assert.equal(repository.read(serverPath).state.contentRevision, 3);
});

test('history is immutable, deterministically paginated, and detach preserves files while disabling management', (t) => {
  const { repository, serverPath } = fixture(t);
  repository.writeCandidate(serverPath, state());
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    repository.appendHistory(serverPath, {
      schemaVersion: 1,
      operationId: `operation-${sequence}`,
      sequence,
      kind: sequence === 3 ? 'detach' : 'upgrade',
      outcome: 'completed',
      timestamp: `2026-08-01T0${sequence}:00:00.000Z`,
      sourceRevision: sequence,
      targetRevision: sequence + 1
    });
  }
  assert.throws(() => repository.appendHistory(serverPath, {
    schemaVersion: 1, operationId: 'operation-1', sequence: 9, kind: 'upgrade', outcome: 'completed',
    timestamp: '2026-08-01T09:00:00.000Z', sourceRevision: 1, targetRevision: 2
  }), error => error.code === 'TARGET_EXISTS');
  const first = repository.listHistory(serverPath, { cursor: null, limit: 2 });
  assert.deepEqual(first.items.map(item => item.operationId), ['operation-3', 'operation-2']);
  assert.equal(typeof first.nextCursor, 'string');
  assert.notEqual(first.nextCursor, 'operation-2');
  const second = repository.listHistory(serverPath, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.items.map(item => item.operationId), ['operation-1']);
  const tamperedCursor = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('a') ? 'b' : 'a'}`;
  assert.throws(() => repository.listHistory(serverPath, { cursor: tamperedCursor, limit: 2 }), error => error.code === 'INVALID_REQUEST');
  const detached = repository.detachCandidate(serverPath, {
    operationId: 'operation-detach', timestamp: '2026-08-01T12:00:00.000Z', contentRevision: 4,
    restorePointId: 'restore-before-detach', restorePointSha256: 'a'.repeat(64),
    restorePointTotalBytes: '987654321'
  });
  assert.equal(detached.modpackManaged, false);
  assert.equal(repository.read(serverPath).state.modpackManaged, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8')).modpackManaged, false);
  assert.equal(fs.existsSync(path.join(serverPath, 'mods')), false);
  assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state', 'operations')), true);
  const detachHistory = repository.listHistory(serverPath).items[0];
  assert.equal(detachHistory.restorePointId, 'restore-before-detach');
  assert.equal(detachHistory.restorePointSha256, 'a'.repeat(64));
  assert.equal(detachHistory.restorePointTotalBytes, '987654321');
});

test('detach and uninstall reject an unpaired safety restore reference before changing managed state', (t) => {
  const { repository, serverPath } = fixture(t);
  repository.writeCandidate(serverPath, state());
  assert.throws(() => repository.detachCandidate(serverPath, {
    operationId: 'operation-detach-unpaired', timestamp: '2026-08-01T12:00:00.000Z', contentRevision: 4,
    restorePointId: 'restore-before-detach'
  }), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => repository.uninstallCandidate(serverPath, {
    operationId: 'operation-uninstall-unpaired', timestamp: '2026-08-01T12:00:00.000Z', contentRevision: 4,
    restorePointSha256: 'b'.repeat(64),
    confirmation: {
      unchangedManagedRemovalCount: '0', preservedCategories: [], possibleNonRunnable: false,
      instanceRetained: true, worldsRetained: true
    }
  }), error => error.code === 'INVALID_REQUEST');
  assert.equal(repository.read(serverPath).state.modpackManaged, true);
  assert.deepEqual(repository.listHistory(serverPath).items, []);
});

test('history inspection does not create managed state directories for an unmanaged server', (t) => {
  const { repository, serverPath } = fixture(t);
  const before = fs.readdirSync(serverPath).sort();

  assert.deepEqual(repository.listHistory(serverPath), { items: [], nextCursor: null });

  assert.deepEqual(fs.readdirSync(serverPath).sort(), before);
  assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core-state')), false);
});

test('history inspection reads legacy immutable records without publishing index markers or sibling directories', (t) => {
  const { repository, serverPath } = fixture(t);
  const stateRoot = path.join(serverPath, '.minecraft-core-state');
  const historyPath = path.join(stateRoot, 'history');
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(historyPath);
  fs.writeFileSync(path.join(historyPath, 'legacy-operation.json'), `${JSON.stringify({
    schemaVersion: 1,
    operationId: 'legacy-operation',
    sequence: 1,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: 1,
    targetRevision: 2
  })}\n`);

  const result = repository.listHistory(serverPath);

  assert.deepEqual(result.items.map(item => item.operationId), ['legacy-operation']);
  assert.deepEqual(fs.readdirSync(stateRoot), ['history']);
  assert.deepEqual(fs.readdirSync(historyPath), ['legacy-operation.json']);
});

test('history sequence is strictly increasing and detach allocates the next unique sequence', (t) => {
  const { repository, serverPath } = fixture(t);
  repository.writeCandidate(serverPath, state());
  repository.appendHistory(serverPath, {
    schemaVersion: 1,
    operationId: 'operation-failed',
    sequence: 4,
    kind: 'upgrade',
    outcome: 'failed',
    timestamp: '2026-08-01T11:30:00.000Z',
    sourceRevision: 3,
    targetRevision: 3
  });
  for (const [operationId, sequence] of [['operation-duplicate-sequence', 4], ['operation-out-of-order', 2]]) {
    assert.throws(() => repository.appendHistory(serverPath, {
      schemaVersion: 1,
      operationId,
      sequence,
      kind: 'repair',
      outcome: 'failed',
      timestamp: '2026-08-01T11:45:00.000Z',
      sourceRevision: 3,
      targetRevision: 3
    }), error => error.code === 'PLAN_STALE');
  }
  repository.detachCandidate(serverPath, {
    operationId: 'operation-detach-after-failure',
    timestamp: '2026-08-01T12:00:00.000Z',
    contentRevision: 4
  });
  assert.deepEqual(repository.listHistory(serverPath).items.map(entry => entry.sequence), [5, 4]);
});

test('history append and bounded pages read only the adjacent indexed records', (t) => {
  const { repository, durableFs, serverPath } = fixture(t);
  for (let sequence = 1; sequence <= 40; sequence += 1) {
    repository.appendHistory(serverPath, {
      schemaVersion: 1,
      operationId: `operation-${String(sequence).padStart(2, '0')}`,
      sequence,
      kind: 'upgrade',
      outcome: 'completed',
      timestamp: '2026-08-01T12:00:00.000Z',
      sourceRevision: sequence,
      targetRevision: sequence + 1
    });
  }

  const reads = [];
  const originalRead = durableFs.readFileBounded.bind(durableFs);
  durableFs.readFileBounded = (filePath, options) => {
    reads.push(path.basename(filePath));
    return originalRead(filePath, options);
  };

  repository.appendHistory(serverPath, {
    schemaVersion: 1,
    operationId: 'operation-41',
    sequence: 41,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: 41,
    targetRevision: 42
  });
  assert.deepEqual(reads.filter(name => /^operation-\d+\.json$/u.test(name)), ['operation-40.json']);

  reads.length = 0;
  const first = repository.listHistory(serverPath, { cursor: null, limit: 2 });
  assert.deepEqual(first.items.map(entry => entry.operationId), ['operation-41', 'operation-40']);
  assert.deepEqual(
    reads.filter(name => /^operation-\d+\.json$/u.test(name)).sort(),
    ['operation-40.json', 'operation-41.json']
  );
  assert.equal(reads.some(name => name === 'operation-01.json'), false);
});

test('legacy history indexes remain read-only until the next explicit history mutation rebuilds them', (t) => {
  const { repository, serverPath } = fixture(t);
  const stateRoot = path.join(serverPath, '.minecraft-core-state');
  const historyPath = path.join(serverPath, '.minecraft-core-state', 'history');
  fs.mkdirSync(stateRoot);
  fs.mkdirSync(historyPath);
  const entry = sequence => ({
    schemaVersion: 1,
    operationId: `legacy-${sequence}`,
    sequence,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: sequence,
    targetRevision: sequence + 1
  });
  fs.writeFileSync(path.join(historyPath, 'legacy-4.json'), `${JSON.stringify(entry(4))}\n`);
  fs.writeFileSync(path.join(historyPath, 'legacy-7.json'), `${JSON.stringify(entry(7))}\n`);

  assert.deepEqual(repository.listHistory(serverPath).items.map(item => item.sequence), [7, 4]);
  const indexNames = fs.readdirSync(historyPath).filter(name => name.endsWith('.idx'));
  assert.equal(indexNames.length, 0);

  repository.appendHistory(serverPath, entry(9));
  assert.deepEqual(repository.listHistory(serverPath).items.map(item => item.sequence), [9, 7, 4]);
  assert.equal(fs.readdirSync(historyPath).filter(name => name.endsWith('.idx')).length, 3);
});

test('history index mismatches fail closed without hiding immutable records', (t) => {
  const { repository, serverPath } = fixture(t);
  repository.appendHistory(serverPath, {
    schemaVersion: 1,
    operationId: 'indexed-operation',
    sequence: 1,
    kind: 'install',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: 0,
    targetRevision: 1
  });
  const historyPath = path.join(serverPath, '.minecraft-core-state', 'history');
  const indexName = fs.readdirSync(historyPath).find(name => name.endsWith('.idx'));
  const mismatchedName = indexName.replace('0000000000000001', '0000000000000002');
  fs.renameSync(path.join(historyPath, indexName), path.join(historyPath, mismatchedName));
  assert.throws(() => repository.listHistory(serverPath), error => error.code === 'INVALID_REQUEST');
  assert.equal(fs.existsSync(path.join(historyPath, 'indexed-operation.json')), true);
});

test('history skips a crashed writer temp of a history record but fails closed on other entries', (t) => {
  const { repository, serverPath } = fixture(t);
  const entry = sequence => ({
    schemaVersion: 1,
    operationId: `operation-${sequence}`,
    sequence,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: sequence,
    targetRevision: sequence + 1
  });
  repository.appendHistory(serverPath, entry(1));
  const historyPath = path.join(serverPath, '.minecraft-core-state', 'history');
  const leftover = path.join(historyPath, `.operation-2.json.minecraft-core-tmp-${crypto.randomUUID()}`);
  fs.writeFileSync(leftover, '{"partial":');

  assert.deepEqual(repository.listHistory(serverPath).items.map(item => item.operationId), ['operation-1']);
  repository.appendHistory(serverPath, entry(2));
  assert.deepEqual(repository.listHistory(serverPath).items.map(item => item.sequence), [2, 1]);
  assert.equal(fs.existsSync(leftover), true);

  for (const [name, kind] of [['junk.txt', 'file'], [`.junk.txt.minecraft-core-tmp-${crypto.randomUUID()}`, 'file'],
    [`.operation-3.json.minecraft-core-tmp-${crypto.randomUUID()}`, 'directory']]) {
    const unexpected = path.join(historyPath, name);
    if (kind === 'file') fs.writeFileSync(unexpected, 'unexpected');
    else fs.mkdirSync(unexpected);
    assert.throws(() => repository.listHistory(serverPath), error => error.code === 'INVALID_REQUEST', name);
    fs.rmSync(unexpected, { recursive: true });
  }
});

test('immutable history append remains successful when its optional index marker cannot be published', (t) => {
  const markerFailure = Object.assign(new Error('history index publication failed'), { code: 'EIO' });
  const repositoryFs = Object.create(fs);
  repositoryFs.openSync = (filePath, ...args) => {
    if (path.basename(filePath).endsWith('.idx')) throw markerFailure;
    return fs.openSync(filePath, ...args);
  };
  const { repository, serverPath } = fixture(t, { repositoryFs });
  const entry = sequence => ({
    schemaVersion: 1,
    operationId: `index-failure-${sequence}`,
    sequence,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: sequence,
    targetRevision: sequence + 1
  });

  assert.deepEqual(repository.appendHistory(serverPath, entry(1)), entry(1));
  assert.deepEqual(repository.appendHistory(serverPath, entry(2)), entry(2));
  assert.deepEqual(repository.listHistory(serverPath).items.map(item => item.sequence), [2, 1]);
  assert.deepEqual(
    fs.readdirSync(path.join(serverPath, '.minecraft-core-state', 'history')).sort(),
    ['index-failure-1.json', 'index-failure-2.json']
  );
});

test('state-backed filenames reject Win32 device names and alternate-data-stream separators', (t) => {
  const { repository, serverPath } = fixture(t);
  for (const installationId of ['CON', 'manifest:stream']) {
    const candidate = state();
    candidate.manifest.installationId = installationId;
    assert.throws(() => repository.writeCandidate(serverPath, candidate), error => error.code === 'INVALID_REQUEST');
  }
  repository.writeCandidate(serverPath, state());
  for (const operationId of ['AUX', 'history:stream']) {
    assert.throws(() => repository.appendHistory(serverPath, {
      schemaVersion: 1,
      operationId,
      sequence: 1,
      kind: 'upgrade',
      outcome: 'failed',
      timestamp: '2026-08-01T12:00:00.000Z',
      sourceRevision: 3,
      targetRevision: 3
    }), error => error.code === 'INVALID_REQUEST');
  }
});

test('persisted mapping evidence must identify the selected permanent provider ID', (t) => {
  const { repository, serverPath } = fixture(t);
  const github = state();
  github.source.acceptedMapping.githubRepositoryId = '9999';
  assert.throws(() => repository.writeCandidate(serverPath, github), error => error.code === 'INVALID_REQUEST');

  const modrinth = state();
  modrinth.source = {
    provider: 'modrinth',
    projectId: 'different-project',
    versionId: 'version-1',
    version: 'v2.0.0',
    title: 'Pack',
    acceptedMapping: state().source.acceptedMapping
  };
  assert.throws(() => repository.writeCandidate(serverPath, modrinth), error => error.code === 'INVALID_REQUEST');
});

test('switching providers removes stale summary identity fields', (t) => {
  const { repository, serverPath } = fixture(t);
  repository.writeCandidate(serverPath, state());
  const switched = state();
  switched.contentRevision = 4;
  switched.manifest.installationId = 'install-0002';
  switched.source = {
    provider: 'modrinth',
    projectId: 'pack-project',
    versionId: 'version-3',
    version: 'v3.0.0',
    title: 'Pack',
    acceptedMapping: state().source.acceptedMapping
  };
  repository.writeCandidate(serverPath, switched);
  const summary = JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8'));
  assert.equal(summary.modpackProvider, 'modrinth');
  assert.equal(summary.modpackProjectId, 'pack-project');
  assert.equal(summary.modpackVersionId, 'version-3');
  assert.equal(Object.hasOwn(summary, 'modpackRepositoryId'), false);
  assert.equal(Object.hasOwn(summary, 'modpackReleaseId'), false);
  assert.equal(Object.hasOwn(summary, 'modpackImportId'), false);
});

test('every repository-owned JSON document excludes remote and workspace metadata', (t) => {
  const { repository, serverPath } = fixture(t);
  repository.writeCandidate(serverPath, state());
  repository.appendHistory(serverPath, {
    schemaVersion: 1,
    operationId: 'operation-1',
    sequence: 1,
    kind: 'install',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: 2,
    targetRevision: 3,
    targetRuntime: runtime()
  });
  const documents = [
    path.join(serverPath, '.minecraft-core.json'),
    path.join(serverPath, '.minecraft-core-state', 'modpack.json'),
    path.join(serverPath, '.minecraft-core-state', 'manifests', 'install-0001.json'),
    path.join(serverPath, '.minecraft-core-state', 'history', 'operation-1.json')
  ];
  for (const document of documents) {
    const serialized = fs.readFileSync(document, 'utf8');
    assert.doesNotMatch(serialized, /https?:\/\/|"(?:cachePath|archivePath|serverPath|workspaceId|workspacePath|sourceUrl|downloadUrl)"/i);
  }
  assert.throws(() => repository.appendHistory(serverPath, {
    schemaVersion: 1,
    operationId: 'operation-leak',
    sequence: 2,
    kind: 'install',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: 2,
    targetRevision: 3,
    sourceUrl: 'https://example.invalid/private'
  }), error => error.code === 'INVALID_REQUEST');
});

test('detach preflights its immutable history ID before changing managed state', (t) => {
  const { repository, serverPath } = fixture(t);
  repository.writeCandidate(serverPath, state());
  repository.appendHistory(serverPath, {
    schemaVersion: 1, operationId: 'operation-detach', sequence: 4, kind: 'detach', outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z', sourceRevision: 3, targetRevision: 4
  });
  assert.throws(() => repository.detachCandidate(serverPath, {
    operationId: 'operation-detach', timestamp: '2026-08-01T12:00:00.000Z', contentRevision: 4
  }), error => error.code === 'TARGET_EXISTS');
  assert.equal(repository.read(serverPath).state.modpackManaged, true);
  assert.equal(repository.read(serverPath).state.contentRevision, 3);
});

test('repository inputs reject accessors, symbols, prototypes, and raw traversal without executing hooks', (t) => {
  const { repository, root, serverPath } = fixture(t);
  let calls = 0;
  const candidate = state();
  Object.defineProperty(candidate.source, 'provider', { enumerable: true, get() { calls += 1; return 'github'; } });
  assert.throws(() => repository.writeCandidate(serverPath, candidate), error => error.code === 'INVALID_REQUEST');
  assert.equal(calls, 0);
  const inherited = Object.create({ provider: 'github' });
  assert.throws(() => repository.writeCandidate(serverPath, inherited), error => error.code === 'INVALID_REQUEST');
  const traversal = `${root}${path.sep}alias${path.sep}..${path.sep}candidate`;
  assert.throws(() => repository.read(traversal), error => error.code === 'INVALID_REQUEST');
});
