const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const {
  MANAGED_RUNTIME_PREPARE_OPERATION
} = require('../electron/services/managed-runtime-worker-protocol.cjs');
const {
  createManagedRuntimeWorkerClient
} = require('../electron/services/managed-runtime-worker-client.cjs');

const runtime = Object.freeze({
  minecraftVersion: '1.20.1',
  loaderFamily: 'fabric',
  loaderVersion: '0.16.14',
  javaMajor: 17,
  os: 'win32',
  architecture: 'x64'
});

test('the authenticated managed-runtime worker executes from app.asar under Electron', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-managed-runtime-asar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const archivePath = path.join(root, 'resources', 'app.asar');
  const repositoryRoot = path.resolve(__dirname, '..');
  const packagedFiles = [
    'electron/services/runtime-diagnostic.cjs',
    'electron/services/managed-runtime-worker-protocol.cjs',
    'electron/services/managed-runtime-worker.cjs',
    'electron/services/runtime-worker-quiescence.cjs',
    'tests/fixtures/slow-managed-runtime-worker.cjs'
  ];
  for (const relativePath of packagedFiles) {
    const destination = path.join(sourceRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, ...relativePath.split('/')), destination);
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(sourceRoot, archivePath);

  const targetPath = path.join(root, 'server');
  const javaPath = path.join(root, 'java', 'bin', 'java.exe');
  fs.mkdirSync(targetPath);
  fs.mkdirSync(path.dirname(javaPath), { recursive: true });
  fs.writeFileSync(javaPath, 'java fixture');
  const runManagedRuntime = createManagedRuntimeWorkerClient({
    execPath: require('electron'),
    workerPath: path.join(archivePath, 'tests', 'fixtures', 'slow-managed-runtime-worker.cjs')
  });
  const result = await runManagedRuntime({
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    targetPath: fs.realpathSync.native(targetPath),
    runtime,
    javaPath: fs.realpathSync.native(javaPath),
    timeoutMs: 5000
  });

  assert.deepEqual(result, { valid: true, runtime });
  assert.equal(fs.readFileSync(path.join(targetPath, '.managed-runtime-started'), 'utf8'), 'started');
});
