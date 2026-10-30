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
const { readContentRevision } = require('../electron/services/server-content-revision.cjs');
const { getCurrentServerMutationLease } = require('../electron/services/server-mutation-context.cjs');
const { updateServerConfig } = require('../electron/utils/config-manager.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');

function createCoordinator() {
  const revisions = new Map();
  const normalized = value => path.resolve(value).toLocaleLowerCase('en-US');
  const coordinator = new ServerMutationCoordinator({
    readContentRevision(serverPath) {
      return revisions.get(normalized(serverPath)) || 0;
    },
    bumpContentRevision(serverPath, { expectedRevision }) {
      const key = normalized(serverPath);
      assert.equal(revisions.get(key) || 0, expectedRevision);
      revisions.set(key, expectedRevision + 1);
      return expectedRevision + 1;
    }
  });
  coordinator.completeStartupRecovery([]);
  return { coordinator, revisions };
}

function code(expected) {
  return error => error && error.code === expected;
}

async function startRunning(coordinator, serverPath, operationId) {
  const runLease = await coordinator.acquireStart(
    { instanceId: 'server-alpha', serverPath },
    { operation: 'server-start', operationId, parentMutationLease: null }
  );
  runLease.markRunning({ pid: 201 });
  return runLease;
}

// A modpack lifecycle operation holds the folder exclusively until it settles.
async function holdLifecycle(coordinator, serverPath) {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = coordinator.runMutation({ instanceId: 'server-alpha', serverPath }, {
    operation: 'modpack-update', operationId: 'task-14-lifecycle', revisionMode: 'none', quiesce: null
  }, async () => {
    entered();
    await gate;
  });
  await started;
  return () => { release(); return run; };
}

test('player-list writers run while the server runs but never overlap modpack lifecycle work', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-14-players');
  const { coordinator } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: serverPath }],
    createOperationId: channel => `content-${channel}`
  });
  let calls = 0;
  const handler = policy.wrapHandler('add-player', async () => {
    calls += 1;
    return [];
  });
  const runLease = await startRunning(coordinator, serverPath, 'task-14-player-run');
  try {
    assert.deepEqual(await handler({ sender: { id: 1 } }, 'whitelist', serverPath, 'Alex'), []);
    assert.equal(calls, 1);
  } finally {
    runLease.release();
  }

  const release = await holdLifecycle(coordinator, serverPath);
  try {
    await assert.rejects(
      handler({ sender: { id: 1 } }, 'whitelist', serverPath, 'Steve'),
      code('OPERATION_IN_PROGRESS')
    );
  } finally {
    await release();
  }
  assert.equal(calls, 1);
});

test('launcher client assets are coordinated by their registered owning server root', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-14-client-owner');
  const clientPath = path.join(serverPath, 'client');
  const { coordinator } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: serverPath }],
    createOperationId: channel => `content-${channel}`
  });
  let owners = [];
  const handler = policy.wrapHandler('minecraft-download-assets', async () => {
    owners.push(getCurrentServerMutationLease()?.serverPath);
    return { success: true };
  });
  const request = { clientPath, type: 'resourcepacks', requiredItems: [], serverInfo: {} };
  const runLease = await startRunning(coordinator, serverPath, 'task-14-client-run');
  try {
    assert.deepEqual(await handler({ sender: { id: 1 } }, request), { success: true });
  } finally {
    runLease.release();
  }
  assert.deepEqual(owners, [path.resolve(serverPath)]);

  owners = [];
  const release = await holdLifecycle(coordinator, serverPath);
  try {
    await assert.rejects(handler({ sender: { id: 1 } }, request), code('OPERATION_IN_PROGRESS'));
  } finally {
    await release();
  }
  assert.deepEqual(owners, []);
});

test('a registered standalone client root receives one content revision for a successful write', async () => {
  const clientPath = path.join(os.tmpdir(), 'minecraft-core-task-14-client');
  const { coordinator, revisions } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'client-alpha', type: 'client', path: clientPath }],
    createOperationId: channel => `content-${channel}`
  });
  const handler = policy.wrapHandler('install-client-mod', async () => ({ success: true }));

  await handler({ sender: { id: 1 } }, { clientPath, fileName: 'example.jar' });

  assert.equal(revisions.get(path.resolve(clientPath).toLocaleLowerCase('en-US')), 1);
});

test('path-shaped legacy instanceId payloads resolve to the registered client root', async () => {
  const clientPath = path.join(os.tmpdir(), 'minecraft-core-task-14-client-preferences');
  const { coordinator, revisions } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'client-alpha', type: 'client', path: clientPath }],
    createOperationId: channel => `content-${channel}`
  });
  const handler = policy.wrapHandler('set-download-preferences', async () => ({ success: true }));

  await handler({ sender: { id: 1 } }, {
    instanceId: clientPath,
    primarySource: 'modrinth',
    fallbackSource: 'server'
  });

  assert.equal(revisions.get(path.resolve(clientPath).toLocaleLowerCase('en-US')), 1);
});

