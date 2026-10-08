const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  createForgeInstallResponse,
  verifyForgeInstallRequest
} = require('../electron/services/forge-installer-worker-protocol.cjs');

let clientModule = null;
try {
  clientModule = require('../electron/services/forge-installer-worker-client.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions below without the module.
}

const token = 'c'.repeat(64);
const requestId = 'd'.repeat(32);

class FakeChild extends EventEmitter {
  constructor(pid = 4242, closeOnKill = true, closeOnDisconnect = true) {
    super();
    this.pid = pid;
    this.closeOnKill = closeOnKill;
    this.closeOnDisconnect = closeOnDisconnect;
    this.connected = true;
    this.sent = [];
    this.killSignals = [];
    this.disconnectCalls = 0;
  }

  send(message, callback) {
    this.sent.push(message);
    queueMicrotask(() => callback?.(null));
    return true;
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
    if (this.closeOnDisconnect) queueMicrotask(() => this.emit('close', 65, null));
  }
}

function fixtureOptions(overrides = {}) {
  return {
    targetPath: path.resolve('worker-client-fixture', 'server'),
    minecraftVersion: '1.12.2',
    loaderVersion: '14.23.5.2860',
    javaPath: path.resolve('worker-client-fixture', 'java', 'bin', 'java.exe'),
    timeoutMs: 1000,
    ...overrides
  };
}

function createHarness({ child = new FakeChild(), execFileImpl } = {}) {
  const forks = [];
  const taskkills = [];
  const forkImpl = (modulePath, args, options) => {
    forks.push({ modulePath, args, options });
    return child;
  };
  const runExecFile = execFileImpl || ((file, args, options, callback) => {
    taskkills.push({ file, args, options });
    queueMicrotask(() => {
      callback?.(null, '', '');
      child.emit('close', null, 'SIGKILL');
    });
  });
  const run = clientModule.createForgeInstallerWorkerClient({
    forkImpl,
    execFileImpl: runExecFile,
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'forge-installer-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  return { child, forks, taskkills, run };
}

test('authenticated success waits for a clean close and gives worker output a zero-byte bound', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');
  const harness = createHarness();
  const options = fixtureOptions();
  const pending = harness.run(options);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.forks.length, 1);
  const fork = harness.forks[0];
  assert.deepEqual(fork.args, []);
  assert.deepEqual(fork.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(fork.options.windowsHide, true);
  assert.equal(fork.options.detached, false);
  assert.equal(fork.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(JSON.stringify({ args: fork.args, options: fork.options }).includes(options.targetPath), false);
  assert.equal(JSON.stringify({ args: fork.args, options: fork.options }).includes(options.javaPath), false);
  assert.deepEqual(verifyForgeInstallRequest(harness.child.sent[0], token), {
    requestId,
    payload: {
      targetPath: options.targetPath,
      minecraftVersion: options.minecraftVersion,
      loaderVersion: options.loaderVersion,
      javaPath: options.javaPath
    }
  });

  let settled = false;
  pending.finally(() => { settled = true; });
  harness.child.emit('message', createForgeInstallResponse({ token, requestId, ok: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  harness.child.emit('close', 0, null);
  assert.deepEqual(await pending, { success: true });
});

test('an authenticated success response followed by a nonzero exit fails closed', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');
  const harness = createHarness();
  const options = fixtureOptions();
  const pending = harness.run(options);
  await new Promise(resolve => setImmediate(resolve));
  harness.child.emit('message', createForgeInstallResponse({ token, requestId, ok: true }));
  harness.child.emit('close', 7, null);

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'RUNTIME_INCOMPLETE');
    assert.equal(error.message.includes(options.targetPath), false);
    assert.equal(error.message.includes(options.javaPath), false);
    return true;
  });
});

test('abnormal Forge worker death cannot authorize cleanup of possible Java descendants', async () => {
  const { waitForRuntimeWorkerQuiescence } = require('../electron/services/runtime-worker-quiescence.cjs');
  const harness = createHarness();
  const pending = harness.run(fixtureOptions());
  harness.child.emit('close', null, 'SIGKILL');
  const failure = await pending.catch(error => error);

  await assert.rejects(waitForRuntimeWorkerQuiescence(failure), error => error.code === 'RECOVERY_REQUIRED');
  assert.equal(failure.preserveWorkspace, true);
});

test('worker failures expose no child diagnostic and wait for process close', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');
  const harness = createHarness();
  const options = fixtureOptions();
  const pending = harness.run(options);
  await new Promise(resolve => setImmediate(resolve));
  harness.child.emit('message', createForgeInstallResponse({ token, requestId, ok: false }));

  harness.child.emit('close', 1, null);

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'RUNTIME_INCOMPLETE');
    assert.equal(error.message.includes(options.targetPath), false);
    assert.equal(error.message.includes('INSTALL_FAILED'), false);
    return true;
  });
  assert.deepEqual(harness.child.killSignals, []);
  assert.equal(harness.child.disconnectCalls, 0);
  assert.equal(harness.taskkills.length, 0);
});

test('timeout disconnects the descendant-capable worker and rejects only after its close', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');
  const harness = createHarness();
  const pending = harness.run(fixtureOptions({ timeoutMs: 5, terminationGraceMs: 100 }));

  await assert.rejects(pending, error => error.code === 'RUNTIME_INCOMPLETE');
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(harness.child.killSignals, []);
  assert.equal(harness.child.disconnectCalls, 1);
});

