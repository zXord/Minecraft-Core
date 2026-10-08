const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  REAL_MODRINTH_LIFECYCLE,
  assertRendererBuildAvailable,
  approvePackConflictChoices,
  createIsolatedRealLifecycle,
  createProductionEnvironment,
  assertNoProductionProcesses,
  closeProductionElectron,
  closeProductionElectronAndAudit,
  collectServerEvidence,
  createSelfContainedEvidenceAttachment,
  finalizeIsolatedRealLifecycle,
  installIsolatedServerDestinationDialogOverride,
  installIsolatedLocalArchiveDialogOverride,
  isRealLifecycleEnabled,
  invokeModpack,
  launchProductionElectronSafely,
  readServerContentRevision,
  reviewExactModrinthVersion,
  startIsolatedServer,
  waitForProductionWindow,
  waitForJob
} = require('./e2e/fixtures/real-modpack-harness.cjs');

function installEvidenceFilesystem(t, { operationFiles, fileContents, readFailures = new Map() }) {
  t.mock.method(fs, 'existsSync', filePath =>
    fileContents.has(filePath) || readFailures.has(filePath) ||
      filePath.endsWith(path.join('modpack-lifecycle', 'operations'))
  );
  t.mock.method(fsp, 'readdir', async () => operationFiles);
  t.mock.method(fsp, 'readFile', async filePath => {
    if (readFailures.has(filePath)) throw readFailures.get(filePath);
    if (!fileContents.has(filePath)) {
      const error = new Error(`Missing fixture: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    }
    return fileContents.get(filePath);
  });
  t.mock.method(fsp, 'writeFile', async () => {});
}

function exactTemporaryTestRoot(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeExactTemporaryTestRoot(root, expectedPrefix) {
  if (!root || !fs.existsSync(root)) return;
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), expectedPrefix);
  await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}

test('production renderer build guard rejects source changes made after the build', (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-core-renderer-build-'));
  t.after(() => {
    const resolved = path.resolve(projectRoot);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^minecraft-core-renderer-build-/u);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const sourcePath = path.join(projectRoot, 'src', 'main.js');
  const publicPath = path.join(projectRoot, 'public', 'icon.png');
  const indexPath = path.join(projectRoot, 'dist', 'index.html');
  const manifestPath = path.join(projectRoot, 'dist', '.vite', 'manifest.json');
  for (const filePath of [sourcePath, publicPath, indexPath, manifestPath]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, filePath.endsWith('.json') ? '{}' : 'fixture');
  }
  for (const fileName of ['index.html', 'package.json', 'package-lock.json', 'svelte.config.js', 'vite.config.js']) {
    fs.writeFileSync(path.join(projectRoot, fileName), fileName.endsWith('.json') ? '{}' : 'fixture');
  }
  const sourceTime = new Date(Date.now() - 120_000);
  const buildTime = new Date(Date.now() - 60_000);
  for (const filePath of [
    sourcePath,
    publicPath,
    ...['index.html', 'package.json', 'package-lock.json', 'svelte.config.js', 'vite.config.js']
      .map(fileName => path.join(projectRoot, fileName))
  ]) fs.utimesSync(filePath, sourceTime, sourceTime);
  for (const filePath of [indexPath, manifestPath]) fs.utimesSync(filePath, buildTime, buildTime);

  assert.doesNotThrow(() => assertRendererBuildAvailable({ projectRoot }));
  fs.utimesSync(sourcePath, new Date(), new Date());
  assert.throws(
    () => assertRendererBuildAvailable({ projectRoot }),
    /built renderer is stale.*npm run build/iu
  );
});

test('isolated lifecycle finalization audits the exact app/root before deleting a successful root', async () => {
  const electronApp = { marker: 'electron' };
  const lifecycle = { root: 'C:\\Temp\\minecraft-core-real-modrinth-e2e-finalize' };
  const calls = [];

  await finalizeIsolatedRealLifecycle({
    completed: true,
    electronApp,
    lifecycle,
    async closeAndAudit(receivedApp, receivedLifecycle) {
      calls.push(['close-and-audit', receivedApp, receivedLifecycle]);
    },
    async collectEvidence() { calls.push('collect'); return null; },
    async attachEvidence() { calls.push('attach'); },
    async dispose(options) { calls.push(['dispose', options]); }
  });

  assert.deepEqual(calls, [
    ['close-and-audit', electronApp, lifecycle],
    ['dispose', { preserveRoot: false }]
  ]);
});

test('isolated lifecycle finalization attaches failed-run evidence before deleting a quiescent root', async () => {
  const calls = [];

  await finalizeIsolatedRealLifecycle({
    completed: false,
    electronApp: { marker: 'electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-modrinth-e2e-failed-clean' },
    async closeAndAudit() { calls.push('close-and-audit'); },
    async collectEvidence() { calls.push('collect'); return { result: 'failed' }; },
    async attachEvidence(evidence) { calls.push(['attach', evidence]); },
    async dispose(options) { calls.push(['dispose', options]); },
    environment: {}
  });

  assert.deepEqual(calls, [
    'close-and-audit',
    'collect',
    ['attach', { result: 'failed' }],
    ['dispose', { preserveRoot: false }]
  ]);
});

test('isolated lifecycle finalization preserves a failed root only with explicit debug opt-in', async () => {
  const calls = [];

  await finalizeIsolatedRealLifecycle({
    completed: false,
    electronApp: { marker: 'electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-modrinth-e2e-failed-debug' },
    async closeAndAudit() { calls.push('close-and-audit'); },
    async collectEvidence() { calls.push('collect'); return { result: 'failed' }; },
    async attachEvidence(evidence) { calls.push(['attach', evidence]); },
    async dispose(options) { calls.push(['dispose', options]); },
    environment: { MINECRAFT_CORE_PRESERVE_FAILED_REAL_E2E: '1' }
  });

  assert.deepEqual(calls, [
    'close-and-audit',
    'collect',
    ['attach', { result: 'failed' }],
    ['dispose', { preserveRoot: true }]
  ]);
});

test('isolated lifecycle finalization preserves evidence when its root-bound process audit fails', async () => {
  const closeFailure = new Error('owned process remains');
  const evidence = { root: 'preserved' };
  const calls = [];

  await assert.rejects(finalizeIsolatedRealLifecycle({
    completed: true,
    electronApp: { marker: 'electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-modrinth-e2e-preserve' },
    async closeAndAudit() { calls.push('close-and-audit'); throw closeFailure; },
    async collectEvidence() { calls.push('collect'); return evidence; },
    async attachEvidence(received) { calls.push(['attach', received]); },
    async dispose(options) { calls.push(['dispose', options]); }
  }), error => error === closeFailure);

  assert.deepEqual(calls, [
    'close-and-audit',
    'collect',
    ['attach', evidence],
    ['dispose', { preserveRoot: true }]
  ]);
});

test('failed-run evidence attachment contains collected JSON instead of a disposable path reference', () => {
  const evidence = {
    scratchRoot: 'C:\\Temp\\minecraft-core-real-example',
    latestLog: '[Server thread/INFO]: Done (5.1s)!',
    operationEntries: ['op2-example']
  };
  const attachment = createSelfContainedEvidenceAttachment(evidence);

  assert.equal(attachment.contentType, 'application/json');
  assert.deepEqual(JSON.parse(attachment.body.toString('utf8')), evidence);
});

test('server evidence embeds parsed and raw operation JSON plus the app main log', async t => {
  const lifecycle = {
    root: 'C:\\Temp\\minecraft-core-real-evidence-complete',
    serverPath: 'C:\\Temp\\minecraft-core-real-evidence-complete\\server',
    clientPath: 'C:\\Temp\\minecraft-core-real-evidence-complete\\client',
    userDataPath: 'C:\\Temp\\minecraft-core-real-evidence-complete\\user-data',
    evidencePath: 'C:\\Temp\\minecraft-core-real-evidence-complete\\evidence',
    serverPort: 25565,
    managementPort: 25575
  };
  const operationRoot = path.join(lifecycle.userDataPath, 'modpack-lifecycle', 'operations');
  const operationPath = path.join(operationRoot, 'op2-complete.json');
  const appMainLogPath = path.join(lifecycle.userDataPath, 'logs', 'main.log');
  const operation = {
    jobId: 'op2-complete',
    phase: 'failed',
    outcome: { failure: { errorCode: 'GITHUB_ASSET_DOWNLOAD_FAILED' } }
  };
  const rawOperation = JSON.stringify(operation);
  const appMainLog = '[error] errorCode=GITHUB_ASSET_DOWNLOAD_FAILED\n';
  installEvidenceFilesystem(t, {
    operationFiles: ['op2-complete.json'],
    fileContents: new Map([
      [operationPath, Buffer.from(rawOperation)],
      [appMainLogPath, Buffer.from(appMainLog)]
    ])
  });

  const evidence = await collectServerEvidence(lifecycle);

  assert.deepEqual(evidence.operationRecords, [{
    fileName: 'op2-complete.json',
    sizeBytes: Buffer.byteLength(rawOperation),
    truncated: false,
    raw: rawOperation,
    parsed: operation,
    error: null
  }]);
  assert.equal(evidence.appMainLogPath, appMainLogPath);
  assert.equal(evidence.appMainLog, appMainLog);
  assert.equal(evidence.appMainLogTruncated, false);
  assert.equal(evidence.appMainLogError, null);
});

test('server evidence bounds operation count, operation bytes, and app main-log bytes', async t => {
  const lifecycle = {
    root: 'C:\\Temp\\minecraft-core-real-evidence-bounded',
    serverPath: 'C:\\Temp\\minecraft-core-real-evidence-bounded\\server',
    clientPath: 'C:\\Temp\\minecraft-core-real-evidence-bounded\\client',
    userDataPath: 'C:\\Temp\\minecraft-core-real-evidence-bounded\\user-data',
    evidencePath: 'C:\\Temp\\minecraft-core-real-evidence-bounded\\evidence',
    serverPort: 25565,
    managementPort: 25575
  };
  const operationRoot = path.join(lifecycle.userDataPath, 'modpack-lifecycle', 'operations');
  const operationFiles = Array.from({ length: 34 }, (_, index) => `op-${String(index).padStart(2, '0')}.json`);
  const fileContents = new Map(operationFiles.map(fileName => [
    path.join(operationRoot, fileName),
    Buffer.from(JSON.stringify({ jobId: fileName.slice(0, -5), phase: 'failed' }))
  ]));
  fileContents.set(path.join(operationRoot, operationFiles[0]), Buffer.alloc((2 * 1024 * 1024) + 1, 0x78));
  const appMainLogPath = path.join(lifecycle.userDataPath, 'logs', 'main.log');
  const terminalLine = '\n[error] errorCode=TERMINAL_FAILURE\n';
  fileContents.set(appMainLogPath, Buffer.concat([
    Buffer.alloc(300 * 1024, 0x78),
    Buffer.from(terminalLine)
  ]));
  installEvidenceFilesystem(t, { operationFiles, fileContents });

  const evidence = await collectServerEvidence(lifecycle);

  assert.equal(evidence.operationEntryCount, 34);
  assert.equal(evidence.operationEntriesTruncated, true);
  assert.equal(evidence.operationEntries.length, 32);
  assert.equal(evidence.operationRecords.length, 32);
  assert.ok(Buffer.byteLength(evidence.operationRecords[0].raw) <= 2 * 1024 * 1024);
  assert.equal(evidence.operationRecords[0].truncated, true);
  assert.ok(Buffer.byteLength(evidence.appMainLog) <= 256 * 1024);
  assert.match(evidence.appMainLog, /errorCode=TERMINAL_FAILURE/u);
  assert.equal(evidence.appMainLogTruncated, true);
});

test('server evidence reports unreadable and malformed diagnostics without aborting collection', async t => {
  const lifecycle = {
    root: 'C:\\Temp\\minecraft-core-real-evidence-errors',
    serverPath: 'C:\\Temp\\minecraft-core-real-evidence-errors\\server',
    clientPath: 'C:\\Temp\\minecraft-core-real-evidence-errors\\client',
    userDataPath: 'C:\\Temp\\minecraft-core-real-evidence-errors\\user-data',
    evidencePath: 'C:\\Temp\\minecraft-core-real-evidence-errors\\evidence',
    serverPort: 25565,
    managementPort: 25575
  };
  const operationRoot = path.join(lifecycle.userDataPath, 'modpack-lifecycle', 'operations');
  const unreadablePath = path.join(operationRoot, 'op-unreadable.json');
  const malformedPath = path.join(operationRoot, 'op-malformed.json');
  const appMainLogPath = path.join(lifecycle.userDataPath, 'logs', 'main.log');
  const unreadable = Object.assign(new Error('access denied'), { code: 'EACCES' });
  const logFailure = Object.assign(new Error('log is locked'), { code: 'EBUSY' });
  installEvidenceFilesystem(t, {
    operationFiles: ['op-unreadable.json', 'op-malformed.json'],
    fileContents: new Map([
      [malformedPath, Buffer.from('{"phase":')],
      [appMainLogPath, Buffer.from('unreachable')]
    ]),
    readFailures: new Map([
      [unreadablePath, unreadable],
      [appMainLogPath, logFailure]
    ])
  });

  const evidence = await collectServerEvidence(lifecycle);

  assert.equal(evidence.operationRecords[0].error.code, 'EACCES');
  assert.equal(evidence.operationRecords[0].raw, null);
  assert.equal(evidence.operationRecords[1].error.code, 'INVALID_JSON');
  assert.equal(evidence.operationRecords[1].raw, '{"phase":');
  assert.equal(evidence.operationRecords[1].parsed, null);
  assert.equal(evidence.appMainLog, '');
  assert.equal(evidence.appMainLogError.code, 'EBUSY');
});

test('all deleting real-E2E specs attach collected content and use the shared finalizer', () => {
  const specNames = [
    'disposable-client-join.spec.js',
    'real-files-only-local-archive.spec.js',
    'real-github-management-rendered-ui.spec.js',
    'real-github-release-monitor.spec.js',
    'real-github-releases-continuation.spec.js',
    'real-github-releases.spec.js',
    'real-github-rendered-rollback-continuation.spec.js',
    'real-modpack-lifecycle.spec.js',
    'real-modpack-management.spec.js',
    'real-modrinth-rendered-ui.spec.js',
    'real-terrafirmagreg-inspection.spec.js',
    'real-terrafirmagreg-rendered-ui.spec.js'
  ];
  for (const specName of specNames) {
    const source = fs.readFileSync(path.join(__dirname, 'e2e', specName), 'utf8');
    assert.match(source, /finalize(?:IsolatedRealLifecycle|DisposableClientJoin|RealLifecycle)\s*\(/u, specName);
    assert.match(source, /createSelfContainedEvidenceAttachment\(evidence\)/u, specName);
  }
});

test('real-E2E helpers never reclaim abandoned roots by age or pathname', () => {
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, 'e2e', 'fixtures', 'real-modpack-harness.cjs'),
    'utf8'
  );
  const cleanupSource = fs.readFileSync(
    path.join(__dirname, 'e2e', 'fixtures', 'real-modpack-scratch-cleanup.cjs'),
    'utf8'
  );

  assert.doesNotMatch(lifecycleSource, /pruneExpiredRealLifecycleRoots|cleanupLeasePath|cleanupClock/u);
  assert.doesNotMatch(cleanupSource, /pruneExpiredRealLifecycleRoots|expiresAt|RETENTION/u);
});

test('isolated lifecycle cleanup refuses a nested directory redirect', async t => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'cleanup-immediate-reparse' });
  const outside = await exactTemporaryTestRoot('minecraft-core-cleanup-immediate-outside-');
  const redirected = path.join(lifecycle.root, 'nested-redirect');
  let redirectCreated = false;
  try {
    try {
      await fsp.symlink(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir');
      redirectCreated = true;
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`directory redirect creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      lifecycle.dispose({ preserveRoot: false }),
      /redirect|reparse|symbolic/iu
    );
    assert.equal(fs.existsSync(lifecycle.root), true);
    assert.equal(fs.existsSync(outside), true);
  } finally {
    if (redirectCreated) await fsp.unlink(redirected).catch(() => {});
    if (fs.existsSync(lifecycle.root)) await lifecycle.dispose({ preserveRoot: false });
    await removeExactTemporaryTestRoot(outside, /^minecraft-core-cleanup-immediate-outside-/u);
  }
});

test('isolated lifecycle finalization preserves a failed root when evidence collection fails', async () => {
  const evidenceFailure = new Error('evidence filesystem unavailable');
  const calls = [];

  await assert.rejects(finalizeIsolatedRealLifecycle({
    completed: false,
    electronApp: { marker: 'electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-modrinth-e2e-evidence-failed' },
    async closeAndAudit() { calls.push('close-and-audit'); },
    async collectEvidence() { calls.push('collect'); throw evidenceFailure; },
    async attachEvidence() { calls.push('attach'); },
    async dispose(options) { calls.push(['dispose', options]); },
    environment: {}
  }), error => error === evidenceFailure);

  assert.deepEqual(calls, [
    'close-and-audit',
    'collect',
    ['dispose', { preserveRoot: true }]
  ]);
});

test('isolated lifecycle finalization preserves a failed root when evidence attachment fails', async () => {
  const attachmentFailure = new Error('test reporter unavailable');
  const calls = [];

  await assert.rejects(finalizeIsolatedRealLifecycle({
    completed: false,
    electronApp: { marker: 'electron' },
    lifecycle: { root: 'C:\\Temp\\minecraft-core-real-modrinth-e2e-attachment-failed' },
    async closeAndAudit() { calls.push('close-and-audit'); },
    async collectEvidence() { calls.push('collect'); return { result: 'failed' }; },
    async attachEvidence() { calls.push('attach'); throw attachmentFailure; },
    async dispose(options) { calls.push(['dispose', options]); },
    environment: {}
  }), error => error === attachmentFailure);

  assert.deepEqual(calls, [
    'close-and-audit',
    'collect',
    'attach',
    ['dispose', { preserveRoot: true }]
  ]);
});

const {
  REAL_CONTINUATION_ROOT_ENV,
  getPreservedLifecycleRoot,
  isPreservedLifecycleContinuationEnabled,
  loadPreservedRealLifecycle,
  startPreservedServer
} = require('./e2e/fixtures/preserved-real-modrinth-harness.cjs');
const { planOwnership } = require('../electron/services/modpacks/planning/ownership-planner.cjs');
const {
  createRecoveryTargetEnvelope
} = require('../electron/services/modpack-lifecycle/recovery-target-envelope.cjs');
const {
  OperationJournal,
  createDirectoryMarker
} = require('../electron/services/modpack-lifecycle/operation-journal.cjs');
const {
  identifyServerDirectory,
  inspectServerDirectoryTree
} = require('../electron/services/modpack-lifecycle/server-directory-identity.cjs');
const {
  createExistingSiblingPaths
} = require('../electron/services/modpack-lifecycle/server-directory-transaction.cjs');

async function createPreservedLifecycleFixture({
  identity = { harness: 'modrinth-lifecycle' },
  versionId = 'oQ6gSIoF',
  minecraftVersion = REAL_MODRINTH_LIFECYCLE.versions.find(version => version.id === versionId)?.minecraft || '1.20.1',
  instances = null,
  lastServerPath = null
} = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-real-modrinth-e2e-'));
  const serverPath = path.join(root, 'server');
  const userDataPath = path.join(root, 'user-data');
  const identityPath = path.join(root, 'real-lifecycle-identity.json');
  const statePath = path.join(serverPath, '.minecraft-core-state', 'modpack.json');
  const configPath = path.join(userDataPath, 'config', 'minecraft-core-config.json');
  await Promise.all([
    fsp.mkdir(path.dirname(statePath), { recursive: true }),
    fsp.mkdir(path.dirname(configPath), { recursive: true }),
    fsp.mkdir(path.join(root, 'client')),
    fsp.mkdir(path.join(root, 'evidence'))
  ]);
  const persistedInstances = instances ?? [{
    id: 'server-disposable-only',
    name: 'server',
    type: 'server',
    path: serverPath
  }];
  await Promise.all([
    fsp.writeFile(identityPath, JSON.stringify(identity), 'utf8'),
    fsp.writeFile(statePath, JSON.stringify({
      schemaVersion: 1,
      modpackManaged: true,
      source: {
        provider: 'modrinth',
        projectId: REAL_MODRINTH_LIFECYCLE.projectId,
        versionId
      },
      runtime: {
        minecraftVersion,
        loaderFamily: 'fabric'
      }
    }), 'utf8'),
    fsp.writeFile(configPath, JSON.stringify({
      lastServerPath: lastServerPath ?? serverPath,
      instances: persistedInstances
    }), 'utf8')
  ]);
  return { root, serverPath, userDataPath };
}

async function removePreservedLifecycleFixture(root) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved).toLocaleLowerCase('en-US'), path.resolve(os.tmpdir()).toLocaleLowerCase('en-US'));
  assert.match(path.basename(resolved), /^minecraft-core-real-modrinth-e2e-[A-Za-z0-9_-]+$/u);
  await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}

