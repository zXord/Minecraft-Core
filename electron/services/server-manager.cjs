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
const { getLoggerHandlers } = require('../ipc/logger-handlers.cjs');
const instanceContext = require('../utils/instance-context.cjs');

// Initialize logger
const logger = getLoggerHandlers();

// Initialize server Java manager (will be updated per server)
let serverJavaManager = new ServerJavaManager();

// Server process state
let serverProcess = null;
let serverStartMs = null;
let serverMaxRam = 4; // Default in GB
let playersInfo = { count: 0, names: [] };
let listInterval = null;

// Performance tracking
let performanceMetrics = {
  serverStarts: 0,
  serverStops: 0,
  serverKills: 0,
  commandsSent: 0,
  playerEvents: 0,
  metricsUpdates: 0
};

// Log service initialization
logger.info('Server manager service initialized', {
  category: 'server',
  data: {
    service: 'ServerManager',
    defaultMaxRam: serverMaxRam,
    platform: process.platform,
    nodeVersion: process.version
  }
});

// Track last log line and buffer partial stdout chunks
let lastLine = '';
let stdoutBuffer = '';
let lastListCommandTime = 0;
const LIST_COMMAND_THROTTLE = 30000; // Only send list command every 30 seconds by default

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
    performanceMetrics.metricsUpdates++;
    
    logger.debug('Server metrics updated', {
      category: 'performance',
      data: {
        service: 'ServerManager',
        operation: 'sendMetricsUpdate',
        metrics: {
          players: metrics.players,
          uptime: metrics.uptime,
          memUsedMB: metrics.memUsedMB,
          cpuPct: metrics.cpuPct
        },
        totalUpdates: performanceMetrics.metricsUpdates,
        throttleMs: METRICS_UPDATE_THROTTLE
      }
    });
  }
}

// Function to send list command but suppress the output
function sendListCommand() {
  if (!serverProcess || serverProcess.killed) {
    logger.debug('Cannot send list command - server not running', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'sendListCommand',
        serverRunning: !!serverProcess,
        serverKilled: serverProcess?.killed
      }
    });
    return;
  }
  
  const now = Date.now();
  // Only send if enough time has passed since last command
  if (now - lastListCommandTime >= LIST_COMMAND_THROTTLE || intensivePlayerCheckMode) {
    // Set a flag to indicate we're expecting a list response
    sendListCommand.expectingResponse = true;
    serverProcess.stdin.write('list\n');
    lastListCommandTime = now;
    
    logger.debug('List command sent to server', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'sendListCommand',
        intensiveMode: intensivePlayerCheckMode,
        timeSinceLastCommand: now - (lastListCommandTime - LIST_COMMAND_THROTTLE),
        throttleMs: LIST_COMMAND_THROTTLE
      }
    });
    
    // After a timeout, assume we're no longer expecting a response
    clearTimeout(sendListCommand.responseTimeout);
    sendListCommand.responseTimeout = setTimeout(() => {
      sendListCommand.expectingResponse = false;
      logger.debug('List command response timeout', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'sendListCommand',
          timeoutMs: 2000
        }
      });
    }, 2000); // Wait 2 seconds for response
  }
}

// Initialize the static properties
sendListCommand.expectingResponse = false;
sendListCommand.responseTimeout = null;

