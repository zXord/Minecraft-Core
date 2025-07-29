/// <reference path="../../electron.d.ts" />

/**
 * Retention Policy Performance Optimizer
 * Provides efficient algorithms for backup sorting, filtering, and batch processing
 */

/**
 * Recommendation Priority Levels
 */
export const RecommendationPriority = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * Optimized backup sorting with multiple algorithms
 */
export class OptimizedBackupSorter {
  /**
   * Sort backups using the most efficient algorithm based on data size
   * @param {Array} backups - Array of backup objects
   * @param {string} sortBy - Sort criteria ('date', 'size', 'name')
   * @param {boolean} ascending - Sort order
   * @returns {Array} Sorted backups
   */
  static sort(backups, sortBy = 'date', ascending = false) {
    if (!Array.isArray(backups) || backups.length === 0) {
      return backups;
    }

    // Use different algorithms based on array size
    if (backups.length < 100) {
      return this._quickSort(backups, sortBy, ascending);
    } else if (backups.length < 1000) {
      return this._mergeSort(backups, sortBy, ascending);
    } else {
      return this._timsort(backups, sortBy, ascending);
    }
  }

  /**
   * Quick sort implementation for small arrays
   */
  static _quickSort(backups, sortBy, ascending) {
    if (backups.length <= 1) return backups;

    const pivot = backups[Math.floor(backups.length / 2)];
    const left = [];
    const right = [];
    const equal = [];

    for (const backup of backups) {
      const comparison = this._compareBackups(backup, pivot, sortBy);
      if (comparison < 0) {
        left.push(backup);
      } else if (comparison > 0) {
        right.push(backup);
      } else {
        equal.push(backup);
      }
    }

    const sortedLeft = this._quickSort(left, sortBy, ascending);
    const sortedRight = this._quickSort(right, sortBy, ascending);

    return ascending 
      ? [...sortedLeft, ...equal, ...sortedRight]
      : [...sortedRight, ...equal, ...sortedLeft];
  }

  /**
   * Merge sort implementation for medium arrays
   */
  static _mergeSort(backups, sortBy, ascending) {
    if (backups.length <= 1) return backups;

    const mid = Math.floor(backups.length / 2);
    const left = this._mergeSort(backups.slice(0, mid), sortBy, ascending);
    const right = this._mergeSort(backups.slice(mid), sortBy, ascending);

    return this._merge(left, right, sortBy, ascending);
  }

  /**
   * Merge two sorted arrays
   */
  static _merge(left, right, sortBy, ascending) {
    const result = [];
    let leftIndex = 0;
    let rightIndex = 0;

    while (leftIndex < left.length && rightIndex < right.length) {
      const comparison = this._compareBackups(left[leftIndex], right[rightIndex], sortBy);
      const shouldTakeLeft = ascending ? comparison <= 0 : comparison >= 0;

      if (shouldTakeLeft) {
        result.push(left[leftIndex]);
        leftIndex++;
      } else {
        result.push(right[rightIndex]);
        rightIndex++;
      }
    }

    return result.concat(left.slice(leftIndex)).concat(right.slice(rightIndex));
  }

  /**
   * Timsort-inspired algorithm for large arrays
   */
  static _timsort(backups, sortBy, ascending) {
    // For very large arrays, use native sort with optimized comparator
    return [...backups].sort((a, b) => {
      const comparison = this._compareBackups(a, b, sortBy);
      return ascending ? comparison : -comparison;
    });
  }

  /**
   * Compare two backup objects
   */
  static _compareBackups(a, b, sortBy) {
    switch (sortBy) {
      case 'date': {
        const dateA = this._getBackupDate(a);
        const dateB = this._getBackupDate(b);
        return dateA.getTime() - dateB.getTime();
      }
      
      case 'size':
        return (a.size || 0) - (b.size || 0);
      
      case 'name':
        return a.name.localeCompare(b.name);
      
      default:
        return 0;
    }
  }

  /**
   * Get backup date efficiently
   */
  static _getBackupDate(backup) {
    if (backup.metadata && backup.metadata.timestamp) {
      return new Date(backup.metadata.timestamp);
    }
    if (backup.created) {
      return new Date(backup.created);
    }
    return new Date();
  }
}

/**
 * Batch processor for large retention operations
 */
export class BatchRetentionProcessor {
  constructor(batchSize = 50, delayBetweenBatches = 10) {
    this.batchSize = batchSize;
    this.delayBetweenBatches = delayBetweenBatches;
    this.progressCallbacks = new Set();
  }

