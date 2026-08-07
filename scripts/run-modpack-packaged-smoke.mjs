import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ArtifactWorkspaceRegistry } = require('../electron/services/modpacks/artifacts/artifact-workspace-registry.cjs');
const { createArchiveExtractor } = require('../electron/services/modpacks/archive/archive-extractor.cjs');
const { createArchiveInspector } = require('../electron/services/modpacks/archive/archive-inspector.cjs');
const { ArchiveWorkerClient } = require('../electron/services/modpacks/archive/archive-worker-client.cjs');
const { createArtifactSetPlan, finalizeVerifiedArtifactSet } = require('../electron/services/modpacks/contracts.cjs');
const { WindowsReparseInspector } = require('../electron/services/modpacks/local/windows-reparse-inspector.cjs');
const { deterministicZip } = require('../tests/modpacks/fixtures/lifecycle-harness.cjs');
const { verifyPackagedArchive } = require('./verify-packaged-archive.cjs');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_KEYS = new Set([
  'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH',
  'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS', 'OS', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMROOT', 'TEMP',
  'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
]);
const TOMBSTONE_KEYS = [
  'ALL_PROXY', 'ELECTRON_DISABLE_SECURITY_WARNINGS', 'ELECTRON_RUN_AS_NODE', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY',
  'MINECRAFT_CORE_ARCHIVE_RUNTIME_FILE', 'MINECRAFT_CORE_E2E_SCENARIO_FILE',
  'MINECRAFT_CORE_TEST_MODE', 'MINECRAFT_CORE_TEST_MODPACK_FACTORY', 'MINECRAFT_CORE_USE_DEV_SERVER',
  'NODE_ENV', 'NODE_OPTIONS', 'NO_PROXY', 'PATH', 'Path'
];

const FIXTURE_HASHES = Object.freeze({
  'prepared-vanilla.zip': '5304c611fa8329dec173d90cd83d10cc4f49440023e6216c1eea93764b891814',
  'tiny-zip64.zip': 'f4735f3d12914a8b3ddacbab8aaefc84912b91a0df4194be5ba5db0e46af3279',
  'rar4.rar': 'dce342bc0c2852fcaa36a03da5e55abb7dd69c045bbd812faebebc1a3844f5a4',
  'rar5.rar': 'a546b39c1aa42669543ef81f5ec8c4ef49fc7c2e5b8d08ab10549e919996e1a4',
  'multipart.part0001.rar': '54769cdaa6aeac494b9ba580804598369ba240f61550620434e08350e4428ec2',
  'multipart.part0002.rar': '9dd6b28d2fdf0d012390259548cc86be9535ee6eb5ec630c99fbb5dc8d037ed1',
  'multipart.part0003.rar': '7d72ef6e876e98e6a317b7e534c0285615a2953543e68135a8a0dcc94b41cf21',
  'rar5-multipart.part01.rar': '6607f575dad0b28aaeb02298b4c04a0e5a606e77f952127d2d9e346f60616a26',
  'rar5-multipart.part02.rar': 'eb119ed53511905ca6f1844c164b6246d8fcdca0d1f38a8e3fb13da9c0932fbd',
  'rar5-multipart.part03.rar': 'e814c3dbdaf3f613fd25c840065d25543f31e6b6c95505e7e25f47867a4812bd',
  'rar5-multipart.part04.rar': '9ff5a4e633b0e82a2ce6e022f3d389654dbb77a0906a34f107676d6673989c9f',
  'encrypted.zip': '41d5385a18d61e93d14d19b4d82b2a1a13db9c382b41f1e6700be416856bc5e3',
  'traversal.zip': 'b610f140c37669a753051fc166f8bf71e3f7049267a30df61484e6878e69ca7f'
});
const GENERATED_MRPACK_SHA256 = '8e492d0f14f22a84b66ab9e3b949ecc60fc7af88b011c5ce00b8afe03b7abfcb';
const MAX_WINDOWS_LEGACY_PATH_CHARS = 259;
const DOTNET_BUNDLE_EXTRACTION_SUFFIX = Object.freeze([
  'broker-bundles',
  'bundle-XXXXXX',
  'ArchiveWorker',
  'fffff',
  'System.Runtime.InteropServices.RuntimeInformation.dll'
]);

function smokeFailure(cause) {
  const error = new Error('Packaged modpack smoke evidence is incomplete', { cause });
  error.code = 'PACKAGED_SMOKE_FAILED';
  return error;
}

