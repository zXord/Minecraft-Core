const fs = require('fs');
const path = require('path');
const { resolveServerLoader, normalizeLoaderName } = require('../utils/server-loader.cjs');
const { FABRIC_LAUNCH_JAR, getFabricRuntimeStatus } = require('../utils/fabric-runtime.cjs');
const { hasPreparedRuntimeMetadata, validatePreparedRuntime } = require('./loader-install-service.cjs');
const { normalizeRuntimeTuple } = require('./modpacks/contracts.cjs');
const { ModpackError } = require('./modpacks/errors.cjs');
const { markCurrentServerMutationDirty } = require('./server-mutation-context.cjs');
const {
  overlayServerProperties,
  serverNetworkProperties
} = require('../utils/server-network-properties.cjs');

const SUPPORTED_LOADERS = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);
const USER_JVM_ARGS_FILE = 'user_jvm_args.txt';
const WINDOWS_RESPONSE_FILE_PATH_LIMIT = 260;
const READY_MARKERS = Object.freeze([
  'Done (',
  'For help, type "help"'
]);
const FATAL_MARKERS = Object.freeze([
  'UnsupportedClassVersionError',
  'Could not reserve enough space for object heap',
  'Could not find or load main class',
  'Failed to start the minecraft server',
  'Exception in thread "main"'
]);

function codedLaunchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertWindowsResponseFilePath(argsFilePath) {
  if (process.platform !== 'win32' || path.resolve(argsFilePath).length < WINDOWS_RESPONSE_FILE_PATH_LIMIT) {
    return;
  }

  throw new ModpackError(
    'SERVER_PATH_TOO_LONG',
    'This server location is too deeply nested for the selected loader on Windows. Choose a shorter folder.',
    {
      details: { field: 'serverPath' },
      retryable: true
    }
  );
}

function commonPlan({ type, loader, jar, args, cwd, runtime, assets }) {
  const plan = {
    type,
    loader,
    jar,
    args,
    cwd,
    readyMarkers: [...READY_MARKERS],
    fatalMarkers: [...FATAL_MARKERS],
    runtime: runtime || null
  };
  if (assets !== undefined) plan.assets = assets;
  return plan;
}

function readServerProperties(serverPath) {
  const filePath = path.join(serverPath, 'server.properties');
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      lines: [],
      map: {}
    };
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const map = {};

  lines.forEach((line) => {
    if (!line || line.startsWith('#') || !line.includes('=')) {
      return;
    }
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    map[key] = value;
  });

  return {
    filePath,
    lines,
    map
  };
}

function writeServerProperties(serverPath, properties) {
  const filePath = path.join(serverPath, 'server.properties');
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const next = overlayServerProperties(current, properties);
  // An unchanged file is not a content mutation, so a routine start leaves the lease and revision alone.
  if (current && current.equals(next)) return false;
  markCurrentServerMutationDirty(serverPath);
  fs.writeFileSync(filePath, next);
  return true;
}

function syncServerPort(serverPath, port, networkAccess = 'pack-default') {
  if (!serverPath || !port) {
    return;
  }

  writeServerProperties(serverPath, serverNetworkProperties({ port, networkAccess }));
}

function findFirstJar(serverPath, predicate) {
  const files = fs.readdirSync(serverPath);
  return files.find((file) => file.endsWith('.jar') && predicate(file)) || null;
}

function getVanillaLaunchJar(serverPath) {
  const directJar = path.join(serverPath, 'server.jar');
  if (fs.existsSync(directJar)) {
    return directJar;
  }

  const fallbackName = findFirstJar(serverPath, (file) => {
    const lower = file.toLowerCase();
    return lower.includes('server')
      && !lower.includes('installer')
      && !lower.includes('fabric')
      && !lower.includes('forge')
      && !lower.includes('quilt');
  });

  return fallbackName ? path.join(serverPath, fallbackName) : null;
}

function walkFiles(rootDir, maxDepth = 6, depth = 0, results = []) {
  if (depth > maxDepth || !fs.existsSync(rootDir)) {
    return results;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    results.push(fullPath);

    if (entry.isDirectory()) {
      walkFiles(fullPath, maxDepth, depth + 1, results);
    }
  }

  return results;
}

