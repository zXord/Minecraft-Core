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

  test('verify reports observations while fresh repair review and rollback retain exact sources', async ({}, testInfo) => {
    const { page } = fixture;
    await page.getByRole('button', { name: 'Actions' }).click();
    const repair = page.getByRole('button', { name: 'Review repair', exact: true });
    await expect(repair).toBeEnabled();
    await expect(page.getByText('Verify is read-only. Review repair checks the exact installed source and current files before any change.', { exact: true })).toBeVisible();
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
    await expect(verification).toContainText('Differences were observed at verification time. Review repair from Actions checks current files again.');
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
    for (const unavailable of ['Verify', 'Review repair', 'Review detach', 'Review uninstall']) {
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

test('a GitHub notification opens its exact assets once and allows returning to release history', async () => {
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

    // A consumed notification must not replay when the release picker remounts.
    // Deliberately opening the same now-read notification must still work.
    for (let visit = 0; visit < 2; visit += 1) {
      const assetsBeforeBack = fixture.readState().providerCalls
        .filter(call => call.method === 'loadUploadedAssets').length;
      await page.getByRole('button', { name: 'Choose another release' }).click();
      await expect(page.getByRole('heading', { name: 'Choose an exact release' })).toBeVisible();
      await page.getByRole('button', { name: 'Load releases', exact: true }).click();
      await expect(page.getByRole('region', { name: 'GitHub release history' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Fixture Release v2/u })).toBeDisabled();
      await expect(page.getByRole('button', { name: /Fixture Backport Release/u })).toBeEnabled();
      expect(fixture.readState().providerCalls.filter(call => call.method === 'loadUploadedAssets'))
        .toHaveLength(assetsBeforeBack);
      await expect(page.getByRole('heading', { name: 'Fixture Backport Release' })).toHaveCount(0);

      if (visit === 0) {
        await page.getByRole('button', { name: /Modpack notifications, 0 unread/u }).click();
        await page.getByRole('button', { name: /Exact GitHub backport available/u }).click();
        await expect(page.getByRole('heading', { name: 'Fixture Backport Release' })).toBeVisible();
      }
    }
    const afterNavigation = fixture.readState();
    expect(afterNavigation.state).toEqual(evidence.state);
    expect(afterNavigation.lifecycleCalls.filter(call =>
      ['inspectSource', 'createPlan', 'startOperation'].includes(call.method))).toEqual([]);
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
    for (const unavailable of ['Verify', 'Review repair', 'Review detach', 'Review uninstall']) {
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
    await expect(page).toHaveURL(new RegExp(process.env.MINECRAFT_CORE_DEV_SERVER_URL ? '^http://127\\.0\\.0\\.1:5173/' : '/dist/index\\.html'));
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

async function startHeldRepair(fixture) {
  const { page } = fixture;
  await fixture.openModpack();
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.locator('section.outcome').getByRole('heading', { name: 'Differences found' })).toBeVisible();
  await page.getByRole('button', { name: 'Return to server', exact: true }).click();
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Review repair', exact: true }).click();
  await page.getByRole('button', { name: /Local archive/u }).click();
  await startReviewedArchive(page);
  await expect(page.getByRole('heading', { name: 'Creating restore point', exact: true })).toBeVisible();
  return fixture.controlHeldRepair({ kind: 'read' });
}

test('active-job navigation reattaches Repair and blocks both Starts through owned terminal settlement', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { holdRepairOwner: true } });
  const errors = [];
  try {
    const { page } = fixture;
    await expect(page).toHaveTitle('Minecraft Core');
    const initialDocument = new URL(page.url());
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const job = await startHeldRepair(fixture);
    await page.locator('.server-tabs').getByRole('button', { name: /Dashboard/u }).click();
    await expect(dashboardRecovery(page)).toContainText('Operation in progress');
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await expect(dashboardStarts(page).nth(1)).toBeDisabled();
    await dashboardRecovery(page).getByRole('button', { name: 'View operation', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(job.jobId);
    await expect(page.getByRole('region', { name: 'Modpack recovery' })).toHaveCount(0);
    expect(new URL(page.url())).toMatchObject({
      origin: initialDocument.origin, pathname: initialDocument.pathname, search: initialDocument.search,
    });
    await expect(page).toHaveTitle('Minecraft Core');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({ path: path.join(os.tmpdir(), 'task6-held-repair-navigation.png') });

    const old = await fixture.controlHeldRepair({ kind: 'read' });
    await fixture.controlHeldRepair({ kind: 'queue-poll', reply: { value: old, delayMs: 600 } });
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'getJob' && call.jobId === job.jobId).length).toBeGreaterThan(0);
    await fixture.controlHeldRepair({ kind: 'emit', event: { sequence: old.sequence + 5, phase: 'staging', cancellationRequested: true, progress: { percent: 50, message: 'Newer staging event', currentItem: null } } });
    await expect(page.getByRole('heading', { name: 'Extracting and Reconciling files', exact: true })).toBeVisible();
    await page.waitForTimeout(700);
    await expect(page.getByRole('heading', { name: 'Extracting and Reconciling files', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel before commit', exact: true })).toHaveCount(0);
    const terminal = await fixture.controlHeldRepair({ kind: 'settle' });
    await page.getByText('Technical operation log', { exact: true }).click();
    await expect(page.getByLabel('Raw operation logs')).toContainText('Held Repair durable final log');
    await fixture.controlHeldRepair({ kind: 'emit', event: { sequence: terminal.sequence, phase: 'completed', outcome: null, events: [] } });
    await expect(page.getByLabel('Raw operation logs')).toContainText('Held Repair durable final log');
    await page.locator('.server-tabs').getByRole('button', { name: /Dashboard/u }).click();
    await expect(dashboardRecovery(page)).toContainText('Operation in progress');
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await expect(dashboardStarts(page).nth(1)).toBeDisabled();
    const pollsAtUnmount = fixture.readState().lifecycleCalls.filter(call => call.method === 'getJob' && call.jobId === job.jobId).length;
    await fixture.controlHeldRepair({ kind: 'release' });
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
    await expect(dashboardStarts(page).nth(1)).toBeEnabled();
    await page.waitForTimeout(1300);
    expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'getJob' && call.jobId === job.jobId).length).toBe(pollsAtUnmount);
    expect(errors).toEqual([]);
  } finally { await fixture.close(); }
});

test('active-job navigation blocks unknown activity independently of recovery and canonical reads', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { activeFailureIds: ['server-e2e'] } });
  try {
    const { page } = fixture;
    await expect(dashboardRecovery(page)).toContainText('Operation status unavailable');
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await expect(dashboardStarts(page).nth(1)).toBeDisabled();
    await fixture.openModpack();
    await expect(page.locator('.modpack-page strong').filter({ hasText: /^Operation status unavailable$/u })).toBeVisible();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Verify', exact: true })).toHaveCount(0);
  } finally { await fixture.close(); }
});

