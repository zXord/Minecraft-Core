const fsp = require('node:fs/promises');
const path = require('node:path');
const { ARCHIVE_LIMITS, computePreflightReserve } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { canonicalWindowsArchivePath, validateArchiveEntries } = require('./archive-entry-policy.cjs');
const { ArchiveInputMaterializer } = require('./archive-input-materializer.cjs');

const IDENTIFIER = /^(?:inspection|output)-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Archive extraction request is invalid', {
    details: field ? { field } : undefined
  });
}

function stale() {
  return new ModpackError('PLAN_STALE', 'Archive extraction references are stale');
}

function failed(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('EXTRACTOR_FAILED', 'Archive extraction failed', { cause });
}

function cancelled() {
  return new ModpackError('CANCELLED', 'Archive extraction was cancelled');
}

function unsafe() {
  return new ModpackError('UNSAFE_ARCHIVE_ENTRY', 'Archive extraction produced an unsafe entry', {
    details: { reasonCode: 'non-regular-entry' }
  });
}

function insufficient(requiredBytes, availableBytes) {
  return new ModpackError('INSUFFICIENT_DISK', 'There is not enough free space to extract this archive', {
    details: { requiredBytes: String(requiredBytes), availableBytes: String(availableBytes) }
  });
}

function limitExceeded(limit, actual) {
  return new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Archive extraction exceeded a configured safety limit', {
    details: { limit, actual: String(actual) }
  });
}

function cleanupFailed(cause) {
  return new ModpackError('CLEANUP_FAILED', 'Archive staging cleanup failed', { cause });
}

function assertSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') invalid('signal');
}

function emitProgress(callback, phase) {
  if (callback === undefined) return;
  if (typeof callback !== 'function') invalid('onProgress');
  try { callback(deepFreeze({ phase })); }
  catch (error) { throw failed(error); }
}

function parseBytes(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw stale();
  try { return BigInt(value); } catch { throw stale(); }
}

function familyFor(result) {
  const concrete = result?.engineEvidence?.concreteFamily;
  if (concrete !== undefined) {
    if (!['zip', 'rar4', 'rar5'].includes(concrete)) throw stale();
    const compatible = concrete === 'zip'
      ? result.archiveFamily === 'zip' || result.archiveFamily === 'mrpack'
      : result.archiveFamily === concrete || result.archiveFamily === 'multipart-rar';
    const publicFamily = concrete === 'zip' ? 'zip' : 'rar';
    if (!compatible || result.engineEvidence.family !== publicFamily) throw stale();
    return concrete;
  }
  if ((result?.archiveFamily === 'zip' || result?.archiveFamily === 'mrpack') && result.engineEvidence.family === 'zip') return 'zip';
  if ((result?.archiveFamily === 'rar4' || result?.archiveFamily === 'rar5') && result.engineEvidence.family === 'rar') return result.archiveFamily;
  throw stale();
}

function expectedRootEvidence(entries) {
  const candidateNames = new Map();
  let rootFile = false;
  let nested = false;
  for (const entry of entries) {
    const components = entry.entryName.split('/');
    if (components.length === 1) {
      if (entry.type === 'file') rootFile = true;
      else candidateNames.set(entry.canonicalName, entry.entryName);
      continue;
    }
    nested = true;
    candidateNames.set(components[0].normalize('NFC').toLocaleLowerCase('en-US'), components[0].normalize('NFC'));
  }
  const rootCandidates = [...candidateNames.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([, name]) => name);
  return {
    rootCandidates,
    selectedRoot: !rootFile && nested && rootCandidates.length === 1 ? rootCandidates[0] : null
  };
}

