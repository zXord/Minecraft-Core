const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { encodeFrame } = require('../electron/services/modpacks/archive/archive-worker-client.cjs');
const { WindowsDurableFsClient } = require('../electron/utils/windows-durable-fs-client.cjs');

function rootFixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function identityExpectation(candidate, fileType, overrides = {}) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs),
    mtime: String(stat.mtimeNs ?? stat.mtimeMs),
    ctime: String(stat.ctimeNs ?? stat.ctimeMs),
    ...(fileType === 'file'
      ? { sha256: crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex') }
      : {}),
    ...overrides
  };
}

function fixtureWorkerClient(root, overrides = {}) {
  const fixture = path.join(__dirname, 'fixtures', 'slow-durable-fs-worker.cjs');
  return new WindowsDurableFsClient({
    workerPath: fixture,
    workerManifestPath: fixture,
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn(_file, _args, options) { return childProcess.spawn(process.execPath, [fixture], options); },
    ...overrides
  });
}

test('async durable flush keeps parent timers responsive while a real child is synchronously busy', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-live-');
  const fixture = path.join(__dirname, 'fixtures', 'slow-durable-fs-worker.cjs');
  const client = new WindowsDurableFsClient({
    workerPath: fixture,
    workerManifestPath: fixture,
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn(file, args, options) {
      assert.equal(file, path.resolve(fixture));
      assert.deepEqual(args, ['--durable-fs']);
      return childProcess.spawn(process.execPath, [fixture], options);
    }
  });

  let settled = false;
  const pending = client.flushDirectoryAsync(root).finally(() => { settled = true; });
  try {
    const winner = await Promise.race([
      pending.then(() => 'flush'),
      new Promise(resolve => setTimeout(() => resolve('timer'), 40))
    ]);
    assert.equal(winner, 'timer', 'parent timer must fire before the synchronously busy child finishes');
    assert.equal(settled, false);
  } finally {
    // Never let a failed liveness assertion outlive its fixture and turn into
    // teardown-only unhandled rejection noise.
    await pending;
  }
});

test('async durable directory batch keeps parent timers responsive while a real child is synchronously busy', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-batch-live-');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const fixture = path.join(__dirname, 'fixtures', 'slow-durable-fs-worker.cjs');
  const client = new WindowsDurableFsClient({
    workerPath: fixture,
    workerManifestPath: fixture,
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn(file, args, options) {
      assert.equal(file, path.resolve(fixture));
      assert.deepEqual(args, ['--durable-fs']);
      return childProcess.spawn(process.execPath, [fixture], options);
    }
  });

  let settled = false;
  const pending = client.flushDirectoriesAsync([first, second]).finally(() => { settled = true; });
  try {
    const winner = await Promise.race([
      pending.then(() => 'flush'),
      new Promise(resolve => setTimeout(() => resolve('timer'), 40))
    ]);
    assert.equal(winner, 'timer', 'parent timer must fire before the synchronously busy child finishes');
    assert.equal(settled, false);
  } finally {
    await pending;
  }
});

test('repeated async durable flushes use the worker file as their blocker and create no runtime bundles', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-no-extraction-');
  const fixture = path.join(__dirname, 'fixtures', 'slow-durable-fs-worker.cjs');
  const blockers = [];
  const client = fixtureWorkerClient(root, {
    spawn(file, _args, options) {
      blockers.push(options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR);
      return childProcess.spawn(process.execPath, [file], options);
    }
  });

  await client.flushDirectoryAsync(root);
  await client.flushDirectoryAsync(root);

  assert.deepEqual(blockers.map(value => value.replace(/^\\\\\?\\/u, '')), [path.resolve(fixture), path.resolve(fixture)]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'broker', 'broker-bundles')), []);
});

test('a hostile legacy broker remnant is untouched and cannot block extraction-free durable work', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-legacy-remnant-');
  const remnant = path.join(root, 'broker', 'broker-bundles', 'bundle-hostile', 'payload.bin');
  fs.mkdirSync(path.dirname(remnant), { recursive: true });
  fs.writeFileSync(remnant, 'preserve');
  const client = fixtureWorkerClient(root);

  await client.flushDirectoryAsync(root);

  assert.equal(fs.readFileSync(remnant, 'utf8'), 'preserve');
  assert.deepEqual(fs.readdirSync(path.join(root, 'broker', 'broker-bundles')), ['bundle-hostile']);
});