test('cancellation disconnects the descendant-capable worker and remains a generic cancellation', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');
  const harness = createHarness();
  const controller = new AbortController();
  const options = fixtureOptions({ signal: controller.signal, terminationGraceMs: 100 });
  const pending = harness.run(options);
  controller.abort();

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'CANCELLED');
    assert.equal(error.preserveWorkspace, true);
    assert.equal(error.message.includes(options.targetPath), false);
    return true;
  });
  assert.equal(harness.taskkills.length, 0);
  assert.deepEqual(harness.child.killSignals, []);
  assert.equal(harness.child.disconnectCalls, 1);
});

test('an unclosable descendant-capable worker is retained after bounded rejection until actual close', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');
  const child = new FakeChild(4242, false, false);
  const harness = createHarness({
    child,
    execFileImpl(file, args, options, callback) {
      harness.taskkills.push({ file, args, options });
      queueMicrotask(() => callback?.(new Error('tree termination failed')));
    }
  });
  const pending = harness.run(fixtureOptions({ timeoutMs: 5, terminationGraceMs: 15 }));

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'RUNTIME_INCOMPLETE');
    assert.equal(error.preserveWorkspace, true);
    return true;
  });
  assert.deepEqual(child.killSignals, []);
  assert.equal(child.disconnectCalls, 1);
  child.emit('close', 0, null);
});

test('termination never authorizes a reusable numeric pid or kills a descendant-capable outer worker', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');
  const child = new FakeChild(4242);
  const originalKill = child.kill.bind(child);
  child.kill = signal => {
    const result = originalKill(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return result;
  };
  let pidTerminationCalls = 0;
  const run = clientModule.createForgeInstallerWorkerClient({
    forkImpl: () => child,
    execFileImpl() {
      pidTerminationCalls += 1;
      throw new Error('numeric pid termination must not be used');
    },
    processKillImpl() {
      pidTerminationCalls += 1;
      throw new Error('numeric process-group termination must not be used');
    },
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'forge-installer-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });

  await assert.rejects(
    run(fixtureOptions({ timeoutMs: 5, terminationGraceMs: 100 })),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.equal(pidTerminationCalls, 0);
  assert.deepEqual(child.killSignals, []);
  assert.equal(child.disconnectCalls, 1);
});

test('pre-send listener and AbortSignal setup failures kill only the exact retained child', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');
  const cases = [
    ['message-listener', child => { child.on = () => { throw new Error('on trap'); }; }, undefined],
    ['close-listener', child => { child.once = () => { throw new Error('once trap'); }; }, undefined],
    ['abort-listener', () => {}, (() => {
      const signal = new AbortController().signal;
      Object.defineProperty(signal, 'addEventListener', {
        value() { throw new Error('abort listener trap'); }
      });
      return signal;
    })()]
  ];

  for (const [name, mutateChild, signal] of cases) {
    const child = new FakeChild(4242, true, true);
    mutateChild(child);
    let pidTerminationCalls = 0;
    const run = clientModule.createForgeInstallerWorkerClient({
      forkImpl: () => child,
      execFileImpl() { pidTerminationCalls += 1; },
      processKillImpl() { pidTerminationCalls += 1; },
      platform: 'win32',
      workerPath: path.resolve('electron', 'services', 'forge-installer-worker.cjs'),
      tokenFactory: () => token,
      requestIdFactory: () => requestId
    });

    await assert.rejects(
      run(fixtureOptions({ ...(signal ? { signal } : {}), terminationGraceMs: 10 })),
      error => error.code === 'RUNTIME_INCOMPLETE' && !error.message.includes('trap'),
      name
    );
    assert.deepEqual(child.killSignals, ['SIGKILL'], name);
    assert.equal(child.disconnectCalls, 0, name);
    assert.equal(pidTerminationCalls, 0, name);
  }
});

test('a throwing send getter is pre-send, while a throwing send call may have been accepted', async () => {
  assert.equal(typeof clientModule?.createForgeInstallerWorkerClient, 'function');

  const getterChild = new FakeChild();
  Object.defineProperty(getterChild, 'send', {
    get() { throw new Error('send getter trap'); }
  });
  const getterRun = clientModule.createForgeInstallerWorkerClient({
    forkImpl: () => getterChild,
    platform: 'win32',
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  await assert.rejects(
    getterRun(fixtureOptions({ terminationGraceMs: 10 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && !error.message.includes('trap')
  );
  assert.deepEqual(getterChild.killSignals, ['SIGKILL']);
  assert.equal(getterChild.disconnectCalls, 0);

  const callChild = new FakeChild();
  callChild.send = () => { throw new Error('send call trap'); };
  const callRun = clientModule.createForgeInstallerWorkerClient({
    forkImpl: () => callChild,
    platform: 'win32',
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  await assert.rejects(
    callRun(fixtureOptions({ terminationGraceMs: 10 })),
    error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true &&
      !error.message.includes('trap')
  );
  assert.deepEqual(callChild.killSignals, []);
  assert.equal(callChild.disconnectCalls, 1);
});
