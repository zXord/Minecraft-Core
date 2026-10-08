const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { startDevElectron } = require('../scripts/start-dev-electron.cjs');

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
