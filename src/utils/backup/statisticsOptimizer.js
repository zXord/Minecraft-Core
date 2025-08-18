/// <reference path="../../electron.d.ts" />

/**
 * Statistics Performance Optimizer
 * Provides efficient algorithms for backup statistics calculation with caching and background processing
 */

/**
 * Cached statistics calculator with incremental updates
 */
export class CachedStatisticsCalculator {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
    this.incrementalCache = new Map();
    this.backgroundQueue = [];
    this.processing = false;
  }

  /**
   * Calculate statistics with caching and incremental updates
   * @param {Array} backups - Current backups
   * @param {string} serverPath - Server path for cache key
   * @param {Object} options - Calculation options
   * @returns {Promise<Object>} Statistics result
   */
  async calculateStatistics(backups, serverPath, options = {}) {
    const {
      forceRefresh = false,
      useIncremental = true,
      enableBackground = true
    } = options;

    const cacheKey = `stats-${serverPath}`;
    
    // Check cache first
    if (!forceRefresh) {
      const cached = this._getCachedStats(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Try incremental calculation
    if (useIncremental && !forceRefresh) {
      const incrementalResult = await this._calculateIncremental(backups, serverPath);
      if (incrementalResult) {
        this._setCachedStats(cacheKey, incrementalResult);
        return incrementalResult;
      }
    }

    // Full calculation
    const result = await this._calculateFull(backups, enableBackground);
    this._setCachedStats(cacheKey, result);
    
    // Update incremental cache
    this._updateIncrementalCache(serverPath, backups, result);
    
    return result;
  }

  /**
   * Calculate statistics incrementally based on changes
   */
  async _calculateIncremental(backups, serverPath) {
    const lastState = this.incrementalCache.get(serverPath);
    if (!lastState) {
      return null; // No previous state, need full calculation
    }

    const currentBackupNames = new Set(backups.map(b => b.name));
    const lastBackupNames = new Set(lastState.backups.map(b => b.name));

    // Find changes
    const addedBackups = backups.filter(b => !lastBackupNames.has(b.name));
    const removedBackups = lastState.backups.filter(b => !currentBackupNames.has(b.name));
    const changedBackups = backups.filter(b => {
      if (!lastBackupNames.has(b.name)) return false;
      const lastBackup = lastState.backups.find(lb => lb.name === b.name);
      return !lastBackup || lastBackup.size !== b.size;
    });

    // If too many changes, do full recalculation
    const changeRatio = (addedBackups.length + removedBackups.length + changedBackups.length) / backups.length;
    if (changeRatio > 0.3) { // More than 30% changed
      return null;
    }

    // Update statistics incrementally
    const updatedStats = { ...lastState.statistics };

    // Update basic counts and sizes
    updatedStats.totalBackups = backups.length;
    
    // Adjust total size
    let sizeAdjustment = 0;
    for (const backup of addedBackups) {
      sizeAdjustment += backup.size || 0;
    }
    for (const backup of removedBackups) {
      sizeAdjustment -= backup.size || 0;
    }
    for (const backup of changedBackups) {
      const oldBackup = lastState.backups.find(b => b.name === backup.name);
      sizeAdjustment += (backup.size || 0) - (oldBackup?.size || 0);
    }

    updatedStats.totalSize = Math.max(0, updatedStats.totalSize + sizeAdjustment);
    updatedStats.averageSize = updatedStats.totalBackups > 0 ? updatedStats.totalSize / updatedStats.totalBackups : 0;

    // Update oldest/newest if needed
    if (addedBackups.length > 0 || removedBackups.length > 0) {
      const sortedBackups = this._sortBackupsByDate(backups);
      updatedStats.oldestBackup = sortedBackups[0];
      updatedStats.newestBackup = sortedBackups[sortedBackups.length - 1];
    }

    // Recalculate growth trend if there are recent changes
    if (addedBackups.length > 0) {
      updatedStats.sizeGrowthTrend = await this._calculateGrowthTrendOptimized(backups);
    }

    return {
      ...updatedStats,
      incremental: true,
      changes: {
        added: addedBackups.length,
        removed: removedBackups.length,
        changed: changedBackups.length
      }
    };
  }

  /**
   * Calculate full statistics with optimizations
   */
  async _calculateFull(backups, enableBackground = true) {
    if (enableBackground && backups.length > 100) {
      return this._calculateInBackground(backups);
    }

    return this._calculateSync(backups);
  }

  /**
   * Calculate statistics synchronously
   */
  _calculateSync(backups) {
    const stats = {
      totalBackups: backups.length,
      totalSize: 0,
      averageSize: 0,
      oldestBackup: null,
      newestBackup: null,
      sizeGrowthTrend: [],
      frequencyPattern: {},
      retentionSavings: 0
    };

    if (backups.length === 0) {
      return stats;
    }

    // Sort once and reuse
    const sortedByDate = this._sortBackupsByDate(backups);
    
    // Basic statistics
    stats.oldestBackup = sortedByDate[0];
    stats.newestBackup = sortedByDate[sortedByDate.length - 1];
    
    // Size calculations
    stats.totalSize = backups.reduce((sum, backup) => sum + (backup.size || 0), 0);
    stats.averageSize = stats.totalSize / backups.length;
    
    // Growth trend and frequency pattern
    stats.sizeGrowthTrend = this._calculateGrowthTrendOptimized(sortedByDate);
    stats.frequencyPattern = this._calculateFrequencyPatternOptimized(sortedByDate);
    
    return stats;
  }

  /**
   * Calculate statistics in background
   */
  async _calculateInBackground(backups) {
    return new Promise((resolve, reject) => {
      this.backgroundQueue.push({
        operation: () => this._calculateSync(backups),
        resolve,
        reject
      });

      this._processBackgroundQueue();
    });
  }

  /**
   * Process background calculation queue
   */
  async _processBackgroundQueue() {
    if (this.processing || this.backgroundQueue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.backgroundQueue.length > 0) {
        const task = this.backgroundQueue.shift();
        
        try {
          const result = await task.operation();
          task.resolve(result);
        } catch (error) {
          task.reject(error);
        }

        // Yield control periodically
        if (this.backgroundQueue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Optimized growth trend calculation
   */
  _calculateGrowthTrendOptimized(sortedBackups) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    // Use binary search to find the start index
    const startIndex = this._binarySearchByDate(sortedBackups, thirtyDaysAgo);
    const recentBackups = sortedBackups.slice(startIndex);
    
    if (recentBackups.length === 0) {
      return [];
    }
    
    // Group by day using Map for better performance
    const dailyData = new Map();
    
    for (const backup of recentBackups) {
      const backupDate = this._getBackupDate(backup);
      const dayKey = backupDate.toISOString().split('T')[0];
      
      if (!dailyData.has(dayKey)) {
        dailyData.set(dayKey, {
          date: dayKey,
          size: 0,
          count: 0,
          backups: []
        });
      }
      
      const dayData = dailyData.get(dayKey);
      dayData.size += backup.size || 0;
      dayData.count++;
      dayData.backups.push(backup);
    }
    
    // Convert to array and sort
    const trendData = Array.from(dailyData.values()).sort((a, b) => 
      new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    
    // Calculate cumulative size efficiently
    let cumulativeSize = 0;
    return trendData.map(day => {
      cumulativeSize += day.size;
      return {
        ...day,
        cumulativeSize,
        formattedSize: this._formatSize(day.size),
        formattedCumulativeSize: this._formatSize(cumulativeSize)
      };
    });
  }

  /**
   * Optimized frequency pattern calculation
   */
  _calculateFrequencyPatternOptimized(sortedBackups) {
    if (sortedBackups.length < 2) {
      return {
        averageInterval: 0,
        intervalVariance: 0,
        backupsByHour: {},
        backupsByDayOfWeek: {},
        backupsByMonth: {}
      };
    }

    const intervals = [];
    const backupsByHour = new Array(24).fill(0);
    const backupsByDayOfWeek = new Array(7).fill(0);
    const backupsByMonth = new Array(12).fill(0);

    // Calculate intervals and patterns in single pass
    for (let i = 1; i < sortedBackups.length; i++) {
      const prevDate = this._getBackupDate(sortedBackups[i - 1]);
      const currentDate = this._getBackupDate(sortedBackups[i]);
      
      intervals.push(currentDate.getTime() - prevDate.getTime());
    }

    // Analyze timing patterns
    for (const backup of sortedBackups) {
      const backupDate = this._getBackupDate(backup);
      
      backupsByHour[backupDate.getHours()]++;
      backupsByDayOfWeek[backupDate.getDay()]++;
      backupsByMonth[backupDate.getMonth()]++;
    }

    // Calculate statistics
    const averageInterval = intervals.length > 0 ? 
      intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length : 0;
    
    const intervalVariance = intervals.length > 0 ? 
      intervals.reduce((sum, interval) => sum + Math.pow(interval - averageInterval, 2), 0) / intervals.length : 0;

    return {
      averageInterval,
      intervalVariance,
      backupsByHour: this._arrayToObject(backupsByHour),
      backupsByDayOfWeek: this._arrayToObject(backupsByDayOfWeek),
      backupsByMonth: this._arrayToObject(backupsByMonth),
      totalIntervals: intervals.length,
      formattedAverageInterval: this._formatDuration(averageInterval)
    };
  }

  /**
   * Binary search to find backups after a certain date
   */
  _binarySearchByDate(sortedBackups, targetDate) {
    let left = 0;
    let right = sortedBackups.length - 1;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midDate = this._getBackupDate(sortedBackups[mid]);
      
      if (midDate >= targetDate) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    
    return left;
  }

  /**
   * Sort backups by date efficiently
   */
  _sortBackupsByDate(backups) {
    return [...backups].sort((a, b) => {
      const dateA = this._getBackupDate(a);
      const dateB = this._getBackupDate(b);
      return dateA.getTime() - dateB.getTime();
    });
  }

  /**
   * Get backup date
   */
  _getBackupDate(backup) {
    if (backup.metadata && backup.metadata.timestamp) {
      return new Date(backup.metadata.timestamp);
    }
    if (backup.created) {
      return new Date(backup.created);
    }
    return new Date();
  }

  /**
   * Convert array to object with numeric keys
   */
  _arrayToObject(array) {
    const obj = {};
    for (let i = 0; i < array.length; i++) {
      if (array[i] > 0) {
        obj[i] = array[i];
      }
    }
    return obj;
  }

  /**
   * Format size helper
   */
  _formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const sizeIndex = Math.min(i, sizes.length - 1);
    const formattedValue = parseFloat((bytes / Math.pow(k, sizeIndex)).toFixed(2));
    return `${formattedValue} ${sizes[sizeIndex]}`;
  }

  /**
   * Format duration helper
   */
  _formatDuration(milliseconds) {
    if (milliseconds === 0) return '0 seconds';
    
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    return `${seconds} second${seconds > 1 ? 's' : ''}`;
  }

  /**
   * Get cached statistics
   */
  _getCachedStats(cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.cache.delete(cacheKey);
      return null;
    }
    
    return cached.data;
  }

  /**
   * Set cached statistics
   */
  _setCachedStats(cacheKey, data) {
    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Update incremental cache
   */
  _updateIncrementalCache(serverPath, backups, statistics) {
    this.incrementalCache.set(serverPath, {
      backups: [...backups],
      statistics,
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate cache
   */
  invalidateCache(serverPath) {
    if (serverPath) {
      const cacheKey = `stats-${serverPath}`;
      this.cache.delete(cacheKey);
      this.incrementalCache.delete(serverPath);
    } else {
      this.cache.clear();
      this.incrementalCache.clear();
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      cacheSize: this.cache.size,
      incrementalCacheSize: this.incrementalCache.size,
      backgroundQueueLength: this.backgroundQueue.length,
      processing: this.processing
    };
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this.cache.clear();
    this.incrementalCache.clear();
    this.backgroundQueue.length = 0;
    this.processing = false;
  }
}

/**
 * Background statistics updater
 */
export class BackgroundStatisticsUpdater {
  constructor(calculator) {
    this.calculator = calculator;
    this.updateQueue = new Map();
    this.processing = false;
    this.updateInterval = 30000; // 30 seconds
    this.maxQueueSize = 10;
  }

  /**
   * Queue statistics update for background processing
   */
  queueUpdate(serverPath, backups, priority = 0) {
    // Remove existing update for same server path
    this.updateQueue.delete(serverPath);
    
    // Add new update
    this.updateQueue.set(serverPath, {
      serverPath,
      backups: [...backups],
      priority,
      timestamp: Date.now()
    });

    // Limit queue size
    if (this.updateQueue.size > this.maxQueueSize) {
      const oldestKey = Array.from(this.updateQueue.keys())[0];
      this.updateQueue.delete(oldestKey);
    }

    // Start processing if not already running
    if (!this.processing) {
      setTimeout(() => this._processQueue(), 100);
    }
  }

  /**
   * Process update queue
   */
  async _processQueue() {
    if (this.processing || this.updateQueue.size === 0) {
      return;
    }

    this.processing = true;

    try {
      // Sort by priority and timestamp
      const updates = Array.from(this.updateQueue.values()).sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority; // Higher priority first
        }
        return a.timestamp - b.timestamp; // Older first
      });

      for (const update of updates) {
        try {
          await this.calculator.calculateStatistics(
            update.backups,
            update.serverPath,
            { enableBackground: true, useIncremental: true }
          );

          this.updateQueue.delete(update.serverPath);

          // Small delay between updates
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch {
          this.updateQueue.delete(update.serverPath);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueSize: this.updateQueue.size,
      processing: this.processing,
      maxQueueSize: this.maxQueueSize
    };
  }

  /**
   * Clear queue
   */
  clearQueue() {
    this.updateQueue.clear();
  }
}

// Global instances
const cachedCalculator = new CachedStatisticsCalculator();
const backgroundUpdater = new BackgroundStatisticsUpdater(cachedCalculator);

/**
 * Optimized statistics calculation with caching and background processing
 */
export async function calculateStatisticsOptimized(backups, serverPath, options = {}) {
  return cachedCalculator.calculateStatistics(backups, serverPath, options);
}

/**
 * Queue background statistics update
 */
export function queueBackgroundStatisticsUpdate(serverPath, backups, priority = 0) {
  backgroundUpdater.queueUpdate(serverPath, backups, priority);
}

/**
 * Invalidate statistics cache
 */
export function invalidateStatisticsCache(serverPath) {
  cachedCalculator.invalidateCache(serverPath);
}

/**
 * Get performance statistics
 */
export function getStatisticsPerformanceStats() {
  return {
    calculator: cachedCalculator.getCacheStats(),
    backgroundUpdater: backgroundUpdater.getStatus()
  };
}

/**
 * Cleanup statistics resources
 */
export function cleanupStatistics() {
  cachedCalculator.cleanup();
  backgroundUpdater.clearQueue();
}

// BackgroundStatisticsUpdater is already exported as a class above