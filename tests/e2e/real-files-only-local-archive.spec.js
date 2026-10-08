import { expect, test } from '@playwright/test';
import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import githubHarness from './fixtures/real-github-releases-harness.cjs';
import harness from './fixtures/real-modpack-harness.cjs';

const REAL_FILES_ONLY_ENV = 'MINECRAFT_CORE_REAL_FILES_ONLY_E2E';
const WRAPPER_ROOT = 'unusual-layout';
const SAFE_PAYLOAD = Object.freeze({
  'config/files-only.toml': Buffer.from('feature = "files-only"\n', 'utf8'),
  'mods/reviewed-example.jar': Buffer.from('reviewed inert mod bytes\n', 'utf8'),
  'scripts/reviewed-data.zs': Buffer.from('// reviewed data script; not an OS executable\n', 'utf8'),
  'server.properties': Buffer.from('motd=Reviewed files only\nonline-mode=true\n', 'utf8'),
  'world/level.dat': Buffer.from('reviewed disposable world seed\n', 'utf8')
});
const EXCLUDED_ARCHIVE_PATHS = Object.freeze([
  'README.md',
  'bin/publisher-helper.exe',
  'custom-bootstrap.jar',
  'start-publisher.cmd'
]);
const EMPTY_TERMINAL_AUDIT = Object.freeze({
  activeRecoveryEntries: [],
  workspaceEntries: [],
  orphanSiblingEntries: [],
  javaProcesses: []
});

function enabled(environment = process.env) {
  return ['1', 'true'].includes(String(environment[REAL_FILES_ONLY_ENV] || '').trim().toLowerCase());
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function expectNoScratchPath(value, scratchRoot) {
  const rootKey = path.resolve(scratchRoot).replaceAll('\\', '/').toLocaleLowerCase('en-US');
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      expect(current.replaceAll('\\', '/').toLocaleLowerCase('en-US')).not.toContain(rootKey);
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current && typeof current === 'object') {
      pending.push(...Object.values(current));
    }
  }
}

function addDirectory(zip, relativePath) {
  zip.addFile(`${WRAPPER_ROOT}/${relativePath.replace(/\/$/u, '')}/`, Buffer.alloc(0));
}

function createReviewedArchive(lifecycle) {
  const inputRoot = path.join(lifecycle.root, 'inputs');
  const archivePath = path.join(inputRoot, 'generic-unusual-files-only.zip');
  const executionMarkerPath = path.join(lifecycle.root, 'publisher-script-executed.txt');
  fs.mkdirSync(inputRoot);
  const zip = new AdmZip();
  zip.addFile(`${WRAPPER_ROOT}/`, Buffer.alloc(0));
  for (const directory of ['bin', 'config', 'mods', 'scripts', 'world']) addDirectory(zip, directory);
  for (const [relativePath, bytes] of Object.entries(SAFE_PAYLOAD)) {
    zip.addFile(`${WRAPPER_ROOT}/${relativePath}`, bytes);
  }
  const escapedMarker = executionMarkerPath.replaceAll("'", "''");
  zip.addFile(
    `${WRAPPER_ROOT}/start-publisher.cmd`,
    Buffer.from(`@echo off\r\npowershell.exe -NoProfile -Command "Set-Content -LiteralPath '${escapedMarker}' -Value executed"\r\n`, 'utf8')
  );
  zip.addFile(`${WRAPPER_ROOT}/custom-bootstrap.jar`, Buffer.from('untrusted publisher bootstrap\n', 'utf8'));
  zip.addFile(`${WRAPPER_ROOT}/bin/publisher-helper.exe`, Buffer.from('untrusted executable\n', 'utf8'));
  zip.addFile(`${WRAPPER_ROOT}/README.md`, Buffer.from('not part of the reviewed server payload\n', 'utf8'));
  zip.writeZip(archivePath);
  return Object.freeze({
    archivePath,
    archiveSha256: sha256(fs.readFileSync(archivePath)),
    executionMarkerPath
  });
}

