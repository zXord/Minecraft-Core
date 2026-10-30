const asar = require('@electron/asar');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ArchiveWorkerClient,
  verifyArchiveWorkerExecutable,
  verifyArchiveWorkerExecutableSync
} = require('../electron/services/modpacks/archive/archive-worker-client.cjs');
const { ModpackError, deepFreeze } = require('../electron/services/modpacks/errors.cjs');
const { verifyArchiveRuntime } = require('./verify-archive-runtime.cjs');

// These pins are the bytes git checks out: .gitattributes keeps build-resources/archive-runtime/*.json
// at eol=lf, so a developer's CRLF working copy must never become a pin. scripts/archive-worker-manifest.ps1
// writes exactly these worker-manifest bytes under every PowerShell edition.
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
    size: 351,
    sha256: '7862c1d04eedbddb07f09d84f1fc4d217e818afd06ae4798b0d5048ceedea79e'
  }
});

// CI ships the committed ArchiveWorker.exe instead of rebuilding it, so its sources are tied to it by a
// digest that scripts/build-archive-worker.ps1 records next to the exe identity on every rebuild.
const ARCHIVE_WORKER_SOURCE = 'native/ArchiveWorker';
const ARCHIVE_WORKER_SOURCE_DIGEST = 'native/archive-worker-source-digest.json';
const SOURCE_BUILD_OUTPUT_DIRECTORIES = Object.freeze(['bin', 'obj']);
const SOURCE_ENTRY_NAME = /^[A-Za-z0-9._-]+$/u;
const SOURCE_RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_DIGEST_BYTES = 1024 * 1024;
const SOURCE_IDENTITY_HINT = [
  'Usual causes:',
  '- a CRLF working copy of build-resources/archive-runtime/archive-worker-x64.json: delete it, then run',
  '  git checkout -- build-resources/archive-runtime/archive-worker-x64.json (never rerun the build script for this);',
  '- a stray file in build-resources/archive-runtime or vendor/archive-worker/x64;',
  '- native/ArchiveWorker changed without a rebuild: run scripts/build-archive-worker.ps1, re-pin MANIFEST_IDENTITIES',
  '  and the worker pins, then re-test natively (docs/testing/modpack-release-checklist.md, "Release pipeline runbook").'
].join('\n');

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

// Build-time diagnostics only: the public error stays EXTRACTOR_UNAVAILABLE with its safe message.
function identityMismatch(message) {
  const error = new Error(message);
  error.code = 'ARCHIVE_IDENTITY_MISMATCH';
  return unavailable(error);
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
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
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw identityMismatch(`${path.basename(absolute)} must hold exactly ${expected.join(', ')}; found ${actual.join(', ') || 'nothing'}.`);
  }
  return absolute;
}

async function assertManifestIdentities(manifestsRoot) {
  await assertDirectory(manifestsRoot, Object.keys(MANIFEST_IDENTITIES));
  for (const [name, expected] of Object.entries(MANIFEST_IDENTITIES)) {
    const filePath = path.join(manifestsRoot, name);
    const info = await fs.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(filePath) !== filePath) throw unavailable();
    if (info.size !== expected.size) {
      throw identityMismatch(`${name} is ${info.size} bytes; its pin is ${expected.size} bytes (the LF bytes git checks out).`);
    }
    const bytes = await fs.readFile(filePath);
    if (bytes.length !== expected.size || sha256Hex(bytes) !== expected.sha256) {
      throw identityMismatch(`${name} does not match its pinned sha256 ${expected.sha256}.`);
    }
  }
}

