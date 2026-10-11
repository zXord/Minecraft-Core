const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { MAX_FRAME_BYTES, encodeFrame } = require('../electron/services/modpacks/archive/archive-worker-client.cjs');
const { WindowsDurableFsClient } = require('../electron/utils/windows-durable-fs-client.cjs');

function rootFixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved).toLocaleLowerCase('en-US'), path.resolve(os.tmpdir()).toLocaleLowerCase('en-US'));
    assert.ok(path.basename(resolved).startsWith(label));
    assert.equal(fs.lstatSync(resolved).isSymbolicLink(), false);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
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

// Native child behavior and executable verifier callbacks are injected. Path
// ownership, filesystem identities, request framing, verification dispatch and
// close handling exercise the production client.
function flushFrameBoundary(onRequest = (_request, child) => completeFlushChild(child)) {
  const requests = [];
  const frames = [];
  const children = [];
  const killSignals = [];
  const received = new EventEmitter();
  function spawn() {
    const child = new EventEmitter();
    child.pid = 7000 + children.length;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = signal => { killSignals.push(signal); return true; };
    children.push(child);
    const chunks = [];
    child.stdin.on('data', chunk => chunks.push(chunk));
    child.stdin.on('finish', () => {
      const frame = Buffer.concat(chunks);
      const request = JSON.parse(frame.subarray(4).toString('utf8'));
      frames.push(frame);
      requests.push(request);
      received.emit('request');
      setImmediate(() => onRequest(request, child, requests.length));
    });
    return child;
  }
  async function waitForRequests(count) {
    while (requests.length < count) await new Promise(resolve => received.once('request', resolve));
  }
  return { spawn, requests, frames, children, killSignals, waitForRequests };
}

function completeFlushChild(child, response = { ok: true }) {
  child.stdout.end(encodeFrame(response));
  child.stderr.end();
  child.emit('close', 0, null);
}

function exactDeleteOptions(root, leaf) {
  return { expectedFileIdentity: { fileType: 'file', ...identityExpectation(leaf, 'file') },
    expectedParentIdentity: { fileType: 'directory', ...identityExpectation(path.dirname(leaf), 'directory') },
    expectedAllowedRootIdentities: [{ path: root, identity: { fileType: 'directory', ...identityExpectation(root, 'directory') } }],
    expectedAncestorIdentities: [], mode: 'delete' };
}

test('exact delete requires original identities and strict capability', async t => {
  const root = rootFixture(t, `exact-delete-${crypto.randomUUID()}-`);
  const leaf = path.join(root, 'authorized'); fs.writeFileSync(leaf, 'original');
  const boundary = flushFrameBoundary(); const client = fixtureWorkerClient(root, { spawn: boundary.spawn });
  const options = exactDeleteOptions(root, leaf);
  assert.equal(client.capabilities.deleteFileExactFlushesParent, true);
  for (const key of Object.keys(options)) {
    const invalid = { ...options }; delete invalid[key];
    await assert.rejects(client.deleteFileExactAsync(leaf, invalid), { code: 'COMMIT_FAILED' });
  }
  const noHash = structuredClone(options); delete noHash.expectedFileIdentity.sha256;
  await assert.rejects(client.deleteFileExactAsync(leaf, noHash), { code: 'COMMIT_FAILED' });
  assert.equal(boundary.requests.length, 0); assert.equal(fs.readFileSync(leaf, 'utf8'), 'original');
});

test('delete response waits for confirmed worker close', async t => {
  for (const timeout of [false, true]) {
    const root = rootFixture(t, `exact-delete-${crypto.randomUUID()}-`);
    const leaf = path.join(root, 'authorized'); fs.writeFileSync(leaf, 'original');
    const boundary = flushFrameBoundary((_request, child) => {
      if (!timeout) child.stdout.write(encodeFrame({ ok: true, deletion: 'durable' }));
    });
    const client = fixtureWorkerClient(root, { spawn: boundary.spawn, timeoutMs: timeout ? 10 : 1000, terminationGraceMs: 10 });
    let mutationStarted = false;
    const pending = client.deleteFileExactAsync(leaf, exactDeleteOptions(root, leaf))
      .catch(error => error).finally(() => { mutationStarted = true; });
    await boundary.waitForRequests(1); await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(mutationStarted, false);
    boundary.children[0].emit('close', timeout ? null : 0, timeout ? 'SIGKILL' : null);
    const result = await pending;
    if (timeout) assert.equal(result.durableEffectState, 'uncertain');
    else assert.deepEqual(result, { deleted: true, durable: true });
    assert.deepEqual(Object.keys(boundary.requests[0]).sort(), ['operation', 'sourcePath', 'sourceIdentity', 'sourceParentIdentity', 'allowedRoots', 'allowedRootIdentities', 'ancestorIdentities', 'mode'].sort());
  }
});

