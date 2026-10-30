const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { AsyncResource } = require('node:async_hooks');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { createServerMutationContext } = require('../electron/services/server-mutation-context.cjs');
const { configureNativeToastPolicy } = require('../electron/utils/native-toast-policy.cjs');
// Loaded before the context stub below, so lanes and identity use the real modules.
require('../electron/services/server-mutation-policy.cjs');

const HOUR = 60 * 60 * 1000;

async function withWatcherModule(resolveLoaderImpl, fn, {
  servers = ['server-watch'],
  appSettings = {},
  versions = async () => []
} = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-watch-'));
  const serverPaths = servers.map(id => {
    const serverPath = path.join(tmpRoot, id);
    fs.mkdirSync(serverPath);
    return serverPath;
  });
  const instances = servers.map((id, index) => ({ id, type: 'server', path: serverPaths[index] }));
  const safeSendEvents = [];
  const notifications = [];
  let dirtyMarks = 0;
  let availabilityChecks = 0;
  const intervals = [];
  const pendingIo = new Set();
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  // Like real timers, a scheduled callback keeps the async context it was created in.
  global.setInterval = (callback, milliseconds) => {
    const timer = { callback: AsyncResource.bind(callback), milliseconds };
    intervals.push(timer);
    return timer;
  };
  const settleIo = async () => {
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      if (pendingIo.size === 0) return;
      // Reads of files that do not exist yet reject; the watcher handles them.
      await Promise.allSettled([...pendingIo]);
    }
  };
  const track = promise => {
    pendingIo.add(promise);
    promise.then(() => pendingIo.delete(promise), () => pendingIo.delete(promise));
    return promise;
  };
  const context = createServerMutationContext();
  const revisions = new Map();
  const coordinator = new ServerMutationCoordinator({
    context,
    readContentRevision: serverPath => revisions.get(path.resolve(serverPath)) || 0,
    bumpContentRevision: (serverPath, { expectedRevision }) => {
      revisions.set(path.resolve(serverPath), expectedRevision + 1);
      return expectedRevision + 1;
    }
  });
  coordinator.completeStartupRecovery([]);
  const loaderStub = {
    // Informational callers never use the strict resolver.
    resolveServerLoader: () => { throw new Error('the strict loader resolver must not be used'); },
    describeServerLoader: resolveLoaderImpl,
    normalizeLoaderName: (value) => (value ? String(value).trim().toLowerCase() : value)
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        Notification: class FakeNotification {
          constructor(options) { notifications.push(options); }
          show() {}
        }
      };
    }
    if (request.endsWith('mod-api-service.cjs')) return {
      async getModrinthVersions(...args) {
        availabilityChecks++;
        return track(Promise.resolve(versions(...args)));
      }
    };
    if (request === 'fs/promises' && parent?.filename.endsWith('mod-availability-watcher.cjs')) {
      return new Proxy(fs.promises, { get(target, property) {
        if (!['mkdir', 'readFile', 'writeFile'].includes(property)) return target[property];
        return (...args) => track(target[property](...args));
      } });
    }
    if (request.endsWith('safe-send.cjs')) {
      return { safeSend: (channel, data) => safeSendEvents.push({ channel, data }) };
    }
    if (request.endsWith('app-store.cjs')) {
      return {
        get: (key) => (key === 'instances' ? instances : key === 'appSettings' ? appSettings : {}),
        set: () => {}
      };
    }
    if (request.endsWith('server-mutation-context.cjs')) {
      return {
        getCurrentServerMutationLease: () => context.getCurrentMutationLease(),
        getServerMutationCoordinator: () => coordinator,
        markCurrentServerMutationDirty(candidate) {
          const marked = context.markCurrentDirty(candidate);
          if (marked) dirtyMarks += 1;
          return marked;
        }
      };
    }
    if (request.endsWith('server-loader.cjs')) {
      return loaderStub;
    }
    return originalLoad(request, parent, isMain);
  };

  const modulePath = path.resolve(__dirname, '../electron/services/mod-availability-watcher.cjs');
  delete require.cache[modulePath];
  const watcher = require(modulePath);

  async function runBackgroundTick(milliseconds, { now } = {}) {
    const timer = intervals.find(value => value.milliseconds === milliseconds);
    assert.ok(timer, 'production background timer must be registered');
    const originalNow = Date.now;
    if (now !== undefined) Date.now = () => now;
    try {
      timer.callback();
      await settleIo();
      // A check waits for its own lease and lane; let it settle completely.
      for (let round = 0; round < 20; round++) await new Promise(resolve => setImmediate(resolve));
      await settleIo();
    } finally {
      Date.now = originalNow;
    }
  }

  try {
    for (const serverPath of serverPaths) {
      await watcher.clearModAvailabilityWatches(serverPath);
      await watcher.clearModAvailabilityHistory(serverPath);
    }
    await fn({ watcher, serverPath: serverPaths[0], serverPaths, instances, coordinator, context, safeSendEvents, notifications,
      getDirtyMarks: () => dirtyMarks,
      getAvailabilityChecks: () => availabilityChecks,
      runBackgroundTick
    });
  } finally {
    await settleIo();
    try {
      for (const serverPath of serverPaths) {
        await watcher.clearModAvailabilityWatches(serverPath);
        await watcher.clearModAvailabilityHistory(serverPath);
      }
    } catch {
      // ignore cleanup errors
    }
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    delete require.cache[modulePath];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function historyOf(serverPath) {
  const file = path.join(serverPath, 'minecraft-core-configs', 'mod-availability-history.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

function watchesOf(serverPath) {
  const file = path.join(serverPath, 'minecraft-core-configs', 'mod-availability-watches.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).watches : [];
}

const AVAILABLE = async () => [{ id: 'version-2', versionNumber: '2.0.0', gameVersions: ['1.20.1'], loaders: ['forge'], datePublished: '2026-10-01T00:00:00Z' }];

// Adds a watch, lets the scheduler record its next check, then returns a time when it is due.
async function scheduleDueWatch(value, serverPath, projectId = 'waiting-mod') {
  await value.watcher.addModAvailabilityWatch({ serverPath, projectId, modName: projectId, targetMc: '1.20.1' });
  return Date.now() + 13 * HOUR;
}

test('addModAvailabilityWatch injects detected loader metadata when target is undefined', { concurrency: false }, async () => {
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '52.0.1', source: 'config:loader' }), async ({ watcher, serverPath }) => {
    await watcher.addModAvailabilityWatch({
      serverPath,
      projectId: 'allthemods',
      modName: 'All The Mods',
      targetMc: '1.20.1'
    });

    const watches = await watcher.listModAvailabilityWatches(serverPath);
    assert.equal(watches.length, 1, 'Watch should be stored');
    const watch = watches[0];
    assert.equal(watch.target.loader, 'forge');
    assert.equal(watch.target.loaderVersion, '52.0.1');
    assert.equal(watch.target.mc, '1.20.1');
    assert.ok(!('fabric' in watch.target), 'Non-fabric loaders should not expose fabric key');
  });
});

test('a server whose recorded runtime drifted still gets watches from its configured loader', async () => {
  const describe = () => ({ loader: 'forge', loaderVersion: '47.3.12', source: 'runtime-incomplete', runtimeIncomplete: true });
  await withWatcherModule(describe, async ({ watcher, serverPath }) => {
    await watcher.addModAvailabilityWatch({ serverPath, projectId: 'jei', targetMc: '1.20.1' });
    const [watch] = await watcher.listModAvailabilityWatches(serverPath);
    assert.deepEqual(watch.target, { mc: '1.20.1', loader: 'forge', loaderVersion: '47.3.12' });
    await watcher.removeModAvailabilityWatch({ serverPath, projectId: 'jei', targetMc: '1.20.1' });
    assert.deepEqual(await watcher.listModAvailabilityWatches(serverPath), []);
  });
});

test('fabric watches include loader version and can be removed with loader-aware target', { concurrency: false }, async () => {
  const resolveLoader = () => ({ loader: 'fabric', loaderVersion: '0.15.9', source: 'config:loader' });
  await withWatcherModule(resolveLoader, async ({ watcher, serverPath }) => {
    await watcher.addModAvailabilityWatch({
      serverPath,
      projectId: 'sodium',
      modName: 'Sodium',
      targetMc: '1.21.0'
    });

    let watches = await watcher.listModAvailabilityWatches(serverPath);
    assert.equal(watches.length, 1, 'Watch should be stored');
    const stored = watches[0];
    assert.equal(stored.target.loader, 'fabric');
    assert.equal(stored.target.loaderVersion, '0.15.9');
    assert.equal(stored.target.fabric, '0.15.9');

    await watcher.removeModAvailabilityWatch({
      serverPath,
      projectId: stored.projectId,
      targetMc: stored.target.mc,
      targetLoader: stored.target.loader,
      targetLoaderVersion: stored.target.loaderVersion
    });

    watches = await watcher.listModAvailabilityWatches(serverPath);
    assert.equal(watches.length, 0, 'Watch should be removed when loader data matches');
  });
});

for (const intervalMs of [60_000, 5 * 60_000]) {
  test(`empty availability ${intervalMs}ms background tick leaves server content unchanged`, async () => {
    await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.4.13' }), async value => {
      value.watcher.startModAvailabilityWatcher();
      await value.runBackgroundTick(intervalMs);

      assert.equal(value.getDirtyMarks(), 0);
      assert.equal(fs.existsSync(path.join(value.serverPath, 'minecraft-core-configs')), false);
    });
  });
}

