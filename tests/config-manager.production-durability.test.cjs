const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureConfigFile,
  ensureConfigFileStrict,
  updateServerConfig,
  writeServerConfig
} = require('../electron/utils/config-manager.cjs');
const { createModpackServiceGraph } = require('../electron/bootstrap/create-modpack-service-graph.cjs');
const { configureDurableFs, createDurableFs } = require('../electron/utils/durable-fs.cjs');

function temporaryDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function durableFsFor(serverPath, tempNameFactory) {
  return createDurableFs({
    fsApi: fs,
    allowedRoots: [serverPath],
    tempNameFactory,
    durableClient: {
      flushDirectory() {},
      moveWriteThrough(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath);
      },
      replaceFileWriteThrough(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath);
      }
    }
  });
}

function composeGraph(t, durableFsFactory) {
  const userDataPath = temporaryDirectory(t, 'minecraft-core-config-graph-');
  const runtimeRoot = path.resolve(__dirname, '..');
  let id = 0;
  return createModpackServiceGraph({
    app: {
      isPackaged: false,
      getPath(name) {
        assert.equal(name, 'userData');
        return userDataPath;
      }
    },
    store: { get: () => [] },
    userDataPath,
    runtimeRoots: {
      resourcesPath: runtimeRoot,
      runtimeRoot,
      isPackaged: false,
      arch: 'x64'
    },
    clock: { now: () => 1_750_000_000_000 },
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpsRequest() { throw new Error('not called'); },
    randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    randomBytes: size => Buffer.alloc(size, 7),
    workerFactory: options => ({ options }),
    processFactory: options => ({ options }),
    windowFactory: () => ({ id: 1 }),
    coordinator: {
      runMutation() {},
      runManyMutations() {},
      runRecoveryMutation() {},
      beginStartupRecovery() {},
      installRecoveryBlocks() {},
      completeStartupRecovery() {}
    },
    serverMutationPolicy: { wrapHandler: value => value, wrapHandlers: value => value },
    modpackFactory: async () => ({ initialize() {} }),
    durableFsFactory
  });
}

test('direct config writes fail closed before production durability is configured', (t) => {
  const serverPath = temporaryDirectory(t, 'minecraft-core-config-unconfigured-');
  const configPath = path.join(serverPath, '.minecraft-core.json');

  assert.throws(
    () => writeServerConfig(serverPath, { maxRam: 8 }),
    error => error?.code === 'COMMIT_FAILED'
  );
  assert.throws(
    () => updateServerConfig(serverPath, current => ({ ...current, maxRam: 8 })),
    error => error?.code === 'COMMIT_FAILED'
  );
  assert.throws(
    () => ensureConfigFileStrict(serverPath, { maxRam: 8 }),
    error => error?.code === 'COMMIT_FAILED'
  );
  assert.equal(ensureConfigFile(serverPath, { maxRam: 8 }), null);
  assert.equal(fs.existsSync(configPath), false);
});

test('an explicitly configured legacy durable capability remains a supported fallback', (t) => {
  const serverPath = temporaryDirectory(t, 'minecraft-core-config-legacy-durable-');
  let tempSequence = 0;
  configureDurableFs({
    fsApi: fs,
    allowedRoots: [serverPath],
    tempNameFactory: () => `legacy-config-${++tempSequence}`,
    durableClient: {
      flushDirectory() {},
      moveWriteThrough(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath);
      },
      replaceFileWriteThrough(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath);
      }
    }
  });

  const written = writeServerConfig(serverPath, { maxRam: 10 });

  assert.equal(written.maxRam, 10);
  assert.equal(JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8')).maxRam, 10);
});

function addModpackEvidence(serverPath) {
  fs.mkdirSync(path.join(serverPath, '.minecraft-core-state'), { recursive: true });
  fs.writeFileSync(path.join(serverPath, '.minecraft-core-state', 'modpack.json'), '{}\n');
}

