const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createModpackServiceGraph } = require('../../electron/bootstrap/create-modpack-service-graph.cjs');
const { RecoveryRegistry } = require('../../electron/services/modpack-lifecycle/recovery-registry.cjs');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const {
  markCurrentServerMutationDirty,
  runWithServerMutationLease
} = require('../../electron/services/server-mutation-context.cjs');

const RENAME_CLIENT = Object.freeze({
  moveWriteThrough: fs.renameSync,
  replaceFileWriteThrough: fs.renameSync,
  flushDirectory() {},
  moveWriteThroughAsync: fs.promises.rename,
  replaceFileWriteThroughAsync: fs.promises.rename,
  async flushDirectoryAsync() {}
});

function legacyServer(serverPath, port) {
  fs.mkdirSync(serverPath, { recursive: true });
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), `${JSON.stringify({ version: '1.20.1', port, maxRam: 4 }, null, 2)}\n`);
  fs.writeFileSync(path.join(serverPath, 'server.properties'), `motd=hi\nserver-port=${port}\n`);
}

// What a crash during a modpack install leaves in a v26.6.1-shaped profile.
async function seedInterruptedJob(userDataPath, { jobId, serverId, serverPath }) {
  let token = 0;
  const registry = new RecoveryRegistry({
    userDataPath,
    fsApi: fs,
    durableFs: createDurableFs({ allowedRoots: [userDataPath], durableClient: RENAME_CLIENT, tempNameFactory: () => `seed-${++token}` }),
    clock: () => new Date('2026-10-30T00:00:00.000Z'),
    randomUUID: crypto.randomUUID
  });
  await registry.initialize();
  const parent = path.dirname(serverPath);
  const name = path.basename(serverPath);
  await registry.create({
    schemaVersion: 1, sequence: 0, jobId, operationKind: 'install',
    target: { kind: 'existing', stableServerId: serverId, path: serverPath },
    candidatePath: path.join(parent, `.${name}.candidate-${jobId}`),
    rollbackPath: path.join(parent, `.${name}.rollback-${jobId}`),
    failedPath: path.join(parent, `.${name}.failed-${jobId}`),
    restorePoint: { id: 'restore-0001', sha256: 'a'.repeat(64) },
    journalPath: path.join(serverPath, '.minecraft-core-state', 'operations', jobId, 'journal.json'),
    priorRuntime: { running: false, autoRestart: false },
    phase: 'queued', swapStep: 'none',
    directoryIdentities: { target: null, candidate: null, rollback: null, failed: null },
    createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', outcome: null
  });
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(child));
    else files.push(child);
  }
  return files;
}

function snapshot(directory) {
  return Object.fromEntries(listFiles(directory).map(file => [path.relative(directory, file), fs.readFileSync(file).toString('base64')]));
}

function recoveryRecords(userDataPath) {
  const root = path.join(userDataPath, 'modpack-lifecycle');
  return { active: snapshot(path.join(root, 'active')), history: snapshot(path.join(root, 'history')) };
}

// A v26.6.1-shaped profile with one interrupted modpack job, served by the real
// production recovery and composition from an install without ArchiveWorker.exe.
async function productionProfile(t, { damagedOperationStore = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-worker-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'user-data');
  const runtimeRoot = path.join(root, 'runtime-without-worker');
  fs.mkdirSync(userDataPath);
  fs.mkdirSync(runtimeRoot);
  const alpha = path.join(root, 'servers', 'alpha');
  const beta = path.join(root, 'servers', 'beta');
  legacyServer(alpha, 25565);
  legacyServer(beta, 25566);
  await seedInterruptedJob(userDataPath, { jobId: 'job-alpha', serverId: 'server-alpha', serverPath: alpha });
  if (damagedOperationStore) {
    // Stored modpack state the composition cannot read (A44: bad stored state).
    fs.mkdirSync(path.join(userDataPath, 'modpack-lifecycle', 'operations'), { recursive: true });
    fs.writeFileSync(path.join(userDataPath, 'modpack-lifecycle', 'operations', 'not-a-job.txt'), 'damaged\n');
  }
  const instances = [
    { id: 'server-alpha', type: 'server', name: 'Alpha', path: alpha },
    { id: 'server-beta', type: 'server', name: 'Beta', path: beta }
  ];
  const graph = createModpackServiceGraph({
    app: { isPackaged: false, getPath: () => userDataPath },
    store: { get: key => (key === 'instances' ? instances : null), set() {} },
    userDataPath,
    runtimeRoots: { resourcesPath: runtimeRoot, runtimeRoot, isPackaged: false, arch: 'x64' },
    windowFactory: () => ({ id: 1 }),
    isInstanceRunning: () => false,
    dialog: { showOpenDialog() { throw new Error('no dialog in this test'); } },
    shell: { openPath() {}, openExternal() {} },
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpsRequest: () => { throw new Error('no network in this test'); }
  });
  t.after(() => graph.startup.dispose(graph).catch(() => {}));
  assert.equal(fs.existsSync(graph.paths.archiveWorker), false);
  return { alpha, beta, graph, recordsBefore: recoveryRecords(userDataPath), userDataPath };
}

