import { expect, test } from '@playwright/test';
import harness from './fixtures/modpack-harness.cjs';
import os from 'node:os';
import path from 'node:path';

async function chooseModrinthFromOverview(page, version) {
  await page.getByRole('button', { name: 'Install modpack' }).click();
  await page.getByRole('button', { name: /Browse Modrinth/u }).click();
  await page.getByRole('button', { name: /Fixture Factory Pack/u }).click();
  await page.getByRole('button', { name: new RegExp(`^${version.replaceAll('.', '\\.')}`, 'u') }).click();
  await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
}

async function chooseManagedVersion(page, version) {
  await page.getByRole('button', { name: 'Versions' }).click();
  await page.getByRole('button', { name: 'Load exact version history' }).click();
  await page.getByRole('button', { name: new RegExp(`^${version.replaceAll('.', '\\.')}`, 'u') }).click();
  await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
}

async function startReviewedArchive(page, { downgrade = false } = {}) {
  if (downgrade) await page.getByLabel(/I understand a downgrade can make the current world incompatible/u).check();
  await page.getByRole('button', { name: 'Review planned changes' }).click();
  const conflictReview = page.getByRole('region', { name: 'Conflict choices' });
  if (await conflictReview.isVisible().catch(() => false)) {
    await expect(conflictReview.getByText('User configuration override', { exact: true })).toBeVisible();
    await conflictReview.getByLabel('Resolution for User configuration override').selectOption('keep-mine');
    await page.getByRole('button', { name: 'Re-run review with conflict choices' }).click();
  }
  const eula = page.getByLabel('I accept the Minecraft EULA');
  if (await eula.isVisible().catch(() => false)) await eula.check();
  await page.getByRole('button', { name: 'Start reviewed operation' }).click();
}

test('reviewed source plans require explicit EULA consent and preserve the visible start choice', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'unmanaged' });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await chooseModrinthFromOverview(page, '2.0.0');
    await page.getByRole('button', { name: 'Review planned changes' }).click();

    const acceptEula = page.getByLabel('I accept the Minecraft EULA');
    const startAfterInstall = page.getByLabel('Start after install and validate final health');
    const start = page.getByRole('button', { name: 'Start reviewed operation' });
    await expect(acceptEula).toBeVisible();
    await expect(acceptEula).not.toBeChecked();
    await expect(startAfterInstall).toBeVisible();
    await expect(startAfterInstall).not.toBeChecked();
    await expect(start).toBeDisabled();

    await acceptEula.check();
    await startAfterInstall.check();
    await expect(start).toBeEnabled();
    await start.click();

    await expect.poll(() => fixture.readState().lifecycleCalls
      .filter(call => call.method === 'startOperation')
      .at(-1)?.choices).toEqual({
        acceptEula: true,
        startAfterInstall: true,
        restorePointId: null
      });
  } finally {
    await fixture.close();
  }
});

test('a terminal progress event triggers final durable hydration so its safe technical log is visible', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'unmanaged',
    holdFirstJobBeforeCommit: true,
    terminalEventWithDurableLogOnFirstJob: true
  });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await chooseModrinthFromOverview(page, '1.0.0');
    await startReviewedArchive(page);

    await expect(page.locator('section.outcome').getByRole('heading', { name: 'Stopped before server changes' })).toBeVisible();
    const log = page.getByLabel('Raw operation logs');
    await expect(log).toContainText('PLAN_STALE');
    await expect(log).toContainText('revalidate plan');
    await expect(log).toContainText('contentRevision');
    await expect(log).toContainText('The reviewed plan became stale before server changes');
    await expect(log).not.toContainText('No detailed log records have been published');
    await expect.poll(() => fixture.readState().lifecycleCalls.some(call =>
      call.method === 'getJob' && call.jobId === 'job-1' && call.phase === 'failed')).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('switching servers cannot publish a delayed refresh from the previous server', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'managed',
    secondaryServerState: {
      schemaVersion: 1,
      modpackManaged: false,
      lifecycleMode: 'unmanaged',
      source: null,
      runtime: null,
      installedAt: null,
      contentRevision: 0,
      managedFileCount: 0
    },
    refreshFixture: { stateDelayMsByInstanceId: { 'server-e2e': 800 } }
  });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await expect.poll(() => fixture.readState().lifecycleCalls.some(call =>
      call.method === 'getState' && call.instanceId === 'server-e2e')).toBe(true);

    await page.getByRole('button', { name: '☰' }).click();
    await page.locator('.instance-item').filter({ hasText: 'E2E Secondary Server' }).click();
    await expect(page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();

    await page.waitForTimeout(900);
    await expect(page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fixture Factory Pack' })).toHaveCount(0);
    expect(fixture.readState().lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'getState', instanceId: 'server-e2e' }),
      expect.objectContaining({ method: 'getState', instanceId: 'server-e2e-secondary' })
    ]));
  } finally {
    await fixture.close();
  }
});

