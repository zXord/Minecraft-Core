const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  WindowsReparseInspector
} = require('../../electron/services/modpacks/local/windows-reparse-inspector.cjs');

function spawnHarness({ stdout = '{"version":1,"isReparsePoint":false}', stderr = '', exitCode = 0, waitForKill = false } = {}) {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.closed = false;
    const input = [];
    child.stdin.on('data', chunk => input.push(Buffer.from(chunk)));
    const close = (code, signal) => {
      if (child.closed) return;
      child.closed = true;
      child.emit('close', code, signal);
    };
    child.kill = () => {
      child.killed = true;
      setImmediate(() => close(null, 'SIGTERM'));
      return true;
    };
    child.stdin.on('finish', () => {
      if (waitForKill) return;
      setImmediate(() => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => close(exitCode, null));
      });
    });
    calls.push({ executable, args, options, child, input });
    return child;
  };
  return { calls, spawnProcess };
}

function persistentSpawnHarness({
  isReparsePoint = () => false,
  responseDelayMsFor = () => 0,
  exitFor = () => null,
  responseFor = request => ({
    id: request.id,
    version: 1,
    isReparsePoint: isReparsePoint(request.path)
  })
} = {}) {
  const calls = [];
  const requests = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.closed = false;
    child.unref = () => {};
    child.stdin.unref = () => {};
    child.stdout.unref = () => {};
    child.stderr.unref = () => {};
    let buffered = '';
    const close = (code, signal) => {
      if (child.closed) return;
      child.closed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code, signal);
    };
    const respondPersistent = line => {
      const request = JSON.parse(line);
      requests.push(request);
      const requestedExit = exitFor(request, calls.length);
      if (requestedExit) {
        setImmediate(() => close(requestedExit.code, requestedExit.signal ?? null));
        return;
      }
      const response = responseFor(request);
      if (response === null) return;
      const respond = () => {
        if (!child.closed) child.stdout.write(`${typeof response === 'string' ? response : JSON.stringify(response)}\n`);
      };
      const delayMs = responseDelayMsFor(request);
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    };
    child.kill = () => {
      child.killed = true;
      setImmediate(() => close(null, 'SIGTERM'));
      return true;
    };
    child.stdin.on('data', chunk => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline === -1) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) respondPersistent(line);
      }
    });
    child.stdin.on('finish', () => {
      if (buffered) {
        const request = JSON.parse(buffered);
        requests.push(request);
        child.stdout.write(JSON.stringify({ version: 1, isReparsePoint: isReparsePoint(request.path) }));
        buffered = '';
      }
      setImmediate(() => close(0, null));
    });
    calls.push({ executable, args, options, child });
    return child;
  };
  return { calls, requests, spawnProcess };
}

class TrackingSignal {
  constructor() {
    this.aborted = false;
    this.listeners = new Set();
  }

  addEventListener(type, listener) {
    if (type === 'abort') this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'abort') this.listeners.delete(listener);
  }

  abort() {
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
  }
}

