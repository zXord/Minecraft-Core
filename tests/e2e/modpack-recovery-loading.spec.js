import { expect, test } from '@playwright/test';
import harness from './fixtures/modpack-harness.cjs';

const serverId = 'server-e2e';
const record = {
  recoveryId: `recovery-${'b'.repeat(32)}`, serverId,
  instanceId: serverId, visibilityScope: 'registered-server', operationKind: 'repair',
  title: 'Recover repair operation', phase: 'committing', automaticPossible: true,
  summary: 'The interrupted server change can be verified again or restored to the prior server.',
  actions: [
    { actionId: 'retry-recovery', label: 'Retry verified recovery', recommended: true },
    { actionId: 'rollback-server', label: 'Restore prior server', recommended: false }
  ]
};
const unmanaged = { schemaVersion: 1, modpackManaged: false, lifecycleMode: 'unmanaged', source: null, runtime: null, installedAt: null, contentRevision: 0, managedFileCount: 0 };
const panel = page => page.getByRole('region', { name: 'Modpack recovery', exact: true });
const pageRoot = page => page.locator('.modpack-page');
const count = (fixture, method, id = serverId) => fixture.readState().lifecycleCalls.filter(call => call.method === method && call.instanceId === id).length;

async function launch(options = {}) {
  const fixture = await harness.launchModpackApp({
    profile: 'managed', recoveryRecords: [record],
    recoveryListFixture: { allowRegisteredResolution: true },
    env: { MINECRAFT_CORE_USE_DEV_SERVER: '1', MINECRAFT_CORE_DEV_SERVER_URL: 'http://127.0.0.1:5173' },
    ...options
  });
  fixture.errors = [];
  fixture.consoleIssues = [];
  fixture.page.on('pageerror', error => fixture.errors.push(error.message));
  fixture.page.on('console', message => {
    if (['error', 'warning'].includes(message.type())) fixture.consoleIssues.push({ type: message.type(), text: message.text() });
  });
  await fixture.page.locator('.server-tabs').waitFor({ timeout: 25000 });
  await expect.poll(() => fixture.readState().recoveryListCompletedCalls.length).toBeGreaterThan(0);
  return fixture;
}

async function noLifecycleWrites(fixture) {
  expect(fixture.readState().recoveryCalls).toEqual([]);
  expect(fixture.readState().lifecycleCalls.filter(call =>
    ['verify', 'createPlan', 'createManagementPlan', 'inspectSource', 'reserveServerDestination', 'startOperation'].includes(call.method))).toEqual([]);
  expect(fixture.errors).toEqual([]);
}

