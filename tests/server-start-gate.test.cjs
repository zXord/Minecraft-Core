const assert = require('node:assert/strict');
const { AsyncResource } = require('node:async_hooks');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  ServerMutationCoordinator
} = require('../electron/services/server-mutation-coordinator.cjs');
const {
  createServerMutationContext,
  runWithServerMutationLease,
  sharedServerMutationContext
} = require('../electron/services/server-mutation-context.cjs');
const {
  resolveLaunchPlan,
  syncServerPort
} = require('../electron/services/server-launcher.cjs');

const SERVER_PATH = 'C:\\Minecraft\\StartGate';
const INSTANCE_ID = 'start-gate-server';
const MANAGED_RUNTIME = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.15.11',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function code(expected) {
  return error => error && error.code === expected;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.closedForTest = false;
    this.spawnContext = null;
    this.stdin = new EventEmitter();
    this.stdin.writes = [];
    this.stdin.writable = true;
    this.stdin.destroyed = false;
    this.stdin.write = value => {
      this.stdin.writes.push(value);
      if (this.onStdinWrite) this.onStdinWrite(value);
      return true;
    };
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  // A real ChildProcess reports 'exit' and 'close' in the async context it was
  // spawned in, so its exit handlers still see the start lease of that launch.
  bindSpawnContext() {
    this.spawnContext = new AsyncResource('FakeChildProcess');
  }

  emitFromProcess(eventName, ...values) {
    if (!this.spawnContext) return this.emit(eventName, ...values);
    return this.spawnContext.runInAsyncScope(() => this.emit(eventName, ...values));
  }

  kill(signal = null) {
    this.killed = true;
    if (this.onKill) this.onKill(signal);
    return true;
  }

  exit(codeValue = 0, signalValue = null) {
    this.exitCode = codeValue;
    this.signalCode = signalValue;
    this.emitFromProcess('exit', codeValue, signalValue);
  }

  close(codeValue = this.exitCode, signalValue = this.signalCode) {
    if (this.closedForTest) return;
    this.closedForTest = true;
    this.emitFromProcess('close', codeValue, signalValue);
  }
}

class ManagerAttachFailureStream extends PassThrough {
  constructor() {
    super();
    this.listenerRegistrations = 0;
  }

  on(eventName, listener) {
    if (['data', 'end', 'error'].includes(eventName)) {
      this.listenerRegistrations += 1;
      if (this.listenerRegistrations === 4) throw new Error('injected manager listener failure');
    }
    return super.on(eventName, listener);
  }
}

function coordinatorFixture({ completeRecovery = true, calls = [] } = {}) {
  const context = createServerMutationContext();
  let revision = 3;
  const coordinator = new ServerMutationCoordinator({
    context,
    readContentRevision() {
      calls.push('read-revision');
      return revision;
    },
    bumpContentRevision(_serverPath, options) {
      calls.push('bump-revision');
      assert.equal(options.expectedRevision, revision);
      revision += 1;
      return revision;
    }
  });
  if (completeRecovery) coordinator.completeStartupRecovery([]);
  return {
    context,
    coordinator,
    getRevision: () => revision
  };
}

async function withServerManager(options, work) {
  const calls = options.calls || [];
  const serverPath = options.serverPath || SERVER_PATH;
  const instances = options.instances || [{ id: INSTANCE_ID, type: 'server', path: serverPath }];
  const supervisor = { installed: false, available: true, ...options.supervisor };
  const fixture = options.fixture || coordinatorFixture({
    completeRecovery: options.completeRecovery !== false,
    calls
  });
  const { context, coordinator } = fixture;
  const originalAcquireStart = coordinator.acquireStart.bind(coordinator);
  let acquiredSelector = null;
  let acquiredOptions = null;
  coordinator.acquireStart = (selectorValue, startOptions) => {
    calls.push('acquire-start');
    acquiredSelector = selectorValue;
    acquiredOptions = startOptions;
    return originalAcquireStart(selectorValue, startOptions);
  };

  const modulePath = path.resolve(__dirname, '../electron/services/server-manager.cjs');
  const processRunnerPath = path.resolve(__dirname, '../electron/services/server-process-runner.cjs');
  const originalLoad = Module._load;
  const eventBus = new EventEmitter();
  const sentMessages = [];
  const children = [];
  const planRequests = [];
  // One app-issued validation per harness: the manager and the process runner load the worker client separately.
  const issuedValidation = options.runtimeValidation || Object.freeze({ valid: true, runtime: MANAGED_RUNTIME });
  const logs = { debug: [], info: [], warn: [], error: [] };
  const logger = {
    debug(message) { logs.debug.push(message); },
    info(message) { logs.info.push(message); },
    warn(message) { logs.warn.push(message); },
    error(message) {
      logs.error.push(message);
      if (options.onLoggedError) options.onLoggedError(message);
    }
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'fs' && !options.realFs) {
      return {
        existsSync(value) {
          calls.push('exists');
          assert.equal(value, serverPath);
          return options.pathExists !== false;
        }
      };
    }
    if (request === 'child_process') {
      return {
        spawn(file, args, spawnOptions) {
          calls.push('spawn');
          if (options.spawnError) throw options.spawnError;
          const child = options.child || new FakeChild();
          child.bindSpawnContext();
          children.push(child);
          if (options.onSpawn) options.onSpawn({ file, args, spawnOptions, child });
          return child;
        }
      };
    }
    if (request.endsWith('client-process-inspector.cjs')) {
      // No process snapshots in unit tests: launch evidence is optional and never changes a start.
      return { ...originalLoad(request, parent, isMain), createClientProcessInspector: () => undefined };
    }
    if (request.endsWith('server-process-supervision-policy.cjs')) {
      return {
        enableServerProcessSupervisionRequirement() { return true; },
        getSupervisionAvailability() {
          if (!supervisor.installed) return { available: true, reason: 'not-required' };
          return supervisor.available
            ? { available: true, reason: null }
            : { available: false, reason: 'powershell-unavailable' };
        },
        isServerProcessSupervisionRequired() { return supervisor.installed; }
      };
    }
    if (request === 'pidusage') {
      return options.pidusage || (async () => ({ cpu: 0, memory: 0 }));
    }
    if (request.endsWith('server-process-runner.cjs') && options.processHandle) {
      return {
        launchServerProcess(launchRequest) {
          calls.push('spawn');
          if (options.onLaunchRequest) options.onLaunchRequest(launchRequest);
          children.push(options.processHandle.child);
          return options.processHandle;
        }
      };
    }
    if (request.endsWith('managed-runtime-worker-client.cjs')) {
      return {
        isAppIssuedManagedRuntimeValidation(value) {
          return value === issuedValidation;
        },
        async runManagedRuntimeVerificationWorker(verificationRequest) {
          calls.push('verify-runtime');
          if (options.onVerifyRuntime) options.onVerifyRuntime(verificationRequest);
          if (options.verificationError) throw options.verificationError;
          return issuedValidation;
        }
      };
    }
    // Sibling modules in electron/utils require these as './name.cjs'.
    if (request.endsWith('event-bus.cjs')) return eventBus;
    if (request.endsWith('safe-send.cjs')) {
      return {
        safeSend(channel, payload) {
          sentMessages.push({ channel, payload });
        }
      };
    }
    if (request.endsWith('app-store.cjs')) {
      return {
        get(key) {
          // The live array: a test reorders it the way the sidebar drag does.
          if (key === 'instances') return instances;
          if (key === 'lastServerPath') return serverPath;
          return null;
        },
        set() {}
      };
    }
    if (request.endsWith('config-manager.cjs')) {
      return {
        detectMinecraftVersion() {
          calls.push('detect-version');
          return '1.20.1';
        },
        getDefaultServerConfig(value) {
          return value === undefined ? { autoRestart: { enabled: false, delay: 10, maxCrashes: 3 } } : value;
        },
        readServerConfig() {
          calls.push('read-config');
          if (options.configError) throw options.configError;
          return options.config || {
            version: '1.20.1',
            loader: 'vanilla',
            loaderVersion: null,
            port: 25565,
            maxRam: 4
          };
        },
        updateServerConfig() {}
      };
    }
    if (request.endsWith('utils/server-loader.cjs')) {
      return {
        normalizeLoaderName(value) {
          return value;
        },
        resolveServerLoader() {
          calls.push('resolve-loader');
          return { loader: 'vanilla', loaderVersion: null };
        }
      };
    }
    if (request.endsWith('server-java-manager.cjs')) {
      return {
        ServerJavaManager: class FakeJavaManager {
          async getJavaRequirementsForMinecraft() {
            calls.push('java-requirements');
            return {
              isAvailable: true,
              javaPath: 'C:\\Java\\bin\\java.exe',
              needsDownload: false,
              requiredJavaVersion: 17
            };
          }
        }
      };
    }
    if (request.endsWith('server-launcher.cjs') && !options.realLauncher) {
      return {
        syncServerPort(targetPath, port, networkAccess) {
          calls.push('sync-port');
          assert.equal(targetPath, serverPath);
          assert.equal(port, 25565);
          assert.equal(networkAccess, options.config?.networkAccess || 'pack-default');
          const lease = context.getCurrentLease();
          assert.ok(lease, 'port synchronization must run inside the acquired start lease');
          lease.assertOwnedPath(targetPath);
          lease.markDirty();
        },
        resolveLaunchPlan(targetPath, planOptions, extra) {
          calls.push('resolve-launch');
          planRequests.push({ extra, planOptions, serverPath: targetPath });
          if (options.launchPlanError) throw options.launchPlanError;
          return {
            type: 'jar',
            loader: 'vanilla',
            jar: path.win32.join(serverPath, 'server.jar'),
            args: ['-Xmx4G', '-jar', 'server.jar', 'nogui'],
            cwd: serverPath,
            readyMarkers: ['Done ('],
            fatalMarkers: ['fatal'],
            runtime: null
          };
        },
        resolvePrevalidatedLaunchPlan(targetPath, planOptions, validation) {
          calls.push('resolve-prevalidated');
          if (options.onResolvePrevalidated) options.onResolvePrevalidated({ planOptions, serverPath: targetPath, validation });
          if (options.launchPlanError) throw options.launchPlanError;
          return {
            type: 'jar',
            loader: planOptions.loader,
            jar: path.win32.join(serverPath, 'fabric-server-launch.jar'),
            args: ['-Xmx4G', '-jar', 'fabric-server-launch.jar', 'nogui'],
            cwd: serverPath,
            readyMarkers: ['Done ('],
            fatalMarkers: ['fatal'],
            runtime: validation.runtime
          };
        }
      };
    }
    if (request.endsWith('server-mutation-context.cjs')) {
      return {
        getCurrentServerMutationLease() {
          const lease = context.getCurrentLease();
          return lease && lease.kind === 'mutation' ? lease : null;
        },
        getServerMutationCoordinator() {
          return coordinator;
        },
        markCurrentServerMutationDirty(targetPath) {
          return context.markCurrentDirty(targetPath);
        },
        runWithServerMutationLease(lease, callback) {
          return context.runWithLease(lease, callback);
        }
      };
    }
    if (request.endsWith('logger-handlers.cjs')) {
      return {
        getLoggerHandlers() {
          return logger;
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];
  delete require.cache[processRunnerPath];
  try {
    const serverManager = require(modulePath);
    return await work({
      acquired: () => ({ options: acquiredOptions, selector: acquiredSelector }),
      calls,
      children,
      coordinator,
      eventBus,
      fixture,
      instances,
      logs,
      planRequests,
      sentMessages,
      serverManager,
      serverLines: () => sentMessages
        .filter(message => message.channel === 'server-log' && typeof message.payload?.line === 'string')
        .map(message => message.payload.line),
      status: (instanceId = INSTANCE_ID) => serverManager.getServerState({ instanceId }).status
    });
  } finally {
    const serverManager = require.cache[modulePath]?.exports;
    if (serverManager) {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.exit(0, null);
        child.close();
      }
      serverManager.clearIntervals();
      for (const instance of instances) {
        serverManager.disposeServerState({ instanceId: instance.id, targetPath: instance.path });
      }
      serverManager.disposeServerState({ instanceId: INSTANCE_ID, targetPath: serverPath });
    }
    delete require.cache[modulePath];
    delete require.cache[processRunnerPath];
    Module._load = originalLoad;
  }
}

function managedConfig(overrides = {}) {
  return {
    modpackManaged: true,
    runtime: MANAGED_RUNTIME,
    version: MANAGED_RUNTIME.minecraftVersion,
    loader: MANAGED_RUNTIME.loaderFamily,
    loaderVersion: MANAGED_RUNTIME.loaderVersion,
    port: 25565,
    maxRam: 4,
    ...overrides
  };
}

// The installed app watchdog answers every ownership request; `ready` settles when its watcher arms.
function acknowledgeOwnership(eventBus, ready, requests = []) {
  eventBus.on('server-process-owned', request => {
    requests.push(request);
    request.acknowledge({
      instanceId: request.instanceId,
      operationId: request.operationId,
      pid: request.pid,
      ready
    });
  });
  return requests;
}

test('start acquires the shared gate before every server read, write, Java step, resolution, and spawn', async () => {
  const calls = [];
  await withServerManager({ calls }, async ({ acquired, children, eventBus, serverManager }) => {
    const supplied = {
      acquireStart() {
        assert.fail('renderer-supplied coordinator was used');
      }
    };
    let startedEvent = null;
    eventBus.once('server-started', value => {
      startedEvent = value;
    });
    const result = await serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH,
      port: 25565,
      maxRam: 4,
      coordinator: supplied,
      parentMutationLease: supplied,
      revisionFunction: supplied,
      recoveryOutcome: supplied
    });

    assert.deepEqual(
      calls.filter(value => [
        'acquire-start', 'read-revision', 'exists', 'read-config', 'resolve-loader',
        'sync-port', 'java-requirements', 'resolve-launch', 'spawn', 'bump-revision'
      ].includes(value)),
      [
        'acquire-start', 'read-revision', 'exists', 'read-config', 'resolve-loader',
        'sync-port', 'java-requirements', 'resolve-launch', 'spawn', 'bump-revision'
      ]
    );
    assert.equal(calls.includes('verify-runtime'), false);
    assert.equal(calls.includes('resolve-prevalidated'), false);
    assert.deepEqual(acquired().selector, { instanceId: INSTANCE_ID, serverPath: SERVER_PATH });
    assert.equal(acquired().options.operation, 'server-start');
    assert.match(acquired().options.operationId, /^server-start-[A-Za-z0-9_-]{1,120}$/);
    assert.equal(acquired().options.parentMutationLease, null);
    assert.deepEqual(result, {
      success: true,
      instanceId: INSTANCE_ID,
      pid: 4242,
      javaPath: 'C:\\Java\\bin\\java.exe',
      jar: 'C:\\Minecraft\\StartGate\\server.jar',
      loader: 'vanilla'
    });

    // v26.6.1 parity: an ordinary server is running as soon as its process is spawned.
    assert.equal(startedEvent?.instanceId, INSTANCE_ID);
    assert.equal(startedEvent?.pid, 4242);
    children[0].stdout.write('Done (1.23s)! For help, type "help"\n');
    await flush();
    assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).status, 'running');
  });
});

