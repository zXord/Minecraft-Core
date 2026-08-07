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
      inspectSource: noop, createPlan: noop, createManagementPlan: noop, startOperation: noop,
      cancelJob: noop, getJob: noop, getState: noop, listHistory: noop, verify: noop
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
