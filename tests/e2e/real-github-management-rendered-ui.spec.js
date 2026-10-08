import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import harness from './fixtures/real-github-releases-harness.cjs';

const REAL_GITHUB_MANAGEMENT_RENDERED_UI_ENV = 'MINECRAFT_CORE_REAL_GITHUB_MANAGEMENT_RENDERED_UI_E2E';
const OLDER = Object.freeze({
  releaseId: harness.REAL_GITHUB_RELEASE_MONITOR.olderReleaseId,
  tagName: harness.REAL_GITHUB_RELEASE_MONITOR.olderTagName,
  assetId: harness.REAL_GITHUB_RELEASE_MONITOR.olderAssetId,
  assetFileName: harness.REAL_GITHUB_RELEASE_MONITOR.olderAssetFileName,
  assetSize: harness.REAL_GITHUB_RELEASE_MONITOR.olderAssetSize,
  assetSha256: harness.REAL_GITHUB_RELEASE_MONITOR.olderAssetSha256,
  artifactSetDigest: harness.REAL_GITHUB_RELEASE_MONITOR.olderArtifactSetDigest,
  archiveChangelogSha256: harness.REAL_GITHUB_RELEASE_MONITOR.olderArchiveChangelogSha256,
  installedVersionMarkerPath: harness.REAL_GITHUB_RELEASE_MONITOR.olderInstalledVersionMarkerPath
});
const NEWER = Object.freeze({
  releaseId: harness.REAL_GITHUB_SERVER_PACK.releaseId,
  tagName: harness.REAL_GITHUB_SERVER_PACK.tagName,
  assetId: harness.REAL_GITHUB_SERVER_PACK.assetId,
  assetFileName: harness.REAL_GITHUB_SERVER_PACK.assetFileName,
  assetSize: harness.REAL_GITHUB_SERVER_PACK.assetSize,
  assetSha256: harness.REAL_GITHUB_SERVER_PACK.assetSha256,
  artifactSetDigest: harness.REAL_GITHUB_SERVER_PACK.artifactSetDigest,
  archiveChangelogSha256: harness.REAL_GITHUB_SERVER_PACK.archiveChangelogSha256,
  installedVersionMarkerPath: harness.REAL_GITHUB_SERVER_PACK.installedVersionMarkerPath
});
const GITHUB_TIMEOUT_MS = 2 * 60_000;
const INSPECTION_TIMEOUT_MS = 30 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 45 * 60_000;
const OPERATION_TIMEOUT_MS = 90 * 60_000;
const SERVER_READY_TIMEOUT_MS = 45 * 60_000;
const SERVER_STOP_TIMEOUT_MS = 5 * 60_000;
const SERVER_GRACEFUL_STOP_TIMEOUT_MS = 2 * 60_000;

