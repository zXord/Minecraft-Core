const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const { ARCHIVE_LIMITS } = require('../../electron/services/modpacks/limits.cjs');
const {
  MAX_FLUSH_DIRECTORIES,
  WindowsDurableFsClient
} = require('../../electron/utils/windows-durable-fs-client.cjs');
const {
  ArchiveWorkerClient,
  MAX_FRAME_BYTES,
  StrictFrameDecoder,
  createBrokerBundle,
  encodeFrame,
  getBrokerBundleRecoveryDiagnostics,
  markBrokerBundleRunning,
  recoverBrokerBundles,
  removeBrokerBundle,
  verifyArchiveWorkerExecutableSync
} = require('../../electron/services/modpacks/archive/archive-worker-client.cjs');

function rawFrame(bytes) {
  const body = Buffer.from(bytes);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}

class FakeChild extends EventEmitter {
  constructor(onRequest) {
    super();
    this.pid = 424242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.killCount = 0;
    this.stdinChunks = [];
    this.controls = [];
    this.requestDispatched = false;
    const consume = () => {
      const bytes = Buffer.concat(this.stdinChunks);
      let offset = 0;
      while (bytes.length - offset >= 4) {
        const length = bytes.readUInt32LE(offset);
        if (bytes.length - offset < length + 4) break;
        const framed = bytes.subarray(offset, offset + length + 4);
        offset += length + 4;
        if (!this.requestDispatched) {
          this.requestDispatched = true;
          onRequest?.(framed, this);
        } else {
          const control = parseSingleRequest(framed);
          this.controls.push(control);
          this.onControl?.(control);
        }
      }
      this.stdinChunks = offset === 0 ? this.stdinChunks : [bytes.subarray(offset)];
    };
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        this.stdinChunks.push(Buffer.from(chunk));
        try { consume(); done(); } catch (error) { done(error); }
      },
      final: (done) => {
        try {
          consume();
          done();
        } catch (error) {
          done(error);
        }
      }
    });
  }

  kill() {
    this.killed = true;
    this.killCount += 1;
    queueMicrotask(() => this.emit('close', null, 'SIGKILL'));
    return true;
  }

  finish(code = 0) {
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, null));
  }
}

function parseSingleRequest(bytes) {
  assert.ok(bytes.length >= 4);
  const length = bytes.readUInt32LE(0);
  assert.equal(bytes.length, length + 4, 'the client writes exactly one frame');
  return JSON.parse(bytes.subarray(4).toString('utf8'));
}

function goodStatus(overrides = {}) {
  return {
    type: 'status',
    ok: true,
    exitCode: 0,
    metrics: { stdoutBytes: '0', stderrBytes: '0', dataBytes: '0', elapsedMs: 1 },
    ...overrides
  };
}

function writeFrames(child, frames, { fragment = false, code = 0 } = {}) {
  const bytes = Buffer.concat(frames.map((frame) => Buffer.isBuffer(frame) ? frame : encodeFrame(frame)));
  if (fragment) for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  else child.stdout.write(bytes);
  child.finish(code);
}

function fixture(t, responder, clientOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-archive-client-'));
  const workspaceRoot = path.join(root, 'workspaces');
  const inputDirectoryId = 'input-id-1';
  const outputDirectoryId = 'output-id-1';
  fs.mkdirSync(path.join(workspaceRoot, inputDirectoryId), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, outputDirectoryId));
  const archiveBytes = Buffer.from('archive');
  fs.writeFileSync(path.join(workspaceRoot, inputDirectoryId, 'pack.zip'), archiveBytes);
  fs.writeFileSync(path.join(root, 'worker.exe'), 'worker');
  fs.writeFileSync(path.join(root, 'worker.json'), '{}');
  const calls = [];
  const children = [];
  let activeChild = null;
  const queuedControls = [];
  const deliverControl = control => {
    if (!activeChild) { queuedControls.push(control); return; }
    activeChild.controls.push(control);
    activeChild.onControl?.(control);
  };
  const controlChannelFactory = async () => ({
    pipeName: '\\\\.\\pipe\\MinecraftCore.ArchiveWorker.test.0123456789abcdef',
    onError() {},
    send(control) { deliverControl(control); return true; },
    close() {}
  });
  let announceSpawn;
  const spawned = new Promise(resolve => { announceSpawn = resolve; });
  const verifiedSet = {
    type: 'verified-artifact-set',
    artifactSet: {
      primaryPartId: 'part-1',
      setDigest: 'a'.repeat(64),
      parts: [{
        partId: 'part-1', fileName: 'pack.zip', measuredSize: String(archiveBytes.length),
        calculatedDigests: {
          sha256: crypto.createHash('sha256').update(archiveBytes).digest('hex'),
          sha512: crypto.createHash('sha512').update(archiveBytes).digest('hex')
        }
      }]
    }
  };
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(verifiedSet), 'utf8').digest('hex');
  const registry = {
    resolveOwnedId({ ownerId, id, kind }) {
      if (ownerId !== 'operation-1') throw new Error('wrong owner');
      if (id === 'artifact-set-1' && kind === 'artifact-set') return {
        id,
        kind,
        value: {
          ...verifiedSet
        }
      };
      if (id === inputDirectoryId && kind === 'input') return {
        id, kind, value: {
          sourceArtifactSetId: 'artifact-set-1',
          sourceSetDigest: verifiedSet.artifactSet.setDigest,
          sourceFingerprint
        }
      };
      if (id === outputDirectoryId && kind === 'output') return { id, kind, value: {} };
      throw new Error('unknown opaque ID');
    }
  };
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new FakeChild(responder);
    activeChild = child;
    for (const control of queuedControls.splice(0)) deliverControl(control);
    children.push(child);
    announceSpawn(child);
    return child;
  };
  const client = new ArchiveWorkerClient({
    workerPath: path.join(root, 'worker.exe'),
    workerManifestPath: path.join(root, 'worker.json'),
    resourcesRoot: root,
    workspaceRoot,
    workspaceRegistry: registry,
    spawn,
    reparseInspector: { isReparsePoint: async () => false },
    verifyWorker: async () => ({ architecture: 'x64' }),
    verifyRuntime: async () => ({ version: '26.02', architecture: 'x64' }),
    appOwnedRoot: path.join(root, 'app-owned'),
    controlChannelFactory,
    ...clientOptions
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { client, calls, children, spawned, root, workspaceRoot, inputDirectoryId, outputDirectoryId, verifiedSet, registry };
}

function request(overrides = {}) {
  return {
    operation: 'list',
    operationId: 'operation-1',
    artifactSetId: 'artifact-set-1',
    inputDirectoryId: 'input-id-1',
    archiveFamily: 'zip',
    limits: { ...ARCHIVE_LIMITS },
    ...overrides
  };
}

// Exercise the real invocation/decoder while holding the external close authority.
async function terminalControlFixture(t, { synchronous, send = () => true, killResult = true,
  deadlineOverrideMs = 60_000 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const intervalCallbacks = [];
  const setTestInterval = global.setInterval;
  t.mock.method(global, 'setInterval', (...args) => {
    intervalCallbacks.push(args[0]);
    return setTestInterval(...args);
  });
  const sends = [];
  const frames = [];
  let controlError;
  let channelCloses = 0;
  let nativeRequest;
  let announceRequest;
  const received = new Promise(resolve => { announceRequest = resolve; });
  const f = fixture(t, (bytes, child) => {
    nativeRequest = parseSingleRequest(bytes);
    synchronous?.(child);
    announceRequest(child);
  }, {
    deadlineOverrideMs, cleanupGraceMs: 10, forceCloseWaitMs: 20,
    controlChannelFactory: async () => ({
      pipeName: '\\\\.\\pipe\\MinecraftCore.ArchiveWorker.test.0123456789abcdef',
      onError(handler) { controlError = handler; },
      send(control) { sends.push(control); return send(control); },
      close() { channelCloses += 1; }
    })
  });
  const controller = new AbortController();
  let settled = false;
  let closed = false;
  const outcome = f.client.run(request(), { signal: controller.signal, onFrame: frame => frames.push(frame) })
    .then(value => { settled = true; return { kind: 'resolved', value }; },
      error => { settled = true; return { kind: 'rejected', error }; });
  const child = await received;
  child.kill = () => { child.killCount += 1; child.killed = true; return killResult; };
  const close = (code = 0, signal = null) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, signal);
  };
  t.after(async () => { close(); await outcome; });
  await new Promise(resolve => setImmediate(resolve)); // stdin.end and interval setup returned.
  return {
    ...f, child, controller, sends, frames, outcome, intervalCallbacks, close,
    emit: frame => child.stdout.write(Buffer.isBuffer(frame) ? frame : encodeFrame(frame)),
    controlError: () => controlError(new Error('synthetic control transport failure')),
    settled: () => settled,
    channelCloses: () => channelCloses,
    assertAuthenticatedCancel() {
      const cancels = sends.filter(control => control.type === 'cancel');
      assert.ok(cancels.length > 0, 'termination requests authenticated cancellation');
      assert.ok(cancels.every(control => control.token === nativeRequest.controlToken));
      assert.match(nativeRequest.controlToken, /^[a-f0-9]{64}$/u);
    }
  };
}

async function assertTerminalPending(h) {
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.settled(), false, 'only explicit child close proves quiescence');
  assert.equal(h.channelCloses(), 0, 'terminal must not close the control channel early');
}

async function assertTerminalRejected(h, code = 'EXTRACTOR_UNAVAILABLE') {
  await assertTerminalPending(h);
  h.close();
  const outcome = await h.outcome;
  assert.equal(outcome.kind, 'rejected');
  assert.equal(outcome.error.code, code);
  assert.equal(h.channelCloses(), 1);
  return outcome.error;
}

test('terminal control: accepted success stops heartbeats before a false send and still waits for close', async t => {
  const h = await terminalControlFixture(t, { send: () => false });
  assert.equal(h.intervalCallbacks.length, 1, 'status follows interval installation');
  h.emit(goodStatus());
  t.mock.timers.tick(5000);
  await assertTerminalPending(h);
  h.close();
  const outcome = await h.outcome;
  assert.equal(outcome.kind, 'resolved', outcome.error?.stack);
  assert.deepEqual(h.sends, [], 'no post-status heartbeat or cancellation');
  assert.equal(h.child.killCount, 0);
  assert.equal(h.channelCloses(), 1);
});

test('terminal control: synchronous success never installs a heartbeat and still waits for close', async t => {
  const h = await terminalControlFixture(t, {
    synchronous: child => child.stdout.write(encodeFrame(goodStatus())), send: () => false
  });
  t.mock.timers.tick(5000);
  await assertTerminalPending(h);
  h.close();
  const outcome = await h.outcome;
  assert.equal(outcome.kind, 'resolved', outcome.error?.stack);
  assert.equal(h.intervalCallbacks.length, 0);
  assert.deepEqual(h.sends, []);
  assert.equal(h.child.killCount, 0);
});

for (const [name, status, expected] of [
  ['success', goodStatus(), 'resolved'],
  ['reviewed failure', goodStatus({ ok: false, exitCode: 2, errorCode: 'ENCRYPTED_ARCHIVE' }), 'rejected']
]) {
  test(`terminal control: late control error preserves ${name} until clean close`, async t => {
    const h = await terminalControlFixture(t);
    h.emit(status);
    h.controlError();
    t.mock.timers.tick(5000);
    await assertTerminalPending(h);
    h.close();
    const outcome = await h.outcome;
    assert.equal(outcome.kind, expected, outcome.error?.stack);
    if (expected === 'rejected') assert.equal(outcome.error.code, 'ENCRYPTED_ARCHIVE');
    assert.deepEqual(h.sends, []);
    assert.equal(h.child.killCount, 0);
    assert.equal(h.channelCloses(), 1);
  });
}

