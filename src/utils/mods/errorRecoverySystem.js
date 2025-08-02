/**
 * Error recovery system with user-friendly messages and actionable suggestions
 */
/// <reference path="../../electron.d.ts" />
import logger from '../logger.js';
import { RECOVERY_SUGGESTIONS, ERROR_SEVERITY } from './downloadErrorTracker.js';

/**
 * @typedef {import('./downloadErrorTracker.js').DownloadError} DownloadError
 */

/**
 * Error recovery and user guidance system
 */
export class ErrorRecoverySystem {
  constructor() {
    this.recoveryStrategies = new Map();
    this.userMessageTemplates = new Map();
    this.actionHandlers = new Map();
    
    this.initializeRecoveryStrategies();
    this.initializeMessageTemplates();
    this.initializeActionHandlers();
    
    logger.debug('Error recovery system initialized', {
      category: 'mods',
      data: {
        function: 'ErrorRecoverySystem.constructor',
        strategiesCount: this.recoveryStrategies.size,
        templatesCount: this.userMessageTemplates.size,
        handlersCount: this.actionHandlers.size
      }
    });
  }

  /**
   * Initialize recovery strategies for different error types
   */
  initializeRecoveryStrategies() {
    // Network connectivity errors
    this.recoveryStrategies.set('network_connectivity', {
      immediate: [RECOVERY_SUGGESTIONS.CHECK_CONNECTION],
      shortTerm: [RECOVERY_SUGGESTIONS.RETRY, RECOVERY_SUGGESTIONS.FALLBACK],
      longTerm: [RECOVERY_SUGGESTIONS.CONTACT_ADMIN],
      autoRetry: true,
      retryDelay: 5000,
      maxAutoRetries: 2
    });
    
    // Timeout errors
    this.recoveryStrategies.set('timeout', {
      immediate: [RECOVERY_SUGGESTIONS.RETRY],
      shortTerm: [RECOVERY_SUGGESTIONS.FALLBACK],
      longTerm: [RECOVERY_SUGGESTIONS.CONTACT_ADMIN],
      autoRetry: true,
      retryDelay: 10000,
      maxAutoRetries: 3
    });
    
    // Server errors
    this.recoveryStrategies.set('server_error', {
      immediate: [RECOVERY_SUGGESTIONS.FALLBACK],
      shortTerm: [RECOVERY_SUGGESTIONS.CONTACT_ADMIN],
      longTerm: [],
      autoRetry: false,
      retryDelay: 30000,
      maxAutoRetries: 1
    });
    
    // Authentication errors
    this.recoveryStrategies.set('authentication', {
      immediate: [RECOVERY_SUGGESTIONS.CONTACT_ADMIN],
      shortTerm: [RECOVERY_SUGGESTIONS.FALLBACK],
      longTerm: [],
      autoRetry: false,
      retryDelay: 0,
      maxAutoRetries: 0
    });
    
    // Resource not found errors
    this.recoveryStrategies.set('resource_not_found', {
      immediate: [RECOVERY_SUGGESTIONS.UPDATE_MOD, RECOVERY_SUGGESTIONS.FALLBACK],
      shortTerm: [RECOVERY_SUGGESTIONS.MANUAL_DOWNLOAD],
      longTerm: [RECOVERY_SUGGESTIONS.CONTACT_ADMIN],
      autoRetry: false,
      retryDelay: 0,
      maxAutoRetries: 0
    });
    
    // File integrity errors
    this.recoveryStrategies.set('file_integrity', {
      immediate: [RECOVERY_SUGGESTIONS.RETRY],
      shortTerm: [RECOVERY_SUGGESTIONS.FALLBACK],
      longTerm: [RECOVERY_SUGGESTIONS.CONTACT_ADMIN],
      autoRetry: true,
      retryDelay: 2000,
      maxAutoRetries: 2
    });
    
    // File system errors
    this.recoveryStrategies.set('file_system', {
      immediate: [RECOVERY_SUGGESTIONS.CONTACT_ADMIN],
      shortTerm: [],
      longTerm: [],
      autoRetry: false,
      retryDelay: 0,
      maxAutoRetries: 0
    });
  }

