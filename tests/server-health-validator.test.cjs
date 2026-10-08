const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isUnprovenHealthProcessError,
  ServerHealthValidator,
  stopValidatedHandoff
} = require('../electron/services/server-health-validator.cjs');
const { ServerJavaManager } = require('../electron/services/server-java-manager.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const {
  failureDiagnosticFromError
} = require('../electron/services/modpack-lifecycle/publication-failure-diagnostic.cjs');
const {
  issueForgeCandidateHealthAuthorization
} = require('../electron/services/forge-candidate-health-authorization.cjs');

const RUNTIME = Object.freeze({
  minecraftVersion: '1.21.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 21,
  os: 'win32',
  architecture: 'x64'
});

function runtimeValidation(runtime = RUNTIME) {
  return Object.freeze({ valid: true, runtime });
}

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
  const handle = options.handle || options.handles?.[0] || new FakeHealthHandle(options.handleOptions);
  const handles = options.handles || [handle];
  const processRunner = {
    launchServerProcess(request) {
      launchCalls.push(request);
      if (options.launchError) throw options.launchError;
      if (options.onLaunch) options.onLaunch(request, propertiesPath);
      return handles[Math.min(launchCalls.length - 1, handles.length - 1)];
    }
  };

  const verificationCalls = [];
  const defaultRuntimeValidation = options.runtimeValidation || runtimeValidation();
  const verifyRuntime = options.verifyRuntime || (async request => {
    verificationCalls.push(request);
    return defaultRuntimeValidation;
  });

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
  const dependencies = {
    chooseLoopbackPort: options.chooseLoopbackPort || (async () => options.port || 34567),
    clock: options.clock || (() => now),
    coordinator,
    createNonce: options.createNonce || (() => 'nonce-123'),
    fileSystem: options.fileSystem,
    pingStatus,
    processRunner,
    runWithLease: async (_lease, work) => work(),
    sleep: async milliseconds => { now += Math.max(1, milliseconds); },
    verifyRuntime
  };
  if (options.useDefaultResolveJavaPath !== true) {
    dependencies.resolveJavaPath = options.resolveJavaPath || (async () => 'C:\\Java\\bin\\java.exe');
  }
  const validator = new ServerHealthValidator(dependencies);

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
    validator,
    verificationCalls
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

test('candidate validation rejects server.properties larger than one MiB before launch', async t => {
  const oversizedProperties = Buffer.alloc((1024 * 1024) + 1, 0x61);
  const value = fixture(t, { properties: oversizedProperties });

  await assert.rejects(
    value.validator.validateCandidate(candidateRequest(value)),
    error => error?.code === 'HEALTH_CHECK_FAILED'
  );

  assert.equal(value.launchCalls.length, 0);
  assert.equal(fs.statSync(value.propertiesPath).size, oversizedProperties.length);
});

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
    runtimeValidation: call.runtimeValidation,
    serverPath: call.serverPath,
    onLine: typeof call.onLine
  })), [{
    instanceId: 'canonical-server',
    javaPath: 'C:\\Java\\bin\\java.exe',
    maxRam: 6,
    operationId: result.evidence.operationId,
    publishEvents: false,
    runtime: RUNTIME,
    runtimeValidation: runtimeValidation(),
    serverPath: value.serverPath,
    onLine: 'function'
  }]);
  assert.equal(Object.hasOwn(value.launchCalls[0], 'forgeCandidateHealthAuthorization'), false);
  assert.deepEqual(value.verificationCalls, [{
    targetPath: value.serverPath,
    runtime: RUNTIME,
    signal: undefined,
    timeoutMs: 1000
  }]);
  assert.equal(value.pingCalls.length, 1);
  assert.deepEqual(value.pingCalls[0], {
    host: '127.0.0.1',
    port: 34567,
    protocolVersion: -1,
    signal: undefined,
    timeoutMs: 1000
  });
  assert.deepEqual(value.handle.stopCalls, [{ gracefulTimeoutMs: 30_000, killTimeoutMs: 5_000 }]);
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

