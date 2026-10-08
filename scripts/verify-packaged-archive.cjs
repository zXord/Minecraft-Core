const asar = require('@electron/asar');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ArchiveWorkerClient,
  verifyArchiveWorkerExecutable
} = require('../electron/services/modpacks/archive/archive-worker-client.cjs');
const { ModpackError, deepFreeze } = require('../electron/services/modpacks/errors.cjs');
const { verifyArchiveRuntime } = require('./verify-archive-runtime.cjs');

const MANIFEST_IDENTITIES = deepFreeze({
  '7zip-26.02.json': {
    size: 2395,
    sha256: '28051d7f423b6a7a32d3bd135aa95f688239a05c957ee87bd8102f40493a5bd3'
  },
  '7zip-download-policy.json': {
    size: 310,
    sha256: '4051244573651ad3194ad069cb2dd97cc58a1f777b6e78967d99dce7d94ce5b9'
  },
  'archive-worker-x64.json': {
    size: 365,
    sha256: 'b4c72d9e40448d581b31266b4c9ebcef5f075a342d7f3faa3e3348af28638882'
  }
});

const CONTAINMENT_FIELDS = deepFreeze([
  'appContainer',
  'zeroCapabilities',
  'exactInputRead',
  'exactOutputWrite',
  'ambientTempReadDenied',
  'ambientTempWriteDenied',
  'userDataReadDenied',
  'userDataWriteDenied',
  'loopbackDenied',
  'descendantsDenied',
  'unrelatedEnvironmentAbsent',
  'unrelatedHandlesAbsent',
  'bundleRuntimeInMemory',
  'standardInputClosed',
  'cleanupKilledSurvivors',
  'temporaryAclRemoved',
  'profileStoreClean',
  'publishedOutputAclClean'
]);

const REQUIRED_APPLICATION_ENTRIES = deepFreeze([
  '/package.json',
  '/electron/main.cjs',
  '/electron/services/modpacks/archive/archive-runtime-verifier.cjs',
  '/electron/services/modpacks/archive/archive-worker-client.cjs'
]);
const MAX_APPLICATION_ENTRIES = 200_000;

function unavailable(cause) {
  return new ModpackError('EXTRACTOR_UNAVAILABLE', 'Packaged archive processing is unavailable', { cause });
}

function normalizeArchitecture(value) {
  if (value === 'x64' || value === 1) return 'x64';
  throw unavailable();
}

async function assertDirectory(directory, expectedNames) {
  const absolute = path.resolve(directory);
  const info = await fs.lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw unavailable();
  const actual = (await fs.readdir(absolute)).sort();
  const expected = [...expectedNames].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw unavailable();
  return absolute;
}

async function assertManifestIdentities(manifestsRoot) {
  await assertDirectory(manifestsRoot, Object.keys(MANIFEST_IDENTITIES));
  for (const [name, expected] of Object.entries(MANIFEST_IDENTITIES)) {
    const filePath = path.join(manifestsRoot, name);
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size || await fs.realpath(filePath) !== filePath) {
      throw unavailable();
    }
    const bytes = await fs.readFile(filePath);
    if (bytes.length !== expected.size || crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw unavailable();
    }
  }
}

async function assertApplicationArchive(resourcesPath) {
  const archivePath = path.join(path.resolve(resourcesPath), 'app.asar');
  const info = await fs.lstat(archivePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || await fs.realpath(archivePath) !== archivePath) {
    throw unavailable();
  }
  let entries;
  try {
    entries = asar.listPackage(archivePath).map(entry => entry.replaceAll('\\', '/'));
  } catch (error) {
    throw unavailable(error);
  }
  if (entries.length < REQUIRED_APPLICATION_ENTRIES.length || entries.length > MAX_APPLICATION_ENTRIES ||
      REQUIRED_APPLICATION_ENTRIES.some(required => !entries.includes(required)) ||
      entries.some(entry => /^\/dist\/win-unpacked(?:\/|$)/iu.test(entry) ||
        /^\/dist\/(?:Minecraft-Core-Setup-.*\.exe(?:\.blockmap)?|latest\.yml|builder-.*\.yml)$/iu.test(entry))) {
    throw unavailable();
  }
}

function assertContainmentEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const keys = Object.keys(value).sort();
  const expected = [...CONTAINMENT_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      CONTAINMENT_FIELDS.some(key => value[key] !== true)) throw unavailable();
}

