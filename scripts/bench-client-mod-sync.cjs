#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const AdmZip = require('adm-zip');

const repoRoot = path.resolve(__dirname, '..');
const defaultRoot = path.join(os.tmpdir(), 'minecraft-core-client-mod-sync-bench');

const argv = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  })
);

const largeCount = Number.parseInt(argv.get('large') || argv.get('mods') || '300', 10);
const smallCount = Number.parseInt(argv.get('small') || '30', 10);
const payloadKb = Number.parseInt(argv.get('payload-kb') || '64', 10);
const benchRoot = path.resolve(argv.get('root') || defaultRoot);

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function makeForgeToml(modId, displayName, version) {
  return [
    'modLoader="javafml"',
    'loaderVersion="[47,)"',
    'license="MIT"',
    '',
    '[[mods]]',
    `modId="${modId}"`,
    `version="${version}"`,
    `displayName="${displayName}"`,
    'description="Synthetic benchmark mod"',
    ''
  ].join('\n');
}

function makeFabricJson(modId, displayName, version, depends = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    id: modId,
    version,
    name: displayName,
    depends
  }, null, 2);
}

function makePayload(modId, sizeBytes) {
  const seed = crypto.createHash('sha256').update(modId).digest();
  let state = seed.readUInt32LE(0) || 0x9e3779b9;
  const payload = Buffer.alloc(sizeBytes);
  for (let i = 0; i < payload.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[i] = (state >>> ((i % 4) * 8)) & 0xff;
  }
  return payload;
}

async function writeJar(filePath, entries) {
  const zip = new AdmZip();
  for (const [entryName, value] of entries) {
    zip.addFile(entryName, Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  const buffer = zip.toBuffer();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer);
  return md5(buffer);
}

function buildForgeModRecord(index, checksum) {
  const fileName = `synthetic-lib-${String(index).padStart(3, '0')}-1.20.1.jar`;
  const displayName = `Synthetic Lib ${String(index).padStart(3, '0')}`;
  const version = `1.0.${index}`;

  return {
    fileName,
    name: displayName,
    required: true,
    checksum,
    versionNumber: version,
    downloadUrl: ''
  };
}

async function createForgeJar(modsDir, index, payloadSize) {
  const fileName = `synthetic-lib-${String(index).padStart(3, '0')}-1.20.1.jar`;
  const modId = `synthetic_lib_${String(index).padStart(3, '0')}`;
  const displayName = `Synthetic Lib ${String(index).padStart(3, '0')}`;
  const version = `1.0.${index}`;
  const checksum = await writeJar(path.join(modsDir, fileName), [
    ['META-INF/mods.toml', makeForgeToml(modId, displayName, version)],
    [`assets/${modId}/payload.bin`, makePayload(modId, payloadSize)]
  ]);

  return buildForgeModRecord(index, checksum);
}

function createMissingForgeRecord(index) {
  const fileName = `synthetic-lib-${String(index).padStart(3, '0')}-1.20.1.jar`;
  const version = `1.0.${index}`;
  return buildForgeModRecord(index, md5(Buffer.from(`${fileName}:${version}`)));
}

async function createClientDependencyJar(modsDir, dependencyBaseName, payloadSize) {
  const fileName = 'manual-client-dependent-1.0.0.jar';
  const checksum = await writeJar(path.join(modsDir, fileName), [
    [
      'fabric.mod.json',
      makeFabricJson('manual_client_dependent', 'Manual Client Dependent', '1.0.0', {
        minecraft: '1.20.1',
        [dependencyBaseName]: '*'
      })
    ],
    ['assets/manual_client_dependent/payload.bin', makePayload(fileName, payloadSize)]
  ]);

  return {
    fileName,
    name: 'Manual Client Dependent',
    required: false,
    checksum,
    versionNumber: '1.0.0',
    downloadUrl: ''
  };
}

async function writeExpectedState(clientPath, requiredMods, optionalMods = [], acknowledgedDeps = []) {
  const stateDir = path.join(clientPath, 'minecraft-core-state');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(
    path.join(stateDir, 'expected-mods.json'),
    JSON.stringify({
      version: 1,
      requiredMods: requiredMods.map((mod) => mod.fileName.toLowerCase()),
      optionalMods: optionalMods.map((mod) => mod.fileName.toLowerCase()),
      acknowledgedDeps,
      lastUpdated: new Date().toISOString()
    }, null, 2)
  );
}

async function makeClientFixture(name, modCount, {
  currentCount = modCount,
  installedCount = modCount,
  addClientDependency = false,
  payloadSize = payloadKb * 1024
} = {}) {
  const clientPath = path.join(benchRoot, name);
  const modsDir = path.join(clientPath, 'mods');
  await fsp.rm(clientPath, { recursive: true, force: true });
  await fsp.mkdir(modsDir, { recursive: true });

  const previousMods = [];
  for (let index = 0; index < modCount; index += 1) {
    previousMods.push(index < installedCount
      ? await createForgeJar(modsDir, index, payloadSize)
      : createMissingForgeRecord(index));
  }

  if (addClientDependency) {
    await createClientDependencyJar(modsDir, 'synthetic-lib', payloadSize);
  }

  const currentMods = previousMods.slice(0, currentCount);
  await writeExpectedState(clientPath, previousMods);

  return {
    clientPath,
    requiredMods: currentMods,
    allClientMods: currentMods,
    serverManagedFiles: previousMods.map((mod) => mod.fileName.toLowerCase())
  };
}

function markOutdatedMods(fixture, count) {
  const updatedCount = Math.min(count, fixture.requiredMods.length);
  return {
    ...fixture,
    requiredMods: fixture.requiredMods.map((mod, index) => index < updatedCount
      ? { ...mod, checksum: md5(Buffer.from(`outdated:${mod.fileName}:${index}`)) }
      : mod),
    allClientMods: fixture.allClientMods.map((mod, index) => index < updatedCount
      ? { ...mod, checksum: md5(Buffer.from(`outdated:${mod.fileName}:${index}`)) }
      : mod)
  };
}

function createFakeElectron(userDataPath) {
  return {
    app: {
      getPath(name) {
        return name === 'userData' ? userDataPath : benchRoot;
      },
      getVersion() {
        return '0.0.0-bench';
      },
      setPath() {}
    },
    net: null,
    session: { defaultSession: null },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: { getFocusedWindow() { return null; } }
  };
}

function createFakeLauncher() {
  const launcher = new EventEmitter();
  launcher.getStatus = () => ({
    isAuthenticated: false,
    isLaunching: false,
    isRunning: false,
    username: null,
    clientPath: null
  });
  return launcher;
}

function withMinecraftHandlers(fn) {
  const originalLoad = Module._load;
  const handlerPath = path.join(repoRoot, 'electron/ipc/minecraft-launcher-handlers.cjs');
  const modFileManagerPath = path.join(repoRoot, 'electron/ipc/mod-utils/mod-file-manager.cjs');
  const fakeLauncher = createFakeLauncher();
  const fakeElectron = createFakeElectron(path.join(benchRoot, 'electron-user-data'));
  const fakeLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };

  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron') {
      return fakeElectron;
    }

    if (request === './logger-handlers.cjs' || request.endsWith('/ipc/logger-handlers.cjs')) {
      return { getLoggerHandlers: () => fakeLogger };
    }

    if (request === '../services/minecraft-launcher/index.cjs' || request.endsWith('/services/minecraft-launcher/index.cjs')) {
      return { getMinecraftLauncher: () => fakeLauncher };
    }

    if (request === '../utils/app-store.cjs' || request.includes('app-store.cjs')) {
      return { get: () => undefined, set: () => true };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[handlerPath];
  delete require.cache[modFileManagerPath];

  try {
    const { createMinecraftLauncherHandlers } = require(handlerPath);
    const modFileManager = require(modFileManagerPath);
    const win = {
      isDestroyed: () => false,
      webContents: { send() {} }
    };
    return fn(createMinecraftLauncherHandlers(win), modFileManager);
  } finally {
    delete require.cache[handlerPath];
    delete require.cache[modFileManagerPath];
    Module._load = originalLoad;
  }
}

