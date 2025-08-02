/**
 * Server-side error monitoring and logging handlers
 */
// const fs = require('fs');
// const path = require('path');
const { getLoggerHandlers } = require('./logger-handlers.cjs');

/**
 * Error aggregation and monitoring system for server-side operations
 */
class ServerErrorMonitor {
  constructor() {
    this.logger = getLoggerHandlers();
    this.errorLog = [];
    this.maxLogSize = 10000; // Maximum number of errors to keep in memory
    this.errorPatterns = new Map(); // Pattern -> count
    this.checksumErrors = new Map(); // File -> error details
    this.downloadFailures = new Map(); // Source -> failure count
    this.sessionStats = {
      totalErrors: 0,
      checksumErrors: 0,
      networkErrors: 0,
      serverErrors: 0,
      sessionStart: Date.now()
    };
    
    // Start periodic cleanup and reporting
    this.startPeriodicTasks();
    
    this.logger.info('Server error monitor initialized', {
      category: 'mods',
      data: {
        service: 'ServerErrorMonitor',
        maxLogSize: this.maxLogSize,
        sessionStart: this.sessionStats.sessionStart
      }
    });
  }

  /**
   * Log download error with detailed context
   * @param {Object} errorData - Error information
   */
  logDownloadError(errorData) {
    const errorEntry = {
      id: this.generateErrorId(),
      timestamp: Date.now(),
      type: errorData.type || 'unknown',
      category: this.categorizeError(errorData),
      severity: this.determineSeverity(errorData),
      message: errorData.message || 'Unknown error',
      source: errorData.source || 'unknown',
      modId: errorData.modId,
      modName: errorData.modName,
      attempt: errorData.attempt || 1,
      totalAttempts: errorData.totalAttempts || 1,
      
      // Context information
      context: {
        downloadUrl: errorData.downloadUrl,
        filePath: errorData.filePath,
        fileSize: errorData.fileSize,
        httpStatus: errorData.httpStatus,
        timeout: errorData.timeout,
        retryDelay: errorData.retryDelay,
        userAgent: errorData.userAgent,
        serverVersion: process.version
      },
      
      // Error details
      details: {
        stack: errorData.stack,
        errorType: errorData.errorType,
        networkDetails: errorData.networkDetails,
        checksumDetails: errorData.checksumDetails
      }
    };
    
    // Add to error log
    this.addToErrorLog(errorEntry);
    
    // Update statistics
    this.updateStatistics(errorEntry);
    
    // Check for patterns
    this.detectPatterns(errorEntry);
    
    this.logger.error('Download error logged', {
      category: 'mods',
      data: {
        service: 'ServerErrorMonitor',
        errorId: errorEntry.id,
        type: errorEntry.type,
        category: errorEntry.category,
        severity: errorEntry.severity,
        modName: errorEntry.modName,
        source: errorEntry.source,
        attempt: errorEntry.attempt
      }
    });
    
    return errorEntry;
  }

  /**
   * Log checksum validation error
   * @param {Object} checksumData - Checksum error details
   */
  logChecksumError(checksumData) {
    const errorEntry = {
      id: this.generateErrorId(),
      timestamp: Date.now(),
      type: 'checksum',
      category: 'file_integrity',
      severity: 'medium',
      message: `Checksum validation failed: expected ${checksumData.expected}, got ${checksumData.actual}`,
      source: checksumData.source || 'unknown',
      modId: checksumData.modId,
      modName: checksumData.modName,
      attempt: checksumData.attempt || 1,
      
      context: {
        filePath: checksumData.filePath,
        fileSize: checksumData.fileSize,
        algorithm: checksumData.algorithm || 'sha1',
        downloadUrl: checksumData.downloadUrl
      },
      
      details: {
        expected: checksumData.expected,
        actual: checksumData.actual,
        algorithm: checksumData.algorithm || 'sha1',
        validationTime: checksumData.validationTime || Date.now()
      }
    };
    
    // Track checksum errors by file
    const fileKey = `${checksumData.modId}_${checksumData.source}`;
    if (!this.checksumErrors.has(fileKey)) {
      this.checksumErrors.set(fileKey, []);
    }
    this.checksumErrors.get(fileKey).push(errorEntry);
    
    this.addToErrorLog(errorEntry);
    this.updateStatistics(errorEntry);
    this.detectPatterns(errorEntry);
    
    this.logger.error('Checksum error logged', {
      category: 'mods',
      data: {
        service: 'ServerErrorMonitor',
        errorId: errorEntry.id,
        modName: errorEntry.modName,
        source: errorEntry.source,
        expected: checksumData.expected,
        actual: checksumData.actual,
        algorithm: checksumData.algorithm
      }
    });
    
    return errorEntry;
  }

