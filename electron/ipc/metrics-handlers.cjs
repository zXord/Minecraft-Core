// System metrics IPC handlers
const os = require('os');
const { performance } = require('perf_hooks');
const { getLoggerHandlers } = require('./logger-handlers.cjs');

const logger = getLoggerHandlers();

/**
 * Enhanced CPU usage calculator with accurate measurement and error handling
 * Supports both system-wide and process-specific CPU monitoring
 */
class CPUUsageCalculator {
  constructor() {
    this.previousCPUInfo = null;
    this.lastCalculationTime = null;
    this.calculationCount = 0;
    this.errorCount = 0;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
    this.lastValidUsage = null;
    this.fallbackUsage = 0;
    this.isHealthy = true;
    this.healthCheckInterval = null;
    
    // Process-specific CPU monitoring
    this.previousProcessCPU = null;
    this.lastProcessCalculationTime = null;
    this.processCalculationCount = 0;
    this.lastValidProcessUsage = null;
    
    // Start health monitoring
    this.startHealthMonitoring();
    
    logger.debug('CPUUsageCalculator initialized', {
      category: 'performance',
      data: {
        class: 'CPUUsageCalculator',
        function: 'constructor',
        platform: process.platform,
        cpuCount: os.cpus().length,
        maxConsecutiveErrors: this.maxConsecutiveErrors
      }
    });
  }

  /**
   * Gets detailed CPU analysis for debugging Task Manager discrepancies
   * @returns {Promise<Object>} Detailed CPU analysis
   */
  async getDetailedCPUAnalysis() {
    return new Promise((resolve) => {
      const startCPUs = os.cpus();
      const startTime = Date.now();
      
      setTimeout(() => {
        const endCPUs = os.cpus();
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        let totalIdle = 0;
        let totalNonIdle = 0;
        let totalUser = 0;
        let totalSys = 0;
        let coreDetails = [];
        
        for (let i = 0; i < startCPUs.length; i++) {
          const startCpu = startCPUs[i];
          const endCpu = endCPUs[i];
          
          if (!startCpu || !endCpu || !startCpu.times || !endCpu.times) {
            continue;
          }
          
          const userDiff = endCpu.times.user - startCpu.times.user;
          const niceDiff = endCpu.times.nice - startCpu.times.nice;
          const sysDiff = endCpu.times.sys - startCpu.times.sys;
          const idleDiff = endCpu.times.idle - startCpu.times.idle;
          const irqDiff = endCpu.times.irq - startCpu.times.irq;
          
          const totalDiff = userDiff + niceDiff + sysDiff + idleDiff + irqDiff;
          const nonIdleDiff = userDiff + niceDiff + sysDiff + irqDiff;
          
          const coreUsage = totalDiff > 0 ? (nonIdleDiff / totalDiff) * 100 : 0;
          
          coreDetails.push({
            core: i,
            usage: coreUsage,
            userDiff,
            sysDiff,
            niceDiff,
            idleDiff,
            irqDiff,
            totalDiff,
            nonIdleDiff
          });
          
          totalIdle += idleDiff;
          totalNonIdle += nonIdleDiff;
          totalUser += userDiff;
          totalSys += sysDiff;
        }
        
        const totalTime = totalIdle + totalNonIdle;
        const overallUsage = totalTime > 0 ? (totalNonIdle / totalTime) * 100 : 0;
        const userUsage = totalTime > 0 ? (totalUser / totalTime) * 100 : 0;
        const sysUsage = totalTime > 0 ? (totalSys / totalTime) * 100 : 0;
        
        const analysis = {
          overallUsage: Math.max(0, Math.min(100, overallUsage)),
          userUsage: Math.max(0, Math.min(100, userUsage)),
          sysUsage: Math.max(0, Math.min(100, sysUsage)),
          duration,
          coreCount: startCPUs.length,
          validCores: coreDetails.length,
          totalTime,
          totalIdle,
          totalNonIdle,
          totalUser,
          totalSys,
          coreDetails,
          timestamp: new Date().toISOString(),
          platform: process.platform,
          // Additional calculations for comparison
          alternativeCalculations: {
            // Method 1: Average of all cores
            avgCoreUsage: coreDetails.length > 0 ? 
              coreDetails.reduce((sum, core) => sum + core.usage, 0) / coreDetails.length : 0,
            // Method 2: User + System only
            userSysOnly: userUsage + sysUsage,
            // Method 3: Weighted by core activity
            weightedUsage: coreDetails.length > 0 ? 
              coreDetails.reduce((sum, core) => sum + (core.usage * core.totalDiff), 0) / 
              coreDetails.reduce((sum, core) => sum + core.totalDiff, 1) : 0
          }
        };
        
        resolve(analysis);
      }, 1000);
    });
  }

