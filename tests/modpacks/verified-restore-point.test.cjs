const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const Module = require('node:module');
const test = require('node:test');

const AdmZip = require('adm-zip');

const { createDurableFs, MAX_FLUSH_DIRECTORIES } = require('../../electron/utils/durable-fs.cjs');
const { ModpackError } = require('../../electron/services/modpacks/errors.cjs');
const {
  createVerifiedZip,
  enumerateArchiveScope,
  enumerateArchiveScopeCooperatively,
  verifyZipScopeStreaming
} = require('../../electron/utils/backup-util.cjs');
const {
  RestorePointService
} = require('../../electron/services/modpack-lifecycle/restore-point-service.cjs');
const { identityFromStat } = require('../../electron/services/modpack-lifecycle/restore-creation-intent.cjs');

function nativeDurabilityClient() {
  return {
    moveWriteThrough(source, destination) { fs.renameSync(source, destination); },
    replaceFileWriteThrough(source, destination) { fs.renameSync(source, destination); },
    flushDirectory() {},
    async moveWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
    async replaceFileWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
    async flushDirectoryAsync() {}
  };
}

function durableFor(root, { failRenameNumber = null, uncertainRenameNumber = null } = {}) {
  let token = 0;
  let renames = 0;
  const base = createDurableFs({
    fsApi: fs,
    durableClient: nativeDurabilityClient(),
    allowedRoots: [root],
    tempNameFactory: () => `restore-point-${++token}`
  });
  return {
    ...base,
    renameDurable(source, destination) {
      renames += 1;
      if (renames === failRenameNumber) {
        throw Object.assign(new Error('injected rename failure'), { code: 'COMMIT_FAILED' });
      }
      const result = base.renameDurable(source, destination);
      if (renames === uncertainRenameNumber) {
        throw Object.assign(new Error('injected uncertain rename failure'), {
          code: 'COMMIT_FAILED',
          commitPhase: 'post-publication-uncertain'
        });
      }
      return result;
    },
    async renameDurableAsync(source, destination) {
      renames += 1;
      if (renames === failRenameNumber) {
        throw Object.assign(new Error('injected rename failure'), { code: 'COMMIT_FAILED' });
      }
      const result = await base.renameDurableAsync(source, destination);
      if (renames === uncertainRenameNumber) {
        throw Object.assign(new Error('injected uncertain rename failure'), {
          code: 'COMMIT_FAILED',
          commitPhase: 'post-publication-uncertain'
        });
      }
      return result;
    }
  };
}

async function testOnlySecureExtractor({ archivePath, stagingPath, expectedArchiveSha256, expectedScope }) {
  const bytes = fs.readFileSync(archivePath);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expectedArchiveSha256);
  fs.mkdirSync(stagingPath, { recursive: false, mode: 0o700 });
  const zip = new AdmZip(archivePath);
  const expected = new Map(expectedScope.entries.map(entry => [entry.path, entry]));
  for (const entry of zip.getEntries()) {
    const declared = expected.get(entry.entryName);
    assert.ok(declared);
    const target = path.resolve(stagingPath, ...entry.entryName.replace(/\/$/, '').split('/'));
    assert.equal(path.relative(stagingPath, target).startsWith('..'), false);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, entry.getData(), { flag: 'wx', mode: 0o600 });
    }
  }
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-verified-restore-'));
  const serverPath = path.join(root, 'server');
  const backupDir = path.join(serverPath, 'backups');
  fs.mkdirSync(path.join(serverPath, 'world'), { recursive: true });
  fs.mkdirSync(path.join(serverPath, 'config'), { recursive: true });
  fs.mkdirSync(backupDir);
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), Buffer.from('world-data'));
  fs.writeFileSync(path.join(serverPath, 'config', 'pack.toml'), Buffer.from('config-data'));
  fs.writeFileSync(path.join(serverPath, 'server.jar'), Buffer.from('server-binary'));
  fs.writeFileSync(path.join(backupDir, 'older.zip'), Buffer.from('excluded'));
  const durableFs = options.durableFs || options.durableFsFactory?.(root) || durableFor(root, options);
  const service = new RestorePointService({
    fsApi: options.fsApi || fs,
    durableFs,
    clock: () => new Date('2026-08-01T01:02:03.004Z'),
    randomUUID: options.randomUUID || (() => '00000000-0000-4000-8000-000000000017'),
    createVerifiedZipFn: options.createVerifiedZipFn,
    zipStreamVerifier: options.zipStreamVerifier,
    extractVerifiedArchiveFn: options.extractVerifiedArchiveFn || testOnlySecureExtractor,
    faultInjector: options.faultInjector
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { backupDir, durableFs, root, serverPath, service };
}

function topLevelServerItems(serverPath) {
  return fs.readdirSync(serverPath)
    .filter(name => name !== 'backups')
    .sort()
    .map(name => path.join(serverPath, name));
}

function visibleZipFiles(backupDir) {
  return fs.readdirSync(backupDir).filter(name => name.endsWith('.zip')).sort();
}

function request(serverPath) {
  return {
    serverPath,
    operationId: 'operation-0001',
    sourceRevision: 7,
    sourceRuntime: {
      loader: 'fabric',
      minecraftVersion: '1.21.1',
      loaderVersion: '0.16.14'
    }
  };
}

async function withBackupService(callback) {
  const modulePath = path.resolve(__dirname, '../../electron/services/backup-service.cjs');
  const originalLoad = Module._load;
  Module._load = function mockLoad(requestName, parent, isMain) {
    if (requestName.includes('logger-handlers.cjs')) {
      return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    }
    if (requestName.endsWith('/safe-send.cjs') || requestName === '../utils/safe-send.cjs') {
      return { safeSend() {} };
    }
    if (requestName.endsWith('/server-manager.cjs') || requestName === './server-manager.cjs') {
      return { sendServerCommand() {}, getServerState: () => ({ isRunning: false, status: 'Stopped' }) };
    }
    return originalLoad(requestName, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    return await callback(require(modulePath));
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

test('archive scope is exact, hashed, stable, and excludes no ordinary server file', (t) => {
  const { root, serverPath } = fixture(t);
  fs.writeFileSync(path.join(serverPath, 'config', 'keep.tmp'), 'temporary-but-real');
  const scope = enumerateArchiveScope(topLevelServerItems(serverPath));
  assert.deepEqual(scope.entries.map(entry => entry.path), [
    'config/',
    'config/keep.tmp',
    'config/pack.toml',
    'server.jar',
    'world/',
    'world/level.dat'
  ]);
  assert.equal(scope.entries.find(entry => entry.path === 'world/level.dat').sha256,
    crypto.createHash('sha256').update('world-data').digest('hex'));
  assert.equal(scope.scopeSha256.length, 64);
  assert.equal(JSON.stringify(scope).includes(root), false);
});

test('cooperative archive scope matches the exact synchronous scope', async (t) => {
  const { serverPath } = fixture(t);
  const items = topLevelServerItems(serverPath);

  assert.deepEqual(
    await enumerateArchiveScopeCooperatively(items),
    enumerateArchiveScope(items)
  );
});

test('restore point scope hashing hands control back to the main loop', async (t) => {
  const slowFs = Object.create(fs);
  slowFs.readSync = (...args) => {
    const count = fs.readSync(...args);
    const deadline = Date.now() + 3;
    while (Date.now() < deadline) { /* deterministic slow local read */ }
    return count;
  };
  const { serverPath, service } = fixture(t, { fsApi: slowFs });
  const payload = Buffer.alloc(1024 * 1024, 0x5a);
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(serverPath, 'config', `liveness-${index}.bin`), payload);
  }
  let heartbeatObserved = false;
  const heartbeat = setTimeout(() => { heartbeatObserved = true; }, 0);

  await service.prepareVerifiedRestorePointCreation(request(serverPath));
  clearTimeout(heartbeat);

  assert.equal(heartbeatObserved, true, 'scope hashing monopolized the Electron main loop');
});

test('complete restore point creation stays responsive before and after ZIP streaming', async (t) => {
  const slowFs = Object.create(fs);
  slowFs.readSync = (...args) => {
    const count = fs.readSync(...args);
    const deadline = Date.now() + 3;
    while (Date.now() < deadline) { /* deterministic slow local read */ }
    return count;
  };
  let beforePartHeartbeat = false;
  let afterArchiveHeartbeat = false;
  const createVerifiedZipFn = async (options) => {
    const onPartCreated = options.onPartCreated;
    const result = await createVerifiedZip({
      ...options,
      onPartCreated: async (identity) => {
        assert.equal(beforePartHeartbeat, true, 'pre-archive scope checks blocked the main loop');
        await onPartCreated(identity);
      }
    });
    setTimeout(() => { afterArchiveHeartbeat = true; }, 0);
    return result;
  };
  const { serverPath, service } = fixture(t, { fsApi: slowFs, createVerifiedZipFn });
  const payload = Buffer.alloc(1024 * 1024, 0x33);
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(serverPath, 'config', `complete-liveness-${index}.bin`), payload);
  }
  const creationRequest = request(serverPath);
  const creationIntent = await service.prepareVerifiedRestorePointCreation(creationRequest);
  setTimeout(() => { beforePartHeartbeat = true; }, 0);

  await service.createVerifiedRestorePoint(creationRequest, {
    creationIntent,
    async onCreationState() {}
  });

  assert.equal(afterArchiveHeartbeat, true, 'post-archive scope checks blocked the main loop');
});