async function assertLegacyServersKeepWorking({ alpha, beta, graph, recordsBefore, userDataPath }) {
  const { coordinator } = graph;
  assert.equal(coordinator.recoveryOpen, false);
  assert.equal(coordinator.globalRecoveryBlock, false);
  await assert.rejects(coordinator.acquireStart({ instanceId: 'server-alpha', serverPath: alpha },
    { operation: 'server-start', operationId: 'server-start-alpha' }), { code: 'RECOVERY_REQUIRED' });

  // A legacy server starts and records its content revision with the v26.6.1
  // writer, then can start again: nothing needed ArchiveWorker.exe.
  const lease = await coordinator.acquireStart({ instanceId: 'server-beta', serverPath: beta },
    { operation: 'server-start', operationId: 'server-start-beta' });
  runWithServerMutationLease(lease, () => markCurrentServerMutationDirty(beta));
  assert.equal(lease.markRunning({ pid: 4242 }), lease);
  assert.equal(JSON.parse(fs.readFileSync(path.join(beta, '.minecraft-core.json'), 'utf8')).contentRevision, 1);
  assert.equal(lease.release(), true);
  const again = await coordinator.acquireStart({ instanceId: 'server-beta', serverPath: beta },
    { operation: 'server-start', operationId: 'server-start-beta-2' });
  assert.equal(again.release(), true);

  for (const serverPath of [alpha, beta]) {
    assert.deepEqual(fs.readdirSync(serverPath).filter(name => name.includes('minecraft-core-tmp') || name.startsWith('..')), [],
      `${path.basename(serverPath)} keeps no temporary config file`);
  }
  assert.deepEqual(recoveryRecords(userDataPath), recordsBefore, 'the interrupted job record is left exactly as it was');
}

test('without ArchiveWorker.exe the production start keeps the interrupted server blocked, starts the others and reports the worker', {
  skip: process.platform !== 'win32' && 'the production durable filesystem is Windows only'
}, async t => {
  const profile = await productionProfile(t);
  await profile.graph.startup.initializeRecovery(profile.graph);

  const health = profile.graph.startup.getHealth();
  assert.equal(health.status, 'ready');
  assert.equal(health.modpackServices, 'ready');
  assert.deepEqual(health.recoveryGate, {
    basis: 'boundary', globalBlock: false, blockedServers: [{ operationId: 'job-alpha', instanceId: 'server-alpha' }]
  });
  assert.deepEqual(health.issues.map(issue => [issue.stage, issue.reason]), [['archive-worker', 'archive-worker-missing']],
    'the banner can warn about the missing worker without degrading');
  await assertLegacyServersKeepWorking(profile);
});

test('without ArchiveWorker.exe a profile whose modpack services cannot start degrades and keeps the same server safety', {
  skip: process.platform !== 'win32' && 'the production durable filesystem is Windows only'
}, async t => {
  const profile = await productionProfile(t, { damagedOperationStore: true });
  let failure = null;
  await assert.rejects(profile.graph.startup.initializeRecovery(profile.graph), error => { failure = error; return true; });
  assert.equal(typeof profile.graph.startup.enterDegradedMode, 'function', 'the graph can run degraded');
  assert.deepEqual(await profile.graph.startup.enterDegradedMode(failure, profile.graph), { mode: 'degraded' });

  const health = profile.graph.startup.getHealth();
  assert.equal(health.status, 'degraded');
  assert.equal(health.modpackServices, 'unavailable');
  assert.equal(health.legacyFallbacks, 'active');
  assert.equal(health.failure.stage, 'recovery');
  assert.deepEqual(health.recoveryGate, {
    basis: 'boundary', globalBlock: false, blockedServers: [{ operationId: 'job-alpha', instanceId: 'server-alpha' }]
  });
  assert.equal(profile.graph.modpacks.lifecycleService, null);
  assert.equal(profile.graph.modpacks.stateRepository.read(profile.beta), null);
  await assertLegacyServersKeepWorking(profile);
});
