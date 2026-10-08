import { expect, test } from '@playwright/test';
import harness from './fixtures/real-modpack-harness.cjs';

const RENDERED_UI_ENV = 'MINECRAFT_CORE_REAL_MODPACK_RENDERED_UI_E2E';
const LIVE_CATALOG_TIMEOUT_MS = 120_000;
const enabled = ['1', 'true'].includes(String(process.env[RENDERED_UI_ENV] || '').trim().toLowerCase());

async function openFreshServerSetup(page) {
  await page.getByRole('button', { name: /Create Your First Instance/u }).click();
  await page.getByRole('button', { name: /Server Manager/u }).click();
  await page.getByRole('button', { name: 'Install Modpack' }).click();
  await page.getByRole('button', { name: /Browse Modrinth/u }).click();
  await expect(page.getByRole('heading', { name: 'Browse server modpacks' })).toBeVisible();
}

test.describe('real rendered Modrinth setup', () => {
  test.skip(!enabled, `Set ${RENDERED_UI_ENV}=1 to run the production-Electron rendered Modrinth setup proof.`);

  test('renders unfiltered exact versions and reviews v2-1.21.1 without installing', async ({}, testInfo) => {
    test.setTimeout(45 * 60_000);
    const lifecycle = await harness.createIsolatedRealLifecycle({
      scratchLabel: 'modrinth-rendered-ui',
      identity: { provider: 'modrinth', scenario: 'rendered-setup-review' }
    });
    let electronApp = null;
    let page = null;
    let restoreDestinationDialog = null;
    let completed = false;

    try {
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      await openFreshServerSetup(page);

      const search = page.getByRole('search', { name: 'Search Modrinth modpacks' });
      await expect(search.getByLabel('Minecraft version')).toHaveValue('');
      await expect(search.getByLabel('Loader')).toHaveValue('');
      await search.getByLabel('Search').fill('Server Optimized');
      await search.getByRole('button', { name: 'Search' }).click();
      const catalogResults = page.locator('section[aria-busy]');
      await expect(catalogResults).toHaveAttribute('aria-busy', 'false', { timeout: LIVE_CATALOG_TIMEOUT_MS });
      await expect(page.getByText(/^\d+ matching modpacks$/u)).toBeVisible();
      const nextPage = catalogResults.getByRole('button', { name: 'Next', exact: true });
      await expect(nextPage).toHaveCount(1);
      const serverOptimizedTitle = catalogResults.getByText('Server Optimized', { exact: true });
      let foundProject = await serverOptimizedTitle.isVisible().catch(() => false);
      for (let pageNumber = 1; !foundProject && pageNumber < 20; pageNumber += 1) {
        if (await nextPage.isDisabled()) break;
        await nextPage.click();
        await expect(catalogResults).toHaveAttribute('aria-busy', 'false', { timeout: LIVE_CATALOG_TIMEOUT_MS });
        foundProject = await serverOptimizedTitle.isVisible().catch(() => false);
      }
      expect(foundProject, 'Server Optimized should appear in the live Modrinth results').toBe(true);
      await serverOptimizedTitle.click();

      await expect(page.getByRole('heading', { name: 'Server Optimized' })).toBeVisible();
      await expect(page.getByText('Exact version history', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^v1\.2-1\.20\.1\b/u })).toBeVisible();
      const exact1211 = page.getByRole('button', { name: /^v2-1\.21\.1\b/u });
      await expect(exact1211).toBeVisible();

      await exact1211.click();
      await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible({ timeout: 15 * 60_000 });

      restoreDestinationDialog = await harness.installIsolatedServerDestinationDialogOverride(electronApp, lifecycle);
      await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
      await expect(page.getByText('Exact reviewed plan', { exact: true })).toBeVisible({ timeout: 5 * 60_000 });
      await expect(page.getByRole('button', { name: 'Install this exact reviewed plan' })).toBeVisible();

      completed = true;
    } finally {
      await harness.finalizeIsolatedRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        closeAndAudit: async (ownedElectronApp, isolatedLifecycle) => {
          try {
            await restoreDestinationDialog?.();
          } finally {
            await harness.closeProductionElectronAndAudit(ownedElectronApp, isolatedLifecycle);
          }
        },
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-rendered-modrinth-ui-failure-evidence.json',
          harness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
    }
  });
});
