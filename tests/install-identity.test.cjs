const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const packageJson = require('../package.json');

const MODULE_PATH = path.resolve(__dirname, '../electron/utils/install-identity.cjs');
const {
  INSTALL_REGISTRY_GUID,
  INSTALL_REGISTRY_KEYS,
  UNINSTALLER_FILE_NAME,
  createRegistryInstallLocationReader,
  resolveInstallIdentity
} = require(MODULE_PATH);

const INSTALL_DIRECTORY = 'C:\\Users\\Player\\AppData\\Local\\Programs\\Minecraft Core';
const EXEC_PATH = `${INSTALL_DIRECTORY}\\Minecraft Core.exe`;
const UNINSTALLER_PATH = `${INSTALL_DIRECTORY}\\Uninstall Minecraft Core.exe`;
const APP_BUILDER_ROOT = path.dirname(require.resolve('app-builder-lib/package.json'));
const SPAWN_METHODS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
const WRITE_METHODS = ['appendFile', 'chmod', 'copyFile', 'cp', 'link', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir',
  'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'];

function resolveWith({ uninstaller = false, locations = [], registryError = null, existsError = null, ...overrides } = {}) {
  const probes = { exists: [], registryReads: 0 };
  const identity = resolveInstallIdentity({
    platform: 'win32',
    isPackaged: true,
    execPath: EXEC_PATH,
    existsSync: candidate => {
      probes.exists.push(candidate);
      if (existsError) throw existsError;
      return uninstaller && candidate === UNINSTALLER_PATH;
    },
    readRegisteredInstallLocations: () => {
      probes.registryReads += 1;
      if (registryError) throw registryError;
      return locations;
    },
    ...overrides
  });
  return { identity, probes };
}

function regOutput(hive, value, type = 'REG_SZ') {
  return `\r\n${hive}\\Software\\${INSTALL_REGISTRY_GUID}\r\n    InstallLocation    ${type}    ${value}\r\n\r\n`;
}

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

test('the copy with its uninstaller next to the exe is the installed app, without reading the registry', () => {
  const { identity, probes } = resolveWith({ uninstaller: true });
  assert.deepEqual(identity, {
    installed: true,
    reason: 'uninstaller-present',
    platform: 'win32',
    isPackaged: true,
    execPath: EXEC_PATH,
    exeDirectory: INSTALL_DIRECTORY
  });
  assert.equal(Object.isFrozen(identity), true);
  assert.deepEqual(probes, { exists: [UNINSTALLER_PATH], registryReads: 0 });
});

test('a registered InstallLocation equal to the exe folder marks the installed app, ignoring case and trailing separators', () => {
  for (const location of [
    INSTALL_DIRECTORY,
    INSTALL_DIRECTORY.toLowerCase(),
    `${INSTALL_DIRECTORY.toUpperCase()}\\`,
    `${INSTALL_DIRECTORY}\\\\`,
    `${INSTALL_DIRECTORY.replace(/\\/gu, '/')}/`
  ]) {
    const { identity, probes } = resolveWith({ locations: [location] });
    assert.equal(identity.installed, true, location);
    assert.equal(identity.reason, 'registered-install-location');
    assert.deepEqual(probes, { exists: [UNINSTALLER_PATH], registryReads: 1 });
  }
  assert.equal(resolveWith({ locations: ['D:\\Games\\Minecraft Core', INSTALL_DIRECTORY] }).identity.installed, true);
});

test('a registry location elsewhere or a failed registry read means this is not the installed app', () => {
  for (const locations of [
    [],
    ['C:\\Program Files\\Minecraft Core'],
    ['C:\\Users\\Player\\AppData\\Local\\Programs\\Minecraft'],
    [`${INSTALL_DIRECTORY}\\resources`],
    ['Minecraft Core'],
    [null, 42, '']
  ]) {
    const { identity } = resolveWith({ locations });
    assert.equal(identity.installed, false, JSON.stringify(locations));
    assert.equal(identity.reason, 'not-installed-copy');
  }
  const failed = resolveWith({ registryError: Object.assign(new Error('reg.exe failed'), { status: 1 }) });
  assert.equal(failed.identity.installed, false);
  assert.equal(failed.identity.reason, 'registry-unreadable');

  const unreadableFolder = resolveWith({ existsError: Object.assign(new Error('EACCES'), { code: 'EACCES' }) });
  assert.equal(unreadableFolder.identity.installed, false);
  assert.equal(unreadableFolder.probes.registryReads, 1);
});

