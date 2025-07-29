/// <reference path="../../electron.d.ts" />

/**
 * Backup Statistics Service
 * Provides comprehensive statistics calculation for backup management with performance optimizations
 */

import { formatSize } from './sizeCalculator.js';
import { 
  calculateStatisticsOptimized,
  queueBackgroundStatisticsUpdate,
  invalidateStatisticsCache,
  getStatisticsPerformanceStats,
  cleanupStatistics
} from './statisticsOptimizer.js';

/**
 * Backup Statistics class for calculating and analyzing backup patterns
 */
export class BackupStatistics {
  /**
   * Calculate comprehensive statistics for a set of backups with performance optimizations
   * @param {Array} backups - Array of backup objects with name, size, created properties
   * @param {Object} [retentionSavings=null] - Optional retention policy savings data
   * @param {string} [serverPath=''] - Server path for caching
   * @param {Object} [options={}] - Calculation options
   * @returns {Promise<Object>} Comprehensive backup statistics
   */
  static async calculateStatistics(backups, retentionSavings = null, serverPath = '', options = {}) {
    if (!Array.isArray(backups)) {
      throw new Error('Backups must be an array');
    }

    const {
      useOptimized = true,
      forceRefresh = false,
      enableBackground = true,
      useIncremental = true
    } = options;

    // Use optimized calculation if server path is available
    if (useOptimized && serverPath) {
      try {
        const optimizedStats = await calculateStatisticsOptimized(backups, serverPath, {
          forceRefresh,
          useIncremental,
          enableBackground
        });

        // Add retention savings if provided
        if (retentionSavings) {
          optimizedStats.retentionSavings = retentionSavings.spaceSaved || 0;
        }

        return optimizedStats;
      } catch (optimizedError) {
        console.warn('Optimized statistics calculation failed, falling back to standard method:', optimizedError);
        // Fall through to standard calculation
      }
    }

    // Standard calculation
    const stats = {
      totalBackups: backups.length,
      totalSize: 0,
      averageSize: 0,
      oldestBackup: null,
      newestBackup: null,
      sizeGrowthTrend: [],
      frequencyPattern: {},
      retentionSavings: retentionSavings?.spaceSaved || 0
    };

    // Return empty stats for no backups
    if (backups.length === 0) {
      return stats;
    }

    // Sort backups by creation date
    const sortedByDate = this._sortBackupsByDate(backups);
    
    // Calculate basic statistics
    stats.oldestBackup = sortedByDate[0];
    stats.newestBackup = sortedByDate[sortedByDate.length - 1];
    
    // Calculate size statistics
    stats.totalSize = backups.reduce((sum, backup) => sum + (backup.size || 0), 0);
    stats.averageSize = stats.totalSize / backups.length;
    
    // Calculate growth trend (last 30 days)
    stats.sizeGrowthTrend = this._calculateGrowthTrend(sortedByDate);
    
    // Calculate backup frequency pattern
    stats.frequencyPattern = this._calculateFrequencyPattern(sortedByDate);
    
    return stats;
  }

  /**
   * Queue background statistics update for better performance
   * @param {string} serverPath - Server path
   * @param {Array} backups - Backups to calculate statistics for
   * @param {number} priority - Update priority (higher = more urgent)
   */
  static queueBackgroundUpdate(serverPath, backups, priority = 0) {
    queueBackgroundStatisticsUpdate(serverPath, backups, priority);
  }

  /**
   * Invalidate statistics cache for a server path
   * @param {string} serverPath - Server path to invalidate
   */
  static invalidateCache(serverPath) {
    invalidateStatisticsCache(serverPath);
  }

  /**
   * Get performance statistics for monitoring
   * @returns {Object} Performance statistics
   */
  static getPerformanceStats() {
    return getStatisticsPerformanceStats();
  }

  /**
   * Cleanup statistics resources
   */
  static cleanup() {
    cleanupStatistics();
  }