test('archive scope rejects links instead of following them', (t) => {
  const { root, serverPath } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const linked = path.join(serverPath, 'linked');
  try {
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`links unavailable on this test host: ${error.code}`);
    return;
  }
  assert.throws(() => enumerateArchiveScope(topLevelServerItems(serverPath)), error => error.code === 'BACKUP_FAILED');
});

test('createVerifiedZip flushes a part archive and proves exact entry bytes', async (t) => {
  const { backupDir, serverPath } = fixture(t);
  const partPath = path.join(backupDir, 'direct.zip.part');
  const expectedScope = enumerateArchiveScope(topLevelServerItems(serverPath));
  const verified = await createVerifiedZip({
    items: topLevelServerItems(serverPath),
    partPath,
    expectedScope
  });
  assert.equal(fs.existsSync(partPath), true);
  assert.equal(verified.sha256, crypto.createHash('sha256').update(fs.readFileSync(partPath)).digest('hex'));
  assert.equal(verified.scopeSha256, expectedScope.scopeSha256);
  const zip = new AdmZip(partPath);
  assert.deepEqual(zip.getEntries().map(entry => entry.entryName).sort(), expectedScope.entries.map(entry => entry.path).sort());
  assert.equal(zip.test(), true);
});

test('createVerifiedZip persists the exact empty part identity before writing archive bytes', async (t) => {
  const { backupDir, serverPath } = fixture(t);
  const partPath = path.join(backupDir, 'identity-gated.zip.part');
  const expectedScope = enumerateArchiveScope(topLevelServerItems(serverPath));
  let releaseIdentity;
  let observeIdentity;
  const identityObserved = new Promise(resolve => { observeIdentity = resolve; });
  const identityPersisted = new Promise(resolve => { releaseIdentity = resolve; });

  const creation = createVerifiedZip({
    items: topLevelServerItems(serverPath),
    partPath,
    expectedScope,
    onPartCreated: async identity => {
      observeIdentity(identity);
      await identityPersisted;
    }
  });

  const identity = await identityObserved;
  assert.deepEqual(Object.keys(identity).sort(), ['birthtimeNs', 'dev', 'ino']);
  assert.match(identity.dev, /^(0|[1-9][0-9]*)$/);
  assert.match(identity.ino, /^(0|[1-9][0-9]*)$/);
  assert.match(identity.birthtimeNs, /^(0|[1-9][0-9]*)$/);
  assert.equal(fs.statSync(partPath).size, 0, 'no archive bytes may precede the durable identity acknowledgement');

  releaseIdentity();
  const verified = await creation;
  assert.ok(verified.size > 0);
});

test('createVerifiedZip closes an identity-gated part when persistence fails', async (t) => {
  const { backupDir, serverPath } = fixture(t);
  const partPath = path.join(backupDir, 'identity-rejected.zip.part');
  const expectedScope = enumerateArchiveScope(topLevelServerItems(serverPath));

  await assert.rejects(createVerifiedZip({
    items: topLevelServerItems(serverPath),
    partPath,
    expectedScope,
    onPartCreated: async () => { throw new Error('registry persistence failed'); }
  }), error => error?.code === 'BACKUP_FAILED');

  assert.equal(fs.statSync(partPath).size, 0);
  fs.rmSync(partPath);
  assert.equal(fs.existsSync(partPath), false, 'the rejected file descriptor must be closed');
});

test('createVerifiedZip opens, syncs, and closes its part through an async FileHandle', async (t) => {
  const { backupDir, serverPath } = fixture(t);
  const partPath = path.join(backupDir, 'async-handle.zip.part');
  const expectedScope = enumerateArchiveScope(topLevelServerItems(serverPath));
  const fsApi = Object.create(fs);
  fsApi.openSync = (filePath, ...args) => {
    if (path.resolve(filePath) === path.resolve(partPath)) {
      throw new Error('part archive must not use openSync');
    }
    return fs.openSync(filePath, ...args);
  };
  fsApi.fsyncSync = () => { throw new Error('part archive must not use fsyncSync'); };
  let handleSynced = false;
  let handleClosed = false;
  const asyncFsApi = {
    async open(...args) {
      const handle = await fs.promises.open(...args);
      return {
        fd: handle.fd,
        stat: (...statArgs) => handle.stat(...statArgs),
        read: (...readArgs) => handle.read(...readArgs),
        async sync() { handleSynced = true; return handle.sync(); },
        async close() { handleClosed = true; return handle.close(); }
      };
    }
  };

  const verified = await createVerifiedZip({
    items: topLevelServerItems(serverPath),
    partPath,
    expectedScope,
    fsApi,
    asyncFsApi
  });

  assert.ok(verified.size > 0);
  assert.equal(handleSynced, true);
  assert.equal(handleClosed, true);
});

