import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import harness from './fixtures/real-modpack-harness.cjs';

const enabled = ['1', 'true'].includes(String(process.env.MINECRAFT_CORE_REAL_MODPACK_MANAGEMENT_E2E || '').trim().toLowerCase());

function scratchChild(lifecycle, candidate) {
  const root = path.resolve(lifecycle.root);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Refusing to use a path outside the disposable lifecycle root');
  return resolved;
}

function digestFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function managedModEntry(lifecycle) {
  const statePath = scratchChild(lifecycle, path.join(lifecycle.serverPath, '.minecraft-core-state', 'modpack.json'));
  const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  if (typeof state.manifestId !== 'string') throw new Error('Managed state did not identify its immutable manifest');
  const manifestPath = scratchChild(
    lifecycle,
    path.join(lifecycle.serverPath, '.minecraft-core-state', 'manifests', `${state.manifestId}.json`)
  );
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const entry = manifest.entries?.find(candidate =>
    candidate?.origin === 'pack' &&
    candidate?.managementPolicy === 'replaceable-managed' &&
    candidate?.role === 'mod' &&
    typeof candidate.path === 'string' &&
    candidate.path.startsWith('mods/')
  );
  if (!entry) throw new Error('The installed pack did not expose a replaceable managed mod for repair validation');
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

test.describe('real Modrinth management lifecycle', () => {
  test.skip(!enabled, 'Set MINECRAFT_CORE_REAL_MODPACK_MANAGEMENT_E2E=1 to run destructive lifecycle checks in a fresh disposable server.');

  test('verifies, repairs, rolls back, detaches, restores, and uninstalls without touching an existing instance', async () => {
    const testInfo = test.info();
    test.setTimeout(4 * 60 * 60_000);
    const lifecycle = await harness.createIsolatedRealLifecycle({
      scratchLabel: 'modrinth-management',
      identity: { provider: 'modrinth', scenario: 'management-lifecycle' }
    });
    let electronApp = null;
    let page = null;
    let instance = null;
    let completed = false;

    try {
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      instance = await harness.reserveIsolatedServerDestination(electronApp, page, lifecycle);
      const [initial, patchUpdate] = harness.REAL_MODRINTH_LIFECYCLE.versions;

      const installReview = await harness.reviewExactModrinthVersion(page, {
        instanceId: instance.instanceId,
        version: initial
      });
      await harness.executeReviewedPlan(page, installReview, { startAfterInstall: false });

      const healthyBefore = await verifyManaged(page, instance.instanceId);
      expect(healthyBefore.outcome.result).toMatchObject({ healthy: true, repairAvailable: false });

      const managed = await managedModEntry(lifecycle);
      const originalDigest = digestFile(managed.filePath);
      await fsp.appendFile(managed.filePath, Buffer.from('\nreal-e2e-managed-tamper\n', 'utf8'));
      expect(digestFile(managed.filePath)).not.toBe(originalDigest);

      const unhealthy = await verifyManaged(page, instance.instanceId);
      expect(unhealthy.outcome.result).toMatchObject({ healthy: false, repairAvailable: true });
      expect(unhealthy.outcome.result.mismatches).toEqual(expect.arrayContaining([
        expect.objectContaining({ entryName: managed.entry.path, status: 'modified' })
      ]));

      const repairReview = await harness.reviewExactModrinthVersion(page, {
        instanceId: instance.instanceId,
        version: initial,
        operationKind: 'repair'
      });
      await harness.executeReviewedPlan(page, repairReview, { startAfterInstall: false });
      expect(digestFile(managed.filePath)).toBe(originalDigest);
      const healthyAfterRepair = await verifyManaged(page, instance.instanceId);
      expect(healthyAfterRepair.outcome.result).toMatchObject({ healthy: true, repairAvailable: false });

      const worldSentinel = scratchChild(lifecycle, path.join(lifecycle.serverPath, 'world', 'minecraft-core-real-e2e.keep'));
      await fsp.mkdir(path.dirname(worldSentinel), { recursive: true });
      await fsp.writeFile(worldSentinel, 'unmanaged world data must survive\n', 'utf8');

      const updateReview = await harness.reviewExactModrinthVersion(page, {
        instanceId: instance.instanceId,
        version: patchUpdate
      });
      await harness.executeReviewedPlan(page, updateReview, { startAfterInstall: false });
      const updatedState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(updatedState.source).toMatchObject({ versionId: patchUpdate.id });

      const updateHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: instance.instanceId,
        cursor: null,
        limit: 200
      });
      const upgrade = updateHistory.items.find(item => item.kind === 'upgrade' && typeof item.restorePointId === 'string');
      if (!upgrade) throw new Error('The real update did not expose its verified restore point');
      const rollbackReview = await reviewManagement(page, {
        instanceId: instance.instanceId,
        operationKind: 'rollback-restore-point',
        selectionRef: upgrade.restorePointId
      });
      await harness.executeReviewedPlan(page, rollbackReview, {
        startAfterInstall: false,
        restorePointId: upgrade.restorePointId
      });
      const rolledBackState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(rolledBackState.source).toMatchObject({ versionId: initial.id });
      expect(rolledBackState.runtime).toMatchObject({ minecraftVersion: '1.20.1', loaderFamily: 'fabric' });
      expect(await fsp.readFile(worldSentinel, 'utf8')).toBe('unmanaged world data must survive\n');
      const healthyAfterRollback = await verifyManaged(page, instance.instanceId);
      expect(healthyAfterRollback.outcome.result).toMatchObject({ healthy: true, repairAvailable: false });
      const rolledBackStarted = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(rolledBackStarted).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);
      const managedAfterRollback = await managedModEntry(lifecycle);
      const beforeDetachDigest = digestFile(managedAfterRollback.filePath);

      const detachReview = await reviewManagement(page, {
        instanceId: instance.instanceId,
        operationKind: 'detach'
      });
      await harness.executeReviewedPlan(page, detachReview, { acceptEula: false, startAfterInstall: false });
      const detachedState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(detachedState).toMatchObject({ modpackManaged: false, lifecycleMode: 'detached' });
      expect(digestFile(managedAfterRollback.filePath)).toBe(beforeDetachDigest);
      expect(await fsp.readFile(worldSentinel, 'utf8')).toBe('unmanaged world data must survive\n');

      const detachedHistory = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: instance.instanceId,
        cursor: null,
        limit: 200
      });
      const detach = detachedHistory.items.find(item => item.kind === 'detach' && typeof item.restorePointId === 'string');
      if (!detach) throw new Error('Detach did not expose its safety restore point');
      const restoreDetachReview = await reviewManagement(page, {
        instanceId: instance.instanceId,
        operationKind: 'rollback-restore-point',
        selectionRef: detach.restorePointId
      });
      await harness.executeReviewedPlan(page, restoreDetachReview, {
        startAfterInstall: false,
        restorePointId: detach.restorePointId
      });
      const restoredManagedState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(restoredManagedState).toMatchObject({ modpackManaged: true, lifecycleMode: 'managed' });
      expect(restoredManagedState.source).toMatchObject({ versionId: initial.id });
      const healthyAfterDetachRestore = await verifyManaged(page, instance.instanceId);
      expect(healthyAfterDetachRestore.outcome.result).toMatchObject({ healthy: true, repairAvailable: false });
      const detachRestoreStarted = await harness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(detachRestoreStarted).toMatchObject({ instanceId: instance.instanceId, isRunning: true });
      await harness.stopIsolatedServer(page, lifecycle, instance.instanceId);

      const uninstallReview = await reviewManagement(page, {
        instanceId: instance.instanceId,
        operationKind: 'uninstall'
      });
      await harness.executeReviewedPlan(page, uninstallReview, { acceptEula: false, startAfterInstall: false });
      const uninstalledState = await harness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(uninstalledState.modpackManaged).toBe(false);
      expect(fs.existsSync(managedAfterRollback.filePath)).toBe(false);
      expect(await fsp.readFile(worldSentinel, 'utf8')).toBe('unmanaged world data must survive\n');

      completed = true;
    } finally {
      if (page && instance) await harness.stopIsolatedServer(page, lifecycle, instance.instanceId).catch(() => {});
      await harness.finalizeIsolatedRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-management-failure-evidence.json',
          harness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
    }
  });
});
