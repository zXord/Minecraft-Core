/// <reference path="../../electron.d.ts" />

import { RetentionPolicy, TimeConstants, SizeConstants } from './retentionPolicy.js';
import { formatSize } from './sizeCalculator.js';
import logger from '../logger.js';
import { optimizeRetentionPolicies as optimizeRetentionPoliciesCore } from '../../../shared/backup/retentionOptimization.js';

/**
 * Retention Policy Warnings and Preview System
 * Provides warnings, previews, and impact analysis for retention policies
 */

/**
 * Retention Warning Types
 */
export const WarningTypes = {
  SIZE_APPROACHING_LIMIT: 'size-approaching-limit',
  AGE_APPROACHING_LIMIT: 'age-approaching-limit',
  COUNT_APPROACHING_LIMIT: 'count-approaching-limit',
  SIZE_EXCEEDED: 'size-exceeded',
  AGE_EXCEEDED: 'age-exceeded',
  COUNT_EXCEEDED: 'count-exceeded',
  NO_BACKUPS_TO_PRESERVE: 'no-backups-to-preserve',
  ALL_BACKUPS_WOULD_BE_DELETED: 'all-backups-would-be-deleted'
};

/**
 * Warning Severity Levels
 */
export const WarningSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
  ERROR: 'error'
};

/**
 * Recommendation severity levels (aligned with warning semantics)
 */
export const RecommendationSeverity = {
  INFO: 'info',
  ADVISORY: 'advisory',
  WARNING: 'warning',
  CRITICAL: 'critical'
};

/**
 * Recommendation grouping keys to help the UI cluster related advice
 */
export const RecommendationGroups = {
  COVERAGE: 'policy-coverage',
  STORAGE: 'storage-health',
  SAFETY: 'data-safety',
  PERFORMANCE: 'performance',
  MAINTENANCE: 'maintenance'
};

/**
 * Retention Policy Warning System
 */
export class RetentionWarningSystem {
  /**
   * Create a new retention warning system
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.sizeWarningThreshold=0.8] - Threshold for size warnings (0.8 = 80%)
   * @param {number} [options.ageWarningThreshold=0.9] - Threshold for age warnings (0.9 = 90%)
   * @param {number} [options.countWarningThreshold=0.9] - Threshold for count warnings (0.9 = 90%)
   */
  constructor(options = {}) {
    this.sizeWarningThreshold = options.sizeWarningThreshold || 0.8;
    this.ageWarningThreshold = options.ageWarningThreshold || 0.9;
    this.countWarningThreshold = options.countWarningThreshold || 0.9;
  }

  /**
   * Analyze backups and generate warnings based on retention policy settings
   * @param {Array} backups - Array of backup objects
   * @param {Object} retentionSettings - Current retention policy settings
   * @returns {Promise<Array>} Array of warning objects
   */
  async analyzeRetentionWarnings(backups, retentionSettings) {
    if (!Array.isArray(backups)) {
      throw new Error('Backups must be an array');
    }

    const warnings = [];

    try {
      // Create retention policy from settings
      const policy = this._createPolicyFromSettings(retentionSettings);

      if (!policy.hasActiveRules()) {
        return warnings;
      }

      // Calculate current totals
      const totalSize = backups.reduce((sum, backup) => sum + (backup.size || 0), 0);
      const totalCount = backups.length;
      const oldestBackup = this._getOldestBackup(backups);

      // Check size-based warnings
      if (retentionSettings.sizeRetentionEnabled && retentionSettings.maxSizeValue) {
        const maxSizeBytes = this._convertSizeToBytes(
          retentionSettings.maxSizeValue,
          retentionSettings.maxSizeUnit
        );

        const sizeWarnings = this._checkSizeWarnings(
          totalSize,
          maxSizeBytes
        );
        warnings.push(...sizeWarnings);
      }

      // Check age-based warnings
      if (retentionSettings.ageRetentionEnabled && retentionSettings.maxAgeValue) {
        const maxAgeMs = this._convertAgeToMilliseconds(
          retentionSettings.maxAgeValue,
          retentionSettings.maxAgeUnit
        );

        const ageWarnings = this._checkAgeWarnings(
          oldestBackup,
          maxAgeMs,
          backups
        );
        warnings.push(...ageWarnings);
      }

      // Check count-based warnings
      if (retentionSettings.countRetentionEnabled && retentionSettings.maxCountValue) {
        const countWarnings = this._checkCountWarnings(
          totalCount,
          retentionSettings.maxCountValue
        );
        warnings.push(...countWarnings);
      }

      // Check for dangerous policy combinations
      const policyWarnings = await this._checkPolicyWarnings(policy, backups);
      warnings.push(...policyWarnings);

      logger.debug('Retention warnings analyzed', {
        category: 'backup',
        data: {
          totalBackups: backups.length,
          warningsCount: warnings.length,
          warningTypes: warnings.map(w => w.type)
        }
      });

    } catch (error) {
      logger.error('Failed to analyze retention warnings', {
        category: 'backup',
        data: {
          error: error.message,
          backupsCount: backups.length
        }
      });

      warnings.push({
        type: 'analysis-error',
        severity: WarningSeverity.ERROR,
        title: 'Warning Analysis Failed',
        message: 'Unable to analyze retention policy warnings',
        details: error.message,
        timestamp: new Date().toISOString()
      });
    }

    return warnings;
  }

