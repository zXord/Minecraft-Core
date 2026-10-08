const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const AdmZip = require('adm-zip');
const {
  createJavaArchiveWorkerClient
} = require('../electron/services/java-archive-worker-client.cjs');

test('the authenticated Java archive worker executes from app.asar under Electron', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-java-archive-asar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const archivePath = path.join(root, 'resources', 'app.asar');
  const repositoryRoot = path.resolve(__dirname, '..');
  const packagedFiles = [
    'electron/services/java-archive-worker-protocol.cjs',
    'tests/fixtures/slow-java-archive-worker.cjs'
  ];
  for (const relativePath of packagedFiles) {
    const destination = path.join(sourceRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, ...relativePath.split('/')), destination);
  }
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(sourceRoot, archivePath);

  const javaRoot = path.join(root, 'java');
  const tempRoot = path.join(javaRoot, 'temp');
  const runtimeArchive = path.join(tempRoot, 'runtime.zip');
  fs.mkdirSync(tempRoot, { recursive: true });
  const archiveBytes = Buffer.from('java');
  fs.writeFileSync(runtimeArchive, archiveBytes);
  const runJavaArchive = createJavaArchiveWorkerClient({
    execPath: require('electron'),
    workerPath: path.join(archivePath, 'tests', 'fixtures', 'slow-java-archive-worker.cjs')
  });
  const result = await runJavaArchive({
    rootPath: fs.realpathSync.native(javaRoot),
    archivePath: fs.realpathSync.native(runtimeArchive),
    destinationPath: path.join(javaRoot, 'java-17'),
    maxArchiveBytes: 1024,
    expectedArchiveSize: archiveBytes.length,
    expectedSha256: crypto.createHash('sha256').update(archiveBytes).digest('hex'),
    timeoutMs: 5000
  });

  assert.deepEqual(result, {
    entryCount: 1,
    expandedBytes: '4',
    javaExecutableRelativePath: 'bin/java.exe'
  });
  assert.equal(fs.readFileSync(path.join(javaRoot, 'java-17', 'bin', 'java.exe'), 'utf8'), 'java');
});

test('the production Java ZIP worker and AdmZip execute from app.asar under Electron', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-java-production-asar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const archivePath = path.join(root, 'resources', 'app.asar');
  const repositoryRoot = path.resolve(__dirname, '..');
  const packagedFiles = [
    'electron/services/java-archive-worker-protocol.cjs',
    'electron/services/java-archive-worker.cjs',
    'electron/services/modpacks/limits.cjs',
    'electron/services/modpacks/errors.cjs',
    'electron/services/modpacks/windows-basename.cjs',
    'electron/services/modpacks/archive/archive-entry-policy.cjs'
  ];
  for (const relativePath of packagedFiles) {
    const destination = path.join(sourceRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, ...relativePath.split('/')), destination);
  }
  fs.cpSync(path.join(repositoryRoot, 'node_modules', 'adm-zip'),
    path.join(sourceRoot, 'node_modules', 'adm-zip'), { recursive: true });
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(sourceRoot, archivePath);

  const javaRoot = path.join(root, 'java');
  const tempRoot = path.join(javaRoot, 'temp');
  const runtimeArchive = path.join(tempRoot, 'runtime.zip');
  fs.mkdirSync(tempRoot, { recursive: true });
  const zip = new AdmZip();
  const executableRelativePath = `jdk/bin/${process.platform === 'win32' ? 'java.exe' : 'java'}`;
  zip.addFile(executableRelativePath, Buffer.from('java'));
  zip.writeZip(runtimeArchive);
  const archiveBytes = fs.readFileSync(runtimeArchive);
  const runJavaArchive = createJavaArchiveWorkerClient({
    execPath: require('electron'),
    workerPath: path.join(archivePath, 'electron', 'services', 'java-archive-worker.cjs')
  });
  const result = await runJavaArchive({
    rootPath: fs.realpathSync.native(javaRoot),
    archivePath: fs.realpathSync.native(runtimeArchive),
    destinationPath: path.join(javaRoot, 'java-17'),
    maxArchiveBytes: 1024 * 1024,
    expectedArchiveSize: archiveBytes.length,
    expectedSha256: crypto.createHash('sha256').update(archiveBytes).digest('hex'),
    timeoutMs: 5000
  });

  assert.equal(result.javaExecutableRelativePath, executableRelativePath);
  assert.equal(fs.readFileSync(
    path.join(javaRoot, 'java-17', ...result.javaExecutableRelativePath.split('/')),
    'utf8'
  ), 'java');
});
