/**
 * Download error tracking and categorization system
 */
/// <reference path="../../electron.d.ts" />
import logger from '../logger.js';

// Error types enum
export const ERROR_TYPES = {
  NETWORK: 'network',
  CHECKSUM: 'checksum',
  TIMEOUT: 'timeout',
  SERVER: 'server',
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  UNKNOWN: 'unknown'
};

// Error severity levels
export const ERROR_SEVERITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

// Recovery suggestion types
export const RECOVERY_SUGGESTIONS = {
  RETRY: 'retry',
  FALLBACK: 'fallback',
  CHECK_CONNECTION: 'check_connection',
  CONTACT_ADMIN: 'contact_admin',
  UPDATE_MOD: 'update_mod',
  MANUAL_DOWNLOAD: 'manual_download'
};

/**
 * DownloadError interface implementation
 */
export class DownloadError {
  /**
   * Create a new download error
   * @param {Object} options - Error options
   * @param {string} options.type - Error type from ERROR_TYPES
   * @param {string} options.message - Error message
   * @param {string} options.source - Download source
   * @param {number} options.attempt - Attempt number
   * @param {Object} [options.details] - Additional error details
   * @param {string} [options.modId] - Mod ID
   * @param {string} [options.modName] - Mod name
   */
  constructor(options) {
    this.id = this.generateErrorId();
    this.timestamp = Date.now();
    this.type = options.type || ERROR_TYPES.UNKNOWN;
    this.message = options.message || 'Unknown error occurred';
    this.source = options.source || 'unknown';
    this.attempt = options.attempt || 1;
    this.modId = options.modId || null;
    this.modName = options.modName || null;
    this.details = options.details || {};
    
    // Categorize error automatically
    this.category = this.categorizeError();
    this.severity = this.determineSeverity();
    this.recoveryActions = this.generateRecoveryActions();
    this.userMessage = this.generateUserMessage();
    
    // Pattern detection fields
    this.pattern = this.detectPattern();
    this.fingerprint = this.generateFingerprint();
    
    logger.debug('Created download error', {
      category: 'mods',
      data: {
        function: 'DownloadError.constructor',
        errorId: this.id,
        type: this.type,
        category: this.category,
        severity: this.severity,
        source: this.source,
        attempt: this.attempt,
        modId: this.modId,
        modName: this.modName,
        pattern: this.pattern,
        fingerprint: this.fingerprint
      }
    });
  }

