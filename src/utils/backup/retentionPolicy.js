/// <reference path="../../electron.d.ts" />

/**
 * Backup Retention Policy Engine
 * Provides configurable retention policies for backup management with performance optimizations
 */

import { retentionOptimizer } from './retentionOptimizer.js';

/**
 * Retention Policy class for managing backup cleanup based on various criteria
 */
export class RetentionPolicy {
  /**
   * Create a new retention policy
   * @param {Object} [options={}] - Policy configuration options
   * @param {number|null} [options.maxSize] - Maximum total size in bytes (null = no limit)
   * @param {number|null} [options.maxAge] - Maximum age in milliseconds (null = no limit)
   * @param {number|null} [options.maxCount] - Maximum number of backups (null = no limit)
   * @param {number} [options.preserveRecent=1] - Minimum number of recent backups to preserve (default: 1)
   */
  constructor(options = {}) {
    this.maxSize = options.maxSize || null;
    this.maxAge = options.maxAge || null;
    this.maxCount = options.maxCount || null;
    this.preserveRecent = Math.max(1, options.preserveRecent || 1);
    
    // Validate configuration
    this._validateConfiguration();
  }

  /**
   * Validate the retention policy configuration with comprehensive error handling
   * @private
   */
  _validateConfiguration() {
    const errors = [];
    const warnings = [];

    // Validate maxSize
    if (this.maxSize !== null) {
      if (typeof this.maxSize !== 'number') {
        errors.push('maxSize must be a number or null');
      } else if (this.maxSize <= 0) {
        errors.push('maxSize must be greater than 0');
      } else if (this.maxSize < 1024 * 1024) { // Less than 1MB
        warnings.push('maxSize is very small (less than 1MB), this may delete all backups');
      } else if (this.maxSize > 1024 * 1024 * 1024 * 1024) { // Greater than 1TB
        warnings.push('maxSize is very large (greater than 1TB), this may not be effective');
      }
    }
    
    // Validate maxAge
    if (this.maxAge !== null) {
      if (typeof this.maxAge !== 'number') {
        errors.push('maxAge must be a number or null');
      } else if (this.maxAge <= 0) {
        errors.push('maxAge must be greater than 0');
      } else if (this.maxAge < 60 * 1000) { // Less than 1 minute
        warnings.push('maxAge is very short (less than 1 minute), this may delete all backups');
      } else if (this.maxAge > 365 * 24 * 60 * 60 * 1000) { // Greater than 1 year
        warnings.push('maxAge is very long (greater than 1 year), this may not be effective');
      }
    }
    
    // Validate maxCount
    if (this.maxCount !== null) {
      if (typeof this.maxCount !== 'number') {
        errors.push('maxCount must be a number or null');
      } else if (this.maxCount <= 0) {
        errors.push('maxCount must be greater than 0');
      } else if (!Number.isInteger(this.maxCount)) {
        errors.push('maxCount must be a whole number');
      } else if (this.maxCount > 10000) {
        warnings.push('maxCount is very large (greater than 10,000), this may impact performance');
      }
    }
    
    // Validate preserveRecent
    if (typeof this.preserveRecent !== 'number') {
      errors.push('preserveRecent must be a number');
    } else if (this.preserveRecent < 1) {
      errors.push('preserveRecent must be at least 1');
    } else if (!Number.isInteger(this.preserveRecent)) {
      errors.push('preserveRecent must be a whole number');
    } else if (this.preserveRecent > 100) {
      warnings.push('preserveRecent is very large (greater than 100), this may reduce retention effectiveness');
    }

    // Cross-validation checks
    if (this.maxCount !== null && this.preserveRecent >= this.maxCount) {
      errors.push('preserveRecent must be less than maxCount');
    }

    // Check if any retention rules are active
    if (this.maxSize === null && this.maxAge === null && this.maxCount === null) {
      warnings.push('No retention rules are active - policy will not delete any backups');
    }

    // Store validation results
    this._validationErrors = errors;
    this._validationWarnings = warnings;

    // Throw error if there are validation errors
    if (errors.length > 0) {
      throw new Error(`Retention policy validation failed: ${errors.join(', ')}`);
    }

    // Log warnings if present
    if (warnings.length > 0) {
      console.warn('Retention policy warnings:', warnings);
    }
  }

