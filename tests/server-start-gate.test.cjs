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

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    this.stdin = {
      writes: [],
      write: value => {
        this.stdin.writes.push(value);
        if (this.onStdinWrite) this.onStdinWrite(value);
        return true;
      }
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
        launchServerProcess() {
          calls.push('spawn');
          children.push(options.processHandle.child);
          return options.processHandle;
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
          return {
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
        syncServerPort(serverPath, port) {
          calls.push('sync-port');
          assert.equal(serverPath, SERVER_PATH);
          assert.equal(port, 25565);
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
  });
});

test('validated lifecycle handoff is identity-bound, idempotent, and becomes the normal managed process', async () => {
  const child = new FakeChild(8181);
  const processHandle = Object.freeze({
    child,
    pid: child.pid,
    operationId: 'health-live-job-runtime',
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
    let started = 0;
    eventBus.on('server-started', () => { started += 1; });
    const first = serverManager.adoptValidatedLifecycleProcess(request);
    const second = serverManager.adoptValidatedLifecycleProcess(request);
    assert.equal(first, second);
    assert.deepEqual(first, { adopted: true, instanceId: INSTANCE_ID, pid: 8181 });
    assert.equal(started, 1);
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
    child.close();
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
  await withServerManager({ calls }, async ({ children, coordinator, serverManager }) => {
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

    children[0].exit(0, null);
    await assertRunBlocked('blocked-after-exit-before-close');
    children[0].close(0, null);
    await new Promise(resolve => setImmediate(resolve));
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
        BrowserWindow: { getAllWindows: () => [] },
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
      'initialize-registry-recovery',
      'cleanup-runtime'
    ]);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
});
