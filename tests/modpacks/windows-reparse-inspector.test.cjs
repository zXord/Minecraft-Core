const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
  assert.equal(await inspector.isReparsePoint(regular), false);
  assert.equal(await inspector.isReparsePoint(junction), true);
});
