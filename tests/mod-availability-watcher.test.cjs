const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

async function withWatcherModule(resolveLoaderImpl, fn) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-watch-'));
  const safeSendEvents = [];
  const originalLoad = Module._load;
  const loaderStub = {
    resolveServerLoader: resolveLoaderImpl,
    normalizeLoaderName: (value) => (value ? String(value).trim().toLowerCase() : value)
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request.endsWith('safe-send.cjs')) {
      return { safeSend: (channel, data) => safeSendEvents.push({ channel, data }) };
    }
    if (request.endsWith('app-store.cjs')) {
      return {
        get: () => ({}),
        set: () => {}
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
    await fn({ watcher, serverPath: tmpRoot, safeSendEvents });
  } finally {
    try {
      await watcher.clearModAvailabilityWatches(tmpRoot);
      await watcher.clearModAvailabilityHistory(tmpRoot);
    } catch {
      // ignore cleanup errors
    }
    Module._load = originalLoad;
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