export function resolveArchiveWorkerProbeRoot(probeRoot) {
  if (typeof probeRoot !== 'string' || !path.isAbsolute(probeRoot)) throw smokeFailure();
  const resolvedProbeRoot = path.resolve(probeRoot);
  const workerRoot = path.join(resolvedProbeRoot, 'w');
  if (path.dirname(workerRoot) !== resolvedProbeRoot ||
      path.join(workerRoot, ...DOTNET_BUNDLE_EXTRACTION_SUFFIX).length > MAX_WINDOWS_LEGACY_PATH_CHARS) {
    throw smokeFailure();
  }
  return workerRoot;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw smokeFailure();
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw smokeFailure();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      throw smokeFailure();
    }
  }
  return value;
}

function assertSafeJson(value, depth = 0, seen = new Set()) {
  if (depth > 24) throw smokeFailure();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw smokeFailure();
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 4096 || /(?:https?:\/\/|[A-Za-z]:\\|\\\\|(?:token|secret|password)\s*=)/iu.test(value)) throw smokeFailure();
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw smokeFailure();
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) throw smokeFailure();
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.get === 'function' || typeof descriptor.set === 'function' ||
        (/^(?:path|url|token|secret|password)$/iu.test(key) && key !== 'pathSanitized')) throw smokeFailure();
    assertSafeJson(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
}

function freezeJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function closedClone(value) {
  assertSafeJson(value);
  return JSON.parse(JSON.stringify(value));
}

function assertDigest(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw smokeFailure();
}

function validateExtractedArchives(entries) {
  const expected = new Map([
    ['mrpack', ['mrpack', 'zip', 'single']],
    ['zip', ['zip', 'zip', 'single']],
    ['zip64', ['zip64', 'zip', 'single']],
    ['rar4', ['rar4', 'rar4', 'single']],
    ['rar5', ['rar5', 'rar5', 'single']],
    ['rar4-part-number', ['multipart-rar', 'rar4', 'part-number']],
    ['rar5-part-number', ['multipart-rar', 'rar5', 'part-number']]
  ]);
  if (!Array.isArray(entries) || entries.length !== expected.size) throw smokeFailure();
  const seen = new Set();
  for (const entry of entries) {
    exactObject(entry, ['archiveId', 'archiveFamily', 'engineFamily', 'groupingScheme', 'layer', 'sha256', 'outcome']);
    const wanted = expected.get(entry.archiveId);
    if (!wanted || seen.has(entry.archiveId) || entry.archiveFamily !== wanted[0] || entry.engineFamily !== wanted[1] ||
        entry.groupingScheme !== wanted[2] || entry.layer !== 'packaged-worker-extraction' || entry.outcome !== 'accepted') {
      throw smokeFailure();
    }
    assertDigest(entry.sha256);
    seen.add(entry.archiveId);
  }
}

function validateSchemes(entries) {
  const expected = new Map([
    ['part-number', 'packaged-worker-extraction'],
    ['rar-rxx', 'deterministic-grouping-download-materialization-validation'],
    ['numbered-volume', 'deterministic-grouping-download-materialization-validation']
  ]);
  if (!Array.isArray(entries) || entries.length !== expected.size) throw smokeFailure();
  const seen = new Set();
  for (const entry of entries) {
    exactObject(entry, ['groupingScheme', 'layer', 'outcome']);
    if (!expected.has(entry.groupingScheme) || seen.has(entry.groupingScheme) ||
        entry.layer !== expected.get(entry.groupingScheme) || entry.outcome !== 'accepted') throw smokeFailure();
    seen.add(entry.groupingScheme);
  }
}

function validateRejections(entries) {
  const expected = new Map([
    ['encrypted-entry', ['packaged-worker-extraction', 'ENCRYPTED_ARCHIVE']],
    ['encrypted-header', ['deterministic-engine-evidence', 'ENCRYPTED_ARCHIVE']],
    ['incomplete-multipart', ['packaged-worker-extraction', 'MULTIPART_VOLUME_MISSING']],
    ['unsafe-traversal', ['packaged-worker-extraction', 'UNSAFE_ARCHIVE_ENTRY']]
  ]);
  if (!Array.isArray(entries) || entries.length !== expected.size) throw smokeFailure();
  const seen = new Set();
  for (const entry of entries) {
    exactObject(entry, ['caseId', 'layer', 'code']);
    const wanted = expected.get(entry.caseId);
    if (!wanted || seen.has(entry.caseId) || entry.layer !== wanted[0] || entry.code !== wanted[1]) throw smokeFailure();
    seen.add(entry.caseId);
  }
}

