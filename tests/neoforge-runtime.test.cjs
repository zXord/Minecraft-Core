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

const METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const VERSION = '21.1.172-beta';
const INSTALLER_URL = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${VERSION}/neoforge-${VERSION}-installer.jar`;

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
      const runtimeDir = path.join(request.cwd, 'libraries', 'net', 'neoforged', 'neoforge', VERSION);
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(request.cwd, 'user_jvm_args.txt'), '# app reviewed\n');
      fs.writeFileSync(path.join(request.cwd, 'server.jar'), jarBytes('server'));
      fs.writeFileSync(path.join(runtimeDir, `neoforge-${VERSION}-universal.jar`), jarBytes('neoforge'));
      fs.writeFileSync(path.join(runtimeDir, 'win_args.txt'), `--module-path libraries/net/neoforged/neoforge/${VERSION}/neoforge-${VERSION}-universal.jar\n`);
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
      const runtimeDir = path.join(request.cwd, 'libraries', 'net', 'neoforged', 'neoforge', VERSION);
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(request.cwd, 'server.jar'), jarBytes('server'));
      fs.writeFileSync(path.join(request.cwd, 'user_jvm_args.txt'), '# args\n');
      fs.writeFileSync(path.join(runtimeDir, `neoforge-${VERSION}-universal.jar`), jarBytes('neo'));
      fs.writeFileSync(path.join(runtimeDir, 'win_args.txt'), `--module-path libraries/net/neoforged/neoforge/${VERSION}/neoforge-${VERSION}-universal.jar\n`);
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

test('NeoForge launch uses only the exact Windows arg file and app-controlled JVM arguments', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = installerJar();
  const digest = crypto.createHash('sha512').update(installer).digest('hex');
  const transport = fakeTransport(new Map([
    [METADATA_URL, metadataXml([VERSION])],
    [`${INSTALLER_URL}.sha512`, digest],
    [INSTALLER_URL, installer]
  ]));
  await installServerLoader({
    targetPath: root,
    minecraftVersion: '1.21.1',
    loader: 'neoforge',
    loaderVersion: VERSION,
    javaPath: path.join(root, 'java.exe'),
    javaMajor: 21,
    transport,
    validateJava: async () => 21,
    processRunner: async request => {
      const runtimeDir = path.join(request.cwd, 'libraries', 'net', 'neoforged', 'neoforge', VERSION);
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(request.cwd, 'server.jar'), jarBytes('server'));
      fs.writeFileSync(path.join(request.cwd, 'user_jvm_args.txt'), '-javaagent:pack-supplied.jar\n');
      fs.writeFileSync(path.join(runtimeDir, `neoforge-${VERSION}-universal.jar`), jarBytes('neo'));
      fs.writeFileSync(path.join(runtimeDir, 'win_args.txt'), `--module-path libraries/net/neoforged/neoforge/${VERSION}/neoforge-${VERSION}-universal.jar\n`);
      return { code: 0, stdout: '', stderr: '' };
    }
  });

  const plan = resolveLaunchPlan(root, { loader: 'neoforge', maxRam: 6 }, { runtimeTuple: tuple() });
  assert.equal(plan.type, 'neoforge');
  assert.equal(plan.loader, 'neoforge');
  assert.equal(plan.cwd, root);
  assert.equal(plan.jar, null);
  assert.deepEqual(plan.args, [
    '-Xmx6G',
    '-Xms1G',
    `@libraries${path.sep}net${path.sep}neoforged${path.sep}neoforge${path.sep}${VERSION}${path.sep}win_args.txt`,
    'nogui'
  ]);
  assert.equal(plan.args.some(arg => arg.includes('run.bat') || arg.includes('user_jvm_args')), false);
});

test('NeoForge validation rejects escaping argument-file references and mutated artifacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-neoforge-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'libraries', 'net', 'neoforged', 'neoforge', VERSION);
  fs.mkdirSync(path.join(root, '.minecraft-core-state'), { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'server.jar'), jarBytes('server'));
  fs.writeFileSync(path.join(root, 'user_jvm_args.txt'), '# args\n');
  fs.writeFileSync(path.join(runtimeDir, `neoforge-${VERSION}-universal.jar`), jarBytes('neo'));
  fs.writeFileSync(path.join(runtimeDir, 'win_args.txt'), '@../../../../../../outside.txt\n');
  fs.writeFileSync(path.join(root, '.minecraft-core-state', 'runtime.json'), JSON.stringify({
    formatVersion: 1,
    runtime: tuple(),
    artifacts: []
  }));
  assert.throws(() => validatePreparedRuntime(root, tuple()), error => error.code === 'RUNTIME_INCOMPLETE');
});
