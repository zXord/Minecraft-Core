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
  getLoaderVersions,
  installServerLoader,
  validatePreparedRuntime,
  __testUtils
} = require('../electron/services/loader-install-service.cjs');
const { resolveLaunchPlan } = require('../electron/services/server-launcher.cjs');
const { resolveServerLoader } = require('../electron/utils/server-loader.cjs');

const METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const VERSION = '21.1.172-beta';
const INSTALLER_URL = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${VERSION}/neoforge-${VERSION}-installer.jar`;
const VANILLA_SERVER_JAR = 'libraries/net/minecraft/server/1.21.1/server-1.21.1.jar';
const GUARD_MAIN_CLASS = 'MinecraftCore.UpdateRequired.This_NeoForge_server_needs_a_newer_Minecraft_Core';
// Pinned bytes of the generated guard jar: a targeted Repair must regenerate exactly these.
const GUARD_JAR_SHA256 = 'a091729f06bbb1ed882bb4913af93680da2dd5cf448063659bdbb6e9625acaae';

function response(body, statusCode = 200, headers = {}) {
  const stream = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  stream.statusCode = statusCode;
  stream.headers = { 'content-length': String(Buffer.byteLength(body)), ...headers };
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
      if (route instanceof Error) throw route;
      return response(route.body ?? route, route.statusCode ?? 200, route.headers);
    }
  };
}

function metadataXml(versions) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <groupId>net.neoforged</groupId>\n  <artifactId>neoforge</artifactId>\n  <versioning>\n    <latest>${versions.at(-1)}</latest>\n    <release>${versions.at(-1)}</release>\n    <versions>${versions.map(version => `<version>${version}</version>`).join('')}</versions>\n    <lastUpdated>20260801010101</lastUpdated>\n  </versioning>\n</metadata>`;
}

function installerJar({ minecraft = '1.21.1', version = VERSION } = {}) {
  const zip = new AdmZip();
  zip.addFile('install_profile.json', Buffer.from(JSON.stringify({
    spec: 1,
    profile: 'NeoForge',
    version: `neoforge-${version}`,
    minecraft,
    json: '/version.json',
    data: {},
    processors: [],
    libraries: [],
    serverJarPath: '{LIBRARY_DIR}/net/minecraft/server/{MINECRAFT_VERSION}/server-{MINECRAFT_VERSION}.jar'
  })));
  return zip.toBuffer();
}

function jarBytes(label = 'fixture') {
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(`Manifest-Version: 1.0\r\nX-Fixture: ${label}\r\n\r\n`));
  return zip.toBuffer();
}

function tuple() {
  return {
    minecraftVersion: '1.21.1',
    loaderFamily: 'neoforge',
    loaderVersion: VERSION,
    javaMajor: 21,
    os: 'win32',
    architecture: 'x64'
  };
}

const VANILLA_BYTES = jarBytes('vanilla-1.21.1');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// What the official installer leaves in its working folder: libraries (including the vanilla jar
// under libraries/net/minecraft/server), user_jvm_args.txt and run scripts, but no root server.jar.
function writeOfficialInstallerOutput(cwd, { userJvmArgs = '# app reviewed\n' } = {}) {
  const runtimeDir = path.join(cwd, 'libraries', 'net', 'neoforged', 'neoforge', VERSION);
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.dirname(path.join(cwd, ...VANILLA_SERVER_JAR.split('/'))), { recursive: true });
  fs.writeFileSync(path.join(cwd, ...VANILLA_SERVER_JAR.split('/')), VANILLA_BYTES);
  fs.writeFileSync(path.join(cwd, 'user_jvm_args.txt'), userJvmArgs);
  fs.writeFileSync(path.join(cwd, 'run.bat'), `java @user_jvm_args.txt @libraries/net/neoforged/neoforge/${VERSION}/win_args.txt %*\r\n`);
  fs.writeFileSync(path.join(runtimeDir, `neoforge-${VERSION}-universal.jar`), jarBytes('neoforge'));
  fs.writeFileSync(path.join(runtimeDir, 'win_args.txt'), `--module-path libraries/net/neoforged/neoforge/${VERSION}/neoforge-${VERSION}-universal.jar\n`);
}