test('legacy client-mod paths resolve to their registered client owner', async () => {
  const clientPath = path.join(os.tmpdir(), 'minecraft-core-task-14-client-mod-path');
  const { coordinator, revisions } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'client-alpha', type: 'client', path: clientPath }],
    createOperationId: channel => `content-${channel}`
  });
  const handler = policy.wrapHandler('disable-client-mod', async () => ({ success: true }));

  await handler({ sender: { id: 1 } }, {
    modFilePath: path.join(clientPath, 'mods', 'example.jar')
  });

  assert.equal(revisions.get(path.resolve(clientPath).toLocaleLowerCase('en-US')), 1);
});

test('the production revision backend advances client config without publishing server config', async (t) => {
  const clientPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-task-14-client-revision-'));
  t.after(() => fs.rmSync(clientPath, { recursive: true, force: true }));
  const clientConfigPath = path.join(clientPath, 'client-config.json');
  fs.writeFileSync(clientConfigPath, JSON.stringify({
    serverIp: '127.0.0.1',
    serverPort: '8080',
    serverProtocol: 'https',
    clientId: 'client-alpha',
    clientName: 'Test client',
    contentRevision: 3,
    preserved: true
  }));

  let sequence = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      flushDirectory() {},
      moveWriteThrough(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath);
      },
      replaceFileWriteThrough(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath);
      }
    },
    allowedRoots: [clientPath],
    tempNameFactory: () => `client-revision-${++sequence}`
  });
  const coordinator = new ServerMutationCoordinator({ durableFs });
  coordinator.completeStartupRecovery([]);
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'client-alpha', type: 'client', path: clientPath }],
    createOperationId: channel => `content-${channel}`
  });
  const handler = policy.wrapHandler('install-client-mod', async () => ({ success: true }));

  await handler({ sender: { id: 1 } }, { clientPath, fileName: 'example.jar' });

  const clientConfig = JSON.parse(fs.readFileSync(clientConfigPath, 'utf8'));
  assert.equal(clientConfig.contentRevision, 4);
  assert.equal(clientConfig.preserved, true);
  assert.equal(fs.existsSync(path.join(clientPath, '.minecraft-core.json')), false);
});

test('failed or no-op content writers do not advance the content revision', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-14-no-op');
  const { coordinator, revisions } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: serverPath }],
    createOperationId: channel => `content-${channel}`
  });
  const handler = policy.wrapHandler('delete-mod', async (_event, _serverPath, modName) => (
    modName === 'missing.jar'
      ? { success: true, changed: false }
      : { success: false, error: 'invalid' }
  ));

  await handler({ sender: { id: 1 } }, serverPath, 'missing.jar');
  await handler({ sender: { id: 1 } }, serverPath, 'invalid.jar');

  assert.equal(revisions.get(path.resolve(serverPath).toLocaleLowerCase('en-US')) || 0, 0);
});

test('ignored-update preference writes are coordinated without advancing server content revision', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-14-ignored-preferences');
  const { coordinator, revisions } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: serverPath }],
    createOperationId: channel => `content-${channel}`
  });
  const handler = policy.wrapHandler(
    'save-ignored-mod-updates',
    async () => ({ success: true, changed: true })
  );

  await handler({ sender: { id: 1 } }, serverPath, '{"Example.jar":{"ids":[],"vers":[]}}');

  assert.equal(revisions.get(path.resolve(serverPath).toLocaleLowerCase('en-US')) || 0, 0);
});

test('reading an existing management invite does not advance server content revision', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-14-existing-invite');
  const { coordinator, revisions } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: serverPath }],
    createOperationId: channel => `content-${channel}`
  });
  const handler = policy.wrapHandler(
    'get-management-invite-info',
    async () => ({ success: true, secret: 'already-present' })
  );

  await handler({ sender: { id: 1 } }, { instanceId: 'server-alpha', serverPath });

  assert.equal(revisions.get(path.resolve(serverPath).toLocaleLowerCase('en-US')) || 0, 0);
});

