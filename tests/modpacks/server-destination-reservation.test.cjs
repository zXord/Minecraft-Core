const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ServerDestinationReservationService,
  createCompositeInstanceResolver
} = require('../../electron/services/modpacks/planning/server-destination-reservation-service.cjs');
const { createModpackHandlers } = require('../../electron/ipc/modpack-handlers.cjs');
const {
  assertExistingUnmanagedTarget,
  captureExistingUnmanagedTarget,
  captureReservedTarget
} = require('../../electron/services/modpack-lifecycle/reserved-target-authority.cjs');

const reparseInspector = Object.freeze({ async isReparsePoint() { return false; } });

function handlerDependencies(destinationReservationService) {
  const noop = async request => request || {};
  return {
    providers: {
      modrinth: { searchProjects: noop, getProject: noop, listVersions: noop },
      github: { listReleases: noop, loadUploadedAssets: noop }
    },
    localArtifactSource: { selectWithNativeDialog: noop },
    destinationReservationService,
    lifecycleService: {
      releaseServerDestination: instanceId => destinationReservationService.withDestinationGate(
        destinationReservationService.peek(instanceId)?.targetPath || 'C:\\Absent',
        () => destinationReservationService.releaseUnlaunched(instanceId)),
      inspectSource: noop, cancelInspection: noop, createPlan: noop, createManagementPlan: noop, startOperation: noop,
      cancelJob: noop, getJob: noop, getActiveJobs: noop, getState: noop, listHistory: noop, listRollbackOptions: noop, verify: noop
    },
    recoveryService: { listRecovery: noop, recover: noop },
    notificationStore: { list: noop, acknowledge: noop },
    releaseMonitor: { checkAll: noop, checkOne: noop },
    releaseTrackingStore: { upsert: noop, list: async () => [] },
    outcomeActionService: { performSafeAction: noop }
  };
}

test('native destination reservation returns no path and creates no ghost store instance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Private Pack Server');
  fs.mkdirSync(targetPath);
  const instances = [];
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; } },
    reparseInspector,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    isInstanceIdAvailable: id => !instances.some(instance => instance.id === id)
  });
  const handlers = createModpackHandlers(handlerDependencies(service));

  const result = await handlers['modpacks:reserve-server-destination']({}, {});
  assert.deepEqual(result, {
    ok: true,
    value: { instanceId: 'server-00000000-0000-4000-8000-000000000001', displayName: 'Private Pack Server' }
  });
  assert.equal(JSON.stringify(result).includes(targetPath), false);
  assert.deepEqual(instances, []);

  const privateRecord = service.resolve(result.value.instanceId);
  assert.equal(privateRecord.targetPath, targetPath);
  assert.equal(privateRecord.reservation.kind, 'empty-directory');
});

test('cancelled selection returns null and composite resolution keeps paths main-owned', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] }; } },
    reparseInspector,
    randomUUID: () => '00000000-0000-4000-8000-000000000002'
  });
  assert.equal(await service.reserveWithNativeDialog({}), null);

  const targetPath = path.join(root, 'Reserved');
  fs.mkdirSync(targetPath);
  service.dialog = { async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; } };
  const reserved = await service.reserveWithNativeDialog({});
  const composite = createCompositeInstanceResolver({
    destinationReservations: service,
    liveInstanceResolver: {
      async resolveInstance(instanceId) { return { instanceId, serverPath: path.join(root, 'Live'), priorRunning: true }; }
    }
  });
  assert.deepEqual(await composite.resolveInstance(reserved.instanceId), {
    instanceId: reserved.instanceId,
    serverPath: targetPath,
    priorRunning: false
  });
  assert.equal(service.consume(reserved.instanceId, targetPath), true);
  assert.equal(service.resolve(reserved.instanceId), null);
});

test('renderer abandonment releases only the validated opaque destination reservation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Abandoned');
  fs.mkdirSync(targetPath);
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; } },
    reparseInspector,
    randomUUID: () => '00000000-0000-4000-8000-000000000003'
  });
  const handlers = createModpackHandlers(handlerDependencies(service));
  const reserved = await handlers['modpacks:reserve-server-destination']({}, {});
  const instanceId = reserved.value.instanceId;
  assert.notEqual(service.resolve(instanceId), null);

  const released = await handlers['modpacks:release-server-destination']({}, { instanceId });
  assert.deepEqual(released, { ok: true, value: true });
  assert.equal(service.resolve(instanceId), null);
  assert.deepEqual(
    await handlers['modpacks:release-server-destination']({}, { instanceId }),
    { ok: true, value: false }
  );
});

