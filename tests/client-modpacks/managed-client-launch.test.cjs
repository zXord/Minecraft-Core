const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createDurableFs } = require('../../electron/utils/durable-fs.cjs');
const { ClientProcessGuard } = require('../../electron/services/client-modpacks/client-process-guard.cjs');
const { ProperMinecraftLauncher } = require('../../electron/services/minecraft-launcher/proper-launcher.cjs');

const blocked = error => error.code === 'CLIENT_RUNNING' || error.code === 'RECOVERY_REQUIRED';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-managed-launch-'));
  const clientPath = path.join(root, 'client');
  const versionDir = path.join(clientPath, 'versions', '1.20.1'); fs.mkdirSync(versionDir, { recursive: true });
  fs.writeFileSync(path.join(versionDir, '1.20.1.jar'), 'fixture-jar');
  fs.writeFileSync(path.join(versionDir, '1.20.1.json'), JSON.stringify({ id: '1.20.1', mainClass: 'fixture.Main', libraries: [], arguments: { jvm: [], game: [] } }));
  const owner = { pid: process.pid, parentPid: process.ppid, creationTime: 'owner-start', executablePath: process.execPath, commandLine: 'node fixture' };
  let processes = [owner];
  const durableFs = createDurableFs({ allowedRoots: [root], durableClient: {
    moveWriteThrough: fs.renameSync, replaceFileWriteThrough: fs.renameSync, flushDirectory() {},
    moveWriteThroughAsync: fs.promises.rename, replaceFileWriteThroughAsync: fs.promises.rename, async flushDirectoryAsync() {}
  } });
  const guard = new ClientProcessGuard({ root, durableFs, inspectProcesses: async () => ({ complete: true, processes }) });
  const client = { clientId: 'client-a', clientPath };
  let reservation; let spawnArgs; let hookCalls = 0;
  const child = new EventEmitter(); Object.assign(child, { pid: 8722, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
  const hook = async ({ clientPath: requested }) => { assert.equal(requested, clientPath); hookCalls++; reservation = await guard.beginLaunch(client); return reservation; };
  const spawn = (_command, args) => {
    spawnArgs = args;
    const marker = args.find(arg => arg.startsWith('-Dminecraft.core.clientLaunchId='));
    processes = [owner, { ...owner, pid: child.pid, parentPid: process.pid, creationTime: 'child-start', commandLine: `java ${marker || ''} fixture.Main` }];
    return child;
  };
  t.after(async () => { child.emit('close', 0); await reservation?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { guard, client, child, hook, spawn, options: { clientPath, minecraftVersion: '1.20.1', javaPath: 'fixture-java' },
    get spawnArgs() { return spawnArgs; }, get hookCalls() { return hookCalls; }, get reservation() { return reservation; } };
}

function proper(f) {
  const launcher = new ProperMinecraftLauncher({ beginManagedLaunch: f.hook, spawn: f.spawn, isProcessAlive: () => true });
  launcher.setAuthData({ name: 'Fixture', uuid: 'fixture', access_token: 'fixture-not-real-auth' });
  return launcher;
}

// Removing acquisition before preparation or releasing at successful IPC return makes the mutation callback run.
test('managed proper launch reserves before preparation, inserts main marker, and holds after return/error', async t => {
  const f = fixture(t); const launcher = proper(f);
  launcher.ensureMinecraftClient = async () => {
    await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('preparation raced mutation')), blocked);
  };
  const result = await launcher.launchMinecraft(f.options);
  assert.equal(result.success, true, result.error);
  assert.equal(f.hookCalls, 1);
  const marker = f.spawnArgs.find(arg => arg.startsWith('-Dminecraft.core.clientLaunchId='));
  assert.match(marker, /^-Dminecraft\.core\.clientLaunchId=[a-f0-9-]{36}$/);
  assert.ok(f.spawnArgs.indexOf(marker) < f.spawnArgs.indexOf('fixture.Main'));
  await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('returned launch released guard')), blocked);
  f.child.emit('error', new Error('non-close error'));
  await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('error released guard')), blocked);
  f.child.emit('close', 0); await f.reservation.close();
  assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
});

