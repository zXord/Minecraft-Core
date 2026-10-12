const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  captureServerDirectoryCopySource,
  copyServerDirectoryContents,
  inspectAndFlushServerDirectoryTree,
  inspectServerDirectoryStructure,
  inspectServerDirectoryTree
} = require('../electron/services/modpack-lifecycle/server-directory-identity.cjs');

function rejectingSyncContentFs() {
  const fsApi = Object.create(fs);
  for (const method of ['closeSync', 'fstatSync', 'fsyncSync', 'openSync', 'readSync', 'writeSync']) {
    fsApi[method] = () => { throw new Error(`synchronous content method ${method} must not run`); };
  }
  return fsApi;
}

test('read-only check snapshot batches observed completed files without altering authority', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-observed-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let index = 0; index < 130; index++) fs.writeFileSync(path.join(root, `${index}.txt`), 'x');
  const events = [];
  const snapshot = await captureServerDirectoryCopySource(root, { reparseInspector: { async isReparsePoint() { return false; } },
    onInspectionProgress: event => { events.push(event); throw new Error('observer only'); } });
  assert.equal(snapshot.entries.length, 130);
  assert.deepEqual(events.map(event => event.completedItems), ['64', '128', '130']);
  assert.ok(events.every(event => event.phase === 'checking-client-files' && event.totalItems === undefined && !('path' in event)));
});

test('read-only check snapshot cancellation still refuses a verdict after observed files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-observed-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'one'), 'x'); const controller = new AbortController();
  await assert.rejects(captureServerDirectoryCopySource(root, { signal: controller.signal, reparseInspector: { async isReparsePoint() { return false; } },
    onInspectionProgress: () => controller.abort() }), { code: 'CANCELLED' });
});

test('read-only check snapshot observer cannot bypass final freshness revalidation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-observed-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'one'); fs.writeFileSync(file, 'x');
  await assert.rejects(captureServerDirectoryCopySource(root, { reparseInspector: { async isReparsePoint() { return false; } },
    onInspectionProgress: () => fs.writeFileSync(file, 'changed') }), { code: 'RECOVERY_REQUIRED' });
});

function asyncDirectoryDurability() {
  return {
    flushDirectory() { throw new Error('synchronous directory durability must not run'); },
    async flushDirectoryAsync() { await new Promise(resolve => setImmediate(resolve)); },
    async flushDirectoriesAsync() { await new Promise(resolve => setImmediate(resolve)); }
  };
}

test('whole-tree hashing and file durability use asynchronous file handles', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-async-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = Buffer.alloc((3 * 1024 * 1024) + 17, 0x63);
  fs.writeFileSync(path.join(root, 'server.jar'), payload);
  let timerObserved = false;
  const fsPromises = Object.create(fs.promises);
  fsPromises.open = async (...args) => {
    const handle = await fs.promises.open(...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'read') {
          return async (...readArgs) => {
            await new Promise(resolve => setImmediate(() => {
              timerObserved = true;
              resolve();
            }));
            return target.read(...readArgs);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };

  const inspection = await inspectAndFlushServerDirectoryTree(root, {
    fsApi: rejectingSyncContentFs(),
    fsPromises,
    durableFs: asyncDirectoryDurability(),
    reparseInspector: { async isReparsePoint() { return false; } }
  });

  assert.equal(inspection.totalBytes, String(payload.length));
  assert.equal(timerObserved, true);
});

test('candidate copy uses asynchronous reads, writes, and file durability', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-async-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  const payload = Buffer.alloc((3 * 1024 * 1024) + 29, 0x4d);
  fs.writeFileSync(path.join(source, 'payload.bin'), payload);

  const result = await copyServerDirectoryContents(source, destination, {
    fsApi: rejectingSyncContentFs(),
    fsPromises: fs.promises,
    durableFs: asyncDirectoryDurability(),
    reparseInspector: { async isReparsePoint() { return false; } }
  });

  assert.equal(result.copiedBytes, String(payload.length));
  assert.deepEqual(fs.readFileSync(path.join(destination, 'payload.bin')), payload);
});

