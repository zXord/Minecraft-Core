const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  __testUtils: {
    getForgeArtifactVersion,
    getForgeInstallerPath,
    isForgeInstallerOpenError
  }
} = require('../electron/services/loader-install-service.cjs');

test('getForgeArtifactVersion normalizes modern Forge versions', () => {
  assert.equal(getForgeArtifactVersion('1.20.1', '47.4.18'), '1.20.1-47.4.18');
  assert.equal(getForgeArtifactVersion('1.20.1', '1.20.1-47.4.18'), '1.20.1-47.4.18');
});

test('getForgeInstallerPath resolves the expected Forge installer jar path', () => {
  const targetPath = path.join('C:', 'Minecraft', 'Client');
  const installerPath = getForgeInstallerPath(targetPath, '1.20.1', '47.4.18');

  assert.equal(
    installerPath,
    path.join(
      targetPath,
      'libraries',
      'net',
      'minecraftforge',
      'forge',
      '1.20.1-47.4.18',
      'forge-1.20.1-47.4.18-installer.jar'
    )
  );
});

test('isForgeInstallerOpenError only matches installer access failures for the expected path', () => {
  const installerPath = path.join(
    'C:',
    'Minecraft',
    'Client',
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    '1.20.1-47.4.18',
    'forge-1.20.1-47.4.18-installer.jar'
  );

  assert.equal(
    isForgeInstallerOpenError(
      new Error(`EPERM: operation not permitted, open '${installerPath}'`),
      installerPath
    ),
    true
  );

  assert.equal(
    isForgeInstallerOpenError(
      new Error(`ENOENT: no such file or directory, open '${installerPath}'`),
      installerPath
    ),
    false
  );

  assert.equal(
    isForgeInstallerOpenError(
      new Error("EPERM: operation not permitted, open 'C:\\other\\path\\installer.jar'"),
      installerPath
    ),
    false
  );
});
