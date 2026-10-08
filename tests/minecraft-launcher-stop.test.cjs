const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const {
  ProperMinecraftLauncher
} = require('../electron/services/minecraft-launcher/proper-launcher.cjs');

function createChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    return true;
  };
  return child;
}

async function withMinecraftLauncherClass(run) {
  const originalLoad = Module._load;
  const modulePath = require.resolve('../electron/services/minecraft-launcher/index.cjs');
  Module._load = function mockLoad(request, parent, isMain) {
    if (request === '../../ipc/logger-handlers.cjs' || request.includes('ipc/logger-handlers.cjs')) {
      return {
        getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} })
      };
    }
    if (request === './utils.cjs' && parent?.filename === modulePath) {
      return {
        resolveRequiredJavaVersion: async () => ({ requiredJavaVersion: 17 })
      };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];
  try {
    const { MinecraftLauncher } = require(modulePath);
    return await run(MinecraftLauncher);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

test('proper launcher retains a live client and reports failure when exit cannot be confirmed', async () => {
  const child = createChild();
  let stoppedEvents = 0;
  const launcher = new ProperMinecraftLauncher({
    isProcessAlive: () => true,
    stopTrackedProcess: async () => ({
      success: false,
      error: 'Minecraft process did not exit after termination attempts'
    })
  });
  const trackedClient = { child };
  launcher.client = trackedClient;
  launcher.isLaunching = true;
  launcher.on('minecraft-stopped', () => {
    stoppedEvents += 1;
  });

  const result = await launcher.stopMinecraft();

  assert.equal(result.success, false);
  assert.equal(launcher.client, trackedClient);
  assert.equal(launcher.getStatus().isRunning, true);
  assert.equal(stoppedEvents, 0);
});

test('proper launcher keeps process state until its awaited stop operation confirms exit', async () => {
  const child = createChild();
  let resolveStop;
  const launcher = new ProperMinecraftLauncher({
    isProcessAlive: () => true,
    stopTrackedProcess: () => new Promise(resolve => {
      resolveStop = resolve;
    })
  });
  const trackedClient = { child };
  launcher.client = trackedClient;
  launcher.isLaunching = true;

  const stopPromise = launcher.stopMinecraft();
  await Promise.resolve();
  assert.equal(launcher.client, trackedClient);

  resolveStop({ success: true });
  const result = await stopPromise;
  assert.equal(result.success, true);
  assert.equal(launcher.client, null);
  assert.equal(launcher.getStatus().isRunning, false);
});

test('proper launcher does not treat a process error event as confirmed exit while the PID is alive', () => {
  const child = createChild();
  const launcher = new ProperMinecraftLauncher({
    isProcessAlive: () => true
  });
  const trackedClient = { child };
  launcher.client = trackedClient;
  launcher.isLaunching = true;
  let stoppedEvents = 0;
  launcher.on('minecraft-stopped', () => {
    stoppedEvents += 1;
  });

  launcher._handleTrackedProcessError(trackedClient);

  assert.equal(launcher.client, trackedClient);
  assert.equal(launcher.isLaunching, true);
  assert.equal(stoppedEvents, 0);
});

test('proper launcher escalates through the retained Windows child handle without a PID command', async () => {
  const child = createChild(4242);
  let alive = true;
  const commands = [];
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGKILL') alive = false;
    return true;
  };
  const launcher = new ProperMinecraftLauncher({
    isProcessAlive: () => alive,
    stopOptions: {
      platform: 'win32',
      gracefulTimeoutMs: 1,
      forceTimeoutMs: 5,
      pollIntervalMs: 1,
      execFileAsync: async (file, args, options) => {
        commands.push({ file, args, options });
        alive = false;
      }
    }
  });
  launcher.client = { child };
  launcher.isLaunching = true;

  const result = await launcher.stopMinecraft();

  assert.equal(result.success, true);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(commands, []);
  assert.equal(launcher.client, null);
});