function enabled(environment = process.env) {
  return ['1', 'true'].includes(
    String(environment[REAL_GITHUB_MANAGEMENT_RENDERED_UI_ENV] || '').trim().toLowerCase()
  );
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function readOptionalText(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function appendedLog(previous, current) {
  if (current === null) return '';
  if (previous === null) return current;
  if (current === previous) return '';
  return current.startsWith(previous) ? current.slice(previous.length) : current;
}

async function assertVisibleProductionWindow(electronApp, page) {
  await expect.poll(async () => {
    const browserWindow = await electronApp.browserWindow(page);
    try {
      return await browserWindow.evaluate(window => {
        const destroyed = window.isDestroyed();
        if (!destroyed) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          if (typeof window.moveTop === 'function') window.moveTop();
        }
        return { destroyed, visible: !destroyed && window.isVisible() };
      });
    } finally {
      await browserWindow.dispose();
    }
  }, {
    message: 'The exact production BrowserWindow driven by this test must be visibly shown',
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
  await page.getByRole('button', { name: 'Install Modpack' }).click();
  await expect(page.getByRole('heading', { name: 'Choose where the pack is published' })).toBeVisible();
  await page.getByRole('button', { name: /GitHub Releases/u }).click();
  await expect(page.getByRole('heading', { name: 'Choose an exact release' })).toBeVisible();
}

function releaseRow(page, release) {
  const history = page.getByRole('region', { name: 'GitHub release history' });
  const tagLine = new RegExp(`${escapeRegex(release.tagName)}\\s*·\\s*published`, 'u');
  return history.locator('li').filter({ hasText: tagLine });
}

async function loadUntilReleasesVisible(page, releases) {
  const history = page.getByRole('region', { name: 'GitHub release history' });
  await expect(history).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const allVisible = await Promise.all(releases.map(release =>
      releaseRow(page, release).isVisible().catch(() => false)
    ));
    if (allVisible.every(Boolean)) return;

    const loadOlder = history.getByRole('button', { name: 'Load older releases' });
    if (!await loadOlder.isVisible().catch(() => false)) break;
    const priorRows = await history.locator('li').count();
    await loadOlder.click();
    await expect.poll(async () => {
      const nowVisible = await Promise.all(releases.map(release =>
        releaseRow(page, release).isVisible().catch(() => false)
      ));
      return nowVisible.every(Boolean) || await history.locator('li').count() > priorRows;
    }, { timeout: GITHUB_TIMEOUT_MS }).toBe(true);
  }
  throw new Error(`The rendered GitHub history did not contain ${releases.map(value => value.tagName).join(' and ')}`);
}

async function chooseExactRelease(page, target, requiredHistory = [target]) {
  await loadUntilReleasesVisible(page, requiredHistory);
  const button = releaseRow(page, target).getByRole('button');
  await expect(button).toBeEnabled();
  await button.click();
}

async function inspectExactAsset(page, release, { rememberPattern = false } = {}) {
  const assetSelection = page.getByRole('radiogroup', { name: 'GitHub uploaded asset selection' });
  await expect(assetSelection).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
  const asset = assetSelection.getByRole('radio', {
    name: new RegExp(escapeRegex(release.assetFileName), 'u')
  });
  await asset.click();
  await expect(asset).toHaveAttribute('aria-checked', 'true');
  if (rememberPattern) {
    const remember = page.getByLabel(/Use this asset pattern for future releases/u);
    await remember.check();
    await expect(remember).toBeChecked();
  }
  await page.getByRole('button', { name: 'Download and inspect selected asset' }).click();
  await expect(page.getByRole('heading', { name: 'Inspect evidence before installation' })).toBeVisible({
    timeout: INSPECTION_TIMEOUT_MS
  });
}

async function resolveVisibleConflicts(page) {
  const review = page.getByRole('region', { name: 'Conflict choices' });
  if (!await review.isVisible().catch(() => false)) return false;
  const fieldsets = review.locator('fieldset');
  const count = await fieldsets.count();
  if (count < 1) throw new Error('Visible conflict review contained no choices');
  for (let index = 0; index < count; index += 1) {
    const fieldset = fieldsets.nth(index);
    const label = String(await fieldset.locator('legend').textContent() || '').trim();
    const details = String(await fieldset.locator('p.mp-muted').first().textContent() || '');
    const role = details.split('·', 1)[0].trim();
    const resolution = fieldset.locator('select[aria-label^="Resolution for"]');
    const values = await resolution.locator('option').evaluateAll(options =>
      options.map(option => option.value).filter(Boolean)
    );
    const choice = harness.preferredConflictChoice({ role, allowedChoices: values });
    if (!choice) throw new Error(`Visible conflict ${index + 1} has no supported safe choice`);
    await resolution.selectOption(choice);
    if (label === NEWER.installedVersionMarkerPath) {
      expect(choice, 'The exact release identity file must come from the selected release').toBe('use-pack');
    }
    if (choice === 'keep-both') {
      const alternate = fieldset.locator('select[aria-label^="Alternate destination for"]');
      const alternateValue = await alternate.locator('option').evaluateAll(options =>
        options.map(option => option.value).find(Boolean) || null
      );
      if (!alternateValue) throw new Error(`Visible conflict ${index + 1} has no approved alternate destination`);
      await alternate.selectOption(alternateValue);
    }
  }
  await page.getByRole('button', { name: 'Re-run review with conflict choices' }).click();
  return true;
}

async function waitForReviewedPlanOrConflicts(page) {
  await expect.poll(async () => {
    if (await page.getByText('Exact reviewed plan', { exact: true }).isVisible().catch(() => false) ||
        await page.getByText('Reviewed lifecycle plan', { exact: true }).isVisible().catch(() => false)) return 'plan';
    if (await page.getByRole('region', { name: 'Conflict choices' }).isVisible().catch(() => false)) return 'conflicts';
    return 'pending';
  }, { timeout: PREFLIGHT_TIMEOUT_MS }).toMatch(/^(?:plan|conflicts)$/u);
  if (await resolveVisibleConflicts(page)) {
    await expect.poll(async () =>
      await page.getByText('Exact reviewed plan', { exact: true }).isVisible().catch(() => false) ||
      await page.getByText('Reviewed lifecycle plan', { exact: true }).isVisible().catch(() => false),
    { timeout: PREFLIGHT_TIMEOUT_MS }).toBe(true);
  }
}

async function reviewSourcePlan(page, { electronApp = null, lifecycle = null, downgrade = false } = {}) {
  if (downgrade) {
    const risk = page.getByLabel(/I understand a downgrade can make the current world incompatible/u);
    await risk.check();
    await expect(risk).toBeChecked();
  }

  let restoreDestinationDialog = null;
  try {
    if (electronApp && lifecycle) {
      restoreDestinationDialog = await harness.installIsolatedServerDestinationDialogOverride(electronApp, lifecycle);
      await page.getByRole('button', { name: 'Choose destination and review plan' }).click();
    } else {
      await page.getByRole('button', { name: 'Review planned changes' }).click();
    }
    await waitForReviewedPlanOrConflicts(page);
  } finally {
    await restoreDestinationDialog?.();
  }
}

async function startReviewedSourcePlan(page) {
  const acceptEula = page.getByLabel('I accept the Minecraft EULA');
  const startAfterInstall = page.getByLabel('Start after install and validate final health');
  await acceptEula.check();
  await startAfterInstall.check();
  await expect(startAfterInstall).toBeChecked();
  const start = page.getByRole('button', {
    name: /^(?:Install this exact reviewed plan|Start reviewed operation)$/u
  });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });
}