test('persistent failures retain bounded, distinguishable diagnostics without private child data', async (t) => {
  const { runtimeDiagnosticFor } = require('../../electron/services/runtime-diagnostic.cjs');
  const cases = [
    ['cold timeout', { responseFor: () => null }, false, 'reparse-startup', 'timeout', 1],
    ['warm timeout', { responseFor: request => request.id === 1 ? { id: 1, version: 1, isReparsePoint: false } : null }, true, 'reparse-request', 'timeout', 1],
    ['native io', { exitFor: () => ({ code: 66 }) }, false, 'reparse-native', 'io', 2],
    ['native invalid', { exitFor: () => ({ code: 67 }) }, false, 'reparse-native', 'invalid-input', 1],
    ['native open io', { exitFor: () => ({ code: 68 }) }, false, 'reparse-native-open', 'io', 2],
    ['native identity io', { exitFor: () => ({ code: 69 }) }, false, 'reparse-native-identity', 'io', 2],
    ['native finalpath io', { exitFor: () => ({ code: 70 }) }, false, 'reparse-native-finalpath', 'io', 2],
    ['native tag invalid', { exitFor: () => ({ code: 71 }) }, false, 'reparse-native-tag', 'invalid-input', 1],
    ['native path redirected', { exitFor: () => ({ code: 72 }) }, false, 'reparse-native-path', 'invalid-input', 1],
    ['native identity changed', { exitFor: () => ({ code: 73 }) }, false, 'reparse-native-identity', 'identity-changed', 1],
    ['unexpected exit', { exitFor: () => ({ code: 999 }) }, false, 'reparse-exit', 'dependency', 1],
    ['malformed protocol', { responseFor: () => 'private-secret C:\\private\\secret.jar' }, false, 'reparse-protocol', 'protocol', 1]
  ];
  for (const [name, behavior, warm, stage, reason, attempts] of cases) await t.test(name, async () => {
    const harness = persistentSpawnHarness(behavior);
    const inspector = new WindowsReparseInspector({ platform: 'win32', spawnProcess: harness.spawnProcess,
      persistent: true, timeoutMs: 10, startupTimeoutMs: 10 });
    t.after(() => inspector.close());
    if (warm) assert.equal(await inspector.isReparsePoint('C:\\private\\warm.jar'), false);
    await assert.rejects(inspector.isReparsePoint('C:\\private\\secret.jar'), error => {
      assert.equal(error.code, 'REPARSE_INSPECTION_FAILED');
      assert.deepEqual(runtimeDiagnosticFor(error, 'finalizer-fresh-record'), { stage, reason });
      assert.doesNotMatch(JSON.stringify(error), /private|secret|999/);
      return true;
    });
    assert.equal(harness.calls.length, attempts);
  });
});

test('persistent spawn and pipe errors expose only their fixed diagnostic categories', async (t) => {
  for (const mode of ['spawn', 'pipe']) await t.test(mode, async () => {
    const harness = persistentSpawnHarness({ responseFor: () => null });
    const inspector = new WindowsReparseInspector({ platform: 'win32', persistent: true,
      spawnProcess(...args) {
        if (mode === 'spawn') throw new Error('private-secret');
        const child = harness.spawnProcess(...args);
        setImmediate(() => child.stdin.emit('error', new Error('private-secret')));
        return child;
      } });
    await assert.rejects(inspector.isReparsePoint('C:\\private\\secret.jar'), error => {
      assert.deepEqual(error.runtimeDiagnostic, { stage: `reparse-${mode}`, reason: 'io' });
      assert.doesNotMatch(JSON.stringify(error), /private|secret/);
      return true;
    });
    inspector.close();
  });
});

test('inspector sends the absolute path only as bounded UTF-8 JSON stdin to pinned PowerShell', async () => {
  const harness = spawnHarness({ stdout: '{"version":1,"isReparsePoint":true}' });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess
  });
  const selectedPath = 'C:\\private\\雪\\pack.zip';
  assert.equal(await inspector.isReparsePoint(selectedPath), true);
  assert.equal(harness.calls.length, 1);
  const call = harness.calls[0];
  assert.equal(path.win32.isAbsolute(call.executable), true);
  assert.equal(path.win32.basename(call.executable).toLocaleLowerCase('en-US'), 'powershell.exe');
  assert.equal(JSON.stringify([call.executable, call.args, call.options]).includes(selectedPath), false);
  assert.equal(call.args.includes('-NoProfile'), true);
  assert.equal(call.args.includes('-NonInteractive'), true);
  assert.equal(call.args.includes('-EncodedCommand'), true);
  assert.deepEqual(call.options, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  assert.deepEqual(JSON.parse(Buffer.concat(call.input).toString('utf8')), { path: selectedPath });
});

