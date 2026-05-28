const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const AdmZip = require('adm-zip');

function forgeToml() {
  return [
    'modLoader="javafml"',
    'loaderVersion="[47,)"',
    'license="MIT"',
    '',
    '[[mods]]',
    'modId="cached_test_mod"',
    'version="1.2.3"',
    'displayName="Cached Test Mod"',
    'description="Used by the manifest cache test"',
    ''
  ].join('\n');
}

async function writeForgeJar(filePath) {
  const zip = new AdmZip();
  zip.addFile('META-INF/mods.toml', Buffer.from(forgeToml()));
  zip.addFile('assets/cached_test_mod/payload.txt', Buffer.from('payload'));
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, zip.toBuffer());
}

async function withModFileManager(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-mod-info-'));
  const originalLoad = Module._load;
  const modulePath = path.resolve(__dirname, '../electron/ipc/mod-utils/mod-file-manager.cjs');

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath() {
            return path.join(root, 'user-data');
          }
        }
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const modFileManager = require(modulePath);
    return await fn(modFileManager, root);
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test('client installed mod info persists parsed jar metadata into a manifest', async () => {
  await withModFileManager(async (modFileManager, root) => {
    const clientPath = path.join(root, 'client');
    const jarName = 'cached-test-mod-1.2.3.jar';
    const manifestPath = path.join(clientPath, 'minecraft-core-manifests', `${jarName}.json`);

    await writeForgeJar(path.join(clientPath, 'mods', jarName));

    const info = await modFileManager.getClientInstalledModInfo(clientPath);

    assert.equal(info.length, 1);
    assert.equal(info[0].name, 'Cached Test Mod');
    assert.equal(fs.existsSync(manifestPath), true);

    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    assert.equal(manifest.fileName, jarName);
    assert.equal(manifest.name, 'Cached Test Mod');
    assert.equal(manifest.versionNumber, '1.2.3');
    assert.equal(typeof manifest.fileSignature, 'string');
  });
});