async function waitForExistingOperationCompletion(page) {
  const terminalTitle = page.locator('section.outcome h3');
  await terminalTitle.waitFor({ state: 'visible', timeout: OPERATION_TIMEOUT_MS });
  expect(String(await terminalTitle.textContent() || '').trim()).toBe('Completed');
  await page.getByRole('button', { name: 'Return to server' }).click();
  await expect(page.getByRole('navigation', { name: 'Modpack sections' })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });
  await expect(page.getByRole('heading', { name: 'Modpack', exact: true })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });
}

async function waitForNewInstallCompletion(page) {
  const dashboard = page.getByRole('heading', { name: 'Server Dashboard' });
  const terminalTitle = page.locator('section.outcome h3');
  const result = await Promise.race([
    dashboard.waitFor({ state: 'visible', timeout: OPERATION_TIMEOUT_MS }).then(() => 'dashboard'),
    terminalTitle.waitFor({ state: 'visible', timeout: OPERATION_TIMEOUT_MS })
      .then(async () => `outcome:${String(await terminalTitle.textContent() || '').trim()}`)
  ]);
  if (result !== 'dashboard') throw new Error(`Visible new-server setup ended with ${result}`);
}

async function openServerTab(page, label) {
  const tab = page.locator('button.server-tab-button').filter({ hasText: label });
  await expect(tab).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
  await tab.click();
}

async function openModpack(page) {
  if (!await page.getByRole('navigation', { name: 'Modpack sections' }).isVisible().catch(() => false)) {
    await openServerTab(page, 'Modpack');
  }
  await expect(page.getByRole('heading', { name: 'Modpack', exact: true })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });
  await expect(page.getByRole('navigation', { name: 'Modpack sections' })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });
}

function samePath(left, right) {
  const normalize = value => path.resolve(String(value || '')).toLocaleLowerCase('en-US');
  return normalize(left) === normalize(right);
}

