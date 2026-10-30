const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '../electron/services/modpacks/instance-ownership.cjs');
const {
  CLIENT_PACK_MANIFEST,
  EVIDENCE_ENTRIES_BY_KIND,
  SERVER_EVIDENCE_ENTRIES,
  SERVER_STATE_DIRECTORY,
  inspectFolderEvidence,
  proveEntriesAbsent,
  proveEntriesAbsentAsync
} = require(MODULE_PATH);

const UNMANAGED = Object.freeze({ state: 'unmanaged', evidence: [], errorCode: null });
const SERVER_EVIDENCE = [
  '.minecraft-core-state/modpack.json',
  '.minecraft-core-state/manifests',
  '.minecraft-core-state/operations',
  '.minecraft-core-state/history'
];
const ALL_EVIDENCE = [...SERVER_EVIDENCE, '.minecraft-core-client-pack.json'];
const STATE_FILE = ['.minecraft-core-state/modpack.json'];
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const FAKE_FOLDER = process.platform === 'win32' ? 'X:\\Servers\\Injected' : '/srv/servers/injected';
const SPAWN_METHODS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const WRITE_METHODS = ['appendFile', 'chmod', 'copyFile', 'cp', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir',
  'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'];

function lifecycle(evidence) {
  return { state: 'lifecycle', evidence, errorCode: null };
}

function unknown(errorCode) {
  return { state: 'unknown', evidence: [], errorCode };
}

function errno(code) {
  return Object.assign(new Error(`${code}: injected failure`), { code });
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-ownership-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeFolder(root, name) {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function place(folder, relativeEntry, type = 'file') {
  const target = path.join(folder, ...relativeEntry.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (type === 'directory') fs.mkdirSync(target);
  else fs.writeFileSync(target, '{}\n');
  return target;
}

function fakeFs(entries) {
  const calls = [];
  const lookup = (method, candidate) => {
    calls.push([method, candidate]);
    const value = entries.get(candidate);
    if (value instanceof Error) throw value;
    if (value === undefined) throw errno('ENOENT');
    return { isDirectory: () => value === 'directory', isFile: () => value === 'file', isSymbolicLink: () => false };
  };
  return {
    calls,
    fsApi: { statSync: candidate => lookup('statSync', candidate), lstatSync: candidate => lookup('lstatSync', candidate) },
    fsPromises: { stat: async candidate => lookup('stat', candidate), lstat: async candidate => lookup('lstat', candidate) }
  };
}

function recordingFs(base) {
  const calls = [];
  const api = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args) => {
        calls.push([property, args[0]]);
        return value.apply(target, args);
      };
    }
  });
  return { api, calls };
}

function spyOnSideEffects(t) {
  const effects = [];
  const refuse = label => () => {
    effects.push(label);
    throw new Error(`${label} is not allowed here`);
  };
  for (const name of SPAWN_METHODS) t.mock.method(childProcess, name, refuse(`child_process.${name}`));
  for (const name of WRITE_METHODS) {
    t.mock.method(fs, name, refuse(`fs.${name}`));
    t.mock.method(fs, `${name}Sync`, refuse(`fs.${name}Sync`));
    t.mock.method(fs.promises, name, refuse(`fs.promises.${name}`));
  }
  t.mock.method(fs, 'createWriteStream', refuse('fs.createWriteStream'));
  return effects;
}

async function assertAbsenceProof(folder, entries, expected, options = {}) {
  assert.equal(proveEntriesAbsent(folder, entries, options), expected, `sync proof for ${folder}`);
  assert.equal(await proveEntriesAbsentAsync(folder, entries, options), expected, `async proof for ${folder}`);
}

test('evidence names are exactly the boundary rule entries', () => {
  assert.equal(SERVER_STATE_DIRECTORY, '.minecraft-core-state');
  assert.deepEqual(SERVER_EVIDENCE_ENTRIES, ['modpack.json', 'manifests', 'operations', 'history']);
  assert.equal(CLIENT_PACK_MANIFEST, '.minecraft-core-client-pack.json');
  assert.deepEqual(EVIDENCE_ENTRIES_BY_KIND, { server: SERVER_EVIDENCE, client: ['.minecraft-core-client-pack.json'] });
  assert.equal(Object.isFrozen(SERVER_EVIDENCE_ENTRIES), true);
  assert.equal(Object.isFrozen(EVIDENCE_ENTRIES_BY_KIND), true);
  assert.equal(Object.isFrozen(EVIDENCE_ENTRIES_BY_KIND.server), true);
});