test('active-job navigation ignores A-B-A stale discovery success and rejection while canonical reads fail', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { holdRepairOwner: true },
    secondaryServerState: { schemaVersion: 1, modpackManaged: false, lifecycleMode: 'unmanaged', source: null, runtime: null, installedAt: null, contentRevision: 0, managedFileCount: 0 } });
  try {
    const { page } = fixture;
    const job = await startHeldRepair(fixture);
    fixture.updateScenario({ refreshFixture: { holdRepairOwner: true, stateFailureIds: ['server-e2e'], historyFailureIds: ['server-e2e'] } });
    for (const fail of [false, true]) {
      const before = fixture.readState().lifecycleCalls.filter(call => call.method === 'getActiveJobs').length;
      await fixture.controlHeldRepair({ kind: 'queue-active', reply: { fail, delayMs: 1600,
        value: { serverId: 'server-e2e', items: [{ ownership: 'running', job: { ...job, jobId: 'stale-owned-job' } }] } } });
      await fixture.controlHeldRepair({ kind: 'emit', event: { sequence: job.sequence, phase: 'snapshotting' } });
      await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'getActiveJobs').length).toBeGreaterThan(before);
      await page.getByRole('button', { name: '☰' }).click();
      await page.locator('.instance-item').filter({ hasText: 'E2E Secondary Server' }).click();
      await expect(page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();
      await page.locator('.instance-item').filter({ hasText: 'E2E Fixture Server' }).click();
      await page.getByRole('button', { name: '☰' }).click();
      await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(job.jobId);
      await page.waitForTimeout(1700);
      await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(job.jobId);
      await expect(page.getByText('stale-owned-job', { exact: false })).toHaveCount(0);
      await expect(page.locator('.modpack-page strong').filter({ hasText: /^Operation status unavailable$/u })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Modpack recovery' })).toHaveCount(0);
    }
    await fixture.controlHeldRepair({ kind: 'duplicate-owner' });
    const owned = page.getByRole('region', { name: 'Owned operations' });
    await expect(owned.getByRole('heading', { name: 'Choose an owned operation' })).toBeVisible();
    await expect(owned.getByRole('button')).toHaveCount(2);
    await owned.getByRole('button', { name: /second-owned-verify/u }).click();
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText('second-owned-verify');
  } finally { await fixture.close(); }
});

