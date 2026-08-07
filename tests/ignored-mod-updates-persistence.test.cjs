const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('loading malformed ignored-update JSON surfaces the parse failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ignored-malformed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'minecraft-core-configs');
  fs.mkdirSync(configDirectory);
  fs.writeFileSync(path.join(configDirectory, 'ignored-mod-updates.json'), '{"broken":');

  const manager = loadModFileManager(path.join(root, 'user-data'));

  await assert.rejects(manager.getIgnoredModUpdates(root), SyntaxError);
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
