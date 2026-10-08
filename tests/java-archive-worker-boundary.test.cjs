const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { createJavaArchiveWorkerClient } = require('../electron/services/java-archive-worker-client.cjs');

async function withJavaArchiveWorkerMock(runJavaArchiveWorker, work) {
  const managerPath = require.resolve('../electron/services/minecraft-launcher/java-manager.cjs');
  const originalLoad = Module._load;
  Module._load = function javaArchiveBoundaryLoad(request, parent, isMain) {
    if (request === '../java-archive-worker-client.cjs' && parent?.filename === managerPath) {
      return { runJavaArchiveWorker };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[managerPath];
  try {
    return await work(require(managerPath).JavaManager);
  } finally {
    delete require.cache[managerPath];
    Module._load = originalLoad;
  }
}

test('production Java ZIP extraction delegates to a child while main-process timers remain live', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-java-archive-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const javaRoot = path.join(root, 'java');
  const tempRoot = path.join(javaRoot, 'temp');
  const archivePath = path.join(tempRoot, 'runtime.zip');
  const destinationPath = path.join(javaRoot, 'java-17');
  fs.mkdirSync(tempRoot, { recursive: true });
  const archiveBytes = Buffer.from('verified fixture archive');
  fs.writeFileSync(archivePath, archiveBytes);
  const controller = new AbortController();
  const calls = [];

  await withJavaArchiveWorkerMock(async request => {
    calls.push(request);
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.mkdirSync(path.join(destinationPath, 'bin'), { recursive: true });
    return {
      entryCount: 2,
      expandedBytes: '10',
      javaExecutableRelativePath: 'bin/java.exe'
    };
  }, async JavaManager => {
    const manager = new JavaManager(root, { maxArchiveBytes: 123456 });
    manager.javaBaseDir = javaRoot;
    let timerTicks = 0;
    const timer = setInterval(() => { timerTicks += 1; }, 5);
    try {
      await manager.extractJava(archivePath, 17, { signal: controller.signal });
    } finally {
      clearInterval(timer);
    }
    assert.ok(timerTicks >= 5, `main-process timer advanced only ${timerTicks} times`);
  });

  assert.deepEqual(calls, [{
    rootPath: fs.realpathSync.native(javaRoot),
    archivePath: fs.realpathSync.native(archivePath),
    destinationPath,
    maxArchiveBytes: 123456,
    expectedArchiveSize: archiveBytes.length,
    expectedSha256: require('node:crypto').createHash('sha256').update(archiveBytes).digest('hex'),
    signal: controller.signal
  }]);
});

test('a real forked Java archive child cannot block parent heartbeat timers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-java-archive-liveness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, 'temp');
  const archivePath = path.join(tempRoot, 'runtime.zip');
  fs.mkdirSync(tempRoot);
  const archiveBytes = Buffer.from('java');
  fs.writeFileSync(archivePath, archiveBytes);
  fs.mkdirSync(path.join(root, 'java-17', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'java-17', 'bin', 'java.exe'), 'prior');
  const run = createJavaArchiveWorkerClient({
    workerPath: path.join(__dirname, 'fixtures', 'slow-java-archive-worker.cjs')
  });

  let timerTicks = 0;
  const timer = setInterval(() => { timerTicks += 1; }, 5);
  try {
    assert.deepEqual(await run({
      rootPath: fs.realpathSync.native(root),
      archivePath: fs.realpathSync.native(archivePath),
      destinationPath: path.join(root, 'java-17'),
      maxArchiveBytes: 1024,
      expectedArchiveSize: archiveBytes.length,
      expectedSha256: crypto.createHash('sha256').update(archiveBytes).digest('hex'),
      timeoutMs: 5000,
      terminationGraceMs: 1000
    }), {
      entryCount: 1,
      expandedBytes: '4',
      javaExecutableRelativePath: 'bin/java.exe'
    });
  } finally {
    clearInterval(timer);
  }
  assert.ok(timerTicks >= 10, `parent heartbeat advanced only ${timerTicks} times`);
  assert.equal(fs.readFileSync(path.join(root, 'java-17', 'bin', 'java.exe'), 'utf8'), 'java');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('-previous-')), []);
});

test('cancelling a real extraction child removes staging without touching the prior Java runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-java-archive-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tempRoot = path.join(root, 'temp');
  const archivePath = path.join(tempRoot, 'runtime.zip');
  const destinationPath = path.join(root, 'java-17');
  fs.mkdirSync(tempRoot);
  fs.mkdirSync(path.join(destinationPath, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(destinationPath, 'bin', 'java.exe'), 'prior');
  const archiveBytes = Buffer.from('java');
  fs.writeFileSync(archivePath, archiveBytes);
  const run = createJavaArchiveWorkerClient({
    workerPath: path.join(__dirname, 'fixtures', 'slow-java-archive-worker.cjs')
  });
  const controller = new AbortController();
  const pending = run({
    rootPath: fs.realpathSync.native(root),
    archivePath: fs.realpathSync.native(archivePath),
    destinationPath,
    maxArchiveBytes: 1024,
    expectedArchiveSize: archiveBytes.length,
    expectedSha256: crypto.createHash('sha256').update(archiveBytes).digest('hex'),
    signal: controller.signal,
    timeoutMs: 5000,
    terminationGraceMs: 2000
  });
  const deadline = Date.now() + 3000;
  while (!fs.readdirSync(root).some(name => name.includes('-extract-'))) {
    if (Date.now() >= deadline) throw new Error('slow worker never created its staging directory');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort();

  await assert.rejects(pending, error =>
    error?.code === 'CANCELLED' && !Object.hasOwn(error, 'preserveWorkspace'));
  assert.equal(fs.readFileSync(path.join(destinationPath, 'bin', 'java.exe'), 'utf8'), 'prior');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.includes('-extract-')), []);
});
