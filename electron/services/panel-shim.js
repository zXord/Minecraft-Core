(() => {
  const listeners = new Map();
  function emit(event, data) {
    (listeners.get(event) || []).forEach((fn) => {
      try { fn(data); } catch { /* ignore listener error */ }
    });
  }

  // Mark this environment as the Browser Panel (non-Electron)
  try {
    Object.defineProperty(window, 'IS_BROWSER_PANEL', { value: true, configurable: false, enumerable: false, writable: false });
  } catch { /* ignore */ }

  // Polling for status/metrics (2s) and logs (1s)
  let statusPoller = null;
  let logPoller = null;
  let prevLogLines = [];
  let sse = null;
  let mgmtPoller = null;
  let autoRestartPoller = null;

  function startPolling() {
  if (!sse) {
      try {
        sse = new EventSource('/api/events');
        sse.addEventListener('backup-size-changed', (e) => {
          try { emit('backup-size-changed', JSON.parse(e.data)); } catch { /* ignore */ }
        });
        sse.addEventListener('backup-notification', (e) => {
          try { emit('backup-notification', JSON.parse(e.data)); } catch { /* ignore */ }
        });
        sse.addEventListener('server-java-download-progress', (e) => {
          try { emit('server-java-download-progress', JSON.parse(e.data)); } catch { /* ignore */ }
        });
        sse.addEventListener('players-list-changed', (e) => {
          try {
            const payload = JSON.parse(e.data);
            emit('players-list-changed', payload);
          } catch { /* ignore */ }
        });
          sse.addEventListener('mods-changed', (e) => {
            try { emit('mods-changed', JSON.parse(e.data)); } catch { /* ignore */ }
          });
        // Management server bridge
        sse.addEventListener('management-server-status', (e) => {
          try { emit('management-server-status', JSON.parse(e.data)); } catch { /* ignore */ }
        });
        sse.addEventListener('server-status', (e) => {
          try {
            const payload = JSON.parse(e.data);
            if (payload && typeof payload.isRunning === 'boolean') {
              emit('server-status', payload.isRunning ? 'running' : 'stopped');
            }
          } catch { /* ignore */ }
        });
        sse.addEventListener('management-server-path-updated', (e) => {
          try { emit('management-server-path-updated', JSON.parse(e.data)); } catch { /* ignore */ }
        });
        // Auto-restart status bridge
        sse.addEventListener('auto-restart-status', (e) => {
          try { emit('auto-restart-status', JSON.parse(e.data)); } catch { /* ignore */ }
        });
      } catch { /* ignore SSE init */ }
    }
    if (!statusPoller) {
      let lastStatusVersion = null;
      statusPoller = setInterval(async () => {
        try {
          const r = await fetch('/api/server/status');
          const s = await r.json();
          if (s && s.success) {
            if (lastStatusVersion === null || s.statusVersion !== lastStatusVersion) {
              lastStatusVersion = s.statusVersion;
              emit('server-status', s.isRunning ? 'running' : 'stopped');
            }
            // Build uptime string for UI
            let uptimeStr = '0h 0m 0s';
            if (s && typeof s.uptimeMs === 'number' && s.uptimeMs > 0) {
              const total = Math.floor(s.uptimeMs / 1000);
              const h = Math.floor(total / 3600);
              const m = Math.floor((total % 3600) / 60);
              const sec = total % 60;
              uptimeStr = `${h}h ${m}m ${sec}s`;
            }
            const cpuPct = typeof s.cpuPct === 'number' && isFinite(s.cpuPct) ? s.cpuPct : 0;
            let memUsedMB = typeof s.memUsedMB === 'number' && isFinite(s.memUsedMB) ? s.memUsedMB : 0;
            let maxRamMB = typeof s.maxRamMB === 'number' && isFinite(s.maxRamMB) ? s.maxRamMB : 0;
            if (!maxRamMB || maxRamMB <= 0) maxRamMB = 4096;
            if (memUsedMB < 0) memUsedMB = 0;
            emit('metrics-update', { cpuPct, memUsedMB, maxRamMB, uptime: uptimeStr, names: (s.players && s.players.names) || [] });
          }
        } catch { /* ignore status poll error */ }
      }, 1500); // slightly faster to surface transitions promptly
    }
    if (!logPoller) {
      logPoller = setInterval(async () => {
        try {
          const r = await fetch('/api/server/logs?tail=500', { headers: { 'Accept': 'text/plain' } });
          const text = await r.text();
          const lines = text.split('\n').filter(Boolean);
          if (prevLogLines.length === 0) {
            const seed = lines.slice(-50);
            seed.forEach((line) => emit('server-log', line));
          } else if (lines.length >= prevLogLines.length) {
            const newLines = lines.slice(prevLogLines.length);
            newLines.forEach((line) => emit('server-log', line));
          } else {
            const seed = lines.slice(-50);
            seed.forEach((line) => emit('server-log', line));
          }
          prevLogLines = lines;
  } catch { /* ignore log poll error */ }
      }, 1000);
    }
    if (!mgmtPoller) {
      mgmtPoller = setInterval(async () => {
        try {
          const r = await fetch('/api/management/status');
          const j = await r.json();
          if (j && j.success && j.status) {
            emit('management-server-status', j.status);
          }
        } catch { /* ignore */ }
      }, 3000);
    }
    if (!autoRestartPoller) {
      // Periodically emit auto-restart status to keep UI in sync
      autoRestartPoller = setInterval(async () => {
        try {
          const r = await fetch('/api/auto-restart');
          const j = await r.json();
          if (j && (j.enabled !== undefined)) emit('auto-restart-status', j);
        } catch { /* ignore */ }
      }, 5000);
    }
  }

  window.electron = {
    isBrowserPanel: true,
    invoke: async (channel, ...args) => {
      switch (channel) {
        case 'get-last-server-path': {
          const r = await fetch('/api/settings');
          const j = await r.json();
          const s = (j && j.settings) || {};
          return s.serverPath || null;
        }
        case 'set-server-path': {
          const serverPath = args[0];
          const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverPath }) });
          const j = await r.json();
          return j && j.success ? { success: true } : { success: false, error: (j && j.error) || 'Failed to set server path' };
        }
        case 'get-instances': {
          const r = await fetch('/api/instances');
          return await r.json();
        }
        case 'get-settings': {
          const r = await fetch('/api/settings');
          return await r.json();
        }
        case 'update-settings': {
          const body = args[0] || {};
          const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        case 'read-config': {
          const targetPath = args[0];
          const url = new URL(window.location.origin + '/api/config');
          url.searchParams.set('serverPath', targetPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        case 'start-server': {
          const { targetPath, port, maxRam } = args[0] || {};
          const r = await fetch('/api/server/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetPath, port, maxRam }) });
          return await r.json();
        }
        case 'stop-server': {
          const r = await fetch('/api/server/stop', { method: 'POST' });
          return await r.json();
        }
        case 'kill-server': {
          const r = await fetch('/api/server/kill', { method: 'POST' });
          return await r.json();
        }
        case 'send-command': {
          const { command } = args[0] || {};
          const r = await fetch('/api/server/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) });
          return await r.json();
        }
        case 'get-server-status': {
          const r = await fetch('/api/server/status');
          const s = await r.json();
          // Convert uptimeMs → "Xh Ym Zs" string for UI compatibility
          let uptimeStr = '0h 0m 0s';
          if (s && typeof s.uptimeMs === 'number' && s.uptimeMs > 0) {
            const total = Math.floor(s.uptimeMs / 1000);
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const sec = total % 60;
            uptimeStr = `${h}h ${m}m ${sec}s`;
          }
          return { status: s.isRunning ? 'running' : 'stopped', playersInfo: s.players || { count: 0, names: [] }, uptime: uptimeStr };
        }
        case 'get-management-server-status': {
          const r = await fetch('/api/management/status');
          return await r.json();
        }
        case 'start-management-server': {
          const { port = 8080, serverPath = null } = args[0] || {};
          const r = await fetch('/api/management/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port, serverPath }) });
          return await r.json();
        }
        case 'stop-management-server': {
          const r = await fetch('/api/management/stop', { method: 'POST' });
          return await r.json();
        }
        case 'update-management-server-path': {
          const serverPath = args[0];
          const r = await fetch('/api/management/update-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverPath }) });
          return await r.json();
        }
        case 'set-management-server-external-host': {
          const host = args[0];
          const r = await fetch('/api/management/set-external-host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host }) });
          return await r.json();
        }
        case 'get-management-server-host-info': {
          const r = await fetch('/api/management/host-info');
          return await r.json();
        }
        case 'open-external-url': {
          return { success: true };
        }
        case 'show-error-dialog': {
          return { success: true };
        }
        // Auto-Restart (browser bridge)
        case 'get-auto-restart': {
          const r = await fetch('/api/auto-restart');
          return await r.json();
        }
        case 'set-auto-restart': {
          const body = args[0] || {};
          const r = await fetch('/api/auto-restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const j = await r.json();
          // Emit locally so listeners update immediately
          try { emit('auto-restart-status', j); } catch { /* ignore */ }
          return j;
        }
        // App settings (browser-safe)
        case 'get-app-settings': {
          const r = await fetch('/api/app-settings');
          return await r.json();
        }
        case 'save-app-settings': {
          const body = args[0] || {};
          const r = await fetch('/api/app-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        case 'set-instance-visibility': {
          const visibility = args[0] || {};
          const r = await fetch('/api/app-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ browserPanel: { instanceVisibility: visibility } }) });
          return await r.json();
        }
        case 'set-current-instance': {
          return { success: true };
        }
        case 'start-periodic-checks': {
          startPolling();
          return { success: true };
        }
        case 'stop-periodic-checks': {
          if (statusPoller) { try { clearInterval(statusPoller); } catch { /* ignore */ } statusPoller = null; }
          if (logPoller) { try { clearInterval(logPoller); } catch { /* ignore */ } logPoller = null; }
          if (mgmtPoller) { try { clearInterval(mgmtPoller); } catch { /* ignore */ } mgmtPoller = null; }
          if (autoRestartPoller) { try { clearInterval(autoRestartPoller); } catch { /* ignore */ } autoRestartPoller = null; }
          if (sse) { try { sse.close(); } catch { /* ignore */ } sse = null; }
          return { success: true };
        }
        case 'logger-add-log': {
          return { success: true };
        }
        // Backups: list
        case 'backups:list': {
          const { serverPath } = args[0] || {};
          const url = new URL(window.location.origin + '/api/backups/list');
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        // Backups: calculate sizes
        case 'backups:calculate-sizes': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/calculate-sizes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Backups: watch size changes
        case 'backups:watch-size-changes': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/watch-size-changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Backups: delete
        case 'backups:delete': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Backups: rename
        case 'backups:rename': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Backups: restore
        case 'backups:restore': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Backups: run immediate auto
        case 'backups:run-immediate-auto': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/run-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Backups: automation settings
        case 'backups:get-automation-settings': {
          const r = await fetch('/api/backups/automation');
          return await r.json();
        }
        case 'backups:configure-automation': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Backups: retention settings
        case 'backups:get-retention-settings': {
          const { serverPath } = args[0] || {};
          const url = new URL(window.location.origin + '/api/backups/retention');
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        case 'backups:save-retention-settings': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/retention', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Backups: apply retention policy
        case 'backups:apply-retention-policy': {
          const body = args[0] || {};
          const r = await fetch('/api/backups/apply-retention-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Players
        case 'read-players': {
          const [listName, serverPath] = args;
          const url = new URL(window.location.origin + '/api/players/read');
          if (listName) url.searchParams.set('listName', listName);
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          const j = await r.json();
          // API returns { success, data }; UI expects an array
          if (j && j.success) return Array.isArray(j.data) ? j.data : [];
          // Fallback for unexpected shapes
          if (Array.isArray(j)) return j;
          if (j && Array.isArray(j.data)) return j.data;
          return [];
        }
        case 'add-player': {
          const [listName, serverPath, entry] = args;
          const r = await fetch('/api/players/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listName, serverPath, entry }) });
          const j = await r.json();
          return j && j.success ? (j.data ?? true) : j;
        }
        case 'remove-player': {
          const [listName, serverPath, entry] = args;
          const r = await fetch('/api/players/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listName, serverPath, entry }) });
          const j = await r.json();
          return j && j.success ? (j.data ?? true) : j;
        }
        case 'get-last-banned-player': {
          const [serverPath] = args;
          const url = new URL(window.location.origin + '/api/players/last-banned');
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        // Window ops not applicable in browser
        case 'set-window-size': {
          return { success: true };
        }
        // Browser panel control not available from browser
        case 'browser-panel:status': {
          const r = await fetch('/api/panel/status');
          return await r.json();
        }
        case 'browser-panel:start':
        case 'browser-panel:stop': {
          return { success: false, error: 'Not available from browser' };
        }
        // Server properties
        case 'read-server-properties': {
          const [serverPath] = args;
          const url = new URL(window.location.origin + '/api/server-properties/read');
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        case 'write-server-properties': {
          const body = args[0] || {};
          const r = await fetch('/api/server-properties/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        case 'restore-backup-properties': {
          const [serverPath] = args;
          const r = await fetch('/api/server-properties/restore-default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverPath }) });
          return await r.json();
        }
        // Server Java
        case 'server-java-check-requirements': {
          const { minecraftVersion, serverPath } = args[0] || {};
          const url = new URL(window.location.origin + '/api/java/requirements');
          if (minecraftVersion) url.searchParams.set('minecraftVersion', minecraftVersion);
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        case 'server-java-ensure': {
          const body = args[0] || {};
          const r = await fetch('/api/java/ensure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        case 'server-java-get-path': {
          const { minecraftVersion, serverPath } = args[0] || {};
          const url = new URL(window.location.origin + '/api/java/path');
          if (minecraftVersion) url.searchParams.set('minecraftVersion', minecraftVersion);
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        case 'server-java-get-available-versions': {
          const params = args[0] || {};
          const url = new URL(window.location.origin + '/api/java/available-versions');
          if (params.serverPath) url.searchParams.set('serverPath', params.serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        case 'server-java-is-available': {
          const { minecraftVersion, serverPath } = args[0] || {};
          const url = new URL(window.location.origin + '/api/java/is-available');
          if (minecraftVersion) url.searchParams.set('minecraftVersion', minecraftVersion);
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        // Mods/Shaders/Resourcepacks: list
        case 'list-mods':
        case 'list-shaders':
        case 'list-resourcepacks': {
          const serverPath = args[0];
          const contentType = channel === 'list-shaders' ? 'shaders' : (channel === 'list-resourcepacks' ? 'resourcepacks' : 'mods');
          const url = new URL(window.location.origin + '/api/mods/list');
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          url.searchParams.set('contentType', contentType);
          const r = await fetch(url.toString());
          return await r.json();
        }
        // Mods: installed info
        case 'get-installed-mod-info': {
          const serverPath = args[0];
          const url = new URL(window.location.origin + '/api/mods/installed-info');
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        // Mods: save disabled mods
        case 'save-disabled-mods': {
          const [serverPath, disabledMods] = args;
          const r = await fetch('/api/mods/save-disabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverPath, disabledMods }) });
          return await r.json();
        }
        // Mods/Shaders/Resourcepacks: delete
        case 'delete-mod':
        case 'delete-shader':
        case 'delete-resourcepack': {
          const serverPath = args[0];
          const itemName = args[1];
          const contentType = channel === 'delete-shader' ? 'shaders' : (channel === 'delete-resourcepack' ? 'resourcepacks' : 'mods');
          const r = await fetch('/api/mods/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverPath, itemName, contentType }) });
          return await r.json();
        }
        // Mods: move file to category (server/client/common)
        case 'move-mod-file': {
          const body = args[0] || {};
          const r = await fetch('/api/mods/move-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Mods/Shaders/Resourcepacks: install
        case 'install-mod':
        case 'install-shader-with-fallback':
        case 'install-resourcepack-with-fallback': {
          const serverPath = args[0];
          const contentData = args[1] || {};
          const contentType = channel === 'install-shader-with-fallback' ? 'shaders' : (channel === 'install-resourcepack-with-fallback' ? 'resourcepacks' : 'mods');
          const r = await fetch('/api/mods/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverPath, contentData, contentType }) });
          return await r.json();
        }
        // Mods: check disabled updates
        case 'check-disabled-mod-updates': {
          const body = args[0] || {};
          const r = await fetch('/api/mods/check-disabled-updates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Mods: enable and update
        case 'enable-and-update-mod': {
          const body = args[0] || {};
          const r = await fetch('/api/mods/enable-and-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        // Mods/Shaders/Resourcepacks: search
        case 'search-mods':
        case 'search-shaders':
        case 'search-resourcepacks': {
          const contentType = channel === 'search-shaders' ? 'shaders' : (channel === 'search-resourcepacks' ? 'resourcepacks' : 'mods');
          const argsBody = args[0] || {};
          const r = await fetch('/api/mods/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentType, ...argsBody }) });
          return await r.json();
        }
        // Mods: versions
        case 'get-mod-versions': {
          const argsBody = args[0] || {};
          const r = await fetch('/api/mods/versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(argsBody) });
          return await r.json();
        }
        case 'get-mod-categories': {
          const r = await fetch('/api/mods/categories');
          return await r.json();
        }
        case 'save-mod-categories': {
          // Preload passes (categoriesArray, serverPath, clientPath), but handler uses only categoriesArray
          const categories = args[0] || [];
          const r = await fetch('/api/mods/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ categories }) });
          return await r.json();
        }
        case 'get-disabled-mods': {
          const serverPath = args[0];
          const url = new URL(window.location.origin + '/api/mods/disabled');
          if (serverPath) url.searchParams.set('serverPath', serverPath);
          const r = await fetch(url.toString());
          return await r.json();
        }
        case 'check-mod-compatibility': {
          const body = args[0] || {};
          const r = await fetch('/api/mods/check-compatibility', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          return await r.json();
        }
        case 'get-project-info': {
          const argsBody = args[0] || {};
          const r = await fetch('/api/mods/project-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(argsBody) });
          return await r.json();
        }
        case 'get-version-info': {
          const argsBody = args[0] || {};
          const r = await fetch('/api/mods/version-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(argsBody) });
          return await r.json();
        }
        case 'get-mod-info': {
          const argsBody = args[0] || {};
          const r = await fetch('/api/mods/mod-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(argsBody) });
          return await r.json();
        }
        default: {
          return { success: false, error: 'Unsupported in browser panel: ' + channel };
        }
      }
    },
    on: (event, handler) => {
      const arr = listeners.get(event) || [];
      arr.push(handler);
      listeners.set(event, arr);
      startPolling();
    },
    removeAllListeners: (event) => { listeners.delete(event); },
    removeListener: (event, handler) => {
      const arr = listeners.get(event) || [];
      const idx = arr.indexOf(handler);
      if (idx > -1) { arr.splice(idx, 1); listeners.set(event, arr); }
    }
  };
})();
