const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createProductionServerSnapshot
} = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');

const runtime = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'forge',
  loaderVersion: '47.3.0',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function currentState() {
  return {
    state: {
      modpackManaged: true,
      contentRevision: 3,
      runtime
    },
    manifest: { schemaVersion: 1, installationId: 'installed-one', entries: [] }
  };
}

function snapshotRequest(serverPath, extra = {}) {
  return {
    currentState: currentState(),
    operationKind: 'upgrade',
    runtime,
    serverKind: 'existing',
    serverPath,
    ...extra
  };
}

function stateRepository() {
  return {
    read() { return currentState(); },
    listHistory() { return { items: [], nextCursor: null }; }
  };
}

function writeSizedFile(filePath, size, byte = 0x5a) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(size, byte));
}

function diskBudgetFixture(t, prefix) {
  const serverPath = fixture(t, prefix);
  writeSizedFile(path.join(serverPath, 'mods', 'pack.jar'), 11, 0x11);
  writeSizedFile(path.join(serverPath, '.minecraft-core.json'), 13, 0x13);
  writeSizedFile(path.join(serverPath, '.minecraft-core-state', 'history', 'entry.json'), 17, 0x17);
  writeSizedFile(path.join(serverPath, '.minecraft-core-state', 'operations', 'old', 'journal.json'), 19, 0x19);
  writeSizedFile(path.join(serverPath, 'backups', 'restore-old.zip'), 101, 0x21);
  writeSizedFile(path.join(serverPath, 'backups', 'restore-old.json'), 23, 0x23);
  writeSizedFile(path.join(serverPath, 'crash-reports', 'crash.txt'), 29, 0x29);
  writeSizedFile(path.join(serverPath, 'logs', 'latest.log'), 31, 0x31);
  return serverPath;
}

function syncFilesystemThatRejectsContentIo(calls) {
  const blocked = new Set([
    'accessSync', 'closeSync', 'lstatSync', 'openSync', 'readFileSync', 'readSync', 'readdirSync'
  ]);
  return new Proxy(fs, {
    get(target, property, receiver) {
      if (!blocked.has(property)) return Reflect.get(target, property, receiver);
      return () => {
        calls.push(property);
        throw new Error(`synchronous content API invoked: ${property}`);
      };
    }
  });
}

test('existing-server snapshot refuses to capture server.properties larger than one MiB', async t => {
  const serverPath = fixture(t, 'minecraft-core-snapshot-properties-cap-');
  fs.writeFileSync(path.join(serverPath, 'server.properties'), Buffer.alloc((1024 * 1024) + 1, 0x61));
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises: fsp,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });

  await assert.rejects(
    snapshotServer(snapshotRequest(serverPath)),
    error => error?.code === 'PLAN_STALE'
  );
});

test('existing-server snapshot permits server.properties at the one MiB boundary', async t => {
  const serverPath = fixture(t, 'minecraft-core-snapshot-properties-boundary-');
  fs.writeFileSync(path.join(serverPath, 'server.properties'), Buffer.alloc(1024 * 1024, 0x23));
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises: fsp,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });

  const snapshot = await snapshotServer(snapshotRequest(serverPath));
  const properties = snapshot.liveSnapshot.entries.find(entry => entry.pathKey === 'server.properties');
  assert.equal(properties?.size, String(1024 * 1024));
});

test('existing-server snapshot discovers the effective Java-properties level name', async t => {
  const serverPath = fixture(t, 'minecraft-core-snapshot-level-name-');
  fs.writeFileSync(path.join(serverPath, 'server.properties'), [
    'level-name=ignored',
    'level\\u002dname: saves/\\',
    ' custom_world',
    ''
  ].join('\r\n'));
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises: fsp,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });

  const snapshot = await snapshotServer(snapshotRequest(serverPath));

  assert.deepEqual(snapshot.liveSnapshot.worldDirectories, [
    'saves/custom_world', 'world', 'world_nether', 'world_the_end'
  ]);
});

test('existing mutation disk accounting charges retained backups once and both safety restore copies', async t => {
  const serverPath = diskBudgetFixture(t, 'minecraft-core-snapshot-disk-existing-');
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises: fsp,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });

  const snapshot = await snapshotServer(snapshotRequest(serverPath));

  // The ordinary candidate clones all 244 live bytes. Before that clone, the
  // operation creates a safety restore from the 120 non-backup bytes, and the
  // clone then retains a second copy of that archive. Existing backup bytes
  // (101-byte ZIP + 23-byte metadata) are copied only into the candidate.
  assert.deepEqual({
    candidateBytes: snapshot.candidateBytes,
    restorePointBytes: snapshot.restorePointBytes,
    rollbackBytes: snapshot.rollbackBytes
  }, {
    candidateBytes: '364',
    restorePointBytes: '120',
    rollbackBytes: '0'
  });
});

