const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const PACKAGED_SMOKE_ARGUMENT = '--minecraft-core-packaged-smoke';
const PACKAGED_SMOKE_MARKER = '.minecraft-core-packaged-smoke';
const REAL_E2E_ROOT_ARGUMENT = '--minecraft-core-real-e2e-root';

function pathKey(value, platform) {
  const resolved = path.resolve(value);
  return platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function isStrictlyInside(parentKey, childKey) {
  const relative = path.relative(parentKey, childKey);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveIsolatedRealE2ERoot({ argv, env, isPackaged, platform, tempDirectory }) {
  if (isPackaged || env.NODE_ENV !== 'development' ||
      env.MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS !== '1') return null;
  const prefix = `${REAL_E2E_ROOT_ARGUMENT}=`;
  const argumentsForRoot = argv.filter(value => value.startsWith(prefix));
  const configuredUserData = env.MINECRAFT_CORE_USER_DATA_DIR;
  if (argumentsForRoot.length !== 1 || typeof configuredUserData !== 'string') return null;

  const rawRoot = argumentsForRoot[0].slice(prefix.length).trim();
  const rawUserData = configuredUserData.trim();
  if (!rawRoot || !rawUserData || !path.isAbsolute(rawRoot) || !path.isAbsolute(rawUserData)) return null;

  const root = path.resolve(rawRoot);
  const rootKey = pathKey(root, platform);
  const tempKey = pathKey(tempDirectory, platform);
  // The harness creates its root in the parent's temp folder and then points
  // the child's TEMP inside that root, so either relation identifies it.
  if (
    (pathKey(path.dirname(root), platform) !== tempKey && !isStrictlyInside(rootKey, tempKey))
    || !path.basename(root).startsWith('minecraft-core-real-')
    || pathKey(rawUserData, platform) !== pathKey(path.join(root, 'user-data'), platform)
  ) {
    return null;
  }
  return root;
}

function resolvePackagedSmokeAuthorization({ argv, fsApi }) {
  const smokeValue = argv.find(value => value.startsWith(`${PACKAGED_SMOKE_ARGUMENT}=`));
  const userDataValue = argv.find(value => value.startsWith('--user-data-dir='));
  if (!smokeValue || !userDataValue) return null;
  const nonce = smokeValue.slice(PACKAGED_SMOKE_ARGUMENT.length + 1);
  const userDataPath = userDataValue.slice('--user-data-dir='.length);
  if (!/^[a-f0-9]{64}$/u.test(nonce) || !path.isAbsolute(userDataPath)) return null;
  const resolvedUserDataPath = path.resolve(userDataPath);
  const markerPath = path.join(resolvedUserDataPath, PACKAGED_SMOKE_MARKER);
  try {
    if (fsApi.readFileSync(markerPath, 'utf8').trim() !== nonce) return null;
    fsApi.unlinkSync(markerPath);
  } catch {
    return null;
  }
  return Object.freeze({ nonce, userDataPath: resolvedUserDataPath, markerPath });
}

function createRuntimeFlags({
  env = process.env,
  argv = process.argv,
  platform = process.platform,
  processId = process.pid,
  isPackaged = false,
  fsApi = fs,
  tempDirectory = os.tmpdir()
} = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || typeof platform !== 'string' || !platform ||
      !Array.isArray(argv) || argv.some(value => typeof value !== 'string') ||
      !Number.isSafeInteger(processId) || processId < 1 || typeof isPackaged !== 'boolean' ||
      !fsApi || typeof fsApi.readFileSync !== 'function' || typeof fsApi.unlinkSync !== 'function' ||
      typeof tempDirectory !== 'string' || !tempDirectory.trim()) {
    throw new TypeError('Runtime flag dependencies are invalid');
  }

  // A packaged binary is always production composition. Environment variables
  // supplied by its caller must never activate dev-only service injection.
  const testMode = !isPackaged && env.NODE_ENV === 'test' && env.MINECRAFT_CORE_TEST_MODE === '1';
  const packagedSmokeAuthorization = isPackaged ? resolvePackagedSmokeAuthorization({ argv, fsApi }) : null;
  const packagedSmokeMode = Boolean(packagedSmokeAuthorization);
  const isolatedRealE2ERoot = resolveIsolatedRealE2ERoot({ argv, env, isPackaged, platform, tempDirectory });
  let isolatedUserDataPath = null;
  if (testMode) {
    const configured = env.MINECRAFT_CORE_USER_DATA_DIR;
    if (configured !== undefined && (typeof configured !== 'string' || !path.isAbsolute(configured.trim()))) {
      throw new TypeError('Test userData path must be absolute');
    }
    isolatedUserDataPath = path.resolve(configured?.trim() || path.join(tempDirectory, `minecraft-core-test-${processId}`));
  }

  return Object.freeze({
    testMode,
    packagedSmokeMode,
    packagedSmokeUserDataPath: packagedSmokeAuthorization?.userDataPath || null,
    platform,
    isolatedUserDataPath,
    updaterEnabled: !testMode && !packagedSmokeMode,
    automaticReleaseChecksEnabled: !testMode && !packagedSmokeMode,
    trayEnabled: !testMode,
    watchdogEnabled: !testMode,
    nativeNotificationsEnabled: !testMode && !isolatedRealE2ERoot,
    publicManagementListenersEnabled: !testMode && !packagedSmokeMode
  });
}

module.exports = { PACKAGED_SMOKE_ARGUMENT, PACKAGED_SMOKE_MARKER, REAL_E2E_ROOT_ARGUMENT, createRuntimeFlags };
