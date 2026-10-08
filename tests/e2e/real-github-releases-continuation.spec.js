import { expect, test } from '@playwright/test';
import harness from './fixtures/real-github-releases-harness.cjs';
import continuation from './fixtures/preserved-real-github-releases-harness.cjs';

const enabled = continuation.isPreservedGitHubLifecycleEnabled();
const configuredRoot = continuation.getPreservedGitHubLifecycleRoot();

function expectExactTransition(items, kind, sourceRevision, targetRevision) {
  expect(targetRevision).toBe(sourceRevision + 1);
  expect(items).toContainEqual(expect.objectContaining({ kind, sourceRevision, targetRevision }));
}

test.describe('preserved real GitHub Releases lifecycle continuation', () => {
  test.skip(!enabled, `Set ${harness.REAL_GITHUB_RELEASES_ENV}=1 and ${continuation.REAL_GITHUB_CONTINUATION_ROOT_ENV} to the explicit disposable scratch root.`);

  test('proves the completed install-upgrade-downgrade history and boots only the exact downgraded disposable server', async () => {
    const testInfo = test.info();
    test.setTimeout(30 * 60_000);
    let lifecycle = null;
    let electronApp = null;
    let page = null;
    let completed = false;

    try {
      lifecycle = await continuation.loadPreservedGitHubLifecycle(configuredRoot);
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));

      expect((await harness.invokeModpack(page, 'modpacks:list-recovery', {})).items).toEqual([]);
      const state = await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: lifecycle.instanceId
      });
      expect(state).toMatchObject({
        modpackManaged: true,
        contentRevision: 5,
        source: {
          provider: 'github',
          repositoryId: harness.REAL_GITHUB_RELEASE_MONITOR.repositoryId,
          releaseId: harness.REAL_GITHUB_RELEASE_MONITOR.olderReleaseId,
          version: harness.REAL_GITHUB_RELEASE_MONITOR.olderTagName
        },
        runtime: harness.REAL_GITHUB_SERVER_PACK.runtimeChoice
      });
      const sentinel = harness.assertUnmanagedSentinel(lifecycle);

      const history = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: lifecycle.instanceId,
        cursor: null,
        limit: 200
      });
      expectExactTransition(history.items, 'install', 0, 1);
      expectExactTransition(history.items, 'upgrade', 2, 3);
      expectExactTransition(history.items, 'downgrade', 4, 5);
      expect(history.items).toContainEqual(expect.objectContaining({
        kind: 'downgrade',
        restorePointId: expect.any(String),
        sourceRuntime: expect.objectContaining(harness.REAL_GITHUB_SERVER_PACK.runtimeChoice),
        targetRuntime: expect.objectContaining(harness.REAL_GITHUB_SERVER_PACK.runtimeChoice)
      }));

      const started = await continuation.startPreservedServer(page, lifecycle);
      expect(started).toMatchObject({
        instanceId: lifecycle.instanceId,
        isRunning: true,
        serverSettings: { port: lifecycle.serverPort }
      });
      await harness.stopIsolatedServer(page, lifecycle, lifecycle.instanceId);

      const evidence = await harness.collectServerEvidence(lifecycle);
      expect(evidence.latestLog).toMatch(/Done \([0-9.]+s\)!/u);
      expect(evidence.managedState).toContain(harness.REAL_GITHUB_RELEASE_MONITOR.olderReleaseId);
      const terminalAudit = await harness.auditCompletedLifecycle(lifecycle);
      await testInfo.attach('preserved-real-github-releases-evidence.json', {
        body: Buffer.from(JSON.stringify({ state, history: history.items, sentinel, terminalAudit }, null, 2)),
        contentType: 'application/json'
      });
      completed = true;
    } finally {
      if (page && lifecycle) {
        await harness.stopIsolatedServer(page, lifecycle, lifecycle.instanceId).catch(() => {});
      }
      if (lifecycle) {
        await harness.finalizeRealLifecycle({
          completed,
          electronApp,
          lifecycle,
          collectEvidence: () => harness.collectServerEvidence(lifecycle),
          attachEvidence: evidence => testInfo.attach(
            'real-github-releases-continuation-failure-evidence.json',
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
