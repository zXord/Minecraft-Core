const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const {
  ModpackStateRepository,
  createModpackStateObserver
} = require('../../electron/services/modpacks/state/modpack-state-repository.cjs');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const WINDOWS_PATHS = { skip: process.platform !== 'win32' && 'Windows drive-letter paths' };
const WRITE_METHODS = ['mkdirSync', 'writeFileSync', 'openSync', 'renameSync', 'rmSync', 'unlinkSync', 'symlinkSync'];

function errno(code) {
  return Object.assign(new Error(`${code}: injected`), { code });
}

// Reports the listed folders as directories and every other path as absent.
// Every write method throws, so a passing test also proves reads only.
function injectedFs(directories) {
  const calls = [];
  const lookup = (method, candidate) => {
    calls.push([method, candidate]);
    if (directories.includes(candidate)) return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
    throw errno('ENOENT');
  };
  const fsApi = { statSync: candidate => lookup('statSync', candidate), lstatSync: candidate => lookup('lstatSync', candidate) };
  for (const method of WRITE_METHODS) fsApi[method] = () => { throw new Error(`${method} must not run`); };
  return { calls, fsApi };
}

function refusingRepository() {
  const calls = [];
  const refuse = method => (...args) => {
    calls.push([method, ...args]);
    throw new Error('the strict repository must not be reached');
  };
  return { calls, read: refuse('read'), listHistory: refuse('listHistory') };
}

function strictFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-state-observer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const durableFs = createDurableFs({
    fsApi: fs,
    allowedRoots: [root],
    durableClient: {
      moveWriteThrough: fs.renameSync,
      replaceFileWriteThrough: fs.renameSync,
      flushDirectory() {},
      moveWriteThroughAsync: fs.promises.rename,
      replaceFileWriteThroughAsync: fs.promises.rename,
      async flushDirectoryAsync() {}
    }
  });
  const repository = new ModpackStateRepository({ fsApi: fs, durableFs, clock: () => new Date('2026-08-01T12:00:00.000Z') });
  const calls = [];
  const delegate = {
    read(serverPath) {
      calls.push(['read', serverPath]);
      return repository.read(serverPath);
    },
    listHistory(serverPath, options) {
      calls.push(['listHistory', serverPath, options]);
      return repository.listHistory(serverPath, options);
    }
  };
  return { root, repository, calls, observer: createModpackStateObserver({ repository: delegate, fsApi: fs }) };
}

function server(root, name) {
  const folder = path.join(root, ...name.split('/'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.minecraft-core.json'), '{"port":25565}\n');
  return folder;
}

function historyEntry(sequence) {
  return {
    schemaVersion: 1,
    operationId: `operation-${sequence}`,
    sequence,
    kind: 'upgrade',
    outcome: 'completed',
    timestamp: '2026-08-01T12:00:00.000Z',
    sourceRevision: sequence,
    targetRevision: sequence + 1
  };
}

test('a server directly under a drive root without state reads as unmanaged without the strict repository', WINDOWS_PATHS, () => {
  const { calls, fsApi } = injectedFs(['X:\\MinecraftServer']);
  const repository = refusingRepository();
  const observer = createModpackStateObserver({ repository, fsApi });

  assert.equal(observer.read('X:\\MinecraftServer'), null);
  const page = observer.listHistory('X:\\MinecraftServer');
  assert.deepEqual(page, { items: [], nextCursor: null });
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.items), true);
  assert.deepEqual(observer.listHistory('X:\\MinecraftServer', { cursor: null, limit: 200 }), { items: [], nextCursor: null });

  assert.deepEqual(repository.calls, []);
  assert.deepEqual(calls.filter(([method]) => method === 'lstatSync').map(([, candidate]) => candidate), [
    'X:\\MinecraftServer\\.minecraft-core-state\\modpack.json',
    'X:\\MinecraftServer\\.minecraft-core-state\\history',
    'X:\\MinecraftServer\\.minecraft-core-state\\history'
  ]);
  assert.ok(calls.every(([method]) => method === 'statSync' || method === 'lstatSync'));
});

