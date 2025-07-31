/**
 * Enhanced CPU monitoring utility for accurate CPU usage calculation and history tracking
 * Provides verification, error handling, and fallback mechanisms for CPU monitoring
 */

import { safeInvoke } from '../ipcUtils.js';
import logger from '../logger.js';

export class CPUMonitor {
  constructor() {
    this.history = [];
    this.maxHistoryLength = 60; // Keep 1 hour of data (1 point per minute)
    this.updateInterval = null;
    this.isMonitoring = false;
    this.lastValidUsage = null;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 5;
    
    // Performance optimizations
    this._usageCache = null;
    this._cacheTimestamp = 0;
    this._cacheValidityMs = 5000; // Cache CPU readings for 5 seconds
    this._batchUpdateQueue = [];
    this._batchUpdateTimer = null;
    this._batchUpdateInterval = 1000; // Batch updates every second
    this._logThrottle = 0;
    this._logThrottleInterval = 10; // Log every 10th operation
    
    // Pre-allocate arrays for better performance
    this._tempHistoryArray = new Array(this.maxHistoryLength);
    
    // Only log initialization once
    logger.debug('CPUMonitor initialized with performance optimizations', {
      category: 'performance',
      data: {
        class: 'CPUMonitor',
        maxHistoryLength: this.maxHistoryLength,
        cacheValidityMs: this._cacheValidityMs
      }
    });
  }

  /**
   * Gets detailed CPU analysis for debugging Task Manager discrepancies
   * @returns {Promise<Object|null>} Detailed CPU analysis or null if failed
   */
  async getDetailedCPUAnalysis() {
    try {
      logger.debug('Requesting detailed CPU analysis from backend', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getDetailedCPUAnalysis'
        }
      });

      const analysis = await safeInvoke('get-detailed-cpu-analysis');
      
      if (!analysis || typeof analysis !== 'object') {
        throw new Error(`Invalid detailed CPU analysis data received: ${analysis}`);
      }
      
