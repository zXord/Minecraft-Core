const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, spawn, spawnSync } = require('child_process');
const { fetch } = require('../../utils/fetch.cjs');
const { promisify } = require('util');
const { runJavaArchiveWorker } = require('../java-archive-worker-client.cjs');
const {
  assertSafeRemoteUrl,
  isPathInside,
  safeBaseName,
  safeFilePath
} = require('../../utils/security-boundaries.cjs');

const DEFAULT_JAVA_METADATA_BYTES = 2 * 1024 * 1024;
const DEFAULT_JAVA_METADATA_TIMEOUT_MS = 60 * 1000;
const DEFAULT_JAVA_ARCHIVE_BYTES = 256 * 1024 * 1024;
const DEFAULT_JAVA_REQUEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_JAVA_ARCHIVE_IDLE_TIMEOUT_MS = 90 * 1000;
const DEFAULT_JAVA_ARCHIVE_TIMEOUT_MS = 30 * 60 * 1000;

function javaAcquisitionError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function positiveSafeInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

function cancelledError(cause) {
  return javaAcquisitionError('CANCELLED', 'Java acquisition was cancelled', cause);
}

function createOperationDeadline(upstreamSignal, timeoutMs, timeoutError) {
  const controller = new AbortController();
  let settled = false;
  let rejectFailure;
  const failure = new Promise((resolve, reject) => {
    rejectFailure = reject;
  });
  const abort = error => {
    if (settled) return;
    settled = true;
    rejectFailure(error);
    controller.abort(error);
  };
  const onAbort = () => abort(cancelledError(upstreamSignal.reason));
  if (upstreamSignal) {
    if (upstreamSignal.aborted) onAbort();
    else upstreamSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => abort(timeoutError()), timeoutMs);
  return {
    signal: controller.signal,
    abort,
    race(promise) { return Promise.race([promise, failure]); },
    cleanup() {
      clearTimeout(timer);
      if (upstreamSignal) upstreamSignal.removeEventListener('abort', onAbort);
    }
  };
}

function createResettableAbortTimer(abort, timeoutMs, errorFactory) {
  let timer = null;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort(errorFactory()), timeoutMs);
  };
  return {
    reset,
    cleanup() { clearTimeout(timer); }
  };
}

function responseContentLength(response, code = 'JAVA_METADATA_TOO_LARGE', label = 'Java metadata') {
  const value = response?.headers?.get?.('content-length');
  if (value === null || value === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/u.test(String(value))) {
    throw javaAcquisitionError(code, `${label} response size is invalid`);
  }
  return Number(value);
}

