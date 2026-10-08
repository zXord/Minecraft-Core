const { annotateRuntimeError, runtimeDiagnosticFor, runRuntimeStage, runRuntimeStageSync, changedIdentityFields } = require('./runtime-diagnostic.cjs');
const { safeSend } = require('../utils/safe-send.cjs');
const {
  installFabric: installFabricXmcl,
  getLoaderArtifactListFor,
  getForgeVersionList,
  installVersion,
  installLibraries,
  walkForgeInstallerEntries,
  unpackForgeInstaller,
  installByProfileTask,
  isForgeInstallerEntries
} = require('@xmcl/installer');
const { runForgeInstallerWorker } = require('./forge-installer-worker-client.cjs');
const { runForgeRuntimeFinalizerWorker } = require('./forge-runtime-finalizer-worker-client.cjs');
const { runManagedRuntimeWorker } = require('./managed-runtime-worker-client.cjs');
const { retainRuntimeWorkerQuiescence, waitForRuntimeWorkerQuiescence } = require('./runtime-worker-quiescence.cjs');
const { MANAGED_RUNTIME_PREPARE_OPERATION } = require('./managed-runtime-worker-protocol.cjs');
const { Version, MinecraftFolder } = require('@xmcl/core');
const { open: openZip, readEntry } = require('@xmcl/unzip');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { fetch } = require('../utils/fetch.cjs');
const { PinnedHttpsClient } = require('./modpacks/network/pinned-https-client.cjs');
const { isSafeWindowsBasename } = require('./modpacks/windows-basename.cjs');
const { normalizeRuntimeTuple } = require('./modpacks/contracts.cjs');
const minecraftRuntimeUtils = require('./minecraft-launcher/utils.cjs');
const {
  assertSafeRemoteUrl,
  resolveSafeRedirectUrl
} = require('../utils/security-boundaries.cjs');

const RUNTIME_USER_AGENT = 'Minecraft-Core/26.6.1 RuntimeManager';
const NEOFORGE_HOST = 'maven.neoforged.net';
const NEOFORGE_ORIGIN = `https://${NEOFORGE_HOST}`;
const NEOFORGE_METADATA_URL = `https://${NEOFORGE_HOST}/releases/net/neoforged/neoforge/maven-metadata.xml`;
const QUILT_META_HOST = 'meta.quiltmc.org';
const QUILT_META_ORIGIN = `https://${QUILT_META_HOST}`;
const QUILT_META_BASE_URL = `https://${QUILT_META_HOST}/v3/versions/loader`;
const QUILT_MAVEN_ROOTS = Object.freeze(new Map([
  ['maven.quiltmc.org', '/repository/release/'],
  ['maven.fabricmc.net', '/']
]));
const DEFAULT_METADATA_BYTES = 2 * 1024 * 1024;
const DEFAULT_INSTALLER_BYTES = 128 * 1024 * 1024;
const DEFAULT_LIBRARY_BYTES = 64 * 1024 * 1024;
const DEFAULT_RUNTIME_BYTES = 1024 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_STDERR_BYTES = 1024 * 1024;
const RUNTIME_METADATA_RELATIVE = path.join('.minecraft-core-state', 'runtime.json');
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_MINECRAFT_VERSION = /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9._-]+)?$/;
const SUPPORTED_RUNTIME_LOADERS = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);
const QUILT_LAUNCHER_MAIN = 'org.quiltmc.loader.impl.launch.server.QuiltServerLauncher';
const QUILT_SERVER_MAIN = 'org.quiltmc.loader.impl.launch.knot.KnotServer';
const MOJANG_META_HOST = 'piston-meta.mojang.com';
const MOJANG_META_ORIGIN = `https://${MOJANG_META_HOST}`;
const MOJANG_DATA_HOST = 'piston-data.mojang.com';
const MOJANG_DATA_ORIGIN = `https://${MOJANG_DATA_HOST}`;
const MOJANG_VERSION_MANIFEST_URL = `${MOJANG_META_ORIGIN}/mc/game/version_manifest_v2.json`;

let logger = null;
function getLogger() {
  if (!logger) {
    try {
      const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
      logger = getLoggerHandlers();
    } catch {
      logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {}
      };
    }
  }
  return logger;
}

function normalizeLoader(loader) {
  const normalized = typeof loader === 'string' ? loader.trim().toLowerCase() : '';
  if (!normalized) {
    return 'vanilla';
  }
  if (['fabric', 'fabric-loader', 'fabricloader'].includes(normalized)) return 'fabric';
  if (['forge', 'forge-loader'].includes(normalized)) return 'forge';
  if (['neoforge', 'neo-forge', 'neo_forge', 'neo.forge'].includes(normalized)) return 'neoforge';
  if (['quilt', 'quilt-loader', 'quiltloader'].includes(normalized)) return 'quilt';
  return normalized;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unavailable(message = 'The exact loader version is unavailable.') {
  return codedError('LOADER_VERSION_UNAVAILABLE', message);
}

function runtimeIncomplete(message = 'The prepared server runtime is incomplete.') {
  return codedError('RUNTIME_INCOMPLETE', message);
}

function unsupportedLoader(loader) {
  return codedError('UNSUPPORTED_LOADER', `Unsupported loader: ${loader || 'unknown'}`);
}

function normalizeRuntimeInstallError(error) {
  let normalized;
  if (error?.code === 'CANCELLED') {
    normalized = codedError('CANCELLED', 'Runtime preparation was cancelled.');
  } else if (error?.code === 'LOADER_VERSION_UNAVAILABLE') {
    normalized = unavailable();
  } else if (error?.code === 'LOADER_VERSION_REQUIRED') {
    normalized = codedError('LOADER_VERSION_REQUIRED', 'An exact loader version is required.');
  } else if (error?.code === 'UNSUPPORTED_LOADER') {
    normalized = unsupportedLoader('unknown');
  } else {
    normalized = runtimeIncomplete();
  }
  try {
    if (Object.hasOwn(error || {}, 'runtimeDiagnostic')) {
      normalized.runtimeDiagnostic = runtimeDiagnosticFor(error, 'unknown');
    }
  } catch { /* diagnostic metadata must not replace the failure or its close proof */ }
  if (error?.preserveWorkspace === true) {
    retainRuntimeWorkerQuiescence(normalized,
      waitForRuntimeWorkerQuiescence(error).then(() => true, () => false));
  }
  return normalized;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key));
}

function hasControlCharacters(value) {
  return [...String(value)].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function validMinecraftVersion(value) {
  return typeof value === 'string' && value === value.trim() && SAFE_MINECRAFT_VERSION.test(value);
}

function validLoaderVersion(value) {
  return typeof value === 'string' && value === value.trim() && SAFE_VERSION.test(value);
}

function validExactQuiltLoaderVersion(value) {
  return validLoaderVersion(value) &&
    /^\d+(?:\.\d+)+(?:-[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*)?$/.test(value) &&
    !/^(?:latest|recommended|stable|release)$/i.test(value);
}

function assertRuntimeIdentifiers(minecraftVersion, loaderVersion, { requireLoader = true } = {}) {
  if (!validMinecraftVersion(minecraftVersion)) throw unavailable();
  if (requireLoader && !validLoaderVersion(loaderVersion)) {
    throw codedError('LOADER_VERSION_REQUIRED', 'An exact loader version is required.');
  }
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || hasControlCharacters(value) ||
    /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || value.includes(':')) return null;
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
    /[. ]$/.test(segment) || !isSafeWindowsBasename(segment))) return null;
  return segments.join(path.sep);
}

function resolveControlledPath(root, relativePath) {
  const safe = safeRelativePath(relativePath);
  if (!safe) throw runtimeIncomplete();
  const resolved = path.resolve(root, safe);
  if (!inside(root, resolved)) throw runtimeIncomplete();
  return resolved;
}

function assertDirectory(pathValue) {
  if (typeof pathValue !== 'string' || !path.isAbsolute(pathValue)) throw runtimeIncomplete();
  let stat;
  try { stat = fs.lstatSync(pathValue); } catch { throw runtimeIncomplete(); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeIncomplete();
  return path.resolve(pathValue);
}

function canonicalPathIdentity(pathValue) {
  const normalized = path.normalize(path.resolve(pathValue)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertCanonicalDirectory(pathValue) {
  const resolved = assertDirectory(pathValue);
  let real;
  try { real = fs.realpathSync.native(resolved); } catch { throw runtimeIncomplete(); }
  if (canonicalPathIdentity(real) !== canonicalPathIdentity(resolved)) throw runtimeIncomplete();
  return resolved;
}

function assertRegularContainedFile(root, filePath) {
  const resolved = path.resolve(filePath);
  if (!inside(root, resolved)) throw runtimeIncomplete();
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw runtimeIncomplete(); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw runtimeIncomplete();
  let real;
  try { real = fs.realpathSync(resolved); } catch { throw runtimeIncomplete(); }
  if (!inside(fs.realpathSync(root), real)) throw runtimeIncomplete();
  return { path: resolved, stat };
}

function positiveSafeInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError('Runtime limit is invalid');
  return value;
}

function responseStatus(response) {
  const status = response?.statusCode ?? response?.status;
  return Number.isSafeInteger(status) ? status : 0;
}

async function * responseChunks(response) {
  if (Buffer.isBuffer(response)) {
    yield response;
    return;
  }
  if (Buffer.isBuffer(response?.body)) {
    yield response.body;
    return;
  }
  if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    return;
  }
  if (response && typeof response[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    return;
  }
  throw runtimeIncomplete();
}

function requestTransport(options = {}) {
  const transport = options.transport || new PinnedHttpsClient();
  if (!transport || typeof transport.request !== 'function') throw new TypeError('Runtime transport is invalid');
  return transport;
}

async function requestRuntimeBytes(url, {
  transport,
  allowedHosts,
  allowedOrigins,
  maxBytes,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal,
  allowedStatuses = []
}) {
  const byteLimit = positiveSafeInteger(maxBytes, DEFAULT_METADATA_BYTES, DEFAULT_RUNTIME_BYTES);
  const deadline = positiveSafeInteger(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 60 * 60 * 1000);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw codedError('CANCELLED', 'Runtime preparation was cancelled.');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), deadline);
  let response;
  try {
    response = await transport.request(url, {
      headers: { 'User-Agent': RUNTIME_USER_AGENT, Accept: '*/*' },
      signal: controller.signal,
      allowedHosts,
      allowedOrigins,
      allowSubdomains: false,
      maxRedirects: 5
    });
    const statusCode = responseStatus(response);
    if (!((statusCode >= 200 && statusCode < 300) || allowedStatuses.includes(statusCode))) throw unavailable();
    const declared = response?.headers?.['content-length'] ?? response?.headers?.get?.('content-length');
    if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(String(declared)) || BigInt(declared) > BigInt(byteLimit))) throw runtimeIncomplete();
    const chunks = [];
    let measured = 0;
    for await (const chunk of responseChunks(response)) {
      measured += chunk.length;
      if (measured > byteLimit) throw runtimeIncomplete();
      chunks.push(chunk);
    }
    return { statusCode, body: Buffer.concat(chunks, measured), headers: response?.headers || {} };
  } catch (error) {
    if (signal?.aborted || error?.code === 'CANCELLED') throw codedError('CANCELLED', 'Runtime preparation was cancelled.');
    if (controller.signal.aborted) throw runtimeIncomplete('The runtime request exceeded its deadline.');
    if (error?.code === 'LOADER_VERSION_UNAVAILABLE' || error?.code === 'RUNTIME_INCOMPLETE') throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (response && typeof response.destroy === 'function' && !response.destroyed) response.destroy();
  }
}

function fatalUtf8(buffer, errorFactory = runtimeIncomplete) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw errorFactory(); }
}

function assertJsonBounds(value, { maxDepth = 12, maxArray = 2048, maxString = 8192, maxNodes = 20000 } = {}) {
  let nodes = 0;
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) throw unavailable();
    if (typeof current === 'string') {
      if (current.length > maxString || hasControlCharacters(current)) throw unavailable();
      return;
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      if (typeof current === 'number' && !Number.isFinite(current)) throw unavailable();
      return;
    }
    if (Array.isArray(current)) {
      if (current.length > maxArray) throw unavailable();
      current.forEach(child => visit(child, depth + 1));
      return;
    }
    if (!isPlainObject(current)) throw unavailable();
    Object.entries(current).forEach(([key, child]) => {
      if (!key || key.length > 128 || hasControlCharacters(key)) throw unavailable();
      visit(child, depth + 1);
    });
  };
  visit(value, 0);
  return value;
}

function parseBoundedJson(buffer) {
  let parsed;
  try { parsed = JSON.parse(fatalUtf8(buffer, unavailable)); }
  catch (error) {
    if (error?.code === 'LOADER_VERSION_UNAVAILABLE') throw error;
    throw unavailable();
  }
  return assertJsonBounds(parsed);
}

function sanitizedProcessEnvironment(command) {
  const result = { PATH: path.dirname(command) };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string' && process.env[key]) result[key] = process.env[key];
  }
  return result;
}

function runBoundedProcess({
  command,
  args,
  cwd,
  env = sanitizedProcessEnvironment(command),
  signal,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  maxStdoutBytes = DEFAULT_STDOUT_BYTES,
  maxStderrBytes = DEFAULT_STDERR_BYTES,
  terminationGraceMs = 5000,
  shell = false,
  windowsHide = true,
  spawnImpl = spawn
}) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') ||
    typeof cwd !== 'string' || !path.isAbsolute(cwd) || shell !== false || windowsHide !== true || !isPlainObject(env) ||
    typeof spawnImpl !== 'function') throw runtimeIncomplete();
  const deadline = positiveSafeInteger(timeoutMs, DEFAULT_INSTALL_TIMEOUT_MS, 60 * 60 * 1000);
  const stdoutLimit = positiveSafeInteger(maxStdoutBytes, DEFAULT_STDOUT_BYTES, 64 * 1024 * 1024);
  const stderrLimit = positiveSafeInteger(maxStderrBytes, DEFAULT_STDERR_BYTES, 8 * 1024 * 1024);
  const terminationGrace = positiveSafeInteger(terminationGraceMs, 5000, 60 * 1000);
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let terminationError = null;
    let stdout = '';
    let stderr = '';
    let timer = null;
    let escalationTimer = null;
    let forcedSettlementTimer = null;
    let processError = null;
    let recordClosure;
    const closed = new Promise(resolve => { recordClosure = resolve; });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      clearTimeout(forcedSettlementTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        if (error.preserveWorkspace === true) retainRuntimeWorkerQuiescence(error, closed);
        reject(error);
      } else resolve(value);
    };
    const terminateAndWait = error => {
      if (settled || terminationError) return;
      terminationError = error;
      try { child.kill(); } catch { /* bounded settlement below remains authoritative */ }
      if (settled) return;
      escalationTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* bounded settlement below remains authoritative */ }
      }, Math.max(1, Math.floor(terminationGrace / 2)));
      escalationTimer.unref?.();
      forcedSettlementTimer = setTimeout(() => {
        terminationError.preserveWorkspace = true;
        finish(terminationError);
      }, terminationGrace);
      forcedSettlementTimer.unref?.();
    };
    const onAbort = () => terminateAndWait(codedError('CANCELLED', 'Runtime preparation was cancelled.'));
    if (signal?.aborted) {
      finish(codedError('CANCELLED', 'Runtime preparation was cancelled.'));
      return;
    }
    try {
      child = spawnImpl(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(runtimeIncomplete());
      return;
    }
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function' ||
      typeof child.stdout?.on !== 'function' || typeof child.stderr?.on !== 'function') {
      finish(runtimeIncomplete());
      return;
    }
    const collect = (current, chunk, limit) => {
      try {
        const next = Buffer.byteLength(current) + Buffer.byteLength(chunk);
        if (next > limit) {
          terminateAndWait(runtimeIncomplete('The official loader installer produced excessive output.'));
          return current;
        }
        return current + chunk.toString('utf8');
      } catch {
        terminateAndWait(runtimeIncomplete());
        return current;
      }
    };
    child.stdout.on('data', chunk => { if (!settled) stdout = collect(stdout, chunk, stdoutLimit); });
    child.stderr.on('data', chunk => { if (!settled) stderr = collect(stderr, chunk, stderrLimit); });
    child.stdout.on('error', () => { if (!settled) terminateAndWait(runtimeIncomplete()); });
    child.stderr.on('error', () => { if (!settled) terminateAndWait(runtimeIncomplete()); });
    child.on('error', () => {
      if (settled) return;
      processError = runtimeIncomplete();
      if (!terminationError) terminateAndWait(processError);
    });
    child.once('exit', () => {
      // Deliberately wait for close: Node emits close only after child stdio is quiescent.
    });
    child.once('close', (code) => {
      recordClosure(true);
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (processError) {
        finish(processError);
        return;
      }
      if (code !== 0) {
        finish(runtimeIncomplete('The official loader installer failed.'));
        return;
      }
      finish(null, { code, stdout, stderr });
    });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => terminateAndWait(runtimeIncomplete('The official loader installer exceeded its deadline.')), deadline);
    timer.unref?.();
    if (signal?.aborted) onAbort();
  });
}

