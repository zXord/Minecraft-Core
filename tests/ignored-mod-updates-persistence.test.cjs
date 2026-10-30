const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadModFileManager(userDataPath) {
  const originalLoad = Module._load;
  Module._load = function loadIgnoredUpdatesFixture(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => userDataPath } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve('../electron/ipc/mod-utils/mod-file-manager.cjs');
  delete require.cache[modulePath];
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function makeServer(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-core-ignored-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'minecraft-core-configs');
  return {
    root,
    configDirectory,
    ignoredPath: path.join(configDirectory, 'ignored-mod-updates.json'),
    manager: loadModFileManager(path.join(root, 'user-data'))
  };
}

function writeIgnoredFile(server, content) {
  fs.mkdirSync(server.configDirectory, { recursive: true });
  fs.writeFileSync(server.ignoredPath, content);
}

function configEntries(server) {
  return fs.readdirSync(server.configDirectory).sort();
}

function setAsideEntries(server) {
  return configEntries(server).filter(name => name.startsWith('ignored-mod-updates.json.unreadable-'));
}

// Replaces one fs/promises method for a single test; the manager looks the
// method up on every call.
function replaceFsMethod(t, name, implementation) {
  const original = fsPromises[name];
  fsPromises[name] = function replacedFsMethod(...args) {
    return implementation.call(this, original, ...args);
  };
  const restore = () => { fsPromises[name] = original; };
  t.after(restore);
  return restore;
}

function fsError(code) {
  return Object.assign(new Error(`${code}: simulated failure`), { code });
}

const UNREADABLE_CONTENT = Object.freeze({
  empty: '',
  whitespace: ' \r\n\t',
  truncated: '{"A.jar":{"ids":["a-1"],"vers":["1.0"]},"B.jar":{"ids":["b',
  nulFilled: '\0\0\0\0\0\0\0\0',
  array: '[]',
  nullJson: 'null',
  stringJson: '"x"',
  numberJson: '42'
});
const TRUNCATED = UNREADABLE_CONTENT.truncated;
const UTF8_BOM = String.fromCharCode(0xFEFF);

test('loading a missing ignored-update file reports that no persisted data exists', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manager = loadModFileManager(path.join(root, 'user-data'));
  const result = await manager.getIgnoredModUpdates(root);

  assert.deepEqual(result, { found: false, data: {} });
});

test('loading a valid ignored-update file reports its persisted data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-load-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'minecraft-core-configs');
  fs.mkdirSync(configDirectory);
  fs.writeFileSync(
    path.join(configDirectory, 'ignored-mod-updates.json'),
    '{"Example.jar":{"ids":["version-one"],"vers":["1.0"]}}'
  );

  const manager = loadModFileManager(path.join(root, 'user-data'));
  const result = await manager.getIgnoredModUpdates(root);

  assert.deepEqual(result, {
    found: true,
    data: { 'Example.jar': { ids: ['version-one'], vers: ['1.0'] } }
  });
});

test('loading malformed ignored-update JSON reports unreadable empty data and leaves the file untouched', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-malformed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'minecraft-core-configs');
  fs.mkdirSync(configDirectory);
  fs.writeFileSync(path.join(configDirectory, 'ignored-mod-updates.json'), '{"broken":');

  const manager = loadModFileManager(path.join(root, 'user-data'));

  assert.deepEqual(await manager.getIgnoredModUpdates(root), { found: false, data: {}, unreadable: true });
  assert.equal(fs.readFileSync(path.join(configDirectory, 'ignored-mod-updates.json'), 'utf8'), '{"broken":');
  assert.deepEqual(fs.readdirSync(configDirectory), ['ignored-mod-updates.json']);
});

test('loading an unreadable ignored-update path surfaces the I/O failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-read-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ignoredPath = path.join(root, 'minecraft-core-configs', 'ignored-mod-updates.json');
  fs.mkdirSync(ignoredPath, { recursive: true });

  const manager = loadModFileManager(path.join(root, 'user-data'));

  await assert.rejects(manager.getIgnoredModUpdates(root));
});