test('active-job review fix preserves freshest multi-owner state on same-job reselection and switch-away-back', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { holdRepairOwner: true } });
  try {
    const { page } = fixture;
    const job = await startHeldRepair(fixture);
    await fixture.controlHeldRepair({ kind: 'duplicate-owner' });
    const owned = page.getByRole('region', { name: 'Owned operations' });
    const repair = owned.getByRole('button', { name: new RegExp(job.jobId, 'u') });
    const verify = owned.getByRole('button', { name: /second-owned-verify/u });
    await expect(owned.getByRole('button')).toHaveCount(2);
    const before = fixture.readState().lifecycleCalls.filter(call => call.method === 'getActiveJobs').length;
    const log = { sequence: job.sequence + 4, jobId: job.jobId, channel: 'log', phase: 'staging', timestamp: job.createdAt,
      message: 'Fresh multi-owner log', progress: null, currentItem: null, details: null };
    await fixture.controlHeldRepair({ kind: 'emit', event: { sequence: job.sequence + 5, phase: 'staging', cancellationRequested: true,
      progress: { percent: 50, message: 'Fresh selected state', currentItem: null }, events: [log] } });
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'getActiveJobs').length).toBeGreaterThan(before);
    await expect(page.getByRole('heading', { name: 'Extracting and Reconciling files', exact: true })).toBeVisible();
    await repair.click();
    await expect(page.getByRole('heading', { name: 'Extracting and Reconciling files', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel before commit', exact: true })).toHaveCount(0);
    await verify.click();
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText('second-owned-verify');
    await repair.click();
    await expect(page.getByRole('heading', { name: 'Extracting and Reconciling files', exact: true })).toBeVisible();
    await page.getByText('Technical operation log', { exact: true }).click();
    await expect(page.getByLabel('Raw operation logs')).toContainText('Fresh multi-owner log');
    await fixture.controlHeldRepair({ kind: 'emit', event: { sequence: job.sequence + 6, phase: 'failed', terminalAt: job.createdAt,
      outcome: { status: 'failed', kind: 'nothing-changed', result: { serverUnchanged: true }, actions: [] } } });
    await expect(page.getByRole('heading', { name: 'Stopped before server changes' })).toBeVisible();
    await verify.click();
    await repair.click();
    await expect(page.getByRole('heading', { name: 'Stopped before server changes' })).toBeVisible();
    await page.getByText('Technical operation log', { exact: true }).click();
    await expect(page.getByLabel('Raw operation logs')).toContainText('Fresh multi-owner log');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally { await fixture.close(); }
});

for (const scope of ['A-B-A', 'newer-job']) {
  for (const fail of [false, true]) {
    test(`active-job review fix ignores held parent Retry ${fail ? 'rejection' : 'success'} after ${scope}`, async () => {
      const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { holdRepairOwner: true },
        secondaryServerState: { schemaVersion: 1, modpackManaged: false, lifecycleMode: 'unmanaged', source: null, runtime: null, installedAt: null, contentRevision: 0, managedFileCount: 0 } });
      try {
        const { page } = fixture;
        const job = await startHeldRepair(fixture);
        const readsBeforeFailure = fixture.readState().lifecycleCalls.filter(call => call.method === 'getJob').length;
        const failed = await fixture.controlHeldRepair({ kind: 'set-job', job: { sequence: job.sequence + 10, phase: 'failed', terminalAt: job.createdAt,
          outcome: { status: 'failed', kind: 'nothing-changed', result: { serverUnchanged: true }, actions: [{ actionId: 'retry', opaqueRef: 'held-retry-ref' }] } } });
        await expect(page.getByRole('heading', { name: 'Stopped before server changes' })).toBeVisible();
        await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'getJob').length).toBeGreaterThan(readsBeforeFailure);
        await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
        await fixture.controlHeldRepair({ kind: 'queue-poll', reply: { hold: true, fail, value: { ...failed, jobId: 'stale-parent-retry-job' } } });
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldGetJobEntered').length).toBe(1);
        const held = fixture.readState().lifecycleCalls.find(call => call.method === 'heldGetJobEntered');
        let expectedJobId = job.jobId;
        if (scope === 'A-B-A') {
          await page.getByRole('button', { name: '☰' }).click();
          await page.locator('.instance-item').filter({ hasText: 'E2E Secondary Server' }).click();
          await expect(page.getByRole('heading', { name: 'No managed modpack is attached' })).toBeVisible();
          await page.locator('.instance-item').filter({ hasText: 'E2E Fixture Server' }).click();
          await page.getByRole('button', { name: '☰' }).click();
        } else {
          expectedJobId = 'newer-owned-repair';
          await fixture.controlHeldRepair({ kind: 'replace-owner', job: { jobId: expectedJobId, sequence: failed.sequence + 10,
            phase: 'staging', terminalAt: null, outcome: null, progress: { percent: 60, message: 'Newer owned job', currentItem: null } } });
        }
        await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(expectedJobId);
        await page.evaluate(() => {
          window.retryRaceViolations = [];
          window.retryRaceObserver = new MutationObserver(() => {
            const root = document.querySelector('.modpack-page');
            if (root?.textContent?.includes('stale-parent-retry-job')) window.retryRaceViolations.push('stale job rendered');
            if (root?.querySelector('.page-error')) window.retryRaceViolations.push('stale parent error rendered');
          });
          window.retryRaceObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        });
        await fixture.controlHeldRepair({ kind: 'release-poll', readId: held.readId });
        await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldGetJobReleased').length).toBe(1);
        await page.waitForTimeout(150);
        await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(expectedJobId);
        await expect(page.getByText('stale-parent-retry-job', { exact: false })).toHaveCount(0);
        await expect(page.locator('.page-error')).toHaveCount(0);
        expect(await page.evaluate(() => { window.retryRaceObserver.disconnect(); return window.retryRaceViolations; })).toEqual([]);
        await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      } finally { await fixture.close(); }
    });
  }
}

async function openDashboard(page) {
  await page.locator('.server-tabs').getByRole('button', { name: /Dashboard/u }).click();
  await expect(page.getByRole('heading', { name: 'Minecraft Server Control Panel' })).toBeVisible();
}

test('verification continuity restores off-route settled historical evidence without replay', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { holdVerifyOwner: true, largeVerification: true } });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    const started = await fixture.controlVerification({ kind: 'read' });
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(started.jobId);
    await openDashboard(page);
    await expect(dashboardRecovery(page)).toContainText('Operation in progress');
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await expect(dashboardStarts(page).nth(1)).toBeDisabled();
    await fixture.controlVerification({ kind: 'settle' });
    await expect(dashboardRecovery(page)).toContainText('Operation in progress');
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await fixture.controlVerification({ kind: 'release' });
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
    await expect(dashboardStarts(page).nth(1)).toBeEnabled();
    const beforeReturn = fixture.readState().lifecycleCalls.length;
    await fixture.openModpack();
    const summary = page.getByRole('region', { name: 'Last verification' });
    await expect(summary).toContainText(started.jobId);
    await expect(summary).toContainText('4,596 checked files · 147 differences');
    await expect(summary).toContainText('2026-08-01T12:00:00.000Z');
    await expect(summary).toContainText(`revision ${fixture.readState().state.contentRevision}`);
    await expect(summary).toContainText('historical observation, not a current integrity check');
    expect(fixture.readState().lifecycleCalls.slice(beforeReturn).find(call => call.method === 'getActiveJobs')).toMatchObject({ serverId: harness.SERVER_ID, itemsCount: 0 });
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toBeEnabled();
    const calls = fixture.readState().lifecycleCalls;
    expect(calls.filter(call => call.method === 'verify')).toHaveLength(1);
    expect(calls.filter(call => ['startOperation', 'createPlan', 'createManagementPlan', 'cancelJob'].includes(call.method))).toEqual([]);
    expect(fixture.readState().safeActions).toEqual([]);
  } finally { await fixture.close(); }
});

