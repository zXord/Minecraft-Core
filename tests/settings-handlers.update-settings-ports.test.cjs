const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// update-settings with the real port validator and the real config writer,
// against real listening sockets: while a server runs, its Java process holds
// its saved Minecraft port and Minecraft Core holds its running management
// port. One environment per process; only process-wide boundaries are stubbed.
const store = new Map();
const appStore = {
  get: key => (store.has(key) ? structuredClone(store.get(key)) : undefined),
  set: (key, value) => { store.set(key, structuredClone(value)); return true; },
  delete: key => { store.delete(key); return true; }
};
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const STUBS = new Map([
  ['app-store.cjs', appStore],
  ['logger-handlers.cjs', { getLoggerHandlers: () => QUIET }],
  ['instance-context.cjs', { updateInstances() {} }],
  ['secure-store.cjs', { ensureEncryptionAvailable: () => true, packSecret: value => `packed:${value}`, unpackSecret: value => value }],
  ['servers-dat.cjs', { ensureServersDat: async () => ({ success: true }) }],
  ['server-manager.cjs', { shutdownMinecraftServer: async () => ({ success: true }) }],
  ['management-server.cjs', { stopAndDisposeManagementServers: async () => ({ success: true }) }]
]);
const originalLoad = Module._load;
Module._load = function loadWithBoundaries(request, parent, isMain) {
  const stub = typeof request === 'string' ? STUBS.get(path.posix.basename(request.replaceAll('\\', '/'))) : undefined;
  return stub || originalLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; });

const configManager = require('../electron/utils/config-manager.cjs');
const { createInstanceConfigFsFactory } = require('../electron/utils/instance-config-fs.cjs');
const { validateServerPorts } = require('../electron/utils/port-validator.cjs');
const { createSettingsHandlers } = require('../electron/ipc/settings-handlers.cjs');

// These folders have no modpack evidence, so the legacy config writer serves them.
configManager.configureServerConfigDurableFsFactory(createInstanceConfigFsFactory({
  strictFactory: () => { throw new Error('Only unmanaged folders are written here'); }
}));
const settings = createSettingsHandlers();

const EVENT = { sender: { id: 1 } };
const FIELDS = ['port', 'maxRam', 'managementPort', 'autoStartMinecraft', 'autoStartManagement'];
const pick = value => Object.fromEntries(FIELDS.map(field => [field, value[field]]));

// .minecraft-core.json as v26.6.1 writes it.
function v26Config(overrides) {
  return {
    version: '1.21.1', fabric: null, loader: 'vanilla', loaderVersion: null,
    port: 25565, maxRam: 4, managementPort: 8080, autoStartMinecraft: true, autoStartManagement: true,
    ...overrides
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  store.clear();
  appStore.set('instances', []);
  return {
    // A registered server folder; a null config leaves it without .minecraft-core.json.
    addServer(id, name, config) {
      const serverPath = path.join(root, name);
      const configPath = path.join(serverPath, '.minecraft-core.json');
      fs.mkdirSync(serverPath);
      if (config) fs.writeFileSync(configPath, `${JSON.stringify(v26Config(config), null, 2)}\n`);
      appStore.set('instances', [...appStore.get('instances'), { id, type: 'server', name, path: serverPath }]);
      return { id, name, serverPath, configPath, saved: () => pick(JSON.parse(fs.readFileSync(configPath, 'utf8'))) };
    }
  };
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(port, '127.0.0.1', () => resolve(socket));
  });
}

function close(socket) {
  return new Promise(resolve => (socket.listening ? socket.close(() => resolve()) : resolve()));
}

// Distinct loopback ports, each held by a real listening socket (the validator
// probes 127.0.0.1) until released. Ports below the management minimum of 1025
// and the defaults 25565 and 8080, which a test saves for another server, are skipped.
async function holdPorts(t, count) {
  const held = [];
  const skipped = [];
  while (held.length < count) {
    const socket = await listen(0);
    const { port } = socket.address();
    if (port < 1025 || port === 8080 || port === 25565) skipped.push(socket);
    else held.push({ port, release: () => close(socket) });
  }
  await Promise.all(skipped.map(close));
  t.after(() => Promise.all(held.map(entry => entry.release())));
  return held;
}

// ServerControls.updateSettings sends every field the Dashboard shows on each change.
function dashboardSave(server, shown) {
  return settings['update-settings'](EVENT, { instanceId: server.id, serverPath: server.serverPath, ...pick(shown) });
}