  /**
   * Gets process-specific CPU usage for the current Node.js process
   * @returns {Promise<number>} Process CPU usage percentage (0-100)
   */
  async getProcessCPUUsage() {
    // Simple fallback - return 0 for now to prevent app freezing
    // This will be improved later
    return 0;
  }

  /**
   * Gets both system-wide and process-specific CPU usage
   * @returns {Promise<Object>} Object with system and process CPU usage
   */
  async getDualCPUUsage() {
    try {
      // For now, just get system usage and set process to 0 to prevent freezing
      const systemUsage = await this.calculateCPUUsage();
      const processUsage = 0; // Simplified for stability
      
      return {
        system: systemUsage,
        process: processUsage,
        timestamp: Date.now(),
        cores: os.cpus().length
      };
    } catch (error) {
      logger.error(`Dual CPU usage calculation failed: ${error.message}`, {
        category: 'performance',
        data: {
          class: 'CPUUsageCalculator',
          function: 'getDualCPUUsage',
          errorType: error.constructor.name
        }
      });
      
      return {
        system: this.lastValidUsage || 0,
        process: 0,
        timestamp: Date.now(),
        cores: os.cpus().length,
        error: error.message
      };
    }
  }

  /**
   * Gets a quick CPU usage reading using the same standard method
   * @returns {Promise<number>} CPU usage percentage (0-100)
   */
  async getQuickCPUUsage() {
    return new Promise((resolve) => {
      const startCPUs = os.cpus();
      
      setTimeout(() => {
        const endCPUs = os.cpus();
        
        let totalIdle = 0;
        let totalTick = 0;
        
        for (let i = 0; i < startCPUs.length; i++) {
          const startCpu = startCPUs[i];
          const endCpu = endCPUs[i];
          
          if (!startCpu || !endCpu || !startCpu.times || !endCpu.times) {
            continue;
          }
          
          const idle = endCpu.times.idle - startCpu.times.idle;
          const user = endCpu.times.user - startCpu.times.user;
          const nice = endCpu.times.nice - startCpu.times.nice;
          const sys = endCpu.times.sys - startCpu.times.sys;
          const irq = endCpu.times.irq - startCpu.times.irq;
          
          const total = idle + user + nice + sys + irq;
          
          if (total > 0 && idle >= 0) {
            totalIdle += idle;
            totalTick += total;
          }
        }
        
        const usage = totalTick > 0 ? 100 - (totalIdle / totalTick * 100) : 0;
        
        resolve(Math.max(0, Math.min(100, usage)));
      }, 1000); // 1 second measurement period
    });
  }