test('verification continuity permits fresh Review repair before any verification without planning', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Review repair', exact: true }).click();
    await expect(page.getByRole('button', { name: /Local archive/u })).toBeVisible();
    expect(fixture.readState().lifecycleCalls.filter(call => ['verify', 'createPlan', 'createManagementPlan', 'startOperation'].includes(call.method))).toEqual([]);
  } finally { await fixture.close(); }
});

async function startFixtureVerification(fixture) {
  const { page } = fixture;
  await fixture.openModpack();
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'verify').length).toBeGreaterThan(0);
  return fixture.controlVerification({ kind: 'read' });
}

test('historical summary layout keeps 64 samples collapsed, exact and keyboard accessible without actions', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { historicalVerificationSamples: 64 } });
  try {
    const { page } = fixture;
    const rendererErrors = [];
    page.on('pageerror', error => rendererErrors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) rendererErrors.push(message.text()); });
    await page.setViewportSize({ width: 800, height: 600 });
    const job = await startFixtureVerification(fixture);
    await openDashboard(page);
    await fixture.openModpack();
    const history = page.getByRole('region', { name: 'Last verification', exact: true });
    const details = history.locator('details');
    const summary = details.locator('summary');
    const rows = history.locator('ul[aria-label="Historical managed file differences"] li');
    await expect(details).toHaveCount(1);
    await expect(details).not.toHaveAttribute('open');
    await expect(rows).toHaveCount(64);
    await expect(rows.first()).not.toBeVisible();
    for (const text of [job.jobId, '2026-08-01T12:00:00.000Z', 'revision 1', '4,596 checked files · 148 differences',
      'historical observation, not a current integrity check', 'Review repair checks the installed source and current files again']) {
      await expect(history.getByText(text, { exact: false }).last()).toBeVisible();
    }
    const closedHeight = (await history.boundingBox()).height;
    console.log(`Historical card 800x600: ${closedHeight} CSS px closed, 64 samples`);
    expect(closedHeight).toBeLessThanOrEqual(240);
    const tabs = page.getByRole('navigation', { name: 'Modpack sections' });
    expect((await tabs.boundingBox()).y - (await history.boundingBox()).y).toBeLessThanOrEqual(260);
    await expect(page.locator('[data-verification-history] :focus')).toHaveCount(0);
    await expect(page).toHaveTitle('Minecraft Core');
    expect(page.url()).toMatch(/^(?:http:\/\/127\.0\.0\.1:5173\/|file:\/\/\/.*\/dist\/index\.html)/u);
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'minecraft-core-history-closed-800x600.png') });
    const actionsBefore = fixture.readState().lifecycleCalls.filter(call => !['getActiveJobs', 'getState', 'listHistory', 'getJob'].includes(call.method));
    await summary.focus();
    await summary.press('Enter');
    await expect(details).toHaveAttribute('open', '');
    await expect(rows.first()).toBeVisible();
    await expect(rows.last()).toBeVisible();
    await expect(history.getByText('Showing 64 differences; 84 additional differences are not listed.')).toBeVisible();
    await expect(summary).toBeFocused();
    await summary.press('Space');
    await expect(details).not.toHaveAttribute('open');
    await expect(summary).toBeFocused();
    const beforeToggle = fixture.readState().lifecycleCalls.length;
    await summary.click();
    await expect(details).toHaveAttribute('open', '');
    await summary.click();
    await expect(details).not.toHaveAttribute('open');
    expect(fixture.readState().lifecycleCalls.slice(beforeToggle)).toEqual([]);
    expect(fixture.readState().lifecycleCalls.filter(call => !['getActiveJobs', 'getState', 'listHistory', 'getJob'].includes(call.method))).toEqual(actionsBefore);
    expect(fixture.readState().safeActions).toEqual([]);
    await summary.click();
    // A same-attempt read temporarily replaces completed markup with loading.
    await fixture.controlVerification({ kind: 'own', jobId: job.jobId });
    await fixture.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('modpacks:state-changed', { instanceId: 'server-e2e' }));
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(job.jobId);
    await fixture.controlVerification({ kind: 'queue-read', jobId: job.jobId, reply: { hold: true } });
    await fixture.controlVerification({ kind: 'release' });
    await expect(history).toContainText('Loading historical verification evidence');
    const held = fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationReadEntered').at(-1);
    await fixture.controlVerification({ kind: 'release-read', readId: held.readId });
    await expect(details).toHaveAttribute('open', '');
    await openDashboard(page);
    await fixture.openModpack();
    await expect(details).not.toHaveAttribute('open');
    await summary.click();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(history).toContainText('verify-2');
    await expect(details).not.toHaveAttribute('open');
    await expect(page.locator('section.outcome')).toBeFocused();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(rendererErrors).toEqual([]);
  } finally { await fixture.close(); }
});

