'use strict';

// Every lifecycle review of a modpack-managed server whose Minecraft server is
// running, through the production planning adapter and live snapshot: the
// server holds its world lock, logs the reply to Minecraft Core's periodic
// "list" command and autosaves its world while the review reads the folder.
// The review succeeds with the same decisions for every pack-managed file as a
// review of the stopped server; the commit stops the server and checks again.
// A review that Start could only refuse after that stop, because Start holds a
// recorded world file exact and the stop saves the world, is refused up front.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LIST_LINE, levelAutosave, runningServerFs } = require('./running-server-fs-fixture.cjs');
const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../../electron/services/modpacks/contracts.cjs');
const { ProductionPlanningAdapter } = require('../../electron/services/modpacks/planning/production-planning-adapter.cjs');
const { createProductionServerSnapshot } = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');

const INSTANCE_ID = 'server-running';
const RUNTIME = Object.freeze({
  minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
  javaMajor: 21, os: 'win32', architecture: 'x64'
});
const SOURCE = Object.freeze({
  provider: 'modrinth', projectId: 'project-one', versionId: 'version-one', version: '1.0.0', title: 'Project One'
});
const SHA = 'a'.repeat(64);
const SHA512 = 'b'.repeat(128);
const RESTORE_SHA = 'c'.repeat(64);
const NO_REPARSE = Object.freeze({ async isReparsePoint() { return false; } });
const PACK_FILES = Object.freeze({
  'config/alpha.json': '{"alpha":true}\n',
  'config/beta.json': '{"beta":true}\n',
  'mods/alpha.jar': 'alpha mod bytes',
  'mods/beta.jar': 'beta mod bytes'
});
const RUNTIME_FILES = Object.freeze({
  'fabric-server-launch.jar': 'fabric launcher bytes',
  'libraries/net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar': 'fabric loader bytes'
});
// The world the running server holds: its lock and its level.dat.
const WORLD_FILES = Object.freeze({
  'world/level.dat': 'level at install',
  'world/session.lock': '☃'
});
const FIRST_BOOT_FILES = Object.freeze({
  'logs/latest.log': '[12:00:09] [Server thread/INFO]: Done (8.917s)! For help, type "help"\n',
  'server.properties': '#Minecraft server properties\nmotd=Pack\n',
  'usercache.json': '[]',
  'world/level.dat_old': 'level before',
  'world/region/r.0.0.mca': 'region bytes'
});

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function writeFiles(root, files) {
  for (const [relative, bytes] of Object.entries(files)) {
    const filePath = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
  }
}

function manifestEntry(pathKey, bytes, origin, role) {
  return {
    path: pathKey, pathKey, origin, managementPolicy: origin === 'user' ? 'protected' : 'replaceable-managed',
    role, installedHash: sha256(bytes), size: String(Buffer.byteLength(bytes)), priorBaseline: null
  };
}

