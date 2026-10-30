const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const AdmZip = require('adm-zip');
const { CompanionService } = require('../electron/services/client-modpacks/companion-service.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');

const MANAGEMENT_SERVER = require.resolve('../electron/services/management-server.cjs');
const MANAGEMENT_HANDLERS = require.resolve('../electron/ipc/management-server-handlers.cjs');
const unpaired = Object.freeze({
  schemaVersion: 1,
  status: 'unpaired',
  serverFingerprint: 'a'.repeat(64),
  serverVersion: '0.13.4',
  source: null,
  runtime: null,
  artifactSha256: null
});
const turn = () => new Promise(resolve => setImmediate(resolve));

function temporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeServer(serverPath, config = { version: '1.20.1', loader: 'fabric', loaderVersion: '0.15.11' }) {
  fs.mkdirSync(serverPath, { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'server.properties'), 'server-port=25575\nmotd=Disposable\n');
  fs.writeFileSync(path.join(serverPath, '.minecraft-core.json'), JSON.stringify(config));
}

function writeJar(filePath, manifestLines = ['Manifest-Version: 1.0', '', '']) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const archive = new AdmZip();
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from(manifestLines.join('\r\n'), 'utf8'));
  archive.addFile('fixture.class', Buffer.from('fixture'));
  archive.writeZip(filePath);
}

function artifact(root, relativePath) {
  const bytes = fs.readFileSync(path.join(root, ...relativePath.split('/')));
  return {
    relativePath,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(bytes).digest('hex')
  };
}

// A legacy Forge runtime recorded by a modpack install (.minecraft-core-state/runtime.json).
function writePreparedLegacyForgeRuntime(serverPath) {
  const runtime = {
    minecraftVersion: '1.12.2',
    loaderFamily: 'forge',
    loaderVersion: '14.23.5.2860',
    javaMajor: 8,
    os: 'win32',
    architecture: 'x64'
  };
  const launchJar = 'forge-1.12.2-14.23.5.2860.jar';
  const serverJar = 'minecraft_server.1.12.2.jar';
  const libraries = ['libraries/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar'];
  writeJar(path.join(serverPath, ...libraries[0].split('/')));
  writeJar(path.join(serverPath, serverJar));
  writeJar(path.join(serverPath, launchJar), [
    'Manifest-Version: 1.0',
    'Main-Class: net.minecraftforge.fml.relauncher.ServerLaunchWrapper',
    `Class-Path: ${libraries[0]} ${serverJar}`,
    '',
    ''
  ]);
  fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'runtime.json'), JSON.stringify({
    formatVersion: 1,
    runtime,
    loader: { family: 'forge', launchJar, serverJar, libraries },
    artifacts: [launchJar, serverJar, ...libraries].map(relativePath => artifact(serverPath, relativePath))
  }));
  return { serverJar };
}

function createJunction(target, link) {
  try {
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code)) return false;
    throw error;
  }
}

// The real management server module with stubbed electron, logger and app store. The
// registered instances are the live `instances` array, so a test can register later.
function loadManagementServer(t, { root, instances }) {
  const original = Module._load;
  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getVersion: () => 'test', getPath: () => root, setPath() {} },
        safeStorage: { isEncryptionAvailable: () => false }
      };
    }
    if (request.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    }
    if (request.endsWith('/utils/app-store.cjs')) {
      return {
        get: key => (key === 'instances' ? instances : undefined),
        set() { throw new Error('Server information never writes the registry'); }
      };
    }
    return original(request, parent, isMain);
  };
  delete require.cache[MANAGEMENT_SERVER];
  t.after(() => {
    Module._load = original;
    delete require.cache[MANAGEMENT_SERVER];
  });
  return require(MANAGEMENT_SERVER);
}

function infoRoute(server) {
  return server.app._router.stack.find(layer => layer.route?.path === '/api/server/info').route.stack[0].handle;
}

