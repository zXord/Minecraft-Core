const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ServerHealthValidator
} = require('../electron/services/server-health-validator.cjs');

const RUNTIME = Object.freeze({
  minecraftVersion: '1.21.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 21,
  os: 'win32',
  architecture: 'x64'
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function parseProperties(value) {
  const result = {};
  for (const line of String(value).split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function healthFailure(error) {
  return error && error.code === 'HEALTH_CHECK_FAILED';
}

class FakeHealthHandle {
  constructor(options = {}) {
    this.pid = options.pid || 5100;
    this.publishEvents = false;
    this.readyMarkers = ['Done ('];
    this.fatalMarkers = ['fatal'];
    this.live = options.live !== false;
    this.owner = options.owner !== false;
    this.readyError = options.readyError || null;
    this.stopResult = options.stopResult || {
      clean: true,
      closed: true,
      exitCode: 0,
      forced: false,
      signal: null
    };
    this.stopCalls = [];
    this.ownerCalls = [];
    this.liveChecks = 0;
    this.closedGate = deferred();
    this.closed = this.closedGate.promise;
    this.isLiveImpl = options.isLiveImpl || null;
  }

  isLive() {
    this.liveChecks += 1;
    return this.isLiveImpl ? this.isLiveImpl(this.liveChecks) : this.live;
  }

  async waitForReady(request) {
    this.readyRequest = request;
    if (this.readyError) throw this.readyError;
    return { marker: 'Done (', pid: this.pid };
  }

  async ownsEndpoint(request) {
    this.ownerCalls.push(request);
    return this.owner;
  }

  async stopFully(request) {
    this.stopCalls.push(request);
    if (this.stopResult.closed) {
      this.live = false;
      this.closedGate.resolve({ exitCode: this.stopResult.exitCode, signal: this.stopResult.signal });
    }
    return { ...this.stopResult };
  }

  finish() {
    this.live = false;
    this.closedGate.resolve({ exitCode: 0, signal: null });
  }
}

function fixture(t, options = {}) {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-health-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  const propertiesPath = path.join(serverPath, 'server.properties');
  if (options.properties !== null) {
    fs.writeFileSync(
      propertiesPath,
      options.properties || Buffer.from('# exact original\r\nmotd=Original\r\nserver-port=25565\r\n'),
      options.properties ? undefined : undefined
    );
  }

  const leaseCalls = [];
  const startLease = {
    kind: 'start',
    instanceId: 'canonical-server',
    serverPath,
    assertOwnedPath(candidate) {
      assert.equal(path.resolve(candidate), path.resolve(serverPath));
      return candidate;
    },
    markDirty() {
      leaseCalls.push('dirty');
      return true;
    },
    markRunning({ pid }) {
      leaseCalls.push(`running:${pid}`);
      return this;
    },
    release() {
      leaseCalls.push('release');
      return true;
    }
  };
  const mutationLease = Object.freeze({
    kind: 'mutation',
    instanceId: 'canonical-server',
    serverPath: 'C:\\Minecraft\\Canonical',
    operationId: 'install-job-parent'
  });
  const acquireCalls = [];
  const coordinator = {
    async acquireStart(selector, request) {
      acquireCalls.push({ selector, request });
      return startLease;
    }
  };

  const launchCalls = [];
  const handle = options.handle || new FakeHealthHandle(options.handleOptions);
  const processRunner = {
    launchServerProcess(request) {
      launchCalls.push(request);
      if (options.launchError) throw options.launchError;
      if (options.onLaunch) options.onLaunch(request, propertiesPath);
      return handle;
    }
  };

  const pingCalls = [];
  let now = 1000;
  const pingStatus = async request => {
    pingCalls.push(request);
    if (options.onPing) await options.onPing(request, propertiesPath);
    if (options.pingError) throw options.pingError;
    if (options.pingResult) return options.pingResult;
    const properties = parseProperties(fs.readFileSync(propertiesPath, 'utf8'));
    return Object.freeze({
      description: properties.motd || 'Live server',
      players: null,
      version: null
    });
  };
  const validator = new ServerHealthValidator({
    chooseLoopbackPort: async () => options.port || 34567,
    clock: options.clock || (() => now),
    coordinator,
    createNonce: () => 'nonce-123',
    fileSystem: options.fileSystem,
    pingStatus,
    processRunner,
    resolveJavaPath: options.resolveJavaPath || (async () => 'C:\\Java\\bin\\java.exe'),
    runWithLease: async (_lease, work) => work(),
    sleep: async milliseconds => { now += Math.max(1, milliseconds); }
  });

  return {
    acquireCalls,
    handle,
    launchCalls,
    leaseCalls,
    mutationLease,
    pingCalls,
    propertiesPath,
    serverPath,
    startLease,
    validator
  };
}

function candidateRequest(value, overrides = {}) {
  return {
    jobId: 'job-candidate',
    candidatePath: value.serverPath,
    runtime: RUNTIME,
    maxRam: 6,
    mutationLease: value.mutationLease,
    timeoutMs: 1000,
    ...overrides
  };
}

function liveRequest(value, overrides = {}) {
  return {
    jobId: 'job-live',
    instanceId: 'canonical-server',
    serverPath: value.serverPath,
    runtime: RUNTIME,
    port: 25570,
    maxRam: 6,
    mutationLease: value.mutationLease,
    keepRunning: false,
    timeoutMs: 1000,
    ...overrides
  };
}

test('candidate validation uses a private nonce endpoint, same child evidence, full stop, and exact byte restoration', async t => {
  const original = Buffer.from('# preserve\r\nmotd=Secret original\r\nserver-port=25565\r\n');
  let overlay = null;
  const value = fixture(t, {
    properties: original,
    onLaunch(_request, propertiesPath) {
      overlay = parseProperties(fs.readFileSync(propertiesPath, 'utf8'));
    }
  });

  const result = await value.validator.validateCandidate(candidateRequest(value));

  assert.deepEqual(value.acquireCalls, [{
    selector: { instanceId: 'canonical-server', serverPath: value.serverPath },
    request: {
      operation: 'server-health-candidate',
      operationId: result.evidence.operationId,
      parentMutationLease: value.mutationLease
    }
  }]);
  assert.equal(overlay['server-ip'], '127.0.0.1');
  assert.equal(overlay['server-port'], '34567');
  assert.equal(overlay['enable-query'], 'false');
  assert.equal(overlay['enable-rcon'], 'false');
  assert.equal(overlay['broadcast-rcon-to-ops'], 'false');
  assert.equal(overlay['management-server-enabled'], 'false');
  assert.equal(overlay.motd, result.evidence.motdNonce);
  assert.match(overlay.motd, /^minecraft-core-health:/);
  assert.deepEqual(value.launchCalls.map(call => ({
    instanceId: call.instanceId,
    javaPath: call.javaPath,
    maxRam: call.maxRam,
    operationId: call.operationId,
    publishEvents: call.publishEvents,
    runtime: call.runtime,
    serverPath: call.serverPath,
    onLine: typeof call.onLine
  })), [{
    instanceId: 'canonical-server',
    javaPath: 'C:\\Java\\bin\\java.exe',
    maxRam: 6,
    operationId: result.evidence.operationId,
    publishEvents: false,
    runtime: RUNTIME,
    serverPath: value.serverPath,
    onLine: 'function'
  }]);
  assert.equal(value.pingCalls.length, 1);
  assert.deepEqual(value.pingCalls[0], {
    host: '127.0.0.1',
    port: 34567,
    protocolVersion: -1,
    signal: undefined,
    timeoutMs: 1000
  });
  assert.deepEqual(value.handle.stopCalls, [{ gracefulTimeoutMs: 5000, killTimeoutMs: 5000 }]);
  assert.deepEqual(value.handle.ownerCalls, [{
    host: '127.0.0.1',
    port: 34567,
    signal: undefined,
    timeoutMs: 1000
  }]);
  assert.deepEqual(value.leaseCalls, ['dirty', 'running:5100', 'dirty', 'release']);
  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
  assert.equal(result.handoff, null);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.deepEqual(result.evidence, {
    elapsedMs: 0,
    endpoint: { host: '127.0.0.1', port: 34567 },
    handedOff: false,
    kind: 'candidate',
    listenerOwned: true,
    live: true,
    motdNonce: 'minecraft-core-health:nonce-123',
    operationId: result.evidence.operationId,
    pid: 5100,
    pongMatched: true,
    properties: {
      existed: true,
      sha256: crypto.createHash('sha256').update(original).digest('hex')
    },
    readyMarker: 'Done (',
    shutdown: {
      clean: true,
      closed: true,
      exitCode: 0,
      forced: false,
      signal: null
    }
  });
  const serialized = JSON.stringify(result.evidence);
  assert.equal(serialized.includes(value.serverPath), false);
  assert.equal(serialized.includes('Secret original'), false);
});

test('candidate validation restores the exact absence of server.properties', async t => {
  const value = fixture(t, { properties: null });
  const result = await value.validator.validateCandidate(candidateRequest(value));
  assert.equal(fs.existsSync(value.propertiesPath), false);
  assert.deepEqual(result.evidence.properties, { existed: false, sha256: null });
  assert.deepEqual(value.leaseCalls, ['dirty', 'running:5100', 'dirty', 'release']);
});

test('an unrelated listener or wrong nonce can never satisfy candidate health', async t => {
  const unrelated = fixture(t, { handleOptions: { owner: false } });
  await assert.rejects(
    unrelated.validator.validateCandidate(candidateRequest(unrelated, { timeoutMs: 20 })),
    healthFailure
  );
  assert.equal(unrelated.pingCalls.length, 0);
  assert.equal(unrelated.handle.stopCalls.length, 1);

  const wrongNonce = fixture(t, { pingResult: { description: 'another server', players: null, version: null } });
  await assert.rejects(
    wrongNonce.validator.validateCandidate(candidateRequest(wrongNonce, { timeoutMs: 20 })),
    healthFailure
  );
  assert.ok(wrongNonce.pingCalls.length >= 1);
  assert.equal(wrongNonce.handle.stopCalls.length, 1);
});

test('candidate validation rejects premature liveness, bind conflicts, timeout, and cancellation with cleanup', async t => {
  const dead = fixture(t, { handleOptions: { isLiveImpl: call => call === 1 } });
  await assert.rejects(dead.validator.validateCandidate(candidateRequest(dead)), healthFailure);
  assert.equal(dead.handle.stopCalls.length, 1);

  const bindError = Object.assign(new Error('listen EADDRINUSE C:\\secret'), { code: 'EADDRINUSE' });
  const bind = fixture(t, { launchError: bindError });
  const bindOriginal = fs.readFileSync(bind.propertiesPath);
  await assert.rejects(bind.validator.validateCandidate(candidateRequest(bind)), healthFailure);
  assert.deepEqual(fs.readFileSync(bind.propertiesPath), bindOriginal);

  const timeoutError = Object.assign(new Error('timed out C:\\secret'), { code: 'HEALTH_CHECK_FAILED' });
  const timeout = fixture(t, { handleOptions: { readyError: timeoutError } });
  await assert.rejects(timeout.validator.validateCandidate(candidateRequest(timeout)), healthFailure);
  assert.equal(timeout.handle.stopCalls.length, 1);

  const cancelledError = Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  const cancelled = fixture(t, { handleOptions: { readyError: cancelledError } });
  await assert.rejects(
    cancelled.validator.validateCandidate(candidateRequest(cancelled)),
    error => error.code === 'CANCELLED'
  );
  assert.equal(cancelled.handle.stopCalls.length, 1);
  assert.equal(JSON.stringify(cancelled.leaseCalls).includes('secret'), false);
});

test('candidate property write and restore failures fail closed without exposing paths', async t => {
  const baseFileSystem = {
    exists: fs.existsSync,
    readFile: fs.readFileSync,
    removeFile: filePath => fs.rmSync(filePath, { force: true }),
    writeFile: fs.writeFileSync
  };
  let writes = 0;
  const overlayFailure = fixture(t, {
    fileSystem: {
      ...baseFileSystem,
      writeFile(filePath, bytes) {
        writes += 1;
        if (writes === 1) throw new Error(`overlay failed ${filePath}`);
        fs.writeFileSync(filePath, bytes);
      }
    }
  });
  const overlayOriginal = fs.readFileSync(overlayFailure.propertiesPath);
  await assert.rejects(
    overlayFailure.validator.validateCandidate(candidateRequest(overlayFailure)),
    error => {
      assert.equal(error.code, 'HEALTH_CHECK_FAILED');
      assert.equal(error.message.includes(overlayFailure.serverPath), false);
      return true;
    }
  );
  assert.deepEqual(fs.readFileSync(overlayFailure.propertiesPath), overlayOriginal);
  assert.equal(overlayFailure.launchCalls.length, 0);

  writes = 0;
  const restoreFailure = fixture(t, {
    fileSystem: {
      ...baseFileSystem,
      writeFile(filePath, bytes) {
        writes += 1;
        if (writes === 2) throw new Error(`restore failed ${filePath}`);
        fs.writeFileSync(filePath, bytes);
      }
    }
  });
  await assert.rejects(
    restoreFailure.validator.validateCandidate(candidateRequest(restoreFailure)),
    healthFailure
  );
  assert.equal(restoreFailure.handle.stopCalls.length, 1);
});

test('a child that cannot prove close fails health and retains its start lease fail-closed', async t => {
  const value = fixture(t, {
    handleOptions: {
      stopResult: { clean: false, closed: false, exitCode: null, forced: true, signal: null }
    }
  });
  await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), healthFailure);
  assert.equal(value.leaseCalls.includes('release'), false);

  value.handle.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.leaseCalls.filter(call => call === 'release').length, 1);
});

test('a rejected close signal never releases the retained start lease', async t => {
  const closeGate = deferred();
  const handle = new FakeHealthHandle({
    stopResult: { clean: false, closed: false, exitCode: null, forced: true, signal: null }
  });
  handle.closed = closeGate.promise;
  const value = fixture(t, { handle });

  await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), healthFailure);
  assert.equal(value.leaseCalls.includes('release'), false);

  closeGate.reject(new Error('close evidence failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.leaseCalls.includes('release'), false);
});

test('candidate and stopped-live validation reject forced, signalled, or nonzero shutdowns', async t => {
  const shutdowns = [
    { clean: false, closed: true, exitCode: null, forced: true, signal: 'SIGKILL' },
    { clean: false, closed: true, exitCode: 1, forced: false, signal: null },
    { clean: false, closed: true, exitCode: null, forced: false, signal: 'SIGTERM' },
    { clean: true, closed: true, exitCode: 1, forced: false, signal: null },
    { clean: true, closed: true, exitCode: 0, forced: true, signal: null }
  ];

  for (const [index, stopResult] of shutdowns.entries()) {
    const candidate = fixture(t, { handleOptions: { pid: 5200 + index, stopResult } });
    await assert.rejects(candidate.validator.validateCandidate(candidateRequest(candidate)), healthFailure);
    assert.equal(candidate.leaseCalls.filter(call => call === 'release').length, 1);

    const live = fixture(t, {
      handleOptions: { pid: 5300 + index, stopResult },
      pingResult: { description: 'Live server', players: null, version: null }
    });
    await assert.rejects(live.validator.validateLive(liveRequest(live)), healthFailure);
    assert.equal(live.leaseCalls.filter(call => call === 'release').length, 1);
  }
});

test('live validation leaves properties untouched and restores the prior stopped policy', async t => {
  const original = Buffer.from('# live exact\nserver-port=25570\nmotd=Visible MOTD\n');
  const value = fixture(t, { properties: original, pingResult: { description: 'Visible MOTD', players: null, version: null } });
  const result = await value.validator.validateLive(liveRequest(value));

  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
  assert.equal(result.evidence.kind, 'live');
  assert.equal(result.evidence.motdNonce, null);
  assert.equal(result.evidence.handedOff, false);
  assert.equal(result.evidence.pongMatched, true);
  assert.equal(result.handoff, null);
  assert.equal(value.handle.stopCalls.length, 1);
  assert.deepEqual(value.leaseCalls, ['running:5100', 'release']);
  assert.equal(value.launchCalls[0].serverPath, value.serverPath);
  assert.equal(value.launchCalls[0].publishEvents, false);
  assert.deepEqual(value.handle.ownerCalls[0], {
    host: '127.0.0.1',
    port: 25570,
    signal: undefined,
    timeoutMs: 1000
  });
});

test('live keep-running returns the exact child and start lease handoff until child close', async t => {
  const value = fixture(t, { pingResult: { description: 'Live server', players: null, version: null } });
  const result = await value.validator.validateLive(liveRequest(value, { keepRunning: true }));

  assert.equal(result.evidence.handedOff, true);
  assert.equal(result.evidence.shutdown, null);
  assert.equal(result.handoff.processHandle, value.handle);
  assert.equal(result.handoff.startLease, value.startLease);
  assert.equal(value.handle.stopCalls.length, 0);
  assert.equal(value.leaseCalls.includes('release'), false);

  value.handle.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.leaseCalls.filter(call => call === 'release').length, 1);
});