test('an empty folder is unmanaged and its absence proofs hold', async t => {
  const folder = makeFolder(tempRoot(t), 'empty');
  const result = inspectFolderEvidence(folder);
  assert.deepEqual(result, UNMANAGED);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  await assertAbsenceProof(folder, ALL_EVIDENCE, true);
});

for (const entry of SERVER_EVIDENCE_ENTRIES) {
  for (const type of ['file', 'directory']) {
    test(`.minecraft-core-state/${entry} alone as a ${type} is lifecycle evidence`, async t => {
      const folder = makeFolder(tempRoot(t), 'server');
      place(folder, `.minecraft-core-state/${entry}`, type);
      assert.deepEqual(inspectFolderEvidence(folder), lifecycle([`.minecraft-core-state/${entry}`]));
      assert.deepEqual(inspectFolderEvidence(folder, { kinds: ['server'] }), lifecycle([`.minecraft-core-state/${entry}`]));
      assert.deepEqual(inspectFolderEvidence(folder, { kinds: ['client'] }), UNMANAGED);
      await assertAbsenceProof(folder, [`.minecraft-core-state/${entry}`], false);
      await assertAbsenceProof(folder, ALL_EVIDENCE.filter(item => item !== `.minecraft-core-state/${entry}`), true);
    });
  }
}

test('every present evidence entry is reported in a stable order', t => {
  const folder = makeFolder(tempRoot(t), 'full');
  for (const entry of [...ALL_EVIDENCE].reverse()) place(folder, entry, entry.endsWith('.json') ? 'file' : 'directory');
  assert.deepEqual(inspectFolderEvidence(folder), lifecycle(ALL_EVIDENCE));
  assert.deepEqual(inspectFolderEvidence(folder, { kinds: ['client', 'server'] }), lifecycle(ALL_EVIDENCE));
});

test('runtime.json, runtime-staging, an empty state folder and .minecraft-core.json fields are not evidence', async t => {
  const root = tempRoot(t);
  const runtimeOnly = makeFolder(root, 'runtime-only');
  place(runtimeOnly, '.minecraft-core-state/runtime.json');
  const stagingOnly = makeFolder(root, 'staging-only');
  place(stagingOnly, '.minecraft-core-state/runtime-staging', 'directory');
  const emptyState = makeFolder(root, 'empty-state');
  fs.mkdirSync(path.join(emptyState, '.minecraft-core-state'));
  const summaryOnly = makeFolder(root, 'summary-only');
  fs.writeFileSync(path.join(summaryOnly, '.minecraft-core.json'),
    JSON.stringify({ modpackManaged: true, contentRevision: 7, runtime: { loader: 'fabric' } }));

  for (const folder of [runtimeOnly, stagingOnly, emptyState, summaryOnly]) {
    assert.deepEqual(inspectFolderEvidence(folder), UNMANAGED, folder);
    await assertAbsenceProof(folder, ALL_EVIDENCE, true);
  }
});

test('a v26.6.1 client folder with minecraft-core-state/expected-mods.json is unmanaged', async t => {
  const client = makeFolder(tempRoot(t), 'v26.6.1-client');
  place(client, 'minecraft-core-state/expected-mods.json');
  place(client, 'mods', 'directory');
  place(client, 'client-config.json');
  assert.deepEqual(inspectFolderEvidence(client), UNMANAGED);
  assert.deepEqual(inspectFolderEvidence(client, { kinds: ['client'] }), UNMANAGED);
  await assertAbsenceProof(client, ['.minecraft-core-client-pack.json'], true);
});

test('the client-pack manifest is lifecycle evidence', async t => {
  const root = tempRoot(t);
  for (const type of ['file', 'directory']) {
    const client = makeFolder(root, `client-${type}`);
    place(client, CLIENT_PACK_MANIFEST, type);
    assert.deepEqual(inspectFolderEvidence(client), lifecycle(['.minecraft-core-client-pack.json']));
    assert.deepEqual(inspectFolderEvidence(client, { kinds: ['client'] }), lifecycle(['.minecraft-core-client-pack.json']));
    assert.deepEqual(inspectFolderEvidence(client, { kinds: ['server'] }), UNMANAGED);
    await assertAbsenceProof(client, [CLIENT_PACK_MANIFEST], false);
  }
});