async function interruptPreservedLifecycleBetweenRenames(
  fixture,
  jobId = `op2-${'b'.repeat(32)}`
) {
  const instanceId = 'server-disposable-only';
  const paths = createExistingSiblingPaths(fixture.serverPath, jobId);
  const candidatePath = paths.candidatePath;
  const rollbackPath = paths.rollbackPath;
  const failedPath = paths.failedPath;
  await fsp.cp(fixture.serverPath, candidatePath, { recursive: true, force: false, errorOnExist: true });
  const [targetIdentity, candidateIdentity, rollbackInspection] = await Promise.all([
    identifyServerDirectory(fixture.serverPath),
    identifyServerDirectory(candidatePath),
    inspectServerDirectoryTree(fixture.serverPath)
  ]);
  const operationRoot = path.join(candidatePath, '.minecraft-core-state', 'operations', jobId);
  const journalPath = path.join(operationRoot, 'journal.json');
  const markerPath = path.join(operationRoot, 'directory-marker.json');
  await fsp.mkdir(operationRoot, { recursive: true });
  const marker = createDirectoryMarker({
    jobId,
    operationKind: 'switch',
    stableInstanceId: instanceId,
    createdAt: '2026-08-31T04:00:00.000Z'
  });
  await fsp.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  const durableFs = {
    readFileBounded(filePath) { return fs.readFileSync(filePath); },
    async readFileBoundedAsync(filePath) { return fsp.readFile(filePath); },
    async writeJsonAtomicAsync(filePath, value) {
      await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }
  };
  const operationJournal = new OperationJournal({
    durableFs,
    fsApi: fs,
    clock: () => new Date('2026-08-31T04:00:00.000Z')
  });
  await operationJournal.create(journalPath, {
    jobId,
    operationKind: 'switch',
    stableInstanceId: instanceId,
    targetPath: fixture.serverPath,
    candidateIdentity,
    markerSha256: marker.checksum
  });
  const candidateInspection = await inspectServerDirectoryTree(candidatePath, {
    mutableRelativePaths: [`.minecraft-core-state/operations/${jobId}/journal.json`]
  });
  await operationJournal.transition(journalPath, {
    expectedPhase: 'staging',
    nextPhase: 'committing',
    patch: {
      swapStep: 'prepared',
      candidateIdentity,
      targetIdentity,
      sourceFingerprint: rollbackInspection.fingerprint,
      candidateFingerprint: candidateInspection.fingerprint
    }
  });
  await fsp.rename(fixture.serverPath, rollbackPath);
  const activePath = path.join(fixture.userDataPath, 'modpack-lifecycle', 'active');
  const operationsPath = path.join(fixture.userDataPath, 'modpack-lifecycle', 'operations');
  await Promise.all([
    fsp.mkdir(activePath, { recursive: true }),
    fsp.mkdir(operationsPath, { recursive: true })
  ]);
  const record = {
    schemaVersion: 2,
    sequence: 7,
    jobId,
    operationKind: 'switch',
    target: { kind: 'existing', stableServerId: instanceId, path: fixture.serverPath },
    candidatePath,
    rollbackPath,
    failedPath,
    restorePoint: { id: 'restore-interrupted-switch', sha256: 'a'.repeat(64) },
    restoreCreation: null,
    journalPath,
    priorRuntime: { running: false, autoRestart: false },
    phase: 'committing',
    swapStep: 'prepared',
    directoryIdentities: {
      target: targetIdentity,
      candidate: candidateIdentity,
      rollback: null,
      failed: null
    },
    createdAt: '2026-08-31T04:00:00.000Z',
    updatedAt: '2026-08-31T04:00:01.000Z',
    outcome: {
      live: { fingerprint: rollbackInspection.fingerprint },
      candidate: { fingerprint: candidateInspection.fingerprint, markerSha256: marker.checksum },
      revision: { source: 1, target: 2 }
    }
  };
  await Promise.all([
    fsp.writeFile(path.join(activePath, `${jobId}.json`), JSON.stringify(record), 'utf8'),
    fsp.writeFile(
      path.join(activePath, `${jobId}.target.json`),
      JSON.stringify(createRecoveryTargetEnvelope(record)),
      'utf8'
    ),
    fsp.writeFile(path.join(operationsPath, `${jobId}.json`), JSON.stringify({
      jobId,
      serverId: instanceId,
      operationKind: 'switch',
      phase: 'committing'
    }), 'utf8')
  ]);
  return { jobId, candidatePath, rollbackPath, failedPath };
}

