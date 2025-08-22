// Mod Availability Watcher Service
// Periodically checks Modrinth (via existing get-mod-versions logic) for mods that were
// incompatible during a version upgrade and notifies when a compatible version appears.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { safeSend } = require('../utils/safe-send.cjs');
const appStore = require('../utils/app-store.cjs');

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

async function loadWatches(serverPath) {
  await ensureDir(getConfigDir(serverPath));
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
  await ensureDir(getConfigDir(serverPath));
  const file = getWatchFile(serverPath);
  const toWrite = { watches: state.watches || [], lastCheck: state.lastCheck || null, nextCheck: state.nextCheck || null };
  await fsp.writeFile(file, JSON.stringify(toWrite, null, 2)).catch(() => {});
}

async function loadHistory(serverPath) {
  await ensureDir(getConfigDir(serverPath));
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
  await ensureDir(getConfigDir(serverPath));
  const file = getHistoryFile(serverPath);
  await fsp.writeFile(file, JSON.stringify(history, null, 2)).catch(() => {});
}

function makeWatchKey(w) {
  return `${w.projectId}::${w.target.mc}::${w.target.fabric}`;
}

async function hydrateServerState(serverPath) {
  if (!serverWatchState.has(serverPath)) {
    const state = await loadWatches(serverPath);
    serverWatchState.set(serverPath, state);
  }
  return serverWatchState.get(serverPath);
}

async function addWatch({ serverPath, projectId, modName, fileName, targetMc, targetFabric }) {
  if (!serverPath || !projectId || !targetMc || !targetFabric) throw new Error('Missing required fields');
  const state = await hydrateServerState(serverPath);
  const key = `${projectId}::${targetMc}::${targetFabric}`;
  if (!state.watches.find(w => makeWatchKey(w) === key)) {
    state.watches.push({
      projectId,
      modName: modName || projectId,
      fileName: fileName || null,
      target: { mc: targetMc, fabric: targetFabric },
      addedAt: new Date().toISOString(),
      lastChecked: null
    });
    await saveWatches(serverPath, state);
  }
  return state.watches;
}

async function removeWatch({ serverPath, projectId, targetMc, targetFabric }) {
  const state = await hydrateServerState(serverPath);
  const key = `${projectId}::${targetMc}::${targetFabric}`;
  state.watches = state.watches.filter(w => makeWatchKey(w) !== key);
  await saveWatches(serverPath, state);
  return state.watches;
}

async function clearWatches(serverPath) {
  const state = await hydrateServerState(serverPath);
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
    if (!state.watches || state.watches.length === 0) {
      scheduleNext(state);
      await saveWatches(serverPath, state);
      continue;
    }
    totalWatches += state.watches.length;
    state.lastCheck = new Date().toISOString();
    // Iterate sequentially (volume low, interval high)
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
  }
  log('debug', 'Mod availability periodic check complete', { totalWatches, durationMs: Date.now() - start });
}

async function checkSingleWatch(serverPath, watch) {
  // Reuse existing IPC handler logic indirectly by calling the mod API service directly
  try {
    const modApiService = require('./mod-api-service.cjs');
  const versions = await modApiService.getModrinthVersions(watch.projectId, 'fabric', watch.target.mc, false);
    if (Array.isArray(versions) && versions.length > 0) {
      // Filter for matching mc + fabric loader
      const matching = versions.filter(v => Array.isArray(v.gameVersions) && v.gameVersions.includes(watch.target.mc) && Array.isArray(v.loaders) && v.loaders.includes('fabric'));
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
  // Attempt to hydrate last server path watches (best-effort)
  try {
    const settings = appStore.get('appSettings') || {};
    if (settings.modWatch && (settings.modWatch.intervalHours === 24 || settings.modWatch.intervalHours === 12)) {
      intervalHours = settings.modWatch.intervalHours;
    }
  } catch {
    // ignore settings load errors
  }
  const lastServerPath = appStore.get('lastServerPath');
  if (lastServerPath && fs.existsSync(lastServerPath)) {
    hydrateServerState(lastServerPath).then(() => {}).catch(() => {});
  }
  intervalHandle = setInterval(() => {
    performCheck();
  }, 5 * 60 * 1000); // Run lightweight loop every 5 min to see if a full period passed

  // Also a timer to run the heavy check only when due
  setInterval(() => {
    const now = Date.now();
    for (const [serverPath, state] of serverWatchState.entries()) {
      if (!state.nextCheck) {
        scheduleNext(state);
        saveWatches(serverPath, state);
      } else if (new Date(state.nextCheck).getTime() <= now) {
        performCheck();
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