function internalConflict(kind, port, instance) {
  const message = `${kind === 'management' ? 'Management' : 'Minecraft'} port ${port} is already used by "${instance.name}".`;
  return {
    type: kind,
    scope: 'internal',
    port,
    conflictingInstance: { id: instance.id, name: instance.name, path: instance.serverPath },
    message
  };
}

test('auto-start and RAM are saved while the server and its management server hold their saved ports', async t => {
  const f = fixture(t);
  const [javaw, management] = await holdPorts(t, 2);
  const alpha = f.addServer('server-alpha', 'Alpha', { port: javaw.port, managementPort: management.port });
  // Checked afresh, both saved ports are taken, as the Dashboard reported them.
  const probe = await validateServerPorts({
    instanceId: alpha.id, serverPath: alpha.serverPath, minecraftPort: javaw.port, managementPort: management.port
  });
  assert.deepEqual(probe.errors.map(error => [error.type, error.scope]), [['minecraft', 'external'], ['management', 'external']]);

  const shown = { port: javaw.port, maxRam: 4, managementPort: management.port, autoStartMinecraft: true, autoStartManagement: true };
  for (const change of [{ autoStartMinecraft: false }, { autoStartManagement: false }, { maxRam: 6 }, { autoStartMinecraft: true }]) {
    Object.assign(shown, change);
    const result = await dashboardSave(alpha, shown);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(pick(result.settings), shown);
    assert.deepEqual(alpha.saved(), shown);
  }

  // The same ports sent as text are still the saved ports.
  const textual = await settings['update-settings'](EVENT, {
    instanceId: alpha.id,
    serverPath: alpha.serverPath,
    ...shown,
    port: String(javaw.port),
    managementPort: ` ${management.port} `,
    maxRam: '5'
  });
  assert.equal(textual.success, true, JSON.stringify(textual));
  assert.deepEqual(alpha.saved(), { ...shown, maxRam: 5 });
});

test('changing the management port while the server runs checks only the new port', async t => {
  const f = fixture(t);
  const [javaw, saved, next] = await holdPorts(t, 3);
  // The management server is stopped, and the new port is free.
  await saved.release();
  await next.release();
  const alpha = f.addServer('server-alpha', 'Alpha', { port: javaw.port, managementPort: saved.port });

  const shown = { port: javaw.port, maxRam: 4, managementPort: next.port, autoStartMinecraft: true, autoStartManagement: true };
  const result = await dashboardSave(alpha, shown);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(alpha.saved(), shown);
});

test('changing the Minecraft port while the management server runs checks only the new port', async t => {
  const f = fixture(t);
  const [saved, management, next] = await holdPorts(t, 3);
  // The server is stopped, and the new port is free.
  await saved.release();
  await next.release();
  const alpha = f.addServer('server-alpha', 'Alpha', { port: saved.port, managementPort: management.port });

  const shown = { port: next.port, maxRam: 4, managementPort: management.port, autoStartMinecraft: true, autoStartManagement: true };
  const result = await dashboardSave(alpha, shown);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(alpha.saved(), shown);
});

test('a changed port another process holds is still refused with the same details', async t => {
  const f = fixture(t);
  const [savedPort, savedManagement, taken] = await holdPorts(t, 3);
  // The server and its management server are stopped.
  await savedPort.release();
  await savedManagement.release();
  const alpha = f.addServer('server-alpha', 'Alpha', { port: savedPort.port, managementPort: savedManagement.port });
  const before = fs.readFileSync(alpha.configPath);
  const shown = { port: savedPort.port, maxRam: 4, managementPort: savedManagement.port, autoStartMinecraft: true, autoStartManagement: true };

  for (const [field, kind] of [['port', 'minecraft'], ['managementPort', 'management']]) {
    const request = { ...shown, [field]: taken.port };
    // The check this save made before: both ports the Dashboard sent.
    const expected = await validateServerPorts({
      instanceId: alpha.id, serverPath: alpha.serverPath, minecraftPort: request.port, managementPort: request.managementPort
    });
    assert.deepEqual(expected.errors.map(error => [error.type, error.scope, error.port]), [[kind, 'external', taken.port]]);
    assert.deepEqual(await dashboardSave(alpha, request), { success: false, error: expected.errors[0].message, details: expected.errors });
  }
  assert.deepEqual(fs.readFileSync(alpha.configPath), before, 'nothing was saved');
});

