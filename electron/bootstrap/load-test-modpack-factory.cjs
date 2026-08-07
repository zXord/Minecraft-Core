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

function resolveServiceGraphUserData({ runtimeFlags, app, runtimeRoot } = {}) {
  if (runtimeFlags?.testMode) {
    const isolated = runtimeFlags.isolatedUserDataPath;
    if (typeof isolated !== 'string' || !path.isAbsolute(isolated.trim())) {
      throw new TypeError('Test service graph requires an absolute isolated userData path');
    }
    return path.resolve(isolated.trim());
  }
  if (typeof app?.getPath === 'function') return app.getPath('userData');
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)) {
    throw new TypeError('Service graph runtime root is invalid');
  }
  return path.join(runtimeRoot, '.minecraft-core-user-data');
}

module.exports = { loadTestIpcOverrides, loadTestModpackFactory, loadTestRecoveryFactory, resolveServiceGraphUserData };