test('real lifecycle is opt-in only', () => {
  assert.equal(isRealLifecycleEnabled({}), false);
  assert.equal(isRealLifecycleEnabled({ MINECRAFT_CORE_REAL_MODPACK_E2E: '1' }), true);
  assert.equal(isRealLifecycleEnabled({ MINECRAFT_CORE_REAL_MODPACK_E2E: 'true' }), true);
  assert.equal(isRealLifecycleEnabled({ MINECRAFT_CORE_REAL_MODPACK_E2E: 'yes' }), false);
});

test('real lifecycle reads the current coordinator revision through the production settings contract', async () => {
  const requests = [];
  const page = {
    async evaluate(_callback, payload) {
      requests.push(payload);
      return { success: true, settings: { contentRevision: 4 } };
    }
  };

  assert.equal(await readServerContentRevision(page, 'disposable-server'), 4);
  assert.deepEqual(requests, [{
    channel: 'get-settings',
    request: { instanceId: 'disposable-server' }
  }]);
});

test('real lifecycle rejects an invalid coordinator revision response', async () => {
  const failedPage = {
    async evaluate() {
      return { success: false, error: 'settings unavailable' };
    }
  };
  const malformedPage = {
    async evaluate() {
      return { success: true, settings: { contentRevision: -1 } };
    }
  };

  await assert.rejects(
    readServerContentRevision(failedPage, 'disposable-server'),
    /Could not read isolated server settings/iu
  );
  await assert.rejects(
    readServerContentRevision(malformedPage, 'disposable-server'),
    /content revision is invalid/iu
  );
});