test('candidate validation forwards an explicit transactional restore boundary to the process launch', async t => {
  const forgeRuntime = Object.freeze({
    ...RUNTIME,
    minecraftVersion: '1.12.2',
    loaderFamily: 'forge',
    loaderVersion: '14.23.5.2860',
    javaMajor: 8
  });
  const value = fixture(t, { runtimeValidation: runtimeValidation(forgeRuntime) });
  const authorization = issueForgeCandidateHealthAuthorization({
    candidatePath: value.serverPath,
    instanceId: value.mutationLease.instanceId,
    jobId: 'job-candidate',
    operationKind: 'upgrade',
    restorePointId: 'restore-one',
    restorePointSha256: 'a'.repeat(64),
    runtime: forgeRuntime,
    serverPath: path.join(path.dirname(value.serverPath), 'canonical-server'),
    sourceRevision: 5
  });

  await value.validator.validateCandidate(candidateRequest(value, {
    runtime: forgeRuntime,
    forgeCandidateHealthAuthorization: authorization
  }));

  assert.equal(value.launchCalls[0].forgeCandidateHealthAuthorization, authorization);
});

test('candidate validation restores the exact absence of server.properties', async t => {
  const value = fixture(t, { properties: null });
  const result = await value.validator.validateCandidate(candidateRequest(value));
  assert.equal(fs.existsSync(value.propertiesPath), false);
  assert.deepEqual(result.evidence.properties, { existed: false, sha256: null });
  assert.deepEqual(value.leaseCalls, ['dirty', 'running:5100', 'dirty', 'release']);
});

test('candidate validation accepts a pack-scale startup deadline', async t => {
  const value = fixture(t);

  const result = await value.validator.validateCandidate(candidateRequest(value, {
    timeoutMs: 15 * 60_000
  }));

  assert.equal(result.evidence.live, true);
  assert.equal(value.handle.readyRequest.timeoutMs, 15 * 60_000);
});

