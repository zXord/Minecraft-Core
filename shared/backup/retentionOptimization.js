// Shared retention optimization logic used by renderer and main processes

export const RecommendationPriority = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

export const TimeConstants = {
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
  MONTH: 30 * 24 * 60 * 60 * 1000,
  YEAR: 365 * 24 * 60 * 60 * 1000
};

export const SizeConstants = {
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
  TB: 1024 * 1024 * 1024 * 1024
};

/**
 * Optimize retention policies based on backup patterns.
 * Designed to be deterministic and side-effect free so it can run on any process.
 * @param {Array} backups
 * @param {Object} currentSettings
 * @returns {Promise<Object>}
 */
export async function optimizeRetentionPolicies(backups, currentSettings = {}) {
  const safeBackups = Array.isArray(backups) ? backups.filter(Boolean) : [];
  const totalSize = safeBackups.reduce((sum, backup) => sum + (Number(backup?.size) || 0), 0);
  const averageSize = safeBackups.length > 0 ? totalSize / safeBackups.length : 0;

  const normalizedSettings = normalizeRetentionSettings(currentSettings);

  const baseResult = {
    recommendations: [],
    effectiveness: buildDefaultEffectiveness(totalSize, averageSize, safeBackups.length),
    patterns: buildDefaultPatterns(totalSize, averageSize, safeBackups.length),
    suggestedPolicies: [],
    metrics: {
      optimizationPotential: 1,
      storageUtilization: 0,
      retentionPressure: 0
    }
  };

  if (safeBackups.length === 0) {
    return baseResult;
  }

  const sortedBackups = [...safeBackups].sort((a, b) => getBackupTimestamp(a) - getBackupTimestamp(b));
  const timestamps = sortedBackups.map(getBackupTimestamp);
  const newestBackupAt = timestamps[timestamps.length - 1];
  const oldestBackupAt = timestamps[0];

  const frequency = analyzeBackupFrequency(timestamps);
  const growthTrend = analyzeGrowthTrend(sortedBackups, timestamps);
  const storageUtilization = calculateStorageUtilization(totalSize, normalizedSettings, averageSize);
  const countPressure = calculateCountPressure(sortedBackups.length, normalizedSettings.maxCountValue, normalizedSettings.countRetentionEnabled);
  const agePressure = calculateAgePressure(Date.now() - oldestBackupAt, normalizedSettings.maxAgeMs, normalizedSettings.ageRetentionEnabled);

  const activePolicies = calculateActivePolicyCount(normalizedSettings);
  const retentionBalance = calculateRetentionBalance(activePolicies, frequency);
  const policyUtilization = calculatePolicyUtilization({
    sizeUtilization: storageUtilization,
    countPressure,
    agePressure,
    settings: normalizedSettings
  });

  const storageEfficiency = clamp(1 - storageUtilization, 0, 1);
  const overallScore = clamp(
    (storageEfficiency + retentionBalance + policyUtilization) / 3,
    0,
    1
  );

  const recommendations = buildRecommendations({
    totalSize,
    averageSize,
    backups: sortedBackups,
    settings: normalizedSettings,
    storageUtilization,
    countPressure,
    agePressure,
    frequency,
    newestBackupAt,
    oldestBackupAt
  });

  const suggestedPolicies = buildSuggestedPolicies({
    totalSize,
    averageSize,
    backupCount: sortedBackups.length,
    settings: normalizedSettings,
    storageUtilization
  });

  return {
    recommendations,
    effectiveness: {
      ...baseResult.effectiveness,
      overallScore,
      storageEfficiency,
      retentionBalance,
      policyUtilization,
      currentSize: totalSize,
      formattedCurrentSize: formatSize(totalSize),
      averageBackupSize: averageSize,
      formattedAverageSize: formatSize(averageSize),
      backupCount: sortedBackups.length
    },
    patterns: {
      ...baseResult.patterns,
      totalBackups: sortedBackups.length,
      totalSize,
      averageSize,
      newestBackupAt,
      oldestBackupAt,
      growthTrend,
      frequency
    },
    suggestedPolicies,
    metrics: {
      optimizationPotential: clamp(1 - overallScore, 0, 1),
      storageUtilization,
      retentionPressure: clamp(Math.max(storageUtilization, countPressure, agePressure), 0, 1)
    }
  };
}

