import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import githubHarness from './fixtures/real-github-releases-harness.cjs';
import harness from './fixtures/real-modpack-harness.cjs';
import tfgFixture from './fixtures/real-terrafirmagreg-fixture.cjs';

const REAL_TFG_ENV = 'MINECRAFT_CORE_REAL_TFG_E2E';
const REAL_TFG = tfgFixture.selectRealTfgRelease();
const EXPECTED_RUNTIME = REAL_TFG.runtime;

function enabled(environment = process.env) {
  return ['1', 'true'].includes(String(environment[REAL_TFG_ENV] || '').trim().toLowerCase());
}

async function findPinnedRelease(page) {
  let cursor;
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const listing = await harness.invokeModpack(page, 'modpacks:list-github-releases', {
      repositoryUrl: REAL_TFG.repositoryUrl,
      includePrereleases: false,
      ...(cursor ? { cursor } : {})
    });
    const release = listing.releases.find(candidate =>
      candidate.repositoryId === REAL_TFG.repositoryId &&
      candidate.releaseId === REAL_TFG.releaseId &&
      candidate.tagName === REAL_TFG.tagName &&
      candidate.prerelease === false
    );
    if (release) return release;
    cursor = listing.pagination?.nextCursor;
    if (!cursor) return null;
  }
  throw new Error('TerraFirmaGreg release pagination exceeded the E2E safety limit');
}

async function inspectWithProgress(page, request) {
  return page.evaluate(async sourceRequest => {
    const requestId = `inspect-e2e-${crypto.randomUUID()}`;
    const progress = [];
    const listener = event => {
      if (event?.requestId === requestId) progress.push(event);
    };
    window.electron.on('modpacks:inspection-progress', listener);
    try {
      const response = await window.electron.invoke('modpacks:inspect', { ...sourceRequest, requestId });
      return { response, progress };
    } finally {
      window.electron.removeListener('modpacks:inspection-progress', listener);
    }
  }, request);
}

function progressEvidence(progress) {
  const downloads = progress.filter(event => event.phase === 'downloading');
  const measuredDownloads = downloads.filter(event => Number.isSafeInteger(event.transferredBytes));
  return {
    phases: [...new Set(progress.map(event => event.phase))],
    eventCount: progress.length,
    downloadEventCount: downloads.length,
    lastTransferredBytes: measuredDownloads.at(-1)?.transferredBytes ?? null,
    totalBytes: downloads.find(event => Number.isSafeInteger(event.totalBytes))?.totalBytes ?? null
  };
}

function selectedRootForPlanning(inspection) {
  expect(inspection.rootCandidates).toEqual(expect.any(Array));
  if (inspection.selectedRoot === null) return null;
  expect(inspection.selectedRoot).toEqual(expect.any(String));
  expect(inspection.rootCandidates).toContain(inspection.selectedRoot);
  return inspection.selectedRoot;
}

function exactDetectedRuntime(inspection) {
  expect(inspection.classification.runtime).toEqual(EXPECTED_RUNTIME);
  return {
    minecraftVersion: inspection.classification.runtime.minecraftVersion,
    loaderFamily: inspection.classification.runtime.loaderFamily,
    loaderVersion: inspection.classification.runtime.loaderVersion
  };
}

function planningSelections({ inspection, conflictChoices = { paths: {}, categories: {} } }) {
  return {
    optionalFileIds: [],
    conflictChoices,
    acknowledgeMissingProviderDigest: false,
    acknowledgeDowngradeWorldRisk: false,
    selectedRoot: selectedRootForPlanning(inspection),
    runtimeChoice: exactDetectedRuntime(inspection),
    maxRam: 6
  };
}

