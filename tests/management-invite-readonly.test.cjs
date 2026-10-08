const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

test('management invite inspection preserves existing metadata and leaves missing setup uncreated', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-invite-readonly-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const handlerPath = path.resolve(__dirname, '../electron/ipc/management-server-handlers.cjs');
  const configManagerPath = path.resolve(__dirname, '../electron/utils/config-manager.cjs');
  const durableFsPath = path.resolve(__dirname, '../electron/utils/durable-fs.cjs');
  const originalLoad = Module._load;
  let appStoreSetCalls = 0;
  const instance = {
    id: 'server-one',
    type: 'server',
    path: serverPath,
    managementInviteHost: 'server.example',
    managementInviteSecret: 'enc:existing-secret'
  };
  const appState = {
    instances: [instance],
    lastServerPath: serverPath
  };
  const managementServer = {
    publicHost: '',
    useHttps: false,
    async refreshPublicHostIfStale() {},
    detectExternalIP: () => '127.0.0.1',
    getStatus: () => ({ port: 8080 }),
    setExternalHost() {},
    setInviteSecret() {},
    updateServerPath() {}
  };

  Module._load = function mockLoad(request, parent, isMain) {
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
    const config = {
      ...getDefaultServerConfig({ managementPort: 8080 }),
      managementInviteHost: 'server.example',
      managementInviteSecret: 'existing-secret'
    };
    const originalConfig = `${JSON.stringify(config, null, 2)}\n`;
    fs.writeFileSync(configPath, originalConfig);
    const originalInstances = JSON.stringify(appState.instances);
    const oldTime = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(configPath, oldTime, oldTime);

    const { createManagementServerHandlers } = require(handlerPath);
    const result = await createManagementServerHandlers(null)['get-management-invite-info'](null, {
      instanceId: 'server-one',
      serverPath
    });

    assert.equal(result.success, true);
    assert.equal(result.secret, 'existing-secret');
    assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
    assert.equal(fs.statSync(configPath).mtimeMs, oldTime.getTime());
    assert.equal(JSON.stringify(appState.instances), originalInstances);
    assert.equal(appStoreSetCalls, 0);

    const missingConfig = {
      ...config,
      managementInviteSecret: ''
    };
    const missingConfigBytes = `${JSON.stringify(missingConfig, null, 2)}\n`;
    fs.writeFileSync(configPath, missingConfigBytes);
    fs.utimesSync(configPath, oldTime, oldTime);
    delete instance.managementInviteSecret;
    const missingInstances = JSON.stringify(appState.instances);
    appStoreSetCalls = 0;

    const missingResult = await createManagementServerHandlers(null)['get-management-invite-info'](null, {
      instanceId: 'server-one',
      serverPath
    });

    assert.equal(missingResult.success, true);
    assert.equal(missingResult.configured, false);
    assert.equal(missingResult.secret, '');
    assert.equal(missingResult.inviteLink, '');
    assert.equal(fs.readFileSync(configPath, 'utf8'), missingConfigBytes);
    assert.equal(fs.statSync(configPath).mtimeMs, oldTime.getTime());
    assert.equal(JSON.stringify(appState.instances), missingInstances);
    assert.equal(appStoreSetCalls, 0);

    const pathUpdateResult = await createManagementServerHandlers(null)['update-management-server-path'](null, {
      instanceId: 'server-one',
      serverPath
    });

    assert.equal(pathUpdateResult.success, true);
    assert.equal(fs.readFileSync(configPath, 'utf8'), missingConfigBytes);
    assert.equal(fs.statSync(configPath).mtimeMs, oldTime.getTime());
    assert.equal(JSON.stringify(appState.instances), missingInstances);
    assert.equal(appStoreSetCalls, 0);
  } finally {
    delete require.cache[handlerPath];
    delete require.cache[configManagerPath];
    Module._load = originalLoad;
  }
});
