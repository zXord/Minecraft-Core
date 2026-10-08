const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const AdmZip = require('adm-zip');
const archiver = require('archiver');

const {
  createVerifiedZip,
  enumerateArchiveScope,
  verifyZipScopeStreaming
} = require('../../electron/utils/backup-util.cjs');
const {
  createVerifiedRestoreExtractor
} = require('../../electron/services/modpack-lifecycle/verified-restore-extractor.cjs');

const noReparse = Object.freeze({
  async isReparsePoint() { return false; }
});

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-restore-extractor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function scope(entries) {
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  return {
    schemaVersion: 1,
    entries: ordered,
    totalBytes: ordered.reduce((total, entry) => total + entry.size, 0),
    fileCount: ordered.filter(entry => entry.type === 'file').length,
    scopeSha256: crypto.createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex')
  };
}

function archiveIdentity(archivePath) {
  const stat = fs.lstatSync(archivePath, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    birthtimeNs: String(stat.birthtimeNs),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function archiveEvidence(archivePath) {
  const bytes = fs.readFileSync(archivePath);
  return {
    expectedArchiveSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    expectedArchiveSize: bytes.length,
    expectedArchiveIdentity: archiveIdentity(archivePath)
  };
}

async function verifiedFixture(t) {
  const root = temporaryRoot(t);
  const source = path.join(root, 'source');
  const world = path.join(source, 'world');
  fs.mkdirSync(world, { recursive: true });
  fs.writeFileSync(path.join(source, 'server.properties'), 'server-port=25565\n');
  fs.writeFileSync(path.join(world, 'level.dat'), 'world-data');
  const expectedScope = enumerateArchiveScope([
    path.join(source, 'server.properties'),
    world
  ]);
  const archivePath = path.join(root, 'restore.zip');
  const partPath = `${archivePath}.part`;
  await createVerifiedZip({
    items: [path.join(source, 'server.properties'), world],
    partPath,
    expectedScope
  });
  fs.renameSync(partPath, archivePath);
  const evidence = await verifyZipScopeStreaming(archivePath, expectedScope);
  return {
    archivePath,
    expectedScope,
    root,
    request(stagingName = 'staging') {
      return {
        archivePath,
        stagingPath: path.join(root, stagingName),
        expectedArchiveSha256: evidence.archiveSha256,
        expectedArchiveSize: evidence.archiveSize,
        expectedArchiveIdentity: evidence.archiveIdentity,
        expectedScope,
        operationId: 'restore-operation-1'
      };
    }
  };
}

function createExtractor(options = {}) {
  return createVerifiedRestoreExtractor({
    fsApi: fs,
    reparseInspector: noReparse,
    durableFs: { flushDirectory() {} },
    ...options
  });
}

async function writeSymlinkZip(archivePath, entryName, target) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 0 } });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.symlink(entryName, target);
    archive.finalize();
  });
}

test('verified restore extraction binds archive identity, digest, scope, and post-extraction fingerprint', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request();
  const result = await createExtractor()(request);

  assert.equal(result.ok, true);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.scopeSha256, fixture.expectedScope.scopeSha256);
  assert.equal(fs.readFileSync(path.join(request.stagingPath, 'world', 'level.dat'), 'utf8'), 'world-data');
  assert.equal(fs.readFileSync(path.join(request.stagingPath, 'server.properties'), 'utf8'), 'server-port=25565\n');
});

test('restore extraction accepts reviewed archive ctime-only churn before and during extraction', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('ctime-only-staging');
  request.expectedArchiveIdentity = {
    ...request.expectedArchiveIdentity,
    ctimeNs: String(BigInt(request.expectedArchiveIdentity.ctimeNs) - 1n)
  };
  let changed = false;
  const alter = stat => {
    if (!stat || !changed || stat.ino !== BigInt(request.expectedArchiveIdentity.ino)) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ctimeNs: stat.ctimeNs + 1n });
  };
  const fsApi = Object.create(fs);
  fsApi.lstatSync = (...args) => alter(fs.lstatSync(...args));
  fsApi.fstatSync = (...args) => alter(fs.fstatSync(...args));
  const result = await createExtractor({
    fsApi,
    faultInjector(stage) { if (stage === 'archive-pinned') changed = true; }
  })(request);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(request.stagingPath, 'world', 'level.dat'), 'utf8'), 'world-data');
});

