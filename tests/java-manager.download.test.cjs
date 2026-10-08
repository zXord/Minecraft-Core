const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Module } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

let fetchImplementation = async () => {
  throw new Error('unexpected Java download request');
};
let runJavaArchiveWorkerImplementation = async () => {
  throw new Error('unexpected Java archive worker request');
};

function loadJavaManager() {
  const modulePath = path.resolve(__dirname, '../electron/services/minecraft-launcher/java-manager.cjs');
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function mockLoad(request, parent, isMain) {
    if (request.endsWith('../../utils/fetch.cjs')) {
      return { fetch: (...args) => fetchImplementation(...args) };
    }
    if (request.endsWith('../java-archive-worker-client.cjs')) {
      return { runJavaArchiveWorker: (...args) => runJavaArchiveWorkerImplementation(...args) };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(modulePath).JavaManager;
  } finally {
    Module._load = originalLoad;
  }
}

const JavaManager = loadJavaManager();

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: name => normalized[String(name).toLowerCase()] ?? null };
}

function metadataBytes(archiveBytes, overrides = {}) {
  return Buffer.from(JSON.stringify([{
    binary: {
      package: {
        checksum: crypto.createHash('sha256').update(archiveBytes).digest('hex'),
        link: 'https://downloads.example.test/runtime.zip',
        name: 'runtime.zip',
        size: archiveBytes.length,
        ...overrides
      }
    }
  }]), 'utf8');
}

function metadataResponse(bytes) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-length': bytes.length }),
    body: Readable.from([bytes]),
    async json() { return JSON.parse(bytes.toString('utf8')); }
  };
}

function archiveResponse(bytes) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-length': bytes.length }),
    body: Readable.from([bytes])
  };
}

function successfulExtraction(manager) {
  manager.extractJava = async (_archivePath, version) => {
    const binPath = path.join(manager.javaBaseDir, `java-${version}`, 'bin');
    fs.mkdirSync(path.join(binPath, 'server'), { recursive: true });
    fs.writeFileSync(path.join(binPath, process.platform === 'win32' ? 'java.exe' : 'java'), 'java');
    fs.writeFileSync(path.join(binPath, 'server', process.platform === 'win32' ? 'jvm.dll' : 'libjvm.so'), 'jvm');
    return {
      entryCount: 2,
      expandedBytes: '8',
      javaExecutableRelativePath: `bin/${process.platform === 'win32' ? 'java.exe' : 'java'}`
    };
  };
}

function temporaryFiles(manager) {
  const tempPath = path.join(manager.javaBaseDir, 'temp');
  return fs.existsSync(tempPath) ? fs.readdirSync(tempPath).sort() : [];
}

test('verified download evidence is bound into Java archive extraction', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-extraction-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  const responses = [metadataResponse(metadata), archiveResponse(archive)];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root);
  let received;
  manager.extractJava = async (_archivePath, version, options) => {
    received = options;
    const binPath = path.join(manager.javaBaseDir, `java-${version}`, 'bin');
    fs.mkdirSync(path.join(binPath, 'server'), { recursive: true });
    fs.writeFileSync(path.join(binPath, process.platform === 'win32' ? 'java.exe' : 'java'), 'java');
    fs.writeFileSync(path.join(binPath, 'server', process.platform === 'win32' ? 'jvm.dll' : 'libjvm.so'), 'jvm');
    return {
      entryCount: 2,
      expandedBytes: '8',
      javaExecutableRelativePath: `bin/${process.platform === 'win32' ? 'java.exe' : 'java'}`
    };
  };

  await manager.downloadJava(21);

  assert.deepEqual(received, {
    signal: undefined,
    expectedArchiveSize: archive.length,
    expectedSha256: crypto.createHash('sha256').update(archive).digest('hex')
  });
});

