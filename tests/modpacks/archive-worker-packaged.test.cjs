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
const COMMITTED_WORKER = Object.freeze({
  size: 67764851,
  sha256: '279e3beb4c2b7e9425b7768be27764661eb53ff6e8d7b6da8823c3bfaff58083'
});
const PROCESS_LAUNCHERS = Object.freeze(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

async function withoutProcessLaunches(action) {
  const originals = Object.fromEntries(PROCESS_LAUNCHERS.map(name => [name, childProcess[name]]));
  const launched = [];
  for (const name of PROCESS_LAUNCHERS) {
    childProcess[name] = () => {
      launched.push(name);
      throw new Error(`${name} must not run during source identity verification`);
    };
  }
  try {
    return { result: await action(), launched };
  } finally {
    Object.assign(childProcess, originals);
  }
}

function copySourceArchiveTree(root) {
  for (const relativePath of ['build-resources/archive-runtime', 'vendor/archive-worker/x64']) {
    fs.cpSync(path.join(repositoryRoot, relativePath), path.join(root, relativePath), { recursive: true });
  }
  fs.cpSync(path.join(repositoryRoot, 'native', 'ArchiveWorker'), path.join(root, 'native', 'ArchiveWorker'), {
    recursive: true,
    filter: source => !(['bin', 'obj'].includes(path.basename(source)) && fs.lstatSync(source).isDirectory())
  });
  fs.copyFileSync(
    path.join(repositoryRoot, 'native', 'archive-worker-source-digest.json'),
    path.join(root, 'native', 'archive-worker-source-digest.json')
  );
}

function rewriteLineEndings(filePath, lineEnding) {
  const text = fs.readFileSync(filePath, 'latin1').replaceAll('\r\n', '\n');
  fs.writeFileSync(filePath, lineEnding === '\n' ? text : text.replaceAll('\n', lineEnding), 'latin1');
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? listFiles(path.join(directory, entry.name))
    : [path.join(directory, entry.name)]);
}

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
      runtimeMode: 'in-memory-single-file',
      size: 67764851,
      sha256: '279e3beb4c2b7e9425b7768be27764661eb53ff6e8d7b6da8823c3bfaff58083'
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

test('source archive identity proves the committed worker and its sources without launching a process', { timeout: 60000 }, async () => {
  assert.equal(typeof packagedVerifier.verifySourceArchiveIdentity, 'function', 'verifySourceArchiveIdentity is required');
  const record = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'native', 'archive-worker-source-digest.json'), 'utf8'));
  assert.deepEqual(record.worker, COMMITTED_WORKER, 'the source digest names the committed worker');
  assert.equal(record.source, 'native/ArchiveWorker');

  const { result: evidence, launched } = await withoutProcessLaunches(() => packagedVerifier.verifySourceArchiveIdentity({ repositoryRoot }));

  assert.deepEqual(launched, []);
  assert.deepEqual(evidence, {
    type: 'source-archive-identity',
    version: 1,
    worker: COMMITTED_WORKER,
    source: { root: 'native/ArchiveWorker', files: Object.keys(record.files).length, sha256: record.sha256 }
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.worker), true);
});

test('verify:archive-worker reports the verified identity and refuses unknown options', { timeout: 60000 }, () => {
  const script = path.join(repositoryRoot, 'scripts', 'verify-packaged-archive.cjs');
  const verified = childProcess.spawnSync(process.execPath, [script, '--source-identity'], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 60000
  });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, new RegExp(`ArchiveWorker\\.exe \\(${COMMITTED_WORKER.size} bytes, sha256 ${COMMITTED_WORKER.sha256}\\)`, 'u'));
  const refused = childProcess.spawnSync(process.execPath, [script, '--source-identty'], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 60000
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Usage:/u);
});

