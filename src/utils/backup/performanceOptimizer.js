/// <reference path="../../electron.d.ts" />

/**
 * Performance Optimizer for Backup Size Calculations
 * Provides incremental updates, background processing, and advanced caching
 */

/**
 * Advanced cache with size-based eviction and performance metrics
 */
class AdvancedSizeCache {
  constructor(maxSize = 1000, ttl = 5 * 60 * 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.accessCount = new Map();
    this.hitCount = 0;
    this.missCount = 0;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.missCount++;
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      this.accessCount.delete(key);
      this.missCount++;
      return null;
    }

    // Update access count for LRU eviction
    this.accessCount.set(key, (this.accessCount.get(key) || 0) + 1);
    this.hitCount++;
    return entry.data;
  }

  set(key, data) {
    // Evict least recently used items if cache is full
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    this.accessCount.set(key, 1);
  }

  evictLRU() {
    let lruKey = null;
    let minAccess = Infinity;

    for (const [key, count] of this.accessCount) {
      if (count < minAccess) {
        minAccess = count;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
      this.accessCount.delete(lruKey);
    }
  }

  delete(key) {
    this.cache.delete(key);
    this.accessCount.delete(key);
  }

  clear() {
    this.cache.clear();
    this.accessCount.clear();
    this.hitCount = 0;
    this.missCount = 0;
  }

  getStats() {
    const total = this.hitCount + this.missCount;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? (this.hitCount / total) : 0,
      hitCount: this.hitCount,
      missCount: this.missCount
    };
  }
}

/**
 * Background task queue for non-blocking operations
 */
class BackgroundTaskQueue {
  constructor(maxConcurrent = 3) {
    this.queue = [];
    this.running = new Set();
    this.maxConcurrent = maxConcurrent;
  }

  async add(task, priority = 0) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task,
        priority,
        resolve,
        reject
      });

      // Sort by priority (higher priority first)
      this.queue.sort((a, b) => b.priority - a.priority);
      
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.running.size >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    const taskId = Symbol('task');
    this.running.add(taskId);

    try {
      const result = await item.task();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.running.delete(taskId);
      // Process next task
      setTimeout(() => this.processQueue(), 0);
    }
  }

  getStats() {
    return {
      queueLength: this.queue.length,
      runningTasks: this.running.size,
      maxConcurrent: this.maxConcurrent
    };
  }
}

/**
 * Incremental size calculator with change detection
 */
class IncrementalSizeCalculator {
  constructor() {
    this.cache = new AdvancedSizeCache();
    this.taskQueue = new BackgroundTaskQueue();
    this.changeListeners = new Set();
    this.lastKnownState = new Map(); // serverPath -> { backups: [], totalSize: number, timestamp: number }
    this.calculationInProgress = new Map(); // serverPath -> Promise
  }