function neoForgeInstallRoutes() {
  const installer = installerJar();
  return fakeTransport(new Map([
    [METADATA_URL, metadataXml([VERSION])],
    [`${INSTALLER_URL}.sha512`, crypto.createHash('sha512').update(installer).digest('hex')],
    [INSTALLER_URL, installer]
  ]));
}

async function installNeoForge(targetPath, javaRoot, { userJvmArgs } = {}) {
  return installServerLoader({
    targetPath,
    minecraftVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: VERSION,
    javaPath: path.join(javaRoot, 'java.exe'),
    javaMajor: 21,
    transport: neoForgeInstallRoutes(),
    validateJava: async () => 21,
    processRunner: async request => {
      writeOfficialInstallerOutput(request.cwd, { userJvmArgs });
      return { code: 0, stdout: '', stderr: '' };
    }
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

function unfoldedManifest(jarPath) {
  return new AdmZip(jarPath).readAsText('META-INF/MANIFEST.MF').replace(/\r?\n /gu, '');
}

function refreshArtifactRecord(root, relativePath) {
  const metadataPath = path.join(root, '.minecraft-core-state', 'runtime.json');
  const record = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const artifact = record.artifacts.find(candidate => candidate.relativePath === relativePath);
  assert.ok(artifact, `missing artifact record for ${relativePath}`);
  const bytes = fs.readFileSync(path.join(root, ...relativePath.split('/')));
  artifact.size = bytes.length;
  artifact.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  artifact.sha512 = crypto.createHash('sha512').update(bytes).digest('hex');
  fs.writeFileSync(metadataPath, `${JSON.stringify(record, null, 2)}\n`);
}

test('NeoForge version mapping is exact for legacy and calver Minecraft identities', () => {
  assert.equal(__testUtils.getNeoForgeMinecraftPrefix('1.20.2'), '20.2.');
  assert.equal(__testUtils.getNeoForgeMinecraftPrefix('1.21'), '21.0.');
  assert.equal(__testUtils.getNeoForgeMinecraftPrefix('26.1'), '26.1.0.');
  assert.equal(__testUtils.getNeoForgeMinecraftPrefix('26.1.2'), '26.1.2.');
  assert.equal(__testUtils.getNeoForgeMinecraftPrefix('latest'), null);
});

test('NeoForge metadata uses only the authoritative bounded endpoint and preserves beta identity', async () => {
  const transport = fakeTransport(new Map([[METADATA_URL, metadataXml([
    '20.2.91-beta', '21.0.167', VERSION, '21.1.173', '26.1.2.90'
  ])]]));
  const versions = await getLoaderVersions('neoforge', '1.21.1', { transport, maxMetadataBytes: 128 * 1024 });
  assert.deepEqual(versions, ['21.1.173', VERSION]);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, METADATA_URL);
  assert.match(transport.calls[0].options.headers['User-Agent'], /^Minecraft-Core\//);
  assert.deepEqual(transport.calls[0].options.allowedHosts, ['maven.neoforged.net']);
  assert.deepEqual(transport.calls[0].options.allowedOrigins, ['https://maven.neoforged.net']);
});

test('NeoForge metadata rejects entities, duplicate versions, malformed XML, and oversized bytes', async () => {
  for (const body of [
    '<!DOCTYPE metadata [<!ENTITY x SYSTEM "file:///secret">]><metadata>&x;</metadata>',
    metadataXml(['21.1.1', '21.1.1']),
    '<metadata><groupId>net.neoforged</groupId></metadata>'
  ]) {
    const transport = fakeTransport(new Map([[METADATA_URL, body]]));
    await assert.rejects(getLoaderVersions('neoforge', '1.21.1', { transport }), error => error.code === 'LOADER_VERSION_UNAVAILABLE');
  }
  const transport = fakeTransport(new Map([[METADATA_URL, metadataXml(['21.1.1']).padEnd(2048, ' ')]]));
  await assert.rejects(
    getLoaderVersions('neoforge', '1.21.1', { transport, maxMetadataBytes: 256 }),
    error => error.code === 'LOADER_VERSION_UNAVAILABLE'
  );
});

test('NeoForge stages the exact digest-verified official installer and never runs pack scripts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-'));
  const targetPath = path.join(root, 'candidate');
  fs.mkdirSync(targetPath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(targetPath, 'run.bat'), 'pack supplied');
  fs.writeFileSync(path.join(targetPath, 'evil-installer.jar'), 'pack supplied');

  const installer = installerJar();
  const sha512 = crypto.createHash('sha512').update(installer).digest('hex');
  const transport = fakeTransport(new Map([
    [METADATA_URL, metadataXml([VERSION])],
    [`${INSTALLER_URL}.sha512`, `${sha512}  neoforge-${VERSION}-installer.jar\n`],
    [INSTALLER_URL, installer]
  ]));
  const processCalls = [];
  const result = await installServerLoader({
    targetPath,
    minecraftVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'managed-java', 'bin', 'java.exe'),
    javaMajor: 21,
    transport,
    validateJava: async ({ expectedMajor }) => expectedMajor,
    processRunner: async request => {
      processCalls.push(request);
      writeOfficialInstallerOutput(request.cwd);
      return { code: 0, stdout: 'installed', stderr: '' };
    }
  });

  assert.equal(result.loader, 'neoforge');
  assert.deepEqual(result.runtime, tuple());
  assert.equal(processCalls.length, 1);
  assert.equal(processCalls[0].command, path.join(root, 'managed-java', 'bin', 'java.exe'));
  assert.deepEqual(processCalls[0].args.slice(0, 1), ['-jar']);
  assert.match(processCalls[0].args[1], /\.minecraft-core-state[\\/]runtime-staging[\\/][^\\/]+[\\/]neoforge-/);
  assert.notEqual(processCalls[0].args[1], path.join(targetPath, 'evil-installer.jar'));
  assert.equal(processCalls[0].args[2], '--installServer');
  assert.match(processCalls[0].cwd, /\.minecraft-core-state[\\/]runtime-staging[\\/][^\\/]+[\\/]server$/);
  assert.notEqual(processCalls[0].cwd, targetPath);
  assert.equal(processCalls[0].shell, false);
  assert.equal(processCalls[0].windowsHide, true);
  assert.equal(path.isAbsolute(processCalls[0].command), true);
  assert.equal(transport.calls.some(call => call.url.includes('/latest')), false);
  assert.equal(fs.readFileSync(path.join(targetPath, 'run.bat'), 'utf8'), 'pack supplied');
  assert.equal(fs.existsSync(path.join(targetPath, '.minecraft-core-state', 'runtime.json')), true);
  assert.equal(validatePreparedRuntime(targetPath, tuple()).valid, true);
  assert.deepEqual(resolveServerLoader(targetPath), {
    loader: 'neoforge',
    loaderVersion: VERSION,
    source: 'runtime-metadata'
  });
});