async function resolveJavaMajor(minecraftVersion, resolver = minecraftRuntimeUtils.resolveRequiredJavaVersion) {
  if (!validMinecraftVersion(minecraftVersion) || typeof resolver !== 'function') throw runtimeIncomplete();
  const result = await resolver(minecraftVersion);
  const major = result?.requiredJavaVersion;
  if (!Number.isSafeInteger(major) || major < 8 || major > 99) throw runtimeIncomplete();
  return major;
}

async function validateManagedJava({ javaPath, expectedMajor, processRunner = runBoundedProcess, signal }) {
  if (typeof javaPath !== 'string' || !path.isAbsolute(javaPath) || !Number.isSafeInteger(expectedMajor)) throw runtimeIncomplete();
  if (!fs.existsSync(javaPath)) throw runtimeIncomplete();
  const result = await processRunner({
    command: javaPath,
    args: ['-version'],
    cwd: path.dirname(javaPath),
    signal,
    timeoutMs: 30 * 1000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    shell: false,
    windowsHide: true,
    env: sanitizedProcessEnvironment(javaPath)
  });
  const match = `${result.stdout || ''}\n${result.stderr || ''}`.match(/version\s+"(\d+)(?:\.(\d+))?/i);
  if (!match) throw runtimeIncomplete();
  const detected = Number(match[1]) === 1 ? Number(match[2]) : Number(match[1]);
  if (detected !== expectedMajor) throw runtimeIncomplete('The selected Java runtime has the wrong major version.');
  return detected;
}

function normalizeRuntime(input) {
  try {
    const runtime = normalizeRuntimeTuple(input);
    if (!validMinecraftVersion(runtime.minecraftVersion) || !validLoaderVersion(runtime.loaderVersion) ||
      (runtime.loaderFamily === 'quilt' && !validExactQuiltLoaderVersion(runtime.loaderVersion))) throw runtimeIncomplete();
    return runtime;
  } catch (error) {
    if (error?.code === 'RUNTIME_INCOMPLETE') throw error;
    throw runtimeIncomplete();
  }
}

function runtimeTupleEquals(left, right) {
  return ['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture']
    .every(key => left?.[key] === right?.[key]);
}

function portableRelative(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw runtimeIncomplete();
  return relative.split(path.sep).join('/');
}

function ensureControlledDirectory(root, directoryPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directoryPath);
  if (!inside(resolvedRoot, resolvedDirectory)) throw runtimeIncomplete();
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current);
      continue;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeIncomplete();
  }
  return resolvedDirectory;
}

function writeNewControlledFile(root, filePath, bytes) {
  const resolved = path.resolve(filePath);
  if (!inside(root, resolved) || fs.existsSync(resolved)) throw runtimeIncomplete();
  ensureControlledDirectory(root, path.dirname(resolved));
  const descriptor = fs.openSync(resolved, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return resolved;
}

function createRuntimeWorkspace(targetRoot, family) {
  targetRoot = assertCanonicalDirectory(targetRoot);
  let workspace = null;
  try {
    const stagingParent = ensureControlledDirectory(targetRoot, path.join(targetRoot, '.minecraft-core-state', 'runtime-staging'));
    if (!inside(fs.realpathSync.native(targetRoot), fs.realpathSync.native(stagingParent))) throw runtimeIncomplete();
    workspace = fs.mkdtempSync(path.join(stagingParent, `${family}-`));
    const serverRoot = path.join(workspace, 'server');
    fs.mkdirSync(serverRoot);
    return { workspace, serverRoot };
  } catch {
    cleanupRuntimeWorkspace(targetRoot, workspace);
    throw runtimeIncomplete();
  }
}

function cleanupRuntimeWorkspace(targetRoot, workspace) {
  const stateDirectory = path.join(targetRoot, '.minecraft-core-state');
  const stagingParent = path.join(targetRoot, '.minecraft-core-state', 'runtime-staging');
  if (typeof workspace === 'string' && inside(stagingParent, workspace)) {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try {
    if (fs.existsSync(stagingParent) && fs.readdirSync(stagingParent).length === 0) fs.rmdirSync(stagingParent);
  } catch { /* best effort */ }
  try {
    if (fs.existsSync(stateDirectory) && fs.readdirSync(stateDirectory).length === 0) fs.rmdirSync(stateDirectory);
  } catch { /* best effort */ }
}

function listRegularFiles(root, {
  maxFiles = 100000,
  maxBytes = DEFAULT_RUNTIME_BYTES,
  includeRootEntry = null
} = {}) {
  if (includeRootEntry !== null && typeof includeRootEntry !== 'function') throw runtimeIncomplete();
  const files = [];
  const identities = new Set();
  let measured = 0;
  const walk = (directory, rootDirectory = false) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (rootDirectory && includeRootEntry && !includeRootEntry(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const relativePath = portableRelative(root, fullPath);
      const identity = relativePath.normalize('NFC').toLowerCase();
      if (identities.has(identity)) throw runtimeIncomplete();
      identities.add(identity);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw runtimeIncomplete();
      if (stat.isDirectory()) {
        walk(fullPath, false);
      } else if (stat.isFile()) {
        measured += stat.size;
        if (files.length >= maxFiles || measured > maxBytes) throw runtimeIncomplete();
        files.push({ source: fullPath, relativePath, size: stat.size });
      } else {
        throw runtimeIncomplete();
      }
    }
  };
  walk(root, true);
  return files.sort((left, right) => {
    const leftMetadata = left.relativePath === '.minecraft-core-state/runtime.json';
    const rightMetadata = right.relativePath === '.minecraft-core-state/runtime.json';
    if (leftMetadata !== rightMetadata) return leftMetadata ? 1 : -1;
    return left.relativePath.localeCompare(right.relativePath, 'en');
  });
}

function listRuntimeArtifactFiles(root, {
  maxFiles = 100000,
  maxBytes = DEFAULT_RUNTIME_BYTES
} = {}) {
  const runtimeDirectories = new Set(['libraries', 'versions']);
  const runtimeRootFiles = new Set([
    'fabric-installer.jar',
    'fabric-server-launch.jar',
    'fabric-server-launcher.properties',
    'quilt-server-launch.jar',
    'quilt-server-launcher.properties',
    'server.jar',
    'user_jvm_args.txt'
  ]);
  const isRuntimeRootJar = identity => /^(?:forge|neoforge)-.*\.jar$/u.test(identity) ||
    /^minecraft_server\.[a-z0-9._+-]+\.jar$/u.test(identity);
  const isRuntimeRootEntry = name => {
    const identity = name.normalize('NFC').toLocaleLowerCase('en-US');
    return runtimeDirectories.has(identity) || runtimeRootFiles.has(identity) ||
      isRuntimeRootJar(identity);
  };
  return listRegularFiles(root, { maxFiles, maxBytes, includeRootEntry: isRuntimeRootEntry }).filter(file => {
    const identity = file.relativePath.normalize('NFC').toLocaleLowerCase('en-US');
    const segments = identity.split('/');
    if (segments.length > 1) return runtimeDirectories.has(segments[0]);
    return runtimeRootFiles.has(identity) || isRuntimeRootJar(identity);
  });
}

function collectConflictingRuntimePaths(targetRoot, loaderFamily) {
  const relativePaths = [];
  if (loaderFamily !== 'fabric') relativePaths.push('fabric-server-launch.jar', '.fabric');
  if (loaderFamily !== 'quilt') relativePaths.push('quilt-server-launch.jar', 'quilt-server-launcher.properties');
  relativePaths.push('libraries/net/minecraftforge/forge', 'libraries/net/neoforged/neoforge');
  try {
    for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
      if (entry.isFile() && /^forge-.*-shim\.jar$/i.test(entry.name)) relativePaths.push(entry.name);
    }
  } catch { throw runtimeIncomplete(); }
  const unique = new Map();
  for (const relativePath of relativePaths) {
    const destination = resolveControlledPath(targetRoot, relativePath);
    if (!fs.existsSync(destination)) continue;
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw runtimeIncomplete();
    let real;
    try { real = fs.realpathSync.native(destination); } catch { throw runtimeIncomplete(); }
    if (!inside(fs.realpathSync.native(targetRoot), real)) throw runtimeIncomplete();
    unique.set(canonicalPathIdentity(destination), { destination, relativePath });
  }
  return [...unique.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}

function publishStagedRuntime(stageRoot, targetRoot, workspace, verify, {
  loaderFamily = null,
  renameFile = fs.renameSync
} = {}) {
  stageRoot = assertCanonicalDirectory(stageRoot);
  targetRoot = assertCanonicalDirectory(targetRoot);
  if (!inside(targetRoot, workspace) || !inside(workspace, stageRoot) || typeof verify !== 'function' || typeof renameFile !== 'function') {
    throw runtimeIncomplete();
  }
  const files = listRegularFiles(stageRoot);
  const conflicts = loaderFamily ? collectConflictingRuntimePaths(targetRoot, loaderFamily) : [];
  const backupRoot = path.join(workspace, 'backup');
  fs.mkdirSync(backupRoot);
  const operations = [];
  const conflictOperations = [];
  const createdDirectories = [];
  const ensureTargetParent = directory => {
    const missing = [];
    let current = path.resolve(directory);
    while (inside(targetRoot, current) && current !== path.resolve(targetRoot) && !fs.existsSync(current)) {
      missing.push(current);
      current = path.dirname(current);
    }
    ensureControlledDirectory(targetRoot, directory);
    createdDirectories.push(...missing);
  };
  for (const file of files) {
    const destination = resolveControlledPath(targetRoot, file.relativePath);
    if (fs.existsSync(destination)) {
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) throw runtimeIncomplete();
      assertRegularContainedFile(targetRoot, destination);
    }
  }
  try {
    for (const conflict of conflicts) {
      const backup = resolveControlledPath(backupRoot, `conflicts/${conflict.relativePath}`);
      ensureControlledDirectory(backupRoot, path.dirname(backup));
      renameFile(conflict.destination, backup);
      conflictOperations.push({ ...conflict, backup });
    }
    for (const file of files) {
      const destination = resolveControlledPath(targetRoot, file.relativePath);
      const backup = resolveControlledPath(backupRoot, file.relativePath);
      ensureTargetParent(path.dirname(destination));
      let hadExisting = false;
      if (fs.existsSync(destination)) {
        ensureControlledDirectory(backupRoot, path.dirname(backup));
        renameFile(destination, backup);
        hadExisting = true;
      }
      const operation = { destination, backup, hadExisting, published: false };
      operations.push(operation);
      renameFile(file.source, destination);
      operation.published = true;
    }
    const result = verify();
    return result;
  } catch (error) {
    let rollbackComplete = true;
    for (const operation of operations.reverse()) {
      if (operation.published) {
        try { fs.rmSync(operation.destination, { force: true }); } catch { rollbackComplete = false; }
      }
      if (operation.hadExisting && fs.existsSync(operation.backup)) {
        try {
          ensureControlledDirectory(targetRoot, path.dirname(operation.destination));
          renameFile(operation.backup, operation.destination);
        } catch { rollbackComplete = false; }
      }
    }
    for (const directory of [...new Set(createdDirectories)].sort((left, right) => right.length - left.length)) {
      try { if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory); } catch { rollbackComplete = false; }
    }
    for (const operation of conflictOperations.reverse()) {
      try {
        if (fs.existsSync(operation.destination)) fs.rmSync(operation.destination, { recursive: true, force: true });
        ensureControlledDirectory(targetRoot, path.dirname(operation.destination));
        renameFile(operation.backup, operation.destination);
      } catch { rollbackComplete = false; }
    }
    const failure = error?.code ? error : runtimeIncomplete();
    if (!rollbackComplete) failure.preserveWorkspace = true;
    throw failure;
  }
}