test('nested ZIP runtime stays nested without manager-side flattening or rename', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-nested-runtime-'));
  const originalRenameSync = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = (...args) => {
    renameCalls += 1;
    return originalRenameSync(...args);
  };
  t.after(() => {
    fs.renameSync = originalRenameSync;
    runJavaArchiveWorkerImplementation = async () => {
      throw new Error('unexpected Java archive worker request');
    };
    fs.rmSync(root, { recursive: true, force: true });
  });
  const archive = Buffer.from('verified nested runtime bytes');
  const metadata = metadataBytes(archive);
  const responses = [metadataResponse(metadata), archiveResponse(archive)];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root);
  const runtimeRootName = 'jdk-21.0.8+9-jre';
  const extractPath = path.join(manager.javaBaseDir, 'java-21');
  const nestedJavaPath = path.join(
    extractPath,
    runtimeRootName,
    'bin',
    process.platform === 'win32' ? 'java.exe' : 'java'
  );
  runJavaArchiveWorkerImplementation = async ({ destinationPath }) => {
    const workerJavaPath = path.join(
      destinationPath,
      runtimeRootName,
      'bin',
      path.basename(nestedJavaPath)
    );
    fs.mkdirSync(path.dirname(workerJavaPath), { recursive: true });
    fs.writeFileSync(workerJavaPath, 'java');
    fs.writeFileSync(path.join(destinationPath, 'README.txt'), 'runtime notes');
    return {
      entryCount: 2,
      expandedBytes: '17',
      javaExecutableRelativePath: `${runtimeRootName}/bin/${path.basename(nestedJavaPath)}`
    };
  };

  const result = await manager.downloadJava(21);

  assert.equal(result.success, true);
  assert.equal(result.javaPath, nestedJavaPath);
  assert.equal(fs.readFileSync(nestedJavaPath, 'utf8'), 'java');
  assert.equal(fs.readFileSync(path.join(extractPath, 'README.txt'), 'utf8'), 'runtime notes');
  assert.equal(renameCalls, 0, 'download manager must not flatten a nested ZIP runtime');
  assert.equal(Object.hasOwn(JavaManager.prototype, 'flattenJavaDirectory'), false);
});

test('Java metadata is rejected when its measured body exceeds the configured limit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-metadata-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  const responses = [metadataResponse(metadata), archiveResponse(archive)];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root, { maxMetadataBytes: metadata.length - 1 });
  successfulExtraction(manager);

  await assert.rejects(
    manager.downloadJava(21),
    error => error?.code === 'JAVA_METADATA_TOO_LARGE'
  );
});

test('Java metadata body is aborted when its overall deadline expires', { timeout: 500 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-metadata-timeout-'));
  const body = new Readable({ read() {} });
  t.after(() => {
    body.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fetchImplementation = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers(),
    body
  });
  const manager = new JavaManager(root, { metadataTimeoutMs: 20 });

  await assert.rejects(
    Promise.race([
      manager.downloadJava(21),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('test deadline'), { code: 'TEST_DEADLINE' })), 150))
    ]),
    error => error?.code === 'JAVA_METADATA_TIMEOUT'
  );
  assert.equal(body.destroyed, true);
});

test('caller cancellation promptly aborts an in-flight Java metadata body', { timeout: 500 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-metadata-cancel-'));
  const body = new Readable({ read() {} });
  const controller = new AbortController();
  let requestSignal;
  t.after(() => {
    body.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fetchImplementation = async (_url, options) => {
    requestSignal = options.signal;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: headers(),
      body
    };
  };
  const manager = new JavaManager(root, { metadataTimeoutMs: 250 });
  const pending = manager.downloadJava(21, null, { signal: controller.signal });
  setImmediate(() => controller.abort(new Error('caller-only detail')));

  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('test deadline'), { code: 'TEST_DEADLINE' })), 150))
    ]),
    error => error?.code === 'CANCELLED' && !error.message.includes('caller-only detail')
  );
  assert.equal(requestSignal.aborted, true);
  assert.equal(body.destroyed, true);
});

test('an already cancelled Java download does not start a metadata request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-pre-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let requestCount = 0;
  fetchImplementation = async () => {
    requestCount += 1;
    throw new Error('request must not start');
  };
  const manager = new JavaManager(root);
  controller.abort(new Error('caller-only detail'));

  await assert.rejects(
    manager.downloadJava(21, null, { signal: controller.signal }),
    error => error?.code === 'CANCELLED' && !error.message.includes('caller-only detail')
  );
  assert.equal(requestCount, 0);
});

test('Java archive is rejected before writing when its declared size exceeds the configured cap', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  const responses = [metadataResponse(metadata), archiveResponse(archive)];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root, { maxArchiveBytes: archive.length - 1 });
  successfulExtraction(manager);

  await assert.rejects(
    manager.downloadJava(21),
    error => error?.code === 'JAVA_ARCHIVE_TOO_LARGE'
  );
  assert.deepEqual(temporaryFiles(manager), []);
});