test('ZIP verification hashes through the pinned async FileHandle and yields while a read is pending', async (t) => {
  const { backupDir } = fixture(t);
  const archivePath = path.join(backupDir, 'async-verified.zip');
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const zip = new AdmZip();
  zip.addFile('payload.bin', payload);
  zip.writeZip(archivePath);
  const scope = {
    schemaVersion: 1,
    entries: [{
      path: 'payload.bin', type: 'file', size: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex')
    }],
    totalBytes: payload.length,
    fileCount: 1
  };
  scope.scopeSha256 = crypto.createHash('sha256').update(JSON.stringify(scope.entries), 'utf8').digest('hex');
  const fsApi = Object.create(fs);
  fsApi.readSync = () => { throw new Error('ZIP content must not use readSync'); };
  let enterRead;
  const readEntered = new Promise(resolve => { enterRead = resolve; });
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  let firstRead = true;
  let closed = false;
  const asyncFsApi = {
    async open(...args) {
      const handle = await fs.promises.open(...args);
      return {
        fd: handle.fd,
        stat: (...statArgs) => handle.stat(...statArgs),
        async read(...readArgs) {
          if (firstRead) {
            firstRead = false;
            enterRead();
            await readGate;
          }
          return handle.read(...readArgs);
        },
        async close() { closed = true; return handle.close(); }
      };
    }
  };

  let settled = false;
  const pending = verifyZipScopeStreaming(archivePath, scope, { fsApi, asyncFsApi })
    .finally(() => { settled = true; });
  await readEntered;
  let heartbeatObserved = false;
  await new Promise(resolve => setImmediate(() => {
    heartbeatObserved = true;
    resolve();
  }));

  assert.equal(heartbeatObserved, true);
  assert.equal(settled, false);
  releaseRead();
  const evidence = await pending;
  assert.equal(evidence.archiveSize, fs.statSync(archivePath).size);
  assert.equal(closed, true);
});

test('ZIP verification cancellation closes the pinned descriptor and reports CANCELLED', async (t) => {
  const { backupDir } = fixture(t);
  const archivePath = path.join(backupDir, 'cancelled-verification.zip');
  const payload = Buffer.alloc(1024 * 1024, 0x42);
  const zip = new AdmZip();
  zip.addFile('payload.bin', payload);
  zip.writeZip(archivePath);
  const scope = {
    schemaVersion: 1,
    entries: [{
      path: 'payload.bin', type: 'file', size: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex')
    }],
    totalBytes: payload.length,
    fileCount: 1
  };
  scope.scopeSha256 = crypto.createHash('sha256').update(JSON.stringify(scope.entries), 'utf8').digest('hex');
  const controller = new AbortController();
  let enterRead;
  const readEntered = new Promise(resolve => { enterRead = resolve; });
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  let closed = false;
  const asyncFsApi = {
    async open(...args) {
      const handle = await fs.promises.open(...args);
      return {
        fd: handle.fd,
        stat: (...statArgs) => handle.stat(...statArgs),
        async read(...readArgs) {
          enterRead();
          await readGate;
          return handle.read(...readArgs);
        },
        async close() { closed = true; return handle.close(); }
      };
    }
  };
  const pending = verifyZipScopeStreaming(archivePath, scope, {
    asyncFsApi,
    signal: controller.signal
  });
  await readEntered;
  controller.abort();
  releaseRead();

  await assert.rejects(pending, error => error?.code === 'CANCELLED');
  assert.equal(closed, true);
});

test('ZIP verification hashes decompressed entries as a bounded stream', async (t) => {
  const { backupDir } = fixture(t);
  const archivePath = path.join(backupDir, 'streamed.zip');
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a);
  const zip = new AdmZip();
  zip.addFile('large.bin', payload);
  zip.writeZip(archivePath);
  const scope = {
    schemaVersion: 1,
    entries: [{
      path: 'large.bin',
      type: 'file',
      size: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex')
    }],
    totalBytes: payload.length,
    fileCount: 1
  };
  scope.scopeSha256 = crypto.createHash('sha256').update(JSON.stringify(scope.entries), 'utf8').digest('hex');
  let largestChunk = 0;
  const evidence = await verifyZipScopeStreaming(archivePath, scope, {
    onChunk: chunk => { largestChunk = Math.max(largestChunk, chunk.length); }
  });
  assert.equal(evidence.scopeSha256, scope.scopeSha256);
  assert.ok(largestChunk > 0 && largestChunk < payload.length);
});

