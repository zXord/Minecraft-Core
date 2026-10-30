const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const https = require('node:https');
const AdmZip = require('adm-zip');

const {
  getLoaderVersions,
  installServerLoader,
  validatePreparedRuntime,
  __testUtils
} = require('../electron/services/loader-install-service.cjs');
const { resolveLaunchPlan } = require('../electron/services/server-launcher.cjs');
const { resolveServerLoader } = require('../electron/utils/server-loader.cjs');

const GAME = '1.20.1';
const VERSION = '0.26.4';
const LIST_URL = `https://meta.quiltmc.org/v3/versions/loader/${GAME}`;
const PAIR_URL = `${LIST_URL}/${VERSION}`;
const PROFILE_URL = `${PAIR_URL}/server/json`;
const QUILT_MAVEN = 'https://maven.quiltmc.org/repository/release/';
const FABRIC_MAVEN = 'https://maven.fabricmc.net/';
const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const VANILLA_SERVER_JAR = `libraries/net/minecraft/server/${GAME}/server-${GAME}.jar`;
// Pinned bytes of the generated launcher for this library set: a targeted Repair must regenerate exactly these.
const LAUNCHER_JAR_SHA256 = '5093118106a9f3833c3c1b6fee39e9e79ee67c6544102fcc556be306ff0183c4';
const LIBRARY_PATHS = [
  'libraries/net/fabricmc/intermediary/1.20.1/intermediary-1.20.1.jar',
  'libraries/org/quiltmc/hashed/1.20.1/hashed-1.20.1.jar',
  'libraries/org/quiltmc/quilt-loader/0.26.4/quilt-loader-0.26.4.jar'
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Stands in for the pinned Mojang download: writes the vanilla jar where the installer asks for it.
function fakeBaseRuntime(serverBytes, calls = null) {
  return async options => {
    if (calls) calls.push(options);
    const destination = path.join(options.targetPath, ...(options.destinationRelativePath ?? 'server.jar').split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, serverBytes);
  };
}

function jarBytes(label) {
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(`Manifest-Version: 1.0\r\nX-Fixture: ${label}\r\n\r\n`));
  return zip.toBuffer();
}

