const { PassThrough } = require('node:stream');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { ModpackError, deepFreeze } = require('../errors.cjs');
const { groupMultipartCandidates } = require('../artifacts/multipart-names.cjs');
const { detectArchiveFamily } = require('./archive-magic.cjs');
const { validateArchiveEntries } = require('./archive-entry-policy.cjs');
const { ArchiveInputMaterializer } = require('./archive-input-materializer.cjs');
const { classifyArchive } = require('./archive-classifier.cjs');
const { parseSevenZipTechnicalList } = require('./sevenzip-slt-parser.cjs');

const PASSWORD_DIAGNOSTIC = /(?:enter|wrong|incorrect|required).{0,64}password|password.{0,64}(?:required|incorrect|wrong)/i;
const MAX_TECHNICAL_BYTES = Number(ARCHIVE_LIMITS.maxTechnicalStdoutBytes);

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Archive inspection request is invalid', {
    details: field ? { field } : undefined
  });
}

function failed(cause) {
  if (cause instanceof ModpackError) return cause;
  return new ModpackError('EXTRACTOR_FAILED', 'Archive inspection failed', { cause });
}

function cancelled() {
  return new ModpackError('CANCELLED', 'Archive inspection was cancelled');
}

function multipartMissing(partId) {
  return new ModpackError('MULTIPART_VOLUME_MISSING', 'The multipart archive set could not be verified', {
    details: partId ? { partId } : undefined
  });
}

function familyMismatch(archiveFamily) {
  return new ModpackError('MAGIC_EXTENSION_MISMATCH', 'Archive content does not match its reviewed type', {
    details: { archiveFamily }
  });
}

function assertSignal(signal) {
  if (signal === undefined) return;
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') invalid('signal');
}

function linkedController(signal) {
  assertSignal(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    controller,
    close() { signal?.removeEventListener('abort', onAbort); }
  };
}

function emitProgress(callback, phase) {
  if (callback === undefined) return;
  if (typeof callback !== 'function') invalid('onProgress');
  try { Promise.resolve(callback(deepFreeze({ phase }))).catch(() => {}); }
  catch { /* inspection progress is best effort */ }
}

function concreteFamily(magic) {
  if (magic.signature === 'rar4') return 'rar4';
  if (magic.signature === 'rar5') return 'rar5';
  return 'zip';
}

function workerRequest(context, operation, archiveFamily, extra = {}) {
  return {
    operation,
    operationId: context.ownerId,
    artifactSetId: context.artifactSetId,
    inputDirectoryId: context.inputDirectoryId,
    archiveFamily,
    limits: ARCHIVE_LIMITS,
    ...extra
  };
}

function scanDiagnostic(frame) {
  if ((frame.type === 'stdout' || frame.type === 'stderr') && PASSWORD_DIAGNOSTIC.test(frame.text)) {
    throw new ModpackError('ENCRYPTED_ARCHIVE', 'Encrypted archives are not supported');
  }
}

async function listArchive(workerClient, context, archiveFamily, signal) {
  const output = new PassThrough({ highWaterMark: 64 * 1024 });
  const link = linkedController(signal);
  let parserFailure = null;
  let callbackFailure = null;
  const parser = parseSevenZipTechnicalList(output, { maxBytes: MAX_TECHNICAL_BYTES }).then(
    value => ({ value }),
    error => {
      parserFailure = error;
      link.controller.abort();
      return { error };
    }
  );
  try {
    await workerClient.run(workerRequest(context, 'list', archiveFamily), {
      signal: link.controller.signal,
      onFrame(frame) {
        try {
          scanDiagnostic(frame);
          if (frame.type === 'stdout') output.write(Buffer.from(frame.text, 'utf8'));
          else if (frame.type !== 'stderr') throw new Error('Unexpected archive list frame');
        } catch (error) {
          callbackFailure = error;
          link.controller.abort();
        }
      }
    });
    if (callbackFailure) throw callbackFailure;
    output.end();
    const outcome = await parser;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  } catch (error) {
    const primaryFailure = parserFailure || callbackFailure || error;
    output.destroy();
    await parser;
    throw failed(primaryFailure);
  } finally {
    link.close();
  }
}

