const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XMCLClientDownloader = require('../electron/services/minecraft-launcher/xmcl-client-downloader.cjs');

function createDownloader() {
  const noopEmitter = { emit() {}, setMaxListeners() {} };
  const stubJavaManager = {
    ensureJava: async () => ({ success: true, javaPath: '' }),
    setClientPath() {}
  };

  return new XMCLClientDownloader(stubJavaManager, noopEmitter);
}

test('XMCLClientDownloader clearMinecraftClient removes Forge runtime artifacts for the target version', async () => {
  const downloader = createDownloader();
  const minecraftVersion = '1.20.1';
  const loaderVersion = '47.4.18';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-xmcl-client-'));
  const versionsDir = path.join(tempRoot, 'versions');
  const forgeRuntimeDir = path.join(
    tempRoot,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    `${minecraftVersion}-${loaderVersion}`
  );

  try {
    fs.mkdirSync(path.join(versionsDir, `${minecraftVersion}-forge-${loaderVersion}`), { recursive: true });
    fs.mkdirSync(forgeRuntimeDir, { recursive: true });
    fs.writeFileSync(path.join(forgeRuntimeDir, `forge-${minecraftVersion}-${loaderVersion}-installer.jar`), 'jar');

    const result = await downloader.clearMinecraftClient(tempRoot, minecraftVersion);

    assert.equal(result.success, true);
    assert.ok(
      result.clearedItems.some((item) => item.includes('Forge runtime')),
      'expected Forge runtime cleanup to be reported'
    );
    assert.equal(fs.existsSync(forgeRuntimeDir), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('XMCLClientDownloader normalizes Forge loader metadata with a Minecraft-version prefix', async () => {
  const downloader = createDownloader();

  const metadata = downloader.extractLoaderMetadata(
    {
      inheritsFrom: '1.20.1',
      libraries: [
        { name: 'net.minecraftforge:fmlloader:1.20.1-47.4.18' }
      ]
    },
    '1.20.1-forge-47.4.18'
  );

  assert.equal(metadata.loaderType, 'forge');
  assert.equal(metadata.loaderVersion, '47.4.18');
  assert.equal(
    downloader.areLoaderVersionsEquivalent('forge', '1.20.1-47.4.18', '47.4.18', '1.20.1'),
    true
  );
  assert.equal(
    await downloader.resolveRequestedLoaderVersion('forge', '1.20.1-47.4.18', '1.20.1'),
    '47.4.18'
  );
});
