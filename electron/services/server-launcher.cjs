const fs = require('fs');
const path = require('path');
const { resolveServerLoader } = require('../utils/server-loader.cjs');
const { FABRIC_LAUNCH_JAR, getFabricRuntimeStatus } = require('../utils/fabric-runtime.cjs');

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
      && !lower.includes('forge');
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
  const forgeArgs = pickBestForgeAsset(forgeArgCandidates, {
    ...expected,
    serverPath
  });

  const runScriptCandidates = files.filter((file) => /^run\.(bat|cmd|sh)$/i.test(path.basename(file)));
  const runScript = pickBestForgeAsset(runScriptCandidates, {
    ...expected,
    serverPath
  }, forgeArgs ? path.dirname(forgeArgs) : null);

  return {
    userJvmArgs,
    forgeArgs,
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

function normalizeForgeArgs(args, baseDir) {
  const normalized = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '-jar' || token === '-cp' || token === '-classpath' || token === '--module-path') {
      const nextToken = args[index + 1];
      normalized.push(token);
      if (nextToken) {
        const resolvedPath = path.isAbsolute(nextToken) ? nextToken : path.resolve(baseDir, nextToken);
        normalized.push(resolvedPath);
        index += 1;
      }
      continue;
    }

    normalized.push(token);
  }

  return normalized;
}

function resolveForgeLaunchPlan(serverPath, maxRam, expected = {}) {
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

  return {
    type: 'forge',
    loader: 'forge',
    args,
    assets
  };
}

function resolveLaunchPlan(serverPath, options = {}) {
  const resolvedLoaderInfo = resolveServerLoader(serverPath);
  const resolvedLoader = options.loader || resolvedLoaderInfo.loader || 'vanilla';
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

    return {
      type: 'jar',
      loader: 'fabric',
      jar: launchJar,
      args: [`-Xmx${maxRam}G`, '-jar', launchJar, 'nogui']
    };
  }

  if (resolvedLoader === 'forge') {
    return resolveForgeLaunchPlan(serverPath, maxRam, {
      minecraftVersion,
      loaderVersion
    });
  }

  const launchJar = getVanillaLaunchJar(serverPath);
  if (!launchJar) {
    const error = new Error('No valid server jar was found in the selected server folder.');
    error.code = 'SERVER_JAR_MISSING';
    throw error;
  }

  return {
    type: 'jar',
    loader: resolvedLoader || 'vanilla',
    jar: launchJar,
    args: [`-Xmx${maxRam}G`, '-jar', launchJar, 'nogui']
  };
}

module.exports = {
  readServerProperties,
  writeServerProperties,
  syncServerPort,
  findForgeLaunchAssets,
  resolveLaunchPlan
};
