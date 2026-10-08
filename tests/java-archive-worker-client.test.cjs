const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

let clientModule = null;
let protocol = null;
try {
  clientModule = require('../electron/services/java-archive-worker-client.cjs');
  protocol = require('../electron/services/java-archive-worker-protocol.cjs');
} catch {
  // The first TDD run intentionally reaches the assertions without the modules.
}

const token = 'c'.repeat(64);
const requestId = 'd'.repeat(32);
const rootPath = path.resolve('java-archive-client');

class FakeChild extends EventEmitter {
  constructor(closeOnKill = true) {
    super();
    this.pid = 7474;
    this.closeOnKill = closeOnKill;
    this.connected = true;
    this.sent = [];
    this.killSignals = [];
  }
  send(value, callback) {
    this.sent.push(value);
    queueMicrotask(() => callback?.(null));
    return true;
  }
  kill(signal) {
    this.killSignals.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

function fixture(overrides = {}) {
  return {
    rootPath,
    archivePath: path.join(rootPath, 'temp', 'runtime.zip'),
    destinationPath: path.join(rootPath, 'java-17'),
    maxArchiveBytes: 268435456,
    expectedArchiveSize: 123456,
    expectedSha256: '1'.repeat(64),
    timeoutMs: 1000,
    terminationGraceMs: 100,
    ...overrides
  };
}

function harness() {
  const child = new FakeChild();
  const forks = [];
  const publications = [];
  const taskkills = [];
  const removals = [];
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl(modulePath, args, options) {
      forks.push({ modulePath, args, options });
      return child;
    },
    execFileImpl(file, args, options, callback) {
      taskkills.push({ file, args, options });
      queueMicrotask(() => {
        callback?.(null, '', '');
        child.emit('close', null, 'SIGKILL');
      });
    },
    execPath: path.resolve('java-archive-client', 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    async publishImpl(request) { publications.push(request); },
    async removeImpl(target) { removals.push(target); }
  });
  return { child, forks, publications, removals, taskkills, run };
}

test('Java archive extraction resolves only after one authenticated success and clean child close', async () => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const context = harness();
  const options = fixture();
  const pending = context.run(options);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(context.forks.length, 1);
  assert.deepEqual(context.forks[0].options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(context.forks[0].options.windowsHide, true);
  assert.equal(JSON.stringify(context.forks[0]).includes(options.archivePath), false);
  assert.deepEqual(protocol.verifyJavaArchiveRequest(context.child.sent[0], token), {
    requestId,
    payload: {
      rootPath: options.rootPath,
      archivePath: options.archivePath,
      destinationPath: options.destinationPath,
      maxArchiveBytes: options.maxArchiveBytes,
      expectedArchiveSize: options.expectedArchiveSize,
      expectedSha256: options.expectedSha256
    }
  });

  let settled = false;
  pending.finally(() => { settled = true; }).catch(() => {});
  context.child.emit('message', protocol.createJavaArchiveResponse({
    token,
    requestId,
    ok: true,
    result: {
      entryCount: 412,
      expandedBytes: '198765432',
      javaExecutableRelativePath: 'bin/java.exe'
    }
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  context.child.emit('close', 0, null);
  assert.deepEqual(await pending, {
    entryCount: 412,
    expandedBytes: '198765432',
    javaExecutableRelativePath: 'bin/java.exe'
  });
  assert.deepEqual(context.publications, [{
    rootPath: options.rootPath,
    destinationPath: options.destinationPath,
    stagingPath: protocol.javaArchiveStagingPath(options.destinationPath, requestId),
    requestId,
    result: {
      entryCount: 412,
      expandedBytes: '198765432',
      javaExecutableRelativePath: 'bin/java.exe'
    }
  }]);
});

test('publication retries one transient Windows sharing violation before exposing the Java runtime', async t => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-java-publication-'));
  t.after(() => fs.promises.rm(testRoot, { recursive: true, force: true }));
  const canonicalRoot = await fs.promises.realpath(testRoot);
  const destinationPath = path.join(canonicalRoot, 'java-17');
  const stagingPath = protocol.javaArchiveStagingPath(destinationPath, requestId);
  const executablePath = path.join(stagingPath, 'bin', 'java.exe');
  await fs.promises.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.promises.writeFile(executablePath, 'runtime');

  const child = new FakeChild();
  let stagingRenameAttempts = 0;
  const retryDelays = [];
  const publicationFsApi = {
    lstat: fs.promises.lstat,
    realpath: fs.promises.realpath,
    rm: fs.promises.rm,
    async rename(source, destination) {
      if (source === stagingPath && destination === destinationPath) {
        stagingRenameAttempts += 1;
        if (stagingRenameAttempts === 1) {
          const error = new Error('simulated Windows sharing violation');
          error.code = 'EPERM';
          throw error;
        }
      }
      return fs.promises.rename(source, destination);
    }
  };
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execPath: path.join(canonicalRoot, 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    publicationFsApi,
    async publicationRetryDelayImpl(delayMs) { retryDelays.push(delayMs); }
  });
  const result = {
    entryCount: 1,
    expandedBytes: '7',
    javaExecutableRelativePath: 'bin/java.exe'
  };
  const pending = run(fixture({
    rootPath: canonicalRoot,
    archivePath: path.join(canonicalRoot, 'temp', 'runtime.zip'),
    destinationPath
  }));
  await new Promise(resolve => setImmediate(resolve));
  child.emit('message', protocol.createJavaArchiveResponse({ token, requestId, ok: true, result }));
  child.emit('close', 0, null);

  assert.deepEqual(await pending, result);
  assert.equal(stagingRenameAttempts, 2);
  assert.equal(retryDelays.length, 1);
  assert.equal(await fs.promises.readFile(path.join(destinationPath, 'bin', 'java.exe'), 'utf8'), 'runtime');
  await assert.rejects(fs.promises.lstat(stagingPath), error => error?.code === 'ENOENT');
});

test('publication retries a transient failure while backing up the previous Java runtime', async t => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-java-publication-'));
  t.after(() => fs.promises.rm(testRoot, { recursive: true, force: true }));
  const canonicalRoot = await fs.promises.realpath(testRoot);
  const destinationPath = path.join(canonicalRoot, 'java-17');
  const stagingPath = protocol.javaArchiveStagingPath(destinationPath, requestId);
  const previousPath = protocol.javaArchivePreviousPath(destinationPath, requestId);
  const stagedExecutablePath = path.join(stagingPath, 'bin', 'java.exe');
  const previousExecutablePath = path.join(destinationPath, 'bin', 'java.exe');
  await fs.promises.mkdir(path.dirname(stagedExecutablePath), { recursive: true });
  await fs.promises.mkdir(path.dirname(previousExecutablePath), { recursive: true });
  await fs.promises.writeFile(stagedExecutablePath, 'new-runtime');
  await fs.promises.writeFile(previousExecutablePath, 'old-runtime');

  const child = new FakeChild();
  let backupRenameAttempts = 0;
  const retryDelays = [];
  const publicationFsApi = {
    lstat: fs.promises.lstat,
    realpath: fs.promises.realpath,
    rm: fs.promises.rm,
    async rename(source, destination) {
      if (source === destinationPath && destination === previousPath) {
        backupRenameAttempts += 1;
        if (backupRenameAttempts === 1) {
          const error = new Error('simulated transient backup sharing violation');
          error.code = 'EBUSY';
          throw error;
        }
      }
      return fs.promises.rename(source, destination);
    }
  };
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execPath: path.join(canonicalRoot, 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    publicationFsApi,
    async publicationRetryDelayImpl(delayMs) { retryDelays.push(delayMs); }
  });
  const result = {
    entryCount: 1,
    expandedBytes: '11',
    javaExecutableRelativePath: 'bin/java.exe'
  };
  const pending = run(fixture({
    rootPath: canonicalRoot,
    archivePath: path.join(canonicalRoot, 'temp', 'runtime.zip'),
    destinationPath
  }));
  await new Promise(resolve => setImmediate(resolve));
  child.emit('message', protocol.createJavaArchiveResponse({ token, requestId, ok: true, result }));
  child.emit('close', 0, null);

  assert.deepEqual(await pending, result);
  assert.equal(backupRenameAttempts, 2);
  assert.deepEqual(retryDelays, [50]);
  assert.equal(await fs.promises.readFile(previousExecutablePath, 'utf8'), 'new-runtime');
  await assert.rejects(fs.promises.lstat(stagingPath), error => error?.code === 'ENOENT');
  await assert.rejects(fs.promises.lstat(previousPath), error => error?.code === 'ENOENT');
});