test('a drive root itself without state reads as unmanaged', WINDOWS_PATHS, () => {
  const { fsApi } = injectedFs(['X:\\']);
  const repository = refusingRepository();
  const observer = createModpackStateObserver({ repository, fsApi });

  assert.equal(observer.read('X:\\'), null);
  assert.deepEqual(observer.listHistory('X:\\'), { items: [], nextCursor: null });
  assert.deepEqual(repository.calls, []);
});

test('history paging rules match the repository when no history exists', WINDOWS_PATHS, () => {
  const { fsApi } = injectedFs(['X:\\MinecraftServer']);
  const repository = refusingRepository();
  const observer = createModpackStateObserver({ repository, fsApi });

  assert.throws(() => observer.listHistory('X:\\MinecraftServer', { cursor: 'eyJ2IjoxfQ.forged' }),
    error => error.code === 'INVALID_REQUEST' && error.details?.field === 'cursor');
  for (const limit of [0, 201, 1.5, '50']) {
    assert.throws(() => observer.listHistory('X:\\MinecraftServer', { limit }),
      error => error.code === 'INVALID_REQUEST' && error.details?.field === 'limit', String(limit));
  }
  assert.deepEqual(repository.calls, []);
});

test('malformed server paths are refused like the repository before any probe', (t) => {
  const { root, repository, calls, observer } = strictFixture(t);
  const folder = server(root, 'Server');
  fs.mkdirSync(path.join(root, 'elsewhere'));
  const inputs = [
    `${root}${path.sep}elsewhere${path.sep}..${path.sep}Server`,
    `${root}${path.sep}.${path.sep}Server`,
    `${folder}${path.sep}..`,
    'Server',
    `${folder}\0`,
    '',
    42,
    null
  ];
  const refused = error => error.code === 'INVALID_REQUEST' && error.details?.field === 'serverPath';

  assert.equal(observer.read(folder), null);
  for (const value of inputs) {
    assert.throws(() => repository.read(value), refused, String(value));
    assert.throws(() => observer.read(value), refused, String(value));
    assert.throws(() => repository.listHistory(value, { limit: 0 }), refused, String(value));
    assert.throws(() => observer.listHistory(value, { limit: 0 }), refused, String(value));
  }
  assert.deepEqual(calls, []);

  const probes = injectedFs(['X:\\MinecraftServer']);
  const refusing = refusingRepository();
  const injected = createModpackStateObserver({ repository: refusing, fsApi: probes.fsApi });
  assert.throws(() => injected.read('X:\\Other\\..\\MinecraftServer'), refused);
  assert.throws(() => injected.listHistory('X:\\Other\\..\\MinecraftServer'), refused);
  assert.deepEqual(probes.calls, []);
  assert.deepEqual(refusing.calls, []);
});

test('a server reached through a junction reads as unmanaged while the strict repository still refuses it', (t) => {
  const { root, repository, calls, observer } = strictFixture(t);
  const real = server(root, 'real/Server');
  const parentLink = path.join(root, 'linked-parent');
  const leafLink = path.join(root, 'linked-leaf');
  fs.symlinkSync(path.dirname(real), parentLink, LINK_TYPE);
  fs.symlinkSync(real, leafLink, LINK_TYPE);

  for (const alias of [path.join(parentLink, 'Server'), leafLink]) {
    assert.throws(() => repository.read(alias), error => error.code === 'INVALID_REQUEST', alias);
    assert.equal(observer.read(alias), null, alias);
    assert.deepEqual(observer.listHistory(alias), { items: [], nextCursor: null }, alias);
  }
  assert.deepEqual(calls, []);
});

