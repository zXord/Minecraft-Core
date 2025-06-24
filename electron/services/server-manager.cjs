// Server manager service
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const process = require('process');
const { safeSend } = require('../utils/safe-send.cjs');
const eventBus = require('../utils/event-bus.cjs');
const { resetCrashCount } = require('./auto-restart.cjs');
const { ServerJavaManager } = require('./server-java-manager.cjs');

// Initialize server Java manager (will be updated per server)
let serverJavaManager = new ServerJavaManager();

// Server process state
let serverProcess = null;
let serverStartMs = null;
let serverMaxRam = 4; // Default in GB
let playersInfo = { count: 0, names: [] };
let listInterval = null;

// Add a buffer to store the last log line
let lastLine = '';
let lastListCommandTime = 0;
const LIST_COMMAND_THROTTLE = 10000; // Only send list command every 10 seconds by default

// Add a variable to track if we need more frequent player list checks
let intensivePlayerCheckMode = false;
let intensiveCheckTimer = null;
let intensiveCheckTimeouts = [];
let lastMetricsUpdate = 0;
const METRICS_UPDATE_THROTTLE = 2000; // Minimum 2 seconds between updates

// Function to safely send metrics updates with throttling
function sendMetricsUpdate(metrics) {
  const now = Date.now();
  // Only send if it's been more than the throttle time since last update
  if (now - lastMetricsUpdate >= METRICS_UPDATE_THROTTLE) {
    safeSend('metrics-update', metrics);
    lastMetricsUpdate = now;
  }
}

// Function to send list command but suppress the output
function sendListCommand() {
  if (!serverProcess || serverProcess.killed) return;
  
  const now = Date.now();
  // Only send if enough time has passed since last command
  if (now - lastListCommandTime >= LIST_COMMAND_THROTTLE || intensivePlayerCheckMode) {
    // Set a flag to indicate we're expecting a list response
    sendListCommand.expectingResponse = true;
    serverProcess.stdin.write('list\n');
    lastListCommandTime = now;
    
    // After a timeout, assume we're no longer expecting a response
    clearTimeout(sendListCommand.responseTimeout);
    sendListCommand.responseTimeout = setTimeout(() => {
      sendListCommand.expectingResponse = false;
    }, 2000); // Wait 2 seconds for response
  }
}

// Initialize the static properties
sendListCommand.expectingResponse = false;
sendListCommand.responseTimeout = null;

// Function to parse player list from server response
function parsePlayerList(text) {
  // If this is a list response, make sure we mark it as handled
  const isListResponse = /There are \d+ of a max of \d+ players online/.test(text);
  if (isListResponse) {
    sendListCommand.expectingResponse = false;
  }

  // Look for patterns like "There are X of a max of Y players online: player1, player2"
  // First pattern with player names
  const fullPattern = /There are (\d+) of a max of \d+ players online: (.+)/;
  const match = text.match(fullPattern);
  
  if (match) {
    const count = parseInt(match[1]);
    const names = match[2].split(', ').filter(name => name.trim());
    playersInfo = { count, names };
    return true;
  }
  
  // Second pattern without player names (just count)
  const countPattern = /There are (\d+) of a max of \d+ players online/;
  const countMatch = text.match(countPattern);
  
  if (countMatch) {
    const count = parseInt(countMatch[1]);
    // Keep existing player names if count matches
    if (count === playersInfo.names.length) {
      playersInfo = { count, names: playersInfo.names };
    } else {
      // Reset names if count doesn't match
      playersInfo = { count, names: [] };
    }
    return true;
  }
  
  // Also look for player join/leave messages
  const joinPattern = /(\w+) joined the game/;
  const joinMatch = text.match(joinPattern);
  
  if (joinMatch) {
    const playerName = joinMatch[1];
    if (!playersInfo.names.includes(playerName)) {
      // Add player to the list immediately for responsive UI
      playersInfo.names.push(playerName);
      playersInfo.count = playersInfo.names.length;
      
      // Update UI with the new player
      sendMetricsUpdate({
        cpuPct: 0.1,
        memUsedMB: 1,
        systemTotalRamMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
        maxRamMB: serverMaxRam * 1024,
        uptime: '0h 0m 0s',
        players: playersInfo.count,
        names: playersInfo.names
      });
      
      // Send list command to get fresh player list
      if (serverProcess && !serverProcess.killed && !intensivePlayerCheckMode) {
        sendListCommand();
      }
      return true;
    }
  }
  
  const leavePattern = /(\w+) left the game/;
  const leaveMatch = text.match(leavePattern);
  
  if (leaveMatch) {
    const playerName = leaveMatch[1];
    
    // Remove player from the list immediately
    playersInfo.names = playersInfo.names.filter(name => name !== playerName);
    playersInfo.count = playersInfo.names.length;
    
    // Update UI immediately showing player has left
    sendMetricsUpdate({
      cpuPct: 0.1,
      memUsedMB: 1,
      systemTotalRamMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
      maxRamMB: serverMaxRam * 1024,
      uptime: '0h 0m 0s',
      players: playersInfo.count,
      names: playersInfo.names
    });
    
    // Start moderate intensive checking if not already in that mode
    if (!intensivePlayerCheckMode) {
      enableIntensiveChecking();
    }
    
    return true;
  }
  
  return false;
}

