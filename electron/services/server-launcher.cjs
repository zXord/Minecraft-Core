const fs = require('fs');
const path = require('path');
const { resolveServerLoader, normalizeLoaderName } = require('../utils/server-loader.cjs');
const { FABRIC_LAUNCH_JAR, getFabricRuntimeStatus } = require('../utils/fabric-runtime.cjs');
const { validatePreparedRuntime } = require('./loader-install-service.cjs');

const SUPPORTED_LOADERS = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt']);
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
  const current = readServerProperties(serverPath);
  const nextLines = [...current.lines];
  const seenKeys = new Set();

  Object.entries(properties).forEach(([key, value]) => {
    const serialized = `${key}=${value}`;
    const existingIndex = nextLines.findIndex((line) => line && !line.startsWith('#') && line.startsWith(`${key}=`));

    if (existingIndex >= 0) {
      nextLines[existingIndex] = serialized;
    } else {
      nextLines.push(serialized);
    }

    seenKeys.add(key);
  });

  if (nextLines.length === 0) {
    nextLines.push('');
  }

  fs.writeFileSync(current.filePath, nextLines.join('\n'), 'utf8');
}

function syncServerPort(serverPath, port) {
  if (!serverPath || !port) {
    return;
  }

  writeServerProperties(serverPath, {
    'server-port': String(port)
  });
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
    return resolveForgeLaunchPlan(serverPath, maxRam, {
      minecraftVersion,
      loaderVersion
    }, runtimeTuple);
  }

  if (resolvedLoader === 'neoforge') {
    if (!runtimeTuple) throw codedLaunchError('RUNTIME_INCOMPLETE', 'NeoForge runtime identity is missing.');
    const validation = validatePreparedRuntime(serverPath, runtimeTuple);
    const argsFile = path.join(serverPath, ...validation.loader.argsFile.split('/'));
    return commonPlan({
      type: 'neoforge',
      loader: 'neoforge',
      jar: null,
      args: [`-Xmx${maxRam}G`, '-Xms1G', `@${path.relative(serverPath, argsFile)}`, 'nogui'],
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
  resolveLaunchPlan
};