  /**
   * Generate unique error ID
   * @returns {string} Unique error ID
   */
  generateErrorId() {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Categorize error based on type and details
   * @returns {string} Error category
   */
  categorizeError() {
    const message = this.message.toLowerCase();
    const details = this.details || {};
    
    // Network-related errors
    if (this.type === ERROR_TYPES.NETWORK || 
        message.includes('network') || 
        message.includes('connection') ||
        message.includes('dns') ||
        message.includes('resolve')) {
      return 'network_connectivity';
    }
    
    // Timeout errors
    if (this.type === ERROR_TYPES.TIMEOUT || 
        message.includes('timeout') || 
        message.includes('timed out')) {
      return 'timeout';
    }
    
    // Server errors
    if (this.type === ERROR_TYPES.SERVER || 
        details.httpStatus >= 500 ||
        message.includes('server error') ||
        message.includes('internal server error')) {
      return 'server_error';
    }
    
    // Authentication/authorization errors
    if (this.type === ERROR_TYPES.FORBIDDEN || 
        details.httpStatus === 403 ||
        message.includes('forbidden') ||
        message.includes('unauthorized')) {
      return 'authentication';
    }
    
    // Resource not found errors
    if (this.type === ERROR_TYPES.NOT_FOUND || 
        details.httpStatus === 404 ||
        message.includes('not found') ||
        message.includes('does not exist')) {
      return 'resource_not_found';
    }
    
    // Checksum validation errors
    if (this.type === ERROR_TYPES.CHECKSUM || 
        message.includes('checksum') ||
        message.includes('integrity') ||
        details.checksumMismatch) {
      return 'file_integrity';
    }
    
    // File system errors
    if (message.includes('permission') ||
        message.includes('access denied') ||
        message.includes('disk space') ||
        message.includes('file system')) {
      return 'file_system';
    }
    
    return 'unknown';
  }

  /**
   * Determine error severity
   * @returns {string} Error severity level
   */
  determineSeverity() {
    // Critical errors that prevent all downloads
    if (this.category === 'file_system' || 
        (this.category === 'network_connectivity' && this.attempt >= 3)) {
      return ERROR_SEVERITY.CRITICAL;
    }
    
    // High severity errors that likely need admin intervention
    if (this.category === 'server_error' || 
        this.category === 'authentication' ||
        (this.category === 'file_integrity' && this.attempt >= 2)) {
      return ERROR_SEVERITY.HIGH;
    }
    
    // Medium severity errors that might resolve with retry
    if (this.category === 'timeout' || 
        this.category === 'resource_not_found' ||
        (this.category === 'network_connectivity' && this.attempt < 3)) {
      return ERROR_SEVERITY.MEDIUM;
    }
    
    // Low severity errors that are likely transient
    return ERROR_SEVERITY.LOW;
  }

  /**
   * Generate recovery action suggestions
   * @returns {Array<string>} Array of recovery suggestions
   */
  generateRecoveryActions() {
    const actions = [];
    
    switch (this.category) {
      case 'network_connectivity':
        actions.push(RECOVERY_SUGGESTIONS.CHECK_CONNECTION);
        if (this.attempt < 3) {
          actions.push(RECOVERY_SUGGESTIONS.RETRY);
        }
        actions.push(RECOVERY_SUGGESTIONS.FALLBACK);
        break;
        
      case 'timeout':
        actions.push(RECOVERY_SUGGESTIONS.RETRY);
        actions.push(RECOVERY_SUGGESTIONS.FALLBACK);
        break;
        
      case 'server_error':
        actions.push(RECOVERY_SUGGESTIONS.FALLBACK);
        actions.push(RECOVERY_SUGGESTIONS.CONTACT_ADMIN);
        break;
        
      case 'authentication':
        actions.push(RECOVERY_SUGGESTIONS.CONTACT_ADMIN);
        actions.push(RECOVERY_SUGGESTIONS.FALLBACK);
        break;
        
      case 'resource_not_found':
        actions.push(RECOVERY_SUGGESTIONS.UPDATE_MOD);
        actions.push(RECOVERY_SUGGESTIONS.FALLBACK);
        actions.push(RECOVERY_SUGGESTIONS.MANUAL_DOWNLOAD);
        break;
        
      case 'file_integrity':
        actions.push(RECOVERY_SUGGESTIONS.RETRY);
        actions.push(RECOVERY_SUGGESTIONS.FALLBACK);
        if (this.attempt >= 2) {
          actions.push(RECOVERY_SUGGESTIONS.CONTACT_ADMIN);
        }
        break;
        
      case 'file_system':
        actions.push(RECOVERY_SUGGESTIONS.CONTACT_ADMIN);
        break;
        
      default:
        actions.push(RECOVERY_SUGGESTIONS.RETRY);
        actions.push(RECOVERY_SUGGESTIONS.FALLBACK);
    }
    
    return actions;
  }

  /**
   * Generate user-friendly error message
   * @returns {string} User-friendly error message
   */
  generateUserMessage() {
    const modName = this.modName || 'mod';
    
    switch (this.category) {
      case 'network_connectivity':
        return `Unable to connect to download server for ${modName}. Please check your internet connection.`;
        
      case 'timeout':
        return `Download of ${modName} timed out. The server may be slow or overloaded.`;
        
      case 'server_error':
        return `Server error occurred while downloading ${modName}. The download server may be experiencing issues.`;
        
      case 'authentication':
        return `Access denied when downloading ${modName}. You may not have permission to download this file.`;
        
      case 'resource_not_found':
        return `${modName} could not be found on the server. The file may have been moved or deleted.`;
        
      case 'file_integrity':
        return `Downloaded file for ${modName} failed integrity check. The file may be corrupted.`;
        
      case 'file_system':
        return `Unable to save ${modName} to disk. Check available disk space and file permissions.`;
        
      default:
        return `An error occurred while downloading ${modName}: ${this.message}`;
    }
  }

  /**
   * Detect error patterns for aggregation
   * @returns {string} Error pattern identifier
   */
  detectPattern() {
    // Create pattern based on error characteristics
    const components = [
      this.category,
      this.source,
      this.details.httpStatus ? `http_${this.details.httpStatus}` : null,
      this.type
    ].filter(Boolean);
    
    return components.join('_');
  }

  /**
   * Generate error fingerprint for deduplication
   * @returns {string} Error fingerprint
   */
  generateFingerprint() {
    // Create fingerprint for similar errors
    const components = [
      this.type,
      this.category,
      this.source,
      this.details.httpStatus || 'no_status',
      this.modId || 'no_mod'
    ];
    
    return components.join('|');
  }

  /**
   * Convert error to JSON for logging/storage
   * @returns {Object} JSON representation of error
   */
  toJSON() {
    return {
      id: this.id,
      timestamp: this.timestamp,
      type: this.type,
      category: this.category,
      severity: this.severity,
      message: this.message,
      userMessage: this.userMessage,
      source: this.source,
      attempt: this.attempt,
      modId: this.modId,
      modName: this.modName,
      details: this.details,
      recoveryActions: this.recoveryActions,
      pattern: this.pattern,
      fingerprint: this.fingerprint
    };
  }
}

/**
 * Error aggregation and pattern detection system
 */
export class ErrorAggregator {
  constructor() {
    this.errors = new Map(); // errorId -> DownloadError
    this.patterns = new Map(); // pattern -> count
    this.fingerprints = new Map(); // fingerprint -> [errorIds]
    this.modErrors = new Map(); // modId -> [errorIds]
    this.sourceErrors = new Map(); // source -> [errorIds]
    this.timeWindows = new Map(); // timeWindow -> [errorIds]
    
    logger.debug('Error aggregator initialized', {
      category: 'mods',
      data: {
        function: 'ErrorAggregator.constructor'
      }
    });
  }