test('candidate copy durably flushes each completed directory once instead of every copied entry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(path.join(source, 'nested', 'deep'), { recursive: true });
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, 'root.txt'), 'root');
  fs.writeFileSync(path.join(source, 'nested', 'one.txt'), 'one');
  fs.writeFileSync(path.join(source, 'nested', 'two.txt'), 'two');
  fs.writeFileSync(path.join(source, 'nested', 'deep', 'three.txt'), 'three');
  const batches = [];

  const result = await copyServerDirectoryContents(source, destination, {
    fsApi: fs,
    durableFs: {
      async flushDirectoryAsync() { throw new Error('single-directory flush is not expected'); },
      async flushDirectoriesAsync(directoryPaths) {
        batches.push(directoryPaths.map(directoryPath => path.resolve(directoryPath)));
      }
    },
    reparseInspector: { async isReparsePoint() { return false; } }
  });

  assert.equal(result.copiedFiles, 4);
  assert.equal(fs.readFileSync(path.join(destination, 'nested', 'deep', 'three.txt'), 'utf8'), 'three');
  assert.deepEqual(batches, [[
    path.resolve(destination, 'nested', 'deep'),
    path.resolve(destination, 'nested'),
    path.resolve(destination)
  ]]);
});

test('candidate copy reads each source byte only for the before snapshot, copy, and after snapshot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-copy-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  const payload = Buffer.alloc((2 * 1024 * 1024) + 117, 0x5a);
  const sourceFile = path.join(source, 'payload.bin');
  const destinationFile = path.join(destination, 'payload.bin');
  fs.writeFileSync(sourceFile, payload);

  const readBytes = new Map();
  const fsPromises = Object.create(fs.promises);
  fsPromises.open = async (filePath, ...args) => {
    const resolved = path.resolve(filePath);
    const handle = await fs.promises.open(filePath, ...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'read') {
          return async (...readArgs) => {
            const result = await target.read(...readArgs);
            if (result.bytesRead > 0) {
              readBytes.set(resolved, (readBytes.get(resolved) || 0) + result.bytesRead);
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };

  await copyServerDirectoryContents(source, destination, {
    fsApi: fs,
    fsPromises,
    durableFs: asyncDirectoryDurability(),
    reparseInspector: { async isReparsePoint() { return false; } }
  });

  assert.equal(readBytes.get(path.resolve(sourceFile)), payload.length * 3);
  assert.equal(readBytes.get(path.resolve(destinationFile)), payload.length);
  assert.deepEqual(fs.readFileSync(destinationFile), payload);
});

test('candidate structure scan proves entry types and reparse safety without opening file content', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-structure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested');
  const rejected = path.join(nested, 'rejected.txt');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(root, 'server.jar'), 'server');
  fs.writeFileSync(rejected, 'unsafe');

  const checked = [];
  const fsPromises = Object.create(fs.promises);
  fsPromises.open = async () => { throw new Error('the metadata-only scan must not open file content'); };
  const safe = await inspectServerDirectoryStructure(root, {
    fsApi: fs,
    fsPromises,
    reparseInspector: {
      async isReparsePoint(candidate) {
        checked.push(path.resolve(candidate));
        return false;
      }
    }
  });

  assert.match(safe.directoryIdentity.volumeSerial, /^[a-f0-9]+$/u);
  assert.match(safe.directoryIdentity.fileId, /^[a-f0-9]+$/u);
  assert.equal(safe.entryCount, 3);
  assert.deepEqual(new Set(checked), new Set([
    path.resolve(root),
    path.resolve(nested),
    path.resolve(root, 'server.jar'),
    path.resolve(rejected)
  ]));

  await assert.rejects(
    inspectServerDirectoryStructure(root, {
      fsApi: fs,
      fsPromises,
      reparseInspector: {
        async isReparsePoint(candidate) { return path.resolve(candidate) === path.resolve(rejected); }
      }
    }),
    error => error?.code === 'UNSAFE_ARCHIVE_ENTRY'
  );
});

