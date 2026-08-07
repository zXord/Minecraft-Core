const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const { ARCHIVE_LIMITS } = require('../../electron/services/modpacks/limits.cjs');
const { WindowsDurableFsClient } = require('../../electron/utils/windows-durable-fs-client.cjs');
const {
  ArchiveWorkerClient,
  MAX_FRAME_BYTES,
  StrictFrameDecoder,
  encodeFrame
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

test('the overall deadline includes runtime verification before broker spawn', async (t) => {
  const f = fixture(t, () => assert.fail('deadline-expired verification spawned a broker'), {
    deadlineOverrideMs: 5,
    verifyRuntime: () => new Promise(() => {})
  });
  const outcome = await Promise.race([
    f.client.run(request(), {}).then(() => 'resolved', error => error.code),
    new Promise(resolve => setTimeout(() => resolve('hung'), 100))
  ]);
  assert.equal(outcome, 'EXTRACTOR_UNAVAILABLE');
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
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'app-owned', 'broker-bundles')), []);
});

test('cancellation does not settle or delete the bundle tree until broker close proves quiescence', async (t) => {
  const f = fixture(t, () => {}, { cleanupGraceMs: 5, forceCloseWaitMs: 1000 });
  const controller = new AbortController();
  let settled = false;
  const pending = f.client.run(request(), { signal: controller.signal }).finally(() => { settled = true; });
  const child = await f.spawned;
  child.kill = () => false;
  const bundleRoot = f.calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fs.existsSync(bundleRoot), true);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', null, 'SIGKILL');
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(fs.existsSync(bundleRoot), false);
});

test('forced cancellation cannot settle until late broker close proves quiescence', async (t) => {
  const f = fixture(t, () => {}, { cleanupGraceMs: 5, forceCloseWaitMs: 5 });
  const controller = new AbortController();
  const pending = f.client.run(request(), { signal: controller.signal });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const child = await f.spawned;
  child.kill = () => { child.killed = true; child.killCount += 1; return false; };
  const bundleRoot = f.calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 25));
  const settledBeforeClose = settled;
  assert.ok(child.killCount >= 1);
  assert.equal(fs.existsSync(bundleRoot), true);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', null, 'SIGKILL');
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(settledBeforeClose, false);
  assert.equal(fs.existsSync(bundleRoot), false);
});

test('a running-journal failure still waits for and observes broker close', async (t) => {
  const originalOpenSync = fs.openSync;
  fs.openSync = (...args) => {
    if (args[1] === 'w' && path.basename(args[0]) === '.minecraft-core-broker-bundle.json') {
      throw Object.assign(new Error('simulated running journal failure'), { code: 'EIO' });
    }
    return originalOpenSync(...args);
  };
  t.after(() => { fs.openSync = originalOpenSync; });

  const f = fixture(t, () => assert.fail('request must not be written after the running journal fails'), {
    cleanupGraceMs: 5,
    forceCloseWaitMs: 1000
  });
  const pending = f.client.run(request());
  const child = await f.spawned;
  child.kill = () => false;
  const bundleRoot = f.calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fs.existsSync(bundleRoot), true);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', null, 'SIGKILL');
  const result = await Promise.race([
    pending.then(() => 'resolved', error => error.code),
    new Promise(resolve => setTimeout(() => resolve('not-observed'), 25))
  ]);
  assert.equal(result, 'EXTRACTOR_UNAVAILABLE');
  assert.equal(fs.existsSync(bundleRoot), false);
});

test('startup recovery removes only broker bundles whose recorded process is absent', (t) => {
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

  new ArchiveWorkerClient({ resourcesRoot: root, appOwnedRoot });

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(live), true);
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

test('durable client rejects roots and device aliases before spawn and isolates the single-file bundle', (t) => {
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
  const bundleRoot = calls[0].options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
  assert.equal(path.relative(appOwnedRoot, bundleRoot).startsWith('..'), false);
  assert.equal(fs.existsSync(bundleRoot), false, 'confirmed close removes the isolated bundle');
});

test('durable client removes its bundle after bounded spawnSync returns from timeout', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-durable-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  fs.writeFileSync(source, 'source');
  let bundleRoot;
  const client = new WindowsDurableFsClient({
    workerPath: 'worker.exe', workerManifestPath: 'worker.json', allowedRoots: [root], appOwnedRoot: path.join(root, 'app-owned'),
    verifyWorker: () => {},
    spawnSync(_file, _args, options) {
      bundleRoot = options.env.DOTNET_BUNDLE_EXTRACT_BASE_DIR;
      return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
  });
  assert.throws(() => client.moveWriteThrough(source, path.join(root, 'moved.txt')), error => error.code === 'COMMIT_FAILED');
  assert.equal(fs.existsSync(bundleRoot), false);
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