function hashes(bytes) {
  return {
    sha1: crypto.createHash('sha1').update(bytes).digest('hex'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sha512: crypto.createHash('sha512').update(bytes).digest('hex')
  };
}

const libraryBytes = {
  'org.quiltmc:quilt-loader:0.26.4': jarBytes('loader'),
  'org.quiltmc:hashed:1.20.1': jarBytes('hashed'),
  'net.fabricmc:intermediary:1.20.1': jarBytes('intermediary')
};

function pair(loaderVersion = VERSION, gameVersion = GAME) {
  return {
    loader: {
      maven: `org.quiltmc:quilt-loader:${loaderVersion}`,
      version: loaderVersion,
      build: 4,
      separator: '.',
      file_size: libraryBytes['org.quiltmc:quilt-loader:0.26.4'].length,
      hashes: hashes(libraryBytes['org.quiltmc:quilt-loader:0.26.4'])
    },
    hashed: {
      maven: `org.quiltmc:hashed:${gameVersion}`,
      version: gameVersion,
      file_size: libraryBytes['org.quiltmc:hashed:1.20.1'].length,
      hashes: hashes(libraryBytes['org.quiltmc:hashed:1.20.1'])
    },
    intermediary: {
      maven: `net.fabricmc:intermediary:${gameVersion}`,
      version: gameVersion
    },
    launcherMeta: {
      version: 2,
      libraries: { client: [], common: [], server: [] },
      mainClass: { client: 'client.Main', server: 'server.Main' }
    }
  };
}

function profile(libraries = [
  { name: 'org.quiltmc:quilt-loader:0.26.4', url: QUILT_MAVEN },
  { name: 'org.quiltmc:hashed:1.20.1', url: QUILT_MAVEN },
  { name: 'net.fabricmc:intermediary:1.20.1', url: FABRIC_MAVEN }
]) {
  return {
    id: `quilt-loader-${VERSION}-${GAME}`,
    inheritsFrom: GAME,
    type: 'release',
    mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotServer',
    launcherMainClass: 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher',
    arguments: { game: [] },
    libraries,
    releaseTime: '2023-06-12T13:25:51+00:00',
    time: '2026-07-28T06:43:40+00:00'
  };
}

function response(value, statusCode = 200, headers = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const stream = Readable.from([body]);
  stream.statusCode = statusCode;
  stream.headers = { 'content-length': String(body.length), ...headers };
  return stream;
}

function fakeTransport(routes) {
  const calls = [];
  return {
    calls,
    async request(url, options) {
      calls.push({ url: String(url), options });
      const route = routes.get(String(url));
      if (!route) throw new Error(`unexpected URL ${url}`);
      return response(route.body ?? route, route.statusCode ?? 200, route.headers);
    }
  };
}

function mavenUrl(repository, coordinate) {
  const [group, artifact, version] = coordinate.split(':');
  return `${repository}${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
}

function routesForInstall(serverBytes = jarBytes('server')) {
  const routes = new Map([
    [PAIR_URL, pair()],
    [PROFILE_URL, profile()]
  ]);
  for (const [coordinate, bytes] of Object.entries(libraryBytes)) {
    routes.set(mavenUrl(coordinate.startsWith('net.fabricmc') ? FABRIC_MAVEN : QUILT_MAVEN, coordinate), bytes);
  }
  return { routes, serverBytes };
}

function tuple() {
  return {
    minecraftVersion: GAME,
    loaderFamily: 'quilt',
    loaderVersion: VERSION,
    javaMajor: 17,
    os: 'win32',
    architecture: 'x64'
  };
}

function mojangRoutes(serverBytes = jarBytes('server')) {
  const serverSha1 = crypto.createHash('sha1').update(serverBytes).digest('hex');
  const serverUrl = `https://piston-data.mojang.com/v1/objects/${serverSha1}/server.jar`;
  const versionMetadata = {
    id: GAME,
    type: 'release',
    downloads: {
      server: {
        sha1: serverSha1,
        size: serverBytes.length,
        url: serverUrl
      }
    }
  };
  const versionBytes = Buffer.from(JSON.stringify(versionMetadata));
  const versionSha1 = crypto.createHash('sha1').update(versionBytes).digest('hex');
  const versionUrl = `https://piston-meta.mojang.com/v1/packages/${versionSha1}/${GAME}.json`;
  return {
    routes: new Map([
      [MOJANG_MANIFEST_URL, {
        latest: { release: GAME, snapshot: GAME },
        versions: [{ id: GAME, type: 'release', url: versionUrl, sha1: versionSha1 }]
      }],
      [versionUrl, versionBytes],
      [serverUrl, serverBytes]
    ]),
    serverUrl,
    versionUrl
  };
}

test('Quilt versions come from the exact game endpoint with a proper User-Agent and no latest fallback', async () => {
  const transport = fakeTransport(new Map([[LIST_URL, [pair('0.26.3'), pair(), pair('0.27.0-beta.1')]]]));
  const versions = await getLoaderVersions('quilt', GAME, { transport });
  assert.deepEqual(versions, ['0.27.0-beta.1', VERSION, '0.26.3']);
  assert.deepEqual(transport.calls.map(call => call.url), [LIST_URL]);
  assert.match(transport.calls[0].options.headers['User-Agent'], /^Minecraft-Core\//);
  assert.equal(transport.calls[0].url.includes('/latest'), false);
  assert.deepEqual(transport.calls[0].options.allowedOrigins, ['https://meta.quiltmc.org']);
});

test('Quilt rejects empty, mismatched, hostile, and oversized Meta responses', async () => {
  for (const value of [[], [pair(VERSION, '1.20.2')], { loader: { version: VERSION } }, '{"loader":']) {
    const transport = fakeTransport(new Map([[LIST_URL, value]]));
    await assert.rejects(getLoaderVersions('quilt', GAME, { transport }), error => error.code === 'LOADER_VERSION_UNAVAILABLE');
  }
  const transport = fakeTransport(new Map([[LIST_URL, JSON.stringify([pair()]).padEnd(4096, ' ')]]));
  await assert.rejects(
    getLoaderVersions('quilt', GAME, { transport, maxMetadataBytes: 512 }),
    error => error.code === 'LOADER_VERSION_UNAVAILABLE'
  );
});

test('Quilt resolves the exact pair, maps strict Maven paths, and reconstructs a deterministic app-owned server', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'run.ps1'), 'pack supplied');
  fs.writeFileSync(path.join(root, 'quilt-installer.jar'), 'pack supplied');
  fs.writeFileSync(path.join(root, 'fabric-server-launch.jar'), 'stale Fabric launcher');
  const { routes, serverBytes } = routesForInstall();
  const transport = fakeTransport(routes);
  const baseCalls = [];
  let processCalls = 0;
  const result = await installServerLoader({
    targetPath: root,
    minecraftVersion: GAME,
    loader: 'quilt',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java', 'bin', 'java.exe'),
    javaMajor: 17,
    transport,
    validateJava: async ({ expectedMajor }) => expectedMajor,
    ensureBaseRuntime: fakeBaseRuntime(serverBytes, baseCalls),
    processRunner: async () => { processCalls += 1; throw new Error('Quilt must not execute an installer'); }
  });

  assert.equal(baseCalls.length, 1);
  assert.equal(baseCalls[0].destinationRelativePath, VANILLA_SERVER_JAR);
  assert.equal(processCalls, 0);
  assert.equal(result.loader, 'quilt');
  assert.deepEqual(result.runtime, tuple());
  assert.deepEqual(transport.calls.slice(0, 2).map(call => call.url), [PAIR_URL, PROFILE_URL]);
  for (const call of transport.calls) {
    assert.deepEqual(call.options.allowedOrigins, [new URL(call.url).origin]);
  }
  assert.equal(transport.calls.some(call => call.url.includes('/latest')), false);
  assert.equal(fs.readFileSync(path.join(root, 'run.ps1'), 'utf8'), 'pack supplied');
  assert.equal(fs.readFileSync(path.join(root, 'quilt-installer.jar'), 'utf8'), 'pack supplied');
  assert.equal(fs.existsSync(path.join(root, 'fabric-server-launch.jar')), false);
  assert.equal(
    fs.readFileSync(path.join(root, 'quilt-server-launcher.properties'), 'utf8'),
    `serverJar=${VANILLA_SERVER_JAR}\n`
  );
  assert.deepEqual(fs.readFileSync(path.join(root, ...VANILLA_SERVER_JAR.split('/'))), serverBytes);
  assert.deepEqual(fs.readFileSync(path.join(root, 'server.jar')), fs.readFileSync(path.join(root, 'quilt-server-launch.jar')));
  assert.equal(sha256(fs.readFileSync(path.join(root, 'server.jar'))), LAUNCHER_JAR_SHA256);
  const recorded = JSON.parse(fs.readFileSync(path.join(root, '.minecraft-core-state', 'runtime.json'), 'utf8'))
    .artifacts.map(artifact => artifact.relativePath);
  for (const relativePath of ['server.jar', VANILLA_SERVER_JAR, 'quilt-server-launch.jar', 'quilt-server-launcher.properties']) {
    assert.equal(recorded.includes(relativePath), true, relativePath);
  }

  const launchJar = fs.readFileSync(path.join(root, 'quilt-server-launch.jar'));
  const manifest = new AdmZip(launchJar).readAsText('META-INF/MANIFEST.MF');
  assert.match(manifest, /^Manifest-Version: 1\.0\r?$/m);
  assert.match(manifest, /^Main-Class: org\.quiltmc\.loader\.impl\.launch\.server\.QuiltServerLauncher\r?$/m);
  const unfolded = manifest.replace(/\r?\n /g, '');
  assert.match(unfolded, /Class-Path: libraries\/net\/fabricmc\/intermediary\/1\.20\.1\/intermediary-1\.20\.1\.jar libraries\/org\/quiltmc\/hashed\/1\.20\.1\/hashed-1\.20\.1\.jar libraries\/org\/quiltmc\/quilt-loader\/0\.26\.4\/quilt-loader-0\.26\.4\.jar/);
  assert.equal(validatePreparedRuntime(root, tuple()).valid, true);
  assert.deepEqual(resolveServerLoader(root), {
    loader: 'quilt',
    loaderVersion: VERSION,
    source: 'runtime-metadata'
  });
  fs.writeFileSync(path.join(root, '.minecraft-core.json'), JSON.stringify({
    loader: 'vanilla',
    loaderVersion: GAME
  }));
  assert.deepEqual(resolveServerLoader(root), {
    loader: 'quilt',
    loaderVersion: VERSION,
    source: 'runtime-metadata'
  });
});