test('saving semantically unchanged ignored updates leaves the file untouched', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-noop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'minecraft-core-configs');
  const ignoredPath = path.join(configDirectory, 'ignored-mod-updates.json');
  fs.mkdirSync(configDirectory);
  fs.writeFileSync(ignoredPath, '{"Example.jar":{"vers":["1.0"],"ids":["version-one"]}}');
  const oldTime = new Date('2020-01-02T03:04:05.000Z');
  fs.utimesSync(ignoredPath, oldTime, oldTime);

  const manager = loadModFileManager(path.join(root, 'user-data'));
  const changed = await manager.saveIgnoredModUpdates(root, {
    'Example.jar': { ids: ['version-one'], vers: ['1.0'] }
  });

  assert.equal(changed, false);
  assert.equal(fs.statSync(ignoredPath).mtimeMs, oldTime.getTime());
  assert.equal(
    fs.readFileSync(ignoredPath, 'utf8'),
    '{"Example.jar":{"vers":["1.0"],"ids":["version-one"]}}'
  );
});

test('ignored-update persistence surfaces a failed file write', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-write-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'minecraft-core-configs');
  fs.mkdirSync(configDirectory);
  fs.mkdirSync(path.join(configDirectory, 'ignored-mod-updates.json'));

  const manager = loadModFileManager(path.join(root, 'user-data'));
  await assert.rejects(
    manager.saveIgnoredModUpdates(root, {
      'Example.jar': { ids: ['version-one'], vers: ['1.0'] }
    })
  );
});

test('saving an empty ignored-update set does not create a missing preference file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ignoredPath = path.join(root, 'minecraft-core-configs', 'ignored-mod-updates.json');

  const manager = loadModFileManager(path.join(root, 'user-data'));
  const changed = await manager.saveIgnoredModUpdates(root, {});

  assert.equal(changed, false);
  assert.equal(fs.existsSync(ignoredPath), false);
});

for (const [label, content] of Object.entries(UNREADABLE_CONTENT)) {
  test(`R6: ${label} ignored-update content reads as unreadable empty data and is left untouched`, async (t) => {
    const server = makeServer(t, `unreadable-${label}`);
    writeIgnoredFile(server, content);

    assert.deepEqual(
      await server.manager.getIgnoredModUpdates(server.root),
      { found: false, data: {}, unreadable: true }
    );
    assert.equal(fs.readFileSync(server.ignoredPath, 'utf8'), content);
    assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
  });
}

test('R6: a UTF-8 BOM before valid JSON is the stored data, and an equal save keeps the file as it is', async (t) => {
  const server = makeServer(t, 'bom');
  const content = `${UTF8_BOM}{"Kept.jar":{"ids":["k-1"],"vers":["1.0"]}}`;
  writeIgnoredFile(server, content);

  assert.deepEqual(await server.manager.getIgnoredModUpdates(server.root), {
    found: true,
    data: { 'Kept.jar': { ids: ['k-1'], vers: ['1.0'] } }
  });
  assert.equal(
    await server.manager.saveIgnoredModUpdates(server.root, { 'Kept.jar': { ids: ['k-1'], vers: ['1.0'] } }),
    false
  );
  assert.equal(fs.readFileSync(server.ignoredPath, 'utf8'), content);
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
});

test('R6: saving over unreadable content sets the old bytes aside and publishes canonical JSON', async (t) => {
  const server = makeServer(t, 'set-aside');
  writeIgnoredFile(server, TRUNCATED);

  assert.equal(
    await server.manager.saveIgnoredModUpdates(server.root, { 'X.jar': { vers: [], ids: ['x-1'] } }),
    true
  );

  assert.equal(
    fs.readFileSync(server.ignoredPath, 'utf8'),
    JSON.stringify({ 'X.jar': { ids: ['x-1'], vers: [] } }, null, 2)
  );
  const setAside = setAsideEntries(server);
  assert.equal(setAside.length, 1);
  assert.match(
    setAside[0],
    /^ignored-mod-updates\.json\.unreadable-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/
  );
  assert.equal(fs.readFileSync(path.join(server.configDirectory, setAside[0]), 'utf8'), TRUNCATED);
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json', setAside[0]].sort());
});

for (const [label, content] of Object.entries({
  empty: '',
  whitespace: ' \r\n\t',
  nulFilled: '\0\0\0\0\0\0',
  bomOnly: UTF8_BOM
})) {
  test(`R6: blank (${label}) content is replaced without leaving a set-aside copy`, async (t) => {
    const server = makeServer(t, `blank-${label}`);
    writeIgnoredFile(server, content);

    assert.equal(
      await server.manager.saveIgnoredModUpdates(server.root, { 'X.jar': { ids: ['x-1'], vers: [] } }),
      true
    );

    assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
    assert.deepEqual(await server.manager.getIgnoredModUpdates(server.root), {
      found: true,
      data: { 'X.jar': { ids: ['x-1'], vers: [] } }
    });
  });
}