test('candidate validation resolves the already-planned Java major without provider metadata', async t => {
  const originalStatus = ServerJavaManager.prototype.getJavaValidationStatus;
  const originalRequirements = ServerJavaManager.prototype.getJavaRequirementsForMinecraft;
  let requestedMajor = null;
  ServerJavaManager.prototype.getJavaValidationStatus = function getJavaValidationStatus(major) {
    requestedMajor = major;
    return {
      isInstalled: true,
      javaPath: path.join(this.serverPath, 'java', 'java-21', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java')
    };
  };
  ServerJavaManager.prototype.getJavaRequirementsForMinecraft = async function forbiddenMetadataLookup() {
    throw new Error('provider metadata must not be queried during candidate health');
  };
  t.after(() => {
    ServerJavaManager.prototype.getJavaValidationStatus = originalStatus;
    ServerJavaManager.prototype.getJavaRequirementsForMinecraft = originalRequirements;
  });
  const value = fixture(t, { useDefaultResolveJavaPath: true });

  const result = await value.validator.validateCandidate(candidateRequest(value));

  assert.equal(result.evidence.live, true);
  assert.equal(requestedMajor, RUNTIME.javaMajor);
});

test('candidate validation gives a modded server a bounded graceful-save window before forcing termination', async t => {
  const handle = new FakeHealthHandle();
  handle.stopFully = async request => {
    handle.stopCalls.push(request);
    if (request.gracefulTimeoutMs < 30_000) {
      handle.live = false;
      handle.closedGate.resolve({ exitCode: null, signal: 'SIGKILL' });
      return { clean: false, closed: true, exitCode: null, forced: true, signal: 'SIGKILL' };
    }
    handle.live = false;
    handle.closedGate.resolve({ exitCode: 0, signal: null });
    return { clean: true, closed: true, exitCode: 0, forced: false, signal: null };
  };
  const value = fixture(t, { handle });

  const result = await value.validator.validateCandidate(candidateRequest(value));

  assert.deepEqual(handle.stopCalls, [{ gracefulTimeoutMs: 30_000, killTimeoutMs: 5_000 }]);
  assert.equal(result.evidence.shutdown.clean, true);
});

test('candidate validation retries one fully-unwound transient failure on a fresh private endpoint', async t => {
  const original = Buffer.from('# exact rollback candidate\r\nmotd=Original\r\nserver-port=25565\r\n');
  const first = new FakeHealthHandle({
    pid: 5201,
    readyError: Object.assign(new Error('transient candidate launch failure'), {
      code: 'HEALTH_CHECK_FAILED'
    })
  });
  const second = new FakeHealthHandle({ pid: 5202 });
  const ports = [41001, 41002];
  const nonces = ['first-attempt', 'second-attempt'];
  const overlays = [];
  const value = fixture(t, {
    properties: original,
    handles: [first, second],
    chooseLoopbackPort: async () => ports.shift(),
    createNonce: () => nonces.shift(),
    onLaunch(_request, propertiesPath) {
      overlays.push(parseProperties(fs.readFileSync(propertiesPath, 'utf8')));
    }
  });

  const result = await value.validator.validateCandidate(candidateRequest(value));

  assert.equal(result.evidence.pid, 5202);
  assert.equal(result.evidence.endpoint.port, 41002);
  assert.equal(result.evidence.motdNonce, 'minecraft-core-health:second-attempt');
  assert.deepEqual(overlays.map(properties => [properties['server-port'], properties.motd]), [
    ['41001', 'minecraft-core-health:first-attempt'],
    ['41002', 'minecraft-core-health:second-attempt']
  ]);
  assert.deepEqual(first.stopCalls, [{ gracefulTimeoutMs: 30_000, killTimeoutMs: 5_000 }]);
  assert.deepEqual(second.stopCalls, [{ gracefulTimeoutMs: 30_000, killTimeoutMs: 5_000 }]);
  assert.equal(value.leaseCalls.filter(call => call === 'release').length, 2);
  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
});

test('candidate cleanup failure preserves caller cancellation and never turns it into a retryable health failure', async t => {
  const cancellation = new ModpackError('CANCELLED', 'Archive inspection was cancelled');
  const handle = new FakeHealthHandle({ readyError: cancellation });
  handle.stopFully = async request => {
    handle.stopCalls.push(request);
    throw new Error('private stop cleanup failure');
  };
  t.after(() => handle.finish());
  const value = fixture(t, { handle });
  const original = fs.readFileSync(value.propertiesPath);

  await assert.rejects(
    value.validator.validateCandidate(candidateRequest(value)),
    error => error === cancellation
  );

  assert.equal(value.launchCalls.length, 1);
  assert.equal(handle.stopCalls.length, 1);
  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
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

test('candidate boot failures attach only a closed non-enumerable diagnostic derived from bounded process output', async t => {
  const cases = [
    {
      name: 'heap exhaustion',
      line: 'java.lang.OutOfMemoryError: Java heap space C:\\private\\world',
      category: 'out-of-memory'
    },
    {
      name: 'JVM heap reservation failure',
      line: 'Error occurred during initialization of VM: Could not reserve enough space for 8388608KB object heap',
      category: 'out-of-memory'
    },
    {
      name: 'Java class mismatch',
      line: 'UnsupportedClassVersionError: compiled by a more recent Java Runtime C:\\private\\mods',
      category: 'runtime-java-mismatch'
    },
    {
      name: 'mod loader failure',
      line: 'net.minecraftforge.fml.ModLoadingException: Failed to load mod from C:\\private\\mods\\broken.jar',
      category: 'mod-loading-failure'
    }
  ];

  for (const failure of cases) {
    await t.test(failure.name, async subtest => {
      const readyError = new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed');
      const value = fixture(subtest, {
        handleOptions: { readyError },
        onLaunch(request) {
          request.onLine(Object.freeze({
            line: failure.line,
            operationId: 'health-candidate-test',
            pid: 5100,
            stream: 'stderr'
          }));
        }
      });
      let caught = null;

      await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), error => {
        caught = error;
        return error?.code === 'HEALTH_CHECK_FAILED';
      });

      const descriptor = Object.getOwnPropertyDescriptor(caught, 'candidateBootDiagnostic');
      assert.equal(descriptor?.enumerable, false);
      assert.deepEqual(descriptor?.value, {
        stage: 'candidate-boot',
        boundary: 'readiness',
        category: failure.category
      });
      assert.equal(Object.isFrozen(descriptor.value), true);
      assert.doesNotMatch(JSON.stringify(caught), /private|world|mods|broken/i);
    });
  }
});

test('candidate diagnostics identify internal boot boundaries without exposing raw causes', async t => {
  const portCause = Object.assign(new Error('listen EADDRINUSE C:\\private\\server'), { code: 'EADDRINUSE' });
  const port = fixture(t, { launchError: portCause });
  let portError = null;
  await assert.rejects(port.validator.validateCandidate(candidateRequest(port)), error => {
    portError = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(portError, 'candidateBootDiagnostic')?.value, {
    stage: 'candidate-boot', boundary: 'process-launch', category: 'port-conflict'
  });

  const runtime = fixture(t, {
    async verifyRuntime() {
      throw new ModpackError('HEALTH_CHECK_FAILED', 'Managed runtime verification failed', {
        cause: new Error('UnsupportedClassVersionError C:\\private\\java.exe')
      });
    }
  });
  let runtimeError = null;
  await assert.rejects(runtime.validator.validateCandidate(candidateRequest(runtime)), error => {
    runtimeError = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(runtimeError, 'candidateBootDiagnostic')?.value, {
    stage: 'candidate-boot', boundary: 'runtime-verification', category: 'runtime-java-mismatch'
  });

  const timeoutCause = new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed', {
    cause: new Error('Server process deadline exceeded at C:\\private\\server')
  });
  const timeout = fixture(t, { handleOptions: { readyError: timeoutCause } });
  let timeoutError = null;
  await assert.rejects(timeout.validator.validateCandidate(candidateRequest(timeout)), error => {
    timeoutError = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(timeoutError, 'candidateBootDiagnostic')?.value, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'readiness-timeout'
  });

  const exited = fixture(t, { handleOptions: { live: false } });
  let exitedError = null;
  await assert.rejects(exited.validator.validateCandidate(candidateRequest(exited)), error => {
    exitedError = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(exitedError, 'candidateBootDiagnostic')?.value, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'process-exited'
  });

  for (const caught of [portError, runtimeError, timeoutError, exitedError]) {
    assert.doesNotMatch(JSON.stringify(caught), /private|java\.exe/i);
  }
});

test('new canonical validation can opt into the same bounded boot diagnostic without exposing raw output', async t => {
  const readyError = new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed');
  const value = fixture(t, {
    handleOptions: { readyError },
    onLaunch(request) {
      request.onLine(Object.freeze({
        line: 'net.minecraftforge.fml.ModLoadingException: broken C:\\private\\mods\\secret.jar',
        operationId: 'health-live-test',
        pid: 5100,
        stream: 'stderr'
      }));
    }
  });
  let caught = null;

  await assert.rejects(
    value.validator.validateLive(liveRequest(value, { captureBootDiagnostic: true })),
    error => {
      caught = error;
      return error?.code === 'HEALTH_CHECK_FAILED';
    }
  );

  assert.deepEqual(Object.getOwnPropertyDescriptor(caught, 'candidateBootDiagnostic')?.value, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.doesNotMatch(JSON.stringify(caught), /private|secret\.jar/i);
});

test('candidate process diagnostics evict old lines at a strict bounded ring limit', async t => {
  const value = fixture(t, {
    handles: [5100, 5101].map(pid => new FakeHealthHandle({
      pid,
      readyError: new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed')
    })),
    onLaunch(request) {
      request.onLine(Object.freeze({
        line: 'OutOfMemoryError C:\\private\\must-be-evicted', operationId: 'health-candidate-test', pid: 5100, stream: 'stderr'
      }));
      for (let index = 0; index < 96; index += 1) {
        request.onLine(Object.freeze({
          line: `ordinary-line-${index}-${'x'.repeat(2048)}`,
          operationId: 'health-candidate-test',
          pid: 5100,
          stream: 'stdout'
        }));
      }
    }
  });
  let caught = null;

  await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), error => {
    caught = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });

  assert.deepEqual(Object.getOwnPropertyDescriptor(caught, 'candidateBootDiagnostic')?.value, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'health-failure'
  });
  assert.doesNotMatch(JSON.stringify(caught), /must-be-evicted|ordinary-line/i);
});

