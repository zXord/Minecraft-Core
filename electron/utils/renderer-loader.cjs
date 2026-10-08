const DEV_SERVER_URL = 'http://127.0.0.1:5173';
const DEFAULT_ATTEMPT_TIMEOUTS_MS = Object.freeze([45_000, 10_000]);
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000;

function resolveDevelopmentServerUrl(candidate = DEV_SERVER_URL) {
  if (candidate === undefined || candidate === null || candidate === '') return DEV_SERVER_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError('Development server URL must be an exact IPv4 loopback HTTP origin');
  }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Development server URL must be an exact IPv4 loopback HTTP origin');
  }
  return `http://127.0.0.1:${port}`;
}

function createDevelopmentPageHtml({ title, message }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
      body { display: grid; place-items: center; min-height: 100vh; margin: 0; }
      main { max-width: 38rem; padding: 2rem; border: 1px solid #334155; border-radius: 0.75rem; background: #111827; box-shadow: 0 20px 50px #0008; }
      h1 { margin-top: 0; font-size: 1.5rem; }
      code { padding: 0.15rem 0.35rem; border-radius: 0.25rem; background: #1e293b; color: #f8fafc; }
      p { line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      ${message}
    </main>
  </body>
</html>`;
}

function createDevelopmentDiagnosticHtml(devServerUrl = DEV_SERVER_URL) {
  return createDevelopmentPageHtml({
    title: 'Development server unavailable',
    message: `<p>Minecraft Core could not reach the Vite development server at <code>${devServerUrl}</code>.</p>
      <p>Start or restart <code>npm run dev</code>, then check the terminal for Vite errors.</p>`
  });
}

function createDevelopmentSplashHtml() {
  return createDevelopmentPageHtml({
    title: 'Starting Minecraft Core…',
    message: '<p>Waiting for the development server…</p>'
  });
}

function createDevelopmentDiagnosticUrl(devServerUrl = DEV_SERVER_URL) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(createDevelopmentDiagnosticHtml(devServerUrl))}`;
}

function createDevelopmentSplashUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(createDevelopmentSplashHtml())}`;
}

function waitForNavigation(load, { timeoutMs, setTimeoutFn, clearTimeoutFn, stop }) {
  let navigation;
  try {
    navigation = Promise.resolve(load());
  } catch (error) {
    navigation = Promise.reject(error);
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timeoutId);
      resolve(result);
    };
    const timeoutId = setTimeoutFn(() => {
      try {
        stop?.();
      } catch {
        // A destroyed webContents cannot be stopped; the failed attempt still ends here.
      }
      finish({ status: 'timeout' });
    }, timeoutMs);

    navigation.then(
      () => finish({ status: 'loaded' }),
      error => finish({ status: 'error', error })
    );
  });
}

async function defaultDevelopmentServerProbe(url, { signal } = {}) {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    cache: 'no-store',
    signal
  });
  try {
    return response.status >= 200 && response.status < 400;
  } finally {
    await response.body?.cancel?.().catch(() => {});
  }
}

function waitForProbe(probe, url, { timeoutMs, setTimeoutFn, clearTimeoutFn }) {
  const controller = new AbortController();
  let probeResult;
  try {
    probeResult = Promise.resolve(probe(url, { signal: controller.signal }));
  } catch (error) {
    probeResult = Promise.reject(error);
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timeoutId);
      resolve(result);
    };
    const timeoutId = setTimeoutFn(() => {
      controller.abort();
      finish({ status: 'timeout' });
    }, timeoutMs);
    probeResult.then(
      ready => finish({ status: ready ? 'ready' : 'not-ready' }),
      error => finish({ status: 'error', error })
    );
  });
}

function defaultWait(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

function positiveDuration(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function retryDelay(failedAttempts, initialDelayMs, maxDelayMs) {
  const exponent = Math.max(0, Math.min(30, failedAttempts - 1));
  return Math.min(maxDelayMs, initialDelayMs * (2 ** exponent));
}

async function loadDevelopmentRenderer({
  window,
  devServerUrl = DEV_SERVER_URL,
  maxAttempts,
  attemptTimeoutMs,
  attemptTimeoutsMs = DEFAULT_ATTEMPT_TIMEOUTS_MS,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  retryDelayMs,
  initialRetryDelayMs = retryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS,
  maxRetryDelayMs = retryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
  wait = defaultWait,
  now = Date.now,
  probe = defaultDevelopmentServerProbe,
  setTimeout: setTimeoutFn = setTimeout,
  clearTimeout: clearTimeoutFn = clearTimeout,
  onRendererReady
}) {
  devServerUrl = resolveDevelopmentServerUrl(devServerUrl);
  const configuredTimeouts = Array.isArray(attemptTimeoutsMs) && attemptTimeoutsMs.length > 0
    ? attemptTimeoutsMs
    : DEFAULT_ATTEMPT_TIMEOUTS_MS;
  const attemptLimit = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : Number.POSITIVE_INFINITY;
  const startupDeadlineMs = positiveDuration(startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const firstRetryDelayMs = positiveDuration(initialRetryDelayMs, DEFAULT_INITIAL_RETRY_DELAY_MS);
  const retryDelayLimitMs = Math.max(firstRetryDelayMs, positiveDuration(maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS));
  const startedAt = now();
  let attempts = 0;
  let finalFailure = 'error';

  await window.loadURL(createDevelopmentSplashUrl());

  while (attempts < attemptLimit) {
    const remainingMs = startupDeadlineMs - Math.max(0, now() - startedAt);
    if (remainingMs <= 0) break;
    attempts += 1;
    const configuredAttemptTimeoutMs = Number.isFinite(attemptTimeoutMs)
      ? attemptTimeoutMs
      : configuredTimeouts[Math.min(attempts - 1, configuredTimeouts.length - 1)];
    const cycleTimeoutMs = Math.min(positiveDuration(configuredAttemptTimeoutMs, remainingMs), remainingMs);
    const probeResult = await waitForProbe(probe, devServerUrl, {
      timeoutMs: cycleTimeoutMs,
      setTimeoutFn,
      clearTimeoutFn
    });

    if (probeResult.status === 'ready') {
      const remainingForNavigationMs = startupDeadlineMs - Math.max(0, now() - startedAt);
      if (remainingForNavigationMs <= 0) break;
      const navigationResult = await waitForNavigation(
        () => window.loadURL(devServerUrl),
        {
          timeoutMs: Math.min(cycleTimeoutMs, remainingForNavigationMs),
          setTimeoutFn,
          clearTimeoutFn,
          stop: () => window.webContents?.stop?.()
        }
      );
      if (navigationResult.status === 'loaded') {
        const outcome = { mode: 'development', status: 'loaded', attempts, url: devServerUrl };
        await onRendererReady?.(outcome);
        return outcome;
      }
      finalFailure = navigationResult.status;
      const remainingAfterNavigationMs = startupDeadlineMs - Math.max(0, now() - startedAt);
      if (attempts < attemptLimit && remainingAfterNavigationMs > 0) {
        await window.loadURL(createDevelopmentSplashUrl());
      }
    } else {
      finalFailure = probeResult.status;
    }
    if (attempts >= attemptLimit) break;
    const remainingAfterAttemptMs = startupDeadlineMs - Math.max(0, now() - startedAt);
    if (remainingAfterAttemptMs <= 0) break;
    await wait(Math.min(
      retryDelay(attempts, firstRetryDelayMs, retryDelayLimitMs),
      remainingAfterAttemptMs
    ));
  }

  await window.loadURL(createDevelopmentDiagnosticUrl(devServerUrl));
  return {
    mode: 'development',
    status: 'diagnostic',
    attempts,
    url: devServerUrl,
    failure: finalFailure
  };
}

async function loadRendererContent({ isDevelopment, window, distPath, onRendererReady, ...options }) {
  if (isDevelopment) return loadDevelopmentRenderer({ window, onRendererReady, ...options });
  await window.loadFile(distPath);
  const outcome = { mode: 'production', status: 'loaded', path: distPath };
  await onRendererReady?.(outcome);
  return outcome;
}

module.exports = {
  DEV_SERVER_URL,
  createDevelopmentDiagnosticHtml,
  createDevelopmentDiagnosticUrl,
  createDevelopmentSplashHtml,
  createDevelopmentSplashUrl,
  loadRendererContent,
  resolveDevelopmentServerUrl
};
