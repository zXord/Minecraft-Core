import { expect, test } from '@playwright/test';
import harness from './fixtures/real-modpack-harness.cjs';
import continuation from './fixtures/preserved-real-modrinth-harness.cjs';

const enabled = continuation.isPreservedLifecycleContinuationEnabled();
const configuredRoot = continuation.getPreservedLifecycleRoot();

async function recoverValidatedDisposableServer(page, lifecycle) {
  const recoveryPage = await harness.invokeModpack(page, 'modpacks:list-recovery', {});
  if (recoveryPage.items.length === 0) return null;
  expect(recoveryPage.items).toHaveLength(1);
  const [recovery] = recoveryPage.items;
  expect(recovery).toMatchObject({
    serverId: lifecycle.instanceId,
    automaticPossible: true
  });
  const recommended = recovery.actions.filter(action => action.recommended === true);
  expect(recommended).toHaveLength(1);
  expect(['retry-recovery', 'retry-cleanup']).toContain(recommended[0].actionId);
  const result = await harness.invokeModpack(page, 'modpacks:recover', {
    recoveryId: recovery.recoveryId,
    actionId: recommended[0].actionId
  });
  expect(result).toMatchObject({
    recoveryId: recovery.recoveryId,
    serverId: lifecycle.instanceId,
    actionId: recommended[0].actionId,
    resolved: true,
    status: 'resolved',
    operationStateReconciled: true
  });
  expect((await harness.invokeModpack(page, 'modpacks:list-recovery', {})).items).toEqual([]);
  return { phase: recovery.phase, actionId: recommended[0].actionId };
}

