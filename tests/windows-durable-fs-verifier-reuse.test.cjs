const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { encodeFrame } = require('../electron/services/modpacks/archive/archive-worker-client.cjs');
const { WindowsReparseInspector } = require('../electron/services/modpacks/local/windows-reparse-inspector.cjs');
const { WindowsDurableFsClient } = require('../electron/utils/windows-durable-fs-client.cjs');

const windowsOnly = { skip: process.platform !== 'win32' && 'Exercises the real Windows reparse transport' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workerDirectory = path.join(root, 'worker');
  const target = path.join(root, 'target');
  fs.mkdirSync(workerDirectory); fs.mkdirSync(target);
  const workerPath = path.join(workerDirectory, 'ArchiveWorker.exe');
  const workerManifestPath = path.join(workerDirectory, 'archive-worker-x64.json');
  // Inert PE-shaped bytes: verified by production code, never executed.
  const bytes = Buffer.alloc(256, 0x5a);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80); bytes.writeUInt16LE(0x8664, 0x84);
  const manifest = { schemaVersion: 2, architecture: 'x64', runtimeIdentifier: 'win-x64',
    targetFramework: 'net8.0-windows', sdkVersion: '10.0.204', runtimeMode: 'in-memory-single-file',
    files: { 'ArchiveWorker.exe': { size: 256, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } } };
  fs.writeFileSync(workerPath, bytes); fs.writeFileSync(workerManifestPath, JSON.stringify(manifest));
  const requests = [];
  function spawn(file, args, options) {
    assert.equal(file, workerPath); assert.deepEqual(args, ['--durable-fs']);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    const child = new EventEmitter(); child.pid = 12345;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; };
    const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    child.stdin.on('finish', () => {
      const frame = Buffer.concat(chunks);
      assert.equal(frame.readUInt32LE(0), frame.length - 4);
      const request = JSON.parse(frame.subarray(4).toString('utf8'));
      assert.equal(request.operation, 'flush-directory'); assert.equal(request.directoryPath, target);
      requests.push(request);
      setImmediate(() => { child.stdout.end(encodeFrame({ ok: true })); child.emit('close', 0, null); });
    });
    return child;
  }
  const options = { workerPath, workerManifestPath, allowedRoots: [target], appOwnedRoot: path.join(root, 'broker'), spawn };
  return { root, target, workerDirectory, workerPath, workerManifestPath, bytes, manifest, options, requests };
}

function observeRealProbes(t) {
  const seen = [];
  const original = WindowsReparseInspector.prototype.isReparsePoint;
  t.mock.method(WindowsReparseInspector.prototype, 'isReparsePoint', async function (candidate, options) {
    const observation = { inspector: this, candidate }; seen.push(observation);
    const result = await original.call(this, candidate, options);
    observation.child = this.persistentProbe?.worker?.child;
    return result;
  });
  t.after(async () => {
    await Promise.all([...new Set(seen.map(item => item.inspector))].map(inspector => {
      const child = inspector.persistentProbe?.worker?.child;
      if (!child) return;
      const closed = new Promise(resolve => child.once('close', resolve));
      inspector.close(); return closed;
    }));
  });
  return seen;
}

test('default durable verifier reuses one real probe worker while checking both paths on every invocation', windowsOnly, async t => {
  const f = fixture(t); const seen = observeRealProbes(t);
  const client = new WindowsDurableFsClient(f.options);
  await client.flushDirectoryAsync(f.target); await client.flushDirectoryAsync(f.target);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(seen.map(item => item.candidate), [f.workerPath, f.workerManifestPath, f.workerPath, f.workerManifestPath]);
  assert.equal(new Set(seen.map(item => item.inspector)).size, 1, 'repeated verification must not create another cold inspector');
  assert.equal(new Set(seen.map(item => item.child)).size, 1, 'real PowerShell process must be reused');
});