test('NeoForge installer failure leaves candidate runtime output unpublished', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = installerJar();
  const digest = crypto.createHash('sha512').update(installer).digest('hex');
  const transport = fakeTransport(new Map([
    [METADATA_URL, metadataXml([VERSION])],
    [`${INSTALLER_URL}.sha512`, digest],
    [INSTALLER_URL, installer]
  ]));
  await assert.rejects(installServerLoader({
    targetPath: root,
    minecraftVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 21,
    transport,
    validateJava: async () => 21,
    processRunner: async request => {
      fs.writeFileSync(path.join(request.cwd, 'server.jar'), jarBytes('partial'));
      throw Object.assign(new Error('installer failed'), { code: 'RUNTIME_INCOMPLETE' });
    }
  }), error => error.code === 'RUNTIME_INCOMPLETE');
  assert.equal(fs.existsSync(path.join(root, 'server.jar')), false);
  assert.equal(fs.existsSync(path.join(root, 'libraries')), false);
  assert.equal(fs.existsSync(path.join(root, '.minecraft-core-state', 'runtime.json')), false);
});

test('NeoForge staging write failures are cleaned and normalized without local path disclosure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-stage-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = installerJar();
  const digest = crypto.createHash('sha512').update(installer).digest('hex');
  const originalOpenSync = fs.openSync;
  fs.openSync = function injectedOpenFailure(filePath, ...args) {
    if (typeof filePath === 'string' && filePath.endsWith('-installer.jar')) {
      throw Object.assign(new Error(`EACCES while opening ${filePath}`), {
        code: 'EACCES',
        path: filePath
      });
    }
    return originalOpenSync.call(this, filePath, ...args);
  };
  let failure;
  try {
    await installServerLoader({
      targetPath: root,
      minecraftVersion: '1.21.1',
      loader: 'neoforge',
      loaderVersion: VERSION,
      javaPath: path.join(root, 'java.exe'),
      javaMajor: 21,
      transport: fakeTransport(new Map([
        [METADATA_URL, metadataXml([VERSION])],
        [`${INSTALLER_URL}.sha512`, digest],
        [INSTALLER_URL, installer]
      ])),
      validateJava: async () => 21,
      processRunner: async () => ({ code: 0, stdout: '', stderr: '' })
    });
  } catch (error) {
    failure = error;
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(failure?.code, 'RUNTIME_INCOMPLETE');
  assert.equal(String(failure?.message).includes(root), false);
  assert.equal(JSON.stringify(failure).includes(root), false);
  const stagingRoot = path.join(root, '.minecraft-core-state', 'runtime-staging');
  assert.equal(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).length : 0, 0);
});