function bindEngineFamily(parsed, concrete) {
  const expected = concrete === 'rar4' ? 'rar' : concrete === 'rar5' ? 'rar5' : 'zip';
  if (parsed.archive.type !== expected) throw familyMismatch(concrete);
}

function assertMultipartComplete(context, parsed, magic) {
  const set = context.verifiedArtifactSet.artifactSet;
  if (set.kind === 'single') {
    if (parsed.archive.multivolume || parsed.entries.some(entry => entry.splitBefore || entry.splitAfter)) {
      throw multipartMissing(set.primaryPartId);
    }
    return;
  }
  if (magic.archiveFamily !== 'multipart-rar' || !parsed.archive.multivolume ||
      parsed.archive.volumeIndex !== '0' || parsed.archive.volumes !== String(set.parts.length)) {
    throw multipartMissing(set.primaryPartId);
  }
  let groups;
  try {
    groups = groupMultipartCandidates(set.parts.map(part => ({
      assetId: part.partId,
      fileName: part.fileName,
      size: part.size
    })));
  } catch {
    throw multipartMissing(set.primaryPartId);
  }
  const group = groups.length === 1 ? groups[0] : null;
  const actualIds = group?.parts?.map(part => part.partId).sort() || [];
  const expectedIds = set.parts.map(part => part.partId).sort();
  if (!group || group.disabled || group.kind !== 'multipart' || group.groupingScheme !== set.groupingScheme ||
      group.primaryPartId !== set.primaryPartId || actualIds.length !== expectedIds.length ||
      actualIds.some((partId, index) => partId !== expectedIds[index])) {
    throw multipartMissing(set.primaryPartId);
  }
}

function rootAnalysis(entries) {
  const candidateNames = new Map();
  let rootFile = false;
  let nested = false;
  for (const entry of entries) {
    const components = entry.path.split('/');
    if (components.length === 1) {
      if (entry.type === 'file') rootFile = true;
      else candidateNames.set(entry.canonicalPath, entry.path);
      continue;
    }
    nested = true;
    candidateNames.set(components[0].normalize('NFC').toLocaleLowerCase('en-US'), components[0].normalize('NFC'));
  }
  const rootCandidates = [...candidateNames.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([, name]) => name);
  const selectedRoot = !rootFile && nested && rootCandidates.length === 1 ? rootCandidates[0] : null;
  return { rootCandidates, selectedRoot };
}

function publicEntries(entries) {
  return entries.map(entry => ({
    entryName: entry.path,
    canonicalName: entry.canonicalPath,
    type: entry.type,
    size: entry.size,
    packedSize: entry.packedSize,
    depth: entry.depth,
    nameLength: entry.pathLength,
    ...(entry.method === undefined ? {} : { method: entry.method }),
    ...(entry.volumeIndex === undefined ? {} : { volumeIndex: entry.volumeIndex })
  }));
}

function strictBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid archive data frame');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Invalid archive data frame');
  return bytes;
}

async function readEntry(workerClient, context, archiveFamily, entriesByName, entryName, options, signal) {
  const entry = entriesByName.get(entryName);
  const maxBytes = options?.maxBytes;
  if (!entry || entry.type !== 'file' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      maxBytes > MAX_TECHNICAL_BYTES || BigInt(entry.size) > BigInt(maxBytes)) invalid('readEntry');
  const link = linkedController(signal);
  const chunks = [];
  let measured = 0;
  let callbackFailure = null;
  try {
    await workerClient.run(workerRequest(context, 'read-entry', archiveFamily, {
      entryName,
      maxDataBytes: String(maxBytes)
    }), {
      signal: link.controller.signal,
      onFrame(frame) {
        try {
          if (frame.type === 'stderr') {
            scanDiagnostic(frame);
            return;
          }
          if (frame.type !== 'data') throw new Error('Unexpected archive entry frame');
          const bytes = strictBase64(frame.data);
          measured += bytes.length;
          if (measured > maxBytes || BigInt(measured) > BigInt(entry.size)) {
            callbackFailure = new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Archive entry read exceeded its safety limit', {
              details: { limit: 'maxTechnicalStdoutBytes', actual: String(measured) }
            });
            link.controller.abort();
            return;
          }
          chunks.push(bytes);
        } catch (error) {
          callbackFailure = error;
          link.controller.abort();
        }
      }
    });
    if (callbackFailure) throw callbackFailure;
    if (BigInt(measured) !== BigInt(entry.size)) throw new Error('Archive entry size changed');
    return Buffer.concat(chunks, measured);
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw failed(callbackFailure || error);
  } finally {
    link.close();
  }
}

