import { expect, test } from '@playwright/test';
import harness from './fixtures/real-github-releases-harness.cjs';

const enabled = harness.isRealGitHubReleaseMonitorEnabled();

async function listKnownRelease(page, selector) {
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
  throw new Error('GitHub releases pagination exceeded the release-monitor E2E safety limit.');
}

function trackingRecord({ olderRelease, olderAsset }) {
  const providerDigest = olderAsset?.providerDigest;
  if (providerDigest?.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/u.test(providerDigest.value)) {
    throw new Error('The exact older uploaded server asset has no reviewed SHA-256 provider digest.');
  }
  return {
    trackingId: 'real-github-nomi-176',
    serverId: 'real-github-nomi',
    provider: 'github',
    projectId: null,
    repositoryId: olderRelease.repositoryId,
    githubOwner: 'Nomi-CEu',
    githubRepo: 'Nomi-CEu',
    includePrereleases: false,
    acceptedMapping: null,
    assetPattern: null,
    etag: null,
    lastSuccessfulCheck: null,
    lastFailure: null,
    nextDueAt: '2026-01-01T00:00:00.000Z',
    lastSnapshot: {
      releaseId: olderRelease.releaseId,
      version: olderRelease.tagName,
      prerelease: olderRelease.prerelease,
      publishedAt: olderRelease.publishedAt,
      assetFingerprint: providerDigest.value,
      installable: true
    }
  };
}

test.describe('real GitHub Releases update monitor', () => {
  test.skip(!enabled, `Set ${harness.REAL_GITHUB_RELEASE_MONITOR_ENV}=1 to run this live GitHub metadata-only test.`);

  test('persists a safe update notification from the exact older Nomi uploaded server-pack release', async ({}, testInfo) => {
    test.setTimeout(10 * 60_000);
    const lifecycle = await harness.createIsolatedRealReleaseMonitor();
    let electronApp = null;
    let page = null;
    let completed = false;

    try {
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      const olderRelease = await listKnownRelease(page, harness.selectKnownOlderRelease);
      const newerRelease = await listKnownRelease(page, harness.selectKnownRelease);
      expect(olderRelease, `Expected exact older release ${harness.REAL_GITHUB_RELEASE_MONITOR.olderTagName}`).toBeTruthy();
      expect(newerRelease, `Expected exact newer release ${harness.REAL_GITHUB_SERVER_PACK.tagName}`).toBeTruthy();
      expect(() => harness.assertExactReleaseChronology(olderRelease, newerRelease)).not.toThrow();

      const olderAssets = await harness.invokeModpack(page, 'modpacks:list-github-assets', {
        repositoryId: olderRelease.repositoryId,
        releaseId: olderRelease.releaseId
      });
      const newerAssets = await harness.invokeModpack(page, 'modpacks:list-github-assets', {
        repositoryId: newerRelease.repositoryId,
        releaseId: newerRelease.releaseId
      });
      const olderAsset = harness.selectKnownOlderServerAsset(olderAssets.assets);
      const newerAsset = harness.selectKnownServerAsset(newerAssets.assets);
      expect(olderAsset, `Expected uploaded asset ${harness.REAL_GITHUB_RELEASE_MONITOR.olderAssetFileName}`).toBeTruthy();
      expect(newerAsset, `Expected uploaded asset ${harness.REAL_GITHUB_SERVER_PACK.assetFileName}`).toBeTruthy();
      expect(olderAsset.fileName).not.toMatch(/^source code\b/iu);
      expect(newerAsset.fileName).not.toMatch(/^source code\b/iu);

      const record = trackingRecord({ olderRelease, olderAsset });
      await harness.invokeModpack(page, 'modpacks:update-tracking', record);
      const checked = await harness.invokeModpack(page, 'modpacks:check-updates', {
        trackingId: record.trackingId,
        force: true
      });
      expect(checked).toMatchObject({ checked: true, changed: true, trackingId: record.trackingId });

      const notifications = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: true,
        limit: 100
      });
      const notification = notifications.find(item => item.serverId === record.serverId &&
        item.source?.provider === 'github' && item.source?.sourceId === olderRelease.repositoryId &&
        item.release?.releaseId === newerRelease.releaseId &&
        item.type === 'update-available');
      expect(notification).toBeTruthy();
      expect(notification.release).toEqual({
        releaseId: newerRelease.releaseId,
        version: newerRelease.tagName,
        prerelease: false
      });
      expect(notification.action).toMatchObject({ actionId: 'open-details' });
      expect(notification.action.opaqueRef).toMatch(new RegExp(`^release-review:${record.trackingId}:${newerRelease.releaseId}$`, 'u'));

      await harness.closeProductionElectron(electronApp);
      electronApp = null;
      page = null;
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      const persistedUnread = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: true,
        limit: 100
      });
      const persistedNotification = persistedUnread.find(item => item.notificationId === notification.notificationId);
      expect(persistedNotification).toEqual(notification);
      const safeAction = await harness.invokeModpack(page, 'modpacks:perform-safe-action', notification.action);
      expect(safeAction).toEqual({
        type: 'outcome-action-result',
        actionId: 'open-details',
        status: 'ready',
        destination: {
          kind: 'details',
          targetId: `release:${record.trackingId}:${newerRelease.releaseId}`,
          releaseTarget: {
            serverId: record.serverId,
            provider: 'github',
            sourceId: olderRelease.repositoryId,
            releaseId: newerRelease.releaseId,
            prerelease: false
          }
        }
      });
      const postRestartCheck = await harness.invokeModpack(page, 'modpacks:check-updates', {
        trackingId: record.trackingId,
        force: true
      });
      expect(postRestartCheck).toMatchObject({
        checked: true,
        trackingId: record.trackingId
      });
      const deduplicated = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: false,
        limit: 100
      });
      expect(deduplicated.filter(item => item.notificationId === notification.notificationId)).toHaveLength(1);
      expect(deduplicated.filter(item => item.serverId === record.serverId &&
        item.release?.releaseId === newerRelease.releaseId && item.type === 'update-available')).toHaveLength(1);
      await harness.invokeModpack(page, 'modpacks:ack-notification', {
        notificationId: notification.notificationId
      });

      await harness.closeProductionElectron(electronApp);
      electronApp = null;
      page = null;
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      const unreadAfterRestart = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: true,
        limit: 100
      });
      expect(unreadAfterRestart.some(item => item.notificationId === notification.notificationId)).toBe(false);
      const retainedHistory = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: false,
        limit: 100
      });
      expect(retainedHistory).toContainEqual(expect.objectContaining({
        notificationId: notification.notificationId,
        type: 'update-available',
        read: true
      }));
      completed = true;
    } finally {
      await harness.finalizeRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-github-release-monitor-failure-evidence.json',
          harness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
    }
  });
});