  /**
   * Initialize user message templates
   */
  initializeMessageTemplates() {
    // Network connectivity messages
    this.userMessageTemplates.set('network_connectivity', {
      title: 'Connection Problem',
      message: 'Unable to connect to the download server for {modName}.',
      details: 'This usually happens when there are internet connectivity issues or the server is temporarily unavailable.',
      icon: 'network-error',
      severity: 'warning'
    });
    
    // Timeout messages
    this.userMessageTemplates.set('timeout', {
      title: 'Download Timeout',
      message: 'Download of {modName} timed out.',
      details: 'The server may be slow or overloaded. The download will be retried automatically.',
      icon: 'clock-error',
      severity: 'warning'
    });
    
    // Server error messages
    this.userMessageTemplates.set('server_error', {
      title: 'Server Error',
      message: 'The download server encountered an error while processing {modName}.',
      details: 'This is a server-side issue that requires administrator attention. An alternative download source will be tried.',
      icon: 'server-error',
      severity: 'error'
    });
    
    // Authentication messages
    this.userMessageTemplates.set('authentication', {
      title: 'Access Denied',
      message: 'You do not have permission to download {modName}.',
      details: 'This may be due to server configuration or authentication issues. Please contact your administrator.',
      icon: 'lock-error',
      severity: 'error'
    });
    
    // Resource not found messages
    this.userMessageTemplates.set('resource_not_found', {
      title: 'File Not Found',
      message: '{modName} could not be found on the server.',
      details: 'The file may have been moved, deleted, or the mod information may be outdated.',
      icon: 'file-error',
      severity: 'warning'
    });
    
    // File integrity messages
    this.userMessageTemplates.set('file_integrity', {
      title: 'File Corruption Detected',
      message: 'The downloaded file for {modName} failed integrity verification.',
      details: 'This indicates the file was corrupted during download. The download will be retried automatically.',
      icon: 'checksum-error',
      severity: 'warning'
    });
    
    // File system messages
    this.userMessageTemplates.set('file_system', {
      title: 'File System Error',
      message: 'Unable to save {modName} to your computer.',
      details: 'This may be due to insufficient disk space, permission issues, or file system problems.',
      icon: 'disk-error',
      severity: 'error'
    });
  }

  /**
   * Initialize action handlers for recovery suggestions
   */
  initializeActionHandlers() {
    this.actionHandlers.set(RECOVERY_SUGGESTIONS.RETRY, {
      label: 'Retry Download',
      description: 'Try downloading the file again',
      icon: 'refresh',
      action: 'retry-download',
      primary: true
    });
    
    this.actionHandlers.set(RECOVERY_SUGGESTIONS.FALLBACK, {
      label: 'Try Alternative Source',
      description: 'Download from an alternative source (Modrinth/CurseForge)',
      icon: 'alternate-source',
      action: 'fallback-download',
      primary: true
    });
    
    this.actionHandlers.set(RECOVERY_SUGGESTIONS.CHECK_CONNECTION, {
      label: 'Check Connection',
      description: 'Verify your internet connection and try again',
      icon: 'network-check',
      action: 'check-connection',
      primary: false
    });
    
    this.actionHandlers.set(RECOVERY_SUGGESTIONS.CONTACT_ADMIN, {
      label: 'Contact Administrator',
      description: 'Report this issue to your server administrator',
      icon: 'contact-admin',
      action: 'contact-admin',
      primary: false
    });
    
    this.actionHandlers.set(RECOVERY_SUGGESTIONS.UPDATE_MOD, {
      label: 'Update Mod Info',
      description: 'Check for updated mod information',
      icon: 'update-mod',
      action: 'update-mod',
      primary: false
    });
    
    this.actionHandlers.set(RECOVERY_SUGGESTIONS.MANUAL_DOWNLOAD, {
      label: 'Manual Download',
      description: 'Download the mod manually from the original source',
      icon: 'manual-download',
      action: 'manual-download',
      primary: false
    });
  }

