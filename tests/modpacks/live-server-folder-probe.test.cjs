'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LIVE_SERVER_FOLDER_MESSAGE,
  probeLiveServerFolder
} = require('../../electron/services/modpack-lifecycle/live-server-folder-probe.cjs');
const { encodePowerShellCommand, resolveSystemPowerShell } = require('../../electron/watchdog/app-watchdog.cjs');

const windowsLock = {
  skip: process.platform !== 'win32' && 'Java world locks block reads only on Windows',
  timeout: 60000
};

// The same exclusive whole-file byte-range lock Java's FileChannel.lock() takes on world/session.lock.
const LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$lockPath = [Environment]::GetEnvironmentVariable('MC_CORE_TEST_SESSION_LOCK', 'Process')
$share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
$stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, $share)
$stream.Lock(0, [long]::MaxValue)
[Console]::Out.WriteLine('LOCKED')
[Console]::Out.Flush()
$null = [Console]::In.ReadToEnd()
$stream.Close()
`;

function serverFolder(t, { properties = null, worlds = ['world'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-live-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverPath = path.join(root, 'server');
  fs.mkdirSync(serverPath);
  if (properties !== null) fs.writeFileSync(path.join(serverPath, 'server.properties'), properties);
  for (const world of worlds) {
    fs.mkdirSync(path.join(serverPath, world), { recursive: true });
    fs.writeFileSync(path.join(serverPath, world, 'session.lock'), '☃');
  }
  return serverPath;
}

async function holdSessionLock(t, lockPath) {
  const powershell = resolveSystemPowerShell();
  assert.ok(powershell, 'Windows PowerShell is required for the lock fixture');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(LOCK_SCRIPT)], {
    env: { ...process.env, MC_CORE_TEST_SESSION_LOCK: lockPath },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const release = async () => {
    if (!child.stdin.writableEnded) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  t.after(release);
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.includes('LOCKED')) resolve();
    });
    child.once('exit', code => reject(new Error(`session lock fixture exited early (${code})`)));
    child.once('error', reject);
  });
  return { release };
}

function errnoError(code) {
  return Object.assign(new Error(`${code}: fixture`), { code });
}

// A read-only fake of the fs.promises surface the probe uses; every opened path and flag is recorded.
function fakeFs({ properties = null, propertiesError = null, lockError = null, lockReadError = null } = {}) {
  const opened = [];
  return {
    opened,
    fsPromises: {
      async open(filePath, flags) {
        opened.push({ filePath, flags });
        if (path.basename(filePath) === 'server.properties') {
          if (propertiesError) throw errnoError(propertiesError);
          if (properties === null) throw errnoError('ENOENT');
          const bytes = Buffer.isBuffer(properties) ? properties : Buffer.from(properties, 'utf8');
          return {
            async read(buffer, offset, length, position) {
              const bytesRead = Math.max(0, Math.min(length, bytes.length - position));
              bytes.copy(buffer, offset, position, position + bytesRead);
              return { bytesRead, buffer };
            },
            async close() {}
          };
        }
        if (lockError) throw errnoError(lockError);
        return {
          async read() {
            if (lockReadError) throw errnoError(lockReadError);
            return { bytesRead: 1 };
          },
          async close() {}
        };
      }
    }
  };
}

function loadAutoRestart() {
  const modulePath = require.resolve('../../electron/services/auto-restart.cjs');
  const originalLoad = Module._load;
  Module._load = function loadFixture(request, parent, isMain) {
    if (request.endsWith('utils/event-bus.cjs')) return new EventEmitter();
    if (request.endsWith('utils/safe-send.cjs')) return { safeSend() {} };
    if (request.endsWith('utils/app-store.cjs')) return { get() { return null; }, set() {} };
    if (request.endsWith('utils/config-manager.cjs')) {
      return {
        getDefaultServerConfig() { return { autoRestart: { enabled: false, delay: 10, maxCrashes: 3 } }; },
        readServerConfig() { return null; },
        updateServerConfig() { throw new Error('the live-folder probe must not write server config'); }
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

function stopRequest(serverPath) {
  return { instanceId: 'server-one', jobId: 'job-live-folder', operationId: 'job-live-folder', serverPath };
}

test('an exclusive lock on world/session.lock is live; unlocked or missing worlds are not', windowsLock, async t => {
  const serverPath = serverFolder(t);
  const lock = await holdSessionLock(t, path.join(serverPath, 'world', 'session.lock'));
  assert.deepEqual(await probeLiveServerFolder(serverPath), { live: true, code: 'EBUSY' });

  await lock.release();
  assert.deepEqual(await probeLiveServerFolder(serverPath), { live: false, code: null });

  fs.rmSync(path.join(serverPath, 'world', 'session.lock'));
  assert.deepEqual(await probeLiveServerFolder(serverPath), { live: false, code: 'ENOENT' });
  fs.rmSync(path.join(serverPath, 'world'), { recursive: true });
  assert.deepEqual(await probeLiveServerFolder(serverPath), { live: false, code: 'ENOENT' });
  assert.deepEqual(await probeLiveServerFolder(path.join(serverPath, 'never-created')), { live: false, code: 'ENOENT' });
});

test('the configured level-name world is probed instead of the default world', windowsLock, async t => {
  const serverPath = serverFolder(t, {
    properties: '#Minecraft server properties\nmotd=Fixture\nlevel-name=worlds/survival\n',
    worlds: ['world', path.join('worlds', 'survival')]
  });
  const defaultWorld = await holdSessionLock(t, path.join(serverPath, 'world', 'session.lock'));
  assert.deepEqual(await probeLiveServerFolder(serverPath), { live: false, code: null },
    'a lock on an unused world folder does not describe the configured world');
  await defaultWorld.release();

  await holdSessionLock(t, path.join(serverPath, 'worlds', 'survival', 'session.lock'));
  assert.deepEqual(await probeLiveServerFolder(serverPath), { live: true, code: 'EBUSY' });
});

test('level-name follows Java properties parsing, including escapes and a Latin-1 fallback', async () => {
  const serverPath = path.resolve('/minecraft-core-fixture/server');
  const cases = [
    ['level-name=Survival\\ World\n', 'Survival World'],
    ['level-name = spaced\n', 'spaced'],
    ['level-name:colon\n', 'colon'],
    ['level-name=first\nlevel-name=second\n', 'second'],
    ['# level-name=commented\n', 'world'],
    ['motd=no level\n', 'world'],
    [Buffer.from('motd=Café\nlevel-name=mondeé\n', 'latin1'), 'mondeé']
  ];
  for (const [properties, world] of cases) {
    const fixture = fakeFs({ properties });
    assert.deepEqual(await probeLiveServerFolder(serverPath, { fsPromises: fixture.fsPromises }), { live: false, code: null });
    assert.deepEqual(fixture.opened, [
      { filePath: path.join(serverPath, 'server.properties'), flags: 'r' },
      { filePath: path.resolve(serverPath, world, 'session.lock'), flags: 'r' }
    ], String(properties));
  }
});

test('probe error mapping fails closed only on genuinely unknown evidence', async () => {
  const serverPath = path.resolve('/minecraft-core-fixture/server');
  const cases = [
    [{ lockError: 'EBUSY' }, { live: true, code: 'EBUSY' }],
    [{ lockError: 'EPERM' }, { live: true, code: 'EPERM' }],
    [{ lockReadError: 'EBUSY' }, { live: true, code: 'EBUSY' }],
    [{ lockReadError: 'EPERM' }, { live: true, code: 'EPERM' }],
    [{ lockError: 'ENOENT' }, { live: false, code: 'ENOENT' }],
    [{ lockError: 'EACCES' }, { live: 'unknown', code: 'EACCES' }],
    [{ lockError: 'EIO' }, { live: 'unknown', code: 'EIO' }],
    [{ lockReadError: 'EISDIR' }, { live: 'unknown', code: 'EISDIR' }],
    [{ propertiesError: 'EACCES' }, { live: 'unknown', code: 'EACCES' }],
    [{ propertiesError: 'EBUSY' }, { live: 'unknown', code: 'EBUSY' }],
    [{ properties: 'level-name=broken\\u12\n' }, { live: 'unknown', code: 'PROPERTIES_INVALID' }],
    [{ properties: Buffer.alloc(1024 * 1024 + 1, 0x61) }, { live: 'unknown', code: 'PROPERTIES_INVALID' }]
  ];
  for (const [options, expected] of cases) {
    const fixture = fakeFs(options);
    assert.deepEqual(await probeLiveServerFolder(serverPath, { fsPromises: fixture.fsPromises }), expected, JSON.stringify(options).slice(0, 80));
    assert.ok(fixture.opened.every(entry => entry.flags === 'r'), 'the probe only ever opens files read-only');
  }
  for (const invalidPath of ['', 'relative\\server', null, 42]) {
    const fixture = fakeFs();
    assert.deepEqual(await probeLiveServerFolder(invalidPath, { fsPromises: fixture.fsPromises }), { live: 'unknown', code: 'INVALID_PATH' });
    assert.deepEqual(fixture.opened, []);
  }
});

test('recovery ensureStopped refuses with SERVER_RUNNING while a server it did not start holds the world', windowsLock, async t => {
  const serverPath = serverFolder(t);
  const autoRestart = loadAutoRestart();
  const stops = [];
  const policy = autoRestart.createRecoveryRuntimePolicy({
    runtimeController: {
      async ensureStopped(request) { stops.push(request.serverPath); return { alreadyStopped: true }; },
      async adoptValidatedHandoff() { assert.fail('the probe test never adopts a process'); }
    }
  });
  const lock = await holdSessionLock(t, path.join(serverPath, 'world', 'session.lock'));
  await assert.rejects(policy.ensureStopped(stopRequest(serverPath)), error => {
    assert.equal(error.code, 'SERVER_RUNNING');
    assert.equal(error.message, LIVE_SERVER_FOLDER_MESSAGE);
    assert.equal(error.message, 'A Minecraft server that Minecraft Core did not start is still using this folder. Stop it, then retry.');
    assert.equal(error.retryable, true);
    assert.deepEqual(error.toPublicResult().error.details, { serverId: 'server-one' });
    return true;
  });
  assert.deepEqual(stops, [serverPath], 'the in-memory stop runs before the folder probe');

  await lock.release();
  assert.deepEqual(await policy.ensureStopped(stopRequest(serverPath)), { alreadyStopped: true });
});

test('recovery ensureStopped probes only after a proven stop and treats unknown evidence as running', async () => {
  const autoRestart = loadAutoRestart();
  const serverPath = path.resolve('/minecraft-core-fixture/server');
  const probes = [];
  let stopResult = { stopped: true };
  let probeResult = { live: false, code: null };
  const policy = autoRestart.createRecoveryRuntimePolicy({
    runtimeController: {
      async ensureStopped() { return stopResult; },
      async adoptValidatedHandoff() { return { adopted: true }; }
    },
    liveFolderProbe: async value => {
      probes.push(value);
      if (probeResult instanceof Error) throw probeResult;
      return probeResult;
    }
  });

  assert.deepEqual(await policy.ensureStopped(stopRequest(serverPath)), { stopped: true });
  assert.deepEqual(probes, [serverPath]);

  for (const result of [{ live: 'unknown', code: 'EACCES' }, { live: true, code: 'EBUSY' }, null, new Error('probe crashed')]) {
    probeResult = result;
    await assert.rejects(policy.ensureStopped(stopRequest(serverPath)), error => error.code === 'SERVER_RUNNING' &&
      error.message === LIVE_SERVER_FOLDER_MESSAGE && (!(result instanceof Error) || error.cause === result));
  }

  stopResult = { stopped: false };
  probes.length = 0;
  await assert.rejects(policy.ensureStopped(stopRequest(serverPath)), /could not be proven stopped/u);
  assert.deepEqual(probes, [], 'an unproven in-memory stop is refused before any folder probe');

  assert.throws(() => autoRestart.createRecoveryRuntimePolicy({
    runtimeController: { async ensureStopped() {}, async adoptValidatedHandoff() {} },
    liveFolderProbe: 'not-a-function'
  }), TypeError);
});
