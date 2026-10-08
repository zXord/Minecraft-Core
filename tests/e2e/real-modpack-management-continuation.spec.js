import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import guardedCleanup from './fixtures/real-modpack-crash-recovery-cleanup.cjs';
import harness from './fixtures/real-modpack-harness.cjs';
import continuation from './fixtures/preserved-real-modrinth-management-harness.cjs';

const configuredRoot = continuation.getPreservedManagementRoot(process.env);
const enabled = continuation.isPreservedManagementContinuationEnabled(process.env);

function scratchChild(lifecycle, candidate) {
  const root = path.resolve(lifecycle.root);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Refusing to use a path outside the disposable management root');
  return resolved;
}

function digestFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function managedModEntry(lifecycle) {
  const stateRoot = scratchChild(lifecycle, path.join(lifecycle.serverPath, '.minecraft-core-state'));
  const state = JSON.parse(await fsp.readFile(path.join(stateRoot, 'modpack.json'), 'utf8'));
  if (typeof state.manifestId !== 'string') throw new Error('Managed state did not identify its immutable manifest');
  const manifestPath = scratchChild(lifecycle, path.join(stateRoot, 'manifests', `${state.manifestId}.json`));
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const entry = manifest.entries?.find(candidate => candidate?.origin === 'pack' &&
    candidate?.managementPolicy === 'replaceable-managed' && candidate?.role === 'mod' &&
    typeof candidate.path === 'string' && candidate.path.startsWith('mods/'));
  if (!entry) throw new Error('The restored pack did not expose a replaceable managed mod');
  return {
    entry,
    filePath: scratchChild(lifecycle, path.join(lifecycle.serverPath, ...entry.path.split('/')))
  };
}

async function verifyManaged(page, instanceId) {
  const queued = await harness.invokeModpack(page, 'modpacks:verify', { serverId: instanceId });
  return harness.waitForJob(page, queued.jobId);
}

async function reviewManagement(page, { instanceId, operationKind, selectionRef = null }) {
  const plan = await harness.invokeModpack(page, 'modpacks:preflight-management', {
    serverId: instanceId,
    operationKind,
    ...(selectionRef === null ? {} : { selectionRef })
  });
  return { plan };
}

async function recoverSolePreSwapRollback(page, lifecycle) {
  const recoveryPage = await harness.invokeModpack(page, 'modpacks:list-recovery', {});
  expect(recoveryPage.items).toHaveLength(1);
  const recovery = recoveryPage.items[0];
  expect(recovery).toMatchObject({
    serverId: lifecycle.instanceId,
    instanceId: lifecycle.instanceId,
    operationKind: 'rollback',
    phase: 'validating-candidate',
    automaticPossible: true
  });
  expect(recovery.actions).toHaveLength(1);
  expect(recovery.actions[0]).toMatchObject({ actionId: 'retry-recovery', recommended: true });
  const recommended = recovery.actions.filter(action => action.recommended === true);
  expect(recommended).toHaveLength(1);
  expect(recommended[0].actionId).toBe('retry-recovery');

  const result = await harness.invokeModpack(page, 'modpacks:recover', {
    recoveryId: recovery.recoveryId,
    actionId: 'retry-recovery'
  });
  expect(result).toEqual({
    recoveryId: recovery.recoveryId,
    serverId: lifecycle.instanceId,
    actionId: 'retry-recovery',
    resolved: true,
    status: 'resolved',
    operationStateReconciled: true
  });
  expect((await harness.invokeModpack(page, 'modpacks:list-recovery', {})).items).toEqual([]);
}

