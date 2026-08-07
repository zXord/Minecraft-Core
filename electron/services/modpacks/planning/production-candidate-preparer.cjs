const crypto = require('node:crypto');
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

const SAFE_PREPARED_ROOTS = new Set([
  'config', 'defaultconfigs', 'kubejs', 'mods', 'resourcepacks', 'resources', 'scripts',
  'shaderpacks', 'world', 'world_nether', 'world_the_end'
]);
const SAFE_PREPARED_FILES = new Set(['server.properties', 'server-icon.png']);
const FORBIDDEN_FILE = /\.(?:bat|cmd|com|exe|msi|ps1|sh|vbs|wsf|scr|dll)$/iu;

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
  if (['config', 'defaultconfigs', 'kubejs', 'scripts'].includes(first)) {
    return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'configuration' };
  }
  if (first === 'resourcepacks' || first === 'resources') {
    return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'resource' };
  }
  if (first === 'shaderpacks') return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'shader' };
  return { origin: 'pack', managementPolicy: 'replaceable-managed', role: 'other' };
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
  const isRepairManaged = entry => ['pack', 'runtime'].includes(entry?.origin) &&
    entry.managementPolicy === 'replaceable-managed';
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

async function hashFile(filePath) {
  const handle = await fsp.open(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0n;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += BigInt(bytesRead);
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), size: size.toString() };
}

async function copyRegularFile(source, destination, { reparseInspector, signal, replace = false }) {
  cancellation(signal);
  const before = await fsp.lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || BigInt(before.nlink) !== 1n ||
      await reparseInspector.isReparsePoint(source, signal ? { signal } : undefined) !== false) throw unsafe();
  if (FORBIDDEN_FILE.test(path.basename(destination))) throw unsafe();
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination, replace ? 0 : fs.constants.COPYFILE_EXCL);
  const [sourceHash, targetHash] = await Promise.all([hashFile(source), hashFile(destination)]);
  if (JSON.stringify(sourceHash) !== JSON.stringify(targetHash)) throw unsafe();
  const after = await fsp.lstat(source, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.birthtimeNs !== before.birthtimeNs ||
      after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw unsafe();
  return targetHash;
}

async function copyTree(source, destination, dependencies, relative = '') {
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
      await fsp.mkdir(destinationChild, { recursive: true });
      await copyTree(sourceChild, destination, dependencies, relativeChild);
    } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
      await copyRegularFile(sourceChild, destinationChild, dependencies);
    } else {
      throw unsafe();
    }
  }
}

