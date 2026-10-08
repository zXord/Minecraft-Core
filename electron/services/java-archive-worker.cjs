const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { ARCHIVE_LIMITS } = require('./modpacks/limits.cjs');
const { validateArchiveEntries } = require('./modpacks/archive/archive-entry-policy.cjs');
const {
  JAVA_ARCHIVE_WORKER_TOKEN_ENV,
  createJavaArchiveResponse,
  javaArchiveStagingPath,
  verifyJavaArchiveRequest
} = require('./java-archive-worker-protocol.cjs');

const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_JAVA_EXPANDED_BYTES = 1024n * 1024n * 1024n;
const MAX_JAVA_FILE_EXPANDED_BYTES = 256n * 1024n * 1024n;

function coded(code) {
  const error = new Error('Java archive extraction failed.');
  error.code = code;
  return error;
}

function identity(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return identity(left) === identity(right);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function nativeRealpath(value, fsApi = fs) {
  const implementation = fsApi.realpathSync?.native || fsApi.realpathSync;
  if (typeof implementation !== 'function') throw coded('JAVA_ARCHIVE_UNSAFE');
  return implementation.call(fsApi.realpathSync, value);
}

function canonicalDirectory(value, fsApi = fs) {
  const stat = fsApi.lstatSync(value, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(nativeRealpath(value, fsApi), value)) {
    throw coded('JAVA_ARCHIVE_UNSAFE');
  }
  return stat;
}

function canonicalFile(value, maximumBytes, fsApi = fs) {
  const stat = fsApi.lstatSync(value, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
      stat.size < 1n || stat.size > BigInt(maximumBytes) || !samePath(nativeRealpath(value, fsApi), value)) {
    throw coded(stat?.size > BigInt(maximumBytes) ? 'JAVA_ARCHIVE_TOO_LARGE' : 'JAVA_ARCHIVE_UNSAFE');
  }
  return stat;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function readPinnedArchive(payload, fsApi = fs) {
  const initial = canonicalFile(payload.archivePath, payload.maxArchiveBytes, fsApi);
  if (initial.size !== BigInt(payload.expectedArchiveSize)) throw coded('JAVA_ARCHIVE_UNSAFE');
  const constants = fsApi.constants || fs.constants;
  let flags = constants.O_RDONLY;
  if (Number.isInteger(constants.O_NOFOLLOW)) flags |= constants.O_NOFOLLOW;
  let descriptor;
  try {
    descriptor = fsApi.openSync(payload.archivePath, flags);
    const opened = fsApi.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(initial, opened)) {
      throw coded('JAVA_ARCHIVE_UNSAFE');
    }
    const bytes = Buffer.allocUnsafe(payload.expectedArchiveSize);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fsApi.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count < 1) throw coded('JAVA_ARCHIVE_UNSAFE');
      offset += count;
    }
    const probe = Buffer.allocUnsafe(1);
    if (fsApi.readSync(descriptor, probe, 0, 1, offset) !== 0) throw coded('JAVA_ARCHIVE_UNSAFE');
    const afterRead = fsApi.fstatSync(descriptor, { bigint: true });
    const afterPath = canonicalFile(payload.archivePath, payload.maxArchiveBytes, fsApi);
    if (!sameFileIdentity(opened, afterRead) || !sameFileIdentity(opened, afterPath) ||
        afterRead.size !== BigInt(payload.expectedArchiveSize)) throw coded('JAVA_ARCHIVE_UNSAFE');
    const actual = crypto.createHash('sha256').update(bytes).digest();
    const expected = Buffer.from(payload.expectedSha256, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw coded('JAVA_ARCHIVE_UNSAFE');
    }
    return bytes;
  } catch (error) {
    if (error?.code === 'JAVA_ARCHIVE_UNSAFE' || error?.code === 'JAVA_ARCHIVE_TOO_LARGE') throw error;
    throw coded('JAVA_ARCHIVE_UNSAFE');
  } finally {
    if (descriptor !== undefined) {
      try { fsApi.closeSync(descriptor); } catch { /* request fails on the surrounding operation if needed */ }
    }
  }
}