async function reviewServerpack(page, { instanceId, inspection }) {
  let selections = planningSelections({ inspection });
  let plan = await harness.invokeModpack(page, 'modpacks:preflight', {
    inspectionId: inspection.inspectionId,
    instanceId,
    operationKind: 'install-new',
    selections
  });
  let conflicts = [];
  if (plan.requiresConflictReview === true) {
    conflicts = plan.conflicts;
    selections = planningSelections({
      inspection,
      conflictChoices: harness.approvePackConflictChoices(conflicts)
    });
    plan = await harness.invokeModpack(page, 'modpacks:preflight', {
      inspectionId: inspection.inspectionId,
      instanceId,
      operationKind: 'install-new',
      selections
    });
  }
  expect(plan.requiresConflictReview).not.toBe(true);
  expect(plan.planId).toEqual(expect.any(String));
  expect(plan.planFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  return Object.freeze({ plan, selections, conflicts: Object.freeze([...conflicts]) });
}

function assertPublisherBootstrapWasNotInstalled(serverPath) {
  for (const fileName of [
    'forge-auto-install.txt',
    'minecraft_server.jar',
    'server_starter.conf',
    'start_server.bat',
    'start_server.sh'
  ]) {
    expect(fs.existsSync(path.join(serverPath, fileName)), fileName).toBe(false);
  }
}

test.describe('real TerraFirmaGreg GitHub server-pack lifecycle', () => {
  test.skip(
    !enabled(),
    `Set ${REAL_TFG_ENV}=1 to run the default pinned lifecycle, or also set ${tfgFixture.REAL_TFG_RELEASE_ENV}=0.13.4 for the exact reported serverpack.`
  );

  test(`inspects ${REAL_TFG.tagName} exact assets and installs and boots its serverpack only in a fresh disposable server`, async () => {
    const testInfo = test.info();
    test.setTimeout(3 * 60 * 60_000);
    const lifecycle = await harness.createIsolatedRealLifecycle({
      scratchLabel: `tfg-${REAL_TFG.tagName.replaceAll('.', '-')}`,
      identity: {
        provider: 'github-releases',
        harness: 'real-terrafirmagreg-lifecycle',
        releaseId: REAL_TFG.releaseId,
        tagName: REAL_TFG.tagName
      }
    });
    let electronApp = null;
    let page = null;
    let instance = null;
    let completed = false;
    let terminalAudit = null;
    const inspectionEvidence = {};
    const inspections = new Map();

    try {
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      const release = await findPinnedRelease(page);
      expect(release, `Expected exact release ${REAL_TFG.tagName}`).toBeTruthy();

      const listing = await harness.invokeModpack(page, 'modpacks:list-github-assets', {
        repositoryId: REAL_TFG.repositoryId,
        releaseId: REAL_TFG.releaseId
      });

      for (const expected of REAL_TFG.assets) {
        const asset = listing.assets.find(candidate => candidate.assetId === expected.assetId);
        expect(asset).toMatchObject({
          repositoryId: REAL_TFG.repositoryId,
          releaseId: REAL_TFG.releaseId,
          assetId: expected.assetId,
          fileName: expected.fileName,
          size: String(expected.size),
          installableCandidate: true,
          providerDigest: { algorithm: 'sha256', value: expected.sha256 }
        });

        const { response, progress } = await inspectWithProgress(page, {
          provider: 'github',
          repositoryId: REAL_TFG.repositoryId,
          releaseId: REAL_TFG.releaseId,
          assetIds: [expected.assetId]
        });
        expect(response, JSON.stringify(response?.error || null)).toMatchObject({ ok: true });
        const inspection = response.value;
        expect(inspection).toMatchObject({
          type: 'archive-inspection',
          integrity: 'deferred-to-extraction',
          engineEvidence: { tested: false },
          artifactSet: { completeness: 'verified-complete-set' },
          limitEvidence: { totals: { entryCount: expected.expectedEntryCount } }
        });
        expect(inspection.artifactSet.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
        expect(inspection).not.toHaveProperty('entries');
        selectedRootForPlanning(inspection);

        if (expected.kind === 'serverpack') {
          expect(inspection.classification).toMatchObject({
            kind: 'prepared-server-pack',
            confidence: 'exact',
            blocked: false,
            runtime: EXPECTED_RUNTIME,
            suppliedBootstrapExecuted: false,
            evidence: expect.arrayContaining([
              expect.objectContaining({ kind: 'forge-auto-install-config' })
            ])
          });
        } else {
          expect(inspection.classification).toMatchObject({
            kind: 'multimc-client-only',
            confidence: 'exact',
            blocked: true,
            reasonCode: 'client-launcher-instance',
            evidence: expect.arrayContaining([
              expect.objectContaining({ kind: 'multimc-instance-config' }),
              expect.objectContaining({ kind: 'multimc-pack-manifest' }),
              expect.objectContaining({ kind: 'minecraft-client-root' })
            ])
          });
        }

        expect(progress[0]).toMatchObject({ phase: 'resolving' });
        expect(progress).toContainEqual(expect.objectContaining({
          phase: 'downloading',
          totalBytes: expected.size
        }));
        expect(progress.at(-1)).toMatchObject({ phase: 'complete' });
        expect(progress).not.toContainEqual(expect.objectContaining({ phase: 'test' }));
        const downloaded = progress.filter(event =>
          event.phase === 'downloading' && Number.isSafeInteger(event.transferredBytes)
        );
        expect(downloaded.length).toBeGreaterThan(0);
        expect(downloaded.at(-1).transferredBytes).toBe(expected.size);

        inspections.set(expected.kind, { asset, inspection });
        inspectionEvidence[expected.kind] = {
          assetId: expected.assetId,
          inspectionId: inspection.inspectionId,
          selectedRoot: inspection.selectedRoot,
          rootCandidates: inspection.rootCandidates,
          totals: inspection.limitEvidence.totals,
          classification: inspection.classification,
          progress: progressEvidence(progress)
        };
        console.log(`[real-tfg] inspected ${expected.kind}: ${JSON.stringify({
          classification: inspection.classification.kind,
          blocked: inspection.classification.blocked,
          entries: inspection.limitEvidence.totals.entryCount,
          selectedRoot: inspection.selectedRoot,
          progress: inspectionEvidence[expected.kind].progress
        })}`);
      }

      instance = await harness.reserveIsolatedServerDestination(electronApp, page, lifecycle);
      expect(instance.serverPath).toBe(lifecycle.serverPath);
      expect(path.dirname(instance.serverPath)).toBe(lifecycle.root);

      const multimc = inspections.get('multimc');
      let blockedPlan = null;
      if (multimc) {
        const multimcClientRoot = multimc.inspection.rootCandidates.find(candidate =>
          candidate.toLocaleLowerCase('en-US') === '.minecraft'
        );
        expect(multimcClientRoot).toEqual(expect.any(String));
        blockedPlan = await harness.invoke(page, 'modpacks:preflight', {
          inspectionId: multimc.inspection.inspectionId,
          instanceId: instance.instanceId,
          operationKind: 'install-new',
          selections: {
            optionalFileIds: [],
            conflictChoices: { paths: {}, categories: {} },
            acknowledgeMissingProviderDigest: false,
            acknowledgeDowngradeWorldRisk: false,
            selectedRoot: multimcClientRoot,
            runtimeChoice: { ...EXPECTED_RUNTIME },
            maxRam: 6
          }
        });
        expect(blockedPlan).toMatchObject({
          ok: false,
          error: { code: 'CLIENT_ONLY_PACK' }
        });
      }

      const serverpack = inspections.get('serverpack');
      const reviewed = await reviewServerpack(page, {
        instanceId: instance.instanceId,
        inspection: serverpack.inspection
      });
      expect(reviewed.plan.planView).toMatchObject({
        source: {
          provider: 'github',
          repositoryId: REAL_TFG.repositoryId,
          releaseId: REAL_TFG.releaseId,
          version: REAL_TFG.tagName
        },
        runtime: {
          minecraft: EXPECTED_RUNTIME.minecraftVersion,
          loader: EXPECTED_RUNTIME.loaderFamily,
          loaderVersion: EXPECTED_RUNTIME.loaderVersion,
          java: 17
        },
        resources: { maxRam: 6 }
      });

      const job = await harness.executeReviewedPlan(page, reviewed, {
        acceptEula: true,
        startAfterInstall: false,
        timeoutMs: 90 * 60_000,
        maxPollLatencyMs: 10_000
      });
      expect(job).toMatchObject({ phase: 'completed' });
      assertPublisherBootstrapWasNotInstalled(lifecycle.serverPath);
      expect(fs.readFileSync(path.join(lifecycle.serverPath, 'eula.txt'), 'utf8')).toMatch(/^eula=true\s*$/mu);

      const installedState = await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: instance.instanceId
      });
      expect(installedState).toMatchObject({
        source: {
          provider: 'github',
          repositoryId: REAL_TFG.repositoryId,
          releaseId: REAL_TFG.releaseId,
          version: REAL_TFG.tagName
        },
        runtime: EXPECTED_RUNTIME
      });

      const started = await harness.startIsolatedServer(page, lifecycle, instance.instanceId, {
        maxRam: 6,
        timeoutMs: 45 * 60_000,
        pollMs: 2_000
      });
      expect(started).toMatchObject({
        instanceId: instance.instanceId,
        isRunning: true,
        status: 'running',
        serverSettings: { port: lifecycle.serverPort }
      });
      const runningStatuses = await harness.invoke(page, 'get-all-server-statuses', {});
      expect(runningStatuses.filter(status => status.isRunning === true)).toHaveLength(1);
      expect(runningStatuses.filter(status =>
        status.isRunning === true && status.targetPath === lifecycle.serverPath
      )).toHaveLength(1);
      const stopped = await harness.stopIsolatedServer(page, lifecycle, instance.instanceId, {
        timeoutMs: 5 * 60_000
      });
      expect(stopped.isRunning).toBe(false);

      const serverEvidence = await harness.collectServerEvidence(lifecycle);
      expect(serverEvidence.latestLog).toMatch(/Done \([0-9.]+s\)!/u);
      expect(serverEvidence.managedState).toContain(REAL_TFG.releaseId);
      expect(serverEvidence.operationEntries.length).toBeGreaterThanOrEqual(1);
      console.log(`[real-tfg] lifecycle: ${JSON.stringify({
        planId: reviewed.plan.planId,
        conflictsReviewed: reviewed.conflicts.length,
        jobPhase: job.phase,
        contentRevision: installedState.contentRevision,
        runtime: installedState.runtime,
        ready: true,
        maxRamGiB: 6,
        stopped: stopped.isRunning === false
      })}`);

      await testInfo.attach('real-tfg-lifecycle-before-cleanup.json', {
        body: Buffer.from(JSON.stringify({
          release,
          inspections: inspectionEvidence,
          clientOnlyPreflightError: blockedPlan?.error ?? null,
          preflight: {
            planView: reviewed.plan.planView,
            selections: reviewed.selections,
            conflictCount: reviewed.conflicts.length
          },
          job: {
            jobId: job.jobId,
            phase: job.phase,
            outcome: job.outcome,
            progress: job.progress
          },
          installedState,
          boot: {
            port: lifecycle.serverPort,
            maxRamGiB: 6,
            runningServerCount: 1,
            ready: true,
            stopped: stopped.isRunning === false
          },
          latestLogTail: serverEvidence.latestLog.slice(-16_384)
        }, null, 2)),
        contentType: 'application/json'
      });
      completed = true;
    } finally {
      if (page && instance) {
        await harness.stopIsolatedServer(page, lifecycle, instance.instanceId, {
          timeoutMs: 5 * 60_000
        }).catch(() => {});
      }
      await githubHarness.finalizeRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        closeAndAudit: async (ownedElectronApp, isolatedLifecycle) => {
          await harness.closeProductionElectronAndAudit(ownedElectronApp, isolatedLifecycle);
          if (completed) terminalAudit = await githubHarness.auditCompletedLifecycle(lifecycle);
        },
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-tfg-failure-evidence.json',
          harness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
    }

    expect(terminalAudit).toEqual({
      activeRecoveryEntries: [],
      workspaceEntries: [],
      orphanSiblingEntries: [],
      javaProcesses: []
    });
    console.log(`[real-tfg] cleanup: ${JSON.stringify(terminalAudit)}`);
    await testInfo.attach('real-tfg-terminal-cleanup.json', {
      body: Buffer.from(JSON.stringify(terminalAudit, null, 2)),
      contentType: 'application/json'
    });
  });
});