test('publication does not retry a non-transient filesystem failure', async t => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-java-publication-'));
  t.after(() => fs.promises.rm(testRoot, { recursive: true, force: true }));
  const canonicalRoot = await fs.promises.realpath(testRoot);
  const destinationPath = path.join(canonicalRoot, 'java-17');
  const stagingPath = protocol.javaArchiveStagingPath(destinationPath, requestId);
  const executablePath = path.join(stagingPath, 'bin', 'java.exe');
  await fs.promises.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.promises.writeFile(executablePath, 'runtime');

  const child = new FakeChild();
  let stagingRenameAttempts = 0;
  const retryDelays = [];
  const publicationFsApi = {
    lstat: fs.promises.lstat,
    realpath: fs.promises.realpath,
    rm: fs.promises.rm,
    async rename(source, destination) {
      if (source === stagingPath && destination === destinationPath) {
        stagingRenameAttempts += 1;
        const error = new Error('simulated access policy failure');
        error.code = 'EACCES';
        throw error;
      }
      return fs.promises.rename(source, destination);
    }
  };
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execPath: path.join(canonicalRoot, 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    publicationFsApi,
    async publicationRetryDelayImpl(delayMs) { retryDelays.push(delayMs); }
  });
  const result = {
    entryCount: 1,
    expandedBytes: '7',
    javaExecutableRelativePath: 'bin/java.exe'
  };
  const pending = run(fixture({
    rootPath: canonicalRoot,
    archivePath: path.join(canonicalRoot, 'temp', 'runtime.zip'),
    destinationPath
  }));
  await new Promise(resolve => setImmediate(resolve));
  child.emit('message', protocol.createJavaArchiveResponse({ token, requestId, ok: true, result }));
  child.emit('close', 0, null);

  await assert.rejects(pending, error => error?.code === 'JAVA_EXTRACTION_FAILED');
  assert.equal(stagingRenameAttempts, 1);
  assert.deepEqual(retryDelays, []);
  await assert.rejects(fs.promises.lstat(destinationPath), error => error?.code === 'ENOENT');
});