test('NeoForge preserves staging when process quiescence could not be proven', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-nonquiescent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = installerJar();
  const digest = crypto.createHash('sha512').update(installer).digest('hex');
  await assert.rejects(installServerLoader({
    targetPath: root,
    minecraftVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 21,
    transport: fakeTransport(new Map([
      [METADATA_URL, metadataXml([VERSION])],
      [`${INSTALLER_URL}.sha512`, digest],
      [INSTALLER_URL, installer]
    ])),
    validateJava: async () => 21,
    processRunner: async () => {
      const error = Object.assign(new Error('child did not close'), {
        code: 'RUNTIME_INCOMPLETE',
        preserveWorkspace: true
      });
      throw error;
    }
  }), error => error.code === 'RUNTIME_INCOMPLETE' && error.preserveWorkspace === true);
  const stagingRoot = path.join(root, '.minecraft-core-state', 'runtime-staging');
  assert.equal(fs.readdirSync(stagingRoot).length, 1);
  assert.equal(fs.existsSync(path.join(root, 'server.jar')), false);
});

test('NeoForge refuses a target reached through a reparse ancestor before execution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-reparse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actualParent = path.join(root, 'actual');
  const linkedParent = path.join(root, 'linked');
  const actualTarget = path.join(actualParent, 'candidate');
  fs.mkdirSync(actualTarget, { recursive: true });
  try {
    fs.symlinkSync(actualParent, linkedParent, 'junction');
  } catch {
    t.skip('directory junction creation is unavailable');
    return;
  }
  const installer = installerJar();
  const digest = crypto.createHash('sha512').update(installer).digest('hex');
  let executions = 0;
  await assert.rejects(installServerLoader({
    targetPath: path.join(linkedParent, 'candidate'),
    minecraftVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 21,
    transport: fakeTransport(new Map([
      [METADATA_URL, metadataXml([VERSION])],
      [`${INSTALLER_URL}.sha512`, digest],
      [INSTALLER_URL, installer]
    ])),
    validateJava: async () => 21,
    processRunner: async request => {
      executions += 1;
      writeOfficialInstallerOutput(request.cwd);
      return { code: 0, stdout: '', stderr: '' };
    }
  }), error => error.code === 'RUNTIME_INCOMPLETE');
  assert.equal(executions, 0);
});

