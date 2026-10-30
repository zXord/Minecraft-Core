const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { resolveInstallIdentity } = require('../electron/utils/install-identity.cjs');

const MODULE_PATH = path.resolve(__dirname, '../electron/utils/native-toast-policy.cjs');
const OPT_IN = Object.freeze({ MINECRAFT_CORE_ALLOW_DEV_NATIVE_TOASTS: '1' });
const SPAWN_METHODS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const WRITE_METHODS = ['appendFile', 'chmod', 'copyFile', 'cp', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir',
  'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'];

function freshPolicy() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

function identity({ isPackaged = true, uninstaller = false } = {}) {
  return resolveInstallIdentity({
    platform: 'win32',
    isPackaged,
    execPath: 'C:\\Apps\\Minecraft Core\\Minecraft Core.exe',
    existsSync: () => uninstaller,
    readRegisteredInstallLocations: () => []
  });
}

const INSTALLED = identity({ uninstaller: true });
const PACKAGED_COPY = identity();
const UNPACKAGED = identity({ isPackaged: false });

function spyOnSideEffects(t) {
  const effects = [];
  const refuse = label => () => {
    effects.push(label);
    throw new Error(`${label} is not allowed here`);
  };
  for (const name of SPAWN_METHODS) t.mock.method(childProcess, name, refuse(`child_process.${name}`));
  for (const name of WRITE_METHODS) {
    t.mock.method(fs, name, refuse(`fs.${name}`));
    t.mock.method(fs, `${name}Sync`, refuse(`fs.${name}Sync`));
    t.mock.method(fs.promises, name, refuse(`fs.promises.${name}`));
  }
  t.mock.method(fs, 'createWriteStream', refuse('fs.createWriteStream'));
  return effects;
}

test('the identities used here come from the real install-identity resolver', () => {
  assert.equal(INSTALLED.installed, true);
  assert.equal(PACKAGED_COPY.installed, false);
  assert.equal(PACKAGED_COPY.isPackaged, true);
  assert.equal(UNPACKAGED.installed, false);
  assert.equal(UNPACKAGED.isPackaged, false);
});

test('native toasts are denied until the policy is configured', () => {
  const { nativeToastsAllowed } = freshPolicy();
  assert.equal(nativeToastsAllowed(), false);
});

test('the installed copy may show native toasts', () => {
  const { configureNativeToastPolicy, nativeToastsAllowed } = freshPolicy();
  assert.equal(configureNativeToastPolicy({ identity: INSTALLED, isPackaged: true, env: {} }), true);
  assert.equal(nativeToastsAllowed(), true);
  assert.equal(configureNativeToastPolicy({ identity: INSTALLED, isPackaged: true, env: OPT_IN }), true);
  assert.equal(nativeToastsAllowed(), true);
});

test('an unpackaged run shows native toasts only with the developer opt-in', () => {
  const { ALLOW_DEV_NATIVE_TOASTS_ENV, configureNativeToastPolicy, nativeToastsAllowed } = freshPolicy();
  assert.equal(ALLOW_DEV_NATIVE_TOASTS_ENV, 'MINECRAFT_CORE_ALLOW_DEV_NATIVE_TOASTS');
  assert.equal(configureNativeToastPolicy({ identity: UNPACKAGED, isPackaged: false, env: {} }), false);
  assert.equal(nativeToastsAllowed(), false);
  assert.equal(configureNativeToastPolicy({ identity: UNPACKAGED, isPackaged: false, env: OPT_IN }), true);
  assert.equal(nativeToastsAllowed(), true);
  for (const value of ['0', 'true', 'yes', '', ' 1', '1 ']) {
    assert.equal(configureNativeToastPolicy({
      identity: UNPACKAGED, isPackaged: false, env: { MINECRAFT_CORE_ALLOW_DEV_NATIVE_TOASTS: value }
    }), false, JSON.stringify(value));
    assert.equal(nativeToastsAllowed(), false);
  }
});

test('a packaged copy that is not the installed app never shows native toasts, even with the opt-in', () => {
  const { configureNativeToastPolicy, nativeToastsAllowed } = freshPolicy();
  assert.equal(configureNativeToastPolicy({ identity: PACKAGED_COPY, isPackaged: true, env: OPT_IN }), false);
  assert.equal(nativeToastsAllowed(), false);
  assert.equal(configureNativeToastPolicy({ identity: PACKAGED_COPY, env: OPT_IN }), false);
  assert.equal(nativeToastsAllowed(), false);
});

test('isPackaged defaults to the identity and an install identity can be passed directly', () => {
  const { configureNativeToastPolicy, nativeToastsAllowed } = freshPolicy();
  assert.equal(configureNativeToastPolicy({ identity: INSTALLED }), true);
  assert.equal(nativeToastsAllowed(), true);
  assert.equal(configureNativeToastPolicy(PACKAGED_COPY), false);
  assert.equal(nativeToastsAllowed(), false);
  assert.equal(configureNativeToastPolicy(INSTALLED), true);
  assert.equal(nativeToastsAllowed(), true);
});

test('reconfiguring replaces the previous decision', () => {
  const { configureNativeToastPolicy, nativeToastsAllowed } = freshPolicy();
  configureNativeToastPolicy({ identity: INSTALLED, isPackaged: true, env: {} });
  assert.equal(nativeToastsAllowed(), true);
  configureNativeToastPolicy({ identity: PACKAGED_COPY, isPackaged: true, env: {} });
  assert.equal(nativeToastsAllowed(), false);
});

test('invalid inputs throw and leave native toasts denied', () => {
  const { configureNativeToastPolicy, nativeToastsAllowed } = freshPolicy();
  for (const options of [
    undefined,
    null,
    [],
    {},
    { identity: null, isPackaged: true, env: {} },
    { identity: { installed: 'yes' }, isPackaged: true, env: {} },
    { identity: { installed: true } },
    { identity: INSTALLED, isPackaged: 'yes', env: {} },
    { identity: INSTALLED, isPackaged: true, env: null },
    { installed: true }
  ]) {
    configureNativeToastPolicy({ identity: INSTALLED, isPackaged: true, env: {} });
    assert.equal(nativeToastsAllowed(), true);
    assert.throws(() => configureNativeToastPolicy(options), TypeError, JSON.stringify(options));
    assert.equal(nativeToastsAllowed(), false, JSON.stringify(options));
  }
});

test('requiring the module spawns no process and writes nothing', t => {
  const effects = spyOnSideEffects(t);
  const fresh = freshPolicy();
  assert.equal(fresh.nativeToastsAllowed(), false);
  assert.deepEqual(effects, []);
});