  /**
   * Calculates current CPU usage percentage with proper error handling
   * @returns {Promise<number>} CPU usage percentage (0-100)
   */
  async calculateCPUUsage() {
    const startTime = performance.now();
    
    try {
      const currentCPUs = os.cpus();
      const currentTime = performance.now();
      
      // Validate CPU data
      if (!currentCPUs || !Array.isArray(currentCPUs) || currentCPUs.length === 0) {
        throw new Error('Invalid CPU data from os.cpus()');
      }

      // First calculation - store baseline and return 0
      if (!this.previousCPUInfo || !this.lastCalculationTime) {
        logger.debug('First CPU calculation, establishing baseline', {
          category: 'performance',
          data: {
            class: 'CPUUsageCalculator',
            function: 'calculateCPUUsage',
            cpuCount: currentCPUs.length,
            isBaseline: true
          }
        });
        
        this.previousCPUInfo = currentCPUs;
        this.lastCalculationTime = currentTime;
        this.calculationCount++;
        return 0;
      }
      
      // Ensure we have enough time between calculations for accuracy
      const timeDiff = currentTime - this.lastCalculationTime;
      if (timeDiff < 100) { // Less than 100ms
        logger.debug('CPU calculation too soon, using previous baseline', {
          category: 'performance',
          data: {
            class: 'CPUUsageCalculator',
            function: 'calculateCPUUsage',
            timeDiff,
            minTimeDiff: 100
          }
        });
        return 0; // Return 0 for too-frequent calls
      }

      // Simple and accurate CPU calculation that matches Task Manager
      let totalIdle = 0;
      let totalTick = 0;
      let validCores = 0;

      // Calculate CPU usage using the standard method
      for (let i = 0; i < currentCPUs.length; i++) {
        const cpu = currentCPUs[i];
        const prevCpu = this.previousCPUInfo[i];
        
        // Validate CPU core data
        if (!cpu || !cpu.times || !prevCpu || !prevCpu.times) {
          continue;
        }

        // Calculate tick differences for this core
        const idle = cpu.times.idle - prevCpu.times.idle;
        const user = cpu.times.user - prevCpu.times.user;
        const nice = cpu.times.nice - prevCpu.times.nice;
        const sys = cpu.times.sys - prevCpu.times.sys;
        const irq = cpu.times.irq - prevCpu.times.irq;
        
        const total = idle + user + nice + sys + irq;
        
        // Validate differences
        if (total <= 0 || idle < 0) {
          continue;
        }

        totalIdle += idle;
        totalTick += total;
        validCores++;
      }

      // Store current values for next calculation
      this.previousCPUInfo = currentCPUs;
      this.lastCalculationTime = currentTime;
      this.calculationCount++;

      // Validate we have enough valid cores
      if (validCores === 0 || totalTick === 0) {
        return 0;
      }

      // Calculate CPU usage percentage - standard formula
      const usage = 100 - (totalIdle / totalTick * 100);
      const validatedUsage = Math.max(0, Math.min(100, usage));
      
      const calculationTime = performance.now() - startTime;
      
      // Log calculation details (only occasionally to avoid spam)
      if (this.calculationCount % 50 === 0 || validatedUsage !== usage) {
        logger.info('CPU usage calculated', {
          category: 'performance',
          data: {
            class: 'CPUUsageCalculator',
            function: 'calculateCPUUsage',
            usage: validatedUsage,
            rawUsage: usage,
            validCores,
            totalCores: currentCPUs.length,
            calculationTime: calculationTime.toFixed(2),
            calculationCount: this.calculationCount,
            wasValidated: validatedUsage !== usage,
            algorithm: 'optimized'
          }
        });
      }
      
      // Reset error counts on successful calculation
      this.errorCount = 0;
      this.consecutiveErrors = 0;
      this.lastValidUsage = validatedUsage;
      this.isHealthy = true;
      
      return validatedUsage;
      
    } catch (error) {
      this.errorCount++;
      this.consecutiveErrors++;
      const calculationTime = performance.now() - startTime;
      
      // Check if we should mark as unhealthy
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.isHealthy = false;
        logger.warn('CPU calculator marked as unhealthy due to consecutive errors', {
          category: 'performance',
          data: {
            class: 'CPUUsageCalculator',
            function: 'calculateCPUUsage',
            consecutiveErrors: this.consecutiveErrors,
            maxConsecutiveErrors: this.maxConsecutiveErrors,
            lastValidUsage: this.lastValidUsage
          }
        });
      }
      
      logger.error(`CPU usage calculation failed: ${error.message}`, {
        category: 'performance',
        data: {
          class: 'CPUUsageCalculator',
          function: 'calculateCPUUsage',
          errorType: error.constructor.name,
          errorCount: this.errorCount,
          consecutiveErrors: this.consecutiveErrors,
          calculationCount: this.calculationCount,
          calculationTime: calculationTime.toFixed(2),
          platform: process.platform,
          cpuCount: os.cpus().length,
          isHealthy: this.isHealthy
        }
      });
      
      // Return fallback value if we have too many consecutive errors
      if (this.consecutiveErrors >= this.maxConsecutiveErrors && this.lastValidUsage !== null) {
        logger.info('Using fallback CPU usage due to consecutive errors', {
          category: 'performance',
          data: {
            class: 'CPUUsageCalculator',
            function: 'calculateCPUUsage',
            fallbackUsage: this.lastValidUsage,
            consecutiveErrors: this.consecutiveErrors
          }
        });
        return this.lastValidUsage;
      }
      
      throw new Error(`CPU calculation failed: ${error.message}`);
    }
  }

  /**
   * Gets calculator statistics for debugging
   * @returns {Object} Calculator statistics
   */
  getStats() {
    return {
      calculationCount: this.calculationCount,
      errorCount: this.errorCount,
      consecutiveErrors: this.consecutiveErrors,
      maxConsecutiveErrors: this.maxConsecutiveErrors,
      hasBaseline: !!(this.previousCPUInfo && this.lastCalculationTime),
      lastCalculationTime: this.lastCalculationTime,
      lastValidUsage: this.lastValidUsage,
      fallbackUsage: this.fallbackUsage,
      isHealthy: this.isHealthy,
      hasHealthMonitoring: !!this.healthCheckInterval,
      cpuCores: os.cpus().length,
      platform: process.platform,
      errorRate: this.calculationCount > 0 ? (this.errorCount / this.calculationCount * 100).toFixed(2) + '%' : '0%'
    };
  }

  /**
   * Starts health monitoring to automatically recover from errors
   */
  startHealthMonitoring() {
    // Clear any existing interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    // Check health every 30 seconds
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 30000);
    
    logger.debug('CPU calculator health monitoring started', {
      category: 'performance',
      data: {
        class: 'CPUUsageCalculator',
        function: 'startHealthMonitoring',
        intervalMs: 30000
      }
    });
  }
  
  /**
   * Stops health monitoring
   */
  stopHealthMonitoring() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      
      logger.debug('CPU calculator health monitoring stopped', {
        category: 'performance',
        data: {
          class: 'CPUUsageCalculator',
          function: 'stopHealthMonitoring'
        }
      });
    }
  }
  
  /**
   * Performs a health check and attempts recovery if needed
   */
  performHealthCheck() {
    const stats = this.getStats();
    
    // If we're unhealthy and haven't had a successful calculation recently, try to recover
    if (!this.isHealthy && this.consecutiveErrors >= this.maxConsecutiveErrors) {
      logger.info('Attempting CPU calculator recovery', {
        category: 'performance',
        data: {
          class: 'CPUUsageCalculator',
          function: 'performHealthCheck',
          stats,
          attemptingRecovery: true
        }
      });
      
      // Reset state to attempt recovery
      this.reset();
      
      // Try a test calculation
      this.calculateCPUUsage().then(usage => {
        logger.info('CPU calculator recovery successful', {
          category: 'performance',
          data: {
            class: 'CPUUsageCalculator',
            function: 'performHealthCheck',
            recoveryUsage: usage,
            isHealthy: this.isHealthy
          }
        });
      }).catch(error => {
        logger.warn('CPU calculator recovery failed', {
          category: 'performance',
          data: {
            class: 'CPUUsageCalculator',
            function: 'performHealthCheck',
            recoveryError: error.message,
            errorType: error.constructor.name
          }
        });
      });
    }
    
    // Log health status periodically
    if (this.calculationCount % 100 === 0 && this.calculationCount > 0) {
      logger.info('CPU calculator health status', {
        category: 'performance',
        data: {
          class: 'CPUUsageCalculator',
          function: 'performHealthCheck',
          stats,
          isHealthy: this.isHealthy
        }
      });
    }
  }
  
  /**
   * Validates CPU usage bounds and provides fallback
   * @param {number} usage - Raw CPU usage value
   * @returns {number} Validated CPU usage (0-100)
   */
  validateUsageBounds(usage) {
    if (typeof usage !== 'number' || isNaN(usage)) {
      logger.warn('Invalid CPU usage type, using fallback', {
        category: 'performance',
        data: {
          class: 'CPUUsageCalculator',
          function: 'validateUsageBounds',
          invalidUsage: usage,
          usageType: typeof usage,
          fallback: this.fallbackUsage
        }
      });
      return this.fallbackUsage;
    }
    
    // Check for unrealistic values
    if (usage < 0 || usage > 100) {
      const clampedUsage = Math.max(0, Math.min(100, usage));
      logger.warn('CPU usage out of bounds, clamping value', {
        category: 'performance',
        data: {
          class: 'CPUUsageCalculator',
          function: 'validateUsageBounds',
          originalUsage: usage,
          clampedUsage,
          wasOutOfBounds: true
        }
      });
      return clampedUsage;
    }
    
    return usage;
  }
  
  /**
   * Resets the calculator state (useful for testing or recovery)
   */
  reset() {
    const previousStats = this.getStats();
    
    logger.info('Resetting CPU usage calculator', {
      category: 'performance',
      data: {
        class: 'CPUUsageCalculator',
        function: 'reset',
        previousStats
      }
    });
    
    this.previousCPUInfo = null;
    this.lastCalculationTime = null;
    this.calculationCount = 0;
    this.errorCount = 0;
    this.consecutiveErrors = 0;
    this.lastValidUsage = null;
    this.isHealthy = true;
  }
  
  /**
   * Cleanup method to stop monitoring and clear resources
   */
  cleanup() {
    this.stopHealthMonitoring();
    
    logger.info('CPU usage calculator cleaned up', {
      category: 'performance',
      data: {
        class: 'CPUUsageCalculator',
        function: 'cleanup',
        finalStats: this.getStats()
      }
    });
  }
}