  /**
   * Generate user-friendly error message with recovery options
   * @param {DownloadError} downloadError - Download error instance
   * @returns {Object} User-friendly error information
   */
  generateUserErrorInfo(downloadError) {
    const template = this.userMessageTemplates.get(downloadError.category) || 
                    this.userMessageTemplates.get('unknown');
    
    const strategy = this.recoveryStrategies.get(downloadError.category) || 
                    this.getDefaultStrategy();
    
    // Replace placeholders in message
    const message = this.replacePlaceholders(template.message, {
      modName: downloadError.modName || 'the mod',
      modId: downloadError.modId || 'unknown',
      source: downloadError.source,
      attempt: downloadError.attempt
    });
    
    const details = this.replacePlaceholders(template.details, {
      modName: downloadError.modName || 'the mod',
      modId: downloadError.modId || 'unknown',
      source: downloadError.source,
      attempt: downloadError.attempt
    });
    
    // Generate recovery actions
    const recoveryActions = this.generateRecoveryActions(downloadError, strategy);
    
    const userErrorInfo = {
      id: downloadError.id,
      timestamp: downloadError.timestamp,
      
      // Display information
      title: template.title,
      message,
      details,
      icon: template.icon,
      severity: template.severity,
      
      // Technical information (for advanced users/debugging)
      technical: {
        errorType: downloadError.type,
        errorCategory: downloadError.category,
        source: downloadError.source,
        attempt: downloadError.attempt,
        pattern: downloadError.pattern,
        fingerprint: downloadError.fingerprint
      },
      
      // Recovery options
      recovery: {
        canAutoRetry: strategy.autoRetry,
        autoRetryDelay: strategy.retryDelay,
        maxAutoRetries: strategy.maxAutoRetries,
        actions: recoveryActions
      },
      
      // Context information
      context: {
        modId: downloadError.modId,
        modName: downloadError.modName,
        downloadSource: downloadError.source,
        attemptNumber: downloadError.attempt,
        errorOccurredAt: new Date(downloadError.timestamp).toLocaleString()
      }
    };
    
    logger.debug('Generated user error info', {
      category: 'mods',
      data: {
        function: 'ErrorRecoverySystem.generateUserErrorInfo',
        errorId: downloadError.id,
        category: downloadError.category,
        severity: template.severity,
        canAutoRetry: strategy.autoRetry,
        actionCount: recoveryActions.length
      }
    });
    
    return userErrorInfo;
  }

  /**
   * Generate recovery actions based on error and strategy
   * @param {DownloadError} downloadError - Download error
   * @param {Object} strategy - Recovery strategy
   * @returns {Array<Object>} Recovery actions
   */
  generateRecoveryActions(downloadError, strategy) {
    const actions = [];
    
    // Add immediate actions
    strategy.immediate.forEach(suggestion => {
      const handler = this.actionHandlers.get(suggestion);
      if (handler) {
        actions.push({
          ...handler,
          category: 'immediate',
          enabled: this.isActionEnabled(suggestion, downloadError),
          context: this.getActionContext(suggestion, downloadError)
        });
      }
    });
    
    // Add short-term actions
    strategy.shortTerm.forEach(suggestion => {
      const handler = this.actionHandlers.get(suggestion);
      if (handler) {
        actions.push({
          ...handler,
          category: 'short-term',
          enabled: this.isActionEnabled(suggestion, downloadError),
          context: this.getActionContext(suggestion, downloadError)
        });
      }
    });
    
    // Add long-term actions
    strategy.longTerm.forEach(suggestion => {
      const handler = this.actionHandlers.get(suggestion);
      if (handler) {
        actions.push({
          ...handler,
          category: 'long-term',
          enabled: this.isActionEnabled(suggestion, downloadError),
          context: this.getActionContext(suggestion, downloadError)
        });
      }
    });
    
    return actions;
  }

