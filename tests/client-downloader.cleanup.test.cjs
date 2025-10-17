const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClientDownloader } = require('../electron/services/minecraft-launcher/client-downloader.cjs');

function createDownloader() {
  const noopEmitter = { emit() {} };
  const stubJavaManager = {
    ensureJava: async () => ({ success: true, javaPath: '' })
  };

  return new ClientDownloader(stubJavaManager, noopEmitter);
}

test('ClientDownloader keeps current fabric profile during cleanup when loader version provided', () => {
  const downloader = createDownloader();
  const minecraftVersion = '1.21.1';
  const loaderVersion = '0.15.9';
  const fabricProfile = `fabric-loader-${loaderVersion}-${minecraftVersion}`;

  const result = downloader.shouldKeepVersion(fabricProfile, minecraftVersion, loaderVersion);
  assert.equal(result.keep, true);
  assert.equal(result.reason, 'Current Fabric version');

  const fullProfileResult = downloader.shouldKeepVersion(
    fabricProfile,
    minecraftVersion,
    fabricProfile
  );
  assert.equal(fullProfileResult.keep, true);
});

test('ClientDownloader cleanup preserves active fabric profile and removes older entries', async () => {
  const downloader = createDownloader();
  const minecraftVersion = '1.21.1';
  const loaderVersion = '0.15.9';
  const fabricProfile = `fabric-loader-${loaderVersion}-${minecraftVersion}`;
  const oldFabricProfile = `fabric-loader-0.15.8-${minecraftVersion}`;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-client-'));
  const versionsDir = path.join(tempRoot, 'versions');

  try {
    fs.mkdirSync(path.join(versionsDir, minecraftVersion), { recursive: true });
    fs.mkdirSync(path.join(versionsDir, fabricProfile), { recursive: true });
    fs.mkdirSync(path.join(versionsDir, oldFabricProfile), { recursive: true });

    await downloader.cleanupOldVersions(tempRoot, minecraftVersion, loaderVersion);

    assert.ok(fs.existsSync(path.join(versionsDir, minecraftVersion)), 'Vanilla folder should remain');
    assert.ok(fs.existsSync(path.join(versionsDir, fabricProfile)), 'Current fabric profile should remain');
    assert.ok(!fs.existsSync(path.join(versionsDir, oldFabricProfile)), 'Outdated fabric profile should be removed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
