import { writable } from 'svelte/store';
import { safeInvoke } from '../utils/ipcUtils.js';

function normalizeTarget(target = {}) {
  /** @type {Record<string, any>} */
  const normalized = { ...target };
  normalized.mc = normalized.mc || null;
  const loader = normalized.loader || (normalized.fabric ? 'fabric' : null) || null;
  const loaderVersion = normalized.loaderVersion || normalized.fabric || null;
  normalized.loader = loader;
  normalized.loaderVersion = loaderVersion;
  if (loader === 'fabric') {
    normalized.fabric = normalized.fabric || loaderVersion || null;
  } else if ('fabric' in normalized) {
    delete normalized.fabric;
  }
  return normalized;
}

function buildWatchKey(entry) {
  const target = normalizeTarget(entry?.target);
  const projectId = entry?.projectId || '';
  return `${projectId}::${target.mc || ''}::${target.loader || ''}::${target.loaderVersion || ''}`;
}

function createModAvailabilityWatchStore() {
  const { subscribe, update } = writable({ watches: [], history: [], config: { intervalHours: 12, lastCheck: null, nextCheck: null }, loaded: false, error: null, notifications: [] });

  async function refresh(serverPath) {
    try {
      const [watchesRaw, historyRaw, config] = await Promise.all([
        safeInvoke('mod-watch:list', serverPath),
        safeInvoke('mod-watch:history', serverPath),
        safeInvoke('mod-watch:config', serverPath)
      ]);
      const watches = (watchesRaw || []).map((entry) => {
        const target = normalizeTarget(entry?.target);
        return { ...entry, target, key: buildWatchKey({ ...entry, target }) };
      });
      const history = (historyRaw || []).map((entry) => {
        const target = normalizeTarget(entry?.target);
        return { ...entry, target, key: buildWatchKey({ ...entry, target }) };
      });
      update(s => ({ ...s, watches, history, config: config || {}, loaded: true, error: null }));
    } catch (e) {
      update(s => ({ ...s, error: e.message }));
    }
  }

  async function add(serverPath, mod) {
    await safeInvoke('mod-watch:add', {
      serverPath,
      projectId: mod.projectId,
      modName: mod.name,
      fileName: mod.fileName,
      targetMc: mod.targetMc,
      targetFabric: mod.targetFabric,
      targetLoader: mod.targetLoader,
      targetLoaderVersion: mod.targetLoaderVersion
    });
    await refresh(serverPath);
  }

  async function remove(serverPath, entry) {
    const target = normalizeTarget(entry?.target);
    await safeInvoke('mod-watch:remove', {
      serverPath,
      projectId: entry.projectId,
      targetMc: target.mc,
      targetFabric: target.fabric,
      targetLoader: target.loader,
      targetLoaderVersion: target.loaderVersion
    });
    await refresh(serverPath);
  }

  async function clear(serverPath) {
    await safeInvoke('mod-watch:clear', serverPath);
    await refresh(serverPath);
  }

  async function clearHistory(serverPath) {
    await safeInvoke('mod-watch:history:clear', serverPath);
    await refresh(serverPath);
  }

  async function setIntervalHours(hours) {
    await safeInvoke('mod-watch:interval:set', hours);
  }

  function dismissNotification(idx) {
    update(s => ({ ...s, notifications: s.notifications.filter((_, i) => i !== idx) }));
  }

  // Expose update so internal helper functions defined after export can mutate state
  return { subscribe, update, refresh, add, remove, clear, clearHistory, setIntervalHours, dismissNotification };
}

export const modAvailabilityWatchStore = createModAvailabilityWatchStore();

// Listen for fulfillment notifications
if (window?.electron) {
  window.electron.on('mod-availability-notification', (data) => {
    if (data?.serverPath) {
      modAvailabilityWatchStore.refresh(data.serverPath);
      // Push notification
      modAvailabilityWatchStore._pushNotification?.(data); // internal call if exposed
    }
  });
}

// Expose internal helper to append notifications without exporting non-store functions
modAvailabilityWatchStore._pushNotification = (notif) => {
  if (!notif) return;
  const entry = {
    modName: notif.modName || notif.projectId,
    projectId: notif.projectId,
    versionFound: notif.versionFound,
    target: normalizeTarget(notif.target),
    at: new Date().toISOString()
  };
  modAvailabilityWatchStore._appendNotification(entry);
};

modAvailabilityWatchStore._appendNotification = (entry) => {
  if (!entry) return;
  modAvailabilityWatchStore.update?.((s) => {
    const list = [entry, ...(s.notifications || [])];
    // Keep last 20
    if (list.length > 20) list.length = 20;
    return { ...s, notifications: list };
  });
};
