/**
 * Download error logging system with detailed context information
 */
/// <reference path="../../electron.d.ts" />
import logger from '../logger.js';
import { DownloadError, globalErrorAggregator, ERROR_TYPES } from './downloadErrorTracker.js';

/**
 * Enhanced error logging system for download operations
 */
export class DownloadErrorLogger {
  constructor() {
    this.sessionId = this.generateSessionId();
    this.logBuffer = [];
    this.maxBufferSize = 1000;
    this.flushInterval = 30000; // 30 seconds
    
    // Start periodic flush
    this.startPeriodicFlush();
    
    logger.info('Download error logger initialized', {
      category: 'mods',
      data: {
        function: 'DownloadErrorLogger.constructor',
        sessionId: this.sessionId,
        maxBufferSize: this.maxBufferSize,
        flushInterval: this.flushInterval
      }
    });
  }

  /**
   * Generate unique session ID
   * @returns {string} Session ID
   */
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Log download error with full context
   * @param {Error|Object} error - Error object or error data
   * @param {Object} context - Download context information
   * @param {string} context.modId - Mod ID
   * @param {string} context.modName - Mod name
   * @param {string} context.source - Download source
   * @param {number} context.attempt - Attempt number
   * @param {Object} [context.additionalData] - Additional context data
   */
  logError(error, context) {
    try {
      // Create DownloadError instance
      const downloadError = this.createDownloadError(error, context);
      
      // Add to aggregator for pattern detection
      globalErrorAggregator.addError(downloadError);
      
      // Create detailed log entry
      const logEntry = this.createLogEntry(downloadError, context);
      
      // Add to buffer
      this.addToBuffer(logEntry);
      
      // Log immediately for critical errors
      if (downloadError.severity === 'critical') {
        this.flushBuffer();
      }
      
      logger.error('Download error logged', {
        category: 'mods',
        data: {
          function: 'DownloadErrorLogger.logError',
          errorId: downloadError.id,
          modId: context.modId,
          modName: context.modName,
          source: context.source,
          attempt: context.attempt,
          errorType: downloadError.type,
          errorCategory: downloadError.category,
          severity: downloadError.severity,
          sessionId: this.sessionId
        }
      });
      
      return downloadError;
    } catch (logError) {
      logger.error(`Failed to log download error: ${logError.message}`, {
        category: 'mods',
        data: {
          function: 'DownloadErrorLogger.logError',
          originalError: error?.message || 'unknown',
          logError: logError.message,
          context
        }
      });
      return null;
    }
  }

  /**
   * Create DownloadError from error object and context
   * @param {Error|Object} error - Error object
   * @param {Object} context - Context information
   * @returns {DownloadError} Download error instance
   */
  createDownloadError(error, context) {
    let errorType = ERROR_TYPES.UNKNOWN;
    let errorMessage = 'Unknown error occurred';
    let errorDetails = {};
    
    if (error instanceof Error) {
      errorMessage = error.message;
      errorDetails.stack = error.stack;
      errorDetails.errorType = error.constructor.name;
      
      // Categorize based on error message
      errorType = this.categorizeErrorFromMessage(error.message);
    } else if (typeof error === 'object' && error !== null) {
      errorMessage = error.message || error.error || 'Unknown error';
      errorType = error.type || this.categorizeErrorFromMessage(errorMessage);
      errorDetails = { ...error };
    } else if (typeof error === 'string') {
      errorMessage = error;
      errorType = this.categorizeErrorFromMessage(error);
    }
    
    // Add context-specific details
    if (context.additionalData) {
      errorDetails = { ...errorDetails, ...context.additionalData };
    }
    
    return new DownloadError({
      type: errorType,
      message: errorMessage,
      source: context.source,
      attempt: context.attempt,
      modId: context.modId,
      modName: context.modName,
      details: errorDetails
    });
  }

  /**
   * Categorize error type from message
   * @param {string} message - Error message
   * @returns {string} Error type
   */
  categorizeErrorFromMessage(message) {
    const lowerMessage = message.toLowerCase();
    
    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      return ERROR_TYPES.TIMEOUT;
    }
    
    if (lowerMessage.includes('network') || lowerMessage.includes('connection') ||
        lowerMessage.includes('dns') || lowerMessage.includes('resolve')) {
      return ERROR_TYPES.NETWORK;
    }
    