function digestBuffer(buffer, algorithm) {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

function sameFileIdentity(left, right) {
  return left.nlink === 1 && right.nlink === 1 && left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}

function artifactIdentityFailure(left, right, stage) {
  const error = runtimeIncomplete();
  const mask = changedIdentityFields(left, right);
  if (mask) error.runtimeDiagnostic = {
    stage, reason: 'identity-changed', changedIdentityFields: mask
  };
  return error;
}

function digestStableArtifact(root, filePath, options = {}) {
  const fsApi = options.fsApi || fs;
  const diagnosticStage = options.diagnosticStage || 'artifact-digest';
  const resolved = path.resolve(filePath);
  let descriptor = null;
  try {
    if (!inside(root, resolved)) throw runtimeIncomplete();
    const rootRealPath = fsApi.realpathSync.native(root);
    const pathStatBefore = fsApi.lstatSync(resolved);
    if (!pathStatBefore.isFile() || pathStatBefore.isSymbolicLink()) throw runtimeIncomplete();
    const realPathBefore = fsApi.realpathSync.native(resolved);
    if (!inside(rootRealPath, realPathBefore)) throw runtimeIncomplete();
    const noFollow = Number.isInteger(fsApi.constants?.O_NOFOLLOW) ? fsApi.constants.O_NOFOLLOW : 0;
    descriptor = fsApi.openSync(resolved, fsApi.constants.O_RDONLY | noFollow);
    const descriptorStatBefore = fsApi.fstatSync(descriptor);
    if (!descriptorStatBefore.isFile() || !sameFileIdentity(pathStatBefore, descriptorStatBefore)) {
      throw artifactIdentityFailure(pathStatBefore, descriptorStatBefore, diagnosticStage);
    }

    const sha256 = crypto.createHash('sha256');
    const sha512 = crypto.createHash('sha512');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < descriptorStatBefore.size) {
      const length = Math.min(buffer.length, descriptorStatBefore.size - offset);
      const bytesRead = fsApi.readSync(descriptor, buffer, 0, length, offset);
      if (bytesRead !== length) throw runtimeIncomplete();
      const chunk = buffer.subarray(0, bytesRead);
      sha256.update(chunk);
      sha512.update(chunk);
      offset += bytesRead;
    }

    const descriptorStatAfter = fsApi.fstatSync(descriptor);
    const pathStatAfter = fsApi.lstatSync(resolved);
    const realPathAfter = fsApi.realpathSync.native(resolved);
    if (!pathStatAfter.isFile() || pathStatAfter.isSymbolicLink() ||
        realPathAfter !== realPathBefore || !inside(rootRealPath, realPathAfter) ||
        !sameFileIdentity(descriptorStatBefore, descriptorStatAfter) ||
        !sameFileIdentity(descriptorStatAfter, pathStatAfter)) {
      const failure = artifactIdentityFailure(descriptorStatBefore, descriptorStatAfter, diagnosticStage);
      if (!failure.runtimeDiagnostic) throw artifactIdentityFailure(descriptorStatAfter, pathStatAfter, diagnosticStage);
      throw failure;
    }
    return {
      path: resolved,
      realPath: realPathAfter,
      stat: descriptorStatAfter,
      size: descriptorStatAfter.size,
      sha256: sha256.digest('hex'),
      sha512: sha512.digest('hex')
    };
  } catch (error) {
    if (error?.code === 'RUNTIME_INCOMPLETE') throw annotateRuntimeError(error, diagnosticStage);
    const failure = runtimeIncomplete();
    failure.runtimeDiagnostic = runtimeDiagnosticFor(error, diagnosticStage);
    throw failure;
  } finally {
    if (descriptor !== null) {
      try { fsApi.closeSync(descriptor); } catch { /* the integrity check already fails closed above */ }
    }
  }
}

function buildArtifactRecord(root, filePath) {
  const inspected = digestStableArtifact(root, filePath);
  return {
    relativePath: portableRelative(root, inspected.path),
    size: inspected.size,
    sha256: inspected.sha256,
    sha512: inspected.sha512
  };
}

function artifactRecordPath(root, record) {
  if (!hasExactKeys(record, ['relativePath', 'size', 'sha256', 'sha512']) ||
    !Number.isSafeInteger(record.size) || record.size < 0 ||
    !/^[a-f0-9]{64}$/.test(record.sha256) || !/^[a-f0-9]{128}$/.test(record.sha512)) throw runtimeIncomplete();
  return resolveControlledPath(root, record.relativePath);
}

function validateArtifactRecord(root, record) {
  const filePath = artifactRecordPath(root, record);
  const inspected = digestStableArtifact(root, filePath);
  if (inspected.size !== record.size || inspected.sha256 !== record.sha256 ||
    inspected.sha512 !== record.sha512) throw runtimeIncomplete();
  return filePath;
}

function atomicWriteRuntimeMetadata(root, record) {
  const stateDirectory = ensureControlledDirectory(root, path.join(root, '.minecraft-core-state'));
  const destination = path.join(root, RUNTIME_METADATA_RELATIVE);
  const temporary = path.join(stateDirectory, `runtime-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function requireJar(root, filePath) {
  const { path: resolved, stat } = assertRegularContainedFile(root, filePath);
  if (stat.size < 4) throw runtimeIncomplete();
  const prefix = Buffer.alloc(4);
  const descriptor = fs.openSync(resolved, 'r');
  try { fs.readSync(descriptor, prefix, 0, prefix.length, 0); } finally { fs.closeSync(descriptor); }
  if (!(prefix[0] === 0x50 && prefix[1] === 0x4b && [0x03, 0x05, 0x07].includes(prefix[2]))) throw runtimeIncomplete();
  try { new AdmZip(resolved).getEntries(); } catch { throw runtimeIncomplete(); }
  return resolved;
}

function readJarMainAttributes(root, filePath) {
  const resolved = requireJar(root, filePath);
  let archive;
  try { archive = new AdmZip(resolved); } catch { throw runtimeIncomplete(); }
  const manifestEntries = archive.getEntries().filter(entry =>
    entry.entryName.replaceAll('\\', '/').toLocaleUpperCase('en-US') === 'META-INF/MANIFEST.MF'
  );
  if (manifestEntries.length !== 1 || manifestEntries[0].isDirectory ||
      manifestEntries[0].header.size < 1 || manifestEntries[0].header.size > DEFAULT_METADATA_BYTES) throw runtimeIncomplete();
  let text;
  try { text = fatalUtf8(manifestEntries[0].getData()); } catch { throw runtimeIncomplete(); }
  if (text.includes('\0')) throw runtimeIncomplete();
  const logicalLines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === '') break;
    if (rawLine.startsWith(' ')) {
      if (logicalLines.length === 0) throw runtimeIncomplete();
      logicalLines[logicalLines.length - 1] += rawLine.slice(1);
      continue;
    }
    logicalLines.push(rawLine);
  }
  const attributes = new Map();
  for (const line of logicalLines) {
    const separator = line.indexOf(': ');
    if (separator < 1) throw runtimeIncomplete();
    const name = line.slice(0, separator).toLocaleLowerCase('en-US');
    const value = line.slice(separator + 2);
    if (!/^[a-z0-9][a-z0-9-]{0,69}$/u.test(name) || attributes.has(name) || !value) throw runtimeIncomplete();
    attributes.set(name, value);
  }
  return attributes;
}

function filesByteForByteEqual(leftPath, rightPath) {
  const leftStat = fs.statSync(leftPath);
  const rightStat = fs.statSync(rightPath);
  if (leftStat.size !== rightStat.size) return false;
  let leftDescriptor = null;
  let rightDescriptor = null;
  const leftBuffer = Buffer.allocUnsafe(1024 * 1024);
  const rightBuffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    leftDescriptor = fs.openSync(leftPath, 'r');
    rightDescriptor = fs.openSync(rightPath, 'r');
    let offset = 0;
    while (offset < leftStat.size) {
      const length = Math.min(leftBuffer.length, leftStat.size - offset);
      const leftRead = fs.readSync(leftDescriptor, leftBuffer, 0, length, offset);
      const rightRead = fs.readSync(rightDescriptor, rightBuffer, 0, length, offset);
      if (leftRead !== length || rightRead !== length ||
          !leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))) return false;
      offset += length;
    }
    return true;
  } finally {
    if (leftDescriptor !== null) fs.closeSync(leftDescriptor);
    if (rightDescriptor !== null) fs.closeSync(rightDescriptor);
  }
}

function requireIdenticalJars(root, leftPath, rightPath) {
  try {
    const left = requireJar(root, leftPath);
    const right = requireJar(root, rightPath);
    if (!filesByteForByteEqual(left, right)) throw runtimeIncomplete();
    return { left, right };
  } catch (error) {
    if (error?.code === 'RUNTIME_INCOMPLETE') throw error;
    throw runtimeIncomplete();
  }
}

function materializeExactLegacyForgeJar(root, sourcePath, destinationPath) {
  const source = requireJar(root, sourcePath);
  if (fs.existsSync(destinationPath)) {
    requireIdenticalJars(root, source, destinationPath);
    return requireJar(root, destinationPath);
  }
  let copied = false;
  try {
    fs.copyFileSync(source, destinationPath, fs.constants.COPYFILE_EXCL);
    copied = true;
    requireIdenticalJars(root, source, destinationPath);
    return requireJar(root, destinationPath);
  } catch {
    if (copied) {
      try { fs.rmSync(destinationPath, { force: true }); } catch { /* candidate validation remains fail-closed */ }
    }
    throw runtimeIncomplete();
  }
}

function materializeLegacyForgeLayout(root, runtime) {
  const artifactVersion = `${runtime.minecraftVersion}-${runtime.loaderVersion}`;
  const installedLaunchJar = resolveControlledPath(
    root,
    `libraries/net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}.jar`
  );
  const installedServerJar = resolveControlledPath(root, 'server.jar');
  const bundledServerJar = resolveControlledPath(
    root,
    `libraries/net/minecraft/server/${runtime.minecraftVersion}/server-${runtime.minecraftVersion}-bundled.jar`
  );
  requireIdenticalJars(root, installedServerJar, bundledServerJar);
  materializeExactLegacyForgeJar(
    root,
    installedLaunchJar,
    resolveControlledPath(root, `forge-${artifactVersion}.jar`)
  );
  materializeExactLegacyForgeJar(
    root,
    installedServerJar,
    resolveControlledPath(root, `minecraft_server.${runtime.minecraftVersion}.jar`)
  );
  return legacyForgeLayout(root, runtime);
}

function legacyForgeLayout(root, runtime) {
  const launchJarRelative = `forge-${runtime.minecraftVersion}-${runtime.loaderVersion}.jar`;
  const serverJarRelative = `minecraft_server.${runtime.minecraftVersion}.jar`;
  const launchJar = resolveControlledPath(root, launchJarRelative);
  const serverJar = resolveControlledPath(root, serverJarRelative);
  requireJar(root, launchJar);
  requireJar(root, serverJar);
  const attributes = readJarMainAttributes(root, launchJar);
  const mainClass = attributes.get('main-class');
  const classPath = attributes.get('class-path');
  if (!mainClass || !/^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)+[A-Za-z_$][A-Za-z0-9_$]*$/u.test(mainClass) ||
      typeof classPath !== 'string' || !classPath.trim()) throw runtimeIncomplete();
  const entries = classPath.trim().split(/[ \t]+/u);
  if (entries.length < 2 || entries.length > 10000) throw runtimeIncomplete();
  const identities = new Set();
  const libraries = [];
  let serverReferences = 0;
  for (const entry of entries) {
    if (!entry || entry.includes('\\') || entry.includes('%') || entry.includes('?') || entry.includes('#')) {
      throw runtimeIncomplete();
    }
    const safe = safeRelativePath(entry);
    if (!safe || safe.split(path.sep).join('/') !== entry) throw runtimeIncomplete();
    const identity = entry.normalize('NFC').toLocaleLowerCase('en-US');
    if (identities.has(identity)) throw runtimeIncomplete();
    identities.add(identity);
    if (entry === serverJarRelative) {
      serverReferences += 1;
    } else {
      if (!entry.startsWith('libraries/') || !entry.toLocaleLowerCase('en-US').endsWith('.jar')) {
        throw runtimeIncomplete();
      }
      libraries.push(entry);
    }
    requireJar(root, resolveControlledPath(root, entry));
  }
  if (serverReferences !== 1 || libraries.length === 0) throw runtimeIncomplete();
  return {
    family: 'forge',
    launchJar: launchJarRelative,
    serverJar: serverJarRelative,
    libraries
  };
}

function resolveForgeRuntimeLoader(root, runtime) {
  const argsFile = `libraries/net/minecraftforge/forge/${runtime.minecraftVersion}-${runtime.loaderVersion}/win_args.txt`;
  const argsPath = resolveControlledPath(root, argsFile);
  if (fs.existsSync(argsPath)) {
    assertRegularContainedFile(root, argsPath);
    return { family: 'forge', argsFile };
  }
  return legacyForgeLayout(root, runtime);
}

function parsePropertiesExact(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length > 64 * 1024) throw runtimeIncomplete();
  const text = fatalUtf8(bytes);
  const entries = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw runtimeIncomplete();
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (entries.has(key)) throw runtimeIncomplete();
    entries.set(key, value);
  }
  return entries;
}

function getNeoForgeMinecraftPrefix(minecraftVersion) {
  if (!validMinecraftVersion(minecraftVersion) || minecraftVersion.includes('-')) return null;
  const parts = minecraftVersion.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) return null;
  if (parts[0] === 1 && (parts.length === 2 || parts.length === 3)) {
    return `${parts[1]}.${parts[2] ?? 0}.`;
  }
  if (parts[0] >= 26 && (parts.length === 2 || parts.length === 3)) {
    return `${parts[0]}.${parts[1]}.${parts[2] ?? 0}.`;
  }
  return null;
}

function parseNeoForgeMetadata(buffer) {
  const xml = fatalUtf8(buffer, unavailable).trim();
  if (!xml || xml.length > DEFAULT_METADATA_BYTES || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--|&(?:#|[A-Za-z])/i.test(xml)) throw unavailable();
  const documentMatch = xml.match(/^(?:<\?xml\s+version="1\.0"(?:\s+encoding="UTF-8")?\s*\?>\s*)?<metadata>\s*<groupId>net\.neoforged<\/groupId>\s*<artifactId>neoforge<\/artifactId>\s*<versioning>\s*<latest>([^<]+)<\/latest>\s*<release>([^<]+)<\/release>\s*<versions>([\s\S]*?)<\/versions>\s*<lastUpdated>\d{14}<\/lastUpdated>\s*<\/versioning>\s*<\/metadata>$/);
  if (!documentMatch) throw unavailable();
  const versionBlock = documentMatch[3];
  const versions = [...versionBlock.matchAll(/<version>([^<]+)<\/version>/g)].map(match => match[1]);
  const residue = versionBlock.replace(/<version>[^<]+<\/version>/g, '').trim();
  if (residue || versions.length === 0 || versions.length > 8192 ||
    !versions.every(validLoaderVersion) || new Set(versions).size !== versions.length ||
    !validLoaderVersion(documentMatch[1]) || !validLoaderVersion(documentMatch[2])) throw unavailable();
  return versions;
}

async function getNeoForgeVersions(minecraftVersion, options = {}) {
  const prefix = getNeoForgeMinecraftPrefix(minecraftVersion);
  if (!prefix) throw unavailable();
  try {
    const result = await requestRuntimeBytes(NEOFORGE_METADATA_URL, {
      transport: requestTransport(options),
      allowedHosts: [NEOFORGE_HOST],
      allowedOrigins: [NEOFORGE_ORIGIN],
      maxBytes: options.maxMetadataBytes ?? DEFAULT_METADATA_BYTES,
      timeoutMs: options.timeoutMs,
      signal: options.signal
    });
    return parseNeoForgeMetadata(result.body)
      .filter(version => version.startsWith(prefix))
      .sort(compareNumericVersionDesc);
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    throw unavailable();
  }
}

function neoForgeInstallerUrl(loaderVersion) {
  if (!validLoaderVersion(loaderVersion)) throw unavailable();
  return `https://${NEOFORGE_HOST}/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
}

function parseDigestSidecar(buffer, algorithm) {
  const text = fatalUtf8(buffer).trim();
  const length = algorithm === 'sha512' ? 128 : 64;
  const match = text.match(new RegExp(`^([a-fA-F0-9]{${length}})(?:\\s+(?:\\*?neoforge-[A-Za-z0-9._+-]+-installer\\.jar))?$`));
  if (!match) throw runtimeIncomplete();
  return match[1].toLowerCase();
}

