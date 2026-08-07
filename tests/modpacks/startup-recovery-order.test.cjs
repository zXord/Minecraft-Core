const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { createMainBootstrap } = require('../../electron/bootstrap/create-main-bootstrap.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function runtimeFlags(overrides = {}) {
  return {
    testMode: false,
    platform: 'win32',
    updaterEnabled: true,
    trayEnabled: true,
    watchdogEnabled: true,
    nativeNotificationsEnabled: true,
    publicManagementListenersEnabled: true,
    ...overrides
  };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function recoveryPathHash(value) {
  const normalized = path.win32.normalize(value.replaceAll('/', '\\')).normalize('NFC').toLocaleLowerCase('en-US');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

test('IPC setup cannot run before recovery finishes', async () => {
  const order = [];
  const recoveryGate = deferred();
  const bootstrap = createMainBootstrap({
    electronApi: { app: { setName() {}, setAppUserModelId() {} } },
    runtimeFlags: runtimeFlags(),
    serviceGraph: {
      startup: {
        async initializeRecovery() {
          order.push('recover-all');
          await recoveryGate.promise;
        },
        async completeRecovery() {
          order.push('legacy-empty-recovery');
        }
      },
      window: {
        create() {
          order.push('setup-ipc');
          return { id: 1 };
        }
      }
    }
  });

  const ready = bootstrap.onReady();
  await tick();
  assert.deepEqual(order, ['recover-all']);
  recoveryGate.resolve();
  await ready;
  assert.deepEqual(order, ['recover-all', 'setup-ipc']);
});

test('startup recovery installs every discoverable block before attempting a record', async () => {
  const { initializeStartupRecovery } = require('../../electron/services/modpack-lifecycle/startup-recovery-bootstrap.cjs');
  const order = [];
  const record = {
    jobId: 'job-alpha',
    target: { stableServerId: 'alpha', path: 'C:\\Minecraft\\Alpha' }
  };
  const initial = {
    records: [record],
    corrupt: [],
    blocks: [{ jobId: 'job-alpha', stableServerId: 'alpha', targetPathHash: recoveryPathHash(record.target.path), targetLabel: 'Alpha' }],
    globalBlock: false
  };
  const final = { records: [], corrupt: [], blocks: [], globalBlock: false };
  let scans = 0;
  const coordinator = {
    beginStartupRecovery() { order.push('begin'); },
    installRecoveryBlocks(blocks) {
      order.push(`install:${blocks.map(item => item.operationId).join(',')}`);
    },
    completeStartupRecovery(outcomes, options) {
      order.push(`complete:${outcomes.map(item => `${item.selector.instanceId}:${item.resolved}`).join(',')}:${options.globalBlock}`);
      return { resolved: 1, unresolved: 0, globalBlocked: options.globalBlock };
    }
  };
  const registry = {
    initialize() {
      order.push(`scan:${scans + 1}`);
      scans += 1;
      return scans === 1 ? initial : final;
    }
  };
  const recoveryService = {
    async recoverAll(scan) {
      assert.equal(scan, initial);
      order.push('recover');
      return { recovered: ['job-alpha'], unresolved: [] };
    }
  };
  const runtimeVerifier = { verifyBeforeRecovery() { order.push('runtime'); return { quiescent: true }; } };

  const result = await initializeStartupRecovery({ coordinator, registry, recoveryService, runtimeVerifier });

  assert.deepEqual(order, [
    'begin',
    'runtime',
    'scan:1',
    'install:job-alpha',
    'recover',
    'scan:2',
    'complete:alpha:true:false'
  ]);
  assert.deepEqual(result, { recovered: ['job-alpha'], unresolved: [], globalBlock: false });
  assert.equal(Object.isFrozen(result), true);
});

test('identifiable corruption stays scoped while unidentifiable corruption retains the global block', async () => {
  const { initializeStartupRecovery } = require('../../electron/services/modpack-lifecycle/startup-recovery-bootstrap.cjs');
  const record = {
    jobId: 'job-corrupt',
    target: { stableServerId: 'alpha', path: 'C:\\Minecraft\\Alpha' }
  };
  const scan = {
    records: [record],
    corrupt: [{ jobId: 'job-corrupt', recordValid: true, envelopeValid: false, mismatched: false }],
    blocks: [{ jobId: 'job-corrupt', stableServerId: 'alpha', targetPathHash: recoveryPathHash(record.target.path), targetLabel: 'Alpha' }],
    globalBlock: true
  };
  const installed = [];
  const completions = [];
  let recoverCalls = 0;
  const coordinator = {
    beginStartupRecovery() {},
    installRecoveryBlocks(value) { installed.push(...value); },
    completeStartupRecovery(value, options) { completions.push({ value, options }); return {}; }
  };
  const registry = { initialize: async () => scan };
  const recoveryService = {
    async recoverAll(value) {
      recoverCalls += 1;
      assert.equal(value, scan);
      return { recovered: [], unresolved: ['job-corrupt'] };
    }
  };

  const result = await initializeStartupRecovery({
    coordinator,
    registry,
    recoveryService,
    runtimeVerifier: { verifyBeforeRecovery: async () => ({ quiescent: true }) }
  });

  assert.equal(recoverCalls, 1);
  assert.deepEqual(installed, [{
    operationId: 'job-corrupt',
    selector: { instanceId: 'alpha', serverPath: 'C:\\Minecraft\\Alpha' }
  }]);
  assert.deepEqual(completions, [{
    value: [{ selector: { instanceId: 'alpha', serverPath: 'C:\\Minecraft\\Alpha' }, resolved: false }],
    options: { globalBlock: true }
  }]);
  assert.deepEqual(result.unresolved, ['job-corrupt']);
  assert.equal(result.globalBlock, true);
});

test('fatal runtime verification or registry scan exposes no cleanup, window, IPC, or listener', async () => {
  for (const failAt of ['runtime', 'scan']) {
    const order = [];
    const bootstrap = createMainBootstrap({
      electronApi: { app: { setName() {}, setAppUserModelId() {} } },
      runtimeFlags: runtimeFlags(),
      serviceGraph: {
        startup: {
          async initializeRecovery() {
            order.push('recovery');
            throw new Error(`${failAt} failed`);
          },
          cleanupRuntime() { order.push('cleanup'); },
          configureAfterReady() { order.push('configure'); },
          afterWindowCreated() { order.push('after-window'); }
        },
        tray: { start() { order.push('tray'); } },
        updater: { start() { order.push('updater'); } },
        watchdog: { start() { order.push('watchdog'); } },
        nativeNotifications: { start() { order.push('notifications'); } },
        managementServer: { listen() { order.push('management'); } },
        window: { create() { order.push('window+ipc'); return {}; } }
      }
    });

    await assert.rejects(bootstrap.onReady(), new RegExp(`${failAt} failed`));
    assert.deepEqual(order, ['recovery']);
  }
});

test('concurrent ready calls perform one recovery pass and one exposure pass', async () => {
  let recoveries = 0;
  let windows = 0;
  const bootstrap = createMainBootstrap({
    electronApi: { app: { setName() {}, setAppUserModelId() {} } },
    runtimeFlags: runtimeFlags({
      updaterEnabled: false,
      trayEnabled: false,
      watchdogEnabled: false,
      nativeNotificationsEnabled: false,
      publicManagementListenersEnabled: false
    }),
    serviceGraph: {
      startup: { async initializeRecovery() { recoveries += 1; } },
      window: { create() { windows += 1; return { id: windows }; } }
    }
  });

  const [left, right] = await Promise.all([bootstrap.onReady(), bootstrap.onReady()]);
  assert.equal(recoveries, 1);
  assert.equal(windows, 1);
  assert.equal(left, right);
});

test('window activation cannot bypass pending or failed startup recovery', async () => {
  for (const outcome of ['pending-then-pass', 'fail']) {
    const gate = deferred();
    const order = [];
    let currentWindow = null;
    const bootstrap = createMainBootstrap({
      electronApi: { app: { setName() {}, setAppUserModelId() {} } },
      runtimeFlags: runtimeFlags({
        updaterEnabled: false,
        trayEnabled: false,
        watchdogEnabled: false,
        nativeNotificationsEnabled: false,
        publicManagementListenersEnabled: false
      }),
      serviceGraph: {
        startup: {
          async initializeRecovery() {
            order.push('recovery');
            await gate.promise;
            if (outcome === 'fail') throw new Error('recovery failed');
          }
        },
        window: {
          create() {
            order.push('window');
            currentWindow = { id: 1 };
            return currentWindow;
          },
          get() { return currentWindow; }
        }
      }
    });

    const activation = bootstrap.createWindowAfterRecovery();
    await tick();
    assert.deepEqual(order, ['recovery']);
    if (outcome === 'fail') {
      gate.resolve();
      await assert.rejects(activation, /recovery failed/);
      assert.deepEqual(order, ['recovery']);
    } else {
      gate.resolve();
      const window = await activation;
      assert.equal(window, currentWindow);
      assert.deepEqual(order, ['recovery', 'window']);
    }
  }
});