function validateLifecycle(value) {
  exactObject(value, ['layer', 'fixtureFactoryEnabled', 'operations', 'canonicalServer', 'history', 'ownership', 'recovery']);
  if (value.layer !== 'non-packaged-test-composition' || value.fixtureFactoryEnabled !== true) throw smokeFailure();
  const operations = new Set(['create', 'update', 'verify', 'targeted-repair', 'detach']);
  if (!Array.isArray(value.operations) || value.operations.length !== operations.size) throw smokeFailure();
  for (const entry of value.operations) {
    exactObject(entry, ['operation', 'outcome']);
    if (!operations.delete(entry.operation) || entry.outcome !== 'succeeded') throw smokeFailure();
  }
  exactObject(value.canonicalServer, ['count', 'sha256', 'generation']);
  if (value.canonicalServer.count !== 1 || typeof value.canonicalServer.generation !== 'string' || !value.canonicalServer.generation) throw smokeFailure();
  assertDigest(value.canonicalServer.sha256);
  exactObject(value.history, ['durable', 'operationCount', 'ownershipTransitionsRecorded']);
  if (value.history.durable !== true || !Number.isSafeInteger(value.history.operationCount) || value.history.operationCount < 5 ||
      value.history.ownershipTransitionsRecorded !== true) throw smokeFailure();
  exactObject(value.ownership, ['verified', 'detached', 'unmanagedFilesPreserved']);
  if (Object.values(value.ownership).some(item => item !== true)) throw smokeFailure();
  exactObject(value.recovery, ['crashPoints', 'startupBlockedUntilRecovered', 'canonicalServerCount', 'idempotent', 'outcome']);
  const crashPoints = new Set(['before-live-rename', 'between-renames', 'after-candidate-rename']);
  if (!Array.isArray(value.recovery.crashPoints) || value.recovery.crashPoints.length !== crashPoints.size ||
      value.recovery.crashPoints.some(point => !crashPoints.delete(point)) || value.recovery.startupBlockedUntilRecovered !== true ||
      value.recovery.canonicalServerCount !== 1 || value.recovery.idempotent !== true || value.recovery.outcome !== 'recovered') {
    throw smokeFailure();
  }
}

function validateSmokeEvidenceInner(value) {
  exactObject(value, [
    'type', 'version', 'platform', 'architecture', 'application', 'archiveWorker', 'fallbacksUsed',
    'environment', 'archives', 'lifecycle'
  ]);
  if (value.type !== 'minecraft-core-packaged-modpack-smoke' || value.version !== 1 || value.platform !== 'win32' ||
      value.architecture !== 'x64' || !Array.isArray(value.fallbacksUsed) || value.fallbacksUsed.length !== 0) throw smokeFailure();
  exactObject(value.application, ['version', 'executableSize', 'executableSha256', 'rendererLoaded']);
  if (!/^\d+\.\d+\.\d+$/u.test(value.application.version) || !Number.isSafeInteger(value.application.executableSize) ||
      value.application.executableSize < 1 || value.application.rendererLoaded !== true) throw smokeFailure();
  assertDigest(value.application.executableSha256);
  exactObject(value.archiveWorker, ['containment', 'runtimeVersion', 'handlers', 'workerSize', 'workerSha256']);
  exactObject(value.archiveWorker.handlers, ['zip', 'rar']);
  if (value.archiveWorker.containment !== 'passed' || value.archiveWorker.runtimeVersion !== '26.02' ||
      value.archiveWorker.handlers.zip !== true || value.archiveWorker.handlers.rar !== true ||
      !Number.isSafeInteger(value.archiveWorker.workerSize) || value.archiveWorker.workerSize < 1) throw smokeFailure();
  assertDigest(value.archiveWorker.workerSha256);
  exactObject(value.environment, [
    'appIsPackaged', 'productionComposition', 'fixtureFactoryEnabled', 'isolatedUserData', 'pathSanitized',
    'fixtureRootUnchanged', 'publicNetworkRequests'
  ]);
  if (value.environment.appIsPackaged !== true || value.environment.productionComposition !== true ||
      value.environment.fixtureFactoryEnabled !== false || value.environment.isolatedUserData !== true ||
      value.environment.pathSanitized !== true || value.environment.fixtureRootUnchanged !== true ||
      value.environment.publicNetworkRequests !== 0) throw smokeFailure();
  exactObject(value.archives, ['extracted', 'schemes', 'rejected']);
  validateExtractedArchives(value.archives.extracted);
  validateSchemes(value.archives.schemes);
  validateRejections(value.archives.rejected);
  validateLifecycle(value.lifecycle);
}

