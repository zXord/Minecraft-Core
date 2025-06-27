// @ts-nocheck
const { execSync } = require('child_process');
const fs = require('fs');
const { getRuntimePaths } = require('../utils/runtime-paths.cjs');
const { wmicExecSync, wmicTerminate } = require('../utils/wmic-utils.cjs');

const mainPid = parseInt(process.argv[2], 10);
const serverIdentifier = process.argv[3] || 'minecraft-core';

const runtimePaths = getRuntimePaths();
const serverRunningFlagPath = runtimePaths.serverRunningFlag;

/** @type {import('child_process').ExecSyncOptions} */
const execOptions = {
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'ignore']
};

function log() {}

// Cache for server status to reduce WMIC calls
let serverStatusCache = null;
let lastServerCheck = 0;

function isMinecraftServerRunning() {
  // Check file flag first (fastest)
  if (fs.existsSync(serverRunningFlagPath)) {
    return true;
  }
  
  // Use cached result if recent (within 25 seconds to drastically reduce WMIC calls)
  const now = Date.now();
  if (serverStatusCache !== null && (now - lastServerCheck) < 25000) {
    return serverStatusCache;
  }
  
  // Perform WMIC check and cache result
  try {
    const filteredOutput = wmicExecSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv');
    const lines = filteredOutput.trim().split('\n');
    
    let serverRunning = false;
    for (const line of lines) {
      if (line.includes('minecraft') ||
          line.includes('fabric-server') ||
          line.includes('minecraft-core') ||
          line.includes('server.jar')) {
        serverRunning = true;
        break;
      }
    }
    
    // Cache the result
    serverStatusCache = serverRunning;
    lastServerCheck = now;
    return serverRunning;
  } catch {
    // Cache negative result too
    serverStatusCache = false;
    lastServerCheck = now;
    return false;
  }
}

log(`App Watchdog started - PID: ${process.pid}, Monitoring: ${mainPid}, App ID: ${serverIdentifier}`);

if (!mainPid) {
  log('Error: No parent PID provided');
  process.exit(1);
}

try {
  fs.writeFileSync(runtimePaths.appWatchdogPid, process.pid.toString());
  log(`App Watchdog PID ${process.pid} saved to ${runtimePaths.appWatchdogPid}`);
} catch (err) {
  log(`Failed to write app watchdog PID file: ${err.message}`);
}

function logRunningJavaProcesses() {  try {
    log('Listing all running Java processes for debugging:');
    const filteredOutput = wmicExecSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv');
    const lines = filteredOutput.trim().split('\n');
    
    if (lines.length <= 1) {
      log('No Java processes found running.');
      return;
    }
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line) {
        const match = line.match(/,(\d+)$/);
        const pid = match ? match[1] : 'unknown';
        log(`Java process: PID=${pid}, Command=${line}`);
      }
    }
  } catch (err) {
    log(`Error listing Java processes: ${err.message}`);
  }
}

function killJavaProcesses() {
  log(`Killing Java SERVER processes only (preserving Minecraft client)...`);
  
  logRunningJavaProcesses();
  
  try {
    log("Attempt 1: Looking for Fabric server processes");
    wmicTerminate(`wmic process where "commandline like '%fabric-server-launch.jar%' and name='java.exe'" call terminate`);
    log("Fabric server kill command executed");
  } catch (e) {
    log(`Fabric server kill error: ${e.message}`);
  }
  
  try {
    log("Attempt 2: Looking for vanilla Minecraft server processes");
    wmicTerminate(`wmic process where "commandline like '%minecraft_server.jar%' and name='java.exe'" call terminate`);
    log("Minecraft server jar kill command executed");
  } catch (e) {
    log(`Minecraft server jar kill error: ${e.message}`);
  }

  try {
    log("Attempt 3: Looking for processes with server-specific identifiers");
    wmicTerminate(`wmic process where "commandline like '%-Dminecraft.core.server%' and name='java.exe'" call terminate`);
    log("Server identifier kill command executed");
  } catch (e) {
    log(`Server identifier kill error: ${e.message}`);
  }
    try {
    log("Final check for any remaining Minecraft SERVER processes (preserving client):");
    const remainingJava = wmicExecSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv').trim();
    
    if (remainingJava && remainingJava.includes('ProcessId')) {
      const lines = remainingJava.split('\n').filter(line => line.trim() && !line.includes('ProcessId'));
      
      if (lines.length > 0) {
        log(`Found ${lines.length} remaining Java processes after cleanup`);
        
        for (const line of lines) {
          // Only kill processes that are clearly SERVER processes, not client
          const isServerProcess = (
            line.includes('fabric-server-launch.jar') || 
            line.includes('minecraft_server.jar') ||
            line.includes('-Dminecraft.core.server') ||
            (line.includes('server.jar') && !line.includes('client'))
          );
          
          // IMPORTANT: Do NOT kill client processes (these should keep running)
          const isClientProcess = (
            line.includes('net.minecraft.client.main.Main') ||
            line.includes('-Djava.library.path') ||
            line.includes('versions') && line.includes('natives') ||
            line.includes('launcher') && line.includes('client')
          );
          
          if (isServerProcess && !isClientProcess) {
            const match = line.match(/,(\d+)$/);
            if (match && match[1]) {
              const javaPid = match[1];
              log(`Found Minecraft SERVER process: ${javaPid}, killing...`);
              try {
                execSync(`taskkill /F /PID ${javaPid}`, /** @type {import('child_process').ExecSyncOptions} */({ ...execOptions, stdio: 'ignore' }));
                log(`Killed server process ${javaPid}`);
              } catch (e) {
                log(`Error killing server process ${javaPid}: ${e.message}`);
              }
            }
          } else if (isClientProcess) {
            log(`Preserving Minecraft CLIENT process (not killing)`);
          }
        }
      } else {
        log("No remaining Minecraft server Java processes found - cleanup successful");
      }
    } else {
      log("No remaining Java processes found - cleanup successful");
    }
  } catch (e) {
    log(`Error checking for remaining processes: ${e.message}`);
  }
  
  log("Server cleanup complete - Minecraft client processes preserved");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkProcess() {
  const serverRunning = isMinecraftServerRunning();

  if (!serverRunning) {
    if (!processExists(mainPid)) {
      log(`Electron app (PID ${mainPid}) not found, but no server is running. Exiting watchdog.`);
      process.exit(0);
    }
    
    setTimeout(checkProcess, 45000); // Check every 45 seconds when server not running
    return;
  }

  try {
    log(`Checking if Electron app (PID ${mainPid}) is still running...`);
    
    if (!processExists(mainPid)) {
      log(`Electron app (PID ${mainPid}) terminated, killing Minecraft server Java processes...`);
      killJavaProcesses();
      log('Cleanup complete, exiting app watchdog');
      process.exit(0);
    } else {
      log(`Electron app (PID ${mainPid}) is still running`);
    }
  } catch (e) {
    log(`Error checking Electron app (PID ${mainPid}): ${e.message}`);
    log('Assuming Electron app is terminated, killing Minecraft server Java processes...');
    killJavaProcesses();
    log('Cleanup complete, exiting app watchdog');
    process.exit(0);
  }
  setTimeout(checkProcess, 30000); // Check every 30 seconds when server running (lightweight check)
}

log("Starting Electron app monitoring loop");
checkProcess();