test('rollback disk accounting budgets only fresh-candidate live copies plus the new safety restore copy', async t => {
  const serverPath = diskBudgetFixture(t, 'minecraft-core-snapshot-disk-rollback-');
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises: fsp,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });

  const snapshot = await snapshotServer(snapshotRequest(serverPath, {
    operationKind: 'rollback-restore-point'
  }));

  // A rollback starts with a fresh candidate: it copies the 124 retained
  // backup bytes and the 17-byte live history, then also retains the newly
  // created 120-byte safety restore. The selected restore payload has its own
  // management-plan budget and must not be charged here.
  assert.deepEqual({
    candidateBytes: snapshot.candidateBytes,
    restorePointBytes: snapshot.restorePointBytes,
    rollbackBytes: snapshot.rollbackBytes
  }, {
    candidateBytes: '261',
    restorePointBytes: '120',
    rollbackBytes: '0'
  });
});

test('disk-only excluded roots are still traversed for nested reparse safety', async t => {
  const serverPath = diskBudgetFixture(t, 'minecraft-core-snapshot-disk-reparse-');
  const unsafePath = path.resolve(serverPath, 'backups', 'restore-old.zip');
  const inspected = [];
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises: fsp,
    reparseInspector: {
      async isReparsePoint(candidate) {
        inspected.push(path.resolve(candidate));
        return path.resolve(candidate) === unsafePath;
      }
    },
    stateRepository: stateRepository()
  });

  await assert.rejects(
    snapshotServer(snapshotRequest(serverPath)),
    error => error?.code === 'PLAN_STALE'
  );
  assert.equal(inspected.includes(unsafePath), true);
});

test('existing-server snapshot awaits asynchronous traversal without invoking synchronous content APIs', async t => {
  const serverPath = fixture(t, 'minecraft-core-snapshot-async-');
  fs.mkdirSync(path.join(serverPath, 'world'));
  fs.writeFileSync(path.join(serverPath, 'server.properties'), 'level-name=custom_world\n');
  fs.writeFileSync(path.join(serverPath, 'world', 'level.dat'), 'world-sentinel');
  const syncCalls = [];
  let releaseTraversal;
  let announceTraversal;
  const traversalGate = new Promise(resolve => { releaseTraversal = resolve; });
  const traversalStarted = new Promise(resolve => { announceTraversal = resolve; });
  t.after(() => releaseTraversal());
  let firstReaddir = true;
  const fsPromises = {
    access: (...args) => fsp.access(...args),
    lstat: (...args) => fsp.lstat(...args),
    open: (...args) => fsp.open(...args),
    readFile: (...args) => fsp.readFile(...args),
    async readdir(...args) {
      if (firstReaddir) {
        firstReaddir = false;
        announceTraversal();
        await traversalGate;
      }
      return fsp.readdir(...args);
    }
  };
  const snapshotServer = createProductionServerSnapshot({
    fsApi: syncFilesystemThatRejectsContentIo(syncCalls),
    fsPromises,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });
  const outcome = snapshotServer(snapshotRequest(serverPath)).then(
    value => ({ status: 'resolved', value }),
    error => ({ status: 'rejected', error })
  );

  const first = await Promise.race([
    traversalStarted.then(() => 'async-traversal-started'),
    outcome.then(result => result.status),
    new Promise(resolve => setTimeout(() => resolve('timed-out'), 1_000))
  ]);
  assert.equal(first, 'async-traversal-started');
  assert.equal(await Promise.race([
    outcome.then(result => result.status),
    new Promise(resolve => setImmediate(() => resolve('pending')))
  ]), 'pending');

  releaseTraversal();
  const result = await outcome;
  assert.equal(result.status, 'resolved', result.error?.stack);
  assert.deepEqual(syncCalls, []);
  assert.deepEqual(result.value.liveSnapshot.worldDirectories, [
    'custom_world', 'world', 'world_nether', 'world_the_end'
  ]);
  const level = result.value.liveSnapshot.entries.find(entry => entry.path === 'world/level.dat');
  assert.equal(level.sha256, crypto.createHash('sha256').update('world-sentinel').digest('hex'));
});

test('existing-server snapshot cancels during asynchronous hashing and closes the open file', async t => {
  const serverPath = fixture(t, 'minecraft-core-snapshot-cancel-');
  const payloadPath = path.join(serverPath, 'payload.bin');
  fs.writeFileSync(payloadPath, Buffer.alloc(2 * 1024 * 1024, 0x5a));
  const controller = new AbortController();
  let releaseRead;
  let announceRead;
  let payloadHandleClosed = false;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const readStarted = new Promise(resolve => { announceRead = resolve; });
  t.after(() => releaseRead());
  const fsPromises = {
    access: (...args) => fsp.access(...args),
    lstat: (...args) => fsp.lstat(...args),
    readFile: (...args) => fsp.readFile(...args),
    readdir: (...args) => fsp.readdir(...args),
    async open(filePath, ...args) {
      const handle = await fsp.open(filePath, ...args);
      if (path.resolve(filePath) !== path.resolve(payloadPath)) return handle;
      let firstRead = true;
      return {
        stat: (...statArgs) => handle.stat(...statArgs),
        async read(...readArgs) {
          if (firstRead) {
            firstRead = false;
            announceRead();
            await readGate;
          }
          return handle.read(...readArgs);
        },
        async close() {
          payloadHandleClosed = true;
          return handle.close();
        }
      };
    }
  };
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });
  const outcome = snapshotServer(snapshotRequest(serverPath, { signal: controller.signal })).then(
    value => ({ status: 'resolved', value }),
    error => ({ status: 'rejected', error })
  );

  const first = await Promise.race([
    readStarted.then(() => 'async-read-started'),
    outcome.then(result => result.status),
    new Promise(resolve => setTimeout(() => resolve('timed-out'), 1_000))
  ]);
  assert.equal(first, 'async-read-started');
  controller.abort();
  releaseRead();

  const result = await outcome;
  assert.equal(result.status, 'rejected');
  assert.equal(result.error?.code, 'CANCELLED');
  assert.equal(payloadHandleClosed, true);
});

