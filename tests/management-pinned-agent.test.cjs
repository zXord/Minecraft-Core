const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { requestManagementJson, HOST_UNREACHABLE_REASON } = require('../electron/services/management-session-transport.cjs');
const { ManagementPackClient } = require('../electron/services/client-modpacks/management-pack-client.cjs');
const { createClientConnectionCore } = require('../electron/bootstrap/create-client-connection-core.cjs');

// Only an exchange that never reached the host carries the internal reason.
const unreachable = error => error?.code === 'CLIENT_PACK_UNAVAILABLE' && error.reason === HOST_UNREACHABLE_REASON;
const reached = error => error?.code === 'CLIENT_PACK_UNAVAILABLE' && error.reason === undefined;

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
  const durableFsPath = path.resolve(__dirname, '../electron/utils/durable-fs.cjs');
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
    require(durableFsPath).configureDurableFs({
      allowedRoots: [root],
      durableClient: {
        moveWriteThrough: fs.renameSync,
        replaceFileWriteThrough: fs.renameSync,
        flushDirectory() {}
      }
    });
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

async function managementTls(root, tlsUtils) {
  const serverPath = path.join(root, 'server');
  await fsp.mkdir(serverPath, { recursive: true });
  return tlsUtils.getManagementTlsConfig(serverPath);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

// Accepts TCP and never answers the TLS ClientHello, like an offline or filtered host.
async function withStalledTlsHost(fn) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  const port = await listen(server);
  try {
    return await fn(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

// Completes the TLS handshake with the management certificate, then runs the handler.
async function withManagementHost(tlsConfig, handler, fn) {
  const server = https.createServer({ key: tlsConfig.key, cert: tlsConfig.cert }, handler);
  let connections = 0;
  server.on('connection', () => { connections += 1; });
  const port = await listen(server);
  try {
    return await fn(port, () => connections);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
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

test('pinned management HTTPS agent refuses a certificate that does not match the pin before sending anything', async () => {
  await withTlsUtils(async ({ root, tlsUtils }) => {
    const serverPath = path.join(root, 'server');
    await fsp.mkdir(serverPath, { recursive: true });
    const tlsConfig = await tlsUtils.getManagementTlsConfig(serverPath);
    const port = await getFreePort();
    const received = [];
    const server = https.createServer({ key: tlsConfig.key, cert: tlsConfig.cert }, (req, res) => {
      received.push(req.url);
      req.resume();
      res.end('ok');
    });

    await new Promise((resolve, reject) => {
      server.listen(port, '127.0.0.1', resolve);
      server.on('error', reject);
    });

    try {
      const otherPin = tlsConfig.fingerprint.replace(/^./, first => (first === '0' ? '1' : '0'));
      assert.notEqual(otherPin, tlsConfig.fingerprint);
      const agent = await tlsUtils.getPinnedHttpsAgent('127.0.0.1', port, otherPin);
      const outcome = await new Promise(resolve => {
        const req = https.request(`https://127.0.0.1:${port}/api/client/register`, {
          method: 'POST',
          agent,
          headers: { 'Content-Type': 'application/json' }
        }, res => {
          res.resume();
          resolve({ statusCode: res.statusCode });
        });
        req.on('error', error => resolve({ error: error.message }));
        req.end(JSON.stringify({ secret: 'private-invite-secret' }));
      });

      assert.match(outcome.error || '', /fingerprint mismatch/i);
      assert.deepEqual(received, []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('a pinned management request whose TLS handshake never completes reports an unreachable host', async () => {
  await withTlsUtils(async ({ tlsUtils }) => {
    await withStalledTlsHost(async port => {
      const agent = await tlsUtils.getPinnedHttpsAgent('127.0.0.1', port, 'ab'.repeat(32));
      const stages = [];
      await assert.rejects(requestManagementJson(`https://127.0.0.1:${port}/api/server/info`, {
        agent, timeoutMs: 300, onProgress: stage => stages.push(stage)
      }), unreachable);
      assert.deepEqual(stages, ['connecting']);
    });
  });
});

test('a pinned management host that completes the handshake but never answers HTTP was reached', async () => {
  await withTlsUtils(async ({ root, tlsUtils }) => {
    const tlsConfig = await managementTls(root, tlsUtils);
    await withManagementHost(tlsConfig, () => {}, async port => {
      const agent = await tlsUtils.getPinnedHttpsAgent('127.0.0.1', port, tlsConfig.fingerprint);
      const stages = [];
      await assert.rejects(requestManagementJson(`https://127.0.0.1:${port}/api/server/info`, {
        agent, timeoutMs: 1000, onProgress: stage => stages.push(stage)
      }), reached);
      assert.deepEqual(stages, ['connecting', 'connected']);
    });
  });
});

test('a pinned management request to another certificate sends nothing and is not reported as unreachable', async () => {
  await withTlsUtils(async ({ root, tlsUtils }) => {
    const tlsConfig = await managementTls(root, tlsUtils);
    const received = [];
    const handler = (req, res) => {
      received.push(req.url);
      req.resume();
      res.end('{}');
    };
    await withManagementHost(tlsConfig, handler, async (port, connections) => {
      const otherPin = tlsConfig.fingerprint.replace(/^./, first => (first === '0' ? '1' : '0'));
      const agent = await tlsUtils.getPinnedHttpsAgent('127.0.0.1', port, otherPin);
      const stages = [];
      await assert.rejects(requestManagementJson(`https://127.0.0.1:${port}/api/client/register`, {
        method: 'POST',
        agent,
        timeoutMs: 5000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'private-invite-secret' }),
        onProgress: stage => stages.push(stage)
      }), reached);
      assert.deepEqual(stages, ['connecting']);
      assert.equal(connections(), 1);
      assert.deepEqual(received, []);
    });
  });
});

test('a pinned management connection is connected when handed over and when reused', async () => {
  await withTlsUtils(async ({ root, tlsUtils }) => {
    const tlsConfig = await managementTls(root, tlsUtils);
    await withManagementHost(tlsConfig, (_req, res) => res.end('{"success":true}'), async (port, connections) => {
      const agent = await tlsUtils.getPinnedHttpsAgent('127.0.0.1', port, tlsConfig.fingerprint);
      const url = `https://127.0.0.1:${port}/api/server/info`;
      const first = [];
      const second = [];
      assert.deepEqual((await requestManagementJson(url, { agent, timeoutMs: 5000, onProgress: stage => first.push(stage) })).body, { success: true });
      assert.deepEqual((await requestManagementJson(url, { agent, timeoutMs: 5000, onProgress: stage => second.push(stage) })).body, { success: true });
      assert.deepEqual(first, ['connecting', 'connected', 'responded']);
      assert.deepEqual(second, ['connected', 'responded']);
      assert.equal(connections(), 1);
    });
  });
});

test('a request timeout on a pinned connection leaves the socket to the request', async () => {
  await withTlsUtils(async ({ root, tlsUtils }) => {
    const tlsConfig = await managementTls(root, tlsUtils);
    await withManagementHost(tlsConfig, (_req, res) => { setTimeout(() => res.end('ok'), 150); }, async port => {
      const agent = await tlsUtils.getPinnedHttpsAgent('127.0.0.1', port, tlsConfig.fingerprint);
      let timedOut = false;
      const body = await new Promise((resolve, reject) => {
        const req = https.get(`https://127.0.0.1:${port}/`, { agent }, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve(data));
        });
        req.setTimeout(50, () => { timedOut = true; });
        req.on('error', reject);
      });
      assert.equal(timedOut, true);
      assert.equal(body, 'ok');
    });
  });
});

test('client sessions over the pinned agent count only a host that never completes the handshake as unreachable', async () => {
  await withTlsUtils(async ({ root, tlsUtils }) => {
    const tlsConfig = await managementTls(root, tlsUtils);
    // The same read and deadline shape runLocalMutation uses before it allows a local content edit.
    const readRequirement = async (port, fingerprint = tlsConfig.fingerprint) => {
      const clientPath = path.join(root, `client-${port}-${fingerprint.slice(0, 8)}`);
      await fsp.mkdir(clientPath, { recursive: true });
      const core = createClientConnectionCore({
        store: { get: key => (key === 'instances' ? [{ id: 'friend', type: 'client', path: clientPath }] : undefined) },
        readClientConfig: async () => ({
          serverProtocol: 'https', serverIp: '127.0.0.1', serverPort: String(port), clientId: 'remote-friend',
          clientName: 'Friend', inviteSecret: 'synthetic-invite', sessionToken: 'a'.repeat(64), managementCertFingerprint: fingerprint
        }),
        getPinnedHttpsAgent: tlsUtils.getPinnedHttpsAgent,
        clock: { now: () => Date.now() }
      });
      try {
        const client = new ManagementPackClient({ sessionBroker: core.managementSessionBroker });
        return await client.readRequirement('friend', { deadline: Date.now() + 500 }).then(() => null, error => error);
      } finally {
        core.dispose();
      }
    };

    await withStalledTlsHost(async port => {
      assert.equal(unreachable(await readRequirement(port)), true);
    });
    const received = [];
    await withManagementHost(tlsConfig, req => { received.push(req.url); }, async port => {
      assert.equal(reached(await readRequirement(port)), true);
      assert.deepEqual(received, ['/api/server/info']);
      const otherPin = tlsConfig.fingerprint.replace(/^./, first => (first === '0' ? '1' : '0'));
      assert.equal(reached(await readRequirement(port, otherPin)), true);
      assert.deepEqual(received, ['/api/server/info']);
    });
  });
});
