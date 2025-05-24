// App Watchdog - Kills server processes if the Electron app crashes
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Process arguments - parent PID and server identifier
const mainPid = parseInt(process.argv[2], 10);
const serverIdentifier = process.argv[3] || 'minecraft-core';

// Set up logging
const logDir = path.join(__dirname);
const logFile = path.join(logDir, 'app-watchdog.log');
const serverRunningFlagPath = path.join(__dirname, 'server-running.flag');

// Add a common options object for all process executions to hide windows
const execOptions = {
  encoding: 'utf8',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'ignore']
};

// Create a function for logging (disabled file logging)
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${message}`;
  
  // Only log to console, no file logging
  console.log(logMessage);
}

// Function to check if a Minecraft server is running
function isMinecraftServerRunning() {
  // Method 1: Check if server-running.flag exists
  if (fs.existsSync(serverRunningFlagPath)) {
    return true;
  }
  
  // Method 2: Check for Java processes with Minecraft keywords
  try {
    const stdout = execSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv', execOptions);
    const lines = stdout.trim().split('\n');
    
    // Check if any Java process has Minecraft related keywords
    for (const line of lines) {
      if (line.includes('minecraft') || 
          line.includes('fabric-server') || 
          line.includes('minecraft-core') ||
          line.includes('server.jar')) {
        return true;
      }
    }
  } catch (err) {
    // If process check fails, try one more method
  }
  
  return false;
}

// Start of execution
log(`App Watchdog started - PID: ${process.pid}, Monitoring: ${mainPid}, App ID: ${serverIdentifier}`);

if (!mainPid) {
  log('Error: No parent PID provided');
  process.exit(1);
}

// Write watchdog PID to a file for debugging
try {
  const watchdogPidFile = path.join(__dirname, 'app-watchdog.pid');
  fs.writeFileSync(watchdogPidFile, process.pid.toString());
  log(`App Watchdog PID ${process.pid} saved to ${watchdogPidFile}`);
} catch (err) {
  log(`Failed to write app watchdog PID file: ${err.message}`);
}

// Find all Java processes and log them for debugging
function logRunningJavaProcesses() {
  try {
    log('Listing all running Java processes for debugging:');
    const stdout = execSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv', execOptions);
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

// Use stronger methods to kill Java processes (similar to minecraft-watchdog.cjs)
function killJavaProcesses() {
  log(`Killing Java processes related to "${serverIdentifier}"...`);
  
  // First log all running Java processes for debugging
  logRunningJavaProcesses();
  
  // Kill by server identifier
  try {
    log(`Attempt 1: Using WMIC to kill Java processes with "${serverIdentifier}" in command line`);
    execSync(`wmic process where "commandline like '%${serverIdentifier}%' and name='java.exe'" call terminate`, 
      { ...execOptions, stdio: 'ignore' });
    log("WMIC kill command executed");
  } catch (e) {
    log(`WMIC kill error: ${e.message}`);
  }
  
  // Try another approach with taskkill
  try {
    log("Attempt 2: Looking for any process with fabric-server-launch.jar");
    execSync(`wmic process where "commandline like '%fabric-server-launch.jar%' and name='java.exe'" call terminate`, 
      { ...execOptions, stdio: 'ignore' });
    log("Fabric server kill command executed");
  } catch (e) {
    log(`Fabric server kill error: ${e.message}`);
  }
  
  // Try another approach with taskkill for minecraft-related Java
  try {
    log("Attempt 3: Killing all Java processes with minecraft in the command line");
    execSync(`wmic process where "commandline like '%minecraft%' and name='java.exe'" call terminate`, 
      { ...execOptions, stdio: 'ignore' });
    log("Minecraft Java kill command executed");
  } catch (e) {
    log(`Minecraft Java kill error: ${e.message}`);
  }
  
  // Final check to make sure all relevant Java processes are gone
  try {
    log("Final check for any remaining Java processes that may be Minecraft servers:");
    const remainingJava = execSync('wmic process where "name=\'java.exe\'" get ProcessId,CommandLine /format:csv', execOptions).trim();
    
    if (remainingJava && remainingJava.includes('ProcessId')) {
      const lines = remainingJava.split('\n').filter(line => line.trim() && !line.includes('ProcessId'));
      
      if (lines.length > 0) {
        log(`Found ${lines.length} remaining Java processes after cleanup`);
        
        // Don't kill all Java processes - this could affect other applications
        // Instead, try one final targeted attempt
        for (const line of lines) {
          if (line.includes('minecraft') || line.includes('fabric-server-launch') || line.includes('-Dminecraft.core')) {
            const match = line.match(/,(\d+)$/);
            if (match && match[1]) {
              const javaPid = match[1];
              log(`Found likely Minecraft server process: ${javaPid}, killing...`);
              try {
                execSync(`taskkill /F /PID ${javaPid}`, { ...execOptions, stdio: 'ignore' });
                log(`Killed process ${javaPid}`);
              } catch (e) {
                log(`Error killing process ${javaPid}: ${e.message}`);
              }
            }
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
  
  log("All kill attempts complete");
}

// Function to check if a process exists without using execSync
function processExists(pid) {
  try {
    // On Windows, trying to send signal 0 throws an error if process doesn't exist
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Error thrown means process doesn't exist or we don't have permission
    return false;
  }
}

// Counter to reduce log spam when server isn't running
let quietCheckCounter = 0;

function checkProcess() {
  // Check if server is running
  const serverRunning = isMinecraftServerRunning();
  
  // Simple check when server isn't running
  if (!serverRunning) {
    // Only log occasionally to reduce noise
    if (quietCheckCounter % 6 === 0) { // Log once every 30 seconds (5s × 6)
      console.log(`[${new Date().toISOString()}] No Minecraft server running, watchdog in standby mode`);
    }
    quietCheckCounter++;
    
    // Simple check that parent process exists
    if (!processExists(mainPid)) {
      // Even if no server is running, if app crashed, exit watchdog
      log(`Electron app (PID ${mainPid}) not found, but no server is running. Exiting watchdog.`);
      process.exit(0);
    }
    
    setTimeout(checkProcess, 5000);
    return;
  }
  
  // Reset counter when server is running
  quietCheckCounter = 0;
  
  try {
    // Full check when server is running
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
    // If check fails, assume main process is gone
    log(`Error checking Electron app (PID ${mainPid}): ${e.message}`);
    log('Assuming Electron app is terminated, killing Minecraft server Java processes...');
    killJavaProcesses();
    log('Cleanup complete, exiting app watchdog');
    process.exit(0);
  }
  setTimeout(checkProcess, 5000); // Check every 5 seconds
}

// Start checking
log("Starting Electron app monitoring loop");
checkProcess(); 