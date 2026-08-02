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

test('bounded installer completion waits for close so all stdio is quiescent', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const pending = runBoundedProcess({
    command: path.resolve('C:', 'managed-java', 'bin', 'java.exe'),
    args: ['-jar', path.resolve('C:', 'runtime', 'installer.jar')],
    cwd: path.resolve('C:', 'runtime'),
    timeoutMs: 1000,
    spawnImpl: () => child
  });
  let settled = false;
  pending.finally(() => { settled = true; });
  child.stdout.emit('data', Buffer.from('before-exit'));
  child.emit('exit', 0, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.stdout.emit('data', Buffer.from('-after-exit'));
  child.stderr.emit('data', Buffer.from('stderr-after-exit'));
  child.emit('close', 0, null);
  assert.deepEqual(await pending, {
    code: 0,
    stdout: 'before-exit-after-exit',
    stderr: 'stderr-after-exit'
  });
});

test('bounded installer kill and error paths settle even when the child never closes', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    queueMicrotask(() => child.emit('error', new Error('kill failed before close')));
    throw new Error('kill failed');
  };
  const pending = runBoundedProcess({
    command: path.resolve('C:', 'managed-java', 'bin', 'java.exe'),
    args: ['-jar', path.resolve('C:', 'runtime', 'installer.jar')],
    cwd: path.resolve('C:', 'runtime'),
    timeoutMs: 5,
    terminationGraceMs: 20,
    spawnImpl: () => child
  });
  const outcome = await Promise.race([
    pending.then(() => ({ resolved: true }), error => ({ error })),
    new Promise(resolve => setTimeout(() => resolve({ testTimeout: true }), 200))
  ]);
  assert.equal(outcome.testTimeout, undefined);
  assert.equal(outcome.error?.code, 'RUNTIME_INCOMPLETE');
  assert.equal(outcome.error?.preserveWorkspace, true);
});

test('bounded installer stream errors are contained and still wait for close', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const pending = runBoundedProcess({
    command: path.resolve('C:', 'managed-java', 'bin', 'java.exe'),
    args: ['-jar', path.resolve('C:', 'runtime', 'installer.jar')],
    cwd: path.resolve('C:', 'runtime'),
    timeoutMs: 1000,
    spawnImpl: () => child
  });
  let settled = false;
  pending.catch(() => { settled = true; });
  child.stdout.emit('error', new Error('stream failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, error => error.code === 'RUNTIME_INCOMPLETE');
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
