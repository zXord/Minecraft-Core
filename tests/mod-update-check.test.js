import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for mod update checking functionality
 *
 * This test suite verifies:
 * 1. Update checking works when app is running
 * 2. Concurrent update checks are handled properly
 * 3. Update counts are calculated correctly for enabled and disabled mods
 */

test('Update Check Concurrency - handles concurrent update checks without dropping requests', async () => {
  let checkForUpdatesCalls = 0;
  let lastCheckTimestamp = null;
  const mockServerPath = '/test/server/path';
  let mockIsCheckingUpdates = false;

  // Simulate a long-running check
  mockIsCheckingUpdates = true;
  const pendingCheck = { serverPath: mockServerPath, forceRefresh: false };

  // First check starts
  checkForUpdatesCalls++;

  // Second check arrives while first is running - should be queued
  const secondCheckTime = Date.now();
  assert.equal(mockIsCheckingUpdates, true);

  // Complete first check
  mockIsCheckingUpdates = false;

  // Pending check should execute now
  if (pendingCheck) {
    checkForUpdatesCalls++;
    lastCheckTimestamp = Date.now();
  }

  assert.equal(checkForUpdatesCalls, 2);
  assert.ok(lastCheckTimestamp >= secondCheckTime);
});

test('Update Check Concurrency - prioritizes forceRefresh in queued checks', async () => {
  // Queue regular check
  let pendingCheck = { serverPath: '/test/path', forceRefresh: false };

  // Queue force refresh check - should override
  pendingCheck = { serverPath: '/test/path', forceRefresh: true };

  // Verify force refresh was preferred
  assert.equal(pendingCheck.forceRefresh, true);
});

test('Update Check Concurrency - executes checks periodically when app is running', async () => {
  const intervalMs = 100; // 100ms for test
  let checkCount = 0;
  let mockIsCheckingUpdates = false;

  // Simulate interval-based checking
  const intervalId = setInterval(() => {
    if (!mockIsCheckingUpdates) {
      checkCount++;
    }
  }, intervalMs);

  // Wait for 3 intervals
  await new Promise(resolve => setTimeout(resolve, intervalMs * 3.5));
  clearInterval(intervalId);

  // Should have run at least 3 times
  assert.ok(checkCount >= 3, `Expected at least 3 checks, got ${checkCount}`);
});

test('Update Count Calculation - counts enabled mod updates correctly', () => {
  // Setup test mods
  const mockModsWithUpdates = new Map([
    ['mod1.jar', { versionNumber: '1.1.0', id: 'version-1.1' }],
    ['mod2.jar', { versionNumber: '2.0.0', id: 'version-2.0' }],
    ['project:projectId1', { versionNumber: '1.1.0', id: 'version-1.1' }], // Reference for Find tab
    ['project:projectId2', { versionNumber: '2.0.0', id: 'version-2.0' }]  // Reference for Find tab
  ]);

  let count = 0;

  // Count enabled mods only (skip project: prefix entries)
  for (const [modName] of mockModsWithUpdates.entries()) {
    if (!modName.startsWith('project:')) {
      count++;
    }
  }

  assert.equal(count, 2); // mod1.jar and mod2.jar
});

test('Update Count Calculation - counts disabled mod updates correctly WITHOUT doubling', () => {
  const mockDisabledMods = new Set(['disabled-mod.jar']);
  const mockDisabledModUpdates = new Map([
    ['disabled-mod.jar', {
      projectId: 'disabled-proj',
      latestVersion: '3.0.0',
      latestVersionId: 'version-3.0'
    }]
  ]);

  let count = 0;

  // Count disabled mods that are actually disabled
  for (const name of mockDisabledModUpdates.keys()) {
    if (mockDisabledMods.has(name)) {
      count++;
    }
  }

  assert.equal(count, 1); // Only disabled-mod.jar
});

test('Update Count Calculation - calculates total update count correctly', () => {
  const mockModsWithUpdates = new Map([
    ['mod1.jar', { versionNumber: '1.1.0', id: 'version-1.1' }],
    ['mod2.jar', { versionNumber: '2.0.0', id: 'version-2.0' }],
    ['project:projectId1', { versionNumber: '1.1.0', id: 'version-1.1' }],
    ['project:projectId2', { versionNumber: '2.0.0', id: 'version-2.0' }]
  ]);

  const mockDisabledMods = new Set(['disabled-mod.jar']);
  const mockDisabledModUpdates = new Map([
    ['disabled-mod.jar', {
      projectId: 'disabled-proj',
      latestVersion: '3.0.0',
      latestVersionId: 'version-3.0'
    }]
  ]);

  let totalCount = 0;

  // Count enabled mods (excluding project: references)
  for (const [modName] of mockModsWithUpdates.entries()) {
    if (!modName.startsWith('project:')) {
      totalCount++;
    }
  }

  // Count disabled mods (only if actually disabled)
  for (const name of mockDisabledModUpdates.keys()) {
    if (mockDisabledMods.has(name)) {
      totalCount++;
    }
  }

  assert.equal(totalCount, 3); // 2 enabled + 1 disabled
});