test('strict Quilt Maven mapping rejects classifiers, unsafe hosts, credentials, ports, and collisions', () => {
  assert.equal(
    __testUtils.mavenCoordinateToPath('org.quiltmc:quilt-loader:0.26.4'),
    'org/quiltmc/quilt-loader/0.26.4/quilt-loader-0.26.4.jar'
  );
  for (const coordinate of [
    'org.quiltmc:quilt-loader:0.26.4:all',
    'org.quiltmc:quilt-loader',
    '../org:loader:1.0',
    'org.quiltmc:loader:1.0@zip',
    'org.CON.quiltmc:loader:1.0',
    'org.quiltmc:COM1:1.0',
    'org.quiltmc:loader:NUL',
    'org.quiltmc:COM¹:1.0',
    'org.CONIN$:loader:1.0'
  ]) {
    assert.throws(() => __testUtils.mavenCoordinateToPath(coordinate), error => error.code === 'RUNTIME_INCOMPLETE');
  }
  for (const url of [
    'https://evil.example/repository/',
    'https://user:password@maven.quiltmc.org/repository/release/',
    'https://maven.quiltmc.org:444/repository/release/'
  ]) {
    assert.throws(() => __testUtils.validateQuiltRepository(url), error => error.code === 'RUNTIME_INCOMPLETE');
  }
  assert.throws(
    () => __testUtils.normalizeQuiltLibraries(profile([
      { name: 'org.quiltmc:quilt-loader:0.26.4', url: QUILT_MAVEN },
      { name: 'org.quiltmc:quilt-loader:0.26.4', url: QUILT_MAVEN }
    ]).libraries),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  for (const relativePath of [
    'libraries/CON/file.jar',
    'libraries/aux.txt/file.jar',
    'libraries/COM¹/file.jar',
    'libraries/CONIN$/file.jar'
  ]) {
    assert.equal(__testUtils.safeRelativePath(relativePath), null, relativePath);
  }
});

test('semantic Quilt aliases and ranges are rejected before Java resolution or network access', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const loaderVersion of ['latest', 'recommended', 'stable', '1.x', '0.26+', '[0.20,1.0)']) {
    let javaResolutions = 0;
    const transport = fakeTransport(new Map());
    await assert.rejects(installServerLoader({
      targetPath: root,
      minecraftVersion: GAME,
      loader: 'quilt',
      loaderVersion,
      javaPath: path.join(root, 'java.exe'),
      resolveJavaVersion: async () => { javaResolutions += 1; return { requiredJavaVersion: 17 }; },
      validateJava: async () => 17,
      transport
    }), error => error.code === 'LOADER_VERSION_REQUIRED', loaderVersion);
    assert.equal(javaResolutions, 0, loaderVersion);
    assert.equal(transport.calls.length, 0, loaderVersion);
  }
});