  /**
   * Get validation results for the current configuration
   * @returns {Object} Validation results with errors and warnings
   */
  getValidationResults() {
    return {
      errors: this._validationErrors || [],
      warnings: this._validationWarnings || [],
      isValid: !this._validationErrors || this._validationErrors.length === 0
    };
  }

  /**
   * Evaluate backups against retention policies with performance optimizations
   * @param {Array} backups - Array of backup objects with name, size, created properties
   * @param {Object} options - Evaluation options
   * @returns {Promise<Object>} Object containing backups to delete and evaluation details
   */
  async evaluateBackups(backups, options = {}) {
    const {
      useBatchProcessing = backups.length > 100,
      enableOptimizedSorting = true,
      enableMemoryOptimization = backups.length > 500
    } = options;

    const evaluationResult = {
      toDelete: [],
      errors: [],
      warnings: [],
      skippedBackups: [],
      evaluationDetails: {
        sizeViolations: 0,
        ageViolations: 0,
        countViolations: 0,
        preservedByRecent: 0
      }
    };

    try {
      // Input validation
      if (!Array.isArray(backups)) {
        throw new Error('Backups must be an array');
      }

      if (backups.length === 0) {
        return evaluationResult;
      }

      // Use memory-efficient evaluation for large datasets
      if (enableMemoryOptimization) {
        const memoryEfficientResult = await retentionOptimizer.evaluator.evaluate(backups, {
          maxSize: this.maxSize,
          maxAge: this.maxAge,
          maxCount: this.maxCount,
          preserveRecent: this.preserveRecent
        });

        return {
          ...evaluationResult,
          toDelete: memoryEfficientResult.toDelete || [],
          errors: memoryEfficientResult.errors || []
        };
      }

      // Validate backup objects
      const validBackups = [];
      for (let i = 0; i < backups.length; i++) {
        const backup = backups[i];
        try {
          this._validateBackupObject(backup, i);
          validBackups.push(backup);
        } catch (validationError) {
          evaluationResult.errors.push({
            backup: backup?.name || `backup[${i}]`,
            error: validationError.message,
            type: 'validation_error'
          });
          evaluationResult.skippedBackups.push(backup);
        }
      }

      if (validBackups.length === 0) {
        evaluationResult.warnings.push('No valid backups found to evaluate');
        return evaluationResult;
      }

      // Use optimized sorting
      let sortedBackups;
      try {
        if (enableOptimizedSorting) {
          sortedBackups = retentionOptimizer.sorter.sort(validBackups, 'date', false);
        } else {
          sortedBackups = this._sortBackupsByAge(validBackups);
        }
      } catch (sortError) {
        throw new Error(`Failed to sort backups: ${sortError.message}`);
      }

      // Use batch processing for large datasets
      if (useBatchProcessing) {
        const batchResult = await retentionOptimizer.batchProcessor.processBatches(
          sortedBackups,
          async (batch) => this._evaluateBatch(batch)
        );

        evaluationResult.toDelete = batchResult.toDelete || [];
        evaluationResult.errors.push(...(batchResult.errors || []));
        
        return evaluationResult;
      }
      
      // Standard evaluation for smaller datasets
      const violations = new Set();
      const violationReasons = new Map();
      
      // Apply size-based retention
      if (this.maxSize !== null) {
        try {
          const sizeViolations = this._findSizeViolations(sortedBackups);
          sizeViolations.forEach(backup => {
            violations.add(backup);
            violationReasons.set(backup.name, (violationReasons.get(backup.name) || []).concat(['size_limit']));
          });
          evaluationResult.evaluationDetails.sizeViolations = sizeViolations.length;
        } catch (sizeError) {
          evaluationResult.errors.push({
            type: 'size_evaluation_error',
            error: sizeError.message
          });
        }
      }
      
      // Apply age-based retention
      if (this.maxAge !== null) {
        try {
          const ageViolations = this._findAgeViolations(sortedBackups);
          ageViolations.forEach(backup => {
            violations.add(backup);
            violationReasons.set(backup.name, (violationReasons.get(backup.name) || []).concat(['age_limit']));
          });
          evaluationResult.evaluationDetails.ageViolations = ageViolations.length;
        } catch (ageError) {
          evaluationResult.errors.push({
            type: 'age_evaluation_error',
            error: ageError.message
          });
        }
      }
      
      // Apply count-based retention
      if (this.maxCount !== null) {
        try {
          const countViolations = this._findCountViolations(sortedBackups);
          countViolations.forEach(backup => {
            violations.add(backup);
            violationReasons.set(backup.name, (violationReasons.get(backup.name) || []).concat(['count_limit']));
          });
          evaluationResult.evaluationDetails.countViolations = countViolations.length;
        } catch (countError) {
          evaluationResult.errors.push({
            type: 'count_evaluation_error',
            error: countError.message
          });
        }
      }
      
      // Convert Set back to Array and ensure we preserve recent backups
      const candidatesForDeletion = Array.from(violations);
      let finalDeletionList;
      
      try {
        finalDeletionList = this._preserveRecentBackups(candidatesForDeletion, sortedBackups);
        
        // Calculate how many were preserved by the recent backup rule
        evaluationResult.evaluationDetails.preservedByRecent = candidatesForDeletion.length - finalDeletionList.length;
      } catch (preserveError) {
        evaluationResult.errors.push({
          type: 'preserve_recent_error',
          error: preserveError.message
        });
        finalDeletionList = []; // Safe fallback
      }

      // Add deletion reasons to the final list
      evaluationResult.toDelete = finalDeletionList.map(backup => ({
        ...backup,
        deletionReasons: violationReasons.get(backup.name) || ['unknown']
      }));

      // Add warnings for edge cases
      if (finalDeletionList.length === validBackups.length) {
        evaluationResult.warnings.push('Retention policy would delete all backups - this is prevented by preserveRecent setting');
      }

      if (finalDeletionList.length > validBackups.length * 0.8) {
        evaluationResult.warnings.push('Retention policy would delete more than 80% of backups - please review settings');
      }

      return evaluationResult;
    } catch (error) {
      evaluationResult.errors.push({
        type: 'critical_evaluation_error',
        error: error.message
      });
      
      // Return safe empty result on critical error
      return {
        ...evaluationResult,
        toDelete: []
      };
    }
  }