export function validateSmokeEvidence(value) {
  try {
    const clone = closedClone(value);
    validateSmokeEvidenceInner(clone);
    return freezeJson(clone);
  } catch (error) {
    if (error?.code === 'PACKAGED_SMOKE_FAILED') throw error;
    throw smokeFailure(error);
  }
}

export function createSanitizedEnvironment({ source = process.env, userDataPath } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || typeof userDataPath !== 'string' ||
      !path.isAbsolute(userDataPath)) throw new TypeError('Packaged smoke environment input is invalid');
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    result[key] = SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase()) ? value : '';
  }
  for (const key of TOMBSTONE_KEYS) result[key] = '';
  result.MINECRAFT_CORE_USER_DATA_DIR = path.resolve(userDataPath);
  return Object.freeze(result);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha512(bytes) {
  return crypto.createHash('sha512').update(bytes).digest('hex');
}

async function assertExactPath(candidate, kind) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw smokeFailure();
  const resolved = path.resolve(candidate);
  const info = await fs.lstat(resolved);
  if (info.isSymbolicLink() || (kind === 'file' ? !info.isFile() : !info.isDirectory())) throw smokeFailure();
  if ((await fs.realpath(resolved)).toLocaleLowerCase('en-US') !== resolved.toLocaleLowerCase('en-US')) throw smokeFailure();
  return { resolved, info };
}

async function hashTree(root) {
  const { resolved } = await assertExactPath(root, 'directory');
  const hash = crypto.createHash('sha256');
  async function walk(directory, relative) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await fs.lstat(entryPath);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) ||
          (await fs.realpath(entryPath)).toLocaleLowerCase('en-US') !== entryPath.toLocaleLowerCase('en-US')) throw smokeFailure();
      hash.update(info.isDirectory() ? `d:${name}\0` : `f:${name}:${info.size}\0`, 'utf8');
      if (info.isDirectory()) await walk(entryPath, name);
      else hash.update(await fs.readFile(entryPath));
    }
  }
  await walk(resolved, '');
  return hash.digest('hex');
}

async function removeControlledRoot(root, parent) {
  const resolvedRoot = path.resolve(root);
  const resolvedParent = path.resolve(parent);
  if (path.dirname(resolvedRoot).toLocaleLowerCase('en-US') !== resolvedParent.toLocaleLowerCase('en-US') ||
      !path.basename(resolvedRoot).startsWith('minecraft-core-packaged-smoke-')) throw smokeFailure();
  let info;
  try { info = await fs.lstat(resolvedRoot); } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (await fs.realpath(resolvedRoot)).toLocaleLowerCase('en-US') !== resolvedRoot.toLocaleLowerCase('en-US')) throw smokeFailure();
  await fs.rm(resolvedRoot, { recursive: true, force: false });
}

function generatedMrpack() {
  const manifest = Buffer.from(JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'packaged-smoke-1.0.0',
    name: 'Packaged Smoke Server Pack',
    summary: 'Deterministic packaged release smoke',
    files: [],
    dependencies: { minecraft: '1.21.1' }
  }), 'utf8');
  const bytes = deterministicZip([{ name: 'modrinth.index.json', data: manifest }]);
  if (sha256(bytes) !== GENERATED_MRPACK_SHA256) throw smokeFailure();
  return bytes;
}

async function loadFixtureParts(fixtureRoot, names) {
  const parts = [];
  for (const [index, name] of names.entries()) {
    const expected = FIXTURE_HASHES[name];
    if (!expected) throw smokeFailure();
    const filePath = path.join(fixtureRoot, name);
    if (path.dirname(filePath) !== fixtureRoot) throw smokeFailure();
    await assertExactPath(filePath, 'file');
    const bytes = await fs.readFile(filePath);
    if (sha256(bytes) !== expected) throw smokeFailure();
    parts.push({ partId: `part-${index + 1}`, fileName: name, bytes });
  }
  return parts;
}