async function resolveNeoForgeInstaller(options) {
  const { minecraftVersion, loaderVersion } = options;
  const versions = await getNeoForgeVersions(minecraftVersion, options);
  if (!versions.includes(loaderVersion)) throw unavailable();
  const transport = requestTransport(options);
  const installerUrl = neoForgeInstallerUrl(loaderVersion);
  const common = {
    transport,
    allowedHosts: [NEOFORGE_HOST],
    allowedOrigins: [NEOFORGE_ORIGIN],
    timeoutMs: options.timeoutMs,
    signal: options.signal
  };
  const sha512Response = await requestRuntimeBytes(`${installerUrl}.sha512`, {
    ...common,
    maxBytes: 4096,
    allowedStatuses: [404]
  });
  let algorithm = 'sha512';
  let expectedDigest;
  if (sha512Response.statusCode === 404) {
    const sha256Response = await requestRuntimeBytes(`${installerUrl}.sha256`, { ...common, maxBytes: 4096 });
    algorithm = 'sha256';
    expectedDigest = parseDigestSidecar(sha256Response.body, algorithm);
  } else {
    expectedDigest = parseDigestSidecar(sha512Response.body, algorithm);
  }
  const installerResponse = await requestRuntimeBytes(installerUrl, {
    ...common,
    maxBytes: options.maxInstallerBytes ?? DEFAULT_INSTALLER_BYTES
  });
  if (digestBuffer(installerResponse.body, algorithm) !== expectedDigest) throw runtimeIncomplete('The NeoForge installer checksum did not match.');
  if (installerResponse.body.length < 4 || installerResponse.body[0] !== 0x50 || installerResponse.body[1] !== 0x4b) throw runtimeIncomplete();
  return { bytes: installerResponse.body, installerUrl, algorithm, expectedDigest };
}

function validateNeoForgeInstallerProfile(installerPath, minecraftVersion, loaderVersion) {
  let zip;
  try { zip = new AdmZip(installerPath); } catch { throw runtimeIncomplete(); }
  const entries = zip.getEntries();
  if (entries.length > 100000) throw runtimeIncomplete();
  const profileEntries = entries.filter(entry => entry.entryName.replaceAll('\\', '/') === 'install_profile.json');
  if (profileEntries.length !== 1 || profileEntries[0].isDirectory || profileEntries[0].header.size > DEFAULT_METADATA_BYTES) throw runtimeIncomplete();
  const profile = parseBoundedJson(profileEntries[0].getData());
  if (!isPlainObject(profile) || profile.spec !== 1 || profile.profile !== 'NeoForge' ||
    profile.minecraft !== minecraftVersion || profile.version !== `neoforge-${loaderVersion}` ||
    !Array.isArray(profile.processors) || !Array.isArray(profile.libraries) || !isPlainObject(profile.data) ||
    profile.serverJarPath !== '{LIBRARY_DIR}/net/minecraft/server/{MINECRAFT_VERSION}/server-{MINECRAFT_VERSION}.jar') throw runtimeIncomplete();
  return profile;
}