test('terminal control: stale heartbeat callbacks cannot send after terminal or close', async t => {
  const h = await terminalControlFixture(t, { send: () => false });
  const staleHeartbeat = h.intervalCallbacks[0];
  h.emit(goodStatus());
  staleHeartbeat();
  await assertTerminalPending(h);
  h.close();
  const outcome = await h.outcome;
  assert.equal(outcome.kind, 'resolved', outcome.error?.stack);
  staleHeartbeat();
  assert.deepEqual(h.sends, []);
  assert.equal(h.child.killCount, 0);
});

for (const failure of ['send false', 'send throw', 'control error']) {
  test(`terminal control: pre-terminal ${failure} remains fatal after success status`, async t => {
    const h = await terminalControlFixture(t, {
      send: control => {
        if (control.type === 'cancel' || failure === 'send false') return false;
        if (failure === 'send throw') throw new Error('synthetic send failure');
        return true;
      }
    });
    if (failure === 'control error') h.controlError();
    else t.mock.timers.tick(5000);
    h.assertAuthenticatedCancel();
    const sendsBeforeStaleCallback = h.sends.length;
    h.intervalCallbacks[0]();
    assert.equal(h.sends.length, sendsBeforeStaleCallback, 'terminated invocations cannot send stale heartbeats');
    h.emit(goodStatus());
    const error = await assertTerminalRejected(h);
    if (failure === 'control error') assert.equal(error.cause.message, 'synthetic control transport failure');
    assert.equal(h.child.killCount, 0);
  });
}

test('terminal control: synchronous termination does not install a heartbeat', async t => {
  const h = await terminalControlFixture(t, {
    synchronous: child => child.emit('error', new Error('synchronous child failure'))
  });
  assert.equal(h.intervalCallbacks.length, 0);
  h.assertAuthenticatedCancel();
  await assertTerminalRejected(h);
});

for (const reason of ['abort', 'deadline']) {
  for (const killResult of [true, false]) {
    test(`terminal control: ${reason} after terminal retains close authority when kill returns ${killResult}`, async t => {
      const h = await terminalControlFixture(t, {
        killResult, deadlineOverrideMs: 10_000,
        send: control => { if (control.type === 'cancel') throw new Error('cancel transport gone'); return true; }
      });
      h.emit(goodStatus());
      if (reason === 'abort') h.controller.abort();
      else t.mock.timers.tick(10_000);
      h.assertAuthenticatedCancel();
      assert.deepEqual(h.sends.map(control => control.type), ['cancel']);
      await assertTerminalPending(h);
      t.mock.timers.tick(10);
      assert.equal(h.child.killCount, 1, 'cleanup grace requests first kill');
      await assertTerminalPending(h);
      t.mock.timers.tick(20);
      assert.equal(h.child.killCount, 2, 'force-close wait requests second kill');
      t.mock.timers.tick(1000);
      await assertTerminalPending(h);
      await assertTerminalRejected(h, reason === 'abort' ? 'CANCELLED' : 'EXTRACTOR_UNAVAILABLE');
    });
  }
}

for (const [name, trailing] of [
  ['duplicate status', goodStatus()],
  ['stdout', { type: 'stdout', text: 'late' }],
  ['stderr', { type: 'stderr', text: 'late' }],
  ['data', { type: 'data', data: 'eA==' }],
  ['malformed JSON', rawFrame('{')],
  ['truncated frame', encodeFrame(goodStatus()).subarray(0, 9)]
]) {
  test(`terminal control: separately delivered trailing ${name} still rejects`, async t => {
    const h = await terminalControlFixture(t);
    h.emit(goodStatus());
    await assertTerminalPending(h);
    h.emit(trailing);
    assert.deepEqual(h.frames, [], 'no trailing output reaches the consumer');
    await assertTerminalRejected(h);
    if (name !== 'truncated frame') h.assertAuthenticatedCancel();
  });
}

test('terminal control: same-chunk duplicate status still rejects', async t => {
  const h = await terminalControlFixture(t);
  h.emit(Buffer.concat([encodeFrame(goodStatus()), encodeFrame(goodStatus())]));
  h.assertAuthenticatedCancel();
  await assertTerminalRejected(h);
});

for (const metric of ['stdoutBytes', 'stderrBytes', 'dataBytes']) {
  test(`terminal control: mismatched ${metric} still rejects only at close`, async t => {
    const h = await terminalControlFixture(t);
    h.emit(goodStatus({ metrics: { ...goodStatus().metrics, [metric]: '1' } }));
    t.mock.timers.tick(5000);
    assert.deepEqual(h.sends, []);
    await assertTerminalRejected(h);
  });
}

for (const [name, code, signal] of [
  ['nonzero exit', 9, null], ['signal', 0, 'SIGTERM'], ['null exit', null, null]
]) {
  test(`terminal control: ${name} still rejects only at close`, async t => {
    const h = await terminalControlFixture(t);
    h.emit(goodStatus());
    await assertTerminalPending(h);
    h.close(code, signal);
    const outcome = await h.outcome;
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.error.code, 'EXTRACTOR_UNAVAILABLE');
    assert.deepEqual(h.sends, []);
    assert.equal(h.child.killCount, 0);
  });
}

test('terminal control: one raw broker-stderr byte still rejects only at close', async t => {
  const h = await terminalControlFixture(t);
  h.emit(goodStatus());
  h.child.stderr.write(Buffer.from('x'));
  assert.deepEqual(h.sends, []);
  await assertTerminalRejected(h);
});

for (const source of ['child', 'stdin', 'stdout', 'stderr']) {
  test(`terminal control: post-terminal ${source} error remains fatal`, async t => {
    const h = await terminalControlFixture(t);
    h.emit(goodStatus());
    (source === 'child' ? h.child : h.child[source]).emit('error', new Error(`synthetic ${source} failure`));
    h.assertAuthenticatedCancel();
    const error = await assertTerminalRejected(h);
    assert.equal(error.cause.message, `synthetic ${source} failure`);
    assert.equal(h.child.killCount, 0);
  });
}

test('terminal control: malformed terminal shape never ends control error authority', async t => {
  const h = await terminalControlFixture(t);
  h.emit(goodStatus({ extra: true }));
  const cancelsBeforeError = h.sends.length;
  h.controlError();
  assert.equal(h.sends.length, cancelsBeforeError + 1, 'invalid terminal cannot suppress control failure');
  h.assertAuthenticatedCancel();
  await assertTerminalRejected(h);
});

test('terminal control: partial terminal frame keeps heartbeats and control errors authoritative', async t => {
  const h = await terminalControlFixture(t);
  h.emit(encodeFrame(goodStatus()).subarray(0, 9));
  t.mock.timers.tick(5000);
  assert.deepEqual(h.sends.map(control => control.type), ['keepalive']);
  h.controlError();
  h.assertAuthenticatedCancel();
  const error = await assertTerminalRejected(h);
  assert.equal(error.cause.message, 'synthetic control transport failure');
});

async function assertFileHandleCloses(handle) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await handle.stat();
    } catch (error) {
      if (error?.code === 'EBADF') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('the FileHandle acquired after timeout remained open');
}

test('writes one closed request, uses the verified hidden broker, and accepts byte-fragmented frames', async (t) => {
  let nativeRequest;
  const f = fixture(t, (bytes, child) => {
    nativeRequest = parseSingleRequest(bytes);
    writeFrames(child, [
      { type: 'stdout', text: 'Path = safe.txt\r\n' },
      goodStatus({ metrics: { stdoutBytes: '17', stderrBytes: '0', dataBytes: '0', elapsedMs: 3 } })
    ], { fragment: true });
  });
  const seen = [];
  const status = await f.client.run(request(), { onFrame: frame => seen.push(frame) });

  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, path.join(f.root, 'worker.exe'));
  assert.deepEqual(f.calls[0].args, []);
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.windowsHide, true);
  assert.deepEqual(f.calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(Object.hasOwn(f.calls[0].options.env, 'PATH'), false);
  const extractionBlocker = f.calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  assert.match(extractionBlocker, /^\\\\\?\\/u);
  assert.equal(extractionBlocker.replace(/^\\\\\?\\/u, ''), path.join(f.root, 'worker.exe'));
  assert.equal(fs.lstatSync(extractionBlocker).isFile(), true, 'the extraction base is the verified worker file');
  assert.equal(nativeRequest.operation, 'list');
  assert.equal(nativeRequest.archiveFamily, 'zip');
  assert.equal(nativeRequest.archivePath, path.join(f.workspaceRoot, f.inputDirectoryId, 'pack.zip'));
  assert.equal(nativeRequest.inputDirectory, path.join(f.workspaceRoot, f.inputDirectoryId));
  assert.deepEqual(nativeRequest.inputParts, [{
    path: path.join(f.workspaceRoot, f.inputDirectoryId, 'pack.zip'),
    size: '7',
    sha256: crypto.createHash('sha256').update('archive').digest('hex'),
    sha512: crypto.createHash('sha512').update('archive').digest('hex')
  }]);
  assert.equal(Object.hasOwn(nativeRequest, 'artifactSetId'), false);
  assert.equal(Object.hasOwn(nativeRequest, 'inputDirectoryId'), false);
  assert.equal(Object.hasOwn(nativeRequest, 'executable'), false);
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(Object.isFrozen(status), true);
  assert.equal(status.ok, true);
});

test('rejects unknown request keys, renderer paths, command fields, and non-exact limits before spawn', async (t) => {
  const forbidden = [
    { path: 'C:\\secret' }, { executable: '7z.exe' }, { args: ['x'] }, { env: { X: '1' } },
    { url: 'https://example.test/a.zip' }, { password: 'secret' }, { cachePath: 'C:\\cache' },
    { limits: { ...ARCHIVE_LIMITS, arbitrary: 1 } },
    { limits: { ...ARCHIVE_LIMITS, maxArchiveEntries: ARCHIVE_LIMITS.maxArchiveEntries - 1 } }
  ];
  for (const extra of forbidden) {
    const f = fixture(t, () => assert.fail('spawned'));
    await assert.rejects(f.client.run(request(extra), {}), error => error.code === 'INVALID_REQUEST', JSON.stringify(extra));
    assert.equal(f.calls.length, 0);
  }
});

test('validates operation, IDs, archive family, output, and read-entry contract before spawn', async (t) => {
  const invalid = [
    { operation: 'run' }, { operationId: '../owner' }, { operationId: 'operation:one' }, { artifactSetId: 'C:\\x' }, { inputDirectoryId: '..' },
    { artifactSetId: 'artifact:set' }, { inputDirectoryId: 'input:stream' },
    { archiveFamily: '7z' }, { archiveFamily: 'multipart-rar' }, { outputDirectoryId: 'output-id-1' }, { operation: 'extract' },
    { operation: 'extract', outputDirectoryId: 'output:stream' },
    { operation: 'read-entry' }, { operation: 'read-entry', entryName: '../secret' }, { operation: 'read-entry', entryName: 'CON.txt', maxDataBytes: '1' },
    { operation: 'read-entry', entryName: '@listfile.txt', maxDataBytes: '1' },
    { operation: 'list', entryName: 'file.txt' }
  ];
  for (const change of invalid) {
    const f = fixture(t, () => assert.fail('spawned'));
    await assert.rejects(f.client.run(request(change), {}), error => error.code === 'INVALID_REQUEST', JSON.stringify(change));
    assert.equal(f.calls.length, 0);
  }
});