// Function to parse player list from server response
function parsePlayerList(text) {
  const parseStartTime = Date.now();
  
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
    const oldCount = playersInfo.count;
    playersInfo = { count, names };
    
    const parseDuration = Date.now() - parseStartTime;
    logger.debug('Player list parsed with names', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'parsePlayerList',
        duration: parseDuration,
        playerCount: count,
        playerNames: names,
        countChanged: count !== oldCount,
        listType: 'full'
      }
    });
    
    return true;
  }
  
  // Second pattern without player names (just count)
  const countPattern = /There are (\d+) of a max of \d+ players online/;
  const countMatch = text.match(countPattern);
  
  if (countMatch) {
    const count = parseInt(countMatch[1]);
    const oldCount = playersInfo.count;
    
    // Keep existing player names if count matches
    if (count === playersInfo.names.length) {
      playersInfo = { count, names: playersInfo.names };
    } else {
      // Reset names if count doesn't match
      playersInfo = { count, names: [] };
    }
    
    const parseDuration = Date.now() - parseStartTime;
    logger.debug('Player list parsed count only', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'parsePlayerList',
        duration: parseDuration,
        playerCount: count,
        countChanged: count !== oldCount,
        namesReset: count !== playersInfo.names.length,
        listType: 'count_only'
      }
    });
    
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
      performanceMetrics.playerEvents++;
      
      const parseDuration = Date.now() - parseStartTime;
      logger.info('Player joined server', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'parsePlayerList',
          duration: parseDuration,
          playerName,
          totalPlayers: playersInfo.count,
          eventType: 'join',
          totalPlayerEvents: performanceMetrics.playerEvents
        }
      });
      
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
    performanceMetrics.playerEvents++;
    
    const parseDuration = Date.now() - parseStartTime;
    logger.info('Player left server', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'parsePlayerList',
        duration: parseDuration,
        playerName,
        totalPlayers: playersInfo.count,
        eventType: 'leave',
        totalPlayerEvents: performanceMetrics.playerEvents
      }
    });
    
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
  // Always clear any existing intensive checking first to prevent accumulation
  clearIntensiveChecking();
  
  // Enable intensive player list checking for a short period
  intensivePlayerCheckMode = true;
  
  logger.debug('Intensive player checking enabled', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'enableIntensiveChecking',
      duration: 6000,
      checkIntervals: [2000, 5000]
    }
  });
  
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
    logger.debug('Intensive player checking disabled', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'enableIntensiveChecking',
        timeoutReached: true
      }
    });
    clearIntensiveChecking();
  }, 6000);
}

// Helper function to clear all intensive checking timers
function clearIntensiveChecking() {
  const wasIntensive = intensivePlayerCheckMode;
  const timeoutsCleared = intensiveCheckTimeouts.length;
  
  // Clear the main intensive check timer
  if (intensiveCheckTimer) {
    clearTimeout(intensiveCheckTimer);
    intensiveCheckTimer = null;
  }
  
  // Clear all pending check timeouts
  if (intensiveCheckTimeouts.length) {
    intensiveCheckTimeouts.forEach(clearTimeout);
    intensiveCheckTimeouts = [];
  }
  
  // Disable intensive mode
  intensivePlayerCheckMode = false;
  
  if (wasIntensive) {
    logger.debug('Intensive player checking cleared', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'clearIntensiveChecking',
        timeoutsCleared,
        wasIntensive
      }
    });
  }
}

/**
 * Detect Minecraft version from server directory
 * @param {string} serverPath - Path to the server directory
 * @returns {Promise<string>} - Minecraft version or 'unknown'
 */
