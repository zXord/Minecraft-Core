// This baseline is JavaScript trace initialization, not OS process creation.
// Electron's cached module shares it across early entry, main and update IPC;
// the launcher is a separate process and its elapsed values are not comparable.
let defaultEnabled = false;
let defaultBaseline;
try {
  defaultEnabled = process.env.MINECRAFT_CORE_STARTUP_TRACE === '1';
  if (defaultEnabled) defaultBaseline = Number(process.hrtime.bigint()) / 1e6;
} catch {
  defaultEnabled = false;
}

const allowedMarkers = new Set([
  'launcher:entry', 'launcher:runtime-prepare:start', 'launcher:runtime-prepare:complete',
  'launcher:runtime-lease:start', 'launcher:runtime-lease:complete', 'launcher:spawn-returned',
  'early:entry', 'early:imports:complete', 'early:when-ready:start', 'early:when-ready:complete',
  'early:icon:start', 'early:icon:complete', 'early:shortcut-attempt:start', 'early:shortcut-attempt:complete',
  'early:window:create:start', 'early:window:create:complete', 'early:document:start', 'early:document:complete',
  'early:main-load:start', 'early:main-load:complete', 'early:failed',
  'main:entry',
  'main:import:path:complete', 'main:import:electron:complete', 'main:import:fs:complete',
  'main:import:runtime-flags:complete', 'main:import:packaged-smoke-guard:complete',
  'main:import:main-bootstrap:complete', 'main:import:modpack-service-graph:complete',
  'main:import:test-modpack-factory:complete', 'main:import:app-cleanup:complete',
  'main:import:safe-send:complete', 'main:import:app-store:complete', 'main:import:navigation-policy:complete',
  'main:import:runtime-paths:complete', 'main:import:tls-utils:complete', 'main:import:runtime-mode:complete',
  'main:import:renderer-loader:complete', 'main:import:asset-resolver:complete',
  'main:import:orderly-quit-barrier:complete', 'main:import:startup-window:complete',
  'main:import:startup-entry:complete', 'main:import:update-service:complete',
  'main:import:server-mutation-context:complete', 'main:import:dev-config:complete',
  'main:imports:complete', 'main:graph:start', 'main:graph:complete',
  'main:before-ready:start', 'main:before-ready:complete', 'main:ipc:start',
  'main:ipc:listeners:complete', 'main:ipc:handler-module:complete', 'main:ipc:complete',
  'update-service:get:start', 'update-service:get:complete', 'recovery:start', 'recovery:complete',
  'server-config:start', 'server-config:complete', 'cleanup:start', 'cleanup:complete',
  'main-window:create:start', 'main-window:create:complete',
  'main-window:browser-window:create:start', 'main-window:browser-window:create:complete',
  'main-window:ready-to-show', 'main-window:navigation:start', 'main-window:navigation:complete',
  'main-window:navigation:failed', 'startup-window:close', 'app:when-ready', 'startup-window:create:complete'
]);
const drop = () => false;
const monotonicNow = () => Number(process.hrtime.bigint()) / 1e6;
const utcNow = () => new Date().toISOString();

function enabledTrace(options, now, baseline) {
  if (!Number.isFinite(baseline) || baseline < 0) return drop;
  const pid = options.pid === undefined ? process.pid : options.pid;
  const wallClock = options.utcNow === undefined ? utcNow : options.utcNow;
  // Sink contract: synchronous only. No Writable/global listeners or awaits.
  const sink = options.sink === undefined
    ? line => require('node:fs').writeSync(2, line)
    : options.sink;
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof wallClock !== 'function' || typeof sink !== 'function') return drop;
  const attempted = new Set();
  return marker => {
    if (!allowedMarkers.has(marker) || attempted.has(marker)) return false;
    attempted.add(marker); // Failed attempts also count, bounding lifetime output.
    try {
      const current = now();
      if (!Number.isFinite(current) || current < baseline) return false;
      const elapsedMs = current - baseline;
      if (!Number.isFinite(elapsedMs)) return false;
      const utc = wallClock();
      if (typeof utc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(utc) || new Date(utc).toISOString() !== utc) return false;
      const result = sink('[Minecraft Core startup trace] ' + JSON.stringify({ marker, pid, utc, elapsedMs }) + '\n');
      // Defensively contain contract violations without awaiting diagnostic work.
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => {});
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };
}

function createStartupTrace(options = {}) {
  try {
    const env = options.env === undefined ? process.env : options.env;
    if (env?.MINECRAFT_CORE_STARTUP_TRACE !== '1') return drop;
    const now = options.now === undefined ? monotonicNow : options.now;
    // Capture exactly once before reading other diagnostic dependencies.
    const baseline = now();
    return enabledTrace(options, now, baseline);
  } catch {
    return drop;
  }
}

let markStartupTrace = drop;
try {
  if (defaultEnabled) markStartupTrace = enabledTrace({}, monotonicNow, defaultBaseline);
} catch {
  // Diagnostics must never prevent the application module from loading.
}

module.exports = { createStartupTrace, markStartupTrace };