for (const stage of ['archive-opened', 'archive-pinned', 'after-file-flush']) {
  for (const mutation of ['hardlink', 'mode']) {
    test(`restore extraction rejects ${mutation} mutation at ${stage}`, async t => {
      const fixture = await verifiedFixture(t);
      const request = fixture.request(`${mutation}-${stage}-staging`);
      const before = fs.lstatSync(fixture.archivePath, { bigint: true });
      let changed = false;
      const mutate = () => {
        if (changed) return;
        changed = true;
        if (mutation === 'hardlink') {
          fs.linkSync(fixture.archivePath, path.join(fixture.root, 'archive-alias.zip'));
          assert.equal(fs.lstatSync(fixture.archivePath, { bigint: true }).nlink, before.nlink + 1n);
        }
      };
      const alterMode = stat => {
        if (!stat || !changed || mutation !== 'mode' || stat.ino !== before.ino) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: stat.mode ^ 0o200n });
      };
      const fsApi = Object.create(fs);
      fsApi.lstatSync = (...args) => alterMode(fs.lstatSync(...args));
      fsApi.fstatSync = (...args) => alterMode(fs.fstatSync(...args));
      fsApi.openSync = (...args) => {
        const descriptor = fs.openSync(...args);
        if (stage === 'archive-opened' && args[0] === fixture.archivePath) mutate();
        return descriptor;
      };
      await assert.rejects(createExtractor({
        fsApi,
        faultInjector(currentStage) { if (currentStage === stage) mutate(); }
      })(request), { code: 'BACKUP_FAILED' });
      assert.equal(changed, true, 'the intended in-operation mutation must occur');
      assert.equal(fs.existsSync(request.stagingPath), false);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixture.archivePath)).digest('hex'),
        request.expectedArchiveSha256, 'mode/link evidence must not depend on content changes');
    });
  }
}

