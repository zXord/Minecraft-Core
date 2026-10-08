const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
let diagnostics;
try { diagnostics = require('../electron/services/runtime-diagnostic.cjs'); } catch {}
const managed = require('../electron/services/managed-runtime-worker-protocol.cjs');
const forge = require('../electron/services/forge-installer-worker-protocol.cjs');
const finalizer = require('../electron/services/forge-runtime-finalizer-worker-protocol.cjs');
const token = 'a'.repeat(64), requestId = 'b'.repeat(32);
const runtime = { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13',
  javaMajor: 17, os: 'win32', architecture: 'x64' };
const diagnostic = { stage: 'finalizer-publish', reason: 'io', osCode: 'EACCES' };
const variants = [
  { name: 'managed', create: d => managed.createManagedRuntimeResponse({ token, requestId,
    operation: managed.MANAGED_RUNTIME_PREPARE_OPERATION, ok: false, code: 'RUNTIME_INCOMPLETE', runtimeDiagnostic: d }),
    verify: m => managed.verifyManagedRuntimeResponse(m, token, requestId, managed.MANAGED_RUNTIME_PREPARE_OPERATION, runtime),
    factory: require('../electron/services/managed-runtime-worker-client.cjs').createManagedRuntimeWorkerClient,
    options: { operation: managed.MANAGED_RUNTIME_PREPARE_OPERATION, targetPath: path.join(os.tmpdir(), 'diagnostic-not-created'), runtime,
      javaPath: path.join(os.tmpdir(), 'diagnostic-not-created', 'java.exe') } },
  { name: 'forge', create: d => forge.createForgeInstallResponse({ token, requestId, ok: false, runtimeDiagnostic: d }),
    verify: m => forge.verifyForgeInstallResponse(m, token, requestId),
    factory: require('../electron/services/forge-installer-worker-client.cjs').createForgeInstallerWorkerClient,
    options: { targetPath: path.join(os.tmpdir(), 'diagnostic-not-created'), minecraftVersion: '1.20.1', loaderVersion: '47.4.13',
      javaPath: path.join(os.tmpdir(), 'diagnostic-not-created', 'java.exe') } },
  { name: 'finalizer', create: d => finalizer.createForgeFinalizerResponse({ token, requestId, ok: false, runtimeDiagnostic: d }),
    verify: m => finalizer.verifyForgeFinalizerResponse(m, token, requestId, runtime),
    factory: require('../electron/services/forge-runtime-finalizer-worker-client.cjs').createForgeRuntimeFinalizerWorkerClient,
    options: { targetPath: path.join(os.tmpdir(), 'diagnostic-not-created'), runtime } }
];

for (const v of variants) {
  test(`${v.name}: failure diagnostic is versioned, authenticated and strictly bounded`, () => {
    const message = v.create(diagnostic);
    assert.equal(message.protocolVersion, 2);
    assert.deepEqual(v.verify(message).runtimeDiagnostic, diagnostic);
    assert.throws(() => v.verify({ ...message, runtimeDiagnostic: { ...diagnostic, osCode: 'EPERM' } }));
    for (const bad of [ { ...diagnostic, path: 'C:/private' }, { ...diagnostic, message: 'secret' },
      { ...diagnostic, stage: 'x'.repeat(100000) }, { ...diagnostic, reason: 'raw stack' },
      { ...diagnostic, osCode: 'C:/private' }, { ...diagnostic, changedIdentityFields: 64 },
      { stage: 'finalizer-artifact-digest', reason: 'identity-changed', changedIdentityFields: 256 },
      Object.assign(Object.create({ secret: true }), diagnostic) ]) {
      assert.throws(() => v.create(bad));
      assert.throws(() => v.verify({ ...message, runtimeDiagnostic: bad }));
    }
    assert.throws(() => v.verify({ ...message, protocolVersion: 1 }));
  });
  test(`${v.name}: main error receives only the authenticated normalized diagnostic at exact close`, async () => {
    const child = new EventEmitter();
    child.send = (_m, cb) => cb?.(null); child.kill = () => true; child.disconnect = () => {};
    const run = v.factory({ forkImpl: () => child, tokenFactory: () => token, requestIdFactory: () => requestId });
    const pending = run(v.options).catch(e => e);
    child.emit('message', v.create(diagnostic));
    child.emit('close', 1, null);
    assert.deepEqual((await pending).runtimeDiagnostic, diagnostic);
  });
}