      logger.info('Detailed CPU analysis retrieved', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getDetailedCPUAnalysis',
          overallUsage: analysis.overallUsage,
          userUsage: analysis.userUsage,
          sysUsage: analysis.sysUsage,
          avgCoreUsage: analysis.alternativeCalculations?.avgCoreUsage,
          coreCount: analysis.coreCount,
          platform: analysis.platform
        }
      });
      
      return analysis;
    } catch (error) {
      logger.error(`Failed to get detailed CPU analysis: ${error.message}`, {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getDetailedCPUAnalysis',
          errorType: error.constructor.name
        }
      });
      
      return null;
    }
  }

  /**
   * Gets a quick CPU usage reading for comparison with Task Manager
   * @returns {Promise<number|null>} CPU usage percentage (0-100) or null if failed
   */
  async getQuickCPUUsage() {
    try {
      logger.debug('Requesting quick CPU usage from backend', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getQuickCPUUsage'
        }
      });

      const usage = await safeInvoke('get-quick-cpu-usage');
      
      if (typeof usage !== 'number' || isNaN(usage)) {
        throw new Error(`Invalid quick CPU usage data received: ${usage} (type: ${typeof usage})`);
      }
      
      const validatedUsage = Math.max(0, Math.min(100, usage));
      
      logger.info('Quick CPU usage retrieved', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getQuickCPUUsage',
          usage: validatedUsage,
          usageFormatted: `${validatedUsage.toFixed(1)}%`,
          method: 'quick'
        }
      });
      
      return validatedUsage;
    } catch (error) {
      logger.error(`Failed to get quick CPU usage: ${error.message}`, {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getQuickCPUUsage',
          errorType: error.constructor.name
        }
      });
      
      return null;
    }
  }

  /**
   * Gets dual CPU usage (system-wide and process-specific) with caching
   * @returns {Promise<Object|null>} Object with system and process CPU usage or null if failed
   */
  async getDualCPUUsage() {
    try {
      // Performance optimization: Check cache first
      const now = Date.now();
      if (this._usageCache !== null && (now - this._cacheTimestamp) < this._cacheValidityMs) {
        return this._usageCache;
      }

      // Throttle debug logging to reduce overhead
      const shouldLog = (this._logThrottle++ % this._logThrottleInterval) === 0;
      
      if (shouldLog) {
        logger.debug('Requesting dual CPU usage from backend (cache miss)', {
          category: 'performance',
          data: {
            class: 'CPUMonitor',
            function: 'getDualCPUUsage',
            consecutiveErrors: this.consecutiveErrors,
            cacheAge: now - this._cacheTimestamp
          }
        });
      }

      const dualUsage = await safeInvoke('get-dual-cpu-usage');
      
      // Validate the received usage data
      if (!dualUsage || typeof dualUsage !== 'object') {
        throw new Error(`Invalid dual CPU usage data received: ${dualUsage}`);
      }
      
      if (typeof dualUsage.system !== 'number' || isNaN(dualUsage.system) ||
          typeof dualUsage.process !== 'number' || isNaN(dualUsage.process)) {
        throw new Error(`Invalid CPU usage numbers: system=${dualUsage.system}, process=${dualUsage.process}`);
      }
      
      // Ensure usage is within valid range (0-100%)
      const validatedUsage = {
        system: Math.max(0, Math.min(100, dualUsage.system)),
        process: Math.max(0, Math.min(100, dualUsage.process)),
        timestamp: dualUsage.timestamp || now,
        cores: dualUsage.cores || 1
      };
      
      // Reset error counter on successful reading
      this.consecutiveErrors = 0;
      this.lastValidUsage = validatedUsage.system; // Keep for backward compatibility
      
      // Update cache
      this._usageCache = validatedUsage;
      this._cacheTimestamp = now;
      
      if (shouldLog) {
        logger.debug('Dual CPU usage retrieved and cached', {
          category: 'performance',
          data: {
            class: 'CPUMonitor',
            function: 'getDualCPUUsage',
            systemUsage: validatedUsage.system,
            processUsage: validatedUsage.process,
            cached: true
          }
        });
      }
      
      return validatedUsage;
    } catch (error) {
      this.consecutiveErrors++;
      
      // Only log errors occasionally to reduce spam
      const shouldLogError = this.consecutiveErrors <= 3 || (this.consecutiveErrors % 5) === 0;
      
      if (shouldLogError) {
        logger.error(`Failed to get dual CPU usage: ${error.message}`, {
          category: 'performance',
          data: {
            class: 'CPUMonitor',
            function: 'getDualCPUUsage',
            errorType: error.constructor.name,
            consecutiveErrors: this.consecutiveErrors,
            maxConsecutiveErrors: this.maxConsecutiveErrors,
            hasLastValidUsage: this.lastValidUsage !== null
          }
        });
      }
      
      // Check backend health if we have consecutive errors (but only occasionally)
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        if ((this.consecutiveErrors % this.maxConsecutiveErrors) === 0) {
          logger.warn('Too many consecutive CPU usage errors, checking backend health', {
            category: 'performance',
            data: {
              class: 'CPUMonitor',
              function: 'getDualCPUUsage',
              consecutiveErrors: this.consecutiveErrors,
              fallbackValue: this.lastValidUsage || 0
            }
          });
          
          // Try to get health status and potentially trigger recovery (async, don't wait)
          this._performHealthCheckAsync();
        }
        
        // Always return fallback data instead of null to prevent monitoring failure
        return {
          system: this.lastValidUsage || 0,
          process: 0,
          timestamp: Date.now(),
          cores: 1,
          fallback: true,
          error: error.message
        };
      }
      
      // For fewer errors, still return fallback instead of null
      return {
        system: this.lastValidUsage || 0,
        process: 0,
        timestamp: Date.now(),
        cores: 1,
        fallback: true,
        error: error.message
      };
    }
  }

  /**
   * Gets current CPU usage with caching and optimized error handling (legacy method)
   * Returns system CPU usage for backward compatibility
   * @returns {Promise<number|null>} CPU usage percentage (0-100) or null if failed
   */
  async getCurrentCPUUsage() {
    try {
      // Performance optimization: Check cache first
      const now = Date.now();
      if (this._usageCache !== null && (now - this._cacheTimestamp) < this._cacheValidityMs) {
        return typeof this._usageCache === 'object' ? this._usageCache.system : this._usageCache;
      }

      // Use original single CPU usage method for stability
      const usage = await safeInvoke('get-cpu-usage');
      
      // Validate the received usage data
      if (typeof usage !== 'number' || isNaN(usage)) {
        throw new Error(`Invalid CPU usage data received: ${usage} (type: ${typeof usage})`);
      }
      
      // Ensure usage is within valid range (0-100%)
      const validatedUsage = Math.max(0, Math.min(100, usage));
      
      // Reset error counter on successful reading
      this.consecutiveErrors = 0;
      this.lastValidUsage = validatedUsage;
      
      // Update cache
      this._usageCache = validatedUsage;
      this._cacheTimestamp = now;
      
      return validatedUsage;
    } catch (error) {
      this.consecutiveErrors++;
      
      // Only log errors occasionally to reduce spam
      const shouldLogError = this.consecutiveErrors <= 3 || (this.consecutiveErrors % 5) === 0;
      
      if (shouldLogError) {
        logger.error(`Failed to get CPU usage: ${error.message}`, {
          category: 'performance',
          data: {
            class: 'CPUMonitor',
            function: 'getCurrentCPUUsage',
            errorType: error.constructor.name,
            consecutiveErrors: this.consecutiveErrors
          }
        });
      }
      
      // Return fallback instead of null to prevent UI issues
      return this.lastValidUsage || 0;
    }
  }

  /**
   * Performs health check asynchronously without blocking
   * @private
   */
  async _performHealthCheckAsync() {
    try {
      const healthStatus = await safeInvoke('get-cpu-health');
      
      // If backend is unhealthy, trigger a health check
      if (!healthStatus.isHealthy) {
        await safeInvoke('perform-cpu-health-check');
        logger.info('Triggered backend CPU health check for recovery', {
          category: 'performance',
          data: {
            class: 'CPUMonitor',
            function: '_performHealthCheckAsync'
          }
        });
      }
    } catch (healthError) {
      logger.error(`Failed to check backend CPU health: ${healthError.message}`, {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: '_performHealthCheckAsync',
          healthErrorType: healthError.constructor.name
        }
      });
    }
  }

  /**
   * Adds dual CPU usage data to history with optimized batch processing
   * @param {Object|number} usage - Dual CPU usage object or legacy single number
   * @param {number} timestamp - Optional timestamp, defaults to current time
   */
  addToHistory(usage, timestamp = Date.now()) {
    let historyPoint;
    
    // Handle both dual usage object and legacy single number
    if (typeof usage === 'object' && usage !== null) {
      // New dual CPU usage format
      if (typeof usage.system !== 'number' || isNaN(usage.system)) {
        if ((this._logThrottle % (this._logThrottleInterval * 5)) === 0) {
          logger.warn('Invalid dual usage value provided to addToHistory', {
            category: 'performance',
            data: {
              class: 'CPUMonitor',
              function: 'addToHistory',
              usage,
              usageType: typeof usage
            }
          });
        }
        return;
      }
      
      historyPoint = {
        usage: Math.max(0, Math.min(100, usage.system)), // System usage for backward compatibility
        systemUsage: Math.max(0, Math.min(100, usage.system)),
        processUsage: Math.max(0, Math.min(100, usage.process || 0)),
        timestamp: usage.timestamp || timestamp,
        formattedTime: new Date(usage.timestamp || timestamp).toLocaleTimeString(),
        date: new Date(usage.timestamp || timestamp).toDateString(),
        cores: usage.cores || 1,
        isDual: true
      };
    } else if (typeof usage === 'number' && !isNaN(usage)) {
      // Legacy single number format
      historyPoint = {
        usage: Math.max(0, Math.min(100, usage)),
        systemUsage: Math.max(0, Math.min(100, usage)),
        processUsage: 0, // Unknown for legacy format
        timestamp,
        formattedTime: new Date(timestamp).toLocaleTimeString(),
        date: new Date(timestamp).toDateString(),
        cores: 1,
        isDual: false
      };
    } else {
      // Invalid usage data
      if ((this._logThrottle % (this._logThrottleInterval * 5)) === 0) {
        logger.warn('Invalid usage value provided to addToHistory', {
          category: 'performance',
          data: {
            class: 'CPUMonitor',
            function: 'addToHistory',
            usage,
            usageType: typeof usage
          }
        });
      }
      return;
    }

    // Performance optimization: Use efficient array operations
    this.history.push(historyPoint);
    
    // Keep only recent history to prevent memory issues
    if (this.history.length > this.maxHistoryLength) {
      // More efficient than slice - just remove from beginning
      const removeCount = this.history.length - this.maxHistoryLength;
      this.history.splice(0, removeCount);
      
      // Only log trimming occasionally
      if ((this._logThrottle % (this._logThrottleInterval * 2)) === 0) {
        logger.debug('CPU history trimmed to prevent memory issues', {
          category: 'performance',
          data: {
            class: 'CPUMonitor',
            function: 'addToHistory',
            removedCount: removeCount,
            currentHistoryLength: this.history.length,
            maxHistoryLength: this.maxHistoryLength
          }
        });
      }
    }

    // Throttle debug logging significantly
    if ((this._logThrottle % (this._logThrottleInterval * 3)) === 0) {
      logger.debug('CPU usage added to history', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'addToHistory',
          systemUsage: historyPoint.systemUsage,
          processUsage: historyPoint.processUsage,
          historyLength: this.history.length,
          timestamp: historyPoint.formattedTime,
          isDual: historyPoint.isDual
        }
      });
    }
  }

  /**
   * Gets CPU usage history formatted for chart visualization with optimized processing
   * @returns {Array} Array of history points with additional chart metadata
   */
  getHistoryForChart() {
    // Performance optimization: Pre-allocate result array
    const chartData = new Array(this.history.length);
    let highUsageCount = 0;
    let warningUsageCount = 0;
    let normalUsageCount = 0;

    // Single pass through history for better performance
    for (let i = 0; i < this.history.length; i++) {
      const point = this.history[i];
      const isHigh = point.usage > 80;      // Critical usage level
      const isWarning = point.usage > 60;   // Warning usage level
      const isNormal = point.usage <= 60;   // Normal usage level
      
      // Count usage levels efficiently
      if (isHigh) highUsageCount++;
      else if (isWarning) warningUsageCount++;
      else normalUsageCount++;
      
      // Create enhanced tooltip with status information
      const statusText = isHigh ? 'Critical' : isWarning ? 'Warning' : 'Normal';
      const tooltip = `${point.formattedTime}: ${point.usage.toFixed(1)}% CPU (${statusText})`;
      
      chartData[i] = {
        usage: point.usage,
        timestamp: point.timestamp,
        formattedTime: point.formattedTime,
        date: point.date,
        index: i,
        isHigh,
        isWarning,
        isNormal,
        percentage: point.usage,       // Alias for usage for chart compatibility
        tooltip,
        statusText,
        statusClass: statusText.toLowerCase()
      };
    }

    // Only log chart formatting occasionally
    if ((this._logThrottle % (this._logThrottleInterval * 5)) === 0) {
      logger.debug('CPU history formatted for chart', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getHistoryForChart',
          dataPoints: chartData.length,
          highUsagePoints: highUsageCount,
          warningUsagePoints: warningUsageCount,
          normalUsagePoints: normalUsageCount,
          timeSpan: chartData.length > 0 ? {
            start: chartData[0].formattedTime,
            end: chartData[chartData.length - 1].formattedTime
          } : null
        }
      });
    }

    return chartData;
  }

  /**
   * Starts CPU monitoring with optimized periodic updates
   * @param {Function} callback - Callback function called with (usage, history) on each update
   * @param {number} intervalMs - Update interval in milliseconds (default: 60000 = 1 minute)
   */
  startMonitoring(callback, intervalMs = 60000) {
    if (typeof callback !== 'function') {
      logger.error('Invalid callback provided to startMonitoring', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'startMonitoring',
          callbackType: typeof callback
        }
      });
      throw new Error('Callback function is required for CPU monitoring');
    }

    // Stop any existing monitoring
    this.stopMonitoring();

    this.isMonitoring = true;
    
    logger.info('Starting optimized CPU monitoring', {
      category: 'performance',
      data: {
        class: 'CPUMonitor',
        function: 'startMonitoring',
        intervalMs,
        intervalMinutes: intervalMs / 60000,
        cacheValidityMs: this._cacheValidityMs
      }
    });

    // Get initial reading immediately (async, don't block)
    this._getInitialReading(callback);

    // Set up periodic monitoring with optimized error handling
    this.updateInterval = setInterval(async () => {
      if (!this.isMonitoring) {
        this.stopMonitoring();
        return;
      }

      try {
        const usage = await this.getCurrentCPUUsage();
        if (usage !== null) {
          this.addToHistory(usage);
          
          // Use try-catch for callback to prevent monitoring from stopping
          try {
            callback(usage, this.history);
          } catch (callbackError) {
            logger.error(`CPU monitoring callback failed: ${callbackError.message}`, {
              category: 'performance',
              data: {
                class: 'CPUMonitor',
                function: 'startMonitoring.callback',
                errorType: callbackError.constructor.name
              }
            });
          }
        } else {
          // Only log null readings occasionally
          if ((this._logThrottle % (this._logThrottleInterval * 2)) === 0) {
            logger.warn('CPU usage reading returned null, skipping history update', {
              category: 'performance',
              data: {
                class: 'CPUMonitor',
                function: 'startMonitoring.interval',
                consecutiveErrors: this.consecutiveErrors
              }
            });
          }
        }
      } catch (error) {
        // Only log monitoring errors occasionally
        if (this.consecutiveErrors <= 3 || (this.consecutiveErrors % 5) === 0) {
          logger.error(`CPU monitoring update failed: ${error.message}`, {
            category: 'performance',
            data: {
              class: 'CPUMonitor',
              function: 'startMonitoring.interval',
              errorType: error.constructor.name,
              consecutiveErrors: this.consecutiveErrors
            }
          });
        }
      }
    }, intervalMs);

    logger.info('CPU monitoring started successfully with optimizations', {
      category: 'performance',
      data: {
        class: 'CPUMonitor',
        function: 'startMonitoring',
        intervalMs,
        hasInterval: !!this.updateInterval
      }
    });
  }

  /**
   * Gets initial CPU reading asynchronously
   * @private
   * @param {Function} callback - Callback function
   */
  async _getInitialReading(callback) {
    try {
      const usage = await this.getCurrentCPUUsage();
      if (usage !== null) {
        this.addToHistory(usage);
        callback(usage, this.history);
      }
    } catch (error) {
      logger.error(`Initial CPU reading failed: ${error.message}`, {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: '_getInitialReading',
          errorType: error.constructor.name
        }
      });
    }
  }

  /**
   * Stops CPU monitoring and cleans up resources
   */
  stopMonitoring() {
    const wasMonitoring = this.isMonitoring;
    
    this.isMonitoring = false;
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (wasMonitoring) {
      logger.info('CPU monitoring stopped', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'stopMonitoring',
          historyLength: this.history.length,
          lastValidUsage: this.lastValidUsage
        }
      });
    }
  }

  /**
   * Clears CPU usage history and caches
   */
  clearHistory() {
    const previousLength = this.history.length;
    this.history = [];
    
    // Clear performance caches
    this._usageCache = null;
    this._cacheTimestamp = 0;
    this._batchUpdateQueue = [];
    
    if (this._batchUpdateTimer) {
      clearTimeout(this._batchUpdateTimer);
      this._batchUpdateTimer = null;
    }
    
    logger.info('CPU history and caches cleared', {
      category: 'performance',
      data: {
        class: 'CPUMonitor',
        function: 'clearHistory',
        previousLength,
        newLength: this.history.length,
        cachesCleared: true
      }
    });
  }

  /**
   * Optimizes memory usage by cleaning up old data and caches
   */
  optimizeMemoryUsage() {
    const beforeHistoryLength = this.history.length;
    
    // Trim history more aggressively if needed
    if (this.history.length > this.maxHistoryLength * 0.8) {
      const targetLength = Math.floor(this.maxHistoryLength * 0.7);
      const removeCount = this.history.length - targetLength;
      this.history.splice(0, removeCount);
    }
    
    // Clear old cache if it's stale
    const now = Date.now();
    if (this._usageCache !== null && (now - this._cacheTimestamp) > (this._cacheValidityMs * 2)) {
      this._usageCache = null;
      this._cacheTimestamp = 0;
    }
    
    // Clear batch update queue if it's getting large
    if (this._batchUpdateQueue.length > 10) {
      this._batchUpdateQueue = [];
    }
    
    logger.debug('Memory usage optimized', {
      category: 'performance',
      data: {
        class: 'CPUMonitor',
        function: 'optimizeMemoryUsage',
        historyLengthBefore: beforeHistoryLength,
        historyLengthAfter: this.history.length,
        cacheCleared: this._usageCache === null,
        batchQueueCleared: this._batchUpdateQueue.length === 0
      }
    });
  }

  /**
   * Gets current monitoring status and statistics
   * @returns {Object} Status information
   */
  getStatus() {
    const status = {
      isMonitoring: this.isMonitoring,
      historyLength: this.history.length,
      maxHistoryLength: this.maxHistoryLength,
      lastValidUsage: this.lastValidUsage,
      consecutiveErrors: this.consecutiveErrors,
      hasInterval: !!this.updateInterval,
      oldestEntry: this.history.length > 0 ? this.history[0].timestamp : null,
      newestEntry: this.history.length > 0 ? this.history[this.history.length - 1].timestamp : null
    };

    logger.debug('CPU monitor status requested', {
      category: 'performance',
      data: {
        class: 'CPUMonitor',
        function: 'getStatus',
        status
      }
    });

    return status;
  }

  /**
   * Validates CPU usage value and provides fallback if needed
   * @param {any} usage - Usage value to validate
   * @returns {number|null} Validated usage or null if invalid
   */
  static validateUsage(usage) {
    if (typeof usage !== 'number' || isNaN(usage)) {
      return null;
    }
    
    // Clamp to valid range
    return Math.max(0, Math.min(100, usage));
  }

  /**
   * Gets backend CPU calculator health status
   * @returns {Promise<Object|null>} Health status or null if failed
   */
  async getBackendHealth() {
    try {
      const healthStatus = await safeInvoke('get-cpu-health');
      
      logger.debug('Backend CPU health status retrieved', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getBackendHealth',
          healthStatus
        }
      });
      
      return healthStatus;
    } catch (error) {
      logger.error(`Failed to get backend CPU health: ${error.message}`, {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'getBackendHealth',
          errorType: error.constructor.name
        }
      });
      
      return null;
    }
  }

  /**
   * Triggers a manual health check on the backend
   * @returns {Promise<Object|null>} Health check results or null if failed
   */
  async triggerBackendHealthCheck() {
    try {
      const results = await safeInvoke('perform-cpu-health-check');
      
      logger.info('Backend CPU health check triggered', {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'triggerBackendHealthCheck',
          results
        }
      });
      
      return results;
    } catch (error) {
      logger.error(`Failed to trigger backend CPU health check: ${error.message}`, {
        category: 'performance',
        data: {
          class: 'CPUMonitor',
          function: 'triggerBackendHealthCheck',
          errorType: error.constructor.name
        }
      });
      
      return null;
    }
  }

  /**
   * Creates a formatted status message for CPU usage
   * @param {number} usage - CPU usage percentage
   * @returns {Object} Status object with message and level
   */
  static getUsageStatus(usage) {
    if (typeof usage !== 'number' || isNaN(usage)) {
      return {
        level: 'error',
        message: 'CPU usage unavailable',
        color: 'error'
      };
    }

    if (usage > 90) {
      return {
        level: 'critical',
        message: `Critical CPU usage: ${usage.toFixed(1)}%`,
        color: 'critical'
      };
    } else if (usage > 80) {
      return {
        level: 'high',
        message: `High CPU usage: ${usage.toFixed(1)}%`,
        color: 'warning'
      };
    } else if (usage > 60) {
      return {
        level: 'warning',
        message: `Elevated CPU usage: ${usage.toFixed(1)}%`,
        color: 'warning'
      };
    } else {
      return {
        level: 'normal',
        message: `CPU usage: ${usage.toFixed(1)}%`,
        color: 'normal'
      };
    }
  }
}