function verifiedSet(parts, groupingScheme = 'single') {
  const plan = createArtifactSetPlan({
    provider: 'local',
    artifactSet: {
      kind: parts.length === 1 ? 'single' : 'multipart',
      primaryPartId: parts[0].partId,
      groupingScheme: parts.length === 1 ? 'single' : groupingScheme,
      parts: parts.map(part => ({
        partId: part.partId,
        fileName: part.fileName,
        size: String(part.bytes.length),
        providerDigest: { algorithm: 'sha256', value: sha256(part.bytes) }
      })),
      providerImmutable: true,
      attestationStatus: 'verified'
    }
  });
  return finalizeVerifiedArtifactSet(plan, parts.map(part => ({
    partId: part.partId,
    measuredSize: String(part.bytes.length),
    sha256: sha256(part.bytes),
    sha512: sha512(part.bytes)
  })));
}

function idFactory(prefix) {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

async function createArchiveCase({ caseRoot, resourcesRoot, parts, groupingScheme, appOwnedRoot }) {
  const set = verifiedSet(parts, groupingScheme);
  const bytesByPart = new Map(parts.map(part => [part.partId, part.bytes]));
  const workspaceRoot = path.join(caseRoot, 'workspaces');
  const cache = {
    retain() {},
    release() {},
    async materializeSet(value, destination) {
      await fs.mkdir(destination);
      for (const part of value.artifactSet.parts) await fs.writeFile(path.join(destination, part.fileName), bytesByPart.get(part.partId));
      const primary = value.artifactSet.parts.find(part => part.partId === value.artifactSet.primaryPartId);
      return path.join(destination, primary.fileName);
    }
  };
  const registry = new ArtifactWorkspaceRegistry({
    root: workspaceRoot,
    artifactCache: cache,
    idFactory: idFactory('smoke')
  });
  const reparseInspector = new WindowsReparseInspector();
  const workerClient = new ArchiveWorkerClient({
    workerPath: path.join(resourcesRoot, 'worker', 'ArchiveWorker.exe'),
    workerManifestPath: path.join(resourcesRoot, 'manifests', 'archive-worker-x64.json'),
    resourcesRoot,
    runtimeLayout: 'packaged',
    workspaceRoot,
    workspaceRegistry: registry,
    reparseInspector,
    appOwnedRoot
  });
  return {
    set,
    registry,
    workspaceRoot,
    inspector: createArchiveInspector({ workspaceRegistry: registry, workspaceRoot, workerClient }),
    extractor: createArchiveExtractor({ workspaceRegistry: registry, workspaceRoot, workerClient, reparseInspector })
  };
}

async function runAcceptedArchive({ probeRoot, resourcesRoot, fixtureRoot, archiveId, archiveFamily, engineFamily,
  groupingScheme = 'single', fixtureNames = [], generatedBytes = null, appOwnedRoot }) {
  const caseRoot = await fs.mkdtemp(path.join(probeRoot, `case-${archiveId}-`));
  const parts = generatedBytes
    ? [{ partId: 'part-1', fileName: 'packaged-smoke.mrpack', bytes: generatedBytes }]
    : await loadFixtureParts(fixtureRoot, fixtureNames);
  const current = await createArchiveCase({ caseRoot, resourcesRoot, parts, groupingScheme, appOwnedRoot });
  const inspected = await current.inspector.inspectArchive({ verifiedArtifactSet: current.set });
  const expectedInspectionFamily = archiveFamily === 'zip64' ? 'zip' : archiveFamily;
  if (inspected.archiveFamily !== expectedInspectionFamily ||
      (engineFamily === 'zip' ? inspected.engineEvidence.family !== 'zip' : inspected.engineEvidence.concreteFamily !== engineFamily) ||
      inspected.integrity !== 'tested') throw smokeFailure();
  const destinationId = current.registry.createStagingOutput({ ownerId: inspected.inspectionId });
  const extracted = await current.extractor.extractArchive({ inspectionId: inspected.inspectionId, destinationId });
  if (extracted.type !== 'verified-extraction' || extracted.measured.entryCount < 1) throw smokeFailure();
  current.registry.releaseOwner(inspected.inspectionId);
  return {
    archiveId,
    archiveFamily,
    engineFamily,
    groupingScheme,
    layer: 'packaged-worker-extraction',
    sha256: current.set.artifactSet.setDigest,
    outcome: 'accepted'
  };
}

async function runRejectedArchive({ probeRoot, resourcesRoot, fixtureRoot, caseId, expectedCode, fixtureNames,
  groupingScheme = 'single', appOwnedRoot }) {
  const caseRoot = await fs.mkdtemp(path.join(probeRoot, `case-${caseId}-`));
  const parts = await loadFixtureParts(fixtureRoot, fixtureNames);
  const current = await createArchiveCase({ caseRoot, resourcesRoot, parts, groupingScheme, appOwnedRoot });
  try {
    await current.inspector.inspectArchive({ verifiedArtifactSet: current.set });
  } catch (error) {
    if (error?.code !== expectedCode) throw error;
    return { caseId, layer: 'packaged-worker-extraction', code: expectedCode };
  }
  throw smokeFailure();
}

export async function runPackagedArchiveFixtures({ resourcesPath, fixtureRoot, temporaryBase = os.tmpdir() } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw smokeFailure();
  const resources = (await assertExactPath(resourcesPath, 'directory')).resolved;
  const fixtures = (await assertExactPath(fixtureRoot, 'directory')).resolved;
  const temporary = (await assertExactPath(path.resolve(temporaryBase), 'directory')).resolved;
  const resourcesRoot = path.join(resources, 'archive');
  await assertExactPath(resourcesRoot, 'directory');
  const probeRoot = await fs.mkdtemp(path.join(temporary, 'minecraft-core-packaged-smoke-archive-'));
  const appOwnedRoot = resolveArchiveWorkerProbeRoot(probeRoot);
  let evidence = null;
  let primaryFailure = null;
  try {
    const accepted = [
      { archiveId: 'mrpack', archiveFamily: 'mrpack', engineFamily: 'zip', generatedBytes: generatedMrpack() },
      { archiveId: 'zip', archiveFamily: 'zip', engineFamily: 'zip', fixtureNames: ['prepared-vanilla.zip'] },
      { archiveId: 'zip64', archiveFamily: 'zip64', engineFamily: 'zip', fixtureNames: ['tiny-zip64.zip'] },
      { archiveId: 'rar4', archiveFamily: 'rar4', engineFamily: 'rar4', fixtureNames: ['rar4.rar'] },
      { archiveId: 'rar5', archiveFamily: 'rar5', engineFamily: 'rar5', fixtureNames: ['rar5.rar'] },
      {
        archiveId: 'rar4-part-number', archiveFamily: 'multipart-rar', engineFamily: 'rar4', groupingScheme: 'part-number',
        fixtureNames: ['multipart.part0001.rar', 'multipart.part0002.rar', 'multipart.part0003.rar']
      },
      {
        archiveId: 'rar5-part-number', archiveFamily: 'multipart-rar', engineFamily: 'rar5', groupingScheme: 'part-number',
        fixtureNames: ['rar5-multipart.part01.rar', 'rar5-multipart.part02.rar', 'rar5-multipart.part03.rar', 'rar5-multipart.part04.rar']
      }
    ];
    const extracted = [];
    for (const descriptor of accepted) {
      extracted.push(await runAcceptedArchive({ probeRoot, resourcesRoot, fixtureRoot: fixtures, appOwnedRoot, ...descriptor }));
    }
    const rejected = [];
    for (const descriptor of [
      { caseId: 'encrypted-entry', expectedCode: 'ENCRYPTED_ARCHIVE', fixtureNames: ['encrypted.zip'] },
      {
        caseId: 'incomplete-multipart', expectedCode: 'MULTIPART_VOLUME_MISSING', groupingScheme: 'part-number',
        fixtureNames: ['multipart.part0001.rar', 'multipart.part0002.rar']
      },
      { caseId: 'unsafe-traversal', expectedCode: 'UNSAFE_ARCHIVE_ENTRY', fixtureNames: ['traversal.zip'] }
    ]) rejected.push(await runRejectedArchive({ probeRoot, resourcesRoot, fixtureRoot: fixtures, appOwnedRoot, ...descriptor }));
    evidence = freezeJson({
      extracted,
      schemes: [{ groupingScheme: 'part-number', layer: 'packaged-worker-extraction', outcome: 'accepted' }],
      rejected
    });
  } catch (error) {
    primaryFailure = error;
  }
  try {
    let info = null;
    try { info = await fs.lstat(probeRoot); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(probeRoot) !== temporary) throw smokeFailure();
      await fs.rm(probeRoot, { recursive: true, force: false });
    }
  } catch (error) {
    primaryFailure = smokeFailure(error);
  }
  if (primaryFailure) throw primaryFailure;
  if (!evidence) throw smokeFailure();
  return evidence;
}

