const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ServerMutationCoordinator
} = require('../electron/services/server-mutation-coordinator.cjs');
const {
  createServerMutationPolicy
} = require('../electron/services/server-mutation-policy.cjs');
const {
  readContentRevision
} = require('../electron/services/server-content-revision.cjs');

test('invite inspection is read-only while explicit secret setup remains coordinated', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-invite-policy-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const handlerPath = path.resolve(__dirname, '../electron/ipc/management-server-handlers.cjs');
  const configManagerPath = path.resolve(__dirname, '../electron/utils/config-manager.cjs');
  const durableFsPath = path.resolve(__dirname, '../electron/utils/durable-fs.cjs');
  const originalLoad = Module._load;
  let appStoreSetCalls = 0;
  let refreshCalls = 0;
  let releaseFirstRefresh;
  let reportFirstRefresh;
  const firstRefreshEntered = new Promise(resolve => {
    reportFirstRefresh = resolve;
  });
  const firstRefreshBarrier = new Promise(resolve => {
    releaseFirstRefresh = resolve;
  });
  const appState = {
    instances: [{
      id: 'server-one',
      type: 'server',
      path: serverPath,
      managementInviteHost: 'server.example'
    }],
    lastServerPath: serverPath
  };
  const managementServer = {
    publicHost: '',
    useHttps: false,
    async refreshPublicHostIfStale() {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        reportFirstRefresh();
        await firstRefreshBarrier;
      }
    },
    detectExternalIP: () => '127.0.0.1',
    getStatus: () => ({ port: 8080 }),
    setInviteSecret(value) { this.inviteSecret = value; }
  };

  Module._load = function loadInviteFixture(request, parent, isMain) {
    if (request.endsWith('/utils/app-store.cjs')) {
      return {
        get: key => appState[key],
        set: (key, value) => {
          appStoreSetCalls += 1;
          appState[key] = value;
          return true;
        }
      };
    }
    if (request.endsWith('/utils/secure-store.cjs')) {
      return {
        ensureEncryptionAvailable() {},
        packSecret: value => `enc:${value}`,
        unpackSecret: value => String(value).replace(/^enc:/, '')
      };
    }
    if (request.endsWith('/services/management-server.cjs')) {
      return { getManagementServer: () => managementServer };
    }
    if (request.endsWith('/utils/tls-utils.cjs')) {
      return { getExistingManagementTlsConfig: () => null };
    }
    if (request.endsWith('/utils/port-validator.cjs')) {
      return { validateServerPorts: async () => ({ valid: true, errors: [] }) };
    }
    if (request.endsWith('/ipc/logger-handlers.cjs')) {
      return {
        getLoggerHandlers: () => ({
          debug() {},
          error() {},
          info() {},
          warn() {}
        })
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[handlerPath];
  delete require.cache[configManagerPath];

  try {
    const durableFsModule = require(durableFsPath);
    durableFsModule.configureDurableFs({
      allowedRoots: [root],
      durableClient: {
        moveWriteThrough: (source, destination) => fs.renameSync(source, destination),
        replaceFileWriteThrough: (source, destination) => fs.renameSync(source, destination),
        flushDirectory() {}
      }
    });
    const { getDefaultServerConfig } = require(configManagerPath);
    const configPath = path.join(serverPath, '.minecraft-core.json');
    fs.writeFileSync(configPath, `${JSON.stringify({
      ...getDefaultServerConfig({ managementPort: 8080 }),
      contentRevision: 12,
      managementInviteHost: 'server.example',
      managementInviteSecret: ''
    }, null, 2)}\n`);

    const coordinator = new ServerMutationCoordinator({
      durableFs: durableFsModule.getConfiguredDurableFs()
    });
    coordinator.completeStartupRecovery([]);
    let operationSequence = 0;
    const policy = createServerMutationPolicy({
      coordinator,
      getInstances: () => appState.instances,
      createOperationId: channel => `invite-policy-${++operationSequence}-${channel}`
    });
    const { createManagementServerHandlers } = require(handlerPath);
    const managementHandlers = createManagementServerHandlers(null);
    const inviteHandler = policy.wrapHandler('get-management-invite-info', managementHandlers['get-management-invite-info']);
    const setupHandler = policy.wrapHandler(
      'regenerate-management-invite-secret',
      managementHandlers['regenerate-management-invite-secret']
    );
    let competingHandlerCalls = 0;
    const competingHandler = policy.wrapHandler('save-ignored-mod-updates', async () => {
      competingHandlerCalls += 1;
      return { success: true, changed: false };
    });
    const originalConfigBytes = fs.readFileSync(configPath, 'utf8');
    const originalInstances = JSON.stringify(appState.instances);

    const firstResultPromise = inviteHandler({ sender: { id: 1 } }, {
      instanceId: 'server-one',
      serverPath,
      port: 25591
    });
    await firstRefreshEntered;

    try {
      await competingHandler({ sender: { id: 2 } }, serverPath, '{}');
      assert.equal(competingHandlerCalls, 1);
    } finally {
      releaseFirstRefresh();
    }

    const firstResult = await firstResultPromise;
    assert.equal(firstResult.success, true);
    assert.equal(firstResult.configured, false);
    assert.equal(firstResult.requiresSetup, true);
    assert.equal(firstResult.secret, '');
    assert.equal(firstResult.inviteLink, '');
    assert.equal(firstResult.host, 'server.example');
    assert.equal(firstResult.port, 25591);
    assert.equal(firstResult.hostSource, 'configured');
    assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfigBytes);
    assert.equal(readContentRevision(serverPath), 12);
    assert.equal(JSON.stringify(appState.instances), originalInstances);
    assert.equal(appStoreSetCalls, 0);

    const preservedMtime = new Date('2021-02-03T04:05:06.000Z');
    fs.utimesSync(configPath, preservedMtime, preservedMtime);

    const secondResult = await inviteHandler({ sender: { id: 1 } }, {
      instanceId: 'server-one',
      serverPath,
      port: 25591
    });

    assert.equal(secondResult.success, true);
    assert.equal(secondResult.configured, false);
    assert.equal(secondResult.secret, '');
    assert.equal(secondResult.inviteLink, '');
    assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfigBytes);
    assert.equal(fs.statSync(configPath).mtimeMs, preservedMtime.getTime());
    assert.equal(JSON.stringify(appState.instances), originalInstances);
    assert.equal(appStoreSetCalls, 0);
    assert.equal(readContentRevision(serverPath), 12);

    const setupResult = await setupHandler({ sender: { id: 3 } }, {
      instanceId: 'server-one',
      serverPath
    });
    assert.equal(setupResult.success, true);
    assert.match(setupResult.secret, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).managementInviteSecret, setupResult.secret);
    assert.equal(appState.instances[0].managementInviteSecret, `enc:${setupResult.secret}`);
    assert.equal(managementServer.inviteSecret, setupResult.secret);
    assert.equal(appStoreSetCalls, 1);
  } finally {
    releaseFirstRefresh();
    delete require.cache[handlerPath];
    delete require.cache[configManagerPath];
    Module._load = originalLoad;
  }
});
