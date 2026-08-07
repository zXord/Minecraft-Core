const os = require('node:os');
const path = require('node:path');

function createRuntimeFlags({ env = process.env, platform = process.platform, processId = process.pid, isPackaged = false } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || typeof platform !== 'string' || !platform ||
      !Number.isSafeInteger(processId) || processId < 1 || typeof isPackaged !== 'boolean') {
    throw new TypeError('Runtime flag dependencies are invalid');
  }

  // A packaged binary is always production composition. Environment variables
  // supplied by its caller must never activate dev-only service injection.
  const testMode = !isPackaged && env.NODE_ENV === 'test' && env.MINECRAFT_CORE_TEST_MODE === '1';
  let isolatedUserDataPath = null;
  if (testMode) {
    const configured = env.MINECRAFT_CORE_USER_DATA_DIR;
    if (configured !== undefined && (typeof configured !== 'string' || !path.isAbsolute(configured.trim()))) {
      throw new TypeError('Test userData path must be absolute');
    }
    isolatedUserDataPath = path.resolve(configured?.trim() || path.join(os.tmpdir(), `minecraft-core-test-${processId}`));
  }

  return Object.freeze({
    testMode,
    platform,
    isolatedUserDataPath,
    updaterEnabled: !testMode,
    trayEnabled: !testMode,
    watchdogEnabled: !testMode,
    nativeNotificationsEnabled: !testMode,
    publicManagementListenersEnabled: !testMode
  });
}

module.exports = { createRuntimeFlags };