test('ZIP progress observer rejection cannot change verification correctness', async (t) => {
  const { backupDir } = fixture(t);
  const archivePath = path.join(backupDir, 'progress-observer.zip');
  const payload = Buffer.from('verified payload');
  const zip = new AdmZip();
  zip.addFile('payload.bin', payload);
  zip.writeZip(archivePath);
  const scope = {
    schemaVersion: 1,
    entries: [{
      path: 'payload.bin', type: 'file', size: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex')
    }],
    totalBytes: payload.length,
    fileCount: 1
  };
  scope.scopeSha256 = crypto.createHash('sha256').update(JSON.stringify(scope.entries), 'utf8').digest('hex');

  const evidence = await verifyZipScopeStreaming(archivePath, scope, {
    onProgress: async () => { throw new Error('observer failed'); }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(evidence.scopeSha256, scope.scopeSha256);
});

test('ZIP verification rejects and releases a decompression stream that stops making progress', async (t) => {
  const { backupDir } = fixture(t);
  const archivePath = path.join(backupDir, 'stalled.zip');
  fs.writeFileSync(archivePath, Buffer.from('archive bytes'));
  const payload = Buffer.from('expected payload');
  const expectedScope = {
    schemaVersion: 1,
    entries: [{
      path: 'payload.bin',
      type: 'file',
      size: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex')
    }],
    totalBytes: payload.length,
    fileCount: 1
  };
  expectedScope.scopeSha256 = crypto.createHash('sha256')
    .update(JSON.stringify(expectedScope.entries), 'utf8')
    .digest('hex');

  let streamOpened = false;
  let streamDestroyed = false;
  let zipClosed = false;
  const stalledStream = new Readable({
    read() {
      if (streamOpened) return;
      streamOpened = true;
      this.push(payload);
    },
    destroy(error, callback) {
      streamDestroyed = true;
      callback(error);
    }
  });
  const zip = new EventEmitter();
  let entryRequested = false;
  zip.readEntry = () => {
    if (entryRequested) {
      setImmediate(() => zip.emit('end'));
      return;
    }
    entryRequested = true;
    setImmediate(() => zip.emit('entry', {
      fileName: 'payload.bin',
      uncompressedSize: payload.length
    }));
  };
  zip.openReadStream = (_entry, callback) => setImmediate(() => callback(null, stalledStream));
  zip.close = () => { zipClosed = true; };
  const yauzlApi = {
    fromFd(_descriptor, _options, callback) {
      setImmediate(() => callback(null, zip));
    }
  };

  await assert.rejects(
    verifyZipScopeStreaming(archivePath, expectedScope, { yauzlApi, streamIdleTimeoutMs: 25 }),
    error => error?.code === 'BACKUP_FAILED'
  );
  assert.equal(streamOpened, true);
  assert.equal(streamDestroyed, true);
  assert.equal(zipClosed, true);
});

test('a verified restore point is visible only after exact verification and is durably pinned', async (t) => {
  const { backupDir, serverPath, service } = fixture(t);
  const expectedScope = enumerateArchiveScope(topLevelServerItems(serverPath));
  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  assert.equal(reference.sha256.length, 64);
  assert.equal(reference.scopeSha256.length, 64);
  assert.equal(reference.totalBytes, String(expectedScope.totalBytes));
  assert.equal(Object.hasOwn(reference, 'scope'), false);
  assert.equal(reference.sourceRevision, 7);
  assert.equal(reference.sourceRuntime.loader, 'fabric');
  assert.deepEqual(visibleZipFiles(backupDir).filter(name => name.startsWith('restore-point-')), [reference.name]);
  assert.equal(fs.readdirSync(backupDir).some(name => name.endsWith('.part')), false);
  assert.equal(service.isRestorePointPinned(reference), true);
  const evidence = await service.verifyRestorePoint(reference);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.sha256, reference.sha256);
  assert.equal(evidence.totalBytes, reference.totalBytes);
});

test('restore point creation publishes archives and metadata only through async durability', async (t) => {
  const environment = fixture(t, {
    durableFsFactory(root) {
      const base = durableFor(root);
      return {
        ...base,
        flushDirectory() { throw new Error('synchronous directory durability must not run'); },
        renameDurable() { throw new Error('synchronous publication must not run'); },
        writeJsonAtomic() { throw new Error('synchronous metadata publication must not run'); },
        flushDirectoryAsync: (...args) => base.flushDirectoryAsync(...args),
        renameDurableAsync: (...args) => base.renameDurableAsync(...args),
        writeJsonAtomicAsync: (...args) => base.writeJsonAtomicAsync(...args)
      };
    }
  });

  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));

  assert.equal(fs.existsSync(reference.archivePath), true);
  assert.equal(fs.existsSync(reference.metadataPath), true);
  assert.equal(await environment.service.verifyRestorePoint(reference).then(value => value.ok), true);
});

test('restore-point verification accepts cancellation and reports bounded archive progress', async (t) => {
  const environment = fixture(t);
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const progress = [];

  const evidence = await environment.service.verifyRestorePoint(reference, {
    onProgress(value) { progress.push(value); }
  });

  assert.equal(evidence.ok, true);
  assert.equal(progress.some(value => value.phase === 'archive-hash'), true);
  assert.ok(progress.length < 20, 'verification progress must stay bounded');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    environment.service.verifyRestorePoint(reference, { signal: controller.signal }),
    error => error?.code === 'CANCELLED'
  );
});

test('cancelled restore creation removes an exact owned part but preserves a replacement at the same path', async (t) => {
  for (const replacePart of [false, true]) {
    await t.test(replacePart ? 'replacement-is-preserved' : 'owned-part-is-removed', async (st) => {
      let partPath = null;
      let cleanupFlushes = 0;
      const controller = new AbortController();
      const createVerifiedZipFn = async options => {
        partPath = options.partPath;
        fs.writeFileSync(partPath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
        const created = fs.lstatSync(partPath, { bigint: true });
        await options.onPartCreated(identityFromStat(created));
        if (replacePart) {
          fs.unlinkSync(partPath);
          fs.writeFileSync(partPath, 'user-owned replacement', { flag: 'wx', mode: 0o600 });
        }
        controller.abort();
        throw new ModpackError('CANCELLED', 'The modpack operation was cancelled');
      };
      const environment = fixture(st, {
        createVerifiedZipFn,
        durableFsFactory(root) {
          const base = durableFor(root);
          return {
            ...base,
            async flushDirectoryAsync(directoryPath) {
              cleanupFlushes += 1;
              return base.flushDirectoryAsync(directoryPath);
            }
          };
        }
      });
      const creationRequest = request(environment.serverPath);
      const creationIntent = await environment.service.prepareVerifiedRestorePointCreation(creationRequest);

      await assert.rejects(
        environment.service.createVerifiedRestorePoint(creationRequest, {
          creationIntent,
          async onCreationState() {},
          signal: controller.signal,
          async onProgress() {}
        }),
        error => error?.code === 'CANCELLED'
      );

      assert.equal(fs.existsSync(partPath), replacePart);
      if (replacePart) assert.equal(fs.readFileSync(partPath, 'utf8'), 'user-owned replacement');
      assert.equal(cleanupFlushes, replacePart ? 0 : 1);
    });
  }
});

test('fresh-process recovery removes only the exact partial archive bound by a trusted registry intent', async (t) => {
  const environment = fixture(t);
  const prepared = await environment.service.prepareVerifiedRestorePointCreation(request(environment.serverPath));
  const partPath = path.join(environment.backupDir, prepared.partName);
  fs.writeFileSync(partPath, Buffer.from('interrupted archive bytes'), { flag: 'wx', mode: 0o600 });
  const writing = {
    ...prepared,
    partIdentity: identityFromStat(fs.lstatSync(partPath, { bigint: true })),
    state: 'writing'
  };
  const unclaimedPart = path.join(environment.backupDir, 'restore-point-unclaimed.zip.part');
  fs.writeFileSync(unclaimedPart, Buffer.from('user-owned diagnostic file'), { flag: 'wx' });

  const recoveredService = new RestorePointService({
    fsApi: fs,
    durableFs: durableFor(environment.root),
    clock: () => new Date('2026-08-01T01:03:00.000Z'),
    randomUUID: crypto.randomUUID,
    extractVerifiedArchiveFn: testOnlySecureExtractor
  });
  const result = await recoveredService.cleanupInterruptedRestorePointCreation({
    serverPath: environment.serverPath,
    operationId: 'operation-0001',
    creationIntent: writing
  });
  assert.deepEqual(result, { cleaned: 1, diagnostics: [] });
  assert.equal(fs.existsSync(partPath), false);
  assert.equal(fs.readFileSync(unclaimedPart, 'utf8'), 'user-owned diagnostic file');
});

test('restore creation preparation is read-only and no-claim cleanup does not create a backup directory', async (t) => {
  const environment = fixture(t);
  fs.rmSync(environment.backupDir, { recursive: true });
  const prepared = await environment.service.prepareVerifiedRestorePointCreation(request(environment.serverPath));
  assert.equal(prepared.state, 'prepared');
  assert.deepEqual(prepared.backupDirectory, { existed: false, identity: null });
  assert.equal(fs.existsSync(environment.backupDir), false);

  const cleanup = await environment.service.cleanupInterruptedRestorePointCreation({
    serverPath: environment.serverPath,
    operationId: 'operation-0001',
    creationIntent: null
  });
  assert.deepEqual(cleanup, { cleaned: 0, diagnostics: [] });
  assert.equal(fs.existsSync(environment.backupDir), false);
});

test('restore point creation reports monotonic writing and verified registry states', async (t) => {
  const environment = fixture(t);
  const prepared = await environment.service.prepareVerifiedRestorePointCreation(request(environment.serverPath));
  const states = [];
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath), {
    creationIntent: prepared,
    onCreationState: async state => { states.push(state); }
  });

  assert.deepEqual(states.map(state => state.state), [
    'writing', 'verified', 'metadata-writing', 'metadata-staged', 'archive-published', 'published'
  ]);
  assert.equal(states[0].partIdentity !== null, true);
  assert.equal(states[1].archiveSha256, reference.sha256);
  assert.equal(states[1].archiveSize, reference.size);
  assert.match(states[1].metadataSha256, /^[a-f0-9]{64}$/);
  assert.equal(states[2].metadataIdentity !== null, true);
});

