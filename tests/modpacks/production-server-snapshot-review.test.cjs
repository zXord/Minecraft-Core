'use strict';

// A lifecycle review of a modpack-managed server that is running. The review
// reads the live server tree while Minecraft holds its world lock, appends to
// its log, saves the world and rewrites its player lists. Those passive runtime
// outputs may be left out of the review: the commit stops the server and scans
// it again exactly before it changes anything. Pack-managed and sensitive files
// stay exact, and the commit-time scan stays strict.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LIST_LINE, levelAutosave, runningServerFs } = require('./running-server-fs-fixture.cjs');
const {
  createProductionServerSnapshot
} = require('../../electron/services/modpacks/planning/production-server-snapshot.cjs');
const { encodePowerShellCommand, resolveSystemPowerShell } = require('../../electron/watchdog/app-watchdog.cjs');

const RUNTIME = Object.freeze({
  minecraftVersion: '1.21.1', loaderFamily: 'fabric', loaderVersion: '0.16.10',
  javaMajor: 21, os: 'win32', architecture: 'x64'
});
const NO_REPARSE = Object.freeze({ async isReparsePoint() { return false; } });
const PACK_FILES = Object.freeze({
  'config/pack.json': '{"pack":true}\n',
  'mods/pack.jar': 'pack mod bytes'
});
// What the first boot leaves beside the pack while the server runs.
const RUNTIME_FILES = Object.freeze({
  'logs/latest.log': '[12:00:09] [Server thread/INFO]: Done (8.917s)! For help, type "help"\n',
  'server.properties': 'motd=Pack\n',
  'usercache.json': '[]',
  'world/level.dat': 'level',
  'world/level.dat_old': 'level old',
  'world/region/r.0.0.mca': 'region 0 0',
  'world/session.lock': '☃'
});
const IN_USE = 'server-files-in-use';
const windowsLock = {
  skip: process.platform !== 'win32' && 'Java world locks block reads only on Windows',
  timeout: 60000
};

// The same exclusive whole-file byte-range lock Java's FileChannel.tryLock()
// takes on world/session.lock (tests/modpacks/live-server-folder-probe.test.cjs).
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

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function writeFiles(root, files) {
  for (const [relative, bytes] of Object.entries(files)) {
    const filePath = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
  }
}

function packEntry(pathKey, bytes) {
  return {
    path: pathKey, pathKey, origin: 'pack', managementPolicy: 'replaceable-managed',
    role: pathKey.startsWith('mods/') ? 'mod' : 'configuration',
    installedHash: sha256(bytes), size: String(Buffer.byteLength(bytes)), priorBaseline: null
  };
}

