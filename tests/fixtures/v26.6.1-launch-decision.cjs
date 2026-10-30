'use strict';

// Frozen copy of how the public Minecraft Core v26.6.1 release decides what to run for a server
// folder, and what its health panel reports. Downgrade tests apply it to layouts produced by newer
// installers. Do not update it to match newer code: it must keep describing the released app.
//
// Copied from git tag v26.6.1 (commit 23d0590f3dd267ebd130c56c796e53f275da28fb):
// - electron/services/server-manager.cjs:508
//     const loader = config.loader || loaderInfo.loader || 'vanilla';
//   startMinecraftServer passes that loader to resolveLaunchPlan (line 530).
// - electron/services/server-launcher.cjs:71-91, findFirstJar and getVanillaLaunchJar (verbatim).
// - electron/services/server-launcher.cjs:320-371, resolveLaunchPlan: only 'fabric' and 'forge'
//   have launch paths; every other loader runs getVanillaLaunchJar (line 358).
// - electron/ipc/install-handlers.cjs:124-131, buildHealthReport: reports 'server.jar' when the root
//   jar is missing (its Repair then downloads vanilla), and getLoaderHealthIssues (106-122) checks
//   only 'fabric' and 'forge'.
// - electron/services/loader-install-service.cjs:44-52, normalizeLoader (verbatim).
//
// Not copied: the Fabric and Forge launch branches, their health checks and the Java check. The
// fixture refuses those loaders instead of guessing; it models only the fallback that v26.6.1
// applies to loaders it has no launch path for (NeoForge and Quilt among them).
const fs = require('fs');
const path = require('path');

function normalizeLoader(loader) {
  const normalized = typeof loader === 'string' ? loader.trim().toLowerCase() : '';
  if (!normalized) {
    return 'vanilla';
  }
  if (normalized === 'fabric') return 'fabric';
  if (normalized === 'forge') return 'forge';
  return normalized;
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

function readSummary(serverPath) {
  return JSON.parse(fs.readFileSync(path.join(serverPath, '.minecraft-core.json'), 'utf8'));
}

function unmodelled(loader) {
  return new Error(`The frozen v26.6.1 fixture does not model the ${loader} branch`);
}

function v26_6_1LaunchDecision(serverPath, maxRam = 4) {
  const config = readSummary(serverPath);
  if (!config.loader) throw unmodelled('loader-detection');
  const resolvedLoader = config.loader;
  if (resolvedLoader === 'fabric' || resolvedLoader === 'forge') throw unmodelled(resolvedLoader);

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

function v26_6_1HealthMissing(serverPath) {
  const loader = normalizeLoader(readSummary(serverPath).loader);
  if (loader === 'fabric' || loader === 'forge') throw unmodelled(loader);
  const missing = [];
  if (!fs.existsSync(path.join(serverPath, 'server.jar'))) {
    missing.push('server.jar');
  }
  return missing;
}

module.exports = {
  getVanillaLaunchJar,
  v26_6_1HealthMissing,
  v26_6_1LaunchDecision
};
