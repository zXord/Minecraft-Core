const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const harness = require('../e2e/fixtures/modpack-harness.cjs');
const { createModpackHandlers } = require('../../electron/ipc/modpack-handlers.cjs');

const fingerprint = 'a'.repeat(64);
const choices = { acceptEula: true, startAfterInstall: false, restorePointId: null };
const validators = () => import(`data:text/javascript;base64,${fs.readFileSync(path.resolve(__dirname,
  '../../src/utils/modpacks/launchResultValidation.js')).toString('base64')}`);

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-harness-contract-'));
  const prepared = harness.prepareProfile({ root, ...options });
  const priorEnv = Object.fromEntries(['NODE_ENV', 'MINECRAFT_CORE_TEST_MODE', 'MINECRAFT_CORE_E2E_SCENARIO_FILE']
    .map(key => [key, process.env[key]]));
  const priorControl = globalThis.__MINECRAFT_CORE_VERIFICATION__;
  t.after(() => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (priorControl === undefined) delete globalThis.__MINECRAFT_CORE_VERIFICATION__;
    else globalThis.__MINECRAFT_CORE_VERIFICATION__ = priorControl;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('minecraft-core-harness-contract-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.NODE_ENV = 'test';
  process.env.MINECRAFT_CORE_TEST_MODE = '1';
  process.env.MINECRAFT_CORE_E2E_SCENARIO_FILE = prepared.scenarioFile;
  const store = new Map();
  const composition = await harness.createModpackFactory()({
    store: { get: key => store.get(key), set: (key, value) => store.set(key, value) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [prepared.serverRoot] }) },
    getWindow: () => null
  });
  const service = composition.lifecycleService;
  const inspectRepair = async () => {
    const inspected = await service.inspectSource({ provider: 'local', selectionId: 'local-selection-1' });
    return { inspectionId: inspected.inspectionId, instanceId: harness.SERVER_ID, operationKind: 'repair', selections: {} };
  };
  return { ...prepared, composition, service, handlers: createModpackHandlers(composition), inspectRepair,
    readState: () => JSON.parse(fs.readFileSync(prepared.scenarioFile, 'utf8')) };
}

test('E2E uninstall emits the canonical public kind while preserving personal files', async t => {
  const f = await fixture(t);
  const plan = await f.service.createManagementPlan({ instanceId: harness.SERVER_ID, operationKind: 'uninstall' });
  const job = await f.service.startOperation({ ...plan, choices });
  assert.equal(job.operationKind, 'uninstall-managed');
  assert.equal((await validators()).isValidPublicJob(job, { serverId: harness.SERVER_ID,
    operationKind: 'uninstall-managed', planFingerprint: fingerprint }), true);
  assert.equal(fs.existsSync(path.join(f.serverRoot, 'mods', 'managed.jar')), false);
  assert.equal(fs.readFileSync(path.join(f.serverRoot, 'mods', 'user-added.jar'), 'utf8'), 'user-added\n');
  assert.equal(fs.readFileSync(path.join(f.serverRoot, 'world', 'level.dat'), 'utf8'), 'protected-world\n');
});

for (const [scenario, phase] of [
  ['retainedDownloadOnFirstJob', 'failed'], ['destinationRecoveryOnFirstJob', 'failed'], ['normalCompletion', 'completed']
]) test(`E2E ${scenario} hydrates a complete authoritative terminal launch DTO`, async t => {
  const f = await fixture(t, { profile: 'empty', ...(scenario === 'normalCompletion' ? {} : { [scenario]: true }) });
  await f.composition.destinationReservationService.reserveWithNativeDialog();
  const inspected = await f.service.inspectSource({ provider: 'modrinth', projectId: 'fixture-pack', versionId: 'version-upgrade' });
  const plan = await f.service.createPlan({ inspectionId: inspected.inspectionId, instanceId: harness.SERVER_ID,
    operationKind: 'install-new', selections: {} });
  const initial = await f.service.startOperation({ ...plan, choices });
  const terminal = await f.service.getJob(initial.jobId);
  assert.equal(terminal.phase, phase);
  assert.equal(terminal.terminalAt, harness.FIXED_TIME);
  assert.equal(terminal.progress.currentItem, null);
  assert.equal((await validators()).isValidLaunchJob(terminal, { jobId: initial.jobId, serverId: harness.SERVER_ID,
    operationKind: 'install-new', planFingerprint: fingerprint }), true);
  if (scenario === 'destinationRecoveryOnFirstJob') assert.equal(terminal.outcome.failureReason, 'destination-recovery');
  if (phase === 'failed') assert.equal(terminal.outcome.result.serverUnchanged, true);
});