test('exact-version review retries one pre-execution PLAN_STALE with the same immutable inspection', async () => {
  const requests = [];
  let preflights = 0;
  const page = {
    async evaluate(_callback, payload) {
      requests.push(payload);
      if (payload.channel === 'modpacks:inspect') {
        return { ok: true, value: { inspectionId: 'inspection-exact-version' } };
      }
      if (payload.channel === 'modpacks:preflight') {
        preflights += 1;
        if (preflights === 1) {
          return {
            ok: false,
            error: { code: 'PLAN_STALE', message: 'The reviewed server changed during preparation' }
          };
        }
        return {
          ok: true,
          value: { planId: 'plan-fresh', planFingerprint: 'f'.repeat(64), planView: {} }
        };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  const reviewed = await reviewExactModrinthVersion(page, {
    instanceId: 'server-disposable-only',
    version: REAL_MODRINTH_LIFECYCLE.versions[1]
  });

  assert.equal(reviewed.inspection.inspectionId, 'inspection-exact-version');
  assert.equal(reviewed.plan.planId, 'plan-fresh');
  assert.equal(requests.filter(request => request.channel === 'modpacks:inspect').length, 1);
  assert.equal(preflights, 2);
  assert.deepEqual(
    requests.filter(request => request.channel === 'modpacks:preflight').map(request => request.request.inspectionId),
    ['inspection-exact-version', 'inspection-exact-version']
  );
});

test('exact-version review never retries PLAN_STALE more than once', async () => {
  let preflights = 0;
  const page = {
    async evaluate(_callback, payload) {
      if (payload.channel === 'modpacks:inspect') {
        return { ok: true, value: { inspectionId: 'inspection-stays-stale' } };
      }
      if (payload.channel === 'modpacks:preflight') {
        preflights += 1;
        return { ok: false, error: { code: 'PLAN_STALE', message: 'Still stale' } };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  await assert.rejects(
    reviewExactModrinthVersion(page, {
      instanceId: 'server-disposable-only',
      version: REAL_MODRINTH_LIFECYCLE.versions[1]
    }),
    error => error?.code === 'PLAN_STALE'
  );
  assert.equal(preflights, 2);
});

test('preserved continuation accepts only an explicit environment root and never invents one', () => {
  assert.equal(getPreservedLifecycleRoot({}), null);
  assert.equal(getPreservedLifecycleRoot({ [REAL_CONTINUATION_ROOT_ENV]: '   ' }), null);
  assert.equal(
    getPreservedLifecycleRoot({ [REAL_CONTINUATION_ROOT_ENV]: ' C:\\temp\\minecraft-core-real-modrinth-e2e-explicit ' }),
    'C:\\temp\\minecraft-core-real-modrinth-e2e-explicit'
  );
  assert.equal(isPreservedLifecycleContinuationEnabled({}), false);
  assert.equal(isPreservedLifecycleContinuationEnabled({
    [REAL_CONTINUATION_ROOT_ENV]: 'C:\\temp\\minecraft-core-real-modrinth-e2e-explicit'
  }), false);
  assert.equal(isPreservedLifecycleContinuationEnabled({
    MINECRAFT_CORE_REAL_MODPACK_E2E: '1'
  }), false);
  assert.equal(isPreservedLifecycleContinuationEnabled({
    MINECRAFT_CORE_REAL_MODPACK_E2E: '1',
    [REAL_CONTINUATION_ROOT_ENV]: 'C:\\temp\\minecraft-core-real-modrinth-e2e-explicit'
  }), true);
});

test('preserved continuation adopts one exact disposable Modrinth server and preserves it by default', async () => {
  const fixture = await createPreservedLifecycleFixture();
  try {
    const lifecycle = await loadPreservedRealLifecycle(fixture.root);
    assert.equal(lifecycle.root, path.resolve(fixture.root));
    assert.equal(lifecycle.serverPath, fixture.serverPath);
    assert.equal(lifecycle.userDataPath, fixture.userDataPath);
    assert.equal(lifecycle.instanceId, 'server-disposable-only');
    assert.equal(lifecycle.serverHost, '127.0.0.1');
    assert.notEqual(lifecycle.serverPort, lifecycle.managementPort);
    const environment = createProductionEnvironment(lifecycle, {
      APPDATA: 'C:\\existing\\appdata',
      LOCALAPPDATA: 'C:\\existing\\localappdata',
      TEMP: 'C:\\existing\\temp',
      SystemRoot: 'C:\\Windows'
    });
    assert.equal(environment.APPDATA, path.join(fixture.root, 'environment', 'profile', 'AppData', 'Roaming'));
    assert.equal(environment.LOCALAPPDATA, path.join(fixture.root, 'environment', 'profile', 'AppData', 'Local'));
    assert.equal(environment.TEMP, path.join(fixture.root, 'environment', 'temp'));
    await lifecycle.dispose();
    assert.equal(fs.existsSync(fixture.root), true);
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
  }
});

test('preserved continuation can launch recovery when an exact existing-server commit stopped between renames', async () => {
  const fixture = await createPreservedLifecycleFixture({ versionId: 'zH4ppiGM' });
  try {
    const interrupted = await interruptPreservedLifecycleBetweenRenames(fixture);
    const lifecycle = await loadPreservedRealLifecycle(fixture.root);
    assert.equal(fs.existsSync(fixture.serverPath), false);
    assert.equal(lifecycle.instanceId, 'server-disposable-only');
    assert.equal(lifecycle.recoveryPending, true);
    assert.equal(lifecycle.recoveryJobId, interrupted.jobId);
    assert.equal(lifecycle.recoveryCandidatePath, interrupted.candidatePath);
    assert.equal(lifecycle.recoveryRollbackPath, interrupted.rollbackPath);
    const environment = createProductionEnvironment(lifecycle, { SystemRoot: 'C:\\Windows' });
    assert.equal(environment.MINECRAFT_CORE_USER_DATA_DIR, fixture.userDataPath);
    assert.equal(fs.existsSync(fixture.serverPath), false);
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
  }
});

test('production environment rejects a forged missing-server recovery capability', async () => {
  const fixture = await createPreservedLifecycleFixture({ versionId: 'zH4ppiGM' });
  try {
    await interruptPreservedLifecycleBetweenRenames(fixture);
    assert.throws(
      () => createProductionEnvironment({
        root: fixture.root,
        userDataPath: fixture.userDataPath,
        serverPath: fixture.serverPath,
        clientPath: path.join(fixture.root, 'client'),
        evidencePath: path.join(fixture.root, 'evidence'),
        environmentPath: path.join(fixture.root, 'environment'),
        profilePath: path.join(fixture.root, 'environment', 'profile'),
        roamingAppDataPath: path.join(fixture.root, 'environment', 'profile', 'AppData', 'Roaming'),
        localAppDataPath: path.join(fixture.root, 'environment', 'profile', 'AppData', 'Local'),
        tempPath: path.join(fixture.root, 'environment', 'temp'),
        identityPath: path.join(fixture.root, 'real-lifecycle-identity.json'),
        recoveryLaunchAuthority: Object.freeze({})
      }, { SystemRoot: 'C:\\Windows' }),
      /recovery authority|serverPath/iu
    );
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
  }
});

test('production environment rejects recovery evidence replaced after guarded adoption', async () => {
  const fixture = await createPreservedLifecycleFixture({ versionId: 'zH4ppiGM' });
  try {
    const interrupted = await interruptPreservedLifecycleBetweenRenames(fixture);
    const lifecycle = await loadPreservedRealLifecycle(fixture.root);
    const activeRecord = path.join(fixture.userDataPath, 'modpack-lifecycle', 'active', `${interrupted.jobId}.json`);
    await fsp.writeFile(activeRecord, `${await fsp.readFile(activeRecord, 'utf8')}\n`, 'utf8');
    assert.throws(
      () => createProductionEnvironment(lifecycle, { SystemRoot: 'C:\\Windows' }),
      /recovery authority|evidence/iu
    );
    assert.equal(fs.existsSync(fixture.serverPath), false);
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
  }
});

test('preserved continuation refuses adoption while its exact disposable root still has a bound process', async () => {
  const fixture = await createPreservedLifecycleFixture();
  const auditFailure = new Error('root-bound test process');
  try {
    await assert.rejects(
      loadPreservedRealLifecycle(fixture.root, {
        assertNoRootProcesses() { throw auditFailure; }
      }),
      error => error === auditFailure
    );
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
  }
});

test('preserved continuation waits for a fresh readiness log instead of accepting an old successful boot', async () => {
  const fixture = await createPreservedLifecycleFixture();
  const latestLogPath = path.join(fixture.serverPath, 'logs', 'latest.log');
  await fsp.mkdir(path.dirname(latestLogPath), { recursive: true });
  await fsp.writeFile(latestLogPath, '[old] Done (1.000s)!', 'utf8');
  let statusPolls = 0;
  const page = {
    async evaluate(_callback, payload) {
      if (payload.channel === 'start-server') return { success: true };
      if (payload.channel === 'get-server-status') {
        statusPolls += 1;
        if (statusPolls === 2) await fsp.writeFile(latestLogPath, '[new] Done (2.000s)!', 'utf8');
        return { instanceId: 'server-disposable-only', isRunning: true, status: 'running' };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  try {
    const lifecycle = await loadPreservedRealLifecycle(fixture.root);
    const status = await startPreservedServer(page, lifecycle, { timeoutMs: 100, pollMs: 1 });
    assert.equal(status.isRunning, true);
    assert.equal(statusPolls, 2);
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
  }
});

test('preserved continuation binds the exact validated server to loopback before start', async () => {
  const fixture = await createPreservedLifecycleFixture();
  const propertiesPath = path.join(fixture.serverPath, 'server.properties');
  const latestLogPath = path.join(fixture.serverPath, 'logs', 'latest.log');
  const originalProperties = '# publisher setting\r\nmotd=Keep this value\r\nserver-ip=\r\nview-distance=9\r\nserver-ip=0.0.0.0\r\n';
  await fsp.writeFile(propertiesPath, originalProperties, 'utf8');
  let propertiesAtStart = null;
  const page = {
    async evaluate(_callback, payload) {
      if (payload.channel === 'start-server') {
        propertiesAtStart = await fsp.readFile(propertiesPath, 'utf8');
        return { success: true };
      }
      if (payload.channel === 'get-server-status') {
        await fsp.mkdir(path.dirname(latestLogPath), { recursive: true });
        await fsp.writeFile(latestLogPath, '[new] Done (2.000s)!', 'utf8');
        return { instanceId: 'server-disposable-only', isRunning: true, status: 'running' };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  try {
    const lifecycle = await loadPreservedRealLifecycle(fixture.root);
    await startPreservedServer(page, lifecycle, { timeoutMs: 100, pollMs: 1 });
    assert.equal(propertiesAtStart, '# publisher setting\r\nmotd=Keep this value\r\nserver-ip=127.0.0.1\r\nview-distance=9\r\n');
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
  }
});

test('preserved continuation never starts a forged lifecycle path', async () => {
  const fixture = await createPreservedLifecycleFixture();
  let invoked = false;
  const page = {
    async evaluate() {
      invoked = true;
      throw new Error('IPC must not be reached');
    }
  };
  try {
    const lifecycle = await loadPreservedRealLifecycle(fixture.root);
    await assert.rejects(
      startPreservedServer(page, { ...lifecycle, serverPath: path.dirname(fixture.root) }, { timeoutMs: 1, pollMs: 1 }),
      /validated continuation scratch server/iu
    );
    assert.equal(invoked, false);
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
  }
});

test('preserved continuation rejects nested, wrong-prefix, and missing explicit roots before adoption', async () => {
  const fixture = await createPreservedLifecycleFixture();
  const nested = path.join(fixture.root, 'nested');
  const wrongPrefix = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-real-github-e2e-'));
  await fsp.mkdir(nested);
  try {
    await assert.rejects(loadPreservedRealLifecycle(), /explicit preserved lifecycle root is required/iu);
    await assert.rejects(loadPreservedRealLifecycle(nested), /directly under the operating-system temporary directory/iu);
    await assert.rejects(loadPreservedRealLifecycle(wrongPrefix), /exact Modrinth continuation prefix/iu);
  } finally {
    await removePreservedLifecycleFixture(fixture.root);
    await fsp.rm(wrongPrefix, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('preserved continuation accepts approved resume versions and rejects the wrong identity or unknown version without deleting roots', async () => {
  const wrongIdentity = await createPreservedLifecycleFixture({ identity: { harness: 'github-releases' } });
  const resumedPatch = await createPreservedLifecycleFixture({ versionId: 'zH4ppiGM' });
  const resumedSwitch = await createPreservedLifecycleFixture({ versionId: 'MEznmVQB' });
  const wrongVersion = await createPreservedLifecycleFixture({ versionId: 'not-approved' });
  try {
    await loadPreservedRealLifecycle(resumedPatch.root);
    await loadPreservedRealLifecycle(resumedSwitch.root);
    await assert.rejects(loadPreservedRealLifecycle(wrongIdentity.root), /identity does not match/iu);
    await assert.rejects(loadPreservedRealLifecycle(wrongVersion.root), /approved exact Modrinth version/iu);
    assert.equal(fs.existsSync(wrongIdentity.root), true);
    assert.equal(fs.existsSync(wrongVersion.root), true);
  } finally {
    await removePreservedLifecycleFixture(wrongIdentity.root);
    await removePreservedLifecycleFixture(resumedPatch.root);
    await removePreservedLifecycleFixture(resumedSwitch.root);
    await removePreservedLifecycleFixture(wrongVersion.root);
  }
});

test('preserved continuation rejects ambiguous or out-of-root saved server records', async () => {
  const ambiguous = await createPreservedLifecycleFixture();
  const outOfRoot = await createPreservedLifecycleFixture();
  const otherServerPath = path.join(os.tmpdir(), 'not-the-disposable-server');
  try {
    const ambiguousConfig = path.join(ambiguous.userDataPath, 'config', 'minecraft-core-config.json');
    const first = JSON.parse(await fsp.readFile(ambiguousConfig, 'utf8')).instances[0];
    await fsp.writeFile(ambiguousConfig, JSON.stringify({
      lastServerPath: ambiguous.serverPath,
      instances: [first, { ...first, id: 'second-disposable-server' }]
    }), 'utf8');
    const outOfRootConfig = path.join(outOfRoot.userDataPath, 'config', 'minecraft-core-config.json');
    await fsp.writeFile(outOfRootConfig, JSON.stringify({
      lastServerPath: otherServerPath,
      instances: [{ id: 'unsafe-server', name: 'unsafe', type: 'server', path: otherServerPath }]
    }), 'utf8');

    await assert.rejects(loadPreservedRealLifecycle(ambiguous.root), /exactly one saved disposable server/iu);
    await assert.rejects(loadPreservedRealLifecycle(outOfRoot.root), /outside the validated scratch server directory/iu);
  } finally {
    await removePreservedLifecycleFixture(ambiguous.root);
    await removePreservedLifecycleFixture(outOfRoot.root);
  }
});

test('real lifecycle versions remain pinned to the approved Modrinth files', () => {
  assert.deepEqual(
    REAL_MODRINTH_LIFECYCLE.versions.map(version => version.id),
    ['oQ6gSIoF', 'zH4ppiGM', 'MEznmVQB']
  );
});

test('real lifecycle conflict approval prefers the pack version over every fallback', () => {
  assert.deepEqual(
    approvePackConflictChoices([{
      id: 'config/server.properties',
      allowedChoices: ['keep-mine', 'remove-addon', 'use-pack']
    }]),
    {
      paths: { 'config/server.properties': { choice: 'use-pack' } },
      categories: {}
    }
  );
});

test('real lifecycle conflict approval treats protected configuration as an explicit pack choice', () => {
  assert.deepEqual(
    approvePackConflictChoices([{
      id: 'opaque-conflict-version-marker',
      label: 'config/nomilabs-version.cfg',
      role: 'configuration',
      protected: true,
      allowedChoices: ['keep-mine', 'use-pack']
    }]),
    {
      paths: { 'opaque-conflict-version-marker': { choice: 'use-pack' } },
      categories: {}
    }
  );
});

test('real lifecycle conflict approval preserves a protected world file removed upstream', () => {
  const sentinel = {
    path: 'world/minecraft-core-real-github.keep',
    pathKey: 'world/minecraft-core-real-github.keep',
    origin: 'user',
    managementPolicy: 'protected',
    role: 'world',
    installedHash: '2'.repeat(64),
    size: '45',
    priorBaseline: null
  };
  const conflictId = 'opaque-conflict-world-sentinel';
  const approved = approvePackConflictChoices([{
    id: conflictId,
    role: 'world',
    reason: 'protected-incoming-removed',
    protected: true,
    allowedChoices: ['keep-mine', 'use-pack'],
    alternateOptions: []
  }]);

  assert.deepEqual(approved, {
    paths: { [conflictId]: { choice: 'keep-mine' } },
    categories: {}
  });

  const plan = planOwnership({
    oldManifest: { schemaVersion: 1, installationId: 'installed-github-release', entries: [sentinel] },
    liveSnapshot: {
      kind: 'existing',
      worldDirectories: ['world'],
      protectedPaths: [],
      entries: [{
        path: sentinel.path,
        pathKey: sentinel.pathKey,
        type: 'file',
        sha256: sentinel.installedHash,
        size: sentinel.size,
        origin: 'user'
      }]
    },
    incomingManifest: { schemaVersion: 1, installationId: 'downgraded-github-release', entries: [] },
    conflictChoices: {}
  });

  assert.equal(plan.actions[0].action, 'preserve-orphan');
  assert.equal(plan.actions[0].reason, 'user-owned-content-preserved');
  assert.equal(plan.confirmation.worldsRetained, true);
});

test('real lifecycle conflict approval falls back to removing the addon', () => {
  assert.deepEqual(
    approvePackConflictChoices([{
      id: 'mods/obsolete-addon.jar',
      allowedChoices: ['keep-mine', 'remove-addon']
    }]),
    {
      paths: { 'mods/obsolete-addon.jar': { choice: 'remove-addon' } },
      categories: {}
    }
  );
});

test('real lifecycle keep-both approval preserves the opaque alternate target ID', () => {
  assert.deepEqual(
    approvePackConflictChoices([{
      id: 'config/shared.toml',
      allowedChoices: ['keep-both'],
      alternateOptions: [{ id: 'opaque-alternate-target:v3:a91f' }]
    }]),
    {
      paths: {
        'config/shared.toml': {
          choice: 'keep-both',
          alternateId: 'opaque-alternate-target:v3:a91f'
        }
      },
      categories: {}
    }
  );

  assert.throws(
    () => approvePackConflictChoices([{
      id: 'config/shared.toml',
      allowedChoices: ['keep-both'],
      alternateOptions: []
    }]),
    /no approved alternate target/iu
  );
});

test('real lifecycle conflict approval rejects empty and unresolvable reviews', () => {
  assert.throws(() => approvePackConflictChoices([]), /did not include conflicts/iu);
  assert.throws(
    () => approvePackConflictChoices([{
      id: 'config/unsupported.toml',
      allowedChoices: ['unsupported-choice']
    }]),
    /no supported approval choice/iu
  );
});

test('real lifecycle exposes a disposable destination-dialog override for rendered setup tests', () => {
  assert.equal(typeof installIsolatedServerDestinationDialogOverride, 'function');
});

test('real lifecycle local archive dialog is limited to one direct scratch input and restores the native picker', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'local-picker' });
  const inputsPath = path.join(lifecycle.root, 'inputs');
  const archivePath = path.join(inputsPath, 'reviewed-files-only.zip');
  await fsp.mkdir(inputsPath);
  await fsp.writeFile(archivePath, 'reviewed archive bytes');
  const originalOpenDialog = async () => ({ canceled: true, filePaths: [] });
  const dialog = { showOpenDialog: originalOpenDialog };
  const electronApp = {
    async evaluate(callback, payload) {
      return callback({ dialog }, payload);
    }
  };

  try {
    const restoreDialog = await installIsolatedLocalArchiveDialogOverride(
      electronApp,
      lifecycle,
      archivePath
    );
    assert.deepEqual(await dialog.showOpenDialog(), {
      canceled: false,
      filePaths: [archivePath]
    });
    await restoreDialog();
    assert.equal(dialog.showOpenDialog, originalOpenDialog);

    const outsideArchive = path.join(lifecycle.root, 'outside.zip');
    await fsp.writeFile(outsideArchive, 'outside input');
    await assert.rejects(
      installIsolatedLocalArchiveDialogOverride(electronApp, lifecycle, outsideArchive),
      /direct scratch input/iu
    );
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('isolated lifecycle labels its fresh, separate state root for concurrent real runs', async () => {
  const identity = { harness: 'modrinth-lifecycle' };
  const lifecycle = await createIsolatedRealLifecycle({
    scratchPrefix: 'minecraft-core-real-modrinth-e2e-',
    identity
  });
  try {
    assert.ok(lifecycle.root.includes('minecraft-core-real-modrinth-e2e-'));
    assert.deepEqual(JSON.parse(fs.readFileSync(lifecycle.identityPath, 'utf8')), identity);
    assert.notEqual(lifecycle.userDataPath, lifecycle.serverPath);
    assert.notEqual(lifecycle.serverPath, lifecycle.clientPath);
    assert.match(lifecycle.userDataPath, /user-data$/u);
    assert.match(lifecycle.serverPath, /server$/u);
    assert.match(lifecycle.clientPath, /client$/u);
    assert.equal(fs.statSync(lifecycle.userDataPath).isDirectory(), true);
    assert.equal(fs.statSync(lifecycle.serverPath).isDirectory(), true);
    assert.equal(fs.statSync(lifecycle.clientPath).isDirectory(), true);
    assert.equal(lifecycle.serverHost, '127.0.0.1');
    assert.notEqual(lifecycle.serverPort, lifecycle.managementPort);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('successful lifecycle cleanup refuses an identity marker changed after creation', async () => {
  const lifecycle = await createIsolatedRealLifecycle({
    scratchLabel: 'cleanup-marker-swap',
    identity: { harness: 'original-cleanup-marker' }
  });
  try {
    await fsp.writeFile(lifecycle.identityPath, JSON.stringify({ harness: 'replacement-cleanup-marker' }), 'utf8');
    await assert.rejects(
      lifecycle.dispose({ preserveRoot: false }),
      /identity marker|cleanup authority/iu
    );
    assert.equal(fs.existsSync(lifecycle.root), true);
  } finally {
    if (fs.existsSync(lifecycle.root)) {
      const resolved = path.resolve(lifecycle.root);
      assert.equal(path.dirname(resolved).toLocaleLowerCase('en-US'), path.resolve(os.tmpdir()).toLocaleLowerCase('en-US'));
      assert.match(path.basename(resolved), /^minecraft-core-real-cleanup-marker-swap-e2e-/u);
      await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});

test('successful lifecycle cleanup refuses a same-shaped replacement of the exact scratch root', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'cleanup-root-swap' });
  const displacedRoot = `${lifecycle.root}-displaced`;
  try {
    await fsp.rename(lifecycle.root, displacedRoot);
    await fsp.cp(displacedRoot, lifecycle.root, { recursive: true, force: false, errorOnExist: true });

    await assert.rejects(
      lifecycle.dispose({ preserveRoot: false }),
      /root identity|cleanup authority/iu
    );
    assert.equal(fs.existsSync(lifecycle.root), true);
    assert.equal(fs.existsSync(displacedRoot), true);
  } finally {
    if (fs.existsSync(lifecycle.root)) {
      const resolved = path.resolve(lifecycle.root);
      assert.equal(path.dirname(resolved).toLocaleLowerCase('en-US'), path.resolve(os.tmpdir()).toLocaleLowerCase('en-US'));
      assert.match(path.basename(resolved), /^minecraft-core-real-cleanup-root-swap-e2e-/u);
      await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
    if (fs.existsSync(displacedRoot)) {
      await fsp.rename(displacedRoot, lifecycle.root);
      await lifecycle.dispose({ preserveRoot: false });
    }
  }
});

test('successful lifecycle cleanup refuses redirected child topology before recursive removal', async t => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'cleanup-topology-swap' });
  const originalServerPath = `${lifecycle.serverPath}-original`;
  const redirectTarget = await fsp.mkdtemp(path.join(os.tmpdir(), 'minecraft-core-real-cleanup-redirect-target-e2e-'));
  try {
    await fsp.rename(lifecycle.serverPath, originalServerPath);
    try {
      await fsp.symlink(redirectTarget, lifecycle.serverPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip(`directory redirect creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await fsp.writeFile(path.join(redirectTarget, 'outside.keep'), 'must survive\n', 'utf8');

    await assert.rejects(
      lifecycle.dispose({ preserveRoot: false }),
      /redirected|cleanup authority/iu
    );
    assert.equal(fs.readFileSync(path.join(redirectTarget, 'outside.keep'), 'utf8'), 'must survive\n');
    assert.equal(fs.existsSync(lifecycle.root), true);
  } finally {
    if (fs.existsSync(lifecycle.serverPath)) await fsp.rm(lifecycle.serverPath, { recursive: true, force: true });
    if (fs.existsSync(originalServerPath)) await fsp.rename(originalServerPath, lifecycle.serverPath);
    if (fs.existsSync(lifecycle.root)) await lifecycle.dispose({ preserveRoot: false });
    await fsp.rm(redirectTarget, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('production environment confines child profile storage and strips executable startup injections', async () => {
  const lifecycle = await createIsolatedRealLifecycle();
  try {
    const environment = createProductionEnvironment(lifecycle, {
      NODE_ENV: 'test',
      MINECRAFT_CORE_TEST_MODE: '1',
      MINECRAFT_CORE_TEST_MODPACK_FACTORY: 'C:\\existing\\factory.cjs',
      MINECRAFT_CORE_E2E_SCENARIO_FILE: 'C:\\existing\\scenario.json',
      MINECRAFT_CORE_USE_DEV_SERVER: '1',
      MINECRAFT_CORE_DEV_SERVER_URL: 'http://127.0.0.1:59999/',
      npm_lifecycle_event: 'dev',
      MINECRAFT_CORE_USER_DATA_DIR: 'C:\\existing\\user-data',
      APPDATA: 'C:\\existing\\appdata',
      LOCALAPPDATA: 'C:\\existing\\localappdata',
      USERPROFILE: 'C:\\Users\\existing',
      HOME: 'C:\\Users\\existing',
      TEMP: 'C:\\existing\\temp',
      TMP: 'C:\\existing\\temp',
      TMPDIR: 'C:\\existing\\temp',
      FORCE_UPDATES: 'true',
      MC_CORE_STAGE_UPDATE_INSTALLER: 'C:\\existing\\installer.exe',
      MC_CORE_STAGE_UPDATE_VERSION: '99.0.0',
      MC_CORE_STAGE_UPDATE_CLIENT_VERSION: '99.0.0',
      NODE_OPTIONS: '--require=C:\\existing\\inject.cjs',
      NODE_PATH: 'C:\\existing\\node_modules',
      ELECTRON_RUN_AS_NODE: '1',
      JAVA_TOOL_OPTIONS: '-javaagent:C:\\existing\\agent.jar',
      _JAVA_OPTIONS: '-Duser.home=C:\\existing\\java-home',
      JDK_JAVA_OPTIONS: '-Djava.io.tmpdir=C:\\existing\\java-temp',
      CLASSPATH: 'C:\\existing\\injected.jar',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      JAVA_HOME: 'C:\\Program Files\\Java\\jdk-17',
      SystemRoot: 'C:\\Windows'
    });

    assert.equal(environment.NODE_ENV, 'development');
    assert.equal(environment.MINECRAFT_CORE_USER_DATA_DIR, lifecycle.userDataPath);
    assert.equal(environment.MINECRAFT_CORE_REAL_E2E_DISABLE_NATIVE_NOTIFICATIONS, '1');
    assert.equal(environment.MINECRAFT_CORE_TEST_MODE, undefined);
    assert.equal(environment.MINECRAFT_CORE_TEST_MODPACK_FACTORY, undefined);
    assert.equal(environment.MINECRAFT_CORE_E2E_SCENARIO_FILE, undefined);
    assert.equal(environment.MINECRAFT_CORE_USE_DEV_SERVER, undefined);
    assert.equal(environment.MINECRAFT_CORE_DEV_SERVER_URL, undefined);
    assert.equal(environment.npm_lifecycle_event, undefined);
    assert.equal(environment.FORCE_UPDATES, undefined);
    assert.equal(environment.MC_CORE_STAGE_UPDATE_INSTALLER, undefined);
    assert.equal(environment.MC_CORE_STAGE_UPDATE_VERSION, undefined);
    assert.equal(environment.MC_CORE_STAGE_UPDATE_CLIENT_VERSION, undefined);
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.NODE_PATH, undefined);
    assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(environment.JAVA_TOOL_OPTIONS, undefined);
    assert.equal(environment._JAVA_OPTIONS, undefined);
    assert.equal(environment.JDK_JAVA_OPTIONS, undefined);
    assert.equal(environment.CLASSPATH, undefined);
    assert.equal(environment.APPDATA, path.join(lifecycle.root, 'environment', 'profile', 'AppData', 'Roaming'));
    assert.equal(environment.LOCALAPPDATA, path.join(lifecycle.root, 'environment', 'profile', 'AppData', 'Local'));
    assert.equal(environment.USERPROFILE, path.join(lifecycle.root, 'environment', 'profile'));
    assert.equal(environment.HOME, path.join(lifecycle.root, 'environment', 'profile'));
    assert.equal(environment.TEMP, path.join(lifecycle.root, 'environment', 'temp'));
    assert.equal(environment.TMP, path.join(lifecycle.root, 'environment', 'temp'));
    assert.equal(environment.TMPDIR, path.join(lifecycle.root, 'environment', 'temp'));
    assert.equal(environment.HTTPS_PROXY, 'http://127.0.0.1:8080');
    assert.equal(environment.JAVA_HOME, 'C:\\Program Files\\Java\\jdk-17');
    assert.equal(environment.SystemRoot, 'C:\\Windows');
    for (const directory of [
      environment.APPDATA,
      environment.LOCALAPPDATA,
      environment.USERPROFILE,
      environment.TEMP
    ]) {
      assert.equal(fs.statSync(directory).isDirectory(), true);
      assert.equal(path.relative(lifecycle.root, directory).startsWith('..'), false);
    }
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('production environment refuses a Temp-shaped lifecycle without its creator identity marker', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'missing-identity' });
  try {
    await fsp.unlink(lifecycle.identityPath);
    assert.throws(
      () => createProductionEnvironment(lifecycle, { SystemRoot: 'C:\\Windows' }),
      /identity/iu
    );
  } finally {
    if (fs.existsSync(lifecycle.root)) {
      const resolved = path.resolve(lifecycle.root);
      assert.equal(path.dirname(resolved).toLocaleLowerCase('en-US'), path.resolve(os.tmpdir()).toLocaleLowerCase('en-US'));
      assert.match(path.basename(resolved), /^minecraft-core-real-missing-identity-e2e-/u);
      await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
    }
  }
});

test('production launch skips the unprivileged startup window and waits for the preload-backed main window', async () => {
  let windowsCalls = 0;
  const startupPage = {
    async evaluate() { return false; }
  };
  const expectedPage = {
    async evaluate() { return true; }
  };
  const electronApp = {
    windows() {
      windowsCalls += 1;
      return windowsCalls === 1 ? [startupPage] : [startupPage, expectedPage];
    }
  };

  assert.equal(await waitForProductionWindow(electronApp, { timeoutMs: 100, pollMs: 1 }), expectedPage);
  assert.equal(windowsCalls, 2);
});

test('production launch closes the exact Electron handle when the first window never becomes available', async () => {
  assert.equal(typeof launchProductionElectronSafely, 'function');
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'window-failure' });
  const electronApp = { marker: 'owned-electron-handle' };
  const closed = [];
  const audited = [];
  const failure = new Error('window creation failed');

  try {
    await assert.rejects(
      launchProductionElectronSafely(lifecycle, {
      assertBuildAvailable() {},
      async launchElectron(options) {
        assert.match(options.args[1], /^--minecraft-core-real-e2e-root=/u);
        return electronApp;
      },
      async waitForWindow(received) {
        assert.equal(received, electronApp);
        throw failure;
      },
      async closeElectron(received) { closed.push(received); },
      async assertNoOwnedProcesses(received) { audited.push(received); }
    }),
      error => error === failure
    );

    assert.deepEqual(closed, [electronApp]);
    assert.equal(audited.length, 3);
    assert.ok(audited.every(item => item === lifecycle));
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('production close audits every process bound to the exact isolated root only after Electron exits', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'post-close-audit' });
  const processes = [{
    Name: 'ArchiveWorker.exe',
    ProcessId: 4701,
    CommandLine: `ArchiveWorker.exe --workspace ${lifecycle.root}`
  }];
  const events = [];

  try {
    const result = await closeProductionElectronAndAudit(
      { marker: 'owned-electron' },
      lifecycle,
      {
        async closeElectron() {
          events.push('close');
          processes.length = 0;
        },
        processes
      }
    );

    assert.deepEqual(events, ['close']);
    assert.deepEqual(result, []);

    await assert.rejects(
      closeProductionElectronAndAudit(null, lifecycle, {
        async closeElectron() {},
        processes: [{
          Name: 'node.exe',
          ProcessId: 4702,
          CommandLine: `node worker.cjs --root=${lifecycle.root}`
        }]
      }),
      /root-bound process/iu
    );
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('production process audit ignores only the current harness ancestry, never an unrelated root-bound process', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'audit-ancestry' });
  try {
    assert.doesNotThrow(() => assertNoProductionProcesses(lifecycle, {
      processes: [{
        ProcessId: process.pid,
        ParentProcessId: 1,
        CommandLine: `node test.cjs --root=${lifecycle.root}`
      }]
    }));
    assert.throws(
      () => assertNoProductionProcesses(lifecycle, {
        processes: [{
          ProcessId: process.pid + 100000,
          ParentProcessId: 1,
          CommandLine: `node stale.cjs --root=${lifecycle.root}`
        }]
      }),
      /root-bound process/iu
    );
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('production launch closes the exact Electron handle when preload readiness fails', async () => {
  assert.equal(typeof launchProductionElectronSafely, 'function');
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'preload-failure' });
  const page = { marker: 'window' };
  const electronApp = { marker: 'owned-electron-handle' };
  const closed = [];
  const audited = [];
  const failure = new Error('preload did not become ready');

  try {
    await assert.rejects(
      launchProductionElectronSafely(lifecycle, {
      assertBuildAvailable() {},
      async launchElectron() { return electronApp; },
      async waitForWindow() { return page; },
      async waitForPreload(received) {
        assert.equal(received, page);
        throw failure;
      },
      async closeElectron(received) { closed.push(received); },
      async assertNoOwnedProcesses(received) { audited.push(received); }
    }),
      error => error === failure
    );

    assert.deepEqual(closed, [electronApp]);
    assert.equal(audited.length, 3);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('production launch preserves the readiness failure when Playwright has already lost its process handle and still audits the root', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'lost-process-handle' });
  const readinessFailure = new Error('main window failed before readiness');
  const processAccessorFailure = new TypeError("Cannot read properties of undefined (reading '_object')");
  const electronApp = {
    process() { throw processAccessorFailure; }
  };
  const audited = [];

  try {
    await assert.rejects(
      launchProductionElectronSafely(lifecycle, {
        assertBuildAvailable() {},
        async launchElectron() { return electronApp; },
        async waitForWindow() { throw readinessFailure; },
        closeElectron: closeProductionElectron,
        async assertNoOwnedProcesses(received) { audited.push(received); }
      }),
      error => error === readinessFailure
    );
    assert.equal(audited.length, 3);
    assert.ok(audited.every(value => value === lifecycle));
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('production launch reports both readiness and close failures without abandoning the handle silently', async () => {
  assert.equal(typeof launchProductionElectronSafely, 'function');
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'close-failure' });
  const readinessFailure = new Error('preload failed');
  const closeFailure = new Error('close failed');

  try {
    await assert.rejects(
      launchProductionElectronSafely(lifecycle, {
      assertBuildAvailable() {},
      async launchElectron() { return { marker: 'electron' }; },
      async waitForWindow() { return { marker: 'window' }; },
      async waitForPreload() { throw readinessFailure; },
      async closeElectron() { throw closeFailure; },
      async assertNoOwnedProcesses() {}
    }),
      error => error instanceof AggregateError && error.errors[0] === readinessFailure && error.errors[1] === closeFailure
    );
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('production launch reports a readiness failure together with an owned-process audit failure', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'audit-failure' });
  const readinessFailure = new Error('preload failed');
  const auditFailure = new Error('owned Electron descendant remains');
  let audits = 0;

  try {
    await assert.rejects(
      launchProductionElectronSafely(lifecycle, {
      assertBuildAvailable() {},
      async launchElectron() { return { marker: 'electron' }; },
      async waitForWindow() { return { marker: 'window' }; },
      async waitForPreload() { throw readinessFailure; },
      async closeElectron() {},
      async assertNoOwnedProcesses() {
        audits += 1;
        if (audits === 3) throw auditFailure;
      }
    }),
      error => error instanceof AggregateError && error.errors[0] === readinessFailure &&
        error.errors[1] === auditFailure
    );
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('production launch never reaches Electron while a disposable root still has a bound process', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'prelaunch-process-audit' });
  const auditFailure = new Error('owned process remains');
  let launches = 0;
  try {
    await assert.rejects(
      launchProductionElectronSafely(lifecycle, {
        assertBuildAvailable() {},
        async assertNoOwnedProcesses() { throw auditFailure; },
        async launchElectron() { launches += 1; return { marker: 'must-not-launch' }; }
      }),
      error => error === auditFailure
    );
    assert.equal(launches, 0);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real pack boot waits for the production fifteen-minute readiness allowance', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'boot-timeout' });
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let now = 0;
  let statusPolls = 0;
  const page = {
    async evaluate(_callback, payload) {
      if (payload.channel === 'start-server') return { success: true };
      if (payload.channel === 'get-server-status') {
        statusPolls += 1;
        return { instanceId: 'real-e2e-server', isRunning: false, status: 'starting' };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  Date.now = () => now;
  globalThis.setTimeout = (callback, delayMs) => {
    now += delayMs;
    queueMicrotask(callback);
    return 1;
  };
  try {
    await assert.rejects(
      startIsolatedServer(page, lifecycle, 'real-e2e-server', { pollMs: 60_000 }),
      /did not reach Minecraft readiness/iu
    );
    assert.equal(statusPolls, 15);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real pack boot binds the exact isolated server to loopback before start and preserves unrelated properties', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'boot-loopback-only' });
  const propertiesPath = path.join(lifecycle.serverPath, 'server.properties');
  const latestLogPath = path.join(lifecycle.serverPath, 'logs', 'latest.log');
  await fsp.writeFile(
    propertiesPath,
    '# publisher setting\r\nmotd=Keep this value\r\nserver-ip=\r\nview-distance=9\r\nserver-ip=0.0.0.0\r\nserver-ip 192.0.2.1\r\n',
    'utf8'
  );
  let propertiesAtStart = null;
  const page = {
    async evaluate(_callback, payload) {
      if (payload.channel === 'start-server') {
        propertiesAtStart = await fsp.readFile(propertiesPath, 'utf8');
        return { success: true };
      }
      if (payload.channel === 'get-server-status') {
        await fsp.mkdir(path.dirname(latestLogPath), { recursive: true });
        await fsp.writeFile(latestLogPath, '[main/INFO] Done (12.345s)!', 'utf8');
        return { instanceId: 'real-e2e-server', isRunning: true, status: 'running' };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  try {
    await startIsolatedServer(page, lifecycle, 'real-e2e-server', { timeoutMs: 100, pollMs: 1 });
    assert.equal(propertiesAtStart, '# publisher setting\r\nmotd=Keep this value\r\nserver-ip=127.0.0.1\r\nview-distance=9\r\n');
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real pack boot removes Java-escaped aliases before appending the authoritative loopback property', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'boot-loopback-escaped-key' });
  const propertiesPath = path.join(lifecycle.serverPath, 'server.properties');
  const latestLogPath = path.join(lifecycle.serverPath, 'logs', 'latest.log');
  await fsp.writeFile(
    propertiesPath,
    '# publisher setting\r\nmotd=Keep this value\r\nserver-ip=\r\nserver\\u002dip=0.0.0.0\r\nview-distance=9\r\n',
    'utf8'
  );
  let propertiesAtStart = null;
  const page = {
    async evaluate(_callback, payload) {
      if (payload.channel === 'start-server') {
        propertiesAtStart = await fsp.readFile(propertiesPath, 'utf8');
        return { success: true };
      }
      if (payload.channel === 'get-server-status') {
        await fsp.mkdir(path.dirname(latestLogPath), { recursive: true });
        await fsp.writeFile(latestLogPath, '[main/INFO] Done (12.345s)!', 'utf8');
        return { instanceId: 'real-e2e-server', isRunning: true, status: 'running' };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  try {
    await startIsolatedServer(page, lifecycle, 'real-e2e-server', { timeoutMs: 100, pollMs: 1 });
    assert.doesNotMatch(propertiesAtStart, /server\\u002dip/iu);
    assert.deepEqual(propertiesAtStart.match(/^server-ip=.*$/gmu), ['server-ip=127.0.0.1']);
    assert.match(propertiesAtStart, /motd=Keep this value\r\n/u);
    assert.match(propertiesAtStart, /view-distance=9\r\n/u);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real pack boot forwards one explicitly bounded RAM allocation', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'boot-explicit-ram' });
  const latestLogPath = path.join(lifecycle.serverPath, 'logs', 'latest.log');
  const requests = [];
  const page = {
    async evaluate(_callback, payload) {
      requests.push(payload);
      if (payload.channel === 'start-server') return { success: true };
      if (payload.channel === 'get-server-status') {
        await fsp.mkdir(path.dirname(latestLogPath), { recursive: true });
        await fsp.writeFile(latestLogPath, '[main/INFO] Done (12.345s)! For help, type "help"', 'utf8');
        return { instanceId: 'real-e2e-server', isRunning: true, status: 'running' };
      }
      throw new Error(`Unexpected IPC channel ${payload.channel}`);
    }
  };

  try {
    await startIsolatedServer(page, lifecycle, 'real-e2e-server', {
      maxRam: 6,
      timeoutMs: 100,
      pollMs: 1
    });
    assert.deepEqual(requests[0], {
      channel: 'start-server',
      request: {
        instanceId: 'real-e2e-server',
        targetPath: lifecycle.serverPath,
        port: lifecycle.serverPort,
        maxRam: 6
      }
    });
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real pack boot rejects RAM allocations outside the harness boundary before IPC', async () => {
  const lifecycle = await createIsolatedRealLifecycle({ scratchLabel: 'boot-invalid-ram' });
  let invoked = false;
  const page = {
    async evaluate() {
      invoked = true;
      throw new Error('IPC must not be reached');
    }
  };

  try {
    for (const maxRam of [0, 1.5, 65, Number.NaN]) {
      await assert.rejects(
        startIsolatedServer(page, lifecycle, 'real-e2e-server', { maxRam }),
        /integer from 1 through 64/iu
      );
    }
    assert.equal(invoked, false);
  } finally {
    await lifecycle.dispose({ preserveRoot: false });
  }
});

test('real lifecycle IPC failures retain public validation details for diagnosis', async () => {
  const page = {
    async evaluate() {
      return {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'The preflight request is invalid',
          details: { field: 'serverSnapshot.pathPreconditions.3' }
        }
      };
    }
  };

  await assert.rejects(
    invokeModpack(page, 'modpacks:preflight', {}),
    /serverSnapshot\.pathPreconditions\.3/u
  );
});

test('terminal failed jobs report their persisted outcome code and message', async () => {
  const page = {
    async evaluate(_callback, request) {
      assert.equal(request.channel, 'modpacks:get-job');
      assert.deepEqual(request.request, { jobId: 'job-durable-flush' });
      return {
        ok: true,
        value: {
          phase: 'failed',
          outcome: {
            errorCode: 'COMMIT_FAILED',
            message: 'The operation failed before the server changed'
          }
        }
      };
    }
  };

  await assert.rejects(
    waitForJob(page, 'job-durable-flush', { timeoutMs: 10, pollMs: 1 }),
    /Lifecycle job job-durable-flush ended failed: COMMIT_FAILED The operation failed before the server changed/u
  );
});

test('real lifecycle polling fails when the Electron main-process heartbeat exceeds its bound', async () => {
  const page = {
    async evaluate(_callback, request) {
      assert.equal(request.channel, 'modpacks:get-job');
      await new Promise(resolve => setTimeout(resolve, 30));
      return { ok: true, value: { phase: 'completed', outcome: { status: 'completed' } } };
    }
  };

  await assert.rejects(
    waitForJob(page, 'job-blocked-main', {
      timeoutMs: 1_000,
      pollMs: 1,
      maxPollLatencyMs: 5
    }),
    /main-process heartbeat exceeded 5ms/u
  );
});

test('all non-success terminal job phases fail immediately with their persisted outcome', async () => {
  for (const phase of ['cancelled', 'rolled-back', 'recovery-required']) {
    let polls = 0;
    const page = {
      async evaluate(_callback, request) {
        polls += 1;
        assert.equal(request.channel, 'modpacks:get-job');
        assert.deepEqual(request.request, { jobId: `job-${phase}` });
        return {
          ok: true,
          value: {
            phase,
            outcome: {
              errorCode: phase === 'recovery-required' ? 'RECOVERY_REQUIRED' : 'COMMIT_FAILED',
              message: `terminal ${phase}`
            }
          }
        };
      }
    };

    await assert.rejects(
      waitForJob(page, `job-${phase}`, { timeoutMs: 10, pollMs: 1 }),
      new RegExp(`Lifecycle job job-${phase} ended ${phase}: .* terminal ${phase}`, 'u')
    );
    assert.equal(polls, 1, `${phase} must not be polled after becoming terminal`);
  }
});
