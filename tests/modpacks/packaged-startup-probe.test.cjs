const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const probePath = path.join(__dirname, '..', 'e2e', 'fixtures', 'packaged-startup-probe.cjs');

function loadProbe() {
  return require(probePath);
}

test('renderer CSP meta policies omit the unsupported frame-ancestors directive', () => {
  const repositoryRoot = path.join(__dirname, '..', '..');
  for (const relativePath of [
    'index.html',
    'public/logger-window.html',
    'electron/logger-window.html',
    'electron/debug-console.html'
  ]) {
    const html = fs.readFileSync(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
    const policy = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/u)?.[1] || '';
    assert.match(policy, /object-src 'none'/u, relativePath);
    assert.match(policy, /base-uri 'self'/u, relativePath);
    assert.doesNotMatch(policy, /frame-ancestors/u, relativePath);
  }
});

test('the renderer canvas stays dark when Windows prefers a light color scheme', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app.css'), 'utf8');
  assert.match(css, /color-scheme:\s*dark/u);
  assert.match(css, /html,\s*body,\s*#app\s*\{[^}]*background-color:\s*#1a1a1a/isu);
  assert.doesNotMatch(css, /prefers-color-scheme:\s*light[^}]*background-color:\s*#ffffff/isu);
});

test('packaged startup selects the dist renderer window instead of the early data-url splash', async () => {
  const { waitForPackagedMainWindow } = loadProbe();
  assert.equal(typeof waitForPackagedMainWindow, 'function', 'the packaged main-window selector must exist');

  const startupWindow = { url: () => 'data:text/html;charset=utf-8,%3Ch1%3EStarting%3C%2Fh1%3E' };
  const unrelatedPackagedWindow = { url: () => 'file:///C:/Other/Minecraft%20Core/resources/app.asar/dist/index.html' };
  const mainWindow = { url: () => 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html' };
  const windows = [startupWindow, unrelatedPackagedWindow];
  const electronApp = { windows: () => [...windows] };

  setTimeout(() => windows.push(mainWindow), 10);

  assert.equal(await waitForPackagedMainWindow(electronApp, {
    deadlineMs: Date.now() + 250,
    pollIntervalMs: 2,
    expectedRendererUrl: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html'
  }), mainWindow);
});

test('packaged startup rejects a renderer whose static startup splash never disappeared', () => {
  const { validatePackagedRendererSnapshot } = loadProbe();
  assert.equal(typeof validatePackagedRendererSnapshot, 'function', 'the packaged renderer validator must exist');

  assert.throws(() => validatePackagedRendererSnapshot({
    url: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    title: 'Minecraft Core',
    startupSplashCount: 1,
    appSurfaceVisible: true,
    primaryControlVisible: true,
    bodyBackgroundColor: 'rgb(26, 26, 26)',
    documentBackgroundColor: 'rgb(26, 26, 26)',
    rendererErrors: []
  }), error => error?.code === 'PACKAGED_STARTUP_FAILED');
});

test('packaged startup rejects a white renderer even when the app container exists', () => {
  const { validatePackagedRendererSnapshot } = loadProbe();

  assert.throws(() => validatePackagedRendererSnapshot({
    url: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    title: 'Minecraft Core',
    startupSplashCount: 0,
    appSurfaceVisible: true,
    primaryControlVisible: true,
    bodyBackgroundColor: 'rgb(255, 255, 255)',
    documentBackgroundColor: 'rgb(26, 26, 26)',
    rendererErrors: []
  }), error => error?.code === 'PACKAGED_STARTUP_FAILED');
});

test('packaged startup rejects a transparent body that can expose the default white window', () => {
  const { validatePackagedRendererSnapshot } = loadProbe();

  assert.throws(() => validatePackagedRendererSnapshot({
    url: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    title: 'Minecraft Core',
    startupSplashCount: 0,
    appSurfaceVisible: true,
    primaryControlVisible: true,
    bodyBackgroundColor: 'rgba(0, 0, 0, 0)',
    documentBackgroundColor: 'rgb(26, 26, 26)',
    rendererErrors: []
  }), error => error?.code === 'PACKAGED_STARTUP_FAILED');
});

test('packaged startup rejects a renderer that raised a page or console error while mounting', () => {
  const { validatePackagedRendererSnapshot } = loadProbe();

  assert.throws(() => validatePackagedRendererSnapshot({
    url: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    title: 'Minecraft Core',
    startupSplashCount: 0,
    appSurfaceVisible: true,
    primaryControlVisible: true,
    bodyBackgroundColor: 'rgb(26, 26, 26)',
    documentBackgroundColor: 'rgb(26, 26, 26)',
    rendererErrors: ['pageerror: ReferenceError: bootstrap is not defined']
  }), error => error?.code === 'PACKAGED_STARTUP_FAILED');
});

test('packaged startup requires the mounted app surface and clean-profile primary control', () => {
  const { validatePackagedRendererSnapshot } = loadProbe();

  for (const changed of [
    { appSurfaceVisible: false, primaryControlVisible: true },
    { appSurfaceVisible: true, primaryControlVisible: false }
  ]) {
    assert.throws(() => validatePackagedRendererSnapshot({
      url: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
      title: 'Minecraft Core',
      startupSplashCount: 0,
      ...changed,
      bodyBackgroundColor: 'rgb(26, 26, 26)',
      documentBackgroundColor: 'rgb(26, 26, 26)',
      rendererErrors: []
    }), error => error?.code === 'PACKAGED_STARTUP_FAILED');
  }
});

test('packaged startup evidence is tied to the exact packaged renderer identity', () => {
  const { validatePackagedRendererSnapshot } = loadProbe();
  const healthy = {
    url: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    title: 'Minecraft Core',
    startupSplashCount: 0,
    appSurfaceVisible: true,
    primaryControlVisible: true,
    bodyBackgroundColor: 'rgb(26, 26, 26)',
    documentBackgroundColor: 'rgb(26, 26, 26)',
    rendererErrors: []
  };

  for (const changed of [
    { url: 'data:text/html;charset=utf-8,Starting' },
    { url: 'file:///C:/Temp/dist/index.html' },
    { title: 'Starting Minecraft Core…' }
  ]) {
    assert.throws(
      () => validatePackagedRendererSnapshot({ ...healthy, ...changed }),
      error => error?.code === 'PACKAGED_STARTUP_FAILED'
    );
  }

  const validated = validatePackagedRendererSnapshot(healthy);
  assert.deepEqual(validated, healthy);
  assert.equal(Object.isFrozen(validated), true);
  assert.notEqual(validated, healthy);
});

test('packaged startup captures renderer failures from existing and subsequently opened windows', () => {
  const { createPackagedRendererErrorCollector } = loadProbe();
  assert.equal(typeof createPackagedRendererErrorCollector, 'function', 'the renderer error collector must exist');

  const existingWindow = new EventEmitter();
  const laterWindow = new EventEmitter();
  const electronApp = new EventEmitter();
  electronApp.windows = () => [existingWindow];
  const collector = createPackagedRendererErrorCollector(electronApp);

  existingWindow.emit('pageerror', new Error('mount failed'));
  electronApp.emit('window', laterWindow);
  laterWindow.emit('console', { type: () => 'error', text: () => 'chunk failed' });
  laterWindow.emit('requestfailed', {
    url: () => 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/assets/app.js',
    failure: () => ({ errorText: 'net::ERR_FILE_NOT_FOUND' })
  });

  assert.deepEqual(collector.errors, [
    'pageerror: mount failed',
    'console: chunk failed',
    'requestfailed: net::ERR_FILE_NOT_FOUND'
  ]);

  collector.dispose();
  laterWindow.emit('pageerror', new Error('after dispose'));
  assert.equal(collector.errors.length, 3);
});

test('packaged startup waits for its launched application process to exit during cleanup', async (t) => {
  const { closePackagedElectronApp } = loadProbe();
  assert.equal(typeof closePackagedElectronApp, 'function', 'the packaged process cleanup barrier must exist');

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const electronApp = {
    process: () => child,
    async close() { child.kill(); }
  };

  const result = await closePackagedElectronApp(electronApp, { timeoutMs: 5_000 });
  assert.deepEqual(result, { processExited: true });
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});

test('packaged startup force-closes its held child handle but fails rather than PID-killing a leaked descendant', async (t) => {
  const { closePackagedElectronApp } = loadProbe();
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    process.stdout.write(String(descendant.pid) + '\\n');
    setInterval(() => {}, 1000);
  `], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  });
  const descendantPid = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', bytes => resolve(Number(String(bytes).trim())));
  });
  const isAlive = pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (isAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
  });
  const electronApp = {
    process: () => child,
    async close() {}
  };

  let cleanupError = null;
  await assert.rejects(
    closePackagedElectronApp(electronApp, { timeoutMs: 50, forceExitTimeoutMs: 2_000 }),
    error => {
      cleanupError = error;
      return error?.code === 'PACKAGED_STARTUP_FAILED';
    }
  );
  assert.equal(
    cleanupError.preservePackagedSmokeRoot,
    true,
    'unproven descendant cleanup must tell the outer smoke runner to preserve its isolated root'
  );
  assert.equal(child.exitCode !== null || child.signalCode !== null, true, 'the exact launched child must be gone');
  assert.equal(isAlive(descendantPid), true, 'a detached descendant is reported as a leak, never killed through a reusable PID');
});

test('packaged startup waits for Svelte to replace the splash and expose the clean-profile control', async () => {
  const { inspectPackagedRenderer } = loadProbe();
  assert.equal(typeof inspectPackagedRenderer, 'function', 'the packaged renderer inspection must exist');

  let splashCount = 1;
  let currentTime = 1_000;
  const appSurface = {
    async waitFor(options) {
      assert.deepEqual(options, { state: 'visible', timeout: 600 });
      currentTime += 200;
    },
    async isVisible() { return true; }
  };
  const splash = {
    async waitFor(options) {
      assert.deepEqual(options, { state: 'detached', timeout: 900 });
      splashCount = 0;
      currentTime += 300;
    },
    async count() { return splashCount; }
  };
  const primaryControl = {
    async waitFor(options) { assert.deepEqual(options, { state: 'visible', timeout: 400 }); },
    async isVisible() { return true; }
  };
  const page = {
    url: () => 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    async title() { return 'Minecraft Core'; },
    async waitForLoadState(state, options) {
      assert.equal(state, 'domcontentloaded');
      assert.deepEqual(options, { timeout: 1_000 });
      currentTime += 100;
    },
    async waitForFunction(predicate, argument, options) {
      assert.equal(typeof predicate, 'function');
      assert.match(String(predicate), /appStartupQuiescent/);
      assert.equal(argument, null);
      assert.deepEqual(options, { timeout: 400 });
    },
    locator(selector) {
      if (selector === '#startup-splash') return splash;
      if (selector === 'main.app-container') return appSurface;
      throw new Error(`Unexpected locator: ${selector}`);
    },
    getByRole(role, options) {
      assert.equal(role, 'button');
      assert.equal(options?.name instanceof RegExp, true);
      assert.equal(options.name.source, 'Create Your First Instance$');
      return primaryControl;
    },
    async evaluate() {
      return {
        bodyBackgroundColor: 'rgb(26, 26, 26)',
        documentBackgroundColor: 'rgb(26, 26, 26)'
      };
    }
  };

  const evidence = await inspectPackagedRenderer(page, {
    deadlineMs: 2_000,
    expectedRendererUrl: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    now: () => currentTime,
    getRendererErrors: () => []
  });
  assert.equal(evidence.startupSplashCount, 0);
  assert.equal(evidence.appSurfaceVisible, true);
  assert.equal(evidence.primaryControlVisible, true);
  assert.equal(Object.isFrozen(evidence), true);
});

test('packaged startup rechecks renderer errors after the explicit app-ready barrier and before success', async () => {
  const { inspectPackagedRenderer } = loadProbe();
  let readyBarrierObserved = false;
  let errorReads = 0;
  const visible = {
    async waitFor() {},
    async isVisible() { return true; },
    async count() { return 0; }
  };
  const page = {
    url: () => 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    async title() { return 'Minecraft Core'; },
    async waitForLoadState() {},
    async waitForFunction(predicate, _argument, options) {
      assert.equal(typeof predicate, 'function');
      assert.match(String(predicate), /appStartupQuiescent/);
      assert.equal(options.timeout > 0, true);
      readyBarrierObserved = true;
    },
    locator() { return visible; },
    getByRole() { return visible; },
    async evaluate() {
      return {
        bodyBackgroundColor: 'rgb(26, 26, 26)',
        documentBackgroundColor: 'rgb(26, 26, 26)'
      };
    }
  };

  await assert.rejects(inspectPackagedRenderer(page, {
    deadlineMs: Date.now() + 1_000,
    expectedRendererUrl: 'file:///C:/Apps/Minecraft%20Core/resources/app.asar/dist/index.html',
    getRendererErrors() {
      assert.equal(readyBarrierObserved, true);
      errorReads += 1;
      return errorReads === 1 ? [] : ['pageerror: late mount rejection'];
    }
  }), error => error?.code === 'PACKAGED_STARTUP_FAILED');
  assert.equal(errorReads, 2);
});