function startInfo(server) {
  const reply = { status: 200, body: undefined };
  const response = {
    status(code) { reply.status = code; return this; },
    json(value) { reply.body = value; }
  };
  reply.done = infoRoute(server)({}, response);
  return reply;
}

async function readInfo(server) {
  const reply = startInfo(server);
  await reply.done;
  return reply;
}

// The Minecraft process scan is not part of these checks.
function withoutProcessScan(server) {
  server.checkMinecraftServerStatus = async () => 'stopped';
  return server;
}

// The production companion resolver (ipc-handlers.cjs) over the production resolveServer
// rule (create-client-pack-composition.cjs). getStatus reaches none of the pack
// collaborators for a server without modpack state, so they all refuse.
function productionCompanionResolver(instances, calls = []) {
  const refuse = async () => { throw new Error('Not reached for a server without modpack state'); };
  const resolveServer = async serverId => {
    const matches = instances.filter(instance => instance?.id === serverId && instance.type === 'server' &&
      typeof instance.path === 'string' && path.isAbsolute(instance.path));
    if (matches.length !== 1) throw new ModpackError('INVALID_REQUEST', 'Choose a registered server instance');
    return { instanceId: serverId, serverPath: path.resolve(matches[0].path) };
  };
  const companionService = new CompanionService({
    store: { get: refuse, put: refuse },
    resolveServer,
    readServerState: refuse,
    coordinator: { runMutation: refuse },
    providers: { github: { getRepositoryIdentity: refuse, listUploadedAssets: refuse } },
    sourceResolver: { resolveArtifactSetPlan: refuse },
    artifactAcquisition: { downloadSet: refuse },
    archiveInspector: { inspectArchive: refuse, materializer: { workspaceRegistry: { releaseOwner: refuse } } },
    clientCandidatePreparer: { inspect: refuse, forgetInspection: refuse }
  });
  return serverId => {
    calls.push(serverId);
    return companionService.getStatus({ serverId });
  };
}

test('a junction-registered unmanaged server answers 200 with exactly {clientModpack:null} (A31)', async t => {
  const root = temporaryRoot(t, 'management-server-info-junction-');
  const realParent = path.join(root, 'real');
  const serverPath = path.join(realParent, 'srv');
  writeServer(serverPath);
  fs.mkdirSync(path.join(serverPath, 'client', 'mods'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'client', 'mods', 'friend-mod.jar'), 'client mod bytes');
  if (!createJunction(realParent, path.join(root, 'jparent')) || !createJunction(serverPath, path.join(root, 'jsrv'))) {
    t.skip('directory junctions are unavailable');
    return;
  }
  const instances = [
    { id: 'server-junction-parent', type: 'server', path: path.join(root, 'jparent', 'srv') },
    { id: 'server-junction-leaf', type: 'server', path: path.join(root, 'jsrv') }
  ];
  const management = loadManagementServer(t, { root, instances });
  management.configureClientModpackResolver(productionCompanionResolver(instances));

  for (const instance of instances) {
    const server = withoutProcessScan(management.getManagementServer({ instanceId: instance.id, serverPath: instance.path }));
    const { status, body } = await readInfo(server);
    assert.equal(status, 200, instance.path);
    assert.equal(body.success, true);
    assert.equal(body.clientModpack, null);
    assert.equal(Object.hasOwn(body, 'clientModpackError'), false, 'no requirement error for an unmanaged server');
    assert.equal(Object.hasOwn(body, 'runtimeIncomplete'), false);
    assert.equal(body.instanceId, instance.id);
    assert.equal(body.minecraftVersion, '1.20.1');
    assert.equal(body.loaderType, 'fabric');
    assert.equal(body.loaderVersion, '0.15.11');
    assert.equal(body.minecraftPort, '25575');
    assert.deepEqual(body.requiredMods.map(mod => mod.fileName), ['friend-mod.jar']);
  }
});

