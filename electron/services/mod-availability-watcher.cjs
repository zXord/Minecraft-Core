// Mod Availability Watcher Service
// Periodically checks Modrinth (via existing get-mod-versions logic) for mods that were
// incompatible during a version upgrade and notifies when a compatible version appears.

const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('node:crypto');
const path = require('path');
const { safeSend } = require('../utils/safe-send.cjs');
const appStore = require('../utils/app-store.cjs');
const { resolveServerLoader, normalizeLoaderName } = require('../utils/server-loader.cjs');
const {
  getCurrentServerMutationLease,
  getServerMutationCoordinator,
  markCurrentServerMutationDirty
} = require('./server-mutation-context.cjs');

let logger = null;
try {
  const { getLogger } = require('./logger-service.cjs');
  logger = getLogger();
} catch {
  // Fallback silent
}

// In-memory state
const serverWatchState = new Map(); // serverPath -> { watches: [], lastCheck, nextCheck }
let intervalHandle = null;
let intervalHours = 12; // default (user can change to 24)

function log(level, message, data) {
  if (logger && logger[level]) {
    logger[level](message, { category: 'mods', data: { service: 'mod-availability-watcher', ...data } });
  }
}

function normalizeServerPath(serverPath) {
  if (!serverPath || typeof serverPath !== 'string') {
    return '';
  }

  try {
    return path.resolve(serverPath).replace(/[\\/]+$/, '').toLowerCase();
  } catch {
    return serverPath.trim().replace(/[\\/]+$/, '').toLowerCase();
  }
}

function getTrackedServerPaths() {
  const instances = appStore.get('instances') || [];
  return instances
    .filter((instance) => instance && instance.type === 'server' && typeof instance.path === 'string' && instance.path.trim())
    .map((instance) => instance.path.trim())
    .filter((serverPath) => fs.existsSync(serverPath));
}

function pruneDetachedServerState(serverPaths) {
  const allowedPaths = new Set(serverPaths.map((serverPath) => normalizeServerPath(serverPath)));
  for (const trackedPath of [...serverWatchState.keys()]) {
    if (!allowedPaths.has(normalizeServerPath(trackedPath))) {
      serverWatchState.delete(trackedPath);
    }
  }
}

function getConfigDir(serverPath) {
  return path.join(serverPath, 'minecraft-core-configs');
}

function getWatchFile(serverPath) {
  return path.join(getConfigDir(serverPath), 'mod-availability-watches.json');
}

function getHistoryFile(serverPath) {
  return path.join(getConfigDir(serverPath), 'mod-availability-history.json');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
}

function getRegisteredServerSelector(serverPath) {
  const normalized = normalizeServerPath(serverPath);
  const instances = appStore.get('instances') || [];
  const instance = instances.find(candidate => (
    candidate &&
    candidate.type === 'server' &&
    normalizeServerPath(candidate.path) === normalized
  ));
  if (!instance) throw new Error('Server path is not a registered server instance');
  return { instanceId: instance.id || null, serverPath: instance.path };
}

async function runAvailabilityMutation(serverPath, operation, work) {
  const currentLease = getCurrentServerMutationLease();
  if (currentLease) {
    currentLease.assertOwnedPath(serverPath);
    return work();
  }

  const coordinator = getServerMutationCoordinator();
  return coordinator.runMutation(
    getRegisteredServerSelector(serverPath),
    {
      operation,
      operationId: `mod-watch-${crypto.randomUUID()}`,
      revisionMode: 'auto',
      quiesce: null
    },
    work
  );
}

async function loadWatches(serverPath) {
  const file = getWatchFile(serverPath);
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { raw = null; }
  if (!raw) {
    return { watches: [], lastCheck: null, nextCheck: null };
  }
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data.watches)) return data;
  } catch {
    // Logger service not available yet
  }
  return { watches: [], lastCheck: null, nextCheck: null };
}

async function saveWatches(serverPath, state) {
  return runAvailabilityMutation(serverPath, 'save-mod-availability-watches', async () => {
    markCurrentServerMutationDirty(serverPath);
    await ensureDir(getConfigDir(serverPath));
    const file = getWatchFile(serverPath);
    const toWrite = { watches: state.watches || [], lastCheck: state.lastCheck || null, nextCheck: state.nextCheck || null };
    await fsp.writeFile(file, JSON.stringify(toWrite, null, 2));
  });
}

async function loadHistory(serverPath) {
  const file = getHistoryFile(serverPath);
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { raw = null; }
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
  } catch {
    // Ignore malformed JSON
  }
  return [];
}

async function saveHistory(serverPath, history) {
  return runAvailabilityMutation(serverPath, 'save-mod-availability-history', async () => {
    markCurrentServerMutationDirty(serverPath);
    await ensureDir(getConfigDir(serverPath));
    const file = getHistoryFile(serverPath);
    await fsp.writeFile(file, JSON.stringify(history, null, 2));
  });
}

