// @ts-nocheck
// Browser Panel Server - decoupled from Management Server
const express = require('express');
const cors = require('cors');
// No fs/path needed here currently
const appStore = require('../utils/app-store.cjs');
const { safeSend } = require('../utils/safe-send.cjs');
const { getManagementServer } = require('./management-server.cjs');
// Reuse existing server manager for start/stop/commands/status
const {
  startMinecraftServer,
  stopMinecraftServer,
  killMinecraftServer,
  sendServerCommand,
  getServerState,
} = require('./server-manager.cjs');
// Backup and retention utilities
const backupService = require('./backup-service.cjs');
const { RetentionPolicy } = require('../utils/retention-policy.cjs');
const playerHandlers = require('../ipc/player-handlers.cjs');
const serverPropsHandlers = require('../ipc/server-properties-handlers.cjs');
// Mods/info handlers (server mods, shaders, resourcepacks, and search/info)
const serverModHandlers = require('../ipc/mod-handlers/server-mod-handlers.cjs');
const modInfoHandlers = require('../ipc/mod-handlers/mod-info-handlers.cjs');
// Using ServerJavaManager directly for browser server; no IPC wrapper needed
const { ServerJavaManager } = require('./server-java-manager.cjs');
// Auto-restart service (reuse existing logic/state)
const {
  setAutoRestartOptions,
  getAutoRestartState
} = require('./auto-restart.cjs');
class BrowserPanelServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.port = 8081; // separate default
    this.isRunning = false;
  this.connections = new Set();
  this.sseClients = new Set();
  this.backupWatchers = new Map(); // serverPath -> fs.FSWatcher
  this.serverJavaManager = new (ServerJavaManager)();
  this.authFailures = new Map();
  this.authWindowMs = 10 * 60 * 1000;
  this.authMaxFailures = 6;
  this.authLockMs = 15 * 60 * 1000;
    this.setupMiddleware();
    this.setupRoutes();
  }

  getRequestIp(req) {
    const forwarded = req && req.headers && req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
    return (req && req.ip) || (req && req.connection && req.connection.remoteAddress) || 'unknown';
  }

  getPanelCredentials() {
    const settings = appStore.get('appSettings') || {};
    const bp = settings.browserPanel || {};
    const username = typeof bp.username === 'string' ? bp.username.trim() : '';
    const password = typeof bp.password === 'string' ? bp.password : '';
    const isDefault = username === 'user' && password === 'password';
    const isConfigured = !!username && !!password && !isDefault;
    return { username, password, isDefault, isConfigured };
  }

  isAuthLocked(ip) {
    if (!ip) return false;
    const entry = this.authFailures.get(ip);
    if (!entry || !entry.lockedUntil) return false;
    if (Date.now() >= entry.lockedUntil) {
      this.authFailures.delete(ip);
      return false;
    }
    return true;
  }

  registerAuthFailure(ip) {
    if (!ip) return null;
    const now = Date.now();
    let entry = this.authFailures.get(ip);
    if (!entry || now - entry.start > this.authWindowMs) {
      entry = { start: now, count: 0, lockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= this.authMaxFailures) {
      entry.lockedUntil = now + this.authLockMs;
    }
    this.authFailures.set(ip, entry);
    return entry;
  }

  clearAuthFailures(ip) {
    if (ip) this.authFailures.delete(ip);
  }

  setupMiddleware() {
    this.app.use(cors({ origin: true, credentials: true }));
    this.app.use(express.json({ limit: '10mb' }));

    // Basic Auth always on for panel with lockout
    this.app.use((req, res, next) => {
      try {
        const { username, password, isConfigured } = this.getPanelCredentials();
        if (!isConfigured) {
          return res.status(403).send('Browser panel credentials are not configured. Set a unique username and password in App Settings.');
        }

        const ip = this.getRequestIp(req);
        if (this.isAuthLocked(ip)) {
          const entry = this.authFailures.get(ip);
          const retryAfter = entry && entry.lockedUntil
            ? Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 1000))
            : Math.ceil(this.authLockMs / 1000);
          res.set('Retry-After', String(retryAfter));
          return res.status(429).send('Too many failed login attempts. Try again later.');
        }

        const header = req.headers['authorization'];
        if (!header || !header.startsWith('Basic ')) {
          res.set('WWW-Authenticate', 'Basic realm="Minecraft Core"');
          return res.status(401).send('Authentication required');
        }

        const decoded = Buffer.from(header.substring(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        const user = separator >= 0 ? decoded.slice(0, separator) : decoded;
        const pass = separator >= 0 ? decoded.slice(separator + 1) : '';
        const ok = user === username && pass === password;
        if (!ok) {
          const entry = this.registerAuthFailure(ip);
          if (entry && entry.lockedUntil) {
            const retryAfter = Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 1000));
            res.set('Retry-After', String(retryAfter));
          }
          res.set('WWW-Authenticate', 'Basic realm="Minecraft Core"');
          return res.status(401).send('Invalid credentials');
        }

        this.clearAuthFailures(ip);
        next();
      } catch {
        return res.status(500).send('Auth error');
      }
    });
  }

  setupRoutes() {
  // Serve the app at root without redirects to avoid potential redirect loops.
  // We inject a <base href="/ui/"> so relative asset URLs resolve to /ui/assets.
  this.app.get('/', (_req, res) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const distDir = path.join(__dirname, '../../dist');
      const publicDir = path.join(__dirname, '../../public');
      const serveDir = fs.existsSync(distDir) ? distDir : (fs.existsSync(publicDir) ? publicDir : path.join(__dirname, '../../'));
      const indexPath = fs.existsSync(path.join(serveDir, 'index.html')) ? path.join(serveDir, 'index.html') : path.join(__dirname, '../../index.html');
      let html = fs.readFileSync(indexPath, 'utf8');
      // Ensure favicon/icon usage for browser panel (replace any vite.svg reference)
      if (html.includes('vite.svg')) {
        html = html.replace(/vite\.svg/g, 'icon.png');
      }
      // Ensure <link rel="icon" exists pointing to icon.png
      if (!/rel=["']icon["']/i.test(html)) {
        if (html.includes('</head>')) {
          html = html.replace('</head>', '  <link rel="icon" type="image/png" href="/icon.png" />\n</head>');
        } else if (html.includes('<head>')) {
          html = html.replace('<head>', '<head>\n  <link rel="icon" type="image/png" href="/icon.png" />');
        } else {
          html = '<link rel="icon" type="image/png" href="/icon.png" />\n' + html;
        }
      }
      // Ensure shim is injected early
      if (!html.includes('/panel-shim.js')) {
        if (html.includes('<head>')) {
          html = html.replace('<head>', '<head>\n  <script src="/panel-shim.js"></script>');
        } else if (html.includes('<body>')) {
          html = html.replace('<body>', '<body>\n  <script src="/panel-shim.js"></script>');
        } else if (html.includes('</body>')) {
          html = html.replace('</body>', '  <script src="/panel-shim.js"></script>\n</body>');
        } else {
          html += '\n<script src="/panel-shim.js"></script>';
        }
      }
      // Inject a base tag so relative URLs resolve under /ui/
  if (!/<base\s+href=/i.test(html)) {
        if (html.includes('<head>')) {
          html = html.replace('<head>', '<head>\n  <base href="/ui/">');
        } else {
          // Fallback: prepend to start of document
          html = '<base href="/ui/">\n' + html;
        }
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(html);
    } catch {
      res.status(500).send('Panel not available');
    }
  });

    // Management server APIs (mirror desktop IPC)
    this.app.get('/api/management/status', (_req, res) => {
      try {
        const management = getManagementServer();
        const status = management.getStatus();
        res.json({ success: true, status });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    this.app.post('/api/management/start', express.json(), async (req, res) => {
      try {
        const { port = 8080, serverPath = null } = req.body || {};
        const management = getManagementServer();
        const result = await management.start(port, serverPath);
        try {
          if (result && result.success) {
            const payload = { isRunning: true, port: result.port, serverPath };
            // Notify browser UI clients immediately
            emitEvent('management-server-status', payload);
            // Notify desktop renderer too
            safeSend('management-server-status', payload);
          }
        } catch { /* ignore notify error */ }
        res.json(result);
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    this.app.post('/api/management/stop', async (_req, res) => {
      try {
        const management = getManagementServer();
        const result = await management.stop();
        try {
          if (result && result.success) {
            const payload = { isRunning: false, port: null, serverPath: null };
            // Notify browser UI clients immediately
            emitEvent('management-server-status', payload);
            // Notify desktop renderer too
            safeSend('management-server-status', payload);
          }
        } catch { /* ignore notify error */ }
        res.json(result);
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    this.app.post('/api/management/update-path', express.json(), (req, res) => {
      try {
        const { serverPath } = req.body || {};
        const management = getManagementServer();
        management.updateServerPath(serverPath || null);
        try {
          emitEvent('management-server-path-updated', serverPath || null);
          safeSend('management-server-path-updated', serverPath || null);
        } catch { /* ignore notify error */ }
        res.json({ success: true, serverPath: serverPath || null });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    this.app.post('/api/management/set-external-host', express.json(), (req, res) => {
      try {
        const { host } = req.body || {};
        const management = getManagementServer();
        management.setExternalHost(host || null);
        res.json({ success: true, externalHost: host || null, downloadHost: management.getModDownloadHost() });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    this.app.get('/api/management/host-info', (_req, res) => {
      try {
        const management = getManagementServer();
        res.json({
          success: true,
          downloadHost: management.getModDownloadHost(),
          externalHost: management.externalHost,
          configuredHost: management.configuredHost,
          detectedPublicHost: management.detectedPublicHost
        });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // Serve the built renderer under /ui with a shim to emulate Electron IPC in the browser
    const fs = require('fs');
    const path = require('path');
    const distDir = path.join(__dirname, '../../dist');
    const publicDir = path.join(__dirname, '../../public');
    const serveDir = fs.existsSync(distDir) ? distDir : (fs.existsSync(publicDir) ? publicDir : path.join(__dirname, '../../'));

  // Static assets (do not serve index; we inject shim via the /ui* handler below)
  this.app.use('/ui', express.static(serveDir, { index: false }));

  // Normalize /ui to /ui/ so built asset relative URLs like ./assets resolve to /ui/assets
  this.app.get('/ui', (_req, res) => res.redirect('/ui/'));

    // Serve static shim file
    this.app.get('/panel-shim.js', (_req, res) => {
      const path = require('path');
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(__dirname, 'panel-shim.js'));
    });

    // Server-Sent Events stream for async notifications
    this.app.get('/api/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders && res.flushHeaders();
      res.write(': connected\n\n');
      this.sseClients.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 25000);
      req.on('close', () => {
        clearInterval(heartbeat);
        this.sseClients.delete(res);
        try { res.end(); } catch { /* ignore */ }
      });
    });

    // Helper to emit events to SSE clients
    const emitEvent = (type, payload) => {
      const data = `event: ${type}\n` + `data: ${JSON.stringify(payload)}\n\n`;
      for (const client of this.sseClients) {
        try { client.write(data); } catch { /* ignore write error */ }
      }
    };

    // Serve index.html with injected shim for /ui routes
    this.app.get('/ui*', (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const indexPath = fs.existsSync(path.join(serveDir, 'index.html')) ? path.join(serveDir, 'index.html') : path.join(__dirname, '../../index.html');
        let html = fs.readFileSync(indexPath, 'utf8');
        // Normalize favicon in served UI HTML
        if (html.includes('vite.svg')) {
          html = html.replace(/vite\.svg/g, 'icon.png');
        }
        if (!/rel=["']icon["']/i.test(html)) {
          if (html.includes('</head>')) {
            html = html.replace('</head>', '  <link rel="icon" type="image/png" href="/icon.png" />\n</head>');
          } else if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>\n  <link rel="icon" type="image/png" href="/icon.png" />');
          } else {
            html = '<link rel="icon" type="image/png" href="/icon.png" />\n' + html;
          }
        }
        // Inject shim early to ensure window.electron exists before app scripts run
        if (!html.includes('/panel-shim.js')) {
          if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>\n  <script src="/panel-shim.js"></script>');
          } else if (html.includes('<body>')) {
            html = html.replace('<body>', '<body>\n  <script src="/panel-shim.js"></script>');
          } else if (html.includes('</body>')) {
            html = html.replace('</body>', '  <script src="/panel-shim.js"></script>\n</body>');
          } else {
            // Fallback append
            html += '\n<script src="/panel-shim.js"></script>';
          }
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
      } catch {
        res.status(500).send('Panel not available');
      }
    });

    // Explicit favicon/icon routes so browser always finds it regardless of build hashing
    this.app.get(['/favicon.ico', '/icon.png'], (req, res) => {
      try {
        const path = require('path');
        const fs = require('fs');
        const candidates = [
          path.join(__dirname, '../../public/icon.png'),
          path.join(__dirname, '../../icon.png'),
          path.join(__dirname, '../../dist/icon.png')
        ];
        const file = candidates.find(p => fs.existsSync(p));
        if (file) return res.sendFile(file);
        res.status(404).end();
      } catch {
        res.status(500).end();
      }
    });

  // APIs for UI
    this.app.get('/api/panel/status', (_req, res) => res.json({ success: true, isRunning: this.isRunning, port: this.port }));
    this.app.get('/api/instances', (_req, res) => {
      try {
        const settings = appStore.get('appSettings') || {};
        const bp = settings.browserPanel || {};
        const vis = bp.instanceVisibility || {};
        const instances = (appStore.get('instances') || [])
          .filter(i => i && i.type === 'server' && vis[i.id] !== false);
        res.json(instances);
      } catch {
        res.json([]);
      }
    });
    this.app.get('/api/instances/:id/info', (req, res) => {
      const { id } = req.params;
      const settings = appStore.get('appSettings') || {}; const bp = settings.browserPanel || {}; const vis = bp.instanceVisibility || {};
      const instances = appStore.get('instances') || [];
      const inst = instances.find(i => i && i.id === id && i.type === 'server' && vis[i.id] !== false);
  if (!inst) return res.status(404).json({ success: false, error: 'Instance not found or not visible' });
      // Read server.properties if available
      const fs = require('fs');
      const path = require('path');
      const serverPropsPath = path.join(inst.path || '', 'server.properties');
      let props = {};
      try {
        if (inst.path && fs.existsSync(serverPropsPath)) {
          const content = fs.readFileSync(serverPropsPath, 'utf8');
          content.split('\n').forEach(line => {
            if (line.trim() && !line.startsWith('#')) {
              const idx = line.indexOf('=');
              if (idx > -1) {
                const key = line.substring(0, idx).trim();
                const val = line.substring(idx + 1).trim();
                props[key] = val;
              }
            }
          });
        }
  } catch { /* ignore props read error */ }
      // Simple version detection from props or fallback
      const versionGuess = props['version'] || null;
      res.json({ success: true, id: inst.id, name: inst.name, path: inst.path, serverProperties: props, minecraftVersion: versionGuess });
    });

    // Settings APIs to mirror get-settings / update-settings
    this.app.get('/api/settings', (_req, res) => {
      try {
        const serverSettings = appStore.get('serverSettings') || {
          port: 25565,
          maxRam: 4,
          managementPort: 8080,
          autoStartMinecraft: false,
          autoStartManagement: false
        };
        const serverPath = appStore.get('lastServerPath') || '';
        res.json({ success: true, settings: { ...serverSettings, serverPath } });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    // App settings APIs to mirror get-app-settings / save-app-settings (browser-safe subset)
    this.app.get('/api/app-settings', (_req, res) => {
      try {
        const defaults = {
          minimizeToTray: false,
          startMinimized: false,
          startOnStartup: false,
          windowSize: 'medium',
          customWidth: 1200,
          customHeight: 800,
          browserPanel: { enabled: false, autoStart: false, port: 8081, username: 'user', password: 'password', instanceVisibility: {} }
        };
        const settings = appStore.get('appSettings') || defaults;
        res.json({ success: true, settings });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    this.app.post('/api/app-settings', express.json(), (req, res) => {
      try {
        const incoming = req.body || {};
        const current = appStore.get('appSettings') || {};
        const updated = { ...current };
        if (Object.prototype.hasOwnProperty.call(incoming, 'minimizeToTray')) updated.minimizeToTray = !!incoming.minimizeToTray;
        if (Object.prototype.hasOwnProperty.call(incoming, 'startMinimized')) updated.startMinimized = !!incoming.startMinimized;
        if (Object.prototype.hasOwnProperty.call(incoming, 'startOnStartup')) updated.startOnStartup = !!incoming.startOnStartup; // no OS integration here
        if (incoming.windowSize) updated.windowSize = String(incoming.windowSize);
        if (incoming.customWidth) updated.customWidth = Math.max(800, parseInt(incoming.customWidth) || 1200);
        if (incoming.customHeight) updated.customHeight = Math.max(600, parseInt(incoming.customHeight) || 800);
    if (incoming.browserPanel && typeof incoming.browserPanel === 'object') {
          const bp = incoming.browserPanel; const cur = current.browserPanel || {};
          const portNum = parseInt(bp.port);
          updated.browserPanel = {
      enabled: bp.enabled !== undefined ? !!bp.enabled : (cur.enabled || false),
      autoStart: bp.autoStart !== undefined ? !!bp.autoStart : (cur.autoStart || false),
            port: !isNaN(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : (cur.port || 8081),
            username: typeof bp.username === 'string' && bp.username.trim() ? bp.username.trim() : (cur.username || 'user'),
            password: typeof bp.password === 'string' && bp.password.trim() ? bp.password.trim() : (cur.password || 'password'),
            instanceVisibility: (bp.instanceVisibility && typeof bp.instanceVisibility === 'object') ? bp.instanceVisibility : (cur.instanceVisibility || {})
          };
          // Ensure at least one server instance stays visible
          try {
            const instances = appStore.get('instances') || [];
            const servers = instances.filter(i => i && i.type === 'server');
            if (servers.length > 0) {
              const visMap = { ...(updated.browserPanel.instanceVisibility || {}) };
              const anyVisible = servers.some(s => visMap[s.id] !== false);
              if (!anyVisible) {
                visMap[servers[0].id] = true;
                updated.browserPanel.instanceVisibility = visMap;
              }
            }
          } catch { /* ignore */ }
        }
        appStore.set('appSettings', updated);
        res.json({ success: true, settings: updated });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // -------------- Auto-Restart APIs --------------
    this.app.get('/api/auto-restart', (_req, res) => {
      try {
        const state = getAutoRestartState();
        res.json(state);
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    this.app.post('/api/auto-restart', express.json(), (req, res) => {
      try {
        const options = req.body || {};
        const state = setAutoRestartOptions(options);
        try { emitEvent('auto-restart-status', state); } catch { /* ignore SSE */ }
        res.json(state);
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    this.app.post('/api/settings', express.json(), (req, res) => {
      try {
        const { port, maxRam, managementPort, serverPath, autoStartMinecraft, autoStartManagement } = req.body || {};
        // Basic validation similar to IPC handler
        if (port !== undefined && (typeof port !== 'number' || port < 1 || port > 65535)) {
          return res.status(400).json({ success: false, error: 'Invalid port number' });
        }
        if (maxRam !== undefined && (typeof maxRam !== 'number' || maxRam <= 0)) {
          return res.status(400).json({ success: false, error: 'Invalid memory allocation' });
        }
        if (managementPort !== undefined && (typeof managementPort !== 'number' || managementPort < 1025 || managementPort > 65535)) {
          return res.status(400).json({ success: false, error: 'Invalid management port number' });
        }
        if (serverPath !== undefined && (typeof serverPath !== 'string' || serverPath.trim() === '')) {
          return res.status(400).json({ success: false, error: 'Invalid server path' });
        }
        const current = appStore.get('serverSettings') || {
          port: 25565, maxRam: 4, managementPort: 8080, autoStartMinecraft: false, autoStartManagement: false
        };
        const updated = {
          ...current,
          ...(port !== undefined ? { port } : {}),
          ...(maxRam !== undefined ? { maxRam } : {}),
          ...(managementPort !== undefined ? { managementPort } : {}),
          ...(autoStartMinecraft !== undefined ? { autoStartMinecraft: !!autoStartMinecraft } : {}),
          ...(autoStartManagement !== undefined ? { autoStartManagement: !!autoStartManagement } : {})
        };
        appStore.set('serverSettings', updated);
        if (serverPath !== undefined) {
          appStore.set('lastServerPath', serverPath);
        }
        res.json({ success: true, settings: { ...updated, serverPath: appStore.get('lastServerPath') || '' } });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // Read config for a server path (mirrors read-config)
    this.app.get('/api/config', (req, res) => {
      try {
        const serverPath = req.query.serverPath || req.query.path;
        if (!serverPath || typeof serverPath !== 'string') return res.json(null);
        const fs = require('fs'); const path = require('path');
        const configPath = path.join(serverPath, '.minecraft-core.json');
        if (!fs.existsSync(configPath)) return res.json(null);
        const content = fs.readFileSync(configPath, 'utf8');
        try { return res.json(JSON.parse(content)); } catch { return res.json(null); }
      } catch { res.json(null); }
    });

    // Server-global control APIs for shim
  // Track status transitions with a version counter for clients needing precise change detection
  let statusVersionCounter = 0;
  let lastIsRunning = null;
  let lastTransitionTs = 0;
  this.app.get('/api/server/status', (_req, res) => {
    try {
      const state = getServerState();
      const isRunning = !!state.isRunning;
      if (lastIsRunning === null) {
        lastIsRunning = isRunning;
        lastTransitionTs = Date.now();
      } else if (lastIsRunning !== isRunning) {
        lastIsRunning = isRunning;
        statusVersionCounter++;
        lastTransitionTs = Date.now();
        try {
          // Push event immediately to SSE clients so UI doesn't wait for next poll
          emitEvent && emitEvent('server-status', { isRunning, statusVersion: statusVersionCounter, lastTransitionTs });
          // Also notify desktop renderer
          safeSend && safeSend('server-status', isRunning ? 'running' : 'stopped');
        } catch { /* ignore SSE push error */ }
      }
      const info = state.serverProcess ? state.serverProcess['serverInfo'] : null;
      const uptime = state.serverStartMs ? (Date.now() - state.serverStartMs) : 0;
      const players = state.playersInfo || { count: 0, names: [] };
      // Provide metrics from the system-metrics service if available
      let cpuPct = 0, memUsedMB = 0, maxRamMB = (appStore.get('serverSettings')?.maxRam || 4) * 1024;
      try {
        const { getLastMetrics } = require('./system-metrics.cjs');
        const last = getLastMetrics && getLastMetrics();
        if (last) {
          cpuPct = typeof last.cpuPct === 'number' ? last.cpuPct : cpuPct;
          memUsedMB = typeof last.memUsedMB === 'number' ? last.memUsedMB : memUsedMB;
          maxRamMB = typeof last.maxRamMB === 'number' ? last.maxRamMB : maxRamMB;
        }
      } catch { /* ignore metrics retrieval error */ }
      res.json({ success: true, isRunning, serverInfo: info, uptimeMs: uptime, players, cpuPct, memUsedMB, maxRamMB, statusVersion: statusVersionCounter, lastTransitionTs });
    } catch (e) {
      res.json({ success: false, error: e.message });
    }
  });
    this.app.post('/api/server/start', express.json(), async (req, res) => {
      const { targetPath, port = null, maxRam = null } = req.body || {};
      if (!targetPath) return res.status(400).json({ success: false, error: 'targetPath required' });
      // Enforce visibility if configured
      const instances = appStore.get('instances') || [];
      const settings = appStore.get('appSettings') || {}; const bp = settings.browserPanel || {}; const vis = bp.instanceVisibility || {};
      const inst = instances.find(i => i && i.type === 'server' && i.path === targetPath && vis[i.id] !== false);
      if (!inst) return res.status(404).json({ success: false, error: 'Instance not found or not visible' });
      try {
        // Persist path and settings same as desktop IPC
        try {
          appStore.set('lastServerPath', targetPath);
          const current = appStore.get('serverSettings') || { port: 25565, maxRam: 4, managementPort: 8080, autoStartMinecraft: false, autoStartManagement: false };
          const updated = { ...current, ...(port !== null ? { port } : {}), ...(maxRam !== null ? { maxRam } : {}) };
          appStore.set('serverSettings', updated);
        } catch { /* ignore store error */ }
  const ok = await startMinecraftServer(targetPath, port, maxRam);
  try { if (ok) { safeSend('server-status', 'running'); } } catch { /* ignore */ }
  res.json({ success: !!ok });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.post('/api/server/stop', async (_req, res) => {
      try { 
        const ok = await stopMinecraftServer(); 
  try { safeSend('server-status', 'stopped'); } catch { /* ignore */ }
        res.json({ success: !!ok }); 
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.post('/api/server/kill', async (_req, res) => {
      try { const ok = await killMinecraftServer(); res.json({ success: !!ok }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.post('/api/server/command', express.json(), async (req, res) => {
      try { const { command } = req.body || {}; const ok = await sendServerCommand(command); res.json({ success: !!ok }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.get('/api/server/logs', (req, res) => {
      try {
        const fs = require('fs'); const path = require('path');
        // Try to read current running instance log if available
        const state = getServerState();
        const p = state.serverProcess?.['serverInfo']?.targetPath;
        if (!p) return res.send('');
        const tail = Math.max(1, Math.min(1000, parseInt(req.query.tail) || 200));
        const logPath = path.join(p, 'logs', 'latest.log');
        if (!fs.existsSync(logPath)) return res.send('');
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n');
        const slice = lines.slice(-tail).join('\n');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(slice);
      } catch { res.send(''); }
    });

    // Instance control APIs (kept for direct instance addressing)
    this.app.get('/api/instances/:id/status', (req, res) => {
      const { id } = req.params;
      const settings = appStore.get('appSettings') || {};
      const bp = settings.browserPanel || {};
      const instances = appStore.get('instances') || [];
      const vis = bp.instanceVisibility || {};
      const inst = instances.find(i => i && i.id === id && i.type === 'server' && vis[i.id] !== false);
      if (!inst) return res.status(404).json({ success: false, error: 'Instance not found or not visible' });
      try {
        const state = getServerState();
        const isRunning = !!state.isRunning;
        const serverInfo = state.serverProcess ? state.serverProcess['serverInfo'] : null;
        const isThisInstance = isRunning && serverInfo && serverInfo.targetPath === inst.path;
        const uptimeMs = state.serverStartMs && isThisInstance ? (Date.now() - state.serverStartMs) : 0;
        const players = state.playersInfo || { count: 0, names: [] };
        res.json({ success: true, isRunning, isThisInstance, uptimeMs, players });
  } catch (e) {
        res.json({ success: false, error: e.message });
      }
    });

    this.app.post('/api/instances/:id/start', express.json(), async (req, res) => {
      const { id } = req.params;
      const { port = null, maxRam = null } = req.body || {};
      const instances = appStore.get('instances') || [];
      const settings = appStore.get('appSettings') || {}; const bp = settings.browserPanel || {}; const vis = bp.instanceVisibility || {};
      const inst = instances.find(i => i && i.id === id && i.type === 'server' && vis[i.id] !== false);
      if (!inst) return res.status(404).json({ success: false, error: 'Instance not found or not visible' });
      // Prevent starting if another server is running on a different path
      try {
        const state = getServerState();
        if (state.isRunning) {
          const currentPath = state.serverProcess?.['serverInfo']?.targetPath;
          if (currentPath && currentPath !== inst.path) {
            return res.status(409).json({ success: false, error: 'Another server is already running' });
          }
        }
  } catch { /* ignore running server check */ }
      try {
        // Persist path and settings same as desktop IPC
        try {
          appStore.set('lastServerPath', inst.path);
          const current = appStore.get('serverSettings') || { port: 25565, maxRam: 4, managementPort: 8080, autoStartMinecraft: false, autoStartManagement: false };
          const updated = { ...current, ...(port !== null ? { port } : {}), ...(maxRam !== null ? { maxRam } : {}) };
          appStore.set('serverSettings', updated);
        } catch { /* ignore store error */ }
        const ok = await startMinecraftServer(inst.path, port, maxRam);
        res.json({ success: !!ok });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

  this.app.post('/api/instances/:id/stop', async (req, res) => {
      const { id } = req.params;
      const instances = appStore.get('instances') || [];
      const settings = appStore.get('appSettings') || {}; const bp = settings.browserPanel || {}; const vis = bp.instanceVisibility || {};
      const inst = instances.find(i => i && i.id === id && i.type === 'server' && vis[i.id] !== false);
      if (!inst) return res.status(404).json({ success: false, error: 'Instance not found or not visible' });
      try {
        const state = getServerState();
        if (!state.isRunning) return res.json({ success: true, note: 'Already stopped' });
        const currentPath = state.serverProcess?.['serverInfo']?.targetPath;
        if (currentPath && currentPath !== inst.path) return res.status(409).json({ success: false, error: 'Different instance is running' });
  const ok = await stopMinecraftServer();
  try { safeSend('server-status', 'stopped'); } catch { /* ignore */ }
  res.json({ success: !!ok });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.post('/api/instances/:id/kill', async (req, res) => {
      try {
        const ok = await killMinecraftServer();
        res.json({ success: !!ok });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.post('/api/instances/:id/command', express.json(), async (req, res) => {
      const { id } = req.params; const { command } = req.body || {};
      if (!command || typeof command !== 'string') return res.status(400).json({ success: false, error: 'Invalid command' });
      const instances = appStore.get('instances') || [];
      const settings = appStore.get('appSettings') || {}; const bp = settings.browserPanel || {}; const vis = bp.instanceVisibility || {};
      const inst = instances.find(i => i && i.id === id && i.type === 'server' && vis[i.id] !== false);
      if (!inst) return res.status(404).json({ success: false, error: 'Instance not found or not visible' });
      try {
        const state = getServerState();
        if (!state.isRunning) return res.status(409).json({ success: false, error: 'Server not running' });
        const currentPath = state.serverProcess?.['serverInfo']?.targetPath;
        if (currentPath && currentPath !== inst.path) return res.status(409).json({ success: false, error: 'Different instance is running' });
        const ok = await sendServerCommand(command);
        res.json({ success: !!ok });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.get('/api/instances/:id/logs', (req, res) => {
      const { id } = req.params; const tail = Math.max(1, Math.min(1000, parseInt(req.query.tail) || 200));
      const instances = appStore.get('instances') || [];
      const settings = appStore.get('appSettings') || {}; const bp = settings.browserPanel || {}; const vis = bp.instanceVisibility || {};
      const inst = instances.find(i => i && i.id === id && i.type === 'server' && vis[i.id] !== false);
      if (!inst) return res.status(404).send('');
      try {
        const fs = require('fs'); const path = require('path');
        const logPath = path.join(inst.path || '', 'logs', 'latest.log');
        if (!inst.path || !fs.existsSync(logPath)) return res.send('');
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n');
        const slice = lines.slice(-tail).join('\n');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(slice);
      } catch { res.send(''); }
    });

    // Lightweight health
    this.app.get('/health', (_req, res) => res.json({ status: 'ok', port: this.port }));

    // -------------- Backups APIs --------------
    // List backups with metadata
    this.app.get('/api/backups/list', async (req, res) => {
      try {
        const serverPath = req.query.serverPath;
        if (!serverPath || typeof serverPath !== 'string') return res.json([]);
        const backups = await backupService.listBackupsWithMetadata(serverPath);
        res.json(backups);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Calculate backup sizes (simple implementation)
    this.app.post('/api/backups/calculate-sizes', express.json(), async (req, res) => {
      const { serverPath } = req.body || {};
      try {
        if (!serverPath || typeof serverPath !== 'string') return res.json({ success: false, error: 'Invalid server path' });
        const fs = require('fs');
        const path = require('path');
        const backups = await backupService.listBackupsWithMetadata(serverPath);
        let totalSize = 0;
        const withSizes = backups.map((b) => {
          try {
            const size = fs.statSync(path.join(serverPath, 'backups', b.name)).size;
            totalSize += size;
            return { ...b, size };
          } catch {
            return { ...b, size: b.size || 0 };
          }
        });
        res.json({ success: true, backups: withSizes, totalSize, totalSizeFormatted: `${totalSize}` });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });

    // Delete a backup
    this.app.post('/api/backups/delete', express.json(), async (req, res) => {
      try {
        const { serverPath, name } = req.body || {};
        if (!serverPath || !name) return res.json({ success: false, error: 'Missing serverPath or name' });
        const result = await backupService.deleteBackup({ serverPath, name });
        if (result && result.success) {
          emitEvent('backup-notification', { type: 'success', title: 'Backup deleted', message: `Deleted ${name}`, serverPath, name });
        }
        res.json(result);
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Rename a backup
    this.app.post('/api/backups/rename', express.json(), async (req, res) => {
      try {
        const { serverPath, oldName, newName } = req.body || {};
        if (!serverPath || !oldName || !newName) return res.json({ success: false, error: 'Missing parameters' });
  await backupService.renameBackup({ serverPath, oldName, newName });
  emitEvent('backup-notification', { type: 'info', title: 'Backup renamed', message: `${oldName} → ${newName}`, serverPath, name: newName });
        res.json({ success: true });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Restore a backup
    this.app.post('/api/backups/restore', express.json(), async (req, res) => {
      try {
        const { serverPath, name, serverStatus } = req.body || {};
        if (!serverPath || !name) return res.json({ success: false, error: 'Missing parameters' });
        const result = await backupService.restoreBackup({ serverPath, name, serverStatus });
        if (result && result.success) {
          emitEvent('backup-notification', { type: 'success', title: 'Backup restored', message: `Restored ${name}`, serverPath, name });
        }
        res.json(result);
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Immediate auto backup (manual run)
    this.app.post('/api/backups/run-now', express.json(), async (req, res) => {
      try {
        const { serverPath, type = 'world' } = req.body || {};
        if (!serverPath) return res.json({ success: false, error: 'Missing serverPath' });
        const result = await backupService.safeCreateBackup({ serverPath, type, trigger: 'manual-auto' });
        // Update lastRun in settings
        const settings = appStore.get('backupSettings') || {};
        appStore.set('backupSettings', { ...settings, lastRun: new Date().toISOString() });
        if (result && result.success) {
          emitEvent('backup-notification', { type: 'success', title: 'Backup created', message: `${type} backup completed`, serverPath });
        }
        res.json(result || { success: true });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Automation settings GET/POST (compute next time similar to IPC)
    const computeNextBackupTime = (settings) => {
      try {
        if (!settings || !settings.enabled) return null;
        const now = new Date();
        const scheduledHour = settings.hour !== undefined ? settings.hour : 3;
        const scheduledMinute = settings.minute !== undefined ? settings.minute : 0;
        let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), scheduledHour, scheduledMinute, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        if ((settings.frequency || 86400000) >= 604800000) {
          const targetDay = settings.day !== undefined ? settings.day : 0;
          const currentDay = next.getDay();
          const daysUntilTarget = (targetDay - currentDay + 7) % 7;
          if (daysUntilTarget > 0) next.setDate(next.getDate() + daysUntilTarget);
          else if (daysUntilTarget === 0 && next <= now) next.setDate(next.getDate() + 7);
        }
        const lastRun = settings.lastRun ? new Date(settings.lastRun) : null;
        if (lastRun) {
          if ((settings.frequency || 86400000) < 604800000) {
            if (lastRun >= next) next.setDate(next.getDate() + 1);
          } else {
            if (lastRun >= next) next.setDate(next.getDate() + 7);
          }
        }
        return next.toISOString();
      } catch { return null; }
    };

    this.app.get('/api/backups/automation', (_req, res) => {
      try {
        const defaults = {
          enabled: false,
          frequency: 86400000,
          type: 'world',
          retentionCount: 100,
          runOnLaunch: false,
          hour: 3,
          minute: 0,
          day: 0,
          lastRun: null
        };
        const settings = appStore.get('backupSettings') || defaults;
        res.json({ success: true, settings: { ...defaults, ...settings, nextBackupTime: computeNextBackupTime(settings) } });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.post('/api/backups/automation', express.json(), (req, res) => {
      try {
        const { enabled, frequency, type, retentionCount, runOnLaunch, hour, minute, day } = req.body || {};
        const prev = appStore.get('backupSettings') || {};
        const updated = {
          enabled: !!enabled,
          frequency: Number.isFinite(frequency) ? frequency : (prev.frequency || 86400000),
          type: typeof type === 'string' ? type : (prev.type || 'world'),
          retentionCount: Number.isFinite(retentionCount) ? retentionCount : (prev.retentionCount || 100),
          runOnLaunch: !!runOnLaunch,
          hour: Number.isFinite(hour) ? hour : (prev.hour || 3),
          minute: Number.isFinite(minute) ? minute : (prev.minute || 0),
          day: Number.isFinite(day) ? day : (prev.day || 0),
          lastRun: prev.lastRun || null
        };
        appStore.set('backupSettings', updated);
        res.json({ success: true });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Retention settings GET/POST
    this.app.get('/api/backups/retention', (req, res) => {
      try {
        const serverPath = req.query.serverPath;
        if (!serverPath || typeof serverPath !== 'string') return res.json({ success: false, error: 'Invalid server path' });
        const key = `retentionSettings_${Buffer.from(serverPath).toString('base64')}`;
        const settings = appStore.get(key) || {
          sizeRetentionEnabled: false,
          maxSizeValue: 10,
          maxSizeUnit: 'GB',
          ageRetentionEnabled: false,
          maxAgeValue: 30,
          maxAgeUnit: 'days',
          countRetentionEnabled: false,
          maxCountValue: 14
        };
        res.json({ success: true, settings });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.post('/api/backups/retention', express.json(), (req, res) => {
      try {
        const { serverPath, settings } = req.body || {};
        if (!serverPath || typeof serverPath !== 'string') return res.json({ success: false, error: 'Invalid server path' });
        if (!settings || typeof settings !== 'object') return res.json({ success: false, error: 'Invalid settings' });
        const validated = {
          sizeRetentionEnabled: !!settings.sizeRetentionEnabled,
          maxSizeValue: Math.max(1, parseInt(settings.maxSizeValue) || 10),
          maxSizeUnit: ['GB', 'TB'].includes(settings.maxSizeUnit) ? settings.maxSizeUnit : 'GB',
          ageRetentionEnabled: !!settings.ageRetentionEnabled,
          maxAgeValue: Math.max(1, parseInt(settings.maxAgeValue) || 30),
          maxAgeUnit: ['days', 'weeks', 'months'].includes(settings.maxAgeUnit) ? settings.maxAgeUnit : 'days',
          countRetentionEnabled: !!settings.countRetentionEnabled,
          maxCountValue: Math.max(1, parseInt(settings.maxCountValue) || 14)
        };
        const key = `retentionSettings_${Buffer.from(serverPath).toString('base64')}`;
        appStore.set(key, validated);
        res.json({ success: true });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Apply retention policy
    this.app.post('/api/backups/apply-retention-policy', express.json(), async (req, res) => {
      try {
        const { serverPath, policy, dryRun = false } = req.body || {};
        if (!serverPath || typeof serverPath !== 'string') return res.json({ success: false, error: 'Invalid server path' });
        if (!policy || typeof policy !== 'object') return res.json({ success: false, error: 'Invalid policy' });
        const backups = await backupService.listBackupsWithMetadata(serverPath);
        const fs = require('fs'); const path = require('path');
        // Add sizes to backups for policy evaluation
        const withSizes = backups.map((b) => {
          let size = 0;
          try { size = fs.statSync(path.join(serverPath, 'backups', b.name)).size; } catch { size = b.size || 0; }
          return { ...b, size };
        });
        const rp = new RetentionPolicy({
          maxSize: policy.maxSize || null,
          maxAge: policy.maxAge || null,
          maxCount: policy.maxCount || null,
          preserveRecent: Math.max(1, policy.preserveRecent || 1)
        });
        const toDelete = await rp.evaluateBackups(withSizes);
        let spaceSaved = 0;
        const deletedBackups = [];
        if (!dryRun) {
          for (const b of toDelete) {
            try {
              const r = await backupService.deleteBackup({ serverPath, name: b.name });
              if (r && r.success) {
                deletedBackups.push(b);
                spaceSaved += b.size || 0;
              }
            } catch { /* ignore */ }
          }
        }
        if (!dryRun && deletedBackups.length) {
          emitEvent('backup-notification', { type: 'info', title: 'Retention applied', message: `Deleted ${deletedBackups.length} backups`, serverPath, count: deletedBackups.length, spaceSaved });
        }
        res.json({ success: true, deletedBackups: dryRun ? [] : deletedBackups, spaceSaved });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Watch for backup size changes (basic fs.watch + debounce). Emits 'backup-size-changed' SSE events
    this.app.post('/api/backups/watch-size-changes', express.json(), async (req, res) => {
      try {
        const { serverPath } = req.body || {};
        if (!serverPath || typeof serverPath !== 'string') return res.json({ success: false, error: 'Invalid server path' });
        const path = require('path');
        const fs = require('fs');
        const dir = path.join(serverPath, 'backups');
        if (!fs.existsSync(dir)) {
          try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
        }
        // already watching?
        if (this.backupWatchers.has(serverPath)) {
          return res.json({ success: true, message: 'Watcher already active' });
        }
        let timer = null;
        const trigger = async (reason) => {
          if (timer) { clearTimeout(timer); timer = null; }
          timer = setTimeout(async () => {
            try {
              // Compute quick total size and emit a change event
              const bks = await backupService.listBackupsWithMetadata(serverPath);
              const sizes = [];
              let total = 0;
              for (const b of bks) {
                try {
                  const s = fs.statSync(path.join(dir, b.name)).size; sizes.push({ name: b.name, size: s }); total += s;
                } catch { sizes.push({ name: b.name, size: b.size || 0 }); total += (b.size || 0); }
              }
              emitEvent('backup-size-changed', { serverPath, totalSize: total, backups: sizes, reason });
            } catch { /* ignore */ }
          }, 400);
        };
        const watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
          if (filename && filename.endsWith('.zip')) trigger(eventType || 'change');
          else trigger(eventType || 'change');
        });
        this.backupWatchers.set(serverPath, watcher);
        res.json({ success: true, message: 'File system watcher setup successfully' });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // -------------- Players APIs --------------
    this.app.get('/api/players/read', (req, res) => {
      try {
        const { listName, serverPath } = req.query || {};
        const handlers = playerHandlers.createPlayerHandlers();
        const data = handlers['read-players']({ sender: { id: 'browser' } }, listName, serverPath);
        res.json({ success: true, data });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.post('/api/players/add', express.json(), (req, res) => {
      try {
        const { listName, serverPath, entry } = req.body || {};
        const handlers = playerHandlers.createPlayerHandlers();
        const data = handlers['add-player']({ sender: { id: 'browser' } }, listName, serverPath, entry);
        try {
          // Notify all connected UIs to refresh lists
          emitEvent('players-list-changed', { listName, serverPath, action: 'add', entry });
        } catch { /* ignore SSE */ }
        res.json({ success: true, data });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.post('/api/players/remove', express.json(), (req, res) => {
      try {
        const { listName, serverPath, entry } = req.body || {};
        const handlers = playerHandlers.createPlayerHandlers();
        const data = handlers['remove-player']({ sender: { id: 'browser' } }, listName, serverPath, entry);
        try {
          emitEvent('players-list-changed', { listName, serverPath, action: 'remove', entry });
        } catch { /* ignore SSE */ }
        res.json({ success: true, data });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.get('/api/players/last-banned', (req, res) => {
      try {
        const { serverPath } = req.query || {};
        const handlers = playerHandlers.createPlayerHandlers();
        const data = handlers['get-last-banned-player']({ sender: { id: 'browser' } }, serverPath);
        res.json({ success: true, ...data });
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // -------------- Server Properties APIs --------------
    this.app.get('/api/server-properties/read', (req, res) => {
      try {
        const { serverPath } = req.query || {};
        const handlers = serverPropsHandlers.createServerPropertiesHandlers();
        const p = handlers['read-server-properties']({ sender: { id: 'browser' } }, serverPath);
        Promise.resolve(p).then((out) => res.json(out)).catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.post('/api/server-properties/write', express.json(), (req, res) => {
      try {
        const { serverPath, properties } = req.body || {};
        const handlers = serverPropsHandlers.createServerPropertiesHandlers();
        const p = handlers['write-server-properties']({ sender: { id: 'browser' } }, { serverPath, properties });
        Promise.resolve(p).then((out) => res.json(out)).catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    this.app.post('/api/server-properties/restore-default', express.json(), (req, res) => {
      try {
        const { serverPath } = req.body || {};
        const handlers = serverPropsHandlers.createServerPropertiesHandlers();
        const p = handlers['restore-backup-properties']({ sender: { id: 'browser' } }, serverPath);
        Promise.resolve(p).then((out) => res.json(out)).catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // -------------- Server Java APIs --------------
  // Keep legacy handler import available in case of future reuse
  /* const javaHandlers = createServerJavaHandlers(null); */
    this.app.get('/api/java/requirements', async (req, res) => {
      try {
        const { minecraftVersion, serverPath } = req.query || {};
        if (serverPath) this.serverJavaManager.setServerPath(serverPath);
        const out = await this.serverJavaManager.getJavaRequirementsForMinecraft(minecraftVersion);
        out.success = true;
        res.json(out);
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.post('/api/java/ensure', express.json(), async (req, res) => {
      try {
        const { minecraftVersion, serverPath } = req.body || {};
        if (serverPath) this.serverJavaManager.setServerPath(serverPath);
        const out = await this.serverJavaManager.ensureJavaForMinecraft(
          minecraftVersion,
          (progress) => emitEvent('server-java-download-progress', { minecraftVersion, serverPath, ...progress })
        );
        res.json(out);
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.get('/api/java/path', async (req, res) => {
      try {
        const { minecraftVersion, serverPath } = req.query || {};
        if (serverPath) this.serverJavaManager.setServerPath(serverPath);
        const jp = this.serverJavaManager.getBestJavaPathForMinecraft(minecraftVersion);
        const out = { success: true, javaPath: jp, available: !!jp };
        res.json(out);
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.get('/api/java/available-versions', async (req, res) => {
      try {
        const { serverPath } = req.query || {};
        if (serverPath) this.serverJavaManager.setServerPath(serverPath);
        const versions = this.serverJavaManager.getAvailableJavaVersions();
        const out = { success: true, versions };
        res.json(out);
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.get('/api/java/is-available', async (req, res) => {
      try {
        const { minecraftVersion, serverPath } = req.query || {};
        if (serverPath) this.serverJavaManager.setServerPath(serverPath);
        const available = this.serverJavaManager.isCorrectJavaAvailableForMinecraft(minecraftVersion);
        const out = { success: true, available, minecraftVersion };
        res.json(out);
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // -------------- Mods/Shaders/Resourcepacks APIs --------------
    // List content (mods/shaders/resourcepacks)
    this.app.get('/api/mods/list', (req, res) => {
      try {
        const { serverPath, contentType = 'mods' } = req.query || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        let p;
        if (contentType === 'shaders') p = handlers['list-shaders']({ sender: { id: 'browser' } }, serverPath);
        else if (contentType === 'resourcepacks') p = handlers['list-resourcepacks']({ sender: { id: 'browser' } }, serverPath);
        else p = handlers['list-mods']({ sender: { id: 'browser' } }, serverPath);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Get installed mod info (array)
    this.app.get('/api/mods/installed-info', (req, res) => {
      try {
        const { serverPath } = req.query || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['get-installed-mod-info']({ sender: { id: 'browser' } }, serverPath);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Save disabled mods
    this.app.post('/api/mods/save-disabled', express.json(), (req, res) => {
      try {
        const { serverPath, disabledMods } = req.body || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['save-disabled-mods']({ sender: { id: 'browser' } }, serverPath, disabledMods || []);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Delete content (mods/shaders/resourcepacks)
    this.app.post('/api/mods/delete', express.json(), (req, res) => {
      try {
        const { serverPath, itemName, contentType = 'mods' } = req.body || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        let p;
        if (contentType === 'shaders') p = handlers['delete-shader']({ sender: { id: 'browser' } }, serverPath, itemName);
        else if (contentType === 'resourcepacks') p = handlers['delete-resourcepack']({ sender: { id: 'browser' } }, serverPath, itemName);
        else p = handlers['delete-mod']({ sender: { id: 'browser' } }, serverPath, itemName);
        Promise.resolve(p)
          .then((out) => { try { emitEvent('mods-changed', { serverPath, action: 'delete', itemName, contentType }); } catch { /* ignore emit error */ } res.json(out); })
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Move a mod file to a new category (e.g., client/server/common)
    this.app.post('/api/mods/move-file', express.json(), (req, res) => {
      try {
        const { fileName, newCategory, serverPath } = req.body || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['move-mod-file']({ sender: { id: 'browser' } }, { fileName, newCategory, serverPath });
        Promise.resolve(p)
          .then((out) => { try { emitEvent('mods-changed', { serverPath, action: 'move', fileName, newCategory, contentType: 'mods' }); } catch { /* ignore emit error */ } res.json(out); })
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Install content (mods/shaders/resourcepacks)
    this.app.post('/api/mods/install', express.json(), (req, res) => {
      try {
        const { serverPath, contentData, contentType = 'mods' } = req.body || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        let p;
        if (contentType === 'shaders') p = handlers['install-shader-with-fallback']({ sender: { id: 'browser' } }, serverPath, contentData);
        else if (contentType === 'resourcepacks') p = handlers['install-resourcepack-with-fallback']({ sender: { id: 'browser' } }, serverPath, contentData);
        else p = handlers['install-mod']({ sender: { id: 'browser' } }, serverPath, contentData);
        Promise.resolve(p)
          .then((out) => { try { emitEvent('mods-changed', { serverPath, action: 'install', contentType, contentData }); } catch { /* ignore emit error */ } res.json(out); })
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Check disabled mod updates
    this.app.post('/api/mods/check-disabled-updates', express.json(), (req, res) => {
      try {
        const { serverPath, mcVersion } = req.body || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['check-disabled-mod-updates']({ sender: { id: 'browser' } }, { serverPath, mcVersion });
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Enable and update a disabled mod
    this.app.post('/api/mods/enable-and-update', express.json(), (req, res) => {
      try {
        const body = req.body || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['enable-and-update-mod']({ sender: { id: 'browser' } }, body);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Search content (mods/shaders/resourcepacks)
    this.app.post('/api/mods/search', express.json(), (req, res) => {
      try {
        const { contentType = 'mods', ...args } = req.body || {};
        const handlers = modInfoHandlers.createModInfoHandlers();
        let p;
        if (contentType === 'shaders') p = handlers['search-shaders']({ sender: { id: 'browser' } }, args);
        else if (contentType === 'resourcepacks') p = handlers['search-resourcepacks']({ sender: { id: 'browser' } }, args);
        else p = handlers['search-mods']({ sender: { id: 'browser' } }, args);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Get versions for a project/mod
    this.app.post('/api/mods/versions', express.json(), (req, res) => {
      try {
        const args = req.body || {};
        const handlers = modInfoHandlers.createModInfoHandlers();
        const p = handlers['get-mod-versions']({ sender: { id: 'browser' } }, args);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Get project info
    this.app.post('/api/mods/project-info', express.json(), (req, res) => {
      try {
        const args = req.body || {};
        const handlers = modInfoHandlers.createModInfoHandlers();
        const p = handlers['get-project-info']({ sender: { id: 'browser' } }, args);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Get specific version info
    this.app.post('/api/mods/version-info', express.json(), (req, res) => {
      try {
        const args = req.body || {};
        const handlers = modInfoHandlers.createModInfoHandlers();
        const p = handlers['get-version-info']({ sender: { id: 'browser' } }, args);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Get mod info (by modId)
    this.app.post('/api/mods/mod-info', express.json(), (req, res) => {
      try {
        const args = req.body || {};
        const handlers = modInfoHandlers.createModInfoHandlers();
        const p = handlers['get-mod-info']({ sender: { id: 'browser' } }, args);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Mod categories persistence
    this.app.get('/api/mods/categories', (_req, res) => {
      try {
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['get-mod-categories']({ sender: { id: 'browser' } });
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
    this.app.post('/api/mods/categories', express.json(), (req, res) => {
      try {
        const { categories } = req.body || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['save-mod-categories']({ sender: { id: 'browser' } }, categories || []);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Get disabled mods list
    this.app.get('/api/mods/disabled', (req, res) => {
      try {
        const { serverPath } = req.query || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['get-disabled-mods']({ sender: { id: 'browser' } }, serverPath);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // Check mod compatibility
    this.app.post('/api/mods/check-compatibility', express.json(), (req, res) => {
      try {
        const args = req.body || {};
        const handlers = serverModHandlers.createServerModHandlers(null);
        const p = handlers['check-mod-compatibility']({ sender: { id: 'browser' } }, args);
        Promise.resolve(p)
          .then((out) => res.json(out))
          .catch((e) => res.status(500).json({ success: false, error: e.message }));
      } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });
  }

  async start(port = 8081) {
    if (this.isRunning) return { success: true, port: this.port };
    const creds = this.getPanelCredentials();
    if (!creds.isConfigured) {
      return { success: false, error: 'Browser panel credentials are not configured. Set a unique username and password in App Settings.' };
    }
    // Require at least one visible server instance to be configured
    try {
      const settings = appStore.get('appSettings') || {};
      const vis = (settings.browserPanel && settings.browserPanel.instanceVisibility) || {};
      const instances = (appStore.get('instances') || []).filter(i => i && i.type === 'server' && vis[i.id] !== false);
      if (instances.length === 0) {
        return { success: false, error: 'No visible servers selected. Choose at least one in App Settings → Browser Control Panel.' };
      }
    } catch { /* ignore and proceed */ }
    this.port = port;
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        this.isRunning = true;
        resolve({ success: true, port: this.port });
      });
      // Track connections for fast shutdown
      this.server.on('connection', (socket) => {
        this.connections.add(socket);
        socket.on('close', () => this.connections.delete(socket));
      });
      // Lower keep-alive timeout to speed up shutdowns
  try { this.server.keepAliveTimeout = 1000; } catch { /* keepAlive not supported */ }
      this.server.on('error', (error) => {
        this.isRunning = false;
        if (error && error.code === 'EADDRINUSE') {
          resolve({ success: false, error: `Port ${this.port} is already in use` });
        } else {
          resolve({ success: false, error: error.message });
        }
      });
    });
  }

  async stop() {
    if (!this.isRunning || !this.server) return { success: true };
    return new Promise((resolve) => {
      const server = this.server;
      // Safety timeout to force-close lingering sockets
      const timeout = setTimeout(() => {
        for (const socket of this.connections) {
          try { socket.destroy(); } catch { /* ignore destroy error */ }
        }
      }, 1500);
      server.close(() => {
        clearTimeout(timeout);
        this.isRunning = false;
        this.server = null;
        // Close SSE clients
        for (const client of this.sseClients) {
          try { client.end(); } catch { /* ignore */ }
        }
        this.sseClients.clear();
        // Close backup watchers
  for (const [, watcher] of this.backupWatchers) {
          try { watcher.close(); } catch { /* ignore */ }
        }
        this.backupWatchers.clear();
        resolve({ success: true });
      });
    });
  }

  getStatus() {
    return { isRunning: this.isRunning, port: this.port };
  }
}

let browserPanelInstance = null;
function getBrowserPanel() {
  if (!browserPanelInstance) browserPanelInstance = new BrowserPanelServer();
  return browserPanelInstance;
}

module.exports = { BrowserPanelServer, getBrowserPanel };
