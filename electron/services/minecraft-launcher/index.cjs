// Minecraft launcher service for client launching with Microsoft authentication
// REMOVED unused @xmcl imports - we now use direct Java execution instead
const fs = require('fs');
const path = require('path');
const os = require('os'); // Re-enabled since it's used in memory calculations
const { EventEmitter } = require('events');
const { JavaManager } = require('./java-manager.cjs');
const { AuthHandler } = require('./auth-handler.cjs');
const { ClientDownloader } = require('./client-downloader.cjs');
const utils = require('./utils.cjs'); // Added import for utils
const { ProperMinecraftLauncher } = require('./proper-launcher.cjs'); // Import proper launcher
const eventBus = require('../utils/event-bus.cjs');

// CRITICAL DEBUG: Intercept session join requests to debug authentication
try {
  const originalFetch = require('node-fetch');
  const fetch = require('node-fetch');
  
  // Override global fetch to log session requests
  if (typeof global !== 'undefined') {
    global.fetch = async (url, opts) => {
      if (url && url.includes && url.includes('sessionserver.mojang.com')) {
        console.log('[SESSION DEBUG ►] Request to:', url);
        if (opts && opts.body) {
          try {
            const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
            console.log('[SESSION DEBUG ►] Request body:', {
              accessToken: body.accessToken ? `${body.accessToken.substring(0, 10)}...` : 'missing',
              selectedProfile: body.selectedProfile || 'missing',
              serverId: body.serverId || 'missing'
            });
          } catch (parseError) {
            console.log('[SESSION DEBUG ►] Request body (raw):', opts.body);
          }
        }
        
        const response = await originalFetch(url, opts);
        console.log('[SESSION DEBUG ◄] Response:', response.status, response.statusText);
        
        if (!response.ok) {
          const errorText = await response.clone().text();
          console.error('[SESSION DEBUG ◄] Error response:', errorText);
        }
        
        return response;
      }
      
      return originalFetch(url, opts);
    };
  }
} catch (debugError) {
  console.warn('[MinecraftLauncher] Could not set up session debugging:', debugError.message);
}

// Console hiding removed - fixing the root cause instead (using javaw.exe)

// Add global error handling for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.warn('[MinecraftLauncher] Unhandled Promise Rejection:', reason);
  
  // Handle common authentication network errors gracefully
  if (reason && typeof reason === 'object' && reason.message) {
    if (reason.message.includes('ENOTFOUND') ||
        reason.message.includes('authserver.mojang.com') ||
        reason.message.includes('api.minecraftservices.com')) {
      console.log('[MinecraftLauncher] Authentication network error handled gracefully');
      return; // Don't crash the app for authentication network issues
    }
  }
  
  // For other critical errors, we might want to log them differently
  console.error('[MinecraftLauncher] Unhandled rejection details:', promise);
});

class MinecraftLauncher extends EventEmitter {
  constructor() {
    super();
    this.isLaunching = false;
    this.client = null;
    // this.authData = null; // Moved to AuthHandler
    this.clientPath = null;
    this.javaManager = new JavaManager(); // Initialize without client path initially
    this.authHandler = new AuthHandler(this); // Instantiate AuthHandler
    // ClientDownloader will now import utils directly
    this.clientDownloader = new ClientDownloader(this.javaManager, this); 
    
    // Add proper launcher for fixing LogUtils issues
    this.properLauncher = new ProperMinecraftLauncher();
    
    // REMOVED: Old MCLC debug logging no longer needed since we use direct Java execution
    // Our new approach logs directly from the spawned Java process
    
    // Log system information for debugging
    utils.logSystemInfo(); // Use util function
    // Update alias to use the downloader's method
    this.downloadMinecraftClient = this.clientDownloader.downloadMinecraftClientSimple.bind(this.clientDownloader);

    eventBus.on('server-version-changed', async (info) => {
      try {
        await this.handleServerVersionChanged(info);
      } catch (err) {
        console.error('[MinecraftLauncher] Error handling server version change:', err.message);
      }
    });
  }
  
  // Log system information to help with debugging - MOVED to utils.cjs
  // logSystemInfo() { ... }
  
  // Log current memory usage for debugging - MOVED to utils.cjs
  // logMemoryUsage() { ... }
  
  // Get the correct Java version for a Minecraft version - MOVED to utils.cjs
  // getRequiredJavaVersion(minecraftVersion) { ... }
  
  // Microsoft Authentication
  async authenticateWithMicrosoft() {
    return this.authHandler.authenticateWithMicrosoft();
  }
  
  // Save authentication data to file
  async saveAuthData(clientPath) {
    // Pass clientPath, authData is now internal to authHandler
    return this.authHandler.saveAuthData(clientPath);
  }
  
  // Load saved authentication data
  async loadAuthData(clientPath) {
    return this.authHandler.loadAuthData(clientPath);
  }
  
  // Reset launcher state - used when launcher gets stuck
  resetLauncherState() {
    console.log(`[MinecraftLauncher] Resetting launcher state...`);
    this.isLaunching = false;
    this.client = null;
    console.log(`[MinecraftLauncher] Launcher state reset complete`);
  }

  // Check if authentication is valid and refresh if needed
  async checkAndRefreshAuth() {
    return this.authHandler.checkAndRefreshAuth();
  }
  
  // Debug Java installation - Enhanced version
  // REMOVED: debugJavaInstallation method is no longer needed
  