test('candidate retry diagnostics use only the final attempt process output', async t => {
  const handles = [
    new FakeHealthHandle({
      pid: 5301,
      readyError: new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed')
    }),
    new FakeHealthHandle({
      pid: 5302,
      readyError: new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed')
    })
  ];
  let launch = 0;
  const value = fixture(t, {
    handles,
    onLaunch(request) {
      launch += 1;
      request.onLine(Object.freeze({
        line: launch === 1
          ? 'java.lang.OutOfMemoryError: Java heap space C:\\private\\first-attempt'
          : 'ModLoadingException: Failed to load mod C:\\private\\second-attempt.jar',
        operationId: 'health-candidate-test',
        pid: launch === 1 ? 5301 : 5302,
        stream: 'stderr'
      }));
    }
  });
  let caught = null;

  await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), error => {
    caught = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });

  assert.equal(value.launchCalls.length, 2);
  assert.deepEqual(Object.getOwnPropertyDescriptor(caught, 'candidateBootDiagnostic')?.value, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.doesNotMatch(JSON.stringify(caught), /private|first-attempt|second-attempt/i);
});

test('candidate validation preserves closed filesystem evidence instead of attaching a boot diagnostic', async t => {
  const readyError = new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed');
  Object.defineProperty(readyError, 'durableFailureKind', { value: 'sharing-violation' });
  Object.defineProperty(readyError, 'durableFailureStage', { value: 'destination-parent-open' });
  const value = fixture(t, {
    handleOptions: { readyError },
    onLaunch(request) {
      request.onLine(Object.freeze({
        line: 'ModLoadingException: C:\\private\\mods\\broken.jar failed to load',
        operationId: 'health-candidate-test',
        pid: 5100,
        stream: 'stderr'
      }));
    }
  });
  let caught = null;

  await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), error => {
    caught = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });

  assert.equal(Object.hasOwn(caught, 'candidateBootDiagnostic'), false);
  assert.deepEqual(failureDiagnosticFromError(caught), {
    stage: 'filesystem-operation', category: 'sharing-violation', boundary: 'destination-parent-open'
  });
  assert.doesNotMatch(JSON.stringify(caught), /private|mods|broken/i);
});