async function detectMinecraftVersion(serverPath) {
  const detectionStartTime = Date.now();
  
  try {
    logger.debug('Starting Minecraft version detection', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'detectMinecraftVersion',
        serverPath
      }
    });
    
    // First priority: check .minecraft-core.json config file
    const minecraftCoreConfigPath = path.join(serverPath, '.minecraft-core.json');
    if (fs.existsSync(minecraftCoreConfigPath)) {
      const coreConfig = JSON.parse(fs.readFileSync(minecraftCoreConfigPath, 'utf8'));
      if (coreConfig.version) {
        const detectionDuration = Date.now() - detectionStartTime;
        logger.info('Minecraft version detected from core config', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'detectMinecraftVersion',
            duration: detectionDuration,
            version: coreConfig.version,
            source: 'minecraft-core.json',
            serverPath
          }
        });
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
        const detectionDuration = Date.now() - detectionStartTime;
        logger.info('Minecraft version detected from jar file', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'detectMinecraftVersion',
            duration: detectionDuration,
            version: versionMatch[1],
            source: 'jar_filename',
            jarName,
            serverJarsFound: serverJars.length,
            serverPath
          }
        });
        return versionMatch[1];
      }
    }
    
    // Third priority: check version.json if it exists
    const versionPath = path.join(serverPath, 'version.json');
    if (fs.existsSync(versionPath)) {
      const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
      if (versionData.name || versionData.id) {
        const version = versionData.name || versionData.id;
        const detectionDuration = Date.now() - detectionStartTime;
        logger.info('Minecraft version detected from version.json', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'detectMinecraftVersion',
            duration: detectionDuration,
            version,
            source: 'version.json',
            serverPath
          }
        });
        return version;
      }
    }
    
    // Fourth priority: check Fabric loader version info
    const fabricLoaderPath = path.join(serverPath, '.fabric', 'remappedJars');
    if (fs.existsSync(fabricLoaderPath)) {
      const fabricFiles = fs.readdirSync(fabricLoaderPath);
      for (const file of fabricFiles) {
        const match = file.match(/minecraft-(\d+\.\d+(?:\.\d+)?)/);
        if (match) {
          const detectionDuration = Date.now() - detectionStartTime;
          logger.info('Minecraft version detected from Fabric files', {
            category: 'server',
            data: {
              service: 'ServerManager',
              operation: 'detectMinecraftVersion',
              duration: detectionDuration,
              version: match[1],
              source: 'fabric_remapped',
              fabricFile: file,
              serverPath
            }
          });
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
          const version = versionMatch[1] || versionMatch[2] || versionMatch[3];
          const detectionDuration = Date.now() - detectionStartTime;
          logger.info('Minecraft version detected from server logs', {
            category: 'server',
            data: {
              service: 'ServerManager',
              operation: 'detectMinecraftVersion',
              duration: detectionDuration,
              version,
              source: 'server_logs',
              serverPath
            }
          });
          return version;
        }
      }
    }
    
    const detectionDuration = Date.now() - detectionStartTime;
    logger.warn('Could not detect Minecraft version', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'detectMinecraftVersion',
        duration: detectionDuration,
        version: 'unknown',
        serverPath,
        checkedSources: ['minecraft-core.json', 'jar_files', 'version.json', 'fabric_files', 'server_logs']
      }
    });
    
    return 'unknown';
  } catch (error) {
    const detectionDuration = Date.now() - detectionStartTime;
    logger.error(`Minecraft version detection failed: ${error.message}`, {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'detectMinecraftVersion',
        duration: detectionDuration,
        errorType: error.constructor.name,
        serverPath,
        stack: error.stack
      }
    });
    return 'unknown';
  }
}