async function expectCompleted(page) {
  const outcome = page.locator('section.outcome');
  await expect(outcome).toBeVisible();
  await expect(outcome.getByRole('heading', { name: 'Completed' })).toBeVisible();
  await expect(outcome).toBeFocused();
  return outcome;
}

async function returnToOverview(page) {
  await page.getByRole('button', { name: 'Return to server' }).click();
  await expect(page.getByRole('heading', { name: 'Modpack', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Modpack sections' })).toBeVisible();
}

test.describe.serial('managed modpack lifecycle', () => {
  let fixture;

  test.beforeAll(async () => {
    fixture = await harness.launchModpackApp({
      profile: 'unmanaged',
      holdFirstJobBeforeCommit: true
    });
    await fixture.openModpack();
  });

  test.afterAll(async () => fixture?.close());

  test('install-existing can cancel before commit, then complete with a safe outcome action', async () => {
    const { page } = fixture;
    await chooseModrinthFromOverview(page, '1.0.0');
    await startReviewedArchive(page);
    await expect(page.getByRole('progressbar', { name: 'Downloading' })).not.toHaveAttribute('aria-valuenow');
    const startedJobId = fixture.readState().lifecycleCalls
      .filter(call => call.method === 'startOperation')
      .at(-1)?.jobId;
    const heldPoll = await page.evaluate(jobId => window.electron.invoke('modpacks:get-job', { jobId }), startedJobId);
    expect(heldPoll).toMatchObject({ ok: true, value: { jobId: startedJobId, phase: 'downloading' } });
    await page.getByRole('button', { name: 'Cancel before commit' }).click();
    await expect(page.locator('section.outcome').getByRole('heading', { name: 'Stopped before server changes' })).toBeVisible();
    await expect(page.locator('section.outcome')).toBeFocused();
    expect(fixture.readState().state.lifecycleMode).toBe('unmanaged');

    await page.getByRole('button', { name: 'Back to Modpack overview' }).click();
    await chooseModrinthFromOverview(page, '1.0.0');
    await startReviewedArchive(page);
    const outcome = await expectCompleted(page);
    await outcome.getByRole('button', { name: 'Open details' }).click();
    await expect(page.getByRole('navigation', { name: 'Modpack sections' })).toBeVisible();
    expect(fixture.readState().safeActions.at(-1)).toMatchObject({ actionId: 'open-details' });
    expect(fixture.readState().safeActionResults.at(-1)).toEqual({
      at: '2026-08-01T12:00:00.000Z',
      type: 'outcome-action-result',
      actionId: 'open-details',
      status: 'ready',
      destination: { kind: 'details', targetId: expect.stringMatching(/^(?:job-|op2-)/u) }
    });
    const evidence = fixture.readState();
    const reviewedPlanCall = evidence.lifecycleCalls.filter(call => call.method === 'createPlan' && call.planId).at(-1);
    expect(reviewedPlanCall.selections).toMatchObject({
      optionalFileIds: ['optional-server-utilities'],
      conflictChoices: { paths: { 'conflict-user-config': { choice: 'keep-mine' } } }
    });
    expect(evidence.state).toMatchObject({ modpackManaged: true, lifecycleMode: 'managed' });
  });

  test('upgrade, blocked downgrade, safe downgrade, and switch retain exact reviewed identity', async () => {
    const { page } = fixture;
    await chooseManagedVersion(page, '2.0.0');
    await startReviewedArchive(page);
    await expectCompleted(page);
    await returnToOverview(page);
    expect(fixture.readState().state.source).toMatchObject({ version: '2.0.0', versionId: 'version-upgrade' });

    await chooseManagedVersion(page, '0.8.0');
    await page.getByLabel(/I understand a downgrade can make the current world incompatible/u).check();
    await page.getByRole('button', { name: 'Review planned changes' }).click();
    await expect(page.getByText('The selected downgrade archive cannot be prepared safely.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start reviewed operation' })).toBeDisabled();
    await page.getByRole('button', { name: 'Back to Modpack overview' }).click();

    await chooseManagedVersion(page, '0.9.0');
    await startReviewedArchive(page, { downgrade: true });
    await expectCompleted(page);
    await returnToOverview(page);
    expect(fixture.readState().state.source).toMatchObject({ version: '0.9.0', versionId: 'version-downgrade-safe' });

    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Switch modpack' }).click();
    await page.getByRole('button', { name: /Local archive/u }).click();
    await expect(page.getByText('zip archive', { exact: true })).toBeVisible();
    await startReviewedArchive(page);
    await expectCompleted(page);
    await returnToOverview(page);
    expect(fixture.readState().state.source).toMatchObject({ provider: 'local', version: 'local-1' });
  });

  test('verify enables targeted repair and rollback restores an exact recorded point', async ({}, testInfo) => {
    const { page } = fixture;
    await page.getByRole('button', { name: 'Actions' }).click();
    const repair = page.getByRole('button', { name: 'Repair', exact: true });
    await expect(repair).toBeDisabled();
    await expect(page.getByText(/Repair is offered separately and only when managed content differs from the manifest\./u)).toBeVisible();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    const verification = page.locator('section.outcome');
    await expect(verification.getByRole('heading', { name: 'Differences found' })).toBeVisible();
    await expect(verification).toBeFocused();
    await expect(verification).toHaveClass(/\bwarn\b/u);
    await expect(verification).toContainText('Checked files: 2');
    await expect(verification).toContainText('Mismatches: 1');
    await expect(verification).toContainText('mods/managed.jar');
    await expect(verification).toContainText('modified');
    await expect(verification).toContainText('No server files were changed');
    await expect(verification).toContainText('Repair is available separately');
    await expect(verification).not.toContainText('committed, validated from its final location');
    await page.screenshot({ path: testInfo.outputPath('verify-differences.png'), fullPage: false });
    await expect(page.getByText('Operation status error', { exact: true })).not.toBeVisible();
    await returnToOverview(page);

    await page.getByRole('button', { name: 'Actions' }).click();
    await expect(repair).toBeEnabled();
    await repair.click();
    await page.getByRole('button', { name: /Local archive/u }).click();
    await expect(page.getByText('zip archive', { exact: true })).toBeVisible();
    await startReviewedArchive(page);
    await expectCompleted(page);
    await returnToOverview(page);
    expect(fixture.readServerFile('mods/managed.jar')).toBe('managed:repaired\n');
    const repairCalls = fixture.readState().lifecycleCalls.filter(call => call.operationKind === 'repair');
    expect(repairCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'createPlan', requestedOperationKind: 'repair' }),
      expect.objectContaining({ method: 'startOperation', operationKind: 'repair' })
    ]));
    expect(repairCalls.some(call => call.method === 'createManagementPlan')).toBe(false);

    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('button', { name: 'Choose restore point' }).click();
    expect(fixture.readState().lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'listRollbackOptions', instanceId: harness.SERVER_ID })
    ]));
    await page.getByRole('button', { name: /install existing restore point/u }).click();
    await page.getByRole('button', { name: 'Start reviewed operation' }).click();
    await expectCompleted(page);
    await returnToOverview(page);
    expect(fixture.readServerFile('server.jar')).toBe('managed-v1\n');
  });

  test('history, notifications, ownership preservation, and prior running/stopped state remain explicit', async () => {
    const { page } = fixture;
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'Lifecycle operations' })).toBeVisible();
    await expect(page.getByRole('list').getByText('install existing', { exact: true })).toBeVisible();
    await expect(page.getByRole('list').getByText('rollback restore point', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /Modpack notifications, 1 unread/u }).click();
    await page.getByRole('button', { name: /Exact modpack update available/u }).click();
    await expect(page.getByRole('button', { name: /Modpack notifications, 0 unread/u })).toBeVisible();

    const evidence = fixture.readState();
    expect(evidence.notifications[0].read).toBe(true);
    expect(evidence.safeActions.at(-1)).toMatchObject({ actionId: 'open-details', opaqueRef: 'action-reference-1' });
    expect(new Set(evidence.priorStates.map(item => item.priorState))).toEqual(new Set(['running', 'stopped']));
    expect(evidence.priorStates.every(item => item.priorState === item.restoredState)).toBe(true);
    for (const preserved of ['mods/user-added.jar', 'config/user.cfg', 'world/level.dat']) {
      expect(fixture.serverFileExists(preserved), `${preserved} should remain`).toBe(true);
    }
    expect(evidence.ambientNetworkRequests).toBe(0);
  });

  test('detach confirmation defaults to Cancel, traps/restores focus, and removes zero files', async () => {
    const { page } = fixture;
    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('button', { name: 'Review detach' }).click();
    const opener = page.getByRole('button', { name: 'Detach and keep all files' });
    await opener.click();
    const cancel = page.getByRole('button', { name: 'Cancel' });
    const confirm = page.getByRole('button', { name: 'Detach', exact: true });
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();

    await opener.click();
    await expect(cancel).toBeFocused();
    await confirm.click();
    await expectCompleted(page);
    const beforeReturn = fixture.readState();
    expect(beforeReturn.state).toMatchObject({ modpackManaged: false, lifecycleMode: 'detached' });
    for (const kept of ['server.jar', 'mods/managed.jar', 'mods/user-added.jar', 'config/user.cfg', 'world/level.dat']) {
      expect(fixture.serverFileExists(kept), `${kept} should remain after detach`).toBe(true);
    }
    await returnToOverview(page);
    await page.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('heading', { name: 'Management is detached' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose restore point' })).toBeVisible();
    for (const unavailable of ['Verify', 'Repair', 'Review detach', 'Review uninstall']) {
      await expect(page.getByRole('button', { name: unavailable, exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByRole('list').getByText('detach', { exact: true })).toBeVisible();
  });
});

test('rollback chooser does not offer a historical restore record after its archive is unavailable', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', rollbackOptions: [] });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByText('install existing', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('button', { name: 'Choose restore point' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a compatible restore point' })).toBeVisible();
    await expect(page.getByText('No retained restore point is available', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /restore point/u })).toHaveCount(0);
    const evidence = fixture.readState();
    expect(evidence.lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'listRollbackOptions', instanceId: harness.SERVER_ID })
    ]));
    expect(evidence.lifecycleCalls.some(call => call.method === 'createManagementPlan')).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('rollback selection visibly reports live scan and measured archive verification before plan review', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'managed',
    managementPreflightDelayMs: 500
  });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('button', { name: 'Choose restore point' }).click();
    const restorePoint = page.getByRole('button', { name: /install existing restore point/iu });
    await restorePoint.click();

    const progress = page.getByRole('status', { name: 'Modpack preflight progress' });
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('Scanning current server files');
    await expect(restorePoint).toHaveAttribute('aria-pressed', 'true');
    await expect(restorePoint).toContainText('Verifying selection…');
    expect(fixture.readState().lifecycleCalls.some(call => call.method === 'createManagementPlan')).toBe(false);

    await expect(progress).toContainText('Verifying archive contents');
    await expect(progress).toContainText('25%');
    await expect(page.getByRole('region', { name: 'Reviewed modpack operation plan' })).toBeVisible();
    expect(fixture.readState().lifecycleCalls.some(call => call.method === 'startOperation')).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('managed version history defaults to every channel and marks runtime changes', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Load exact version history' }).click();

    await expect(page.getByRole('button', { name: /1\.20\.1 Forge beta/u })).toBeVisible();
    await expect(page.getByRole('button', { name: /1\.19\.4 Quilt alpha/u })).toBeVisible();
    await expect(page.getByText('Advertises the current Minecraft version and loader family. Archive inspection must confirm the exact runtime and loader version.')).toHaveCount(5);
    await expect(page.getByText('Advertises a different Minecraft version or loader family. Archive inspection must confirm the exact runtime and loader version.')).toHaveCount(3);

    const call = fixture.readState().providerCalls.filter(entry => entry.method === 'listVersions').at(-1);
    expect(call.request).toEqual({ projectId: 'fixture-pack' });
  } finally {
    await fixture.close();
  }
});

