const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const afterPack = require('../../scripts/afterPack.cjs');
const rcedit = require('rcedit');
const repositoryRoot = path.resolve(__dirname, '..', '..');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-after-pack-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    appOutDir: path.join(root, 'win-unpacked'),
    iconPath: path.join(root, 'icon.ico')
  };
}

function createCompleteFixture(t) {
  const fixture = createFixture(t);
  fs.mkdirSync(fixture.appOutDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.appOutDir, 'Minecraft Core.exe'), 'packaged-executable');
  fs.writeFileSync(fixture.iconPath, 'expected-icon');
  return fixture;
}

test('Windows executable hardening rejects a missing packaged executable', async (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(fixture.appOutDir, { recursive: true });
  fs.writeFileSync(fixture.iconPath, 'expected-icon');

  await assert.rejects(
    afterPack.hardenWindowsExecutable({
      appOutDir: fixture.appOutDir,
      iconPath: fixture.iconPath,
      version: '26.6.1'
    }),
    error => error?.code === 'PACKAGED_EXECUTABLE_MISSING'
  );
});

test('Windows executable hardening rejects a missing source icon', async (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(fixture.appOutDir, { recursive: true });
  fs.writeFileSync(path.join(fixture.appOutDir, 'Minecraft Core.exe'), 'packaged-executable');

  await assert.rejects(
    afterPack.hardenWindowsExecutable({
      appOutDir: fixture.appOutDir,
      iconPath: fixture.iconPath,
      version: '26.6.1'
    }),
    error => error?.code === 'PACKAGED_ICON_MISSING'
  );
});

test('Windows executable hardening rejects when every resource editor fails', async (t) => {
  const fixture = createCompleteFixture(t);

  await assert.rejects(
    afterPack.hardenWindowsExecutable({
      appOutDir: fixture.appOutDir,
      iconPath: fixture.iconPath,
      version: '26.6.1'
    }, {
      editStrategies: [
        { name: 'primary', attempts: 2, edit: async () => { throw new Error('primary failed'); } },
        { name: 'fallback', attempts: 1, edit: async () => { throw new Error('fallback failed'); } }
      ],
      verifyEmbeddedIcon: async () => { throw new Error('verification must not run'); },
      delay: async () => {},
      logger: { log() {}, error() {} }
    }),
    error => error?.code === 'PACKAGED_ICON_EMBED_FAILED' && error?.cause?.message === 'fallback failed'
  );
});

test('Windows executable hardening rejects an editor success whose native icon cannot be verified', async (t) => {
  const fixture = createCompleteFixture(t);

  await assert.rejects(
    afterPack.hardenWindowsExecutable({
      appOutDir: fixture.appOutDir,
      iconPath: fixture.iconPath,
      version: '26.6.1'
    }, {
      editStrategies: [
        { name: 'editor', attempts: 1, edit: async () => {} }
      ],
      verifyEmbeddedIcon: async () => {
        const error = new Error('native icon differs');
        error.code = 'PACKAGED_ICON_VERIFICATION_FAILED';
        throw error;
      },
      delay: async () => {},
      logger: { log() {}, error() {} }
    }),
    error => error?.code === 'PACKAGED_ICON_VERIFICATION_FAILED' && error?.message === 'native icon differs'
  );
});

test('Windows executable hardening succeeds only after the edited resource matches the source icon', async (t) => {
  const fixture = createCompleteFixture(t);

  const evidence = await afterPack.hardenWindowsExecutable({
    appOutDir: fixture.appOutDir,
    iconPath: fixture.iconPath,
    version: '26.6.1'
  }, {
    editStrategies: [{
      name: 'fixture-editor',
      attempts: 1,
      edit: async ({ exePath, iconPath }) => fs.copyFileSync(iconPath, exePath)
    }],
    verifyEmbeddedIcon: async ({ exePath, iconPath }) => {
      assert.deepEqual(fs.readFileSync(exePath), fs.readFileSync(iconPath));
    },
    delay: async () => {},
    logger: { log() {}, error() {} }
  });

  assert.deepEqual(evidence, {
    type: 'windows-executable-icon-verification',
    version: 1,
    status: 'verified'
  });
  assert.equal(Object.isFrozen(evidence), true);
});

test('native Windows verification distinguishes the Electron icon from the embedded application icon', {
  skip: process.platform !== 'win32',
  timeout: 30000
}, async (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(fixture.appOutDir, { recursive: true });
  const exePath = path.join(fixture.appOutDir, 'Minecraft Core.exe');
  fs.copyFileSync(path.join(repositoryRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), exePath);
  fs.copyFileSync(path.join(repositoryRoot, 'build-resources', 'icon.ico'), fixture.iconPath);

  await assert.rejects(
    afterPack.verifyWindowsExecutableIcon({ exePath, iconPath: fixture.iconPath }),
    error => error?.code === 'PACKAGED_ICON_VERIFICATION_FAILED'
  );

  await rcedit(exePath, { icon: fixture.iconPath });
  const evidence = await afterPack.verifyWindowsExecutableIcon({ exePath, iconPath: fixture.iconPath });
  assert.deepEqual(evidence, {
    type: 'windows-native-icon-verification',
    version: 1,
    status: 'matched'
  });
  assert.equal(Object.isFrozen(evidence), true);
});

test('afterPack leaves non-Windows targets outside Windows executable hardening', async () => {
  const archiveEvidence = Object.freeze({ type: 'archive-verification', status: 'verified' });
  const hook = afterPack.createAfterPackHook({
    verifyPackagedArchive: async () => archiveEvidence,
    hardenWindowsExecutable: async () => { throw new Error('Windows hardening must not run'); }
  });

  const result = await hook({
    electronPlatformName: 'linux',
    arch: 'x64',
    appOutDir: '/tmp/linux-unpacked',
    packager: { appInfo: { version: '26.6.1' } }
  });

  assert.equal(result, archiveEvidence);
});

test('afterPack propagates Windows executable hardening failures after archive verification', async () => {
  const expected = new Error('packaged icon mismatch');
  expected.code = 'PACKAGED_ICON_VERIFICATION_FAILED';
  const hook = afterPack.createAfterPackHook({
    verifyPackagedArchive: async () => Object.freeze({ status: 'verified' }),
    hardenWindowsExecutable: async () => { throw expected; }
  });

  await assert.rejects(hook({
    electronPlatformName: 'win32',
    arch: 'x64',
    appOutDir: 'C:\\fixture\\win-unpacked',
    packager: { appInfo: { version: '26.6.1' } }
  }), error => error === expected);
});

test('production Windows hardening embeds and verifies the repository icon without a full package', {
  skip: process.platform !== 'win32',
  timeout: 30000
}, async (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(fixture.appOutDir, { recursive: true });
  fs.copyFileSync(
    path.join(repositoryRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(fixture.appOutDir, 'Minecraft Core.exe')
  );
  fs.copyFileSync(path.join(repositoryRoot, 'build-resources', 'icon.ico'), fixture.iconPath);

  const evidence = await afterPack.hardenWindowsExecutable({
    appOutDir: fixture.appOutDir,
    iconPath: fixture.iconPath,
    version: '26.6.1'
  });

  assert.deepEqual(evidence, {
    type: 'windows-executable-icon-verification',
    version: 1,
    status: 'verified'
  });
});