async function runContainmentSelfTest({ resourcesRoot, runtimeLayout, workerPath, workerManifestPath }) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-packaged-archive-verify-'));
  let failure = null;
  try {
    const sentinel = path.join(temporaryRoot, 'user-data-sentinel.txt');
    await fs.writeFile(sentinel, 'packaged archive verifier sentinel');
    const client = new ArchiveWorkerClient({
      workerPath,
      workerManifestPath,
      resourcesRoot,
      runtimeLayout,
      appOwnedRoot: path.join(temporaryRoot, 'app-owned')
    });
    const evidence = await client.selfTest({ resourcesRoot, userDataSentinel: sentinel });
    assertContainmentEvidence(evidence);
    if (await fs.readFile(sentinel, 'utf8') !== 'packaged archive verifier sentinel') throw unavailable();
  } catch (error) {
    failure = error;
  }
  try {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    if (!failure) failure = error;
  }
  if (failure) throw failure;
}

function verificationEvidence(runtime, worker) {
  return deepFreeze({
    type: 'packaged-archive-verification',
    version: 1,
    architecture: 'x64',
    runtime: { version: runtime.version, handlers: { zip: runtime.handlers.zip, rar: runtime.handlers.rar } },
    worker: {
      runtimeIdentifier: worker.runtimeIdentifier,
      runtimeMode: worker.runtimeMode,
      size: worker.file.size,
      sha256: worker.file.sha256
    },
    containment: 'passed',
    fallbacksUsed: []
  });
}

async function verifyClosedArchive({ resourcesRoot, runtimeLayout, workerPath, workerManifestPath }) {
  const runtime = await verifyArchiveRuntime(resourcesRoot, { layout: runtimeLayout });
  if (runtime.version !== '26.02' || runtime.architecture !== 'x64' ||
      runtime.handlers.zip !== true || runtime.handlers.rar !== true) throw unavailable();
  const worker = await verifyArchiveWorkerExecutable({ workerPath, workerManifestPath });
  if (worker.architecture !== 'x64' || worker.runtimeIdentifier !== 'win-x64' ||
      worker.targetFramework !== 'net8.0-windows' || worker.runtimeMode !== 'in-memory-single-file') throw unavailable();
  await runContainmentSelfTest({ resourcesRoot, runtimeLayout, workerPath, workerManifestPath });
  return verificationEvidence(runtime, worker);
}

async function verifyPackagedArchive({ appOutDir, resourcesPath, architecture = process.arch, platform = process.platform } = {}) {
  try {
    if (platform !== 'win32') throw unavailable();
    normalizeArchitecture(architecture);
    if (resourcesPath === undefined) {
      if (typeof appOutDir !== 'string' || !path.isAbsolute(appOutDir)) throw unavailable();
      resourcesPath = path.join(path.resolve(appOutDir), 'resources');
    }
    if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) throw unavailable();
    await assertApplicationArchive(resourcesPath);
    const archiveRoot = path.join(path.resolve(resourcesPath), 'archive');
    await assertDirectory(archiveRoot, ['7zip', 'licenses', 'manifests', 'worker']);
    await assertDirectory(path.join(archiveRoot, 'worker'), ['ArchiveWorker.exe']);
    await assertManifestIdentities(path.join(archiveRoot, 'manifests'));
    return await verifyClosedArchive({
      resourcesRoot: archiveRoot,
      runtimeLayout: 'packaged',
      workerPath: path.join(archiveRoot, 'worker', 'ArchiveWorker.exe'),
      workerManifestPath: path.join(archiveRoot, 'manifests', 'archive-worker-x64.json')
    });
  } catch (error) {
    if (error instanceof ModpackError && error.code === 'EXTRACTOR_UNAVAILABLE') throw error;
    throw unavailable(error);
  }
}

async function verifySourceArchiveForPack(context) {
  try {
    if (!context || context.electronPlatformName !== 'win32') throw unavailable();
    normalizeArchitecture(context.arch);
    const repositoryRoot = path.resolve(__dirname, '..');
    await assertManifestIdentities(path.join(repositoryRoot, 'build-resources', 'archive-runtime'));
    return await verifyClosedArchive({
      resourcesRoot: repositoryRoot,
      runtimeLayout: 'repository',
      workerPath: path.join(repositoryRoot, 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe'),
      workerManifestPath: path.join(repositoryRoot, 'build-resources', 'archive-runtime', 'archive-worker-x64.json')
    });
  } catch (error) {
    if (error instanceof ModpackError && error.code === 'EXTRACTOR_UNAVAILABLE') throw error;
    throw unavailable(error);
  }
}

module.exports = {
  MANIFEST_IDENTITIES,
  verifyPackagedArchive,
  verifySourceArchiveForPack,
  default: verifySourceArchiveForPack
};

if (require.main === module) {
  verifyPackagedArchive({ appOutDir: path.resolve(__dirname, '..', 'dist', 'win-unpacked') }).then(evidence => {
    process.stdout.write(`Verified packaged archive ${evidence.runtime.version} ${evidence.architecture}; containment ${evidence.containment}\n`);
  }).catch(error => {
    process.stderr.write(`${error?.safeMessage || 'Packaged archive processing is unavailable'}\n`);
    process.exitCode = 1;
  });
}