// What the manifest records of the world: 'user' once an earlier update or
// adoption recorded it, its lock included, as the user's files; 'none' on a
// fresh install; 'pack' when the pack shipped (seeded) the world's level.dat.
function managedServer(t, { world = 'user' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-running-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const serverPath = path.join(root, 'Running Server');
  writeFiles(serverPath, { ...PACK_FILES, ...RUNTIME_FILES, ...WORLD_FILES, ...FIRST_BOOT_FILES });
  const worldEntries = world === 'user'
    ? Object.entries(WORLD_FILES).map(([key, bytes]) => manifestEntry(key, bytes, 'user', 'world'))
    : world === 'pack'
      ? [{ ...manifestEntry('world/level.dat', WORLD_FILES['world/level.dat'], 'pack', 'world'), managementPolicy: 'preserve-after-seed' }]
      : [];
  const entries = [
    ...Object.entries(PACK_FILES).map(([key, bytes]) => manifestEntry(key, bytes, 'pack', key.startsWith('mods/') ? 'mod' : 'configuration')),
    ...Object.entries(RUNTIME_FILES).map(([key, bytes]) => manifestEntry(key, bytes, 'runtime', key.startsWith('libraries/') ? 'library' : 'runtime')),
    ...worldEntries
  ].sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  const currentState = {
    state: {
      schemaVersion: 1, modpackManaged: true, source: { ...SOURCE }, runtime: RUNTIME,
      selectedOptionalFiles: [], installedAt: '2026-10-31T05:00:00.000Z', contentRevision: 3
    },
    manifest: { schemaVersion: 1, installationId: 'installed-one', entries }
  };
  // `prepared` lists each source candidate a review prepared (downloaded and extracted).
  return { serverPath, currentState, prepared: [], at: relative => path.join(serverPath, ...relative.split('/')) };
}

// The running server's activity while the review walks the folder.
function serverActivity(server) {
  const save = levelAutosave(server.at('world'));
  return runningServerFs({
    locked: [server.at('world/session.lock')],
    after: {
      [`lstat ${server.at('logs/latest.log')}`]: () => fsp.appendFile(server.at('logs/latest.log'), LIST_LINE),
      [`lstat ${server.at('world/level.dat')}`]: () => { save.begin(); save.finish(); }
    }
  });
}

function verifiedSet() {
  const plan = createArtifactSetPlan({
    provider: 'modrinth',
    project: { id: 'project-one', slug: 'project-one', title: 'Project One' },
    release: { id: 'version-one', version: '1.0.0', channel: 'release', publishedAt: '2026-08-01T00:00:00.000Z' },
    artifactSet: {
      kind: 'single', primaryPartId: 'part-one', groupingScheme: 'single',
      providerImmutable: true, attestationStatus: 'verified',
      parts: [{ partId: 'part-one', fileName: 'pack.mrpack', size: '1', providerDigest: { algorithm: 'sha512', value: SHA512 } }]
    }
  });
  return finalizeVerifiedArtifactSet(plan, [{ partId: 'part-one', measuredSize: '1', sha256: SHA, sha512: SHA512 }]);
}

function inspection() {
  return {
    inspectionId: 'inspection-one',
    verifiedArtifactSet: verifiedSet(),
    result: {
      type: 'archive-inspection', archiveFamily: 'mrpack', integrity: 'tested', selectedRoot: null,
      artifactSet: { completeness: 'verified-complete-set', fingerprint: SHA },
      classification: {
        kind: 'mrpack-server', confidence: 'exact', blocked: false,
        runtime: { minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10' }
      },
      limitEvidence: { totals: { entryCount: 1, expandedBytes: '1' } }
    }
  };
}

function sourceRequest(operationKind) {
  return {
    inspectionId: 'inspection-one', instanceId: INSTANCE_ID, operationKind,
    selections: {
      optionalFileIds: [], conflictChoices: { paths: {}, categories: {} },
      acknowledgeMissingProviderDigest: false, acknowledgeDowngradeWorldRisk: operationKind === 'downgrade',
      selectedRoot: null, runtimeChoice: null
    }
  };
}

// The prepared candidate: a repair's desired manifest names every installed
// entry, the user's included, as ProductionCandidatePreparer builds it; every
// other source review ships the pack with one mod changed, plus any
// `addedFiles` the new release brings.
function preparedCandidate(server, operationKind, addedFiles = {}) {
  const installed = server.currentState.manifest.entries;
  const entries = operationKind === 'repair'
    ? installed
    : [
        ...installed.filter(entry => entry.origin === 'pack').map(entry => entry.pathKey === 'mods/alpha.jar'
          ? { ...entry, installedHash: sha256('alpha mod update'), size: String('alpha mod update'.length) }
          : entry),
        ...Object.entries(addedFiles).map(([key, bytes]) => manifestEntry(key, bytes, 'pack', 'configuration'))
      ].sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  return {
    runtime: RUNTIME,
    incomingManifest: { schemaVersion: 1, installationId: `installation-${operationKind}`, entries },
    candidateBytes: '1',
    execution: { templateOutputId: `output-${operationKind}` }
  };
}

function adapterFor(server, fsPromises, operationKind, addedFiles, running) {
  const stateRepository = {
    read() { return server.currentState; },
    listHistory() {
      return {
        items: [{
          restorePointId: 'restore-one', restorePointSha256: RESTORE_SHA, restorePointTotalBytes: '4096',
          sourceRevision: 2, sourceRuntime: RUNTIME
        }],
        nextCursor: null
      };
    }
  };
  let sessions = 0;
  return new ProductionPlanningAdapter({
    instanceResolver: {
      async resolveInstance(instanceId) { return { instanceId, serverPath: server.serverPath, priorRunning: running }; }
    },
    stateRepository,
    readContentRevision: () => server.currentState.state.contentRevision,
    reparseInspector: NO_REPARSE,
    preparePlanInputs: async () => {
      server.prepared.push(operationKind);
      return preparedCandidate(server, operationKind, addedFiles);
    },
    snapshotServer: createProductionServerSnapshot({ fsApi: fs, fsPromises, reparseInspector: NO_REPARSE, stateRepository }),
    fsApi: fs,
    availableBytes: async () => '100000000000',
    validateServerPorts: async () => ({ valid: true, errors: [] }),
    workspaceRegistry: {
      createPlanningSession() { sessions += 1; return `planning-${sessions}`; },
      createStagingOutput() { return `output-${sessions}`; },
      releaseOwner() { return 1; }
    },
    resolveRestorePoint: async () => ({
      id: 'restore-one', sha256: RESTORE_SHA, serverPath: server.serverPath, totalBytes: '4096', size: 2048,
      scopeSha256: 'd'.repeat(64), sourceRevision: 2, sourceRuntime: RUNTIME
    }),
    listAvailableRestorePoints: async () => []
  });
}

// A review reads the folder through `fsPromises`; the server runs while it does.
async function review(server, operationKind, fsPromises = fsp, { addedFiles = {}, running = fsPromises !== fsp } = {}) {
  const adapter = adapterFor(server, fsPromises, operationKind, addedFiles, running);
  if (['uninstall', 'detach', 'rollback-restore-point'].includes(operationKind)) {
    return adapter.createManagementPlan({
      request: {
        instanceId: INSTANCE_ID, operationKind,
        selectionRef: operationKind === 'rollback-restore-point' ? 'restore-one' : null
      },
      currentState: server.currentState,
      instance: { instanceId: INSTANCE_ID, serverPath: server.serverPath, priorRunning: running }
    });
  }
  return adapter.createPlan({ request: sourceRequest(operationKind), inspection: inspection(), source: { ...SOURCE } });
}

function preconditionsOf(plan) {
  return plan.preconditions.pathPreconditions || plan.preconditions.paths;
}

function packDecisions(plan) {
  const managed = new Set(Object.keys({ ...PACK_FILES, ...RUNTIME_FILES }));
  return plan.ownership.actions.filter(action => managed.has(action.pathKey))
    .map(action => [action.pathKey, action.action]);
}

function packPreconditions(plan) {
  const managed = new Set(Object.keys({ ...PACK_FILES, ...RUNTIME_FILES }));
  return preconditionsOf(plan).filter(condition => managed.has(condition.pathKey));
}

// The refusal a review gives when the running server's files keep it from
// matching what Start will find once it has stopped the server.
function filesInUse(error) {
  assert.equal(error?.code, 'PLAN_STALE');
  assert.deepEqual(error.toPublicResult().error, {
    code: 'PLAN_STALE',
    message: error.message,
    details: { reasonCode: 'server-files-in-use' },
    retryable: true
  });
  assert.match(error.message, /[Ss]top (?:it|the server), then review again\. Nothing was changed on the server\.$/u);
  return true;
}

for (const [operationKind, world] of [
  ...['uninstall', 'detach', 'rollback-restore-point', 'update', 'downgrade', 'switch', 'install-existing'].map(kind => [kind, 'user']),
  // A repair binds every recorded file, so its review can match only where no
  // lifecycle recorded the world.
  ['repair', 'none']
]) {
  test(`${operationKind} review of a running server matches the stopped review for every pack file`, async t => {
    const stopped = await review(managedServer(t, { world }), operationKind);
    const server = managedServer(t, { world });
    const running = await review(server, operationKind, serverActivity(server));

    assert.deepEqual(packDecisions(running.plan), packDecisions(stopped.plan));
    assert.deepEqual(
      packPreconditions(running.plan).map(({ path: itemPath, sha256: digest, size }) => [itemPath, digest, size]),
      packPreconditions(stopped.plan).map(({ path: itemPath, sha256: digest, size }) => [itemPath, digest, size])
    );
    const reviewedKeys = preconditionsOf(running.plan).map(condition => condition.pathKey);
    // The world lock the server holds and the level.dat it saved during the
    // review are left for the commit to read once the server has stopped.
    assert.equal(reviewedKeys.includes('world/session.lock'), false);
    assert.equal(reviewedKeys.includes('world/level.dat'), false);
    assert.equal(reviewedKeys.includes('world/region/r.0.0.mca'), true);
    if (operationKind === 'uninstall') {
      assert.deepEqual(running.sanitizedView.confirmation, stopped.sanitizedView.confirmation);
      assert.equal(running.sanitizedView.confirmation.unchangedManagedRemovalCount, String(Object.keys({ ...PACK_FILES, ...RUNTIME_FILES }).length));
    }
  });
}

test('update review of a running server keeps a file the new release adds exact while a mod rewrites it', async t => {
  // A mod created config/gamma.json at runtime; the update ships its own copy,
  // so the review must see the live file to decide the collision.
  const addedFiles = { 'config/gamma.json': '{"gamma":true}\n' };
  const stopped = managedServer(t);
  writeFiles(stopped.serverPath, { 'config/gamma.json': '{"gamma":"runtime"}\n' });
  const quiet = await review(stopped, 'update', fsp, { addedFiles });
  assert.equal(quiet.requiresConflictReview, true);
  assert.deepEqual(quiet.conflicts.map(conflict => [conflict.label, conflict.reason]), [['config/gamma.json', 'user-path-collision']]);

  const server = managedServer(t);
  writeFiles(server.serverPath, { 'config/gamma.json': '{"gamma":"runtime"}\n' });
  const fsPromises = runningServerFs({
    locked: [server.at('world/session.lock')],
    after: { [`lstat ${server.at('mods')}`]: () => fsp.writeFile(server.at('config/gamma.json'), '{"gamma":"saved again"}\n') }
  });
  await assert.rejects(review(server, 'update', fsPromises, { addedFiles }), error => {
    assert.equal(error?.code, 'PLAN_STALE');
    assert.deepEqual(error.toPublicResult().error.details, { reasonCode: 'server-files-in-use' });
    return true;
  });
});

for (const operationKind of ['uninstall', 'update']) {
  test(`${operationKind} review of a running server still refuses a pack config the server rewrites while it is read`, async t => {
    const server = managedServer(t);
    const fsPromises = runningServerFs({
      locked: [server.at('world/session.lock')],
      after: { [`lstat ${server.at('mods')}`]: () => fsp.writeFile(server.at('config/alpha.json'), '{"alpha":false}\n') }
    });

    await assert.rejects(review(server, operationKind, fsPromises), filesInUse);
  });
}

test('repair review of a running server is refused up front once a lifecycle recorded the world', async t => {
  // A repair binds every recorded file, the user's world included, and the
  // server saves its world as Start stops it: Start could only stop the server
  // and then refuse. The same review of the stopped server succeeds.
  assert.ok((await review(managedServer(t), 'repair')).plan);
  const busy = managedServer(t);
  await assert.rejects(review(busy, 'repair', serverActivity(busy)), filesInUse);
  // Also when no world file happens to be busy while the review reads them.
  const quiet = managedServer(t);
  await assert.rejects(review(quiet, 'repair', runningServerFs()), filesInUse);
  // Both before the repair downloads or extracts its source.
  assert.deepEqual([...busy.prepared, ...quiet.prepared], []);
});

for (const operationKind of ['uninstall', 'update', 'downgrade', 'switch', 'repair', 'install-existing']) {
  test(`${operationKind} review of a running server whose pack seeded its world is refused up front`, async t => {
    // Start holds a world file the pack shipped exact, and the server saves it
    // as Start stops it, so the review refuses instead of Start after the stop.
    assert.ok((await review(managedServer(t, { world: 'pack' }), operationKind)).plan);
    const server = managedServer(t, { world: 'pack' });
    await assert.rejects(review(server, operationKind, runningServerFs({ locked: [server.at('world/session.lock')] })), filesInUse);
  });
}

for (const operationKind of ['detach', 'rollback-restore-point']) {
  test(`${operationKind} review of a running server whose pack seeded its world is not refused for it`, async t => {
    // Start keeps the whole folder as it finds it after the stop, or first saves
    // it in a verified restore point, so no recorded file must stay exact.
    const server = managedServer(t, { world: 'pack' });
    const running = await review(server, operationKind, runningServerFs({ locked: [server.at('world/session.lock')] }));
    assert.equal(preconditionsOf(running.plan).some(condition => condition.pathKey === 'world/session.lock'), false);
  });
}