for (const failure of ['state', 'history', 'both']) {
  test(`independent ${failure} failure does not discard actionable recovery or other successful reads`, async ({}, testInfo) => {
    const fixture = await launch({ refreshFixture: {
      stateFailureIds: failure === 'history' ? [] : [serverId],
      historyFailureIds: failure === 'state' ? [] : [serverId]
    } });
    try {
      const { page } = fixture;
      await fixture.openModpack();
      await expect(panel(page).getByRole('button', { name: 'Retry verified recovery' })).toBeVisible();
      await expect(panel(page).getByRole('button', { name: 'Restore prior server' })).toBeVisible();
      if (failure !== 'history') {
        await expect(page.getByRole('region', { name: 'Modpack overview' })).toContainText('Modpack state unavailable');
        await expect(page.getByRole('button', { name: 'Install modpack', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Import files only', exact: true })).toHaveCount(0);
        if (failure === 'state') {
          await expect(page).toHaveTitle('Minecraft Core');
          expect(page.url()).toBe('http://127.0.0.1:5173/#/modpack');
          await expect(page.locator('vite-error-overlay')).toHaveCount(0);
          await page.screenshot({ path: testInfo.outputPath('state-failed-recovery-ready.png'), fullPage: true });
          await testInfo.attach('renderer-console', { body: JSON.stringify(fixture.consoleIssues, null, 2), contentType: 'application/json' });
        }
        for (const section of ['Versions', 'Actions']) {
          await page.getByRole('button', { name: section, exact: true }).click();
          await expect(pageRoot(page).getByText('Modpack state unavailable', { exact: true })).toBeVisible();
          await expect(pageRoot(page).getByRole('button', { name: /Verify managed|Switch modpack|Uninstall|Detach|Load exact version/u })).toHaveCount(0);
        }
      } else await expect(page.getByRole('heading', { name: 'Fixture Factory Pack', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Modpack history' })).toContainText(failure === 'state' ? 'install existing' : 'History unavailable');
      await page.getByRole('button', { name: 'Recovery', exact: true }).click();
      await expect(panel(page).getByRole('button', { name: 'Retry verified recovery' })).toBeVisible();
      await expect(page.getByText('No recovery action is pending', { exact: true })).toHaveCount(0);
      await noLifecycleWrites(fixture);
    } finally { await fixture.close(); }
  });
}

test('recovery publishes while unrelated state and history reads are still stalled', async () => {
  const fixture = await launch();
  try {
    const stateCall = count(fixture, 'getState') + 1;
    const historyCall = count(fixture, 'listHistory') + 1;
    fixture.updateScenario({ refreshFixture: {
      stateResponsesByInstanceId: { [serverId]: { [stateCall]: { delayMs: 6000, fail: true } } },
      historyResponsesByInstanceId: { [serverId]: { [historyCall]: { delayMs: 6000 } } }
    } });
    await fixture.openModpack();
    await expect(panel(fixture.page).getByRole('button', { name: 'Retry verified recovery' })).toBeVisible({ timeout: 3000 });
    await expect(fixture.page.getByRole('region', { name: 'Modpack overview' })).toContainText('Loading managed modpack state');
    await noLifecycleWrites(fixture);
  } finally { await fixture.close(); }
});

test('delayed recovery shows checking, never empty, and publishes without another click', async () => {
  const fixture = await launch({ refreshFixture: { stateFailureIds: [serverId] } });
  try {
    const next = fixture.readState().recoveryListCalls + 1;
    fixture.updateScenario({ recoveryListFixture: { delayMsByCall: { [next]: 1800 } } });
    await fixture.openModpack();
    await fixture.page.getByRole('button', { name: 'Recovery', exact: true }).click();
    await expect(panel(fixture.page)).toContainText('Checking recovery status');
    await expect(fixture.page.getByText('No recovery action is pending', { exact: true })).toHaveCount(0);
    await expect(panel(fixture.page).getByRole('button', { name: 'Retry verified recovery' })).toBeVisible();
    await noLifecycleWrites(fixture);
  } finally { await fixture.close(); }
});

for (const failedState of [false, true]) {
  test(`failed recovery retry shares parent status and records with failedState=${failedState}`, async () => {
    const fixture = await launch({ refreshFixture: { stateFailureIds: failedState ? [serverId] : [] } });
    try {
      fixture.updateScenario({ recoveryListFixture: { failureCalls: [fixture.readState().recoveryListCalls + 1] } });
      await fixture.openModpack();
      await expect(panel(fixture.page)).toContainText('Recovery status unavailable');
      if (!failedState) {
        await expect(fixture.page.getByRole('heading', { name: 'Fixture Factory Pack', exact: true })).toBeVisible();
        await fixture.page.getByRole('button', { name: 'Actions', exact: true }).click();
        await expect(pageRoot(fixture.page)).toContainText('Lifecycle actions unavailable');
        await fixture.page.getByRole('button', { name: 'History', exact: true }).click();
        await expect(fixture.page.getByRole('region', { name: 'Modpack history' })).toContainText('install existing');
      }
      await expect(fixture.page.getByText('No recovery action is pending', { exact: true })).toHaveCount(0);
      await panel(fixture.page).getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(panel(fixture.page).getByRole('button', { name: 'Retry verified recovery' })).toBeVisible();
      await fixture.page.getByRole('button', { name: 'Recovery', exact: true }).click();
      await expect(panel(fixture.page).getByRole('button', { name: 'Restore prior server' })).toBeVisible();
      await expect(panel(fixture.page)).not.toContainText('Recovery status unavailable');
      await noLifecycleWrites(fixture);
    } finally { await fixture.close(); }
  });
}

for (const failedState of [false, true]) {
  test(`successful empty is authoritative only for recovery, failedState=${failedState}`, async () => {
    const fixture = await launch({ profile: 'unmanaged', recoveryRecords: [], refreshFixture: { stateFailureIds: failedState ? [serverId] : [] } });
    try {
      await fixture.openModpack();
      if (failedState) {
        await expect(fixture.page.getByRole('region', { name: 'Modpack overview' })).toContainText('Modpack state unavailable');
        await expect(fixture.page.getByRole('button', { name: 'Install modpack', exact: true })).toHaveCount(0);
        await expect(fixture.page.getByRole('region', { name: 'Modpack overview' })).toContainText('Modpack state unavailable');
      } else {
        await expect(fixture.page.getByRole('button', { name: 'Install modpack', exact: true })).toBeVisible();
        await expect(fixture.page.getByRole('button', { name: 'Import files only', exact: true })).toBeVisible();
      }
      await fixture.page.getByRole('button', { name: 'Recovery', exact: true }).click();
      await expect(panel(fixture.page)).toContainText('No recovery action is pending');
      await noLifecycleWrites(fixture);
    } finally { await fixture.close(); }
  });
}

test('stale records survive failed refresh and only successful empty clears pending presentation', async () => {
  const fixture = await launch();
  try {
    await fixture.openModpack();
    await expect(panel(fixture.page).getByText(record.title, { exact: true })).toBeVisible();
    fixture.updateScenario({ recovery: [], recoveryListFixture: { failureCalls: [fixture.readState().recoveryListCalls + 1] } });
    await panel(fixture.page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(panel(fixture.page)).toContainText('Recovery status unavailable');
    await expect(panel(fixture.page)).toContainText('Previously loaded recovery records');
    await expect(fixture.page.getByText('No recovery action is pending', { exact: true })).toHaveCount(0);
    await expect(panel(fixture.page).getByRole('button', { name: 'Retry verified recovery' })).toBeDisabled();
    await panel(fixture.page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(panel(fixture.page)).toHaveCount(0);
    await fixture.page.getByRole('button', { name: 'Recovery', exact: true }).click();
    await expect(panel(fixture.page)).toContainText('No recovery action is pending');
    await noLifecycleWrites(fixture);
  } finally { await fixture.close(); }
});

test('dismissing a notification navigation error cannot authorize previously loaded but failed state', async () => {
  const fixture = await launch();
  try {
    await fixture.openModpack();
    await expect(fixture.page.getByRole('heading', { name: 'Fixture Factory Pack', exact: true })).toBeVisible();
    fixture.updateScenario({ refreshFixture: { stateFailureIds: [serverId] } });
    await panel(fixture.page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(fixture.page.getByRole('region', { name: 'Modpack overview' })).toContainText('Modpack state unavailable');
    await pageRoot(fixture.page).getByRole('button', { name: /Modpack notifications/u }).click();
    await pageRoot(fixture.page).getByRole('region', { name: 'Persistent modpack notifications' }).getByRole('button', { name: /Exact modpack update available/u }).click();
    await expect(fixture.page.locator('section.page-error')).toBeVisible();
    await fixture.page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(fixture.page.locator('section.page-error')).toHaveCount(0);
    await expect(fixture.page.getByRole('region', { name: 'Modpack overview' })).toContainText('Modpack state unavailable');
    await expect(fixture.page.getByRole('button', { name: 'Install modpack', exact: true })).toHaveCount(0);
    await fixture.page.getByRole('button', { name: 'Versions', exact: true }).click();
    await expect(pageRoot(fixture.page)).toContainText('Modpack state unavailable');
    await expect(fixture.page.getByRole('button', { name: 'Load exact version history', exact: true })).toHaveCount(0);
    await noLifecycleWrites(fixture);
  } finally { await fixture.close(); }
});

test('successful older history pagination remains usable independently of failed state', async () => {
  const fixture = await launch();
  try {
    const first = fixture.readState().history[0];
    const older = { ...first, operationId: 'older-fixture-operation', sequence: 2, kind: 'verify', sourceRevision: 1, targetRevision: 1 };
    fixture.updateScenario({ refreshFixture: {
      stateFailureIds: [serverId],
      historyResponsesByInstanceId: { [serverId]: {
        1: { value: { items: [first], nextCursor: 'older-fixture-cursor' } },
        2: { value: { items: [older], nextCursor: null } }
      } }
    } });
    await fixture.openModpack();
    await fixture.page.getByRole('button', { name: 'History', exact: true }).click();
    const history = fixture.page.getByRole('region', { name: 'Modpack history' });
    await history.getByRole('button', { name: 'Load older history', exact: true }).click();
    await expect(history).toContainText('install existing');
    await expect(history.getByText('verify', { exact: true })).toBeVisible();
    await expect(history.getByRole('button', { name: 'Load older history', exact: true })).toHaveCount(0);
    expect(fixture.readState().lifecycleCalls).toContainEqual(expect.objectContaining({ method: 'listHistory', instanceId: serverId, cursor: 'older-fixture-cursor' }));
    await noLifecycleWrites(fixture);
  } finally { await fixture.close(); }
});

test('successful recovery disables Refresh and reloads all three resources without clearing renewed read failures', async () => {
  const fixture = await launch({ refreshFixture: { stateFailureIds: [serverId], historyFailureIds: [serverId] } });
  try {
    await fixture.openModpack();
    const { page } = fixture;
    await expect(panel(page).getByRole('button', { name: 'Retry verified recovery' })).toBeVisible();
    const before = { state: count(fixture, 'getState'), history: count(fixture, 'listHistory'), recovery: fixture.readState().recoveryListCalls };
    fixture.updateScenario({ recoveryListFixture: { allowRegisteredResolution: true, actionDelayMs: 1000, delayMsByCall: { [before.recovery + 1]: 1500 } } });
    await panel(page).getByRole('button', { name: 'Retry verified recovery' }).click();
    await expect(panel(page).getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    await expect(panel(page).getByRole('button', { name: 'Restore prior server' })).toBeDisabled();
    await expect.poll(() => count(fixture, 'getState')).toBeGreaterThan(before.state);
    await expect.poll(() => count(fixture, 'listHistory')).toBeGreaterThan(before.history);
    await expect.poll(() => fixture.readState().recoveryListCalls).toBeGreaterThan(before.recovery);
    await expect(page.getByRole('region', { name: 'Modpack overview' })).toContainText('Modpack state unavailable');
    await expect(panel(page)).toContainText('Checking recovery status');
    await expect(page.getByText('No recovery action is pending', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Recovery', exact: true }).click();
    await expect(panel(page)).toContainText('No recovery action is pending');
    fixture.updateScenario({ refreshFixture: {} });
    await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Fixture Factory Pack', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Modpack history' })).toContainText('install existing');
    expect(fixture.readState().recoveryCalls).toEqual([{ recoveryId: record.recoveryId, actionId: 'retry-recovery' }]);
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

async function stateChanged(fixture, id = serverId) {
  await fixture.electronApp.evaluate(({ BrowserWindow }, instanceId) => {
    BrowserWindow.getAllWindows()[0].webContents.send('modpacks:state-changed', { instanceId });
  }, id);
}

for (const lateFailure of [false, true]) {
  test(`server switch rejects late resource settlement, lateFailure=${lateFailure}`, async () => {
    const fixture = await launch({ secondaryServerState: unmanaged });
    try {
      fixture.updateScenario({ refreshFixture: {
        stateResponsesByInstanceId: { [serverId]: { [count(fixture, 'getState') + 1]: { delayMs: 1800, fail: lateFailure } } },
        historyResponsesByInstanceId: { [serverId]: { 1: { delayMs: 1800, fail: lateFailure } } }
      }, recoveryListFixture: { delayMsByCall: { [fixture.readState().recoveryListCalls + 1]: 1800 }, failureCalls: lateFailure ? [fixture.readState().recoveryListCalls + 1] : [] } });
      await fixture.openModpack();
      await expect.poll(() => count(fixture, 'listHistory')).toBe(1);
      await fixture.page.getByRole('button', { name: '☰' }).click();
      await fixture.page.locator('.instance-item').filter({ hasText: 'E2E Secondary Server' }).click();
      await fixture.page.getByRole('button', { name: '☰' }).click();
      await expect(fixture.page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();
      await fixture.page.waitForTimeout(2100);
      await expect(fixture.page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();
      await expect(fixture.page.getByText(record.title, { exact: true })).toHaveCount(0);
      await expect(fixture.page.getByText('Managed modpack state is invalid', { exact: true })).toHaveCount(0);
      await noLifecycleWrites(fixture);
    } finally { await fixture.close(); }
  });
}

test('older overlapping same-server refresh cannot replace newer ready data or errors', async () => {
  const fixture = await launch();
  try {
    await fixture.openModpack();
    await expect(panel(fixture.page).getByText(record.title, { exact: true })).toBeVisible();
    const oldRecoveryCall = fixture.readState().recoveryListCalls + 1;
    fixture.updateScenario({ refreshFixture: {
      stateResponsesByInstanceId: { [serverId]: { [count(fixture, 'getState') + 1]: { delayMs: 1800, fail: true } } },
      historyResponsesByInstanceId: { [serverId]: { [count(fixture, 'listHistory') + 1]: { delayMs: 1800, fail: true } } }
    }, recoveryListFixture: { delayMsByCall: { [oldRecoveryCall]: 1800 }, failureCalls: [oldRecoveryCall] } });
    await stateChanged(fixture);
    await expect.poll(() => fixture.readState().recoveryListCalls).toBe(oldRecoveryCall);
    fixture.updateScenario({ recovery: [] });
    await stateChanged(fixture);
    await expect(panel(fixture.page)).toHaveCount(0);
    await expect.poll(() => fixture.readState().recoveryListCompletedCalls.includes(oldRecoveryCall)).toBe(true);
    await expect(fixture.page.getByRole('heading', { name: 'Fixture Factory Pack', exact: true })).toBeVisible();
    await expect(fixture.page.getByText('Managed modpack state is invalid', { exact: true })).toHaveCount(0);
    await fixture.page.getByRole('button', { name: 'Recovery', exact: true }).click();
    await expect(panel(fixture.page)).toContainText('No recovery action is pending');
    await noLifecycleWrites(fixture);
  } finally { await fixture.close(); }
});

test('late recovery action completion cannot reload or change the newly selected server', async () => {
  const fixture = await launch({ secondaryServerState: unmanaged });
  try {
    await fixture.openModpack();
    await expect(panel(fixture.page).getByRole('button', { name: 'Retry verified recovery' })).toBeVisible();
    fixture.updateScenario({ recoveryListFixture: { allowRegisteredResolution: true, actionDelayMs: 1800 } });
    await panel(fixture.page).getByRole('button', { name: 'Retry verified recovery' }).click();
    await fixture.page.getByRole('button', { name: '☰' }).click();
    await fixture.page.locator('.instance-item').filter({ hasText: 'E2E Secondary Server' }).click();
    await fixture.page.getByRole('button', { name: '☰' }).click();
    await expect(fixture.page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();
    const reads = count(fixture, 'listHistory', 'server-e2e-secondary');
    await expect.poll(() => fixture.readState().recoveryRuns).toBe(1);
    await fixture.page.waitForTimeout(300);
    expect(count(fixture, 'listHistory', 'server-e2e-secondary')).toBe(reads);
    await expect(fixture.page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally { await fixture.close(); }
});

const remainingRecord = {
  ...record, recoveryId: `recovery-${'c'.repeat(32)}`, title: 'Remaining verified recovery',
  actions: [{ actionId: 'retry-recovery', label: 'Retry remaining recovery', recommended: true }]
};

for (const reconciliation of ['nonempty', 'failure']) {
  test(`R1 post-action ${reconciliation} recovery releases controls while canonical reads remain pending`, async () => {
    const fixture = await launch();
    try {
      await fixture.openModpack();
      const { page } = fixture;
      await expect(panel(page).getByRole('button', { name: 'Retry verified recovery', exact: true })).toBeVisible();
      const before = { state: count(fixture, 'getState'), history: count(fixture, 'listHistory'), recovery: fixture.readState().recoveryListCalls };
      const reconciliationCall = before.recovery + 1;
      fixture.updateScenario({
        refreshFixture: {
          stateResponsesByInstanceId: { [serverId]: { [before.state + 1]: { delayMs: 15000, fail: true } } },
          historyResponsesByInstanceId: { [serverId]: { [before.history + 1]: { delayMs: 15000, fail: true } } }
        },
        recoveryListFixture: {
          allowRegisteredResolution: true, actionDelayMs: 500,
          recordsAfterResolution: [remainingRecord],
          delayMsByCall: { [reconciliationCall]: 500 },
          failureCalls: reconciliation === 'failure' ? [reconciliationCall] : []
        }
      });
      await panel(page).getByRole('button', { name: 'Retry verified recovery', exact: true }).click();
      await expect(panel(page).getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
      await expect(panel(page).getByRole('button', { name: 'Restore prior server', exact: true })).toBeDisabled();
      await expect.poll(() => fixture.readState().recoveryListCompletedCalls.includes(reconciliationCall)).toBe(true);
      expect(count(fixture, 'getState')).toBe(before.state + 1);
      expect(count(fixture, 'listHistory')).toBe(before.history + 1);
      await expect(page.getByRole('region', { name: 'Modpack overview' })).toContainText('Loading managed modpack state');
      if (reconciliation === 'failure') {
        await expect(panel(page)).toContainText('Recovery status unavailable');
        await expect(panel(page).getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled({ timeout: 2500 });
        await expect(panel(page).getByRole('button', { name: 'Retry verified recovery', exact: true })).toBeDisabled();
      } else {
        await expect(panel(page).getByRole('button', { name: 'Retry remaining recovery', exact: true })).toBeEnabled({ timeout: 2500 });
      }
      await expect(panel(page).getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled({ timeout: 2500 });
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Modpack history' })).toContainText('Loading modpack history');
      await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect.poll(() => fixture.readState().recoveryListCalls).toBe(reconciliationCall + 1);
      await expect(panel(page).getByRole('button', { name: 'Retry remaining recovery', exact: true })).toBeEnabled();
      expect(fixture.readState().recoveryCalls).toEqual([{ recoveryId: record.recoveryId, actionId: 'retry-recovery' }]);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.close(); }
  });
}

for (const refreshedRecords of ['empty', 'nonempty']) {
  test(`R2 failed action cannot veto a successful ${refreshedRecords} recovery Refresh`, async ({}, testInfo) => {
    const fixture = await launch({
      recoveryFailureIds: [record.recoveryId],
      refreshFixture: { stateFailureIds: [serverId], historyFailureIds: [serverId] }
    });
    try {
      await fixture.openModpack();
      const { page } = fixture;
      await expect(panel(page).getByRole('button', { name: 'Retry verified recovery', exact: true })).toBeVisible();
      const before = { state: count(fixture, 'getState'), history: count(fixture, 'listHistory'), recovery: fixture.readState().recoveryListCalls };
      await panel(page).getByRole('button', { name: 'Retry verified recovery', exact: true }).click();
      await expect(panel(page)).toContainText('Setup recovery could not be completed');
      expect(fixture.readState().recoveryListCalls).toBe(before.recovery);
      expect(count(fixture, 'getState')).toBe(before.state);
      expect(count(fixture, 'listHistory')).toBe(before.history);
      fixture.updateScenario({ recovery: refreshedRecords === 'empty' ? [] : [remainingRecord] });
      await panel(page).getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect.poll(() => fixture.readState().recoveryListCompletedCalls.includes(before.recovery + 1)).toBe(true);
      await expect(page.getByRole('region', { name: 'Modpack overview' })).toContainText('Modpack state unavailable');
      await page.getByRole('button', { name: 'Recovery', exact: true }).click();
      if (refreshedRecords === 'empty') await expect(panel(page)).toContainText('No recovery action is pending', { timeout: 2500 });
      else {
        await expect(panel(page).getByRole('button', { name: 'Retry remaining recovery', exact: true })).toBeEnabled();
        await expect(panel(page)).not.toContainText('No recovery action is pending');
      }
      await expect(panel(page)).not.toContainText('Recovery status unavailable', { timeout: 2500 });
      await expect(panel(page)).not.toContainText('Setup recovery could not be completed');
      await page.screenshot({ path: testInfo.outputPath(`reconciled-${refreshedRecords}.png`), fullPage: true });
      await page.getByRole('button', { name: 'History', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Modpack history' })).toContainText('History unavailable');
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Modpack overview' })).toContainText('Modpack state unavailable');
      await expect(page.getByRole('button', { name: 'Install modpack', exact: true })).toHaveCount(0);
      expect(fixture.readState().recoveryCalls).toEqual([{ recoveryId: record.recoveryId, actionId: 'retry-recovery' }]);
      expect(fixture.errors).toEqual([]);
    } finally { await fixture.close(); }
  });
}