function loadHarness(repositoryRoot) {
  const harnessPath = path.join(repositoryRoot, 'tests', 'e2e', 'fixtures', 'modpack-harness.cjs');
  const info = fsSync.lstatSync(harnessPath);
  if (!info.isFile() || info.isSymbolicLink() || fsSync.realpathSync.native(harnessPath).toLocaleLowerCase('en-US') !==
      harnessPath.toLocaleLowerCase('en-US')) throw smokeFailure();
  return require(harnessPath);
}

async function defaultPackagedDriver(input) {
  const harness = loadHarness(input.repositoryRoot);
  if (typeof harness.runPackagedModpackSmoke !== 'function') throw smokeFailure();
  return harness.runPackagedModpackSmoke(input);
}

async function defaultDeterministicProbe(input) {
  const harness = loadHarness(input.repositoryRoot);
  if (typeof harness.runDeterministicModpackLifecycleEvidence !== 'function') throw smokeFailure();
  return harness.runDeterministicModpackLifecycleEvidence(input);
}

function validatePackagedDriverEvidence(value) {
  exactObject(value, ['rendererLoaded', 'environment', 'fallbacksUsed']);
  if (value.rendererLoaded !== true || !Array.isArray(value.fallbacksUsed) || value.fallbacksUsed.length !== 0) throw smokeFailure();
  exactObject(value.environment, [
    'appIsPackaged', 'productionComposition', 'fixtureFactoryEnabled', 'isolatedUserData', 'pathSanitized', 'publicNetworkRequests'
  ]);
  if (value.environment.appIsPackaged !== true || value.environment.productionComposition !== true ||
      value.environment.fixtureFactoryEnabled !== false || value.environment.isolatedUserData !== true ||
      value.environment.pathSanitized !== true || value.environment.publicNetworkRequests !== 0) throw smokeFailure();
}