// Create a singleton CPU calculator instance
const cpuCalculator = new CPUUsageCalculator();

/**
 * IPC handler for getting detailed CPU analysis
 * @param {Electron.IpcMainInvokeEvent} event - IPC event
 * @returns {Promise<Object>} Detailed CPU analysis
 */
async function getDetailedCPUAnalysis(event) {
  const startTime = performance.now();
  
  try {
    logger.debug('Detailed CPU analysis requested via IPC', {
      category: 'performance',
      data: {
        handler: 'getDetailedCPUAnalysis',
        senderId: event.sender.id
      }
    });

    const analysis = await cpuCalculator.getDetailedCPUAnalysis();
    const handlerTime = performance.now() - startTime;
    
    logger.info('Detailed CPU analysis completed', {
      category: 'performance',
      data: {
        handler: 'getDetailedCPUAnalysis',
        overallUsage: analysis.overallUsage,
        userUsage: analysis.userUsage,
        sysUsage: analysis.sysUsage,
        avgCoreUsage: analysis.alternativeCalculations.avgCoreUsage,
        handlerTime: handlerTime.toFixed(2),
        senderId: event.sender.id,
        coreCount: analysis.coreCount
      }
    });
    
    return analysis;
  } catch (error) {
    const handlerTime = performance.now() - startTime;
    
    logger.error(`Detailed CPU analysis failed: ${error.message}`, {
      category: 'performance',
      data: {
        handler: 'getDetailedCPUAnalysis',
        errorType: error.constructor.name,
        handlerTime: handlerTime.toFixed(2),
        senderId: event.sender.id
      }
    });
    
    throw error;
  }
}

