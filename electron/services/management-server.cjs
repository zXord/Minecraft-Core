// @ts-nocheck
// Management server for client-server communication
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { wmicExecAsync } = require('../utils/wmic-utils.cjs');
const eventBus = require('../utils/event-bus.cjs');
const process = require('process');
const os = require('os');

class ManagementServer {
  /** @type {ReturnType<typeof express>} */
  app;
  /** @type {import('http').Server | null} */
  server = null;
  constructor() {
    this.app = express();
    this.port = 8080; // Default management port (different from Minecraft)
    this.isRunning = false;
    this.serverPath = null;
    this.clients = new Map(); // Track connected clients
    this.clientCleanupInterval = null; // Interval for cleaning up stale clients
    this.versionInfo = { minecraftVersion: null, loaderType: null, loaderVersion: null };
    this.versionWatcher = null;
    this.sseClients = [];
    // Track active sockets to enable forceful shutdown if needed
    this.activeSockets = new Set();
    this.appVersion = this.getAppVersion(); // Get current app version
    this.externalHost = null; // External host IP for mod downloads
    this.lastExternalHostCheck = 0; // Timestamp of last external IP detection
    this.externalHostTtlMs = 5 * 60 * 1000; // Refresh external IP detection every 5 minutes when needed
    this.configuredHost = null; // Manually configured host override
    this.detectedPublicHost = null; // Public host detected from client connections
    
    // Rate limiting for status checks
    this._lastStatusCheck = null;
    this._cachedStatus = null;

    this.setupMiddleware();
    this.setupRoutes();
  }