  // Check Java installation
  async checkJavaInstallation() {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      console.log('[MinecraftLauncher] Checking for Java installation...');
      
      // Try different Java commands - prioritize javaw on Windows to avoid console
      const javaCommands = process.platform === 'win32' ? [
        'javaw', // Windows java without console - PREFERRED
        'java', // Standard java command
        path.join(process.env.JAVA_HOME || '', 'bin', 'javaw'), // JAVA_HOME javaw
        path.join(process.env.JAVA_HOME || '', 'bin', 'java') // JAVA_HOME java
      ] : [
        'java', // Standard java command
        path.join(process.env.JAVA_HOME || '', 'bin', 'java') // JAVA_HOME
      ];
      
      const validCommands = javaCommands.filter(cmd => cmd && cmd !== 'bin\\java' && cmd !== 'bin\\javaw'); // Filter out invalid paths
      
      for (const javaCommand of validCommands) {
        try {
          console.log(`[MinecraftLauncher] Trying Java command: ${javaCommand}`);
          const { stdout, stderr } = await execAsync(`"${javaCommand}" -version`, { timeout: 5000 });
          const output = stdout + stderr; // Java version info often goes to stderr
          
          if (output.includes('version')) {
            console.log(`[MinecraftLauncher] Java found with command: ${javaCommand}`);
            console.log(`[MinecraftLauncher] Java version output: ${output.split('\n')[0]}`);
            
            // Check Java architecture (32-bit vs 64-bit)
            let is64Bit = false;
            try {
              const { stdout: archOutput } = await execAsync(`"${javaCommand}" -d64 -version`, { timeout: 3000 });
              is64Bit = true;
              console.log(`[MinecraftLauncher] Java is 64-bit`);
            } catch (archError) {
              console.log(`[MinecraftLauncher] Java appears to be 32-bit (cannot use -d64 flag)`);
              is64Bit = false;
            }
            
            // Check if it's a reasonable Java version (8 or higher)
            const versionMatch = output.match(/version "?(\d+)\.?(\d*)/);
            if (versionMatch) {
              const majorVersion = parseInt(versionMatch[1]);
              const minorVersion = parseInt(versionMatch[2] || '0');
              
              // Java 8 is version 1.8, Java 9+ is version 9+
              const isValidVersion = majorVersion >= 9 || (majorVersion === 1 && minorVersion >= 8);
              
              if (isValidVersion) {
                return { 
                  success: true, 
                  javaPath: javaCommand,
                  version: versionMatch[0],
                  is64Bit: is64Bit,
                  architecture: is64Bit ? '64-bit' : '32-bit'
                };
              } else {
                console.warn(`[MinecraftLauncher] Java version ${versionMatch[0]} is too old, need Java 8 or higher`);
              }
            } else {
              return { 
                success: true, 
                javaPath: javaCommand,
                version: 'unknown',
                is64Bit: is64Bit,
                architecture: is64Bit ? '64-bit' : '32-bit'
              };
            }
          }
        } catch (cmdError) {
          console.log(`[MinecraftLauncher] Java command '${javaCommand}' failed: ${cmdError.message}`);
        }
      }
      
      // If no Java found, provide helpful error message
      return { 
        success: false, 
        error: 'Java not found. Please install Java 8 or higher from https://adoptopenjdk.net/ or https://www.oracle.com/java/technologies/downloads/'
      };
      
    } catch (error) {
      console.error('[MinecraftLauncher] Error checking Java installation:', error);
      return { 
        success: false, 
        error: `Failed to check Java installation: ${error.message}`
      };
    }
  }
  
  // Download Minecraft client files for a specific version (simplified approach)
  async downloadMinecraftClientSimple(clientPath, minecraftVersion, options = {}) {
    return this.clientDownloader.downloadMinecraftClientSimple(clientPath, minecraftVersion, options);
  }
  
  // Manual download method for when automated downloads fail
  async downloadMinecraftManually(clientPath, minecraftVersion, javaPath) {
    return this.clientDownloader.downloadMinecraftManually(clientPath, minecraftVersion, javaPath);
  }
  
  // Helper method to download JSON with retry logic
  async downloadJson(url, maxRetries = 3) {
    return this.clientDownloader.downloadJson(url, maxRetries);
  }
  
  // Single JSON download attempt
  async _downloadJsonSingle(url) {
    return this.clientDownloader._downloadJsonSingle(url);
  }
  
  // Helper method to download file with retry logic
  async downloadFile(url, filePath, maxRetries = 3) {
    return this.clientDownloader.downloadFile(url, filePath, maxRetries);
  }
  
  // Single download attempt
  async _downloadFileSingle(url, filePath) {
    return this.clientDownloader._downloadFileSingle(url, filePath);
  }
  