test('empty availability background checks cannot invalidate an in-flight server snapshot', async () => {
  const { createProductionServerSnapshot } = require('../electron/services/modpacks/planning/production-server-snapshot.cjs');
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.4.13' }), async value => {
    fs.mkdirSync(path.join(value.serverPath, 'mods'));
    fs.writeFileSync(path.join(value.serverPath, 'mods', 'pack.jar'), 'pack-bytes');
    value.watcher.startModAvailabilityWatcher();
    const currentState = { state: { modpackManaged: true, runtime: { loaderFamily: 'forge' } } };
    let ticked = false;
    const snapshot = createProductionServerSnapshot({
      fsPromises: { ...fs.promises, async open(...args) {
        if (!ticked) {
          ticked = true;
          await value.runBackgroundTick(5 * 60_000);
        }
        return fs.promises.open(...args);
      } },
      reparseInspector: { async isReparsePoint() { return false; } },
      stateRepository: { read() { return currentState; } }
    });

    const result = await snapshot({ currentState, operationKind: 'upgrade', serverKind: 'existing', serverPath: value.serverPath });
    assert.equal(result.liveSnapshot.entries.some(entry => entry.path === 'mods/pack.jar'), true);
    assert.equal(value.getDirtyMarks(), 0);
  });
});

test('availability background checks respect a future schedule and still run when due', async () => {
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.4.13' }), async value => {
    await value.watcher.addModAvailabilityWatch({ serverPath: value.serverPath,
      projectId: 'waiting-mod', targetMc: '1.20.1' });
    value.watcher.startModAvailabilityWatcher();
    await value.runBackgroundTick(60_000);
    const watchFile = path.join(value.serverPath, 'minecraft-core-configs', 'mod-availability-watches.json');
    const scheduled = fs.readFileSync(watchFile, 'utf8');
    const initialDirty = value.getDirtyMarks();

    await value.runBackgroundTick(5 * 60_000);
    assert.equal(value.getAvailabilityChecks(), 0);
    assert.equal(value.getDirtyMarks(), initialDirty);
    assert.equal(fs.readFileSync(watchFile, 'utf8'), scheduled);

    await value.runBackgroundTick(5 * 60_000, { now: Date.now() + 13 * HOUR });
    assert.equal(value.getAvailabilityChecks(), 1);
    assert.equal(value.getDirtyMarks(), initialDirty + 1);
    assert.notEqual(fs.readFileSync(watchFile, 'utf8'), scheduled);
  });
});