test('publication retries a transient rollback after the staged runtime fails to publish', async t => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-java-publication-'));
  t.after(() => fs.promises.rm(testRoot, { recursive: true, force: true }));
  const canonicalRoot = await fs.promises.realpath(testRoot);
  const destinationPath = path.join(canonicalRoot, 'java-17');
  const stagingPath = protocol.javaArchiveStagingPath(destinationPath, requestId);
  const previousPath = protocol.javaArchivePreviousPath(destinationPath, requestId);
  const stagedExecutablePath = path.join(stagingPath, 'bin', 'java.exe');
  const previousExecutablePath = path.join(destinationPath, 'bin', 'java.exe');
  await fs.promises.mkdir(path.dirname(stagedExecutablePath), { recursive: true });
  await fs.promises.mkdir(path.dirname(previousExecutablePath), { recursive: true });
  await fs.promises.writeFile(stagedExecutablePath, 'new-runtime');
  await fs.promises.writeFile(previousExecutablePath, 'old-runtime');

  const child = new FakeChild();
  let stagingRenameAttempts = 0;
  let rollbackRenameAttempts = 0;
  const retryDelays = [];
  const publicationFsApi = {
    lstat: fs.promises.lstat,
    realpath: fs.promises.realpath,
    rm: fs.promises.rm,
    async rename(source, destination) {
      if (source === stagingPath && destination === destinationPath) {
        stagingRenameAttempts += 1;
        const error = new Error('simulated staged publication failure');
        error.code = 'EACCES';
        throw error;
      }
      if (source === previousPath && destination === destinationPath) {
        rollbackRenameAttempts += 1;
        if (rollbackRenameAttempts === 1) {
          const error = new Error('simulated transient rollback sharing violation');
          error.code = 'EPERM';
          throw error;
        }
      }
      return fs.promises.rename(source, destination);
    }
  };
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execPath: path.join(canonicalRoot, 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    publicationFsApi,
    async publicationRetryDelayImpl(delayMs) { retryDelays.push(delayMs); }
  });
  const result = {
    entryCount: 1,
    expandedBytes: '11',
    javaExecutableRelativePath: 'bin/java.exe'
  };
  const pending = run(fixture({
    rootPath: canonicalRoot,
    archivePath: path.join(canonicalRoot, 'temp', 'runtime.zip'),
    destinationPath
  }));
  await new Promise(resolve => setImmediate(resolve));
  child.emit('message', protocol.createJavaArchiveResponse({ token, requestId, ok: true, result }));
  child.emit('close', 0, null);

  await assert.rejects(pending, error =>
    error?.code === 'JAVA_EXTRACTION_FAILED' && !Object.hasOwn(error, 'preserveWorkspace'));
  assert.equal(stagingRenameAttempts, 1);
  assert.equal(rollbackRenameAttempts, 2);
  assert.deepEqual(retryDelays, [50]);
  assert.equal(await fs.promises.readFile(previousExecutablePath, 'utf8'), 'old-runtime');
  await assert.rejects(fs.promises.lstat(stagingPath), error => error?.code === 'ENOENT');
  await assert.rejects(fs.promises.lstat(previousPath), error => error?.code === 'ENOENT');
});