test('unpackaged and non-Windows copies are never the installed app and probe nothing', () => {
  const unpackaged = resolveWith({ isPackaged: false, uninstaller: true, locations: [INSTALL_DIRECTORY] });
  assert.equal(unpackaged.identity.installed, false);
  assert.equal(unpackaged.identity.reason, 'unpackaged');
  assert.equal(unpackaged.identity.isPackaged, false);
  assert.deepEqual(unpackaged.probes, { exists: [], registryReads: 0 });

  for (const platform of ['linux', 'darwin']) {
    const other = resolveWith({ platform, uninstaller: true, locations: [INSTALL_DIRECTORY] });
    assert.equal(other.identity.installed, false);
    assert.equal(other.identity.reason, 'unsupported-platform');
    assert.deepEqual(other.probes, { exists: [], registryReads: 0 });
  }
});

test('an exe path that is not an absolute Windows path is never the installed app', () => {
  for (const execPath of ['Minecraft Core.exe', '', null, undefined, 'C:\\Apps\\Minecraft\0Core.exe']) {
    const { identity, probes } = resolveWith({ execPath, uninstaller: true, locations: [INSTALL_DIRECTORY] });
    assert.equal(identity.installed, false);
    assert.equal(identity.reason, 'invalid-exec-path');
    assert.equal(identity.exeDirectory, null);
    assert.deepEqual(probes, { exists: [], registryReads: 0 });
  }
});

test('invalid inputs are programming errors', () => {
  const base = {
    platform: 'win32', isPackaged: true, execPath: EXEC_PATH, existsSync: () => false, readRegisteredInstallLocations: () => []
  };
  assert.throws(() => resolveInstallIdentity(), TypeError);
  for (const override of [{ platform: 32 }, { isPackaged: 'yes' }, { existsSync: null }, { readRegisteredInstallLocations: [] }]) {
    assert.throws(() => resolveInstallIdentity({ ...base, ...override }), TypeError, JSON.stringify(override));
  }
});

test('the registry GUID is electron-builder\'s UUIDv5 of the app id', () => {
  const { UUID } = require(require.resolve('builder-util-runtime', { paths: [APP_BUILDER_ROOT] }));
  const nsisTarget = fs.readFileSync(path.join(APP_BUILDER_ROOT, 'out', 'targets', 'nsis', 'NsisTarget.js'), 'utf8');
  const namespace = /ELECTRON_BUILDER_NS_UUID = [\w$.]*UUID\.parse\("([0-9a-f-]{36})"\)/u.exec(nsisTarget)?.[1];
  assert.equal(namespace, '50e065bc-3134-11e6-9bab-38c9862bdaf3');
  assert.match(nsisTarget, /UUID\.v5\(appInfo\.id, ELECTRON_BUILDER_NS_UUID\)/u);
  assert.equal(packageJson.build.appId, 'com.minecraft-core.app');
  assert.equal(INSTALL_REGISTRY_GUID, UUID.v5(packageJson.build.appId, UUID.parse(namespace)));
  assert.equal(INSTALL_REGISTRY_GUID, 'ade4bf3b-9814-5be8-858f-034b41fd69d2');
  assert.deepEqual(INSTALL_REGISTRY_KEYS, [
    'HKCU\\Software\\ade4bf3b-9814-5be8-858f-034b41fd69d2',
    'HKLM\\Software\\ade4bf3b-9814-5be8-858f-034b41fd69d2'
  ]);
});

test('the uninstaller name follows electron-builder\'s NSIS template for this product', () => {
  const commonNsh = fs.readFileSync(path.join(APP_BUILDER_ROOT, 'templates', 'nsis', 'common.nsh'), 'utf8');
  assert.match(commonNsh, /!define UNINSTALL_FILENAME "Uninstall \$\{PRODUCT_FILENAME\}\.exe"/u);
  assert.equal(UNINSTALLER_FILE_NAME, `Uninstall ${packageJson.build.productName}.exe`);
  assert.equal(UNINSTALLER_FILE_NAME, 'Uninstall Minecraft Core.exe');
});

