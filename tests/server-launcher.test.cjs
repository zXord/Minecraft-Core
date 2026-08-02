const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const { resolveLaunchPlan } = require('../electron/services/server-launcher.cjs');
const { resolveServerLoader } = require('../electron/utils/server-loader.cjs');

function makeTempForgeServer() {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-forge-'));
  const forgeDir = path.join(
    serverPath,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    '1.20.1-47.4.18'
  );

  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(path.join(serverPath, 'user_jvm_args.txt'), '# test\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'win_args.txt'), '-p libraries/a.jar;libraries/b.jar\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'unix_args.txt'), '-p libraries/a.jar:libraries/b.jar\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'run.bat'), '@echo off\n', 'utf8');
  fs.writeFileSync(path.join(forgeDir, 'run.sh'), '#!/bin/sh\n', 'utf8');

  return serverPath;
}

function makeRuntimeTuple(loaderFamily, loaderVersion, minecraftVersion = '1.20.1', javaMajor = 17) {
  return {
    minecraftVersion,
    loaderFamily,
    loaderVersion,
    javaMajor,
    os: 'win32',
    architecture: 'x64'
  };
}

test('resolveLaunchPlan prefers platform-specific Forge args files', () => {
  const serverPath = makeTempForgeServer();

  try {
    const plan = resolveLaunchPlan(serverPath, {
      loader: 'forge',
      maxRam: 4,
      minecraftVersion: '1.20.1',
      loaderVersion: '47.4.18'
    });

    const expectedArgsFile = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';

    assert.equal(plan.type, 'forge');
    assert.equal(plan.loader, 'forge');
    assert.equal(plan.cwd, serverPath);
    assert.ok(plan.readyMarkers.some(marker => marker.includes('Done (')));
    assert.ok(plan.fatalMarkers.includes('UnsupportedClassVersionError'));
    assert.equal(path.basename(plan.assets.forgeArgs), expectedArgsFile);
    assert.match(
      plan.args.find((arg) => typeof arg === 'string' && arg.startsWith('@libraries')),
      new RegExp(`${expectedArgsFile.replace('.', '\\.')}$`)
    );
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('Vanilla and Fabric launch plans keep jar and args while exposing the closed runtime shape', () => {
  const vanillaPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-vanilla-'));
  const fabricPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-fabric-'));
  try {
    fs.writeFileSync(path.join(vanillaPath, 'server.jar'), 'vanilla');
    const vanillaRuntime = makeRuntimeTuple('vanilla', '1.20.1');
    const vanilla = resolveLaunchPlan(vanillaPath, { loader: 'vanilla', maxRam: 3 }, { runtimeTuple: vanillaRuntime });
    assert.deepEqual(Object.keys(vanilla).sort(), ['args', 'cwd', 'fatalMarkers', 'jar', 'loader', 'readyMarkers', 'runtime', 'type']);
    assert.equal(vanilla.jar, path.join(vanillaPath, 'server.jar'));
    assert.deepEqual(vanilla.args, ['-Xmx3G', '-Xms1G', '-jar', vanilla.jar, 'nogui']);
    assert.deepEqual(vanilla.runtime, vanillaRuntime);

    const fabricJar = new AdmZip();
    fabricJar.addFile('net/fabricmc/loader/impl/launch/server/FabricServerLauncher.class', Buffer.from('fixture'));
    fabricJar.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\r\nMain-Class: net.fabricmc.loader.impl.launch.server.FabricServerLauncher\r\n\r\n'));
    fabricJar.writeZip(path.join(fabricPath, 'fabric-server-launch.jar'));
    fs.writeFileSync(path.join(fabricPath, 'server.jar'), 'server');
    const fabricRuntime = makeRuntimeTuple('fabric', '0.16.14');
    const fabric = resolveLaunchPlan(fabricPath, { loader: 'fabric', maxRam: 4 }, { runtimeTuple: fabricRuntime });
    assert.equal(fabric.loader, 'fabric');
    assert.equal(fabric.jar, path.join(fabricPath, 'fabric-server-launch.jar'));
    assert.equal(fabric.cwd, fabricPath);
  } finally {
    fs.rmSync(vanillaPath, { recursive: true, force: true });
    fs.rmSync(fabricPath, { recursive: true, force: true });
  }
});

test('an explicit unsupported loader can never fall through to a generic server jar', () => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-unknown-'));
  try {
    fs.writeFileSync(path.join(serverPath, 'server.jar'), 'not a fallback');
    assert.throws(
      () => resolveLaunchPlan(serverPath, { loader: 'unknown-loader' }),
      error => error.code === 'UNSUPPORTED_LOADER'
    );
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('NeoForge and Quilt filenames alone are not treated as installed runtimes', () => {
  const neoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neo-name-'));
  const quiltPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-name-'));
  try {
    fs.writeFileSync(path.join(neoPath, 'neoforge-21.1.172.jar'), 'name only');
    fs.writeFileSync(path.join(quiltPath, 'quilt-server-launch.jar'), 'name only');
    assert.equal(resolveServerLoader(neoPath).loader, null);
    assert.equal(resolveServerLoader(quiltPath).loader, null);
  } finally {
    fs.rmSync(neoPath, { recursive: true, force: true });
    fs.rmSync(quiltPath, { recursive: true, force: true });
  }
});