  // Launch Minecraft client
  async launchMinecraft(options) {
    const {
      clientPath,
      minecraftVersion,
      serverIp,
      serverPort,
      requiredMods = [],
      serverInfo = null,
      maxMemory = null // Accept memory setting from client
    } = options;
    
    console.log(`[MinecraftLauncher] 🚀 LAUNCH ATTEMPT STARTED FOR ${minecraftVersion}`);
    console.log(`[MinecraftLauncher] 📍 Client Path: ${clientPath}`);
    
    // CRITICAL: Check vanilla JAR immediately for LogUtils issue
    const immediateVanillaJar = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.jar`);
    console.log(`[MinecraftLauncher] 🔍 IMMEDIATE VANILLA JAR CHECK:`);
    console.log(`[MinecraftLauncher] - Expected path: ${immediateVanillaJar}`);
    console.log(`[MinecraftLauncher] - Exists: ${fs.existsSync(immediateVanillaJar)}`);
    
    if (fs.existsSync(immediateVanillaJar)) {
      const immediateJarStats = fs.statSync(immediateVanillaJar);
      console.log(`[MinecraftLauncher] - Size: ${immediateJarStats.size} bytes (${(immediateJarStats.size / 1024 / 1024).toFixed(1)} MB)`);
      
      // Check for LogUtils class
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(immediateVanillaJar);
        const entries = zip.getEntries();
        const logUtilsEntry = entries.find(entry => entry.entryName === 'com/mojang/logging/LogUtils.class');
        
        console.log(`[MinecraftLauncher] 🔍 LOGUTILS CHECK:`);
        console.log(`[MinecraftLauncher] - Total JAR entries: ${entries.length}`);
        console.log(`[MinecraftLauncher] - LogUtils.class present: ${!!logUtilsEntry}`);
        
        if (!logUtilsEntry) {
          console.error(`[MinecraftLauncher] ❌ CRITICAL: LogUtils.class is MISSING from vanilla JAR!`);
          console.error(`[MinecraftLauncher] This explains the ClassNotFoundException for com.mojang.logging.LogUtils`);
          console.error(`[MinecraftLauncher] - LogUtils.class present: ${logUtilsPresent}`);
          console.error(`[MinecraftLauncher] - Classes in com/mojang/logging/: ${loggingClasses.length}`);
          
          console.log(`[MinecraftLauncher] 🔧 PHASE 1 REPAIR: Implementing automatic vanilla JAR re-download...`);
          console.log(`[MinecraftLauncher] 🔧 Official JAR URL: ${profile.downloads.client.url}`);
          console.log(`[MinecraftLauncher] 🔧 Expected SHA1: ${profile.downloads.client.sha1}`);
          console.log(`[MinecraftLauncher] 🔧 Expected size: ${profile.downloads.client.size} bytes`);
          
          // Remove the old JAR
          console.log(`[MinecraftLauncher] 🔧 Removing corrupted JAR: ${vanillaJar}`);
          fs.unlinkSync(vanillaJar);
          
          // Re-download the official JAR
          console.log(`[MinecraftLauncher] 🔧 Re-downloading official vanilla JAR...`);
          await this.downloadFile(profile.downloads.client.url, vanillaJar);
          
          // Verify again
          console.log(`[MinecraftLauncher] 🔧 Verifying downloaded JAR...`);
          const newJarStats = fs.statSync(vanillaJar);
          console.log(`[MinecraftLauncher] 🔧 New JAR size: ${newJarStats.size} bytes`);
          
          // Check LogUtils again
          const newZip = new AdmZip(vanillaJar);
          const newEntries = newZip.getEntries();
          const newLogUtilsEntry = newEntries.find(entry => entry.entryName === 'com/mojang/logging/LogUtils.class');
          
          if (!newLogUtilsEntry) {
            console.log(`[MinecraftLauncher] ❌ PHASE 1 UNEXPECTED: Even the official JAR doesn't contain LogUtils.class!`);
            console.log(`[MinecraftLauncher] 💡 RECOMMENDATION: LogUtils was removed from Minecraft 1.21.5`);
            console.log(`[MinecraftLauncher] 💡 SOLUTION: Try using Minecraft 1.21.3 instead, which still contains LogUtils`);
            console.log(`[MinecraftLauncher] 🔍 Continuing with launch for further investigation...`);
          } else {
            console.log(`[MinecraftLauncher] ✅ PHASE 1 SUCCESS: LogUtils.class found after re-download!`);
          }
          
        } else {
          console.log(`[MinecraftLauncher] ✅ LogUtils.class found in vanilla JAR`);
        }
      } catch (zipError) {
        console.error(`[MinecraftLauncher] ❌ Failed to check JAR contents:`, zipError.message);
      }
    } else {
      console.error(`[MinecraftLauncher] ❌ CRITICAL: Vanilla JAR completely missing!`);
    }
    
    // PHASE 4 ENHANCEMENT: Continue with actual Minecraft launch
    try {
      console.log(`[MinecraftLauncher] 🚀 Proceeding with Minecraft launch...`);
      
      // Determine launch version and setup
      const needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
      const fabricVersion = serverInfo?.loaderVersion || 'latest';
      let launchVersion = minecraftVersion;
      
      if (needsFabric) {
        // Use latest Fabric version if needed
        let actualFabricVersion = fabricVersion;
        if (fabricVersion === 'latest') {
          try {
            const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
            const loaders = await response.json();
            actualFabricVersion = loaders[0].version;
            console.log(`[MinecraftLauncher] Using latest Fabric loader: ${actualFabricVersion}`);
          } catch (error) {
            console.warn(`[MinecraftLauncher] Could not fetch latest Fabric version, using 0.16.14:`, error.message);
            actualFabricVersion = '0.16.14';
          }
        }
        launchVersion = `fabric-loader-${actualFabricVersion}-${minecraftVersion}`;
        console.log(`[MinecraftLauncher] Launching with Fabric profile: ${launchVersion}`);
      } else {
        console.log(`[MinecraftLauncher] Launching vanilla Minecraft: ${launchVersion}`);
      }
      
      // Get Java path
      const requiredJavaVersion = require('./utils.cjs').getRequiredJavaVersion(minecraftVersion);
      const javaResult = await this.javaManager.ensureJava(requiredJavaVersion);
      
      if (!javaResult.success) {
        throw new Error(`Java ${requiredJavaVersion} not available: ${javaResult.error}`);
      }
      
      const javaPath = javaResult.javaPath;
      console.log(`[MinecraftLauncher] Using Java: ${javaPath}`);
      
      // Prepare launch arguments
      const versionsDir = path.join(clientPath, 'versions');
      const launchJsonPath = path.join(versionsDir, launchVersion, `${launchVersion}.json`);
      
      if (!fs.existsSync(launchJsonPath)) {
        throw new Error(`Launch profile not found: ${launchJsonPath}`);
      }
      
      const launchJson = JSON.parse(fs.readFileSync(launchJsonPath, 'utf8'));
      
      // Build classpath
      const classpath = [];
      const seenLibraries = new Set(); // Track libraries to avoid duplicates
      
      // Add vanilla JAR first
      const vanillaJarPath = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.jar`);
      if (fs.existsSync(vanillaJarPath)) {
        classpath.push(vanillaJarPath);
        console.log(`[MinecraftLauncher] ✅ Added vanilla JAR to classpath`);
      } else {
        throw new Error(`Vanilla JAR not found: ${vanillaJarPath}`);
      }
      
      // Helper function to get library priority (higher number = higher priority)
      const getLibraryPriority = (name) => {
        if (name.includes('asm')) {
          // For ASM libraries, prefer higher versions
          const versionMatch = name.match(/asm[^:]*:(\d+\.?\d*)/);
          if (versionMatch) {
            return parseFloat(versionMatch[1]);
          }
        }
        return 0;
      };
      
      // Helper function to normalize library name for deduplication
      const normalizeLibraryName = (name) => {
        // Don't normalize native libraries - they're separate from their main libraries
        if (name.includes('-natives-')) {
          return name; // Keep full name for natives (e.g., "org.lwjgl:lwjgl:3.3.3:natives-windows")
        }
        
        // Remove version to get base library name for non-natives
        const parts = name.split(':');
        if (parts.length >= 2) {
          return `${parts[0]}:${parts[1]}`;
        }
        return name;
      };
      
      // Process libraries with deduplication
      const libraryMap = new Map();
      
      console.log(`[MinecraftLauncher] Processing ${launchJson.libraries.length} libraries...`);
      
      for (const lib of launchJson.libraries) {
        if (!lib.name) continue;
        
        // Handle regular libraries (downloads.artifact)
        if (lib.downloads?.artifact) {
          const libPath = path.join(clientPath, 'libraries', lib.downloads.artifact.path);
          
          if (fs.existsSync(libPath)) {
            const normalizedName = normalizeLibraryName(lib.name);
            const priority = getLibraryPriority(lib.name);
            
            // Check if we already have this library
            if (libraryMap.has(normalizedName)) {
              const existing = libraryMap.get(normalizedName);
              if (priority > existing.priority) {
                console.log(`[MinecraftLauncher] 🔧 Replacing ${existing.name} with ${lib.name} (higher priority)`);
                libraryMap.set(normalizedName, { name: lib.name, path: libPath, priority });
              } else {
                console.log(`[MinecraftLauncher] 🔧 Skipping ${lib.name} (lower priority than ${existing.name})`);
              }
            } else {
              libraryMap.set(normalizedName, { name: lib.name, path: libPath, priority });
            }
          } else {
            console.warn(`[MinecraftLauncher] Library not found: ${libPath}`);
          }
        }
        
        // Handle native libraries (downloads.classifiers) - CRITICAL for LWJGL natives
        if (lib.downloads?.classifiers) {
          const platform = process.platform === 'win32' ? 'windows' : 
                         process.platform === 'darwin' ? 'osx' : 'linux';
          
          // Look for platform-specific natives
          for (const [classifier, download] of Object.entries(lib.downloads.classifiers)) {
            if (classifier.includes(`natives-${platform}`)) {
              const nativeLibPath = path.join(clientPath, 'libraries', download.path);
              
              if (fs.existsSync(nativeLibPath)) {
                const nativeLibName = `${lib.name}:${classifier}`;
                console.log(`[MinecraftLauncher] 🔧 Found native library: ${nativeLibName}`);
                libraryMap.set(nativeLibName, { 
                  name: nativeLibName, 
                  path: nativeLibPath, 
                  priority: 100 // High priority for natives
                });
              } else {
                console.warn(`[MinecraftLauncher] Native library not found: ${nativeLibPath}`);
              }
            }
          }
        }
      }
      
      // Add deduplicated libraries to classpath
      for (const [, libInfo] of libraryMap) {
        classpath.push(libInfo.path);
      }
      
      console.log(`[MinecraftLauncher] Built classpath with ${classpath.length} entries`);
      console.log(`[MinecraftLauncher] 🔧 Deduplicated ${launchJson.libraries.length - libraryMap.size} duplicate libraries`);
      
      // Setup authentication
      if (!this.authHandler.authData) {
        throw new Error('No authentication data available. Please authenticate first.');
      }
      
      const authData = this.authHandler.authData;
      
      // Build launch arguments
      const gameArgs = [];
      
      // Process game arguments from profile
      if (launchJson.arguments?.game) {
        for (const arg of launchJson.arguments.game) {
          if (typeof arg === 'string') {
            let processedArg = arg
              .replace(/\$\{auth_playerName\}/g, authData.name)
              .replace(/\$\{auth_player_name\}/g, authData.name)
              .replace(/\$\{auth_uuid\}/g, authData.uuid)
              .replace(/\$\{auth_accessToken\}/g, authData.access_token)
              .replace(/\$\{auth_access_token\}/g, authData.access_token)
              .replace(/\$\{auth_userType\}/g, 'msa')
              .replace(/\$\{auth_user_type\}/g, 'msa')
              .replace(/\$\{version_name\}/g, launchVersion)
              .replace(/\$\{game_directory\}/g, clientPath)
              .replace(/\$\{assets_root\}/g, path.join(clientPath, 'assets'))
              .replace(/\$\{assets_index_name\}/g, launchJson.assetIndex?.id || minecraftVersion)
              .replace(/\$\{version_type\}/g, 'release');
              
            gameArgs.push(processedArg);
          } else {
            gameArgs.push(arg);
          }
        }
      }
      
      // Add server connection arguments if provided
      if (serverIp && serverPort) {
        gameArgs.push('--server', serverIp);
        gameArgs.push('--port', serverPort.toString());
        console.log(`[MinecraftLauncher] Added server connection: ${serverIp}:${serverPort}`);
      }
      
      // Build JVM arguments
      const jvmArgs = [
        `-Xmx${maxMemory || 4096}M`,
        `-Xms1024M`,
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        '-XX:G1HeapRegionSize=8M',
        '-XX:G1ReservePercent=20',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:SurvivorRatio=32',
        '-XX:+PerfDisableSharedMem',
        '-XX:MaxTenuringThreshold=1'
      ];
      
      // Add native library paths - CRITICAL for LWJGL
      const nativesDir = path.join(clientPath, 'versions', launchVersion, 'natives');
      console.log(`[MinecraftLauncher] 🔧 Natives directory: ${nativesDir}`);
      console.log(`[MinecraftLauncher] 🔧 Natives directory exists: ${fs.existsSync(nativesDir)}`);
      
      // Ensure natives directory exists and extract natives if needed
      if (!fs.existsSync(nativesDir)) {
        fs.mkdirSync(nativesDir, { recursive: true });
        console.log(`[MinecraftLauncher] 🔧 Created natives directory`);
      }
      
      // Extract native libraries from JARs
      let extractedNatives = 0;
      console.log(`[MinecraftLauncher] 🔧 Extracting native libraries...`);
      
      for (const [, libInfo] of libraryMap) {
        // Look for native JAR files (containing DLL/SO files)
        if (libInfo.name.includes('-natives-') && libInfo.path.endsWith('.jar')) {
          console.log(`[MinecraftLauncher] 🔧 Processing native JAR: ${libInfo.name}`);
          try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(libInfo.path);
            const entries = zip.getEntries();
            
            for (const entry of entries) {
              if (!entry.isDirectory && (entry.entryName.endsWith('.dll') || entry.entryName.endsWith('.so') || entry.entryName.endsWith('.dylib'))) {
                const nativePath = path.join(nativesDir, path.basename(entry.entryName));
                if (!fs.existsSync(nativePath)) {
                  fs.writeFileSync(nativePath, entry.getData());
                  extractedNatives++;
                  console.log(`[MinecraftLauncher] 🔧   Extracted: ${path.basename(entry.entryName)}`);
                }
              }
            }
          } catch (extractError) {
            console.warn(`[MinecraftLauncher] ⚠️ Failed to extract natives from ${libInfo.path}:`, extractError.message);
          }
        }
      }
      
      console.log(`[MinecraftLauncher] 🔧 Extracted ${extractedNatives} native libraries`);
      
      // List files in natives directory for debugging
      if (fs.existsSync(nativesDir)) {
        const nativeFiles = fs.readdirSync(nativesDir);
        console.log(`[MinecraftLauncher] 🔧 Native files available: ${nativeFiles.length}`);
        nativeFiles.slice(0, 10).forEach(file => {
          console.log(`[MinecraftLauncher] 🔧   - ${file}`);
        });
        if (nativeFiles.length > 10) {
          console.log(`[MinecraftLauncher] 🔧   ... and ${nativeFiles.length - 10} more`);
        }
      }
      
      // Add native library system properties - MULTIPLE WAYS for maximum compatibility
      jvmArgs.push(
        `-Djava.library.path=${nativesDir}`,
        `-Dorg.lwjgl.librarypath=${nativesDir}`,
        `-Djna.tmpdir=${nativesDir}`,
        `-Dorg.lwjgl.system.SharedLibraryExtractPath=${nativesDir}`,
        `-Dio.netty.native.workdir=${nativesDir}`,
        // CRITICAL WORKAROUND: Add LWJGL debug flags and manual extraction
        `-Dorg.lwjgl.util.Debug=true`,
        `-Dorg.lwjgl.util.DebugLoader=true`
      );
      
      // EMERGENCY WORKAROUND: Manually extract LWJGL natives from vanilla client
      console.log(`[MinecraftLauncher] 🔧 EMERGENCY: Manually extracting LWJGL natives from vanilla...`);
      try {
        const vanillaVersionDir = path.join(clientPath, 'versions', minecraftVersion);
        const vanillaLibrariesDir = path.join(clientPath, 'libraries');
        
        // Common LWJGL native paths for Windows
        const lwjglNativePaths = [
          'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar',
          'org/lwjgl/lwjgl-opengl/3.3.3/lwjgl-opengl-3.3.3-natives-windows.jar',
          'org/lwjgl/lwjgl-glfw/3.3.3/lwjgl-glfw-3.3.3-natives-windows.jar',
          'org/lwjgl/lwjgl-openal/3.3.3/lwjgl-openal-3.3.3-natives-windows.jar',
          'org/lwjgl/lwjgl-stb/3.3.3/lwjgl-stb-3.3.3-natives-windows.jar'
        ];
        
        let manuallyExtracted = 0;
        for (const nativePath of lwjglNativePaths) {
          const fullNativePath = path.join(vanillaLibrariesDir, nativePath);
          if (fs.existsSync(fullNativePath)) {
            console.log(`[MinecraftLauncher] 🔧 Found LWJGL native: ${nativePath}`);
            try {
              const AdmZip = require('adm-zip');
              const zip = new AdmZip(fullNativePath);
              const entries = zip.getEntries();
              
              for (const entry of entries) {
                if (!entry.isDirectory && entry.entryName.endsWith('.dll')) {
                  const dllPath = path.join(nativesDir, path.basename(entry.entryName));
                  if (!fs.existsSync(dllPath)) {
                    fs.writeFileSync(dllPath, entry.getData());
                    manuallyExtracted++;
                    console.log(`[MinecraftLauncher] 🔧 Manually extracted: ${path.basename(entry.entryName)}`);
                  }
                }
              }
            } catch (extractError) {
              console.warn(`[MinecraftLauncher] ⚠️ Failed to extract ${nativePath}:`, extractError.message);
            }
          }
        }
        
        if (manuallyExtracted > 0) {
          console.log(`[MinecraftLauncher] 🔧 EMERGENCY SUCCESS: Manually extracted ${manuallyExtracted} LWJGL natives`);
        } else {
          console.warn(`[MinecraftLauncher] ⚠️ EMERGENCY FAILED: Could not find any LWJGL natives to extract`);
        }
        
      } catch (emergencyError) {
        console.error(`[MinecraftLauncher] ❌ Emergency extraction failed:`, emergencyError.message);
      }
      
      // Add classpath
      jvmArgs.push('-cp', classpath.join(process.platform === 'win32' ? ';' : ':'));
      
      // Add additional JVM args from profile
      if (launchJson.arguments?.jvm) {
        for (const arg of launchJson.arguments.jvm) {
          if (typeof arg === 'string' && !jvmArgs.includes(arg)) {
            let processedArg = arg
              .replace(/\$\{natives_directory\}/g, nativesDir)
              .replace(/\$\{launcher_name\}/g, 'minecraft-core')
              .replace(/\$\{launcher_version\}/g, '1.0.0');
            jvmArgs.push(processedArg);
          }
        }
      }
      
      // Final arguments
      const allArgs = [
        ...jvmArgs,
        launchJson.mainClass || 'net.minecraft.client.main.Main',
        ...gameArgs
      ];
      
      console.log(`[MinecraftLauncher] Launching Minecraft with ${allArgs.length} arguments`);
      console.log(`[MinecraftLauncher] Main class: ${launchJson.mainClass}`);
      console.log(`[MinecraftLauncher] Memory: ${maxMemory || 4096}MB`);
      
      // Launch Minecraft
      const { spawn } = require('child_process');
      
      this.isLaunching = true;
      
      const child = spawn(javaPath, allArgs, {
        cwd: clientPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });
      
      this.client = { child };
      
      // Handle process output
      child.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[Minecraft] ${output.trim()}`);
        
        // Check for successful launch indicators
        if (output.includes('Setting user:') || output.includes('Environment: authHost')) {
          console.log(`[MinecraftLauncher] ✅ Minecraft authentication successful`);
        }
        
        if (output.includes('[Render thread/INFO]: Created')) {
          console.log(`[MinecraftLauncher] ✅ Minecraft game window created`);
        }
      });
      
      child.stderr.on('data', (data) => {
        const output = data.toString();
        console.error(`[Minecraft Error] ${output.trim()}`);
        
        // Check for the LogUtils error specifically
        if (output.includes('java.lang.ClassNotFoundException: com.mojang.logging.LogUtils')) {
          console.error(`[MinecraftLauncher] ❌ CONFIRMED: LogUtils ClassNotFoundException occurred during runtime`);
          console.error(`[MinecraftLauncher] This confirms the vanilla JAR is missing this class`);
        }
      });
      
      child.on('close', (code) => {
        console.log(`[MinecraftLauncher] Minecraft process exited with code: ${code}`);
        this.isLaunching = false;
        this.client = null;
        this.emit('minecraft-stopped');
      });
      
      child.on('error', (error) => {
        console.error(`[MinecraftLauncher] ❌ Launch error:`, error);
        this.isLaunching = false;
        this.client = null;
        this.emit('minecraft-stopped');
      });
      
      // Wait a moment to see if launch fails immediately
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      if (child.killed || child.exitCode !== null) {
        throw new Error(`Minecraft failed to start. Exit code: ${child.exitCode}`);
      }
      
      console.log(`[MinecraftLauncher] ✅ Minecraft launched successfully (PID: ${child.pid})`);
      
      return {
        success: true,
        message: `Minecraft ${launchVersion} launched successfully`,
        pid: child.pid,
        version: launchVersion,
        vanillaVersion: minecraftVersion,
        needsFabric: needsFabric
      };
      
    } catch (error) {
      console.error(`[MinecraftLauncher] ❌ Launch failed:`, error);
      this.isLaunching = false;
      this.client = null;
      
      return {
        success: false,
        error: error.message,
        message: `Failed to launch Minecraft: ${error.message}`
      };
    }
  }
  
  // Stop Minecraft if running
  async stopMinecraft() {
    try {
      console.log('[MinecraftLauncher] Stopping Minecraft...');
      
      let stopped = false;
      
      // Method 1: Stop via direct process if available
      if (this.client && this.client.child) {
        console.log('[MinecraftLauncher] Stopping via direct process reference...');
        try {
          // We have direct access to the child process from our spawn call
          this.client.child.kill('SIGTERM');
          
          // Wait a moment, then force kill if necessary
          setTimeout(() => {
            if (this.client && this.client.child && !this.client.child.killed) {
              console.log('[MinecraftLauncher] Force killing Minecraft process...');
              this.client.child.kill('SIGKILL');
            }
          }, 3000);
          
          stopped = true;
          console.log('[MinecraftLauncher] Direct process terminated');
        } catch (error) {
          console.warn('[MinecraftLauncher] Error stopping direct process:', error.message);
        }
      }
      
      // Method 2: Targeted Java process killing (Windows-specific fallback)
      if (process.platform === 'win32') {
        try {
          console.log('[MinecraftLauncher] Attempting to stop client Java processes on Windows...');
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          // CRITICAL FIX: Only kill Java processes that are specifically related to this client
          // DO NOT kill all Java processes as this would stop the Minecraft server!
          
          // Try to kill only processes running from our client directory
          if (this.clientPath) {
            const clientPathEscaped = this.clientPath.replace(/\\/g, '\\\\');
            
            try {
              // Kill only Java processes with our client path in the command line
              await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='java.exe'" call terminate`, { 
                windowsHide: true,
                timeout: 5000 
              }).catch(() => {
                console.log('[MinecraftLauncher] No client-specific java.exe processes to kill');
              });
              
              await execAsync(`wmic process where "commandline like '%${clientPathEscaped}%' and name='javaw.exe'" call terminate`, { 
                windowsHide: true,
                timeout: 5000 
              }).catch(() => {
                console.log('[MinecraftLauncher] No client-specific javaw.exe processes to kill');
              });
              
              console.log('[MinecraftLauncher] Targeted client Java process termination completed');
              stopped = true;
              
            } catch (wmicError) {
              console.warn('[MinecraftLauncher] WMIC targeted kill failed, trying PID-based approach:', wmicError.message);
              
              // Fallback: Try to use the stored client PID if we have it
              if (this.client && this.client.child && this.client.child.pid) {
                try {
                  await execAsync(`taskkill /F /PID ${this.client.child.pid}`, { windowsHide: true });
                  console.log(`[MinecraftLauncher] Killed client process by PID: ${this.client.child.pid}`);
                  stopped = true;
                } catch (pidError) {
                  console.warn('[MinecraftLauncher] PID-based kill also failed:', pidError.message);
                }
              }
            }
          } else {
            console.log('[MinecraftLauncher] No client path available for targeted killing, skipping Windows process cleanup');
          }
          
        } catch (error) {
          console.warn('[MinecraftLauncher] Error with Windows process termination:', error.message);
        }
      }
      
      // Reset launcher state
      this.isLaunching = false;
      this.client = null;
      this.emit('minecraft-stopped');
      
      if (stopped) {
        return { success: true, message: 'Minecraft stopped successfully' };
      } else {
        return { success: true, message: 'Minecraft process cleanup completed (no active process found)' };
      }
      
    } catch (error) {
      console.error('[MinecraftLauncher] Error stopping Minecraft:', error);
      // Reset state even on error
      this.isLaunching = false;
      this.client = null;
      this.emit('minecraft-stopped');
      return { success: false, error: error.message };
    }
  }
  
  // Calculate file checksum for mod verification - MOVED to utils.cjs
  // calculateFileChecksum(filePath) { ... }
  
  // Get launcher status
  getStatus() {
    let isRunning = false;
    
    // Check if we actually have a running process
    if (this.client && this.client.child) {
      try {
        // Check if the process is still alive
        const pid = this.client.child.pid;
        if (pid) {
          // On Windows, we can check if the process exists
          try {
            process.kill(pid, 0); // Signal 0 just tests if process exists
            isRunning = true;
          } catch (e) {
            // Process doesn't exist anymore
            console.log(`[MinecraftLauncher] Process ${pid} no longer exists, cleaning up...`);
            this.isLaunching = false;
            this.client = null;
            isRunning = false;
          }
        }
      } catch (error) {
        console.warn('[MinecraftLauncher] Error checking process status:', error);
        isRunning = false;
      }
    }
    
    return {
      isAuthenticated: !!this.authHandler.authData, // Changed to this.authHandler.authData
      isLaunching: this.isLaunching,
      isRunning: isRunning,
      username: this.authHandler.authData?.name || null, // Changed to this.authHandler.authData
      clientPath: this.clientPath
    };
  }
  
  // Check if Minecraft client files are present and up to date
  async checkMinecraftClient(clientPath, requiredVersion, options = {}) {
    return this.clientDownloader.checkMinecraftClient(clientPath, requiredVersion, options);
  }
  
  // Clear Minecraft client files for re-download
  async clearMinecraftClient(clientPath, minecraftVersion) {
    return this.clientDownloader.clearMinecraftClient(clientPath, minecraftVersion);
  }

  // Force clear just assets directory - useful when assets are corrupted
  async clearAssets(clientPath) {
    return this.clientDownloader.clearAssets(clientPath);
  }
  
  // Install Fabric loader for the client
  async installFabricLoader(clientPath, minecraftVersion, fabricVersion = 'latest') {
    return this.clientDownloader.installFabricLoader(clientPath, minecraftVersion, fabricVersion);
  }

  // Fix Fabric profile to include asset index for MCLC compatibility
  async fixFabricAssetIndex(clientPath, fabricProfileName, vanillaVersion) {
    return this.clientDownloader.fixFabricAssetIndex(clientPath, fabricProfileName, vanillaVersion);
  }

  // Add server to Minecraft's server list
  async addServerToList(clientPath, serverInfo) {
    return this.clientDownloader.addServerToList(clientPath, serverInfo);
  }

  // Inject vanilla downloads.client and merge vanilla libraries into Fabric profile
  async injectVanillaDownloadsAndLibraries(clientPath, profileName, vanillaVersion) {
    try {
      const versionsDir = path.join(clientPath, 'versions');
      const fabricJsonPath = path.join(versionsDir, profileName, `${profileName}.json`);
      const vanillaJsonPath = path.join(versionsDir, vanillaVersion, `${vanillaVersion}.json`);

      if (!fs.existsSync(fabricJsonPath)) {
        throw new Error(`Fabric profile not found: ${fabricJsonPath}`);
      }

      if (!fs.existsSync(vanillaJsonPath)) {
        throw new Error(`Vanilla version not found: ${vanillaJsonPath}`);
      }

      const fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));
      const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));

      console.log(`[MinecraftLauncher] Merging vanilla ${vanillaVersion} components into Fabric profile ${profileName}`);

      // 1) Inject downloads.client if missing
      fabricJson.downloads = fabricJson.downloads || {};
      if (!fabricJson.downloads.client && vanillaJson.downloads?.client) {
        fabricJson.downloads.client = vanillaJson.downloads.client;
        console.log('[MinecraftLauncher] ✅ Injected vanilla downloads.client into Fabric profile');
      } else if (fabricJson.downloads.client) {
        console.log('[MinecraftLauncher] ✅ Fabric profile already has downloads.client');
      }

      // 1a) Inject vanilla asset index & asset downloads for sounds and textures
      if (vanillaJson.assetIndex && !fabricJson.assetIndex) {
        fabricJson.assetIndex = vanillaJson.assetIndex;
        console.log('[MinecraftLauncher] ✅ Injected vanilla assetIndex');
      } else if (fabricJson.assetIndex) {
        console.log('[MinecraftLauncher] ✅ Fabric profile already has assetIndex');
      }

      if (vanillaJson.downloads?.assets && !fabricJson.downloads.assets) {
        fabricJson.downloads.assets = vanillaJson.downloads.assets;
        console.log('[MinecraftLauncher] ✅ Injected vanilla downloads.assets');
      } else if (fabricJson.downloads.assets) {
        console.log('[MinecraftLauncher] ✅ Fabric profile already has downloads.assets');
      }

      // 2) Merge vanilla libraries *except* ASM to avoid conflicts
      if (Array.isArray(vanillaJson.libraries) && vanillaJson.libraries.length > 0) {
        // Initialize Fabric libraries array if it doesn't exist
        fabricJson.libraries = fabricJson.libraries || [];
        
        // Function to detect ASM libraries that should be skipped
        const skipASM = lib => {
          if (!lib.name) return false;
          // Skip ASM libraries since Fabric provides its own version
          return /^org\.ow2\.asm:asm(?:-|$)/.test(lib.name);
        };

        // Create a set of existing library names to avoid duplicates
        const existing = new Set(fabricJson.libraries.map(lib => lib.name).filter(Boolean));

        // Filter vanilla libraries to exclude ASM and duplicates
        const toInject = (vanillaJson.libraries || [])
          .filter(lib => {
            // Must have a name
            if (!lib.name) return false;
            
            // Skip ASM libraries
            if (skipASM(lib)) {
              console.log(`[MinecraftLauncher] Skipping ASM library: ${lib.name}`);
              return false;
            }
            
            // Skip if already exists
            if (existing.has(lib.name)) {
              return false;
            }
            
            // Add to existing set to prevent future duplicates
            existing.add(lib.name);
            return true;
          })
          .map(vanillaLib => {
            // CRITICAL FIX: Copy natives metadata from vanilla libraries
            // This ensures LWJGL and other native libraries have proper download metadata
            const libCopy = { ...vanillaLib };
            
            // If vanillaLib had a "natives" block, copy it verbatim
            if (vanillaLib.natives) {
              libCopy.natives = { ...vanillaLib.natives };
              console.log(`[MinecraftLauncher] 🔧 Copying natives metadata for: ${vanillaLib.name}`);
            }
            
            // If vanillaLib already had download metadata for classifiers, copy it too
            if (vanillaLib.downloads && vanillaLib.downloads.classifiers) {
              libCopy.downloads = libCopy.downloads || {};
              libCopy.downloads.classifiers = { ...vanillaLib.downloads.classifiers };
              console.log(`[MinecraftLauncher] 🔧 Copying classifiers metadata for: ${vanillaLib.name}`);
            }
            
            return libCopy;
          });

        // Merge vanilla libraries at the front of the array
        fabricJson.libraries = [...toInject, ...fabricJson.libraries];
        console.log(`[MinecraftLauncher] ✅ Merged ${toInject.length} vanilla libraries into Fabric profile (skipping ASM, total: ${fabricJson.libraries.length})`);

        // 3) Explicit ASM cleanup - remove ALL ASM versions except Fabric's 9.8
        const beforeASMFilter = fabricJson.libraries.length;
        fabricJson.libraries = fabricJson.libraries.filter(lib => {
          // If it's not an ASM library, keep it
          if (!lib.name?.startsWith('org.ow2.asm:asm:')) return true;
          // If it's ASM, only keep version 9.8.x (Fabric's version)
          const keepASM = /^org\.ow2\.asm:asm:9\.8/.test(lib.name);
          if (!keepASM) {
            console.log(`[MinecraftLauncher] Removing duplicate ASM library: ${lib.name}`);
          }
          return keepASM;
        });
        const afterASMFilter = fabricJson.libraries.length;
        console.log(`[MinecraftLauncher] ✅ Filtered ASM libraries—only Fabric's 9.8 remains (removed ${beforeASMFilter - afterASMFilter} duplicates)`);

        // 4) Verify key libraries are present
        const requiredLibraries = [
          'net.sf.jopt-simple:jopt-simple',
          'com.mojang:brigadier',
          'com.mojang:authlib',
          'com.mojang:datafixerupper'
        ];
        
        requiredLibraries.forEach(requiredLib => {
          const found = fabricJson.libraries.find(lib => lib.name?.startsWith(requiredLib));
          if (found) {
            console.log(`[MinecraftLauncher] ✅ Key library found: ${found.name}`);
          } else {
            console.warn(`[MinecraftLauncher] ⚠️ Key library missing: ${requiredLib}`);
          }
        });

      } else {
        console.warn(`[MinecraftLauncher] ⚠️ No vanilla libraries found to merge`);
      }

      // 5) Ensure proper inheritance and type for MCLC
      fabricJson.inheritsFrom = fabricJson.inheritsFrom || vanillaVersion;
      fabricJson.type = fabricJson.type || 'release';

      // Write the updated Fabric profile
      fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2), 'utf8');
      console.log(`[MinecraftLauncher] ✅ Updated Fabric profile saved to: ${fabricJsonPath}`);

      return { success: true };

    } catch (error) {
      console.error(`[MinecraftLauncher] Error injecting vanilla components:`, error);
      return { success: false, error: error.message };
    }
  }

  // Validate session token against Mojang's servers (from debugging guide)
  async validateSessionToken(accessToken, uuid) {
    try {
      const fetch = require('node-fetch');
      console.log('[SESSION VALIDATION] Testing token against Mojang session servers...');
      
      const payload = {
        accessToken: accessToken,
        selectedProfile: uuid,
        serverId: ""  // empty string means "just validate token"
      };

      const response = await fetch('https://sessionserver.mojang.com/session/minecraft/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 10000
      });

      if (response.status === 204) {
        console.log('[SESSION VALIDATION] ✅ Token is valid - session servers responded successfully');
        return true;
      } else {
        const errorText = await response.text();
        console.error('[SESSION VALIDATION] ❌ Token validation failed:', response.status, errorText);
        return false;
      }
    } catch (error) {
      console.error('[SESSION VALIDATION] ❌ Error validating session token:', error.message);
      return false;
    }
  }

  // Validate Fabric version.json for authentication placeholders (from debugging guide)
  async verifyAndRepairLibraries(clientPath, fabricProfileName, vanillaVersion) {
    try {
      console.log(`[MinecraftLauncher] Verifying critical libraries for ${fabricProfileName}...`);
      
      const versionsDir = path.join(clientPath, 'versions');
      const fabricJsonPath = path.join(versionsDir, fabricProfileName, `${fabricProfileName}.json`);
      const vanillaJsonPath = path.join(versionsDir, vanillaVersion, `${vanillaVersion}.json`);
      
      if (!fs.existsSync(fabricJsonPath)) {
        throw new Error(`Fabric profile JSON not found: ${fabricJsonPath}`);
      }
      
      const fabricJson = JSON.parse(fs.readFileSync(fabricJsonPath, 'utf8'));
      
      // List of critical libraries that must be present for Minecraft to launch
      const criticalLibraries = [
        'net.sf.jopt-simple:jopt-simple',
        'com.mojang:brigadier',
        'com.mojang:authlib',
        'com.mojang:datafixerupper',
        'com.google.guava:guava',
        'org.apache.commons:commons-lang3'
      ];
      
      const missingLibraries = [];
      const presentLibraries = [];
      
      // Check which critical libraries are missing from the Fabric profile
      for (const requiredLib of criticalLibraries) {
        const found = fabricJson.libraries?.find(lib => lib.name?.startsWith(requiredLib));
        if (found) {
          // Verify the actual JAR file exists
          const parts = found.name.split(':');
          if (parts.length >= 3) {
            const groupPath = parts[0].replace(/\./g, '/');
            const artifact = parts[1];
            const version = parts[2];
            const libFileName = `${artifact}-${version}.jar`;
            const libPath = path.join(clientPath, 'libraries', groupPath, artifact, version, libFileName);
            
            if (fs.existsSync(libPath)) {
              presentLibraries.push(found.name);
              console.log(`[MinecraftLauncher] ✅ Critical library verified: ${found.name}`);
            } else {
              console.warn(`[MinecraftLauncher] ❌ Critical library JAR missing: ${libPath}`);
              missingLibraries.push(requiredLib);
            }
          }
        } else {
          console.warn(`[MinecraftLauncher] ❌ Critical library not in profile: ${requiredLib}`);
          missingLibraries.push(requiredLib);
        }
      }
      
      if (missingLibraries.length === 0) {
        console.log(`[MinecraftLauncher] ✅ All ${criticalLibraries.length} critical libraries verified`);
        return { success: true, message: `All critical libraries present` };
      }
      
      console.warn(`[MinecraftLauncher] Missing ${missingLibraries.length} critical libraries:`, missingLibraries);
      
      // Try to repair by merging vanilla libraries if vanilla profile exists
      if (fs.existsSync(vanillaJsonPath)) {
        console.log(`[MinecraftLauncher] Attempting to repair by merging vanilla libraries...`);
        
        const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
        let repairedCount = 0;
        
        if (vanillaJson.libraries && Array.isArray(vanillaJson.libraries)) {
          // Create a map of existing Fabric libraries to avoid duplicates
          const fabricLibNames = new Set(fabricJson.libraries?.map(lib => lib.name) || []);
          
          // Find missing libraries in vanilla profile
          for (const missingLib of missingLibraries) {
            const vanillaLib = vanillaJson.libraries.find(lib => lib.name?.startsWith(missingLib));
            if (vanillaLib && !fabricLibNames.has(vanillaLib.name)) {
              console.log(`[MinecraftLauncher] 🔧 Adding missing library from vanilla: ${vanillaLib.name}`);
              fabricJson.libraries = fabricJson.libraries || [];
              fabricJson.libraries.unshift(vanillaLib); // Add at beginning for priority
              fabricLibNames.add(vanillaLib.name);
              repairedCount++;
            }
          }
          
          if (repairedCount > 0) {
            // Save the updated Fabric profile
            fs.writeFileSync(fabricJsonPath, JSON.stringify(fabricJson, null, 2), 'utf8');
            console.log(`[MinecraftLauncher] ✅ Repaired Fabric profile with ${repairedCount} missing libraries`);
            
            // Re-verify after repair
            const stillMissing = [];
            for (const requiredLib of criticalLibraries) {
              const found = fabricJson.libraries.find(lib => lib.name?.startsWith(requiredLib));
              if (!found) {
                stillMissing.push(requiredLib);
              }
            }
            
            if (stillMissing.length === 0) {
              return { success: true, message: `Successfully repaired ${repairedCount} missing libraries` };
            } else {
              return { 
                success: false, 
                error: `Still missing ${stillMissing.length} libraries after repair: ${stillMissing.join(', ')}`,
                stillMissing: stillMissing
              };
            }
          } else {
            return { 
              success: false, 
              error: `Could not find ${missingLibraries.length} missing libraries in vanilla profile`,
              missingLibraries: missingLibraries
            };
          }
        } else {
          return { 
            success: false, 
            error: `Vanilla profile has no libraries to merge`,
            missingLibraries: missingLibraries
          };
        }
      } else {
        return { 
          success: false, 
          error: `Vanilla profile not found for library repair: ${vanillaJsonPath}`,
          missingLibraries: missingLibraries
        };
      }
      
    } catch (error) {
      console.error(`[MinecraftLauncher] Library verification failed:`, error);
      return { 
        success: false, 
        error: `Library verification error: ${error.message}` 
      };
    }
  }

  validateFabricProfile(clientPath, profileName) {
    try {
      const profilePath = path.join(clientPath, 'versions', profileName, `${profileName}.json`);
      
      if (!fs.existsSync(profilePath)) {
        console.error('[FABRIC VALIDATION] ❌ Fabric profile JSON not found:', profilePath);
        return false;
      }

      const profileJson = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      
      console.log('[FABRIC VALIDATION] Checking Fabric profile for authentication support...');
      console.log('[FABRIC VALIDATION] Profile ID:', profileJson.id);
      console.log('[FABRIC VALIDATION] Inherits From:', profileJson.inheritsFrom);
      console.log('[FABRIC VALIDATION] Main Class:', profileJson.mainClass);

      // Check for required authentication placeholders in game arguments
      const gameArgs = profileJson.arguments?.game || [];
      const requiredPlaceholders = [
        '${auth_player_name}',
        '${auth_uuid}', 
        '${auth_access_token}',
        '${auth_user_type}'
      ];

      const missingPlaceholders = [];
      requiredPlaceholders.forEach(placeholder => {
        const found = gameArgs.some(arg => 
          typeof arg === 'string' && arg.includes(placeholder)
        );
        if (!found) {
          missingPlaceholders.push(placeholder);
        }
      });

      if (missingPlaceholders.length > 0) {
        console.warn('[FABRIC VALIDATION] ⚠️ Missing authentication placeholders:', missingPlaceholders);
        console.log('[FABRIC VALIDATION] This profile will be automatically fixed during enrichment...');
        // Don't fail validation - let the enrichment process fix this
        return true;
      }

      // Check for auth session in JVM arguments
      const jvmArgs = profileJson.arguments?.jvm || [];
      const hasAuthSession = jvmArgs.some(arg => 
        typeof arg === 'string' && arg.includes('${auth_session}')
      );

      if (!hasAuthSession) {
        console.log('[FABRIC VALIDATION] ⚠️ Missing ${auth_session} in JVM arguments - will be added during enrichment');
      }

      // Check for required authentication libraries
      const libraries = profileJson.libraries || [];
      const authLibrary = libraries.find(lib => 
        lib.name && lib.name.includes('com.mojang:authlib')
      );

      if (!authLibrary) {
        console.warn('[FABRIC VALIDATION] ⚠️ Missing com.mojang:authlib library - this may be inherited from vanilla');
        // Don't fail for missing authlib as it may be inherited
      } else {
        console.log('[FABRIC VALIDATION] ✅ Auth library found:', authLibrary.name);
      }

      console.log('[FABRIC VALIDATION] ✅ Fabric profile validation passed');
      
      return true;

    } catch (error) {
      console.error('[FABRIC VALIDATION] ❌ Error validating Fabric profile:', error.message);
      return false;
    }
  }

  // New method: Use proper launcher for LogUtils fix
  async launchMinecraftProper(options) {
    try {
      console.log(`[MinecraftLauncher] 🔧 Using XMCL proper launcher to fix LogUtils issues...`);
      
      // Set authentication data
      if (this.authHandler.authData) {
        this.properLauncher.setAuthData(this.authHandler.authData);
      } else {
        throw new Error('No authentication data available. Please authenticate first.');
      }
      
      // Forward the call to the proper launcher
      const result = await this.properLauncher.launchMinecraft(options);
      
      // Update our state to match
      if (result.success) {
        this.isLaunching = this.properLauncher.isLaunching;
        this.client = this.properLauncher.client;
        this.clientPath = options.clientPath;
        
        // Forward events
        this.properLauncher.on('minecraft-stopped', () => {
          this.emit('minecraft-stopped');
        });
      }
      
      return result;
      
    } catch (error) {
      console.error(`[MinecraftLauncher] Proper launcher failed:`, error);
      return {
        success: false,
        error: error.message,
        message: `Failed to launch with proper launcher: ${error.message}`
      };
    }
  }

  async handleServerVersionChanged(info) {
    if (!this.clientPath) {
      return;
    }
    const { minecraftVersion, loaderType, loaderVersion } = info;
    console.log(`[MinecraftLauncher] Detected server version change:`, info);
    await this.clientDownloader.updateForServerVersion({
      clientPath: this.clientPath,
      mcVersion: minecraftVersion,
      fabricVersion: loaderType === 'fabric' ? loaderVersion : null,
      serverPath: info.serverPath,
      requiredMods: info.requiredMods || [],
      allClientMods: info.allClientMods || []
    });
  }
}

// Singleton instance
let launcherInstance = null;

function getMinecraftLauncher() {
  if (!launcherInstance) {
    launcherInstance = new MinecraftLauncher();
    // Redirect all calls to the new "Simple" downloader:
    launcherInstance.downloadMinecraftClient = launcherInstance.downloadMinecraftClientSimple;
  }
  return launcherInstance;
}

module.exports = {
  MinecraftLauncher,
  getMinecraftLauncher
}; 