/**
 * IPC handler for getting quick CPU usage (for testing/comparison)
 * @param {Electron.IpcMainInvokeEvent} event - IPC event
 * @returns {Promise<number>} CPU usage percentage
 */
async function getQuickCPUUsage(event) {
  const startTime = performance.now();
  
  try {
    logger.debug('Quick CPU usage requested via IPC', {
      category: 'performance',
      data: {
        handler: 'getQuickCPUUsage',
        senderId: event.sender.id
      }
    });

    const usage = await cpuCalculator.getQuickCPUUsage();
    const handlerTime = performance.now() - startTime;
    
    logger.info('Quick CPU usage completed', {
      category: 'performance',
      data: {
        handler: 'getQuickCPUUsage',
        usage,
        usageFormatted: `${usage.toFixed(1)}%`,
        handlerTime: handlerTime.toFixed(2),
        senderId: event.sender.id,
        method: 'quick'
      }
    });
    
    return usage;
  } catch (error) {
    const handlerTime = performance.now() - startTime;
    
    logger.error(`Quick CPU usage IPC handler failed: ${error.message}`, {
      category: 'performance',
      data: {
        handler: 'getQuickCPUUsage',
        errorType: error.constructor.name,
        handlerTime: handlerTime.toFixed(2),
        senderId: event.sender.id
      }
    });
    
    throw error;
  }
}

