const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { withBackupMutationLock } = require('../electron/services/backup-mutation-lock.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-backup-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realParent = path.join(root, 'real-parent');
  const serverPath = path.join(realParent, 'server');
  fs.mkdirSync(serverPath, { recursive: true });
  return { root, realParent, serverPath };
}

function directoryAlias(t, target, alias) {
  try {
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    t.skip(`directory aliases are unavailable on this host: ${error.code}`);
    return false;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function realpathFailure() {
  return Object.assign(new Error('EISDIR: illegal operation on a directory, realpath'), { code: 'EISDIR' });
}

// Some RAM disks and virtual drives cannot report a final path, and libuv then
// fails native realpath with EISDIR for a directory that exists.
function failNativeRealpath(t) {
  return t.mock.method(fs.realpathSync, 'native', () => { throw realpathFailure(); });
}

async function assertSharesOneLock(serverPath, spellings) {
  const events = [];
  const releaseHolder = deferred();
  const holder = withBackupMutationLock(serverPath, async () => {
    events.push('holder-start');
    await releaseHolder.promise;
    events.push('holder-end');
  });
  const waiters = spellings.map((spelling, index) => withBackupMutationLock(spelling, async () => {
    events.push(`alias-${index}`);
  }));
  for (let tick = 0; tick < 5; tick += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['holder-start']);

  releaseHolder.resolve();
  await Promise.all([holder, ...waiters]);
  assert.deepEqual(events, ['holder-start', 'holder-end', ...spellings.map((_, index) => `alias-${index}`)]);
}

test('a server folder that is itself a junction takes the backup lock', async (t) => {
  const { root, serverPath } = fixture(t);
  const serverJunction = path.join(root, 'server-junction');
  if (!directoryAlias(t, serverPath, serverJunction)) return;

  assert.equal(await withBackupMutationLock(serverJunction, async () => 'locked'), 'locked');
});

test('a server folder below a junctioned ancestor takes the backup lock', async (t) => {
  const { root, realParent } = fixture(t);
  const parentJunction = path.join(root, 'parent-junction');
  if (!directoryAlias(t, realParent, parentJunction)) return;

  assert.equal(await withBackupMutationLock(path.join(parentJunction, 'server'), async () => 'locked'), 'locked');
});

test('every spelling of one folder serialises on one lock', async (t) => {
  const { root, realParent, serverPath } = fixture(t);
  const serverJunction = path.join(root, 'server-junction');
  const parentJunction = path.join(root, 'parent-junction');
  if (!directoryAlias(t, serverPath, serverJunction) || !directoryAlias(t, realParent, parentJunction)) return;
  const spellings = [
    serverJunction,
    path.join(parentJunction, 'server'),
    process.platform === 'win32' ? serverPath.toUpperCase() : `${serverPath}${path.sep}`
  ];

  const events = [];
  const releaseHolder = deferred();
  const holder = withBackupMutationLock(serverPath, async () => {
    events.push('holder-start');
    await releaseHolder.promise;
    events.push('holder-end');
  });
  const waiters = spellings.map((spelling, index) => withBackupMutationLock(spelling, async () => {
    events.push(`alias-${index}`);
  }));
  for (let tick = 0; tick < 5; tick += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['holder-start']);

  releaseHolder.resolve();
  await Promise.all([holder, ...waiters]);
  assert.deepEqual(events, ['holder-start', 'holder-end', 'alias-0', 'alias-1', 'alias-2']);
});

test('different folders do not wait for each other', async (t) => {
  const { root, serverPath } = fixture(t);
  const otherServer = path.join(root, 'other-server');
  fs.mkdirSync(otherServer);
  const releaseHolder = deferred();
  const holder = withBackupMutationLock(serverPath, () => releaseHolder.promise);

  assert.equal(await withBackupMutationLock(otherServer, async () => 'independent'), 'independent');
  releaseHolder.resolve();
  await holder;
});

test('a missing folder, a file and a relative path are refused before the operation runs', async (t) => {
  const { root, serverPath } = fixture(t);
  const filePath = path.join(root, 'not-a-folder.txt');
  fs.writeFileSync(filePath, 'file');
  let ran = false;
  const operation = async () => { ran = true; };

  await assert.rejects(withBackupMutationLock(path.join(root, 'missing-server'), operation));
  await assert.rejects(withBackupMutationLock(filePath, operation));
  await assert.rejects(withBackupMutationLock('relative-server', operation), TypeError);
  await assert.rejects(withBackupMutationLock(`${serverPath}\0`, operation), TypeError);
  await assert.rejects(withBackupMutationLock(serverPath, null), TypeError);
  assert.equal(ran, false);
});

test('a server folder takes the backup lock where native realpath fails', async (t) => {
  const { serverPath } = fixture(t);
  const nativeRealpath = failNativeRealpath(t);
  let ran = false;

  assert.equal(await withBackupMutationLock(serverPath, async () => {
    ran = true;
    return 'locked';
  }), 'locked');
  assert.equal(ran, true);
  assert.ok(nativeRealpath.mock.callCount() > 0);
});

test('where native realpath fails, junction aliases and letter case still share one lock', async (t) => {
  const { root, realParent, serverPath } = fixture(t);
  const serverJunction = path.join(root, 'server-junction');
  const parentJunction = path.join(root, 'parent-junction');
  if (!directoryAlias(t, serverPath, serverJunction) || !directoryAlias(t, realParent, parentJunction)) return;
  failNativeRealpath(t);

  await assertSharesOneLock(serverPath, [
    serverJunction,
    path.join(parentJunction, 'server'),
    process.platform === 'win32' ? serverPath.toUpperCase() : `${serverPath}${path.sep}`
  ]);
});

test('where native realpath fails, a missing folder and a file are still refused before the operation runs', async (t) => {
  const { root } = fixture(t);
  const filePath = path.join(root, 'not-a-folder.txt');
  fs.writeFileSync(filePath, 'file');
  failNativeRealpath(t);
  let ran = false;
  const operation = async () => { ran = true; };

  await assert.rejects(withBackupMutationLock(path.join(root, 'missing-server'), operation), { code: 'ENOENT' });
  await assert.rejects(withBackupMutationLock(filePath, operation), TypeError);
  assert.equal(ran, false);
});

test('where no realpath works, an existing folder locks by its resolved path', async (t) => {
  const { serverPath } = fixture(t);
  failNativeRealpath(t);
  const jsRealpath = t.mock.method(fs, 'realpathSync', () => { throw realpathFailure(); });

  await assertSharesOneLock(serverPath, [
    process.platform === 'win32' ? serverPath.toUpperCase() : `${serverPath}${path.sep}`
  ]);
  assert.ok(jsRealpath.mock.callCount() > 0);
});
