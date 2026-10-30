const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

// A57(b): the server mod handlers read the loader only to query the mod provider. On a server whose
// app-recorded runtime drifted (for example after v26.6.1's Repair or Version Updater rewrote a
// recorded runtime file), those reads describe the loader from .minecraft-core.json instead of
// throwing RUNTIME_INCOMPLETE. The real server-loader and loader-install-service validate a real
// folder; only the mod inventory, the provider and the mod installer are faked.

const handlersPath = require.resolve('../electron/ipc/mod-handlers/server-mod-handlers.cjs');
const serverLoaderPath = require.resolve('../electron/utils/server-loader.cjs');

const RUNTIME = {
  minecraftVersion: '1.20.1',
  loaderFamily: 'forge',
  loaderVersion: '47.4.18',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
};
const ARGS_FILE = 'libraries/net/minecraftforge/forge/1.20.1-47.4.18/win_args.txt';
const MC_VERSION = RUNTIME.minecraftVersion;

function artifact(root, relativePath) {
  const bytes = fs.readFileSync(path.join(root, ...relativePath.split('/')));
  return {
    relativePath,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(bytes).digest('hex')
  };
}

// A Forge server with an app-recorded runtime (as modpack installs write it) that was valid when
// written, and one enabled and one disabled server mod.
function writeRecordedForgeServer(root) {
  const argsPath = path.join(root, ...ARGS_FILE.split('/'));
  fs.mkdirSync(path.dirname(argsPath), { recursive: true });
  fs.writeFileSync(argsPath, '--launchTarget forgeserver\n--fml.forgeVersion 47.4.18\n');
  fs.mkdirSync(path.join(root, '.minecraft-core-state'));
  fs.writeFileSync(path.join(root, '.minecraft-core-state', 'runtime.json'), JSON.stringify({
    formatVersion: 1,
    runtime: RUNTIME,
    loader: { family: 'forge', argsFile: ARGS_FILE },
    artifacts: [artifact(root, ARGS_FILE)]
  }));
  fs.writeFileSync(path.join(root, '.minecraft-core.json'), JSON.stringify({
    version: MC_VERSION,
    loader: 'forge',
    loaderVersion: '47.4.18',
    maxRam: 4,
    port: 25565
  }));
  fs.mkdirSync(path.join(root, 'mods'));
  fs.writeFileSync(path.join(root, 'mods', 'alpha-1.0.0.jar'), 'alpha');
  fs.writeFileSync(path.join(root, 'mods', 'beta-1.0.0.jar.disabled'), 'beta');
}

// Another installer rewrote a recorded runtime file after the record was written.
function driftRecordedRuntime(root) {
  fs.appendFileSync(path.join(root, ...ARGS_FILE.split('/')), '--fml.forgeVersion 47.4.0\n');
}

function makeServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-server-mod-loader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRecordedForgeServer(root);
  return root;
}