  /**
   * Process retention policy in batches
   * @param {Array} backups - Backups to process
   * @param {Function} retentionEvaluator - Function to evaluate retention for each batch
   * @returns {Promise<Object>} Processing results
   */
  async processBatches(backups, retentionEvaluator) {
    const results = {
      processed: 0,
      toDelete: [],
      errors: [],
      totalBatches: Math.ceil(backups.length / this.batchSize),
      currentBatch: 0
    };

    for (let i = 0; i < backups.length; i += this.batchSize) {
      const batch = backups.slice(i, i + this.batchSize);
      results.currentBatch++;

      try {
        const batchResult = await retentionEvaluator(batch);
        
        if (batchResult.toDelete) {
          results.toDelete.push(...batchResult.toDelete);
        }
        
        if (batchResult.errors) {
          results.errors.push(...batchResult.errors);
        }

        results.processed += batch.length;

        // Notify progress callbacks
        this._notifyProgress({
          processed: results.processed,
          total: backups.length,
          currentBatch: results.currentBatch,
          totalBatches: results.totalBatches,
          percentage: Math.round((results.processed / backups.length) * 100)
        });

        // Small delay between batches to prevent blocking
        if (i + this.batchSize < backups.length) {
          await new Promise(resolve => setTimeout(resolve, this.delayBetweenBatches));
        }
      } catch (error) {
        results.errors.push({
          batch: results.currentBatch,
          error: error.message,
          backupsInBatch: batch.length
        });
      }
    }

    return results;
  }

  /**
   * Add progress callback
   */
  addProgressCallback(callback) {
    this.progressCallbacks.add(callback);
    return () => this.progressCallbacks.delete(callback);
  }

  /**
   * Notify progress callbacks
   */
  _notifyProgress(progress) {
    for (const callback of this.progressCallbacks) {
      try {
        callback(progress);
      } catch (error) {
        console.error('Error in progress callback:', error);
      }
    }
  }
}

/**
 * Efficient backup filtering with indexed lookups
 */
export class OptimizedBackupFilter {
  constructor() {
    this.indexCache = new Map();
  }

  /**
   * Create indexes for fast filtering
   * @param {Array} backups - Backups to index
   */
  createIndexes(backups) {
    const indexes = {
      byDate: new Map(),
      bySize: new Map(),
      byName: new Map(),
      byType: new Map()
    };

    for (let i = 0; i < backups.length; i++) {
      const backup = backups[i];
      
      // Date index (by day)
      const date = OptimizedBackupSorter._getBackupDate(backup);
      const dayKey = date.toISOString().split('T')[0];
      if (!indexes.byDate.has(dayKey)) {
        indexes.byDate.set(dayKey, []);
      }
      indexes.byDate.get(dayKey).push(i);

      // Size index (by size ranges)
      const sizeRange = this._getSizeRange(backup.size || 0);
      if (!indexes.bySize.has(sizeRange)) {
        indexes.bySize.set(sizeRange, []);
      }
      indexes.bySize.get(sizeRange).push(i);

      // Name index (by first letter)
      const nameKey = backup.name.charAt(0).toLowerCase();
      if (!indexes.byName.has(nameKey)) {
        indexes.byName.set(nameKey, []);
      }
      indexes.byName.get(nameKey).push(i);

      // Type index
      const type = backup.metadata?.type || 'unknown';
      if (!indexes.byType.has(type)) {
        indexes.byType.set(type, []);
      }
      indexes.byType.get(type).push(i);
    }

    this.indexCache.set('current', { backups, indexes });
    return indexes;
  }

  /**
   * Filter backups using indexes for better performance
   * @param {Array} backups - Backups to filter
   * @param {Object} criteria - Filter criteria
   * @returns {Array} Filtered backups
   */
  filter(backups, criteria) {
    // Create indexes if not cached or backups changed
    const cached = this.indexCache.get('current');
    let indexes;
    
    if (!cached || cached.backups !== backups) {
      indexes = this.createIndexes(backups);
    } else {
      indexes = cached.indexes;
    }

    let candidateIndexes = null;

    // Use the most selective filter first
    if (criteria.dateRange) {
      candidateIndexes = this._filterByDateRange(indexes.byDate, criteria.dateRange);
    } else if (criteria.sizeRange) {
      candidateIndexes = this._filterBySizeRange(indexes.bySize, criteria.sizeRange);
    } else if (criteria.type) {
      candidateIndexes = indexes.byType.get(criteria.type) || [];
    } else if (criteria.namePattern) {
      candidateIndexes = this._filterByNamePattern(indexes.byName, criteria.namePattern);
    }

    // If no indexed filter was used, use all backups
    if (candidateIndexes === null) {
      candidateIndexes = Array.from({ length: backups.length }, (_, i) => i);
    }

    // Apply remaining filters to candidates
    const results = [];
    for (const index of candidateIndexes) {
      const backup = backups[index];
      if (this._matchesCriteria(backup, criteria)) {
        results.push(backup);
      }
    }

    return results;
  }