test('Quilt exact pair/profile mismatch is unavailable and never chooses the first loader', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    targetPath: root,
    minecraftVersion: GAME,
    loader: 'quilt',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 17,
    validateJava: async () => 17,
    ensureBaseRuntime: async () => {}
  };
  await assert.rejects(installServerLoader({
    ...options,
    transport: fakeTransport(new Map([[PAIR_URL, { body: '', statusCode: 404 }]]))
  }), error => error.code === 'LOADER_VERSION_UNAVAILABLE');

  await assert.rejects(installServerLoader({
    ...options,
    transport: fakeTransport(new Map([
      [PAIR_URL, pair()],
      [PROFILE_URL, { ...profile(), inheritsFrom: '1.20.2' }]
    ]))
  }), error => error.code === 'LOADER_VERSION_UNAVAILABLE');
});

test('Quilt verifies every official digest supplied for each downloaded library', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-all-digests-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tamperedPair = pair();
  tamperedPair.loader.hashes.sha1 = '0'.repeat(40);
  const { routes, serverBytes } = routesForInstall();
  routes.set(PAIR_URL, tamperedPair);
  await assert.rejects(installServerLoader({
    targetPath: root,
    minecraftVersion: GAME,
    loader: 'quilt',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 17,
    transport: fakeTransport(routes),
    validateJava: async () => 17,
    ensureBaseRuntime: fakeBaseRuntime(serverBytes)
  }), error => error.code === 'RUNTIME_INCOMPLETE');
  assert.equal(fs.existsSync(path.join(root, 'quilt-server-launch.jar')), false);
});