  /**
   * Evaluate a batch of backups (used by batch processor)
   * @private
   */
  async _evaluateBatch(batch) {
    const violations = new Set();
    const violationReasons = new Map();
    
    // Apply retention rules to batch
    if (this.maxSize !== null) {
      const sizeViolations = this._findSizeViolations(batch);
      sizeViolations.forEach(backup => {
        violations.add(backup);
        violationReasons.set(backup.name, ['size_limit']);
      });
    }
    
    if (this.maxAge !== null) {
      const ageViolations = this._findAgeViolations(batch);
      ageViolations.forEach(backup => {
        violations.add(backup);
        violationReasons.set(backup.name, (violationReasons.get(backup.name) || []).concat(['age_limit']));
      });
    }
    
    if (this.maxCount !== null) {
      const countViolations = this._findCountViolations(batch);
      countViolations.forEach(backup => {
        violations.add(backup);
        violationReasons.set(backup.name, (violationReasons.get(backup.name) || []).concat(['count_limit']));
      });
    }

    const toDelete = Array.from(violations).map(backup => ({
      ...backup,
      deletionReasons: violationReasons.get(backup.name) || ['unknown']
    }));

    return { toDelete, errors: [] };
  }

  /**
   * Validate a backup object for retention policy evaluation
   * @param {Object} backup - Backup object to validate
   * @param {number} index - Index of backup in array (for error reporting)
   * @private
   */
  _validateBackupObject(backup, index) {
    if (!backup || typeof backup !== 'object') {
      throw new Error(`Backup at index ${index} is not a valid object`);
    }

    if (!backup.name || typeof backup.name !== 'string') {
      throw new Error(`Backup at index ${index} missing or invalid name property`);
    }

    // Size is optional but should be a number if present
    if (backup.size !== undefined && backup.size !== null) {
      if (typeof backup.size !== 'number' || backup.size < 0) {
        throw new Error(`Backup '${backup.name}' has invalid size property`);
      }
    }

    // Validate date fields
    const backupDate = this._getBackupDate(backup);
    if (isNaN(backupDate.getTime())) {
      throw new Error(`Backup '${backup.name}' has invalid or missing date information`);
    }
  }

  /**
   * Sort backups by creation date (newest first)
   * @param {Array} backups - Array of backup objects
   * @returns {Array} Sorted array of backups
   * @private
   */
  _sortBackupsByAge(backups) {
    return [...backups].sort((a, b) => {
      const dateA = this._getBackupDate(a);
      const dateB = this._getBackupDate(b);
      return dateB.getTime() - dateA.getTime(); // Newest first
    });
  }