// A managed server that is running: the installed pack plus its runtime output.
function runningServer(t, { files = {}, manifestEntries = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-review-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const serverPath = path.join(root, 'Server');
  writeFiles(serverPath, { ...PACK_FILES, ...RUNTIME_FILES, ...files });
  const currentState = {
    state: { modpackManaged: true, contentRevision: 3, runtime: RUNTIME },
    manifest: {
      schemaVersion: 1,
      installationId: 'installed-one',
      entries: [...Object.entries(PACK_FILES).map(([key, bytes]) => packEntry(key, bytes)), ...manifestEntries]
        .sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'))
    }
  };
  return { serverPath, currentState, at: relative => path.join(serverPath, ...relative.split('/')) };
}

function snapshotFor(server, { fsPromises = fsp, reparseInspector = NO_REPARSE } = {}) {
  return createProductionServerSnapshot({
    fsApi: fs,
    fsPromises,
    reparseInspector,
    stateRepository: {
      read() { return server.currentState; },
      listHistory() { return { items: [], nextCursor: null }; }
    }
  });
}

function request(server, extra = {}) {
  return {
    currentState: server.currentState,
    operationKind: 'uninstall',
    runtime: RUNTIME,
    serverKind: 'existing',
    serverPath: server.serverPath,
    ...extra
  };
}

function keys(snapshot) {
  return snapshot.liveSnapshot.entries.map(entry => entry.pathKey);
}

function entryOf(snapshot, pathKey) {
  return snapshot.liveSnapshot.entries.find(entry => entry.pathKey === pathKey) || null;
}

function withoutKeys(values, leftOut) {
  return values.filter(value => !leftOut.some(key => value.pathKey === key || value.pathKey.startsWith(`${key}/`)));
}

function assertPackFilesExact(snapshot) {
  for (const [key, bytes] of Object.entries(PACK_FILES)) {
    assert.equal(entryOf(snapshot, key)?.sha256, sha256(bytes), key);
    assert.equal(snapshot.pathPreconditions.find(condition => condition.pathKey === key)?.sha256, sha256(bytes), key);
  }
}

function inUseRejection(error) {
  assert.equal(error?.code, 'PLAN_STALE');
  assert.equal(error.details?.reasonCode, IN_USE);
  assert.equal(error.retryable, true);
  assert.match(error.message, /stop it, then review again/i);
  assert.deepEqual(error.toPublicResult().error.details, { reasonCode: IN_USE });
  return true;
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

test('a review of a quiet server is exactly the commit-time snapshot', async t => {
  const server = runningServer(t);
  const snapshotServer = snapshotFor(server);

  assert.deepEqual(await snapshotServer(request(server, { review: true })), await snapshotServer(request(server)));
});

test('a review leaves out the world lock a running server holds and keeps every pack file exact', async t => {
  const server = runningServer(t);
  const quiet = await snapshotFor(server)(request(server));
  const lockedFs = () => runningServerFs({ locked: [server.at('world/session.lock')] });

  // The commit-time snapshot stays exact; it only ever runs after the stop.
  await assert.rejects(snapshotFor(server, { fsPromises: lockedFs() })(request(server)),
    error => error?.code === 'PLAN_STALE' && error.cause?.code === 'EBUSY' && error.details === undefined);

  const reviewed = await snapshotFor(server, { fsPromises: lockedFs() })(request(server, { review: true }));
  assert.deepEqual(reviewed.liveSnapshot.entries, withoutKeys(quiet.liveSnapshot.entries, ['world/session.lock']));
  assert.deepEqual(reviewed.pathPreconditions, withoutKeys(quiet.pathPreconditions, ['world/session.lock']));
  assert.deepEqual(
    [reviewed.candidateBytes, reviewed.restorePointBytes, reviewed.liveSnapshot.worldDirectories],
    [quiet.candidateBytes, quiet.restorePointBytes, quiet.liveSnapshot.worldDirectories]
  );
  assertPackFilesExact(reviewed);
});

test('a review succeeds while another process holds the world lock exactly as Minecraft does', windowsLock, async t => {
  const server = runningServer(t);
  const lock = await holdSessionLock(t, server.at('world/session.lock'));
  let strict;
  let reviewed;
  try {
    strict = await snapshotFor(server)(request(server)).then(() => null, error => error);
    reviewed = await snapshotFor(server)(request(server, { review: true }));
  } finally {
    await lock.release();
  }

  assert.equal(strict?.code, 'PLAN_STALE');
  assert.equal(strict.cause?.code, 'EBUSY');
  assert.equal(keys(reviewed).includes('world/session.lock'), false);
  assertPackFilesExact(reviewed);
  // Once the server stopped, the commit-time snapshot reads the released lock.
  const stopped = await snapshotFor(server)(request(server));
  assert.equal(entryOf(stopped, 'world/session.lock')?.sha256, sha256('☃'));
});

const RUNTIME_WRITES = [
  {
    name: 'a log line after logs/latest.log was observed',
    after: server => ({ [`lstat ${server.at('logs/latest.log')}`]: () => fsp.appendFile(server.at('logs/latest.log'), LIST_LINE) }),
    leftOut: []
  },
  {
    name: 'an autosave that replaces world/level.dat while it is read',
    after: server => {
      const save = levelAutosave(server.at('world'));
      return { [`lstat ${server.at('world/level.dat')}`]: () => { save.begin(); save.finish(); } };
    },
    leftOut: ['world/level.dat']
  },
  {
    name: 'an autosave temporary file that is gone before the review reaches it',
    after: server => {
      const save = levelAutosave(server.at('world'));
      return { [`lstat ${server.at('world')}`]: save.begin, [`readdir ${server.at('world')}`]: save.finish };
    },
    leftOut: []
  },
  {
    name: 'a chunk saved in place to a region file after it was hashed',
    after: server => ({
      [`lstat ${server.at('world/session.lock')}`]: () => fsp.appendFile(server.at('world/region/r.0.0.mca'), 'chunk sector')
    }),
    leftOut: ['world/region/r.0.0.mca']
  },
  {
    name: 'usercache.json rewritten after it was hashed',
    after: server => ({
      [`lstat ${server.at('world')}`]: () => fsp.writeFile(server.at('usercache.json'), '[{"name":"Steve"}]')
    }),
    leftOut: ['usercache.json']
  },
  {
    name: 'a new region file and a new crash report',
    after: server => ({
      [`readdir ${server.at('world/region')}`]: () => fsp.writeFile(server.at('world/region/r.-1.0.mca'), 'new region'),
      [`lstat ${server.at('world/session.lock')}`]: () => writeFiles(server.serverPath, { 'crash-reports/crash.txt': 'watchdog' })
    }),
    leftOut: []
  },
  {
    name: 'a runtime folder a mod removes while the review reads it',
    files: { 'world/temp/chunk.bin': 'scratch' },
    after: server => ({
      [`lstat ${server.at('world/temp')}`]: () => fsp.rm(server.at('world/temp'), { recursive: true, force: true })
    }),
    leftOut: ['world/temp']
  },
  {
    name: 'a scheduled backup written while the review reads the server',
    after: server => ({
      [`lstat ${server.at('world')}`]: () => writeFiles(server.serverPath, { 'backups/scheduled.zip': 'backup bytes' })
    }),
    leftOut: []
  }
];

for (const scenario of RUNTIME_WRITES) {
  test(`a review of a running server tolerates ${scenario.name}`, async t => {
    const committed = runningServer(t, { files: scenario.files || {} });
    await assert.rejects(snapshotFor(committed, { fsPromises: runningServerFs({ after: scenario.after(committed) }) })(request(committed)),
      error => error?.code === 'PLAN_STALE' && error.details === undefined, 'the commit-time snapshot stays exact');

    const server = runningServer(t, { files: scenario.files || {} });
    const quiet = await snapshotFor(server)(request(server));
    const reviewed = await snapshotFor(server, { fsPromises: runningServerFs({ after: scenario.after(server) }) })(
      request(server, { review: true })
    );
    assertPackFilesExact(reviewed);
    for (const key of scenario.leftOut) assert.equal(keys(reviewed).some(item => item === key || item.startsWith(`${key}/`)), false, key);
    const stable = keys(quiet).filter(key => !scenario.leftOut.some(left => key === left || key.startsWith(`${left}/`)) &&
      !['world/level.dat', 'world/level.dat_old', 'usercache.json', 'world/region/r.0.0.mca'].includes(key));
    for (const key of stable) assert.deepEqual(entryOf(reviewed, key), entryOf(quiet, key), key);
  });
}

const STRICT_CHANGES = [
  {
    name: 'a pack-managed config is rewritten after it was hashed',
    after: server => ({ [`lstat ${server.at('mods')}`]: () => fsp.writeFile(server.at('config/pack.json'), '{"pack":false}\n') })
  },
  {
    name: 'a pack-managed config is locked',
    locked: server => [server.at('config/pack.json')]
  },
  {
    name: 'a new mod jar appears',
    after: server => ({ [`readdir ${server.at('mods')}`]: () => fsp.writeFile(server.at('mods/extra.jar'), 'extra mod') })
  },
  {
    name: 'server.properties changes while it is read',
    after: server => ({ [`open ${server.at('server.properties')}`]: () => fsp.writeFile(server.at('server.properties'), 'motd=Changed\n') })
  },
  {
    name: 'the world lock is a pack-managed file',
    manifestEntries: [packEntry('world/session.lock', '☃')],
    locked: server => [server.at('world/session.lock')]
  },
  {
    name: 'a datapack changes in a custom world the walk reaches before server.properties',
    files: { 'server.properties': 'motd=Pack\nlevel-name=adventure\n', 'adventure/datapacks/tools.zip': 'datapack', 'adventure/level.dat': 'custom' },
    after: server => ({
      [`lstat ${server.at('adventure/datapacks/tools.zip')}`]: () => fsp.appendFile(server.at('adventure/datapacks/tools.zip'), ' changed')
    })
  },
  {
    name: 'the server settings file changes',
    files: { '.minecraft-core.json': '{"contentRevision":3}' },
    after: server => ({ [`lstat ${server.at('world')}`]: () => fsp.writeFile(server.at('.minecraft-core.json'), '{"contentRevision":4}') })
  },
  {
    name: 'the modpack state changes',
    files: { '.minecraft-core-state/modpack.json': '{"revision":3}' },
    after: server => ({
      [`lstat ${server.at('world')}`]: () => fsp.writeFile(server.at('.minecraft-core-state/modpack.json'), '{"revision":40}')
    })
  },
  {
    // Start always decides eula.txt `ignore-eula`, which it cannot rebase.
    name: 'eula.txt changes',
    files: { 'eula.txt': 'eula=true\n' },
    after: server => ({ [`lstat ${server.at('world')}`]: () => fsp.writeFile(server.at('eula.txt'), 'eula=false\n') })
  },
  {
    // A world folder holds its datapacks, which stay exact.
    name: 'a world folder appears',
    after: server => ({
      [`readdir ${server.serverPath}`]: () => writeFiles(server.serverPath, { 'world_nether/level.dat': 'nether' })
    })
  },
  {
    // A passive folder left out cannot take a reviewed executable with it.
    name: 'a passive folder holding a jar is replaced after it was read',
    files: { 'world/temp/helper.jar': 'helper', 'world/zz-last.dat': 'last' },
    after: server => ({
      [`lstat ${server.at('world/zz-last.dat')}`]: () => {
        fs.renameSync(server.at('world/temp'), server.at('world/temp-old'));
        writeFiles(server.serverPath, { 'world/temp/helper.jar': 'helper' });
      }
    })
  }
];

for (const scenario of STRICT_CHANGES) {
  test(`a review still refuses, with its own reason, when ${scenario.name}`, async t => {
    const server = runningServer(t, { files: scenario.files || {}, manifestEntries: scenario.manifestEntries || [] });
    const fsPromises = runningServerFs({ locked: scenario.locked?.(server) || [], after: scenario.after?.(server) || {} });

    await assert.rejects(snapshotFor(server, { fsPromises })(request(server, { review: true })), inUseRejection);
  });
}

test('a review still refuses a reparse point in passive world data without the running-server reason', async t => {
  const server = runningServer(t);
  const unsafe = path.resolve(server.at('world/region/r.0.0.mca'));
  const reparseInspector = { async isReparsePoint(candidate) { return path.resolve(candidate) === unsafe; } };

  await assert.rejects(snapshotFor(server, { reparseInspector })(request(server, { review: true })),
    error => error?.code === 'PLAN_STALE' && error.details === undefined);
});

test('a review leaves out a passive file deleted before the reparse probe opened it, and nothing else', async t => {
  // The Windows probe cannot open a path that is gone; any other probe failure stays fatal.
  const probeFailure = () => Object.assign(new Error('Windows reparse-point inspection failed'), { code: 'REPARSE_INSPECTION_FAILED' });
  const reparseInspector = failing => ({
    async isReparsePoint(candidate) {
      if (!fs.existsSync(candidate) || path.resolve(candidate) === failing) throw probeFailure();
      return false;
    }
  });
  const deleteAfterLstat = (server, relative) => runningServerFs({
    after: { [`lstat ${server.at(relative)}`]: () => fsp.rm(server.at(relative)) }
  });

  const server = runningServer(t, { files: { 'world/level123.dat': 'temporary save' } });
  const reviewed = await snapshotFor(server, {
    fsPromises: deleteAfterLstat(server, 'world/level123.dat'),
    reparseInspector: reparseInspector(null)
  })(request(server, { review: true }));
  assert.equal(keys(reviewed).includes('world/level123.dat'), false);
  assertPackFilesExact(reviewed);

  const strict = runningServer(t, { files: { 'world/level123.dat': 'temporary save' } });
  await assert.rejects(snapshotFor(strict, {
    fsPromises: deleteAfterLstat(strict, 'world/level123.dat'),
    reparseInspector: reparseInspector(null)
  })(request(strict)), error => error?.code === 'PLAN_STALE' && error.details === undefined);

  const managed = runningServer(t);
  await assert.rejects(snapshotFor(managed, {
    fsPromises: deleteAfterLstat(managed, 'config/pack.json'),
    reparseInspector: reparseInspector(null)
  })(request(managed, { review: true })), inUseRejection);

  const broken = runningServer(t);
  await assert.rejects(snapshotFor(broken, {
    reparseInspector: reparseInspector(path.resolve(broken.at('world/level.dat')))
  })(request(broken, { review: true })), error => error?.code === 'PLAN_STALE' && error.details === undefined &&
    error.cause?.code === 'REPARSE_INSPECTION_FAILED');
});

test('a review leaves out a passive path being deleted, and refuses one this user may not read', async t => {
  // Windows answers EPERM both for a file or folder being deleted and for one
  // this user may not read. Only the first can no longer be looked up; the
  // second stays unreadable after the server stops, so it is not in use.
  const denied = (target, syscall) => Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${target}'`), {
    code: 'EPERM', syscall
  });
  const refusing = (server, relative, { deleting }) => {
    const target = path.resolve(server.at(relative));
    let refused = false;
    const refuse = (candidate, syscall) => {
      refused = true;
      throw denied(candidate, syscall);
    };
    return {
      access: (...args) => fsp.access(...args),
      async lstat(candidate, ...args) {
        if (deleting && refused && path.resolve(candidate) === target) throw denied(candidate, 'lstat');
        return fsp.lstat(candidate, ...args);
      },
      async readdir(candidate, ...args) {
        if (path.resolve(candidate) === target) refuse(candidate, 'scandir');
        return fsp.readdir(candidate, ...args);
      },
      async open(candidate, ...args) {
        if (path.resolve(candidate) === target) refuse(candidate, 'open');
        return fsp.open(candidate, ...args);
      }
    };
  };
  const files = { 'world/stats/player.json': '{}' };

  for (const relative of ['usercache.json', 'world/stats']) {
    const deleting = runningServer(t, { files });
    const reviewed = await snapshotFor(deleting, { fsPromises: refusing(deleting, relative, { deleting: true }) })(
      request(deleting, { review: true }));
    assert.equal(keys(reviewed).some(key => key === relative || key.startsWith(`${relative}/`)), false, relative);
    assertPackFilesExact(reviewed);

    for (const review of [true, false]) {
      const unreadable = runningServer(t, { files });
      await assert.rejects(snapshotFor(unreadable, { fsPromises: refusing(unreadable, relative, { deleting: false }) })(
        request(unreadable, { review })), error => error?.code === 'PLAN_STALE' && error.details === undefined &&
        error.cause?.code === 'EPERM');
    }
  }
});