function buildForgeVersionMarkers(minecraftVersion, loaderVersion) {
  const normalizedMc = String(minecraftVersion || '').trim();
  const normalizedLoader = String(loaderVersion || '').trim();
  if (!normalizedMc && !normalizedLoader) {
    return [];
  }

  const markers = [];
  if (normalizedMc && normalizedLoader) {
    markers.push(`${normalizedMc}-${normalizedLoader}`.toLowerCase());
    markers.push(`forge-${normalizedMc}-${normalizedLoader}`.toLowerCase());
  }
  if (normalizedMc) {
    markers.push(normalizedMc.toLowerCase());
  }
  if (normalizedLoader) {
    markers.push(normalizedLoader.toLowerCase());
  }

  return [...new Set(markers)];
}

function scoreForgeAssetCandidate(filePath, expected = {}, preferredBaseDir = null) {
  const normalizedPath = String(filePath || '').toLowerCase();
  const markers = buildForgeVersionMarkers(expected.minecraftVersion, expected.loaderVersion);
  let score = 0;

  if (preferredBaseDir) {
    const normalizedBaseDir = String(preferredBaseDir).toLowerCase();
    if (normalizedPath.startsWith(normalizedBaseDir)) {
      score += 500;
    }
  }

  markers.forEach((marker) => {
    if (marker && normalizedPath.includes(marker)) {
      score += marker.includes('-') ? 200 : 50;
    }
  });

  const relativeDepth = String(path.relative(expected.serverPath || '', filePath) || '')
    .split(path.sep)
    .filter(Boolean)
    .length;

  score -= relativeDepth;
  return score;
}

function pickBestForgeAsset(candidates, expected = {}, preferredBaseDir = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  return [...candidates]
    .sort((left, right) => {
      const scoreDelta =
        scoreForgeAssetCandidate(right, expected, preferredBaseDir)
        - scoreForgeAssetCandidate(left, expected, preferredBaseDir);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.localeCompare(right);
    })[0];
}

function findForgeLaunchAssets(serverPath, expected = {}) {
  const files = walkFiles(serverPath, 8);
  const rootUserJvmArgs = path.join(serverPath, 'user_jvm_args.txt');
  const userJvmArgs = fs.existsSync(rootUserJvmArgs)
    ? rootUserJvmArgs
    : files.find((file) => path.basename(file).toLowerCase() === 'user_jvm_args.txt') || null;
  const preferredArgs = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const forgeArgCandidates = [
    ...files.filter((file) => path.basename(file).toLowerCase() === preferredArgs),
    ...files.filter((file) => path.basename(file).toLowerCase() === 'win_args.txt'),
    ...files.filter((file) => path.basename(file).toLowerCase() === 'unix_args.txt')
  ];
  const preferredForgeArgCandidates = forgeArgCandidates.filter(
    (file) => path.basename(file).toLowerCase() === preferredArgs
  );
  const resolvedForgeArgs = pickBestForgeAsset(
    preferredForgeArgCandidates.length > 0 ? preferredForgeArgCandidates : forgeArgCandidates,
    {
      ...expected,
      serverPath
    }
  );

  const runScriptCandidates = files.filter((file) => /^run\.(bat|cmd|sh)$/i.test(path.basename(file)));
  const runScript = pickBestForgeAsset(runScriptCandidates, {
    ...expected,
    serverPath
  }, resolvedForgeArgs ? path.dirname(resolvedForgeArgs) : null);

  return {
    userJvmArgs,
    forgeArgs: resolvedForgeArgs,
    runScript
  };
}

function findForgeShimName(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-jar' && args[index + 1]) {
      return path.basename(args[index + 1]);
    }
  }

  return null;
}

function ensureForgeRootShim(serverPath, argsFilePath) {
  if (!serverPath || !argsFilePath || !fs.existsSync(argsFilePath)) {
    return null;
  }

  const forgeArgs = readArgumentFileEntries(argsFilePath);
  const shimName = findForgeShimName(forgeArgs);
  if (!shimName) {
    return null;
  }

  const sourceShimPath = path.join(path.dirname(argsFilePath), shimName);
  if (!fs.existsSync(sourceShimPath)) {
    return null;
  }

  const rootShimPath = path.join(serverPath, shimName);
  const shouldCopy = !fs.existsSync(rootShimPath)
    || fs.statSync(rootShimPath).size !== fs.statSync(sourceShimPath).size;

  if (shouldCopy) {
    markCurrentServerMutationDirty(serverPath);
    fs.copyFileSync(sourceShimPath, rootShimPath);
  }

  return rootShimPath;
}

