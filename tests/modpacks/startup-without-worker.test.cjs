const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createModpackServiceGraph,
  createProductionDurableFsFactory
} = require('../../electron/bootstrap/create-modpack-service-graph.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { WindowsDurableFsClient } = require('../../electron/utils/windows-durable-fs-client.cjs');

function profileFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-startup-without-worker-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const installRoot = path.join(base, 'install');
  fs.mkdirSync(installRoot);
  return {
    base,
    runtimeRoots: { resourcesPath: installRoot, runtimeRoot: installRoot, isPackaged: false, arch: 'x64' },
    userDataPath(name) {
      const userDataPath = path.join(base, name);
      fs.mkdirSync(userDataPath);
      return userDataPath;
    }
  };
}

// Production durable factories over the real native client. The install has no
// ArchiveWorker.exe, so every native call fails its worker verification with
// EXTRACTOR_UNAVAILABLE before anything could launch. nativeCalls counts them.
function missingWorkerFactories({ userDataPath, runtimeRoots }) {
  const nativeCalls = [];
  const durableClientFactory = options => new WindowsDurableFsClient({
    ...options,
    verifyWorker(paths) {
      nativeCalls.push(paths.workerPath);
      throw new ModpackError('EXTRACTOR_UNAVAILABLE', 'The archive extractor is unavailable');
    },
    spawnSync() { throw new Error('an unverified worker must never be launched'); },
    spawn() { throw new Error('an unverified worker must never be launched'); }
  });
  const factory = requireConfirmedClose => createProductionDurableFsFactory({
    fsSync: fs, fsPromises: fs.promises, randomUUID: crypto.randomUUID, runtimeRoots, userDataPath,
    requireConfirmedClose, durableClientFactory
  });
  return {
    nativeCalls,
    deps: { durableFsFactory: factory(false), recoveryDurableFsFactory: factory(true), clientDurableFsFactory: factory(true) }
  };
}

// A working helper for the first, healthy run of an existing profile.
function workingFactories() {
  const durableClient = {
    moveWriteThrough: fs.renameSync,
    replaceFileWriteThrough: fs.renameSync,
    flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename,
    replaceFileWriteThroughAsync: fs.promises.rename,
    async flushDirectoryAsync() {}
  };
  const factory = roots => createDurableFs({ fsApi: fs, asyncFsApi: fs.promises, durableClient, allowedRoots: roots });
  return { durableFsFactory: factory, recoveryDurableFsFactory: factory, clientDurableFsFactory: factory };
}

function startupGraph({ userDataPath, runtimeRoots, durable }) {
  const values = new Map([['instances', []]]);
  const inertReparseInspector = { async isReparsePoint() { return false; } };
  return createModpackServiceGraph({
    app: { isPackaged: false, getPath: () => userDataPath },
    store: { get: key => values.get(key), set: (key, value) => values.set(key, value) },
    userDataPath,
    runtimeRoots,
    clock: { now: () => Date.parse('2026-10-30T12:00:00.000Z') },
    dnsLookup: async () => { throw new Error('startup must not resolve hosts'); },
    httpsRequest() { throw new Error('startup must not reach the network'); },
    randomUUID: crypto.randomUUID,
    windowFactory: () => ({}),
    workerFactory: () => ({ async run() { throw new Error('startup must not run archive work'); } }),
    processFactory() { throw new Error('startup must not start processes'); },
    dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
    shell: { async openPath() { return ''; } },
    reparseInspector: inertReparseInspector,
    recoveryReparseInspector: inertReparseInspector,
    startup: { automaticReleaseChecksEnabled: false },
    ...durable
  });
}

async function startWithMissingWorker(t, { userDataPath, runtimeRoots }) {
  const { deps, nativeCalls } = missingWorkerFactories({ userDataPath, runtimeRoots });
  const graph = startupGraph({ userDataPath, runtimeRoots, durable: deps });
  t.after(() => graph.startup.dispose(graph));
  const result = await graph.startup.initializeRecovery(graph);
  return { graph, nativeCalls, result };
}

test('a fresh profile starts when ArchiveWorker.exe is missing', async t => {
  const profile = profileFixture(t);
  const userDataPath = profile.userDataPath('fresh-profile');

  const { graph, nativeCalls, result } = await startWithMissingWorker(t, { userDataPath, runtimeRoots: profile.runtimeRoots });

  assert.equal(result.globalBlock, false);
  assert.deepEqual(result.unresolved, []);
  assert.ok(nativeCalls.length > 0, 'creating the profile directories needed the helper, and its absence was deferred');
  assert.ok(graph.modpacks.lifecycleService, 'the modpack services finished composing');
  for (const directory of ['active', 'history', 'operations']) {
    assert.equal(fs.statSync(path.join(userDataPath, 'modpack-lifecycle', directory)).isDirectory(), true, directory);
  }
});

test('an existing healthy profile starts without any native helper call when ArchiveWorker.exe is missing', async t => {
  const profile = profileFixture(t);
  const userDataPath = profile.userDataPath('existing-profile');
  const healthy = startupGraph({ userDataPath, runtimeRoots: profile.runtimeRoots, durable: workingFactories() });
  assert.equal((await healthy.startup.initializeRecovery(healthy)).globalBlock, false);
  await healthy.startup.dispose(healthy);

  const { graph, nativeCalls, result } = await startWithMissingWorker(t, { userDataPath, runtimeRoots: profile.runtimeRoots });

  assert.equal(result.globalBlock, false);
  assert.deepEqual(result.unresolved, []);
  assert.ok(graph.modpacks.lifecycleService, 'the modpack services finished composing');
  assert.deepEqual(nativeCalls, [], 'opening an existing profile must not need ArchiveWorker.exe');
});
