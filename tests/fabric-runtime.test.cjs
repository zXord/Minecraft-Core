const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const { getFabricRuntimeStatus } = require('../electron/utils/fabric-runtime.cjs');

test('Fabric runtime health accepts the legacy embedded server launcher generated for 1.14.4', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-fabric-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'fabric-installer.jar'), 'installer');
  const launch = new AdmZip();
  launch.addFile('META-INF/MANIFEST.MF', Buffer.from(
    'Manifest-Version: 1.0\nMain-Class: net.fabricmc.loader.launch.server.FabricServerLauncher\n\n', 'utf8'
  ));
  launch.addFile('fabric-server-launch.properties', Buffer.from(
    'launch.mainClass=net.fabricmc.loader.launch.knot.KnotServer\n', 'utf8'
  ));
  launch.addFile('net/fabricmc/loader/launch/server/FabricServerLauncher.class', Buffer.from('legacy-launcher'));
  launch.writeZip(path.join(root, 'fabric-server-launch.jar'));

  const status = getFabricRuntimeStatus(root);
  assert.equal(status.hasBlockingIssues, false);
  assert.equal(status.hasEmbeddedLauncherClass, true);
  assert.equal(status.issues.some(issue => issue.code === 'FABRIC_RUNTIME_METADATA_MISSING'), false);
});
