const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const {
  DEV_SERVER_URL,
  loadRendererContent,
  resolveDevelopmentServerUrl
} = require('../electron/utils/renderer-loader.cjs');

function createWindow({ loadUrlResults = [], loadUrl } = {}) {
  const calls = [];
  let urlAttempt = 0;
  return {
    calls,
    webContents: {
      stop() {
        calls.push({ type: 'stop' });
      }
    },
    loadURL(url) {
      calls.push({ type: 'loadURL', url });
      if (typeof loadUrl === 'function') return loadUrl(url, urlAttempt++);
      const result = loadUrlResults[urlAttempt++];
      return typeof result === 'function' ? result() : result;
    },
    loadFile(filePath) {
      calls.push({ type: 'loadFile', filePath });
      return Promise.resolve();
    }
  };
}

function waitForChildMessage(child) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      child.off('message', onMessage);
      reject(error);
    };
    const onExit = code => {
      child.off('message', onMessage);
      reject(new Error(`Delayed development server exited before listening (${code})`));
    };
    const onMessage = message => {
      child.off('error', onError);
      child.off('exit', onExit);
      resolve(message);
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('message', onMessage);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.send?.({ type: 'close' });
  const timer = setTimeout(() => child.kill(), 2_000);
  timer.unref?.();
  await exited;
  clearTimeout(timer);
}