async function scanManifest(root, installationId, { reparseInspector, signal }) {
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
      if (stat.isSymbolicLink() || await reparseInspector.isReparsePoint(absolute, signal ? { signal } : undefined) !== false) throw unsafe();
      if (stat.isDirectory()) {
        await visit(absolute, childRelative);
      } else if (stat.isFile() && BigInt(stat.nlink) === 1n) {
        const measured = await hashFile(absolute);
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
  return {
    manifest: deepFreeze({ schemaVersion: 1, installationId, entries }),
    totalBytes: total.toString()
  };
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

function guidedRuntimeChoice(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(value).sort().join(',') !== 'loaderFamily,loaderVersion,minecraftVersion') throw invalid();
  try {
    return normalizeRuntimeTuple({
      minecraftVersion: value.minecraftVersion,
      loaderFamily: value.loaderFamily,
      loaderVersion: value.loaderVersion,
      javaMajor: getRequiredJavaVersion(value.minecraftVersion),
      os: 'win32',
      architecture: 'x64'
    });
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

function blockedClassification(classification) {
  if (classification?.kind === 'mrpack-client-only') {
    throw new ModpackError('CLIENT_ONLY_PACK', 'The selected archive does not provide a supported server payload');
  }
  if (classification?.kind === 'backup-archive') {
    throw new ModpackError('UNSUPPORTED_ARCHIVE', 'Minecraft Core backups must be opened through the restore workflow');
  }
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
  constructor({ workspaceRegistry, archiveExtractor, artifactDownloader, artifactCache, reparseInspector, randomUUID } = {}) {
    if (!workspaceRegistry || typeof workspaceRegistry.createStagingOutput !== 'function' ||
        typeof workspaceRegistry.resolveOwnedWorkspace !== 'function' ||
        !archiveExtractor || typeof archiveExtractor.extractArchive !== 'function' ||
        !artifactDownloader || typeof artifactDownloader.downloadPart !== 'function' ||
        !artifactCache || typeof artifactCache.pathForSha256 !== 'function' ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' ||
        typeof randomUUID !== 'function') throw invalid();
    this.workspaceRegistry = workspaceRegistry;
    this.archiveExtractor = archiveExtractor;
    this.artifactDownloader = artifactDownloader;
    this.artifactCache = artifactCache;
    this.reparseInspector = reparseInspector;
    this.randomUUID = randomUUID;
  }

  async preparePlanInputs({
    inspection,
    operationKind = 'install',
    selections,
    signal,
    currentState = null,
    liveSnapshot = null
  } = {}) {
    if (!inspection || typeof inspection.inspectionId !== 'string' || !inspection.result?.classification) throw invalid();
    const ownerId = inspection.inspectionId;
    const rawOutputId = this.workspaceRegistry.createStagingOutput({ ownerId });
    await this.archiveExtractor.extractArchive({ inspectionId: ownerId, destinationId: rawOutputId, signal });
    const rawOutput = this.workspaceRegistry.resolveOwnedWorkspace({ ownerId, id: rawOutputId, kind: 'output' }).path;
    const selectedRoot = selectedArchiveRoot(inspection.result, selections?.selectedRoot);
    let classification = inspection.result.classification;
    if (selections?.selectedRoot !== null && selections?.selectedRoot !== undefined) {
      classification = await classifyArchive({
        entries: inspection.result.entries,
        selectedRoot,
        readEntry: (entryName, options) => readExtractedEvidence(
          rawOutput, entryName, options, this.reparseInspector, signal
        )
      });
    }
    const runtimeChoice = guidedRuntimeChoice(selections?.runtimeChoice);
    const filesOnly = operationKind === 'files-only';
    const repair = operationKind === 'repair' ? createRepairContext(currentState, liveSnapshot) : null;
    blockedClassification(classification);
    if (filesOnly) {
      classification = deepFreeze({
        kind: 'files-only', confidence: 'exact', blocked: false,
        evidence: Array.isArray(classification?.evidence) ? classification.evidence : []
      });
    } else if (runtimeChoice !== null) {
      if (!['prepared-server-pack', 'loader-installer-bundle', 'ambiguous-or-unknown'].includes(classification?.kind)) throw invalid();
      classification = deepFreeze({
        kind: 'prepared-server-pack', confidence: 'exact', blocked: false,
        runtime: runtimeChoice,
        evidence: Array.isArray(classification?.evidence) ? classification.evidence : []
      });
    } else if (classification?.blocked === true) {
      throw new ModpackError('RUNTIME_INCOMPLETE', 'The archive requires one reviewed root and exact runtime choice');
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

    if (classification.kind === 'mrpack-server') {
      const manifestPath = path.join(root, 'modrinth.index.json');
      const bytes = await fsp.readFile(manifestPath);
      if (bytes.length > MRPACK_MANIFEST_MAX_BYTES) throw invalid();
      const manifest = parseMrpackManifest(bytes);
      const archiveEntries = inspection.result.entries.map(entry => ({
        path: stripRoot(entry.path, selectedRoot), type: entry.type
      })).filter(entry => entry.path);
      const packPlan = buildMrpackServerPlan({
        manifest,
        selectedOptionalFiles: resolveOptionalFileChoiceIds(manifest, selections.optionalFileIds),
        archiveEntries
      });
      if (JSON.stringify(packPlan.runtime) !== JSON.stringify(classification.runtime)) throw invalid();
      for (const directory of packPlan.finalDirectories) {
        await fsp.mkdir(resolveRelative(templatePath, directory.targetPath), { recursive: true });
      }
      for (const download of packPlan.downloads.filter(item => item.selected &&
        (!repair || repair.shouldMaterialize(item.targetPath)))) {
        cancellation(signal);
        const verified = await this.artifactDownloader.downloadPart(download, { signal });
        const cachePath = this.artifactCache.pathForSha256(verified.sha256);
        await copyRegularFile(cachePath, resolveRelative(templatePath, download.targetPath), {
          reparseInspector: this.reparseInspector, signal
        });
      }
      for (const override of packPlan.finalOverrides.filter(item => !repair || repair.shouldMaterialize(item.targetPath))) {
        await copyRegularFile(resolveRelative(root, override.archivePath), resolveRelative(templatePath, override.targetPath), {
          reparseInspector: this.reparseInspector, signal, replace: true
        });
      }
    } else if (classification.kind === 'prepared-server-pack' || classification.kind === 'loader-installer-bundle' ||
        classification.kind === 'files-only') {
      const children = await fsp.readdir(root, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
      for (const child of children) {
        const key = child.name.toLocaleLowerCase('en-US');
        if (SAFE_PREPARED_ROOTS.has(key) && child.isDirectory()) {
          const destination = resolveRelative(templatePath, child.name);
          await fsp.mkdir(destination, { recursive: true });
          await copyTree(path.join(root, child.name), destination, {
            reparseInspector: this.reparseInspector, signal
          });
        } else if (SAFE_PREPARED_FILES.has(key) && child.isFile()) {
          await copyRegularFile(path.join(root, child.name), resolveRelative(templatePath, child.name), {
            reparseInspector: this.reparseInspector, signal
          });
        }
      }
    } else {
      throw new ModpackError('RUNTIME_INCOMPLETE', 'The archive is not a supported server pack');
    }

    const installationId = `installation-${String(this.randomUUID())}`;
    const scanned = await scanManifest(templatePath, installationId, {
      reparseInspector: this.reparseInspector,
      signal
    });
    const incomingManifest = repair
      ? repair.desiredManifest(installationId)
      : scanned.manifest;
    if (repair) repair.verifyPayload(scanned.manifest);
    return deepFreeze({
      runtime,
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
  }
}

module.exports = {
  ProductionCandidatePreparer,
  copyRegularFile,
  copyTree,
  roleAndPolicy,
  scanManifest
};