async function readBoundedResponseBody(response, maximumBytes) {
  const declaredBytes = responseContentLength(response);
  if (declaredBytes !== null && declaredBytes > maximumBytes) {
    response?.body?.destroy?.();
    throw javaAcquisitionError('JAVA_METADATA_TOO_LARGE', 'Java metadata response exceeded the configured limit');
  }
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
    throw javaAcquisitionError('JAVA_METADATA_INVALID', 'Java metadata response body is invalid');
  }
  const chunks = [];
  let measuredBytes = 0;
  for await (const value of response.body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    measuredBytes += chunk.length;
    if (measuredBytes > maximumBytes) {
      response.body.destroy?.();
      throw javaAcquisitionError('JAVA_METADATA_TOO_LARGE', 'Java metadata response exceeded the configured limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, measuredBytes);
}

async function measureLocalJavaArchive(archivePath, maximumBytes, signal) {
  if (signal?.aborted) throw cancelledError(signal.reason);
  const before = await fs.promises.lstat(archivePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n) {
    throw javaAcquisitionError('JAVA_ARCHIVE_UNSAFE', 'Java archive is not a safe regular file');
  }
  if (before.size > BigInt(maximumBytes)) {
    throw javaAcquisitionError('JAVA_ARCHIVE_TOO_LARGE', 'Java archive exceeded the configured limit');
  }
  const digest = crypto.createHash('sha256');
  const stream = fs.createReadStream(archivePath);
  const onAbort = () => stream.destroy(cancelledError(signal.reason));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let measured = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      measured += chunk.length;
      if (!Number.isSafeInteger(measured) || measured > maximumBytes || BigInt(measured) > before.size) {
        throw javaAcquisitionError('JAVA_ARCHIVE_UNSAFE', 'Java archive changed while it was being measured');
      }
      digest.update(chunk);
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    stream.destroy();
  }
  const after = await fs.promises.lstat(archivePath, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      BigInt(measured) !== before.size) {
    throw javaAcquisitionError('JAVA_ARCHIVE_UNSAFE', 'Java archive changed while it was being measured');
  }
  return {
    expectedArchiveSize: measured,
    expectedSha256: digest.digest('hex')
  };
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Server and client folders may be reached through a junction, symlink, SUBST or
// mapped drive. Only the parent is resolved, so a link at the path itself is
// never followed.
function underCanonicalParent(value) {
  const resolved = path.resolve(value);
  return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
}

// The archive worker accepts only canonical paths, so the extraction folder keeps
// its name under the canonical Java folder. A destination that is not directly
// inside that folder is refused, never moved there.
function javaExtractionDestination(rootPath, extractPath) {
  const outside = cause => javaAcquisitionError(
    'JAVA_EXTRACTION_FAILED',
    'Java extraction destination is outside the Java directory',
    cause
  );
  let destinationPath;
  try {
    destinationPath = underCanonicalParent(extractPath);
  } catch (error) {
    throw outside(error);
  }
  if (comparablePath(path.dirname(destinationPath)) !== comparablePath(rootPath)) throw outside();
  return path.join(rootPath, path.basename(destinationPath));
}

function executableFromWorkerResult(extractPath, result) {
  const relative = result?.javaExecutableRelativePath;
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') ||
      relative.split('/').some(component => !component || component === '.' || component === '..')) {
    throw javaAcquisitionError('JAVA_EXTRACTION_FAILED', 'Java extraction did not return a valid executable');
  }
  const executablePath = path.resolve(extractPath, ...relative.split('/'));
  if (!isPathInside(executablePath, extractPath)) {
    throw javaAcquisitionError('JAVA_EXTRACTION_FAILED', 'Java extraction did not return a valid executable');
  }
  // The realpath rule is measured under the canonical extraction folder: the
  // executable must resolve to exactly that path, so no link at or below the
  // folder is followed. The caller's own spelling of the folder is returned.
  let canonicalExecutablePath;
  let resolvedExecutablePath;
  let stat;
  try {
    canonicalExecutablePath = path.resolve(underCanonicalParent(extractPath), ...relative.split('/'));
    stat = fs.lstatSync(canonicalExecutablePath, { bigint: true });
    resolvedExecutablePath = fs.realpathSync.native(executablePath);
  } catch (error) {
    throw javaAcquisitionError('JAVA_EXTRACTION_FAILED', 'Java extraction verification failed', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
      comparablePath(resolvedExecutablePath) !== comparablePath(canonicalExecutablePath)) {
    throw javaAcquisitionError('JAVA_EXTRACTION_FAILED', 'Java extraction verification failed');
  }
  return executablePath;
}

// Java Manager class to handle downloading and managing Java runtimes
class JavaManager {
  beforeFilesystemMutation() {}

  constructor(clientPath = null, options = {}) {
    this.platform = this.getPlatformString();
    this.architecture = this.getArchitectureString();
    this.clientPath = clientPath;
    this.isScopedJavaDir = Boolean(clientPath);
    this.fetch = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
    this.maxMetadataBytes = positiveSafeInteger(
      options.maxMetadataBytes,
      DEFAULT_JAVA_METADATA_BYTES,
      DEFAULT_JAVA_METADATA_BYTES
    );
    this.metadataTimeoutMs = positiveSafeInteger(
      options.metadataTimeoutMs,
      DEFAULT_JAVA_METADATA_TIMEOUT_MS,
      5 * 60 * 1000
    );
    this.maxArchiveBytes = positiveSafeInteger(
      options.maxArchiveBytes,
      DEFAULT_JAVA_ARCHIVE_BYTES,
      DEFAULT_JAVA_ARCHIVE_BYTES
    );
    this.requestTimeoutMs = positiveSafeInteger(
      options.requestTimeoutMs,
      DEFAULT_JAVA_REQUEST_TIMEOUT_MS,
      5 * 60 * 1000
    );
    this.archiveIdleTimeoutMs = positiveSafeInteger(
      options.archiveIdleTimeoutMs,
      DEFAULT_JAVA_ARCHIVE_IDLE_TIMEOUT_MS,
      5 * 60 * 1000
    );
    this.archiveTimeoutMs = positiveSafeInteger(
      options.archiveTimeoutMs,
      DEFAULT_JAVA_ARCHIVE_TIMEOUT_MS,
      60 * 60 * 1000
    );

    // Use client-specific Java directory if clientPath is provided
    if (clientPath) {
      this.javaBaseDir = path.join(clientPath, 'java');
    } else {
      // Fallback to global directory for backwards compatibility
      this.javaBaseDir = path.join(os.homedir(), '.minecraft-core', 'java');
    }
    
  }
  
  // Update client path and Java directory
  setClientPath(clientPath) {
    this.clientPath = clientPath;
    this.isScopedJavaDir = Boolean(clientPath);
    this.javaBaseDir = clientPath
      ? path.join(clientPath, 'java')
      : path.join(os.homedir(), '.minecraft-core', 'java');
    
  }
  
  getPlatformString() {
    switch (process.platform) {
      case 'win32': return 'windows';
      case 'darwin': return 'mac';
      case 'linux': return 'linux';
      default: return 'linux';
    }
  }
  
  getArchitectureString() {
    switch (process.arch) {
      case 'x64': return 'x64';
      case 'arm64': return 'aarch64';
      case 'ia32': return 'x32';
      default: return 'x64';
    }
  }
  
  getJavaExecutablePath(javaVersion) {
    const javaDir = path.join(this.javaBaseDir, `java-${javaVersion}`);
    
    
    if (!fs.existsSync(javaDir)) {
      return null;
    }
    
    // Recursive function to find Java executable in any subdirectory
    const findJavaExecutableRecursively = (dir, maxDepth = 5, currentDepth = 0) => {
      if (currentDepth > maxDepth) {
        return null;
      }

      const items = fs.readdirSync(dir);
      const binDir = path.join(dir, 'bin');
      if (fs.existsSync(binDir)) {
        const possibleExecutables = this.platform === 'windows' ? ['javaw.exe', 'java.exe'] : ['java'];
        for (const exe of possibleExecutables) {
          const exePath = path.join(binDir, exe);
          if (fs.existsSync(exePath)) {
            return exePath;
          }
        }
      }

      for (const item of items) {
        const itemPath = path.join(dir, item);
        if (fs.statSync(itemPath).isDirectory()) {
          const result = findJavaExecutableRecursively(itemPath, maxDepth, currentDepth + 1);
          if (result) {
            return result;
          }
        }
      }

      return null;
    };
    
    // Start the recursive search
    const foundExecutable = findJavaExecutableRecursively(javaDir);
    
    if (foundExecutable) {
      return foundExecutable;
    }
    
    return null;
  }

  calculateFileHash(filePath, algorithm = 'sha256') {
    const hash = crypto.createHash(algorithm);
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  }

  assertArchiveEntriesSafe(entries, extractPath) {
    const resolvedExtractPath = path.resolve(extractPath);
    for (const entryName of entries) {
      const normalized = String(entryName || '').replace(/\\/g, '/');
      if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
        throw new Error(`Unsafe archive entry: ${entryName}`);
      }
      const resolvedEntryPath = path.resolve(resolvedExtractPath, normalized);
      if (!isPathInside(resolvedEntryPath, resolvedExtractPath)) {
        throw new Error(`Archive entry escapes extraction directory: ${entryName}`);
      }
    }
  }

  getJvmLibraryPath(javaExecutablePath) {
    if (!javaExecutablePath) {
      return null;
    }

    const binDir = path.dirname(javaExecutablePath);
    switch (this.platform) {
      case 'windows':
        return path.join(binDir, 'server', 'jvm.dll');
      case 'mac':
        return path.resolve(binDir, '..', 'lib', 'server', 'libjvm.dylib');
      default:
        return path.resolve(binDir, '..', 'lib', 'server', 'libjvm.so');
    }
  }

  validateJavaExecutable(javaExecutablePath) {
    if (!javaExecutablePath) {
      return {
        valid: false,
        code: 'JAVA_EXECUTABLE_MISSING',
        message: 'Java executable not found'
      };
    }

    if (!fs.existsSync(javaExecutablePath)) {
      return {
        valid: false,
        code: 'JAVA_EXECUTABLE_MISSING',
        message: 'Java executable path does not exist',
        javaPath: javaExecutablePath
      };
    }

    const jvmLibraryPath = this.getJvmLibraryPath(javaExecutablePath);
    if (jvmLibraryPath && !fs.existsSync(jvmLibraryPath)) {
      return {
        valid: false,
        code: 'JAVA_RUNTIME_INCOMPLETE',
        message: `Java runtime is missing JVM components at ${jvmLibraryPath}`,
        javaPath: javaExecutablePath,
        jvmLibraryPath
      };
    }

    try {
      const result = spawnSync(javaExecutablePath, ['-version'], {
        timeout: 10000,
        windowsHide: true,
        encoding: 'utf8'
      });

      if (result.error) {
        return {
          valid: false,
          code: 'JAVA_VERSION_CHECK_FAILED',
          message: result.error.message,
          javaPath: javaExecutablePath,
          jvmLibraryPath
        };
      }

      if (typeof result.status === 'number' && result.status !== 0) {
        const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
        const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
        return {
          valid: false,
          code: 'JAVA_VERSION_CHECK_FAILED',
          message: stderr || stdout || `java -version exited with code ${result.status}`,
          javaPath: javaExecutablePath,
          jvmLibraryPath
        };
      }

      return {
        valid: true,
        code: 'JAVA_VALID',
        message: 'Java runtime is valid',
        javaPath: javaExecutablePath,
        jvmLibraryPath
      };
    } catch (error) {
      return {
        valid: false,
        code: 'JAVA_VERSION_CHECK_FAILED',
        message: error.message,
        javaPath: javaExecutablePath,
        jvmLibraryPath
      };
    }
  }

  getJavaValidationStatus(requiredJavaVersion) {
    const requiredVersion = parseInt(requiredJavaVersion);
    const invalidResult = {
      requiredJavaVersion,
      state: 'missing',
      isInstalled: false,
      javaPath: null,
      validation: null
    };

    if (!fs.existsSync(this.javaBaseDir)) {
      return invalidResult;
    }

    try {
      if (!Number.isFinite(requiredVersion) || requiredVersion <= 0) {
        return invalidResult;
      }

      const executablePath = this.getJavaExecutablePath(requiredVersion.toString());
      if (!executablePath) {
        return invalidResult;
      }

      const validation = this.validateJavaExecutable(executablePath);
      if (validation.valid) {
        return {
          requiredJavaVersion,
          state: 'available',
          isInstalled: true,
          javaPath: executablePath,
          validation
        };
      }

      return {
        requiredJavaVersion,
        state: 'broken',
        isInstalled: false,
        javaPath: executablePath,
        validation
      };
    } catch {
      return invalidResult;
    }
  }

  isJavaInstalled(requiredJavaVersion) {
    return this.getJavaValidationStatus(requiredJavaVersion).isInstalled;
  }

  getBestJavaPath(requiredJavaVersion) {
    return this.getJavaValidationStatus(requiredJavaVersion).javaPath;
  }

  getManagedJavaVersionFromPath(javaExecutablePath) {
    if (!javaExecutablePath || !this.javaBaseDir) {
      return null;
    }

    const relativePath = path.relative(this.javaBaseDir, javaExecutablePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }

    const [topLevelSegment] = relativePath.split(path.sep);
    const versionMatch = typeof topLevelSegment === 'string'
      ? topLevelSegment.match(/^java-(\d+)$/)
      : null;

    return versionMatch ? versionMatch[1] : null;
  }

  async cleanupUnusedJavaVersions(requiredJavaVersion, javaPath = null) {
    if (!this.isScopedJavaDir) {
      return {
        success: true,
        skipped: true,
        reason: 'shared-java-directory',
        cleanedVersions: [],
        keptVersions: []
      };
    }

    if (!fs.existsSync(this.javaBaseDir)) {
      return {
        success: true,
        cleanedVersions: [],
        keptVersions: []
      };
    }

    const activeJavaVersion = this.getManagedJavaVersionFromPath(javaPath);
    if (!activeJavaVersion) {
      return {
        success: true,
        skipped: true,
        reason: 'active-java-version-unknown',
        requiredJavaVersion,
        cleanedVersions: [],
        keptVersions: []
      };
    }

    const javaDirs = fs.readdirSync(this.javaBaseDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^java-\d+$/.test(entry.name))
      .map(entry => entry.name.replace('java-', ''));

    const cleanedVersions = [];
    const failedVersions = [];
    const keptVersions = javaDirs.filter(version => version === activeJavaVersion);

    for (const version of javaDirs) {
      if (version === activeJavaVersion) {
        continue;
      }

      const versionDir = path.join(this.javaBaseDir, `java-${version}`);

      try {
        await this.removeDirectoryWithRetry(versionDir, 3);
        if (!fs.existsSync(versionDir)) {
          cleanedVersions.push(version);
        } else {
          failedVersions.push(version);
        }
      } catch {
        failedVersions.push(version);
      }
    }

    return {
      success: failedVersions.length === 0,
      requiredJavaVersion,
      activeJavaVersion,
      cleanedVersions,
      failedVersions,
      keptVersions
    };
  }

    async downloadJava(javaVersion, progressCallback, options = {}) {
    if (options?.signal?.aborted) throw cancelledError(options.signal.reason);
    if (progressCallback) {
      progressCallback({ type: 'Preparing', task: `Preparing to download Java ${javaVersion}...`, progress: 0 });
    }
    
    // Get download URL from Adoptium API
    const apiUrl = `https://api.adoptium.net/v3/assets/latest/${javaVersion}/hotspot?architecture=${this.architecture}&image_type=jre&os=${this.platform}&vendor=eclipse`;
    
    
    const metadataDeadline = createOperationDeadline(
      options?.signal,
      this.metadataTimeoutMs,
      () => javaAcquisitionError('JAVA_METADATA_TIMEOUT', 'Java metadata request timed out')
    );
    let response;
    let metadataBody;
    try {
      response = await metadataDeadline.race(this.fetch(apiUrl, { signal: metadataDeadline.signal }));
      if (!response.ok) {
        throw new Error(`Failed to get Java download info: ${response.status} ${response.statusText}`);
      }
      metadataBody = await metadataDeadline.race(readBoundedResponseBody(response, this.maxMetadataBytes));
    } catch (error) {
      response?.body?.destroy?.();
      throw error;
    } finally {
      metadataDeadline.cleanup();
    }
    let releases;
    try {
      releases = JSON.parse(metadataBody.toString('utf8'));
    } catch (error) {
      throw javaAcquisitionError('JAVA_METADATA_INVALID', 'Java metadata response is invalid', error);
    }
    if (!releases || releases.length === 0) {
      throw new Error(`No Java ${javaVersion} release found for ${this.platform} ${this.architecture}`);
    }
    
    const release = releases[0];
    const downloadUrl = assertSafeRemoteUrl(release.binary.package.link, { allowedProtocols: ['https:'] });
    const filename = safeBaseName(release.binary.package.name, 'Java archive file name', {
      allowedExtensions: ['.zip', '.tar.gz']
    });
    const expectedChecksum = typeof release.binary.package.checksum === 'string'
      ? release.binary.package.checksum.trim().toLowerCase()
      : '';
    if (!/^[a-f0-9]{64}$/u.test(expectedChecksum)) {
      throw javaAcquisitionError('JAVA_METADATA_INVALID', 'Java runtime checksum metadata is invalid');
    }
    const packageSizeValue = release.binary.package.size;
    if (packageSizeValue !== undefined &&
        (!Number.isSafeInteger(packageSizeValue) || packageSizeValue < 1)) {
      throw javaAcquisitionError('JAVA_METADATA_INVALID', 'Java archive size metadata is invalid');
    }
    const expectedArchiveSize = packageSizeValue === undefined ? null : packageSizeValue;
    if (expectedArchiveSize !== null && expectedArchiveSize > this.maxArchiveBytes) {
      throw javaAcquisitionError('JAVA_ARCHIVE_TOO_LARGE', 'Java archive exceeded the configured limit');
    }
    
    
    if (progressCallback) {
      progressCallback({ type: 'Downloading', task: `Downloading ${filename}...`, progress: 0 });
    }
    
    const archiveDeadline = createOperationDeadline(
      options?.signal,
      this.archiveTimeoutMs,
      () => javaAcquisitionError('JAVA_DOWNLOAD_TIMEOUT', 'Java archive download timed out')
    );
    const headerTimer = createResettableAbortTimer(
      archiveDeadline.abort,
      this.requestTimeoutMs,
      () => javaAcquisitionError('JAVA_DOWNLOAD_TIMEOUT', 'Java archive request timed out')
    );
    const idleTimer = createResettableAbortTimer(
      archiveDeadline.abort,
      this.archiveIdleTimeoutMs,
      () => javaAcquisitionError('JAVA_DOWNLOAD_STALLED', 'Java archive download stopped making progress')
    );
    let downloadResponse;
    let fileHandle;
    let tempFile;
    let onArchiveAbort;
    let operationError = null;
    try {
      headerTimer.reset();
      downloadResponse = await archiveDeadline.race(
        this.fetch(downloadUrl, { signal: archiveDeadline.signal })
      );
      headerTimer.cleanup();
      if (!downloadResponse.ok) {
        throw new Error(`Failed to download Java: ${downloadResponse.status} ${downloadResponse.statusText}`);
      }
      if (!downloadResponse.body || typeof downloadResponse.body[Symbol.asyncIterator] !== 'function') {
        throw javaAcquisitionError('JAVA_DOWNLOAD_FAILED', 'Java archive response body is invalid');
      }

      const totalSize = responseContentLength(downloadResponse, 'JAVA_ARCHIVE_TOO_LARGE', 'Java archive');
      if (totalSize !== null && totalSize > this.maxArchiveBytes) {
        downloadResponse.body.destroy?.();
        throw javaAcquisitionError('JAVA_ARCHIVE_TOO_LARGE', 'Java archive exceeded the configured limit');
      }
      if (totalSize !== null && expectedArchiveSize !== null && totalSize !== expectedArchiveSize) {
        downloadResponse.body.destroy?.();
        throw javaAcquisitionError('JAVA_ARCHIVE_SIZE_MISMATCH', 'Java archive size did not match metadata');
      }

      const tempDir = path.join(this.javaBaseDir, 'temp');
      if (!fs.existsSync(tempDir)) {
        this.beforeFilesystemMutation(tempDir);
        fs.mkdirSync(tempDir, { recursive: true });
      }
      tempFile = safeFilePath(
        tempDir,
        `${crypto.randomUUID()}-${filename}`,
        'Java archive file name',
        { allowedExtensions: ['.zip', '.tar.gz'] }
      );
      this.beforeFilesystemMutation(tempFile);
      fileHandle = await fs.promises.open(tempFile, 'wx', 0o600);

      const digest = crypto.createHash('sha256');
      let downloadedSize = 0;
      const expectedProgressSize = totalSize || expectedArchiveSize;
      onArchiveAbort = () => downloadResponse?.body?.destroy?.(archiveDeadline.signal.reason);
      archiveDeadline.signal.addEventListener('abort', onArchiveAbort, { once: true });
      idleTimer.reset();

      const transfer = (async () => {
        try {
          for await (const value of downloadResponse.body) {
            idleTimer.reset();
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const nextSize = downloadedSize + chunk.length;
            if (!Number.isSafeInteger(nextSize) || nextSize > this.maxArchiveBytes) {
              throw javaAcquisitionError('JAVA_ARCHIVE_TOO_LARGE', 'Java archive exceeded the configured limit');
            }
            if ((totalSize !== null && nextSize > totalSize) ||
                (expectedArchiveSize !== null && nextSize > expectedArchiveSize)) {
              throw javaAcquisitionError('JAVA_ARCHIVE_SIZE_MISMATCH', 'Java archive size did not match metadata');
            }
            digest.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await fileHandle.write(chunk, offset, chunk.length - offset, null);
              if (!bytesWritten) {
                throw javaAcquisitionError('JAVA_DOWNLOAD_FAILED', 'Java archive could not be written');
              }
              offset += bytesWritten;
            }
            downloadedSize = nextSize;
            const progress = expectedProgressSize
              ? Math.round((downloadedSize / expectedProgressSize) * 100)
              : 0;
            if (progressCallback && progress % 5 === 0) {
              progressCallback({
                type: 'Downloading',
                task: `Downloading ${filename}...`,
                progress,
                downloadedMB: Math.round(downloadedSize / 1024 / 1024),
                totalMB: Math.round((expectedProgressSize || 0) / 1024 / 1024)
              });
            }
          }
        } catch (error) {
          if (error?.code === 'CANCELLED' || String(error?.code || '').startsWith('JAVA_')) throw error;
          throw javaAcquisitionError('JAVA_DOWNLOAD_FAILED', 'Java archive download failed', error);
        }
      })();
      try {
        await archiveDeadline.race(transfer);
      } catch (error) {
        downloadResponse.body.destroy?.(error);
        await transfer.catch(() => {});
        throw error;
      }
      idleTimer.cleanup();

      if ((totalSize !== null && downloadedSize !== totalSize) ||
          (expectedArchiveSize !== null && downloadedSize !== expectedArchiveSize)) {
        throw javaAcquisitionError('JAVA_ARCHIVE_SIZE_MISMATCH', 'Java archive size did not match metadata');
      }
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;

      const actualChecksum = digest.digest('hex').toLowerCase();
      if (actualChecksum !== expectedChecksum) {
        throw javaAcquisitionError('JAVA_CHECKSUM_MISMATCH', 'Java runtime checksum verification failed');
      }

      archiveDeadline.cleanup();
      if (onArchiveAbort) {
        archiveDeadline.signal.removeEventListener('abort', onArchiveAbort);
        onArchiveAbort = null;
      }
      downloadResponse.body.destroy?.();
      if (options?.signal?.aborted) throw cancelledError(options.signal.reason);
      if (progressCallback) {
        progressCallback({ type: 'Extracting', task: 'Extracting Java runtime...', progress: 0 });
      }
      const extractionResult = await this.extractJava(tempFile, javaVersion, {
        signal: options?.signal,
        expectedArchiveSize: downloadedSize,
        expectedSha256: actualChecksum
      });

      if (progressCallback) {
        progressCallback({ type: 'Verifying', task: 'Verifying Java installation...', progress: 90 });
      }
      const extractPath = path.join(this.javaBaseDir, `java-${javaVersion}`);
      const javaExe = filename.toLowerCase().endsWith('.zip')
        ? executableFromWorkerResult(extractPath, extractionResult)
        : this.getJavaExecutablePath(javaVersion);
      if (!javaExe) throw javaAcquisitionError('JAVA_EXTRACTION_FAILED', 'Java extraction verification failed');

      const execAsync = promisify(exec);
      let testJavaPath = javaExe;
      if (process.platform === 'win32' && javaExe.includes('java.exe')) {
        testJavaPath = javaExe.replace('java.exe', 'javaw.exe');
      }
      await execAsync(`"${testJavaPath}" -version`, {
        timeout: 5000,
        windowsHide: true
      }).catch(() => {});

      if (progressCallback) {
        progressCallback({ type: 'Complete', task: `Java ${javaVersion} ready!`, progress: 100 });
      }
      return { success: true, javaPath: javaExe };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      headerTimer.cleanup();
      idleTimer.cleanup();
      archiveDeadline.cleanup();
      if (onArchiveAbort) archiveDeadline.signal.removeEventListener('abort', onArchiveAbort);
      downloadResponse?.body?.destroy?.();
      if (fileHandle) await fileHandle.close().catch(() => {});
      if (tempFile && fs.existsSync(tempFile) && operationError?.preserveWorkspace !== true) {
        this.beforeFilesystemMutation(tempFile);
        try { fs.rmSync(tempFile, { force: true }); }
        catch (cleanupError) {
          if (!operationError) throw cleanupError;
        }
      }
    }
  }
    async extractJava(archivePath, javaVersion, options = {}) {
    const extractPath = path.join(this.javaBaseDir, `java-${javaVersion}`);

    if (archivePath.endsWith('.tar.gz')) {
      if (fs.existsSync(extractPath)) {
        this.beforeFilesystemMutation(extractPath);
        fs.rmSync(extractPath, { recursive: true, force: true });
      }
      await this.extractTarGz(archivePath, extractPath);
    } else if (archivePath.endsWith('.zip')) {
      return this.extractZip(archivePath, extractPath, options);
    } else {
      throw new Error('Unsupported archive format');
    }
  }
    async extractZip(zipPath, extractPath, options = {}) {
    const rootPath = fs.realpathSync.native(this.javaBaseDir);
    const destinationPath = javaExtractionDestination(rootPath, extractPath);
    const archivePath = fs.realpathSync.native(zipPath);
    const suppliedSize = options?.expectedArchiveSize;
    const suppliedSha256 = options?.expectedSha256;
    let archiveEvidence;
    if (suppliedSize === undefined && suppliedSha256 === undefined) {
      archiveEvidence = await measureLocalJavaArchive(archivePath, this.maxArchiveBytes, options?.signal);
    } else if (Number.isSafeInteger(suppliedSize) && suppliedSize > 0 && suppliedSize <= this.maxArchiveBytes &&
        typeof suppliedSha256 === 'string' && /^[a-f0-9]{64}$/u.test(suppliedSha256)) {
      archiveEvidence = { expectedArchiveSize: suppliedSize, expectedSha256: suppliedSha256 };
    } else {
      throw javaAcquisitionError('JAVA_ARCHIVE_UNSAFE', 'Java archive verification evidence is invalid');
    }
    this.beforeFilesystemMutation(extractPath);
    return runJavaArchiveWorker({
      rootPath,
      archivePath,
      destinationPath,
      maxArchiveBytes: this.maxArchiveBytes,
      ...archiveEvidence,
      ...(options?.signal ? { signal: options.signal } : {})
    });
  }
  
  async extractTarGz(tarPath, extractPath) {
    // const { spawn } = require('child_process'); // Now top-level
    const listing = spawnSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
    if (listing.status !== 0) {
      throw new Error(`TAR listing failed: ${listing.stderr || listing.error?.message || 'unknown error'}`);
    }
    this.assertArchiveEntriesSafe(String(listing.stdout || '').split(/\r?\n/).filter(Boolean), extractPath);
    
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(extractPath)) {
        this.beforeFilesystemMutation(extractPath);
        fs.mkdirSync(extractPath, { recursive: true });
      }
      
      this.beforeFilesystemMutation(extractPath);
      const tar = spawn('tar', ['-xzf', tarPath, '-C', extractPath], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      tar.on('close', (code) => {
        if (code === 0) {
          
          // Find the Java directory (it might be nested)
          const contents = fs.readdirSync(extractPath);
          if (contents.length === 1 && fs.statSync(path.join(extractPath, contents[0])).isDirectory()) {
            // Move contents up one level
            const nestedDir = path.join(extractPath, contents[0]);
            const tempDir = extractPath + '_temp';
            
            fs.renameSync(nestedDir, tempDir);
            fs.rmSync(extractPath, { recursive: true });
            fs.renameSync(tempDir, extractPath);
          }
          
          resolve();
        } else {
          reject(new Error(`TAR extraction failed with code ${code}`));
        }
      });
      
      tar.on('error', reject);
    });
  }
  
  async ensureJava(requiredJavaVersion, progressCallback, options = {}) {
    if (options?.signal?.aborted) throw cancelledError(options.signal.reason);
    const validationStatus = this.getJavaValidationStatus(requiredJavaVersion);

    if (validationStatus.isInstalled && validationStatus.javaPath) {
      const cleanup = await this.cleanupUnusedJavaVersions(requiredJavaVersion, validationStatus.javaPath);
      return {
        success: true,
        javaPath: validationStatus.javaPath,
        cleanup
      };
    }

    const result = await this.downloadJava(requiredJavaVersion, progressCallback, options);
    if (!result?.success || !result.javaPath) {
      return result;
    }

    const cleanup = await this.cleanupUnusedJavaVersions(requiredJavaVersion, result.javaPath);
    return {
      ...result,
      cleanup
    };
  }
  async removeDirectoryWithRetry(dirPath, maxRetries = 5) {
    if (fs.existsSync(dirPath)) {
      this.beforeFilesystemMutation(dirPath);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        
        if (fs.existsSync(dirPath)) {
          // On Windows, sometimes we need to wait for file handles to be released
          if (attempt > 1) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          }
          
          // Make all files and directories writable first
          const makeWritableRecursive = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const itemPath = path.join(dir, item);
              const stat = fs.statSync(itemPath);
              fs.chmodSync(itemPath, 0o777);
              if (stat.isDirectory()) {
                makeWritableRecursive(itemPath);
              }
            }
          };

          makeWritableRecursive(dirPath);
          fs.chmodSync(dirPath, 0o777);
          
          // Try to remove the directory
          fs.rmSync(dirPath, { 
            recursive: true, 
            force: true,
            maxRetries: 3,
            retryDelay: 1000
          });
        }
        
        return; // Success!
        
      } catch (error) {
        
        if (attempt === maxRetries) {
          if (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'ENOTEMPTY') {
            // Create a unique temp name and leave the old directory
            const timestamp = Date.now();
            const tempName = `${dirPath}_old_${timestamp}`;            try {
              fs.renameSync(dirPath, tempName);
              return; // Consider this success
            } catch {
              // Continue with extraction anyway
            }
          }
          
          return; // Don't throw error, just continue
        }
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt * attempt));
      }
    }
  }
}

module.exports = { JavaManager };
