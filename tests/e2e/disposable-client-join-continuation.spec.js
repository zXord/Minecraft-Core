import { expect, test } from '@playwright/test';
import realHarness from './fixtures/real-modpack-harness.cjs';
import disposableHarness from './fixtures/disposable-client-join-harness.cjs';
import preservedHarness from './fixtures/preserved-real-modrinth-harness.cjs';
import continuation from './fixtures/preserved-disposable-client-join-harness.cjs';

const enabled = continuation.isPreservedDisposableClientJoinEnabled();
const configuredRoot = continuation.getPreservedDisposableClientJoinRoot();

function freshUsername(priorUsername) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const username = disposableHarness.createDisposableUsername();
    if (username !== priorUsername) return username;
  }
  throw new Error('Could not produce a fresh disposable Minecraft username');
}

test.describe('preserved disposable Minecraft client join continuation', () => {
  test.skip(
    !enabled,
    `Set ${disposableHarness.DISPOSABLE_CLIENT_JOIN_ENV}=1 and ${continuation.PRESERVED_DISPOSABLE_CLIENT_JOIN_ROOT_ENV} to the explicit preserved disposable scratch root.`
  );

  test('validates the characterized asset state and joins only the preserved loopback server', async () => {
    const testInfo = test.info();
    test.setTimeout(2 * 60 * 60_000);
    let lifecycle = null;
    let electronApp = null;
    let page = null;
    let clientLaunchAttempted = false;
    let clientStopped = false;
    let serverStartAttempted = false;
    let serverStopped = false;
    let completed = false;

    try {
      lifecycle = await continuation.loadPreservedDisposableClientJoinLifecycle(configuredRoot);
      const username = freshUsername(lifecycle.priorUsername);
      ({ electronApp, page } = await realHarness.launchProductionElectron(lifecycle));

      const initialServerStatus = await realHarness.invoke(page, 'get-server-status', {
        instanceId: lifecycle.instanceId,
        targetPath: lifecycle.serverPath
      });
      expect(initialServerStatus?.isRunning === true || initialServerStatus?.status === 'running').toBe(false);
      const initialClientStatus = await realHarness.invoke(page, 'minecraft-launcher-status');
      expect(initialClientStatus).toMatchObject({ success: true });
      expect(initialClientStatus.status?.isRunning).toBe(false);

      await disposableHarness.configureOfflineServerProperties(lifecycle);
      await disposableHarness.writeSyntheticEncryptedAuth(electronApp, lifecycle, { username });
      const client = await disposableHarness.registerDisposableClient(page, lifecycle, { username });
      expect(client).toMatchObject({
        clientId: disposableHarness.DISPOSABLE_CLIENT_ID,
        clientPath: lifecycle.clientPath
      });
      const persistedInstances = await realHarness.invoke(page, 'get-instances');
      const persistedClient = Array.isArray(persistedInstances)
        ? persistedInstances.find(instance => instance?.type === 'client' &&
          instance?.id === disposableHarness.DISPOSABLE_CLIENT_ID)
        : null;
      expect(persistedClient).toMatchObject({
        id: disposableHarness.DISPOSABLE_CLIENT_ID,
        name: username,
        clientName: username,
        path: lifecycle.clientPath
      });

      serverStartAttempted = true;
      const started = await preservedHarness.startPreservedServer(page, lifecycle);
      expect(started).toMatchObject({ instanceId: lifecycle.instanceId, isRunning: true });

      const joinBoundary = await disposableHarness.captureLatestLogBoundary(lifecycle);
      clientLaunchAttempted = true;
      const launched = await disposableHarness.launchDisposableClient(page, lifecycle, lifecycle.runtime);
      expect(launched).toMatchObject({ launcherKind: 'proper', fallbackAttempted: false });

      const join = await disposableHarness.waitForJoinLog(lifecycle, username, { boundary: joinBoundary });
      expect(join.joinLine).toMatch(new RegExp(`: ${username} joined the game$`, 'u'));

      const repairedAssets = await continuation.auditClientAssets(lifecycle, lifecycle.runtime);
      expect(continuation.assertExpectedRepairedAssets(repairedAssets)).toBe(true);
      await expect(
        continuation.verifyPreservedClientProjection(lifecycle, lifecycle.clientPackProjection)
      ).resolves.toBe(true);

      await disposableHarness.stopDisposableClient(page);
      clientStopped = true;
      await disposableHarness.stopDisposableServer(page, lifecycle, lifecycle.instanceId);
      serverStopped = true;
      completed = true;
    } finally {
      if (page && clientLaunchAttempted && !clientStopped) {
        await disposableHarness.stopDisposableClient(page).catch(() => {});
      }
      if (page && lifecycle && serverStartAttempted && !serverStopped) {
        await disposableHarness.stopDisposableServer(page, lifecycle, lifecycle.instanceId).catch(() => {});
      }
      await realHarness.closeProductionElectron(electronApp);
      if (lifecycle && !completed) {
        const evidence = await disposableHarness.collectDisposableJoinEvidence(lifecycle).catch(() => null);
        await testInfo.attach('preserved-disposable-client-join-root.txt', {
          body: Buffer.from(`${lifecycle.root}\n${evidence ? lifecycle.evidencePath : ''}\n`),
          contentType: 'text/plain'
        });
      }
      if (lifecycle) await lifecycle.dispose({ preserveRoot: !completed });
    }
  });
});
