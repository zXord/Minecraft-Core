const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const AdmZip = require('adm-zip');

const {
  getLoaderVersions,
  installServerLoader,
  validatePreparedRuntime,
  __testUtils: {
    getForgeArtifactVersion,
    getForgeInstallerPath,
    isForgeInstallerOpenError,
    resolveJavaMajor,
    runBoundedProcess,
    publishStagedRuntime,
    ensureFabricBaseRuntime,
    listRuntimeArtifactFiles,
    publishForgeRuntimeMetadata,
    digestStableArtifact,
    finalizeForgeRuntimeMetadata
  }
} = require('../electron/services/loader-install-service.cjs');
const { resolveLaunchPlan } = require('../electron/services/server-launcher.cjs');

async function withFabricInstaller(installFabric, work) {
  const modulePath = require.resolve('../electron/services/loader-install-service.cjs');
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './download-manager.cjs' && parent?.filename === modulePath) return { installFabric };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    return await work(require(modulePath));
  } finally {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  }
}

function writeMinimalJar(filePath, marker = 'server') {
  const archive = new AdmZip();
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n\n', 'utf8'));
  archive.addFile('marker.txt', Buffer.from(marker, 'utf8'));
  archive.writeZip(filePath);
}

function writeFabricLauncherJar(filePath) {
  const archive = new AdmZip();
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from(
    'Manifest-Version: 1.0\nMain-Class: net.fabricmc.loader.launch.server.FabricServerLauncher\n\n',
    'utf8'
  ));
  archive.addFile(
    'net/fabricmc/loader/launch/server/FabricServerLauncher.class',
    Buffer.from('fixture', 'utf8')
  );
  archive.writeZip(filePath);
}

function runtimeArtifact(root, relativePath) {
  const filePath = path.join(root, ...relativePath.split('/'));
  const bytes = fs.readFileSync(filePath);
  return {
    relativePath,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(bytes).digest('hex')
  };
}

function legacyForgeRuntime() {
  return {
    minecraftVersion: '1.12.2',
    loaderFamily: 'forge',
    loaderVersion: '14.23.5.2860',
    javaMajor: 8,
    os: 'win32',
    architecture: 'x64'
  };
}

function writeLegacyForgeLayout(root, runtime = legacyForgeRuntime()) {
  const libraries = [
    'libraries/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar',
    'libraries/org/example/runtime/1.0/runtime-1.0.jar'
  ];
  for (const relativePath of libraries) {
    const filePath = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeMinimalJar(filePath, relativePath);
  }
  const serverJar = `minecraft_server.${runtime.minecraftVersion}.jar`;
  writeMinimalJar(path.join(root, serverJar), 'minecraft-server');
  const launchJar = `forge-${runtime.minecraftVersion}-${runtime.loaderVersion}.jar`;
  const archive = new AdmZip();
  const mainAttributes = [
    'Manifest-Version: 1.0',
    'Main-Class: net.minecraftforge.fml.relauncher.ServerLaunchWrapper',
    `Class-Path: ${libraries[0]} ${libraries[1]} `,
    ` ${serverJar}`,
    '',
    ''
  ].join('\r\n');
  const signedSections = Array.from({ length: 1200 }, (_, index) =>
    `Name: net/minecraftforge/fixture/Entry${index}.class\r\nSHA-256-Digest: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n`
  ).join('');
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from(mainAttributes + signedSections, 'utf8'));
  archive.addFile('net/minecraftforge/Legacy.class', Buffer.from('fixture'));
  archive.writeZip(path.join(root, launchJar));
  return { launchJar, serverJar, libraries };
}

