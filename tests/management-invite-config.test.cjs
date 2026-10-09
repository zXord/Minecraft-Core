const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function createFixture(t, { existing = true, failPublication = false, failPacking = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-invite-config-'));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  const handlerPath = path.resolve(__dirname, '../electron/ipc/management-server-handlers.cjs');
  const configManagerPath = path.resolve(__dirname, '../electron/utils/config-manager.cjs');
  const originalLoad = Module._load;
  const appState = {
    instances: [{ id: 'server-one', type: 'server', path: serverPath,
      managementInviteHost: 'old.example', managementInviteSecret: 'enc:fixture-secret' }],
    lastServerPath: serverPath
  };
  let appStoreWrites = 0;
  let publicationAttempts = 0;
  const live = {
    externalHost: 'old.example',
    inviteSecret: 'fixture-secret',
    hostWrites: 0,
    secretWrites: 0,
    setExternalHost(value) { this.hostWrites += 1; this.externalHost = value; },
    setInviteSecret(value) { this.secretWrites += 1; this.inviteSecret = value; },
    getModDownloadHost() { return this.externalHost || '127.0.0.1'; }
  };
  Module._load = function loadInviteFixture(request, parent, isMain) {
    if (request.endsWith('/utils/app-store.cjs')) return {
      get: key => appState[key],
      set(key, value) { appStoreWrites += 1; appState[key] = value; }
    };
    if (request.endsWith('/utils/secure-store.cjs')) return {
      ensureEncryptionAvailable() {},
      packSecret(value) {
        if (failPacking) throw new Error('Injected encryption failure');
        return `enc:${value}`;
      },
      unpackSecret: value => String(value).replace(/^enc:/, '')
    };
    if (request.endsWith('/services/management-server.cjs')) return { getManagementServer: () => live };
    if (request.endsWith('/utils/tls-utils.cjs')) return { getExistingManagementTlsConfig: () => null };
    if (request.endsWith('/utils/port-validator.cjs')) return {
      validateServerPorts: async () => ({ valid: true, errors: [] })
    };
    if (request.endsWith('/ipc/logger-handlers.cjs')) return {
      getLoggerHandlers: () => ({ debug() {}, error() {}, info() {}, warn() {} })
    };
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[handlerPath];
  delete require.cache[configManagerPath];
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[handlerPath];
    delete require.cache[configManagerPath];
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Keep the production config writer, strict JSON validation and atomic writer;
  // only substitute the native publication boundary for this isolated fixture.
  const durableFs = require('../electron/utils/durable-fs.cjs').createDurableFs({
    allowedRoots: [root],
    durableClient: {
      moveWriteThrough: publish,
      replaceFileWriteThrough: publish,
      flushDirectory() {}
    }
  });
  function publish(source, destination) {
    publicationAttempts += 1;
    if (failPublication) throw new Error('Injected pre-publication failure');
    fs.renameSync(source, destination);
  }
  const configManager = require(configManagerPath);
  configManager.configureServerConfigDurableFsFactory(() => durableFs);
  const configPath = path.join(serverPath, '.minecraft-core.json');
  if (existing) fs.writeFileSync(configPath, `${JSON.stringify({
    ...configManager.getDefaultServerConfig({ managementPort: 8080 }),
    contentRevision: 12,
    maxRam: 7,
    customSetting: { preserved: true },
    managementInviteHost: 'old.example',
    managementInviteSecret: 'fixture-secret'
  }, null, 2)}\n`);
  const handlers = require(handlerPath).createManagementServerHandlers(null);
  return {
    appState, live, configPath, serverPath, handlers,
    readConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
    getAppStoreWrites: () => appStoreWrites,
    getPublicationAttempts: () => publicationAttempts
  };
}

for (const channel of ['set-management-invite-host', 'set-management-server-external-host']) {
  for (const existing of [false, true]) {
    test(`${channel} saves host-only metadata in ${existing ? 'existing' : 'fresh'} strict config`, async (t) => {
      const fixture = createFixture(t, { existing });
      const result = await fixture.handlers[channel](null, {
        instanceId: 'server-one', serverPath: fixture.serverPath,
        host: ' 127.0.0.1 ', hostIP: ' 127.0.0.1 '
      });
      assert.equal(result.success, true, result.error);
      const config = fixture.readConfig();
      assert.equal(config.managementInviteHost, '127.0.0.1');
      assert.equal(config.managementInviteSecret === (existing ? 'fixture-secret' : ''), true);
      assert.equal(config.contentRevision, existing ? 12 : 0);
      if (existing) {
        assert.equal(config.maxRam, 7);
        assert.deepEqual(config.customSetting, { preserved: true });
      }
      assert.equal(fixture.appState.instances[0].managementInviteHost, '127.0.0.1');
      assert.equal(fixture.appState.instances[0].managementInviteSecret === 'enc:fixture-secret', true);
      assert.equal(fixture.live.externalHost, '127.0.0.1');
      assert.equal(fixture.live.secretWrites, 0);
    });
  }

  test(`${channel} explicitly clears the host without clearing the secret`, async (t) => {
    const fixture = createFixture(t);
    const result = await fixture.handlers[channel](null, {
      serverPath: fixture.serverPath, host: '', hostIP: ''
    });
    assert.equal(result.success, true, result.error);
    assert.equal(fixture.readConfig().managementInviteHost, '');
    assert.equal(fixture.readConfig().managementInviteSecret === 'fixture-secret', true);
    assert.equal(fixture.appState.instances[0].managementInviteHost, '');
    assert.equal(fixture.live.externalHost, null);
  });
}

for (const channel of [
  'set-management-invite-host', 'set-management-server-external-host', 'regenerate-management-invite-secret'
]) {
  test(`${channel} leaves stored and advertised state unchanged on durable publication failure`, async (t) => {
    const fixture = createFixture(t, { failPublication: true });
    const originalConfig = fs.readFileSync(fixture.configPath, 'utf8');
    const originalInstances = JSON.stringify(fixture.appState.instances);
    const result = await fixture.handlers[channel](null, {
      serverPath: fixture.serverPath, host: 'new.example', hostIP: 'new.example'
    });
    assert.equal(result.success, false);
    assert.equal(fixture.getPublicationAttempts(), 1);
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8') === originalConfig, true);
    assert.equal(JSON.stringify(fixture.appState.instances) === originalInstances, true);
    assert.equal(fixture.getAppStoreWrites(), 0);
    assert.equal(fixture.live.externalHost, 'old.example');
    assert.equal(fixture.live.inviteSecret === 'fixture-secret', true);
    assert.equal(fixture.live.hostWrites, 0);
    assert.equal(fixture.live.secretWrites, 0);
  });
}

for (const existing of [false, true]) {
  test(`invite secret ${existing ? 'rotation' : 'setup'} persists strict metadata before advertising`, async (t) => {
    const fixture = createFixture(t, { existing });
    const result = await fixture.handlers['regenerate-management-invite-secret'](null, {
      serverPath: fixture.serverPath
    });
    assert.equal(result.success, true, result.error);
    assert.equal(typeof result.secret === 'string' && /^[A-Za-z0-9_-]{32}$/.test(result.secret), true);
    const config = fixture.readConfig();
    assert.equal(config.managementInviteSecret === result.secret, true);
    assert.equal(config.managementInviteHost, 'old.example');
    assert.equal(config.contentRevision, existing ? 12 : 0);
    assert.equal(fixture.appState.instances[0].managementInviteSecret === `enc:${result.secret}`, true);
    assert.equal(fixture.live.inviteSecret === result.secret, true);
  });
}

test('secret packing failure leaves durable and advertised invite metadata unchanged', async (t) => {
  const fixture = createFixture(t, { failPacking: true });
  const originalConfig = fs.readFileSync(fixture.configPath, 'utf8');
  const originalInstances = JSON.stringify(fixture.appState.instances);
  const result = await fixture.handlers['regenerate-management-invite-secret'](null, {
    serverPath: fixture.serverPath
  });
  assert.equal(result.success, false);
  assert.equal(fixture.getPublicationAttempts(), 0);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8') === originalConfig, true);
  assert.equal(JSON.stringify(fixture.appState.instances) === originalInstances, true);
  assert.equal(fixture.getAppStoreWrites(), 0);
  assert.equal(fixture.live.secretWrites, 0);
});