/**
 * IPC handler for getting dual CPU usage (system + process)
 * @param {Electron.IpcMainInvokeEvent} event - IPC event
 * @returns {Promise<Object>} Object with system and process CPU usage
 */
async function getDualCPUUsage(event) {
  const startTime = performance.now();
  
  try {
    const shouldLog = (cpuCalculator.calculationCount % 20) === 0;
    
    if (shouldLog) {
      logger.debug('Dual CPU usage requested via IPC', {
        category: 'performance',
        data: {
          handler: 'getDualCPUUsage',
          senderId: event.sender.id
        }
      });
    }

    const dualUsage = await cpuCalculator.getDualCPUUsage();
    const handlerTime = performance.now() - startTime;
    
    if (shouldLog) {
      logger.debug('Dual CPU usage IPC request completed', {
        category: 'performance',
        data: {
          handler: 'getDualCPUUsage',
          systemUsage: dualUsage.system,
          processUsage: dualUsage.process,
          handlerTime: handlerTime.toFixed(2),
          senderId: event.sender.id
        }
      });
    }
    
    return dualUsage;
  } catch (error) {
    const handlerTime = performance.now() - startTime;
    
    logger.error(`Dual CPU usage IPC handler failed: ${error.message}`, {
      category: 'performance',
      data: {
        handler: 'getDualCPUUsage',
        errorType: error.constructor.name,
        handlerTime: handlerTime.toFixed(2),
        senderId: event.sender.id
      }
    });
    
    throw error;
  }
}

/**
 * IPC handler for getting CPU usage (legacy - system only)
 * @param {Electron.IpcMainInvokeEvent} event - IPC event
 * @returns {Promise<number>} CPU usage percentage
 */
async function getCPUUsage(event) {
  const startTime = performance.now();
  
  try {
    // Throttle debug logging to reduce overhead
    const shouldLog = (cpuCalculator.calculationCount % 20) === 0;
    
    if (shouldLog) {
      logger.debug('CPU usage requested via IPC', {
        category: 'performance',
        data: {
          handler: 'getCPUUsage',
          senderId: event.sender.id,
          calculationCount: cpuCalculator.calculationCount
        }
      });
    }

    const usage = await cpuCalculator.calculateCPUUsage();
    const handlerTime = performance.now() - startTime;
    
    if (shouldLog) {
      logger.debug('CPU usage IPC request completed', {
        category: 'performance',
        data: {
          handler: 'getCPUUsage',
          usage,
          handlerTime: handlerTime.toFixed(2),
          senderId: event.sender.id
        }
      });
    }
    
    return usage;
  } catch (error) {
    const handlerTime = performance.now() - startTime;
    
    logger.error(`CPU usage IPC handler failed: ${error.message}`, {
      category: 'performance',
      data: {
        handler: 'getCPUUsage',
        errorType: error.constructor.name,
        handlerTime: handlerTime.toFixed(2),
        senderId: event.sender.id,
        calculatorStats: cpuCalculator.getStats()
      }
    });
    
    throw error;
  }
}

/**
 * IPC handler for getting CPU calculator statistics
 * @param {Electron.IpcMainInvokeEvent} event - IPC event
 * @returns {Object} Calculator statistics
 */
function getCPUStats(event) {
  try {
    const stats = cpuCalculator.getStats();
    
    logger.debug('CPU stats requested via IPC', {
      category: 'performance',
      data: {
        handler: 'getCPUStats',
        senderId: event.sender.id,
        stats
      }
    });
    
    return stats;
  } catch (error) {
    logger.error(`CPU stats IPC handler failed: ${error.message}`, {
      category: 'performance',
      data: {
        handler: 'getCPUStats',
        errorType: error.constructor.name,
        senderId: event.sender.id
      }
    });
    
    throw error;
  }
}

/**
 * IPC handler for resetting CPU calculator
 * @param {Electron.IpcMainInvokeEvent} event - IPC event
 * @returns {boolean} Success status
 */