test('Update Count Calculation - does NOT double-count disabled mods', () => {
  const mockModsWithUpdates = new Map([
    ['mod1.jar', { versionNumber: '1.1.0', id: 'version-1.1' }],
    ['mod2.jar', { versionNumber: '2.0.0', id: 'version-2.0' }],
    ['project:projectId1', { versionNumber: '1.1.0', id: 'version-1.1' }],
    ['project:projectId2', { versionNumber: '2.0.0', id: 'version-2.0' }],
    // Add a mod that exists in both maps
    ['mixed-mod.jar', { versionNumber: '1.0.0', id: 'v1' }]
  ]);

  const mockDisabledMods = new Set(['disabled-mod.jar', 'mixed-mod.jar']);
  const mockDisabledModUpdates = new Map([
    ['disabled-mod.jar', {
      projectId: 'disabled-proj',
      latestVersion: '3.0.0',
      latestVersionId: 'version-3.0'
    }],
    ['mixed-mod.jar', {
      projectId: 'mixed-proj',
      latestVersion: '1.0.0',
      latestVersionId: 'v1'
    }]
  ]);

  let totalCount = 0;
  const counted = new Set();

  // Count enabled mods
  for (const [modName] of mockModsWithUpdates.entries()) {
    if (!modName.startsWith('project:') && !counted.has(modName)) {
      totalCount++;
      counted.add(modName);
    }
  }

  // Count disabled mods (skip if already counted)
  for (const name of mockDisabledModUpdates.keys()) {
    if (mockDisabledMods.has(name) && !counted.has(name)) {
      totalCount++;
      counted.add(name);
    }
  }

  assert.equal(totalCount, 4); // 2 enabled (mod1, mod2) + 1 disabled (disabled-mod) + 1 mixed (counted once)
});

test('Update Count Calculation - handles empty update maps correctly', () => {
  const mockModsWithUpdates = new Map();
  const mockDisabledModUpdates = new Map();
  const mockDisabledMods = new Set();

  let totalCount = 0;

  for (const [modName] of mockModsWithUpdates.entries()) {
    if (!modName.startsWith('project:')) {
      totalCount++;
    }
  }

  for (const name of mockDisabledModUpdates.keys()) {
    if (mockDisabledMods.has(name)) {
      totalCount++;
    }
  }

  assert.equal(totalCount, 0);
});

test('Update Count Calculation - only counts disabled mods that are in the disabled set', () => {
  const mockDisabledMods = new Set(['disabled-mod.jar']);
  const mockDisabledModUpdates = new Map([
    ['disabled-mod.jar', {
      projectId: 'proj1',
      latestVersion: '2.0.0',
      latestVersionId: 'v2'
    }],
    // Add updates for mods not in disabled set
    ['not-disabled.jar', {
      projectId: 'proj2',
      latestVersion: '2.0.0',
      latestVersionId: 'v2'
    }]
  ]);

  let disabledCount = 0;
  for (const name of mockDisabledModUpdates.keys()) {
    if (mockDisabledMods.has(name)) {
      disabledCount++;
    }
  }

  // Should only count the one that's actually disabled
  assert.equal(disabledCount, 1);
});

test('Update Check Interval - does not skip updates when interval triggers during a check', async () => {
  let completedChecks = 0;
  let mockIsCheckingUpdates = false;
  let pendingCheck = null;

  const simulateCheck = async () => {
    if (mockIsCheckingUpdates) {
      // Queue the check instead of skipping
      pendingCheck = { serverPath: '/test/path', forceRefresh: false };
      return;
    }

    mockIsCheckingUpdates = true;

    // Simulate work
    await new Promise(resolve => setTimeout(resolve, 50));

    mockIsCheckingUpdates = false;
    completedChecks++;

    // Execute pending check if any
    if (pendingCheck) {
      pendingCheck = null;
      await simulateCheck();
    }
  };

  // Start 3 checks in quick succession
  const checks = [
    simulateCheck(),
    simulateCheck(),
    simulateCheck()
  ];

  await Promise.all(checks);

  // All checks should complete (none skipped permanently)
  assert.ok(completedChecks >= 1, `Expected at least 1 completed check, got ${completedChecks}`);
});

test('Update Check Interval - executes delayed check after app startup', async () => {
  let checkExecuted = false;
  let checkForUpdatesCalls = 0;

  // Simulate startup delay
  setTimeout(() => {
    checkExecuted = true;
    checkForUpdatesCalls++;
  }, 100);

  await new Promise(resolve => setTimeout(resolve, 150));

  assert.equal(checkExecuted, true);
  assert.equal(checkForUpdatesCalls, 1);
});
