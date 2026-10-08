import { expect, test } from '@playwright/test';
import harness from './fixtures/real-modpack-harness.cjs';

const enabled = harness.isRealLifecycleEnabled();

test.describe('real Modrinth Server Optimized lifecycle', () => {
  test.skip(!enabled, 'Set MINECRAFT_CORE_REAL_MODPACK_E2E=1 to run real Modrinth downloads and Java processes.');

  test('boots after install, runtime switch, and optional downgrade only inside fresh isolated paths', async () => {
    const testInfo = test.info();
    test.setTimeout(3 * 60 * 60_000);
    const lifecycle = await harness.createIsolatedRealLifecycle({
      scratchPrefix: 'minecraft-core-real-modrinth-e2e-',
      identity: { harness: 'modrinth-lifecycle' }
    });
    let electronApp = null;
    let page = null;
    let instance = null;
    let completed = false;

    try {
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      const project = await harness.invokeModpack(page, 'modpacks:get-project', {
        projectId: harness.REAL_MODRINTH_LIFECYCLE.projectId
      });
      expect(project).toMatchObject({
        projectId: harness.REAL_MODRINTH_LIFECYCLE.projectId,
        title: harness.REAL_MODRINTH_LIFECYCLE.projectName
      });
      const completeVersionHistory = await harness.invokeModpack(page, 'modpacks:list-versions', {
        projectId: harness.REAL_MODRINTH_LIFECYCLE.projectId
      });
      expect(completeVersionHistory.map(version => version.versionId)).toEqual(expect.arrayContaining(
        harness.REAL_MODRINTH_LIFECYCLE.versions.map(version => version.id)
      ));
      expect(completeVersionHistory.find(version => version.versionId === 'MEznmVQB')).toMatchObject({
        minecraftVersions: ['1.21.1'], loaders: ['fabric']
      });
      instance = await harness.reserveIsolatedServerDestination(electronApp, page, lifecycle);

      const [initial, patchUpdate, runtimeUpdate] = harness.REAL_MODRINTH_LIFECYCLE.versions;
      const reverseEnabled = harness.isReverseLifecycleEnabled();
      const initialReview = await harness.reviewExactModrinthVersion(page, {
        instanceId: instance.instanceId,
        version: initial
      });
      expect(initialReview.plan.planView.source).toMatchObject({ provider: 'modrinth', version: initial.name });
      await harness.executeReviewedPlan(page, initialReview, { startAfterInstall: false });

      const initialState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(initialState.source).toMatchObject({
        provider: 'modrinth',
        projectId: harness.REAL_MODRINTH_LIFECYCLE.projectId,
        versionId: initial.id
      });

      await harness.invokeModpack(page, 'modpacks:check-updates', { force: true });
      const unreadNotifications = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: true,
        limit: 100
      });
      const updateNotice = unreadNotifications.find(notification =>
        notification.serverId === instance.instanceId &&
        notification.source?.provider === 'modrinth' &&
        notification.source?.sourceId === harness.REAL_MODRINTH_LIFECYCLE.projectId &&
        notification.type === 'update-available'
      );
      expect(updateNotice).toBeTruthy();
      expect(updateNotice.source).toEqual({
        provider: 'modrinth',
        sourceId: harness.REAL_MODRINTH_LIFECYCLE.projectId
      });
      expect(updateNotice.source).not.toHaveProperty('projectId');
      const newestStableVersion = completeVersionHistory
        .filter(version => version.channel === 'release')
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt) ||
          right.versionId.localeCompare(left.versionId, 'en-US'))[0];
      expect(updateNotice.release).toEqual({
        releaseId: newestStableVersion.versionId,
        version: newestStableVersion.version,
        prerelease: false
      });
      await harness.invokeModpack(page, 'modpacks:ack-notification', { notificationId: updateNotice.notificationId });
      const unreadAfterAcknowledgement = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: true,
        limit: 100
      });
      expect(unreadAfterAcknowledgement.some(notification => notification.notificationId === updateNotice.notificationId)).toBe(false);

      await harness.closeProductionElectronAndAudit(electronApp, lifecycle);
      electronApp = null;
      page = null;
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      const unreadAfterRestart = await harness.invokeModpack(page, 'modpacks:list-notifications', {
        unreadOnly: true,
        limit: 100
      });
      expect(unreadAfterRestart.some(notification => notification.notificationId === updateNotice.notificationId)).toBe(false);

      const started = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(started).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      expect(started.serverSettings).toMatchObject({ port: lifecycle.serverPort });
      await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);

      const updateReview = await harness.reviewExactModrinthVersion(page, {
        instanceId: instance.instanceId,
        version: patchUpdate
      });
      expect(updateReview.plan.planView.runtime).toMatchObject({ minecraft: '1.20.1', loader: 'fabric' });
      const updateSourceRevision = updateReview.plan.planView.server.contentRevision;
      await harness.executeReviewedPlan(page, updateReview, { startAfterInstall: false });
      const patchedState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(patchedState.source).toMatchObject({ versionId: patchUpdate.id });
      expect(patchedState.runtime).toMatchObject({ minecraftVersion: '1.20.1', loaderFamily: 'fabric' });
      const patchedStarted = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(patchedStarted).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      expect(patchedStarted.serverSettings).toMatchObject({ port: lifecycle.serverPort });
      await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);

      const runtimeSwitchReview = await harness.reviewExactModrinthVersion(page, {
        instanceId: instance.instanceId,
        version: runtimeUpdate,
        operationKind: 'switch'
      });
      expect(runtimeSwitchReview.plan.planView.runtime).toMatchObject({ minecraft: '1.21.1', loader: 'fabric' });
      const switchSourceRevision = runtimeSwitchReview.plan.planView.server.contentRevision;
      await harness.executeReviewedPlan(page, runtimeSwitchReview, { startAfterInstall: false });

      const switchedState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(switchedState.source).toMatchObject({ versionId: runtimeUpdate.id });
      expect(switchedState.runtime).toMatchObject({ minecraftVersion: '1.21.1', loaderFamily: 'fabric' });

      const switchedStarted = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(switchedStarted).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      expect(switchedStarted.serverSettings).toMatchObject({ port: lifecycle.serverPort });
      await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);

      if (reverseEnabled) {
        const downgradeReview = await harness.reviewExactModrinthVersion(page, {
          instanceId: instance.instanceId,
          version: patchUpdate,
          operationKind: 'downgrade',
          acknowledgeDowngradeWorldRisk: true
        });
        const downgradeSourceRevision = downgradeReview.plan.planView.server.contentRevision;
        await harness.executeReviewedPlan(page, downgradeReview, { startAfterInstall: false });
        const downgradedState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
        expect(downgradedState.source).toMatchObject({ versionId: patchUpdate.id });
        expect(downgradedState.runtime).toMatchObject({ minecraftVersion: '1.20.1', loaderFamily: 'fabric' });
        const downgradeHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
          serverId: instance.instanceId,
          cursor: null,
          limit: 200
        });
        expect(downgradeHistory.items).toContainEqual(expect.objectContaining({
          kind: 'downgrade',
          sourceRevision: downgradeSourceRevision,
          targetRevision: downgradedState.contentRevision,
          restorePointId: expect.any(String),
          sourceRuntime: expect.objectContaining({ minecraftVersion: '1.21.1', loaderFamily: 'fabric' }),
          targetRuntime: expect.objectContaining({ minecraftVersion: '1.20.1', loaderFamily: 'fabric' })
        }));
        expect(downgradeHistory.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'install', targetRevision: initialState.contentRevision }),
          expect.objectContaining({
            kind: 'upgrade',
            sourceRevision: updateSourceRevision,
            targetRevision: patchedState.contentRevision
          }),
          expect.objectContaining({
            kind: 'switch',
            sourceRevision: switchSourceRevision,
            targetRevision: switchedState.contentRevision
          })
        ]));

        const downgradedStarted = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
        expect(downgradedStarted).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
        expect(downgradedStarted.serverSettings).toMatchObject({ port: lifecycle.serverPort });
        await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);
      }

      const evidence = await harness.collectServerEvidence(lifecycle);
      expect(evidence.operationEntries.length).toBeGreaterThanOrEqual(reverseEnabled ? 4 : 3);
      expect(evidence.latestLog).toMatch(/Done \([0-9.]+s\)!/u);
      expect(evidence.managedState).toContain(reverseEnabled ? patchUpdate.id : runtimeUpdate.id);
      completed = true;
    } finally {
      if (page && instance) await harness.stopIsolatedServer(page, lifecycle, instance.instanceId).catch(() => {});
      await harness.finalizeIsolatedRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-lifecycle-failure-evidence.json',
          harness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
      electronApp = null;
    }
  });
});