test('restore extraction rejects raw archive changes after hashing even when entry bytes match', async t => {
  const fixture = await verifiedFixture(t);
  // Give the ZIP an inert comment whose mutation leaves the declared entries intact.
  const zip = new AdmZip(fixture.archivePath);
  zip.addZipComment('original');
  zip.writeZip(fixture.archivePath);
  const request = { ...fixture.request('raw-change-staging'), ...archiveEvidence(fixture.archivePath) };
  const before = fs.lstatSync(fixture.archivePath, { bigint: true });
  const alter = stat => {
    if (!stat || stat.ino !== before.ino) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs
    });
  };
  const fsApi = Object.create(fs);
  fsApi.lstatSync = (...args) => alter(fs.lstatSync(...args));
  fsApi.fstatSync = (...args) => alter(fs.fstatSync(...args));
  await assert.rejects(createExtractor({
    fsApi,
    faultInjector(stage) {
      if (stage !== 'archive-pinned') return;
      const fd = fs.openSync(fixture.archivePath, 'r+');
      try { fs.writeSync(fd, Buffer.from('modified'), 0, 8, Number(before.size) - 8); }
      finally { fs.closeSync(fd); }
    }
  })(request), { code: 'BACKUP_FAILED' });
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('verified restore extraction publishes bounded byte and file progress without exposing correctness to observers', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('progress-staging');
  const progress = [];

  const result = await createExtractor()({
    ...request,
    onProgress(value) {
      progress.push(value);
      if (value.phase === 'entry-verification') throw new Error('observer failure');
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual([...new Set(progress.map(value => value.phase))], [
    'archive-hash',
    'entry-verification',
    'extraction',
    'output-verification',
    'complete'
  ]);
  const extracted = progress.filter(value => value.phase === 'extraction').at(-1);
  assert.deepEqual(extracted, {
    phase: 'extraction',
    processedBytes: fixture.expectedScope.totalBytes,
    totalBytes: fixture.expectedScope.totalBytes,
    processedItems: fixture.expectedScope.fileCount,
    totalItems: fixture.expectedScope.fileCount
  });
  assert.ok(progress.length <= 20, 'small restores must not flood the progress observer');
});

test('archive hashing yields to cancellation before reading the entire reviewed archive', async t => {
  const root = temporaryRoot(t);
  const archivePath = path.join(root, 'large-reviewed-archive.zip');
  const archiveBytes = Buffer.alloc((8 * 1024 * 1024) + 17, 0x61);
  fs.writeFileSync(archivePath, archiveBytes);
  const expectedScope = scope([{
    path: 'payload.bin',
    type: 'file',
    size: 1,
    sha256: crypto.createHash('sha256').update('x').digest('hex')
  }]);
  const controller = new AbortController();
  let bytesRead = 0;
  const fsApi = Object.create(fs);
  Object.defineProperty(fsApi, 'readSync', {
    configurable: true,
    enumerable: true,
    value(...args) {
      const count = fs.readSync(...args);
      bytesRead += count;
      return count;
    }
  });
  const cancellation = new Promise(resolve => setImmediate(() => {
    controller.abort();
    resolve();
  }));
  const stagingPath = path.join(root, 'cancelled-hash-staging');

  await assert.rejects(createExtractor({ fsApi })({
    archivePath,
    stagingPath,
    ...archiveEvidence(archivePath),
    expectedScope,
    operationId: 'restore-cancelled-hash',
    signal: controller.signal
  }), error => error?.code === 'CANCELLED');
  await cancellation;

  assert.ok(bytesRead > 0, 'hashing must begin before the scheduled cancellation');
  assert.ok(bytesRead < archiveBytes.length, 'hashing must yield before consuming the whole archive');
  assert.equal(fs.existsSync(stagingPath), false);
  assert.equal(fs.existsSync(archivePath), true);
});

test('entry verification cooperatively cancels before creating restore staging', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('cancelled-entry-verification-staging');
  const controller = new AbortController();

  await assert.rejects(createExtractor()({
    ...request,
    signal: controller.signal,
    onProgress(value) {
      if (value.phase === 'entry-verification') controller.abort();
    }
  }), error => error?.code === 'CANCELLED');

  assert.equal(fs.existsSync(request.stagingPath), false);
  assert.equal(fs.existsSync(request.archivePath), true);
});

test('cancellation during root reparse inspection removes the exact newly created staging directory', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('cancelled-root-reparse-staging');
  const controller = new AbortController();
  let cancelledDuringRootInspection = false;
  const reparseInspector = {
    async isReparsePoint(candidate, options) {
      if (!cancelledDuringRootInspection && options?.signal && candidate === request.stagingPath) {
        cancelledDuringRootInspection = true;
        await new Promise(resolve => setImmediate(() => {
          controller.abort();
          resolve();
        }));
      }
      return false;
    }
  };

  await assert.rejects(createExtractor({ reparseInspector })({
    ...request,
    signal: controller.signal
  }), error => error?.code === 'CANCELLED');

  assert.equal(cancelledDuringRootInspection, true);
  assert.equal(fs.existsSync(request.stagingPath), false);
  assert.equal(fs.existsSync(request.archivePath), true);
});

