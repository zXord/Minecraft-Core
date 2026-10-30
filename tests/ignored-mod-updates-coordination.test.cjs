const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createServerMutationPolicy
} = require('../electron/services/server-mutation-policy.cjs');
const {
  ServerMutationCoordinator
} = require('../electron/services/server-mutation-coordinator.cjs');
const {
  getCurrentServerMutationLease
} = require('../electron/services/server-mutation-context.cjs');

const TORN = '{"Old.jar":{"ids":["old-2"],"vers":["2.0"]},"Other.jar":{"ids":["o';
const SNAPSHOT = Object.freeze({ 'A.jar': Object.freeze({ ids: Object.freeze(['a-2']), vers: Object.freeze([]) }) });

function loadRealIgnoredUpdateHandlers(userDataPath) {
  const originalLoad = Module._load;
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  Module._load = function loadIgnoredUpdatesCoordinationFixture(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userDataPath } };
    if (request === '../../services/mod-api-service.cjs') return {};
    if (request === '../mod-utils/mod-installation-service.cjs') return {};
    if (request === '../../services/download-manager.cjs') return {};
    if (request === '../../utils/app-store.cjs') return { get: () => [] };
    if (request === './mod-handler-utils.cjs') return {};
    if (request === '../logger-handlers.cjs') return { getLoggerHandlers: () => logger };
    if (request === '../error-monitoring-handlers.cjs') return { serverErrorMonitor: {} };
    if (request === '../../utils/server-loader.cjs') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  const handlersPath = require.resolve('../electron/ipc/mod-handlers/server-mod-handlers.cjs');
  const managerPath = require.resolve('../electron/ipc/mod-utils/mod-file-manager.cjs');
  delete require.cache[handlersPath];
  delete require.cache[managerPath];
  try {
    return require(handlersPath).createServerModHandlers(null);
  } finally {
    Module._load = originalLoad;
  }
}

function ignoredFile(serverPath) {
  return path.join(serverPath, 'minecraft-core-configs', 'ignored-mod-updates.json');
}

function createCoordinatedSave(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-coordination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const alpha = path.join(root, 'alpha');
  const revisions = new Map();
  const normalized = value => path.resolve(value).toLocaleLowerCase('en-US');
  const coordinator = new ServerMutationCoordinator({
    readContentRevision(serverPath) {
      return revisions.get(normalized(serverPath)) || 0;
    },
    bumpContentRevision(serverPath, { expectedRevision }) {
      revisions.set(normalized(serverPath), expectedRevision + 1);
      return expectedRevision + 1;
    }
  });
  coordinator.completeStartupRecovery([]);
  let operationCount = 0;
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: alpha }],
    createOperationId: () => `ignored-updates-${operationCount += 1}`
  });
  const handlers = loadRealIgnoredUpdateHandlers(path.join(root, 'user-data'));
  const leasesSeen = [];
  const save = policy.wrapHandler('save-ignored-mod-updates', (...args) => {
    leasesSeen.push(getCurrentServerMutationLease());
    return handlers['save-ignored-mod-updates'](...args);
  });
  return {
    alpha,
    coordinator,
    leasesSeen,
    revisions,
    save: (...args) => save({ sender: { id: 1 } }, ...args),
    unsettledRecords: () => Array.from(coordinator.records).filter(record =>
      record.recoveryBlock || record.revisionFailure || record.mutation || record.start)
  };
}

test('R16: a save for a missing server folder fails through the real coordinator and leaves nothing behind', async (t) => {
  const env = createCoordinatedSave(t);

  const result = await env.save(env.alpha, JSON.stringify(SNAPSHOT));

  assert.equal(result.success, false);
  assert.match(result.error, /ENOENT/);
  assert.equal(fs.existsSync(env.alpha), false);
  assert.deepEqual(env.unsettledRecords(), []);
  assert.equal(env.revisions.size, 0);

  fs.mkdirSync(env.alpha);
  assert.deepEqual(await env.save(env.alpha, JSON.stringify(SNAPSHOT)), { success: true, changed: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(ignoredFile(env.alpha), 'utf8')), SNAPSHOT);
  assert.deepEqual(env.unsettledRecords(), []);
  assert.equal(env.revisions.size, 0);
});

test('R6: an unreadable file is repaired inside the server lease with its bytes set aside and no revision bump', async (t) => {
  const env = createCoordinatedSave(t);
  const configDirectory = path.dirname(ignoredFile(env.alpha));
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(ignoredFile(env.alpha), TORN);

  const result = await env.save(env.alpha, '{}', { replaceOnlyUnreadable: true });

  assert.deepEqual(result, { success: true, changed: true });
  assert.equal(env.leasesSeen.length, 1);
  assert.ok(env.leasesSeen[0], 'the save must run inside the server mutation lease');
  assert.equal(fs.readFileSync(ignoredFile(env.alpha), 'utf8'), '{}');
  const setAside = fs.readdirSync(configDirectory)
    .filter(name => name.startsWith('ignored-mod-updates.json.unreadable-'));
  assert.equal(setAside.length, 1);
  assert.equal(fs.readFileSync(path.join(configDirectory, setAside[0]), 'utf8'), TORN);
  assert.deepEqual(fs.readdirSync(configDirectory).sort(), ['ignored-mod-updates.json', setAside[0]].sort());
  assert.deepEqual(env.unsettledRecords(), []);
  assert.equal(env.revisions.size, 0);
});

test('a save while the server runs is refused by the coordinator and leaves the file untouched', async (t) => {
  const env = createCoordinatedSave(t);
  fs.mkdirSync(path.dirname(ignoredFile(env.alpha)), { recursive: true });
  fs.writeFileSync(ignoredFile(env.alpha), TORN);
  const runLease = await env.coordinator.acquireStart(
    { instanceId: 'server-alpha', serverPath: env.alpha },
    { operation: 'server-start', operationId: 'ignored-updates-run', parentMutationLease: null }
  );
  runLease.markRunning({ pid: 301 });

  try {
    await assert.rejects(
      env.save(env.alpha, '{}', { replaceOnlyUnreadable: true }),
      error => error?.code === 'SERVER_RUNNING'
    );
  } finally {
    runLease.release();
  }

  assert.deepEqual(env.leasesSeen, []);
  assert.equal(fs.readFileSync(ignoredFile(env.alpha), 'utf8'), TORN);
  assert.deepEqual(fs.readdirSync(path.dirname(ignoredFile(env.alpha))), ['ignored-mod-updates.json']);
});
