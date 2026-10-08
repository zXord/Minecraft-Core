const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  ProperMinecraftLauncher
} = require('../electron/services/minecraft-launcher/proper-launcher.cjs');

const MINECRAFT_VERSION = '1.20.1';
const LOADER_VERSION = '0.15.10';
const FABRIC_PROFILE = `${MINECRAFT_VERSION}-fabric${LOADER_VERSION}`;
const FABRIC_LIBRARY_RELATIVE = path.join(
  'net',
  'fabricmc',
  'fabric-loader',
  LOADER_VERSION,
  `fabric-loader-${LOADER_VERSION}.jar`
);

async function createFabricClientFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-fabric-client-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const baseRoot = path.join(root, 'versions', MINECRAFT_VERSION);
  const fabricRoot = path.join(root, 'versions', FABRIC_PROFILE);
  await fsp.mkdir(baseRoot, { recursive: true });
  await fsp.mkdir(fabricRoot, { recursive: true });
  await fsp.writeFile(path.join(baseRoot, `${MINECRAFT_VERSION}.jar`), 'minecraft-client');
  await fsp.writeFile(path.join(baseRoot, `${MINECRAFT_VERSION}.json`), JSON.stringify({
    id: MINECRAFT_VERSION,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '5' },
    arguments: { jvm: [], game: [] },
    libraries: []
  }));
  await fsp.writeFile(path.join(fabricRoot, `${FABRIC_PROFILE}.json`), JSON.stringify({
    id: FABRIC_PROFILE,
    inheritsFrom: MINECRAFT_VERSION,
    type: 'release',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    arguments: { jvm: [], game: [] },
    libraries: [{
      name: `net.fabricmc:fabric-loader:${LOADER_VERSION}`,
      url: 'https://maven.fabricmc.net/'
    }]
  }));

  return root;
}

function createLiveChild(pid = 8123) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  child.kill = () => true;
  return child;
}

function createLibraryTask(startAndWait, cancel = async () => {}) {
  return {
    progress: 0,
    total: 1,
    startAndWait,
    cancel
  };
}

test('proper launcher reuses the canonical XMCL Fabric profile and prepares its libraries before classpath construction', async t => {
  const clientPath = await createFabricClientFixture(t);
  const loaderJar = path.join(clientPath, 'libraries', FABRIC_LIBRARY_RELATIVE);
  const child = createLiveChild();
  let spawnArgs = null;
  let loaderProfileInstallCalls = 0;

  const launcher = new ProperMinecraftLauncher({
    installClientLoader: async () => {
      loaderProfileInstallCalls += 1;
      throw new Error('The existing canonical Fabric profile must be reused');
    },
    installLibrariesTask: resolvedVersion => createLibraryTask(async () => {
      assert.equal(resolvedVersion.id, FABRIC_PROFILE);
      await fsp.mkdir(path.dirname(loaderJar), { recursive: true });
      await fsp.writeFile(loaderJar, 'fabric-loader');
    }),
    spawn: (_command, args) => {
      spawnArgs = args;
      return child;
    }
  });
  launcher.ensureMinecraftClient = async () => ({ success: true });
  launcher.setAuthData({ name: 'FabricJoiner', uuid: 'uuid', access_token: 'token' });

  const result = await launcher.launchMinecraft({
    clientPath,
    minecraftVersion: MINECRAFT_VERSION,
    loaderType: 'fabric',
    loaderVersion: LOADER_VERSION,
    javaPath: 'javaw.exe'
  });

  assert.equal(result.success, true);
  assert.equal(loaderProfileInstallCalls, 0);
  assert.ok(fs.existsSync(loaderJar));
  const classpathIndex = spawnArgs.indexOf('-cp');
  assert.notEqual(classpathIndex, -1);
  assert.ok(spawnArgs[classpathIndex + 1].split(path.delimiter).includes(loaderJar));
  assert.ok(spawnArgs.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'));

  child.exitCode = 0;
  child.emit('close');
});

test('proper launcher cancels Fabric library preparation and never spawns the JVM', async t => {
  const clientPath = await createFabricClientFixture(t);
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let cancelled = false;
  let spawnCalls = 0;

  const launcher = new ProperMinecraftLauncher({
    installClientLoader: async () => {
      throw new Error('The existing canonical Fabric profile must be reused');
    },
    installLibrariesTask: () => createLibraryTask(
      () => {
        markStarted();
        return new Promise(() => {});
      },
      async () => {
        cancelled = true;
      }
    ),
    spawn: () => {
      spawnCalls += 1;
      throw new Error('JVM must not spawn after cancellation');
    },
    launchPreparationStopTimeoutMs: 1_000
  });
  launcher.ensureMinecraftClient = async () => ({ success: true });
  launcher.setAuthData({ name: 'FabricJoiner', uuid: 'uuid', access_token: 'token' });

  const launchPromise = launcher.launchMinecraft({
    clientPath,
    minecraftVersion: MINECRAFT_VERSION,
    loaderType: 'fabric',
    loaderVersion: LOADER_VERSION,
    javaPath: 'javaw.exe'
  });
  const libraryPreparationStarted = await Promise.race([
    started.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 200))
  ]);
  if (!libraryPreparationStarted) {
    await launchPromise;
    assert.equal(libraryPreparationStarted, true, 'Fabric library preparation never started');
  }
  const stopPromise = launcher.stopMinecraft();
  const [launchResult, stopResult] = await Promise.all([launchPromise, stopPromise]);

  assert.equal(stopResult.success, true);
  assert.equal(launchResult.success, false);
  assert.equal(launchResult.error, 'Minecraft asset preparation was cancelled.');
  assert.equal(cancelled, true);
  assert.equal(spawnCalls, 0);
});
