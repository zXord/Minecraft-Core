import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateRetentionPreview,
  RecommendationSeverity,
  RecommendationGroups
} from '../src/utils/backup/retentionWarnings.js';
import { SizeConstants, TimeConstants } from '../src/utils/backup/retentionPolicy.js';

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    electron: {
      invoke: () => Promise.resolve({ success: true })
    }
  };
}

function createBackup(name, { daysAgo = 0, sizeGb = 1 }) {
  return {
    name,
    size: sizeGb * SizeConstants.GB,
    metadata: {
      timestamp: new Date(Date.now() - daysAgo * TimeConstants.DAY).toISOString()
    }
  };
}

test('generateRetentionPreview recommends enabling retention when safeguards are disabled', async () => {
  const backups = Array.from({ length: 18 }, (_, index) =>
    createBackup(`backup-${index + 1}.zip`, { daysAgo: index, sizeGb: 1.2 })
  );

  const settings = {
    sizeRetentionEnabled: false,
    ageRetentionEnabled: false,
    countRetentionEnabled: false
  };

  const preview = await generateRetentionPreview(backups, settings);

  assert.ok(preview.recommendations.length > 0, 'should surface at least one recommendation');
  const enableRetention = preview.recommendations.find(rec => rec.type === 'enable-retention');
  assert.ok(enableRetention, 'should include enable-retention recommendation');
  assert.equal(enableRetention.group, RecommendationGroups.COVERAGE);
  assert.ok(
    enableRetention.severity === RecommendationSeverity.CRITICAL ||
      enableRetention.severity === RecommendationSeverity.WARNING,
    'severity should indicate urgency'
  );
  assert.ok(typeof enableRetention.metrics?.totalBackups === 'number');
});

test('generateRetentionPreview surfaces preventative size warning before hard limit', async () => {
  const backups = Array.from({ length: 10 }, (_, index) =>
    createBackup(`backup-${index + 1}.zip`, { daysAgo: index * 2, sizeGb: 4.5 })
  );

  const settings = {
    sizeRetentionEnabled: true,
    maxSizeValue: 50,
    maxSizeUnit: 'GB',
    ageRetentionEnabled: false,
    countRetentionEnabled: false
  };

  const preview = await generateRetentionPreview(backups, settings);

  const sizeAdjustment = preview.recommendations.find(rec => rec.type === 'adjust-size-retention');
  assert.ok(sizeAdjustment, 'should include adjust-size-retention recommendation when nearing limit');
  assert.equal(sizeAdjustment.group, RecommendationGroups.STORAGE);
  assert.equal(sizeAdjustment.severity, RecommendationSeverity.WARNING);
  assert.ok(sizeAdjustment.metrics?.sizeRatio >= 0.8, 'size ratio context should reflect approaching limit');
});

test('generateRetentionPreview suggests enabling age-based retention for stale history', async () => {
  const backups = [
    createBackup('recent-backup.zip', { daysAgo: 2, sizeGb: 2 }),
    createBackup('old-backup.zip', { daysAgo: 120, sizeGb: 2 })
  ];

  const settings = {
    sizeRetentionEnabled: false,
    ageRetentionEnabled: false,
    countRetentionEnabled: true,
    maxCountValue: 30
  };

  const preview = await generateRetentionPreview(backups, settings);

  const ageRecommendation = preview.recommendations.find(rec => rec.type === 'enable-age-retention');
  assert.ok(ageRecommendation, 'should include enable-age-retention recommendation for old backups');
  assert.equal(ageRecommendation.severity, RecommendationSeverity.ADVISORY);
  assert.ok(ageRecommendation.suggestedValue >= 30, 'should propose a practical age window');
  assert.equal(ageRecommendation.group, RecommendationGroups.SAFETY);
});