function spawnDelayedDevelopmentServer(delayMs) {
  const source = `
    const http = require('node:http');
    let ready = false;
    const server = http.createServer((_request, response) => {
      if (!ready) {
        response.writeHead(503, { 'content-type': 'text/plain' });
        response.end('warming');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>ready</title>');
    });
    server.listen(0, '127.0.0.1', () => {
      process.send({ port: server.address().port });
      setTimeout(() => { ready = true; }, Number(process.env.DELAY_MS));
    });
    process.on('message', message => {
      if (message?.type !== 'close') return;
      server.close(() => process.exit(0));
    });
  `;
  return spawn(process.execPath, ['-e', source], {
    env: { ...process.env, DELAY_MS: String(delayMs) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });
}

test('development server override accepts only an exact IPv4 loopback HTTP origin', () => {
  assert.equal(resolveDevelopmentServerUrl('http://127.0.0.1:43891/'), 'http://127.0.0.1:43891');
  for (const candidate of [
    'https://127.0.0.1:43891',
    'http://localhost:43891',
    'http://127.0.0.1:43891/renderer',
    'http://127.0.0.1:43891/?redirect=https://example.com',
    'http://example.com:43891'
  ]) {
    assert.throws(
      () => resolveDevelopmentServerUrl(candidate),
      /exact IPv4 loopback HTTP origin/u
    );
  }
});

test('development keeps retrying connection-refused navigation until a 25-second cold Vite startup becomes ready', async () => {
  let elapsedMs = 0;
  let probeAttempts = 0;
  const win = createWindow({
    loadUrl(url) {
      return Promise.resolve();
    }
  });

  const outcome = await loadRendererContent({
    isDevelopment: true,
    window: win,
    startupTimeoutMs: 30_000,
    attemptTimeoutMs: 1_000,
    initialRetryDelayMs: 1_000,
    maxRetryDelayMs: 1_000,
    now: () => elapsedMs,
    wait: async delayMs => { elapsedMs += delayMs; },
    async probe() {
      probeAttempts += 1;
      if (elapsedMs < 25_000) throw new Error('ERR_CONNECTION_REFUSED');
      return true;
    }
  });

  assert.deepEqual(outcome, {
    mode: 'development',
    status: 'loaded',
    attempts: 26,
    url: DEV_SERVER_URL
  });
  assert.equal(probeAttempts, 26);
  assert.equal(elapsedMs, 25_000);
  assert.equal(win.calls.filter(call => call.url === DEV_SERVER_URL).length, 1);
  assert.equal(win.calls.some(call => call.url.includes('Development%20server%20unavailable')), false);
});

test('development splash survives a delayed spawned server on an OS-assigned port and opens it when ready', async t => {
  const child = spawnDelayedDevelopmentServer(350);
  t.after(() => stopChild(child));
  const { port } = await waitForChildMessage(child);
  const devServerUrl = `http://127.0.0.1:${port}`;
  const win = createWindow({
    async loadUrl(url) {
      if (url.startsWith('data:')) return;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }
  });

  const outcome = await loadRendererContent({
    isDevelopment: true,
    window: win,
    devServerUrl,
    startupTimeoutMs: 5_000,
    attemptTimeoutMs: 500,
    initialRetryDelayMs: 25,
    maxRetryDelayMs: 100
  });

  assert.equal(outcome.status, 'loaded');
  assert.equal(outcome.url, devServerUrl);
  assert.ok(outcome.attempts > 1);
  assert.match(win.calls[0].url, /^data:text\/html;charset=utf-8,/u);
  assert.equal(win.calls.at(-1).url, devServerUrl);
});

test('development retries the fixed IPv4 URL after a transient failure without loading a file', async () => {
  const win = createWindow({
    loadUrlResults: [Promise.resolve(), Promise.reject(new Error('ERR_FAILED')), Promise.resolve(), Promise.resolve()]
  });

  const outcome = await loadRendererContent({
    isDevelopment: true,
    window: win,
    distPath: 'stale-dist/index.html',
    maxAttempts: 2,
    retryDelayMs: 1,
    wait: async () => {},
    probe: async () => true
  });

  assert.deepEqual(outcome, {
    mode: 'development',
    status: 'loaded',
    attempts: 2,
    url: 'http://127.0.0.1:5173'
  });
  assert.match(win.calls[0].url, /^data:text\/html;charset=utf-8,/u);
  assert.deepEqual(win.calls.slice(1), [
    { type: 'loadURL', url: DEV_SERVER_URL },
    { type: 'loadURL', url: win.calls[0].url },
    { type: 'loadURL', url: DEV_SERVER_URL }
  ]);
});

test('development loads a dark local splash before it starts navigating to Vite', async () => {
  const win = createWindow({ loadUrlResults: [Promise.resolve(), Promise.resolve()] });

  await loadRendererContent({ isDevelopment: true, window: win, maxAttempts: 1, probe: async () => true });

  assert.match(win.calls[0].url, /^data:text\/html;charset=utf-8,/u);
  const splashHtml = decodeURIComponent(win.calls[0].url.split(',')[1]);
  assert.match(splashHtml, /<title>Starting Minecraft Core…<\/title>/u);
  assert.match(splashHtml, /Starting Minecraft Core/u);
  assert.match(splashHtml, /Waiting for the development server/u);
  assert.match(splashHtml, /http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/u);
  assert.equal(win.calls[1].url, DEV_SERVER_URL);
});

test('development invokes renderer-dependent startup only after the Vite renderer succeeds', async () => {
  const win = createWindow({ loadUrlResults: [Promise.resolve(), Promise.resolve()] });
  const startupSnapshots = [];

  await loadRendererContent({
    isDevelopment: true,
    window: win,
    maxAttempts: 1,
    probe: async () => true,
    onRendererReady() {
      startupSnapshots.push(win.calls.map(call => call.url));
    }
  });

  assert.deepEqual(startupSnapshots, [[win.calls[0].url, DEV_SERVER_URL]]);
});

test('development permits the cold compile timeout before its shorter final retry', async () => {
  const timeoutDelays = [];
  const win = createWindow({
    loadUrlResults: [Promise.resolve(), Promise.resolve()]
  });

  const outcome = await loadRendererContent({
    isDevelopment: true,
    window: win,
    maxAttempts: 2,
    wait: async () => {},
    probe: async () => { throw new Error('ERR_CONNECTION_REFUSED'); },
    setTimeout(callback, delayMs) {
      timeoutDelays.push(delayMs);
      return timeoutDelays.length;
    },
    clearTimeout() {}
  });

  assert.equal(outcome.status, 'diagnostic');
  assert.deepEqual(timeoutDelays, [45_000, 10_000]);
});

test('development shows a local diagnostic after permanent failure instead of loading stale dist output', async () => {
  let rendererReadyCalls = 0;
  const win = createWindow({
    loadUrlResults: [Promise.resolve(), Promise.resolve()]
  });

  const outcome = await loadRendererContent({
    isDevelopment: true,
    window: win,
    distPath: 'stale-dist/index.html',
    maxAttempts: 1,
    probe: async () => false,
    onRendererReady() {
      rendererReadyCalls += 1;
    }
  });

  assert.deepEqual(outcome, {
    mode: 'development',
    status: 'diagnostic',
    attempts: 1,
    url: 'http://127.0.0.1:5173',
    failure: 'not-ready'
  });
  assert.equal(win.calls.some(call => call.type === 'loadFile'), false);
  assert.equal(rendererReadyCalls, 0);
  assert.match(win.calls[1].url, /^data:text\/html;charset=utf-8,/u);
  const diagnosticHtml = decodeURIComponent(win.calls[1].url.split(',')[1]);
  assert.match(diagnosticHtml, /Development server unavailable/u);
  assert.match(diagnosticHtml, /npm run dev/u);
  assert.match(diagnosticHtml, /http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/u);
});

test('development cancels a timed out renderer navigation before showing the diagnostic', async () => {
  const pendingTimers = new Map();
  let nextTimerId = 0;
  const win = createWindow({
    loadUrlResults: [Promise.resolve(), new Promise(() => {}), Promise.resolve()]
  });

  const outcomePromise = loadRendererContent({
    isDevelopment: true,
    window: win,
    maxAttempts: 1,
    attemptTimeoutMs: 1,
    probe: async () => true,
    setTimeout(callback) {
      const timerId = ++nextTimerId;
      pendingTimers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(timerId) {
      pendingTimers.delete(timerId);
    }
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pendingTimers.size, 1);
  [...pendingTimers.values()][0]();

  const outcome = await outcomePromise;

  assert.equal(outcome.status, 'diagnostic');
  assert.equal(outcome.failure, 'timeout');
  assert.deepEqual(win.calls.map(call => call.type), ['loadURL', 'loadURL', 'stop', 'loadURL']);
});

test('production loads the packaged renderer file directly', async () => {
  const win = createWindow();

  const outcome = await loadRendererContent({
    isDevelopment: false,
    window: win,
    distPath: 'dist/index.html'
  });

  assert.deepEqual(outcome, {
    mode: 'production',
    status: 'loaded',
    path: 'dist/index.html'
  });
  assert.deepEqual(win.calls, [{ type: 'loadFile', filePath: 'dist/index.html' }]);
});
