const fs = require('node:fs');
const path = require('node:path');

function testModeEnabled(env, isPackaged) {
  return isPackaged !== true && env?.NODE_ENV === 'test' && env?.MINECRAFT_CORE_TEST_MODE === '1';
}

function loadTestExportFactory({ env, requireModule, creatorName, description, isPackaged }) {
  if (!testModeEnabled(env, isPackaged)) return null;

  const configured = env.MINECRAFT_CORE_TEST_MODPACK_FACTORY;
  if (configured === undefined || configured === null || configured === '') return null;
  if (typeof configured !== 'string' || !path.isAbsolute(configured.trim())) {
    throw new TypeError('Test modpack factory module must be an absolute path');
  }
  if (typeof requireModule !== 'function') throw new TypeError('Test modpack factory loader is invalid');

  const modulePath = path.resolve(configured.trim());
  const loaded = requireModule(modulePath);
  if (!loaded || typeof loaded[creatorName] !== 'function') {
    throw new TypeError(`Test modpack factory module must export ${creatorName}`);
  }
  const factory = loaded[creatorName]();
  if (typeof factory !== 'function') throw new TypeError(`${description} export returned an invalid factory`);
  return factory;
}

function loadTestModpackFactory({ env = process.env, requireModule = require, isPackaged = false } = {}) {
  return loadTestExportFactory({ env, requireModule, creatorName: 'createModpackFactory', description: 'Test modpack factory', isPackaged });
}

function loadTestRecoveryFactory({ env = process.env, requireModule = require, isPackaged = false } = {}) {
  return loadTestExportFactory({ env, requireModule, creatorName: 'createRecoveryFactory', description: 'Test recovery factory', isPackaged });
}

function loadTestIpcOverrides({ env = process.env, requireModule = require, isPackaged = false } = {}) {
  if (!testModeEnabled(env, isPackaged)) return null;
  const configured = env.MINECRAFT_CORE_TEST_MODPACK_FACTORY;
  if (configured === undefined || configured === null || configured === '') return null;
  if (typeof configured !== 'string' || !path.isAbsolute(configured.trim())) {
    throw new TypeError('Test modpack factory module must be an absolute path');
  }
  const loaded = requireModule(path.resolve(configured.trim()));
  if (!loaded || typeof loaded.createIpcOverrides !== 'function') {
    throw new TypeError('Test modpack factory module must export createIpcOverrides');
  }
  const overrides = loaded.createIpcOverrides();
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Test IPC override export returned invalid overrides');
  }
  return overrides;
}

// The modpack services refuse a data folder reached through a junction, SUBST
// drive or 8.3 short name, so the service graph uses its canonical drive path.
// Only the graph does: Electron and app-store keep their own spelling. A path
// that differs only in letter case, a network share, or a folder that cannot
// be created or resolved keeps the given spelling.
function canonicalServiceGraphUserData(rawPath, fsApi) {
  if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath) || /^[\\/]{2}/u.test(rawPath)) return rawPath;
  let canonical;
  try {
    fsApi.mkdirSync(rawPath, { recursive: true });
    canonical = fsApi.realpathSync.native(rawPath);
  } catch {
    return rawPath;
  }
  if (typeof canonical !== 'string' || !/^[A-Za-z]:[\\/]/u.test(canonical)) return rawPath;
  const resolved = path.resolve(canonical);
  if (resolved === path.parse(resolved).root ||
      resolved.toLocaleLowerCase('en-US') === path.resolve(rawPath).toLocaleLowerCase('en-US')) return rawPath;
  return resolved;
}

function resolveServiceGraphUserData({ runtimeFlags, app, runtimeRoot, fsApi = fs } = {}) {
  if (runtimeFlags?.testMode) {
    const isolated = runtimeFlags.isolatedUserDataPath;
    if (typeof isolated !== 'string' || !path.isAbsolute(isolated.trim())) {
      throw new TypeError('Test service graph requires an absolute isolated userData path');
    }
    return path.resolve(isolated.trim());
  }
  if (typeof app?.getPath === 'function') return canonicalServiceGraphUserData(app.getPath('userData'), fsApi);
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) {
    throw new TypeError('Service graph runtime root is invalid');
  }
  return path.join(runtimeRoot, '.minecraft-core-user-data');
}

module.exports = { loadTestIpcOverrides, loadTestModpackFactory, loadTestRecoveryFactory, resolveServiceGraphUserData };
