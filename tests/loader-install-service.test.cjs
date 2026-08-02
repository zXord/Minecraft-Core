const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  getLoaderVersions,
  installServerLoader,
  __testUtils: {
    getForgeArtifactVersion,
    getForgeInstallerPath,
    isForgeInstallerOpenError,
    resolveJavaMajor,
    runBoundedProcess,
    publishStagedRuntime
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

test('existing options-object loader installation and exact version listing remain backward compatible', async () => {
  assert.deepEqual(await getLoaderVersions('vanilla', '1.20.1'), []);
  assert.deepEqual(await installServerLoader({
    targetPath: path.resolve('C:', 'Minecraft', 'Server'),
    minecraftVersion: '1.20.1',
    loader: 'vanilla'
  }), {
    success: true,
    loader: 'vanilla',
    loaderVersion: null
  });
});

test('the positional install compatibility overload preserves exact loader identity', async () => {
  const result = await installServerLoader(
    path.resolve('C:', 'Minecraft', 'Server'),
    'vanilla',
    '1.20.1',
    null,
    {}
  );
  assert.equal(result.loader, 'vanilla');
  assert.equal(result.loaderVersion, null);
});

test('Java major resolution preserves the 1.20.4 and 1.20.5 boundary', async () => {
  const resolver = async (minecraftVersion) => ({
    requiredJavaVersion: minecraftVersion === '1.20.4' ? 17 : 21,
    source: 'test-mojang-metadata'
  });
  assert.equal(await resolveJavaMajor('1.20.4', resolver), 17);
  assert.equal(await resolveJavaMajor('1.20.5', resolver), 21);
});

test('unknown loaders fail explicitly instead of behaving as Vanilla', async () => {
  await assert.rejects(
    installServerLoader({
      targetPath: path.resolve('C:', 'Minecraft', 'Server'),
      minecraftVersion: '1.20.1',
      loader: 'unknown-loader',
      loaderVersion: '1.0.0'
    }),
    error => error.code === 'UNSUPPORTED_LOADER'
  );
});

test('bounded installer termination waits for child exit before rejecting', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let exited = false;
  child.kill = () => {
    setTimeout(() => {
      child.emit('error', new Error('termination in progress'));
    }, 5);
    setTimeout(() => {
      exited = true;
      child.emit('exit', null, 'SIGTERM');
    }, 25);
    return true;
  };
  const startedAt = Date.now();
  await assert.rejects(runBoundedProcess({
    command: path.resolve('C:', 'managed-java', 'bin', 'java.exe'),
    args: ['-jar', path.resolve('C:', 'runtime', 'installer.jar')],
    cwd: path.resolve('C:', 'runtime'),
    timeoutMs: 5,
    spawnImpl: () => child
  }), error => error.code === 'RUNTIME_INCOMPLETE');
  assert.equal(exited, true);
  assert.ok(Date.now() - startedAt >= 20);
});

test('failed publish rollback retains the only backup when restore itself fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-publish-rollback-'));
  const target = path.join(root, 'target');
  const workspace = path.join(target, '.minecraft-core-state', 'runtime-staging', 'fixture');
  const stage = path.join(workspace, 'server');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(target, 'server.jar'), 'old-runtime');
  fs.writeFileSync(path.join(stage, 'server.jar'), 'new-runtime');
  try {
    let restoreAttempted = false;
    assert.throws(() => publishStagedRuntime(stage, target, workspace, () => {
      throw Object.assign(new Error('verification failed'), { code: 'RUNTIME_INCOMPLETE' });
    }, {
      renameFile(source, destination) {
        if (source.includes(`${path.sep}backup${path.sep}`) && destination === path.join(target, 'server.jar')) {
          restoreAttempted = true;
          throw new Error('restore blocked');
        }
        fs.renameSync(source, destination);
      }
    }), error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true);
    assert.equal(restoreAttempted, true);
    assert.equal(fs.readFileSync(path.join(workspace, 'backup', 'server.jar'), 'utf8'), 'old-runtime');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