function assertSafeTree(root, directory = root, fsApi = fs) {
  const stat = fsApi.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(nativeRealpath(directory, fsApi), directory) ||
      !inside(root, directory)) throw coded('JAVA_ARCHIVE_UNSAFE');
  for (const name of fsApi.readdirSync(directory)) {
    const child = path.join(directory, name);
    const childStat = fsApi.lstatSync(child, { bigint: true });
    if (childStat.isSymbolicLink() || !inside(root, child) || !samePath(nativeRealpath(child, fsApi), child)) {
      throw coded('JAVA_ARCHIVE_UNSAFE');
    }
    if (childStat.isDirectory()) assertSafeTree(root, child, fsApi);
    else if (!childStat.isFile() || childStat.nlink !== 1n) throw coded('JAVA_ARCHIVE_UNSAFE');
  }
}

function zipEntry(entry) {
  const header = entry?.header;
  const raw = String(entry?.entryName || '');
  const pathValue = entry?.isDirectory ? raw.replace(/[/\\]+$/u, '') : raw;
  const unixMode = Number.isSafeInteger(header?.attr) ? ((header.attr >>> 16) & 0xffff) : 0;
  const symbolicLink = (unixMode & 0o170000) === 0o120000;
  return {
    path: pathValue,
    type: symbolicLink ? 'symlink' : entry?.isDirectory ? 'directory' : 'file',
    size: String(header?.size),
    packedSize: String(header?.compressedSize),
    encrypted: header?.encrypted === true,
    attributes: symbolicLink ? 'lrwxrwxrwx' : entry?.isDirectory ? 'directory' : 'regular',
    ...(symbolicLink ? { symbolicLink: 'metadata-only' } : {})
  };
}

function reviewedEntries(zip) {
  let policy;
  try {
    policy = validateArchiveEntries(zip.getEntries().map(zipEntry), ARCHIVE_LIMITS);
  } catch (error) {
    if (error?.code === 'ARCHIVE_LIMIT_EXCEEDED') throw coded('JAVA_ARCHIVE_TOO_LARGE');
    throw coded('JAVA_ARCHIVE_UNSAFE');
  }
  if (BigInt(policy.totals.expandedBytes) > MAX_JAVA_EXPANDED_BYTES) throw coded('JAVA_ARCHIVE_TOO_LARGE');
  if (policy.entries.some(entry => entry.type === 'file' &&
      BigInt(entry.size) > MAX_JAVA_FILE_EXPANDED_BYTES)) throw coded('JAVA_ARCHIVE_TOO_LARGE');
  return policy;
}

function verifyExtractedFiles(destinationPath, policy, fsApi = fs) {
  const expectedFiles = new Map(policy.entries
    .filter(entry => entry.type === 'file')
    .map(entry => [entry.canonicalPath, entry]));
  const actualFiles = new Set();
  function visit(directory, relative = '') {
    for (const name of fsApi.readdirSync(directory)) {
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const childStat = fsApi.lstatSync(child, { bigint: true });
      if (childStat.isSymbolicLink() || !inside(destinationPath, child) ||
          !samePath(nativeRealpath(child, fsApi), child)) throw coded('JAVA_ARCHIVE_UNSAFE');
      if (childStat.isDirectory()) {
        visit(child, childRelative);
        continue;
      }
      if (!childStat.isFile() || childStat.nlink !== 1n) throw coded('JAVA_ARCHIVE_UNSAFE');
      const key = childRelative.normalize('NFC').toLocaleLowerCase('en-US');
      const expected = expectedFiles.get(key);
      if (!expected || BigInt(expected.size) !== childStat.size || actualFiles.has(key)) {
        throw coded('JAVA_ARCHIVE_UNSAFE');
      }
      actualFiles.add(key);
    }
  }
  visit(destinationPath);
  if (actualFiles.size !== expectedFiles.size) throw coded('JAVA_ARCHIVE_UNSAFE');
}

function findJavaExecutableRelativePath(rootPath, fsApi = fs) {
  const executableName = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [];
  function visit(directory, relative = '') {
    for (const name of fsApi.readdirSync(directory)) {
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = fsApi.lstatSync(child, { bigint: true });
      if (stat.isDirectory()) {
        visit(child, childRelative);
      } else if (stat.isFile() && stat.nlink === 1n && name.toLowerCase() === executableName) {
        candidates.push(childRelative.replaceAll('\\', '/'));
      }
    }
  }
  visit(rootPath);
  candidates.sort((left, right) => {
    const leftDepth = left.split('/').length;
    const rightDepth = right.split('/').length;
    return leftDepth - rightDepth || left.length - right.length || left.localeCompare(right, 'en-US');
  });
  if (!candidates[0]) throw coded('JAVA_EXTRACTION_FAILED');
  return candidates[0];
}