// Helper function to enable intensive checking with cleanup
function enableIntensiveChecking() {
  // Clean up any existing intensive checking
  if (intensiveCheckTimer) {
    clearTimeout(intensiveCheckTimer);
    intensiveCheckTimer = null;
  }
  
  if (intensiveCheckTimeouts.length) {
    intensiveCheckTimeouts.forEach(clearTimeout);
    intensiveCheckTimeouts = [];
  }
  
  // Enable intensive player list checking for a short period
  intensivePlayerCheckMode = true;
  
  // Send just one list command immediately
  if (serverProcess && !serverProcess.killed) {
    sendListCommand();
  }
  
  // Set up just a few quick follow-up checks after a player event
  const checkTimes = [2000, 5000]; // Check after 2s and 5s

  checkTimes.forEach(delay => {
    const timeout = setTimeout(() => {
      if (serverProcess && !serverProcess.killed) {
        sendListCommand();
      }
    }, delay);
    intensiveCheckTimeouts.push(timeout);
  });
  
  // Stop intensive checking after 6 seconds total
  intensiveCheckTimer = setTimeout(() => {
    if (intensiveCheckTimeouts.length) {
      intensiveCheckTimeouts.forEach(clearTimeout);
      intensiveCheckTimeouts = [];
    }
    intensivePlayerCheckMode = false;
  }, 6000);
}

/**
 * Detect Minecraft version from server directory
 * @param {string} serverPath - Path to the server directory
 * @returns {Promise<string>} - Minecraft version or 'unknown'
 */
