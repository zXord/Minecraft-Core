const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

async function withManagementServer(fn) {
  const modulePath = path.resolve(__dirname, '../electron/services/management-server.cjs');
  const originalLoad = Module._load;

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getVersion() {
            return '0.0.0-test';
          },
          getPath() {
            return __dirname;
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

    if (request === '../ipc/logger-handlers.cjs' || request.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const { ManagementServer } = require(modulePath);
    return await fn(new ManagementServer('rate-limit-test'));
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

function fakeResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
  };
}

function fakeRequest(routePath, ip = '127.0.0.1') {
  return {
    path: routePath,
    ip,
    headers: {},
    get(name) {
      return this.headers[String(name).toLowerCase()] || '';
    },
    connection: { remoteAddress: ip }
  };
}

test('bulk mod downloads use a separate rate limit bucket from management API calls', async () => {
  await withManagementServer(async (server) => {
    for (let i = 0; i < 500; i += 1) {
      const allowed = server.applyRateLimit(
        fakeRequest(`/api/mods/download/test-mod-${i}.jar`),
        fakeResponse()
      );
      assert.equal(allowed, true, `download request ${i + 1} should be allowed`);
    }

    const apiResponse = fakeResponse();
    assert.equal(server.applyRateLimit(fakeRequest('/api/server/info'), apiResponse), true);
    assert.equal(apiResponse.headers['retry-after'], undefined);
  });
});

test('regular management API calls remain rate limited', async () => {
  await withManagementServer(async (server) => {
    for (let i = 0; i < 120; i += 1) {
      assert.equal(server.applyRateLimit(fakeRequest('/api/server/info'), fakeResponse()), true);
    }

    const response = fakeResponse();
    assert.equal(server.applyRateLimit(fakeRequest('/api/server/info'), response), false);
    assert.equal(response.headers['retry-after'], '60');
  });
});
