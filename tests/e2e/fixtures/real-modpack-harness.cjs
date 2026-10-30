const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_SERVER_HEALTH_TIMEOUT_MS } = require('../../../electron/services/server-health-constants.cjs');
const {
  inspectServerDirectoryTree
} = require('../../../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const {
  createExistingSiblingPaths
} = require('../../../electron/services/modpack-lifecycle/server-directory-transaction.cjs');
const scratchCleanup = require('./real-modpack-scratch-cleanup.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const REAL_SCRATCH_PREFIX = 'minecraft-core-real-';
const REAL_LIFECYCLE_ENV = 'MINECRAFT_CORE_REAL_MODPACK_E2E';
const REAL_REVERSE_ENV = 'MINECRAFT_CORE_REAL_MODPACK_E2E_REVERSE';
const PRESERVE_FAILED_REAL_E2E_ENV = 'MINECRAFT_CORE_PRESERVE_FAILED_REAL_E2E';
const MAX_EVIDENCE_OPERATION_RECORDS = 32;
const MAX_EVIDENCE_OPERATION_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_APP_LOG_BYTES = 256 * 1024;
const STARTUP_HEALTH_TIMEOUT_MS = 60_000;
const STARTUP_HEALTH_POLL_MS = 250;
const recoveryLaunchAuthorities = new WeakSet();
const lifecycleCleanupAuthorities = new WeakSet();

const REAL_MODRINTH_LIFECYCLE = Object.freeze({
  projectId: 'ca0m6gMz',
  projectName: 'Server Optimized',
  versions: Object.freeze([
    Object.freeze({ id: 'oQ6gSIoF', name: 'v1.2-1.20.1', minecraft: '1.20.1', operationKind: 'install-new' }),
    Object.freeze({ id: 'zH4ppiGM', name: 'v2-1.20.1', minecraft: '1.20.1', operationKind: 'update' }),
    Object.freeze({ id: 'MEznmVQB', name: 'v2-1.21.1', minecraft: '1.21.1', operationKind: 'switch' })
  ])
});

const TEST_ONLY_ENVIRONMENT_KEYS = Object.freeze([
  'MINECRAFT_CORE_TEST_MODE',
  'MINECRAFT_CORE_TEST_MODPACK_FACTORY',
  'MINECRAFT_CORE_TEST_RECOVERY_FACTORY',
  'MINECRAFT_CORE_TEST_IPC_OVERRIDES',
  'MINECRAFT_CORE_E2E_SCENARIO_FILE',
  'MINECRAFT_CORE_USE_DEV_SERVER',
  'MINECRAFT_CORE_DEV_SERVER_URL',
  'npm_lifecycle_event',
  'FORCE_UPDATES',
  'MC_CORE_STAGE_UPDATE_INSTALLER',
  'MC_CORE_STAGE_UPDATE_VERSION',
  'MC_CORE_STAGE_UPDATE_CLIENT_VERSION',
  'NODE_OPTIONS',
  'NODE_PATH',
  'ELECTRON_RUN_AS_NODE',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH'
]);

function isRealLifecycleEnabled(environment = process.env) {
  const value = String(environment?.[REAL_LIFECYCLE_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function isReverseLifecycleEnabled(environment = process.env) {
  const value = String(environment?.[REAL_REVERSE_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : null;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function reserveDistinctLoopbackPorts(count) {
  const ports = new Set();
  while (ports.size < count) ports.add(await reserveLoopbackPort());
  return [...ports];
}

function assertScratchRoot(root) {
  const normalized = path.resolve(root);
  if (path.dirname(normalized) !== path.resolve(os.tmpdir()) || !path.basename(normalized).startsWith(REAL_SCRATCH_PREFIX)) {
    throw new Error('Refusing to clean a path outside the real lifecycle scratch area');
  }
  return normalized;
}

function shouldPreserveFailedRealE2E(environment = process.env) {
  return environment?.[PRESERVE_FAILED_REAL_E2E_ENV] === '1';
}

function samePath(left, right) {
  const normalize = value => {
    const normalized = path.normalize(path.resolve(value));
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  return normalize(left) === normalize(right);
}

function localDirectoryIdentity(directoryPath) {
  const info = fs.lstatSync(directoryPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync(directoryPath), directoryPath)) {
    throw new TypeError('The recovery launch directory is redirected');
  }
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs ?? info.birthtimeMs)
  });
}

function sameLocalDirectoryIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.birthtimeNs === right?.birthtimeNs;
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function recoveryEvidenceSnapshot(filePath, root) {
  const resolved = path.resolve(filePath);
  if (!isPathWithin(root, resolved)) throw new TypeError('The recovery launch evidence path is invalid');
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n || opened.size < 2n || opened.size > 4n * 1024n * 1024n) {
      throw new TypeError('The recovery launch evidence file is invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const closed = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(resolved, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
        opened.dev !== closed.dev || opened.ino !== closed.ino || opened.birthtimeNs !== closed.birthtimeNs ||
        opened.mtimeNs !== closed.mtimeNs || opened.size !== closed.size ||
        closed.dev !== current.dev || closed.ino !== current.ino || closed.birthtimeNs !== current.birthtimeNs ||
        closed.mtimeNs !== current.mtimeNs || closed.size !== current.size ||
        !samePath(fs.realpathSync.native(resolved), resolved)) {
      throw new TypeError('The recovery launch evidence file changed during validation');
    }
    return Object.freeze({
      path: resolved,
      dev: String(closed.dev),
      ino: String(closed.ino),
      birthtimeNs: String(closed.birthtimeNs),
      mtimeNs: String(closed.mtimeNs),
      size: String(closed.size),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameRecoveryEvidence(left, right) {
  return left?.path === right?.path && left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.birthtimeNs === right?.birthtimeNs && left?.mtimeNs === right?.mtimeNs && left?.size === right?.size &&
    left?.sha256 === right?.sha256;
}

function createMissingServerRecoveryAuthority({
  root,
  serverPath,
  candidatePath,
  rollbackPath,
  jobId,
  candidateFingerprint,
  rollbackFingerprint,
  evidencePaths
} = {}) {
  const canonicalRoot = assertScratchRoot(root);
  if (typeof jobId !== 'string' || !/^(?:job-[A-Za-z0-9_-]{1,123}|op2-[0-9a-f]{32})$/u.test(jobId) ||
      !samePath(serverPath, path.join(canonicalRoot, 'server')) ||
      typeof candidateFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(candidateFingerprint) ||
      typeof rollbackFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(rollbackFingerprint) ||
      !Array.isArray(evidencePaths) || evidencePaths.length < 6 || evidencePaths.length > 16 ||
      evidencePaths.some(value => typeof value !== 'string' || value.length === 0) ||
      new Set(evidencePaths.map(value => path.resolve(value).toLocaleLowerCase('en-US'))).size !== evidencePaths.length) {
    throw new TypeError('The missing-server recovery authority request is invalid');
  }
  const expectedPaths = createExistingSiblingPaths(serverPath, jobId);
  const expectedCandidate = expectedPaths.candidatePath;
  const expectedRollback = expectedPaths.rollbackPath;
  if (!samePath(candidatePath, expectedCandidate) || !samePath(rollbackPath, expectedRollback) || fs.existsSync(serverPath)) {
    throw new TypeError('The missing-server recovery authority topology is invalid');
  }
  const authority = Object.freeze({
    root: canonicalRoot,
    serverPath: path.resolve(serverPath),
    candidatePath: path.resolve(candidatePath),
    rollbackPath: path.resolve(rollbackPath),
    jobId,
    rootIdentity: localDirectoryIdentity(canonicalRoot),
    candidateIdentity: localDirectoryIdentity(candidatePath),
    rollbackIdentity: localDirectoryIdentity(rollbackPath),
    candidateFingerprint,
    rollbackFingerprint,
    mutableJournalRelativePath: `.minecraft-core-state/operations/${jobId}/journal.json`,
    evidence: Object.freeze(evidencePaths.map(filePath => recoveryEvidenceSnapshot(filePath, canonicalRoot)))
  });
  recoveryLaunchAuthorities.add(authority);
  return authority;
}

function assertMissingServerRecoveryAuthority(lifecycle, root, serverPath) {
  const authority = lifecycle?.recoveryLaunchAuthority;
  if (!authority || !recoveryLaunchAuthorities.has(authority) || !Object.isFrozen(authority) ||
      !samePath(authority.root, root) || !samePath(authority.serverPath, serverPath) ||
      fs.existsSync(serverPath) ||
      !sameLocalDirectoryIdentity(authority.rootIdentity, localDirectoryIdentity(root)) ||
      !sameLocalDirectoryIdentity(authority.candidateIdentity, localDirectoryIdentity(authority.candidatePath)) ||
      !sameLocalDirectoryIdentity(authority.rollbackIdentity, localDirectoryIdentity(authority.rollbackPath)) ||
      authority.evidence.some(snapshot => !sameRecoveryEvidence(
        snapshot,
        recoveryEvidenceSnapshot(snapshot.path, root)
      ))) {
    throw new TypeError('The isolated lifecycle missing-server recovery authority is invalid');
  }
}

async function assertRecoveryLaunchAuthorityDeep(lifecycle) {
  if (fs.existsSync(lifecycle.serverPath)) return;
  assertMissingServerRecoveryAuthority(lifecycle, lifecycle.root, lifecycle.serverPath);
  const authority = lifecycle.recoveryLaunchAuthority;
  const [candidate, rollback] = await Promise.all([
    inspectServerDirectoryTree(authority.candidatePath, {
      mutableRelativePaths: [authority.mutableJournalRelativePath]
    }),
    inspectServerDirectoryTree(authority.rollbackPath)
  ]);
  if (!sameLocalDirectoryIdentity(authority.candidateIdentity, localDirectoryIdentity(authority.candidatePath)) ||
      !sameLocalDirectoryIdentity(authority.rollbackIdentity, localDirectoryIdentity(authority.rollbackPath)) ||
      candidate.fingerprint !== authority.candidateFingerprint || rollback.fingerprint !== authority.rollbackFingerprint) {
    throw new TypeError('The isolated lifecycle recovery content changed before launch');
  }
  assertMissingServerRecoveryAuthority(lifecycle, lifecycle.root, lifecycle.serverPath);
}

function assertIsolatedLifecycle(lifecycle) {
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
    throw new TypeError('An isolated lifecycle is required');
  }
  const root = assertScratchRoot(lifecycle.root);
  const expected = {
    userDataPath: path.join(root, 'user-data'),
    serverPath: path.join(root, 'server'),
    clientPath: path.join(root, 'client'),
    evidencePath: path.join(root, 'evidence'),
    environmentPath: path.join(root, 'environment'),
    profilePath: path.join(root, 'environment', 'profile'),
    roamingAppDataPath: path.join(root, 'environment', 'profile', 'AppData', 'Roaming'),
    localAppDataPath: path.join(root, 'environment', 'profile', 'AppData', 'Local'),
    tempPath: path.join(root, 'environment', 'temp')
  };
  for (const [field, expectedPath] of Object.entries(expected)) {
    if (typeof lifecycle[field] !== 'string' || !samePath(lifecycle[field], expectedPath)) {
      throw new TypeError(`The isolated lifecycle ${field} is invalid`);
    }
    let info;
    try { info = fs.lstatSync(expectedPath); }
    catch (error) {
      if (field === 'serverPath' && error?.code === 'ENOENT') {
        assertMissingServerRecoveryAuthority(lifecycle, root, expectedPath);
        continue;
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(fs.realpathSync(expectedPath), expectedPath)) {
      throw new TypeError(`The isolated lifecycle ${field} is redirected`);
    }
  }
  const identityPath = path.join(root, 'real-lifecycle-identity.json');
  if (typeof lifecycle.identityPath !== 'string' || !samePath(lifecycle.identityPath, identityPath)) {
    throw new TypeError('The isolated lifecycle identity path is invalid');
  }
  let identityInfo;
  let identity;
  try {
    identityInfo = fs.lstatSync(identityPath);
    identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  } catch (error) {
    throw new TypeError('The isolated lifecycle identity marker is unavailable', { cause: error });
  }
  if (!identityInfo.isFile() || identityInfo.isSymbolicLink() || !samePath(fs.realpathSync(identityPath), identityPath) ||
      !identity || typeof identity !== 'object' || Array.isArray(identity) || Object.keys(identity).length < 1) {
    throw new TypeError('The isolated lifecycle identity marker is invalid');
  }
  return Object.freeze({ root, ...expected, identityPath });
}

function captureIsolatedLifecycleCleanupAuthority(lifecycle) {
  const isolated = assertIsolatedLifecycle(lifecycle);
  const authority = Object.freeze({
    root: isolated.root,
    rootIdentity: localDirectoryIdentity(isolated.root),
    identityMarker: recoveryEvidenceSnapshot(isolated.identityPath, isolated.root)
  });
  lifecycleCleanupAuthorities.add(authority);
  return authority;
}

function assertIsolatedLifecycleCleanupAuthority(lifecycle, authority) {
  if (!authority || !lifecycleCleanupAuthorities.has(authority) || !Object.isFrozen(authority)) {
    throw new TypeError('The isolated lifecycle cleanup authority is invalid');
  }
  const isolated = assertIsolatedLifecycle(lifecycle);
  if (!samePath(authority.root, isolated.root) ||
      !sameLocalDirectoryIdentity(authority.rootIdentity, localDirectoryIdentity(isolated.root))) {
    throw new TypeError('The isolated lifecycle root identity changed before cleanup');
  }
  const identityMarker = recoveryEvidenceSnapshot(isolated.identityPath, isolated.root);
  if (!sameRecoveryEvidence(authority.identityMarker, identityMarker)) {
    throw new TypeError('The isolated lifecycle identity marker changed before cleanup');
  }
  return isolated.root;
}

async function removeIsolatedLifecycleRoot(lifecycle, authority) {
  const deletionRoot = assertIsolatedLifecycleCleanupAuthority(lifecycle, authority);
  await scratchCleanup.assertNoNestedRedirects(deletionRoot);
  const revalidatedRoot = assertIsolatedLifecycleCleanupAuthority(lifecycle, authority);
  await fsp.rm(revalidatedRoot, { recursive: true, force: true, maxRetries: 3 });
}

async function createIsolatedRealLifecycle({
  scratchLabel = 'modrinth',
  scratchPrefix = null,
  identity = null
} = {}) {
  if (typeof scratchLabel !== 'string' || !/^[a-z0-9-]+$/u.test(scratchLabel)) {
    throw new TypeError('Real lifecycle scratch label is invalid');
  }
  scratchPrefix ??= `minecraft-core-real-${scratchLabel}-e2e-`;
  if (typeof scratchPrefix !== 'string' || !scratchPrefix.startsWith(REAL_SCRATCH_PREFIX) || !scratchPrefix.endsWith('-')) {
    throw new TypeError('Real lifecycle scratch prefix is invalid');
  }
  if (identity !== null && (!identity || typeof identity !== 'object' || Array.isArray(identity))) {
    throw new TypeError('Real lifecycle identity is invalid');
  }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), scratchPrefix));
  const [serverPort, managementPort] = await reserveDistinctLoopbackPorts(2);
  let cleanupAuthority = null;
  const lifecycle = {
    root,
    scratchLabel,
    userDataPath: path.join(root, 'user-data'),
    serverPath: path.join(root, 'server'),
    clientPath: path.join(root, 'client'),
    evidencePath: path.join(root, 'evidence'),
    environmentPath: path.join(root, 'environment'),
    profilePath: path.join(root, 'environment', 'profile'),
    roamingAppDataPath: path.join(root, 'environment', 'profile', 'AppData', 'Roaming'),
    localAppDataPath: path.join(root, 'environment', 'profile', 'AppData', 'Local'),
    tempPath: path.join(root, 'environment', 'temp'),
    identityPath: path.join(root, 'real-lifecycle-identity.json'),
    serverHost: '127.0.0.1',
    serverPort,
    managementPort,
    async dispose({ preserveRoot = true } = {}) {
      if (preserveRoot) {
        console.error(`[real-modpack-e2e] preserving scratch root: ${root}`);
        return;
      }
      await removeIsolatedLifecycleRoot(lifecycle, cleanupAuthority);
    }
  };
  await fsp.writeFile(lifecycle.identityPath, JSON.stringify(
    identity ?? { provider: scratchLabel, harness: 'real-modpack' }
  ), 'utf8');
  await Promise.all([
    fsp.mkdir(lifecycle.userDataPath),
    fsp.mkdir(lifecycle.serverPath),
    fsp.mkdir(lifecycle.clientPath),
    fsp.mkdir(lifecycle.evidencePath),
    fsp.mkdir(lifecycle.roamingAppDataPath, { recursive: true }),
    fsp.mkdir(lifecycle.localAppDataPath, { recursive: true }),
    fsp.mkdir(lifecycle.tempPath, { recursive: true })
  ]);
  cleanupAuthority = captureIsolatedLifecycleCleanupAuthority(lifecycle);
  return Object.freeze(lifecycle);
}

function createProductionEnvironment(lifecycle, inherited = process.env) {
  const isolated = assertIsolatedLifecycle(lifecycle);
  const environment = { ...inherited };
  for (const key of TEST_ONLY_ENVIRONMENT_KEYS) delete environment[key];
  environment.NODE_ENV = 'development';
  environment.MINECRAFT_CORE_USER_DATA_DIR = isolated.userDataPath;
  environment.MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS = '1';
  environment.USERPROFILE = isolated.profilePath;
  environment.HOME = isolated.profilePath;
  environment.APPDATA = isolated.roamingAppDataPath;
  environment.LOCALAPPDATA = isolated.localAppDataPath;
  environment.TEMP = isolated.tempPath;
  environment.TMP = isolated.tempPath;
  environment.TMPDIR = isolated.tempPath;
  environment.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  return environment;
}

function rendererInputMtimeNs(inputPath) {
  const input = fs.lstatSync(inputPath, { bigint: true });
  if (input.isSymbolicLink()) throw new Error('The renderer build input tree contains a symbolic link');
  if (input.isFile()) return input.mtimeNs;
  if (!input.isDirectory()) throw new Error('The renderer build input tree contains an unsupported entry');
  let newest = 0n;
  for (const name of fs.readdirSync(inputPath)) {
    const entryMtime = rendererInputMtimeNs(path.join(inputPath, name));
    if (entryMtime > newest) newest = entryMtime;
  }
  return newest;
}

function assertRendererBuildAvailable({ projectRoot = PROJECT_ROOT } = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    throw new TypeError('The renderer project root is invalid');
  }
  const root = path.resolve(projectRoot);
  const buildOutputs = [
    path.join(root, 'dist', 'index.html'),
    path.join(root, 'dist', '.vite', 'manifest.json')
  ];
  let oldestBuildOutput = null;
  for (const outputPath of buildOutputs) {
    let output;
    try {
      output = fs.lstatSync(outputPath, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error('The built renderer is required for the real lifecycle harness. Run npm run build first.');
      }
      throw error;
    }
    if (!output.isFile() || output.isSymbolicLink() || output.size < 1n) {
      throw new Error('The built renderer is invalid for the real lifecycle harness. Run npm run build first.');
    }
    oldestBuildOutput = oldestBuildOutput === null || output.mtimeNs < oldestBuildOutput
      ? output.mtimeNs
      : oldestBuildOutput;
  }

  const requiredInputs = [
    path.join(root, 'src'),
    path.join(root, 'index.html'),
    path.join(root, 'package.json'),
    path.join(root, 'vite.config.js')
  ];
  const optionalInputs = [
    path.join(root, 'public'),
    path.join(root, 'package-lock.json'),
    path.join(root, 'svelte.config.js')
  ].filter(inputPath => fs.existsSync(inputPath));
  let newestInput = 0n;
  for (const inputPath of [...requiredInputs, ...optionalInputs]) {
    const inputMtime = rendererInputMtimeNs(inputPath);
    if (inputMtime > newestInput) newestInput = inputMtime;
  }
  if (newestInput > oldestBuildOutput) {
    throw new Error('The built renderer is stale for the real lifecycle harness. Run npm run build first.');
  }
}

async function waitForProductionWindow(electronApp, { timeoutMs = 15 * 60_000, pollMs = 50 } = {}) {
  if (!electronApp || typeof electronApp.windows !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new TypeError('Production window wait dependencies are invalid');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of electronApp.windows()) {
      const ready = await page.evaluate(() => Boolean(
        window.electron && typeof window.electron.invoke === 'function'
      )).catch(() => false);
      if (ready) return page;
    }
    const child = typeof electronApp.process === 'function' ? electronApp.process() : null;
    if (child && childHasExited(child)) throw new Error('Production Electron exited before its main window became ready');
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  throw new Error('Production Electron main window did not become ready');
}

async function waitForProductionPreload(page, { timeoutMs = 60_000 } = {}) {
  await page.waitForFunction(() => Boolean(window.electron && typeof window.electron.invoke === 'function'), null, {
    timeout: timeoutMs
  });
}

function windowsProcesses() {
  if (process.platform !== 'win32') return [];
  const childProcess = require('node:child_process');
  const command = 'Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
  const result = childProcess.spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: false });
  if (result.error || result.signal || result.status !== 0 || String(result.stderr || '').trim() !== '') {
    throw new Error('Could not audit isolated lifecycle processes');
  }
  const output = String(result.stdout || '').trim();
  if (!output) return [];
  let parsed;
  try { parsed = JSON.parse(output); }
  catch (error) { throw new Error('Could not parse isolated lifecycle processes', { cause: error }); }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function currentProcessAncestors(inventory) {
  const parentByProcessId = new Map();
  for (const item of inventory) {
    const processId = Number(item?.ProcessId ?? item?.processId);
    const parentProcessId = Number(item?.ParentProcessId ?? item?.parentProcessId);
    if (Number.isSafeInteger(processId) && processId > 0 && Number.isSafeInteger(parentProcessId) && parentProcessId > 0) {
      parentByProcessId.set(processId, parentProcessId);
    }
  }
  const ancestors = new Set([process.pid]);
  let current = process.pid;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = parentByProcessId.get(current);
    if (!parent || ancestors.has(parent)) break;
    ancestors.add(parent);
    current = parent;
  }
  return ancestors;
}

function commandLineContainsRoot(commandLine, root) {
  const normalize = value => {
    const normalized = String(value || '').replaceAll('/', '\\');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  const command = normalize(commandLine);
  const needle = normalize(path.resolve(root));
  let offset = command.indexOf(needle);
  while (offset !== -1) {
    const next = command[offset + needle.length] || '';
    if (!next || /[\\\s"'=,;]/u.test(next)) return true;
    offset = command.indexOf(needle, offset + 1);
  }
  return false;
}

function assertNoProductionProcesses(lifecycle, { processes = null } = {}) {
  if (!lifecycle || typeof lifecycle.userDataPath !== 'string') {
    throw new TypeError('An isolated lifecycle is required');
  }
  const root = path.resolve(lifecycle.userDataPath, '..');
  if (typeof lifecycle.root === 'string' && path.resolve(lifecycle.root) !== root) {
    throw new TypeError('The isolated lifecycle root is inconsistent');
  }
  const inventory = processes ?? windowsProcesses();
  if (!Array.isArray(inventory)) throw new TypeError('Lifecycle process inventory is invalid');
  const ownAncestors = currentProcessAncestors(inventory);
  const matching = inventory.filter(value => commandLineContainsRoot(
    value?.CommandLine ?? value?.commandLine,
    root
  ) && !ownAncestors.has(Number(value?.ProcessId ?? value?.processId)));
  if (matching.length !== 0) throw new Error('The isolated lifecycle left a root-bound process');
  return Object.freeze([...inventory]);
}

// Same call shape as the renderer's startup banner: the channel takes no request.
function readStartupHealth(page) {
  return page.evaluate(async channel => window.electron.invoke(channel), 'startup:get-health');
}

// A degraded start still opens the main window with modpack services off.
// Only a start that reports every modpack service ready may drive a real run.
async function assertProductionStartupHealthy(page, {
  timeoutMs = STARTUP_HEALTH_TIMEOUT_MS,
  pollMs = STARTUP_HEALTH_POLL_MS
} = {}) {
  if (!page || typeof page.evaluate !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new TypeError('Production startup health check dependencies are invalid');
  }
  const deadline = Date.now() + timeoutMs;
  let health = await readStartupHealth(page);
  while (health?.status === 'starting' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    health = await readStartupHealth(page);
  }
  if (health?.status === 'ready' && health?.modpackServices === 'ready') return health;
  const failure = health?.failure && typeof health.failure === 'object'
    ? [health.failure.reason, health.failure.technical].filter(value => typeof value === 'string' && value)
    : [];
  const error = new Error(
    `Production Electron started with status ${health?.status ?? 'unavailable'} and modpack services ` +
    `${health?.modpackServices ?? 'unavailable'}${failure.length ? ` (${failure.join(': ')})` : ''}`
  );
  error.code = 'STARTUP_HEALTH_NOT_READY';
  throw error;
}

async function launchProductionElectronSafely(lifecycle, {
  inheritedEnvironment = process.env,
  assertBuildAvailable = assertRendererBuildAvailable,
  launchElectron = null,
  waitForWindow = waitForProductionWindow,
  waitForPreload = waitForProductionPreload,
  assertStartupHealth = assertProductionStartupHealthy,
  closeElectron = closeProductionElectron,
  assertNoOwnedProcesses = assertNoProductionProcesses
} = {}) {
  if (typeof assertBuildAvailable !== 'function' ||
      (launchElectron !== null && typeof launchElectron !== 'function') ||
      typeof waitForWindow !== 'function' || typeof waitForPreload !== 'function' ||
      typeof assertStartupHealth !== 'function' ||
      typeof closeElectron !== 'function' || typeof assertNoOwnedProcesses !== 'function') {
    throw new TypeError('Production Electron launch dependencies are invalid');
  }
  assertBuildAvailable();
  await assertNoOwnedProcesses(lifecycle);
  await assertRecoveryLaunchAuthorityDeep(lifecycle);
  const productionEnvironment = createProductionEnvironment(lifecycle, inheritedEnvironment);
  await assertNoOwnedProcesses(lifecycle);
  const launch = launchElectron ?? (options => require('playwright')._electron.launch(options));
  const electronApp = await launch({
    args: ['.', `--minecraft-core-real-e2e-root=${path.resolve(lifecycle.userDataPath, '..')}`],
    cwd: PROJECT_ROOT,
    env: productionEnvironment
  });
  try {
    const page = await waitForWindow(electronApp);
    await waitForPreload(page);
    await assertStartupHealth(page);
    return { electronApp, page };
  } catch (readinessError) {
    const cleanupErrors = [];
    try {
      await closeElectron(electronApp);
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    try {
      await assertNoOwnedProcesses(lifecycle);
    } catch (auditError) {
      cleanupErrors.push(auditError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [readinessError, ...cleanupErrors],
        'Production Electron launch failed and its owned processes could not be proven closed'
      );
    }
    throw readinessError;
  }
}

async function launchProductionElectron(lifecycle, options = {}) {
  return launchProductionElectronSafely(lifecycle, options);
}

async function invoke(page, channel, request = {}) {
  return page.evaluate(async ({ channel, request }) => window.electron.invoke(channel, request), { channel, request });
}

function teardownIpcTimeoutError(stage, timeoutMs) {
  const error = new Error(`E2E teardown ${stage} IPC exceeded its ${timeoutMs}ms deadline`);
  error.code = 'E2E_TEARDOWN_IPC_TIMEOUT';
  error.stage = stage;
  return error;
}

async function invokeBeforeTeardownDeadline(page, channel, request, deadline, stage) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw teardownIpcTimeoutError(stage, 0);

  const ipc = Promise.resolve().then(() => invoke(page, channel, request));
  // page.evaluate cannot be cancelled. Keep observing the losing branch so a
  // late IPC rejection cannot become an unhandled rejection after teardown.
  void ipc.catch(() => {});

  let timer;
  try {
    return await Promise.race([
      ipc,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(teardownIpcTimeoutError(stage, remainingMs)), remainingMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitBeforeTeardownDeadline(deadline, pollMs) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remainingMs)));
}

async function invokeModpack(page, channel, request = {}) {
  const result = await invoke(page, channel, request);
  if (!result || result.ok !== true) {
    const error = result?.error || {};
    let detail = '';
    if (error.details && typeof error.details === 'object') {
      try { detail = ` ${JSON.stringify(error.details)}`; } catch { /* retain the stable public error */ }
    }
    const failure = new Error(`${channel} failed: ${error.code || 'UNKNOWN'} ${error.message || ''}${detail}`.trim());
    if (typeof error.code === 'string' && error.code) failure.code = error.code;
    throw failure;
  }
  return result.value;
}

async function readServerContentRevision(page, instanceId) {
  if (typeof instanceId !== 'string' || !instanceId.trim()) {
    throw new TypeError('An isolated server instance ID is required');
  }
  const result = await invoke(page, 'get-settings', { instanceId: instanceId.trim() });
  if (!result?.success) {
    throw new Error(`Could not read isolated server settings: ${result?.error || 'unknown failure'}`);
  }
  const revision = result.settings?.contentRevision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('The isolated server content revision is invalid');
  }
  return revision;
}

async function registerIsolatedServer(page, lifecycle, { instanceId = 'real-e2e-server' } = {}) {
  const result = await invoke(page, 'save-instances', [{
    id: instanceId,
    name: 'Real lifecycle isolated server',
    type: 'server',
    path: lifecycle.serverPath,
    port: lifecycle.serverPort,
    managementPort: lifecycle.managementPort
  }]);
  if (!result?.success) throw new Error(`Could not register isolated server: ${result?.error || 'unknown failure'}`);
  return Object.freeze({ instanceId, serverPath: lifecycle.serverPath });
}

function isolatedServerDestinationPath(lifecycle) {
  const root = assertScratchRoot(lifecycle?.root);
  const targetPath = path.resolve(lifecycle?.serverPath || '');
  if (path.dirname(targetPath) !== root || path.basename(targetPath) !== 'server') {
    throw new TypeError('The isolated lifecycle server destination is invalid');
  }
  return targetPath;
}

function optionalRegularFileSnapshot(filePath) {
  let before;
  try {
    before = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      !samePath(fs.realpathSync.native(filePath), filePath)) {
    throw new TypeError('The isolated server properties file is redirected');
  }
  const bytes = fs.readFileSync(filePath);
  const after = fs.lstatSync(filePath, { bigint: true });
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n ||
      before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs ||
      before.mtimeNs !== after.mtimeNs || before.size !== after.size ||
      !samePath(fs.realpathSync.native(filePath), filePath)) {
    throw new TypeError('The isolated server properties file changed during validation');
  }
  return Object.freeze({
    dev: String(after.dev),
    ino: String(after.ino),
    birthtimeNs: String(after.birthtimeNs),
    mtimeNs: String(after.mtimeNs),
    size: String(after.size),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  });
}

function sameRegularFileSnapshot(left, right) {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs &&
    left.mtimeNs === right.mtimeNs && left.size === right.size && left.sha256 === right.sha256;
}

function hasOddTrailingBackslash(text) {
  let count = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === '\\'; index -= 1) count += 1;
  return count % 2 === 1;
}

function firstPhysicalPropertyCharacter(text) {
  let index = 0;
  while (index < text.length && /[ \t\f]/u.test(text[index])) index += 1;
  return text[index] || '';
}

function propertyRecords(source) {
  const parts = source.split(/(\r\n|\n|\r)/u);
  const records = [];
  let current = [];
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index] || '';
    const separator = parts[index + 1] || '';
    if (!text && !separator && index === parts.length - 1) break;
    const firstCharacter = current.length === 0 ? firstPhysicalPropertyCharacter(text) : '';
    current.push({ text, separator });
    const commentOrBlank = current.length === 1 && (!firstCharacter || firstCharacter === '#' || firstCharacter === '!');
    if (commentOrBlank || !hasOddTrailingBackslash(text)) {
      records.push(current);
      current = [];
    }
  }
  if (current.length) records.push(current);
  return records;
}