test('existing-server snapshot fails closed when a file changes while its asynchronous hash is read', async t => {
  const serverPath = fixture(t, 'minecraft-core-snapshot-race-');
  const payloadPath = path.join(serverPath, 'payload.bin');
  fs.writeFileSync(payloadPath, Buffer.alloc(2 * 1024 * 1024, 0x3c));
  let changed = false;
  const fsPromises = {
    access: (...args) => fsp.access(...args),
    lstat: (...args) => fsp.lstat(...args),
    readFile: (...args) => fsp.readFile(...args),
    readdir: (...args) => fsp.readdir(...args),
    async open(filePath, ...args) {
      const handle = await fsp.open(filePath, ...args);
      if (path.resolve(filePath) !== path.resolve(payloadPath)) return handle;
      return {
        stat: (...statArgs) => handle.stat(...statArgs),
        async read(...readArgs) {
          const result = await handle.read(...readArgs);
          if (!changed && result.bytesRead > 0) {
            changed = true;
            await fsp.appendFile(payloadPath, Buffer.from('changed-during-snapshot'));
          }
          return result;
        },
        close: () => handle.close()
      };
    }
  };
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });

  await assert.rejects(
    snapshotServer(snapshotRequest(serverPath)),
    error => error?.code === 'PLAN_STALE'
  );
  assert.equal(changed, true);
});

test('existing-server snapshot fails closed when directory membership changes during traversal', async t => {
  const serverPath = fixture(t, 'minecraft-core-snapshot-membership-race-');
  fs.writeFileSync(path.join(serverPath, 'payload.txt'), 'reviewed-payload');
  let rootStatCalls = 0;
  let membershipChanged = false;
  const fsPromises = {
    access: (...args) => fsp.access(...args),
    open: (...args) => fsp.open(...args),
    readdir: (...args) => fsp.readdir(...args),
    async lstat(candidate, ...args) {
      if (path.resolve(candidate) === path.resolve(serverPath)) {
        rootStatCalls += 1;
        if (rootStatCalls === 3) {
          await fsp.writeFile(path.join(serverPath, 'appeared-during-snapshot.txt'), 'late member');
          membershipChanged = true;
        }
      }
      return fsp.lstat(candidate, ...args);
    }
  };
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises,
    reparseInspector: { async isReparsePoint() { return false; } },
    stateRepository: stateRepository()
  });

  await assert.rejects(
    snapshotServer(snapshotRequest(serverPath)),
    error => error?.code === 'PLAN_STALE'
  );
  assert.equal(membershipChanged, true);
});

test('existing-server snapshot detects a later excluded-file identity change without opening excluded content', async t => {
  const serverPath = fixture(t, 'minecraft-core-snapshot-excluded-race-');
  const excludedPath = path.join(serverPath, 'backups', 'restore-old.zip');
  const laterPath = path.join(serverPath, 'z-marker.txt');
  writeSizedFile(excludedPath, 32, 0x31);
  fs.writeFileSync(laterPath, 'later traversal marker');
  let excludedChanged = false;
  const opened = [];
  const fsPromises = {
    access: (...args) => fsp.access(...args),
    lstat: (...args) => fsp.lstat(...args),
    readdir: (...args) => fsp.readdir(...args),
    async open(candidate, ...args) {
      opened.push(path.resolve(candidate));
      if (path.resolve(candidate) === path.resolve(excludedPath)) {
        throw new Error('excluded content must not be opened');
      }
      return fsp.open(candidate, ...args);
    }
  };
  const snapshotServer = createProductionServerSnapshot({
    fsApi: fs,
    fsPromises,
    reparseInspector: {
      async isReparsePoint(candidate) {
        if (!excludedChanged && path.resolve(candidate) === path.resolve(laterPath)) {
          await fsp.appendFile(excludedPath, Buffer.from('changed after excluded traversal'));
          excludedChanged = true;
        }
        return false;
      }
    },
    stateRepository: stateRepository()
  });

  await assert.rejects(
    snapshotServer(snapshotRequest(serverPath)),
    error => error?.code === 'PLAN_STALE'
  );
  assert.equal(excludedChanged, true);
  assert.equal(opened.includes(path.resolve(excludedPath)), false);
});