test('historical summary layout closed height is sample independent and long exact labels wrap', async () => {
  const heights = [];
  for (const samples of [1, 64]) {
    const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { historicalVerificationSamples: samples } });
    try {
      const { page } = fixture;
      await page.setViewportSize({ width: 800, height: 600 });
      await startFixtureVerification(fixture);
      await openDashboard(page);
      await fixture.openModpack();
      const history = page.getByRole('region', { name: 'Last verification', exact: true });
      await expect(history.locator('details')).toHaveCount(1);
      heights.push((await history.boundingBox()).height);
      await expect(page.getByRole('button', { name: 'Actions', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Versions', exact: true })).toBeVisible();
    } finally { await fixture.close(); }
  }
  expect(Math.abs(heights[0] - heights[1])).toBeLessThanOrEqual(2);
  console.log(`Historical card closed heights at 800x600: one=${heights[0]}, 64=${heights[1]} CSS px`);
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { historicalVerificationSamples: 64, longVerificationLabels: true } });
  try {
    const { page } = fixture;
    await page.setViewportSize({ width: 800, height: 600 });
    const job = await startFixtureVerification(fixture);
    await openDashboard(page);
    await fixture.openModpack();
    const history = page.getByRole('region', { name: 'Last verification', exact: true });
    await expect(history).toContainText(job.jobId);
    await history.locator('summary').click();
    await expect(history.getByRole('list').locator('li').first()).toHaveText(`config/${'long-unbroken-label-'.repeat(30)}.cfg — modified (pack · config)`);
    expect(await history.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await history.getByRole('list').locator('li').first().evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: path.join(os.tmpdir(), 'minecraft-core-history-expanded-800x600.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await history.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(os.tmpdir(), 'minecraft-core-history-expanded-390x844.png') });
  } finally { await fixture.close(); }
});

for (const healthy of [false, true]) test(`historical summary layout ${healthy ? 'healthy' : 'omitted-only'} zero samples has no empty disclosure`, async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { historicalVerificationSamples: 0, healthyVerification: healthy } });
  try {
    const { page } = fixture;
    await startFixtureVerification(fixture);
    await openDashboard(page);
    await fixture.openModpack();
    const history = page.getByRole('region', { name: 'Last verification', exact: true });
    await expect(history).toContainText(healthy ? 'healthy at verification time' : 'Showing 0 differences; 148 additional differences are not listed.');
    await expect(history.locator('details')).toHaveCount(0);
    await expect(history).toContainText('not a current integrity check');
  } finally { await fixture.close(); }
});

for (const fast of [false, true]) test(`verification continuity preserves ${fast ? 'fast queued' : 'local'} completion through Back and actual route destruction`, async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { fastVerify: fast } });
  try {
    const { page } = fixture;
    const job = await startFixtureVerification(fixture);
    await expect(page.locator('section.outcome').getByRole('heading', { name: 'Differences found' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await page.getByRole('button', { name: 'Back to Modpack overview', exact: true }).click();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toBeEnabled();
    await openDashboard(page);
    await fixture.openModpack();
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'verify')).toHaveLength(1);
  } finally { await fixture.close(); }
});

test('verification continuity healthy history remains historical through source revision and inactive state changes', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { healthyVerification: true } });
  try {
    const { page } = fixture;
    const job = await startFixtureVerification(fixture);
    const summary = page.getByRole('region', { name: 'Last verification', exact: true });
    await expect(summary).toContainText('healthy at verification time');
    await page.getByRole('button', { name: 'Back to Modpack overview', exact: true }).click();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toBeEnabled();
    await openDashboard(page);
    const original = fixture.readState().state;
    fixture.editManagedFixtureFile();
    expect(fixture.readState().state.contentRevision).toBe(original.contentRevision);
    await fixture.openModpack();
    await expect(summary).toContainText('not a current integrity check');
    await expect(summary).toContainText(`revision ${original.contentRevision}`);
    await openDashboard(page);
    fixture.updateScenario({ state: { ...original, contentRevision: original.contentRevision + 1, source: { ...original.source, version: 'changed-source' } } });
    await fixture.openModpack();
    await expect(summary).toContainText(job.jobId);
    await expect(summary).toContainText(`revision ${original.contentRevision}`);
    await expect(summary).toContainText('not a current integrity check');
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toBeEnabled();
    await openDashboard(page);
    fixture.updateScenario({ state: { ...original, modpackManaged: false, lifecycleMode: 'detached' } });
    await fixture.openModpack();
    await expect(summary).toContainText(job.jobId);
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toHaveCount(0);
    expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'verify')).toHaveLength(1);
  } finally { await fixture.close(); }
});

for (const terminalPhase of ['failed', 'cancelled']) test(`verification continuity a newer ${terminalPhase} attempt never revives a prior successful result`, async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    const older = await startFixtureVerification(fixture);
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(older.jobId);
    await page.getByRole('button', { name: 'Back to Modpack overview', exact: true }).click();
    fixture.updateScenario({ refreshFixture: { holdVerifyOwner: true } });
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    const newer = await fixture.controlVerification({ kind: 'read' });
    await fixture.controlVerification({ kind: 'settle', phase: terminalPhase });
    await fixture.controlVerification({ kind: 'release' });
    await openDashboard(page);
    await fixture.openModpack();
    const summary = page.getByRole('region', { name: 'Last verification attempt', exact: true });
    await expect(summary).toContainText(newer.jobId);
    await expect(summary).toContainText(`— ${terminalPhase} at`);
    await expect(summary.locator('details')).toHaveCount(0);
    await expect(summary).not.toContainText('checked files');
    await expect(summary).not.toContainText(older.jobId);
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toBeEnabled();
    expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'verify')).toHaveLength(2);
  } finally { await fixture.close(); }
});