test('forced stop terminates only the retained server ChildProcess handle', async () => {
  const child = new FakeChild(4242);
  const killSignals = [];
  child.onKill = signal => killSignals.push(signal);

  await withServerManager({ child }, async ({ serverManager }) => {
    const started = await serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH,
      port: 25565,
      maxRam: 4
    });
    assert.equal(started.success, true);

    assert.equal(serverManager.killMinecraftServer({ instanceId: INSTANCE_ID }), true);
    assert.deepEqual(killSignals, ['SIGKILL']);
  });
});

test('an ordinary server is running and announced at spawn; ready markers are informational', async () => {
  await withServerManager({}, async ({ children, eventBus, logs, sentMessages, serverLines, serverManager, status }) => {
    const started = [];
    eventBus.on('server-started', event => started.push(event));
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true);
    assert.equal(status(), 'running');
    assert.equal(started.length, 1);
    assert.equal(started[0].pid, 4242);
    const announced = sentMessages.filter(message => message.channel === 'server-status').at(-1).payload;
    assert.deepEqual([announced.status, announced.isRunning], ['running', true]);

    // A proxy or custom jar that never prints a vanilla ready marker stays running.
    children[0].stdout.write('Listening on /0.0.0.0:25565\n');
    await flush();
    assert.equal(status(), 'running');
    children[0].stdout.write('Done (2.0s)! For help, type "help"\n');
    await flush();
    assert.equal(status(), 'running');
    assert.equal(started.length, 1, 'the ready marker does not announce the server again');
    // Without an installed watchdog supervisor (tests, E2E) nothing is reported.
    assert.deepEqual(serverLines().filter(line => line.startsWith('[WARNING]')), []);
    assert.deepEqual(logs.warn, []);
  });
});

test('a fatal-marker substring never flips a live ordinary server to error', async () => {
  const child = new FakeChild(4343);
  const killSignals = [];
  child.onKill = signal => killSignals.push(signal);
  await withServerManager({ child }, async ({ serverManager, status }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true);
    child.stdout.write('[Server thread/WARN]: a mod logged a fatal-looking line while loading\n');
    child.stderr.write('java.lang.IllegalStateException: fatal config value, using the default\n');
    await flush();
    assert.equal(status(), 'running');
    assert.deepEqual(killSignals, []);
    assert.equal(serverManager.stopMinecraftServer({ instanceId: INSTANCE_ID }), true, 'Stop stays available');
    assert.deepEqual(child.stdin.writes, ['stop\n']);
  });
});

test('a watchdog fault on an ordinary server is reported once and never stops it', async () => {
  const child = new FakeChild(4444);
  const killSignals = [];
  child.onKill = signal => killSignals.push(signal);
  await withServerManager({ child, supervisor: { installed: true } }, async ({
    eventBus, logs, serverLines, serverManager, status
  }) => {
    const requests = acknowledgeOwnership(eventBus, Promise.resolve());
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true);
    await flush();
    assert.equal(requests.length, 1);
    // Task Manager or antivirus ends the PowerShell watcher after it armed.
    requests[0].onSupervisionFailure(requests[0], new Error('watchdog exited unexpectedly (1/null)'));
    await flush();
    assert.deepEqual(killSignals, []);
    assert.equal(child.killed, false);
    assert.equal(status(), 'running');
    const warnings = serverLines().filter(line => line.startsWith('[WARNING]'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /watchdog exited unexpectedly/);
    assert.equal(logs.warn.length, 1);
  });
});

test('an ordinary server starts and keeps running when PowerShell is unavailable', async () => {
  const child = new FakeChild(4545);
  const killSignals = [];
  child.onKill = signal => killSignals.push(signal);
  await withServerManager({ child, supervisor: { installed: true, available: false } }, async ({
    calls, logs, serverLines, serverManager, status
  }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true);
    assert.ok(calls.includes('spawn'));
    await flush();
    assert.deepEqual(killSignals, []);
    assert.equal(status(), 'running');
    assert.equal(serverLines().filter(line => line.startsWith('[WARNING]')).length, 1);
    assert.equal(logs.warn.length, 1);
  });
});

test('a managed server is running only once its watchdog is armed and its ready marker appears', async () => {
  const arm = deferred();
  const child = new FakeChild(5050);
  await withServerManager({ child, config: managedConfig(), supervisor: { installed: true } }, async ({
    eventBus, sentMessages, serverManager, status
  }) => {
    acknowledgeOwnership(eventBus, arm.promise);
    const started = [];
    eventBus.on('server-started', event => started.push(event));
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true);
    assert.equal(status(), 'starting');
    // The renderer learns that a process is live while the managed start is pending, so Kill stays usable.
    const pending = sentMessages.filter(message => message.channel === 'server-status').at(-1).payload;
    assert.deepEqual([pending.status, pending.isRunning], ['starting', true]);

    child.stdout.write('[Server thread/INFO]: Done (12.0s)! For help, type "help"\n');
    await flush();
    assert.equal(status(), 'starting');
    assert.equal(started.length, 0);
    arm.resolve({ instanceId: INSTANCE_ID });
    await flush();
    assert.equal(status(), 'running');
    assert.equal(started.length, 1);
    assert.deepEqual(child.stdin.writes, []);
  });
});

