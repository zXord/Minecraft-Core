import test from 'node:test';
import assert from 'node:assert/strict';

import { optimizeRetentionPolicies, SizeConstants } from '../shared/backup/retentionOptimization.js';

test('optimizeRetentionPolicies returns stable defaults with no backups', async () => {
  const result = await optimizeRetentionPolicies([], {});

  assert.ok(Array.isArray(result.recommendations));
  assert.ok(Array.isArray(result.suggestedPolicies));
  assert.ok(result.effectiveness);
  assert.ok(result.patterns);
  assert.ok(result.metrics);

  assert.equal(result.patterns.totalBackups, 0);
  assert.equal(result.effectiveness.formattedCurrentSize, '0 B');
  assert.equal(result.effectiveness.overallScore, 0);
  assert.equal(result.metrics.storageUtilization, 0);
});

test('optimizeRetentionPolicies analyzes backups and produces recommendations', async () => {
  const now = Date.now();
  const backups = [
    {
      name: 'backup-001.zip',
      size: 4 * SizeConstants.GB,
      metadata: { timestamp: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString() }
    },
    {
      name: 'backup-002.zip',
      size: 5 * SizeConstants.GB,
      metadata: { timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString() }
    },
    {
      name: 'backup-003.zip',
      size: 6 * SizeConstants.GB,
      metadata: { timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString() }
    }
  ];

  const settings = {
    sizeRetentionEnabled: true,
    maxSizeValue: 12,
    maxSizeUnit: 'GB',
    countRetentionEnabled: true,
    maxCountValue: 10,
    ageRetentionEnabled: false
  };

  const result = await optimizeRetentionPolicies(backups, settings);

  assert.equal(result.patterns.totalBackups, backups.length);
  assert.equal(result.effectiveness.currentSize, backups.reduce((sum, b) => sum + b.size, 0));
  assert.ok(result.effectiveness.overallScore >= 0 && result.effectiveness.overallScore <= 1);
  assert.ok(result.effectiveness.storageEfficiency >= 0 && result.effectiveness.storageEfficiency <= 1);
  assert.ok(result.metrics.storageUtilization >= 0 && result.metrics.storageUtilization <= 1.5);

  assert.ok(result.recommendations.length > 0, 'should surface at least one recommendation');
  assert.ok(result.suggestedPolicies.length >= 1, 'should provide suggested policy presets');

  for (const policy of result.suggestedPolicies) {
    assert.ok(policy.settings, 'policy should include settings');
    assert.ok(policy.expectedImpact, 'policy should include expected impact');
    assert.ok(typeof policy.expectedImpact.storageReduction === 'number');
  }
});
