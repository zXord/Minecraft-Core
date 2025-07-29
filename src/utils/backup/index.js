/// <reference path="../../electron.d.ts" />

/**
 * Backup Utilities Index
 * Centralized exports for all backup-related utilities
 */

// Size calculation utilities
export {
  calculateTotalSize,
  formatSize,
  getCachedSize,
  setCachedSize,
  clearSizeCache,
  watchSizeChanges,
  calculateBackupSizes,
  calculateBackupSizesBackground,
  addSizeChangeListenerOptimized,
  invalidateSizeCache,
  getCacheStats,
  createSizeCalculationErrorMessage,
  validateSizeCalculationResult,
  queueBackgroundCalculation,
  cleanup
} from './sizeCalculator.js';

// Retention policy utilities
export {
  RetentionPolicy,
  RetentionPolicyPresets,
  TimeConstants,
  SizeConstants,
  RetentionPolicyValidator
} from './retentionPolicy.js';

// Retention execution utilities
export {
  RetentionPolicyExecutor,
  createRetentionExecutor,
  executeRetentionPolicies,
  previewRetentionPolicies
} from './retentionExecutor.js';

// Statistics calculation utilities
export {
  BackupStatistics,
  StatisticsUtils
} from './statisticsService.js';

// Retention warnings and preview utilities
export {
  RetentionWarningSystem,
  WarningTypes,
  WarningSeverity,
  createWarningSystem,
  analyzeRetentionWarnings,
  generateRetentionPreview,
  optimizeRetentionPolicies
} from './retentionWarnings.js';

// Retention optimization utilities
export {
  retentionOptimizer,
  RecommendationPriority
} from './retentionOptimizer.js';