test('R6: an empty set replaces blank content with a clean empty file', async (t) => {
  const server = makeServer(t, 'blank-empty-set');
  writeIgnoredFile(server, '');

  assert.equal(await server.manager.saveIgnoredModUpdates(server.root, {}), true);

  assert.equal(fs.readFileSync(server.ignoredPath, 'utf8'), '{}');
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
  assert.deepEqual(await server.manager.getIgnoredModUpdates(server.root), { found: true, data: {} });
});

test('R6: a failed publish keeps the previous file byte-identical and leaves no temporary file', async (t) => {
  const server = makeServer(t, 'publish-failure');
  const previous = '{"Old.jar":{"ids":["o-1"],"vers":[]}}';
  writeIgnoredFile(server, previous);
  // Fail every publish step that an in-place or a temp-and-rename writer could use.
  const restoreRename = replaceFsMethod(t, 'rename', async () => {
    throw fsError('EPERM');
  });
  const restoreWriteFile = replaceFsMethod(t, 'writeFile', async function (original, target, ...rest) {
    if (path.resolve(String(target)) === server.ignoredPath) {
      await original.call(this, target, '');
      throw fsError('ENOSPC');
    }
    return original.call(this, target, ...rest);
  });

  await assert.rejects(
    server.manager.saveIgnoredModUpdates(server.root, { 'New.jar': { ids: ['n-1'], vers: [] } })
  );
  restoreRename();
  restoreWriteFile();

  assert.equal(fs.readFileSync(server.ignoredPath, 'utf8'), previous);
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
});

test('R6: a failed temporary write leaves unreadable bytes in place instead of setting them aside', async (t) => {
  const server = makeServer(t, 'temporary-write-failure');
  writeIgnoredFile(server, TRUNCATED);
  const restoreOpen = replaceFsMethod(t, 'open', async function (original, target, ...rest) {
    if (path.dirname(path.resolve(String(target))) === server.configDirectory) throw fsError('ENOSPC');
    return original.call(this, target, ...rest);
  });

  await assert.rejects(
    server.manager.saveIgnoredModUpdates(server.root, { 'New.jar': { ids: ['n-1'], vers: [] } }),
    error => error?.code === 'ENOSPC'
  );
  restoreOpen();

  assert.equal(fs.readFileSync(server.ignoredPath, 'utf8'), TRUNCATED);
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
});

test('R6: a briefly locked target is retried and the save lands', async (t) => {
  const server = makeServer(t, 'publish-retry');
  writeIgnoredFile(server, '{}');
  let failures = 2;
  replaceFsMethod(t, 'rename', async function (original, ...args) {
    if (failures > 0) {
      failures -= 1;
      throw fsError('EBUSY');
    }
    return original.apply(this, args);
  });

  assert.equal(
    await server.manager.saveIgnoredModUpdates(server.root, { 'X.jar': { ids: ['x-1'], vers: [] } }),
    true
  );

  assert.equal(failures, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(server.ignoredPath, 'utf8')), { 'X.jar': { ids: ['x-1'], vers: [] } });
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
});

test('R6: a target that stays locked fails after a short retry budget and keeps the file', async (t) => {
  const server = makeServer(t, 'publish-locked');
  writeIgnoredFile(server, '{}');
  let attempts = 0;
  const restoreRename = replaceFsMethod(t, 'rename', async () => {
    attempts += 1;
    throw fsError('EBUSY');
  });

  const started = Date.now();
  await assert.rejects(
    server.manager.saveIgnoredModUpdates(server.root, { 'X.jar': { ids: ['x-1'], vers: [] } }),
    error => error?.code === 'EBUSY'
  );
  const elapsed = Date.now() - started;
  restoreRename();

  // The save runs inside the server's mutation reservation, so it retries at
  // most three times before giving the reservation back.
  assert.ok(attempts > 1 && attempts <= 4, `rename attempts: ${attempts}`);
  assert.ok(elapsed < 1000, `retry wait: ${elapsed} ms`);
  assert.equal(fs.readFileSync(server.ignoredPath, 'utf8'), '{}');
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
});

test('R16: saving ignored updates never recreates a missing server folder', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-gone-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const gone = path.join(parent, 'gone-server');
  const manager = loadModFileManager(path.join(parent, 'user-data'));

  await assert.rejects(
    manager.saveIgnoredModUpdates(gone, { 'A.jar': { ids: ['a-2'], vers: ['2.0'] } }),
    error => error?.code === 'ENOENT'
  );
  assert.equal(fs.existsSync(gone), false);
  // A missing server folder is not "nothing stored", and reading it creates nothing.
  assert.deepEqual(await manager.getIgnoredModUpdates(gone), { found: false, data: {}, rootMissing: true });
  assert.equal(fs.existsSync(gone), false);
});