test('loader runtime metadata alone is not modpack state', (t) => {
  const { root, calls, observer } = strictFixture(t);
  const folder = server(root, 'RuntimeOnly');
  fs.mkdirSync(path.join(folder, '.minecraft-core-state'));
  fs.writeFileSync(path.join(folder, '.minecraft-core-state', 'runtime.json'), '{"loader":"neoforge"}\n');

  assert.equal(observer.read(folder), null);
  assert.deepEqual(observer.listHistory(folder), { items: [], nextCursor: null });
  assert.deepEqual(calls, []);
});

test('present, corrupt or unprovable state delegates to the strict repository and still fails closed', (t) => {
  const { root, calls, observer, repository } = strictFixture(t);
  const real = server(root, 'real/Server');
  fs.mkdirSync(path.join(real, '.minecraft-core-state'));
  fs.writeFileSync(path.join(real, '.minecraft-core-state', 'modpack.json'), '{}\n');
  const parentLink = path.join(root, 'linked-parent');
  fs.symlinkSync(path.dirname(real), parentLink, LINK_TYPE);
  const aliased = path.join(parentLink, 'Server');

  const corrupt = server(root, 'Corrupt');
  fs.mkdirSync(path.join(corrupt, '.minecraft-core-state'));
  fs.writeFileSync(path.join(corrupt, '.minecraft-core-state', 'modpack.json'), '{bad');
  const missing = path.join(root, 'Missing');

  for (const folder of [aliased, corrupt, missing]) {
    calls.length = 0;
    assert.throws(() => observer.read(folder), error => error.code === 'INVALID_REQUEST', folder);
    assert.deepEqual(calls, [['read', folder]], folder);
  }

  const historyAlias = server(root, 'history-real/Server');
  repository.appendHistory(historyAlias, historyEntry(1));
  const historyLink = path.join(root, 'history-link');
  fs.symlinkSync(path.dirname(historyAlias), historyLink, LINK_TYPE);
  calls.length = 0;
  assert.throws(() => observer.listHistory(path.join(historyLink, 'Server')), error => error.code === 'INVALID_REQUEST');
  assert.equal(calls.length, 1);
  assert.throws(() => observer.listHistory(missing), error => error.code === 'INVALID_REQUEST');
});

test('recorded history delegates to the strict repository with the same paging', (t) => {
  const { root, calls, observer, repository } = strictFixture(t);
  const folder = server(root, 'Managed');
  for (let sequence = 1; sequence <= 3; sequence += 1) repository.appendHistory(folder, historyEntry(sequence));

  const first = observer.listHistory(folder, { limit: 2 });
  assert.deepEqual(first.items.map(item => item.sequence), [3, 2]);
  assert.deepEqual(first, repository.listHistory(folder, { limit: 2 }));
  const second = observer.listHistory(folder, { cursor: first.nextCursor, limit: 2 });
  assert.deepEqual(second.items.map(item => item.sequence), [1]);
  assert.deepEqual(calls.map(([method, , options]) => [method, options]), [
    ['listHistory', { cursor: null, limit: 2 }],
    ['listHistory', { cursor: first.nextCursor, limit: 2 }]
  ]);
  assert.equal(observer.read(folder), null, 'history without modpack.json is not an installed pack');
});

test('the observer is frozen and requires a readable repository and filesystem', () => {
  const observer = createModpackStateObserver({ repository: refusingRepository(), fsApi: fs });
  assert.equal(Object.isFrozen(observer), true);
  assert.deepEqual(Object.keys(observer).sort(), ['listHistory', 'read']);
  for (const options of [undefined, {}, { repository: { read() {} } }]) {
    assert.throws(() => createModpackStateObserver(options),
      error => error.code === 'INVALID_REQUEST' && error.details?.field === 'repository');
  }
  for (const fsApi of [null, {}, { statSync() {} }]) {
    assert.throws(() => createModpackStateObserver({ repository: refusingRepository(), fsApi }),
      error => error.code === 'INVALID_REQUEST' && error.details?.field === 'fsApi');
  }
});