function writeXmclLegacyForgeLayout(root, runtime = legacyForgeRuntime()) {
  const rootLayout = writeLegacyForgeLayout(root, runtime);
  const installedLaunchJar = [
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    `${runtime.minecraftVersion}-${runtime.loaderVersion}`,
    rootLayout.launchJar
  ].join('/');
  const installedServerJar = 'server.jar';
  const bundledServerJar = [
    'libraries',
    'net',
    'minecraft',
    'server',
    runtime.minecraftVersion,
    `server-${runtime.minecraftVersion}-bundled.jar`
  ].join('/');
  fs.mkdirSync(path.dirname(path.join(root, ...installedLaunchJar.split('/'))), { recursive: true });
  fs.copyFileSync(path.join(root, rootLayout.launchJar), path.join(root, ...installedLaunchJar.split('/')));
  fs.copyFileSync(path.join(root, rootLayout.serverJar), path.join(root, installedServerJar));
  fs.mkdirSync(path.dirname(path.join(root, ...bundledServerJar.split('/'))), { recursive: true });
  fs.copyFileSync(path.join(root, rootLayout.serverJar), path.join(root, ...bundledServerJar.split('/')));
  fs.rmSync(path.join(root, rootLayout.launchJar));
  fs.rmSync(path.join(root, rootLayout.serverJar));
  return { ...rootLayout, installedLaunchJar, installedServerJar, bundledServerJar };
}

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

test('Fabric runtime staging forwards its explicit mutation-marker opt-out without changing default installs', async () => {
  const calls = [];
  await withFabricInstaller(async (...args) => { calls.push(args); }, async loader => {
    const base = {
      targetPath: path.join(os.tmpdir(), 'minecraft-core-fabric-stage'),
      minecraftVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.16.10',
      javaPath: path.join(os.tmpdir(), 'minecraft-core-java', 'bin', 'java.exe')
    };
    await loader.installServerLoader({ ...base, skipMutationMark: true });
    await loader.installServerLoader(base);
  });

  assert.deepEqual(calls.map(call => call[5]), [
    { javaPath: path.join(os.tmpdir(), 'minecraft-core-java', 'bin', 'java.exe'), skipMutationMark: true },
    { javaPath: path.join(os.tmpdir(), 'minecraft-core-java', 'bin', 'java.exe') }
  ]);
});

test('Fabric runtime cancellation reaches the legacy installer boundary', async () => {
  const controller = new AbortController();
  let received;
  await withFabricInstaller(async (...args) => { received = args[5].signal; }, async loader => {
    await loader.installServerLoader({
      targetPath: path.join(os.tmpdir(), 'minecraft-core-fabric-cancel'),
      minecraftVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.16.10',
      javaPath: path.join(os.tmpdir(), 'minecraft-core-java', 'bin', 'java.exe'),
      signal: controller.signal
    });
  });
  assert.equal(received, controller.signal);
});

test('Fabric runtime obtains the verified Minecraft base only when the candidate has no valid server jar', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-fabric-base-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverJar = path.join(root, 'server.jar');
  writeMinimalJar(serverJar, 'existing');
  const runtime = { minecraftVersion: '1.20.1' };
  const calls = [];
  const ensureBaseRuntime = async options => {
    calls.push(options);
    writeMinimalJar(serverJar, 'downloaded');
  };

  await ensureFabricBaseRuntime(root, runtime, { signal: AbortSignal.abort() }, ensureBaseRuntime);
  assert.equal(calls.length, 0);
  assert.equal(new AdmZip(serverJar).readAsText('marker.txt'), 'existing');

  fs.rmSync(serverJar);
  await ensureFabricBaseRuntime(root, runtime, { signal: null }, ensureBaseRuntime);
  assert.deepEqual(calls, [{ targetPath: root, minecraftVersion: '1.20.1', signal: null }]);
  assert.equal(new AdmZip(serverJar).readAsText('marker.txt'), 'downloaded');
});