  /**
   * Get size range for indexing
   */
  _getSizeRange(size) {
    if (size < 1024 * 1024) return 'small'; // < 1MB
    if (size < 100 * 1024 * 1024) return 'medium'; // < 100MB
    if (size < 1024 * 1024 * 1024) return 'large'; // < 1GB
    return 'xlarge'; // >= 1GB
  }

  /**
   * Filter by date range using index
   */
  _filterByDateRange(dateIndex, dateRange) {
    const results = [];
    const startDate = new Date(dateRange.start).toISOString().split('T')[0];
    const endDate = new Date(dateRange.end).toISOString().split('T')[0];

    for (const [dayKey, indexes] of dateIndex) {
      if (dayKey >= startDate && dayKey <= endDate) {
        results.push(...indexes);
      }
    }

    return results;
  }

  /**
   * Filter by size range using index
   */
  _filterBySizeRange(sizeIndex, sizeRange) {
    const results = [];
    const ranges = ['small', 'medium', 'large', 'xlarge'];
    
    for (const range of ranges) {
      if (this._sizeRangeMatches(range, sizeRange)) {
        const indexes = sizeIndex.get(range) || [];
        results.push(...indexes);
      }
    }

    return results;
  }

  /**
   * Filter by name pattern using index
   */
  _filterByNamePattern(nameIndex, pattern) {
    const results = [];
    const lowerPattern = pattern.toLowerCase();

    for (const [firstLetter, indexes] of nameIndex) {
      if (lowerPattern.includes(firstLetter) || firstLetter.includes(lowerPattern.charAt(0))) {
        results.push(...indexes);
      }
    }

    return results;
  }

  /**
   * Check if size range matches criteria
   */
  _sizeRangeMatches(range, criteria) {
    const rangeSizes = {
      small: { min: 0, max: 1024 * 1024 },
      medium: { min: 1024 * 1024, max: 100 * 1024 * 1024 },
      large: { min: 100 * 1024 * 1024, max: 1024 * 1024 * 1024 },
      xlarge: { min: 1024 * 1024 * 1024, max: Infinity }
    };

    const rangeSize = rangeSizes[range];
    return criteria.min < rangeSize.max && criteria.max > rangeSize.min;
  }

  /**
   * Check if backup matches all criteria
   */
  _matchesCriteria(backup, criteria) {
    // Additional fine-grained filtering after index-based pre-filtering
    if (criteria.exactSize && backup.size !== criteria.exactSize) {
      return false;
    }

    if (criteria.nameRegex && !criteria.nameRegex.test(backup.name)) {
      return false;
    }

    if (criteria.customFilter && !criteria.customFilter(backup)) {
      return false;
    }

    return true;
  }

  /**
   * Clear index cache
   */
  clearCache() {
    this.indexCache.clear();
  }
}

/**
 * Memory-efficient retention policy evaluator
 */
export class MemoryEfficientRetentionEvaluator {
  constructor() {
    this.chunkSize = 100;
    this.memoryThreshold = 100 * 1024 * 1024; // 100MB
  }

  /**
   * Evaluate retention policy with memory optimization
   * @param {Array} backups - Backups to evaluate
   * @param {Object} policy - Retention policy
   * @returns {Promise<Object>} Evaluation results
   */
  async evaluate(backups, policy) {
    const memoryUsage = this._estimateMemoryUsage(backups);
    
    if (memoryUsage > this.memoryThreshold) {
      return this._evaluateInChunks(backups, policy);
    } else {
      return this._evaluateInMemory(backups, policy);
    }
  }

  /**
   * Evaluate in memory for small datasets
   */
  async _evaluateInMemory(backups, policy) {
    // Use existing retention policy logic
    const sortedBackups = OptimizedBackupSorter.sort(backups, 'date', false);
    return this._applyRetentionRules(sortedBackups, policy);
  }

