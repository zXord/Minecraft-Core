const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const { ModpackError, deepFreeze } = require('../errors.cjs');
const { ARCHIVE_LIMITS } = require('../limits.cjs');
const { isSafeWindowsBasename } = require('../windows-basename.cjs');
const { WindowsReparseInspector } = require('../local/windows-reparse-inspector.cjs');
const { verifyArchiveRuntime } = require('./archive-runtime-verifier.cjs');

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_COLLECTION = 1024;
const MAX_JSON_STRING = 256 * 1024;
const MAX_BROKER_STDERR_BYTES = 1024 * 1024;
const BROKER_CLEANUP_MARGIN_MS = 30 * 1000;
const DEFAULT_CLEANUP_GRACE_MS = 10 * 1000;
const DEFAULT_FORCE_CLOSE_WAIT_MS = 5 * 1000;
const DEFAULT_KEEPALIVE_MS = 5 * 1000;
const BUNDLE_JOURNAL_NAME = '.minecraft-core-broker-bundle.json';
const MAX_BUNDLE_JOURNAL_BYTES = 4096;
const RUN_OPERATIONS = new Set(['list', 'test', 'extract', 'read-entry']);
const ARCHIVE_FAMILIES = new Set(['mrpack', 'zip', 'rar4', 'rar5']);
const WORKER_ERROR_CODES = new Set([
  'UNSUPPORTED_ARCHIVE', 'MAGIC_EXTENSION_MISMATCH', 'ENCRYPTED_ARCHIVE', 'MULTIPART_VOLUME_MISSING',
  'ARCHIVE_LIMIT_EXCEEDED', 'UNSAFE_ARCHIVE_ENTRY', 'ARCHIVE_ENTRY_COLLISION', 'EXTRACTOR_UNAVAILABLE',
  'EXTRACTOR_FAILED', 'CANCELLED'
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKSPACE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA512 = /^[a-f0-9]{128}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function unavailable(cause) {
  return new ModpackError('EXTRACTOR_UNAVAILABLE', 'The protected archive worker is unavailable', { cause });
}

function invalid(field) {
  throw new ModpackError('INVALID_REQUEST', 'Archive worker request is invalid', { details: { field } });
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key));
}

function scanStrictJson(text) {
  let offset = 0;
  const length = text.length;
  const whitespace = () => { while (offset < length && /[\x20\t\r\n]/.test(text[offset])) offset += 1; };
  const parseString = () => {
    if (text[offset] !== '"') throw new SyntaxError('Expected string');
    const start = offset;
    offset += 1;
    let decodedLength = 0;
    while (offset < length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        const raw = text.slice(start, offset);
        const decoded = JSON.parse(raw);
        if (decoded.length > MAX_JSON_STRING || decodedLength > MAX_JSON_STRING) throw new SyntaxError('String limit');
        return decoded;
      }
      if (code < 0x20) throw new SyntaxError('Control in string');
      if (code === 0x5c) {
        offset += 1;
        if (offset >= length || !/["\\/bfnrtu]/.test(text[offset])) throw new SyntaxError('Bad escape');
        if (text[offset] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) throw new SyntaxError('Bad unicode escape');
          offset += 4;
        }
      }
      offset += 1;
      decodedLength += 1;
    }
    throw new SyntaxError('Unterminated string');
  };
  const parseValue = (depth) => {
    if (depth > MAX_JSON_DEPTH) throw new SyntaxError('Depth limit');
    whitespace();
    if (text[offset] === '"') { parseString(); return; }
    if (text[offset] === '{') {
      offset += 1;
      whitespace();
      const keys = new Set();
      let count = 0;
      if (text[offset] === '}') { offset += 1; return; }
      while (true) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) throw new SyntaxError('Duplicate key');
        keys.add(key);
        count += 1;
        if (count > MAX_JSON_COLLECTION) throw new SyntaxError('Collection limit');
        whitespace();
        if (text[offset] !== ':') throw new SyntaxError('Expected colon');
        offset += 1;
        parseValue(depth + 1);
        whitespace();
        if (text[offset] === '}') { offset += 1; return; }
        if (text[offset] !== ',') throw new SyntaxError('Expected comma');
        offset += 1;
      }
    }
    if (text[offset] === '[') {
      offset += 1;
      whitespace();
      let count = 0;
      if (text[offset] === ']') { offset += 1; return; }
      while (true) {
        count += 1;
        if (count > MAX_JSON_COLLECTION) throw new SyntaxError('Collection limit');
        parseValue(depth + 1);
        whitespace();
        if (text[offset] === ']') { offset += 1; return; }
        if (text[offset] !== ',') throw new SyntaxError('Expected comma');
        offset += 1;
      }
    }
    const rest = text.slice(offset);
    const token = rest.match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/)?.[0];
    if (!token) throw new SyntaxError('Invalid value');
    offset += token.length;
  };
  parseValue(0);
  whitespace();
  if (offset !== length) throw new SyntaxError('Trailing data');
}

function parseStrictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  scanStrictJson(text);
  return JSON.parse(text);
}