  /**
   * Add error to aggregation system
   * @param {DownloadError} error - Error to add
   */
  addError(error) {
    if (!(error instanceof DownloadError)) {
      logger.warn('Attempted to add non-DownloadError to aggregator', {
        category: 'mods',
        data: {
          function: 'ErrorAggregator.addError',
          errorType: typeof error,
          hasId: !!(error && typeof error === 'object' && 'id' in error)
        }
      });
      return;
    }
    
    // Store error
    this.errors.set(error.id, error);
    
    // Update pattern tracking
    const currentPatternCount = this.patterns.get(error.pattern) || 0;
    this.patterns.set(error.pattern, currentPatternCount + 1);
    
    // Update fingerprint tracking
    const fingerprintErrors = this.fingerprints.get(error.fingerprint) || [];
    fingerprintErrors.push(error.id);
    this.fingerprints.set(error.fingerprint, fingerprintErrors);
    
    // Update mod error tracking
    if (error.modId) {
      const modErrors = this.modErrors.get(error.modId) || [];
      modErrors.push(error.id);
      this.modErrors.set(error.modId, modErrors);
    }
    
    // Update source error tracking
    const sourceErrors = this.sourceErrors.get(error.source) || [];
    sourceErrors.push(error.id);
    this.sourceErrors.set(error.source, sourceErrors);
    
    // Update time window tracking (1 hour windows)
    const timeWindow = Math.floor(error.timestamp / (60 * 60 * 1000));
    const windowErrors = this.timeWindows.get(timeWindow) || [];
    windowErrors.push(error.id);
    this.timeWindows.set(timeWindow, windowErrors);
    
    logger.debug('Error added to aggregator', {
      category: 'mods',
      data: {
        function: 'ErrorAggregator.addError',
        errorId: error.id,
        pattern: error.pattern,
        fingerprint: error.fingerprint,
        modId: error.modId,
        source: error.source,
        patternCount: this.patterns.get(error.pattern),
        totalErrors: this.errors.size
      }
    });
    
    // Check for concerning patterns
    this.checkForPatterns(error);
  }

  /**
   * Check for concerning error patterns
   * @param {DownloadError} error - Latest error
   */
  checkForPatterns(error) {
    const patternCount = this.patterns.get(error.pattern);
    const fingerprintErrors = this.fingerprints.get(error.fingerprint);
    
    // Alert on repeated patterns
    if (patternCount >= 5) {
      logger.warn('High frequency error pattern detected', {
        category: 'mods',
        data: {
          function: 'ErrorAggregator.checkForPatterns',
          pattern: error.pattern,
          count: patternCount,
          severity: 'pattern_alert',
          errorCategory: error.category,
          source: error.source
        }
      });
    }
    
    // Alert on duplicate fingerprints (same error recurring)
    if (fingerprintErrors.length >= 3) {
      logger.warn('Recurring error detected', {
        category: 'mods',
        data: {
          function: 'ErrorAggregator.checkForPatterns',
          fingerprint: error.fingerprint,
          occurrences: fingerprintErrors.length,
          severity: 'recurring_error',
          modId: error.modId,
          source: error.source,
          errorIds: fingerprintErrors
        }
      });
    }
    
    // Alert on mod-specific issues
    if (error.modId) {
      const modErrorCount = this.modErrors.get(error.modId)?.length || 0;
      if (modErrorCount >= 3) {
        logger.warn('Mod-specific download issues detected', {
          category: 'mods',
          data: {
            function: 'ErrorAggregator.checkForPatterns',
            modId: error.modId,
            modName: error.modName,
            errorCount: modErrorCount,
            severity: 'mod_specific_issues'
          }
        });
      }
    }
  }

  /**
   * Get error statistics
   * @returns {Object} Error statistics
   */
  getStatistics() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
    const recentErrors = Array.from(this.errors.values())
      .filter(error => error.timestamp > oneHourAgo);
    
    const dailyErrors = Array.from(this.errors.values())
      .filter(error => error.timestamp > oneDayAgo);
    