test('publication preserves the rollback workspace after bounded transient retries are exhausted', async t => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-java-publication-'));
  t.after(() => fs.promises.rm(testRoot, { recursive: true, force: true }));
  const canonicalRoot = await fs.promises.realpath(testRoot);
  const destinationPath = path.join(canonicalRoot, 'java-17');
  const stagingPath = protocol.javaArchiveStagingPath(destinationPath, requestId);
  const previousPath = protocol.javaArchivePreviousPath(destinationPath, requestId);
  const stagedExecutablePath = path.join(stagingPath, 'bin', 'java.exe');
  const previousExecutablePath = path.join(destinationPath, 'bin', 'java.exe');
  await fs.promises.mkdir(path.dirname(stagedExecutablePath), { recursive: true });
  await fs.promises.mkdir(path.dirname(previousExecutablePath), { recursive: true });
  await fs.promises.writeFile(stagedExecutablePath, 'new-runtime');
  await fs.promises.writeFile(previousExecutablePath, 'old-runtime');

  const child = new FakeChild();
  let stagingRenameAttempts = 0;
  let rollbackRenameAttempts = 0;
  const retryDelays = [];
  const publicationFsApi = {
    lstat: fs.promises.lstat,
    realpath: fs.promises.realpath,
    rm: fs.promises.rm,
    async rename(source, destination) {
      if (source === stagingPath && destination === destinationPath) {
        stagingRenameAttempts += 1;
        const error = new Error('simulated staged publication failure');
        error.code = 'EACCES';
        throw error;
      }
      if (source === previousPath && destination === destinationPath) {
        rollbackRenameAttempts += 1;
        const error = new Error('simulated persistent rollback sharing violation');
        error.code = 'EBUSY';
        throw error;
      }
      return fs.promises.rename(source, destination);
    }
  };
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execPath: path.join(canonicalRoot, 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    publicationFsApi,
    async publicationRetryDelayImpl(delayMs) { retryDelays.push(delayMs); }
  });
  const result = {
    entryCount: 1,
    expandedBytes: '11',
    javaExecutableRelativePath: 'bin/java.exe'
  };
  const pending = run(fixture({
    rootPath: canonicalRoot,
    archivePath: path.join(canonicalRoot, 'temp', 'runtime.zip'),
    destinationPath
  }));
  await new Promise(resolve => setImmediate(resolve));
  child.emit('message', protocol.createJavaArchiveResponse({ token, requestId, ok: true, result }));
  child.emit('close', 0, null);

  await assert.rejects(pending, error =>
    error?.code === 'JAVA_EXTRACTION_FAILED' && error.preserveWorkspace === true);
  assert.equal(stagingRenameAttempts, 1);
  assert.equal(rollbackRenameAttempts, 5);
  assert.deepEqual(retryDelays, [50, 150, 400, 800]);
  await assert.rejects(fs.promises.lstat(destinationPath), error => error?.code === 'ENOENT');
  assert.equal(await fs.promises.readFile(path.join(previousPath, 'bin', 'java.exe'), 'utf8'), 'old-runtime');
  await assert.rejects(fs.promises.lstat(stagingPath), error => error?.code === 'ENOENT');
});