  /**
   * Check if a recovery action is enabled for the current error
   * @param {string} suggestion - Recovery suggestion
   * @param {DownloadError} downloadError - Download error
   * @returns {boolean} True if action is enabled
   */
  isActionEnabled(suggestion, downloadError) {
    switch (suggestion) {
      case RECOVERY_SUGGESTIONS.RETRY:
        return downloadError.attempt < 3; // Don't allow retry after 3 attempts
        
      case RECOVERY_SUGGESTIONS.FALLBACK:
        return downloadError.source === 'server'; // Only fallback from server
        
      case RECOVERY_SUGGESTIONS.UPDATE_MOD:
        return !!downloadError.modId; // Only if we have mod ID
        
      case RECOVERY_SUGGESTIONS.MANUAL_DOWNLOAD:
        return !!downloadError.modId; // Only if we have mod ID
        
      default:
        return true;
    }
  }

  /**
   * Get context information for recovery action
   * @param {string} suggestion - Recovery suggestion
   * @param {DownloadError} downloadError - Download error
   * @returns {Object} Action context
   */
  getActionContext(suggestion, downloadError) {
    const context = {
      modId: downloadError.modId,
      modName: downloadError.modName,
      source: downloadError.source,
      attempt: downloadError.attempt
    };
    
    switch (suggestion) {
      case RECOVERY_SUGGESTIONS.RETRY:
        context.nextAttempt = downloadError.attempt + 1;
        context.maxAttempts = 3;
        break;
        
      case RECOVERY_SUGGESTIONS.FALLBACK:
        context.fallbackSources = this.getFallbackSources(downloadError.source);
        break;
        
      case RECOVERY_SUGGESTIONS.MANUAL_DOWNLOAD:
        context.downloadUrls = this.getManualDownloadUrls(downloadError.modId);
        break;
    }
    
    return context;
  }

  /**
   * Get fallback sources for a given source
   * @param {string} currentSource - Current download source
   * @returns {Array<string>} Available fallback sources
   */
  getFallbackSources(currentSource) {
    const allSources = ['server', 'modrinth', 'curseforge'];
    return allSources.filter(source => source !== currentSource);
  }

  /**
   * Get manual download URLs for a mod
   * @param {string} modId - Mod ID
   * @returns {Array<Object>} Manual download URLs
   */
  getManualDownloadUrls(modId) {
    if (!modId) return [];
    
    return [
      {
        source: 'modrinth',
        url: `https://modrinth.com/mod/${modId}`,
        label: 'Download from Modrinth'
      },
      {
        source: 'curseforge',
        url: `https://www.curseforge.com/minecraft/mc-mods/${modId}`,
        label: 'Download from CurseForge'
      }
    ];
  }

  /**
   * Replace placeholders in message templates
   * @param {string} template - Message template
   * @param {Object} values - Placeholder values
   * @returns {string} Message with replaced placeholders
   */
  replacePlaceholders(template, values) {
    let result = template;
    
    Object.entries(values).forEach(([key, value]) => {
      const placeholder = `{${key}}`;
      result = result.replace(new RegExp(placeholder, 'g'), value || 'unknown');
    });
    
    return result;
  }

  /**
   * Get default recovery strategy
   * @returns {Object} Default strategy
   */
  getDefaultStrategy() {
    return {
      immediate: [RECOVERY_SUGGESTIONS.RETRY],
      shortTerm: [RECOVERY_SUGGESTIONS.FALLBACK],
      longTerm: [RECOVERY_SUGGESTIONS.CONTACT_ADMIN],
      autoRetry: true,
      retryDelay: 5000,
      maxAutoRetries: 2
    };
  }

