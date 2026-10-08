'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { createClientRuntimeWorkerClient } = require('../../electron/services/client-modpacks/client-runtime-worker-client.cjs');
test('packaged client runtime worker loads production dependencies in isolated Electron Node mode', { timeout: 20000 }, async t => {
  const repository = path.resolve(__dirname, '../..');
  const fixtureName = 'tests/fixtures/client-runtime-packaged-fixture.cjs';
  assert.equal(fs.existsSync(path.join(repository, fixtureName)), true, 'safe packaged fixture must exist');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'client-runtime-asar-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const resources = path.join(root, 'resources'); const archive = path.join(resources, 'app.asar');
  fs.mkdirSync(resources, { recursive: true }); fs.cpSync(path.join(repository, 'electron'), path.join(source, 'electron'), { recursive: true });
  fs.mkdirSync(path.join(source, 'tests/fixtures'), { recursive: true }); fs.copyFileSync(path.join(repository, fixtureName), path.join(source, fixtureName));
  await asar.createPackage(source, archive);
  // This fixture proves relative app.asar requires plus installed dependency
  // compatibility. It does not claim electron-builder's full dependency bundle.
  fs.symlinkSync(path.join(repository, 'node_modules'), path.join(resources, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const clientPath = path.join(root, 'candidate'); fs.mkdirSync(clientPath); const progress = [];
  const run = createClientRuntimeWorkerClient({ execPath: require('electron'), workerPath: path.join(archive, fixtureName) });
  assert.deepEqual(await run({ clientPath, runtime: { minecraftVersion: '1.20.1', loaderFamily: 'forge', loaderVersion: '47.4.13', javaMajor: 17, os: 'win32', architecture: 'x64' }, onProgress: event => progress.push(event), timeoutMs: 10000 }), { quiescent: true });
  assert.equal(fs.readFileSync(path.join(clientPath, '.runtime-require-fixture'), 'utf8'), 'loaded');
  assert.deepEqual(progress, [{ phase: 'libraries', files: 4, totalFiles: 4 }]);
});