test('persistent inspector compiles one pinned probe and reuses it for sequential file checks', async () => {
  const harness = persistentSpawnHarness({
    isReparsePoint: selectedPath => selectedPath.endsWith('junction')
  });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess,
    persistent: true
  });

  assert.equal(await inspector.isReparsePoint('C:\\private\\regular-one.jar'), false);
  assert.equal(await inspector.isReparsePoint('C:\\private\\regular-two.jar'), false);
  assert.equal(await inspector.isReparsePoint('C:\\private\\junction'), true);

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.requests.map(request => request.path), [
    'C:\\private\\regular-one.jar',
    'C:\\private\\regular-two.jar',
    'C:\\private\\junction'
  ]);
  assert.equal(new Set(harness.requests.map(request => request.id)).size, 3);
  inspector.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.calls[0].child.closed, true);
});

test('persistent inspector gives a cold PowerShell compile a separate bounded startup budget', async () => {
  const harness = persistentSpawnHarness({ responseDelayMsFor: request => request.id === 1 ? 25 : 0 });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess,
    persistent: true,
    timeoutMs: 5,
    startupTimeoutMs: 50,
    idleTimeoutMs: 1_000
  });

  assert.equal(await inspector.isReparsePoint('C:\\private\\cold-start.jar'), false);
  assert.equal(await inspector.isReparsePoint('C:\\private\\warm-check.jar'), false);
  assert.equal(harness.calls.length, 1);
  inspector.close();
});

test('persistent inspector retries the exact read-only request once after an unexpected worker exit', async () => {
  const selectedPath = 'C:\\private\\intermittently-locked.jar';
  const harness = persistentSpawnHarness({
    exitFor(_request, spawnCount) {
      return spawnCount === 1 ? { code: 66 } : null;
    }
  });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess,
    persistent: true
  });

  assert.equal(await inspector.isReparsePoint(selectedPath), false);
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.requests.map(request => request.path), [selectedPath, selectedPath]);
  inspector.close();
});

test('persistent inspector remains fail closed when the replacement worker also exits', async () => {
  const selectedPath = 'C:\\private\\consistently-uninspectable.jar';
  const harness = persistentSpawnHarness({ exitFor: () => ({ code: 66 }) });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess,
    persistent: true
  });

  await assert.rejects(
    inspector.isReparsePoint(selectedPath),
    error => error.code === 'REPARSE_INSPECTION_FAILED' && !String(error.message).includes(selectedPath)
  );
  assert.equal(harness.calls.length, 2);
  assert.deepEqual(harness.requests.map(request => request.path), [selectedPath, selectedPath]);
  inspector.close();
});

test('persistent inspector never retries an unsafe native validation result', async () => {
  const selectedPath = 'C:\\private\\redirected.jar';
  const harness = persistentSpawnHarness({ exitFor: () => ({ code: 67 }) });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess,
    persistent: true
  });

  await assert.rejects(
    inspector.isReparsePoint(selectedPath),
    error => error.code === 'REPARSE_INSPECTION_FAILED' && !String(error.message).includes(selectedPath)
  );
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.requests.map(request => request.path), [selectedPath]);
  inspector.close();
});

test('persistent inspector recovers once during a pack-sized sequence without skipping a path', async () => {
  const harness = persistentSpawnHarness({
    exitFor(request) {
      return request.id === 4097 ? { code: 66 } : null;
    }
  });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess,
    persistent: true
  });

  for (let index = 0; index < 5000; index += 1) {
    assert.equal(await inspector.isReparsePoint(`C:\\private\\pack\\file-${index}.jar`), false);
  }
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.requests.length, 5001);
  assert.equal(harness.requests[4096].path, 'C:\\private\\pack\\file-4096.jar');
  assert.equal(harness.requests[4097].path, 'C:\\private\\pack\\file-4096.jar');
  inspector.close();
});

