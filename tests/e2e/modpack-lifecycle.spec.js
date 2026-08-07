import { expect, test } from '@playwright/test';
import harness from './fixtures/modpack-harness.cjs';

async function chooseModrinthFromOverview(page, version) {
  await page.getByRole('button', { name: 'Install modpack' }).click();
  await page.getByRole('radio', { name: /Modrinth/u }).click();
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
  if (downgrade) await page.getByLabel('I understand a world downgrade requires a compatible verified restore point.').check();
  await page.getByRole('button', { name: 'Run preflight review' }).click();
  const conflictReview = page.getByRole('region', { name: 'Conflict choices' });
  if (await conflictReview.isVisible().catch(() => false)) {
    await expect(conflictReview.getByText('User configuration override', { exact: true })).toBeVisible();
    await conflictReview.getByLabel('Resolution for User configuration override').selectOption('keep-mine');
    await page.getByRole('button', { name: 'Re-run preflight with conflict choices' }).click();
  }
  await page.getByRole('button', { name: 'Start reviewed operation' }).click();
}

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
    fixture = await harness.launchModpackApp({ profile: 'unmanaged' });
    await fixture.openModpack();
  });

  test.afterAll(async () => fixture?.close());

  test('install-existing can cancel before commit, then complete with a safe outcome action', async () => {
    const { page } = fixture;
    await chooseModrinthFromOverview(page, '1.0.0');
    await startReviewedArchive(page);
    await expect(page.getByRole('progressbar', { name: 'Downloading' })).toHaveAttribute('aria-valuenow', '35');
    await page.getByRole('button', { name: 'Cancel before commit' }).click();
    await expect(page.locator('section.outcome').getByRole('heading', { name: 'Nothing changed' })).toBeVisible();
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
      destination: { kind: 'details', targetId: expect.stringMatching(/^job-/u) }
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
    await page.getByLabel('I understand a world downgrade requires a compatible verified restore point.').check();
    await page.getByRole('button', { name: 'Run preflight review' }).click();
    await expect(page.getByText('No compatible verified world restore point exists for this downgrade.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start reviewed operation' })).toBeDisabled();
    await page.getByRole('button', { name: 'Back to Modpack overview' }).click();

    await chooseManagedVersion(page, '0.9.0');
    await startReviewedArchive(page, { downgrade: true });
    await expectCompleted(page);
    await returnToOverview(page);
    expect(fixture.readState().state.source).toMatchObject({ version: '0.9.0', versionId: 'version-downgrade-safe' });

    await page.getByRole('button', { name: 'Versions' }).click();
    await page.getByRole('button', { name: 'Switch modpack' }).click();
    await page.getByRole('radio', { name: /Local archive/u }).click();
    await expect(page.getByText('zip archive', { exact: true })).toBeVisible();
    await startReviewedArchive(page);
    await expectCompleted(page);
    await returnToOverview(page);
    expect(fixture.readState().state.source).toMatchObject({ provider: 'local', version: 'local-1' });
  });

  test('verify enables targeted repair and rollback restores an exact recorded point', async () => {
    const { page } = fixture;
    await page.getByRole('button', { name: 'Actions' }).click();
    const repair = page.getByRole('button', { name: 'Repair', exact: true });
    await expect(repair).toBeDisabled();
    await expect(page.getByText(/Repair is offered separately and only when managed content differs from the manifest\./u)).toBeVisible();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expectCompleted(page);
    await returnToOverview(page);

    await page.getByRole('button', { name: 'Actions' }).click();
    await expect(repair).toBeEnabled();
    await repair.click();
    await page.getByRole('radio', { name: /Local archive/u }).click();
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
    expect(beforeReturn.state).toMatchObject({ modpackManaged: false, lifecycleMode: 'unmanaged' });
    for (const kept of ['server.jar', 'mods/managed.jar', 'mods/user-added.jar', 'config/user.cfg', 'world/level.dat']) {
      expect(fixture.serverFileExists(kept), `${kept} should remain after detach`).toBe(true);
    }
    await returnToOverview(page);
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByRole('list').getByText('detach', { exact: true })).toBeVisible();
  });
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
  } finally {
    await fixture.close();
  }
});