test('production Quilt base acquisition uses only bounded pinned Mojang endpoints and verifies official digests', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-mojang-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { routes } = routesForInstall();
  const mojang = mojangRoutes();
  for (const entry of mojang.routes) routes.set(...entry);
  const transport = fakeTransport(routes);
  const legacyGet = https.get;
  https.get = () => { throw new Error('legacy raw https.get must not be used for Quilt'); };
  try {
    const result = await installServerLoader({
      targetPath: root,
      minecraftVersion: GAME,
      loader: 'quilt',
      loaderVersion: VERSION,
      javaPath: path.join(root, 'java.exe'),
      javaMajor: 17,
      transport,
      validateJava: async () => 17,
      timeoutMs: 1000
    });
    assert.equal(result.loader, 'quilt');
  } finally {
    https.get = legacyGet;
  }
  assert.deepEqual(
    transport.calls.filter(call => call.url.includes('mojang.com')).map(call => call.url),
    [MOJANG_MANIFEST_URL, mojang.versionUrl, mojang.serverUrl]
  );
  for (const call of transport.calls.filter(call => call.url.includes('mojang.com'))) {
    assert.deepEqual(call.options.allowedOrigins, [new URL(call.url).origin]);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
  assert.equal(validatePreparedRuntime(root, tuple()).valid, true);
  assert.deepEqual(fs.readFileSync(path.join(root, ...VANILLA_SERVER_JAR.split('/'))), mojang.routes.get(mojang.serverUrl));
  assert.deepEqual(fs.readFileSync(path.join(root, 'server.jar')), fs.readFileSync(path.join(root, 'quilt-server-launch.jar')));
});

test('production Quilt base acquisition fails closed on malformed UTF-8 and cancellation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-mojang-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = routesForInstall().routes;
  first.set(MOJANG_MANIFEST_URL, Buffer.from([0xc3, 0x28]));
  const legacyGet = https.get;
  https.get = () => { throw new Error('legacy raw https.get must not be used for Quilt'); };
  try {
    await assert.rejects(installServerLoader({
      targetPath: root,
      minecraftVersion: GAME,
      loader: 'quilt',
      loaderVersion: VERSION,
      javaPath: path.join(root, 'java.exe'),
      javaMajor: 17,
      transport: fakeTransport(first),
      validateJava: async () => 17
    }), error => error.code === 'RUNTIME_INCOMPLETE');
  } finally {
    https.get = legacyGet;
  }

  const controller = new AbortController();
  controller.abort();
  const cancelledTransport = fakeTransport(new Map());
  await assert.rejects(installServerLoader({
    targetPath: root,
    minecraftVersion: GAME,
    loader: 'quilt',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 17,
    transport: cancelledTransport,
    validateJava: async () => 17,
    signal: controller.signal
  }), error => error.code === 'CANCELLED');
  assert.equal(cancelledTransport.calls.length, 0);
});

test('Quilt validation rejects partial or mutated libraries and launch never falls back to Vanilla', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { routes, serverBytes } = routesForInstall();
  await installServerLoader({
    targetPath: root,
    minecraftVersion: GAME,
    loader: 'quilt',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 17,
    transport: fakeTransport(routes),
    validateJava: async () => 17,
    ensureBaseRuntime: fakeBaseRuntime(serverBytes)
  });
  const mutated = path.join(root, 'libraries', 'org', 'quiltmc', 'quilt-loader', VERSION, `quilt-loader-${VERSION}.jar`);
  fs.appendFileSync(mutated, 'tampered');
  assert.throws(() => validatePreparedRuntime(root, tuple()), error => error.code === 'RUNTIME_INCOMPLETE');
  assert.throws(
    () => resolveLaunchPlan(root, { loader: 'quilt', maxRam: 4 }, { runtimeTuple: tuple() }),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
});