function validateInspection(result) {
  const integrityEvidence = result?.integrity === 'tested'
    ? result?.engineEvidence?.tested === true
    : result?.integrity === 'deferred-to-extraction' && result?.engineEvidence?.tested === false;
  if (!result || result.type !== 'archive-inspection' || !integrityEvidence ||
      result.artifactSet?.completeness !== 'verified-complete-set' ||
      result.engineEvidence?.version !== '26.02' ||
      !Array.isArray(result.entries) || !result.limitEvidence || !result.limitEvidence.totals) throw stale();
  const expected = new Map();
  const policyInput = [];
  for (const entry of result.entries) {
    if (!entry || !['file', 'directory'].includes(entry.type) || typeof entry.entryName !== 'string' ||
        typeof entry.canonicalName !== 'string' || !Number.isSafeInteger(entry.depth) || entry.depth < 1) throw stale();
    let canonical;
    try { canonical = canonicalWindowsArchivePath(entry.entryName); } catch { throw stale(); }
    if (canonical !== entry.canonicalName || expected.has(canonical)) throw stale();
    const size = parseBytes(entry.size);
    const packedSize = parseBytes(entry.packedSize);
    if (entry.type === 'directory' && size !== 0n) throw stale();
    expected.set(canonical, { ...entry, sizeValue: size });
    policyInput.push({
      path: entry.entryName,
      type: entry.type,
      size: entry.size,
      packedSize: entry.packedSize,
      encrypted: false,
      attributes: '',
      ...(entry.method === undefined ? {} : { method: entry.method }),
      ...(entry.volumeIndex === undefined ? {} : { volumeIndex: entry.volumeIndex })
    });
  }
  let policy;
  try { policy = validateArchiveEntries(policyInput, ARCHIVE_LIMITS); }
  catch { throw stale(); }
  const totals = result.limitEvidence.totals;
  const roots = expectedRootEvidence(result.entries);
  const expectedTotalKeys = ['entryCount', 'fileCount', 'directoryCount', 'expandedBytes', 'packedBytes', 'maximumDepth', 'maximumPathLength'];
  if (result.limitEvidence.policyVersion !== ARCHIVE_LIMITS.version ||
      !Array.isArray(result.rootCandidates) || result.rootCandidates.length !== roots.rootCandidates.length ||
      result.rootCandidates.some((candidate, index) => candidate !== roots.rootCandidates[index]) ||
      result.selectedRoot !== roots.selectedRoot ||
      Object.keys(totals).length !== expectedTotalKeys.length ||
      expectedTotalKeys.some(key => !Object.hasOwn(totals, key) || totals[key] !== policy.totals[key]) ||
      policy.entries.some((entry, index) => entry.canonicalPath !== result.entries[index].canonicalName ||
        entry.depth !== result.entries[index].depth ||
        (result.entries[index].nameLength !== undefined && entry.pathLength !== result.entries[index].nameLength))) throw stale();
  return { expected, expandedBytes: BigInt(policy.totals.expandedBytes), archiveFamily: familyFor(result) };
}

async function defaultDiskProbe(candidate) {
  const stats = await fsp.statfs(candidate);
  return { availableBytes: (BigInt(stats.bavail) * BigInt(stats.bsize)).toString() };
}

async function defaultRemoveStaging(candidate) {
  await fsp.rm(candidate, { recursive: true, force: true });
}