test('persistent inspector fails closed on a mismatched response and restarts for a later request', async () => {
  const harness = persistentSpawnHarness({
    responseFor(request) {
      return {
        id: request.id === 1 ? request.id + 10 : request.id,
        version: 1,
        isReparsePoint: false
      };
    }
  });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess,
    persistent: true
  });

  await assert.rejects(
    inspector.isReparsePoint('C:\\private\\first.jar'),
    error => error.code === 'REPARSE_INSPECTION_FAILED'
  );
  assert.equal(await inspector.isReparsePoint('C:\\private\\second.jar'), false);
  assert.equal(harness.calls.length, 2);
  inspector.close();
});

test('persistent inspector bounds a stalled worker and cleans cancellation listeners', async (t) => {
  await t.test('timeout', async () => {
    const harness = persistentSpawnHarness({ responseFor: () => null });
    const inspector = new WindowsReparseInspector({
      platform: 'win32',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      spawnProcess: harness.spawnProcess,
      persistent: true,
      timeoutMs: 10,
      startupTimeoutMs: 10
    });
    await assert.rejects(
      inspector.isReparsePoint('C:\\private\\stalled.jar'),
      error => error.code === 'REPARSE_INSPECTION_FAILED'
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.calls[0].child.closed, true);
  });

  await t.test('cancellation', async () => {
    const harness = persistentSpawnHarness({ responseFor: () => null });
    const signal = new TrackingSignal();
    const inspector = new WindowsReparseInspector({
      platform: 'win32',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      spawnProcess: harness.spawnProcess,
      persistent: true
    });
    const pending = inspector.isReparsePoint('C:\\private\\cancelled.jar', { signal });
    await new Promise(resolve => setImmediate(resolve));
    signal.abort();
    await assert.rejects(pending, error => error.code === 'ABORT_ERR');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.listeners.size, 0);
    assert.equal(harness.calls[0].child.closed, true);
  });
});

test('persistent inspector retains the warm timeout and restarts cold after a stalled request', async () => {
  const harness = persistentSpawnHarness({
    responseFor(request) {
      if (request.id === 2) return null;
      return { id: request.id, version: 1, isReparsePoint: false };
    }
  });
  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: harness.spawnProcess,
    persistent: true,
    timeoutMs: 10,
    startupTimeoutMs: 50,
    idleTimeoutMs: 1_000
  });

  assert.equal(await inspector.isReparsePoint('C:\\private\\first.jar'), false);
  await assert.rejects(
    inspector.isReparsePoint('C:\\private\\stalled-warm.jar'),
    error => error.code === 'REPARSE_INSPECTION_FAILED'
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.calls[0].child.closed, true);
  assert.equal(await inspector.isReparsePoint('C:\\private\\restarted.jar'), false);
  assert.equal(harness.calls.length, 2);
  inspector.close();
});

test('inspector requires absolute closed inputs and one exact fatal-UTF8 JSON response', async () => {
  const invalidOutputs = [
    '{"version":1,"isReparsePoint":false,"path":"C:\\\\private\\\\leak.zip"}',
    '{"version":1,"isReparsePoint":false}{"version":1,"isReparsePoint":false}',
    Buffer.from([0xc3, 0x28])
  ];
  for (const stdout of invalidOutputs) {
    const harness = spawnHarness({ stdout });
    const inspector = new WindowsReparseInspector({
      platform: 'win32',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      spawnProcess: harness.spawnProcess
    });
    await assert.rejects(inspector.isReparsePoint('C:\\private\\secret.zip'), error =>
      error.code === 'REPARSE_INSPECTION_FAILED' && !String(error.message).includes('secret.zip'));
  }

  const inspector = new WindowsReparseInspector({
    platform: 'win32',
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    spawnProcess: spawnHarness().spawnProcess
  });
  await assert.rejects(inspector.isReparsePoint('relative.zip'), error => error.code === 'REPARSE_INSPECTION_FAILED');
  await assert.rejects(inspector.isReparsePoint('\\root-relative.zip'), error => error.code === 'REPARSE_INSPECTION_FAILED');
  await assert.rejects(inspector.isReparsePoint('C:\\valid.zip', { extra: true }), error => error.code === 'REPARSE_INSPECTION_FAILED');
});