test('a newer-published cross-runtime Modrinth backport uses downgrade safeguards, not update or switch', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Load exact version history' }).click();
    await page.getByRole('button', { name: /1\.20\.1 Forge beta/u }).click();
    await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
    await page.getByLabel(/I understand a downgrade can make the current world incompatible/u).check();
    await page.getByRole('button', { name: 'Review planned changes' }).click();
    expect(fixture.readState().lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'createPlan', operationKind: 'downgrade', selections: expect.objectContaining({ acknowledgeDowngradeWorldRisk: true }) })
    ]));
    expect(fixture.readState().lifecycleCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'createPlan', operationKind: 'update' }),
      expect.objectContaining({ method: 'createPlan', operationKind: 'switch' })
    ]));
    expect(fixture.readState().lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'inspectSource', provider: 'modrinth', projectId: 'fixture-pack', versionId: 'version-forge-beta' })
    ]));
  } finally {
    await fixture.close();
  }
});

test('a newer forward-runtime Modrinth version uses switch review', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Load exact version history' }).click();
    await page.getByRole('button', { name: /1\.22\.0 NeoForge/u }).click();
    await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
    await page.getByRole('button', { name: 'Review planned changes' }).click();
    expect(fixture.readState().lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'inspectSource', provider: 'modrinth', projectId: 'fixture-pack', versionId: 'version-forward-neoforge' }),
      expect.objectContaining({ method: 'createPlan', operationKind: 'switch' })
    ]));
  } finally {
    await fixture.close();
  }
});