for (const code of ['EACCES', 'EPERM', 'EIO', 'EBUSY', 'ENOTDIR']) {
  test(`an evidence entry that fails lstat with ${code} makes the folder unknown`, async () => {
    for (const entry of ALL_EVIDENCE) {
      const target = path.join(FAKE_FOLDER, ...entry.split('/'));
      const { fsApi, fsPromises } = fakeFs(new Map([[FAKE_FOLDER, 'directory'], [target, errno(code)]]));
      assert.deepEqual(inspectFolderEvidence(FAKE_FOLDER, { fsApi }), unknown(code), entry);
      assert.equal(proveEntriesAbsent(FAKE_FOLDER, [entry], { fsApi }), false);
      assert.equal(await proveEntriesAbsentAsync(FAKE_FOLDER, [entry], { fsPromises }), false);
    }
  });
}

test('a folder whose own stat fails is unknown', async () => {
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const { fsApi, fsPromises, calls } = fakeFs(new Map([[FAKE_FOLDER, errno(code)]]));
    assert.deepEqual(inspectFolderEvidence(FAKE_FOLDER, { fsApi }), unknown(code));
    assert.equal(proveEntriesAbsent(FAKE_FOLDER, STATE_FILE, { fsApi }), false);
    assert.equal(await proveEntriesAbsentAsync(FAKE_FOLDER, STATE_FILE, { fsPromises }), false);
    assert.deepEqual(calls.map(([method]) => method), ['statSync', 'statSync', 'stat']);
  }
});

test('present evidence wins over an entry that cannot be read', () => {
  const { fsApi } = fakeFs(new Map([
    [FAKE_FOLDER, 'directory'],
    [path.join(FAKE_FOLDER, '.minecraft-core-state', 'modpack.json'), 'file'],
    [path.join(FAKE_FOLDER, '.minecraft-core-state', 'history'), errno('EACCES')]
  ]));
  assert.deepEqual(inspectFolderEvidence(FAKE_FOLDER, { fsApi }), lifecycle(['.minecraft-core-state/modpack.json']));
});

test('a missing folder or a file where the folder should be is unknown', async t => {
  const root = tempRoot(t);
  const missing = path.join(root, 'missing');
  const file = path.join(root, 'not-a-folder');
  fs.writeFileSync(file, 'plain file');
  assert.deepEqual(inspectFolderEvidence(missing), unknown('ENOENT'));
  assert.deepEqual(inspectFolderEvidence(file), unknown('ENOTDIR'));
  await assertAbsenceProof(missing, ALL_EVIDENCE, false);
  await assertAbsenceProof(file, ALL_EVIDENCE, false);
});

test('a relative, empty, non-string or NUL-containing folder is unknown and never probed', async () => {
  const { fsApi, fsPromises, calls } = fakeFs(new Map());
  for (const folder of ['relative\\server', 'relative/server', '', null, undefined, 42, `${FAKE_FOLDER}\0x`]) {
    assert.deepEqual(inspectFolderEvidence(folder, { fsApi }), unknown('EINVAL'), String(folder));
    assert.equal(proveEntriesAbsent(folder, STATE_FILE, { fsApi }), false);
    assert.equal(await proveEntriesAbsentAsync(folder, STATE_FILE, { fsPromises }), false);
  }
  assert.deepEqual(calls, []);
});

test('a junction is followed: to an unmanaged folder it is unmanaged, to a pack folder it is lifecycle', async t => {
  const root = tempRoot(t);
  const plainTarget = makeFolder(root, 'plain-target');
  const packTarget = makeFolder(root, 'pack-target');
  place(packTarget, '.minecraft-core-state/modpack.json');
  const plainLink = path.join(root, 'plain-link');
  const packLink = path.join(root, 'pack-link');
  fs.symlinkSync(plainTarget, plainLink, LINK_TYPE);
  fs.symlinkSync(packTarget, packLink, LINK_TYPE);

  assert.deepEqual(inspectFolderEvidence(plainLink), UNMANAGED);
  assert.deepEqual(inspectFolderEvidence(packLink), lifecycle(['.minecraft-core-state/modpack.json']));
  await assertAbsenceProof(plainLink, ALL_EVIDENCE, true);
  await assertAbsenceProof(packLink, STATE_FILE, false);
});

