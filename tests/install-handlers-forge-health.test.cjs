const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const loaderService = require('../electron/services/loader-install-service.cjs');
const { resolveLaunchPlan } = require('../electron/services/server-launcher.cjs');

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

function writeConfig(root, { minecraftVersion, loaderFamily, loaderVersion }) {
  fs.writeFileSync(path.join(root, '.minecraft-core.json'), JSON.stringify({
    version: minecraftVersion,
    loader: loaderFamily,
    loaderVersion,
    maxRam: 4,
    port: 25565
  }));
}

function writeLegacyRuntime(root) {
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
  const library = 'libraries/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar';
  writeJar(path.join(root, ...library.split('/')));
  writeJar(path.join(root, serverJar));
  writeJar(path.join(root, launchJar), [
    'Manifest-Version: 1.0',
    'Main-Class: net.minecraftforge.fml.relauncher.ServerLaunchWrapper',
    `Class-Path: ${library} ${serverJar}`,
    '',
    ''
  ]);
  loaderService.__testUtils.publishForgeRuntimeMetadata(root, runtime);
  writeConfig(root, runtime);
  return { runtime, library };
}

function writeModernRuntime(root) {
  const runtime = {
    minecraftVersion: '1.20.1',
    loaderFamily: 'forge',
    loaderVersion: '47.4.18',
    javaMajor: 17,
    os: 'win32',
    architecture: 'x64'
  };
  const argsFile = 'libraries/net/minecraftforge/forge/1.20.1-47.4.18/win_args.txt';
  const argsPath = path.join(root, ...argsFile.split('/'));
  fs.mkdirSync(path.dirname(argsPath), { recursive: true });
  fs.writeFileSync(argsPath, '--launchTarget forgeserver\n');
  fs.mkdirSync(path.join(root, '.minecraft-core-state'));
  fs.writeFileSync(path.join(root, '.minecraft-core-state', 'runtime.json'), JSON.stringify({
    formatVersion: 1,
    runtime,
    loader: { family: 'forge', argsFile },
    artifacts: [artifact(root, argsFile)]
  }));
  writeConfig(root, runtime);
  return runtime;
}

const V26_FORGE_ARGS = 'libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt';

function writeJson(root, relativePath, value) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