test('source archive identity rejects line-ending drift, a changed worker, stray files and unrebuilt source changes', { timeout: 120000 }, async (t) => {
  assert.equal(typeof packagedVerifier.verifySourceArchiveIdentity, 'function', 'verifySourceArchiveIdentity is required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-source-archive-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  copySourceArchiveTree(root);
  const manifestsRoot = path.join(root, 'build-resources', 'archive-runtime');
  const workerPath = path.join(root, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe');
  const sourceRoot = path.join(root, 'native', 'ArchiveWorker');
  const digestPath = path.join(root, 'native', 'archive-worker-source-digest.json');
  const verify = () => packagedVerifier.verifySourceArchiveIdentity({ repositoryRoot: root });
  const unavailable = error => error?.code === 'EXTRACTOR_UNAVAILABLE';

  assert.deepEqual((await verify()).worker, COMMITTED_WORKER);

  const restoreFile = filePath => {
    const bytes = fs.readFileSync(filePath);
    return () => fs.writeFileSync(filePath, bytes);
  };
  const mutations = {
    'CRLF manifest copy': () => {
      const manifestPath = path.join(manifestsRoot, 'archive-worker-x64.json');
      const restore = restoreFile(manifestPath);
      rewriteLineEndings(manifestPath, '\r\n');
      return restore;
    },
    'appended worker byte': () => {
      fs.appendFileSync(workerPath, Buffer.from([0]));
      return () => fs.truncateSync(workerPath, COMMITTED_WORKER.size);
    },
    'stray manifest stage file': () => {
      const stray = path.join(manifestsRoot, '.archive-worker-x64.stage-0123456789abcdef0123456789abcdef.json');
      fs.writeFileSync(stray, '{}\n');
      return () => fs.rmSync(stray);
    },
    'stray worker stage file': () => {
      const stray = path.join(path.dirname(workerPath), '.ArchiveWorker.stage-0123456789abcdef0123456789abcdef.exe');
      fs.writeFileSync(stray, 'MZ');
      return () => fs.rmSync(stray);
    },
    'changed source without a rebuild': () => {
      const programPath = path.join(sourceRoot, 'Program.cs');
      const restore = restoreFile(programPath);
      fs.appendFileSync(programPath, '\n// changed after the worker was built\n');
      return restore;
    },
    'added source file': () => {
      const added = path.join(sourceRoot, 'Security', 'Unreviewed.cs');
      fs.writeFileSync(added, 'namespace MinecraftCore.ArchiveWorker;\n');
      return () => fs.rmSync(added);
    },
    'removed source file': () => {
      const removed = path.join(sourceRoot, 'Security', 'Redaction.cs');
      const restore = restoreFile(removed);
      fs.rmSync(removed);
      return restore;
    },
    'source digest for another worker': () => {
      const restore = restoreFile(digestPath);
      const record = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
      record.worker.sha256 = '0'.repeat(64);
      fs.writeFileSync(digestPath, `${JSON.stringify(record, null, 2)}\n`);
      return restore;
    },
    'source digest with an unknown field': () => {
      const restore = restoreFile(digestPath);
      const record = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
      record.reviewed = true;
      fs.writeFileSync(digestPath, `${JSON.stringify(record, null, 2)}\n`);
      return restore;
    },
    'missing source digest': () => {
      const restore = restoreFile(digestPath);
      fs.rmSync(digestPath);
      return restore;
    }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const restore = mutate();
    try {
      await assert.rejects(verify(), unavailable, name);
    } finally {
      restore();
    }
  }

  // A fresh CRLF checkout re-encodes every source file; the LF-normalised digest is unchanged.
  for (const filePath of listFiles(sourceRoot)) rewriteLineEndings(filePath, '\r\n');
  assert.deepEqual((await verify()).worker, COMMITTED_WORKER);
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

test('afterPack aborts a valid Windows package when its expected executable is missing', { timeout: 120000 }, async (t) => {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-after-pack-missing-exe-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  copyPackagedResources(path.join(appOutDir, 'resources'));
  await createPackagedApplicationArchive(appOutDir);

  await assert.rejects(afterPack.default({
    electronPlatformName: 'win32',
    arch: 1,
    appOutDir,
    packager: { appInfo: { version: '26.6.1' } }
  }), error => error?.code === 'PACKAGED_EXECUTABLE_MISSING');
});