for (const variant of ['missing', 'rejected', 'foreign-server', 'foreign-job', 'wrong-kind', 'bad-count']) test(`verification continuity ${variant} evidence is locally unavailable without changing safe Starts`, async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    const job = await startFixtureVerification(fixture);
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await openDashboard(page);
    const bad = structuredClone(job);
    if (variant === 'foreign-server') bad.serverId = 'foreign';
    if (variant === 'foreign-job') bad.jobId = 'foreign';
    if (variant === 'wrong-kind') bad.operationKind = 'repair';
    if (variant === 'bad-count') bad.outcome.result.checkedFiles = '0002';
    await fixture.controlVerification({ kind: 'queue-read', jobId: job.jobId, reply: variant === 'rejected' ? { fail: true } : { value: variant === 'missing' ? null : bad } });
    await fixture.openModpack();
    const summary = page.getByRole('region', { name: 'Last verification attempt', exact: true });
    await expect(summary).toContainText('Historical verification evidence is unavailable');
    await expect(summary.locator('details')).toHaveCount(0);
    await expect(summary.getByRole('button', { name: 'Retry historical read' })).toBeVisible();
    await expect(summary).not.toContainText('checked files');
    await expect(page.locator('.page-error')).toHaveCount(0);
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Review repair', exact: true }).click();
    await expect(page.getByRole('button', { name: /Local archive/u })).toBeVisible();
    await openDashboard(page);
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
    await expect(dashboardStarts(page).nth(1)).toBeEnabled();
    expect(fixture.readState().lifecycleCalls.filter(call => ['createPlan', 'startOperation', 'createManagementPlan'].includes(call.method))).toEqual([]);
  } finally { await fixture.close(); }
});

test('verification continuity historical evidence stays visible beside unavailable current activity', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    const job = await startFixtureVerification(fixture);
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await openDashboard(page);
    fixture.updateScenario({ refreshFixture: { activeFailureIds: [harness.SERVER_ID] } });
    await fixture.openModpack();
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await expect(page.locator('.modpack-page strong').filter({ hasText: /^Operation status unavailable$/u })).toBeVisible();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toHaveCount(0);
    await openDashboard(page);
    await expect(dashboardStarts(page).nth(0)).toBeDisabled();
    await expect(dashboardStarts(page).nth(1)).toBeDisabled();
  } finally { await fixture.close(); }
});

for (const startFailure of ['rejected', 'malformed']) for (const fail of [false, true]) {
  test(`verification continuity resumes history after ${startFailure} Verify start and stale historical ${fail ? 'rejection' : 'success'}`, async () => {
    const fixture = await harness.launchModpackApp({ profile: 'managed' });
    try {
      const { page } = fixture;
      const old = await startFixtureVerification(fixture);
      await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(old.jobId);
      await openDashboard(page);
      const stale = structuredClone(old); stale.outcome.result.checkedFiles = '1111';
      await fixture.controlVerification({ kind: 'queue-read', jobId: old.jobId, reply: { hold: true, fail, value: stale } });
      await fixture.openModpack();
      await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationReadEntered').length).toBe(1);
      const held = fixture.readState().lifecycleCalls.find(call => call.method === 'heldVerificationReadEntered');
      await expect(page.getByRole('region', { name: /^Last verification/u })).toContainText('Loading historical verification evidence');
      fixture.updateScenario({ refreshFixture: { verifyStartFailure: startFailure } });
      await page.evaluate(() => {
        window.failedStartHistoryViolations = [];
        window.failedStartHistoryObserver = new MutationObserver(() => {
          const history = document.querySelector('[data-verification-history]')?.textContent;
          if (history?.includes('1,111 checked files')) {
            window.failedStartHistoryViolations.push('obsolete evidence');
          }
          if (history?.includes('Historical verification evidence is unavailable')) window.failedStartHistoryViolations.push('obsolete rejection');
        });
        window.failedStartHistoryObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      await page.getByRole('button', { name: 'Actions', exact: true }).click();
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(page.locator('.page-error')).toBeVisible();
      const currentError = await page.locator('.page-error').textContent();
      await fixture.controlVerification({ kind: 'release-read', readId: held.readId });
      await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationReadReleased').length).toBe(1);
      await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText('2 checked files');
      await page.waitForTimeout(100);
      expect(await page.locator('.page-error').textContent()).toBe(currentError);
      await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toHaveCount(0);
      expect(await page.evaluate(() => { window.failedStartHistoryObserver.disconnect(); return window.failedStartHistoryViolations; })).toEqual([]);
      expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'verify')).toHaveLength(2);
      await openDashboard(page);
      await expect(dashboardStarts(page).nth(0)).toBeEnabled();
      await expect(dashboardStarts(page).nth(1)).toBeEnabled();
      await fixture.openModpack();
      await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(old.jobId);
    } finally { await fixture.close(); }
  });
}