test('cancellation during child reparse inspection removes the exact newly created child and staging tree', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('cancelled-child-reparse-staging');
  const childPath = path.join(request.stagingPath, 'world');
  const controller = new AbortController();
  let cancelledDuringChildInspection = false;
  const reparseInspector = {
    async isReparsePoint(candidate, options) {
      if (!cancelledDuringChildInspection && options?.signal && candidate === childPath) {
        cancelledDuringChildInspection = true;
        await new Promise(resolve => setImmediate(() => {
          controller.abort();
          resolve();
        }));
      }
      return false;
    }
  };

  await assert.rejects(createExtractor({ reparseInspector })({
    ...request,
    signal: controller.signal
  }), error => error?.code === 'CANCELLED');

  assert.equal(cancelledDuringChildInspection, true);
  assert.equal(fs.existsSync(childPath), false);
  assert.equal(fs.existsSync(request.stagingPath), false);
  assert.equal(fs.existsSync(request.archivePath), true);
});

test('extraction cancellation removes only the exact identity-bound staging tree', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('cancelled-extraction-staging');
  const unrelated = path.join(fixture.root, 'unrelated-owned-by-someone-else');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  const controller = new AbortController();
  const fsApi = Object.create(fs);
  let abortedDuringWrite = false;
  Object.defineProperty(fsApi, 'writeSync', {
    configurable: true,
    enumerable: true,
    value(...args) {
      const count = fs.writeSync(...args);
      if (!abortedDuringWrite) {
        abortedDuringWrite = true;
        controller.abort();
      }
      return count;
    }
  });

  await assert.rejects(createExtractor({ fsApi })({
    ...request,
    signal: controller.signal
  }), error => error?.code === 'CANCELLED');

  assert.equal(abortedDuringWrite, true);
  assert.equal(fs.existsSync(request.stagingPath), false);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(request.archivePath), true);
});

test('output verification cancellation removes only the exact identity-bound staging tree', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('cancelled-output-verification-staging');
  const unrelated = path.join(fixture.root, 'unrelated-output-directory');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  const controller = new AbortController();

  await assert.rejects(createExtractor()({
    ...request,
    signal: controller.signal,
    onProgress(value) {
      if (value.phase === 'output-verification') controller.abort();
    }
  }), error => error?.code === 'CANCELLED');

  assert.equal(fs.existsSync(request.stagingPath), false);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(request.archivePath), true);
});

test('verified restore extraction batches directory durability after every file is fsynced', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('batched-staging');
  const singleFlushes = [];
  const batches = [];
  const extract = createExtractor({
    durableFs: {
      flushDirectory(directoryPath) { singleFlushes.push(directoryPath); },
      flushDirectories(directoryPaths) { batches.push([...directoryPaths]); }
    }
  });

  const result = await extract(request);

  assert.equal(result.ok, true);
  assert.deepEqual(singleFlushes, []);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [
    path.join(request.stagingPath, 'world'),
    request.stagingPath,
    path.dirname(request.stagingPath)
  ]);
});