function makeWatchKey(w) {
  const target = w.target || {};
  const loader = target.loader || (target.fabric ? 'fabric' : '') || '';
  const loaderVersion = target.loaderVersion || target.fabric || '';
  return `${w.projectId || ''}::${target.mc || ''}::${loader}::${loaderVersion}`;
}

async function hydrateServerState(serverPath) {
  if (!serverWatchState.has(serverPath)) {
    const state = await loadWatches(serverPath);
    serverWatchState.set(serverPath, state);
  }
  return serverWatchState.get(serverPath);
}

async function addWatch({ serverPath, projectId, modName, fileName, targetMc, targetFabric, targetLoader, targetLoaderVersion }) {
  if (!serverPath || !projectId || !targetMc) throw new Error('Missing required fields');

  const { loader: detectedLoader, loaderVersion: detectedLoaderVersion } = resolveServerLoader(serverPath);
  const resolvedLoader = (targetLoader || detectedLoader || (targetFabric ? 'fabric' : null)) || null;
  const resolvedLoaderVersion = targetLoaderVersion || detectedLoaderVersion || targetFabric || null;

  const state = await hydrateServerState(serverPath);
  const key = `${projectId}::${targetMc}::${resolvedLoader || ''}::${resolvedLoaderVersion || ''}`;
  if (!state.watches.find(w => makeWatchKey(w) === key)) {
    const target = {
      mc: targetMc,
      loader: resolvedLoader,
      loaderVersion: resolvedLoaderVersion
    };
    if (resolvedLoader === 'fabric' && resolvedLoaderVersion) {
      target.fabric = resolvedLoaderVersion;
    }

    state.watches.push({
      projectId,
      modName: modName || projectId,
      fileName: fileName || null,
      target,
      addedAt: new Date().toISOString(),
      lastChecked: null
    });
    await saveWatches(serverPath, state);
  }
  return state.watches;
}

async function removeWatch({ serverPath, projectId, targetMc, targetFabric, targetLoader, targetLoaderVersion }) {
  const state = await hydrateServerState(serverPath);
  const { loader: detectedLoader, loaderVersion: detectedLoaderVersion } = resolveServerLoader(serverPath);
  const resolvedLoader = (targetLoader || detectedLoader || (targetFabric ? 'fabric' : null)) || null;
  const resolvedLoaderVersion = targetLoaderVersion || detectedLoaderVersion || targetFabric || null;
  const key = `${projectId}::${targetMc}::${resolvedLoader || ''}::${resolvedLoaderVersion || ''}`;
  const remaining = state.watches.filter(w => makeWatchKey(w) !== key);
  if (remaining.length === state.watches.length) return state.watches;
  state.watches = remaining;
  await saveWatches(serverPath, state);
  return state.watches;
}

async function clearWatches(serverPath) {
  const state = await hydrateServerState(serverPath);
  if (state.watches.length === 0) return true;
  state.watches = [];
  await saveWatches(serverPath, state);
  return true;
}

async function listWatches(serverPath) {
  const state = await hydrateServerState(serverPath);
  return state.watches;
}

async function getHistory(serverPath) {
  return loadHistory(serverPath);
}

async function clearHistory(serverPath) {
  const history = await loadHistory(serverPath);
  if (history.length === 0) return true;
  await saveHistory(serverPath, []);
  return true;
}

function scheduleNext(state) {
  const next = new Date(Date.now() + intervalHours * 60 * 60 * 1000);
  state.nextCheck = next.toISOString();
}

async function performCheck() {
  const start = Date.now();
  let totalWatches = 0;
  for (const [serverPath, state] of serverWatchState.entries()) {
    await runAvailabilityMutation(serverPath, 'check-mod-availability', async () => {
      if (!state.watches || state.watches.length === 0) {
        scheduleNext(state);
        await saveWatches(serverPath, state);
        return;
      }
      totalWatches += state.watches.length;
      state.lastCheck = new Date().toISOString();
      // Keep history publication and watch removal under one server reservation.
      const remaining = [];
      for (const watch of state.watches) {
        const fulfilled = await checkSingleWatch(serverPath, watch).catch(() => false);
        if (!fulfilled) {
          remaining.push(watch);
        }
      }
      state.watches = remaining;
      scheduleNext(state);
      await saveWatches(serverPath, state);
    });
  }
  log('debug', 'Mod availability periodic check complete', { totalWatches, durationMs: Date.now() - start });
}

async function checkSingleWatch(serverPath, watch) {
  // Reuse existing IPC handler logic indirectly by calling the mod API service directly
  try {
    const modApiService = require('./mod-api-service.cjs');
    const target = watch.target || {};
    const targetLoaderNormalized = target.loader ? normalizeLoaderName(target.loader) : (target.fabric ? 'fabric' : null);
    // Force refresh to bypass cache and detect new releases during interval checks
    const versions = await modApiService.getModrinthVersions(watch.projectId, targetLoaderNormalized, target.mc, false, true);
    if (Array.isArray(versions) && versions.length > 0) {
      // Filter for matching minecraft version and loader if specified
      const matching = versions.filter(v => {
        const supportsMinecraft = Array.isArray(v.gameVersions) && v.gameVersions.includes(target.mc);
        if (!supportsMinecraft) {
          return false;
        }

        if (!targetLoaderNormalized) {
          return true;
        }

        return Array.isArray(v.loaders) && v.loaders.some(loaderCandidate => normalizeLoaderName(loaderCandidate) === targetLoaderNormalized);
      });
      if (matching.length > 0) {
        // Sort newest by datePublished
        matching.sort((a, b) => new Date(b.datePublished).getTime() - new Date(a.datePublished).getTime());
        const latest = matching[0];
        await recordFulfilled(serverPath, watch, latest.versionNumber || latest.id || 'unknown');
        return true;
      }
    }
  } catch (err) {
    log('warn', 'Failed checking watch', { error: err.message, projectId: watch.projectId });
  }
  watch.lastChecked = new Date().toISOString();
  return false;
}

