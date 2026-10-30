const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  configureDurableFs,
  createDeferredDirectoryFlushes,
  createDurableFs,
  durableTempTargetName,
  isDurableTempLeftover,
  renameDurable: renameWithConfiguredDurableFs
} = require('../electron/utils/durable-fs.cjs');
const { encodeFrame } = require('../electron/services/modpacks/archive/archive-worker-client.cjs');
const { ModpackError } = require('../electron/services/modpacks/errors.cjs');
const { WindowsDurableFsClient } = require('../electron/utils/windows-durable-fs-client.cjs');

function fixture(t, { capabilities, failAt = null, shortWrites = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-fs-'));
  const calls = [];
  let tempSequence = 0;
  let wrote = false;
  const tempDescriptors = new Set();
  const fsApi = {
    ...fs,
    openSync(...args) {
      const descriptor = fs.openSync(...args);
      if (args[1] === 'wx') {
        tempDescriptors.add(descriptor);
        calls.push({ kind: 'open-temp', mode: args[2] });
      }
      return descriptor;
    },
    writeSync(fd, buffer, offset, length, position) {
      if (!wrote) {
        calls.push({ kind: 'write' });
        wrote = true;
      }
      if (failAt === 'write') throw new Error('injected write failure');
      const count = shortWrites ? Math.max(1, Math.floor(length / 2)) : length;
      return fs.writeSync(fd, buffer, offset, count, position);
    },
    fsyncSync(fd) {
      calls.push({ kind: 'flush-file' });
      if (failAt === 'flush-file') throw new Error('injected file flush failure');
      return fs.fsyncSync(fd);
    },
    closeSync(fd) {
      if (tempDescriptors.delete(fd)) calls.push({ kind: 'close-file' });
      return fs.closeSync(fd);
    }
  };
  const durableClient = {
    ...(capabilities === undefined ? {} : { capabilities }),
    moveWriteThrough(sourcePath, destinationPath) {
      calls.push({ kind: 'move-write-through' });
      if (failAt === 'move-write-through') throw new Error('injected move failure');
      fs.renameSync(sourcePath, destinationPath);
    },
    replaceFileWriteThrough(sourcePath, destinationPath) {
      calls.push({ kind: 'replace-file-write-through' });
      if (failAt === 'replace-file-write-through') throw new Error('injected replace failure');
      fs.renameSync(sourcePath, destinationPath);
    },
    flushDirectory(directoryPath) {
      calls.push({ kind: 'flush-directory', directoryPath });
      if (failAt === 'flush-directory') throw new Error('injected directory flush failure');
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient,
    allowedRoots: [root],
    tempNameFactory: () => `test-${++tempSequence}`
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, calls, durableFs };
}

function tempEntries(root) {
  return fs.readdirSync(root).filter(name => name.includes('.minecraft-core-tmp-'));
}

test('exact delete requires original identities and strict capability', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `exact-delete-${crypto.randomUUID()}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const leaf = path.join(root, 'leaf'); fs.writeFileSync(leaf, 'keep');
  let calls = 0;
  const client = { moveWriteThrough() {}, replaceFileWriteThrough() {}, flushDirectory() {},
    async deleteFileExactAsync() { calls++; return { deleted: true, durable: true }; } };
  const identity = (candidate, fileType) => {
    const stat = fs.lstatSync(candidate, { bigint: true });
    return { fileType, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
      birthtime: String(stat.birthtimeNs), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      ...(fileType === 'file' ? { sha256: crypto.createHash('sha256').update('keep').digest('hex') } : {}) };
  };
  const options = { expectedFileIdentity: identity(leaf, 'file'), expectedParentIdentity: identity(root, 'directory'),
    expectedAllowedRootIdentities: [{ path: root, identity: identity(root, 'directory') }], expectedAncestorIdentities: [], mode: 'delete' };
  for (const capabilities of [undefined, { deleteFileExactFlushesParent: true },
    Object.freeze(Object.create({ deleteFileExactFlushesParent: true }))]) {
    const service = createDurableFs({ durableClient: { ...client, capabilities }, allowedRoots: [root] });
    await assert.rejects(service.deleteFileExactAsync(leaf, options), { code: 'COMMIT_FAILED', durableEffectState: 'none' });
  }
  const service = configureDurableFs({ durableClient: { ...client, capabilities: Object.freeze({ deleteFileExactFlushesParent: true }) },
    allowedRoots: [root], fsApi: { ...fs, unlinkSync() { throw Error('forbidden fallback'); }, rmSync() { throw Error('forbidden fallback'); } } });
  for (const key of Object.keys(options)) {
    const invalid = { ...options }; delete invalid[key];
    await assert.rejects(service.deleteFileExactAsync(leaf, invalid), { code: 'COMMIT_FAILED' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await require('../electron/utils/durable-fs.cjs').deleteFileExactAsync(leaf, options), { deleted: true, durable: true });
  assert.equal(calls, 1); assert.equal(fs.readFileSync(leaf, 'utf8'), 'keep');
});

function uncertainMoveFixture(t, {
  sourceType = 'directory',
  moveMode = 'rename',
  sameParent = false,
  includeBatchFlush = true,
  includeNativeReconcile = false,
  afterMove = () => {},
  onReconcile = () => {},
  onFlush = () => {}
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-uncertain-move-'));
  const sourceParent = path.join(root, 'source-parent');
  const destinationParent = sameParent ? sourceParent : path.join(root, 'destination-parent');
  const source = path.join(sourceParent, 'candidate');
  const destination = path.join(destinationParent, 'published');
  const sourceBytes = 'validated file bytes';
  fs.mkdirSync(sourceParent);
  if (!sameParent) fs.mkdirSync(destinationParent);
  if (sourceType === 'file') {
    fs.writeFileSync(source, sourceBytes);
  } else {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'identity.txt'), 'validated directory');
  }
  const calls = [];
  const durableClient = {
    capabilities: Object.freeze({
      moveWriteThroughFlushesParents: true,
      ...(includeNativeReconcile ? { reconcileMoveWriteThrough: true } : {})
    }),
    moveWriteThrough(from, to) {
      calls.push({ kind: 'move', from, to });
      if (moveMode === 'copy') fs.cpSync(from, to, { recursive: sourceType === 'directory' });
      else fs.renameSync(from, to);
      afterMove({ root, sourceParent, destinationParent, source, destination, sourceBytes });
      throw new Error('injected uncertain native move');
    },
    replaceFileWriteThrough() {
      throw new Error('replacement is not expected');
    },
    flushDirectory(directoryPath, expectations) {
      calls.push({ kind: 'flush', directoryPath, expectations });
      return onFlush(directoryPath, expectations);
    }
  };
  if (includeBatchFlush) {
    durableClient.flushDirectories = (directoryPaths, expectations) => {
      calls.push({ kind: 'flush-batch', directoryPaths, expectations });
      for (let index = 0; index < directoryPaths.length; index += 1) {
        onFlush(directoryPaths[index], { directoryIdentity: expectations.directoryIdentities[index] });
      }
    };
  }
  if (includeNativeReconcile) {
    durableClient.reconcileMoveWriteThrough = (from, to, expectations) => {
      calls.push({ kind: 'reconcile', from, to, expectations });
      return onReconcile(from, to, expectations);
    };
  }
  const durableFs = createDurableFs({ fsApi: fs, durableClient, allowedRoots: [root] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, sourceParent, destinationParent, source, destination, sourceBytes, calls, durableFs };
}

test('atomic JSON publication flushes data before write-through rename', (t) => {
  const { root, calls, durableFs } = fixture(t);
  const target = path.join(root, 'state.json');

  durableFs.writeJsonAtomic(target, { contentRevision: 1 });

  assert.deepEqual(calls.map(call => call.kind), [
    'open-temp',
    'write',
    'flush-file',
    'close-file',
    'move-write-through',
    'flush-directory'
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { contentRevision: 1 });
  assert.deepEqual(tempEntries(root), []);
});

test('existing files use atomic write-through replacement', (t) => {
  const { root, calls, durableFs } = fixture(t);
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, '{"old":true}');

  durableFs.writeJsonAtomic(target, { old: false });

  assert.deepEqual(calls.map(call => call.kind), [
    'open-temp',
    'write',
    'flush-file',
    'close-file',
    'replace-file-write-through',
    'flush-directory'
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { old: false });
});

test('existing atomic replacement accepts ctime-only destination drift and sends its digest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-atomic-ctime-'));
  const target = path.join(root, 'state.bin');
  fs.writeFileSync(target, 'old bytes');
  const targetKey = path.resolve(target).toLocaleLowerCase('en-US');
  const expectedSha256 = crypto.createHash('sha256').update('old bytes').digest('hex');
  let ctimeOffset = 0n;
  const targetDescriptors = new Set();

  function withCtimeDrift(stat) {
    ctimeOffset += 1n;
    const ctimeKey = stat.ctimeNs === undefined ? 'ctimeMs' : 'ctimeNs';
    const value = stat[ctimeKey];
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      [ctimeKey]: typeof value === 'bigint' ? value + ctimeOffset : value + Number(ctimeOffset)
    });
  }

  const fsApi = {
    ...fs,
    openSync(candidate, flags, mode) {
      const descriptor = fs.openSync(candidate, flags, mode);
      if (path.resolve(candidate).toLocaleLowerCase('en-US') === targetKey) targetDescriptors.add(descriptor);
      return descriptor;
    },
    closeSync(descriptor) {
      targetDescriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
    lstatSync(candidate, options) {
      const stat = fs.lstatSync(candidate, options);
      return path.resolve(candidate).toLocaleLowerCase('en-US') === targetKey && options?.bigint === true
        ? withCtimeDrift(stat)
        : stat;
    },
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      return options?.bigint === true && targetDescriptors.has(descriptor)
        ? withCtimeDrift(stat)
        : stat;
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough() { throw new Error('move is not expected'); },
      replaceFileWriteThrough(source, destination, expectations) {
        assert.equal(expectations.destinationIdentity.sha256, expectedSha256);
        assert.equal(typeof expectations.destinationIdentity.ctime, 'string');
        fs.renameSync(source, destination);
      },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => 'ctime-drift'
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  durableFs.writeFileAtomic(target, 'new bytes');

  assert.equal(fs.readFileSync(target, 'utf8'), 'new bytes');
});

test('existing atomic replacement rejects same-size destination substitution after digest capture', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-atomic-target-race-'));
  const target = path.join(root, 'state.bin');
  fs.writeFileSync(target, 'safe');
  const targetKey = path.resolve(target).toLocaleLowerCase('en-US');
  const original = fs.lstatSync(target, { bigint: true });
  const targetDescriptors = new Set();
  const tempDescriptors = new Set();
  let substituted = false;
  let replaceCalls = 0;

  function withStableTargetMetadata(stat) {
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      dev: original.dev,
      ino: original.ino,
      size: original.size,
      birthtimeNs: original.birthtimeNs,
      mtimeNs: original.mtimeNs,
      ctimeNs: original.ctimeNs + 1n
    });
  }

  const fsApi = {
    ...fs,
    openSync(candidate, flags, mode) {
      const descriptor = fs.openSync(candidate, flags, mode);
      if (path.resolve(candidate).toLocaleLowerCase('en-US') === targetKey) targetDescriptors.add(descriptor);
      if (flags === 'wx') tempDescriptors.add(descriptor);
      return descriptor;
    },
    closeSync(descriptor) {
      const isTarget = targetDescriptors.delete(descriptor);
      const isTemp = tempDescriptors.delete(descriptor);
      const result = fs.closeSync(descriptor);
      if (!isTarget && isTemp && !substituted) {
        substituted = true;
        fs.writeFileSync(target, 'evil');
      }
      return result;
    },
    lstatSync(candidate, options) {
      const stat = fs.lstatSync(candidate, options);
      return path.resolve(candidate).toLocaleLowerCase('en-US') === targetKey && options?.bigint === true
        ? withStableTargetMetadata(stat)
        : stat;
    },
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      return targetDescriptors.has(descriptor) && options?.bigint === true
        ? withStableTargetMetadata(stat)
        : stat;
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough() { throw new Error('move is not expected'); },
      replaceFileWriteThrough(source, destination) {
        replaceCalls += 1;
        fs.renameSync(source, destination);
      },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => 'target-race'
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.writeFileAtomic(target, 'next'),
    error => error.code === 'PLAN_STALE' && error.commitPhase === 'pre-publication'
  );
  assert.equal(replaceCalls, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'evil');
});

test('atomic replacement trusts only a frozen native parent-flush capability', (t) => {
  for (const [name, capabilities, expectedFlushes] of [
    ['native-capability', Object.freeze({ moveWriteThroughFlushesParents: true }), 0],
    ['mutable-claim', { moveWriteThroughFlushesParents: true }, 1],
    ['no-claim', undefined, 1]
  ]) {
    const { root, calls, durableFs } = fixture(t, { capabilities });
    const target = path.join(root, `${name}.json`);
    fs.writeFileSync(target, '{"old":true}\n');

    durableFs.writeJsonAtomic(target, { old: false });

    assert.equal(fs.readFileSync(target, 'utf8'), '{\n  "old": false\n}\n', name);
    assert.equal(calls.filter(call => call.kind === 'flush-directory').length, expectedFlushes, name);
  }
});

test('an exact atomic replacement is reconciled when native completion reports failure after publication', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-atomic-reconcile-'));
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, '{"old":true}\n');
  const calls = [];
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      capabilities: Object.freeze({
        moveWriteThroughFlushesParents: true,
        reconcileMoveWriteThrough: true
      }),
      moveWriteThrough() { throw new Error('new-file move is not expected'); },
      replaceFileWriteThrough(source, destination) {
        calls.push('replace');
        fs.renameSync(source, destination);
        throw new Error('injected post-publication completion failure');
      },
      reconcileMoveWriteThrough(source, destination) {
        calls.push('reconcile');
        assert.equal(fs.existsSync(source), false);
        assert.equal(fs.existsSync(destination), true);
      },
      flushDirectory() { calls.push('flush-directory'); }
    },
    allowedRoots: [root],
    tempNameFactory: () => 'atomic-reconcile'
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  durableFs.writeJsonAtomic(target, { old: false });

  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { old: false });
  assert.deepEqual(tempEntries(root), []);
  assert.deepEqual(calls, ['replace', 'reconcile']);
});

test('atomic replacement reconciliation rejects changed published bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-atomic-reconcile-race-'));
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, '{"old":true}\n');
  let reconcileCalls = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      capabilities: Object.freeze({
        moveWriteThroughFlushesParents: true,
        reconcileMoveWriteThrough: true
      }),
      moveWriteThrough() { throw new Error('new-file move is not expected'); },
      replaceFileWriteThrough(source, destination) {
        fs.renameSync(source, destination);
        fs.writeFileSync(destination, '{"evil":true}');
        throw new Error('injected substituted publication');
      },
      reconcileMoveWriteThrough() { reconcileCalls += 1; },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => 'atomic-reconcile-race'
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.writeJsonAtomic(target, { old: false }),
    error => error.code === 'PLAN_STALE' && error.commitPhase === 'post-publication-uncertain'
  );
  assert.equal(reconcileCalls, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { evil: true });
});

test('existing replacement accepts the destination birthtime retained by native publication', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-name-tunneling-'));
  const target = path.join(root, 'state.bin');
  fs.writeFileSync(target, 'old bytes');
  const targetKey = path.resolve(target).toLocaleLowerCase('en-US');
  const originalTarget = fs.lstatSync(target, { bigint: true });
  const retainedBirthtimeNs = originalTarget.birthtimeNs - 86_400_000_000_000n;
  const targetDescriptors = new Set();
  let published = false;

  function withRetainedBirthtime(stat) {
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      birthtimeNs: retainedBirthtimeNs
    });
  }

  const fsApi = {
    ...fs,
    openSync(candidate, flags, mode) {
      const descriptor = fs.openSync(candidate, flags, mode);
      if (path.resolve(candidate).toLocaleLowerCase('en-US') === targetKey) targetDescriptors.add(descriptor);
      return descriptor;
    },
    closeSync(descriptor) {
      targetDescriptors.delete(descriptor);
      return fs.closeSync(descriptor);
    },
    lstatSync(candidate, options) {
      const stat = fs.lstatSync(candidate, options);
      return path.resolve(candidate).toLocaleLowerCase('en-US') === targetKey && options?.bigint === true
        ? withRetainedBirthtime(stat)
        : stat;
    },
    fstatSync(descriptor, options) {
      const stat = fs.fstatSync(descriptor, options);
      return (published || targetDescriptors.has(descriptor)) && options?.bigint === true
        ? withRetainedBirthtime(stat)
        : stat;
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough() { throw new Error('move is not expected'); },
      replaceFileWriteThrough(source, destination) {
        fs.renameSync(source, destination);
        published = true;
      },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => 'name-tunneling'
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  durableFs.writeFileAtomic(target, 'complete bytes');

  assert.equal(fs.readFileSync(target, 'utf8'), 'complete bytes');
  assert.deepEqual(tempEntries(root), []);
});

test('short writes are completed before the file is flushed', (t) => {
  const { root, durableFs } = fixture(t, { shortWrites: true });
  const target = path.join(root, 'large.txt');
  const content = '0123456789'.repeat(1024);

  durableFs.writeFileAtomic(target, content);

  assert.equal(fs.readFileSync(target, 'utf8'), content);
});

test('atomic writes snapshot caller-owned binary input before opening the temp file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-input-snapshot-'));
  const input = Buffer.from('stable-input');
  let mutated = false;
  const fsApi = {
    ...fs,
    openSync(...args) {
      const descriptor = fs.openSync(...args);
      if (args[1] === 'wx' && !mutated) {
        mutated = true;
        input.fill(0x78);
      }
      return descriptor;
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  durableFs.writeFileAtomic(path.join(root, 'snapshot.bin'), input);
  assert.equal(fs.readFileSync(path.join(root, 'snapshot.bin'), 'utf8'), 'stable-input');
  assert.equal(input.equals(Buffer.from('stable-input')), false);
});

test('a pre-publication failure preserves the old file and removes the unique temp', (t) => {
  const { root, durableFs } = fixture(t, { failAt: 'flush-file' });
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, '{"stable":true}');

  assert.throws(() => durableFs.writeJsonAtomic(target, { stable: false }), error => error.code === 'COMMIT_FAILED');

  assert.equal(fs.readFileSync(target, 'utf8'), '{"stable":true}');
  assert.deepEqual(tempEntries(root), []);
});

test('an unacknowledged move failure is classified uncertain and preserves its recovery temp', (t) => {
  const { root, durableFs } = fixture(t, { failAt: 'move-write-through' });
  const target = path.join(root, 'state.json');

  assert.throws(
    () => durableFs.writeJsonAtomic(target, { stable: true }),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'post-publication-uncertain'
  );

  assert.equal(fs.existsSync(target), false);
  assert.equal(tempEntries(root).length, 1);
});

test('a native failure before handle publication stays pre-publication and removes its temp', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-native-prepublish-'));
  const target = path.join(root, 'state.json');
  fs.writeFileSync(target, '{"stable":true}');
  const failure = new ModpackError('COMMIT_FAILED', 'Durable filesystem operation failed');
  Object.defineProperties(failure, {
    durableFailureKind: { value: 'integrity-failure', enumerable: true },
    durableFailureStage: { value: 'destination-parent-open', enumerable: true }
  });
  const durableFs = createDurableFs({
    fsApi: fs,
    allowedRoots: [root],
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough() { throw failure; },
      flushDirectory() {}
    }
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.writeJsonAtomic(target, { stable: false }),
    error => error === failure && error.commitPhase === 'pre-publication'
  );
  assert.equal(fs.readFileSync(target, 'utf8'), '{"stable":true}');
  assert.deepEqual(tempEntries(root), []);
});

test('atomic publication rejects a same-size temp replacement after flush and close', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-temp-race-'));
  const target = path.join(root, 'state.bin');
  let tempPath = null;
  let tempClosed = false;
  let swapped = false;
  let moveCalls = 0;
  const fsApi = {
    ...fs,
    openSync(filePath, flags, mode) {
      if (flags === 'wx') tempPath = filePath;
      return fs.openSync(filePath, flags, mode);
    },
    closeSync(descriptor) {
      const result = fs.closeSync(descriptor);
      if (tempPath) tempClosed = true;
      return result;
    },
    lstatSync(candidate, options) {
      if (tempClosed && !swapped && path.resolve(candidate) === path.resolve(root)) {
        swapped = true;
        const original = `${tempPath}.original`;
        fs.renameSync(tempPath, original);
        fs.writeFileSync(tempPath, 'evil');
      }
      return fs.lstatSync(candidate, options);
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough(source, destination) {
        moveCalls += 1;
        fs.renameSync(source, destination);
      },
      replaceFileWriteThrough() { throw new Error('replacement is not expected'); },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => 'temp-race'
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.writeFileAtomic(target, 'safe'),
    error => error.code === 'PLAN_STALE' && error.commitPhase === 'pre-publication'
  );
  assert.equal(moveCalls, 0);
  assert.equal(fs.existsSync(target), false);
});

test('atomic publication verifies the published object still matches the flushed temp', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-published-race-'));
  const target = path.join(root, 'state.bin');
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough(source, destination) {
        fs.renameSync(source, destination);
        fs.writeFileSync(destination, 'evil');
      },
      replaceFileWriteThrough() { throw new Error('replacement is not expected'); },
      flushDirectory() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => 'published-race'
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.writeFileAtomic(target, 'safe'),
    error => error.code === 'PLAN_STALE' && error.commitPhase === 'post-publication'
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'evil');
});

test('non-JSON values fail before a temp file is opened', (t) => {
  const { root, calls, durableFs } = fixture(t);
  const target = path.join(root, 'state.json');
  const cyclic = {};
  cyclic.self = cyclic;

  assert.throws(() => durableFs.writeJsonAtomic(target, undefined), error => error.code === 'COMMIT_FAILED');
  assert.throws(() => durableFs.writeJsonAtomic(target, cyclic), error => error.code === 'COMMIT_FAILED');
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('durable rename flushes both changed parents exactly once', (t) => {
  const { root, calls, durableFs } = fixture(t);
  const sourceParent = path.join(root, 'source');
  const destinationParent = path.join(root, 'destination');
  fs.mkdirSync(sourceParent);
  fs.mkdirSync(destinationParent);
  const source = path.join(sourceParent, 'candidate');
  const destination = path.join(destinationParent, 'published');
  fs.mkdirSync(source);

  durableFs.renameDurable(source, destination);

  assert.equal(fs.existsSync(destination), true);
  assert.deepEqual(calls.map(call => call.kind), [
    'move-write-through',
    'flush-directory',
    'flush-directory'
  ]);
  assert.deepEqual(calls.slice(1).map(call => call.directoryPath), [sourceParent, destinationParent]);
});

test('durable rename reconciles a completed uncertain directory move and explicitly flushes both current parents', (t) => {
  const { sourceParent, destinationParent, source, destination, calls, durableFs } = uncertainMoveFixture(t);

  const published = durableFs.renameDurable(source, destination);

  assert.equal(published, destination);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(destination, 'identity.txt'), 'utf8'), 'validated directory');
  assert.deepEqual(calls.map(call => call.kind), ['move', 'flush-batch']);
  assert.deepEqual(calls[1].directoryPaths, [sourceParent, destinationParent]);
  for (const [index, directoryPath] of calls[1].directoryPaths.entries()) {
    const current = fs.lstatSync(directoryPath, { bigint: true });
    assert.equal(calls[1].expectations.directoryIdentities[index].dev, String(current.dev));
    assert.equal(calls[1].expectations.directoryIdentities[index].ino, String(current.ino));
    assert.equal(calls[1].expectations.directoryIdentities[index].birthtime, String(current.birthtimeNs));
  }
});

test('durable rename prefers native handle-pinned uncertain-move reconciliation when available', (t) => {
  const { sourceParent, destinationParent, source, destination, calls, durableFs } = uncertainMoveFixture(t, {
    sourceType: 'file',
    includeNativeReconcile: true
  });

  const published = durableFs.renameDurable(source, destination);

  assert.equal(published, destination);
  assert.deepEqual(calls.map(call => call.kind), ['move', 'reconcile']);
  assert.equal(calls[1].from, source);
  assert.equal(calls[1].to, destination);
  assert.equal(calls[1].expectations.sourceIdentity.sha256.length, 64);
  assert.equal(calls[1].expectations.sourceParentIdentity.dev, String(fs.lstatSync(sourceParent, { bigint: true }).dev));
  assert.equal(calls[1].expectations.destinationParentIdentity.dev, String(fs.lstatSync(destinationParent, { bigint: true }).dev));
});

test('durable rename precomputes the digest needed to reconcile an uncertain file move when the caller omitted it', (t) => {
  const { sourceParent, destinationParent, source, destination, sourceBytes, calls, durableFs } = uncertainMoveFixture(t, {
    sourceType: 'file'
  });

  const published = durableFs.renameDurable(source, destination);

  assert.equal(published, destination);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), sourceBytes);
  assert.deepEqual(calls.map(call => call.kind), ['move', 'flush-batch']);
  assert.deepEqual(calls[1].directoryPaths, [sourceParent, destinationParent]);
});

test('durable rename rejects an uncertain file move whose destination bytes changed in place', (t) => {
  const { source, destination, calls, durableFs } = uncertainMoveFixture(t, {
    sourceType: 'file',
    afterMove({ destination: published }) {
      fs.writeFileSync(published, 'substituted bytes');
    }
  });

  assert.throws(
    () => durableFs.renameDurable(source, destination),
    error => error.code === 'PLAN_STALE' && error.commitPhase === 'post-publication-uncertain'
  );
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'substituted bytes');
  assert.deepEqual(calls.map(call => call.kind), ['move']);
});

test('durable rename rejects an uncertain move when source and destination both exist', (t) => {
  const { source, destination, calls, durableFs } = uncertainMoveFixture(t, {
    sourceType: 'file',
    moveMode: 'copy'
  });

  assert.throws(
    () => durableFs.renameDurable(source, destination),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'post-publication-uncertain'
  );
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(destination), true);
  assert.deepEqual(calls.map(call => call.kind), ['move']);
});

test('durable rename rejects an uncertain move to a substituted destination object', (t) => {
  const { root, source, destination, sourceBytes, calls, durableFs } = uncertainMoveFixture(t, {
    sourceType: 'file',
    afterMove({ destination: published, sourceBytes: originalBytes }) {
      fs.renameSync(published, path.join(root, 'displaced-original'));
      fs.writeFileSync(published, originalBytes);
    }
  });

  assert.throws(
    () => durableFs.renameDurable(source, destination),
    error => error.code === 'PLAN_STALE' && error.commitPhase === 'post-publication-uncertain'
  );
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), sourceBytes);
  assert.deepEqual(calls.map(call => call.kind), ['move']);
});

test('durable rename rejects an uncertain completed move when a parent was substituted', (t) => {
  const { root, sourceParent, source, destination, calls, durableFs } = uncertainMoveFixture(t, {
    sourceType: 'file',
    afterMove({ sourceParent: publishedSourceParent }) {
      fs.renameSync(publishedSourceParent, path.join(root, 'displaced-source-parent'));
      fs.mkdirSync(publishedSourceParent);
    }
  });

  assert.throws(
    () => durableFs.renameDurable(source, destination),
    error => error.code === 'PLAN_STALE' && error.commitPhase === 'post-publication-uncertain'
  );
  assert.equal(fs.existsSync(sourceParent), true);
  assert.equal(fs.existsSync(destination), true);
  assert.deepEqual(calls.map(call => call.kind), ['move']);
});

test('durable rename flushes a shared source and destination parent once during uncertain reconciliation', (t) => {
  const { sourceParent, source, destination, calls, durableFs } = uncertainMoveFixture(t, {
    sourceType: 'file',
    sameParent: true
  });

  const published = durableFs.renameDurable(source, destination);

  assert.equal(published, destination);
  assert.deepEqual(calls.map(call => call.kind), ['move', 'flush-batch']);
  assert.deepEqual(calls[1].directoryPaths, [sourceParent]);
  assert.equal(calls[1].expectations.directoryIdentities.length, 1);
});

test('durable rename rejects destination substitution during the reconciliation flush', (t) => {
  let substituted = false;
  let fixtureState;
  fixtureState = uncertainMoveFixture(t, {
    sourceType: 'file',
    onFlush() {
      if (substituted) return;
      substituted = true;
      fs.renameSync(fixtureState.destination, path.join(fixtureState.root, 'displaced-after-flush'));
      fs.writeFileSync(fixtureState.destination, fixtureState.sourceBytes);
    }
  });

  assert.throws(
    () => fixtureState.durableFs.renameDurable(fixtureState.source, fixtureState.destination),
    error => error.code === 'PLAN_STALE' && error.commitPhase === 'post-publication-uncertain'
  );
  assert.equal(fs.existsSync(fixtureState.source), false);
  assert.equal(fs.readFileSync(fixtureState.destination, 'utf8'), fixtureState.sourceBytes);
  assert.deepEqual(fixtureState.calls.map(call => call.kind), ['move', 'flush-batch']);
});

test('durable rename fails closed when reconciliation cannot flush a changed parent', (t) => {
  const { source, destination, calls, durableFs } = uncertainMoveFixture(t, {
    sourceType: 'file',
    onFlush() {
      throw new Error('injected parent flush failure');
    }
  });

  assert.throws(
    () => durableFs.renameDurable(source, destination),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'post-publication-uncertain'
  );
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(destination), true);
  assert.deepEqual(calls.map(call => call.kind), ['move', 'flush-batch']);
});

test('durable rename keeps a legacy second-parent flush failure uncertain', (t) => {
  let destinationParent;
  const fixtureState = uncertainMoveFixture(t, {
    sourceType: 'file',
    includeBatchFlush: false,
    onFlush(directoryPath) {
      if (directoryPath === destinationParent) throw new Error('injected second parent flush failure');
    }
  });
  destinationParent = fixtureState.destinationParent;

  assert.throws(
    () => fixtureState.durableFs.renameDurable(fixtureState.source, fixtureState.destination),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'post-publication-uncertain'
  );
  assert.equal(fs.existsSync(fixtureState.source), false);
  assert.equal(fs.existsSync(fixtureState.destination), true);
  assert.deepEqual(fixtureState.calls.map(call => call.kind), ['move', 'flush', 'flush']);
  assert.deepEqual(fixtureState.calls.slice(1).map(call => call.directoryPath), [
    fixtureState.sourceParent,
    fixtureState.destinationParent
  ]);
});

test('durable rename trusts only a frozen native parent-flush capability', (t) => {
  for (const [name, capabilities, expectedFlushes] of [
    ['native-capability', Object.freeze({ moveWriteThroughFlushesParents: true }), 0],
    ['mutable-claim', { moveWriteThroughFlushesParents: true }, 2],
    ['no-claim', undefined, 2]
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-core-durable-${name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceParent = path.join(root, 'source');
    const destinationParent = path.join(root, 'destination');
    const source = path.join(sourceParent, 'candidate');
    const destination = path.join(destinationParent, 'published');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(destinationParent);
    const calls = [];
    const durableClient = {
      ...(capabilities === undefined ? {} : { capabilities }),
      moveWriteThrough(from, to) { calls.push('move'); fs.renameSync(from, to); },
      replaceFileWriteThrough() { throw new Error('replacement is not expected'); },
      flushDirectory() { calls.push('flush'); }
    };
    const durableFs = createDurableFs({ fsApi: fs, durableClient, allowedRoots: [root] });

    durableFs.renameDurable(source, destination);

    assert.equal(fs.existsSync(destination), true, name);
    assert.equal(calls.filter(call => call === 'flush').length, expectedFlushes, name);
  }
});

test('multiple directory flushes use one identity-bound batch client call', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first');
  const second = path.join(first, 'second');
  fs.mkdirSync(second, { recursive: true });
  const batchCalls = [];
  const singleCalls = [];
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough() { throw new Error('move is not expected'); },
      replaceFileWriteThrough() { throw new Error('replacement is not expected'); },
      flushDirectory(directoryPath) { singleCalls.push(directoryPath); },
      flushDirectories(directoryPaths, expectations) {
        batchCalls.push({ directoryPaths, expectations });
      }
    },
    allowedRoots: [root]
  });

  const flushed = durableFs.flushDirectories([second, first]);

  assert.deepEqual(flushed, [second, first]);
  assert.equal(Object.isFrozen(flushed), true);
  assert.equal(singleCalls.length, 0);
  assert.equal(batchCalls.length, 1);
  assert.deepEqual(batchCalls[0].directoryPaths, [second, first]);
  assert.deepEqual(Object.keys(batchCalls[0].expectations), ['directoryIdentities']);
  assert.equal(batchCalls[0].expectations.directoryIdentities.length, 2);
  assert.deepEqual(
    batchCalls[0].expectations.directoryIdentities.map(identity => [identity.dev, identity.ino, identity.birthtime]),
    [second, first].map(directoryPath => {
      const stat = fs.lstatSync(directoryPath, { bigint: true });
      return [String(stat.dev), String(stat.ino), String(stat.birthtimeNs)];
    })
  );
});

test('multiple directory flushes retain the legacy single-call fallback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-batch-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const calls = [];
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough() { throw new Error('move is not expected'); },
      replaceFileWriteThrough() { throw new Error('replacement is not expected'); },
      flushDirectory(directoryPath, expectations) { calls.push({ directoryPath, expectations }); }
    },
    allowedRoots: [root]
  });

  durableFs.flushDirectories([first, second]);

  assert.deepEqual(calls.map(call => call.directoryPath), [first, second]);
  assert.equal(calls.every(call => Object.keys(call.expectations).join(',') === 'directoryIdentity'), true);
});

test('durable rename binds a file publication to the caller-validated source digest', (t) => {
  const { root, calls, durableFs } = fixture(t);
  const source = path.join(root, 'active.json');
  const destination = path.join(root, 'history.json');
  fs.writeFileSync(source, 'validated bytes');
  const expectedSourceSha256 = crypto.createHash('sha256').update('validated bytes').digest('hex');
  fs.writeFileSync(source, 'substituted bytes');

  assert.throws(
    () => durableFs.renameDurable(source, destination, { expectedSourceSha256 }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(fs.readFileSync(source, 'utf8'), 'substituted bytes');
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(calls, []);
  let getterCalls = 0;
  const unsafeOptions = {};
  Object.defineProperty(unsafeOptions, 'expectedSourceSha256', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return expectedSourceSha256;
    }
  });
  assert.throws(() => durableFs.renameDurable(source, destination, unsafeOptions), error => error.code === 'COMMIT_FAILED');
  assert.throws(
    () => durableFs.renameDurable(source, destination, {
      expectedSourceSha256: {
        toString() {
          getterCalls += 1;
          return expectedSourceSha256;
        }
      }
    }),
    error => error.code === 'COMMIT_FAILED'
  );
  assert.equal(getterCalls, 0);
});

test('configured durable rename facade forwards caller-validated source digest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-configured-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'active.json');
  const destination = path.join(root, 'history.json');
  fs.writeFileSync(source, 'substituted');
  configureDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough(sourcePath, destinationPath) { fs.renameSync(sourcePath, destinationPath); },
      replaceFileWriteThrough(sourcePath, destinationPath) { fs.renameSync(sourcePath, destinationPath); },
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  const expectedSourceSha256 = crypto.createHash('sha256').update('validated').digest('hex');
  assert.throws(
    () => renameWithConfiguredDurableFs(source, destination, { expectedSourceSha256 }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(destination), false);
});

test('explicit directory flush is capability checked', (t) => {
  const { root, calls, durableFs } = fixture(t);
  const directory = path.join(root, 'metadata');
  fs.mkdirSync(directory);

  durableFs.flushDirectory(directory);

  assert.deepEqual(calls, [{ kind: 'flush-directory', directoryPath: directory }]);
  assert.throws(
    () => durableFs.flushDirectory(path.dirname(root)),
    error => error.code === 'COMMIT_FAILED'
  );
});

test('durable rename rejects parents on different volume identities before publication', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-volume-'));
  const sourceParent = path.join(root, 'source');
  const destinationParent = path.join(root, 'destination');
  fs.mkdirSync(sourceParent);
  fs.mkdirSync(destinationParent);
  const source = path.join(sourceParent, 'candidate');
  const destination = path.join(destinationParent, 'published');
  fs.mkdirSync(source);
  let moveCalls = 0;
  const fsApi = {
    ...fs,
    lstatSync(candidate, options) {
      const stat = fs.lstatSync(candidate, options);
      if (path.resolve(candidate) !== path.resolve(destinationParent)) return stat;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        dev: Number(stat.dev) + 1
      });
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough() { moveCalls += 1; },
      replaceFileWriteThrough() { throw new Error('replacement is not expected'); },
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.renameDurable(source, destination),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication'
  );
  assert.equal(moveCalls, 0);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(destination), false);
});

test('durable rename rejects a source identity replaced during planning', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-source-race-'));
  const source = path.join(root, 'candidate');
  const original = path.join(root, 'original-candidate');
  const destination = path.join(root, 'published');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'identity.txt'), 'original');
  let swapped = false;
  let moveCalls = 0;
  const fsApi = {
    ...fs,
    lstatSync(candidate, options) {
      if (!swapped && path.resolve(candidate) === path.resolve(destination)) {
        swapped = true;
        fs.renameSync(source, original);
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'identity.txt'), 'replacement');
      }
      return fs.lstatSync(candidate, options);
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough() { moveCalls += 1; },
      replaceFileWriteThrough() { throw new Error('replacement is not expected'); },
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.renameDurable(source, destination),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(moveCalls, 0);
  assert.equal(fs.readFileSync(path.join(original, 'identity.txt'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(source, 'identity.txt'), 'utf8'), 'replacement');
});

test('sha256File hashes bytes without changing them', (t) => {
  const { root, durableFs } = fixture(t);
  const target = path.join(root, 'artifact.bin');
  const bytes = crypto.randomBytes(8193);
  fs.writeFileSync(target, bytes);

  assert.equal(
    durableFs.sha256File(target),
    crypto.createHash('sha256').update(bytes).digest('hex')
  );
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('paths outside configured roots and reparse parents fail before a temp is opened', (t) => {
  const { root, calls, durableFs } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.writeJsonAtomic(path.join(outside, 'outside.json'), { unsafe: true }),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication'
  );
  const link = path.join(root, 'redirect');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => durableFs.writeJsonAtomic(path.join(link, 'redirected.json'), { unsafe: true }),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication'
  );
  assert.equal(fs.existsSync(path.join(outside, 'outside.json')), false);
  assert.equal(fs.existsSync(path.join(outside, 'redirected.json')), false);
  assert.deepEqual(calls, []);
});

test('raw traversal aliases are rejected before write rename read hash or flush normalization', (t) => {
  const { root, calls, durableFs } = fixture(t);
  const source = path.join(root, 'source.json');
  fs.writeFileSync(source, '{}');
  const rawTarget = `${root}${path.sep}nested${path.sep}..${path.sep}target.json`;
  const rawSource = `${root}${path.sep}.${path.sep}source.json`;
  const rawDirectory = `${root}${path.sep}nested${path.sep}..`;
  for (const operation of [
    () => durableFs.writeJsonAtomic(rawTarget, {}),
    () => durableFs.renameDurable(rawSource, path.join(root, 'history.json')),
    () => durableFs.renameDurable(source, rawTarget),
    () => durableFs.readFileBounded(rawSource),
    () => durableFs.sha256File(rawSource),
    () => durableFs.flushDirectory(rawDirectory)
  ]) {
    assert.throws(operation, error => error.code === 'COMMIT_FAILED');
  }
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(path.join(root, 'target.json')), false);
  assert.deepEqual(calls, []);
});

test('strict JSON rejects getters prototypes nonfinite numbers and oversize values without invoking code', (t) => {
  const { root } = fixture(t);
  let getterCalls = 0;
  const withGetter = {};
  Object.defineProperty(withGetter, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    }
  });
  const strict = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root],
    maxJsonBytes: 32,
    tempNameFactory: () => 'strict-json'
  });
  const invalid = [
    withGetter,
    new Date(),
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: undefined },
    { value() {} },
    Object.assign(Object.create(null), { value: 'null-prototype' }),
    { value: 'x'.repeat(64) }
  ];

  for (const [index, value] of invalid.entries()) {
    assert.throws(
      () => strict.writeJsonAtomic(path.join(root, `invalid-${index}.json`), value),
      error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication'
    );
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('strict JSON rejects array accessors and hidden named properties without invoking code', (t) => {
  const { root, durableFs } = fixture(t);
  let getterCalls = 0;
  const withAccessor = [];
  Object.defineProperty(withAccessor, '0', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'unsafe';
    }
  });
  withAccessor.length = 1;
  const withHiddenProperty = [];
  Object.defineProperty(withHiddenProperty, 'hidden', {
    enumerable: false,
    configurable: true,
    value: 'unsafe'
  });
  const withNonIndexDecimalName = [];
  Object.defineProperty(withNonIndexDecimalName, '4294967295', {
    enumerable: true,
    configurable: true,
    value: 'unsafe'
  });

  assert.throws(
    () => durableFs.writeJsonAtomic(path.join(root, 'accessor.json'), withAccessor),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication'
  );
  assert.throws(
    () => durableFs.writeJsonAtomic(path.join(root, 'hidden.json'), withHiddenProperty),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication'
  );
  assert.throws(
    () => durableFs.writeJsonAtomic(path.join(root, 'non-index.json'), withNonIndexDecimalName),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication'
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('atomic writes enforce a constructor-narrowed byte cap and restrictive new-file mode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-cap-'));
  const modes = [];
  const fsApi = {
    ...fs,
    openSync(filePath, flags, mode) {
      if (flags === 'wx') modes.push(mode);
      return fs.openSync(filePath, flags, mode);
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root],
    maxAtomicBytes: 8,
    tempNameFactory: () => 'cap'
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.writeFileAtomic(path.join(root, 'large.bin'), Buffer.alloc(9)),
    error => error.code === 'COMMIT_FAILED'
  );
  durableFs.writeFileAtomic(path.join(root, 'small.bin'), Buffer.alloc(8));
  assert.equal(modes.at(-1), 0o600);
});

test('post-publication flush failure is explicitly classified and leaves complete bytes', (t) => {
  const { root, durableFs } = fixture(t, { failAt: 'flush-directory' });
  const target = path.join(root, 'state.json');

  assert.throws(
    () => durableFs.writeJsonAtomic(target, { complete: true }),
    error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'post-publication'
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { complete: true });
  assert.deepEqual(tempEntries(root), []);
});

test('durable rename refuses an existing destination without changing either tree', (t) => {
  const { root, durableFs } = fixture(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  fs.mkdirSync(destination);

  assert.throws(() => durableFs.renameDurable(source, destination), error => error.code === 'TARGET_EXISTS');
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(destination), true);
});

test('sha256File rejects a file whose identity changes while it is read', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-hash-race-'));
  const target = path.join(root, 'artifact.bin');
  fs.writeFileSync(target, 'stable');
  let fstatCalls = 0;
  const fsApi = {
    ...fs,
    fstatSync(fd, options) {
      const stat = fs.fstatSync(fd, options);
      fstatCalls += 1;
      if (fstatCalls === 2) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          size: typeof stat.size === 'bigint' ? stat.size + 1n : stat.size + 1
        });
      }
      return stat;
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => durableFs.sha256File(target), error => error.code === 'PLAN_STALE');
});

test('sha256File rejects same-size timestamp mutation while the handle is read', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-hash-time-race-'));
  const target = path.join(root, 'artifact.bin');
  fs.writeFileSync(target, 'stable');
  let fstatCalls = 0;
  const fsApi = {
    ...fs,
    fstatSync(fd, options) {
      const stat = fs.fstatSync(fd, options);
      fstatCalls += 1;
      if (fstatCalls === 2) {
        const changes = stat.mtimeNs !== undefined
          ? { mtimeNs: stat.mtimeNs + 1n, ctimeNs: stat.ctimeNs + 1n }
          : { mtimeMs: Number(stat.mtimeMs) + 1, ctimeMs: Number(stat.ctimeMs) + 1 };
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes);
      }
      return stat;
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => durableFs.sha256File(target), error => error.code === 'PLAN_STALE');
});

test('sha256File accepts ctime-only drift while retaining size, mtime, path, and bytes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-hash-ctime-'));
  const target = path.join(root, 'artifact.bin');
  fs.writeFileSync(target, 'stable');
  let fstatCalls = 0;
  const fsApi = {
    ...fs,
    fstatSync(fd, options) {
      const stat = fs.fstatSync(fd, options);
      fstatCalls += 1;
      if (fstatCalls === 2) {
        const ctimeKey = stat.ctimeNs === undefined ? 'ctimeMs' : 'ctimeNs';
        const value = stat[ctimeKey];
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          [ctimeKey]: typeof value === 'bigint' ? value + 1n : value + 1
        });
      }
      return stat;
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(
    durableFs.sha256File(target),
    crypto.createHash('sha256').update('stable').digest('hex')
  );
});

test('an allowed root identity replacement is rejected before any file opens', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-root-race-'));
  let rootStats = 0;
  let openCalls = 0;
  const fsApi = {
    ...fs,
    lstatSync(candidate, options) {
      const stat = fs.lstatSync(candidate, options);
      if (path.resolve(candidate) === path.resolve(root) && ++rootStats > 1) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          ino: Number(stat.ino) + 4096
        });
      }
      return stat;
    },
    openSync(...args) {
      openCalls += 1;
      return fs.openSync(...args);
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => durableFs.writeJsonAtomic(path.join(root, 'state.json'), { safe: true }),
    error => error.code === 'PLAN_STALE'
  );
  assert.equal(openCalls, 0);
});

test('filesystem identity reads request bigint stats', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-bigint-identity-'));
  const target = path.join(root, 'artifact.bin');
  fs.writeFileSync(target, 'identity');
  let bigintLstatCalls = 0;
  let bigintFstatCalls = 0;
  const fsApi = {
    ...fs,
    lstatSync(candidate, options) {
      if (options?.bigint === true) bigintLstatCalls += 1;
      return fs.lstatSync(candidate, options);
    },
    fstatSync(descriptor, options) {
      if (options?.bigint === true) bigintFstatCalls += 1;
      return fs.fstatSync(descriptor, options);
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root]
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  durableFs.sha256File(target);
  assert.ok(bigintLstatCalls > 0);
  assert.ok(bigintFstatCalls > 0);
});

test('flushDirectoryAsync revalidates the exact directory before and after the awaited native flush', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-async-identity-'));
  const directory = path.join(root, 'directory');
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {},
      async flushDirectoryAsync(target, expectations) {
        calls += 1;
        assert.equal(target, path.resolve(directory));
        assert.equal(typeof expectations.directoryIdentity.ino, 'string');
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    allowedRoots: [root]
  });

  assert.equal(await durableFs.flushDirectoryAsync(directory), path.resolve(directory));
  assert.equal(calls, 1);

  const replacingClient = {
    moveWriteThrough: fs.renameSync,
    replaceFileWriteThrough: fs.renameSync,
    flushDirectory() {},
    async flushDirectoryAsync() {
      fs.renameSync(directory, `${directory}-old`);
      fs.mkdirSync(directory);
    }
  };
  const guarded = createDurableFs({ fsApi: fs, durableClient: replacingClient, allowedRoots: [root] });
  await assert.rejects(
    guarded.flushDirectoryAsync(directory),
    error => error.code === 'PLAN_STALE' || error.code === 'COMMIT_FAILED'
  );
});

test('flushDirectoriesAsync revalidates every exact directory around one awaited native batch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-async-batch-identity-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {},
      flushDirectories() { throw new Error('synchronous batch must not run'); },
      async flushDirectoriesAsync(targets, expectations) {
        calls.push({ targets: [...targets], expectations });
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    allowedRoots: [root]
  });

  assert.deepEqual(
    await durableFs.flushDirectoriesAsync([first, second]),
    [path.resolve(first), path.resolve(second)]
  );
  assert.deepEqual(calls[0].targets, [path.resolve(first), path.resolve(second)]);
  assert.equal(calls[0].expectations.directoryIdentities.length, 2);
  assert.equal(calls[0].expectations.directoryIdentities.every(identity => typeof identity.ino === 'string'), true);

  const replacingClient = {
    moveWriteThrough: fs.renameSync,
    replaceFileWriteThrough: fs.renameSync,
    flushDirectory() {},
    async flushDirectoriesAsync() {
      fs.renameSync(first, `${first}-old`);
      fs.mkdirSync(first);
    }
  };
  const guarded = createDurableFs({ fsApi: fs, durableClient: replacingClient, allowedRoots: [root] });
  await assert.rejects(
    guarded.flushDirectoriesAsync([first, second]),
    error => error.code === 'PLAN_STALE' || error.code === 'COMMIT_FAILED'
  );
});

test('renameDurableAsync authenticates the source and revalidates the exact published file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-async-move-'));
  const source = path.join(root, 'active.json');
  const destination = path.join(root, 'history.json');
  const contents = '{"phase":"completed"}\n';
  fs.writeFileSync(source, contents);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let asyncMoves = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    durableClient: {
      moveWriteThrough() { throw new Error('synchronous move must not run'); },
      async moveWriteThroughAsync(from, to, expectations) {
        asyncMoves += 1;
        assert.equal(typeof expectations.sourceIdentity.sha256, 'string');
        await new Promise(resolve => setImmediate(resolve));
        fs.renameSync(from, to);
      },
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {},
      async flushDirectoryAsync() {}
    },
    allowedRoots: [root]
  });
  const expectedSourceSha256 = crypto.createHash('sha256').update(contents).digest('hex');

  assert.equal(
    await durableFs.renameDurableAsync(source, destination, { expectedSourceSha256 }),
    path.resolve(destination)
  );
  assert.equal(asyncMoves, 1);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(destination, 'utf8'), contents);
});

test('writeJsonAtomicAsync keeps the event loop responsive through file sync and native replacement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-async-atomic-'));
  const target = path.join(root, 'job.json');
  fs.writeFileSync(target, '{"sequence":1}\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asyncFsApi = {
    async open(...args) {
      const handle = await fs.promises.open(...args);
      return {
        stat: options => handle.stat(options),
        write: (...writeArgs) => handle.write(...writeArgs),
        async sync() {
          await new Promise(resolve => setTimeout(resolve, 120));
          return handle.sync();
        },
        close: () => handle.close()
      };
    },
    unlink: targetPath => fs.promises.unlink(targetPath)
  };
  let asyncReplacements = 0;
  const durableFs = createDurableFs({
    fsApi: fs,
    asyncFsApi,
    durableClient: {
      moveWriteThrough() { throw new Error('synchronous move must not run'); },
      replaceFileWriteThrough() { throw new Error('synchronous replacement must not run'); },
      flushDirectory() {},
      async moveWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
      async replaceFileWriteThroughAsync(source, destination, expectations) {
        asyncReplacements += 1;
        assert.equal(expectations.destinationIdentity.sha256, priorSha256);
        await new Promise(resolve => setImmediate(resolve));
        fs.renameSync(source, destination);
      },
      async flushDirectoryAsync() {}
    },
    allowedRoots: [root],
    tempNameFactory: () => 'async-atomic'
  });
  const priorSha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  let settled = false;
  const pending = durableFs.writeJsonAtomicAsync(target, { sequence: 2 }, {
    expectedTargetSha256: priorSha256
  }).finally(() => { settled = true; });
  const winner = await Promise.race([
    pending.then(() => 'write'),
    new Promise(resolve => setTimeout(() => resolve('timer'), 30))
  ]);
  assert.equal(winner, 'timer');
  assert.equal(settled, false);
  await pending;
  assert.equal(asyncReplacements, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { sequence: 2 });
});

test('readFileBoundedAsync yields while the authenticated file handle is pending', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-async-read-'));
  const target = path.join(root, 'journal.json');
  const expected = Buffer.from('{"sequence":1}\n', 'utf8');
  fs.writeFileSync(target, expected);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let announceOpen;
  const openStarted = new Promise(resolve => { announceOpen = resolve; });
  let releaseOpen;
  const openGate = new Promise(resolve => { releaseOpen = resolve; });
  const asyncFsApi = {
    async open(...args) {
      announceOpen();
      await openGate;
      const handle = await fs.promises.open(...args);
      return {
        stat: options => handle.stat(options),
        read: (...readArgs) => handle.read(...readArgs),
        close: () => handle.close()
      };
    },
    unlink: targetPath => fs.promises.unlink(targetPath)
  };
  const durableFs = createDurableFs({
    fsApi: fs,
    asyncFsApi,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {}
    },
    allowedRoots: [root]
  });

  assert.equal(typeof durableFs.readFileBoundedAsync, 'function');
  const pending = durableFs.readFileBoundedAsync(target, { allowMissing: false, maxBytes: 1024 });
  await openStarted;
  const winner = await Promise.race([
    pending.then(() => 'read'),
    new Promise(resolve => setImmediate(() => resolve('event-loop')))
  ]);
  assert.equal(winner, 'event-loop');
  releaseOpen();
  assert.deepEqual(await pending, expected);
});

test('writeJsonAtomicAsync cleans its temp after a native pre-publication failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-async-prepublish-'));
  const target = path.join(root, 'job.json');
  fs.writeFileSync(target, '{"sequence":1}\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failure = new ModpackError('COMMIT_FAILED', 'Durable filesystem operation failed');
  Object.defineProperties(failure, {
    durableFailureKind: { value: 'integrity-failure', enumerable: true },
    durableFailureStage: { value: 'destination-parent-open', enumerable: true }
  });
  const durableFs = createDurableFs({
    fsApi: fs,
    asyncFsApi: fs.promises,
    allowedRoots: [root],
    durableClient: {
      moveWriteThrough() { throw new Error('synchronous move must not run'); },
      replaceFileWriteThrough() { throw new Error('synchronous replacement must not run'); },
      flushDirectory() {},
      async moveWriteThroughAsync(source, destination) { fs.renameSync(source, destination); },
      async replaceFileWriteThroughAsync() { throw failure; },
      async flushDirectoryAsync() {}
    }
  });
  const priorSha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');

  await assert.rejects(
    durableFs.writeJsonAtomicAsync(target, { sequence: 2 }, { expectedTargetSha256: priorSha256 }),
    error => error === failure && error.commitPhase === 'pre-publication'
  );
  assert.equal(fs.readFileSync(target, 'utf8'), '{"sequence":1}\n');
  assert.deepEqual(tempEntries(root), []);
});

function missingWorkerError() {
  return new ModpackError('EXTRACTOR_UNAVAILABLE', 'The archive extractor is unavailable');
}

// A real native client whose worker executable cannot be used. Only the worker
// verifier and the process launcher are injected; path ownership, identities
// and request framing are production code.
function unavailableWorkerClient(root, overrides = {}) {
  const calls = { verify: 0, spawnSync: 0 };
  const client = new WindowsDurableFsClient({
    workerPath: path.join(root, 'resources', 'ArchiveWorker.exe'),
    workerManifestPath: path.join(root, 'resources', 'archive-worker-x64.json'),
    allowedRoots: [root],
    appOwnedRoot: path.join(root, 'broker'),
    verifyWorker() {
      calls.verify += 1;
      throw missingWorkerError();
    },
    spawnSync() {
      calls.spawnSync += 1;
      throw new Error('an unverified worker must never be launched');
    },
    ...overrides
  });
  return { calls, client };
}

function tempEntriesFor(root, target) {
  return fs.readdirSync(root).filter(name => name.startsWith(`.${path.basename(target)}.minecraft-core-tmp-`));
}

test('a durable worker that never starts is pre-publication and leaves no temp', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-worker-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { calls, client } = unavailableWorkerClient(root);
  const durableFs = createDurableFs({ fsApi: fs, durableClient: client, allowedRoots: [root] });
  const created = path.join(root, 'created.json');
  const replaced = path.join(root, 'replaced.json');
  fs.writeFileSync(replaced, '{"stable":true}\n');

  for (const target of [created, replaced]) {
    assert.throws(() => durableFs.writeJsonAtomic(target, { stable: false }), error =>
      error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication' &&
      error.durableFailureKind === 'worker-failure' && error.durableFailureStage === 'preflight-revalidation' &&
      error.message.includes('ArchiveWorker.exe') && error.cause?.code === 'EXTRACTOR_UNAVAILABLE');
  }

  assert.equal(fs.existsSync(created), false);
  assert.equal(fs.readFileSync(replaced, 'utf8'), '{"stable":true}\n');
  assert.deepEqual(tempEntries(root), []);
  assert.deepEqual(calls, { verify: 2, spawnSync: 0 });
});

test('a worker launch refused before any process exists is pre-publication; a launched failure stays uncertain', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-worker-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launchError = code => Object.assign(new Error(`spawnSync ${code}`), { code });
  const cases = [
    ['refused-launch', () => ({ pid: 0, error: launchError('ENOENT'), status: null, signal: null, stdout: null, stderr: null }),
      'pre-publication'],
    ['throwing-launch', () => { throw launchError('EACCES'); }, 'pre-publication'],
    ['timed-out-worker', () => ({ pid: 4242, error: launchError('ETIMEDOUT'), status: null, signal: 'SIGTERM',
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }), 'post-publication-uncertain'],
    ['failed-worker', () => ({ pid: 4243, status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from('failed') }),
      'post-publication-uncertain']
  ];

  for (const [label, spawnSync, phase] of cases) {
    const { client } = unavailableWorkerClient(root, { verifyWorker() {}, spawnSync });
    const durableFs = createDurableFs({ fsApi: fs, durableClient: client, allowedRoots: [root] });
    const target = path.join(root, `${label}.json`);
    assert.throws(() => durableFs.writeJsonAtomic(target, { label }), error =>
      error.code === 'COMMIT_FAILED' && error.commitPhase === phase &&
      error.durableFailureStage === (phase === 'pre-publication' ? 'preflight-revalidation' : undefined), label);
    assert.equal(fs.existsSync(target), false, label);
    assert.equal(tempEntriesFor(root, target).length, phase === 'pre-publication' ? 0 : 1, label);
  }
});

// The first native call renames the staged temp onto the target and only then
// fails, so the write is published. The call that would confirm it (a native
// reconcile or a parent flush) never starts a worker, or reports a
// pre-publication stage of its own: neither may relabel the published write.
test('a published write stays uncertain when its reconcile or parent flush cannot start a worker', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launchedFailures = {
    'timed-out': () => ({ pid: 4242, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      status: null, signal: 'SIGTERM', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    failed: () => ({ pid: 4243, status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
  };
  const reportsPreflight = () => ({ pid: 4244, status: 0, signal: null, stderr: Buffer.alloc(0),
    stdout: encodeFrame({ ok: false, failureKind: 'io-failure', failureStage: 'preflight-revalidation' }) });

  function nativeReconcileCase(label, existing, { firstOutcome, reconcileOutcome = null }) {
    const operations = [];
    let verifications = 0;
    const { client } = unavailableWorkerClient(root, {
      verifyWorker() {
        verifications += 1;
        if (reconcileOutcome === null && verifications > 1) throw missingWorkerError();
      },
      spawnSync(_file, _args, options) {
        const request = JSON.parse(options.input.subarray(4).toString('utf8'));
        operations.push(request.operation);
        if (operations.length > 1) return reconcileOutcome();
        fs.renameSync(request.sourcePath, request.destinationPath);
        return firstOutcome();
      }
    });
    return { label, existing, client, operations, verifications: () => verifications,
      expectedOperations: [existing ? 'replace-file-write-through' : 'move-write-through',
        ...(reconcileOutcome === null ? [] : ['reconcile-move-write-through'])],
      expectedVerifications: 2, causeKind: reconcileOutcome === null ? 'worker-failure' : 'io-failure' };
  }

  function parentFlushCase(label, existing) {
    const operations = [];
    const { calls, client: nativeClient } = unavailableWorkerClient(root);
    const publishThenFail = operation => (source, destination) => {
      operations.push(operation);
      fs.renameSync(source, destination);
      throw new Error('injected failure after the rename');
    };
    // No native reconcile capability: durable-fs confirms the rename by
    // flushing the parent through a client whose worker cannot be verified.
    const client = {
      moveWriteThrough: publishThenFail('move-write-through'),
      replaceFileWriteThrough: publishThenFail('replace-file-write-through'),
      flushDirectory: (directory, expectations) => nativeClient.flushDirectory(directory, expectations)
    };
    return { label, existing, client, operations, verifications: () => calls.verify,
      expectedOperations: [existing ? 'replace-file-write-through' : 'move-write-through'],
      expectedVerifications: 1, causeKind: 'worker-failure' };
  }

  const cases = [];
  for (const [outcome, firstOutcome] of Object.entries(launchedFailures)) {
    for (const existing of [false, true]) {
      cases.push(nativeReconcileCase(`${outcome}-missing-reconcile-worker`, existing, { firstOutcome }));
    }
  }
  cases.push(nativeReconcileCase('reconcile-reports-preflight', false,
    { firstOutcome: launchedFailures.failed, reconcileOutcome: reportsPreflight }));
  for (const existing of [false, true]) cases.push(parentFlushCase('missing-flush-worker', existing));

  for (const { label, existing, client, operations, verifications, expectedOperations, expectedVerifications, causeKind } of cases) {
    const name = `${label}-${existing ? 'replaced' : 'created'}`;
    const target = path.join(root, `${name}.json`);
    if (existing) fs.writeFileSync(target, '{"previous":true}\n');
    const durableFs = createDurableFs({ fsApi: fs, durableClient: client, allowedRoots: [root] });

    assert.throws(() => durableFs.writeJsonAtomic(target, { name }), error =>
      error.code === 'COMMIT_FAILED' && error.commitPhase === 'post-publication-uncertain' &&
      error.cause?.durableFailureKind === causeKind && error.cause?.durableFailureStage === 'preflight-revalidation', name);
    assert.deepEqual(operations, expectedOperations, name);
    assert.equal(verifications(), expectedVerifications, name);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { name }, name);
    assert.deepEqual(tempEntriesFor(root, target), [], name);
  }
});

test('a failed publication whose target can no longer be proven stays uncertain, sync and async', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-unprovable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The temp is renamed onto the target, which is then swapped for a directory
  // before the call fails, so the reconcile cannot prove the outcome.
  const publishThenSubstitute = (source, destination) => {
    fs.renameSync(source, destination);
    fs.rmSync(destination);
    fs.mkdirSync(destination);
    throw new Error('injected failure after a substituted publication');
  };
  const durableFs = createDurableFs({
    fsApi: fs,
    asyncFsApi: fs.promises,
    durableClient: {
      moveWriteThrough() { throw new Error('new-file move is not expected'); },
      replaceFileWriteThrough: publishThenSubstitute,
      flushDirectory() {},
      async moveWriteThroughAsync() { throw new Error('new-file move is not expected'); },
      async replaceFileWriteThroughAsync(source, destination) { publishThenSubstitute(source, destination); },
      async flushDirectoryAsync() {}
    },
    allowedRoots: [root]
  });
  const uncertain = error => error.code === 'COMMIT_FAILED' && error.commitPhase === 'post-publication-uncertain';

  const syncTarget = path.join(root, 'sync.json');
  fs.writeFileSync(syncTarget, '{"old":true}\n');
  assert.throws(() => durableFs.writeJsonAtomic(syncTarget, { old: false }), uncertain);
  const asyncTarget = path.join(root, 'async.json');
  fs.writeFileSync(asyncTarget, '{"old":true}\n');
  await assert.rejects(durableFs.writeJsonAtomicAsync(asyncTarget, { old: false }), uncertain);

  assert.equal(fs.lstatSync(syncTarget).isDirectory(), true);
  assert.equal(fs.lstatSync(asyncTarget).isDirectory(), true);
  assert.deepEqual(tempEntries(root), []);
});

test('an oversized native request is refused before any worker is verified or launched', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-frame-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let parent = root;
  for (let index = 0; index < 12; index += 1) {
    parent = path.join(parent, `${index}-${'界'.repeat(240)}`);
    fs.mkdirSync(parent);
  }
  const directories = Array.from({ length: 200 }, (_, index) => path.join(parent, `directory-${index}`));
  for (const directory of directories) fs.mkdirSync(directory);
  const { calls, client } = unavailableWorkerClient(root);

  assert.throws(() => client.flushDirectories(directories), error =>
    error.code === 'COMMIT_FAILED' && error.durableFailureKind === 'worker-failure' &&
    error.durableFailureStage === 'preflight-revalidation');
  assert.deepEqual(calls, { verify: 0, spawnSync: 0 });
});

test('durable temp names share one template with the startup leftover matcher', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-durable-temp-template-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = 'b7c0d2e4-0f1a-4c3b-9d8e-7f6a5b4c3d2e';
  const staged = [];
  const fsApi = {
    ...fs,
    openSync(filePath, flags, mode) {
      if (flags === 'wx') staged.push(path.basename(filePath));
      return fs.openSync(filePath, flags, mode);
    }
  };
  const asyncFsApi = {
    ...fs.promises,
    open(filePath, flags, mode) {
      if (flags === 'wx') staged.push(path.basename(filePath));
      return fs.promises.open(filePath, flags, mode);
    }
  };
  const durableFs = createDurableFs({
    fsApi,
    asyncFsApi,
    allowedRoots: [root],
    tempNameFactory: () => token,
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {},
      moveWriteThroughAsync: fs.promises.rename,
      replaceFileWriteThroughAsync: fs.promises.rename,
      async flushDirectoryAsync() {}
    }
  });

  durableFs.writeJsonAtomic(path.join(root, 'job-0001.json'), { sync: true });
  await durableFs.writeJsonAtomicAsync(path.join(root, 'job-0002.target.json'), { async: true });

  assert.deepEqual(staged, [
    `.job-0001.json.minecraft-core-tmp-${token}`,
    `.job-0002.target.json.minecraft-core-tmp-${token}`
  ]);
  assert.deepEqual(staged.map(durableTempTargetName), ['job-0001.json', 'job-0002.target.json']);
  assert.equal(durableTempTargetName('.a.minecraft-core-tmp-b.minecraft-core-tmp-c'), 'a.minecraft-core-tmp-b');
  for (const name of ['job-0001.json', '.job-0001.json', '.job-0001.json.minecraft-core-tmp-',
    '.job-0001.json.minecraft-core-tmp-bad.token', '..minecraft-core-tmp-abc',
    `.job.json.minecraft-core-tmp-${'a'.repeat(129)}`, '', null, undefined, 7]) {
    assert.equal(durableTempTargetName(name), null, String(name));
  }

  const scanned = path.join(root, 'scanned');
  fs.mkdirSync(scanned);
  const recordName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;
  fs.writeFileSync(path.join(scanned, `.job-0003.json.minecraft-core-tmp-${token}`), '{"partial":');
  fs.writeFileSync(path.join(scanned, `.junk.txt.minecraft-core-tmp-${token}`), 'junk');
  fs.writeFileSync(path.join(scanned, 'job-0003.json'), '{}');
  fs.mkdirSync(path.join(scanned, `.job-0004.json.minecraft-core-tmp-${token}`));
  let linked = true;
  try {
    fs.symlinkSync(path.join(scanned, 'job-0003.json'), path.join(scanned, `.job-0005.json.minecraft-core-tmp-${token}`), 'file');
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    linked = false;
  }
  const entries = new Map(fs.readdirSync(scanned, { withFileTypes: true }).map(entry => [entry.name, entry]));
  const leftover = entries.get(`.job-0003.json.minecraft-core-tmp-${token}`);
  assert.equal(isDurableTempLeftover(leftover, recordName), true);
  assert.equal(isDurableTempLeftover(leftover, name => name === 'job-0003.json'), true);
  assert.equal(isDurableTempLeftover(leftover, name => name === 'job-0004.json'), false);
  assert.equal(isDurableTempLeftover(entries.get(`.junk.txt.minecraft-core-tmp-${token}`), recordName), false);
  assert.equal(isDurableTempLeftover(entries.get('job-0003.json'), recordName), false);
  assert.equal(isDurableTempLeftover(entries.get(`.job-0004.json.minecraft-core-tmp-${token}`), recordName), false);
  if (linked) assert.equal(isDurableTempLeftover(entries.get(`.job-0005.json.minecraft-core-tmp-${token}`), recordName), false);
  assert.equal(isDurableTempLeftover(null, recordName), false);
  assert.equal(isDurableTempLeftover(leftover, null), false);
});

test('deferred directory flushes run in creation order before the next write and report pre-publication', () => {
  const calls = [];
  let failing = true;
  const flushes = createDeferredDirectoryFlushes(directory => {
    calls.push(directory);
    if (failing) throw new ModpackError('COMMIT_FAILED', 'Durable filesystem operation failed');
  });
  const failure = cause => new ModpackError('COMMIT_FAILED', 'The test store could not be updated', { cause });

  assert.equal(flushes.created('first-parent'), false);
  assert.equal(flushes.created('second-parent'), false);
  assert.equal(flushes.created('first-parent'), false);
  assert.deepEqual(calls, ['first-parent'], 'a parent created behind a deferred flush is queued without another native call');
  assert.throws(() => flushes.flushPending(failure), error =>
    error.code === 'COMMIT_FAILED' && error.commitPhase === 'pre-publication' &&
    error.safeMessage === 'The test store could not be updated' && error.cause?.code === 'COMMIT_FAILED');
  assert.deepEqual(calls, ['first-parent', 'first-parent']);

  failing = false;
  flushes.flushPending(failure);
  flushes.flushPending(failure);
  assert.deepEqual(calls, ['first-parent', 'first-parent', 'first-parent', 'second-parent']);
  assert.equal(flushes.created('third-parent'), true);
  assert.deepEqual(calls.slice(4), ['third-parent']);
  assert.throws(() => createDeferredDirectoryFlushes(null), error => error.code === 'COMMIT_FAILED');
});