test('post-effect delete failures never retry', async t => {
  const root = rootFixture(t, `exact-delete-${crypto.randomUUID()}-`);
  const leaf = path.join(root, 'authorized'); fs.writeFileSync(leaf, 'original');
  for (const stage of ['handle-disposition', 'delete-close', 'delete-parent-flush']) {
    const boundary = flushFrameBoundary((_request, child) => completeFlushChild(child,
      { ok: false, failureKind: 'sharing-violation', failureStage: stage, effectState: 'uncertain' }));
    await assert.rejects(fixtureWorkerClient(root, { spawn: boundary.spawn }).deleteFileExactAsync(leaf, exactDeleteOptions(root, leaf)),
      { durableFailureStage: stage, durableEffectState: 'uncertain' });
    assert.equal(boundary.requests.length, 1);
  }
  for (const response of [{ ok: true }, { ok: true, deletion: 'durable', extra: true },
    { ok: false, failureKind: 'io-failure', failureStage: 'delete-close' },
    { ok: false, failureKind: 'io-failure', failureStage: 'delete-close', effectState: 'none' }]) {
    const boundary = flushFrameBoundary((_request, child) => completeFlushChild(child, response));
    await assert.rejects(fixtureWorkerClient(root, { spawn: boundary.spawn }).deleteFileExactAsync(leaf, exactDeleteOptions(root, leaf)), { code: 'COMMIT_FAILED' });
  }
  const boundary = flushFrameBoundary();
  await assert.rejects(fixtureWorkerClient(root, { spawn: boundary.spawn }).deleteFileExactAsync(leaf,
    { ...exactDeleteOptions(root, leaf), mode: 'reconcile-absent' }), { code: 'COMMIT_FAILED' });
  assert.equal(boundary.requests.length, 0); assert.equal(fs.readFileSync(leaf, 'utf8'), 'original');
});

test('exact delete authenticates every ancestor across nested configured roots and snapshots authority', async t => {
  const root = rootFixture(t, `exact-delete-${crypto.randomUUID()}-`);
  const first = path.join(root, 'first'); const nested = path.join(first, 'nested'); const parent = path.join(nested, 'parent');
  fs.mkdirSync(parent, { recursive: true }); const leaf = path.join(parent, 'leaf'); fs.writeFileSync(leaf, 'original');
  const boundary = flushFrameBoundary((_request, child) => completeFlushChild(child, { ok: true, deletion: 'durable' }));
  const options = exactDeleteOptions(root, leaf);
  const entry = candidate => ({ path: candidate, identity: { fileType: 'directory', ...identityExpectation(candidate, 'directory') } });
  options.expectedAllowedRootIdentities.push(entry(nested));
  options.expectedAncestorIdentities = [entry(first), entry(nested)];
  const client = fixtureWorkerClient(root, { allowedRoots: [root, nested], spawn: boundary.spawn });
  for (const ancestors of [[], [entry(first)], [entry(nested)], [entry(nested), entry(first)], [...options.expectedAncestorIdentities, entry(first)]]) {
    await assert.rejects(client.deleteFileExactAsync(leaf, { ...options, expectedAncestorIdentities: ancestors }), { code: 'COMMIT_FAILED' });
  }
  assert.equal(boundary.requests.length, 0);
  assert.deepEqual(await client.deleteFileExactAsync(leaf, options), { deleted: true, durable: true });
  assert.deepEqual(boundary.requests[0].ancestorIdentities, options.expectedAncestorIdentities);
  let resume;
  const pendingVerification = new Promise(resolve => { resume = resolve; });
  const delayed = fixtureWorkerClient(root, { allowedRoots: [root, nested], spawn: boundary.spawn, verifyWorkerAsync: () => pendingVerification });
  const pending = delayed.deleteFileExactAsync(leaf, options);
  options.expectedFileIdentity.sha256 = '0'.repeat(64); options.expectedAncestorIdentities[0].identity.ino = '1';
  resume(); await pending;
  assert.notEqual(boundary.requests[1].sourceIdentity.sha256, options.expectedFileIdentity.sha256);
  assert.notEqual(boundary.requests[1].ancestorIdentities[0].identity.ino, options.expectedAncestorIdentities[0].identity.ino);
});