test('candidate diagnostics replace enumerable or mutable preexisting metadata with hardened current evidence', async t => {
  const descriptors = [
    { configurable: false, enumerable: true, writable: false },
    { configurable: false, enumerable: false, writable: true },
    { configurable: true, enumerable: false, writable: false }
  ];
  for (const descriptorShape of descriptors) {
    await t.test(JSON.stringify(descriptorShape), async subtest => {
      const readyError = new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed');
      Object.defineProperty(readyError, 'candidateBootDiagnostic', {
        ...descriptorShape,
        value: Object.freeze({
          stage: 'candidate-boot', boundary: 'readiness', category: 'out-of-memory'
        })
      });
      const value = fixture(subtest, {
        handleOptions: { readyError },
        onLaunch(request) {
          request.onLine(Object.freeze({
            line: 'ModLoadingException: Failed to load mod from C:\\private\\current.jar',
            operationId: 'health-candidate-test',
            pid: 5100,
            stream: 'stderr'
          }));
        }
      });
      let caught = null;

      await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), error => {
        caught = error;
        return error?.code === 'HEALTH_CHECK_FAILED';
      });

      assert.notEqual(caught, readyError);
      const descriptor = Object.getOwnPropertyDescriptor(caught, 'candidateBootDiagnostic');
      assert.deepEqual(descriptor?.value, {
        stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
      });
      assert.deepEqual({
        configurable: descriptor?.configurable,
        enumerable: descriptor?.enumerable,
        writable: descriptor?.writable
      }, { configurable: false, enumerable: false, writable: false });
      assert.doesNotMatch(JSON.stringify(caught), /private|current\.jar/i);
    });
  }
});

test('a reused error object cannot preserve the first candidate retry diagnostic', async t => {
  const readyError = new ModpackError('HEALTH_CHECK_FAILED', 'Server process health check failed');
  const handles = [
    new FakeHealthHandle({ pid: 5401, readyError }),
    new FakeHealthHandle({ pid: 5402, readyError })
  ];
  let launch = 0;
  const value = fixture(t, {
    handles,
    onLaunch(request) {
      launch += 1;
      request.onLine(Object.freeze({
        line: launch === 1
          ? 'OutOfMemoryError: Java heap space C:\\private\\first-attempt'
          : 'ModLoadingException: Failed to load mod C:\\private\\final-attempt.jar',
        operationId: 'health-candidate-test',
        pid: launch === 1 ? 5401 : 5402,
        stream: 'stderr'
      }));
    }
  });
  let caught = null;

  await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), error => {
    caught = error;
    return error?.code === 'HEALTH_CHECK_FAILED';
  });

  assert.equal(value.launchCalls.length, 2);
  assert.notEqual(caught, readyError);
  assert.deepEqual(Object.getOwnPropertyDescriptor(readyError, 'candidateBootDiagnostic')?.value, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'out-of-memory'
  });
  const finalDescriptor = Object.getOwnPropertyDescriptor(caught, 'candidateBootDiagnostic');
  assert.deepEqual(finalDescriptor?.value, {
    stage: 'candidate-boot', boundary: 'readiness', category: 'mod-loading-failure'
  });
  assert.deepEqual({
    configurable: finalDescriptor?.configurable,
    enumerable: finalDescriptor?.enumerable,
    writable: finalDescriptor?.writable
  }, { configurable: false, enumerable: false, writable: false });
  assert.doesNotMatch(JSON.stringify(caught), /private|first-attempt|final-attempt/i);
});