test('combined candidate inspection hashes and durably flushes each file in one open traversal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-inspect-flush-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(root, 'root.txt'), 'root');
  fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested');

  const opens = new Map();
  const synced = [];
  const fsPromises = Object.create(fs.promises);
  fsPromises.open = async (filePath, ...args) => {
    const handle = await fs.promises.open(filePath, ...args);
    const resolved = path.resolve(filePath);
    opens.set(resolved, (opens.get(resolved) || 0) + 1);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') {
          return async () => {
            synced.push(resolved);
            return target.sync();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };
  const flushBatches = [];
  const options = {
    fsApi: fs,
    fsPromises,
    durableFs: {
      async flushDirectoryAsync() { throw new Error('single-directory flush is not expected'); },
      async flushDirectoriesAsync(directoryPaths) {
        flushBatches.push(directoryPaths.map(directoryPath => path.resolve(directoryPath)));
      }
    },
    reparseInspector: { async isReparsePoint() { return false; } }
  };

  const durableInspection = await inspectAndFlushServerDirectoryTree(root, options);
  const ordinaryInspection = await inspectServerDirectoryTree(root, {
    fsApi: fs,
    reparseInspector: options.reparseInspector
  });

  assert.equal(durableInspection.fingerprint, ordinaryInspection.fingerprint);
  assert.deepEqual(synced.sort(), [
    path.resolve(root, 'root.txt'),
    path.resolve(nested, 'nested.txt')
  ].sort());
  assert.equal(opens.get(path.resolve(root, 'root.txt')), 1);
  assert.equal(opens.get(path.resolve(nested, 'nested.txt')), 1);
  assert.deepEqual(flushBatches, [[path.resolve(nested), path.resolve(root)]]);
});

test('candidate durability prefers the asynchronous native directory batch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-async-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'server.jar'), 'server');
  const batches = [];

  await inspectAndFlushServerDirectoryTree(root, {
    fsApi: fs,
    durableFs: {
      flushDirectory() { throw new Error('single-directory flush is not expected'); },
      flushDirectories() { throw new Error('synchronous batch must not run'); },
      async flushDirectoriesAsync(directoryPaths) {
        batches.push(directoryPaths.map(directoryPath => path.resolve(directoryPath)));
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    reparseInspector: { async isReparsePoint() { return false; } }
  });

  assert.deepEqual(batches, [[path.resolve(nested), path.resolve(root)]]);
});

test('whole-tree hashing and copying yield control at bounded byte intervals', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-yield-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, 'large.bin'), Buffer.alloc((20 * 1024 * 1024) + 17, 0x5a));
  let yields = 0;
  const options = {
    fsApi: fs,
    durableFs: asyncDirectoryDurability(),
    reparseInspector: { async isReparsePoint() { return false; } },
    async yieldControl() {
      yields += 1;
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  const inspected = await inspectServerDirectoryTree(source, options);
  const afterInspectionYields = yields;
  assert.equal(inspected.totalBytes, String((20 * 1024 * 1024) + 17));
  assert.ok(afterInspectionYields >= 2);

  const copied = await copyServerDirectoryContents(source, destination, options);
  assert.equal(copied.copiedFiles, 1);
  assert.ok(yields >= afterInspectionYields + 6);
  assert.deepEqual(
    fs.readFileSync(path.join(destination, 'large.bin')),
    fs.readFileSync(path.join(source, 'large.bin'))
  );
});

test('whole-tree hashing observes cancellation at a cooperative yield boundary', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-yield-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(20 * 1024 * 1024, 0x33));
  const controller = new AbortController();

  await assert.rejects(
    inspectServerDirectoryTree(root, {
      fsApi: fs,
      reparseInspector: { async isReparsePoint() { return false; } },
      signal: controller.signal,
      async yieldControl() {
        controller.abort();
        await new Promise(resolve => setImmediate(resolve));
      }
    }),
    error => error.code === 'CANCELLED'
  );
});

