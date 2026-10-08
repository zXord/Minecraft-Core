const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const micromatch = require('micromatch');

const packageJson = require('../package.json');

const devConfig = require('../config/dev-config.cjs');

test('production build config does not auto-open DevTools', () => {
  assert.equal(devConfig.enableDevConsole, false);
});

test('Vite development server uses the fixed IPv4 renderer endpoint', async () => {
  const viteConfig = (await import('../vite.config.js')).default;
  const repositoryRoot = path.resolve(__dirname, '..');

  assert.equal(viteConfig.server.host, '127.0.0.1');
  assert.equal(viteConfig.server.port, 5173);
  assert.equal(viteConfig.server.strictPort, true);
  assert.equal(path.isAbsolute(viteConfig.cacheDir), true);
  assert.equal(
    path.relative(repositoryRoot, viteConfig.cacheDir).startsWith(`..${path.sep}`),
    true,
    'Vite cache must live outside the cloud-backed checkout'
  );
  assert.match(path.basename(viteConfig.cacheDir), /^[a-f0-9]{16}$/u);
  assert.match(viteConfig.cacheDir.replace(/\\/gu, '/'), /\/Minecraft Core\/vite-cache\//u);
  assert.deepEqual(viteConfig.server.warmup, {
    clientFiles: ['./src/main.js', './src/App.svelte']
  });
});

test('Vite watcher ignores replaceable build output without excluding renderer inputs', async () => {
  const viteConfig = (await import('../vite.config.js')).default;
  const ignored = viteConfig.server.watch.ignored;
  const isIgnored = candidate => micromatch.isMatch(candidate.replace(/\\/gu, '/'), ignored, { dot: true });

  for (const generatedPath of [
    'native/ArchiveWorker/bin/Release/net8.0-windows/win-x64/ArchiveWorker.exe',
    'native/ArchiveWorker/obj/Release/net8.0-windows/win-x64/apphost.exe',
    'electron/main.cjs',
    'electron/vendor/archive-worker/win32-x64/ArchiveWorker.exe',
    'tests/modpacks/production-mutation-runtime.test.cjs',
    'scripts/generate-icon.cjs',
    'docs/modpack-lifecycle.md',
    'vendor/archive-worker/win32-x64/ArchiveWorker.exe',
    'third-party/7zip/LICENSE.txt',
    'build-resources/icon.ico',
    'dist/assets/index.js',
    'dist-ssr/server.js',
    'build/Minecraft-Core-Setup.exe',
    'test-results/modpack-flow/trace.zip',
    'playwright-report/index.html',
    'coverage/lcov-report/index.html',
    '.archive-worker-diagnostic-codex/probe/output.json',
    'logs/development.log'
  ]) {
    assert.equal(isIgnored(generatedPath), true, `${generatedPath} should not be watched`);
  }

  for (const rendererInput of [
    'src/main.js',
    'src/App.svelte',
    'src/components/modpacks/ModpackSetup.svelte',
    'public/icon.png',
    'config/dev-config.cjs',
    'vite.config.js'
  ]) {
    assert.equal(isIgnored(rendererInput), false, `${rendererInput} must remain watched`);
  }
});

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Expected an IPv4 test port'));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    await wait(25);
  }
  return fs.existsSync(filePath);
}

test('development Electron launches its branded startup window before Vite is ready', async t => {
  const commandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-dev-command-'));
  const logPath = path.join(commandDirectory, 'startup.log');
  const electronCliPath = path.join(commandDirectory, 'electron-cli.cjs');
  const port = await getAvailablePort();
  const server = http.createServer((_request, response) => response.end('ready'));

  fs.writeFileSync(electronCliPath, "require('node:fs').appendFileSync(process.env.MINECRAFT_CORE_DEV_STARTUP_LOG, `electron:${process.argv.slice(2).join(' ')}\\n`);\n");
  t.after(() => fs.rmSync(commandDirectory, { recursive: true, force: true }));

  assert.equal(packageJson.scripts['dev:electron'], 'node scripts/start-dev-electron.cjs');
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', packageJson.scripts['dev:electron']], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      MINECRAFT_CORE_DEV_STARTUP_LOG: logPath,
      MINECRAFT_CORE_DEV_SERVER_PORT: String(port),
      MINECRAFT_CORE_DEV_ELECTRON_CLI: electronCliPath
    },
    stdio: 'pipe'
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  const launchedBeforeVite = await waitForFile(logPath);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => server.close());

  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, stderr);
  assert.equal(launchedBeforeVite, true, 'Electron must show the branded startup window while Vite initializes');
  assert.deepEqual(
    fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/u),
    [
      `electron:${path.resolve(__dirname, '..')}`
    ]
  );
});
