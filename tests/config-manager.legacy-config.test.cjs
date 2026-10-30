const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const configManager = require('../electron/utils/config-manager.cjs');
const {
  configureServerConfigDurableFsFactory,
  readServerConfig,
  updateServerConfig,
  writeServerConfig
} = configManager;
const {
  bumpContentRevision,
  readContentRevision,
  withContentRevisionLock
} = require('../electron/services/server-content-revision.cjs');
const { ServerMutationCoordinator } = require('../electron/services/server-mutation-coordinator.cjs');
const { createDurableFs } = require('../electron/utils/durable-fs.cjs');
const {
  createInstanceConfigFsFactory,
  isLegacyInstanceConfigFs
} = require('../electron/utils/instance-config-fs.cjs');

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const strictCalls = [];
let tempSequence = 0;

function strictFactory(roots) {
  strictCalls.push([...roots]);
  return createDurableFs({
    fsApi: fs,
    allowedRoots: [...roots],
    tempNameFactory: () => `strict-config-${++tempSequence}`,
    durableClient: {
      moveWriteThrough: (source, destination) => fs.renameSync(source, destination),
      replaceFileWriteThrough: (source, destination) => fs.renameSync(source, destination),
      flushDirectory() {}
    }
  });
}

// The writer selection the service graph wires for config-manager and the
// coordinator: legacy for folders without lifecycle evidence, strict otherwise.
const instanceConfigFsFactory = createInstanceConfigFsFactory({ strictFactory });
configureServerConfigDurableFsFactory(instanceConfigFsFactory);

function serverFolder(t) {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-legacy-config-'));
  t.after(() => fs.rmSync(serverPath, { recursive: true, force: true }));
  return serverPath;
}

function configPathOf(serverPath) {
  return path.join(serverPath, '.minecraft-core.json');
}

