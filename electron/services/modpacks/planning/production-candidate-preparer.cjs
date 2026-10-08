const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { getRequiredJavaVersion } = require('../../minecraft-launcher/utils.cjs');
const { normalizeRuntimeTuple } = require('../contracts.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { buildMrpackServerPlan, resolveOptionalFileChoiceIds } = require('../mrpack/mrpack-file-plan.cjs');
const { MRPACK_MANIFEST_MAX_BYTES, parseMrpackManifest } = require('../mrpack/mrpack-parser.cjs');
const { classifyArchive } = require('../archive/archive-classifier.cjs');
const { canonicalPath } = require('./ownership-planner.cjs');
const {
  PersistentCandidateHashService,
  fileIdentityFromStat,
  sameFileIdentity
} = require('./candidate-hash-service.cjs');

const SAFE_PREPARED_ROOTS = new Set([
  'config', 'defaultconfigs', 'discordintegration-data', 'kubejs', 'mods', 'resourcepacks', 'resources',
  'scripts', 'shaderpacks', 'tacz', 'world', 'world_nether', 'world_the_end'
]);
const SAFE_PREPARED_FILES = new Set(['server.properties', 'server-icon.png']);
const FORBIDDEN_FILE = /\.(?:bat|cmd|com|exe|msi|ps1|sh|vbs|wsf|scr|dll)$/iu;
const CANDIDATE_PROGRESS_ACTIVITIES = new Set([
  'extracting', 'verifying-archive', 'downloading-pack-files', 'assembling-files', 'hashing-candidate-files'
]);

function candidateProgressReporter(callback) {
  if (callback === undefined) return () => {};
  if (typeof callback !== 'function') throw invalid();
  let previous = '';
  return value => {
    if (!value || !CANDIDATE_PROGRESS_ACTIVITIES.has(value.activity)) return;
    const event = { activity: value.activity };
    for (const [completed, total] of [
      ['completedItems', 'totalItems'], ['processedBytes', 'totalBytes']
    ]) {
      if (value[completed] === undefined && value[total] === undefined) continue;
      const completedValue = Number(value[completed]);
      const totalValue = Number(value[total]);
      if (!Number.isSafeInteger(completedValue) || completedValue < 0 ||
          !Number.isSafeInteger(totalValue) || totalValue < 0 || completedValue > totalValue) return;
      event[completed] = completedValue;
      event[total] = totalValue;
    }
    const key = JSON.stringify(event);
    if (key === previous) return;
    previous = key;
    try { Promise.resolve(callback(deepFreeze(event))).catch(() => {}); }
    catch { /* candidate progress cannot change planning correctness */ }
  };
}

function validCandidateHashService(value) {
  return value && typeof value.hashFile === 'function' && typeof value.dispose === 'function';
}

async function withCandidateHashService(candidateHashService, callback) {
  const supplied = candidateHashService !== undefined && candidateHashService !== null;
  if (supplied && !validCandidateHashService(candidateHashService)) throw invalid();
  const service = supplied ? candidateHashService : new PersistentCandidateHashService();
  try {
    return await callback(service);
  } finally {
    if (!supplied) await service.dispose();
  }
}

function invalid(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('INVALID_REQUEST', 'The archive candidate request is invalid', { cause });
}

function unsafe(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('UNSAFE_ARCHIVE_ENTRY', 'The archive candidate contains unsafe content', { cause });
}

function stale(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('PLAN_STALE', 'The installed modpack changed while its repair was prepared', { cause });
}

function cancellation(signal) {
  if (signal?.aborted) throw new ModpackError('CANCELLED', 'The operation was cancelled');
}

function preparationFailure(error, signal) {
  if (error instanceof ModpackError) return error;
  if (signal?.aborted || error?.code === 'ABORT_ERR') {
    return new ModpackError('CANCELLED', 'The operation was cancelled', { cause: error });
  }
  if (error?.code === 'ENOSPC') {
    return new ModpackError('INSUFFICIENT_DISK', 'There is not enough disk space to prepare this archive', {
      cause: error,
      retryable: true
    });
  }
  return new ModpackError('COMMIT_FAILED', 'File integrity check could not be completed', {
    cause: error,
    retryable: true
  });
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRelative(root, relativeValue) {
  const normalized = canonicalPath(relativeValue).path;
  const candidate = path.resolve(root, ...normalized.split('/'));
  if (!within(root, candidate)) throw unsafe();
  return candidate;
}

function stripRoot(value, selectedRoot) {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!selectedRoot) return normalized;
  const root = selectedRoot.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized === root) return '';
  if (!normalized.toLocaleLowerCase('en-US').startsWith(`${root.toLocaleLowerCase('en-US')}/`)) throw unsafe();
  return normalized.slice(root.length + 1);
}

