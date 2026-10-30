const assert = require('node:assert/strict');
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

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.closedForTest = false;
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

  kill(signal = null) {
    this.killed = true;
    if (this.onKill) this.onKill(signal);
    return true;
  }

  exit(codeValue = 0, signalValue = null) {
    this.exitCode = codeValue;
    this.signalCode = signalValue;
    this.emit('exit', codeValue, signalValue);
  }

  close(codeValue = this.exitCode, signalValue = this.signalCode) {
    if (this.closedForTest) return;
    this.closedForTest = true;
    this.emit('close', codeValue, signalValue);
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
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'fs') {
      return {
        existsSync(value) {
          calls.push('exists');
          assert.equal(value, SERVER_PATH);
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
          children.push(child);
          if (options.onSpawn) options.onSpawn({ file, args, spawnOptions, child });
          return child;
        }
      };
    }
    if (request === 'pidusage') {
      return async () => ({ cpu: 0, memory: 0 });
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
      const issuedValidation = options.runtimeValidation || Object.freeze({ valid: true, runtime: MANAGED_RUNTIME });
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
    if (request.endsWith('utils/event-bus.cjs')) return eventBus;
    if (request.endsWith('utils/safe-send.cjs')) {
      return {
        safeSend(channel, payload) {
          sentMessages.push({ channel, payload });
        }
      };
    }
    if (request.endsWith('utils/app-store.cjs')) {
      return {
        get(key) {
          if (key === 'instances') {
            return [{ id: INSTANCE_ID, type: 'server', path: SERVER_PATH }];
          }
          if (key === 'lastServerPath') return SERVER_PATH;
          return null;
        },
        set() {}
      };
    }
    if (request.endsWith('utils/config-manager.cjs')) {
      return {
        detectMinecraftVersion() {
          calls.push('detect-version');
          return '1.20.1';
        },
        getDefaultServerConfig(value) {
          return value;
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
        }
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
    if (request.endsWith('server-launcher.cjs')) {
      return {
        syncServerPort(serverPath, port, networkAccess) {
          calls.push('sync-port');
          assert.equal(serverPath, SERVER_PATH);
          assert.equal(port, 25565);
          assert.equal(networkAccess, options.config?.networkAccess || 'pack-default');
          const lease = context.getCurrentLease();
          assert.ok(lease, 'port synchronization must run inside the acquired start lease');
          lease.assertOwnedPath(serverPath);
          lease.markDirty();
        },
        resolveLaunchPlan() {
          calls.push('resolve-launch');
          return {
            type: 'jar',
            loader: 'vanilla',
            jar: 'C:\\Minecraft\\StartGate\\server.jar',
            args: ['-Xmx4G', '-jar', 'server.jar', 'nogui'],
            cwd: SERVER_PATH,
            readyMarkers: ['Done ('],
            fatalMarkers: ['fatal'],
            runtime: null
          };
        },
        resolvePrevalidatedLaunchPlan(serverPath, planOptions, validation) {
          calls.push('resolve-prevalidated');
          if (options.onResolvePrevalidated) options.onResolvePrevalidated({ planOptions, serverPath, validation });
          return {
            type: 'jar',
            loader: planOptions.loader,
            jar: 'C:\\Minecraft\\StartGate\\fabric-server-launch.jar',
            args: ['-Xmx4G', '-jar', 'fabric-server-launch.jar', 'nogui'],
            cwd: SERVER_PATH,
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
        runWithServerMutationLease(lease, callback) {
          return context.runWithLease(lease, callback);
        }
      };
    }
    if (request.endsWith('ipc/logger-handlers.cjs')) {
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
      sentMessages,
      serverManager
    });
  } finally {
    const serverManager = require.cache[modulePath]?.exports;
    if (serverManager) {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.exit(0, null);
        child.close();
      }
      serverManager.clearIntervals();
      serverManager.disposeServerState({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    }
    delete require.cache[modulePath];
    delete require.cache[processRunnerPath];
    Module._load = originalLoad;
  }
}

test('start acquires the shared gate before every server read, write, Java step, resolution, and spawn', async () => {
  const calls = [];
  await withServerManager({ calls }, async ({ acquired, children, eventBus, serverManager }) => {
    const supplied = {
      acquireStart() {
        assert.fail('renderer-supplied coordinator was used');
      }
    };
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

    let startedEvent = null;
    eventBus.once('server-started', value => {
      startedEvent = value;
    });
    children[0].stdout.write('Done (1.23s)! For help, type "help"\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(startedEvent?.instanceId, INSTANCE_ID);
    assert.equal(startedEvent?.pid, 4242);
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

test('server-started publication waits for supervision and is suppressed when arming fails', async () => {
  const supervision = deferred();
  const child = new FakeChild(4243);
  await withServerManager({ child }, async ({ eventBus, serverManager }) => {
    let published = 0;
    eventBus.on('server-process-owned', request => request.acknowledge({
      instanceId: request.instanceId,
      operationId: request.operationId,
      pid: request.pid,
      ready: supervision.promise
    }));
    eventBus.on('server-started', () => { published += 1; });
    const started = await serverManager.startMinecraftServer({ instanceId: INSTANCE_ID, targetPath: SERVER_PATH });
    assert.equal(started.success, true);
    child.stdout.write('Done (1.0s)\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(published, 0);
    supervision.reject(new Error('watchdog arm failed'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(published, 0);
    assert.deepEqual(child.killed, true);
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
    assert.equal(serverManager.getServerState({ instanceId: 'existing-owner' }).status, 'starting');
    assert.notEqual(existing, child);
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
              async initializeRecovery() { calls.push('initialize-registry-recovery'); }
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
          throw sentinel;
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
    if (request.endsWith('services/update-service.cjs')) return { getUpdateService() { return {}; } };
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
      'cleanup-runtime'
    ]);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
});