test('read-entry accepts one narrowing decimal cap and cannot widen or leak it to other operations', async (t) => {
  let nativeRequest;
  const f = fixture(t, (bytes, child) => {
    nativeRequest = parseSingleRequest(bytes);
    writeFrames(child, [goodStatus()]);
  });
  await f.client.run(request({ operation: 'read-entry', entryName: 'manifest.json', maxDataBytes: '2097152' }), {});
  assert.equal(nativeRequest.maxDataBytes, '2097152');
  for (const change of [
    { operation: 'read-entry', entryName: 'manifest.json', maxDataBytes: '0' },
    { operation: 'read-entry', entryName: 'manifest.json', maxDataBytes: '67108865' },
    { operation: 'read-entry', entryName: 'manifest.json', maxDataBytes: 2097152 },
    { maxDataBytes: '1' }
  ]) {
    await assert.rejects(f.client.run(request(change), {}), error => error.code === 'INVALID_REQUEST');
  }
  assert.equal(f.calls.length, 1);
});

test('preserves concrete RAR4/RAR5 handlers and rejects ambiguous multipart family', async (t) => {
  const observed = [];
  const f = fixture(t, (bytes, child) => {
    observed.push(parseSingleRequest(bytes).archiveFamily);
    writeFrames(child, [goodStatus()]);
  });
  await f.client.run(request({ archiveFamily: 'rar4' }), {});
  await f.client.run(request({ archiveFamily: 'rar5' }), {});
  assert.deepEqual(observed, ['rar4', 'rar5']);
  await assert.rejects(f.client.run(request({ archiveFamily: 'multipart-rar' }), {}), error => error.code === 'INVALID_REQUEST');
});

test('rejects cross-paired input IDs and substituted bytes before spawning', async (t) => {
  const crossPaired = fixture(t, () => assert.fail('spawned'));
  const originalResolve = crossPaired.registry.resolveOwnedId.bind(crossPaired.registry);
  crossPaired.registry.resolveOwnedId = value => {
    const record = originalResolve(value);
    if (value.kind === 'input') return { ...record, value: { ...record.value, sourceArtifactSetId: 'artifact-set-2' } };
    return record;
  };
  await assert.rejects(crossPaired.client.run(request(), {}), error => error.code === 'INVALID_REQUEST');
  assert.equal(crossPaired.calls.length, 0);

  const substituted = fixture(t, () => assert.fail('spawned'));
  fs.writeFileSync(path.join(substituted.workspaceRoot, substituted.inputDirectoryId, 'pack.zip'), 'ARCHIVE');
  await assert.rejects(substituted.client.run(request(), {}), error => error.code === 'HASH_MISMATCH');
  assert.equal(substituted.calls.length, 0);
});

test('requires the registry to return an app-issued verified artifact set', async (t) => {
  const f = fixture(t, () => assert.fail('spawned'));
  const original = f.client.workspaceRegistry.resolveOwnedId.bind(f.client.workspaceRegistry);
  f.client.workspaceRegistry.resolveOwnedId = requestValue => {
    const value = original(requestValue);
    if (requestValue.kind === 'artifact-set') value.value.type = 'provisional-artifact-set';
    return value;
  };
  await assert.rejects(f.client.run(request(), {}), error => error.code === 'INVALID_REQUEST');
  assert.equal(f.calls.length, 0);
});

test('extract requires a fresh empty controlled output and normalizes MRPACK to forced ZIP', async (t) => {
  let nativeRequest;
  const f = fixture(t, (bytes, child) => {
    nativeRequest = parseSingleRequest(bytes);
    writeFrames(child, [goodStatus()]);
  });
  await f.client.run(request({ operation: 'extract', outputDirectoryId: f.outputDirectoryId, archiveFamily: 'mrpack' }), {});
  assert.equal(nativeRequest.archiveFamily, 'zip');
  assert.equal(nativeRequest.outputDirectory, path.join(f.workspaceRoot, f.outputDirectoryId));

  fs.writeFileSync(path.join(f.workspaceRoot, f.outputDirectoryId, 'occupied'), 'x');
  await assert.rejects(
    f.client.run(request({ operation: 'extract', outputDirectoryId: f.outputDirectoryId }), {}),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.equal(f.calls.length, 1);
});

test('rejects oversized prefixes, truncated frames, fatal UTF-8, duplicate keys, and JSON limits', async (t) => {
  const cases = [
    (child) => { const prefix = Buffer.alloc(4); prefix.writeUInt32LE(MAX_FRAME_BYTES + 1); child.stdout.end(prefix); child.finish(0); },
    (child) => { const prefix = Buffer.alloc(4); prefix.writeUInt32LE(10); child.stdout.end(Buffer.concat([prefix, Buffer.from('{}')])); child.finish(0); },
    (child) => { child.stdout.end(rawFrame(Buffer.from([0xff, 0xfe]))); child.finish(0); },
    (child) => { child.stdout.end(rawFrame('{"type":"status","type":"status","ok":true,"exitCode":0,"metrics":{"stdoutBytes":"0","stderrBytes":"0","dataBytes":"0","elapsedMs":0}}')); child.finish(0); },
    (child) => { child.stdout.end(rawFrame(`{"type":"stdout","text":"${'x'.repeat(1024 * 1024)}"}`)); child.finish(0); },
    (child) => { child.stdout.end(rawFrame(`{"type":"data","data":[${Array(5000).fill('0').join(',')}]}`)); child.finish(0); },
    (child) => { child.stdout.end(rawFrame(`${'['.repeat(70)}0${']'.repeat(70)}`)); child.finish(0); }
  ];
  for (const emit of cases) {
    const f = fixture(t, (_bytes, child) => emit(child));
    await assert.rejects(f.client.run(request(), {}), error => error.code === 'EXTRACTOR_UNAVAILABLE');
  }
});

test('fragmented frame decoding never shifts the chunk queue', () => {
  const seen = [];
  const decoder = new StrictFrameDecoder(value => seen.push(value));
  const originalShift = Array.prototype.shift;
  Array.prototype.shift = () => { throw new Error('quadratic shift'); };
  try {
    for (const byte of encodeFrame(goodStatus())) decoder.push(Buffer.from([byte]));
    decoder.end();
  } finally {
    Array.prototype.shift = originalShift;
  }
  assert.equal(seen.length, 1);
});

test('rejects unknown frame types or keys and every malformed terminal-status shape', async (t) => {
  const badFrames = [
    { type: 'progress', text: 'x' },
    { type: 'stdout', text: 'x', extra: true },
    { type: 'status', ok: true, exitCode: 0, metrics: goodStatus().metrics, extra: true },
    { type: 'status', ok: true, exitCode: 1, metrics: goodStatus().metrics },
    { type: 'status', ok: false, exitCode: 0, errorCode: 'EXTRACTOR_FAILED', metrics: goodStatus().metrics },
    { type: 'status', ok: false, exitCode: 2, errorCode: 'NATIVE_SECRET', metrics: goodStatus().metrics },
    { type: 'status', ok: true, exitCode: 0, errorCode: 'EXTRACTOR_FAILED', metrics: goodStatus().metrics },
    { type: 'status', ok: true, exitCode: 0, metrics: { ...goodStatus().metrics, stdoutBytes: 0 } },
    { type: 'status', ok: true, exitCode: 0, metrics: { ...goodStatus().metrics, unknown: '1' } }
  ];
  for (const frame of badFrames) {
    const f = fixture(t, (_bytes, child) => writeFrames(child, [frame]));
    await assert.rejects(f.client.run(request(), {}), error => error.code === 'EXTRACTOR_UNAVAILABLE', JSON.stringify(frame));
  }
});

test('terminal byte metrics must exactly match the observed framed payloads', async (t) => {
  const f = fixture(t, (_bytes, child) => writeFrames(child, [
    { type: 'stdout', text: 'abc' },
    goodStatus({ metrics: { stdoutBytes: '2', stderrBytes: '0', dataBytes: '0', elapsedMs: 1 } })
  ]));
  await assert.rejects(f.client.run(request(), {}), error => error.code === 'EXTRACTOR_UNAVAILABLE');
});

test('requires exactly one final status and rejects frames after it or a nonzero broker exit', async (t) => {
  const variants = [
    { frames: [{ type: 'stdout', text: 'no status' }], code: 0 },
    { frames: [goodStatus(), goodStatus()], code: 0 },
    { frames: [goodStatus(), { type: 'stderr', text: 'late' }], code: 0 },
    { frames: [goodStatus()], code: 9 }
  ];
  for (const variant of variants) {
    const f = fixture(t, (_bytes, child) => writeFrames(child, variant.frames, { code: variant.code }));
    await assert.rejects(f.client.run(request(), {}), error => error.code === 'EXTRACTOR_UNAVAILABLE');
  }
});

test('enforces stdout, stderr, data, and unframed broker-stderr caps', async (t) => {
  const frames = [
    { type: 'stdout', text: 'four' },
    { type: 'stderr', text: 'four' },
    { type: 'data', data: Buffer.from('four').toString('base64') }
  ];
  for (const frame of frames) {
    const f = fixture(t, (_bytes, child) => writeFrames(child, [frame, goodStatus()]), {
      outputCaps: { stdout: 3, stderr: 3, data: 3 }
    });
    await assert.rejects(f.client.run(request(), {}), error => error.code === 'ARCHIVE_LIMIT_EXCEEDED');
    assert.equal(f.children[0].killed, false, 'a naturally closing broker is not forcibly terminated');
  }
  const f = fixture(t, (_bytes, child) => {
    child.stderr.write(Buffer.alloc(1024 * 1024 + 1));
    writeFrames(child, [goodStatus()]);
  });
  await assert.rejects(f.client.run(request(), {}), error => error.code === 'EXTRACTOR_UNAVAILABLE');
});

test('timeout and cancellation request graceful native cleanup, settle once, and remove abort listeners', async (t) => {
  const gracefulResponder = (_bytes, child) => {
    child.onControl = control => {
      if (control.type === 'cancel') writeFrames(child, [goodStatus({ ok: false, exitCode: 2, errorCode: 'CANCELLED' })]);
    };
  };
  const f = fixture(t, gracefulResponder);
  const controller = new AbortController();
  let additions = 0;
  let removals = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { additions += 1; return add(...args); };
  controller.signal.removeEventListener = (...args) => { removals += 1; return remove(...args); };
  const pending = f.client.run(request(), { signal: controller.signal });
  await f.spawned;
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(f.children[0].killed, false);
  assert.equal(f.children[0].controls.some(control => control.type === 'cancel' && /^[a-f0-9]{64}$/.test(control.token)), true);
  assert.equal(additions, removals);

  const preAborted = fixture(t, () => assert.fail('pre-aborted operation spawned'));
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  preAborted.client.workspaceRegistry.resolveOwnedId = () => assert.fail('pre-aborted operation touched the artifact registry');
  await assert.rejects(preAborted.client.run(request(), { signal: alreadyCancelled.signal }), error => error.code === 'CANCELLED');
  assert.equal(preAborted.calls.length, 0);

  const timeoutFixture = fixture(t, gracefulResponder, { deadlineOverrideMs: 5 });
  await assert.rejects(
    timeoutFixture.client.run(request(), {}),
    error => error.code === 'EXTRACTOR_UNAVAILABLE'
  );
  assert.equal(timeoutFixture.children[0]?.killed ?? false, false);
});

test('timeout closes a FileHandle acquired after the operation has already rejected', async (t) => {
  const f = fixture(t, () => assert.fail('a timed-out artifact open must not spawn a broker'), {
    deadlineOverrideMs: 5
  });
  const archivePath = path.join(f.workspaceRoot, f.inputDirectoryId, 'pack.zip');
  const originalOpen = fsp.open;
  let releaseOpen;
  let announceOpen;
  let lateHandle = null;
  const openStarted = new Promise(resolve => { announceOpen = resolve; });
  const openGate = new Promise(resolve => { releaseOpen = resolve; });
  fsp.open = async function delayedArtifactOpen(candidate, ...args) {
    if (path.resolve(String(candidate)) !== path.resolve(archivePath)) {
      return originalOpen.call(this, candidate, ...args);
    }
    announceOpen();
    await openGate;
    lateHandle = await originalOpen.call(this, candidate, ...args);
    return lateHandle;
  };
  t.after(async () => {
    fsp.open = originalOpen;
    await lateHandle?.close().catch(() => {});
  });

  const pending = f.client.run(request());
  await openStarted;
  await assert.rejects(pending, error => error.code === 'EXTRACTOR_UNAVAILABLE');
  releaseOpen();
  while (!lateHandle) await new Promise(resolve => setImmediate(resolve));

  await assertFileHandleCloses(lateHandle);
  assert.equal(f.calls.length, 0);
});

test('timeout after artifact stat never constructs a read stream with an aborted signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, () => assert.fail('a timed-out artifact stat must not spawn a broker'), {
    deadlineOverrideMs: 60_000
  });
  const archivePath = path.join(f.workspaceRoot, f.inputDirectoryId, 'pack.zip');
  const originalOpen = fsp.open;
  let releaseStat;
  let announceStat;
  let streamConstructions = 0;
  const statStarted = new Promise(resolve => { announceStat = resolve; });
  const statGate = new Promise(resolve => { releaseStat = resolve; });
  fsp.open = async function delayedArtifactStat(candidate, ...args) {
    const handle = await originalOpen.call(this, candidate, ...args);
    if (path.resolve(String(candidate)) !== path.resolve(archivePath)) return handle;
    const stat = handle.stat.bind(handle);
    const createReadStream = handle.createReadStream.bind(handle);
    let firstStat = true;
    handle.stat = async (...statArgs) => {
      if (firstStat) {
        firstStat = false;
        announceStat();
        await statGate;
      }
      return stat(...statArgs);
    };
    handle.createReadStream = (...streamArgs) => {
      streamConstructions += 1;
      return createReadStream(...streamArgs);
    };
    return handle;
  };
  t.after(() => { fsp.open = originalOpen; });

  const outcome = f.client.run(request()).then(() => 'resolved', error => error.code);
  await statStarted;
  t.mock.timers.tick(60_000);
  releaseStat();

  assert.equal(await outcome, 'EXTRACTOR_UNAVAILABLE');
  assert.equal(streamConstructions, 0);
  assert.equal(f.calls.length, 0);
});