test('candidate validation rejects premature liveness, bind conflicts, timeout, and cancellation with cleanup', async t => {
  const dead = fixture(t, { handleOptions: { isLiveImpl: call => call === 1 } });
  await assert.rejects(dead.validator.validateCandidate(candidateRequest(dead)), healthFailure);
  assert.equal(dead.handle.stopCalls.length, 2);

  const bindError = Object.assign(new Error('listen EADDRINUSE C:\\secret'), { code: 'EADDRINUSE' });
  const bind = fixture(t, { launchError: bindError });
  const bindOriginal = fs.readFileSync(bind.propertiesPath);
  await assert.rejects(bind.validator.validateCandidate(candidateRequest(bind)), healthFailure);
  assert.equal(bind.launchCalls.length, 1);
  assert.deepEqual(fs.readFileSync(bind.propertiesPath), bindOriginal);

  const timeoutError = Object.assign(new Error('timed out C:\\secret'), { code: 'HEALTH_CHECK_FAILED' });
  const timeout = fixture(t, { handleOptions: { readyError: timeoutError } });
  await assert.rejects(timeout.validator.validateCandidate(candidateRequest(timeout)), healthFailure);
  assert.equal(timeout.handle.stopCalls.length, 2);

  const cancelledError = Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
  const cancelled = fixture(t, { handleOptions: { readyError: cancelledError } });
  let observedCancellation = null;
  await assert.rejects(
    cancelled.validator.validateCandidate(candidateRequest(cancelled)),
    error => {
      observedCancellation = error;
      return error.code === 'CANCELLED';
    }
  );
  assert.equal(cancelled.handle.stopCalls.length, 1);
  assert.equal(Object.hasOwn(observedCancellation, 'candidateBootDiagnostic'), false);
  assert.equal(JSON.stringify(cancelled.leaseCalls).includes('secret'), false);
});

test('candidate property write and restore failures fail closed without exposing paths', async t => {
  const baseFileSystem = {
    exists: fs.existsSync,
    readFileBounded(filePath, { maxBytes }) {
      const stat = fs.statSync(filePath);
      if (stat.size > maxBytes) throw new Error('file exceeds the configured test limit');
      const bytes = fs.readFileSync(filePath);
      if (bytes.length > maxBytes) throw new Error('file exceeds the configured test limit');
      return bytes;
    },
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
  let failure;
  await assert.rejects(value.validator.validateCandidate(candidateRequest(value)), error => {
    failure = error;
    return healthFailure(error);
  });
  assert.equal(isUnprovenHealthProcessError(failure), true);
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
    assert.equal(candidate.leaseCalls.filter(call => call === 'release').length, 2);

    const live = fixture(t, {
      handleOptions: { pid: 5300 + index, stopResult },
      pingResult: { description: 'Live server', players: null, version: null }
    });
    await assert.rejects(live.validator.validateLive(liveRequest(live)), healthFailure);
    assert.equal(live.leaseCalls.filter(call => call === 'release').length, 1);
  }
});

test('stopped live validation probes privately, leaves properties untouched, and restores the prior stopped policy', async t => {
  const original = Buffer.from('# live exact\nserver-port=25570\nmotd=Visible MOTD\n');
  const value = fixture(t, { properties: original });
  const result = await value.validator.validateLive(liveRequest(value));

  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
  assert.equal(result.evidence.kind, 'live');
  assert.match(result.evidence.motdNonce, /^minecraft-core-health:/u);
  assert.equal(result.evidence.handedOff, false);
  assert.equal(result.evidence.pongMatched, true);
  assert.equal(result.handoff, null);
  assert.equal(value.handle.stopCalls.length, 1);
  assert.deepEqual(value.leaseCalls, ['dirty', 'running:5100', 'dirty', 'release']);
  assert.equal(value.launchCalls[0].serverPath, value.serverPath);
  assert.equal(value.launchCalls[0].publishEvents, false);
  assert.deepEqual(value.handle.ownerCalls[0], {
    host: '127.0.0.1',
    port: 34567,
    signal: undefined,
    timeoutMs: 1000
  });
});