test('Quilt launch is the exact app-owned launcher jar with stable markers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { routes, serverBytes } = routesForInstall();
  await installServerLoader({
    targetPath: root,
    minecraftVersion: GAME,
    loader: 'quilt',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 17,
    transport: fakeTransport(routes),
    validateJava: async () => 17,
    ensureBaseRuntime: fakeBaseRuntime(serverBytes)
  });
  const plan = resolveLaunchPlan(root, { loader: 'quilt', maxRam: 5 }, { runtimeTuple: tuple() });
  assert.equal(plan.type, 'jar');
  assert.equal(plan.loader, 'quilt');
  assert.equal(plan.jar, path.join(root, 'quilt-server-launch.jar'));
  assert.deepEqual(plan.args, ['-Xmx5G', '-Xms1G', '-jar', plan.jar, 'nogui']);
  assert.equal(plan.cwd, root);
  assert.ok(plan.readyMarkers.some(marker => marker.includes('Done (')));
  assert.ok(plan.fatalMarkers.includes('UnsupportedClassVersionError'));
});

async function installQuilt(targetPath, serverBytes) {
  return installServerLoader({
    targetPath,
    minecraftVersion: GAME,
    loader: 'quilt',
    loaderVersion: VERSION,
    javaPath: path.join(targetPath, 'java.exe'),
    javaMajor: 17,
    transport: fakeTransport(routesForInstall().routes),
    validateJava: async () => 17,
    ensureBaseRuntime: fakeBaseRuntime(serverBytes)
  });
}

function recordedArtifact(root, relativePath) {
  const record = JSON.parse(fs.readFileSync(path.join(root, '.minecraft-core-state', 'runtime.json'), 'utf8'));
  return record.artifacts.find(artifact => artifact.relativePath === relativePath) || null;
}

// Mirrors the targeted runtime Repair check (production-mutation-runtime.cjs #repairCandidateRuntimePaths):
// a runtime file regenerated into a fresh staging folder replaces the live one only when its size and
// hash equal the recorded artifact; otherwise the repair fails with RUNTIME_INCOMPLETE.
function repairRuntimeFile(liveRoot, stagingRoot, relativePath) {
  const recorded = recordedArtifact(liveRoot, relativePath);
  const regenerated = fs.readFileSync(path.join(stagingRoot, ...relativePath.split('/')));
  if (!recorded || regenerated.length !== recorded.size || sha256(regenerated) !== recorded.sha256) {
    throw Object.assign(new Error('The prepared server runtime is incomplete.'), { code: 'RUNTIME_INCOMPLETE' });
  }
  fs.writeFileSync(path.join(liveRoot, ...relativePath.split('/')), regenerated);
}

// Re-records every runtime artifact as it now is on disk, the way a publication would.
function republishArtifacts(root) {
  const metadataPath = path.join(root, '.minecraft-core-state', 'runtime.json');
  const record = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  record.artifacts = __testUtils.listRuntimeArtifactFiles(root).map(file => {
    const bytes = fs.readFileSync(file.source);
    return {
      relativePath: file.relativePath,
      size: bytes.length,
      sha256: sha256(bytes),
      sha512: crypto.createHash('sha512').update(bytes).digest('hex')
    };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  fs.writeFileSync(metadataPath, `${JSON.stringify(record, null, 2)}\n`);
}

test('the Quilt launcher jar, and so its root server.jar copy, has identical bytes in every time zone', () => {
  const modulePath = require.resolve('../electron/services/loader-install-service.cjs');
  const script = [
    "const crypto = require('node:crypto');",
    `const { __testUtils } = require(${JSON.stringify(modulePath)});`,
    `const libraries = ${JSON.stringify(LIBRARY_PATHS)}.map(relativePath => ({ relativePath }));`,
    'process.stdout.write(JSON.stringify({',
    '  offset: new Date(1980, 0, 1).getTimezoneOffset(),',
    "  sha256: crypto.createHash('sha256').update(__testUtils.quiltLauncherJarBytes(libraries)).digest('hex')",
    '}));'
  ].join('\n');
  const runs = ['UTC', 'EST5EDT'].map(TZ => {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ },
      timeout: 60_000,
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split(/\r?\n/u).pop());
  });

  assert.deepEqual(runs.map(run => run.offset), [0, 300], 'each child ran in its own time zone');
  assert.deepEqual(runs.map(run => run.sha256), [LAUNCHER_JAR_SHA256, LAUNCHER_JAR_SHA256]);
  assert.equal(
    sha256(__testUtils.quiltLauncherJarBytes(LIBRARY_PATHS.map(relativePath => ({ relativePath })))),
    LAUNCHER_JAR_SHA256
  );
});