test('the overall deadline includes runtime verification before broker spawn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let announceRuntimeVerification;
  const runtimeVerificationStarted = new Promise(resolve => { announceRuntimeVerification = resolve; });
  const f = fixture(t, () => assert.fail('deadline-expired verification spawned a broker'), {
    deadlineOverrideMs: 60_000,
    verifyRuntime: () => {
      announceRuntimeVerification();
      return new Promise(() => {});
    }
  });
  const outcome = f.client.run(request(), {}).then(() => 'resolved', error => error.code);

  await runtimeVerificationStarted;
  t.mock.timers.tick(60_000);

  assert.equal(await outcome, 'EXTRACTOR_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

test('the overall deadline remains authoritative after a synchronous registry stall', async (t) => {
  const f = fixture(t, () => assert.fail('deadline-expired registry lookup spawned a broker'), {
    deadlineOverrideMs: 5
  });
  f.registry.resolveOwnedId = () => {
    const end = performance.now() + 25;
    while (performance.now() < end) { /* model a trusted synchronous registry stall */ }
    throw new Error('registry unavailable after the deadline');
  };

  await assert.rejects(f.client.run(request(), {}), error => error.code === 'EXTRACTOR_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

test('cancellation during control-channel setup remains CANCELLED and never spawns', async (t) => {
  let announceSetup;
  const setupStarted = new Promise(resolve => { announceSetup = resolve; });
  const f = fixture(t, () => assert.fail('cancelled control setup spawned a broker'), {
    controlChannelFactory() {
      announceSetup();
      return new Promise(() => {});
    }
  });
  const controller = new AbortController();
  const pending = f.client.run(request(), { signal: controller.signal });
  await setupStarted;
  controller.abort();

  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(f.calls.length, 0);
  assert.equal(fs.readdirSync(path.join(f.root, 'app-owned', 'broker-bundles')).length, 0);
});

test('cancellation does not settle before worker close proves quiescence', async (t) => {
  const f = fixture(t, () => {}, { cleanupGraceMs: 5, forceCloseWaitMs: 1000 });
  const controller = new AbortController();
  let settled = false;
  const pending = f.client.run(request(), { signal: controller.signal }).finally(() => { settled = true; });
  const child = await f.spawned;
  child.kill = () => false;
  const extractionBlocker = f.calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fs.existsSync(extractionBlocker), true);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', null, 'SIGKILL');
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(fs.existsSync(extractionBlocker), true);
});

test('forced cancellation cannot settle before late worker close proves quiescence', async (t) => {
  const f = fixture(t, () => {}, { cleanupGraceMs: 5, forceCloseWaitMs: 5 });
  const controller = new AbortController();
  const pending = f.client.run(request(), { signal: controller.signal });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const child = await f.spawned;
  child.kill = () => { child.killed = true; child.killCount += 1; return false; };
  const extractionBlocker = f.calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 25));
  const settledBeforeClose = settled;
  assert.ok(child.killCount >= 1);
  assert.equal(fs.existsSync(extractionBlocker), true);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', null, 'SIGKILL');
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(settledBeforeClose, false);
  assert.equal(fs.existsSync(extractionBlocker), true);
});

test('archive operations use the verified worker file as their extraction blocker and create no broker journal', async (t) => {
  const f = fixture(t, (_bytes, child) => writeFrames(child, [goodStatus()]));

  await f.client.run(request());

  const extractionBlocker = f.calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  assert.equal(extractionBlocker.replace(/^\\\\\?\\/u, ''), path.join(f.root, 'worker.exe'));
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'app-owned', 'broker-bundles')), []);
});

test('startup recovery never treats recorded process IDs as deletion authority', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-bundle-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleParent = path.join(appOwnedRoot, 'broker-bundles');
  const stale = path.join(bundleParent, 'bundle-stale');
  const live = path.join(bundleParent, 'bundle-live');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(stale, '.minecraft-core-broker-bundle.json'), JSON.stringify({
    schemaVersion: 1, state: 'running', ownerPid: process.pid, brokerPid: 2147483647
  }));
  fs.writeFileSync(path.join(live, '.minecraft-core-broker-bundle.json'), JSON.stringify({
    schemaVersion: 1, state: 'running', ownerPid: process.pid, brokerPid: process.pid
  }));

  const client = new ArchiveWorkerClient({ resourcesRoot: root, appOwnedRoot });

  assert.equal(fs.existsSync(stale), true);
  assert.equal(fs.existsSync(live), true);
  assert.equal(client.recoveryDiagnostics.filter(item => item.kind === 'retained-broker-bundle-remnant').length, 2);
});

test('startup recovery retains interrupted legacy creation records regardless of owner PID', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-creating-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleParent = path.join(appOwnedRoot, 'broker-bundles');
  const stale = path.join(bundleParent, 'bundle-stale-creating');
  const live = path.join(bundleParent, 'bundle-live-creating');
  fs.mkdirSync(stale, { recursive: true });
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(stale, '.minecraft-core-broker-bundle.json'), JSON.stringify({
    schemaVersion: 1, state: 'creating', ownerPid: 2147483647
  }));
  fs.writeFileSync(path.join(live, '.minecraft-core-broker-bundle.json'), JSON.stringify({
    schemaVersion: 1, state: 'creating', ownerPid: process.pid
  }));

  recoverBrokerBundles(appOwnedRoot);

  assert.equal(fs.existsSync(stale), true);
  assert.equal(fs.existsSync(live), true);
});

test('broker recovery accepts another cleanup removing the whole bundle before journal inspection', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-concurrent-inspection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleRoot = path.join(appOwnedRoot, 'broker-bundles', 'bundle-concurrent');
  const journalPath = path.join(bundleRoot, '.minecraft-core-broker-bundle.json');
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.writeFileSync(journalPath, JSON.stringify({
    schemaVersion: 1, state: 'creating', ownerPid: 2147483647
  }));

  const originalLstatSync = fs.lstatSync;
  let removed = false;
  fs.lstatSync = function concurrentLstat(candidate, ...args) {
    if (!removed && path.resolve(String(candidate)) === path.resolve(journalPath)) {
      removed = true;
      fs.rmSync(bundleRoot, { recursive: true, force: false });
    }
    return originalLstatSync.call(this, candidate, ...args);
  };
  t.after(() => { fs.lstatSync = originalLstatSync; });

  assert.doesNotThrow(() => recoverBrokerBundles(appOwnedRoot));
  assert.equal(removed, true, 'the concurrent cleanup race must be exercised');
  assert.equal(fs.existsSync(bundleRoot), false);
});

test('broker recovery retains directory-only cleanup remnants in place', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-empty-remnant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleRoot = path.join(appOwnedRoot, 'broker-bundles', 'bundle-interrupted-cleanup');
  fs.mkdirSync(path.join(bundleRoot, 'ArchiveWorker', 'extraction-id'), { recursive: true });

  assert.doesNotThrow(() => recoverBrokerBundles(appOwnedRoot));
  assert.equal(fs.existsSync(bundleRoot), true);
});

test('durable startup retains a journal-less extracted-runtime crash remnant and reports it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-broker-remnant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managedRoot = path.join(root, 'managed');
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleRoot = path.join(appOwnedRoot, 'broker-bundles', 'bundle-crashed-cleanup');
  const retainedFile = path.join(bundleRoot, 'ArchiveWorker', 'extraction-id', 'ArchiveWorker.dll');
  fs.mkdirSync(path.dirname(retainedFile), { recursive: true });
  fs.mkdirSync(managedRoot);
  fs.writeFileSync(retainedFile, Buffer.from([0x4d, 0x5a, 0x01, 0x02]));

  assert.doesNotThrow(() => new WindowsDurableFsClient({
    workerPath: 'worker.exe',
    workerManifestPath: 'worker.json',
    allowedRoots: [managedRoot],
    appOwnedRoot,
    verifyWorker: () => {}
  }));

  assert.equal(fs.existsSync(bundleRoot), true, 'startup preserves the untrusted remnant in place');
  assert.deepEqual(
    fs.readFileSync(retainedFile),
    Buffer.from([0x4d, 0x5a, 0x01, 0x02]),
    'recovery preserves rather than trusts, moves, or deletes unknown bytes'
  );
});

test('failed broker cleanup retains its journal while extracted content remains', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-journal-last-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const { bundleParent, bundleRoot } = createBrokerBundle(appOwnedRoot);
  const extractedRoot = path.join(bundleRoot, 'ArchiveWorker');
  const journalPath = path.join(bundleRoot, '.minecraft-core-broker-bundle.json');
  fs.mkdirSync(extractedRoot);
  fs.writeFileSync(path.join(extractedRoot, 'ArchiveWorker.dll'), 'locked-runtime');

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = function interruptedCleanup(candidate, ...args) {
    const resolved = path.resolve(String(candidate));
    if (resolved === path.resolve(path.join(extractedRoot, 'ArchiveWorker.dll'))) {
      throw Object.assign(new Error('simulated locked extracted runtime'), { code: 'EBUSY' });
    }
    return originalUnlinkSync.call(this, candidate, ...args);
  };
  try {
    if (process.platform === 'win32') {
      assert.deepEqual(removeBrokerBundle(bundleParent, bundleRoot), {
        removed: false,
        retained: true,
        reason: 'windows-pathname-cleanup-disabled'
      });
    } else {
      assert.throws(() => removeBrokerBundle(bundleParent, bundleRoot), error => error.code === 'EBUSY');
    }
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'creating');
  assert.equal(fs.readFileSync(path.join(extractedRoot, 'ArchiveWorker.dll'), 'utf8'), 'locked-runtime');
});