async function resolveIsolatedInstanceId(page, lifecycle) {
  const instances = await harness.invoke(page, 'get-instances', {});
  if (!Array.isArray(instances)) throw new Error('The visible app did not return its instance list');
  const matches = instances.filter(instance =>
    instance?.type === 'server' && typeof instance.id === 'string' && samePath(instance.path, lifecycle.serverPath)
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one server bound to the isolated destination, found ${matches.length}`);
  }
  return matches[0].id;
}

async function waitForFreshReadyLog(latestLogPath, previousLog) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readOptionalText(latestLogPath);
    const fresh = appendedLog(previousLog, current);
    if (/Done \([0-9.]+s\)!/u.test(fresh)) return fresh;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('The visible disposable server never produced a fresh Minecraft readiness line');
}

async function proveVisibleServerRunning(page, latestLogPath, previousLog) {
  if (!await page.getByRole('heading', { name: 'Server Dashboard' }).isVisible().catch(() => false)) {
    await openServerTab(page, 'Dashboard');
  }
  await expect(page.getByRole('heading', { name: 'Server Dashboard' })).toBeVisible();
  const controls = page.locator('.minecraft-server-section');
  const status = controls.locator('.status-value');
  await expect(status).toHaveText('Running', { timeout: 5 * 60_000 });
  const freshLog = await waitForFreshReadyLog(latestLogPath, previousLog);
  await expect(controls.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await expect(controls.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  return freshLog;
}

async function stopVisibleServerIfRunning(page) {
  if (!page || page.isClosed()) return;
  if (!await page.getByRole('heading', { name: 'Server Dashboard' }).isVisible().catch(() => false)) {
    const dashboardTab = page.locator('button.server-tab-button').filter({ hasText: 'Dashboard' });
    if (!await dashboardTab.isVisible().catch(() => false)) return;
    await dashboardTab.click();
    await expect(page.getByRole('heading', { name: 'Server Dashboard' })).toBeVisible({
      timeout: GITHUB_TIMEOUT_MS
    });
  }
  const controls = page.locator('.minecraft-server-section');
  await expect(controls).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
  const status = controls.locator('.status-value');
  const stop = controls.getByRole('button', { name: 'Stop', exact: true });
  const kill = controls.getByRole('button', { name: 'Kill', exact: true });
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
  let gracefulRequested = false;
  let gracefulRequestedAt = null;
  let forceRequested = false;
  let stoppingSince = null;
  let previousStatus = null;

  while (Date.now() < deadline) {
    const visibleStatus = String(await status.textContent() || '').trim();
    if (visibleStatus === 'Stopped') return;

    if (visibleStatus === 'Starting') {
      stoppingSince = null;
    } else if (visibleStatus === 'Running') {
      stoppingSince = null;
      if (!gracefulRequested && await stop.isEnabled().catch(() => false)) {
        await stop.click();
        gracefulRequested = true;
        gracefulRequestedAt = Date.now();
      } else if (gracefulRequested && !forceRequested &&
          (previousStatus === 'Stopping' || Date.now() - gracefulRequestedAt >= SERVER_GRACEFUL_STOP_TIMEOUT_MS) &&
          await kill.isEnabled().catch(() => false)) {
        await kill.click();
        forceRequested = true;
      }
    } else if (visibleStatus === 'Stopping') {
      stoppingSince ??= Date.now();
      if (Date.now() - stoppingSince >= SERVER_GRACEFUL_STOP_TIMEOUT_MS && !forceRequested &&
          await kill.isEnabled().catch(() => false)) {
        await kill.click();
        forceRequested = true;
      }
    } else if (!['', 'Unknown'].includes(visibleStatus)) {
      throw new Error(`Visible disposable server entered unexpected cleanup status: ${visibleStatus}`);
    }

    previousStatus = visibleStatus;
    await page.waitForTimeout(1_000);
  }

  throw new Error(`Visible disposable server did not stop from status ${String(await status.textContent() || '').trim()}`);
}

async function beginManagedGitHubVersion(page, target, installed) {
  await openModpack(page);
  await page.getByRole('button', { name: 'Versions' }).click();
  await page.getByRole('button', { name: "Load this repository's releases" }).click();
  await expect(page.getByRole('heading', { name: 'Choose an exact release' })).toBeVisible();
  await page.getByRole('button', { name: 'Load releases' }).click();
  await chooseExactRelease(page, target, [target, installed]);
  await inspectExactAsset(page, target);
}

async function beginUpdateFromVisibleNotification(page, testInfo) {
  await openModpack(page);
  const checkButton = page.getByRole('button', { name: 'Check for updates' });
  await expect(checkButton).toBeVisible();
  await checkButton.click();
  await expect(page.getByRole('status', { name: 'Release check status' })).toHaveText(
    'Release check finished. A matching update is available in notifications.',
    { timeout: GITHUB_TIMEOUT_MS }
  );
  await expect(checkButton).toBeEnabled();
  const notifications = page.getByRole('button', { name: /Modpack notifications, [1-9][0-9]* unread/u });
  await expect(notifications).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
  await notifications.click();
  const panel = page.getByRole('region', { name: 'Persistent modpack notifications' });
  await expect(panel).toBeVisible();
  const exactUpdate = panel.getByRole('button', { name: /Modpack update available[\s\S]*1\.7\.7/u });
  await expect(exactUpdate).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
  await testInfo.attach('real-github-update-notification.png', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await exactUpdate.click();
  await expect(page.getByRole('heading', { name: NEWER.tagName, exact: true })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });
  await inspectExactAsset(page, NEWER);
}

async function expectInstalledRelease(page, instanceId, release) {
  const state = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instanceId });
  expect(state).toMatchObject({
    modpackManaged: true,
    lifecycleMode: 'managed',
    source: {
      provider: 'github',
      repositoryId: harness.REAL_GITHUB_SERVER_PACK.repositoryId,
      releaseId: release.releaseId,
      version: release.tagName
    },
    runtime: harness.REAL_GITHUB_SERVER_PACK.runtimeChoice
  });
  return state;
}

async function assertExactReleaseContent(lifecycle, release) {
  const managedState = JSON.parse(await fs.promises.readFile(
    path.join(lifecycle.serverPath, '.minecraft-core-state', 'modpack.json'),
    'utf8'
  ));
  expect(managedState.source.selectedAssetIds).toEqual([release.assetId]);
  expect(managedState.source.artifactSetDigest).toBe(release.artifactSetDigest);

  const archive = await harness.assertPinnedReleaseArchiveEvidence(lifecycle, release);
  expect(archive).toEqual({
    assetSha256: release.assetSha256,
    changelogSha256: release.archiveChangelogSha256,
    tagName: release.tagName
  });
  const installed = await harness.assertPinnedInstalledVersion(lifecycle, release);
  expect(installed).toEqual({
    formattedVersion: `v${release.tagName}`,
    relativePath: release.installedVersionMarkerPath,
    tagName: release.tagName
  });
}

async function assertLoopbackNetworkPolicy(lifecycle) {
  const config = JSON.parse(await fs.promises.readFile(
    path.join(lifecycle.serverPath, '.minecraft-core.json'),
    'utf8'
  ));
  expect(config).toMatchObject({
    port: lifecycle.serverPort,
    networkAccess: 'loopback'
  });

  const properties = await fs.promises.readFile(
    path.join(lifecycle.serverPath, 'server.properties'),
    'utf8'
  );
  const activeLines = properties.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
  expect(activeLines.filter(line => /^server-port\s*=/u.test(line))).toEqual([
    `server-port=${lifecycle.serverPort}`
  ]);
  expect(activeLines.filter(line => /^server-ip\s*=/u.test(line))).toEqual([
    `server-ip=${lifecycle.serverHost}`
  ]);
}

function expectExactHistoryTransition(items, kind, sourceRevision, targetRevision, { restorePoint = false } = {}) {
  expect(targetRevision).toBe(sourceRevision + 1);
  const matches = items.filter(item => item.kind === kind && item.outcome === 'completed' &&
    item.sourceRevision === sourceRevision && item.targetRevision === targetRevision);
  expect(matches).toHaveLength(1);
  if (restorePoint) expect(matches[0].restorePointId).toEqual(expect.any(String));
  return matches[0];
}

async function assertVisibleHistoryTransitions(page, transitions) {
  await openModpack(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('region', { name: 'Modpack history' });
  await expect(history.getByRole('heading', { name: 'Lifecycle operations' })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });

  for (const transition of transitions) {
    const kind = String(transition.kind || '').replaceAll('-', ' ');
    const revision = `revision ${transition.sourceRevision} → ${transition.targetRevision}`;
    const row = history.getByRole('listitem')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegex(kind)}\\s*${escapeRegex(transition.outcome)}`, 'iu') })
      .filter({ hasText: revision });
    await expect(row, `Rendered history must show ${kind} ${revision}`).toHaveCount(1);
    await expect(row.getByText(kind, { exact: true })).toBeVisible();
    await expect(row.getByText(revision, { exact: true })).toBeVisible();
  }
}