test('a review refuses a passive file it cannot read for a reason a running server does not cause', async t => {
  // Only a lock, a file being deleted or a file already gone is what a running
  // server does; any other read error (here EIO) is not left out.
  for (const syscall of ['open', 'readdir']) {
    const server = runningServer(t, { files: { 'world/stats/player.json': '{}' } });
    const target = path.resolve(server.at(syscall === 'open' ? 'usercache.json' : 'world/stats'));
    const ioError = candidate => Object.assign(new Error(`EIO: i/o error, ${syscall} '${candidate}'`), { code: 'EIO', syscall });
    const fsPromises = {
      access: (...args) => fsp.access(...args),
      lstat: (...args) => fsp.lstat(...args),
      async readdir(candidate, ...args) {
        if (syscall === 'readdir' && path.resolve(candidate) === target) throw ioError(candidate);
        return fsp.readdir(candidate, ...args);
      },
      async open(candidate, ...args) {
        if (syscall === 'open' && path.resolve(candidate) === target) throw ioError(candidate);
        return fsp.open(candidate, ...args);
      }
    };

    await assert.rejects(snapshotFor(server, { fsPromises })(request(server, { review: true })),
      error => error?.code === 'PLAN_STALE' && error.details === undefined && error.cause?.code === 'EIO', syscall);
  }
});

