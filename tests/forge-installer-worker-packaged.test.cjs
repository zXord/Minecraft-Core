const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const {
  createForgeInstallerWorkerClient
} = require('../electron/services/forge-installer-worker-client.cjs');

test('the production Forge installer worker resolves its default installer dependency from app.asar', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-installer-asar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const archivePath = path.join(root, 'resources', 'app.asar');
  const repositoryRoot = path.resolve(__dirname, '..');
  for (const relativePath of [
    'electron/services/runtime-diagnostic.cjs',
    'electron/services/forge-installer-worker-protocol.cjs',
    'electron/services/forge-installer-worker.cjs'
  ]) {
    const destination = path.join(sourceRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, ...relativePath.split('/')), destination);
  }

  const dependencyRoot = path.join(sourceRoot, 'node_modules', '@xmcl', 'installer');
  fs.mkdirSync(dependencyRoot, { recursive: true });
  fs.writeFileSync(path.join(dependencyRoot, 'package.json'), JSON.stringify({
    name: '@xmcl/installer', version: '0.0.0-packaged-test', main: 'index.js'
  }));
  fs.writeFileSync(path.join(dependencyRoot, 'index.js'), String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    exports.installForgeTask = (version, targetPath, options) => ({
      async startAndWait() {
        fs.writeFileSync(path.join(targetPath, '.packaged-forge-installer.json'), JSON.stringify({
          source: 'app.asar-default-module', version, targetPath, options,
          ownedSpawnType: typeof options.spawn
        }));
      },
      async cancel() {}
    });
  `);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  await asar.createPackage(sourceRoot, archivePath);

  const targetPath = path.join(root, 'server');
  const javaPath = path.join(root, 'java', 'bin', 'java.exe');
  fs.mkdirSync(targetPath);
  fs.mkdirSync(path.dirname(javaPath), { recursive: true });
  fs.writeFileSync(javaPath, 'not executed');
  const canonicalTarget = fs.realpathSync.native(targetPath);
  const canonicalJava = fs.realpathSync.native(javaPath);
  const runForgeInstaller = createForgeInstallerWorkerClient({
    execPath: require('electron'),
    workerPath: path.join(archivePath, 'electron', 'services', 'forge-installer-worker.cjs')
  });

  assert.deepEqual(await runForgeInstaller({
    targetPath: canonicalTarget,
    minecraftVersion: '1.20.1',
    loaderVersion: '47.3.0',
    javaPath: canonicalJava,
    timeoutMs: 5000
  }), { success: true });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(targetPath, '.packaged-forge-installer.json'), 'utf8')),
    {
      source: 'app.asar-default-module',
      version: { version: '47.3.0', mcversion: '1.20.1' },
      targetPath: canonicalTarget,
      options: { side: 'server', java: canonicalJava },
      ownedSpawnType: 'function'
    }
  );
});