test('whole-tree hashing rejects same-size pathname substitution during a cooperative yield', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-yield-substitution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = path.join(root, 'server');
  const livePath = path.join(server, 'large.bin');
  const displacedPath = path.join(root, 'displaced.bin');
  fs.mkdirSync(server);
  fs.writeFileSync(livePath, Buffer.alloc(20 * 1024 * 1024, 0x41));
  let substituted = false;

  await assert.rejects(
    inspectServerDirectoryTree(server, {
      fsApi: fs,
      reparseInspector: { async isReparsePoint() { return false; } },
      async yieldControl() {
        if (!substituted) {
          fs.renameSync(livePath, displacedPath);
          fs.writeFileSync(livePath, Buffer.alloc(20 * 1024 * 1024, 0x42));
          substituted = true;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    }),
    error => error.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(substituted, true);
});

test('whole-tree hashing rejects directory membership injected during a cooperative yield', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-yield-membership-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(20 * 1024 * 1024, 0x41));
  let injected = false;

  await assert.rejects(
    inspectServerDirectoryTree(root, {
      fsApi: fs,
      reparseInspector: { async isReparsePoint() { return false; } },
      async yieldControl() {
        if (!injected) {
          fs.writeFileSync(path.join(root, 'injected.jar'), 'injected');
          injected = true;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    }),
    error => error.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(injected, true);
});

test('candidate copy rejects destination pathname substitution during a cooperative yield', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-copy-yield-substitution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const destinationFile = path.join(destination, 'large.bin');
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, 'large.bin'), Buffer.alloc(20 * 1024 * 1024, 0x41));
  let substituted = false;

  await assert.rejects(
    copyServerDirectoryContents(source, destination, {
      fsApi: fs,
      durableFs: asyncDirectoryDurability(),
      reparseInspector: { async isReparsePoint() { return false; } },
      async yieldControl() {
        if (!substituted && fs.existsSync(destinationFile)) {
          fs.renameSync(destinationFile, path.join(root, 'displaced-copy.bin'));
          fs.writeFileSync(destinationFile, Buffer.alloc(20 * 1024 * 1024, 0x42));
          substituted = true;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    }),
    error => error.code === 'RECOVERY_REQUIRED'
  );
  assert.equal(substituted, true);
});

test('candidate copy authorizes one immutable exact source snapshot before writing any destination entry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-copy-authorize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(path.join(source, 'Nested'), { recursive: true });
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, 'root.txt'), 'root');
  fs.writeFileSync(path.join(source, 'Nested', 'payload.bin'), 'payload');

  let authorization = null;
  let authorized = false;
  const destinationRoot = `${path.resolve(destination)}${path.sep}`;
  const fsPromises = Object.create(fs.promises);
  fsPromises.mkdir = async (candidate, ...args) => {
    if (path.resolve(candidate).startsWith(destinationRoot)) {
      assert.equal(authorized, true, 'destination directory was created before source authorization');
    }
    return fs.promises.mkdir(candidate, ...args);
  };
  fsPromises.open = async (candidate, ...args) => {
    if (path.resolve(candidate).startsWith(destinationRoot)) {
      assert.equal(authorized, true, 'destination file was opened before source authorization');
    }
    return fs.promises.open(candidate, ...args);
  };

  await copyServerDirectoryContents(source, destination, {
    fsApi: fs,
    fsPromises,
    durableFs: asyncDirectoryDurability(),
    reparseInspector: { async isReparsePoint() { return false; } },
    async authorizeSourceSnapshot(value) {
      assert.deepEqual(fs.readdirSync(destination), []);
      await new Promise(resolve => setImmediate(resolve));
      authorization = value;
      authorized = true;
    }
  });

  assert.equal(authorized, true);
  assert.equal(Object.isFrozen(authorization), true);
  assert.equal(Object.isFrozen(authorization.entries), true);
  assert.equal(Object.isFrozen(authorization.directoryIdentity), true);
  assert.deepEqual(authorization.entries.map(entry => entry.pathKey), [
    'nested',
    'nested/payload.bin',
    'root.txt'
  ]);
  const directory = authorization.entries[0];
  assert.deepEqual({
    path: directory.path,
    pathKey: directory.pathKey,
    sha256: directory.sha256,
    size: directory.size,
    type: directory.type
  }, {
    path: 'Nested',
    pathKey: 'nested',
    sha256: null,
    size: '0',
    type: 'directory'
  });
  for (const entry of authorization.entries) {
    assert.equal(Object.isFrozen(entry), true);
    assert.match(entry.dev, /^(0|[1-9][0-9]*)$/u);
    assert.match(entry.ino, /^(0|[1-9][0-9]*)$/u);
    assert.match(entry.birthtime, /^-?(0|[1-9][0-9]*)$/u);
    if (entry.type === 'file') {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
      assert.match(entry.size, /^(0|[1-9][0-9]*)$/u);
    }
  }
  assert.equal(authorization.totalBytes, String(Buffer.byteLength('root') + Buffer.byteLength('payload')));
  assert.match(authorization.fingerprint, /^[a-f0-9]{64}$/u);
});