async function detectMinecraftVersion(serverPath) {
  try {
    // First priority: check .minecraft-core.json config file
    const minecraftCoreConfigPath = path.join(serverPath, '.minecraft-core.json');
    if (fs.existsSync(minecraftCoreConfigPath)) {
      const coreConfig = JSON.parse(fs.readFileSync(minecraftCoreConfigPath, 'utf8'));
      if (coreConfig.version) {
        return coreConfig.version;
      }
    }
    
    // Second priority: try to find version from server jar files
    const files = fs.readdirSync(serverPath);
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
      // Extract version from jar name (e.g., "minecraft_server.1.20.1.jar" or "paper-1.20.1-196.jar")
      const versionMatch = jarName.match(/(\d+\.\d+(?:\.\d+)?)/);
      if (versionMatch) {
        return versionMatch[1];
      }
    }
    
    // Third priority: check version.json if it exists
    const versionPath = path.join(serverPath, 'version.json');
    if (fs.existsSync(versionPath)) {
      const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
      if (versionData.name || versionData.id) {
        return versionData.name || versionData.id;
      }
    }
    
    // Fourth priority: check Fabric loader version info
    const fabricLoaderPath = path.join(serverPath, '.fabric', 'remappedJars');
    if (fs.existsSync(fabricLoaderPath)) {
      const fabricFiles = fs.readdirSync(fabricLoaderPath);
      for (const file of fabricFiles) {
        const match = file.match(/minecraft-(\d+\.\d+(?:\.\d+)?)/);
        if (match) {
          return match[1];
        }
      }
    }
    
    // Fifth priority: check logs directory
    const logsPath = path.join(serverPath, 'logs');
    if (fs.existsSync(logsPath)) {
      const latestLog = path.join(logsPath, 'latest.log');
      if (fs.existsSync(latestLog)) {
        const logContent = fs.readFileSync(latestLog, 'utf8');
        const versionMatch = logContent.match(/Starting minecraft server version (\d+\.\d+(?:\.\d+)?)|Minecraft (\d+\.\d+(?:\.\d+)?)|version (\d+\.\d+(?:\.\d+)?)/i);
        if (versionMatch) {
          return versionMatch[1] || versionMatch[2] || versionMatch[3];
        }
      }
    }
    
    return 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

// Set up event listeners
eventBus.on('request-server-start', async ({ targetPath, port, maxRam }) => {
  const result = await startMinecraftServer(targetPath, port, maxRam);
  if (result) {
    safeSend('server-log', `[INFO] Server start successful via event`);
  } else {
    safeSend('server-log', `[ERROR] Server start failed via event`);
  }
});

/**
 * Start the Minecraft server
 * 
 * @param {string} targetPath - Path to the server directory
 * @param {number} port - The port number to run the server on
 * @param {number} maxRam - Maximum RAM allocation in GB
 * @returns {Promise<boolean>} Success status
 */
async function startMinecraftServer(targetPath, port, maxRam) {
  if (serverProcess) return false;
  
  serverStartMs = Date.now();
  serverMaxRam = maxRam;

  // First, detect the Minecraft version and ensure correct Java is available
  const minecraftVersion = await detectMinecraftVersion(targetPath);
  if (!minecraftVersion || minecraftVersion === 'unknown') {
    safeSend('server-log', '[ERROR] Could not determine Minecraft version. Cannot ensure correct Java version.');
    return false;
  }

  safeSend('server-log', `[INFO] Detected Minecraft version: ${minecraftVersion}`);

  // Set server path for Java manager and check if correct Java is available
  serverJavaManager.setServerPath(targetPath);
  const javaRequirements = serverJavaManager.getJavaRequirementsForMinecraft(minecraftVersion);
  safeSend('server-log', `[INFO] Required Java version: ${javaRequirements.requiredJavaVersion}`);

  let javaPath = javaRequirements.javaPath;

  if (!javaRequirements.isAvailable) {
    safeSend('server-log', `[INFO] Java ${javaRequirements.requiredJavaVersion} not found. Downloading...`);
    
    try {
      const javaResult = await serverJavaManager.ensureJavaForMinecraft(
        minecraftVersion,
        (progress) => {
          // Send progress updates
          safeSend('server-log', `[JAVA] ${progress.task}`);
          if (progress.progress) {
            const progressMsg = progress.downloadedMB && progress.totalMB 
              ? `${progress.progress}% (${progress.downloadedMB}/${progress.totalMB} MB)`
              : `${progress.progress}%`;
            safeSend('server-log', `[JAVA] Progress: ${progressMsg}`);
          }
        }
      );

      if (!javaResult.success) {
        safeSend('server-log', `[ERROR] Failed to download Java ${javaRequirements.requiredJavaVersion}: ${javaResult.error}`);
        return false;
      }

      javaPath = javaResult.javaPath;
      safeSend('server-log', `[INFO] Java ${javaRequirements.requiredJavaVersion} downloaded successfully`);
    } catch (error) {
      safeSend('server-log', `[ERROR] Java download failed: ${error.message}`);
      return false;
    }
  } else {
    safeSend('server-log', `[INFO] Using Java at: ${javaPath}`);
  }

  // Determine the correct server JAR to use based on configuration
  let launchJar = null;
  
  // First, try to read configuration to determine server type
  const configPath = path.join(targetPath, '.minecraft-core.json');
  let useFabric = false;
  
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      useFabric = !!config.fabric; // Use Fabric if Fabric version is specified
    }
  } catch {
    // If config can't be read, fall back to detecting JAR files
  }
  
  if (useFabric) {
    // Try to use Fabric launcher
    const fabricJar = path.join(targetPath, 'fabric-server-launch.jar');
    if (fs.existsSync(fabricJar)) {
      launchJar = fabricJar;
    }
  }
  
  // Fall back to vanilla server.jar if Fabric not available or not configured
  if (!launchJar) {
    const vanillaJar = path.join(targetPath, 'server.jar');
    if (fs.existsSync(vanillaJar)) {
      launchJar = vanillaJar;
    }
  }
  
  // Final fallback: look for any server JAR files
  if (!launchJar) {
    try {
      const files = fs.readdirSync(targetPath);
      const serverJars = files.filter(f => 
        f.endsWith('.jar') && 
        (f.includes('server') || f.includes('fabric-server-launch'))
      );
      
      if (serverJars.length > 0) {
        // Prefer fabric-server-launch.jar, then server.jar, then any server JAR
        const fabricLaunch = serverJars.find(f => f === 'fabric-server-launch.jar');
        const serverJar = serverJars.find(f => f === 'server.jar');
        
        if (fabricLaunch) {
          launchJar = path.join(targetPath, fabricLaunch);
        } else if (serverJar) {
          launchJar = path.join(targetPath, serverJar);
        } else {
          launchJar = path.join(targetPath, serverJars[0]);
        }
      }
    } catch {
      // Could not read directory
    }
  }
  
  if (!launchJar || !fs.existsSync(launchJar)) {
    return false;
  }

  try {
    const serverIdentifier = `minecraft-core-server-${Date.now()}`;
    
    safeSend('server-log', `[INFO] Starting server with Java: ${javaPath}`);
    
    serverProcess = spawn(javaPath, [
      `-Xmx${maxRam}G`,
      `-Dminecraft.core.server.id=${serverIdentifier}`,
      '-jar', launchJar,
      'nogui',
      '--port', `${port}`
    ], {
      cwd: targetPath,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    serverProcess['serverInfo'] = {
      id: serverIdentifier,
      jar: launchJar,
      port: port,
      maxRam: maxRam,
      startTime: serverStartMs,
      commandLineIdentifier: `${path.basename(launchJar)} nogui --port ${port}`,
      targetPath: targetPath
    };

    serverProcess.stdout.on('data', chunk => {
      const text = chunk.toString();
      
      // Check if this is a response to a list command
      const isListResponse = /There are \d+ of a max of \d+ players online/.test(text);
      
      if (text !== lastLine) {
        lastLine = text;
        
        // Only send to log if it's not a list response or we're not expecting one
        if (!isListResponse || !sendListCommand.expectingResponse) {
          safeSend('server-log', text);
        }
        
        // If this is a list response, mark that we've received it
        if (isListResponse) {
          sendListCommand.expectingResponse = false;
        }
        
        // Check specifically for player leave messages
        const leaveMatch = text.match(/(\w+) left the game/);
        if (leaveMatch) {
          const playerName = leaveMatch[1];
          
          // Immediately remove the player from our tracking
          if (playersInfo.names.includes(playerName)) {
            playersInfo.names = playersInfo.names.filter(name => name !== playerName);
            playersInfo.count = playersInfo.names.length;
            
            // Send metrics update immediately
            sendMetricsUpdate({
              cpuPct: 0.1,
              memUsedMB: 1,
              systemTotalRamMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
              maxRamMB: serverMaxRam * 1024,
              uptime: '0h 0m 0s',
              players: playersInfo.count,
              names: playersInfo.names
            });
            
            // Enable moderate intensive checking if not already in that mode
            if (!intensivePlayerCheckMode) {
              enableIntensiveChecking();
            }
          }
        }
        // Also specifically check for player join events for special handling
        else if (text.match(/(\w+) joined the game/)) {
          // We'll let the parsePlayerList function handle this to avoid duplication
        }
        
        // Continue with normal list parsing
        if (parsePlayerList(text)) {
          sendMetricsUpdate({
            cpuPct: 0.1,
            memUsedMB: 1,
            systemTotalRamMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
            maxRamMB: serverMaxRam * 1024,
            uptime: '0h 0m 0s',
            players: playersInfo.count,
            names: playersInfo.names
          });
        }
      }
    });

    serverProcess.stderr.on('data', chunk => {
      const text = chunk.toString();
      safeSend('server-log', `[STDERR] ${text}`);
    });

    serverProcess.on('error', (err) => {
      safeSend('server-log', `Server process error: ${err.message}`);
    });
    
    eventBus.emit('server-started');
    safeSend('server-status', 'running');
    
    // Start metrics reporting when server starts
    const { startMetricsReporting } = require('./system-metrics.cjs');
    startMetricsReporting();
    
    serverProcess.on('exit', (code, signal) => {
      
      const isNormalExit = code === 0 || signal === 'SIGTERM' || signal === 'SIGINT';
      
      const serverInfo = serverProcess ? { ...serverProcess['serverInfo'] } : null;
      
      
      if (!isNormalExit) {
        const restartInfo = {
          serverInfo: {
            targetPath: serverProcess && serverProcess['serverInfo'] ? serverProcess['serverInfo'].targetPath : null,
            port: serverProcess && serverProcess['serverInfo'] ? serverProcess['serverInfo'].port : 25565,
            maxRam: serverProcess && serverProcess['serverInfo'] ? serverProcess['serverInfo'].maxRam : 4,
            jar: serverProcess && serverProcess['serverInfo'] ? serverProcess['serverInfo'].jar : null,
            ...serverInfo
          },
          pid: serverProcess ? serverProcess.pid : null,
          exitCode: code,
          signal: signal
        };
        
        
        eventBus.emit('server-crashed', restartInfo);
      } else {
        eventBus.emit('server-normal-exit');
      }
      
      if (listInterval) {
        clearInterval(listInterval);
        listInterval = null;
      }
      // Reset serverProcess after exit to allow auto-restart
      serverProcess = null;
    });

    if (listInterval) clearInterval(listInterval);
    // Use the player joining/leaving events as primary detection method
    // Only check occasionally for sync purposes
    listInterval = setInterval(() => {
      if (serverProcess && !serverProcess.killed && !intensivePlayerCheckMode) {
        // Only send list commands occasionally to reduce log spam
        sendListCommand();
      }
    }, 30000); // Check only every 30 seconds by default

    safeSend('server-status', 'running');
    
    sendMetricsUpdate({
      cpuPct: 0.1,
      memUsedMB: 1,
      systemTotalRamMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
      maxRamMB: maxRam * 1024,
      uptime: '0h 0m 0s',
      players: 0,
      names: []
    });
    
    setTimeout(() => {
      if (serverProcess) {
        safeSend('server-status', 'running');
      }
    }, 300);
    
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/**
 * Stop the Minecraft server gracefully
 * 
 * @returns {boolean} Success status
 */
function stopMinecraftServer() {
  if (!serverProcess) return false;
  
  serverProcess.stdin.write('stop\n');

  if (listInterval) clearInterval(listInterval);
  
  // Reset all server state immediately
  serverProcess = null;
  serverStartMs = null;
  playersInfo = { count: 0, names: [] };
  
  // Emit normal exit event
  eventBus.emit('server-normal-exit');
  // Notify renderer with zeroed metrics
  safeSend('server-status', 'stopped');
  
  // Send zeroed metrics immediately
  sendMetricsUpdate({
    cpuPct: 0,
    memUsedMB: 0,
    maxRamMB: serverMaxRam * 1024,
    uptime: '0h 0m 0s',
    players: 0,
    names: []
  });
  
  // Send a second status update after a small delay to ensure the UI updates
  setTimeout(() => {
    safeSend('server-status', 'stopped');
  }, 300);
  
  return true;
}

/**
 * Force kill the Minecraft server process
 * 
 * @returns {boolean} Success status
 */
function killMinecraftServer() {
  if (!serverProcess) return false;
  const pid = serverProcess.pid;
  

  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', pid.toString(), '/F', '/T']);
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { process.kill(pid, 'SIGKILL'); }
  }

  // Clean up interval
  if (listInterval) {
    clearInterval(listInterval);
    listInterval = null;
  }
  
  // Clear server state
  serverProcess = null;
  serverStartMs = null;
  playersInfo = { count: 0, names: [] };
  
  // Emit normal exit event
  eventBus.emit('server-normal-exit');
  
  // Reset crash counter on manual kill
  if (typeof resetCrashCount === 'function') {
    resetCrashCount();
  }
  
  // Notify renderer of stopped status and send zeroed metrics
  safeSend('server-status', 'stopped');
  sendMetricsUpdate({
    cpuPct: 0,
    memUsedMB: 0,
    maxRamMB: serverMaxRam * 1024,
    uptime: '0h 0m 0s',
    players: 0,
    names: []
  });
  
  // Send a second status update after a small delay to ensure the UI updates
  setTimeout(() => {
    safeSend('server-status', 'stopped');
  }, 300);
  
  return true;
}

/**
 * Send a command to the server
 * 
 * @param {string} command - The command to send
 * @returns {boolean} Success status
 */
function sendServerCommand(command) {
  if (!serverProcess) return false;
  serverProcess.stdin.write(`${command}\n`);
  safeSend('command-response', command);
  return true;
}

/**
 * Get current server process info
 * 
 * @returns {object} Server state information
 */
function getServerState() {
  return {
    isRunning: !!serverProcess,
    serverProcess: serverProcess,
    serverStartMs: serverStartMs,
    serverMaxRam: serverMaxRam,
    playersInfo: playersInfo
  };
}

/**
 * Get the server process object
 * 
 * @returns {object|null} The server process object or null
 */
function getServerProcess() {
  return serverProcess;
}

/**
 * Clear all intervals
 */
function clearIntervals() {
  if (listInterval) {
    clearInterval(listInterval);
    listInterval = null;
  }
}

module.exports = {
  startMinecraftServer,
  stopMinecraftServer,
  killMinecraftServer,
  sendServerCommand,
  getServerState,
  getServerProcess,
  clearIntervals,
  sendMetricsUpdate
};
