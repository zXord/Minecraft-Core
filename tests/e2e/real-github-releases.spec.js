import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import harness from './fixtures/real-github-releases-harness.cjs';

const enabled = harness.isRealGitHubReleasesEnabled();

async function findKnownRelease(page, selector) {
  let cursor;
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const listing = await harness.invokeModpack(page, 'modpacks:list-github-releases', {
      repositoryUrl: harness.REAL_GITHUB_SERVER_PACK.repositoryUrl,
      includePrereleases: false,
      ...(cursor ? { cursor } : {})
    });
    const release = selector(listing.releases);
    if (release) return release;
    cursor = listing.pagination?.nextCursor;
    if (!cursor) return null;
  }
  throw new Error('GitHub releases pagination exceeded the E2E safety limit.');
}

async function inspectExactServerArchive(page, {
  release,
  selectAsset,
  expectedFileName,
  evidenceLabel,
  testInfo,
  rememberAssetPattern = false
}) {
  const assetListing = await harness.invokeModpack(page, 'modpacks:list-github-assets', {
    repositoryId: release.repositoryId,
    releaseId: release.releaseId
  });
  const asset = selectAsset(assetListing.assets);
  expect(asset, `Expected uploaded asset ${expectedFileName}`).toBeTruthy();
  expect(asset.fileName).toBe(expectedFileName);
  expect(asset.fileName).not.toMatch(/^source code\b/iu);

  const inspection = await harness.invokeModpack(page, 'modpacks:inspect', {
    provider: 'github',
    repositoryId: release.repositoryId,
    releaseId: release.releaseId,
    assetIds: [asset.assetId],
    ...(rememberAssetPattern ? { rememberAssetPattern: true } : {})
  });
  expect(inspection).toMatchObject({
    type: 'archive-inspection',
    integrity: 'deferred-to-extraction',
    engineEvidence: { tested: false },
    artifactSet: { completeness: 'verified-complete-set' }
  });
  expect(inspection.artifactSet.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(inspection).not.toHaveProperty('entries');
  expect(inspection.limitEvidence.totals.entryCount).toBeGreaterThan(0);
  expect(inspection.classification).toEqual(expect.any(Object));

  const classification = inspection.classification;
  if (classification.blocked === true || classification.confidence !== 'exact' || !classification.runtime) {
    await testInfo.attach(`${evidenceLabel}-classification-limitation.json`, {
      body: Buffer.from(JSON.stringify({
        repositoryUrl: harness.REAL_GITHUB_SERVER_PACK.repositoryUrl,
        releaseId: release.releaseId,
        assetId: asset.assetId,
        assetFileName: asset.fileName,
        classification,
        entryCount: inspection.limitEvidence.totals.entryCount
      }, null, 2)),
      contentType: 'application/json'
    });
    throw new Error(`Inspected uploaded asset cannot continue: ${classification.kind || 'unknown'} / ${classification.confidence || 'unknown'}.`);
  }
  expect(classification.runtime).toMatchObject(harness.REAL_GITHUB_SERVER_PACK.runtimeChoice);
  return { asset, inspection };
}

async function reviewExactServerArchive(page, {
  instanceId,
  release,
  asset,
  inspection,
  operationKind,
  acknowledgeDowngradeWorldRisk = false
}) {
  const reviewed = await harness.reviewExactGitHubArchive(page, {
    instanceId,
    release,
    asset,
    inspection,
    operationKind,
    acknowledgeDowngradeWorldRisk
  });
  expect(reviewed.plan.planView).toMatchObject({
    source: { provider: 'github', version: release.tagName },
    runtime: { minecraft: '1.12.2', loader: 'forge' }
  });
  return reviewed;
}

async function expectExactInstalledRelease(page, instanceId, release) {
  const state = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instanceId });
  expect(state.source).toMatchObject({
    provider: 'github',
    repositoryId: release.repositoryId,
    releaseId: release.releaseId,
    version: release.tagName
  });
  expect(state.runtime).toMatchObject(harness.REAL_GITHUB_SERVER_PACK.runtimeChoice);
  return state;
}

function expectPublisherInstallScriptsRemoved(serverPath) {
  for (const publisherScript of ['_install.cmd', '_install.sh', '_install_mods.cmd', '_install_mods.sh']) {
    expect(fs.existsSync(path.join(serverPath, publisherScript)), publisherScript).toBe(false);
  }
}