function monitorEventLoop(intervalMs = 10) {
  let maxLagMs = 0;
  let samples = 0;
  let expected = performance.now() + intervalMs;

  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, Math.max(0, now - expected));
    samples += 1;
    expected = now + intervalMs;
  }, intervalMs);

  return () => {
    clearInterval(timer);
    return { maxLagMs, samples };
  };
}

async function runCase(handlers, name, fixture, warmRuns = 1) {
  const handler = handlers['minecraft-check-mods'];
  const runs = [];

  for (let runIndex = 0; runIndex < warmRuns + 1; runIndex += 1) {
    const stopMonitor = monitorEventLoop();
    const startedAt = performance.now();
    const result = await handler({}, fixture);
    const durationMs = performance.now() - startedAt;
    const loop = stopMonitor();

    runs.push({
      phase: runIndex === 0 ? 'cold' : `warm-${runIndex}`,
      durationMs,
      maxEventLoopLagMs: loop.maxLagMs,
      synchronized: result.synchronized,
      missing: result.missingMods?.length || 0,
      outdated: result.outdatedMods?.length || 0,
      removals: (result.requiredRemovals?.length || 0) + (result.optionalRemovals?.length || 0),
      acknowledgments: result.acknowledgments?.length || 0,
      success: result.success,
      error: result.error || null
    });
  }

  return { name, runs };
}