    const stats = {
      total: this.errors.size,
      lastHour: recentErrors.length,
      lastDay: dailyErrors.length,
      patterns: this.patterns.size,
      uniqueFingerprints: this.fingerprints.size,
      affectedMods: this.modErrors.size,
      affectedSources: this.sourceErrors.size,
      
      // Error breakdown by category
      byCategory: {},
      bySeverity: {},
      bySource: {},
      
      // Top patterns
      topPatterns: Array.from(this.patterns.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10),
      
      // Most problematic mods
      problematicMods: Array.from(this.modErrors.entries())
        .map(([modId, errorIds]) => ({
          modId,
          errorCount: errorIds.length,
          latestError: Math.max(...errorIds.map(id => this.errors.get(id)?.timestamp || 0))
        }))
        .sort((a, b) => b.errorCount - a.errorCount)
        .slice(0, 10)
    };
    
    // Calculate category breakdown
    Array.from(this.errors.values()).forEach(error => {
      stats.byCategory[error.category] = (stats.byCategory[error.category] || 0) + 1;
      stats.bySeverity[error.severity] = (stats.bySeverity[error.severity] || 0) + 1;
      stats.bySource[error.source] = (stats.bySource[error.source] || 0) + 1;
    });
    
    return stats;
  }

  /**
   * Get errors by pattern
   * @param {string} pattern - Pattern to search for
   * @returns {Array<DownloadError>} Errors matching pattern
   */
  getErrorsByPattern(pattern) {
    return Array.from(this.errors.values())
      .filter(error => error.pattern === pattern);
  }

  /**
   * Get errors by fingerprint
   * @param {string} fingerprint - Fingerprint to search for
   * @returns {Array<DownloadError>} Errors matching fingerprint
   */
  getErrorsByFingerprint(fingerprint) {
    const errorIds = this.fingerprints.get(fingerprint) || [];
    return errorIds.map(id => this.errors.get(id)).filter(Boolean);
  }

  /**
   * Get errors for specific mod
   * @param {string} modId - Mod ID
   * @returns {Array<DownloadError>} Errors for the mod
   */
  getModErrors(modId) {
    const errorIds = this.modErrors.get(modId) || [];
    return errorIds.map(id => this.errors.get(id)).filter(Boolean);
  }

  /**
   * Clean up old errors (older than 7 days)
   */
  cleanup() {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let cleanedCount = 0;
    
    const errorEntries = Array.from(this.errors.entries());
    for (const [errorId, error] of errorEntries) {
      if (error.timestamp < sevenDaysAgo) {
        this.removeError(errorId);
        cleanedCount++;
      }
    }
    
    logger.info('Error aggregator cleanup completed', {
      category: 'mods',
      data: {
        function: 'ErrorAggregator.cleanup',
        cleanedCount,
        remainingErrors: this.errors.size
      }
    });
  }

  /**
   * Remove error from all tracking structures
   * @param {string} errorId - Error ID to remove
   */
  removeError(errorId) {
    const error = this.errors.get(errorId);
    if (!error) return;
    
    // Remove from main storage
    this.errors.delete(errorId);
    
    // Update pattern count
    const patternCount = this.patterns.get(error.pattern) || 0;
    if (patternCount <= 1) {
      this.patterns.delete(error.pattern);
    } else {
      this.patterns.set(error.pattern, patternCount - 1);
    }
    
    // Remove from fingerprint tracking
    const fingerprintErrors = this.fingerprints.get(error.fingerprint) || [];
    const updatedFingerprintErrors = fingerprintErrors.filter(id => id !== errorId);
    if (updatedFingerprintErrors.length === 0) {
      this.fingerprints.delete(error.fingerprint);
    } else {
      this.fingerprints.set(error.fingerprint, updatedFingerprintErrors);
    }
    
    // Remove from mod tracking
    if (error.modId) {
      const modErrors = this.modErrors.get(error.modId) || [];
      const updatedModErrors = modErrors.filter(id => id !== errorId);
      if (updatedModErrors.length === 0) {
        this.modErrors.delete(error.modId);
      } else {
        this.modErrors.set(error.modId, updatedModErrors);
      }
    }
    
    // Remove from source tracking
    const sourceErrors = this.sourceErrors.get(error.source) || [];
    const updatedSourceErrors = sourceErrors.filter(id => id !== errorId);
    if (updatedSourceErrors.length === 0) {
      this.sourceErrors.delete(error.source);
    } else {
      this.sourceErrors.set(error.source, updatedSourceErrors);
    }
  }
}

// Global error aggregator instance
export const globalErrorAggregator = new ErrorAggregator();

// Schedule periodic cleanup
setInterval(() => {
  globalErrorAggregator.cleanup();
}, 24 * 60 * 60 * 1000); // Daily cleanup