function tokenizeArgumentString(value) {
  const matches = String(value || '').match(/"([^"\\]*(?:\\.[^"\\]*)*)"|[^\s]+/g) || [];
  return matches
    .map((token) => token.replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function readArgumentFileEntries(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  return tokenizeArgumentString(meaningfulLines.join(' '));
}

function resolveForgeLaunchPlan(serverPath, maxRam, expected = {}, runtime = null) {
  const assets = findForgeLaunchAssets(serverPath, expected);
  if (!assets.forgeArgs) {
    const error = new Error('Forge launch assets are missing. Repair the server before starting it.');
    error.code = 'FORGE_LAUNCH_ASSETS_MISSING';
    throw error;
  }

  if (assets.userJvmArgs) assertWindowsResponseFilePath(assets.userJvmArgs);
  assertWindowsResponseFilePath(assets.forgeArgs);
  ensureForgeRootShim(serverPath, assets.forgeArgs);
  const userJvmArgFile = assets.userJvmArgs
    ? `@${path.relative(serverPath, assets.userJvmArgs) || path.basename(assets.userJvmArgs)}`
    : null;
  const forgeArgFile = `@${path.relative(serverPath, assets.forgeArgs)}`;

  const args = [];
  if (userJvmArgFile) {
    args.push(userJvmArgFile);
  }
  args.push(`-Xmx${maxRam}G`, '-Xms1G', forgeArgFile, 'nogui');

  return commonPlan({
    type: 'forge',
    loader: 'forge',
    jar: null,
    args,
    cwd: serverPath,
    runtime,
    assets
  });
}

// user_jvm_args.txt is the server owner's file (RAM and other JVM flags) and its bytes are never
// validated. A runtime-backed Forge or NeoForge launch passes it whenever it is present, as the
// official run scripts do, whether or not the runtime record lists it.
function resolveUserJvmArgsFile(serverPath) {
  const filePath = path.join(serverPath, USER_JVM_ARGS_FILE);
  let stat;
  try {
    stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  } catch {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The server user_jvm_args.txt could not be read.');
  }
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The server user_jvm_args.txt is not a regular file.');
  }
  assertWindowsResponseFilePath(filePath);
  return filePath;
}

function responseFileLaunchArgs(serverPath, maxRam, argsFile, userJvmArgs) {
  const args = userJvmArgs ? [`@${path.relative(serverPath, userJvmArgs)}`] : [];
  args.push(`-Xmx${maxRam}G`, '-Xms1G', `@${path.relative(serverPath, argsFile)}`, 'nogui');
  return args;
}

function resolveRecordedForgeLaunchPlan(serverPath, maxRam, validation) {
  const loader = validation?.loader;
  if (loader && typeof loader.argsFile === 'string') {
    const forgeArgs = path.join(serverPath, ...loader.argsFile.split('/'));
    assertWindowsResponseFilePath(forgeArgs);
    const userJvmArgs = resolveUserJvmArgsFile(serverPath);
    return commonPlan({
      type: 'forge',
      loader: 'forge',
      jar: null,
      args: responseFileLaunchArgs(serverPath, maxRam, forgeArgs, userJvmArgs),
      cwd: serverPath,
      runtime: validation.runtime,
      assets: { userJvmArgs, forgeArgs, runScript: null }
    });
  }
  if (loader && typeof loader.launchJar === 'string') {
    const launchJar = path.join(serverPath, ...loader.launchJar.split('/'));
    return commonPlan({
      type: 'jar',
      loader: 'forge',
      jar: launchJar,
      args: [`-Xmx${maxRam}G`, '-Xms1G', '-jar', launchJar, 'nogui'],
      cwd: serverPath,
      runtime: validation.runtime
    });
  }
  throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared Forge runtime is incomplete.');
}

function sameRuntime(left, right) {
  return ['minecraftVersion', 'loaderFamily', 'loaderVersion', 'javaMajor', 'os', 'architecture']
    .every(key => left?.[key] === right?.[key]);
}

function canonicalLaunchIdentity(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolvePrevalidatedFile(serverPath, relativePath, recordedPaths) {
  if (typeof relativePath !== 'string' || !recordedPaths.has(relativePath) || relativePath.includes('\\') ||
      relativePath.includes(':') || relativePath.startsWith('/') ||
      relativePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared runtime launch evidence is invalid.');
  }
  const filePath = path.resolve(serverPath, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(serverPath), filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared runtime launch evidence is invalid.');
  }
  let stat;
  let rootRealPath;
  let fileRealPath;
  try {
    const rootStat = fs.lstatSync(serverPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid root');
    rootRealPath = fs.realpathSync.native(serverPath);
    fileRealPath = fs.realpathSync.native(filePath);
    stat = fs.lstatSync(filePath);
  } catch {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared runtime launch file is missing.');
  }
  const realRelative = path.relative(rootRealPath, fileRealPath);
  if (canonicalLaunchIdentity(rootRealPath) !== canonicalLaunchIdentity(serverPath) ||
      !realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative) ||
      !stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.nlink) || stat.nlink !== 1) {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared runtime launch file is invalid.');
  }
  return filePath;
}

function resolvePrevalidatedLaunchPlan(serverPath, options = {}, validation) {
  let runtime;
  try {
    if (!validation || typeof validation !== 'object' || Array.isArray(validation) || validation.valid !== true ||
        !validation.loader || typeof validation.loader !== 'object' || Array.isArray(validation.loader) ||
        !Array.isArray(validation.artifacts) || validation.artifacts.length < 1) throw new Error('invalid validation');
    runtime = normalizeRuntimeTuple(validation.runtime);
  } catch {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared runtime launch evidence is invalid.');
  }
  const expectedRuntime = {
    minecraftVersion: options.minecraftVersion,
    loaderFamily: normalizeLoaderName(options.loader),
    loaderVersion: options.loaderVersion,
    javaMajor: options.javaMajor,
    os: runtime.os,
    architecture: runtime.architecture
  };
  if (!sameRuntime(runtime, expectedRuntime) || validation.loader.family !== runtime.loaderFamily ||
      !SUPPORTED_LOADERS.has(runtime.loaderFamily)) {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared runtime does not match the launch request.');
  }
  const recordedPaths = new Set();
  for (const artifact of validation.artifacts) {
    if (!artifact || typeof artifact !== 'object' || typeof artifact.relativePath !== 'string' ||
        recordedPaths.has(artifact.relativePath)) {
      throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared runtime launch evidence is invalid.');
    }
    recordedPaths.add(artifact.relativePath);
  }
  const maxRam = Number.isFinite(Number(options.maxRam)) ? Number(options.maxRam) : 4;
  const loader = validation.loader;

  if (runtime.loaderFamily === 'vanilla') {
    const serverJar = resolvePrevalidatedFile(serverPath, loader.serverJar, recordedPaths);
    return commonPlan({
      type: 'jar',
      loader: 'vanilla',
      jar: serverJar,
      args: [`-Xmx${maxRam}G`, '-Xms1G', '-jar', serverJar, 'nogui'],
      cwd: serverPath,
      runtime
    });
  }
  if (runtime.loaderFamily === 'fabric') {
    const launcherJar = resolvePrevalidatedFile(serverPath, loader.launcherJar, recordedPaths);
    return commonPlan({
      type: 'jar',
      loader: 'fabric',
      jar: launcherJar,
      args: [`-Xmx${maxRam}G`, '-Xms1G', '-jar', launcherJar, 'nogui'],
      cwd: serverPath,
      runtime
    });
  }
  if (runtime.loaderFamily === 'forge') {
    const launchPath = typeof loader.argsFile === 'string' ? loader.argsFile : loader.launchJar;
    resolvePrevalidatedFile(serverPath, launchPath, recordedPaths);
    return resolveRecordedForgeLaunchPlan(serverPath, maxRam, { ...validation, runtime });
  }
  if (runtime.loaderFamily === 'neoforge') {
    const argsFile = resolvePrevalidatedFile(serverPath, loader.argsFile, recordedPaths);
    assertWindowsResponseFilePath(argsFile);
    return commonPlan({
      type: 'neoforge',
      loader: 'neoforge',
      jar: null,
      args: responseFileLaunchArgs(serverPath, maxRam, argsFile, resolveUserJvmArgsFile(serverPath)),
      cwd: serverPath,
      runtime
    });
  }
  if (runtime.loaderFamily === 'quilt') {
    const launcherJar = resolvePrevalidatedFile(serverPath, loader.launcherJar, recordedPaths);
    return commonPlan({
      type: 'jar',
      loader: 'quilt',
      jar: launcherJar,
      args: [`-Xmx${maxRam}G`, '-Xms1G', '-jar', launcherJar, 'nogui'],
      cwd: serverPath,
      runtime
    });
  }
  throw codedLaunchError('UNSUPPORTED_LOADER', `Unsupported loader: ${runtime.loaderFamily}`);
}

function resolveLaunchPlan(serverPath, options = {}, { runtimeTuple = null } = {}) {
  const resolvedLoaderInfo = resolveServerLoader(serverPath);
  const explicitLoader = options.loader === undefined || options.loader === null
    ? null
    : normalizeLoaderName(options.loader);
  const resolvedLoader = explicitLoader || normalizeLoaderName(resolvedLoaderInfo.loader) || 'vanilla';
  if (!SUPPORTED_LOADERS.has(resolvedLoader)) {
    throw codedLaunchError('UNSUPPORTED_LOADER', `Unsupported loader: ${resolvedLoader || 'unknown'}`);
  }
  if (runtimeTuple && runtimeTuple.loaderFamily !== resolvedLoader) {
    throw codedLaunchError('RUNTIME_INCOMPLETE', 'The prepared runtime does not match the requested loader.');
  }
  const maxRam = Number.isFinite(Number(options.maxRam)) ? Number(options.maxRam) : 4;
  const minecraftVersion = options.minecraftVersion || null;
  const loaderVersion = options.loaderVersion || resolvedLoaderInfo.loaderVersion || null;

  if (resolvedLoader === 'fabric') {
    const launchJar = path.join(serverPath, FABRIC_LAUNCH_JAR);
    if (!fs.existsSync(launchJar)) {
      const error = new Error('Fabric server launcher is missing. Repair Fabric before starting the server.');
      error.code = 'FABRIC_LAUNCH_JAR_MISSING';
      throw error;
    }

    const fabricStatus = getFabricRuntimeStatus(serverPath);
    if (fabricStatus.hasBlockingIssues) {
      const error = new Error(fabricStatus.blockingIssues[0]?.message || 'Fabric runtime is incomplete.');
      error.code = 'FABRIC_BROKEN';
      error.details = fabricStatus.blockingIssues;
      throw error;
    }

    return commonPlan({
      type: 'jar',
      loader: 'fabric',
      jar: launchJar,
      args: [`-Xmx${maxRam}G`, '-Xms1G', '-jar', launchJar, 'nogui'],
      cwd: serverPath,
      runtime: runtimeTuple
    });
  }

  if (resolvedLoader === 'forge') {
    // Only a server with app-recorded runtime metadata uses the recorded plan; Forge servers installed
    // without it (every v26.6.1 server) keep the v26.6.1 args-file discovery. Present but corrupt,
    // directory-shaped or mismatched metadata still fails closed in validatePreparedRuntime.
    if (runtimeTuple && hasPreparedRuntimeMetadata(serverPath)) {
      return resolveRecordedForgeLaunchPlan(
        serverPath,
        maxRam,
        validatePreparedRuntime(serverPath, runtimeTuple)
      );
    }
    return resolveForgeLaunchPlan(serverPath, maxRam, {
      minecraftVersion,
      loaderVersion
    }, runtimeTuple);
  }

  if (resolvedLoader === 'neoforge') {
    if (!runtimeTuple) throw codedLaunchError('RUNTIME_INCOMPLETE', 'NeoForge runtime identity is missing.');
    const validation = validatePreparedRuntime(serverPath, runtimeTuple);
    const argsFile = path.join(serverPath, ...validation.loader.argsFile.split('/'));
    assertWindowsResponseFilePath(argsFile);
    return commonPlan({
      type: 'neoforge',
      loader: 'neoforge',
      jar: null,
      args: responseFileLaunchArgs(serverPath, maxRam, argsFile, resolveUserJvmArgsFile(serverPath)),
      cwd: serverPath,
      runtime: validation.runtime
    });
  }

  if (resolvedLoader === 'quilt') {
    if (!runtimeTuple) throw codedLaunchError('RUNTIME_INCOMPLETE', 'Quilt runtime identity is missing.');
    const validation = validatePreparedRuntime(serverPath, runtimeTuple);
    const launchJar = path.join(serverPath, ...validation.loader.launcherJar.split('/'));
    return commonPlan({
      type: 'jar',
      loader: 'quilt',
      jar: launchJar,
      args: [`-Xmx${maxRam}G`, '-Xms1G', '-jar', launchJar, 'nogui'],
      cwd: serverPath,
      runtime: validation.runtime
    });
  }

  const launchJar = getVanillaLaunchJar(serverPath);
  if (!launchJar) {
    const error = new Error('No valid server jar was found in the selected server folder.');
    error.code = 'SERVER_JAR_MISSING';
    throw error;
  }

  return commonPlan({
    type: 'jar',
    loader: 'vanilla',
    jar: launchJar,
    args: [`-Xmx${maxRam}G`, '-Xms1G', '-jar', launchJar, 'nogui'],
    cwd: serverPath,
    runtime: runtimeTuple
  });
}

module.exports = {
  readServerProperties,
  writeServerProperties,
  syncServerPort,
  findForgeLaunchAssets,
  resolvePrevalidatedLaunchPlan,
  resolveLaunchPlan
};