function extractJavaZip(payload, { fsApi = fs, AdmZipImpl = AdmZip, requestId } = {}) {
  const rootPath = payload.rootPath;
  canonicalDirectory(rootPath, fsApi);
  if (!inside(rootPath, payload.archivePath) || !inside(rootPath, payload.destinationPath)) {
    throw coded('JAVA_ARCHIVE_UNSAFE');
  }
  const destinationParent = path.dirname(payload.destinationPath);
  canonicalDirectory(destinationParent, fsApi);
  if (!samePath(destinationParent, rootPath)) throw coded('JAVA_ARCHIVE_UNSAFE');
  const stagingPath = javaArchiveStagingPath(payload.destinationPath, requestId);
  if (!inside(rootPath, stagingPath) || fsApi.existsSync(stagingPath)) throw coded('JAVA_ARCHIVE_UNSAFE');

  let created = false;
  try {
    const archiveBytes = readPinnedArchive(payload, fsApi);
    const zip = new AdmZipImpl(archiveBytes);
    const policy = reviewedEntries(zip);
    fsApi.mkdirSync(stagingPath, { recursive: false, mode: 0o700 });
    created = true;
    zip.extractAllTo(stagingPath, true, false);
    verifyExtractedFiles(stagingPath, policy, fsApi);
    assertSafeTree(stagingPath, stagingPath, fsApi);
    const javaExecutableRelativePath = findJavaExecutableRelativePath(stagingPath, fsApi);
    created = false;
    return {
      entryCount: policy.totals.entryCount,
      expandedBytes: policy.totals.expandedBytes,
      javaExecutableRelativePath
    };
  } catch (error) {
    if (created && fsApi.existsSync(stagingPath)) {
      try { fsApi.rmSync(stagingPath, { recursive: true, force: true }); } catch { /* failure remains closed */ }
    }
    if (error?.code === 'JAVA_ARCHIVE_UNSAFE' || error?.code === 'JAVA_ARCHIVE_TOO_LARGE') throw error;
    throw coded('JAVA_EXTRACTION_FAILED');
  }
}

function startJavaArchiveWorker(options = {}) {
  const processRef = options.processRef || process;
  const fsApi = options.fsApi || fs;
  const environment = processRef.env || {};
  const token = environment[JAVA_ARCHIVE_WORKER_TOKEN_ENV];
  delete environment[JAVA_ARCHIVE_WORKER_TOKEN_ENV];
  const requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? options.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  let accepted = false;
  let finished = false;
  let requestTimer = null;

  const hardExit = code => {
    if (finished) return;
    finished = true;
    clearTimeout(requestTimer);
    processRef.exit(code);
  };
  const sendAndExit = (response, code) => {
    if (finished) return;
    finished = true;
    clearTimeout(requestTimer);
    const exitTimer = setTimeout(() => processRef.exit(70), 1000);
    try {
      if (!processRef.connected || typeof processRef.send !== 'function') {
        clearTimeout(exitTimer);
        processRef.exit(70);
        return;
      }
      processRef.send(response, error => {
        clearTimeout(exitTimer);
        if (!error) {
          try { processRef.disconnect?.(); } catch { /* process exit remains authoritative */ }
        }
        processRef.exit(error ? 70 : code);
      });
    } catch {
      clearTimeout(exitTimer);
      processRef.exit(70);
    }
  };

  processRef.once?.('disconnect', () => hardExit(65));
  processRef.on?.('message', message => {
    if (finished) return;
    if (accepted) { hardExit(64); return; }
    accepted = true;
    clearTimeout(requestTimer);
    let verified;
    try { verified = verifyJavaArchiveRequest(message, token); }
    catch { hardExit(64); return; }

    try {
      const result = (options.extractImpl || extractJavaZip)(verified.payload, {
        fsApi,
        requestId: verified.requestId
      });
      sendAndExit(createJavaArchiveResponse({ token, requestId: verified.requestId, ok: true, result }), 0);
    } catch (error) {
      const code = ['JAVA_ARCHIVE_UNSAFE', 'JAVA_ARCHIVE_TOO_LARGE'].includes(error?.code)
        ? error.code
        : 'JAVA_EXTRACTION_FAILED';
      sendAndExit(createJavaArchiveResponse({ token, requestId: verified.requestId, ok: false, code }), 1);
    }
  });
  requestTimer = setTimeout(() => hardExit(64), requestTimeoutMs);
  requestTimer.unref?.();
  return { started: true };
}

if (require.main === module) startJavaArchiveWorker();

module.exports = { extractJavaZip, startJavaArchiveWorker };