function roleAndPolicy(relative) {
  const key = relative.toLocaleLowerCase('en-US');
  const first = key.split('/')[0];
  if (key === 'eula.txt') return { origin: 'pack', managementPolicy: 'ignored-rejected', role: 'configuration' };
  if (['world', 'world_nether', 'world_the_end'].includes(first)) {
    return { origin: 'pack', managementPolicy: 'preserve-after-seed', role: 'world' };
  }
  if (key === 'server.properties' || key === 'server-icon.png') {
    return { origin: 'pack', managementPolicy: 'preserve-after-seed', role: 'configuration' };
  }
  if (first === 'mods') return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'mod' };
  if (['config', 'defaultconfigs', 'discordintegration-data', 'kubejs', 'scripts'].includes(first)) {
    return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'configuration' };
  }
  if (['resourcepacks', 'resources', 'tacz'].includes(first)) {
    return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'resource' };
  }
  if (first === 'shaderpacks') return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'shader' };
  return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'other' };
}

function createManifestAccumulator(root) {
  const entries = new Map();
  let total = 0n;
  return Object.freeze({
    add(filePath, measured) {
      if (!measured || typeof measured.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(measured.sha256) ||
          typeof measured.size !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(measured.size)) throw unsafe();
      const relative = path.relative(root, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw unsafe();
      const normalized = canonicalPath(relative.replaceAll('\\', '/'));
      const previous = entries.get(normalized.pathKey);
      if (previous) total -= BigInt(previous.size);
      const manifestPath = previous?.path || normalized.path;
      const entry = {
        path: manifestPath,
        pathKey: normalized.pathKey,
        ...roleAndPolicy(manifestPath),
        installedHash: measured.sha256,
        size: measured.size,
        priorBaseline: null
      };
      entries.set(normalized.pathKey, entry);
      total += BigInt(measured.size);
    },
    finish(installationId) {
      const ordered = [...entries.values()].sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
      return {
        manifest: deepFreeze({ schemaVersion: 1, installationId, entries: ordered }),
        totalBytes: total.toString()
      };
    }
  });
}

function preparedPayloadTotals(entries, selectedRoot) {
  let completedItems = 0;
  let processedBytes = 0n;
  const root = selectedRoot?.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '') || '';
  for (const entry of archiveClassificationEntries(entries)) {
    if (entry.type !== 'file') continue;
    const normalizedEntry = entry.path.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
    let relative = normalizedEntry;
    if (root) {
      if (normalizedEntry === root) continue;
      if (!normalizedEntry.toLocaleLowerCase('en-US').startsWith(`${root.toLocaleLowerCase('en-US')}/`)) continue;
      relative = normalizedEntry.slice(root.length + 1);
    }
    const normalized = canonicalPath(relative);
    const first = normalized.pathKey.split('/')[0];
    const rootFile = !normalized.pathKey.includes('/') && SAFE_PREPARED_FILES.has(normalized.pathKey);
    const rootedPayload = normalized.pathKey.includes('/') && SAFE_PREPARED_ROOTS.has(first);
    if (!rootFile && !rootedPayload) continue;
    completedItems += 1;
    processedBytes += BigInt(entry.size);
  }
  if (completedItems < 1 || completedItems > Number.MAX_SAFE_INTEGER || processedBytes > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Object.freeze({ totalItems: completedItems, totalBytes: Number(processedBytes) });
}

function createRepairContext(currentState, liveSnapshot) {
  if (!currentState?.state || currentState.state.modpackManaged !== true ||
      !currentState.manifest || currentState.manifest.schemaVersion !== 1 ||
      !Array.isArray(currentState.manifest.entries) || liveSnapshot?.kind !== 'existing' ||
      !Array.isArray(liveSnapshot.entries)) throw stale();
  const installedByPath = new Map();
  for (const entry of currentState.manifest.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.pathKey !== 'string' ||
        installedByPath.has(entry.pathKey)) throw stale();
    installedByPath.set(entry.pathKey, entry);
  }
  const liveByPath = new Map();
  for (const entry of liveSnapshot.entries) {
    if (!entry || typeof entry.pathKey !== 'string' || liveByPath.has(entry.pathKey)) throw stale();
    liveByPath.set(entry.pathKey, entry);
  }
  const isMismatch = entry => {
    const live = liveByPath.get(entry.pathKey);
    return !live || live.type !== 'file' || live.sha256 !== entry.installedHash;
  };
  return Object.freeze({
    desiredManifest(installationId) {
      const entries = currentState.manifest.entries
        .map(entry => structuredClone(entry))
        .sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
      return deepFreeze({ schemaVersion: 1, installationId, entries });
    },
    shouldMaterialize(targetPath) {
      const key = canonicalPath(targetPath).pathKey;
      const installed = installedByPath.get(key);
      if (!installed) throw stale();
      return installed.origin === 'pack' && installed.managementPolicy === 'replaceable-managed' && isMismatch(installed);
    },
    verifyPayload(payloadManifest) {
      const payloadPaths = new Set();
      for (const entry of payloadManifest.entries) {
        const installed = installedByPath.get(entry.pathKey);
        if (!installed) throw stale();
        payloadPaths.add(entry.pathKey);
        if (installed.origin === 'pack' && installed.managementPolicy === 'replaceable-managed' &&
            (entry.installedHash !== installed.installedHash || entry.size !== installed.size)) throw stale();
      }
      for (const installed of installedByPath.values()) {
        if (installed.origin === 'pack' && installed.managementPolicy === 'replaceable-managed' &&
            isMismatch(installed) && !payloadPaths.has(installed.pathKey)) throw stale();
      }
      return payloadManifest;
    }
  });
}