function createOperationBudget({ signal, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw unavailable();
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) invalid('signal');
  const controller = new AbortController();
  const deadline = process.hrtime.bigint() + (BigInt(timeoutMs) * 1_000_000n);
  let failure = null;
  const abort = error => {
    if (controller.signal.aborted) return;
    failure = error;
    controller.abort(error);
  };
  const onExternalAbort = () => abort(new ModpackError('CANCELLED', 'Archive operation was cancelled'));
  if (signal?.aborted) onExternalAbort();
  else signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => abort(unavailable()), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    error() { return failure || unavailable(); },
    throwIfAborted() {
      if (!controller.signal.aborted && process.hrtime.bigint() >= deadline) abort(unavailable());
      if (controller.signal.aborted) throw this.error();
    },
    wait(value) {
      this.throwIfAborted();
      return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(this.error());
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(value).then(result => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', onAbort);
          resolve(result);
        }, error => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', onAbort);
          reject(error);
        });
      });
    },
    dispose() {
      clearTimeout(timer);
      try { signal?.removeEventListener('abort', onExternalAbort); } catch { /* stable operation result remains authoritative */ }
    }
  };
}

function processDefinitelyAbsent(processId) {
  if (!Number.isSafeInteger(processId) || processId < 1 || processId > 0x7fffffff) return false;
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function exactBundleDirectory(bundleParent, candidate) {
  const resolvedParent = path.resolve(bundleParent);
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== resolvedParent || !path.basename(resolved).startsWith('bundle-')) throw unavailable();
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(resolved), resolved)) throw unavailable();
  return resolved;
}

function removeBrokerBundle(bundleParent, bundleRoot) {
  const exact = exactBundleDirectory(bundleParent, bundleRoot);
  fs.rmSync(exact, { recursive: true, force: false });
}

function writeBundleJournal(bundleRoot, value, { create = false } = {}) {
  const required = value.state === 'running' ? ['schemaVersion', 'state', 'ownerPid', 'brokerPid'] : ['schemaVersion', 'state', 'ownerPid'];
  if (!exactKeys(value, required) || value.schemaVersion !== 1 || !['creating', 'running'].includes(value.state) ||
      !Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1 ||
      (value.state === 'running' && (!Number.isSafeInteger(value.brokerPid) || value.brokerPid < 1))) throw unavailable();
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length < 2 || body.length > MAX_BUNDLE_JOURNAL_BYTES) throw unavailable();
  const descriptor = fs.openSync(path.join(bundleRoot, BUNDLE_JOURNAL_NAME), create ? 'wx' : 'w');
  try {
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function recoverBrokerBundles(appOwnedRoot) {
  const bundleParent = path.join(appOwnedRoot, 'broker-bundles');
  fs.mkdirSync(bundleParent, { recursive: true });
  if (!samePath(fs.realpathSync.native(bundleParent), bundleParent)) throw unavailable();
  for (const name of fs.readdirSync(bundleParent).sort()) {
    const bundleRoot = exactBundleDirectory(bundleParent, path.join(bundleParent, name));
    const journalPath = path.join(bundleRoot, BUNDLE_JOURNAL_NAME);
    if (!fs.existsSync(journalPath)) continue;
    const stat = fs.lstatSync(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_BUNDLE_JOURNAL_BYTES) continue;
    let journal;
    try { journal = parseStrictJson(fs.readFileSync(journalPath)); } catch { continue; }
    const running = exactKeys(journal, ['schemaVersion', 'state', 'ownerPid', 'brokerPid']) && journal.schemaVersion === 1 &&
      journal.state === 'running' && Number.isSafeInteger(journal.ownerPid) && journal.ownerPid > 0 &&
      Number.isSafeInteger(journal.brokerPid) && journal.brokerPid > 0;
    if (running && processDefinitelyAbsent(journal.brokerPid)) removeBrokerBundle(bundleParent, bundleRoot);
  }
  return bundleParent;
}

function createBrokerBundle(appOwnedRoot) {
  const bundleParent = recoverBrokerBundles(appOwnedRoot);
  const bundleRoot = fs.mkdtempSync(path.join(bundleParent, 'bundle-'));
  try {
    writeBundleJournal(bundleRoot, { schemaVersion: 1, state: 'creating', ownerPid: process.pid }, { create: true });
    return { bundleParent, bundleRoot };
  } catch (error) {
    try { removeBrokerBundle(bundleParent, bundleRoot); } catch { /* original journal failure remains authoritative */ }
    throw error;
  }
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw unavailable();
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

class StrictFrameDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.chunks = [];
    this.chunkIndex = 0;
    this.chunkOffset = 0;
    this.bufferedBytes = 0;
    this.expected = null;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw unavailable();
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.length;
    while (true) {
      if (this.expected === null) {
        if (this.bufferedBytes < 4) return;
        this.expected = this.#read(4).readUInt32LE(0);
        if (this.expected < 2 || this.expected > MAX_FRAME_BYTES) throw unavailable();
      }
      if (this.bufferedBytes < this.expected) return;
      const body = this.#read(this.expected);
      this.expected = null;
      let value;
      try { value = parseStrictJson(body); } catch (error) { throw unavailable(error); }
      this.onFrame(value);
    }
  }

  #read(length) {
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[this.chunkIndex];
      const available = chunk.length - this.chunkOffset;
      const take = Math.min(available, length - written);
      chunk.copy(result, written, this.chunkOffset, this.chunkOffset + take);
      written += take;
      this.chunkOffset += take;
      this.bufferedBytes -= take;
      if (this.chunkOffset === chunk.length) {
        this.chunkIndex += 1;
        this.chunkOffset = 0;
        if (this.chunkIndex >= 1024 && this.chunkIndex * 2 >= this.chunks.length) {
          this.chunks = this.chunks.slice(this.chunkIndex);
          this.chunkIndex = 0;
        }
      }
    }
    return result;
  }

  end() {
    if (this.expected !== null || this.bufferedBytes !== 0) throw unavailable();
  }
}