class ArchiveInspector {
  constructor({ workspaceRegistry, workspaceRoot, workerClient } = {}) {
    if (!workerClient || typeof workerClient.run !== 'function') invalid('workerClient');
    this.materializer = new ArchiveInputMaterializer({ workspaceRegistry, workspaceRoot });
    this.workerClient = workerClient;
  }

  async inspectArchive({ verifiedArtifactSet, signal, onProgress } = {}) {
    assertSignal(signal);
    if (onProgress !== undefined && typeof onProgress !== 'function') invalid('onProgress');
    if (signal?.aborted) throw cancelled();
    let context = null;
    let promoted = false;
    try {
      emitProgress(onProgress, 'materialize');
      context = await this.materializer.prepare(verifiedArtifactSet);
      if (signal?.aborted) throw cancelled();

      const magic = detectArchiveFamily(await this.materializer.readPrefix(context), context.reviewedNames);
      const concrete = concreteFamily(magic);
      emitProgress(onProgress, 'list');
      const parsed = await listArchive(this.workerClient, context, concrete, signal);
      bindEngineFamily(parsed, concrete);
      assertMultipartComplete(context, parsed, magic);

      emitProgress(onProgress, 'validate');
      const policy = validateArchiveEntries(parsed.entries, ARCHIVE_LIMITS);
      const roots = rootAnalysis(policy.entries);

      emitProgress(onProgress, 'classify');
      const entriesByName = new Map(policy.entries.map(entry => [entry.path, entry]));
      const classification = await classifyArchive({
        entries: policy.entries,
        selectedRoot: roots.selectedRoot,
        readEntry: (entryName, options) => readEntry(
          this.workerClient,
          context,
          concrete,
          entriesByName,
          entryName,
          options,
          signal
        )
      });

      const result = deepFreeze({
        type: 'archive-inspection',
        archiveFamily: magic.archiveFamily,
        integrity: 'deferred-to-extraction',
        artifactSet: {
          completeness: 'verified-complete-set',
          fingerprint: context.fingerprint
        },
        engineEvidence: {
          family: concrete === 'zip' ? 'zip' : 'rar',
          concreteFamily: concrete,
          version: parsed.engineVersion,
          tested: false
        },
        entries: publicEntries(policy.entries),
        rootCandidates: roots.rootCandidates,
        selectedRoot: roots.selectedRoot,
        limitEvidence: {
          policyVersion: policy.policyVersion,
          totals: policy.totals
        },
        classification
      });
      emitProgress(onProgress, 'complete');
      const inspectionId = this.materializer.promote(context, result);
      promoted = true;
      return deepFreeze({ ...result, inspectionId });
    } catch (error) {
      if (signal?.aborted && !(error instanceof ModpackError && error.code !== 'CANCELLED')) throw cancelled();
      throw failed(error);
    } finally {
      if (context && !promoted) {
        try { await this.materializer.workspaceRegistry.releaseOwner(context.ownerId); } catch { /* retain the primary failure */ }
      }
    }
  }
}

function createArchiveInspector(dependencies) {
  return new ArchiveInspector(dependencies);
}

async function inspectArchive(request, dependencies) {
  if (!dependencies) invalid('dependencies');
  return createArchiveInspector(dependencies).inspectArchive(request);
}

module.exports = { ArchiveInspector, createArchiveInspector, inspectArchive };