test('async durable move keeps parent timers responsive and publishes the exact source', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-move-live-');
  const source = path.join(root, 'active.json');
  const destination = path.join(root, 'history.json');
  fs.writeFileSync(source, '{"phase":"completed"}\n');
  const fixture = path.join(__dirname, 'fixtures', 'slow-durable-fs-worker.cjs');
  const client = new WindowsDurableFsClient({
    workerPath: fixture,
    workerManifestPath: fixture,
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn(file, args, options) {
      assert.equal(file, path.resolve(fixture));
      assert.deepEqual(args, ['--durable-fs']);
      return childProcess.spawn(process.execPath, [fixture], options);
    }
  });

  let settled = false;
  const pending = client.moveWriteThroughAsync(source, destination).finally(() => { settled = true; });
  try {
    const winner = await Promise.race([
      pending.then(() => 'move'),
      new Promise(resolve => setTimeout(() => resolve('timer'), 40))
    ]);
    assert.equal(winner, 'timer', 'parent timer must fire before the synchronously busy child finishes');
    assert.equal(settled, false);
  } finally {
    await pending;
  }
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), '{"phase":"completed"}\n');
});

test('async durable move preserves a directory and its contents', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-directory-move-');
  const source = path.join(root, 'candidate');
  const destination = path.join(root, 'published');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'server.jar'), 'server');
  const fixture = path.join(__dirname, 'fixtures', 'slow-durable-fs-worker.cjs');
  const client = new WindowsDurableFsClient({
    workerPath: fixture,
    workerManifestPath: fixture,
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn(_file, _args, options) { return childProcess.spawn(process.execPath, [fixture], options); }
  });

  await client.moveWriteThroughAsync(source, destination);

  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(destination, 'server.jar'), 'utf8'), 'server');
});

test('async durable replacement keeps parent timers responsive and publishes exact bytes', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-replace-live-');
  const source = path.join(root, 'next.json');
  const destination = path.join(root, 'current.json');
  fs.writeFileSync(source, '{"sequence":2}\n');
  fs.writeFileSync(destination, '{"sequence":1}\n');
  const fixture = path.join(__dirname, 'fixtures', 'slow-durable-fs-worker.cjs');
  const client = new WindowsDurableFsClient({
    workerPath: fixture,
    workerManifestPath: fixture,
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn(_file, _args, options) { return childProcess.spawn(process.execPath, [fixture], options); }
  });

  let settled = false;
  const pending = client.replaceFileWriteThroughAsync(source, destination).finally(() => { settled = true; });
  try {
    const winner = await Promise.race([
      pending.then(() => 'replace'),
      new Promise(resolve => setTimeout(() => resolve('timer'), 40))
    ]);
    assert.equal(winner, 'timer');
    assert.equal(settled, false);
  } finally {
    await pending;
  }
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), '{"sequence":2}\n');
});

test('async durable move accepts caller identity whose only drift is file ctime', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-ctime-');
  const source = path.join(root, 'source.bin');
  const destination = path.join(root, 'destination.bin');
  fs.writeFileSync(source, 'stable bytes');
  const sourceIdentity = identityExpectation(source, 'file');
  sourceIdentity.ctime = String(BigInt(sourceIdentity.ctime) + 1n);

  await fixtureWorkerClient(root).moveWriteThroughAsync(source, destination, {
    sourceIdentity,
    destinationParentIdentity: identityExpectation(root, 'directory')
  });

  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'stable bytes');
});