test('navigation cancels stale exact-version inspections before a newer selection can replace them', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'managed',
    modrinthFixture: {
      inspectionDelayMsByVersionId: {
        'version-forge-beta': 400,
        'version-forward-neoforge': 25,
        'version-client-only': 250
      }
    }
  });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Load exact version history' }).click();
    await page.getByRole('button', { name: /1\.20\.1 Forge beta/u }).click();
    await expect(page.getByRole('progressbar', { name: 'Downloading selected asset' })).toBeVisible();
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect.poll(() => fixture.readState().lifecycleCalls.some(call =>
      call.method === 'inspectSourceCancelled' && call.versionId === 'version-forge-beta')).toBe(true);

    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Load exact version history' }).click();
    await page.getByRole('button', { name: /1\.22\.0 NeoForge/u }).click();
    await expect.poll(() => fixture.readState().lifecycleCalls.some(call =>
      call.method === 'inspectSourceCompleted' && call.versionId === 'version-forward-neoforge')).toBe(true);
    await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
    await page.getByRole('button', { name: 'Review planned changes' }).click();
    expect(fixture.readState().lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'createPlan', operationKind: 'switch', projectId: 'fixture-pack', versionId: 'version-forward-neoforge' })
    ]));

    await page.getByRole('button', { name: 'Back to Modpack overview' }).click();
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Load exact version history' }).click();
    await page.getByRole('button', { name: /^3\.0\.0-client/u }).click();
    await page.getByRole('button', { name: 'Overview' }).click();
    await expect.poll(() => fixture.readState().lifecycleCalls.some(call =>
      call.method === 'inspectSourceCancelled' && call.versionId === 'version-client-only')).toBe(true);
    await expect(page.getByRole('navigation', { name: 'Modpack sections' })).toBeVisible();
    await expect(page.getByText('CLIENT_ONLY_PACK', { exact: true })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test('a Modrinth notification opens its exact immutable version without starting a download', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: /Modpack notifications, 1 unread/u }).click();
    await page.getByRole('button', { name: /Exact modpack update available/u }).click();

    const exactTarget = page.locator('[data-version-id="version-upgrade"][data-notification-target="true"]');
    await expect(exactTarget).toBeVisible();
    await expect(exactTarget).toContainText('2.0.0');
    await expect(exactTarget).toBeFocused();

    const evidence = fixture.readState();
    expect(evidence.safeActionResults.at(-1)).toMatchObject({
      destination: {
        kind: 'details',
        releaseTarget: {
          serverId: harness.SERVER_ID,
          provider: 'modrinth',
          sourceId: 'fixture-pack',
          releaseId: 'version-upgrade',
          prerelease: false
        }
      }
    });
    expect(evidence.providerCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'modrinth', method: 'listVersions', request: { projectId: 'fixture-pack' } })
    ]));
    expect(evidence.lifecycleCalls.some(call => call.method === 'inspectSource')).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('a GitHub notification opens the exact release assets without substituting another release', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'managed',
    managedGithub: true,
    notificationRecords: [{
      notificationId: 'notification-github-backport',
      serverId: harness.SERVER_ID,
      type: 'update-available',
      title: 'Exact GitHub backport available',
      message: 'Review the exact uploaded assets for v2.0.1-backport.',
      timestamp: harness.FIXED_TIME,
      read: false,
      source: { provider: 'github', sourceId: '1001' },
      release: { releaseId: '2003', version: 'v2.0.1-backport', prerelease: false },
      action: { actionId: 'open-details', opaqueRef: 'release-review:fixture-tracking:2003' }
    }]
  });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: /Modpack notifications, 1 unread/u }).click();
    await page.getByRole('button', { name: /Exact GitHub backport available/u }).click();

    await expect(page.getByRole('heading', { name: 'Fixture Backport Release' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /fixture-github-backport\.zip/u })).toBeVisible();

    const evidence = fixture.readState();
    expect(evidence.safeActionResults.at(-1)).toMatchObject({
      destination: {
        kind: 'details',
        releaseTarget: {
          serverId: harness.SERVER_ID,
          provider: 'github',
          sourceId: '1001',
          releaseId: '2003',
          prerelease: false
        }
      }
    });
    expect(evidence.providerCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'github', method: 'listReleases', repositoryId: '1001' }),
      expect.objectContaining({ provider: 'github', method: 'loadUploadedAssets', repositoryId: '1001', releaseId: '2003' })
    ]));
    expect(evidence.providerCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'github', method: 'loadUploadedAssets', releaseId: '2001' })
    ]));
    expect(evidence.lifecycleCalls.some(call => call.method === 'inspectSource')).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('a newer-published GitHub backport uses exact runtime downgrade safeguards', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', managedGithub: true });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: "Load this repository's releases" }).click();
    await page.getByLabel('Public repository or release URL').fill('https://github.com/FixtureOrg/FixturePack');
    await page.getByRole('button', { name: 'Load releases' }).click();
    await expect(page.getByRole('button', { name: /Fixture Release v2/u })).toBeDisabled();
    await page.getByRole('button', { name: /Fixture Backport Release/u }).click();
    await page.getByRole('radio', { name: /fixture-github-backport\.zip/u }).click();
    await page.getByRole('button', { name: 'Download and inspect selected asset' }).click();
    await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
    const preflight = page.getByRole('button', { name: 'Review planned changes' });
    await expect(preflight).toBeDisabled();
    await page.getByLabel(/I understand a downgrade can make the current world incompatible/u).check();
    await expect(preflight).toBeEnabled();
    await preflight.click();

    const evidence = fixture.readState();
    expect(evidence.lifecycleCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'inspectSource', provider: 'github', repositoryId: '1001', releaseId: '2003', assetIds: ['asset-github-backport']
      }),
      expect.objectContaining({
        method: 'createPlan', operationKind: 'downgrade', selections: expect.objectContaining({ acknowledgeDowngradeWorldRisk: true })
      })
    ]));
    expect(evidence.lifecycleCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'createPlan', operationKind: 'update' }),
      expect.objectContaining({ method: 'createPlan', operationKind: 'switch' })
    ]));
  } finally {
    await fixture.close();
  }
});