test('inspector kills and waits for close on output cap, timeout, and cancellation', async (t) => {
  await t.test('output cap', async () => {
    const harness = spawnHarness({ stdout: Buffer.alloc(257, 0x41) });
    const inspector = new WindowsReparseInspector({
      platform: 'win32',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      spawnProcess: harness.spawnProcess
    });
    await assert.rejects(inspector.isReparsePoint('C:\\private\\pack.zip'), error => error.code === 'REPARSE_INSPECTION_FAILED');
    assert.equal(harness.calls[0].child.killed, true);
    assert.equal(harness.calls[0].child.closed, true);
  });

  await t.test('timeout', async () => {
    const harness = spawnHarness({ waitForKill: true });
    const inspector = new WindowsReparseInspector({
      platform: 'win32',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      spawnProcess: harness.spawnProcess,
      timeoutMs: 10
    });
    await assert.rejects(inspector.isReparsePoint('C:\\private\\pack.zip'), error => error.code === 'REPARSE_INSPECTION_FAILED');
    assert.equal(harness.calls[0].child.killed, true);
    assert.equal(harness.calls[0].child.closed, true);
  });

  await t.test('cancellation and listener cleanup', async () => {
    const harness = spawnHarness({ waitForKill: true });
    const signal = new TrackingSignal();
    const inspector = new WindowsReparseInspector({
      platform: 'win32',
      powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      spawnProcess: harness.spawnProcess
    });
    const pending = inspector.isReparsePoint('C:\\private\\pack.zip', { signal });
    signal.abort();
    await assert.rejects(pending, error => error.code === 'ABORT_ERR');
    assert.equal(signal.listeners.size, 0);
    assert.equal(harness.calls[0].child.killed, true);
    assert.equal(harness.calls[0].child.closed, true);
  });
});

test('default inspector fails closed off Windows', async () => {
  const inspector = new WindowsReparseInspector({ platform: 'linux' });
  await assert.rejects(inspector.isReparsePoint('/tmp/pack.zip'), error => error.code === 'REPARSE_INSPECTION_FAILED');
});

test('production Windows inspector detects a real directory junction and permits a regular file', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-reparse-inspector-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const junction = path.join(root, 'junction');
  const regular = path.join(root, 'regular.zip');
  await fs.mkdir(target);
  await fs.writeFile(regular, Buffer.from('regular'));
  await fs.symlink(target, junction, 'junction');
  const inspector = new WindowsReparseInspector();
  assert.equal(await inspector.isReparsePoint(process.cwd()), false);
  assert.equal(await inspector.isReparsePoint(regular), false);
  assert.equal(await inspector.isReparsePoint(junction), true);
});

test('production Windows inspector permits a regular local file beyond legacy MAX_PATH', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-reparse-long-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const segment = `segment-${'x'.repeat(52)}`;
  let directory = root;
  while (path.join(directory, 'regular.jar').length < 320) directory = path.join(directory, segment);
  await fs.mkdir(directory, { recursive: true });
  const regular = path.join(directory, 'regular.jar');
  await fs.writeFile(regular, Buffer.from('regular'));
  assert.ok(regular.length > 260, 'the regression must exercise a path beyond legacy MAX_PATH');

  const inspector = new WindowsReparseInspector();
  t.after(() => inspector.close());
  assert.equal(await inspector.isReparsePoint(regular), false);
});

test('production Windows probe transports a controlled unavailable-handle category without its path', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-reparse-diagnostic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inspector = new WindowsReparseInspector();
  t.after(() => inspector.close());
  await assert.rejects(inspector.isReparsePoint(path.join(root, 'private-missing-file.jar')), error => {
    assert.equal(error.code, 'REPARSE_INSPECTION_FAILED');
    assert.deepEqual(error.runtimeDiagnostic, { stage: 'reparse-native-open', reason: 'io' });
    assert.doesNotMatch(JSON.stringify(error), /private-missing|mc-reparse-diagnostic/);
    return true;
  });
});

