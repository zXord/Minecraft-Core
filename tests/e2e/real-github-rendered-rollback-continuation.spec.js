import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import harness from './fixtures/real-github-releases-harness.cjs';
import continuation from './fixtures/preserved-real-github-releases-harness.cjs';
import preservedHarness from './fixtures/preserved-real-modrinth-harness.cjs';

const RENDERED_ROLLBACK_CONTINUATION_ENV =
  'MINECRAFT_CORE_REAL_GITHUB_RENDERED_ROLLBACK_CONTINUATION_E2E';
const RENDERED_ROLLBACK_APPROVED_ROOT_ENV =
  'MINECRAFT_CORE_REAL_GITHUB_RENDERED_ROLLBACK_APPROVED_ROOT';
const configuredRoot = continuation.getPreservedGitHubLifecycleRoot();
const approvedRoot = String(process.env[RENDERED_ROLLBACK_APPROVED_ROOT_ENV] || '').trim() || null;
const GITHUB_TIMEOUT_MS = 2 * 60_000;
const PREFLIGHT_TIMEOUT_MS = 45 * 60_000;
const OPERATION_TIMEOUT_MS = 90 * 60_000;
const SERVER_READY_TIMEOUT_MS = 45 * 60_000;
const SERVER_STOP_TIMEOUT_MS = 5 * 60_000;
const PRE_ROLLBACK_REVISION = 3;
const POST_ROLLBACK_REVISION = 4;
const MAX_RENDERER_DIAGNOSTICS = 100;
const NEWER = Object.freeze({
  releaseId: harness.REAL_GITHUB_SERVER_PACK.releaseId,
  tagName: harness.REAL_GITHUB_SERVER_PACK.tagName,
  assetId: harness.REAL_GITHUB_SERVER_PACK.assetId,
  assetSize: harness.REAL_GITHUB_SERVER_PACK.assetSize,
  assetSha256: harness.REAL_GITHUB_SERVER_PACK.assetSha256,
  artifactSetDigest: harness.REAL_GITHUB_SERVER_PACK.artifactSetDigest,
  archiveChangelogSha256: harness.REAL_GITHUB_SERVER_PACK.archiveChangelogSha256,
  installedVersionMarkerPath: harness.REAL_GITHUB_SERVER_PACK.installedVersionMarkerPath
});

function pathsEqual(left, right) {
  return path.resolve(String(left || '')).toLocaleLowerCase('en-US') ===
    path.resolve(String(right || '')).toLocaleLowerCase('en-US');
}

function explicitOptIn(environment = process.env) {
  return ['1', 'true'].includes(
    String(environment[RENDERED_ROLLBACK_CONTINUATION_ENV] || '').trim().toLowerCase()
  );
}

function enabled() {
  return explicitOptIn() && continuation.isPreservedGitHubLifecycleEnabled() &&
    configuredRoot !== null && approvedRoot !== null && pathsEqual(configuredRoot, approvedRoot);
}

function validateCompletedRollbackState(state) {
  const source = state?.source;
  const runtime = harness.REAL_GITHUB_SERVER_PACK.runtimeChoice;
  if (state?.modpackManaged !== true || state?.contentRevision !== POST_ROLLBACK_REVISION ||
      source?.provider !== 'github' ||
      source?.repositoryId !== harness.REAL_GITHUB_SERVER_PACK.repositoryId ||
      source?.releaseId !== NEWER.releaseId || source?.version !== NEWER.tagName ||
      state.runtime?.minecraftVersion !== runtime.minecraftVersion ||
      state.runtime?.loaderFamily !== runtime.loaderFamily ||
      state.runtime?.loaderVersion !== runtime.loaderVersion) {
    throw new Error('The preserved lifecycle is not the exact completed rendered rollback');
  }
}

function appendBoundedDiagnostic(items, value) {
  if (items.length >= MAX_RENDERER_DIAGNOSTICS) return;
  items.push(value);
}