function sha12(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

function preservedCopies(serverPath) {
  return fs.readdirSync(serverPath).filter(name => name.startsWith('.minecraft-core.json.unreadable-'));
}

function tempLeftovers(serverPath) {
  return fs.readdirSync(serverPath).filter(name => name.includes('.minecraft-core-tmp-'));
}

function addLifecycleEvidence(serverPath) {
  fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'));
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{}');
}

function prePublication(code) {
  return error => error?.code === code && error.commitPhase === 'pre-publication';
}

const DAMAGED_CONFIGS = [
  ['empty', Buffer.alloc(0)],
  ['400 NUL bytes', Buffer.alloc(400, 0)],
  ['truncated', Buffer.from('{\n  "port": 25570,\n  "maxRam": 8,\n  "contentRev', 'utf8')],
  ['trailing comma', Buffer.from('{"port": 25570, "maxRam": 8,}', 'utf8')]
];

for (const [label, original] of DAMAGED_CONFIGS) {
  test(`an unmanaged server saves over a ${label} config and keeps the damaged bytes`, (t) => {
    const serverPath = serverFolder(t);
    const configPath = configPathOf(serverPath);
    fs.writeFileSync(configPath, original);
    const strictCallsBefore = strictCalls.length;

    const saved = updateServerConfig(serverPath, { maxRam: 6 });

    assert.equal(saved.maxRam, 6);
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(written.maxRam, 6);
    assert.equal(written.contentRevision, 0);
    if (original.length === 0) {
      assert.deepEqual(preservedCopies(serverPath), []);
    } else {
      const preservedName = `.minecraft-core.json.unreadable-${sha12(original)}`;
      assert.deepEqual(preservedCopies(serverPath), [preservedName]);
      assert.deepEqual(fs.readFileSync(path.join(serverPath, preservedName)), original);
    }
    assert.deepEqual(tempLeftovers(serverPath), []);
    assert.equal(strictCalls.length, strictCallsBefore);
  });
}

test('a start lease on an unmanaged server with a damaged config bumps instead of blocking', async (t) => {
  const serverPath = serverFolder(t);
  const configPath = configPathOf(serverPath);
  const original = Buffer.alloc(400, 0);
  fs.writeFileSync(configPath, original);
  const coordinator = new ServerMutationCoordinator({ durableFsFactory: instanceConfigFsFactory });
  coordinator.completeStartupRecovery([]);
  const selector = { instanceId: 'legacy-damaged-server', serverPath };

  const first = await coordinator.acquireStart(selector, {
    operation: 'server-start',
    operationId: 'legacy-damaged-start-1',
    parentMutationLease: null
  });
  // Every start rewrites server.properties, which marks the lease dirty.
  first.markDirty();
  first.markRunning({ pid: 4242 });
  first.release();

  assert.equal(readContentRevision(serverPath), 1);
  assert.deepEqual(fs.readFileSync(path.join(serverPath, `.minecraft-core.json.unreadable-${sha12(original)}`)), original);
  const second = await coordinator.acquireStart(selector, {
    operation: 'server-start',
    operationId: 'legacy-damaged-start-2',
    parentMutationLease: null
  });
  assert.equal(second.baseRevision, 1);
  second.release();
});

test('a BOM config keeps its settings and bumps from its stored revision', (t) => {
  const serverPath = serverFolder(t);
  const configPath = configPathOf(serverPath);
  fs.writeFileSync(configPath, Buffer.concat([
    BOM,
    Buffer.from(JSON.stringify({ port: 25570, maxRam: 8, contentRevision: 5 }, null, 2), 'utf8')
  ]));

  const config = readServerConfig(serverPath);
  assert.equal(config.port, 25570);
  assert.equal(config.maxRam, 8);
  assert.equal(readContentRevision(serverPath), 5);

  const durableFs = instanceConfigFsFactory(Object.freeze([path.resolve(serverPath)]));
  assert.equal(isLegacyInstanceConfigFs(durableFs), true);
  assert.equal(bumpContentRevision(serverPath, {
    expectedRevision: 5,
    operationId: 'legacy-bom-bump',
    durableFs
  }), 6);

  const bumped = readServerConfig(serverPath);
  assert.equal(bumped.port, 25570);
  assert.equal(bumped.maxRam, 8);
  assert.equal(bumped.contentRevision, 6);
  assert.deepEqual(preservedCopies(serverPath), []);
});

test('a server folder that is itself a junction saves its settings', (t) => {
  const root = serverFolder(t);
  const realServer = path.join(root, 'real-server');
  fs.mkdirSync(realServer);
  fs.writeFileSync(configPathOf(realServer), JSON.stringify({ port: 25570, maxRam: 4, contentRevision: 2 }));
  const serverJunction = path.join(root, 'server-junction');
  try {
    fs.symlinkSync(realServer, serverJunction, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory aliases are unavailable on this host: ${error.code}`);
    return;
  }
  const strictCallsBefore = strictCalls.length;

  assert.equal(writeServerConfig(serverJunction, { maxRam: 6 }).maxRam, 6);
  assert.equal(updateServerConfig(serverJunction, current => ({ ...current, maxRam: 10 })).maxRam, 10);

  const written = JSON.parse(fs.readFileSync(configPathOf(realServer), 'utf8'));
  assert.equal(written.maxRam, 10);
  assert.equal(written.port, 25570);
  assert.equal(written.contentRevision, 2);
  assert.equal(strictCalls.length, strictCallsBefore);
  assert.deepEqual(tempLeftovers(realServer), []);
});

test('a server with lifecycle evidence still fails closed on a damaged config', (t) => {
  const serverPath = serverFolder(t);
  addLifecycleEvidence(serverPath);
  const configPath = configPathOf(serverPath);
  const damaged = Buffer.from('{"contentRevision": 4,', 'utf8');
  fs.writeFileSync(configPath, damaged);
  const strictCallsBefore = strictCalls.length;

  assert.throws(() => updateServerConfig(serverPath, { maxRam: 6 }), prePublication('COMMIT_FAILED'));

  assert.deepEqual(fs.readFileSync(configPath), damaged);
  assert.deepEqual(preservedCopies(serverPath), []);
  assert.deepEqual(strictCalls.slice(strictCallsBefore), [[path.resolve(serverPath)]]);
});

test('every refusal before a config write is tagged pre-publication', (t) => {
  const serverPath = serverFolder(t);
  const configPath = configPathOf(serverPath);
  const original = JSON.stringify({ contentRevision: 4, maxRam: 4 });
  fs.writeFileSync(configPath, original);
  const refusals = [
    ['a missing server folder', () => updateServerConfig(path.join(serverPath, 'missing'), { maxRam: 6 }), 'INVALID_REQUEST'],
    ['a file instead of a folder', () => writeServerConfig(configPath, { maxRam: 6 }), 'INVALID_REQUEST'],
    ['unknown write options', () => writeServerConfig(serverPath, { maxRam: 6 }, {}, { unknown: true }), 'INVALID_REQUEST'],
    ['a non-object config', () => writeServerConfig(serverPath, ['maxRam']), 'INVALID_REQUEST'],
    ['an updater without a plain result', () => updateServerConfig(serverPath, () => null), 'INVALID_REQUEST'],
    ['a stale expected revision', () => updateServerConfig(serverPath, { maxRam: 6 }, {}, { expectedContentRevision: 3 }), 'PLAN_STALE'],
    ['a renderer revision change', () => writeServerConfig(serverPath, { contentRevision: 5 }), 'PLAN_STALE'],
    ['a busy revision lock', () => withContentRevisionLock(serverPath, 'outer-config-lock',
      () => updateServerConfig(serverPath, { maxRam: 6 })), 'OPERATION_IN_PROGRESS']
  ];
  for (const [label, attempt, code] of refusals) {
    assert.throws(attempt, prePublication(code), label);
  }

  configureServerConfigDurableFsFactory(() => {
    throw new Error('injected durable factory failure');
  });
  try {
    assert.throws(() => updateServerConfig(serverPath, { maxRam: 6 }), prePublication('COMMIT_FAILED'));
  } finally {
    configureServerConfigDurableFsFactory(instanceConfigFsFactory);
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), original);
});

test('an unmanaged config write starts no helper process and never builds the strict writer', (t) => {
  const serverPath = serverFolder(t);
  fs.writeFileSync(configPathOf(serverPath), JSON.stringify({ contentRevision: 1, maxRam: 4 }));
  const spawned = [];
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = (...args) => {
      spawned.push(name);
      return original(...args);
    };
    t.after(() => { childProcess[name] = original; });
  }
  const strictCallsBefore = strictCalls.length;

  updateServerConfig(serverPath, { maxRam: 6 });
  writeServerConfig(serverPath, { port: 25570 });
  bumpContentRevision(serverPath, {
    expectedRevision: 1,
    operationId: 'legacy-spawn-free-bump',
    durableFs: instanceConfigFsFactory(Object.freeze([path.resolve(serverPath)]))
  });

  assert.deepEqual(spawned, []);
  assert.equal(strictCalls.length, strictCallsBefore);
  const written = readServerConfig(serverPath);
  assert.deepEqual([written.maxRam, written.port, written.contentRevision], [6, 25570, 2]);
});

test('restoreContentRevision writes back exactly the requested revision', (t) => {
  const serverPath = serverFolder(t);
  const configPath = configPathOf(serverPath);
  fs.writeFileSync(configPath, JSON.stringify({ port: 25570, maxRam: 6, custom: { kept: true } }));

  assert.equal(configManager.restoreContentRevision(serverPath, 3), 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
    port: 25570,
    maxRam: 6,
    custom: { kept: true },
    contentRevision: 3
  });

  const unchanged = fs.readFileSync(configPath);
  assert.equal(configManager.restoreContentRevision(serverPath, 3), 3);
  assert.deepEqual(fs.readFileSync(configPath), unchanged);

  for (const revision of [-1, 1.5, '3', Number.NaN]) {
    assert.throws(() => configManager.restoreContentRevision(serverPath, revision), prePublication('INVALID_REQUEST'));
  }
  assert.deepEqual(fs.readFileSync(configPath), unchanged);
});

test('restoreContentRevision is a no-op without a config and lenient only without evidence', (t) => {
  const missingConfig = serverFolder(t);
  assert.equal(configManager.restoreContentRevision(missingConfig, 4), null);
  assert.equal(fs.existsSync(configPathOf(missingConfig)), false);

  const legacy = serverFolder(t);
  const damaged = Buffer.from('{"port": 25570,', 'utf8');
  fs.writeFileSync(configPathOf(legacy), damaged);
  assert.equal(configManager.restoreContentRevision(legacy, 4), 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPathOf(legacy), 'utf8')), { contentRevision: 4 });
  assert.deepEqual(fs.readFileSync(path.join(legacy, `.minecraft-core.json.unreadable-${sha12(damaged)}`)), damaged);

  const managed = serverFolder(t);
  addLifecycleEvidence(managed);
  fs.writeFileSync(configPathOf(managed), damaged);
  assert.throws(() => configManager.restoreContentRevision(managed, 4), prePublication('COMMIT_FAILED'));
  assert.deepEqual(fs.readFileSync(configPathOf(managed)), damaged);
  assert.deepEqual(preservedCopies(managed), []);
});
