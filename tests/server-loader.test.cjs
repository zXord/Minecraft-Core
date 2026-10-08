const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const { resolveServerLoader } = require('../electron/utils/server-loader.cjs');

function writeJar(filePath, manifestLines = ['Manifest-Version: 1.0', '', '']) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const archive = new AdmZip();
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from(manifestLines.join('\r\n'), 'utf8'));
  archive.addFile('fixture.class', Buffer.from('fixture'));
  archive.writeZip(filePath);
}

function artifact(root, relativePath) {
  const bytes = fs.readFileSync(path.join(root, ...relativePath.split('/')));
  return {
    relativePath,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(bytes).digest('hex')
  };
}

function writeLegacyMarker(root, loaderOverrides = {}) {
  const runtime = {
    minecraftVersion: '1.12.2',
    loaderFamily: 'forge',
    loaderVersion: '14.23.5.2860',
    javaMajor: 8,
    os: 'win32',
    architecture: 'x64'
  };
  const launchJar = 'forge-1.12.2-14.23.5.2860.jar';
  const serverJar = 'minecraft_server.1.12.2.jar';
  const libraries = ['libraries/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar'];
  writeJar(path.join(root, ...libraries[0].split('/')));
  writeJar(path.join(root, serverJar));
  writeJar(path.join(root, launchJar), [
    'Manifest-Version: 1.0',
    'Main-Class: net.minecraftforge.fml.relauncher.ServerLaunchWrapper',
    `Class-Path: ${libraries[0]} ${serverJar}`,
    '',
    ''
  ]);
  fs.mkdirSync(path.join(root, '.minecraft-core-state'));
  fs.writeFileSync(path.join(root, '.minecraft-core-state', 'runtime.json'), JSON.stringify({
    formatVersion: 1,
    runtime,
    loader: { family: 'forge', launchJar, serverJar, libraries, ...loaderOverrides },
    artifacts: [launchJar, serverJar, ...libraries].map(relativePath => artifact(root, relativePath))
  }));
  return { runtime, launchJar };
}

test('server loader resolves an exact legacy Forge identity only from validated immutable metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-server-loader-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeLegacyMarker(root);
  writeJar(path.join(root, 'forge-1.12.2-14.23.5.9999.jar'));
  fs.writeFileSync(path.join(root, '.minecraft-core.json'), JSON.stringify({ loader: 'vanilla' }));

  assert.deepEqual(resolveServerLoader(root), {
    loader: 'forge',
    loaderVersion: '14.23.5.2860',
    source: 'runtime-metadata'
  });
});

test('server loader rejects a substituted or traversing legacy Forge launch artifact without heuristic fallback', t => {
  for (const replacement of ['forge-1.12.2-14.23.5.9999.jar', '../outside.jar']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-server-loader-reject-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = writeLegacyMarker(root, { launchJar: replacement });
    if (!replacement.includes('..')) writeJar(path.join(root, replacement));
    fs.writeFileSync(path.join(root, 'forge-visible-fallback.jar'), 'not trusted');

    assert.throws(
      () => resolveServerLoader(root),
      error => error.code === 'RUNTIME_INCOMPLETE',
      replacement
    );
    assert.equal(fixture.runtime.loaderFamily, 'forge');
  }
});