test('a state directory reached through a junction still exposes its evidence', async t => {
  const root = tempRoot(t);
  const elsewhere = makeFolder(root, 'elsewhere');
  place(elsewhere, 'history', 'directory');
  const server = makeFolder(root, 'server');
  fs.symlinkSync(elsewhere, path.join(server, '.minecraft-core-state'), LINK_TYPE);
  assert.deepEqual(inspectFolderEvidence(server), lifecycle(['.minecraft-core-state/history']));
  await assertAbsenceProof(server, ['.minecraft-core-state/history'], false);
});

test('an NFD-named folder is evaluated under its own spelling', async t => {
  const root = tempRoot(t);
  const plainName = 'Cafe\u0301 Server';
  const packName = 'Cafe\u0301 Pack';
  const plain = makeFolder(root, plainName);
  const pack = makeFolder(root, packName);
  place(pack, '.minecraft-core-state/modpack.json');
  const recorded = recordingFs(fs);

  assert.deepEqual(inspectFolderEvidence(plain, { fsApi: recorded.api }), UNMANAGED);
  assert.deepEqual(inspectFolderEvidence(pack, { fsApi: recorded.api }), lifecycle(['.minecraft-core-state/modpack.json']));
  const seen = recorded.calls.map(([, candidate]) => candidate);
  assert.deepEqual(recorded.calls[0], ['statSync', plain]);
  assert.ok(seen.every(candidate => candidate.startsWith(plain) || candidate.startsWith(pack)));
  assert.ok(seen.every(candidate => !candidate.includes(plainName.normalize('NFC')) && !candidate.includes(packName.normalize('NFC'))));
  await assertAbsenceProof(plain, ALL_EVIDENCE, true);

  const nfdOnly = path.join(FAKE_FOLDER, plainName);
  const { fsApi } = fakeFs(new Map([[nfdOnly, 'directory']]));
  assert.deepEqual(inspectFolderEvidence(nfdOnly, { fsApi }), UNMANAGED);
  assert.deepEqual(inspectFolderEvidence(nfdOnly.normalize('NFC'), { fsApi }), unknown('ENOENT'));
});

test('drive roots, UNC share roots and space-padded names are evaluated, not refused', {
  skip: process.platform !== 'win32' && 'Windows path shapes'
}, async () => {
  const rootCalls = fakeFs(new Map([['X:\\', 'directory']]));
  assert.deepEqual(inspectFolderEvidence('X:\\', { fsApi: rootCalls.fsApi }), UNMANAGED);
  assert.deepEqual(rootCalls.calls, [
    ['statSync', 'X:\\'],
    ['lstatSync', 'X:\\.minecraft-core-state\\modpack.json'],
    ['lstatSync', 'X:\\.minecraft-core-state\\manifests'],
    ['lstatSync', 'X:\\.minecraft-core-state\\operations'],
    ['lstatSync', 'X:\\.minecraft-core-state\\history'],
    ['lstatSync', 'X:\\.minecraft-core-client-pack.json']
  ]);
  assert.equal(proveEntriesAbsent('X:\\', STATE_FILE, { fsApi: rootCalls.fsApi }), true);
  assert.equal(await proveEntriesAbsentAsync('X:\\', STATE_FILE, { fsPromises: rootCalls.fsPromises }), true);

  const packRoot = fakeFs(new Map([['X:\\', 'directory'], ['X:\\.minecraft-core-state\\modpack.json', 'file']]));
  assert.deepEqual(inspectFolderEvidence('X:\\', { fsApi: packRoot.fsApi }), lifecycle(['.minecraft-core-state/modpack.json']));

  const share = '\\\\nas\\minecraft\\';
  const shareCalls = fakeFs(new Map([[share, 'directory'], ['\\\\nas\\minecraft\\.minecraft-core-client-pack.json', 'file']]));
  assert.deepEqual(inspectFolderEvidence(share, { fsApi: shareCalls.fsApi }), lifecycle(['.minecraft-core-client-pack.json']));
  assert.equal(shareCalls.calls[0][1], share);

  for (const name of [' Leading Space', 'Trailing Space ', 'Trailing Dot.']) {
    const folder = `X:\\Servers\\${name}`;
    const padded = fakeFs(new Map([[folder, 'directory']]));
    assert.deepEqual(inspectFolderEvidence(folder, { fsApi: padded.fsApi }), UNMANAGED, name);
    assert.equal(padded.calls[0][1], folder);
    assert.equal(padded.calls[1][1], `${folder}\\.minecraft-core-state\\modpack.json`);
  }
});