function redactText(value) {
  return value
    .replace(/\b(?:password|passwd|pwd)\s*=\s*[^\s]+/gi, '[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[REDACTED]')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n]*/g, '[REDACTED]');
}

function validateMetrics(metrics) {
  if (!exactKeys(metrics, ['stdoutBytes', 'stderrBytes', 'dataBytes', 'elapsedMs'])) return false;
  return typeof metrics.stdoutBytes === 'string' && typeof metrics.stderrBytes === 'string' && typeof metrics.dataBytes === 'string' &&
    metrics.stdoutBytes.length <= 20 && metrics.stderrBytes.length <= 20 && metrics.dataBytes.length <= 20 &&
    DECIMAL.test(metrics.stdoutBytes) && DECIMAL.test(metrics.stderrBytes) && DECIMAL.test(metrics.dataBytes) &&
    Number.isSafeInteger(metrics.elapsedMs) && metrics.elapsedMs >= 0;
}

function validateWorkerFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') throw unavailable();
  if (frame.type === 'stdout' || frame.type === 'stderr') {
    if (!exactKeys(frame, ['type', 'text']) || typeof frame.text !== 'string' || frame.text.length > MAX_JSON_STRING) throw unavailable();
    return deepFreeze({ type: frame.type, text: redactText(frame.text) });
  }
  if (frame.type === 'data') {
    if (!exactKeys(frame, ['type', 'data']) || typeof frame.data !== 'string' || !BASE64.test(frame.data)) throw unavailable();
    return deepFreeze({ type: 'data', data: frame.data });
  }
  if (frame.type === 'status') {
    if (!exactKeys(frame, ['type', 'ok', 'exitCode', 'metrics'], ['errorCode']) || typeof frame.ok !== 'boolean' ||
        !Number.isSafeInteger(frame.exitCode) || frame.exitCode < 0 || !validateMetrics(frame.metrics)) throw unavailable();
    if (frame.ok) {
      if (frame.exitCode !== 0 || Object.hasOwn(frame, 'errorCode')) throw unavailable();
    } else if (frame.exitCode === 0 || !WORKER_ERROR_CODES.has(frame.errorCode)) throw unavailable();
    return deepFreeze({
      type: 'status', ok: frame.ok, exitCode: frame.exitCode,
      ...(frame.errorCode ? { errorCode: frame.errorCode } : {}),
      metrics: { ...frame.metrics }
    });
  }
  throw unavailable();
}

function validateLimits(value) {
  if (!exactKeys(value, Object.keys(ARCHIVE_LIMITS))) return false;
  return Object.entries(ARCHIVE_LIMITS).every(([key, expected]) => value[key] === expected);
}

function safeEntryName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > ARCHIVE_LIMITS.maxNormalizedPathLength ||
      value.startsWith('@') ||
      [...value].some(character => { const code = character.codePointAt(0); return code === 0 || code < 0x20 || code === 0x7f; })) return false;
  if (/^(?:[A-Za-z]:|[\\/]|\\\\)/.test(value) || value.includes(':')) return false;
  const parts = value.replace(/\\/g, '/').split('/');
  return !parts.some(part => !part || part === '.' || part === '..' || !isSafeWindowsBasename(part));
}

function validateRunRequest(request) {
  if (!exactKeys(request, ['operation', 'operationId', 'artifactSetId', 'inputDirectoryId', 'archiveFamily', 'limits'], ['outputDirectoryId', 'entryName', 'maxDataBytes'])) invalid('request');
  if (!RUN_OPERATIONS.has(request.operation)) invalid('operation');
  if (!IDENTIFIER.test(request.operationId || '')) invalid('operationId');
  for (const key of ['artifactSetId', 'inputDirectoryId']) if (!WORKSPACE_IDENTIFIER.test(request[key] || '')) invalid(key);
  if (!ARCHIVE_FAMILIES.has(request.archiveFamily)) invalid('archiveFamily');
  if (!validateLimits(request.limits)) invalid('limits');
  if (request.operation === 'extract') {
    if (!WORKSPACE_IDENTIFIER.test(request.outputDirectoryId || '') || Object.hasOwn(request, 'entryName')) invalid('outputDirectoryId');
  } else if (Object.hasOwn(request, 'outputDirectoryId')) invalid('outputDirectoryId');
  if (request.operation === 'read-entry') {
    if (!safeEntryName(request.entryName)) invalid('entryName');
    if (Object.hasOwn(request, 'maxDataBytes')) {
      if (typeof request.maxDataBytes !== 'string' || !DECIMAL.test(request.maxDataBytes) || request.maxDataBytes === '0' ||
          BigInt(request.maxDataBytes) > BigInt(ARCHIVE_LIMITS.maxTechnicalStdoutBytes)) invalid('maxDataBytes');
    }
  } else if (Object.hasOwn(request, 'entryName')) invalid('entryName');
  if (request.operation !== 'read-entry' && Object.hasOwn(request, 'maxDataBytes')) invalid('maxDataBytes');
}

function samePath(left, right) {
  return path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US');
}

