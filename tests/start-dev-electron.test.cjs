const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const { startDevElectron } = require('../scripts/start-dev-electron.cjs');

// Keep the real launcher and trace factory; only replace process-local diagnostics.
async function withLauncherTrace(importEnv, events, run, { brokenSink = false } = {}) {
  const modulePath = path.resolve(__dirname, '../scripts/start-dev-electron.cjs');
  const originalLoad = Module._load;
  let time = 100;
  Module._load = function(request, parent, isMain) {
    if (request === '../electron/utils/startup-trace.cjs') {
      const { createStartupTrace } = originalLoad(request, parent, isMain);
      const options = {
        now: () => time++, utcNow: () => '2026-10-09T00:00:00.000Z', pid: 123,
        sink(line) {
          if (brokenSink) throw new Error('private sink failure');
          events.push(JSON.parse(line.slice('[Minecraft Core startup trace] '.length)).marker);
        }
      };
      return {
        markStartupTrace: createStartupTrace({ ...options, env: importEnv }),
        createStartupTrace: ({ env }) => createStartupTrace({ ...options, env })
      };
    }
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[modulePath];
  try { return await run(require(modulePath).startDevElectron); }
  finally { delete require.cache[modulePath]; Module._load = originalLoad; }
}

test('startup trace brackets held runtime preparation and lease before spawn without changing cleanup', async () => {
  const events = [];
  await withLauncherTrace({}, events, async launch => {
    let finishPrepare, finishLease;
    const prepared = new Promise(resolve => { finishPrepare = resolve; });
    const leased = new Promise(resolve => { finishLease = resolve; });
    const processLike = new EventEmitter();
    const child = new EventEmitter();
    child.kill = signal => { events.push(signal); };
    const result = launch({
      env: { MINECRAFT_CORE_STARTUP_TRACE: '1', LOCALAPPDATA: 'C:\\fixture\\local' },
      platform: 'win32', processLike,
      prepareDevRuntime() { events.push('prepare'); return prepared; },
      createDevRuntimeLease() { events.push('lease'); return leased; },
      spawnProcess() { events.push('spawn'); return child; }
    });
    assert.deepEqual(events, ['launcher:runtime-prepare:start', 'prepare']);
    finishPrepare({ cacheDirectory: 'C:\\fixture\\cache', executablePath: 'C:\\fixture\\electron.exe' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['launcher:runtime-prepare:start', 'prepare', 'launcher:runtime-prepare:complete', 'launcher:runtime-lease:start', 'lease']);
    finishLease({ dispose() { events.push('dispose'); } });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events.slice(-3), ['launcher:runtime-lease:complete', 'spawn', 'launcher:spawn-returned']);
    processLike.emit('SIGTERM');
    child.emit('exit', 7, null);
    assert.equal(await result, 7);
    assert.deepEqual(events.slice(-2), ['SIGTERM', 'dispose']);
    assert.equal(processLike.listenerCount('SIGTERM'), 0);
    assert.equal(processLike.listenerCount('SIGINT'), 0);
    assert.equal(events.includes('launcher:entry'), false, 'import-only launcher has no entry marker');
  });
});

test('startup trace supplied disabled env overrides enabled import and broken diagnostics preserve launcher error', async () => {
  const error = new Error('original preparation failure');
  for (const brokenSink of [false, true]) {
    const events = [];
    await withLauncherTrace({ MINECRAFT_CORE_STARTUP_TRACE: '1' }, events, async launch => {
      const processLike = new EventEmitter();
      await assert.rejects(launch({
        platform: 'win32', processLike,
        env: { LOCALAPPDATA: 'C:\\fixture\\local', ...(brokenSink ? { MINECRAFT_CORE_STARTUP_TRACE: '1' } : {}) },
        prepareDevRuntime() { throw error; },
        spawnProcess() { assert.fail('failed preparation must not spawn'); }
      }), actual => actual === error);
      assert.deepEqual(events, []);
      assert.equal(processLike.listenerCount('SIGTERM'), 0);
      assert.equal(processLike.listenerCount('SIGINT'), 0);
    }, { brokenSink });
  }
});

test('startup trace termination during held lease keeps disposal and omits spawn-returned', async () => {
  const events = [];
  await withLauncherTrace({}, events, async launch => {
    const processLike = new EventEmitter();
    let finishLease;
    const lease = new Promise(resolve => { finishLease = resolve; });
    const result = launch({
      env: { MINECRAFT_CORE_STARTUP_TRACE: '1', LOCALAPPDATA: 'C:\\fixture\\local' },
      platform: 'win32', processLike,
      prepareDevRuntime: async () => ({ cacheDirectory: 'C:\\fixture\\cache', executablePath: 'C:\\fixture\\electron.exe' }),
      createDevRuntimeLease() { return lease; },
      spawnProcess() { assert.fail('termination during lease must not spawn'); }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.at(-1), 'launcher:runtime-lease:start');
    processLike.emit('SIGINT');
    finishLease({ dispose() { events.push('dispose'); } });
    assert.equal(await result, 0);
    assert.deepEqual(events.slice(-2), ['launcher:runtime-lease:complete', 'dispose']);
    assert.equal(events.includes('launcher:spawn-returned'), false);
    assert.equal(processLike.listenerCount('SIGINT'), 0);
    assert.equal(processLike.listenerCount('SIGTERM'), 0);
  });
});

test('Windows development launches the icon-embedded cached Electron executable directly', async () => {
  const events = [];
  const child = new EventEmitter();
  child.killed = false;
  child.kill = signal => { events.push(['kill', signal]); child.killed = true; };
  const processLike = new EventEmitter();
  const projectRoot = 'C:\\fixture\\minecraft-core';
  const sourceExecutablePath = 'C:\\fixture\\electron\\electron.exe';
  const iconPath = 'C:\\fixture\\minecraft-core\\build-resources\\icon.ico';
  const cachedExecutablePath = 'C:\\fixture\\LocalAppData\\Minecraft Core\\dev-electron-runtime\\runtime-key\\electron.exe';
  const cachedDirectory = 'C:\\fixture\\LocalAppData\\Minecraft Core\\dev-electron-runtime\\runtime-key';

  const exitCodePromise = startDevElectron({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\fixture\\LocalAppData' },
    projectRoot,
    sourceExecutablePath,
    iconPath,
    electronVersion: '42.10.1',
    architecture: 'x64',
    processLike,
    spawnElectron() {
      throw new Error('legacy stock launcher invoked');
    },
    async prepareDevRuntime(options) {
      events.push(['prepare', options]);
      return { cacheDirectory: cachedDirectory, executablePath: cachedExecutablePath };
    },
    async createDevRuntimeLease(cacheDirectory) {
      events.push(['lease:create', cacheDirectory]);
      return { async dispose() { events.push(['lease:dispose']); } };
    },
    spawnProcess(command, args, options) {
      events.push(['spawn', command, args, options]);
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }
  });

  assert.equal(await exitCodePromise, 0);
  assert.deepEqual(events, [
    ['prepare', {
      sourceExecutablePath,
      sourceDistributionPath: 'C:\\fixture\\electron',
      iconPath,
      cacheBasePath: 'C:\\fixture\\LocalAppData',
      electronVersion: '42.10.1',
      architecture: 'x64'
    }],
    ['lease:create', cachedDirectory],
    ['spawn', cachedExecutablePath, [projectRoot], {
      stdio: 'inherit',
      cwd: projectRoot,
      env: { LOCALAPPDATA: 'C:\\fixture\\LocalAppData' }
    }],
    ['lease:dispose']
  ]);
});

test('termination during branded runtime preparation exits without spawning Electron', async () => {
  const processLike = new EventEmitter();
  let releasePreparation;
  let preparationStarted;
  const started = new Promise(resolve => { preparationStarted = resolve; });
  const gate = new Promise(resolve => { releasePreparation = resolve; });
  let spawns = 0;
  let leases = 0;

  const launch = startDevElectron({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\fixture\\LocalAppData' },
    projectRoot: 'C:\\fixture\\minecraft-core',
    sourceExecutablePath: 'C:\\fixture\\electron\\electron.exe',
    iconPath: 'C:\\fixture\\icon.ico',
    electronVersion: '42.10.1',
    architecture: 'x64',
    processLike,
    async prepareDevRuntime() {
      preparationStarted();
      await gate;
      return {
        cacheDirectory: 'C:\\fixture\\cache\\runtime',
        executablePath: 'C:\\fixture\\cache\\runtime\\electron.exe'
      };
    },
    async createDevRuntimeLease() { leases += 1; return { async dispose() {} }; },
    spawnProcess() { spawns += 1; throw new Error('must not spawn'); }
  });

  await started;
  processLike.emit('SIGTERM');
  releasePreparation();

  assert.equal(await launch, 0);
  assert.equal(spawns, 0);
  assert.equal(leases, 0);
});

test('Windows branded runtime fails closed when LocalAppData is unavailable', async () => {
  const processLike = new EventEmitter();
  let prepares = 0;
  let spawns = 0;

  await assert.rejects(startDevElectron({
    platform: 'win32',
    env: {},
    processLike,
    async prepareDevRuntime() { prepares += 1; },
    spawnProcess() { spawns += 1; }
  }), /LOCALAPPDATA/u);

  assert.equal(prepares, 0);
  assert.equal(spawns, 0);
});
