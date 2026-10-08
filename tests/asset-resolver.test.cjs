const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  materializeCachedDevelopmentIcon,
  resolveWindowIconPath
} = require('../electron/utils/asset-resolver.cjs');

test('Windows development windows prefer the build resource ICO over a root PNG fallback', t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-icon-resolution-'));
  const buildResources = path.join(projectRoot, 'build-resources');
  fs.mkdirSync(buildResources);
  fs.writeFileSync(path.join(projectRoot, 'icon.png'), 'png');
  fs.writeFileSync(path.join(buildResources, 'icon.ico'), 'ico');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  assert.equal(
    resolveWindowIconPath({ platform: 'win32', isPackaged: false, projectRoot }),
    path.join(buildResources, 'icon.ico')
  );
});

test('Windows development window resolution returns the userData cache path instead of the checkout path', t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-icon-resolution-cache-'));
  const buildResources = path.join(projectRoot, 'build-resources');
  const userDataPath = path.join(projectRoot, 'user-data');
  fs.mkdirSync(buildResources);
  fs.copyFileSync(path.join(__dirname, '..', 'build-resources', 'icon.ico'), path.join(buildResources, 'icon.ico'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const resolved = resolveWindowIconPath({
    platform: 'win32',
    isPackaged: false,
    projectRoot,
    userDataPath
  });

  assert.equal(path.dirname(resolved), path.join(userDataPath, 'window-icon-cache'));
  assert.deepEqual(fs.readFileSync(resolved), fs.readFileSync(path.join(buildResources, 'icon.ico')));
});

test('Windows development windows fall back to the root PNG only when the ICO is absent', t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-icon-resolution-'));
  fs.writeFileSync(path.join(projectRoot, 'icon.png'), 'png');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  assert.equal(
    resolveWindowIconPath({ platform: 'win32', isPackaged: false, projectRoot }),
    path.join(projectRoot, 'icon.png')
  );
});

test('Windows development materializes the valid repository ICO into an idempotent content-versioned userData cache', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-icon-cache-'));
  const sourcePath = path.join(root, 'repository-icon.ico');
  const userDataPath = path.join(root, 'user-data');
  fs.copyFileSync(path.join(__dirname, '..', 'build-resources', 'icon.ico'), sourcePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const firstPath = materializeCachedDevelopmentIcon({
    platform: 'win32',
    isPackaged: false,
    sourcePath,
    userDataPath
  });
  assert.match(
    firstPath,
    new RegExp(`^${path.join(userDataPath, 'window-icon-cache', 'minecraft-core-').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[a-f0-9]{64}\\.ico$`, 'u')
  );
  assert.deepEqual(fs.readFileSync(firstPath), fs.readFileSync(sourcePath));

  const retainedTime = new Date('2001-02-03T04:05:06.000Z');
  fs.utimesSync(firstPath, retainedTime, retainedTime);
  const retainedMtime = fs.statSync(firstPath).mtimeMs;

  const secondPath = materializeCachedDevelopmentIcon({
    platform: 'win32',
    isPackaged: false,
    sourcePath,
    userDataPath
  });
  assert.equal(secondPath, firstPath);
  assert.equal(fs.statSync(secondPath).mtimeMs, retainedMtime);
});

test('development icon caching safely falls back to the repository icon when userData cannot host the cache', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-icon-cache-fallback-'));
  const sourcePath = path.join(root, 'repository-icon.ico');
  const unavailableUserDataPath = path.join(root, 'not-a-directory');
  fs.copyFileSync(path.join(__dirname, '..', 'build-resources', 'icon.ico'), sourcePath);
  fs.writeFileSync(unavailableUserDataPath, 'occupied');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(materializeCachedDevelopmentIcon({
    platform: 'win32',
    isPackaged: false,
    sourcePath,
    userDataPath: unavailableUserDataPath
  }), sourcePath);
});

test('packaged icon resolution preserves the application resource path without creating a development cache', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-packaged-icon-cache-'));
  const sourcePath = path.join(root, 'packaged-icon.ico');
  const userDataPath = path.join(root, 'user-data');
  fs.copyFileSync(path.join(__dirname, '..', 'build-resources', 'icon.ico'), sourcePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(materializeCachedDevelopmentIcon({
    platform: 'win32',
    isPackaged: true,
    sourcePath,
    userDataPath
  }), sourcePath);
  assert.equal(fs.existsSync(userDataPath), false);
});