test('explicitly generating management invite metadata uses the coordinated mutation boundary', async (t) => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-task-14-missing-invite-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const configPath = path.join(serverPath, '.minecraft-core.json');
  fs.writeFileSync(configPath, JSON.stringify({ contentRevision: 3, maxRam: 4 }));

  let sequence = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      flushDirectory() {},
      moveWriteThrough(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath);
      },
      replaceFileWriteThrough(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath);
      }
    },
    allowedRoots: [serverPath],
    tempNameFactory: () => `invite-revision-${++sequence}`
  });
  const coordinator = new ServerMutationCoordinator({ durableFs });
  coordinator.completeStartupRecovery([]);
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: serverPath }],
    createOperationId: channel => `content-${channel}`
  });
  const handler = policy.wrapHandler('regenerate-management-invite-secret', async () => {
    updateServerConfig(serverPath, { managementInviteSecret: 'generated-secret' }, {}, {
      durableFs,
      operationId: 'persist-generated-invite'
    });
    return { success: true, secret: 'generated-secret' };
  });

  await handler({ sender: { id: 1 } }, { instanceId: 'server-alpha', serverPath });

  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).managementInviteSecret, 'generated-secret');
  assert.equal(readContentRevision(serverPath), 4);
});

test('browser writer delegates use the same mutation policy as desktop IPC', async () => {
  const serverPath = path.join(os.tmpdir(), 'minecraft-core-task-14-browser');
  const { coordinator } = createCoordinator();
  const policy = createServerMutationPolicy({
    coordinator,
    getInstances: () => [{ id: 'server-alpha', type: 'server', path: serverPath }],
    createOperationId: channel => `browser-${channel}`
  });
  const { createCoordinatedBrowserHandlers } = require(
    '../electron/services/browser-writer-delegates.cjs'
  );
  let calls = 0;
  const delegates = createCoordinatedBrowserHandlers({
    mutationPolicy: policy,
    player: {
      'add-player': async () => {
        calls += 1;
        return { success: true };
      }
    }
  });
  const runLease = await startRunning(coordinator, serverPath, 'task-14-browser-run');
  try {
    assert.deepEqual(
      await delegates.player['add-player']({ sender: { id: 'browser' } }, 'ops', serverPath, 'Alex'),
      { success: true }
    );
  } finally {
    runLease.release();
  }

  const release = await holdLifecycle(coordinator, serverPath);
  try {
    await assert.rejects(
      delegates.player['add-player']({ sender: { id: 'browser' } }, 'ops', serverPath, 'Steve'),
      code('OPERATION_IN_PROGRESS')
    );
  } finally {
    await release();
  }
  assert.equal(calls, 1);
});

test('player and mod hydration paths do not create or rewrite server content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-task-14-readonly-'));
  const bannedIpsPath = path.join(root, 'banned-ips.json');
  const originalPlayers = '[{"ip":"127.0.0.1","playerName":"Unknown"}]\n';
  fs.writeFileSync(bannedIpsPath, originalPlayers);
  const originalLoad = Module._load;
  const logger = { debug() {}, error() {}, info() {}, warn() {} };
  Module._load = function loadReadOnlyFixture(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => path.join(root, 'user-data') } };
    }
    if (typeof request === 'string' && request.endsWith('utils/app-store.cjs')) {
      return {
        get(key) {
          return key === 'instances' ? [{ id: 'server-alpha', type: 'server', path: root }] : null;
        }
      };
    }
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => logger };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const playerModulePath = require.resolve('../electron/ipc/player-handlers.cjs');
    const managerModulePath = require.resolve('../electron/ipc/mod-utils/mod-file-manager.cjs');
    delete require.cache[playerModulePath];
    delete require.cache[managerModulePath];
    const { createPlayerHandlers } = require(playerModulePath);
    const modFileManager = require(managerModulePath);

    const players = createPlayerHandlers()['read-players'](
      { sender: { id: 1 } },
      'banned-ips',
      root
    );
    assert.equal(players.length, 1);
    assert.equal(fs.readFileSync(bannedIpsPath, 'utf8'), originalPlayers);

    assert.deepEqual(await modFileManager.listMods(root), {
      mods: [],
      modFiles: [],
      serverPath: root,
      clientPath: path.join(root, 'client')
    });
    assert.deepEqual(await modFileManager.getInstalledModInfo(root), []);
    assert.deepEqual(await modFileManager.getDisabledMods(root), []);
    assert.deepEqual(
      await modFileManager.getIgnoredModUpdates(root),
      { found: false, data: {} }
    );
    assert.equal(fs.existsSync(path.join(root, 'mods')), false);
    assert.equal(fs.existsSync(path.join(root, 'client')), false);
    assert.equal(fs.existsSync(path.join(root, 'minecraft-core-manifests')), false);
  } finally {
    Module._load = originalLoad;
    for (const modulePath of [
      require.resolve('../electron/ipc/player-handlers.cjs'),
      require.resolve('../electron/ipc/mod-utils/mod-file-manager.cjs')
    ]) delete require.cache[modulePath];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