test('reservation incarnation is never reused after release or consumption at the same path', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Retry Server');
  fs.mkdirSync(targetPath);
  const ids = [
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000012',
    '00000000-0000-4000-8000-000000000013'
  ];
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; } },
    reparseInspector,
    randomUUID: () => ids.shift()
  });

  const first = await service.reserveWithNativeDialog({});
  assert.equal(first.instanceId, 'server-00000000-0000-4000-8000-000000000011');
  assert.equal(service.release(first.instanceId), true);

  const retry = await service.reserveWithNativeDialog({});
  assert.notEqual(retry.instanceId, first.instanceId);
  assert.equal(service.release(first.instanceId), false);
  assert.equal(service.consume(retry.instanceId, targetPath), true);

  const afterPublication = await service.reserveWithNativeDialog({});
  assert.equal(afterPublication.instanceId, 'server-00000000-0000-4000-8000-000000000013');
});

test('a released destination identity cannot be issued to a different path', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstPath = path.join(root, 'First Server');
  const secondPath = path.join(root, 'Second Server');
  fs.mkdirSync(firstPath);
  fs.mkdirSync(secondPath);
  let selectedPath = firstPath;
  const ids = [
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000022',
    '00000000-0000-4000-8000-000000000023'
  ];
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [selectedPath] }; } },
    reparseInspector,
    randomUUID: () => ids.shift()
  });

  const first = await service.reserveWithNativeDialog({});
  assert.equal(service.release(first.instanceId), true);
  selectedPath = secondPath;

  const second = await service.reserveWithNativeDialog({});
  assert.equal(second.instanceId, 'server-00000000-0000-4000-8000-000000000022');
  selectedPath = firstPath;
  const retriedFirst = await service.reserveWithNativeDialog({});
  assert.notEqual(retriedFirst.instanceId, first.instanceId);
});

test('reservation incarnation allocation skips unavailable and previously issued identifiers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-unavailable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstPath = path.join(root, 'Original Server');
  const secondPath = path.join(root, 'Other Server');
  fs.mkdirSync(firstPath);
  fs.mkdirSync(secondPath);
  const originalId = 'server-00000000-0000-4000-8000-000000000041';
  let selectedPath = firstPath;
  let originalIdAvailable = true;
  const ids = [
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000042',
    '00000000-0000-4000-8000-000000000043',
    '00000000-0000-4000-8000-000000000044'
  ];
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [selectedPath] }; } },
    reparseInspector,
    randomUUID: () => ids.shift(),
    isInstanceIdAvailable: instanceId => instanceId !== originalId || originalIdAvailable
  });

  const first = await service.reserveWithNativeDialog({});
  assert.equal(first.instanceId, originalId);
  assert.equal(service.release(first.instanceId), true);

  originalIdAvailable = false;
  const replacement = await service.reserveWithNativeDialog({});
  assert.notEqual(replacement.instanceId, originalId);
  assert.equal(service.release(replacement.instanceId), true);

  originalIdAvailable = true;
  selectedPath = secondPath;
  const second = await service.reserveWithNativeDialog({});
  assert.equal(second.instanceId, 'server-00000000-0000-4000-8000-000000000043');

  selectedPath = firstPath;
  const retriedFirst = await service.reserveWithNativeDialog({});
  assert.notEqual(retriedFirst.instanceId, originalId);
});

test('concurrent reservations for the same destination produce exactly one reservation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-concurrent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Concurrent Server');
  fs.mkdirSync(targetPath);
  let captureCalls = 0;
  let randomCalls = 0;
  let releaseFirstCapture;
  let markFirstCaptureEntered;
  const firstCaptureEntered = new Promise(resolve => { markFirstCaptureEntered = resolve; });
  const firstCaptureGate = new Promise(resolve => { releaseFirstCapture = resolve; });
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; } },
    reparseInspector,
    randomUUID() {
      randomCalls += 1;
      return `00000000-0000-4000-8000-${String(randomCalls).padStart(12, '0')}`;
    },
    async captureReservation() {
      captureCalls += 1;
      if (captureCalls === 1) {
        markFirstCaptureEntered();
        await firstCaptureGate;
      }
      return Object.freeze({ kind: 'empty-directory' });
    }
  });

  const firstAttempt = service.reserveWithNativeDialog({});
  await firstCaptureEntered;
  const secondAttempt = service.reserveWithNativeDialog({});
  await new Promise(resolve => setImmediate(resolve));
  releaseFirstCapture();

  const results = await Promise.allSettled([firstAttempt, secondAttempt]);
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, 'TARGET_EXISTS');
  assert.equal(captureCalls, 1);
  assert.equal(randomCalls, 1);
  assert.notEqual(service.resolve(fulfilled[0].value.instanceId), null);
});