function logicalPropertyText(record) {
  let logical = '';
  for (let index = 0; index < record.length; index += 1) {
    let text = record[index].text;
    if (index > 0) text = text.replace(/^[ \t\f]+/u, '');
    if (hasOddTrailingBackslash(text)) text = text.slice(0, -1);
    logical += text;
  }
  return logical;
}

function decodeJavaPropertyKey(rawKey) {
  let decoded = '';
  for (let index = 0; index < rawKey.length; index += 1) {
    const character = rawKey[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= rawKey.length) throw new TypeError('The isolated server properties key has an incomplete escape');
    const escaped = rawKey[index];
    if (escaped === 'u') {
      const hex = rawKey.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/iu.test(hex)) {
        throw new TypeError('The isolated server properties key has an invalid Unicode escape');
      }
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    decoded += ({ t: '\t', r: '\r', n: '\n', f: '\f' })[escaped] ?? escaped;
  }
  return decoded;
}

function recordPropertyKey(record) {
  const logical = logicalPropertyText(record);
  let start = 0;
  while (start < logical.length && /[ \t\f]/u.test(logical[start])) start += 1;
  if (start >= logical.length || logical[start] === '#' || logical[start] === '!') return null;
  let escaped = false;
  let end = start;
  for (; end < logical.length; end += 1) {
    const character = logical[end];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '=' || character === ':' || /[ \t\f]/u.test(character)) break;
  }
  return decodeJavaPropertyKey(logical.slice(start, end));
}