test('a late watchdog ACK inside the grace period still makes a managed server running', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const arm = deferred();
  const child = new FakeChild(5151);
  await withServerManager({ child, config: managedConfig(), supervisor: { installed: true } }, async ({
    eventBus, serverManager, status
  }) => {
    const requests = acknowledgeOwnership(eventBus, arm.promise);
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true);
    assert.equal(typeof requests[0]?.onSupervisionDeadline, 'function', 'managed starts request best-effort supervision');
    // The supervisor's ACK deadline passes during a cold login start; its watcher is kept alive.
    requests[0].onSupervisionDeadline(requests[0], new Error('Watchdog ACK deadline exceeded'));
    await flush();
    child.stdout.write('Done (40.0s)! For help, type "help"\n');
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(status(), 'starting');
    arm.resolve({ instanceId: INSTANCE_ID });
    await flush();
    assert.equal(status(), 'running');
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(status(), 'running');
    assert.deepEqual(child.stdin.writes, []);
  });
});

test('a managed server whose watchdog cannot arm is stopped normally and never SIGKILLed, even after a long startup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const arm = deferred();
  const child = new FakeChild(5252);
  const killSignals = [];
  child.onKill = signal => killSignals.push(signal);
  await withServerManager({ child, config: managedConfig(), supervisor: { installed: true } }, async ({
    eventBus, serverLines, serverManager, status
  }) => {
    acknowledgeOwnership(eventBus, arm.promise);
    const events = [];
    for (const name of ['server-started', 'server-crashed', 'server-normal-exit']) {
      eventBus.on(name, () => events.push(name));
    }
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true);
    arm.reject(new Error('watchdog arm failed'));
    await flush();
    assert.deepEqual(killSignals, []);

    // A large modpack is still loading its world after more than a minute.
    t.mock.timers.tick(61_000);
    await flush();
    assert.deepEqual(child.stdin.writes, []);
    assert.equal(status(), 'starting');

    child.stdout.write('[Server thread/INFO]: Done (93.2s)! For help, type "help"\n');
    await flush();
    t.mock.timers.tick(59_000);
    await flush();
    assert.deepEqual(child.stdin.writes, []);
    assert.equal(status(), 'starting');
    t.mock.timers.tick(1_000);
    await flush();
    assert.deepEqual(child.stdin.writes, ['stop\n']);
    assert.equal(status(), 'stopping');
    assert.equal(serverLines().filter(line => line.startsWith('[ERROR]') && /crash protection/i.test(line)).length, 1);

    // Saving a big world can take minutes; nothing escalates to a hard kill.
    t.mock.timers.tick(10 * 60_000);
    await flush();
    assert.deepEqual(killSignals, []);
    assert.equal(child.killed, false);

    child.exit(1, null);
    child.close(1, null);
    await flush();
    assert.equal(status(), 'stopped');
    assert.deepEqual(events, ['server-normal-exit'], 'a safety stop is a normal exit: no crash event, no auto-restart');
  });
});

test('a user stop while a managed server waits for its watchdog replaces the safety stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakeChild(5353);
  await withServerManager({ child, config: managedConfig(), supervisor: { installed: true } }, async ({
    eventBus, serverLines, serverManager, status
  }) => {
    acknowledgeOwnership(eventBus, new Promise(() => {}));
    const started = [];
    eventBus.on('server-started', event => started.push(event));
    assert.equal((await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH })).success, true);
    child.stdout.write('Done (8.0s)! For help, type "help"\n');
    await flush();
    assert.equal(serverManager.stopMinecraftServer({ instanceId: INSTANCE_ID }), true);
    t.mock.timers.tick(5 * 60_000);
    await flush();
    assert.deepEqual(child.stdin.writes, ['stop\n']);
    assert.equal(status(), 'stopping');
    assert.deepEqual(started, []);
    assert.deepEqual(serverLines().filter(line => line.startsWith('[ERROR]')), []);
  });
});

test('a managed start is refused before Java starts when PowerShell is unavailable', async () => {
  const calls = [];
  await withServerManager({
    calls,
    config: managedConfig(),
    supervisor: { installed: true, available: false }
  }, async ({ coordinator, serverManager, status }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Modpack servers need Windows PowerShell for crash protection; it is blocked or missing on this PC.');
    assert.equal(calls.includes('spawn'), false);
    assert.equal(calls.includes('verify-runtime'), false);
    assert.equal(calls.includes('sync-port'), false);
    assert.equal(status(), 'error');
    const next = await coordinator.acquireStart(
      { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
      { operation: 'test-start', operationId: 'after-watchdog-refusal', parentMutationLease: null }
    );
    next.release();
  });
});

test('managed runtime drift tells the user to use Modpack Verify and Repair', async () => {
  const changed = 'Modpack runtime files changed - use Modpack Verify and Repair';
  const verificationError = Object.assign(new Error('managed runtime verification failed'), { code: 'RUNTIME_INCOMPLETE' });
  await withServerManager({ config: managedConfig(), verificationError }, async ({ serverLines, serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.code, 'RUNTIME_INCOMPLETE');
    assert.equal(result.error, changed);
    assert.ok(serverLines().includes(`[ERROR] ${changed}`));
  });

  const launchPlanError = Object.assign(new Error('The prepared server runtime is incomplete.'), { code: 'RUNTIME_INCOMPLETE' });
  await withServerManager({ config: managedConfig(), launchPlanError }, async ({ calls, serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.code, 'RUNTIME_INCOMPLETE');
    assert.equal(result.error, changed);
    assert.equal(calls.includes('spawn'), false);
  });

  const runtimeConfig = managedConfig({ runtime: { ...MANAGED_RUNTIME, loaderFamily: 'paper' } });
  await withServerManager({ config: runtimeConfig }, async ({ calls, serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.code, 'RUNTIME_INCOMPLETE');
    assert.equal(result.error, changed);
    assert.equal(calls.includes('spawn'), false);
  });
});

test('unmanaged launch-plan failures keep their own actionable message', async () => {
  const failures = [
    ['FORGE_LAUNCH_ASSETS_MISSING', 'Forge launch assets are missing. Repair the server before starting it.'],
    ['FABRIC_LAUNCH_JAR_MISSING', 'Fabric server launcher is missing. Repair Fabric before starting the server.'],
    ['FABRIC_BROKEN', 'Fabric runtime is incomplete.', [{ type: 'fabric-library' }]],
    ['SERVER_JAR_MISSING', 'No valid server jar was found in the selected server folder.'],
    ['UNSUPPORTED_LOADER', 'Unsupported loader: liteloader'],
    ['RUNTIME_INCOMPLETE', 'The prepared server runtime is incomplete.']
  ];
  for (const [errorCode, message, details] of failures) {
    const launchPlanError = Object.assign(new Error(message), { code: errorCode }, details ? { details } : {});
    await withServerManager({ launchPlanError }, async ({ coordinator, serverLines, serverManager }) => {
      const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
      assert.equal(result.success, false, errorCode);
      assert.equal(result.code, errorCode);
      assert.equal(result.error, message);
      assert.deepEqual(result.details, details || null);
      assert.ok(serverLines().includes(`[ERROR] ${message}`), errorCode);
      const next = await coordinator.acquireStart(
        { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
        { operation: 'test-start', operationId: `after-${errorCode.toLowerCase()}`, parentMutationLease: null }
      );
      next.release();
    });
  }

  await withServerManager({ launchPlanError: new Error('plan resolution exploded') }, async ({ serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.code, 'SERVER_START_FAILED');
    assert.equal(result.error, 'Server process failed to launch');
  });
});

test('a v26.6.1 Forge server without launch assets reports the v26.6.1 message through the real launcher', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-start-gate-forge-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await withServerManager({
    serverPath: root,
    realFs: true,
    realLauncher: true,
    config: { version: '1.20.1', loader: 'forge', loaderVersion: '47.2.0', port: 25565, maxRam: 4 }
  }, async ({ calls, serverLines, serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: root });
    assert.equal(result.success, false);
    assert.equal(result.code, 'FORGE_LAUNCH_ASSETS_MISSING');
    assert.equal(result.error, 'Forge launch assets are missing. Repair the server before starting it.');
    assert.equal(calls.includes('spawn'), false);
    assert.ok(serverLines().includes('[ERROR] Forge launch assets are missing. Repair the server before starting it.'));
  });
});

test('an unmanaged server labelled paper launches its server.jar and keeps its label', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-start-gate-paper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'server.jar'), 'paperclip bytes');
  const spawned = [];
  await withServerManager({
    serverPath: root,
    realFs: true,
    realLauncher: true,
    config: { version: '1.20.1', loader: 'paper', loaderVersion: null, port: 25565, maxRam: 4 },
    onSpawn: value => spawned.push(value)
  }, async ({ children, serverManager, status }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: root });
    assert.equal(result.success, true, result.error);
    assert.equal(result.loader, 'paper');
    const jarIndex = spawned[0].args.indexOf('-jar');
    assert.ok(jarIndex > 0);
    assert.equal(spawned[0].args[jarIndex + 1], path.join(root, 'server.jar'));
    assert.equal(spawned[0].spawnOptions.cwd, root);
    assert.equal(status(), 'running');
    assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).loader, 'paper');
    assert.equal(children[0].serverInfo.loader, 'paper');
  });
});