test('managed runtime integrity excludes mutable app lifecycle state from repeated launch validation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMinimalJar(path.join(root, 'server.jar'));
  const journalPath = path.join(
    root,
    '.minecraft-core-state',
    'operations',
    'job-runtime-journal',
    'journal.json'
  );
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, JSON.stringify({ phase: 'candidate-ready', sequence: 1 }));
  const summaryPath = path.join(root, '.minecraft-core.json');
  const modpackStatePath = path.join(root, '.minecraft-core-state', 'modpack.json');
  const historyPath = path.join(root, '.minecraft-core-state', 'history', 'operation.json');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify({ contentRevision: 1 }));
  fs.writeFileSync(modpackStatePath, JSON.stringify({ contentRevision: 1, modpackManaged: true }));
  fs.writeFileSync(historyPath, JSON.stringify({ sequence: 1 }));
  const runtime = {
    minecraftVersion: '1.20.1',
    loaderFamily: 'fabric',
    loaderVersion: '0.15.10',
    javaMajor: 17,
    os: process.platform,
    architecture: process.arch
  };

  await withFabricInstaller(async targetPath => {
    writeFabricLauncherJar(path.join(targetPath, 'fabric-server-launch.jar'));
  }, async loader => {
    await loader.prepareManagedServerRuntime({
      targetPath: root,
      runtime,
      javaPath: path.join(root, 'java', 'java-17', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java'),
      validateJava: async () => 17
    });
  });

  const metadata = JSON.parse(fs.readFileSync(
    path.join(root, '.minecraft-core-state', 'runtime.json'),
    'utf8'
  ));
  assert.equal(
    metadata.artifacts.some(artifact =>
      artifact.relativePath === '.minecraft-core.json' ||
      artifact.relativePath.startsWith('.minecraft-core-state/')
    ),
    false
  );

  fs.writeFileSync(journalPath, JSON.stringify({ phase: 'registered', sequence: 2 }));
  fs.writeFileSync(summaryPath, JSON.stringify({ contentRevision: 2 }));
  fs.writeFileSync(modpackStatePath, JSON.stringify({ contentRevision: 2, modpackManaged: true }));
  fs.writeFileSync(historyPath, JSON.stringify({ sequence: 2 }));
  assert.equal(validatePreparedRuntime(root, runtime).valid, true);
  await withFabricInstaller(async targetPath => {
    writeFabricLauncherJar(path.join(targetPath, 'fabric-server-launch.jar'));
  }, async loader => {
    await loader.prepareManagedServerRuntime({
      targetPath: root,
      runtime,
      javaPath: path.join(root, 'java', 'java-17', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java'),
      validateJava: async () => 17
    });
  });
  assert.equal(validatePreparedRuntime(root, runtime).valid, true);
  const plan = resolveLaunchPlan(root, {
    loader: runtime.loaderFamily,
    loaderVersion: runtime.loaderVersion,
    minecraftVersion: runtime.minecraftVersion,
    javaMajor: runtime.javaMajor,
    maxRam: 4
  }, { runtimeTuple: runtime });
  assert.equal(plan.loader, 'fabric');
});

test('managed runtime integrity records loader assets without hashing mutable server content', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMinimalJar(path.join(root, 'server.jar'));
  const mutableFiles = [
    ['backups', 'restore-point.zip'],
    ['config', 'pack.toml'],
    ['java', 'java-17', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java'],
    ['logs', 'latest.log'],
    ['mods', 'pack-content.jar'],
    ['world', 'level.dat']
  ];
  for (const segments of mutableFiles) {
    const filePath = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'mutable server content');
  }
  fs.writeFileSync(path.join(root, 'server.properties'), 'server-port=25565\n');
  const runtime = {
    minecraftVersion: '1.20.1',
    loaderFamily: 'fabric',
    loaderVersion: '0.16.9',
    javaMajor: 17,
    os: process.platform,
    architecture: process.arch
  };

  await withFabricInstaller(async targetPath => {
    writeFabricLauncherJar(path.join(targetPath, 'fabric-server-launch.jar'));
  }, async loader => {
    await loader.prepareManagedServerRuntime({
      targetPath: root,
      runtime,
      javaPath: path.join(root, 'java', 'java-17', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java'),
      validateJava: async () => 17
    });
  });

  const metadata = JSON.parse(fs.readFileSync(
    path.join(root, '.minecraft-core-state', 'runtime.json'),
    'utf8'
  ));
  assert.deepEqual(
    metadata.artifacts.map(artifact => artifact.relativePath),
    ['fabric-server-launch.jar', 'server.jar']
  );
  assert.equal(validatePreparedRuntime(root, runtime).valid, true);

  fs.writeFileSync(path.join(root, 'world', 'level.dat'), 'world changed after a clean shutdown');
  fs.writeFileSync(path.join(root, 'mods', 'pack-content.jar'), 'pack updated independently');
  assert.equal(validatePreparedRuntime(root, runtime).valid, true);
});