test('uninstall removes only unchanged managed files and leaves a files-only server', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('button', { name: 'Review uninstall' }).click();
    await expect(page.getByText('The server is not deleted', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove managed pack files' }).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.getByRole('button', { name: 'Remove managed files', exact: true }).click();
    await expectCompleted(page);
    expect(fixture.readState().state).toMatchObject({ modpackManaged: false, lifecycleMode: 'files-only', managedFileCount: 0 });
    expect(fixture.serverFileExists('mods/managed.jar')).toBe(false);
    for (const kept of ['mods/user-added.jar', 'config/user.cfg', 'world/level.dat']) {
      expect(fixture.serverFileExists(kept), `${kept} should remain after uninstall`).toBe(true);
    }
    await returnToOverview(page);
    await page.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('heading', { name: 'Managed files are inactive' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose restore point' })).toBeVisible();
    for (const unavailable of ['Verify', 'Repair', 'Review detach', 'Review uninstall']) {
      await expect(page.getByRole('button', { name: unavailable, exact: true })).toHaveCount(0);
    }
  } finally {
    await fixture.close();
  }
});

test('managed modpack notifications stay on the Modpack tab and page instead of the global header', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'managed',
    additionalNotifications: [{
      notificationId: 'notification-other-server',
      serverId: 'server-other',
      title: 'Other server update',
      message: 'This actionable notice must remain globally available.',
      timestamp: '2026-08-01T12:00:01.000Z',
      read: false,
      source: { provider: 'github' },
      release: { version: '3.0.0' },
      action: { actionId: 'open-details', opaqueRef: 'action-reference-other' }
    }]
  });
  try {
    const { page } = fixture;
    const rendererErrors = [];
    page.on('pageerror', error => rendererErrors.push(error.message));
    expect(page.url()).toContain('/dist/index.html');
    await expect(page).toHaveTitle('Minecraft Core');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const header = page.locator('.server-header');
    const settings = header.getByRole('button', { name: 'Open app settings' });
    await expect(settings).toBeVisible();
    await expect(header.getByRole('button', { name: /Modpack notifications/u })).toHaveCount(0);

    const modpackTab = page.locator('.server-tabs').getByRole('button', { name: /Modpack/u });
    await expect(modpackTab).toHaveAccessibleName('Modpack, 1 unread notification');
    await expect(modpackTab.locator('.nav-update-badge')).toHaveText('1');
    await fixture.openModpack();
    await expect(header.getByRole('button', { name: /Modpack notifications/u })).toHaveCount(0);

    const contextualBell = page.locator('.modpack-page .notification-host.contextual').getByRole('button', {
      name: /Modpack notifications, 1 unread/u
    });
    await expect(contextualBell).toBeVisible();
    await contextualBell.click();
    const contextualPanel = page.locator('.modpack-page').getByRole('region', { name: 'Persistent modpack notifications' });
    await expect(contextualPanel.getByText('Exact modpack update available', { exact: true })).toBeVisible();
    await expect(contextualPanel.getByText('Other server update', { exact: true })).toHaveCount(0);
    // Actual styled App: the ordinary selector overlay must own hit-testing
    // even while contextual notifications remain mounted underneath it.
    await page.getByRole('button', { name: '☰' }).click();
    await page.getByRole('button', { name: '+ Add Instance', exact: true }).click();
    const selector = page.getByRole('dialog').filter({ hasText: 'Welcome to Minecraft Core' });
    await expect(selector).toBeVisible();
    await page.screenshot({ path: path.join(os.tmpdir(), 'minecraft-core-task6-notification-selector.png') });
    const stacking = await page.evaluate(() => {
      const overlay = document.querySelector('.modal-overlay');
      const host = document.querySelector('.modpack-page .notification-host.contextual');
      return { overlay: Number(getComputedStyle(overlay).zIndex), host: Number(getComputedStyle(host).zIndex) };
    });
    expect(stacking.overlay).toBeGreaterThan(stacking.host);
    for (const target of [contextualBell, contextualPanel.getByRole('button', { name: 'Close notifications' })]) {
      const point = await target.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2;
        const y = bounds.top + bounds.height / 2;
        return { x, y, overlayOwnsPoint: Boolean(document.elementFromPoint(x, y)?.closest('.modal-overlay')) };
      });
      expect(point.overlayOwnsPoint).toBe(true);
      await page.mouse.click(point.x, point.y);
      // Backdrop dismissal cannot activate the notification underneath.
      await expect(contextualPanel).toBeVisible();
      if (!await selector.isVisible()) {
        await page.getByRole('button', { name: '+ Add Instance', exact: true }).click();
        await expect(selector).toBeVisible();
      }
    }
    await selector.press('Escape');
    await expect(selector).toHaveCount(0);
    await page.getByRole('button', { name: '☰' }).click();
    await contextualPanel.getByRole('button', { name: 'Close notifications' }).click();
    await expect(contextualPanel).toHaveCount(0);
    await expect(contextualBell).toBeFocused();
    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Switch modpack' }).click();
    await expect(contextualBell).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Modpack overview' })).toBeVisible();
    expect(rendererErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

const dashboardStarts = page => page.locator('.server-controls').getByRole('button', { name: 'Start', exact: true });
const dashboardRecovery = page => page.getByRole('status', { name: 'Server recovery status' });

async function openDashboard(page) {
  await page.locator('.server-tabs').getByRole('button', { name: /Dashboard/u }).click();
  await expect(page.getByRole('heading', { name: 'Minecraft Server Control Panel' })).toBeVisible();
}

test('Dashboard Modpack Dashboard always rechecks recovery and normal completion restores both Starts', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'managed',
    recoveryRecords: [{ recoveryId: `recovery-${'a'.repeat(32)}`, serverId: 'server-e2e', phase: 'failed', title: 'Unfinished cleanup', automaticPossible: true, actions: [{ actionId: 'recover-safely', label: 'Retry verified recovery', recommended: true }] }],
    recoveryListFixture: { allowRegisteredResolution: true }
  });
  try {
    const { page } = fixture;
    await expect(dashboardRecovery(page)).toContainText('Recovery is pending for this server.');
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await expect(dashboardStarts(page).nth(1)).toBeDisabled();
    await dashboardRecovery(page).getByRole('button', { name: 'Review Modpack' }).click();
    await expect(page.getByRole('region', { name: 'Modpack recovery' })).toBeVisible();
    await openDashboard(page);
    await expect(dashboardRecovery(page)).toContainText('Recovery is pending for this server.');
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Retry verified recovery' }).click();
    await expect.poll(() => fixture.readState().recovery.length).toBe(0);
    const callsBeforeDashboard = fixture.readState().recoveryListCalls;
    await openDashboard(page);
    await expect(dashboardRecovery(page)).toHaveCount(0);
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
    await expect(dashboardStarts(page).nth(1)).toBeEnabled();
    expect(fixture.readState().recoveryListCalls).toBeGreaterThan(callsBeforeDashboard);
    expect(fixture.readState().recoveryRuns).toBe(1);
  } finally { await fixture.close(); }
});