// Set up event listeners
eventBus.on('request-server-start', async ({ targetPath, port, maxRam }) => {
  logger.info('Server start requested via event', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'request-server-start',
      targetPath,
      port,
      maxRam
    }
  });
  
  const result = await startMinecraftServer(targetPath, port, maxRam);
  
  if (result) {
    logger.info('Server start successful via event', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'request-server-start',
        success: true,
        targetPath,
        port,
        maxRam
      }
    });
    safeSend('server-log', `[INFO] Server start successful via event`);
  } else {
    logger.error('Server start failed via event', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'request-server-start',
        success: false,
        targetPath,
        port,
        maxRam
      }
    });
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
  const startOperationTime = Date.now();
  
  if (serverProcess) {
    logger.warn('Server start attempted while server already running', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        serverAlreadyRunning: true,
        existingPid: serverProcess.pid,
        targetPath,
        port,
        maxRam
      }
    });
    return false;
  }
  
  // Set instance context based on server path
  const instanceName = instanceContext.getInstanceNameByPath(targetPath);
  
  logger.info('Starting Minecraft server', {
    instanceId: instanceName,
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'startMinecraftServer',
      targetPath,
      port,
      maxRam,
      platform: process.platform,
      instanceName
    }
  });
  
  serverStartMs = Date.now();
  serverMaxRam = maxRam;
  performanceMetrics.serverStarts++;

  // First, detect the Minecraft version and ensure correct Java is available
  const minecraftVersion = await detectMinecraftVersion(targetPath);
  if (!minecraftVersion || minecraftVersion === 'unknown') {
    const operationDuration = Date.now() - startOperationTime;
    logger.error('Could not determine Minecraft version', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        duration: operationDuration,
        targetPath,
        minecraftVersion,
        stage: 'version_detection'
      }
    });
    safeSend('server-log', '[ERROR] Could not determine Minecraft version. Cannot ensure correct Java version.');
    return false;
  }

  logger.info('Minecraft version detected for server start', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'startMinecraftServer',
      minecraftVersion,
      targetPath,
      stage: 'version_detection'
    }
  });
  safeSend('server-log', `[INFO] Detected Minecraft version: ${minecraftVersion}`);

  // Set server path for Java manager and check if correct Java is available
  serverJavaManager.setServerPath(targetPath);
  const javaRequirements = serverJavaManager.getJavaRequirementsForMinecraft(minecraftVersion);
  
  logger.info('Java requirements determined', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'startMinecraftServer',
      minecraftVersion,
      requiredJavaVersion: javaRequirements.requiredJavaVersion,
      javaAvailable: javaRequirements.isAvailable,
      javaPath: javaRequirements.javaPath,
      stage: 'java_requirements'
    }
  });
  safeSend('server-log', `[INFO] Required Java version: ${javaRequirements.requiredJavaVersion}`);

  let javaPath = javaRequirements.javaPath;

  if (!javaRequirements.isAvailable) {
    logger.info('Java not available, starting download', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        requiredJavaVersion: javaRequirements.requiredJavaVersion,
        stage: 'java_download'
      }
    });
    safeSend('server-log', `[INFO] Java ${javaRequirements.requiredJavaVersion} not found. Downloading...`);
    
    try {
      const javaDownloadStart = Date.now();
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

      const javaDownloadDuration = Date.now() - javaDownloadStart;

      if (!javaResult.success) {
        logger.error('Java download failed', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'startMinecraftServer',
            duration: javaDownloadDuration,
            requiredJavaVersion: javaRequirements.requiredJavaVersion,
            error: javaResult.error,
            stage: 'java_download'
          }
        });
        safeSend('server-log', `[ERROR] Failed to download Java ${javaRequirements.requiredJavaVersion}: ${javaResult.error}`);
        return false;
      }

      javaPath = javaResult.javaPath;
      logger.info('Java download completed successfully', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'startMinecraftServer',
          duration: javaDownloadDuration,
          requiredJavaVersion: javaRequirements.requiredJavaVersion,
          javaPath,
          stage: 'java_download'
        }
      });
      safeSend('server-log', `[INFO] Java ${javaRequirements.requiredJavaVersion} downloaded successfully`);
    } catch (error) {
      const operationDuration = Date.now() - startOperationTime;
      logger.error(`Java download failed: ${error.message}`, {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'startMinecraftServer',
          duration: operationDuration,
          errorType: error.constructor.name,
          requiredJavaVersion: javaRequirements.requiredJavaVersion,
          stage: 'java_download',
          stack: error.stack
        }
      });
      safeSend('server-log', `[ERROR] Java download failed: ${error.message}`);
      return false;
    }
  } else {
    logger.info('Using existing Java installation', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        javaPath,
        requiredJavaVersion: javaRequirements.requiredJavaVersion,
        stage: 'java_requirements'
      }
    });
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
      
      logger.debug('Server configuration loaded', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'startMinecraftServer',
          configPath,
          useFabric,
          fabricVersion: config.fabric,
          stage: 'jar_detection'
        }
      });
    }
  } catch (error) {
    logger.debug('Could not read server configuration, using fallback detection', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        configPath,
        errorType: error.constructor.name,
        stage: 'jar_detection'
      }
    });
  }
  
  if (useFabric) {
    // Try to use Fabric launcher
    const fabricJar = path.join(targetPath, 'fabric-server-launch.jar');
    if (fs.existsSync(fabricJar)) {
      launchJar = fabricJar;
      logger.info('Using Fabric server launcher', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'startMinecraftServer',
          launchJar,
          serverType: 'fabric',
          stage: 'jar_detection'
        }
      });
    }
  }
  
  // Fall back to vanilla server.jar if Fabric not available or not configured
  if (!launchJar) {
    const vanillaJar = path.join(targetPath, 'server.jar');
    if (fs.existsSync(vanillaJar)) {
      launchJar = vanillaJar;
      logger.info('Using vanilla server jar', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'startMinecraftServer',
          launchJar,
          serverType: 'vanilla',
          stage: 'jar_detection'
        }
      });
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
        
        logger.info('Server jar found via fallback detection', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'startMinecraftServer',
            launchJar,
            serverJarsFound: serverJars,
            selectedJar: path.basename(launchJar),
            serverType: 'detected',
            stage: 'jar_detection'
          }
        });
      }
    } catch (error) {
      logger.error('Could not read server directory for jar detection', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'startMinecraftServer',
          targetPath,
          errorType: error.constructor.name,
          stage: 'jar_detection'
        }
      });
    }
  }
  
  if (!launchJar || !fs.existsSync(launchJar)) {
    const operationDuration = Date.now() - startOperationTime;
    logger.error('No valid server jar found', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        duration: operationDuration,
        targetPath,
        launchJar,
        jarExists: launchJar ? fs.existsSync(launchJar) : false,
        stage: 'jar_detection'
      }
    });
    return false;
  }

  try {
    const serverIdentifier = `minecraft-core-server-${Date.now()}`;
    const spawnArgs = [
      `-Xmx${maxRam}G`,
      `-Dminecraft.core.server.id=${serverIdentifier}`,
      '-jar', launchJar,
      'nogui',
      '--port', `${port}`
    ];
    
    logger.info('Spawning server process', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        javaPath,
        spawnArgs,
        serverIdentifier,
        cwd: targetPath,
        stage: 'process_spawn'
      }
    });
    safeSend('server-log', `[INFO] Starting server with Java: ${javaPath}`);
    
    serverProcess = spawn(javaPath, spawnArgs, {
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
    const serverInfoSnapshot = { ...serverProcess['serverInfo'] };
    const serverPid = serverProcess.pid;
    
    logger.info('Server process spawned successfully', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        pid: serverProcess.pid,
        serverInfo: serverProcess['serverInfo'],
        stage: 'process_spawn'
      }
    });

    // Reset log tracking for a fresh server session
    lastLine = '';
    stdoutBuffer = '';

    const handleServerLogLine = (text) => {
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
    };

    serverProcess.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      
      lines
        .map(line => line.trimEnd())
        .filter(line => line.length > 0)
        .forEach(handleServerLogLine);
    });

    serverProcess.stdout.on('end', () => {
      const remaining = stdoutBuffer.trim();
      if (remaining) {
        handleServerLogLine(remaining);
      }
      stdoutBuffer = '';
    });

    serverProcess.stderr.on('data', chunk => {
      const text = chunk.toString();
      safeSend('server-log', `[STDERR] ${text}`);
    });

    serverProcess.on('error', (err) => {
      logger.error(`Server process error: ${err.message}`, {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'serverProcess.error',
          errorType: err.constructor.name,
          pid: serverPid,
          serverInfo: serverInfoSnapshot,
          stack: err.stack
        }
      });
      safeSend('server-log', `Server process error: ${err.message}`);
    });
    
    logger.info('Server started successfully', {
      instanceId: instanceName,
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        duration: Date.now() - startOperationTime,
        pid: serverProcess.pid,
        serverInfo: serverProcess['serverInfo'],
        totalServerStarts: performanceMetrics.serverStarts,
        instanceName
      }
    });
    
    eventBus.emit('server-started');
    safeSend('server-status', 'running');
    
    // Start metrics reporting when server starts
    const { startMetricsReporting } = require('./system-metrics.cjs');
    startMetricsReporting();
    
    serverProcess.on('exit', (code, signal) => {
      const exitTime = Date.now();
      const uptime = serverStartMs ? exitTime - serverStartMs : 0;
      const isNormalExit = code === 0 || signal === 'SIGTERM' || signal === 'SIGINT';
      const exitServerInfo = serverInfoSnapshot ? { ...serverInfoSnapshot } : null;
      
      logger.info('Server process exited', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'serverProcess.exit',
          exitCode: code,
          signal,
          isNormalExit,
          uptime,
          pid: serverPid,
          serverInfo: exitServerInfo
        }
      });
      
      if (!isNormalExit) {
        const restartInfo = {
          serverInfo: {
            targetPath: exitServerInfo ? exitServerInfo.targetPath : null,
            port: exitServerInfo && exitServerInfo.port ? exitServerInfo.port : 25565,
            maxRam: exitServerInfo && exitServerInfo.maxRam ? exitServerInfo.maxRam : 4,
            jar: exitServerInfo ? exitServerInfo.jar : null,
            ...(exitServerInfo || {})
          },
          pid: serverPid,
          exitCode: code,
          signal: signal
        };
        
        logger.warn('Server crashed, emitting crash event', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'serverProcess.exit',
            restartInfo,
            uptime
          }
        });
        
        eventBus.emit('server-crashed', restartInfo);
      } else {
        logger.info('Server exited normally', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'serverProcess.exit',
            uptime,
            exitCode: code,
            signal
          }
        });
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
    }, 120000); // Check only every 2 minutes by default

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
  } catch (error) {
    const operationDuration = Date.now() - startOperationTime;
    logger.error(`Server start failed: ${error.message}`, {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'startMinecraftServer',
        duration: operationDuration,
        errorType: error.constructor.name,
        targetPath,
        port,
        maxRam,
        launchJar,
        javaPath,
        stack: error.stack
      }
    });
    return false;
  }
}

