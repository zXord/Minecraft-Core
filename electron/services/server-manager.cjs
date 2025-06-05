// Server manager service
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { safeSend } = require('../utils/safe-send.cjs');
const eventBus = require('../utils/event-bus.cjs');
const { resetCrashCount } = require('./auto-restart.cjs');

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

// Set up event listeners
eventBus.on('request-server-start', ({ targetPath, port, maxRam }) => {
  const result = startMinecraftServer(targetPath, port, maxRam);
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
 * @returns {boolean} Success status
 */
function startMinecraftServer(targetPath, port, maxRam) {
  if (serverProcess) return false;
  
  console.log(`Starting server at ${targetPath} on port ${port} with ${maxRam}GB RAM`);
  
  serverStartMs = Date.now();
  serverMaxRam = maxRam;

  const launchJar = path.join(targetPath, 'fabric-server-launch.jar');
  if (!fs.existsSync(launchJar)) {
    console.log('❌ fabric-server-launch.jar not found');
    return false;
  }

  try {
    const serverIdentifier = `minecraft-core-server-${Date.now()}`;
    
    serverProcess = spawn('java', [
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
    
    serverProcess.serverInfo = {
      id: serverIdentifier,
      jar: launchJar,
      port: port,
      maxRam: maxRam,
      startTime: serverStartMs,
      commandLineIdentifier: `fabric-server-launch.jar nogui --port ${port}`,
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
          console.log(`Player leave detected: ${playerName}`);
          
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
    
    serverProcess.on('exit', (code, signal) => {
      console.log(`Server process exited with code ${code}${signal ? ` and signal ${signal}` : ''}`);
      
      const isNormalExit = code === 0 || signal === 'SIGTERM' || signal === 'SIGINT';
      
      const serverInfo = serverProcess ? { ...serverProcess.serverInfo } : null;
      
      console.log(`[INFO] Server process exited with code ${code}${signal ? ` and signal ${signal}` : ''} (${isNormalExit ? 'normal exit' : 'crash detected'})`);
      
      if (!isNormalExit) {
        const restartInfo = {
          serverInfo: {
            targetPath: serverProcess && serverProcess.serverInfo ? serverProcess.serverInfo.targetPath : null,
            port: serverProcess && serverProcess.serverInfo ? serverProcess.serverInfo.port : 25565,
            maxRam: serverProcess && serverProcess.serverInfo ? serverProcess.serverInfo.maxRam : 4,
            jar: serverProcess && serverProcess.serverInfo ? serverProcess.serverInfo.jar : null,
            ...serverInfo
          },
          pid: serverProcess ? serverProcess.pid : null,
          exitCode: code,
          signal: signal
        };
        
        console.log("Creating restart info with essential properties:", {
          targetPath: restartInfo.serverInfo.targetPath,
          port: restartInfo.serverInfo.port,
          maxRam: restartInfo.serverInfo.maxRam
        });
        
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
        console.log('Sent delayed server running status to ensure UI update');
      }
    }, 300);
    
    return true;
  } catch (err) {
    console.log(`Error starting server: ${err.message}`);
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
  
  console.log('Stopping Minecraft server gracefully');
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
    console.log('Sent delayed server stopped status to ensure UI update');
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
  
  console.log('Force killing Minecraft server process');

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
    console.log('Sent delayed server stopped status after kill to ensure UI update');
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
