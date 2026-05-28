const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

function fileSignature(stats) {
  return `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}

async function writeExpectedState(clientPath, requiredMods) {
  const stateDir = path.join(clientPath, 'minecraft-core-state');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(
    path.join(stateDir, 'expected-mods.json'),
    JSON.stringify({
      version: 1,
      requiredMods: requiredMods.map((mod) => mod.fileName.toLowerCase()),
      optionalMods: [],
      acknowledgedDeps: []
    }, null, 2)
  );
}

async function withMinecraftHandlers({ utils }, fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-check-mods-'));
  const originalLoad = Module._load;
  const modulePath = path.resolve(__dirname, '../electron/ipc/minecraft-launcher-handlers.cjs');
  const fakeLauncher = new EventEmitter();
  fakeLauncher.getStatus = () => ({
    isAuthenticated: false,
    isLaunching: false,
    isRunning: false,
    username: null,
    clientPath: null
  });

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath() {
            return path.join(root, 'user-data');
          },
          getVersion() {
            return '0.0.0-test';
          },
          setPath() {}
        },
        net: null,
        session: { defaultSession: null }
      };
    }

    if (request === './logger-handlers.cjs' || request.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    }

    if (request === '../services/minecraft-launcher/index.cjs' || request.includes('services/minecraft-launcher/index.cjs')) {
      return { getMinecraftLauncher: () => fakeLauncher };
    }

    if (request === '../services/minecraft-launcher/utils.cjs' || request.includes('services/minecraft-launcher/utils.cjs')) {
      return utils;
    }

    if (request === '../utils/app-store.cjs' || request.includes('app-store.cjs')) {
      return { get: () => undefined, set: () => true };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const { createMinecraftLauncherHandlers } = require(modulePath);
    const win = {
      isDestroyed: () => false,
      webContents: { send() {} }
    };
    return await fn(createMinecraftLauncherHandlers(win), root);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('minecraft-check-mods uses a matching manifest checksum without rehashing the jar', async () => {
  let hashCalls = 0;
  const utils = {
    calculateFileChecksum() {
      hashCalls += 1;
      return 'calculated-md5';
    },
    async calculateFileChecksumAsync() {
      hashCalls += 1;
      return 'calculated-md5';
    }
  };

  await withMinecraftHandlers({ utils }, async (handlers, root) => {
    const clientPath = path.join(root, 'client');
    const modsDir = path.join(clientPath, 'mods');
    const manifestDir = path.join(clientPath, 'minecraft-core-manifests');
    const fileName = 'cached-checksum.jar';
    const expectedChecksum = '0123456789abcdef0123456789abcdef';
    const modPath = path.join(modsDir, fileName);

    await fsp.mkdir(modsDir, { recursive: true });
    await fsp.mkdir(manifestDir, { recursive: true });
    await fsp.writeFile(modPath, Buffer.from('jar bytes'));
    const stats = await fsp.stat(modPath);
    await fsp.writeFile(
      path.join(manifestDir, `${fileName}.json`),
      JSON.stringify({
        fileName,
        name: 'Cached Checksum',
        checksum: expectedChecksum,
        checksumAlgorithm: 'md5',
        fileSignature: fileSignature(stats)
      }, null, 2)
    );

    const requiredMods = [{ fileName, name: 'Cached Checksum', required: true, checksum: expectedChecksum }];
    await writeExpectedState(clientPath, requiredMods);

    const result = await handlers['minecraft-check-mods']({}, {
      clientPath,
      requiredMods,
      allClientMods: requiredMods,
      serverManagedFiles: [fileName]
    });

    assert.equal(result.success, true);
    assert.equal(result.synchronized, true);
    assert.equal(hashCalls, 0);
  });
});