function normalizeRetentionSettings(settings) {
  const normalized = {
    sizeRetentionEnabled: !!settings.sizeRetentionEnabled,
    maxSizeValue: Number(settings.maxSizeValue) || 0,
    maxSizeUnit: typeof settings.maxSizeUnit === 'string' ? settings.maxSizeUnit.toUpperCase() : 'GB',
    ageRetentionEnabled: !!settings.ageRetentionEnabled,
    maxAgeValue: Number(settings.maxAgeValue) || 0,
    maxAgeUnit: typeof settings.maxAgeUnit === 'string' ? settings.maxAgeUnit.toLowerCase() : 'days',
    countRetentionEnabled: !!settings.countRetentionEnabled,
    maxCountValue: Number(settings.maxCountValue) || 0
  };

  normalized.maxSizeBytes = normalized.sizeRetentionEnabled && normalized.maxSizeValue > 0
    ? convertSizeToBytes(normalized.maxSizeValue, normalized.maxSizeUnit)
    : null;

  normalized.maxAgeMs = normalized.ageRetentionEnabled && normalized.maxAgeValue > 0
    ? convertAgeToMilliseconds(normalized.maxAgeValue, normalized.maxAgeUnit)
    : null;

  if (!Number.isFinite(normalized.maxCountValue) || normalized.maxCountValue <= 0) {
    normalized.maxCountValue = null;
  }

  return normalized;
}

function buildDefaultEffectiveness(totalSize, averageSize, backupCount) {
  return {
    overallScore: 0,
    storageEfficiency: 0,
    retentionBalance: 0,
    policyUtilization: 0,
    currentSize: totalSize,
    formattedCurrentSize: formatSize(totalSize),
    averageBackupSize: averageSize,
    formattedAverageSize: formatSize(averageSize),
    backupCount
  };
}

function buildDefaultPatterns(totalSize, averageSize, backupCount) {
  return {
    totalBackups: backupCount,
    totalSize,
    averageSize,
    growthTrend: 'unknown',
    frequency: null
  };
}

function getBackupTimestamp(backup) {
  if (backup?.metadata?.timestamp) {
    const ts = new Date(backup.metadata.timestamp).getTime();
    if (!Number.isNaN(ts)) {
      return ts;
    }
  }

  if (backup?.created) {
    const ts = new Date(backup.created).getTime();
    if (!Number.isNaN(ts)) {
      return ts;
    }
  }

  return Date.now();
}

function analyzeBackupFrequency(timestamps) {
  if (!timestamps || timestamps.length < 2) {
    return null;
  }

  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    const delta = Math.max(0, timestamps[i] - timestamps[i - 1]);
    intervals.push(delta);
  }

  if (intervals.length === 0) {
    return null;
  }

  const averageInterval = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const pattern = classifyFrequency(averageInterval);

  return {
    pattern,
    averageInterval,
    samples: intervals.length
  };
}

function classifyFrequency(intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return 'irregular';
  }

  if (intervalMs <= TimeConstants.HOUR) {
    return 'very-frequent';
  }

  if (intervalMs <= TimeConstants.DAY) {
    return 'frequent';
  }

  if (intervalMs <= TimeConstants.WEEK) {
    return 'daily';
  }

  if (intervalMs <= 4 * TimeConstants.WEEK) {
    return 'weekly';
  }

  if (intervalMs <= TimeConstants.MONTH * 3) {
    return 'infrequent';
  }

  return 'irregular';
}

function analyzeGrowthTrend(sortedBackups, timestamps) {
  if (!sortedBackups || sortedBackups.length < 4) {
    return 'stable';
  }

  const mid = Math.floor(sortedBackups.length / 2);
  const firstHalf = sortedBackups.slice(0, mid);
  const secondHalf = sortedBackups.slice(mid);

  const firstDensity = calculateBackupDensity(firstHalf, timestamps[0], timestamps[mid - 1]);
  const secondDensity = calculateBackupDensity(secondHalf, timestamps[mid], timestamps[timestamps.length - 1]);

  if (secondDensity > firstDensity * 1.2) {
    return 'growing';
  }

  if (secondDensity < firstDensity * 0.8) {
    return 'shrinking';
  }

  return 'stable';
}

function calculateBackupDensity(backups, startTs, endTs) {
  const span = Math.max(1, endTs - startTs);
  return backups.length / span;
}