test('live keep-running rejects a child that closes during final handoff validation', async t => {
  const handle = new FakeHealthHandle();
  handle.isLiveImpl = call => {
    if (call === 5) {
      handle.finish();
      return true;
    }
    return true;
  };
  const value = fixture(t, {
    handle,
    pingResult: { description: 'Live server', players: null, version: null }
  });

  await assert.rejects(
    value.validator.validateLive(liveRequest(value, { keepRunning: true })),
    healthFailure
  );
  assert.equal(handle.stopCalls.length, 1);
  assert.equal(value.leaseCalls.filter(call => call === 'release').length, 1);
});

test('live keep-running failures stop the exact child and release instead of leaking a handoff', async t => {
  const readyFailure = Object.assign(new Error('not ready'), { code: 'HEALTH_CHECK_FAILED' });
  const notReady = fixture(t, { handleOptions: { readyError: readyFailure } });
  await assert.rejects(
    notReady.validator.validateLive(liveRequest(notReady, { keepRunning: true })),
    healthFailure
  );
  assert.equal(notReady.handle.stopCalls.length, 1);
  assert.equal(notReady.leaseCalls.filter(call => call === 'release').length, 1);

  const changedProperties = fixture(t, {
    async onPing(_request, propertiesPath) {
      fs.appendFileSync(propertiesPath, 'late-change=true\n');
    },
    pingResult: { description: 'Live server', players: null, version: null }
  });
  await assert.rejects(
    changedProperties.validator.validateLive(liveRequest(changedProperties, { keepRunning: true })),
    healthFailure
  );
  assert.equal(changedProperties.handle.stopCalls.length, 1);
  assert.equal(changedProperties.leaseCalls.filter(call => call === 'release').length, 1);

  const diesAfterIdentity = fixture(t, {
    handleOptions: { isLiveImpl: call => call < 5 },
    pingResult: { description: 'Live server', players: null, version: null }
  });
  await assert.rejects(
    diesAfterIdentity.validator.validateLive(liveRequest(diesAfterIdentity, { keepRunning: true })),
    healthFailure
  );
  assert.equal(diesAfterIdentity.handle.stopCalls.length, 1);
  assert.equal(diesAfterIdentity.leaseCalls.filter(call => call === 'release').length, 1);
});