test('while the server runs a taken management port is refused without reporting its own Minecraft port', async t => {
  const f = fixture(t);
  const [javaw, savedManagement, taken] = await holdPorts(t, 3);
  await savedManagement.release();
  const alpha = f.addServer('server-alpha', 'Alpha', { port: javaw.port, managementPort: savedManagement.port });
  const before = fs.readFileSync(alpha.configPath);

  const result = await dashboardSave(alpha, {
    port: javaw.port, maxRam: 4, managementPort: taken.port, autoStartMinecraft: true, autoStartManagement: true
  });
  const expected = await validateServerPorts({ instanceId: alpha.id, serverPath: alpha.serverPath, managementPort: taken.port });
  assert.deepEqual(expected.errors.map(error => [error.type, error.scope, error.port]), [['management', 'external', taken.port]]);
  assert.deepEqual(result, { success: false, error: expected.errors[0].message, details: expected.errors });
  assert.deepEqual(fs.readFileSync(alpha.configPath), before, 'nothing was saved');
});

test('a changed port another registered server saves is still refused', async t => {
  const f = fixture(t);
  const [javaw, savedManagement, betaPort, betaManagement] = await holdPorts(t, 4);
  // Alpha runs with its management server stopped; Beta is stopped.
  await Promise.all([savedManagement, betaPort, betaManagement].map(entry => entry.release()));
  const alpha = f.addServer('server-alpha', 'Alpha', { port: javaw.port, managementPort: savedManagement.port });
  const beta = f.addServer('server-beta', 'Beta', { port: betaPort.port, managementPort: betaManagement.port });
  const before = fs.readFileSync(alpha.configPath);
  const shown = { port: javaw.port, maxRam: 4, managementPort: savedManagement.port, autoStartMinecraft: true, autoStartManagement: true };

  const management = internalConflict('management', betaManagement.port, beta);
  assert.deepEqual(await dashboardSave(alpha, { ...shown, managementPort: betaManagement.port }),
    { success: false, error: management.message, details: [management] });
  // The Minecraft port once the server is stopped (the Dashboard locks it while the server runs).
  await javaw.release();
  const minecraft = internalConflict('minecraft', betaPort.port, beta);
  assert.deepEqual(await dashboardSave(alpha, { ...shown, port: betaPort.port }),
    { success: false, error: minecraft.message, details: [minecraft] });
  assert.deepEqual(fs.readFileSync(alpha.configPath), before, 'nothing was saved');
});

test('a server folder without a saved config checks every port it is given', async t => {
  const f = fixture(t);
  const [port, managementPort] = await holdPorts(t, 2);
  await port.release();
  await managementPort.release();
  // Nothing is saved yet, so the first save claims its ports.
  const fresh = f.addServer('server-fresh', 'Fresh', null);
  const shown = { port: port.port, maxRam: 4, managementPort: managementPort.port, autoStartMinecraft: false, autoStartManagement: false };
  const first = await dashboardSave(fresh, shown);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(fresh.saved(), shown);

  // The default ports such a folder reads back are claimed too, and another server saves them.
  const beta = f.addServer('server-beta', 'Beta', { port: 25565, managementPort: 8080 });
  const unsaved = f.addServer('server-unsaved', 'Unsaved', null);
  const minecraft = internalConflict('minecraft', 25565, beta);
  assert.deepEqual(await dashboardSave(unsaved, { ...shown, port: 25565, managementPort: 8080 }), {
    success: false,
    error: minecraft.message,
    details: [minecraft, internalConflict('management', 8080, beta)]
  });
  assert.equal(fs.existsSync(unsaved.configPath), false, 'nothing was saved');
});

test('a Minecraft port two servers already share does not block settings that leave it unchanged', async t => {
  const f = fixture(t);
  const [shared, alphaManagement, betaManagement] = await holdPorts(t, 3);
  await Promise.all([shared, alphaManagement, betaManagement].map(entry => entry.release()));
  // A copied server folder brings its Minecraft port along; starting either
  // server still checks the port it starts on.
  const alpha = f.addServer('server-alpha', 'Alpha', { port: shared.port, managementPort: alphaManagement.port });
  f.addServer('server-beta', 'Beta', { port: shared.port, managementPort: betaManagement.port });

  const shown = { port: shared.port, maxRam: 4, managementPort: alphaManagement.port, autoStartMinecraft: false, autoStartManagement: true };
  const result = await dashboardSave(alpha, shown);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(alpha.saved(), shown);
});
