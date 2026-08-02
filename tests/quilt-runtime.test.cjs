const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
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

test('Quilt versions come from the exact game endpoint with a proper User-Agent and no latest fallback', async () => {
  const transport = fakeTransport(new Map([[LIST_URL, [pair('0.26.3'), pair(), pair('0.27.0-beta.1')]]]));
  const versions = await getLoaderVersions('quilt', GAME, { transport });
  assert.deepEqual(versions, ['0.27.0-beta.1', VERSION, '0.26.3']);
  assert.deepEqual(transport.calls.map(call => call.url), [LIST_URL]);
  assert.match(transport.calls[0].options.headers['User-Agent'], /^Minecraft-Core\//);
  assert.equal(transport.calls[0].url.includes('/latest'), false);
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
  let baseCalls = 0;
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
    ensureBaseRuntime: async ({ targetPath }) => {
      baseCalls += 1;
      fs.writeFileSync(path.join(targetPath, 'server.jar'), serverBytes);
    },
    processRunner: async () => { processCalls += 1; throw new Error('Quilt must not execute an installer'); }
  });

  assert.equal(baseCalls, 1);
  assert.equal(processCalls, 0);
  assert.equal(result.loader, 'quilt');
  assert.deepEqual(result.runtime, tuple());
  assert.deepEqual(transport.calls.slice(0, 2).map(call => call.url), [PAIR_URL, PROFILE_URL]);
  assert.equal(transport.calls.some(call => call.url.includes('/latest')), false);
  assert.equal(fs.readFileSync(path.join(root, 'run.ps1'), 'utf8'), 'pack supplied');
  assert.equal(fs.readFileSync(path.join(root, 'quilt-installer.jar'), 'utf8'), 'pack supplied');
  assert.equal(fs.existsSync(path.join(root, 'fabric-server-launch.jar')), false);
  assert.equal(fs.readFileSync(path.join(root, 'quilt-server-launcher.properties'), 'utf8'), 'serverJar=server.jar\n');

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
    'org.quiltmc:loader:1.0@zip'
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
    ensureBaseRuntime: async ({ targetPath }) => fs.writeFileSync(path.join(targetPath, 'server.jar'), serverBytes)
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
    ensureBaseRuntime: async ({ targetPath }) => fs.writeFileSync(path.join(targetPath, 'server.jar'), serverBytes)
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
