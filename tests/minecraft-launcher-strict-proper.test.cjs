const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

async function withLaunchHandler({ properResult, legacyResult, beginManagedLaunch, authResult }, run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-strict-proper-'));
  const clientPath = path.join(root, 'client');
  await fsp.mkdir(clientPath);
  await fsp.writeFile(path.join(clientPath, '.servers-initialized'), '{}');

  const originalLoad = Module._load;
  const modulePath = path.resolve(__dirname, '../electron/ipc/minecraft-launcher-handlers.cjs');
  const calls = { auth: 0, proper: 0, legacy: 0 };
  const launchCalls = [];
  const launcher = new EventEmitter();
  launcher.loadAuthData = async () => {
    calls.auth += 1;
    return authResult || { success: true, username: 'E2EJoiner' };
  };
  launcher.launchMinecraftProper = async (options, reservation) => {
    calls.proper += 1;
    launchCalls.push({ kind: 'proper', options, reservation });
    if (reservation?.authority) {
      assert.equal(reservation?.authority?.profileId, 'exact-main-profile');
      assert.equal(options.clientPath, clientPath);
    }
    return properResult;
  };
  launcher.launchMinecraft = async (options, reservation) => {
    calls.legacy += 1;
    launchCalls.push({ kind: 'legacy', options, reservation });
    return legacyResult;
  };
  launcher.getStatus = () => ({ isRunning: false });

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => path.join(root, 'user-data'), getVersion: () => '0.0.0-test', setPath() {} },
        net: null,
        session: { defaultSession: null }
      };
    }
    if (request === './logger-handlers.cjs' || request.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    }
    if (request === '../services/minecraft-launcher/index.cjs' || request.includes('services/minecraft-launcher/index.cjs')) {
      return { getMinecraftLauncher: () => launcher };
    }
    if (request === '../utils/app-store.cjs' || request.includes('app-store.cjs')) {
      return {
        get: key => key === 'instances' ? [{ id: 'client', type: 'client', path: clientPath }] : undefined,
        set: () => true
      };
    }
    if (request === '../services/server-mutation-context.cjs' || request.includes('server-mutation-context.cjs')) {
      return { markCurrentServerMutationDirty() {} };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];
  try {
    const { createMinecraftLauncherHandlers } = require(modulePath);
    const handlers = createMinecraftLauncherHandlers({
      isDestroyed: () => false,
      webContents: { send() {} }
    }, beginManagedLaunch ? { beginManagedLaunch } : undefined);
    return await run({ handlers, clientPath, calls, launchCalls });
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function launchRequest(clientPath, extra = {}) {
  return {
    clientPath,
    minecraftVersion: '1.20.1',
    serverIp: '127.0.0.1',
    serverPort: 25566,
    managementPort: 18080,
    serverInfo: { loaderType: 'fabric', loaderVersion: '0.15.10' },
    useProperLauncher: true,
    ...extra
  };
}

for (const useProperLauncher of [true, false]) test(`unmanaged process reservation preserves normal ${useProperLauncher ? 'proper' : 'legacy'} runtime and transfers ownership`, async () => {
  let aborts = 0;
  const reservation = { jvmArgument: '-Dfixture=owned', async abortBeforeSpawn() { aborts++; } };
  await withLaunchHandler({ properResult: { success: true }, legacyResult: { success: true }, beginManagedLaunch: async () => reservation },
    async ({ handlers, clientPath, launchCalls }) => {
      const result = await handlers['minecraft-launch'](null, launchRequest(clientPath, { useProperLauncher, maxMemory: 6144 }));
      assert.equal(result.success, true);
      assert.equal(result.launcherKind, useProperLauncher ? 'proper' : 'legacy');
      assert.equal(launchCalls.length, 1);
      assert.equal(launchCalls[0].reservation, reservation);
      assert.equal(launchCalls[0].options.minecraftVersion, '1.20.1');
      assert.equal(launchCalls[0].options.maxMemory, 6144);
      assert.equal(launchCalls[0].options.serverInfo.loaderVersion, '0.15.10');
      assert.equal(launchCalls[0].options.serverIp, '127.0.0.1');
      assert.equal(aborts, 0, 'IPC must not settle an ownership record transferred to a launcher');
    });
});

test('unmanaged proper fallback reacquires ownership instead of reusing or aborting the transferred reservation', async () => {
  let aborts = 0;
  const reservation = { async abortBeforeSpawn() { aborts++; } };
  await withLaunchHandler({ properResult: { success: false, error: 'proper failed' }, legacyResult: { success: true }, beginManagedLaunch: async () => reservation },
    async ({ handlers, clientPath, launchCalls }) => {
      const result = await handlers['minecraft-launch'](null, launchRequest(clientPath));
      assert.equal(result.fallbackAttempted, true);
      assert.equal(launchCalls[0].reservation, reservation);
      assert.equal(launchCalls[1].reservation, undefined, 'legacy must acquire a fresh main reservation, which refuses an uncertain prior child');
      assert.equal(aborts, 0);
    });
});

for (const authFailure of [true, false]) test(`unmanaged ${authFailure ? 'auth' : 'strict-mode'} refusal settles only the untransferred reservation`, async () => {
  let aborts = 0;
  await withLaunchHandler({ beginManagedLaunch: async () => ({ async abortBeforeSpawn() { aborts++; } }),
    authResult: authFailure ? { success: false } : undefined }, async ({ handlers, clientPath, calls }) => {
    const result = await handlers['minecraft-launch'](null, launchRequest(clientPath,
      authFailure ? {} : { useProperLauncher: false, strictProperLauncher: true }));
    assert.equal(result.success, false); assert.equal(calls.proper, 0); assert.equal(calls.legacy, 0); assert.equal(aborts, 1);
  });
});

test('managed handler ignores a renderer legacy request, preserves servers.dat, and forbids fallback', async () => {
  await withLaunchHandler({ properResult: { success: false, error: 'exact runtime failed' }, legacyResult: { success: true },
    beginManagedLaunch: async () => ({ authority: { profileId: 'exact-main-profile' }, async abortBeforeSpawn() {} })
  }, async ({ handlers, clientPath, calls }) => {
    await fsp.unlink(path.join(clientPath, '.servers-initialized'));
    await fsp.writeFile(path.join(clientPath, 'servers.dat'), 'personal list');
    const result = await handlers['minecraft-launch'](null, launchRequest(clientPath, { useProperLauncher: false, strictProperLauncher: false }));
    assert.equal(result.success, false); assert.equal(result.launcherKind, 'proper'); assert.equal(result.fallbackAttempted, false);
    assert.equal(calls.proper, 1); assert.equal(calls.legacy, 0);
    assert.equal(await fsp.readFile(path.join(clientPath, 'servers.dat'), 'utf8'), 'personal list');
    await assert.rejects(fsp.access(path.join(clientPath, '.servers-initialized')), { code: 'ENOENT' });
  });
});

test('strict proper launch returns the proper failure without invoking the legacy fallback', async () => {
  await withLaunchHandler({
    properResult: { success: false, error: 'proper failed' },
    legacyResult: { success: true, message: 'legacy launched' }
  }, async ({ handlers, clientPath, calls }) => {
    const result = await handlers['minecraft-launch'](null, launchRequest(clientPath, { strictProperLauncher: true }));
    assert.deepEqual(result, {
      success: false,
      error: 'proper failed',
      launcherKind: 'proper',
      fallbackAttempted: false
    });
    assert.deepEqual(calls, { auth: 1, proper: 1, legacy: 0 });
  });
});

test('proper launch success reports an explicit proper-launch result', async () => {
  await withLaunchHandler({
    properResult: { success: true, pid: 1234 },
    legacyResult: { success: true, message: 'legacy launched' }
  }, async ({ handlers, clientPath, calls }) => {
    const result = await handlers['minecraft-launch'](null, launchRequest(clientPath, { strictProperLauncher: true }));
    assert.deepEqual(result, {
      success: true,
      pid: 1234,
      launcherKind: 'proper',
      fallbackAttempted: false
    });
    assert.deepEqual(calls, { auth: 1, proper: 1, legacy: 0 });
  });
});

test('non-strict proper launch preserves fallback while reporting that legacy launched', async () => {
  await withLaunchHandler({
    properResult: { success: false, error: 'proper failed' },
    legacyResult: { success: true, pid: 4321 }
  }, async ({ handlers, clientPath, calls }) => {
    const result = await handlers['minecraft-launch'](null, launchRequest(clientPath));
    assert.deepEqual(result, {
      success: true,
      pid: 4321,
      launcherKind: 'legacy',
      fallbackAttempted: true
    });
    assert.deepEqual(calls, { auth: 1, proper: 1, legacy: 1 });
  });
});

test('strict proper launch cannot be combined with a disabled proper launcher', async () => {
  await withLaunchHandler({
    properResult: { success: true, pid: 1234 },
    legacyResult: { success: true, pid: 4321 }
  }, async ({ handlers, clientPath, calls }) => {
    const result = await handlers['minecraft-launch'](null, launchRequest(clientPath, {
      useProperLauncher: false,
      strictProperLauncher: true
    }));
    assert.deepEqual(result, {
      success: false,
      error: 'Strict proper launch requires the proper launcher',
      launcherKind: null,
      fallbackAttempted: false
    });
    assert.deepEqual(calls, { auth: 0, proper: 0, legacy: 0 });
  });
});

test('launch rejects an unknown client path before reading auth or initializing client files', async () => {
  await withLaunchHandler({
    properResult: { success: true, pid: 1234 },
    legacyResult: { success: true, pid: 4321 }
  }, async ({ handlers, clientPath, calls }) => {
    const unknownClientPath = path.join(path.dirname(clientPath), 'unknown-client');
    await fsp.mkdir(unknownClientPath);

    const result = await handlers['minecraft-launch'](null, launchRequest(unknownClientPath));

    assert.deepEqual(result, {
      success: false,
      error: 'Client path is not a known client instance'
    });
    assert.deepEqual(calls, { auth: 0, proper: 0, legacy: 0 });
    await assert.rejects(
      fsp.access(path.join(unknownClientPath, '.servers-initialized')),
      { code: 'ENOENT' }
    );
  });
});
