/**
 * Backup Retention Policy Engine (CommonJS version for backend)
 * Provides configurable retention policies for backup management
 */

/**
 * Retention Policy class for managing backup cleanup based on various criteria
 */
class RetentionPolicy {
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
   * Validate the retention policy configuration
   * @private
   */
  _validateConfiguration() {
    if (this.maxSize !== null && (typeof this.maxSize !== 'number' || this.maxSize <= 0)) {
      throw new Error('maxSize must be a positive number or null');
    }
    
    if (this.maxAge !== null && (typeof this.maxAge !== 'number' || this.maxAge <= 0)) {
      throw new Error('maxAge must be a positive number or null');
    }
    
    if (this.maxCount !== null && (typeof this.maxCount !== 'number' || this.maxCount <= 0)) {
      throw new Error('maxCount must be a positive number or null');
    }
    
    if (typeof this.preserveRecent !== 'number' || this.preserveRecent < 1) {
      throw new Error('preserveRecent must be a positive number >= 1');
    }
  }

  /**
   * Evaluate backups against retention policies and return backups to delete
   * @param {Array} backups - Array of backup objects with name, size, created properties
   * @returns {Promise<Array>} Array of backup objects that should be deleted
   */
  async evaluateBackups(backups) {
    if (!Array.isArray(backups)) {
      throw new Error('Backups must be an array');
    }

    if (backups.length === 0) {
      return [];
    }

    // Sort backups by creation date (newest first)
    const sortedBackups = this._sortBackupsByAge(backups);
    
    // Collect all violations from different policies
    const violations = new Set();
    
    // Apply size-based retention
    if (this.maxSize !== null) {
      const sizeViolations = this._findSizeViolations(sortedBackups);
      sizeViolations.forEach(backup => violations.add(backup));
    }
    
    // Apply age-based retention
    if (this.maxAge !== null) {
      const ageViolations = this._findAgeViolations(sortedBackups);
      ageViolations.forEach(backup => violations.add(backup));
    }
    
    // Apply count-based retention
    if (this.maxCount !== null) {
      const countViolations = this._findCountViolations(sortedBackups);
      countViolations.forEach(backup => violations.add(backup));
    }
    
    // Convert Set back to Array and ensure we preserve recent backups
    const toDelete = Array.from(violations);
    return this._preserveRecentBackups(toDelete, sortedBackups);
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
   * Check if the policy has any active rules
   * @returns {boolean} True if any retention rules are active
   */
  hasActiveRules() {
    return this.maxSize !== null || this.maxAge !== null || this.maxCount !== null;
  }
}

module.exports = { RetentionPolicy };