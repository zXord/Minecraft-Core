// Management server for client-server communication
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

class ManagementServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.port = 8080; // Default management port (different from Minecraft)
    this.isRunning = false;
    this.serverPath = null;
    this.clients = new Map(); // Track connected clients
    this.clientCleanupInterval = null; // Interval for cleaning up stale clients
    
    this.setupMiddleware();
    this.setupRoutes();
  }
  
  setupMiddleware() {
    // Enable CORS for client connections
    this.app.use(cors({
      origin: true, // Allow all origins for now
      credentials: true
    }));
    
    // Parse JSON requests
    this.app.use(express.json({ limit: '50mb' }));
    
    // Logging middleware
    this.app.use((req, res, next) => {
      console.log(`[ManagementServer] ${req.method} ${req.path}`);
      next();
    });
  }
  
  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        server: 'minecraft-core-management',
        version: '1.0.0',
        serverPath: this.serverPath
      });
    });
    
    // Client registration
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
      
      console.log(`[ManagementServer] Client registered: ${name} (${clientId})`);
      
      res.json({ 
        success: true, 
        token,
        serverInfo: {
          serverPath: this.serverPath,
          hasServer: !!this.serverPath
        }
      });
    });
    
    // Client heartbeat/ping to keep connection alive
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
        console.log(`[ManagementServer] Client disconnected: ${client.name} (${clientId})`);
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
        
        // Get Minecraft version from server jar name or version.json
        let minecraftVersion = 'unknown';
        try {
          // First, try to find version from server jar files
          const files = fs.readdirSync(this.serverPath);
          const serverJars = files.filter(file => 
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
            console.log(`[ManagementServer] Found server jar: ${jarName}`);
            
            // Extract version from jar name (e.g., "minecraft_server.1.20.1.jar" or "paper-1.20.1-196.jar")
            const versionMatch = jarName.match(/(\d+\.\d+(?:\.\d+)?)/);
            if (versionMatch) {
              minecraftVersion = versionMatch[1];
              console.log(`[ManagementServer] Extracted version from jar name: ${minecraftVersion}`);
            }
          }
          
          // If no version found from jar name, try reading from version.json if it exists
          if (minecraftVersion === 'unknown') {
            const versionPath = path.join(this.serverPath, 'version.json');
            if (fs.existsSync(versionPath)) {
              const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
              if (versionData.name || versionData.id) {
                minecraftVersion = versionData.name || versionData.id;
                console.log(`[ManagementServer] Found version in version.json: ${minecraftVersion}`);
              }
            }
          }
          
          // If still unknown, try to extract from launcher profile or version logs
          if (minecraftVersion === 'unknown') {
            // Check for Fabric loader version info
            const fabricLoaderPath = path.join(this.serverPath, '.fabric', 'remappedJars');
            if (fs.existsSync(fabricLoaderPath)) {
              try {
                const fabricFiles = fs.readdirSync(fabricLoaderPath);
                for (const file of fabricFiles) {
                  const match = file.match(/minecraft-(\d+\.\d+(?:\.\d+)?)/);
                  if (match) {
                    minecraftVersion = match[1];
                    console.log(`[ManagementServer] Found version in Fabric files: ${minecraftVersion}`);
                    break;
                  }
                }
              } catch (err) {
                console.warn('[ManagementServer] Error reading Fabric directory:', err.message);
              }
            }
          }
          
          // If still unknown, try to find version in logs directory
          if (minecraftVersion === 'unknown') {
            const logsPath = path.join(this.serverPath, 'logs');
            if (fs.existsSync(logsPath)) {
              try {
                const latestLog = path.join(logsPath, 'latest.log');
                if (fs.existsSync(latestLog)) {
                  const logContent = fs.readFileSync(latestLog, 'utf8');
                  // Look for version in server startup logs
                  const versionMatch = logContent.match(/Starting minecraft server version (\d+\.\d+(?:\.\d+)?)|Minecraft (\d+\.\d+(?:\.\d+)?)|version (\d+\.\d+(?:\.\d+)?)/i);
                  if (versionMatch) {
                    minecraftVersion = versionMatch[1] || versionMatch[2] || versionMatch[3];
                    console.log(`[ManagementServer] Found version in server logs: ${minecraftVersion}`);
                  }
                }
              } catch (err) {
                console.warn('[ManagementServer] Error reading server logs:', err.message);
              }
            }
          }
          
          // If still unknown, try to check launch scripts (start.bat, start.sh, run.bat, run.sh)
          if (minecraftVersion === 'unknown') {
            const scriptFiles = ['start.bat', 'start.sh', 'run.bat', 'run.sh', 'launch.bat', 'launch.sh'];
            for (const scriptFile of scriptFiles) {
              const scriptPath = path.join(this.serverPath, scriptFile);
              if (fs.existsSync(scriptPath)) {
                try {
                  const scriptContent = fs.readFileSync(scriptPath, 'utf8');
                  const versionMatch = scriptContent.match(/(\d+\.\d+(?:\.\d+)?)/);
                  if (versionMatch) {
                    minecraftVersion = versionMatch[1];
                    console.log(`[ManagementServer] Found version in ${scriptFile}: ${minecraftVersion}`);
                    break;
                  }
                } catch (err) {
                  console.warn(`[ManagementServer] Error reading ${scriptFile}:`, err.message);
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
                  console.log(`[ManagementServer] Found version using pattern ${pattern} on ${jarName}: ${minecraftVersion}`);
                  break;
                }
              }
              
              if (minecraftVersion !== 'unknown') break;
            }
          }
          
        } catch (versionError) {
          console.warn('[ManagementServer] Could not determine Minecraft version:', versionError);
        }
        
        // Get required mods for clients
        const requiredMods = await this.getRequiredMods();
        
        // Get all client mods (required + optional)
        const allClientMods = await this.getAllClientMods();
        
        // Check Minecraft server status
        const minecraftServerStatus = await this.checkMinecraftServerStatus();
        
        // Detect server loader type (Fabric/Forge/Vanilla)
        let loaderType = 'vanilla';
        let loaderVersion = null;
        
        // Check for Fabric
        const fabricLaunchJar = path.join(this.serverPath, 'fabric-server-launch.jar');
        if (fs.existsSync(fabricLaunchJar)) {
          loaderType = 'fabric';
          
          // Try to get Fabric version from config or files
          try {
            const configPath = path.join(this.serverPath, 'config.json');
            if (fs.existsSync(configPath)) {
              const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
              loaderVersion = config.fabric || config.loaderVersion;
            }
          } catch (e) {
            // Ignore config read errors
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
          serverInfo: {
            name: serverProps['motd'] || 'Minecraft Server',
            maxPlayers: parseInt(serverProps['max-players']) || 20,
            gamemode: serverProps['gamemode'] || 'survival',
            difficulty: serverProps['difficulty'] || 'normal'
          }
        });
      } catch (error) {
        console.error('[ManagementServer] Error reading server info:', error);
        res.status(500).json({ error: 'Failed to read server information' });
      }
    });
    
    // Get mod list
    this.app.get('/api/mods/list', (req, res) => {
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
      } catch (error) {
        console.error('[ManagementServer] Error reading mod list:', error);
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
      
      if (!fileName || !fileName.endsWith('.jar')) {
        return res.status(400).json({ error: 'Invalid file name' });
      }
      
      try {
        let modPath;
        if (location === 'client') {
          modPath = path.join(this.serverPath, 'client', 'mods', fileName);
        } else {
          modPath = path.join(this.serverPath, 'mods', fileName);
        }
        
        if (!fs.existsSync(modPath)) {
          return res.status(404).json({ error: 'Mod file not found' });
        }
        
        // Set appropriate headers for file download
        res.setHeader('Content-Type', 'application/java-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        
        // Stream the file
        const fileStream = fs.createReadStream(modPath);
        fileStream.pipe(res);
        
        console.log(`[ManagementServer] Serving mod file: ${fileName} from ${location}`);
      } catch (error) {
        console.error('[ManagementServer] Error serving mod file:', error);
        res.status(500).json({ error: 'Failed to serve mod file' });
      }
    });
    
    // Debug: Get required mods endpoint
    this.app.get('/api/debug/required-mods', async (req, res) => {
      try {
        const requiredMods = await this.getRequiredMods();
        res.json({
          success: true,
          count: requiredMods.length,
          mods: requiredMods,
          serverPath: this.serverPath,
          port: this.port
        });
      } catch (error) {
        console.error('[ManagementServer] Error getting required mods for debug:', error);
        res.status(500).json({ error: 'Failed to get required mods', details: error.message });
      }
    });
    
    // Test connection endpoint
    this.app.get('/api/test', (req, res) => {
      res.json({ 
        success: true, 
        message: 'Management server is running',
        timestamp: new Date().toISOString(),
        clients: this.clients.size
      });
    });
    
    // Get connected clients (for server admin)
    this.app.get('/api/clients', (req, res) => {
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
      console.log('[ManagementServer] Server is already running');
      return { success: true, port: this.port };
    }
    
    this.port = port;
    this.serverPath = serverPath;
    
    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        this.isRunning = true;
        console.log(`[ManagementServer] Management server started on port ${port}`);
        console.log(`[ManagementServer] Server path: ${serverPath || 'Not set'}`);
        
        // Start client cleanup interval (check every 30 seconds)
        this.startClientCleanup();
        
        resolve({ success: true, port });
      });
      
      this.server.on('error', (error) => {
        console.error('[ManagementServer] Server error:', error);
        this.isRunning = false;
        if (error.code === 'EADDRINUSE') {
          resolve({ success: false, error: `Port ${port} is already in use` });
        } else {
          resolve({ success: false, error: error.message });
        }
      });
    });
  }
  
  async stop() {
    if (!this.isRunning || !this.server) {
      console.log('[ManagementServer] Server is not running');
      return { success: true };
    }
    
    return new Promise((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        this.server = null;
        this.clients.clear();
        
        // Stop client cleanup interval
        this.stopClientCleanup();
        
        console.log('[ManagementServer] Management server stopped');
        resolve({ success: true });
      });
    });
  }
  
  updateServerPath(newPath) {
    this.serverPath = newPath;
    console.log(`[ManagementServer] Server path updated: ${newPath}`);
  }
  
  // Check if Minecraft server is running
  async checkMinecraftServerStatus() {
    try {
      // Check if there's a running server process
      // This is a simple check - in production you might want to check specific process names or PIDs
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      
      // On Windows, check for java processes running from the server directory
      if (process.platform === 'win32') {
        try {
          const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq java.exe" /FO CSV`);
          const lines = stdout.split('\n');
          
          // Look for java processes (basic check)
          const javaProcesses = lines.filter(line => line.includes('java.exe'));
          
          if (javaProcesses.length > 0) {
            return 'running';
          } else {
            return 'stopped';
          }
        } catch (error) {
          console.warn('[ManagementServer] Could not check process list:', error.message);
          return 'unknown';
        }
      } else {
        // On Linux/Mac, use ps to check for java processes
        try {
          const { stdout } = await execAsync('ps aux | grep java | grep -v grep');
          if (stdout.trim()) {
            return 'running';
          } else {
            return 'stopped';
          }
        } catch (error) {
          return 'stopped'; // ps command failed or no processes found
        }
      }
    } catch (error) {
      console.error('[ManagementServer] Error checking Minecraft server status:', error);
      return 'unknown';
    }
  }
  
  // Get list of required mods for clients
  async getRequiredMods() {
    if (!this.serverPath) {
      return [];
    }
    
    try {
      const clientModsDir = path.join(this.serverPath, 'client', 'mods');
      const serverModsDir = path.join(this.serverPath, 'mods');
      
      // Load saved mod categories to check requirement status
      let savedCategories = [];
      try {
        const { app } = require('electron');
        const configDir = path.join(app.getPath('userData'), 'config');
        const configFile = path.join(configDir, 'mod-categories.json');
        
        if (fs.existsSync(configFile)) {
          const data = fs.readFileSync(configFile, 'utf8');
          savedCategories = JSON.parse(data);
          console.log(`[ManagementServer] Loaded ${savedCategories.length} saved mod categories`);
        }
      } catch (configError) {
        console.warn('[ManagementServer] Could not load mod categories config:', configError.message);
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
            
            return {
              fileName: file,
              location: 'client',
              size: stats.size,
              lastModified: stats.mtime,
              required: isRequired,
              checksum: this.calculateFileChecksum(modPath),
              downloadUrl: `http://localhost:${this.port}/api/mods/download/${encodeURIComponent(file)}?location=client`
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
              
              requiredMods.push({
                fileName: serverMod,
                location: 'both',
                size: stats.size,
                lastModified: stats.mtime,
                required: isRequired,
                checksum: this.calculateFileChecksum(modPath),
                downloadUrl: `http://localhost:${this.port}/api/mods/download/${encodeURIComponent(serverMod)}?location=client`
              });
            }
          }
        }
      }
      
      // Filter to only return mods that are actually marked as required
      const actuallyRequiredMods = requiredMods.filter(mod => mod.required);
      
      console.log(`[ManagementServer] Found ${actuallyRequiredMods.length} required mods out of ${requiredMods.length} total client mods`);
      return actuallyRequiredMods;
    } catch (error) {
      console.error('[ManagementServer] Error getting required mods:', error);
      return [];
    }
  }

  // Get all client mods (both required and optional)
  async getAllClientMods() {
    if (!this.serverPath) {
      return [];
    }
    
    try {
      const clientModsDir = path.join(this.serverPath, 'client', 'mods');
      const serverModsDir = path.join(this.serverPath, 'mods');
      
      // Load saved mod categories to check requirement status
      let savedCategories = [];
      try {
        const { app } = require('electron');
        const configDir = path.join(app.getPath('userData'), 'config');
        const configFile = path.join(configDir, 'mod-categories.json');
        
        if (fs.existsSync(configFile)) {
          const data = fs.readFileSync(configFile, 'utf8');
          savedCategories = JSON.parse(data);
        }
      } catch (configError) {
        console.warn('[ManagementServer] Could not load mod categories config:', configError.message);
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
            
            return {
              fileName: file,
              location: 'client',
              size: stats.size,
              lastModified: stats.mtime,
              required: isRequired,
              checksum: this.calculateFileChecksum(modPath),
              downloadUrl: `http://localhost:${this.port}/api/mods/download/${encodeURIComponent(file)}?location=client`
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
              
              allClientMods.push({
                fileName: serverMod,
                location: 'both',
                size: stats.size,
                lastModified: stats.mtime,
                required: isRequired,
                checksum: this.calculateFileChecksum(modPath),
                downloadUrl: `http://localhost:${this.port}/api/mods/download/${encodeURIComponent(serverMod)}?location=client`
              });
            }
          }
        }
      }
      
      console.log(`[ManagementServer] Found ${allClientMods.length} total client mods (${allClientMods.filter(m => m.required).length} required, ${allClientMods.filter(m => !m.required).length} optional)`);
      return allClientMods;
    } catch (error) {
      console.error('[ManagementServer] Error getting all client mods:', error);
      return [];
    }
  }
  
  // Calculate file checksum for integrity verification
  calculateFileChecksum(filePath) {
    try {
      const fileContent = fs.readFileSync(filePath);
      return createHash('md5').update(fileContent).digest('hex');
    } catch (error) {
      console.warn('[ManagementServer] Could not calculate checksum for:', filePath);
      return null;
    }
  }
  
  // Start client cleanup interval
  startClientCleanup() {
    if (this.clientCleanupInterval) {
      clearInterval(this.clientCleanupInterval);
    }
    
    // Check for stale clients every 30 seconds
    this.clientCleanupInterval = setInterval(() => {
      this.cleanupStaleClients();
    }, 30000);
    
    console.log('[ManagementServer] Started client cleanup interval');
  }
  
  // Stop client cleanup interval
  stopClientCleanup() {
    if (this.clientCleanupInterval) {
      clearInterval(this.clientCleanupInterval);
      this.clientCleanupInterval = null;
      console.log('[ManagementServer] Stopped client cleanup interval');
    }
  }
  
  // Remove clients that haven't been seen for more than 2 minutes
  cleanupStaleClients() {
    const now = new Date();
    const staleThreshold = 2 * 60 * 1000; // 2 minutes in milliseconds
    const staleClients = [];
    
    for (const [clientId, client] of this.clients) {
      const timeSinceLastSeen = now - client.lastSeen;
      if (timeSinceLastSeen > staleThreshold) {
        staleClients.push(clientId);
      }
    }
    
    if (staleClients.length > 0) {
      console.log(`[ManagementServer] Removing ${staleClients.length} stale clients`);
      staleClients.forEach(clientId => {
        const client = this.clients.get(clientId);
        if (client) {
          console.log(`[ManagementServer] Removed stale client: ${client.name} (${clientId})`);
          this.clients.delete(clientId);
        }
      });
    }
  }
  
  getStatus() {
    return {
      isRunning: this.isRunning,
      port: this.port,
      serverPath: this.serverPath,
      clientCount: this.clients.size
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