test('verified restore extraction chunks very large directory batches at the native protocol bound', async t => {
  const root = temporaryRoot(t);
  const archivePath = path.join(root, 'many-directories.zip');
  const zip = new AdmZip();
  const entries = [];
  for (let index = 0; index < 1_025; index += 1) {
    const entryPath = `directory-${String(index).padStart(4, '0')}/`;
    zip.addFile(entryPath, Buffer.alloc(0));
    entries.push({ path: entryPath, type: 'directory', size: 0, sha256: null });
  }
  zip.writeZip(archivePath);
  const batches = [];
  const extract = createExtractor({
    durableFs: {
      flushDirectory() { throw new Error('single-directory flush is not expected'); },
      flushDirectories(directoryPaths) { batches.push([...directoryPaths]); }
    }
  });
  const expectedScope = scope(entries);
  const stagingPath = path.join(root, 'many-directories-staging');

  const result = await extract({
    archivePath,
    stagingPath,
    ...archiveEvidence(archivePath),
    expectedScope,
    operationId: 'restore-many-directories'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(batches.map(batch => batch.length), [512, 512, 3]);
  assert.equal(fs.readdirSync(stagingPath).length, 1_025);
});

test('archive substitution after review fails before the owned staging directory is created', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('tampered-staging');
  fs.appendFileSync(fixture.archivePath, Buffer.from('tamper'));

  await assert.rejects(createExtractor()(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('a traversal entry is rejected even when the caller supplies a different safe scope', async t => {
  const root = temporaryRoot(t);
  const archivePath = path.join(root, 'traversal.zip');
  const zip = new AdmZip();
  zip.addFile('../escaped.txt', Buffer.from('escaped'));
  zip.writeZip(archivePath);
  const expectedScope = scope([{
    path: 'safe.txt', type: 'file', size: 7,
    sha256: crypto.createHash('sha256').update('escaped').digest('hex')
  }]);
  const request = {
    archivePath,
    stagingPath: path.join(root, 'staging'),
    ...archiveEvidence(archivePath),
    expectedScope,
    operationId: 'restore-operation-2'
  };

  await assert.rejects(createExtractor()(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(path.join(root, 'escaped.txt')), false);
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('ZIP link entries are rejected even when their bytes match the declared file scope', async t => {
  const root = temporaryRoot(t);
  const archivePath = path.join(root, 'link.zip');
  await writeSymlinkZip(archivePath, 'linked.txt', 'server.properties');
  const payload = Buffer.from('server.properties');
  const expectedScope = scope([{
    path: 'linked.txt', type: 'file', size: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex')
  }]);
  const request = {
    archivePath,
    stagingPath: path.join(root, 'staging'),
    ...archiveEvidence(archivePath),
    expectedScope,
    operationId: 'restore-operation-3'
  };

  await assert.rejects(createExtractor()(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('declared extraction limits are enforced before any destination is created', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('limited-staging');
  const extract = createExtractor({ limits: { maxEntries: 100, maxTotalBytes: 4, maxFileBytes: 4, maxPathDepth: 16 } });

  await assert.rejects(extract(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(fs.existsSync(request.stagingPath), false);
});

test('restore extraction rejects and cleans up when an archive stream stops making progress', async t => {
  const root = temporaryRoot(t);
  const archivePath = path.join(root, 'stalled.zip');
  const stagingPath = path.join(root, 'staging');
  fs.writeFileSync(archivePath, Buffer.from('archive bytes'));
  const payload = Buffer.from('expected payload');
  const expectedScope = scope([{
    path: 'payload.bin',
    type: 'file',
    size: payload.length,
    sha256: crypto.createHash('sha256').update(payload).digest('hex')
  }]);
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
      uncompressedSize: payload.length,
      compressedSize: 1,
      generalPurposeBitFlag: 0,
      externalFileAttributes: 0x80000000
    }));
  };
  zip.openReadStream = (_entry, callback) => setImmediate(() => callback(null, stalledStream));
  zip.close = () => { zipClosed = true; };
  const yauzlApi = {
    fromFd(_descriptor, _options, callback) {
      setImmediate(() => callback(null, zip));
    }
  };
  const extract = createExtractor({ yauzlApi, streamIdleTimeoutMs: 25 });

  await assert.rejects(extract({
    archivePath,
    stagingPath,
    ...archiveEvidence(archivePath),
    expectedScope,
    operationId: 'restore-stalled-stream'
  }), error => error?.code === 'BACKUP_FAILED');
  assert.equal(streamOpened, true);
  assert.equal(streamDestroyed, true);
  assert.equal(zipClosed, true);
  assert.equal(fs.existsSync(stagingPath), false);
});

test('interrupted extraction closes files and removes only its identity-bound staging tree', async t => {
  const fixture = await verifiedFixture(t);
  const request = fixture.request('interrupted-staging');
  let interrupted = false;
  const extract = createExtractor({
    async faultInjector(boundary) {
      if (!interrupted && boundary === 'after-file-flush') {
        interrupted = true;
        throw new Error('interrupted');
      }
    }
  });

  await assert.rejects(extract(request), error => error?.code === 'BACKUP_FAILED');
  assert.equal(interrupted, true);
  assert.equal(fs.existsSync(request.stagingPath), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'server.properties')), false);
});