test.describe('real rendered GitHub release version management', () => {
  test.skip(
    !enabled(),
    `Set ${REAL_GITHUB_MANAGEMENT_RENDERED_UI_ENV}=1 to run this visible production-Electron lifecycle.`
  );

  test('installs 1.7.6, updates to 1.7.7, downgrades to 1.7.6, and rolls back through visible controls', async ({ browserName: _browserName }, testInfo) => {
    void _browserName;
    test.setTimeout(5 * 60 * 60_000);
    const lifecycle = await harness.createIsolatedRealLifecycle();
    const latestLogPath = path.join(lifecycle.serverPath, 'logs', 'latest.log');
    let electronApp = null;
    let page = null;
    let completed = false;
    let terminalAudit = null;

    try {
      expect(fs.readdirSync(lifecycle.serverPath)).toEqual([]);
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      await assertVisibleProductionWindow(electronApp, page);
      await openGitHubServerSetup(page);

      await page.getByLabel('Public repository or release URL').fill(
        harness.REAL_GITHUB_SERVER_PACK.repositoryUrl
      );
      await page.getByRole('button', { name: 'Load releases' }).click();
      await chooseExactRelease(page, OLDER);
      await inspectExactAsset(page, OLDER, { rememberPattern: true });
      await page.getByLabel(/Maximum server RAM/u).fill('6');
      await page.getByLabel('Minecraft server port').fill(String(lifecycle.serverPort));
      await page.getByLabel('Network access').selectOption('loopback');
      await reviewSourcePlan(page, { electronApp, lifecycle });
      const beforeInstallLog = await readOptionalText(latestLogPath);
      await startReviewedSourcePlan(page);
      await waitForNewInstallCompletion(page);
      const installedReady = await proveVisibleServerRunning(page, latestLogPath, beforeInstallLog);
      await testInfo.attach('real-github-installed-running.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      const instanceId = await resolveIsolatedInstanceId(page, lifecycle);
      const installedState = await expectInstalledRelease(page, instanceId, OLDER);
      expect(installedState.contentRevision).toBe(1);
      await assertExactReleaseContent(lifecycle, OLDER);
      await assertLoopbackNetworkPolicy(lifecycle);
      harness.createUnmanagedSentinel(lifecycle);

      const updateSourceRevision = await harness.readServerContentRevision(page, instanceId);
      const beforeUpdateLog = await readOptionalText(latestLogPath);
      await beginUpdateFromVisibleNotification(page, testInfo);
      await reviewSourcePlan(page);
      await startReviewedSourcePlan(page);
      await waitForExistingOperationCompletion(page);
      const updatedReady = await proveVisibleServerRunning(page, latestLogPath, beforeUpdateLog);
      await testInfo.attach('real-github-updated-running.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      const updatedState = await expectInstalledRelease(page, instanceId, NEWER);
      expect(updatedState.contentRevision).toBe(updateSourceRevision + 1);
      await assertExactReleaseContent(lifecycle, NEWER);
      await assertLoopbackNetworkPolicy(lifecycle);
      harness.assertUnmanagedSentinel(lifecycle);

      const downgradeSourceRevision = await harness.readServerContentRevision(page, instanceId);
      const beforeDowngradeLog = await readOptionalText(latestLogPath);
      await beginManagedGitHubVersion(page, OLDER, NEWER);
      await reviewSourcePlan(page, { downgrade: true });
      await startReviewedSourcePlan(page);
      await waitForExistingOperationCompletion(page);
      const downgradedReady = await proveVisibleServerRunning(page, latestLogPath, beforeDowngradeLog);
      await testInfo.attach('real-github-downgraded-running.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      const downgradedState = await expectInstalledRelease(page, instanceId, OLDER);
      expect(downgradedState.contentRevision).toBe(downgradeSourceRevision + 1);
      await assertExactReleaseContent(lifecycle, OLDER);
      await assertLoopbackNetworkPolicy(lifecycle);
      harness.assertUnmanagedSentinel(lifecycle);

      const rollbackSourceRevision = await harness.readServerContentRevision(page, instanceId);
      const beforeRollbackLog = await readOptionalText(latestLogPath);
      await openModpack(page);
      await page.getByRole('button', { name: 'Actions' }).click();
      await page.getByRole('button', { name: 'Choose restore point' }).click();
      await expect(page.getByRole('heading', { name: 'Choose a compatible restore point' })).toBeVisible({
        timeout: PREFLIGHT_TIMEOUT_MS
      });
      const downgradeRestorePoint = page.getByRole('button', { name: /downgrade restore point/u }).first();
      await expect(downgradeRestorePoint).toBeVisible({ timeout: PREFLIGHT_TIMEOUT_MS });
      await downgradeRestorePoint.click();
      await expect(page.getByRole('region', { name: 'Reviewed modpack operation plan' })).toBeVisible({
        timeout: PREFLIGHT_TIMEOUT_MS
      });
      await page.getByRole('button', { name: 'Start reviewed operation' }).click();
      await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible();
      await waitForExistingOperationCompletion(page);
      const rolledBackReady = await proveVisibleServerRunning(page, latestLogPath, beforeRollbackLog);
      await testInfo.attach('real-github-rolled-back-running.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      const rolledBackState = await expectInstalledRelease(page, instanceId, NEWER);
      expect(rolledBackState.contentRevision).toBeGreaterThan(rollbackSourceRevision);
      await assertExactReleaseContent(lifecycle, NEWER);
      await assertLoopbackNetworkPolicy(lifecycle);
      harness.assertUnmanagedSentinel(lifecycle);

      const history = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: instanceId,
        cursor: null,
        limit: 200
      });
      const installHistory = expectExactHistoryTransition(
        history.items,
        'install',
        0,
        installedState.contentRevision
      );
      const updateHistory = expectExactHistoryTransition(
        history.items,
        'upgrade',
        updateSourceRevision,
        updatedState.contentRevision,
        { restorePoint: true }
      );
      const downgradeHistory = expectExactHistoryTransition(
        history.items,
        'downgrade',
        downgradeSourceRevision,
        downgradedState.contentRevision,
        { restorePoint: true }
      );
      const rollbackMatches = history.items.filter(item => item.kind === 'rollback' &&
        item.outcome === 'completed' && item.targetRevision === rolledBackState.contentRevision);
      expect(rollbackMatches).toHaveLength(1);
      expect(rollbackMatches[0].sourceRevision).toBeGreaterThanOrEqual(rollbackSourceRevision);
      const rollbackHistory = expectExactHistoryTransition(
        history.items,
        'rollback',
        rollbackMatches[0].sourceRevision,
        rollbackMatches[0].targetRevision,
        { restorePoint: true }
      );
      await assertVisibleHistoryTransitions(page, [
        installHistory,
        updateHistory,
        downgradeHistory,
        rollbackHistory
      ]);
      await testInfo.attach('real-github-lifecycle-history.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      await assertVisibleProductionWindow(electronApp, page);
      await stopVisibleServerIfRunning(page);

      await testInfo.attach('real-github-management-rendered-ui-evidence.json', {
        body: Buffer.from(JSON.stringify({
          releases: {
            installed: installedState.source,
            updated: updatedState.source,
            downgraded: downgradedState.source,
            rolledBack: rolledBackState.source
          },
          readiness: {
            installed: installedReady.slice(-4_096),
            updated: updatedReady.slice(-4_096),
            downgraded: downgradedReady.slice(-4_096),
            rolledBack: rolledBackReady.slice(-4_096)
          },
          revisions: {
            install: { source: 0, target: installedState.contentRevision },
            update: { source: updateSourceRevision, target: updatedState.contentRevision },
            downgrade: { source: downgradeSourceRevision, target: downgradedState.contentRevision },
            rollback: {
              reviewedSource: rollbackSourceRevision,
              source: rollbackHistory.sourceRevision,
              target: rolledBackState.contentRevision
            }
          },
          history: history.items
        }, null, 2)),
        contentType: 'application/json'
      });
      completed = true;
    } finally {
      await stopVisibleServerIfRunning(page).catch(() => {});
      await harness.finalizeRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        closeAndAudit: async (ownedElectronApp, isolatedLifecycle) => {
          await harness.closeProductionElectronAndAudit(ownedElectronApp, isolatedLifecycle);
          if (completed) terminalAudit = await harness.auditCompletedLifecycle(isolatedLifecycle);
        },
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-github-management-rendered-ui-failure-evidence.json',
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
