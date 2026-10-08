const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.resolve(__dirname, '../src/utils/managementAuth.js')).href;

async function withManagementGlobals(fn) {
  const previousFetch = global.fetch;
  const previousWindow = global.window;
  try {
    const auth = await import(moduleUrl);
    return await fn(auth);
  } finally {
    if (previousFetch === undefined) delete global.fetch;
    else global.fetch = previousFetch;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
}

function client(overrides = {}) {
  return {
    serverIp: '127.0.0.1',
    serverPort: '49152',
    serverProtocol: 'https',
    clientId: 'client-existing',
    clientName: 'Existing client',
    path: 'C:\\Temp\\isolated-client',
    sessionToken: 'stable-session-token',
    inviteSecret: 'invite-secret',
    ...overrides
  };
}

test('ordinary authenticated requests reuse the mounted client session without registration or persistence', async () => {
  await withManagementGlobals(async ({ requestWithSessionRecovery }) => {
    assert.equal(typeof requestWithSessionRecovery, 'function', 'session recovery request helper is required');
    let requestCount = 0;
    global.fetch = async () => { throw new Error('registration must not run'); };
    global.window = { electron: { invoke: async () => { throw new Error('persistence must not run'); } } };
    const instance = client();

    const response = await requestWithSessionRecovery(instance, async headers => {
      requestCount += 1;
      assert.equal(headers['X-Session-Token'], 'stable-session-token');
      return { ok: true, status: 200 };
    });

    assert.equal(response.status, 200);
    assert.equal(requestCount, 1);
    assert.equal(instance.sessionToken, 'stable-session-token');
  });
});

test('an authorization rejection rotates once, persists auth-only state, and retries with the new token', async () => {
  await withManagementGlobals(async ({ requestWithSessionRecovery }) => {
    assert.equal(typeof requestWithSessionRecovery, 'function', 'session recovery request helper is required');
    const persisted = [];
    let registrations = 0;
    global.fetch = async (_url, options) => {
      registrations += 1;
      assert.equal(options.method, 'POST');
      return { ok: true, status: 200, json: async () => ({ token: 'rotated-session-token' }) };
    };
    global.window = { electron: { invoke: async (channel, payload) => { persisted.push({ channel, payload }); return { success: true }; } } };
    const seenTokens = [];
    const instance = client();

    const response = await requestWithSessionRecovery(instance, async headers => {
      seenTokens.push(headers['X-Session-Token']);
      return seenTokens.length === 1
        ? { ok: false, status: 401 }
        : { ok: true, status: 200 };
    });

    assert.equal(response.status, 200);
    assert.equal(registrations, 1);
    assert.deepEqual(seenTokens, ['stable-session-token', 'rotated-session-token']);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].channel, 'save-client-config');
    assert.equal(persisted[0].payload.sessionToken, 'rotated-session-token');
    assert.equal(persisted[0].payload.initializeMultiplayer, false);
  });
});

test('non-authorization failures never rotate a valid mounted session', async () => {
  await withManagementGlobals(async ({ requestWithSessionRecovery }) => {
    assert.equal(typeof requestWithSessionRecovery, 'function', 'session recovery request helper is required');
    let registrations = 0;
    let requests = 0;
    global.fetch = async () => { registrations += 1; return { ok: false, status: 500 }; };
    global.window = { electron: { invoke: async () => ({ success: true }) } };

    const response = await requestWithSessionRecovery(client(), async () => {
      requests += 1;
      return { ok: false, status: 500 };
    });

    assert.equal(response.status, 500);
    assert.equal(requests, 1);
    assert.equal(registrations, 0);
  });
});

test('an explicit reconnect registers before the protected request even when the old token is valid', async () => {
  await withManagementGlobals(async ({ requestWithSessionRecovery }) => {
    assert.equal(typeof requestWithSessionRecovery, 'function', 'session recovery request helper is required');
    let registrations = 0;
    global.fetch = async () => {
      registrations += 1;
      return { ok: true, status: 200, json: async () => ({ token: 'explicit-reconnect-token' }) };
    };
    global.window = { electron: { invoke: async () => ({ success: true }) } };

    const response = await requestWithSessionRecovery(client(), async headers => {
      assert.equal(headers['X-Session-Token'], 'explicit-reconnect-token');
      return { ok: true, status: 200 };
    }, { forceRegistration: true });

    assert.equal(response.status, 200);
    assert.equal(registrations, 1);
  });
});
