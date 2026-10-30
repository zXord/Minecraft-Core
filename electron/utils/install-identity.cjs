const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// electron-builder's NSIS installer puts 'Uninstall <productName>.exe' next to
// the app exe and records the install folder as Software\<APP_GUID>
// InstallLocation (HKCU per-user, HKLM per-machine). APP_GUID is UUIDv5 of the
// appId in electron-builder's namespace; tests/install-identity.test.cjs pins it.
const INSTALL_REGISTRY_GUID = 'ade4bf3b-9814-5be8-858f-034b41fd69d2';
const INSTALL_REGISTRY_KEYS = Object.freeze([
  `HKCU\\Software\\${INSTALL_REGISTRY_GUID}`,
  `HKLM\\Software\\${INSTALL_REGISTRY_GUID}`
]);
const UNINSTALLER_FILE_NAME = 'Uninstall Minecraft Core.exe';
const REGISTRY_QUERY_TIMEOUT_MS = 3000;
const REGISTRY_QUERY_MAX_BUFFER = 64 * 1024;
const INSTALL_LOCATION_LINE = /^\s+InstallLocation\s+REG_SZ\s+(\S.*?)\s*$/iu;

let memoizedIdentity = null;

function hasControlCharacter(value) {
  return [...value].some(character => character.codePointAt(0) <= 0x1f);
}

function resolveRegExecutable(env) {
  const systemRoot = env?.SystemRoot;
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\/u.test(systemRoot) ||
      hasControlCharacter(systemRoot) || systemRoot.split(/[\\/]+/u).includes('..')) return null;
  return path.win32.join(path.win32.normalize(systemRoot), 'System32', 'reg.exe');
}

function parseInstallLocation(output) {
  if (typeof output !== 'string') return null;
  for (const line of output.split(/\r?\n/u)) {
    const match = INSTALL_LOCATION_LINE.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Returns a reader for the InstallLocation values the installer registered.
 * Each hive is one `reg.exe query`, hidden, with a 3 s timeout; a hive that
 * cannot be read is skipped. Nothing runs until the reader is called.
 */
function createRegistryInstallLocationReader({ execFileSync = null, env = process.env } = {}) {
  if ((execFileSync !== null && typeof execFileSync !== 'function') || !env || typeof env !== 'object') {
    throw new TypeError('Registry reader dependencies are invalid');
  }
  return function readRegisteredInstallLocations() {
    const regExecutable = resolveRegExecutable(env);
    if (!regExecutable) return [];
    const run = execFileSync || childProcess.execFileSync;
    const locations = [];
    for (const key of INSTALL_REGISTRY_KEYS) {
      let output;
      try {
        output = run(regExecutable, ['query', key, '/v', 'InstallLocation'], {
          encoding: 'utf8',
          maxBuffer: REGISTRY_QUERY_MAX_BUFFER,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: REGISTRY_QUERY_TIMEOUT_MS,
          windowsHide: true
        });
      } catch {
        continue;
      }
      const location = parseInstallLocation(output);
      if (location) locations.push(location);
    }
    return locations;
  };
}

function installDirectoryKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.win32.isAbsolute(value)) return null;
  return path.win32.normalize(value).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US');
}

function installIdentity(installed, reason, { platform, isPackaged, execPath, exeDirectory = null }) {
  return Object.freeze({ installed, reason, platform, isPackaged, execPath, exeDirectory });
}

/**
 * Decides whether this process is the NSIS-installed copy of the app. Only that
 * copy may install updates, show OS toasts or write the login item; QA, smoke,
 * portable and development copies must not touch the real installation.
 * Installed requires win32, a packaged app, and either the uninstaller next to
 * the exe or a registered InstallLocation equal to the exe folder (letter case
 * and trailing separators ignored). The registry is only read when the
 * uninstaller is missing.
 */
function resolveInstallIdentity({ platform, isPackaged, execPath, existsSync, readRegisteredInstallLocations } = {}) {
  if (typeof platform !== 'string' || typeof isPackaged !== 'boolean' || typeof existsSync !== 'function' ||
      typeof readRegisteredInstallLocations !== 'function') {
    throw new TypeError('Install identity inputs are invalid');
  }
  const facts = { platform, isPackaged, execPath: typeof execPath === 'string' ? execPath : null };
  if (platform !== 'win32') return installIdentity(false, 'unsupported-platform', facts);
  if (!isPackaged) return installIdentity(false, 'unpackaged', facts);
  if (typeof execPath !== 'string' || execPath.includes('\0') || !path.win32.isAbsolute(execPath)) {
    return installIdentity(false, 'invalid-exec-path', facts);
  }

  const exeDirectory = path.win32.dirname(path.win32.normalize(execPath));
  const located = { ...facts, exeDirectory };
  let uninstallerPresent = false;
  try {
    uninstallerPresent = existsSync(path.win32.join(exeDirectory, UNINSTALLER_FILE_NAME)) === true;
  } catch {
    uninstallerPresent = false;
  }
  if (uninstallerPresent) return installIdentity(true, 'uninstaller-present', located);

  let locations;
  try {
    locations = readRegisteredInstallLocations();
  } catch {
    return installIdentity(false, 'registry-unreadable', located);
  }
  const exeKey = installDirectoryKey(exeDirectory);
  const registered = Array.isArray(locations) && locations.some(location => installDirectoryKey(location) === exeKey);
  return installIdentity(registered, registered ? 'registered-install-location' : 'not-installed-copy', located);
}

function electronAppIsPackaged() {
  // Outside Electron, require('electron') loads the npm launcher shim, which can
  // spawn a binary download, so it is only loaded inside an Electron process.
  if (typeof process.versions?.electron !== 'string') return false;
  try {
    return require('electron')?.app?.isPackaged === true;
  } catch {
    return false;
  }
}

const readRegisteredInstallLocations = createRegistryInstallLocationReader();

/** The identity of the running process, resolved once and then reused. */
function getInstallIdentity() {
  if (memoizedIdentity === null) {
    memoizedIdentity = resolveInstallIdentity({
      platform: process.platform,
      isPackaged: electronAppIsPackaged(),
      execPath: process.execPath,
      existsSync: candidate => fs.existsSync(candidate),
      readRegisteredInstallLocations
    });
  }
  return memoizedIdentity;
}

module.exports = {
  INSTALL_REGISTRY_GUID,
  INSTALL_REGISTRY_KEYS,
  UNINSTALLER_FILE_NAME,
  createRegistryInstallLocationReader,
  getInstallIdentity,
  resolveInstallIdentity
};
