const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  closeProductionElectron,
  createIsolatedRealLifecycle,
  stopIsolatedServer
} = require('./e2e/fixtures/real-modpack-harness.cjs');

test('isolated server stop waits until the managed process has actually exited', async () => {
  const lifecycle = await createIsolatedRealLifecycle();
  const statuses = [
    { instanceId: 'disposable-server', isRunning: true, status: 'stopping' },
    { instanceId: 'disposable-server', isRunning: false, status: 'stopped' }
  ];
  const channels = [];
  const page = {
    async evaluate(_callback, payload) {
      channels.push(payload.channel);
      if (payload.channel === 'stop-server') return { success: true };
      if (payload.channel === 'get-server-status') return statuses.shift();
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  try {
    const stopped = await stopIsolatedServer(page, lifecycle, 'disposable-server', {
      timeoutMs: 50,
      pollMs: 1
    });

    assert.deepEqual(stopped, { instanceId: 'disposable-server', isRunning: false, status: 'stopped' });
    assert.deepEqual(channels, ['stop-server', 'get-server-status', 'get-server-status']);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('isolated server stop force-kills only the selected disposable server when graceful shutdown is rejected', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'forced-server-stop' });
  const requests = [];
  const page = {
    async evaluate(_callback, payload) {
      requests.push(payload);
      if (payload.channel === 'stop-server') return { success: false };
      if (payload.channel === 'kill-server') return { success: true };
      if (payload.channel === 'get-server-status') {
        return { instanceId: 'disposable-server', isRunning: false, status: 'stopped' };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  try {
    const stopped = await stopIsolatedServer(page, lifecycle, 'disposable-server', {
      timeoutMs: 50,
      pollMs: 1
    });

    assert.equal(stopped.isRunning, false);
    assert.deepEqual(requests, [
      {
        channel: 'stop-server',
        request: { instanceId: 'disposable-server', targetPath: lifecycle.serverPath }
      },
      {
        channel: 'kill-server',
        request: { instanceId: 'disposable-server', targetPath: lifecycle.serverPath }
      },
      {
        channel: 'get-server-status',
        request: { instanceId: 'disposable-server', targetPath: lifecycle.serverPath }
      }
    ]);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

for (const [stage, channel, response] of [
  ['graceful stop', 'stop-server', null],
  ['force kill', 'kill-server', { success: false }],
  ['status', 'get-server-status', { success: true }]
]) {
  test(`isolated server teardown expires its external deadline when ${stage} IPC never settles`, async () => {
    const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'teardown-ipc-deadline' });
    let finalized = false;
    const page = {
      async evaluate(_callback, payload) {
        if (payload.channel === channel) return new Promise(() => {});
        if (payload.channel === 'stop-server') return response ?? { success: false };
        if (payload.channel === 'kill-server') return response ?? { success: true };
        if (payload.channel === 'get-server-status') return response ?? { isRunning: true, status: 'running' };
        throw new Error(`Unexpected IPC channel ${payload.channel}`);
      }
    };

    try {
      await assert.rejects(
        Promise.race([
          stopIsolatedServer(page, lifecycle, 'disposable-server', { timeoutMs: 30, pollMs: 1 }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('test watchdog: teardown IPC remained unbounded')), 200))
        ]),
        error => error?.code === 'E2E_TEARDOWN_IPC_TIMEOUT' && error?.stage === stage
      );
      finalized = true;
    } finally {
      await lifecycle.dispose({ preserveRoot: false });
    }

    assert.equal(finalized, true);
  });
}

test('production Electron harness force-closes windows without entering the app quit confirmation', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const calls = [];
  const electronApp = {
    evaluate(callback) {
      calls.push('evaluate');
      return Promise.resolve(callback({
        BrowserWindow: {
          getAllWindows() {
            return [{ destroy() { calls.push('destroy'); } }];
          }
        },
        app: {
          quit() {
            calls.push('quit');
            setImmediate(() => {
              child.exitCode = 0;
              child.emit('exit', 0, null);
            });
          }
        }
      }));
    },
    process() {
      return child;
    },
    close() {
      calls.push('close');
      return new Promise(() => {});
    }
  };

  await Promise.race([
    closeProductionElectron(electronApp, { timeoutMs: 50 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Harness close entered the production quit confirmation')), 25))
  ]);

  assert.deepEqual(calls, ['evaluate', 'destroy', 'quit']);
  assert.equal(child.exitCode, 0);
});
