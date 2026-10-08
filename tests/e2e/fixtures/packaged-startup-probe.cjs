const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fileURLToPath, pathToFileURL } = require('node:url');

const execFileAsync = promisify(execFile);

function packagedStartupFailure(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'PACKAGED_STARTUP_FAILED';
  return error;
}

function preservePackagedSmokeRoot(error) {
  Object.defineProperty(error, 'preservePackagedSmokeRoot', {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false
  });
  return error;
}

function isPackagedMainWindowUrl(value, expectedRendererUrl = null) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:' || parsed.hostname || parsed.search || parsed.hash) return false;
    const pathname = decodeURIComponent(parsed.pathname).replaceAll('\\', '/').toLocaleLowerCase('en-US');
    if (!pathname.endsWith('/resources/app.asar/dist/index.html')) return false;
    if (expectedRendererUrl === null) return true;
    const expected = new URL(expectedRendererUrl);
    if (expected.protocol !== 'file:' || expected.hostname || expected.search || expected.hash) return false;
    return path.resolve(fileURLToPath(parsed)).toLocaleLowerCase('en-US') ===
      path.resolve(fileURLToPath(expected)).toLocaleLowerCase('en-US');
  } catch {
    return false;
  }
}

function resolveExpectedPackagedRendererUrl(executablePath) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new TypeError('Packaged executable path is invalid');
  }
  return pathToFileURL(path.join(path.dirname(path.resolve(executablePath)), 'resources', 'app.asar', 'dist', 'index.html')).href;
}

function createPackagedRendererErrorCollector(electronApp) {
  if (!electronApp || typeof electronApp.on !== 'function' || typeof electronApp.off !== 'function' ||
      typeof electronApp.windows !== 'function') {
    throw new TypeError('Electron application cannot report renderer errors');
  }
  const errors = [];
  const observed = new Map();
  const record = (kind, value) => {
    if (errors.length >= 50) return;
    const message = String(value || 'unknown renderer failure').replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
    errors.push(`${kind}: ${message || 'unknown renderer failure'}`);
  };
  const observe = page => {
    if (!page || observed.has(page) || typeof page.on !== 'function' || typeof page.off !== 'function') return;
    const handlers = {
      pageerror: error => record('pageerror', error?.message),
      console: message => {
        if (message?.type?.() === 'error') record('console', message.text?.());
      },
      crash: () => record('crash', 'renderer process crashed'),
      requestfailed: request => {
        let requestUrl = '';
        try { requestUrl = request?.url?.() || ''; } catch { requestUrl = ''; }
        if (!requestUrl.startsWith('file:')) return;
        let failure = null;
        try { failure = request?.failure?.(); } catch { failure = null; }
        record('requestfailed', failure?.errorText);
      }
    };
    for (const [event, handler] of Object.entries(handlers)) page.on(event, handler);
    observed.set(page, handlers);
  };
  const onWindow = page => observe(page);
  electronApp.on('window', onWindow);
  for (const page of electronApp.windows()) observe(page);
  return Object.freeze({
    get errors() { return [...errors]; },
    observe,
    dispose() {
      electronApp.off('window', onWindow);
      for (const [page, handlers] of observed) {
        for (const [event, handler] of Object.entries(handlers)) page.off(event, handler);
      }
      observed.clear();
    }
  });
}

async function waitForPackagedMainWindow(electronApp, {
  deadlineMs,
  expectedRendererUrl,
  pollIntervalMs = 25,
  now = Date.now,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
  if (!electronApp || typeof electronApp.windows !== 'function' || typeof now !== 'function' || typeof wait !== 'function' ||
      !Number.isFinite(deadlineMs) || deadlineMs <= now() ||
      typeof expectedRendererUrl !== 'string' || !isPackagedMainWindowUrl(expectedRendererUrl, expectedRendererUrl) ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new TypeError('Packaged startup window selector input is invalid');
  }
  const deadline = Math.floor(deadlineMs);
  while (now() < deadline) {
    const windows = electronApp.windows();
    if (!Array.isArray(windows)) throw new TypeError('Electron application windows are unavailable');
    const mainWindow = windows.find(page => {
      try {
        return page && typeof page.url === 'function' && isPackagedMainWindowUrl(page.url(), expectedRendererUrl);
      } catch {
        return false;
      }
    });
    if (mainWindow) return mainWindow;
    await wait(Math.min(Math.floor(pollIntervalMs), Math.max(1, deadline - now())));
  }
  throw packagedStartupFailure('Packaged application did not open its dist renderer window');
}

function validatePackagedRendererSnapshot(snapshot, { expectedRendererUrl = null } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.startupSplashCount !== 0) {
    throw packagedStartupFailure('Packaged renderer did not replace its static startup splash');
  }
  if (!isPackagedMainWindowUrl(snapshot.url, expectedRendererUrl) || snapshot.title !== 'Minecraft Core') {
    throw packagedStartupFailure('Packaged renderer identity is invalid');
  }
  const white = /rgba?\(\s*255\s*,\s*255\s*,\s*255(?:\s*,\s*1(?:\.0+)?)?\s*\)/iu;
  const transparent = /^(?:transparent|rgba\([^)]*,\s*0(?:\.0+)?\s*\))$/iu;
  if (typeof snapshot.bodyBackgroundColor !== 'string' || white.test(snapshot.bodyBackgroundColor) || transparent.test(snapshot.bodyBackgroundColor) ||
      typeof snapshot.documentBackgroundColor !== 'string' || white.test(snapshot.documentBackgroundColor)) {
    throw packagedStartupFailure('Packaged renderer displayed a white background');
  }
  if (!Array.isArray(snapshot.rendererErrors) || snapshot.rendererErrors.length !== 0) {
    throw packagedStartupFailure('Packaged renderer reported an error while mounting');
  }
  if (snapshot.appSurfaceVisible !== true || snapshot.primaryControlVisible !== true) {
    throw packagedStartupFailure('Packaged renderer did not expose its clean-profile application surface');
  }
  return Object.freeze({ ...snapshot });
}