for (const scope of ['A-B-A', 'destroyed', 'newer-verify', 'non-verify', 'explicit-owner']) for (const fail of [false, true]) {
  test(`verification continuity ignores held historical ${fail ? 'rejection' : 'success'} after ${scope}`, async () => {
    const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { holdRepairOwner: true },
      secondaryServerState: { schemaVersion: 1, modpackManaged: false, lifecycleMode: 'unmanaged', source: null, runtime: null, installedAt: null, contentRevision: 0, managedFileCount: 0 } });
    try {
      const { page } = fixture;
      const old = await startFixtureVerification(fixture);
      await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(old.jobId);
      const stale = structuredClone(old); stale.outcome.result.checkedFiles = '1111';
      await openDashboard(page);
      await fixture.controlVerification({ kind: 'queue-read', jobId: old.jobId, reply: { hold: true, fail, value: stale } });
      await fixture.openModpack();
      await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationReadEntered').length).toBe(1);
      const held = fixture.readState().lifecycleCalls.find(call => call.method === 'heldVerificationReadEntered');
      let expectedJob = old.jobId;
      if (scope === 'destroyed') {
        await openDashboard(page);
      } else if (scope === 'A-B-A') {
        await page.getByRole('button', { name: '☰' }).click();
        await page.locator('.instance-item').filter({ hasText: 'E2E Secondary Server' }).click();
        await expect(page.getByRole('region', { name: /^Last verification/u })).toHaveCount(0);
        await page.locator('.instance-item').filter({ hasText: 'E2E Fixture Server' }).click();
        await page.getByRole('button', { name: '☰' }).click();
        await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(old.jobId);
      } else if (scope === 'newer-verify') {
        await page.getByRole('button', { name: 'Actions', exact: true }).click();
        await page.getByRole('button', { name: 'Verify', exact: true }).click();
        expectedJob = (await fixture.controlVerification({ kind: 'read' })).jobId;
        await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(expectedJob);
      } else {
        await page.getByRole('button', { name: 'Actions', exact: true }).click();
        await page.getByRole('button', { name: 'Review repair', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText('2 checked files');
        await page.getByRole('button', { name: /Local archive/u }).click();
        await startReviewedArchive(page);
        const repair = await fixture.controlHeldRepair({ kind: 'read' });
        await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(repair.jobId);
        if (scope === 'explicit-owner') {
          await fixture.controlHeldRepair({ kind: 'duplicate-owner' });
          const owned = page.getByRole('region', { name: 'Owned operations' });
          await expect(owned.getByRole('button')).toHaveCount(2);
          await expect(page.getByRole('region', { name: /^Last verification/u })).not.toContainText('second-owned-verify');
          await owned.getByRole('button', { name: /second-owned-verify/u }).click();
          expectedJob = 'second-owned-verify';
          await expect(page.getByRole('region', { name: 'Last verification attempt', exact: true })).toContainText(expectedJob);
          await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(expectedJob);
        }
        await expect(page.getByRole('button', { name: 'Review repair', exact: true })).toHaveCount(0);
      }
      await page.evaluate(() => {
        window.verificationRaceViolations = [];
        window.verificationRaceObserver = new MutationObserver(() => {
          const root = document.querySelector('.modpack-page');
          if (root?.textContent?.includes('1,111 checked files')) window.verificationRaceViolations.push('obsolete evidence');
          if (root?.querySelector('.page-error')) window.verificationRaceViolations.push('historical error took current surface');
          if (root?.textContent?.includes('Historical verification evidence is unavailable')) window.verificationRaceViolations.push('obsolete rejection');
        });
        window.verificationRaceObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      await fixture.controlVerification({ kind: 'release-read', readId: held.readId });
      await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationReadReleased').length).toBe(1);
      await page.waitForTimeout(150);
      if (scope === 'destroyed') await fixture.openModpack();
      await expect(page.getByRole('region', { name: /^Last verification/u })).toContainText(expectedJob);
      expect(await page.evaluate(() => { window.verificationRaceObserver.disconnect(); return window.verificationRaceViolations; })).toEqual([]);
    } finally { await fixture.close(); }
  });
}

test('verification continuity renderer reload loses memory hints without replay despite a durable record', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    const job = await startFixtureVerification(fixture);
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await page.reload();
    if (!(await page.getByRole('heading', { name: 'Modpack', exact: true }).isVisible())) await fixture.openModpack();
    await expect(page.getByRole('navigation', { name: 'Modpack sections' })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Last verification/u })).toHaveCount(0);
    const durable = await page.evaluate(jobId => window.electron.invoke('modpacks:get-job', { jobId }), job.jobId);
    expect(durable).toMatchObject({ ok: true, value: { jobId: job.jobId, phase: 'completed' } });
    expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'verify')).toHaveLength(1);
  } finally { await fixture.close(); }
});

test('verification continuity a destroyed page cannot remember its late start over a newer attempt', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { holdVerifyOwner: true, holdFirstVerifyResponse: true } });
  try {
    const { page } = fixture;
    const old = await startFixtureVerification(fixture);
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationStartEntered').length).toBe(1);
    await openDashboard(page);
    await fixture.controlVerification({ kind: 'settle', jobId: old.jobId });
    await fixture.controlVerification({ kind: 'release', jobId: old.jobId });
    await expect(dashboardStarts(page).nth(0)).toBeEnabled();
    await fixture.openModpack();
    await expect(page.getByRole('region', { name: /^Last verification/u })).toHaveCount(0);
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    const newer = await fixture.controlVerification({ kind: 'read' });
    await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toContainText(newer.jobId);
    await fixture.controlVerification({ kind: 'release-start', jobId: old.jobId });
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationStartReleased').length).toBe(1);
    await expect(page.getByRole('region', { name: 'Last verification attempt', exact: true })).toContainText(newer.jobId);
    await fixture.controlVerification({ kind: 'settle', jobId: newer.jobId });
    await fixture.controlVerification({ kind: 'release', jobId: newer.jobId });
    await openDashboard(page);
    await fixture.openModpack();
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(newer.jobId);
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).not.toContainText(old.jobId);
    expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'verify')).toHaveLength(2);
  } finally { await fixture.close(); }
});

test('verification continuity restored evidence still requires fresh repair inspection preflight and explicit Start', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed' });
  try {
    const { page } = fixture;
    const job = await startFixtureVerification(fixture);
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await openDashboard(page);
    await fixture.openModpack();
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Review repair', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Choose where the pack is published', exact: true })).toBeFocused();
    expect(fixture.readState().lifecycleCalls.filter(call => ['createPlan', 'createManagementPlan', 'startOperation'].includes(call.method))).toEqual([]);
    await page.getByRole('button', { name: /Local archive/u }).click();
    await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible();
    expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'startOperation')).toEqual([]);
    await startReviewedArchive(page);
    await expectCompleted(page);
    const calls = fixture.readState().lifecycleCalls;
    expect(calls.filter(call => call.method === 'createPlan')).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedOperationKind: 'repair' })
    ]));
    expect(calls.filter(call => call.method === 'startOperation')).toEqual([expect.objectContaining({ operationKind: 'repair' })]);
    expect(calls.some(call => call.method === 'createManagementPlan')).toBe(false);
    expect(calls.filter(call => call.method === 'verify')).toHaveLength(1);
  } finally { await fixture.close(); }
});