// A Forge 1.20.1 server exactly as v26.6.1's installer left it: no .minecraft-core-state, an args
// file under libraries, the version metadata @xmcl reads, the bundled base jar and the root shim.
function writeV26ForgeLayout(root) {
  writeConfig(root, { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.2.0' });
  writeJar(path.join(root, 'server.jar'));
  fs.writeFileSync(path.join(root, 'user_jvm_args.txt'), '# Xmx and Xms set the maximum and minimum RAM usage.\n');
  const argsPath = path.join(root, ...V26_FORGE_ARGS.split('/'));
  fs.mkdirSync(path.dirname(argsPath), { recursive: true });
  fs.writeFileSync(argsPath, '-DlibraryDirectory=libraries\n--launchTarget forgeserver\n--fml.forgeVersion 47.2.0\n--fml.mcVersion 1.20.1\n');
  writeJar(path.join(path.dirname(argsPath), 'forge-1.20.1-47.2.0-shim.jar'));
  fs.copyFileSync(path.join(path.dirname(argsPath), 'forge-1.20.1-47.2.0-shim.jar'), path.join(root, 'forge-1.20.1-47.2.0-shim.jar'));
  writeJar(path.join(root, 'libraries', 'net', 'minecraft', 'server', '1.20.1', 'server-1.20.1-bundled.jar'));
  writeJson(root, 'versions/1.20.1/1.20.1.json', {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.bundler.Main',
    libraries: []
  });
  const fmlcore = 'net/minecraftforge/fmlcore/1.20.1-47.2.0/fmlcore-1.20.1-47.2.0.jar';
  writeJson(root, 'versions/1.20.1-forge-47.2.0/1.20.1-forge-47.2.0.json', {
    id: '1.20.1-forge-47.2.0',
    inheritsFrom: '1.20.1',
    type: 'release',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [{
      name: 'net.minecraftforge:fmlcore:1.20.1-47.2.0',
      downloads: { artifact: { path: fmlcore, url: '', sha1: '', size: 0 } }
    }]
  });
  writeJar(path.join(root, 'libraries', ...fmlcore.split('/')));
}

async function withInstallHandlers(work) {
  const modulePath = require.resolve('../electron/ipc/install-handlers.cjs');
  const originalLoad = Module._load;
  const calls = { downloads: [], installs: [], javaInspections: [] };
  class FakeServerJavaManager {
    constructor(targetPath) {
      this.targetPath = targetPath;
    }

    async getJavaRequirementsForMinecraft(minecraftVersion) {
      calls.javaInspections.push({ targetPath: this.targetPath, minecraftVersion });
      const requiredJavaVersion = minecraftVersion === '1.12.2' ? 8 : 17;
      return {
        requiredJavaVersion,
        needsDownload: false,
        isAvailable: true,
        javaPath: path.join(this.targetPath, 'java', `java-${requiredJavaVersion}`, 'bin', 'java.exe')
      };
    }
  }
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent?.filename === modulePath && request === '../services/download-manager.cjs') {
      return { downloadMinecraftServer: async (...args) => { calls.downloads.push(args); } };
    }
    if (parent?.filename === modulePath && request === '../services/server-java-manager.cjs') {
      return { ServerJavaManager: FakeServerJavaManager };
    }
    if (parent?.filename === modulePath && request === './logger-handlers.cjs') {
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      return { getLoggerHandlers: () => logger };
    }
    if (parent?.filename === modulePath && request === '../services/loader-install-service.cjs') {
      return {
        ...loaderService,
        installServerLoader: async options => { calls.installs.push(options); return { success: true }; }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const { createInstallHandlers } = require(modulePath);
    const sent = [];
    const handlers = createInstallHandlers({ webContents: { send: (...args) => sent.push(args) } });
    return await work({ calls, handlers, sent });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

const event = { sender: { id: 7 } };

test('managed legacy and modern Forge health trusts only validated runtime metadata', async t => {
  for (const writeRuntime of [writeLegacyRuntime, writeModernRuntime]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-managed-forge-health-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const written = writeRuntime(root);
    const runtime = written.runtime || written;
    await withInstallHandlers(async ({ calls, handlers }) => {
      assert.deepEqual(await handlers['check-health'](event, root), []);
      assert.deepEqual(await handlers['repair-health'](event, {
        targetPath: root,
        mcVersion: runtime.minecraftVersion,
        loader: 'vanilla',
        loaderVersion: 'wrong'
      }), []);
      assert.equal(calls.downloads.length, 0);
      assert.equal(calls.installs.length, 0);
    });
  }
});

test('managed Forge Repair rejects corrupt runtime metadata before any Java or runtime mutation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-managed-forge-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { runtime, library } = writeLegacyRuntime(root);
  fs.writeFileSync(path.join(root, ...library.split('/')), 'corrupt');

  await withInstallHandlers(async ({ calls, handlers }) => {
    await assert.rejects(
      handlers['repair-health'](event, {
        targetPath: root,
        mcVersion: runtime.minecraftVersion,
        loader: 'forge',
        loaderVersion: runtime.loaderVersion
      }),
      error => error.code === 'RUNTIME_INCOMPLETE'
    );
    assert.deepEqual(calls, { downloads: [], installs: [], javaInspections: [] });
  });
});

test('unmanaged Forge health and Repair retain the legacy heuristic repair path', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-unmanaged-forge-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = {
    minecraftVersion: '1.20.1',
    loaderFamily: 'forge',
    loaderVersion: '47.4.18'
  };
  writeConfig(root, runtime);

  await withInstallHandlers(async ({ calls, handlers }) => {
    const missing = await handlers['check-health'](event, root);
    assert.equal(missing.includes('server.jar'), true);
    assert.equal(missing.includes('Forge launch assets'), true);
    const repaired = await handlers['repair-health'](event, {
      targetPath: root,
      mcVersion: runtime.minecraftVersion,
      loader: runtime.loaderFamily,
      loaderVersion: runtime.loaderVersion
    });
    assert.equal(repaired.includes('server.jar'), true);
    assert.equal(repaired.includes('Forge launch assets'), true);
    assert.equal(calls.downloads.length, 1);
    assert.equal(calls.installs.length, 1);
  });
});

test('v26.6.1 Forge health and launch agree: healthy launches by discovery, missing args fail both the same way', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-v26-forge-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeV26ForgeLayout(root);
  // The unmanaged tuple server-manager passes for every start.
  const runtimeTuple = {
    minecraftVersion: '1.20.1',
    loaderFamily: 'forge',
    loaderVersion: '47.2.0',
    javaMajor: 17,
    os: 'win32',
    architecture: 'x64'
  };
  const launchOptions = { loader: 'forge', loaderVersion: '47.2.0', minecraftVersion: '1.20.1', javaMajor: 17, maxRam: 4 };

  await withInstallHandlers(async ({ calls, handlers }) => {
    assert.deepEqual(await handlers['check-health'](event, root), []);
    assert.deepEqual(calls.installs, []);
  });
  const plan = resolveLaunchPlan(root, launchOptions, { runtimeTuple });
  assert.deepEqual(plan.args, [
    '@user_jvm_args.txt',
    '-Xmx4G',
    '-Xms1G',
    `@${path.join(...V26_FORGE_ARGS.split('/'))}`,
    'nogui'
  ]);
  assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state')), false);

  fs.rmSync(path.join(root, ...V26_FORGE_ARGS.split('/')));
  await withInstallHandlers(async ({ handlers }) => {
    assert.deepEqual(await handlers['check-health'](event, root), ['Forge launch assets']);
  });
  assert.throws(
    () => resolveLaunchPlan(root, launchOptions, { runtimeTuple }),
    error => error.code === 'FORGE_LAUNCH_ASSETS_MISSING'
  );
});
