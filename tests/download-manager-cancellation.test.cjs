const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { waitForRuntimeWorkerQuiescence } = require('../electron/services/runtime-worker-quiescence.cjs');

class JavaChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
  }
  kill(signal) { this.kills.push(signal); return true; }
}

async function fixture(t, { checkPending = false, body = Readable.from(['installer']) } = {}, work) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-fabric-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const check = new JavaChild();
  const installer = new JavaChild();
  let installerStarted = false;
  let fetchOptions;
  let destinationStream;
  const filename = require.resolve('../electron/services/download-manager.cjs');
  const previous = require.cache[filename];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === filename) {
      if (request === 'fs') return { ...fs, createWriteStream(...args) {
        destinationStream = fs.createWriteStream(...args);
        return destinationStream;
      } };
      if (request === '../utils/safe-send.cjs') return { safeSend() {} };
      if (request === '../utils/fabric-runtime.cjs') return {
        getFabricRuntimeStatus: () => ({ hasBlockingIssues: false, blockingIssues: [] })
      };
      if (request === '../utils/fetch.cjs') return { async fetch(_url, options) {
        fetchOptions = options;
        return { ok: true, status: 200, headers: { get() { return null; } }, body };
      } };
      if (request === 'child_process') return {
        execFile(_command, _args, callback) {
          if (!checkPending) queueMicrotask(() => {
            callback(null, '', 'openjdk version "17"');
            check.emit('close', 0, null);
          });
          return check;
        },
        spawn() { installerStarted = true; return installer; }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[filename];
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const manager = require(filename);
    await work({ manager, root, check, installer,
      installerStarted: () => installerStarted, fetchOptions: () => fetchOptions,
      destinationStream: () => destinationStream });
  } finally {
    clearInterval(keepAlive);
    Module._load = originalLoad;
    delete require.cache[filename];
    if (previous) require.cache[filename] = previous;
    body.destroy();
  }
}

async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected fixture boundary was not reached');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

for (const stage of ['Java check', 'installer']) {
  test(`Fabric cancellation stops its exact ${stage} child and waits for close`, async t => {
    await fixture(t, { checkPending: stage === 'Java check' }, async value => {
      const cancellation = new AbortController();
      let settled = false;
      const pending = value.manager.installFabric(value.root, '1.20.1', '0.16.10', undefined, undefined,
        { signal: cancellation.signal, skipMutationMark: true })
        .catch(error => { settled = true; return error; });
      if (stage === 'installer') await until(value.installerStarted);
      const child = stage === 'installer' ? value.installer : value.check;
      cancellation.abort();
      assert.equal(child.kills.length, 1);
      child.emit('exit', null, 'SIGTERM');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      child.emit('close', null, 'SIGTERM');
      assert.equal((await pending).code, 'CANCELLED');
      if (stage === 'Java check') assert.equal(value.installerStarted(), false);
    });
  });
}

test('Fabric bounded shutdown retains cleanup authority until the late exact child close', async t => {
  await fixture(t, {}, async value => {
    const cancellation = new AbortController();
    const pending = value.manager.installFabric(value.root, '1.20.1', '0.16.10', undefined, undefined,
      { signal: cancellation.signal, skipMutationMark: true, terminationGraceMs: 10 }).catch(error => error);
    await until(value.installerStarted);
    cancellation.abort();
    const error = await pending;
    let quiescent = false;
    const stopped = waitForRuntimeWorkerQuiescence(error).then(() => { quiescent = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quiescent, false);
    assert.deepEqual(value.installer.kills, [undefined, 'SIGKILL']);
    value.installer.emit('close', null, 'SIGKILL');
    await stopped;
    assert.equal(quiescent, true);
  });
});

test('Fabric child errors during cancellation cannot bypass the exact close barrier', async t => {
  await fixture(t, {}, async value => {
    const cancellation = new AbortController();
    let settled = false;
    const pending = value.manager.installFabric(value.root, '1.20.1', '0.16.10', undefined, undefined,
      { signal: cancellation.signal, skipMutationMark: true }).catch(error => { settled = true; return error; });
    await until(value.installerStarted);
    cancellation.abort();
    value.installer.emit('error', Object.assign(new Error('Exact child kill failed'), { code: 'EPERM' }));
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeClose = settled;
    value.installer.emit('close', null, 'SIGKILL');
    const failure = await pending;
    assert.equal(settledBeforeClose, false);
    assert.equal(failure.code, 'CANCELLED');
  });
});

test('Fabric installer download abort waits for its destination stream to close', async t => {
  const body = new PassThrough();
  await fixture(t, { body }, async value => {
    const cancellation = new AbortController();
    const destination = path.join(value.root, 'installer.jar');
    const pending = value.manager.downloadWithProgress('https://fixture.invalid/installer', destination,
      'fixture-progress', { signal: cancellation.signal, skipMutationMark: true }).catch(error => error);
    await until(() => fs.existsSync(destination));
    body.write('partial');
    cancellation.abort();
    assert.equal(value.fetchOptions()?.signal, cancellation.signal);
    const error = await pending;
    assert.equal(error.code, 'CANCELLED');
    assert.equal(body.destroyed, true);
    assert.equal(value.destinationStream().closed, true);
  });
});

test('Fabric success without cancellation still downloads and verifies after installer close', async t => {
  await fixture(t, {}, async value => {
    const pending = value.manager.installFabric(value.root, '1.20.1', '0.16.10', undefined, undefined,
      { skipMutationMark: true });
    await until(value.installerStarted);
    value.installer.emit('close', 0, null);
    assert.equal(await pending, undefined);
    assert.equal(fs.readFileSync(path.join(value.root, 'fabric-installer.jar'), 'utf8'), 'installer');
    assert.equal(value.destinationStream().closed, true);
    assert.deepEqual(value.installer.kills, []);
  });
});