test('NeoForge rejects an unavailable exact version, digest mismatch, and installer profile mismatch before execution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let executions = 0;
  const base = {
    targetPath: root,
    minecraftVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 21,
    validateJava: async () => 21,
    processRunner: async () => { executions += 1; return { code: 0, stdout: '', stderr: '' }; }
  };

  await assert.rejects(installServerLoader({
    ...base,
    transport: fakeTransport(new Map([[METADATA_URL, metadataXml(['21.1.173'])]]))
  }), error => error.code === 'LOADER_VERSION_UNAVAILABLE');

  const goodInstaller = installerJar();
  await assert.rejects(installServerLoader({
    ...base,
    transport: fakeTransport(new Map([
      [METADATA_URL, metadataXml([VERSION])],
      [`${INSTALLER_URL}.sha512`, '0'.repeat(128)],
      [INSTALLER_URL, goodInstaller]
    ]))
  }), error => error.code === 'RUNTIME_INCOMPLETE');

  const wrongProfile = installerJar({ minecraft: '1.21.2' });
  const wrongDigest = crypto.createHash('sha512').update(wrongProfile).digest('hex');
  await assert.rejects(installServerLoader({
    ...base,
    transport: fakeTransport(new Map([
      [METADATA_URL, metadataXml([VERSION])],
      [`${INSTALLER_URL}.sha512`, wrongDigest],
      [INSTALLER_URL, wrongProfile]
    ]))
  }), error => error.code === 'RUNTIME_INCOMPLETE');
  assert.equal(executions, 0);
});

test('NeoForge can never fall through to Vanilla when its exact runtime is incomplete', () => {
  const serverPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-incomplete-'));
  try {
    fs.writeFileSync(path.join(serverPath, 'server.jar'), jarBytes('vanilla-lookalike'));
    fs.writeFileSync(path.join(serverPath, 'neoforge-name-only.jar'), jarBytes('name-only'));
    assert.throws(
      () => resolveLaunchPlan(serverPath, { loader: 'neoforge', maxRam: 4 }, { runtimeTuple: tuple() }),
      error => error.code === 'RUNTIME_INCOMPLETE'
    );
  } finally {
    fs.rmSync(serverPath, { recursive: true, force: true });
  }
});

test('NeoForge launch passes user_jvm_args.txt like the official run script, then app memory flags and the exact Windows arg file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await installNeoForge(root, root, { userJvmArgs: '-XX:+UseG1GC\n' });

  const plan = resolveLaunchPlan(root, { loader: 'neoforge', maxRam: 6 }, { runtimeTuple: tuple() });
  assert.equal(plan.type, 'neoforge');
  assert.equal(plan.loader, 'neoforge');
  assert.equal(plan.cwd, root);
  assert.equal(plan.jar, null);
  assert.deepEqual(plan.args, [
    '@user_jvm_args.txt',
    '-Xmx6G',
    '-Xms1G',
    `@libraries${path.sep}net${path.sep}neoforged${path.sep}neoforge${path.sep}${VERSION}${path.sep}win_args.txt`,
    'nogui'
  ]);
  assert.equal(plan.args.some(arg => arg.includes('run.bat')), false);
});

test('NeoForge validation rejects escaping argument-file references and mutated artifacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await installNeoForge(root, root);
  const argsRelative = `libraries/net/neoforged/neoforge/${VERSION}/win_args.txt`;
  const universalRelative = `libraries/net/neoforged/neoforge/${VERSION}/neoforge-${VERSION}-universal.jar`;
  const argsPath = path.join(root, ...argsRelative.split('/'));
  fs.writeFileSync(argsPath, '@../../../../../../outside.txt\n');
  refreshArtifactRecord(root, argsRelative);
  assert.throws(() => validatePreparedRuntime(root, tuple()), error => error.code === 'RUNTIME_INCOMPLETE');

  fs.writeFileSync(argsPath, `--module-path ${universalRelative}\n`);
  refreshArtifactRecord(root, argsRelative);
  fs.appendFileSync(path.join(root, ...universalRelative.split('/')), 'mutated');
  assert.throws(() => validatePreparedRuntime(root, tuple()), error => error.code === 'RUNTIME_INCOMPLETE');
});

