const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { JavaManager } = require('../electron/services/minecraft-launcher/java-manager.cjs');

function createFakeRuntime(javaBaseDir, version) {
  const binDir = path.join(javaBaseDir, `java-${version}`, 'bin');
  const javaBinary = process.platform === 'win32' ? 'java.exe' : 'java';
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, javaBinary), '');
  return path.join(binDir, javaBinary);
}

test('JavaManager cleanup keeps the active scoped runtime and removes stale local versions', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-java-'));
  const manager = new JavaManager(tempRoot);

  try {
    createFakeRuntime(manager.javaBaseDir, '17');
    const activeJavaPath = createFakeRuntime(manager.javaBaseDir, '21');

    const cleanup = await manager.cleanupUnusedJavaVersions(17, activeJavaPath);

    assert.equal(cleanup.success, true);
    assert.deepEqual(cleanup.cleanedVersions, ['17']);
    assert.deepEqual(cleanup.keptVersions, ['21']);
    assert.ok(fs.existsSync(path.join(manager.javaBaseDir, 'java-21')), 'active runtime should remain');
    assert.ok(!fs.existsSync(path.join(manager.javaBaseDir, 'java-17')), 'stale runtime should be removed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('JavaManager cleanup skips shared global caches', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-java-global-'));
  const manager = new JavaManager();
  manager.javaBaseDir = tempRoot;

  try {
    const activeJavaPath = createFakeRuntime(manager.javaBaseDir, '25');
    createFakeRuntime(manager.javaBaseDir, '21');

    const cleanup = await manager.cleanupUnusedJavaVersions(25, activeJavaPath);

    assert.equal(cleanup.success, true);
    assert.equal(cleanup.skipped, true);
    assert.equal(cleanup.reason, 'shared-java-directory');
    assert.ok(fs.existsSync(path.join(manager.javaBaseDir, 'java-25')), 'shared active runtime should remain');
    assert.ok(fs.existsSync(path.join(manager.javaBaseDir, 'java-21')), 'shared cache should not be pruned');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