function validateNeoForgeArgumentFile(root, argumentFile, { minecraftVersion = null, loaderVersion = null } = {}) {
  const inspected = assertRegularContainedFile(root, argumentFile);
  if (inspected.stat.size < 1 || inspected.stat.size > 2 * 1024 * 1024) throw runtimeIncomplete();
  const text = fatalUtf8(fs.readFileSync(argumentFile));
  if (/\$\{|%[^%\r\n]+%|`|[&|><]/.test(text)) throw runtimeIncomplete();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 10000) throw runtimeIncomplete();
  const classpathFlags = new Set(['-p', '--module-path', '-cp', '-classpath', '--class-path']);
  const referencedFiles = new Set();
  const validateClasspath = value => {
    if (!value) return;
    for (const item of value.split(';')) {
      const referenced = resolveControlledPath(root, item.replaceAll('/', path.sep));
      assertRegularContainedFile(root, referenced);
      referencedFiles.add(referenced);
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^"|"$/g, '');
    if (token.startsWith('@')) {
      const referenced = resolveControlledPath(root, token.slice(1).replaceAll('/', path.sep));
      assertRegularContainedFile(root, referenced);
      referencedFiles.add(referenced);
    }
    if (classpathFlags.has(token)) {
      const classpath = tokens[index + 1]?.replace(/^"|"$/g, '');
      if (!classpath) throw runtimeIncomplete();
      validateClasspath(classpath);
      index += 1;
      continue;
    }
    if (token.startsWith('-DlegacyClassPath=') || token.startsWith('-Dfml.pluginLayerLibraries=') || token.startsWith('-Dfml.gameLayerLibraries=')) {
      validateClasspath(token.slice(token.indexOf('=') + 1));
    } else if (token.startsWith('-DlibraryDirectory=')) {
      const directory = resolveControlledPath(root, token.slice(token.indexOf('=') + 1).replaceAll('/', path.sep));
      let stat;
      try { stat = fs.lstatSync(directory); } catch { throw runtimeIncomplete(); }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(fs.realpathSync.native(root), fs.realpathSync.native(directory))) throw runtimeIncomplete();
    } else if (token === '--fml.neoForgeVersion' && loaderVersion && tokens[index + 1] !== loaderVersion) {
      throw runtimeIncomplete();
    } else if (token === '--fml.mcVersion' && minecraftVersion && tokens[index + 1] !== minecraftVersion) {
      throw runtimeIncomplete();
    }
  }
  return { text, referencedFiles: [...referencedFiles] };
}

function neoForgeLayout(root, loaderVersion, minecraftVersion = null) {
  const loaderDirectory = resolveControlledPath(root, `libraries/net/neoforged/neoforge/${loaderVersion}`);
  const argsFile = path.join(loaderDirectory, 'win_args.txt');
  const universalJar = path.join(loaderDirectory, `neoforge-${loaderVersion}-universal.jar`);
  const serverJar = path.join(root, 'server.jar');
  const userJvmArgs = path.join(root, 'user_jvm_args.txt');
  requireJar(root, serverJar);
  requireJar(root, universalJar);
  assertRegularContainedFile(root, userJvmArgs);
  const args = validateNeoForgeArgumentFile(root, argsFile, { minecraftVersion, loaderVersion });
  return { argsFile, universalJar, serverJar, userJvmArgs, referencedFiles: args.referencedFiles };
}

function materializeNeoForgeServerJar(root, minecraftVersion) {
  const rootServerJar = path.join(root, 'server.jar');
  if (fs.existsSync(rootServerJar)) return requireJar(root, rootServerJar);
  const installedServerJar = resolveControlledPath(
    root,
    `libraries/net/minecraft/server/${minecraftVersion}/server-${minecraftVersion}.jar`
  );
  requireJar(root, installedServerJar);
  fs.copyFileSync(installedServerJar, rootServerJar, fs.constants.COPYFILE_EXCL);
  return requireJar(root, rootServerJar);
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every(key => allowed.includes(key));
}

function validateQuiltHashObject(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['sha1', 'sha256', 'sha512'])) throw unavailable();
  const checks = { sha1: 40, sha256: 64, sha512: 128 };
  for (const [name, length] of Object.entries(checks)) {
    if (value[name] !== undefined && !(typeof value[name] === 'string' && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value[name]))) throw unavailable();
  }
  return value;
}

function validateQuiltPair(value, minecraftVersion, expectedLoaderVersion = null) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['loader', 'hashed', 'intermediary', 'launcherMeta']) ||
    !isPlainObject(value.loader) || !isPlainObject(value.hashed) || !isPlainObject(value.intermediary) || !isPlainObject(value.launcherMeta)) throw unavailable();
  if (!hasOnlyKeys(value.loader, ['maven', 'version', 'separator', 'build', 'stable', 'file_size', 'hashes']) ||
    !hasOnlyKeys(value.hashed, ['maven', 'version', 'file_size', 'hashes']) ||
    !hasOnlyKeys(value.intermediary, ['maven', 'version', 'stable'])) throw unavailable();
  const loaderVersion = value.loader.version;
  if (!validExactQuiltLoaderVersion(loaderVersion) || (expectedLoaderVersion !== null && loaderVersion !== expectedLoaderVersion) ||
    value.loader.maven !== `org.quiltmc:quilt-loader:${loaderVersion}` ||
    value.hashed.version !== minecraftVersion || value.hashed.maven !== `org.quiltmc:hashed:${minecraftVersion}` ||
    value.intermediary.version !== minecraftVersion || value.intermediary.maven !== `net.fabricmc:intermediary:${minecraftVersion}`) throw unavailable();
  if (value.loader.hashes !== undefined) validateQuiltHashObject(value.loader.hashes);
  if (value.hashed.hashes !== undefined) validateQuiltHashObject(value.hashed.hashes);
  if (value.loader.file_size !== undefined && (!Number.isSafeInteger(value.loader.file_size) || value.loader.file_size <= 0)) throw unavailable();
  if (value.hashed.file_size !== undefined && (!Number.isSafeInteger(value.hashed.file_size) || value.hashed.file_size <= 0)) throw unavailable();
  return value;
}

function parseQuiltPairList(buffer, minecraftVersion) {
  const parsed = parseBoundedJson(buffer);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 4096) throw unavailable();
  const pairs = parsed.map(value => validateQuiltPair(value, minecraftVersion));
  const versions = pairs.map(value => value.loader.version);
  if (new Set(versions.map(version => version.normalize('NFC').toLowerCase())).size !== versions.length) throw unavailable();
  return pairs;
}

async function getQuiltVersions(minecraftVersion, options = {}) {
  if (!validMinecraftVersion(minecraftVersion)) throw unavailable();
  const url = `${QUILT_META_BASE_URL}/${encodeURIComponent(minecraftVersion)}`;
  try {
    const result = await requestRuntimeBytes(url, {
      transport: requestTransport(options),
      allowedHosts: [QUILT_META_HOST],
      allowedOrigins: [QUILT_META_ORIGIN],
      maxBytes: options.maxMetadataBytes ?? DEFAULT_METADATA_BYTES,
      timeoutMs: options.timeoutMs,
      signal: options.signal
    });
    return parseQuiltPairList(result.body, minecraftVersion)
      .map(value => value.loader.version)
      .sort(compareNumericVersionDesc);
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    throw unavailable();
  }
}

function mavenCoordinateToPath(coordinate) {
  if (typeof coordinate !== 'string' || coordinate !== coordinate.trim() || coordinate.length > 384) throw runtimeIncomplete();
  const parts = coordinate.split(':');
  if (parts.length !== 3) throw runtimeIncomplete();
  const [group, artifact, version] = parts;
  const groupPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,191}$/;
  const artifactPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
  const groupSegments = group.split('.');
  const fileName = `${artifact}-${version}.jar`;
  if (!groupPattern.test(group) || groupSegments.some(segment => !segment || !isSafeWindowsBasename(segment)) ||
    !artifactPattern.test(artifact) || !isSafeWindowsBasename(artifact) || !validLoaderVersion(version) ||
    !isSafeWindowsBasename(version) || !isSafeWindowsBasename(fileName)) throw runtimeIncomplete();
  return `${groupSegments.join('/')}/${artifact}/${version}/${fileName}`;
}

function validateQuiltRepository(value) {
  let url;
  try { url = new URL(value); } catch { throw runtimeIncomplete(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
    !QUILT_MAVEN_ROOTS.has(url.hostname) || url.pathname !== QUILT_MAVEN_ROOTS.get(url.hostname)) throw runtimeIncomplete();
  return url.toString();
}

function normalizeQuiltLibraries(libraries) {
  if (!Array.isArray(libraries) || libraries.length === 0 || libraries.length > 4096) throw runtimeIncomplete();
  const identities = new Set();
  const paths = new Set();
  const result = libraries.map(entry => {
    if (!hasExactKeys(entry, ['name', 'url'])) throw runtimeIncomplete();
    const relativePath = mavenCoordinateToPath(entry.name);
    const repository = validateQuiltRepository(entry.url);
    const identity = entry.name.normalize('NFC').toLowerCase();
    const pathIdentity = relativePath.normalize('NFC').toLowerCase();
    if (identities.has(identity) || paths.has(pathIdentity)) throw runtimeIncomplete();
    identities.add(identity);
    paths.add(pathIdentity);
    return { coordinate: entry.name, repository, relativePath };
  });
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}

function validateQuiltProfile(value, minecraftVersion, loaderVersion) {
  const allowed = ['id', 'inheritsFrom', 'type', 'mainClass', 'launcherMainClass', 'arguments', 'libraries', 'releaseTime', 'time'];
  if (!hasOnlyKeys(value, allowed) || !allowed.every(key => Object.hasOwn(value, key)) ||
    value.id !== `quilt-loader-${loaderVersion}-${minecraftVersion}` || value.inheritsFrom !== minecraftVersion ||
    value.type !== 'release' || value.mainClass !== QUILT_SERVER_MAIN || value.launcherMainClass !== QUILT_LAUNCHER_MAIN ||
    !isPlainObject(value.arguments) || !hasExactKeys(value.arguments, ['game']) || !Array.isArray(value.arguments.game) ||
    value.arguments.game.length !== 0 || typeof value.releaseTime !== 'string' || typeof value.time !== 'string') throw unavailable();
  let libraries;
  try { libraries = normalizeQuiltLibraries(value.libraries); } catch { throw unavailable(); }
  return { profile: value, libraries };
}

async function resolveQuiltPairAndProfile(options) {
  const { minecraftVersion, loaderVersion } = options;
  assertRuntimeIdentifiers(minecraftVersion, loaderVersion);
  if (!validExactQuiltLoaderVersion(loaderVersion)) {
    throw codedError('LOADER_VERSION_REQUIRED', 'An exact loader version is required.');
  }
  const transport = requestTransport(options);
  const pairUrl = `${QUILT_META_BASE_URL}/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(loaderVersion)}`;
  const profileUrl = `${pairUrl}/server/json`;
  const requestOptions = {
    transport,
    allowedHosts: [QUILT_META_HOST],
    allowedOrigins: [QUILT_META_ORIGIN],
    maxBytes: options.maxMetadataBytes ?? DEFAULT_METADATA_BYTES,
    timeoutMs: options.timeoutMs,
    signal: options.signal
  };
  let pairResponse;
  let profileResponse;
  try {
    pairResponse = await requestRuntimeBytes(pairUrl, requestOptions);
    const pair = validateQuiltPair(parseBoundedJson(pairResponse.body), minecraftVersion, loaderVersion);
    profileResponse = await requestRuntimeBytes(profileUrl, requestOptions);
    const validatedProfile = validateQuiltProfile(parseBoundedJson(profileResponse.body), minecraftVersion, loaderVersion);
    return { pair, ...validatedProfile };
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    throw unavailable();
  }
}

function expectedQuiltVerification(pair, coordinate) {
  const candidates = [pair.loader, pair.hashed, pair.intermediary];
  const match = candidates.find(entry => entry.maven === coordinate);
  if (!match) return null;
  const digests = [];
  for (const algorithm of ['sha512', 'sha256', 'sha1']) {
    if (match.hashes?.[algorithm]) {
      digests.push({
        algorithm,
        digest: match.hashes[algorithm].toLowerCase()
      });
    }
  }
  return {
    digests,
    size: Number.isSafeInteger(match.file_size) ? match.file_size : null
  };
}

function assertJarBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw runtimeIncomplete();
  try { new AdmZip(bytes).getEntries(); } catch { throw runtimeIncomplete(); }
}

async function downloadQuiltLibraries(root, libraries, pair, options) {
  const transport = requestTransport(options);
  const downloaded = [];
  for (const library of libraries) {
    const url = new URL(library.relativePath, library.repository).toString();
    let response;
    try {
      response = await requestRuntimeBytes(url, {
        transport,
        allowedHosts: [new URL(library.repository).hostname],
        allowedOrigins: [new URL(library.repository).origin],
        maxBytes: options.maxLibraryBytes ?? DEFAULT_LIBRARY_BYTES,
        timeoutMs: options.timeoutMs,
        signal: options.signal
      });
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      throw runtimeIncomplete();
    }
    assertJarBytes(response.body);
    const expected = expectedQuiltVerification(pair, library.coordinate);
    if (expected && ((expected.size !== null && response.body.length !== expected.size) ||
      expected.digests.some(({ algorithm, digest }) => digestBuffer(response.body, algorithm) !== digest))) {
      throw runtimeIncomplete();
    }
    const destination = resolveControlledPath(root, `libraries/${library.relativePath}`);
    writeNewControlledFile(root, destination, response.body);
    downloaded.push({ ...library, relativePath: `libraries/${library.relativePath}` });
  }
  return downloaded;
}

function foldManifestAttribute(name, value) {
  const firstPrefix = `${name}: `;
  const lines = [];
  let remaining = value;
  let prefix = firstPrefix;
  while (remaining.length > 0) {
    const capacity = 70 - prefix.length;
    let take = Math.min(capacity, remaining.length);
    if (take < remaining.length) {
      const boundary = remaining.lastIndexOf(' ', take);
      if (boundary > 0) take = boundary + 1;
    }
    lines.push(`${prefix}${remaining.slice(0, take)}`);
    remaining = remaining.slice(take);
    prefix = ' ';
  }
  return lines.join('\r\n');
}

function createQuiltLauncherJar(root, libraries) {
  const classPath = libraries.map(library => library.relativePath).join(' ');
  const manifest = [
    'Manifest-Version: 1.0',
    `Main-Class: ${QUILT_LAUNCHER_MAIN}`,
    foldManifestAttribute('Class-Path', classPath),
    '',
    ''
  ].join('\r\n');
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(manifest, 'utf8'));
  const entry = zip.getEntry('META-INF/MANIFEST.MF');
  entry.header.time = new Date('1980-01-01T00:00:00.000Z');
  const destination = path.join(root, 'quilt-server-launch.jar');
  writeNewControlledFile(root, destination, zip.toBuffer());
  return destination;
}

function parseJarManifest(filePath) {
  let zip;
  try { zip = new AdmZip(filePath); } catch { throw runtimeIncomplete(); }
  const entries = zip.getEntries().filter(entry => entry.entryName.toUpperCase() === 'META-INF/MANIFEST.MF');
  if (entries.length !== 1 || entries[0].header.size > 1024 * 1024) throw runtimeIncomplete();
  const text = fatalUtf8(entries[0].getData());
  const unfolded = text.replace(/\r?\n /g, '');
  const attributes = new Map();
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(': ');
    if (separator < 1) throw runtimeIncomplete();
    const key = line.slice(0, separator);
    if (attributes.has(key)) throw runtimeIncomplete();
    attributes.set(key, line.slice(separator + 2));
  }
  return attributes;
}

function quiltLayout(root, loaderMetadata) {
  if (!hasExactKeys(loaderMetadata, ['family', 'launcherJar', 'properties', 'libraries']) ||
    loaderMetadata.family !== 'quilt' || !Array.isArray(loaderMetadata.libraries) || loaderMetadata.libraries.length === 0) throw runtimeIncomplete();
  const launcherJar = resolveControlledPath(root, loaderMetadata.launcherJar);
  const propertiesPath = resolveControlledPath(root, loaderMetadata.properties);
  const serverJar = path.join(root, 'server.jar');
  requireJar(root, launcherJar);
  requireJar(root, serverJar);
  assertRegularContainedFile(root, propertiesPath);
  const properties = parsePropertiesExact(propertiesPath);
  if (properties.size !== 1 || properties.get('serverJar') !== 'server.jar') throw runtimeIncomplete();
  const libraries = loaderMetadata.libraries.map(library => {
    if (!hasExactKeys(library, ['coordinate', 'repository', 'relativePath'])) throw runtimeIncomplete();
    mavenCoordinateToPath(library.coordinate);
    validateQuiltRepository(library.repository);
    const libraryPath = resolveControlledPath(root, library.relativePath);
    requireJar(root, libraryPath);
    return library;
  });
  const sorted = [...libraries].sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  if (libraries.some((library, index) => library.relativePath !== sorted[index].relativePath)) throw runtimeIncomplete();
  const manifest = parseJarManifest(launcherJar);
  if (manifest.get('Manifest-Version') !== '1.0' || manifest.get('Main-Class') !== QUILT_LAUNCHER_MAIN ||
    manifest.get('Class-Path') !== libraries.map(library => library.relativePath).join(' ')) throw runtimeIncomplete();
  return { launcherJar, propertiesPath, serverJar, libraries };
}

function getForgeArtifactVersion(minecraftVersion, loaderVersion) {
  if (!minecraftVersion || !loaderVersion) {
    return null;
  }

  const [, minor] = String(minecraftVersion).split('.');
  const minorVersion = Number.parseInt(minor, 10);
  const normalizedLoaderVersion = String(loaderVersion);

  if (minorVersion >= 7 && minorVersion <= 8) {
    return `${minecraftVersion}-${normalizedLoaderVersion}-${minecraftVersion}`;
  }

  if (normalizedLoaderVersion.startsWith(`${minecraftVersion}`)) {
    return normalizedLoaderVersion;
  }

  return `${minecraftVersion}-${normalizedLoaderVersion}`;
}

function getForgeInstallerPath(targetPath, minecraftVersion, loaderVersion) {
  const artifactVersion = getForgeArtifactVersion(minecraftVersion, loaderVersion);
  if (!targetPath || !artifactVersion) {
    return null;
  }

  return path.join(
    targetPath,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    artifactVersion,
    `forge-${artifactVersion}-installer.jar`
  );
}

async function clearStaleForgeInstaller(targetPath, minecraftVersion, loaderVersion) {
  const installerPath = getForgeInstallerPath(targetPath, minecraftVersion, loaderVersion);
  if (!installerPath || !fs.existsSync(installerPath)) {
    return { installerPath, removed: false };
  }

  try {
    try {
      fs.chmodSync(installerPath, 0o666);
    } catch {
      // Best effort only. Some synced folders keep their own ACLs.
    }

    await fs.promises.rm(installerPath, {
      force: true,
      maxRetries: 6,
      retryDelay: 250
    });
    return { installerPath, removed: true };
  } catch (error) {
    getLogger().warn('Failed to remove stale Forge installer artifact before retry', {
      category: 'client',
      data: {
        service: 'LoaderInstallService',
        operation: 'clearStaleForgeInstaller',
        installerPath,
        error: error?.message || String(error)
      }
    });
    return { installerPath, removed: false, error };
  }
}

function isForgeInstallerOpenError(error, installerPath) {
  const message = error?.message || '';
  if (!installerPath || !message) {
    return false;
  }

  const normalizedInstallerPath = path.normalize(installerPath).toLowerCase();
  const normalizedMessage = String(message).replaceAll('/', path.sep).toLowerCase();

  return /eperm|ebusy|operation not permitted|resource busy/i.test(normalizedMessage)
    && normalizedMessage.includes(normalizedInstallerPath);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadFileBuffer(url, redirectCount = 0) {
  if (redirectCount > 5) {
    throw new Error(`Too many redirects for ${url}`);
  }

  const safeUrl = assertSafeRemoteUrl(url, { allowedProtocols: ['https:'] });
  const response = await fetch(safeUrl, {
    redirect: 'manual',
    headers: {
      'User-Agent': 'Minecraft-Core/LoaderInstallService'
    }
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    const redirectedUrl = resolveSafeRedirectUrl(location, safeUrl, {
      allowedProtocols: ['https:']
    });
    return downloadFileBuffer(redirectedUrl, redirectCount + 1);
  }

  if (!response.ok) {
    throw new Error(`Request failed for ${safeUrl}: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function downloadExpectedSha1(url) {
  const text = await fetchText(`${url}.sha1`);
  const match = String(text || '').match(/[a-fA-F0-9]{40}/);
  if (!match) {
    throw new Error(`Missing SHA-1 checksum for ${url}`);
  }
  return match[0].toLowerCase();
}

function calculateBufferSha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex').toLowerCase();
}

function getForgeInstallerDownloadUrls(minecraftVersion, loaderVersion) {
  const artifactVersion = getForgeArtifactVersion(minecraftVersion, loaderVersion);
  if (!artifactVersion) {
    return [];
  }

  const relativePath = `net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}-installer.jar`;

  return [
    `https://maven.minecraftforge.net/${relativePath}`,
    `https://files.minecraftforge.net/maven/${relativePath}`
  ];
}

async function canReadForgeInstallerJar(installerPath, minecraftVersion, loaderVersion) {
  if (!installerPath || !fs.existsSync(installerPath)) {
    return false;
  }

  const forgeArtifactVersion = getForgeArtifactVersion(minecraftVersion, loaderVersion);
  if (!forgeArtifactVersion) {
    return false;
  }

  let zip;
  try {
    zip = await openZip(installerPath, { lazyEntries: true, autoClose: false });
    const entries = await walkForgeInstallerEntries(zip, forgeArtifactVersion);
    return !!entries.installProfileJson && !!entries.versionJson;
  } catch {
    return false;
  } finally {
    try {
      zip?.close();
    } catch {
      // Ignore zip close errors during validation.
    }
  }
}

async function stageForgeInstallerJar(targetPath, minecraftVersion, loaderVersion) {
  const installerPath = getForgeInstallerPath(targetPath, minecraftVersion, loaderVersion);
  if (!installerPath) {
    throw new Error('Unable to resolve Forge installer path');
  }

  if (await canReadForgeInstallerJar(installerPath, minecraftVersion, loaderVersion)) {
    return installerPath;
  }

  await fs.promises.mkdir(path.dirname(installerPath), { recursive: true });
  await clearStaleForgeInstaller(targetPath, minecraftVersion, loaderVersion);

  const stagedPath = `${installerPath}.download`;
  await fs.promises.rm(stagedPath, {
    force: true,
    maxRetries: 4,
    retryDelay: 150
  }).catch(() => {});

  let lastError = null;

  for (const url of getForgeInstallerDownloadUrls(minecraftVersion, loaderVersion)) {
    try {
      const expectedSha1 = await downloadExpectedSha1(url);
      const fileBuffer = await downloadFileBuffer(url);
      const actualSha1 = calculateBufferSha1(fileBuffer);
      if (actualSha1 !== expectedSha1) {
        throw new Error(`Downloaded Forge installer checksum mismatch for ${url}`);
      }
      await fs.promises.writeFile(stagedPath, fileBuffer);

      const stagedReadable = await canReadForgeInstallerJar(stagedPath, minecraftVersion, loaderVersion);
      if (!stagedReadable) {
        throw new Error(`Downloaded Forge installer from ${url} is invalid`);
      }

      await clearStaleForgeInstaller(targetPath, minecraftVersion, loaderVersion);
      await fs.promises.rename(stagedPath, installerPath);
      return installerPath;
    } catch (error) {
      lastError = error;
      await fs.promises.rm(stagedPath, {
        force: true,
        maxRetries: 2,
        retryDelay: 100
      }).catch(() => {});
    }
  }

  throw lastError || new Error('Unable to stage Forge installer jar');
}

async function installForgeClientFromLocalInstaller(options = {}) {
  const installerPath = await stageForgeInstallerJar(
    options.clientPath,
    options.minecraftVersion,
    options.loaderVersion
  );
  const forgeArtifactVersion = getForgeArtifactVersion(
    options.minecraftVersion,
    options.loaderVersion
  );
  const minecraftFolder = MinecraftFolder.from(options.clientPath);

  let zip;
  try {
    zip = await openZip(installerPath, { lazyEntries: true, autoClose: false });
    const entries = await walkForgeInstallerEntries(zip, forgeArtifactVersion);

    if (!entries.installProfileJson) {
      throw new Error(`Missing install_profile.json in Forge installer ${installerPath}`);
    }

    if (!isForgeInstallerEntries(entries)) {
      throw new Error(`Unsupported Forge installer layout in ${installerPath}`);
    }

    const profile = JSON.parse(
      (await readEntry(zip, entries.installProfileJson)).toString()
    );

    const versionId = await unpackForgeInstaller(
      zip,
      entries,
      profile,
      minecraftFolder,
      installerPath,
      {
        side: 'client',
        java: options.javaPath
      }
    );

    await installByProfileTask(profile, options.clientPath, {
      side: 'client',
      java: options.javaPath
    }).startAndWait();

    return versionId;
  } finally {
    try {
      zip?.close();
    } catch {
      // Ignore zip close errors after install.
    }
  }
}

function getLegacyFabricInstaller() {
  return require('./download-manager.cjs').installFabric;
}

function emitProgress(progressChannel, payload, loader) {
  safeSend(progressChannel, payload);
  if (loader === 'fabric') {
    safeSend('fabric-install-progress', payload);
  }
}

function emitLog(logChannel, message) {
  safeSend(logChannel, message);
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    let safeUrl;
    try {
      safeUrl = assertSafeRemoteUrl(url, { allowedProtocols: ['https:'] });
    } catch (error) {
      reject(error);
      return;
    }
    https.get(safeUrl, (response) => {
      const statusCode = response.statusCode || 0;

      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        let redirectedUrl;
        try {
          redirectedUrl = resolveSafeRedirectUrl(response.headers.location, safeUrl, {
            allowedProtocols: ['https:']
          });
        } catch (error) {
          reject(error);
          return;
        }
        fetchText(redirectedUrl).then(resolve).catch(reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Request failed for ${safeUrl}: ${statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function compareNumericVersionDesc(left, right) {
  const leftParts = String(left).split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = String(right).split(/[^0-9]+/).filter(Boolean).map(Number);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return rightPart - leftPart;
    }
  }

  return String(right).localeCompare(String(left));
}

async function getForgeVersionsFromMetadata(minecraftVersion) {
  const metadataXml = await fetchText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
  const versionMatches = [...metadataXml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const prefix = `${minecraftVersion}-`;

  return versionMatches
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .filter(Boolean)
    .sort(compareNumericVersionDesc);
}

async function getForgeVersionsFromPromotions(minecraftVersion) {
  const promotionsJson = await fetchText('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const promotions = JSON.parse(promotionsJson).promos || {};
  const versions = [];

  for (const suffix of ['latest', 'recommended']) {
    const version = promotions[`${minecraftVersion}-${suffix}`];
    if (version) {
      versions.push(version);
    }
  }

  return versions;
}

async function getForgeVersionsWithFallback(minecraftVersion) {
  const loggerInstance = getLogger();

  try {
    const list = await getForgeVersionList({ minecraft: minecraftVersion });
    const xmclVersions = (list.versions || [])
      .map((entry) => entry.version)
      .filter(Boolean)
      .sort(compareNumericVersionDesc);

    if (xmclVersions.length > 0) {
      return [...new Set(xmclVersions)];
    }
  } catch (error) {
    loggerInstance.warn('XMCL Forge version lookup failed, falling back to Forge metadata', {
      category: 'mods',
      data: {
        service: 'LoaderInstallService',
        operation: 'getForgeVersionsWithFallback',
        minecraftVersion,
        error: error.message
      }
    });
  }

  const [metadataVersions, promotedVersions] = await Promise.all([
    getForgeVersionsFromMetadata(minecraftVersion).catch(() => []),
    getForgeVersionsFromPromotions(minecraftVersion).catch(() => [])
  ]);

  return [...new Set([...promotedVersions, ...metadataVersions])];
}

async function getMinecraftVersionMetadata(minecraftVersion) {
  const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  const versionInfo = Array.isArray(manifest.versions)
    ? manifest.versions.find((entry) => entry.id === minecraftVersion)
    : null;

  if (!versionInfo?.url) {
    throw new Error(`Minecraft version metadata not found for ${minecraftVersion}`);
  }

  return versionInfo;
}

function resolveForgeVersionId(targetPath, minecraftVersion, loaderVersion) {
  const candidate = `${minecraftVersion}-forge-${loaderVersion}`;
  const candidatePath = path.join(targetPath, 'versions', candidate);
  if (fs.existsSync(candidatePath)) {
    return candidate;
  }

  const versionsRoot = path.join(targetPath, 'versions');
  if (!fs.existsSync(versionsRoot)) {
    return candidate;
  }

  const fallback = fs.readdirSync(versionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .find((entry) => entry.startsWith(`${minecraftVersion}-forge-`) && entry.includes(loaderVersion));

  return fallback || candidate;
}

function ensureForgeRootShim(targetPath, minecraftVersion, loaderVersion) {
  if (!targetPath || !minecraftVersion || !loaderVersion) {
    return null;
  }

  const shimName = `forge-${minecraftVersion}-${loaderVersion}-shim.jar`;
  const sourceShimPath = path.join(
    targetPath,
    'libraries',
    'net',
    'minecraftforge',
    'forge',
    `${minecraftVersion}-${loaderVersion}`,
    shimName
  );

  if (!fs.existsSync(sourceShimPath)) {
    return null;
  }

  const rootShimPath = path.join(targetPath, shimName);
  const shouldCopy = !fs.existsSync(rootShimPath)
    || fs.statSync(rootShimPath).size !== fs.statSync(sourceShimPath).size;

  if (shouldCopy) {
    fs.copyFileSync(sourceShimPath, rootShimPath);
  }

  return rootShimPath;
}

async function ensureBaseMinecraftServerLayout(targetPath, minecraftVersion, logChannel, progressChannel) {
  emitLog(logChannel, `🧱 Preparing Minecraft ${minecraftVersion} server runtime...`);
  emitProgress(progressChannel, { percent: 20, speed: 'Resolving Minecraft server metadata...' }, 'forge');

  const versionManifestEntry = await getMinecraftVersionMetadata(minecraftVersion);
  await installVersion(versionManifestEntry, targetPath, { side: 'server' });

  const minecraftFolder = MinecraftFolder.from(targetPath);
  const rootServerJar = path.join(targetPath, 'server.jar');
  const versionedServerJar = minecraftFolder.getVersionJar(minecraftVersion, 'server');
  if (!fs.existsSync(rootServerJar) && fs.existsSync(versionedServerJar)) {
    fs.copyFileSync(versionedServerJar, rootServerJar);
  }

  emitProgress(progressChannel, { percent: 40, speed: 'Minecraft server runtime prepared' }, 'forge');
}

async function ensureForgeServerLibraries(targetPath, minecraftVersion, loaderVersion, logChannel, progressChannel) {
  const forgeVersionId = resolveForgeVersionId(targetPath, minecraftVersion, loaderVersion);
  emitLog(logChannel, `📚 Installing Forge runtime libraries for ${forgeVersionId}...`);
  emitProgress(progressChannel, { percent: 80, speed: 'Downloading Forge libraries...' }, 'forge');

  const resolvedForgeVersion = await Version.parse(targetPath, forgeVersionId);
  await installLibraries(resolvedForgeVersion);
  runRuntimeStageSync('forge-shim', () => ensureForgeRootShim(targetPath, minecraftVersion, loaderVersion));

  emitProgress(progressChannel, { percent: 95, speed: 'Forge libraries ready' }, 'forge');
  return forgeVersionId;
}

async function getForgeRuntimeHealthIssues(targetPath, minecraftVersion, loaderVersion) {
  const issues = [];

  if (!minecraftVersion || !loaderVersion) {
    issues.push('Forge version metadata');
    return issues;
  }

  const minecraftFolder = MinecraftFolder.from(targetPath);
  const baseVersionJson = path.join(targetPath, 'versions', minecraftVersion, `${minecraftVersion}.json`);
  const baseServerJar = minecraftFolder.getVersionJar(minecraftVersion, 'server');
  const rootShimJar = path.join(targetPath, `forge-${minecraftVersion}-${loaderVersion}-shim.jar`);
  if (!fs.existsSync(baseVersionJson)) {
    issues.push(`Minecraft ${minecraftVersion} version metadata`);
  }
  if (!fs.existsSync(baseServerJar)) {
    issues.push(`Minecraft ${minecraftVersion} server runtime jar`);
  }

  try {
    const forgeVersionId = resolveForgeVersionId(targetPath, minecraftVersion, loaderVersion);
    const forgeVersionRoot = path.join(targetPath, 'versions', forgeVersionId);
    if (!fs.existsSync(forgeVersionRoot)) {
      issues.push('Forge version metadata');
      return issues;
    }

    if (!fs.existsSync(rootShimJar)) {
      issues.push('Forge shim jar');
    }

    const resolvedForgeVersion = await Version.parse(targetPath, forgeVersionId);
    const missingLibraries = resolvedForgeVersion.libraries.filter((library) => {
      const relativePath = library?.download?.path;
      if (!relativePath) {
        return false;
      }
      return !fs.existsSync(minecraftFolder.getLibraryByPath(relativePath));
    });

    if (missingLibraries.length > 0) {
      issues.push(`Forge libraries missing (${missingLibraries.length})`);
    }
  } catch (error) {
    getLogger().warn('Failed to inspect Forge runtime health', {
      category: 'mods',
      data: {
        service: 'LoaderInstallService',
        operation: 'getForgeRuntimeHealthIssues',
        targetPath,
        minecraftVersion,
        loaderVersion,
        error: error.message
      }
    });
    issues.push('Forge runtime metadata');
  }

  return [...new Set(issues)];
}

function validateRuntimeRecord(root, expectedRuntime, record, options = {}) {
  if (!hasExactKeys(record, ['formatVersion', 'runtime', 'loader', 'artifacts']) || record.formatVersion !== 1 ||
    !Array.isArray(record.artifacts) || record.artifacts.length === 0 || record.artifacts.length > 10000) throw runtimeIncomplete();
  const runtime = normalizeRuntime(record.runtime);
  if (!runtimeTupleEquals(runtime, expectedRuntime)) throw runtimeIncomplete();
  if (!isPlainObject(record.loader) || record.loader.family !== runtime.loaderFamily) throw runtimeIncomplete();
  const artifactPaths = new Set();
  const artifactValidator = options.artifactValidator || validateArtifactRecord;
  if (typeof artifactValidator !== 'function') throw runtimeIncomplete();
  for (const artifact of record.artifacts) {
    const filePath = artifactValidator(root, artifact);
    const identity = portableRelative(root, filePath).normalize('NFC').toLowerCase();
    if (artifactPaths.has(identity)) throw runtimeIncomplete();
    artifactPaths.add(identity);
  }
  const requireRecorded = filePath => {
    const identity = portableRelative(root, filePath).normalize('NFC').toLowerCase();
    if (!artifactPaths.has(identity)) throw runtimeIncomplete();
  };
  if (runtime.loaderFamily === 'neoforge') {
    if (!hasExactKeys(record.loader, ['family', 'argsFile', 'universalJar']) ||
      record.loader.argsFile !== `libraries/net/neoforged/neoforge/${runtime.loaderVersion}/win_args.txt` ||
      record.loader.universalJar !== `libraries/net/neoforged/neoforge/${runtime.loaderVersion}/neoforge-${runtime.loaderVersion}-universal.jar`) throw runtimeIncomplete();
    const layout = neoForgeLayout(root, runtime.loaderVersion, runtime.minecraftVersion);
    [layout.argsFile, layout.universalJar, layout.serverJar, layout.userJvmArgs, ...layout.referencedFiles].forEach(requireRecorded);
  } else if (runtime.loaderFamily === 'quilt') {
    const layout = quiltLayout(root, record.loader);
    [layout.launcherJar, layout.propertiesPath, layout.serverJar,
      ...layout.libraries.map(library => resolveControlledPath(root, library.relativePath))].forEach(requireRecorded);
  } else if (runtime.loaderFamily === 'fabric') {
    if (!hasExactKeys(record.loader, ['family', 'launcherJar']) || record.loader.launcherJar !== 'fabric-server-launch.jar') throw runtimeIncomplete();
    requireJar(root, path.join(root, record.loader.launcherJar));
    requireJar(root, path.join(root, 'server.jar'));
  } else if (runtime.loaderFamily === 'forge') {
    const expectedArgsFile = `libraries/net/minecraftforge/forge/${runtime.minecraftVersion}-${runtime.loaderVersion}/win_args.txt`;
    if (hasExactKeys(record.loader, ['family', 'argsFile'])) {
      if (record.loader.argsFile !== expectedArgsFile) throw runtimeIncomplete();
      const argsFile = resolveControlledPath(root, record.loader.argsFile);
      assertRegularContainedFile(root, argsFile);
      requireRecorded(argsFile);
    } else if (hasExactKeys(record.loader, ['family', 'launchJar', 'serverJar', 'libraries'])) {
      if (!Array.isArray(record.loader.libraries) || record.loader.libraries.length === 0 ||
          record.loader.libraries.some(relativePath => typeof relativePath !== 'string')) throw runtimeIncomplete();
      const layout = legacyForgeLayout(root, runtime);
      if (record.loader.launchJar !== layout.launchJar || record.loader.serverJar !== layout.serverJar ||
          record.loader.libraries.length !== layout.libraries.length ||
          record.loader.libraries.some((relativePath, index) => relativePath !== layout.libraries[index])) {
        throw runtimeIncomplete();
      }
      [layout.launchJar, layout.serverJar, ...layout.libraries]
        .map(relativePath => resolveControlledPath(root, relativePath))
        .forEach(requireRecorded);
    } else {
      throw runtimeIncomplete();
    }
  } else if (runtime.loaderFamily === 'vanilla') {
    if (!hasExactKeys(record.loader, ['family', 'serverJar']) || record.loader.serverJar !== 'server.jar') throw runtimeIncomplete();
    requireJar(root, path.join(root, 'server.jar'));
  } else {
    throw unsupportedLoader(runtime.loaderFamily);
  }
  return { valid: true, runtime, loader: record.loader, artifacts: record.artifacts };
}

function inspectPreparedRuntime(serverPath) {
  let root;
  try {
    root = assertCanonicalDirectory(serverPath);
    const metadataPath = path.join(root, RUNTIME_METADATA_RELATIVE);
    if (!fs.existsSync(metadataPath)) return null;
    const inspected = assertRegularContainedFile(root, metadataPath);
    if (inspected.stat.size < 2 || inspected.stat.size > DEFAULT_METADATA_BYTES) throw runtimeIncomplete();
    const record = parseBoundedJson(fs.readFileSync(metadataPath));
    return validateRuntimeRecord(root, normalizeRuntime(record?.runtime), record);
  } catch (error) {
    if (error?.code === 'UNSUPPORTED_LOADER') throw error;
    throw runtimeIncomplete();
  }
}

function validatePreparedRuntime(serverPath, runtimeTuple) {
  const expectedRuntime = normalizeRuntime(runtimeTuple);
  const validation = inspectPreparedRuntime(serverPath);
  if (!validation || !runtimeTupleEquals(validation.runtime, expectedRuntime)) throw runtimeIncomplete();
  return validation;
}

function publishRuntimeMetadata(root, runtime, loader, files) {
  const artifacts = [...new Set(files.map(filePath => path.resolve(filePath)))]
    .map(filePath => buildArtifactRecord(root, filePath))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  const record = { formatVersion: 1, runtime, loader, artifacts };
  validateRuntimeRecord(root, runtime, record);
  atomicWriteRuntimeMetadata(root, record);
  return validatePreparedRuntime(root, runtime);
}

function publishForgeRuntimeMetadata(root, runtime) {
  const artifactVersion = `${runtime.minecraftVersion}-${runtime.loaderVersion}`;
  const argsFile = resolveControlledPath(
    root,
    `libraries/net/minecraftforge/forge/${artifactVersion}/win_args.txt`
  );
  const installedLaunchJar = resolveControlledPath(
    root,
    `libraries/net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}.jar`
  );
  const rootLaunchJar = resolveControlledPath(root, `forge-${artifactVersion}.jar`);
  const rootServerJar = resolveControlledPath(root, `minecraft_server.${runtime.minecraftVersion}.jar`);
  if (!fs.existsSync(argsFile) && (fs.existsSync(installedLaunchJar) ||
      !fs.existsSync(rootLaunchJar) || !fs.existsSync(rootServerJar))) {
    materializeLegacyForgeLayout(root, runtime);
  }
  const loader = resolveForgeRuntimeLoader(root, runtime);
  return publishRuntimeMetadata(
    root,
    runtime,
    loader,
    listRuntimeArtifactFiles(root).map(file => file.source)
  );
}

function assertStableArtifactEvidence(root, evidence, fsApi = fs, diagnosticStage = 'finalizer-artifact-digest') {
  try {
    const pathStat = fsApi.lstatSync(evidence.path);
    const realPath = fsApi.realpathSync.native(evidence.path);
    const rootRealPath = fsApi.realpathSync.native(root);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || realPath !== evidence.realPath ||
        !inside(rootRealPath, realPath) || !sameFileIdentity(evidence.stat, pathStat)) {
      const error = runtimeIncomplete();
      const mask = changedIdentityFields(evidence.stat, pathStat);
      if (mask) error.runtimeDiagnostic = {
        stage: diagnosticStage, reason: 'identity-changed', changedIdentityFields: mask
      };
      throw error;
    }
  } catch (error) {
    if (error?.code === 'RUNTIME_INCOMPLETE') throw error;
    const failure = runtimeIncomplete();
    failure.runtimeDiagnostic = runtimeDiagnosticFor(error, diagnosticStage);
    throw failure;
  }
}

function finalizeForgeRuntimeMetadata(root, runtimeTuple, options = {}) {
  const fsApi = options.fsApi || fs;
  let diagnosticStage = 'finalizer-layout';
  try {
    root = assertCanonicalDirectory(root);
    const runtime = normalizeRuntime(runtimeTuple);
    if (runtime.loaderFamily !== 'forge') throw runtimeIncomplete();
    const artifactVersion = `${runtime.minecraftVersion}-${runtime.loaderVersion}`;
    const argsFile = resolveControlledPath(
      root,
      `libraries/net/minecraftforge/forge/${artifactVersion}/win_args.txt`
    );
    const installedLaunchJar = resolveControlledPath(
      root,
      `libraries/net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}.jar`
    );
    const rootLaunchJar = resolveControlledPath(root, `forge-${artifactVersion}.jar`);
    const rootServerJar = resolveControlledPath(root, `minecraft_server.${runtime.minecraftVersion}.jar`);
    if (!fs.existsSync(argsFile) && (fs.existsSync(installedLaunchJar) ||
        !fs.existsSync(rootLaunchJar) || !fs.existsSync(rootServerJar))) {
      materializeLegacyForgeLayout(root, runtime);
    }
    const loader = resolveForgeRuntimeLoader(root, runtime);
    diagnosticStage = 'finalizer-artifact-collection';
    const preparedArtifacts = listRuntimeArtifactFiles(root, { maxFiles: 10000 })
      .map(file => {
        const inspected = runRuntimeStageSync('finalizer-artifact-digest', () => digestStableArtifact(root, file.source, {
          fsApi, diagnosticStage: 'finalizer-artifact-digest'
        }));
        return {
          evidence: inspected,
          record: {
            relativePath: portableRelative(root, inspected.path),
            size: inspected.size,
            sha256: inspected.sha256,
            sha512: inspected.sha512
          }
        };
      })
      .sort((left, right) => left.record.relativePath.localeCompare(right.record.relativePath, 'en'));
    const artifactsByIdentity = new Map(preparedArtifacts.map(({ record }) => [
      record.relativePath.normalize('NFC').toLowerCase(),
      record
    ]));
    const validateFreshArtifact = (recordRoot, artifact) => {
      const filePath = artifactRecordPath(recordRoot, artifact);
      const expected = artifactsByIdentity.get(artifact.relativePath.normalize('NFC').toLowerCase());
      if (!expected || expected.relativePath !== artifact.relativePath || expected.size !== artifact.size ||
          expected.sha256 !== artifact.sha256 || expected.sha512 !== artifact.sha512) throw runtimeIncomplete();
      return filePath;
    };
    const record = {
      formatVersion: 1,
      runtime,
      loader,
      artifacts: preparedArtifacts.map(({ record: artifact }) => artifact)
    };
    diagnosticStage = 'finalizer-fresh-record';
    validateRuntimeRecord(root, runtime, record, { artifactValidator: validateFreshArtifact });
    diagnosticStage = 'finalizer-stability-before-publish';
    preparedArtifacts.forEach(({ evidence }) => assertStableArtifactEvidence(root, evidence, fsApi, diagnosticStage));
    diagnosticStage = 'finalizer-publish';
    atomicWriteRuntimeMetadata(root, record);
    diagnosticStage = 'finalizer-readback';
    const metadataPath = path.join(root, RUNTIME_METADATA_RELATIVE);
    const inspectedMetadata = assertRegularContainedFile(root, metadataPath);
    if (inspectedMetadata.stat.size < 2 || inspectedMetadata.stat.size > DEFAULT_METADATA_BYTES) throw runtimeIncomplete();
    const published = parseBoundedJson(fs.readFileSync(metadataPath));
    if (JSON.stringify(published) !== JSON.stringify(record)) throw runtimeIncomplete();
    diagnosticStage = 'finalizer-stability-after-publish';
    preparedArtifacts.forEach(({ evidence }) => assertStableArtifactEvidence(root, evidence, fsApi, diagnosticStage));
    diagnosticStage = 'finalizer-fresh-record';
    return validateRuntimeRecord(root, runtime, published, { artifactValidator: validateFreshArtifact });
  } catch (error) {
    throw annotateRuntimeError(error, diagnosticStage);
  }
}

async function prepareRuntimeIdentity(options, loaderFamily) {
  assertRuntimeIdentifiers(options.minecraftVersion, options.loaderVersion);
  if (typeof options.targetPath !== 'string' || !path.isAbsolute(options.targetPath)) throw runtimeIncomplete();
  const root = assertCanonicalDirectory(options.targetPath);
  const javaMajor = options.javaMajor === undefined
    ? await resolveJavaMajor(options.minecraftVersion, options.resolveJavaVersion)
    : options.javaMajor;
  const runtime = normalizeRuntime({
    minecraftVersion: options.minecraftVersion,
    loaderFamily,
    loaderVersion: options.loaderVersion,
    javaMajor,
    os: options.os || 'win32',
    architecture: options.architecture || 'x64'
  });
  const validator = options.validateJava || validateManagedJava;
  if (typeof validator !== 'function') throw runtimeIncomplete();
  const validatedMajor = await validator({
    javaPath: options.javaPath,
    expectedMajor: runtime.javaMajor,
    processRunner: options.processRunner || runBoundedProcess,
    signal: options.signal
  });
  if (validatedMajor !== runtime.javaMajor) throw runtimeIncomplete('The selected Java runtime has the wrong major version.');
  return { root, runtime };
}

async function installNeoForgeServer(options) {
  const { root, runtime } = await prepareRuntimeIdentity(options, 'neoforge');
  const installer = await resolveNeoForgeInstaller(options);
  let workspace = null;
  let preserveWorkspace = false;
  try {
    const created = createRuntimeWorkspace(root, 'neoforge');
    workspace = created.workspace;
    const { serverRoot } = created;
    const installerPath = path.join(workspace, `neoforge-${runtime.loaderVersion}-installer.jar`);
    writeNewControlledFile(workspace, installerPath, installer.bytes);
    validateNeoForgeInstallerProfile(installerPath, runtime.minecraftVersion, runtime.loaderVersion);
    const processRunner = options.processRunner || runBoundedProcess;
    if (typeof processRunner !== 'function' || typeof options.javaPath !== 'string' || !path.isAbsolute(options.javaPath)) throw runtimeIncomplete();
    await processRunner({
      command: options.javaPath,
      args: ['-jar', installerPath, '--installServer'],
      cwd: serverRoot,
      env: sanitizedProcessEnvironment(options.javaPath),
      signal: options.signal,
      timeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
      maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_STDOUT_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_STDERR_BYTES,
      shell: false,
      windowsHide: true
    });
    for (const scriptName of ['run.bat', 'run.cmd', 'run.ps1', 'run.sh']) {
      const scriptPath = path.join(serverRoot, scriptName);
      if (fs.existsSync(scriptPath)) {
        const stat = fs.lstatSync(scriptPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw runtimeIncomplete();
        fs.rmSync(scriptPath);
      }
    }
    materializeNeoForgeServerJar(serverRoot, runtime.minecraftVersion);
    const layout = neoForgeLayout(serverRoot, runtime.loaderVersion, runtime.minecraftVersion);
    const loader = {
      family: 'neoforge',
      argsFile: portableRelative(serverRoot, layout.argsFile),
      universalJar: portableRelative(serverRoot, layout.universalJar)
    };
    publishRuntimeMetadata(serverRoot, runtime, loader, listRuntimeArtifactFiles(serverRoot).map(file => file.source));
    publishStagedRuntime(serverRoot, root, workspace, () => validatePreparedRuntime(root, runtime), {
      loaderFamily: 'neoforge'
    });
    return { success: true, loader: 'neoforge', loaderVersion: runtime.loaderVersion, runtime };
  } catch (error) {
    preserveWorkspace = error?.preserveWorkspace === true;
    throw normalizeRuntimeInstallError(error);
  } finally {
    if (workspace && !preserveWorkspace) cleanupRuntimeWorkspace(root, workspace);
  }
}

function officialDigestEntries(value) {
  if (!isPlainObject(value)) throw runtimeIncomplete();
  const lengths = { sha1: 40, sha256: 64, sha512: 128 };
  const unknownDigest = Object.keys(value).some(key => /^sha\d+$/i.test(key) && !Object.hasOwn(lengths, key));
  if (unknownDigest) throw runtimeIncomplete();
  const digests = [];
  for (const [algorithm, length] of Object.entries(lengths)) {
    if (value[algorithm] === undefined) continue;
    if (typeof value[algorithm] !== 'string' || !new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value[algorithm])) {
      throw runtimeIncomplete();
    }
    digests.push({ algorithm, digest: value[algorithm].toLowerCase() });
  }
  if (digests.length === 0) throw runtimeIncomplete();
  return digests;
}

function verifyOfficialDigests(bytes, digests) {
  if (digests.some(({ algorithm, digest }) => digestBuffer(bytes, algorithm) !== digest)) throw runtimeIncomplete();
}

function exactMojangUrl(value, origin, pathname) {
  let url;
  try { url = new URL(value); } catch { throw runtimeIncomplete(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.origin !== origin ||
    url.pathname !== pathname || url.search || url.hash) throw runtimeIncomplete();
  return url.toString();
}

function resolveMojangVersionEntry(manifest, minecraftVersion) {
  if (!isPlainObject(manifest) || !hasExactKeys(manifest, ['latest', 'versions']) ||
    !isPlainObject(manifest.latest) || !Array.isArray(manifest.versions) ||
    manifest.versions.length === 0 || manifest.versions.length > 4096) throw runtimeIncomplete();
  const matches = manifest.versions.filter(entry => isPlainObject(entry) && entry.id === minecraftVersion);
  if (matches.length !== 1) throw runtimeIncomplete();
  const entry = matches[0];
  if (!hasOnlyKeys(entry, ['id', 'type', 'url', 'time', 'releaseTime', 'sha1', 'sha256', 'sha512', 'complianceLevel']) ||
    typeof entry.url !== 'string') throw runtimeIncomplete();
  const digests = officialDigestEntries(entry);
  const sha1 = digests.find(digest => digest.algorithm === 'sha1')?.digest;
  if (!sha1) throw runtimeIncomplete();
  const url = exactMojangUrl(entry.url, MOJANG_META_ORIGIN, `/v1/packages/${sha1}/${minecraftVersion}.json`);
  return { url, digests };
}

function resolveMojangServerDownload(metadata, minecraftVersion, maxBytes) {
  if (!isPlainObject(metadata) || metadata.id !== minecraftVersion || !isPlainObject(metadata.downloads) ||
    !isPlainObject(metadata.downloads.server)) throw runtimeIncomplete();
  const server = metadata.downloads.server;
  if (!hasOnlyKeys(server, ['url', 'size', 'sha1', 'sha256', 'sha512']) ||
    typeof server.url !== 'string' || !Number.isSafeInteger(server.size) || server.size <= 0 || server.size > maxBytes) {
    throw runtimeIncomplete();
  }
  const digests = officialDigestEntries(server);
  const sha1 = digests.find(digest => digest.algorithm === 'sha1')?.digest;
  if (!sha1) throw runtimeIncomplete();
  const url = exactMojangUrl(server.url, MOJANG_DATA_ORIGIN, `/v1/objects/${sha1}/server.jar`);
  return { url, size: server.size, digests };
}

async function defaultEnsureQuiltBaseRuntime({
  targetPath,
  minecraftVersion,
  logChannel,
  progressChannel,
  transport: suppliedTransport,
  timeoutMs,
  maxMetadataBytes = DEFAULT_METADATA_BYTES,
  maxRuntimeBytes = DEFAULT_RUNTIME_BYTES,
  signal
}) {
  try {
    const root = assertCanonicalDirectory(targetPath);
    if (!validMinecraftVersion(minecraftVersion)) throw runtimeIncomplete();
    const transport = requestTransport({ transport: suppliedTransport });
    const metadataLimit = positiveSafeInteger(maxMetadataBytes, DEFAULT_METADATA_BYTES, 16 * 1024 * 1024);
    const runtimeLimit = positiveSafeInteger(maxRuntimeBytes, DEFAULT_RUNTIME_BYTES, DEFAULT_RUNTIME_BYTES);
    emitLog(logChannel, `Preparing the exact Minecraft ${minecraftVersion} server runtime...`);
    emitProgress(progressChannel, { percent: 20, speed: 'Resolving pinned Minecraft metadata...' }, 'quilt');
    const manifestResponse = await requestRuntimeBytes(MOJANG_VERSION_MANIFEST_URL, {
      transport,
      allowedHosts: [MOJANG_META_HOST],
      allowedOrigins: [MOJANG_META_ORIGIN],
      maxBytes: metadataLimit,
      timeoutMs,
      signal
    });
    const versionEntry = resolveMojangVersionEntry(parseBoundedJson(manifestResponse.body), minecraftVersion);
    const versionResponse = await requestRuntimeBytes(versionEntry.url, {
      transport,
      allowedHosts: [MOJANG_META_HOST],
      allowedOrigins: [MOJANG_META_ORIGIN],
      maxBytes: metadataLimit,
      timeoutMs,
      signal
    });
    verifyOfficialDigests(versionResponse.body, versionEntry.digests);
    const server = resolveMojangServerDownload(parseBoundedJson(versionResponse.body), minecraftVersion, runtimeLimit);
    const serverResponse = await requestRuntimeBytes(server.url, {
      transport,
      allowedHosts: [MOJANG_DATA_HOST],
      allowedOrigins: [MOJANG_DATA_ORIGIN],
      maxBytes: runtimeLimit,
      timeoutMs,
      signal
    });
    if (serverResponse.body.length !== server.size) throw runtimeIncomplete();
    verifyOfficialDigests(serverResponse.body, server.digests);
    assertJarBytes(serverResponse.body);
    writeNewControlledFile(root, path.join(root, 'server.jar'), serverResponse.body);
    emitProgress(progressChannel, { percent: 40, speed: 'Minecraft server runtime prepared' }, 'quilt');
  } catch (error) {
    if (error?.code === 'CANCELLED') throw error;
    throw runtimeIncomplete();
  }
}

async function ensureFabricBaseRuntime(root, runtime, options = {}, ensureBaseRuntime = defaultEnsureQuiltBaseRuntime) {
  const serverJar = path.join(root, 'server.jar');
  if (fs.existsSync(serverJar)) {
    requireJar(root, serverJar);
    return { downloaded: false, serverJar };
  }
  const request = { targetPath: root, minecraftVersion: runtime.minecraftVersion };
  for (const key of ['logChannel', 'progressChannel', 'transport', 'timeoutMs', 'maxMetadataBytes', 'maxRuntimeBytes', 'signal']) {
    if (options[key] !== undefined) request[key] = options[key];
  }
  await ensureBaseRuntime(request);
  requireJar(root, serverJar);
  return { downloaded: true, serverJar };
}

async function installQuiltServer(options) {
  const { root, runtime } = await prepareRuntimeIdentity(options, 'quilt');
  const { pair, libraries } = await resolveQuiltPairAndProfile(options);
  let workspace = null;
  let preserveWorkspace = false;
  try {
    const created = createRuntimeWorkspace(root, 'quilt');
    workspace = created.workspace;
    const { serverRoot } = created;
    const downloadedLibraries = await downloadQuiltLibraries(serverRoot, libraries, pair, options);
    const ensureBaseRuntime = options.ensureBaseRuntime || defaultEnsureQuiltBaseRuntime;
    if (typeof ensureBaseRuntime !== 'function') throw runtimeIncomplete();
    await ensureBaseRuntime({
      targetPath: serverRoot,
      minecraftVersion: runtime.minecraftVersion,
      javaPath: options.javaPath,
      logChannel: options.logChannel,
      progressChannel: options.progressChannel,
      transport: options.transport,
      timeoutMs: options.timeoutMs,
      maxMetadataBytes: options.maxMojangMetadataBytes ?? options.maxMetadataBytes,
      maxRuntimeBytes: options.maxMojangServerBytes ?? options.maxRuntimeBytes,
      signal: options.signal
    });
    requireJar(serverRoot, path.join(serverRoot, 'server.jar'));
    const launcherJar = createQuiltLauncherJar(serverRoot, downloadedLibraries);
    const propertiesPath = path.join(serverRoot, 'quilt-server-launcher.properties');
    writeNewControlledFile(serverRoot, propertiesPath, Buffer.from('serverJar=server.jar\n', 'utf8'));
    const loader = {
      family: 'quilt',
      launcherJar: portableRelative(serverRoot, launcherJar),
      properties: portableRelative(serverRoot, propertiesPath),
      libraries: downloadedLibraries
    };
    publishRuntimeMetadata(serverRoot, runtime, loader, listRuntimeArtifactFiles(serverRoot).map(file => file.source));
    publishStagedRuntime(serverRoot, root, workspace, () => validatePreparedRuntime(root, runtime), {
      loaderFamily: 'quilt'
    });
    return { success: true, loader: 'quilt', loaderVersion: runtime.loaderVersion, runtime };
  } catch (error) {
    preserveWorkspace = error?.preserveWorkspace === true;
    throw normalizeRuntimeInstallError(error);
  } finally {
    if (workspace && !preserveWorkspace) cleanupRuntimeWorkspace(root, workspace);
  }
}

async function getLoaderVersions(loader, minecraftVersion, options = {}) {
  const normalizedLoader = normalizeLoader(loader);
  if (!SUPPORTED_RUNTIME_LOADERS.has(normalizedLoader)) throw unsupportedLoader(normalizedLoader);

  if (!minecraftVersion || normalizedLoader === 'vanilla') {
    return [];
  }

  if (normalizedLoader === 'fabric') {
    const versions = await getLoaderArtifactListFor(minecraftVersion);
    return versions.map((entry) => entry.loader.version);
  }

  if (normalizedLoader === 'forge') {
    return getForgeVersionsWithFallback(minecraftVersion);
  }

  if (normalizedLoader === 'neoforge') {
    return getNeoForgeVersions(minecraftVersion, options);
  }

  if (normalizedLoader === 'quilt') {
    return getQuiltVersions(minecraftVersion, options);
  }

  throw unsupportedLoader(normalizedLoader);
}

async function installFabricServer(options) {
  const {
    targetPath,
    minecraftVersion,
    loaderVersion,
    javaPath,
    skipMutationMark,
    logChannel = 'install-log',
    progressChannel = 'loader-install-progress'
  } = options;

  // Keep using the existing installer path for server installs because it already
  // writes the expected Fabric server launch artifacts into the target folder.
  await getLegacyFabricInstaller()(
    targetPath,
    minecraftVersion,
    loaderVersion,
    logChannel,
    progressChannel,
    {
      javaPath,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(skipMutationMark === true ? { skipMutationMark: true } : {})
    }
  );

  return {
    success: true,
    loader: 'fabric',
    loaderVersion
  };
}

async function installForgeServer(options) {
  const loggerInstance = getLogger();
  const {
    targetPath,
    minecraftVersion,
    loaderVersion,
    logChannel = 'install-log',
    progressChannel = 'loader-install-progress'
  } = options;

  emitLog(logChannel, `🔧 Installing Forge ${loaderVersion} for Minecraft ${minecraftVersion}...`);
  emitProgress(progressChannel, { percent: 10, speed: 'Preparing Forge installer...' }, 'forge');

  loggerInstance.info('Starting Forge server installation', {
    category: 'mods',
    data: {
      service: 'LoaderInstallService',
      operation: 'installForgeServer',
      targetPath,
      minecraftVersion,
      loaderVersion
    }
  });

  await runRuntimeStage('base-preparation', () => ensureBaseMinecraftServerLayout(targetPath, minecraftVersion, logChannel, progressChannel));
  emitProgress(progressChannel, { percent: 55, speed: 'Running Forge installer...' }, 'forge');

  await runRuntimeStage('forge-installer', () => runForgeInstallerWorkerBoundary(options));

  const forgeVersionId = await runRuntimeStage('forge-library-completion', () => ensureForgeServerLibraries(
    targetPath,
    minecraftVersion,
    loaderVersion,
    logChannel,
    progressChannel
  ));
  runRuntimeStageSync('forge-shim', () => ensureForgeRootShim(targetPath, minecraftVersion, loaderVersion));

  emitProgress(progressChannel, { percent: 100, speed: 'Completed' }, 'forge');
  emitLog(logChannel, '✔ Forge installation completed');

  loggerInstance.info('Forge server installation completed', {
    category: 'mods',
    data: {
      service: 'LoaderInstallService',
      operation: 'installForgeServer',
      targetPath,
      minecraftVersion,
      loaderVersion,
      forgeVersionId,
      success: true
    }
  });

  return {
    success: true,
    loader: 'forge',
    loaderVersion
  };
}

function runForgeInstallerWorkerBoundary(options) {
  return runForgeInstallerWorker({
    targetPath: options.targetPath,
    minecraftVersion: options.minecraftVersion,
    loaderVersion: options.loaderVersion,
    javaPath: options.javaPath,
    signal: options.signal,
    timeoutMs: options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  });
}

function runForgeRuntimeFinalizerWorkerBoundary(options) {
  return runForgeRuntimeFinalizerWorker({
    targetPath: options.targetPath,
    runtime: options.runtime,
    signal: options.signal,
    timeoutMs: options.finalizationTimeoutMs ?? options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  });
}

function normalizeServerInstallOptions(options, loader, minecraftVersion, loaderVersion, extraOptions) {
  if (isPlainObject(options)) return { ...options };
  if (typeof options !== 'string' || !path.isAbsolute(options) || (extraOptions !== undefined && !isPlainObject(extraOptions))) {
    throw new TypeError('Server loader installation options are invalid');
  }
  return {
    ...(extraOptions || {}),
    targetPath: options,
    loader,
    minecraftVersion,
    loaderVersion
  };
}

async function installServerLoader(options = {}, loader, minecraftVersion, loaderVersion, extraOptions = {}) {
  options = normalizeServerInstallOptions(options, loader, minecraftVersion, loaderVersion, extraOptions);
  const loggerInstance = getLogger();
  const normalizedLoader = normalizeLoader(options.loader);
  if (!SUPPORTED_RUNTIME_LOADERS.has(normalizedLoader)) throw unsupportedLoader(normalizedLoader);
  if (normalizedLoader === 'quilt' && !validExactQuiltLoaderVersion(options.loaderVersion)) {
    throw codedError('LOADER_VERSION_REQUIRED', 'An exact loader version is required.');
  }
  const resultBase = {
    success: true,
    loader: normalizedLoader,
    loaderVersion: options.loaderVersion || null
  };

  loggerInstance.info('Installing server loader', {
    category: 'mods',
    data: {
      service: 'LoaderInstallService',
      operation: 'installServerLoader',
      loader: normalizedLoader,
      loaderVersion: options.loaderVersion || null,
      minecraftVersion: options.minecraftVersion || null,
      targetPath: options.targetPath || null
    }
  });

  if (normalizedLoader === 'vanilla') {
    if (options.logChannel) {
      emitLog(options.logChannel, '✔ Vanilla server selected. No loader installation needed.');
    }
    if (options.progressChannel) {
      emitProgress(options.progressChannel, { percent: 100, speed: 'Completed' }, normalizedLoader);
    }
    return resultBase;
  }

  if (!options.loaderVersion) {
    const error = new Error(`${normalizedLoader} loader version is required.`);
    error.code = 'LOADER_VERSION_REQUIRED';
    throw error;
  }

  if (normalizedLoader === 'fabric') {
    const result = await installFabricServer(options);
    return { ...resultBase, ...result };
  }

  if (normalizedLoader === 'forge') {
    const result = await installForgeServer(options);
    return { ...resultBase, ...result };
  }

  if (normalizedLoader === 'neoforge') {
    const result = await installNeoForgeServer(options);
    return { ...resultBase, ...result };
  }

  if (normalizedLoader === 'quilt') {
    const result = await installQuiltServer(options);
    return { ...resultBase, ...result };
  }

  throw unsupportedLoader(normalizedLoader);
}

async function prepareManagedServerRuntimeInProcess(options = {}) {
  if (!isPlainObject(options) || typeof options.targetPath !== 'string' || !path.isAbsolute(options.targetPath) ||
      !isPlainObject(options.runtime) || typeof options.javaPath !== 'string' || !path.isAbsolute(options.javaPath)) {
    throw runtimeIncomplete();
  }
  const root = assertCanonicalDirectory(options.targetPath);
  const runtime = normalizeRuntime(options.runtime);
  await runRuntimeStage('java-validation', async () => {
    const major = await (options.validateJava || validateManagedJava)({
      javaPath: options.javaPath,
      expectedMajor: runtime.javaMajor,
      processRunner: options.processRunner || runBoundedProcess,
      signal: options.signal
    });
    if (major !== runtime.javaMajor) throw runtimeIncomplete('The selected Java runtime has the wrong major version.');
    return major;
  });

  if (runtime.loaderFamily === 'vanilla') {
    await defaultEnsureQuiltBaseRuntime({
      targetPath: root,
      minecraftVersion: runtime.minecraftVersion,
      transport: options.transport,
      timeoutMs: options.timeoutMs,
      maxMetadataBytes: options.maxMetadataBytes,
      maxRuntimeBytes: options.maxRuntimeBytes,
      signal: options.signal
    });
    publishRuntimeMetadata(root, runtime, { family: 'vanilla', serverJar: 'server.jar' },
      listRuntimeArtifactFiles(root).map(file => file.source));
    return validatePreparedRuntime(root, runtime);
  }

  if (runtime.loaderFamily === 'fabric') {
    await ensureFabricBaseRuntime(root, runtime, options);
  }

  const installServerRuntime = options.installServerLoaderImpl || installServerLoader;
  if (typeof installServerRuntime !== 'function') throw runtimeIncomplete();
  await installServerRuntime({
    ...options,
    targetPath: root,
    loader: runtime.loaderFamily,
    minecraftVersion: runtime.minecraftVersion,
    loaderVersion: runtime.loaderVersion,
    javaMajor: runtime.javaMajor,
    os: runtime.os,
    architecture: runtime.architecture
  });

  if (runtime.loaderFamily === 'fabric') {
    publishRuntimeMetadata(root, runtime, { family: 'fabric', launcherJar: 'fabric-server-launch.jar' },
      listRuntimeArtifactFiles(root).map(file => file.source));
  } else if (runtime.loaderFamily === 'forge') {
    return runRuntimeStage('forge-finalizer', () => runForgeRuntimeFinalizerWorkerBoundary({
      ...options,
      targetPath: root,
      runtime
    }));
  }
  return validatePreparedRuntime(root, runtime);
}

function usesProductionManagedRuntimeBoundary(options) {
  if (!isPlainObject(options)) return false;
  const allowed = new Set([
    'targetPath',
    'runtime',
    'javaPath',
    'skipMutationMark',
    'signal',
    'timeoutMs',
    'terminationGraceMs'
  ]);
  return Object.keys(options).every(key => allowed.has(key)) &&
    (options.skipMutationMark === undefined || options.skipMutationMark === true);
}

async function prepareManagedServerRuntime(options = {}) {
  if (!usesProductionManagedRuntimeBoundary(options)) {
    return prepareManagedServerRuntimeInProcess(options);
  }
  const request = {
    operation: MANAGED_RUNTIME_PREPARE_OPERATION,
    targetPath: options.targetPath,
    runtime: options.runtime,
    javaPath: options.javaPath
  };
  for (const key of ['signal', 'timeoutMs', 'terminationGraceMs']) {
    if (options[key] !== undefined) request[key] = options[key];
  }
  return runManagedRuntimeWorker(request);
}

async function installClientLoader(options = {}) {
  const normalizedLoader = normalizeLoader(options.loader);

  if (normalizedLoader === 'vanilla') {
    return {
      success: true,
      loader: 'vanilla',
      loaderVersion: null,
      profileId: options.minecraftVersion
    };
  }

  if (normalizedLoader === 'fabric') {
    const versionId = await installFabricXmcl({
      minecraftVersion: options.minecraftVersion,
      version: options.loaderVersion,
      minecraft: options.clientPath,
      side: 'client'
    });
    return {
      success: true,
      loader: 'fabric',
      loaderVersion: options.loaderVersion,
      profileId: versionId
    };
  }

  if (normalizedLoader === 'forge') {
    const installerPath = getForgeInstallerPath(
      options.clientPath,
      options.minecraftVersion,
      options.loaderVersion
    );

    let versionId;
    try {
      versionId = await installForgeClientFromLocalInstaller(options);
    } catch (error) {
      if (
        !isForgeInstallerOpenError(error, installerPath)
        && !/enoent|not found|missing install_profile\.json|invalid/i.test(error?.message || '')
      ) {
        throw error;
      }

      getLogger().warn('Retrying Forge client install after installer artifact staging failure', {
        category: 'client',
        data: {
          service: 'LoaderInstallService',
          operation: 'installClientLoader',
          minecraftVersion: options.minecraftVersion,
          loaderVersion: options.loaderVersion,
          installerPath,
          error: error.message
        }
      });

      await clearStaleForgeInstaller(
        options.clientPath,
        options.minecraftVersion,
        options.loaderVersion
      );
      await delay(750);

      versionId = await installForgeClientFromLocalInstaller(options);
    }

    return {
      success: true,
      loader: 'forge',
      loaderVersion: options.loaderVersion,
      profileId: versionId
    };
  }

  throw new Error(`Unsupported client loader: ${normalizedLoader}`);
}

module.exports = {
  normalizeLoader,
  getLoaderVersions,
  installServerLoader,
  prepareManagedServerRuntime,
  installClientLoader,
  getForgeRuntimeHealthIssues,
  inspectPreparedRuntime,
  validatePreparedRuntime,
  __testUtils: {
    getForgeArtifactVersion,
    getForgeInstallerPath,
    isForgeInstallerOpenError,
    resolveJavaMajor,
    runBoundedProcess,
    publishStagedRuntime,
    getNeoForgeMinecraftPrefix,
    mavenCoordinateToPath,
    safeRelativePath,
    validateQuiltRepository,
    normalizeQuiltLibraries,
    ensureFabricBaseRuntime,
    listRuntimeArtifactFiles,
    publishForgeRuntimeMetadata,
    digestStableArtifact,
    finalizeForgeRuntimeMetadata,
    prepareManagedServerRuntimeInProcess,
    runForgeInstallerWorkerBoundary,
    runForgeRuntimeFinalizerWorkerBoundary
  }
};