function calculateStorageUtilization(totalSize, settings, averageSize) {
  const baseline = settings.maxSizeBytes || Math.max(SizeConstants.GB * 5, averageSize * 20 || SizeConstants.GB * 2);
  const utilization = totalSize / baseline;
  return clamp(utilization, 0, 1.5);
}

function calculateCountPressure(backupCount, maxCount, enabled) {
  if (enabled && Number.isFinite(maxCount) && maxCount > 0) {
    return clamp(backupCount / maxCount, 0, 1.5);
  }

  if (!enabled && backupCount > 30) {
    const scaled = (backupCount - 30) / 70;
    return clamp(0.4 + scaled, 0, 1.5);
  }

  return 0.25;
}

function calculateAgePressure(oldestAge, maxAge, enabled) {
  if (enabled && Number.isFinite(maxAge) && maxAge > 0) {
    return clamp(oldestAge / maxAge, 0, 1.5);
  }

  if (!enabled) {
    const years = oldestAge / TimeConstants.YEAR;
    if (years >= 1) {
      return clamp(0.5 + years * 0.2, 0, 1.5);
    }
  }

  return 0.2;
}

function calculateActivePolicyCount(settings) {
  return ['sizeRetentionEnabled', 'ageRetentionEnabled', 'countRetentionEnabled']
    .map((key) => (settings[key] ? 1 : 0))
    .reduce((sum, value) => sum + value, 0);
}

function calculateRetentionBalance(activePolicies, frequency) {
  if (activePolicies === 0) {
    return 0;
  }

  let balance = activePolicies / 3;

  if (activePolicies === 1 && frequency && frequency.pattern !== 'infrequent') {
    balance *= 0.6;
  }

  return clamp(balance, 0, 1);
}

function calculatePolicyUtilization({ sizeUtilization, countPressure, agePressure, settings }) {
  const enabledPressures = [];

  if (settings.sizeRetentionEnabled) {
    enabledPressures.push(sizeUtilization);
  }

  if (settings.countRetentionEnabled) {
    enabledPressures.push(countPressure);
  }

  if (settings.ageRetentionEnabled) {
    enabledPressures.push(agePressure);
  }

  if (enabledPressures.length === 0) {
    return 0;
  }

  const normalizedPressures = enabledPressures.map((value) => clamp(value, 0, 1));
  const avgPressure = normalizedPressures.reduce((sum, value) => sum + value, 0) / normalizedPressures.length;
  return clamp(1 - avgPressure, 0, 1);
}