test('Java archive transfer aborts and removes its partial after an idle body interval', { timeout: 500 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-idle-'));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  let delayedPush;
  let started = false;
  const body = new Readable({
    read() {
      if (started) return;
      started = true;
      this.push(archive.subarray(0, 4));
      delayedPush = setTimeout(() => {
        if (this.destroyed) return;
        this.push(archive.subarray(4));
        this.push(null);
      }, 100);
    }
  });
  const responses = [metadataResponse(metadata), {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-length': archive.length }),
    body
  }];
  t.after(() => {
    clearTimeout(delayedPush);
    body.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root, {
    archiveIdleTimeoutMs: 20,
    archiveTimeoutMs: 250
  });
  successfulExtraction(manager);

  await assert.rejects(
    manager.downloadJava(21),
    error => error?.code === 'JAVA_DOWNLOAD_STALLED'
  );
  assert.equal(body.destroyed, true);
  assert.deepEqual(temporaryFiles(manager), []);
});

test('Java archive request is aborted when response headers miss their deadline', { timeout: 500 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-headers-'));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  let resolveTimer;
  let requestSignal;
  let requestNumber = 0;
  t.after(() => {
    clearTimeout(resolveTimer);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fetchImplementation = async (_url, options = {}) => {
    requestNumber += 1;
    if (requestNumber === 1) return metadataResponse(metadata);
    requestSignal = options.signal;
    return new Promise(resolve => {
      resolveTimer = setTimeout(() => resolve(archiveResponse(archive)), 100);
    });
  };
  const manager = new JavaManager(root, {
    requestTimeoutMs: 20,
    archiveTimeoutMs: 250
  });
  successfulExtraction(manager);

  await assert.rejects(
    manager.downloadJava(21),
    error => error?.code === 'JAVA_DOWNLOAD_TIMEOUT'
  );
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(temporaryFiles(manager), []);
});

test('Java archive hard deadline aborts a body that keeps making idle progress', { timeout: 750 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-hard-'));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  let interval;
  let offset = 0;
  const body = new Readable({
    read() {
      if (interval) return;
      interval = setInterval(() => {
        if (this.destroyed) return;
        if (offset >= archive.length) {
          clearInterval(interval);
          this.push(null);
          return;
        }
        this.push(archive.subarray(offset, offset + 1));
        offset += 1;
      }, 10);
    }
  });
  const responses = [metadataResponse(metadata), {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-length': archive.length }),
    body
  }];
  t.after(() => {
    clearInterval(interval);
    body.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root, {
    archiveIdleTimeoutMs: 30,
    archiveTimeoutMs: 55
  });
  successfulExtraction(manager);

  await assert.rejects(
    manager.downloadJava(21),
    error => error?.code === 'JAVA_DOWNLOAD_TIMEOUT'
  );
  assert.equal(body.destroyed, true);
  assert.deepEqual(temporaryFiles(manager), []);
});

test('caller cancellation promptly aborts an in-flight Java archive and removes its partial', { timeout: 500 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-cancel-'));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  const controller = new AbortController();
  let delayedPush;
  let started = false;
  const body = new Readable({
    read() {
      if (started) return;
      started = true;
      this.push(archive.subarray(0, 4));
      setImmediate(() => controller.abort(new Error('caller-only detail')));
      delayedPush = setTimeout(() => {
        if (this.destroyed) return;
        this.push(archive.subarray(4));
        this.push(null);
      }, 100);
    }
  });
  const responses = [metadataResponse(metadata), {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-length': archive.length }),
    body
  }];
  t.after(() => {
    clearTimeout(delayedPush);
    body.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root, {
    archiveIdleTimeoutMs: 250,
    archiveTimeoutMs: 250
  });
  successfulExtraction(manager);

  await assert.rejects(
    manager.downloadJava(21, null, { signal: controller.signal }),
    error => error?.code === 'CANCELLED' && !error.message.includes('caller-only detail')
  );
  assert.equal(body.destroyed, true);
  assert.deepEqual(temporaryFiles(manager), []);
});

test('Java archive enforces its measured size cap when servers omit content length', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-measured-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = Buffer.from('archive bytes beyond configured limit');
  const metadata = metadataBytes(archive, { size: undefined });
  const responses = [metadataResponse(metadata), {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers(),
    body: Readable.from([archive])
  }];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root, { maxArchiveBytes: archive.length - 1 });

  await assert.rejects(
    manager.downloadJava(21),
    error => error?.code === 'JAVA_ARCHIVE_TOO_LARGE'
  );
  assert.deepEqual(temporaryFiles(manager), []);
});

test('Java archive source errors reject predictably and remove the partial file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-source-error-'));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  let started = false;
  const body = new Readable({
    read() {
      if (started) return;
      started = true;
      this.push(archive.subarray(0, 4));
      setImmediate(() => this.destroy(new Error('socket-only detail')));
    }
  });
  t.after(() => {
    body.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const responses = [metadataResponse(metadata), {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-length': archive.length }),
    body
  }];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root);

  await assert.rejects(
    manager.downloadJava(21),
    error => error?.code === 'JAVA_DOWNLOAD_FAILED' && !error.message.includes('socket-only detail')
  );
  assert.deepEqual(temporaryFiles(manager), []);
});

test('premature Java archive close rejects and removes the partial file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-premature-close-'));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  let started = false;
  const body = new Readable({
    read() {
      if (started) return;
      started = true;
      this.push(archive.subarray(0, 4));
      setImmediate(() => this.destroy());
    }
  });
  t.after(() => {
    body.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const responses = [metadataResponse(metadata), {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-length': archive.length }),
    body
  }];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root);

  await assert.rejects(
    manager.downloadJava(21),
    error => error?.code === 'JAVA_DOWNLOAD_FAILED' || error?.code === 'JAVA_ARCHIVE_SIZE_MISMATCH'
  );
  assert.deepEqual(temporaryFiles(manager), []);
});

