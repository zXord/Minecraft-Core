// Minecraft Watchdog - Kills server processes if the main app crashes
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Process arguments - parent PID and server identifier
const mainPid = parseInt(process.argv[2], 10);
const serverIdentifier = process.argv[3] || 'minecraft-core';

// Set up logging
const logDir = path.join(__dirname);
const logFile = path.join(logDir, 'watchdog.log');

// Create a function for logging
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${message}\n`;
  
  try {
    fs.appendFileSync(logFile, logMessage);
  } catch (err) {
    // If we can't write to the log file, write to a fallback location
    try {
      const fallbackLog = path.join(process.cwd(), 'watchdog-fallback.log');
      fs.appendFileSync(fallbackLog, logMessage);
    } catch (e) {
      // Try one more location - the temp directory
      try {
        const tempDir = process.env.TEMP || process.env.TMP || __dirname;
        const emergencyLog = path.join(tempDir, 'minecraft-watchdog-emergency.log');
        fs.appendFileSync(emergencyLog, logMessage);
      } catch (final) {
        // Can't do much if we can't write to any log
      }
    }
  }
}

// Start of execution
log(`Watchdog started - PID: ${process.pid}, Monitoring: ${mainPid}, Server ID: ${serverIdentifier}`);

if (!mainPid) {
  log('Error: No parent PID provided');
  process.exit(1);
}

// Write watchdog PID to a file for debugging
try {
  const watchdogPidFile = path.join(__dirname, 'watchdog.pid');
  fs.writeFileSync(watchdogPidFile, process.pid.toString());
  log(`Watchdog PID ${process.pid} saved to ${watchdogPidFile}`);
} catch (err) {
  log(`Failed to write watchdog PID file: ${err.message}`);
}

// Check for any server process debug information
try {
  const debugInfoPath = path.join(__dirname, 'server-process-debug.json');
  if (fs.existsSync(debugInfoPath)) {
    const debugInfo = JSON.parse(fs.readFileSync(debugInfoPath, 'utf8'));
    log(`Found server process debug info: Node PID: ${debugInfo.nodePid}, Java PID: ${debugInfo.javaPid}, Server ID: ${debugInfo.serverIdentifier}`);
    
    // If there's a specific server identifier in the debug file, prefer it
    if (debugInfo.serverIdentifier && !serverIdentifier.includes('minecraft-core-server-')) {
      log(`Using more specific server identifier from debug file: ${debugInfo.serverIdentifier}`);
      serverIdentifier = debugInfo.serverIdentifier;
    }
  }
} catch (err) {
  log(`Error reading server process debug info: ${err.message}`);
}

// Find all Java processes and log them for debugging
function logRunningJavaProcesses() {
  try {
    log('Listing all running Java processes for debugging:');
    const stdout = execSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf8' });
    const lines = stdout.trim().split('\n');
    
    if (lines.length <= 1) {
      log('No Java processes found running.');
      return;
    }
    
    // Skip the header line
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

// Use stronger methods to kill Java processes
function killJavaProcesses() {
  log(`Killing Java processes related to "${serverIdentifier}"...`);
  
  // First log all running Java processes for debugging
  logRunningJavaProcesses();
  
  // Kill by server identifier
  try {
    log(`Attempt 1: Using WMIC to kill Java processes with "${serverIdentifier}" in command line`);
    execSync(`wmic process where "commandline like '%${serverIdentifier}%' and name='java.exe'" call terminate`, 
      { stdio: 'ignore' });
    log("WMIC kill command executed");
  } catch (e) {
    log(`WMIC kill error: ${e.message}`);
  }
  
  // Try another approach with taskkill
  try {
    log("Attempt 2: Looking for any process with fabric-server-launch.jar");
    execSync(`wmic process where "commandline like '%fabric-server-launch.jar%' and name='java.exe'" call terminate`, 
      { stdio: 'ignore' });
    log("Fabric server kill command executed");
  } catch (e) {
    log(`Fabric server kill error: ${e.message}`);
  }
  
  // Try another approach with taskkill for all Java
  try {
    log("Attempt 3: Killing all Java processes with taskkill");
    execSync('taskkill /F /IM java.exe /T', { stdio: 'ignore' });
    log("taskkill command executed");
  } catch (e) {
    log(`taskkill error: ${e.message}`);
  }
  
  // Try a third approach to directly search for Minecraft server processes
  try {
    log("Attempt 4: Searching for Java processes with Minecraft server in command line");
    const stdout = execSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv', 
      { encoding: 'utf8' });
    
    log(`Process list obtained: ${stdout.length} bytes`);
    
    // Parse the output
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      if (line.includes('fabric-server-launch.jar') || 
          line.includes('minecraft_server.jar') || 
          line.includes('minecraft-core') ||
          (serverIdentifier && line.includes(serverIdentifier))) {
        
        const match = line.match(/,(\d+)$/);
        if (match && match[1]) {
          const javaPid = match[1];
          log(`Found Minecraft server process: ${javaPid}, killing...`);
          try {
            execSync(`taskkill /F /PID ${javaPid}`, { stdio: 'ignore' });
            log(`Killed process ${javaPid}`);
          } catch (e) {
            log(`Error killing process ${javaPid}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    log(`Process search error: ${e.message}`);
  }
  
  // Final check to make sure all Java processes are gone
  try {
    log("Final check for any remaining Java processes:");
    const remainingJava = execSync('wmic process where "name=\'java.exe\'" get ProcessId', { encoding: 'utf8' }).trim();
    
    if (remainingJava && remainingJava.includes('ProcessId')) {
      const lines = remainingJava.split('\n').filter(line => line.trim() && !line.includes('ProcessId'));
      
      if (lines.length > 0) {
        log(`Warning: Found ${lines.length} remaining Java processes after cleanup`);
        
        // Last resort - brute force kill
        try {
          log("Last resort: Using taskkill with /F /IM java.exe");
          execSync('taskkill /F /IM java.exe', { stdio: 'ignore' });
        } catch (e) {
          log(`Final taskkill error: ${e.message}`);
        }
      } else {
        log("No remaining Java processes found - cleanup successful");
      }
    } else {
      log("No remaining Java processes found - cleanup successful");
    }
  } catch (e) {
    log(`Error checking for remaining processes: ${e.message}`);
  }
  
  log("All kill attempts complete");
}

function checkProcess() {
  try {
    // Check if main process still exists
    log(`Checking if process ${mainPid} is still running...`);
    const result = execSync(`tasklist /FI "PID eq ${mainPid}" /FO CSV`, { encoding: 'utf8' });
    
    if (!result.includes(`"${mainPid}"`)) {
      log(`Main process ${mainPid} terminated, killing Minecraft server Java processes...`);
      killJavaProcesses();
      log('Cleanup complete, exiting watchdog');
      process.exit(0);
    } else {
      log(`Process ${mainPid} is still running`);
    }
  } catch (e) {
    // If tasklist fails, assume main process is gone
    log(`Error checking main process ${mainPid}: ${e.message}`);
    log('Assuming main process is terminated, killing Minecraft server Java processes...');
    killJavaProcesses();
    log('Cleanup complete, exiting watchdog');
    process.exit(0);
  }
  setTimeout(checkProcess, 5000); // Check every 5 seconds
}

// Start checking
log("Starting process monitoring loop");
checkProcess(); 