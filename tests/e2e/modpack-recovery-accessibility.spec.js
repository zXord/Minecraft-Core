import { expect, test } from '@playwright/test';
import harness from './fixtures/modpack-harness.cjs';

for (const crashPoint of ['before-live-rename', 'between-renames', 'after-candidate-rename']) {
  test(`startup blocks and idempotently recovers the ${crashPoint} publication boundary`, async () => {
    const fixture = await harness.launchModpackApp({ profile: 'recovery', crashPoint });
    try {
      await fixture.openModpack();
      const originalServerTreeHash = fixture.serverTreeHash();
      const { page } = fixture;
      await page.getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('button', { name: 'Choose restore point' }).click();
      await page.getByRole('button', { name: /install existing restore point/u }).click();
      await page.getByRole('button', { name: 'Start reviewed operation' }).click();
      await expect(page.getByRole('progressbar', { name: 'Committing directory swap' })).not.toHaveAttribute('aria-valuenow');
      await expect.poll(() => fixture.readState().crashMarker).toBe(crashPoint);

      await fixture.kill();
      await fixture.relaunch();
      await fixture.openModpack();
      await expect(fixture.page.getByText('Interrupted directory publication', { exact: true })).toBeVisible();
      await expect(fixture.page.getByText(new RegExp(crashPoint, 'u'))).toBeVisible();
      expect(fixture.readState()).toMatchObject({ startupBlockedObserved: true });
      expect(fixture.readState().recovery).toHaveLength(1);

      await fixture.page.getByRole('button', { name: 'Versions' }).click();
      await fixture.page.getByRole('button', { name: 'Load exact version history' }).click();
      await fixture.page.getByRole('button', { name: /^2\.0\.0/u }).click();
      const blockedError = fixture.page.locator('section.page-error');
      await expect(blockedError.getByText('RECOVERY_REQUIRED', { exact: true })).toBeVisible();
      await expect(blockedError).toBeFocused();
      await fixture.page.getByRole('button', { name: 'Dismiss' }).click();

      await fixture.page.getByRole('button', { name: 'Recover safely' }).click();
      await expect.poll(() => fixture.readState().recovery.length).toBe(0);
      expect(fixture.canonicalCount()).toBe(1);
      expect(fixture.serverTreeHash()).toBe(originalServerTreeHash);
      expect(fixture.readState().recoveryRuns).toBe(1);
      for (const preserved of ['mods/user-added.jar', 'config/user.cfg', 'world/level.dat']) {
        expect(fixture.serverFileExists(preserved), `${preserved} should survive recovery`).toBe(true);
      }

      await fixture.relaunch();
      await fixture.openModpack();
      expect(fixture.readState().recovery).toHaveLength(0);
      expect(fixture.readState().recoveryRuns).toBe(1);
      expect(fixture.canonicalCount()).toBe(1);
      expect(fixture.serverTreeHash()).toBe(originalServerTreeHash);
      await expect(fixture.page.getByText('Interrupted directory publication', { exact: true })).toHaveCount(0);
    } finally {
      await fixture.close();
    }
  });
}

test('keyboard-only setup moves focus through stages, announces progress, and focuses errors/results', async () => {
  const fixture = await harness.launchModpackApp({ profile: 'unmanaged' });
  try {
    await fixture.openModpack();
    const { page } = fixture;
    const install = page.getByRole('button', { name: 'Install modpack' });
    await install.focus();
    await page.keyboard.press('Enter');

    const sourceHeading = page.getByRole('heading', { name: 'Choose where the pack is published' });
    await expect(sourceHeading).toBeFocused();
    await expect(page.getByText('CurseForge (Unavailable)', { exact: true })).toBeVisible();
    await expect(page.getByText('CurseForge browsing is unavailable in this build.', { exact: true })).toBeVisible();
    await expect(page.getByText(/Coming Soon|coming soon/u)).toHaveCount(0);
    await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();
    await expect(page.getByText('Available', { exact: true })).toHaveCount(3);

    const modrinth = page.getByRole('button', { name: /Browse Modrinth/u });
    await modrinth.focus();
    await page.keyboard.press('Space');
    const browseHeading = page.getByRole('heading', { name: 'Browse server modpacks' });
    await expect(browseHeading).toBeFocused();

    const project = page.getByRole('button', { name: /Fixture Factory Pack/u });
    await project.focus();
    await page.keyboard.press('Enter');
    const version = page.getByRole('button', { name: /^1\.0\.0/u });
    await version.focus();
    await page.keyboard.press('Enter');
    const inspectionHeading = page.getByRole('heading', { name: 'Inspect evidence before installation' });
    await expect(inspectionHeading).toBeFocused();

    await page.getByRole('button', { name: 'Back to Modpack overview' }).click();
    await page.getByRole('button', { name: 'Install modpack' }).click();
    await page.getByRole('button', { name: /GitHub Releases/u }).click();
    await page.getByLabel('Public repository or release URL').fill('https://github.com/FixtureOrg/FixturePack');
    await page.getByRole('button', { name: 'Load releases' }).click();
    await page.getByRole('button', { name: /Fixture Release v2/u }).click();
    await page.getByRole('radio', { name: /fixture-header-encrypted\.rar/u }).click();
    await page.getByRole('button', { name: 'Download and inspect selected asset' }).click();
    const pageError = page.locator('section.page-error');
    await expect(pageError.getByText('ENCRYPTED_ARCHIVE', { exact: true })).toBeVisible();
    await expect(pageError).toBeFocused();
    await page.getByRole('button', { name: 'Dismiss' }).click();

    await page.getByRole('button', { name: 'Back to Modpack overview' }).click();
    await page.getByRole('button', { name: 'Install modpack' }).click();
    await page.getByRole('button', { name: /Local archive/u }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Review planned changes' }).click();
    const eulaConsent = page.getByLabel('I accept the Minecraft EULA');
    await eulaConsent.focus();
    await page.keyboard.press('Space');
    await expect(eulaConsent).toBeChecked();
    const startReviewedOperation = page.getByRole('button', { name: 'Start reviewed operation' });
    await expect(startReviewedOperation).toBeEnabled();
    await startReviewedOperation.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('progressbar', { name: 'Downloading' })).not.toHaveAttribute('aria-valuenow');
    await expect(page.getByText('Verifying exact offline fixture bytes', { exact: true })).toHaveAttribute('aria-live', 'polite');
    const outcome = page.locator('section.outcome');
    await expect(outcome).toBeVisible();
    await expect(outcome).toBeFocused();
  } finally {
    await fixture.close();
  }
});