  /**
   * Generate error summary for multiple errors
   * @param {Array<DownloadError>} errors - Array of download errors
   * @returns {Object} Error summary
   */
  generateErrorSummary(errors) {
    if (!errors || errors.length === 0) {
      return {
        totalErrors: 0,
        categories: {},
        severity: 'none',
        commonPatterns: [],
        recommendations: []
      };
    }
    
    const summary = {
      totalErrors: errors.length,
      categories: {},
      severity: 'low',
      commonPatterns: [],
      recommendations: [],
      affectedMods: new Set(),
      timeRange: {
        earliest: Math.min(...errors.map(e => e.timestamp)),
        latest: Math.max(...errors.map(e => e.timestamp))
      }
    };
    
    // Analyze error categories
    errors.forEach(error => {
      summary.categories[error.category] = (summary.categories[error.category] || 0) + 1;
      summary.affectedMods.add(error.modId);
      
      // Determine overall severity
      if (error.severity === ERROR_SEVERITY.CRITICAL) {
        summary.severity = ERROR_SEVERITY.CRITICAL;
      } else if (error.severity === ERROR_SEVERITY.HIGH && summary.severity !== ERROR_SEVERITY.CRITICAL) {
        summary.severity = ERROR_SEVERITY.HIGH;
      } else if (error.severity === ERROR_SEVERITY.MEDIUM && 
                 summary.severity !== ERROR_SEVERITY.CRITICAL && 
                 summary.severity !== ERROR_SEVERITY.HIGH) {
        summary.severity = ERROR_SEVERITY.MEDIUM;
      }
    });
    
    // Find common patterns
    const patternCounts = new Map();
    errors.forEach(error => {
      const count = patternCounts.get(error.pattern) || 0;
      patternCounts.set(error.pattern, count + 1);
    });
    
    summary.commonPatterns = Array.from(patternCounts.entries())
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pattern, count]) => ({ pattern, count }));
    
    // Generate recommendations
    summary.recommendations = this.generateSummaryRecommendations(summary);
    
    // Convert Set to number for JSON serialization
    summary.affectedModsCount = summary.affectedMods.size;
    delete summary.affectedMods;
    
    return summary;
  }

  /**
   * Generate recommendations for error summary
   * @param {Object} summary - Error summary
   * @returns {Array<Object>} Recommendations
   */
  generateSummaryRecommendations(summary) {
    const recommendations = [];
    
    // Critical severity recommendations
    if (summary.severity === ERROR_SEVERITY.CRITICAL) {
      recommendations.push({
        priority: 'critical',
        title: 'Critical Issues Detected',
        message: 'Multiple critical download errors require immediate attention.',
        actions: ['contact-admin', 'check-system-resources']
      });
    }
    
    // High error count recommendations
    if (summary.totalErrors > 10) {
      recommendations.push({
        priority: 'high',
        title: 'High Error Volume',
        message: `${summary.totalErrors} download errors detected. System may be experiencing issues.`,
        actions: ['check-infrastructure', 'review-logs']
      });
    }
    
    // Pattern-specific recommendations
    summary.commonPatterns.forEach(({ pattern, count }) => {
      if (count >= 3) {
        recommendations.push({
          priority: 'medium',
          title: 'Recurring Error Pattern',
          message: `Pattern "${pattern}" occurred ${count} times.`,
          actions: ['investigate-pattern', 'check-source-health']
        });
      }
    });
    
    // Category-specific recommendations
    Object.entries(summary.categories).forEach(([category, count]) => {
      if (count >= 5) {
        const categoryRecommendation = this.getCategoryRecommendation(category, count);
        if (categoryRecommendation) {
          recommendations.push(categoryRecommendation);
        }
      }
    });
    
    return recommendations;
  }

  /**
   * Get recommendation for specific error category
   * @param {string} category - Error category
   * @param {number} count - Error count
   * @returns {Object|null} Category recommendation
   */
  getCategoryRecommendation(category, count) {
    switch (category) {
      case 'network_connectivity':
        return {
          priority: 'high',
          title: 'Network Connectivity Issues',
          message: `${count} network-related errors detected.`,
          actions: ['check-network', 'verify-dns', 'test-connectivity']
        };
        
      case 'server_error':
        return {
          priority: 'high',
          title: 'Server Issues',
          message: `${count} server errors detected.`,
          actions: ['check-server-health', 'review-server-logs', 'contact-hosting']
        };
        
      case 'file_integrity':
        return {
          priority: 'medium',
          title: 'File Integrity Issues',
          message: `${count} checksum validation failures detected.`,
          actions: ['verify-source-files', 'check-storage-integrity']
        };
        
      default:
        return null;
    }
  }
}

// Global error recovery system instance
export const globalErrorRecovery = new ErrorRecoverySystem();