test('async durable move keeps file identity and digest controls load-bearing', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-controls-');
  const source = path.join(root, 'source.bin');
  fs.writeFileSync(source, 'stable bytes');
  const actual = identityExpectation(source, 'file');
  let spawnCalls = 0;
  const client = fixtureWorkerClient(root, {
    spawn() {
      spawnCalls += 1;
      throw new Error('invalid identity reached the worker');
    }
  });
  const controls = [
    ['file ID', { ino: String(BigInt(actual.ino) + 1n) }],
    ['size', { size: String(BigInt(actual.size) + 1n) }],
    ['mtime', { mtime: String(BigInt(actual.mtime) + 1n) }],
    ['SHA-256', { sha256: `${actual.sha256.slice(0, -1)}${actual.sha256.endsWith('0') ? '1' : '0'}` }]
  ];

  for (const [name, changed] of controls) {
    await assert.rejects(
      client.moveWriteThroughAsync(source, path.join(root, `${name.replaceAll(/[^A-Za-z0-9]/g, '-')}.bin`), {
        sourceIdentity: { ...actual, ...changed },
        destinationParentIdentity: identityExpectation(root, 'directory')
      }),
      error => error.code === 'COMMIT_FAILED',
      name
    );
  }

  assert.equal(spawnCalls, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), 'stable bytes');
});

test('async durable move rejects a same-size content substitution even when metadata expectations match', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-content-control-');
  const source = path.join(root, 'source.bin');
  const destination = path.join(root, 'destination.bin');
  fs.writeFileSync(source, 'safe');
  const originalSha256 = identityExpectation(source, 'file').sha256;
  fs.writeFileSync(source, 'evil');
  const staleIdentity = identityExpectation(source, 'file', { sha256: originalSha256 });
  let spawnCalls = 0;
  const client = fixtureWorkerClient(root, {
    spawn() {
      spawnCalls += 1;
      throw new Error('substituted content reached the worker');
    }
  });

  await assert.rejects(
    client.moveWriteThroughAsync(source, destination, {
      sourceIdentity: staleIdentity,
      destinationParentIdentity: identityExpectation(root, 'directory')
    }),
    error => error.code === 'COMMIT_FAILED'
  );

  assert.equal(spawnCalls, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), 'evil');
});

test('async durable move rejects paths outside the owned root and file symlinks', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-path-control-');
  const outside = rootFixture(t, 'minecraft-core-durable-async-outside-');
  const outsideSource = path.join(outside, 'outside.bin');
  fs.writeFileSync(outsideSource, 'outside');
  const client = fixtureWorkerClient(root);

  await assert.rejects(
    client.moveWriteThroughAsync(outsideSource, path.join(root, 'outside.bin')),
    error => error.code === 'COMMIT_FAILED'
  );

  const realSource = path.join(root, 'real.bin');
  const linkedSource = path.join(root, 'linked.bin');
  fs.writeFileSync(realSource, 'linked');
  try {
    fs.symlinkSync(realSource, linkedSource, 'file');
  } catch (error) {
    if (error?.code === 'EPERM') return;
    throw error;
  }
  await assert.rejects(
    client.moveWriteThroughAsync(linkedSource, path.join(root, 'linked-destination.bin')),
    error => error.code === 'COMMIT_FAILED'
  );
});

test('packaged native worker performs asynchronous move and replacement end to end', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-native-');
  const workerPath = path.join(__dirname, '..', 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe');
  const workerManifestPath = path.join(__dirname, '..', 'build-resources', 'archive-runtime', 'archive-worker-x64.json');
  const first = path.join(root, 'first.json');
  const current = path.join(root, 'current.json');
  const replacement = path.join(root, 'replacement.json');
  fs.writeFileSync(first, '{"sequence":1}\n');
  fs.writeFileSync(replacement, '{"sequence":2}\n');
  const client = new WindowsDurableFsClient({
    workerPath,
    workerManifestPath,
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker')
  });

  await client.moveWriteThroughAsync(first, current);
  await client.replaceFileWriteThroughAsync(replacement, current);

  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(replacement), false);
  assert.equal(fs.readFileSync(current, 'utf8'), '{"sequence":2}\n');
});

test('timed-out async durable move retains authority until worker close is confirmed', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-move-close-');
  const source = path.join(root, 'active.json');
  const destination = path.join(root, 'history.json');
  fs.writeFileSync(source, '{}\n');
  const child = new EventEmitter();
  child.pid = 4545;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const client = new WindowsDurableFsClient({
    workerPath: path.join(root, 'worker.exe'),
    workerManifestPath: path.join(root, 'worker.json'),
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    timeoutMs: 10,
    terminationGraceMs: 15,
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn: () => child,
    execFile(_file, _args, _options, callback) { queueMicrotask(() => callback(null, '', '')); }
  });

  let settled = false;
  const pending = client.moveWriteThroughAsync(source, destination)
    .then(() => null, error => error)
    .finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(settled, false, 'a mutating worker without confirmed close must retain authority');
  child.emit('close', null, 'SIGKILL');
  const error = await pending;
  assert.equal(error.code, 'COMMIT_FAILED');
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(destination), false);
});