test('targeted Repair regenerates the Quilt root jar and launcher with the recorded hashes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, 'live');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(live);
  fs.mkdirSync(staging);
  const serverBytes = jarBytes('vanilla-for-repair');
  await installQuilt(live, serverBytes);
  fs.writeFileSync(path.join(live, 'server.jar'), jarBytes('damaged root'));
  fs.rmSync(path.join(live, 'quilt-server-launch.jar'));
  assert.throws(() => validatePreparedRuntime(live, tuple()), error => error.code === 'RUNTIME_INCOMPLETE');

  await installQuilt(staging, serverBytes);
  repairRuntimeFile(live, staging, 'server.jar');
  repairRuntimeFile(live, staging, 'quilt-server-launch.jar');

  assert.equal(validatePreparedRuntime(live, tuple()).valid, true);
  assert.equal(sha256(fs.readFileSync(path.join(live, 'server.jar'))), LAUNCHER_JAR_SHA256);
  assert.equal(sha256(fs.readFileSync(path.join(live, 'quilt-server-launch.jar'))), LAUNCHER_JAR_SHA256);
});

test('a pre-release Quilt layout keeps validating, a targeted Repair of its vanilla root jar fails closed, and an update rewrites it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-prerelease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, 'live');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(live);
  fs.mkdirSync(staging);
  const serverBytes = jarBytes('vanilla-prerelease');
  await installQuilt(live, serverBytes);
  // What pre-release builds published: vanilla as the root server.jar and serverJar=server.jar.
  fs.writeFileSync(path.join(live, 'server.jar'), serverBytes);
  fs.rmSync(path.join(live, ...VANILLA_SERVER_JAR.split('/')));
  fs.writeFileSync(path.join(live, 'quilt-server-launcher.properties'), 'serverJar=server.jar\n');
  republishArtifacts(live);
  assert.equal(validatePreparedRuntime(live, tuple()).valid, true);
  assert.equal(resolveLaunchPlan(live, { loader: 'quilt', maxRam: 4 }, { runtimeTuple: tuple() }).jar,
    path.join(live, 'quilt-server-launch.jar'));

  await installQuilt(staging, serverBytes);
  assert.throws(
    () => repairRuntimeFile(live, staging, 'server.jar'),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.deepEqual(fs.readFileSync(path.join(live, 'server.jar')), serverBytes);

  await installQuilt(live, serverBytes);
  assert.equal(
    fs.readFileSync(path.join(live, 'quilt-server-launcher.properties'), 'utf8'),
    `serverJar=${VANILLA_SERVER_JAR}\n`
  );
  assert.equal(sha256(fs.readFileSync(path.join(live, 'server.jar'))), LAUNCHER_JAR_SHA256);
  assert.equal(validatePreparedRuntime(live, tuple()).valid, true);
});

test('Quilt validation accepts only the legacy or the exact libraries serverJar reference', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-quilt-serverjar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await installQuilt(root, jarBytes('vanilla-reference'));
  const otherVersion = 'libraries/net/minecraft/server/1.20.2/server-1.20.2.jar';
  fs.mkdirSync(path.dirname(path.join(root, ...otherVersion.split('/'))), { recursive: true });
  fs.copyFileSync(path.join(root, ...VANILLA_SERVER_JAR.split('/')), path.join(root, ...otherVersion.split('/')));
  fs.writeFileSync(path.join(root, 'quilt-server-launcher.properties'), `serverJar=${otherVersion}\n`);
  republishArtifacts(root);

  assert.throws(() => validatePreparedRuntime(root, tuple()), error => error.code === 'RUNTIME_INCOMPLETE');
});