test('E2E destination release follows the real lifecycle IPC route and permits a fresh reservation', async t => {
  const f = await fixture(t, { profile: 'empty' });
  const reserve = () => f.handlers['modpacks:reserve-server-destination'](null, {});
  assert.equal((await reserve()).ok, true);
  const released = await f.handlers['modpacks:release-server-destination'](null, { instanceId: harness.SERVER_ID });
  assert.deepEqual(released, { ok: true, value: true });
  assert.equal((await reserve()).ok, true);
  assert.equal(f.readState().lifecycleCalls.filter(call => call.method === 'releaseServerDestination' && call.released).length, 1);
});

test('E2E post-invocation stale rejection remains an error without fabricating a job', async t => {
  const f = await fixture(t, { refreshFixture: { rejectFirstRepairStart: true } });
  const plan = await f.service.createPlan(await f.inspectRepair());
  const response = await f.handlers['modpacks:start-operation'](null, { planId: plan.planId,
    planFingerprint: plan.planFingerprint, choices });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'PLAN_STALE');
  assert.equal(f.readState().lifecycleCalls.filter(call => call.method === 'startOperation').length, 0);
  assert.equal(f.readState().lifecycleCalls.filter(call => call.method === 'startOperationRejected').length, 1);
});

test('E2E stale repair preflight needs a fresh inspection before its only explicit Start', async t => {
  const f = await fixture(t, { refreshFixture: { rejectFirstRepairPreflight: true } });
  const request = await f.inspectRepair();
  await assert.rejects(f.service.createPlan(request), { code: 'PLAN_STALE' });
  assert.equal(f.readState().lifecycleCalls.filter(call => call.method === 'startOperation').length, 0);
  await assert.rejects(f.service.createPlan(request), { code: 'PLAN_STALE' });
  const fresh = await f.service.createPlan(await f.inspectRepair());
  const job = await f.service.startOperation({ ...fresh, choices });
  assert.equal(job.phase, 'completed');
  assert.equal(job.operationKind, 'repair');
  assert.equal(f.readState().lifecycleCalls.filter(call => call.method === 'startOperation').length, 1);
});

test('E2E held first launch completes only after explicit release through normal hydration', async t => {
  const f = await fixture(t, { profile: 'empty', holdFirstJobBeforeCommit: true });
  await f.composition.destinationReservationService.reserveWithNativeDialog();
  const inspected = await f.service.inspectSource({ provider: 'modrinth', projectId: 'fixture-pack', versionId: 'version-upgrade' });
  const plan = await f.service.createPlan({ inspectionId: inspected.inspectionId, instanceId: harness.SERVER_ID,
    operationKind: 'install-new', selections: {} });
  const initial = await f.service.startOperation({ ...plan, choices });
  for (let read = 0; read < 3; read++) {
    const held = await f.service.getJob(initial.jobId);
    assert.equal(held.phase, 'downloading');
    assert.equal(held.terminalAt, null);
    assert.equal(held.outcome, null);
  }
  assert.equal(f.readState().state.modpackManaged, false);
  fs.writeFileSync(f.scenarioFile, JSON.stringify({ ...f.readState(), releaseFirstJobBeforeCommit: true }));
  const terminal = await f.service.getJob(initial.jobId);
  assert.equal(terminal.phase, 'completed');
  assert.equal((await validators()).isValidLaunchJob(terminal, { jobId: initial.jobId, serverId: harness.SERVER_ID,
    operationKind: 'install-new', planFingerprint: fingerprint }), true);
  assert.equal(f.readState().state.modpackManaged, true);
  assert.equal(f.readState().releaseFirstJobBeforeCommit, false);
  assert.equal(f.readState().lifecycleCalls.filter(call => call.method === 'releaseHeldFirstJob').length, 1);
  await f.service.getJob(initial.jobId);
  assert.equal(f.readState().lifecycleCalls.filter(call => call.method === 'releaseHeldFirstJob').length, 1);
});