test('async durable move rejects a malformed child before request bytes can be sent', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-move-prespawn-');
  const source = path.join(root, 'active.json');
  const destination = path.join(root, 'history.json');
  fs.writeFileSync(source, '{}\n');
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = 0;
  child.kill = () => { killed += 1; return true; };
  const client = new WindowsDurableFsClient({
    workerPath: path.join(root, 'worker.exe'),
    workerManifestPath: path.join(root, 'worker.json'),
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    terminationGraceMs: 15,
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn: () => child
  });

  const result = await Promise.race([
    client.moveWriteThroughAsync(source, destination).then(() => 'resolved', error => error),
    new Promise(resolve => setTimeout(() => resolve('timed-out'), 100))
  ]);
  assert.notEqual(result, 'timed-out');
  assert.equal(result.code, 'COMMIT_FAILED');
  assert.equal(child.stdin.readableLength, 0);
  assert.equal(killed, 1);
  assert.equal(fs.existsSync(source), true);
});

test('async durable timeout kills the retained handle and fails closed without accepting late output', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-timeout-');
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const killSignals = [];
  child.kill = signal => {
    killSignals.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  const taskkills = [];
  const client = new WindowsDurableFsClient({
    workerPath: path.join(root, 'worker.exe'),
    workerManifestPath: path.join(root, 'worker.json'),
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    timeoutMs: 10,
    terminationGraceMs: 100,
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn: () => child,
    execFile(file, args, options, callback) {
      taskkills.push({ file, args, options });
      queueMicrotask(() => {
        callback(null, '', '');
        child.emit('close', null, 'SIGKILL');
      });
    }
  });

  await assert.rejects(client.flushDirectoryAsync(root), error =>
    error.code === 'COMMIT_FAILED' && !String(error).includes(root));
  assert.equal(taskkills.length, 0);
  assert.deepEqual(killSignals, ['SIGKILL']);
  child.stdout.end(Buffer.from([1, 0, 0, 0, 0]));
});

test('async durable timeout uses only the retained worker handle and never a reusable numeric pid', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-exact-handle-');
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const killSignals = [];
  child.kill = signal => {
    killSignals.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  let pidTerminationCalls = 0;
  const client = new WindowsDurableFsClient({
    workerPath: path.join(root, 'worker.exe'),
    workerManifestPath: path.join(root, 'worker.json'),
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    timeoutMs: 10,
    terminationGraceMs: 100,
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn: () => child,
    execFile() {
      pidTerminationCalls += 1;
      throw new Error('numeric pid termination must not be used');
    },
    processKill() {
      pidTerminationCalls += 1;
      throw new Error('numeric process-group termination must not be used');
    },
    platform: 'win32'
  });

  await assert.rejects(client.flushDirectoryAsync(root), error => error.code === 'COMMIT_FAILED');
  assert.equal(pidTerminationCalls, 0);
  assert.deepEqual(killSignals, ['SIGKILL']);
});

test('async durable flush preserves only an authenticated closed native failure classification', async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-failure-');
  const child = new EventEmitter();
  child.pid = 4343;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const client = new WindowsDurableFsClient({
    workerPath: path.join(root, 'worker.exe'),
    workerManifestPath: path.join(root, 'worker.json'),
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    verifyWorker: () => {},
    verifyWorkerAsync: async () => {},
    spawn: () => child
  });

  const pending = client.flushDirectoryAsync(root);
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.end(encodeFrame({
    ok: false,
    failureKind: 'sharing-violation',
    failureStage: 'completion-flush'
  }));
  child.stderr.end();
  child.emit('close', 0, null);

  await assert.rejects(pending, error =>
    error.code === 'COMMIT_FAILED' && error.durableFailureKind === 'sharing-violation' &&
      error.durableFailureStage === 'completion-flush');
});