test('stopped live validation uses a private nonce endpoint and restores absent properties exactly', async t => {
  let overlay = null;
  const value = fixture(t, {
    properties: null,
    onLaunch(_request, propertiesPath) {
      overlay = parseProperties(fs.readFileSync(propertiesPath, 'utf8'));
    }
  });

  const result = await value.validator.validateLive(liveRequest(value));

  assert.equal(overlay['server-ip'], '127.0.0.1');
  assert.equal(overlay['server-port'], '34567');
  assert.match(overlay.motd, /^minecraft-core-health:/u);
  assert.equal(result.evidence.kind, 'live');
  assert.equal(result.evidence.endpoint.port, 34567);
  assert.equal(result.evidence.motdNonce, overlay.motd);
  assert.equal(fs.existsSync(value.propertiesPath), false);
});

test('live keep-running returns the exact child and start lease handoff until child close', async t => {
  let launchProperties = null;
  const original = Buffer.from('# exact original\r\nmotd=Original\r\nserver-port=25565\r\n');
  const value = fixture(t, {
    properties: original,
    pingResult: { description: 'Live server', players: null, version: null },
    onLaunch(_request, propertiesPath) {
      launchProperties = parseProperties(fs.readFileSync(propertiesPath, 'utf8'));
    }
  });
  const result = await value.validator.validateLive(liveRequest(value, { keepRunning: true }));

  assert.equal(launchProperties['server-port'], '25570');
  assert.equal(launchProperties.motd, 'Original');
  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
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

test('live keep-running boots on the configured port when server properties were initially absent', async t => {
  let launchProperties = null;
  const value = fixture(t, {
    properties: null,
    onLaunch(_request, propertiesPath) {
      launchProperties = parseProperties(fs.readFileSync(propertiesPath, 'utf8'));
    }
  });

  const result = await value.validator.validateLive(liveRequest(value, {
    keepRunning: true,
    port: 25570
  }));

  assert.equal(launchProperties['server-port'], '25570');
  assert.equal(launchProperties['server-ip'], undefined);
  assert.equal(fs.existsSync(value.propertiesPath), false);
  assert.deepEqual(value.handle.ownerCalls[0], {
    allowWildcard: true,
    host: '127.0.0.1',
    port: 25570,
    signal: undefined,
    timeoutMs: 1000
  });
  assert.equal(result.evidence.handedOff, true);
  await stopValidatedHandoff(result.handoff);
});

test('live keep-running applies reviewed loopback access for boot and probes the loopback endpoint', async t => {
  let launchProperties = null;
  const original = Buffer.from('server-ip=192.0.2.10\nserver-port=25565\nmotd=Original\n');
  const value = fixture(t, {
    properties: original,
    pingResult: { description: 'Live server', players: null, version: null },
    onLaunch(_request, propertiesPath) {
      launchProperties = parseProperties(fs.readFileSync(propertiesPath, 'utf8'));
    }
  });

  const result = await value.validator.validateLive(liveRequest(value, {
    keepRunning: true,
    networkAccess: 'loopback',
    port: 25571
  }));

  assert.equal(launchProperties['server-ip'], '127.0.0.1');
  assert.equal(launchProperties['server-port'], '25571');
  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
  assert.deepEqual(value.handle.ownerCalls[0], {
    host: '127.0.0.1',
    port: 25571,
    signal: undefined,
    timeoutMs: 1000
  });
  assert.deepEqual(result.evidence.endpoint, { host: '127.0.0.1', port: 25571 });
  await stopValidatedHandoff(result.handoff);
});

test('pack-default live health probes the effective last Java-properties server-ip value', async t => {
  const original = Buffer.from([
    'server-ip=192.0.2.10',
    'server\\u002dip 127.0.0.' + '\\',
    '    \\u0031',
    'server-port:25571',
    'motd=Original'
  ].join('\r\n') + '\r\n', 'utf8');
  const value = fixture(t, {
    properties: original,
    pingResult: { description: 'Live server', players: null, version: null }
  });

  const result = await value.validator.validateLive(liveRequest(value, {
    keepRunning: true,
    networkAccess: 'pack-default',
    port: 25571
  }));

  assert.deepEqual(value.handle.ownerCalls[0], {
    host: '127.0.0.1',
    port: 25571,
    signal: undefined,
    timeoutMs: 1000
  });
  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
  await stopValidatedHandoff(result.handoff);
});

test('new canonical live validation marks an unclosed failed child as recovery-only', async t => {
  const value = fixture(t, {
    handleOptions: {
      readyError: new ModpackError('HEALTH_CHECK_FAILED', 'injected readiness failure'),
      stopResult: { clean: false, closed: false, exitCode: null, forced: true, signal: null }
    }
  });
  let failure;
  await assert.rejects(
    value.validator.validateLive(liveRequest(value, { keepRunning: true })),
    error => {
      failure = error;
      return healthFailure(error);
    }
  );

  assert.equal(isUnprovenHealthProcessError(failure), true);
  assert.equal(value.leaseCalls.includes('release'), false);
  value.handle.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.leaseCalls.filter(call => call === 'release').length, 1);
});

test('stopping an unadopted live handoff closes the exact child and releases its retained start lease', async t => {
  const value = fixture(t);
  const result = await value.validator.validateLive(liveRequest(value, { keepRunning: true }));

  const shutdown = await stopValidatedHandoff(result.handoff);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(shutdown.closed, true);
  assert.equal(value.handle.live, false);
  assert.equal(value.handle.stopCalls.length, 1);
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

test('live keep-running restores pack property bytes even when the boot rewrites them', async t => {
  const changedProperties = fixture(t, {
    async onPing(_request, propertiesPath) {
      fs.appendFileSync(propertiesPath, 'late-change=true\n');
    },
    pingResult: { description: 'Live server', players: null, version: null }
  });
  const originalProperties = fs.readFileSync(changedProperties.propertiesPath);
  const result = await changedProperties.validator.validateLive(liveRequest(changedProperties, { keepRunning: true }));

  assert.deepEqual(fs.readFileSync(changedProperties.propertiesPath), originalProperties);
  assert.equal(changedProperties.handle.live, true);
  await stopValidatedHandoff(result.handoff);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changedProperties.leaseCalls.filter(call => call === 'release').length, 1);
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

test('managed runtime verification receives the remaining health deadline and its exact result reaches launch', async t => {
  let now = 1000;
  let verificationRequest = null;
  const validation = runtimeValidation();
  const value = fixture(t, {
    clock: () => now,
    async resolveJavaPath() {
      now = 1025;
      return 'C:\\Java\\bin\\java.exe';
    },
    async verifyRuntime(request) {
      verificationRequest = request;
      now = 1040;
      return validation;
    }
  });

  await value.validator.validateCandidate(candidateRequest(value, { timeoutMs: 100 }));

  assert.deepEqual(verificationRequest, {
    targetPath: value.serverPath,
    runtime: RUNTIME,
    signal: undefined,
    timeoutMs: 75
  });
  assert.equal(value.launchCalls[0].runtimeValidation, validation);
  assert.equal(value.handle.readyRequest.timeoutMs, 60);
});

test('a runtime verification result that arrives after the absolute deadline never reaches process spawn', async t => {
  let now = 1000;
  let verificationTimeout = null;
  const value = fixture(t, {
    clock: () => now,
    async verifyRuntime({ timeoutMs }) {
      verificationTimeout = timeoutMs;
      now = 1021;
      return runtimeValidation();
    }
  });

  await assert.rejects(
    value.validator.validateCandidate(candidateRequest(value, { timeoutMs: 20 })),
    healthFailure
  );
  assert.equal(verificationTimeout, 20);
  assert.equal(value.launchCalls.length, 0);
  assert.equal(value.leaseCalls.filter(call => call === 'release').length, 1);
});

test('cancelling runtime verification aborts the worker seam, restores properties, and never launches', async t => {
  const controller = new AbortController();
  const verificationStarted = deferred();
  let verificationSignal = null;
  const value = fixture(t, {
    verifyRuntime({ signal }) {
      verificationSignal = signal;
      verificationStarted.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.code = 'CANCELLED';
          reject(error);
        }, { once: true });
      });
    }
  });
  const original = fs.readFileSync(value.propertiesPath);

  const validation = value.validator.validateCandidate(candidateRequest(value, {
    signal: controller.signal
  }));
  await verificationStarted.promise;
  controller.abort();

  await assert.rejects(validation, error => error.code === 'CANCELLED');
  assert.equal(verificationSignal, controller.signal);
  assert.equal(value.launchCalls.length, 0);
  assert.deepEqual(fs.readFileSync(value.propertiesPath), original);
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
    { timeoutMs: 30 * 60_000 + 1 },
    { forgeCandidateHealthAuthorization: false },
    { forgeCandidateHealthAuthorization: {} },
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
  await assert.rejects(
    value.validator.validateLive({ ...liveRequest(value), forgeCandidateHealthAuthorization: {} }),
    error => error.code === 'INVALID_REQUEST'
  );
  assert.equal(value.acquireCalls.length, 0);
  assert.equal(value.launchCalls.length, 0);
});