  // Get current app version from package.json
  getAppVersion() {
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
      return packageJson.version || '1.0.0';
    } catch {
      // TODO: Add proper logging - Failed to read app version
      return '1.0.0'; // Fallback version
    }
  }

  // Detect external IP address for mod downloads
  detectExternalIP() {
    try {
      const interfaces = os.networkInterfaces();
      
      // Priority order: Ethernet, WiFi, then others
      const interfaceNames = Object.keys(interfaces);
      const priorityOrder = ['Ethernet', 'Wi-Fi', 'WiFi', 'en0', 'eth0', 'wlan0'];
      
      // First, try priority interfaces
      for (const priority of priorityOrder) {
        const interfaceAddresses = interfaces[priority];
        if (interfaceAddresses) {
          const ipv4 = interfaceAddresses.find(addr => 
            addr.family === 'IPv4' && 
            !addr.internal && 
            addr.address !== '127.0.0.1'
          );
          if (ipv4) {
            return ipv4.address;
          }
        }
      }
      
      // Fallback: find any external IPv4 address
      for (const interfaceName of interfaceNames) {
        const interfaceAddresses = interfaces[interfaceName];
        if (interfaceAddresses) {
          const ipv4 = interfaceAddresses.find(addr => 
            addr.family === 'IPv4' && 
            !addr.internal && 
            addr.address !== '127.0.0.1'
          );
          if (ipv4) {
            return ipv4.address;
          }
        }
      }
      
      return null;
    } catch {
      // TODO: Add proper logging - Failed to detect external IP
      return null;
    }
  }

  updateDetectedPublicHost(hostHeader) {
    if (!hostHeader) return;
    const host = hostHeader.split(':')[0];
    if (!host || host === 'localhost' || host === '127.0.0.1') return;
    if (this.detectedPublicHost !== host) {
      this.detectedPublicHost = host;
    }
  }

  refreshExternalHostIfStale() {
    const now = Date.now();
    const isStale = !this.externalHost || (now - this.lastExternalHostCheck) > this.externalHostTtlMs;
    if (isStale) {
      this.externalHost = this.detectExternalIP();
      this.lastExternalHostCheck = now;
    }
    return this.externalHost;
  }

  getRequestAwareDownloadHost(req) {
    const hostHeader = req && typeof req.get === 'function' ? req.get('host') : null;
    this.updateDetectedPublicHost(hostHeader);
    const hostFromRequest = hostHeader ? hostHeader.split(':')[0] : null;
    if (hostFromRequest && hostFromRequest !== 'localhost' && hostFromRequest !== '127.0.0.1') {
      return hostFromRequest;
    }
    return this.getModDownloadHost();
  }

  // Get the host to use for mod download URLs
  getModDownloadHost() {
    // Priority: manually configured > detected from client connections > detected external IP > localhost fallback
    if (this.configuredHost) {
      return this.configuredHost;
    }
    
    // If we have clients connected, use the host they connected to
    if (this.detectedPublicHost) {
      return this.detectedPublicHost;
    }
    
    this.refreshExternalHostIfStale();
    
    return this.externalHost || 'localhost';
  }

  // Set a manual host override for external clients
  setExternalHost(host) {
    this.configuredHost = host;
    // TODO: Add proper logging - Management server external host set
  }
  
  setupMiddleware() {
    // Enable CORS for client connections
    this.app.use(cors({
      origin: true, // Allow all origins for now
      credentials: true
    }));
    
    // Parse JSON requests
    this.app.use(express.json({ limit: '50mb' }));
    
    // Middleware to detect public host from client connections
    this.app.use((req, _, next) => {
      // Extract host from request headers (what clients used to connect)
      const hostHeader = req.get('host');
      this.updateDetectedPublicHost(hostHeader);
      next();
    });
    
    // Logging middleware
    this.app.use((_, __, next) => {
      next();
    });
  }
  
  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (_, res) => {
      res.json({
        status: 'ok',
        server: 'minecraft-core-management',
        version: this.appVersion,
        appVersion: this.appVersion, // Explicit app version field
        serverPath: this.serverPath
      });
    });

    // Server-Sent Events endpoint for clients to receive updates
    this.app.get('/api/events', (req, res) => {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.flushHeaders();
      this.sseClients.push(res);
      req.on('close', () => {
        this.sseClients = this.sseClients.filter(c => c !== res);
      });
    });

    // Endpoint to query current server version (Minecraft)
    this.app.get('/api/server/version', (_, res) => {
      res.json({ success: true, version: this.versionInfo });
    });

    // Endpoint to query current app version
    this.app.get('/api/app/version', (_, res) => {
      res.json({ 
        success: true, 
        appVersion: this.appVersion,
        version: this.appVersion, // Backward compatibility
        timestamp: new Date().toISOString()
      });
  });    // Client registration
    this.app.post('/api/client/register', (req, res) => {
      const { clientId, name } = req.body;
      
      if (!clientId || !name) {
        return res.status(400).json({ error: 'Client ID and name required' });
      }
      
      // Generate a session token
      const token = createHash('sha256')
        .update(`${clientId}-${Date.now()}-${Math.random()}`)
        .digest('hex');
      
      // Store client info
      this.clients.set(clientId, {
        id: clientId,
        name,
        token,
        registeredAt: new Date(),
        lastSeen: new Date()
      });
      
      // Start cleanup interval when first client connects
      if (this.clients.size === 1 && !this.clientCleanupInterval) {
        
        this.startClientCleanup();
      }
      
      res.json({ 
        success: true, 
        token,
        serverInfo: {
          serverPath: this.serverPath,
          hasServer: !!this.serverPath,
          appVersion: this.appVersion // Include app version in registration response
        }
      });
  });    // Client heartbeat/ping to keep connection alive
    this.app.post('/api/client/ping', (req, res) => {
      const { clientId } = req.body;
      
      if (!clientId) {
        return res.status(400).json({ error: 'Client ID required' });
      }
      
      const client = this.clients.get(clientId);
      if (client) {
        client.lastSeen = new Date();
        this.clients.set(clientId, client);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Client not found' });
      }
    });
    
    // Client disconnection
    this.app.post('/api/client/disconnect', (req, res) => {
      const { clientId } = req.body;
      
      if (!clientId) {
        return res.status(400).json({ error: 'Client ID required' });
      }
      
      const client = this.clients.get(clientId);
      if (client) {
        this.clients.delete(clientId);
        
        // Stop cleanup interval when no clients remain
        if (this.clients.size === 0 && this.clientCleanupInterval) {
          
          this.stopClientCleanup();
        }
        
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Client not found' });
      }
    });
    
    // Get server information
    this.app.get('/api/server/info', async (req, res) => {
      if (!this.serverPath) {
        return res.status(404).json({ error: 'No server configured' });
      }
      
      try {
        // Read server properties if they exist
        const serverPropsPath = path.join(this.serverPath, 'server.properties');
        let serverProps = {};
        
        if (fs.existsSync(serverPropsPath)) {
          const propsContent = fs.readFileSync(serverPropsPath, 'utf8');
          const lines = propsContent.split('\n');
          
          for (const line of lines) {
            if (line.trim() && !line.startsWith('#')) {
              const [key, value] = line.split('=');
              if (key && value !== undefined) {
                serverProps[key.trim()] = value.trim();
              }
            }
          }
        }
          // Get Minecraft version from .minecraft-core.json, server jar name or version.json
        let minecraftVersion = 'unknown';
        let serverJars = [];
          // First priority: check .minecraft-core.json config file
          const minecraftCoreConfigPath = path.join(this.serverPath, '.minecraft-core.json');
          if (fs.existsSync(minecraftCoreConfigPath)) {
            try {
              const coreConfig = JSON.parse(fs.readFileSync(minecraftCoreConfigPath, 'utf8'));
              if (coreConfig.version) {
                minecraftVersion = coreConfig.version;
              }
            } catch {
              // Config file exists but is invalid, continue with other detection methods
            }
          }
          
          // Second priority: try to find version from server jar files
          if (minecraftVersion === 'unknown') {
            const files = fs.readdirSync(this.serverPath);
            serverJars = files.filter(file =>
              file.endsWith('.jar') && (
                file.includes('server') ||
                file.includes('minecraft') ||
                file.includes('paper') || 
                file.includes('forge') || 
                file.includes('fabric') ||
                file === 'fabric-server-launch.jar'
              )
            );          
            if (serverJars.length > 0) {
              const jarName = serverJars[0];
            
            // Extract version from jar name (e.g., "minecraft_server.1.20.1.jar" or "paper-1.20.1-196.jar")
            const versionMatch = jarName.match(/(\d+\.\d+(?:\.\d+)?)/);
            if (versionMatch) {
              minecraftVersion = versionMatch[1];
            }
            }
          }
          
          // If no version found from jar name, try reading from version.json if it exists
          if (minecraftVersion === 'unknown') {
            const versionPath = path.join(this.serverPath, 'version.json');
            if (fs.existsSync(versionPath)) {
              const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
              if (versionData.name || versionData.id) {
                minecraftVersion = versionData.name || versionData.id;
              }
            }
          }
          
          // If still unknown, try to extract from launcher profile or version logs
          if (minecraftVersion === 'unknown') {
            // Check for Fabric loader version info
            const fabricLoaderPath = path.join(this.serverPath, '.fabric', 'remappedJars');
            if (fs.existsSync(fabricLoaderPath)) {
              const fabricFiles = fs.readdirSync(fabricLoaderPath);
              for (const file of fabricFiles) {
                const match = file.match(/minecraft-(\d+\.\d+(?:\.\d+)?)/);
                if (match) {
                  minecraftVersion = match[1];
                  break;
                }
              }
            }
          }
          
          // If still unknown, try to find version in logs directory
          if (minecraftVersion === 'unknown') {
            const logsPath = path.join(this.serverPath, 'logs');
            if (fs.existsSync(logsPath)) {
              const latestLog = path.join(logsPath, 'latest.log');
              if (fs.existsSync(latestLog)) {
                const logContent = fs.readFileSync(latestLog, 'utf8');
                const versionMatch = logContent.match(/Starting minecraft server version (\d+\.\d+(?:\.\d+)?)|Minecraft (\d+\.\d+(?:\.\d+)?)|version (\d+\.\d+(?:\.\d+)?)/i);
                if (versionMatch) {
                  minecraftVersion = versionMatch[1] || versionMatch[2] || versionMatch[3];
                }
              }
            }
          }
          
          // If still unknown, try to check launch scripts (start.bat, start.sh, run.bat, run.sh)
          if (minecraftVersion === 'unknown') {
            const scriptFiles = ['start.bat', 'start.sh', 'run.bat', 'run.sh', 'launch.bat', 'launch.sh'];
            for (const scriptFile of scriptFiles) {
              const scriptPath = path.join(this.serverPath, scriptFile);
              if (fs.existsSync(scriptPath)) {
                const scriptContent = fs.readFileSync(scriptPath, 'utf8');
                const versionMatch = scriptContent.match(/(\d+\.\d+(?:\.\d+)?)/);
                if (versionMatch) {
                  minecraftVersion = versionMatch[1];
                  break;
                }
              }
            }
          }
          
          // If still unknown, try more comprehensive jar name patterns
          if (minecraftVersion === 'unknown' && serverJars.length > 0) {
            for (const jarName of serverJars) {
              // Try different patterns: server-1.20.1.jar, spigot-1.20.1.jar, etc.
              const patterns = [
                /(\d+\.\d+(?:\.\d+)?)-(?:server|spigot|paper|forge|fabric)/i,
                /(?:server|spigot|paper|forge|fabric)-(\d+\.\d+(?:\.\d+)?)/i,
                /mc-?(\d+\.\d+(?:\.\d+)?)/i,
                /minecraft-?(\d+\.\d+(?:\.\d+)?)/i
              ];
              
              for (const pattern of patterns) {
                const match = jarName.match(pattern);
                if (match) {
                  minecraftVersion = match[1];
                  break;
                }
              }
              
              if (minecraftVersion !== 'unknown') break;
            }
                    }
          
        // If version is still unknown after all detection methods, 
        // users can manually create .minecraft-core.json with their version

        // Get required mods for clients
        const requiredMods = await this.getRequiredMods(req);
        
        // Get all client mods (required + optional)
        const allClientMods = await this.getAllClientMods(req);
        
        // Check Minecraft server status
        const minecraftServerStatus = await this.checkMinecraftServerStatus();
          // Detect server loader type (Fabric/Forge/Vanilla)
        let loaderType = 'vanilla';
        let loaderVersion = null;
        
        // First priority: check .minecraft-core.json config file for loader info
        if (fs.existsSync(minecraftCoreConfigPath)) {
          const coreConfig = JSON.parse(fs.readFileSync(minecraftCoreConfigPath, 'utf8'));
          if (coreConfig.fabric) {
            loaderType = 'fabric';
            loaderVersion = coreConfig.fabric;
          }
        }
        
        // Fallback: Check for Fabric launcher jar
        if (loaderType === 'vanilla') {
          const fabricLaunchJar = path.join(this.serverPath, 'fabric-server-launch.jar');
          if (fs.existsSync(fabricLaunchJar)) {
            loaderType = 'fabric';
            const configPath = path.join(this.serverPath, 'config.json');
            if (fs.existsSync(configPath)) {
              const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              loaderVersion = config.fabric || config.loaderVersion;
            }
          }
        }
        
        // Check for Forge (forge-server.jar or forge in filename)
        if (loaderType === 'vanilla') {
          const serverFiles = fs.readdirSync(this.serverPath);
          for (const file of serverFiles) {
            if (file.includes('forge') && file.endsWith('.jar') && file !== 'fabric-server-launch.jar') {
              loaderType = 'forge';
              const match = file.match(/forge[.-](\d+\.\d+\.\d+)/i);
              if (match) loaderVersion = match[1];
              break;
            }
          }
        }
        
        res.json({
          success: true,
          serverPath: this.serverPath,
          serverProperties: serverProps,
          minecraftPort: serverProps['server-port'] || '25565',
          minecraftServerStatus: minecraftServerStatus,
          minecraftVersion: minecraftVersion,
          loaderType: loaderType,
          loaderVersion: loaderVersion,
          requiredMods: requiredMods,
          allClientMods: allClientMods,
          appVersion: this.appVersion, // Include app version in server info
          serverInfo: {
            name: serverProps['motd'] || 'Minecraft Server',
            maxPlayers: parseInt(serverProps['max-players']) || 20,
            gamemode: serverProps['gamemode'] || 'survival',
            difficulty: serverProps['difficulty'] || 'normal'
          }
        });
      } catch {
        res.status(500).json({ error: 'Failed to read server information' });
      }
    });

    // Lightweight Minecraft server status (parity with browser-panel-server /api/server/status)
    // Provides immediate running/stopped state plus metrics so browser client using only the
    // management server port (default 8080) can still poll for status without 404s.
    let statusVersionCounter = 0;
    let lastIsRunning = null;
    let lastTransitionTs = 0;
    this.app.get('/api/server/status', (_req, res) => {
      try {
        const serverManager = require('./server-manager.cjs');
        const state = serverManager.getServerState();
        const isRunning = !!state.isRunning && !!state.serverProcess;
        if (lastIsRunning === null) {
          lastIsRunning = isRunning;
          lastTransitionTs = Date.now();
        } else if (lastIsRunning !== isRunning) {
          lastIsRunning = isRunning;
          statusVersionCounter++;
          lastTransitionTs = Date.now();
          try {
            // Notify desktop renderer (mirrors browser panel behavior)
            const { safeSend } = require('../utils/safe-send.cjs');
            safeSend && safeSend('server-status', isRunning ? 'running' : 'stopped');
          } catch { /* ignore */ }
        }
        const info = state.serverProcess ? state.serverProcess['serverInfo'] : null;
        const uptime = state.serverStartMs ? (Date.now() - state.serverStartMs) : 0;
        const players = state.playersInfo || { count: 0, names: [] };
        let cpuPct = 0, memUsedMB = 0, maxRamMB = (state.serverMaxRam || 4) * 1024;
        try {
          const { getLastMetrics } = require('./system-metrics.cjs');
          const last = getLastMetrics && getLastMetrics();
          if (last) {
            if (typeof last.cpuPct === 'number') cpuPct = last.cpuPct;
            if (typeof last.memUsedMB === 'number') memUsedMB = last.memUsedMB;
            if (typeof last.maxRamMB === 'number') maxRamMB = last.maxRamMB;
          }
        } catch { /* ignore metrics errors */ }
        res.json({ success: true, isRunning, serverInfo: info, uptimeMs: uptime, players, cpuPct, memUsedMB, maxRamMB, statusVersion: statusVersionCounter, lastTransitionTs });
      } catch (e) {
        res.json({ success: false, error: e.message });
      }
    });
    
    // Get mod list
    this.app.get('/api/mods/list', (_, res) => {
      if (!this.serverPath) {
        return res.status(404).json({ error: 'No server configured' });
      }
      
      try {
        const modsDir = path.join(this.serverPath, 'mods');
        const clientModsDir = path.join(this.serverPath, 'client', 'mods');
        
        let serverMods = [];
        let clientMods = [];
        
        // Read server mods
        if (fs.existsSync(modsDir)) {
          serverMods = fs.readdirSync(modsDir)
            .filter(file => file.endsWith('.jar'))
            .map(file => ({
              fileName: file,
              location: 'server',
              size: fs.statSync(path.join(modsDir, file)).size,
              lastModified: fs.statSync(path.join(modsDir, file)).mtime
            }));
        }
        
        // Read client mods
        if (fs.existsSync(clientModsDir)) {
          clientMods = fs.readdirSync(clientModsDir)
            .filter(file => file.endsWith('.jar'))
            .map(file => ({
              fileName: file,
              location: 'client',
              size: fs.statSync(path.join(clientModsDir, file)).size,
              lastModified: fs.statSync(path.join(clientModsDir, file)).mtime
            }));
        }
        
        // Find mods that exist in both locations
        const bothMods = [];
        for (const serverMod of serverMods) {
          const clientMod = clientMods.find(cm => cm.fileName === serverMod.fileName);
          if (clientMod) {
            bothMods.push({
              fileName: serverMod.fileName,
              location: 'both',
              serverSize: serverMod.size,
              clientSize: clientMod.size,
              serverLastModified: serverMod.lastModified,
              clientLastModified: clientMod.lastModified
            });
            
            // Remove from individual arrays
            serverMods = serverMods.filter(sm => sm.fileName !== serverMod.fileName);
            clientMods = clientMods.filter(cm => cm.fileName !== serverMod.fileName);
          }
        }
        
        res.json({
          success: true,
          mods: {
            server: serverMods,
            client: clientMods,
            both: bothMods,
            total: serverMods.length + clientMods.length + bothMods.length
          }
        });
      } catch {
        res.status(500).json({ error: 'Failed to read mod list' });
      }
    });
    
    // Download mod file
    this.app.get('/api/mods/download/:fileName', (req, res) => {
      if (!this.serverPath) {
        return res.status(404).json({ error: 'No server configured' });
      }
      
      const { fileName } = req.params;
      const { location = 'server' } = req.query;
      const locationParam = typeof location === 'string' ? location : 'server';
      const requestHost = req.get('host') || 'unknown';
      this.updateDetectedPublicHost(requestHost);
      const downloadHost = this.getModDownloadHost();
      
      if (!fileName || !fileName.endsWith('.jar')) {
        return res.status(400).json({ error: 'Invalid file name' });
      }
      
      try {
        let modPath;
        if (locationParam === 'client') {
          modPath = path.join(this.serverPath, 'client', 'mods', fileName);
        } else {
          modPath = path.join(this.serverPath, 'mods', fileName);
        }
        
        if (!fs.existsSync(modPath)) {
          console.warn('[mods-download] file not found', { fileName, location: locationParam, requestHost, downloadHost });
          return res.status(404).json({ error: 'Mod file not found' });
        }

        console.info('[mods-download] serving', { fileName, location: locationParam, requestHost, downloadHost, modPath });
        
        res.setHeader('Content-Type', 'application/java-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        
        const fileStream = fs.createReadStream(modPath);
        
        fileStream.on('error', (err) => {
          console.warn('[mods-download] stream error', { fileName, location: locationParam, requestHost, downloadHost, error: err?.message });
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to serve mod file' });
          }
        });
        
        fileStream.on('end', () => {
        });
        
        fileStream.pipe(res);
        
      } catch {
        res.status(500).json({ error: 'Failed to serve mod file' });
      }
    });

    // List assets (shaderpacks or resourcepacks) available for clients
    this.app.get('/api/assets/list/:type', (req, res) => {
      if (!this.serverPath) {
        return res.status(404).json({ error: 'No server configured' });
      }

      const { type } = req.params;
      const validTypes = new Set(['shaderpacks', 'resourcepacks']);
      if (!validTypes.has(type)) {
        return res.status(400).json({ error: 'Invalid asset type' });
      }

      try {
        const assetsDir = path.join(this.serverPath, 'client', type);
        if (!fs.existsSync(assetsDir)) {
          // If directory does not exist, return empty list
          return res.json({ success: true, type, items: [] });
        }

        const files = fs.readdirSync(assetsDir);
        // Extract version from filename helper (e.g., "Name r1.2.3.zip" or "Name v1.2.zip")
        function extractVersionFromFilename(fileName) {
          if (!fileName) return null;
          const base = fileName.replace(/\.(zip|jar)$/i, '');
          // Allow optional separators, optional 'v' and/or 'r' before version digits, and optional suffixes like -beta9
          const match = base.match(/(?:^|[-_\s])(?:v?r?|rv)?\s*(\d+(?:\.\d+)*(?:-[A-Za-z0-9.]+)?)$/i);
          return match ? match[1] : null;
        }
        function cleanName(fileName) {
          const base = fileName.replace(/\.(zip|jar)$/i, '');
          return base
            .replace(/(?:[-_\s])?(?:r\d+(?:\.\d+)*)$/i, '')
            .replace(/(?:[-_\s])?(?:v?\d+(?:\.\d+)*)$/i, '')
            .replace(/(?:[-_\s])?mc[_-]?\d+(?:\.\d+)*$/i, '')
            .replace(/[_-]+/g, ' ')
            .trim();
        }
        // Prefer zip files, but include directories too if present
        const items = files
          .filter(file => file.toLowerCase().endsWith('.zip') || fs.statSync(path.join(assetsDir, file)).isDirectory())
          .map(file => ({
            fileName: file,
            size: (() => { try { return fs.statSync(path.join(assetsDir, file)).size; } catch { return 0; } })(),
            lastModified: (() => { try { return fs.statSync(path.join(assetsDir, file)).mtime; } catch { return new Date(0); } })(),
            downloadUrl: `http://${this.getRequestAwareDownloadHost(req)}:${this.port}/api/assets/download/${type}/${encodeURIComponent(file)}`,
            versionNumber: extractVersionFromFilename(file),
            name: cleanName(file),
            checksum: (() => { try { return this.calculateFileChecksum(path.join(assetsDir, file)); } catch { return null; } })()
          }));

        return res.json({ success: true, type, items });
      } catch {
        return res.status(500).json({ error: 'Failed to list assets' });
      }
    });

    // Download an asset (shaderpack or resourcepack)
    this.app.get('/api/assets/download/:type/:fileName', (req, res) => {
      if (!this.serverPath) {
        return res.status(404).json({ error: 'No server configured' });
      }

      const { type, fileName } = req.params;
      const validTypes = new Set(['shaderpacks', 'resourcepacks']);
      if (!validTypes.has(type)) {
        return res.status(400).json({ error: 'Invalid asset type' });
      }
      if (!fileName) {
        return res.status(400).json({ error: 'Invalid file name' });
      }

      try {
        const assetPath = path.join(this.serverPath, 'client', type, fileName);
        if (!fs.existsSync(assetPath)) {
          return res.status(404).json({ error: 'Asset not found' });
        }

        // Set appropriate content type based on file extension
        if (fileName.toLowerCase().endsWith('.zip')) {
          res.setHeader('Content-Type', 'application/zip');
        } else {
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

        const fileStream = fs.createReadStream(assetPath);
        fileStream.on('error', () => {
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to serve asset file' });
          }
        });
        fileStream.pipe(res);
      } catch {
        return res.status(500).json({ error: 'Failed to serve asset file' });
      }
    });
    
    // Get required mods endpoint
    this.app.get('/api/debug/required-mods', async (req, res) => {
      try {
        const requiredMods = await this.getRequiredMods(req);
        res.json({
          success: true,
          count: requiredMods.length,
          mods: requiredMods,
          serverPath: this.serverPath,
          port: this.port
        });
      } catch {
        res.status(500).json({ error: 'Failed to get required mods' });
      }
    });
    
    // Test connection endpoint
    this.app.get('/api/test', (_, res) => {
      res.json({ 
        success: true, 
        message: 'Management server is running',
        timestamp: new Date().toISOString(),
        clients: this.clients.size
      });
    });
    
    // Get connected clients (for server admin)
    this.app.get('/api/clients', (_, res) => {
      const clientList = Array.from(this.clients.values()).map(client => ({
        id: client.id,
        name: client.name,
        registeredAt: client.registeredAt,
        lastSeen: client.lastSeen
      }));
      
      res.json({ 
        success: true, 
        clients: clientList,
        count: clientList.length
      });
    });

  }
  
  async start(port = 8080, serverPath = null) {
    if (this.isRunning) {
      return { success: true, port: this.port };
    }
    
  this.port = port;
    this.serverPath = serverPath;
    
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        this.isRunning = true;

        // Configure shorter keep-alive to help shutdowns complete faster
        try {
          // These properties exist on Node's http.Server
          this.server.keepAliveTimeout = 1000; // 1s
          this.server.headersTimeout = 2000;   // 2s
        } catch { /* ignore: optional server timeouts not supported in this runtime */ }

        // Track incoming connections for graceful/forced shutdown
        this.server.on('connection', (socket) => {
          try { socket.setKeepAlive(false); } catch { /* noop */ }
          this.activeSockets.add(socket);
          const remove = () => this.activeSockets.delete(socket);
          socket.on('close', remove);
          socket.on('end', remove);
          socket.on('error', remove);
        });

        // Detect external IP for mod downloads
        this.externalHost = this.detectExternalIP();
        // Startup info (reduced)
        // TODO: Add proper logging - Management server started
        
        const currentDownloadHost = this.getModDownloadHost();
        if (currentDownloadHost === 'localhost') {
          // TODO: Add proper logging - Currently using localhost
        }

        // Start version watcher and check versions
        this.startVersionWatcher();
        this.checkVersionChange();
        
        // DON'T start cleanup interval automatically - only when clients connect

        resolve({ 
          success: true, 
          port: this.port, 
          externalHost: this.externalHost, 
          detectedPublicHost: this.detectedPublicHost,
          downloadHost: this.getModDownloadHost()
        });
      });
      
      this.server.on('error', (error) => {
        this.isRunning = false;
        if (error && error['code'] === 'EADDRINUSE') {
          resolve({ success: false, error: `Port ${this.port} is already in use` });
        } else {
          resolve({ success: false, error: error.message });
        }
      });
    });
  }
  
  async stop() {
    if (!this.isRunning || !this.server) {
      return { success: true };
    }
    
    return new Promise((resolve) => {
      const serverRef = this.server;

      // Close any Server-Sent Events streams to allow connections to end
      try {
        if (Array.isArray(this.sseClients) && this.sseClients.length) {
          for (const res of this.sseClients) {
            try { res.end(); } catch { /* ignore: stream may already be closed */ }
          }
        }
      } finally {
        this.sseClients = [];
      }

      let settled = false;
      const finalize = (forced = false, reason = undefined) => {
        if (settled) return;
        settled = true;
        this.isRunning = false;
        this.server = null;
        this.clients.clear();
        // Clear any tracked sockets
        try { this.activeSockets.clear(); } catch { /* ignore */ }
        // Stop client cleanup interval and watchers
        this.stopClientCleanup();
        this.stopVersionWatcher();
        resolve({ success: !forced, forced, reason });
      };

      // Start graceful close
      try {
        serverRef.close(() => finalize(false));
      } catch (e) {
        // If close throws synchronously, force finalize
        finalize(true, e && e.message ? e.message : 'close-threw');
        return;
      }

      // After a timeout, force-destroy any remaining sockets
      const FORCE_TIMEOUT_MS = 5000;
      setTimeout(() => {
        if (settled) return;
        for (const socket of this.activeSockets) {
          try { socket.destroy(); } catch { /* noop */ }
        }
        // Give a brief moment for 'close' to fire after destroying sockets
        setTimeout(() => finalize(true, 'timeout'), 500);
      }, FORCE_TIMEOUT_MS);
    });
  }
    updateServerPath(newPath) {
    this.serverPath = newPath;
    this.stopVersionWatcher();
    
    // Only start version watcher if we have a valid path
    if (newPath) {
      this.startVersionWatcher();
      this.checkVersionChange();
    }
  }  // Check if Minecraft server is running
  async checkMinecraftServerStatus() {
    // Rate limiting - cache status for 30 seconds to prevent excessive checks
    const now = Date.now();
    if (this._lastStatusCheck && (now - this._lastStatusCheck) < 30000 && this._cachedStatus) {
      return this._cachedStatus;
    }

    try {
      // First check if we have an active server process through the server manager
      const serverManager = require('./server-manager.cjs');
      const serverState = serverManager.getServerState();
      
      if (serverState.isRunning && serverState.serverProcess) {
        try {
          // Verify the process is actually still alive
          process.kill(serverState.serverProcess.pid, 0); // Signal 0 just tests if process exists
          this._cachedStatus = 'running';
          this._lastStatusCheck = now;
          return 'running';
        } catch {
          // Process doesn't exist anymore
          this._cachedStatus = 'stopped';
          this._lastStatusCheck = now;
          return 'stopped';
        }
      }
      
      // Fallback: Check for java processes that might be Minecraft servers
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      
      // On Windows, check for java processes running from the server directory
      if (process.platform === 'win32') {        try {
          // More specific check - look for java processes with minecraft-related command lines using centralized WMIC utility
          const { stdout } = await wmicExecAsync(`wmic process where "name='java.exe'" get ProcessId,CommandLine /format:csv`);
          const filteredOutput = stdout;
            
          const lines = filteredOutput.split('\n');
          
          // Look for processes that contain minecraft server indicators
          const minecraftProcesses = lines.filter(line => {
            if (!line.includes('java.exe')) return false;
            
            // More specific checks - only consider it a Minecraft server if it has these specific indicators
            const hasMinecraftServerIndicators = (
              line.includes('fabric-server-launch.jar') ||
              line.includes('minecraft_server.jar') ||
              line.includes('minecraft-core-server') ||
              (line.includes('server.jar') && (line.includes('minecraft') || line.includes('fabric'))) ||
              line.includes('forge-server') ||
              line.includes('spigot') ||
              line.includes('paper') ||
              line.includes('bukkit')
            );
            
            // Exclude common development/IDE processes
            const isNotDevProcess = !(
              line.includes('vs code') ||
              line.includes('vscode') ||
              line.includes('idea') ||
              line.includes('eclipse') ||
              line.includes('netbeans') ||
              line.includes('gradle') ||
              line.includes('maven') ||
              line.includes('intellij') ||
              line.includes('--add-opens=java.base') || // Common IDE/development JVM args
              line.includes('jdtls') ||
              line.includes('language-server')
            );
            
            return hasMinecraftServerIndicators && isNotDevProcess;
          });          
          if (minecraftProcesses.length > 0) {
            this._cachedStatus = 'running';
            this._lastStatusCheck = now;
            return 'running';
          } else {
            this._cachedStatus = 'stopped';
            this._lastStatusCheck = now;
            return 'stopped';
          }
        } catch {
          this._cachedStatus = 'unknown';
          this._lastStatusCheck = now;
          return 'unknown';        }
      } else {
        // On Linux/Mac, use ps to check for java processes
        try {
          const { stdout } = await execAsync('ps aux | grep java | grep -E "(fabric-server|minecraft|server\\.jar)" | grep -v grep', { timeout: 5000 });
          if (stdout.trim()) {
            this._cachedStatus = 'running';
            this._lastStatusCheck = now;
            return 'running';
          } else {
            this._cachedStatus = 'stopped';
            this._lastStatusCheck = now;
            return 'stopped';
          }
        } catch {
          this._cachedStatus = 'stopped';
          this._lastStatusCheck = now;
          return 'stopped';
        }
      }
    } catch {
      this._cachedStatus = 'unknown';
      this._lastStatusCheck = now;
      return 'unknown';
    }
  }
  
  // Get list of required mods for clients
  async getRequiredMods(req = null) {
    if (!this.serverPath) {
      return [];
    }
        
    try {
      const downloadHost = this.getRequestAwareDownloadHost(req);
      const clientModsDir = path.join(this.serverPath, 'client', 'mods');
      const serverModsDir = path.join(this.serverPath, 'mods');
      
      // Load saved mod categories to check requirement status
      let savedCategories = [];
      const { app } = require('electron');
      const configDir = path.join(app.getPath('userData'), 'config');
      const configFile = path.join(configDir, 'mod-categories.json');

      if (fs.existsSync(configFile)) {
        const data = fs.readFileSync(configFile, 'utf8');
        savedCategories = JSON.parse(data);
      }
      
      // Convert categories array to map for easier lookup
      const categoryMap = new Map();
      if (Array.isArray(savedCategories)) {
        savedCategories.forEach(category => {
          if (category.modId) {
            categoryMap.set(category.modId, category);
          }
        });
      }
      
      let requiredMods = [];
        // Client-only mods (mods that should be installed on client)
      if (fs.existsSync(clientModsDir)) {
        const clientMods = fs.readdirSync(clientModsDir)
          .filter(file => file.endsWith('.jar'))
          .map(file => {
            const modPath = path.join(clientModsDir, file);
            const stats = fs.statSync(modPath);
            
            // Check if this mod has saved requirement status
            const savedCategory = categoryMap.get(file);
            const isRequired = savedCategory ? savedCategory.required !== false : true; // Default to required if not specified
            
            // Try to read manifest to get proper Modrinth project ID
            let projectId = null;
            let versionId = null;
            let versionNumber = null;
            let name = null;
            
            const manifestPath = path.join(this.serverPath, 'client', 'minecraft-core-manifests', `${file}.json`);
            if (fs.existsSync(manifestPath)) {
              const manifestContent = fs.readFileSync(manifestPath, 'utf8');
              const manifest = JSON.parse(manifestContent);
              projectId = manifest.projectId || null;
              versionId = manifest.versionId || null;
              versionNumber = manifest.versionNumber || null;
              name = manifest.name || null;
            }
            
            return {
              fileName: file,
              location: 'client',
              size: stats.size,
              lastModified: stats.mtime,
              required: isRequired,
              checksum: this.calculateFileChecksum(modPath),
              downloadUrl: `http://${downloadHost}:${this.port}/api/mods/download/${encodeURIComponent(file)}?location=client`,
              projectId: projectId,
              versionId: versionId,
              versionNumber: versionNumber,
              name: name
            };
          });
        requiredMods = requiredMods.concat(clientMods);
      }
      
      // Mods that exist in both server and client (shared mods)
      if (fs.existsSync(serverModsDir) && fs.existsSync(clientModsDir)) {
        const serverMods = fs.readdirSync(serverModsDir)
          .filter(file => file.endsWith('.jar'));
        const clientMods = fs.readdirSync(clientModsDir)
          .filter(file => file.endsWith('.jar'))
          .map(f => f);
          // Find mods that exist in both directories
        for (const serverMod of serverMods) {
          if (clientMods.includes(serverMod)) {
            const modPath = path.join(clientModsDir, serverMod);
            const stats = fs.statSync(modPath);
            
            // Only add if not already added from client-only scan
            if (!requiredMods.find(m => m.fileName === serverMod)) {
              // Check if this mod has saved requirement status
              const savedCategory = categoryMap.get(serverMod);
              const isRequired = savedCategory ? savedCategory.required !== false : true; // Default to required if not specified
              
              // Try to read manifest to get proper Modrinth project ID
              let projectId = null;
              let versionId = null;
              let versionNumber = null;
              let name = null;
              
              const manifestPath = path.join(this.serverPath, 'client', 'minecraft-core-manifests', `${serverMod}.json`);
              if (fs.existsSync(manifestPath)) {
                const manifestContent = fs.readFileSync(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);
                projectId = manifest.projectId || null;
                versionId = manifest.versionId || null;
                versionNumber = manifest.versionNumber || null;
                name = manifest.name || null;
              }
              
              requiredMods.push({
                fileName: serverMod,
                location: 'both',
                size: stats.size,
                lastModified: stats.mtime,
                required: isRequired,
                checksum: this.calculateFileChecksum(modPath),
                downloadUrl: `http://${downloadHost}:${this.port}/api/mods/download/${encodeURIComponent(serverMod)}?location=client`,
                projectId: projectId,
                versionId: versionId,
                versionNumber: versionNumber,
                name: name
              });
            }
          }
        }
      }
      
      // Filter to only return mods that are actually marked as required
      const actuallyRequiredMods = requiredMods.filter(mod => mod.required);
      
      return actuallyRequiredMods;
    } catch {
      return [];
    }
  }
  // Get all client mods (both required and optional)
  async getAllClientMods(req = null) {
    if (!this.serverPath) {
      return [];
    }
    
    try {      const downloadHost = this.getRequestAwareDownloadHost(req);
      const clientModsDir = path.join(this.serverPath, 'client', 'mods');
      const serverModsDir = path.join(this.serverPath, 'mods');

      // Load saved mod categories to check requirement status
      let savedCategories = [];
      const { app } = require('electron');
      const configDir = path.join(app.getPath('userData'), 'config');
      const configFile = path.join(configDir, 'mod-categories.json');

      if (fs.existsSync(configFile)) {
        const data = fs.readFileSync(configFile, 'utf8');
        savedCategories = JSON.parse(data);
      }
      
      // Convert categories array to map for easier lookup
      const categoryMap = new Map();
      if (Array.isArray(savedCategories)) {
        savedCategories.forEach(category => {
          if (category.modId) {
            categoryMap.set(category.modId, category);
          }
        });
      }
      
      let allClientMods = [];
        // Client-only mods
      if (fs.existsSync(clientModsDir)) {
        const clientMods = fs.readdirSync(clientModsDir)
          .filter(file => file.endsWith('.jar'))
          .map(file => {
            const modPath = path.join(clientModsDir, file);
            const stats = fs.statSync(modPath);
            
            // Check if this mod has saved requirement status
            const savedCategory = categoryMap.get(file);
            const isRequired = savedCategory ? savedCategory.required !== false : true; // Default to required if not specified
            
            // Try to read manifest to get proper Modrinth project ID
            let projectId = null;
            let versionId = null;
            let versionNumber = null;
            let name = null;
            
            const manifestPath = path.join(this.serverPath, 'client', 'minecraft-core-manifests', `${file}.json`);
            if (fs.existsSync(manifestPath)) {
              const manifestContent = fs.readFileSync(manifestPath, 'utf8');
              const manifest = JSON.parse(manifestContent);
              projectId = manifest.projectId || null;
              versionId = manifest.versionId || null;
              versionNumber = manifest.versionNumber || null;
              name = manifest.name || null;
            }
            
            return {
              fileName: file,
              location: 'client',
              size: stats.size,
              lastModified: stats.mtime,
              required: isRequired,
              checksum: this.calculateFileChecksum(modPath),
              downloadUrl: `http://${downloadHost}:${this.port}/api/mods/download/${encodeURIComponent(file)}?location=client`,
              projectId: projectId,
              versionId: versionId,
              versionNumber: versionNumber,
              name: name
            };
          });
        allClientMods = allClientMods.concat(clientMods);
      }
      
      // Mods that exist in both server and client (shared mods)
      if (fs.existsSync(serverModsDir) && fs.existsSync(clientModsDir)) {
        const serverMods = fs.readdirSync(serverModsDir)
          .filter(file => file.endsWith('.jar'));
        const clientMods = fs.readdirSync(clientModsDir)
          .filter(file => file.endsWith('.jar'))
          .map(f => f);
          // Find mods that exist in both directories
        for (const serverMod of serverMods) {
          if (clientMods.includes(serverMod)) {
            const modPath = path.join(clientModsDir, serverMod);
            const stats = fs.statSync(modPath);
            
            // Only add if not already added from client-only scan
            if (!allClientMods.find(m => m.fileName === serverMod)) {
              // Check if this mod has saved requirement status
              const savedCategory = categoryMap.get(serverMod);
              const isRequired = savedCategory ? savedCategory.required !== false : true; // Default to required if not specified
              
              // Try to read manifest to get proper Modrinth project ID
              let projectId = null;
              let versionId = null;
              let versionNumber = null;
              let name = null;
              
              const manifestPath = path.join(this.serverPath, 'client', 'minecraft-core-manifests', `${serverMod}.json`);
              if (fs.existsSync(manifestPath)) {
                const manifestContent = fs.readFileSync(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);
                projectId = manifest.projectId || null;
                versionId = manifest.versionId || null;
                versionNumber = manifest.versionNumber || null;
                name = manifest.name || null;
              }
              
              allClientMods.push({
                fileName: serverMod,
                location: 'both',
                size: stats.size,
                lastModified: stats.mtime,
                required: isRequired,
                checksum: this.calculateFileChecksum(modPath),
                downloadUrl: `http://${downloadHost}:${this.port}/api/mods/download/${encodeURIComponent(serverMod)}?location=client`,
                projectId: projectId,
                versionId: versionId,
                versionNumber: versionNumber,
                name: name
              });
            }
          }        }
      }
      
      return allClientMods;
    } catch {
      // TODO: Add proper logging - getAllClientMods failed
      return [];
    }
  }
  
  // Calculate file checksum for integrity verification
  calculateFileChecksum(filePath) {
    try {
      const fileContent = fs.readFileSync(filePath);
      return createHash('md5').update(fileContent).digest('hex');
    } catch {
      return null;
    }
  }
  
  // Start client cleanup interval
  startClientCleanup() {
    if (this.clientCleanupInterval) {
      return; // Already running
    }
    
    this.clientCleanupInterval = setInterval(() => {
      this.cleanupStaleClients();
    }, 30000);
  }
  
  // Stop client cleanup interval
  stopClientCleanup() {
    if (this.clientCleanupInterval) {
      clearInterval(this.clientCleanupInterval);
      this.clientCleanupInterval = null;
    }
  }
  
  // Remove clients that haven't been seen for more than 2 minutes
  cleanupStaleClients() {
    const now = Date.now();
    const staleThreshold = 2 * 60 * 1000; // 2 minutes in milliseconds
    const staleClients = [];

    for (const [clientId, client] of this.clients) {
      const timeSinceLastSeen = now - client.lastSeen.getTime();
      if (timeSinceLastSeen > staleThreshold) {
        staleClients.push(clientId);
      }
    }
    
    if (staleClients.length > 0) {
      staleClients.forEach(clientId => {
        const client = this.clients.get(clientId);
        if (client) {
          this.clients.delete(clientId);
        }
      });
      
    }
    
    // Stop cleanup interval if no clients remain
    if (this.clients.size === 0 && this.clientCleanupInterval) {
      
      this.stopClientCleanup();
    }
  }

  broadcastEvent(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.sseClients.forEach(res => {
      if (!res.writableEnded) {
        res.write(payload);
      }
    });
    eventBus.emit(event, data);
  }
  startVersionWatcher() {
    if (!this.serverPath) return;
    
    try {
      // Check if path exists before watching
      if (!fs.existsSync(this.serverPath)) {
        return;
      }
      
      this.versionWatcher = fs.watch(this.serverPath, (_, filename) => {
        if (!filename) return;
        if (filename.endsWith('.jar') || filename === 'version.json') {
          this.checkVersionChange();
        }
      });
      
      // Handle watcher errors (like EPERM when directory is deleted)
      this.versionWatcher.on('error', () => {
        // TODO: Add proper logging - Version watcher error
      });
    } catch {
      // TODO: Add proper logging - Failed to start version watcher
    }
  }
  stopVersionWatcher() {
    if (this.versionWatcher) {
      try {
        this.versionWatcher.close();
      } catch {
        // Ignore close errors - watcher might already be closed
        // TODO: Add proper logging - Version watcher close error
      }
      this.versionWatcher = null;
    }
  }
  async detectServerVersions() {
    if (!this.serverPath) return { minecraftVersion: null, loaderType: null, loaderVersion: null };
    let minecraftVersion = 'unknown';
    let loaderType = 'vanilla';
    let loaderVersion = null;
    try {
      // First priority: check .minecraft-core.json config file
      const minecraftCoreConfigPath = path.join(this.serverPath, '.minecraft-core.json');
      if (fs.existsSync(minecraftCoreConfigPath)) {
        const coreConfig = JSON.parse(fs.readFileSync(minecraftCoreConfigPath, 'utf8'));
        if (coreConfig.version) {
          minecraftVersion = coreConfig.version;
        }
        if (coreConfig.fabric) {
          loaderType = 'fabric';
          loaderVersion = coreConfig.fabric;
        }
      }
      
      // Fallback: check JAR files and other sources
      if (minecraftVersion === 'unknown') {
        const files = fs.readdirSync(this.serverPath);
        const serverJars = files.filter(f => f.endsWith('.jar'));
        if (serverJars.length > 0) {
          const match = serverJars[0].match(/(\d+\.\d+(?:\.\d+)?)/);
          if (match) minecraftVersion = match[1];
        }
      }
      
      if (minecraftVersion === 'unknown') {
        const versionPath = path.join(this.serverPath, 'version.json');
        if (fs.existsSync(versionPath)) {
          const data = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
          minecraftVersion = data.name || data.id || minecraftVersion;
        }
      }
      
      // Check for Fabric if not already detected from .minecraft-core.json
      if (loaderType === 'vanilla') {
        const fabricLaunchJar = path.join(this.serverPath, 'fabric-server-launch.jar');
        if (fs.existsSync(fabricLaunchJar)) {
          loaderType = 'fabric';
          const configPath = path.join(this.serverPath, 'config.json');
          if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            loaderVersion = cfg.fabric || cfg.loaderVersion || null;
          }
        }
      }
    } catch {
      return { minecraftVersion, loaderType, loaderVersion };
    }
    return { minecraftVersion, loaderType, loaderVersion };
  }

  async checkVersionChange() {
    const info = await this.detectServerVersions();
    if (!this.versionInfo ||
        info.minecraftVersion !== this.versionInfo.minecraftVersion ||
        info.loaderType !== this.versionInfo.loaderType ||
        info.loaderVersion !== this.versionInfo.loaderVersion) {
      const requiredMods = await this.getRequiredMods();
      const allClientMods = await this.getAllClientMods();
      this.versionInfo = info;
      this.broadcastEvent('server-version-changed', { ...info, port: this.port, serverPath: this.serverPath, requiredMods, allClientMods });
    }
  }
  
  getStatus() {
    return {
      isRunning: this.isRunning,
      port: this.port,
      serverPath: this.serverPath,
      clientCount: this.clients.size,
      version: this.versionInfo,
      appVersion: this.appVersion, // Include app version in status
      downloadHost: this.getModDownloadHost(),
      externalHost: this.externalHost,
      detectedPublicHost: this.detectedPublicHost,
      configuredHost: this.configuredHost
    };
  }
}

// Singleton instance
let managementServerInstance = null;

function getManagementServer() {
  if (!managementServerInstance) {
    managementServerInstance = new ManagementServer();
  }
  return managementServerInstance;
}

module.exports = {
  ManagementServer,
  getManagementServer
}; 