test('a managed server with drifted runtime metadata answers 200 with runtimeIncomplete instead of 500 (A57b)', async t => {
  const root = temporaryRoot(t, 'management-server-info-drift-');
  const serverPath = path.join(root, 'srv');
  writeServer(serverPath, { version: '1.12.2', loader: 'forge', loaderVersion: '14.23.5.2860' });
  const { serverJar } = writePreparedLegacyForgeRuntime(serverPath);
  const instances = [{ id: 'server-managed', type: 'server', path: serverPath }];
  const management = loadManagementServer(t, { root, instances });
  const calls = [];
  management.configureClientModpackResolver(async serverId => {
    calls.push(serverId);
    return unpaired;
  });
  const server = withoutProcessScan(management.getManagementServer({ instanceId: 'server-managed', serverPath }));

  const intact = await readInfo(server);
  assert.equal(intact.status, 200);
  assert.equal(intact.body.loaderType, 'forge');
  assert.equal(intact.body.loaderVersion, '14.23.5.2860');
  assert.equal(Object.hasOwn(intact.body, 'runtimeIncomplete'), false);

  // An older version's Repair rewrote a recorded runtime file.
  fs.writeFileSync(path.join(serverPath, serverJar), 'replaced by an older Repair');
  const drifted = await readInfo(server);
  assert.equal(drifted.status, 200, JSON.stringify(drifted.body));
  assert.equal(drifted.body.success, true);
  assert.equal(drifted.body.runtimeIncomplete, true);
  assert.equal(drifted.body.loaderType, 'forge');
  assert.equal(drifted.body.loaderVersion, '14.23.5.2860');
  assert.equal(drifted.body.minecraftVersion, '1.12.2');
  assert.equal(drifted.body.minecraftPort, '25575');
  assert.deepEqual(drifted.body.clientModpack, unpaired);
  assert.deepEqual(calls, ['server-managed', 'server-managed']);

  // The version watcher describes the same loader instead of falling back to vanilla.
  assert.deepEqual(await server.detectServerVersions(), {
    minecraftVersion: '1.12.2',
    loaderType: 'forge',
    loaderVersion: '14.23.5.2860'
  });
});

test('a hanging requirement resolver still lets server information answer once the 3 s budget passes (A38)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = temporaryRoot(t, 'management-server-info-hanging-');
  const serverPath = path.join(root, 'srv');
  writeServer(serverPath);
  const instances = [{ id: 'server-a', type: 'server', path: serverPath }];
  const management = loadManagementServer(t, { root, instances });
  management.configureClientModpackResolver(() => new Promise(() => {}));
  const server = withoutProcessScan(management.getManagementServer({ instanceId: 'server-a', serverPath }));

  const reply = startInfo(server);
  await turn();
  t.mock.timers.tick(2999);
  await turn();
  assert.equal(reply.body, undefined, 'the requirement budget is 3 s');
  t.mock.timers.tick(1);
  await reply.done;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.success, true);
  assert.equal(reply.body.clientModpack, null);
  assert.equal(reply.body.clientModpackError.code, 'CLIENT_PACK_UNAVAILABLE');
  assert.equal(reply.body.minecraftVersion, '1.20.1');
  assert.equal(reply.body.loaderType, 'fabric');
});

test('the requirement starts before the legacy work and its 3 s budget starts after it (A38)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = temporaryRoot(t, 'management-server-info-budget-');
  const serverPath = path.join(root, 'srv');
  writeServer(serverPath);
  const instances = [{ id: 'server-a', type: 'server', path: serverPath }];
  const management = loadManagementServer(t, { root, instances });
  const order = [];
  // A warm managed resolver still needs one event-loop turn, as a cached health check does.
  management.configureClientModpackResolver(serverId => {
    order.push(`requirement:${serverId}`);
    return new Promise(resolve => setImmediate(() => resolve(unpaired)));
  });
  const server = withoutProcessScan(management.getManagementServer({ instanceId: 'server-a', serverPath }));
  const getRequiredMods = server.getRequiredMods.bind(server);
  server.getRequiredMods = async (...args) => {
    order.push('legacy');
    // More than 3 s of synchronous checksum work for a large client mod list.
    t.mock.timers.tick(3100);
    return getRequiredMods(...args);
  };

  const { status, body } = await readInfo(server);
  assert.deepEqual(order, ['requirement:server-a', 'legacy'], 'the requirement overlaps the legacy work');
  assert.equal(status, 200);
  assert.deepEqual(body.clientModpack, unpaired);
  assert.equal(Object.hasOwn(body, 'clientModpackError'), false);
});