  /**
   * Get the creation date from a backup object
   * @param {Object} backup - Backup object
   * @returns {Date} Creation date
   * @private
   */
  _getBackupDate(backup) {
    // Try metadata timestamp first, then created property
    if (backup.metadata && backup.metadata.timestamp) {
      return new Date(backup.metadata.timestamp);
    }
    
    if (backup.created) {
      return new Date(backup.created);
    }
    
    // Fallback to current date if no timestamp available
    return new Date();
  }

  /**
   * Find backups that violate size-based retention policy
   * @param {Array} sortedBackups - Backups sorted by age (newest first)
   * @returns {Array} Backups that should be deleted due to size violations
   * @private
   */
  _findSizeViolations(sortedBackups) {
    const violations = [];
    let totalSize = 0;
    
    // Calculate total size
    for (const backup of sortedBackups) {
      totalSize += backup.size || 0;
    }
    
    // If total size is within limit, no violations
    if (totalSize <= this.maxSize) {
      return violations;
    }
    
    // Delete oldest backups until we're under the size limit
    // Start from the end (oldest) and work backwards
    let currentSize = totalSize;
    for (let i = sortedBackups.length - 1; i >= this.preserveRecent; i--) {
      if (currentSize <= this.maxSize) {
        break;
      }
      
      const backup = sortedBackups[i];
      violations.push(backup);
      currentSize -= backup.size || 0;
    }
    
    return violations;
  }

  /**
   * Find backups that violate age-based retention policy
   * @param {Array} sortedBackups - Backups sorted by age (newest first)
   * @returns {Array} Backups that should be deleted due to age violations
   * @private
   */
  _findAgeViolations(sortedBackups) {
    const violations = [];
    const cutoffDate = new Date(Date.now() - this.maxAge);
    
    for (const backup of sortedBackups) {
      const backupDate = this._getBackupDate(backup);
      
      // If backup is older than the cutoff, it's a violation
      if (backupDate < cutoffDate) {
        violations.push(backup);
      }
    }
    
    return violations;
  }

  /**
   * Find backups that violate count-based retention policy
   * @param {Array} sortedBackups - Backups sorted by age (newest first)
   * @returns {Array} Backups that should be deleted due to count violations
   * @private
   */
  _findCountViolations(sortedBackups) {
    const violations = [];
    
    // If we have more backups than the limit, delete the oldest ones
    if (sortedBackups.length > this.maxCount) {
      const excessCount = sortedBackups.length - this.maxCount;
      
      // Take the oldest backups (from the end of the sorted array)
      for (let i = 0; i < excessCount; i++) {
        const index = sortedBackups.length - 1 - i;
        violations.push(sortedBackups[index]);
      }
    }
    
    return violations;
  }

  /**
   * Ensure we preserve the minimum number of recent backups
   * @param {Array} toDelete - Backups marked for deletion
   * @param {Array} sortedBackups - All backups sorted by age (newest first)
   * @returns {Array} Filtered list of backups to delete that preserves recent backups
   * @private
   */
  _preserveRecentBackups(toDelete, sortedBackups) {
    if (toDelete.length === 0) {
      return toDelete;
    }
    
    // Get the names of the most recent backups that should be preserved
    const recentBackups = sortedBackups.slice(0, this.preserveRecent);
    const recentNames = new Set(recentBackups.map(b => b.name));
    
    // Filter out any recent backups from the deletion list
    const filtered = toDelete.filter(backup => !recentNames.has(backup.name));
    
    return filtered;
  }