test('R16: an empty set for a missing server folder fails instead of reporting no change', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-gone-empty-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const gone = path.join(parent, 'gone-server');
  const manager = loadModFileManager(path.join(parent, 'user-data'));

  await assert.rejects(manager.saveIgnoredModUpdates(gone, {}), error => error?.code === 'ENOENT');
  assert.equal(fs.existsSync(gone), false);
});

test('R16: an existing server folder without a config folder still gets one', async (t) => {
  const server = makeServer(t, 'first-save');

  assert.equal(
    await server.manager.saveIgnoredModUpdates(server.root, { 'A.jar': { ids: ['a-1'], vers: [] } }),
    true
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(server.ignoredPath, 'utf8')), { 'A.jar': { ids: ['a-1'], vers: [] } });
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
});

test('R16: a server path that is a file is never turned into a folder', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-root-file-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const serverPath = path.join(parent, 'server');
  fs.writeFileSync(serverPath, 'not a folder');
  const manager = loadModFileManager(path.join(parent, 'user-data'));

  await assert.rejects(
    manager.saveIgnoredModUpdates(serverPath, { 'A.jar': { ids: ['a-1'], vers: [] } }),
    error => error?.code === 'ENOTDIR'
  );
  assert.deepEqual(await manager.getIgnoredModUpdates(serverPath), { found: false, data: {}, rootMissing: true });
  assert.equal(fs.statSync(serverPath).isFile(), true);
  assert.equal(fs.readFileSync(serverPath, 'utf8'), 'not a folder');
});

test('R16: a server folder that cannot be inspected keeps the read and the save failures', async (t) => {
  const server = makeServer(t, 'root-stat-failure');
  replaceFsMethod(t, 'stat', async function (original, target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(server.root)) throw fsError('EACCES');
    return original.call(this, target, ...rest);
  });

  await assert.rejects(server.manager.getIgnoredModUpdates(server.root), error => error?.code === 'EACCES');
  await assert.rejects(
    server.manager.saveIgnoredModUpdates(server.root, { 'A.jar': { ids: ['a-1'], vers: [] } }),
    error => error?.code === 'EACCES'
  );
  assert.equal(fs.existsSync(server.configDirectory), false);
});

test('a replace-only-unreadable save refuses to overwrite a readable file that differs', async (t) => {
  const server = makeServer(t, 'replace-only-readable');
  const current = '{"Restored.jar":{"ids":["r-1"],"vers":[]}}';
  writeIgnoredFile(server, current);

  await assert.rejects(
    server.manager.saveIgnoredModUpdates(
      server.root,
      { 'X.jar': { ids: ['x-1'], vers: [] } },
      { replaceOnlyUnreadable: true }
    ),
    error => error?.code === 'IGNORED_UPDATES_CHANGED'
  );

  assert.equal(fs.readFileSync(server.ignoredPath, 'utf8'), current);
  assert.deepEqual(configEntries(server), ['ignored-mod-updates.json']);
});

test('a replace-only-unreadable save replaces missing or unreadable content and skips an equal file', async (t) => {
  const snapshot = { 'X.jar': { ids: ['x-1'], vers: [] } };
  const options = { replaceOnlyUnreadable: true };

  const missing = makeServer(t, 'replace-only-missing');
  assert.equal(await missing.manager.saveIgnoredModUpdates(missing.root, snapshot, options), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(missing.ignoredPath, 'utf8')), snapshot);

  const unreadable = makeServer(t, 'replace-only-unreadable');
  writeIgnoredFile(unreadable, TRUNCATED);
  assert.equal(await unreadable.manager.saveIgnoredModUpdates(unreadable.root, snapshot, options), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(unreadable.ignoredPath, 'utf8')), snapshot);
  const setAside = setAsideEntries(unreadable);
  assert.equal(setAside.length, 1);
  assert.equal(fs.readFileSync(path.join(unreadable.configDirectory, setAside[0]), 'utf8'), TRUNCATED);

  const equal = makeServer(t, 'replace-only-equal');
  writeIgnoredFile(equal, '{"X.jar":{"vers":[],"ids":["x-1"]}}');
  assert.equal(await equal.manager.saveIgnoredModUpdates(equal.root, snapshot, options), false);
  assert.equal(fs.readFileSync(equal.ignoredPath, 'utf8'), '{"X.jar":{"vers":[],"ids":["x-1"]}}');
});