test('broker cleanup refuses arbitrary contents behind a malformed journal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-forged-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundleParent = path.join(root, 'app-owned', 'broker-bundles');
  const bundleRoot = path.join(bundleParent, 'bundle-forged');
  const payload = path.join(bundleRoot, 'untrusted.bin');
  const journalPath = path.join(bundleRoot, '.minecraft-core-broker-bundle.json');
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.writeFileSync(payload, 'preserve');
  fs.writeFileSync(journalPath, '{"schemaVersion":1,"state":"creating"');

  assert.throws(
    () => removeBrokerBundle(bundleParent, bundleRoot),
    error => error.code === 'EXTRACTOR_UNAVAILABLE'
  );
  assert.equal(fs.readFileSync(payload, 'utf8'), 'preserve');
  assert.equal(fs.readFileSync(journalPath, 'utf8'), '{"schemaVersion":1,"state":"creating"');
});

test('broker recovery performs no file or directory mutation on retained remnants', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-remnant-no-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleRoot = path.join(appOwnedRoot, 'broker-bundles', 'bundle-retained');
  const leaf = path.join(bundleRoot, 'ArchiveWorker');
  fs.mkdirSync(leaf, { recursive: true });
  fs.writeFileSync(path.join(leaf, 'payload.bin'), 'preserve');

  const originalRmSync = fs.rmSync;
  const originalRenameSync = fs.renameSync;
  const originalRmdirSync = fs.rmdirSync;
  const originalUnlinkSync = fs.unlinkSync;
  let mutations = 0;
  fs.rmSync = function countedRm(...args) { mutations += 1; return originalRmSync.apply(this, args); };
  fs.renameSync = function countedRename(...args) { mutations += 1; return originalRenameSync.apply(this, args); };
  fs.rmdirSync = function countedRmdir(...args) { mutations += 1; return originalRmdirSync.apply(this, args); };
  fs.unlinkSync = function countedUnlink(...args) { mutations += 1; return originalUnlinkSync.apply(this, args); };
  try {
    assert.doesNotThrow(() => recoverBrokerBundles(appOwnedRoot));
  } finally {
    fs.rmSync = originalRmSync;
    fs.renameSync = originalRenameSync;
    fs.rmdirSync = originalRmdirSync;
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(mutations, 0);
  assert.equal(fs.readFileSync(path.join(leaf, 'payload.bin'), 'utf8'), 'preserve');
});

test('broker recovery reports malformed or unauthorised journals without blocking startup', (t) => {
  const cases = [
    ['malformed', '{"schemaVersion":1,"state":"creating"'],
    ['unknown-shape', JSON.stringify({ schemaVersion: 1, state: 'creating', ownerPid: 2147483647, extra: true })]
  ];

  for (const [label, journal] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-broker-unknown-${label}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const appOwnedRoot = path.join(root, 'app-owned');
    const bundleRoot = path.join(appOwnedRoot, 'broker-bundles', `bundle-${label}`);
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, '.minecraft-core-broker-bundle.json'), journal);

    assert.doesNotThrow(() => recoverBrokerBundles(appOwnedRoot), label);
    assert.equal(fs.existsSync(bundleRoot), true, `${label} remains untouched without deletion authority`);
    assert.equal(fs.existsSync(createBrokerBundle(appOwnedRoot).bundleRoot), true, `${label} does not block new work`);
  }
});

test('broker recovery bounds diagnostics without letting more than 128 remnants block creation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-bounded-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleParent = path.join(appOwnedRoot, 'broker-bundles');
  fs.mkdirSync(bundleParent, { recursive: true });
  for (let index = 0; index < 129; index += 1) {
    const bundleRoot = path.join(bundleParent, `bundle-stale-${String(index).padStart(3, '0')}`);
    fs.mkdirSync(bundleRoot);
    fs.writeFileSync(path.join(bundleRoot, '.minecraft-core-broker-bundle.json'), JSON.stringify({
      schemaVersion: 1, state: 'creating', ownerPid: 2147483647
    }));
  }

  const created = createBrokerBundle(appOwnedRoot);
  assert.equal(fs.existsSync(created.bundleRoot), true);
  assert.equal(fs.readdirSync(bundleParent).length, 130);
  if (process.platform === 'win32') {
    removeBrokerBundle(created.bundleParent, created.bundleRoot);
    const diagnostics = getBrokerBundleRecoveryDiagnostics(appOwnedRoot);
    assert.ok(diagnostics.length <= 129);
    assert.equal(diagnostics.some(item => item.reason === 'retention-diagnostics-truncated'), true);
  }
});

test('running transition never opens a hardlink-swapped creation journal for mutation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-hardlink-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const { bundleRoot } = createBrokerBundle(appOwnedRoot);
  const journalPath = path.join(bundleRoot, '.minecraft-core-broker-bundle.json');
  const outsidePath = path.join(root, 'outside-hardlink.txt');
  fs.writeFileSync(outsidePath, 'outside-hardlink-bytes');
  fs.unlinkSync(journalPath);
  fs.linkSync(outsidePath, journalPath);

  assert.throws(
    () => markBrokerBundleRunning(bundleRoot, 424242),
    error => error.code === 'EXTRACTOR_UNAVAILABLE'
  );
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside-hardlink-bytes');
});

test('running transition never follows a symlink-swapped creation journal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-symlink-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const { bundleRoot } = createBrokerBundle(appOwnedRoot);
  const journalPath = path.join(bundleRoot, '.minecraft-core-broker-bundle.json');
  const outsidePath = path.join(root, 'outside-symlink.txt');
  fs.writeFileSync(outsidePath, 'outside-symlink-bytes');
  fs.unlinkSync(journalPath);
  try {
    fs.symlinkSync(outsidePath, journalPath, 'file');
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    fs.unlinkSync(outsidePath);
    fs.mkdirSync(outsidePath);
    fs.writeFileSync(path.join(outsidePath, 'sentinel.txt'), 'outside-symlink-bytes');
    fs.symlinkSync(outsidePath, journalPath, 'junction');
  }

  assert.throws(
    () => markBrokerBundleRunning(bundleRoot, 424242),
    error => error.code === 'EXTRACTOR_UNAVAILABLE'
  );
  const outsideStat = fs.lstatSync(outsidePath);
  assert.equal(
    fs.readFileSync(outsideStat.isDirectory() ? path.join(outsidePath, 'sentinel.txt') : outsidePath, 'utf8'),
    'outside-symlink-bytes'
  );
});

test('a partial creation record is retained diagnostically and cannot block the next bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-partial-create-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  let creationDescriptor = null;
  fs.openSync = function captureCreationDescriptor(candidate, flags, ...args) {
    const descriptor = originalOpenSync.call(this, candidate, flags, ...args);
    if (path.basename(String(candidate)) === '.minecraft-core-broker-bundle.json' && flags === 'wx') {
      creationDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.writeFileSync = function truncateCreationRecord(candidate, bytes, ...args) {
    if (candidate === creationDescriptor) {
      originalWriteFileSync.call(this, candidate, Buffer.from(bytes).subarray(0, 9), ...args);
      throw Object.assign(new Error('simulated power loss during creation record'), { code: 'EIO' });
    }
    return originalWriteFileSync.call(this, candidate, bytes, ...args);
  };
  try {
    assert.throws(() => createBrokerBundle(appOwnedRoot), error => error?.code === 'EIO');
  } finally {
    fs.openSync = originalOpenSync;
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.doesNotThrow(() => recoverBrokerBundles(appOwnedRoot));
  const next = createBrokerBundle(appOwnedRoot);
  assert.equal(fs.existsSync(next.bundleRoot), true);
});

test('a ChangeTime-only journal transition does not reject an otherwise unchanged broker bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-ctime-transition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const originalFstatSync = fs.fstatSync;
  let injected = false;
  fs.fstatSync = function injectAdvisoryChangeTime(descriptor, ...args) {
    const stat = originalFstatSync.call(this, descriptor, ...args);
    if (injected || typeof stat.ctimeNs !== 'bigint' || !stat.isFile()) return stat;
    injected = true;
    const drifted = Object.create(stat);
    Object.defineProperty(drifted, 'ctimeNs', {
      configurable: true,
      enumerable: true,
      value: stat.ctimeNs + 1n
    });
    return drifted;
  };

  let created;
  try {
    assert.doesNotThrow(() => { created = createBrokerBundle(appOwnedRoot); });
  } finally {
    fs.fstatSync = originalFstatSync;
  }

  assert.equal(injected, true, 'the test must exercise a ChangeTime-only transition');
  assert.equal(fs.existsSync(created.bundleRoot), true);
});

test('an mtime journal transition still rejects a changed broker bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-mtime-transition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const originalFstatSync = fs.fstatSync;
  let injected = false;
  fs.fstatSync = function injectMaterialMtimeChange(descriptor, ...args) {
    const stat = originalFstatSync.call(this, descriptor, ...args);
    if (injected || typeof stat.mtimeNs !== 'bigint' || !stat.isFile()) return stat;
    injected = true;
    const drifted = Object.create(stat);
    Object.defineProperty(drifted, 'mtimeNs', {
      configurable: true,
      enumerable: true,
      value: stat.mtimeNs + 1n
    });
    return drifted;
  };

  try {
    assert.throws(
      () => createBrokerBundle(appOwnedRoot),
      error => error?.code === 'EXTRACTOR_UNAVAILABLE'
    );
  } finally {
    fs.fstatSync = originalFstatSync;
  }
  assert.equal(injected, true, 'the control must exercise an mtime transition');
});

test('a settled ChangeTime-only journal transition does not block the running record', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-running-ctime-transition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const created = createBrokerBundle(appOwnedRoot);
  const journalPath = path.join(created.bundleRoot, '.minecraft-core-broker-bundle.json');
  const originalLstatSync = fs.lstatSync;
  let injections = 0;
  fs.lstatSync = function injectSettledAdvisoryChangeTime(candidate, ...args) {
    const stat = originalLstatSync.call(this, candidate, ...args);
    if (path.resolve(String(candidate)) !== path.resolve(journalPath) || typeof stat.ctimeNs !== 'bigint') return stat;
    injections += 1;
    const drifted = Object.create(stat);
    Object.defineProperty(drifted, 'ctimeNs', {
      configurable: true,
      enumerable: true,
      value: stat.ctimeNs + 1n
    });
    return drifted;
  };

  try {
    assert.doesNotThrow(() => markBrokerBundleRunning(created.bundleRoot, 424242));
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.ok(injections >= 2, 'the immutable journal must be revalidated across the transition');
  assert.deepEqual(JSON.parse(fs.readFileSync(journalPath, 'utf8')), {
    schemaVersion: 2,
    state: 'creating',
    bundleId: created.bundleId,
    ownerPid: process.pid
  });
  assert.equal(fs.existsSync(path.join(created.bundleRoot, '.minecraft-core-broker-bundle.running.json')), true);
});

