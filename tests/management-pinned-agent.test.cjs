const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function withTlsUtils(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-pinned-agent-'));
  const tlsUtilsPath = path.resolve(__dirname, '../electron/utils/tls-utils.cjs');
  const configManagerPath = path.resolve(__dirname, '../electron/utils/config-manager.cjs');
  const secureStorePath = path.resolve(__dirname, '../electron/utils/secure-store.cjs');
  const originalLoad = Module._load;
  const store = {};

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
        safeStorage: {
          isEncryptionAvailable() {
            return false;
          }
        }
      };
    }

    if (request === './app-store.cjs' || request.endsWith('/utils/app-store.cjs')) {
      return {
        get: (key) => store[key],
        set: (key, value) => {
          store[key] = value;
          return true;
        }
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[tlsUtilsPath];
  delete require.cache[configManagerPath];
  delete require.cache[secureStorePath];

  try {
    const tlsUtils = require(tlsUtilsPath);
    return await fn({ root, tlsUtils });
  } finally {
    delete require.cache[tlsUtilsPath];
    delete require.cache[configManagerPath];
    delete require.cache[secureStorePath];
    Module._load = originalLoad;
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('pinned management HTTPS agent accepts the matching self-signed certificate', async () => {
  await withTlsUtils(async ({ root, tlsUtils }) => {
    const serverPath = path.join(root, 'server');
    await fsp.mkdir(serverPath, { recursive: true });
    const tlsConfig = await tlsUtils.getManagementTlsConfig(serverPath);
    const port = await getFreePort();
    const server = https.createServer({ key: tlsConfig.key, cert: tlsConfig.cert }, (_, res) => {
      res.end('ok');
    });

    await new Promise((resolve, reject) => {
      server.listen(port, '127.0.0.1', resolve);
      server.on('error', reject);
    });

    try {
      const agent = await tlsUtils.getPinnedHttpsAgent('127.0.0.1', port, tlsConfig.fingerprint);
      const body = await new Promise((resolve, reject) => {
        const req = https.get(`https://127.0.0.1:${port}/`, { agent }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
      });

      assert.equal(body, 'ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