test('normalizer rejects raw details and accessor objects without invoking getters', () => {
  assert.equal(typeof diagnostics?.normalizeRuntimeDiagnostic, 'function');
  let accessed = false;
  const value = { stage: 'forge-installer', get reason() { accessed = true; return 'unknown'; } };
  assert.throws(() => diagnostics.normalizeRuntimeDiagnostic(value));
  assert.equal(accessed, false);
  const result = diagnostics.normalizeRuntimeDiagnostic(diagnostic);
  assert.deepEqual(result, diagnostic);
  assert.notEqual(result, diagnostic);
});

test('diagnostic extraction cannot replace a failure when its metadata descriptor traps', () => {
  const error = new Proxy(new Error('private'), { getOwnPropertyDescriptor() { throw new Error('private trap'); } });
  assert.deepEqual(diagnostics.runtimeDiagnosticFor(error, 'forge-installer'), { stage: 'forge-installer', reason: 'unknown' });
});

function loadInstallErrorNormalizer() {
  // Execute the exact private production function without adding a test API or
  // entering an installer. Only this test-local module instance exposes it.
  const Module = require('node:module');
  const filename = require.resolve('../electron/services/loader-install-service.cjs');
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = Module._nodeModulePaths(path.dirname(filename));
  isolated._compile(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports = normalizeRuntimeInstallError;`, filename);
  return isolated.exports;
}

for (const provenClose of [true, false]) test(`install-error normalizer bypasses throwing diagnostic getter and preserves exact ${provenClose ? 'settled' : 'unsettled'} close proof`, async () => {
  const { retainRuntimeWorkerQuiescence, waitForRuntimeWorkerQuiescence } = require('../electron/services/runtime-worker-quiescence.cjs');
  const normalize = loadInstallErrorNormalizer();
  const original = Object.assign(new Error('original private failure'), { code: 'CANCELLED' });
  let getterCalls = 0, close;
  Object.defineProperty(original, 'runtimeDiagnostic', { get() { getterCalls += 1; throw new Error('metadata getter replaced failure'); } });
  retainRuntimeWorkerQuiescence(original, new Promise(resolve => { close = resolve; }));
  const normalized = normalize(original);
  assert.equal(getterCalls, 0);
  assert.equal(original.code, 'CANCELLED');
  assert.equal(normalized.code, 'CANCELLED');
  assert.equal(normalized.preserveWorkspace, true);
  assert.deepEqual(normalized.runtimeDiagnostic, { stage: 'unknown', reason: 'unknown' });
  let finished = false;
  const proof = waitForRuntimeWorkerQuiescence(normalized).then(() => { finished = true; }, error => { finished = true; throw error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'normalization must retain the actual pending close, not invent settlement');
  close(provenClose);
  if (provenClose) {
    await proof;
    await waitForRuntimeWorkerQuiescence(original);
  } else {
    await assert.rejects(proof, error => error.code === 'RECOVERY_REQUIRED' && error.cause === normalized);
    await assert.rejects(waitForRuntimeWorkerQuiescence(original), error => error.code === 'RECOVERY_REQUIRED' && error.cause === original);
  }
});

for (const hasDiagnostic of [false, true]) test(`install-error normalizer preserves ${hasDiagnostic ? 'the original bounded diagnostic' : 'the absent diagnostic shape'} and first failure code`, () => {
  const original = Object.assign(new Error('original private failure'), { code: 'LOADER_VERSION_UNAVAILABLE' });
  if (hasDiagnostic) original.runtimeDiagnostic = diagnostic;
  const normalized = loadInstallErrorNormalizer()(original);
  assert.equal(normalized.code, 'LOADER_VERSION_UNAVAILABLE');
  assert.equal(original.code, 'LOADER_VERSION_UNAVAILABLE');
  assert.equal(Object.hasOwn(normalized, 'runtimeDiagnostic'), hasDiagnostic);
  if (hasDiagnostic) {
    assert.deepEqual(normalized.runtimeDiagnostic, { stage: 'finalizer-publish', reason: 'io', osCode: 'EACCES' });
    assert.notEqual(normalized.runtimeDiagnostic, original.runtimeDiagnostic);
  }
});

test('outer stage preserves proven innermost diagnostic and strips arbitrary incoming details', async () => {
  assert.equal(typeof diagnostics?.runRuntimeStage, 'function');
  const cause = Object.assign(new Error('private stack'), { runtimeDiagnostic: diagnostic });
  await assert.rejects(diagnostics.runRuntimeStage('forge-installer', async () => { throw cause; }), e => {
    assert.equal(e, cause); assert.deepEqual(e.runtimeDiagnostic, diagnostic); return true;
  });
  const unsafe = Object.assign(new Error('private'), { code: 'EACCES', runtimeDiagnostic: { ...diagnostic, token: 'secret' } });
  await assert.rejects(diagnostics.runRuntimeStage('forge-installer', async () => { throw unsafe; }), e => {
    assert.deepEqual(e.runtimeDiagnostic, { stage: 'forge-installer', reason: 'io', osCode: 'EACCES' }); return true;
  });
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diagnostic-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync.native(root);
}

test('Java validation failure receives its observed loader stage without running installation', async t => {
  const root = fixture(t);
  const service = require('../electron/services/loader-install-service.cjs');
  await assert.rejects(service.__testUtils.prepareManagedServerRuntimeInProcess({ targetPath: root, runtime,
    javaPath: path.join(root, 'fake-java.exe'), validateJava: async () => { throw Object.assign(new Error('private'), { code: 'ENOENT' }); },
    installServerLoaderImpl: async () => assert.fail('installation must not run') }), e => {
    assert.deepEqual(e.runtimeDiagnostic, { stage: 'java-validation', reason: 'io', osCode: 'ENOENT' }); return true;
  });
});

test('finalizer preserves digest identity evidence with exact changed-field bitmask', t => {
  const root = fixture(t), relative = 'libraries/net/minecraftforge/forge/1.20.1-47.4.13/win_args.txt';
  const artifact = path.join(root, relative);
  fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, 'fixture');
  const fsApi = { ...fs, fstatSync(fd) { const st = fs.fstatSync(fd); st.ctimeMs += 1; return st; } };
  assert.throws(() => require('../electron/services/loader-install-service.cjs').__testUtils.finalizeForgeRuntimeMetadata(root, runtime, { fsApi }), e => {
    assert.deepEqual(e.runtimeDiagnostic, { stage: 'finalizer-artifact-digest', reason: 'identity-changed', changedIdentityFields: 64 });
    assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state', 'runtime.json')), false); return true;
  });
});

class ProcessDouble extends EventEmitter {
  constructor(env) { super(); this.env = env; this.connected = true; this.responses = []; }
  send(m, cb) { this.responses.push(m); cb?.(null); }
  disconnect() { this.connected = false; this.emit('disconnect'); }
  exit() {}
}
test('managed worker transports nested diagnostics without raw error contents', async t => {
  const root = fixture(t), javaPath = path.join(root, 'fake-java.exe'); fs.writeFileSync(javaPath, 'fixture');
  const proc = new ProcessDouble({ [managed.MANAGED_RUNTIME_WORKER_TOKEN_ENV]: token });
  require('../electron/services/managed-runtime-worker.cjs').startManagedRuntimeWorker({ processRef: proc,
    prepareRuntimeImpl: async () => { throw Object.assign(new Error('private token and path'), { runtimeDiagnostic: diagnostic }); } });
  proc.emit('message', managed.createManagedRuntimeRequest({ token, requestId, operation: managed.MANAGED_RUNTIME_PREPARE_OPERATION,
    payload: { targetPath: root, runtime, javaPath } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(variants[0].verify(proc.responses[0]).runtimeDiagnostic, diagnostic);
  assert.equal(JSON.stringify(proc.responses[0]).includes('private'), false);
});

test('non-finalizer digest failures do not falsely claim a finalizer stage and retain only OS codes', t => {
  const root = fixture(t), artifact = path.join(root, 'server.jar'); fs.writeFileSync(artifact, 'fixture');
  const digest = require('../electron/services/loader-install-service.cjs').__testUtils.digestStableArtifact;
  const fsApi = { ...fs, fstatSync() { throw Object.assign(new Error('private path'), { code: 'EIO' }); } };
  assert.throws(() => digest(root, artifact, { fsApi }), e => {
    assert.deepEqual(e.runtimeDiagnostic, { stage: 'artifact-digest', reason: 'io', osCode: 'EIO' }); return true;
  });
});

for (const [changeAt, stage, published] of [
  [3, 'finalizer-stability-before-publish', false], [4, 'finalizer-stability-after-publish', true]
]) test(`${stage}: identity diagnostic describes actual observed ctime change`, t => {
  const root = fixture(t), artifact = path.join(root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.13/win_args.txt');
  fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, 'fixture');
  let calls = 0;
  const fsApi = { ...fs, lstatSync(file) { const st = fs.lstatSync(file); if (file === artifact && ++calls >= changeAt) st.ctimeMs += 1; return st; } };
  assert.throws(() => require('../electron/services/loader-install-service.cjs').__testUtils.finalizeForgeRuntimeMetadata(root, runtime, { fsApi }), e => {
    assert.deepEqual(e.runtimeDiagnostic, { stage, reason: 'identity-changed', changedIdentityFields: 64 }); return true;
  });
  assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state/runtime.json')), published);
});

test('finalizer publication failure retains bounded OS code rather than file paths', t => {
  const root = fixture(t), artifact = path.join(root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.13/win_args.txt');
  fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, 'fixture');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(root, '.minecraft-core-state/runtime.json')) throw Object.assign(new Error('private path'), { code: 'EACCES' });
    return rename(from, to);
  });
  assert.throws(() => require('../electron/services/loader-install-service.cjs').__testUtils.finalizeForgeRuntimeMetadata(root, runtime), e => {
    assert.deepEqual(e.runtimeDiagnostic, diagnostic); return true;
  });
});

test('finalizer stability IO error retains its observed boundary and bounded code', t => {
  const root = fixture(t), artifact = path.join(root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.13/win_args.txt');
  fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, 'fixture');
  let calls = 0;
  const fsApi = { ...fs, lstatSync(file) {
    if (file === artifact && ++calls === 3) throw Object.assign(new Error('private'), { code: 'EBUSY' });
    return fs.lstatSync(file);
  } };
  assert.throws(() => require('../electron/services/loader-install-service.cjs').__testUtils.finalizeForgeRuntimeMetadata(root, runtime, { fsApi }), e => {
    assert.deepEqual(e.runtimeDiagnostic, { stage: 'finalizer-stability-before-publish', reason: 'io', osCode: 'EBUSY' }); return true;
  });
});

test('finalizer readback mismatch reports its boundary without transporting changed metadata', t => {
  const root = fixture(t), artifact = path.join(root, 'libraries/net/minecraftforge/forge/1.20.1-47.4.13/win_args.txt');
  fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, 'fixture');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => file === path.join(root, '.minecraft-core-state/runtime.json') ? Buffer.from('{}') : read(file, ...args));
  assert.throws(() => require('../electron/services/loader-install-service.cjs').__testUtils.finalizeForgeRuntimeMetadata(root, runtime), e => {
    assert.deepEqual(e.runtimeDiagnostic, { stage: 'finalizer-readback', reason: 'unknown' }); return true;
  });
});

test('Forge and finalizer workers preserve nested failure stage through their own catches', async () => {
  for (const kind of ['forge', 'finalizer']) {
    const isForge = kind === 'forge', proc = new ProcessDouble({ [isForge ? forge.FORGE_WORKER_TOKEN_ENV : finalizer.FORGE_FINALIZER_TOKEN_ENV]: token });
    const fail = () => { throw Object.assign(new Error('private path'), { runtimeDiagnostic: diagnostic }); };
    if (isForge) {
      require('../electron/services/forge-installer-worker.cjs').startForgeInstallerWorker({ processRef: proc, installForgeImpl: fail });
      proc.emit('message', forge.createForgeInstallRequest({ token, requestId, payload: variants[1].options }));
    } else {
      require('../electron/services/forge-runtime-finalizer-worker.cjs').startForgeRuntimeFinalizerWorker({ processRef: proc, finalizeForgeRuntimeImpl: fail });
      proc.emit('message', finalizer.createForgeFinalizerRequest({ token, requestId, payload: variants[2].options }));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(variants[isForge ? 1 : 2].verify(proc.responses[0]).runtimeDiagnostic, diagnostic);
    assert.equal(JSON.stringify(proc.responses[0]).includes('private'), false);
  }
});

for (const v of variants.slice(0, 2)) test(`${v.name}: late diagnostic cannot replace cancellation or restart its grace timer`, async t => {
  const child = new EventEmitter(); child.send = (_m, cb) => cb?.(null); child.kill = () => true; child.disconnect = () => {};
  const controller = new AbortController();
  const schedules = t.mock.method(global, 'setTimeout');
  const pending = v.factory({ forkImpl: () => child, tokenFactory: () => token, requestIdFactory: () => requestId })({ ...v.options, signal: controller.signal }).catch(e => e);
  controller.abort(); const count = schedules.mock.callCount();
  child.emit('message', v.create(diagnostic));
  assert.equal(schedules.mock.callCount(), count);
  child.emit('close', 1, null);
  const error = await pending;
  assert.equal(error.code, 'CANCELLED'); assert.equal(error.runtimeDiagnostic, undefined);
});

for (const v of variants.slice(0, 2)) test(`${v.name}: controlled Node IPC fixture transports failure-v2 and emits exact close`, { timeout: 3000 }, async () => {
  const run = v.factory({ workerPath: path.join(__dirname, 'fixtures/authenticated-runtime-failure-worker.cjs') });
  const error = await run({ ...v.options, timeoutMs: 1000, terminationGraceMs: 1000 }).catch(e => e);
  assert.equal(error.code, 'RUNTIME_INCOMPLETE');
  assert.deepEqual(error.runtimeDiagnostic, { stage: v.name === 'managed' ? 'managed-verify' : 'forge-installer', reason: 'unknown' });
  await require('../electron/services/runtime-worker-quiescence.cjs').waitForRuntimeWorkerQuiescence(error);
});

for (const [failurePoint, expectedStage] of [
  ['base', 'base-preparation'], ['installer', 'forge-installer'], ['libraries', 'forge-library-completion']
]) test(`loader observed ${expectedStage} boundary is retained without invoking any external operation`, async t => {
  const root = fixture(t), Module = require('node:module');
  const servicePath = require.resolve('../electron/services/loader-install-service.cjs');
  const originalLoad = Module._load, priorService = require.cache[servicePath];
  const installer = require('@xmcl/installer'), core = require('@xmcl/core');
  const failure = Object.assign(new Error('private'), { code: 'EIO' });
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === servicePath) {
      if (request === 'https') return { get(_url, callback) {
        const response = new EventEmitter(); response.statusCode = 200;
        callback(response); queueMicrotask(() => {
          response.emit('data', Buffer.from(JSON.stringify({ versions: [{ id: '1.20.1', url: 'https://example.invalid/unused' }] })));
          response.emit('end');
        }); return new EventEmitter();
      } };
      if (request === '@xmcl/installer') return { ...installer,
        installVersion: async () => { if (failurePoint === 'base') throw failure; },
        installLibraries: async () => { if (failurePoint === 'libraries') throw failure; } };
      if (request === '@xmcl/core') return { ...core, Version: { ...core.Version, parse: async () => ({ libraries: [] }) } };
      if (request === './forge-installer-worker-client.cjs') return { runForgeInstallerWorker: async () => { if (failurePoint === 'installer') throw failure; } };
      if (request === './forge-runtime-finalizer-worker-client.cjs' || request === './managed-runtime-worker-client.cjs') {
        return new Proxy({}, { get() { return () => assert.fail('unrequested worker boundary'); } });
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[servicePath];
  try {
    const service = require(servicePath);
    await assert.rejects(service.installServerLoader({ targetPath: root, loader: 'forge', minecraftVersion: '1.20.1', loaderVersion: '47.4.13' }), e => {
      assert.equal(e, failure); assert.deepEqual(e.runtimeDiagnostic, { stage: expectedStage, reason: 'io', osCode: 'EIO' }); return true;
    });
  } finally {
    Module._load = originalLoad; delete require.cache[servicePath]; if (priorService) require.cache[servicePath] = priorService;
  }
});

test('finalizer boundary failure without a child envelope still identifies the observed parent boundary', async t => {
  const root = fixture(t), Module = require('node:module');
  const servicePath = require.resolve('../electron/services/loader-install-service.cjs');
  const load = Module._load, prior = require.cache[servicePath];
  const failure = new Error('private worker startup failure');
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === servicePath && request === './forge-runtime-finalizer-worker-client.cjs') return {
      runForgeRuntimeFinalizerWorker: async () => { throw failure; }
    };
    return load.call(this, request, parent, isMain);
  };
  delete require.cache[servicePath];
  try {
    await assert.rejects(require(servicePath).__testUtils.prepareManagedServerRuntimeInProcess({ targetPath: root,
      runtime, javaPath: path.join(root, 'fake-java.exe'), validateJava: async () => 17,
      installServerLoaderImpl: async () => ({ success: true }) }), e => {
      assert.equal(e, failure); assert.deepEqual(e.runtimeDiagnostic, { stage: 'forge-finalizer', reason: 'unknown' }); return true;
    });
  } finally {
    Module._load = load; delete require.cache[servicePath]; if (prior) require.cache[servicePath] = prior;
  }
});
