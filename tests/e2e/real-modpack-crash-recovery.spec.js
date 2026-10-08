import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import harness from './fixtures/real-modpack-harness.cjs';
import crashCleanup from './fixtures/real-modpack-crash-recovery-cleanup.cjs';
import crashContinuation from './fixtures/real-modpack-crash-recovery-continuation.cjs';
import transactionPaths from '../../electron/services/modpack-lifecycle/server-directory-transaction.cjs';

const { createExistingSiblingPaths } = transactionPaths;

const enabled = ['1', 'true'].includes(String(
  process.env.MINECRAFT_CORE_REAL_MODPACK_CRASH_E2E || ''
).trim().toLowerCase());

async function waitForRecoveredJob(page, jobId, timeoutMs = 3 * 60_000) {
  const startedAt = Date.now();
  let current = null;
  while (Date.now() - startedAt < timeoutMs) {
    current = await harness.invokeModpack(page, 'modpacks:get-job', { jobId });
    if (['rolled-back', 'failed', 'recovery-required'].includes(current.phase)) return current;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Recovered lifecycle job did not become terminal; last phase: ${current?.phase || 'unknown'}`);
}

async function runReviewedRecovery(page, lifecycle) {
  const recoveryPage = await harness.invokeModpack(page, 'modpacks:list-recovery', {});
  expect(recoveryPage.items).toHaveLength(1);
  const [recovery] = recoveryPage.items;
  expect(recovery).toMatchObject({
    serverId: lifecycle.instanceId,
    automaticPossible: true
  });
  const recommended = recovery.actions.filter(action => action.recommended === true);
  expect(recommended).toHaveLength(1);
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
  return recovery;
}

async function assertNoOperationSiblings(lifecycle, jobId) {
  const parent = crashContinuation.resolvePathInsideScratchRoot(
    lifecycle.root,
    path.dirname(lifecycle.serverPath)
  );
  const paths = createExistingSiblingPaths(lifecycle.serverPath, jobId);
  const siblingNames = new Set([
    path.basename(paths.candidatePath),
    path.basename(paths.rollbackPath),
    path.basename(paths.failedPath)
  ]);
  const entries = await fsp.readdir(parent);
  expect(entries.filter(entry => siblingNames.has(entry))).toEqual([]);
}

async function armHardCrashAfterCanonicalMove(electronApp, lifecycle) {
  const markerPath = crashContinuation.resolvePathInsideScratchRoot(
    lifecycle.root,
    path.join(lifecycle.evidencePath, 'hard-crash-fired.json')
  );
  await electronApp.evaluate(async (_electronContext, request) => {
    await new Promise(resolve => setImmediate(resolve));
    const moduleApi = process.getBuiltinModule('node:module');
    const pathApi = process.getBuiltinModule('node:path');
    if (!moduleApi || typeof moduleApi.createRequire !== 'function' || !pathApi) {
      throw new Error('The Electron main process module authority is unavailable');
    }
    const requireFromProject = moduleApi.createRequire(pathApi.join(process.cwd(), 'package.json'));
    const modulePath = pathApi.join(
      process.cwd(), 'electron', 'utils', 'windows-durable-fs-client.cjs'
    );
    const markerModulePath = pathApi.join(
      process.cwd(), 'tests', 'e2e', 'fixtures', 'real-modpack-crash-marker.cjs'
    );
    const transactionModulePath = pathApi.join(
      process.cwd(), 'electron', 'services', 'modpack-lifecycle', 'server-directory-transaction.cjs'
    );
    const { WindowsDurableFsClient } = requireFromProject(modulePath);
    const marker = requireFromProject(markerModulePath);
    const { createExistingSiblingPaths: createSiblingPaths } = requireFromProject(transactionModulePath);
    const prototype = WindowsDurableFsClient.prototype;
    if (prototype.__minecraftCoreRealCrashOriginalMove) {
      throw new Error('The disposable crash boundary is already armed');
    }
    const markerPin = marker.openPinnedCrashMarker(request.markerPath);
    const original = prototype.moveWriteThrough;
    try {
      Object.defineProperty(prototype, '__minecraftCoreRealCrashOriginalMove', {
        configurable: true,
        value: original
      });
    } catch (error) {
      marker.closePinnedCrashMarker(markerPin);
      throw error;
    }
    const target = pathApi.resolve(request.targetPath).toLocaleLowerCase('en-US');
    const targetParent = pathApi.dirname(target);
    const targetLabel = pathApi.basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const legacyRollbackName = new RegExp(
      `^\\.${targetLabel}\\.minecraft-core\\.(job-[A-Za-z0-9_-]{1,123})\\.rollback$`, 'u'
    );
    prototype.moveWriteThrough = function crashAfterCanonicalMove(sourcePath, destinationPath, expectations) {
      const result = original.call(this, sourcePath, destinationPath, expectations);
      const source = pathApi.resolve(sourcePath).toLocaleLowerCase('en-US');
      const destination = pathApi.resolve(destinationPath).toLocaleLowerCase('en-US');
      const destinationName = pathApi.basename(destination);
      const compactMatch = /^\.(op2-[0-9a-f]{32})\.r$/u.exec(destinationName);
      const legacyMatch = legacyRollbackName.exec(destinationName);
      const operationId = compactMatch?.[1] || legacyMatch?.[1] || '';
      const expectedRollback = operationId
        ? pathApi.resolve(createSiblingPaths(request.targetPath, operationId).rollbackPath).toLocaleLowerCase('en-US')
        : '';
      if (source === target && pathApi.dirname(destination) === targetParent && destination === expectedRollback) {
        marker.firePinnedCrashMarkerAndTerminate(markerPin, {
          fired: true,
          rollbackName: destinationName
        });
      }
      return result;
    };
  }, { targetPath: lifecycle.serverPath, markerPath });
  return markerPath;
}

test.describe('real Modrinth hard-crash recovery', () => {
  test.skip(!enabled, 'Set MINECRAFT_CORE_REAL_MODPACK_CRASH_E2E=1 to run the disposable hard-crash recovery proof.');

  test('restores the original exact version after a process kill between durable directory renames', async ({ browserName: _browserName }, testInfo) => {
    void _browserName;
    test.setTimeout(2 * 60 * 60_000);
    const discovered = await crashContinuation.discoverCrashRecoveryContinuation();
    let lifecycle = discovered.lifecycle ?? await harness.createIsolatedRealLifecycle({
      scratchLabel: 'modrinth-crash-recovery',
      identity: crashContinuation.IDENTITY
    });
    let electronApp = null;
    let page = null;
    let instance = lifecycle.resumed
      ? { instanceId: lifecycle.instanceId, serverPath: lifecycle.serverPath }
      : null;
    let scenarioAssertionsPassed = false;
    let crashedJobId = lifecycle.crashedJobId ?? null;
    let initialState = lifecycle.initialState ?? null;

    try {
      const [initial, patchUpdate] = harness.REAL_MODRINTH_LIFECYCLE.versions;
      if (!lifecycle.resumed) {
        ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
        instance = await harness.reserveIsolatedServerDestination(electronApp, page, lifecycle);
        const installReview = await harness.reviewExactModrinthVersion(page, {
          instanceId: instance.instanceId,
          version: initial
        });
        await harness.executeReviewedPlan(page, installReview, { startAfterInstall: false });
        initialState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
        expect(initialState.source).toMatchObject({ provider: 'modrinth', versionId: initial.id });

        const updateReview = await harness.reviewExactModrinthVersion(page, {
          instanceId: instance.instanceId,
          version: patchUpdate
        });
        await crashContinuation.writeCrashRecoveryCheckpoint(lifecycle, {
          instanceId: instance.instanceId,
          initialState,
          initialVersionId: initial.id,
          updateVersionId: patchUpdate.id,
          planFingerprint: updateReview.plan.planFingerprint
        });
        const crashMarker = await armHardCrashAfterCanonicalMove(electronApp, lifecycle);
        const queued = await harness.invokeModpack(page, 'modpacks:start-operation', {
          planId: updateReview.plan.planId,
          planFingerprint: updateReview.plan.planFingerprint,
          choices: { acceptEula: true, startAfterInstall: false, restorePointId: null }
        });
        crashedJobId = queued.jobId;
        await crashContinuation.waitForApplicationClose(electronApp);
        electronApp = null;
        page = null;
        expect(fs.existsSync(crashMarker)).toBe(true);
        const audited = await crashContinuation.loadCrashRecoveryContinuation(lifecycle.root);
        expect(audited.crashedJobId).toBe(crashedJobId);
        lifecycle = audited;
        instance = { instanceId: lifecycle.instanceId, serverPath: lifecycle.serverPath };
        initialState = lifecycle.initialState;
      } else {
        expect(lifecycle.checkpoint.versions).toEqual({
          initialVersionId: initial.id,
          updateVersionId: patchUpdate.id
        });
        expect(fs.existsSync(path.join(lifecycle.evidencePath, crashContinuation.MARKER_NAME))).toBe(true);
      }

      const recoveryLaunchStartedAt = Date.now();
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      expect(Date.now() - recoveryLaunchStartedAt).toBeLessThan(60_000);
      const pendingRecovery = await runReviewedRecovery(page, {
        ...lifecycle,
        instanceId: instance.instanceId
      });
      expect(['swapping', 'committing', 'rolling-back']).toContain(pendingRecovery.phase);
      const recovered = await waitForRecoveredJob(page, crashedJobId);
      expect(recovered).toMatchObject({
        phase: 'rolled-back',
        outcome: { status: 'rolled-back', operationKind: 'update' }
      });
      expect(await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: instance.instanceId
      })).toEqual(initialState);
      await assertNoOperationSiblings(lifecycle, crashedJobId);

      const verified = await harness.invokeModpack(page, 'modpacks:verify', { serverId: instance.instanceId });
      const verification = await harness.waitForJob(page, verified.jobId);
      expect(verification.outcome.result).toMatchObject({ healthy: true, repairAvailable: false });

      await harness.closeProductionElectron(electronApp);
      electronApp = null;
      page = null;
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      expect(await harness.invokeModpack(page, 'modpacks:get-job', { jobId: crashedJobId })).toMatchObject({
        phase: 'rolled-back',
        outcome: { status: 'rolled-back' }
      });
      expect((await harness.invokeModpack(page, 'modpacks:list-recovery', {})).items).toEqual([]);
      expect(await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: instance.instanceId
      })).toEqual(initialState);
      await assertNoOperationSiblings(lifecycle, crashedJobId);

      const started = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(started).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      scenarioAssertionsPassed = true;
    } finally {
      try {
        await crashCleanup.finalizeCrashRecoveryRun({
          page,
          electronApp,
          instance,
          lifecycle,
          scenarioAssertionsPassed,
          stopServer: harness.stopIsolatedServer,
          listServerStatuses: currentPage => harness.invoke(currentPage, 'get-all-server-statuses'),
          closeElectron: harness.closeProductionElectron,
          preserveEvidence: async () => {
            const evidence = await harness.collectServerEvidence(lifecycle).catch(() => null);
            await testInfo.attach('real-crash-recovery-scratch-root.txt', {
              body: Buffer.from(`${lifecycle.root}\n${evidence ? lifecycle.evidencePath : ''}\n${crashedJobId || ''}\n`),
              contentType: 'text/plain'
            });
          }
        });
      } finally {
        await crashContinuation.releasePendingCrashRecoveryLease(lifecycle.root);
      }
    }
  });
});