test('exact delete verification failure proves no effect before dispatch', async t => {
  const root = rootFixture(t, `exact-delete-${crypto.randomUUID()}-`);
  const leaf = path.join(root, 'leaf'); fs.writeFileSync(leaf, 'original');
  const boundary = flushFrameBoundary();
  const client = fixtureWorkerClient(root, { spawn: boundary.spawn, verifyWorkerAsync: async () => { throw Error('verification refused'); } });
  await assert.rejects(client.deleteFileExactAsync(leaf, exactDeleteOptions(root, leaf)), { code: 'COMMIT_FAILED', durableEffectState: 'none' });
  assert.equal(boundary.requests.length, 0); assert.equal(fs.readFileSync(leaf, 'utf8'), 'original');
});

function longFlushFixture(t) {
  const root = rootFixture(t, 'minecraft-core-flush-frames-');
  let parent = root;
  for (let index = 0; index < 7; index += 1) {
    parent = path.join(parent, `${index}-${'界'.repeat(240)}`);
    fs.mkdirSync(parent);
  }
  const directories = Array.from({ length: 512 }, (_, index) => path.join(parent, `directory-${index}`));
  for (const directory of directories) fs.mkdirSync(directory);
  const identities = directories.map(directory => identityExpectation(directory, 'directory'));
  return { root, directories, identities };
}

function assertFlushFrames(boundary, directories, identities) {
  const emitted = boundary.requests.flatMap(request => request.directories);
  assert.deepEqual(emitted.map(directory => directory.directoryPath), directories);
  assert.deepEqual(emitted.map(directory => directory.directoryIdentity),
    identities.map(identity => ({ fileType: 'directory', ...identity })));
  for (let index = 0; index < boundary.requests.length; index += 1) {
    const request = boundary.requests[index];
    const frame = boundary.frames[index];
    assert.equal(request.operation, 'flush-directories');
    assert.ok(request.directories.length > 0 && request.directories.length <= 512);
    assert.equal(frame.readUInt32LE(0), frame.length - 4);
    assert.ok(frame.length - 4 <= MAX_FRAME_BYTES);
    assert.equal(Buffer.byteLength(JSON.stringify(request), 'utf8'), frame.length - 4);
  }
}

test('flush frame keeps a small validated set in one native request', async t => {
  const root = rootFixture(t, 'minecraft-core-flush-frame-small-');
  const directories = ['first', 'second'].map(name => path.join(root, name));
  directories.forEach(directory => fs.mkdirSync(directory));
  const identities = directories.map(directory => identityExpectation(directory, 'directory'));
  const boundary = flushFrameBoundary();
  await fixtureWorkerClient(root, { spawn: boundary.spawn }).flushDirectoriesAsync(directories, { directoryIdentities: identities });
  assert.equal(boundary.requests.length, 1);
  assertFlushFrames(boundary, directories, identities);
});