test('publication exhausts a bounded transient retry and restores the previous Java runtime', async t => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-java-publication-'));
  t.after(() => fs.promises.rm(testRoot, { recursive: true, force: true }));
  const canonicalRoot = await fs.promises.realpath(testRoot);
  const destinationPath = path.join(canonicalRoot, 'java-17');
  const stagingPath = protocol.javaArchiveStagingPath(destinationPath, requestId);
  const previousPath = protocol.javaArchivePreviousPath(destinationPath, requestId);
  const stagedExecutablePath = path.join(stagingPath, 'bin', 'java.exe');
  const previousExecutablePath = path.join(destinationPath, 'bin', 'java.exe');
  await fs.promises.mkdir(path.dirname(stagedExecutablePath), { recursive: true });
  await fs.promises.mkdir(path.dirname(previousExecutablePath), { recursive: true });
  await fs.promises.writeFile(stagedExecutablePath, 'new-runtime');
  await fs.promises.writeFile(previousExecutablePath, 'old-runtime');

  const child = new FakeChild();
  let stagingRenameAttempts = 0;
  const retryDelays = [];
  const publicationFsApi = {
    lstat: fs.promises.lstat,
    realpath: fs.promises.realpath,
    rm: fs.promises.rm,
    async rename(source, destination) {
      if (source === stagingPath && destination === destinationPath) {
        stagingRenameAttempts += 1;
        const error = new Error('simulated persistent Windows sharing violation');
        error.code = 'EBUSY';
        throw error;
      }
      return fs.promises.rename(source, destination);
    }
  };
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execPath: path.join(canonicalRoot, 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    publicationFsApi,
    async publicationRetryDelayImpl(delayMs) { retryDelays.push(delayMs); }
  });
  const result = {
    entryCount: 1,
    expandedBytes: '11',
    javaExecutableRelativePath: 'bin/java.exe'
  };
  const pending = run(fixture({
    rootPath: canonicalRoot,
    archivePath: path.join(canonicalRoot, 'temp', 'runtime.zip'),
    destinationPath
  }));
  await new Promise(resolve => setImmediate(resolve));
  child.emit('message', protocol.createJavaArchiveResponse({ token, requestId, ok: true, result }));
  child.emit('close', 0, null);

  await assert.rejects(pending, error => error?.code === 'JAVA_EXTRACTION_FAILED');
  assert.equal(stagingRenameAttempts, 5);
  assert.deepEqual(retryDelays, [50, 150, 400, 800]);
  assert.equal(await fs.promises.readFile(previousExecutablePath, 'utf8'), 'old-runtime');
  await assert.rejects(fs.promises.lstat(stagingPath), error => error?.code === 'ENOENT');
  await assert.rejects(fs.promises.lstat(previousPath), error => error?.code === 'ENOENT');
});

test('Java archive cancellation kills the retained worker handle and returns a closed cancellation', async () => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const context = harness();
  const controller = new AbortController();
  const pending = context.run(fixture({ signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('private caller reason'));

  await assert.rejects(pending, error =>
    error?.code === 'CANCELLED' && !Object.hasOwn(error, 'preserveWorkspace') &&
    !error.message.includes('private caller reason'));
  assert.equal(context.taskkills.length, 0);
  assert.deepEqual(context.child.killSignals, ['SIGKILL']);
  assert.deepEqual(context.removals, [
    path.join(rootPath, `.java-17-extract-${requestId}`)
  ]);
});

test('an unclosable cancelled worker preserves the uncertain workspace only after bounded grace', async () => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const child = new FakeChild(false);
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execFileImpl: (_file, _args, _options, callback) => queueMicrotask(() => callback?.(null, '', '')),
    execPath: path.resolve('java-archive-client', 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId
  });
  const controller = new AbortController();
  const pending = run(fixture({ signal: controller.signal, terminationGraceMs: 10 }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error =>
    error?.code === 'CANCELLED' && error.preserveWorkspace === true);
});

