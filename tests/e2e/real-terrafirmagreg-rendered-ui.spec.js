import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import githubHarness from './fixtures/real-github-releases-harness.cjs';
import harness from './fixtures/real-modpack-harness.cjs';
import tfgFixture from './fixtures/real-terrafirmagreg-fixture.cjs';

const REAL_TFG_RENDERED_UI_ENV = 'MINECRAFT_CORE_REAL_TFG_RENDERED_UI_E2E';
const REAL_TFG = tfgFixture.REAL_TFG_RELEASES['0.13.4'];
const SERVERPACK = REAL_TFG.assets.find(asset => asset.kind === 'serverpack');
const GITHUB_TIMEOUT_MS = 2 * 60_000;
const INSPECTION_TIMEOUT_MS = 30 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 45 * 60_000;
const INSTALL_TIMEOUT_MS = 90 * 60_000;
const SERVER_READY_TIMEOUT_MS = 45 * 60_000;

function enabled(environment = process.env) {
  return ['1', 'true'].includes(
    String(environment[REAL_TFG_RENDERED_UI_ENV] || '').trim().toLowerCase()
  );
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function currentSetupStep(page) {
  return page.locator('nav[aria-label="Server setup progress"] [aria-current="step"]');
}

async function expectCurrentSetupStep(page, label) {
  const current = currentSetupStep(page);
  await expect(current).toHaveCount(1);
  await expect(current).toContainText(label);
}

async function assertVisibleProductionWindow(electronApp, page) {
  await expect.poll(async () => {
    const browserWindow = await electronApp.browserWindow(page);
    try {
      return await browserWindow.evaluate(window => {
        const destroyed = window.isDestroyed();
        return {
          destroyed,
          visible: !destroyed && window.isVisible()
        };
      });
    } finally {
      await browserWindow.dispose();
    }
  }, {
    message: 'The exact BrowserWindow driven by Playwright must be alive and visibly shown before UI signoff',
    timeout: 60_000
  }).toEqual({ destroyed: false, visible: true });
}

async function openGitHubServerSetup(page) {
  await expect(page.getByRole('heading', { name: 'Welcome to Minecraft Core' })).toBeVisible();
  await page.getByRole('button', { name: /Create Your First Instance/u }).click();
  const instanceDialog = page.getByRole('dialog');
  await expect(instanceDialog).toBeVisible();
  await instanceDialog.getByRole('button', { name: /Server Manager/u }).click();

  await expect(page.getByRole('heading', { name: 'How do you want to set it up?' })).toBeVisible();
  await expectCurrentSetupStep(page, 'Method');
  await page.getByRole('button', { name: 'Install Modpack' }).click();

  await expect(page.getByRole('heading', { name: 'Choose where the pack is published' })).toBeVisible();
  await expectCurrentSetupStep(page, 'Source');
  await page.getByRole('button', { name: /GitHub Releases/u }).click();

  await expect(page.getByRole('heading', { name: 'Choose an exact release' })).toBeVisible();
  await expectCurrentSetupStep(page, 'Version or asset');
}

function exactReleaseButton(page) {
  const history = page.getByRole('region', { name: 'GitHub release history' });
  const tagLine = new RegExp(`${escapeRegex(REAL_TFG.tagName)}\\s*·\\s*published`, 'u');
  return history.locator('li').filter({ hasText: tagLine }).getByRole('button');
}

async function selectExactRelease(page) {
  const history = page.getByRole('region', { name: 'GitHub release history' });
  await expect(history).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });

  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const release = exactReleaseButton(page);
    if (await release.isVisible().catch(() => false)) {
      await release.click();
      return;
    }

    const loadOlder = history.getByRole('button', { name: 'Load older releases' });
    if (!await loadOlder.isVisible().catch(() => false)) break;
    const previousRowCount = await history.locator('li').count();
    await loadOlder.click();
    await expect.poll(async () => {
      if (await exactReleaseButton(page).isVisible().catch(() => false)) return true;
      const nextRowCount = await history.locator('li').count();
      const stillHasNextPage = await loadOlder.isVisible().catch(() => false);
      return nextRowCount > previousRowCount || !stillHasNextPage;
    }, {
      message: `GitHub release page did not finish while locating ${REAL_TFG.tagName}`,
      timeout: GITHUB_TIMEOUT_MS
    }).toBe(true);
  }

  throw new Error(`The exact GitHub release ${REAL_TFG.tagName} was not present in the rendered release history`);
}