async function assertNoReparseChain(root, candidate, inspector) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  let realRoot;
  let realCandidate;
  try {
    realRoot = fs.realpathSync.native(resolvedRoot);
    realCandidate = fs.realpathSync.native(resolvedCandidate);
  } catch { invalid('workspace'); }
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) invalid('workspace');
  if (!samePath(realRoot, resolvedRoot) || !samePath(realCandidate, resolvedCandidate)) invalid('workspace');
  let current = resolvedRoot;
  const components = relative.split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    try { if (await inspector.isReparsePoint(current)) invalid('workspace'); }
    catch (error) { if (error instanceof ModpackError) throw error; invalid('workspace'); }
  }
}

async function assertControlledDirectory(root, id, inspector, { empty = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, id);
  if (path.dirname(candidate) !== resolvedRoot) invalid('workspace');
  let stat;
  try { stat = fs.lstatSync(candidate); } catch (error) { throw invalid('workspace', error); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid('workspace');
  await assertNoReparseChain(resolvedRoot, candidate, inspector);
  if (empty && fs.readdirSync(candidate).length !== 0) invalid('outputDirectoryId');
  return candidate;
}

async function resolveNativeRequest(request, workspaceRoot, workspaceRegistry, reparseInspector, budget) {
  budget.throwIfAborted();
  if (!workspaceRoot || !workspaceRegistry || typeof workspaceRegistry.resolveOwnedId !== 'function') throw unavailable();
  let artifact;
  let inputRecord;
  try {
    artifact = workspaceRegistry.resolveOwnedId({ ownerId: request.operationId, id: request.artifactSetId, kind: 'artifact-set' });
    inputRecord = workspaceRegistry.resolveOwnedId({ ownerId: request.operationId, id: request.inputDirectoryId, kind: 'input' });
  } catch (error) {
    budget.throwIfAborted();
    if (error instanceof ModpackError) throw error;
    throw invalid('workspace');
  }
  budget.throwIfAborted();
  const inputDirectory = await budget.wait(assertControlledDirectory(workspaceRoot, request.inputDirectoryId, reparseInspector));
  const verified = artifact?.value;
  const parts = verified?.artifactSet?.parts;
  const primaryPartId = verified?.artifactSet?.primaryPartId;
  if (verified?.type !== 'verified-artifact-set') invalid('artifactSetId');
  const sourceSetDigest = verified?.artifactSet?.setDigest;
  const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(verified), 'utf8').digest('hex');
  if (!SHA256.test(sourceSetDigest || '') || inputRecord?.value?.sourceArtifactSetId !== request.artifactSetId ||
      inputRecord?.value?.sourceSetDigest !== sourceSetDigest || inputRecord?.value?.sourceFingerprint !== sourceFingerprint) invalid('inputDirectoryId');
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 1024) invalid('artifactSetId');
  const primary = Array.isArray(parts) ? parts.find(part => part?.partId === primaryPartId) : null;
  if (!primary || typeof primary.fileName !== 'string' || path.basename(primary.fileName) !== primary.fileName || !isSafeWindowsBasename(primary.fileName)) invalid('artifactSetId');
  const expectedNames = parts.map(part => part?.fileName).sort();
  if (expectedNames.some(name => typeof name !== 'string' || path.basename(name) !== name || !isSafeWindowsBasename(name)) ||
      new Set(expectedNames.map(name => name.toLocaleLowerCase('en-US'))).size !== expectedNames.length) invalid('artifactSetId');
  const actualNames = fs.readdirSync(inputDirectory).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) invalid('inputDirectoryId');
  for (const name of actualNames) {
    budget.throwIfAborted();
    const stat = fs.lstatSync(path.join(inputDirectory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) invalid('inputDirectoryId');
    await budget.wait(assertNoReparseChain(inputDirectory, path.join(inputDirectory, name), reparseInspector));
  }
  const inputParts = [];
  for (const part of parts) {
    budget.throwIfAborted();
    if (typeof part?.measuredSize !== 'string' || !DECIMAL.test(part.measuredSize) || !SHA256.test(part?.calculatedDigests?.sha256 || '') ||
        !SHA512.test(part?.calculatedDigests?.sha512 || '')) invalid('artifactSetId');
    const partPath = path.join(inputDirectory, part.fileName);
    let measuredSize = 0n;
    const sha256 = crypto.createHash('sha256');
    const sha512 = crypto.createHash('sha512');
    let handle;
    try {
      handle = await budget.wait(fsp.open(partPath, 'r'));
      const before = await handle.stat();
      if (!before.isFile() || BigInt(before.size) !== BigInt(part.measuredSize)) throw new ModpackError('HASH_MISMATCH', 'Artifact bytes changed before archive processing');
      for await (const chunk of handle.createReadStream({ autoClose: false, signal: budget.signal })) {
        budget.throwIfAborted();
        measuredSize += BigInt(chunk.length);
        if (measuredSize > BigInt(part.measuredSize)) throw new ModpackError('HASH_MISMATCH', 'Artifact bytes changed before archive processing');
        sha256.update(chunk);
        sha512.update(chunk);
      }
      const after = await handle.stat();
      if (measuredSize !== BigInt(part.measuredSize) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev ||
          sha256.digest('hex') !== part.calculatedDigests.sha256 || sha512.digest('hex') !== part.calculatedDigests.sha512) {
        throw new ModpackError('HASH_MISMATCH', 'Artifact bytes changed before archive processing');
      }
    } catch (error) {
      budget.throwIfAborted();
      if (error instanceof ModpackError) throw error;
      throw new ModpackError('HASH_MISMATCH', 'Artifact bytes changed before archive processing', { cause: error });
    } finally {
      await handle?.close().catch(() => {});
    }
    inputParts.push({ path: partPath, size: part.measuredSize, sha256: part.calculatedDigests.sha256, sha512: part.calculatedDigests.sha512 });
  }
  const native = {
    operation: request.operation,
    operationId: request.operationId,
    archiveFamily: request.archiveFamily === 'mrpack' || request.archiveFamily === 'zip' ? 'zip' : request.archiveFamily,
    resourcesRoot: path.resolve(this?.resourcesRoot || ''),
    inputDirectory,
    archivePath: path.join(inputDirectory, primary.fileName),
    inputParts,
    limits: { ...request.limits }
  };
  if (request.operation === 'extract') {
    try { workspaceRegistry.resolveOwnedId({ ownerId: request.operationId, id: request.outputDirectoryId, kind: 'output' }); }
    catch (error) { if (error instanceof ModpackError) throw error; throw invalid('outputDirectoryId'); }
    native.outputDirectory = await budget.wait(assertControlledDirectory(workspaceRoot, request.outputDirectoryId, reparseInspector, { empty: true }));
  }
  if (request.operation === 'read-entry') {
    native.entryName = request.entryName;
    if (Object.hasOwn(request, 'maxDataBytes')) native.maxDataBytes = request.maxDataBytes;
  }
  return native;
}