async function recordFulfilled(serverPath, watch, versionFound) {
  const history = await loadHistory(serverPath);
  history.unshift({
    projectId: watch.projectId,
    modName: watch.modName,
    target: watch.target,
    versionFound,
    foundAt: new Date().toISOString()
  });
  // Keep history capped (optional) - limit to last 200
  if (history.length > 200) history.length = 200;
  await saveHistory(serverPath, history);
  safeSend('mod-availability-notification', {
    projectId: watch.projectId,
    modName: watch.modName,
    target: watch.target,
    versionFound,
    serverPath
  });
  try {
    const settings = appStore.get('appSettings') || {};
    if (settings.modWatch?.showWindowsNotifications) {
      const { Notification } = require('electron');
      let iconPath = null;
      try {
        // Attempt to locate app icon relative to app root (packaged vs dev)
        const possible = [
          path.join(process.cwd(), 'icon.png'),
          path.join(__dirname, '..', '..', 'icon.png'),
          path.join(process.resourcesPath || '', 'icon.png')
        ];
        iconPath = possible.find(p => fs.existsSync(p));
      } catch { /* ignore icon resolution errors */ }
      new Notification({
        title: 'Mod Now Available',
        body: `${watch.modName || watch.projectId} has a compatible version (${versionFound})`,
        silent: true,
        icon: iconPath || undefined
      }).show();
    }
  } catch { /* ignore notification errors */ }
  log('info', 'Mod availability fulfilled', { projectId: watch.projectId, versionFound });
}

function startWatcher() {
  if (intervalHandle) return;
  // Attempt to hydrate watch state for currently tracked server instances.
  try {
    const settings = appStore.get('appSettings') || {};
    if (settings.modWatch && (settings.modWatch.intervalHours === 24 || settings.modWatch.intervalHours === 12)) {
      intervalHours = settings.modWatch.intervalHours;
    }
  } catch {
    // ignore settings load errors
  }
  const trackedServerPaths = getTrackedServerPaths();
  pruneDetachedServerState(trackedServerPaths);
  for (const serverPath of trackedServerPaths) {
    hydrateServerState(serverPath).then(() => {}).catch(() => {});
  }
  intervalHandle = setInterval(() => {
    performCheck().catch((error) => {
      log('warn', 'Mod availability periodic check failed', { error: error.message });
    });
  }, 5 * 60 * 1000); // Run lightweight loop every 5 min to see if a full period passed

  // Also a timer to run the heavy check only when due
  setInterval(() => {
    const now = Date.now();
    for (const [serverPath, state] of serverWatchState.entries()) {
      if (!state.nextCheck) {
        scheduleNext(state);
        saveWatches(serverPath, state).catch((error) => {
          log('warn', 'Failed to persist the next mod availability check', { error: error.message, serverPath });
        });
      } else if (new Date(state.nextCheck).getTime() <= now) {
        performCheck().catch((error) => {
          log('warn', 'Mod availability scheduled check failed', { error: error.message });
        });
        break; // performCheck iterates all; break to avoid duplicate
      }
    }
  }, 60 * 1000); // 1 min scheduler
  log('info', 'Mod availability watcher started', { intervalHours });
}

function setIntervalHours(hours) {
  if (hours !== 12 && hours !== 24) throw new Error('Interval must be 12 or 24 hours');
  intervalHours = hours;
  // Recompute nextCheck for all
  for (const state of serverWatchState.values()) {
    scheduleNext(state);
  }
  log('info', 'Mod availability interval updated', { intervalHours });
  return intervalHours;
}

function getConfig(serverPath) {
  const state = serverWatchState.get(serverPath) || { lastCheck: null, nextCheck: null };
  return { intervalHours, lastCheck: state.lastCheck || null, nextCheck: state.nextCheck || null };
}

module.exports = {
  startModAvailabilityWatcher: startWatcher,
  addModAvailabilityWatch: addWatch,
  removeModAvailabilityWatch: removeWatch,
  clearModAvailabilityWatches: clearWatches,
  listModAvailabilityWatches: listWatches,
  getModAvailabilityHistory: getHistory,
  clearModAvailabilityHistory: clearHistory,
  setModAvailabilityInterval: setIntervalHours,
  getModAvailabilityConfig: getConfig
};

// Simulation helper removed (was used only for development)
