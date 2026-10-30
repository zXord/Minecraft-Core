const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const AdmZip = require('adm-zip');

const {
  installServerLoader,
  validatePreparedRuntime,
  __testUtils: { NEOFORGE_DOWNGRADE_GUARD_MAIN_CLASS }
} = require('../electron/services/loader-install-service.cjs');
const {
  v26_6_1HealthMissing,
  v26_6_1LaunchDecision
} = require('./fixtures/v26.6.1-launch-decision.cjs');

// Downgrade safety (A53): v26.6.1 has no NeoForge or Quilt launch path and runs the root server.jar of
// such servers. The layouts the current installers publish must never let it run vanilla on a modded
// world, and must not look broken to its health panel (its Repair would download vanilla).

const NEOFORGE_VERSION = '21.1.172';
const NEOFORGE_GAME = '1.21.1';
const NEOFORGE_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const NEOFORGE_INSTALLER_URL = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-installer.jar`;
const QUILT_VERSION = '0.26.4';
const QUILT_GAME = '1.20.1';
const QUILT_PAIR_URL = `https://meta.quiltmc.org/v3/versions/loader/${QUILT_GAME}/${QUILT_VERSION}`;
const QUILT_MAVEN = 'https://maven.quiltmc.org/repository/release/';
const FABRIC_MAVEN = 'https://maven.fabricmc.net/';

function jarBytes(label) {
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(`Manifest-Version: 1.0\r\nX-Fixture: ${label}\r\n\r\n`));
  zip.addFile('version.json', Buffer.from(JSON.stringify({ id: label })));
  return zip.toBuffer();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fakeTransport(routes) {
  return {
    async request(url) {
      const route = routes.get(String(url));
      if (!route) throw new Error(`unexpected URL ${url}`);
      const body = Buffer.isBuffer(route) ? route : Buffer.from(typeof route === 'string' ? route : JSON.stringify(route));
      const stream = Readable.from([body]);
      stream.statusCode = 200;
      stream.headers = { 'content-length': String(body.length) };
      return stream;
    }
  };
}

function writeSummary(root, runtime) {
  fs.writeFileSync(path.join(root, '.minecraft-core.json'), JSON.stringify({
    contentRevision: 1,
    modpackManaged: true,
    modpackProvider: 'modrinth',
    modpackVersion: '1.0.0',
    version: runtime.minecraftVersion,
    loader: runtime.loaderFamily,
    loaderVersion: runtime.loaderVersion,
    javaVersion: runtime.javaMajor,
    [runtime.loaderFamily]: runtime.loaderVersion,
    runtime,
    port: 25565,
    maxRam: 4
  }, null, 2));
}