test('an inactive server restore point preserves an explicit null source runtime', async (t) => {
  const { serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint({
    ...request(serverPath),
    sourceRuntime: null
  });
  assert.equal(reference.sourceRuntime, null);
  assert.equal((await service.resolveRestorePoint({
    serverPath,
    id: reference.id,
    sha256: reference.sha256
  })).sourceRuntime, null);
  assert.equal((await service.verifyRestorePoint(reference)).ok, true);
});

test('an exact restore point can be resolved privately by server, id, and archive digest', async (t) => {
  const { serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint(request(serverPath));

  const resolved = await service.resolveRestorePoint({
    serverPath,
    id: reference.id,
    sha256: reference.sha256
  });
  assert.deepEqual(resolved, reference);
  await assert.rejects(service.resolveRestorePoint({
    serverPath,
    id: reference.id,
    sha256: 'f'.repeat(64)
  }), error => error?.code === 'BACKUP_FAILED');
});

test('exact restore-point resolution forwards bounded aggregate archive verification progress', async (t) => {
  const { serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  const progress = [];

  const resolved = await service.resolveRestorePoint({
    serverPath,
    id: reference.id,
    sha256: reference.sha256
  }, {
    onProgress(value) { progress.push(value); }
  });

  assert.deepEqual(resolved, reference);
  assert.equal(progress.some(value => value.phase === 'archive-hash'), true);
  assert.ok(progress.length < 20, 'resolution progress must stay bounded');
  assert.equal(progress.every(value => Object.hasOwn(value, 'processedBytes')), true);
  assert.equal(progress.every(value => Object.hasOwn(value, 'totalBytes')), true);
});

test('Windows backup-directory casing cannot make a restore point include its own output', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows path alias semantics only');
    return;
  }
  const environment = fixture(t);
  const temporary = path.join(environment.serverPath, 'backup-case-transition');
  fs.renameSync(environment.backupDir, temporary);
  fs.renameSync(temporary, path.join(environment.serverPath, 'Backups'));
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const metadata = JSON.parse(fs.readFileSync(reference.metadataPath, 'utf8'));
  assert.equal(metadata.scope.entries.some(entry => entry.path.toLocaleLowerCase('en-US').startsWith('backups/')), false);
});

test('a scope mismatch never publishes a visible restore point', async (t) => {
  let serverPath;
  const createVerifiedZipFn = async (options) => {
    fs.writeFileSync(path.join(serverPath, 'late-file.txt'), 'late mutation');
    return createVerifiedZip(options);
  };
  const environment = fixture(t, { createVerifiedZipFn });
  serverPath = environment.serverPath;
  await assert.rejects(
    environment.service.createVerifiedRestorePoint(request(serverPath)),
    error => error.code === 'BACKUP_FAILED'
  );
  assert.deepEqual(visibleZipFiles(environment.backupDir).filter(name => name.startsWith('restore-point-')), []);
});

test('archive close, integrity, manifest, and pre-publication failures expose no restore-point zip', async (t) => {
  for (const point of ['before-archive-close', 'during-integrity-test', 'during-manifest-comparison', 'before-final-rename']) {
    await t.test(point, async (st) => {
      const environment = fixture(st, {
        faultInjector(candidate) {
          if (candidate === point) throw new Error(`injected ${point}`);
        }
      });
      await assert.rejects(
        environment.service.createVerifiedRestorePoint(request(environment.serverPath)),
        error => error.code === 'BACKUP_FAILED'
      );
      assert.deepEqual(visibleZipFiles(environment.backupDir).filter(name => name.startsWith('restore-point-')), []);
    });
  }
});

test('failure or uncertainty after the final rename is retained and recovery finishes the pin', async (t) => {
  for (const option of [{ failRenameNumber: 2 }, { uncertainRenameNumber: 1 }]) {
    await t.test(JSON.stringify(option), async (st) => {
      const environment = fixture(st, option);
      await assert.rejects(
        environment.service.createVerifiedRestorePoint(request(environment.serverPath)),
        error => error.code === 'BACKUP_FAILED'
      );
      const visible = visibleZipFiles(environment.backupDir).filter(name => name.startsWith('restore-point-'));
      assert.equal(visible.length, 1);
      assert.equal(fs.readdirSync(environment.backupDir).some(name => name.endsWith('.pending.json')), true);

      const recoveredService = new RestorePointService({
        fsApi: fs,
        durableFs: durableFor(environment.root),
        clock: () => new Date('2026-08-01T01:03:00.000Z'),
        randomUUID: crypto.randomUUID,
        extractVerifiedArchiveFn: testOnlySecureExtractor
      });
      const recovery = await recoveredService.recoverPendingRestorePoints(environment.serverPath);
      assert.equal(recovery.recovered.length, 1);
      assert.equal(recovery.diagnostics.length, 0);
      const metadata = JSON.parse(fs.readFileSync(path.join(environment.backupDir, visible[0].replace(/\.zip$/, '.json')), 'utf8'));
      assert.deepEqual(metadata.pins, ['operation-0001']);
    });
  }
});

test('uncertainty after final metadata publication is reconciled to the exact pinned restore point', async (t) => {
  const environment = fixture(t, { uncertainRenameNumber: 2 });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  assert.equal(fs.existsSync(reference.archivePath), true);
  assert.equal(fs.existsSync(reference.metadataPath), true);
  assert.equal(fs.existsSync(reference.archivePath.replace(/\.zip$/, '.pending.json')), false);
  const recovery = await environment.service.recoverPendingRestorePoints(environment.serverPath);
  assert.equal(recovery.discovered.some(item => item.id === reference.id && item.operationId === 'operation-0001'), true);
  assert.equal(recovery.diagnostics.length, 0);
});

test('ordinary pin and verification do not rehash unrelated historical restore points', async (t) => {
  let nextId = 0x17;
  const verifiedArchives = [];
  const environment = fixture(t, {
    randomUUID: () => `00000000-0000-4000-8000-${(++nextId).toString(16).padStart(12, '0')}`,
    async zipStreamVerifier(archivePath, scope) {
      verifiedArchives.push(archivePath);
      return verifyZipScopeStreaming(archivePath, scope);
    }
  });
  const first = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const secondRequest = { ...request(environment.serverPath), operationId: 'operation-0002' };
  const second = await environment.service.createVerifiedRestorePoint(secondRequest);

  verifiedArchives.length = 0;
  await environment.service.pinRestorePoint({ ...first, pinId: 'history-no-rescan' });
  assert.deepEqual(verifiedArchives, [first.archivePath]);

  verifiedArchives.length = 0;
  await environment.service.verifyRestorePoint(first);
  assert.deepEqual(verifiedArchives, [first.archivePath]);
  assert.notEqual(first.archivePath, second.archivePath);
});

test('recovery reconciles an uncertain pending metadata rename exactly once', async (t) => {
  const environment = fixture(t, { failRenameNumber: 2 });
  await assert.rejects(
    environment.service.createVerifiedRestorePoint(request(environment.serverPath)),
    error => error.code === 'BACKUP_FAILED'
  );
  const pendingName = fs.readdirSync(environment.backupDir).find(name => name.endsWith('.pending.json'));
  assert.ok(pendingName);

  const recoveredService = new RestorePointService({
    fsApi: fs,
    durableFs: durableFor(environment.root, { uncertainRenameNumber: 1 }),
    clock: () => new Date('2026-08-01T01:03:00.000Z'),
    randomUUID: crypto.randomUUID,
    extractVerifiedArchiveFn: testOnlySecureExtractor
  });
  const recovery = await recoveredService.recoverPendingRestorePoints(environment.serverPath);
  assert.equal(recovery.recovered.length, 1);
  assert.equal(recovery.diagnostics.length, 0);
  assert.equal(recovery.discovered.some(item => item.id === recovery.recovered[0].id), false);
  assert.equal(fs.existsSync(path.join(environment.backupDir, pendingName)), false);
  assert.equal(fs.existsSync(path.join(environment.backupDir, pendingName.replace('.pending.json', '.json'))), true);
});

test('a first final-rename failure leaves no visible restore-point zip', async (t) => {
  const environment = fixture(t, { failRenameNumber: 1 });
  await assert.rejects(
    environment.service.createVerifiedRestorePoint(request(environment.serverPath)),
    error => error.code === 'BACKUP_FAILED'
  );
  assert.deepEqual(visibleZipFiles(environment.backupDir).filter(name => name.startsWith('restore-point-')), []);
});

test('pin owners are idempotent and retention cannot delete or rename a pinned restore point', async (t) => {
  const { serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  const historyReference = { ...reference, pinId: 'history-0001' };
  await service.pinRestorePoint(historyReference);
  await service.pinRestorePoint(historyReference);
  await service.unpinRestorePoint(reference);
  assert.equal(service.isRestorePointPinned(reference), true);

  await withBackupService(async (backupService) => {
    const refusedDelete = await backupService.deleteBackup({ serverPath, name: reference.name });
    assert.equal(refusedDelete.success, false);
    assert.match(refusedDelete.error, /pinned/i);
    await assert.rejects(
      backupService.renameBackup({ serverPath, oldName: reference.name, newName: 'renamed.zip' }),
      /pinned/i
    );

    await service.unpinRestorePoint(historyReference);
    assert.equal(service.isRestorePointPinned(reference), false);
    assert.equal((await backupService.deleteBackup({ serverPath, name: reference.name })).success, true);
  });
});

test('a concurrent pin commits before delete can decide whether the restore point is removable', async (t) => {
  let pausePin = false;
  let entered;
  let release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  const environment = fixture(t, {
    async faultInjector(point) {
      if (point === 'before-pin-cas-write' && pausePin) {
        entered();
        await releasePromise;
      }
    }
  });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  await environment.service.unpinRestorePoint(reference);
  pausePin = true;

  await withBackupService(async (backupService) => {
    const pin = environment.service.pinRestorePoint({ ...reference, pinId: 'history-race' });
    await enteredPromise;
    let deleteSettled = false;
    const deletion = backupService.deleteBackup({ serverPath: environment.serverPath, name: reference.name })
      .then(result => { deleteSettled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deleteSettled, false);
    release();
    await pin;
    const result = await deletion;
    assert.equal(result.success, false);
    assert.match(result.error, /pinned/i);
    assert.equal(fs.existsSync(reference.archivePath), true);
  });
});

test('a junction alias cannot bypass the canonical pin-delete lock', async (t) => {
  let pausePin = false;
  let entered;
  let release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  const environment = fixture(t, {
    async faultInjector(point) {
      if (point === 'before-pin-cas-write' && pausePin) {
        entered();
        await releasePromise;
      }
    }
  });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  await environment.service.unpinRestorePoint(reference);
  const alias = path.join(environment.root, 'server-alias');
  try {
    fs.symlinkSync(environment.serverPath, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory aliases unavailable on this host: ${error.code}`);
    return;
  }
  pausePin = true;
  await withBackupService(async (backupService) => {
    const pin = environment.service.pinRestorePoint({ ...reference, pinId: 'history-alias-race' });
    await enteredPromise;
    const deletion = await backupService.deleteBackup({ serverPath: alias, name: reference.name });
    assert.equal(deletion.success, false);
    release();
    await pin;
    assert.equal(fs.existsSync(reference.archivePath), true);
  });
});

test('restore reconstructs exact bytes only in a fresh candidate and rejects corruption', async (t) => {
  const { root, serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  const candidate = path.join(root, 'candidate');
  const restored = await service.restoreToFreshCandidate(reference, candidate);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(candidate, 'world', 'level.dat'), 'utf8'), 'world-data');
  assert.equal(fs.readFileSync(path.join(candidate, 'server.jar'), 'utf8'), 'server-binary');
  await assert.rejects(service.restoreToFreshCandidate(reference, candidate), error => error.code === 'TARGET_EXISTS');

  fs.appendFileSync(reference.archivePath, 'corruption');
  await assert.rejects(service.verifyRestorePoint(reference), error => error.code === 'BACKUP_FAILED');
  const corruptCandidate = path.join(root, 'corrupt-candidate');
  await assert.rejects(service.restoreToFreshCandidate(reference, corruptCandidate), error => error.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(corruptCandidate), false);
});

test('restore forwards bounded extraction counters through its public progress callback', async (t) => {
  let extractorReceivedProgress = false;
  const environment = fixture(t, {
    async extractVerifiedArchiveFn(options) {
      extractorReceivedProgress = typeof options.onProgress === 'function';
      options.onProgress({
        phase: 'extraction', processedBytes: 5, totalBytes: 10,
        processedItems: 1, totalItems: 2
      });
      options.onProgress({
        phase: 'extraction', processedBytes: 10, totalBytes: 10,
        processedItems: 2, totalItems: 2
      });
      return testOnlySecureExtractor(options);
    }
  });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const progress = [];
  const destination = path.join(environment.root, 'progress-candidate');

  const restored = await environment.service.restoreToFreshCandidate(reference, destination, {
    onProgress(value) { progress.push(value); }
  });

  assert.equal(restored.ok, true);
  assert.equal(extractorReceivedProgress, true);
  assert.deepEqual(progress.find(value => value.phase === 'extraction' && value.processedBytes === 10), {
    phase: 'extraction', processedBytes: 10, totalBytes: 10, processedItems: 2, totalItems: 2
  });
  assert.deepEqual(progress.at(-1), {
    phase: 'complete', processedBytes: Number(reference.totalBytes), totalBytes: Number(reference.totalBytes),
    processedItems: 3, totalItems: 3
  });
  assert.ok(progress.length < 30, 'restore progress must remain bounded');
});

test('restore forwards the exact lifecycle cancellation signal into secure extraction', async (t) => {
  let receivedSignal = null;
  const environment = fixture(t, {
    async extractVerifiedArchiveFn(options) {
      receivedSignal = options.signal;
      return testOnlySecureExtractor(options);
    }
  });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const destination = path.join(environment.root, 'signal-bound-candidate');
  const controller = new AbortController();

  const restored = await environment.service.restoreToFreshCandidate(reference, destination, {
    signal: controller.signal
  });

  assert.equal(restored.ok, true);
  assert.equal(receivedSignal, controller.signal);
});

test('available restore-point listing intersects durable history with the exact published sidecar and archive', async (t) => {
  const { serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  const items = await service.listAvailableRestorePoints({
    serverPath,
    history: [{
      operationId: reference.operationId,
      kind: 'upgrade',
      outcome: 'completed',
      timestamp: '2026-08-01T01:03:00.000Z',
      sourceRevision: reference.sourceRevision,
      restorePointId: reference.id,
      restorePointSha256: reference.sha256,
      restorePointTotalBytes: reference.totalBytes,
      sourceRuntime: reference.sourceRuntime
    }]
  });

  assert.deepEqual(items, [{
    restorePointId: reference.id,
    operationKind: 'upgrade',
    createdAt: reference.createdAt,
    sourceRevision: reference.sourceRevision,
    runtime: reference.sourceRuntime,
    totalBytes: reference.totalBytes
  }]);
  assert.equal(JSON.stringify(items).includes(serverPath), false);
  assert.equal(JSON.stringify(items).includes(reference.sha256), false);
});

test('available restore-point listing omits missing, redirected, duplicated, and history-mismatched artifacts', async (t) => {
  const { backupDir, serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  const archiveBytes = fs.readFileSync(reference.archivePath);
  const historyEntry = {
    operationId: reference.operationId,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-01T01:03:00.000Z',
    sourceRevision: reference.sourceRevision,
    restorePointId: reference.id,
    restorePointSha256: reference.sha256,
    restorePointTotalBytes: reference.totalBytes,
    sourceRuntime: reference.sourceRuntime
  };

  assert.deepEqual(await service.listAvailableRestorePoints({
    serverPath,
    history: [{ ...historyEntry, restorePointSha256: 'f'.repeat(64) }]
  }), []);

  fs.rmSync(reference.archivePath);
  assert.deepEqual(await service.listAvailableRestorePoints({ serverPath, history: [historyEntry] }), []);

  fs.writeFileSync(reference.archivePath, 'replacement');
  assert.deepEqual(await service.listAvailableRestorePoints({ serverPath, history: [historyEntry] }), []);

  fs.writeFileSync(reference.archivePath, archiveBytes);
  const duplicateName = reference.name.replace(/-[^-]+\.zip$/u, '-duplicate.zip');
  const duplicateMetadataPath = path.join(backupDir, duplicateName.replace(/\.zip$/u, '.json'));
  const duplicateArchivePath = path.join(backupDir, duplicateName);
  const duplicateMetadata = JSON.parse(fs.readFileSync(reference.metadataPath, 'utf8'));
  duplicateMetadata.name = duplicateName;
  fs.writeFileSync(duplicateArchivePath, archiveBytes);
  fs.writeFileSync(duplicateMetadataPath, `${JSON.stringify(duplicateMetadata, null, 2)}\n`);
  assert.deepEqual(await service.listAvailableRestorePoints({ serverPath, history: [historyEntry] }), []);
});

test('restore batches its verified tree durability sweep before publication', async (t) => {
  const singleFlushes = [];
  const batches = [];
  const environment = fixture(t, {
    durableFsFactory(root) {
      const base = durableFor(root);
      return {
        ...base,
        flushDirectory(directoryPath) {
          singleFlushes.push(directoryPath);
          return base.flushDirectory(directoryPath);
        },
        async flushDirectoryAsync(directoryPath) {
          singleFlushes.push(directoryPath);
          return base.flushDirectoryAsync(directoryPath);
        },
        flushDirectories(directoryPaths) {
          batches.push([...directoryPaths]);
          for (const directoryPath of directoryPaths) base.flushDirectory(directoryPath);
        },
        async flushDirectoriesAsync(directoryPaths) {
          batches.push([...directoryPaths]);
          for (const directoryPath of directoryPaths) await base.flushDirectoryAsync(directoryPath);
        }
      };
    }
  });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  singleFlushes.length = 0;
  batches.length = 0;

  const destination = path.join(environment.root, 'batched-candidate');
  await environment.service.restoreToFreshCandidate(reference, destination);

  assert.equal(batches.length, 1);
  assert.equal(new Set(batches[0]).size, batches[0].length);
  assert.ok(batches[0].some(directoryPath => path.basename(directoryPath).startsWith('restore-staging-')));
  assert.ok(batches[0].includes(environment.root));
  assert.deepEqual(singleFlushes, [environment.root]);
});

test('restore cancellation stops the post-extraction durability sweep between native batches', async (t) => {
  const controller = new AbortController();
  const batches = [];
  let restoring = false;
  const environment = fixture(t, {
    durableFsFactory(root) {
      const base = durableFor(root);
      return {
        ...base,
        async flushDirectoriesAsync(directoryPaths) {
          if (!restoring) return base.flushDirectoriesAsync(directoryPaths);
          batches.push([...directoryPaths]);
          await base.flushDirectoriesAsync(directoryPaths);
          if (batches.length === 1) controller.abort();
        }
      };
    }
  });
  for (let index = 0; index < MAX_FLUSH_DIRECTORIES + 2; index += 1) {
    fs.mkdirSync(path.join(environment.serverPath, `durability-${String(index).padStart(4, '0')}`));
  }
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const destination = path.join(environment.root, 'cancelled-batched-candidate');
  restoring = true;

  await assert.rejects(
    environment.service.restoreToFreshCandidate(reference, destination, { signal: controller.signal }),
    error => error?.code === 'CANCELLED'
  );

  assert.equal(batches.length, 1, 'an abort inside one durable batch must prevent the next batch');
  assert.equal(batches[0].length, MAX_FLUSH_DIRECTORIES);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readdirSync(environment.root).some(name => name.startsWith('restore-staging-')), false);
});

test('restore cancellation stops the post-extraction durability fallback between directories', async (t) => {
  const controller = new AbortController();
  const stagingFlushes = [];
  let restoring = false;
  const environment = fixture(t, {
    durableFsFactory(root) {
      const base = durableFor(root);
      return {
        ...base,
        flushDirectoriesAsync: undefined,
        async flushDirectoryAsync(directoryPath) {
          const isStagingDirectory = restoring && path.resolve(directoryPath)
            .split(path.sep)
            .some(segment => segment.startsWith('restore-staging-'));
          if (isStagingDirectory) stagingFlushes.push(directoryPath);
          await base.flushDirectoryAsync(directoryPath);
          if (isStagingDirectory && stagingFlushes.length === 1) controller.abort();
        }
      };
    }
  });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const destination = path.join(environment.root, 'cancelled-fallback-candidate');
  restoring = true;

  await assert.rejects(
    environment.service.restoreToFreshCandidate(reference, destination, { signal: controller.signal }),
    error => error?.code === 'CANCELLED'
  );

  assert.equal(stagingFlushes.length, 1, 'an abort inside one directory flush must prevent the next directory flush');
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readdirSync(environment.root).some(name => name.startsWith('restore-staging-')), false);
});

test('restore extracts only into the private workspace of an exact operation-owned candidate', async (t) => {
  const { root, serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  const operationId = 'operation-owned';
  const candidateRoot = path.join(root, `.server.minecraft-core.${operationId}.candidate`);
  const operationWorkspace = path.join(candidateRoot, '.minecraft-core-state', 'operations', operationId);
  const destination = path.join(operationWorkspace, 'selected-restore');
  fs.mkdirSync(operationWorkspace, { recursive: true });

  const restored = await service.restoreToOwnedCandidate(reference, destination, candidateRoot);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(destination, 'world', 'level.dat'), 'utf8'), 'world-data');
  assert.equal(fs.readFileSync(path.join(destination, 'server.jar'), 'utf8'), 'server-binary');
  assert.equal(fs.readdirSync(operationWorkspace).some(name => name.startsWith('restore-staging-')), false);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('restore-staging-')), false);

  const directChild = path.join(candidateRoot, 'not-private');
  await assert.rejects(
    service.restoreToOwnedCandidate(reference, directChild, candidateRoot),
    error => error.code === 'BACKUP_FAILED'
  );
  assert.equal(fs.existsSync(directChild), false);
});

test('restore accepts the private workspace of a compact operation-owned candidate', async (t) => {
  const { root, serverPath, service } = fixture(t);
  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  const operationId = `op2-${'a'.repeat(32)}`;
  const candidateRoot = path.join(root, `.${operationId}.c`);
  const operationWorkspace = path.join(candidateRoot, '.minecraft-core-state', 'operations', operationId);
  const destination = path.join(operationWorkspace, 'selected-restore');
  fs.mkdirSync(operationWorkspace, { recursive: true });

  const restored = await service.restoreToOwnedCandidate(reference, destination, candidateRoot);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(destination, 'world', 'level.dat'), 'utf8'), 'world-data');
});

test('restore binds the secure extractor to the already reviewed archive digest and scope', async (t) => {
  let received = null;
  const environment = fixture(t, {
    async extractVerifiedArchiveFn(options) {
      received = options;
      return testOnlySecureExtractor(options);
    }
  });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const destination = path.join(environment.root, 'bound-candidate');
  await environment.service.restoreToFreshCandidate(reference, destination);
  assert.equal(received.expectedArchiveSha256, reference.sha256);
  assert.equal(received.expectedArchiveSize, reference.size);
  assert.equal(received.expectedScope.scopeSha256, reference.scopeSha256);
  assert.notEqual(received.stagingPath, destination);
  assert.equal(path.dirname(received.stagingPath), path.dirname(destination));
});

test('restore adopts an exact identity-matching destination after durable rename uncertainty', async (t) => {
  const environment = fixture(t, { uncertainRenameNumber: 3 });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const destination = path.join(environment.root, 'uncertain-candidate');
  const restored = await environment.service.restoreToFreshCandidate(reference, destination);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(destination, 'world', 'level.dat'), 'utf8'), 'world-data');
  assert.equal(fs.readdirSync(environment.root).some(name => name.startsWith('restore-staging-')), false);
});

test('restore fails closed when the secure extractor detects a substituted intermediate directory', async (t) => {
  const environment = fixture(t, {
    async extractVerifiedArchiveFn({ stagingPath }) {
      fs.mkdirSync(stagingPath, { recursive: false });
      throw new Error('intermediate directory identity changed');
    }
  });
  const reference = await environment.service.createVerifiedRestorePoint(request(environment.serverPath));
  const destination = path.join(environment.root, 'substitution-candidate');
  await assert.rejects(
    environment.service.restoreToFreshCandidate(reference, destination),
    error => error.code === 'BACKUP_FAILED'
  );
  assert.equal(fs.existsSync(destination), false);
});

test('tampered pending metadata is retained diagnostically and never auto-pinned', async (t) => {
  const { backupDir, serverPath, service } = fixture(t);
  fs.writeFileSync(path.join(backupDir, 'restore-point-hostile.pending.json'), '{bad');
  const result = await service.recoverPendingRestorePoints(serverPath);
  assert.equal(result.recovered.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(fs.existsSync(path.join(backupDir, 'restore-point-hostile.pending.json')), true);
});

test('restore-point inputs reject accessors coercion hooks and raw traversal without executing user code', async (t) => {
  const { root, serverPath, service } = fixture(t);
  let hookCalls = 0;
  const unsafeItems = [];
  Object.defineProperty(unsafeItems, '0', {
    enumerable: true,
    get() {
      hookCalls += 1;
      return path.join(serverPath, 'world');
    }
  });
  unsafeItems.length = 1;
  assert.throws(() => enumerateArchiveScope(unsafeItems), error => error.code === 'BACKUP_FAILED');

  const unsafeRequest = request(serverPath);
  unsafeRequest.operationId = {
    toString() {
      hookCalls += 1;
      return 'operation-0001';
    }
  };
  await assert.rejects(service.createVerifiedRestorePoint(unsafeRequest), error => error.code === 'BACKUP_FAILED');
  assert.equal(hookCalls, 0);

  const reference = await service.createVerifiedRestorePoint(request(serverPath));
  const unsafeReference = {
    ...reference,
    archivePath: {
      toString() {
        hookCalls += 1;
        return reference.archivePath;
      }
    }
  };
  await assert.rejects(service.verifyRestorePoint(unsafeReference), error => error.code === 'BACKUP_FAILED');
  await assert.rejects(
    service.restoreToFreshCandidate(reference, `${root}${path.sep}alias${path.sep}..${path.sep}candidate`),
    error => error.code === 'BACKUP_FAILED'
  );
  assert.equal(hookCalls, 0);
});
