const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CLIENT_PACK_MANIFEST,
  SERVER_EVIDENCE_ENTRIES,
  SERVER_STATE_DIRECTORY,
  inspectFolderEvidence
} = require('../electron/services/modpacks/instance-ownership.cjs');
const {
  CURRENT_STATE,
  ModpackStateRepository,
  STATE_DIRECTORY,
  createModpackStateObserver
} = require('../electron/services/modpacks/state/modpack-state-repository.cjs');
const { MANIFEST_NAME } = require('../electron/services/client-modpacks/client-pack-state.cjs');
const { compileAssetPattern } = require('../electron/services/modpacks/providers/github-asset-pattern.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ownership-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const durableFs = createDurableFs({
    fsApi: fs,
    allowedRoots: [root],
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {},
      moveWriteThroughAsync: fs.promises.rename,
      replaceFileWriteThroughAsync: fs.promises.rename,
      async flushDirectoryAsync() {}
    }
  });
  const repository = new ModpackStateRepository({ fsApi: fs, durableFs, clock: () => new Date('2026-08-01T12:00:00.000Z') });
  return { root, repository };
}

function runtime() {
  return { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14', javaMajor: 21, os: 'win32', architecture: 'x64' };
}

function managedState() {
  return {
    schemaVersion: 1,
    modpackManaged: true,
    source: {
      provider: 'github', repositoryId: '1234', releaseId: '5678', githubOwner: 'Owner', githubRepo: 'Pack',
      version: 'v2.0.0', title: 'Pack', channel: 'release', prerelease: false,
      publishedAt: '2026-07-31T20:15:00.000Z',
      selectedAssetIds: ['901'],
      artifactSetDigest: 'd'.repeat(64),
      assetPattern: compileAssetPattern({
        filenameMatcher: 'server-pack-*.zip',
        reviewedRole: 'server-pack',
        archiveRootFingerprint: 'a'.repeat(64),
        runtimeEvidence: runtime(),
        multipartStructure: { kind: 'single', groupingScheme: 'single', partCount: 1, primaryIndex: 0 },
        userOverrides: { rootChoice: 'primary' }
      }),
      acceptedMapping: null
    },
    runtime: runtime(),
    selectedOptionalFiles: [],
    installedAt: '2026-08-01T11:00:00.000Z',
    contentRevision: 3,
    manifest: {
      schemaVersion: 1,
      installationId: 'install-0001',
      entries: [
        { path: 'mods/a.jar', pathKey: 'mods/a.jar', origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod', installedHash: '1'.repeat(64), size: '4', priorBaseline: null }
      ]
    }
  };
}

function serverFolder(root, name) {
  const folder = path.join(root, name);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, '.minecraft-core.json'), '{"port":25565}\n');
  return folder;
}

function outcome(read) {
  try {
    const value = read();
    return { value: value === null ? null : { modpackManaged: value.state.modpackManaged, installationId: value.manifest?.installationId ?? null } };
  } catch (error) {
    return { error: error.code };
  }
}

test('the ownership predicate names the state repository layout and the client-pack manifest', (t) => {
  assert.equal(SERVER_STATE_DIRECTORY, STATE_DIRECTORY);
  assert.ok(SERVER_EVIDENCE_ENTRIES.includes(CURRENT_STATE));
  assert.equal(CLIENT_PACK_MANIFEST, MANIFEST_NAME);

  const { root, repository } = fixture(t);
  const folder = serverFolder(root, 'Published');
  repository.writeCandidate(folder, managedState());
  assert.deepEqual(fs.readdirSync(path.join(folder, STATE_DIRECTORY)).sort(), [...SERVER_EVIDENCE_ENTRIES].sort(),
    'the four evidence entries are exactly what a state publication creates');
});

test('the observer reads null exactly where the strict repository does, and both refuse corrupt state', (t) => {
  const { root, repository } = fixture(t);
  const observer = createModpackStateObserver({ repository, fsApi: fs });
  const stateRoot = folder => path.join(folder, STATE_DIRECTORY);
  const cases = [
    ['absent', () => {}, { value: null }, 'unmanaged'],
    ['runtime-only', folder => {
      fs.mkdirSync(stateRoot(folder));
      fs.writeFileSync(path.join(stateRoot(folder), 'runtime.json'), '{}\n');
    }, { value: null }, 'unmanaged'],
    ['empty-state-directory', folder => fs.mkdirSync(stateRoot(folder)), { value: null }, 'unmanaged'],
    ['present', folder => repository.writeCandidate(folder, managedState()),
      { value: { modpackManaged: true, installationId: 'install-0001' } }, 'lifecycle'],
    ['detached', folder => {
      repository.writeCandidate(folder, managedState());
      repository.detachCandidate(folder, { operationId: 'operation-detach', timestamp: '2026-08-01T12:30:00.000Z', contentRevision: 4 });
    }, { value: { modpackManaged: false, installationId: 'install-0001' } }, 'lifecycle'],
    ['corrupt', folder => {
      fs.mkdirSync(stateRoot(folder));
      fs.writeFileSync(path.join(stateRoot(folder), CURRENT_STATE), '{bad');
    }, { error: 'INVALID_REQUEST' }, 'lifecycle']
  ];

  for (const [name, arrange, expected, evidence] of cases) {
    const folder = serverFolder(root, name);
    arrange(folder);
    assert.deepEqual(outcome(() => repository.read(folder)), expected, `${name}: strict repository`);
    assert.deepEqual(outcome(() => observer.read(folder)), expected, `${name}: observer`);
    assert.equal(inspectFolderEvidence(folder, { kinds: ['server'] }).state, evidence, `${name}: ownership evidence`);
  }
});