test('proper launcher stop cancels an in-flight pre-spawn preparation and prevents a JVM spawn', async () => {
  const launcher = new ProperMinecraftLauncher();
  launcher.setAuthData({ name: 'E2EJoiner', uuid: 'uuid', access_token: 'token' });
  let preparationSignal = null;
  launcher.ensureMinecraftClient = async (_clientPath, _version, options = {}) => {
    preparationSignal = options.signal || null;
    await new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('Minecraft asset preparation was cancelled.');
        error.code = 'MINECRAFT_ASSET_CANCELLED';
        reject(error);
      }, { once: true });
    });
  };

  const launchPromise = launcher.launchMinecraft({
    clientPath: 'C:\\disposable-client',
    minecraftVersion: '1.20.1',
    javaPath: 'javaw.exe'
  });
  await new Promise(resolve => setImmediate(resolve));
  const stopped = await launcher.stopMinecraft();
  const launchResult = await Promise.race([
    launchPromise,
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 200))
  ]);

  assert.ok(preparationSignal);
  assert.equal(preparationSignal.aborted, true);
  assert.equal(stopped.success, true);
  assert.equal(launchResult.timeout, undefined);
  assert.equal(launchResult.success, false);
  assert.equal(launchResult.error, 'Minecraft asset preparation was cancelled.');
  assert.equal(launcher.client, null);
  assert.equal(launcher.isLaunching, false);
});

test('proper launcher stop reports when pre-spawn task cancellation was not confirmed', async () => {
  const launcher = new ProperMinecraftLauncher();
  launcher.setAuthData({ name: 'E2EJoiner', uuid: 'uuid', access_token: 'token' });
  launcher.ensureMinecraftClient = async (_clientPath, _version, options = {}) => {
    await new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('raw cancellation failure at C:\\private\\asset.bin');
        error.code = 'MINECRAFT_ASSET_CANCEL_TIMEOUT';
        reject(error);
      }, { once: true });
    });
  };

  const launchPromise = launcher.launchMinecraft({
    clientPath: 'C:\\disposable-client',
    minecraftVersion: '1.20.1',
    javaPath: 'javaw.exe'
  });
  await new Promise(resolve => setImmediate(resolve));
  const stopped = await launcher.stopMinecraft();
  const launchResult = await launchPromise;

  assert.deepEqual(stopped, {
    success: false,
    error: 'Minecraft launch preparation could not be cancelled safely'
  });
  assert.equal(launchResult.success, false);
  assert.equal(launcher.client, null);
  assert.equal(launcher.isLaunching, true);
  const retryResult = await launcher.launchMinecraft({
    clientPath: 'C:\\disposable-client',
    minecraftVersion: '1.20.1',
    javaPath: 'javaw.exe'
  });
  assert.equal(retryResult.success, false);
  assert.equal(retryResult.error, 'Minecraft is already launching');
});