async function hashFile(filePath, { candidateHashService, reparseInspector, signal, expectedStat = null }) {
  cancellation(signal);
  const before = expectedStat || await fsp.lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      await reparseInspector.isReparsePoint(filePath, signal ? { signal } : undefined) !== false) throw unsafe();
  const expectedIdentity = fileIdentityFromStat(before);
  let measured;
  try {
    measured = await candidateHashService.hashFile(filePath, { expectedIdentity, signal });
  } catch (error) {
    cancellation(signal);
    throw unsafe(error);
  }
  cancellation(signal);
  const after = await fsp.lstat(filePath, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
      await reparseInspector.isReparsePoint(filePath, signal ? { signal } : undefined) !== false) throw unsafe();
  const afterIdentity = fileIdentityFromStat(after);
  if (!sameFileIdentity(expectedIdentity, measured.identity) ||
      !sameFileIdentity(expectedIdentity, afterIdentity) || measured.size !== expectedIdentity.size) throw unsafe();
  return { sha256: measured.sha256, size: measured.size };
}

async function copyRegularFileWithService(source, destination, {
  beforeCopy, candidateHashService, relativePath = null, reparseInspector, signal, replace = false
}) {
  cancellation(signal);
  const before = await fsp.lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || BigInt(before.nlink) !== 1n ||
      await reparseInspector.isReparsePoint(source, signal ? { signal } : undefined) !== false) throw unsafe();
  if (FORBIDDEN_FILE.test(path.basename(destination))) throw unsafe();
  if (typeof beforeCopy === 'function') {
    await beforeCopy({ sourcePath: source, destinationPath: destination, relativePath, stat: before });
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination, replace ? 0 : fs.constants.COPYFILE_EXCL);
  const [sourceHash, targetHash] = await Promise.all([
    hashFile(source, { candidateHashService, reparseInspector, signal, expectedStat: before }),
    hashFile(destination, { candidateHashService, reparseInspector, signal })
  ]);
  if (JSON.stringify(sourceHash) !== JSON.stringify(targetHash)) throw unsafe();
  return targetHash;
}