test('verification continuity post-invocation stale repair rejection remains unknown without a duplicate Start', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { rejectFirstRepairStart: true } });
  try {
    const { page } = fixture;
    const job = await startFixtureVerification(fixture);
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await openDashboard(page);
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Review repair', exact: true }).click();
    await page.getByRole('button', { name: /Local archive/u }).click();
    await startReviewedArchive(page);
    await expect(page.getByText(/Start outcome is unknown/u).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start reviewed operation', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Run a fresh preflight review', exact: true })).toHaveCount(0);
    // Repeated activation cannot convert an invoked error into permission to
    // retry Start; the renderer has no authoritative no-start evidence.
    await page.getByRole('button', { name: 'Start reviewed operation', exact: true }).evaluate(button => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect(page.getByRole('button', { name: 'Start reviewed operation', exact: true })).toBeDisabled();
    const rejected = fixture.readState().lifecycleCalls;
    expect(rejected.filter(call => call.method === 'startOperation')).toEqual([]);
    expect(rejected.filter(call => call.method === 'startOperationRejected')).toEqual([
      expect.objectContaining({ operationKind: 'repair', code: 'PLAN_STALE' })
    ]);
    expect(rejected.filter(call => call.method === 'verify')).toHaveLength(1);
  } finally { await fixture.close(); }
});

test('verification continuity pre-invocation stale repair preflight requires fresh review before its only Start', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { rejectFirstRepairPreflight: true } });
  try {
    const { page } = fixture;
    const job = await startFixtureVerification(fixture);
    await expect(page.getByRole('region', { name: 'Last verification', exact: true })).toContainText(job.jobId);
    await openDashboard(page);
    await fixture.openModpack();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Review repair', exact: true }).click();
    await page.getByRole('button', { name: /Local archive/u }).click();
    await page.getByRole('button', { name: 'Review planned changes', exact: true }).click();
    await expect(page.getByText('Reviewed plan needs to be refreshed', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review planned changes', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Start reviewed operation', exact: true })).toHaveCount(0);
    const rejected = fixture.readState().lifecycleCalls;
    expect(rejected.filter(call => call.method === 'startOperation')).toEqual([]);
    expect(rejected.filter(call => call.method === 'createPlanRejected')).toEqual([
      expect.objectContaining({ operationKind: 'repair', code: 'PLAN_STALE' })
    ]);
    await page.getByRole('button', { name: 'Run a fresh preflight review', exact: true }).click();
    await expect(page.getByRole('button', { name: /Local archive/u })).toBeVisible();
    await page.getByRole('button', { name: /Local archive/u }).click();
    await startReviewedArchive(page);
    await expectCompleted(page);
    const calls = fixture.readState().lifecycleCalls;
    expect(calls.filter(call => call.method === 'createPlan' && call.planId)).toHaveLength(1);
    expect(calls.filter(call => call.method === 'startOperation')).toEqual([expect.objectContaining({ operationKind: 'repair' })]);
    expect(calls.filter(call => call.method === 'verify')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'createManagementPlan')).toEqual([]);
  } finally { await fixture.close(); }
});

test('verification continuity same-pair explicit owner selection refreshes invalidated hydration without a loop', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'managed', refreshFixture: { holdRepairOwner: true } });
  try {
    const { page } = fixture;
    const repair = await startHeldRepair(fixture);
    const original = await fixture.controlVerification({ kind: 'read' });
    // A nonterminal defensive snapshot must remain an attempt, not old counts.
    await fixture.controlVerification({ kind: 'set-job', jobId: original.jobId, value: { ...original, phase: 'queued', terminalAt: null, outcome: null } });
    await fixture.controlVerification({ kind: 'own', jobId: original.jobId });
    await openDashboard(page);
    for (let index = 0; index < 2; index++) await fixture.controlVerification({ kind: 'queue-read', jobId: original.jobId, reply: { hold: true } });
    await fixture.openModpack();
    const owned = page.getByRole('region', { name: 'Owned operations' });
    await expect(owned.getByRole('button')).toHaveCount(2);
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationReadEntered').length).toBe(1);
    await owned.getByRole('button', { name: new RegExp(repair.jobId, 'u') }).click();
    await expect.poll(() => fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationReadEntered').length).toBe(2);
    await owned.getByRole('button', { name: new RegExp(original.jobId, 'u') }).click();
    const summary = page.getByRole('region', { name: 'Last verification attempt', exact: true });
    await expect(summary).toContainText('had not completed when read');
    await expect(summary.locator('details')).toHaveCount(0);
    await expect(summary).not.toContainText('checked files');
    const before = fixture.readState().lifecycleCalls.filter(call => call.method === 'getJob' && call.jobId === original.jobId).length;
    await owned.getByRole('button', { name: new RegExp(original.jobId, 'u') }).click();
    await owned.getByRole('button', { name: new RegExp(original.jobId, 'u') }).click();
    await page.waitForTimeout(150);
    expect(fixture.readState().lifecycleCalls.filter(call => call.method === 'getJob' && call.jobId === original.jobId).length).toBe(before);
    for (const held of fixture.readState().lifecycleCalls.filter(call => call.method === 'heldVerificationReadEntered')) {
      await fixture.controlVerification({ kind: 'release-read', readId: held.readId });
    }
    await expect(summary).toContainText('had not completed when read');
  } finally { await fixture.close(); }
});

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
    for (const unavailable of ['Verify', 'Review repair', 'Choose restore point', 'Review detach', 'Review uninstall']) {
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
