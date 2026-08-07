const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  configureDurableFs,
  createDurableFs,
  renameDurable: renameWithConfiguredDurableFs
} = require('../electron/utils/durable-fs.cjs');

function fixture(t, { failAt = null, shortWrites = false } = {}) {
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