test('a management server keyed by its folder answers from the folder: null without modpack state, unavailable with it (A31)', async t => {
  const root = temporaryRoot(t, 'management-server-info-folder-key-');
  const serverPath = path.join(root, 'srv');
  writeServer(serverPath);
  const instances = [];
  const management = loadManagementServer(t, { root, instances });
  const calls = [];
  management.configureClientModpackResolver(productionCompanionResolver(instances, calls));
  const server = withoutProcessScan(management.getManagementServer({ serverPath }));
  assert.equal(server.instanceId, serverPath, 'no registered server matched, so the folder keys the management server');

  const unmanaged = await readInfo(server);
  assert.equal(unmanaged.status, 200);
  assert.equal(unmanaged.body.clientModpack, null);
  assert.equal(Object.hasOwn(unmanaged.body, 'clientModpackError'), false, JSON.stringify(unmanaged.body.clientModpackError));
  assert.equal(unmanaged.body.loaderType, 'fabric');

  // A recorded runtime alone is not modpack state.
  fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'));
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'runtime.json'), '{}');
  const runtimeOnly = await readInfo(server);
  assert.equal(runtimeOnly.status, 200);
  assert.equal(runtimeOnly.body.clientModpack, null);
  assert.equal(Object.hasOwn(runtimeOnly.body, 'clientModpackError'), false);
  assert.equal(runtimeOnly.body.runtimeIncomplete, true);

  // Modpack state the folder key cannot resolve stays unavailable (fail closed).
  fs.rmSync(path.join(serverPath, '.minecraft-core-state', 'runtime.json'));
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{}');
  const managed = await readInfo(server);
  assert.equal(managed.status, 200);
  assert.equal(managed.body.clientModpack, null);
  assert.equal(managed.body.clientModpackError.code, 'CLIENT_PACK_UNAVAILABLE');
  assert.deepEqual(calls, [], 'a folder key never reaches the companion');

  // Once the folder is registered, under any spelling, its registered id is asked.
  fs.rmSync(path.join(serverPath, '.minecraft-core-state'), { recursive: true });
  instances.push({ id: 'server-registered-later', type: 'server', path: `${serverPath.toUpperCase()}${path.sep}` });
  const registered = await readInfo(server);
  assert.equal(registered.status, 200);
  assert.equal(registered.body.clientModpack, null);
  assert.equal(Object.hasOwn(registered.body, 'clientModpackError'), false);
  assert.deepEqual(calls, ['server-registered-later']);
});

test('management servers find their registered server by folder: letter case and trailing separators ignored, exact spelling first', t => {
  const root = temporaryRoot(t, 'management-server-info-match-');
  const serverPath = path.join(root, 'Srv');
  const duplicatePath = path.join(root, 'Duplicate');
  const otherPath = path.join(root, 'Other');
  const instances = [
    { id: 'client-same-folder', type: 'client', path: serverPath.toUpperCase() },
    { id: 'server-one', type: 'server', path: serverPath },
    { id: 'server-duplicate-respelled', type: 'server', path: duplicatePath.toLowerCase() },
    { id: 'server-duplicate-exact', type: 'server', path: duplicatePath }
  ];
  const management = loadManagementServer(t, { root, instances });

  const byExactSpelling = management.getManagementServer({ serverPath });
  assert.equal(byExactSpelling.instanceId, 'server-one');
  assert.equal(management.getManagementServer({ serverPath: serverPath.toUpperCase() }), byExactSpelling);
  assert.equal(management.getManagementServer({ serverPath: `${serverPath}${path.sep}` }), byExactSpelling);
  assert.equal(management.getManagementServer({ serverPath: `${serverPath.toLowerCase()}${path.sep}${path.sep}` }), byExactSpelling);
  assert.equal(management.getManagementServer({ serverPath: duplicatePath }).instanceId, 'server-duplicate-exact',
    'an exact spelling still picks its own registration, as v26.6.1 did');
  assert.equal(management.getManagementServer({ instanceId: 'server-explicit', serverPath }).instanceId, 'server-explicit');
  assert.equal(management.getManagementServer({ serverPath: otherPath }).instanceId, otherPath);
});