async function attachRendererFailureEvidence(page, testInfo, rendererDiagnostics) {
  await testInfo.attach('rendered-continuation-renderer-diagnostics.json', {
    body: Buffer.from(`${JSON.stringify(rendererDiagnostics, null, 2)}\n`),
    contentType: 'application/json'
  }).catch(() => {});

  try {
    const screenshot = await page.screenshot({ timeout: 15_000 });
    await testInfo.attach('rendered-continuation-renderer-failure.png', {
      body: screenshot,
      contentType: 'image/png'
    });
  } catch {}

  try {
    const html = String(await page.content()).slice(0, 512 * 1024);
    await testInfo.attach('rendered-continuation-renderer-failure.html', {
      body: Buffer.from(html),
      contentType: 'text/html'
    });
  } catch {}
}

async function loadApprovedLifecycle() {
  try {
    return await continuation.loadPreservedGitHubLifecycle(configuredRoot);
  } catch (downgradedStateError) {
    try {
      return await preservedHarness.loadPreservedRealLifecycle(configuredRoot, {
        expectedIdentity: continuation.GITHUB_CONTINUATION_IDENTITY,
        scratchPrefix: continuation.GITHUB_CONTINUATION_SCRATCH_PREFIX,
        providerLabel: 'GitHub Releases',
        scratchLabel: 'github-releases',
        validateManagedState: validateCompletedRollbackState
      });
    } catch (completedStateError) {
      throw new AggregateError(
        [downgradedStateError, completedStateError],
        'The preserved root is neither the approved pre-rollback nor completed-rollback state'
      );
    }
  }
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
    message: 'The exact production BrowserWindow driven by this continuation must stay visible',
    timeout: 60_000
  }).toEqual({ destroyed: false, visible: true });
}

async function openServerTab(page, label) {
  const tab = page.locator('button.server-tab-button').filter({ hasText: label });
  await expect(tab).toBeVisible({ timeout: GITHUB_TIMEOUT_MS });
  await tab.click();
}

async function openDashboard(page) {
  if (!await page.getByRole('heading', { name: 'Server Dashboard' }).isVisible().catch(() => false)) {
    await openServerTab(page, 'Dashboard');
  }
  await expect(page.getByRole('heading', { name: 'Server Dashboard' })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });
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

async function waitForFreshReadyLog(latestLogPath, previousLog) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await readOptionalText(latestLogPath);
    const fresh = appendedLog(previousLog, current);
    if (/Done \([0-9.]+s\)!/u.test(fresh)) return fresh;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error('The visible continuation server never produced a fresh readiness line');
}

