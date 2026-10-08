const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const {
  createForgeRuntimeFinalizerWorkerClient
} = require('../electron/services/forge-runtime-finalizer-worker-client.cjs');

const runtime = Object.freeze({
  minecraftVersion: '1.12.2',
  loaderFamily: 'forge',
  loaderVersion: '14.23.5.2860',
  javaMajor: 8,
  os: 'win32',
  architecture: 'x64'
});

test('the authenticated finalizer worker boundary executes from app.asar under Electron', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-finalizer-asar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const archivePath = path.join(root, 'resources', 'app.asar');
  const repositoryRoot = path.resolve(__dirname, '..');
  const packagedFiles = [
    'electron/services/runtime-diagnostic.cjs',
    'electron/services/forge-runtime-finalizer-worker-protocol.cjs',
    'electron/services/forge-runtime-finalizer-worker.cjs',
    'tests/fixtures/slow-forge-runtime-finalizer-worker.cjs'
  ];
  for (const relativePath of packagedFiles) {
    const destination = path.join(sourceRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, ...relativePath.split('/')), destination);
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(sourceRoot, archivePath);

  const targetPath = path.join(root, 'server');
  fs.mkdirSync(targetPath);
  const runFinalizer = createForgeRuntimeFinalizerWorkerClient({
    execPath: require('electron'),
    workerPath: path.join(archivePath, 'tests', 'fixtures', 'slow-forge-runtime-finalizer-worker.cjs')
  });
  const validation = await runFinalizer({ targetPath, runtime, timeoutMs: 5000 });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.runtime, runtime);
  assert.equal(validation.loader.family, 'forge');
  assert.deepEqual(validation.artifacts.map(artifact => artifact.relativePath), [
    '.finalizer-started',
    'libraries/net/minecraftforge/forge/1.12.2-14.23.5.2860/win_args.txt'
  ]);
});