async function copyRegularFile(source, destination, dependencies = {}) {
  return withCandidateHashService(dependencies.candidateHashService, candidateHashService =>
    copyRegularFileWithService(source, destination, { ...dependencies, candidateHashService }));
}

async function copyTreeWithService(source, destination, dependencies, relative = '') {
  cancellation(dependencies.signal);
  const entries = await fsp.readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  for (const entry of entries) {
    const sourceChild = path.join(source, entry.name);
    const relativeChild = relative ? `${relative}/${entry.name}` : entry.name;
    const destinationChild = resolveRelative(destination, relativeChild);
    const stat = await fsp.lstat(sourceChild, { bigint: true });
    if (stat.isSymbolicLink() || await dependencies.reparseInspector.isReparsePoint(sourceChild,
      dependencies.signal ? { signal: dependencies.signal } : undefined) !== false) throw unsafe();
    if (stat.isDirectory()) {
      if (typeof dependencies.beforeDirectory === 'function' &&
          await dependencies.beforeDirectory({
            sourcePath: sourceChild,
            destinationPath: destinationChild,
            relativePath: relativeChild,
            stat
          }) === false) continue;
      await fsp.mkdir(destinationChild, { recursive: true });
      await copyTreeWithService(sourceChild, destination, dependencies, relativeChild);
    } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
      const measured = await copyRegularFileWithService(sourceChild, destinationChild, {
        ...dependencies,
        relativePath: relativeChild
      });
      if (typeof dependencies.onCopied === 'function') {
        await dependencies.onCopied(destinationChild, measured, relativeChild);
      }
    } else {
      throw unsafe();
    }
  }
}

async function copyTree(source, destination, dependencies = {}, relative = '') {
  return withCandidateHashService(dependencies.candidateHashService, candidateHashService =>
    copyTreeWithService(source, destination, { ...dependencies, candidateHashService }, relative));
}

async function scanManifestWithService(root, installationId, { candidateHashService, reparseInspector, signal }) {
  const entries = [];
  let total = 0n;
  async function visit(directory, relative = '') {
    const children = await fsp.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const child of children) {
      cancellation(signal);
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      const key = childRelative.replaceAll('\\', '/').toLocaleLowerCase('en-US');
      if (key === '.minecraft-core.json' || key === '.minecraft-core-state' || key.startsWith('.minecraft-core-state/')) continue;
      const absolute = path.join(directory, child.name);
      const stat = await fsp.lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw unsafe();
      if (stat.isDirectory()) {
        if (await reparseInspector.isReparsePoint(absolute, signal ? { signal } : undefined) !== false) throw unsafe();
        await visit(absolute, childRelative);
      } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
        const measured = await hashFile(absolute, { candidateHashService, reparseInspector, signal, expectedStat: stat });
        total += BigInt(measured.size);
        const ownership = roleAndPolicy(childRelative);
        entries.push({
          path: childRelative.replaceAll('\\', '/'),
          pathKey: key,
          ...ownership,
          installedHash: measured.sha256,
          size: measured.size,
          priorBaseline: null
        });
      } else {
        throw unsafe();
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.pathKey.localeCompare(right.pathKey, 'en-US'));
  return {
    manifest: deepFreeze({ schemaVersion: 1, installationId, entries }),
    totalBytes: total.toString()
  };
}

async function scanManifest(root, installationId, dependencies = {}) {
  return withCandidateHashService(dependencies.candidateHashService, candidateHashService =>
    scanManifestWithService(root, installationId, { ...dependencies, candidateHashService }));
}

function runtimeFor(classification) {
  try {
    return normalizeRuntimeTuple({
      ...classification.runtime,
      javaMajor: getRequiredJavaVersion(classification.runtime.minecraftVersion),
      os: 'win32',
      architecture: 'x64'
    });
  } catch {
    throw new ModpackError('RUNTIME_INCOMPLETE', 'The archive does not contain one complete exact runtime');
  }
}