test('managed runtime artifact enumeration ignores sparse non-runtime pack data above the runtime byte cap', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-sparse-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeMinimalJar(path.join(root, 'server.jar'));
  const modPath = path.join(root, 'mods', 'large-pack-content.jar');
  fs.mkdirSync(path.dirname(modPath));
  const descriptor = fs.openSync(modPath, 'w');
  try {
    fs.ftruncateSync(descriptor, (1024 * 1024 * 1024) + 1);
  } finally {
    fs.closeSync(descriptor);
  }
  const runtime = {
    minecraftVersion: '1.20.1',
    loaderFamily: 'fabric',
    loaderVersion: '0.16.9',
    javaMajor: 17,
    os: process.platform,
    architecture: process.arch
  };

  await withFabricInstaller(async targetPath => {
    writeFabricLauncherJar(path.join(targetPath, 'fabric-server-launch.jar'));
  }, async loader => {
    await loader.prepareManagedServerRuntime({
      targetPath: root,
      runtime,
      javaPath: path.join(root, 'java', 'java-17', 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java'),
      validateJava: async () => 17
    });
  });

  const metadata = JSON.parse(fs.readFileSync(
    path.join(root, '.minecraft-core-state', 'runtime.json'),
    'utf8'
  ));
  assert.deepEqual(
    metadata.artifacts.map(artifact => artifact.relativePath),
    ['fabric-server-launch.jar', 'server.jar']
  );
  assert.equal(validatePreparedRuntime(root, runtime).valid, true);
});

test('runtime artifact enumeration keeps byte and file caps scoped to runtime roots', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-scoped-caps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'libraries'));
  fs.mkdirSync(path.join(root, 'versions'));
  fs.mkdirSync(path.join(root, 'world'));
  fs.writeFileSync(path.join(root, 'libraries', 'loader-a.jar'), 'a');
  fs.writeFileSync(path.join(root, 'versions', 'version-a.json'), 'b');
  fs.writeFileSync(path.join(root, 'world', 'level.dat'), 'non-runtime data is not measured');

  assert.deepEqual(
    listRuntimeArtifactFiles(root, { maxFiles: 2, maxBytes: 2 }).map(file => file.relativePath),
    ['libraries/loader-a.jar', 'versions/version-a.json']
  );
  assert.throws(
    () => listRuntimeArtifactFiles(root, { maxFiles: 1, maxBytes: 2 }),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.throws(
    () => listRuntimeArtifactFiles(root, { maxFiles: 2, maxBytes: 1 }),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
});