test('proper launcher owns cancellation through loader preparation and blocks a concurrent relaunch', async () => {
  let resolveLoader;
  let markLoaderStarted;
  let spawnCalls = 0;
  const loaderStarted = new Promise(resolve => { markLoaderStarted = resolve; });
  const loaderPreparation = new Promise(resolve => { resolveLoader = resolve; });
  const launcher = new ProperMinecraftLauncher({
    installClientLoader: async () => {
      markLoaderStarted();
      return loaderPreparation;
    },
    spawn: () => {
      spawnCalls += 1;
      throw new Error('JVM must not spawn after cancellation');
    },
    launchPreparationStopTimeoutMs: 1_000
  });
  launcher.setAuthData({ name: 'E2EJoiner', uuid: 'uuid', access_token: 'token' });
  launcher.ensureMinecraftClient = async () => ({ success: true });

  const options = {
    clientPath: 'C:\\disposable-client',
    minecraftVersion: '1.20.1',
    loaderType: 'fabric',
    loaderVersion: '0.16.14',
    javaPath: 'javaw.exe'
  };
  const firstLaunch = launcher.launchMinecraft(options);
  await loaderStarted;

  let stopSettled = false;
  const stopPromise = launcher.stopMinecraft().then(result => {
    stopSettled = true;
    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const stopWaitedForOwnedPreparation = !stopSettled;
  const secondLaunch = launcher.launchMinecraft(options);

  resolveLoader({ profileId: 'fabric-loader-0.16.14-1.20.1' });
  const [stopped, firstResult, secondResult] = await Promise.all([
    stopPromise,
    firstLaunch,
    secondLaunch
  ]);

  assert.equal(stopWaitedForOwnedPreparation, true);
  assert.equal(stopped.success, true);
  assert.equal(firstResult.success, false);
  assert.equal(firstResult.error, 'Minecraft asset preparation was cancelled.');
  assert.equal(secondResult.success, false);
  assert.equal(secondResult.error, 'Minecraft is already launching');
  assert.equal(spawnCalls, 0);
  assert.equal(launcher.client, null);
  assert.equal(launcher.isLaunching, false);
});

test('proper launcher does not install a loader after cancellation during loader-version resolution', async () => {
  let resolveLoaderVersions;
  let markLoaderLookupStarted;
  let loaderInstallCalls = 0;
  const loaderLookupStarted = new Promise(resolve => { markLoaderLookupStarted = resolve; });
  const loaderVersions = new Promise(resolve => { resolveLoaderVersions = resolve; });
  const launcher = new ProperMinecraftLauncher({
    getLoaderVersions: async () => {
      markLoaderLookupStarted();
      return loaderVersions;
    },
    installClientLoader: async () => {
      loaderInstallCalls += 1;
      return { profileId: 'fabric-loader-0.16.14-1.20.1' };
    },
    launchPreparationStopTimeoutMs: 1_000
  });
  launcher.setAuthData({ name: 'E2EJoiner', uuid: 'uuid', access_token: 'token' });
  launcher.ensureMinecraftClient = async () => ({ success: true });

  const launchPromise = launcher.launchMinecraft({
    clientPath: 'C:\\disposable-client',
    minecraftVersion: '1.20.1',
    loaderType: 'fabric',
    loaderVersion: 'latest',
    javaPath: 'javaw.exe'
  });
  await loaderLookupStarted;
  const stopPromise = launcher.stopMinecraft();
  resolveLoaderVersions(['0.16.14']);

  const [launchResult, stopResult] = await Promise.all([launchPromise, stopPromise]);
  assert.equal(launchResult.success, false);
  assert.equal(launchResult.error, 'Minecraft asset preparation was cancelled.');
  assert.equal(stopResult.success, true);
  assert.equal(loaderInstallCalls, 0);
});

test('wrapper delegates proper-launcher shutdown without sending duplicate signals or events', async () => {
  await withMinecraftLauncherClass(async MinecraftLauncher => {
    const child = createChild();
    // Lifecycle forwarding is installed on construction, before any launch succeeds.
    const launcher = new MinecraftLauncher();
    const properLauncher = launcher.properLauncher;
    properLauncher.client = null;
    properLauncher.isLaunching = false;
    properLauncher.setAuthData = () => {};
    properLauncher.launchMinecraft = async () => {
      properLauncher.client = { child };
      properLauncher.isLaunching = true;
      return { success: true, pid: child.pid };
    };
    let properStopCalls = 0;
    properLauncher.stopMinecraft = async () => {
      properStopCalls += 1;
      properLauncher.client = null;
      properLauncher.isLaunching = false;
      properLauncher.emit('minecraft-stopped');
      return { success: true, message: 'Minecraft stopped' };
    };

    launcher.authHandler = { authData: { name: 'E2EJoiner' } };
    let selectedJavaClientPath = null;
    launcher.javaManager = {
      setClientPath(clientPath) { selectedJavaClientPath = clientPath; },
      ensureJava: async () => {
        assert.equal(selectedJavaClientPath, 'C:\\disposable-client');
        return { success: true, javaPath: 'java' };
      }
    };
    launcher.properLauncher = properLauncher;
    launcher.client = null;
    launcher.clientPath = null;
    launcher.isLaunching = false;
    launcher._activeLauncherKind = null;

    const launched = await launcher.launchMinecraftProper({
      clientPath: 'C:\\disposable-client',
      minecraftVersion: '1.20.1'
    });
    assert.equal(launched.success, true);
    launcher.clientPath = null;

    let stoppedEvents = 0;
    launcher.on('minecraft-stopped', () => {
      stoppedEvents += 1;
    });

    const result = await launcher.stopMinecraft();

    assert.equal(result.success, true);
    assert.equal(properStopCalls, 1);
    assert.deepEqual(child.signals, []);
    assert.equal(stoppedEvents, 1);
    assert.equal(launcher.client, null);
  });
});

test('wrapper delegates cancellation while the proper launcher is preparing before a child exists', async () => {
  await withMinecraftLauncherClass(async MinecraftLauncher => {
    let properStopCalls = 0;
    const properLauncher = new EventEmitter();
    properLauncher.client = null;
    properLauncher.isLaunching = true;
    properLauncher.stopMinecraft = async () => {
      properStopCalls += 1;
      properLauncher.isLaunching = false;
      return { success: true, message: 'Minecraft launch preparation cancelled' };
    };

    const launcher = Object.create(MinecraftLauncher.prototype);
    EventEmitter.call(launcher);
    launcher.authHandler = { authData: { name: 'E2EJoiner' } };
    launcher.properLauncher = properLauncher;
    launcher.client = null;
    launcher.clientPath = 'C:\\disposable-client';
    launcher.isLaunching = true;
    launcher._activeLauncherKind = 'proper';

    const result = await launcher.stopMinecraft();

    assert.equal(result.success, true);
    assert.equal(properStopCalls, 1);
    assert.equal(launcher.isLaunching, false);
    assert.equal(launcher.client, null);
    assert.equal(launcher._activeLauncherKind, null);
  });
});

test('wrapper publishes proper-launch ownership while pre-spawn preparation is pending', async () => {
  await withMinecraftLauncherClass(async MinecraftLauncher => {
    let resolveLaunch;
    const properLauncher = new EventEmitter();
    properLauncher.client = null;
    properLauncher.isLaunching = true;
    properLauncher.setAuthData = () => {};
    properLauncher.launchMinecraft = () => new Promise(resolve => {
      resolveLaunch = resolve;
    });

    const launcher = Object.create(MinecraftLauncher.prototype);
    EventEmitter.call(launcher);
    launcher.authHandler = { authData: { name: 'E2EJoiner' } };
    launcher.javaManager = {
      setClientPath() {},
      ensureJava: async () => ({ success: true, javaPath: 'java' })
    };
    launcher.properLauncher = properLauncher;
    launcher.client = null;
    launcher.clientPath = null;
    launcher.isLaunching = false;
    launcher._activeLauncherKind = null;

    const launchPromise = launcher.launchMinecraftProper({
      clientPath: 'C:\\disposable-client',
      minecraftVersion: '1.20.1'
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(launcher._activeLauncherKind, 'proper');
    assert.equal(launcher.isLaunching, true);
    assert.equal(launcher.clientPath, 'C:\\disposable-client');

    properLauncher.isLaunching = false;
    resolveLaunch({ success: false, error: 'cancelled' });
    const result = await launchPromise;
    assert.equal(result.success, false);
    assert.equal(launcher.isLaunching, false);
    assert.equal(launcher._activeLauncherKind, null);
  });
});

test('wrapper owns cancellation while Java preparation is pending and never starts the proper launcher', async () => {
  await withMinecraftLauncherClass(async MinecraftLauncher => {
    let resolveJava;
    let markJavaStarted;
    let properLaunchCalls = 0;
    let properStopCalls = 0;
    const javaStarted = new Promise(resolve => { markJavaStarted = resolve; });
    const javaPreparation = new Promise(resolve => { resolveJava = resolve; });
    const properLauncher = new EventEmitter();
    properLauncher.client = null;
    properLauncher.isLaunching = false;
    properLauncher.setAuthData = () => {};
    properLauncher.launchMinecraft = async () => {
      properLaunchCalls += 1;
      return { success: false, error: 'should not start' };
    };
    properLauncher.stopMinecraft = async () => {
      properStopCalls += 1;
      return { success: true };
    };

    const launcher = Object.create(MinecraftLauncher.prototype);
    EventEmitter.call(launcher);
    launcher.authHandler = { authData: { name: 'E2EJoiner' } };
    launcher.javaManager = {
      setClientPath() {},
      ensureJava: async () => {
        markJavaStarted();
        return javaPreparation;
      }
    };
    launcher.properLauncher = properLauncher;
    launcher.client = null;
    launcher.clientPath = null;
    launcher.isLaunching = false;
    launcher._activeLauncherKind = null;
    launcher._properLaunchAttempt = null;
    launcher._properLaunchStopTimeoutMs = 1_000;

    const launchPromise = launcher.launchMinecraftProper({
      clientPath: 'C:\\disposable-client',
      minecraftVersion: '1.20.1'
    });
    await javaStarted;
    const ownershipWasPublished = launcher._activeLauncherKind === 'proper' && launcher.isLaunching;
    const pendingStatus = launcher.getStatus();

    let stopSettled = false;
    const stopPromise = launcher.stopMinecraft().then(result => {
      stopSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const stopWaitedForJava = !stopSettled;
    resolveJava({ success: true, javaPath: 'java' });

    const [launchResult, stopResult] = await Promise.all([launchPromise, stopPromise]);
    assert.equal(ownershipWasPublished, true);
    assert.equal(pendingStatus.isLaunching, true);
    assert.equal(pendingStatus.isRunning, false);
    assert.equal(stopWaitedForJava, true);
    assert.equal(stopResult.success, true);
    assert.equal(launchResult.success, false);
    assert.equal(launchResult.error, 'Minecraft launch preparation was cancelled.');
    assert.equal(properLaunchCalls, 0);
    assert.equal(properStopCalls, 0);
    assert.equal(launcher._properLaunchAttempt, null);
    assert.equal(launcher._activeLauncherKind, null);
    assert.equal(launcher.isLaunching, false);
  });
});

test('wrapper forwards its launch cancellation signal into Java acquisition', async () => {
  await withMinecraftLauncherClass(async MinecraftLauncher => {
    let javaSignal = null;
    let markJavaStarted;
    const javaStarted = new Promise(resolve => { markJavaStarted = resolve; });
    const properLauncher = new EventEmitter();
    properLauncher.client = null;
    properLauncher.isLaunching = false;
    properLauncher.setAuthData = () => {};
    properLauncher.launchMinecraft = async () => {
      throw new Error('proper launcher must not start after Java acquisition cancellation');
    };

    const launcher = Object.create(MinecraftLauncher.prototype);
    EventEmitter.call(launcher);
    launcher.authHandler = { authData: { name: 'E2EJoiner' } };
    launcher.javaManager = {
      setClientPath() {},
      ensureJava: async (_version, _progress, options) => {
        javaSignal = options?.signal || null;
        markJavaStarted();
        if (!javaSignal) throw new Error('launch cancellation signal was not forwarded');
        await new Promise((resolve, reject) => {
          javaSignal.addEventListener('abort', () => {
            const error = new Error('Java acquisition was cancelled');
            error.code = 'CANCELLED';
            reject(error);
          }, { once: true });
        });
      }
    };
    launcher.properLauncher = properLauncher;
    launcher.client = null;
    launcher.clientPath = null;
    launcher.isLaunching = false;
    launcher._activeLauncherKind = null;
    launcher._properLaunchAttempt = null;
    launcher._properLaunchStopTimeoutMs = 1_000;

    const launchPromise = launcher.launchMinecraftProper({
      clientPath: 'C:\\disposable-client',
      minecraftVersion: '1.20.1'
    });
    await javaStarted;
    const stopResult = await launcher.stopMinecraft();
    const launchResult = await launchPromise;

    assert.ok(javaSignal instanceof AbortSignal);
    assert.equal(javaSignal.aborted, true);
    assert.equal(stopResult.success, true);
    assert.equal(launchResult.success, false);
    assert.equal(launcher._properLaunchAttempt, null);
    assert.equal(launcher.isLaunching, false);
  });
});

test('wrapper retains proper-launcher state when delegated shutdown cannot confirm exit', async () => {
  await withMinecraftLauncherClass(async MinecraftLauncher => {
    const child = createChild();
    const trackedClient = { child };
    const properLauncher = new EventEmitter();
    properLauncher.client = trackedClient;
    properLauncher.isLaunching = true;
    properLauncher.stopMinecraft = async () => ({
      success: false,
      error: 'Minecraft process did not exit after termination attempts'
    });

    const launcher = Object.create(MinecraftLauncher.prototype);
    EventEmitter.call(launcher);
    launcher.authHandler = { authData: { name: 'E2EJoiner' } };
    launcher.properLauncher = properLauncher;
    launcher.client = trackedClient;
    launcher.clientPath = null;
    launcher.isLaunching = true;
    launcher._activeLauncherKind = 'proper';

    const result = await launcher.stopMinecraft();

    assert.equal(result.success, false);
    assert.equal(launcher.client, trackedClient);
    assert.equal(launcher.isLaunching, true);
  });
});

test('legacy wrapper does not clear a tracked client on an inconclusive process error', async () => {
  await withMinecraftLauncherClass(async MinecraftLauncher => {
    const child = createChild();
    const trackedClient = { child };
    const launcher = Object.create(MinecraftLauncher.prototype);
    EventEmitter.call(launcher);
    launcher.client = trackedClient;
    launcher.isLaunching = true;
    launcher._activeLauncherKind = 'legacy';
    launcher._isProcessAlive = () => true;
    let stoppedEvents = 0;
    launcher.on('minecraft-stopped', () => {
      stoppedEvents += 1;
    });

    launcher._handleTrackedProcessError(trackedClient);

    assert.equal(launcher.client, trackedClient);
    assert.equal(launcher.isLaunching, true);
    assert.equal(stoppedEvents, 0);
  });
});