  /**
   * Calculate total size with incremental updates
   */
  async calculateTotalSizeIncremental(serverPath, backups, forceRefresh = false) {
    const cacheKey = `incremental-${serverPath}`;
    
    // Check if calculation is already in progress
    if (this.calculationInProgress.has(serverPath)) {
      return await this.calculationInProgress.get(serverPath);
    }

    // Check cache first
    if (!forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Start calculation
    const calculationPromise = this._performIncrementalCalculation(serverPath, backups);
    this.calculationInProgress.set(serverPath, calculationPromise);

    try {
      const result = await calculationPromise;
      this.cache.set(cacheKey, result);
      return result;
    } finally {
      this.calculationInProgress.delete(serverPath);
    }
  }

  async _performIncrementalCalculation(serverPath, backups) {
    const lastState = this.lastKnownState.get(serverPath);
    const currentBackupNames = new Set(backups.map(b => b.name));
    
    let totalSize = 0;
    let changedBackups = [];
    let addedBackups = [];
    let removedBackups = [];

    if (lastState) {
      const lastBackupNames = new Set(lastState.backups.map(b => b.name));
      
      // Find changes
      addedBackups = backups.filter(b => !lastBackupNames.has(b.name));
      removedBackups = lastState.backups.filter(b => !currentBackupNames.has(b.name));
      
      // Find potentially changed backups (size might have changed)
      changedBackups = backups.filter(b => {
        if (!lastBackupNames.has(b.name)) return false;
        const lastBackup = lastState.backups.find(lb => lb.name === b.name);
        return !lastBackup || lastBackup.size !== b.size;
      });

      // Start with last known total and adjust
      totalSize = lastState.totalSize;
      
      // Subtract removed backups
      for (const backup of removedBackups) {
        totalSize -= backup.size || 0;
      }
    } else {
      // First calculation - all backups are "added"
      addedBackups = [...backups];
    }

    // Calculate sizes for new and changed backups
    const backupsToCalculate = [...addedBackups, ...changedBackups];
    
    if (backupsToCalculate.length > 0) {
      const sizeResults = await this._calculateBackupSizesBatch(serverPath, backupsToCalculate);
      
      for (const result of sizeResults) {
        if (addedBackups.some(b => b.name === result.name)) {
          totalSize += result.size;
        } else if (changedBackups.some(b => b.name === result.name)) {
          // For changed backups, subtract old size and add new size
          const oldBackup = lastState.backups.find(b => b.name === result.name);
          totalSize = totalSize - (oldBackup?.size || 0) + result.size;
        }
      }
    }

    // Update last known state
    const newState = {
      backups: backups.map(b => {
        const calculated = backupsToCalculate.find(cb => cb.name === b.name);
        return calculated ? { ...b, size: calculated.size } : b;
      }),
      totalSize,
      timestamp: Date.now()
    };
    
    this.lastKnownState.set(serverPath, newState);

    // Notify listeners of changes
    if (addedBackups.length > 0 || removedBackups.length > 0 || changedBackups.length > 0) {
      this._notifyChangeListeners({
        serverPath,
        totalSize,
        changes: {
          added: addedBackups.length,
          removed: removedBackups.length,
          changed: changedBackups.length
        }
      });
    }

    return {
      totalSize,
      backups: newState.backups,
      incremental: true,
      changes: {
        added: addedBackups.length,
        removed: removedBackups.length,
        changed: changedBackups.length
      }
    };
  }

  /**
   * Calculate backup sizes in batches for better performance
   */
  async _calculateBackupSizesBatch(serverPath, backups, batchSize = 5) {
    const results = [];
    
    for (let i = 0; i < backups.length; i += batchSize) {
      const batch = backups.slice(i, i + batchSize);
      
      const batchPromises = batch.map(backup => 
        this.taskQueue.add(async () => {
          try {
            const result = await window.electron.invoke('backups:calculate-sizes', {
              serverPath,
              backupName: backup.name
            });
            
            if (result.success && result.backups && result.backups.length > 0) {
              return {
                name: backup.name,
                size: result.backups[0].size || 0
              };
            }
            
            return { name: backup.name, size: backup.size || 0 };
          } catch (error) {
            console.warn(`Failed to calculate size for ${backup.name}:`, error);
            return { name: backup.name, size: backup.size || 0 };
          }
        }, 1) // Normal priority
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Add change listener
   */
  addChangeListener(listener) {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Notify change listeners
   */
  _notifyChangeListeners(changeData) {
    for (const listener of this.changeListeners) {
      try {
        listener(changeData);
      } catch (error) {
        console.error('Error in change listener:', error);
      }
    }
  }

  /**
   * Invalidate cache for specific server path
   */
  invalidateCache(serverPath) {
    if (serverPath) {
      const cacheKey = `incremental-${serverPath}`;
      this.cache.delete(cacheKey);
      this.lastKnownState.delete(serverPath);
    } else {
      this.cache.clear();
      this.lastKnownState.clear();
    }
  }

  /**
   * Get performance statistics
   */
  getStats() {
    return {
      cache: this.cache.getStats(),
      taskQueue: this.taskQueue.getStats(),
      knownServers: this.lastKnownState.size,
      activeCalculations: this.calculationInProgress.size
    };
  }
}

/**
 * Background size monitor for proactive updates
 */
class BackgroundSizeMonitor {
  constructor(calculator) {
    this.calculator = calculator;
    this.monitoredPaths = new Map(); // serverPath -> { interval, lastCheck }
    this.isMonitoring = false;
  }

  /**
   * Start monitoring a server path
   */
  startMonitoring(serverPath, interval = 30000) { // 30 seconds default
    if (this.monitoredPaths.has(serverPath)) {
      this.stopMonitoring(serverPath);
    }

    const monitorInterval = setInterval(async () => {
      try {
        await this._checkForChanges(serverPath);
      } catch (error) {
        console.error(`Background monitoring error for ${serverPath}:`, error);
      }
    }, interval);

    this.monitoredPaths.set(serverPath, {
      interval: monitorInterval,
      lastCheck: Date.now(),
      checkInterval: interval
    });

    this.isMonitoring = true;
  }

  /**
   * Stop monitoring a server path
   */
  stopMonitoring(serverPath) {
    const monitor = this.monitoredPaths.get(serverPath);
    if (monitor) {
      clearInterval(monitor.interval);
      this.monitoredPaths.delete(serverPath);
    }

    if (this.monitoredPaths.size === 0) {
      this.isMonitoring = false;
    }
  }

  /**
   * Check for changes in background
   */
  async _checkForChanges(serverPath) {
    try {
      // Get current backup list
      const backups = await window.electron.invoke('backups:list', { serverPath });
      
      if (backups && Array.isArray(backups)) {
        // Trigger incremental calculation in background
        await this.calculator.calculateTotalSizeIncremental(serverPath, backups);
      }
    } catch (error) {
      console.warn(`Background check failed for ${serverPath}:`, error);
    }
  }

  /**
   * Stop all monitoring
   */
  stopAll() {
    for (const serverPath of this.monitoredPaths.keys()) {
      this.stopMonitoring(serverPath);
    }
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      monitoredPaths: Array.from(this.monitoredPaths.keys()),
      pathCount: this.monitoredPaths.size
    };
  }
}

// Global instances
const incrementalCalculator = new IncrementalSizeCalculator();
const backgroundMonitor = new BackgroundSizeMonitor(incrementalCalculator);

/**
 * Optimized size calculation with incremental updates
 */
export async function calculateTotalSizeOptimized(serverPath, backups, options = {}) {
  const {
    forceRefresh = false,
    enableBackground = true,
    enableIncremental = true
  } = options;

  try {
    let result;

    if (enableIncremental) {
      result = await incrementalCalculator.calculateTotalSizeIncremental(
        serverPath, 
        backups, 
        forceRefresh
      );
    } else {
      // Fallback to standard calculation
      const totalSize = backups.reduce((sum, backup) => sum + (backup.size || 0), 0);
      result = { totalSize, backups, incremental: false };
    }

    // Start background monitoring if enabled
    if (enableBackground && !backgroundMonitor.monitoredPaths.has(serverPath)) {
      backgroundMonitor.startMonitoring(serverPath);
    }

    return result;
  } catch (error) {
    console.error('Optimized size calculation failed:', error);
    // Fallback to basic calculation
    const totalSize = backups.reduce((sum, backup) => sum + (backup.size || 0), 0);
    return { totalSize, backups, incremental: false, error: error.message };
  }
}

/**
 * Add change listener for size updates
 */
export function addSizeChangeListener(listener) {
  return incrementalCalculator.addChangeListener(listener);
}

/**
 * Invalidate size cache
 */
export function invalidateOptimizedCache(serverPath) {
  incrementalCalculator.invalidateCache(serverPath);
}

/**
 * Get performance statistics
 */
export function getPerformanceStats() {
  return {
    calculator: incrementalCalculator.getStats(),
    monitor: backgroundMonitor.getStatus()
  };
}

/**
 * Cleanup resources
 */
export function cleanup() {
  backgroundMonitor.stopAll();
  incrementalCalculator.cache.clear();
  incrementalCalculator.lastKnownState.clear();
}

/**
 * File system access pattern optimizer
 */
export class FileSystemOptimizer {
  constructor() {
    this.accessQueue = [];
    this.processing = false;
    this.batchSize = 10;
    this.batchDelay = 100; // ms
  }

  /**
   * Queue file system operation for batch processing
   */
  async queueOperation(operation) {
    return new Promise((resolve, reject) => {
      this.accessQueue.push({ operation, resolve, reject });
      this._processBatch();
    });
  }

  async _processBatch() {
    if (this.processing || this.accessQueue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.accessQueue.length > 0) {
        const batch = this.accessQueue.splice(0, this.batchSize);
        
        // Process batch in parallel
        const results = await Promise.allSettled(
          batch.map(item => item.operation())
        );

        // Resolve/reject promises
        results.forEach((result, index) => {
          const item = batch[index];
          if (result.status === 'fulfilled') {
            item.resolve(result.value);
          } else {
            item.reject(result.reason);
          }
        });

        // Small delay between batches to prevent overwhelming the file system
        if (this.accessQueue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, this.batchDelay));
        }
      }
    } finally {
      this.processing = false;
    }
  }
}

// Export global optimizer instance
export const fsOptimizer = new FileSystemOptimizer();