test('the predicate is re-evaluated on every call and never cached', t => {
  const folder = makeFolder(tempRoot(t), 'changing');
  assert.deepEqual(inspectFolderEvidence(folder), UNMANAGED);
  const target = place(folder, '.minecraft-core-state/operations', 'directory');
  assert.deepEqual(inspectFolderEvidence(folder), lifecycle(['.minecraft-core-state/operations']));
  fs.rmSync(target, { recursive: true });
  assert.deepEqual(inspectFolderEvidence(folder), UNMANAGED);
});

test('relative entries accept either separator and must stay inside the folder', async t => {
  const folder = makeFolder(tempRoot(t), 'entries');
  place(folder, '.minecraft-core-state/modpack.json');
  assert.equal(proveEntriesAbsent(folder, ['.minecraft-core-state\\modpack.json']), false);
  assert.equal(proveEntriesAbsent(folder, ['.minecraft-core-state/history']), true);
  for (const entries of [[], 'modpack.json', [''], ['../outside'], ['a/../../outside'], ['.minecraft-core-state/'],
    [path.join(folder, 'absolute')], ['a\0b'], [42]]) {
    assert.throws(() => proveEntriesAbsent(folder, entries), TypeError, JSON.stringify(entries));
    await assert.rejects(proveEntriesAbsentAsync(folder, entries), TypeError);
  }
});

test('invalid options are programming errors', () => {
  assert.throws(() => inspectFolderEvidence(FAKE_FOLDER, { kinds: [] }), TypeError);
  assert.throws(() => inspectFolderEvidence(FAKE_FOLDER, { kinds: ['server', 'world'] }), TypeError);
  assert.throws(() => inspectFolderEvidence(FAKE_FOLDER, { kinds: 'server' }), TypeError);
  assert.throws(() => inspectFolderEvidence(FAKE_FOLDER, { fsApi: { statSync() {} } }), TypeError);
  assert.throws(() => proveEntriesAbsent(FAKE_FOLDER, STATE_FILE, { fsApi: {} }), TypeError);
  return assert.rejects(proveEntriesAbsentAsync(FAKE_FOLDER, STATE_FILE, { fsPromises: { stat: async () => ({}) } }), TypeError);
});

test('the predicate only stats and lstats: no write is ever attempted', async t => {
  const root = tempRoot(t);
  const plain = makeFolder(root, 'plain');
  const pack = makeFolder(root, 'pack');
  place(pack, '.minecraft-core-state/modpack.json');
  place(pack, CLIENT_PACK_MANIFEST);
  const file = path.join(root, 'file');
  fs.writeFileSync(file, '');
  const folders = [plain, pack, file, path.join(root, 'missing')];

  const effects = spyOnSideEffects(t);
  const syncFs = recordingFs(fs);
  const asyncFs = recordingFs(fs.promises);
  try {
    for (const folder of folders) {
      inspectFolderEvidence(folder, { fsApi: syncFs.api });
      inspectFolderEvidence(folder);
      proveEntriesAbsent(folder, ALL_EVIDENCE, { fsApi: syncFs.api });
      proveEntriesAbsent(folder, ALL_EVIDENCE);
      await proveEntriesAbsentAsync(folder, ALL_EVIDENCE, { fsPromises: asyncFs.api });
      await proveEntriesAbsentAsync(folder, ALL_EVIDENCE);
    }
  } finally {
    // The fixture cleanup hook removes files, so the write spies must go first.
    t.mock.restoreAll();
  }

  assert.deepEqual([...new Set(syncFs.calls.map(([method]) => method))].sort(), ['lstatSync', 'statSync']);
  assert.deepEqual([...new Set(asyncFs.calls.map(([method]) => method))].sort(), ['lstat', 'stat']);
  assert.deepEqual(effects, []);
});

test('requiring the module spawns no process and writes nothing', t => {
  const effects = spyOnSideEffects(t);
  delete require.cache[MODULE_PATH];
  const fresh = require(MODULE_PATH);
  assert.equal(typeof fresh.inspectFolderEvidence, 'function');
  assert.deepEqual(effects, []);
});