function setTextProperty(source, key, value) {
  if (/[\r\n]/u.test(key) || /[\r\n]/u.test(value)) {
    throw new TypeError('The isolated server property contains a line break');
  }
  let output = '';
  let replaced = false;
  for (const record of propertyRecords(source)) {
    if (recordPropertyKey(record) === key) {
      if (!replaced) {
        output += `${key}=${value}${record.at(-1)?.separator || ''}`;
        replaced = true;
      }
    } else {
      output += record.map(({ text, separator }) => `${text}${separator}`).join('');
    }
  }
  if (replaced) return output;
  const separator = source.match(/\r\n|\n|\r/u)?.[0] || '\n';
  if (!source) return `${key}=${value}${separator}`;
  if (/(?:\r\n|\n|\r)$/u.test(source)) return `${source}${key}=${value}${separator}`;
  return `${source}${separator}${key}=${value}`;
}

async function configureLoopbackOnlyServerProperties(lifecycle) {
  const isolated = assertIsolatedLifecycle(lifecycle);
  const serverPath = isolatedServerDestinationPath(lifecycle);
  if (!samePath(serverPath, isolated.serverPath)) {
    throw new TypeError('The isolated lifecycle server destination is inconsistent');
  }
  const serverIdentity = localDirectoryIdentity(serverPath);
  const propertiesPath = path.join(serverPath, 'server.properties');
  const originalSnapshot = optionalRegularFileSnapshot(propertiesPath);
  const originalText = originalSnapshot === null ? '' : await fsp.readFile(propertiesPath, 'utf8');
  const nextText = setTextProperty(originalText, 'server-ip', '127.0.0.1');
  const temporaryPath = path.join(
    serverPath,
    `.server.properties.minecraft-core-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  try {
    await fsp.writeFile(temporaryPath, nextText, { encoding: 'utf8', flag: 'wx' });
    const beforeReplace = assertIsolatedLifecycle(lifecycle);
    if (!samePath(beforeReplace.serverPath, serverPath) ||
        !sameLocalDirectoryIdentity(serverIdentity, localDirectoryIdentity(serverPath)) ||
        !sameRegularFileSnapshot(originalSnapshot, optionalRegularFileSnapshot(propertiesPath)) ||
        optionalRegularFileSnapshot(temporaryPath) === null) {
      throw new TypeError('The isolated server changed before loopback binding');
    }
    await fsp.rename(temporaryPath, propertiesPath);
    const afterReplace = assertIsolatedLifecycle(lifecycle);
    const written = optionalRegularFileSnapshot(propertiesPath);
    if (!samePath(afterReplace.serverPath, serverPath) ||
        !sameLocalDirectoryIdentity(serverIdentity, localDirectoryIdentity(serverPath)) || written === null ||
        written.sha256 !== crypto.createHash('sha256').update(nextText, 'utf8').digest('hex')) {
      throw new TypeError('The isolated server loopback binding could not be verified');
    }
    return propertiesPath;
  } finally {
    if (sameLocalDirectoryIdentity(serverIdentity, localDirectoryIdentity(serverPath))) {
      await fsp.unlink(temporaryPath).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }
}

async function installIsolatedServerDestinationDialogOverride(electronApp, lifecycle) {
  if (!electronApp || typeof electronApp.evaluate !== 'function') {
    throw new TypeError('A production Electron application is required');
  }
  const overrideKey = '__minecraftCoreRealLifecycleOriginalOpenDialog';
  const targetPath = isolatedServerDestinationPath(lifecycle);
  await electronApp.evaluate(async ({ dialog }, request) => {
    await new Promise(resolve => setImmediate(resolve));
    const { targetPath: nextTargetPath, overrideKey: nextOverrideKey } = request;
    if (globalThis[nextOverrideKey]) throw new Error('Real lifecycle dialog override is already active');
    globalThis[nextOverrideKey] = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextTargetPath] });
  }, { targetPath, overrideKey });
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await electronApp.evaluate(async ({ dialog }, activeOverrideKey) => {
      await new Promise(resolve => setImmediate(resolve));
      if (globalThis[activeOverrideKey]) {
        dialog.showOpenDialog = globalThis[activeOverrideKey];
        delete globalThis[activeOverrideKey];
      }
    }, overrideKey).catch(() => {});
  };
}

function isolatedLocalArchiveInputPath(lifecycle, archivePathValue) {
  const isolated = assertIsolatedLifecycle(lifecycle);
  if (typeof archivePathValue !== 'string' || !path.isAbsolute(archivePathValue)) {
    throw new TypeError('The isolated local archive must be one direct scratch input');
  }
  const inputsPath = path.join(isolated.root, 'inputs');
  const archivePath = path.resolve(archivePathValue);
  if (!samePath(path.dirname(archivePath), inputsPath) ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}\.(?:mrpack|zip|rar)$/iu.test(path.basename(archivePath))) {
    throw new TypeError('The isolated local archive must be one direct scratch input');
  }
  let inputsInfo;
  let archiveInfo;
  try {
    inputsInfo = fs.lstatSync(inputsPath, { bigint: true });
    archiveInfo = fs.lstatSync(archivePath, { bigint: true });
  } catch (error) {
    throw new TypeError('The isolated local archive scratch input is unavailable', { cause: error });
  }
  if (!inputsInfo.isDirectory() || inputsInfo.isSymbolicLink() ||
      !samePath(fs.realpathSync.native(inputsPath), inputsPath) ||
      !archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.nlink !== 1n || archiveInfo.size < 1n ||
      !samePath(fs.realpathSync.native(archivePath), archivePath)) {
    throw new TypeError('The isolated local archive scratch input is redirected');
  }
  return archivePath;
}

async function installIsolatedLocalArchiveDialogOverride(electronApp, lifecycle, archivePathValue) {
  if (!electronApp || typeof electronApp.evaluate !== 'function') {
    throw new TypeError('A production Electron application is required');
  }
  const overrideKey = '__minecraftCoreRealLifecycleOriginalLocalArchiveOpenDialog';
  const archivePath = isolatedLocalArchiveInputPath(lifecycle, archivePathValue);
  await electronApp.evaluate(async ({ dialog }, request) => {
    await new Promise(resolve => setImmediate(resolve));
    const { archivePath: nextArchivePath, overrideKey: nextOverrideKey } = request;
    if (globalThis[nextOverrideKey]) throw new Error('Real lifecycle local archive dialog override is already active');
    globalThis[nextOverrideKey] = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextArchivePath] });
  }, { archivePath, overrideKey });
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await electronApp.evaluate(async ({ dialog }, activeOverrideKey) => {
      await new Promise(resolve => setImmediate(resolve));
      if (globalThis[activeOverrideKey]) {
        dialog.showOpenDialog = globalThis[activeOverrideKey];
        delete globalThis[activeOverrideKey];
      }
    }, overrideKey).catch(() => {});
  };
}

async function reserveIsolatedServerDestination(electronApp, page, lifecycle) {
  const restoreDialog = await installIsolatedServerDestinationDialogOverride(electronApp, lifecycle);
  try {
    const reservation = await invokeModpack(page, 'modpacks:reserve-server-destination', {});
    if (!reservation?.instanceId) throw new Error('Could not reserve the isolated server destination');
    return Object.freeze({ instanceId: reservation.instanceId, serverPath: lifecycle.serverPath, displayName: reservation.displayName });
  } finally {
    await restoreDialog();
  }
}

function defaultSelections({ acknowledgeDowngradeWorldRisk = false } = {}) {
  return {
    optionalFileIds: [],
    conflictChoices: { paths: {}, categories: {} },
    acknowledgeMissingProviderDigest: false,
    acknowledgeDowngradeWorldRisk
  };
}

function preferredConflictChoice(conflict) {
  if (!conflict || !Array.isArray(conflict.allowedChoices)) {
    throw new Error('Conflict review contains an unresolvable conflict');
  }
  const preservesUserState = ['world', 'secret', 'application'].includes(conflict.role);
  return (preservesUserState
    ? ['keep-mine']
    : ['use-pack', 'remove-addon', 'disable-addon', 'keep-mine', 'keep-both'])
    .find(candidate => conflict.allowedChoices.includes(candidate));
}

function approvePackConflictChoices(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length < 1) throw new Error('Conflict review did not include conflicts');
  const paths = {};
  for (const conflict of conflicts) {
    if (!conflict || typeof conflict.id !== 'string' || !Array.isArray(conflict.allowedChoices) ||
        conflict.allowedChoices.length < 1) throw new Error('Conflict review contains an unresolvable conflict');
    const choice = preferredConflictChoice(conflict);
    if (!choice) throw new Error(`Conflict ${conflict.id} has no supported approval choice`);
    if (choice === 'keep-both') {
      const alternateId = conflict.alternateOptions?.[0]?.id;
      if (typeof alternateId !== 'string') throw new Error(`Conflict ${conflict.id} has no approved alternate target`);
      paths[conflict.id] = { choice, alternateId };
    } else {
      paths[conflict.id] = { choice };
    }
  }
  return { paths, categories: {} };
}

async function reviewExactModrinthVersion(page, { instanceId, version, operationKind = version.operationKind, acknowledgeDowngradeWorldRisk = false } = {}) {
  const inspection = await invokeModpack(page, 'modpacks:inspect', {
    provider: 'modrinth',
    projectId: REAL_MODRINTH_LIFECYCLE.projectId,
    versionId: version.id
  });
  let plan = null;
  let conflicts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      conflicts = [];
      plan = await invokeModpack(page, 'modpacks:preflight', {
        inspectionId: inspection.inspectionId,
        instanceId,
        operationKind,
        selections: defaultSelections({ acknowledgeDowngradeWorldRisk })
      });
      if (plan.requiresConflictReview === true) {
        conflicts = plan.conflicts;
        plan = await invokeModpack(page, 'modpacks:preflight', {
          inspectionId: inspection.inspectionId,
          instanceId,
          operationKind,
          selections: {
            ...defaultSelections({ acknowledgeDowngradeWorldRisk }),
            conflictChoices: approvePackConflictChoices(conflicts)
          }
        });
      }
      break;
    } catch (error) {
      if (error?.code !== 'PLAN_STALE' || attempt === 1) throw error;
    }
  }
  if (plan.requiresConflictReview === true || !plan.planId || !plan.planFingerprint) {
    throw new Error('Exact conflict choices did not produce a reviewed lifecycle plan');
  }
  return Object.freeze({ inspection, plan, conflicts: Object.freeze([...conflicts]) });
}

async function waitForJob(page, jobId, {
  timeoutMs = 90 * 60_000,
  pollMs = 1_000,
  maxPollLatencyMs = null
} = {}) {
  if (maxPollLatencyMs !== null && (!Number.isSafeInteger(maxPollLatencyMs) || maxPollLatencyMs < 1)) {
    throw new TypeError('Lifecycle main-process heartbeat bound must be a positive integer');
  }
  const startedAt = Date.now();
  let lastJob = null;
  while (Date.now() - startedAt < timeoutMs) {
    const pollStartedAt = Date.now();
    lastJob = await invokeModpack(page, 'modpacks:get-job', { jobId });
    const pollLatencyMs = Date.now() - pollStartedAt;
    if (maxPollLatencyMs !== null && pollLatencyMs > maxPollLatencyMs) {
      throw new Error(
        `Lifecycle job ${jobId} main-process heartbeat exceeded ${maxPollLatencyMs}ms (observed ${pollLatencyMs}ms)`
      );
    }
    if (['completed', 'failed', 'cancelled', 'rolled-back', 'recovery-required'].includes(lastJob.phase)) {
      if (lastJob.phase !== 'completed') {
        const outcome = lastJob.outcome || {};
        const detail = [lastJob.errorCode || outcome.errorCode, lastJob.message || outcome.message]
          .filter(Boolean)
          .join(' ') || 'no detail';
        throw new Error(`Lifecycle job ${jobId} ended ${lastJob.phase}: ${detail}`);
      }
      return lastJob;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Lifecycle job ${jobId} did not finish within ${Math.round(timeoutMs / 60_000)} minutes; last phase: ${lastJob?.phase || 'unknown'}`);
}