async function inspectPackagedRenderer(page, {
  deadlineMs,
  expectedRendererUrl,
  now = Date.now,
  getRendererErrors = () => []
} = {}) {
  if (!page || typeof page.url !== 'function' || typeof page.title !== 'function' ||
      typeof page.waitForLoadState !== 'function' || typeof page.locator !== 'function' ||
      typeof page.getByRole !== 'function' || typeof page.evaluate !== 'function' ||
      typeof page.waitForFunction !== 'function' || typeof now !== 'function' ||
      !Number.isFinite(deadlineMs) || typeof expectedRendererUrl !== 'string' ||
      !isPackagedMainWindowUrl(expectedRendererUrl, expectedRendererUrl) || typeof getRendererErrors !== 'function') {
    throw new TypeError('Packaged renderer inspection input is invalid');
  }
  const remaining = () => {
    const milliseconds = Math.floor(deadlineMs - now());
    if (milliseconds <= 0) throw packagedStartupFailure('Packaged renderer startup deadline expired');
    return milliseconds;
  };
  const splash = page.locator('#startup-splash');
  const appSurface = page.locator('main.app-container');
  // The visible plus icon is part of the button's accessible name in Chromium.
  // Match the stable action suffix so both "+ Create…" and plain text remain valid.
  const primaryControl = page.getByRole('button', { name: /Create Your First Instance$/u });

  await page.waitForLoadState('domcontentloaded', { timeout: remaining() });
  await splash.waitFor({ state: 'detached', timeout: remaining() });
  await appSurface.waitFor({ state: 'visible', timeout: remaining() });
  await primaryControl.waitFor({ state: 'visible', timeout: remaining() });
  await page.waitForFunction(() => window.appStartupCompleted === true && window.appStartupQuiescent === true, null, { timeout: remaining() });
  if (getRendererErrors().length !== 0) {
    throw packagedStartupFailure('Packaged renderer reported an error after its app-ready barrier');
  }
  await new Promise(resolve => setImmediate(resolve));

  const colors = await page.evaluate(() => ({
    bodyBackgroundColor: getComputedStyle(document.body).backgroundColor,
    documentBackgroundColor: getComputedStyle(document.documentElement).backgroundColor
  }));
  remaining();
  const finalRendererErrors = getRendererErrors();
  return validatePackagedRendererSnapshot({
    url: page.url(),
    title: await page.title(),
    startupSplashCount: await splash.count(),
    appSurfaceVisible: await appSurface.isVisible(),
    primaryControlVisible: await primaryControl.isVisible(),
    bodyBackgroundColor: colors?.bodyBackgroundColor,
    documentBackgroundColor: colors?.documentBackgroundColor,
    rendererErrors: finalRendererErrors
  }, { expectedRendererUrl });
}

