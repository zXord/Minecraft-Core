const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getRuntimePaths } = require('../utils/runtime-paths.cjs');
const { wmicExecSync, wmicTerminate } = require('../utils/wmic-utils.cjs');

const mainPid = parseInt(process.argv[2], 10);
let serverIdentifier = process.argv[3] || 'minecraft-core';

const runtimePaths = getRuntimePaths();
const logFile = path.join(runtimePaths.runtimeDir, 'watchdog.log');

function log(message) {
  const timestamp = new Date().toISOString();
  
  try {
    fs.appendFileSync(logFile, `${timestamp} - ${message}\n`);
  } catch {
    try {
      const fallbackLog = path.join(process.cwd(), 'watchdog-fallback.log');
      fs.appendFileSync(fallbackLog, `${timestamp} - ${message}\n`);
    } catch {
      try {
        const tempDir = process.env.TEMP || process.env.TMP || __dirname;
        const emergencyLog = path.join(tempDir, 'minecraft-watchdog-emergency.log');
        fs.appendFileSync(emergencyLog, `${timestamp} - ${message}\n`);
      } catch {
        return;
      }
    }
  }
}

log(`Watchdog started - PID: ${process.pid}, Monitoring: ${mainPid}, Server ID: ${serverIdentifier}`);

if (!mainPid) {
  log('Error: No parent PID provided');
  process.exit(1);
}

try {
  fs.writeFileSync(runtimePaths.watchdogPid, process.pid.toString());
  log(`Watchdog PID ${process.pid} saved to ${runtimePaths.watchdogPid}`);
} catch (err) {
  log(`Failed to write watchdog PID file: ${err.message}`);
}

try {
  if (fs.existsSync(runtimePaths.serverProcessDebug)) {
    const debugInfo = JSON.parse(fs.readFileSync(runtimePaths.serverProcessDebug, 'utf8'));
    log(`Found server process debug info: Node PID: ${debugInfo.nodePid}, Java PID: ${debugInfo.javaPid}, Server ID: ${debugInfo.serverIdentifier}`);
    
    if (debugInfo.serverIdentifier && !serverIdentifier.includes('minecraft-core-server-')) {
      log(`Using more specific server identifier from debug file: ${debugInfo.serverIdentifier}`);
      serverIdentifier = debugInfo.serverIdentifier;
    }
  }
} catch (err) {
  log(`Error reading server process debug info: ${err.message}`);
}

function logRunningJavaProcesses() {  try {
    log('Listing all running Java processes for debugging:');
    const filteredOutput = wmicExecSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv');
    const lines = String(filteredOutput).trim().split('\n');
    
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
    log("Attempt 3: Looking for server-specific identifier processes");
    if (serverIdentifier && serverIdentifier.includes('server')) {
      wmicTerminate(`wmic process where "commandline like '%${serverIdentifier}%' and name='java.exe'" call terminate`);
      log(`Server identifier (${serverIdentifier}) kill command executed`);
    }
  } catch (e) {
    log(`Server identifier kill error: ${e.message}`);
  }
  
  try {
    log("Attempt 4: Searching for Java processes with Minecraft SERVER in command line (preserving client)");
    const filteredOutput = wmicExecSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv');
    log(`Process list obtained: ${filteredOutput.length} bytes`);
    
    const lines = String(filteredOutput).trim().split('\n');
    for (const line of lines) {
      // Only kill processes that are clearly SERVER processes, not client
      const isServerProcess = (
        line.includes('fabric-server-launch.jar') || 
          line.includes('minecraft_server.jar') || 
        (line.includes('minecraft-core') && line.includes('server')) ||
        (serverIdentifier && line.includes(serverIdentifier) && serverIdentifier.includes('server'))
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
            execSync(`taskkill /F /PID ${javaPid}`, /** @type {import('child_process').ExecSyncOptions} */({ stdio: 'ignore' }));
            log(`Killed server process ${javaPid}`);
          } catch (e) {
            log(`Error killing server process ${javaPid}: ${e.message}`);
          }
        }
      } else if (isClientProcess) {
        log(`Preserving Minecraft CLIENT process (not killing)`);
      }
    }
  } catch (e) {
    log(`Process search error: ${e.message}`);
  }
    try {
    log("Final check for any remaining Java processes:");
    const remainingJava = wmicExecSync('wmic process where "name=\'java.exe\'" get ProcessId').trim();
    
    if (remainingJava && remainingJava.includes('ProcessId')) {
      const lines = remainingJava.split('\n').filter(line => line.trim() && !line.includes('ProcessId'));
      
      if (lines.length > 0) {
        log(`Found ${lines.length} remaining Java processes after targeted cleanup`);
        log("NOT killing all Java processes - this preserves user's Minecraft client and other applications");
        log("Server cleanup complete - any remaining server processes will be cleaned up on next app start");
      } else {
        log("No remaining Java processes found - cleanup successful");
      }
    } else {
      log("No remaining Java processes found - cleanup successful");
    }
  } catch (e) {
    log(`Error checking for remaining processes: ${e.message}`);
  }
  
  log("Server cleanup complete - Minecraft client processes preserved");
}

function checkProcess() {
  try {
    log(`Checking if process ${mainPid} is still running...`);
    
    // Use lightweight Node.js process check instead of heavy tasklist command
    process.kill(mainPid, 0); // Signal 0 just tests if process exists, doesn't kill it
    
    log(`Process ${mainPid} is still running`);
  } catch (e) {
    // Process doesn't exist - this is the normal way this check works
    log(`Main process ${mainPid} terminated, killing Minecraft server Java processes...`);
    killJavaProcesses();
    log('Cleanup complete, exiting watchdog');
    process.exit(0);
  }
  
  // Check less frequently since we're using lightweight method
  setTimeout(checkProcess, 30000); // Check every 30 seconds - much lighter check
}
log("Starting process monitoring loop");
checkProcess();