test('production probe classifies only name-surrogate tags as redirecting reparses', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'electron', 'services', 'modpacks', 'local', 'windows-reparse-inspector.cjs'), 'utf8');
  assert.match(source, /FileAttributeTagInfo\s*=\s*9/);
  assert.match(source, /0x20000000/);
  assert.match(source, /GetFileInformationByHandle/);
  assert.match(source, /GetFinalPathNameByHandle/);
  assert.match(source, /afterTag\.FileAttributes\s*&\s*FileAttributeReparsePoint/);
  assert.doesNotMatch(source, /beforeTag\.FileAttributes\s*!=\s*afterTag\.FileAttributes/);
  assert.doesNotMatch(source, /FileAttributes\.ReparsePoint\)\s*!=\s*0\s*\}\s*$/m);
});

test('production native identity structure matches the Windows ABI and decodes identity sentinels', { skip: process.platform !== 'win32' }, async () => {
  const harness = spawnHarness();
  const inspector = new WindowsReparseInspector({ platform: 'win32', spawnProcess: harness.spawnProcess });
  await inspector.isReparsePoint('C:\\temporary-layout-fixture');
  const args = harness.calls[0].args;
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  // Compile the actual source sent by the production inspector, not a test-side structure.
  const source = script.match(/\$probeSource = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  const layoutScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = @'
${source}
'@
Add-Type -TypeDefinition $source -Language CSharp
$type = [MinecraftCoreReparseProbe].GetNestedType('ByHandleFileInformation', [Reflection.BindingFlags]::NonPublic)
$offsets = [ordered]@{}
foreach ($field in $type.GetFields([Reflection.BindingFlags]'Instance,NonPublic')) {
  $offsets[$field.Name] = [int][Runtime.InteropServices.Marshal]::OffsetOf($type, $field.Name)
}
$bytes = New-Object byte[] 52
[BitConverter]::GetBytes([uint32]305419896).CopyTo($bytes, 28)
[BitConverter]::GetBytes([uint32]591751049).CopyTo($bytes, 44)
[BitConverter]::GetBytes([uint32]878082202).CopyTo($bytes, 48)
$memory = [Runtime.InteropServices.Marshal]::AllocHGlobal(56)
try {
  # Four trailing zero bytes keep the known incorrect 56-byte baseline safe to decode.
  [Runtime.InteropServices.Marshal]::WriteInt32($memory, 52, 0)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $memory, 52)
  $marshal = [Runtime.InteropServices.Marshal]
  $decode = $marshal.GetMethod('PtrToStructure', [type[]]@([IntPtr], [Type]))
  $value = $decode.Invoke($null, [object[]]@($memory, $type))
  $decoded = @{}
  foreach ($name in @('VolumeSerialNumber','FileIndexHigh','FileIndexLow')) {
    $decoded[$name] = $type.GetField($name, [Reflection.BindingFlags]'Instance,NonPublic').GetValue($value)
  }
  $size = $marshal.GetMethod('SizeOf', [type[]]@([Type])).Invoke($null, [object[]]@($type))
  @{ size = $size; offsets = $offsets; decoded = $decoded } | ConvertTo-Json -Compress
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($memory) }
`;
  const output = execFileSync(harness.calls[0].executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(layoutScript, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30_000, encoding: 'utf8' });
  const actual = JSON.parse(output.trim());
  assert.equal(actual.size, 52);
  assert.deepEqual(actual.offsets, { FileAttributes: 0, CreationTime: 4, LastAccessTime: 12, LastWriteTime: 20,
    VolumeSerialNumber: 28, FileSizeHigh: 32, FileSizeLow: 36, NumberOfLinks: 40, FileIndexHigh: 44, FileIndexLow: 48 });
  assert.deepEqual(actual.decoded, { VolumeSerialNumber: 305419896, FileIndexHigh: 591751049, FileIndexLow: 878082202 });
});