test('checksum and extraction failures both remove the downloaded Java archive', async t => {
  for (const failure of ['checksum', 'extraction']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-java-${failure}-cleanup-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const archive = Buffer.from('verified runtime bytes');
    const metadata = metadataBytes(archive, failure === 'checksum' ? { checksum: '0'.repeat(64) } : {});
    const responses = [metadataResponse(metadata), archiveResponse(archive)];
    fetchImplementation = async () => responses.shift();
    const manager = new JavaManager(root);
    if (failure === 'extraction') {
      manager.extractJava = async () => { throw new Error('extraction failed'); };
    }

    await assert.rejects(manager.downloadJava(21));
    assert.deepEqual(temporaryFiles(manager), [], failure);
  }
});

test('an unquiesced extraction preserves its verified archive without masking the original error', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-unquiesced-extraction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  const responses = [metadataResponse(metadata), archiveResponse(archive)];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root);
  const originalError = Object.assign(new Error('closed cancellation'), {
    code: 'CANCELLED',
    preserveWorkspace: true
  });
  manager.extractJava = async () => { throw originalError; };

  await assert.rejects(manager.downloadJava(21), error => error === originalError);
  assert.equal(temporaryFiles(manager).length, 1);
});

test('archive idle deadline resets on progress and legacy progress callbacks remain available', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-archive-progress-'));
  const archive = Buffer.from('verified runtime bytes');
  const metadata = metadataBytes(archive);
  let interval;
  let offset = 0;
  const body = new Readable({
    read() {
      if (interval) return;
      interval = setInterval(() => {
        if (this.destroyed) return;
        if (offset >= archive.length) {
          clearInterval(interval);
          this.push(null);
          return;
        }
        this.push(archive.subarray(offset, offset + 4));
        offset += 4;
      }, 10);
    }
  });
  t.after(() => {
    clearInterval(interval);
    body.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const responses = [metadataResponse(metadata), {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: headers({ 'content-length': archive.length }),
    body
  }];
  fetchImplementation = async () => responses.shift();
  const manager = new JavaManager(root, { archiveIdleTimeoutMs: 25, archiveTimeoutMs: 500 });
  successfulExtraction(manager);
  const progress = [];

  const result = await manager.downloadJava(21, event => progress.push(event));

  assert.equal(result.success, true);
  assert.equal(progress[0].type, 'Preparing');
  assert.ok(progress.some(event => event.type === 'Downloading'));
  assert.ok(progress.some(event => event.type === 'Extracting'));
  assert.ok(progress.some(event => event.type === 'Verifying'));
  assert.equal(progress.at(-1).type, 'Complete');
  assert.deepEqual(temporaryFiles(manager), []);
});

test('ensureJava forwards the caller signal without changing callback position', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-ensure-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new JavaManager(root);
  const controller = new AbortController();
  const callback = () => {};
  let received;
  manager.getJavaValidationStatus = () => ({ isInstalled: false, javaPath: null });
  manager.downloadJava = async (version, progressCallback, options) => {
    received = { version, progressCallback, options };
    return { success: false };
  };

  await manager.ensureJava(21, callback, { signal: controller.signal });

  assert.equal(received.version, 21);
  assert.equal(received.progressCallback, callback);
  assert.equal(received.options.signal, controller.signal);
});

test('ensureJava rejects an already cancelled request before installed-runtime cleanup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-java-ensure-cancelled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new JavaManager(root);
  const controller = new AbortController();
  let cleaned = false;
  manager.getJavaValidationStatus = () => ({ isInstalled: true, javaPath: 'installed-java' });
  manager.cleanupUnusedJavaVersions = async () => { cleaned = true; };
  controller.abort(new Error('caller-only detail'));

  await assert.rejects(
    manager.ensureJava(21, null, { signal: controller.signal }),
    error => error?.code === 'CANCELLED' && !error.message.includes('caller-only detail')
  );
  assert.equal(cleaned, false);
});