function buildRecommendations({
  totalSize,
  averageSize,
  backups,
  settings,
  storageUtilization,
  countPressure,
  agePressure,
  frequency,
  newestBackupAt,
  oldestBackupAt
}) {
  const recommendations = [];
  const totalSizeGb = totalSize / SizeConstants.GB;
  const sizeLimitGb = settings.maxSizeBytes ? settings.maxSizeBytes / SizeConstants.GB : null;
  const backupCount = backups.length;
  const averageSizeGb = averageSize / SizeConstants.GB;
  const frequencyPattern = frequency?.pattern ?? 'irregular';

  const recommendedCountLimit = Math.max(10, Math.min(backupCount, Math.ceil(backupCount * 0.7)) || 10);
  const recommendedSizeLimitGb = Math.max(5, Math.ceil((totalSizeGb || 1) * 0.8));
  const recommendedAgeDays = getSuggestedAgeWindowForFrequency(frequencyPattern);

  if (!settings.sizeRetentionEnabled && totalSizeGb > 10) {
    recommendations.push({
      type: 'enable-size-retention',
      priority: RecommendationPriority.HIGH,
      title: 'Enable size-based retention',
      message: 'Backups are consuming significant disk space. Setting a size limit prevents runaway growth.',
      suggestedValue: recommendedSizeLimitGb,
      suggestedUnit: 'GB',
      suggestedAction: 'Enable size retention and set a cap to keep storage predictable.',
      expectedImpact: `Keeps total storage near ${recommendedSizeLimitGb} GB (avg backup ~${averageSizeGb.toFixed(1)} GB)`,
      confidence: 0.85
    });
  }

  if (settings.sizeRetentionEnabled && sizeLimitGb && storageUtilization >= 0.9) {
    recommendations.push({
      type: 'adjust-size-limit',
      priority: RecommendationPriority.HIGH,
      title: 'Size limit nearly reached',
      message: 'Backups are close to the configured size limit. Increase the limit or prune old backups.',
      suggestedValue: Math.ceil(sizeLimitGb * 1.2),
      suggestedUnit: settings.maxSizeUnit,
      suggestedAction: 'Raise the size limit or enable additional retention rules.',
      expectedImpact: 'Avoids future backup failures due to full storage.',
      confidence: 0.75
    });
  }

  if (!settings.countRetentionEnabled && backupCount > 20) {
    const countPriority = ['very-frequent', 'frequent'].includes(frequencyPattern)
      ? RecommendationPriority.HIGH
      : RecommendationPriority.MEDIUM;

    recommendations.push({
      type: 'enable-count-retention',
      priority: countPriority,
      title: 'Enable count-based retention',
      message: `Backups are ${frequencyPattern.replace('-', ' ')}. Setting a maximum count keeps only the most recent copies.`,
      suggestedValue: recommendedCountLimit,
      suggestedAction: 'Enable count retention and cap the number of stored backups.',
      expectedImpact: `Keeps roughly the newest ${recommendedCountLimit} backups automatically.`,
      confidence: 0.7
    });
  }

  if (settings.countRetentionEnabled && settings.maxCountValue && countPressure >= 0.9) {
    recommendations.push({
      type: 'adjust-count-limit',
      priority: RecommendationPriority.MEDIUM,
      title: 'Backup count limit nearly reached',
      message: 'Older backups will be deleted soon because the count limit is saturated.',
      suggestedValue: Math.ceil(settings.maxCountValue * 1.2),
      suggestedAction: 'Increase the count limit or enable size/age rules to balance storage.',
      expectedImpact: 'Provides breathing room so automatic cleanup is less aggressive.',
      confidence: 0.65
    });
  }

  const oldestAgeDays = (Date.now() - oldestBackupAt) / TimeConstants.DAY;
  if (!settings.ageRetentionEnabled && oldestAgeDays > 120) {
    recommendations.push({
      type: 'enable-age-retention',
      priority: RecommendationPriority.MEDIUM,
      title: 'Enable age-based retention',
      message: 'Some backups are several months old. Age rules prevent outdated archives from piling up.',
      suggestedValue: recommendedAgeDays,
      suggestedUnit: 'days',
      suggestedAction: 'Enable age retention so backups older than the limit are removed.',
      expectedImpact: `Backups older than about ${recommendedAgeDays} days will be cleaned up automatically.`,
      confidence: 0.6
    });
  }

  if (settings.ageRetentionEnabled && agePressure >= 0.9) {
    recommendations.push({
      type: 'adjust-age-limit',
      priority: RecommendationPriority.LOW,
      title: 'Age limit approaching',
      message: 'Several backups are about to exceed the configured age and be deleted.',
      suggestedValue: Math.max(settings.maxAgeValue || 30, Math.ceil((settings.maxAgeValue || 30) * 1.25)),
      suggestedUnit: settings.maxAgeUnit || 'days',
      suggestedAction: 'Increase the age limit or rely on other retention policies.',
      expectedImpact: 'Retains historical backups a bit longer when needed.',
      confidence: 0.55
    });
  }

  if (recommendations.length === 0) {
    const lastBackupAgeDays = (Date.now() - newestBackupAt) / TimeConstants.DAY;
    const message = lastBackupAgeDays < 1
      ? 'Retention policies look healthy and backups are current.'
      : 'Retention policies look healthy, but ensure backups continue on schedule.';

    recommendations.push({
      type: 'status-ok',
      priority: RecommendationPriority.LOW,
      title: 'Retention policies look good',
      message,
      expectedImpact: 'No immediate action required.',
      suggestedAction: 'Review again after major storage or schedule changes.',
      confidence: 0.9
    });
  }

  return recommendations;
}

