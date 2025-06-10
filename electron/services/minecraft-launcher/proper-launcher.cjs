// Proper Minecraft launcher using @xmcl packages to fix LogUtils and other issues
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Import the XMCL installer package with correct function names
const { installVersion, installAssets, installLibraries, installDependencies, installFabric } = require('@xmcl/installer');

class ProperMinecraftLauncher extends EventEmitter {
  constructor() {
    super();
    this.isLaunching = false;
    this.client = null;
    this.authData = null;
    this.clientPath = null;
  }

  // Set authentication data
  setAuthData(authData) {
    this.authData = authData;
  }

  // Properly install/verify Minecraft client using XMCL packages
  async ensureMinecraftClient(clientPath, version) {
    try {
      
      this.clientPath = clientPath;
      
      // Ensure directories exist
      const versionsDir = path.join(clientPath, 'versions');
      const librariesDir = path.join(clientPath, 'libraries');
      const assetsDir = path.join(clientPath, 'assets');
      
      for (const dir of [versionsDir, librariesDir, assetsDir]) {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      // Step 1: Install version using the correct XMCL function (installVersion not installVersionProfile)
      await installVersion(version, clientPath, {
        side: 'client'
      });
      
      
      // Verify the version JSON exists
      const versionJsonPath = path.join(versionsDir, version, `${version}.json`);
      if (!fs.existsSync(versionJsonPath)) {
        throw new Error(`Version JSON not found after installation: ${versionJsonPath}`);
      }
      
      const versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
      
      // Step 2: Install libraries
      await installLibraries(versionJson, clientPath);
      
      // Step 3: Install assets
      await installAssets(versionJson, clientPath);
      
      // Step 4: Install native dependencies
      await installDependencies(versionJson, clientPath);
      
      
      // Verify the vanilla JAR has LogUtils
      const vanillaJar = path.join(versionsDir, version, `${version}.jar`);
      if (fs.existsSync(vanillaJar)) {
        const zip = new (require('adm-zip'))(vanillaJar);
        const entries = zip.getEntries();
        const logUtilsEntry = entries.find(entry => entry.entryName === 'com/mojang/logging/LogUtils.class');
        
        if (logUtilsEntry) {
        } else {
          
          // Show what logging classes are available
          entries.filter(entry => entry.entryName.startsWith('com/mojang/logging/') && entry.entryName.endsWith('.class'));
        }
        
      }
      
      return { success: true };
      
    } catch (error) {
      throw error;
    }
  }

  // Install Fabric loader properly
  async installFabric(clientPath, minecraftVersion, fabricVersion = 'latest') {
    try {
      
      // Get latest Fabric version if needed
      if (fabricVersion === 'latest') {
        const response = await fetch('https://meta.fabricmc.net/v2/versions/loader');
        const loaders = await response.json();
        fabricVersion = loaders[0].version;
      }
      
      // Use XMCL installer for Fabric
      await installFabric({
        minecraftVersion,
        version: fabricVersion,
        minecraft: clientPath,
        side: 'client'
      });
      
      return { success: true, version: `fabric-loader-${fabricVersion}-${minecraftVersion}` };
      
    } catch (error) {
      throw error;
    }
  }

  // Launch Minecraft manually with proper classpath 
  async launchMinecraft(options) {
    try {
      const {
        clientPath,
        minecraftVersion,
        serverIp,
        serverPort,
        maxMemory = 4096,
        needsFabric = false,
        fabricVersion = 'latest'
      } = options;

      
      if (this.isLaunching) {
        throw new Error('Minecraft is already launching');
      }
      
      if (!this.authData) {
        throw new Error('No authentication data available');
      }
      
      this.isLaunching = true;
      
      // Ensure Minecraft is properly installed
      await this.ensureMinecraftClient(clientPath, minecraftVersion);
      
      // Install Fabric if needed
      let launchVersion = minecraftVersion;
      if (needsFabric) {
        const fabricResult = await this.installFabric(clientPath, minecraftVersion, fabricVersion);
        launchVersion = fabricResult.version;
      }
      
      // Build launch arguments manually
      const versionsDir = path.join(clientPath, 'versions');
      const launchJsonPath = path.join(versionsDir, launchVersion, `${launchVersion}.json`);
      
      if (!fs.existsSync(launchJsonPath)) {
        throw new Error(`Launch profile not found: ${launchJsonPath}`);
      }
      
      const launchJson = JSON.parse(fs.readFileSync(launchJsonPath, 'utf8'));
      
      // Build classpath - vanilla JAR should now have LogUtils
      const classpath = [];
      
      // Add vanilla JAR first (this should now have LogUtils)
      const vanillaJar = path.join(clientPath, 'versions', minecraftVersion, `${minecraftVersion}.jar`);
      if (fs.existsSync(vanillaJar)) {
        classpath.push(vanillaJar);
      } else {
        throw new Error(`Vanilla JAR not found: ${vanillaJar}`);
      }
      
      // Add all libraries from the launch profile
      if (launchJson.libraries && Array.isArray(launchJson.libraries)) {
        
        for (const lib of launchJson.libraries) {
          if (lib.name && lib.downloads?.artifact) {
            const libPath = path.join(clientPath, 'libraries', lib.downloads.artifact.path);
            if (fs.existsSync(libPath)) {
              classpath.push(libPath);
            } else {
            }
          }
        }
      }
      
      
      // Build JVM arguments
      const jvmArgs = [
        `-Xmx${maxMemory}M`,
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
        '-XX:MaxTenuringThreshold=1',
        `-Djava.library.path=${path.join(clientPath, 'versions', launchVersion, 'natives')}`,
        '-cp', classpath.join(process.platform === 'win32' ? ';' : ':')
      ];
      
      // Add additional JVM args from profile
      if (launchJson.arguments?.jvm) {
        for (const arg of launchJson.arguments.jvm) {
          if (typeof arg === 'string' && !jvmArgs.includes(arg)) {
            let processedArg = arg
              .replace(/\$\{natives_directory\}/g, path.join(clientPath, 'versions', launchVersion, 'natives'))
              .replace(/\$\{launcher_name\}/g, 'minecraft-core')
              .replace(/\$\{launcher_version\}/g, '1.0.0');
            jvmArgs.push(processedArg);
          }
        }
      }
      
      // Build game arguments
      const gameArgs = [];
      
      // Process game arguments from profile
      if (launchJson.arguments?.game) {
        for (const arg of launchJson.arguments.game) {
          if (typeof arg === 'string') {
            let processedArg = arg
              .replace(/\$\{auth_playerName\}/g, this.authData.name)
              .replace(/\$\{auth_player_name\}/g, this.authData.name)
              .replace(/\$\{auth_uuid\}/g, this.authData.uuid)
              .replace(/\$\{auth_accessToken\}/g, this.authData.access_token)
              .replace(/\$\{auth_access_token\}/g, this.authData.access_token)
              .replace(/\$\{auth_userType\}/g, 'msa')
              .replace(/\$\{auth_user_type\}/g, 'msa')
              .replace(/\$\{version_name\}/g, launchVersion)
              .replace(/\$\{game_directory\}/g, clientPath)
              .replace(/\$\{assets_root\}/g, path.join(clientPath, 'assets'))
              .replace(/\$\{assets_index_name\}/g, launchJson.assetIndex?.id || minecraftVersion)
              .replace(/\$\{version_type\}/g, 'release');
              
            gameArgs.push(processedArg);
          }
        }
      }
      
      // Add server connection arguments if provided
      if (serverIp && serverPort) {
        gameArgs.push('--server', serverIp);
        gameArgs.push('--port', serverPort.toString());
      }
      
      // Final arguments - use javaw.exe on Windows to avoid console
      const javaCommand = process.platform === 'win32' ? 'javaw' : 'java';
      const allArgs = [
        ...jvmArgs,
        launchJson.mainClass || 'net.minecraft.client.main.Main',
        ...gameArgs
      ];
      
      
      // Launch Minecraft
      const child = spawn(javaCommand, allArgs, {
        cwd: clientPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });
      
      this.client = { child };
      
      // Handle process output
      child.stdout.on('data', (data) => {
        const output = data.toString();
        
        if (output.includes('Setting user:') || output.includes('Environment: authHost')) {
        }
        
        if (output.includes('[Render thread/INFO]: Created')) {
        }
      });
      
      child.stderr.on('data', (data) => {
        const output = data.toString();
        
        // The LogUtils error should be fixed now
        if (output.includes('java.lang.ClassNotFoundException: com.mojang.logging.LogUtils')) {
        }
      });
      
      child.on('close', () => {
        this.isLaunching = false;
        this.client = null;
        this.emit('minecraft-stopped');
      });
      
      child.on('error', () => {
        this.isLaunching = false;
        this.client = null;
        this.emit('minecraft-stopped');
      });
      
      // Wait to see if launch succeeds
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      if (child.killed || child.exitCode !== null) {
        throw new Error(`Minecraft failed to start. Exit code: ${child.exitCode}`);
      }
      
      
      return {
        success: true,
        message: `Minecraft ${launchVersion} launched successfully with XMCL`,
        pid: child.pid,
        version: launchVersion,
        vanillaVersion: minecraftVersion,
        needsFabric: needsFabric
      };
      
    } catch (error) {
      this.isLaunching = false;
      this.client = null;
      
      return {
        success: false,
        error: error.message,
        message: `Failed to launch Minecraft: ${error.message}`
      };
    }
  }

  // Stop Minecraft
  async stopMinecraft() {
    if (this.client?.child) {
      this.client.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.client?.child && !this.client.child.killed) {
          this.client.child.kill('SIGKILL');
        }
      }, 3000);
    }
    
    this.isLaunching = false;
    this.client = null;
    this.emit('minecraft-stopped');
    
    return { success: true, message: 'Minecraft stopped' };
  }

  // Get launcher status
  getStatus() {
    let isRunning = false;
    
    if (this.client?.child) {
      try {
        process.kill(this.client.child.pid, 0);
        isRunning = true;
      } catch (e) {
        this.client = null;
        isRunning = false;
      }
    }
    
    return {
      isAuthenticated: !!this.authData,
      isLaunching: this.isLaunching,
      isRunning: isRunning,
      username: this.authData?.name || null,
      clientPath: this.clientPath
    };
  }
}

module.exports = { ProperMinecraftLauncher }; 