async function readWindowsProcessInventory() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) {
    throw packagedStartupFailure('Windows process inventory is unavailable');
  }
  const powerShell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    created = if ($null -eq $_.CreationDate) { '' } else { $_.CreationDate.ToUniversalTime().ToString('O') }
  }
})
[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress))
`;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(powerShell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    throw packagedStartupFailure('Windows process inventory failed', error);
  }
  let rows;
  try { rows = JSON.parse(stdout); } catch (error) { throw packagedStartupFailure('Windows process inventory was invalid', error); }
  if (!Array.isArray(rows)) throw packagedStartupFailure('Windows process inventory was invalid');
  return rows.map(row => ({
    pid: Number(row?.pid),
    parentPid: Number(row?.parentPid),
    created: String(row?.created || '')
  })).filter(row => Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 && row.created);
}

async function captureWindowsProcessTree(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) throw new TypeError('Packaged process id is invalid');
  const rows = await readWindowsProcessInventory();
  const root = rows.find(row => row.pid === rootPid);
  if (!root) throw packagedStartupFailure('Launched packaged process is absent from the Windows process inventory');
  const captured = [{ ...root, depth: 0 }];
  const known = new Set([rootPid]);
  for (let depth = 1; depth <= rows.length; depth += 1) {
    const additions = rows.filter(row => !known.has(row.pid) && known.has(row.parentPid));
    if (additions.length === 0) break;
    for (const row of additions) {
      known.add(row.pid);
      captured.push({ ...row, depth });
    }
  }
  return captured;
}

function matchingWindowsProcesses(captured, inventory) {
  const current = new Map(inventory.map(row => [row.pid, row.created]));
  return captured.filter(row => current.get(row.pid) === row.created);
}

async function waitForWindowsProcessTreeExit(captured, { timeoutMs, pollIntervalMs = 50 } = {}) {
  const deadline = Date.now() + Math.floor(timeoutMs);
  while (Date.now() < deadline) {
    if (matchingWindowsProcesses(captured, await readWindowsProcessInventory()).length === 0) return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
  return matchingWindowsProcesses(captured, await readWindowsProcessInventory()).length === 0;
}

async function closePackagedElectronApp(electronApp, { timeoutMs = 15_000, forceExitTimeoutMs = 5_000 } = {}) {
  if (!electronApp || typeof electronApp.close !== 'function' || typeof electronApp.process !== 'function' ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(forceExitTimeoutMs) || forceExitTimeoutMs <= 0) {
    throw new TypeError('Packaged application cleanup input is invalid');
  }
  const child = electronApp.process();
  if (!child || typeof child.once !== 'function') throw new TypeError('Packaged application process is unavailable');
  let trackedWindowsTree = null;
  let treeCaptureFailure = null;
  if (process.platform === 'win32') {
    try { trackedWindowsTree = await captureWindowsProcessTree(child.pid); }
    catch (error) { treeCaptureFailure = error; }
  }

  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
  const within = (promise, durationMs, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(packagedStartupFailure(message)), Math.floor(durationMs));
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
  let cleanupFailure = null;
  try {
    await within(Promise.resolve().then(() => electronApp.close()), timeoutMs, 'Packaged application close request timed out');
    await within(exited, timeoutMs, 'Packaged application did not exit during cleanup');
    if (trackedWindowsTree && !await waitForWindowsProcessTreeExit(trackedWindowsTree, { timeoutMs })) {
      throw packagedStartupFailure('Packaged application process tree remained active after cleanup');
    }
    if (treeCaptureFailure) {
      throw packagedStartupFailure('Packaged application process tree could not be captured for cleanup verification', treeCaptureFailure);
    }
  } catch (error) {
    cleanupFailure = error?.code === 'PACKAGED_STARTUP_FAILED'
      ? error
      : packagedStartupFailure('Packaged application cleanup failed', error);
  }
  if (cleanupFailure) {
    try {
      if (trackedWindowsTree) {
        // child.kill uses the held ChildProcess handle, so PID reuse cannot redirect
        // cleanup at an unrelated process. Descendants are observed but never killed
        // by a later PID lookup; a leaked descendant fails the smoke explicitly.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (!await waitForWindowsProcessTreeExit(trackedWindowsTree, { timeoutMs: forceExitTimeoutMs })) {
          throw packagedStartupFailure('Packaged application leaked a descendant after identity-safe forced cleanup');
        }
      } else if (process.platform === 'win32') {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await within(exited, forceExitTimeoutMs, 'Packaged application remained active after forced cleanup');
        throw packagedStartupFailure('Packaged application process-tree exit could not be proven', treeCaptureFailure);
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await within(exited, forceExitTimeoutMs, 'Packaged application remained active after forced cleanup');
      }
    } catch (error) {
      throw preservePackagedSmokeRoot(packagedStartupFailure('Packaged application could not be force-closed', error));
    }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (child.exitCode === null && child.signalCode === null) {
    throw packagedStartupFailure('Packaged application process remained active after cleanup');
  }
  return Object.freeze({ processExited: true });
}

module.exports = {
  closePackagedElectronApp,
  createPackagedRendererErrorCollector,
  inspectPackagedRenderer,
  isPackagedMainWindowUrl,
  resolveExpectedPackagedRendererUrl,
  validatePackagedRendererSnapshot,
  waitForPackagedMainWindow
};