test('NeoForge publishes a manifest-only downgrade guard as the root server.jar and records the vanilla libraries jar', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await installNeoForge(root, root);

  const rootJar = path.join(root, 'server.jar');
  assert.deepEqual(new AdmZip(rootJar).getEntries().map(entry => entry.entryName), ['META-INF/MANIFEST.MF']);
  assert.match(unfoldedManifest(rootJar), new RegExp(`^Main-Class: ${GUARD_MAIN_CLASS.replaceAll('.', '\\.')}\\r?$`, 'mu'));
  assert.equal(__testUtils.NEOFORGE_DOWNGRADE_GUARD_MAIN_CLASS, GUARD_MAIN_CLASS);
  assert.equal(sha256(fs.readFileSync(rootJar)), GUARD_JAR_SHA256);
  assert.notDeepEqual(fs.readFileSync(rootJar), VANILLA_BYTES);
  assert.deepEqual(fs.readFileSync(path.join(root, ...VANILLA_SERVER_JAR.split('/'))), VANILLA_BYTES);
  assert.ok(recordedArtifact(root, 'server.jar'));
  assert.ok(recordedArtifact(root, VANILLA_SERVER_JAR));
  assert.equal(validatePreparedRuntime(root, tuple()).valid, true);
  assert.deepEqual(resolveLaunchPlan(root, { loader: 'neoforge', maxRam: 4 }, { runtimeTuple: tuple() }).args, [
    '@user_jvm_args.txt',
    '-Xmx4G',
    '-Xms1G',
    `@libraries${path.sep}net${path.sep}neoforged${path.sep}neoforge${path.sep}${VERSION}${path.sep}win_args.txt`,
    'nogui'
  ]);

  fs.rmSync(path.join(root, ...VANILLA_SERVER_JAR.split('/')));
  assert.throws(() => validatePreparedRuntime(root, tuple()), error => error.code === 'RUNTIME_INCOMPLETE');
});

test('the NeoForge downgrade guard jar has identical bytes in every time zone', () => {
  const modulePath = require.resolve('../electron/services/loader-install-service.cjs');
  const script = [
    "const crypto = require('node:crypto');",
    `const { __testUtils } = require(${JSON.stringify(modulePath)});`,
    'process.stdout.write(JSON.stringify({',
    '  offset: new Date(1980, 0, 1).getTimezoneOffset(),',
    "  sha256: crypto.createHash('sha256').update(__testUtils.neoForgeDowngradeGuardJarBytes()).digest('hex')",
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
  assert.deepEqual(runs.map(run => run.sha256), [GUARD_JAR_SHA256, GUARD_JAR_SHA256]);
  assert.equal(sha256(__testUtils.neoForgeDowngradeGuardJarBytes()), GUARD_JAR_SHA256);
});

test('targeted Repair regenerates the NeoForge guard jar with the recorded hash', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, 'live');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(live);
  fs.mkdirSync(staging);
  await installNeoForge(live, root);
  fs.writeFileSync(path.join(live, 'server.jar'), jarBytes('damaged'));
  assert.throws(() => validatePreparedRuntime(live, tuple()), error => error.code === 'RUNTIME_INCOMPLETE');

  await installNeoForge(staging, root);
  repairRuntimeFile(live, staging, 'server.jar');

  assert.equal(validatePreparedRuntime(live, tuple()).valid, true);
  assert.equal(sha256(fs.readFileSync(path.join(live, 'server.jar'))), GUARD_JAR_SHA256);
});

test('a pre-release NeoForge layout keeps validating, a targeted Repair of its vanilla root jar fails closed, and an update rewrites it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-prerelease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, 'live');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(live);
  fs.mkdirSync(staging);
  await installNeoForge(live, root);
  // What pre-release builds published: the vanilla libraries jar copied to the root and recorded.
  fs.copyFileSync(path.join(live, ...VANILLA_SERVER_JAR.split('/')), path.join(live, 'server.jar'));
  refreshArtifactRecord(live, 'server.jar');
  assert.equal(validatePreparedRuntime(live, tuple()).valid, true);

  await installNeoForge(staging, root);
  assert.throws(
    () => repairRuntimeFile(live, staging, 'server.jar'),
    error => error.code === 'RUNTIME_INCOMPLETE'
  );
  assert.deepEqual(fs.readFileSync(path.join(live, 'server.jar')), VANILLA_BYTES);

  await installNeoForge(live, root);
  assert.equal(sha256(fs.readFileSync(path.join(live, 'server.jar'))), GUARD_JAR_SHA256);
  assert.equal(validatePreparedRuntime(live, tuple()).valid, true);
});
