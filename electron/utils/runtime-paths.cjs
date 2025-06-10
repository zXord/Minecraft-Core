const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

/**
 * Get the runtime directory for temporary files (PIDs, flags, logs)
 * These should NOT be in the source code directory
 */
function getRuntimeDir() {
  let runtimeDir;
  
  try {
    // Try to use app userData first
    if (app && app.getPath) {
      runtimeDir = path.join(app.getPath('userData'), 'runtime');
    } else {
      // Fallback for when app is not available
      runtimeDir = path.join(os.homedir(), '.minecraft-core', 'runtime');    }
  } catch {
    // Final fallback to system temp
    runtimeDir = path.join(os.tmpdir(), 'minecraft-core-runtime');
  }
  
  // Ensure the directory exists
  try {
    if (!fs.existsSync(runtimeDir)) {
      fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o755 });    }
  } catch {
    // Use system temp as final fallback
    runtimeDir = path.join(os.tmpdir(), 'minecraft-core-runtime-' + Date.now());
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o755 });
  }
  
  return runtimeDir;
}

/**
 * Get specific runtime file paths
 */
function getRuntimePaths() {
  const runtimeDir = getRuntimeDir();
  
  return {
    runtimeDir,
    watchdogPid: path.join(runtimeDir, 'watchdog.pid'),
    currentWatchdogPid: path.join(runtimeDir, 'current-watchdog.pid'),
    appWatchdogPid: path.join(runtimeDir, 'app-watchdog.pid'),
    serverRunningFlag: path.join(runtimeDir, 'server-running.flag'),
    serverPauseFlag: path.join(runtimeDir, 'server-pause.flag'),
    blockRestartFlag: path.join(runtimeDir, 'block-restart.flag'),
    serverProcessDebug: path.join(runtimeDir, 'server-process-debug.json'),
    terminationRecord: path.join(runtimeDir, 'termination-record.json'),
  };
}

/**
 * Clean up all runtime files (useful for app startup)
 */
function cleanupRuntimeFiles() {
  try {
    const paths = getRuntimePaths();
    const filesToClean = [
      paths.watchdogPid,
      paths.currentWatchdogPid,
      paths.appWatchdogPid,
      paths.serverRunningFlag,
      paths.serverPauseFlag,
      paths.blockRestartFlag,
      paths.serverProcessDebug,
      paths.terminationRecord
    ];
    
    for (const filePath of filesToClean) {      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Ignore file deletion errors
      }    }
  } catch {
    // Ignore cleanup errors
  }
}

module.exports = {
  getRuntimeDir,
  getRuntimePaths,
  cleanupRuntimeFiles
}; 