test('managed proper preparation failure aborts durable reservation without spawn', async t => {
  const f = fixture(t); const launcher = proper(f);
  launcher.ensureMinecraftClient = async () => { throw new Error('preparation failed'); };
  const result = await launcher.launchMinecraft(f.options);
  assert.equal(result.success, false); assert.match(result.error, /preparation failed/);
  assert.equal(f.hookCalls, 1); assert.equal(f.spawnArgs, undefined);
  assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
});

test('managed spawn throw aborts safely before an exact child exists', async t => {
  const f = fixture(t);
  const launcher = new ProperMinecraftLauncher({ beginManagedLaunch: f.hook, spawn: () => { throw new Error('spawn failed'); } });
  launcher.setAuthData({ name: 'Fixture' }); launcher.ensureMinecraftClient = async () => {};
  const result = await launcher.launchMinecraft(f.options);
  assert.equal(result.success, false); assert.equal(f.hookCalls, 1);
  assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
});

async function withWrapperClass(run, spawn = null) {
  const original = Module._load; const modulePath = require.resolve('../../electron/services/minecraft-launcher/index.cjs');
  const listeners = process.listeners('unhandledRejection');
  Module._load = function(request, parent, isMain) {
    if (request.includes('ipc/logger-handlers.cjs')) return { getLoggerHandlers: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
    if (request === './utils.cjs' && parent?.filename === modulePath) return { resolveRequiredJavaVersion: async () => ({ requiredJavaVersion: 17 }) };
    if (request === 'child_process' && parent?.filename === modulePath && spawn) return { ...original(request, parent, isMain), spawn };
    return original(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try { const api = require(modulePath); await run(api.MinecraftLauncher, api.getMinecraftLauncher); }
  finally { Module._load = original; delete require.cache[modulePath]; for (const listener of process.listeners('unhandledRejection')) if (!listeners.includes(listener)) process.removeListener('unhandledRejection', listener); }
}

test('wrapper reserves before Java preparation and transfers reservation without double acquisition', async t => {
  const f = fixture(t);
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: f.hook });
    launcher.authHandler.authData = { name: 'Fixture', uuid: 'fixture', access_token: 'not-real-auth' };
    launcher.properLauncher._spawn = f.spawn;
    launcher.properLauncher.ensureMinecraftClient = async () => {};
    launcher.javaManager.ensureJava = async () => {
      await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('Java preparation raced mutation')), blocked);
      return { success: true, javaPath: 'fixture-java' };
    };
    const result = await launcher.launchMinecraftProper(f.options);
    assert.equal(result.success, true, result.error); assert.equal(f.hookCalls, 1);
    await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('wrapper released exact child')), blocked);
  });
});

test('main verified runtime bypasses Java, Minecraft and loader repair and ignores renderer tuple', async t => {
  const f = fixture(t);
  const hook = async request => Object.freeze({ ...await f.hook(request), authority: {
    ...f.client, runtime: { minecraftVersion: '1.20.1', loaderFamily: 'vanilla', loaderVersion: '1.20.1' },
    profileId: '1.20.1', javaPath: path.join(f.client.clientPath, 'java', 'javaw.exe'), serverIp: 'saved.example', serverPort: 25575
  } });
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: hook });
    launcher.authHandler.authData = { name: 'Fixture' };
    launcher.javaManager.ensureJava = async () => { throw new Error('must not repair verified Java'); };
    launcher.properLauncher.ensureMinecraftClient = async () => { throw new Error('must not repair verified client'); };
    launcher.properLauncher._getLoaderVersions = async () => { throw new Error('must not resolve latest'); };
    launcher.properLauncher._installClientLoader = async () => { throw new Error('must not install loader'); };
    launcher.properLauncher._installLibrariesTask = () => { throw new Error('must not repair libraries'); };
    launcher.properLauncher._spawn = (command, args) => { assert.equal(command, path.join(f.client.clientPath, 'java', 'javaw.exe')); return f.spawn(command, args); };
    const result = await launcher.launchMinecraftProper({ ...f.options, minecraftVersion: 'forged', loaderType: 'forge', loaderVersion: 'latest',
      serverIp: 'forged.example', serverPort: 1, javaPath: 'forged-java', showDebugTerminal: true });
    assert.equal(result.success, true, result.error); assert.equal(f.hookCalls, 1);
    assert.ok(f.spawnArgs.includes('saved.example')); assert.ok(f.spawnArgs.includes('25575'));
    assert.ok(!f.spawnArgs.includes('forged.example'));
  });
});