async function executeReviewedPlan(page, reviewed, {
  acceptEula = true,
  startAfterInstall = false,
  restorePointId = null,
  timeoutMs = 90 * 60_000,
  pollMs = 1_000,
  maxPollLatencyMs = null
} = {}) {
  const job = await invokeModpack(page, 'modpacks:start-operation', {
    planId: reviewed.plan.planId,
    planFingerprint: reviewed.plan.planFingerprint,
    choices: { acceptEula, startAfterInstall, restorePointId }
  });
  return waitForJob(page, job.jobId, { timeoutMs, pollMs, maxPollLatencyMs });
}

async function startIsolatedServer(page, lifecycle, instanceId, {
  timeoutMs = DEFAULT_SERVER_HEALTH_TIMEOUT_MS,
  pollMs = 1_000,
  maxRam = 2
} = {}) {
  if (!Number.isSafeInteger(maxRam) || maxRam < 1 || maxRam > 64) {
    throw new TypeError('Isolated server maxRam must be an integer from 1 through 64');
  }
  const serverPath = isolatedServerDestinationPath(lifecycle);
  const latestLogPath = path.join(serverPath, 'logs', 'latest.log');
  const previousLatestLog = await fsp.readFile(latestLogPath, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  await configureLoopbackOnlyServerProperties(lifecycle);
  const result = await invoke(page, 'start-server', {
    instanceId,
    targetPath: serverPath,
    port: lifecycle.serverPort,
    maxRam
  });
  if (!result?.success) throw new Error(`Could not start isolated server: ${result?.code || ''} ${result?.error || ''}`.trim());
  const startedAt = Date.now();
  let status = null;
  let sawRunning = false;
  while (Date.now() - startedAt < timeoutMs) {
    status = await invoke(page, 'get-server-status', { instanceId, targetPath: lifecycle.serverPath });
    const isRunning = status?.status === 'running' || status?.isRunning === true;
    if (isRunning) sawRunning = true;
    if (['failed', 'crashed', 'error'].includes(status?.status) || (sawRunning && !isRunning)) {
      throw new Error(`Isolated server exited before readiness; last status: ${status?.status || 'not-running'}`);
    }
    const latestLog = await fsp.readFile(latestLogPath, 'utf8').catch(() => '');
    const freshLatestLog = previousLatestLog === null
      ? latestLog
      : latestLog.startsWith(previousLatestLog)
        ? latestLog.slice(previousLatestLog.length)
        : latestLog === previousLatestLog ? '' : latestLog;
    if (isRunning && /Done \([0-9.]+s\)!/u.test(freshLatestLog)) return status;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Isolated server did not reach Minecraft readiness; last status: ${status?.status || 'unknown'}`);
}

async function stopIsolatedServer(page, lifecycle, instanceId, { timeoutMs = 60_000, pollMs = 250 } = {}) {
  const selector = { instanceId, targetPath: lifecycle.serverPath };
  const deadline = Date.now() + timeoutMs;
  const result = await invokeBeforeTeardownDeadline(page, 'stop-server', selector, deadline, 'graceful stop');
  if (!result?.success) {
    const killed = await invokeBeforeTeardownDeadline(page, 'kill-server', selector, deadline, 'force kill');
    if (!killed?.success) throw new Error('Could not stop or force-kill isolated server');
  }
  let status = null;
  while (Date.now() < deadline) {
    status = await invokeBeforeTeardownDeadline(page, 'get-server-status', selector, deadline, 'status');
    if (status?.isRunning === false) return status;
    await waitBeforeTeardownDeadline(deadline, pollMs);
  }
  throw new Error(`Isolated server process did not exit; last status: ${status?.status || 'unknown'}`);
}

function evidenceReadError(error, fallbackCode) {
  return Object.freeze({
    code: typeof error?.code === 'string' && error.code ? error.code : fallbackCode,
    message: typeof error?.message === 'string' && error.message ? error.message : 'Evidence could not be read'
  });
}

function decodeBoundedUtf8(bytes, maximumBytes, fromTail) {
  const selected = bytes.length <= maximumBytes
    ? bytes
    : fromTail ? bytes.subarray(bytes.length - maximumBytes) : bytes.subarray(0, maximumBytes);
  let text = selected.toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    text = fromTail ? text.slice(1) : text.slice(0, -1);
  }
  return text;
}

async function readBoundedEvidenceText(filePath, maximumBytes, { fromTail = false } = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return { present: false, text: '', sizeBytes: 0, truncated: false, error: null };
    }
    const value = await fsp.readFile(filePath);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    return {
      present: true,
      text: decodeBoundedUtf8(bytes, maximumBytes, fromTail),
      sizeBytes: bytes.length,
      truncated: bytes.length > maximumBytes,
      error: null
    };
  } catch (error) {
    return {
      present: true,
      text: '',
      sizeBytes: null,
      truncated: false,
      error: evidenceReadError(error, 'EVIDENCE_READ_FAILED')
    };
  }
}

async function collectOperationRecord(operationRoot, fileName) {
  const loaded = await readBoundedEvidenceText(
    path.join(operationRoot, fileName),
    MAX_EVIDENCE_OPERATION_BYTES
  );
  if (loaded.error) {
    return { fileName, sizeBytes: loaded.sizeBytes, truncated: false, raw: null, parsed: null, error: loaded.error };
  }
  if (!loaded.present) {
    return {
      fileName,
      sizeBytes: null,
      truncated: false,
      raw: null,
      parsed: null,
      error: Object.freeze({ code: 'ENOENT', message: 'Operation evidence file was not found' })
    };
  }
  if (loaded.truncated) {
    return {
      fileName,
      sizeBytes: loaded.sizeBytes,
      truncated: true,
      raw: loaded.text,
      parsed: null,
      error: Object.freeze({ code: 'EVIDENCE_TRUNCATED', message: 'Operation evidence exceeded the capture limit' })
    };
  }
  try {
    return {
      fileName,
      sizeBytes: loaded.sizeBytes,
      truncated: false,
      raw: loaded.text,
      parsed: JSON.parse(loaded.text),
      error: null
    };
  } catch (error) {
    return {
      fileName,
      sizeBytes: loaded.sizeBytes,
      truncated: false,
      raw: loaded.text,
      parsed: null,
      error: evidenceReadError(error, 'INVALID_JSON')
    };
  }
}

async function collectServerEvidence(lifecycle) {
  const latestLogPath = path.join(lifecycle.serverPath, 'logs', 'latest.log');
  const statePath = path.join(lifecycle.serverPath, '.minecraft-core-state', 'modpack.json');
  const operationRoot = path.join(lifecycle.userDataPath, 'modpack-lifecycle', 'operations');
  const appMainLogPath = path.join(lifecycle.userDataPath, 'logs', 'main.log');
  const readIfPresent = async filePath => fs.existsSync(filePath) ? fsp.readFile(filePath, 'utf8') : '';
  let operationEntries = [];
  let operationEntryCount = 0;
  let operationEntriesError = null;
  try {
    operationEntries = fs.existsSync(operationRoot) ? await fsp.readdir(operationRoot) : [];
    operationEntryCount = operationEntries.length;
  } catch (error) {
    operationEntryCount = null;
    operationEntriesError = evidenceReadError(error, 'EVIDENCE_LIST_FAILED');
  }
  const operationEntriesTruncated = operationEntryCount !== null &&
    operationEntryCount > MAX_EVIDENCE_OPERATION_RECORDS;
  operationEntries = operationEntries.slice(0, MAX_EVIDENCE_OPERATION_RECORDS);
  const operationRecords = await Promise.all(operationEntries.map(fileName =>
    collectOperationRecord(operationRoot, fileName)
  ));
  const appMainLog = await readBoundedEvidenceText(appMainLogPath, MAX_EVIDENCE_APP_LOG_BYTES, { fromTail: true });
  const evidence = {
    scratchRoot: lifecycle.root,
    serverPath: lifecycle.serverPath,
    clientPath: lifecycle.clientPath,
    userDataPath: lifecycle.userDataPath,
    serverPort: lifecycle.serverPort,
    managementPort: lifecycle.managementPort,
    latestLogPath,
    latestLog: await readIfPresent(latestLogPath),
    managedStatePath: statePath,
    managedState: await readIfPresent(statePath),
    operationEntryCount,
    operationEntriesTruncated,
    operationEntries,
    operationEntriesError,
    operationRecords,
    appMainLogPath,
    appMainLog: appMainLog.text,
    appMainLogSizeBytes: appMainLog.sizeBytes,
    appMainLogTruncated: appMainLog.truncated,
    appMainLogError: appMainLog.error
  };
  await fsp.writeFile(path.join(lifecycle.evidencePath, 'server-evidence.json'), JSON.stringify(evidence, null, 2));
  return evidence;
}

function childHasExited(child) {
  return (child?.exitCode !== null && child?.exitCode !== undefined) ||
    (child?.signalCode !== null && child?.signalCode !== undefined);
}

function waitForChildExit(child, timeoutMs) {
  if (!child || childHasExited(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Production Electron process did not exit'));
    }, timeoutMs);
    child.once('exit', onExit);
    if (childHasExited(child)) onExit();
  });
}

function productionElectronChildProcess(electronApp) {
  if (!electronApp) return null;
  if (typeof electronApp.process !== 'function') {
    throw new TypeError('Production Electron process accessor is unavailable');
  }
  try {
    return electronApp.process() || null;
  } catch {
    // Playwright can discard the connection before a startup failure reaches
    // this harness. The independent root-bound OS process audit remains the
    // authority for whether cleanup is actually complete.
    return null;
  }
}

async function closeProductionElectron(electronApp, { timeoutMs = 15_000 } = {}) {
  if (!electronApp) return;
  const child = productionElectronChildProcess(electronApp);
  if (!child) return;
  if (childHasExited(child)) return;

  try {
    const requestedExit = electronApp.evaluate(async ({ app, BrowserWindow }) => {
      await new Promise(resolve => setImmediate(resolve));
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      app.quit();
    });
    void Promise.resolve(requestedExit).catch(() => {});
  } catch {
    if (typeof child.kill === 'function') child.kill();
  }

  try {
    await waitForChildExit(child, timeoutMs);
  } catch (error) {
    if (!childHasExited(child) && typeof child.kill === 'function') child.kill();
    await waitForChildExit(child, Math.min(timeoutMs, 5_000)).catch(() => {
      throw error;
    });
  }
}

async function closeProductionElectronAndAudit(electronApp, lifecycle, {
  closeElectron = closeProductionElectron,
  processes = null
} = {}) {
  if (typeof closeElectron !== 'function') throw new TypeError('Production Electron close dependency is invalid');
  await closeElectron(electronApp);
  return assertNoProductionProcesses(lifecycle, { processes });
}

async function finalizeIsolatedRealLifecycle({
  completed,
  electronApp,
  lifecycle,
  closeAndAudit = closeProductionElectronAndAudit,
  collectEvidence,
  attachEvidence,
  dispose,
  environment = process.env
} = {}) {
  if (typeof completed !== 'boolean' || typeof closeAndAudit !== 'function' ||
      typeof collectEvidence !== 'function' || typeof attachEvidence !== 'function' ||
      typeof dispose !== 'function') {
    throw new TypeError('Isolated lifecycle finalization dependencies are invalid');
  }

  let closeError = null;
  try {
    await closeAndAudit(electronApp, lifecycle);
  } catch (error) {
    closeError = error;
  }
  const failed = !completed;
  let preserveRoot = closeError !== null || (failed && shouldPreserveFailedRealE2E(environment));
  let followupError = null;
  if (failed || closeError !== null) {
    try {
      const evidence = await collectEvidence();
      await attachEvidence(evidence);
    } catch (error) {
      preserveRoot = true;
      followupError = error;
    }
  }
  try {
    await dispose({ preserveRoot });
  } catch (error) {
    followupError ||= error;
  }
  if (closeError) throw closeError;
  if (followupError) throw followupError;
}

function createSelfContainedEvidenceAttachment(evidence) {
  const serialized = JSON.stringify(evidence, null, 2);
  if (serialized === undefined) throw new TypeError('Failed-run evidence is not serializable');
  return Object.freeze({
    body: Buffer.from(`${serialized}\n`, 'utf8'),
    contentType: 'application/json'
  });
}

module.exports = {
  REAL_MODRINTH_LIFECYCLE,
  REAL_LIFECYCLE_ENV,
  REAL_REVERSE_ENV,
  PRESERVE_FAILED_REAL_E2E_ENV,
  createIsolatedRealLifecycle,
  captureIsolatedLifecycleCleanupAuthority,
  removeIsolatedLifecycleRoot,
  createMissingServerRecoveryAuthority,
  createProductionEnvironment,
  assertRendererBuildAvailable,
  isRealLifecycleEnabled,
  isReverseLifecycleEnabled,
  launchProductionElectron,
  launchProductionElectronSafely,
  assertProductionStartupHealthy,
  waitForProductionWindow,
  invoke,
  invokeModpack,
  readServerContentRevision,
  registerIsolatedServer,
  installIsolatedServerDestinationDialogOverride,
  installIsolatedLocalArchiveDialogOverride,
  reserveIsolatedServerDestination,
  configureLoopbackOnlyServerProperties,
  approvePackConflictChoices,
  preferredConflictChoice,
  reviewExactModrinthVersion,
  executeReviewedPlan,
  waitForJob,
  startIsolatedServer,
  invokeBeforeTeardownDeadline,
  stopIsolatedServer,
  collectServerEvidence,
  closeProductionElectron,
  closeProductionElectronAndAudit,
  createSelfContainedEvidenceAttachment,
  finalizeIsolatedRealLifecycle,
  shouldPreserveFailedRealE2E,
  assertNoProductionProcesses
};
