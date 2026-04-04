const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const { readServerConfig } = require('../electron/utils/config-manager.cjs');

function createTempServerDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-config-'));
}

function writeBundledServerJar(serverDir, { version, javaVersion, javaComponent = null }) {
  const zip = new AdmZip();
  zip.addFile('version.json', Buffer.from(JSON.stringify({
    id: version,
    name: version,
    java_version: javaVersion,
    java_component: javaComponent
  }), 'utf8'));
  zip.writeZip(path.join(serverDir, 'server.jar'));
}

test('readServerConfig prefers bundled server metadata for automatically detected configs', (t) => {
  const serverDir = createTempServerDir();
  t.after(() => {
    fs.rmSync(serverDir, { recursive: true, force: true });
  });

  writeBundledServerJar(serverDir, {
    version: '26.1',
    javaVersion: 25,
    javaComponent: 'java-runtime-epsilon'
  });

  fs.writeFileSync(path.join(serverDir, '.minecraft-core.json'), JSON.stringify({
    version: '1.21.11',
    loader: 'fabric',
    loaderVersion: '0.18.4',
    detectionMethod: 'automatic'
  }, null, 2));

  const config = readServerConfig(serverDir);

  assert.equal(config.version, '26.1');
  assert.equal(config.javaVersion, 25);
  assert.equal(config.javaComponent, 'java-runtime-epsilon');
  assert.equal(config.detectionMethod, 'automatic');
});

test('readServerConfig keeps manual version overrides intact while still exposing runtime java metadata', (t) => {
  const serverDir = createTempServerDir();
  t.after(() => {
    fs.rmSync(serverDir, { recursive: true, force: true });
  });

  writeBundledServerJar(serverDir, {
    version: '26.1',
    javaVersion: 25,
    javaComponent: 'java-runtime-epsilon'
  });

  fs.writeFileSync(path.join(serverDir, '.minecraft-core.json'), JSON.stringify({
    version: '1.21.11',
    loader: 'fabric',
    loaderVersion: '0.18.4',
    detectionMethod: 'manual'
  }, null, 2));

  const config = readServerConfig(serverDir);

  assert.equal(config.version, '1.21.11');
  assert.equal(config.javaVersion, 25);
  assert.equal(config.javaComponent, 'java-runtime-epsilon');
  assert.equal(config.detectionMethod, 'manual');
});