for (const staleReply of ['success', 'rejection']) {
test(`actual App server switch ignores an older delayed recovery ${staleReply}`, async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'managed', secondaryServerState: { schemaVersion: 1, modpackManaged: false, lifecycleMode: 'unmanaged', source: null, runtime: null, installedAt: null, contentRevision: 0, managedFileCount: 0 },
    recoveryRecords: [{ recoveryId: 'other-recovery', serverId: 'server-e2e' }],
    // Keep the initial ownership read from starting an immediate generation
    // refresh before the delayed recovery read has been exercised/switched.
    refreshFixture: { stateDelayMsByInstanceId: { 'server-e2e': 6000 } },
    recoveryListFixture: { delayMsByCall: { 1: 2000 }, failureCalls: staleReply === 'rejection' ? [1] : [] }
  });
  try {
    const { page } = fixture;
    await expect(dashboardRecovery(page)).toContainText('Checking recovery status');
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await page.getByRole('button', { name: '☰' }).click();
    await page.locator('.instance-item').filter({ hasText: 'E2E Secondary Server' }).click();
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
    await expect(dashboardStarts(page).nth(1)).toBeEnabled();
    await expect.poll(() => fixture.readState().recoveryListCompletedCalls.includes(1)).toBe(true);
    await expect(dashboardRecovery(page)).toHaveCount(0);
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
    // Selecting an instance intentionally leaves the sidebar overlay open.
    // Dismiss it normally before navigating, without bypassing hit-testing.
    await page.getByRole('button', { name: '☰' }).click();
    await fixture.openModpack();
    await expect(page.getByRole('region', { name: 'Modpack recovery' })).toHaveCount(0);
    await openDashboard(page);
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
  } finally { await fixture.close(); }
});
}