test('an unmanaged snapshot version starts under the legacy runtime contract', async () => {
  await withServerManager({
    config: { version: '24w14a', loader: 'vanilla', loaderVersion: null, port: 25565, maxRam: 4 }
  }, async ({ planRequests, serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true, result.error);
    assert.equal(planRequests[0].planOptions.minecraftVersion, '24w14a');
    assert.equal(planRequests[0].extra.runtimeTuple.minecraftVersion, '24w14a');
    assert.equal(planRequests[0].extra.runtimeTuple.loaderFamily, 'vanilla');
  });
});

test('auto-restart from the crashed server exit handler is admitted by the start gate', async () => {
  const restarted = deferred();
  const gateRejected = deferred();
  const spawned = [];
  await withServerManager({
    config: {
      version: '1.20.1',
      loader: 'vanilla',
      loaderVersion: null,
      port: 25565,
      maxRam: 4,
      autoRestart: { enabled: true, delay: 0, maxCrashes: 3 }
    },
    onSpawn({ child }) {
      spawned.push(child);
      if (spawned.length === 2) restarted.resolve(child);
    },
    onLoggedError(message) {
      if (/start gate rejected/i.test(message)) gateRejected.resolve(message);
    }
  }, async ({ eventBus, serverManager }) => {
    const autoRestartPath = path.resolve(__dirname, '../electron/services/auto-restart.cjs');
    delete require.cache[autoRestartPath];
    const autoRestart = require(autoRestartPath);
    try {
      autoRestart.initializeAutoRestartListeners();
      autoRestart.initFromServerConfig(SERVER_PATH);
      const first = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
      assert.equal(first.success, true);
      const crashed = new Promise(resolve => eventBus.once('server-crashed', resolve));
      // The crash is reported in the async context the server was spawned in.
      spawned[0].exit(1, null);
      spawned[0].close(1, null);
      await crashed;
      const outcome = await Promise.race([
        restarted.promise.then(child => ({ child })),
        gateRejected.promise.then(message => ({ message })),
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 10_000))
      ]);
      assert.equal(outcome.message, undefined, outcome.message);
      assert.ok(outcome.child, 'auto-restart spawned the server again');
      assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).serverProcess, outcome.child);
    } finally {
      autoRestart.disposeAutoRestartListeners();
      delete require.cache[autoRestartPath];
    }
  });
});

test('duplicate registrations of one folder start through one coordinator identity after a sidebar reorder', async () => {
  const instances = [
    { id: 'server-1', type: 'server', path: SERVER_PATH },
    { id: 'server-2', type: 'server', path: SERVER_PATH }
  ];
  await withServerManager({ instances }, async ({ children, coordinator, serverManager }) => {
    const startAndStop = async instanceId => {
      const result = await serverManager.startMinecraftServer({ instanceId, targetPath: SERVER_PATH });
      assert.equal(result.success, true, `${instanceId}: ${result.error}`);
      const child = children.at(-1);
      child.exit(0, null);
      child.close(0, null);
      await flush();
      assert.equal(serverManager.getServerState({ instanceId }).serverProcess, null);
    };
    await startAndStop('server-2');
    instances.reverse(); // The user drags S2 above S1 in the sidebar.
    await startAndStop('server-1');
    await startAndStop('server-2');
    assert.deepEqual(coordinator.pathBinding(SERVER_PATH), { instanceId: 'server-1' });
  });
});

test('a folder registered as a client and a server starts its server in either sidebar order', async () => {
  const instances = [
    { id: 'client-c', type: 'client', path: SERVER_PATH },
    { id: 'server-s', type: 'server', path: SERVER_PATH }
  ];
  await withServerManager({ instances }, async ({ children, coordinator, serverManager }) => {
    // A client-side write reached the coordinator first and bound the folder to the client's id.
    await coordinator.runMutation(
      { instanceId: 'client-c', serverPath: SERVER_PATH },
      { operation: 'client-write', operationId: 'client-write', revisionMode: 'none', quiesce: null },
      async () => {}
    );
    for (const order of ['client listed first', 'server listed first']) {
      const result = await serverManager.startMinecraftServer({ instanceId: 'server-s', targetPath: SERVER_PATH });
      assert.equal(result.success, true, `${order}: ${result.error}`);
      const child = children.at(-1);
      child.exit(0, null);
      child.close(0, null);
      await flush();
      instances.reverse();
    }
  });
});

test('a server whose folder is a drive root starts', async () => {
  const driveRoot = 'E:\\';
  await withServerManager({ serverPath: driveRoot }, async ({ acquired, serverManager, status }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: driveRoot });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(acquired().selector, { instanceId: INSTANCE_ID, serverPath: driveRoot });
    assert.equal(status(), 'running');
  });
});

test('shutdown results record whether the graceful stop reached the server', async () => {
  const quickStop = { gracefulTimeoutMs: 10, killTimeoutMs: 10, forceKill: false };
  await withServerManager({}, async ({ children, serverManager }) => {
    assert.equal((await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH })).success, true);
    const saving = await serverManager.shutdownMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH }, quickStop);
    assert.equal(saving.success, false);
    assert.equal(saving.results[0].stopped, false);
    assert.equal(saving.results[0].gracefulRequested, true);
    assert.deepEqual(children[0].stdin.writes, ['stop\n']);
  });

  await withServerManager({}, async ({ children, serverManager }) => {
    assert.equal((await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH })).success, true);
    children[0].stdin.destroyed = true;
    const undeliverable = await serverManager.shutdownMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH }, quickStop);
    assert.equal(undeliverable.success, false);
    assert.equal(undeliverable.results[0].gracefulRequested, false);
    assert.deepEqual(children[0].stdin.writes, []);
  });
});

test('stop-server reports a large world that is still saving after 60 s as stopping', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const handlersPath = path.resolve(__dirname, '../electron/ipc/server-handlers.cjs');
  await withServerManager({}, async ({ children, serverManager, status }) => {
    delete require.cache[handlersPath];
    try {
      const { createServerHandlers } = require(handlersPath);
      const stopServer = createServerHandlers()['stop-server'];
      assert.equal((await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH })).success, true);
      const stopping = stopServer({}, { instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
      await flush();
      assert.deepEqual(children[0].stdin.writes, ['stop\n']);
      t.mock.timers.tick(60_000);
      assert.deepEqual(await stopping, { success: true, stopping: true, forced: false, alreadyStopped: false });
      assert.equal(status(), 'stopping');
      assert.equal(children[0].killed, false);

      children[0].exit(0, null);
      children[0].close(0, null);
      await flush();
      assert.equal(status(), 'stopped');
    } finally {
      delete require.cache[handlersPath];
    }
  });
});

test('all five managed loader families verify asynchronously and bypass synchronous runtime discovery', async () => {
  const loaderVersions = {
    vanilla: '1.20.1',
    fabric: '0.15.11',
    forge: '47.3.12',
    neoforge: '20.1.137',
    quilt: '0.28.1'
  };

  for (const [loaderFamily, loaderVersion] of Object.entries(loaderVersions)) {
    const runtime = Object.freeze({ ...MANAGED_RUNTIME, loaderFamily, loaderVersion });
    const validation = Object.freeze({ valid: true, runtime });
    const calls = [];
    let verificationRequest = null;
    let prevalidatedRequest = null;
    await withServerManager({
      calls,
      config: {
        modpackManaged: true,
        runtime,
        version: runtime.minecraftVersion,
        loader: runtime.loaderFamily,
        loaderVersion: runtime.loaderVersion,
        port: 25565,
        maxRam: 4
      },
      runtimeValidation: validation,
      onVerifyRuntime(request) {
        verificationRequest = request;
      },
      onResolvePrevalidated(request) {
        prevalidatedRequest = request;
      }
    }, async ({ serverManager }) => {
      const result = await serverManager.startMinecraftServer({
        instanceId: INSTANCE_ID,
        targetPath: SERVER_PATH
      });

      assert.equal(result.success, true, loaderFamily);
      assert.equal(result.loader, loaderFamily);
      assert.deepEqual(verificationRequest, { targetPath: SERVER_PATH, runtime });
      assert.equal(prevalidatedRequest.validation, validation);
      assert.deepEqual(prevalidatedRequest.planOptions, {
        javaMajor: runtime.javaMajor,
        loader: runtime.loaderFamily,
        loaderVersion: runtime.loaderVersion,
        maxRam: 4,
        minecraftVersion: runtime.minecraftVersion
      });
      assert.equal(calls.includes('resolve-loader'), false);
      assert.equal(calls.includes('detect-version'), false);
      assert.equal(calls.includes('resolve-launch'), false);
      assert.ok(calls.indexOf('verify-runtime') < calls.indexOf('resolve-prevalidated'));
      assert.ok(calls.indexOf('resolve-prevalidated') < calls.indexOf('spawn'));
    });
  }
});

test('managed verification failure releases the start gate and never enters launch resolution', async () => {
  const calls = [];
  const verificationError = new Error('managed runtime verification failed');
  verificationError.code = 'RUNTIME_INCOMPLETE';
  await withServerManager({
    calls,
    config: {
      modpackManaged: true,
      runtime: MANAGED_RUNTIME,
      version: MANAGED_RUNTIME.minecraftVersion,
      loader: MANAGED_RUNTIME.loaderFamily,
      loaderVersion: MANAGED_RUNTIME.loaderVersion,
      port: 25565,
      maxRam: 4
    },
    verificationError
  }, async ({ coordinator, serverManager }) => {
    const result = await serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH
    });

    assert.equal(result.success, false);
    assert.equal(result.code, 'RUNTIME_INCOMPLETE');
    assert.equal(calls.includes('resolve-loader'), false);
    assert.equal(calls.includes('resolve-prevalidated'), false);
    assert.equal(calls.includes('resolve-launch'), false);
    assert.equal(calls.includes('spawn'), false);
    const next = await coordinator.acquireStart(
      { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
      { operation: 'test-start', operationId: 'after-managed-verification-failure', parentMutationLease: null }
    );
    next.release();
  });
});

