const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const { inspectFolderEvidence } = require('../electron/services/modpacks/instance-ownership.cjs');
const { ModpackStateRepository } = require('../electron/services/modpacks/state/modpack-state-repository.cjs');

// The legacy instance-config writer compare-and-sets without the native
// destination identity check. That is safe only because no lifecycle or
// recovery code writes .minecraft-core.json in place in a live folder that has
// no lifecycle evidence: summaries are written into folders that already carry
// the evidence layout (candidates), and publication swaps whole folders.
const SUMMARY = '.minecraft-core.json';
const TIMESTAMP = '2026-08-01T12:00:00.000Z';

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

function runtime() {
  return {
    minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.14',
    javaMajor: 21, os: 'win32', architecture: 'x64'
  };
}

function localSource() {
  return {
    provider: 'local',
    version: '1.0.0',
    title: 'Local Pack',
    importId: 'local-import-0001',
    artifactSha256: 'a'.repeat(64)
  };
}

function managedState(contentRevision, installationId) {
  return {
    schemaVersion: 1,
    modpackManaged: true,
    source: localSource(),
    runtime: runtime(),
    selectedOptionalFiles: [],
    installedAt: '2026-08-01T11:00:00.000Z',
    contentRevision,
    manifest: {
      schemaVersion: 1,
      installationId,
      entries: [
        { path: 'mods/a.jar', pathKey: 'mods/a.jar', origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod', installedHash: '1'.repeat(64), size: '4', priorBaseline: null },
        { path: 'server.properties', pathKey: 'server.properties', origin: 'user', managementPolicy: 'protected', role: 'configuration', installedHash: '2'.repeat(64), size: '8', priorBaseline: null }
      ]
    }
  };
}

function history(operationId, sequence) {
  return {
    schemaVersion: 1,
    operationId,
    sequence,
    kind: 'install',
    outcome: 'completed',
    timestamp: TIMESTAMP,
    sourceRevision: sequence - 1,
    targetRevision: sequence
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-legacy-invariant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A live server exactly as v26.6.1 leaves it: a config and a world, no evidence.
  const live = path.join(root, 'live');
  fs.mkdirSync(path.join(live, 'world'), { recursive: true });
  fs.writeFileSync(path.join(live, 'world', 'level.dat'), 'world');
  fs.writeFileSync(path.join(live, SUMMARY), JSON.stringify({ port: 25565, maxRam: 4, version: '1.21.1' }, null, 2));
  const oldTime = new Date('2026-01-02T03:04:05.000Z');
  fs.utimesSync(path.join(live, SUMMARY), oldTime, oldTime);

  let token = 0;
  const durable = createDurableFs({
    fsApi: fs,
    durableClient: nativeClient(),
    allowedRoots: [root],
    tempNameFactory: () => `invariant-${++token}`
  });
  const summaryWrites = [];
  const observe = filePath => {
    if (path.basename(filePath) !== SUMMARY) return;
    const folder = path.dirname(filePath);
    summaryWrites.push({ folder, evidence: inspectFolderEvidence(folder, { kinds: ['server'] }).state });
  };
  const observed = { ...durable };
  for (const method of ['writeJsonAtomic', 'writeFileAtomic', 'writeJsonAtomicAsync', 'writeFileAtomicAsync']) {
    observed[method] = (filePath, ...rest) => {
      observe(filePath);
      return durable[method](filePath, ...rest);
    };
  }
  for (const method of ['renameDurable', 'renameDurableAsync']) {
    observed[method] = (source, destination, ...rest) => {
      observe(destination);
      return durable[method](source, destination, ...rest);
    };
  }
  const repository = new ModpackStateRepository({ fsApi: fs, durableFs: observed, clock: () => new Date(TIMESTAMP) });
  const liveConfig = path.join(live, SUMMARY);
  return {
    live,
    repository,
    summaryWrites,
    liveBytes: fs.readFileSync(liveConfig),
    liveMtimeMs: fs.statSync(liveConfig).mtimeMs,
    candidateOf(name) {
      const candidate = path.join(root, name);
      fs.cpSync(live, candidate, { recursive: true });
      assert.equal(inspectFolderEvidence(candidate).state, 'unmanaged');
      return candidate;
    },
    assertLiveConfigUntouched() {
      assert.deepEqual(fs.readFileSync(liveConfig), this.liveBytes);
      assert.equal(fs.statSync(liveConfig).mtimeMs, this.liveMtimeMs);
      assert.deepEqual(summaryWrites.filter(write => write.folder === live), []);
    }
  };
}

test('candidate helpers write a summary only into folders that already carry lifecycle evidence', async (t) => {
  const environment = fixture(t);
  const { repository, summaryWrites } = environment;

  const installed = environment.candidateOf('candidate-install');
  repository.writeCandidate(installed, managedState(1, 'install-0001'));
  repository.detachCandidate(installed, { operationId: 'detach-0001', timestamp: TIMESTAMP, contentRevision: 2 });

  const upgraded = environment.candidateOf('candidate-upgrade');
  await repository.writeCandidateAsync(upgraded, managedState(1, 'install-0002'));
  repository.uninstallCandidate(upgraded, {
    operationId: 'uninstall-0001',
    timestamp: TIMESTAMP,
    contentRevision: 2,
    confirmation: {
      unchangedManagedRemovalCount: '0',
      preservedCategories: [],
      possibleNonRunnable: false,
      instanceRetained: true,
      worldsRetained: true
    }
  });

  const filesOnly = environment.candidateOf('candidate-files-only');
  repository.recordFilesOnlyCandidate(filesOnly, {
    operationId: 'import-0001',
    timestamp: TIMESTAMP,
    contentRevision: 1,
    source: localSource(),
    provenance: { classification: 'files-only', inspectionFingerprint: 'b'.repeat(64) }
  });

  assert.ok(summaryWrites.length >= 5, `expected every helper to publish a summary, saw ${summaryWrites.length}`);
  assert.deepEqual(summaryWrites.filter(write => write.evidence !== 'lifecycle'), []);
  environment.assertLiveConfigUntouched();
});

test('the post-publication history helpers never write the live config', async (t) => {
  const environment = fixture(t);
  const { live, repository, summaryWrites } = environment;
  assert.equal(inspectFolderEvidence(live).state, 'unmanaged');

  repository.appendHistory(live, history('history-0001', 1));
  await repository.appendHistoryAsync(live, history('history-0002', 2));

  assert.deepEqual(summaryWrites, []);
  environment.assertLiveConfigUntouched();
});