function strictManifest(bytes) {
  let manifest;
  try { manifest = parseStrictJson(bytes); } catch (error) { throw unavailable(error); }
  if (!exactKeys(manifest, ['schemaVersion', 'architecture', 'runtimeIdentifier', 'targetFramework', 'sdkVersion', 'files']) ||
      manifest.schemaVersion !== 1 || manifest.architecture !== 'x64' || manifest.runtimeIdentifier !== 'win-x64' ||
      manifest.targetFramework !== 'net8.0-windows' || manifest.sdkVersion !== '10.0.204' ||
      !exactKeys(manifest.files, ['ArchiveWorker.exe']) ||
      !exactKeys(manifest.files['ArchiveWorker.exe'], ['size', 'sha256'])) throw unavailable();
  const file = manifest.files['ArchiveWorker.exe'];
  if (!Number.isSafeInteger(file.size) || file.size < 1 || !/^[a-f0-9]{64}$/.test(file.sha256 || '')) throw unavailable();
  return { manifest, file };
}

function verifyPe(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw unavailable();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== 0x8664) throw unavailable();
}

function verifyArchiveWorkerExecutableSync({ workerPath, workerManifestPath }) {
  try {
    const manifestStat = fs.lstatSync(workerManifestPath);
    const workerStat = fs.lstatSync(workerPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024 ||
        !workerStat.isFile() || workerStat.isSymbolicLink()) throw unavailable();
    if (!samePath(fs.realpathSync.native(workerPath), workerPath) || !samePath(fs.realpathSync.native(workerManifestPath), workerManifestPath)) throw unavailable();
    const { manifest, file } = strictManifest(fs.readFileSync(workerManifestPath));
    const bytes = fs.readFileSync(workerPath);
    if (bytes.length !== file.size || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw unavailable();
    verifyPe(bytes);
    return deepFreeze({
      architecture: manifest.architecture,
      runtimeIdentifier: manifest.runtimeIdentifier,
      targetFramework: manifest.targetFramework,
      sdkVersion: manifest.sdkVersion,
      file: { ...file }
    });
  } catch (error) {
    if (error instanceof ModpackError && error.code === 'EXTRACTOR_UNAVAILABLE') throw error;
    throw unavailable(error);
  }
}

async function verifyArchiveWorkerExecutable(options) {
  try {
    const [manifestStat, workerStat] = await Promise.all([fsp.lstat(options.workerManifestPath), fsp.lstat(options.workerPath)]);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024 || !workerStat.isFile() || workerStat.isSymbolicLink()) throw unavailable();
    if (!samePath(fs.realpathSync.native(options.workerPath), options.workerPath) || !samePath(fs.realpathSync.native(options.workerManifestPath), options.workerManifestPath)) throw unavailable();
    const inspector = options.reparseInspector || new WindowsReparseInspector();
    if (await inspector.isReparsePoint(path.resolve(options.workerPath)) || await inspector.isReparsePoint(path.resolve(options.workerManifestPath))) throw unavailable();
    const [manifestBytes, workerBytes] = await Promise.all([fsp.readFile(options.workerManifestPath), fsp.readFile(options.workerPath)]);
    const { manifest, file } = strictManifest(manifestBytes);
    if (workerBytes.length !== file.size || crypto.createHash('sha256').update(workerBytes).digest('hex') !== file.sha256) throw unavailable();
    verifyPe(workerBytes);
    return deepFreeze({ architecture: manifest.architecture, runtimeIdentifier: manifest.runtimeIdentifier, targetFramework: manifest.targetFramework, sdkVersion: manifest.sdkVersion, file: { ...file } });
  } catch (error) {
    if (error instanceof ModpackError && error.code === 'EXTRACTOR_UNAVAILABLE') throw error;
    throw unavailable(error);
  }
}