function lfNormalizedSha256(bytes) {
  return sha256Hex(Buffer.from(bytes.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'));
}

// Every regular file under native/ArchiveWorker except bin and obj build output, hashed with CRLF folded to
// LF so a CRLF checkout gives the same digest as the LF blobs git stores. Must stay identical to
// Get-ArchiveWorkerSourceDigest in scripts/archive-worker-manifest.ps1.
function computeArchiveWorkerSourceDigest(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const rootInfo = fsSync.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw identityMismatch(`${ARCHIVE_WORKER_SOURCE} is not an exact directory.`);
  const hashes = new Map();
  const pending = [[root, '']];
  while (pending.length > 0) {
    const [directory, prefix] = pending.pop();
    for (const name of fsSync.readdirSync(directory)) {
      const relative = `${prefix}${name}`;
      if (!SOURCE_ENTRY_NAME.test(name)) throw identityMismatch(`ArchiveWorker source name is not supported: ${relative}`);
      const entryPath = path.join(directory, name);
      const info = fsSync.lstatSync(entryPath);
      if (info.isSymbolicLink()) throw identityMismatch(`ArchiveWorker source is a link: ${relative}`);
      if (info.isDirectory()) {
        if (!SOURCE_BUILD_OUTPUT_DIRECTORIES.includes(name)) pending.push([entryPath, `${relative}/`]);
        continue;
      }
      if (!info.isFile()) throw identityMismatch(`ArchiveWorker source is not a regular file: ${relative}`);
      hashes.set(relative, lfNormalizedSha256(fsSync.readFileSync(entryPath)));
    }
  }
  if (hashes.size === 0) throw identityMismatch(`${ARCHIVE_WORKER_SOURCE} is empty.`);
  const files = {};
  let listing = '';
  for (const relative of [...hashes.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    files[relative] = hashes.get(relative);
    listing += `${files[relative]}  ${relative}\n`;
  }
  return deepFreeze({ sha256: sha256Hex(Buffer.from(listing, 'utf8')), files });
}

function isExactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}

function readSourceDigestRecord(filePath) {
  const info = fsSync.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_SOURCE_DIGEST_BYTES) {
    throw identityMismatch(`${ARCHIVE_WORKER_SOURCE_DIGEST} is not one regular file.`);
  }
  let record;
  try {
    record = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
  } catch {
    throw identityMismatch(`${ARCHIVE_WORKER_SOURCE_DIGEST} is not valid JSON.`);
  }
  const files = record?.files;
  if (!isExactObject(record, ['schemaVersion', 'source', 'sha256', 'files', 'worker']) || record.schemaVersion !== 1 ||
      record.source !== ARCHIVE_WORKER_SOURCE || !SHA256_HEX.test(String(record.sha256)) ||
      !isExactObject(record.worker, ['size', 'sha256']) || !Number.isSafeInteger(record.worker.size) || record.worker.size < 1 ||
      !SHA256_HEX.test(String(record.worker.sha256)) || !files || typeof files !== 'object' || Array.isArray(files) ||
      Object.keys(files).length === 0 ||
      Object.entries(files).some(([name, digest]) => !SOURCE_RELATIVE_PATH.test(name) || !SHA256_HEX.test(String(digest)))) {
    throw identityMismatch(`${ARCHIVE_WORKER_SOURCE_DIGEST} is not a valid source digest record.`);
  }
  return record;
}

function assertSourceDigestMatches(record, computed) {
  const describe = (label, names) => (names.length === 0 ? [] :
    [`${label} ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}`]);
  const changed = Object.keys(computed.files).filter(name => Object.hasOwn(record.files, name) && record.files[name] !== computed.files[name]);
  const added = Object.keys(computed.files).filter(name => !Object.hasOwn(record.files, name));
  const removed = Object.keys(record.files).filter(name => !Object.hasOwn(computed.files, name));
  if (changed.length > 0 || added.length > 0 || removed.length > 0) {
    throw identityMismatch(`${ARCHIVE_WORKER_SOURCE} differs from the sources the committed ArchiveWorker.exe was built from: ${
      [...describe('changed', changed), ...describe('added', added), ...describe('removed', removed)].join('; ')}.`);
  }
  if (computed.sha256 !== record.sha256) throw identityMismatch(`${ARCHIVE_WORKER_SOURCE_DIGEST} does not match its own file list.`);
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

// verify:archive-worker: the committed worker matches its pinned manifest and the sources it was built from.
// Static file checks only; it launches no process.
async function verifySourceArchiveIdentity({ repositoryRoot = path.resolve(__dirname, '..') } = {}) {
  try {
    if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) throw unavailable();
    const root = path.resolve(repositoryRoot);
    const manifestsRoot = path.join(root, 'build-resources', 'archive-runtime');
    const workerDirectory = path.join(root, 'vendor', 'archive-worker', 'x64');
    await assertManifestIdentities(manifestsRoot);
    await assertDirectory(workerDirectory, ['ArchiveWorker.exe']);
    const worker = verifyArchiveWorkerExecutableSync({
      workerPath: path.join(workerDirectory, 'ArchiveWorker.exe'),
      workerManifestPath: path.join(manifestsRoot, 'archive-worker-x64.json')
    });
    if (worker.architecture !== 'x64' || worker.runtimeIdentifier !== 'win-x64' ||
        worker.targetFramework !== 'net8.0-windows' || worker.runtimeMode !== 'in-memory-single-file') throw unavailable();
    const record = readSourceDigestRecord(path.join(root, ...ARCHIVE_WORKER_SOURCE_DIGEST.split('/')));
    const source = computeArchiveWorkerSourceDigest(path.join(root, ...ARCHIVE_WORKER_SOURCE.split('/')));
    assertSourceDigestMatches(record, source);
    if (record.worker.size !== worker.file.size || record.worker.sha256 !== worker.file.sha256) {
      throw identityMismatch(`${ARCHIVE_WORKER_SOURCE_DIGEST} records a different ArchiveWorker.exe than the committed one.`);
    }
    return deepFreeze({
      type: 'source-archive-identity',
      version: 1,
      worker: { size: worker.file.size, sha256: worker.file.sha256 },
      source: { root: ARCHIVE_WORKER_SOURCE, files: Object.keys(source.files).length, sha256: source.sha256 }
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
  ARCHIVE_WORKER_SOURCE,
  ARCHIVE_WORKER_SOURCE_DIGEST,
  MANIFEST_IDENTITIES,
  computeArchiveWorkerSourceDigest,
  verifyPackagedArchive,
  verifySourceArchiveForPack,
  verifySourceArchiveIdentity,
  default: verifySourceArchiveForPack
};

if (require.main === module) {
  const failed = (error, hint) => {
    const detail = error?.cause?.code === 'ARCHIVE_IDENTITY_MISMATCH' ? `${error.cause.message}\n` : '';
    process.stderr.write(`${error?.safeMessage || 'Packaged archive processing is unavailable'}\n${detail}${hint ? `${hint}\n` : ''}`);
    process.exitCode = 1;
  };
  const options = process.argv.slice(2);
  if (options.length === 1 && options[0] === '--source-identity') {
    verifySourceArchiveIdentity().then(evidence => {
      process.stdout.write(`Verified the committed ArchiveWorker.exe (${evidence.worker.size} bytes, sha256 ${evidence.worker.sha256}) ` +
        `against its pinned manifest and ${evidence.source.files} ${evidence.source.root} source files (digest ${evidence.source.sha256}).\n`);
    }).catch(error => failed(error, SOURCE_IDENTITY_HINT));
  } else if (options.length === 0) {
    verifyPackagedArchive({ appOutDir: path.resolve(__dirname, '..', 'dist', 'win-unpacked') }).then(evidence => {
      process.stdout.write(`Verified packaged archive ${evidence.runtime.version} ${evidence.architecture}; containment ${evidence.containment}\n`);
    }).catch(error => failed(error));
  } else {
    process.stderr.write('Usage: node scripts/verify-packaged-archive.cjs [--source-identity]\n');
    process.exitCode = 1;
  }
}