test('first proper attach failure still forwards natural close and permits a later launch', async t => {
  const f = fixture(t);
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: async request => {
      const reservation = await f.hook(request);
      return { ...reservation, attach: async child => { await reservation.attach(child); throw new Error('identity publication failed'); } };
    } });
    launcher.authHandler.authData = { name: 'Fixture' }; launcher.properLauncher._spawn = f.spawn;
    launcher.properLauncher.ensureMinecraftClient = async () => {};
    launcher.javaManager.ensureJava = async () => ({ success: true, javaPath: 'fixture-java' });
    let stopped = 0; launcher.on('minecraft-stopped', () => stopped++);
    const result = await launcher.launchMinecraftProper(f.options);
    assert.equal(result.success, false); assert.ok(launcher.client);
    assert.equal((await launcher.launchMinecraft(f.options)).success, false, 'fallback cannot settle an uncertain proper child');
    assert.equal(launcher.client?.child, f.child);
    f.child.emit('close', 0); await f.reservation.close();
    assert.equal(stopped, 1); assert.equal(launcher.client, null); assert.equal(launcher.isLaunching, false);
    launcher._beginManagedLaunch = f.hook;
    const later = await launcher.launchMinecraftProper(f.options);
    assert.equal(later.success, true, later.error);
  });
});

test('direct legacy launcher rejects main-managed paths before Java or filesystem preparation', async t => {
  const f = fixture(t);
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: async request => ({ ...await f.hook(request), authority: { profileId: 'main-verified' } }) });
    launcher.authHandler.authData = { name: 'Fixture' };
    launcher.javaManager.ensureJava = async () => { throw new Error('legacy Java reached'); };
    const result = await launcher.launchMinecraft(f.options);
    assert.equal(result.success, false); assert.match(result.error, /matching.*proper|proper.*matching/i);
    assert.equal(f.hookCalls, 1); assert.equal(f.spawnArgs, undefined);
    assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
  });
});

function prepareLegacy(launcher) {
  launcher.authHandler.authData = { name: 'Fixture', uuid: 'fixture', access_token: 'not-real-auth' };
  launcher.checkAndRefreshAuth = async () => ({ success: true, refreshed: false });
  launcher.javaManager.ensureJava = async () => ({ success: true, javaPath: 'fixture-java' });
  launcher._isProcessAlive = () => true;
}

test('ordinary legacy launch keeps original runtime, marker and ownership through stop until exact close', async t => {
  const f = fixture(t);
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: f.hook }); prepareLegacy(launcher);
    const supplied = await f.hook({ clientPath: f.client.clientPath });
    const result = await launcher.launchMinecraft({ ...f.options, maxMemory: 6144, serverIp: 'ordinary.example', serverPort: 25572 }, supplied);
    assert.equal(result.success, true, result.error); assert.equal(result.version, '1.20.1'); assert.equal(f.hookCalls, 1);
    const marker = f.spawnArgs.find(arg => arg.startsWith('-Dminecraft.core.clientLaunchId='));
    assert.ok(marker); assert.ok(f.spawnArgs.indexOf(marker) < f.spawnArgs.indexOf('fixture.Main'));
    assert.ok(f.spawnArgs.includes('-Xmx6144M')); assert.ok(f.spawnArgs.includes('ordinary.example'));
    await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('legacy return released child')), blocked);
    f.child.emit('error', new Error('not a close'));
    await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('error released child')), blocked);
    launcher._stopTrackedProcess = async child => { assert.equal(child, f.child); return { success: false, error: 'still running' }; };
    assert.equal((await launcher.stopMinecraft()).success, false);
    await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('failed stop released child')), blocked);
    launcher._stopTrackedProcess = async child => { child.emit('close', 0); return { success: true }; };
    assert.equal((await launcher.stopMinecraft()).success, true); await f.reservation.close();
    assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
  }, f.spawn);
});