test('default durable verifier transport belongs to its client, not another client', windowsOnly, async t => {
  const f = fixture(t); const seen = observeRealProbes(t);
  const first = new WindowsDurableFsClient(f.options); const second = new WindowsDurableFsClient(f.options);
  await first.flushDirectoryAsync(f.target); await second.flushDirectoryAsync(f.target); await first.flushDirectoryAsync(f.target);
  assert.equal(f.requests.length, 3);
  assert.ok(seen[0].inspector !== seen[2].inspector, 'different clients must not share a verifier transport');
  assert.ok(seen[0].inspector === seen[4].inspector, 'returning to one client must reuse its own verifier transport');
});

for (const change of ['same-size worker bytes', 'manifest digest', 'PE header with matching digest']) {
  test(`reused durable verifier refuses fresh ${change} tampering before helper dispatch`, windowsOnly, async t => {
    const f = fixture(t); const seen = observeRealProbes(t); const client = new WindowsDurableFsClient(f.options);
    await client.flushDirectoryAsync(f.target);
    if (change === 'manifest digest') f.manifest.files['ArchiveWorker.exe'].sha256 = '0'.repeat(64);
    else {
      f.bytes[change === 'same-size worker bytes' ? 200 : 0] ^= 1;
      fs.writeFileSync(f.workerPath, f.bytes);
      if (change === 'PE header with matching digest') f.manifest.files['ArchiveWorker.exe'].sha256 = crypto.createHash('sha256').update(f.bytes).digest('hex');
    }
    fs.writeFileSync(f.workerManifestPath, JSON.stringify(f.manifest));
    await assert.rejects(client.flushDirectoryAsync(f.target), { code: 'COMMIT_FAILED' });
    assert.equal(f.requests.length, 1, 'tampered worker must never reach the native helper');
    assert.deepEqual(seen.map(item => item.candidate), [f.workerPath, f.workerManifestPath, f.workerPath, f.workerManifestPath]);
  });
}

test('reused durable verifier refuses a worker-directory junction introduced after successful verification', windowsOnly, async t => {
  const f = fixture(t); observeRealProbes(t); const client = new WindowsDurableFsClient(f.options);
  await client.flushDirectoryAsync(f.target);
  const moved = path.join(f.root, 'moved-worker');
  fs.renameSync(f.workerDirectory, moved); fs.symlinkSync(moved, f.workerDirectory, 'junction');
  await assert.rejects(client.flushDirectoryAsync(f.target), { code: 'COMMIT_FAILED' });
  assert.equal(f.requests.length, 1, 'unchanged bytes behind a new junction must not reuse prior authority');
});

test('idle default verifier helper closes and a later verification starts fresh on the same transport', windowsOnly, async t => {
  const f = fixture(t); const seen = observeRealProbes(t); const client = new WindowsDurableFsClient(f.options);
  await client.flushDirectoryAsync(f.target);
  const first = seen[0];
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('idle verifier worker did not close')), 12000);
    first.child.once('close', () => { clearTimeout(deadline); resolve(); });
  });
  await client.flushDirectoryAsync(f.target);
  assert.equal(f.requests.length, 2);
  assert.ok(seen[2].inspector === first.inspector, 'idle expiry must not discard the per-client transport');
  assert.ok(seen[2].child !== first.child, 'closed idle worker must never be reused');
});

test('custom async and sync verifier interfaces do not acquire the default reparse transport', async t => {
  const f = fixture(t);
  t.mock.method(WindowsReparseInspector.prototype, 'isReparsePoint', () => assert.fail('custom verifier must remain in control'));
  for (const mode of ['async', 'sync']) {
    const calls = [];
    const verifier = options => { calls.push(options); if (calls.length === 2) throw new Error('refuse next request'); };
    const client = new WindowsDurableFsClient({ ...f.options,
      ...(mode === 'async' ? { verifyWorkerAsync: verifier } : { verifyWorker: verifier }) });
    await client.flushDirectoryAsync(f.target);
    await assert.rejects(client.flushDirectoryAsync(f.target), { code: 'COMMIT_FAILED' });
    assert.deepEqual(calls, [
      { workerPath: f.workerPath, workerManifestPath: f.workerManifestPath },
      { workerPath: f.workerPath, workerManifestPath: f.workerManifestPath }
    ]);
  }
  assert.equal(f.requests.length, 2);
});