test('a partial immutable running record leaves the creation record intact and startup usable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-partial-running-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundle = createBrokerBundle(appOwnedRoot);
  const creationPath = path.join(bundle.bundleRoot, '.minecraft-core-broker-bundle.json');
  const creationBytes = fs.readFileSync(creationPath);
  const runningPath = path.join(bundle.bundleRoot, '.minecraft-core-broker-bundle.running.json');
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  let runningDescriptor = null;
  fs.openSync = function captureRunningDescriptor(candidate, flags, ...args) {
    const descriptor = originalOpenSync.call(this, candidate, flags, ...args);
    if (path.resolve(String(candidate)) === path.resolve(runningPath) && flags === 'wx') runningDescriptor = descriptor;
    return descriptor;
  };
  fs.writeFileSync = function truncateRunningRecord(candidate, bytes, ...args) {
    if (candidate === runningDescriptor) {
      originalWriteFileSync.call(this, candidate, Buffer.from(bytes).subarray(0, 11), ...args);
      throw Object.assign(new Error('simulated power loss during running record'), { code: 'EIO' });
    }
    return originalWriteFileSync.call(this, candidate, bytes, ...args);
  };
  try {
    assert.throws(() => markBrokerBundleRunning(bundle.bundleRoot, 424242), error => error?.code === 'EIO');
  } finally {
    fs.openSync = originalOpenSync;
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.deepEqual(fs.readFileSync(creationPath), creationBytes);
  assert.ok(fs.statSync(runningPath).size > 0);
  assert.doesNotThrow(() => recoverBrokerBundles(appOwnedRoot));
  assert.equal(fs.existsSync(createBrokerBundle(appOwnedRoot).bundleRoot), true);
});

test('a shape-valid forged broker journal never authorizes recursive deletion', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-valid-forgery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundleParent = path.join(root, 'app-owned', 'broker-bundles');
  const bundleRoot = path.join(bundleParent, 'bundle-forged-valid');
  const payload = path.join(bundleRoot, 'untrusted.bin');
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.writeFileSync(payload, 'preserve');
  fs.writeFileSync(path.join(bundleRoot, '.minecraft-core-broker-bundle.json'), JSON.stringify({
    schemaVersion: 1,
    state: 'creating',
    ownerPid: 2147483647
  }));

  assert.throws(
    () => removeBrokerBundle(bundleParent, bundleRoot),
    error => error.code === 'EXTRACTOR_UNAVAILABLE'
  );
  assert.equal(fs.readFileSync(payload, 'utf8'), 'preserve');
});

test('same-process cleanup revalidates a file parent before unlinking through a junction swap', (t) => {
  if (process.platform === 'win32') { t.skip('Windows bundles are retention-only and never reach pathname cleanup'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-cleanup-parent-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundle = createBrokerBundle(appOwnedRoot);
  const nested = path.join(bundle.bundleRoot, 'ArchiveWorker');
  const displaced = path.join(root, 'displaced-ArchiveWorker');
  const payload = path.join(nested, 'runtime.bin');
  fs.mkdirSync(nested);
  fs.writeFileSync(payload, 'outside-must-survive');

  const originalLstatSync = fs.lstatSync;
  let payloadCaptured = false;
  let swapped = false;
  fs.lstatSync = function swapParentAfterCapture(candidate, ...args) {
    const resolved = path.resolve(String(candidate));
    if (resolved === path.resolve(payload) && !payloadCaptured) payloadCaptured = true;
    if (!swapped && payloadCaptured && resolved === path.resolve(bundle.bundleRoot)) {
      fs.renameSync(nested, displaced);
      fs.symlinkSync(displaced, nested, 'junction');
      swapped = true;
    }
    return originalLstatSync.call(this, candidate, ...args);
  };
  try {
    assert.throws(
      () => removeBrokerBundle(bundle.bundleParent, bundle.bundleRoot),
      error => error.code === 'EXTRACTOR_UNAVAILABLE'
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(swapped, true, 'the parent swap must occur after tree capture and before unlink');
  assert.equal(fs.readFileSync(path.join(displaced, 'runtime.bin'), 'utf8'), 'outside-must-survive');
});

test('Windows broker cleanup never invokes pathname deletion that can be swapped immediately before unlink', (t) => {
  if (process.platform !== 'win32') { t.skip('Windows pathname cleanup policy'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-final-unlink-swap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundle = createBrokerBundle(appOwnedRoot);
  const nested = path.join(bundle.bundleRoot, 'ArchiveWorker');
  const displaced = path.join(root, 'displaced-ArchiveWorker');
  const payload = path.join(nested, 'runtime.bin');
  fs.mkdirSync(nested);
  fs.writeFileSync(payload, 'external-file-must-survive');

  const originalUnlinkSync = fs.unlinkSync;
  const originalRmdirSync = fs.rmdirSync;
  let pathnameUnlinks = 0;
  let pathnameRmdirs = 0;
  let swapped = false;
  fs.unlinkSync = function swapImmediatelyBeforeUnlink(candidate, ...args) {
    pathnameUnlinks += 1;
    if (!swapped && path.resolve(String(candidate)) === path.resolve(payload)) {
      fs.renameSync(nested, displaced);
      fs.symlinkSync(displaced, nested, 'junction');
      swapped = true;
    }
    return originalUnlinkSync.call(this, candidate, ...args);
  };
  fs.rmdirSync = function countPathnameRmdir(candidate, ...args) {
    pathnameRmdirs += 1;
    return originalRmdirSync.call(this, candidate, ...args);
  };
  let result;
  try {
    assert.doesNotThrow(() => { result = removeBrokerBundle(bundle.bundleParent, bundle.bundleRoot); });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    fs.rmdirSync = originalRmdirSync;
  }

  assert.deepEqual(result, {
    removed: false,
    retained: true,
    reason: 'windows-pathname-cleanup-disabled'
  });
  assert.equal(pathnameUnlinks, 0, 'Windows cleanup must not reach a pathname unlink primitive');
  assert.equal(pathnameRmdirs, 0, 'Windows cleanup must not reach a pathname rmdir primitive');
  assert.equal(swapped, false, 'there is no final pathname unlink point for an attacker to race');
  assert.equal(fs.readFileSync(payload, 'utf8'), 'external-file-must-survive');
});

test('Windows client completes without creating a retained runtime bundle', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows extraction blocker'); return; }
  const f = fixture(t, (_bytes, child) => writeFrames(child, [goodStatus()]));

  await f.client.run(request());

  assert.deepEqual(fs.readdirSync(path.join(f.root, 'app-owned', 'broker-bundles')), []);
  assert.equal(f.client.recoveryDiagnostics.some(item => item.reason === 'windows-pathname-cleanup-disabled'), false);
});

test('startup leaves an untrusted remnant in place when the old quarantine name is a junction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-quarantine-junction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleRoot = path.join(appOwnedRoot, 'broker-bundles', 'bundle-untrusted');
  const payload = path.join(bundleRoot, 'payload.bin');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(payload, 'retained');
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside');
  try {
    fs.symlinkSync(outside, path.join(appOwnedRoot, 'quarantined-broker-bundles'), 'junction');
  } catch (error) {
    if (error?.code === 'EPERM') { t.skip('junctions are unavailable on this Windows host'); return; }
    throw error;
  }

  assert.doesNotThrow(() => recoverBrokerBundles(appOwnedRoot));
  assert.equal(fs.readFileSync(payload, 'utf8'), 'retained');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
});

test('malformed retained records surface diagnostics without permanently blocking startup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-broker-malformed-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOwnedRoot = path.join(root, 'app-owned');
  const bundleRoot = path.join(appOwnedRoot, 'broker-bundles', 'bundle-malformed-retained');
  fs.mkdirSync(bundleRoot, { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, '.minecraft-core-broker-bundle.json'), '{"schemaVersion":2');
  fs.writeFileSync(path.join(bundleRoot, 'payload.bin'), 'retained');

  const client = new ArchiveWorkerClient({ resourcesRoot: root, appOwnedRoot });

  assert.equal(fs.readFileSync(path.join(bundleRoot, 'payload.bin'), 'utf8'), 'retained');
  assert.equal(Array.isArray(client.recoveryDiagnostics), true);
  assert.equal(client.recoveryDiagnostics.some(item =>
    item.kind === 'retained-broker-bundle-remnant' && item.bundleName === 'bundle-malformed-retained'
  ), true);
  assert.equal(fs.existsSync(createBrokerBundle(appOwnedRoot).bundleRoot), true);
});

test('callback failures cancel safely and delivered text is deeply frozen and redacted', async (t) => {
  const secret = 'C:\\Users\\person\\secret\\pack.zip';
  const diagnostic = `failed at ${secret} password=hunter2`;
  const f = fixture(t, (_bytes, child) => writeFrames(child, [
    { type: 'stderr', text: diagnostic },
    goodStatus({ metrics: { stdoutBytes: '0', stderrBytes: String(Buffer.byteLength(diagnostic)), dataBytes: '0', elapsedMs: 1 } })
  ]));
  let delivered;
  await f.client.run(request(), { onFrame(frame) { delivered = frame; } });
  assert.equal(Object.isFrozen(delivered), true);
  assert.doesNotMatch(delivered.text, /person|hunter2|password=/i);

  const callbackFailure = fixture(t, (_bytes, child) => writeFrames(child, [
    { type: 'stdout', text: 'safe' }, goodStatus()
  ]));
  await assert.rejects(
    callbackFailure.client.run(request(), { onFrame() { throw new Error('private callback details'); } }),
    error => error.code === 'EXTRACTOR_FAILED' && !error.message.includes('private')
  );
  assert.equal(callbackFailure.children[0].killed, false, 'the broker close remains authoritative for cleanup');
});

test('maps only reviewed worker errors and never exposes native diagnostics', async (t) => {
  const f = fixture(t, (_bytes, child) => writeFrames(child, [goodStatus({
    ok: false,
    exitCode: 2,
    errorCode: 'ENCRYPTED_ARCHIVE'
  })]));
  await assert.rejects(
    f.client.run(request(), {}),
    error => error.code === 'ENCRYPTED_ARCHIVE' && !/7z|path|native/i.test(error.message)
  );
});

test('containment failure has no plain-process fallback', async (t) => {
  const plainCalls = [];
  const f = fixture(t, () => assert.fail('sandbox worker must not start after verification failure'));
  f.client.verifyWorker = async () => { throw new Error('containment unavailable C:\\secret'); };
  f.client.plainProcessSpawn = (...args) => plainCalls.push(args);
  await assert.rejects(f.client.run(request(), {}), error => error.code === 'EXTRACTOR_UNAVAILABLE');
  assert.equal(plainCalls.length, 0);
  assert.equal(f.calls.length, 0);
});

function syntheticWorkerFixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workerPath = path.join(root, 'ArchiveWorker.exe');
  const workerManifestPath = path.join(root, 'archive-worker-x64.json');
  const bytes = Buffer.alloc(3 * 1024 * 1024, 0x5a);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  fs.writeFileSync(workerPath, bytes);
  fs.writeFileSync(workerManifestPath, JSON.stringify({
    schemaVersion: 2,
    architecture: 'x64',
    runtimeIdentifier: 'win-x64',
    targetFramework: 'net8.0-windows',
    sdkVersion: '10.0.204',
    runtimeMode: 'in-memory-single-file',
    files: {
      'ArchiveWorker.exe': {
        size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    }
  }));
  bytes.fill(0);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workerPath, workerManifestPath };
}

test('sync worker verification streams the executable without a whole-file read', (t) => {
  const fixture = syntheticWorkerFixture(t, 'minecraft-worker-sync-stream-');
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function guardedRead(candidate, ...args) {
    if (path.resolve(String(candidate)) === path.resolve(fixture.workerPath)) {
      throw new Error('whole executable reads are forbidden');
    }
    return originalReadFileSync.call(this, candidate, ...args);
  };
  let verified;
  try {
    verified = verifyArchiveWorkerExecutableSync(fixture);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(verified.file.size, 3 * 1024 * 1024);
});

function installSyntheticWorkerCtimeRace(t, fixture, { raceEveryHashPass = false } = {}) {
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalLstatSync = fs.lstatSync;
  const originalFstatSync = fs.fstatSync;
  const workerKey = path.resolve(fixture.workerPath);
  let workerDescriptor = null;
  let ctimeEpoch = 0n;
  let hashPasses = 0;
  let opens = 0;
  const withEpoch = stat => {
    const observedEpoch = ctimeEpoch;
    return new Proxy(stat, {
      get(target, key, receiver) {
        if (key === 'ctimeNs') return target.ctimeNs + observedEpoch;
        return Reflect.get(target, key, receiver);
      }
    });
  };
  fs.openSync = function trackedOpen(candidate, ...args) {
    const descriptor = originalOpenSync.call(this, candidate, ...args);
    if (path.resolve(String(candidate)) === workerKey) {
      workerDescriptor = descriptor;
      opens += 1;
    }
    return descriptor;
  };
  fs.lstatSync = function racedLstat(candidate, ...args) {
    const stat = originalLstatSync.call(this, candidate, ...args);
    return path.resolve(String(candidate)) === workerKey ? withEpoch(stat) : stat;
  };
  fs.fstatSync = function racedFstat(descriptor, ...args) {
    const stat = originalFstatSync.call(this, descriptor, ...args);
    return descriptor === workerDescriptor ? withEpoch(stat) : stat;
  };
  fs.readSync = function racedRead(descriptor, buffer, offset, length, position) {
    const count = originalReadSync.call(this, descriptor, buffer, offset, length, position);
    if (descriptor === workerDescriptor && length === 1024 * 1024 && position === 0) {
      hashPasses += 1;
      if (hashPasses === 1 || raceEveryHashPass) ctimeEpoch += 1n;
    }
    return count;
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.lstatSync = originalLstatSync;
    fs.fstatSync = originalFstatSync;
  });
  return {
    get hashPasses() { return hashPasses; },
    get opens() { return opens; }
  };
}

test('sync worker verification rechecks one settled ctime-only metadata race', (t) => {
  const fixture = syntheticWorkerFixture(t, 'minecraft-worker-sync-ctime-settled-');
  const race = installSyntheticWorkerCtimeRace(t, fixture);

  const verified = verifyArchiveWorkerExecutableSync(fixture);

  assert.equal(verified.file.size, 3 * 1024 * 1024);
  assert.equal(race.hashPasses, 2, 'the pinned executable must be fully hashed again');
  assert.equal(race.opens, 1, 'the verified descriptor must remain pinned across the recheck');
});

test('sync worker verification fails closed when ctime changes during the recheck', (t) => {
  const fixture = syntheticWorkerFixture(t, 'minecraft-worker-sync-ctime-churn-');
  const race = installSyntheticWorkerCtimeRace(t, fixture, { raceEveryHashPass: true });

  assert.throws(
    () => verifyArchiveWorkerExecutableSync(fixture),
    error => error.code === 'EXTRACTOR_UNAVAILABLE'
  );
  assert.equal(race.hashPasses, 2, 'persistent churn gets one bounded recheck only');
  assert.equal(race.opens, 1, 'the verifier must not reopen onto a replacement path');
});

test('sync worker verification rejects path substitution while its verified descriptor is open', (t) => {
  const fixture = syntheticWorkerFixture(t, 'minecraft-worker-sync-race-');
  const displaced = path.join(fixture.root, 'displaced.exe');
  const originalReadSync = fs.readSync;
  let substituted = false;
  fs.readSync = function substitutingRead(...args) {
    const bytesRead = originalReadSync.apply(this, args);
    if (!substituted && bytesRead > 0) {
      fs.renameSync(fixture.workerPath, displaced);
      fs.copyFileSync(displaced, fixture.workerPath);
      substituted = true;
    }
    return bytesRead;
  };
  try {
    assert.throws(
      () => verifyArchiveWorkerExecutableSync(fixture),
      error => error.code === 'EXTRACTOR_UNAVAILABLE'
    );
  } finally {
    fs.readSync = originalReadSync;
  }
  assert.equal(substituted, true);
});

test('durable client rejects roots and device aliases before spawn and uses the worker file as its fail-closed extraction blocker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [path.parse(root).root], verifyWorker: () => {}
  }), error => error.code === 'COMMIT_FAILED');

  const excessiveRoots = Array.from({ length: 17 }, (_, index) => {
    const value = path.join(root, `owned-${index}`);
    fs.mkdirSync(value);
    return value;
  });
  assert.throws(() => new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: excessiveRoots,
    appOwnedRoot: path.join(root, 'excessive-app-owned'), verifyWorker: () => {}
  }), error => error.code === 'COMMIT_FAILED');

  const source = path.join(root, 'source.txt');
  fs.writeFileSync(source, 'source');
  const calls = [];
  const appOwnedRoot = path.join(root, 'app-owned');
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [root], appOwnedRoot,
    verifyWorker: () => {},
    spawnSync(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0, signal: null, error: null, stderr: Buffer.alloc(0), stdout: encodeFrame({ ok: true }) };
    }
  });
  for (const name of ['CON.txt', 'COM¹.log', 'normal\\LPT9.json']) {
    assert.throws(() => client.moveWriteThrough(source, path.join(root, name)), error => error.code === 'COMMIT_FAILED');
  }
  assert.equal(calls.length, 0);
  client.moveWriteThrough(source, path.join(root, 'moved.txt'));
  assert.equal(calls.length, 1);
  const framedRequest = calls[0].options.input;
  const nativeRequest = JSON.parse(framedRequest.subarray(4, 4 + framedRequest.readUInt32LE(0)).toString('utf8'));
  assert.deepEqual(Object.keys(nativeRequest).sort(), [
    'allowedRootIdentities', 'allowedRoots', 'destinationParentIdentity', 'destinationPath', 'operation',
    'sourceIdentity', 'sourcePath'
  ]);
  assert.deepEqual(Object.keys(nativeRequest.sourceIdentity).sort(), ['birthtime', 'ctime', 'dev', 'fileType', 'ino', 'mtime', 'sha256', 'size']);
  assert.equal(nativeRequest.sourceIdentity.fileType, 'file');
  assert.equal(nativeRequest.sourceIdentity.sha256, crypto.createHash('sha256').update('source').digest('hex'));
  assert.equal(nativeRequest.destinationParentIdentity.fileType, 'directory');
  assert.equal(nativeRequest.allowedRootIdentities.length, 1);
  assert.equal(nativeRequest.allowedRootIdentities[0].path, path.resolve(root));
  const extractionBlocker = calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  assert.match(extractionBlocker, /^\\\\\?\\/u);
  assert.equal(extractionBlocker.replace(/^\\\\\?\\/u, ''), path.resolve('worker.exe'));
  assert.deepEqual(fs.readdirSync(path.join(appOwnedRoot, 'broker-bundles')), []);
  assert.equal(client.recoveryDiagnostics.some(item => item.reason === 'windows-pathname-cleanup-disabled'), false);
});