test('worker failure, malformed response, and timeout fail closed without leaking diagnostics', async () => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');

  const failed = harness();
  const failedPending = failed.run(fixture());
  await new Promise(resolve => setImmediate(resolve));
  failed.child.emit('message', protocol.createJavaArchiveResponse({
    token,
    requestId,
    ok: false,
    code: 'JAVA_ARCHIVE_UNSAFE'
  }));
  failed.child.emit('close', 1, null);
  await assert.rejects(failedPending, error => error?.code === 'JAVA_ARCHIVE_UNSAFE');

  const malformed = harness();
  const malformedPending = malformed.run(fixture());
  await new Promise(resolve => setImmediate(resolve));
  malformed.child.emit('message', { privatePath: fixture().archivePath });
  await assert.rejects(malformedPending, error =>
    error?.code === 'JAVA_EXTRACTION_FAILED' && !error.message.includes(fixture().archivePath));

  const timed = harness();
  const timedPending = timed.run(fixture({ timeoutMs: 10 }));
  await assert.rejects(timedPending, error => error?.code === 'JAVA_EXTRACTION_TIMEOUT');
});

test('post-close staging cleanup is not mistaken for an unclosable worker', async () => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const child = new FakeChild();
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execFileImpl: () => { throw new Error('must not be called'); },
    execPath: path.resolve('java-archive-client', 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    async removeImpl() { await new Promise(resolve => setTimeout(resolve, 30)); }
  });
  const controller = new AbortController();
  const pending = run(fixture({ signal: controller.signal, terminationGraceMs: 10 }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, error =>
    error?.code === 'CANCELLED' && !Object.hasOwn(error, 'preserveWorkspace'));
});

test('an unexplained closed worker removes its exact staging directory before failing', async () => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const context = harness();
  const pending = context.run(fixture());
  await new Promise(resolve => setImmediate(resolve));
  context.child.emit('close', 1, null);

  await assert.rejects(pending, error =>
    error?.code === 'JAVA_EXTRACTION_FAILED' && !Object.hasOwn(error, 'preserveWorkspace'));
  assert.deepEqual(context.removals, [
    path.join(rootPath, `.java-17-extract-${requestId}`)
  ]);
});

test('publication becomes non-cancellable only after authenticated success and clean close', async () => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const child = new FakeChild();
  const controller = new AbortController();
  let releasePublication;
  let publicationStarted = false;
  const publication = new Promise(resolve => { releasePublication = resolve; });
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execPath: path.resolve('java-archive-client', 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    async publishImpl() {
      publicationStarted = true;
      await publication;
    }
  });
  const pending = run(fixture({ signal: controller.signal }));
  await new Promise(resolve => setImmediate(resolve));
  child.emit('message', protocol.createJavaArchiveResponse({
    token,
    requestId,
    ok: true,
    result: {
      entryCount: 1,
      expandedBytes: '4',
      javaExecutableRelativePath: 'bin/java.exe'
    }
  }));
  assert.equal(publicationStarted, false);
  child.emit('close', 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(publicationStarted, true);
  controller.abort();
  releasePublication();

  assert.deepEqual(await pending, {
    entryCount: 1,
    expandedBytes: '4',
    javaExecutableRelativePath: 'bin/java.exe'
  });
});

test('termination uses only the retained archive-worker handle and never a reusable numeric pid', async () => {
  assert.equal(typeof clientModule?.createJavaArchiveWorkerClient, 'function');
  const child = new FakeChild();
  const originalKill = child.kill.bind(child);
  child.kill = signal => {
    const result = originalKill(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return result;
  };
  let pidTerminationCalls = 0;
  const run = clientModule.createJavaArchiveWorkerClient({
    forkImpl: () => child,
    execFileImpl() {
      pidTerminationCalls += 1;
      throw new Error('numeric pid termination must not be used');
    },
    processKillImpl() {
      pidTerminationCalls += 1;
      throw new Error('numeric process-group termination must not be used');
    },
    execPath: path.resolve('java-archive-client', 'electron.exe'),
    platform: 'win32',
    workerPath: path.resolve('electron', 'services', 'java-archive-worker.cjs'),
    tokenFactory: () => token,
    requestIdFactory: () => requestId,
    async removeImpl() {}
  });

  await assert.rejects(
    run(fixture({ timeoutMs: 5, terminationGraceMs: 100 })),
    error => error.code === 'JAVA_EXTRACTION_TIMEOUT'
  );
  assert.equal(pidTerminationCalls, 0);
  assert.deepEqual(child.killSignals, ['SIGKILL']);
});