for (const failurePoint of ['java', 'spawn']) test(`ordinary legacy ${failurePoint} failure releases pre-spawn ownership`, async t => {
  const f = fixture(t);
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: f.hook }); prepareLegacy(launcher);
    if (failurePoint === 'java') launcher.javaManager.ensureJava = async () => ({ success: false, error: 'fixture Java unavailable' });
    const result = await launcher.launchMinecraft(f.options);
    assert.equal(result.success, false); assert.match(result.error, failurePoint === 'java' ? /fixture Java unavailable/ : /fixture spawn failed/);
    assert.equal(f.hookCalls, 1);
    assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
  }, () => { throw new Error('fixture spawn failed'); });
});

test('ordinary legacy failed child attachment retains exact stop handle and cannot authorize fallback', async t => {
  const f = fixture(t);
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: async request => {
      const reservation = await f.hook(request);
      return { ...reservation, attach: async child => { await reservation.attach(child); throw new Error('fixture attach failed'); } };
    } }); prepareLegacy(launcher);
    const result = await launcher.launchMinecraft(f.options);
    assert.equal(result.success, false); assert.match(result.error, /fixture attach failed/);
    assert.equal(launcher.client?.child, f.child); assert.equal(launcher.isLaunching, true);
    const retry = await launcher.launchMinecraft(f.options);
    assert.equal(retry.success, false);
    assert.equal(launcher.client?.child, f.child, 'failed reacquisition must not drop the prior child');
    await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('unknown child released')), blocked);
    f.child.emit('close', 0); await f.reservation.close();
    assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
  }, f.spawn);
});

test('legacy fallback reacquires only after proper pre-spawn failure or exact close', async t => {
  const f = fixture(t);
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: f.hook }); prepareLegacy(launcher);
    launcher.properLauncher._spawn = f.spawn;
    launcher.properLauncher.ensureMinecraftClient = async () => { throw new Error('fixture preparation failed'); };
    assert.equal((await launcher.launchMinecraftProper(f.options)).success, false);
    assert.equal((await launcher.launchMinecraft(f.options)).success, true, 'pre-spawn failure permits a freshly owned fallback');
    f.child.emit('close', 0); await f.reservation.close();
    launcher.properLauncher.ensureMinecraftClient = async () => {};
    assert.equal((await launcher.launchMinecraftProper(f.options)).success, true);
    const blockedFallback = await launcher.launchMinecraft(f.options);
    assert.equal(blockedFallback.success, false); assert.equal(launcher.client?.child, f.child);
    f.child.emit('close', 0); await f.reservation.close();
    assert.equal((await launcher.launchMinecraft(f.options)).success, true);
    assert.equal(f.hookCalls, 5);
  }, f.spawn);
});

test('wrapper Java preparation failure settles reservation before reporting failure', async t => {
  const f = fixture(t);
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: f.hook });
    launcher.authHandler.authData = { name: 'Fixture' };
    launcher.javaManager.ensureJava = async () => ({ success: false, error: 'fixture Java unavailable' });
    const result = await launcher.launchMinecraftProper(f.options);
    assert.equal(result.success, false); assert.equal(f.hookCalls, 1);
    assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
  });
});

test('wrapper unmanaged decision is not resolved twice by the proper launcher', async t => {
  const f = fixture(t); let decisions = 0;
  await withWrapperClass(async MinecraftLauncher => {
    const launcher = new MinecraftLauncher({ beginManagedLaunch: async () => { decisions++; return null; } });
    launcher.authHandler.authData = { name: 'Fixture' };
    launcher.properLauncher.ensureMinecraftClient = async () => {};
    launcher.properLauncher._spawn = f.spawn;
    launcher.javaManager.ensureJava = async () => ({ success: true, javaPath: 'fixture-java' });
    const result = await launcher.launchMinecraftProper(f.options);
    assert.equal(result.success, true, result.error);
    assert.equal(decisions, 1);
  });
});