async function withServerModHandlers(work) {
  const originalLoad = Module._load;
  const calls = { versions: [], versionInfo: [], installs: [], disabledSaves: [] };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
  const installed = [
    { fileName: 'alpha-1.0.0.jar', name: 'Alpha', projectId: 'alpha', versionNumber: '1.0.0' },
    { fileName: 'beta-1.0.0.jar', name: 'Beta', projectId: 'beta', versionNumber: '1.0.0' }
  ];
  const modApiService = {
    getModrinthDownloadUrl() {},
    getCurseForgeDownloadUrl() {},
    clearVersionCache() {},
    async getModrinthVersions(...args) {
      calls.versions.push(args);
      return [{ id: `${args[0]}-v2`, versionNumber: '2.0.0', gameVersions: [MC_VERSION], dependencies: [] }];
    },
    async getModrinthVersionInfo(...args) {
      calls.versionInfo.push(args);
      return {
        name: `${args[0]} 2.0.0`,
        files: [{ filename: `${args[0]}-2.0.0.jar`, url: `https://cdn.modrinth.com/data/${args[0]}/${args[0]}-2.0.0.jar` }]
      };
    },
    async getModrinthProjectInfo(projectId) {
      return { title: projectId };
    }
  };
  const stubs = new Map([
    ['../../services/mod-api-service.cjs', modApiService],
    ['../mod-utils/mod-file-manager.cjs', {
      async getInstalledModInfo() { return installed; },
      async getDisabledMods() { return ['beta-1.0.0.jar']; },
      async moveModFile() { return { success: true }; },
      async saveDisabledMods(serverPath, disabledMods) { calls.disabledSaves.push(disabledMods); return true; }
    }],
    ['../mod-utils/mod-installation-service.cjs', {
      async installModToServer(_win, serverPath, modDetails) {
        calls.installs.push({ serverPath, modDetails });
        return { success: true };
      }
    }],
    ['../../services/download-manager.cjs', { downloadWithProgress() {} }],
    ['../../utils/app-store.cjs', { get: () => null, set: () => true }],
    ['../error-monitoring-handlers.cjs', { serverErrorMonitor: {} }],
    ['../../services/server-mutation-context.cjs', { markCurrentServerMutationDirty() {} }]
  ]);
  Module._load = function loadServerModLoaderFixture(request, parent, isMain) {
    if (typeof request === 'string' && request.endsWith('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => logger };
    }
    if (parent?.filename === handlersPath && stubs.has(request)) return stubs.get(request);
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[handlersPath];
  try {
    const { createServerModHandlers } = require(handlersPath);
    const serverLoader = require(serverLoaderPath);
    const win = { isDestroyed: () => false, webContents: { send() {} } };
    return await work({ calls, handlers: createServerModHandlers(win), serverLoader });
  } finally {
    delete require.cache[handlersPath];
    Module._load = originalLoad;
  }
}

const event = { sender: { id: 3 } };

test('the strict resolver still rejects the drifted runtime that the mod handlers describe', async t => {
  const root = makeServer(t);
  await withServerModHandlers(async ({ serverLoader }) => {
    assert.equal(serverLoader.resolveServerLoader(root).source, 'runtime-metadata');
    driftRecordedRuntime(root);
    assert.throws(() => serverLoader.resolveServerLoader(root), error => error.code === 'RUNTIME_INCOMPLETE');
    const described = serverLoader.describeServerLoader(root);
    assert.deepEqual(
      [described.loader, described.loaderVersion, described.runtimeIncomplete],
      ['forge', '47.4.18', true]
    );
  });
});

test('check-mod-compatibility on a drifted runtime queries the provider with the configured loader', async t => {
  const root = makeServer(t);
  driftRecordedRuntime(root);
  await withServerModHandlers(async ({ calls, handlers }) => {
    const results = await handlers['check-mod-compatibility'](event, { serverPath: root, mcVersion: MC_VERSION });

    assert.deepEqual(results.map(result => [result.fileName, result.compatible, result.hasUpdate]), [
      ['alpha-1.0.0.jar', true, true]
    ]);
    assert.deepEqual(calls.versions, [
      ['alpha', 'forge', MC_VERSION, false],
      ['alpha', 'forge', MC_VERSION, true]
    ]);
  });
});

test('check-disabled-mod-updates on a drifted runtime lists updates with the configured loader', async t => {
  const root = makeServer(t);
  driftRecordedRuntime(root);
  await withServerModHandlers(async ({ calls, handlers }) => {
    const results = await handlers['check-disabled-mod-updates'](event, { serverPath: root, mcVersion: MC_VERSION });

    assert.deepEqual(results.map(result => [result.fileName, result.hasUpdate, result.latestVersion]), [
      ['beta-1.0.0.jar', true, '2.0.0']
    ]);
    assert.deepEqual(calls.versions, [
      ['beta', 'forge', MC_VERSION, false],
      ['beta', 'forge', MC_VERSION, true]
    ]);
  });
});

test('update-mod on a drifted runtime resolves the target build with the configured loader', async t => {
  const root = makeServer(t);
  driftRecordedRuntime(root);
  await withServerModHandlers(async ({ calls, handlers }) => {
    const result = await handlers['update-mod'](event, {
      serverPath: root,
      projectId: 'alpha',
      targetVersion: '2.0.0',
      fileName: 'alpha-1.0.0.jar',
      mcVersion: MC_VERSION
    });

    assert.equal(result.success, true);
    assert.equal(result.newFileName, 'alpha-2.0.0.jar');
    assert.deepEqual(calls.versions, [['alpha', 'forge', MC_VERSION, false]]);
    assert.deepEqual(calls.versionInfo, [['alpha', 'alpha-v2', MC_VERSION, 'forge']]);
    assert.equal(calls.installs.length, 1);
  });
});

test('enable-and-update-mod on a drifted runtime resolves the target build with the configured loader', async t => {
  const root = makeServer(t);
  driftRecordedRuntime(root);
  await withServerModHandlers(async ({ calls, handlers }) => {
    const result = await handlers['enable-and-update-mod'](event, {
      serverPath: root,
      modFileName: 'beta-1.0.0.jar',
      projectId: 'beta',
      targetVersion: '2.0.0',
      targetVersionId: 'beta-v2',
      mcVersion: MC_VERSION
    });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(calls.versionInfo, [['beta', 'beta-v2', MC_VERSION, 'forge']]);
    assert.equal(calls.installs.length, 1);
    assert.deepEqual(calls.disabledSaves, [[]]);
  });
});