  /**
   * Get a summary of what this policy would do to a set of backups
   * @param {Array} backups - Array of backup objects
   * @returns {Promise<Object>} Summary of policy impact
   */
  async getPolicyImpact(backups) {
    if (!Array.isArray(backups)) {
      throw new Error('Backups must be an array');
    }

    const sortedBackups = this._sortBackupsByAge(backups);
    const evaluationResult = await this.evaluateBackups(backups);
    
    // Handle both old and new evaluation result formats
    const toDelete = Array.isArray(evaluationResult) 
      ? evaluationResult 
      : (evaluationResult.toDelete || []);
    
    const totalSize = sortedBackups.reduce((sum, backup) => sum + (backup.size || 0), 0);
    const deletedSize = toDelete.reduce((sum, backup) => sum + (backup.size || 0), 0);
    const remainingSize = totalSize - deletedSize;
    
    return {
      totalBackups: backups.length,
      backupsToDelete: toDelete.length,
      backupsRemaining: backups.length - toDelete.length,
      totalSize,
      deletedSize,
      remainingSize,
      spaceSaved: deletedSize,
      oldestBackupToDelete: toDelete.length > 0 ? 
        toDelete.reduce((oldest, backup) => {
          const backupDate = this._getBackupDate(backup);
          const oldestDate = this._getBackupDate(oldest);
          return backupDate < oldestDate ? backup : oldest;
        }) : null,
      newestBackupToDelete: toDelete.length > 0 ? 
        toDelete.reduce((newest, backup) => {
          const backupDate = this._getBackupDate(backup);
          const newestDate = this._getBackupDate(newest);
          return backupDate > newestDate ? backup : newest;
        }) : null,
      preservedRecentCount: Math.min(this.preserveRecent, backups.length)
    };
  }

  /**
   * Check if the policy has any active rules
   * @returns {boolean} True if any retention rules are active
   */
  hasActiveRules() {
    return this.maxSize !== null || this.maxAge !== null || this.maxCount !== null;
  }

  /**
   * Get a human-readable description of the policy
   * @returns {string} Policy description
   */
  getDescription() {
    const rules = [];
    
    if (this.maxSize !== null) {
      rules.push(`max size: ${this._formatBytes(this.maxSize)}`);
    }
    
    if (this.maxAge !== null) {
      rules.push(`max age: ${this._formatDuration(this.maxAge)}`);
    }
    
    if (this.maxCount !== null) {
      rules.push(`max count: ${this.maxCount}`);
    }
    
    if (rules.length === 0) {
      return 'No retention rules active';
    }
    
    return `Retention policy: ${rules.join(', ')} (preserve ${this.preserveRecent} recent)`;
  }

  /**
   * Format bytes into human-readable string
   * @param {number} bytes - Size in bytes
   * @returns {string} Formatted size
   * @private
   */
  _formatBytes(bytes) {
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const sizeIndex = Math.min(i, sizes.length - 1);
    const formattedValue = parseFloat((bytes / Math.pow(k, sizeIndex)).toFixed(2));
    return `${formattedValue} ${sizes[sizeIndex]}`;
  }

  /**
   * Format duration into human-readable string
   * @param {number} milliseconds - Duration in milliseconds
   * @returns {string} Formatted duration
   * @private
   */
  _formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    
    if (months > 0) return `${months} month${months > 1 ? 's' : ''}`;
    if (weeks > 0) return `${weeks} week${weeks > 1 ? 's' : ''}`;
    if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    return `${seconds} second${seconds > 1 ? 's' : ''}`;
  }
}

/**
 * Utility functions for creating common retention policies
 */
export const RetentionPolicyPresets = {
  /**
   * Create a size-based retention policy
   * @param {number} maxSizeBytes - Maximum total size in bytes
   * @param {number} preserveRecent - Number of recent backups to preserve
   * @returns {RetentionPolicy} Configured retention policy
   */
  sizeBasedPolicy(maxSizeBytes, preserveRecent = 1) {
    return new RetentionPolicy({
      maxSize: maxSizeBytes,
      preserveRecent
    });
  },

  /**
   * Create an age-based retention policy
   * @param {number} maxAgeMs - Maximum age in milliseconds
   * @param {number} preserveRecent - Number of recent backups to preserve
   * @returns {RetentionPolicy} Configured retention policy
   */
  ageBasedPolicy(maxAgeMs, preserveRecent = 1) {
    return new RetentionPolicy({
      maxAge: maxAgeMs,
      preserveRecent
    });
  },

  /**
   * Create a count-based retention policy
   * @param {number} maxCount - Maximum number of backups
   * @param {number} preserveRecent - Number of recent backups to preserve
   * @returns {RetentionPolicy} Configured retention policy
   */
  countBasedPolicy(maxCount, preserveRecent = 1) {
    return new RetentionPolicy({
      maxCount,
      preserveRecent
    });
  },

  /**
   * Create a combined retention policy with multiple rules
   * @param {Object} options - Policy options
   * @returns {RetentionPolicy} Configured retention policy
   */
  combinedPolicy(options) {
    return new RetentionPolicy(options);
  }
};