/**
 * Stop the Minecraft server gracefully
 * 
 * @returns {boolean} Success status
 */
function stopMinecraftServer() {
  const stopStartTime = Date.now();
  
  if (!serverProcess) {
    logger.warn('Server stop attempted but no server running', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'stopMinecraftServer',
        serverRunning: false
      }
    });
    return false;
  }
  
  const serverInfo = serverProcess['serverInfo'];
  const uptime = serverStartMs ? Date.now() - serverStartMs : 0;
  
  logger.info('Stopping server gracefully', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'stopMinecraftServer',
      pid: serverProcess.pid,
      uptime,
      serverInfo,
      playersOnline: playersInfo.count
    }
  });
  
  serverProcess.stdin.write('stop\n');
  performanceMetrics.serverStops++;

  // Clean up all intervals and timers
  if (listInterval) {
    clearInterval(listInterval);
    listInterval = null;
  }
  clearIntensiveChecking();
  
  // Reset all server state immediately
  serverProcess = null;
  serverStartMs = null;
  playersInfo = { count: 0, names: [] };
  
  const stopDuration = Date.now() - stopStartTime;
  logger.info('Server stopped successfully', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'stopMinecraftServer',
      duration: stopDuration,
      uptime,
      totalServerStops: performanceMetrics.serverStops,
      stopMethod: 'graceful'
    }
  });
  
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
  const killStartTime = Date.now();
  
  if (!serverProcess) {
    logger.warn('Server kill attempted but no server running', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'killMinecraftServer',
        serverRunning: false
      }
    });
    return false;
  }
  
  const pid = serverProcess.pid;
  const serverInfo = serverProcess['serverInfo'];
  const uptime = serverStartMs ? Date.now() - serverStartMs : 0;
  
  logger.warn('Force killing server process', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'killMinecraftServer',
      pid,
      uptime,
      serverInfo,
      playersOnline: playersInfo.count,
      platform: process.platform
    }
  });

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', pid.toString(), '/F', '/T']);
      logger.debug('Windows taskkill command executed', {
        category: 'server',
        data: {
          service: 'ServerManager',
          operation: 'killMinecraftServer',
          pid,
          command: 'taskkill'
        }
      });
    } else {
      try { 
        process.kill(-pid, 'SIGKILL');
        logger.debug('Unix process group kill executed', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'killMinecraftServer',
            pid,
            signal: 'SIGKILL',
            target: 'process_group'
          }
        });
      }
      catch { 
        process.kill(pid, 'SIGKILL');
        logger.debug('Unix process kill executed', {
          category: 'server',
          data: {
            service: 'ServerManager',
            operation: 'killMinecraftServer',
            pid,
            signal: 'SIGKILL',
            target: 'single_process'
          }
        });
      }
    }
  } catch (error) {
    logger.error(`Failed to kill server process: ${error.message}`, {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'killMinecraftServer',
        pid,
        errorType: error.constructor.name,
        platform: process.platform
      }
    });
  }

  performanceMetrics.serverKills++;

  // Clean up all intervals and timers
  if (listInterval) {
    clearInterval(listInterval);
    listInterval = null;
  }
  clearIntensiveChecking();
  
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
  
  const killDuration = Date.now() - killStartTime;
  logger.info('Server killed successfully', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'killMinecraftServer',
      duration: killDuration,
      uptime,
      totalServerKills: performanceMetrics.serverKills,
      stopMethod: 'force_kill'
    }
  });
  
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
  if (!serverProcess) {
    logger.warn('Command send attempted but no server running', {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'sendServerCommand',
        command,
        serverRunning: false
      }
    });
    return false;
  }
  
  performanceMetrics.commandsSent++;
  
  logger.info('Sending command to server', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'sendServerCommand',
      command,
      pid: serverProcess.pid,
      totalCommandsSent: performanceMetrics.commandsSent
    }
  });
  
  try {
    serverProcess.stdin.write(`${command}\n`);
    safeSend('command-response', command);
    return true;
  } catch (error) {
    logger.error(`Failed to send command to server: ${error.message}`, {
      category: 'server',
      data: {
        service: 'ServerManager',
        operation: 'sendServerCommand',
        command,
        errorType: error.constructor.name,
        pid: serverProcess?.pid
      }
    });
    return false;
  }
}

/**
 * Get current server process info
 * 
 * @returns {object} Server state information
 */
function getServerState() {
  const state = {
    isRunning: !!serverProcess,
    serverProcess: serverProcess,
    serverStartMs: serverStartMs,
    serverMaxRam: serverMaxRam,
    playersInfo: playersInfo
  };
  
  logger.debug('Server state requested', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'getServerState',
      isRunning: state.isRunning,
      pid: serverProcess?.pid,
      uptime: serverStartMs ? Date.now() - serverStartMs : 0,
      playersOnline: playersInfo.count,
      maxRam: serverMaxRam
    }
  });
  
  return state;
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
 * Clear all intervals and timers
 */
function clearIntervals() {
  const hadListInterval = !!listInterval;
  
  if (listInterval) {
    clearInterval(listInterval);
    listInterval = null;
  }
  
  // Clear intensive checking timers to prevent memory leaks
  clearIntensiveChecking();
  
  logger.debug('Server intervals cleared', {
    category: 'server',
    data: {
      service: 'ServerManager',
      operation: 'clearIntervals',
      hadListInterval,
      intensiveCheckingCleared: true
    }
  });
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