test('reservation finalization for different destinations remains independent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-parallel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstPath = path.join(root, 'First Parallel Server');
  const secondPath = path.join(root, 'Second Parallel Server');
  fs.mkdirSync(firstPath);
  fs.mkdirSync(secondPath);
  const selections = [firstPath, secondPath];
  let captureCalls = 0;
  let releaseFirstCapture;
  let markFirstCaptureEntered;
  let markSecondCaptureEntered;
  const firstCaptureEntered = new Promise(resolve => { markFirstCaptureEntered = resolve; });
  const secondCaptureEntered = new Promise(resolve => { markSecondCaptureEntered = resolve; });
  const firstCaptureGate = new Promise(resolve => { releaseFirstCapture = resolve; });
  const ids = [
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000052'
  ];
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [selections.shift()] }; } },
    reparseInspector,
    randomUUID: () => ids.shift(),
    async captureReservation({ targetPath }) {
      captureCalls += 1;
      if (targetPath === firstPath) {
        markFirstCaptureEntered();
        await firstCaptureGate;
      } else {
        markSecondCaptureEntered();
      }
      return Object.freeze({ kind: 'empty-directory' });
    }
  });

  const firstAttempt = service.reserveWithNativeDialog({});
  await firstCaptureEntered;
  const secondAttempt = service.reserveWithNativeDialog({});
  await secondCaptureEntered;
  const second = await secondAttempt;
  assert.equal(second.instanceId, 'server-00000000-0000-4000-8000-000000000051');

  releaseFirstCapture();
  const first = await firstAttempt;
  assert.equal(first.instanceId, 'server-00000000-0000-4000-8000-000000000052');
  assert.equal(captureCalls, 2);
});

test('reservation incarnation expiry finalizes under the gate without recycling identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-destination-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Expired Server');
  fs.mkdirSync(targetPath);
  let now = 1;
  const ids = [
    '00000000-0000-4000-8000-000000000031',
    '00000000-0000-4000-8000-000000000032'
  ];
  const service = new ServerDestinationReservationService({
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: [targetPath] }; } },
    reparseInspector,
    randomUUID: () => ids.shift(),
    clock: () => now,
    ttlMs: 10
  });

  const first = await service.reserveWithNativeDialog({});
  now = 11;
  assert.throws(() => service.resolve(first.instanceId), error => error?.code === 'PLAN_STALE');
  assert.notEqual(service.peek(first.instanceId), null, 'resolve must not delete outside the gate');

  const retry = await service.reserveWithNativeDialog({});
  assert.notEqual(retry.instanceId, first.instanceId);
});

test('unmanaged adoption authority rejects a replacement directory while new-target reservation remains empty-only', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-existing-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'Registered Existing Server');
  const originalPath = path.join(root, 'Original Moved Aside');
  fs.mkdirSync(targetPath);
  fs.writeFileSync(path.join(targetPath, 'server.properties'), 'motd=existing\n');

  await assert.rejects(
    captureReservedTarget({ targetPath, fsApi: fs, reparseInspector }),
    error => error?.code === 'TARGET_EXISTS'
  );
  const adoption = await captureExistingUnmanagedTarget({ targetPath, fsApi: fs, reparseInspector });
  assert.equal(adoption.kind, 'existing-unmanaged-directory');

  fs.renameSync(targetPath, originalPath);
  fs.mkdirSync(targetPath);
  fs.writeFileSync(path.join(targetPath, 'server.properties'), 'motd=existing\n');

  await assert.rejects(
    assertExistingUnmanagedTarget({ targetPath, adoption, fsApi: fs, reparseInspector }),
    error => error?.code === 'PLAN_STALE'
  );
  assert.equal(fs.readFileSync(path.join(originalPath, 'server.properties'), 'utf8'), 'motd=existing\n');
  assert.equal(fs.readFileSync(path.join(targetPath, 'server.properties'), 'utf8'), 'motd=existing\n');
});
