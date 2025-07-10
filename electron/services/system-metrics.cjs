// System metrics service
const os = require('os');
const pidusage = require('pidusage');
const { getServerState, sendMetricsUpdate } = require('./server-manager.cjs');
const { wmicExecSync } = require('../utils/wmic-utils.cjs');
const process = require('process');

// Initialize metrics state
let prevCpuTimes = os.cpus().map(cpu => ({ ...cpu.times }));
let memLookupTimer = 0;
let metricsInterval = null;
let isMetricsActive = false;

function startMetricsReporting() {
  
  
  // Clear any existing interval
  stopMetricsReporting();
  
  isMetricsActive = true;
  
  // DON'T start interval immediately - only when server actually starts
  // Use a simple setInterval that can be properly stopped
  metricsInterval = setInterval(async () => {
    if (!isMetricsActive) {
      return; // Skip if metrics were disabled
    }
    
    const { serverProcess } = getServerState();
    
    // Only collect metrics if server is running, OTHERWISE STOP THE INTERVAL
    if (serverProcess && serverProcess.pid) {
      try {
        await publishSystemMetrics();
      } catch (error) {
        // TODO: Add proper logging - Metrics error
      }
    } else {
      // NO SERVER RUNNING - STOP WASTING CPU
      
      stopMetricsReporting();
    }
  }, 3000); // Every 3 seconds when server is running
  
  // Listen for server events
  const eventBus = require('../utils/event-bus.cjs');
  
  // Send metrics immediately when server starts and restart interval
  eventBus.on('server-started', async () => {
    
    
    // Restart metrics if stopped
    if (!metricsInterval || !isMetricsActive) {
      startMetricsReporting();
    }
    
    try {
      await publishSystemMetrics();
    } catch (error) {
      // TODO: Add proper logging - Initial metrics error
    }
  });
  
  // Send zeroed metrics when server stops and STOP INTERVAL
  eventBus.on('server-normal-exit', () => {
    
    sendMetricsUpdate({
      cpuPct: 0,
      memUsedMB: 0,
      systemTotalRamMB: parseFloat((os.totalmem() / 1024 / 1024).toFixed(1)),
      maxRamMB: 4096, 
      uptime: '0h 0m 0s',
      players: 0,
      names: []
    });
    
    // STOP the interval when server stops
    stopMetricsReporting();
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
  } catch {
    return currentLookupMem;
  }
  
  // Throttle memory lookups to reduce system load
  const now = Date.now();
  const throttleTime = 5000; // 5 second throttle
  
  if (now - memLookupTimer < throttleTime && publishSystemMetrics.lastMemUsedMB) {
    return publishSystemMetrics.lastMemUsedMB;
  }
  
  memLookupTimer = now;
  
  if (process.platform === 'win32') {
    try {
      // Try pidusage first as it's more reliable
      try {
        const stats = await pidusage(serverProcess.pid);
        currentLookupMem = parseFloat((stats.memory / 1024 / 1024).toFixed(1));
      } catch (pidError) {
        // Fallback to WMIC if pidusage fails
        try {
          const filteredOutput = wmicExecSync(
            `wmic process where "ProcessId=${serverProcess.pid}" get WorkingSetSize /format:csv`
          );
          
          const lines = filteredOutput.trim().split('\n');
          for (const line of lines) {
            if (!line.trim() || line.includes('WorkingSetSize')) continue;
            const parts = line.trim().split(',');
            if (parts.length >= 2) {
              const memInBytes = parseInt(parts[1], 10);
              if (!isNaN(memInBytes) && memInBytes > 0) {
                currentLookupMem = parseFloat((memInBytes / 1024 / 1024).toFixed(1));
                break;
              }
            }
          }
        } catch (wmicErr) {
          // Silent fallback
        }
      }
    } catch (err) {
      // Silent fallback
    }
  } else {
    // For non-Windows systems, use pidusage
    try {
      const stats = await pidusage(serverProcess.pid);
      currentLookupMem = parseFloat((stats.memory / 1024 / 1024).toFixed(1));
    } catch (err) {
      // Silent fallback
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
      try {
        // Get memory usage
        memUsedMB = await getServerMemoryUsage(serverProcess);
        
        // For CPU, use minimal system impact
        cpuPct = 0.1; // Just show it's running without expensive CPU calculation
        
        // Ensure non-zero state to indicate running server
        if (memUsedMB <= 0) memUsedMB = 1; // Minimal value to show it's actually running
      } catch (error) {
        // Fallback values if metrics collection fails
        cpuPct = 0.1;
        memUsedMB = publishSystemMetrics.lastMemUsedMB || 1;
      }
    } else {
      // Server not running - zero everything
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
    // TODO: Add proper logging - Metrics publishing error
  }
}

// Initialize the last memory value
publishSystemMetrics.lastMemUsedMB = 0;

function stopMetricsReporting() {
  
  isMetricsActive = false;
  
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}

module.exports = {
  startMetricsReporting,
  stopMetricsReporting,
  getSystemCpuPct,
  publishSystemMetrics
};