test.describe('preserved real Modrinth lifecycle continuation', () => {
  test.skip(!enabled, `Set ${harness.REAL_LIFECYCLE_ENV}=1 and ${continuation.REAL_CONTINUATION_ROOT_ENV} to the explicit disposable scratch root.`);

  test('updates, switches runtime, restores a downgrade, and boots only the validated disposable server', async () => {
    const testInfo = test.info();
    test.setTimeout(5 * 60 * 60_000);
    let lifecycle = null;
    let electronApp = null;
    let page = null;
    let completed = false;

    try {
      lifecycle = await continuation.loadPreservedRealLifecycle(configuredRoot);
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));

      if (await recoverValidatedDisposableServer(page, lifecycle)) {
        await harness.closeProductionElectron(electronApp);
        electronApp = null;
        page = null;
        ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
        expect((await harness.invokeModpack(page, 'modpacks:list-recovery', {})).items).toEqual([]);
      }

      const [initial, patchUpdate, runtimeUpdate] = harness.REAL_MODRINTH_LIFECYCLE.versions;
      let currentState = await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: lifecycle.instanceId
      });
      expect(currentState.source).toMatchObject({
        provider: 'modrinth',
        projectId: harness.REAL_MODRINTH_LIFECYCLE.projectId
      });
      const historyBeforeResume = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: lifecycle.instanceId,
        cursor: null,
        limit: 200
      });
      const alreadyDowngraded = historyBeforeResume.items.some(item => item.kind === 'downgrade');

      let patchedState = null;
      if (currentState.source.versionId === initial.id) {
        expect(currentState.runtime).toMatchObject({ minecraftVersion: '1.20.1', loaderFamily: 'fabric' });
        const patchReview = await harness.reviewExactModrinthVersion(page, {
          instanceId: lifecycle.instanceId,
          version: patchUpdate,
          operationKind: 'update'
        });
        expect(patchReview.plan.planView.runtime).toMatchObject({ minecraft: '1.20.1', loader: 'fabric' });
        await harness.executeReviewedPlan(page, patchReview, { startAfterInstall: false });
        currentState = await harness.invokeModpack(page, 'modpacks:get-state', {
          serverId: lifecycle.instanceId
        });
      }
      if (currentState.source.versionId === patchUpdate.id) patchedState = currentState;
      if (!patchedState && currentState.source.versionId !== runtimeUpdate.id) {
        throw new Error(`Preserved lifecycle has an unexpected exact version: ${currentState.source.versionId}`);
      }
      if (patchedState) {
      expect(patchedState.source).toMatchObject({ versionId: patchUpdate.id });
      expect(patchedState.runtime).toMatchObject({ minecraftVersion: '1.20.1', loaderFamily: 'fabric' });
      }

      let switchedState = currentState.source.versionId === runtimeUpdate.id ? currentState : null;
      let downgradedState = alreadyDowngraded ? currentState : null;
      if (!alreadyDowngraded) {
        if (!switchedState) {
          const switchReview = await harness.reviewExactModrinthVersion(page, {
            instanceId: lifecycle.instanceId,
            version: runtimeUpdate,
            operationKind: 'switch'
          });
          expect(switchReview.plan.planView.runtime).toMatchObject({ minecraft: '1.21.1', loader: 'fabric' });
          await harness.executeReviewedPlan(page, switchReview, { startAfterInstall: false });
          switchedState = await harness.invokeModpack(page, 'modpacks:get-state', {
            serverId: lifecycle.instanceId
          });
        }
        expect(switchedState.source).toMatchObject({ versionId: runtimeUpdate.id });
        expect(switchedState.runtime).toMatchObject({ minecraftVersion: '1.21.1', loaderFamily: 'fabric' });

        const downgradeReview = await harness.reviewExactModrinthVersion(page, {
          instanceId: lifecycle.instanceId,
          version: patchUpdate,
          operationKind: 'downgrade',
          acknowledgeDowngradeWorldRisk: true
        });
        await harness.executeReviewedPlan(page, downgradeReview, { startAfterInstall: false });
        downgradedState = await harness.invokeModpack(page, 'modpacks:get-state', {
          serverId: lifecycle.instanceId
        });
      }
      expect(downgradedState.source).toMatchObject({ versionId: patchUpdate.id });
      expect(downgradedState.runtime).toMatchObject({ minecraftVersion: '1.20.1', loaderFamily: 'fabric' });
      const downgradeHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: lifecycle.instanceId,
        cursor: null,
        limit: 200
      });
      expect(downgradeHistory.items).toContainEqual(expect.objectContaining({
        kind: 'downgrade',
        sourceRevision: switchedState?.contentRevision || expect.any(Number),
        targetRevision: downgradedState.contentRevision,
        restorePointId: expect.any(String),
        sourceRuntime: expect.objectContaining({ minecraftVersion: '1.21.1', loaderFamily: 'fabric' }),
        targetRuntime: expect.objectContaining({ minecraftVersion: '1.20.1', loaderFamily: 'fabric' })
      }));

      const started = await continuation.startPreservedServer(page, lifecycle);
      expect(started).toMatchObject({ instanceId: lifecycle.instanceId, isRunning: true });
      await harness.stopIsolatedServer(page, lifecycle, lifecycle.instanceId);

      const evidence = await harness.collectServerEvidence(lifecycle);
      expect(evidence.operationEntries.length).toBeGreaterThanOrEqual(4);
      expect(evidence.latestLog).toMatch(/Done \([0-9.]+s\)!/u);
      expect(evidence.managedState).toContain(patchUpdate.id);
      completed = true;
    } finally {
      if (page && lifecycle) {
        await harness.stopIsolatedServer(page, lifecycle, lifecycle.instanceId).catch(() => {});
      }
      await harness.closeProductionElectron(electronApp);
      if (lifecycle && !completed) {
        const evidence = await harness.collectServerEvidence(lifecycle).catch(() => null);
        await testInfo.attach('preserved-real-lifecycle-root.txt', {
          body: Buffer.from(`${lifecycle.root}\n${evidence ? lifecycle.evidencePath : ''}\n`),
          contentType: 'text/plain'
        });
      }
      if (lifecycle) await lifecycle.dispose({ preserveRoot: !completed });
    }
  });
});
