const assert = require('node:assert/strict');
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
    flushDirectory() {}
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-state-repository-'));
  const serverPath = path.join(root, 'candidate');
  fs.mkdirSync(serverPath);
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify({ maxRam: 8, contentRevision: 2 }));
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: nativeClient(),
    allowedRoots: [root],
    tempNameFactory: (() => { let id = 0; return () => `state-${++id}`; })()
  });
  const repository = new ModpackStateRepository({
    fsApi: fs,
    durableFs,
    clock: () => new Date('2026-08-01T12:00:00.000Z')
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { repository, root, serverPath };
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
      version: 'v2.0.0', title: 'Pack',
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

test('candidate state round-trips exact managed identity and preserves backward-compatible config fields', (t) => {
  const { repository, serverPath } = fixture(t);
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
  assert.deepEqual(loaded.state.source.selectedAssetIds, ['901', '902']);
  assert.equal(loaded.state.source.artifactSetDigest, 'd'.repeat(64));
  assert.equal(summary.runtime.loaderFamily, 'fabric');
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