test('candidate copy fails closed when exact source content changes after authorization', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-copy-authorize-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  const sourceFile = path.join(source, 'payload.bin');
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  fs.writeFileSync(sourceFile, 'reviewed bytes');

  await assert.rejects(
    copyServerDirectoryContents(source, destination, {
      fsApi: fs,
      durableFs: asyncDirectoryDurability(),
      reparseInspector: { async isReparsePoint() { return false; } },
      async authorizeSourceSnapshot(snapshot) {
        assert.equal(snapshot.entries[0].sha256,
          require('node:crypto').createHash('sha256').update('reviewed bytes').digest('hex'));
        fs.writeFileSync(sourceFile, 'changed after authorization');
      }
    }),
    error => error?.code === 'RECOVERY_REQUIRED'
  );
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('a captured copy source can be authorized before destination creation and reused without another baseline scan', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-directory-copy-captured-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'payload.bin'), 'captured');

  const exactSourceSnapshot = await captureServerDirectoryCopySource(source, {
    fsApi: fs,
    reparseInspector: { async isReparsePoint() { return false; } }
  });
  assert.equal(Object.isFrozen(exactSourceSnapshot), true);
  assert.equal(fs.existsSync(destination), false);
  fs.mkdirSync(destination);

  const result = await copyServerDirectoryContents(source, destination, {
    fsApi: fs,
    durableFs: asyncDirectoryDurability(),
    expectedSourceSnapshot: exactSourceSnapshot,
    reparseInspector: { async isReparsePoint() { return false; } }
  });

  assert.equal(result.sourceFingerprint, exactSourceSnapshot.fingerprint);
  assert.equal(fs.readFileSync(path.join(destination, 'payload.bin'), 'utf8'), 'captured');
});

test('candidate copy maps destination capacity exhaustion to a stale available-bytes plan', async t => {
  for (const failureCode of ['ENOSPC', 'EDQUOT']) {
    await t.test(failureCode, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-core-directory-copy-${failureCode.toLowerCase()}-`));
      try {
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        const destinationFile = path.join(destination, 'payload.bin');
        fs.mkdirSync(source);
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(source, 'payload.bin'), 'payload');
        const fsPromises = Object.create(fs.promises);
        fsPromises.open = async (candidate, ...args) => {
          const handle = await fs.promises.open(candidate, ...args);
          if (path.resolve(candidate) !== path.resolve(destinationFile)) return handle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'write') {
                return async () => {
                  const failure = new Error('private operating-system capacity text');
                  failure.code = failureCode;
                  throw failure;
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });
        };

        await assert.rejects(
          copyServerDirectoryContents(source, destination, {
            fsApi: fs,
            fsPromises,
            durableFs: asyncDirectoryDurability(),
            reparseInspector: { async isReparsePoint() { return false; } }
          }),
          error => {
            assert.equal(error?.code, 'PLAN_STALE');
            assert.equal(error?.safeMessage, 'Available disk capacity changed after review');
            assert.equal(error?.details?.field, 'availableBytes');
            assert.equal(error?.cause?.code, failureCode);
            return true;
          }
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