async function readOptionalText(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function logAppendedAfter(previous, current) {
  if (current === null) return '';
  if (previous === null) return current;
  if (current === previous) return '';
  return current.startsWith(previous) ? current.slice(previous.length) : current;
}

async function waitForFreshServerReadiness(status, latestLogPath, previousLog) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  let sawRunning = false;
  let lastStatus = '';
  while (Date.now() < deadline) {
    lastStatus = String(await status.textContent().catch(() => '')).trim();
    if (lastStatus === 'Running') sawRunning = true;
    const currentLog = await readOptionalText(latestLogPath);
    const freshLog = logAppendedAfter(previousLog, currentLog);
    if (sawRunning && /Done \([0-9.]+s\)!/u.test(freshLog)) return freshLog;
    if (sawRunning && lastStatus === 'Stopped') {
      throw new Error('The disposable TerraFirmaGreg server stopped before reporting Minecraft readiness');
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`The disposable TerraFirmaGreg server did not report readiness; last visible status: ${lastStatus || 'unknown'}`);
}

async function stopVisibleServerIfRunning(page) {
  if (!page || page.isClosed()) return;
  const controls = page.locator('.minecraft-server-section');
  if (!await controls.isVisible().catch(() => false)) return;
  const stop = controls.getByRole('button', { name: 'Stop', exact: true });
  if (!await stop.isEnabled().catch(() => false)) return;
  await stop.click();
  await expect(controls.locator('.status-value')).toHaveText('Stopped', { timeout: 5 * 60_000 });
}

test.describe('real rendered TerraFirmaGreg GitHub setup', () => {
  test.skip(
    !enabled(),
    `Set ${REAL_TFG_RENDERED_UI_ENV}=1 to run the production-Electron rendered ${REAL_TFG.tagName} lifecycle.`
  );

  test('installs 0.13.4 serverpack, adopts its validated live process, and stops it through the visible UI', async ({}, testInfo) => {
    test.setTimeout(3 * 60 * 60_000);
    const lifecycle = await harness.createIsolatedRealLifecycle({
      scratchLabel: 'tfg-0-13-4-live-handoff-rendered-ui',
      identity: {
        provider: 'github-releases',
        harness: 'real-terrafirmagreg-live-handoff-rendered-ui',
        releaseId: REAL_TFG.releaseId,
        tagName: REAL_TFG.tagName
      }
    });
    let electronApp = null;
    let page = null;
    let restoreDestinationDialog = null;
    let completed = false;
    let terminalAudit = null;

    try {
      expect(SERVERPACK).toMatchObject({
        assetId: '477754820',
        fileName: 'TerraFirmaGreg-Modern-0.13.4-serverpack.zip'
      });
      expect(fs.readdirSync(lifecycle.serverPath)).toEqual([]);

      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      await assertVisibleProductionWindow(electronApp, page);
      await expect(page).toHaveTitle(/Minecraft Core/u);
      await openGitHubServerSetup(page);

      await page.getByLabel('Public repository or release URL').fill(REAL_TFG.repositoryUrl);
      await page.getByRole('button', { name: 'Load releases' }).click();
      await selectExactRelease(page);

      const assetSelection = page.getByRole('radiogroup', { name: 'GitHub uploaded asset selection' });
      await expect(assetSelection).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
      const serverpack = assetSelection.getByRole('radio', {
        name: new RegExp(escapeRegex(SERVERPACK.fileName), 'u')
      });
      await serverpack.click();
      await expect(serverpack).toHaveAttribute('aria-checked', 'true');
      await expectCurrentSetupStep(page, 'Version or asset');

      await page.getByRole('button', { name: 'Download and inspect selected asset' }).click();
      await expect(page.getByRole('progressbar', { name: 'Downloading selected asset' })).toBeVisible({
        timeout: GITHUB_TIMEOUT_MS
      });
      await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible({
        timeout: INSPECTION_TIMEOUT_MS
      });
      await expectCurrentSetupStep(page, 'Review');
      await testInfo.attach('real-tfg-review.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });

      const maxRam = page.getByLabel(/Maximum server RAM/u);
      await maxRam.fill('6');
      await expect(maxRam).toHaveValue('6');
      const networkAccess = page.getByLabel('Network access');
      await networkAccess.selectOption('loopback');
      await expect(networkAccess).toHaveValue('loopback');
      const chooseDestination = page.getByRole('button', { name: 'Choose destination and review plan' });
      await expect(chooseDestination).toBeEnabled();

      restoreDestinationDialog = await harness.installIsolatedServerDestinationDialogOverride(electronApp, lifecycle);
      try {
        await chooseDestination.click();
        await expect(page.locator('p.destination-note').filter({ hasText: 'Chosen destination:' })).toContainText(
          'server',
          { timeout: GITHUB_TIMEOUT_MS }
        );
      } finally {
        await restoreDestinationDialog();
        restoreDestinationDialog = null;
      }

      await expect(page.locator('.preflight-status[role="status"]')).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
      await expect(page.getByText('Exact reviewed plan', { exact: true })).toBeVisible({
        timeout: PREFLIGHT_TIMEOUT_MS
      });
      await expect(page.getByRole('region', { name: 'Reviewed modpack plan' })).toBeVisible();

      const acceptEula = page.getByLabel('I accept the Minecraft EULA');
      const startAfterInstall = page.getByLabel('Start after install and validate final health');
      await acceptEula.check();
      await startAfterInstall.check();
      await expect(startAfterInstall).toBeChecked();

      const latestLogPath = path.join(lifecycle.serverPath, 'logs', 'latest.log');
      const previousLog = await readOptionalText(latestLogPath);

      const install = page.getByRole('button', { name: 'Install this exact reviewed plan' });
      await expect(install).toBeEnabled();
      await install.click();
      await expectCurrentSetupStep(page, 'Install');
      const jobProgress = page.getByRole('region', { name: 'Modpack operation progress' });
      await expect(jobProgress).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
      await expect(jobProgress.getByRole('progressbar')).toBeVisible();
      await testInfo.attach('real-tfg-install-progress.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });

      await expect(page.getByRole('heading', { name: 'Server Dashboard' })).toBeVisible({
        timeout: INSTALL_TIMEOUT_MS
      });
      await expect(currentSetupStep(page)).toHaveCount(0);

      const minecraftControls = page.locator('.minecraft-server-section');
      await expect(minecraftControls.getByRole('heading', { name: 'Minecraft Server' })).toBeVisible();
      const status = minecraftControls.locator('.status-value');
      await expect(
        status,
        'The install requested a live server, but the validated process was not adopted into the visible dashboard. Resolve any Windows Firewall prompt manually; this test never automates operating-system security dialogs.'
      ).toHaveText('Running', { timeout: 5 * 60_000 });
      const freshReadyLog = await waitForFreshServerReadiness(status, latestLogPath, previousLog);
      expect(freshReadyLog).toMatch(/Done \([0-9.]+s\)!/u);

      const start = minecraftControls.getByRole('button', { name: 'Start', exact: true });
      await expect(
        start,
        'Start must remain disabled because installation already handed the validated process to the dashboard'
      ).toBeDisabled();
      await testInfo.attach('real-tfg-dashboard-ready.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });

      const stop = minecraftControls.getByRole('button', { name: 'Stop', exact: true });
      await expect(stop).toBeEnabled();
      await assertVisibleProductionWindow(electronApp, page);
      await stop.click();
      await expect(status).toHaveText('Stopped', { timeout: 5 * 60_000 });

      const evidence = await harness.collectServerEvidence(lifecycle);
      expect(evidence.latestLog).toMatch(/Done \([0-9.]+s\)!/u);
      expect(evidence.managedState).toContain(REAL_TFG.releaseId);
      expect(evidence.managedState).toContain(SERVERPACK.assetId);
      await testInfo.attach('real-tfg-rendered-ui-before-cleanup.json', {
        body: Buffer.from(JSON.stringify({
          releaseId: REAL_TFG.releaseId,
          tagName: REAL_TFG.tagName,
          assetId: SERVERPACK.assetId,
          startAfterInstall: true,
          validatedLiveProcessAdopted: true,
          ready: true,
          stopped: true,
          latestLogTail: evidence.latestLog.slice(-16_384)
        }, null, 2)),
        contentType: 'application/json'
      });
      completed = true;
    } finally {
      await restoreDestinationDialog?.();
      await stopVisibleServerIfRunning(page).catch(() => {});
      await githubHarness.finalizeRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        closeAndAudit: async (ownedElectronApp, isolatedLifecycle) => {
          await harness.closeProductionElectronAndAudit(ownedElectronApp, isolatedLifecycle);
          if (completed) terminalAudit = await githubHarness.auditCompletedLifecycle(isolatedLifecycle);
        },
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-tfg-rendered-ui-failure-evidence.json',
          harness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
    }

    expect(terminalAudit).toEqual({
      activeRecoveryEntries: [],
      workspaceEntries: [],
      orphanSiblingEntries: [],
      javaProcesses: []
    });
  });
});