function expectExactHistoryTransition(items, kind, sourceRevision, targetRevision) {
  expect(targetRevision).toBe(sourceRevision + 1);
  expect(items).toContainEqual(expect.objectContaining({ kind, sourceRevision, targetRevision }));
}

test.describe('real GitHub Releases uploaded server-pack lifecycle', () => {
  test.skip(!enabled, `Set ${harness.REAL_GITHUB_RELEASES_ENV}=1 to run this real GitHub Releases test.`);

  test('installs, boots, upgrades, boots, downgrades, and boots exact uploaded Nomi CEu releases only inside fresh isolated paths', async () => {
    const testInfo = test.info();
    test.setTimeout(4 * 60 * 60_000);
    const lifecycle = await harness.createIsolatedRealLifecycle();
    let electronApp = null;
    let page = null;
    let instance = null;
    let completed = false;

    try {
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      const olderRelease = await findKnownRelease(page, harness.selectKnownOlderRelease);
      const newerRelease = await findKnownRelease(page, harness.selectKnownRelease);
      expect(olderRelease, `Expected exact older release ${harness.REAL_GITHUB_RELEASE_MONITOR.olderTagName}`).toBeTruthy();
      expect(newerRelease, `Expected exact newer release ${harness.REAL_GITHUB_SERVER_PACK.tagName}`).toBeTruthy();
      expect(() => harness.assertExactReleaseChronology(olderRelease, newerRelease)).not.toThrow();

      const olderInstall = await inspectExactServerArchive(page, {
        release: olderRelease,
        selectAsset: harness.selectKnownOlderServerAsset,
        expectedFileName: harness.REAL_GITHUB_RELEASE_MONITOR.olderAssetFileName,
        evidenceLabel: 'github-older-install',
        testInfo,
        rememberAssetPattern: true
      });

      instance = await harness.reserveIsolatedServerDestination(electronApp, page, lifecycle);
      const installReview = await reviewExactServerArchive(page, {
        instanceId: instance.instanceId,
        release: olderRelease,
        asset: olderInstall.asset,
        inspection: olderInstall.inspection,
        operationKind: 'install-new'
      });
      await testInfo.attach('github-older-server-pack-inspection.json', {
        body: Buffer.from(JSON.stringify({
          inspectionId: olderInstall.inspection.inspectionId,
          selectedRoot: olderInstall.inspection.selectedRoot,
          rootCandidates: olderInstall.inspection.rootCandidates,
          classification: olderInstall.inspection.classification
        }, null, 2)),
        contentType: 'application/json'
      });
      await testInfo.attach('github-older-server-pack-preflight-selections.json', {
        body: Buffer.from(JSON.stringify(installReview.selections, null, 2)),
        contentType: 'application/json'
      });
      await harness.executeReviewedPlan(page, installReview, {
        acceptEula: true,
        startAfterInstall: false,
        maxPollLatencyMs: 10_000
      });
      expectPublisherInstallScriptsRemoved(lifecycle.serverPath);
      const installedState = await expectExactInstalledRelease(page, instance.instanceId, olderRelease);
      harness.createUnmanagedSentinel(lifecycle);
      expect(harness.assertUnmanagedSentinel(lifecycle).relativePath).toBe(harness.UNMANAGED_SENTINEL_RELATIVE_PATH);

      const installedStarted = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(installedStarted).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      expect(installedStarted.serverSettings).toMatchObject({ port: lifecycle.serverPort });
      await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);
      const upgradeSourceRevision = await harness.readServerContentRevision(page, instance.instanceId);

      const newerInstall = await inspectExactServerArchive(page, {
        release: newerRelease,
        selectAsset: harness.selectKnownServerAsset,
        expectedFileName: harness.REAL_GITHUB_SERVER_PACK.assetFileName,
        evidenceLabel: 'github-newer-update',
        testInfo
      });
      const rememberedNewerAssets = await harness.invokeModpack(page, 'modpacks:list-github-assets', {
        repositoryId: newerRelease.repositoryId,
        releaseId: newerRelease.releaseId,
        serverId: instance.instanceId
      });
      expect(rememberedNewerAssets.suggestedAssetIds).toEqual([harness.REAL_GITHUB_SERVER_PACK.assetId]);
      await harness.invokeModpack(page, 'modpacks:check-updates', { force: true });
      const githubNotifications = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: true,
        limit: 100
      });
      const updateNotification = githubNotifications.find(notification =>
        notification.serverId === instance.instanceId &&
        notification.type === 'update-available' &&
        notification.source?.provider === 'github' &&
        notification.source?.sourceId === newerRelease.repositoryId &&
        notification.release?.releaseId === newerRelease.releaseId
      );
      expect(updateNotification).toMatchObject({
        release: { releaseId: newerRelease.releaseId, version: newerRelease.tagName, prerelease: false },
        action: { actionId: 'open-details' }
      });
      const updateReview = await reviewExactServerArchive(page, {
        instanceId: instance.instanceId,
        release: newerRelease,
        asset: newerInstall.asset,
        inspection: newerInstall.inspection,
        operationKind: 'update'
      });
      await harness.executeReviewedPlan(page, updateReview, {
        acceptEula: true,
        startAfterInstall: false,
        maxPollLatencyMs: 10_000
      });
      expectPublisherInstallScriptsRemoved(lifecycle.serverPath);
      const updatedState = await expectExactInstalledRelease(page, instance.instanceId, newerRelease);
      harness.assertUnmanagedSentinel(lifecycle);

      const updatedStarted = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(updatedStarted).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      expect(updatedStarted.serverSettings).toMatchObject({ port: lifecycle.serverPort });
      await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);
      const downgradeSourceRevision = await harness.readServerContentRevision(page, instance.instanceId);

      const olderDowngrade = await inspectExactServerArchive(page, {
        release: olderRelease,
        selectAsset: harness.selectKnownOlderServerAsset,
        expectedFileName: harness.REAL_GITHUB_RELEASE_MONITOR.olderAssetFileName,
        evidenceLabel: 'github-older-downgrade',
        testInfo
      });
      const downgradeReview = await reviewExactServerArchive(page, {
        instanceId: instance.instanceId,
        release: olderRelease,
        asset: olderDowngrade.asset,
        inspection: olderDowngrade.inspection,
        operationKind: 'downgrade',
        acknowledgeDowngradeWorldRisk: true
      });
      await harness.executeReviewedPlan(page, downgradeReview, {
        acceptEula: true,
        startAfterInstall: false,
        maxPollLatencyMs: 10_000
      });
      expectPublisherInstallScriptsRemoved(lifecycle.serverPath);
      const downgradedState = await expectExactInstalledRelease(page, instance.instanceId, olderRelease);
      harness.assertUnmanagedSentinel(lifecycle);
      const downgradeHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: instance.instanceId,
        cursor: null,
        limit: 200
      });
      expect(downgradeHistory.items).toContainEqual(expect.objectContaining({
        kind: 'downgrade',
        sourceRevision: downgradeSourceRevision,
        targetRevision: downgradedState.contentRevision,
        restorePointId: expect.any(String)
      }));
      expectExactHistoryTransition(downgradeHistory.items, 'install', 0, installedState.contentRevision);
      expectExactHistoryTransition(downgradeHistory.items, 'upgrade', upgradeSourceRevision, updatedState.contentRevision);
      expectExactHistoryTransition(downgradeHistory.items, 'downgrade', downgradeSourceRevision, downgradedState.contentRevision);

      const downgradedStarted = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(downgradedStarted).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      expect(downgradedStarted.serverSettings).toMatchObject({ port: lifecycle.serverPort });
      await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);

      const evidence = await harness.collectServerEvidence(lifecycle);
      expect(evidence.operationEntries.length).toBeGreaterThanOrEqual(3);
      expect(evidence.latestLog).toMatch(/Done \([0-9.]+s\)!/u);
      expect(evidence.managedState).toContain(olderRelease.releaseId);
      const terminalAudit = await harness.auditCompletedLifecycle(lifecycle);
      const structuredEvidence = {
        releases: {
          installed: olderRelease.releaseId,
          updated: newerRelease.releaseId,
          downgraded: olderRelease.releaseId
        },
        revisions: {
          installed: installedState.contentRevision,
          upgradeSource: upgradeSourceRevision,
          updated: updatedState.contentRevision,
          downgradeSource: downgradeSourceRevision,
          downgraded: downgradedState.contentRevision
        },
        sentinel: harness.assertUnmanagedSentinel(lifecycle),
        terminalAudit
      };
      await testInfo.attach('real-github-releases-final-evidence.json', {
        body: Buffer.from(JSON.stringify(structuredEvidence, null, 2)),
        contentType: 'application/json'
      });
      completed = true;
    } finally {
      if (page && instance) await harness.stopIsolatedServer(page, lifecycle, instance.instanceId).catch(() => {});
      await harness.finalizeRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-github-releases-failure-evidence.json',
          harness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
    }
  });
});