/**
 * Utility constants for common time periods
 */
export const TimeConstants = {
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
  MONTH: 30 * 24 * 60 * 60 * 1000,
  YEAR: 365 * 24 * 60 * 60 * 1000
};

/**
 * Utility constants for common size units
 */
export const SizeConstants = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024
};

/**
 * Validation utilities for retention policy settings
 */
export const RetentionPolicyValidator = {
  /**
   * Validate retention policy settings before saving
   * @param {Object} settings - Retention policy settings
   * @returns {Object} Validation result with errors and warnings
   */
  validateSettings(settings) {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
      sanitizedSettings: null
    };

    if (!settings || typeof settings !== 'object') {
      result.isValid = false;
      result.errors.push('Settings must be a valid object');
      return result;
    }

    const sanitized = { ...settings };

    // Validate size retention settings
    if (settings.sizeRetentionEnabled) {
      const sizeValidation = this._validateSizeSettings(settings);
      result.errors.push(...sizeValidation.errors);
      result.warnings.push(...sizeValidation.warnings);
      
      if (sizeValidation.sanitized) {
        Object.assign(sanitized, sizeValidation.sanitized);
      }
    }

    // Validate age retention settings
    if (settings.ageRetentionEnabled) {
      const ageValidation = this._validateAgeSettings(settings);
      result.errors.push(...ageValidation.errors);
      result.warnings.push(...ageValidation.warnings);
      
      if (ageValidation.sanitized) {
        Object.assign(sanitized, ageValidation.sanitized);
      }
    }

    // Validate count retention settings
    if (settings.countRetentionEnabled) {
      const countValidation = this._validateCountSettings(settings);
      result.errors.push(...countValidation.errors);
      result.warnings.push(...countValidation.warnings);
      
      if (countValidation.sanitized) {
        Object.assign(sanitized, countValidation.sanitized);
      }
    }

    // Check if at least one retention method is enabled
    if (!settings.sizeRetentionEnabled && !settings.ageRetentionEnabled && !settings.countRetentionEnabled) {
      result.warnings.push('No retention policies are enabled - backups will not be automatically cleaned up');
    }

    result.isValid = result.errors.length === 0;
    result.sanitizedSettings = sanitized;

    return result;
  },

  /**
   * Validate size-based retention settings
   * @param {Object} settings - Settings object
   * @returns {Object} Validation result
   * @private
   */
  _validateSizeSettings(settings) {
    const result = { errors: [], warnings: [], sanitized: {} };

    // Validate maxSizeValue
    if (settings.maxSizeValue === undefined || settings.maxSizeValue === null) {
      result.errors.push('Size limit value is required when size retention is enabled');
    } else if (typeof settings.maxSizeValue !== 'number') {
      result.errors.push('Size limit value must be a number');
    } else if (settings.maxSizeValue <= 0) {
      result.errors.push('Size limit value must be greater than 0');
    } else if (settings.maxSizeValue > 1000000) {
      result.warnings.push('Size limit value is very large - please verify the unit is correct');
    } else if (settings.maxSizeValue < 0.1) {
      result.warnings.push('Size limit value is very small - this may delete all backups');
    }

    // Validate maxSizeUnit
    const validUnits = ['GB', 'TB'];
    if (!settings.maxSizeUnit || !validUnits.includes(settings.maxSizeUnit)) {
      result.errors.push(`Size unit must be one of: ${validUnits.join(', ')}`);
    }

    // Calculate total bytes for additional validation
    if (typeof settings.maxSizeValue === 'number' && settings.maxSizeUnit) {
      const multiplier = SizeConstants[settings.maxSizeUnit];
      if (multiplier) {
        const totalBytes = settings.maxSizeValue * multiplier;
        
        if (totalBytes < 10 * SizeConstants.MB) {
          result.warnings.push('Total size limit is less than 10MB - this may delete all backups');
        }
        
        if (totalBytes > 100 * SizeConstants.TB) {
          result.warnings.push('Total size limit is greater than 100TB - this may not be effective');
        }
      }
    }

    return result;
  },

  /**
   * Validate age-based retention settings
   * @param {Object} settings - Settings object
   * @returns {Object} Validation result
   * @private
   */
  _validateAgeSettings(settings) {
    const result = { errors: [], warnings: [], sanitized: {} };

    // Validate maxAgeValue
    if (settings.maxAgeValue === undefined || settings.maxAgeValue === null) {
      result.errors.push('Age limit value is required when age retention is enabled');
    } else if (typeof settings.maxAgeValue !== 'number') {
      result.errors.push('Age limit value must be a number');
    } else if (settings.maxAgeValue <= 0) {
      result.errors.push('Age limit value must be greater than 0');
    } else if (!Number.isInteger(settings.maxAgeValue)) {
      result.errors.push('Age limit value must be a whole number');
    } else if (settings.maxAgeValue > 10000) {
      result.warnings.push('Age limit value is very large - please verify the unit is correct');
    }

    // Validate maxAgeUnit
    const validUnits = ['days', 'weeks', 'months'];
    if (!settings.maxAgeUnit || !validUnits.includes(settings.maxAgeUnit)) {
      result.errors.push(`Age unit must be one of: ${validUnits.join(', ')}`);
    }

    // Calculate total milliseconds for additional validation
    if (typeof settings.maxAgeValue === 'number' && settings.maxAgeUnit) {
      const multipliers = {
        days: TimeConstants.DAY,
        weeks: TimeConstants.WEEK,
        months: TimeConstants.MONTH
      };
      
      const multiplier = multipliers[settings.maxAgeUnit];
      if (multiplier) {
        const totalMs = settings.maxAgeValue * multiplier;
        
        if (totalMs < TimeConstants.DAY) {
          result.warnings.push('Age limit is less than 1 day - this may delete all backups');
        }
        
        if (totalMs > 5 * TimeConstants.YEAR) {
          result.warnings.push('Age limit is greater than 5 years - this may not be effective');
        }
      }
    }

    return result;
  },

  /**
   * Validate count-based retention settings
   * @param {Object} settings - Settings object
   * @returns {Object} Validation result
   * @private
   */
  _validateCountSettings(settings) {
    const result = { errors: [], warnings: [], sanitized: {} };

    // Validate maxCountValue
    if (settings.maxCountValue === undefined || settings.maxCountValue === null) {
      result.errors.push('Count limit value is required when count retention is enabled');
    } else if (typeof settings.maxCountValue !== 'number') {
      result.errors.push('Count limit value must be a number');
    } else if (settings.maxCountValue <= 0) {
      result.errors.push('Count limit value must be greater than 0');
    } else if (!Number.isInteger(settings.maxCountValue)) {
      result.errors.push('Count limit value must be a whole number');
    } else if (settings.maxCountValue < 2) {
      result.warnings.push('Count limit is very low - this may delete all but the most recent backup');
    } else if (settings.maxCountValue > 1000) {
      result.warnings.push('Count limit is very high - this may not be effective for cleanup');
    }

    return result;
  },

  /**
   * Create user-friendly error messages for retention policy failures
   * @param {Error} error - The original error
   * @param {string} context - Context where the error occurred
   * @returns {string} User-friendly error message
   */
  createRetentionErrorMessage(error, context = 'retention policy') {
    if (!error) {
      return `Unknown error occurred during ${context}`;
    }
    
    const message = error.message || String(error);
    const lowerMessage = message.toLowerCase();
    
    // Validation errors
    if (lowerMessage.includes('validation failed')) {
      return 'Retention policy settings are invalid. Please check your configuration.';
    }
    
    // File system errors during deletion
    if (lowerMessage.includes('enoent') || lowerMessage.includes('not found')) {
      return 'Some backup files could not be found during cleanup. They may have been moved or deleted.';
    }
    
    if (lowerMessage.includes('eacces') || lowerMessage.includes('access denied') || lowerMessage.includes('permission denied')) {
      return 'Permission denied while deleting backup files. Please check file permissions.';
    }
    
    if (lowerMessage.includes('ebusy') || lowerMessage.includes('file is locked')) {
      return 'Some backup files are in use and cannot be deleted. Please try again later.';
    }
    
    // Policy evaluation errors
    if (lowerMessage.includes('evaluation') || lowerMessage.includes('evaluate')) {
      return 'Failed to evaluate which backups to delete. Please check your retention policy settings.';
    }
    
    // Backup deletion errors
    if (lowerMessage.includes('delete') || lowerMessage.includes('removal')) {
      return 'Failed to delete some backup files. Please check file permissions and try again.';
    }
    
    // Fallback to a generic but helpful message
    return `Retention policy operation failed. Please check your settings and file permissions.`;
  }
};