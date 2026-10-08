import { expect, test } from '@playwright/test';
import realHarness from './fixtures/real-modpack-harness.cjs';
import disposableHarness from './fixtures/disposable-client-join-harness.cjs';

const enabled = disposableHarness.isDisposableClientJoinEnabled();
const EXPECTED_CLIENT_MRPACK_SHA512 = '01de697916bdfe839c8d73a75aa5e2fb4af700e360de174e7d56c63fe843a82e1be703ffdadf12765cbc37800a55a4425cdd7e034b118e7c69cb9738d260a8d6';
const EXPECTED_CLIENT_PACK_FILE_COUNT = 26;

function reviewedRuntime(review) {
  const runtime = review?.plan?.planView?.runtime;
  if (!runtime || typeof runtime.minecraft !== 'string' || typeof runtime.loader !== 'string' || typeof runtime.loaderVersion !== 'string') {
    throw new Error('The production lifecycle review did not provide a complete public runtime');
  }
  return {
    minecraftVersion: runtime.minecraft,
    loaderFamily: runtime.loader,
    loaderVersion: runtime.loaderVersion
  };
}

test.describe('disposable real Minecraft client join', () => {
  test.skip(!enabled, 'Set MINECRAFT_CORE_REAL_DISPOSABLE_CLIENT_JOIN_E2E=1 to run the disposable real client join proof.');

  test('joins isolated offline Server Optimized 1.20.1 with a synthetic encrypted profile', async () => {
    const testInfo = test.info();
    test.setTimeout(2 * 60 * 60_000);
    const lifecycle = await realHarness.createIsolatedRealLifecycle();
    let electronApp = null;
    let page = null;
    let instance = null;
    let clientLaunchAttempted = false;
    let clientStopped = false;
    let serverStartAttempted = false;
    let serverStopped = false;
    let completed = false;
    const username = disposableHarness.createDisposableUsername();

    try {
      ({ electronApp, page } = await realHarness.launchProductionElectron(lifecycle));
      instance = await realHarness.reserveIsolatedServerDestination(electronApp, page, lifecycle);

      const initial = realHarness.REAL_MODRINTH_LIFECYCLE.versions[0];
      const review = await realHarness.reviewExactModrinthVersion(page, {
        instanceId: instance.instanceId,
        version: initial
      });
      expect(review.plan.planView.source).toMatchObject({
        provider: 'modrinth',
        version: initial.name
      });
      expect(review.plan.planView.runtime).toMatchObject({ minecraft: '1.20.1', loader: 'fabric' });
      await realHarness.executeReviewedPlan(page, review, { startAfterInstall: false });

      const state = await realHarness.invokeModpack(page, 'modpacks:get-state', { serverId: instance.instanceId });
      expect(state.source).toMatchObject({
        provider: 'modrinth',
        projectId: realHarness.REAL_MODRINTH_LIFECYCLE.projectId,
        versionId: initial.id
      });

      const clientPack = await disposableHarness.installExactModrinthClientPack(lifecycle, {
        projectId: realHarness.REAL_MODRINTH_LIFECYCLE.projectId,
        versionId: initial.id,
        expectedMrpackSha512: EXPECTED_CLIENT_MRPACK_SHA512
      });
      expect(clientPack).toMatchObject({
        projectId: realHarness.REAL_MODRINTH_LIFECYCLE.projectId,
        versionId: initial.id,
        mrpackSha512: EXPECTED_CLIENT_MRPACK_SHA512,
        runtime: reviewedRuntime(review)
      });
      expect(clientPack.files).toHaveLength(EXPECTED_CLIENT_PACK_FILE_COUNT);
      expect(clientPack.files.every(file =>
        file.source === 'download' && /^[a-f0-9]{40}$/u.test(file.sha1) && /^[a-f0-9]{128}$/u.test(file.sha512)
      )).toBe(true);
      await expect(disposableHarness.verifyInstalledClientPack(lifecycle, clientPack)).resolves.toBe(true);

      await disposableHarness.configureOfflineServerProperties(lifecycle);
      await disposableHarness.writeSyntheticEncryptedAuth(electronApp, lifecycle, { username });
      const client = await disposableHarness.registerDisposableClient(page, lifecycle, { username });
      expect(client.clientPath).toBe(lifecycle.clientPath);

      serverStartAttempted = true;
      const started = await realHarness.startIsolatedServer(page, lifecycle, instance.instanceId);
      expect(started).toMatchObject({ instanceId: instance.instanceId, isRunning: true });

      const joinBoundary = await disposableHarness.captureLatestLogBoundary(lifecycle);
      clientLaunchAttempted = true;
      const launched = await disposableHarness.launchDisposableClient(page, lifecycle, reviewedRuntime(review));
      expect(launched).toMatchObject({ launcherKind: 'proper', fallbackAttempted: false });
      const join = await disposableHarness.waitForJoinLog(lifecycle, username, { boundary: joinBoundary });
      expect(join.joinLine).toMatch(new RegExp(`: ${username} joined the game$`, 'u'));

      await disposableHarness.stopDisposableClient(page);
      clientStopped = true;
      await disposableHarness.stopDisposableServer(page, lifecycle, instance.instanceId);
      serverStopped = true;
      completed = true;
    } finally {
      if (page && clientLaunchAttempted && !clientStopped) {
        await disposableHarness.stopDisposableClient(page).catch(() => {});
      }
      if (page && instance && serverStartAttempted && !serverStopped) {
        await disposableHarness.stopDisposableServer(page, lifecycle, instance.instanceId).catch(() => {});
      }
      await disposableHarness.finalizeDisposableClientJoin({
        completed,
        close: async () => {
          await realHarness.closeProductionElectronAndAudit(electronApp, lifecycle);
          electronApp = null;
        },
        collectEvidence: () => disposableHarness.collectDisposableJoinEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'disposable-client-join-evidence.json',
          realHarness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
    }
  });
});