test('flush frame partitions actual multibyte paths before dispatch and preserves each captured identity', async t => {
  const { root, directories, identities } = longFlushFixture(t);
  const boundary = flushFrameBoundary();
  let verifications = 0;
  const client = fixtureWorkerClient(root, {
    spawn: boundary.spawn,
    verifyWorkerAsync: async () => { verifications += 1; }
  });

  await client.flushDirectoriesAsync(directories, { directoryIdentities: identities });

  assert.ok(boundary.requests.length >= 3, 'valid long paths need multiple bounded native frames');
  assertFlushFrames(boundary, directories, identities);
  assert.equal(verifications, boundary.requests.length, 'every native request must receive fresh verification');
  const combined = { ...boundary.requests[0], directories: boundary.requests.flatMap(request => request.directories) };
  assert.ok(JSON.stringify(combined).length < MAX_FRAME_BYTES, 'character-count sizing would incorrectly allow this fixture');
  assert.ok(Buffer.byteLength(JSON.stringify(combined), 'utf8') > MAX_FRAME_BYTES);

  for (const failedChunk of [1, 2]) {
    await t.test(`native failure in chunk ${failedChunk} stops without a smaller retry`, async () => {
      const failing = flushFrameBoundary((_request, child, number) => completeFlushChild(child,
        number === failedChunk ? { ok: false, failureKind: 'io-failure', failureStage: 'completion-flush' } : { ok: true }));
      await assert.rejects(fixtureWorkerClient(root, { spawn: failing.spawn }).flushDirectoriesAsync(directories),
        error => error.code === 'COMMIT_FAILED' && error.durableFailureKind === 'io-failure');
      assert.equal(failing.requests.length, failedChunk, 'never dispatch another chunk or retry a failed chunk');
      assert.deepEqual(failing.requests.map(request => request.directories),
        boundary.requests.slice(0, failedChunk).map(request => request.directories));
    });
  }

  await t.test('serial dispatch awaits each successful child close', async () => {
    const serial = flushFrameBoundary(() => {});
    let settled = false;
    const pending = fixtureWorkerClient(root, { spawn: serial.spawn }).flushDirectoriesAsync(directories)
      .finally(() => { settled = true; });
    await serial.waitForRequests(1);
    serial.children[0].stdout.end(encodeFrame({ ok: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(serial.requests.length, 1, 'successful response bytes alone must not release the next request');
    assert.equal(settled, false);
    serial.children[0].emit('close', 0, null);
    for (let count = 2; count <= boundary.requests.length; count += 1) {
      await serial.waitForRequests(count);
      completeFlushChild(serial.children[count - 1]);
    }
    await pending;
    assertFlushFrames(serial, directories, identities);
  });

  await t.test('configured failed-close policy retains authority until exact child close', async () => {
    const timedOut = flushFrameBoundary(() => {});
    let settled = false;
    const pending = fixtureWorkerClient(root, {
      spawn: timedOut.spawn, timeoutMs: 10, terminationGraceMs: 10, requireConfirmedClose: true
    }).flushDirectoriesAsync(directories).then(() => null, error => error).finally(() => { settled = true; });
    await timedOut.waitForRequests(1);
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.deepEqual(timedOut.killSignals, ['SIGKILL'], 'the worker really reached its timeout before the close check');
    assert.equal(settled, false, 'an unclosed timed-out helper must retain the awaited operation');
    assert.equal(timedOut.requests.length, 1);
    timedOut.children[0].emit('close', null, 'SIGKILL');
    assert.equal((await pending).code, 'COMMIT_FAILED');
    assert.equal(timedOut.requests.length, 1);
  });

  await t.test('a later chunk must verify the worker again and refuse fresh verification failure', async () => {
    const guarded = flushFrameBoundary();
    let calls = 0;
    await assert.rejects(fixtureWorkerClient(root, {
      spawn: guarded.spawn,
      verifyWorkerAsync: async () => { if (++calls === 2) throw new Error('fresh verification refusal'); }
    }).flushDirectoriesAsync(directories), { code: 'COMMIT_FAILED' });
    assert.equal(calls, 2);
    assert.equal(guarded.requests.length, 1);
  });

  await t.test('final revalidation still checks directories from the first chunk', async () => {
    const original = `${directories[0]}-original`;
    const changed = flushFrameBoundary((_request, child, number) => {
      if (number === boundary.requests.length) {
        fs.renameSync(directories[0], original);
        fs.mkdirSync(directories[0]);
      }
      completeFlushChild(child);
    });
    try {
      await assert.rejects(fixtureWorkerClient(root, { spawn: changed.spawn }).flushDirectoriesAsync(directories), { code: 'COMMIT_FAILED' });
      assert.equal(changed.requests.length, boundary.requests.length);
    } finally {
      if (fs.existsSync(original)) {
        fs.rmdirSync(directories[0]);
        fs.renameSync(original, directories[0]);
      }
    }
  });
});

test('flush frame refuses a late unfit singleton with the full allowed-root envelope before any spawn', async t => {
  const root = rootFixture(t, 'minecraft-core-flush-frame-envelope-');
  const short = path.join(root, 'short');
  fs.mkdirSync(short);
  let parent = root;
  for (let index = 0; index < 49; index += 1) {
    parent = path.join(parent, `${index}-${'界'.repeat(230)}`);
    fs.mkdirSync(parent);
  }
  const allowedRoots = [root];
  for (let index = 0; index < 15; index += 1) {
    const allowedRoot = path.join(parent, `root-${index}`);
    fs.mkdirSync(allowedRoot);
    allowedRoots.push(allowedRoot);
  }
  let long = allowedRoots[1];
  for (let index = 0; index < 70; index += 1) {
    long = path.join(long, `${index}-${'界'.repeat(230)}`);
    fs.mkdirSync(long);
  }
  const boundary = flushFrameBoundary();
  let spawnCalls = 0;
  const client = fixtureWorkerClient(root, { allowedRoots, spawn() { spawnCalls += 1; return boundary.spawn(); } });
  const envelope = {
    operation: 'flush-directories',
    allowedRoots,
    allowedRootIdentities: allowedRoots.map(candidate => ({ path: candidate,
      identity: { fileType: 'directory', ...identityExpectation(candidate, 'directory') } }))
  };
  const singletonBytes = candidate => Buffer.byteLength(JSON.stringify({ ...envelope,
    directories: [{ directoryPath: candidate, directoryIdentity: { fileType: 'directory', ...identityExpectation(candidate, 'directory') } }]
  }), 'utf8');
  assert.ok(singletonBytes(short) <= MAX_FRAME_BYTES, 'the first directory is independently feasible');
  assert.ok(singletonBytes(long) > MAX_FRAME_BYTES, 'a later valid long singleton cannot fit its full root envelope');
  assert.ok(Buffer.byteLength(JSON.stringify({ directories: [{ directoryPath: long,
    directoryIdentity: { fileType: 'directory', ...identityExpectation(long, 'directory') } }] }), 'utf8') < MAX_FRAME_BYTES,
  'the directory alone fits; the private root envelope is load-bearing');

  await assert.rejects(client.flushDirectoriesAsync([short, long]), { code: 'COMMIT_FAILED' });
  assert.equal(spawnCalls, 0, 'all singleton envelopes must be feasible before even the first native spawn');
});

test('flush frame final revalidation refuses replacement of an allowed root after native success', async t => {
  const fixture = rootFixture(t, 'minecraft-core-flush-frame-root-change-');
  const root = path.join(fixture, 'owned');
  const original = path.join(fixture, 'owned-original');
  fs.mkdirSync(root);
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);
  const boundary = flushFrameBoundary((_request, child) => {
    fs.renameSync(root, original);
    fs.mkdirSync(root);
    // Keep the requested directory present with its original identity so the
    // allowed-root check, not a missing-directory error, must refuse success.
    fs.renameSync(path.join(original, 'directory'), directory);
    completeFlushChild(child);
  });
  await assert.rejects(fixtureWorkerClient(root, { spawn: boundary.spawn,
    appOwnedRoot: path.join(fixture, 'broker') }).flushDirectoriesAsync([directory]), { code: 'COMMIT_FAILED' });
  assert.equal(boundary.requests.length, 1);
});

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

function packagedDurabilityWorkerPaths() {
  // A scoped fresh publish can be verified without overwriting checked-in vendor
  // artifacts. Both paths remain subject to the production integrity verifier.
  const workerPath = process.env.MINECRAFT_CORE_TEST_DURABILITY_WORKER;
  const workerManifestPath = process.env.MINECRAFT_CORE_TEST_DURABILITY_MANIFEST;
  if (workerPath !== undefined || workerManifestPath !== undefined) {
    assert.equal(typeof workerPath, 'string'); assert.equal(typeof workerManifestPath, 'string');
    assert.ok(path.isAbsolute(workerPath) && path.isAbsolute(workerManifestPath));
    return { workerPath, workerManifestPath };
  }
  return {
    workerPath: path.join(__dirname, '..', 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe'),
    workerManifestPath: path.join(__dirname, '..', 'build-resources', 'archive-runtime', 'archive-worker-x64.json')
  };
}

test('packaged native worker performs asynchronous move and replacement end to end', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = rootFixture(t, 'minecraft-core-durable-async-native-');
  const { workerPath, workerManifestPath } = packagedDurabilityWorkerPaths();
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

test('packaged native worker performs exact delete and absent reconciliation end to end', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = rootFixture(t, `minecraft-exact-delete-native-${crypto.randomUUID()}-`);
  const leaf = path.join(root, 'authorized.bin'); const sibling = path.join(root, 'sibling.bin');
  fs.writeFileSync(leaf, 'authorized bytes'); fs.writeFileSync(sibling, 'preserve');
  const options = exactDeleteOptions(root, leaf);
  const client = new WindowsDurableFsClient({
    ...packagedDurabilityWorkerPaths(),
    allowedRoots: [root], appOwnedRoot: path.join(root, 'broker')
  });
  assert.deepEqual(await client.deleteFileExactAsync(leaf, options), { deleted: true, durable: true });
  assert.equal(fs.existsSync(leaf), false); assert.equal(fs.readFileSync(sibling, 'utf8'), 'preserve');
  assert.deepEqual(await client.deleteFileExactAsync(leaf, { ...options, mode: 'reconcile-absent' }), { deleted: true, durable: true });
  fs.writeFileSync(leaf, 'replacement');
  await assert.rejects(client.deleteFileExactAsync(leaf, { ...options, mode: 'reconcile-absent' }), { code: 'COMMIT_FAILED', durableEffectState: 'none' });
  assert.equal(fs.readFileSync(leaf, 'utf8'), 'replacement'); assert.equal(fs.readFileSync(sibling, 'utf8'), 'preserve');
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