function guidedRuntimeChoice(value, { allowLegacyFabricProfile = false } = {}) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(value).sort().join(',') !== 'loaderFamily,loaderVersion,minecraftVersion') throw invalid();
  try {
    const runtime = normalizeRuntimeTuple({
      minecraftVersion: value.minecraftVersion,
      loaderFamily: value.loaderFamily,
      loaderVersion: value.loaderVersion,
      javaMajor: getRequiredJavaVersion(value.minecraftVersion),
      os: 'win32',
      architecture: 'x64'
    });
    const legacyProfile = allowLegacyFabricProfile && runtime.loaderFamily === 'fabric'
      ? new RegExp(`^${runtime.minecraftVersion.replaceAll('.', '\\.') }\\+build\\.\\d+_yarn-(\\d+(?:\\.\\d+)+\\+build\\.\\d+)$`).exec(runtime.loaderVersion)
      : null;
    // Old Fabric installer bundles used a profile-and-mappings token. The
    // hardened installer accepts the captured Fabric Loader component only.
    return legacyProfile ? { ...runtime, loaderVersion: legacyProfile[1] } : runtime;
  } catch (error) {
    throw invalid(error);
  }
}

function selectedArchiveRoot(result, value) {
  if (value === null || value === undefined) return result.selectedRoot || null;
  if (typeof value !== 'string' || !Array.isArray(result.rootCandidates) ||
      !result.rootCandidates.includes(value)) throw invalid();
  return value;
}

function archiveClassificationEntries(value) {
  if (!Array.isArray(value)) throw invalid();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        !['file', 'directory'].includes(entry.type) ||
        typeof entry.size !== 'string') throw invalid();
    const entryName = typeof entry.entryName === 'string' ? entry.entryName : entry.path;
    if (typeof entryName !== 'string' ||
        (typeof entry.path === 'string' && typeof entry.entryName === 'string' && entry.path !== entry.entryName)) {
      throw invalid();
    }
    return { path: entryName, type: entry.type, size: entry.size };
  });
}

function blockedAlwaysClassification(classification) {
  if (classification?.kind === 'mrpack-client-only' || classification?.kind === 'multimc-client-only') {
    throw new ModpackError('CLIENT_ONLY_PACK', 'The selected archive does not provide a supported server payload');
  }
  if (classification?.kind === 'backup-archive') {
    throw new ModpackError('UNSUPPORTED_ARCHIVE', 'Minecraft Core backups must be opened through the restore workflow');
  }
}

function blockedManagedRuntimeClassification(classification) {
  if (classification?.kind === 'unsupported-runtime-layout') {
    throw new ModpackError('UNSUPPORTED_ARCHIVE', 'The archive depends on an unsupported custom runtime layout');
  }
}

async function readExtractedEvidence(root, entryName, { maxBytes } = {}, reparseInspector, signal) {
  cancellation(signal);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw invalid();
  const source = resolveRelative(root, entryName);
  const stat = await fsp.lstat(source, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || BigInt(stat.nlink) !== 1n || stat.size > BigInt(maxBytes) ||
      await reparseInspector.isReparsePoint(source, signal ? { signal } : undefined) !== false) throw unsafe();
  const bytes = await fsp.readFile(source);
  if (BigInt(bytes.length) !== stat.size) throw unsafe();
  return bytes;
}

class ProductionCandidatePreparer {
  constructor({
    workspaceRegistry, archiveExtractor, artifactDownloader, artifactCache, candidateHashService = null,
    reparseInspector, randomUUID
  } = {}) {
    if (!workspaceRegistry || typeof workspaceRegistry.createStagingOutput !== 'function' ||
        typeof workspaceRegistry.resolveOwnedWorkspace !== 'function' ||
        !archiveExtractor || typeof archiveExtractor.extractArchive !== 'function' ||
        !artifactDownloader || typeof artifactDownloader.downloadPart !== 'function' ||
        !artifactCache || typeof artifactCache.pathForSha256 !== 'function' ||
        (candidateHashService !== null && !validCandidateHashService(candidateHashService)) ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        typeof randomUUID !== 'function') throw invalid();
    this.workspaceRegistry = workspaceRegistry;
    this.archiveExtractor = archiveExtractor;
    this.artifactDownloader = artifactDownloader;
    this.artifactCache = artifactCache;
    this.candidateHashService = candidateHashService || new PersistentCandidateHashService();
    this.ownsCandidateHashService = candidateHashService === null;
    this.reparseInspector = reparseInspector;
    this.randomUUID = randomUUID;
  }