test('a due check while the server runs records the fulfilled watch', async () => {
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.3.12' }), async value => {
    const due = await scheduleDueWatch(value, value.serverPath);
    value.watcher.startModAvailabilityWatcher();
    const run = await value.coordinator.acquireStart({ instanceId: 'server-watch', serverPath: value.serverPath },
      { operation: 'server-start', operationId: 'watch-server-run', parentMutationLease: null });
    run.markRunning({ pid: 4545 });
    try {
      await value.runBackgroundTick(5 * 60_000, { now: due });
    } finally {
      run.release();
    }
    assert.deepEqual(historyOf(value.serverPath).map(entry => [entry.projectId, entry.versionFound]), [['waiting-mod', '2.0.0']]);
    assert.deepEqual(watchesOf(value.serverPath), []);
    assert.deepEqual(value.safeSendEvents.map(event => event.channel), ['mod-availability-notification']);
  }, { versions: AVAILABLE });
});

test('the Modrinth lookup holds no server lease, so other writers are never delayed', async () => {
  const seen = [];
  let coordinatorRef = null;
  let contextRef = null;
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.3.12' }), async value => {
    coordinatorRef = value.coordinator;
    contextRef = value.context;
    const due = await scheduleDueWatch(value, value.serverPath);
    value.watcher.startModAvailabilityWatcher();
    await value.runBackgroundTick(5 * 60_000, { now: due });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { ambient: null, holders: [], exclusive: 'admitted' });
    assert.equal(historyOf(value.serverPath).length, 1);
  }, {
    versions: async () => {
      // A stopped-only (exclusive) writer can take the server while Modrinth answers.
      const exclusive = await coordinatorRef.runMutation({ instanceId: 'server-watch', serverPath: null }, {
        operation: 'test-exclusive', operationId: 'exclusive-during-lookup', revisionMode: 'none', quiesce: null,
        ordinary: true, stoppedOnly: true
      }, async () => 'admitted');
      seen.push({ ambient: contextRef.getCurrentLease(), holders: coordinatorRef.listActiveOperations(), exclusive });
      return AVAILABLE();
    }
  });
});

