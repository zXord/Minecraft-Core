// Minecraft launcher service for client launching with Microsoft authentication
console.log('🔥🔥🔥 MINECRAFT LAUNCHER SERVICE (index.cjs) LOADED - TIMESTAMP: ' + new Date().toISOString() + ' 🔥🔥🔥');
const { Client: MCLCClient, Authenticator } = require('minecraft-launcher-core'); // Renamed Client to MCLCClient to avoid conflict
// const { Auth } = require('msmc'); // Moved to auth-handler.cjs
const fs = require('fs');
const path = require('path');
// const os = require('os'); // Moved to utils.cjs if only used by moved utils
const { EventEmitter } = require('events');
const { JavaManager } = require('./java-manager.cjs');
const { AuthHandler } = require('./auth-handler.cjs');
const { ClientDownloader } = require('./client-downloader.cjs');
const utils = require('./utils.cjs'); // Added import for utils

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
    
    // Log system information for debugging
    utils.logSystemInfo(); // Use util function
    // Update alias to use the downloader's method
    this.downloadMinecraftClient = this.clientDownloader.downloadMinecraftClientSimple.bind(this.clientDownloader);
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
  
  // Manual download method as fallback when MCLC fails
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
    
    // CRITICAL: Check if this is a Fabric server and we need Fabric client
    const needsFabric = serverInfo?.loaderType === 'fabric' || requiredMods.length > 0;
    let fabricVersion = serverInfo?.loaderVersion || 'latest';
    
    console.log(`[MinecraftLauncher] Starting launch for Minecraft ${minecraftVersion} with ${maxMemory || 'auto'}MB RAM`);
    console.log(`[MinecraftLauncher] Needs Fabric: ${needsFabric}, Fabric version: ${fabricVersion}`);
    
    if (!this.authHandler.authData) { // Changed to this.authHandler.authData
      throw new Error('Not authenticated. Please login first.');
    }
    
    if (this.isLaunching) {
      // Check if we're actually launching or just stuck in launching state
      let actuallyLaunching = false;
      
      if (this.client && this.client.child) {
        try {
          // Check if the process is still alive
          const pid = this.client.child.pid;
          if (pid) {
            process.kill(pid, 0); // Signal 0 just tests if process exists
            actuallyLaunching = true;
          }
        } catch (e) {
          // Process doesn't exist, we're stuck in launching state
          actuallyLaunching = false;
        }
      }
      
      if (actuallyLaunching) {
        throw new Error('Minecraft is already launching');
      } else {
        console.log(`[MinecraftLauncher] Launcher was stuck in launching state, resetting...`);
        this.resetLauncherState();
      }
    }
    
    this.isLaunching = true;
    this.clientPath = clientPath;
    
    // Update JavaManager to use client-specific directory
    this.javaManager.setClientPath(clientPath);
    
    try {
      console.log(`[MinecraftLauncher] Launching Minecraft ${minecraftVersion} for ${this.authHandler.authData.name}`); // Changed to this.authHandler.authData
      console.log(`[MinecraftLauncher] Client path: ${clientPath}`);
      console.log(`[MinecraftLauncher] Java will be downloaded to: ${path.join(clientPath, 'java')}`);
      
      // Determine the launch version based on what's available
      let launchVersion = minecraftVersion; // Default to vanilla
      
      if (needsFabric) {
        // Get the Fabric profile name that should have been installed during client download
        if (fabricVersion === 'latest') {
          try {
            const fetch = require('node-fetch');
            const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
            const loaders = await response.json();
            fabricVersion = loaders[0].version;
          } catch (error) {
            fabricVersion = '0.14.21'; // Fallback version
          }
        }
        
        const fabricProfileName = `fabric-loader-${fabricVersion}-${minecraftVersion}`;
        const fabricProfileDir = path.join(clientPath, 'versions', fabricProfileName);
        
        if (fs.existsSync(fabricProfileDir)) {
          launchVersion = fabricProfileName;
          console.log(`[MinecraftLauncher] Using existing Fabric profile: ${fabricProfileName}`);
        } else {
          throw new Error(`Fabric profile ${fabricProfileName} not found. Please download the client files first.`);
        }
      }
      
      console.log(`[MinecraftLauncher] Launch version: ${launchVersion} (${needsFabric ? 'Fabric' : 'Vanilla'})`);
      
      // Fix Fabric asset index if needed
      if (needsFabric) {
        console.log(`[MinecraftLauncher] Fixing Fabric profile asset index for MCLC compatibility...`);
        await this.fixFabricAssetIndex(clientPath, launchVersion, minecraftVersion);
      }
      
      // Determine required Java version and ensure it's available
      const requiredJavaVersion = this.getRequiredJavaVersion(minecraftVersion);
      console.log(`[MinecraftLauncher] Minecraft ${minecraftVersion} requires Java ${requiredJavaVersion}`);
      
      let javaResult;
      try {
        // Try our client-specific downloaded Java first
        this.emit('launch-progress', {
          type: 'Java',
          task: `Ensuring Java ${requiredJavaVersion} is available...`,
          total: 0
        });
        
        console.log(`[MinecraftLauncher] Attempting to ensure Java ${requiredJavaVersion}...`);
        console.log(`[MinecraftLauncher] JavaManager base directory: ${this.javaManager.javaBaseDir}`);
        console.log(`[MinecraftLauncher] Checking if Java ${requiredJavaVersion} is already installed...`);
        
        // Check if Java is already installed first
        const isAlreadyInstalled = this.javaManager.isJavaInstalled(requiredJavaVersion);
        console.log(`[MinecraftLauncher] Java ${requiredJavaVersion} already installed: ${isAlreadyInstalled}`);
        
        if (isAlreadyInstalled) {
          const existingJavaPath = this.javaManager.getJavaExecutablePath(requiredJavaVersion);
          console.log(`[MinecraftLauncher] Existing Java path: ${existingJavaPath}`);
        }
        
        javaResult = await this.javaManager.ensureJava(requiredJavaVersion, (progress) => {
          console.log(`[MinecraftLauncher] Java progress: ${progress.type} - ${progress.task}`);
          this.emit('launch-progress', {
            type: progress.type,
            task: progress.task,
            total: progress.totalMB || 0,
            current: progress.downloadedMB || 0
          });
        });
        
        console.log(`[MinecraftLauncher] ensureJava result:`, {
          success: javaResult.success,
          javaPath: javaResult.javaPath,
          error: javaResult.error
        });
        
        if (!javaResult.success) {
          throw new Error(`Client-specific Java failed: ${javaResult.error}`);
        }
        
        console.log(`[MinecraftLauncher] Java ${requiredJavaVersion} available at: ${javaResult.javaPath}`);
        
        // Test our downloaded Java directly with very conservative settings
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        console.log(`[MinecraftLauncher] Testing client-specific Java: "${javaResult.javaPath}" -Xmx256M -Xms128M -version`);
        const testResult = await execAsync(`"${javaResult.javaPath}" -Xmx256M -Xms128M -version`, { timeout: 10000 });
        console.log(`[MinecraftLauncher] Client-specific Java test passed:`, testResult.stdout || testResult.stderr);
        
      } catch (downloadedJavaError) {
        console.error(`[MinecraftLauncher] ❌ CRITICAL: Client-specific Java failed:`, downloadedJavaError.message);
        
        // For now, let's throw an error instead of falling back to system Java
        // This will help us debug why the client-specific Java isn't working
        throw new Error(`Client-specific Java failed and we need to fix this root cause: ${downloadedJavaError.message}`);
      }
      
      // Log Java installation details
      console.log(`[MinecraftLauncher] Java installation details:`);
      console.log(`[MinecraftLauncher] - Java path: ${javaResult.javaPath}`);
      console.log(`[MinecraftLauncher] - Java base directory: ${this.javaManager.javaBaseDir}`);
      console.log(`[MinecraftLauncher] - Platform: ${this.javaManager.platform}`);
      console.log(`[MinecraftLauncher] - Architecture: ${this.javaManager.architecture}`);
      
      // Check if Java file actually exists
      if (!fs.existsSync(javaResult.javaPath)) {
        throw new Error(`Java executable not found at: ${javaResult.javaPath}`);
      }
      
      const javaStats = fs.statSync(javaResult.javaPath);
      console.log(`[MinecraftLauncher] - Java file size: ${javaStats.size} bytes`);
      console.log(`[MinecraftLauncher] - Java file permissions: ${javaStats.mode.toString(8)}`);
      
      // Check for path issues that might cause JVM problems
      if (javaResult.javaPath.includes(' ')) {
        console.log(`[MinecraftLauncher] - WARNING: Java path contains spaces: ${javaResult.javaPath}`);
      }
      
      // Convert to short path on Windows to avoid space issues
      let finalJavaPath = javaResult.javaPath;
      if (process.platform === 'win32' && javaResult.javaPath.includes(' ')) {
        try {
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          // Get short path equivalent (8.3 format) to avoid space issues
          const { stdout } = await execAsync(`for %I in ("${javaResult.javaPath}") do @echo %~sI`, { shell: 'cmd' });
          const shortPath = stdout.trim();
          if (shortPath && fs.existsSync(shortPath)) {
            finalJavaPath = shortPath;
            console.log(`[MinecraftLauncher] - Using short path: ${finalJavaPath}`);
          }
        } catch (pathError) {
          console.warn(`[MinecraftLauncher] - Could not get short path: ${pathError.message}`);
        }
      }
      
      console.log(`[MinecraftLauncher] Using Java: ${finalJavaPath}`);
      
      // Use memory settings from client UI or calculate automatically
      let finalMaxMemory, finalMinMemory;
      
      if (maxMemory && maxMemory > 0) {
        // Use memory setting provided by client UI
        finalMaxMemory = maxMemory; // Already in MB
        finalMinMemory = Math.min(Math.floor(maxMemory / 4), 512); // Min is 1/4 of max, capped at 512MB
        console.log(`[MinecraftLauncher] Using client-specified memory: ${finalMinMemory}MB to ${finalMaxMemory}MB`);
      } else {
        // Use extremely conservative memory settings to prevent JVM fatal exceptions
        finalMaxMemory = 256; // MB as number, not string
        finalMinMemory = 128; // MB as number, not string
        
        // Check system memory and adjust very conservatively
        const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
        console.log(`[MinecraftLauncher] System total memory: ${totalMemoryGB.toFixed(1)} GB`);
        
        if (totalMemoryGB >= 16) {
          finalMaxMemory = 1024; // 1GB
          finalMinMemory = 512;   // 512MB
        } else if (totalMemoryGB >= 8) {
          finalMaxMemory = 768;   // 768MB
          finalMinMemory = 384;   // 384MB
        } else if (totalMemoryGB >= 4) {
          finalMaxMemory = 512;   // 512MB
          finalMinMemory = 256;   // 256MB
        } else if (totalMemoryGB >= 2) {
          finalMaxMemory = 384;   // 384MB
          finalMinMemory = 192;   // 192MB
        } else {
          // Very limited memory systems - absolute minimum
          finalMaxMemory = 256;   // 256MB
          finalMinMemory = 128;   // 128MB
        }
        
        console.log(`[MinecraftLauncher] Auto-calculated memory settings: ${finalMinMemory}MB to ${finalMaxMemory}MB (based on ${totalMemoryGB.toFixed(1)}GB system memory)`);
      }
      
      // Test Java with progressively lower memory settings until one works
      console.log(`[MinecraftLauncher] Testing Java with memory settings to prevent JVM fatal exception...`);
      let workingMaxMemory = finalMaxMemory;
      let workingMinMemory = finalMinMemory;
      
      const memoryTests = [
        { max: finalMaxMemory, min: finalMinMemory },
        { max: 256, min: 128 },
        { max: 192, min: 96 },
        { max: 128, min: 64 }
      ];
      
      let javaTestPassed = false;
      
      for (const memTest of memoryTests) {
        try {
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          // Use javaw.exe for testing to avoid console window (Windows)
          let testJavaPath = finalJavaPath;
          if (process.platform === 'win32' && finalJavaPath.includes('java.exe')) {
            testJavaPath = finalJavaPath.replace('java.exe', 'javaw.exe');
          }
          
          const javaTestCommand = `"${testJavaPath}" -Xmx${memTest.max}M -Xms${memTest.min}M -version`;
          console.log(`[MinecraftLauncher] Testing memory settings: ${memTest.min}MB to ${memTest.max}MB`);
          
          const testResult = await execAsync(javaTestCommand, { 
            timeout: 15000,
            windowsHide: true // Hide console window on Windows
          });
          console.log(`[MinecraftLauncher] Java memory test PASSED with ${memTest.min}MB to ${memTest.max}MB`);
          
          workingMaxMemory = memTest.max;
          workingMinMemory = memTest.min;
          javaTestPassed = true;
          break;
          
        } catch (javaTestError) {
          console.error(`[MinecraftLauncher] Java memory test FAILED with ${memTest.min}MB to ${memTest.max}MB:`, javaTestError.message);
          
          if (javaTestError.message.includes('Could not create the Java Virtual Machine') || 
              javaTestError.message.includes('heap size') ||
              javaTestError.message.includes('Initial heap size')) {
            console.log(`[MinecraftLauncher] JVM error detected, trying lower memory settings...`);
            continue; // Try next lower memory setting
          } else {
            // Some other Java error that won't be fixed by lower memory
            throw new Error(`Java test failed with non-memory error: ${javaTestError.message}`);
          }
        }
      }
      
      if (!javaTestPassed) {
        throw new Error(`Java Virtual Machine error: All memory settings failed. Your system may have insufficient memory or Java installation issues. Please ensure you have Java properly installed and at least 512MB of free RAM.`);
      }
      
      console.log(`[MinecraftLauncher] Final memory settings: ${workingMinMemory}MB to ${workingMaxMemory}MB`);
      
      // Update the memory variables with working values
      finalMaxMemory = workingMaxMemory;
      finalMinMemory = workingMinMemory;
      
      // Check and refresh authentication if needed
      console.log('[MinecraftLauncher] Checking authentication status...');
      const authCheck = await this.authHandler.checkAndRefreshAuth(); // Delegated
      
      if (!authCheck.success) {
        if (authCheck.needsReauth) {
          throw new Error('Authentication expired. Please re-authenticate with Microsoft and try again.');
        } else {
          throw new Error(`Authentication error: ${authCheck.error}`);
        }
      }
      
      if (authCheck.refreshed) {
        console.log('[MinecraftLauncher] Authentication token was refreshed');
        // Save the refreshed auth data (now handled by authHandler internally if needed, or save explicitly)
        await this.authHandler.saveAuthData(clientPath); // Delegated
      } else if (authCheck.networkError) {
        console.log('[MinecraftLauncher] Proceeding with cached authentication due to network issues');
      }
      
      // Validate client path
      if (!fs.existsSync(clientPath)) {
        console.log('[MinecraftLauncher] Creating client directory:', clientPath);
        fs.mkdirSync(clientPath, { recursive: true });
      }
      
      console.log('[MinecraftLauncher] Client path exists:', clientPath);
      
      // Create essential directories if they don't exist
      const essentialDirs = ['versions', 'libraries', 'assets', 'mods'];
      for (const dir of essentialDirs) {
        const dirPath = path.join(clientPath, dir);
        if (!fs.existsSync(dirPath)) {
          console.log(`[MinecraftLauncher] Creating directory: ${dirPath}`);
          fs.mkdirSync(dirPath, { recursive: true });
        } else {
          console.log(`[MinecraftLauncher] Found directory: ${dirPath}`);
        }
      }
      
      // Check if authentication might need refresh (try to refresh if token seems old)
      let authorization;
      try {
        // Access authData through authHandler
        if (this.authHandler.authData.meta && this.authHandler.authData.meta.mclc) {
          console.log('[MinecraftLauncher] Using MSMC mclc() method for authorization');
          authorization = this.authHandler.authData.meta.mclc();
        } else {
          console.log('[MinecraftLauncher] Using stored auth data for authorization');
          authorization = {
            access_token: this.authHandler.authData.access_token,
            client_token: this.authHandler.authData.client_token,
            uuid: this.authHandler.authData.uuid,
            name: this.authHandler.authData.name,
            user_properties: this.authHandler.authData.user_properties || {}
          };
        }
        
        console.log('[MinecraftLauncher] Authorization prepared:', {
          name: authorization.name || 'unknown',
          uuid: authorization.uuid || 'unknown',
          hasAccessToken: !!authorization.access_token,
          tokenLength: authorization.access_token ? authorization.access_token.length : 0
        });
        
      } catch (authError) {
        console.error('[MinecraftLauncher] Auth preparation error:', authError);
        throw new Error('Authentication error: Please re-authenticate with Microsoft');
      }
      
      const launchOptions = {
        authorization: authorization,
        root: clientPath,
        version: {
          number: launchVersion, // Use Fabric profile name if Fabric, otherwise vanilla
          type: "release"
        },
        // Use MCLC's built-in memory handling
        memory: {
          min: `${finalMinMemory}M`,
          max: `${finalMaxMemory}M`
        },
        // Java configuration
        java: {
          path: finalJavaPath,
          args: [
            // Modern JVM flags for better performance
            "-XX:+UseG1GC",
            "-XX:+UnlockExperimentalVMOptions",
            "-XX:G1NewSizePercent=20",
            "-XX:G1ReservePercent=20",
            "-XX:MaxGCPauseMillis=50",
            "-XX:G1HeapRegionSize=32M"
          ]
        },
        // Server connection (MCLC will handle automatically)
        server: {
          ip: serverIp,
          port: parseInt(serverPort)
        },
        // CRITICAL: Configure MCLC to handle asset downloads properly
        download: true,              // Force MCLC to download any missing assets
        downloadAssets: true,        // Explicitly enable asset downloading
        forge: false,                // We're using Fabric, not Forge
        // Basic options
        clientPackage: null,
        removePackage: false,
        cwd: clientPath,
        overrides: {
          gameDirectory: clientPath
        }
      };
      
      console.log(`[MinecraftLauncher] Launch configuration ready`);
      
      // Add server to the multiplayer server list so it appears automatically
      await this.addServerToList(clientPath, {
        name: serverInfo?.serverInfo?.name || serverInfo?.name || 'Game Server',
        ip: serverIp,
        port: parseInt(serverPort)
      });
      
      console.log('[MinecraftLauncher] Launch options prepared:', {
        root: launchOptions.root,
        version: launchOptions.version,
        serverConnection: `${serverIp}:${parseInt(serverPort)}`,
        hasAuth: !!launchOptions.authorization,
        javaPath: launchOptions.java.path,
        javaArgs: launchOptions.java.args,
        maxMemoryInput: maxMemory,
        finalMaxMemory: finalMaxMemory,
        finalMinMemory: finalMinMemory
      });
      
      // Log the complete launch options for debugging
      console.log('[MinecraftLauncher] Complete launch options:');
      console.log(JSON.stringify(launchOptions, null, 2));
      
      // Create Minecraft Launcher Core client
      this.client = new Client();
      
      // Set up event listeners for detailed logging
      this.client.on('debug', (e) => console.log(`[MCLC Debug] ${e}`));
      this.client.on('data', (e) => console.log(`[MCLC Data] ${e}`));
      this.client.on('progress', (e) => {
        console.log(`[MCLC Progress] ${e.type}: ${e.task} (${e.total})`);
        this.emit('launch-progress', {
          type: e.type,
          task: e.task,
          total: e.total
        });
      });
      
      // Log MCLC arguments for debugging
      this.client.on('arguments', (args) => {
        console.log(`[MCLC] Launching with Java: ${args[0]}`);
        const memoryFlags = args.filter(arg => arg.startsWith('-Xm'));
        if (memoryFlags.length > 0) {
          console.log(`[MCLC] Memory settings: ${memoryFlags.join(', ')}`);
        }
      });
      
      this.client.on('close', (code) => {
        console.log(`[MinecraftLauncher] Minecraft closed with code: ${code}`);
        this.isLaunching = false;
        this.client = null;
        this.emit('minecraft-closed', { code });
      });
      
      // Add error handler for the client
      this.client.on('error', (error) => {
        console.error('[MCLC Error]', error);
        this.isLaunching = false;
        this.client = null;
        this.emit('launch-error', error.message);
      });
      
      // Validate asset index before launch to prevent MCLC errors
      console.log('[MinecraftLauncher] Validating asset index before launch...');
      try {
        const versionsDir = path.join(clientPath, 'versions');
        const assetsIndexesDir = path.join(clientPath, 'assets', 'indexes');
        
        // Find the asset index file for this version
        let assetIndexFile = null;
        
                 if (needsFabric) {
           // For Fabric, check the vanilla version's asset index  
           const vanillaJsonPath = path.join(versionsDir, minecraftVersion, `${minecraftVersion}.json`);
          if (fs.existsSync(vanillaJsonPath)) {
            const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
            if (vanillaJson.assetIndex && vanillaJson.assetIndex.id) {
              assetIndexFile = path.join(assetsIndexesDir, `${vanillaJson.assetIndex.id}.json`);
            }
          }
                 } else {
           // For vanilla, check the version's asset index
           const versionJsonPath = path.join(versionsDir, minecraftVersion, `${minecraftVersion}.json`);
          if (fs.existsSync(versionJsonPath)) {
            const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
            if (versionJson.assetIndex && versionJson.assetIndex.id) {
              assetIndexFile = path.join(assetsIndexesDir, `${versionJson.assetIndex.id}.json`);
            }
          }
        }
        
        if (assetIndexFile && fs.existsSync(assetIndexFile)) {
          const assetIndex = JSON.parse(fs.readFileSync(assetIndexFile, 'utf8'));
          
          if (!assetIndex.objects || typeof assetIndex.objects !== 'object') {
            throw new Error('Asset index missing or invalid objects property');
          }
          
          const objectEntries = Object.values(assetIndex.objects);
          const invalidEntries = objectEntries.filter(obj => !obj.url || !obj.hash);
          
          if (invalidEntries.length > 0) {
            throw new Error(`Asset index malformed: ${invalidEntries.length} entries missing url or hash properties`);
          }
          
          console.log(`[MinecraftLauncher] ✅ Asset index validated: ${objectEntries.length} entries with proper URLs`);
        } else {
          console.warn(`[MinecraftLauncher] ⚠️ Asset index file not found, MCLC will handle downloads`);
        }
      } catch (validationError) {
        console.error(`[MinecraftLauncher] Asset index validation failed: ${validationError.message}`);
        throw new Error(`Cannot launch: Asset index validation failed - ${validationError.message}`);
      }
      
      // Set JAVA_HOME to ensure MCLC uses our downloaded Java
      const originalJavaHome = process.env.JAVA_HOME;
      const clientJavaHome = path.dirname(path.dirname(finalJavaPath));
      process.env.JAVA_HOME = clientJavaHome;
      
      // Launch Minecraft
      console.log('[MinecraftLauncher] Starting Minecraft launch...');
      this.emit('launch-start');
      
      console.log(`[MinecraftLauncher] Starting ${needsFabric ? 'Fabric' : 'Vanilla'} Minecraft ${launchVersion}...`);
      
      // Standard MCLC launch
      let launchResult; // Declare outside try block for proper scoping
      try {
        console.log('[MinecraftLauncher] Launching with configuration:');
        console.log('[MinecraftLauncher] - Version:', launchOptions.version);
        console.log('[MinecraftLauncher] - Java path:', launchOptions.java.path);
        console.log('[MinecraftLauncher] - Memory:', launchOptions.memory);
        console.log('[MinecraftLauncher] - Server:', `${launchOptions.server.ip}:${launchOptions.server.port}`);
        console.log('[MinecraftLauncher] - User:', launchOptions.authorization.name);
        
        launchResult = await this.client.launch(launchOptions);
        console.log('[MinecraftLauncher] client.launch() returned:', launchResult);
        
        // Add more detailed information about what was returned
        if (launchResult) {
          console.log('[MinecraftLauncher] Launch result details:', {
            pid: launchResult.pid || 'none',
            killed: launchResult.killed || 'unknown',
            exitCode: launchResult.exitCode || 'none',
            signalCode: launchResult.signalCode || 'none',
            hasStdout: !!launchResult.stdout,
            hasStderr: !!launchResult.stderr
          });
          
          // Set up monitoring for the returned process if it exists
          if (launchResult.stdout) {
            launchResult.stdout.on('data', (data) => {
              console.log(`[Minecraft stdout] ${data.toString()}`);
            });
          }
          
          if (launchResult.stderr) {
            launchResult.stderr.on('data', (data) => {
              console.log(`[Minecraft stderr] ${data.toString()}`);
            });
          }
          
          if (launchResult.on) {
            launchResult.on('exit', (code, signal) => {
              console.log(`[MinecraftLauncher] Launch result process exited with code: ${code}, signal: ${signal}`);
            });
          }
        }
      } catch (launchError) {
        console.error('[MinecraftLauncher] Launch error details:', launchError);
        
        // Check for specific error types and provide helpful messages
        if (launchError.message && (
          launchError.message.includes('authserver.mojang.com') ||
          launchError.message.includes('ENOTFOUND') ||
          launchError.message.includes('authentication') ||
          launchError.message.includes('Invalid credentials')
        )) {
          throw new Error('Authentication expired. Please re-authenticate with Microsoft and try again.');
        } else if (launchError.message && launchError.message.includes('EMFILE')) {
          throw new Error('Too many files open. Please close other applications and try again.');
        } else if (launchError.message && (
          launchError.message.includes('Could not create the Java Virtual Machine') ||
          launchError.message.includes('java.lang.OutOfMemoryError') ||
          launchError.message.includes('Initial heap size') ||
          launchError.message.includes('Maximum heap size')
        )) {
          throw new Error('Java Virtual Machine error. Try freeing up system memory by closing other applications. If the problem persists, try restarting your computer.');
        } else if (launchError.message && launchError.message.includes('java')) {
          throw new Error(`Java error: ${launchError.message}. Please ensure you have Java 8 or higher installed.`);
        } else {
          throw launchError;
        }
      }
      
      // Wait and check if the process actually started
      console.log('[MinecraftLauncher] Checking if Minecraft process started...');
      
      // Wait a moment for the process to actually start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check if we have a running process
      let processStarted = false;
      let minecraftPid = null;
      
      if (this.client && this.client.child) {
        minecraftPid = this.client.child.pid;
        console.log(`[MinecraftLauncher] Minecraft process detected with PID: ${minecraftPid}`);
        processStarted = true;
        
        // Set up process monitoring
        this.client.child.on('exit', (code, signal) => {
          console.log(`[MinecraftLauncher] Minecraft process exited with code: ${code}, signal: ${signal}`);
          this.isLaunching = false;
          this.client = null;
          this.emit('minecraft-closed', { code, signal });
        });
        
        this.client.child.on('error', (error) => {
          console.error('[MinecraftLauncher] Minecraft process error:', error);
          this.isLaunching = false;
          this.client = null;
          this.emit('launch-error', `Process error: ${error.message}`);
        });
        
        // Monitor stdout/stderr for Minecraft startup messages
        if (this.client.child.stdout) {
          this.client.child.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`[Minecraft stdout] ${output}`);
            
            // Look for success indicators
            if (output.includes('Minecraft') || output.includes('Starting Minecraft')) {
              console.log('[MinecraftLauncher] Minecraft startup detected in output');
            }
          });
        }
        
        if (this.client.child.stderr) {
          this.client.child.stderr.on('data', (data) => {
            const output = data.toString();
            console.log(`[Minecraft stderr] ${output}`);
            
            // Look for error indicators
            if (output.includes('Could not find or load main class') || 
                output.includes('UnsupportedClassVersionError') ||
                output.includes('Exception')) {
              console.error('[MinecraftLauncher] Critical error detected in Minecraft output:', output);
            }
          });
        }
        
      } else {
        console.warn('[MinecraftLauncher] No direct process access from MCLC');
        
        // Try to find the Minecraft process manually
        if (process.platform === 'win32') {
          try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            
            const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq javaw.exe" /FO CSV', { timeout: 5000 });
            const lines = stdout.split('\n');
            
            if (lines.length > 1) { // Header + at least one process
              console.log(`[MinecraftLauncher] Found ${lines.length - 1} javaw.exe processes running`);
              processStarted = true;
            }
          } catch (processCheckError) {
            console.warn('[MinecraftLauncher] Could not check for running Java processes:', processCheckError.message);
          }
        }
      }
      
      if (processStarted) {
        console.log('[MinecraftLauncher] Minecraft process started successfully');
        this.emit('launch-success');
        
        // Restore original JAVA_HOME
        if (originalJavaHome) {
          process.env.JAVA_HOME = originalJavaHome;
        } else {
          delete process.env.JAVA_HOME;
        }
        
        return { success: true, pid: minecraftPid };
      } else {
        console.error('[MinecraftLauncher] Minecraft process did not start or could not be detected');
        
        // Restore original JAVA_HOME
        if (originalJavaHome) {
          process.env.JAVA_HOME = originalJavaHome;
        } else {
          delete process.env.JAVA_HOME;
        }
        
        throw new Error('Minecraft process failed to start. Check the console for error details.');
      }
      
    } catch (error) {
      console.error('[MinecraftLauncher] Launch error:', error);
      this.isLaunching = false;
      this.client = null;
      this.emit('launch-error', error.message);
      throw error;
    }
  }
  
  // Stop Minecraft if running
  async stopMinecraft() {
    try {
      console.log('[MinecraftLauncher] Stopping Minecraft...');
      
      let stopped = false;
      
      // Method 1: Stop via MCLC client if available
      if (this.client && this.client.child) {
        console.log('[MinecraftLauncher] Stopping via MCLC client process...');
        try {
          // minecraft-launcher-core provides access to the child process
          this.client.child.kill('SIGTERM');
          
          // Wait a moment, then force kill if necessary
          setTimeout(() => {
            if (this.client && this.client.child && !this.client.child.killed) {
              console.log('[MinecraftLauncher] Force killing Minecraft process...');
              this.client.child.kill('SIGKILL');
            }
          }, 3000);
          
          stopped = true;
          console.log('[MinecraftLauncher] MCLC client process terminated');
        } catch (error) {
          console.warn('[MinecraftLauncher] Error stopping MCLC client process:', error.message);
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
}

// Singleton instance
let launcherInstance = null;

function getMinecraftLauncher() {
  console.log('💡 getMinecraftLauncher() CALLED - launcherInstance exists:', !!launcherInstance);
  if (!launcherInstance) {
    console.log('💡 Creating new MinecraftLauncher instance...');
    launcherInstance = new MinecraftLauncher();
    // Redirect all calls to the new "Simple" downloader:
    launcherInstance.downloadMinecraftClient = launcherInstance.downloadMinecraftClientSimple;
    console.log('🔧 LAUNCHER INSTANCE CREATED - downloadMinecraftClient now aliases to downloadMinecraftClientSimple');
    console.log('💡 Available methods on instance:', Object.getOwnPropertyNames(Object.getPrototypeOf(launcherInstance)).filter(name => name.startsWith('download')));
  } else {
    console.log('💡 Returning existing launcher instance');
  }
  return launcherInstance;
}

module.exports = {
  MinecraftLauncher,
  getMinecraftLauncher
}; 