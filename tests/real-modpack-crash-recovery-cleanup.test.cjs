const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let finalizeCrashRecoveryRun;
try {
  ({ finalizeCrashRecoveryRun } = require('./e2e/fixtures/real-modpack-crash-recovery-cleanup.cjs'));
} catch {
  // The first TDD run proves the cleanup boundary does not exist yet.
}

function fixture({
  stopResult,
  stopError,
  serverStatuses,
  serverStatusResponses,
  statusError,
  closeError,
  scenarioAssertionsPassed = true
} = {}) {
  const lifecycle = {
    root: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture'),
    serverPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
    disposeCalls: [],
    async dispose(options) {
      this.disposeCalls.push(options);
    }
  };
  const instance = { instanceId: 'crash-recovery-server' };
  const calls = [];
  return {
    lifecycle,
    instance,
    calls,
    options: {
      page: { marker: 'page' },
      electronApp: { marker: 'electron' },
      instance,
      lifecycle,
      scenarioAssertionsPassed,
      async stopServer(page, receivedLifecycle, instanceId) {
        calls.push('stop');
        assert.equal(page.marker, 'page');
        assert.equal(receivedLifecycle, lifecycle);
        assert.equal(instanceId, instance.instanceId);
        if (stopError) throw stopError;
        return stopResult ?? {
          instanceId: instance.instanceId,
          targetPath: lifecycle.serverPath,
          isRunning: false,
          status: 'stopped'
        };
      },
      async listServerStatuses(page) {
        calls.push('statuses');
        assert.equal(page.marker, 'page');
        if (statusError) throw statusError;
        if (Array.isArray(serverStatusResponses)) {
          const responseIndex = calls.filter(call => call === 'statuses').length - 1;
          return serverStatusResponses[Math.min(responseIndex, serverStatusResponses.length - 1)];
        }
        return serverStatuses ?? [{
          instanceId: instance.instanceId,
          targetPath: lifecycle.serverPath,
          isRunning: false,
          status: 'stopped'
        }];
      },
      async closeElectron(app) {
        calls.push('close');
        assert.equal(app.marker, 'electron');
        if (closeError) throw closeError;
      },
      async preserveEvidence() {
        calls.push('evidence');
      }
    }
  };
}

test('crash recovery accepts one exact already-stopped inventory entry without calling stop again', async () => {
  assert.equal(typeof finalizeCrashRecoveryRun, 'function');
  const state = fixture();

  const result = await finalizeCrashRecoveryRun(state.options);

  assert.deepEqual(result, {
    safeToDelete: true,
    serverStopConfirmed: true,
    noOwnedJavaConfirmed: true,
    electronCloseConfirmed: true
  });
  assert.deepEqual(state.calls, ['statuses', 'close']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: false }]);
});

test('crash recovery stops one exact running entry and re-audits the complete inventory', async () => {
  assert.equal(typeof finalizeCrashRecoveryRun, 'function');
  const running = fixture({
    stopError: new Error('the process exited between inventory and stop'),
    serverStatusResponses: [[{
      instanceId: 'crash-recovery-server',
      targetPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
      isRunning: true,
      status: 'running'
    }], [{
      instanceId: 'crash-recovery-server',
      targetPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
      isRunning: false,
      status: 'stopped'
    }]]
  });

  const result = await finalizeCrashRecoveryRun(running.options);

  assert.deepEqual(result, {
    safeToDelete: true,
    serverStopConfirmed: true,
    noOwnedJavaConfirmed: true,
    electronCloseConfirmed: true
  });
  assert.deepEqual(running.calls, ['statuses', 'stop', 'statuses', 'close']);
  assert.deepEqual(running.lifecycle.disposeCalls, [{ preserveRoot: false }]);
});

test('crash recovery rejects a missing exact owned status instead of attempting a blind stop', async () => {
  const state = fixture({ serverStatuses: [] });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('crash recovery rejects ambiguous exact owned statuses instead of choosing one', async () => {
  const exact = {
    instanceId: 'crash-recovery-server',
    targetPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
    isRunning: false,
    status: 'stopped'
  };
  const state = fixture({ serverStatuses: [exact, { ...exact }] });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('crash recovery rejects an id-or-path ownership mismatch', async () => {
  const state = fixture({
    serverStatuses: [{
      instanceId: 'different-server',
      targetPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
      isRunning: false,
      status: 'stopped'
    }]
  });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('crash recovery preserves the root when the exact owned status remains running after stop', async () => {
  const runningStatus = {
    instanceId: 'crash-recovery-server',
    targetPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
    isRunning: true,
    status: 'running'
  };
  const state = fixture({ serverStatusResponses: [[runningStatus], [{ ...runningStatus }]] });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'stop', 'statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('crash recovery preserves evidence and fails a completed run when owned Java exit is uncertain', async () => {
  assert.equal(typeof finalizeCrashRecoveryRun, 'function');
  const runningStatus = {
    instanceId: 'crash-recovery-server',
    targetPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
    isRunning: true,
    status: 'running'
  };
  const state = fixture({
    stopError: new Error('stop was not confirmed'),
    serverStatusResponses: [[runningStatus], [{ ...runningStatus }]]
  });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'stop', 'statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('crash recovery rejects a mismatched final inventory after requesting stop', async () => {
  assert.equal(typeof finalizeCrashRecoveryRun, 'function');
  const state = fixture({
    stopResult: false,
    serverStatusResponses: [[{
      instanceId: 'crash-recovery-server',
      targetPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
      isRunning: true,
      status: 'running'
    }], [{
      instanceId: 'different-server',
      targetPath: path.resolve('C:\\Temp\\different-server'),
      isRunning: false,
      status: 'stopped'
    }]]
  });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'stop', 'statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('crash recovery preserves the root when Electron close is uncertain even after Java stopped', async () => {
  assert.equal(typeof finalizeCrashRecoveryRun, 'function');
  const state = fixture({ closeError: new Error('Electron stayed alive') });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('crash recovery preserves the root while any matching managed Java process remains', async () => {
  assert.equal(typeof finalizeCrashRecoveryRun, 'function');
  const state = fixture({
    serverStatuses: [{
      instanceId: 'different-id-for-the-same-server-path',
      targetPath: path.resolve('C:\\Temp\\minecraft-core-real-modrinth-crash-recovery-e2e-fixture\\server'),
      isRunning: true,
      status: 'running'
    }]
  });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('crash recovery treats an unavailable all-statuses check as owned-Java uncertainty', async () => {
  assert.equal(typeof finalizeCrashRecoveryRun, 'function');
  const state = fixture({ statusError: new Error('server statuses unavailable') });

  await assert.rejects(
    finalizeCrashRecoveryRun(state.options),
    /cleanup could not be confirmed safely/iu
  );

  assert.deepEqual(state.calls, ['statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});

test('an already-failed crash scenario preserves evidence without masking the original failure', async () => {
  assert.equal(typeof finalizeCrashRecoveryRun, 'function');
  const state = fixture({
    scenarioAssertionsPassed: false,
    stopError: new Error('stop uncertainty during failure cleanup'),
    statusError: new Error('status uncertainty during failure cleanup'),
    closeError: new Error('Electron close uncertainty during failure cleanup')
  });

  const result = await finalizeCrashRecoveryRun(state.options);

  assert.deepEqual(result, {
    safeToDelete: false,
    serverStopConfirmed: false,
    noOwnedJavaConfirmed: false,
    electronCloseConfirmed: false
  });
  assert.deepEqual(state.calls, ['statuses', 'close', 'evidence']);
  assert.deepEqual(state.lifecycle.disposeCalls, [{ preserveRoot: true }]);
});