test.describe('preserved real Modrinth management continuation', () => {
  test.skip(!enabled, `Set MINECRAFT_CORE_REAL_MODPACK_MANAGEMENT_E2E=1 and ${continuation.MANAGEMENT_CONTINUATION_ROOT_ENV} to the explicit disposable management root.`);

  test('recovers the pre-swap failure, then rolls back, detaches, restores, boots, and uninstalls', async () => {
    const testInfo = test.info();
    test.setTimeout(4 * 60 * 60_000);
    let lifecycle = null;
    let electronApp = null;
    let page = null;
    let scenarioAssertionsPassed = false;
    let terminalRootDisposed = false;

    try {
      lifecycle = await continuation.loadPreservedRealManagementLifecycle(configuredRoot);
      if (lifecycle.managementCompleted) {
        const completed = await lifecycle.auditCompletedManagementLifecycle();
        expect(completed).toMatchObject({
          authorized: true,
          state: { modpackManaged: false, lifecycleMode: 'files-only', contentRevision: 10 },
          managedFilePaths: { length: 455 },
          rollbackOperationId: expect.any(String),
          uninstallOperationId: expect.any(String)
        });
        expect(await fsp.readFile(lifecycle.checkpoint.worldSentinelPath, 'utf8')).toBe(
          lifecycle.checkpoint.worldSentinelText
        );
        scenarioAssertionsPassed = true;
        await lifecycle.dispose({ preserveRoot: false });
        terminalRootDisposed = true;
        return;
      }
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));

      if (lifecycle.requiresRecovery) {
        await recoverSolePreSwapRollback(page, lifecycle);
        await harness.closeProductionElectron(electronApp);
        electronApp = null;
        page = null;
        ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      }
      expect((await harness.invokeModpack(page, 'modpacks:list-recovery', {})).items).toEqual([]);
      if (!lifecycle.rollbackCompleted) {
        const recovered = await continuation.auditRecoveredManagementLifecycle(lifecycle);
        expect(recovered.state).toMatchObject({
          modpackManaged: true,
          contentRevision: lifecycle.checkpoint.sourceRevision,
          source: { versionId: lifecycle.checkpoint.currentVersionId },
          runtime: lifecycle.checkpoint.currentRuntime
        });
        expect(await fsp.readFile(lifecycle.checkpoint.worldSentinelPath, 'utf8')).toBe(
          lifecycle.checkpoint.worldSentinelText
        );

        const rollbackReview = await reviewManagement(page, {
          instanceId: lifecycle.instanceId,
          operationKind: 'rollback-restore-point',
          selectionRef: lifecycle.checkpoint.upgradeRestorePointId
        });
        await harness.executeReviewedPlan(page, rollbackReview, {
          startAfterInstall: false,
          restorePointId: lifecycle.checkpoint.upgradeRestorePointId
        });
      }
      let managedAfterRollback;
      let detachRestorePointId;
      if (lifecycle.detachCompleted) {
        expect(lifecycle.rollbackCompleted).toBe(true);
        const detachedAudit = await lifecycle.auditDetachedManagementLifecycle();
        expect(detachedAudit).toMatchObject({
          state: {
            modpackManaged: false,
            contentRevision: lifecycle.checkpoint.detachRevision,
            source: { versionId: lifecycle.checkpoint.initialVersionId },
            runtime: lifecycle.checkpoint.initialRuntime
          },
          restorePointId: lifecycle.checkpoint.detachRestorePointId
        });
        const detachedState = await harness.invokeModpack(page, 'modpacks:get-state', {
          serverId: lifecycle.instanceId
        });
        expect(detachedState).toMatchObject({
          modpackManaged: false,
          lifecycleMode: 'detached',
          contentRevision: lifecycle.checkpoint.detachRevision,
          source: { versionId: lifecycle.checkpoint.initialVersionId },
          runtime: lifecycle.checkpoint.initialRuntime
        });
        managedAfterRollback = { filePath: detachedAudit.managedModPath };
        detachRestorePointId = lifecycle.checkpoint.detachRestorePointId;
        const detachedHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
          serverId: lifecycle.instanceId,
          cursor: null,
          limit: 200
        });
        expect(detachedHistory.items).toContainEqual(expect.objectContaining({
          kind: 'rollback',
          outcome: 'completed',
          sourceRevision: lifecycle.checkpoint.rollbackSourceRevision,
          targetRevision: lifecycle.checkpoint.rollbackRevision
        }));
        expect(detachedHistory.items).toContainEqual(expect.objectContaining({
          kind: 'detach',
          outcome: 'completed',
          sourceRevision: lifecycle.checkpoint.rollbackRevision,
          targetRevision: lifecycle.checkpoint.detachRevision,
          restorePointId: detachRestorePointId,
          restorePointSha256: lifecycle.checkpoint.detachRestorePointSha256
        }));
      } else {
        const rolledBackState = await harness.invokeModpack(page, 'modpacks:get-state', {
          serverId: lifecycle.instanceId
        });
        expect(rolledBackState).toMatchObject({
          modpackManaged: true,
          lifecycleMode: 'managed',
          contentRevision: lifecycle.checkpoint.rollbackRevision,
          source: { versionId: lifecycle.checkpoint.initialVersionId },
          runtime: lifecycle.checkpoint.initialRuntime
        });
        expect(await fsp.readFile(lifecycle.checkpoint.worldSentinelPath, 'utf8')).toBe(
          lifecycle.checkpoint.worldSentinelText
        );
        const rolledBackAudit = await lifecycle.auditRolledBackManagementLifecycle();
        expect(rolledBackAudit).toMatchObject({
          state: {
            modpackManaged: true,
            contentRevision: lifecycle.checkpoint.rollbackRevision,
            source: { versionId: lifecycle.checkpoint.initialVersionId },
            runtime: lifecycle.checkpoint.initialRuntime
          }
        });
        const rollbackHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
          serverId: lifecycle.instanceId,
          cursor: null,
          limit: 200
        });
        expect(rollbackHistory.items).toContainEqual(expect.objectContaining({
          kind: 'rollback',
          outcome: 'completed',
          sourceRevision: lifecycle.checkpoint.rollbackSourceRevision ??
            lifecycle.checkpoint.coordinatorRevision ?? lifecycle.checkpoint.sourceRevision,
          targetRevision: lifecycle.checkpoint.rollbackRevision,
          sourceRuntime: lifecycle.checkpoint.currentRuntime,
          targetRuntime: lifecycle.checkpoint.initialRuntime,
          restorePointId: expect.any(String),
          restorePointSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
        }));
        const healthyAfterRollback = await verifyManaged(page, lifecycle.instanceId);
        expect(healthyAfterRollback.outcome.result).toMatchObject({ healthy: true, repairAvailable: false });
        const rollbackStarted = await harness.startIsolatedServer(page, lifecycle, lifecycle.instanceId);
        expect(rollbackStarted).toMatchObject({ instanceId: lifecycle.instanceId, isRunning: true });
        const rollbackStopped = await harness.stopIsolatedServer(page, lifecycle, lifecycle.instanceId);
        expect(rollbackStopped).toMatchObject({ instanceId: lifecycle.instanceId, isRunning: false });

        managedAfterRollback = await managedModEntry(lifecycle);
        expect(managedAfterRollback.filePath).toBe(rolledBackAudit.managedModPath);
        const beforeDetachDigest = digestFile(managedAfterRollback.filePath);
        const detachReview = await reviewManagement(page, {
          instanceId: lifecycle.instanceId,
          operationKind: 'detach'
        });
        await harness.executeReviewedPlan(page, detachReview, { acceptEula: false, startAfterInstall: false });
        const detachedState = await harness.invokeModpack(page, 'modpacks:get-state', {
          serverId: lifecycle.instanceId
        });
        expect(detachedState).toMatchObject({ modpackManaged: false, lifecycleMode: 'detached' });
        expect(digestFile(managedAfterRollback.filePath)).toBe(beforeDetachDigest);
        expect(await fsp.readFile(lifecycle.checkpoint.worldSentinelPath, 'utf8')).toBe(
          lifecycle.checkpoint.worldSentinelText
        );
        const detachedHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
          serverId: lifecycle.instanceId,
          cursor: null,
          limit: 200
        });
        const detach = detachedHistory.items.find(item => item.kind === 'detach' && item.outcome === 'completed' &&
          typeof item.restorePointId === 'string');
        if (!detach) throw new Error('Detach did not expose its verified safety restore point');
        detachRestorePointId = detach.restorePointId;
      }
      expect(await fsp.readFile(lifecycle.checkpoint.worldSentinelPath, 'utf8')).toBe(
        lifecycle.checkpoint.worldSentinelText
      );
      const restoreDetachReview = await reviewManagement(page, {
        instanceId: lifecycle.instanceId,
        operationKind: 'rollback-restore-point',
        selectionRef: detachRestorePointId
      });
      await harness.executeReviewedPlan(page, restoreDetachReview, {
        startAfterInstall: false,
        restorePointId: detachRestorePointId
      });
      const restoredManagedState = await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: lifecycle.instanceId
      });
      expect(restoredManagedState).toMatchObject({
        modpackManaged: true,
        lifecycleMode: 'managed',
        ...(lifecycle.detachCompleted ? { contentRevision: lifecycle.checkpoint.detachRestoreRevision } : {}),
        source: { versionId: lifecycle.checkpoint.initialVersionId },
        runtime: lifecycle.checkpoint.initialRuntime
      });
      expect(await fsp.readFile(lifecycle.checkpoint.worldSentinelPath, 'utf8')).toBe(
        lifecycle.checkpoint.worldSentinelText
      );
      const healthyAfterDetachRestore = await verifyManaged(page, lifecycle.instanceId);
      expect(healthyAfterDetachRestore.outcome.result).toMatchObject({ healthy: true, repairAvailable: false });
      const detachRestoreStarted = await harness.startIsolatedServer(page, lifecycle, lifecycle.instanceId);
      expect(detachRestoreStarted).toMatchObject({ instanceId: lifecycle.instanceId, isRunning: true });
      const detachRestoreStopped = await harness.stopIsolatedServer(page, lifecycle, lifecycle.instanceId);
      expect(detachRestoreStopped).toMatchObject({ instanceId: lifecycle.instanceId, isRunning: false });

      const uninstallReview = await reviewManagement(page, {
        instanceId: lifecycle.instanceId,
        operationKind: 'uninstall'
      });
      await harness.executeReviewedPlan(page, uninstallReview, { acceptEula: false, startAfterInstall: false });
      const uninstalledState = await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: lifecycle.instanceId
      });
      expect(uninstalledState.modpackManaged).toBe(false);
      expect(fs.existsSync(managedAfterRollback.filePath)).toBe(false);
      expect(await fsp.readFile(lifecycle.checkpoint.worldSentinelPath, 'utf8')).toBe(
        lifecycle.checkpoint.worldSentinelText
      );
      const finalHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: lifecycle.instanceId,
        cursor: null,
        limit: 200
      });
      expect(finalHistory.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'detach', outcome: 'completed' }),
        expect.objectContaining({ kind: 'uninstall', outcome: 'completed' })
      ]));
      expect(finalHistory.items.filter(item => item.kind === 'rollback' && item.outcome === 'completed').length)
        .toBeGreaterThanOrEqual(2);
      expect((await harness.invokeModpack(page, 'modpacks:list-recovery', {})).items).toEqual([]);

      expect(await lifecycle.confirmCompletedManagement({ managedFilePath: managedAfterRollback.filePath }))
        .toMatchObject({ authorized: true });
      scenarioAssertionsPassed = true;
    } finally {
      if (terminalRootDisposed) {
        await harness.closeProductionElectron(electronApp);
        return;
      }
      if (!lifecycle) {
        await harness.closeProductionElectron(electronApp);
      } else {
        await guardedCleanup.finalizeCrashRecoveryRun({
          page,
          electronApp,
          instance: { instanceId: lifecycle.instanceId },
          lifecycle,
          scenarioAssertionsPassed,
          stopServer: harness.stopIsolatedServer,
          listServerStatuses: currentPage => harness.invoke(currentPage, 'get-all-server-statuses'),
          closeElectron: harness.closeProductionElectron,
          preserveEvidence: async () => {
            const evidence = await harness.collectServerEvidence(lifecycle).catch(() => null);
            await testInfo.attach('preserved-real-management-root.txt', {
              body: Buffer.from(`${lifecycle.root}\n${evidence ? lifecycle.evidencePath : ''}\n`),
              contentType: 'text/plain'
            });
          }
        });
      }
    }
  });
});