function listPublishedPayload(serverPath) {
  const files = [];
  function visit(directory, relative = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(entryPath, { bigint: true });
      expect(stat.isSymbolicLink(), `${entryRelative} must not be a link`).toBe(false);
      if (stat.isDirectory()) visit(entryPath, entryRelative);
      else {
        expect(stat.isFile(), `${entryRelative} must be a regular file`).toBe(true);
        expect(stat.nlink, `${entryRelative} must not be hard-linked`).toBe(1n);
        files.push(entryRelative.replaceAll('\\', '/'));
      }
    }
  }
  visit(serverPath);
  return files;
}

test.describe('real generic files-only local archive publication', () => {
  test.skip(!enabled(), `Set ${REAL_FILES_ONLY_ENV}=1 to run this tiny real-Electron lifecycle test.`);

  test('publishes only reviewed safe files from an unusual layout and persists no managed runtime', async () => {
    const testInfo = test.info();
    test.setTimeout(20 * 60_000);
    const lifecycle = await harness.createIsolatedRealLifecycle({
      scratchLabel: 'files-only',
      identity: { provider: 'local', harness: 'real-files-only-local-archive' }
    });
    const archive = createReviewedArchive(lifecycle);
    let electronApp = null;
    let page = null;
    let completed = false;

    try {
      ({ electronApp, page } = await harness.launchProductionElectron(lifecycle));
      const restoreArchiveDialog = await harness.installIsolatedLocalArchiveDialogOverride(
        electronApp,
        lifecycle,
        archive.archivePath
      );
      let selection;
      try {
        selection = await harness.invokeModpack(page, 'modpacks:select-local-archive', {
          allowMultipart: false
        });
      } finally {
        await restoreArchiveDialog();
      }
      expect(selection).toMatchObject({
        cancelled: false,
        selectionId: expect.any(String),
        files: [{ displayName: path.basename(archive.archivePath), size: expect.any(String) }]
      });
      expectNoScratchPath(selection, lifecycle.root);

      const inspection = await harness.invokeModpack(page, 'modpacks:inspect', {
        provider: 'local',
        selectionId: selection.selectionId
      });
      expect(inspection).toMatchObject({
        type: 'archive-inspection',
        integrity: 'deferred-to-extraction',
        engineEvidence: { tested: false },
        selectedRoot: WRAPPER_ROOT,
        rootCandidates: [WRAPPER_ROOT],
        classification: {
          kind: 'unsupported-runtime-layout',
          confidence: 'exact',
          blocked: true,
          reasonCode: 'custom-bootstrap-required'
        }
      });
      expect(inspection.artifactSet.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(inspection).not.toHaveProperty('entries');

      const instance = await harness.reserveIsolatedServerDestination(electronApp, page, lifecycle);
      expect(instance.serverPath).toBe(lifecycle.serverPath);
      expect(path.dirname(instance.serverPath)).toBe(lifecycle.root);
      const selections = {
        optionalFileIds: [],
        conflictChoices: { paths: {}, categories: {} },
        acknowledgeMissingProviderDigest: false,
        acknowledgeDowngradeWorldRisk: false,
        selectedRoot: inspection.selectedRoot,
        runtimeChoice: null
      };
      const plan = await harness.invokeModpack(page, 'modpacks:preflight', {
        inspectionId: inspection.inspectionId,
        instanceId: instance.instanceId,
        operationKind: 'import-files-only-new',
        selections
      });
      expect(plan).toMatchObject({
        planId: expect.any(String),
        planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        planView: {
          title: 'Local archive',
          source: { provider: 'local', version: 'local-import' },
          runtime: null,
          server: { contentRevision: 0, priorState: 'new' },
          changes: { added: Object.keys(SAFE_PAYLOAD).length, changed: 0, removed: 0, preserved: 0 }
        }
      });
      expect(plan.requiresConflictReview).not.toBe(true);

      const job = await harness.executeReviewedPlan(page, { plan }, {
        acceptEula: false,
        startAfterInstall: false,
        timeoutMs: 10 * 60_000,
        pollMs: 100,
        maxPollLatencyMs: 5_000
      });
      expect(job).toMatchObject({ phase: 'completed' });

      const state = await harness.invokeModpack(page, 'modpacks:get-state', {
        serverId: instance.instanceId
      });
      expect(state).toMatchObject({
        instanceId: instance.instanceId,
        modpackManaged: false,
        lifecycleMode: 'files-only',
        source: {
          provider: 'local',
          importId: selection.selectionId,
          version: 'local-import',
          title: 'Local archive'
        },
        runtime: null,
        selectedOptionalFiles: [],
        contentRevision: 1,
        managedFileCount: '0'
      });
      expect(state.source.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);

      for (const [relativePath, expectedBytes] of Object.entries(SAFE_PAYLOAD)) {
        const installedBytes = fs.readFileSync(path.join(lifecycle.serverPath, ...relativePath.split('/')));
        expect(sha256(installedBytes), relativePath).toBe(sha256(expectedBytes));
      }
      for (const relativePath of EXCLUDED_ARCHIVE_PATHS) {
        expect(fs.existsSync(path.join(lifecycle.serverPath, ...relativePath.split('/'))), relativePath).toBe(false);
      }
      expect(fs.existsSync(path.join(lifecycle.serverPath, 'eula.txt'))).toBe(false);
      expect(fs.existsSync(archive.executionMarkerPath)).toBe(false);
      expect(sha256(fs.readFileSync(archive.archivePath))).toBe(archive.archiveSha256);

      const allFiles = listPublishedPayload(lifecycle.serverPath);
      const publishedPayload = allFiles.filter(relativePath =>
        relativePath !== '.minecraft-core.json' && !relativePath.startsWith('.minecraft-core-state/')
      );
      expect(publishedPayload).toEqual(Object.keys(SAFE_PAYLOAD).sort((left, right) =>
        left.localeCompare(right, 'en-US')
      ));
      const persistedState = JSON.parse(fs.readFileSync(
        path.join(lifecycle.serverPath, '.minecraft-core-state', 'modpack.json'),
        'utf8'
      ));
      expect(persistedState).toMatchObject({
        modpackManaged: false,
        lifecycleMode: 'files-only',
        runtime: null,
        provenance: { classification: 'files-only' }
      });
      const history = await harness.invokeModpack(page, 'modpacks:list-history', {
        serverId: instance.instanceId,
        cursor: null,
        limit: 20
      });
      expect(history.items).toContainEqual(expect.objectContaining({
        kind: 'import-files-only',
        outcome: 'completed',
        sourceRevision: 0,
        targetRevision: 1
      }));
      const status = await harness.invoke(page, 'get-server-status', {
        instanceId: instance.instanceId,
        targetPath: lifecycle.serverPath
      });
      expect(status?.isRunning).toBe(false);

      await testInfo.attach('real-files-only-before-cleanup.json', {
        body: Buffer.from(JSON.stringify({
          archive: {
            fileName: path.basename(archive.archivePath),
            sha256: archive.archiveSha256,
            selectedRoot: inspection.selectedRoot,
            initialClassification: inspection.classification
          },
          plan: plan.planView,
          job: { jobId: job.jobId, phase: job.phase, outcome: job.outcome },
          state,
          publishedPayload,
          excludedArchivePaths: EXCLUDED_ARCHIVE_PATHS,
          publisherScriptExecuted: false
        }, null, 2)),
        contentType: 'application/json'
      });
      completed = true;
    } finally {
      await githubHarness.finalizeRealLifecycle({
        completed,
        electronApp,
        lifecycle,
        closeAndAudit: async (ownedElectronApp, isolatedLifecycle) => {
          await harness.closeProductionElectronAndAudit(ownedElectronApp, isolatedLifecycle);
          if (completed) {
            const terminalAudit = await githubHarness.auditCompletedLifecycle(isolatedLifecycle);
            expect(terminalAudit).toEqual(EMPTY_TERMINAL_AUDIT);
          }
        },
        collectEvidence: () => harness.collectServerEvidence(lifecycle),
        attachEvidence: evidence => testInfo.attach(
          'real-files-only-failure-evidence.json',
          harness.createSelfContainedEvidenceAttachment(evidence)
        ),
        dispose: options => lifecycle.dispose(options)
      });
    }

  });
});