test('durable client exposes only reviewed closed failure kinds from exact status-zero native frames', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-failure-kind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  fs.writeFileSync(source, 'source');
  const failureKinds = [
    'sharing-violation',
    'access-denied',
    'timeout',
    'integrity-failure',
    'io-failure',
    'worker-failure'
  ];
  let responseIndex = 0;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe',
    workerManifestPath: 'worker.json',
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'app-owned'),
    verifyWorker: () => {},
    spawnSync() {
      const failureKind = failureKinds[responseIndex++];
      return {
        status: 0,
        signal: null,
        error: null,
        stderr: Buffer.alloc(0),
        stdout: encodeFrame({ ok: false, failureKind, failureStage: 'request' })
      };
    }
  });

  for (const failureKind of failureKinds) {
    assert.throws(
      () => client.moveWriteThrough(source, destination),
      error => {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'durableFailureKind');
        return error.code === 'COMMIT_FAILED' &&
          error.message === 'Durable filesystem operation failed' &&
          error.durableFailureKind === failureKind &&
          error.durableFailureStage === 'request' &&
          descriptor?.value === failureKind && descriptor.enumerable === true &&
          descriptor.configurable === false && descriptor.writable === false;
      }
    );
  }
  assert.equal(responseIndex, failureKinds.length);
});

test('durable client exposes only reviewed closed failure stages from exact status-zero native frames', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-failure-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  fs.writeFileSync(source, 'source');
  const failureStages = [
    'root-open',
    'source-open',
    'destination-parent-open',
    'source-parent-open',
    'ancestor-open',
    'preflight-revalidation',
    'handle-rename',
    'completion-flush',
    'published-identity',
    'final-revalidation',
    'request'
  ];
  let responseIndex = 0;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [root],
    appOwnedRoot: path.join(root, 'app-owned'), verifyWorker: () => {},
    spawnSync() {
      const failureStage = failureStages[responseIndex++];
      return {
        status: 0, signal: null, error: null, stderr: Buffer.alloc(0),
        stdout: encodeFrame({ ok: false, failureKind: 'worker-failure', failureStage })
      };
    }
  });

  for (const failureStage of failureStages) {
    assert.throws(
      () => client.moveWriteThrough(source, destination),
      error => {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'durableFailureStage');
        return error.code === 'COMMIT_FAILED' && error.durableFailureKind === 'worker-failure' &&
          error.durableFailureStage === failureStage && descriptor?.value === failureStage &&
          descriptor.enumerable === true && descriptor.configurable === false && descriptor.writable === false;
      }
    );
  }
  assert.equal(responseIndex, failureStages.length);
});

test('durable client never retries an ambiguous handle-rename sharing violation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-sharing-no-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  fs.writeFileSync(source, 'source');
  let spawnCalls = 0;
  let delayCalls = 0;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe',
    workerManifestPath: 'worker.json',
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'app-owned'),
    verifyWorker: () => {},
    retrySleepSync() { delayCalls += 1; },
    spawnSync() {
      spawnCalls += 1;
      return {
        status: 0,
        signal: null,
        error: null,
        stderr: Buffer.alloc(0),
        stdout: encodeFrame({
          ok: false,
          failureKind: 'sharing-violation',
          failureStage: 'handle-rename'
        })
      };
    }
  });

  assert.throws(
    () => client.moveWriteThrough(source, destination),
    error => error.code === 'COMMIT_FAILED' && error.durableFailureKind === 'sharing-violation' &&
      error.durableFailureStage === 'handle-rename'
  );
  assert.equal(spawnCalls, 1);
  assert.equal(delayCalls, 0);
});