async function withRetainedLifecycleHandoff(options, work) {
  const fixture = coordinatorFixture();
  const initialPath = options.initialPath || SERVER_PATH;
  const bound = await fixture.coordinator.acquireStart(
    { instanceId: INSTANCE_ID, serverPath: initialPath },
    { operation: 'bind-handoff-root', operationId: 'bind-handoff-root', parentMutationLease: null }
  );
  bound.release();
  await withServerManager({ fixture: options.managerFixture || fixture }, async harness => {
    const policyPath = path.resolve(__dirname, '../electron/services/auto-restart.cjs');
    delete require.cache[policyPath];
    const { createRecoveryRuntimePolicy } = require(policyPath);
    const policy = createRecoveryRuntimePolicy({ runtimeController: {
      async ensureStopped() { assert.fail('adoption must not stop a process'); },
      adoptValidatedHandoff: request => harness.serverManager.adoptValidatedLifecycleProcess(request)
    } });
    const child = new FakeChild(8383);
    const closed = deferred();
    child.once('close', (exitCode, signal) => closed.resolve({ exitCode, signal }));
    let startLease;
    try {
      if (options.beforeMutation) await options.beforeMutation(harness);
      await fixture.coordinator.runMutation(
        { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
        { operation: 'handoff-test', operationId: 'handoff-test', revisionMode: 'none', quiesce: null },
        async mutationLease => {
          startLease = await fixture.coordinator.acquireStart(
            { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
            { operation: options.operation || 'server-health-live', operationId: 'health-handoff-test', parentMutationLease: mutationLease }
          );
          const processHandle = Object.freeze({
            child, closed: closed.promise, pid: child.pid,
            operationId: 'health-handoff-test', publishEvents: false,
            supervisionReady: Promise.resolve({}),
            launchPlan: Object.freeze({
              type: 'jar', loader: 'vanilla', jar: `${SERVER_PATH}\\server.jar`, cwd: SERVER_PATH,
              readyMarkers: ['Done ('], fatalMarkers: ['fatal'],
              runtime: { minecraftVersion: '1.20.1', loaderFamily: 'vanilla', loaderVersion: '1.20.1', javaMajor: 17 }
            }),
            isLive: () => child.exitCode === null && child.signalCode === null && !child.killed
          });
          const request = {
            eventId: 'modpack-runtime-handoff:handoff-test', jobId: 'handoff-test',
            instanceId: INSTANCE_ID, serverPath: SERVER_PATH,
            handoff: { processHandle, startLease }
          };
          await work({ ...harness, child, coordinator: fixture.coordinator, mutationLease, policy, request });
        }
      );
    } finally {
      child.exit(0, null);
      child.close();
      await new Promise(resolve => setImmediate(resolve));
      startLease?.release();
      delete require.cache[policyPath];
    }
  });
}

for (const [label, initialPath] of [['same spelling', SERVER_PATH], ['case-only alias', 'c:\\minecraft\\startgate']]) {
  test(`real retained lifecycle handoff adopts ${label} and releases ownership only after close`, async () => {
    await withRetainedLifecycleHandoff({ initialPath }, async ({ child, coordinator, eventBus, mutationLease, policy, request, serverManager }) => {
      assert.equal(request.handoff.startLease.serverPath, label === 'same spelling' ? SERVER_PATH : 'C:\\minecraft\\startgate');
      const events = [];
      eventBus.on('server-process-owned', event => events.push(['owned', event.pid]));
      eventBus.on('server-started', event => events.push(['started', event.pid]));
      assert.deepEqual(await policy.adoptValidatedHandoff(request), { adopted: true, instanceId: INSTANCE_ID, pid: 8383 });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events, [['owned', 8383], ['started', 8383]]);
      assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).serverProcess, child);
      assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).status, 'running');
      const acquireNext = () => coordinator.acquireStart(
        { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
        { operation: 'next-start', operationId: 'next-start', parentMutationLease: mutationLease }
      );
      await assert.rejects(acquireNext, code('OPERATION_IN_PROGRESS'));
      child.exit(0, null);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).status, 'stopping');
      await assert.rejects(acquireNext, code('OPERATION_IN_PROGRESS'));
      child.close();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).serverProcess, null);
      assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).status, 'stopped');
      const next = await acquireNext();
      next.release();
    });
  });
}

test('validated lifecycle adoption repeats the same event across case-only root aliases without duplicate ownership', async () => {
  await withRetainedLifecycleHandoff({}, async ({ eventBus, request, serverManager }) => {
    let owned = 0;
    eventBus.on('server-process-owned', () => { owned += 1; });
    const first = serverManager.adoptValidatedLifecycleProcess(request);
    const second = serverManager.adoptValidatedLifecycleProcess({ ...request, serverPath: 'c:\\minecraft\\startgate' });
    assert.equal(first, second);
    assert.equal(owned, 1);
    for (const serverPath of ['C:\\Other\\StartGate', 'C:\\Minecraft\\StartGateSibling', `${SERVER_PATH}\\child`, 'relative', `${SERVER_PATH}\\..\\StartGate`, '\\\\?\\C:\\Minecraft\\StartGate', 'C:\\', '', null, undefined]) {
      assert.throws(() => serverManager.adoptValidatedLifecycleProcess({ ...request, serverPath }), /handoff|directory/i);
    }
    request.handoff.processHandle.child.exit(0, null);
    assert.throws(() => serverManager.adoptValidatedLifecycleProcess(request), /stale/i);
  });
});

test('validated lifecycle adoption rejects non-exact and unsafe roots before taking ownership', async () => {
  await withRetainedLifecycleHandoff({}, async ({ request, serverManager }) => {
    for (const serverPath of ['C:\\Other\\StartGate', 'C:\\Minecraft\\StartGateSibling', `${SERVER_PATH}\\child`, 'relative', `${SERVER_PATH}\\..\\StartGate`, '\\\\?\\C:\\Minecraft\\StartGate', 'C:\\', `${SERVER_PATH}\0`, '', null, undefined]) {
      assert.throws(() => serverManager.adoptValidatedLifecycleProcess({ ...request, serverPath }), /handoff|directory/i);
      assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).serverProcess, null);
    }
    assert.throws(() => serverManager.adoptValidatedLifecycleProcess({ ...request, instanceId: 'wrong-instance' }), /handoff/i);
    assert.throws(() => serverManager.adoptValidatedLifecycleProcess({ ...request, jobId: 'wrong-job' }), /handoff/i);
    assert.throws(() => serverManager.adoptValidatedLifecycleProcess({
      ...request,
      handoff: { ...request.handoff, processHandle: { ...request.handoff.processHandle, operationId: 'wrong-operation-id' } }
    }), /cannot be proven/i);
    assert.throws(() => serverManager.adoptValidatedLifecycleProcess({
      ...request,
      handoff: { ...request.handoff, startLease: {
        ...request.handoff.startLease,
        assertOwnedPath() { throw new Error('ownership assertion failed'); }
      } }
    }), /ownership assertion failed/);
    assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).serverProcess, null);
  });
});

test('validated lifecycle adoption rejects the wrong retained lease operation', async () => {
  await withRetainedLifecycleHandoff({ operation: 'server-start' }, async ({ request, serverManager }) => {
    assert.throws(() => serverManager.adoptValidatedLifecycleProcess(request), /cannot be proven/i);
    assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).serverProcess, null);
  });
});

test('validated lifecycle adoption excludes a managed owner under a different instance and case-only root alias', async () => {
  // Independent real lease fixture isolates the manager's collision defense from
  // the coordinator's earlier alias/instance rejection. No real child is spawned.
  await withRetainedLifecycleHandoff({
    managerFixture: coordinatorFixture(),
    async beforeMutation({ serverManager }) {
      const started = await serverManager.startMinecraftServer({ instanceId: 'existing-owner', targetPath: SERVER_PATH });
      assert.equal(started.success, true);
    }
  }, async ({ child, request, serverManager }) => {
    const existing = serverManager.getServerState({ instanceId: 'existing-owner' }).serverProcess;
    assert.ok(existing);
    assert.throws(() => serverManager.adoptValidatedLifecycleProcess({ ...request, serverPath: 'c:\\minecraft\\startgate' }), /different managed process/i);
    assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).serverProcess, null);
    assert.equal(serverManager.getServerState({ instanceId: 'existing-owner' }).serverProcess, existing);
    assert.equal(serverManager.getServerState({ instanceId: 'existing-owner' }).status, 'running');
    assert.notEqual(existing, child);
  });
});

test('a later watchdog fault on an adopted lifecycle server warns and kills nothing', async () => {
  const child = new FakeChild(8484);
  const killSignals = [];
  child.onKill = signal => killSignals.push(signal);
  const closeGate = deferred();
  const handleSupervision = deferred();
  let relaxed = 0;
  child.once('close', (exitCode, signal) => closeGate.resolve({ exitCode, signal }));
  const processHandle = Object.freeze({
    child,
    closed: closeGate.promise,
    pid: child.pid,
    operationId: 'health-live-job-relaxed',
    publishEvents: false,
    supervisionReady: handleSupervision.promise,
    launchPlan: Object.freeze({
      type: 'jar',
      loader: 'vanilla',
      jar: 'C:\\Minecraft\\StartGate\\server.jar',
      cwd: SERVER_PATH,
      readyMarkers: Object.freeze(['Done (']),
      fatalMarkers: Object.freeze(['fatal']),
      runtime: Object.freeze({ minecraftVersion: '1.20.1', loaderFamily: 'vanilla', loaderVersion: '1.20.1', javaMajor: 17 })
    }),
    isLive() {
      return child.exitCode === null && child.signalCode === null && child.killed === false;
    },
    relaxSupervision() {
      relaxed += 1;
      return true;
    }
  });
  const startLease = Object.freeze({
    kind: 'start',
    operation: 'server-health-live',
    operationId: processHandle.operationId,
    instanceId: INSTANCE_ID,
    serverPath: SERVER_PATH,
    assertOwnedPath(value) { assert.equal(value, SERVER_PATH); return value; },
    release() { return true; }
  });

  await withServerManager({ supervisor: { installed: true } }, async ({ eventBus, logs, serverLines, serverManager }) => {
    const requests = acknowledgeOwnership(eventBus, Promise.resolve());
    const started = [];
    eventBus.on('server-started', event => started.push(event));
    try {
      serverManager.adoptValidatedLifecycleProcess({
        eventId: 'modpack-runtime-handoff:job-relaxed',
        handoff: { processHandle, startLease },
        instanceId: INSTANCE_ID,
        jobId: 'job-relaxed',
        serverPath: SERVER_PATH
      });
      assert.equal(relaxed, 1, 'adoption makes later runner watchdog faults report-only');
      assert.equal(requests.length, 1);
      requests[0].onSupervisionFailure(requests[0], new Error('watchdog exited unexpectedly (1/null)'));
      handleSupervision.reject(new Error('Server process watchdog failed'));
      await flush();
      assert.deepEqual(killSignals, []);
      assert.equal(child.killed, false);
      assert.equal(serverManager.getServerState({ instanceId: INSTANCE_ID }).status, 'running');
      assert.ok(serverLines().some(line => line.startsWith('[WARNING]') && /watchdog exited unexpectedly/.test(line)));
      assert.ok(logs.warn.length >= 1);
      assert.equal(started.length, 1, 'the adopted server is still announced as started');
    } finally {
      child.exit(0, null);
      child.close();
      await flush();
    }
  });
});