  /**
   * Generate unique error ID
   * @returns {string} Error ID
   */
  generateErrorId() {
    return `srv_err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Categorize error based on type and details
   * @param {Object} errorData - Error data
   * @returns {string} Error category
   */
  categorizeError(errorData) {
    const message = (errorData.message || '').toLowerCase();
    const type = errorData.type || 'unknown';
    
    if (type === 'checksum' || message.includes('checksum') || message.includes('integrity')) {
      return 'file_integrity';
    }
    
    if (message.includes('timeout') || message.includes('timed out')) {
      return 'timeout';
    }
    
    if (message.includes('network') || message.includes('connection') || 
        message.includes('dns') || message.includes('resolve')) {
      return 'network_connectivity';
    }
    
    if (errorData.httpStatus >= 500 || message.includes('server error')) {
      return 'server_error';
    }
    
    if (errorData.httpStatus === 404 || message.includes('not found')) {
      return 'resource_not_found';
    }
    
    if (errorData.httpStatus === 403 || message.includes('forbidden')) {
      return 'authentication';
    }
    
    if (message.includes('permission') || message.includes('access denied') || 
        message.includes('disk space')) {
      return 'file_system';
    }
    
    return 'unknown';
  }

  /**
   * Determine error severity
   * @param {Object} errorData - Error data
   * @returns {string} Severity level
   */
  determineSeverity(errorData) {
    const category = this.categorizeError(errorData);
    const attempt = errorData.attempt || 1;
    
    if (category === 'file_system') {
      return 'critical';
    }
    
    if (category === 'server_error' || category === 'authentication') {
      return 'high';
    }
    
    if (category === 'file_integrity' && attempt >= 2) {
      return 'high';
    }
    
    if (category === 'timeout' || category === 'resource_not_found') {
      return 'medium';
    }
    
    return 'low';
  }

  /**
   * Add error to log with size management
   * @param {Object} errorEntry - Error entry
   */
  addToErrorLog(errorEntry) {
    this.errorLog.push(errorEntry);
    
    // Manage log size
    if (this.errorLog.length > this.maxLogSize) {
      this.errorLog = this.errorLog.slice(-this.maxLogSize);
      
      this.logger.debug('Error log size limit reached, oldest entries removed', {
        category: 'mods',
        data: {
          service: 'ServerErrorMonitor',
          maxLogSize: this.maxLogSize,
          currentSize: this.errorLog.length
        }
      });
    }
  }

  /**
   * Update error statistics
   * @param {Object} errorEntry - Error entry
   */
  updateStatistics(errorEntry) {
    this.sessionStats.totalErrors++;
    
    switch (errorEntry.category) {
      case 'file_integrity':
        this.sessionStats.checksumErrors++;
        break;
      case 'network_connectivity':
      case 'timeout':
        this.sessionStats.networkErrors++;
        break;
      case 'server_error':
        this.sessionStats.serverErrors++;
        break;
    }
    
    // Track download failures by source
    const source = errorEntry.source;
    const currentCount = this.downloadFailures.get(source) || 0;
    this.downloadFailures.set(source, currentCount + 1);
  }

  /**
   * Detect error patterns
   * @param {Object} errorEntry - Error entry
   */
  detectPatterns(errorEntry) {
    const pattern = `${errorEntry.category}_${errorEntry.source}_${errorEntry.type}`;
    const currentCount = this.errorPatterns.get(pattern) || 0;
    this.errorPatterns.set(pattern, currentCount + 1);
    
    // Alert on concerning patterns
    if (currentCount + 1 >= 5) {
      this.logger.warn('High frequency error pattern detected', {
        category: 'mods',
        data: {
          service: 'ServerErrorMonitor',
          pattern,
          count: currentCount + 1,
          category: errorEntry.category,
          source: errorEntry.source,
          severity: 'pattern_alert'
        }
      });
    }
    
    // Check for checksum error patterns
    if (errorEntry.category === 'file_integrity') {
      const fileKey = `${errorEntry.modId}_${errorEntry.source}`;
      const fileErrors = this.checksumErrors.get(fileKey) || [];
      
      if (fileErrors.length >= 3) {
        this.logger.warn('Repeated checksum failures for file', {
          category: 'mods',
          data: {
            service: 'ServerErrorMonitor',
            modId: errorEntry.modId,
            modName: errorEntry.modName,
            source: errorEntry.source,
            failureCount: fileErrors.length,
            severity: 'file_corruption_suspected'
          }
        });
      }
    }
  }

  /**
   * Get error statistics for monitoring
   * @returns {Object} Error statistics
   */
  getStatistics() {
    const now = Date.now();
    const sessionDuration = now - this.sessionStats.sessionStart;
    const recentErrors = this.errorLog.filter(error => 
      now - error.timestamp < 60 * 60 * 1000 // Last hour
    );
    
    return {
      session: {
        ...this.sessionStats,
        duration: sessionDuration,
        errorRate: this.sessionStats.totalErrors / (sessionDuration / 1000 / 60) // errors per minute
      },
      recent: {
        totalErrors: recentErrors.length,
        byCategory: this.groupBy(recentErrors, 'category'),
        bySeverity: this.groupBy(recentErrors, 'severity'),
        bySource: this.groupBy(recentErrors, 'source')
      },
      patterns: {
        topPatterns: Array.from(this.errorPatterns.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10),
        checksumIssues: Array.from(this.checksumErrors.entries())
          .map(([fileKey, errors]) => ({
            fileKey,
            errorCount: errors.length,
            latestError: Math.max(...errors.map(e => e.timestamp))
          }))
          .sort((a, b) => b.errorCount - a.errorCount)
          .slice(0, 10),
        sourceFailures: Array.from(this.downloadFailures.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
      }
    };
  }

  /**
   * Group array by property
   * @param {Array} array - Array to group
   * @param {string} property - Property to group by
   * @returns {Object} Grouped object
   */
  groupBy(array, property) {
    return array.reduce((groups, item) => {
      const key = item[property] || 'unknown';
      groups[key] = (groups[key] || 0) + 1;
      return groups;
    }, {});
  }

  /**
   * Generate error report for administrators
   * @param {Object} options - Report options
   * @returns {Object} Error report
   */
  generateErrorReport(options = {}) {
    const timeRange = options.timeRange || (24 * 60 * 60 * 1000); // 24 hours
    const cutoffTime = Date.now() - timeRange;
    
    const relevantErrors = this.errorLog.filter(error => error.timestamp > cutoffTime);
    
    const report = {
      generatedAt: Date.now(),
      timeRange,
      serverInfo: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime: process.uptime()
      },
      summary: {
        totalErrors: relevantErrors.length,
        uniquePatterns: new Set(relevantErrors.map(e => 
          `${e.category}_${e.source}_${e.type}`
        )).size,
        affectedMods: new Set(relevantErrors.map(e => e.modId).filter(Boolean)).size,
        criticalErrors: relevantErrors.filter(e => e.severity === 'critical').length,
        highSeverityErrors: relevantErrors.filter(e => e.severity === 'high').length
      },
      breakdown: {
        byCategory: this.groupBy(relevantErrors, 'category'),
        bySeverity: this.groupBy(relevantErrors, 'severity'),
        bySource: this.groupBy(relevantErrors, 'source'),
        byHour: this.groupByTimeWindow(relevantErrors, 60 * 60 * 1000) // Hourly breakdown
      },
      topIssues: {
        mostProblematicMods: this.getMostProblematicMods(relevantErrors),
        frequentPatterns: this.getFrequentPatterns(relevantErrors),
        checksumFailures: this.getChecksumFailures(relevantErrors)
      },
      recommendations: this.generateRecommendations()
    };
    
    return report;
  }

  /**
   * Group errors by time window
   * @param {Array} errors - Errors to group
   * @param {number} windowSize - Window size in milliseconds
   * @returns {Object} Time-grouped errors
   */
  groupByTimeWindow(errors, windowSize) {
    const windows = {};
    
    errors.forEach(error => {
      const windowStart = Math.floor(error.timestamp / windowSize) * windowSize;
      const windowKey = new Date(windowStart).toISOString();
      windows[windowKey] = (windows[windowKey] || 0) + 1;
    });
    
    return windows;
  }

  /**
   * Get most problematic mods
   * @param {Array} errors - Errors to analyze
   * @returns {Array} Most problematic mods
   */
  getMostProblematicMods(errors) {
    const modCounts = {};
    
    errors.forEach(error => {
      if (error.modId) {
        const key = error.modId;
        if (!modCounts[key]) {
          modCounts[key] = {
            modId: error.modId,
            modName: error.modName,
            errorCount: 0,
            categories: new Set(),
            sources: new Set(),
            latestError: 0
          };
        }
        
        modCounts[key].errorCount++;
        modCounts[key].categories.add(error.category);
        modCounts[key].sources.add(error.source);
        modCounts[key].latestError = Math.max(modCounts[key].latestError, error.timestamp);
      }
    });
    
    return Object.values(modCounts)
      .map(mod => ({
        ...mod,
        categories: Array.from(mod.categories),
        sources: Array.from(mod.sources)
      }))
      .sort((a, b) => b.errorCount - a.errorCount)
      .slice(0, 10);
  }

  /**
   * Get frequent error patterns
   * @param {Array} errors - Errors to analyze
   * @returns {Array} Frequent patterns
   */
  getFrequentPatterns(errors) {
    const patterns = {};
    
    errors.forEach(error => {
      const pattern = `${error.category}_${error.source}_${error.type}`;
      if (!patterns[pattern]) {
        patterns[pattern] = {
          pattern,
          category: error.category,
          source: error.source,
          type: error.type,
          count: 0,
          firstOccurrence: error.timestamp,
          lastOccurrence: error.timestamp,
          affectedMods: new Set()
        };
      }
      
      patterns[pattern].count++;
      patterns[pattern].lastOccurrence = Math.max(patterns[pattern].lastOccurrence, error.timestamp);
      patterns[pattern].firstOccurrence = Math.min(patterns[pattern].firstOccurrence, error.timestamp);
      
      if (error.modId) {
        patterns[pattern].affectedMods.add(error.modId);
      }
    });
    
    return Object.values(patterns)
      .map(pattern => ({
        ...pattern,
        affectedModsCount: pattern.affectedMods.size,
        affectedMods: undefined // Remove Set for JSON serialization
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  /**
   * Get checksum failure analysis
   * @param {Array} errors - Errors to analyze
   * @returns {Array} Checksum failures
   */
  getChecksumFailures(errors) {
    const checksumErrors = errors.filter(error => error.category === 'file_integrity');
    const failures = {};
    
    checksumErrors.forEach(error => {
      const key = `${error.modId}_${error.source}`;
      if (!failures[key]) {
        failures[key] = {
          modId: error.modId,
          modName: error.modName,
          source: error.source,
          failureCount: 0,
          firstFailure: error.timestamp,
          lastFailure: error.timestamp,
          expectedChecksums: new Set(),
          actualChecksums: new Set()
        };
      }
      
      failures[key].failureCount++;
      failures[key].lastFailure = Math.max(failures[key].lastFailure, error.timestamp);
      failures[key].firstFailure = Math.min(failures[key].firstFailure, error.timestamp);
      
      if (error.details.expected) {
        failures[key].expectedChecksums.add(error.details.expected);
      }
      if (error.details.actual) {
        failures[key].actualChecksums.add(error.details.actual);
      }
    });
    
    return Object.values(failures)
      .map(failure => ({
        ...failure,
        expectedChecksumsCount: failure.expectedChecksums.size,
        actualChecksumsCount: failure.actualChecksums.size,
        expectedChecksums: undefined, // Remove Set for JSON serialization
        actualChecksums: undefined
      }))
      .sort((a, b) => b.failureCount - a.failureCount)
      .slice(0, 10);
  }

  /**
   * Generate recommendations based on error analysis
   * @returns {Array} Recommendations
   */
  generateRecommendations() {
    const recommendations = [];
    const stats = this.getStatistics();
    
    // High error rate recommendation
    if (stats.session.errorRate > 5) { // More than 5 errors per minute
      recommendations.push({
        priority: 'high',
        type: 'high_error_rate',
        title: 'High Error Rate Detected',
        description: `Current error rate: ${stats.session.errorRate.toFixed(2)} errors/minute`,
        suggestion: 'Check system resources, network connectivity, and server health',
        action: 'investigate_system_health'
      });
    }
    
    // Checksum error recommendation
    if (stats.session.checksumErrors > 10) {
      recommendations.push({
        priority: 'high',
        type: 'checksum_issues',
        title: 'Multiple Checksum Failures',
        description: `${stats.session.checksumErrors} checksum validation failures detected`,
        suggestion: 'Verify source file integrity and check for storage corruption',
        action: 'verify_file_integrity'
      });
    }
    
    // Network error recommendation
    if (stats.session.networkErrors > 20) {
      recommendations.push({
        priority: 'medium',
        type: 'network_issues',
        title: 'Network Connectivity Issues',
        description: `${stats.session.networkErrors} network-related errors detected`,
        suggestion: 'Check network connectivity, DNS resolution, and firewall settings',
        action: 'check_network_infrastructure'
      });
    }
    
    // Server error recommendation
    if (stats.session.serverErrors > 5) {
      recommendations.push({
        priority: 'high',
        type: 'server_issues',
        title: 'Server-Side Issues',
        description: `${stats.session.serverErrors} server errors detected`,
        suggestion: 'Check download server health and capacity',
        action: 'investigate_server_health'
      });
    }
    
    return recommendations;
  }

  /**
   * Start periodic tasks (cleanup, reporting)
   */
  startPeriodicTasks() {
    // Cleanup old errors every hour
    setInterval(() => {
      this.cleanupOldErrors();
    }, 60 * 60 * 1000);
    
    // Generate periodic reports every 6 hours
    setInterval(() => {
      this.generatePeriodicReport();
    }, 6 * 60 * 60 * 1000);
  }

  /**
   * Clean up old errors (older than 7 days)
   */
  cleanupOldErrors() {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const initialCount = this.errorLog.length;
    
    this.errorLog = this.errorLog.filter(error => error.timestamp > sevenDaysAgo);
    
    // Clean up checksum errors
    const checksumEntries = Array.from(this.checksumErrors.entries());
    for (const [fileKey, errors] of checksumEntries) {
      const filteredErrors = errors.filter(error => error.timestamp > sevenDaysAgo);
      if (filteredErrors.length === 0) {
        this.checksumErrors.delete(fileKey);
      } else {
        this.checksumErrors.set(fileKey, filteredErrors);
      }
    }
    
    const cleanedCount = initialCount - this.errorLog.length;
    
    if (cleanedCount > 0) {
      this.logger.info('Cleaned up old error entries', {
        category: 'mods',
        data: {
          service: 'ServerErrorMonitor',
          cleanedCount,
          remainingCount: this.errorLog.length
        }
      });
    }
  }

  /**
   * Generate periodic error report
   */
  generatePeriodicReport() {
    const report = this.generateErrorReport({ timeRange: 6 * 60 * 60 * 1000 }); // Last 6 hours
    
    if (report.summary.totalErrors > 0) {
      this.logger.info('Periodic error report generated', {
        category: 'mods',
        data: {
          service: 'ServerErrorMonitor',
          reportPeriod: '6_hours',
          totalErrors: report.summary.totalErrors,
          criticalErrors: report.summary.criticalErrors,
          highSeverityErrors: report.summary.highSeverityErrors,
          affectedMods: report.summary.affectedMods,
          recommendations: report.recommendations.length
        }
      });
      
      // Log high-priority recommendations
      report.recommendations
        .filter(rec => rec.priority === 'high')
        .forEach(rec => {
          this.logger.warn(`Recommendation: ${rec.title}`, {
            category: 'mods',
            data: {
              service: 'ServerErrorMonitor',
              recommendationType: rec.type,
              description: rec.description,
              suggestion: rec.suggestion,
              action: rec.action
            }
          });
        });
    }
  }
}

// Global server error monitor instance
const serverErrorMonitor = new ServerErrorMonitor();

/**
 * Create error monitoring handlers for IPC
 * @param {Object} win - Electron window
 * @returns {Object} Error monitoring handlers
 */
function createErrorMonitoringHandlers(win) {
  const logger = getLoggerHandlers();
  
  logger.info('Error monitoring handlers initialized', {
    category: 'mods',
    data: {
      handler: 'error-monitoring-handlers',
      hasWindow: !!win
    }
  });

  return {
    'log-download-errors': async (_e, { sessionId, entries, timestamp }) => {
      logger.debug('Logging download errors from frontend', {
        category: 'mods',
        data: {
          handler: 'log-download-errors',
          sessionId,
          entryCount: entries?.length || 0,
          timestamp
        }
      });

      try {
        // Process each error entry
        entries.forEach(entry => {
          if (entry.error && entry.error.type === 'checksum') {
            // Log checksum error
            serverErrorMonitor.logChecksumError({
              modId: entry.context?.modId,
              modName: entry.context?.modName,
              source: entry.context?.source,
              attempt: entry.context?.attempt,
              filePath: entry.downloadState?.filePath,
              fileSize: entry.downloadState?.totalBytes,
              expected: entry.error?.details?.checksumMismatch?.expected,
              actual: entry.error?.details?.checksumMismatch?.actual,
              algorithm: entry.error?.details?.checksumMismatch?.algorithm,
              downloadUrl: entry.downloadState?.downloadUrl,
              validationTime: entry.error?.timestamp
            });
          } else {
            // Log general download error
            serverErrorMonitor.logDownloadError({
              type: entry.error?.type,
              message: entry.error?.message,
              source: entry.context?.source,
              modId: entry.context?.modId,
              modName: entry.context?.modName,
              attempt: entry.context?.attempt,
              totalAttempts: entry.context?.totalAttempts,
              downloadUrl: entry.downloadState?.downloadUrl,
              filePath: entry.downloadState?.filePath,
              fileSize: entry.downloadState?.totalBytes,
              httpStatus: entry.error?.details?.httpDetails?.status,
              timeout: entry.error?.details?.networkDetails?.timeout,
              retryDelay: entry.error?.details?.networkDetails?.retryDelay,
              stack: entry.error?.details?.stack,
              errorType: entry.error?.details?.errorType,
              networkDetails: entry.error?.details?.networkDetails,
              checksumDetails: entry.error?.details?.checksumMismatch
            });
          }
        });

        logger.info('Download errors logged successfully', {
          category: 'mods',
          data: {
            handler: 'log-download-errors',
            sessionId,
            processedEntries: entries.length
          }
        });

        return { success: true, processedCount: entries.length };
      } catch (error) {
        logger.error(`Failed to log download errors: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'log-download-errors',
            sessionId,
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'get-error-statistics': async (_e, options = {}) => {
      logger.debug('Getting error statistics', {
        category: 'mods',
        data: {
          handler: 'get-error-statistics',
          options
        }
      });

      try {
        const statistics = serverErrorMonitor.getStatistics();
        
        logger.debug('Error statistics retrieved', {
          category: 'mods',
          data: {
            handler: 'get-error-statistics',
            totalErrors: statistics.session.totalErrors,
            recentErrors: statistics.recent.totalErrors,
            patterns: statistics.patterns.topPatterns.length
          }
        });

        return statistics;
      } catch (error) {
        logger.error(`Failed to get error statistics: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'get-error-statistics',
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    },

    'generate-error-report': async (_e, options = {}) => {
      logger.info('Generating error report', {
        category: 'mods',
        data: {
          handler: 'generate-error-report',
          timeRange: options.timeRange || '24_hours'
        }
      });

      try {
        const report = serverErrorMonitor.generateErrorReport(options);
        
        logger.info('Error report generated successfully', {
          category: 'mods',
          data: {
            handler: 'generate-error-report',
            totalErrors: report.summary.totalErrors,
            criticalErrors: report.summary.criticalErrors,
            affectedMods: report.summary.affectedMods,
            recommendations: report.recommendations.length
          }
        });

        return report;
      } catch (error) {
        logger.error(`Failed to generate error report: ${error.message}`, {
          category: 'mods',
          data: {
            handler: 'generate-error-report',
            errorType: error.constructor.name
          }
        });
        throw error;
      }
    }
  };
}

module.exports = {
  createErrorMonitoringHandlers,
  serverErrorMonitor
};