const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.on('error', reject);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function createFakeHttpsGet(onRequest) {
  return function fakeHttpsGet(url) {
    const requestUrl = typeof url === 'string'
      ? url
      : (url && typeof url.href === 'string' ? url.href : String(url));
    onRequest(requestUrl);

    const request = new EventEmitter();
    request.end = () => {};
    request.abort = () => {};
    request.setTimeout = () => {};

    process.nextTick(() => {
      request.emit('error', new Error('external API should not be used in this test'));
    });

    return request;
  };
}

async function withMinecraftHandlers({ appStoreData, utils }, fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-download-no-fallback-'));
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
      return {
        get: (key) => appStoreData[key],
        set: (key, value) => {
          appStoreData[key] = value;
          return true;
        }
      };
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

test('server download mode does not fall back to Modrinth when server downloads fail', async () => {
  const server = http.createServer((_, res) => {
    res.statusCode = 429;
    res.end('Too many requests');
  });
  const port = await listen(server);
  const originalHttpsGet = https.get;
  const externalRequests = [];
  https.get = createFakeHttpsGet((url) => externalRequests.push(url));

  try {
    const appStoreData = { instanceConfigs: {} };
    const utils = {
      calculateFileChecksum() {
        return 'unused';
      },
      async calculateFileChecksumAsync() {
        return 'unused';
      }
    };

    await withMinecraftHandlers({ appStoreData, utils }, async (handlers, root) => {
      const clientPath = path.join(root, 'client');
      await fsp.mkdir(path.join(clientPath, 'mods'), { recursive: true });
      appStoreData.instances = [{ id: 'client-test', type: 'client', path: clientPath }];
      appStoreData.instanceConfigs[clientPath] = {
        downloadPreferences: {
          primarySource: 'server',
          fallbackSource: 'modrinth'
        }
      };

      const result = await handlers['minecraft-download-mods']({}, {
        clientPath,
        requiredMods: [
          {
            fileName: 'server-only-test.jar',
            name: 'Server Only Test',
            required: true,
            downloadUrl: `http://127.0.0.1:${port}/api/mods/download/server-only-test.jar`,
            projectId: 'server-only-project'
          }
        ],
        allClientMods: [],
        serverInfo: {
          serverIp: '127.0.0.1',
          serverPort: String(port),
          serverProtocol: 'http',
          minecraftVersion: '1.20.1',
          loaderType: 'forge'
        }
      });

      assert.equal(result.success, false);
      assert.equal(result.attemptedSource, 'server');
      assert.equal(result.fallbackAvailable, true);
      assert.equal(result.fallbackSource, 'modrinth');
      assert.equal(fs.existsSync(path.join(clientPath, 'mods', 'server-only-test.jar')), false);
      assert.deepEqual(externalRequests, []);
    });
  } finally {
    https.get = originalHttpsGet;
    await close(server);
  }
});

test('explicit Modrinth retry is the only path that contacts Modrinth after server download failure', async () => {
  const server = http.createServer((_, res) => {
    res.statusCode = 429;
    res.end('Too many requests');
  });
  const port = await listen(server);
  const originalHttpsGet = https.get;
  const externalRequests = [];
  https.get = createFakeHttpsGet((url) => externalRequests.push(url));

  try {
    const appStoreData = { instanceConfigs: {} };
    const utils = {
      calculateFileChecksum() {
        return 'unused';
      },
      async calculateFileChecksumAsync() {
        return 'unused';
      }
    };

    await withMinecraftHandlers({ appStoreData, utils }, async (handlers, root) => {
      const clientPath = path.join(root, 'client');
      await fsp.mkdir(path.join(clientPath, 'mods'), { recursive: true });
      appStoreData.instances = [{ id: 'client-test', type: 'client', path: clientPath }];
      appStoreData.instanceConfigs[clientPath] = {
        downloadPreferences: {
          primarySource: 'server',
          fallbackSource: 'modrinth'
        }
      };

      const result = await handlers['minecraft-download-mods']({}, {
        clientPath,
        requiredMods: [
          {
            fileName: 'manual-modrinth-retry.jar',
            name: 'Manual Modrinth Retry',
            required: true,
            downloadUrl: `http://127.0.0.1:${port}/api/mods/download/manual-modrinth-retry.jar`,
            projectId: 'manual-modrinth-project'
          }
        ],
        allClientMods: [],
        serverInfo: {
          serverIp: '127.0.0.1',
          serverPort: String(port),
          serverProtocol: 'http',
          minecraftVersion: '1.20.1',
          loaderType: 'forge'
        },
        downloadSourceOverride: 'modrinth'
      });

      assert.equal(result.success, false);
      assert.equal(result.attemptedSource, 'modrinth');
      assert.equal(result.sourceSelectionMode, 'explicit');
      assert.equal(externalRequests.length, 1);
      assert.match(externalRequests[0], /api\.modrinth\.com\/v2\/project\/manual-modrinth-project\/version/);
    });
  } finally {
    https.get = originalHttpsGet;
    await close(server);
  }
});

test('Modrinth download mode does not fall back to server when Modrinth fails', async () => {
  let serverRequests = 0;
  const server = http.createServer((_, res) => {
    serverRequests += 1;
    res.statusCode = 200;
    res.end('server fallback should not be automatic');
  });
  const port = await listen(server);
  const originalHttpsGet = https.get;
  const externalRequests = [];
  https.get = createFakeHttpsGet((url) => externalRequests.push(url));

  try {
    const appStoreData = { instanceConfigs: {} };
    const utils = {
      calculateFileChecksum() {
        return 'unused';
      },
      async calculateFileChecksumAsync() {
        return 'unused';
      }
    };

    await withMinecraftHandlers({ appStoreData, utils }, async (handlers, root) => {
      const clientPath = path.join(root, 'client');
      await fsp.mkdir(path.join(clientPath, 'mods'), { recursive: true });
      appStoreData.instances = [{ id: 'client-test', type: 'client', path: clientPath }];
      appStoreData.instanceConfigs[clientPath] = {
        downloadPreferences: {
          primarySource: 'modrinth',
          fallbackSource: 'server'
        }
      };

      const result = await handlers['minecraft-download-mods']({}, {
        clientPath,
        requiredMods: [
          {
            fileName: 'modrinth-first-test.jar',
            name: 'Modrinth First Test',
            required: true,
            downloadUrl: `http://127.0.0.1:${port}/api/mods/download/modrinth-first-test.jar`,
            projectId: 'modrinth-first-project'
          }
        ],
        allClientMods: [],
        serverInfo: {
          serverIp: '127.0.0.1',
          serverPort: String(port),
          serverProtocol: 'http',
          minecraftVersion: '1.20.1',
          loaderType: 'forge'
        }
      });

      assert.equal(result.success, false);
      assert.equal(result.attemptedSource, 'modrinth');
      assert.equal(result.fallbackAvailable, true);
      assert.equal(result.fallbackSource, 'server');
      assert.equal(serverRequests, 0);
      assert.equal(externalRequests.length, 1);
      assert.equal(fs.existsSync(path.join(clientPath, 'mods', 'modrinth-first-test.jar')), false);
    });
  } finally {
    https.get = originalHttpsGet;
    await close(server);
  }
});