function minimalEnvironment(bundleRoot) {
  const environment = { DOTNET_BUNDLE_EXTRACT_BASE_DIR: bundleRoot };
  if (process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
  else if (process.env.WINDIR) environment.SystemRoot = process.env.WINDIR;
  return environment;
}

async function createNamedPipeControlChannel() {
  const pipeName = `\\\\.\\pipe\\MinecraftCore.ArchiveWorker.${process.pid}.${crypto.randomBytes(16).toString('hex')}`;
  const server = net.createServer();
  server.maxConnections = 1;
  let socket = null;
  let closed = false;
  const pending = [];
  let errorHandler = () => {};
  server.on('connection', candidate => {
    if (socket || closed) { candidate.destroy(); return; }
    socket = candidate;
    socket.on('error', error => errorHandler(error));
    for (const bytes of pending.splice(0)) socket.write(bytes);
  });
  server.on('error', error => errorHandler(error));
  await new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeName);
  });
  return {
    pipeName,
    onError(handler) { errorHandler = typeof handler === 'function' ? handler : () => {}; },
    send(value) {
      if (closed) return false;
      const bytes = encodeFrame(value);
      if (!socket) { pending.push(bytes); return true; }
      if (socket.destroyed) return false;
      return socket.write(bytes);
    },
    close() {
      if (closed) return;
      closed = true;
      pending.length = 0;
      try { socket?.destroy(); } catch { /* already closed */ }
      try { server.close(); } catch { /* never accepted */ }
    }
  };
}