function validateArchiveProbeEvidence(value) {
  exactObject(value, ['extracted', 'schemes', 'rejected']);
  validateExtractedArchives(value.extracted);
  if (!Array.isArray(value.schemes) || value.schemes.length !== 1 || value.schemes[0]?.groupingScheme !== 'part-number' ||
      value.schemes[0]?.layer !== 'packaged-worker-extraction' || value.schemes[0]?.outcome !== 'accepted') throw smokeFailure();
  const expected = new Set(['encrypted-entry', 'incomplete-multipart', 'unsafe-traversal']);
  if (!Array.isArray(value.rejected) || value.rejected.length !== expected.size ||
      value.rejected.some(entry => !expected.delete(entry?.caseId))) throw smokeFailure();
}

function validateDeterministicEvidence(value) {
  exactObject(value, ['layer', 'fixtureFactoryEnabled', 'schemes', 'rejected', 'lifecycle']);
  if (value.layer !== 'non-packaged-test-composition' || value.fixtureFactoryEnabled !== true ||
      !Array.isArray(value.schemes) || value.schemes.length !== 2 ||
      !Array.isArray(value.rejected) || value.rejected.length !== 1) throw smokeFailure();
  const schemes = new Map(value.schemes.map(entry => [entry?.groupingScheme, entry]));
  for (const name of ['rar-rxx', 'numbered-volume']) {
    const entry = schemes.get(name);
    if (!entry || entry.layer !== 'deterministic-grouping-download-materialization-validation' || entry.outcome !== 'accepted') throw smokeFailure();
  }
  const rejection = value.rejected[0];
  if (rejection?.caseId !== 'encrypted-header' || rejection.layer !== 'deterministic-engine-evidence' ||
      rejection.code !== 'ENCRYPTED_ARCHIVE') throw smokeFailure();
  exactObject(value.lifecycle, ['operations', 'canonicalServer', 'history', 'ownership', 'recovery']);
  validateLifecycle({
    layer: value.layer,
    fixtureFactoryEnabled: value.fixtureFactoryEnabled,
    ...value.lifecycle
  });
}