test('the registry fallback runs System32 reg.exe hidden with a 3 s timeout and reads InstallLocation from both hives', () => {
  const runs = [];
  const outputs = new Map([[INSTALL_REGISTRY_KEYS[1], regOutput('HKEY_LOCAL_MACHINE', 'C:\\Program Files\\Minecraft Core')]]);
  const read = createRegistryInstallLocationReader({
    env: { SystemRoot: 'C:\\WINDOWS' },
    execFileSync: (file, args, options) => {
      runs.push({ file, args, options });
      if (!outputs.has(args[1])) throw Object.assign(new Error('ERROR: The system was unable to find the specified registry key'), { status: 1 });
      return outputs.get(args[1]);
    }
  });

  assert.deepEqual(read(), ['C:\\Program Files\\Minecraft Core']);
  assert.deepEqual(runs.map(({ file, args }) => [file, args]), [
    ['C:\\WINDOWS\\System32\\reg.exe', ['query', INSTALL_REGISTRY_KEYS[0], '/v', 'InstallLocation']],
    ['C:\\WINDOWS\\System32\\reg.exe', ['query', INSTALL_REGISTRY_KEYS[1], '/v', 'InstallLocation']]
  ]);
  for (const { options } of runs) {
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 3000);
    assert.notEqual(options.shell, true);
    assert.equal(options.encoding, 'utf8');
  }

  outputs.set(INSTALL_REGISTRY_KEYS[0], regOutput('HKEY_CURRENT_USER', INSTALL_DIRECTORY));
  assert.deepEqual(read(), [INSTALL_DIRECTORY, 'C:\\Program Files\\Minecraft Core']);
});

test('the registry fallback ignores other value types and malformed output', () => {
  const outputs = [
    regOutput('HKEY_CURRENT_USER', '%LOCALAPPDATA%\\Programs\\Minecraft Core', 'REG_EXPAND_SZ'),
    '\r\nHKEY_LOCAL_MACHINE\\Software\\x\r\n    KeepShortcuts    REG_SZ    true\r\n'
  ];
  const read = createRegistryInstallLocationReader({ env: { SystemRoot: 'C:\\Windows' }, execFileSync: () => outputs.shift() });
  assert.deepEqual(read(), []);
});

test('the registry fallback never runs without a valid SystemRoot', () => {
  for (const env of [{}, { SystemRoot: '' }, { SystemRoot: 'Windows' }, { SystemRoot: '\\\\server\\share\\Windows' },
    { SystemRoot: 'C:\\Windows\\..\\Temp' }, { SystemRoot: 'C:\\Win\ndows' }]) {
    let runs = 0;
    const read = createRegistryInstallLocationReader({ env, execFileSync: () => { runs += 1; return ''; } });
    assert.deepEqual(read(), [], JSON.stringify(env));
    assert.equal(runs, 0);
  }
});

test('getInstallIdentity is memoized and treats a plain Node process as an unpackaged copy', t => {
  const effects = spyOnSideEffects(t);
  const electronLoads = [];
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function trackElectron(request, parent, isMain) {
    if (request === 'electron') electronLoads.push(request);
    return originalLoad.call(this, request, parent, isMain);
  });
  delete require.cache[MODULE_PATH];
  const fresh = require(MODULE_PATH);

  const first = fresh.getInstallIdentity();
  const second = fresh.getInstallIdentity();
  assert.equal(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(first.installed, false);
  assert.equal(first.isPackaged, false);
  assert.equal(first.reason, process.platform === 'win32' ? 'unpackaged' : 'unsupported-platform');
  if (!process.versions.electron) assert.deepEqual(electronLoads, []);
  assert.deepEqual(effects, []);
});

test('requiring the module spawns no process and writes nothing', t => {
  const effects = spyOnSideEffects(t);
  delete require.cache[MODULE_PATH];
  const fresh = require(MODULE_PATH);
  assert.equal(typeof fresh.getInstallIdentity, 'function');
  assert.deepEqual(effects, []);
});