test('Java resolution is bounded by the health deadline and receives a cooperative abort signal', async t => {
  let resolverSignal = null;
  const resolverGate = deferred();
  const value = fixture(t, {
    async resolveJavaPath({ signal }) {
      resolverSignal = signal;
      await resolverGate.promise;
      return 'C:\\Java\\bin\\java.exe';
    }
  });
  const started = Date.now();
  await assert.rejects(
    value.validator.validateCandidate(candidateRequest(value, { timeoutMs: 20 })),
    healthFailure
  );
  assert.ok(Date.now() - started < 120, 'deadline must reject before the slow resolver settles');
  assert.equal(resolverSignal?.aborted, true);
  assert.equal(value.launchCalls.length, 0);
  assert.equal(value.leaseCalls.includes('release'), false, 'unsettled Java work must retain the lease');

  resolverGate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.leaseCalls.filter(call => call === 'release').length, 1);
});

test('a Java result that arrives after the absolute deadline never reaches process spawn', async t => {
  let now = 1000;
  const value = fixture(t, {
    clock: () => now,
    async resolveJavaPath() {
      now = 1021;
      return 'C:\\Java\\bin\\java.exe';
    }
  });

  await assert.rejects(
    value.validator.validateCandidate(candidateRequest(value, { timeoutMs: 20 })),
    healthFailure
  );
  assert.equal(value.launchCalls.length, 0);
  assert.equal(value.leaseCalls.filter(call => call === 'release').length, 1);
});

test('health validators reject closed malformed requests before lease acquisition or property reads', async t => {
  const value = fixture(t);
  const invalidCandidate = [
    { jobId: '../bad' },
    { candidatePath: 'relative' },
    { runtime: { ...RUNTIME, extra: true } },
    { maxRam: 0 },
    { mutationLease: null },
    { timeoutMs: 0 },
    { extra: true }
  ];
  for (const change of invalidCandidate) {
    await assert.rejects(
      value.validator.validateCandidate({ ...candidateRequest(value), ...change }),
      error => error.code === 'INVALID_REQUEST'
    );
  }
  await assert.rejects(
    value.validator.validateLive({ ...liveRequest(value), keepRunning: 'yes' }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.equal(value.acquireCalls.length, 0);
  assert.equal(value.launchCalls.length, 0);
});