test('validated lifecycle handoff is identity-bound, idempotent, and becomes the normal managed process', async () => {
  const child = new FakeChild(8181);
  const closeGate = deferred();
  const supervisionGate = deferred();
  child.once('close', (exitCode, signal) => closeGate.resolve({ exitCode, signal }));
  const processHandle = Object.freeze({
    child,
    closed: closeGate.promise,
    pid: child.pid,
    operationId: 'health-live-job-runtime',
    publishEvents: false,
    supervisionReady: supervisionGate.promise,
    launchPlan: Object.freeze({
      type: 'jar',
      loader: 'vanilla',
      jar: 'C:\\Minecraft\\StartGate\\server.jar',
      cwd: SERVER_PATH,
      readyMarkers: Object.freeze(['Done (']),
      fatalMarkers: Object.freeze(['fatal']),
      runtime: Object.freeze({
        minecraftVersion: '1.20.1',
        loaderFamily: 'vanilla',
        loaderVersion: '1.20.1',
        javaMajor: 17
      })
    }),
    isLive() {
      return child.exitCode === null && child.signalCode === null && child.killed === false;
    }
  });
  const startLease = Object.freeze({
    kind: 'start',
    operation: 'server-health-live',
    operationId: processHandle.operationId,
    instanceId: INSTANCE_ID,
    serverPath: SERVER_PATH,
    assertOwnedPath(value) { assert.equal(value, SERVER_PATH); return value; },
    release() { return true; }
  });
  const request = {
    eventId: 'modpack-runtime-handoff:job-runtime',
    handoff: { processHandle, startLease },
    instanceId: INSTANCE_ID,
    jobId: 'job-runtime',
    maxRam: 7,
    port: 25570,
    runtime: processHandle.launchPlan.runtime,
    serverPath: SERVER_PATH
  };

  await withServerManager({ calls: [] }, async ({ eventBus, serverManager }) => {
    const lifecycleEvents = [];
    let normalExitEvent = null;
    eventBus.on('server-process-owned', value => lifecycleEvents.push(['owned', value]));
    eventBus.on('server-started', value => lifecycleEvents.push(['started', value]));
    eventBus.once('server-normal-exit', value => { normalExitEvent = value; });
    const first = serverManager.adoptValidatedLifecycleProcess(request);
    const second = serverManager.adoptValidatedLifecycleProcess(request);
    assert.equal(first, second);
    assert.deepEqual(first, { adopted: true, instanceId: INSTANCE_ID, pid: 8181 });
    assert.deepEqual(lifecycleEvents.map(([name]) => name), ['owned']);
    assert.equal(lifecycleEvents[0][1].instanceId, INSTANCE_ID);
    assert.equal(lifecycleEvents[0][1].operationId, processHandle.operationId);
    assert.equal(lifecycleEvents[0][1].pid, 8181);
    supervisionGate.resolve({ instanceId: INSTANCE_ID, operationId: processHandle.operationId, pid: 8181 });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lifecycleEvents.map(([name]) => name), ['owned', 'started']);
    assert.equal(lifecycleEvents[1][1].pid, 8181);
    const state = serverManager.getServerState({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(state.serverProcess, child);
    assert.equal(state.status, 'running');
    assert.equal(state.serverMaxRam, 7);
    assert.equal(state.port, 25570);

    assert.throws(
      () => serverManager.adoptValidatedLifecycleProcess({ ...request, jobId: 'different-job' }),
      /handoff/i
    );
    assert.throws(
      () => serverManager.adoptValidatedLifecycleProcess({
        ...request,
        eventId: 'modpack-runtime-handoff:job-other',
        jobId: 'job-other',
        instanceId: 'different-server'
      }),
      /handoff|server/i
    );
    child.exit(0, null);
    await new Promise(resolve => setImmediate(resolve));
    const closePending = serverManager.getServerState({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(closePending.isRunning, true);
    assert.equal(closePending.status, 'stopping');
    assert.equal(closePending.serverProcess, child);
    child.close();
    await new Promise(resolve => setImmediate(resolve));
    const stopped = serverManager.getServerState({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(stopped.isRunning, false);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.serverProcess, null);
    assert.deepEqual(normalExitEvent, {
      instanceId: INSTANCE_ID,
      operationId: processHandle.operationId,
      pid: 8181
    });
  });
});

test('validated lifecycle adoption rejects a process handle without a thenable close barrier', async () => {
  const child = new FakeChild(8282);
  const processHandle = Object.freeze({
    child,
    pid: child.pid,
    operationId: 'health-live-job-no-close-barrier',
    publishEvents: false,
    launchPlan: Object.freeze({
      type: 'jar',
      loader: 'vanilla',
      jar: 'C:\\Minecraft\\StartGate\\server.jar',
      cwd: SERVER_PATH,
      readyMarkers: Object.freeze(['Done (']),
      fatalMarkers: Object.freeze(['fatal']),
      runtime: Object.freeze({
        minecraftVersion: '1.20.1',
        loaderFamily: 'vanilla',
        loaderVersion: '1.20.1',
        javaMajor: 17
      })
    }),
    isLive() { return true; }
  });
  const startLease = Object.freeze({
    kind: 'start',
    operation: 'server-health-live',
    operationId: processHandle.operationId,
    instanceId: INSTANCE_ID,
    serverPath: SERVER_PATH,
    assertOwnedPath(value) { assert.equal(value, SERVER_PATH); return value; },
    release() { assert.fail('an unprovable adoption must retain its start lease'); }
  });

  await withServerManager({ calls: [] }, async ({ serverManager }) => {
    assert.throws(
      () => serverManager.adoptValidatedLifecycleProcess({
        eventId: 'modpack-runtime-handoff:job-no-close-barrier',
        handoff: { processHandle, startLease },
        instanceId: INSTANCE_ID,
        jobId: 'job-no-close-barrier',
        maxRam: 4,
        port: 25565,
        runtime: processHandle.launchPlan.runtime,
        serverPath: SERVER_PATH
      }),
      /cannot be proven/i
    );
    assert.equal(
      serverManager.getServerState({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH }).isRunning,
      false
    );
  });
});

test('global recovery and pending mutation failures happen before any server-side observation', async () => {
  const recoveryCalls = [];
  await withServerManager({ calls: recoveryCalls, completeRecovery: false }, async ({ serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, false);
    assert.equal(result.code, 'RECOVERY_REQUIRED');
    assert.deepEqual(recoveryCalls, ['acquire-start']);
  });

  const pendingCalls = [];
  const fixture = coordinatorFixture({ calls: pendingCalls });
  const quiesce = deferred();
  const mutation = fixture.coordinator.runMutation(
    { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
    {
      operation: 'pending-write',
      operationId: 'pending-write-1',
      revisionMode: 'none',
      quiesce: async () => quiesce.promise
    },
    async () => {}
  );

  await withServerManager({ calls: pendingCalls, fixture }, async ({ serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, false);
    assert.equal(result.code, 'OPERATION_IN_PROGRESS');
    assert.equal(pendingCalls.includes('exists'), false);
    assert.equal(pendingCalls.includes('read-config'), false);
    assert.equal(pendingCalls.includes('spawn'), false);
  });
  quiesce.resolve();
  await mutation;
});

test('spawn failure releases the start reservation and commits a dirty-once revision', async () => {
  const calls = [];
  await withServerManager({ calls, spawnError: new Error('spawn failed') }, async ({ coordinator, fixture, serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, false);
    assert.equal(result.code, 'SERVER_START_FAILED');
    assert.equal(fixture.getRevision(), 4);
    assert.equal(calls.filter(value => value === 'bump-revision').length, 1);

    const next = await coordinator.acquireStart(
      { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
      { operation: 'test-start', operationId: 'after-spawn-failure', parentMutationLease: null }
    );
    next.release();
  });
});

test('a post-spawn setup failure retains the start gate until the exact child is confirmed closed', async () => {
  const calls = [];
  const child = new FakeChild(4545);
  child.stdout = new ManagerAttachFailureStream();
  const stopRequested = deferred();
  child.onStdinWrite = value => {
    if (value === 'stop\n') stopRequested.resolve();
  };

  await withServerManager({ calls, child }, async ({ coordinator, serverManager }) => {
    let startSettled = false;
    const startPromise = serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH
    }).then(result => {
      startSettled = true;
      return result;
    });

    const cleanupStarted = await Promise.race([
      stopRequested.promise.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 100))
    ]);
    assert.equal(cleanupStarted, true, 'failure cleanup must use the shared process handle');
    assert.equal(startSettled, false);
    await assert.rejects(
      coordinator.acquireStart(
        { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
        { operation: 'test-start', operationId: 'blocked-before-close', parentMutationLease: null }
      ),
      code('OPERATION_IN_PROGRESS')
    );

    child.exit(1, null);
    child.close(1, null);
    const result = await startPromise;
    assert.equal(result.success, false);
    assert.equal(result.code, 'SERVER_START_FAILED');

    const next = await coordinator.acquireStart(
      { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
      { operation: 'test-start', operationId: 'after-confirmed-close', parentMutationLease: null }
    );
    next.release();
  });
});

test('invalid resolved close evidence cannot release a failed-start reservation', async () => {
  const calls = [];
  const child = new FakeChild(4646);
  child.stdout = new ManagerAttachFailureStream();
  child.stdout.listenerRegistrations = 3;
  const closeGate = deferred();
  const processHandle = {
    child,
    closed: closeGate.promise,
    launchPlan: {
      type: 'jar',
      loader: 'vanilla',
      jar: 'C:\\Minecraft\\StartGate\\server.jar',
      args: ['-Xmx4G', '-jar', 'server.jar', 'nogui'],
      cwd: SERVER_PATH,
      readyMarkers: ['Done ('],
      fatalMarkers: ['fatal'],
      runtime: null
    },
    isLive: () => true,
    async stopFully() {
      return { clean: false, closed: false, exitCode: null, forced: true, signal: null };
    }
  };

  await withServerManager({ calls, processHandle }, async ({ coordinator, serverManager }) => {
    const result = await serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH
    });
    assert.equal(result.success, false);

    closeGate.resolve(null);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(
      coordinator.acquireStart(
        { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
        { operation: 'test-start', operationId: 'invalid-close-evidence', parentMutationLease: null }
      ),
      code('OPERATION_IN_PROGRESS')
    );

    const shutdown = await serverManager.shutdownMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH
    }, {
      gracefulTimeoutMs: 10,
      killTimeoutMs: 10,
      forceKill: false,
      disposeStateAfterStop: true
    });
    assert.equal(shutdown.success, false);
    assert.equal(
      serverManager.getServerState({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH }).targetPath,
      SERVER_PATH,
      'fail-closed process evidence must retain the state that owns its close barrier'
    );
  });
});

test('pre-spawn read failure releases the start reservation', async () => {
  const calls = [];
  await withServerManager({ calls, configError: new Error('config read failed') }, async ({ coordinator, serverManager }) => {
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, false);
    assert.equal(result.code, 'SERVER_START_FAILED');
    assert.equal(calls.includes('spawn'), false);

    const next = await coordinator.acquireStart(
      { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
      { operation: 'test-start', operationId: 'after-config-failure', parentMutationLease: null }
    );
    next.release();
  });
});

test('a post-running child error keeps the run block until confirmed process close', async () => {
  const calls = [];
  await withServerManager({ calls }, async ({ children, coordinator, eventBus, serverManager }) => {
    let crashedEvent = null;
    eventBus.once('server-crashed', value => { crashedEvent = value; });
    const result = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(result.success, true);

    const assertRunBlocked = operationId => assert.rejects(
      coordinator.runMutation(
        { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
        {
          operation: 'blocked-write',
          operationId,
          revisionMode: 'none',
          quiesce: null
        },
        async () => {}
      ),
      code('SERVER_RUNNING')
    );

    await assertRunBlocked('blocked-before-error');
    children[0].emit('error', new Error('non-terminal child error'));
    await assertRunBlocked('blocked-after-error');

    children[0].exit(1, null);
    const closePending = serverManager.getServerState({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(closePending.isRunning, true);
    assert.equal(closePending.status, 'stopping');
    assert.equal(closePending.serverProcess, children[0]);
    await assertRunBlocked('blocked-after-exit-before-close');
    children[0].close(1, null);
    await new Promise(resolve => setImmediate(resolve));
    const stopped = serverManager.getServerState({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(stopped.isRunning, false);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.serverProcess, null);
    assert.equal(crashedEvent?.instanceId, INSTANCE_ID);
    assert.equal(crashedEvent?.pid, 4242);
    await coordinator.runMutation(
      { instanceId: INSTANCE_ID, serverPath: SERVER_PATH },
      {
        operation: 'released-write',
        operationId: 'released-after-close',
        revisionMode: 'none',
        quiesce: null
      },
      async () => {}
    );
  });
});

for (const outcome of ['returns usage', 'fails']) {
  test(`a process usage read that ${outcome} after the server stopped sends no metrics`, async () => {
    const reads = [];
    const pidusage = () => new Promise((resolve, reject) => reads.push({ resolve, reject }));
    await withServerManager({ pidusage }, async ({ children, sentMessages, serverManager }) => {
      const started = await serverManager.startMinecraftServer({
        instanceId: INSTANCE_ID,
        targetPath: SERVER_PATH,
        port: 25565,
        maxRam: 4
      });
      assert.equal(started.success, true, started.error);
      assert.equal(reads.length, 1, 'metrics reporting reads the process once at start');

      // The read is still running when the server exits and its close is confirmed.
      const child = children.at(-1);
      child.exit(0, null);
      child.close(0, null);
      await flush();
      await flush();
      assert.equal(sentMessages.filter(message => message.channel === 'server-status').at(-1).payload.status, 'stopped');
      const afterStop = sentMessages.length;

      // A late sample would make the app show Running for a stopped server.
      if (outcome === 'fails') reads[0].reject(new Error('No matching pid found'));
      else reads[0].resolve({ cpu: 12.5, memory: 512 * 1024 * 1024 });
      await flush();
      await flush();
      assert.deepEqual(sentMessages.slice(afterStop).filter(message => message.channel === 'metrics-update'), []);
    });
  });
}

test('a process usage read that finishes while the server runs still reports metrics', async () => {
  const reads = [];
  const pidusage = () => new Promise((resolve, reject) => reads.push({ resolve, reject }));
  await withServerManager({ pidusage }, async ({ sentMessages, serverManager }) => {
    const started = await serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH,
      port: 25565,
      maxRam: 4
    });
    assert.equal(started.success, true, started.error);
    reads[0].resolve({ cpu: 12.5, memory: 512 * 1024 * 1024 });
    await flush();
    await flush();
    const metrics = sentMessages.filter(message => message.channel === 'metrics-update');
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].payload.cpuPct, 12.5);
    assert.equal(metrics[0].payload.memUsedMB, 512);
  });
});

test('shutdown does not report a stopped server until process close releases its active start lease', async () => {
  const calls = [];
  await withServerManager({ calls }, async ({ children, fixture, serverManager }) => {
    const started = await serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH,
      port: 25565,
      maxRam: 4
    });
    assert.equal(started.success, true);
    assert.equal(fixture.getRevision(), 4, 'start-side writes are revisioned before the process is published');

    let shutdownSettled = false;
    const shutdown = serverManager.shutdownMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH
    }, {
      gracefulTimeoutMs: 1000,
      killTimeoutMs: 1000,
      forceKill: false
    }).then(result => {
      shutdownSettled = true;
      return result;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(children[0].stdin.writes, ['stop\n']);
    children[0].exit(0, null);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(shutdownSettled, false, 'child exit is not durable process-close evidence');
    assert.equal(fixture.getRevision(), 4);

    children[0].close(0, null);
    const result = await shutdown;
    assert.equal(result.success, true);
    assert.equal(result.results[0].stopped, true);
    assert.equal(fixture.getRevision(), 4);
  });
});