test('renderer-shaped launch options cannot supply a managed hook to an unmanaged launcher', async t => {
  const f = fixture(t); const launcher = new ProperMinecraftLauncher({ spawn: f.spawn });
  launcher.setAuthData({ name: 'Fixture' }); launcher.ensureMinecraftClient = async () => {};
  const result = await launcher.launchMinecraft({ ...f.options, beginManagedLaunch: () => assert.fail('renderer hook accepted'), managedReservation: { jvmArgument: '-Dforged=true' } });
  assert.equal(result.success, true, result.error);
  assert.equal(f.spawnArgs.some(arg => arg.startsWith('-Dminecraft.core.clientLaunchId=')), false);
});

test('failed post-spawn identity publication retains exact child and reservation until close', async t => {
  const f = fixture(t);
  const launcher = new ProperMinecraftLauncher({ beginManagedLaunch: f.hook, isProcessAlive: () => true,
    spawn(command, args) { const child = f.spawn(command, args); f.guard.inspectProcesses = async () => { throw new Error('query denied after spawn'); }; return child; }
  });
  launcher.setAuthData({ name: 'Fixture' }); launcher.ensureMinecraftClient = async () => {};
  const result = await launcher.launchMinecraft(f.options);
  assert.equal(result.success, false);
  assert.equal(launcher.client?.child, f.child);
  assert.equal(launcher.isLaunching, true);
  await assert.rejects(f.guard.withMutation(f.client, () => assert.fail('failed attach released child')), blocked);
  f.child.emit('close', 0); await f.reservation.close();
  assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
});

test('cancellation during managed reservation does not start preparation after the reservation resolves', async t => {
  const f = fixture(t); let allowReservation; let entered;
  const hookEntered = new Promise(resolve => { entered = resolve; });
  const launcher = new ProperMinecraftLauncher({ spawn: f.spawn, beginManagedLaunch: async request => {
    const reservation = await f.hook(request); entered(); await new Promise(resolve => { allowReservation = resolve; }); return reservation;
  } });
  launcher.setAuthData({ name: 'Fixture' });
  let preparationStarted = false;
  launcher.ensureMinecraftClient = async () => { preparationStarted = true; };
  const pending = launcher.launchMinecraft(f.options); await hookEntered;
  const stopped = launcher.stopMinecraft(); allowReservation();
  const result = await pending;
  assert.match(result.error, /cancelled/);
  assert.equal(preparationStarted, false);
  assert.equal((await stopped).success, true);
  assert.equal(await f.guard.withMutation(f.client, () => 'safe'), 'safe');
});

test('factory first creation installs main-owned guard and later plain access preserves it', async t => {
  const f = fixture(t);
  await withWrapperClass(async (_Class, getMinecraftLauncher) => {
    const launcher = getMinecraftLauncher({ beginManagedLaunch: f.hook });
    assert.equal(getMinecraftLauncher(), launcher);
    launcher.authHandler.authData = { name: 'Fixture' };
    launcher.javaManager.ensureJava = async () => ({ success: false, error: 'fixture unavailable' });
    assert.equal((await launcher.launchMinecraftProper(f.options)).success, false);
    assert.equal(f.hookCalls, 1);
  });
});

test('factory rejects late guard installation instead of silently discarding exclusion', async () => {
  await withWrapperClass(async (_Class, getMinecraftLauncher) => {
    getMinecraftLauncher();
    assert.throws(() => getMinecraftLauncher({ beginManagedLaunch: async () => null }), error => error.code === 'MINECRAFT_LAUNCHER_ALREADY_INITIALIZED');
  });
});

test('factory rejects replacing configured guard while allowing its identical main hook', async () => {
  await withWrapperClass(async (_Class, getMinecraftLauncher) => {
    const hook = async () => null;
    const launcher = getMinecraftLauncher({ beginManagedLaunch: hook });
    assert.equal(getMinecraftLauncher({ beginManagedLaunch: hook }), launcher);
    assert.throws(() => getMinecraftLauncher({ beginManagedLaunch: async () => null }), error => error.code === 'MINECRAFT_LAUNCHER_ALREADY_INITIALIZED');
  });
});