test('management IPC handlers find and update the registered server under another spelling of its folder', async t => {
  const root = temporaryRoot(t, 'management-server-info-handlers-');
  const serverPath = path.join(root, 'Srv');
  const respelled = `${serverPath.toUpperCase()}${path.sep}`;
  const appState = {
    instances: [
      { id: 'server-other', type: 'server', path: path.join(root, 'Other') },
      { id: 'server-one', type: 'server', path: serverPath, managementInviteSecret: 'enc:fixture-secret' }
    ]
  };
  const selectors = [];
  const live = {
    publicHost: '',
    useHttps: true,
    externalHost: null,
    async refreshPublicHostIfStale() {},
    detectExternalIP: () => '127.0.0.1',
    getStatus: () => ({ port: 8080 }),
    setInviteSecret() {},
    setExternalHost(value) { this.externalHost = value; },
    getModDownloadHost() { return this.externalHost || '127.0.0.1'; }
  };
  const configWrites = [];
  const original = Module._load;
  Module._load = function loadHandlerStubs(request, parent, isMain) {
    if (request.endsWith('/utils/app-store.cjs')) {
      return { get: key => appState[key], set(key, value) { appState[key] = value; } };
    }
    if (request.endsWith('/utils/secure-store.cjs')) {
      return {
        ensureEncryptionAvailable() {},
        packSecret: value => `enc:${value}`,
        unpackSecret: value => String(value).replace(/^enc:/, '')
      };
    }
    if (request.endsWith('/services/management-server.cjs')) {
      return { getManagementServer: selector => { selectors.push(selector); return live; } };
    }
    if (request.endsWith('/utils/tls-utils.cjs')) return { getExistingManagementTlsConfig: () => null };
    if (request.endsWith('/utils/port-validator.cjs')) return { validateServerPorts: async () => ({ valid: true, errors: [] }) };
    if (request.endsWith('/utils/config-manager.cjs')) {
      return {
        getDefaultServerConfig: overrides => ({ ...overrides }),
        readServerConfig: () => null,
        updateServerConfig: (targetPath, updates) => { configWrites.push({ targetPath, updates }); return updates; }
      };
    }
    return original(request, parent, isMain);
  };
  delete require.cache[MANAGEMENT_HANDLERS];
  t.after(() => {
    Module._load = original;
    delete require.cache[MANAGEMENT_HANDLERS];
  });
  const handlers = require(MANAGEMENT_HANDLERS).createManagementServerHandlers(null);

  const invite = await handlers['get-management-invite-info'](null, { serverPath: respelled, port: 8080 });
  assert.equal(invite.success, true, invite.error);
  assert.equal(invite.secret, 'fixture-secret');
  assert.equal(selectors.length > 0, true);
  assert.deepEqual(selectors.map(selector => selector.instanceId), selectors.map(() => 'server-one'));

  const saved = await handlers['set-management-invite-host'](null, { serverPath: respelled, host: ' play.example ' });
  assert.equal(saved.success, true, saved.error);
  assert.equal(appState.instances[1].managementInviteHost, 'play.example');
  assert.equal(Object.hasOwn(appState.instances[0], 'managementInviteHost'), false, 'another server is never touched');
  assert.deepEqual(configWrites, [{ targetPath: respelled, updates: { managementInviteHost: 'play.example' } }]);
});