test('graceful shutdown cancels delayed player-list writes before server stdin closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new FakeChild(4747);

  await withServerManager({ child }, async ({ serverManager }) => {
    const started = await serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH,
      port: 25565,
      maxRam: 4
    });
    assert.equal(started.success, true);

    child.stdout.write('E2EJoiner left the game\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.stdin.writes, ['list\n']);

    const shutdown = serverManager.shutdownMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH
    }, {
      gracefulTimeoutMs: 10_000,
      killTimeoutMs: 10_000,
      forceKill: false
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(child.stdin.writes, ['list\n', 'stop\n']);

    t.mock.timers.tick(5_000);
    assert.deepEqual(
      child.stdin.writes,
      ['list\n', 'stop\n'],
      'shutdown must cancel the delayed list writes that can race a closed Java stdin pipe'
    );

    child.exit(0, null);
    child.close(0, null);
    const result = await shutdown;
    assert.equal(result.success, true);
    assert.equal(result.results[0].stopped, true);
  });
});

test('server stdin EPIPE errors are handled and disable later command writes', async () => {
  const child = new FakeChild(4848);

  await withServerManager({ child }, async ({ serverManager }) => {
    const started = await serverManager.startMinecraftServer({
      instanceId: INSTANCE_ID,
      targetPath: SERVER_PATH,
      port: 25565,
      maxRam: 4
    });
    assert.equal(started.success, true);

    const pipeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    assert.doesNotThrow(() => child.stdin.emit('error', pipeError));
    assert.equal(
      serverManager.sendServerCommand({ instanceId: INSTANCE_ID }, 'say should-not-write'),
      false
    );
    assert.deepEqual(child.stdin.writes, []);
  });
});

test('launcher port synchronization marks the active start lease dirty and bumps once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-start-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'server.properties'), 'motd=Test\nserver-port=25565\n', 'utf8');
  let revision = 9;
  const bumps = [];
  const coordinator = new ServerMutationCoordinator({
    context: sharedServerMutationContext,
    readContentRevision: () => revision,
    bumpContentRevision(_serverPath, options) {
      bumps.push({ ...options });
      assert.equal(options.expectedRevision, revision);
      revision += 1;
      return revision;
    }
  });
  coordinator.completeStartupRecovery([]);
  const lease = await coordinator.acquireStart(
    { instanceId: 'temp-server', serverPath: root },
    { operation: 'server-start', operationId: 'port-sync-start', parentMutationLease: null }
  );

  await runWithServerMutationLease(lease, async () => {
    syncServerPort(root, 25570);
  });
  lease.markRunning({ pid: 55 });
  lease.release();
  lease.release();

  assert.match(fs.readFileSync(path.join(root, 'server.properties'), 'utf8'), /server-port=25570/);
  assert.equal(revision, 10);
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].operationId, 'port-sync-start');
});