async function installNeoForgeLayout(root, vanillaBytes) {
  const installer = new AdmZip();
  installer.addFile('install_profile.json', Buffer.from(JSON.stringify({
    spec: 1,
    profile: 'NeoForge',
    version: `neoforge-${NEOFORGE_VERSION}`,
    minecraft: NEOFORGE_GAME,
    json: '/version.json',
    data: {},
    processors: [],
    libraries: [],
    serverJarPath: '{LIBRARY_DIR}/net/minecraft/server/{MINECRAFT_VERSION}/server-{MINECRAFT_VERSION}.jar'
  })));
  const installerBytes = installer.toBuffer();
  const metadata = '<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <groupId>net.neoforged</groupId>\n' +
    '  <artifactId>neoforge</artifactId>\n  <versioning>\n' +
    `    <latest>${NEOFORGE_VERSION}</latest>\n    <release>${NEOFORGE_VERSION}</release>\n` +
    `    <versions><version>${NEOFORGE_VERSION}</version></versions>\n` +
    '    <lastUpdated>20260801010101</lastUpdated>\n  </versioning>\n</metadata>';
  const result = await installServerLoader({
    targetPath: root,
    minecraftVersion: NEOFORGE_GAME,
    loader: 'neoforge',
    loaderVersion: NEOFORGE_VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 21,
    transport: fakeTransport(new Map([
      [NEOFORGE_METADATA_URL, metadata],
      [`${NEOFORGE_INSTALLER_URL}.sha512`, crypto.createHash('sha512').update(installerBytes).digest('hex')],
      [NEOFORGE_INSTALLER_URL, installerBytes]
    ])),
    validateJava: async () => 21,
    // The official installer's output: vanilla only under libraries, no root server.jar.
    processRunner: async request => {
      const loaderDirectory = path.join(request.cwd, 'libraries', 'net', 'neoforged', 'neoforge', NEOFORGE_VERSION);
      const vanilla = path.join(request.cwd, 'libraries', 'net', 'minecraft', 'server', NEOFORGE_GAME, `server-${NEOFORGE_GAME}.jar`);
      fs.mkdirSync(loaderDirectory, { recursive: true });
      fs.mkdirSync(path.dirname(vanilla), { recursive: true });
      fs.writeFileSync(vanilla, vanillaBytes);
      fs.writeFileSync(path.join(request.cwd, 'user_jvm_args.txt'), '# user arguments\n');
      fs.writeFileSync(path.join(loaderDirectory, `neoforge-${NEOFORGE_VERSION}-universal.jar`), jarBytes('neoforge'));
      fs.writeFileSync(
        path.join(loaderDirectory, 'win_args.txt'),
        `--module-path libraries/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-universal.jar\n`
      );
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  writeSummary(root, result.runtime);
  return result.runtime;
}

async function installQuiltLayout(root, vanillaBytes) {
  const libraries = {
    'org.quiltmc:quilt-loader:0.26.4': [QUILT_MAVEN, jarBytes('quilt-loader')],
    'org.quiltmc:hashed:1.20.1': [QUILT_MAVEN, jarBytes('hashed')],
    'net.fabricmc:intermediary:1.20.1': [FABRIC_MAVEN, jarBytes('intermediary')]
  };
  const routes = new Map([
    [QUILT_PAIR_URL, {
      loader: { maven: `org.quiltmc:quilt-loader:${QUILT_VERSION}`, version: QUILT_VERSION },
      hashed: { maven: `org.quiltmc:hashed:${QUILT_GAME}`, version: QUILT_GAME },
      intermediary: { maven: `net.fabricmc:intermediary:${QUILT_GAME}`, version: QUILT_GAME },
      launcherMeta: { version: 2 }
    }],
    [`${QUILT_PAIR_URL}/server/json`, {
      id: `quilt-loader-${QUILT_VERSION}-${QUILT_GAME}`,
      inheritsFrom: QUILT_GAME,
      type: 'release',
      mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotServer',
      launcherMainClass: 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher',
      arguments: { game: [] },
      libraries: Object.entries(libraries).map(([name, [url]]) => ({ name, url })),
      releaseTime: '2023-06-12T13:25:51+00:00',
      time: '2026-07-28T06:43:40+00:00'
    }]
  ]);
  for (const [coordinate, [repository, bytes]] of Object.entries(libraries)) {
    const [group, artifact, version] = coordinate.split(':');
    routes.set(`${repository}${group.replaceAll('.', '/')}/${artifact}/${version}/${artifact}-${version}.jar`, bytes);
  }
  const result = await installServerLoader({
    targetPath: root,
    minecraftVersion: QUILT_GAME,
    loader: 'quilt',
    loaderVersion: QUILT_VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 17,
    transport: fakeTransport(routes),
    validateJava: async () => 17,
    // Stands in for the pinned Mojang download; writes vanilla where the installer asks for it.
    ensureBaseRuntime: async ({ targetPath, destinationRelativePath = 'server.jar' }) => {
      const destination = path.join(targetPath, ...destinationRelativePath.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, vanillaBytes);
    }
  });
  writeSummary(root, result.runtime);
  return result.runtime;
}

function tempServer(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function javaAvailable() {
  const probe = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return !probe.error && probe.status === 0;
}

test('v26.6.1 runs the NeoForge downgrade guard, never vanilla, and its health panel stays clean', async t => {
  const root = tempServer(t, 'mc-core-downgrade-neoforge-');
  const vanillaBytes = jarBytes('vanilla-1.21.1');
  const runtime = await installNeoForgeLayout(root, vanillaBytes);
  assert.equal(validatePreparedRuntime(root, runtime).valid, true);

  assert.deepEqual(v26_6_1HealthMissing(root), []);
  const decision = v26_6_1LaunchDecision(root);
  assert.equal(decision.jar, path.join(root, 'server.jar'));
  const launched = fs.readFileSync(decision.jar);
  assert.notEqual(sha256(launched), sha256(vanillaBytes));
  assert.deepEqual(new AdmZip(launched).getEntries().map(entry => entry.entryName), ['META-INF/MANIFEST.MF']);
  assert.match(
    new AdmZip(launched).readAsText('META-INF/MANIFEST.MF').replace(/\r?\n /gu, ''),
    new RegExp(`^Main-Class: ${NEOFORGE_DOWNGRADE_GUARD_MAIN_CLASS.replaceAll('.', '\\.')}\\r?$`, 'mu')
  );
});

test('v26.6.1 runs the Quilt launcher copy, never vanilla, and its health panel stays clean', async t => {
  const root = tempServer(t, 'mc-core-downgrade-quilt-');
  const vanillaBytes = jarBytes('vanilla-1.20.1');
  const runtime = await installQuiltLayout(root, vanillaBytes);
  assert.equal(validatePreparedRuntime(root, runtime).valid, true);

  assert.deepEqual(v26_6_1HealthMissing(root), []);
  const decision = v26_6_1LaunchDecision(root);
  assert.equal(decision.jar, path.join(root, 'server.jar'));
  const launched = fs.readFileSync(decision.jar);
  assert.notEqual(sha256(launched), sha256(vanillaBytes));
  assert.deepEqual(launched, fs.readFileSync(path.join(root, 'quilt-server-launch.jar')));
  assert.equal(
    fs.readFileSync(path.join(root, 'quilt-server-launcher.properties'), 'utf8'),
    `serverJar=libraries/net/minecraft/server/${QUILT_GAME}/server-${QUILT_GAME}.jar\n`
  );
});

test('real Java refuses to start the NeoForge guard and creates no world', async t => {
  if (!javaAvailable()) {
    t.skip('java is not on PATH');
    return;
  }
  const root = tempServer(t, 'mc-core-downgrade-neoforge-java-');
  await installNeoForgeLayout(root, jarBytes('vanilla-1.21.1'));

  const result = spawnSync('java', ['-jar', 'server.jar', 'nogui'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true
  });

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(NEOFORGE_DOWNGRADE_GUARD_MAIN_CLASS.replaceAll('.', '\\.'), 'u'));
  assert.equal(fs.existsSync(path.join(root, 'world')), false);
  assert.equal(fs.existsSync(path.join(root, 'eula.txt')), false);
});