  /**
   * Evaluate in chunks for large datasets
   */
  async _evaluateInChunks(backups, policy) {
    const results = {
      toDelete: [],
      errors: [],
      processed: 0
    };

    // Sort backups first (this is necessary for retention logic)
    const sortedBackups = OptimizedBackupSorter.sort(backups, 'date', false);

    // Process in chunks
    for (let i = 0; i < sortedBackups.length; i += this.chunkSize) {
      const chunk = sortedBackups.slice(i, i + this.chunkSize);
      
      try {
        const chunkResult = await this._applyRetentionRules(chunk, policy, {
          isChunk: true,
          chunkIndex: Math.floor(i / this.chunkSize),
          totalBackups: sortedBackups.length,
          processedSoFar: i
        });

        if (chunkResult.toDelete) {
          results.toDelete.push(...chunkResult.toDelete);
        }

        results.processed += chunk.length;

        // Allow other operations to run
        await new Promise(resolve => setTimeout(resolve, 1));
      } catch (error) {
        results.errors.push({
          chunk: Math.floor(i / this.chunkSize),
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Apply retention rules to a set of backups
   */
  async _applyRetentionRules(backups, policy, chunkInfo = null) {
    const toDelete = [];
    const errors = [];

    try {
      // Size-based retention
      if (policy.maxSize) {
        const sizeViolations = this._findSizeViolations(backups, policy.maxSize, policy.preserveRecent);
        toDelete.push(...sizeViolations);
      }

      // Age-based retention
      if (policy.maxAge) {
        const ageViolations = this._findAgeViolations(backups, policy.maxAge);
        toDelete.push(...ageViolations);
      }

      // Count-based retention
      if (policy.maxCount) {
        const countViolations = this._findCountViolations(backups, policy.maxCount, policy.preserveRecent);
        toDelete.push(...countViolations);
      }

      // Remove duplicates
      const uniqueToDelete = Array.from(new Set(toDelete.map(b => b.name)))
        .map(name => toDelete.find(b => b.name === name));

      return {
        toDelete: uniqueToDelete,
        errors,
        chunkInfo
      };
    } catch (error) {
      errors.push({
        type: 'retention_evaluation_error',
        error: error.message
      });
      
      return {
        toDelete: [],
        errors,
        chunkInfo
      };
    }
  }

  /**
   * Find size violations efficiently
   */
  _findSizeViolations(backups, maxSize, preserveRecent) {
    let totalSize = 0;
    for (const backup of backups) {
      totalSize += backup.size || 0;
    }

    if (totalSize <= maxSize) {
      return [];
    }

    const violations = [];
    let currentSize = totalSize;
    
    // Start from oldest (end of sorted array) and work backwards
    for (let i = backups.length - 1; i >= preserveRecent; i--) {
      if (currentSize <= maxSize) {
        break;
      }
      
      const backup = backups[i];
      violations.push(backup);
      currentSize -= backup.size || 0;
    }

    return violations;
  }

  /**
   * Find age violations efficiently
   */
  _findAgeViolations(backups, maxAge) {
    const cutoffDate = new Date(Date.now() - maxAge);
    const violations = [];

    for (const backup of backups) {
      const backupDate = OptimizedBackupSorter._getBackupDate(backup);
      if (backupDate < cutoffDate) {
        violations.push(backup);
      }
    }

    return violations;
  }

  /**
   * Find count violations efficiently
   */
  _findCountViolations(backups, maxCount, preserveRecent) {
    if (backups.length <= maxCount) {
      return [];
    }

    const violations = [];
    const excessCount = backups.length - maxCount;
    
    // Take oldest backups (from end of sorted array)
    for (let i = 0; i < excessCount; i++) {
      const index = backups.length - 1 - i;
      if (index >= preserveRecent) {
        violations.push(backups[index]);
      }
    }

    return violations;
  }

  /**
   * Estimate memory usage for backup array
   */
  _estimateMemoryUsage(backups) {
    if (!backups || backups.length === 0) return 0;
    
    // Rough estimate: each backup object ~1KB + size of strings
    const avgBackupSize = 1024; // Base object size
    const avgStringSize = 100; // Average string properties
    
    return backups.length * (avgBackupSize + avgStringSize);
  }
}

// Export optimized components
export const retentionOptimizer = {
  sorter: OptimizedBackupSorter,
  batchProcessor: new BatchRetentionProcessor(),
  filter: new OptimizedBackupFilter(),
  evaluator: new MemoryEfficientRetentionEvaluator()
};