export async function runPackagedSmoke({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  appOutDir = path.join(DEFAULT_REPOSITORY_ROOT, 'dist', 'win-unpacked'),
  temporaryBase = os.tmpdir(),
  verifyPackage = verifyPackagedArchive,
  archiveProbe = runPackagedArchiveFixtures,
  deterministicProbe = defaultDeterministicProbe,
  driver = defaultPackagedDriver,
  platform = process.platform,
  architecture = process.arch
} = {}) {
  let smokeRoot = null;
  let primaryFailure = null;
  try {
    if (platform !== 'win32' || architecture !== 'x64' || typeof verifyPackage !== 'function' || typeof archiveProbe !== 'function' ||
        typeof deterministicProbe !== 'function' || typeof driver !== 'function') throw smokeFailure();
    const repository = (await assertExactPath(path.resolve(repositoryRoot), 'directory')).resolved;
    const appOutput = (await assertExactPath(path.resolve(appOutDir), 'directory')).resolved;
    const temporary = (await assertExactPath(path.resolve(temporaryBase), 'directory')).resolved;
    const fixtureRoot = (await assertExactPath(path.join(repository, 'tests', 'fixtures', 'archives'), 'directory')).resolved;
    const executablePath = path.join(appOutput, 'Minecraft Core.exe');
    const executable = await assertExactPath(executablePath, 'file');
    const packageJson = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
    if (!packageJson || typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(packageJson.version)) throw smokeFailure();
    const executableBytes = await fs.readFile(executable.resolved);
    const fixtureBefore = await hashTree(fixtureRoot);

    const packaged = await verifyPackage({ appOutDir: appOutput, architecture, platform });
    smokeRoot = await fs.mkdtemp(path.join(temporary, 'minecraft-core-packaged-smoke-'));
    const userDataPath = path.join(smokeRoot, 'user-data');
    await fs.mkdir(userDataPath);
    const env = createSanitizedEnvironment({ source: process.env, userDataPath });
    const probeResults = await Promise.allSettled([
      archiveProbe({ resourcesPath: path.join(appOutput, 'resources'), fixtureRoot, temporaryBase: smokeRoot }),
      deterministicProbe({ repositoryRoot: repository, fixtureRoot, temporaryBase: smokeRoot })
    ]);
    const failedProbe = probeResults.find(result => result.status === 'rejected');
    if (failedProbe) throw failedProbe.reason;
    const [archiveRaw, deterministicRaw] = probeResults.map(result => result.value);
    const driverRaw = await driver({
      repositoryRoot: repository,
      executablePath: executable.resolved,
      userDataPath,
      env,
      fixtureRoot
    });
    const archiveEvidence = closedClone(archiveRaw);
    const deterministicEvidence = closedClone(deterministicRaw);
    const driverEvidence = closedClone(driverRaw);
    validateArchiveProbeEvidence(archiveEvidence);
    validateDeterministicEvidence(deterministicEvidence);
    validatePackagedDriverEvidence(driverEvidence);
    const fixtureAfter = await hashTree(fixtureRoot);
    if (fixtureAfter !== fixtureBefore) throw smokeFailure();

    return validateSmokeEvidence({
      type: 'minecraft-core-packaged-modpack-smoke',
      version: 1,
      platform: 'win32',
      architecture: 'x64',
      application: {
        version: packageJson.version,
        executableSize: executable.info.size,
        executableSha256: sha256(executableBytes),
        rendererLoaded: driverEvidence.rendererLoaded
      },
      archiveWorker: {
        containment: packaged.containment,
        runtimeVersion: packaged.runtime?.version,
        handlers: packaged.runtime?.handlers,
        workerSize: packaged.worker?.size,
        workerSha256: packaged.worker?.sha256
      },
      fallbacksUsed: [...(packaged.fallbacksUsed || []), ...driverEvidence.fallbacksUsed],
      environment: { ...driverEvidence.environment, fixtureRootUnchanged: true },
      archives: {
        extracted: archiveEvidence.extracted,
        schemes: [...archiveEvidence.schemes, ...deterministicEvidence.schemes],
        rejected: [...archiveEvidence.rejected, ...deterministicEvidence.rejected]
      },
      lifecycle: {
        layer: deterministicEvidence.layer,
        fixtureFactoryEnabled: deterministicEvidence.fixtureFactoryEnabled,
        ...deterministicEvidence.lifecycle
      }
    });
  } catch (error) {
    primaryFailure = error?.code === 'PACKAGED_SMOKE_FAILED' ? error : smokeFailure(error);
  } finally {
    if (smokeRoot) {
      try { await removeControlledRoot(smokeRoot, path.resolve(temporaryBase)); }
      catch (cleanupError) { primaryFailure = smokeFailure(cleanupError); }
    }
  }
  throw primaryFailure || smokeFailure();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath.toLocaleLowerCase('en-US') === SCRIPT_PATH.toLocaleLowerCase('en-US')) {
  runPackagedSmoke().then(evidence => {
    process.stdout.write(`PACKAGED_MODPACK_SMOKE_JSON ${JSON.stringify(evidence)}\n`);
  }).catch(error => {
    process.stderr.write(`${error?.code === 'PACKAGED_SMOKE_FAILED' ? error.message : 'Packaged modpack smoke failed'}\n`);
    process.exitCode = 1;
  });
}