    if (lowerMessage.includes('checksum') || lowerMessage.includes('integrity') ||
        lowerMessage.includes('hash') || lowerMessage.includes('validation')) {
      return ERROR_TYPES.CHECKSUM;
    }
    
    if (lowerMessage.includes('404') || lowerMessage.includes('not found')) {
      return ERROR_TYPES.NOT_FOUND;
    }
    
    if (lowerMessage.includes('403') || lowerMessage.includes('forbidden') ||
        lowerMessage.includes('unauthorized')) {
      return ERROR_TYPES.FORBIDDEN;
    }
    
    if (lowerMessage.includes('500') || lowerMessage.includes('server error') ||
        lowerMessage.includes('internal server')) {
      return ERROR_TYPES.SERVER;
    }
    
    return ERROR_TYPES.UNKNOWN;
  }

  /**
   * Create detailed log entry
   * @param {DownloadError} downloadError - Download error
   * @param {Object} context - Original context
   * @returns {Object} Log entry
   */
  createLogEntry(downloadError, context) {
    return {
      timestamp: downloadError.timestamp,
      sessionId: this.sessionId,
      errorId: downloadError.id,
      
      // Error information
      error: downloadError.toJSON(),
      
      // Context information
      context: {
        modId: context.modId,
        modName: context.modName,
        source: context.source,
        attempt: context.attempt,
        maxAttempts: context.maxAttempts || 3,
        totalAttempts: context.totalAttempts || context.attempt,
        ...context.additionalData
      },
      
      // System information
      system: {
        userAgent: navigator?.userAgent || 'unknown',
        platform: navigator?.platform || 'unknown',
        timestamp: Date.now(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      
      // Download state information
      downloadState: {
        downloadId: context.downloadId,
        startTime: context.startTime,
        duration: context.startTime ? Date.now() - context.startTime : null,
        bytesDownloaded: context.bytesDownloaded || 0,
        totalBytes: context.totalBytes || 0,
        speed: context.speed || 0
      }
    };
  }

  /**
   * Add log entry to buffer
   * @param {Object} logEntry - Log entry to buffer
   */
  addToBuffer(logEntry) {
    this.logBuffer.push(logEntry);
    
    // Prevent buffer overflow
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer = this.logBuffer.slice(-this.maxBufferSize);
      
      logger.warn('Error log buffer overflow, oldest entries removed', {
        category: 'mods',
        data: {
          function: 'DownloadErrorLogger.addToBuffer',
          maxBufferSize: this.maxBufferSize,
          currentSize: this.logBuffer.length
        }
      });
    }
  }

  /**
   * Start periodic buffer flush
   */
  startPeriodicFlush() {
    setInterval(() => {
      if (this.logBuffer.length > 0) {
        this.flushBuffer();
      }
    }, this.flushInterval);
  }

  /**
   * Flush log buffer to persistent storage
   */
  async flushBuffer() {
    if (this.logBuffer.length === 0) {
      return;
    }
    
    const entriesToFlush = [...this.logBuffer];
    this.logBuffer = [];
    
    try {
      // Send to backend for persistent storage
      if (window.electron && window.electron.invoke) {
        await window.electron.invoke('log-download-errors', {
          sessionId: this.sessionId,
          entries: entriesToFlush,
          timestamp: Date.now()
        });
        
        logger.debug('Error log buffer flushed to backend', {
          category: 'mods',
          data: {
            function: 'DownloadErrorLogger.flushBuffer',
            entryCount: entriesToFlush.length,
            sessionId: this.sessionId
          }
        });
      } else {
        // Fallback: log to console if IPC not available
        logger.warn('IPC not available, logging errors to console', {
          category: 'mods',
          data: {
            function: 'DownloadErrorLogger.flushBuffer',
            entryCount: entriesToFlush.length,
            errors: entriesToFlush
          }
        });
      }
    } catch (error) {
      logger.error(`Failed to flush error log buffer: ${error.message}`, {
        category: 'mods',
        data: {
          function: 'DownloadErrorLogger.flushBuffer',
          error: error.message,
          entryCount: entriesToFlush.length,
          sessionId: this.sessionId
        }
      });
      
      // Re-add entries to buffer for retry
      this.logBuffer.unshift(...entriesToFlush);
    }
  }

  /**
   * Log checksum validation error with detailed context
   * @param {Object} validation - Checksum validation result
   * @param {Object} context - Download context
   */
  logChecksumError(validation, context) {
    const error = {
      type: ERROR_TYPES.CHECKSUM,
      message: `Checksum validation failed: expected ${validation.expected}, got ${validation.actual}`,
      details: {
        expected: validation.expected,
        actual: validation.actual,
        algorithm: validation.algorithm,
        validationTime: validation.validationTime || Date.now(),
        checksumMismatch: {
          expected: validation.expected,
          actual: validation.actual,
          algorithm: validation.algorithm
        }
      }
    };
    
    return this.logError(error, {
      ...context,
      additionalData: {
        ...context.additionalData,
        checksumValidation: validation
      }
    });
  }

  /**
   * Log network error with connection details
   * @param {Error} error - Network error
   * @param {Object} context - Download context
   * @param {Object} networkDetails - Network-specific details
   */
  logNetworkError(error, context, networkDetails = {}) {
    return this.logError(error, {
      ...context,
      additionalData: {
        ...context.additionalData,
        networkDetails: {
          url: networkDetails.url,
          method: networkDetails.method || 'GET',
          headers: networkDetails.headers,
          timeout: networkDetails.timeout,
          retryDelay: networkDetails.retryDelay,
          connectionTime: networkDetails.connectionTime,
          ...networkDetails
        }
      }
    });
  }

  /**
   * Log server error with HTTP details
   * @param {Error} error - Server error
   * @param {Object} context - Download context
   * @param {Object} httpDetails - HTTP-specific details
   */
  logServerError(error, context, httpDetails = {}) {
    return this.logError(error, {
      ...context,
      additionalData: {
        ...context.additionalData,
        httpDetails: {
          status: httpDetails.status,
          statusText: httpDetails.statusText,
          headers: httpDetails.headers,
          responseTime: httpDetails.responseTime,
          serverInfo: httpDetails.serverInfo,
          ...httpDetails
        }
      }
    });
  }

  /**
   * Get error statistics for current session
   * @returns {Object} Session error statistics
   */
  getSessionStatistics() {
    const sessionErrors = Array.from(globalErrorAggregator.errors.values())
      .filter(error => this.logBuffer.some(entry => entry.errorId === error.id) ||
                      error.timestamp > Date.now() - (60 * 60 * 1000)); // Last hour
    
    const stats = {
      sessionId: this.sessionId,
      totalErrors: sessionErrors.length,
      bufferedEntries: this.logBuffer.length,
      errorsByType: {},
      errorsByCategory: {},
      errorsBySeverity: {},
      errorsBySource: {},
      mostProblematicMods: [],
      recentPatterns: []
    };
    
    sessionErrors.forEach(error => {
      // Count by type
      stats.errorsByType[error.type] = (stats.errorsByType[error.type] || 0) + 1;
      
      // Count by category
      stats.errorsByCategory[error.category] = (stats.errorsByCategory[error.category] || 0) + 1;
      
      // Count by severity
      stats.errorsBySeverity[error.severity] = (stats.errorsBySeverity[error.severity] || 0) + 1;
      
      // Count by source
      stats.errorsBySource[error.source] = (stats.errorsBySource[error.source] || 0) + 1;
      
      // Track problematic mods (will be processed later)
      // Track recent patterns (will be processed later)
    });
    
    // Process problematic mods and patterns
    const modCounts = new Map();
    const patternCounts = new Map();
    
    sessionErrors.forEach(error => {
      if (error.modId) {
        const currentCount = modCounts.get(error.modId) || 0;
        modCounts.set(error.modId, currentCount + 1);
      }
      
      const currentPatternCount = patternCounts.get(error.pattern) || 0;
      patternCounts.set(error.pattern, currentPatternCount + 1);
    });
    
    stats.mostProblematicMods = Array.from(modCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    stats.recentPatterns = Array.from(patternCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    
    return stats;
  }

  /**
   * Generate error report for administrators
   * @param {Object} options - Report options
   * @returns {Object} Error report
   */
  generateErrorReport(options = {}) {
    const timeRange = options.timeRange || (24 * 60 * 60 * 1000); // 24 hours
    const cutoffTime = Date.now() - timeRange;
    
    const relevantErrors = Array.from(globalErrorAggregator.errors.values())
      .filter(error => error.timestamp > cutoffTime);
    
    const report = {
      generatedAt: Date.now(),
      timeRange,
      sessionId: this.sessionId,
      summary: {
        totalErrors: relevantErrors.length,
        uniquePatterns: new Set(relevantErrors.map(e => e.pattern)).size,
        affectedMods: new Set(relevantErrors.map(e => e.modId).filter(Boolean)).size,
        criticalErrors: relevantErrors.filter(e => e.severity === 'critical').length,
        highSeverityErrors: relevantErrors.filter(e => e.severity === 'high').length
      },
      patterns: {},
      recommendations: []
    };
    
    // Analyze patterns
    const patternCounts = new Map();
    relevantErrors.forEach(error => {
      const count = patternCounts.get(error.pattern) || 0;
      patternCounts.set(error.pattern, count + 1);
    });
    
    // Generate pattern analysis
    Array.from(patternCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([pattern, count]) => {
        const patternErrors = relevantErrors.filter(e => e.pattern === pattern);
        const firstError = patternErrors[0];
        
        report.patterns[pattern] = {
          count,
          category: firstError.category,
          severity: firstError.severity,
          affectedMods: new Set(patternErrors.map(e => e.modId).filter(Boolean)).size,
          sources: Array.from(new Set(patternErrors.map(e => e.source))),
          firstOccurrence: Math.min(...patternErrors.map(e => e.timestamp)),
          lastOccurrence: Math.max(...patternErrors.map(e => e.timestamp)),
          sampleError: firstError.toJSON()
        };
      });
    
    // Generate recommendations
    report.recommendations = this.generateRecommendations(report);
    
    return report;
  }

  /**
   * Generate recommendations based on error patterns
   * @param {Object} report - Error report
   * @returns {Array<Object>} Recommendations
   */
  generateRecommendations(report) {
    const recommendations = [];
    
    // Check for high-frequency patterns
    Object.entries(report.patterns).forEach(([pattern, data]) => {
      if (data.count >= 10) {
        recommendations.push({
          type: 'high_frequency_pattern',
          priority: 'high',
          pattern,
          description: `Pattern "${pattern}" occurred ${data.count} times`,
          suggestion: this.getPatternSuggestion(data.category, data.sources),
          affectedMods: data.affectedMods
        });
      }
    });
    
    // Check for critical errors
    if (report.summary.criticalErrors > 0) {
      recommendations.push({
        type: 'critical_errors',
        priority: 'critical',
        description: `${report.summary.criticalErrors} critical errors detected`,
        suggestion: 'Immediate investigation required. Check system resources and permissions.',
        action: 'investigate_critical_errors'
      });
    }
    
    // Check for widespread issues
    if (report.summary.affectedMods > 10) {
      recommendations.push({
        type: 'widespread_issues',
        priority: 'high',
        description: `${report.summary.affectedMods} different mods affected by download errors`,
        suggestion: 'Check server infrastructure and network connectivity.',
        action: 'check_infrastructure'
      });
    }
    
    return recommendations;
  }

  /**
   * Get suggestion for specific pattern category
   * @param {string} category - Error category
   * @param {Array<string>} sources - Affected sources
   * @returns {string} Suggestion text
   */
  getPatternSuggestion(category, sources) {
    switch (category) {
      case 'network_connectivity':
        return 'Check network infrastructure and DNS resolution. Consider implementing connection pooling.';
      case 'server_error':
        return `Server issues detected on sources: ${sources.join(', ')}. Check server logs and capacity.`;
      case 'file_integrity':
        return 'Checksum validation failures indicate file corruption. Verify source file integrity.';
      case 'timeout':
        return 'Frequent timeouts suggest server overload or network issues. Consider increasing timeout values.';
      case 'authentication':
        return 'Authentication failures may indicate API key issues or permission problems.';
      default:
        return 'Pattern requires investigation. Check logs for common factors.';
    }
  }
}

// Global error logger instance
export const globalErrorLogger = new DownloadErrorLogger();