async function runInstalledInfoCase(modFileManager, name, fixture, warmRuns = 1) {
  const runs = [];

  for (let runIndex = 0; runIndex < warmRuns + 1; runIndex += 1) {
    const stopMonitor = monitorEventLoop();
    const startedAt = performance.now();
    const info = await modFileManager.getClientInstalledModInfo(fixture.clientPath);
    const durationMs = performance.now() - startedAt;
    const loop = stopMonitor();

    runs.push({
      phase: runIndex === 0 ? 'cold' : `warm-${runIndex}`,
      durationMs,
      maxEventLoopLagMs: loop.maxLagMs,
      synchronized: 'n/a',
      missing: info.length,
      outdated: 0,
      removals: 0,
      acknowledgments: 0,
      success: true,
      error: null
    });
  }

  return { name, runs };
}

function printResult(result) {
  for (const run of result.runs) {
    const status = run.success ? 'ok' : 'fail';
    const details = run.synchronized === 'n/a'
      ? [`items=${run.missing}`]
      : [
          `sync=${run.synchronized}`,
          `missing=${run.missing}`,
          `outdated=${run.outdated}`,
          `remove=${run.removals}`,
          `keep=${run.acknowledgments}`
        ];

    console.log([
      result.name.padEnd(30),
      run.phase.padEnd(7),
      status.padEnd(4),
      `${run.durationMs.toFixed(1)} ms`.padStart(11),
      `loop max ${run.maxEventLoopLagMs.toFixed(1)} ms`.padStart(20),
      ...details
    ].join('  '));
  }
}

async function main() {
  if (argv.has('fixture')) {
    const fixturePath = path.resolve(argv.get('fixture'));
    const fixture = JSON.parse(await fsp.readFile(fixturePath, 'utf8'));
    const realFixture = {
      clientPath: fixture.clientPath,
      requiredMods: fixture.requiredMods || [],
      allClientMods: fixture.allClientMods || fixture.requiredMods || [],
      serverManagedFiles: fixture.serverManagedFiles || []
    };

    console.log('Client mod sync benchmark fixture');
    console.log(`fixture=${fixturePath}`);
    console.log(`minecraft=${fixture.minecraftVersion || 'unknown'} loader=${fixture.loader || 'unknown'} ${fixture.loaderVersion || ''}`);
    console.log(`mods=${realFixture.requiredMods.length}`);
    console.log('');

    await withMinecraftHandlers(async (handlers, modFileManager) => {
      const results = [];
      const label = `fixture-${realFixture.requiredMods.length}`;
      results.push(await runCase(handlers, label, realFixture));
      results.push(await runInstalledInfoCase(modFileManager, `installed-info-${label}`, realFixture));

      for (const result of results) {
        printResult(result);
      }
    });

    return;
  }

  await fsp.rm(benchRoot, { recursive: true, force: true });
  await fsp.mkdir(benchRoot, { recursive: true });

  console.log(`Synthetic client mod sync benchmark`);
  console.log(`root=${benchRoot}`);
  console.log(`small=${smallCount} large=${largeCount} payload=${payloadKb} KiB per jar`);
  console.log('');

  const noMods = await makeClientFixture('no-mods', 0);
  const smallPack = await makeClientFixture('small-pack', smallCount);
  const smallMissing = await makeClientFixture('small-missing', smallCount, {
    installedCount: 0
  });
  const largePack = await makeClientFixture('large-pack', largeCount);
  const largeMissing = await makeClientFixture('large-missing', largeCount, {
    installedCount: 0
  });
  const largeOutdated = markOutdatedMods(largePack, Math.max(1, Math.floor(largeCount / 6)));
  const largeRemoval = await makeClientFixture('large-removal', largeCount, {
    currentCount: Math.max(0, largeCount - 50)
  });
  const largeKeep = await makeClientFixture('large-keep', largeCount, {
    currentCount: Math.max(0, largeCount - 1),
    addClientDependency: true
  });

  await withMinecraftHandlers(async (handlers, modFileManager) => {
    const results = [];
    results.push(await runCase(handlers, 'no-mods', noMods));
    results.push(await runCase(handlers, `small-pack-${smallCount}`, smallPack));
    results.push(await runCase(handlers, `small-missing-${smallCount}`, smallMissing));
    results.push(await runCase(handlers, `large-pack-${largeCount}`, largePack));
    results.push(await runCase(handlers, `large-missing-${largeCount}`, largeMissing));
    results.push(await runCase(handlers, `large-outdated-${largeCount}`, largeOutdated));
    results.push(await runCase(handlers, `large-removal-${largeCount}`, largeRemoval));
    results.push(await runCase(handlers, `large-keep-${largeCount}`, largeKeep));
    results.push(await runInstalledInfoCase(modFileManager, 'installed-info-no-mods', noMods));
    results.push(await runInstalledInfoCase(modFileManager, `installed-info-small-${smallCount}`, smallPack));
    results.push(await runInstalledInfoCase(modFileManager, `installed-info-small-missing-${smallCount}`, smallMissing));
    results.push(await runInstalledInfoCase(modFileManager, `installed-info-large-${largeCount}`, largePack));
    results.push(await runInstalledInfoCase(modFileManager, `installed-info-large-missing-${largeCount}`, largeMissing));

    for (const result of results) {
      printResult(result);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