async function startVisibleServer(page, latestLogPath) {
  await openDashboard(page);
  const controls = page.locator('.minecraft-server-section');
  const status = controls.locator('.status-value');
  await expect(status).toHaveText('Stopped', { timeout: GITHUB_TIMEOUT_MS });
  const previousLog = await readOptionalText(latestLogPath);
  const start = controls.getByRole('button', { name: 'Start', exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(status).toHaveText('Running', { timeout: 5 * 60_000 });
  const freshLog = await waitForFreshReadyLog(latestLogPath, previousLog);
  await expect(start).toBeDisabled();
  await expect(controls.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  return freshLog;
}

async function proveVisibleServerRunning(page, latestLogPath, previousLog) {
  await openDashboard(page);
  const controls = page.locator('.minecraft-server-section');
  await expect(controls.locator('.status-value')).toHaveText('Running', { timeout: 5 * 60_000 });
  const freshLog = await waitForFreshReadyLog(latestLogPath, previousLog);
  await expect(controls.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await expect(controls.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  return freshLog;
}

async function stopVisibleServerIfRunning(page) {
  if (!page || page.isClosed()) return;
  await openDashboard(page);
  const controls = page.locator('.minecraft-server-section');
  const status = controls.locator('.status-value');
  const stop = controls.getByRole('button', { name: 'Stop', exact: true });
  const kill = controls.getByRole('button', { name: 'Kill', exact: true });
  const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
  let stopRequestedAt = null;
  let forceRequested = false;

  while (Date.now() < deadline) {
    const current = String(await status.textContent() || '').trim();
    if (current === 'Stopped') return;
    if (current === 'Running' && stopRequestedAt === null && await stop.isEnabled().catch(() => false)) {
      await stop.click();
      stopRequestedAt = Date.now();
    } else if (stopRequestedAt !== null && !forceRequested &&
        Date.now() - stopRequestedAt >= 2 * 60_000 && await kill.isEnabled().catch(() => false)) {
      await kill.click();
      forceRequested = true;
    } else if (!['Starting', 'Running', 'Stopping', '', 'Unknown'].includes(current)) {
      throw new Error(`Visible continuation server entered unexpected cleanup status: ${current}`);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Visible continuation server did not stop from ${String(await status.textContent() || '').trim()}`);
}

function exactTransition(items, kind, sourceRevision, targetRevision, { restorePoint = false } = {}) {
  expect(targetRevision).toBe(sourceRevision + 1);
  const matches = items.filter(item => item.kind === kind && item.outcome === 'completed' &&
    item.sourceRevision === sourceRevision && item.targetRevision === targetRevision);
  expect(matches).toHaveLength(1);
  if (restorePoint) expect(matches[0].restorePointId).toEqual(expect.any(String));
  return matches[0];
}

async function expectInstalledNewerRelease(page, lifecycle, expectedRevision = null) {
  const state = await harness.invokeModpack(page, 'modpacks:get-state', {
    serverId: lifecycle.instanceId
  });
  expect(state).toMatchObject({
    modpackManaged: true,
    lifecycleMode: 'managed',
    source: {
      provider: 'github',
      repositoryId: harness.REAL_GITHUB_SERVER_PACK.repositoryId,
      releaseId: NEWER.releaseId,
      version: NEWER.tagName
    },
    runtime: harness.REAL_GITHUB_SERVER_PACK.runtimeChoice
  });
  expect(Number.isSafeInteger(state.contentRevision)).toBe(true);
  if (expectedRevision !== null) expect(state.contentRevision).toBe(expectedRevision);

  const managedState = JSON.parse(await fs.promises.readFile(
    path.join(lifecycle.serverPath, '.minecraft-core-state', 'modpack.json'),
    'utf8'
  ));
  expect(managedState.source.selectedAssetIds).toEqual([NEWER.assetId]);
  expect(managedState.source.artifactSetDigest).toBe(NEWER.artifactSetDigest);
  expect(await harness.assertPinnedReleaseArchiveEvidence(lifecycle, NEWER)).toEqual({
    assetSha256: NEWER.assetSha256,
    changelogSha256: NEWER.archiveChangelogSha256,
    tagName: NEWER.tagName
  });
  expect(await harness.assertPinnedInstalledVersion(lifecycle, NEWER)).toEqual({
    formattedVersion: `v${NEWER.tagName}`,
    relativePath: NEWER.installedVersionMarkerPath,
    tagName: NEWER.tagName
  });
  harness.assertUnmanagedSentinel(lifecycle);
  return state;
}

async function assertVisibleHistory(page, transitions) {
  await openModpack(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.getByRole('region', { name: 'Modpack history' });
  await expect(history.getByRole('heading', { name: 'Lifecycle operations' })).toBeVisible({
    timeout: GITHUB_TIMEOUT_MS
  });
  for (const transition of transitions) {
    const kind = String(transition.kind).replaceAll('-', ' ');
    const revision = `revision ${transition.sourceRevision} → ${transition.targetRevision}`;
    const row = history.getByRole('listitem')
      .filter({ hasText: new RegExp(`^\\s*${kind}\\s*${transition.outcome}`, 'iu') })
      .filter({ hasText: revision });
    await expect(row).toHaveCount(1);
    await expect(row.getByText(kind, { exact: true })).toBeVisible();
    await expect(row.getByText(revision, { exact: true })).toBeVisible();
  }
}

test.describe('exact preserved rendered GitHub rollback continuation', () => {
  test.skip(
    !enabled(),
    `Set ${RENDERED_ROLLBACK_CONTINUATION_ENV}=1, ${harness.REAL_GITHUB_RELEASES_ENV}=1, and ` +
      `the same exact root in ${continuation.REAL_GITHUB_CONTINUATION_ROOT_ENV} and ` +
      `${RENDERED_ROLLBACK_APPROVED_ROOT_ENV} to run this one-root continuation.`
  );

  test('visibly rolls the isolated downgraded 1.7.6 server back to 1.7.7, proves history, and stops it', async ({ browserName: _browserName }, testInfo) => {
    void _browserName;
    test.setTimeout(2 * 60 * 60_000);
    let lifecycle = null;
    let electronApp = null;
    let page = null;
    let completed = false;
    const rendererDiagnostics = { pageErrors: [], consoleErrors: [] };

    try {
      expect(pathsEqual(configuredRoot, approvedRoot)).toBe(true);
      lifecycle = await loadApprovedLifecycle();
      expect(pathsEqual(lifecycle.root, approvedRoot)).toBe(true);
      const latestLogPath = path.join(lifecycle.serverPath, 'logs', 'latest.log');

      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      page.on('pageerror', error => {
        appendBoundedDiagnostic(rendererDiagnostics.pageErrors, {
          name: String(error?.name || 'Error').slice(0, 128),
          message: String(error?.message || error || 'Unknown renderer error').slice(0, 4_096),
          stack: String(error?.stack || '').slice(0, 16_384)
        });
      });
      page.on('console', message => {
        if (message.type() !== 'error') return;
        appendBoundedDiagnostic(
          rendererDiagnostics.consoleErrors,
          String(message.text() || '').slice(0, 4_096)
        );
      });
      await assertVisibleProductionWindow(electronApp, page);

      const beforeState = await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: lifecycle.instanceId
      });
      expect((await harness.invokeModpack(page, 'modpacks:list-recovery', {})).items).toEqual([]);
      harness.assertUnmanagedSentinel(lifecycle);
      const alreadyRolledBack = beforeState.contentRevision === POST_ROLLBACK_REVISION &&
        beforeState.source?.releaseId === NEWER.releaseId && beforeState.source?.version === NEWER.tagName;
      let initialReady = null;
      let rolledBackReady;
      let rolledBackState;

      if (alreadyRolledBack) {
        rolledBackReady = await startVisibleServer(page, latestLogPath);
        rolledBackState = await expectInstalledNewerRelease(page, lifecycle, POST_ROLLBACK_REVISION);
      } else {
        expect(beforeState).toMatchObject({
          contentRevision: PRE_ROLLBACK_REVISION,
          source: {
            provider: 'github',
            repositoryId: harness.REAL_GITHUB_SERVER_PACK.repositoryId,
            releaseId: harness.REAL_GITHUB_RELEASE_MONITOR.olderReleaseId,
            version: harness.REAL_GITHUB_RELEASE_MONITOR.olderTagName
          }
        });
        initialReady = await startVisibleServer(page, latestLogPath);
        await testInfo.attach('rendered-continuation-downgraded-running.png', {
          body: await page.screenshot(),
          contentType: 'image/png'
        });

        const beforeRollbackLog = await readOptionalText(latestLogPath);
        await openModpack(page);
        await page.getByRole('button', { name: 'Actions' }).click();
        await page.getByRole('button', { name: 'Choose restore point' }).click();
        await expect(page.getByRole('heading', { name: 'Choose a compatible restore point' })).toBeVisible({
          timeout: GITHUB_TIMEOUT_MS
        });
        const updateRestorePoint = page.getByRole('button', { name: /downgrade restore point/iu })
          .filter({ hasText: /source revision 2/iu });
        await expect(updateRestorePoint).toHaveCount(1, { timeout: PREFLIGHT_TIMEOUT_MS });
        await expect(updateRestorePoint).toBeVisible();
        await testInfo.attach('rendered-continuation-restore-point-list.png', {
          body: await page.screenshot(),
          contentType: 'image/png'
        });
        await updateRestorePoint.click();

        const reviewedPlan = page.getByRole('region', { name: 'Reviewed modpack operation plan' });
        await expect(reviewedPlan).toBeVisible({ timeout: PREFLIGHT_TIMEOUT_MS });
        await testInfo.attach('rendered-continuation-rollback-plan.png', {
          body: await page.screenshot(),
          contentType: 'image/png'
        });
        const startOperation = reviewedPlan.getByRole('button', { name: 'Start reviewed operation' });
        await expect(startOperation).toBeEnabled();
        await startOperation.click();
        await expect(page.getByRole('region', { name: 'Modpack operation progress' })).toBeVisible({
          timeout: GITHUB_TIMEOUT_MS
        });

        const terminalTitle = page.locator('section.outcome h3');
        await terminalTitle.waitFor({ state: 'visible', timeout: OPERATION_TIMEOUT_MS });
        expect(String(await terminalTitle.textContent() || '').trim()).toBe('Completed');
        await page.getByRole('button', { name: 'Return to server' }).click();
        await expect(page.getByRole('navigation', { name: 'Modpack sections' })).toBeVisible({
          timeout: GITHUB_TIMEOUT_MS
        });

        rolledBackReady = await proveVisibleServerRunning(page, latestLogPath, beforeRollbackLog);
        rolledBackState = await expectInstalledNewerRelease(page, lifecycle);
        expect(rolledBackState.contentRevision).toBeGreaterThan(beforeState.contentRevision);
      }
      await testInfo.attach('rendered-continuation-rolled-back-running.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });

      const history = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: lifecycle.instanceId,
        cursor: null,
        limit: 200
      });
      const rollbackEntries = history.items.filter(item => item.kind === 'rollback' &&
        item.outcome === 'completed' && item.targetRevision === rolledBackState.contentRevision);
      expect(rollbackEntries).toHaveLength(1);
      const transitions = [
        exactTransition(history.items, 'install', 0, 1),
        exactTransition(history.items, 'upgrade', 1, 2, { restorePoint: true }),
        exactTransition(history.items, 'downgrade', 2, 3, { restorePoint: true }),
        exactTransition(
          history.items,
          'rollback',
          rollbackEntries[0].sourceRevision,
          rollbackEntries[0].targetRevision,
          { restorePoint: true }
        )
      ];
      await assertVisibleHistory(page, transitions);
      await testInfo.attach('rendered-continuation-lifecycle-history.png', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      await assertVisibleProductionWindow(electronApp, page);
      await stopVisibleServerIfRunning(page);
      const terminalAudit = await harness.auditCompletedLifecycle(lifecycle);

      await testInfo.attach('rendered-continuation-evidence.json', {
        body: Buffer.from(JSON.stringify({
          approvedRoot: lifecycle.root,
          beforeState,
          rolledBackState,
          readiness: {
            initial: initialReady?.slice(-4_096) ?? null,
            rollback: rolledBackReady.slice(-4_096)
          },
          history: history.items,
          terminalAudit
        }, null, 2)),
        contentType: 'application/json'
      });
      completed = true;
    } finally {
      if (!completed && page && !page.isClosed()) {
        await attachRendererFailureEvidence(page, testInfo, rendererDiagnostics);
      }
      await stopVisibleServerIfRunning(page).catch(() => {});
      if (lifecycle) {
        await harness.finalizeRealLifecycle({
          completed,
          electronApp,
          lifecycle,
          collectEvidence: () => harness.collectServerEvidence(lifecycle),
          attachEvidence: evidence => testInfo.attach(
            'rendered-continuation-failure-evidence.json',
            harness.createSelfContainedEvidenceAttachment(evidence)
          ),
          dispose: options => lifecycle.dispose(options)
        });
      } else {
        await harness.closeProductionElectron(electronApp);
      }
    }
  });
});