class ArchiveWorkerClient {
  constructor({ workerPath, workerManifestPath, resourcesRoot, workspaceRoot, workspaceRegistry, spawn = childProcess.spawn,
    verifyWorker = verifyArchiveWorkerExecutable, verifyRuntime = verifyArchiveRuntime, reparseInspector = new WindowsReparseInspector(), outputCaps,
    deadlineOverrideMs, appOwnedRoot, cleanupGraceMs = DEFAULT_CLEANUP_GRACE_MS, forceCloseWaitMs = DEFAULT_FORCE_CLOSE_WAIT_MS,
    keepaliveMs = DEFAULT_KEEPALIVE_MS, controlChannelFactory = createNamedPipeControlChannel, runtimeLayout = 'repository' } = {}) {
    this.workerPath = path.resolve(workerPath || path.join(resourcesRoot || '', 'vendor', 'archive-worker', 'x64', 'ArchiveWorker.exe'));
    this.workerManifestPath = path.resolve(workerManifestPath || path.join(resourcesRoot || '', 'build-resources', 'archive-runtime', 'archive-worker-x64.json'));
    this.resourcesRoot = path.resolve(resourcesRoot || '');
    this.workspaceRoot = workspaceRoot ? path.resolve(workspaceRoot) : null;
    this.workspaceRegistry = workspaceRegistry;
    this.spawn = spawn;
    this.verifyWorker = verifyWorker;
    this.verifyRuntime = verifyRuntime;
    if (runtimeLayout !== 'repository' && runtimeLayout !== 'packaged') invalid('runtimeLayout');
    this.runtimeLayout = runtimeLayout;
    this.reparseInspector = reparseInspector;
    this.outputCaps = outputCaps;
    if (deadlineOverrideMs !== undefined && (!Number.isSafeInteger(deadlineOverrideMs) || deadlineOverrideMs < 1 ||
        deadlineOverrideMs > ARCHIVE_LIMITS.maxExtractionMs + BROKER_CLEANUP_MARGIN_MS)) invalid('deadlineOverrideMs');
    this.deadlineOverrideMs = deadlineOverrideMs;
    const defaultBase = process.env.LOCALAPPDATA || path.join(os.tmpdir(), 'MinecraftCore-LocalAppData');
    this.appOwnedRoot = path.resolve(appOwnedRoot || path.join(defaultBase, 'MinecraftCore', 'ArchiveWorker'));
    for (const [name, value, maximum] of [['cleanupGraceMs', cleanupGraceMs, 60_000], ['forceCloseWaitMs', forceCloseWaitMs, 60_000], ['keepaliveMs', keepaliveMs, 60_000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid(name);
    }
    this.cleanupGraceMs = cleanupGraceMs;
    this.forceCloseWaitMs = forceCloseWaitMs;
    this.keepaliveMs = keepaliveMs;
    if (typeof controlChannelFactory !== 'function') invalid('controlChannelFactory');
    this.controlChannelFactory = controlChannelFactory;
    fs.mkdirSync(this.appOwnedRoot, { recursive: true });
    const appRootStat = fs.lstatSync(this.appOwnedRoot);
    if (!appRootStat.isDirectory() || appRootStat.isSymbolicLink() || !samePath(fs.realpathSync.native(this.appOwnedRoot), this.appOwnedRoot)) throw unavailable();
    recoverBrokerBundles(this.appOwnedRoot);
  }

  async run(request, { signal, onFrame } = {}) {
    validateRunRequest(request);
    const nativeDeadline = request.operation === 'extract' ? request.limits.maxExtractionMs : request.limits.maxListTestMs;
    const budget = createOperationBudget({ signal, timeoutMs: this.deadlineOverrideMs ?? (nativeDeadline + BROKER_CLEANUP_MARGIN_MS) });
    try {
      budget.throwIfAborted();
      const nativeRequest = await resolveNativeRequest.call(this, request, this.workspaceRoot, this.workspaceRegistry, this.reparseInspector, budget);
      nativeRequest.resourcesRoot = this.resourcesRoot;
      nativeRequest.resourcesLayout = this.runtimeLayout;
      nativeRequest.appOwnedRoot = this.appOwnedRoot;
      const result = await this.#invoke(nativeRequest, { budget, onFrame, limits: request.limits });
      return result.status;
    } finally {
      budget.dispose();
    }
  }

  async selfTest({ resourcesRoot, userDataSentinel } = {}) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw unavailable();
    if (typeof resourcesRoot !== 'string' || !path.isAbsolute(resourcesRoot) || typeof userDataSentinel !== 'string' || !path.isAbsolute(userDataSentinel)) throw invalid('selfTest');
    const stat = fs.lstatSync(userDataSentinel);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('userDataSentinel');
    const frames = [];
    const budget = createOperationBudget({ timeoutMs: this.deadlineOverrideMs ?? (ARCHIVE_LIMITS.maxListTestMs + BROKER_CLEANUP_MARGIN_MS) });
    try {
      await this.#invoke({
        operation: 'self-test',
        resourcesRoot: path.resolve(resourcesRoot),
        resourcesLayout: this.runtimeLayout,
        appOwnedRoot: this.appOwnedRoot,
        userDataSentinel: path.resolve(userDataSentinel),
        limits: { ...ARCHIVE_LIMITS }
      }, { budget, onFrame: frame => frames.push(frame), limits: ARCHIVE_LIMITS });
    } finally {
      budget.dispose();
    }
    const data = frames.filter(frame => frame.type === 'data');
    if (data.length !== 1) throw unavailable();
    let evidence;
    try { evidence = parseStrictJson(Buffer.from(data[0].data, 'base64')); } catch (error) { throw unavailable(error); }
    const required = [
      'appContainer', 'zeroCapabilities', 'exactInputRead', 'exactOutputWrite', 'ambientTempReadDenied',
      'ambientTempWriteDenied', 'userDataReadDenied', 'userDataWriteDenied', 'loopbackDenied', 'descendantsDenied',
      'unrelatedEnvironmentAbsent', 'unrelatedHandlesAbsent', 'bundleExtractionIsolated', 'standardInputClosed',
      'cleanupKilledSurvivors', 'temporaryAclRemoved', 'profileStoreClean', 'publishedOutputAclClean'
    ];
    if (!exactKeys(evidence, required) || required.some(key => evidence[key] !== true)) throw unavailable();
    return deepFreeze({ ...evidence });
  }

  async #invoke(nativeRequest, { budget, onFrame, limits }) {
    budget.throwIfAborted();
    try {
      await budget.wait(Promise.all([
        this.verifyWorker({ workerPath: this.workerPath, workerManifestPath: this.workerManifestPath, reparseInspector: this.reparseInspector }),
        this.verifyRuntime(this.resourcesRoot, { layout: this.runtimeLayout })
      ]));
    } catch (error) {
      if (error instanceof ModpackError && error.code === 'CANCELLED') throw error;
      throw unavailable(error);
    }
    budget.throwIfAborted();
    const { bundleParent, bundleRoot } = createBrokerBundle(this.appOwnedRoot);
    const controlToken = crypto.randomBytes(32).toString('hex');
    let controlChannel;
    try { controlChannel = await budget.wait(this.controlChannelFactory()); }
    catch (error) {
      try { removeBrokerBundle(bundleParent, bundleRoot); } catch { /* no broker was launched */ }
      if (error instanceof ModpackError) throw error;
      throw unavailable(error);
    }
    nativeRequest.controlToken = controlToken;
    nativeRequest.controlPipeName = controlChannel.pipeName;
    nativeRequest.leaseId = crypto.randomUUID();
    let framedRequest;
    try {
      budget.throwIfAborted();
      framedRequest = encodeFrame(nativeRequest);
      budget.throwIfAborted();
    } catch (error) {
      controlChannel.close();
      try { removeBrokerBundle(bundleParent, bundleRoot); } catch { /* no broker was launched */ }
      throw error;
    }
    return new Promise((resolve, reject) => {
      let child;
      let terminal = null;
      let settled = false;
      let closed = false;
      let terminationError = null;
      let cleanupGraceTimer = null;
      let forceCloseTimer = null;
      let keepaliveTimer = null;
      let stdoutBytes = 0n;
      let stderrBytes = 0n;
      let dataBytes = 0n;
      let brokerStderrBytes = 0;
      const configuredStdout = BigInt(this.outputCaps?.stdout ?? limits.maxTechnicalStdoutBytes);
      const configuredStderr = BigInt(this.outputCaps?.stderr ?? limits.maxTechnicalStderrBytes);
      const requestDataCap = BigInt(nativeRequest.maxDataBytes ?? limits.maxTechnicalStdoutBytes);
      const configuredData = this.outputCaps?.data === undefined ? requestDataCap :
        (BigInt(this.outputCaps.data) < requestDataCap ? BigInt(this.outputCaps.data) : requestDataCap);
      const cleanupTimersAndListener = () => {
        if (cleanupGraceTimer) clearTimeout(cleanupGraceTimer);
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        try { budget.signal.removeEventListener('abort', onAbort); } catch { /* keep the stable failure */ }
        controlChannel.close();
      };
      const cleanupAfterClose = () => {
        if (!closed) return;
        try { removeBrokerBundle(bundleParent, bundleRoot); } catch { /* startup recovery owns a confirmed stale bundle */ }
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanupTimersAndListener();
        cleanupAfterClose();
        if (error) reject(error); else resolve(value);
      };
      const writeControl = type => {
        if (!child || closed) return false;
        try { return controlChannel.send({ type, token: controlToken }); } catch { return false; }
      };
      const terminate = (error) => {
        if (settled || closed) return;
        terminationError ??= error;
        if (!child) { finish(terminationError); return; }
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        writeControl('cancel');
        if (!cleanupGraceTimer) {
          cleanupGraceTimer = setTimeout(() => {
            try { child.kill(); } catch { /* late close or recovery owns cleanup */ }
            forceCloseTimer = setTimeout(() => {
              if (!closed) try { child.kill(); } catch { /* close remains the only quiescence proof */ }
            }, this.forceCloseWaitMs);
            forceCloseTimer.unref?.();
          }, this.cleanupGraceMs);
          cleanupGraceTimer.unref?.();
        }
      };
      const onAbort = () => terminate(budget.error());
      controlChannel.onError(error => terminate(unavailable(error)));
      const decoder = new StrictFrameDecoder(raw => {
        if (terminal) throw unavailable();
        const frame = validateWorkerFrame(raw);
        if (frame.type === 'status') { terminal = frame; return; }
        if (frame.type === 'stdout') stdoutBytes += BigInt(Buffer.byteLength(raw.text, 'utf8'));
        if (frame.type === 'stderr') stderrBytes += BigInt(Buffer.byteLength(raw.text, 'utf8'));
        if (frame.type === 'data') dataBytes += BigInt(Buffer.from(raw.data, 'base64').length);
        if (stdoutBytes > configuredStdout || stderrBytes > configuredStderr || dataBytes > configuredData) {
          throw new ModpackError('ARCHIVE_LIMIT_EXCEEDED', 'Archive worker output exceeded its safety limit', { details: { limit: frame.type === 'stderr' ? 'maxTechnicalStderrBytes' : 'maxTechnicalStdoutBytes', actual: (frame.type === 'stderr' ? stderrBytes : frame.type === 'data' ? dataBytes : stdoutBytes).toString() } });
        }
        if (typeof onFrame === 'function') {
          try { onFrame(frame); } catch (error) { throw new ModpackError('EXTRACTOR_FAILED', 'Archive processing callback failed', { cause: error }); }
        }
      });
      try { budget.signal.addEventListener('abort', onAbort, { once: true }); }
      catch (error) { finish(unavailable(error)); return; }
      try {
        child = this.spawn(this.workerPath, [], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: minimalEnvironment(bundleRoot)
        });
      } catch (error) {
        finish(unavailable(error));
        return;
      }
      if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function' ||
          !Number.isSafeInteger(child.pid) || child.pid < 1 ||
          !child.stdin || typeof child.stdin.end !== 'function' || typeof child.stdin.on !== 'function' ||
          !child.stdout || typeof child.stdout.on !== 'function' ||
          !child.stderr || typeof child.stderr.on !== 'function') {
        terminate(unavailable());
        return;
      }
      child.once('error', error => terminate(unavailable(error)));
      child.once('close', (code, signalName) => {
        closed = true;
        cleanupAfterClose();
        if (settled) return;
        if (terminationError) { finish(terminationError); return; }
        try { decoder.end(); } catch (error) { finish(error instanceof ModpackError ? error : unavailable(error)); return; }
        if (signalName || code !== 0 || brokerStderrBytes !== 0 || !terminal) { finish(unavailable()); return; }
        if (terminal.metrics.stdoutBytes !== stdoutBytes.toString() || terminal.metrics.stderrBytes !== stderrBytes.toString() ||
            terminal.metrics.dataBytes !== dataBytes.toString()) { finish(unavailable()); return; }
        if (!terminal.ok) {
          const codeValue = terminal.errorCode;
          finish(new ModpackError(codeValue, codeValue === 'CANCELLED' ? 'Archive operation was cancelled' : 'Archive processing failed'));
          return;
        }
        finish(null, { status: terminal });
      });
      try {
        writeBundleJournal(bundleRoot, { schemaVersion: 1, state: 'running', ownerPid: process.pid, brokerPid: child.pid });
        budget.throwIfAborted();
      } catch (error) {
        terminate(error instanceof ModpackError ? error : unavailable(error));
        return;
      }
      child.stdout.on('data', chunk => {
        try { decoder.push(chunk); } catch (error) { terminate(error instanceof ModpackError ? error : unavailable(error)); }
      });
      child.stdout.on('error', error => terminate(unavailable(error)));
      child.stderr.on('data', chunk => {
        if (!Buffer.isBuffer(chunk)) { terminate(unavailable()); return; }
        brokerStderrBytes += chunk.length;
        if (brokerStderrBytes > MAX_BROKER_STDERR_BYTES) terminate(unavailable());
      });
      child.stderr.on('error', error => terminate(unavailable(error)));
      child.stdin.on('error', error => terminate(unavailable(error)));
      try {
        child.stdin.end(framedRequest);
        keepaliveTimer = setInterval(() => {
          if (!writeControl('keepalive')) terminate(unavailable());
        }, this.keepaliveMs);
        keepaliveTimer.unref?.();
      } catch (error) {
        terminate(unavailable(error));
      }
    });
  }
}

module.exports = {
  ArchiveWorkerClient,
  MAX_FRAME_BYTES,
  StrictFrameDecoder,
  encodeFrame,
  parseStrictJson,
  createBrokerBundle,
  recoverBrokerBundles,
  removeBrokerBundle,
  verifyArchiveWorkerExecutable,
  verifyArchiveWorkerExecutableSync
};