function resetCPUCalculator(event) {
  try {
    logger.info('CPU calculator reset requested via IPC', {
      category: 'performance',
      data: {
        handler: 'resetCPUCalculator',
        senderId: event.sender.id,
        previousStats: cpuCalculator.getStats()
      }
    });
    
    cpuCalculator.reset();
    
    return true;
  } catch (error) {
    logger.error(`CPU calculator reset failed: ${error.message}`, {
      category: 'performance',
      data: {
        handler: 'resetCPUCalculator',
        errorType: error.constructor.name,
        senderId: event.sender.id
      }
    });
    
    throw error;
  }
}

/**
 * IPC handler for getting CPU calculator health status
 * @param {Electron.IpcMainInvokeEvent} event - IPC event
 * @returns {Object} Health status information
 */
function getCPUHealth(event) {
  try {
    const stats = cpuCalculator.getStats();
    const healthStatus = {
      isHealthy: cpuCalculator.isHealthy,
      consecutiveErrors: cpuCalculator.consecutiveErrors,
      errorRate: stats.errorRate,
      lastValidUsage: cpuCalculator.lastValidUsage,
      hasBaseline: stats.hasBaseline,
      uptime: cpuCalculator.lastCalculationTime ? Date.now() - cpuCalculator.lastCalculationTime : null,
      recommendations: []
    };
    
    // Add recommendations based on health status
    if (!healthStatus.isHealthy) {
      healthStatus.recommendations.push('CPU calculator is unhealthy - consider resetting');
    }
    if (healthStatus.consecutiveErrors > 0) {
      healthStatus.recommendations.push(`${healthStatus.consecutiveErrors} consecutive errors detected`);
    }
    if (!healthStatus.hasBaseline) {
      healthStatus.recommendations.push('No baseline established - first calculation needed');
    }
    
    logger.debug('CPU health status requested via IPC', {
      category: 'performance',
      data: {
        handler: 'getCPUHealth',
        senderId: event.sender.id,
        healthStatus
      }
    });
    
    return healthStatus;
  } catch (error) {
    logger.error(`CPU health status request failed: ${error.message}`, {
      category: 'performance',
      data: {
        handler: 'getCPUHealth',
        errorType: error.constructor.name,
        senderId: event.sender.id
      }
    });
    
    throw error;
  }
}

/**
 * IPC handler for performing manual health check
 * @param {Electron.IpcMainInvokeEvent} event - IPC event
 * @returns {Object} Health check results
 */
function performCPUHealthCheck(event) {
  try {
    logger.info('Manual CPU health check requested via IPC', {
      category: 'performance',
      data: {
        handler: 'performCPUHealthCheck',
        senderId: event.sender.id,
        currentStats: cpuCalculator.getStats()
      }
    });
    
    cpuCalculator.performHealthCheck();
    
    const results = {
      timestamp: Date.now(),
      healthCheckPerformed: true,
      newStats: cpuCalculator.getStats(),
      isHealthy: cpuCalculator.isHealthy
    };
    
    return results;
  } catch (error) {
    logger.error(`CPU health check failed: ${error.message}`, {
      category: 'performance',
      data: {
        handler: 'performCPUHealthCheck',
        errorType: error.constructor.name,
        senderId: event.sender.id
      }
    });
    
    throw error;
  }
}

/**
 * Creates and returns metrics IPC handlers
 * @returns {Object} Object containing IPC handler functions
 */
function createMetricsHandlers() {
  logger.info('Metrics handlers initialized', {
    category: 'performance',
    data: {
      handler: 'createMetricsHandlers',
      cpuCores: os.cpus().length,
      platform: process.platform,
      calculatorStats: cpuCalculator.getStats()
    }
  });

  return {
    'get-cpu-usage': getCPUUsage,
    'get-dual-cpu-usage': getDualCPUUsage,
    'get-quick-cpu-usage': getQuickCPUUsage,
    'get-detailed-cpu-analysis': getDetailedCPUAnalysis,
    'get-cpu-stats': getCPUStats,
    'get-cpu-health': getCPUHealth,
    'perform-cpu-health-check': performCPUHealthCheck,
    'reset-cpu-calculator': resetCPUCalculator
  };
}

// Cleanup on process exit
process.on('exit', () => {
  cpuCalculator.cleanup();
});

process.on('SIGINT', () => {
  cpuCalculator.cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cpuCalculator.cleanup();
  process.exit(0);
});

module.exports = { 
  createMetricsHandlers,
  CPUUsageCalculator // Export class for testing
};