test('service graph keeps unmanaged config writes off the strict writer and gives servers with evidence their exact root', (t) => {
  const requestedRoots = [];
  let tempSequence = 0;
  composeGraph(t, allowedRoots => {
    requestedRoots.push([...allowedRoots]);
    assert.equal(allowedRoots.length, 1);
    return durableFsFor(allowedRoots[0], () => `production-config-${++tempSequence}`);
  });

  const serverPaths = Array.from({ length: 18 }, (_, index) =>
    temporaryDirectory(t, `minecraft-core-config-root-${String(index).padStart(2, '0')}-`));

  writeServerConfig(serverPaths[0], { maxRam: 6 });
  updateServerConfig(serverPaths[1], current => ({ ...current, maxRam: 7 }));
  assert.equal(ensureConfigFile(serverPaths[2], { maxRam: 8 })?.maxRam, 8);
  for (let index = 3; index < serverPaths.length; index += 1) {
    writeServerConfig(serverPaths[index], { maxRam: index + 4 });
  }

  assert.deepEqual(requestedRoots, [], 'folders without modpack evidence use the legacy writer');
  for (const serverPath of serverPaths) {
    assert.equal(fs.existsSync(path.join(serverPath, '.minecraft-core.json')), true);
    assert.deepEqual(fs.readdirSync(serverPath).filter(name => name.includes('minecraft-core-tmp')), []);
  }

  const managedPaths = serverPaths.slice(0, 3);
  for (const serverPath of managedPaths) addModpackEvidence(serverPath);
  writeServerConfig(managedPaths[0], { maxRam: 9 });
  updateServerConfig(managedPaths[1], current => ({ ...current, maxRam: 10 }));
  assert.equal(ensureConfigFile(managedPaths[2], { maxRam: 11 })?.maxRam, 8);
  assert.deepEqual(requestedRoots, managedPaths.map(serverPath => [path.resolve(serverPath)]));
  assert.equal(JSON.parse(fs.readFileSync(path.join(managedPaths[0], '.minecraft-core.json'), 'utf8')).maxRam, 9);
  assert.equal(JSON.parse(fs.readFileSync(path.join(managedPaths[1], '.minecraft-core.json'), 'utf8')).maxRam, 10);

  const explicitPath = temporaryDirectory(t, 'minecraft-core-config-explicit-');
  const callsBeforeExplicitWrite = requestedRoots.length;
  let explicitSequence = 0;
  const explicitDurableFs = durableFsFor(explicitPath, () => `explicit-config-${++explicitSequence}`);
  writeServerConfig(explicitPath, { maxRam: 32 }, {}, { durableFs: explicitDurableFs });
  assert.equal(requestedRoots.length, callsBeforeExplicitWrite);
  assert.equal(JSON.parse(fs.readFileSync(path.join(explicitPath, '.minecraft-core.json'), 'utf8')).maxRam, 32);
});

test('a configured production factory failure cannot fall back to ordinary filesystem writes for a server with evidence', (t) => {
  composeGraph(t, () => {
    throw new Error('injected durable factory failure');
  });
  const serverPath = temporaryDirectory(t, 'minecraft-core-config-factory-failure-');
  addModpackEvidence(serverPath);
  const configPath = path.join(serverPath, '.minecraft-core.json');

  assert.throws(
    () => writeServerConfig(serverPath, { maxRam: 12 }),
    error => error?.code === 'COMMIT_FAILED'
  );
  assert.equal(ensureConfigFile(serverPath, { maxRam: 12 }), null);
  assert.equal(fs.existsSync(configPath), false);
});

test('an unmanaged config write succeeds while the strict production factory throws', (t) => {
  let strictCalls = 0;
  composeGraph(t, () => {
    strictCalls += 1;
    throw new Error('ArchiveWorker.exe is missing');
  });
  const serverPath = temporaryDirectory(t, 'minecraft-core-config-unmanaged-without-worker-');
  const configPath = path.join(serverPath, '.minecraft-core.json');

  assert.equal(writeServerConfig(serverPath, { maxRam: 12 }).maxRam, 12);
  assert.equal(updateServerConfig(serverPath, current => ({ ...current, port: 25570 })).port, 25570);
  assert.equal(ensureConfigFile(serverPath, { maxRam: 16 })?.maxRam, 12);

  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(written.maxRam, 12);
  assert.equal(written.port, 25570);
  assert.equal(strictCalls, 0);
  assert.deepEqual(fs.readdirSync(serverPath).filter(name => name.includes('minecraft-core-tmp')), []);
});