test('durable client rejects unknown, malformed, or diagnostic-bearing failure frames without leaking them', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-failure-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  fs.writeFileSync(source, 'source');
  const secret = 'C:\\private\\server-pack\\diagnostic-12345';
  const responses = [
    { ok: false, failureKind: 'unreviewed-native-code-12345', failureStage: 'request' },
    { ok: false, failureKind: 'sharing-violation', failureStage: 'request', diagnostic: secret },
    { ok: false, failureKind: 'sharing-violation', failureStage: 'unreviewed-stage-12345' },
    { ok: false, failureKind: 'sharing-violation' },
    { ok: false },
    { ok: true, failureKind: 'sharing-violation' },
    { ok: 'false', failureKind: 'sharing-violation' }
  ];
  let responseIndex = 0;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe',
    workerManifestPath: 'worker.json',
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'app-owned'),
    verifyWorker: () => {},
    spawnSync() {
      return {
        status: 0,
        signal: null,
        error: null,
        stderr: Buffer.alloc(0),
        stdout: encodeFrame(responses[responseIndex++])
      };
    }
  });

  for (let attempt = 0; attempt < responses.length; attempt += 1) {
    assert.throws(
      () => client.moveWriteThrough(source, destination),
      error => error.code === 'COMMIT_FAILED' &&
        error.message === 'Durable filesystem operation failed' &&
        error.durableFailureKind === undefined &&
        error.durableFailureStage === undefined &&
        !String(error).includes(secret) && !String(error).includes('12345')
    );
    assert.equal(responseIndex, attempt + 1);
  }
  assert.equal(responseIndex, responses.length);
});

test('durable timeout keeps the extraction blocker fixed to the worker and creates no bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  fs.writeFileSync(source, 'source');
  let extractionBlocker;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [root], appOwnedRoot: path.join(root, 'app-owned'),
    verifyWorker: () => {},
    spawnSync(_file, _args, options) {
      extractionBlocker = options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
      return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
  });
  assert.throws(() => client.moveWriteThrough(source, path.join(root, 'moved.txt')), error => error.code === 'COMMIT_FAILED');
  assert.equal(extractionBlocker.replace(/^\\\\\?\\/u, ''), path.resolve('worker.exe'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'app-owned', 'broker-bundles')), []);
});

test('durable client rejects caller-to-native source substitution and allowed-root replacement before spawn', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-identity-'));
  const root = path.join(parent, 'owned');
  const displaced = path.join(parent, 'displaced');
  const appOwnedRoot = path.join(parent, 'broker');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const source = path.join(root, 'source.bin');
  const destination = path.join(root, 'destination.bin');
  fs.writeFileSync(source, 'safe');
  const identity = stat => ({
    dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size),
    birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs),
    mtime: String(stat.mtimeNs ?? stat.mtimeMs), ctime: String(stat.ctimeNs ?? stat.ctimeMs)
  });
  const sourceExpectation = {
    ...identity(fs.lstatSync(source, { bigint: true })),
    sha256: crypto.createHash('sha256').update('safe').digest('hex')
  };
  const parentExpectation = identity(fs.lstatSync(root, { bigint: true }));
  let spawnCalls = 0;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [root], appOwnedRoot,
    verifyWorker: () => {}, spawnSync() { spawnCalls += 1; return {}; }
  });
  fs.writeFileSync(source, 'evil');
  assert.throws(
    () => client.moveWriteThrough(source, destination, { sourceIdentity: sourceExpectation, destinationParentIdentity: parentExpectation }),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.equal(spawnCalls, 0);

  fs.renameSync(root, displaced);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'replacement.bin'), 'same path, different root');
  assert.throws(
    () => client.moveWriteThrough(path.join(root, 'replacement.bin'), destination),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.equal(spawnCalls, 0);
});

test('durable client frames a bounded identity-bound directory batch in one native invocation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-batch-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first');
  const second = path.join(first, 'second');
  fs.mkdirSync(second, { recursive: true });
  const calls = [];
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe',
    workerManifestPath: 'worker.json',
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'app-owned'),
    verifyWorker: () => {},
    spawnSync(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0, signal: null, error: null, stderr: Buffer.alloc(0), stdout: encodeFrame({ ok: true }) };
    }
  });

  client.flushDirectories([second, first]);

  assert.equal(calls.length, 1);
  const framed = calls[0].options.input;
  const request = JSON.parse(framed.subarray(4, 4 + framed.readUInt32LE(0)).toString('utf8'));
  assert.deepEqual(Object.keys(request).sort(), ['allowedRootIdentities', 'allowedRoots', 'directories', 'operation']);
  assert.equal(request.operation, 'flush-directories');
  assert.deepEqual(request.directories.map(entry => entry.directoryPath), [path.resolve(second), path.resolve(first)]);
  assert.equal(request.directories.every(entry => entry.directoryIdentity.fileType === 'directory'), true);
  assert.equal(Object.isFrozen(client.capabilities), true);
  assert.deepEqual(client.capabilities, {
    deleteFileExactFlushesParent: true,
    moveWriteThroughFlushesParents: true,
    reconcileMoveWriteThrough: true
  });
});

test('durable client frames uncertain move reconciliation with the published object and both original parents', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-reconcile-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceParent = path.join(root, 'source-parent');
  const destinationParent = path.join(root, 'destination-parent');
  const source = path.join(sourceParent, 'candidate.bin');
  const destination = path.join(destinationParent, 'published.bin');
  fs.mkdirSync(sourceParent);
  fs.mkdirSync(destinationParent);
  fs.writeFileSync(destination, 'published bytes');
  const identity = stat => ({
    dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size),
    birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs),
    mtime: String(stat.mtimeNs ?? stat.mtimeMs), ctime: String(stat.ctimeNs ?? stat.ctimeMs)
  });
  const sourceIdentity = {
    ...identity(fs.lstatSync(destination, { bigint: true })),
    sha256: crypto.createHash('sha256').update('published bytes').digest('hex')
  };
  const sourceParentIdentity = identity(fs.lstatSync(sourceParent, { bigint: true }));
  const destinationParentIdentity = identity(fs.lstatSync(destinationParent, { bigint: true }));
  const calls = [];
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [root],
    appOwnedRoot: path.join(root, 'app-owned'), verifyWorker: () => {},
    spawnSync(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0, signal: null, error: null, stderr: Buffer.alloc(0), stdout: encodeFrame({ ok: true }) };
    }
  });

  client.reconcileMoveWriteThrough(source, destination, {
    sourceIdentity,
    sourceParentIdentity,
    destinationParentIdentity
  });

  assert.equal(calls.length, 1);
  const framed = calls[0].options.input;
  const request = JSON.parse(framed.subarray(4, 4 + framed.readUInt32LE(0)).toString('utf8'));
  assert.deepEqual(Object.keys(request).sort(), [
    'allowedRootIdentities', 'allowedRoots', 'destinationParentIdentity', 'destinationPath', 'operation',
    'sourceIdentity', 'sourceParentIdentity', 'sourcePath'
  ]);
  assert.equal(request.operation, 'reconcile-move-write-through');
  assert.equal(request.sourcePath, path.resolve(source));
  assert.equal(request.destinationPath, path.resolve(destination));
  assert.equal(request.sourceIdentity.sha256, sourceIdentity.sha256);
  assert.equal(request.sourceParentIdentity.fileType, 'directory');
  assert.equal(request.destinationParentIdentity.fileType, 'directory');
});

test('durable client never treats a dangling source reparse point as an absent reconciled name', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-reconcile-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'dangling-source');
  const destination = path.join(root, 'published');
  fs.mkdirSync(destination);
  try {
    fs.symlinkSync(path.join(root, 'missing-target'), source, 'junction');
  } catch (error) {
    if (error.code === 'EPERM') return;
    throw error;
  }
  const stat = fs.lstatSync(destination, { bigint: true });
  const identity = value => ({
    dev: String(value.dev), ino: String(value.ino), size: Number(value.size),
    birthtime: String(value.birthtimeNs ?? value.birthtimeMs),
    mtime: String(value.mtimeNs ?? value.mtimeMs), ctime: String(value.ctimeNs ?? value.ctimeMs)
  });
  let spawnCalls = 0;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [root],
    appOwnedRoot: path.join(root, 'app-owned'), verifyWorker: () => {},
    spawnSync() { spawnCalls += 1; return {}; }
  });

  assert.throws(
    () => client.reconcileMoveWriteThrough(source, destination, {
      sourceIdentity: identity(stat),
      sourceParentIdentity: identity(fs.lstatSync(root, { bigint: true })),
      destinationParentIdentity: identity(fs.lstatSync(root, { bigint: true }))
    }),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.equal(spawnCalls, 0);
});

test('durable directory batches reject duplicates, malformed expectations, and excess entries before spawn', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-batch-bounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);
  let spawnCalls = 0;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [root],
    appOwnedRoot: path.join(root, 'app-owned'), verifyWorker: () => {},
    spawnSync() { spawnCalls += 1; return {}; }
  });

  assert.equal(Number.isSafeInteger(MAX_FLUSH_DIRECTORIES), true);
  assert.ok(MAX_FLUSH_DIRECTORIES >= 2 && MAX_FLUSH_DIRECTORIES <= 4096);
  assert.throws(() => client.flushDirectories([]), error => error.code === 'COMMIT_FAILED');
  assert.throws(() => client.flushDirectories([directory, directory]), error => error.code === 'COMMIT_FAILED');
  assert.throws(
    () => client.flushDirectories([directory], { directoryIdentities: [] }),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.throws(
    () => client.flushDirectories(Array.from({ length: MAX_FLUSH_DIRECTORIES + 1 }, () => directory)),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.equal(spawnCalls, 0);
});

test('advertised durable directory batch fits the native strict JSON token budget at maximum root cardinality', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-token-budget-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowedRoots = Array.from({ length: 16 }, (_, index) => {
    const root = path.join(base, `root-${String(index).padStart(2, '0')}`);
    fs.mkdirSync(root);
    return root;
  });
  const directories = Array.from({ length: MAX_FLUSH_DIRECTORIES }, (_, index) => {
    const directory = path.join(allowedRoots[0], `directory-${String(index).padStart(4, '0')}`);
    fs.mkdirSync(directory);
    return directory;
  });
  let framedRequest = null;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe',
    workerManifestPath: 'worker.json',
    allowedRoots,
    appOwnedRoot: path.join(base, 'app-owned'),
    verifyWorker: () => {},
    spawnSync(_file, _args, options) {
      framedRequest = options.input;
      return { status: 0, signal: null, error: null, stderr: Buffer.alloc(0), stdout: encodeFrame({ ok: true }) };
    }
  });

  client.flushDirectories(directories);

  const requestLength = framedRequest.readUInt32LE(0);
  const request = JSON.parse(framedRequest.subarray(4, 4 + requestLength).toString('utf8'));
  const tokenCount = value => {
    if (Array.isArray(value)) return 2 + value.reduce((total, item) => total + tokenCount(item), 0);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      return 2 + entries.length + entries.reduce((total, [, item]) => total + tokenCount(item), 0);
    }
    return 1;
  };
  const repositoryRoot = path.resolve(__dirname, '../..');
  const frameReader = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Protocol', 'FrameReader.cs'), 'utf8');
  const durableWorker = fs.readFileSync(path.join(repositoryRoot, 'native', 'ArchiveWorker', 'Durability', 'DurableFilesystem.cs'), 'utf8');
  const tokenLimitMatch = frameReader.match(/MaximumTokens\s*=\s*(\d+)\s*\*\s*(\d+)/u);
  const nativeBatchMatch = durableWorker.match(/MaxFlushDirectories\s*=\s*(\d+)/u);
  assert.ok(tokenLimitMatch);
  assert.ok(nativeBatchMatch);
  const nativeTokenLimit = Number(tokenLimitMatch[1]) * Number(tokenLimitMatch[2]);

  assert.equal(MAX_FLUSH_DIRECTORIES, 512);
  assert.equal(Number(nativeBatchMatch[1]), MAX_FLUSH_DIRECTORIES);
  assert.ok(requestLength <= MAX_FRAME_BYTES, 'maximum-cardinality fixture must fit the native frame byte limit');
  assert.ok(tokenCount(request) <= nativeTokenLimit, 'maximum directory batch must fit the native JSON token budget');
});
