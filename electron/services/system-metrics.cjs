// System metrics service
const os = require('os');
const pidusage = require('pidusage');
const { execSync } = require('child_process');
const { safeSend } = require('../utils/safe-send.cjs');
const { getServerState, sendMetricsUpdate } = require('./server-manager.cjs');

// Initialize metrics state
let prevCpuTimes = os.cpus().map(cpu => ({ ...cpu.times }));
let memLookupTimer = 0;
let mainWindow = null;

/**
 * Start periodic metrics reporting
 * 
 * @param {BrowserWindow} win - Main window
 */
function startMetricsReporting(win) {
  mainWindow = win; // Store reference to the main window
  
  // System metrics update every half second
  setInterval(() => {
    publishSystemMetrics().catch(err => {
    });
  }, 500); // 500ms for faster UI updates
  
  // Also listen for server state changes to ensure metrics are updated
  const eventBus = require('../utils/event-bus.cjs');
  
  // Reset metrics when server stops
  eventBus.on('server-normal-exit', () => {
    
    // Send zeroed metrics on server exit
    sendMetricsUpdate({
      cpuPct: 0,
      memUsedMB: 0,
      systemTotalRamMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
      maxRamMB: 4096, 
      uptime: '0h 0m 0s',
      players: 0,
      names: []
    });
  });
}

/**
 * Calculate CPU usage since last tick
 * 
 * @returns {number} CPU usage percentage
 */
function getSystemCpuPct() {
  const cpus = os.cpus();
  let idleDiff = 0, totalDiff = 0;

  cpus.forEach((cpu, i) => {
    const prev = prevCpuTimes[i];
    const now = cpu.times;

    const idle = now.idle - prev.idle;
    const total = Object.values(now).reduce((a, b) => a + b, 0) -
                  Object.values(prev).reduce((a, b) => a + b, 0);

    idleDiff += idle;
    totalDiff += total;
    prevCpuTimes[i] = { ...now };
  });

  return totalDiff ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
}

/**
 * Get server memory usage
 * 
 * @param {object} serverProcess - Server process object
 * @returns {Promise<number>} Memory usage in MB
 */
async function getServerMemoryUsage(serverProcess) {
  // Default value
  let currentLookupMem = 0;
  
  // Check if process is valid and exists
  if (!serverProcess || !serverProcess.pid) {
    return currentLookupMem;
  }
  
  // Check if the process still exists before trying to get metrics
  try {
    // In Node.js, sending signal 0 is a way to check if a process exists
    // without actually sending a signal to it
    process.kill(serverProcess.pid, 0);
  } catch (e) {
    // If process doesn't exist, return 0 immediately
    return currentLookupMem;
  }
  
  // Throttle memory lookup to every 5s
  const now = Date.now();
  if (now - memLookupTimer < 5000 && publishSystemMetrics.lastMemUsedMB) {
    return publishSystemMetrics.lastMemUsedMB;
  }
  
  memLookupTimer = now;
  
  if (process.platform === 'win32') {
    try {
      // First try a more reliable method for Windows
      let minecraftServerMemory = 0;
      
      try {
        // Get all java processes on the system
        const javaProcesses = execSync(
          'wmic process where "name=\'java.exe\'" get ProcessId,WorkingSetSize /format:csv',
          { encoding: 'utf8' }
        ).trim().split('\n').slice(1); // Skip header
        
        // Find the process with the highest memory footprint
        for (const line of javaProcesses) {
          if (!line.trim()) continue;
          const parts = line.trim().split(',');
          if (parts.length >= 3) {
            const memInBytes = parseInt(parts[2], 10);
            if (!isNaN(memInBytes) && memInBytes > minecraftServerMemory) {
              minecraftServerMemory = memInBytes;
            }
          }
        }
        
        if (minecraftServerMemory > 0) {
          currentLookupMem = parseFloat((minecraftServerMemory / 1024 / 1024).toFixed(1));
        }      } catch (wmicErr) {
        if (process.env.DEBUG) {
          console.error('WMIC memory lookup failed:', wmicErr.message);
        }
      }
        // If the first method failed, try direct PowerShell as backup
      if (minecraftServerMemory === 0) {
        try {
          // Check if process exists in PowerShell before trying to get metrics
          const processExists = execSync(
            `powershell -Command "if (Get-Process -Id ${serverProcess.pid} -ErrorAction SilentlyContinue) { Write-Output 'true' } else { Write-Output 'false' }"`, 
            { encoding: 'utf8' }
          ).trim();
          
          if (processExists === 'true') {
            const memoryOutput = execSync(
              `powershell -Command "(Get-Process -Id ${serverProcess.pid} -ErrorAction Stop).WorkingSet64 / 1MB"`, 
              { encoding: 'utf8' }
            ).trim();
            const memoryValue = parseFloat(memoryOutput);
            if (!isNaN(memoryValue) && memoryValue > 0) {
              currentLookupMem = memoryValue;
            }
          } else {
          }        } catch (psErr) {
          // Silently handle the error and don't output to console as this is expected sometimes
          if (process.env.DEBUG) {
            console.error('PowerShell memory lookup failed:', psErr.message);
          }
        }
      }
    } catch (err) {
    }
  } else {
    // For non-Windows systems, use pidusage
    try {
      const stats = await pidusage(serverProcess.pid);
      currentLookupMem = parseFloat((stats.memory / 1024 / 1024).toFixed(1));
    } catch (err) {
    }
  }
  
  // Save last memory value for later use
  publishSystemMetrics.lastMemUsedMB = currentLookupMem;
  return currentLookupMem;
}

