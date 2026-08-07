const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../../package.json');

let packagedVerifier = {};
try {
  packagedVerifier = require('../../scripts/verify-packaged-archive.cjs');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('verify-packaged-archive.cjs')) throw error;
}

const afterPack = require('../../scripts/afterPack.cjs');
const repositoryRoot = path.resolve(__dirname, '..', '..');

function copyPackagedResources(resourcesPath) {
  const archiveRoot = path.join(resourcesPath, 'archive');
  for (const [source, destination] of [
    ['vendor/7zip/x64', '7zip'],
    ['vendor/archive-worker/x64', 'worker'],
    ['third-party/7zip', 'licenses'],
    ['build-resources/archive-runtime', 'manifests']
  ]) {
    fs.cpSync(path.join(repositoryRoot, source), path.join(archiveRoot, destination), { recursive: true });
  }
  return archiveRoot;
}

async function createPackagedApplicationArchive(appOutDir, { includeNestedOutput = false } = {}) {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-app-source-'));
  try {
    for (const relativePath of [
      'electron/main.cjs',
      'electron/services/modpacks/archive/archive-runtime-verifier.cjs',
      'electron/services/modpacks/archive/archive-worker-client.cjs'
    ]) {
      const destination = path.join(sourceRoot, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, `module.exports = ${JSON.stringify(relativePath)};\n`);
    }
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({
      name: 'minecraft-core-packaged-fixture',
      version: '1.0.0',
      main: 'electron/main.cjs'
    }));
    if (includeNestedOutput) {
      const nestedExecutable = path.join(sourceRoot, 'dist', 'win-unpacked', 'Minecraft Core.exe');
      fs.mkdirSync(path.dirname(nestedExecutable), { recursive: true });
      fs.writeFileSync(nestedExecutable, 'nested-packaged-output');
    }
    await asar.createPackage(sourceRoot, path.join(appOutDir, 'resources', 'app.asar'));
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
}

function withoutPathEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLocaleUpperCase('en-US') !== 'PATH'));
}

test('packaged resolution cannot fall back to vendor or PATH', (t) => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-no-fallback-'));
  t.after(() => fs.rmSync(resourcesPath, { recursive: true, force: true }));
  const script = `
    const path = require('node:path');
    const { getBundledArchiveRuntime } = require('./electron/services/modpacks/archive/archive-engine-paths.cjs');
    getBundledArchiveRuntime({
      resourcesPath: ${JSON.stringify(resourcesPath)},
      runtimeRoot: path.resolve('.'),
      arch: 'x64',
      isPackaged: true
    }).then(
      () => { process.stderr.write('unexpected packaged fallback'); process.exitCode = 2; },
      error => { process.stdout.write(error?.code || 'missing-code'); }
    );
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', script], {
    cwd: repositoryRoot,
    env: withoutPathEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'EXTRACTOR_UNAVAILABLE');
});

test('Electron Builder maps only the reviewed x64 runtime, worker, licenses, and manifests', () => {
  assert.deepEqual(packageJson.build.extraResources, [
    { from: 'vendor/7zip/${arch}', to: 'archive/7zip', filter: ['**/*'] },
    { from: 'vendor/archive-worker/${arch}', to: 'archive/worker', filter: ['**/*'] },
    { from: 'third-party/7zip', to: 'archive/licenses', filter: ['**/*'] },
    { from: 'build-resources/archive-runtime', to: 'archive/manifests', filter: ['*.json'] }
  ]);
  assert.equal(packageJson.build.beforePack, 'scripts/verify-packaged-archive.cjs');
  assert.equal(packageJson.build.afterPack, 'scripts/afterPack.cjs');
});

test('packaged verifier proves exact runtime, worker, notices, manifests, and containment', { timeout: 120000 }, async (t) => {
  assert.equal(typeof packagedVerifier.verifyPackagedArchive, 'function', 'packaged archive verifier is required');
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-win-unpacked-fixture-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const resourcesPath = path.join(appOutDir, 'resources');
  copyPackagedResources(resourcesPath);
  await createPackagedApplicationArchive(appOutDir);

  const evidence = await packagedVerifier.verifyPackagedArchive({ appOutDir, architecture: 'x64' });
  assert.deepEqual(evidence, {
    type: 'packaged-archive-verification',
    version: 1,
    architecture: 'x64',
    runtime: { version: '26.02', handlers: { zip: true, rar: true } },
    worker: {
      runtimeIdentifier: 'win-x64',
      size: 67744371,
      sha256: '8a7653cfbfece23e2ad6dcd62584021309ce5df0c91e0a76212c3ae1e7d32489'
    },
    containment: 'passed',
    fallbacksUsed: []
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.fallbacksUsed), true);
});

test('packaged verifier rejects application archives that contain nested builder output', { timeout: 120000 }, async (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-nested-output-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  copyPackagedResources(path.join(appOutDir, 'resources'));
  await createPackagedApplicationArchive(appOutDir, { includeNestedOutput: true });

  await assert.rejects(
    packagedVerifier.verifyPackagedArchive({ appOutDir, architecture: 'x64' }),
    error => error?.code === 'EXTRACTOR_UNAVAILABLE'
  );
});

test('packaged verifier rejects missing, changed, and unsupported packaged inputs before success', { timeout: 30000 }, async (t) => {
  assert.equal(typeof packagedVerifier.verifyPackagedArchive, 'function', 'packaged archive verifier is required');
  for (const [name, mutate] of [
    ['missing-license', archiveRoot => fs.rmSync(path.join(archiveRoot, 'licenses', 'NOTICE.md'))],
    ['changed-worker', archiveRoot => fs.appendFileSync(path.join(archiveRoot, 'worker', 'ArchiveWorker.exe'), Buffer.from([0]))],
    ['changed-manifest', archiveRoot => fs.appendFileSync(path.join(archiveRoot, 'manifests', 'archive-worker-x64.json'), ' ')]
  ]) {
    await t.test(name, async (subtest) => {
      const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-packaged-${name}-`));
      subtest.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
      const archiveRoot = copyPackagedResources(path.join(appOutDir, 'resources'));
      await createPackagedApplicationArchive(appOutDir);
      mutate(archiveRoot);
      await assert.rejects(
        packagedVerifier.verifyPackagedArchive({ appOutDir, architecture: 'x64' }),
        error => error?.code === 'EXTRACTOR_UNAVAILABLE'
      );
    });
  }
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-packaged-arm64-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  copyPackagedResources(path.join(appOutDir, 'resources'));
  await createPackagedApplicationArchive(appOutDir);
  await assert.rejects(
    packagedVerifier.verifyPackagedArchive({ appOutDir, architecture: 'arm64' }),
    error => error?.code === 'EXTRACTOR_UNAVAILABLE'
  );
});

test('afterPack propagates archive verification failures', async (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-after-pack-failure-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  await assert.rejects(afterPack.default({
    electronPlatformName: 'win32',
    arch: 1,
    appOutDir,
    packager: { appInfo: { version: '26.6.1' } }
  }), error => error?.code === 'EXTRACTOR_UNAVAILABLE');
});
