const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

async function withWatcherModule(resolveLoaderImpl, fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-watch-'));
  const safeSendEvents = [];
  let dirtyMarks = 0;
  let availabilityChecks = 0;
  const intervals = [];
  const pendingIo = new Set();
  const originalLoad = Module._load;
  const originalSetInterval = global.setInterval;
  global.setInterval = (callback, milliseconds) => {
    const timer = { callback, milliseconds };
    intervals.push(timer);
    return timer;
  };
  const settleIo = async () => {
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      if (pendingIo.size === 0) return;
      await Promise.all([...pendingIo]);
    }
  };
  const loaderStub = {
    resolveServerLoader: resolveLoaderImpl,
    normalizeLoaderName: (value) => (value ? String(value).trim().toLowerCase() : value)
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request.endsWith('mod-api-service.cjs')) return {
      async getModrinthVersions() { availabilityChecks++; return []; }
    };
    if (request === 'fs/promises' && parent?.filename.endsWith('mod-availability-watcher.cjs')) {
      return new Proxy(fs.promises, { get(target, property) {
        if (!['mkdir', 'readFile', 'writeFile'].includes(property)) return target[property];
        return (...args) => {
          const pending = target[property](...args);
          pendingIo.add(pending);
          pending.then(() => pendingIo.delete(pending), () => pendingIo.delete(pending));
          return pending;
        };
      } });
    }
    if (request.endsWith('safe-send.cjs')) {
      return { safeSend: (channel, data) => safeSendEvents.push({ channel, data }) };
    }
    if (request.endsWith('app-store.cjs')) {
      return {
        get: (key) => key === 'instances'
          ? [{ id: 'server-watch', type: 'server', path: tmpRoot }]
          : {},
        set: () => {}
      };
    }
    if (request.endsWith('server-mutation-context.cjs')) {
      return {
        getCurrentServerMutationLease: () => ({
          assertOwnedPath(candidate) {
            assert.equal(path.resolve(candidate), path.resolve(tmpRoot));
          }
        }),
        getServerMutationCoordinator() {
          throw new Error('ambient lease should be reused');
        },
        markCurrentServerMutationDirty(candidate) {
          assert.equal(path.resolve(candidate), path.resolve(tmpRoot));
          dirtyMarks += 1;
          return true;
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

  try {
    await watcher.clearModAvailabilityWatches(tmpRoot);
    await watcher.clearModAvailabilityHistory(tmpRoot);
    await fn({ watcher, serverPath: tmpRoot, safeSendEvents, getDirtyMarks: () => dirtyMarks,
      getAvailabilityChecks: () => availabilityChecks,
      async runBackgroundTick(milliseconds) {
        const timer = intervals.find(value => value.milliseconds === milliseconds);
        assert.ok(timer, 'production background timer must be registered');
        timer.callback();
        await settleIo();
      }
    });
  } finally {
    await settleIo();
    try {
      await watcher.clearModAvailabilityWatches(tmpRoot);
      await watcher.clearModAvailabilityHistory(tmpRoot);
    } catch {
      // ignore cleanup errors
    }
    Module._load = originalLoad;
    global.setInterval = originalSetInterval;
    delete require.cache[modulePath];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
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

    const originalNow = Date.now;
    const afterDue = originalNow() + 13 * 60 * 60 * 1000;
    Date.now = () => afterDue;
    try { await value.runBackgroundTick(5 * 60_000); }
    finally { Date.now = originalNow; }
    assert.equal(value.getAvailabilityChecks(), 1);
    assert.equal(value.getDirtyMarks(), initialDirty + 1);
    assert.notEqual(fs.readFileSync(watchFile, 'utf8'), scheduled);
  });
});