test('runtime artifact enumeration rejects a runtime-directory symlink containment escape', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-symlink-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-symlink-outside-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'escaped-runtime.jar'), 'outside');
  try {
    fs.symlinkSync(outside, path.join(root, 'libraries'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`directory links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () => listRuntimeArtifactFiles(root),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
});

test('legacy Forge runtime publication binds the tuple-derived launch jar, Minecraft server jar, and manifest libraries', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-legacy-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = legacyForgeRuntime();
  const layout = writeLegacyForgeLayout(root, runtime);

  const validation = publishForgeRuntimeMetadata(root, runtime);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.loader, {
    family: 'forge',
    launchJar: layout.launchJar,
    serverJar: layout.serverJar,
    libraries: layout.libraries
  });
  assert.deepEqual(
    validation.artifacts.map(artifact => artifact.relativePath),
    [...layout.libraries, layout.launchJar, layout.serverJar].sort((left, right) => left.localeCompare(right, 'en'))
  );
  assert.equal(
    listRuntimeArtifactFiles(root).some(file => file.relativePath === layout.serverJar),
    true
  );
});

test('runtime artifact hashing produces both digests in one identity-stable file pass', t => {
  assert.equal(typeof digestStableArtifact, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-stable-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'server.jar');
  const bytes = Buffer.alloc((2 * 1024 * 1024) + 137, 0x5a);
  fs.writeFileSync(filePath, bytes);
  let measuredBytes = 0;
  const fsApi = {
    ...fs,
    readSync(...args) {
      const count = fs.readSync(...args);
      measuredBytes += count;
      return count;
    }
  };

  const digested = digestStableArtifact(root, filePath, { fsApi });

  assert.equal(measuredBytes, bytes.length);
  assert.equal(digested.size, bytes.length);
  assert.equal(digested.sha256, 'c26dcb89d202521856a55ed7b6d3b312a30e9675dbf74d1c2def343000cd9a45');
  assert.equal(digested.sha512, '55d0260cdd85a81171ac6f469e83b30a5cb09ecc1a58a52aa7efa62280ed15e77b4f32dd1f5f13726489c8c8290ed54bcfbf4c15e729b1b060546f683f4d90f3');
});

test('runtime artifact hashing rejects same-size mutation while the descriptor is open', t => {
  assert.equal(typeof digestStableArtifact, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-mutating-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'server.jar');
  const original = Buffer.alloc((1024 * 1024) + 31, 0x31);
  const replacement = Buffer.alloc(original.length, 0x32);
  fs.writeFileSync(filePath, original);
  let mutated = false;
  const fsApi = {
    ...fs,
    readSync(...args) {
      const count = fs.readSync(...args);
      if (!mutated && args[4] + count >= original.length) {
        mutated = true;
        fs.writeFileSync(filePath, replacement);
      }
      return count;
    }
  };

  assert.throws(
    () => digestStableArtifact(root, filePath, { fsApi }),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
});

test('runtime artifact hashing rejects files with an external hard-link alias', t => {
  assert.equal(typeof digestStableArtifact, 'function');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-runtime-hard-link-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'server');
  fs.mkdirSync(root);
  const filePath = path.join(root, 'server.jar');
  fs.writeFileSync(filePath, 'runtime bytes');
  try {
    fs.linkSync(filePath, path.join(parent, 'external-alias.jar'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`hard links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  assert.throws(
    () => digestStableArtifact(root, filePath),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
});

test('Forge install finalization preserves runtime metadata while hashing every artifact once', t => {
  assert.equal(typeof finalizeForgeRuntimeMetadata, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-finalizer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = legacyForgeRuntime();
  const layout = writeLegacyForgeLayout(root, runtime);
  const artifactBytes = [...layout.libraries, layout.launchJar, layout.serverJar]
    .reduce((sum, relativePath) => sum + fs.statSync(path.join(root, ...relativePath.split('/'))).size, 0);
  let measuredBytes = 0;
  const fsApi = {
    ...fs,
    readSync(...args) {
      const count = fs.readSync(...args);
      measuredBytes += count;
      return count;
    }
  };

  const validation = finalizeForgeRuntimeMetadata(root, runtime, { fsApi });

  assert.equal(measuredBytes, artifactBytes);
  assert.deepEqual(validation.loader, {
    family: 'forge',
    launchJar: layout.launchJar,
    serverJar: layout.serverJar,
    libraries: layout.libraries
  });
  assert.equal(validatePreparedRuntime(root, runtime).valid, true);
});

test('legacy Forge runtime publication deterministically materializes the exact clean @xmcl installer layout', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-xmcl-materialize-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = legacyForgeRuntime();
  const layout = writeXmclLegacyForgeLayout(root, runtime);

  const validation = publishForgeRuntimeMetadata(root, runtime);
  assert.equal(validation.loader.launchJar, layout.launchJar);
  assert.equal(validation.loader.serverJar, layout.serverJar);
  assert.deepEqual(fs.readFileSync(path.join(root, layout.launchJar)), fs.readFileSync(
    path.join(root, ...layout.installedLaunchJar.split('/'))
  ));
  assert.deepEqual(fs.readFileSync(path.join(root, layout.serverJar)), fs.readFileSync(
    path.join(root, layout.installedServerJar)
  ));
  for (const requiredPath of [layout.launchJar, layout.serverJar, layout.installedLaunchJar,
    layout.installedServerJar, layout.bundledServerJar]) {
    assert.equal(validation.artifacts.some(artifact => artifact.relativePath === requiredPath), true, requiredPath);
  }
  assert.equal(publishForgeRuntimeMetadata(root, runtime).valid, true);
});

test('legacy Forge materialization rejects conflicting tuple-derived root artifacts', t => {
  for (const conflict of ['launch', 'server']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `minecraft-core-forge-xmcl-${conflict}-conflict-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = legacyForgeRuntime();
    const layout = writeXmclLegacyForgeLayout(root, runtime);
    fs.copyFileSync(path.join(root, ...layout.installedLaunchJar.split('/')), path.join(root, layout.launchJar));
    fs.copyFileSync(path.join(root, layout.installedServerJar), path.join(root, layout.serverJar));
    if (conflict === 'launch') {
      const archive = new AdmZip(path.join(root, layout.launchJar));
      archive.addFile('conflict.txt', Buffer.from('different valid launch jar'));
      archive.writeZip(path.join(root, layout.launchJar));
    } else {
      writeMinimalJar(path.join(root, layout.serverJar), 'different valid server jar');
    }

    assert.throws(
      () => publishForgeRuntimeMetadata(root, runtime),
      error => error.code === 'RUNTIME_INCOMPLETE',
      conflict
    );
    assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state', 'runtime.json')), false);
  }
});

test('legacy Forge materialization rejects substituted canonical Minecraft server bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-xmcl-server-substitution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = legacyForgeRuntime();
  const layout = writeXmclLegacyForgeLayout(root, runtime);
  writeMinimalJar(path.join(root, ...layout.bundledServerJar.split('/')), 'substituted bundled server');

  assert.throws(
    () => publishForgeRuntimeMetadata(root, runtime),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.equal(fs.existsSync(path.join(root, layout.launchJar)), false);
  assert.equal(fs.existsSync(path.join(root, layout.serverJar)), false);
  assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state', 'runtime.json')), false);
});

test('legacy Forge runtime validation fails closed on hashed dependency changes and tuple-derived artifact substitution', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-legacy-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = legacyForgeRuntime();
  const layout = writeLegacyForgeLayout(root, runtime);
  publishForgeRuntimeMetadata(root, runtime);

  fs.writeFileSync(path.join(root, ...layout.libraries[0].split('/')), 'substituted library bytes');
  assert.throws(
    () => validatePreparedRuntime(root, runtime),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );

  writeLegacyForgeLayout(root, runtime);
  publishForgeRuntimeMetadata(root, runtime);
  fs.writeFileSync(path.join(root, layout.serverJar), 'substituted Minecraft server bytes');
  assert.throws(
    () => validatePreparedRuntime(root, runtime),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );

  writeLegacyForgeLayout(root, runtime);
  publishForgeRuntimeMetadata(root, runtime);
  assert.throws(
    () => validatePreparedRuntime(root, { ...runtime, loaderVersion: '14.23.5.9999' }),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );

  const metadataPath = path.join(root, '.minecraft-core-state', 'runtime.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const substitutedJar = 'forge-1.12.2-14.23.5.9999.jar';
  fs.copyFileSync(path.join(root, layout.launchJar), path.join(root, substitutedJar));
  metadata.loader.launchJar = substitutedJar;
  metadata.artifacts.push(runtimeArtifact(root, substitutedJar));
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(
    () => validatePreparedRuntime(root, runtime),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );

  metadata.loader.launchJar = '../outside.jar';
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(
    () => validatePreparedRuntime(root, runtime),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
});

test('legacy Forge publication rejects manifest classpath traversal before metadata is written', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-forge-legacy-classpath-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = legacyForgeRuntime();
  const layout = writeLegacyForgeLayout(root, runtime);
  const launchPath = path.join(root, layout.launchJar);
  const archive = new AdmZip();
  archive.addFile('META-INF/MANIFEST.MF', Buffer.from([
    'Manifest-Version: 1.0',
    'Main-Class: net.minecraftforge.fml.relauncher.ServerLaunchWrapper',
    `Class-Path: ${layout.libraries[0]} ../outside.jar ${layout.serverJar}`,
    '',
    ''
  ].join('\r\n')));
  archive.addFile('fixture.class', Buffer.from('fixture'));
  archive.writeZip(launchPath);

  assert.throws(
    () => publishForgeRuntimeMetadata(root, runtime),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state', 'runtime.json')), false);
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
