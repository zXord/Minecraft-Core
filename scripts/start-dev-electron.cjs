const { once } = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  createDevElectronRuntimeLease,
  prepareBrandedDevElectronRuntime
} = require('./dev-electron-runtime.cjs');

const DEFAULT_ELECTRON_CLI_PATH = path.resolve(__dirname, '..', 'node_modules', 'electron', 'cli.js');
const DEFAULT_ELECTRON_EXECUTABLE_PATH = require('electron');
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ICON_PATH = path.join(DEFAULT_PROJECT_ROOT, 'build-resources', 'icon.ico');
const DEFAULT_ELECTRON_VERSION = require('electron/package.json').version;

async function startDevElectron({
  electronCliPath = process.env.MINECRAFT_CORE_DEV_ELECTRON_CLI || DEFAULT_ELECTRON_CLI_PATH,
  sourceExecutablePath = DEFAULT_ELECTRON_EXECUTABLE_PATH,
  projectRoot = DEFAULT_PROJECT_ROOT,
  iconPath = DEFAULT_ICON_PATH,
  electronVersion = DEFAULT_ELECTRON_VERSION,
  architecture = process.arch,
  platform = process.platform,
  env = process.env,
  prepareDevRuntime = prepareBrandedDevElectronRuntime,
  createDevRuntimeLease = createDevElectronRuntimeLease,
  spawnProcess = spawn,
  spawnElectron,
  processLike = process
} = {}) {
  let stopping = false;
  let electron = null;
  let runtimeLease = null;
  const stop = signal => {
    stopping = true;
    if (electron && !electron.killed) electron.kill(signal);
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');

  processLike.once('SIGINT', onSigint);
  processLike.once('SIGTERM', onSigterm);
  try {
    // The native startup window is intentionally launched immediately. The
    // renderer loader already retries the fixed local Vite endpoint, so a slow
    // dependency optimizer never leaves the user staring at an absent app.
    if (stopping) return 0;
    if (platform === 'win32' && !env.MINECRAFT_CORE_DEV_ELECTRON_CLI) {
      const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
      if (!localAppData || !path.isAbsolute(localAppData)) {
        throw new TypeError('LOCALAPPDATA must be an absolute path for the Windows development runtime');
      }
      const prepared = await prepareDevRuntime({
        sourceExecutablePath,
        sourceDistributionPath: path.dirname(sourceExecutablePath),
        iconPath,
        cacheBasePath: localAppData,
        electronVersion,
        architecture
      });
      if (stopping) return 0;
      runtimeLease = await createDevRuntimeLease(prepared.cacheDirectory);
      if (stopping) return 0;
      electron = spawnProcess(prepared.executablePath, [projectRoot], {
        stdio: 'inherit',
        cwd: projectRoot,
        env
      });
    } else {
      electron = typeof spawnElectron === 'function'
        ? spawnElectron()
        : spawnProcess(process.execPath, [electronCliPath, projectRoot], {
            stdio: 'inherit',
            cwd: projectRoot,
            env
          });
    }
    const [exitCode, signal] = await once(electron, 'exit');
    return exitCode ?? (signal ? 1 : 0);
  } finally {
    processLike.off('SIGINT', onSigint);
    processLike.off('SIGTERM', onSigterm);
    await runtimeLease?.dispose?.();
  }
}

if (require.main === module) {
  startDevElectron().then(exitCode => {
    process.exitCode = exitCode;
  }).catch(error => {
    console.error('[Minecraft Core] Development Electron launcher failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  startDevElectron
};