/**
 * Publish CPU, memory, uptime, and player info to renderer
 * 
 * @returns {Promise<void>}
 */
async function publishSystemMetrics() {  
  try {
    let cpuPct = 0;
    let memUsedMB = publishSystemMetrics.lastMemUsedMB || 0;
    let { serverProcess, playersInfo } = getServerState();
    const { serverStartMs, serverMaxRam } = getServerState();
    
    // Calculate max ram in MB for percentage calculations
    const maxRamMB = serverMaxRam ? serverMaxRam * 1024 : memUsedMB > 0 ? memUsedMB * 1.5 : 4096;
    
    if (serverProcess && serverProcess.pid) {
      // Server is running - collect real metrics
      if (process.platform !== 'win32') {
        // On non-Windows, use pidusage
        try {
          const stat = await pidusage(serverProcess.pid);
          cpuPct = parseFloat(stat.cpu.toFixed(1));
        } catch (err) {
          cpuPct = 0; // Fallback
        }
      } else {
        // Skip per-process CPU usage on Windows to avoid pidusage errors
        cpuPct = 0;
      }
      
      // Get memory usage
      memUsedMB = await getServerMemoryUsage(serverProcess);
      
      // Ensure non-zero state to indicate running server
      if (cpuPct <= 0) cpuPct = 0.1; // Minimal value to show it's actually running
      if (memUsedMB <= 0) memUsedMB = 1; // Minimal value to show it's actually running
    } else {
      // If server is not running, explicitly reset all metrics to zero
      // Only log the first time we zero out metrics to avoid log spam
      if (publishSystemMetrics.lastMemUsedMB > 0) {
      }
      
      cpuPct = 0;
      memUsedMB = 0;
      publishSystemMetrics.lastMemUsedMB = 0;
      
      // Reset player info safely
      if (playersInfo) {
        playersInfo.count = 0;
        playersInfo.names = [];
      }
    }

    // Calculate uptime
    let uptime = '0h 0m 0s';
    if (serverStartMs) {
      const uptimeMs = Date.now() - serverStartMs;
      const h = Math.floor(uptimeMs / 3600000);
      const m = Math.floor((uptimeMs % 3600000) / 60000);
      const s = Math.floor((uptimeMs % 60000) / 1000);
      uptime = `${h}h ${m}m ${s}s`;
    }

    // Send metrics to renderer
    sendMetricsUpdate({
      cpuPct,
      memUsedMB,
      systemTotalRamMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
      maxRamMB,
      uptime,
      players: playersInfo.count,
      names: playersInfo.names
    });
  } catch (err) {
  }
}

// Initialize the last memory value
publishSystemMetrics.lastMemUsedMB = 0;

module.exports = {
  startMetricsReporting,
  getSystemCpuPct,
  publishSystemMetrics
};