function buildSuggestedPolicies({ totalSize, averageSize, backupCount, settings, storageUtilization }) {
  const totalSizeGb = totalSize / SizeConstants.GB;
  const avgSizeGb = Math.max(averageSize / SizeConstants.GB, 0.25);
  const baselineCount = Math.max(backupCount, 12);

  const conservativeCount = Math.max(15, Math.round(baselineCount * 0.8));
  const balancedCount = Math.max(8, Math.round(baselineCount * 0.6));
  const aggressiveCount = Math.max(4, Math.round(baselineCount * 0.4));

  const sizeCapGb = Math.max(10, Math.ceil(totalSizeGb * 0.85), Math.ceil(avgSizeGb * 8));
  const aggressiveSizeCapGb = Math.max(5, Math.ceil(totalSizeGb * 0.6), Math.ceil(avgSizeGb * 4));

  const conservative = {
    name: 'Conservative',
    description: 'Keep a larger history while introducing soft limits.',
    settings: {
      countRetentionEnabled: true,
      maxCountValue: conservativeCount,
      sizeRetentionEnabled: settings.sizeRetentionEnabled || totalSizeGb > 50,
      maxSizeValue: Math.max(settings.maxSizeValue || sizeCapGb, sizeCapGb),
      maxSizeUnit: settings.maxSizeUnit || 'GB',
      ageRetentionEnabled: settings.ageRetentionEnabled,
      maxAgeValue: settings.maxAgeValue || 120,
      maxAgeUnit: settings.maxAgeUnit || 'days'
    },
    expectedImpact: {
      storageReduction: clamp(storageUtilization * 0.3, 0, 1),
      backupsKept: clamp(conservativeCount / Math.max(backupCount || 1, conservativeCount), 0, 1),
      riskLevel: 'low'
    }
  };

  const balanced = {
    name: 'Balanced',
    description: 'Blend storage savings with reasonable history.',
    settings: {
      countRetentionEnabled: true,
      maxCountValue: balancedCount,
      sizeRetentionEnabled: true,
      maxSizeValue: Math.max(8, Math.round(sizeCapGb * 0.8)),
      maxSizeUnit: 'GB',
      ageRetentionEnabled: true,
      maxAgeValue: 90,
      maxAgeUnit: 'days'
    },
    expectedImpact: {
      storageReduction: 0.45,
      backupsKept: clamp(balancedCount / Math.max(backupCount || 1, balancedCount), 0, 1),
      riskLevel: 'medium'
    }
  };

  const aggressive = {
    name: 'Aggressive',
    description: 'Prioritize minimizing storage usage.',
    settings: {
      countRetentionEnabled: true,
      maxCountValue: aggressiveCount,
      sizeRetentionEnabled: true,
      maxSizeValue: Math.max(4, aggressiveSizeCapGb),
      maxSizeUnit: 'GB',
      ageRetentionEnabled: true,
      maxAgeValue: 45,
      maxAgeUnit: 'days'
    },
    expectedImpact: {
      storageReduction: 0.65,
      backupsKept: clamp(aggressiveCount / Math.max(backupCount || 1, aggressiveCount), 0, 1),
      riskLevel: 'high'
    }
  };

  return [conservative, balanced, aggressive];
}

function getSuggestedAgeWindowForFrequency(pattern) {
  switch (pattern) {
    case 'very-frequent':
      return 14;
    case 'frequent':
      return 30;
    case 'daily':
      return 45;
    case 'weekly':
      return 60;
    case 'infrequent':
      return 90;
    default:
      return 120;
  }
}

function convertSizeToBytes(value, unit = 'GB') {
  const normalizedUnit = unit.toUpperCase();
  switch (normalizedUnit) {
    case 'TB':
      return value * SizeConstants.TB;
    case 'GB':
      return value * SizeConstants.GB;
    case 'MB':
      return value * SizeConstants.MB;
    default:
      return value * SizeConstants.GB;
  }
}

function convertAgeToMilliseconds(value, unit = 'days') {
  const normalizedUnit = unit.toLowerCase();
  switch (normalizedUnit) {
    case 'days':
      return value * TimeConstants.DAY;
    case 'weeks':
      return value * TimeConstants.WEEK;
    case 'months':
      return value * TimeConstants.MONTH;
    case 'hours':
      return value * TimeConstants.HOUR;
    default:
      return value * TimeConstants.DAY;
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function formatSize(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) {
    return '0 B';
  }

  if (bytes === 0) {
    return '0 B';
  }

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const sizeIndex = Math.min(i, sizes.length - 1);
  const formattedValue = parseFloat((bytes / Math.pow(k, sizeIndex)).toFixed(2));
  return `${formattedValue} ${sizes[sizeIndex]}`;
}