  /**
   * Sort backups by creation date (oldest first)
   * @param {Array} backups - Array of backup objects
   * @returns {Array} Sorted array of backups
   * @private
   */
  static _sortBackupsByDate(backups) {
    return [...backups].sort((a, b) => {
      const dateA = this.getBackupDate(a);
      const dateB = this.getBackupDate(b);
      return dateA.getTime() - dateB.getTime(); // Oldest first
    });
  }

  /**
   * Get the creation date from a backup object
   * @param {Object} backup - Backup object
   * @returns {Date} Creation date
   */
  static getBackupDate(backup) {
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
   * Calculate size growth trend for the last 30 days
   * @param {Array} sortedBackups - Backups sorted by date (oldest first)
   * @returns {Array} Array of daily growth data points
   * @private
   */
  static _calculateGrowthTrend(sortedBackups) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentBackups = sortedBackups.filter(backup => 
      this.getBackupDate(backup) >= thirtyDaysAgo
    );
    
    if (recentBackups.length === 0) {
      return [];
    }
    
    // Group backups by day
    const dailyData = {};
    
    for (const backup of recentBackups) {
      const backupDate = this.getBackupDate(backup);
      const dayKey = backupDate.toISOString().split('T')[0]; // YYYY-MM-DD format
      
      if (!dailyData[dayKey]) {
        dailyData[dayKey] = {
          date: dayKey,
          size: 0,
          count: 0,
          backups: []
        };
      }
      
      dailyData[dayKey].size += backup.size || 0;
      dailyData[dayKey].count++;
      dailyData[dayKey].backups.push(backup);
    }
    
    // Convert to array and sort by date
    const trendData = Object.values(dailyData).sort((a, b) => 
      new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    
    // Calculate cumulative size for trend visualization
    let cumulativeSize = 0;
    return trendData.map(day => {
      cumulativeSize += day.size;
      return {
        ...day,
        cumulativeSize,
        formattedSize: formatSize(day.size),
        formattedCumulativeSize: formatSize(cumulativeSize)
      };
    });
  }

  /**
   * Calculate backup frequency patterns
   * @param {Array} sortedBackups - Backups sorted by date (oldest first)
   * @returns {Object} Frequency pattern analysis
   * @private
   */
  static _calculateFrequencyPattern(sortedBackups) {
    if (sortedBackups.length < 2) {
      return {
        averageInterval: 0,
        intervalVariance: 0,
        dailyPattern: {},
        weeklyPattern: {},
        monthlyPattern: {},
        backupsByHour: {},
        backupsByDayOfWeek: {},
        backupsByMonth: {}
      };
    }

    const intervals = [];
    const dailyPattern = {};
    const weeklyPattern = {};
    const monthlyPattern = {};
    const backupsByHour = {};
    const backupsByDayOfWeek = {};
    const backupsByMonth = {};

    // Calculate intervals between backups
    for (let i = 1; i < sortedBackups.length; i++) {
      const prevDate = this.getBackupDate(sortedBackups[i - 1]);
      const currentDate = this.getBackupDate(sortedBackups[i]);
      const interval = currentDate.getTime() - prevDate.getTime();
      intervals.push(interval);
    }

    // Analyze backup timing patterns
    for (const backup of sortedBackups) {
      const backupDate = this.getBackupDate(backup);
      
      // Daily pattern (by date)
      const dayKey = backupDate.toISOString().split('T')[0];
      dailyPattern[dayKey] = (dailyPattern[dayKey] || 0) + 1;
      
      // Weekly pattern (by week number)
      const weekNumber = this._getWeekNumber(backupDate);
      const weekKey = `${backupDate.getFullYear()}-W${weekNumber}`;
      weeklyPattern[weekKey] = (weeklyPattern[weekKey] || 0) + 1;
      
      // Monthly pattern (by month)
      const monthKey = `${backupDate.getFullYear()}-${String(backupDate.getMonth() + 1).padStart(2, '0')}`;
      monthlyPattern[monthKey] = (monthlyPattern[monthKey] || 0) + 1;
      
      // Hour pattern (0-23)
      const hour = backupDate.getHours();
      backupsByHour[hour] = (backupsByHour[hour] || 0) + 1;
      
      // Day of week pattern (0=Sunday, 6=Saturday)
      const dayOfWeek = backupDate.getDay();
      backupsByDayOfWeek[dayOfWeek] = (backupsByDayOfWeek[dayOfWeek] || 0) + 1;
      
      // Month pattern (0-11)
      const month = backupDate.getMonth();
      backupsByMonth[month] = (backupsByMonth[month] || 0) + 1;
    }

    // Calculate average interval and variance
    const averageInterval = intervals.length > 0 ? 
      intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length : 0;
    
    const intervalVariance = intervals.length > 0 ? 
      intervals.reduce((sum, interval) => sum + Math.pow(interval - averageInterval, 2), 0) / intervals.length : 0;

    return {
      averageInterval,
      intervalVariance,
      dailyPattern,
      weeklyPattern,
      monthlyPattern,
      backupsByHour,
      backupsByDayOfWeek,
      backupsByMonth,
      totalIntervals: intervals.length,
      formattedAverageInterval: this.formatDuration(averageInterval)
    };
  }

  /**
   * Get week number for a date
   * @param {Date} date - Date to get week number for
   * @returns {number} Week number (1-53)
   * @private
   */
  static _getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  /**
   * Format duration into human-readable string
   * @param {number} milliseconds - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  static formatDuration(milliseconds) {
    if (milliseconds === 0) return '0 seconds';
    
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

  /**
   * Calculate storage savings from retention policies
   * @param {Array} backups - Current backups
   * @param {Array} deletedBackups - Backups that were deleted by retention policies
   * @returns {Object} Storage savings analysis
   */
  static calculateRetentionSavings(backups, deletedBackups) {
    if (!Array.isArray(backups) || !Array.isArray(deletedBackups)) {
      return {
        spaceSaved: 0,
        backupsDeleted: 0,
        percentageSaved: 0,
        formattedSpaceSaved: formatSize(0)
      };
    }

    const spaceSaved = deletedBackups.reduce((sum, backup) => sum + (backup.size || 0), 0);
    const totalOriginalSize = backups.reduce((sum, backup) => sum + (backup.size || 0), 0) + spaceSaved;
    const percentageSaved = totalOriginalSize > 0 ? (spaceSaved / totalOriginalSize) * 100 : 0;

    return {
      spaceSaved,
      backupsDeleted: deletedBackups.length,
      percentageSaved: Math.round(percentageSaved * 100) / 100, // Round to 2 decimal places
      formattedSpaceSaved: formatSize(spaceSaved),
      totalOriginalSize,
      formattedTotalOriginalSize: formatSize(totalOriginalSize)
    };
  }

  /**
   * Get backup statistics summary for display
   * @param {Object} statistics - Full statistics object
   * @returns {Object} Simplified statistics for UI display
   */
  static getStatisticsSummary(statistics) {
    if (!statistics) {
      return {
        totalBackups: 0,
        totalSize: formatSize(0),
        averageSize: formatSize(0),
        oldestBackup: null,
        newestBackup: null,
        retentionSavings: formatSize(0),
        averageInterval: 'N/A',
        growthTrendLength: 0
      };
    }

    return {
      totalBackups: statistics.totalBackups,
      totalSize: formatSize(statistics.totalSize),
      averageSize: formatSize(statistics.averageSize),
      oldestBackup: statistics.oldestBackup ? {
        ...statistics.oldestBackup,
        formattedDate: this.formatDate(this.getBackupDate(statistics.oldestBackup))
      } : null,
      newestBackup: statistics.newestBackup ? {
        ...statistics.newestBackup,
        formattedDate: this.formatDate(this.getBackupDate(statistics.newestBackup))
      } : null,
      retentionSavings: formatSize(statistics.retentionSavings),
      averageInterval: statistics.frequencyPattern?.formattedAverageInterval || 'N/A',
      growthTrendLength: statistics.sizeGrowthTrend?.length || 0,
      hasGrowthData: statistics.sizeGrowthTrend && statistics.sizeGrowthTrend.length > 0
    };
  }

  /**
   * Format date for display
   * @param {Date} date - Date to format
   * @returns {string} Formatted date string
   */
  static formatDate(date) {
    if (!date || !(date instanceof Date)) {
      return 'Unknown';
    }
    
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }

  /**
   * Analyze backup health and provide recommendations
   * @param {Object} statistics - Full statistics object
   * @returns {Object} Health analysis and recommendations
   */
  static analyzeBackupHealth(statistics) {
    const recommendations = [];
    const warnings = [];
    let healthScore = 100; // Start with perfect score

    if (!statistics || statistics.totalBackups === 0) {
      return {
        healthScore: 0,
        status: 'critical',
        recommendations: ['Create your first backup to start protecting your data'],
        warnings: ['No backups found']
      };
    }

    // Check backup frequency
    if (statistics.frequencyPattern && statistics.frequencyPattern.averageInterval > 0) {
      const avgIntervalDays = statistics.frequencyPattern.averageInterval / (24 * 60 * 60 * 1000);
      
      if (avgIntervalDays > 7) {
        healthScore -= 20;
        warnings.push('Backups are infrequent (more than 7 days apart on average)');
        recommendations.push('Consider enabling automatic backups for more frequent protection');
      } else if (avgIntervalDays > 3) {
        healthScore -= 10;
        recommendations.push('Consider more frequent backups for better data protection');
      }
    }

    // Check backup age
    if (statistics.newestBackup) {
      const newestDate = this.getBackupDate(statistics.newestBackup);
      const daysSinceLastBackup = (Date.now() - newestDate.getTime()) / (24 * 60 * 60 * 1000);
      
      if (daysSinceLastBackup > 7) {
        healthScore -= 30;
        warnings.push('Last backup is more than 7 days old');
        recommendations.push('Create a new backup soon to ensure recent data is protected');
      } else if (daysSinceLastBackup > 3) {
        healthScore -= 15;
        recommendations.push('Consider creating a more recent backup');
      }
    }

    // Check backup count
    if (statistics.totalBackups < 3) {
      healthScore -= 15;
      recommendations.push('Maintain at least 3 backups for better redundancy');
    }

    // Check size growth trend
    if (statistics.sizeGrowthTrend && statistics.sizeGrowthTrend.length > 1) {
      const recentGrowth = statistics.sizeGrowthTrend.slice(-7); // Last 7 days
      const totalGrowth = recentGrowth.reduce((sum, day) => sum + day.size, 0);
      
      if (totalGrowth > 1024 * 1024 * 1024) { // More than 1GB growth in 7 days
        recommendations.push('Consider retention policies to manage growing backup sizes');
      }
    }

    // Determine overall status
    let status = 'excellent';
    if (healthScore < 50) {
      status = 'critical';
    } else if (healthScore < 70) {
      status = 'poor';
    } else if (healthScore < 85) {
      status = 'good';
    }

    return {
      healthScore: Math.max(0, healthScore),
      status,
      recommendations,
      warnings
    };
  }
}

/**
 * Export utility functions for external use
 */
export const StatisticsUtils = {
  formatSize,
  
  /**
   * Format duration into human-readable string
   * @param {number} milliseconds - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  formatDuration(milliseconds) {
    return BackupStatistics.formatDuration(milliseconds);
  },
  
  /**
   * Format date for display
   * @param {Date} date - Date to format
   * @returns {string} Formatted date string
   */
  formatDate(date) {
    return BackupStatistics.formatDate(date);
  },
  
  /**
   * Get the creation date from a backup object
   * @param {Object} backup - Backup object
   * @returns {Date} Creation date
   */
  getBackupDate(backup) {
    return BackupStatistics.getBackupDate(backup);
  }
};