test('actual App unavailable recovery cannot enable Start and ordinary Retry check confirms empty', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'unmanaged', recoveryListFixture: { failureCalls: [1] } });
  try {
    const { page } = fixture;
    await expect(dashboardRecovery(page)).toContainText('Recovery status could not be checked');
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await expect(dashboardStarts(page).nth(1)).toBeDisabled();
    await dashboardRecovery(page).getByRole('button', { name: 'Retry check' }).click();
    await expect(dashboardRecovery(page)).toHaveCount(0);
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
    await expect(dashboardStarts(page).nth(1)).toBeEnabled();
  } finally { await fixture.close(); }
});

test('an unmanaged server shows neither a notification badge nor a notification control', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'unmanaged' });
  try {
    const { page } = fixture;
    const header = page.locator('.server-header');
    const modpackTab = page.locator('.server-tabs').getByRole('button', { name: /^Modpack$/u });

    await expect(header.getByRole('button', { name: /Modpack notifications/u })).toHaveCount(0);
    await expect(modpackTab).toBeVisible();
    await expect(modpackTab.locator('.nav-update-badge')).toHaveCount(0);

    await fixture.openModpack();
    await expect(page.locator('.modpack-page .notification-host.contextual')).toHaveCount(0);
    await page.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();
    for (const unavailable of ['Verify', 'Repair', 'Choose restore point', 'Review detach', 'Review uninstall']) {
      await expect(page.getByRole('button', { name: unavailable, exact: true })).toHaveCount(0);
    }
    expect(fixture.readState().lifecycleCalls.some(call =>
      ['verify', 'createManagementPlan'].includes(call.method))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('another server recovery does not surface on a pristine active server', async () => {
  const fixture = await harness.launchModpackApp({
    profile: 'unmanaged',
    notificationRecords: [],
    recoveryRecords: [{
      recoveryId: 'recovery-other-server',
      serverId: 'server-other',
      phase: 'blocked',
      automaticPossible: false,
      actions: [{ actionId: 'review-recovery', label: 'Review recovery' }]
    }]
  });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await expect(page.locator('.modpack-page .notification-host.contextual')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Modpack recovery' })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