async function removeAuthorizedOutput(removeStaging, workspaceRoot, output) {
  const resolved = path.resolve(output);
  if (path.dirname(resolved) !== workspaceRoot) throw cleanupFailed();
  try {
    await removeStaging(resolved);
    try {
      await fsp.lstat(resolved);
      throw new Error('Staging output remains');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    throw cleanupFailed(error);
  }
}

function availableBytes(probe) {
  const value = probe?.availableBytes;
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error('Invalid disk probe');
  return BigInt(value);
}

function controlledOutput(workspaceRoot, destinationId) {
  if (typeof destinationId !== 'string' || !IDENTIFIER.test(destinationId) || !destinationId.startsWith('output-')) invalid('destinationId');
  const root = path.resolve(workspaceRoot);
  const output = path.resolve(root, destinationId);
  if (path.dirname(output) !== root) invalid('destinationId');
  return output;
}

async function assertDirectory(candidate, reparseInspector) {
  let stat;
  try { stat = await fsp.lstat(candidate); } catch (error) { throw stale(error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
  try { if (await reparseInspector.isReparsePoint(candidate)) throw unsafe(); }
  catch (error) { throw failed(error); }
}

function implicitDirectories(expected) {
  const implicit = new Set();
  for (const entry of expected.values()) {
    const parts = entry.canonicalName.split('/');
    for (let index = 1; index < parts.length; index += 1) implicit.add(parts.slice(0, index).join('/'));
  }
  return implicit;
}

async function scanOutput({ output, expected, reparseInspector, final }) {
  await assertDirectory(output, reparseInspector);
  let realOutput;
  try { realOutput = await fsp.realpath(output); }
  catch (error) { throw failed(error); }
  const implicit = implicitDirectories(expected);
  const observed = new Map();
  const stack = [{ absolute: output, relative: '' }];
  let fileCount = 0;
  let directoryCount = 0;
  let expandedBytes = 0n;
  while (stack.length) {
    const current = stack.pop();
    let children;
    try { children = await fsp.readdir(current.absolute, { withFileTypes: true }); }
    catch (error) { throw failed(error); }
    for (const child of children) {
      const absolute = path.resolve(current.absolute, child.name);
      const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
      const containment = path.relative(output, absolute);
      if (!containment || containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) throw unsafe();
      let canonical;
      try { canonical = canonicalWindowsArchivePath(relative); } catch { throw unsafe(); }
      if (observed.has(canonical)) throw new ModpackError('ARCHIVE_ENTRY_COLLISION', 'Archive extraction produced conflicting entries', {
        details: { reasonCode: 'normalized-path-collision' }
      });
      let stat;
      try { stat = await fsp.lstat(absolute); } catch (error) { throw failed(error); }
      if (stat.isSymbolicLink()) throw unsafe();
      try { if (await reparseInspector.isReparsePoint(absolute)) throw unsafe(); }
      catch (error) { throw failed(error); }
      let realAbsolute;
      try { realAbsolute = await fsp.realpath(absolute); } catch (error) { throw failed(error); }
      const realContainment = path.relative(realOutput, realAbsolute);
      if (!realContainment || realContainment === '..' || realContainment.startsWith(`..${path.sep}`) || path.isAbsolute(realContainment)) throw unsafe();
      if (stat.isDirectory() && child.isDirectory()) {
        const declared = expected.get(canonical);
        if (declared && declared.type !== 'directory') {
          if (final) throw failed();
          throw unsafe();
        }
        if (!declared && !implicit.has(canonical)) throw unsafe();
        observed.set(canonical, { type: 'directory', size: 0n });
        directoryCount += 1;
        stack.push({ absolute, relative });
      } else if (stat.isFile() && child.isFile()) {
        const declared = expected.get(canonical);
        if (declared && declared.type !== 'file') {
          if (final) throw failed();
          throw unsafe();
        }
        if (!declared) throw unsafe();
        const size = BigInt(stat.size);
        if (size > BigInt(ARCHIVE_LIMITS.maxFileExpandedBytes)) throw limitExceeded('maxFileExpandedBytes', size);
        if (size > declared.sizeValue) throw failed();
        if (final && size !== declared.sizeValue) throw failed();
        observed.set(canonical, { type: 'file', size });
        fileCount += 1;
        expandedBytes += size;
      } else {
        throw unsafe();
      }
      const entryCount = fileCount + directoryCount;
      if (entryCount > ARCHIVE_LIMITS.maxArchiveEntries) throw limitExceeded('maxArchiveEntries', entryCount);
      if (expandedBytes > BigInt(ARCHIVE_LIMITS.maxExpandedBytes)) throw limitExceeded('maxExpandedBytes', expandedBytes);
    }
  }
  if (final) {
    for (const [canonical, entry] of expected) {
      const actual = observed.get(canonical);
      if (!actual || actual.type !== entry.type || (entry.type === 'file' && actual.size !== entry.sizeValue)) throw failed();
    }
  }
  return {
    entryCount: fileCount + directoryCount,
    fileCount,
    directoryCount,
    expandedBytes
  };
}

function createWatchdog({ output, expected, plannedBytes, reserveBytes, diskProbe, reparseInspector, clock,
  intervalMs, controller, startedAt }) {
  let timer = null;
  let stopped = false;
  let running = null;
  let watchdogError = null;

  const inspect = async () => {
    if (stopped || watchdogError) return;
    try {
      const elapsed = clock() - startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > ARCHIVE_LIMITS.maxExtractionMs) throw failed();
      const measured = await scanOutput({ output, expected, reparseInspector, final: false });
      if (measured.expandedBytes > plannedBytes) throw failed();
      const remaining = plannedBytes > measured.expandedBytes ? plannedBytes - measured.expandedBytes : 0n;
      const available = availableBytes(await diskProbe(output));
      const required = remaining + reserveBytes;
      if (available < required) throw insufficient(required, available);
    } catch (error) {
      watchdogError = failed(error);
      controller.abort();
    }
  };

  const tick = () => {
    if (stopped || watchdogError) return;
    running = inspect().finally(() => {
      running = null;
      if (!stopped && !watchdogError) {
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      }
    });
  };
  timer = setTimeout(tick, intervalMs);
  timer.unref?.();

  return {
    error: () => watchdogError,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    }
  };
}

class ArchiveExtractor {
  constructor({ workspaceRegistry, workspaceRoot, workerClient, diskProbe = defaultDiskProbe,
    reparseInspector, clock = () => Date.now(), removeStaging = defaultRemoveStaging, watchdogIntervalMs = 250 } = {}) {
    if (!workspaceRegistry || typeof workspaceRegistry.resolveOwnedId !== 'function' ||
        typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) ||
        !workerClient || typeof workerClient.run !== 'function' || typeof diskProbe !== 'function' ||
        !reparseInspector || typeof reparseInspector.isReparsePoint !== 'function' || typeof clock !== 'function' ||
        typeof removeStaging !== 'function' ||
        !Number.isSafeInteger(watchdogIntervalMs) || watchdogIntervalMs < 1 || watchdogIntervalMs > 60000) invalid('dependencies');
    this.workspaceRegistry = workspaceRegistry;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.workerClient = workerClient;
    this.diskProbe = diskProbe;
    this.reparseInspector = reparseInspector;
    this.clock = clock;
    this.removeStaging = removeStaging;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.materializer = new ArchiveInputMaterializer({ workspaceRegistry, workspaceRoot });
  }

  async extractArchive({ inspectionId, destinationId, signal, onProgress, preparationAttempt = null } = {}) {
    if (typeof inspectionId !== 'string' || !IDENTIFIER.test(inspectionId) || !inspectionId.startsWith('inspection-')) invalid('inspectionId');
    assertSignal(signal);
    if (onProgress !== undefined && typeof onProgress !== 'function') invalid('onProgress');
    if (signal?.aborted) throw cancelled();
    const output = controlledOutput(this.workspaceRoot, destinationId);
    let outputAuthorized = false;
    let succeeded = false;
    let context = null;
    let externalAbort = null;
    let watchdog = null;
    try {
      this.workspaceRegistry.resolveOwnedId({ ownerId: inspectionId, id: destinationId, kind: 'output' });
      outputAuthorized = true;
      await assertDirectory(output, this.reparseInspector);
      const loaded = this.materializer.loadInspection(inspectionId);
      const validated = validateInspection(loaded.result);

      emitProgress(onProgress, 'preflight');
      const reserveBytes = BigInt(computePreflightReserve(validated.expandedBytes.toString()));
      const requiredBytes = validated.expandedBytes + reserveBytes;
      const available = availableBytes(await this.diskProbe(output));
      if (available < requiredBytes) throw insufficient(requiredBytes, available);

      context = await this.materializer.rematerialize(inspectionId, preparationAttempt);
      const controller = new AbortController();
      externalAbort = () => controller.abort(signal.reason);
      if (signal?.aborted) externalAbort();
      else signal?.addEventListener('abort', externalAbort, { once: true });

      const startedAt = this.clock();
      if (!Number.isFinite(startedAt)) throw failed();
      watchdog = createWatchdog({
        output,
        expected: validated.expected,
        plannedBytes: validated.expandedBytes,
        reserveBytes,
        diskProbe: this.diskProbe,
        reparseInspector: this.reparseInspector,
        clock: this.clock,
        intervalMs: this.watchdogIntervalMs,
        controller,
        startedAt
      });

      emitProgress(onProgress, 'extract');
      let workerError = null;
      try {
        await this.workerClient.run({
          operation: 'extract',
          operationId: inspectionId,
          artifactSetId: context.artifactSetId,
          inputDirectoryId: context.inputDirectoryId,
          outputDirectoryId: destinationId,
          archiveFamily: validated.archiveFamily,
          limits: ARCHIVE_LIMITS
        }, { signal: controller.signal });
      } catch (error) {
        workerError = error;
      }
      await watchdog.stop();
      const watchdogError = watchdog.error();
      if (signal?.aborted) throw cancelled();
      if (watchdogError) throw watchdogError;
      if (workerError) throw failed(workerError);

      emitProgress(onProgress, 'postwalk');
      const measured = await scanOutput({
        output,
        expected: validated.expected,
        reparseInspector: this.reparseInspector,
        final: true
      });
      if (measured.expandedBytes !== validated.expandedBytes) throw failed();

      emitProgress(onProgress, 'complete');
      succeeded = true;
      return deepFreeze({
        type: 'verified-extraction',
        inspectionId,
        destinationId,
        measured: {
          entryCount: measured.entryCount,
          fileCount: measured.fileCount,
          directoryCount: measured.directoryCount,
          expandedBytes: measured.expandedBytes.toString()
        }
      });
    } catch (error) {
      if (watchdog) await watchdog.stop().catch(() => {});
      const failure = signal?.aborted ? cancelled() : failed(error);
      if (outputAuthorized && !succeeded) {
        await removeAuthorizedOutput(this.removeStaging, this.workspaceRoot, output);
      }
      throw failure;
    } finally {
      if (watchdog) await watchdog.stop().catch(() => {});
      if (externalAbort) signal?.removeEventListener('abort', externalAbort);
    }
  }
}

function createArchiveExtractor(dependencies) {
  return new ArchiveExtractor(dependencies);
}

async function extractArchive(request, dependencies) {
  if (!dependencies) invalid('dependencies');
  return createArchiveExtractor(dependencies).extractArchive(request);
}

module.exports = { ArchiveExtractor, createArchiveExtractor, extractArchive };