test('launcher network synchronization persists loopback binding with the selected port', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-start-gate-loopback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'server.properties'),
    [
      '# preserve this comment',
      'server-ip:192.0.2.10',
      'server\\u002dip 192.0.2.11',
      'server-port 25565',
      'server\\u002dport:25566',
      'motd=Test'
    ].join('\r\n') + '\r\n',
    'utf8'
  );
  const lease = {
    kind: 'mutation', instanceId: 'loopback-server', serverPath: root,
    markDirty() {}, assertOwnedPath() {}
  };

  await runWithServerMutationLease(lease, async () => {
    syncServerPort(root, 25571, 'loopback');
  });

  const properties = fs.readFileSync(path.join(root, 'server.properties'), 'utf8');
  assert.equal(properties, [
    '# preserve this comment',
    'server-ip=127.0.0.1',
    'server-port=25571',
    'motd=Test'
  ].join('\r\n') + '\r\n');
});

test('launcher marks dirty before a failed property write so partial bytes remain revision-audited', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-start-gate-partial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const propertiesPath = path.join(root, 'server.properties');
  fs.writeFileSync(propertiesPath, 'motd=Test\nserver-port=25565\n', 'utf8');
  let revision = 4;
  const coordinator = new ServerMutationCoordinator({
    context: sharedServerMutationContext,
    readContentRevision: () => revision,
    bumpContentRevision(_serverPath, options) {
      assert.equal(options.expectedRevision, revision);
      revision += 1;
      return revision;
    }
  });
  coordinator.completeStartupRecovery([]);
  const lease = await coordinator.acquireStart(
    { instanceId: 'partial-write-server', serverPath: root },
    { operation: 'server-start', operationId: 'partial-port-sync', parentMutationLease: null }
  );

  const originalWriteFileSync = fs.writeFileSync;
  try {
    fs.writeFileSync = (targetPath, contents, encoding) => {
      originalWriteFileSync(targetPath, String(contents).slice(0, 4), encoding);
      throw new Error('injected partial write');
    };
    await runWithServerMutationLease(lease, async () => {
      assert.throws(() => syncServerPort(root, 25570), /injected partial write/);
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  lease.release();

  assert.equal(revision, 5);
});

test('Forge root shim creation bumps the active start revision once and an unchanged shim remains clean', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-start-gate-forge-shim-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forgeDir = path.join(root, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.18');
  const shimName = 'forge-shim.jar';
  const sourceShim = path.join(forgeDir, shimName);
  const rootShim = path.join(root, shimName);
  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(path.join(forgeDir, 'win_args.txt'), `-jar ${shimName}\n`, 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'unix_args.txt'), `-jar ${shimName}\n`, 'utf8');
  fs.writeFileSync(sourceShim, 'forge shim bytes', 'utf8');

  let revision = 9;
  const bumps = [];
  const coordinator = new ServerMutationCoordinator({
    context: sharedServerMutationContext,
    readContentRevision: () => revision,
    bumpContentRevision(_serverPath, options) {
      bumps.push({ ...options });
      assert.equal(options.expectedRevision, revision);
      revision += 1;
      return revision;
    }
  });
  coordinator.completeStartupRecovery([]);

  const resolveUnderStartLease = async operationId => {
    const lease = await coordinator.acquireStart(
      { instanceId: 'forge-shim-server', serverPath: root },
      { operation: 'server-start', operationId, parentMutationLease: null }
    );
    await runWithServerMutationLease(lease, async () => {
      resolveLaunchPlan(root, {
        loader: 'forge',
        minecraftVersion: '1.20.1',
        loaderVersion: '47.4.18'
      });
    });
    lease.release();
  };

  await resolveUnderStartLease('forge-shim-create');
  assert.deepEqual(fs.readFileSync(rootShim), fs.readFileSync(sourceShim));
  assert.equal(revision, 10);
  assert.equal(bumps.length, 1);
  assert.equal(bumps[0].operationId, 'forge-shim-create');

  await resolveUnderStartLease('forge-shim-unchanged');
  assert.equal(revision, 10);
  assert.equal(bumps.length, 1);
});

test('Forge root shim marks dirty before a failed copy so partial bytes remain revision-audited', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-start-gate-forge-partial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forgeDir = path.join(root, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.18');
  const shimName = 'forge-shim.jar';
  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(path.join(forgeDir, 'win_args.txt'), `-jar ${shimName}\n`, 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'unix_args.txt'), `-jar ${shimName}\n`, 'utf8');
  fs.writeFileSync(path.join(forgeDir, shimName), 'forge shim bytes', 'utf8');

  let revision = 4;
  const coordinator = new ServerMutationCoordinator({
    context: sharedServerMutationContext,
    readContentRevision: () => revision,
    bumpContentRevision(_serverPath, options) {
      assert.equal(options.expectedRevision, revision);
      revision += 1;
      return revision;
    }
  });
  coordinator.completeStartupRecovery([]);
  const lease = await coordinator.acquireStart(
    { instanceId: 'forge-partial-server', serverPath: root },
    { operation: 'server-start', operationId: 'forge-shim-partial', parentMutationLease: null }
  );

  const originalCopyFileSync = fs.copyFileSync;
  try {
    fs.copyFileSync = (source, target) => {
      fs.writeFileSync(target, fs.readFileSync(source).subarray(0, 4));
      throw new Error('injected partial Forge shim copy');
    };
    await runWithServerMutationLease(lease, async () => {
      assert.throws(
        () => resolveLaunchPlan(root, {
          loader: 'forge',
          minecraftVersion: '1.20.1',
          loaderVersion: '47.4.18'
        }),
        /injected partial Forge shim copy/
      );
    });
  } finally {
    fs.copyFileSync = originalCopyFileSync;
  }
  lease.release();

  assert.equal(revision, 5);
});

test('main installs the coordinator then runs registry recovery before cleanup', async () => {
  const modulePath = path.resolve(__dirname, '../electron/main.cjs');
  const originalLoad = Module._load;
  const calls = [];
  const sentinel = new Error('stop after ordering evidence');
  let readyCallback = null;
  let coordinatorInstance = null;

  class FakeBrowserWindow {
    static getAllWindows() { return []; }

    constructor() {
      calls.push('create-startup-window');
      this.id = 1;
    }

    loadURL() {
      return Promise.resolve();
    }
  }

  const app = {
    getVersion: () => 'test',
    isPackaged: false,
    on() {},
    quit() {},
    setAppUserModelId() {},
    setName() {},
    whenReady() {
      return {
        then(callback) {
          readyCallback = callback;
          return { catch() {} };
        }
      };
    }
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app,
        BrowserWindow: FakeBrowserWindow,
        ipcMain: {},
        Menu: { setApplicationMenu() {} },
        session: {},
        shell: {},
        Tray: class {}
      };
    }
    if (request.endsWith('bootstrap/create-modpack-service-graph.cjs')) {
      return {
        createModpackServiceGraph(dependencies) {
          calls.push('construct-coordinator');
          coordinatorInstance = {};
          return {
            coordinator: coordinatorInstance,
            paths: { userData: dependencies.userDataPath },
            startup: {
              ...dependencies.startup,
              async initializeRecovery() { calls.push('initialize-registry-recovery'); },
              // Cleanup is an optional startup stage, so the first fatal stage after it stops startup.
              configureAfterReady() {
                calls.push('configure-after-ready');
                throw sentinel;
              }
            },
            window: { create: dependencies.windowFactory, get: dependencies.getWindow },
            updater: dependencies.updater,
            tray: dependencies.tray,
            watchdog: dependencies.watchdog,
            managementServer: dependencies.managementServer
          };
        }
      };
    }
    if (request.endsWith('services/server-mutation-context.cjs')) {
      return {
        installServerMutationCoordinator(value) {
          assert.equal(value, coordinatorInstance);
          calls.push('install-coordinator');
        }
      };
    }
    if (request.endsWith('utils/runtime-paths.cjs')) {
      return {
        cleanupRuntimeFiles() {
          calls.push('cleanup-runtime');
        }
      };
    }
    if (request.endsWith('services/logger-service.cjs')) {
      return {
        getLogger() {
          return { debug() {}, error() {}, fatal() {}, info() {}, warn() {} };
        }
      };
    }
    if (request.endsWith('ipc-handlers.cjs')) return { setupIpcHandlers() {} };
    if (request.endsWith('utils/app-cleanup.cjs')) return { setupAppCleanup() {} };
    if (request.endsWith('utils/safe-send.cjs')) return { setMainWindow() {} };
    if (request.endsWith('utils/app-store.cjs')) return { get() { return null; }, set() {} };
    if (request.endsWith('utils/config-manager.cjs')) return { ensureConfigFile() {} };
    if (request.endsWith('utils/navigation-policy.cjs')) return { shouldAllowNavigation() { return false; } };
    if (request.endsWith('utils/tls-utils.cjs')) return { getTlsFingerprint() {}, normalizeFingerprint() {} };
    if (request.endsWith('utils/runtime-mode.cjs')) return { shouldUseDevServer() { return false; } };
    if (request.endsWith('services/update-service.cjs')) return { getUpdateService() { return {}; }, setInstallActivityProbe() {} };
    if (request.endsWith('config/dev-config.cjs')) return {};
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];
  try {
    require(modulePath);
    assert.deepEqual(calls, ['construct-coordinator', 'install-coordinator']);
    assert.equal(typeof readyCallback, 'function');
    let thrown = null;
    try {
      await readyCallback();
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, sentinel);
    assert.deepEqual(calls, [
      'construct-coordinator',
      'install-coordinator',
      'create-startup-window',
      'initialize-registry-recovery',
      'cleanup-runtime',
      'configure-after-ready'
    ]);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
});