  async preparePlanInputs({
    inspection,
    operationKind = 'install',
    selections,
    signal,
    onProgress,
    currentState = null,
    liveSnapshot = null
  } = {}) {
    try {
    if (!inspection || typeof inspection.inspectionId !== 'string' || !inspection.result?.classification) throw invalid();
    const reportProgress = candidateProgressReporter(onProgress);
    blockedAlwaysClassification(inspection.result.classification);
    const ownerId = inspection.inspectionId;
    const rawOutputId = this.workspaceRegistry.createStagingOutput({ ownerId });
    reportProgress({ activity: 'extracting' });
    await this.archiveExtractor.extractArchive({
      inspectionId: ownerId,
      destinationId: rawOutputId,
      signal,
      onProgress: progress => {
        if (progress?.phase === 'postwalk') reportProgress({ activity: 'verifying-archive' });
      }
    });
    reportProgress({ activity: 'verifying-archive' });
    const rawOutput = this.workspaceRegistry.resolveOwnedWorkspace({ ownerId, id: rawOutputId, kind: 'output' }).path;
    const selectedRoot = selectedArchiveRoot(inspection.result, selections?.selectedRoot);
    let classification = inspection.result.classification;
    if (selections?.selectedRoot !== null && selections?.selectedRoot !== undefined) {
      classification = await classifyArchive({
        entries: archiveClassificationEntries(inspection.result.entries),
        selectedRoot,
        readEntry: (entryName, options) => readExtractedEvidence(
          rawOutput, entryName, options, this.reparseInspector, signal
        )
      });
    }
    const runtimeChoice = guidedRuntimeChoice(selections?.runtimeChoice, {
      allowLegacyFabricProfile: classification?.kind === 'loader-installer-bundle'
    });
    const filesOnly = operationKind === 'files-only';
    const repair = operationKind === 'repair' ? createRepairContext(currentState, liveSnapshot) : null;
    blockedAlwaysClassification(classification);
    if (filesOnly) {
      classification = deepFreeze({
        kind: 'files-only', confidence: 'exact', blocked: false,
        evidence: Array.isArray(classification?.evidence) ? classification.evidence : []
      });
    } else {
      blockedManagedRuntimeClassification(classification);
      if (runtimeChoice !== null) {
        if (!['prepared-server-pack', 'loader-installer-bundle', 'ambiguous-or-unknown'].includes(classification?.kind)) throw invalid();
        classification = deepFreeze({
          kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
          runtime: runtimeChoice,
          evidence: Array.isArray(classification?.evidence) ? classification.evidence : []
        });
      } else if (classification?.blocked === true) {
        throw new ModpackError('RUNTIME_INCOMPLETE', 'The archive requires one reviewed root and exact runtime choice');
      }
    }
    const root = selectedRoot ? resolveRelative(rawOutput, selectedRoot) : rawOutput;
    const rootStat = await fsp.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        await this.reparseInspector.isReparsePoint(root, signal ? { signal } : undefined) !== false) throw unsafe();
    const templateOutputId = this.workspaceRegistry.createStagingOutput({ ownerId });
    const templatePath = this.workspaceRegistry.resolveOwnedWorkspace({
      ownerId, id: templateOutputId, kind: 'output'
    }).path;
    const runtime = filesOnly ? null : (runtimeChoice || runtimeFor(classification));
    const installationId = `installation-${String(this.randomUUID())}`;
    const accumulated = createManifestAccumulator(templatePath);

    if (classification.kind === 'mrpack-server') {
      const manifestPath = path.join(root, 'modrinth.index.json');
      const bytes = await fsp.readFile(manifestPath);
      if (bytes.length > MRPACK_MANIFEST_MAX_BYTES) throw invalid();
      const manifest = parseMrpackManifest(bytes);
      const archiveEntries = inspection.result.entries.map(entry => ({
        path: stripRoot(entry.entryName, selectedRoot),
        type: entry.type,
        ...(entry.size === undefined ? {} : { size: Number(entry.size) })
      })).filter(entry => entry.path);
      const packPlan = buildMrpackServerPlan({
        manifest,
        selectedOptionalFiles: resolveOptionalFileChoiceIds(manifest, selections.optionalFileIds),
        archiveEntries
      });
      if (JSON.stringify(packPlan.runtime) !== JSON.stringify(classification.runtime)) throw invalid();
      const selectedDownloads = packPlan.downloads.filter(item => item.selected &&
        (!repair || repair.shouldMaterialize(item.targetPath)));
      const selectedOverrides = packPlan.finalOverrides.filter(item =>
        !repair || repair.shouldMaterialize(item.targetPath));
      const downloadTotalBytes = selectedDownloads.reduce((total, item) => total + BigInt(item.size), 0n);
      const overrideSizesKnown = selectedOverrides.every(item =>
        typeof item.size === 'string' && /^(?:0|[1-9]\d*)$/u.test(item.size));
      const assemblyTotalItems = selectedDownloads.length + selectedOverrides.length;
      const assemblyTotalBytes = overrideSizesKnown
        ? downloadTotalBytes + selectedOverrides.reduce((total, item) => total + BigInt(item.size), 0n)
        : null;
      const determinateAssembly = assemblyTotalItems <= Number.MAX_SAFE_INTEGER &&
        assemblyTotalBytes !== null && assemblyTotalBytes <= BigInt(Number.MAX_SAFE_INTEGER);
      let assembledItems = 0;
      let assembledBytes = 0n;
      let assemblyStarted = false;
      const assemblyProgress = () => {
        if (!assemblyStarted) assemblyStarted = true;
        reportProgress(determinateAssembly ? {
          activity: 'assembling-files', completedItems: assembledItems, totalItems: assemblyTotalItems,
          processedBytes: Number(assembledBytes), totalBytes: Number(assemblyTotalBytes)
        } : { activity: 'assembling-files' });
      };
      const recordAssembled = (destination, measured) => {
        accumulated.add(destination, measured);
        assembledItems += 1;
        assembledBytes += BigInt(measured.size);
        assemblyProgress();
      };
      let downloadedBytes = 0n;
      if (selectedDownloads.length > 0) {
        reportProgress({
          activity: 'downloading-pack-files', completedItems: 0, totalItems: selectedDownloads.length,
          processedBytes: 0, totalBytes: Number(downloadTotalBytes)
        });
      }
      for (const directory of packPlan.finalDirectories) {
        await fsp.mkdir(resolveRelative(templatePath, directory.targetPath), { recursive: true });
      }
      for (const [index, download] of selectedDownloads.entries()) {
        cancellation(signal);
        reportProgress({
          activity: 'downloading-pack-files', completedItems: index, totalItems: selectedDownloads.length,
          processedBytes: Number(downloadedBytes), totalBytes: Number(downloadTotalBytes)
        });
        const verified = await this.artifactDownloader.downloadPart(download, {
          signal,
          onProgress: progress => {
            let partBytes;
            try { partBytes = BigInt(String(progress?.partBytes ?? progress?.setBytes ?? '0')); }
            catch { return; }
            if (partBytes < 0n || partBytes > BigInt(download.size)) return;
            reportProgress({
              activity: 'downloading-pack-files', completedItems: index, totalItems: selectedDownloads.length,
              processedBytes: Number(downloadedBytes + partBytes), totalBytes: Number(downloadTotalBytes)
            });
          }
        });
        downloadedBytes += BigInt(download.size);
        reportProgress({
          activity: 'downloading-pack-files', completedItems: index + 1, totalItems: selectedDownloads.length,
          processedBytes: Number(downloadedBytes), totalBytes: Number(downloadTotalBytes)
        });
        if (!assemblyStarted) assemblyProgress();
        const cachePath = this.artifactCache.pathForSha256(verified.sha256);
        const destination = resolveRelative(templatePath, download.targetPath);
        const measured = await copyRegularFile(cachePath, destination, {
          candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal
        });
        recordAssembled(destination, measured);
      }
      if (!assemblyStarted) assemblyProgress();
      for (const override of selectedOverrides) {
        const destination = resolveRelative(templatePath, override.targetPath);
        const measured = await copyRegularFile(resolveRelative(root, override.archivePath), destination, {
          candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal, replace: true
        });
        recordAssembled(destination, measured);
      }
      if (assembledItems !== assemblyTotalItems ||
          (assemblyTotalBytes !== null && assembledBytes !== assemblyTotalBytes)) throw unsafe();
    } else if (classification.kind === 'prepared-server-pack' || classification.kind === 'loader-installer-bundle' ||
        classification.kind === 'files-only') {
      const assemblyTotals = preparedPayloadTotals(inspection.result.entries, selectedRoot);
      let assembledItems = 0;
      let assembledBytes = 0;
      const recordAssembled = (filePath, measured) => {
        accumulated.add(filePath, measured);
        if (!assemblyTotals) return;
        assembledItems += 1;
        assembledBytes += Number(measured.size);
        reportProgress({
          activity: 'assembling-files', completedItems: assembledItems, totalItems: assemblyTotals.totalItems,
          processedBytes: assembledBytes, totalBytes: assemblyTotals.totalBytes
        });
      };
      reportProgress(assemblyTotals ? {
        activity: 'assembling-files', completedItems: 0, totalItems: assemblyTotals.totalItems,
        processedBytes: 0, totalBytes: assemblyTotals.totalBytes
      } : { activity: 'assembling-files' });
      const children = await fsp.readdir(root, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
      for (const child of children) {
        const key = child.name.toLocaleLowerCase('en-US');
        if (SAFE_PREPARED_ROOTS.has(key) && child.isDirectory()) {
          const destination = resolveRelative(templatePath, child.name);
          await fsp.mkdir(destination, { recursive: true });
          await copyTree(path.join(root, child.name), destination, {
            candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal,
            onCopied: recordAssembled
          });
        } else if (SAFE_PREPARED_FILES.has(key) && child.isFile()) {
          const destination = resolveRelative(templatePath, child.name);
          const measured = await copyRegularFile(path.join(root, child.name), destination, {
            candidateHashService: this.candidateHashService, reparseInspector: this.reparseInspector, signal
          });
          recordAssembled(destination, measured);
        }
      }
      if (assemblyTotals && (assembledItems !== assemblyTotals.totalItems || assembledBytes !== assemblyTotals.totalBytes)) throw unsafe();
    } else {
      throw new ModpackError('RUNTIME_INCOMPLETE', 'The archive is not a supported server pack');
    }

    const scanned = accumulated.finish(installationId);
    const incomingManifest = repair
      ? repair.desiredManifest(installationId)
      : scanned.manifest;
    if (repair) repair.verifyPayload(scanned.manifest);
    return deepFreeze({
      runtime,
      runtimeChoice: runtimeChoice === null ? null : {
        minecraftVersion: runtime.minecraftVersion,
        loaderFamily: runtime.loaderFamily,
        loaderVersion: runtime.loaderVersion
      },
      incomingManifest,
      candidateBytes: scanned.totalBytes,
      inspectionResult: {
        ...inspection.result,
        selectedRoot,
        classification
      },
      execution: {
        classificationKind: classification.kind,
        templateOutputId,
        ...(repair ? { repairPayloadManifest: scanned.manifest } : {})
      }
    });
    } catch (error) {
      throw preparationFailure(error, signal);
    }
  }

  async dispose() {
    if (!this.ownsCandidateHashService) return;
    this.ownsCandidateHashService = false;
    await this.candidateHashService.dispose();
  }
}

module.exports = {
  ProductionCandidatePreparer,
  copyRegularFile,
  copyTree,
  roleAndPolicy,
  scanManifest
};