test('a review refuses a junction in passive world data without the running-server reason', async t => {
  const server = runningServer(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-review-junction-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.writeFileSync(path.join(elsewhere, 'r.0.0.mca'), 'region elsewhere');
  fs.rmSync(server.at('world/region'), { recursive: true, force: true });
  fs.symlinkSync(elsewhere, server.at('world/region'), process.platform === 'win32' ? 'junction' : 'dir');

  for (const review of [true, false]) {
    await assert.rejects(snapshotFor(server)(request(server, { review })),
      error => error?.code === 'PLAN_STALE' && error.details === undefined, `review: ${review}`);
  }
});

test('a review is still cancelled while the running server keeps its files busy', async t => {
  const server = runningServer(t);
  const controller = new AbortController();
  const fsPromises = runningServerFs({
    locked: [server.at('world/session.lock')],
    after: { [`lstat ${server.at('world/level.dat')}`]: () => controller.abort() }
  });

  await assert.rejects(snapshotFor(server, { fsPromises })(request(server, { review: true, signal: controller.signal })),
    error => error?.code === 'CANCELLED');
});

test('a review rejects an invalid mode flag or incoming manifest', async t => {
  const server = runningServer(t);

  await assert.rejects(snapshotFor(server)(request(server, { review: 'yes' })), error => error?.code === 'PLAN_STALE');
  await assert.rejects(snapshotFor(server)(request(server, { review: true, incomingManifest: { entries: 'all' } })),
    error => error?.code === 'PLAN_STALE');
});