test('a watch added while Modrinth is being asked survives the recorded results', async () => {
  let addLate = null;
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.3.12' }), async value => {
    const due = await scheduleDueWatch(value, value.serverPath, 'found-mod');
    addLate = () => value.watcher.addModAvailabilityWatch({ serverPath: value.serverPath, projectId: 'late-mod', targetMc: '1.20.1' });
    value.watcher.startModAvailabilityWatcher();
    await value.runBackgroundTick(5 * 60_000, { now: due });
    assert.deepEqual(historyOf(value.serverPath).map(entry => entry.projectId), ['found-mod']);
    assert.deepEqual(watchesOf(value.serverPath).map(watch => watch.projectId), ['late-mod']);
  }, {
    versions: async projectId => {
      if (projectId === 'found-mod' && addLate) {
        const add = addLate;
        addLate = null;
        await add();
      }
      return projectId === 'found-mod' ? AVAILABLE() : [];
    }
  });
});

test('a server whose check fails does not stop the checks of the next server', async () => {
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.3.12' }), async value => {
    const [blockedPath, healthyPath] = value.serverPaths;
    await scheduleDueWatch(value, blockedPath, 'blocked-mod');
    const due = await scheduleDueWatch(value, healthyPath, 'healthy-mod');
    value.watcher.startModAvailabilityWatcher();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const held = new Promise(resolve => { entered = resolve; });
    // A modpack lifecycle operation holds the first server for the whole check.
    const lifecycle = value.coordinator.runMutation({ instanceId: 'server-blocked', serverPath: blockedPath }, {
      operation: 'modpack-update', operationId: 'lifecycle-blocks-watch', revisionMode: 'none', quiesce: null
    }, async () => { entered(); await gate; });
    await held;
    try {
      await value.runBackgroundTick(5 * 60_000, { now: due });
    } finally {
      release();
      await lifecycle;
    }
    assert.deepEqual(historyOf(blockedPath), []);
    assert.deepEqual(historyOf(healthyPath).map(entry => entry.projectId), ['healthy-mod']);
    assert.deepEqual(watchesOf(healthyPath), []);
  }, { servers: ['server-blocked', 'server-healthy'], versions: AVAILABLE });
});

test('a timer left in a released lease context still runs its next check', async () => {
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.3.12' }), async value => {
    const due = await scheduleDueWatch(value, value.serverPath);
    // The watcher starts while a desktop writer holds the server; its timers keep that context.
    await value.coordinator.runMutation({ instanceId: 'server-watch', serverPath: value.serverPath }, {
      operation: 'test-writer', operationId: 'writer-starts-watcher', revisionMode: 'none', quiesce: null, ordinary: true
    }, async () => { value.watcher.startModAvailabilityWatcher(); });

    await value.runBackgroundTick(5 * 60_000, { now: due });

    assert.deepEqual(historyOf(value.serverPath).map(entry => entry.projectId), ['waiting-mod']);
    assert.deepEqual(watchesOf(value.serverPath), []);
  }, { versions: AVAILABLE });
});

test('a fulfilled watch shows an OS notification only when native toasts are allowed', async t => {
  t.after(() => configureNativeToastPolicy({ identity: { installed: false, isPackaged: true }, env: {} }));
  await withWatcherModule(() => ({ loader: 'forge', loaderVersion: '47.3.12' }), async value => {
    configureNativeToastPolicy({ identity: { installed: false, isPackaged: true }, env: {} });
    const firstDue = await scheduleDueWatch(value, value.serverPath, 'first-mod');
    value.watcher.startModAvailabilityWatcher();
    await value.runBackgroundTick(5 * 60_000, { now: firstDue });
    assert.equal(historyOf(value.serverPath).length, 1);
    assert.deepEqual(value.notifications, []);

    configureNativeToastPolicy({ identity: { installed: true, isPackaged: true }, env: {} });
    await scheduleDueWatch(value, value.serverPath, 'second-mod');
    // The first check scheduled the next one 12 hours after it ran.
    await value.runBackgroundTick(5 * 60_000, { now: firstDue + 13 * HOUR });
    assert.equal(historyOf(value.serverPath).length, 2);
    assert.deepEqual(value.notifications.map(notification => notification.title), ['Mod Now Available']);
  }, { appSettings: { modWatch: { showWindowsNotifications: true } }, versions: AVAILABLE });
});