  /**
   * Generate a detailed preview of what a retention policy would do
   * @param {Array} backups - Array of backup objects
   * @param {Object} retentionSettings - Retention policy settings
   * @returns {Promise<Object>} Detailed preview result
   */
  async generateRetentionPreview(backups, retentionSettings) {
    if (!Array.isArray(backups)) {
      throw new Error('Backups must be an array');
    }

    try {
      const policy = this._createPolicyFromSettings(retentionSettings);

      if (!policy.hasActiveRules()) {
        const totalSize = backups.reduce((sum, b) => sum + (b.size || 0), 0);
        const impact = {
          totalBackups: backups.length,
          backupsToDelete: 0,
          backupsRemaining: backups.length,
          spaceSaved: 0,
          totalSize,
          deletedSize: 0,
          remainingSize: totalSize,
          oldestBackupToDelete: null,
          newestBackupToDelete: null,
          preservedRecentCount: Math.min(1, backups.length)
        };

        const optimization = await optimizeRetentionPolicies(backups, retentionSettings);
        const recommendationContext = this._buildRecommendationContext({
          backups,
          retentionSettings,
          impact,
          optimization
        });

        const recommendations = this._generateRecommendations({
          backups,
          retentionSettings,
          impact,
          optimization,
          context: recommendationContext
        });

        return {
          hasActiveRules: false,
          impact,
          backupsToDelete: [],
          backupsToKeep: [...backups],
          warnings: [],
          recommendations,
          recommendationContext,
          optimization,
          breakdown: null,
          policyDescription: 'No retention rules active',
          timestamp: new Date().toISOString()
        };
      }

      // Get policy impact
      const impact = await policy.getPolicyImpact(backups);
      const evaluationResult = await policy.evaluateBackups(backups);

      // Handle both old and new evaluation result formats
      const backupsToDelete = Array.isArray(evaluationResult)
        ? evaluationResult
        : (evaluationResult.toDelete || []);

      // Separate backups to keep and delete
      const deleteNames = new Set(backupsToDelete.map(b => b.name));
      const backupsToKeep = backups.filter(b => !deleteNames.has(b.name));

      // Generate warnings for this preview
      const warnings = await this.analyzeRetentionWarnings(backups, retentionSettings);

      // Run advanced optimization to feed richer recommendation context
      const optimization = await optimizeRetentionPolicies(backups, retentionSettings);

      const recommendationContext = this._buildRecommendationContext({
        backups,
        retentionSettings,
        impact,
        optimization
      });

      // Generate recommendations with contextual awareness
      const recommendations = this._generateRecommendations({
        backups,
        retentionSettings,
        impact,
        optimization,
        context: recommendationContext
      });

      // Create detailed breakdown by policy type
      const breakdown = await this._createPolicyBreakdown(
        backups,
        retentionSettings,
        policy
      );

      logger.info('Retention preview generated', {
        category: 'backup',
        data: {
          totalBackups: backups.length,
          backupsToDelete: backupsToDelete.length,
          spaceSaved: impact.spaceSaved,
          warningsCount: warnings.length,
          recommendationsCount: recommendations.length
        }
      });

      return {
        hasActiveRules: true,
        impact,
        backupsToDelete: backupsToDelete.map(backup => ({
          ...backup,
          reason: this._getDeletionReason(backup, retentionSettings),
          ageInDays: this._getBackupAgeInDays(backup)
        })),
        backupsToKeep: backupsToKeep.map(backup => ({
          ...backup,
          reason: this._getPreservationReason(backup, retentionSettings),
          ageInDays: this._getBackupAgeInDays(backup)
        })),
        warnings,
        recommendations,
        recommendationContext,
        optimization,
        breakdown,
        policyDescription: policy.getDescription(),
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Failed to generate retention preview', {
        category: 'backup',
        data: {
          error: error.message,
          backupsCount: backups.length
        }
      });

      throw new Error(`Failed to generate retention preview: ${error.message}`);
    }
  }

  /**
   * Create a retention policy from UI settings
   * @param {Object} settings - Retention policy settings from UI
   * @returns {RetentionPolicy} Configured retention policy
   * @private
   */
  _createPolicyFromSettings(settings) {
    const options = {
      preserveRecent: 1 // Always preserve at least 1 backup
    };

    if (settings.sizeRetentionEnabled && settings.maxSizeValue) {
      options.maxSize = this._convertSizeToBytes(
        settings.maxSizeValue,
        settings.maxSizeUnit
      );
    }

    if (settings.ageRetentionEnabled && settings.maxAgeValue) {
      options.maxAge = this._convertAgeToMilliseconds(
        settings.maxAgeValue,
        settings.maxAgeUnit
      );
    }

    if (settings.countRetentionEnabled && settings.maxCountValue) {
      options.maxCount = settings.maxCountValue;
    }

    return new RetentionPolicy(options);
  }

  /**
   * Check for size-based warnings
   * @param {number} currentSize - Current total size in bytes
   * @param {number} maxSize - Maximum allowed size in bytes
   * @returns {Array} Array of size-related warnings
   * @private
   */
  _checkSizeWarnings(currentSize, maxSize) {
    const warnings = [];
    const sizeRatio = currentSize / maxSize;

    if (sizeRatio > 1.0) {
      warnings.push({
        type: WarningTypes.SIZE_EXCEEDED,
        severity: WarningSeverity.CRITICAL,
        title: 'Storage Limit Exceeded',
        message: `Total backup size (${formatSize(currentSize)}) exceeds the limit (${formatSize(maxSize)})`,
        details: `Excess: ${formatSize(currentSize - maxSize)}. Automatic cleanup will be triggered.`,
        currentValue: currentSize,
        limitValue: maxSize,
        ratio: sizeRatio,
        timestamp: new Date().toISOString()
      });
    }
    // Note: Removed "approaching limit" warnings as they're expected with retention policies

    return warnings;
  }

  /**
   * Check for age-based warnings
   * @param {Object} oldestBackup - Oldest backup object
   * @param {number} maxAge - Maximum allowed age in milliseconds
   * @param {Array} backups - Array of backup objects
   * @returns {Array} Array of age-related warnings
   * @private
   */
  _checkAgeWarnings(oldestBackup, maxAge, backups) {
    const warnings = [];

    if (!oldestBackup) {
      return warnings;
    }

    const oldestAge = Date.now() - this._getBackupDate(oldestBackup).getTime();
    const ageRatio = oldestAge / maxAge;

    if (ageRatio >= 1.0) {
      const expiredCount = backups.filter(backup => {
        const backupAge = Date.now() - this._getBackupDate(backup).getTime();
        return backupAge > maxAge;
      }).length;

      warnings.push({
        type: WarningTypes.AGE_EXCEEDED,
        severity: WarningSeverity.CRITICAL,
        title: 'Backup Age Limit Exceeded',
        message: `${expiredCount} backup(s) exceed the age limit of ${this._formatDuration(maxAge)}`,
        details: `Oldest backup is ${this._formatDuration(oldestAge)} old. Automatic cleanup will be triggered.`,
        currentValue: oldestAge,
        limitValue: maxAge,
        ratio: ageRatio,
        expiredCount,
        timestamp: new Date().toISOString()
      });
    }
    // Note: Removed "approaching limit" warnings as they're expected with retention policies

    return warnings;
  }

  /**
   * Check for count-based warnings
   * @param {number} currentCount - Current number of backups
   * @param {number} maxCount - Maximum allowed number of backups
   * @returns {Array} Array of count-related warnings
   * @private
   */
  _checkCountWarnings(currentCount, maxCount) {
    const warnings = [];
    const countRatio = currentCount / maxCount;

    if (countRatio > 1.0) {
      const excessCount = currentCount - maxCount;
      warnings.push({
        type: WarningTypes.COUNT_EXCEEDED,
        severity: WarningSeverity.CRITICAL,
        title: 'Backup Count Limit Exceeded',
        message: `${excessCount} backup(s) exceed the limit of ${maxCount}`,
        details: `Current: ${currentCount}, Limit: ${maxCount}. ${excessCount} backup(s) will be deleted automatically.`,
        currentValue: currentCount,
        limitValue: maxCount,
        ratio: countRatio,
        excessCount,
        timestamp: new Date().toISOString()
      });
    }
    // Note: Removed "approaching limit" warnings as they're expected with retention policies

    return warnings;
  }

  /**
   * Check for dangerous policy combinations and edge cases
   * @param {RetentionPolicy} policy - Retention policy instance
   * @param {Array} backups - Array of backup objects
   * @returns {Promise<Array>} Array of policy-related warnings
   * @private
   */
  async _checkPolicyWarnings(policy, backups) {
    const warnings = [];

    try {
      const evaluationResult = await policy.evaluateBackups(backups);

      // Handle both old and new evaluation result formats
      const backupsToDelete = Array.isArray(evaluationResult)
        ? evaluationResult
        : (evaluationResult.toDelete || []);

      const backupsRemaining = backups.length - backupsToDelete.length;

      // Check if all backups would be deleted
      if (backupsRemaining === 0 && backups.length > 0) {
        warnings.push({
          type: WarningTypes.ALL_BACKUPS_WOULD_BE_DELETED,
          severity: WarningSeverity.ERROR,
          title: 'All Backups Would Be Deleted',
          message: 'Current retention policy would delete all backups',
          details: 'This is prevented by the minimum preservation setting, but indicates overly aggressive policies.',
          timestamp: new Date().toISOString()
        });
      }

      // Check if very few backups would remain
      if (backupsRemaining > 0 && backupsRemaining <= 2 && backups.length > 5) {
        warnings.push({
          type: WarningTypes.NO_BACKUPS_TO_PRESERVE,
          severity: WarningSeverity.WARNING,
          title: 'Very Few Backups Would Remain',
          message: `Only ${backupsRemaining} backup(s) would remain out of ${backups.length}`,
          details: 'Consider adjusting retention policies to preserve more backup history.',
          remainingCount: backupsRemaining,
          totalCount: backups.length,
          timestamp: new Date().toISOString()
        });
      }

    } catch (error) {
      warnings.push({
        type: 'policy-evaluation-error',
        severity: WarningSeverity.ERROR,
        title: 'Policy Evaluation Error',
        message: 'Unable to evaluate retention policy impact',
        details: error.message,
        timestamp: new Date().toISOString()
      });
    }

    return warnings;
  }

  /**
   * Generate recommendations based on backup patterns, settings, and optimization context
   * @param {Object} params
   * @param {Array} params.backups
   * @param {Object} params.retentionSettings
   * @param {Object} [params.impact]
   * @param {Object|null} [params.optimization]
   * @param {Object} [params.context]
   * @returns {Array}
   * @private
   */
  _generateRecommendations({ backups, retentionSettings: settings, impact = {}, optimization = null, context }) {
    const recommendations = [];
    const seen = new Set();

    const pushRecommendation = (recommendation) => {
      if (!recommendation) {
        return;
      }

      const key = recommendation.id || recommendation.type || recommendation.title;
      if (!key || seen.has(key)) {
        return;
      }

      const severity = recommendation.severity || this._mapPriorityToSeverity(recommendation.priority);
      const priority = recommendation.priority || this._mapSeverityToPriority(severity);

      const enriched = {
        group: RecommendationGroups.STORAGE,
        severity,
        priority,
        timestamp: new Date().toISOString(),
        ...recommendation
      };

      if (!enriched.group && recommendation.type) {
        enriched.group = this._inferGroupFromType(recommendation.type);
      }

      seen.add(key);
      recommendations.push(enriched);
    };

    const totalBackups = context?.totalCount ?? backups.length;
    const totalSize = context?.totalSize ?? backups.reduce((sum, b) => sum + (b.size || 0), 0);
    const averageSize = context?.averageSize ?? (totalBackups > 0 ? totalSize / totalBackups : 0);

    const hasSizeRetention = !!settings.sizeRetentionEnabled;
    const hasAgeRetention = !!settings.ageRetentionEnabled;
    const hasCountRetention = !!settings.countRetentionEnabled;
    const activeRetentionCount = [hasSizeRetention, hasAgeRetention, hasCountRetention].filter(Boolean).length;

    const storageUtilization = context?.storageUtilization ?? null;
    const sizeRatio = context?.sizeRatio ?? null;
    const countRatio = context?.countRatio ?? null;
    const ageRatio = context?.ageRatio ?? null;

    const projectMonthlyGrowth = context?.projectedMonthlyGrowthBytes ?? null;
    const projectedMonthlyBackups = context?.projectedMonthlyBackups ?? null;
    const averageIntervalMs = context?.averageIntervalMs ?? null;
    const growthTrend = context?.growthTrend ?? 'unknown';

    const humanFrequency = frequency => {
      if (!frequency) return 'an unknown schedule';
      const pattern = frequency.pattern;
      switch (pattern) {
        case 'very-frequent':
          return 'multiple times per hour';
        case 'frequent':
          return 'several times per day';
        case 'daily':
          return 'daily';
        case 'weekly':
          return 'weekly';
        case 'infrequent':
          return 'every few months';
        case 'irregular':
        default:
          return 'irregular intervals';
      }
    };

    const contextualMetrics = {
      totalBackups,
      totalSize,
      averageSize,
      storageUtilization,
      projectedMonthlyGrowth: projectMonthlyGrowth,
      projectedMonthlyBackups,
      averageIntervalMs,
      sizeRatio,
      countRatio,
      ageRatio
    };

    // Integrate optimization engine recommendations for richer guidance
    if (optimization?.recommendations?.length) {
      optimization.recommendations.forEach((optRec, index) => {
        const mappedSeverity = this._mapPriorityToSeverity(optRec.priority);
        pushRecommendation({
          id: `optimizer-${optRec.type || index}`,
          type: optRec.type || 'optimizer-recommendation',
          title: optRec.title || 'Optimization Suggestion',
          message: optRec.message,
          details: optRec.description,
          group: this._inferGroupFromType(optRec.type),
          severity: mappedSeverity,
          priority: (optRec.priority || 'medium').toLowerCase(),
          suggestedAction: optRec.suggestedAction,
          suggestedValue: optRec.suggestedValue,
          suggestedUnit: optRec.suggestedUnit,
          expectedImpact: optRec.expectedImpact,
          confidence: optRec.confidence,
          metrics: {
            ...contextualMetrics,
            optimizer: true
          }
        });
      });
    }

    // Recommend enabling retention if none are active or coverage is low
    if (activeRetentionCount === 0) {
      const severity = (totalBackups > 20 || growthTrend === 'growing')
        ? RecommendationSeverity.CRITICAL
        : RecommendationSeverity.WARNING;

      const suggestedLimit = Math.max(10, Math.min(30, Math.ceil(totalBackups * 0.7) || 10));

      pushRecommendation({
        id: 'enable-retention',
        type: 'enable-retention',
        group: RecommendationGroups.COVERAGE,
        severity,
        priority: severity === RecommendationSeverity.CRITICAL ? 'critical' : 'high',
        title: 'Enable retention automation',
        message: `Backups run on ${humanFrequency(context?.frequency)} and none of the retention safeguards are enabled.`,
        details: `With ${totalBackups} backups totalling ${formatSize(totalSize)}, turning on retention prevents runaway growth.`,
        suggestedAction: `Enable count-based retention and cap at ${suggestedLimit} backups`,
        suggestedSettings: {
          countRetentionEnabled: true,
          maxCountValue: suggestedLimit
        },
        metrics: contextualMetrics
      });
    }

    // Recommend size-based retention or adjustments when storage utilization is high
    if (!hasSizeRetention && totalSize > 5 * SizeConstants.GB) {
      const suggestedLimitGb = Math.max(5, Math.ceil((totalSize / SizeConstants.GB) * 0.9));
      pushRecommendation({
        id: 'enable-size-retention',
        type: 'enable-size-retention',
        group: RecommendationGroups.STORAGE,
        severity: storageUtilization && storageUtilization > 0.85
          ? RecommendationSeverity.CRITICAL
          : RecommendationSeverity.WARNING,
        priority: storageUtilization && storageUtilization > 0.85 ? 'high' : 'medium',
        title: 'Control storage usage with a size limit',
        message: `Backups currently occupy ${formatSize(totalSize)} without a size cap.`,
        details: 'Size-based retention protects against spikes when automated backups run frequently.',
        suggestedAction: `Enable size retention and cap at ${suggestedLimitGb} GB`,
        suggestedValue: suggestedLimitGb,
        suggestedUnit: 'GB',
        metrics: contextualMetrics
      });
    } else if (hasSizeRetention && sizeRatio !== null && sizeRatio >= 0.8) {
      const severity = sizeRatio >= 1 ? RecommendationSeverity.CRITICAL : RecommendationSeverity.WARNING;
      pushRecommendation({
        id: 'adjust-size-retention',
        type: 'adjust-size-retention',
        group: RecommendationGroups.STORAGE,
        severity,
        priority: severity === RecommendationSeverity.CRITICAL ? 'high' : 'medium',
        title: 'Size limit nearly reached',
        message: `Backups are using ${(sizeRatio * 100).toFixed(0)}% of the configured size limit.`,
        details: 'Consider raising the limit slightly or pruning older backups manually.',
        suggestedAction: 'Increase the size limit or delete stale backups',
        metrics: {
          ...contextualMetrics,
          sizeLimitBytes: context?.sizeLimitBytes
        }
      });
    }

    // Recommend age-based retention if oldest backups are stale
    if (!hasAgeRetention && context?.oldestAgeMs && context.oldestAgeMs > 60 * TimeConstants.DAY) {
      const suggestedAgeDays = context.averageIntervalMs
        ? Math.max(30, Math.round((context.averageIntervalMs / TimeConstants.DAY) * 10))
        : 30;

      pushRecommendation({
        id: 'enable-age-retention',
        type: 'enable-age-retention',
        group: RecommendationGroups.SAFETY,
        severity: RecommendationSeverity.ADVISORY,
        priority: 'medium',
        title: 'Cull very old backups automatically',
        message: `Oldest backup is ${this._formatDuration(context.oldestAgeMs)} old and never expires.`,
        details: 'Age-based retention prevents ancient backups from lingering indefinitely.',
        suggestedAction: `Enable age retention and expire backups after ${suggestedAgeDays} days`,
        suggestedValue: suggestedAgeDays,
        suggestedUnit: 'days',
        metrics: contextualMetrics
      });
    } else if (hasAgeRetention && ageRatio !== null && ageRatio >= 0.8) {
      pushRecommendation({
        id: 'age-limit-approaching',
        type: 'adjust-age-retention',
        group: RecommendationGroups.SAFETY,
        severity: RecommendationSeverity.WARNING,
        priority: 'medium',
        title: 'Age limit nearly reached',
        message: `Several backups will expire soon (oldest is ${this._formatDuration(context.oldestAgeMs || 0)} old).`,
        details: 'Review whether the age window is still appropriate before automatic cleanup runs.',
        metrics: contextualMetrics
      });
    }

    // Recommend count-based retention adjustments
    if (!hasCountRetention && totalBackups > 15) {
      const suggestedLimit = Math.max(10, Math.floor(totalBackups * 0.75));
      pushRecommendation({
        id: 'enable-count-retention',
        type: 'enable-count-retention',
        group: RecommendationGroups.COVERAGE,
        severity: RecommendationSeverity.ADVISORY,
        priority: 'medium',
        title: 'Cap the number of backups retained',
        message: `You currently have ${totalBackups} backups with no count limit.`,
        details: 'A count limit keeps the catalog manageable and speeds up browse operations.',
        suggestedAction: `Enable count retention and keep the latest ${suggestedLimit} backups`,
        suggestedValue: suggestedLimit,
        metrics: contextualMetrics
      });
    } else if (hasCountRetention && countRatio !== null && countRatio >= 0.85) {
      pushRecommendation({
        id: 'count-limit-approaching',
        type: 'adjust-count-retention',
        group: RecommendationGroups.COVERAGE,
        severity: RecommendationSeverity.WARNING,
        priority: 'medium',
        title: 'Backup count limit is nearly reached',
        message: `Count limit is ${(countRatio * 100).toFixed(0)}% consumed.`,
        details: 'Increase the cap or remove older backups to avoid forced deletions during the next cleanup.',
        metrics: contextualMetrics
      });
    }

    // Detect aggressive policies that remove most backups
    if (impact.backupsToDelete > impact.backupsRemaining && impact.backupsRemaining < 5) {
      pushRecommendation({
        id: 'aggressive-policy',
        type: 'adjust-aggressive-policy',
        group: RecommendationGroups.SAFETY,
        severity: RecommendationSeverity.CRITICAL,
        priority: 'high',
        title: 'Retention policy is overly aggressive',
        message: `This run would delete ${impact.backupsToDelete} backups, leaving only ${impact.backupsRemaining}.`,
        details: 'Relax the limits or disable one of the rules to keep a healthier safety net.',
        suggestedAction: 'Raise the limits or disable overlapping policies',
        metrics: {
          ...contextualMetrics,
          backupsToDelete: impact.backupsToDelete,
          backupsRemaining: impact.backupsRemaining
        }
      });
    }

    // Highlight rapid growth trends
    if (growthTrend === 'growing' && projectMonthlyGrowth && projectMonthlyGrowth > 5 * SizeConstants.GB) {
      pushRecommendation({
        id: 'growth-alert',
        type: 'growth-trend',
        group: RecommendationGroups.PERFORMANCE,
        severity: RecommendationSeverity.WARNING,
        priority: 'medium',
        title: 'Backups are growing quickly',
        message: `At the current pace you'll add ${formatSize(projectMonthlyGrowth)} of backups this month.`,
        details: 'Adjust retention or review backup frequency to avoid exceeding storage capacity.',
        metrics: contextualMetrics
      });
    }

    // Surface optimization potential if score indicates room for improvement
    if (context?.optimizationPotential !== null && context.optimizationPotential > 0.6) {
      pushRecommendation({
        id: 'apply-optimizer-suggestions',
        type: 'optimization-followup',
        group: RecommendationGroups.MAINTENANCE,
        severity: RecommendationSeverity.ADVISORY,
        priority: 'medium',
        title: 'Apply optimizer suggestions',
        message: 'There is significant room for tightening retention. Review the optimization panel for guided changes.',
        details: 'Optimizer insights combine frequency analysis and storage projections to recommend safer defaults.',
        metrics: contextualMetrics
      });
    }

    return recommendations;
  }

  /**
   * Create detailed breakdown of policy impact by type
   * @param {Array} backups - Array of backup objects
   * @param {Object} settings - Retention settings
   * @param {RetentionPolicy} policy - Retention policy instance
   * @returns {Promise<Object>} Policy breakdown
   * @private
   */
  async _createPolicyBreakdown(backups, settings, policy) {
    const breakdown = {
      sizePolicy: null,
      agePolicy: null,
      countPolicy: null,
      combined: null
    };

    try {
      // Analyze individual policy impacts
      if (settings.sizeRetentionEnabled) {
        const sizePolicy = new RetentionPolicy({
          maxSize: this._convertSizeToBytes(settings.maxSizeValue, settings.maxSizeUnit),
          preserveRecent: 1
        });
        breakdown.sizePolicy = await sizePolicy.getPolicyImpact(backups);
      }

      if (settings.ageRetentionEnabled) {
        const agePolicy = new RetentionPolicy({
          maxAge: this._convertAgeToMilliseconds(settings.maxAgeValue, settings.maxAgeUnit),
          preserveRecent: 1
        });
        breakdown.agePolicy = await agePolicy.getPolicyImpact(backups);
      }

      if (settings.countRetentionEnabled) {
        const countPolicy = new RetentionPolicy({
          maxCount: settings.maxCountValue,
          preserveRecent: 1
        });
        breakdown.countPolicy = await countPolicy.getPolicyImpact(backups);
      }

      // Combined impact
      breakdown.combined = await policy.getPolicyImpact(backups);

    } catch (error) {
      logger.error('Failed to create policy breakdown', {
        category: 'backup',
        data: { error: error.message }
      });
    }

    return breakdown;
  }

  /**
   * Build context information used when generating recommendations
   * @param {Object} params
   * @param {Array} params.backups
   * @param {Object} params.retentionSettings
   * @param {Object} params.impact
   * @param {Object|null} params.optimization
   * @returns {Object}
   * @private
   */
  _buildRecommendationContext({ backups, retentionSettings, impact, optimization }) {
    const totalSize = backups.reduce((sum, backup) => sum + (backup.size || 0), 0);
    const totalCount = backups.length;
    const averageSize = totalCount > 0 ? totalSize / totalCount : 0;

    const oldestBackup = this._getOldestBackup(backups);
    const newestBackup = backups.reduce((latest, backup) => {
      if (!latest) return backup;
      const backupDate = this._getBackupDate(backup);
      const latestDate = this._getBackupDate(latest);
      return backupDate > latestDate ? backup : latest;
    }, null);

    const oldestAgeMs = oldestBackup ? Date.now() - this._getBackupDate(oldestBackup).getTime() : null;
    const newestAgeMs = newestBackup ? Date.now() - this._getBackupDate(newestBackup).getTime() : null;

    const sizeLimitBytes = retentionSettings.sizeRetentionEnabled && retentionSettings.maxSizeValue
      ? this._convertSizeToBytes(retentionSettings.maxSizeValue, retentionSettings.maxSizeUnit)
      : null;

    const countLimit = retentionSettings.countRetentionEnabled && retentionSettings.maxCountValue
      ? retentionSettings.maxCountValue
      : null;

    const ageLimitMs = retentionSettings.ageRetentionEnabled && retentionSettings.maxAgeValue
      ? this._convertAgeToMilliseconds(retentionSettings.maxAgeValue, retentionSettings.maxAgeUnit)
      : null;

    const diskCapacityBytes = typeof retentionSettings.diskCapacityBytes === 'number'
      ? retentionSettings.diskCapacityBytes
      : null;

    const optimizationMetrics = optimization?.metrics || {};
    const optimizationPatterns = optimization?.patterns || {};

    const frequency = optimizationPatterns.frequency || null;
    const growthTrend = optimizationPatterns.growthTrend || 'unknown';
    const storageUtilization = optimizationMetrics.storageUtilization ?? null;
    const retentionPressure = optimizationMetrics.retentionPressure ?? null;
    const optimizationPotential = optimizationMetrics.optimizationPotential ?? null;

    const averageIntervalMs = frequency?.averageInterval ?? null;
    const projectedMonthlyBackups = averageIntervalMs && averageIntervalMs > 0
      ? Math.max(1, Math.round(TimeConstants.MONTH / averageIntervalMs))
      : null;

    const projectedMonthlyGrowthBytes = projectedMonthlyBackups && averageSize
      ? projectedMonthlyBackups * averageSize
      : null;

    const sizeRatio = sizeLimitBytes ? totalSize / sizeLimitBytes : null;
    const countRatio = countLimit ? totalCount / countLimit : null;
    const ageRatio = ageLimitMs && oldestAgeMs ? oldestAgeMs / ageLimitMs : null;

    return {
      totalSize,
      totalCount,
      averageSize,
      oldestBackup,
      newestBackup,
      oldestAgeMs,
      newestAgeMs,
      sizeLimitBytes,
      countLimit,
      ageLimitMs,
      diskCapacityBytes,
      storageUtilization,
      retentionPressure,
      optimizationPotential,
      frequency,
      growthTrend,
      averageIntervalMs,
      projectedMonthlyBackups,
      projectedMonthlyGrowthBytes,
      sizeRatio,
      countRatio,
      ageRatio,
      impact
    };
  }

  _mapPriorityToSeverity(priority) {
    const normalized = typeof priority === 'string' ? priority.toLowerCase() : priority;
    switch (normalized) {
      case 'critical':
        return RecommendationSeverity.CRITICAL;
      case 'high':
        return RecommendationSeverity.WARNING;
      case 'medium':
        return RecommendationSeverity.ADVISORY;
      case 'low':
      default:
        return RecommendationSeverity.INFO;
    }
  }

  _mapSeverityToPriority(severity) {
    switch (severity) {
      case RecommendationSeverity.CRITICAL:
        return 'critical';
      case RecommendationSeverity.WARNING:
        return 'high';
      case RecommendationSeverity.ADVISORY:
        return 'medium';
      case RecommendationSeverity.INFO:
      default:
        return 'low';
    }
  }

  _inferGroupFromType(type = '') {
    const normalized = type.toLowerCase();
    if (normalized.includes('size')) {
      return RecommendationGroups.STORAGE;
    }
    if (normalized.includes('count')) {
      return RecommendationGroups.COVERAGE;
    }
    if (normalized.includes('age')) {
      return RecommendationGroups.SAFETY;
    }
    if (normalized.includes('growth') || normalized.includes('performance')) {
      return RecommendationGroups.PERFORMANCE;
    }
    if (normalized.includes('optimization')) {
      return RecommendationGroups.MAINTENANCE;
    }
    return RecommendationGroups.STORAGE;
  }

  /**
   * Get the reason why a backup would be deleted
   * @param {Object} backup - Backup object
   * @param {Object} settings - Retention settings
   * @returns {string} Deletion reason
   * @private
   */
  _getDeletionReason(backup, settings) {
    const reasons = [];
    const backupDate = this._getBackupDate(backup);
    const backupAge = Date.now() - backupDate.getTime();

    if (settings.ageRetentionEnabled) {
      const maxAge = this._convertAgeToMilliseconds(settings.maxAgeValue, settings.maxAgeUnit);
      if (backupAge > maxAge) {
        reasons.push(`Exceeds age limit (${this._formatDuration(maxAge)})`);
      }
    }

    if (settings.sizeRetentionEnabled) {
      reasons.push('Size limit enforcement');
    }

    if (settings.countRetentionEnabled) {
      reasons.push('Count limit enforcement');
    }

    return reasons.length > 0 ? reasons.join(', ') : 'Retention policy';
  }

  /**
   * Get the reason why a backup would be preserved
   * @param {Object} backup - Backup object
   * @param {Object} settings - Retention settings
   * @returns {string} Preservation reason
   * @private
   */
  _getPreservationReason(backup, settings) {
    const backupDate = this._getBackupDate(backup);
    const backupAge = Date.now() - backupDate.getTime();

    // Check if it's a recent backup
    if (backupAge < 7 * TimeConstants.DAY) {
      return 'Recent backup (within 7 days)';
    }

    const reasons = [];

    if (settings.ageRetentionEnabled) {
      const maxAge = this._convertAgeToMilliseconds(settings.maxAgeValue, settings.maxAgeUnit);
      if (backupAge < maxAge) {
        reasons.push('Within age limit');
      }
    }

    if (settings.sizeRetentionEnabled || settings.countRetentionEnabled) {
      reasons.push('Within retention limits');
    }

    return reasons.length > 0 ? reasons.join(', ') : 'Preserved by policy';
  }

  /**
   * Get backup age in days
   * @param {Object} backup - Backup object
   * @returns {number} Age in days
   * @private
   */
  _getBackupAgeInDays(backup) {
    const backupDate = this._getBackupDate(backup);
    const ageMs = Date.now() - backupDate.getTime();
    return Math.floor(ageMs / TimeConstants.DAY);
  }

  /**
   * Get the oldest backup from an array
   * @param {Array} backups - Array of backup objects
   * @returns {Object|null} Oldest backup or null if empty
   * @private
   */
  _getOldestBackup(backups) {
    if (backups.length === 0) return null;

    return backups.reduce((oldest, backup) => {
      const backupDate = this._getBackupDate(backup);
      const oldestDate = this._getBackupDate(oldest);
      return backupDate < oldestDate ? backup : oldest;
    });
  }

  /**
   * Get the creation date from a backup object
   * @param {Object} backup - Backup object
   * @returns {Date} Creation date
   * @private
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
   * Convert size value and unit to bytes
   * @param {number} value - Size value
   * @param {string} unit - Size unit (GB, TB)
   * @returns {number} Size in bytes
   * @private
   */
  _convertSizeToBytes(value, unit) {
    const multipliers = {
      GB: SizeConstants.GB,
      TB: SizeConstants.TB
    };
    return value * (multipliers[unit] || SizeConstants.GB);
  }

  /**
   * Convert age value and unit to milliseconds
   * @param {number} value - Age value
   * @param {string} unit - Age unit (days, weeks, months)
   * @returns {number} Age in milliseconds
   * @private
   */
  _convertAgeToMilliseconds(value, unit) {
    const multipliers = {
      days: TimeConstants.DAY,
      weeks: TimeConstants.WEEK,
      months: TimeConstants.MONTH
    };
    return value * (multipliers[unit] || TimeConstants.DAY);
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
 * Utility function to create a warning system with default settings
 * @param {Object} options - Configuration options
 * @returns {RetentionWarningSystem} Configured warning system
 */
export function createWarningSystem(options = {}) {
  return new RetentionWarningSystem(options);
}

/**
 * Utility function to quickly analyze warnings for current settings
 * @param {Array} backups - Array of backup objects
 * @param {Object} retentionSettings - Current retention settings
 * @returns {Promise<Array>} Array of warnings
 */
export async function analyzeRetentionWarnings(backups, retentionSettings) {
  const warningSystem = createWarningSystem();
  return await warningSystem.analyzeRetentionWarnings(backups, retentionSettings);
}

/**
 * Utility function to quickly generate a retention preview
 * @param {Array} backups - Array of backup objects
 * @param {Object} retentionSettings - Retention settings
 * @returns {Promise<Object>} Preview result
 */
export async function generateRetentionPreview(backups, retentionSettings) {
  const warningSystem = createWarningSystem();
  return await warningSystem.generateRetentionPreview(backups, retentionSettings);
}/**
 * O
ptimize retention policies based on backup patterns
 * @param {Array} backups - Array of backup objects
 * @param {Object} currentSettings - Current retention policy settings
 * @returns {Promise<Object>} Optimization recommendations
 */
async function fallbackOptimizeRetentionPolicies(backups, currentSettings = {}) {
  // Basic optimization analysis
  const totalSize = backups.reduce((sum, backup) => sum + (backup.size || 0), 0);
  const averageSize = backups.length > 0 ? totalSize / backups.length : 0;

  const recommendations = [];
  let effectivenessScore = 75; // Base score

  // Analyze current settings effectiveness
  if (currentSettings.sizeRetentionEnabled) {
    const maxSizeBytes = currentSettings.maxSizeValue * (currentSettings.maxSizeUnit === 'GB' ? SizeConstants.GB : SizeConstants.TB);
    if (totalSize > maxSizeBytes * 0.9) {
      recommendations.push({
        type: 'size_optimization',
        priority: 'high',
        title: 'Size limit approaching',
        description: 'Consider reducing the size limit or enabling additional retention policies',
        suggestedValue: Math.floor(currentSettings.maxSizeValue * 0.8),
        suggestedUnit: currentSettings.maxSizeUnit
      });
      effectivenessScore -= 15;
    }
  }

  if (currentSettings.countRetentionEnabled) {
    if (backups.length > currentSettings.maxCountValue * 0.9) {
      recommendations.push({
        type: 'count_optimization',
        priority: 'medium',
        title: 'Backup count approaching limit',
        description: 'Consider reducing the count limit or enabling size-based retention',
        suggestedValue: Math.floor(currentSettings.maxCountValue * 0.8)
      });
      effectivenessScore -= 10;
    }
  }

  // Suggest enabling policies if none are active
  if (!currentSettings.sizeRetentionEnabled && !currentSettings.ageRetentionEnabled && !currentSettings.countRetentionEnabled) {
    recommendations.push({
      type: 'enable_policies',
      priority: 'high',
      title: 'No retention policies active',
      description: 'Enable at least one retention policy to manage backup storage',
      suggestedSettings: {
        countRetentionEnabled: true,
        maxCountValue: Math.max(5, Math.min(20, backups.length))
      }
    });
    effectivenessScore = 25;
  }

  return {
    recommendations,
    effectiveness: {
      overallScore: effectivenessScore,
      currentSize: totalSize,
      formattedCurrentSize: formatSize(totalSize),
      averageBackupSize: averageSize,
      formattedAverageSize: formatSize(averageSize),
      backupCount: backups.length
    },
    suggestedPolicies: [
      {
        name: 'Conservative',
        description: 'Keep more backups for safety',
        settings: {
          countRetentionEnabled: true,
          maxCountValue: Math.max(10, Math.floor(backups.length * 0.8)),
          sizeRetentionEnabled: false,
          ageRetentionEnabled: false
        }
      },
      {
        name: 'Balanced',
        description: 'Balance between storage and retention',
        settings: {
          countRetentionEnabled: true,
          maxCountValue: Math.max(7, Math.floor(backups.length * 0.6)),
          sizeRetentionEnabled: true,
          maxSizeValue: Math.max(1, Math.floor(totalSize / SizeConstants.GB * 0.7)),
          maxSizeUnit: 'GB',
          ageRetentionEnabled: false
        }
      },
      {
        name: 'Aggressive',
        description: 'Minimize storage usage',
        settings: {
          countRetentionEnabled: true,
          maxCountValue: Math.max(3, Math.floor(backups.length * 0.4)),
          sizeRetentionEnabled: true,
          maxSizeValue: Math.max(1, Math.floor(totalSize / SizeConstants.GB * 0.5)),
          maxSizeUnit: 'GB',
          ageRetentionEnabled: true,
          maxAgeValue: 30,
          maxAgeUnit: 'days'
        }
      }
    ]
  };
}

/**
 * Optimize retention policies using shared core logic with renderer fallback.
 */
export async function optimizeRetentionPolicies(backups, currentSettings = {}) {
  try {
    return await optimizeRetentionPoliciesCore(backups, currentSettings);
  } catch (error) {
    logger.error('Shared retention optimization failed, using fallback implementation', {
      category: 'backup',
      data: {
        function: 'optimizeRetentionPolicies',
        error: error.message,
        backupCount: Array.isArray(backups) ? backups.length : 'unknown'
      }
    });

    return await fallbackOptimizeRetentionPolicies(backups, currentSettings);
  }
}
